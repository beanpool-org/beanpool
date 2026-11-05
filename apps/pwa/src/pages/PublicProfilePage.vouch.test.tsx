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
        getBalance: vi.fn(async () => ({ balance: 100, earnedCredit: 50, allowance: 100 })),
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
            budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [],
            history: [],
        })),
        vouchForMember: vi.fn(async () => ({
            id: 'gift-1',
            memberPubkey: 'target-pk',
            amount: 25,
            total: 25,
            budget: { left: 525, held: 100, heldInvites: 1, vouched: 375, peopleVouched: 5, level: 1000 },
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
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
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
            budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [],
            history: [
                {
                    kind: 'hold',
                    amount: -50,
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

    it('asks confirmation when server reports already_vouched and Cancel sends nothing', async () => {
        const error: any = new Error("You've already vouched for @sam.");
        error.code = 'already_vouched';
        error.prior = 25;
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

        await waitFor(() => expect(screen.getByTestId('profile-vouch-raise-confirm')).toBeInTheDocument());
        expect(screen.getByTestId('profile-vouch-raise-confirm')).toHaveTextContent(
            'You vouched 25 for @sam before. Raise it to 50?'
        );

        fireEvent.click(screen.getByTestId('profile-vouch-raise-cancel'));
        expect(screen.queryByTestId('profile-vouch-raise-confirm')).not.toBeInTheDocument();
        expect(vouchForMember).toHaveBeenCalledTimes(1);
    });

    it('asks confirmation when server reports already_vouched and Raise sends raise', async () => {
        const error: any = new Error("You've already vouched for @sam.");
        error.code = 'already_vouched';
        error.prior = 25;
        vi.mocked(vouchForMember)
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce({
                id: 'gift-2',
                memberPubkey: TARGET_PK,
                amount: 25,
                total: 50,
                budget: { left: 525, held: 100, heldInvites: 1, vouched: 375, peopleVouched: 5, level: 1000 },
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

        await waitFor(() => expect(screen.getByTestId('profile-vouch-raise-confirm')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('profile-vouch-raise-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-success')).toBeInTheDocument());
        expect(screen.getByTestId('profile-vouch-success')).toHaveTextContent('Raised vouch for @sam to 50 Beans.');
        expect(vouchForMember).toHaveBeenCalledTimes(2);
        expect(vouchForMember).toHaveBeenLastCalledWith(TARGET_PK, 25, true);
    });

    it('greys out presets that would take total for that person past 100', async () => {
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            voucher: true,
            budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [],
            history: [
                {
                    kind: 'hold',
                    amount: -50,
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
        // Prior is 50. Presets:
        // 25: 50 + 25 = 75 <= 100 -> enabled
        // 50: 50 + 50 = 100 <= 100 -> enabled
        // 75: 50 + 75 = 125 > 100 -> disabled
        // 100: 50 + 100 = 150 > 100 -> disabled
        expect(screen.getByTestId('invite-vouch-25')).not.toBeDisabled();
        expect(screen.getByTestId('invite-vouch-50')).not.toBeDisabled();
        expect(screen.getByTestId('invite-vouch-75')).toBeDisabled();
        expect(screen.getByTestId('invite-vouch-100')).toBeDisabled();
        // Greyed by the cap, not the budget (550 left): it says so (#2915 round 4, note 5).
        expect(screen.getByTestId('invite-vouch-75').closest('label')).toHaveAttribute('title', 'Your vouches for @sam can’t go past 100 Beans.');
        expect(screen.getByTestId('invite-vouch-75').closest('label')?.getAttribute('title')).not.toBe('Not enough budget left');
    });

    it('after a raise the card reads the node’s new total and greys presets against it (#2915 round 4, finding 2)', async () => {
        // The earlier vouch (50) is outside the history window: only the node's refusal knows it.
        const error: any = new Error('You’ve already vouched for @sam.');
        error.code = 'already_vouched';
        error.prior = 50;
        vi.mocked(vouchForMember)
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce({
                id: 'gift-2',
                memberPubkey: TARGET_PK,
                amount: 25,
                total: 75,
                budget: { left: 525, held: 100, heldInvites: 1, vouched: 375, peopleVouched: 4, level: 1000 },
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
        await waitFor(() => expect(screen.getByTestId('profile-vouch-raise-confirm')).toHaveTextContent('You vouched 50 for @sam before. Raise it to 75?'));
        fireEvent.click(screen.getByTestId('profile-vouch-raise-submit'));

        await waitFor(() => expect(screen.getByTestId('profile-vouch-success')).toHaveTextContent('Raised vouch for @sam to 75 Beans.'));
        expect(screen.getByText(/You already vouched 75 Beans for @sam/)).toBeInTheDocument();
        expect(screen.queryByText(/You already vouched 50 Beans/)).toBeNull();
        // 75 + 25 = 100 stays; 75 + 50 = 125 is greyed.
        expect(screen.getByTestId('invite-vouch-25')).not.toBeDisabled();
        expect(screen.getByTestId('invite-vouch-50')).toBeDisabled();
        expect(screen.getByTestId('invite-vouch-75')).toBeDisabled();
        expect(screen.getByTestId('invite-vouch-100')).toBeDisabled();
    });

    it('after a first vouch the card turns into a raise of the node’s total (#2915 round 4, finding 2)', async () => {
        vi.mocked(vouchForMember).mockResolvedValueOnce({
            id: 'gift-1',
            memberPubkey: TARGET_PK,
            amount: 75,
            total: 75,
            budget: { left: 475, held: 100, heldInvites: 1, vouched: 425, peopleVouched: 5, level: 1000 },
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
        expect(screen.getByRole('heading', { name: 'Raise vouch for @sam' })).toBeInTheDocument();
        expect(screen.getByText(/You already vouched 75 Beans for @sam/)).toBeInTheDocument();
        expect(screen.getByTestId('invite-vouch-50')).toBeDisabled();
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
        expect(screen.queryByTestId('profile-vouch-raise-confirm')).toBeNull();
        expect(screen.getByTestId('profile-vouch').textContent).not.toMatch(/\b25\b.*before|already vouched 25/);
        expect(vouchForMember).toHaveBeenCalledTimes(1);
    });
});
