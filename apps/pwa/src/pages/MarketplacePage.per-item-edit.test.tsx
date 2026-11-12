/**
 * The seller editing a listing priced for each one on the web (DESIGN-per-item-price-fable.md §2.5, §4.6, slice P4): the same
 * three fields as the create form, the count read from the node as the form opens and sent back as `unitsLeftWas`, the price for
 * all of them kept, set or cleared by what the seller did to its box, a count that changed under them told in the node's own
 * sentence, and a Total listing made Each with the figure carried into the price for all. Rob's panels: 300 Beans each, 20 of
 * them, or all 20 for 5,500. Each check names the change that turns it red.
 *
 * The listing's own words only: the cards, sheets and modals it draws are stubbed, as in MarketplacePage.keeper-edit.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { setLanguage } from '@beanpool/core';

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

// What the node answers about itself; a test sets it (perItem present or not).
let info: Record<string, unknown> = {};
vi.mock('../lib/visitor-lobby-gate', async (orig) => ({
    ...(await orig<typeof import('../lib/visitor-lobby-gate')>()),
    communityInfoOnce: vi.fn(async () => info),
    joinInFlight: vi.fn(async () => false),
}));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Rob', createdAt: '2026-09-17T00:00:00.000Z' };
const TODAY = new Date().toISOString();
const PHOTO = '/api/marketplace/posts/offer-panels/photos/0?k=abc';

/** Rob's panels: 300 each, 20 left, all 20 for 5,500. */
const panels = (over: Record<string, unknown> = {}) => ({
    id: 'offer-panels', type: 'offer', category: 'tools', title: 'Solar panels', description: 'Second hand, tested', price_c: 30000, priceType: 'each',
    unitsLeft: 20, lot: { units: 20, price_c: 550000 },
    status: 'active', active: true, repeatable: false, authorPublicKey: ME, authorCallsign: 'Rob', createdAt: TODAY, photos: [PHOTO],
    audienceScope: 'public', ...over,
});
/** The same listing as a one-price Total listing. */
const stool = { id: 'offer-panels', type: 'offer', category: 'tools', title: 'Solar panels', description: 'Second hand, tested', price_c: 550000, priceType: 'fixed',
    status: 'active', active: true, repeatable: false, authorPublicKey: ME, authorCallsign: 'Rob', createdAt: TODAY, photos: [PHOTO], audienceScope: 'public' };

function stubNode(listing: Record<string, unknown>) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => (f?.id && f.id !== listing.id ? [] : f?.author ? [] : [listing]) as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance_c: 10000, isBlockedFromTrading: false, keeperOf: [] } as any);
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
async function openEdit(deals: unknown[] = []) {
    render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-panels" onPostOpened={() => {}} transactions={deals as any} onRefreshTransactions={vi.fn()} />);
    await screen.findByRole('heading', { name: /Solar panels/ });
    await settle();
    await waitFor(() => expect(screen.getByText('✏️ Edit Post')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('✏️ Edit Post')); });
    await settle();
}
const save = async () => { await act(async () => { fireEvent.click(screen.getByText('💾 Save')); }); };
const count = () => screen.getByTestId('per-item-count') as HTMLInputElement;
const lot = () => screen.getByTestId('per-item-lot') as HTMLInputElement;
const typeInto = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetCommunityInfoOnce();
    info = {};
});
afterEach(() => { cleanup(); setLanguage('en'); });

describe('editing a listing priced for each one (§2.5)', () => {
    it('opens with the count read from the node and the price for all while it is for that count; HOW MANY DO YOU HAVE LEFT? (red if the boxes open empty)', async () => {
        stubNode(panels());
        await openEdit();
        expect(screen.getByText(/HOW MANY DO YOU HAVE LEFT\?/)).toBeInTheDocument();
        expect(screen.getByText(/PRICE FOR ONE/)).toBeInTheDocument();
        expect(count().value).toBe('20');
        expect(lot().value).toBe('5500');
        expect(screen.getByTestId('per-item-hint')).toHaveTextContent('All 20 for 5,500 Beans. One by one they come to 6,000.');
        // Each has no Repeatable tick.
        expect(screen.queryByText('Recurring Need / Offer')).toBeNull();
    });

    it('a title edit sends the unit, the count, the count it read and the price for all as it stands, and never Repeatable (red if unitsLeftWas is dropped)', async () => {
        stubNode(panels());
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels({ title: 'Solar panels, 20' }) }) as any);
        await openEdit();
        typeInto(screen.getByPlaceholderText('Title'), 'Solar panels, 20');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update).toHaveBeenCalledWith('offer-panels', ME, {
            type: 'offer', category: 'tools', title: 'Solar panels, 20', description: 'Second hand, tested', price_c: 30000, priceType: 'each',
            unitsLeft: 20, unitsLeftWas: 20, lot: { price_c: 550000 }, repeatable: false, photos: [PHOTO],
        });
    });

    it('a price for all that was for another number: the box opens EMPTY with the reason, and a title edit leaves it stored (red if it is cleared)', async () => {
        stubNode(panels({ unitsLeft: 17 }));
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 17 }) }) as any);
        await openEdit();
        expect(count().value).toBe('17');
        expect(lot().value).toBe('');
        expect(screen.getByTestId('per-item-lot-other')).toHaveTextContent(
            'Your price for all of them was for 20. There are 17 left, so it is not showing. Set a price for the 17 left, or leave this empty.');
        // Its line stands in place of "Leave this empty to sell them one by one only." (§2.5), not beside it.
        expect(screen.queryByTestId('per-item-hint')).toBeNull();
        typeInto(screen.getByPlaceholderText('Title'), 'Solar panels, 17');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        const sent = update.mock.calls[0][2] as Record<string, unknown>;
        expect(sent).toMatchObject({ priceType: 'each', unitsLeft: 17, unitsLeftWas: 17 });
        expect(sent).not.toHaveProperty('lot');
    });

    it('a price for all set for the 17 left is sent as { price_c } (red if it is sent without the count it was read at)', async () => {
        stubNode(panels({ unitsLeft: 17 }));
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 17 }) }) as any);
        await openEdit();
        typeInto(lot(), '4500');
        expect(screen.getByTestId('per-item-hint')).toHaveTextContent('All 17 for 4,500 Beans. One by one they come to 5,100.');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update.mock.calls[0][2]).toMatchObject({ unitsLeft: 17, unitsLeftWas: 17, lot: { price_c: 450000 } });
    });

    it('the seller empties the price for all: null clears it (red if an emptied box sends nothing and the old price stays)', async () => {
        stubNode(panels());
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels({ lot: undefined }) }) as any);
        await openEdit();
        typeInto(lot(), '');
        expect(screen.getByTestId('per-item-hint')).toHaveTextContent('Leave this empty to sell them one by one only.');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update.mock.calls[0][2]).toMatchObject({ lot: null });
    });

    it('the seller changes the count: unitsLeft is the new count and unitsLeftWas the count it read (red if the node cannot tell a sale from an edit)', async () => {
        stubNode(panels({ lot: undefined }));
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 25, lot: undefined }) }) as any);
        await openEdit();
        typeInto(count(), '25');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update.mock.calls[0][2]).toMatchObject({ unitsLeft: 25, unitsLeftWas: 20 });
    });

    it('a count typed on an Arabic number pad is read as 25, not refused (red if the count box takes ASCII digits only)', async () => {
        stubNode(panels({ lot: undefined }));
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 25, lot: undefined }) }) as any);
        await openEdit();
        setLanguage('ar');
        typeInto(count(), '٢٥');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update.mock.calls[0][2]).toMatchObject({ unitsLeft: 25, unitsLeftWas: 20 });
        expect(screen.queryByTestId('per-item-refusal')).toBeNull();
    });

    it('a count changed to 0 is refused with the design\'s words, and nothing is sent (red if 0 is sent)', async () => {
        stubNode(panels());
        const update = vi.spyOn(api, 'updateMarketplacePost').mockResolvedValue({ success: true, post: panels() } as any);
        await openEdit();
        typeInto(count(), '0');
        await save();
        expect(await screen.findByTestId('per-item-refusal')).toHaveTextContent('To stop selling, pause or remove the listing.');
        expect(update).not.toHaveBeenCalled();
    });

    it('all taken for now (0 left) can still be edited: the 0 is not a change, so it is not refused', async () => {
        stubNode(panels({ unitsLeft: 0, lot: undefined }));
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 0, lot: undefined }) }) as any);
        await openEdit();
        expect(count().value).toBe('0');
        typeInto(screen.getByPlaceholderText('Title'), 'Solar panels, all taken');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update.mock.calls[0][2]).toMatchObject({ unitsLeft: 0, unitsLeftWas: 0 });
    });

    it('a take-up landed while the form was open: the node\'s 409 shows how many are left now, the box shows it, and the form stays open (red if it closes as saved)', async () => {
        stubNode(panels({ lot: undefined }));
        const update = vi.spyOn(api, 'updateMarketplacePost')
            .mockRejectedValueOnce(Object.assign(new Error('Someone took some while you were editing.'), { status: 409, code: 'units_changed', unitsLeft: 17 }))
            .mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 18, lot: undefined }) }) as any);
        await openEdit();
        typeInto(count(), '18');
        await save();
        expect(await screen.findByTestId('per-item-refusal')).toHaveTextContent('Someone took some while you were editing. There are 17 left now. Check the number and save again.');
        expect(count().value).toBe('17');
        expect(screen.getByText('💾 Save')).toBeInTheDocument();
        // Checked and saved again: made against the count now.
        typeInto(count(), '18');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
        expect(update.mock.calls[1][2]).toMatchObject({ unitsLeft: 18, unitsLeftWas: 17 });
    });

    it('after the 409 the price-for-all box is read again for the count now: it does not keep a figure the node holds for 20, and the save does not send it back (red if the box keeps "5000" and "All 17 for 5,000" shows)', async () => {
        // 20 left, all 20 for 5,000, 300 each (17 × 300 = 5,100, so the old figure would still read as good for the 17).
        const lot20 = { units: 20, price_c: 500000 };
        stubNode(panels({ lot: lot20 }));
        const update = vi.spyOn(api, 'updateMarketplacePost')
            .mockRejectedValueOnce(Object.assign(new Error('Someone took some while you were editing.'), { status: 409, code: 'units_changed', unitsLeft: 17 }))
            .mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 17, lot: lot20 }) }) as any);
        await openEdit();
        expect(lot().value).toBe('5000');
        typeInto(count(), '19');
        await save();
        expect(await screen.findByTestId('per-item-refusal')).toHaveTextContent('There are 17 left now. Check the number and save again.');
        expect(count().value).toBe('17');
        // The box the seller did not touch is empty for the 17 left, with the reason; the live line no longer promises a price for all 17.
        expect(lot().value).toBe('');
        expect(screen.getByTestId('per-item-lot-other')).toHaveTextContent('Your price for all of them was for 20. There are 17 left, so it is not showing.');
        expect(screen.queryByText(/All 17 for 5,000/)).toBeNull();
        await save();
        await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
        const sent = update.mock.calls[1][2] as Record<string, unknown>;
        expect(sent).toMatchObject({ priceType: 'each', unitsLeft: 17, unitsLeftWas: 17 });
        // lot is absent: the stored price for 20 is kept as it is, and nothing says it is on offer for the 17.
        expect(sent).not.toHaveProperty('lot');
    });

    it('after the 409 a price the seller typed themselves stays in the box and is sent for the count now', async () => {
        const lot20 = { units: 20, price_c: 500000 };
        stubNode(panels({ lot: lot20 }));
        const update = vi.spyOn(api, 'updateMarketplacePost')
            .mockRejectedValueOnce(Object.assign(new Error('Someone took some while you were editing.'), { status: 409, code: 'units_changed', unitsLeft: 17 }))
            .mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 17, lot: { units: 17, price_c: 480000 } }) }) as any);
        await openEdit();
        typeInto(lot(), '4800');
        await save();
        expect(await screen.findByTestId('per-item-refusal')).toHaveTextContent('There are 17 left now.');
        expect(count().value).toBe('17');
        expect(lot().value).toBe('4800');
        expect(screen.getByTestId('per-item-hint')).toHaveTextContent('All 17 for 4,800 Beans. One by one they come to 5,100.');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
        expect(update.mock.calls[1][2]).toMatchObject({ unitsLeft: 17, unitsLeftWas: 17, lot: { price_c: 480000 } });
    });

    it('a stored price for another number that the lowered price for one makes not-less is cleared, not refused about a box the seller cannot see', async () => {
        stubNode(panels({ unitsLeft: 17 }));
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels({ unitsLeft: 17, lot: undefined, price_c: 25000 }) }) as any);
        await openEdit();
        expect(lot().value).toBe('');
        // 20 × 250 = 5,000, and the 5,500 stored for the 20 is no longer less than that.
        typeInto(screen.getByLabelText('PRICE FOR ONE'), '250');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        expect(update.mock.calls[0][2]).toMatchObject({ price_c: 25000, unitsLeft: 17, unitsLeftWas: 17, lot: null });
        expect(screen.queryByTestId('per-item-refusal')).toBeNull();
    });

    it('3 held for buyers: "3 are held for buyers now. They are not counted here." (red if the note is missing or counts a deal twice)', async () => {
        const held = [{
            id: 'tx-1', postId: 'offer-panels', postTitle: 'Solar panels', status: 'pending', buyerPublicKey: 'buyer-pk', buyerCallsign: 'Dana', sellerPublicKey: ME,
            sellerCallsign: 'Rob', amount_c: 90000, hours: 3, createdAt: TODAY, itemOption: 'each',
        }];
        stubNode(panels({ unitsLeft: 17, lot: undefined }));
        await openEdit(held);
        expect(screen.getByTestId('per-item-held')).toHaveTextContent('3 are held for buyers now. They are not counted here.');
    });

    it('no deals held: no note', async () => {
        stubNode(panels());
        await openEdit();
        expect(screen.queryByTestId('per-item-held')).toBeNull();
    });

    it('the node cannot be asked for the count: the form closes and says so, rather than open on a count it never saw (red if it opens on the list\'s old count)', async () => {
        stubNode(panels());
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-panels" onPostOpened={() => {}} transactions={[]} />);
        await screen.findByRole('heading', { name: /Solar panels/ });
        await settle();
        const reads = vi.mocked(api.getMarketplacePosts);
        reads.mockImplementation(async (f?: any) => { if (f?.id) throw new Error('down'); return [panels()] as any; });
        await act(async () => { fireEvent.click(screen.getByText('✏️ Edit Post')); });
        await settle();
        expect(await screen.findByText("Your community couldn't be reached. Try again.")).toBeInTheDocument();
        expect(screen.queryByText('💾 Save')).toBeNull();
    });
});

describe('a one-price listing made Each (§2.4)', () => {
    it('the node does not say perItem: no Each in the list (red if Each shows early)', async () => {
        info = {};
        stubNode(stool);
        await openEdit();
        expect(Array.from((screen.getByDisplayValue('Total') as HTMLSelectElement).options).map(o => o.value)).toEqual(['fixed', 'hourly', 'daily', 'weekly', 'monthly']);
    });

    it('the node says perItem: Total typed as 5500 moves to the price for all, the price for one is empty and focused (red if it stays in the price box)', async () => {
        info = { features: { perItem: true } };
        stubNode(stool);
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: panels() }) as any);
        await openEdit();
        const unit = screen.getByDisplayValue('Total') as HTMLSelectElement;
        expect(Array.from(unit.options).map(o => o.value)).toEqual(['fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly']);
        await act(async () => { fireEvent.change(unit, { target: { value: 'each' } }); });
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        const price = screen.getByLabelText('PRICE FOR ONE') as HTMLInputElement;
        expect(price.value).toBe('');
        expect(lot().value).toBe('5500');
        expect(document.activeElement).toBe(price);
        // Repeatable is gone, and a count is asked for before it can be saved.
        expect(screen.queryByText('Recurring Need / Offer')).toBeNull();
        await save();
        expect(await screen.findByTestId('per-item-refusal')).toHaveTextContent('Say how many you have: a whole number from 1 to 9,999.');
        expect(update).not.toHaveBeenCalled();
        typeInto(price, '300');
        typeInto(count(), '20');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        const sent = update.mock.calls[0][2] as Record<string, unknown>;
        expect(sent).toMatchObject({ priceType: 'each', price_c: 30000, unitsLeft: 20, lot: { price_c: 550000 }, repeatable: false });
        // Made Each by this edit: there is no count the node has to compare.
        expect(sent).not.toHaveProperty('unitsLeftWas');
    });

    it('a Total listing saved as Total sends none of the new fields (red if they leak into other units)', async () => {
        info = { features: { perItem: true } };
        stubNode(stool);
        const update = vi.spyOn(api, 'updateMarketplacePost').mockImplementation(async () => ({ success: true, post: stool }) as any);
        await openEdit();
        typeInto(screen.getByPlaceholderText('Title'), 'Solar panels, the lot');
        await save();
        await waitFor(() => expect(update).toHaveBeenCalled());
        const sent = update.mock.calls[0][2] as Record<string, unknown>;
        expect(sent).toMatchObject({ priceType: 'fixed' });
        for (const key of ['unitsLeft', 'unitsLeftWas', 'lot']) expect(sent).not.toHaveProperty(key);
    });
});
