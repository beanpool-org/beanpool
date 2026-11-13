/**
 * The web chat composer grows with its words (fix/web-composer-grow). Marty, 14 Nov 2026, on a web DM:
 * "a little vertical bar showing? what is this?" It was a scrollbar: the box sat at a fixed 40px, a pixel
 * short of its own one line, so even an empty box scrolled.
 *
 * Now: one line tall when empty, a line taller for each line of words up to five, a scrollbar only past
 * five, and back to one line after a send. One composer serves a DM, a request and a group chat.
 * jsdom lays nothing out, so composer-grow.test-support.ts gives the textarea a browser's arithmetic.
 */
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { sendMessageApi, getGroupChat, type Conversation, type ApiMessage } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { resetPendingChatLinesForTest } from '../lib/pending-chat-lines';
import { installTextareaGeometry, showsScrollbar, hidesWords, heightOf } from '../composer-grow.test-support';

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
    socketIsAlive: vi.fn(() => true),
}));

vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/archetypes', () => ({
    consumeChatPrefill: vi.fn(() => null),
}));

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

const { mockSendSealedGroupLine } = vi.hoisted(() => ({
    mockSendSealedGroupLine: vi.fn(async (..._args: any[]) => {}),
}));
vi.mock('../lib/group-chat-lines', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/group-chat-lines')>();
    return {
        ...actual,
        sendSealedGroupLine: mockSendSealedGroupLine,
    };
});

vi.mock('../lib/e2e-crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/e2e-crypto')>();
    return {
        ...actual,
        dmThreadInShownOrder: (msgs: any[]) => msgs,
        dmQuoteFrom: () => 'author',
        dmQuoteLabel: () => 'You',
        dmLineShownText: (v: any) => v?.text ?? '',
        dmLineIsUnattributed: () => false,
        dmReplyToOf: () => null,
        decodePlaintext: (c: string) => c,
        encodePlaintext: (text: string) => ({ ciphertext: text, nonce: '00000' }),
        sealDmLine: (text: string) => ({ ciphertext: text, nonce: '00000' }),
        openDmLine: (p: { ciphertext: string }) => ({ text: p.ciphertext, format: 4, after: null, conversationId: '', moved: false }),
        checkDmThread: () => new Map(),
        dmAfterReference: actual.dmAfterReference,
        isEncryptedNonce: actual.isEncryptedNonce,
        dmLineMarkText: () => null,
        newDmMessageId: () => 'msg-grow-1',
        DM_LINE_NOT_VERIFIED_TEXT: "🔒 This message couldn't be verified, so it isn't shown.",
    };
});

let mockConversations: Conversation[] = [];
let mockMessagesByConv: Record<string, ApiMessage[]> = {};

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({
        conversations: mockConversations,
        totalUnread: 0,
    })),
    getConversationMessages: vi.fn(async (convId: string) => ({
        conversation: mockConversations.find(c => c.id === convId) || {
            id: convId,
            type: 'dm',
            participants: ['my-pubkey', 'peer-pubkey'],
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-01T00:00:00Z',
        },
        messages: mockMessagesByConv[convId] || [],
    })),
    getMembers: vi.fn(async () => [
        { publicKey: 'peer-pubkey', callsign: 'Bob', role: 'member' },
    ]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async (groupId: string) => ({
        id: groupId,
        conversation: mockConversations.find(c => c.id === groupId),
        messages: mockMessagesByConv[groupId] || [],
        canPost: true,
    })),
    getGroupMembers: vi.fn(async () => []),
    createGroup: vi.fn(),
    groupKeysNet: { get: vi.fn(async () => new Response('{}', { status: 404 })), post: vi.fn(async () => new Response('{}', { status: 404 })) },
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'my-pubkey',
    privateKey: 'my-privkey',
    callsign: 'Alice',
    createdAt: '2026-11-01T00:00:00Z',
};

let undoGeometry: () => void = () => {};

beforeEach(() => {
    window.alert = vi.fn();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    resetPendingChatLinesForTest();
    vi.clearAllMocks();
    undoGeometry = installTextareaGeometry();
    mockConversations = [
        {
            id: 'conv-dm-1',
            type: 'dm',
            name: null,
            createdBy: 'my-pubkey',
            participants: ['my-pubkey', 'peer-pubkey'],
            peerCallsign: 'Bob',
            createdAt: '2026-11-01T00:00:00Z',
            unreadCount: 0,
        },
    ];
    mockMessagesByConv = { 'conv-dm-1': [] };
});

afterEach(() => {
    undoGeometry();
    vi.unstubAllGlobals();
});

/** The composer is up a beat before the chat's opening clears the draft: words typed in that beat are wiped, and no line goes. */
async function composerOpen() {
    const composer = await screen.findByPlaceholderText('Message...');
    await act(async () => {});
    return composer as HTMLTextAreaElement;
}

function type(composer: HTMLTextAreaElement, words: string) {
    fireEvent.change(composer, { target: { value: words } });
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('Web chat composer: grows with its words, no scrollbar until five lines', () => {
    it('opening a DM: the empty box shows no scrollbar and cuts nothing off', async () => {
        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);
        const composer = await composerOpen();

        expect(composer.value).toBe('');
        expect(showsScrollbar(composer)).toBe(false);
        expect(hidesWords(composer)).toBe(false);
    });

    it('one line is the same height as the empty box: nothing jumps on the first letter', async () => {
        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);
        const composer = await composerOpen();
        const empty = heightOf(composer);
        expect(empty).toBeGreaterThan(0);

        type(composer, 'Hello there');
        expect(heightOf(composer)).toBe(empty);
        expect(showsScrollbar(composer)).toBe(false);
        expect(hidesWords(composer)).toBe(false);
    });

    it('each new line makes the box a line taller up to five; the sixth scrolls, and only then is there a scrollbar', async () => {
        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);
        const composer = await composerOpen();
        const heights: number[] = [];
        for (let n = 1; n <= 6; n++) {
            type(composer, lines(n));
            heights.push(heightOf(composer));
            expect(hidesWords(composer)).toBe(false);
            expect(showsScrollbar(composer)).toBe(n === 6);
        }
        for (let n = 1; n < 5; n++) expect(heights[n]).toBeGreaterThan(heights[n - 1]);
        // Five lines is the cap: a sixth line scrolls inside the same height.
        expect(heights[5]).toBe(heights[4]);
    });

    it('after a send the box is one line again, with no scrollbar', async () => {
        vi.mocked(sendMessageApi).mockReturnValue(new Promise(() => {}) as any);
        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);
        const composer = await composerOpen();
        const empty = heightOf(composer);

        type(composer, lines(6));
        expect(heightOf(composer)).toBeGreaterThan(empty);
        fireEvent.keyDown(composer, { key: 'Enter' });

        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        expect(composer.value).toBe('');
        expect(heightOf(composer)).toBe(empty);
        expect(showsScrollbar(composer)).toBe(false);
    });

    it('the keys are as before: Shift+Enter is a new line and sends nothing; a word being composed is never sent', async () => {
        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);
        const composer = await composerOpen();
        type(composer, 'first line');
        fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
        fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
        fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 });
        await act(async () => {});
        expect(sendMessageApi).not.toHaveBeenCalled();
        expect(composer.value).toBe('first line');
    });

    it('a group chat uses the same box: empty with no scrollbar, growing a line at a time', async () => {
        mockConversations = [{
            id: 'conv-group-1',
            type: 'group_thread',
            name: 'Community Garden',
            createdBy: 'my-pubkey',
            participants: ['my-pubkey', 'peer-pubkey'],
            createdAt: '2026-11-01T00:00:00Z',
            unreadCount: 0,
        }];
        mockMessagesByConv = { 'conv-group-1': [] };
        vi.mocked(getGroupChat).mockImplementation(async (groupId: string) => ({
            id: groupId,
            conversation: mockConversations.find(c => c.id === groupId)!,
            messages: mockMessagesByConv[groupId] || [],
            canPost: true,
            encryption: { current: 1, stale: [], fromEpoch: 1 } as any,
        }));
        render(<MessagesPage identity={mockIdentity} openConversationId="conv-group-1" />);
        await screen.findByText('Community Garden');
        const composer = await composerOpen();
        const empty = heightOf(composer);

        expect(showsScrollbar(composer)).toBe(false);
        expect(hidesWords(composer)).toBe(false);
        type(composer, lines(3));
        expect(heightOf(composer)).toBeGreaterThan(empty);
        expect(showsScrollbar(composer)).toBe(false);
        expect(hidesWords(composer)).toBe(false);
    });
});
