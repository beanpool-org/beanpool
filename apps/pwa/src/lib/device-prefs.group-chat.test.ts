/**
 * Sign Out takes the group chats' state with it (lib/device-prefs.ts clearAccountStorage): the lock rows in IndexedDB
 * and every opened group key in memory (review of #1816, finding 5: DP1 and DP2 had no test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { memoryIndexedDB, type MemoryIndexedDB } from './memory-indexeddb';
import { indexedDbGroupLockStore, lockedGroupsOf, resetGroupChatLockStoreForTest } from './group-chat-lock-store';
import { groupKeyring, groupsSeenLockedInMemory, forgetGroupKeys, memoryGroupLockStore } from './group-chat-keys';
import { clearAccountStorage } from './device-prefs';
import { fakeGroupNode, person } from './group-chat-fake-node.test-support';

const G = '8b1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
let mem: MemoryIndexedDB;

beforeEach(() => {
    localStorage.clear();
    mem = memoryIndexedDB();
    vi.stubGlobal('indexedDB', mem);
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Sign Out and the group chats', () => {
    it('the lock rows go (DP1) and the opened keys leave memory (DP2)', async () => {
        const ana = person(true); const ben = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        await indexedDbGroupLockStore.markLocked(`${ana.publicKey}/${G}`);
        const ring = groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore());
        await ring.prepareToSeal();
        expect([...await lockedGroupsOf(ana.publicKey)]).toEqual([G]);
        expect(groupsSeenLockedInMemory(ana.publicKey)).toEqual([G]);

        await clearAccountStorage();

        resetGroupChatLockStoreForTest();
        expect([...await lockedGroupsOf(ana.publicKey)]).toEqual([]);
        expect(groupsSeenLockedInMemory(ana.publicKey)).toEqual([]);
        // A keyring asked for afterwards is a new one, holding nothing.
        expect(groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore())).not.toBe(ring);
    });
});
