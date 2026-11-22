/**
 * The web's group chat lock store (group-chat-lock-store.ts): two facts per identity and group in IndexedDB, the highest
 * epoch never falling, reads that throw rather than answer "never held", and Sign Out taking every row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { memoryIndexedDB, type MemoryIndexedDB } from './memory-indexeddb';
import { indexedDbGroupLockStore as store, lockedGroupsOf, clearGroupChatLocks, LOCK_STORE_MS, resetGroupChatLockStoreForTest } from './group-chat-lock-store';

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

    it('an open that never answers is a failed read after its time, the next read opens afresh, and the late one is closed', async () => {
        vi.useFakeTimers();
        try {
            const late: any = { result: { close: vi.fn() }, onsuccess: null };
            const open = vi.fn().mockReturnValueOnce(late).mockImplementation((n: string) => idb.open(n));
            vi.stubGlobal('indexedDB', { open, deleteDatabase: idb.deleteDatabase });
            const read = store.load('ana/g1').then(() => 'read', (e: Error) => e.message);
            await vi.advanceTimersByTimeAsync(LOCK_STORE_MS + 1);
            expect(await read).toBe('The group chat lock store did not answer.');
            const again = store.load('ana/g1');
            await vi.advanceTimersByTimeAsync(10);
            expect(await again).toEqual({ highest: 0, locked: false });
            expect(open).toHaveBeenCalledTimes(2);
            late.onsuccess?.({ target: late });
            expect(late.result.close).toHaveBeenCalledTimes(1);
            // No wait is left running.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('Sign Out takes every row', async () => {
        await store.raiseHighest('ana/g1', 1);
        await clearGroupChatLocks();
        expect(idb.has('beanpool-group-chat-locks')).toBe(false);
        expect(await store.load('ana/g1')).toEqual({ highest: 0, locked: false });
    });
});
