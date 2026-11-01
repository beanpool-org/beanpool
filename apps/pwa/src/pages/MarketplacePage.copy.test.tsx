/**
 * A member's copy of an Offer or a Need on the global community, opened by a member (slice G1′; @beanpool/core eventCopyOf). The
 * page draws the card a visitor reads, for a member too, so nothing of a deal or a person can be drawn on it: its price is
 * the line's words, and the way on is the door. The node refuses a deal whatever a page draws (apps/server test-offer-copy).
 *
 * The cards, sheets and modals the page draws are stubbed, as in MarketplacePage.deal-open.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null), saveRadiusSettings: vi.fn(), clearRadiusSettings: vi.fn(), haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', async (orig) => ({
    ...(await orig<typeof import('../lib/profile-status')>()),
    getProfileStatus: vi.fn(async () => ({ complete: true, missingName: false, missingAvatar: false })),
}));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({})), joinInFlight: vi.fn(async () => false) }));
vi.mock('../components/MarketplaceCard', () => ({ MarketplaceCard: ({ post }: { post: { title: string } }) => <div data-testid="card-stub">{post.title}</div> }));
vi.mock('../components/PollCard', () => ({ PollCard: () => null }));
vi.mock('../components/EventCard', () => ({ EventCard: () => null, EventDetail: () => null }));
vi.mock('../components/YourEvents', () => ({ YourEvents: () => null }));
vi.mock('../components/CategoryPickerModal', () => ({ CategoryPickerModal: () => null }));
vi.mock('../components/MyDealsModal', () => ({ MyDealsModal: () => null }));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Mia', createdAt: '2026-09-17T00:00:00.000Z' };
const LINE = "20 Beans in Mullumbimby · You can't buy or take this until Mullumbimby welcomes you.";

/** A copy as the node reads it to anyone but its author: `credits` 0, the neutral author, the line's two fields. */
const copy = {
    id: 'copy-1', type: 'offer', category: 'food', title: 'Sourdough loaves', description: 'Fresh this morning', credits: 0, priceType: 'fixed',
    status: 'active', active: true, repeatable: false, authorPublicKey: 'hidden', authorCallsign: 'another member', createdAt: new Date().toISOString(),
    shownCopy: true, shownPrice: '20 fixed',
    shownFrom: { host: 'mullum.example', postId: 'home-1', name: 'Mullumbimby', url: 'https://mullum.example', door: 'ask' },
};
/** A plain Offer, which the same page opens with its deal: the control, so "no Accept" below says something. */
const plain = { ...copy, id: 'plain-1', title: 'Plain loaves', credits: 12, authorPublicKey: 'damo-pk', authorCallsign: 'Damo', shownCopy: undefined, shownPrice: undefined, shownFrom: undefined };

function stubNode(posts: unknown[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) =>
        (f?.id ? (posts as Array<{ id: string }>).filter(p => p.id === f.id) : f?.author ? [] : posts) as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, isBlockedFromTrading: false } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
    vi.spyOn(api, 'getCommissionCapacity').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: ME } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({ avatar: null, bio: '' } as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 0, count: 0 } as any);
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] });
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
const open = async (postId: string) => {
    render(<MarketplacePage identity={identity} isMember={true} openPostId={postId} onPostOpened={() => {}} transactions={[]} />);
    await screen.findByRole('heading', { name: postId === 'plain-1' ? /Plain loaves/ : /Sourdough loaves/ });
    await settle();
};

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
afterEach(cleanup);

describe("a member's copy, opened by a member of the global community", () => {
    it('the control: a plain Offer opens with its deal and its author', async () => {
        stubNode([plain]);
        await open('plain-1');
        expect(screen.getByText('🤝 Accept Offer')).toBeInTheDocument();
        expect(screen.queryByTestId('listing-copy-report')).toBeNull();
    });

    it('reads the line, the door and Report: nothing of a deal or a person', async () => {
        stubNode([copy]);
        await open('copy-1');
        expect(screen.getByText(LINE)).toBeInTheDocument();
        expect(screen.getByText('Ask to join Mullumbimby')).toBeInTheDocument();
        expect(screen.getByTestId('listing-copy-report')).toBeInTheDocument();
        expect(screen.queryByText('🤝 Accept Offer')).toBeNull();
        expect(document.body.textContent).not.toContain('another member');
        expect(document.body.textContent).not.toContain('hidden');
        expect(document.body.textContent).not.toMatch(/\bMessage\b/);
    });

    it('Report opens the report on this post', async () => {
        stubNode([copy]);
        await open('copy-1');
        expect(screen.queryByRole('button', { name: /Submit Report/i })).toBeNull();
        fireEvent.click(screen.getByTestId('listing-copy-report'));
        expect(await screen.findByRole('button', { name: /Submit Report/i })).toBeInTheDocument();
    });

    it("its author is told it is theirs, and offered neither the door nor a report on themselves", async () => {
        stubNode([{ ...copy, authorPublicKey: ME, authorCallsign: 'Mia' }]);
        await open('copy-1');
        expect(screen.getByTestId('listing-copy-own')).toBeInTheDocument();
        expect(screen.queryByTestId('listing-copy-report')).toBeNull();
        expect(screen.queryByText('Ask to join Mullumbimby')).toBeNull();
        expect(screen.queryByText('🤝 Accept Offer')).toBeNull();
    });
});
