/**
 * The web app's door work (two-doors design §3.4, slice S5): the solve the Web Worker runs is held to core's frozen
 * vectors (`@beanpool/core/door-work-vectors`), with the browser's own SHA-256 (WebCrypto) doing the hashing; the worker
 * answers its page in the protocol solveInWorker reads; a browser with no worker solves on the page; and the busy-level
 * sentence carries this browser's own estimate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    checkDoorWorkChallenge,
    checkDoorWorkSolution,
    makeDoorWorkChallenge,
    solveDoorWorkSync,
    DOOR_WORK_PARTS,
} from '@beanpool/core/door-work';
import {
    DOOR_WORK_VECTORS,
    DOOR_WORK_VECTOR_KEY,
    DOOR_WORK_VECTOR_NOW,
    DOOR_WORK_VECTOR_RANDOM_HEX,
    DOOR_WORK_VECTOR_WORK_KEY_HEX,
} from '@beanpool/core/door-work-vectors';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
    aboutTime,
    busySentence,
    secondsLeft,
    solveHere,
    solveInWorker,
    solveWithWebCrypto,
    type DoorWorkProgress,
} from './door-work';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('the solve, against the frozen vectors', () => {
    it('every vector: the challenge is the one core makes from its inputs, and WebCrypto finds exactly its counters', async () => {
        for (const v of DOOR_WORK_VECTORS) {
            const made = makeDoorWorkChallenge({
                workKey: hexToBytes(DOOR_WORK_VECTOR_WORK_KEY_HEX), level: v.level, key: DOOR_WORK_VECTOR_KEY, door: v.door,
                now: DOOR_WORK_VECTOR_NOW, random: hexToBytes(DOOR_WORK_VECTOR_RANDOM_HEX),
            });
            expect(made).toBe(v.challenge);
            const parts: number[] = [];
            const counters = await solveWithWebCrypto(v.challenge, { onProgress: (p) => parts.push(p.done) });
            expect(counters).toEqual([...v.counters]);
            // A part's progress is said as each part is done: 1 to 8, in order.
            expect([...new Set(parts.filter((d) => d > 0))]).toEqual(Array.from({ length: DOOR_WORK_PARTS }, (_, i) => i + 1));
            // And the node's own check takes it, as the node would (its mac, its key, its door, in time).
            const check = checkDoorWorkChallenge(v.challenge, {
                workKey: hexToBytes(DOOR_WORK_VECTOR_WORK_KEY_HEX), key: DOOR_WORK_VECTOR_KEY, door: v.door, now: DOOR_WORK_VECTOR_NOW,
            });
            expect(check.ok).toBe(true);
            expect(checkDoorWorkSolution(v.challenge, counters)).toEqual({ ok: true, hashes: DOOR_WORK_PARTS });
        }
    });

    it('the solve calls WebCrypto once a try, over 64 KB plus the challenge hash, part and counter', async () => {
        const v = DOOR_WORK_VECTORS[0];
        const sizes = new Set<number>();
        let calls = 0;
        const subtle = {
            digest: (alg: string, data: Uint8Array) => {
                calls++;
                sizes.add(data.byteLength);
                expect(alg).toBe('SHA-256');
                return globalThis.crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
            },
        } as unknown as SubtleCrypto;
        const counters = await solveWithWebCrypto(v.challenge, { subtle });
        expect(counters).toEqual([...v.counters]);
        expect(calls).toBe(v.counters.reduce((sum, c) => sum + c + 1, 0));
        expect([...sizes]).toEqual([32 + 1 + 8 + 65_536]);
    });

    it('the page fallback (no worker) gives the same counters, and stops when cancelled', async () => {
        const v = DOOR_WORK_VECTORS[1];
        expect(await solveHere(v.challenge).done).toEqual([...v.counters]);
        const run = solveHere(DOOR_WORK_VECTORS[2].challenge);
        run.cancel();
        expect(await run.done).toBeNull();
    });

    it('a level-0 challenge from a node with a random work key is solved, and its solution checks', async () => {
        const workKey = crypto.getRandomValues(new Uint8Array(32));
        const key = 'ab'.repeat(32);
        const challenge = makeDoorWorkChallenge({ workKey, level: 0, key, door: 'words' });
        const counters = await solveWithWebCrypto(challenge);
        expect(counters).toEqual(solveDoorWorkSync(challenge));
        expect(checkDoorWorkSolution(challenge, counters).ok).toBe(true);
    });
});

describe('the Web Worker', () => {
    /** The worker module run as a worker would be: `self` is its scope, its posts are collected. */
    async function loadWorker() {
        const posted: unknown[] = [];
        const scope: { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void } = {
            onmessage: null,
            postMessage: (m) => posted.push(m),
        };
        vi.stubGlobal('self', scope);
        await import('./door-work.worker');
        return { scope, posted };
    }

    it('answers a challenge with progress, then the vector counters', async () => {
        const { scope, posted } = await loadWorker();
        const v = DOOR_WORK_VECTORS[0];
        scope.onmessage?.({ data: { challenge: v.challenge } } as MessageEvent);
        await vi.waitFor(() => expect(posted.some((m) => (m as { type: string }).type === 'done')).toBe(true), { timeout: 10_000 });
        const done = posted.find((m) => (m as { type: string }).type === 'done') as { counters: number[] };
        expect(done.counters).toEqual([...v.counters]);
        const progress = posted.filter((m) => (m as { type: string }).type === 'progress') as { progress: DoorWorkProgress }[];
        expect(progress.at(-1)?.progress).toMatchObject({ done: DOOR_WORK_PARTS, of: DOOR_WORK_PARTS });
    });

    it('anything but a challenge is an error, not a solve', async () => {
        const { scope, posted } = await loadWorker();
        scope.onmessage?.({ data: { challenge: 42 } } as MessageEvent);
        expect(posted).toEqual([{ type: 'error', message: 'no challenge' }]);
    });

    it("solveInWorker: the worker's answers reach the page; a worker that fails to load is replaced by the page's own solve", async () => {
        const v = DOOR_WORK_VECTORS[0];
        // A worker that answers as door-work.worker.ts does.
        class AnsweringWorker {
            onmessage: ((e: MessageEvent) => void) | null = null;
            onerror: ((e: ErrorEvent) => void) | null = null;
            terminated = false;
            static last: AnsweringWorker | null = null;
            constructor(public url: URL, public options: WorkerOptions) { AnsweringWorker.last = this; }
            postMessage(m: { challenge: string }) {
                setTimeout(() => {
                    this.onmessage?.({ data: { type: 'progress', progress: { done: 1, of: 8, tries: 40, rate: 400 } } } as MessageEvent);
                    this.onmessage?.({ data: { type: 'done', counters: m.challenge === v.challenge ? [...v.counters] : [] } } as MessageEvent);
                }, 0);
            }
            terminate() { this.terminated = true; }
        }
        vi.stubGlobal('Worker', AnsweringWorker);
        const seen: DoorWorkProgress[] = [];
        const run = solveInWorker(v.challenge, { onProgress: (p) => seen.push(p) });
        expect(await run.done).toEqual([...v.counters]);
        expect(seen).toEqual([{ done: 1, of: 8, tries: 40, rate: 400 }]);
        expect(AnsweringWorker.last?.url.pathname).toMatch(/door-work\.worker/);
        expect(AnsweringWorker.last?.options).toEqual({ type: 'module' });
        expect(AnsweringWorker.last?.terminated).toBe(true);

        // A worker the browser refuses (a policy, an old browser): its error, then the page solves.
        class FailingWorker {
            onmessage: ((e: MessageEvent) => void) | null = null;
            onerror: ((e: Partial<ErrorEvent>) => void) | null = null;
            postMessage() { setTimeout(() => this.onerror?.({ message: 'refused', preventDefault: () => {} }), 0); }
            terminate() {}
        }
        vi.stubGlobal('Worker', FailingWorker);
        expect(await solveInWorker(v.challenge).done).toEqual([...v.counters]);

        // No Worker at all: the page solves.
        vi.stubGlobal('Worker', undefined);
        expect(await solveInWorker(v.challenge).done).toEqual([...v.counters]);
    });
});

describe('the busy level, said with this browser\'s own estimate (design §3.5)', () => {
    it('the estimate is the work left at the measured speed', () => {
        // Level 3: 8 parts x 2^10 tries = 8,192 on average.
        expect(secondsLeft(3, { done: 1, of: 8, tries: 1_000, rate: 500 })).toBe(14);
        expect(secondsLeft(3, { done: 0, of: 8, tries: 10, rate: null })).toBeNull();
        expect(secondsLeft(3, null)).toBeNull();
        // Never "0 seconds": the last of it still takes a moment.
        expect(secondsLeft(0, { done: 7, of: 8, tries: 5_000, rate: 500 })).toBe(1);
    });

    it('said as a person would: seconds, rounded past ten, then minutes', () => {
        expect(aboutTime(1)).toBe('about a second');
        expect(aboutTime(7)).toBe('about 7 seconds');
        expect(aboutTime(14)).toBe('about 15 seconds');
        expect(aboutTime(59)).toBe('about 60 seconds');
        expect(aboutTime(70)).toBe('about a minute');
        expect(aboutTime(200)).toBe('about 3 minutes');
    });

    it('the sentence: never a refusal, and the sign-in beside it', () => {
        expect(busySentence(14)).toBe('Lots of people are joining right now. Setting up a 12-words account will take about 15 seconds in this browser. Or sign in to join now.');
        expect(busySentence(null)).toMatch(/^Lots of people are joining right now.*Or sign in to join now\.$/);
    });
});
