/**
 * The swap of a standby's whole copy, at boot, before the database opens (design scratch/global-node/DESIGN-paged-copies-
 * fable.md §4.2 and §4.3; services/stager.ts builds the copy in `data/staging`).
 *
 * Run before the database opens: db/db.ts calls it right before it opens `state.db`, whichever module imported it
 * first, and index.ts imports this module first of all (right after the report scrub), as the take-over harness does. It
 * imports nothing that opens the database, only Node, better-sqlite3 and services/stager.ts's constants (that module
 * imports nothing of the server's at its top level). Once a process: the first call does it.
 *
 * - `staging/READY` and `staging/state.db`, and the staging database passes `PRAGMA quick_check`: `state.db` (with its
 *   `-wal` and `-shm`) becomes `state.previous.db`, the staging database becomes `state.db`, and the staging directory
 *   goes. `state.previous.db` is deleted once the new one passes its first check: on a standby, by its puller, at the first
 *   copy that lands on it or the first whole copy's closing checks, in whichever process that is (it deletes the file
 *   whenever it finds one, a swap being the only thing that makes one), or sooner when a whole copy needs its room
 *   (services/backup-puller.ts); on a server promoted by a take-over, whose puller never runs again, at the start whose
 *   take-over audit found its ledger adds up (services/takeover.ts). It holds rows members deleted since, so nothing keeps it
 *   longer. Never in a process whose swap failed part way (deletePreviousDatabase): that file may then be the only whole
 *   database here.
 * - Killed between the two renames: `state.previous.db`, no `state.db`, and the staging database still there: the swap
 *   finishes (a rename is atomic, and the older previous is never written over by nothing).
 * - Killed after the swap, before the staging directory went: READY and no staging database: the staging goes.
 * - A staging directory with no READY (a copy that was being built when the server stopped), or a staging database that
 *   fails its check: the staging goes, and the live copy is as it was.
 * - A take-over that is under way (its journal, services/takeover.ts, not complete): the staging goes. A copy made
 *   before a take-over must never replace what the take-over wrote.
 *
 * Never throws: a swap that fails leaves the live copy as it was and says why.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
// Its constants only: services/stager.ts imports nothing of the server's at its top level.
import { STAGING_DIR_NAME as STAGING, READY_FILE as READY, PREVIOUS_DB } from '../services/stager.js';

/** services/takeover.ts TAKEOVER_JOURNAL_FILE. */
const TAKEOVER_JOURNAL = 'takeover-journal.json';

export type SwapOutcome = 'none' | 'swapped' | 'discarded' | 'failed';

let done: SwapOutcome | null = null;

function takeoverUnderWay(dataDir: string): boolean {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(dataDir, TAKEOVER_JOURNAL), 'utf-8')) as { state?: unknown };
        return j?.state !== 'complete';
    } catch {
        return false;
    }
}

function renameIfThere(from: string, to: string): void {
    if (fs.existsSync(from)) fs.renameSync(from, to);
    else fs.rmSync(to, { force: true });
}

/** The swap for `dataDir` (BEANPOOL_DATA_DIR, as db/db.ts reads it). Once a process. */
export function swapStagedCopyAtBoot(dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data')): SwapOutcome {
    if (done) return done;
    done = swap(dataDir);
    return done;
}

function swap(dataDir: string): SwapOutcome {
    const staging = path.join(dataDir, STAGING);
    if (!fs.existsSync(staging)) return 'none';
    const discard = (why: string): SwapOutcome => {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* the next boot tries again */ }
        console.warn(`[Swap] The whole copy in ${STAGING}/ was not swapped in, and is deleted: ${why}. This server's copy is as it was.`);
        return 'discarded';
    };
    try {
        const ready = path.join(staging, READY);
        const staged = path.join(staging, 'state.db');
        const live = path.join(dataDir, 'state.db');
        if (!fs.existsSync(ready)) return discard('it was still being built when the server stopped');
        if (takeoverUnderWay(dataDir)) return discard('a take-over is under way');
        if (!fs.existsSync(staged)) {
            // Swapped already: only the staging directory was left.
            fs.rmSync(staging, { recursive: true, force: true });
            return 'swapped';
        }
        let check = 'unread';
        try {
            const conn = new Database(staged, { readonly: true, fileMustExist: true });
            try { check = String(conn.pragma('quick_check', { simple: true })); } finally { conn.close(); }
        } catch (e) {
            check = (e as Error)?.message || String(e);
        }
        if (check !== 'ok') return discard(`its database failed its check (${check.slice(0, 200)})`);
        // The live database and its WAL together, so the previous one opens as it was; never an older previous written over
        // by a live one that is already gone (a swap killed between its renames).
        const previous = path.join(dataDir, PREVIOUS_DB);
        if (fs.existsSync(live)) {
            for (const s of ['-wal', '-shm']) fs.rmSync(previous + s, { force: true });
            fs.renameSync(live, previous);
            for (const s of ['-wal', '-shm']) renameIfThere(live + s, previous + s);
        } else {
            // A swap killed between its renames: the live database is the previous one now, and a WAL left under the live
            // name is its WAL.
            for (const s of ['-wal', '-shm']) {
                if (!fs.existsSync(live + s)) continue;
                if (fs.existsSync(previous) && !fs.existsSync(previous + s)) fs.renameSync(live + s, previous + s);
                else fs.rmSync(live + s, { force: true });
            }
        }
        fs.renameSync(staged, live);
        for (const s of ['-wal', '-shm']) renameIfThere(staged + s, live + s);
        const info = (() => { try { return JSON.parse(fs.readFileSync(ready, 'utf-8')); } catch { return {}; } })();
        fs.rmSync(staging, { recursive: true, force: true });
        console.log(`[Swap] Swapped in the whole copy built in ${STAGING}/ (${info.pages ?? '?'} page(s), made ${info.generatedAt ?? '?'}); `
            + `the database it replaced is kept as ${PREVIOUS_DB} until the next copy lands.`);
        return 'swapped';
    } catch (e) {
        console.error(`[Swap] Swapping in the whole copy in ${STAGING}/ failed: ${(e as Error)?.message || e}. This server starts on the database it has.`);
        return 'failed';
    }
}

/** Whether any file of the database the last swap replaced is here: PREVIOUS_DB, or a `-wal` or `-shm` of it left over. */
export function previousDatabaseThere(dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data')): boolean {
    const previous = path.join(dataDir, PREVIOUS_DB);
    return ['', '-wal', '-shm'].some((s) => fs.existsSync(previous + s));
}

/**
 * Delete the database the last swap replaced (PREVIOUS_DB, with its `-wal` and `-shm`), unless this process's swap failed
 * part way or there is no `state.db` beside it: then it may be the only whole database here (the renames are not undone,
 * and the next start's swap finishes them), and it stays. The callers say when it is no longer needed. Never throws.
 *
 * The `-wal` and `-shm` go first, the database last: a delete stopped part way (a SIGKILL, a file that would not go)
 * leaves the database, which the callers see and delete again, never a WAL on its own holding rows members changed or
 * deleted since (#1334 review round 3, finding 1). A WAL or index left on its own, by an older build, goes whatever else
 * holds: it is no database.
 */
export function deletePreviousDatabase(dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data')): {
    had: boolean; deleted: boolean; kept: string | null; errors: string[];
} {
    const previous = path.join(dataDir, PREVIOUS_DB);
    const had = previousDatabaseThere(dataDir);
    const errors: string[] = [];
    if (!had) return { had, deleted: false, kept: null, errors };
    let kept: string | null = null;
    if (fs.existsSync(previous)) {
        if (done === null) kept = 'the swap at boot has not run in this process';
        else if (done === 'failed') kept = "this start's swap failed part way, so it may be the only whole database here";
        else if (!fs.existsSync(path.join(dataDir, 'state.db'))) kept = 'there is no state.db beside it';
    }
    if (kept) return { had, deleted: false, kept, errors };
    for (const s of ['-wal', '-shm', '']) {
        try { fs.rmSync(previous + s, { force: true }); } catch (e) { errors.push(`${PREVIOUS_DB}${s} could not be deleted: ${(e as Error)?.message || e}`); }
    }
    return { had, deleted: !previousDatabaseThere(dataDir), kept: null, errors };
}

swapStagedCopyAtBoot();
