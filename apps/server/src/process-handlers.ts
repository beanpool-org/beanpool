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
 * AND NEITHER RECORD MAY CARRY A SECRET, because the data dir is exactly what an owner copies, mounts and
 * hands to a stranger for help. A Node diagnostic report holds the whole environment unless it is told
 * not to; see the block above `scrubReportEnvironment` for that, and for the reports already on disk.
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

/**
 * Owner-only permissions on a file this module writes. The data dir is the directory an owner copies,
 * mounts and hands to someone else for help, so nothing in it should be readable by every account on the
 * host as well. Never throws: a read-only mount or a file owned by someone else is not worth a second
 * failure raised from inside the net.
 */
function restrictMode(filePath: string): void {
    try {
        fs.chmodSync(filePath, 0o600);
    } catch {
        // Best effort. The content is what matters; the mode is the second lock.
    }
}

/** Append one line, rotating first if the file has reached its cap. Never throws. */
function appendLogLine(entry: Record<string, unknown>): void {
    try {
        const logFilePath = getUnhandledRejectionLogPath();
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        let existed = false;
        try {
            const size = fs.statSync(logFilePath).size;
            existed = true;
            if (size >= MAX_LOG_BYTES) {
                // One generation is kept. Truncating instead would throw away the beginning of the very
                // incident the owner is reading the file to understand.
                fs.renameSync(logFilePath, `${logFilePath}.1`);
                existed = false;
            }
        } catch {
            // No file yet, or it cannot be stat'd. Either way, appending is still the right next move.
            existed = false;
        }
        fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        // `mode` above only applies when the file is created, and the umask can still clear bits from it,
        // so the permissions are set explicitly the one time the file comes into existence. The rotated
        // .1 file arrives by rename and keeps the mode it already had.
        if (!existed) restrictMode(logFilePath);
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
 * A DIAGNOSTIC REPORT CARRIES THE WHOLE ENVIRONMENT.
 *
 * Node's report has an `environmentVariables` section holding every variable in `process.env`, in
 * plaintext. On a node that is ADMIN_PASSWORD, BACKUP_ADMIN_PASSWORD, BACKUP_REPLICATION_TOKEN,
 * CF_API_TOKEN, INSTAGRAM_APP_SECRET, INSTAGRAM_CLIENT_SECRET and TIKTOK_CLIENT_SECRET, written into the
 * data dir — the directory an owner copies, mounts and hands to someone else for help, and the one the
 * manual now sends them into to find the report. Measured on the test node: 46 of these files left over
 * from the July freeze captures, world-readable, 28 of them holding the admin password and the Cloudflare
 * token, one of them the Instagram and TikTok secrets.
 *
 * Two separate things are needed, because they cover different files:
 *
 *   - `excludeEnv` stops the top-level section being written at all. It is a property of the running
 *     thread, so setting it once covers our own `writeReport` below, Node's own `--report-uncaught-exception`
 *     report and the `--report-on-signal` freeze reports the watchdog asks for. None of the three needs the
 *     environment to be useful: the value of a report is the stacks. It is NOT set here — by the time any
 *     statement of the entry point runs, every module it imports has already been evaluated and could
 *     already have crashed, and a node that crashes at import crash-loops and never reaches this function
 *     at all. It is set in `report-privacy.ts`, the entry point's first import, which imports nothing; the
 *     assignment below is only belt and braces. Nodes also pass `--report-exclude-env`, which is the one
 *     thing that reaches a WORKER thread's copy of the flag — see the next paragraph.
 *
 *   - the scrub takes it out of the file. It is needed for two separate reasons. The reports ALREADY on
 *     disk are the first: every node that has ever frozen or crashed is carrying them right now, and a fix
 *     that only protects the next report leaves those where they are. The second is that `excludeEnv` does
 *     NOT reach every environment in a report — MEASURED: a report written with it set still carries the
 *     full environment under `workers[].environmentVariables`, one nested section per worker thread, and
 *     the flag is per-thread so the main thread setting it does not speak for them. A node started with
 *     `node dist/index.js` has no workers, but one started with `pnpm dev` has the loader's, so the report
 *     this file writes is put through the scrub the moment it is written, not left until the next boot.
 *
 *   The scrub never deletes a report: they are the only record of what happened in July.
 */

/** Node names its own reports `report.<date>.<pid>....json`; ours is `report-uncaught-....json`. */
const REPORT_FILE_NAME = /^report.*\.json$/;
/** What a redacted argv word is replaced with — and what makes a second scrub of the same file a no-op. */
const REDACTED_VALUE = '[REDACTED]';
/** A shell-style `NAME=value` as a bare argv word. A flag like `--report-directory=/data` starts with `-` and is left alone. */
const ARGV_ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=[^]+$/;

/**
 * Every directory a report could already be sitting in. Normally one — nodes run with
 * `--report-directory=/data` and their data dir IS /data — and two only when the flag points away from
 * the data dir, which is the case the handler below deliberately writes across.
 */
function reportDirectories(dataDir?: string): string[] {
    const dirs = [path.resolve(resolveDataDir(dataDir))];
    try {
        const configured = process.report?.directory;
        if (configured) {
            const resolved = path.resolve(configured);
            if (!dirs.includes(resolved)) dirs.push(resolved);
        }
    } catch {
        // No `process.report` on this Node. The data dir is then the only place to look.
    }
    return dirs;
}

/** Worker sections nest (a worker can have workers). Bounded so a malformed file cannot spin here. */
const MAX_WORKER_DEPTH = 4;

/**
 * Take the environment out of one parsed report, in place, including the nested section each worker thread
 * contributes. Returns false when there was nothing to take, which is what makes the scrub idempotent: a
 * file already scrubbed is not rewritten a second time, so a node that updates twice does not churn 46
 * files on every boot.
 */
function stripEnvironmentFromReport(report: Record<string, unknown>, depth = 0): boolean {
    let changed = false;

    if (Object.prototype.hasOwnProperty.call(report, 'environmentVariables')) {
        delete report.environmentVariables;
        changed = true;
    }

    // The command line is argv, not the environment — but a process started as `env FOO=secret node …`,
    // or anything else that puts an assignment in argv, carries the value here too.
    const header = report.header as { commandLine?: unknown } | undefined;
    if (header && typeof header === 'object' && Array.isArray(header.commandLine)) {
        let commandLineChanged = false;
        const words = header.commandLine.map((word: unknown) => {
            if (typeof word !== 'string' || word.endsWith(`=${REDACTED_VALUE}`)) return word;
            const match = ARGV_ENV_ASSIGNMENT.exec(word);
            if (!match) return word;
            commandLineChanged = true;
            return `${match[1]}=${REDACTED_VALUE}`;
        });
        if (commandLineChanged) {
            header.commandLine = words;
            changed = true;
        }
    }

    // Each worker thread contributes its own report-shaped section, with its own copy of the environment.
    // `excludeEnv` is set per thread, so the main thread setting it does not cover these.
    if (depth < MAX_WORKER_DEPTH && Array.isArray(report.workers)) {
        for (const worker of report.workers) {
            if (worker && typeof worker === 'object' && !Array.isArray(worker)) {
                if (stripEnvironmentFromReport(worker as Record<string, unknown>, depth + 1)) changed = true;
            }
        }
    }

    return changed;
}

/**
 * Scrub one report file in place, and say whether it was changed. Atomic: the new content is written
 * beside the original and renamed over it, so a report is never half a file and an interrupted update
 * leaves the original intact. Anything that will not parse as a JSON object is left exactly as it is — it
 * belongs to something else. Nothing is ever deleted, and this never throws.
 */
function scrubReportFile(filePath: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return false; // Unreadable, or not JSON. Leave it alone rather than guess at it.
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const report = parsed as Record<string, unknown>;
    if (!stripEnvironmentFromReport(report)) {
        // Already clean. Still worth closing the permissions: these went out world-readable, and this is
        // the boot that fixes the ones already there.
        restrictMode(filePath);
        return false;
    }
    const tempPath = `${filePath}.scrub-${process.pid}.tmp`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(report, null, 2), { mode: 0o600 });
        restrictMode(tempPath);
        fs.renameSync(tempPath, filePath);
        restrictMode(filePath);
        return true;
    } catch {
        // A full or read-only disk. Leave the original where it is and move on.
        try { fs.unlinkSync(tempPath); } catch { /* it may never have been created */ }
        return false;
    }
}

/**
 * Rewrite every diagnostic report already on disk that carries the environment, and return how many were
 * changed. Called at install, and again from the entry point once the root .env has been read and the data
 * dir is certain. Never throws, and on a node with no reports it costs one readdir.
 */
export function scrubReportEnvironment(dataDir?: string): number {
    let scrubbed = 0;
    try {
        for (const dir of reportDirectories(dataDir)) {
            let names: string[];
            try {
                names = fs.readdirSync(dir);
            } catch {
                continue; // No such directory yet — a first boot. Nothing to scrub.
            }
            for (const name of names) {
                if (!REPORT_FILE_NAME.test(name)) continue;
                if (scrubReportFile(path.join(dir, name))) scrubbed++;
            }
        }
    } catch {
        // Same rule as the rest of this file: it must never become a failure of its own.
    }
    if (scrubbed > 0) {
        console.warn(`[diagnostic-reports] removed the environment from ${scrubbed} existing report file${scrubbed === 1 ? '' : 's'} — they held every variable of the process in plaintext, secrets included`);
    }
    return scrubbed;
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

    // Belt and braces. The entry point already set this in its very first import (report-privacy.ts),
    // because by the time any statement of the entry point runs the whole application has been imported
    // and could already have crashed. This covers a process that reaches the handlers another way — the
    // test children, a tool that imports this module directly — and costs nothing when it is already set.
    try {
        if (process.report) process.report.excludeEnv = true;
    } catch {
        // Node before 22.13 has no such property. Nothing else to do: the scrub below still runs.
    }

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
                    restrictMode(reportPath);
                    // `excludeEnv` covers the top-level section but not a worker thread's, so the file is
                    // scrubbed here rather than at the next boot: the owner may copy it away before then.
                    scrubReportFile(reportPath);
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

    // The reports already on disk, from before `excludeEnv` existed on this node. The entry point calls
    // this again once the root .env has been read, for a self-hoster whose BEANPOOL_DATA_DIR comes from
    // there and so is not yet visible at this point.
    scrubReportEnvironment();

    process.on('exit', () => {
        try {
            flushSuppressedCounts();
        } catch {
            // Nothing useful is left to do at exit.
        }
    });
}
