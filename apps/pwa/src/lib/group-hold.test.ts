/**
 * A group stays a group (lib/group-hold.ts): once seen locked here, whatever the node calls it, and the lock store
 * unreadable never counts as "never held".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { memoryIndexedDB } from './memory-indexeddb';
import { indexedDbGroupLockStore, resetGroupChatLockStoreForTest } from './group-chat-lock-store';
import { rememberDmConversations, isKnownDmConversation } from './dm-guard';
import { holdConversation, sendRouteOf, startedDm } from './group-hold';

const ME = 'a'.repeat(64);
const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('holdConversation', () => {
    it('a group held locked here stays a group chat whatever the node calls it, and is never remembered as a DM', () => {
        const held = new Set([G]);
        for (const type of ['dm', 'enterprise_thread', 'event_thread', 'group_thread']) {
            expect(holdConversation({ id: G, type }, held).type).toBe('group_thread');
        }
        expect(isKnownDmConversation(G)).toBe(false);
    });

    it('anything else goes through the DM guard as before', () => {
        rememberDmConversations(['dm-1']);
        expect(holdConversation({ id: 'dm-1', type: 'enterprise_thread' }, new Set([G])).type).toBe('dm');
        expect(holdConversation({ id: 'e-1', type: 'event_thread' }, new Set()).type).toBe('event_thread');
        expect(holdConversation({ id: 'e-1', type: 'event_thread' }, null).type).toBe('event_thread');
    });
});

describe('sendRouteOf', () => {
    it('a group marked locked or with a verified epoch goes as a group line; one never held as typed', async () => {
        expect(await sendRouteOf(ME, G)).toBe('as-typed');
        await indexedDbGroupLockStore.markLocked(`${ME}/${G}`);
        expect(await sendRouteOf(ME, G)).toBe('group');
        await indexedDbGroupLockStore.raiseHighest(`${ME}/other-group`, 2);
        expect(await sendRouteOf(ME, 'other-group')).toBe('group');
        // Per identity: another member in this browser never held it.
        expect(await sendRouteOf('b'.repeat(64), G)).toBe('as-typed');
    });

    it('a held group the DM guard also knows still goes as a group line', async () => {
        rememberDmConversations([G]);
        await indexedDbGroupLockStore.markLocked(`${ME}/${G}`);
        expect(await sendRouteOf(ME, G)).toBe('group');
    });

    it('with the store unreadable, only a known DM goes on; anything else is refused, never "never held"', async () => {
        vi.stubGlobal('indexedDB', undefined);
        resetGroupChatLockStoreForTest();
        rememberDmConversations(['dm-1']);
        expect(await sendRouteOf(ME, 'dm-1')).toBe('as-typed');
        expect(await sendRouteOf(ME, 'event-1')).toBe('refuse');
        expect(await sendRouteOf(ME, G)).toBe('refuse');
    });
});

describe('startedDm (confirmation review of #1816, finding 1)', () => {
    const answer = (id: string) => ({ id, type: 'group_thread', participants: [ME, 'b'.repeat(64)] });

    it("the node answers \"start a DM\" with a group held locked here: nothing opens, nothing is remembered", () => {
        expect(startedDm(answer(G), new Set([G]))).toBeNull();
        expect(startedDm(answer(G.toUpperCase()), new Set([G]))).toBeNull();
        expect(isKnownDmConversation(G)).toBe(false);
    });

    it('the lock store unreadable: shown as a DM, never remembered as one', () => {
        expect(startedDm(answer('dm-2'), null)?.type).toBe('dm');
        expect(isKnownDmConversation('dm-2')).toBe(false);
    });

    it('otherwise a DM, remembered as one, whatever type the answer names', () => {
        expect(startedDm(answer('dm-3'), new Set([G]))?.type).toBe('dm');
        expect(isKnownDmConversation('dm-3')).toBe(true);
    });
});
