/**
 * lib/member-area's time limits (deciding review of #1766, B2): a save the node never answers ends in the step's one
 * line, with its request stopped, after AREA_REQUEST_TIMEOUT_MS or as soon as the step stops it (Skip, Back).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AREA_REQUEST_TIMEOUT_MS, writeArea, type AreaSender } from './member-area';

const NO_REACH = "Couldn't reach the community. Check your connection and try again.";

function neverAnswers() {
    const signals: Array<AbortSignal | undefined> = [];
    const send: AreaSender = (_body, signal) => { signals.push(signal); return new Promise(() => {}); };
    return { send, signals };
}

afterEach(() => vi.useRealTimers());

describe('writeArea: a save that never answers', () => {
    it('ends after AREA_REQUEST_TIMEOUT_MS (30 s) in the one line, and its request is stopped', async () => {
        expect(AREA_REQUEST_TIMEOUT_MS).toBe(30_000);
        vi.useFakeTimers();
        const node = neverAnswers();
        let result: unknown;
        void writeArea(node.send, { lat: -28.647412, lng: 153.612031 }).then((r) => { result = r; });
        await vi.advanceTimersByTimeAsync(29_000);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(result).toEqual({ ok: false, error: NO_REACH });
        expect(node.signals[0]?.aborted).toBe(true);
    });

    it("ends at once when the step stops it, and a stopped step's save is never sent", async () => {
        const node = neverAnswers();
        const stop = new AbortController();
        const pending = writeArea(node.send, { lat: 1, lng: 2 }, { signal: stop.signal });
        stop.abort();
        expect(await pending).toEqual({ ok: false, error: NO_REACH });
        expect(node.signals[0]?.aborted).toBe(true);

        const already = new AbortController();
        already.abort();
        const quiet = neverAnswers();
        expect(await writeArea(quiet.send, { lat: 1, lng: 2 }, { signal: already.signal })).toEqual({ ok: false, error: NO_REACH });
        expect(quiet.signals).toEqual([]);
    });

    it('returns the node sentence on private_preview standing refusal, not NO_REACH', async () => {
        const previewRefusal = Object.assign(new Error('This community is in a private preview. Ask its owner for an invite.'), {
            status: 403,
            code: 'private_preview',
        });
        const send: AreaSender = () => Promise.reject(previewRefusal);
        const result = await writeArea(send, { lat: 1, lng: 2 });
        expect(result).toEqual({ ok: false, error: 'This community is in a private preview. Ask its owner for an invite.' });
    });

    it('returns the closed sentence on account_closed standing refusal, not NO_REACH', async () => {
        const closedRefusal = Object.assign(new Error('Closed'), {
            status: 403,
            code: 'account_closed',
        });
        const send: AreaSender = () => Promise.reject(closedRefusal);
        const result = await writeArea(send, { lat: 1, lng: 2 });
        expect(result).toEqual({ ok: false, error: 'Your account in this community was closed.' });
    });
});
