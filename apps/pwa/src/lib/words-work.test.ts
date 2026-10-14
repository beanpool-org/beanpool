/**
 * The 12-words door's work kept ready for one joining key (lib/words-work.ts; two-doors design §3.4): asked for and
 * solved before the join, so nobody waits at ordinary levels; replaced quietly before it runs out; used once; and every
 * way it can't be done here (a network's ceiling, the door shut, no answer, a browser that can't) ends in a sentence,
 * never a gate. The node and the solver are stubs; the clock is this test's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateIdentity, type BeanPoolIdentity } from './identity';
import { DoorUnreachableError, type DoorWorkAnswer } from './web-join';
import { WordsWork, RENEW_MARGIN_MS, SEND_MARGIN_MS, type WordsWorkState } from './words-work';
import type { DoorWorkRun, DoorWorkSolver } from './door-work';

let identity: BeanPoolIdentity;
let now: number;
beforeEach(async () => {
    identity = await generateIdentity('');
    now = 1_000_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
    vi.useRealTimers();
});

/** The node: a challenge per ask, `life` seconds long, at `level`; or the answer a test gives instead. */
function node(o: { life?: number; level?: number; answers?: Array<DoorWorkAnswer | Error> } = {}) {
    const asked: string[] = [];
    let n = 0;
    const request = vi.fn(async (_id: BeanPoolIdentity, door: 'words' | 'sign-in', clock: () => number = Date.now): Promise<DoorWorkAnswer> => {
        asked.push(door);
        const scripted = o.answers?.shift();
        if (scripted instanceof Error) throw scripted;
        if (scripted) return scripted;
        n++;
        return { kind: 'work', work: { challenge: `challenge-${n}`, level: o.level ?? 0, parts: 8, bits: 7, expiresAt: clock() + (o.life ?? 600) * 1000 } };
    });
    return { request, asked };
}

/** A solver the test finishes by hand: `finish()` answers the oldest run still going. */
function handSolver() {
    const runs: Array<{ challenge: string; resolve: (c: number[] | null) => void; cancelled: boolean; finished: boolean; progress?: (p: any) => void }> = [];
    const solver: DoorWorkSolver = (challenge, callbacks): DoorWorkRun => {
        let resolve: (c: number[] | null) => void = () => {};
        const done = new Promise<number[] | null>((r) => { resolve = r; });
        const run = { challenge, resolve, cancelled: false, finished: false, progress: callbacks?.onProgress };
        runs.push(run);
        return { done, cancel: () => { run.cancelled = true; resolve(null); } };
    };
    const finish = async () => {
        const i = runs.findIndex((r) => !r.cancelled && !r.finished);
        runs[i].finished = true;
        runs[i].resolve([i, 1, 2, 3, 4, 5, 6, 7]);
        await vi.advanceTimersByTimeAsync(0);
    };
    return { solver, runs, finish };
}

function keeper(o: { life?: number; level?: number; answers?: Array<DoorWorkAnswer | Error> } = {}) {
    const n = node(o);
    const s = handSolver();
    const states: WordsWorkState[] = [];
    const k = new WordsWork(identity, { solver: s.solver, request: n.request, now: () => now, onChange: (st) => states.push(st) });
    return { k, n, s, states };
}

describe('made before the join', () => {
    it('start: asks for words work, solves it, and has it ready; take hands it over once', async () => {
        const { k, n, s, states } = keeper();
        k.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(n.asked).toEqual(['words']);
        expect(states.map((x) => x.status)).toEqual(['asking', 'solving']);
        await s.finish();
        expect(k.current).toEqual({ status: 'ready', level: 0 });
        // Started again while ready: nothing more is asked.
        k.start();
        expect(n.request).toHaveBeenCalledTimes(1);
        expect(await k.take()).toEqual({ ok: true, work: { challenge: 'challenge-1', counters: [0, 1, 2, 3, 4, 5, 6, 7] } });
        expect(k.current.status).toBe('idle');
        // Used once: the next join gets new work.
        const next = k.take();
        await vi.advanceTimersByTimeAsync(0);
        await s.finish();
        expect((await next).ok && (await next as any).work.challenge).toBe('challenge-2');
    });

    it('a join before the work is done waits for it', async () => {
        const { k, s } = keeper();
        k.start();
        await vi.advanceTimersByTimeAsync(0);
        const taking = k.take();
        let taken = false;
        void taking.then(() => { taken = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(taken).toBe(false);
        await s.finish();
        expect(await taking).toMatchObject({ ok: true, work: { challenge: 'challenge-1' } });
    });

    it('a join that stops waiting (← Choose another way) takes nothing: the work carries on, ready for the next take', async () => {
        const { k, n, s } = keeper();
        k.start();
        await vi.advanceTimersByTimeAsync(0);
        const wait = new AbortController();
        const taking = k.take(wait.signal);
        await vi.advanceTimersByTimeAsync(0);
        wait.abort();
        expect(await taking).toBeNull();
        expect(s.runs[0].cancelled).toBe(false);
        await s.finish();
        expect(k.current).toEqual({ status: 'ready', level: 0 });
        expect(await k.take()).toMatchObject({ ok: true, work: { challenge: 'challenge-1' } });
        expect(n.request).toHaveBeenCalledTimes(1);
    });

    it('progress from the solver is passed on, with the level', async () => {
        const { k, s, states } = keeper({ level: 3 });
        k.start();
        await vi.advanceTimersByTimeAsync(0);
        s.runs[0].progress?.({ done: 2, of: 8, tries: 2000, rate: 800 });
        expect(states.at(-1)).toEqual({ status: 'solving', level: 3, progress: { done: 2, of: 8, tries: 2000, rate: 800 } });
    });
});

describe('a challenge runs out (ten minutes): replaced quietly', () => {
    it('one left unused is replaced before it runs out, and the join gets the new one', async () => {
        const { k, n, s } = keeper();
        k.start();
        await vi.advanceTimersByTimeAsync(0);
        await s.finish();
        // Nine minutes on, the timer has asked for another; the old one is not sent.
        now += 600_000 - RENEW_MARGIN_MS;
        await vi.advanceTimersByTimeAsync(600_000 - RENEW_MARGIN_MS);
        expect(n.asked).toHaveLength(2);
        await s.finish();
        expect(await k.take()).toMatchObject({ ok: true, work: { challenge: 'challenge-2' } });
    });

    it('one too close to its end to reach the node in time is made again at the join, without a word', async () => {
        const { k, n, s, states } = keeper({ life: 120 });
        k.start();
        await vi.advanceTimersByTimeAsync(0);
        await s.finish();
        now += 120_000 - SEND_MARGIN_MS + 1;
        const taking = k.take();
        await vi.advanceTimersByTimeAsync(0);
        await s.finish();
        expect(await taking).toMatchObject({ ok: true, work: { challenge: 'challenge-2' } });
        expect(n.asked).toHaveLength(2);
        expect(states.some((x) => x.status === 'failed' || x.status === 'busy')).toBe(false);
    });

    it('a node whose challenges are shorter-lived than the margin still gets its join: the one just made is taken', async () => {
        const { k, s } = keeper({ life: 30 });
        const taking = k.take();
        await vi.advanceTimersByTimeAsync(0);
        await s.finish();
        expect(await taking).toMatchObject({ ok: true, work: { challenge: 'challenge-1' } });
    });
});

describe('never a gate: each way it cannot be done is a sentence, and the sign-in is beside it', () => {
    const WORDS_CEILING = 'A very large number of 12-words accounts were made from your network in the last hour. Sign in to join now, or try again in about 12 minutes.';

    it("a network's ceiling: busy, in the node's words", async () => {
        const { k } = keeper({ answers: [{ kind: 'refused', answer: { status: 429, body: { error: WORDS_CEILING, code: 'network_busy' }, retryAfterSeconds: 720 } }] });
        expect(await k.take()).toEqual({ ok: false, state: { status: 'busy', message: WORDS_CEILING } });
    });

    it('the 12-words door shut here (sign_in_required), or a node that asks no work of it: closed', async () => {
        let { k } = keeper({ answers: [{ kind: 'refused', answer: { status: 403, body: { error: 'This community needs a sign-in to join: Google, Apple or Facebook.', code: 'sign_in_required' } } }] });
        expect(await k.take()).toMatchObject({ ok: false, state: { status: 'closed' } });
        ({ k } = keeper({ answers: [{ kind: 'none' }] }));
        expect(await k.take()).toMatchObject({ ok: false, state: { status: 'closed', message: expect.stringMatching(/Sign in to join/) } });
    });

    it('no answer, or a browser that cannot do the work: failed, and asking again tries again', async () => {
        const { k, s } = keeper({ answers: [new DoorUnreachableError(new Error('offline'))] });
        expect(await k.take()).toEqual({ ok: false, state: { status: 'failed', message: "Can't reach the community right now. Try again in a minute, or sign in." } });
        const again = k.take();
        await vi.advanceTimersByTimeAsync(0);
        await s.finish();
        expect(await again).toMatchObject({ ok: true });

        const broken = new WordsWork(identity, {
            request: node().request, now: () => now,
            solver: () => ({ done: Promise.reject(new Error('no WebCrypto')), cancel: () => {} }),
        });
        expect(await broken.take()).toEqual({ ok: false, state: { status: 'failed', message: "This browser can't finish setting up a 12-words account right now. Try again, or sign in." } });
    });

    it('let go (the key changed, the page left): the solve is cancelled and nothing more is asked', async () => {
        const { k, n, s } = keeper();
        k.start();
        await vi.advanceTimersByTimeAsync(0);
        k.dispose();
        expect(s.runs[0].cancelled).toBe(true);
        k.start();
        expect(n.request).toHaveBeenCalledTimes(1);
        expect((await k.take()).ok).toBe(false);
    });
});
