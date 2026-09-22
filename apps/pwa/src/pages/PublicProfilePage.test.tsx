import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { PublicProfilePage } from './PublicProfilePage';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getMemberProfile, type MemberProfile, type BalanceInfo } from '../lib/api';
import { ARCHETYPES } from '@beanpool/core';

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
        const rootContainer = bannerHeading.closest('[data-testid="page-overlay"]');
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
        const rootContainer = headerTitle.closest('[data-testid="page-overlay"]');
        expect(rootContainer).not.toBeNull();

        const detailContent = rootContainer?.querySelector('.max-w-2xl.mx-auto');
        expect(detailContent).not.toBeNull();
        expect(detailContent).toHaveStyle({
            paddingBottom: 'calc(var(--bottom-nav-offset) + 4rem)',
        });
    });
});

// Both pages were `fixed inset-0 bg-nature-100 dark:bg-black`: a full-viewport layer that covered the
// desktop sidebar, and an opaque flat fill that replaced the doodle wallpaper with plain black in dark
// mode. They now carry .page-overlay, which stops at the sidebar on md+ and repaints the wallpaper over
// its own ground (index.css). jsdom lays nothing out, so the class — and the absence of the two it
// replaced — is what the assertion can hold on to; the CSS contract itself is asserted in
// AppBottomNav.test.tsx.
describe('Full-page views are .page-overlay, not a viewport-wide opaque sheet', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('PublicProfilePage stops at the sidebar and drops the flat bg-nature-100 / dark:bg-black fill', async () => {
        render(
            <PublicProfilePage
                identity={mockIdentity}
                pubkey="peer-pubkey-123"
                onBack={vi.fn()}
                onMessage={vi.fn()}
                onNavigatePost={vi.fn()}
            />
        );
        await waitFor(() => expect(screen.getByText('Trust Profile')).toBeInTheDocument());

        const root = screen.getByTestId('page-overlay');
        const classes = root.className.split(/\s+/);
        expect(classes).toContain('page-overlay');
        expect(classes).toContain('z-[110]');   // still above the mobile header
        expect(classes).not.toContain('inset-0');
        expect(classes).not.toContain('fixed'); // position now comes from .page-overlay
        expect(classes).not.toContain('bg-nature-100');
        expect(classes).not.toContain('dark:bg-black');
    });

    it('TreasuryDetailPage stops at the sidebar and drops the flat bg-nature-100 / dark:bg-black fill', async () => {
        render(
            <TreasuryDetailPage
                identity={mockIdentity}
                pubkey="treasury-pubkey-123"
                onBack={vi.fn()}
                onNavigatePost={vi.fn()}
            />
        );
        await waitFor(() => expect(screen.getAllByText('Community Bakery').length).toBeGreaterThan(0));

        const root = screen.getByTestId('page-overlay');
        const classes = root.className.split(/\s+/);
        expect(classes).toContain('page-overlay');
        expect(classes).toContain('z-[110]');
        expect(classes).not.toContain('inset-0');
        expect(classes).not.toContain('fixed');
        expect(classes).not.toContain('bg-nature-100');
        expect(classes).not.toContain('dark:bg-black');
    });
});

describe('PublicProfilePage Collaboration Chemistry names no archetype', () => {
    const archetypeJson = (primary: string) => JSON.stringify({ primary, secondary: 'sage', mode: 'quick', updatedAt: '2026-09-01T00:00:00.000Z' });
    const typeNames = Object.values(ARCHETYPES).flatMap((a) => [a.name, a.name.replace(/^The\s+/, '')]);

    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
    });

    // spark + weaver is a complementary pair (headline was "The Spark + The Weaver");
    // weaver + weaver is kindred (headline was "Shared Weaver intuition").
    it.each([
        ['spark', 'weaver', 'Complementary Synergy'],
        ['weaver', 'weaver', 'Kindred Rhythms'],
        ['artisan', 'sage', 'Balanced Collaboration'],
    ])('viewer %s looking at a %s: card and outreach message carry no type name', async (viewerType, peerType, title) => {
        vi.mocked(getMemberProfile).mockImplementation(async (pk: string) => (
            pk === 'my-user-pubkey'
                ? ({ ...mockProfile, publicKey: pk, callsign: 'Alice', archetype: archetypeJson(viewerType) } as any)
                : ({ ...mockProfile, archetype: archetypeJson(peerType) } as any)
        ));
        const onMessage = vi.fn();
        render(
            <PublicProfilePage
                identity={mockIdentity}
                pubkey="peer-pubkey-123"
                onBack={vi.fn()}
                onMessage={onMessage}
                onNavigatePost={vi.fn()}
            />
        );

        const cardTitle = await screen.findByText(title);
        const card = cardTitle.closest('.rounded-2xl') as HTMLElement;
        expect(card).not.toBeNull();
        for (const name of typeNames) {
            expect(card.textContent).not.toContain(name);
        }

        fireEvent.click(screen.getByRole('button', { name: 'Collaborate with Bob' }));
        expect(onMessage).toHaveBeenCalledWith('peer-pubkey-123');
        const prefill = JSON.parse(sessionStorage.getItem('bp_chat_prefill') || '{}');
        expect(prefill.text).toBeTruthy();
        for (const name of typeNames) {
            expect(prefill.text).not.toContain(name);
        }
        vi.mocked(getMemberProfile).mockImplementation(async () => mockProfile);
    });
});
