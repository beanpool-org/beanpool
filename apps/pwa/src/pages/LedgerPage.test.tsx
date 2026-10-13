import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { LedgerPage } from './LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getBalance, getMembers, getTransactions } from '../lib/api';
import { onSyncActivity } from '../lib/sync';
import { getBlockedUsers } from '../lib/blocklist';

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../components/CommonsInfoModal', () => ({
    CommonsInfoModal: () => null,
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
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

// #1838: levels are merit badges. They gate nothing, so a level not reached yet is something to grow into: no lock, no
// "Locked", and not faded or greyed as if it were out of bounds.
describe('levels a member has not reached yet', () => {
    const LOCK = /🔒|lock/i;
    // The greys the shelf and the badge used for "can't": #9ca3af, #d1d5db, #f9fafb.
    const GREYS = ['rgb(156, 163, 175)', 'rgb(209, 213, 219)', 'rgb(249, 250, 251)'];

    function greyed(root: HTMLElement): string[] {
        return [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].flatMap(el => {
            const s = el.style;
            const faded = s.opacity !== '' && Number(s.opacity) < 1 ? [`opacity ${s.opacity}: ${el.textContent}`] : [];
            return [...faded, ...[s.color, s.backgroundColor].filter(c => GREYS.includes(c)).map(c => `${c}: ${el.textContent}`)];
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getBalance).mockResolvedValue({ balance: 0, floor: 0, commonsBalance: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
    });

    it('shows every level on the shelf without a lock, faded or grey', async () => {
        render(<LedgerPage identity={identity} isMember={true} />);

        const shelf = await screen.findByTestId('levels-shelf');
        expect(within(shelf).getAllByRole('button')).toHaveLength(4);
        expect(shelf.textContent).not.toMatch(LOCK);
        expect(greyed(shelf)).toEqual([]);
    });

    it('names each one as the next level or one up ahead, with what it takes', async () => {
        render(<LedgerPage identity={identity} isMember={true} />);
        const shelf = await screen.findByTestId('levels-shelf');

        for (const [name, badge] of [['Newcomer', "You're here"], ['Resident', 'Next level'], ['Steward', 'Up ahead'], ['Elder', 'Up ahead']]) {
            fireEvent.click(within(shelf).getByRole('button', { name: `View ${name} level details` }));
            const detail = screen.getByTestId('level-detail');
            expect(screen.getByTestId('level-detail-heading').children[2], name).toHaveTextContent(badge);
            expect(detail.textContent, name).not.toMatch(LOCK);
            expect(greyed(detail), name).toEqual([]);
            if (name !== 'Newcomer') expect(detail.textContent, name).toMatch(/Reach \d+ trust \(\d+ to go\)/);
        }
    });
});

describe('a line of Beans from someone the member has blocked', () => {
    const BO = 'b'.repeat(64);
    const CY = 'c'.repeat(64);
    const line = (id: string, from: string, to: string, memo: string) =>
        ({ id, from, to, amount: 3, taxFee: 0, memo, timestamp: '2026-10-01T10:00:00.000Z' });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getBalance).mockResolvedValue({ balance: 5, floor: 0, commonsBalance: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
        vi.mocked(getBlockedUsers).mockReturnValue([BO]);
    });

    async function wallet() {
        render(<LedgerPage identity={identity} isMember={true} />);
        await waitFor(() => expect(getTransactions).toHaveBeenCalled());
        fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));
    }

    it('shows the neutral line in place of the note that came with the Beans', async () => {
        vi.mocked(getTransactions).mockResolvedValue([line('t1', BO, identity.publicKey, 'meet me behind the shed')] as any);
        await wallet();
        expect(await screen.findByText('Beans from a member you blocked')).toHaveClass('italic');
        expect(screen.queryByText(/behind the shed/)).not.toBeInTheDocument();
    });

    it('and as the community sends it, for a note it kept from them', async () => {
        vi.mocked(getBlockedUsers).mockReturnValue([]);
        vi.mocked(getTransactions).mockResolvedValue([line('t1', BO, identity.publicKey, 'Beans from a member you blocked')] as any);
        await wallet();
        expect(await screen.findByText('Beans from a member you blocked')).toHaveClass('italic');
    });

    it("shows anyone else's note, and the member's own to someone blocked", async () => {
        vi.mocked(getTransactions).mockResolvedValue([
            line('t1', CY, identity.publicKey, 'thanks for the eggs'),
            line('t2', identity.publicKey, BO, 'for the bread'),
        ] as any);
        await wallet();
        expect(await screen.findByText('thanks for the eggs')).toBeInTheDocument();
        expect(screen.getByText('for the bread')).toBeInTheDocument();
        expect(screen.queryByText('Beans from a member you blocked')).not.toBeInTheDocument();
    });
});

describe('the Send picker when the node is too busy to send the members list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getBalance).mockResolvedValue({ balance: 5, earnedCredit: 2, floor: 0, commonsBalance: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
        vi.mocked(getBlockedUsers).mockReturnValue([]);
    });

    it('keeps the members it had when a refresh is answered "busy" (503), not an empty list', async () => {
        vi.mocked(getMembers).mockResolvedValueOnce([{ publicKey: 'd'.repeat(64), callsign: 'Dana' }] as any);
        render(<LedgerPage identity={identity} isMember={true} />);
        await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(1));
        fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Send Credits/ }));
        fireEvent.click(screen.getByRole('button', { name: /Select recipient/ }));
        expect(await screen.findByText('Dana')).toBeInTheDocument();

        // The next refresh, past its 2 s coalescing window: the members list refused as the api module throws a 503 from
        // the heavy-read cap (apps/server/src/heavy-reads.ts).
        vi.mocked(getMembers).mockRejectedValueOnce(Object.assign(new Error('This community is busy right now.'), { status: 503, code: 'heavy_read_busy' }));
        const sync = vi.mocked(onSyncActivity).mock.calls.at(-1)![0] as () => Promise<void> | undefined;
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 5000);
            await act(async () => { await sync(); });
        } finally {
            vi.useRealTimers();
        }
        expect(getMembers).toHaveBeenCalledTimes(2);
        expect(screen.getByText('Dana')).toBeInTheDocument();
        expect(screen.queryByText('No members found')).not.toBeInTheDocument();
    });
});
