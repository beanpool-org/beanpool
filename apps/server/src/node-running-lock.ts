/**
 * How the shell commands that replace this server's database (`beanpool restore`, `beanpool restore-point roll-back`)
 * tell that the node is running (design case 18 §3.5: "it refuses while state.db is locked by a running node").
 *
 * state.db alone cannot say it: an idle connection in WAL mode holds no lock on the database file after a write, only
 * after a read, so a probe there passes beside a node that has just written (measured, S3). So the node holds a lock of
 * its own, `data/.node-running.lock`, for its whole life: a tiny SQLite file in EXCLUSIVE locking mode, written once at
 * boot, which keeps its exclusive lock until the connection closes. The operating system releases it when the process
 * ends, however it ends, so a crashed node never leaves a stale lock; and the lock is on the file, so a `docker compose
 * run` container on the same data folder sees it.
 *
 * No database of the node's here, so the shell reads it before it loads anything that opens state.db.
 */
import path from 'node:path';
import Database from 'better-sqlite3';

export const NODE_RUNNING_LOCK = '.node-running.lock';

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

let held: Database.Database | null = null;

/** In the node, first thing at boot. Never blocks the boot: a lock that cannot be taken is logged, and the shell's
 *  state.db probe is then the only check. */
export function holdNodeRunningLock(dir = dataDir()): void {
    if (held) return;
    try {
        const conn = new Database(path.join(dir, NODE_RUNNING_LOCK));
        conn.pragma('busy_timeout = 0');
        conn.pragma('journal_mode = DELETE');
        conn.pragma('locking_mode = EXCLUSIVE');
        // A write: in EXCLUSIVE locking mode the exclusive lock it takes is kept until close.
        conn.exec('CREATE TABLE IF NOT EXISTS held (id INTEGER PRIMARY KEY, at TEXT, pid INTEGER)');
        conn.prepare('INSERT OR REPLACE INTO held (id, at, pid) VALUES (1, ?, ?)').run(new Date().toISOString(), process.pid);
        held = conn;
    } catch (e: any) {
        console.warn(`[Boot] Could not hold ${NODE_RUNNING_LOCK} (${e?.code || e?.message || e}): beanpool restore will check state.db only.`);
    }
}

/** Tests: the node stops. */
export function releaseNodeRunningLock(): void {
    try { held?.close(); } catch { /* closed */ }
    held = null;
}

/** In the shell: is a node holding the lock? A file that is not there was never held (no node started on this version). */
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
        if (e?.code === 'SQLITE_BUSY' || e?.code === 'SQLITE_LOCKED') return true;
        throw e;
    } finally {
        conn.close();
    }
}
