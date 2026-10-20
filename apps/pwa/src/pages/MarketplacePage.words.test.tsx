/**
 * The web Market in the member's language (words S3, web sweep W1), as the phone's Market tab and listing screen: in the
 * pseudo-locale every word MarketplacePage itself writes came through t(), the categories' names (lib/marketplace.ts)
 * and the report reasons (lib/reportReasons.ts) included; what it SENDS stays the English the node reads. What members
 * wrote is shown as written: titles, descriptions, names, a group's, a link's and a community's name.
 *
 * Only the page's own sentences are judged here: the cards, sheets and modals it draws (MarketplaceCard, PollCard,
 * EventCard, MyDealsModal, PricingGuideModal, ActivityWaterfall, ImageLightbox, the visitor's cards, …) are stubbed,
 * each with words:check-tested files and words tests of its own. The local-community marks and the profile gate are
 * stubbed to show what the page hands them, so those words are judged as the page's.
 *
 * Left in English, and why: a server's own message (`e.message`, the trade gates' "FLOOR_LOCKED…" sentence); the
 * distance in the area line (lib/events formatDistance, not this file); a peer named by its address alone
 * ("peer (1.2.3.4)", lib/marketplace formatNodeName, which MarketplaceCard shares).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { getProfileStatus, describeMissing } from '../lib/profile-status';
import { EVENT_WINDOWS } from '../lib/events';
import { NO_BEANS_TERMS_TEXT, VISITOR_LIST_NOTE } from '../lib/visitor-lobby';
import { DEAL_ACTION_LABEL } from '../components/LocalCommunityMark';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

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
const info = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => info.value), joinInFlight: vi.fn(async () => false) }));
// Beans and deals on the global node live in a local community (preview); elsewhere live.
const modes = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useFeatureMode: (feature: string) => modes.value[feature] ?? 'live',
}));

// The page's children: stubbed, so only the page's own words are judged (see the note at the top).
vi.mock('../components/MarketplaceCard', () => ({ MarketplaceCard: ({ post }: { post: { title: string } }) => <div data-testid="card-stub">{post.title}</div> }));
vi.mock('../components/PollCard', () => ({ PollCard: ({ post }: { post: { title: string } }) => <div data-testid="poll-stub">{post.title}</div> }));
vi.mock('../components/EventCard', () => ({
    EventCard: ({ post }: { post: { title: string } }) => <div data-testid="event-stub">{post.title}</div>,
    EventDetail: ({ post }: { post: { title: string } }) => <div data-testid="event-detail-stub">{post.title}</div>,
}));
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
vi.mock('../components/VisitorListing', () => ({
    VisitorCard: ({ post }: { post: { title: string } }) => <div data-testid="visitor-card-stub">{post.title}</div>,
    VisitorPostDetail: ({ post }: { post: { title: string } }) => <div data-testid="visitor-detail-stub">{post.title}</div>,
}));
// What the page hands these is its own sentence: drawn as given, so it is judged here.
vi.mock('../components/LocalCommunityMark', async (orig) => ({
    ...(await orig<typeof import('../components/LocalCommunityMark')>()),
    LocalCommunityAction: ({ label }: { label: string }) => <button type="button" data-testid="local-action-stub">{label}</button>,
    LocalCommunityLine: ({ text }: { text: string }) => <button type="button" data-testid="local-line-stub">{text}</button>,
}));
vi.mock('../components/ProfileGateModal', () => ({ ProfileGateModal: ({ message }: { message: string }) => <div data-testid="profile-gate-stub">{message}</div> }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Mia', createdAt: '2026-09-17T00:00:00.000Z' };
const TODAY = new Date().toISOString();

const offer = {
    id: 'offer-1', type: 'offer', category: 'services', title: 'Bicycle Repair', description: 'Fix gears and brakes', credits: 20,
    priceType: 'hourly', status: 'active', active: true, authorPublicKey: 'david-pk', authorCallsign: 'David', createdAt: TODAY,
    photos: ['/assets/bean.png'], audienceScope: 'group', targetGroupId: 'g1', targetGroupName: 'Gardeners', lat: -28.6, lng: 153.4,
};
const need = {
    id: 'need-1', type: 'need', category: 'transport', title: 'Lift to town', description: 'Tuesday morning', credits: 5,
    priceType: 'fixed', status: 'active', active: true, authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-09-01T00:00:00Z',
};
const poll = {
    id: 'poll-1', type: 'poll', category: 'general', title: 'Market day?', description: 'Pick one', credits: 0, priceType: 'fixed',
    status: 'active', active: true, authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-09-02T00:00:00Z', pollOptions: [],
};

/** What members, the node and other communities wrote in the fixtures: shown as written. */
const OTHERS = [
    'Bicycle Repair', 'Fix gears and brakes', 'David', 'Lift to town', 'Tuesday morning', 'Ada', 'Market day?', 'Mia', 'Bob',
    'Gardeners', 'Byron Link', 'Byron', 'Bean Bakery', 'Sourdough loaf', 'Fresh every Friday', 'Loves bikes', 'david@example.test',
    'Daily Pulse', 'Kindness compounds', 'Share what you have',
];

const said: string[] = [];
const tx = (extra: Record<string, unknown>) => ({
    id: 'tx-1', postId: 'offer-1', postTitle: 'Bicycle Repair', buyerPublicKey: ME, buyerCallsign: 'Mia', sellerPublicKey: 'david-pk',
    sellerCallsign: 'David', credits: 20, status: 'pending', createdAt: TODAY, ...extra,
}) as unknown as api.MarketplaceTransaction;

function stubNode(posts: unknown[]) {
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f?: any) =>
        (f?.id ? (posts as Array<{ id: string }>).filter(p => p.id === f.id) : f?.author ? [] : posts) as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasury').mockResolvedValue(null);
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [{ callsign: 'Byron', publicUrl: 'https://byron.example.test' }] } as any);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    vi.spyOn(api, 'getGroups').mockResolvedValue([{ id: 'g1', name: 'Gardeners', viewerStatus: 'active', viewerRole: 'convenor' }] as any);
    vi.spyOn(api, 'getCommissionCapacity').mockResolvedValue({ links: [] });
    vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: ME, area: { lat: -28.5, lng: 153.5 } } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({ avatar: 'https://example.test/david.png', bio: 'Loves bikes', contact: { value: 'david@example.test', visibility: 'members' } } as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ ratings: [], average: 4.5, count: 2, asProvider: { average: 4, count: 1 }, asReceiver: { average: 5, count: 1 } });
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] });
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
}

async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

/** Nothing on screen, in a label or in an alert bypassed t(), and the screen is not empty. */
function allThroughT(atLeast: number) {
    expect(bypassing(document.body, { others: OTHERS, said })).toEqual([]);
    expect(bracketed()).toBeGreaterThan(atLeast);
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    info.value = {};
    modes.value = {};
    said.length = 0;
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
    vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { said.push(String(m)); return false; });
    vi.mocked(getProfileStatus).mockResolvedValue({ complete: true, missingName: false, missingAvatar: false });
});
afterEach(() => { cleanup(); backToEnglish(); });

describe('the Market in the pseudo-locale', () => {
    it('the list: the search, pills, chips, the area line, the fresh banner, the sections, For You and the empty search', async () => {
        info.value = { features: { nearbyListings: { radiusKm: 250, max: 500 } } };
        stubNode([offer, need, poll]);
        await showIn('xx');
        render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Bicycle Repair');
        await settle();
        expect(screen.getByTestId('market-near-line')).toBeInTheDocument();
        expect(screen.getByPlaceholderText(xx('Search marketplace...'))).toBeInTheDocument();
        allThroughT(15);

        // List View: the day headings.
        fireEvent.click(screen.getByRole('button', { name: xx('Switch to List View') }));
        expect(screen.getByText(xx('Today'))).toBeInTheDocument();
        allThroughT(15);

        // ★ For You: the interests, every category's name, then folded.
        fireEvent.click(screen.getByRole('button', { name: xx('★ For You') }));
        expect(screen.getByText(xx('Food & Produce'))).toBeInTheDocument();
        allThroughT(30);
        fireEvent.click(screen.getByRole('button', { name: xx('✕ HIDE') }));
        expect(screen.getByText(xx('Prioritizing: None selected yet'))).toBeInTheDocument();
        allThroughT(10);

        // Events: the date chips.
        fireEvent.click(screen.getByRole('button', { name: xx('Events') }));
        expect(within(screen.getByTestId('feed-event-window-chips')).getAllByRole('button')).toHaveLength(EVENT_WINDOWS.length);
        allThroughT(10);

        // A search that matches nothing: the member's words inside the sentence.
        fireEvent.click(within(screen.getByTestId('feed-type-filter')).getByRole('button', { name: xx('All') }));
        fireEvent.change(screen.getByPlaceholderText(xx('Search marketplace...')), { target: { value: 'zebra' } });
        expect(await screen.findByText(xx('No matches for "{query}".').replace('{query}', 'zebra'))).toBeInTheDocument();
        allThroughT(10);
    });

    it('a listing as a buyer: the card, its author, Accept with an estimate, the report form and a convenor\'s tools', async () => {
        stubNode([offer, need]);
        await showIn('xx');
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await settle();
        expect(screen.getByText(xx('Only {group} can see this').replace('{group}', 'Gardeners'))).toBeInTheDocument();
        allThroughT(10);

        fireEvent.click(screen.getByText(xx('🤝 Accept Offer')));
        expect(await screen.findByText(xx('Accept this Offer?'))).toBeInTheDocument();
        expect(screen.getByText(xx('ESTIMATED HOURS'))).toBeInTheDocument();
        allThroughT(12);

        fireEvent.click(screen.getByText(xx('🚩 Report')));
        const reasons = screen.getAllByRole('option').map(o => (o as HTMLOptionElement).value);
        expect(reasons).toEqual(expect.arrayContaining(['', 'Spam or scam', 'Child safety', 'Other']));
        allThroughT(12);

        // The convenor's delete asks first, in the member's language.
        fireEvent.click(screen.getByText(xx('🗑️ Delete Group Post (Convenor)')));
        expect(said).toEqual([xx('Delete this post as Convenor of {group}? This action cannot be undone.').replace('{group}', 'Gardeners')]);
        allThroughT(12);
    });

    it('a need to fulfil, a fixed price and a free one, and the profile gate', async () => {
        stubNode([need, { ...need, id: 'need-free', credits: 0 }]);
        await showIn('xx');
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="need-1" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Lift to town/ });
        await settle();
        fireEvent.click(screen.getByText(xx('✋ Offer to Fulfill')));
        expect(await screen.findByText(xx('Offer to Fulfill this Need?'))).toBeInTheDocument();
        allThroughT(10);
        view.unmount();

        render(<MarketplacePage identity={identity} isMember={true} openPostId="need-free" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Lift to town/ });
        await settle();
        fireEvent.click(screen.getByText(xx('✋ Offer to Fulfill')));
        expect(await screen.findByText(xx('This is a free listing (0 B). No credits transferred.'))).toBeInTheDocument();
        allThroughT(10);

        // The profile gate's card is drawn by the list (as it has been): it shows once the listing is left.
        fireEvent.click(screen.getByText(xx('Cancel')));
        vi.mocked(getProfileStatus).mockResolvedValue({ complete: false, missingName: true, missingAvatar: true });
        fireEvent.click(screen.getByText(xx('✋ Offer to Fulfill')));
        await waitFor(() => expect(getProfileStatus).toHaveBeenCalledTimes(3));
        await settle();
        fireEvent.click(screen.getByText(xx('Back to Market')));
        expect(await screen.findByTestId('profile-gate-stub')).toBeInTheDocument();
        allThroughT(10);
    });

    it('my own offer: pause, edit (the type, the categories, the price units, the photos) and delete', async () => {
        const mine = { ...offer, id: 'mine-1', authorPublicKey: ME, authorCallsign: 'Mia', audienceScope: 'public', targetGroupId: undefined, targetGroupName: undefined };
        stubNode([mine]);
        await showIn('xx');
        render(<MarketplacePage identity={identity} isMember={true} openPostId="mine-1" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await settle();
        expect(screen.getByText(xx('⏸️ Pause Offer'))).toBeInTheDocument();
        fireEvent.click(screen.getByText(xx('🗑️ Delete Post')));
        expect(said).toEqual([xx('Delete this post?')]);
        allThroughT(10);

        fireEvent.click(screen.getAllByText(xx('✏️ Edit Post'))[0]);
        expect(screen.getByPlaceholderText(xx('Title'))).toBeInTheDocument();
        expect(screen.getByRole('option', { name: xx('/ Hr') })).toBeInTheDocument();
        allThroughT(30);
    });

    it('a deal held in trust: the payer releasing it by the hour, and the payee waiting', async () => {
        const held = { ...offer, status: 'pending', pendingTransactionId: 'tx-1', audienceScope: 'public', targetGroupId: undefined, targetGroupName: undefined };
        stubNode([held]);
        await showIn('xx');
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} transactions={[tx({})]} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await settle();
        fireEvent.click(screen.getByText(xx('✅ Release Credits')));
        expect(screen.getByText(xx('ACTUAL HOURS WORKED'))).toBeInTheDocument();
        fireEvent.click(screen.getByText(xx('❌ Cancel Hold')));
        expect(said).toEqual([xx('Cancel this transaction and return the post to the market?')]);
        allThroughT(15);
        view.unmount();

        const mine = { ...held, authorPublicKey: ME, authorCallsign: 'Mia' };
        stubNode([mine]);
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}}
            transactions={[tx({ buyerPublicKey: 'bob-pk', buyerCallsign: 'Bob', sellerPublicKey: ME, sellerCallsign: 'Mia' })]} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await settle();
        expect(screen.getByText(xx('⏳ Pending Release by {name}').replace('{name}', 'Bob'))).toBeInTheDocument();
        allThroughT(10);
    });

    it('my need with offers to fulfil it, and my own offer to fulfil someone else\'s', async () => {
        const myNeed = { ...need, id: 'need-mine', authorPublicKey: ME, authorCallsign: 'Mia', priceType: 'hourly' };
        stubNode([myNeed, need]);
        await showIn('xx');
        const bid = tx({ id: 'bid-1', postId: 'need-mine', status: 'requested', buyerPublicKey: ME, sellerPublicKey: 'bob-pk', sellerCallsign: 'Bob', hours: 3 });
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="need-mine" onPostOpened={() => {}} transactions={[bid]} />);
        await screen.findByText(xx('✋ Fulfillment Requests ({n})').replace('{n}', '1'));
        allThroughT(10);
        view.unmount();

        const mine = tx({ id: 'bid-2', postId: 'need-1', status: 'requested', buyerPublicKey: 'ada-pk', sellerPublicKey: ME, sellerCallsign: 'Mia' });
        render(<MarketplacePage identity={identity} isMember={true} openPostId="need-1" onPostOpened={() => {}} transactions={[mine]} />);
        expect(await screen.findByText(xx('Offer Pending Approval'))).toBeInTheDocument();
        allThroughT(10);
    });

    it('requests word quantity in the price’s unit: daily says days, fixed lendable loan says days, hourly says hours', async () => {
        await showIn('xx');

        // Hourly deal unchanged: "{n} hours estimated"
        const hourlyNeed = { ...need, id: 'need-hourly', authorPublicKey: ME, authorCallsign: 'Mia', priceType: 'hourly' };
        stubNode([hourlyNeed]);
        const hourlyBid = tx({ id: 'bid-hourly', postId: 'need-hourly', status: 'requested', buyerPublicKey: ME, sellerPublicKey: 'bob-pk', sellerCallsign: 'Bob', hours: 3 });
        const v1 = render(<MarketplacePage identity={identity} isMember={true} openPostId="need-hourly" onPostOpened={() => {}} transactions={[hourlyBid]} />);
        await screen.findByText(xx('✋ Fulfillment Requests ({n})').replace('{n}', '1'));
        expect(screen.getByText(xx('{n} hours estimated').replace('{n}', '3'))).toBeInTheDocument();
        allThroughT(10);
        v1.unmount();

        // Daily deal as days: "{n} days"
        const dailyNeed = { ...need, id: 'need-daily', authorPublicKey: ME, authorCallsign: 'Mia', priceType: 'daily' };
        stubNode([dailyNeed]);
        const dailyBid = tx({ id: 'bid-daily', postId: 'need-daily', status: 'requested', buyerPublicKey: ME, sellerPublicKey: 'bob-pk', sellerCallsign: 'Bob', hours: 3 });
        const v2 = render(<MarketplacePage identity={identity} isMember={true} openPostId="need-daily" onPostOpened={() => {}} transactions={[dailyBid]} />);
        await screen.findByText(xx('✋ Fulfillment Requests ({n})').replace('{n}', '1'));
        expect(screen.getByText(xx('{n} days').replace('{n}', '3'))).toBeInTheDocument();
        allThroughT(10);
        v2.unmount();

        // Fixed lendable loan as days: "for {n} days"
        const loanOffer = { ...offer, id: 'offer-loan', authorPublicKey: ME, authorCallsign: 'Mia', priceType: 'fixed', lendable: true };
        stubNode([loanOffer]);
        const loanBid = tx({ id: 'bid-loan', postId: 'offer-loan', status: 'requested', buyerPublicKey: 'bob-pk', buyerCallsign: 'Bob', sellerPublicKey: ME, hours: 3 });
        const onOpenProfile = vi.fn();
        const v3 = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-loan" onPostOpened={() => {}} transactions={[loanBid]} onOpenProfile={onOpenProfile} />);
        await screen.findByText(xx('✋ Fulfillment Requests ({n})').replace('{n}', '1'));
        expect(screen.getByText(xx('for {n} days').replace('{n}', '3'))).toBeInTheDocument();
        expect(screen.getByText('Bob')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Bob/ }));
        expect(onOpenProfile).toHaveBeenCalledWith('bob-pk');
        allThroughT(10);
        v3.unmount();

        // Weekly lendable loan as weeks: "for {n} weeks"
        const weeklyLoanOffer = { ...offer, id: 'offer-loan-wk', authorPublicKey: ME, authorCallsign: 'Mia', priceType: 'weekly', lendable: true };
        stubNode([weeklyLoanOffer]);
        const weeklyLoanBid = tx({ id: 'bid-loan-wk', postId: 'offer-loan-wk', status: 'requested', buyerPublicKey: 'bob-pk', buyerCallsign: 'Bob', sellerPublicKey: ME, hours: 2 });
        const v4 = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-loan-wk" onPostOpened={() => {}} transactions={[weeklyLoanBid]} />);
        await screen.findByText(xx('✋ Fulfillment Requests ({n})').replace('{n}', '1'));
        expect(screen.getByText(xx('for {n} weeks').replace('{n}', '2'))).toBeInTheDocument();
        allThroughT(10);
        v4.unmount();

        // Fixed non-loan: no quantity unit line (empty string)
        const fixedNeed = { ...need, id: 'need-fixed', authorPublicKey: ME, authorCallsign: 'Mia', priceType: 'fixed' };
        stubNode([fixedNeed]);
        const fixedBid = tx({ id: 'bid-fixed', postId: 'need-fixed', status: 'requested', buyerPublicKey: ME, sellerPublicKey: 'bob-pk', sellerCallsign: 'Bob', hours: 2 });
        const v5 = render(<MarketplacePage identity={identity} isMember={true} openPostId="need-fixed" onPostOpened={() => {}} transactions={[fixedBid]} />);
        await screen.findByText(xx('✋ Fulfillment Requests ({n})').replace('{n}', '1'));
        expect(screen.queryByText(/hours estimated/)).not.toBeInTheDocument();
        allThroughT(10);
        v5.unmount();
    });

    it('a finished trade to rate on the listing, and the rating card a release opens', async () => {
        const done = { ...offer, status: 'completed', acceptedBy: ME, pendingTransactionId: 'tx-9', audienceScope: 'public', targetGroupId: undefined, targetGroupName: undefined };
        stubNode([done]);
        await showIn('xx');
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await settle();
        fireEvent.click(screen.getByText(xx('⭐ Rate {name} as {role}').replace('{name}', 'David').replace('{role}', xx('Provider'))));
        expect(screen.getByText(xx('Tap stars to rate'))).toBeInTheDocument();
        allThroughT(10);
        view.unmount();

        const finished = tx({ id: 'tx-done', status: 'completed', ratedByBuyer: false, ratedBySeller: false });
        render(<MarketplacePage identity={identity} isMember={true} openReviewTxId="tx-done" onReviewOpened={() => {}} transactions={[finished]} />);
        const dialog = await screen.findByRole('dialog', { name: xx('Deal Complete!') });
        expect(within(dialog).getByRole('button', { name: xx('Rate {n} stars').replace('{n}', '3') })).toBeInTheDocument();
        allThroughT(5);
    });

    it('a paused, winding-up or closed enterprise\'s listing', async () => {
        for (const ent of [{ paused: true, status: 'active' }, { paused: false, status: 'winding_up' }, { paused: false, status: 'completed' }]) {
            stubNode([offer]);
            vi.mocked(api.getTreasury).mockResolvedValue({ ...ent, name: 'Bean Bakery' });
            await showIn('xx');
            const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} />);
            await screen.findByRole('heading', { name: /Bicycle Repair/ });
            await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
            allThroughT(10);
            view.unmount();
            backToEnglish();
        }
    });

    it('an Offer to accept before listing one: the contribution card', async () => {
        stubNode([offer]);
        vi.mocked(api.getBalance).mockResolvedValue({ balance: 0, isBlockedFromTrading: true } as any);
        await showIn('xx');
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await waitFor(() => expect(api.getBalance).toHaveBeenCalled());
        await settle();
        fireEvent.click(screen.getByText(xx('🤝 Accept Offer')));
        await waitFor(() => expect(getProfileStatus).toHaveBeenCalled());
        await settle();
        // Drawn by the list (as it has been): it shows once the listing is left.
        fireEvent.click(screen.getByText(xx('Back to Market')));
        expect(await screen.findByText(xx('Contribution Required'))).toBeInTheDocument();
        allThroughT(10);
    });

    it('a partner community\'s listing: what can\'t be bought here, and the keeper\'s commission panel', async () => {
        const remote = { ...offer, priceType: 'fixed', originNode: 'https://byron.example.test', audienceScope: 'public', targetGroupId: undefined, targetGroupName: undefined };
        const link = { peerId: 'p', treasuryPubkey: 't', name: 'Byron Link', originNode: 'https://byron.example.test', energyBalance: -120, ceiling: 500, allowance: 620, redeemable: 120, treasuryBalance: 0, commonsBalance: 1000 };
        for (const capacity of [link, { ...link, allowance: 5, redeemable: 0 }, { ...link, commonsBalance: 3 }]) {
            stubNode([remote]);
            vi.mocked(api.getCommissionCapacity).mockResolvedValue({ links: [capacity] } as any);
            vi.spyOn(api, 'commissionListing').mockResolvedValue({ status: 'settled', amount: 20.3, fee: 0.3, drawnFromCommons: 20.3 } as any);
            await showIn('xx');
            const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} />);
            await screen.findByRole('heading', { name: /Bicycle Repair/ });
            await settle();
            fireEvent.click(screen.getByText(xx('🤝 Accept Offer')));
            await screen.findByText(xx('Accept this Offer?'));
            expect(screen.getByText(xx('{n} 🫘 available').replace('{n}', String(capacity.allowance)))).toBeInTheDocument();
            const commission = screen.queryByText(xx('Commission for the community — {n} 🫘').replace('{n}', '20.3'));
            if (commission) {
                fireEvent.click(commission);
                await screen.findByRole('status');
            }
            allThroughT(15);
            view.unmount();
            backToEnglish();
        }
    });

    it('on the global node: what the description asks in return, and the deal in a local community', async () => {
        modes.value = { beans: 'preview', escrow: 'preview' };
        stubNode([{ ...offer, audienceScope: 'public', targetGroupId: undefined, targetGroupName: undefined }]);
        await showIn('xx');
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await settle();
        expect(screen.getByTestId('listing-in-return')).toBeInTheDocument();
        expect(screen.getByTestId('local-action-stub')).toBeInTheDocument();
        allThroughT(10);
    });

    it('a Daily Pulse listing: the way to post one\'s own', async () => {
        stubNode([{ ...offer, id: 'pulse-1', title: 'Kindness compounds', description: 'Share what you have', authorCallsign: 'Daily Pulse', authorPublicKey: 'pulse-pk', audienceScope: 'public', targetGroupId: undefined, targetGroupName: undefined }]);
        await showIn('xx');
        render(<MarketplacePage identity={identity} isMember={true} openPostId="pulse-1" onPostOpened={() => {}} />);
        expect(await screen.findByText(xx('Feeling Inspired?'))).toBeInTheDocument();
        await settle();
        allThroughT(6);
    });

    it('a visitor\'s list, its one line, and an empty Market', async () => {
        stubNode([offer, poll]);
        await showIn('xx');
        const visitor = { joinCard: <div data-testid="join-card" />, onJoin: () => {}, beans: false };
        const view = render(<MarketplacePage identity={null} isMember={false} visitor={visitor} />);
        await screen.findByTestId('visitor-list-note');
        expect(screen.getByRole('button', { name: xx('Open poll: {title}').replace('{title}', 'Market day?') })).toBeInTheDocument();
        allThroughT(5);
        view.unmount();

        stubNode([]);
        render(<MarketplacePage identity={null} isMember={false} visitor={visitor} />);
        expect(await screen.findByText(xx('Nothing posted here yet'))).toBeInTheDocument();
        allThroughT(5);
    });

    it('a list that could not be read says so through t(), a node\'s own words as it wrote them', async () => {
        stubNode([]);
        vi.mocked(api.getMarketplacePosts).mockRejectedValue(new Error(''));
        await showIn('xx');
        render(<MarketplacePage identity={identity} isMember={true} />);
        expect(await screen.findByText(xx('Failed to load'))).toBeInTheDocument();
        allThroughT(10);
    });
});

describe('the Market in English', () => {
    it('nothing is bracketed, and the words are as they were', async () => {
        info.value = { features: { nearbyListings: { radiusKm: 250, max: 500 } } };
        stubNode([offer, need]);
        const view = render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Bicycle Repair');
        await settle();
        expect(bracketed()).toBe(0);
        expect(Array.from(screen.getByTestId('feed-type-filter').querySelectorAll('button')).map(b => b.textContent))
            .toEqual(['All', '★ For You', '🟢 Offers', '🟠 Needs', 'Events', '🗳️ Polls']);
        expect(screen.getByText('🔥').parentElement!.textContent).toContain('1 fresh listing posted today!');
        expect(screen.getByTestId('market-near-line')).toHaveTextContent('Nearest to your area first, within 250 km.');
        // The date chips are lib/events.ts EVENT_WINDOWS' words, shown here through t().
        fireEvent.click(screen.getByRole('button', { name: 'Events' }));
        expect(Array.from(screen.getByTestId('feed-event-window-chips').querySelectorAll('button')).map(b => b.textContent))
            .toEqual(EVENT_WINDOWS.map(w => w.label));
        view.unmount();

        // A listing: its header, price, estimate and the commitment it asks for.
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await settle();
        expect(bracketed()).toBe(0);
        expect(screen.getByText('🟢 Offer · Services')).toBeInTheDocument();
        expect(screen.getByText('Only Gardeners can see this')).toBeInTheDocument();
        expect(screen.getByText('/Hr')).toBeInTheDocument();
        expect(screen.getByText('≈ 0.5 hrs')).toBeInTheDocument();
        expect(screen.getByText('4.5 (2)')).toBeInTheDocument();
        expect(screen.getByAltText('B')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'View enlarged photo 1 of 1: Bicycle Repair' })).toBeInTheDocument();
        fireEvent.click(screen.getByText('🤝 Accept Offer'));
        const commit = await screen.findByText(/^By proceeding, you commit/);
        expect(commit.textContent).toBe('By proceeding, you commit 20 B (1 hr) to a Trust Wallet. When finalized, the provider will receive 19.70 B (net of 1.5% transaction fee (100% community owned) to fund the Commons Pool).');
        expect(screen.getByText('ESTIMATED HOURS')).toBeInTheDocument();
        fireEvent.click(screen.getByText('🚩 Report'));
        expect(screen.getByText('Child safety', { selector: 'span' }).closest('p')!.textContent).toBe('Child safety: A child at risk, or sexual content involving a minor.');
        expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(expect.arrayContaining(['Select a reason...', 'Spam or scam', 'Child safety']));
    });

    it('the profile gate says what is missing, in the words lib/profile-status.ts gives it', async () => {
        stubNode([need]);
        for (const status of [
            { complete: false, missingName: true, missingAvatar: true },
            { complete: false, missingName: true, missingAvatar: false },
            { complete: false, missingName: false, missingAvatar: true },
        ]) {
            vi.mocked(getProfileStatus).mockResolvedValue(status);
            const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="need-1" onPostOpened={() => {}} />);
            await screen.findByRole('heading', { name: /Lift to town/ });
            fireEvent.click(screen.getByText('✋ Offer to Fulfill'));
            await settle();
            fireEvent.click(screen.getByText('Back to Market'));
            expect((await screen.findByTestId('profile-gate-stub')).textContent)
                .toBe(`Your community likes to know who they're dealing with, so you need ${describeMissing(status)} before you can accept. It only takes a moment.`);
            view.unmount();
        }
    });

    it('the global node\'s words are lib/visitor-lobby.ts\'s and LocalCommunityMark\'s, and a visitor\'s line too', async () => {
        modes.value = { beans: 'preview', escrow: 'preview' };
        stubNode([{ ...offer, audienceScope: 'public', targetGroupId: undefined, targetGroupName: undefined }]);
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-1" onPostOpened={() => {}} />);
        await screen.findByRole('heading', { name: /Bicycle Repair/ });
        await settle();
        expect(within(screen.getByTestId('listing-in-return')).getByText(NO_BEANS_TERMS_TEXT)).toBeInTheDocument();
        expect(within(screen.getByTestId('listing-in-return')).getByTestId('local-line-stub').textContent).toBe('🏘️ In a local community this is a price in Beans ›');
        expect(screen.getByTestId('local-action-stub').textContent).toBe(DEAL_ACTION_LABEL);
        view.unmount();

        modes.value = {};
        stubNode([offer]);
        render(<MarketplacePage identity={null} isMember={false} visitor={{ joinCard: null, onJoin: () => {}, beans: false }} />);
        expect((await screen.findByTestId('visitor-list-note')).textContent).toBe(VISITOR_LIST_NOTE);
    });
});
