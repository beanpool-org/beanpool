/**
 * Every listing price unit, taken up and released on the web Market (#3378): MarketplacePage rendered for real, its node
 * calls spied, so each row of the table says what a member SEES (the box over the quantity, the sentence with the total)
 * and what the page SENDS (the quantity on the wire, `hours`). The weight a per-kilo listing asks for is entered as an
 * hourly one's hours are (Marty, 25 Nov 2026: "yes ask for the weight like hours"): any decimals in the member's own decimal
 * mark (core parseAmount), Confirm off for nothing, 0 or a negative, and a weight past what a deal can be for refused in the
 * node's own words (engine/post-fields.ts DEAL_QUANTITY_ERROR, as an hourly listing's hours are).
 *
 * Its node-side twin is apps/server/src/test-price-units.ts (every unit × Offer/Need × create/edit × deal amount and
 * release), its phone twin the "every price unit, taken up on the phone" table in
 * apps/native/utils/__tests__/post-detail-words-render.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PRICE_UNITS, dealAmountFor, feeOf, formatHundredths, needAnswerLine, releaseAmount, type PriceUnit } from '@beanpool/core';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { estimatedLabel, estimateLength, actualWorkedLabel } from '../lib/price-unit-words';

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
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({ features: { priceUnitsKgYear: true } })), joinInFlight: vi.fn(async () => false) }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useFeatureMode: () => 'live',
}));
vi.mock('../components/MarketplaceCard', () => ({ MarketplaceCard: ({ post }: { post: { title: string } }) => <div data-testid="card-stub">{post.title}</div> }));
vi.mock('../components/EventCard', () => ({ EventCard: () => null, EventDetail: () => null }));
vi.mock('../components/YourEvents', () => ({ YourEvents: () => null }));
vi.mock('../components/CategoryPickerModal', () => ({ CategoryPickerModal: () => null }));
vi.mock('../components/MyDealsModal', () => ({ MyDealsModal: () => null }));
vi.mock('../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
vi.mock('../components/ExampleListings', () => ({ ExampleListings: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/MembersOnlyListings', async (orig) => ({
    ...(await orig<typeof import('../components/MembersOnlyListings')>()),
    MembersOnlyListings: () => null,
}));
vi.mock('../components/ProfileGateModal', () => ({ ProfileGateModal: () => null }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Mia', createdAt: '2026-09-17T00:00:00.000Z' };
const TODAY = new Date().toISOString();
/** 7.50 Beans a unit, whole hundredths. */
const PRICE = 750;

const listingOf = (kind: 'offer' | 'need', unit: PriceUnit, extra: Record<string, unknown> = {}) => ({
    id: `l-${kind}-${unit}`, type: kind, category: 'food', title: `Thing ${kind} ${unit}`, description: 'For the table test', price_c: PRICE,
    priceType: unit, status: 'active', active: true, authorPublicKey: 'david-pk', authorCallsign: 'David', createdAt: TODAY,
    audienceScope: 'public', ...(unit === 'each' ? { unitsLeft: 9, lot: null } : {}), ...extra,
});

function stubNode(posts: unknown[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) =>
        (f?.id ? (posts as Array<{ id: string }>).filter(p => p.id === f.id) : f?.author ? [] : posts) as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance_c: 100_000, isBlockedFromTrading: false } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([] as any);
    vi.spyOn(api, 'getCommissionCapacity').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: ME, area: { lat: -28.5, lng: 153.5 } } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({ avatar: null, bio: '', contact: null } as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 0, count: 0, asProvider: { average: 0, count: 0 }, asReceiver: { average: 0, count: 0 } });
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] });
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
    vi.spyOn(api, 'createConversationApi').mockResolvedValue({ conversation: { id: 'c1' } } as any);
}

const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 30)); }); };
const said: string[] = [];
let accept: MockInstance<typeof api.acceptMarketplacePost>;
let request: MockInstance<typeof api.requestMarketplacePost>;

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    said.length = 0;
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
    accept = vi.spyOn(api, 'acceptMarketplacePost').mockResolvedValue({ success: true, transaction: { id: 'tx-new' } } as any);
    request = vi.spyOn(api, 'requestMarketplacePost').mockResolvedValue({ success: true, transaction: { id: 'tx-new' } } as any);
});
afterEach(() => { cleanup(); });

async function openListing(post: ReturnType<typeof listingOf>, transactions?: api.MarketplaceTransaction[]) {
    stubNode([post]);
    const view = render(<MarketplacePage identity={identity} isMember={true} openPostId={post.id} onPostOpened={() => {}} {...(transactions ? { transactions } : {})} />);
    await screen.findByRole('heading', { name: new RegExp(post.title) });
    await settle();
    return view;
}
const takeUpButton = (kind: 'offer' | 'need') => screen.getByRole('button', { name: kind === 'offer' ? '🤝 Accept Offer' : '✋ I can do this' });
const confirmButton = () => screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
/** The quantity box in the take-up panel: the one text box drawn under its label. */
const quantityBox = (unit: PriceUnit) => screen.getByText(estimatedLabel(unit)).parentElement!.querySelector('input') as HTMLInputElement;

/**
 * What each unit's take-up is on the web, by the rules the node holds it to (core priceUnitDealKind, standingUnitForListing):
 * `box` the quantity is asked for under a label of its own; `standing` a week's or a month's price taken up period by period
 * (DESIGN-standing-deals-fable §2.2: no quantity box; a Need's helper offers one period); `each` the per-item box
 * (pages/MarketplacePage.per-item tests); `none` the posted price, nothing asked.
 */
const TAKE_UP: Record<PriceUnit, 'none' | 'each' | 'box' | 'standing'> = {
    fixed: 'none', each: 'each', hourly: 'box', daily: 'box', weekly: 'standing', monthly: 'standing', yearly: 'box', per_kg: 'box',
};

describe('every price unit × Offer and Need, taken up on the web: what is shown and what is sent', () => {
    it('the table covers every unit the node knows', () => {
        expect(Object.keys(TAKE_UP)).toEqual([...PRICE_UNITS]);
    });

    for (const unit of PRICE_UNITS) {
        for (const kind of ['offer', 'need'] as const) {
            if (unit === 'each' && kind === 'need') continue; // a Need is never priced each (the node refuses it: test-price-units)
            const how = TAKE_UP[unit];
            it(`${kind} priced ${unit}: ${how}`, async () => {
                const post = listingOf(kind, unit);
                await openListing(post);
                fireEvent.click(takeUpButton(kind));
                await settle();
                const sent = kind === 'offer' ? accept : request;

                if (how === 'box') {
                    // The box names the unit, starts at 1, and takes any decimals in the member's decimal mark.
                    expect(screen.getByText(estimatedLabel(unit))).toBeInTheDocument();
                    const box = quantityBox(unit);
                    expect(box.value).toBe('1');
                    fireEvent.change(box, { target: { value: '2.5' } });
                    const held = dealAmountFor(PRICE, 2.5);
                    expect(held).toBe(1875);
                    if (kind === 'offer') {
                        expect(screen.getByText(/^By proceeding, you commit/).textContent).toBe(
                            `By proceeding, you commit ${formatHundredths(held)} B (${estimateLength(unit, 2.5)}) to a Trust Wallet. When finalized, the provider will receive ${formatHundredths(held - feeOf(held))} B (net of 1.5% transaction fee (100% community owned) to fund the Commons Pool).`);
                    } else {
                        expect(screen.getByText(needAnswerLine(held, 'David'))).toBeInTheDocument();
                    }
                    // Per kilo, the kilos and what they come to, both sides (core weightTakeUpLine); no other unit has the line.
                    const weightLine = screen.queryByTestId('weight-take-up-line');
                    if (unit === 'per_kg') expect(weightLine?.textContent).toBe('2.5 kilos at 7.50 Beans a kilo comes to 18.75 Beans.');
                    else expect(weightLine).toBeNull();
                    await act(async () => { fireEvent.click(confirmButton()); });
                    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
                    expect(sent).toHaveBeenCalledWith(post.id, ME, 2.5);
                } else if (how === 'standing') {
                    // No quantity box: an Offer signs a standing deal's authorisation (components/StandingDeal), a Need's helper
                    // offers one period, sent as a quantity of 1.
                    expect(screen.queryByText(estimatedLabel(unit))).toBeNull();
                    if (kind === 'need') {
                        await act(async () => { fireEvent.click(confirmButton()); });
                        await waitFor(() => expect(request).toHaveBeenCalledWith(post.id, ME, 1));
                    } else {
                        expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
                        expect(accept).not.toHaveBeenCalled();
                    }
                } else if (how === 'each') {
                    // The per-item box, never the quantity box (its own suite judges the count and the lot).
                    expect(screen.queryByText(estimatedLabel(unit))).toBeNull();
                    expect(screen.queryByText(/ESTIMATED/)).toBeNull();
                } else {
                    // A total: nothing asked, the posted price held and sent with no quantity.
                    expect(screen.queryByText(/ESTIMATED|WEIGHT/)).toBeNull();
                    if (kind === 'offer') {
                        expect(screen.getByText(/^By proceeding, you commit/).textContent).toContain(`commit ${formatHundredths(PRICE)} B to a Trust Wallet`);
                    } else {
                        expect(screen.getByText(needAnswerLine(PRICE, 'David'))).toBeInTheDocument();
                    }
                    await act(async () => { fireEvent.click(confirmButton()); });
                    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
                    expect(sent).toHaveBeenCalledWith(post.id, ME, undefined);
                }
            });
        }
    }
});

describe('a per-kilo take-up refuses what the hours box refuses, on both sides', () => {
    for (const kind of ['offer', 'need'] as const) {
        it(`${kind}: nothing, 0 or a negative weight leaves Confirm off and sends nothing; a decimal comma reads in the member's mark`, async () => {
            await openListing(listingOf(kind, 'per_kg'));
            fireEvent.click(takeUpButton(kind));
            await settle();
            const box = quantityBox('per_kg');
            for (const typed of ['', '0', '-2', '0.00']) {
                fireEvent.change(box, { target: { value: typed } });
                expect(confirmButton().disabled, `"${typed}"`).toBe(true);
                expect(screen.queryByTestId('weight-take-up-line'), `"${typed}"`).toBeNull();
            }
            fireEvent.click(confirmButton());
            expect(accept).not.toHaveBeenCalled();
            expect(request).not.toHaveBeenCalled();
            fireEvent.change(box, { target: { value: '0.25' } });
            expect(confirmButton().disabled).toBe(false);
            expect(screen.getByTestId('weight-take-up-line').textContent).toBe('0.25 kilos at 7.50 Beans a kilo comes to 1.87 Beans.');
        });

        it(`${kind}: a weight past what a deal can be for is refused in the node's words, as an hourly box's hours are`, async () => {
            const words = 'The quantity must be a number from 0.01 to 10000';
            (kind === 'offer' ? accept : request).mockRejectedValueOnce(new Error(words));
            await openListing(listingOf(kind, 'per_kg'));
            fireEvent.click(takeUpButton(kind));
            await settle();
            fireEvent.change(quantityBox('per_kg'), { target: { value: '10001' } });
            await act(async () => { fireEvent.click(confirmButton()); });
            await waitFor(() => expect(said).toContain(words));
            expect(kind === 'offer' ? accept : request).toHaveBeenCalledWith(`l-${kind}-per_kg`, ME, 10001);
        });
    }
});

describe('a per-kilo deal released on the web: the weight confirmed, the figure the node pays, and what is sent', () => {
    it('the payer confirms the kilos (any decimals): the line moves with them and Release sends them', async () => {
        const complete = vi.spyOn(api, 'completeMarketplaceTransaction').mockResolvedValue({ success: true } as any);
        const held = dealAmountFor(PRICE, 2.5);
        const post = listingOf('offer', 'per_kg', { status: 'pending', pendingTransactionId: 'tx-1' });
        const tx = {
            id: 'tx-1', postId: post.id, postTitle: post.title, buyerPublicKey: ME, buyerCallsign: 'Mia', sellerPublicKey: 'david-pk',
            sellerCallsign: 'David', amount_c: held, hours: 2.5, status: 'pending', createdAt: TODAY,
        } as unknown as api.MarketplaceTransaction;
        await openListing(post, [tx]);
        fireEvent.click(screen.getByText('✅ Release Beans'));
        expect(screen.getByText(actualWorkedLabel('per_kg'))).toBeInTheDocument();
        expect(actualWorkedLabel('per_kg')).toBe('ACTUAL WEIGHT (KILOS)');
        const box = screen.getByText('ACTUAL WEIGHT (KILOS)').parentElement!.querySelector('input') as HTMLInputElement;
        expect(box.value).toBe('2.5');
        expect(screen.getByText(`Transferring ${formatHundredths(held)} B to David`)).toBeInTheDocument();
        fireEvent.change(box, { target: { value: '3' } });
        const paid = releaseAmount({ amount_c: held, hours: 2.5 }, 3, { priceType: 'per_kg' });
        expect(paid).toBe(2250);
        expect(screen.getByText(`Transferring ${formatHundredths(paid)} B to David`)).toBeInTheDocument();
        fireEvent.change(box, { target: { value: '0' } });
        expect((screen.getByRole('button', { name: 'Release Beans' }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(box, { target: { value: '3' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Release Beans' })); });
        await waitFor(() => expect(complete).toHaveBeenCalledWith('tx-1', ME, 3));
    });
});
