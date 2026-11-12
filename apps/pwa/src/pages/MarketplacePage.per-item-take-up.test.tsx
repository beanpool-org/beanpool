/**
 * The buyer taking up a listing priced for each one on the web (DESIGN-per-item-price-fable.md §2.2, §2.3, slice P3): "How many
 * would you like?" in the confirm box, a number or all of them, what Confirm sends (exactly the total shown), the refusals said
 * in the box with the listing read again, and both sides' deal lines. Rob's panels: 300 Beans each, 20 of them, or all 20 for
 * 5,500. Each check names the change that turns it red.
 *
 * The listing's own words only: the cards, sheets and modals it draws are stubbed, as in MarketplacePage.per-item-edit.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { pseudoLocalise, setLanguage } from '@beanpool/core';

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
vi.mock('../lib/visitor-lobby-gate', async (orig) => ({
    ...(await orig<typeof import('../lib/visitor-lobby-gate')>()),
    communityInfoOnce: vi.fn(async () => ({})),
    joinInFlight: vi.fn(async () => false),
}));

const ME = 'me-pk';
const ROB = 'rob-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Ana', createdAt: '2026-09-17T00:00:00.000Z' };
const HELD_AT = '2026-11-11T10:00:00.000Z';
const PHOTO = '/api/marketplace/posts/offer-panels/photos/0?k=abc';

/** Rob's panels: 300 each, 20 left, all 20 for 5,500. */
const panels = (over: Record<string, unknown> = {}) => ({
    id: 'offer-panels', type: 'offer', category: 'tools', title: 'Solar panels', description: 'Second hand, tested', price_c: 30000, priceType: 'each',
    unitsLeft: 20, lot: { units: 20, price_c: 550000 },
    status: 'active', active: true, repeatable: false, authorPublicKey: ROB, authorCallsign: 'Rob', createdAt: '2026-11-10T09:00:00.000Z', photos: [PHOTO],
    audienceScope: 'public', ...over,
});
const deal = (over: Record<string, unknown> = {}) => ({
    id: 'tx-3', postId: 'offer-panels', postTitle: 'Solar panels', buyerPublicKey: ME, buyerCallsign: 'Ana', sellerPublicKey: ROB, sellerCallsign: 'Rob',
    amount_c: 90000, hours: 3, itemOption: 'each', status: 'pending', createdAt: HELD_AT, ...over,
});

let reads: unknown[] = [];
/** The listing as the node holds it now: a test moves it on (another buyer took some) and every read after sees that. */
let onNode: Record<string, unknown> = {};
function stubNode(listing: Record<string, unknown>) {
    reads = [];
    onNode = listing;
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) => {
        if (f?.author) return [] as any;
        if (f?.id) reads.push(f.id);
        return [onNode] as any;
    });
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance_c: 100000, isBlockedFromTrading: false, keeperOf: [] } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
    vi.spyOn(api, 'getCommissionCapacity').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: ME } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({ avatar: null, bio: '' } as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 0, count: 0 } as any);
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] });
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
    vi.spyOn(api, 'createConversationApi').mockResolvedValue({ conversation: { id: 'c1' } } as any);
}

let said: string[] = [];
async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}
async function openPage(deals: unknown[] = [], who: BeanPoolIdentity = identity) {
    render(<MarketplacePage identity={who} isMember={true} openPostId="offer-panels" onPostOpened={() => {}} transactions={deals as any} onRefreshTransactions={vi.fn()} />);
    await screen.findByRole('heading', { name: /Solar panels/ });
    await settle();
}
async function openBox() {
    await openPage();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '🤝 Accept Offer' })); });
    await settle();
}
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); await settle(); };
const box = () => screen.getByTestId('each-confirm');
const radioIn = (id: string) => screen.getByTestId(id).querySelector('input[type="radio"]') as HTMLInputElement;

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetCommunityInfoOnce();
    said = [];
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
});
afterEach(() => { cleanup(); setLanguage('en'); });

describe("the buyer's box (§2.2): how many, or all of them", () => {
    it('Accept Offer opens it at one: the price and count by the stepper, all 20 as the second choice, the total (red if an Each Offer gets the hours box)', async () => {
        stubNode(panels());
        await openBox();
        expect(box()).toHaveTextContent('How many would you like?');
        expect(screen.getByTestId('each-line')).toHaveTextContent('300 Beans each · 20 left');
        expect(screen.getByTestId('each-all')).toHaveTextContent('All 20 for 5,500 Beans500 less than one by one');
        expect(screen.getByTestId('each-total')).toHaveTextContent('1 × 300 = 300 Beans');
        expect(radioIn('each-choose').checked).toBe(true);
        expect(screen.queryByText(/Credits will be reserved based on this estimate/)).toBeNull();
    });

    it('3 of them: the total and what Rob receives, and Confirm sends 3 at exactly 900 (red if expect_c is not the total shown)', async () => {
        stubNode(panels());
        const accept = vi.spyOn(api, 'acceptMarketplacePost').mockResolvedValue({ success: true, transaction: deal() } as any);
        await openBox();
        await click(screen.getByTestId('each-more'));
        await click(screen.getByTestId('each-more'));
        expect((screen.getByTestId('each-count') as HTMLInputElement).value).toBe('3');
        expect(screen.getByTestId('each-total')).toHaveTextContent('3 × 300 = 900 Beans');
        expect(screen.getByTestId('each-trust')).toHaveTextContent('900 Beans go into trust now. Rob receives 886.50 when you release them (1.5% goes to the community).');
        await click(screen.getByTestId('each-confirm-btn'));
        await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
        expect(accept).toHaveBeenCalledWith('offer-panels', ME, 3, undefined, { itemOption: 'each', expect_c: 90000 });
    });

    it('all of them: picked, or typed as 20, is the price for all, and Confirm sends all 20 at 5,500 (red if 20 goes one by one at 6,000)', async () => {
        stubNode(panels());
        const accept = vi.spyOn(api, 'acceptMarketplacePost').mockResolvedValue({ success: true, transaction: deal() } as any);
        await openBox();
        await click(radioIn('each-all'));
        expect(radioIn('each-all').checked).toBe(true);
        expect(screen.getByTestId('each-total')).toHaveTextContent('All 20 for 5,500 Beans');
        expect(screen.getByTestId('each-trust')).toHaveTextContent('5,500 Beans go into trust now. Rob receives 5,417.50 when you release them (1.5% goes to the community).');
        await click(radioIn('each-choose'));
        expect(screen.getByTestId('each-total')).toHaveTextContent('19 × 300 = 5,700 Beans');
        await act(async () => { fireEvent.change(screen.getByTestId('each-count'), { target: { value: '20' } }); });
        expect(screen.getByTestId('each-total')).toHaveTextContent('All 20 for 5,500 Beans');
        await click(screen.getByTestId('each-confirm-btn'));
        await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
        expect(accept).toHaveBeenCalledWith('offer-panels', ME, 20, undefined, { itemOption: 'lot', expect_c: 550000 });
    });

    it('more than are left, or not a whole number: said in the box and Confirm is off (red if the box sends what the node refuses)', async () => {
        stubNode(panels());
        const accept = vi.spyOn(api, 'acceptMarketplacePost').mockResolvedValue({ success: true, transaction: deal() } as any);
        await openBox();
        await act(async () => { fireEvent.change(screen.getByTestId('each-count'), { target: { value: '25' } }); });
        expect(screen.getByTestId('each-refusal')).toHaveTextContent('Only 20 left now. Choose 20 or fewer.');
        expect(screen.getByTestId('each-confirm-btn')).toBeDisabled();
        await act(async () => { fireEvent.change(screen.getByTestId('each-count'), { target: { value: '2.5' } }); });
        expect(screen.getByTestId('each-refusal')).toHaveTextContent('Choose a whole number, 1 or more.');
        expect(screen.getByTestId('each-confirm-btn')).toBeDisabled();
        expect(accept).not.toHaveBeenCalled();
    });
});

describe('when the node says the listing moved on: said in the box, read again, never a different amount', () => {
    it('units_gone: "Only 2 left now. Choose 2 or fewer.", the listing read again, no alert (red if the refusal is not read)', async () => {
        stubNode(panels());
        // Someone else took 18 while the box was open: the node refuses this one and its listing reads 2 left from now on.
        const accept = vi.spyOn(api, 'acceptMarketplacePost').mockImplementation(async () => {
            onNode = panels({ unitsLeft: 2 });
            throw Object.assign(new Error('Only 2 left now. Choose 2 or fewer.'), { code: 'units_gone', unitsLeft: 2 });
        });
        await openBox();
        await click(screen.getByTestId('each-more'));
        await click(screen.getByTestId('each-more'));
        const readsBefore = reads.length;
        await click(screen.getByTestId('each-confirm-btn'));
        await waitFor(() => expect(screen.getByTestId('each-refusal')).toHaveTextContent('Only 2 left now. Choose 2 or fewer.'));
        expect(reads.length).toBeGreaterThan(readsBefore);
        expect(said).toEqual([]);
        // The box stands on the listing as it is now, at the member's own number: they choose again.
        await waitFor(() => expect(screen.getByTestId('each-line')).toHaveTextContent('300 Beans each · 2 left'));
        expect((screen.getByTestId('each-count') as HTMLInputElement).value).toBe('3');
        expect(accept).toHaveBeenCalledTimes(1);
    });

    it('lot_gone and price_changed have their sentences', async () => {
        for (const [code, words] of [
            ['lot_gone', 'One has just been taken, so the price for all of them is off. You can still take what is left one by one.'],
            ['price_changed', 'The price changed while you were looking. Check it and try again.'],
        ] as const) {
            cleanup();
            stubNode(panels());
            vi.spyOn(api, 'acceptMarketplacePost').mockRejectedValue(Object.assign(new Error('x'), { code }));
            await openBox();
            await click(radioIn('each-all'));
            await click(screen.getByTestId('each-confirm-btn'));
            await waitFor(() => expect(screen.getByTestId('each-refusal')).toHaveTextContent(words));
        }
    });

    it("a deal already under way keeps today's words", async () => {
        stubNode(panels());
        vi.spyOn(api, 'acceptMarketplacePost').mockRejectedValue(Object.assign(new Error('x'), { code: 'deal_open', transactionId: 'tx-old' }));
        await openBox();
        await click(screen.getByTestId('each-confirm-btn'));
        await waitFor(() => expect(said).toContain('You already have a deal under way on this. Finish or cancel it first.'));
    });

    it('none left: no Accept Offer, "All taken for now" in its place', async () => {
        stubNode(panels({ unitsLeft: 0 }));
        await openPage();
        expect(screen.queryByRole('button', { name: '🤝 Accept Offer' })).toBeNull();
        expect(screen.getByTestId('each-all-taken')).toHaveTextContent('All taken for now');
    });
});

describe('both sides of the deal (§2.3)', () => {
    it('the buyer: "✅ You took up 3 on 11 Nov · 900 Beans held in trust", and Release asks no number and sends none (red if the deal is re-rated)', async () => {
        stubNode(panels({ unitsLeft: 17 }));
        const complete = vi.spyOn(api, 'completeMarketplaceTransaction').mockResolvedValue({ success: true } as any);
        await openPage([deal()]);
        expect(screen.getByTestId('taker-line')).toHaveTextContent('✅ You took up 3 on 11 Nov · 900 Beans held in trust');
        await click(screen.getByRole('button', { name: '✅ Release Beans' }));
        expect(screen.queryByText(/ACTUAL|Actual time/i)).toBeNull();
        expect(screen.getByText('Transferring 900 B to Rob')).toBeInTheDocument();
        await click(screen.getByRole('button', { name: 'Release Beans' }));
        await waitFor(() => expect(complete).toHaveBeenCalledWith('tx-3', ME, undefined));
    });

    it('all of them: "✅ You took up all 20 on 11 Nov · 5,500 Beans held in trust"', async () => {
        stubNode(panels({ unitsLeft: 0 }));
        await openPage([deal({ amount_c: 550000, hours: 20, itemOption: 'lot' })]);
        expect(screen.getByTestId('taker-line')).toHaveTextContent('✅ You took up all 20 on 11 Nov · 5,500 Beans held in trust');
    });

    it('the seller: "17 left · 3 held for buyers" in the price box, and the row "Dana · 3 for 900 Beans held · since 11 Nov"', async () => {
        const rob: BeanPoolIdentity = { ...identity, publicKey: ROB, callsign: 'Rob' };
        stubNode(panels({ unitsLeft: 17 }));
        await openPage([deal({ id: 'tx-d', buyerPublicKey: 'dana-pk', buyerCallsign: 'Dana' })], rob);
        expect(screen.getByTestId('listing-each-stock')).toHaveTextContent('17 left · 3 held for buyers');
        expect(screen.getByTestId('deal-row-tx-d')).toHaveTextContent('Dana · 3 for 900 Beans held · since 11 Nov');
    });
});

describe('the words come through the words layer', () => {
    it('the pseudo-locale: the box is translated (red if a line is written past t())', async () => {
        setLanguage('xx');
        stubNode(panels());
        await openPage();
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: pseudoLocalise('🤝 Accept Offer') })); });
        await settle();
        expect(box()).toHaveTextContent(pseudoLocalise('How many would you like?'));
        expect(box()).toHaveTextContent(pseudoLocalise('Choose how many'));
    });
});
