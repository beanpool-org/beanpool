import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getConversationMessages, sendMessageApi, getConversations, getGroupChat, type Conversation, type ApiMessage } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { resetPendingChatLinesForTest } from '../lib/pending-chat-lines';

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

let syncListeners: Array<() => void | Promise<void>> = [];
vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn((cb: () => void | Promise<void>) => {
        syncListeners.push(cb);
        return () => {
            syncListeners = syncListeners.filter(l => l !== cb);
        };
    }),
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

let currentGeneratedId = 'msg-opt-1';
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
        signDmLine: () => ({ sig: 'sig', at: '2026-11-01T00:00:00.000Z' }),
        openDmLine: (p: { ciphertext: string }) => ({ text: p.ciphertext, format: 3, after: null, conversationId: '', moved: false }),
        checkDmThread: () => new Map(),
        dmAfterReference: actual.dmAfterReference,
        isEncryptedNonce: actual.isEncryptedNonce,
        dmLineMarkText: () => null,
        newDmMessageId: () => currentGeneratedId,
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

beforeEach(() => {
    window.alert = vi.fn();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    resetPendingChatLinesForTest();
    vi.clearAllMocks();
    syncListeners = [];
    currentGeneratedId = 'msg-opt-1';

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
    vi.unstubAllGlobals();
});

/** The composer is up a beat before the chat's opening clears the draft: words typed in that beat are wiped, and no line goes. */
async function composerOpen() {
    const composer = await screen.findByPlaceholderText('Message...');
    await act(async () => {});
    return composer;
}

describe('Web instant chat message sending (optimistic)', () => {
    it('the line shows before the send resolves, marked as sending with no false success', async () => {
        let resolveSend!: (value: any) => void;
        const sendPromise = new Promise(resolve => { resolveSend = resolve; });
        vi.mocked(sendMessageApi).mockReturnValue(sendPromise as any);

        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);

        const composer = await composerOpen();
        fireEvent.change(composer, { target: { value: 'Instant optimistic line' } });
        fireEvent.keyDown(composer, { key: 'Enter' });

        // 1. Line appears IMMEDIATELY before send resolves
        expect(screen.getByText('Instant optimistic line')).toBeInTheDocument();

        // 2. Marked as sending (clock ◷), never a false success tick
        const sendingMark = screen.getByTestId('chat-line-sending');
        expect(sendingMark).toBeInTheDocument();
        expect(sendingMark.textContent).toContain('◷');
        expect(screen.queryByLabelText('Sent')).toBeNull();

        // 3. Resolve the server send
        mockMessagesByConv['conv-dm-1'] = [{
            id: 'msg-opt-1',
            conversationId: 'conv-dm-1',
            authorPubkey: 'my-pubkey',
            ciphertext: 'Instant optimistic line',
            nonce: '00000',
            type: 'text',
            timestamp: new Date().toISOString(),
        }];

        await act(async () => {
            resolveSend({ success: true, message: mockMessagesByConv['conv-dm-1'][0] });
        });

        // 4. Once confirmed by the server, sending mark is gone and confirmed tick shows
        await waitFor(() => {
            expect(screen.queryByTestId('chat-line-sending')).toBeNull();
        });
        expect(screen.getByLabelText('Sent')).toBeInTheDocument();
    });

    it('no duplicate on socket echo or refresh delivers it', async () => {
        let resolveSend!: (value: any) => void;
        const sendPromise = new Promise(resolve => { resolveSend = resolve; });
        vi.mocked(sendMessageApi).mockReturnValue(sendPromise as any);

        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);

        const composer = await composerOpen();
        fireEvent.change(composer, { target: { value: 'No duplicate message' } });
        fireEvent.keyDown(composer, { key: 'Enter' });

        expect(screen.getByText('No duplicate message')).toBeInTheDocument();
        expect(screen.getAllByText('No duplicate message')).toHaveLength(1);

        // Socket delivers the message with the same id while send is still resolving
        mockMessagesByConv['conv-dm-1'] = [{
            id: 'msg-opt-1',
            conversationId: 'conv-dm-1',
            authorPubkey: 'my-pubkey',
            ciphertext: 'No duplicate message',
            nonce: '00000',
            type: 'text',
            timestamp: new Date().toISOString(),
        }];

        // Trigger sync activity (socket echo / poll)
        for (const cb of syncListeners) {
            await act(async () => { await cb(); });
        }

        // Must still be exactly ONE line in the thread, not duplicated
        expect(screen.getAllByText('No duplicate message')).toHaveLength(1);

        // Now resolve send
        await act(async () => {
            resolveSend({ success: true, message: mockMessagesByConv['conv-dm-1'][0] });
        });
        expect(screen.getAllByText('No duplicate message')).toHaveLength(1);
    });

    it('a failure with no answer keeps the words on the line, says plainly ! not delivered, and can be retried', async () => {
        let rejectSend!: (err: any) => void;
        const sendPromise = new Promise((_, reject) => { rejectSend = reject; });
        sendPromise.catch(() => {});
        vi.mocked(sendMessageApi).mockReturnValue(sendPromise as any);

        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);

        const composer = await composerOpen() as HTMLTextAreaElement;
        fireEvent.change(composer, { target: { value: 'Important unsent words' } });
        fireEvent.keyDown(composer, { key: 'Enter' });

        // Line is visible immediately
        expect(screen.getByText('Important unsent words')).toBeInTheDocument();

        // Reject send with network failure
        await act(async () => {
            rejectSend(new Error('Connection lost'));
        });

        // 1. Line stays in the thread
        expect(screen.getByText('Important unsent words')).toBeInTheDocument();

        // 2. Says plainly "! not delivered"
        const failedMark = await screen.findByTestId('chat-line-failed');
        expect(failedMark).toBeInTheDocument();
        expect(failedMark.textContent).toContain('! not delivered');

        // 3. Offers retry
        const retryBtn = screen.getByTestId('chat-line-retry');
        expect(retryBtn).toBeInTheDocument();

        // 4. The words stay on the line, not in the composer: the node may have this line, and a copy sent from the composer
        // would go under a new id and reach the other person twice. Its Retry reuses the id.
        expect(composer.value).toBe('');

        // 5. Retrying attempts to send again
        vi.mocked(sendMessageApi).mockResolvedValueOnce({
            success: true,
            message: {
                id: 'msg-opt-1',
                conversationId: 'conv-dm-1',
                authorPubkey: 'my-pubkey',
                ciphertext: 'Important unsent words',
                nonce: '00000',
                type: 'text',
                timestamp: new Date().toISOString(),
            },
        } as any);

        await act(async () => {
            fireEvent.click(retryBtn);
        });

        // Sending indicator returns during retry and sendMessageApi is called again
        await waitFor(() => {
            expect(sendMessageApi).toHaveBeenCalledTimes(2);
        });

        // 6. And it went under the same id
        const calls = vi.mocked(sendMessageApi).mock.calls;
        expect(calls[1][7]).toBe(calls[0][7]);
    });

    it('the message order stays right, and two quick sends do not swap', async () => {
        let resolveFirst!: (value: any) => void;
        let resolveSecond!: (value: any) => void;
        const firstPromise = new Promise(resolve => { resolveFirst = resolve; });
        const secondPromise = new Promise(resolve => { resolveSecond = resolve; });

        let sendCallCount = 0;
        vi.mocked(sendMessageApi).mockImplementation(async () => {
            sendCallCount++;
            if (sendCallCount === 1) return firstPromise as any;
            return secondPromise as any;
        });

        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);
        const composer = await composerOpen();

        // First send
        currentGeneratedId = 'msg-first';
        fireEvent.change(composer, { target: { value: 'First line' } });
        fireEvent.keyDown(composer, { key: 'Enter' });

        // Second send immediately after
        currentGeneratedId = 'msg-second';
        fireEvent.change(composer, { target: { value: 'Second line' } });
        fireEvent.keyDown(composer, { key: 'Enter' });

        // Check both lines appear in the DOM
        // Find, not get: a line comes through the pending store a tick after the key. Neither send has been answered yet.
        const thread = screen.getByTestId('chat-thread');
        const firstEl = await screen.findByText('First line');
        const secondEl = await screen.findByText('Second line');

        expect(firstEl).toBeInTheDocument();
        expect(secondEl).toBeInTheDocument();

        // Verify order: First line comes before Second line
        expect(firstEl.compareDocumentPosition(secondEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // Resolve both
        await act(async () => {
            resolveFirst({ success: true, message: { id: 'msg-first' } });
            resolveSecond({ success: true, message: { id: 'msg-second' } });
        });
    });

    it('in a sealed group chat, the line shows immediately and after binds to the line before it once the node has taken it, never to one still pending', async () => {
        mockConversations = [
            {
                id: 'conv-group-1',
                type: 'group_thread',
                name: 'Community Garden',
                createdBy: 'my-pubkey',
                participants: ['my-pubkey', 'peer-pubkey'],
                createdAt: '2026-11-01T00:00:00Z',
                unreadCount: 0,
            },
        ];
        mockMessagesByConv = {
            'conv-group-1': [
                {
                    id: 'msg-server-confirmed',
                    conversationId: 'conv-group-1',
                    authorPubkey: 'peer-pubkey',
                    ciphertext: 'Existing confirmed line',
                    nonce: '00000',
                    type: 'text',
                    timestamp: '2026-11-01T00:00:00Z',
                },
            ],
        };

        vi.mocked(getGroupChat).mockImplementation(async (groupId: string) => ({
            id: groupId,
            conversation: mockConversations.find(c => c.id === groupId)!,
            messages: mockMessagesByConv[groupId] || [],
            canPost: true,
            encryption: { current: 1, stale: [], fromEpoch: 1 } as any,
        }));

        let resolveFirstGroupSend!: () => void;
        const firstSendPromise = new Promise<void>(resolve => { resolveFirstGroupSend = resolve; });
        mockSendSealedGroupLine.mockReturnValueOnce(firstSendPromise as any);

        render(<MessagesPage identity={mockIdentity} openConversationId="conv-group-1" />);

        await screen.findByText('Community Garden');
        await screen.findByText(/End-to-end encrypted/i);
        const composer = await composerOpen();

        // 1. Send first line
        currentGeneratedId = 'group-pending-1';
        fireEvent.change(composer, { target: { value: 'Optimistic group line 1' } });
        fireEvent.keyDown(composer, { key: 'Enter' });

        // Appears immediately in thread
        expect(screen.getByText('Optimistic group line 1')).toBeInTheDocument();

        // sendSealedGroupLine was called with after: 'msg-server-confirmed' (NOT 'group-pending-1')
        await waitFor(() => {
            expect(mockSendSealedGroupLine).toHaveBeenCalledTimes(1);
        });
        expect(mockSendSealedGroupLine).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                clientId: 'group-pending-1',
                text: 'Optimistic group line 1',
                after: 'msg-server-confirmed',
            }),
        );
        const firstCall = mockSendSealedGroupLine.mock.calls[0] as any[];
        expect(firstCall[3]?.after).not.toBe('group-pending-1');

        // 2. Send second line while first send is still pending
        currentGeneratedId = 'group-pending-2';
        fireEvent.change(composer, { target: { value: 'Optimistic group line 2' } });
        fireEvent.keyDown(composer, { key: 'Enter' });

        expect(screen.getByText('Optimistic group line 2')).toBeInTheDocument();

        // Resolve first send
        await act(async () => {
            resolveFirstGroupSend();
        });

        // Line 2 goes once line 1 is taken, so it is written after line 1: never after a line still pending, which it can't be
        // here (it waits its turn), and never after 'msg-server-confirmed' as well, which would let a node swap the two.
        await waitFor(() => {
            expect(mockSendSealedGroupLine).toHaveBeenCalledTimes(2);
        });
        expect(mockSendSealedGroupLine).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                clientId: 'group-pending-2',
                text: 'Optimistic group line 2',
                after: 'group-pending-1',
            }),
        );
        const secondCall = mockSendSealedGroupLine.mock.calls[1] as any[];
        expect(secondCall[3]?.after).not.toBe('group-pending-2');
    });

    it('in a DM, a line still pending shows, and is sent once', async () => {
        mockMessagesByConv['conv-dm-1'] = [
            {
                id: 'dm-server-1',
                conversationId: 'conv-dm-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Server DM line',
                nonce: 'x25519-xc20p-v2:validnonce1',
                type: 'text',
                timestamp: '2026-11-01T00:00:00Z',
            },
        ];

        let resolveSend!: (val: any) => void;
        const sendPromise = new Promise(resolve => { resolveSend = resolve; });
        vi.mocked(sendMessageApi).mockReturnValue(sendPromise as any);

        render(<MessagesPage identity={mockIdentity} openConversationId="conv-dm-1" />);

        const composer = await composerOpen();
        currentGeneratedId = 'dm-pending-1';
        fireEvent.change(composer, { target: { value: 'DM line 1' } });
        fireEvent.keyDown(composer, { key: 'Enter' });

        expect(screen.getByText('DM line 1')).toBeInTheDocument();

        await waitFor(() => {
            expect(sendMessageApi).toHaveBeenCalledTimes(1);
        });
        await act(async () => {
            resolveSend({ success: true, message: { id: 'dm-pending-1' } });
        });
    });
});
