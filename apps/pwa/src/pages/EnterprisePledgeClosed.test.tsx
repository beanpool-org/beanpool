import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

// The node takes a pledge only while an enterprise is active (#1374 NB, 2026-10-02). The pledge box used to show on a
// funded enterprise too, and a member who filled it in was told "Pledge Failed" with the node's refusal. Now a funded or
// closed enterprise shows a plain sentence where the box was.

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

const member: BeanPoolIdentity = {
    publicKey: 'member-pubkey',
    privateKey: 'member-private-key-hex',
    callsign: 'Ann',
    createdAt: '2026-09-17T00:00:00.000Z',
};

const well = (status: string, currentAmount: number) => ({
    publicKey: 'enterprise-well-pubkey',
    name: 'Village Well',
    purpose: 'Clean water',
    avatar: null,
    balance: currentAmount,
    creditLine: 0,
    goalAmount: 20,
    currentAmount,
    lifecycle: 'bounded',
    status,
    paused: false,
    keepers: [{ publicKey: 'keeper-pubkey', callsign: 'Keeper' }],
    posts: [],
    flow: [],
});

const ledger = {
    enterprise: { publicKey: 'enterprise-well-pubkey', name: 'Village Well', status: 'active', balance: 0 },
    period: { since: null, until: null },
    summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 0, endingBalance: 0, transactionCount: 0 },
    entries: [],
};

async function openWell(status: string, currentAmount: number) {
    vi.spyOn(api, 'getTreasury').mockResolvedValue(well(status, currentAmount) as any);
    render(<TreasuryDetailPage identity={member} isMember={true} pubkey="enterprise-well-pubkey" onBack={() => {}} />);
    await screen.findByRole('heading', { level: 1, name: 'Village Well' });
}

describe('The pledge box on an enterprise that is not taking pledges', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: [] } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(ledger as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: {}, messages: [], readOnly: false } as any);
    });

    it('a funded enterprise says it has reached its goal, with no box to pledge in', async () => {
        await openWell('funded', 20);
        expect(screen.getByText('This enterprise has reached its goal, so it isn’t taking more pledges.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Amount (🫘)')).not.toBeInTheDocument();
        expect(screen.queryByText('Back this initiative')).not.toBeInTheDocument();
    });

    it('a funded enterprise whose raised figure reads short of the goal is still not taking pledges: the node goes by its status', async () => {
        await openWell('funded', 15);
        expect(screen.getByText('This enterprise has reached its goal, so it isn’t taking more pledges.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
    });

    it('an enterprise winding up, or closed, says so, with no box', async () => {
        await openWell('winding_up', 5);
        expect(screen.getByText('This enterprise is winding up, so it isn’t taking pledges.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
    });

    it('a closed enterprise says it has closed, with no box', async () => {
        await openWell('completed', 5);
        expect(screen.getByText('This enterprise has closed, so it isn’t taking pledges.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pledge Beans/ })).not.toBeInTheDocument();
    });

    it('an active enterprise still has its pledge box, and no such sentence', async () => {
        await openWell('active', 5);
        expect(screen.getByText('Back this initiative')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Pledge Beans/ })).toBeInTheDocument();
        expect(screen.queryByText(/isn’t taking/)).not.toBeInTheDocument();
    });
});
