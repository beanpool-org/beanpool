/**
 * Who "let in once" never accepts quietly (blocklist.ts getKeysOnceBlocked, slice S3b; Marty 21 Nov 2026: someone unblocked is
 * not let in quietly): every key of each person the account on this phone blocked, now or before an unblock it still
 * remembers, as the community named their keys. Real blocklist over in-memory storage; the community keeps no block list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>(), me: 'a'.repeat(64), failReads: false }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn(), addListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => { if (mem.failReads) throw new Error('storage is gone'); return mem.async.get(key) ?? null; }),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => (mem.me ? { publicKey: mem.me, privateKey: '0'.repeat(64) } : null)) }));
// The community keeps no block list: every sync is answered 404, so the phone's own changes are all there is.
vi.mock('../node-post', () => ({
    signedGet: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    signedPost: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
}));

import { announceAccountOnPhone } from '../account-on-phone';
import { blockUser, unblockUser, clearBlocklist, getBlockedUsers, getKeysOnceBlocked, blockSyncsEndedForTests } from '../blocklist';
import { blockChangesStoreKey, blockedKeyChainsStoreKey } from '../storage-keys';

const K = (c: string) => c.repeat(64);
let n = 0;

beforeEach(async () => {
    await blockSyncsEndedForTests();
    mem.async.clear();
    mem.async.set('beanpool_anchor_url', 'https://riverside.example');
    mem.failReads = false;
    mem.me = K(String.fromCharCode(97 + (n++ % 6)));
    announceAccountOnPhone(mem.me);
});

describe('getKeysOnceBlocked', () => {
    it('nobody blocked: none', async () => {
        expect(await getKeysOnceBlocked()).toEqual([]);
    });

    it('blocked now: on it, as on getBlockedUsers', async () => {
        await blockUser(K('1'));
        expect(await getKeysOnceBlocked()).toEqual([K('1')]);
        expect(await getBlockedUsers()).toEqual([K('1')]);
    });

    it('blocked, then unblocked: still on it, though getBlockedUsers no longer has them', async () => {
        await blockUser(K('1'));
        await unblockUser(K('1'));
        expect(await getBlockedUsers()).toEqual([]);
        expect(await getKeysOnceBlocked()).toEqual([K('1')]);
    });

    it('Unblock All: everyone it lifted is still on it', async () => {
        await blockUser(K('1'));
        await blockUser(K('2'));
        await clearBlocklist();
        expect(await getBlockedUsers()).toEqual([]);
        expect((await getKeysOnceBlocked())?.sort()).toEqual([K('1'), K('2')]);
    });

    it('a re-keyed person, unblocked under their old key: every key the community named as theirs', async () => {
        await blockUser(K('1'));
        await unblockUser(K('1'));
        // The community said 2 replaced 1 (blocklist.ts learns this from its answers).
        mem.async.set(blockedKeyChainsStoreKey(mem.me), JSON.stringify({ [K('2')]: [K('1')] }));
        expect((await getKeysOnceBlocked())?.sort()).toEqual([K('1'), K('2')]);
    });

    it('a change of someone else on the phone is not this account\'s', async () => {
        await blockUser(K('1'));
        const other = K('9');
        mem.me = other;
        announceAccountOnPhone(other);
        expect(await getKeysOnceBlocked()).toEqual([]);
    });

    it('no account on the phone: none', async () => {
        mem.me = '';
        announceAccountOnPhone(null);
        expect(await getKeysOnceBlocked()).toEqual([]);
    });

    it('the stores can\'t be read: null, so nobody is let in on a guess', async () => {
        await blockUser(K('1'));
        await unblockUser(K('1'));
        mem.failReads = true;
        expect(await getKeysOnceBlocked()).toBeNull();
    });

    it('the remembered unblocks are the changes kept: the store as written', async () => {
        await blockUser(K('1'));
        await unblockUser(K('1'));
        const changes = JSON.parse(mem.async.get(blockChangesStoreKey(mem.me))!);
        expect(changes.of[K('1')]).toMatchObject({ blocked: false });
    });
});
