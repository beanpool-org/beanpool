/**
 * A member's listing rows on their profile are small cards, and a small card's photo is part of the card (Marty, 4 Nov 2026:
 * "from small cards you should be able to click anywhere on the card and have the card come up"). A press on the row's photo
 * opens the post, as a press anywhere else on the row does; the enlarge lives on the post's own page. The row is one
 * accessible element, "View post: {title}", with no photo button inside it.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PublicProfilePage } from './PublicProfilePage';
import type { BeanPoolIdentity } from '../lib/identity';

vi.mock('../lib/features', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/features')>()),
    useFeatureMode: vi.fn(() => 'live'),
}));
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} })),
}));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(),
    onBlocklistUpdated: vi.fn(() => () => {}), getBlocklistFullNote: vi.fn(() => null),
}));

const PHOTOS = ['/api/marketplace/posts/p1/photos/0?v=1&k=KEY0', '/api/marketplace/posts/p1/photos/1?v=1&k=KEY1'];
const listing = (photos: unknown) => ({
    id: 'p1', type: 'offer', category: 'food', title: 'Pottery lessons on Sundays', description: '', credits: 20,
    priceType: 'fixed', authorPublicKey: 'kofi-pubkey', authorCallsign: 'Kofi', active: true, status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z', photos,
});
let rows: unknown[] = [];
vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(async () => ({
        publicKey: 'kofi-pubkey', callsign: 'Kofi', avatar: null, bio: '', role: 'member',
        stats: { ratingsReceivedCount: 0, averageRating: 0 },
    })),
    updateMemberProfile: vi.fn(),
    getMemberRatings: vi.fn(async () => []),
    getMarketplacePosts: vi.fn(async () => rows),
    getBalance: vi.fn(async () => null),
    getRatingsGiven: vi.fn(async () => ({ ratings: [] })),
    getFriends: vi.fn(async () => []),
    submitRating: vi.fn(),
    getPublicChannels: vi.fn(async () => ({ channels: [] })),
}));

const me: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'k', callsign: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' };

describe("a member's listing rows on their profile: the photo is part of the row", () => {
    it.each([
        ['a list of photos', PHOTOS],
        ['a JSON string of photos', JSON.stringify(PHOTOS)],
        ['one bare photo', PHOTOS[0]],
    ])('%s: a press on the photo opens the post; the row holds no enlarge button', async (_name, photos) => {
        rows = [listing(photos)];
        const onBack = vi.fn();
        const onNavigatePost = vi.fn();
        render(<PublicProfilePage identity={me} pubkey="kofi-pubkey" onBack={onBack} onMessage={vi.fn()} onNavigatePost={onNavigatePost} />);
        const row = await screen.findByRole('button', { name: 'View post: Pottery lessons on Sundays' });
        // One accessible element per card: nothing inside the row is a button, the photo included.
        expect(within(row).queryAllByRole('button')).toEqual([]);
        expect(screen.queryByRole('button', { name: /View enlarged photo: Pottery lessons/ })).toBeNull();
        const img = row.querySelector('img');
        expect(img).not.toBeNull();
        expect(img!.closest('button')).toBeNull();
        fireEvent.click(img!);
        expect(onNavigatePost).toHaveBeenCalledTimes(1);
        expect(onNavigatePost).toHaveBeenCalledWith('p1');
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    // Both halves together (the sync of #2838 with the small-cards rule): a small copy that fails steps down to the full photo,
    // then to the box tile, never an empty slot; and through every step the row stays one accessible element that opens the post.
    it('a failed small photo is asked once more past every cache, then steps down to the full photo, then the box tile, and the row still opens the post', async () => {
        rows = [listing(PHOTOS)];
        const onNavigatePost = vi.fn();
        render(<PublicProfilePage identity={me} pubkey="kofi-pubkey" onBack={vi.fn()} onMessage={vi.fn()} onNavigatePost={onNavigatePost} />);
        const row = await screen.findByRole('button', { name: 'View post: Pottery lessons on Sundays' });
        expect(row.querySelector('img')?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2`);
        // card-photo-blank (#2853): the small copy is asked once more past every cache before the photo's own URL.
        fireEvent.error(row.querySelector('img')!);
        expect(row.querySelector('img')?.getAttribute('src')).toBe(`${PHOTOS[0]}&size=thumb2&retry=1`);
        expect(within(row).queryAllByRole('button')).toEqual([]);
        fireEvent.error(row.querySelector('img')!);
        expect(row.querySelector('img')?.getAttribute('src')).toBe(PHOTOS[0]);
        expect(within(row).queryAllByRole('button')).toEqual([]);
        fireEvent.error(row.querySelector('img')!);
        expect(row.querySelector('img')).toBeNull();
        expect(within(row).getByText('📦')).toBeInTheDocument();
        expect(within(row).queryAllByRole('button')).toEqual([]);
        fireEvent.click(row);
        expect(onNavigatePost).toHaveBeenCalledTimes(1);
        expect(onNavigatePost).toHaveBeenCalledWith('p1');
    });
});
