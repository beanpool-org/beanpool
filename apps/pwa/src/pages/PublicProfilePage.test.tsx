import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { PublicProfilePage } from './PublicProfilePage';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { MemberProfile, BalanceInfo } from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

vi.mock('../components/ArchetypeQuizModal', () => ({
    ArchetypeQuizModal: () => null,
}));

vi.mock('../components/ChannelChips', () => ({
    ChannelChips: () => null,
}));

vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'my-user-pubkey',
    privateKey: 'my-user-privkey',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const mockProfile: MemberProfile = {
    publicKey: 'peer-pubkey-123',
    callsign: 'Bob',
    avatar: null,
    bio: 'Test bio',
    role: 'member',
    elderVouchedBy: null,
    stats: {
        totalVouchesGiven: 0,
        ratingsReceivedCount: 0,
        averageRating: 0,
        vouchesReceivedCount: 0,
    },
} as any;

const mockBalance: BalanceInfo = {
    balance: 100,
    floor: -500,
    commonsBalance: 0,
    callsign: 'Alice',
    tier: 'contributor' as any,
};

const mockTreasuryDetail: any = {
    publicKey: 'treasury-pubkey-123',
    name: 'Community Bakery',
    description: 'Fresh bread for all',
    balance: 500,
    avatar: null,
    created_at: '2026-09-01T00:00:00.000Z',
    signers: [
        { publicKey: 'my-user-pubkey', callsign: 'Alice', role: 'admin' },
    ],
    rules: {
        approval_threshold: 1,
        auto_payout_limit: 0,
    },
    activity: [],
} as any;

vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(async () => mockProfile),
    updateMemberProfile: vi.fn(),
    getMemberRatings: vi.fn(async () => []),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => mockBalance),
    getRatingsGiven: vi.fn(async () => []),
    getFriends: vi.fn(async () => []),
    submitRating: vi.fn(),
    vouchMemberApi: vi.fn(),
    getPublicChannels: vi.fn(async () => []),
    getTreasury: vi.fn(async () => mockTreasuryDetail),
    getTreasuryDetail: vi.fn(async () => mockTreasuryDetail),
    getTreasuries: vi.fn(async () => []),
}));

describe('PublicProfilePage & TreasuryDetailPage bottom padding regression (#791 / #792)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('PublicProfilePage applies shared --bottom-nav-offset padding instead of a hardcoded magic number', async () => {
        render(
            <PublicProfilePage
                identity={mockIdentity}
                pubkey="peer-pubkey-123"
                onBack={vi.fn()}
                onMessage={vi.fn()}
                onNavigatePost={vi.fn()}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Trust Profile')).toBeInTheDocument();
        });

        // The profile banner/content container must derive padding from --bottom-nav-offset
        const bannerHeading = screen.getByText('Trust Profile');
        const rootContainer = bannerHeading.closest('.fixed.inset-0');
        expect(rootContainer).not.toBeNull();

        const profileContent = rootContainer?.querySelector('.max-w-2xl.mx-auto.pb-20');
        expect(profileContent).not.toBeNull();
        expect(profileContent).toHaveStyle({
            paddingBottom: 'calc(var(--bottom-nav-offset) + 4rem)',
        });
    });

    it('TreasuryDetailPage applies shared --bottom-nav-offset padding instead of a hardcoded magic number', async () => {
        render(
            <TreasuryDetailPage
                identity={mockIdentity}
                pubkey="treasury-pubkey-123"
                onBack={vi.fn()}
                onNavigatePost={vi.fn()}
            />
        );

        await waitFor(() => {
            expect(screen.getAllByText('Community Bakery').length).toBeGreaterThan(0);
        });

        const headerTitle = screen.getAllByText('Community Bakery')[0];
        const rootContainer = headerTitle.closest('.fixed.inset-0');
        expect(rootContainer).not.toBeNull();

        const detailContent = rootContainer?.querySelector('.max-w-2xl.mx-auto');
        expect(detailContent).not.toBeNull();
        expect(detailContent).toHaveStyle({
            paddingBottom: 'calc(var(--bottom-nav-offset) + 4rem)',
        });
    });
});
