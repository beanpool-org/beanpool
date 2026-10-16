/**
 * How the shell commands that replace this server's database (`beanpool restore`, `beanpool restore-point roll-back`)
 * tell that the node is running (design case 18 §3.5: "it refuses while state.db is locked by a running node"), and how
 * a node is kept from starting while one of them runs.
 *
 * state.db alone cannot say it: an idle connection in WAL mode holds no lock on the database file after a write, only
 * after a read, so a probe there passes beside a node that has just written (measured, S3). So `data/.node-running.lock`
 * is held for a whole process life, by the node and by the shell command: a tiny SQLite file in EXCLUSIVE locking mode,
 * written once, which keeps its exclusive lock until the connection closes. The operating system releases it when the
 * process ends, however it ends, so a crashed holder never leaves a stale lock: a lock that is held always has a live
 * holder. The lock is on the file, so a `docker compose run` container on the same data folder sees it.
 *
 * Whoever finds it held waits (the node) or refuses (the shell): a node never runs beside a restore, or beside another
 * node on the same data folder (#2017 review B1).
 *
 * No database of the node's here, so the shell reads it before it loads anything that opens state.db.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const NODE_RUNNING_LOCK = '.node-running.lock';
/** The lock as people are told about it: the data folder is /data in the container, ./data beside the compose file. */
export const NODE_RUNNING_LOCK_SHOWN = `data/${NODE_RUNNING_LOCK}`;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

const BUSY = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);
/** Not a database, so nobody's lock: a holder writes the header in its first write, under its exclusive lock, and a
 *  reader gets BUSY before it reads a byte. */
const NOT_A_LOCK = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT']);

/** This process's hold: the connection, and which file it is on (one removed and made again is another file). */
let held: { conn: Database.Database; dev: number; ino: number } | null = null;

function openHeld(file: string): Database.Database {
    const conn = new Database(file);
    try {
        conn.pragma('busy_timeout = 0');
        conn.pragma('journal_mode = DELETE');
        conn.pragma('locking_mode = EXCLUSIVE');
        // A write: in EXCLUSIVE locking mode the exclusive lock it takes is kept until close.
        conn.exec('CREATE TABLE IF NOT EXISTS held (id INTEGER PRIMARY KEY, at TEXT, pid INTEGER)');
        conn.prepare('INSERT OR REPLACE INTO held (id, at, pid) VALUES (1, ?, ?)').run(new Date().toISOString(), process.pid);
        return conn;
    } catch (e) {
        try { conn.close(); } catch { /* closed */ }
        throw e;
    }
}

export type NodeRunningLockTry = { held: true } | { held: false; busy: boolean; code: string };

/**
 * Take the lock now, without waiting. `busy` when another process holds it: a node, or a `beanpool restore`. A file at
 * its path that is not a database is nobody's lock and is replaced (#2017 review N6). Any other failure (a read-only
 * file, a folder at its path) is its code.
 */
export function tryHoldNodeRunningLock(dir = dataDir()): NodeRunningLockTry {
    if (held) return { held: true };
    const file = path.join(dir, NODE_RUNNING_LOCK);
    for (let attempt = 0; ; attempt++) {
        try {
            const conn = openHeld(file);
            const st = fs.statSync(file);
            held = { conn, dev: st.dev, ino: st.ino };
            return { held: true };
        } catch (e: any) {
            const code = String(e?.code || e?.message || e);
            if (BUSY.has(code)) return { held: false, busy: true, code };
            if (NOT_A_LOCK.has(code) && attempt === 0) {
                try {
                    for (const f of [file, `${file}-journal`]) fs.rmSync(f, { force: true });
                } catch (rm: any) {
                    return { held: false, busy: false, code: String(rm?.code || code) };
                }
                console.warn(`[Lock] ${NODE_RUNNING_LOCK_SHOWN} was not a lock file (${code}): replaced.`);
                continue;
            }
            return { held: false, busy: false, code };
        }
    }
}

/** A pause that blocks the thread: the node's wait runs while its modules are still being imported (boot-lock.ts). */
function sleepMs(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The way out, said with each waiting line (#2017 confirmation review N7): a restore whose session was dropped at a
 *  question keeps its container, and the lock, until it is ended. */
export const WAITING_WAY_OUT = 'If no restore is running: docker ps shows one left open (a container named …-run-…): finish it, '
    + 'or end it with docker rm -f NAME.';
/** After a minute of waiting, the other cause (N8): where file locks fail (some network shares), every lock reads as
 *  held. BeanPool cannot run there; before the lock, the node stopped at its first state.db open instead. */
export const NO_WORKING_LOCKS = 'or this folder is on a file system without working file locks (some network shares), where '
    + 'BeanPool cannot run';

/**
 * In the node, before anything opens state.db (boot-lock.ts), held until the process ends. While another process holds
 * it (a `beanpool restore` replacing this server, or another node on this data folder) the node waits, and says so every
 * 10 s with the way out: running beside either breaks the database. It blocks: nothing of the node has started yet.
 * Outside Docker a stop signal still ends it at once. In the image the node is PID 1 (su-exec execs it), which gets no
 * default handler for SIGTERM, and the thread is blocked in Atomics.wait, so `docker stop` ends it with the kill at the
 * end of its grace period: harmless, as nothing was opened (#2017 confirmation review N10, measured). Any other failure
 * is logged and the node runs; the shell's state.db probe is then the only check.
 */
export function holdNodeRunningLock(dir = dataDir(), waits = { retryMs: 1000, sayEveryMs: 10_000, locksMayFailAfterMs: 60_000 }): void {
    const started = Date.now();
    let saidAt: number | null = null;
    // A first start in a folder that is not there yet: db/db.ts would make it a moment later.
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the lock's own open says why */ }
    for (;;) {
        const r = tryHoldNodeRunningLock(dir);
        if (r.held) {
            if (saidAt !== null) console.log(`[Boot] ${NODE_RUNNING_LOCK_SHOWN} was let go: this node starts.`);
            return;
        }
        if (!r.busy) {
            console.warn(`[Boot] Could not hold ${NODE_RUNNING_LOCK_SHOWN} (${r.code}): beanpool restore will check state.db only.`);
            return;
        }
        if (saidAt === null || Date.now() - saidAt >= waits.sayEveryMs) {
            saidAt = Date.now();
            const waited = saidAt - started;
            console.warn(`[Boot] ${NODE_RUNNING_LOCK_SHOWN} is held: a beanpool restore or another node is using this data folder`
                + `${waited >= waits.locksMayFailAfterMs ? `, ${NO_WORKING_LOCKS}` : ''}. `
                + `This node waits until it is let go (${Math.round(waited / 1000)} s so far). ${WAITING_WAY_OUT}`);
        }
        sleepMs(waits.retryMs);
    }
}

/** The node stops (tests), or a shell command refuses before it changes anything. */
export function releaseNodeRunningLock(): void {
    try { held?.conn.close(); } catch { /* closed */ }
    held = null;
}

/**
 * In the shell, just before it replaces anything: is the lock it took still its own? The file at the path must be the
 * one it holds. One removed while the command waited at a question, and made again by a node that started then, is
 * another file, held by that node.
 */
export function nodeRunningLockStillOurs(dir = dataDir()): boolean {
    if (!held) return false;
    try {
        const st = fs.statSync(path.join(dir, NODE_RUNNING_LOCK));
        if (st.dev !== held.dev || st.ino !== held.ino) return false;
        held.conn.prepare('UPDATE held SET at = ? WHERE id = 1').run(new Date().toISOString());
        return true;
    } catch {
        return false;
    }
}

/**
 * Is another process holding the lock? A file that is not there was never held (no node started on this version); one
 * that is not a database is nobody's. Asked from a process that holds it itself, the answer is yes.
 */
export function nodeRunningLockHeld(dir = dataDir()): boolean {
    let conn: Database.Database;
    try {
        conn = new Database(path.join(dir, NODE_RUNNING_LOCK), { fileMustExist: true });
    } catch (e: any) {
        if (e?.code === 'SQLITE_CANTOPEN') return false;
        throw e;
    }
    try {
        conn.pragma('busy_timeout = 0');
        conn.prepare('SELECT COUNT(*) FROM sqlite_master').get();
        return false;
    } catch (e: any) {
        if (BUSY.has(e?.code)) return true;
        if (NOT_A_LOCK.has(e?.code)) return false;
        throw e;
    } finally {
        conn.close();
    }
}
