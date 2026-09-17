import { render, screen, waitFor } from '@testing-library/react';
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
