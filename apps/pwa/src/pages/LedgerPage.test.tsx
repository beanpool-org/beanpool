import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { LedgerPage } from './LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getBalance, getTransactions } from '../lib/api';

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../components/CommonsInfoModal', () => ({
    CommonsInfoModal: () => null,
}));

vi.mock('../lib/api', () => ({
    getBalance: vi.fn(),
    getTransactions: vi.fn(async () => []),
    getMembers: vi.fn(async () => []),
    sendTransfer: vi.fn(),
}));

const identity: BeanPoolIdentity = {
    publicKey: 'viewer-pubkey',
    privateKey: 'viewer-private-key',
    callsign: 'Visitor',
    createdAt: '2026-09-17T00:00:00.000Z',
};

describe('LedgerPage for a guest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The node has no member for a guest's key.
        vi.mocked(getBalance).mockRejectedValue(new Error('Member not found'));
    });

    it('does not ask the node for a guest\'s balance and shows no error', async () => {
        render(<LedgerPage identity={identity} isMember={false} />);

        await screen.findByText('Visitor');
        // Let any refresh settle before asserting nothing went out.
        await new Promise(r => setTimeout(r, 0));
        expect(getBalance).not.toHaveBeenCalled();
        expect(getTransactions).not.toHaveBeenCalled();
        expect(screen.queryByText('Failed to load balance')).not.toBeInTheDocument();
    });

    it('clears the error once the viewer turns out to be a guest', async () => {
        // App starts out assuming a member and learns guest status after its membership check.
        const { rerender } = render(<LedgerPage identity={identity} />);
        expect(await screen.findByText('Failed to load balance')).toBeInTheDocument();

        rerender(<LedgerPage identity={identity} isMember={false} />);

        await waitFor(() => expect(screen.queryByText('Failed to load balance')).not.toBeInTheDocument());
    });

    it('still tells a member when their balance failed to load', async () => {
        render(<LedgerPage identity={identity} isMember={true} />);

        expect(await screen.findByText('Failed to load balance')).toBeInTheDocument();
        expect(getBalance).toHaveBeenCalledWith('viewer-pubkey');
    });
});

describe('LedgerPage at 320px with 1.3x text', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getBalance).mockResolvedValue({ balance: 0, floor: 0, commonsBalance: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
    });

    it('lets the level heading wrap so its "You\'re here" badge stays inside the card', async () => {
        render(<LedgerPage identity={identity} isMember={true} />);

        const heading = await screen.findByTestId('level-detail-heading');
        expect(heading).toHaveClass('flex-wrap');
        // The name keeps at least 7rem, so the badge moves to its own line instead of squeezing it.
        expect(heading.children[1]).toHaveClass('flex-1', 'min-w-[7rem]');
        expect(heading.children[2]).toHaveTextContent("You're here");
        expect(heading.children[2]).toHaveClass('whitespace-nowrap');
    });

    it('keeps the trust tiles narrow enough for their labels on a small phone', async () => {
        render(<LedgerPage identity={identity} isMember={true} />);

        const grid = await screen.findByTestId('trust-builders');
        expect(grid).toHaveClass('grid-cols-3', 'gap-1.5', 'sm:gap-3');
        for (const tile of Array.from(grid.children)) {
            expect(tile).toHaveClass('min-w-0', 'px-1.5', 'sm:p-3');
        }
        expect(screen.getByText('PARTNERS')).not.toHaveClass('tracking-wider');
    });
});
