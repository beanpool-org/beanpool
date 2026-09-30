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
 *   longer. Never in a process whose swap failed part way, or that started with no database of its own
 *   (deletePreviousDatabase): that file may then be the only whole database here.
 * - Killed between the two renames: `state.previous.db`, no `state.db`, and the staging database still there: the swap
 *   finishes (a rename is atomic, and the older previous is never written over by nothing).
 * - Killed after the swap, before the staging directory went: READY and no staging database: the staging goes.
 * - A staging directory with no READY (a copy that was being built when the server stopped), or a staging database that
 *   fails its check: the staging goes, and the live copy is as it was.
 * - A take-over that is under way (its journal, services/takeover.ts, not complete): the staging goes. A copy made
 *   before a take-over must never replace what the take-over wrote.
 * - Any of these after a swap stopped between its renames (the staged copy torn, or a take-over under way): the staging
 *   goes and `state.previous.db`, which is this server's copy, becomes `state.db` again (putPreviousBack).
 * - `state.db` missing or empty and `state.previous.db` there with no staging: taken away from outside (by hand, or the
 *   disk). A standby puts the previous one back (its next copy brings it level); a main server refuses to start and says
 *   what to do, since that database is older than the one it ran on (swapStagedCopyAtBoot).
 * - Still no database of its own after that (a put-back that failed): the server stops before db/db.ts makes an empty one,
 *   and a restart tries again. It never runs on an empty database beside its copy.
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

/**
 * Whether this process started on a database of its own: a `state.db` there after the swap, before db/db.ts opened it (and
 * made a new, empty one when there was none). Null before the swap has run.
 */
let startedOnDatabase: boolean | null = null;

/** A database file worth keeping: there, not empty, and holding the members table. Never throws. */
function isDatabase(file: string): boolean {
    try {
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) return false;
        const conn = new Database(file, { readonly: true, fileMustExist: true });
        try { return !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'members'").get(); } finally { conn.close(); }
    } catch {
        return false;
    }
}

/**
 * No `state.db`, and `state.previous.db` there: a swap stopped between its two renames whose staged copy was then not
 * swapped in (discarded, or its rename failed), or a `state.db` removed by hand. The previous database is this server's
 * copy: it becomes `state.db` again (its `-wal` and `-shm` with it; one left under the live name is its own, as the swap
 * reads it), so the server never starts on an empty database while its copy sits beside it, and never deletes that copy as
 * "the database the last swap replaced" (#1334 review round 3, finding 2). The database is renamed last: a start stopped
 * part way finds it where it was and does this again. Returns whether it did. Never throws.
 */
function putPreviousBack(dataDir: string, say = true): boolean {
    const live = path.join(dataDir, 'state.db');
    const previous = path.join(dataDir, PREVIOUS_DB);
    if (fs.existsSync(live) || !fs.existsSync(previous)) return false;
    try {
        for (const s of ['-wal', '-shm']) {
            if (!fs.existsSync(previous + s)) continue;
            fs.rmSync(live + s, { force: true });
            fs.renameSync(previous + s, live + s);
        }
        fs.renameSync(previous, live);
        if (say) console.warn(`[Swap] There was no state.db, and ${PREVIOUS_DB} was there: it is this server's copy, and is state.db again.`);
        return true;
    } catch (e) {
        console.error(`[Swap] ${PREVIOUS_DB} could not be put back as state.db: ${(e as Error)?.message || e}. It is kept as it is.`);
        return false;
    }
}

/** No database of this server's own: `state.db` missing, or an empty file. */
function noDatabase(live: string): boolean {
    try { return !fs.existsSync(live) || fs.statSync(live).size === 0; } catch { return true; }
}

/** This server's role as config/node-role.ts resolves it (local-config.json's `nodeRole`, then NODE_ROLE), read here. */
function roleAtBoot(dataDir: string): 'primary' | 'backup' {
    try {
        const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'local-config.json'), 'utf-8')) as { nodeRole?: unknown };
        if (c?.nodeRole === 'primary' || c?.nodeRole === 'backup') return c.nodeRole;
    } catch { /* no readable config: the environment decides */ }
    return process.env.NODE_ROLE === 'backup' ? 'backup' : 'primary';
}

/** A boot condition this server must not start past, said as index.ts says its own (one line), then exit 1. */
function refuseToStart(why: string): never {
    console.error(`🚨 FATAL: ${why}`);
    process.exit(1);
}

/** The swap for `dataDir` (BEANPOOL_DATA_DIR, as db/db.ts reads it). Once a process. */
export function swapStagedCopyAtBoot(dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data')): SwapOutcome {
    if (done) return done;
    done = swap(dataDir);
    const live = path.join(dataDir, 'state.db');
    if (noDatabase(live) && fs.existsSync(path.join(dataDir, PREVIOUS_DB))) {
        if (fs.existsSync(path.join(dataDir, STAGING))) {
            // The swap's own doing (it failed part way, its staging kept for the next start): the previous one is this
            // server's copy.
            putPreviousBack(dataDir);
        } else if (roleAtBoot(dataDir) === 'backup') {
            // Taken away from outside (by hand, or the disk). On a standby the previous database carries its own cursor and
            // copy record: put back, the next copy brings it level with its main server.
            if (fs.existsSync(live)) fs.rmSync(live, { force: true }); // an empty file: nothing
            putPreviousBack(dataDir);
        } else {
            // On a main server (a take-over promoted it, or its role set by hand) the previous database is from before the
            // standby's last whole copy: older than the one it ran on, and never checked as a main server. Never run on it
            // unasked (#1334 review round 4, finding 1).
            refuseToStart(`${path.join(dataDir, 'state.db')} is ${fs.existsSync(live) ? 'empty' : 'missing'}, and ${path.join(dataDir, PREVIOUS_DB)} is there: `
                + 'that is the database from before this server\'s last whole copy as a standby, older than the one it ran on, so it is not started on. '
                + `Put back the state.db that was moved, or restore it from a backup; or, to run on the older database, rename ${PREVIOUS_DB} `
                + '(and its -wal and -shm, if there) to state.db, and start the server again.');
        }
    }
    // Still no database of its own beside the previous one (a put-back that failed: a rename refused, a full disk): stop
    // before db/db.ts makes a new, empty state.db, which would serve an empty community, drop a WAL moved under the live
    // name, and let a later start delete the previous database as "the one the last swap replaced". A restart tries the
    // put-back again (#1334 review round 4, finding 2).
    if (noDatabase(live) && fs.existsSync(path.join(dataDir, PREVIOUS_DB))) {
        refuseToStart(`${live} is ${fs.existsSync(live) ? 'empty' : 'missing'}, and ${path.join(dataDir, PREVIOUS_DB)}, this server's copy, `
            + 'could not be put back in its place (the reason is above). Nothing was changed, and starting again tries again. '
            + `If it keeps failing, rename ${PREVIOUS_DB} (and its -wal and -shm, if there) to state.db by hand.`);
    }
    startedOnDatabase = isDatabase(live);
    return done;
}

function swap(dataDir: string): SwapOutcome {
    const staging = path.join(dataDir, STAGING);
    if (!fs.existsSync(staging)) return 'none';
    const discard = (why: string): SwapOutcome => {
        // A swap stopped between its renames: this server's copy is state.previous.db until it is put back. Before the
        // staging goes: a start stopped between the two finds the staging again and does this again, and a state.db missing
        // with no staging always means one taken away from outside (swapStagedCopyAtBoot; #1334 review round 4).
        const back = putPreviousBack(dataDir, false); // said below
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* the next boot tries again */ }
        console.warn(`[Swap] The whole copy in ${STAGING}/ was not swapped in, and is deleted: ${why}. `
            + (back ? `The swap had been stopped between its renames: ${PREVIOUS_DB}, this server's copy, is state.db again.`
                : fs.existsSync(path.join(dataDir, 'state.db')) ? "This server's copy is as it was." : 'This server has no copy of its own.'));
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
 * part way or this process started with no database of its own (checked before db/db.ts opened, or made, `state.db`):
 * then it may be the only whole database here, and it stays. The callers say when it is no longer needed. Never throws.
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
        // Decided before db/db.ts opened state.db, which makes a new, empty one when there is none (review round 3, finding 2).
        else if (startedOnDatabase !== true) kept = 'this server started with no database of its own (its state.db was made new at this start), so it may be the only whole database here';
        else if (!fs.existsSync(path.join(dataDir, 'state.db'))) kept = 'there is no state.db beside it';
    }
    if (kept) return { had, deleted: false, kept, errors };
    for (const s of ['-wal', '-shm', '']) {
        try { fs.rmSync(previous + s, { force: true }); } catch (e) { errors.push(`${PREVIOUS_DB}${s} could not be deleted: ${(e as Error)?.message || e}`); }
    }
    return { had, deleted: !previousDatabaseThere(dataDir), kept: null, errors };
}

swapStagedCopyAtBoot();
