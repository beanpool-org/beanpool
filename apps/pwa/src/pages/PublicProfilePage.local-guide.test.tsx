/**
 * The Local guide badge on a member's profile (Learn K8; DESIGN-local-knowledge-fable.md §2.10): drawn from the trust profile's
 * `badges` (the node's engine/local-guide.ts; test-knowledge-local-guide holds the rule), this key's own answer only. It gates
 * nothing and offers nothing: the profile has no "Thank" (the design puts Thank on a page, whose note names the page). The phone
 * draws the same under its name (public-profile.tsx `profile-local-guide`).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureMode } from '@beanpool/core';
import { PublicProfilePage } from './PublicProfilePage';
import { getTrustProfile } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';

let beansMode: FeatureMode = 'live';
vi.mock('../lib/features', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/features')>()),
    useFeatureMode: vi.fn(() => beansMode),
}));
const LOCAL_INFO = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: {} };
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => LOCAL_INFO) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));
const trust = vi.hoisted(() => ({ badges: undefined as unknown }));
vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(async () => ({
        publicKey: 'ada-pubkey', callsign: 'Ada', avatar: null, bio: '', role: 'member',
        stats: { ratingsReceivedCount: 0, averageRating: 0 },
    })),
    updateMemberProfile: vi.fn(),
    getMemberRatings: vi.fn(async () => []),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => null),
    getRatingsGiven: vi.fn(async () => ({ ratings: [] })),
    getFriends: vi.fn(async () => []),
    submitRating: vi.fn(),
    getPublicChannels: vi.fn(async () => ({ channels: [] })),
    getMyVouching: vi.fn(async () => null),
    getTrustProfile: vi.fn(async () => ({ vouchedInBy: null, ...(trust.badges === undefined ? {} : { badges: trust.badges }) })),
}));

const me: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'k', callsign: 'Owen', createdAt: '2026-01-01T00:00:00.000Z' };
const renderAda = () => render(
    <PublicProfilePage identity={me} pubkey="ada-pubkey" onBack={vi.fn()} onMessage={vi.fn()} onNavigatePost={vi.fn()} />,
);

describe('the Local guide badge on the web profile', () => {
    beforeEach(() => { vi.clearAllMocks(); beansMode = 'live'; trust.badges = undefined; });
    afterEach(() => cleanup());

    it.each([
        [['local-guide'], true],
        [[], false],
        // A node from before K8 sends no `badges`: no badge, never an error.
        [undefined, false],
        [['something-else'], false],
    ] as const)('badges %j: "🗺️ Local guide" shown %s, and no Thank on a profile', async (badges, shown) => {
        trust.badges = badges;
        renderAda();
        await waitFor(() => expect(getTrustProfile).toHaveBeenCalledWith('ada-pubkey'));
        await new Promise((r) => setTimeout(r, 20));
        const badge = screen.queryByTestId('profile-local-guide');
        expect(badge !== null).toBe(shown);
        if (shown) expect(badge).toHaveTextContent('🗺️ Local guide');
        expect(screen.queryByText(/Thank/)).toBeNull();
    });
});
