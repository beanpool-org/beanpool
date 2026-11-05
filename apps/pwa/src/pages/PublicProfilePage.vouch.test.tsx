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
});
