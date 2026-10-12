/**
 * Prune Stale Posts, sent the way the node takes it: POST /api/local/admin/posts/bulk-delete answers 400 above
 * MAX_BULK_DELETE_POSTS ids (apps/server/src/routes/admin.ts), so a longer list goes in batches, one after another.
 */

/**
 * The most post ids one bulk-delete request carries. Mirrors MAX_BULK_DELETE_POSTS in
 * apps/server/src/routes/admin.ts (the manager cannot import from the server); change both together.
 */
export const BULK_DELETE_BATCH_SIZE = 200;

/** One escrow the node could not refund in full while deleting (the server's EscrowRefundShortfall). */
export interface BulkDeleteRefundShortfall {
    transactionId: string;
    postId: string;
    buyerPubkey: string;
    owed: number | null;
    refunded: number;
}

/** What one batch came back with: the route's answer on success, or why it failed. */
export type BulkDeleteBatchResult =
    | { ok: true; deleted: number; refundShortfalls?: BulkDeleteRefundShortfall[] }
    | { ok: false; error: string };

export interface BulkDeleteOutcome {
    /** How many ids were asked for in all. */
    total: number;
    /** The node's deleted counts, added up over every batch that went through. */
    deleted: number;
    /** Every batch's refund shortfalls, in order. */
    refundShortfalls: BulkDeleteRefundShortfall[];
    /** How many batches the node answered with success. */
    batchesDone: number;
    /** Set when a batch failed: the server's reason. No batch after it was sent. */
    error?: string;
}

/** Splits `ids` into consecutive batches of at most `size`. */
export function chunkIds<T>(ids: readonly T[], size = BULK_DELETE_BATCH_SIZE): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
    return batches;
}

/**
 * Sends `ids` through `sendBatch` in batches of at most BULK_DELETE_BATCH_SIZE, each only after the one before it
 * answered, and stops at the first that fails.
 */
export async function bulkDeleteInBatches(
    ids: readonly string[],
    sendBatch: (batch: string[]) => Promise<BulkDeleteBatchResult>,
): Promise<BulkDeleteOutcome> {
    const outcome: BulkDeleteOutcome = { total: ids.length, deleted: 0, refundShortfalls: [], batchesDone: 0 };
    for (const batch of chunkIds(ids)) {
        let result: BulkDeleteBatchResult;
        try {
            result = await sendBatch(batch);
        } catch (e: unknown) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!result.ok) {
            outcome.error = result.error;
            return outcome;
        }
        outcome.deleted += result.deleted;
        if (result.refundShortfalls?.length) outcome.refundShortfalls.push(...result.refundShortfalls);
        outcome.batchesDone += 1;
    }
    return outcome;
}

/**
 * One bulk-delete request to the node. A 2xx answer reads `deleted` (else `deletedCount`, else the batch size, as
 * the screen always did); anything else, or a body that is not JSON, is a failure with the server's reason.
 */
export async function sendBulkDeleteBatch(url: string, headers: Record<string, string>, batch: string[]): Promise<BulkDeleteBatchResult> {
    const res = await fetch(url, { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify({ postIds: batch }) });
    let data: { deleted?: number; deletedCount?: number; refundShortfalls?: BulkDeleteRefundShortfall[]; error?: string } = {};
    try {
        data = await res.json();
    } catch {
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    }
    if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
    return {
        ok: true,
        deleted: data?.deleted ?? data?.deletedCount ?? batch.length,
        ...(Array.isArray(data?.refundShortfalls) ? { refundShortfalls: data.refundShortfalls } : {}),
    };
}

/** The line the screen shows for an outcome. */
export function describeBulkDeleteOutcome(o: BulkDeleteOutcome): string {
    if (o.error === undefined) return `Deleted ${o.deleted} post(s).`;
    // The first batch failing deleted nothing: say so as the screen always has.
    if (o.batchesDone === 0) return `Failed: ${o.error}`;
    return `Deleted ${o.deleted} of ${o.total}, then: ${o.error}`;
}
