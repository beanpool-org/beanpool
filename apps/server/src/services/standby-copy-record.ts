/**
 * A standby's record of its own copies (design scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §2 G8): how its
 * last pull went and why, how many copies in a row were refused, when its last copy landed, and its last whole copy's
 * check (services/backup-puller.ts checkWholeCopy): exact, or what differed, and when the last exact one was. A check that
 * could not compare everything gives no verdict: it is kept beside the last one that did, and changes nothing it says.
 *
 * Kept in node_config (`standby_copy_record`), so it outlives a restart: a standby restarted after its main server died
 * still says, in the take-over preview, when its last exact copy was. Sent to the main server with each pull
 * (services/standby-report.ts), which tells the community's owners when it needs them (services/standby-health.ts).
 */

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import {
    type PullOutcome, type StandbyReport, type WhyCode, differsInWords, timeInWords, whyInWords,
} from './standby-report.js';

const KEY = 'standby_copy_record';
/** A last copy older than this, and the take-over preview says so. */
const STALE_MS = 60 * 60_000;

export interface WholeCopyCheck {
    /** When this standby checked it. */
    at: number;
    exact: boolean;
    /** What differed: copied tables by name, and the ledger's (standby-report.ts LEDGER_DIFFERS). */
    differs: string[];
    /** Accounts whose balance differed. */
    ledgerDiffering: number;
    /** Whether each table's content was compared (the main server sent its hashes), not only the counts. */
    hashed: boolean;
    snapshotGeneratedAt: string | null;
}

/**
 * A whole copy's check that found nothing different but could not compare everything, so it says neither "exact" nor
 * "differs" (review 4118340714: one read as exact was an all-clear for a copy still wrong).
 */
export interface UncomparedCheck {
    at: number;
    /**
     * What it could not compare: `content`, each table's content (the main server sent no hashes with the copy: it was
     * written to while the copy was being made); `ledger`, every account (the copy names accounts this server can't hold).
     */
    notCompared: ('content' | 'ledger')[];
    snapshotGeneratedAt: string | null;
}

export interface CopyRecord {
    id: string;
    lastPullAt: number | null;
    lastOutcome: PullOutcome | null;
    lastWhy: WhyCode | null;
    failedImportsInARow: number;
    lastOkAt: number | null;
    /** The last whole copy's check that gave a verdict: exact, or what differed. */
    lastWhole: WholeCopyCheck | null;
    /** A later check that could give none: kept for the take-over preview's words, and changing nothing the verdict says. */
    lastUncompared: UncomparedCheck | null;
    /** When the last exact whole copy was: only a check that compared everything moves it. */
    lastExactAt: number | null;
}

function fresh(): CopyRecord {
    return {
        id: crypto.randomBytes(16).toString('hex'), lastPullAt: null, lastOutcome: null, lastWhy: null,
        failedImportsInARow: 0, lastOkAt: null, lastWhole: null, lastUncompared: null, lastExactAt: null,
    };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function readCopyRecord(): CopyRecord {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return fresh();
    try {
        const r = JSON.parse(row.value);
        const base = fresh();
        const w = r?.lastWhole;
        const u = r?.lastUncompared;
        return {
            id: typeof r?.id === 'string' && /^[0-9a-f]{32}$/.test(r.id) ? r.id : base.id,
            lastPullAt: num(r?.lastPullAt),
            lastOutcome: ['ok', 'refused', 'fetch-failed'].includes(r?.lastOutcome) ? r.lastOutcome : null,
            lastWhy: typeof r?.lastWhy === 'string' ? r.lastWhy : null,
            failedImportsInARow: Number.isInteger(r?.failedImportsInARow) && r.failedImportsInARow >= 0 ? r.failedImportsInARow : 0,
            lastOkAt: num(r?.lastOkAt),
            lastWhole: w && typeof w === 'object' && num(w.at) !== null && typeof w.exact === 'boolean' ? {
                at: w.at, exact: w.exact, differs: Array.isArray(w.differs) ? w.differs.filter((d: unknown) => typeof d === 'string') : [],
                ledgerDiffering: Number.isInteger(w.ledgerDiffering) ? w.ledgerDiffering : 0, hashed: w.hashed === true,
                snapshotGeneratedAt: typeof w.snapshotGeneratedAt === 'string' ? w.snapshotGeneratedAt : null,
            } : null,
            lastUncompared: u && typeof u === 'object' && num(u.at) !== null ? {
                at: u.at,
                notCompared: Array.isArray(u.notCompared) ? u.notCompared.filter((n: unknown) => n === 'content' || n === 'ledger') : [],
                snapshotGeneratedAt: typeof u.snapshotGeneratedAt === 'string' ? u.snapshotGeneratedAt : null,
            } : null,
            lastExactAt: num(r?.lastExactAt),
        };
    } catch {
        return fresh();
    }
}

function write(r: CopyRecord): void {
    db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(r));
}

/** A pull whose copy landed (or the main server said nothing changed since the last one). */
export function noteCopyLanded(now = Date.now()): void {
    const r = readCopyRecord();
    write({ ...r, lastPullAt: now, lastOutcome: 'ok', lastWhy: null, failedImportsInARow: 0, lastOkAt: now });
}

/** A pull that failed: `refused` when the copy came and was not imported, `fetch-failed` when none came. */
export function noteCopyFailed(outcome: Exclude<PullOutcome, 'ok'>, why: WhyCode, now = Date.now()): void {
    const r = readCopyRecord();
    write({
        ...r, lastPullAt: now, lastOutcome: outcome, lastWhy: why,
        // Only copies that came count: a main server that can't be reached is the main server's "no pull for an hour".
        failedImportsInARow: outcome === 'refused' ? r.failedImportsInARow + 1 : r.failedImportsInARow,
    });
}

/** A whole copy's check that gave a verdict (services/backup-puller.ts checkWholeCopy). */
export function noteWholeCopyCheck(check: WholeCopyCheck): void {
    const r = readCopyRecord();
    write({ ...r, lastWhole: check, lastUncompared: null, lastExactAt: check.exact ? check.at : r.lastExactAt });
}

/**
 * A whole copy's check that gave none: the last verdict, the last exact copy's time, and so the report to the main server
 * stay as they were, and an incident there is neither opened nor ended by it.
 */
export function noteUncomparedCheck(check: UncomparedCheck): void {
    const r = readCopyRecord();
    write({ ...r, lastUncompared: check });
}

/** Why a pull failed, as a code: what the report may carry (never the error's own text). */
export function whyOf(stage: 'fetch' | 'import', e: unknown): WhyCode {
    const err = e as { message?: unknown; name?: unknown } | null | undefined;
    const msg = String(err?.message || e || '');
    if (stage === 'import') {
        if (/conservation/i.test(msg)) return 'conservation';
        if (/signature|untrusted|mirror/i.test(msg)) return 'signature';
        return 'import-error';
    }
    if (err?.name === 'AbortError') return 'timeout';
    const http = /^primary returned HTTP (\d{3})$/.exec(msg);
    if (http && /^[1-5]\d\d$/.test(http[1])) return `http-${Number(http[1])}`;
    if (e instanceof SyntaxError) return 'unparseable';
    return 'network';
}

/** The report for the next pull's header (services/standby-report.ts). */
export function standbyReport(now = Date.now()): StandbyReport {
    const r = readCopyRecord();
    // The id is kept from the first report on, so the main server knows this standby from any other it has.
    if (!db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(KEY)) write(r);
    const ago = (t: number | null) => (t === null ? null : Math.max(0, Math.round(now - t)));
    return {
        v: 1, id: r.id, last: r.lastOutcome ?? 'none', why: r.lastWhy, fails: r.failedImportsInARow,
        okAgo: ago(r.lastOkAt), wholeAgo: ago(r.lastWhole?.at ?? null), exact: r.lastWhole ? r.lastWhole.exact : null,
        exactAgo: ago(r.lastExactAt), differs: r.lastWhole && !r.lastWhole.exact ? r.lastWhole.differs.slice(0, 40) : [],
        hashed: r.lastWhole?.hashed ?? false,
    };
}

function notComparedInWords(notCompared: UncomparedCheck['notCompared']): string {
    const words = notCompared.map((n) => (n === 'content'
        ? 'the main server was changing while it made that copy, so it sent nothing to compare each table\'s content with'
        : 'the copy named accounts this server cannot hold, so its ledger could not be compared account by account'));
    return words.length > 0 ? words.join('; ') : 'not everything in it could be compared';
}

/**
 * The take-over preview's words on this standby's copy (services/takeover.ts): when its last exact copy of the main server
 * was, or in plain words what didn't match and when the last exact one was; that its last copies were refused; that its
 * last copy is old. `warning` when any of those: a take-over still goes ahead (design, Marty's answer 4).
 */
export function copyCheckForPreview(lastCopyAtInMemory: number | null, now = Date.now()): {
    lastCopyAt: number | null; lastExactAt: number | null; lastWholeAt: number | null; exact: boolean | null;
    lastUncomparedAt: number | null; differs: string[]; failedImportsInARow: number; warning: boolean; lines: string[];
} {
    const r = readCopyRecord();
    const lastCopyAt = lastCopyAtInMemory ?? r.lastOkAt;
    const lines: string[] = [];
    let warning = false;
    const w = r.lastWhole;
    const u = r.lastUncompared;
    if (w?.exact) {
        lines.push(`Last exact copy of the main server: ${timeInWords(r.lastExactAt)}.`);
    } else if (w) {
        warning = true;
        const what = w.differs.includes('ledger') && w.ledgerDiffering > 0
            ? differsInWords(w.differs).replace("members' balances", `${w.ledgerDiffering} account${w.ledgerDiffering === 1 ? "'s balance" : "s' balances"}`)
            : differsInWords(w.differs);
        lines.push(`This server's last whole copy of the main server${u ? ' that could be compared with it' : ''}, at ${timeInWords(w.at)}, did not match it: ${what} differed.`);
        lines.push(r.lastExactAt !== null
            ? `Last exact copy of the main server: ${timeInWords(r.lastExactAt)}.`
            : 'This server has no exact copy of the main server on record.');
    } else {
        warning = true;
        lines.push(u
            ? 'This server has no whole copy of the main server on record that could be compared with it in full, so it cannot say its copy is exact.'
            : 'This server has not checked a whole copy of the main server yet, so it cannot say its copy is exact.');
    }
    // A later whole copy that could not be compared in full: said as such, and the last exact copy's time stays the older one.
    if (u) lines.push(`Its last whole copy of the main server, at ${timeInWords(u.at)}, could not be compared with it in full: ${notComparedInWords(u.notCompared)}.`);
    if (r.failedImportsInARow > 0) {
        warning = true;
        lines.push(`Its last ${r.failedImportsInARow === 1 ? 'copy was' : `${r.failedImportsInARow} copies were`} refused: ${whyInWords(r.lastWhy)}.`);
    }
    if (lastCopyAt === null || now - lastCopyAt >= STALE_MS) {
        warning = true;
        lines.push(lastCopyAt === null
            ? 'This server has no copy of the main server on record.'
            : `Its last copy of the main server was at ${timeInWords(lastCopyAt)}: anything that changed there after that is not here.`);
    }
    if (warning) lines.push('The take-over goes ahead all the same: what did not match, or changed since, may be missing or wrong afterwards.');
    return {
        lastCopyAt, lastExactAt: r.lastExactAt, lastWholeAt: w?.at ?? null, exact: w ? w.exact : null,
        lastUncomparedAt: u?.at ?? null, differs: w && !w.exact ? w.differs : [], failedImportsInARow: r.failedImportsInARow, warning, lines,
    };
}
