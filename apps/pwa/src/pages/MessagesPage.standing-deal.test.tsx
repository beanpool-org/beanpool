import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage, MarketplaceTransaction } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';

// U2 of the standing-deals redesign (DESIGN-standing-deals-upfront-fable §0, §3): the web chat's Trust Hold banner and deal
// strip ask core's dealMoves and dealStep, so a standing deal's row never shows Release or Cancel (Marty, 10 Nov: "Release 50"
// then "Failed: This month's Beans go to them by themselves"), and a standing deal asks for one review, on its first period.

let mockTxs: MarketplaceTransaction[] = [];
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

vi.mock('../lib/e2e-crypto', async (importOriginal) => ({
    // The thread's order is the real one: by the node's timestamps (core dmThreadInShownOrder).
    dmThreadInShownOrder: (await importOriginal<typeof import('../lib/e2e-crypto')>()).dmThreadInShownOrder,
    dmQuoteFrom: (await importOriginal<typeof import('../lib/e2e-crypto')>()).dmQuoteFrom,
    dmQuoteLabel: (await importOriginal<typeof import('../lib/e2e-crypto')>()).dmQuoteLabel,
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
    newDmMessageId: vi.fn(() => crypto.randomUUID()),
    isEncryptedNonce: vi.fn(() => false),
    DM_LINE_NOT_VERIFIED_TEXT: "🔒 This message couldn't be verified, so it isn't shown.",
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
    getMyMarketplaceTransactions: vi.fn(async () => mockTxs),
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
    // A group's chat on a node from before locked chats (no `encryption`), unless a test says otherwise.
    getGroupChat: vi.fn(async (groupId: string) => ({ conversation: mockConversationDetails[groupId], messages: mockMessagesByConv[groupId] || [], canPost: true })),
    getGroupMembers: vi.fn(async () => []),
    groupKeysNet: { get: vi.fn(async () => new Response('{}', { status: 404 })), post: vi.fn(async () => new Response('{}', { status: 404 })) },
}));


const me: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'my-privkey', callsign: 'Alice', createdAt: '2026-09-14T00:00:00Z' };

const dm: Conversation = {
    id: 'conv-1', type: 'dm', name: null, participants: ['my-pubkey', 'peer-pubkey'], createdBy: 'my-pubkey',
    peerCallsign: 'Bob', unreadCount: 0, createdAt: '2026-10-14T00:00:00Z',
    // As the node lists a trade chat: no post, the last line the release.
    postId: null, lastMsgType: 'system', lastSysType: 'ESCROW_RELEASED',
} as any;

const START = '2026-10-09T08:00:00.000Z';
function period(id: string, n: number, over: Partial<MarketplaceTransaction> = {}): MarketplaceTransaction {
    // I pay Bob 50 Beans a month for Vehicle Storage.
    return {
        id, postId: 'post-storage', postTitle: 'Vehicle Storage', buyerPublicKey: 'my-pubkey', buyerCallsign: 'Alice', sellerPublicKey: 'peer-pubkey',
        sellerCallsign: 'Bob', amount_c: 5000, status: 'completed', createdAt: START, completedAt: START, ratedByBuyer: false, ratedBySeller: false,
        standingId: 'sd-1', periodNo: n, ...over,
    } as MarketplaceTransaction;
}
function released(id: string, t: MarketplaceTransaction, at: string): ApiMessage {
    return {
        id, conversationId: 'conv-1', authorPubkey: 'SYSTEM', ciphertext: 'Payment of 50 Beans released to the provider.', nonce: '',
        type: 'system', systemType: 'ESCROW_RELEASED' as any, timestamp: at,
        metadata: JSON.stringify({ amount_c: 5000, postId: t.postId, transactionId: t.id, actorPubkey: 'my-pubkey', buyerPubkey: t.buyerPublicKey, sellerPubkey: t.sellerPublicKey }),
    };
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    syncActivityListeners = [];
    mockConversationDetails = {};
});
afterEach(() => { vi.unstubAllGlobals(); });

const holdButtons = () => screen.queryAllByRole('button', { name: /Release|Cancel|Hold back/ }).map(b => b.textContent?.trim());

describe("the web chat: a standing deal's rows never show Release, Cancel or Hold back (U2, fail-first)", () => {
    it('the current period read as pending (a stale copy) and an older one: no Trust Hold banner, no Release, no Cancel', async () => {
        mockTxs = [
            period('sd-m3', 3, { status: 'pending', standingPhase: 'paid', standingBeans_c: 5000, standingUnit: 'month', standingStartsAt: START, standingNextDueAt: '2027-01-09T08:00:00.000Z', createdAt: '2026-12-09T08:00:00.000Z' } as any),
            period('sd-m2', 2, { status: 'pending', createdAt: '2026-11-09T08:00:00.000Z' }),
            period('sd-m1', 1, { ratedByBuyer: true }),
        ];
        mockConversations = [{ ...dm, lastSysType: null } as any];
        mockMessagesByConv = { 'conv-1': [] };
        render(<MessagesPage identity={me} />);
        fireEvent.click(await screen.findByText('Bob'));
        await new Promise(r => setTimeout(r, 80));
        expect(screen.queryByText(/Trust Hold/)).toBeNull();
        expect(holdButtons()).toEqual([]);
        expect(screen.queryByTestId('chat-deal-sd-m3')).toBeNull();
        expect(screen.queryByTestId('chat-deal-sd-m2')).toBeNull();
    });

    it('a one-off deal held in trust still shows its banner with Release and Cancel (the control)', async () => {
        mockTxs = [period('tx-one', 0, { status: 'pending', standingId: undefined, periodNo: undefined, postTitle: 'Bread', amount_c: 500 })];
        mockConversations = [{ ...dm, lastSysType: null } as any];
        mockMessagesByConv = { 'conv-1': [] };
        render(<MessagesPage identity={me} />);
        fireEvent.click(await screen.findByText('Bob'));
        await screen.findByText(/Trust Hold/);
        expect(holdButtons()).toEqual(['✅ Release Beans', 'Cancel']);
    });

    it("reviewed once: the first period asks for a review; a later period's line and strip ask nothing", async () => {
        const m1 = period('sd-m1', 1);
        const m2 = period('sd-m2', 2, { createdAt: '2026-11-09T08:00:00.000Z', completedAt: '2026-11-09T08:00:00.000Z' });
        mockTxs = [m2, m1];
        mockConversations = [dm];
        mockMessagesByConv = { 'conv-1': [released('l1', m1, START), released('l2', m2, '2026-11-09T08:00:00.000Z')] };
        const onNavigate = vi.fn();
        render(<MessagesPage identity={me} onNavigate={onNavigate} />);
        await screen.findByText(/Action Needed/);
        fireEvent.click(screen.getByText('Bob'));
        await screen.findByRole('button', { name: /Rate your partner/ });
        expect(screen.getAllByRole('button', { name: /Rate your partner/ })).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: /Rate your partner/ }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace-review', 'sd-m1');
        expect(screen.queryByTestId('chat-deal-sd-m2')).toBeNull();
    });

    it('the first period rated, a later one not: the list shows no Action Needed', async () => {
        mockTxs = [period('sd-m2', 2, { createdAt: '2026-11-09T08:00:00.000Z' }), period('sd-m1', 1, { ratedByBuyer: true })];
        mockConversations = [dm];
        mockMessagesByConv = {};
        render(<MessagesPage identity={me} />);
        await screen.findByText('Bob');
        await new Promise(r => setTimeout(r, 50));
        expect(screen.queryByText(/Action Needed/)).toBeNull();
    });

    it("a standing deal's record line (due, covered, ended, stopped) shows the node's own sentence, marked 🔁", async () => {
        mockTxs = [period('sd-m1', 1, { ratedByBuyer: true })];
        mockConversations = [{ ...dm, lastSysType: 'STANDING_DEAL' } as any];
        mockMessagesByConv = { 'conv-1': [{
            id: 'sl1', conversationId: 'conv-1', authorPubkey: 'SYSTEM', ciphertext: "Vehicle Storage: this month's 50 Beans have gone to Bob.", nonce: '',
            type: 'system', systemType: 'STANDING_DEAL' as any, timestamp: '2026-11-12T08:00:00.000Z',
            metadata: JSON.stringify({ postId: 'post-storage', standingId: 'sd-1', text: "Vehicle Storage: this month's 50 Beans have gone to Bob." }),
        }] };
        render(<MessagesPage identity={me} />);
        fireEvent.click(await screen.findByText('Bob'));
        const line = await screen.findByText(/this month's 50 Beans have gone to Bob/);
        expect(line.closest('div')?.textContent).toContain('🔁');
        expect(holdButtons()).toEqual([]);
    });
});
