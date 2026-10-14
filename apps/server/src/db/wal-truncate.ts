/**
 * Empty the WAL after a delete (data-at-rest report F2). secure_delete (db/db.ts) zeroes a deleted or replaced row where
 * it lies in state.db, but state.db-wal still holds the pages as they were — the delete's own "before" and every earlier
 * write's — until a checkpoint folds the WAL back AND later writes happen to cover those frames: on a quiet node, days. A
 * truncating checkpoint empties the file at once. The WAL is what an operator, a host or a tarred copy of the data
 * directory takes with state.db.
 *
 * Never inside a transaction (the caller's commits first), and never waiting. A reader holding the WAL — a copy being
 * served to a standby in pages (engine/open-copies.ts) — makes a truncating checkpoint wait the whole busy timeout with the
 * event loop held, and then leaves the WAL as it was. So the busy timeout is 0 for this one statement: the checkpoint folds
 * back what it can, says it was busy, and is tried again every minute for up to an hour, until one empties the file. The
 * copy is never closed for it, as the operator's Clean storage closes it: a standby's copy matters more than an hour.
 */

import { db, afterTransactionCommit } from './db.js';

const RETRIES = 60;
/** Between tries while a reader holds the WAL. A suite sets WAL_TRUNCATE_RETRY_MS to see a retry without waiting a minute. */
const retryMs = () => Number(process.env.WAL_TRUNCATE_RETRY_MS) || 60_000;

let retry: NodeJS.Timeout | null = null;
let triesLeft = 0;
let pendingWhy = '';

/** One truncating checkpoint that never waits. True when it emptied the WAL. Never throws. */
function truncateNow(): boolean {
    let prior: number | null = null;
    try {
        prior = db.pragma('busy_timeout', { simple: true }) as number;
        db.pragma('busy_timeout = 0');
        const [cp] = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[];
        return !!cp && cp.busy === 0;
    } catch {
        return false;
    } finally {
        if (prior !== null) {
            try { db.pragma(`busy_timeout = ${prior}`); } catch { /* the connection closed under it */ }
        }
    }
}

function scheduleRetry(): void {
    if (retry) return;
    retry = setTimeout(() => {
        retry = null;
        // A restore closed the connection (routes/backup.ts): the server starts again on the restored file.
        if (!db.open) return;
        if (truncateNow()) return;
        if (--triesLeft > 0) scheduleRetry();
        else console.warn(`[DB] The WAL is still held by a reader an hour after ${pendingWhy}; the next checkpoint writes over what it keeps.`);
    }, retryMs());
    retry.unref?.();
}

/** Empty the WAL now, or as soon as no reader holds it. `why` names the delete, for the log. Never throws. */
export function truncateWalAfterDelete(why: string): void {
    if ((db as any).inTransaction) {
        afterTransactionCommit(() => truncateWalAfterDelete(why));
        return;
    }
    if (truncateNow()) return;
    pendingWhy = why;
    triesLeft = RETRIES;
    scheduleRetry();
}
