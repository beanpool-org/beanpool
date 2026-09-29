/**
 * The copies this server is serving in pages (engine/copy-pages.ts) whose snapshot is open: each holds a read transaction
 * on a second connection to state.db, which keeps every page written since in the WAL until it closes. What needs the
 * database to itself closes them first: the recovery seal's VACUUM and its checkpoint (services/recovery-seal-key.ts),
 * which a reader holding the WAL makes fail, and a restore, which writes a new state.db over this one. A standby asking
 * for a page of a closed copy is told there is no such copy, and asks for a new one.
 *
 * Its own module, importing nothing, so the seal can reach it without importing the copy's code.
 */

const open = new Map<string, (why: string) => void>();

/** A copy's snapshot is open; `close` closes it, and says why in the log. */
export function noteCopyOpen(copyId: string, close: (why: string) => void): void {
    open.set(copyId, close);
}

/** A copy's snapshot closed. */
export function noteCopyClosed(copyId: string): void {
    open.delete(copyId);
}

/** Close every copy's snapshot now, for `why`. How many there were. Never throws. */
export function closeOpenCopies(why: string): number {
    const closers = [...open.values()];
    open.clear();
    for (const close of closers) {
        try { close(why); } catch (e) { console.warn('[Copy] Closing a copy failed:', (e as Error)?.message || e); }
    }
    return closers.length;
}
