/**
 * The node's data read ends rather than hang (review r4309394025): a request that never settled left Settings' Home on
 * "Loading…" with no Retry for as long as the browser kept the socket open.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchNodeData, NODE_DATA_ANSWER_MS, NODE_DATA_ALL_MS } from './node-client';

const NODE = 'https://node.example';

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('fetchNodeData has time limits', () => {
    it('a node that never answers: fails after 30 seconds, in words, and the request is stopped', async () => {
        let signal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
            signal = init?.signal ?? undefined;
            return new Promise(() => { /* never answers, and ignores the abort */ });
        }));
        const read = fetchNodeData(NODE);
        const outcome = read.then(() => 'loaded', (e: Error) => e.message);
        await vi.advanceTimersByTimeAsync(NODE_DATA_ANSWER_MS - 1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toBe("The node didn't answer within 30 seconds");
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an answer whose data never all arrives: fails 5 minutes after the request, not 5 minutes after the answer', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, status: 200, statusText: 'OK', json: () => new Promise(() => { /* stalls */ }) }), 10_000);
        })));
        const outcome = fetchNodeData(NODE).then(() => 'loaded', (e: Error) => e.message);
        await vi.advanceTimersByTimeAsync(NODE_DATA_ALL_MS - 1);
        let settled = false;
        void outcome.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toBe("The node's data didn't all arrive within 5 minutes");
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a slow but steady read inside the limits loads, and leaves no timer behind', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
            setTimeout(() => resolve({
                ok: true, status: 200, statusText: 'OK',
                json: () => new Promise((done) => setTimeout(() => done({ members: [{ publicKey: 'ab'.repeat(32) }] }), 4 * 60_000)),
            }), NODE_DATA_ANSWER_MS - 1_000);
        })));
        const read = fetchNodeData(NODE);
        await vi.advanceTimersByTimeAsync(NODE_DATA_ANSWER_MS - 1_000 + 4 * 60_000);
        const data = await read;
        expect(data.members).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a refusal is still the node\'s status, not a time-out', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error', json: () => Promise.resolve({}) })));
        await expect(fetchNodeData(NODE)).rejects.toThrow('HTTP 500: Internal Server Error');
        expect(vi.getTimerCount()).toBe(0);
    });
});
