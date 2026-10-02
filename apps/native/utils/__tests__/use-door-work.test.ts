// @vitest-environment jsdom
/**
 * The door's work as the screens hold it (utils/use-door-work.ts `useDoorWork`), rendered for real with react-dom in
 * jsdom: the hook, the real run (utils/door-work.ts) and the real work route reader, signed by a real key, against a
 * stubbed fetch that counts every request.
 *
 * PR #1452 deciding review, finding 1: after a refusal from the work route, every later Join returned that refusal and
 * sent nothing (measured there: a proxy 502, then 3 Join taps, 0 new requests). The screens call `start` then
 * `solution()` on every Join (app/welcome.tsx and app/join-global.tsx `handleWordsJoin`), and `start` again whenever
 * the door's first screen comes back: each must ask the node again after a refusal, once its Retry-After allows.
 *
 * Finding 2 too: "Choose another way" during the work must not wait for it (`solutionUnlessLeft`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createHash, randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
    digest: vi.fn(async (_algorithm: string, data: Uint8Array) => {
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

import { makeDoorWorkChallenge } from '@beanpool/core';
import { useDoorWork } from '../use-door-work';
import { solutionUnlessLeft, type DoorWorkOutcome } from '../door-work';
import { draftIdentity, type BeanPoolIdentity } from '../identity';

const URL_BASE = 'https://global.test';
const WORK_KEY = new Uint8Array(32).fill(9);

type Reply = { status: number; body: unknown; headers?: Record<string, string> } | 'hang';
let replies: Reply[] = [];
let workAsks = 0;

function challengeFor(key: BeanPoolIdentity, level = 0): Reply {
    return {
        status: 200,
        body: { work: { challenge: makeDoorWorkChallenge({ workKey: WORK_KEY, level, key: key.publicKey, door: 'words', now: Date.now() }), expiresInSeconds: 600 } },
    };
}

beforeEach(() => {
    replies = [];
    workAsks = 0;
    globalThis.fetch = vi.fn(async (url: any) => {
        if (new URL(String(url)).pathname === '/api/join/work') workAsks++;
        const r = replies.length > 1 ? replies.shift()! : replies[0];
        if (r === 'hang') return new Promise<Response>(() => {});
        return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers ?? {} });
    }) as any;
});

/** One Join tap, as the screens' `handleWordsJoin` makes it: start (keeps or renews the run), then its solution. */
async function joinTap(hook: { current: ReturnType<typeof useDoorWork> }, key: BeanPoolIdentity): Promise<DoorWorkOutcome> {
    let outcome: DoorWorkOutcome = { kind: 'cancelled' };
    await act(async () => {
        const run = hook.current.start(URL_BASE, key, 'words');
        outcome = await run.solution();
    });
    return outcome;
}

describe('useDoorWork, rendered: Join after a refusal asks the node again', () => {
    it('a proxy 502 when the door opened, then Join: a new work request, solved (it was 0 new requests in 3 taps)', async () => {
        const key = await draftIdentity();
        replies = [{ status: 502, body: {} }, challengeFor(key)];
        const { result, unmount } = renderHook(() => useDoorWork());
        // The door opens (welcome.tsx's effect at `choose`): the work starts, and the proxy refuses it.
        act(() => { result.current.start(URL_BASE, key, 'words'); });
        await waitFor(() => expect(result.current.state('words')?.phase).toBe('refused'));
        expect(workAsks).toBe(1);

        const outcome = await joinTap(result, key);
        expect(outcome.kind).toBe('solved');
        expect(workAsks).toBe(2);
        expect(result.current.state('words')?.phase).toBe('ready');
        unmount();
    });

    it('three Join taps while a proxy keeps refusing: each asks again until the work comes, then the work in hand is used', async () => {
        const key = await draftIdentity();
        replies = [{ status: 503, body: {} }, { status: 502, body: {} }, challengeFor(key)];
        const { result, unmount } = renderHook(() => useDoorWork());
        act(() => { result.current.start(URL_BASE, key, 'words'); });
        await waitFor(() => expect(result.current.state('words')?.phase).toBe('refused'));
        // Tap 1: asked again, refused again (the proxy still down). Tap 2: asked again, and the work is done.
        expect((await joinTap(result, key)).kind).toBe('refused');
        expect(workAsks).toBe(2);
        expect((await joinTap(result, key)).kind).toBe('solved');
        expect(workAsks).toBe(3);
        // Tap 3 uses the work in hand: no new request.
        expect((await joinTap(result, key)).kind).toBe('solved');
        expect(workAsks).toBe(3);
        unmount();
    });

    it('the door\'s first screen coming back after a refusal (start again) asks again at once', async () => {
        const key = await draftIdentity();
        replies = [{ status: 502, body: {} }, challengeFor(key)];
        const { result, unmount } = renderHook(() => useDoorWork());
        act(() => { result.current.start(URL_BASE, key, 'words'); });
        await waitFor(() => expect(result.current.state('words')?.phase).toBe('refused'));
        act(() => { result.current.start(URL_BASE, key, 'words'); });
        await waitFor(() => expect(result.current.state('words')?.phase).toBe('ready'));
        expect(workAsks).toBe(2);
        unmount();
    });
});

describe('"Choose another way" while the 12-words work finishes (PR #1452 review, finding 2)', () => {
    it('the screen stops waiting at once when the member leaves; the work itself keeps going in the hook', async () => {
        const key = await draftIdentity();
        replies = ['hang'];
        const { result, unmount } = renderHook(() => useDoorWork());
        let run!: ReturnType<ReturnType<typeof useDoorWork>['start']>;
        act(() => { run = result.current.start(URL_BASE, key, 'words'); });
        const leave = new AbortController();
        const waiting = solutionUnlessLeft(run, leave.signal);
        let settled: DoorWorkOutcome | null = null;
        void waiting.then((o) => { settled = o; });
        await new Promise((r) => setTimeout(r, 20));
        expect(settled).toBeNull();
        leave.abort();
        expect(await waiting).toEqual({ kind: 'cancelled' });
        // Not stopped: the run is the hook's, still asking.
        expect(result.current.runFor('words')).toBe(run);
        expect(run.state().phase).toBe('fetching');
        unmount();
    });

    it('already left: settles at once without waiting on anything', async () => {
        const key = await draftIdentity();
        replies = ['hang'];
        const { result, unmount } = renderHook(() => useDoorWork());
        let run!: ReturnType<ReturnType<typeof useDoorWork>['start']>;
        act(() => { run = result.current.start(URL_BASE, key, 'words'); });
        const leave = new AbortController();
        leave.abort();
        expect(await solutionUnlessLeft(run, leave.signal)).toEqual({ kind: 'cancelled' });
        unmount();
    });
});
