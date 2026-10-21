import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    BULK_DELETE_BATCH_SIZE,
    bulkDeleteInBatches,
    chunkIds,
    describeBulkDeleteOutcome,
    sendBulkDeleteBatch,
    type BulkDeleteBatchResult,
} from './bulk-delete-posts';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `post_${i}`);

/** A stand-in node: answers each batch with its size deleted, and records how many requests were open at once. */
function fakeNode(failOnCall?: number, reason = 'Ledger paused') {
    const calls: string[][] = [];
    let inFlight = 0, maxInFlight = 0;
    const send = async (batch: string[]): Promise<BulkDeleteBatchResult> => {
        calls.push(batch);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 1));
        inFlight--;
        if (calls.length === failOnCall) return { ok: false, error: reason };
        return { ok: true, deleted: batch.length };
    };
    return { send, calls, maxInFlight: () => maxInFlight };
}

describe('bulk delete in batches (the node takes at most 200 ids per request)', () => {
    it('mirrors the server cap of 200', () => {
        expect(BULK_DELETE_BATCH_SIZE).toBe(200);
    });

    it.each([
        [0, 0, []],
        [1, 1, [1]],
        [200, 1, [200]],
        [201, 2, [200, 1]],
        [950, 5, [200, 200, 200, 200, 150]],
    ])('%i stale posts: %i request(s), sizes %j, the counts added up', async (n, requests, sizes) => {
        const node = fakeNode();
        const all = ids(n);
        const outcome = await bulkDeleteInBatches(all, node.send);
        expect(node.calls).toHaveLength(requests);
        expect(node.calls.map(b => b.length)).toEqual(sizes);
        expect(node.calls.every(b => b.length <= 200)).toBe(true);
        // Every id sent exactly once, in order.
        expect(node.calls.flat()).toEqual(all);
        expect(outcome).toMatchObject({ total: n, deleted: n, batchesDone: requests });
        expect(outcome.error).toBeUndefined();
        expect(describeBulkDeleteOutcome(outcome)).toBe(`Deleted ${n} post(s).`);
        // One after another, never in parallel.
        expect(node.maxInFlight()).toBeLessThanOrEqual(1);
    });

    it('a failing 3rd batch of 950 stops there, and says how many went before it and why', async () => {
        const node = fakeNode(3, 'Bulk delete limit exceeded (maximum 200 posts per request)');
        const outcome = await bulkDeleteInBatches(ids(950), node.send);
        expect(node.calls).toHaveLength(3);
        expect(outcome).toMatchObject({ total: 950, deleted: 400, batchesDone: 2, error: 'Bulk delete limit exceeded (maximum 200 posts per request)' });
        expect(describeBulkDeleteOutcome(outcome)).toBe('Deleted 400 of 950, then: Bulk delete limit exceeded (maximum 200 posts per request)');
    });

    it('a failing first batch deleted nothing and reads as before: "Failed: <reason>"', async () => {
        const node = fakeNode(1, 'Unauthorized');
        const outcome = await bulkDeleteInBatches(ids(950), node.send);
        expect(node.calls).toHaveLength(1);
        expect(describeBulkDeleteOutcome(outcome)).toBe('Failed: Unauthorized');
    });

    it('a thrown request (network) stops the run like a refusal, with its message', async () => {
        let n = 0;
        const outcome = await bulkDeleteInBatches(ids(450), async (b) => {
            if (++n === 2) throw new Error('Failed to fetch');
            return { ok: true, deleted: b.length };
        });
        expect(n).toBe(2);
        expect(describeBulkDeleteOutcome(outcome)).toBe('Deleted 200 of 450, then: Failed to fetch');
    });

    it("adds up the node's own counts (not the ids sent) and keeps every batch's refund shortfalls", async () => {
        const shortfall = (postId: string) => ({ transactionId: `tx_${postId}`, postId, buyerPubkey: 'b', owed: 10, refunded: 4 });
        const answers: BulkDeleteBatchResult[] = [
            { ok: true, deleted: 198, refundShortfalls: [shortfall('post_3')] },
            { ok: true, deleted: 200 },
            { ok: true, deleted: 49, refundShortfalls: [shortfall('post_420'), shortfall('post_421')] },
        ];
        const outcome = await bulkDeleteInBatches(ids(450), async () => answers.shift()!);
        expect(outcome.deleted).toBe(447);
        expect(outcome.refundShortfalls.map(s => s.postId)).toEqual(['post_3', 'post_420', 'post_421']);
    });

    it('chunkIds never makes an empty batch', () => {
        expect(chunkIds([])).toEqual([]);
        expect(chunkIds(ids(400)).map(b => b.length)).toEqual([200, 200]);
    });
});

describe('sendBulkDeleteBatch reads what the route answers', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('posts the batch and reads deleted and refundShortfalls', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ success: true, deleted: 2, deletedCount: 2, refundShortfalls: [{ transactionId: 't', postId: 'a', buyerPubkey: 'b', owed: null, refunded: 0 }] }),
        });
        vi.stubGlobal('fetch', fetchMock);
        const r = await sendBulkDeleteBatch('https://n/api/local/admin/posts/bulk-delete', { 'X-Admin-Password': 'pw' }, ['a', 'b']);
        expect(r).toEqual({ ok: true, deleted: 2, refundShortfalls: [{ transactionId: 't', postId: 'a', buyerPubkey: 'b', owed: null, refunded: 0 }] });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://n/api/local/admin/posts/bulk-delete');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('same-origin');
        expect(init.headers['X-Admin-Password']).toBe('pw');
        expect(JSON.parse(init.body)).toEqual({ postIds: ['a', 'b'] });
    });

    it('falls back to deletedCount, then to the batch size, as the screen always did', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ deletedCount: 1 }) }));
        expect(await sendBulkDeleteBatch('u', {}, ['a', 'b'])).toEqual({ ok: true, deleted: 1 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
        expect(await sendBulkDeleteBatch('u', {}, ['a', 'b'])).toEqual({ ok: true, deleted: 2 });
    });

    it("a refusal carries the server's reason; a body that is not JSON, its HTTP status", async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'The Commons pot is unknown', code: 'POT_UNKNOWN' }) }));
        expect(await sendBulkDeleteBatch('u', {}, ['a'])).toEqual({ ok: false, error: 'The Commons pot is unknown' });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
        expect(await sendBulkDeleteBatch('u', {}, ['a'])).toEqual({ ok: false, error: 'HTTP 502' });
    });
});
