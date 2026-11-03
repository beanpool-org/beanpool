/**
 * An Off global hasn't answered, in the web app (lib/show-on-global.ts keepTryingOffs): a tab left open tries it again, backing off,
 * and a tab with nothing owed calls nobody and holds no timer. What an Off is and when it counts as answered are core's, and its
 * suite holds them (src/__tests__/show-on-global.test.ts). The pairs are a plain array here: the IndexedDB stand-in's answers come
 * by timers, which this file stops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toEd25519Pkcs8, type CopyPair } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';

vi.mock('./visitor-lobby-gate', async () => ({ ...(await vi.importActual('./visitor-lobby-gate')), communityInfoOnce: vi.fn() }));
vi.mock('./copy-pairs', () => {
    let held: CopyPair[] = [];
    return {
        copyPairs: {
            read: async () => held,
            change: async (edit: (pairs: CopyPair[]) => CopyPair[]) => { held = edit(held); },
        },
        clearCopyPairs: async () => { held = []; },
    };
});

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const me = {
    publicKey: 'ab'.repeat(32), privateKey: hex(toEd25519Pkcs8(new Uint8Array(32).fill(7))), callsign: 'River', createdAt: '2026-11-03T00:00:00Z',
} as BeanPoolIdentity;
const pair = (copyId: string, extra: Partial<CopyPair> = {}): CopyPair => ({ publicKey: me.publicKey, home: 'https://home.test', homeId: `home-${copyId}`, copyId, sent: '', sentAt: 0, photo: '', skips: [], ...extra });
const fetchMock = vi.fn();

describe('an Off global has not answered, with the tab left open', () => {
    const DOOR = '/api/marketplace/posts/takes-questions';
    const COPY = pair('a', { homeId: 'h', sent: '{}', questions: true });
    const toDoor = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(DOOR)).length;
    const elsewhere = () => fetchMock.mock.calls.filter(([url]) => !String(url).endsWith(DOOR)).map(([url]) => String(url));
    /** Global's answers to the door from now on, in order; the last stands. */
    const doorSays = (...statuses: number[]) => fetchMock.mockImplementation(async (url: string) => {
        if (!String(url).endsWith(DOOR)) return new Response('[]');
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
        return new Response(JSON.stringify(status === 200 ? { success: true } : { error: 'Busy' }), { status });
    });
    const after = (ms: number) => vi.advanceTimersByTimeAsync(ms);

    // Each test has a keeper and a timer of its own, as a page load has, and a store of its own (the mock above runs again).
    let lib: typeof import('./show-on-global');
    let pairs: typeof import('./copy-pairs');
    beforeEach(async () => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
        localStorage.clear();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(1_800_000_000_000);
        vi.resetModules();
        lib = await import('./show-on-global');
        pairs = await import('./copy-pairs');
        const gate = await import('./visitor-lobby-gate');
        vi.mocked(gate.communityInfoOnce).mockResolvedValue({ profile: 'local', globalCommunityUrl: 'https://global.test', addresses: [] } as never);
        await pairs.copyPairs.change(() => [COPY]);
        localStorage.setItem('beanpool_copies_tended', String(Date.now()));
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('is tried again until global answers, backing off, and then it stops for good', async () => {
        doorSays(503, 503, 503, 200);
        expect(await lib.takeQuestions('h', false, me)).toBe('later');
        expect(toDoor()).toBe(1);
        await after(29_000);
        expect(toDoor()).toBe(1);
        await after(1_000);
        expect(toDoor()).toBe(2);
        await after(59_000);
        expect(toDoor()).toBe(2);
        await after(1_000);
        expect(toDoor()).toBe(3);
        await after(120_000);
        expect(toDoor()).toBe(4);
        expect((await pairs.copyPairs.read())[0]).toMatchObject({ questions: false, questionsOwed: false });
        expect(vi.getTimerCount()).toBe(0);
        await after(3 * 60 * 60_000);
        expect(toDoor()).toBe(4);
    });

    it('asks only global, and only about the door: no community, and no other copy', async () => {
        doorSays(503, 200);
        await lib.takeQuestions('h', false, me);
        await after(30_000);
        expect(toDoor()).toBe(2);
        expect(elsewhere()).toEqual([]);
    });

    it('a tab flicked back and forth sends nothing extra: the wait holds, and the one timer stands', async () => {
        doorSays(503);
        await lib.takeQuestions('h', false, me);
        for (let i = 0; i < 5; i++) await lib.tendCopiesSoon(me);
        expect(toDoor()).toBe(1);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('owed from an earlier page, the tab goes after it on load, inside the hour', async () => {
        await pairs.copyPairs.change(() => [{ ...COPY, questions: false, questionsOwed: true }]);
        doorSays(200);
        await lib.tendCopiesSoon(me);
        expect(toDoor()).toBe(1);
        expect(elsewhere()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('sends nothing else inside the hour, and leaves the hour where it was', async () => {
        const tended = String(Date.now());
        await pairs.copyPairs.change(() => [{ ...COPY, questions: false, questionsOwed: true }]);
        doorSays(503, 200);
        await lib.tendCopiesSoon(me);
        await after(30_000);
        expect(toDoor()).toBe(2);
        expect(localStorage.getItem('beanpool_copies_tended')).toBe(tended);
    });

    it('a tab left open with nothing owed calls nobody, and holds no timer', async () => {
        doorSays(200);
        await lib.tendCopiesSoon(me);
        expect(vi.getTimerCount()).toBe(0);
        await after(3 * 60 * 60_000);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a tab with no copy at all does not even look up which global its community names', async () => {
        await pairs.copyPairs.change(() => []);
        const gate = await import('./visitor-lobby-gate');
        vi.mocked(gate.communityInfoOnce).mockClear();
        await lib.tendCopiesSoon(me);
        expect(gate.communityInfoOnce).not.toHaveBeenCalled();
    });

    it('a refusal is an answer: the tab stops, and the Off stays owed for a tend', async () => {
        doorSays(503, 403);
        await lib.takeQuestions('h', false, me);
        await after(30_000);
        expect(toDoor()).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
        await after(30 * 60_000);
        expect(toDoor()).toBe(2);
    });

    it('an On that did not land starts no timer', async () => {
        doorSays(503);
        expect(await lib.takeQuestions('h', true, me)).toBe('later');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('signed out while it waits: nothing owed, so nothing goes', async () => {
        doorSays(503);
        await lib.takeQuestions('h', false, me);
        fetchMock.mockClear();
        await pairs.clearCopyPairs();
        await after(30 * 60_000);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('another account\'s Off is not this one\'s to send', async () => {
        await pairs.copyPairs.change(() => [{ ...COPY, publicKey: 'cd'.repeat(32), questions: false, questionsOwed: true }]);
        doorSays(200);
        const gate = await import('./visitor-lobby-gate');
        vi.mocked(gate.communityInfoOnce).mockClear();
        await lib.tendCopiesSoon(me);
        expect(gate.communityInfoOnce).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('two callers at once set one timer, and the next try is one try', async () => {
        await pairs.copyPairs.change(() => [{ ...COPY, questions: false, questionsOwed: true }]);
        doorSays(503);
        await Promise.all([lib.tendCopiesSoon(me), lib.tendCopiesSoon(me)]);
        expect(vi.getTimerCount()).toBe(1);
        await after(30_000);
        expect(toDoor()).toBe(2);
    });

    it('a 429 waits as global asks, in a tab as on a phone', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Slow down' }), { status: 429, headers: { 'Retry-After': '600' } }));
        await lib.takeQuestions('h', false, me);
        await after(599_000);
        expect(toDoor()).toBe(1);
        await after(1_000);
        expect(toDoor()).toBe(2);
    });
});
