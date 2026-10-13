/**
 * The web's group chat lock store (group-chat-lock-store.ts): two facts per identity and group in IndexedDB, the highest
 * epoch never falling, reads that throw rather than answer "never held", and Sign Out taking every row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { memoryIndexedDB, type MemoryIndexedDB } from './memory-indexeddb';
import { indexedDbGroupLockStore as store, lockedGroupsOf, clearGroupChatLocks, resetGroupChatLockStoreForTest } from './group-chat-lock-store';

let idb: MemoryIndexedDB;
beforeEach(() => {
    idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    resetGroupChatLockStoreForTest();
});
afterEach(() => vi.unstubAllGlobals());

describe('group chat lock store', () => {
    it('keeps the highest epoch per identity and group, never lowered, and the locked mark', async () => {
        await store.raiseHighest('ana/g1', 3);
        await store.raiseHighest('ana/g1', 2);
        expect(await store.load('ana/g1')).toEqual({ highest: 3, locked: true });
        expect(await store.load('ben/g1')).toEqual({ highest: 0, locked: false });
        await store.markLocked('ben/g2');
        expect(await store.load('ben/g2')).toEqual({ highest: 0, locked: true });
        expect([...await lockedGroupsOf('ana')]).toEqual(['g1']);
        expect([...await lockedGroupsOf('ben')]).toEqual(['g2']);
        // Nothing but the two facts is kept.
        expect(idb.peek('beanpool-group-chat-locks', 'locks', 'ana/g1')).toEqual({ highest: 3, locked: true });
    });

    it('a read with no IndexedDB throws (the caller fails closed), and reads again once it is there', async () => {
        vi.stubGlobal('indexedDB', undefined);
        await expect(store.load('ana/g1')).rejects.toThrow();
        await expect(lockedGroupsOf('ana')).rejects.toThrow();
        vi.stubGlobal('indexedDB', idb);
        expect(await store.load('ana/g1')).toEqual({ highest: 0, locked: false });
    });

    it('Sign Out takes every row', async () => {
        await store.raiseHighest('ana/g1', 1);
        await clearGroupChatLocks();
        expect(idb.has('beanpool-group-chat-locks')).toBe(false);
        expect(await store.load('ana/g1')).toEqual({ highest: 0, locked: false });
    });
});
