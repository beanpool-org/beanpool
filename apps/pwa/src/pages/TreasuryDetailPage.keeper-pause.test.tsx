/**
 * A keeper finding the enterprise's paused Offers and Needs on the web:
 * TreasuryDetailPage rendered for a keeper and non-keeper.
 *
 * Verifies:
 *  - A keeper of the enterprise sees the "Paused" section listing paused Offers and Needs.
 *  - Tapping/clicking one opens it (calls onNavigatePost).
 *  - With the enterprise season-paused, keeper's sections show "No live listings yet.",
 *    and the Paused section shows only the paused row.
 *  - A non-keeper member sees NO Paused section and never triggers the keeper read.
 *  - A visitor sees NO Paused section and never triggers the keeper read.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(async () => true),
    unblockUser: vi.fn(async () => true),
}));

vi.mock('../components/EnterpriseDecisions', () => ({
    EnterpriseDecisions: () => null,
}));

const ENT = 'enterprise-eggs-pubkey';
const KEEPER_PUBKEY = 'keeper-charlie-pubkey';
const STRANGER_PUBKEY = 'stranger-pubkey';

const keeperIdentity: BeanPoolIdentity = {
    publicKey: KEEPER_PUBKEY,
    privateKey: 'k',
    callsign: 'Charlie',
    createdAt: '2026-09-01T00:00:00.000Z',
};

const strangerIdentity: BeanPoolIdentity = {
    publicKey: STRANGER_PUBKEY,
    privateKey: 'k',
    callsign: 'Sam',
    createdAt: '2026-09-01T00:00:00.000Z',
};

function makeEnterpriseDetail(over: Record<string, unknown> = {}) {
    return {
        publicKey: ENT,
        name: 'Mullum Eggs',
        purpose: 'Pasture eggs for all',
        about: 'Fresh pasture eggs from Mullumbimby hens.',
        since: '2026-09-01T00:00:00.000Z',
        offerCategories: ['food'],
        status: 'active',
        paused: false,
        lifecycle: 'ongoing',
        balance: 50,
        creditLine: 200,
        liveOffers: 1,
        keepers: [
            { publicKey: KEEPER_PUBKEY, callsign: 'Charlie', role: 'keeper', backing: 10 },
        ],
        isLeadOrSoleKeeperOrAdmin: true,
        shop: { id: 'shop-eggs', category: 'food', howToDeal: 'Pick up at gate' },
        posts: [
            { id: 'p-active', type: 'offer', title: 'Fresh eggs carton', credits: 6, status: 'active', price_type: 'fixed' },
        ],
        ...over,
    };
}

const mockListings = [
    { id: 'p-active', type: 'offer', title: 'Fresh eggs carton', category: 'food', credits: 6, status: 'active', priceType: 'fixed', photos: [] },
    { id: 'p-paused', type: 'offer', title: 'Special duck eggs', category: 'food', credits: 8, status: 'paused', priceType: 'fixed', photos: [] },
];

describe('TreasuryDetailPage paused section for keepers', () => {
    let currentDetail: any;

    beforeEach(() => {
        vi.restoreAllMocks();
        currentDetail = makeEnterpriseDetail();
        vi.spyOn(api, 'getTreasury').mockImplementation(async () => currentDetail);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (filter?: any) => {
            // When keeper=1 is requested, return active rows and paused rows (skipping off-board filter)
            if (filter?.keeper) {
                return mockListings as any;
            }
            // Member read: if enterprise is season-paused or winding up, off-board filter returns empty []
            if (currentDetail.paused || currentDetail.status === 'winding_up' || currentDetail.status === 'completed') {
                return [];
            }
            // Active enterprise member read: active rows only, no paused rows
            return mockListings.filter((l: any) => l.status === 'active') as any;
        });
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: null, readOnly: false, messages: [] } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({ enterprise: { publicKey: ENT }, period: {}, summary: {}, entries: [] } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shows the Paused section to a keeper with the paused Offer, opens it on click', async () => {
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 20, keeperOf: [ENT] } as any);
        const onNavigatePost = vi.fn();

        render(
            <TreasuryDetailPage
                identity={keeperIdentity}
                pubkey={ENT}
                isMember={true}
                onBack={() => {}}
                onNavigatePost={onNavigatePost}
            />
        );

        expect(await screen.findByRole('heading', { level: 1, name: 'Mullum Eggs' })).toBeInTheDocument();

        // Active offer is visible under sections
        expect(await screen.findByText('Fresh eggs carton')).toBeInTheDocument();

        // The Paused section must be visible to the keeper
        await waitFor(() => {
            expect(screen.getByTestId('shopfront-paused')).toBeInTheDocument();
        });
        expect(screen.getByText('Special duck eggs')).toBeInTheDocument();

        // Tapping the paused listing opens it
        const row = screen.getByTestId('shopfront-row-p-paused');
        fireEvent.click(row);
        expect(onNavigatePost).toHaveBeenCalledWith('p-paused');
    });

    it('with enterprise season-paused, keeper sections show no live listing and Paused section shows only the paused row', async () => {
        currentDetail = makeEnterpriseDetail({ paused: true });
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 20, keeperOf: [ENT] } as any);
        const onNavigatePost = vi.fn();

        render(
            <TreasuryDetailPage
                identity={keeperIdentity}
                pubkey={ENT}
                isMember={true}
                onBack={() => {}}
                onNavigatePost={onNavigatePost}
            />
        );

        expect(await screen.findByRole('heading', { level: 1, name: 'Mullum Eggs' })).toBeInTheDocument();

        // The Paused section must be visible to the keeper with only the paused listing
        await waitFor(() => {
            expect(screen.getByTestId('shopfront-paused')).toBeInTheDocument();
        });
        expect(screen.getByText('Special duck eggs')).toBeInTheDocument();

        // Sections must show empty message: no live listings
        expect(await screen.findByText('No live listings yet.')).toBeInTheDocument();
        // The active offer must NOT be shown in the sections
        expect(screen.queryByText('Fresh eggs carton')).toBeNull();
    });

    it('a non-keeper member sees NO Paused section and never triggers the keeper read', async () => {
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 20, keeperOf: [] } as any);
        const onNavigatePost = vi.fn();

        render(
            <TreasuryDetailPage
                identity={strangerIdentity}
                pubkey={ENT}
                isMember={true}
                onBack={() => {}}
                onNavigatePost={onNavigatePost}
            />
        );

        expect(await screen.findByRole('heading', { level: 1, name: 'Mullum Eggs' })).toBeInTheDocument();

        // Normal active listing should be visible
        expect(await screen.findByText('Fresh eggs carton')).toBeInTheDocument();

        // Paused section and paused listing must NOT be visible
        expect(screen.queryByTestId('shopfront-paused')).toBeNull();
        expect(screen.queryByText('Special duck eggs')).toBeNull();

        // Must never trigger keeper read
        const postsCalls = vi.mocked(api.getMarketplacePosts).mock.calls;
        expect(postsCalls.some(([filter]) => filter?.keeper)).toBe(false);
    });

    it('a visitor sees NO Paused section and never triggers the keeper read', async () => {
        const onNavigatePost = vi.fn();

        render(
            <TreasuryDetailPage
                identity={null}
                pubkey={ENT}
                isMember={false}
                onBack={() => {}}
                onNavigatePost={onNavigatePost}
            />
        );

        expect(await screen.findByRole('heading', { level: 1, name: 'Mullum Eggs' })).toBeInTheDocument();
        expect(screen.queryByTestId('shopfront-paused')).toBeNull();
        expect(screen.queryByText('Special duck eggs')).toBeNull();

        const postsCalls = vi.mocked(api.getMarketplacePosts).mock.calls;
        expect(postsCalls.some(([filter]) => filter?.keeper)).toBe(false);
    });
});
