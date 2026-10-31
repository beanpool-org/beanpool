/**
 * A keeper editing their enterprise's Offer or Need on the web, as on the phone (apps/native app/post/[id].tsx shows Edit to
 * the enterprise's keepers; Damo, 26 Oct). The listing page shows Edit to a member whose balance says they keep the
 * enterprise that listed it (keeperOf), opens the same form as for their own listing, and saves through the same call, the
 * member's own key named (the node takes it from a keeper: apps/server test-enterprise-post-edit-http). Pausing and deleting
 * it stay the author's here. A member who keeps nothing sees no Edit, and neither does a keeper of another enterprise.
 *
 * The listing's own words only: the cards, sheets and modals it draws are stubbed, as in MarketplacePage.deal-open.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const ENT = 'eggs-enterprise-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };
const TODAY = new Date().toISOString();
const PHOTO = '/api/marketplace/posts/offer-eggs/photos/0?k=abc';

/** The enterprise's Offer, with a photo: written by the enterprise, listed by a keeper. */
const eggs = {
    id: 'offer-eggs', type: 'offer', category: 'food', title: 'Dozen eggs', description: 'Laid this week', credits: 6, priceType: 'fixed',
    status: 'active', active: true, repeatable: true, authorPublicKey: ENT, authorCallsign: 'Mullum Eggs', createdAt: TODAY, photos: [PHOTO],
    audienceScope: 'public',
};

function stubNode(posts: unknown[], keeperOf: string[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) =>
        (f?.id ? (posts as Array<{ id: string }>).filter(p => p.id === f.id) : f?.author ? [] : posts) as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, isBlockedFromTrading: false, keeperOf } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
    vi.spyOn(api, 'getCommissionCapacity').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: ME } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({ avatar: null, bio: '' } as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 0, count: 0 } as any);
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] });
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
}

async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}
async function openEggs() {
    render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-eggs" onPostOpened={() => {}} transactions={[]} />);
    await screen.findByRole('heading', { name: /Dozen eggs/ });
    await settle();
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});
afterEach(() => { cleanup(); });

describe("a keeper editing their enterprise's listing on the web", () => {
    it('Edit for a keeper of the enterprise that listed it: the same form, saved with the member\'s own key, the saved listing shown', async () => {
        // The node's listings, as it answers them: the edit saved changes what it answers next.
        const listings: Array<Record<string, unknown>> = [eggs];
        stubNode(listings, [ENT]);
        const saved = { ...eggs, title: 'Dozen free-range eggs' };
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => {
            listings[0] = saved;
            return { success: true, post: saved } as any;
        });
        await openEggs();

        await waitFor(() => expect(screen.getByText('✏️ Edit Post')).toBeInTheDocument());
        // Edit and Pause for a keeper; deleting the enterprise's listing stays the author's on this page.
        expect(screen.getByText('⏸️ Pause Offer')).toBeInTheDocument();
        expect(screen.queryByText('🗑️ Delete Post')).toBeNull();

        fireEvent.click(screen.getByText('✏️ Edit Post'));
        const title = screen.getByPlaceholderText('Title') as HTMLInputElement;
        expect(title.value).toBe('Dozen eggs');
        fireEvent.change(title, { target: { value: 'Dozen free-range eggs' } });
        await act(async () => { fireEvent.click(screen.getByText('💾 Save')); });

        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update).toHaveBeenCalledWith('offer-eggs', ME, {
            type: 'offer', category: 'food', title: 'Dozen free-range eggs', description: 'Laid this week', credits: 6, priceType: 'fixed',
            repeatable: true, photos: [PHOTO],
        });
        await waitFor(() => expect(screen.getByRole('heading', { name: /Dozen free-range eggs/ })).toBeInTheDocument());
        expect(screen.queryByText('💾 Save')).toBeNull();
    });

    describe('its tags (DESIGN-owner-seeding-tags-fable.md §4.4, §4.7: sent only when chosen; an edit never wipes them)', () => {
        const LEMON = 'food.fruit.lemon';
        const ORANGE = 'food.fruit.orange';
        const tagged = { ...eggs, tags: [LEMON, ORANGE] };
        async function openForm(listing: Record<string, unknown> = tagged) {
            const listings: Array<Record<string, unknown>> = [listing];
            stubNode(listings, [ENT]);
            const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: listings[0] }) as any);
            await openEggs();
            await waitFor(() => expect(screen.getByText('✏️ Edit Post')).toBeInTheDocument());
            fireEvent.click(screen.getByText('✏️ Edit Post'));
            return { update, listings };
        }
        const save = async () => { await act(async () => { fireEvent.click(screen.getByText('💾 Save')); }); };

        it('an edit that did not touch the tags sends none, on a listing that has some', async () => {
            const { update } = await openForm();
            fireEvent.change(screen.getByPlaceholderText('Title') as HTMLInputElement, { target: { value: 'Two dozen eggs' } });
            await save();
            await waitFor(() => expect(update).toHaveBeenCalled());
            expect(update.mock.calls[0][2]).not.toHaveProperty('tags');
        });

        it('one taken off: the rest go, and taking off the last sends the empty list that clears them', async () => {
            const { update } = await openForm({ ...eggs, tags: [LEMON] });
            fireEvent.click(screen.getByRole('button', { name: 'Remove Lemon' }));
            await save();
            await waitFor(() => expect(update).toHaveBeenCalled());
            expect(update.mock.calls[0][2]).toMatchObject({ tags: [] });
        });

        it('a tag put on goes with the ones it had', async () => {
            const { update } = await openForm({ ...eggs, tags: [LEMON] });
            fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }));
            fireEvent.change(screen.getByPlaceholderText('Search tags...'), { target: { value: 'orange' } });
            fireEvent.click(screen.getByRole('button', { name: 'Orange' }));
            fireEvent.click(screen.getByRole('button', { name: 'Done' }));
            await save();
            await waitFor(() => expect(update).toHaveBeenCalled());
            expect(update.mock.calls[0][2]).toMatchObject({ tags: [LEMON, ORANGE] });
        });

        it("Escape in the tag sheet shuts the sheet and leaves the edit open: nothing typed is lost", async () => {
            await openForm();
            const title = screen.getByPlaceholderText('Title') as HTMLInputElement;
            fireEvent.change(title, { target: { value: 'Unsaved words' } });
            fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }));
            fireEvent.keyDown(screen.getByPlaceholderText('Search tags...'), { key: 'Escape' });
            expect(screen.queryByPlaceholderText('Search tags...')).toBeNull();
            expect((screen.getByPlaceholderText('Title') as HTMLInputElement).value).toBe('Unsaved words');
            expect(screen.getByText('💾 Save')).toBeInTheDocument();
        });
    });

    describe('leaving a listing ends its edit: the form never opens on the next one holding the first\'s words (review of #2663)', () => {
        const lemons = { ...eggs, title: 'Lemons', tags: ['food.fruit.lemon'] };
        const jam = { ...eggs, id: 'offer-jam', title: 'Plum jam', description: 'Last summer', credits: 9, photos: [] };
        const props = { identity, isMember: true, onPostOpened: () => {}, transactions: [] };

        /** Lemons open at its Edit form, with words typed, and the next listing ready. */
        async function editLemons() {
            stubNode([lemons, jam], [ENT]);
            const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: jam }) as any);
            const page = render(<MarketplacePage {...props} openPostId="offer-eggs" />);
            await screen.findByRole('heading', { name: /Lemons/ });
            await waitFor(() => expect(screen.getByText('✏️ Edit Post')).toBeInTheDocument());
            fireEvent.click(screen.getByText('✏️ Edit Post'));
            fireEvent.change(screen.getByPlaceholderText('Title'), { target: { value: 'Lemons from A' } });
            return { page, update };
        }

        it('a tag chip tapped during an edit: the next listing opens to read, with nothing of the first to Save', async () => {
            const { page, update } = await editLemons();
            fireEvent.click(screen.getByRole('button', { name: 'Filter marketplace by tag Lemon' }));
            await settle();
            page.rerender(<MarketplacePage {...props} openPostId="offer-jam" />);
            await screen.findByRole('heading', { name: /Plum jam/ });
            expect(screen.queryByText('💾 Save')).toBeNull();
            await waitFor(() => expect(screen.getByText('✏️ Edit Post')).toBeInTheDocument());
            fireEvent.click(screen.getByText('✏️ Edit Post'));
            expect((screen.getByPlaceholderText('Title') as HTMLInputElement).value).toBe('Plum jam');
            expect(update).not.toHaveBeenCalled();
        });

        it('the Market tab tapped again during an edit does the same', async () => {
            const { page } = await editLemons();
            page.rerender(<MarketplacePage {...props} openPostId="offer-eggs" marketClickCount={1} />);
            await settle();
            page.rerender(<MarketplacePage {...props} openPostId="offer-jam" marketClickCount={1} />);
            await screen.findByRole('heading', { name: /Plum jam/ });
            expect(screen.queryByText('💾 Save')).toBeNull();
        });

        it('an edit saved stays on its listing: Save still closes the form there, and re-reading it does not', async () => {
            const { page, update } = await editLemons();
            expect(screen.getByText('💾 Save')).toBeInTheDocument();
            page.rerender(<MarketplacePage {...props} openPostId="offer-eggs" />);
            await settle();
            // The same listing read again: the member's words and the form stay.
            expect((screen.getByPlaceholderText('Title') as HTMLInputElement).value).toBe('Lemons from A');
            expect(update).not.toHaveBeenCalled();
        });
    });

    it('Pause and Resume Offer for a keeper of the enterprise: calls pauseMarketplacePost and resumeMarketplacePost with member\'s key', async () => {
        const listings: Array<Record<string, unknown>> = [eggs];
        stubNode(listings, [ENT]);
        const pause = vi.spyOn(api, 'pauseMarketplacePost').mockImplementation(async () => {
            listings[0] = { ...eggs, status: 'paused' };
            return { success: true };
        });
        const resume = vi.spyOn(api, 'resumeMarketplacePost').mockImplementation(async () => {
            listings[0] = { ...eggs, status: 'active' };
            return { success: true };
        });
        await openEggs();

        await waitFor(() => expect(screen.getByText('⏸️ Pause Offer')).toBeInTheDocument());
        await act(async () => { fireEvent.click(screen.getByText('⏸️ Pause Offer')); });

        await waitFor(() => expect(pause).toHaveBeenCalledWith('offer-eggs', ME));
        await waitFor(() => expect(screen.getByText('▶️ Activate Offer')).toBeInTheDocument());

        await act(async () => { fireEvent.click(screen.getByText('▶️ Activate Offer')); });
        await waitFor(() => expect(resume).toHaveBeenCalledWith('offer-eggs', ME));
        await waitFor(() => expect(screen.getByText('⏸️ Pause Offer')).toBeInTheDocument());
    });

    it('a member who keeps nothing, or keeps another enterprise: no Edit and no Pause', async () => {
        stubNode([eggs], []);
        await openEggs();
        expect(screen.queryByText('✏️ Edit Post')).toBeNull();
        expect(screen.queryByText('⏸️ Pause Offer')).toBeNull();
        cleanup();

        stubNode([eggs], ['another-enterprise-pk']);
        await openEggs();
        expect(screen.queryByText('✏️ Edit Post')).toBeNull();
        expect(screen.queryByText('⏸️ Pause Offer')).toBeNull();
    });

    it('a keeper who signs out on the open listing: no Edit, the enterprises they kept go with them', async () => {
        stubNode([eggs], [ENT]);
        const page = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-eggs" onPostOpened={() => {}} transactions={[]} />);
        await screen.findByRole('heading', { name: /Dozen eggs/ });
        await waitFor(() => expect(screen.getByText('✏️ Edit Post')).toBeInTheDocument());

        page.rerender(<MarketplacePage identity={null} isMember={null as any} openPostId="offer-eggs" onPostOpened={() => {}} transactions={[]} />);
        await settle();
        expect(screen.getByRole('heading', { name: /Dozen eggs/ })).toBeInTheDocument();
        expect(screen.queryByText('✏️ Edit Post')).toBeNull();
    });

    it("a keeper and a listing that isn't for everyone here (a group's): no Edit, as the node takes none", async () => {
        const forGroup = { ...eggs, audienceScope: 'group', targetGroupId: 'g1' };
        stubNode([forGroup], [ENT]);
        await openEggs();
        expect(screen.queryByText('✏️ Edit Post')).toBeNull();
    });
});
