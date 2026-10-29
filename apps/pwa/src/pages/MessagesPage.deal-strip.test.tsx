import { render, screen, fireEvent, within, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { completeMarketplaceTransaction, cancelMarketplaceTransaction, type Conversation, type MarketplaceTransaction } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { backToEnglish, bypassing, showIn, xx } from '../words-xx.test-support';

// Deals S5 (DESIGN-deals-fable §2.2): the web chat shows the phone's deal strip to BOTH sides of a deal, and its list counts
// the deals whose next step is the member's own, by core's one rule (dealsNeedingMe). The phone is the reference
// (apps/native/app/chat/[id].tsx `dealStrip`, chats.tsx): the buyer's Trust Hold banner is its action bar, and a deal the
// bar carries is left out of the strip.

let mockTxs: MarketplaceTransaction[] = [];
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

/** A deal between me and Bob. By default I pay (I am the buyer) and it is held in trust. */
function deal(id: string, over: Partial<MarketplaceTransaction> = {}): MarketplaceTransaction {
    return {
        id, postId: `post-${id}`, postTitle: `Bread ${id}`, buyerPublicKey: 'my-pubkey', buyerCallsign: 'Alice',
        sellerPublicKey: 'peer-pubkey', sellerCallsign: 'Bob', credits: 5, status: 'pending', createdAt: '2026-10-20T00:00:00Z',
        ratedByBuyer: false, ratedBySeller: false, ...over,
    };
}
/** The same deal with Bob paying: I am its seller. */
const sold = (id: string, over: Partial<MarketplaceTransaction> = {}) => deal(id, {
    buyerPublicKey: 'peer-pubkey', buyerCallsign: 'Bob', sellerPublicKey: 'my-pubkey', sellerCallsign: 'Alice', ...over,
});

let said: string[] = [];
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    mockConversations = [dm];
    mockTxs = [];
    said = [];
    vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { said.push(String(m)); return true; });
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
});
afterEach(() => { cleanup(); backToEnglish(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openChat(onNavigate?: (tab: string, contextId?: string, txId?: string) => void) {
    render(<MessagesPage identity={me} onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByText('Bob'));
}
const strip = () => screen.findByTestId('chat-deal-strip');

describe('Chat deal strip: the seller (payee) sees the deal too', () => {
    it('a deal held for me: "Awaiting release" on its card, no Release, no Cancel, and no banner', async () => {
        mockTxs = [sold('tx-s')];
        await openChat();
        const card = within(await strip()).getByRole('group', { name: 'Bread tx-s' });
        expect(within(card).getByText('⏳ Awaiting release')).toBeInTheDocument();
        expect(within(card).getByText('5 Beans · in escrow')).toBeInTheDocument();
        expect(within(card).queryByRole('button', { name: /Release/ })).toBeNull();
        expect(within(card).queryByRole('button', { name: /Cancel/ })).toBeNull();
        expect(screen.queryByText('🔒 Trust Hold: 5 Beans')).toBeNull();
    });

    it('a finished deal I have not rated: Review, and it asks for that deal\'s rating form', async () => {
        const onNavigate = vi.fn();
        mockTxs = [sold('tx-d', { status: 'completed', completedAt: '2026-10-21T00:00:00Z' })];
        await openChat(onNavigate);
        const card = within(await strip()).getByRole('group', { name: 'Bread tx-d' });
        expect(within(card).getByText('5 Beans · completed')).toBeInTheDocument();
        fireEvent.click(within(card).getByRole('button', { name: 'Leave a review for Bread tx-d' }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace-review', 'tx-d');
    });

    it('a finished deal I have already rated, a cancelled one and a stranger\'s deal: no card', async () => {
        mockTxs = [
            sold('tx-r', { status: 'completed', ratedBySeller: true }),
            sold('tx-c', { status: 'cancelled' }),
            sold('tx-x', { buyerPublicKey: 'other-pubkey', sellerPublicKey: 'third-pubkey' }),
        ];
        await openChat();
        await screen.findByText(/No messages yet/);
        expect(screen.queryByTestId('chat-deal-strip')).toBeNull();
    });
});

describe('Chat deal strip: the payer', () => {
    // The phone's action bar (the buyer's Trust Hold banner here) carries the newest held deal; the strip shows the rest.
    it('Release on a card calls complete with THAT deal\'s id, after the same confirm the banner asks', async () => {
        mockTxs = [deal('tx-new', { createdAt: '2026-10-21T00:00:00Z' }), deal('tx-old', { createdAt: '2026-10-19T00:00:00Z', credits: 7 })];
        await openChat();
        const card = within(await strip()).getByRole('group', { name: 'Bread tx-old' });
        fireEvent.click(within(card).getByRole('button', { name: 'Release credits for Bread tx-old' }));
        expect(said[0]).toBe('Release 7 Beans to the provider? This action is final.');
        await waitFor(() => expect(completeMarketplaceTransaction).toHaveBeenCalledTimes(1));
        expect(completeMarketplaceTransaction).toHaveBeenCalledWith('tx-old', 'my-pubkey');
        expect(cancelMarketplaceTransaction).not.toHaveBeenCalled();
    });

    it('Cancel on a card calls cancel with its own id, after the same confirm', async () => {
        mockTxs = [deal('tx-new', { createdAt: '2026-10-21T00:00:00Z' }), deal('tx-old', { createdAt: '2026-10-19T00:00:00Z' })];
        await openChat();
        const card = within(await strip()).getByRole('group', { name: 'Bread tx-old' });
        fireEvent.click(within(card).getByRole('button', { name: 'Cancel deal' }));
        expect(said[0]).toBe('Cancel this hold and refund the credits?');
        await waitFor(() => expect(cancelMarketplaceTransaction).toHaveBeenCalledTimes(1));
        expect(cancelMarketplaceTransaction).toHaveBeenCalledWith('tx-old', 'my-pubkey');
        expect(completeMarketplaceTransaction).not.toHaveBeenCalled();
    });

    it('declining the confirm calls nothing', async () => {
        mockTxs = [deal('tx-new', { createdAt: '2026-10-21T00:00:00Z' }), deal('tx-old', { createdAt: '2026-10-19T00:00:00Z' })];
        vi.spyOn(window, 'confirm').mockImplementation(() => false);
        await openChat();
        const card = within(await strip()).getByRole('group', { name: 'Bread tx-old' });
        fireEvent.click(within(card).getByRole('button', { name: 'Release credits for Bread tx-old' }));
        fireEvent.click(within(card).getByRole('button', { name: 'Cancel deal' }));
        expect(completeMarketplaceTransaction).not.toHaveBeenCalled();
        expect(cancelMarketplaceTransaction).not.toHaveBeenCalled();
    });

    it('one held deal: the banner carries it (as the phone\'s action bar does) and the strip does not repeat it', async () => {
        mockTxs = [deal('tx-one')];
        await openChat();
        await screen.findByText('🔒 Trust Hold: 5 Beans');
        expect(screen.queryByTestId('chat-deal-strip')).toBeNull();
        expect(screen.getAllByRole('button', { name: /Release/ })).toHaveLength(1);
    });

    it('the cards run newest first, a payer\'s next to a payee\'s', async () => {
        mockTxs = [
            deal('tx-a', { createdAt: '2026-10-22T00:00:00Z' }),   // the banner's
            sold('tx-b', { createdAt: '2026-10-18T00:00:00Z' }),
            deal('tx-c', { createdAt: '2026-10-20T00:00:00Z' }),
        ];
        await openChat();
        const cards = within(await strip()).getAllByRole('group').map(g => g.getAttribute('aria-label'));
        expect(cards).toEqual(['Bread tx-c', 'Bread tx-b']);
    });
});

describe('Chat deal strip: a request on my listing waits for my answer', () => {
    // The list's Action Required counts this request (dealsNeedingMe → to-answer), so the chat it opens must show it.
    it('the chip leads to a card: the item, "Waiting on you: answer", nothing held and no buttons; it opens the listing at the deal', async () => {
        const onNavigate = vi.fn();
        mockTxs = [sold('tx-q', { status: 'requested', postAuthorPublicKey: 'my-pubkey', postType: 'offer' })];
        render(<MessagesPage identity={me} onNavigate={onNavigate} />);
        await waitFor(() => expect(screen.queryByTestId('deal-action-chip')).not.toBeNull());
        expect(screen.getByTestId('deal-action-chip').textContent).toBe('⚡Action Required (1)');
        fireEvent.click(await screen.findByText('Bob'));
        const card = within(await strip()).getByRole('group', { name: 'Bread tx-q' });
        expect(within(card).getByText('Waiting on you: answer')).toBeInTheDocument();
        expect(within(card).queryByText(/escrow/)).toBeNull();
        expect(within(card).queryByText(/Awaiting release/)).toBeNull();
        expect(screen.queryByText(/Trust Hold/)).toBeNull();
        // The card's one control is the door to the listing, where Approve and Deny are.
        expect(within(card).getAllByRole('button')).toHaveLength(1);
        fireEvent.click(within(card).getByRole('button', { name: /Bread tx-q/ }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-tx-q', 'tx-q');
        expect(completeMarketplaceTransaction).not.toHaveBeenCalled();
        expect(cancelMarketplaceTransaction).not.toHaveBeenCalled();
    });

    it('a request of mine waiting on them, a declined one and a stranger\'s: no card', async () => {
        mockTxs = [
            deal('tx-a', { status: 'requested', postAuthorPublicKey: 'peer-pubkey', postType: 'offer' }),
            sold('tx-d', { status: 'rejected', postAuthorPublicKey: 'my-pubkey', postType: 'offer' }),
            sold('tx-x', { status: 'requested', buyerPublicKey: 'other-pubkey', sellerPublicKey: 'third-pubkey' }),
        ];
        await openChat();
        await screen.findByText(/No messages yet/);
        expect(screen.queryByTestId('chat-deal-strip')).toBeNull();
    });

    it('the request sits among the cards by date, next to a held deal', async () => {
        mockTxs = [
            sold('tx-held', { createdAt: '2026-10-20T00:00:00Z' }),
            sold('tx-q', { status: 'requested', postAuthorPublicKey: 'my-pubkey', postType: 'offer', createdAt: '2026-10-22T00:00:00Z' }),
        ];
        await openChat();
        const cards = within(await strip()).getAllByRole('group').map(g => g.getAttribute('aria-label'));
        expect(cards).toEqual(['Bread tx-q', 'Bread tx-held']);
    });
});

describe('Chat deal strip: each card opens the listing at its deal', () => {
    it('a card opens the Market at its post and its deal, not the newest one', async () => {
        const onNavigate = vi.fn();
        mockTxs = [sold('tx-1', { createdAt: '2026-10-21T00:00:00Z', postId: 'post-lend' }), sold('tx-2', { createdAt: '2026-10-19T00:00:00Z', postId: 'post-lend' })];
        await openChat(onNavigate);
        const card = within(await strip()).getByRole('group', { name: 'Bread tx-2' });
        fireEvent.click(within(card).getByRole('button', { name: /Bread tx-2/ }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-lend', 'tx-2');
    });

    it('every control is a button 44 px tall at least', async () => {
        mockTxs = [deal('tx-new', { createdAt: '2026-10-21T00:00:00Z' }), deal('tx-old', { createdAt: '2026-10-19T00:00:00Z' }), sold('tx-d', { status: 'completed' })];
        await openChat();
        const buttons = within(await strip()).getAllByRole('button');
        expect(buttons.length).toBeGreaterThanOrEqual(5);
        for (const b of buttons) {
            expect(b.tagName).toBe('BUTTON');
            expect(parseInt(b.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
        }
    });
});

// Review of #2607: on a 360 x 640 screen at 1.3x text the strip, the Trust Hold banner and the pinned Rate banner left the
// thread 20 px and put the composer under the bottom nav. jsdom lays nothing out, so what is pinned here is the structure the
// real-Chromium measurement (in the PR) rests on: one scroll box for everything pinned, a floor for the thread, one door to a
// rating form.
describe('Chat deal strip: the pinned block never takes the thread or the composer', () => {
    it('a deal in trust and an older finished one I never rated: the Review card is the only door to its rating form', async () => {
        const onNavigate = vi.fn();
        mockTxs = [
            deal('tx-new', { createdAt: '2026-10-22T00:00:00Z' }),
            deal('tx-old', { status: 'completed', createdAt: '2026-10-16T00:00:00Z', completedAt: '2026-10-17T00:00:00Z' }),
        ];
        await openChat(onNavigate);
        await screen.findByText('🔒 Trust Hold: 5 Beans');
        const card = await screen.findByTestId('chat-deal-tx-old');
        await new Promise(r => setTimeout(r, 50));   // the pinned banner waits for the chat's lines
        expect(screen.queryByTestId('chat-rate-banner')).toBeNull();
        expect(screen.queryByRole('button', { name: /Rate your partner/ })).toBeNull();
        fireEvent.click(within(card).getByRole('button', { name: /Leave a review for Bread tx-old/ }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace-review', 'tx-old');
    });

    it('the strip and the Trust Hold banner sit in one scroll box that can shrink, above a thread with a floor', async () => {
        mockTxs = [
            deal('tx-new', { createdAt: '2026-10-22T00:00:00Z' }),
            deal('tx-old', { createdAt: '2026-10-19T00:00:00Z' }),
        ];
        await openChat();
        const pinned = await screen.findByTestId('chat-pinned');
        expect(within(pinned).getByTestId('chat-deal-strip')).toBeInTheDocument();
        expect(within(pinned).getByText('🔒 Trust Hold: 5 Beans')).toBeInTheDocument();
        // Content-sized when there is room, and the one thing that gives way when there is not.
        expect(pinned).toHaveStyle({ flexGrow: '0', flexShrink: '1', minHeight: '0px', overflowY: 'auto' });
        const thread = screen.getByTestId('chat-thread');
        expect(thread).toHaveStyle({ minHeight: '120px', overflowY: 'auto' });
        // The box comes before the thread, so the thread (and with it the composer) is the last thing in the column.
        expect(pinned.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('every card and its buttons stay in the tab order inside the box', async () => {
        mockTxs = [deal('tx-new', { createdAt: '2026-10-22T00:00:00Z' }), deal('tx-old', { createdAt: '2026-10-19T00:00:00Z' }), sold('tx-d', { status: 'completed' })];
        await openChat();
        const pinned = await screen.findByTestId('chat-pinned');
        const buttons = within(pinned).getAllByRole('button');
        expect(buttons.length).toBeGreaterThanOrEqual(6);   // the banner's two, then each card's open + its own control(s)
        for (const b of buttons) expect(b.getAttribute('tabindex')).not.toBe('-1');
    });
});

describe('Chat list: Action Required counts the deals whose step is mine', () => {
    const chip = () => screen.queryByTestId('deal-action-chip');

    it('Beans of mine held in trust: the chip counts the deals to release', async () => {
        mockTxs = [deal('tx-1'), deal('tx-2')];
        render(<MessagesPage identity={me} />);
        await screen.findByText('Bob');
        await waitFor(() => expect(chip()).not.toBeNull());
        expect(chip()!.textContent).toBe('⚡Release Credits (2)');
    });

    it('Beans held for me (I am the payee): no chip, my step is in the world', async () => {
        mockTxs = [sold('tx-1')];
        render(<MessagesPage identity={me} />);
        await screen.findByText('Bob');
        await new Promise(r => setTimeout(r, 50));
        expect(chip()).toBeNull();
    });

    it('a request on my listing to answer: Action Required; my own request, waiting: none', async () => {
        // Bob asks to borrow my thing: I am the listing's author and answer.
        mockTxs = [sold('tx-q', { status: 'requested', postAuthorPublicKey: 'my-pubkey', postType: 'offer' })];
        render(<MessagesPage identity={me} />);
        await screen.findByText('Bob');
        await waitFor(() => expect(chip()).not.toBeNull());
        expect(chip()!.textContent).toBe('⚡Action Required (1)');
        cleanup();

        // I asked to borrow Bob's: it waits on him.
        mockTxs = [deal('tx-q', { status: 'requested', postAuthorPublicKey: 'peer-pubkey', postType: 'offer' })];
        render(<MessagesPage identity={me} />);
        await screen.findByText('Bob');
        await new Promise(r => setTimeout(r, 50));
        expect(chip()).toBeNull();
    });

    it('a finished deal, a cancelled one and a deal with someone else: no chip', async () => {
        mockTxs = [
            deal('tx-1', { status: 'completed', ratedByBuyer: true }),
            deal('tx-2', { status: 'cancelled' }),
            deal('tx-3', { sellerPublicKey: 'other-pubkey', sellerCallsign: 'Charlie' }),
        ];
        render(<MessagesPage identity={me} />);
        await screen.findByText('Bob');
        await new Promise(r => setTimeout(r, 50));
        expect(chip()).toBeNull();
    });
});

describe('Chat deal strip in the member\'s language', () => {
    it('every word the strip and the chip write came through t()', async () => {
        await showIn('xx');
        mockTxs = [deal('tx-new', { createdAt: '2026-10-21T00:00:00Z' }), sold('tx-s', { createdAt: '2026-10-20T00:00:00Z' }),
            sold('tx-d', { status: 'completed', createdAt: '2026-10-19T00:00:00Z' }), deal('tx-old', { createdAt: '2026-10-18T00:00:00Z' })];
        render(<MessagesPage identity={me} />);
        await waitFor(() => expect(screen.queryByTestId('deal-action-chip')).not.toBeNull());
        expect(bypassing(document.body, { others: ['Bob'] })).toEqual([]);
        fireEvent.click(await screen.findByText('Bob'));
        const s = await strip();
        expect(within(s).getByText(xx('⏳ Awaiting release'))).toBeInTheDocument();
        expect(within(s).getAllByRole('button', { name: xx('Release credits for {title}').replace('{title}', 'Bread tx-old') })).toHaveLength(1);
        expect(within(s).getByRole('button', { name: xx('Leave a review for {title}').replace('{title}', 'Bread tx-d') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: ['Bob', 'Bread tx-new', 'Bread tx-s', 'Bread tx-d', 'Bread tx-old'] })).toEqual([]);
    });

    it('the request card\'s words came through t() too', async () => {
        await showIn('xx');
        mockTxs = [sold('tx-q', { status: 'requested', postAuthorPublicKey: 'my-pubkey', postType: 'offer' })];
        render(<MessagesPage identity={me} />);
        fireEvent.click(await screen.findByText('Bob'));
        const s = await strip();
        expect(within(s).getByText(xx('Waiting on you: answer'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: ['Bob', 'Bread tx-q'] })).toEqual([]);
    });
});
