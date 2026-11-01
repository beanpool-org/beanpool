import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { markConversationReadApi, type Conversation, type MarketplaceTransaction } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';

let mockTxs: MarketplaceTransaction[] = [];
if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

let syncListeners: Array<() => void> = [];
vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn((f: () => void) => { syncListeners.push(f); return () => { syncListeners = syncListeners.filter(l => l !== f); }; }),
    socketIsAlive: vi.fn(() => true),
}));
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

let mockConversations: Conversation[] = [];
vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: mockConversations, totalUnread: 0 })),
    getConversationMessages: vi.fn(async (convId: string) => ({
        conversation: mockConversations.find(c => c.id === convId), messages: [],
    })),
    getMembers: vi.fn(async () => [{ publicKey: 'peer-pubkey', callsign: 'Bob', role: 'member' }]),
    getMyMarketplaceTransactions: vi.fn(async () => mockTxs),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(), editMessageApi: vi.fn(), toggleMessageReactionApi: vi.fn(), getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(async () => ({})),
    cancelMarketplaceTransaction: vi.fn(async () => ({})),
    getGroupChat: vi.fn(), getGroupMembers: vi.fn(async () => []),
    groupKeysNet: { get: vi.fn(async () => new Response('{}', { status: 404 })), post: vi.fn(async () => new Response('{}', { status: 404 })) },
}));

const me: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'my-privkey', callsign: 'Alice', createdAt: '2026-09-14T00:00:00Z' };

const dm: Conversation = {
    id: 'conv-1', type: 'dm', name: null, participants: ['my-pubkey', 'peer-pubkey'], createdBy: 'my-pubkey',
    peerCallsign: 'Bob', unreadCount: 0, createdAt: '2026-10-14T00:00:00Z', postId: null,
} as any;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    syncListeners = [];
    mockTxs = [];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Marking the open chat read', () => {
    it('a line that lands while a mark is out is marked once more when it returns, not left unread', async () => {
        mockConversations = [{ ...dm, unreadCount: 1 }];
        let finishFirst: (v: { success: boolean }) => void = () => {};
        vi.mocked(markConversationReadApi).mockImplementationOnce(() => new Promise(r => { finishFirst = r; }) as never);
        render(<MessagesPage identity={me} />);
        fireEvent.click(await screen.findByText('Bob'));
        await waitFor(() => expect(markConversationReadApi).toHaveBeenCalledTimes(1));

        // Line B: the sync event's list read still says unread while line A's mark is out.
        mockConversations = [{ ...dm, unreadCount: 1 }];
        await act(async () => { syncListeners.forEach(l => l()); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(markConversationReadApi).toHaveBeenCalledTimes(1);

        await act(async () => { finishFirst({ success: true }); });
        await waitFor(() => expect(markConversationReadApi).toHaveBeenCalledTimes(2));
    });

    it('opening an unread chat never loops: however the reads overlap, two marks at most', async () => {
        mockConversations = [{ ...dm, unreadCount: 1 }];
        vi.mocked(markConversationReadApi).mockImplementation(async () => {
            mockConversations = [{ ...dm, unreadCount: 0 }];
            return { success: true } as never;
        });
        render(<MessagesPage identity={me} />);
        fireEvent.click(await screen.findByText('Bob'));
        await waitFor(() => expect(markConversationReadApi).toHaveBeenCalledTimes(1));
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(vi.mocked(markConversationReadApi).mock.calls.length).toBeLessThanOrEqual(2);
    });
});
