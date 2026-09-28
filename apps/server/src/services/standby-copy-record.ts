/**
 * A standby's record of its own copies (design scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §2 G8): how its
 * last pull went and why, how many copies in a row were refused, when its last copy landed, and its last whole copy's
 * check (services/backup-puller.ts checkWholeCopy): exact, or what differed, and when the last exact one was. A check that
 * could not compare everything gives no verdict: it is kept beside the last one that did, and changes nothing it says.
 * And the tables its copies leave out, or are refused over, because the main server holds more rows of them than one copy
 * carries (scratch/global-node/DESIGN-replica-flood-bounds-opus.md §4.2 N4, §5).
 *
 * Kept in node_config (`standby_copy_record`), so it outlives a restart: a standby restarted after its main server died
 * still says, in the take-over preview, when its last exact copy was. Sent to the main server with each pull
 * (services/standby-report.ts), which tells the community's owners when it needs them (services/standby-health.ts).
 */

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import {
    type PullOutcome, type StandbyReport, type WhyCode, MAX_TABLES_NAMED, differsInWords, timeInWords, whyInWords,
} from './standby-report.js';

const KEY = 'standby_copy_record';
/** A last copy older than this, and the take-over preview says so. */
const STALE_MS = 60 * 60_000;
/**
 * How long a copy that didn't match counts as mending itself after its check asked for the held force-resync
 * (services/backup-puller.ts): the resync is the next pull, and its own whole copy is checked. Past this with no check
 * that gave a verdict since (one whose copy came without hashes gives none), it is told as not matching.
 */
export const HEALING_MS = 60 * 60_000;

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
    /**
     * Listing photos the main server could not read from its own storage, left out of the check (the copy's
     * `photosOmitted`): no copy brings them, so they are said as such, never as a difference.
     */
    photosLeftOut: number;
    /**
     * This check asked for the held force-resync (services/backup-puller.ts): the standby mends the copy by itself, and
     * its main server tells nobody unless the check after that resync still differs (design G8, Marty's answer 2).
     */
    resyncAsked: boolean;
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
     * written to while the copy was being made); `ledger`, every account (the copy names accounts this server can't hold,
     * names one twice, or names none while this server holds some).
     */
    notCompared: ('content' | 'ledger')[];
    photosLeftOut: number;
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
    /**
     * When this standby last asked for a force-resync for a copy that didn't match. Kept here, not only in the puller's
     * memory, so a restart allows no sooner one: at most one in six hours, and a difference no resync mends never loops.
     */
    lastMismatchResyncAt: number | null;
    /**
     * When a copy last came for the force-resync it asked for (services/backup-puller.ts). One asked for since, and not
     * taken, is still due, across a restart too (review 4119011899): a standby restarted between asking and taking still
     * takes it, once.
     */
    lastMismatchResyncTakenAt: number | null;
    /**
     * The tables the copies that landed left out (engine/sync.ts ImportResult.tablesLeftOut): each is stale here, from
     * `since` on, until a whole copy carries it. A delta adds to them; a whole copy that lands says which it left out.
     */
    lastLeftOut: TablesNamed | null;
    /**
     * The tables of the ledger set the last copy refused over (engine/sync.ts OversizedCopyError), until a whole copy lands:
     * deltas can land meanwhile, while every whole copy is refused.
     */
    lastOversized: TablesNamed | null;
}

/** Tables named by the manifest's names: since when, and the last time a copy named them. */
export interface TablesNamed {
    since: number;
    at: number;
    tables: string[];
}

function fresh(): CopyRecord {
    return {
        id: crypto.randomBytes(16).toString('hex'), lastPullAt: null, lastOutcome: null, lastWhy: null,
        failedImportsInARow: 0, lastOkAt: null, lastWhole: null, lastUncompared: null, lastExactAt: null, lastMismatchResyncAt: null,
        lastMismatchResyncTakenAt: null, lastLeftOut: null, lastOversized: null,
    };
}

function tablesNamed(v: unknown): TablesNamed | null {
    const t = v as Partial<TablesNamed> | null | undefined;
    if (!t || typeof t !== 'object' || num(t.at) === null || num(t.since) === null || !Array.isArray(t.tables)) return null;
    const tables = t.tables.filter((x): x is string => typeof x === 'string').slice(0, MAX_TABLES_NAMED);
    return tables.length > 0 ? { since: t.since as number, at: t.at as number, tables } : null;
}

/** Named since the first time, now too: `tables` with any named before kept (a delta's), or `tables` alone (a whole copy's). */
function named(prev: TablesNamed | null, tables: readonly string[], now: number, keep: boolean): TablesNamed | null {
    const all = [...new Set([...(keep && prev ? prev.tables : []), ...tables])].sort().slice(0, MAX_TABLES_NAMED);
    if (all.length === 0) return null;
    const still = !!prev && prev.tables.some((t) => all.includes(t));
    return { since: still ? prev!.since : now, at: now, tables: all };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0);

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
                photosLeftOut: count(w.photosLeftOut), resyncAsked: w.resyncAsked === true,
                snapshotGeneratedAt: typeof w.snapshotGeneratedAt === 'string' ? w.snapshotGeneratedAt : null,
            } : null,
            lastUncompared: u && typeof u === 'object' && num(u.at) !== null ? {
                at: u.at,
                notCompared: Array.isArray(u.notCompared) ? u.notCompared.filter((n: unknown) => n === 'content' || n === 'ledger') : [],
                photosLeftOut: count(u.photosLeftOut),
                snapshotGeneratedAt: typeof u.snapshotGeneratedAt === 'string' ? u.snapshotGeneratedAt : null,
            } : null,
            lastExactAt: num(r?.lastExactAt),
            lastMismatchResyncAt: num(r?.lastMismatchResyncAt),
            lastMismatchResyncTakenAt: num(r?.lastMismatchResyncTakenAt),
            lastLeftOut: tablesNamed(r?.lastLeftOut),
            lastOversized: tablesNamed(r?.lastOversized),
        };
    } catch {
        return fresh();
    }
}

function write(r: CopyRecord): void {
    db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(r));
}

/**
 * A pull whose copy landed (or the main server said nothing changed since the last one: no `copy`). `copy.leftOut`: the
 * tables it left out. A whole copy's are the whole story (any it carried is current again, and so is the ledger set); a
 * delta's add to the ones already stale, which only a whole copy brings back.
 */
export function noteCopyLanded(now = Date.now(), copy?: { whole: boolean; leftOut: readonly string[] }): void {
    const r = readCopyRecord();
    write({
        ...r, lastPullAt: now, lastOutcome: 'ok', lastWhy: null, failedImportsInARow: 0, lastOkAt: now,
        lastLeftOut: copy ? (copy.whole || copy.leftOut.length > 0 ? named(r.lastLeftOut, copy.leftOut, now, !copy.whole) : r.lastLeftOut) : r.lastLeftOut,
        lastOversized: copy?.whole ? null : r.lastOversized,
    });
}

/**
 * A pull that failed: `refused` when the copy came and was not imported, `fetch-failed` when none came. `oversized`: the
 * tables of the ledger set it was refused over (why `oversized`).
 */
export function noteCopyFailed(outcome: Exclude<PullOutcome, 'ok'>, why: WhyCode, now = Date.now(), oversized: readonly string[] = []): void {
    const r = readCopyRecord();
    write({
        ...r, lastPullAt: now, lastOutcome: outcome, lastWhy: why,
        // Only copies that came count: a main server that can't be reached is the main server's "no pull for an hour".
        failedImportsInARow: outcome === 'refused' ? r.failedImportsInARow + 1 : r.failedImportsInARow,
        lastOversized: why === 'oversized' && oversized.length > 0 ? named(r.lastOversized, oversized, now, false) : r.lastOversized,
    });
}

/** A whole copy's check that gave a verdict (services/backup-puller.ts checkWholeCopy). */
export function noteWholeCopyCheck(check: WholeCopyCheck): void {
    const r = readCopyRecord();
    write({
        ...r, lastWhole: check, lastUncompared: null, lastExactAt: check.exact ? check.at : r.lastExactAt,
        lastMismatchResyncAt: check.resyncAsked ? check.at : r.lastMismatchResyncAt,
    });
}

/** When this standby last asked for a force-resync for a copy that didn't match, across restarts; 0 for never. */
export function lastMismatchResyncAt(): number {
    return readCopyRecord().lastMismatchResyncAt ?? 0;
}

/**
 * This standby asked for the held force-resync outside a whole copy's check: a delta left the main server's deletions out
 * (services/backup-puller.ts). Kept, as the check's is, so a restart allows no sooner one and still takes this one.
 */
export function noteMismatchResyncAsked(at: number): void {
    const r = readCopyRecord();
    write({ ...r, lastMismatchResyncAt: at });
}

/** A copy came for the force-resync this standby asked for: it is taken, and no restart asks for it again. */
export function noteMismatchResyncTaken(now = Date.now()): void {
    const r = readCopyRecord();
    write({ ...r, lastMismatchResyncTakenAt: now });
}

/**
 * When this standby asked for the force-resync for a copy that didn't match that no copy has come for yet, or null: the
 * puller's first pull after a restart takes it (services/backup-puller.ts nextMode). Only while the copy counts as mending
 * itself (HEALING_MS): past that its main server tells the owners, and the next one waits for the six-hour slot.
 */
export function pendingMismatchResync(now = Date.now()): number | null {
    const r = readCopyRecord();
    const asked = r.lastMismatchResyncAt;
    if (asked === null || (r.lastMismatchResyncTakenAt !== null && r.lastMismatchResyncTakenAt >= asked)) return null;
    return now - asked < HEALING_MS ? asked : null;
}

/**
 * Whether the last whole copy's check found a difference this standby is mending by itself: it asked for the held
 * force-resync, and no check that gave a verdict has come since, for up to HEALING_MS. Its main server tells nobody of it.
 */
function mending(w: WholeCopyCheck | null, now: number): boolean {
    return !!w && !w.exact && w.resyncAsked && now - w.at < HEALING_MS;
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
        // engine/sync.ts OversizedCopyError: a table the ledger needs whole has more rows than one copy carries.
        if (err?.name === 'OversizedCopyError') return 'oversized';
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
        hashed: r.lastWhole?.hashed ?? false, healing: mending(r.lastWhole, now),
        // The deletions left out mend themselves: this standby takes a force-resync for them (services/backup-puller.ts).
        leftOut: (r.lastLeftOut?.tables ?? []).filter((t) => t !== 'tombstones'),
        oversized: r.lastOversized?.tables ?? [],
    };
}

function notComparedInWords(notCompared: UncomparedCheck['notCompared']): string {
    const words = notCompared.map((n) => (n === 'content'
        ? 'the main server was changing while it made that copy, so it sent nothing to compare each table\'s content with'
        : 'the copy did not carry every account in a form this server can hold, so its ledger could not be compared account by account'));
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
        // A whole copy that left tables out and found nothing else different: the tables are said below.
        if (w.differs.length > 0) {
            const what = w.differs.includes('ledger') && w.ledgerDiffering > 0
                ? differsInWords(w.differs).replace("members' balances", `${w.ledgerDiffering} account${w.ledgerDiffering === 1 ? "'s balance" : "s' balances"}`)
                : differsInWords(w.differs);
            lines.push(`This server's last whole copy of the main server${u ? ' that could be compared with it' : ''}, at ${timeInWords(w.at)}, did not match it: ${what} differed.`);
        }
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
    // Photos the main server can't read itself: said as such, never as a difference, and no warning (a take-over from here
    // loses nothing the main server could still show).
    const photos = (u ?? w)?.photosLeftOut ?? 0;
    if (photos > 0) {
        lines.push(`The main server could not read ${photos} listing photo${photos === 1 ? '' : 's'} from its own storage, so `
            + `${photos === 1 ? 'it was' : 'they were'} left out of that check: no copy can bring ${photos === 1 ? 'it' : 'them'} here.`);
    }
    // Tables the copies leave out (design §5, D): stale here, the rest current.
    const out = r.lastLeftOut;
    if (out) {
        warning = true;
        lines.push(`Its copies of the main server leave out ${differsInWords(out.tables)}: the main server holds more rows of `
            + `${out.tables.length === 1 ? 'it' : 'them'} than one copy carries. What this server has of ${out.tables.length === 1 ? 'it' : 'them'} `
            + `is from before ${timeInWords(out.since)}; everything else was copied.`);
    }
    if (r.failedImportsInARow > 0) {
        warning = true;
        lines.push(`Its last ${r.failedImportsInARow === 1 ? 'copy was' : `${r.failedImportsInARow} copies were`} refused: ${r.lastWhy === 'oversized' && r.lastOversized
            ? `the main server holds more rows of ${differsInWords(r.lastOversized.tables)} than one copy carries, and the ledger needs ${r.lastOversized.tables.length === 1 ? 'it' : 'them'} whole`
            : whyInWords(r.lastWhy)}. Nothing has landed since ${timeInWords(r.lastOkAt)}: this server holds the last copy that did, whole.`);
    } else if (r.lastOversized) {
        // Deltas land, and every whole copy is refused: this server's copy is current, and nothing can check it is exact.
        warning = true;
        lines.push(`Its whole copies of the main server are refused: the main server holds more rows of ${differsInWords(r.lastOversized.tables)} `
            + `than one copy carries, since ${timeInWords(r.lastOversized.since)}. Changes still reach it one by one, but nothing checks its copy is exact.`);
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
