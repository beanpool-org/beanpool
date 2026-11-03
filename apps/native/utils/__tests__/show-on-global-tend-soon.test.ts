/**
 * The phone's gate on a tend (utils/show-on-global.ts tendCopiesSoon): the 5-minute timer and each return to the front call it,
 * a tend goes at most hourly, and inside the hour an Off global hasn't answered goes by itself, with nothing else. The cases of
 * the copy itself are core's (packages/beanpool-core show-on-global.test.ts) and show-on-global-e2e's, on real nodes.
 *
 * The file is imported fresh for each test: what it keeps of the hour is one page load's, as a phone's is one run's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOWN_ON_GLOBAL_STORE_KEY } from '../storage-keys';

vi.hoisted(() => { (globalThis as any).__DEV__ = false; });

const store = vi.hoisted(() => new Map<string, string>());
const net = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
    },
}));
vi.mock('../node-post', () => ({ signedGet: net.get, signedPost: net.post, signedDelete: net.del }));
vi.mock('../node-profile', () => ({ fetchNodeProfile: async () => null, getCachedNodeProfile: async () => null }));
vi.mock('../crypto', () => ({ memberSigner: () => async () => new Uint8Array(64) }));
vi.mock('../events', () => ({ isEventEnded: () => false }));
vi.mock('../global-node-url', () => ({ GLOBAL_NODE_URL: 'https://global.test' }));

const HOUR = 60 * 60_000;
const FIVE_MINUTES = 5 * 60_000;
const NOW = 1_800_000_000_000;
const DOOR = '/api/marketplace/posts/takes-questions';
const me = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as never;
const copy = { publicKey: 'ab'.repeat(32), home: 'https://home.test', homeId: 'h', copyId: 'c', sent: '{}', sentAt: NOW, photo: '', skips: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const toDoor = () => net.post.mock.calls.filter(([, path]) => path === DOOR).length;
const reads = () => net.get.mock.calls.length;

async function freshGate() {
    vi.resetModules();
    return (await import('../show-on-global')).tendCopiesSoon;
}

/** Holds a pair as stored, with what a tap would have left. */
const pairs = (...extra: Record<string, unknown>[]) => store.set(SHOWN_ON_GLOBAL_STORE_KEY, JSON.stringify(extra.map((e) => ({ ...copy, ...e }))));
const doorSays = (status: number) => net.post.mockImplementation(async () => json(status === 200 ? { success: true } : { error: 'Busy' }, status));

beforeEach(() => {
    store.clear();
    net.get.mockReset().mockImplementation(async () => json([]));
    net.post.mockReset();
    net.del.mockReset();
});

describe('a tend, by the phone\'s timer', () => {
    it('with an Off owed inside the hour: the Off and nothing else, and the hour stays where it was', async () => {
        const tendCopiesSoon = await freshGate();
        pairs({});
        await tendCopiesSoon(me, NOW);
        const asked = reads();
        expect(asked).toBeGreaterThan(0);
        pairs({ questions: false, questionsOwed: true });
        doorSays(200);
        await tendCopiesSoon(me, NOW + FIVE_MINUTES);
        expect(toDoor()).toBe(1);
        expect(reads()).toBe(asked);
        await tendCopiesSoon(me, NOW + HOUR - 1);
        expect(reads()).toBe(asked);
        await tendCopiesSoon(me, NOW + HOUR);
        expect(reads()).toBeGreaterThan(asked);
    });

    it('with nothing owed, the 5-minute timer goes for nothing, all hour', async () => {
        const tendCopiesSoon = await freshGate();
        pairs({});
        await tendCopiesSoon(me, NOW);
        const asked = reads();
        const posts = net.post.mock.calls.length;
        for (let tick = 1; tick < 12; tick++) await tendCopiesSoon(me, NOW + tick * FIVE_MINUTES);
        expect(reads()).toBe(asked);
        expect(net.post.mock.calls.length).toBe(posts);
    });

    it('retries each tick while global gives no answer, and stops when it does', async () => {
        const tendCopiesSoon = await freshGate();
        pairs({});
        await tendCopiesSoon(me, NOW);
        pairs({ questions: false, questionsOwed: true });
        doorSays(503);
        for (let tick = 1; tick <= 6; tick++) await tendCopiesSoon(me, NOW + tick * FIVE_MINUTES);
        expect(toDoor()).toBe(6);
        doorSays(200);
        for (let tick = 7; tick <= 9; tick++) await tendCopiesSoon(me, NOW + tick * FIVE_MINUTES);
        expect(toDoor()).toBe(7);
    });

    it('a phone flicked to the front and back between ticks sends nothing extra', async () => {
        const tendCopiesSoon = await freshGate();
        pairs({});
        await tendCopiesSoon(me, NOW);
        pairs({ questions: false, questionsOwed: true });
        doorSays(503);
        await tendCopiesSoon(me, NOW + 60_000);
        expect(toDoor()).toBe(1);
        for (let second = 1; second < 30; second += 3) await tendCopiesSoon(me, NOW + 60_000 + second * 1000);
        expect(toDoor()).toBe(1);
    });

    it('an Off a whole tend could not send starts the same wait', async () => {
        const tendCopiesSoon = await freshGate();
        pairs({ questions: false, questionsOwed: true });
        doorSays(503);
        net.get.mockImplementation(async () => json({ error: 'Busy' }, 503));
        await tendCopiesSoon(me, NOW);
        expect(toDoor()).toBe(1);
        await tendCopiesSoon(me, NOW + 10_000);
        expect(toDoor()).toBe(1);
        await tendCopiesSoon(me, NOW + 30_000);
        expect(toDoor()).toBe(2);
    });

    it('a 429 holds the Off for as long as it asks', async () => {
        const tendCopiesSoon = await freshGate();
        pairs({});
        await tendCopiesSoon(me, NOW);
        pairs({ questions: false, questionsOwed: true });
        net.post.mockImplementation(async () => new Response(JSON.stringify({ error: 'Slow down' }), { status: 429, headers: { 'Retry-After': '1200' } }));
        await tendCopiesSoon(me, NOW + FIVE_MINUTES);
        await tendCopiesSoon(me, NOW + 2 * FIVE_MINUTES);
        await tendCopiesSoon(me, NOW + 4 * FIVE_MINUTES);
        expect(toDoor()).toBe(1);
        await tendCopiesSoon(me, NOW + 5 * FIVE_MINUTES);
        expect(toDoor()).toBe(2);
    });

    it('with no key, nobody is asked', async () => {
        const tendCopiesSoon = await freshGate();
        await tendCopiesSoon(null, NOW);
        expect(reads()).toBe(0);
    });
});
