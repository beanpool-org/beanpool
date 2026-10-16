/**
 * Another member's profile where Beans live in a local community for this reader (the global node): their listings
 * show no price. Before, every row read "OFFER 0 🫘" under the line that says Beans are earned in a local community
 * (global previews audit, item 1, B10-profile-other-320.png). On a local node the price stays.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureMode } from '@beanpool/core';
import { PublicProfilePage } from './PublicProfilePage';
import { getBalance, getMarketplacePosts } from '../lib/api';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import type { BeanPoolIdentity } from '../lib/identity';

let beansMode: FeatureMode = 'live';
vi.mock('../lib/features', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/features')>()),
    useFeatureMode: vi.fn(() => beansMode),
}));
// The node's /api/community/info, read once per page load: a local node unless a test says otherwise.
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

const listing = {
    id: 'p1', type: 'offer', category: 'food', title: 'Pottery lessons on Sundays', description: '', credits: 20,
    priceType: 'fixed', authorPublicKey: 'kofi-pubkey', authorCallsign: 'Kofi', active: true, status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
};
vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(async () => ({
        publicKey: 'kofi-pubkey', callsign: 'Kofi', avatar: null, bio: '', role: 'member', elderVouchedBy: null,
        stats: { totalVouchesGiven: 0, ratingsReceivedCount: 0, averageRating: 0, vouchesReceivedCount: 0 },
    })),
    updateMemberProfile: vi.fn(),
    getMemberRatings: vi.fn(async () => []),
    getMarketplacePosts: vi.fn(async () => [listing]),
    getBalance: vi.fn(async () => null),
    getRatingsGiven: vi.fn(async () => ({ ratings: [] })),
    getFriends: vi.fn(async () => []),
    submitRating: vi.fn(),
    vouchMemberApi: vi.fn(),
    getPublicChannels: vi.fn(async () => ({ channels: [] })),
}));

const me: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'k', callsign: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' };
const renderKofi = () => render(
    <PublicProfilePage identity={me} pubkey="kofi-pubkey" onBack={vi.fn()} onMessage={vi.fn()} onNavigatePost={vi.fn()} />,
);

describe('another member\'s listings on their profile', () => {
    beforeEach(() => { beansMode = 'live'; });

    it('Beans in preview (the global node): the row has its title and kind, no price; the line says where Beans live', async () => {
        beansMode = 'preview';
        renderKofi();
        expect(await screen.findByText('Pottery lessons on Sundays')).toBeInTheDocument();
        expect(screen.getByText('OFFER')).toBeInTheDocument();
        expect(screen.queryByTestId('profile-listing-price')).toBeNull();
        expect(screen.queryByText('🫘')).toBeNull();
        expect(screen.getByTestId('profile-local-line')).toBeInTheDocument();
    });

    it('read-only Beans are marked too: no price', async () => {
        beansMode = 'read-only';
        renderKofi();
        expect(await screen.findByText('Pottery lessons on Sundays')).toBeInTheDocument();
        expect(screen.queryByTestId('profile-listing-price')).toBeNull();
        expect(screen.queryByText('🫘')).toBeNull();
    });

    it('Beans live (a local node): the price stays, as before', async () => {
        renderKofi();
        expect(await screen.findByText('Pottery lessons on Sundays')).toBeInTheDocument();
        expect(screen.getByTestId('profile-listing-price')).toHaveTextContent('20🫘');
        expect(screen.queryByTestId('profile-local-line')).toBeNull();
    });
});

describe('a profile reads nothing of the reader\'s where Beans are in preview (global previews audit, P3)', () => {
    const GLOBAL_INFO = {
        ...LOCAL_INFO, profile: 'global',
        features: { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true },
    };
    const renderMine = () => render(
        <PublicProfilePage identity={me} pubkey={me.publicKey} onBack={vi.fn()} onMessage={vi.fn()} onNavigatePost={vi.fn()} />,
    );
    beforeEach(() => {
        vi.clearAllMocks();
        beansMode = 'live';
        vi.mocked(communityInfoOnce).mockImplementation(async () => LOCAL_INFO as never);
    });

    it('global (previews), my own profile: the line, and my balance is never asked', async () => {
        beansMode = 'preview';
        vi.mocked(communityInfoOnce).mockImplementation(async () => GLOBAL_INFO as never);
        renderMine();
        expect(await screen.findByTestId('profile-local-line')).toBeInTheDocument();
        await waitFor(() => expect(getMarketplacePosts).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 0));
        expect(getBalance).not.toHaveBeenCalled();
    });

    it('global (previews), another member\'s profile: my balance (the vouch button\'s) is never asked', async () => {
        beansMode = 'preview';
        vi.mocked(communityInfoOnce).mockImplementation(async () => GLOBAL_INFO as never);
        renderKofi();
        expect(await screen.findByText('Pottery lessons on Sundays')).toBeInTheDocument();
        await new Promise(r => setTimeout(r, 0));
        expect(getBalance).not.toHaveBeenCalled();
    });

    it('local (live): my own balance is asked on my profile, and on another\'s, as before', async () => {
        renderMine();
        await waitFor(() => expect(getBalance).toHaveBeenCalledWith(me.publicKey));
        vi.mocked(getBalance).mockClear();
        renderKofi();
        await waitFor(() => expect(getBalance).toHaveBeenCalledWith(me.publicKey));
        expect(getBalance).not.toHaveBeenCalledWith('kofi-pubkey');
    });
});
