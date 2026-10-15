import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Conversation, ApiMessage, MarketplaceTransaction } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';

// Marty, 15 Oct (web, dark): the Messages list said "Action Needed: Review Partner" on DMs whose trades were all rated,
// and the chat had nothing to rate. A trade chat is one DM per pair (post_id NULL), and one pair can trade more than once.

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
    openDmLine: vi.fn((p: { ciphertext: string }) => ({ text: p.ciphertext, format: 3, after: null, conversationId: '', moved: false })),
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

function tx(id: string, postId: string, rated: boolean, completedAt: string): MarketplaceTransaction {
    // I bought from Bob each time.
    return {
        id, postId, postTitle: 'Bread', buyerPublicKey: 'my-pubkey', buyerCallsign: 'Alice', sellerPublicKey: 'peer-pubkey',
        sellerCallsign: 'Bob', credits: 5, status: 'completed', createdAt: completedAt, completedAt, ratedByBuyer: rated, ratedBySeller: false,
    };
}

function released(id: string, t: MarketplaceTransaction, at: string): ApiMessage {
    return {
        id, conversationId: 'conv-1', authorPubkey: 'SYSTEM', ciphertext: 'Payment of 5 Beans released to the provider.', nonce: '',
        type: 'system', systemType: 'ESCROW_RELEASED' as any, timestamp: at,
        metadata: JSON.stringify({ amount: 5, postId: t.postId, transactionId: t.id, actorPubkey: 'my-pubkey', buyerPubkey: t.buyerPublicKey, sellerPubkey: t.sellerPublicKey }),
    };
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    syncActivityListeners = [];
    mockConversationDetails = {};
});
afterEach(() => { vi.unstubAllGlobals(); });

function oldLine(id: string, t: MarketplaceTransaction, at: string): ApiMessage {
    // A release line from before #1604 (2026-10-04): no transactionId in its metadata, as on mullum and castlemaine.
    return {
        id, conversationId: 'conv-1', authorPubkey: 'SYSTEM', ciphertext: 'Payment of 5 Beans released to the provider.', nonce: '',
        type: 'system', systemType: 'ESCROW_RELEASED' as any, timestamp: at,
        metadata: JSON.stringify({ amount: 5, postId: t.postId, actorPubkey: 'my-pubkey', buyerPubkey: t.buyerPublicKey, sellerPubkey: t.sellerPublicKey }),
    };
}
const lineButtons = () => screen.queryAllByRole('button', { name: /Rate your partner|Rating Submitted|View Post/ }).map(b => b.textContent?.trim());

describe('Messages: the review prompt is about this DM\'s own trades', () => {
    it('two finished trades with Bob, both rated: no Action Needed', async () => {
        // A repeatable offer bought twice: both rows on one post.
        mockTxs = [tx('tx-a', 'post-1', true, '2026-10-13T00:00:00Z'), tx('tx-b', 'post-1', true, '2026-10-14T00:00:00Z')];
        mockConversations = [dm];
        mockMessagesByConv = {};
        render(<MessagesPage identity={me} />);
        await screen.findByText('Bob');
        // Let the trades load (they arrive with the conversations).
        await new Promise(r => setTimeout(r, 50));
        expect(screen.queryByText(/Action Needed/)).toBeNull();
    });

    it('one of two unrated: the prompt shows, and the chat\'s Rate your partner goes to THAT trade\'s rating form', async () => {
        const rated = tx('tx-a', 'post-1', true, '2026-10-13T00:00:00Z');
        const unrated = tx('tx-b', 'post-1', false, '2026-10-14T00:00:00Z');
        mockTxs = [rated, unrated];
        mockConversations = [dm];
        mockMessagesByConv = { 'conv-1': [released('m1', rated, '2026-10-13T00:00:00Z'), released('m2', unrated, '2026-10-14T00:00:00Z')] };
        const onNavigate = vi.fn();
        render(<MessagesPage identity={me} onNavigate={onNavigate} />);
        await screen.findByText(/Action Needed/);
        fireEvent.click(screen.getByText('Bob'));
        const rate = await screen.findByRole('button', { name: /Rate your partner/ });
        // The rated trade's line says so; the unrated one offers the form.
        expect(screen.getAllByRole('button', { name: /Rating Submitted/ })).toHaveLength(1);
        fireEvent.click(rate);
        expect(onNavigate).toHaveBeenCalledWith('marketplace-review', 'tx-b');
    });

    it('no finished trade with this person: no prompt, whatever the last line was', async () => {
        mockTxs = [{ ...tx('tx-c', 'post-2', false, '2026-10-14T00:00:00Z'), sellerPublicKey: 'other-pubkey', sellerCallsign: 'Charlie' }];
        mockConversations = [dm];
        mockMessagesByConv = {};
        render(<MessagesPage identity={me} />);
        await screen.findByText('Bob');
        await new Promise(r => setTimeout(r, 50));
        expect(screen.queryByText(/Action Needed/)).toBeNull();
    });
    it('the unrated trade\'s release line is not among the lines loaded: the chat still offers Rate your partner, for that trade', async () => {
        mockTxs = [tx('tx-a', 'post-1', true, '2026-10-13T00:00:00Z'), tx('tx-b', 'post-1', false, '2026-10-14T00:00:00Z')];
        mockConversations = [dm];
        mockMessagesByConv = { 'conv-1': [] };
        const onNavigate = vi.fn();
        render(<MessagesPage identity={me} onNavigate={onNavigate} />);
        await screen.findByText(/Action Needed/);
        fireEvent.click(screen.getByText('Bob'));
        const banner = await screen.findByTestId('chat-rate-banner');
        fireEvent.click(within(banner).getByRole('button', { name: /Rate your partner/ }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace-review', 'tx-b');
    });

    it('the release line is shown: one Rate your partner, on the line, no pinned copy', async () => {
        const unrated = tx('tx-b', 'post-1', false, '2026-10-14T00:00:00Z');
        mockTxs = [unrated];
        mockConversations = [dm];
        mockMessagesByConv = { 'conv-1': [released('m2', unrated, '2026-10-14T00:00:00Z')] };
        render(<MessagesPage identity={me} />);
        await screen.findByText(/Action Needed/);
        fireEvent.click(screen.getByText('Bob'));
        await screen.findByRole('button', { name: /Rate your partner/ });
        expect(screen.queryByTestId('chat-rate-banner')).toBeNull();
        expect(screen.getAllByRole('button', { name: /Rate your partner/ })).toHaveLength(1);
    });

    // Review #1980 B1 (M1): Marty's screen word for word on lines written before #1604. Each old line is the trade on its
    // post between the two people that finished nearest the line's own time, never "the first one on the post".
    it('old lines, one offer bought twice from Bob, the older unrated: its line offers Rate for THAT trade, the newer says rated', async () => {
        const t2 = tx('t2', 'post-1', true, '2026-09-20T00:00:00Z');   // newer, rated
        const t1 = tx('t1', 'post-1', false, '2026-09-10T00:00:00Z');  // older, unrated
        mockTxs = [t2, t1]; // the node's order: newest first
        mockConversations = [dm];
        mockMessagesByConv = { 'conv-1': [oldLine('m1', t1, '2026-09-10T00:00:00.120Z'), oldLine('m2', t2, '2026-09-20T00:00:00.080Z')] };
        const onNavigate = vi.fn();
        render(<MessagesPage identity={me} onNavigate={onNavigate} />);
        await screen.findByText(/Action Needed/);
        fireEvent.click(screen.getByText('Bob'));
        await screen.findByRole('button', { name: /Rate your partner/ });
        expect(lineButtons()).toEqual(['⭐ Rate your partner', '✓ Rating Submitted']);
        expect(screen.queryByTestId('chat-rate-banner')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Rate your partner/ }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace-review', 't1');
    });

    it('old lines, the older rated and the newer not: one Rate, on the newer line, for the newer trade (M2)', async () => {
        const t2 = tx('t2', 'post-1', false, '2026-09-20T00:00:00Z');
        const t1 = tx('t1', 'post-1', true, '2026-09-10T00:00:00Z');
        mockTxs = [t2, t1];
        mockConversations = [dm];
        mockMessagesByConv = { 'conv-1': [oldLine('m1', t1, '2026-09-10T00:00:00Z'), oldLine('m2', t2, '2026-09-20T00:00:00Z')] };
        const onNavigate = vi.fn();
        render(<MessagesPage identity={me} onNavigate={onNavigate} />);
        await screen.findByText(/Action Needed/);
        fireEvent.click(screen.getByText('Bob'));
        await screen.findByRole('button', { name: /Rate your partner/ });
        expect(lineButtons()).toEqual(['✓ Rating Submitted', '⭐ Rate your partner']);
        fireEvent.click(screen.getByRole('button', { name: /Rate your partner/ }));
        expect(onNavigate.mock.calls).toEqual([['marketplace-review', 't2']]);
    });

    // Review #1980 N2: a line whose trade this page doesn't hold (older than the node's page of trades) offers what it can
    // do — open the post — and never a Rate it can't give.
    it('a release line whose trade is not among the loaded trades says View Post, and opens the post', async () => {
        mockTxs = [];
        mockConversations = [dm];
        const gone = tx('t-old', 'post-old', true, '2026-08-01T00:00:00Z');
        mockMessagesByConv = { 'conv-1': [released('m1', gone, '2026-08-01T00:00:00Z')] };
        const onNavigate = vi.fn();
        render(<MessagesPage identity={me} onNavigate={onNavigate} />);
        fireEvent.click(await screen.findByText('Bob'));
        const view = await screen.findByRole('button', { name: /View Post/ });
        expect(lineButtons()).toEqual(['🏷️ View Post']);
        fireEvent.click(view);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-old');
    });
});
