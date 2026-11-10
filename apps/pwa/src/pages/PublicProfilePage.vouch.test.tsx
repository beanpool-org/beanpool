import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        getMemberProfile: vi.fn(async (targetPubkey: string) => ({
            publicKey: targetPubkey,
            callsign: 'sam',
            bio: 'Hello world',
            created_at: '2026-10-01T00:00:00.000Z',
        })),
        getMemberRatings: vi.fn(async () => ({ average: 5, count: 1, ratings: [], asProvider: 1, asReceiver: 0 })),
        getMarketplacePosts: vi.fn(async () => []),
        getBalance: vi.fn(async () => ({ balance_c: 10000, earnedCredit_c: 5000, allowance: 100 })),
        getRatingsGiven: vi.fn(async () => []),
        getFriends: vi.fn(async () => []),
        getTrustProfile: vi.fn(async () => ({
            tier: 'trusted',
            mutualCount: 0,
            mutualConnections: [],
            vouchedInBy: { kind: 'member', callsign: 'founder', publicKey: 'founder-pk', tier: 'core' },
        })),
        getMyVouching: vi.fn(async () => ({
            voucher: true,
            budget: { left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 100000 },
            presets: [2500, 5000, 7500, 10000],
            vouchMax: 10000,
            budgetMax: 200000,
            vouchedBy: [],
            history: [],
        })),
        vouchForMember: vi.fn(async () => ({
            id: 'gift-1',
            memberPubkey: 'target-pk',
            amount: 2500,
            total: 2500,
            budget: { left: 52500, held: 10000, heldInvites: 1, vouched: 37500, peopleVouched: 5, level: 100000 },
        })),
    };
});

vi.mock('../components/MemberAvatar', () => ({ MemberAvatar: () => <span data-testid="avatar" /> }));
vi.mock('../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../components/ListPhoto', () => ({ ListPhoto: () => null }));

import { PublicProfilePage } from './PublicProfilePage';
import { getMyVouching, vouchForMember } from '../lib/api';

const IDENTITY = {
    publicKey: 'me-pk'.padEnd(64, '0'),
    privateKey: 'me-sk'.padEnd(96, '0'),
    callsign: 'ana',
    createdAt: '2026-10-01T00:00:00.000Z',
};
const TARGET_PK = 'target-pk'.padEnd(64, '0');

describe('PublicProfilePage Vouching (§9)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders "Vouch for @sam" on a member profile when viewer is a voucher', async () => {
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );

        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        expect(screen.getByRole('heading', { name: 'Vouch for @sam' })).toBeInTheDocument();
        expect(screen.getByTestId('profile-vouch-submit')).toBeInTheDocument();
    });

    it('does not render profile vouch when viewer is not a voucher', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            voucher: false,
            presets: [2500, 5000, 7500, 10000],
            vouchMax: 10000,
            budgetMax: 200000,
            vouchedBy: [],
        });

        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );

        await waitFor(() => expect(screen.getByText('sam')).toBeInTheDocument());
        expect(screen.queryByTestId('profile-vouch')).not.toBeInTheDocument();
    });

    it('shows node refusal sentence as it comes (e.g. below zero)', async () => {
        vi.mocked(vouchForMember).mockRejectedValueOnce(
            new Error('@sam is below zero: a credit-line gift or a Decision can help.')
        );

        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );

        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('invite-vouch-25'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-refusal')).toBeInTheDocument());
        expect(screen.getByTestId('profile-vouch-refusal')).toHaveTextContent(
            '@sam is below zero: a credit-line gift or a Decision can help.'
        );
    });

    it('offers raise when voucher already vouched for that member', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            voucher: true,
            budget: { left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 100000 },
            presets: [2500, 5000, 7500, 10000],
            vouchMax: 10000,
            budgetMax: 200000,
            vouchedBy: [],
            history: [
                {
                    kind: 'hold',
                    amount_c: -5000,
                    actor: IDENTITY.publicKey,
                    actorCallsign: 'ana',
                    at: '2026-11-01T00:00:00.000Z',
                    for: 'profile',
                    person: { memberPubkey: TARGET_PK, callsign: 'sam' },
                },
            ],
        });

        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );

        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        expect(screen.getByRole('heading', { name: 'Raise vouch for @sam' })).toBeInTheDocument();
        expect(screen.getByText(/You already vouched 50 Beans for @sam/)).toBeInTheDocument();
    });

    /** A voucher who vouched `amount_c` (whole hundredths) for sam before; budget, presets and caps in hundredths too. */
    const vouchedBefore = (amount_c: number) => ({
        voucher: true,
        budget: { left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 100000 },
        presets: [2500, 5000, 7500, 10000],
        vouchMax: 10000,
        budgetMax: 200000,
        vouchedBy: [],
        history: [
            {
                kind: 'hold',
                amount_c: -amount_c,
                actor: IDENTITY.publicKey,
                actorCallsign: 'ana',
                at: '2026-11-01T00:00:00.000Z',
                for: 'profile' as const,
                person: { memberPubkey: TARGET_PK, callsign: 'sam' },
            },
        ],
    });
    const chips =() => screen.getAllByRole('radio').map((r) => r.getAttribute('data-testid')?.replace('invite-vouch-', ''));

    it('a raise from 50 offers Raise to 75 · 100, never None or an amount to add, with nothing greyed (slice I6)', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce(vouchedBefore(5000));
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        expect(screen.getByText('Raise to')).toBeInTheDocument();
        expect(screen.queryByText('Vouch for them')).toBeNull();
        expect(screen.queryByText('None')).toBeNull();
        expect(chips()).toEqual(['75', '100']);
        for (const r of screen.getAllByRole('radio')) expect(r).not.toBeDisabled();
    });

    it('a raise posts the total it ends at, and the success line reads the node’s new total', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce(vouchedBefore(2500));
        vi.mocked(vouchForMember).mockResolvedValueOnce({
            id: 'gift-2',
            memberPubkey: TARGET_PK,
            amount: 5000,
            total: 7500,
            budget: { left: 50000, held: 10000, heldInvites: 1, vouched: 40000, peopleVouched: 4, level: 100000 },
        });
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('invite-vouch-75'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-success')).toHaveTextContent('Raised vouch for @sam to 75 Beans.'));
        expect(vouchForMember).toHaveBeenCalledTimes(1);
        expect(vouchForMember).toHaveBeenLastCalledWith(TARGET_PK, { raiseTo: 7500 });
        // The card follows the node's total: 75 is vouched now, so only 100 is left to raise to.
        expect(screen.getByText(/You already vouched 75 Beans for @sam/)).toBeInTheDocument();
        expect(screen.queryByText(/You already vouched 25 Beans/)).toBeNull();
        expect(chips()).toEqual(['100']);
    });

    it('an owner’s raise from 100 offers Raise to 200 · 500 with None gone and nothing greyed, and posts the target (slice I6)', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            ...vouchedBefore(10000),
            noLimit: true,
            presets: [2500, 5000, 7500, 10000, 20000, 50000],
            vouchMax: 50000,
        });
        vi.mocked(vouchForMember).mockResolvedValueOnce({
            id: 'gift-3',
            memberPubkey: TARGET_PK,
            amount: 10000,
            total: 20000,
            budget: { left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 100000 },
        });
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        expect(screen.getByText(/You already vouched 100 Beans for @sam. You can raise it up to 500 Beans./)).toBeInTheDocument();
        expect(screen.getByText('Raise to')).toBeInTheDocument();
        expect(screen.queryByText('None')).toBeNull();
        expect(chips()).toEqual(['200', '500']);
        for (const r of screen.getAllByRole('radio')) expect(r).not.toBeDisabled();

        fireEvent.click(screen.getByTestId('invite-vouch-200'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-success')).toHaveTextContent('Raised vouch for @sam to 200 Beans.'));
        expect(vouchForMember).toHaveBeenLastCalledWith(TARGET_PK, { raiseTo: 20000 });
    });

    it('a first vouch the node says was a raise turns the card into the raise card: no confirm prompt, the node’s sentence beside it', async () => {
        const error: any = new Error("You've already vouched for @sam.");
        error.code = 'already_vouched';
        error.prior = 2500;
        vi.mocked(vouchForMember).mockRejectedValueOnce(error);
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('invite-vouch-25'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByRole('heading', { name: 'Raise vouch for @sam' })).toBeInTheDocument());
        expect(screen.getByTestId('profile-vouch-refusal')).toHaveTextContent("You've already vouched for @sam.");
        expect(screen.queryByTestId('profile-vouch-raise-confirm')).toBeNull();
        expect(screen.getByText(/You already vouched 25 Beans for @sam/)).toBeInTheDocument();
        expect(chips()).toEqual(['50', '75', '100']);
        expect(screen.getByTestId('profile-vouch-submit')).toBeDisabled();
        expect(vouchForMember).toHaveBeenCalledTimes(1);
        expect(vouchForMember).toHaveBeenLastCalledWith(TARGET_PK, { vouchAmount: 2500 });
    });

    it('after that refusal a raise from the new card sends the total it names (#2915 round 4, finding 2)', async () => {
        // The earlier vouch (50) is outside the history window: only the node's refusal knows it.
        const error: any = new Error('You’ve already vouched for @sam.');
        error.code = 'already_vouched';
        error.prior = 5000;
        vi.mocked(vouchForMember)
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce({
                id: 'gift-2',
                memberPubkey: TARGET_PK,
                amount: 2500,
                total: 7500,
                budget: { left: 52500, held: 10000, heldInvites: 1, vouched: 37500, peopleVouched: 4, level: 100000 },
            });
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('invite-vouch-25'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));
        await waitFor(() => expect(screen.getByText(/You already vouched 50 Beans for @sam/)).toBeInTheDocument());
        expect(chips()).toEqual(['75', '100']);

        fireEvent.click(screen.getByTestId('invite-vouch-75'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-success')).toHaveTextContent('Raised vouch for @sam to 75 Beans.'));
        expect(vouchForMember).toHaveBeenCalledTimes(2);
        expect(vouchForMember).toHaveBeenLastCalledWith(TARGET_PK, { raiseTo: 7500 });
        expect(screen.getByText(/You already vouched 75 Beans for @sam/)).toBeInTheDocument();
        expect(screen.queryByText(/You already vouched 50 Beans/)).toBeNull();
        expect(chips()).toEqual(['100']);
    });

    it('after a first vouch the card turns into a raise of the node’s total (#2915 round 4, finding 2)', async () => {
        vi.mocked(vouchForMember).mockResolvedValueOnce({
            id: 'gift-1',
            memberPubkey: TARGET_PK,
            amount: 7500,
            total: 7500,
            budget: { left: 47500, held: 10000, heldInvites: 1, vouched: 42500, peopleVouched: 5, level: 100000 },
        });
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('invite-vouch-75'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-success')).toHaveTextContent('Vouched 75 Beans for @sam.'));
        expect(vouchForMember).toHaveBeenLastCalledWith(TARGET_PK, { vouchAmount: 7500 });
        expect(screen.getByRole('heading', { name: 'Raise vouch for @sam' })).toBeInTheDocument();
        expect(screen.getByText(/You already vouched 75 Beans for @sam/)).toBeInTheDocument();
        expect(chips()).toEqual(['100']);
    });

    it('an already_vouched refusal at 100 hides the card’s choices and keeps the node’s sentence (#2915 round 4, self-check)', async () => {
        const error: any = new Error('You’ve already vouched for @sam.');
        error.code = 'already_vouched';
        error.prior = 10000;
        vi.mocked(vouchForMember).mockRejectedValueOnce(error);
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('invite-vouch-75'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-refusal')).toHaveTextContent('You’ve already vouched for @sam.'));
        // 100 is the most one voucher's vouches come to: nothing is left to raise to, and no submit is offered.
        expect(screen.queryAllByRole('radio')).toEqual([]);
        expect(screen.queryByTestId('profile-vouch-submit')).toBeNull();
        expect(vouchForMember).toHaveBeenCalledTimes(1);
    });

    it('an already_vouched refusal without the node’s figure shows the node’s sentence and never guesses 25 (#2915 round 4, note 7)', async () => {
        const error: any = new Error('You’ve already vouched for @sam.');
        error.code = 'already_vouched';
        vi.mocked(vouchForMember).mockRejectedValueOnce(error);
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('invite-vouch-50'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-refusal')).toHaveTextContent('You’ve already vouched for @sam.'));
        // No figure, no raise card: the card is still the first-vouch card, and says no amount.
        expect(screen.queryByRole('heading', { name: 'Raise vouch for @sam' })).toBeNull();
        expect(screen.getByRole('heading', { name: 'Vouch for @sam' })).toBeInTheDocument();
        expect(screen.getByTestId('profile-vouch').textContent).not.toMatch(/\b25\b.*before|already vouched 25/);
        expect(screen.getByTestId('invite-vouch-50')).not.toBeChecked();
        expect(vouchForMember).toHaveBeenCalledTimes(1);
    });

    it('at 100 (the most a vouch can be) the person’s card hides Raise vouch', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce(vouchedBefore(10000));
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByText('sam')).toBeInTheDocument());
        expect(screen.queryByTestId('profile-vouch')).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Raise vouch for @sam' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('profile-vouch-submit')).not.toBeInTheDocument();
    });

    it('after a refusal the refused preset is no longer selected', async () => {
        const error: any = new Error('@sam is below zero: a credit-line gift or a Decision can help.');
        error.code = 'below_zero';
        vi.mocked(vouchForMember).mockRejectedValueOnce(error);
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('invite-vouch-50'));
        expect(screen.getByTestId('invite-vouch-50')).toBeChecked();
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-refusal')).toHaveTextContent('@sam is below zero: a credit-line gift or a Decision can help.'));
        // Refused preset goes back to null (not checked)
        expect(screen.getByTestId('invite-vouch-50')).not.toBeChecked();
        expect(screen.getByTestId('profile-vouch-submit')).toBeDisabled();
    });

    it('when raised to 100, success is shown and Raise vouch is no longer offered', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce(vouchedBefore(7500));
        vi.mocked(vouchForMember).mockResolvedValueOnce({
            id: 'gift-100',
            memberPubkey: TARGET_PK,
            amount: 2500,
            total: 10000,
            budget: { left: 52500, held: 10000, heldInvites: 1, vouched: 37500, peopleVouched: 4, level: 100000 },
        });
        render(
            <PublicProfilePage
                identity={IDENTITY}
                pubkey={TARGET_PK}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigateTab={() => {}}
                onNavigatePost={() => {}}
            />
        );
        await waitFor(() => expect(screen.getByTestId('profile-vouch')).toBeInTheDocument());
        expect(chips()).toEqual(['100']);
        fireEvent.click(screen.getByTestId('invite-vouch-100'));
        fireEvent.click(screen.getByTestId('profile-vouch-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-success')).toHaveTextContent('Raised vouch for @sam to 100 Beans.'));
        expect(vouchForMember).toHaveBeenLastCalledWith(TARGET_PK, { raiseTo: 10000 });
        // Card is at max: no heading or submit button offering to raise further
        expect(screen.queryByRole('heading', { name: 'Raise vouch for @sam' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('profile-vouch-submit')).not.toBeInTheDocument();
        expect(screen.queryByTestId('invite-vouch-100')).not.toBeInTheDocument();
    });
});
