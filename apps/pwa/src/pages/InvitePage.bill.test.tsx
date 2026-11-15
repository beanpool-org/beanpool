/**
 * A bill with an invite on the web (DESIGN-getting-paid-fable.md §4.5, slice B3): the fold shows only where the community takes
 * bills; a filled fold goes to the node with its own id; a bill the fold can't read, or the node refuses, makes no invite and
 * no offline ticket; offline, no ticket carries it; Share says a bill comes with the invite, with no amount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async (_pk: string, _for?: string, _vouch?: number, bill?: { id: string; whatFor: string; amount_c: number } | null) => ({
            success: true,
            invite: {
                code: 'INV-ABCD-EFGH', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null,
                ...(bill ? { bill } : {}),
            },
        })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: [] })),
        getInviteTree: vi.fn(async () => []),
        getMyVouching: vi.fn(async () => ({ voucher: false, presets: [], vouchMax: 0, budgetMax: 0, vouchedBy: [] })),
        getVouchersBlock: vi.fn(async () => null),
        getCommunityCard: vi.fn(async () => ({ name: 'Riverside' })),
    };
});

const features = { invites: true, beans: true, bills: true as const };
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features })),
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: vi.fn(() => null) }));

import { InvitePage } from './InvitePage';
import { generateInvite, buildOfflineInviteCode } from '../lib/api';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Rob', createdAt: '2026-10-01T00:00:00.000Z' };

async function openFold() {
    render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('invite-bill-toggle')).toBeInTheDocument());
    expect(screen.queryByTestId('invite-bill-what-for')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invite-bill-toggle'));
}

describe('InvitePage: a bill with the invite (B3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it('no fold where the community takes no bills: the invite is made as before', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { invites: true, beans: true } } as any);
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByText(/Invite Someone/)).toBeInTheDocument());
        expect(screen.queryByTestId('invite-bill-fold')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(generateInvite).toHaveBeenCalledWith(IDENTITY.publicKey, undefined));
        vi.mocked(communityInfoOnce).mockResolvedValue({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features } as any);
    });

    it('a filled fold goes with the invite, as whole hundredths with its own id, and shows what the maker receives', async () => {
        await openFold();
        fireEvent.change(screen.getByTestId('invite-bill-what-for'), { target: { value: 'Power, October' } });
        fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '60' } });
        expect(screen.getByTestId('invite-bill-receive')).toHaveTextContent('You receive 59.10 of 60 Beans: 1.5% goes to the community.');
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(generateInvite).toHaveBeenCalledTimes(1));
        const [pk, forWhom, vouch, bill] = vi.mocked(generateInvite).mock.calls[0];
        expect([pk, forWhom, vouch]).toEqual([IDENTITY.publicKey, undefined, undefined]);
        expect(bill).toMatchObject({ whatFor: 'Power, October', amount_c: 6000 });
        expect(bill!.id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
        await waitFor(() => expect(screen.getByTestId('invite-made-carries')).toHaveTextContent('bill 60 Beans'));
    });

    it('a fold it can\'t read makes no invite: the bill\'s own words', async () => {
        await openFold();
        fireEvent.change(screen.getByTestId('invite-bill-what-for'), { target: { value: 'ab' } });
        fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '5' } });
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Say what the bill is for in 3 to 80 characters.'));
        expect(generateInvite).not.toHaveBeenCalled();
    });

    it('a bill the node refuses makes no invite and no offline ticket: the node\'s words', async () => {
        vi.mocked(generateInvite).mockRejectedValueOnce({ status: 429, code: 'bills_new_people_day', message: "You've sent bills to 3 people you haven't dealt with today. More from 16 Nov, 09:00 UTC." });
        await openFold();
        fireEvent.change(screen.getByTestId('invite-bill-what-for'), { target: { value: 'Seedlings' } });
        fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '5' } });
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("You've sent bills to 3 people you haven't dealt with today."));
        expect(buildOfflineInviteCode).not.toHaveBeenCalled();
    });

    it('offline, no ticket carries a bill: nothing is made', async () => {
        vi.mocked(generateInvite).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await openFold();
        fireEvent.change(screen.getByTestId('invite-bill-what-for'), { target: { value: 'Seedlings' } });
        fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '5' } });
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("A bill can't go with an offline ticket."));
        expect(buildOfflineInviteCode).not.toHaveBeenCalled();
    });

    it('Share says a bill comes with the invite, naming the inviter, with no amount', async () => {
        const shared: string[] = [];
        Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn(async (d: { text: string }) => { shared.push(d.text); }) });
        await openFold();
        fireEvent.change(screen.getByTestId('invite-bill-what-for'), { target: { value: 'Power, October' } });
        fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '60' } });
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(screen.getByTestId('invite-made-carries')).toBeInTheDocument());
        fireEvent.click(screen.getAllByRole('button', { name: /Share invite link/ })[0]);
        await waitFor(() => expect(shared.length).toBe(1));
        expect(shared[0]).toContain("Rob has also sent you a bill to pay in Beans once you're in.");
        expect(shared[0]).not.toMatch(/\b60\b/);
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
});
