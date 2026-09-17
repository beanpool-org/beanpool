import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getConversationMessages, type Conversation, type ApiMessage } from '../lib/api';

// Polyfill scrollIntoView for jsdom
if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

let syncActivityListeners: Array<() => void | Promise<void>> = [];

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn((cb: () => void | Promise<void>) => {
        syncActivityListeners.push(cb);
        return () => {
            syncActivityListeners = syncActivityListeners.filter(l => l !== cb);
        };
    }),
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

vi.mock('../lib/e2e-crypto', () => ({
    decodePlaintext: vi.fn((c: string) => c),
    encodePlaintext: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    decryptDM: vi.fn((c: string) => c),
    encryptDM: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    isEncryptedNonce: vi.fn(() => false),
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

let mockConversations: Conversation[] = [];
let mockMessagesByConv: Record<string, ApiMessage[]> = {};
let mockConversationDetails: Record<string, Conversation> = {};

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({
        conversations: mockConversations,
        totalUnread: mockConversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    })),
    getConversationMessages: vi.fn(async (convId: string) => ({
        conversation: mockConversationDetails[convId] || {
            id: convId,
            type: 'dm',
            participants: ['my-pubkey', 'peer-pubkey'],
            createdAt: '2026-09-14T00:00:00Z',
            updatedAt: '2026-09-14T00:00:00Z',
        },
        messages: mockMessagesByConv[convId] || [],
    })),
    getMembers: vi.fn(async () => [
        { publicKey: 'peer-pubkey', callsign: 'Bob', role: 'member' },
        { publicKey: 'other-pubkey', callsign: 'Charlie', role: 'member' },
    ]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'my-pubkey',
    privateKey: 'my-privkey',
    callsign: 'Alice',
    createdAt: '2026-09-14T00:00:00Z',
};

describe('MessagesPage Stage 5: Chat Over Push & Backstop Polling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncActivityListeners = [];

        mockConversations = [
            {
                id: 'conv-1',
                type: 'dm',
                name: null,
                participants: ['my-pubkey', 'peer-pubkey'],
                createdBy: 'my-pubkey',
                peerCallsign: 'Bob',
                unreadCount: 0,
                createdAt: '2026-09-14T00:00:00Z',
            },
            {
                id: 'conv-2',
                type: 'dm',
                name: null,
                participants: ['my-pubkey', 'other-pubkey'],
                createdBy: 'my-pubkey',
                peerCallsign: 'Charlie',
                unreadCount: 0,
                createdAt: '2026-09-14T00:00:00Z',
            },
        ];

        mockConversationDetails = {
            'conv-1': mockConversations[0],
            'conv-2': mockConversations[1],
        };

        mockMessagesByConv = {
            'conv-1': [
                {
                    id: 'msg-1',
                    conversationId: 'conv-1',
                    authorPubkey: 'peer-pubkey',
                    ciphertext: 'Hello Alice!',
                    nonce: '00000',
                    timestamp: '2026-09-14T00:00:00.000Z',
                },
            ],
            'conv-2': [],
        };

        vi.mocked(getConversationMessages).mockImplementation(async (convId: string) => ({
            conversation: mockConversationDetails[convId] || {
                id: convId,
                type: 'dm',
                participants: ['my-pubkey', 'peer-pubkey'],
                createdAt: '2026-09-14T00:00:00Z',
                updatedAt: '2026-09-14T00:00:00Z',
            },
            messages: mockMessagesByConv[convId] || [],
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.mocked(getConversationMessages).mockImplementation(async (convId: string) => ({
            conversation: mockConversationDetails[convId] || {
                id: convId,
                type: 'dm',
                participants: ['my-pubkey', 'peer-pubkey'],
                createdAt: '2026-09-14T00:00:00Z',
                updatedAt: '2026-09-14T00:00:00Z',
            },
            messages: mockMessagesByConv[convId] || [],
        }));
    });

    it('1. an arriving message appears without waiting for the backstop', async () => {
        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        // Initial message renders
        await waitFor(() => {
            expect(screen.getByText('Hello Alice!')).toBeInTheDocument();
        });

        // New message arrives on server
        mockMessagesByConv['conv-1'] = [
            ...mockMessagesByConv['conv-1'],
            {
                id: 'msg-2',
                conversationId: 'conv-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Push broadcast message arrived!',
                nonce: '00000',
                timestamp: '2026-09-14T00:00:05.000Z',
            },
        ];

        // Trigger onSyncActivity (simulating WebSocket doorbell push event)
        // Note: No timer advancement by 30s is needed!
        await act(async () => {
            for (const listener of syncActivityListeners) {
                await listener();
            }
        });

        // Message appears immediately via push listener
        expect(screen.getByText('Push broadcast message arrived!')).toBeInTheDocument();
    });

    it('2. no duplicate render when identical message id is received or refetched', async () => {
        // Mock returning the exact same message twice in the server response
        mockMessagesByConv['conv-1'] = [
            {
                id: 'msg-dup-1',
                conversationId: 'conv-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Unique content test',
                nonce: '00000',
                timestamp: '2026-09-14T00:00:00.000Z',
            },
            {
                id: 'msg-dup-1', // Same ID!
                conversationId: 'conv-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Unique content test',
                nonce: '00000',
                timestamp: '2026-09-14T00:00:00.000Z',
            },
        ];

        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Unique content test')).toBeInTheDocument();
        });

        // Verify deduplication: only 1 element rendered in DOM
        const matches = screen.getAllByText('Unique content test');
        expect(matches.length).toBe(1);

        // Even after another onSyncActivity push, it stays deduplicated
        await act(async () => {
            for (const listener of syncActivityListeners) {
                await listener();
            }
        });

        expect(screen.getAllByText('Unique content test').length).toBe(1);
    });

    it('3. the backstop still recovers when no broadcast arrives (silently dead socket)', async () => {
        vi.useFakeTimers();

        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        // Flush initial load promises
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });

        expect(screen.getByText('Hello Alice!')).toBeInTheDocument();

        // A new message is sent on server, but socket is dead so NO broadcast / onSyncActivity fires
        mockMessagesByConv['conv-1'] = [
            ...mockMessagesByConv['conv-1'],
            {
                id: 'msg-recovered',
                conversationId: 'conv-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Recovered via 30s backstop poll',
                nonce: '00000',
                timestamp: '2026-09-14T00:00:10.000Z',
            },
        ];

        // Message should NOT be rendered yet (before backstop fires)
        expect(screen.queryByText('Recovered via 30s backstop poll')).not.toBeInTheDocument();

        // Advance past 30s (with ±20% jitter, max interval is 36s = 36000ms)
        await act(async () => {
            await vi.advanceTimersByTimeAsync(36000);
        });

        // Backstop poll executed and recovered the message
        expect(screen.getByText('Recovered via 30s backstop poll')).toBeInTheDocument();
    });

    it('4. unread counts update for a conversation that is not open', async () => {
        // Render conversation list view (no open conversation)
        render(
            <MessagesPage
                identity={mockIdentity}
            />
        );

        // Initial list renders Bob and Charlie
        await waitFor(() => {
            expect(screen.getByText('Bob')).toBeInTheDocument();
            expect(screen.getByText('Charlie')).toBeInTheDocument();
        });

        // Initially no unread badge '5'
        expect(screen.queryByText('5')).not.toBeInTheDocument();

        // Message arrives for conv-2 (unopened conversation)
        mockConversations = [
            {
                ...mockConversations[0],
                unreadCount: 0,
            },
            {
                ...mockConversations[1],
                unreadCount: 5,
            },
        ];

        // Trigger onSyncActivity (conversation list sync)
        await act(async () => {
            for (const listener of syncActivityListeners) {
                await listener();
            }
        });

        // Unread badge for conv-2 updates to 5
        await waitFor(() => {
            const badge = screen.getByText('5');
            expect(badge).toBeInTheDocument();
        });

        // conv-1 has unreadCount 0 (no unread badge)
        expect(screen.queryByText('1')).not.toBeInTheDocument();
    });

    it('5. out-of-order race protection: an older in-flight load cannot overwrite newer messages', async () => {
        let resolveFirstCall: ((val: any) => void) | null = null;
        const firstCallPromise = new Promise((resolve) => {
            resolveFirstCall = resolve;
        });

        let firstCallStartedResolve: (() => void) | null = null;
        const firstCallStartedPromise = new Promise<void>((resolve) => {
            firstCallStartedResolve = resolve;
        });

        const { getConversationMessages } = await import('../lib/api');
        const originalMock = vi.mocked(getConversationMessages);

        let callCount = 0;
        originalMock.mockImplementation(async (convId: string) => {
            callCount++;
            if (callCount === 1) {
                // Signal that first call has started
                firstCallStartedResolve?.();
                // First call stalls waiting for promise
                await firstCallPromise;
                return {
                    conversation: mockConversationDetails[convId],
                    messages: [
                        {
                            id: 'msg-old',
                            conversationId: convId,
                            authorPubkey: 'peer-pubkey',
                            ciphertext: 'Old Stale Message',
                            nonce: '00000',
                            timestamp: '2026-09-14T00:00:00.000Z',
                        },
                    ],
                };
            }
            // Second call completes immediately with newer message
            return {
                conversation: mockConversationDetails[convId],
                messages: [
                    {
                        id: 'msg-new',
                        conversationId: convId,
                        authorPubkey: 'peer-pubkey',
                        ciphertext: 'Fresh Push Message',
                        nonce: '00000',
                        timestamp: '2026-09-14T00:00:05.000Z',
                    },
                ],
            };
        });

        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        // Wait until first loadMessages call is in-flight
        await firstCallStartedPromise;

        // While first call is stalled, push broadcast arrives and starts second load
        await act(async () => {
            for (const listener of syncActivityListeners) {
                await listener();
            }
        });

        // Second call completed and rendered the fresh message
        await waitFor(() => {
            expect(screen.getByText('Fresh Push Message')).toBeInTheDocument();
        });

        // Now first call finally resolves later
        await act(async () => {
            resolveFirstCall!({} as any);
        });

        // The older out-of-order response was discarded and did not overwrite the fresh message!
        expect(screen.getByText('Fresh Push Message')).toBeInTheDocument();
        expect(screen.queryByText('Old Stale Message')).not.toBeInTheDocument();
    });

    it('6. listeners return promises so sync coordinator can await them', async () => {
        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Hello Alice!')).toBeInTheDocument();
        });

        expect(syncActivityListeners.length).toBeGreaterThan(0);
        for (const listener of syncActivityListeners) {
            let ret: any;
            await act(async () => {
                ret = listener();
            });
            // Each listener must return a Promise (or undefined when paused/hidden)
            if (ret !== undefined) {
                expect(ret).toBeInstanceOf(Promise);
            }
        }
    });
});

describe('MessagesPage conversation filters at 320px with 1.3x text', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConversations = [];
    });

    it('wraps All / Transactions / Direct onto a second line instead of hiding Direct behind a scrollbar', async () => {
        render(<MessagesPage identity={mockIdentity} />);

        const row = await screen.findByTestId('conversation-filter-chips');
        expect(row).toHaveStyle({ flexWrap: 'wrap' });
        expect(row).toHaveClass('scrollbar-none');
        expect(Array.from(row.querySelectorAll('button')).map(b => b.textContent)).toEqual(['All', 'Transactions', 'Direct']);
    });
});
