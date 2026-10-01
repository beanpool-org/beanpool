/**
 * Door work on the phone (utils/door-work.ts; two-doors design §3): the solver on `expo-crypto`'s `digest` over one
 * reused 64 KB buffer, held to the frozen vectors every node checks against (@beanpool/core/door-work-vectors); short
 * batches that let the screen breathe; a challenge that runs out replaced without the member seeing an error; the
 * phone's own estimate from its first part, and the busy-level sentence from level 3.
 *
 * Nothing here contacts a node: the work route is a stub where one is needed. `expo-crypto` is mocked with Node's
 * native SHA-256, answering with an ArrayBuffer, as expo-crypto 55's `digest` does on a phone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;

const digestCalls = vi.hoisted(() => ({ algorithms: new Set<string>(), buffers: new Set<unknown>(), sizes: new Set<number>(), count: 0 }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
    // expo-crypto 55 `digest(algorithm, data)`: one synchronous native call, answered with a promise of an ArrayBuffer.
    digest: vi.fn(async (algorithm: string, data: Uint8Array) => {
        digestCalls.algorithms.add(algorithm);
        digestCalls.buffers.add(data);
        digestCalls.sizes.add(data.byteLength);
        digestCalls.count++;
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() } }));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined),
}));

import {
    DOOR_WORK_MESSAGE_BYTES,
    checkDoorWorkSolution,
    doorWorkExpectedTries,
    makeDoorWorkChallenge,
    type DoorWorkDigest,
} from '@beanpool/core';
import { DOOR_WORK_VECTORS, DOOR_WORK_VECTOR_KEY } from '@beanpool/core/door-work-vectors';
import {
    BUSY_LEVEL,
    DOOR_WORK_EXPIRY_MARGIN_MS,
    DOOR_WORK_MAX_REFRESHES,
    DOOR_WORK_MESSAGES,
    ESTIMATE_MIN_TRIES,
    aboutHowLong,
    busyLevelSentence,
    fetchDoorWork,
    phoneSha256,
    readIssuedWork,
    solveOnPhone,
    startDoorWork,
    type DoorWorkFetch,
    type DoorWorkState,
    type IssuedDoorWork,
    type PhoneSolve,
} from '../door-work';
import type { BeanPoolIdentity } from '../identity';

const nodeSha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());
const WORK_KEY = new Uint8Array(32).fill(7);
const KEY = 'a'.repeat(64);
const identity = { publicKey: KEY, privateKey: '11'.repeat(32), callsign: '' } as BeanPoolIdentity;

function challengeAt(level: number, now = Date.now()): string {
    return makeDoorWorkChallenge({ workKey: WORK_KEY, level, key: KEY, door: 'words', now });
}

beforeEach(() => {
    digestCalls.algorithms.clear();
    digestCalls.buffers.clear();
    digestCalls.sizes.clear();
    digestCalls.count = 0;
});

describe('the solver on expo-crypto matches the core vectors', () => {
    it.each(DOOR_WORK_VECTORS.map(v => [`level ${v.level} (${v.door})`, v] as const))('%s: the same counters every node checks', async (_name, v) => {
        const solved = await solveOnPhone(v.challenge);
        expect(solved?.counters).toEqual([...v.counters]);
        // Each try is ONE native SHA-256 over the whole message, asked of expo-crypto, over one buffer reused throughout.
        expect([...digestCalls.algorithms]).toEqual(['SHA-256']);
        expect([...digestCalls.sizes]).toEqual([DOOR_WORK_MESSAGE_BYTES]);
        expect(digestCalls.buffers.size).toBe(1);
        expect(solved?.tries).toBe(v.counters.reduce((n, c) => n + c + 1, 0));
        expect(digestCalls.count).toBe(solved?.tries);
        // And the node's own check (core's, with node:crypto) takes it.
        expect(checkDoorWorkSolution(v.challenge, solved?.counters, nodeSha256)).toEqual({ ok: true, hashes: 8 });
        // The first part's winning hash is the vector's, byte for byte.
        expect(v.firstDigestHex.startsWith('0')).toBe(true);
    });

    it('the phone\'s own digest is expo-crypto\'s, read when called (never at import, so a test without it still loads)', async () => {
        const out = await phoneSha256(new Uint8Array(DOOR_WORK_MESSAGE_BYTES));
        expect(new Uint8Array(out as ArrayBuffer)).toEqual(nodeSha256(new Uint8Array(DOOR_WORK_MESSAGE_BYTES)));
        expect(DOOR_WORK_VECTORS.every(v => v.challenge.includes('.'))).toBe(true);
        expect(DOOR_WORK_VECTOR_KEY).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a cancelled solve stops at once and answers null', async () => {
        let asked = 0;
        const solved = await solveOnPhone(DOOR_WORK_VECTORS[2].challenge, { cancelled: () => ++asked > 5 });
        expect(solved).toBeNull();
        expect(digestCalls.count).toBeLessThanOrEqual(5);
    });

    it('a solver that cannot run (no native hash on this phone) throws, and the run says so in a sentence', async () => {
        const broken: DoorWorkDigest = () => { throw new Error('ExpoCrypto.digest is not a function'); };
        const states: DoorWorkState[] = [];
        const run = startDoorWork({
            url: 'https://global.test', identity, door: 'words', digest: broken,
            fetchWork: async () => ({ kind: 'work', work: readIssuedWork({ work: { challenge: challengeAt(0), expiresInSeconds: 600 } }) as any, receivedAt: Date.now() }),
            onChange: s => states.push(s),
        });
        const outcome = await run.solution();
        expect(outcome).toEqual({ kind: 'refused', answer: { kind: 'try_again', message: DOOR_WORK_MESSAGES.solverUnavailable } });
        expect(states.at(-1)?.phase).toBe('failed');
        expect(DOOR_WORK_MESSAGES.solverUnavailable).toMatch(/sign in/);
        run.cancel();
    });
});

describe('short batches: the screen breathes while the work runs', () => {
    /** A digest as slow as an old phone's (about 0.25 ms a try, on top of the real hash). */
    const slowDigest: DoorWorkDigest = (bytes) => {
        const until = performance.now() + 0.25;
        while (performance.now() < until) { /* an old phone's native hash */ }
        return nodeSha256(bytes);
    };

    async function longestHold(sliceMs: number): Promise<{ ticks: number; worstGapMs: number }> {
        let last = performance.now();
        let worst = 0;
        let ticks = 0;
        let solving = true;
        // The screen: wants a turn every millisecond while the solve runs.
        const screen = setInterval(() => {
            if (!solving) return;
            const t = performance.now();
            worst = Math.max(worst, t - last);
            last = t;
            ticks++;
        }, 1);
        const started = performance.now();
        last = started;
        await solveOnPhone(DOOR_WORK_VECTORS[0].challenge, { digest: slowDigest, sliceMs });
        solving = false;
        clearInterval(screen);
        worst = Math.max(worst, performance.now() - last);
        return { ticks, worstGapMs: worst };
    }

    it('with the default batches, the screen gets a turn every few milliseconds', async () => {
        const { ticks, worstGapMs } = await longestHold(8);
        expect(ticks).toBeGreaterThan(5);
        // A batch is 8 ms of tries, plus one try that started inside it and a timer's own lateness on a busy machine.
        expect(worstGapMs).toBeLessThan(60);
    });

    it('control: without the batches (one endless slice), the screen gets no turn until the work is done', async () => {
        const { ticks } = await longestHold(Number.POSITIVE_INFINITY);
        expect(ticks).toBe(0);
    });
});

describe('the estimate: the phone times its own first part', () => {
    it('time per try over the first part, times the tries a whole solve takes at that level', async () => {
        // 1 ms a try on this pretend phone.
        let clock = 0;
        const timed: DoorWorkDigest = (bytes) => { clock += 1; return nodeSha256(bytes); };
        const estimates: number[] = [];
        const v = DOOR_WORK_VECTORS[0];
        await solveOnPhone(v.challenge, { digest: timed, now: () => clock, onEstimate: ms => estimates.push(ms) });
        expect(estimates).toEqual([doorWorkExpectedTries(v.level)]);
        expect(v.counters[0] + 1).toBeGreaterThanOrEqual(ESTIMATE_MIN_TRIES);
    });

    it('a lucky first part (fewer tries than the minimum) waits for the next to time', async () => {
        let clock = 0;
        const timed: DoorWorkDigest = (bytes) => { clock += 2; return nodeSha256(bytes); };
        const parts: number[] = [];
        let estimatedAtPart = -1;
        // Level 3's first part takes 28 tries, under the minimum; its second takes 759.
        const v = DOOR_WORK_VECTORS[2];
        expect(v.counters[0] + 1).toBeLessThan(ESTIMATE_MIN_TRIES);
        await solveOnPhone(v.challenge, {
            digest: timed, now: () => clock,
            onPart: (done) => parts.push(done),
            onEstimate: (ms) => { estimatedAtPart = parts.length + 1; expect(ms).toBe(2 * doorWorkExpectedTries(3)); },
        });
        expect(estimatedAtPart).toBe(2);
    });

    it('from level 3, the busy sentence with this phone\'s estimate and the sign-in door beside it; never below', () => {
        const at = (level: number, estimateMs: number | null, phase: DoorWorkState['phase'] = 'solving') => busyLevelSentence({ level, estimateMs, startedAt: 0, phase }, 0);
        expect(BUSY_LEVEL).toBe(3);
        expect(at(2, 30_000)).toBeNull();
        expect(at(3, null)).toBeNull();
        expect(at(3, 15_000)).toBe('Lots of people are joining right now. Setting up a 12-words account will take about 15 seconds on this phone. Or sign in to join now.');
        expect(at(5, 70_000)).toMatch(/about a minute on this phone\. Or sign in to join now\.$/);
        // Done: nobody waits, so nothing to say.
        expect(at(4, 15_000, 'ready')).toBeNull();
        // Counting down from when the solve started.
        expect(busyLevelSentence({ level: 3, estimateMs: 20_000, startedAt: 0, phase: 'solving' }, 10_000)).toMatch(/about 10 seconds/);
    });

    it('"about N" is never more precise than an estimate', () => {
        expect(aboutHowLong(700)).toBe('about a second');
        expect(aboutHowLong(4_200)).toBe('about 5 seconds');
        expect(aboutHowLong(17_000)).toBe('about 15 seconds');
        expect(aboutHowLong(56_000)).toBe('about a minute');
        expect(aboutHowLong(150_000)).toBe('about 3 minutes');
    });
});

describe('a run started when the door opens: ready by Join, and a challenge that runs out is replaced quietly', () => {
    /** The work route: each call a new challenge at `level`, good for `seconds` from when the phone heard it. */
    function workRoute(level = 0, seconds = 600) {
        const issued: string[] = [];
        let clock = 1_000_000;
        const fetchWork = vi.fn(async (): Promise<DoorWorkFetch> => {
            const challenge = challengeAt(level, Date.now() + issued.length);
            issued.push(challenge);
            return { kind: 'work', work: readIssuedWork({ work: { challenge, level, expiresInSeconds: seconds } }) as IssuedDoorWork, receivedAt: clock };
        });
        const solve = vi.fn(async (challenge: string, o: any): Promise<PhoneSolve | null> => {
            o.onPart?.(8, 8);
            return { counters: [challenge.length, 0, 0, 0, 0, 0, 0, 0], tries: 8, ms: 1 };
        });
        return { issued, fetchWork, solve, advance: (ms: number) => { clock += ms; }, now: () => clock };
    }

    it('fetches and solves at once, so the work is ready before anyone taps Join', async () => {
        const r = workRoute();
        const states: string[] = [];
        const run = startDoorWork({ url: 'https://global.test', identity, door: 'words', fetchWork: r.fetchWork, solve: r.solve, now: r.now, setTimer: () => 1, clearTimer: () => {}, onChange: s => { if (states.at(-1) !== s.phase) states.push(s.phase); } });
        expect(r.fetchWork).toHaveBeenCalledTimes(1);
        const outcome = await run.solution();
        expect(outcome).toMatchObject({ kind: 'solved', work: { challenge: r.issued[0] } });
        expect(states).toEqual(['fetching', 'solving', 'ready']);
        expect(r.fetchWork).toHaveBeenCalledTimes(1);
        run.cancel();
    });

    it('Join after the challenge ran out (or is about to): a new one is fetched and solved; no error is shown', async () => {
        const r = workRoute();
        const run = startDoorWork({ url: 'https://global.test', identity, door: 'words', fetchWork: r.fetchWork, solve: r.solve, now: r.now, setTimer: () => 1, clearTimer: () => {} });
        await run.solution();
        // Nine and a half minutes thinking about a name: under a minute left, so it isn't used.
        r.advance(600_000 - DOOR_WORK_EXPIRY_MARGIN_MS + 1);
        const outcome = await run.solution();
        expect(r.fetchWork).toHaveBeenCalledTimes(2);
        expect(outcome).toMatchObject({ kind: 'solved', work: { challenge: r.issued[1] } });
        expect(run.state().phase).toBe('ready');
        run.cancel();
    });

    it('while nobody taps Join, a challenge about to run out is replaced by itself, up to an hour\'s worth', async () => {
        const r = workRoute();
        const timers: { fn: () => void; ms: number }[] = [];
        const run = startDoorWork({
            url: 'https://global.test', identity, door: 'words', fetchWork: r.fetchWork, solve: r.solve, now: r.now,
            setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
        });
        await run.solution();
        expect(timers[0].ms).toBe(600_000 - DOOR_WORK_EXPIRY_MARGIN_MS);
        for (let i = 0; i < DOOR_WORK_MAX_REFRESHES + 2; i++) {
            const t = timers[timers.length - 1];
            if (!t) break;
            timers.pop();
            r.advance(t.ms);
            t.fn();
            await run.solution();
        }
        expect(r.fetchWork).toHaveBeenCalledTimes(1 + DOOR_WORK_MAX_REFRESHES);
        run.cancel();
    });

    it('the node refused the work it was sent (work_*): again() fetches a new challenge and solves it', async () => {
        const r = workRoute();
        const run = startDoorWork({ url: 'https://global.test', identity, door: 'words', fetchWork: r.fetchWork, solve: r.solve, now: r.now, setTimer: () => 1, clearTimer: () => {} });
        const first = await run.solution();
        const second = await run.again();
        expect(first).toMatchObject({ work: { challenge: r.issued[0] } });
        expect(second).toMatchObject({ kind: 'solved', work: { challenge: r.issued[1] } });
        run.cancel();
    });

    it('no answer at the door opening: asked again when the member taps Join; a refusal the door made stands', async () => {
        const fetchWork = vi.fn()
            .mockResolvedValueOnce({ kind: 'refused', answer: { kind: 'unreachable', message: 'x' } })
            .mockResolvedValueOnce({ kind: 'work', work: readIssuedWork({ work: { challenge: challengeAt(1), expiresInSeconds: 600 } }), receivedAt: Date.now() });
        const solve = vi.fn(async () => ({ counters: [1, 2, 3, 4, 5, 6, 7, 8], tries: 8, ms: 1 }));
        const run = startDoorWork({ url: 'https://global.test', identity, door: 'words', fetchWork, solve, setTimer: () => 1, clearTimer: () => {} });
        expect(await run.solution()).toMatchObject({ kind: 'solved' });
        expect(fetchWork).toHaveBeenCalledTimes(2);

        const busy = { kind: 'rate_limited', message: 'busy', retryAfterSeconds: 60 };
        const shut = startDoorWork({ url: 'https://global.test', identity, door: 'words', fetchWork: vi.fn(async () => ({ kind: 'refused', answer: busy }) as DoorWorkFetch), solve, setTimer: () => 1, clearTimer: () => {} });
        expect(await shut.solution()).toEqual({ kind: 'refused', answer: busy });
    });

    it('cancelled (the door was left): nothing more is fetched or hashed', async () => {
        const r = workRoute();
        const run = startDoorWork({ url: 'https://global.test', identity, door: 'words', fetchWork: r.fetchWork, solve: r.solve, now: r.now, setTimer: () => 1, clearTimer: () => {} });
        run.cancel();
        expect(await run.solution()).toEqual({ kind: 'cancelled' });
        expect(await run.again()).toEqual({ kind: 'cancelled' });
        expect(r.fetchWork).toHaveBeenCalledTimes(1);
    });
});

describe('the work route', () => {
    it('reads a challenge, none (the sign-in door at ordinary rates), or nothing it can use', () => {
        const c = challengeAt(2);
        expect(readIssuedWork({ work: { challenge: c, level: 0, expiresInSeconds: 600 } })).toMatchObject({ challenge: c, level: 2, parts: 8 });
        expect(readIssuedWork({ work: null, turnstile: null })).toBe('none');
        expect(readIssuedWork({ work: { challenge: 'v2.nope' } })).toBeNull();
        expect(readIssuedWork(null)).toBeNull();
    });

    it('asks signed by the joining key, and says every refusal as the door\'s answer', async () => {
        const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
        globalThis.fetch = vi.fn(async (url: any, init: any) => {
            seen.push({ url: String(url), headers: init.headers, body: init.body });
            return new Response(JSON.stringify({ error: 'x', code: 'network_busy', door: 'words', window: 'hour', retryAfterSeconds: 600 }), { status: 429, headers: { 'Retry-After': '600' } });
        }) as any;
        const { draftIdentity } = await import('../identity');
        const joiner = await draftIdentity();
        const answer = await fetchDoorWork('https://global.test', joiner, 'words');
        expect(seen[0].url).toBe('https://global.test/api/join/work');
        expect(JSON.parse(seen[0].body)).toEqual({ door: 'words' });
        expect(seen[0].headers['X-Public-Key']).toBe(joiner.publicKey);
        expect(answer).toMatchObject({ kind: 'refused', answer: { kind: 'rate_limited', door: 'words' } });
        if (answer.kind === 'refused') expect((answer.answer as any).message).toMatch(/Sign in to join now, or try again in 10 minutes\.$/);

        globalThis.fetch = vi.fn(async () => { throw new TypeError('Network request failed'); }) as any;
        expect(await fetchDoorWork('https://global.test', joiner, 'words')).toMatchObject({ kind: 'refused', answer: { kind: 'unreachable' } });
    });
});
