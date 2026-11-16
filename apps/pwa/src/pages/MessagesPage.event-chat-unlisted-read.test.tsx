/**
 * An event's chat opened from its event while it is not in the chat list (the server lists it only once someone has written in
 * it: engine/event-thread.ts chatListedFor). The web opens it by its own route (getEventChat), with no unread count to go by.
 * The host unticked "Only people I let in" before anyone wrote, so the node's "opened to everyone going" line is in it: the open
 * marks the chat read, as the phone does on every open (EventChatView), or that line stays unread and the first line someone
 * writes counts "2 new" on the web where the phone counts "1 new" (the deciding review of #3231, head 7900d37b).
 *
 *   the chat holds          open from the event  ->  marked read on the node
 *   a system line only                               yes, once
 *   nothing                                          no (nothing to mark)
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import { forgetDraftsForTests } from '../lib/chat-drafts';
import { getEventChat, markConversationReadApi } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage, EventThreadMessage } from '../lib/api';

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
// This browser holds no locked group chats, and can say so (jsdom has no IndexedDB): the id is not a held group.
vi.mock('../lib/group-hold', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/group-hold')>()),
    lockedGroupsOrNull: vi.fn(async () => new Set<string>()),
}));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const ME: BeanPoolIdentity = { publicKey: 'member-ana', privateKey: 'k', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };
const KOFI = 'member-kofi';
const EVENT_ID = 'event-working-bee';

/** The member's list: one direct chat. The event's chat is not in it. */
const DM: Conversation = {
    id: 'dm-kofi', type: 'dm', name: null, participants: [ME.publicKey, KOFI], createdBy: ME.publicKey,
    createdAt: '2026-10-01T00:00:00Z', peerCallsign: 'Kofi', peerAvatar: null,
};
const EVENT_CONV = {
    id: EVENT_ID, type: 'event_thread', name: 'Working bee', participants: [ME.publicKey, KOFI], createdBy: KOFI,
    createdAt: '2026-10-01T00:00:00Z',
} as Conversation;
/** The node's line when the host opens the chat to everyone going (engine/event-thread.ts writeEventOpenedLine). */
const OPENED_LINE: EventThreadMessage = {
    id: 'sys-1', conversationId: EVENT_ID, authorPubkey: 'SYSTEM', ciphertext: 'The host opened this chat to everyone going.',
    nonce: '00000', type: 'system', systemType: 'event_opened_to_going', metadata: JSON.stringify({ postId: EVENT_ID }),
    timestamp: '2026-11-16T00:00:00.000Z',
};

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [DM], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: DM, messages: [] as ApiMessage[] })),
    getMembers: vi.fn(async () => [{ publicKey: KOFI, callsign: 'Kofi' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    sendMessageApi: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(),
    getGroupMembers: vi.fn(async () => []),
    getMemberProfile: vi.fn(async () => { throw new Error('Not found'); }),
    getMemberRatings: vi.fn(async () => ({ average: 0, count: 0, ratings: [] })),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 10, keeperOf: [] })),
    getRatingsGiven: vi.fn(async () => ({ ratings: [] })),
    getFriends: vi.fn(async () => []),
    getPublicChannels: vi.fn(async () => ({ channels: [] })),
    groupKeysNet: { get: vi.fn(), post: vi.fn() },
    getMyVouching: vi.fn(async () => null),
}));

function eventChatHolding(messages: EventThreadMessage[]) {
    vi.mocked(getEventChat).mockResolvedValue({
        conversation: EVENT_CONV, messages, readOnly: false, readOnlyReason: null, canPost: true, isHost: false,
        title: 'Working bee', eventEndAt: '2030-09-28T12:00:00.000Z', eventState: 'scheduled', privateNote: null,
        notice: "Visible to the host, everyone going, and this node's operator.",
    });
}
async function openFromTheEvent() {
    render(<MessagesPage identity={ME} openConversationId={EVENT_ID} homeNonce={0} onConversationOpened={() => {}} />);
    expect(await screen.findByTestId('event-chat')).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

beforeEach(() => { vi.clearAllMocks(); forgetDraftsForTests(); });
afterEach(() => { cleanup(); });

describe('an event chat opened while it is not in the list', () => {
    it('holding only the node\'s "opened to everyone going" line: marked read once, as the phone does', async () => {
        eventChatHolding([OPENED_LINE]);
        await openFromTheEvent();
        const marks = vi.mocked(markConversationReadApi).mock.calls.filter(([, id]) => id === EVENT_ID);
        expect(marks).toEqual([[ME.publicKey, EVENT_ID]]);
    });

    it('holding nothing: no mark is asked for', async () => {
        eventChatHolding([]);
        await openFromTheEvent();
        expect(vi.mocked(markConversationReadApi)).not.toHaveBeenCalled();
    });
});
