import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

// Enterprise map pins are public, so tapping one as a guest must open the enterprise.
// A guest is a local key the node has no member for: /api/ledger/balance answers
// "Member not found" for it, and that used to replace the whole page with an error.

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

vi.mock('../components/EnterpriseLocationPicker', () => ({
    EnterpriseLocationPicker: () => null,
}));

const guestIdentity: BeanPoolIdentity = {
    publicKey: 'guest-pubkey-unknown-to-node',
    privateKey: 'guest-private-key-hex',
    callsign: 'Visitor',
    createdAt: '2026-09-17T00:00:00.000Z',
};

const bakery = {
    publicKey: 'enterprise-bakery-pubkey',
    name: 'Community Bakery',
    purpose: 'Fresh sourdough for everyone',
    avatar: null,
    balance: 150,
    creditLine: 200,
    goalAmount: 500,
    currentAmount: 150,
    lifecycle: 'bounded',
    status: 'active',
    paused: false,
    keepers: [{ publicKey: 'keeper-alice-pubkey', callsign: 'Alice' }],
    posts: [],
    flow: [],
};

const ledger = {
    enterprise: { publicKey: 'enterprise-bakery-pubkey', name: 'Community Bakery', status: 'active', balance: 150 },
    period: { since: null, until: null },
    summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 150, endingBalance: 150, transactionCount: 0 },
    entries: [],
};

describe('Enterprise page for a guest', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getTreasury').mockResolvedValue(bakery);
        vi.spyOn(api, 'getBalance').mockRejectedValue(new Error('Member not found'));
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(ledger as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({
            conversation: {},
            messages: [{
                id: 'msg-1',
                conversationId: 'enterprise-bakery-pubkey',
                authorPubkey: 'keeper-alice-pubkey',
                authorCallsign: 'Alice',
                ciphertext: btoa('Loaves are ready at 7'),
                nonce: '',
                timestamp: '2026-09-16T07:00:00.000Z',
                type: 'text',
            }],
            readOnly: false,
        } as any);
    });

    it('opens the enterprise without asking the node for the guest\'s own balance', async () => {
        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Community Bakery' })).toBeInTheDocument();
        expect(screen.queryByText('Error loading enterprise')).not.toBeInTheDocument();
        expect(api.getBalance).not.toHaveBeenCalled();

        // What the node returned is shown: purpose, funding, P&L, the thread.
        expect(screen.getByText('Fresh sourdough for everyone')).toBeInTheDocument();
        expect(screen.getByText('Funding Progress')).toBeInTheDocument();
        expect(screen.getByText('Income & Spend (P&L)')).toBeInTheDocument();
        expect(await screen.findByText('Loaves are ready at 7')).toBeInTheDocument();
    });

    it('hides the member-only actions: pledging, asking to be a keeper, posting in the thread', async () => {
        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        await screen.findByRole('heading', { level: 1, name: 'Community Bakery' });
        await screen.findByText('Loaves are ready at 7');

        expect(screen.queryByText('Back this initiative')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
        expect(screen.queryByText('Ask to Join as a Keeper')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Message the enterprise')).not.toBeInTheDocument();
        expect(screen.getByTestId('thread-guest-note')).toHaveTextContent('Join the community to post here.');
    });

    it('shows P&L and thread as member-only, not as errors, when the node refuses a guest', async () => {
        vi.spyOn(api, 'getEnterpriseLedger').mockRejectedValue(new Error('Members only'));
        vi.spyOn(api, 'getEnterpriseThread').mockRejectedValue(new Error('Members only'));

        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        await screen.findByRole('heading', { level: 1, name: 'Community Bakery' });
        expect(await screen.findByTestId('ledger-members-only')).toBeInTheDocument();
        expect(await screen.findByTestId('thread-members-only')).toBeInTheDocument();
        expect(screen.queryByText('Members only')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
        expect(screen.queryByText('Error loading enterprise')).not.toBeInTheDocument();
    });

    it('still opens the enterprise when a signed-in viewer\'s balance lookup fails', async () => {
        // Membership not yet known (isMember omitted): the balance call goes out and fails.
        render(<TreasuryDetailPage identity={guestIdentity} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Community Bakery' })).toBeInTheDocument();
        await waitFor(() => expect(api.getBalance).toHaveBeenCalledWith('guest-pubkey-unknown-to-node'));
        expect(screen.queryByText('Error loading enterprise')).not.toBeInTheDocument();
        expect(screen.queryByText('Member not found')).not.toBeInTheDocument();
    });

    it('keeps the member actions for a member', async () => {
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: [] } as any);

        render(<TreasuryDetailPage identity={guestIdentity} isMember={true} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        await screen.findByRole('heading', { level: 1, name: 'Community Bakery' });
        expect(screen.getByText('Back this initiative')).toBeInTheDocument();
        expect(screen.getByText('Ask to Join as a Keeper')).toBeInTheDocument();
        expect(await screen.findByLabelText('Message the enterprise')).toBeInTheDocument();
    });
});

describe('Enterprise page at 320px with 1.3x text', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getBalance').mockRejectedValue(new Error('Member not found'));
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(ledger as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: {}, messages: [], readOnly: true } as any);
    });

    it('falls back to the no-avatar placeholder when the avatar image fails to load', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue({ ...bakery, avatar: '/uploads/avatars/missing.png' });
        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        await screen.findByRole('heading', { level: 1, name: 'Community Bakery' });
        const img = screen.getByRole('img', { name: 'Community Bakery' });
        expect(screen.queryByTestId('enterprise-avatar-placeholder')).not.toBeInTheDocument();

        fireEvent.error(img);

        expect(await screen.findByTestId('enterprise-avatar-placeholder')).toHaveTextContent('🌱');
        expect(screen.queryByRole('img', { name: 'Community Bakery' })).not.toBeInTheDocument();
    });

    it('lets the enterprise name wrap instead of truncating it', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(bakery);
        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        const heading = await screen.findByRole('heading', { level: 1, name: 'Community Bakery' });
        expect(heading).not.toHaveClass('truncate');
        expect(heading).toHaveClass('line-clamp-2');
    });

    it('stacks each P&L transaction below sm instead of a six-column table that scrolls sideways', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(bakery);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
            ...ledger,
            summary: { totalIncome: 36, totalSpend: 0, netChange: 35.82, startingBalance: 0, endingBalance: 35.82, transactionCount: 3 },
            entries: [0, 1, 2].map(i => ({
                id: `tx-${i}`, timestamp: '2026-07-27T00:06:00.000Z', direction: 'income', amount: 12, fee: 0.06, netAmount: 11.94,
                counterparty: 'escrow_p', counterpartyName: 'Escrow: 1 dozen eggs', memo: 'Escrow payment: 1 dozen eggs',
                runningBalance: [11.94, 23.88, 35.82][i], authSigner: null,
            })),
        } as any);
        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        const region = await screen.findByRole('region', { name: 'Enterprise ledger transactions' });
        // Only sm and up may scroll sideways; the table has no minimum width below sm.
        expect(region).not.toHaveClass('overflow-x-auto');
        expect(region).toHaveClass('sm:overflow-x-auto');
        const table = region.querySelector('table')!;
        expect(table).toHaveClass('block', 'sm:table', 'sm:min-w-[500px]');
        expect(table).not.toHaveClass('min-w-[500px]');
        expect(region.querySelector('thead')).toHaveClass('hidden', 'sm:table-header-group');

        const rows = screen.getAllByTestId('ledger-entry');
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row).toHaveClass('grid', 'sm:table-row');
            // The empty "went out" cell of an income row is not drawn in the stacked layout.
            const cells = row.querySelectorAll('td');
            expect(cells[4]).toHaveClass('hidden', 'sm:table-cell');
            expect(cells[3]).toHaveTextContent('+12.00 🫘');
        }
    });

    it('explains the gap between came in and net change: came in is before fees', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(bakery);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
            ...ledger,
            summary: { totalIncome: 36, totalSpend: 0, netChange: 35.82, startingBalance: 0, endingBalance: 35.82, transactionCount: 3 },
        } as any);
        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        expect(await screen.findByTestId('ledger-fee-note')).toHaveTextContent('Came in is before fees: 0.18 🫘 in fees came off it.');
        // Nothing went out: no "-0.00".
        expect(screen.queryByText(/-0\.00/)).not.toBeInTheDocument();
        expect(screen.getByText('Went out').nextElementSibling).toHaveTextContent('0.00 🫘');
    });

    it('shows no fee note when the summary already adds up', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(bakery);
        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        await screen.findByText('Income & Spend (P&L)');
        await screen.findByText('No transactions recorded for this period.');
        expect(screen.queryByTestId('ledger-fee-note')).not.toBeInTheDocument();
    });

    it('drops the balance tiles to one column when two would not fit "Uncapped"', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue({ ...bakery, workingCapitalCeiling: null });
        render(<TreasuryDetailPage identity={guestIdentity} isMember={false} pubkey="enterprise-bakery-pubkey" onBack={() => {}} />);

        await screen.findByRole('heading', { level: 1, name: 'Community Bakery' });
        const tiles = screen.getByTestId('enterprise-balance-tiles');
        expect(tiles).toHaveTextContent('Uncapped');
        // rem-based minimum, so the switch follows the phone's text size as well as its width.
        expect(tiles).toHaveClass('grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]');
        expect(tiles).not.toHaveClass('grid-cols-2');
    });
});
