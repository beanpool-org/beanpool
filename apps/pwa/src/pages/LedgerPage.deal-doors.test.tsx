import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { LedgerPage } from './LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getBalance, getTransactions, type MarketplaceTransaction } from '../lib/api';
import { forgetRecentLookups } from '../lib/members-on-demand';
import { resetReaderFeaturesOnce } from '../lib/features';

// The Ledger's doors to deals (deals S6, scratch/fable-design/DESIGN-deals-fable.md §2.2 and §5): what is held in trust
// opens Your deals on In Progress, and a hold's row opens its deal. Both go through the app's own onNavigate, to the
// Market: 'deals_active' is the Market's own word for the sheet on In Progress; a deal opens as its listing (the page that
// shows the member's deal on it), as every other door on the web does.

beforeEach(() => { forgetRecentLookups(); resetReaderFeaturesOnce(); });

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/api', () => ({
    getBalance: vi.fn(),
    getTransactions: vi.fn(async () => []),
    getMembers: vi.fn(async () => []),
    getMemberCards: vi.fn(async () => []),
    sendTransfer: vi.fn(),
    saveHomePreferences: vi.fn(async () => ({ success: true })),
    getCommunityMe: vi.fn(async () => ({ features: null })),
}));
vi.mock('../lib/identity', async (orig) => ({
    ...(await orig<typeof import('../lib/identity')>()),
    loadIdentity: vi.fn(async () => ({ publicKey: 'viewer-pubkey', privateKey: 'viewer-private-key', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' })),
}));
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ profile: 'local', features: {} })),
    resetCommunityInfoOnce: vi.fn(),
}));

const ME = 'viewer-pubkey';
const MIA = 'm'.repeat(64);
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'viewer-private-key', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' };

const LISTING = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_LISTING = '223e4567-e89b-12d3-a456-426614174001';

const deal = (id: string, postId: string, status: MarketplaceTransaction['status'], credits: number, side: { buyer?: string; seller?: string } = {}): MarketplaceTransaction => ({
    id, postId, postTitle: 'Fix the gate', buyerPublicKey: side.buyer ?? ME, buyerCallsign: 'Visitor', sellerPublicKey: side.seller ?? MIA, sellerCallsign: 'Mia',
    credits, status, createdAt: '2026-10-16T09:00:00.000Z',
});
const line = (id: string, from: string, to: string, memo: string, amount = 30) =>
    ({ id, from, to, amount, taxFee: 0, memo, timestamp: '2026-10-16T10:00:00.000Z' });

async function wallet(deals: MarketplaceTransaction[], onNavigate = vi.fn()) {
    render(<LedgerPage identity={identity} isMember={true} onNavigate={onNavigate} deals={deals} />);
    await waitFor(() => expect(getTransactions).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));
    return onNavigate;
}

describe('the Ledger opens the deals behind what is held in trust (deals S6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getBalance).mockResolvedValue({ balance: 5, floor: 0, commonsBalance: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
    });

    it('the Held in Trust total is a button, at least 44 px, that opens Your deals on In Progress', async () => {
        // Two deals held as the payer (30 + 12.5), a request (holds nothing), a deal held from the other side, and a finished one.
        const onNavigate = await wallet([
            deal('d1', LISTING, 'pending', 30),
            deal('d2', OTHER_LISTING, 'pending', 12.5),
            deal('d3', LISTING, 'requested', 99),
            deal('d4', LISTING, 'pending', 70, { buyer: MIA, seller: ME }),
            deal('d5', LISTING, 'completed', 8),
        ]);
        const total = await screen.findByTestId('ledger-in-escrow');
        expect(total.tagName).toBe('BUTTON');
        expect(total).toHaveClass('min-h-[44px]');
        expect(total).toHaveTextContent('Held in Trust');
        expect(total).toHaveTextContent('42.5');
        expect(total).toHaveTextContent('Your deals in progress');

        fireEvent.click(total);
        // 'deals_active' is how the Market is told to open its deals sheet on In Progress (MarketplacePage openPostId).
        expect(onNavigate).toHaveBeenCalledExactlyOnceWith('marketplace', 'deals_active');
    });

    it('nothing held, no total and no door', async () => {
        await wallet([deal('d1', LISTING, 'requested', 30), deal('d2', LISTING, 'completed', 30), deal('d3', LISTING, 'pending', 30, { buyer: MIA, seller: ME })]);
        await screen.findByText('Commons Pool');
        expect(screen.queryByTestId('ledger-in-escrow')).not.toBeInTheDocument();
    });

    it('a hold whose deal the member has is one button, at least 44 px, that opens the deal\'s listing', async () => {
        vi.mocked(getTransactions).mockResolvedValue([line('t1', ME, 'escrow_d1', `Escrow hold for offer ${LISTING}`)] as any);
        const onNavigate = await wallet([deal('d1', LISTING, 'pending', 30)]);
        const held = await screen.findByTestId('ledger-held-row');
        expect(held.tagName).toBe('BUTTON');
        expect(held).toHaveClass('min-h-[44px]');
        // Its name is the row's own words, and what it does.
        expect(held).toHaveTextContent('Sent');
        expect(held).toHaveTextContent('Held in trust for offer');
        expect(held).toHaveTextContent('Opens the deal');
        expect(screen.getByRole('button', { name: /Sent.*Held in trust for offer.*Opens the deal/ })).toBe(held);

        fireEvent.click(held);
        expect(onNavigate).toHaveBeenCalledExactlyOnceWith('marketplace', LISTING);
    });

    it('the row is the one door: no listing id and no View Offer link inside the button', async () => {
        vi.mocked(getTransactions).mockResolvedValue([line('t1', ME, 'escrow_d1', `Escrow hold for offer ${LISTING}`)] as any);
        await wallet([deal('d1', LISTING, 'pending', 30)]);
        const held = await screen.findByTestId('ledger-held-row');
        expect(held.textContent).not.toContain(LISTING);
        expect(within(held).queryByText('View Offer')).not.toBeInTheDocument();
        expect(within(held).queryAllByRole('button')).toHaveLength(0);
    });

    it("finds the deal by the account's deal id, not the listing the note names: the payout and an older hold keyed by the listing too", async () => {
        vi.mocked(getTransactions).mockResolvedValue([
            line('t1', 'escrow_d2', ME, 'Escrow payout for completed post (none)', 12.5),
            line('t2', ME, `escrow_${LISTING}`, 'Escrow hold', 8),
        ] as any);
        const onNavigate = await wallet([deal('d2', OTHER_LISTING, 'completed', 12.5), deal('d9', LISTING, 'pending', 8)]);
        const rows = await screen.findAllByTestId('ledger-held-row');
        expect(rows).toHaveLength(2);
        fireEvent.click(rows[0]);
        expect(onNavigate).toHaveBeenLastCalledWith('marketplace', OTHER_LISTING);
        fireEvent.click(rows[1]);
        expect(onNavigate).toHaveBeenLastCalledWith('marketplace', LISTING);
    });

    it("a hold the member's deals don't have falls back to the listing its note names; with neither it is just a row", async () => {
        vi.mocked(getTransactions).mockResolvedValue([
            line('t1', ME, 'escrow_gone', `Escrow hold for offer ${LISTING}`),
            line('t2', ME, 'escrow_gone2', 'Adjust escrow for 3 hours', 5),
            line('t3', MIA, ME, `Paid for ${LISTING} thanks`, 40),
        ] as any);
        const onNavigate = await wallet([]);
        const rows = await screen.findAllByTestId('ledger-held-row');
        expect(rows).toHaveLength(1);
        fireEvent.click(rows[0]);
        expect(onNavigate).toHaveBeenCalledExactlyOnceWith('marketplace', LISTING);
        // The adjustment names no listing and no deal this member has: a plain row, not a button.
        const plain = screen.getByText('Adjust trust for 3 hours');
        expect(plain.closest('button')).toBeNull();
        // Beans from a member that name a listing keep the inline link.
        expect(screen.getByRole('button', { name: 'View Offer' })).toBeInTheDocument();
    });

    it('a Ledger drawn without a way to navigate has no doors', async () => {
        vi.mocked(getTransactions).mockResolvedValue([line('t1', ME, 'escrow_d1', `Escrow hold for offer ${LISTING}`)] as any);
        render(<LedgerPage identity={identity} isMember={true} deals={[deal('d1', LISTING, 'pending', 30)]} />);
        await waitFor(() => expect(getTransactions).toHaveBeenCalled());
        fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));
        await screen.findByText('Commons Pool');
        expect(screen.queryByTestId('ledger-in-escrow')).not.toBeInTheDocument();
        expect(screen.queryByTestId('ledger-held-row')).not.toBeInTheDocument();
    });
});
