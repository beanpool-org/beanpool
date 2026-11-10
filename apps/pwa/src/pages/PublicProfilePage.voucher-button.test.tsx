/**
 * The owner's or admin's button on another member's profile (invites-vouching I4), and where Beans are off (the deciding
 * review of #3035). The node decides the button and sends none where Beans are off (test-invites-vouchers-block); the web
 * reads the trust profile only where Beans are live, so the same community shows no button here either, not even Add to
 * the names list. The phone draws it under the same `showsBeans` gate (profile-voucher-button-render.test.ts).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureMode } from '@beanpool/core';
import { PublicProfilePage } from './PublicProfilePage';
import { getMemberProfile, getTrustProfile } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';

let beansMode: FeatureMode = 'live';
vi.mock('../lib/features', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/features')>()),
    useFeatureMode: vi.fn(() => beansMode),
}));
const LOCAL_INFO = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} };
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => LOCAL_INFO) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(),
    onBlocklistUpdated: vi.fn(() => () => {}), getBlocklistFullNote: vi.fn(() => null),
}));
vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(async () => ({
        publicKey: 'kofi-pubkey', callsign: 'Kofi', avatar: null, bio: '', role: 'member',
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
    getTrustProfile: vi.fn(async () => ({ vouchedInBy: null, voucherButton: { state: 'add' } })),
}));

const me: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'k', callsign: 'Owen', createdAt: '2026-01-01T00:00:00.000Z' };
const renderKofi = () => render(
    <PublicProfilePage identity={me} pubkey="kofi-pubkey" onBack={vi.fn()} onMessage={vi.fn()} onNavigatePost={vi.fn()} />,
);

describe('the profile’s names-list / voucher button on the web', () => {
    beforeEach(() => { vi.clearAllMocks(); beansMode = 'live'; });
    afterEach(() => cleanup());

    it('Beans live: the node’s button is drawn', async () => {
        renderKofi();
        expect(await screen.findByTestId('profile-voucher-button')).toHaveTextContent('Add to the names list');
        expect(getTrustProfile).toHaveBeenCalledWith('kofi-pubkey');
    });

    it.each(['preview', 'read-only', 'hidden'] as const)('Beans %s: no button at all, and the trust profile is not even read', async (mode) => {
        beansMode = mode;
        renderKofi();
        await waitFor(() => expect(getMemberProfile).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('profile-voucher-button')).toBeNull();
        expect(screen.queryByTestId('profile-voucher')).toBeNull();
        expect(getTrustProfile).not.toHaveBeenCalled();
    });
});
