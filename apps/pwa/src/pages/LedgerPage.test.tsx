import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forgetRecentLookups } from '../lib/members-on-demand';

// Each case asks the node afresh: an answer kept from the last case (the search's and near read's recent answers) isn't this one's.
beforeEach(() => forgetRecentLookups());
import React from 'react';
import { LedgerPage } from './LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getBalance, getMembers, getMemberCards, getTransactions } from '../lib/api';
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
    getMemberCards: vi.fn(async () => []),
    sendTransfer: vi.fn(),
}));

// The node's /api/community/info, read once per page load: a local community (no members on demand) unless a test says.
const info = vi.hoisted(() => ({ value: { profile: 'local', features: {} } as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => info.value) }));
import { communityInfoOnce } from '../lib/visitor-lobby-gate';

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

    // PR #2020 fix round 2: side by side, the Wallet's Overdraft Floor and Commons Pool pushed Commons Pool past the right
    // edge (343 px in a 320 px window). Each tile now asks 9rem, so the pair stacks on a small phone with large text, and
    // can shrink below its words' width; a long number wraps rather than spilling out. Same tiles in preview.
    for (const preview of [false, true]) {
        it(`lets the Wallet's Overdraft Floor and Commons Pool tiles stack rather than run off the edge${preview ? ' (preview)' : ''}`, async () => {
            render(<LedgerPage identity={identity} isMember={true} preview={preview} />);
            fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));

            const row = screen.getByTestId('ledger-wallet-tiles');
            expect(row).toHaveClass('flex', 'flex-wrap');
            expect(row.children).toHaveLength(2);
            expect(row.children[0]).toHaveTextContent('Overdraft Floor');
            expect(row.children[1]).toHaveTextContent('Commons Pool');
            for (const tile of Array.from(row.children)) {
                expect(tile).toHaveClass('flex-1', 'basis-[9rem]', 'min-w-0', 'p-4', 'sm:p-5');
                expect(tile).not.toHaveClass('p-5');
                expect(tile.children[1]).toHaveClass('flex-wrap', '[overflow-wrap:anywhere]');
            }
        });
    }
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

describe('the Ledger with members on demand (review of #1861, N1)', () => {
    const DANA = 'd'.repeat(64);
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getBalance).mockResolvedValue({ balance: 5, earnedCredit: 2, floor: 0, commonsBalance: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
        vi.mocked(getBlockedUsers).mockReturnValue([]);
    });
    afterEach(() => { info.value = { profile: 'local', features: {} }; });

    const openPicker = async () => {
        fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Send Credits/ }));
        fireEvent.click(screen.getByRole('button', { name: /Select recipient/ }));
    };
    const syncPast2s = async () => {
        const sync = vi.mocked(onSyncActivity).mock.calls.at(-1)![0] as () => Promise<void> | undefined;
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 5000);
            await act(async () => { await sync(); });
        } finally {
            vi.useRealTimers();
        }
    };

    it('global: no whole-directory read at open or on refresh; the Send picker asks the node by name', async () => {
        info.value = { profile: 'global', features: { membersOnDemand: true, beans: false } };
        vi.mocked(getMemberCards).mockResolvedValue([{ publicKey: DANA, callsign: 'Dana', joinedAt: '2026-01-01' }]);
        render(<LedgerPage identity={identity} isMember={true} />);
        await waitFor(() => expect(getBalance).toHaveBeenCalled());
        await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
        await openPicker();
        expect(await screen.findByTestId('ledger-picker-note')).toHaveTextContent('Type at least 2 letters of a name.');
        fireEvent.change(screen.getByPlaceholderText('Search members...'), { target: { value: 'da' } });
        fireEvent.click(await screen.findByRole('button', { name: /Dana/ }));
        expect(vi.mocked(getMemberCards).mock.calls.map(c => c[0])).toEqual(['/api/members?q=da&limit=20']);
        expect(screen.getByRole('button', { name: /Dana/ })).toBeInTheDocument();
        await syncPast2s();
        expect(getBalance).toHaveBeenCalledTimes(2);
        expect(getMembers).not.toHaveBeenCalled();
    });

    it('global: a search that fails says so, never "nobody"', async () => {
        info.value = { profile: 'global', features: { membersOnDemand: true } };
        vi.mocked(getMemberCards).mockRejectedValue(new TypeError('Failed to fetch'));
        render(<LedgerPage identity={identity} isMember={true} />);
        await openPicker();
        fireEvent.change(screen.getByPlaceholderText('Search members...'), { target: { value: 'da' } });
        await waitFor(() => expect(screen.getByTestId('ledger-picker-note')).toHaveTextContent("Couldn't search just now."));
        expect(screen.queryByText(/Nobody here/)).toBeNull();
        expect(screen.queryByText('No members found')).toBeNull();
        expect(getMembers).not.toHaveBeenCalled();
    });

    // The confirmation review of #1861's fix round, F2 (LG7): the node's answer can hold the member themself.
    it('global: the search never offers the member themself', async () => {
        info.value = { profile: 'global', features: { membersOnDemand: true } };
        vi.mocked(getMemberCards).mockResolvedValue([
            { publicKey: identity.publicKey, callsign: 'Dalia-me', joinedAt: '2026-01-01' },
            { publicKey: DANA, callsign: 'Dana', joinedAt: '2026-01-01' },
        ]);
        render(<LedgerPage identity={identity} isMember={true} />);
        await openPicker();
        fireEvent.change(screen.getByPlaceholderText('Search members...'), { target: { value: 'da' } });
        expect(await screen.findByRole('button', { name: /Dana/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Dalia-me/ })).toBeNull();
    });

    it('local: the directory is read as before, once at open and on each refresh, and no small form is asked', async () => {
        vi.mocked(getMembers).mockResolvedValue([{ publicKey: DANA, callsign: 'Dana' }] as any);
        render(<LedgerPage identity={identity} isMember={true} />);
        await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(1));
        await openPicker();
        expect(await screen.findByText('Dana')).toBeInTheDocument();
        // F2 (LG6): typing in a local node's picker filters the list it has; it never searches the node.
        fireEvent.change(screen.getByPlaceholderText('Search members...'), { target: { value: 'da' } });
        await new Promise(r => setTimeout(r, 600));
        expect(screen.getByText('Dana')).toBeInTheDocument();
        await syncPast2s();
        expect(getMembers).toHaveBeenCalledTimes(2);
        expect(getMemberCards).not.toHaveBeenCalled();
    });

    // F2 (LG9): a guest on a local node never reads the directory, as before the switch.
    it('local: a guest reads no directory, at open or once the node has said it reads whole', async () => {
        render(<LedgerPage identity={identity} isMember={false} />);
        await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
        await act(async () => { await new Promise(r => setTimeout(r, 50)); });
        expect(getMembers).not.toHaveBeenCalled();
        expect(getMemberCards).not.toHaveBeenCalled();
    });
});

describe('the Ledger in preview (a node that previews Beans): Example Valley, and nothing asked of the node', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        info.value = { profile: 'global', features: { beans: false, showcase: true } };
        vi.mocked(getBalance).mockResolvedValue({ balance: 4321, earnedCredit: 9, floor: -50, commonsBalance: 7, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
        vi.mocked(getTransactions).mockResolvedValue([{ id: 'own-tx', from: 'someone', to: 'viewer-pubkey', amount: 77, memo: 'My own line', timestamp: '2026-10-15T00:00:00.000Z' }]);
    });
    afterEach(() => { info.value = { profile: 'local', features: {} }; });

    it("reads no balance, transactions or members, polls nothing and takes up no socket nudge; the reader's own name never shows", async () => {
        render(<LedgerPage identity={identity} isMember={true} preview />);
        expect(screen.getByTestId('ledger-balance')).toHaveTextContent('+85.0B');
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        expect(screen.getByText('A loaf of bread')).toBeInTheDocument();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(getBalance).not.toHaveBeenCalled();
        expect(getTransactions).not.toHaveBeenCalled();
        expect(getMembers).not.toHaveBeenCalled();
        expect(getMemberCards).not.toHaveBeenCalled();
        expect(onSyncActivity).not.toHaveBeenCalled();
        expect(screen.queryByText('Visitor')).toBeNull();
        expect(screen.queryByText(/Failed to load/)).toBeNull();
    });

    it("turns live (BeanID's flip): the sample goes at once, and the member's own balance and rows are read and shown", async () => {
        const { rerender } = render(<LedgerPage identity={identity} isMember={true} preview />);
        expect(screen.getByTestId('ledger-balance')).toHaveTextContent('+85.0B');
        rerender(<LedgerPage identity={identity} isMember={true} />);
        // Before the member's own land: never Example Valley's 85 Beans or name as theirs.
        expect(screen.getByTestId('ledger-balance')).not.toHaveTextContent('85.0');
        expect(screen.queryByText('an example member')).toBeNull();
        await waitFor(() => expect(screen.getByTestId('ledger-balance')).toHaveTextContent('+4321.0B'));
        expect(getBalance).toHaveBeenCalledWith('viewer-pubkey');
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        expect(screen.getByText('My own line')).toBeInTheDocument();
        expect(screen.queryByText('A loaf of bread')).toBeNull();
        expect(screen.queryByTestId('local-community-strip')).toBeNull();
    });

    it("turns to preview while the member's own are on screen: Example Valley's at once, never the member's own under the marker", async () => {
        const { rerender } = render(<LedgerPage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getByTestId('ledger-balance')).toHaveTextContent('+4321.0B'));
        rerender(<LedgerPage identity={identity} isMember={true} preview />);
        expect(screen.getByTestId('ledger-balance')).toHaveTextContent('+85.0B');
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        expect(screen.queryByText('My own line')).toBeNull();
        expect(screen.getByText('A loaf of bread')).toBeInTheDocument();
    });
});

// PR #2020 fix round 1: the Wallet's Community Circulation box. Its figure is core's monthlyCirculation (the ledger's own
// brackets), its colours are the chip roles (no raw hex, so it reads as a card in dark), and at or under the 200 Beans
// fee-free line it says so in words instead of "−0.000 /mo" and "≈ 0.00% /mo".
describe('the Wallet\'s Community Circulation box', () => {
    const walletWith = async (balance: number) => {
        vi.mocked(getBalance).mockResolvedValue({ balance, floor: 0, commonsBalance: 0, callsign: 'Visitor', tier: { name: 'Newcomer' } } as any);
        render(<LedgerPage identity={identity} isMember={true} />);
        await waitFor(() => expect(screen.getByTestId('ledger-balance')).toHaveTextContent(`+${balance.toFixed(1)}B`));
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        return screen.getByTestId('ledger-circulation');
    };

    beforeEach(() => { vi.clearAllMocks(); });

    for (const balance of [85, 200]) {
        it(`at ${balance} Beans says in words that nothing goes to the Commons, with no amount or rate`, async () => {
            const box = await walletWith(balance);
            expect(box).toHaveTextContent('Nothing goes to the Commons while you hold 200 Beans or less.');
            expect(within(box).queryByTestId('ledger-circulation-amount')).toBeNull();
            expect(box.textContent).not.toMatch(/0\.00|%/);
        });
    }

    it('over 200 Beans shows the month\'s amount to 2 decimals and the share of the balance', async () => {
        // 750: 300 at 1 % + 250 at 1.5 % = 6.75 a month, 0.90 % of the balance.
        const box = await walletWith(750);
        expect(within(box).getByTestId('ledger-circulation-amount')).toHaveTextContent('−6.75');
        expect(box).toHaveTextContent('about 0.90% of your balance');
        expect(box.textContent).not.toMatch(/Nothing goes/);
    });

    it('is drawn from the colour library: ok chip roles, warn above 1000, no inline colour', async () => {
        const box = await walletWith(750);
        expect(box).toHaveClass('bg-bp-chip-ok-tint', 'text-bp-chip-ok-ink');
        expect([box, ...Array.from(box.querySelectorAll<HTMLElement>('*'))].map(el => el.getAttribute('style')).filter(Boolean)).toEqual([]);
    });

    it('turns to the warn roles above 1000 Beans', async () => {
        const box = await walletWith(1500);
        expect(box).toHaveClass('bg-bp-chip-warn-tint', 'text-bp-chip-warn-ink');
        expect(within(box).getByTestId('ledger-circulation-amount')).toHaveTextContent('−20.50');
    });
});
