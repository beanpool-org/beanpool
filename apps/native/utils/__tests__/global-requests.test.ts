/**
 * Message requests waiting on the global community, behind the one row at the top of Chat (utils/global-requests.ts): nothing
 * is asked of global until the member has ticked a door on this phone, and a count is all that crosses.
 *
 * The file is imported once, and each test has a key of its own, which is all the count is kept by. Re-importing it for each test
 * ran @beanpool/core again inside that test's five seconds: 30-470 ms of every test here at load 15, and timeouts at load 60-80.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noteQuestionsOpened, requestsWaitingOnGlobal } from '../global-requests';

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
    // Not asked is not known (null), never a 0: the row's dot follows a 0 as a fall, so a "not asked" 0 would throw away
    // global's real 0 with it (PR #3301 review).
    it('a phone that has never ticked a door asks global nothing, and knows nothing (null, not 0)', async () => {
        expect(await requestsWaitingOnGlobal(me)).toBeNull();
        expect(net.get).not.toHaveBeenCalled();
    });

    it('a mark left by another account asks nothing either, and knows nothing', async () => {
        await noteQuestionsOpened('ef'.repeat(32));
        expect(await requestsWaitingOnGlobal(me)).toBeNull();
        expect(net.get).not.toHaveBeenCalled();
    });

    it('a door ticked here and global says none waiting: 0, a known count, told apart from not known (PR #3301 review)', async () => {
        await noteQuestionsOpened(me.publicKey);
        net.get.mockImplementation(async () => answer(0));
        expect(await requestsWaitingOnGlobal(me, 1_000)).toBe(0);
        // And once heard, a blip says that 0, not null.
        net.get.mockImplementation(async () => { throw new TypeError('Network request failed'); });
        expect(await requestsWaitingOnGlobal(me, 400_000)).toBe(0);
    });

    it('after a tick it asks for the counts alone, of global, signed', async () => {
        await noteQuestionsOpened(me.publicKey);
        expect(await requestsWaitingOnGlobal(me)).toBe(2);
        expect(net.get.mock.calls[0].slice(0, 3)).toEqual(['https://global.beanpool.org', '/api/me/unread', me]);
    });

    it('on global itself (or with no community at all) it asks nothing, and knows nothing: its own list has them', async () => {
        await noteQuestionsOpened(me.publicKey);
        store.set('beanpool_anchor_url', 'https://global.beanpool.org/');
        expect(await requestsWaitingOnGlobal(me)).toBeNull();
        store.set('beanpool_anchor_url', '');
        expect(await requestsWaitingOnGlobal(me)).toBeNull();
        store.delete('beanpool_anchor_url');
        expect(await requestsWaitingOnGlobal(me)).toBeNull();
        expect(net.get).not.toHaveBeenCalled();
    });

    it('the trip to global forgets the count: what was answered there, the row hears from global on the way home', async () => {
        await noteQuestionsOpened(me.publicKey);
        expect(await requestsWaitingOnGlobal(me, 1_000)).toBe(2);
        store.set('beanpool_anchor_url', 'https://global.beanpool.org/');
        expect(await requestsWaitingOnGlobal(me, 2_000)).toBeNull();
        store.set('beanpool_anchor_url', HOME);
        // Both answered there: global's own 0, a known count.
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

    it('no answer with nothing heard before is not known (null), never a 0 the row\'s dot would read as a fall (PR #3298 review)', async () => {
        await noteQuestionsOpened(me.publicKey);
        net.get.mockImplementation(async () => { throw new TypeError('Network request failed'); });
        expect(await requestsWaitingOnGlobal(me, 1_000)).toBeNull();
        net.get.mockImplementation(async () => answer(null, false));
        expect(await requestsWaitingOnGlobal(me, 2_000)).toBeNull();
        // Then global answers: its count.
        net.get.mockImplementation(async () => answer(2));
        expect(await requestsWaitingOnGlobal(me, 3_000)).toBe(2);
    });

    it('a storage read that fails is not known either: what it last heard, or null', async () => {
        await noteQuestionsOpened(me.publicKey);
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const read = AsyncStorage.getItem;
        try {
            AsyncStorage.getItem = async () => { throw new Error('storage is busy'); };
            expect(await requestsWaitingOnGlobal(me, 1_000)).toBeNull();
            AsyncStorage.getItem = read;
            expect(await requestsWaitingOnGlobal(me, 2_000)).toBe(2);
            AsyncStorage.getItem = async () => { throw new Error('storage is busy'); };
            expect(await requestsWaitingOnGlobal(me, 3_000)).toBe(2);
        } finally {
            AsyncStorage.getItem = read;
        }
        expect(net.get).toHaveBeenCalledTimes(1);
    });

    it('no key on this phone: nothing asked, nothing known (null)', async () => {
        await noteQuestionsOpened(me.publicKey);
        expect(await requestsWaitingOnGlobal(null)).toBeNull();
        expect(await requestsWaitingOnGlobal({ publicKey: me.publicKey } as any)).toBeNull();
        expect(net.get).not.toHaveBeenCalled();
    });
});

