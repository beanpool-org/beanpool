/**
 * One round of mail from other communities at a time, and never one without an end (utils/outside-chat-live.ts; PR #3168
 * review: "a round has no deadline, and one stuck round stops every later one until the app restarts").
 *
 *   1  a round that stalls (a request that never answers) ends at its deadline: its signal aborts, `running` is released,
 *      and the next caller (the chat's poll, the Chat tab, the background task) starts a new round that finishes
 *   2  a caller with a shorter budget (the background task) waits no longer than its own budget for a round already running,
 *      and starts no second one beside it
 *   3  the background step's budget fits what is left of iOS's ~30 s after the sync and its notices, or is skipped
 *   4  the community reads its switch off: no round asks, and my lines still `sending` fail with the words why
 *
 * The round itself (utils/outside-mail.ts) is played here; its own test (outside-mail.test.ts) shows every request it makes
 * carries the signal it is given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({
    rounds: [] as Array<{ signal: AbortSignal | undefined; finish: (v: unknown) => void }>,
    profile: { features: { outsideMessages: true } } as null | { features: Record<string, unknown> },
    failed: [] as string[],
    emitted: [] as string[],
}));

vi.mock('react-native', () => ({ DeviceEventEmitter: { emit: (e: string) => { live.emitted.push(e); } } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async (k: string) => (k === 'beanpool_anchor_url' ? 'https://riverside.example' : null) } }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), callsign: 'Ben' }) }));
vi.mock('../blocklist', () => ({ isUserBlocked: async () => false }));
vi.mock('../db', () => ({ outsideStore: () => ({}) }));
vi.mock('../node-profile', () => ({
    getCachedNodeProfile: async () => live.profile,
    fetchNodeProfile: async () => null,
    outsideMessagesOn: (f: Record<string, unknown> | undefined) => f?.outsideMessages === true,
}));
vi.mock('../outside-mail', () => ({
    OutsideMailError: class extends Error {},
    // A round that answers only when the test says, or throws when its signal aborts (as a fetch given that signal does).
    syncOutsideMail: (ctx: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
        live.rounds.push({ signal: ctx.signal, finish: resolve });
        ctx.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    }),
    failUnsent: async (_ctx: unknown, words: string) => { live.failed.push(words); return 2; },
}));

import {
    OUTSIDE_BACKGROUND_MS, OUTSIDE_ROUND_MS, OUTSIDE_CHATS_UPDATED, backgroundMailBudget, syncOutsideMailNow,
} from '../outside-chat-live';

const DONE = { written: 1, requests: 0, dropped: 0, confirmed: 1, ticks: 0 };
/** Lets the round's awaits (the context, the store's import, the profile) run: setImmediate is not faked. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    live.rounds = [];
    live.profile = { features: { outsideMessages: true } };
    live.failed = [];
    live.emitted = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('1  a round that stalls ends at its deadline', () => {
    it('aborts its requests, answers null, and the next caller starts a round that finishes', async () => {
        const first = syncOutsideMailNow();
        await settle();
        expect(live.rounds).toHaveLength(1);
        expect(live.rounds[0].signal?.aborted).toBe(false);
        // Every caller meanwhile shares it: the chat's poll, the Chat tab.
        const poll = syncOutsideMailNow();
        await settle();
        expect(live.rounds).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(OUTSIDE_ROUND_MS);
        expect(await first).toBeNull();
        expect(await poll).toBeNull();
        expect(live.rounds[0].signal?.aborted).toBe(true);

        // Released: the next round runs.
        const next = syncOutsideMailNow();
        await settle();
        expect(live.rounds).toHaveLength(2);
        expect(live.rounds[1].signal?.aborted).toBe(false);
        live.rounds[1].finish(DONE);
        expect(await next).toEqual(DONE);
        expect(live.emitted).toEqual([OUTSIDE_CHATS_UPDATED]);
    });

    it('a round that finishes in time is not aborted after, and its timer is gone', async () => {
        const round = syncOutsideMailNow();
        await settle();
        live.rounds[0].finish(DONE);
        expect(await round).toEqual(DONE);
        expect(vi.getTimerCount()).toBe(0);
        expect(live.rounds[0].signal?.aborted).toBe(false);
    });
});

describe('2  a caller\'s own budget', () => {
    it('the background task waits only its budget for a round already running, and starts none beside it', async () => {
        const foreground = syncOutsideMailNow();
        await settle();
        const background = syncOutsideMailNow(5_000);
        await settle();
        expect(live.rounds).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await background).toBeNull();
        // The foreground round goes on to its own end.
        expect(live.rounds[0].signal?.aborted).toBe(false);
        live.rounds[0].finish(DONE);
        expect(await foreground).toEqual(DONE);
    });

    it('a round the background task starts has the background\'s deadline', async () => {
        const background = syncOutsideMailNow(5_000);
        await settle();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await background).toBeNull();
        expect(live.rounds[0].signal?.aborted).toBe(true);
    });
});

describe('3  the background step\'s budget inside iOS\'s ~30 s', () => {
    it('is its own budget early, what is left later, and nothing when too little is left', () => {
        expect(backgroundMailBudget(0)).toBe(OUTSIDE_BACKGROUND_MS);
        expect(backgroundMailBudget(5_000)).toBe(OUTSIDE_BACKGROUND_MS);
        // The sync's 20 s fail-fast, then the notices' share: what is left, under 30 s with a margin.
        const late = backgroundMailBudget(22_000);
        expect(late).toBeGreaterThan(0);
        expect(22_000 + late).toBeLessThanOrEqual(28_000);
        expect(backgroundMailBudget(26_500)).toBe(0);
        expect(backgroundMailBudget(40_000)).toBe(0);
    });
});

describe('4  the community reads its switch off', () => {
    it('asks nothing, and fails my lines still sending with the words why', async () => {
        live.profile = { features: {} };
        expect(await syncOutsideMailNow()).toBeNull();
        expect(live.rounds).toEqual([]);
        expect(live.failed).toEqual(["This community doesn't take messages from other communities."]);
        expect(live.emitted).toEqual([OUTSIDE_CHATS_UPDATED]);
    });

    it('a profile that can\'t be read at all (no copy kept, unreachable) fails nothing', async () => {
        live.profile = null;
        expect(await syncOutsideMailNow()).toBeNull();
        expect(live.rounds).toEqual([]);
        expect(live.failed).toEqual([]);
    });
});
