/**
 * The swap of a standby's whole copy, at boot, before the database opens (design scratch/global-node/DESIGN-paged-copies-
 * fable.md §4.2 and §4.3; services/stager.ts builds the copy in `data/staging`).
 *
 * Imported first (index.ts, right after the report scrub; the take-over harness likewise), because db/db.ts opens
 * `state.db` as it is imported: this imports nothing that does, only Node, better-sqlite3 and services/stager.ts's
 * constants (that module imports nothing of the server's at its top level).
 *
 * - `staging/READY` and `staging/state.db`, and the staging database passes `PRAGMA quick_check`: `state.db` (with its
 *   `-wal` and `-shm`) becomes `state.previous.db`, the staging database becomes `state.db`, and the staging directory
 *   goes. The standby's puller deletes `state.previous.db` once its first copy lands on the new one.
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

swapStagedCopyAtBoot();
