/**
 * Process-level error policy: log rejections, restart on true exceptions.
 *
 * WHY THIS EXISTS. The node installed no process-level handler, so ANY error nothing else caught killed
 * the process. Node's default for an unhandled promise rejection is to throw, and a thrown-at-top-level
 * error ends the process; Docker then restarts the container and every connected member is dropped for
 * about a minute. That is an enormous punishment for one async call that failed — a peer that answered
 * oddly, a fetch that timed out — and on a node of strangers nobody is watching the logs to notice.
 *
 * So the two cases are separated, which is the decision of 2026-09-24:
 *
 *   - UNHANDLED PROMISE REJECTION. One async call failed and nothing awaited it. Nothing in the process
 *     is half-written, because a rejection is not a torn operation — it is an operation that finished by
 *     failing. Record it and keep serving.
 *
 *   - UNCAUGHT EXCEPTION. Synchronous, and the process may be part-way through a change: a function
 *     stopped between two writes, holding state no code path expects to see. Continuing from there can
 *     corrupt the ledger, which is far worse than a minute offline. So the outcome is unchanged — the
 *     process still crashes and Docker still restarts it. `uncaughtExceptionMonitor` is used precisely
 *     because it OBSERVES without registering a handler: Node's default crash stays in place.
 *
 * Either way a record is left in the data dir, because the person who has to understand it is usually an
 * owner reading Settings a day later, not us reading a terminal.
 *
 * NOTHING IN THIS FILE MAY THROW, and nothing in it may import the database. It is the last net under
 * everything else: if it depends on the thing that broke, it is not a net. That is why `sanitizeMessage`
 * is imported from its own file rather than from logger.ts (which opens SQLite at import), why the whole
 * recording path is wrapped, and why every filesystem write fails silently — a full disk must not become
 * a second failure raised from inside the handler for the first one.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { errorMessage } from './error-message.js';
import { sanitizeMessage } from './sanitize-message.js';

export interface UnhandledRejectionSummary {
    /** Unhandled rejections seen since this process started. Not persisted: a restart resets it. */
    count: number;
    /** ISO time of the most recent one, or null if there has been none. */
    lastAt: string | null;
    /** The most recent one's error text, redacted. Never a request body, a key or a parameter. */
    lastMessage: string | null;
}

/** A repeat of the same signature is written in full at most this often. */
const FULL_ENTRY_WINDOW_MS = 10 * 60 * 1000;
/** The log rotates at this size, so at most two files of this size can exist. */
const MAX_LOG_BYTES = 1024 * 1024;
/** Distinct signatures tracked for de-duplication. A loop inventing a new message each time cannot grow this without bound. */
const MAX_TRACKED_SIGNATURES = 200;
/** Stack frames kept per entry. Enough to place the failure; short enough that the file stays readable. */
const STACK_FRAMES = 3;

interface SignatureState {
    /** Times this signature has been seen since start. */
    total: number;
    /** When it was last written in full (epoch ms; 0 = never). */
    lastFullAt: number;
    /** Times it has been seen since that full entry, and so not written. */
    suppressed: number;
    /** Kept so the flush on exit can name what was suppressed. */
    message: string;
}

let installed = false;
/** Only set when a caller (a test) names a directory; otherwise the environment decides, at write time. */
let overrideDataDir: string | undefined;
let rejectionCount = 0;
let lastRejectionAt: string | null = null;
let lastRejectionMessage: string | null = null;
const signatures = new Map<string, SignatureState>();

/**
 * Resolved at every write, never captured at install. The entry point installs the handlers as its first
 * statement — deliberately, so nothing can reject unrecorded — and that is BEFORE it loads the root .env,
 * which is where a self-hoster's BEANPOOL_DATA_DIR may come from. A directory captured at install would
 * quietly be the wrong one on exactly those nodes.
 */
function resolveDataDir(dataDir?: string): string {
    return dataDir || overrideDataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

/** Where the rejection log lives, for the manual, the tests and anyone going to look. */
export function getUnhandledRejectionLogPath(dataDir?: string): string {
    return path.join(resolveDataDir(dataDir), 'unhandled-rejections.log');
}

/**
 * What the admin diagnostics response and the health flag read. Zeroes when nothing has rejected — and
 * also when the handlers were never installed, which is the honest answer in that case.
 */
export function getUnhandledRejectionSummary(): UnhandledRejectionSummary {
    return { count: rejectionCount, lastAt: lastRejectionAt, lastMessage: lastRejectionMessage };
}

/** The first few stack frames of whatever was rejected, or none — a rejection reason need not be an Error. */
function stackFrames(reason: unknown): string[] {
    let stack: unknown;
    try {
        stack = (reason as { stack?: unknown } | null | undefined)?.stack;
    } catch {
        // A getter on `stack` can itself throw.
        return [];
    }
    if (typeof stack !== 'string') return [];
    return stack
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at '))
        .slice(0, STACK_FRAMES)
        .map((line) => sanitizeMessage(line));
}

/**
 * What counts as "the same rejection". The message alone would merge two unrelated failures that both say
 * "fetch failed"; the whole stack would split one failure into many when the frames vary by line. Message
 * plus the innermost frame is the pairing that holds a rejecting loop to one entry without hiding a second
 * distinct fault behind the first.
 */
function signatureOf(message: string, topFrame: string | undefined): string {
    return crypto.createHash('sha1').update(`${message}\n${topFrame ?? ''}`).digest('hex').slice(0, 12);
}

/** Append one line, rotating first if the file has reached its cap. Never throws. */
function appendLogLine(entry: Record<string, unknown>): void {
    try {
        const logFilePath = getUnhandledRejectionLogPath();
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        try {
            if (fs.statSync(logFilePath).size >= MAX_LOG_BYTES) {
                // One generation is kept. Truncating instead would throw away the beginning of the very
                // incident the owner is reading the file to understand.
                fs.renameSync(logFilePath, `${logFilePath}.1`);
            }
        } catch {
            // No file yet, or it cannot be stat'd. Either way, appending is still the right next move.
        }
        fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`);
    } catch {
        // A full, read-only or missing disk. Losing the record is bad; raising from inside the handler
        // that exists to stop the process dying would be worse.
    }
}

function recordRejection(reason: unknown): void {
    const message = sanitizeMessage(errorMessage(reason, 'Unknown rejection reason'));
    const frames = stackFrames(reason);
    const signature = signatureOf(message, frames[0]);
    const now = Date.now();

    rejectionCount++;
    lastRejectionAt = new Date(now).toISOString();
    lastRejectionMessage = message;

    let state = signatures.get(signature);
    if (!state) {
        if (signatures.size >= MAX_TRACKED_SIGNATURES) {
            // Map iteration is insertion-ordered, so this drops the signature seen longest ago.
            const oldest = signatures.keys().next();
            if (!oldest.done) signatures.delete(oldest.value);
        }
        state = { total: 0, lastFullAt: 0, suppressed: 0, message };
        signatures.set(signature, state);
    }
    state.total++;
    state.message = message;

    // The de-duplication covers the console as well as the file. A loop rejecting on every tick would
    // otherwise fill Docker's own log just as fast as it filled ours, which is the same disk.
    if (state.lastFullAt === 0 || now - state.lastFullAt >= FULL_ENTRY_WINDOW_MS) {
        const suppressed = state.suppressed;
        state.suppressed = 0;
        state.lastFullAt = now;
        const entry: Record<string, unknown> = { t: lastRejectionAt, sig: signature, msg: message, frames, n: state.total };
        if (suppressed > 0) entry.repeated = suppressed;
        appendLogLine(entry);
        const repeatNote = suppressed > 0 ? ` (+${suppressed} identical since the last entry)` : '';
        const frameNote = frames.length > 0 ? `\n    ${frames.join('\n    ')}` : '';
        console.error(`[unhandledRejection] ${message}${repeatNote} — the node is still serving${frameNote}`);
    } else {
        state.suppressed++;
    }
}

/**
 * On the way out, write one compact line per signature whose repeats were never written in full, so the
 * count survives in the file. Without this a burst that ends inside the ten-minute window leaves a single
 * entry saying "1" for something that happened fifty times.
 */
function flushSuppressedCounts(): void {
    const at = new Date().toISOString();
    for (const [signature, state] of signatures) {
        if (state.suppressed > 0) {
            appendLogLine({ t: at, sig: signature, msg: state.message, repeated: state.suppressed, n: state.total, note: 'identical repeats not written in full' });
            state.suppressed = 0;
        }
    }
}

/**
 * True when this process should write its own diagnostic report for an uncaught exception.
 *
 * Nodes run with NODE_OPTIONS=--report-uncaught-exception --report-directory=/data, so Node already writes
 * one there. Writing a second identical report on every crash doubles what a crash-restart loop costs a
 * small disk, and these files are already on the manual's list of things that grow without limit. So ours
 * is written only when Node's would not land in the data dir anyway.
 */
function shouldWriteOwnReport(): boolean {
    try {
        const dataDir = resolveDataDir();
        const report = process.report;
        if (!report || typeof report.writeReport !== 'function') return false;
        if (!report.reportOnUncaughtException) return true;
        const nodeDir = report.directory ? path.resolve(report.directory) : process.cwd();
        return path.resolve(dataDir) !== nodeDir;
    } catch {
        return false;
    }
}

/**
 * Install the process-level handlers. Idempotent: a second call is a no-op rather than a second set of
 * listeners, so a test that installs and the entry point that installs cannot double-count a rejection.
 *
 * Call this as the first statement of the entry point. ES module imports are evaluated before any module
 * body runs, so this cannot literally precede them — but a rejection is only reported as unhandled once
 * the microtask queue drains, which is after the entry module body has finished. Nothing that rejects
 * during import evaluation escapes these handlers.
 */
export function installProcessHandlers(options?: { dataDir?: string }): void {
    if (installed) return;
    installed = true;
    overrideDataDir = options?.dataDir;

    process.on('unhandledRejection', (reason) => {
        try {
            recordRejection(reason);
        } catch {
            // Recording failed. The node keeps running regardless: that is the whole point.
        }
    });

    // OBSERVES the crash; it does not prevent it. Registering an `uncaughtException` handler instead would
    // silently keep a process alive that may be half-way through a ledger write. See the file header.
    process.on('uncaughtExceptionMonitor', (err, origin) => {
        try {
            const message = sanitizeMessage(errorMessage(err, 'Unknown exception'));
            const dataDir = resolveDataDir();
            let reportPath: string | null = null;
            if (shouldWriteOwnReport()) {
                const previousDirectory = process.report?.directory;
                try {
                    fs.mkdirSync(dataDir, { recursive: true });
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const name = `report-uncaught-${stamp}-${process.pid}.json`;
                    // `writeReport` joins its filename onto `process.report.directory`, and joins it
                    // naively: hand it an absolute path while --report-directory is set and Node tries to
                    // open "/data//tmp/whatever.json", fails with ENOENT and prints a line nobody reads.
                    // Point the directory at the data dir and pass a bare name, which lands the report
                    // where the owner will look for it whatever the flags say. Nodes DO set that flag.
                    process.report!.directory = dataDir;
                    process.report!.writeReport(name, err instanceof Error ? err : undefined);
                    reportPath = path.join(dataDir, name);
                } catch {
                    reportPath = null;
                } finally {
                    try {
                        if (process.report && previousDirectory !== undefined) process.report.directory = previousDirectory;
                    } catch { /* the process is ending anyway */ }
                }
            }
            const where = reportPath ? ` — diagnostic report: ${reportPath}` : '';
            console.error(`[uncaughtException] ${message} (${origin}) — the node is restarting${where}`);
        } catch {
            // Never add a second failure to the one that is already ending this process.
        }
    });

    process.on('exit', () => {
        try {
            flushSuppressedCounts();
        } catch {
            // Nothing useful is left to do at exit.
        }
    });
}
