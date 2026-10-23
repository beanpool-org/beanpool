/**
 * Talk on the web in the member's language (words S3, web sweep W1), as the phone's chats tab and chat screen: in the
 * pseudo-locale every word the page itself writes came through t(), a trade's lines in the phone's keys
 * (utils/chat-line-words.ts) included, and the times and dates are core's. What members wrote is shown as written:
 * names, messages, a group's and a listing's title.
 *
 * A group chat's notice and the other sentences the group chat's and the DMs' key code writes (lib/group-chat-lines.ts and
 * its neighbours) are translated by their English in lib/chat-line-words.ts, as the phone's utils/chat-line-words.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getFriends, getMemberCards, type ApiMessage, type Conversation, type MarketplaceTransaction } from '../lib/api';
import { isUserBlocked } from '../lib/blocklist';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { groupChatNotice } from '../lib/group-chat-lines';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';
import { chooseAndShowLanguage } from '../lib/language';
import { useLanguage } from '../lib/useLanguage';
import { formatDate } from '@beanpool/core';
import ruWords from '../../words/ru.json';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../lib/e2e-crypto', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/e2e-crypto')>();
    return {
        ...real,
        decodePlaintext: vi.fn((c: string) => c),
        openDmLine: vi.fn((p: { ciphertext: string }) => ({ text: p.ciphertext, format: 3, after: null, conversationId: '', moved: false })),
        checkDmThread: vi.fn(() => new Map()),
        isEncryptedNonce: vi.fn(() => false),
    };
});
// The community's info: a directory read whole ({}), or people asked for by name (membersOnDemand).
const info = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => info.value) }));

const state = vi.hoisted(() => ({ conversations: [] as unknown[], messages: {} as Record<string, unknown[]>, txs: [] as unknown[] }));
vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getConversations: vi.fn(async () => ({ conversations: state.conversations, totalUnread: 0 })),
    getConversationMessages: vi.fn(async (id: string) => ({
        conversation: (state.conversations as Conversation[]).find(c => c.id === id), messages: state.messages[id] || [],
    })),
    getGroupChat: vi.fn(async (id: string) => ({
        conversation: (state.conversations as Conversation[]).find(c => c.id === id), messages: state.messages[id] || [], canPost: true,
    })),
    getGroupMembers: vi.fn(async () => []),
    groupKeysNet: { get: vi.fn(async () => new Response('{}', { status: 404 })), post: vi.fn(async () => new Response('{}', { status: 404 })) },
    getMembers: vi.fn(async () => [
        { publicKey: 'peer-pubkey', callsign: 'Bob', avatarUrl: 'https://example.test/bob.png', role: 'member' },
        { publicKey: 'other-pubkey', callsign: 'Charlie', avatarUrl: 'https://example.test/charlie.png', role: 'member' },
    ]),
    getMemberCards: vi.fn(async () => []),
    getFriends: vi.fn(async () => []),
    getMyMarketplaceTransactions: vi.fn(async () => state.txs),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(), editMessageApi: vi.fn(), toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
    createGroup: vi.fn(),
}));

const me: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'my-privkey', callsign: 'Alice', createdAt: '2026-09-14T00:00:00Z' };
const GROUP_ID = 'group-1';

const bobDm: Conversation = {
    id: 'conv-1', type: 'dm', name: null, participants: ['my-pubkey', 'peer-pubkey'], createdBy: 'my-pubkey',
    peerCallsign: 'Bob', peerAvatar: 'https://example.test/bob.png', unreadCount: 0, createdAt: '2026-10-14T09:00:00Z',
    peerLastReadAt: '2000-01-01T00:00:00Z',
} as Conversation;
const tradeChat: Conversation = {
    id: 'conv-2', type: 'dm', name: null, participants: ['my-pubkey', 'other-pubkey'], createdBy: 'my-pubkey',
    peerCallsign: 'Charlie', peerAvatar: 'https://example.test/charlie.png', unreadCount: 2, createdAt: '2026-10-15T09:00:00Z',
    postId: 'post-2', postTitle: 'Sourdough loaf', postStatus: 'pending',
} as Conversation;
const garden: Conversation = {
    id: GROUP_ID, type: 'group_thread' as Conversation['type'], name: 'Garden crew', participants: ['my-pubkey', 'peer-pubkey', 'other-pubkey'],
    createdBy: 'my-pubkey', unreadCount: 0, createdAt: '2026-10-13T09:00:00Z',
} as Conversation;

const trade = (id: string, status: string, credits: number, rated: boolean): MarketplaceTransaction => ({
    id, postId: `post-${id}`, postTitle: 'Ladder', buyerPublicKey: 'my-pubkey', buyerCallsign: 'Alice', sellerPublicKey: 'peer-pubkey',
    sellerCallsign: 'Bob', credits, status, createdAt: '2026-10-14T00:00:00Z', completedAt: status === 'completed' ? '2026-10-14T00:00:00Z' : null,
    ratedByBuyer: rated, ratedBySeller: false,
} as MarketplaceTransaction);
const FINISHED = trade('tx-done', 'completed', 5, false);
const HELD = trade('tx-held', 'pending', 3, false);

const NOW = new Date().toISOString();
const line = (id: string, author: string, text: string, over: Partial<ApiMessage> = {}): ApiMessage => ({
    id, conversationId: 'conv-1', authorPubkey: author, ciphertext: text, nonce: '00000', type: 'text', timestamp: NOW, metadata: null, ...over,
} as ApiMessage);
const BOB_LINES: ApiMessage[] = [
    line('m1', 'peer-pubkey', 'Is the ladder still free?', {
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        metadata: JSON.stringify({ reactions: [{ emoji: '👍', author: 'my-pubkey' }, { emoji: '❤️', author: 'peer-pubkey' }] }),
    }),
    line('m2', 'my-pubkey', 'Yes, come by Saturday', { metadata: JSON.stringify({ replyToId: 'm1' }), editedAt: NOW }),
    line('m3', 'SYSTEM', '', { type: 'system', systemType: 'ESCROW_FUNDED' as ApiMessage['systemType'], metadata: JSON.stringify({ amount: 5, postId: 'post-tx-done' }) }),
    line('m4', 'SYSTEM', '', {
        type: 'system', systemType: 'ESCROW_RELEASED' as ApiMessage['systemType'],
        metadata: JSON.stringify({ amount: 5, postId: 'post-tx-done', transactionId: 'tx-done', sellerPubkey: 'peer-pubkey' }),
    }),
    line('m5', 'peer-pubkey', '', { type: 'image' }),
];

/** What members wrote: their names, their messages, a group's name and a listing's title. */
const OTHERS = ['Bob', 'Charlie', 'Garden crew', 'Sourdough loaf', 'Is the ladder still free?', 'Yes, come by Saturday', 'Seeds are in'];

let said: string[] = [];
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    localStorage.clear();
    info.value = {};
    state.conversations = [bobDm, tradeChat, garden];
    state.messages = { 'conv-1': BOB_LINES, 'conv-2': [], [GROUP_ID]: [line('g1', 'peer-pubkey', 'Seeds are in', { conversationId: GROUP_ID })] };
    state.txs = [FINISHED, HELD];
    said = [];
    vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { said.push(String(m)); return false; });
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
});
afterEach(() => { cleanup(); backToEnglish(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openChat(id: string) {
    render(<MessagesPage identity={me} openConversationId={id} />);
    const composer = await screen.findByPlaceholderText(xx('Message...'));
    await act(async () => {});
    return composer;
}

const picture = () => new File([new Uint8Array(1)], 'shot.png', { type: 'image/png' });
const clipboardWith = (file: File) => ({ files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }], types: ['Files'] });

describe('Talk on the web in the pseudo-locale', () => {
    it('the list: rows, a deal on its pill, the date, the review prompt; then no conversations at all', async () => {
        await showIn('xx');
        render(<MessagesPage identity={me} />);
        await screen.findByText(xx('Action Needed: Review Partner'));
        expect(screen.getByText(xx('HELD IN TRUST'))).toBeInTheDocument();
        expect(screen.getByText(xx('💬 Messages'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(8);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();

        state.conversations = [];
        render(<MessagesPage identity={me} />);
        await screen.findByText(xx('No conversations yet.'));
        expect(screen.getByText(xx('Start by sending a DM or creating a group.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it('a DM: lines, a trade\'s lines, the held deal, the confirms, a reaction, a reply, an edit and a pasted picture', async () => {
        await showIn('xx');
        const composer = await openChat('conv-1');
        await screen.findAllByText('Is the ladder still free?');
        await waitFor(() => expect(screen.getByTestId('dm-quote').textContent).toContain('Bob'));
        expect(document.body.textContent).toContain(xx('{n} Beans held in trust.').replace('{n}', '5'));
        expect(document.body.textContent).toContain(xx('Payment of {n} Beans released to the provider.').replace('{n}', '5'));
        expect(document.body.textContent).toContain(xx('🔒 Trust Hold: {n} Beans').replace('{n}', '3'));
        expect(screen.getByRole('button', { name: xx('Rate your partner') })).toBeInTheDocument();
        await screen.findByText(xx('🔒 Image unavailable'));
        expect(bracketed()).toBeGreaterThan(15);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        // The deal's two actions and Block ask first, in the member's language.
        fireEvent.click(screen.getByRole('button', { name: xx('✅ Release Credits') }));
        fireEvent.click(screen.getByRole('button', { name: xx('Cancel') }));
        fireEvent.click(screen.getByRole('button', { name: xx('Block user') }));
        expect(said).toEqual([
            xx('Release {n} Beans to the provider? This action is final.').replace('{n}', '3'),
            xx('Cancel this hold and refund the credits?'),
            xx('Block {name}?\n\nThis will hide their messages and posts, and notify moderation.').replace('{name}', 'Bob'),
        ]);

        fireEvent.click(screen.getAllByRole('button', { name: xx('React to message') })[0]);
        expect(screen.getByRole('button', { name: xx('React with {emoji}').replace('{emoji}', '😂') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);

        fireEvent.click(screen.getAllByRole('button', { name: xx('Reply to message') })[0]);
        expect(document.body.textContent).toContain(xx('Replying to {name}').replace('{name}', 'Bob'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: xx('Edit message') }));
        expect(screen.getByText(xx('Editing message'))).toBeInTheDocument();
        expect(composer).toHaveAttribute('placeholder', xx('Edit message...'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: xx('Cancel edit') }));

        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        const preview = await screen.findByTestId('chat-image-preview');
        expect(preview.textContent).toContain(xx('Send this picture?'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it('a DM with someone blocked: the notice and Unblock, and its confirm', async () => {
        await showIn('xx');
        vi.mocked(isUserBlocked).mockReturnValue(true);
        render(<MessagesPage identity={me} openConversationId="conv-1" />);
        const banner = await screen.findByText(xx('You have blocked this user. Messaging is disabled.'));
        fireEvent.click(within(banner.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: xx('Unblock') }));
        expect(said).toEqual([xx('Unblock {name}?').replace('{name}', 'Bob')]);
        expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);
    });

    it("a group's chat: its header, its notice (lib/chat-line-words.ts), search with no match, a picture refused", async () => {
        await showIn('xx');
        const composer = await openChat(GROUP_ID);
        await screen.findByText('Seeds are in');
        await waitFor(() => expect(screen.getByTestId('group-line-author').textContent).toBe('Bob'));
        expect(screen.getByText(xx('{n} members').replace('{n}', '3'))).toBeInTheDocument();
        const notice = groupChatNotice({ nodeSaysLocked: false, seenLocked: false, chatError: null });
        expect(screen.getByTestId('group-chat-notice')).toHaveTextContent(xx(notice));
        // The header's round face with no picture: the first letter of the group's name.
        const others = [...OTHERS, 'G'];
        expect(bypassing(document.body, { others })).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: xx('Search this chat') }));
        fireEvent.change(screen.getByPlaceholderText(xx('Search this chat')), { target: { value: 'zzz' } });
        expect(await screen.findByText(xx('No messages in this chat match.'))).toBeInTheDocument();

        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        expect(await screen.findByTestId('chat-image-notice')).toHaveTextContent(xx('Photos can only be sent in direct messages'));
        expect(screen.getByRole('button', { name: xx('Close search') })).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('New DM: the directory, then people asked for by name (a short search, none found, friends unread)', async () => {
        await showIn('xx');
        render(<MessagesPage identity={me} />);
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: xx('✉️ New DM') })); });
        await screen.findByText(xx('Choose someone to message:'));
        await screen.findByText('Charlie');
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();

        info.value = { profile: 'global', features: { membersOnDemand: true } };
        state.conversations = [];
        vi.mocked(getFriends).mockRejectedValue(new TypeError('Failed to fetch'));
        render(<MessagesPage identity={me} />);
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: xx('✉️ New DM') })); });
        expect(await screen.findByTestId('new-message-friends-failed')).toHaveTextContent(xx("Couldn't load your friends just now. Search for them by name above."));
        const box = screen.getByLabelText(xx('Find someone by name'));
        expect(box).toHaveAttribute('placeholder', xx('Type a name…'));
        fireEvent.change(box, { target: { value: 'z' } });
        expect(screen.getByTestId('new-message-search-status')).toHaveTextContent(xx('Type at least {n} letters of a name.').replace('{n}', '2'));
        fireEvent.change(box, { target: { value: 'zz' } });
        await waitFor(() => expect(vi.mocked(getMemberCards)).toHaveBeenCalled());
        expect(await screen.findByText(xx('Nobody here has a name starting with that.'))).toBeInTheDocument();
        expect(screen.getByText(xx('No one yet. Search for someone by name above.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });
});

describe('Talk on the web in English', () => {
    it('nothing is bracketed, and the words are as they were', async () => {
        render(<MessagesPage identity={me} />);
        const prompt = await screen.findByText('Action Needed: Review Partner');
        expect(prompt.textContent).toBe('⭐ Action Needed: Review Partner');
        expect(screen.getByText('HELD IN TRUST')).toBeInTheDocument();
        // The conversation's date from core's tables (was the browser's toLocaleDateString).
        expect(screen.getByText('14 Oct 2026')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
        cleanup();

        render(<MessagesPage identity={me} openConversationId="conv-1" />);
        await screen.findAllByText('Is the ladder still free?');
        expect(document.body.textContent).toContain('5 Beans held in trust.');
        expect(document.body.textContent).toContain('Payment of 5 Beans released to the provider.');
        expect(screen.getByText('🔒 Trust Hold: 3 Beans')).toBeInTheDocument();
        // The time under a bubble: core's 24-hour time of day (was the browser's toLocaleTimeString).
        const d = new Date(NOW);
        expect(document.body.textContent).toContain(`edited · ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
        fireEvent.click(screen.getByRole('button', { name: '✅ Release Credits' }));
        expect(said).toEqual(['Release 3 Beans to the provider? This action is final.']);
        expect(bracketed()).toBe(0);
    });
});

describe('Talk follows a language switch live (Settings → Language, the first screen\'s switch)', () => {
    // As App does: the root re-renders when the language changes (lib/useLanguage.ts).
    const Live = () => { useLanguage(); return <MessagesPage identity={me} />; };

    it('English → Russian → English on the open page: its words and dates follow, what members wrote stays', async () => {
        render(<Live />);
        await screen.findByText('Action Needed: Review Partner');
        expect(screen.getAllByText('3 members').length).toBeGreaterThan(0);
        expect(screen.getByText('14 Oct 2026')).toBeInTheDocument();

        await act(async () => { expect(await chooseAndShowLanguage('ru')).toBe(true); });
        const threeMembers = (ruWords as unknown as Record<string, Record<string, string>>)['{n} member|{n} members'].few.replace('{n}', '3');
        expect(threeMembers).not.toBe('3 members');
        expect(screen.getAllByText(threeMembers).length).toBeGreaterThan(0);
        expect(screen.queryByText('3 members')).toBeNull();
        // The row's date in Russian, from core's tables (the Russian date words came with the language).
        const russianDate = formatDate(new Date(bobDm.createdAt), 'day-month-year');
        expect(russianDate).not.toBe('14 Oct 2026');
        expect(screen.getByText(russianDate)).toBeInTheDocument();
        // The review prompt in Russian once it is drafted, else in English (never blank); members' words as they wrote them.
        const reviewPrompt = (ruWords as unknown as Record<string, unknown>)['Action Needed: Review Partner'];
        expect(screen.getByText(typeof reviewPrompt === 'string' ? reviewPrompt : 'Action Needed: Review Partner')).toBeInTheDocument();
        expect(screen.getByText('Garden crew')).toBeInTheDocument();
        expect(screen.getByText('Sourdough loaf')).toBeInTheDocument();

        await act(async () => { expect(await chooseAndShowLanguage('en')).toBe(true); });
        expect(screen.getAllByText('3 members').length).toBeGreaterThan(0);
        expect(screen.getByText('14 Oct 2026')).toBeInTheDocument();
        expect(screen.queryByText(threeMembers)).toBeNull();
    });
});
