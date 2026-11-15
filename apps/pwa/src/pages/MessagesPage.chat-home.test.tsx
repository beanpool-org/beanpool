/**
 * Chat chosen in the menu while Chat already shows (Marty, 16 Nov, inside an event chat: "clicking on chat in menu should take
 * you back to the main chat menu - not just need the tiny back arrow"). App bumps `homeNonce` (App.chatHomeNonce, its own test
 * in App.chatSideWaysIn.test.tsx); here, the real MessagesPage over a stand-in node, from every place inside Chat:
 *
 *   where you are     x  Chat chosen in the menu  ->  the chat list shows, the filter chip as the member left it, and
 *                                                     words typed and not sent are in the box when that chat opens again.
 *
 * Also: a way in that names a chat still opens it (openConversationId), and one still being found when the member chose Chat
 * does not open over the list; the back arrow keeps the draft too and is its own 44 x 44 target named "Back to chats".
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import { forgetDraftsForTests } from '../lib/chat-drafts';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
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
vi.mock('../lib/e2e-crypto', () => ({
    dmThreadInShownOrder: (msgs: unknown[]) => msgs,
    dmQuoteFrom: vi.fn(() => null),
    dmQuoteLabel: vi.fn(() => null),
    dmLineShownText: vi.fn((v: { text: string | null } | undefined) => v?.text ?? ''),
    dmLineIsUnattributed: vi.fn(() => false),
    dmReplyToOf: vi.fn(() => null),
    decodePlaintext: vi.fn((c: string) => c),
    encodePlaintext: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    sealDmLine: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    openDmLine: vi.fn((p: { ciphertext: string }) => ({ text: p.ciphertext, format: 4, after: null, conversationId: '', moved: false })),
    checkDmThread: vi.fn(() => new Map()),
    dmAfterReference: vi.fn(() => null),
    dmLineMarkText: vi.fn(() => null),
    newDmMessageId: vi.fn(() => 'msg-1'),
    isEncryptedNonce: vi.fn(() => false),
    DM_LINE_NOT_VERIFIED_TEXT: "🔒 This message couldn't be verified, so it isn't shown.",
}));

const ME: BeanPoolIdentity = { publicKey: 'member-ana', privateKey: 'k', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };
const KOFI = 'member-kofi';
const GROUP_ID = 'group-crew-123';
const EVENT_ID = 'event-working-bee';

/** Someone in another community, in an open chat kept in this browser (lib/outside-chat-store.ts). */
const OUTSIDE = {
    id: 'outside-sol', peerKey: 'sol-key', peerName: 'Sol', peerHome: 'hills.example', state: 'open', lastText: 'see you there',
    lastAt: '2026-11-15T00:00:00.000Z', restored: false, unread: 0,
};
vi.mock('../lib/outside-mail', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/outside-mail')>();
    const ctx = {
        nodeUrl: 'https://riverside.example', identity: { publicKey: 'member-ana', privateKey: 'k', callsign: 'Ana' },
        store: { chat: async () => OUTSIDE, lines: async () => [], chats: async () => [OUTSIDE] },
        isBlocked: async () => false, holds: () => true,
    };
    return {
        ...real,
        outsideContext: async () => ctx,
        chatsShown: async () => [OUTSIDE],
        syncOutsideMailNow: () => Promise.resolve(null),
    };
});

const conversations: Record<string, Conversation> = {
    'dm-kofi': {
        id: 'dm-kofi', type: 'dm', name: null, participants: [ME.publicKey, KOFI], createdBy: ME.publicKey,
        createdAt: '2026-10-01T00:00:00Z', peerCallsign: 'Kofi', peerAvatar: null,
    },
    [GROUP_ID]: {
        id: GROUP_ID, type: 'group_thread', name: 'Garden crew', participants: [ME.publicKey, KOFI], createdBy: ME.publicKey,
        createdAt: '2026-10-01T00:00:00Z',
    },
    [EVENT_ID]: {
        id: EVENT_ID, type: 'event_thread', name: 'Working bee', participants: [ME.publicKey], createdBy: KOFI,
        createdAt: '2026-10-01T00:00:00Z',
    } as Conversation,
};

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({
        conversations: Object.values(conversations),
        totalUnread: 0,
        // A request is waiting: the "Message requests" row shows and opens its own view.
        requests: { count: 1, conversations: [] },
    })),
    getConversationMessages: vi.fn(async (convId: string) => ({ conversation: conversations[convId], messages: [] as ApiMessage[] })),
    getMembers: vi.fn(async () => [{ publicKey: KOFI, callsign: 'Kofi' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(async () => ({
        conversation: conversations[EVENT_ID], messages: [], readOnly: false, readOnlyReason: null, canPost: true, isHost: false,
        title: 'Working bee', eventEndAt: '2030-09-28T12:00:00.000Z', eventState: 'scheduled', privateNote: null,
        notice: "Visible to the host, everyone going, and this node's operator.",
    })),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async (groupId: string) => ({ conversation: conversations[groupId], messages: [], canPost: true })),
    getGroupMembers: vi.fn(async () => [
        { groupId: GROUP_ID, memberPubkey: ME.publicKey, callsign: 'Ana', role: 'member', status: 'active', joinedAt: '' },
        { groupId: GROUP_ID, memberPubkey: KOFI, callsign: 'Kofi', role: 'member', status: 'active', joinedAt: '' },
    ]),
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

type Props = { open: string | null; home: number };
let view: ReturnType<typeof render> | null = null;
const draw = (p: Props) => <MessagesPage identity={ME} openConversationId={p.open} homeNonce={p.home} onConversationOpened={() => {}} />;
async function show(p: Props) {
    if (!view) view = render(draw(p));
    else view.rerender(draw(p));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}
/** The chat list: its filter chips, nothing open over it. */
async function onTheList(where: string) {
    expect(await screen.findByTestId('conversation-filter-chips'), where).toBeInTheDocument();
    expect(screen.queryByTestId('chat-back'), where).toBeNull();
    expect(screen.queryByTestId('event-chat'), where).toBeNull();
    expect(screen.queryByTestId('outside-chat'), where).toBeNull();
    expect(screen.queryByTestId('message-requests'), where).toBeNull();
}
/** The box of the chat on screen: the community chat's, an event chat's or an outside chat's. */
async function box(): Promise<HTMLTextAreaElement> {
    const outside = screen.queryByTestId('outside-chat-input');
    if (outside) return outside as HTMLTextAreaElement;
    const event = screen.queryByTestId('event-chat');
    if (event) return within(event).getByRole('textbox') as HTMLTextAreaElement;
    await screen.findByTestId('chat-back');
    return document.querySelector('textarea') as HTMLTextAreaElement;
}
async function type(words: string) {
    const b = await waitFor(box);
    fireEvent.change(b, { target: { value: words } });
    expect(b.value).toBe(words);
}

beforeEach(() => { vi.clearAllMocks(); forgetDraftsForTests(); });
afterEach(() => { cleanup(); view = null; });

/** Each place a chat opens, how it is opened, and how it is opened again to find its draft. */
const CHATS: Array<{ where: string; open: () => Promise<void> }> = [
    { where: 'a DM', open: () => show({ open: 'dm-kofi', home: nonce }) },
    { where: 'a group chat', open: () => show({ open: GROUP_ID, home: nonce }) },
    { where: 'an event chat', open: () => show({ open: EVENT_ID, home: nonce }) },
    {
        where: 'an outside chat', open: async () => {
            fireEvent.click(await screen.findByTestId('outside-chat-row'));
            await screen.findByTestId('outside-chat-input');
        },
    },
];
let nonce = 0;
const chooseChatInTheMenu = () => show({ open: null, home: ++nonce });

describe('Chat chosen in the menu while Chat shows: the chat list, the draft kept', () => {
    beforeEach(() => { nonce = 0; });

    for (const chat of CHATS) {
        it(`from ${chat.where}`, async () => {
            await show({ open: null, home: nonce });
            await onTheList('before');
            await chat.open();
            await type(`half a thought in ${chat.where}`);
            // The way in is spent (App clears it once the chat opened), then Chat is chosen in the menu.
            await chooseChatInTheMenu();
            await onTheList(chat.where);
            // Opened again: the words are still in its box.
            if (chat.where !== 'an outside chat') await show({ open: null, home: nonce });
            await chat.open();
            expect((await waitFor(box)).value, chat.where).toBe(`half a thought in ${chat.where}`);
        });
    }

    it('from Message requests', async () => {
        await show({ open: null, home: nonce });
        fireEvent.click(await screen.findByTestId('message-requests-row'));
        expect(await screen.findByTestId('message-requests')).toBeInTheDocument();
        await chooseChatInTheMenu();
        await onTheList('message requests');
        // The list on All, as the requests' own Back leaves it.
        expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('from New DM', async () => {
        await show({ open: null, home: nonce });
        fireEvent.click(await screen.findByRole('button', { name: /New DM/ }));
        await waitFor(() => expect(screen.queryByTestId('conversation-filter-chips')).toBeNull());
        await chooseChatInTheMenu();
        await onTheList('new DM');
    });

    it('on the chat list: it stays, with the filter chip the member picked', async () => {
        await show({ open: null, home: nonce });
        fireEvent.click(await screen.findByRole('button', { name: 'Direct' }));
        await chooseChatInTheMenu();
        await onTheList('the list');
        expect(screen.getByRole('button', { name: 'Direct' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('a chat sent from is not kept as a draft; an edit under way is never kept as one', async () => {
        await show({ open: 'dm-kofi', home: nonce });
        await type('typed, then cleared');
        await type('');
        await chooseChatInTheMenu();
        await onTheList('cleared');
        await show({ open: 'dm-kofi', home: nonce });
        expect((await waitFor(box)).value).toBe('');
    });
});

describe('ways in that name a chat still open it', () => {
    it('a deep link (openConversationId) opens its chat, after Chat was chosen in the menu too', async () => {
        await show({ open: null, home: 0 });
        await show({ open: null, home: 1 });
        await show({ open: 'dm-kofi', home: 1 });
        expect(await screen.findByTestId('chat-back')).toBeInTheDocument();
    });

    it('a chat still being found when the member chose Chat does not open over the list', async () => {
        await act(async () => { view = render(draw({ open: null, home: 0 })); });
        await screen.findByTestId('conversation-filter-chips');
        // The way in and Chat in the menu in one go: the way in's reads finish after the member's choice.
        view!.rerender(draw({ open: 'dm-kofi', home: 0 }));
        view!.rerender(draw({ open: 'dm-kofi', home: 1 }));
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        await onTheList('found late');
    });
});

describe('the back arrow', () => {
    it('is its own 44 x 44 target named "Back to chats", and keeps the draft', async () => {
        await show({ open: 'dm-kofi', home: 0 });
        await type('back soon');
        const back = await screen.findByTestId('chat-back');
        expect(back).toHaveAccessibleName('Back to chats');
        expect(back.tagName).toBe('BUTTON');
        expect(back.style.width).toBe('44px');
        expect(back.style.height).toBe('44px');
        expect(back.style.minWidth).toBe('44px');
        expect(back.style.minHeight).toBe('44px');
        fireEvent.click(back);
        await onTheList('back');
        await show({ open: null, home: 0 });
        await show({ open: 'dm-kofi', home: 0 });
        expect((await waitFor(box)).value).toBe('back soon');
    });

    it('an event chat\'s is named "Back to chats" and at least 44 px wide', async () => {
        await show({ open: EVENT_ID, home: 0 });
        const back = await screen.findByTestId('chat-back');
        expect(back).toHaveAccessibleName('Back to chats');
        expect(back.className).toMatch(/min-w-\[44px\]/);
        expect(back.className).toMatch(/min-h-\[48px\]/);
    });
});
