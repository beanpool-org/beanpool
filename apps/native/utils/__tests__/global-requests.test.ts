/**
 * Message requests waiting on the global community, behind the one row at the top of Chat (utils/global-requests.ts): nothing
 * is asked of global until the member has ticked a door on this phone, and a count is all that crosses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).__DEV__ = false;

const store = vi.hoisted(() => new Map<string, string>());
const net = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
    },
}));
vi.mock('../node-post', () => ({ signedGet: net.get }));

const me = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as any;
const HOME = 'https://mullum.example.org';
const answer = (requests: unknown, ok = true) => ({ ok, json: async () => ({ requests }) });

async function fresh() {
    vi.resetModules();
    return import('../global-requests');
}

beforeEach(() => {
    store.clear();
    store.set('beanpool_anchor_url', HOME);
    net.get.mockReset();
    net.get.mockImplementation(async () => answer(2));
});

describe('what waits on global', () => {
    it('a phone that has never ticked a door asks global nothing', async () => {
        const { requestsWaitingOnGlobal } = await fresh();
        expect(await requestsWaitingOnGlobal(me)).toBe(0);
        expect(net.get).not.toHaveBeenCalled();
    });

    it('a mark left by another account asks nothing either', async () => {
        const { noteQuestionsOpened, requestsWaitingOnGlobal } = await fresh();
        await noteQuestionsOpened('ef'.repeat(32));
        expect(await requestsWaitingOnGlobal(me)).toBe(0);
        expect(net.get).not.toHaveBeenCalled();
    });

    it('after a tick it asks for the counts alone, of global, signed', async () => {
        const { noteQuestionsOpened, requestsWaitingOnGlobal } = await fresh();
        await noteQuestionsOpened(me.publicKey);
        expect(await requestsWaitingOnGlobal(me)).toBe(2);
        expect(net.get.mock.calls[0].slice(0, 3)).toEqual(['https://global.beanpool.org', '/api/me/unread', me]);
    });

    it('on global itself it asks nothing: its own list has them', async () => {
        const { noteQuestionsOpened, requestsWaitingOnGlobal } = await fresh();
        await noteQuestionsOpened(me.publicKey);
        store.set('beanpool_anchor_url', 'https://global.beanpool.org/');
        expect(await requestsWaitingOnGlobal(me)).toBe(0);
        expect(net.get).not.toHaveBeenCalled();
    });

    it('a Chat tab that comes and goes asks once in five minutes, and then again', async () => {
        const { noteQuestionsOpened, requestsWaitingOnGlobal } = await fresh();
        await noteQuestionsOpened(me.publicKey);
        await requestsWaitingOnGlobal(me, 1_000);
        await requestsWaitingOnGlobal(me, 1_000 + 299_000);
        expect(net.get).toHaveBeenCalledTimes(1);
        await requestsWaitingOnGlobal(me, 1_000 + 300_000);
        expect(net.get).toHaveBeenCalledTimes(2);
    });

    it('no answer, or an answer with no number, says what it last heard and throws nothing', async () => {
        const { noteQuestionsOpened, requestsWaitingOnGlobal } = await fresh();
        await noteQuestionsOpened(me.publicKey);
        await requestsWaitingOnGlobal(me, 1_000);
        net.get.mockImplementation(async () => { throw new TypeError('Network request failed'); });
        expect(await requestsWaitingOnGlobal(me, 400_000)).toBe(2);
        net.get.mockImplementation(async () => answer('three'));
        expect(await requestsWaitingOnGlobal(me, 800_000)).toBe(2);
    });

    it('no key on this phone: nothing', async () => {
        const { requestsWaitingOnGlobal } = await fresh();
        expect(await requestsWaitingOnGlobal(null)).toBe(0);
        expect(await requestsWaitingOnGlobal({ publicKey: me.publicKey } as any)).toBe(0);
    });
});
