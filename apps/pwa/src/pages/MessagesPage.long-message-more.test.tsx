/**
 * A long message folds with "…more" in a web one-to-one chat (components/FoldedChatText.tsx, drawn by MessagesPage), sent and
 * received: a 40-line message folds, opens in place and folds again; a 3-line one never shows the control; the one being edited
 * is never folded. The group chat's half is MessagesPage.long-message-more-group.test.tsx.
 */
import { render, screen, act, cleanup, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage } from '../lib/api';
import { lockForDm } from '../lib/dm-lock';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';
import { installFoldLayout, removeFoldLayout } from '../chat-fold-layout.test-support';

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
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));

const thread = vi.hoisted(() => ({ conversation: null as any, messages: [] as any[] }));
vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [thread.conversation], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: thread.conversation, messages: thread.messages })),
    getGroupChat: vi.fn(),
    getGroupMembers: vi.fn(async () => []),
    groupKeysNet: {
        get: async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
        post: async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    },
    getMembers: vi.fn(async () => []),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    deleteMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
}));

function person(name: string) {
    const seed = ed25519.utils.randomSecretKey();
    return { name, seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)) };
}

const ana = person('Ana');
const ben = person('Ben');
const CONV = 'c0ffee00-2222-4222-8333-444455556666';
const chat = { id: CONV, type: 'dm', participants: [ana.publicKey, ben.publicKey] };

let minute = 0;
let last: string | null = null;

/** The next line of the thread, sent a few minutes ago (so its author can still edit it). */
function sent(from: typeof ana, text: string): ApiMessage {
    const id = crypto.randomUUID();
    const sealed = lockForDm(text, chat, from, { messageId: id, after: last });
    last = id;
    return {
        id, conversationId: CONV, authorPubkey: from.publicKey, ...sealed, timestamp: new Date(Date.now() - 5 * 60_000 + 1000 * minute++).toISOString(),
    } as ApiMessage;
}

const anaIdentity: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };

const fortyLines = (name: string) => Array.from({ length: 40 }, (_, i) => `${name} line ${i + 1} of the list`).join('\n');
const threeLines = 'First thing\nSecond thing\nThird thing';

async function openChat(): Promise<void> {
    render(<MessagesPage identity={anaIdentity} openConversationId={CONV} />);
    await screen.findByPlaceholderText('Message...');
    await act(async () => {});
}

/** One message's row, found by a word in it. */
const rowWith = (word: string) => screen.getAllByTestId('chat-text').map((e) => e.closest('[id^="msg-"]') as HTMLElement).find((r) => r.textContent?.includes(word));

beforeEach(() => {
    minute = 0;
    last = null;
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    installFoldLayout();
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    thread.conversation = {
        id: CONV, type: 'dm', name: null, participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey,
        peerCallsign: 'Ben', unreadCount: 0, createdAt: '2026-09-01T00:00:00Z',
    } as Conversation;
    thread.messages = [];
});

afterEach(() => {
    cleanup();
    removeFoldLayout();
});

describe('a web one-to-one chat folds a long message with …more', () => {
    it("Ben's 40-line message folds under …more, opens in place, and folds again; a 3-line one never shows the control", async () => {
        thread.messages = [sent(ben, fortyLines('Ben')), sent(ben, threeLines)];
        await openChat();

        const long = rowWith('Ben line 1 of')!;
        const folded = within(long).getByTestId('chat-text');
        expect(folded.dataset.fold).toBe('folded');
        const more = within(long).getByRole('button', { name: 'Show the whole message' });
        expect(more.textContent).toBe('…more');

        // The 3-line message beside it is drawn as it always was.
        expect(screen.getByText(/First thing/).closest('[id^="msg-"]')!.querySelector('[data-testid="chat-fold-toggle"]')).toBeNull();
        expect(screen.getAllByTestId('chat-fold-toggle')).toHaveLength(1);

        fireEvent.click(more);
        expect(within(long).getByTestId('chat-text').dataset.fold).toBe('open');
        expect(within(long).getByRole('button', { name: 'Show less' }).textContent).toBe('less');
        // All of it is there to read, copy and search once opened — and before.
        expect(within(long).getByTestId('chat-text').textContent).toBe(fortyLines('Ben'));

        fireEvent.click(within(long).getByRole('button', { name: 'Show less' }));
        expect(within(long).getByTestId('chat-text').dataset.fold).toBe('folded');
        expect(within(long).getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
    });

    it('folds my own long message too, and keeps its Edit and Delete beside it', async () => {
        thread.messages = [sent(ana, fortyLines('Ana'))];
        await openChat();
        const mine = rowWith('Ana line 1 of')!;
        expect(within(mine).getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
        expect(within(mine).getByRole('button', { name: 'Edit message' })).toBeTruthy();
        expect(within(mine).getByRole('button', { name: 'Delete message' })).toBeTruthy();
    });

    it('never folds the message being edited, and folds it again when the edit is cancelled', async () => {
        thread.messages = [sent(ana, fortyLines('Ana')), sent(ben, fortyLines('Ben'))];
        await openChat();
        const mine = rowWith('Ana line 1 of')!;
        expect(within(mine).getByTestId('chat-text').dataset.fold).toBe('folded');

        await act(async () => { fireEvent.click(within(mine).getByRole('button', { name: 'Edit message' })); });
        expect(screen.getByPlaceholderText('Edit message...')).toBeTruthy();
        // Whole: no clamp, no control, all forty lines in the bubble.
        expect(within(mine).queryByTestId('chat-text')).toBeNull();
        expect(within(mine).queryByRole('button', { name: /whole message|Show less/ })).toBeNull();
        expect(mine.textContent).toContain('Ana line 40 of the list');
        // The other long message is still folded.
        expect(within(rowWith('Ben line 1 of')!).getByTestId('chat-text').dataset.fold).toBe('folded');

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' })); });
        expect(within(rowWith('Ana line 1 of')!).getByTestId('chat-text').dataset.fold).toBe('folded');
    });

    it('a deleted long message is the app\'s words, never folded', async () => {
        const gone = sent(ben, fortyLines('Ben'));
        gone.type = 'removed';
        gone.metadata = JSON.stringify({ removed: true, removedBy: ben.publicKey });
        thread.messages = [gone];
        await openChat();
        await screen.findByText('This message was deleted');
        expect(screen.queryByTestId('chat-fold-toggle')).toBeNull();
    });
});
