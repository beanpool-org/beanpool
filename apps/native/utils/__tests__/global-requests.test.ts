/**
 * Message requests waiting on the global community, behind the one row at the top of Chat (utils/global-requests.ts): nothing
 * is asked of global until the member has ticked a door on this phone, and a count is all that crosses.
 *
 * The file is imported once, and each test has a key of its own, which is all the count is kept by. Re-importing it for each test
 * ran @beanpool/core again inside that test's five seconds: 30-470 ms of every test here at load 15, and timeouts at load 60-80.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noteQuestionsOpened, openGlobalRequests, requestsWaitingOnGlobal } from '../global-requests';

vi.hoisted(() => { (globalThis as any).__DEV__ = false; });

const store = vi.hoisted(() => new Map<string, string>());
const net = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
    },
}));
vi.mock('../node-post', () => ({ signedGet: net.get }));
const landing = vi.hoisted(() => ({ order: [] as string[], asked: [] as unknown[][], switched: [] as string[], busy: false }));
vi.mock('../use-communities', () => ({
    communitySwitchUnderWay: () => landing.busy,
    switchCommunity: async (url: string, before: () => Promise<void>) => { landing.switched.push(url); await before(); },
}));
vi.mock('../member-landing', () => ({ openAfterLanding: (...a: unknown[]) => { landing.order.push('open'); landing.asked.push(a); } }));

let keys = 0;
let me: any;
const HOME = 'https://mullum.example.org';
const answer = (requests: unknown, ok = true) => ({ ok, json: async () => ({ requests }) });

beforeEach(() => {
    me = { publicKey: String(++keys).padStart(64, '0'), privateKey: 'cd'.repeat(32) };
    store.clear();
    store.set('beanpool_anchor_url', HOME);
    net.get.mockReset();
    net.get.mockImplementation(async () => answer(2));
});

describe('what waits on global', () => {
    it('a phone that has never ticked a door asks global nothing', async () => {
        expect(await requestsWaitingOnGlobal(me)).toBe(0);
        expect(net.get).not.toHaveBeenCalled();
    });

    it('a mark left by another account asks nothing either', async () => {
        await noteQuestionsOpened('ef'.repeat(32));
        expect(await requestsWaitingOnGlobal(me)).toBe(0);
        expect(net.get).not.toHaveBeenCalled();
    });

    it('after a tick it asks for the counts alone, of global, signed', async () => {
        await noteQuestionsOpened(me.publicKey);
        expect(await requestsWaitingOnGlobal(me)).toBe(2);
        expect(net.get.mock.calls[0].slice(0, 3)).toEqual(['https://global.beanpool.org', '/api/me/unread', me]);
    });

    it('on global itself it asks nothing: its own list has them', async () => {
        await noteQuestionsOpened(me.publicKey);
        store.set('beanpool_anchor_url', 'https://global.beanpool.org/');
        expect(await requestsWaitingOnGlobal(me)).toBe(0);
        expect(net.get).not.toHaveBeenCalled();
    });

    it('the trip to global forgets the count: what was answered there, the row hears from global on the way home', async () => {
        await noteQuestionsOpened(me.publicKey);
        expect(await requestsWaitingOnGlobal(me, 1_000)).toBe(2);
        store.set('beanpool_anchor_url', 'https://global.beanpool.org/');
        expect(await requestsWaitingOnGlobal(me, 2_000)).toBe(0);
        store.set('beanpool_anchor_url', HOME);
        net.get.mockImplementation(async () => answer(0));
        expect(await requestsWaitingOnGlobal(me, 3_000)).toBe(0);
        expect(net.get).toHaveBeenCalledTimes(2);
    });

    it('a Chat tab that comes and goes asks once in five minutes, and then again', async () => {
        await noteQuestionsOpened(me.publicKey);
        await requestsWaitingOnGlobal(me, 1_000);
        await requestsWaitingOnGlobal(me, 1_000 + 299_000);
        expect(net.get).toHaveBeenCalledTimes(1);
        await requestsWaitingOnGlobal(me, 1_000 + 300_000);
        expect(net.get).toHaveBeenCalledTimes(2);
    });

    it('no answer, or an answer with no number, says what it last heard and throws nothing', async () => {
        await noteQuestionsOpened(me.publicKey);
        await requestsWaitingOnGlobal(me, 1_000);
        net.get.mockImplementation(async () => { throw new TypeError('Network request failed'); });
        expect(await requestsWaitingOnGlobal(me, 400_000)).toBe(2);
        net.get.mockImplementation(async () => answer('three'));
        expect(await requestsWaitingOnGlobal(me, 800_000)).toBe(2);
    });

    it('no key on this phone: nothing', async () => {
        expect(await requestsWaitingOnGlobal(null)).toBe(0);
        expect(await requestsWaitingOnGlobal({ publicKey: me.publicKey } as any)).toBe(0);
    });
});

describe('the tap on the row', () => {
    beforeEach(() => {
        Object.assign(landing, { order: [], asked: [], switched: [], busy: false });
    });
    const recheck = async () => { landing.order.push('recheck'); };

    it('moves the phone to global and asks for its Message requests, once the guard knows where the phone is', async () => {
        await openGlobalRequests(me.publicKey, recheck);
        expect(landing.switched).toEqual(['https://global.beanpool.org']);
        expect(landing.order).toEqual(['recheck', 'open']);
        expect(landing.asked[0]).toEqual(['/(tabs)/chats?filter=requests', 'https://global.beanpool.org', me.publicKey]);
    });

    it('a recognition that fails still asks: the guard then holds it, as a notice\'s', async () => {
        await openGlobalRequests(me.publicKey, async () => { throw new Error('no answer'); });
        expect(landing.order).toEqual(['open']);
    });

    it('a switch under way starts no second one, and no key starts none', async () => {
        await openGlobalRequests(null, recheck);
        landing.busy = true;
        await openGlobalRequests(me.publicKey, recheck);
        expect(landing.switched).toEqual([]);
    });
});

