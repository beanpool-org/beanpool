/**
 * A deal already under way on the listing (the node's 409 `deal_open`, apps/server engine/escrow.ts;
 * scratch/fable-design/DESIGN-deals-fable.md S2). The member takes up a recurring Offer, or offers to help with a recurring
 * Need, while their deal on it is under way (made in another tab or on their phone, so this page did not know): the page
 * says so in its own words, closes the confirmation, refreshes the member's deals, and opens the listing at the deal the node
 * named, as Your deals' View deal does (postId + txId). Any other refusal is as it was.
 *
 * The listing's own words only: the cards, sheets and modals it draws are stubbed, as in MarketplacePage.words.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { backToEnglish, showIn, xx } from '../words-xx.test-support';

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
const TODAY = new Date().toISOString();
const DEAL_OPEN_WORDS = 'You already have a deal under way on this. Finish or cancel it first.';

/** A recurring Offer: on the board while its deals run. */
const course = {
    id: 'offer-course', type: 'offer', category: 'education', title: 'Pottery course', description: 'Six weeks on the wheel', credits: 45,
    priceType: 'fixed', status: 'active', active: true, repeatable: true, authorPublicKey: 'damo-pk', authorCallsign: 'Damo', createdAt: TODAY,
};
/** A recurring Need of Ada's. */
const stall = {
    id: 'need-stall', type: 'need', category: 'labour', title: 'Help at the market stall', description: 'Saturday mornings', credits: 20,
    priceType: 'fixed', status: 'active', active: true, repeatable: true, authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: TODAY,
};
const deal = (extra: Record<string, unknown>) => ({
    id: 'tx-course', postId: 'offer-course', postTitle: 'Pottery course', buyerPublicKey: ME, buyerCallsign: 'Mia', sellerPublicKey: 'damo-pk',
    sellerCallsign: 'Damo', credits: 45, status: 'pending', createdAt: TODAY, ...extra,
}) as unknown as api.MarketplaceTransaction;
/** What lib/api's request throws for the node's answer (its refusalError). */
const refused = (body: Record<string, unknown>, status = 409) =>
    Object.assign(new Error(String(body.error)), { status, ...(body.code ? { code: body.code } : {}), ...(body.transactionId ? { transactionId: body.transactionId } : {}) });

const said: string[] = [];

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

async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    said.length = 0;
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
});
afterEach(() => { cleanup(); backToEnglish(); });

describe('a deal already under way on the listing (deal_open)', () => {
    it('a recurring Offer taken up again: the words, the deals refreshed, and the listing at the deal in place of Accept', async () => {
        stubNode([course]);
        const accept = vi.spyOn(api, 'acceptMarketplacePost').mockRejectedValue(refused({ error: 'Vous avez déjà un échange en cours ici.', code: 'deal_open', transactionId: 'tx-course' }));
        const chat = vi.spyOn(api, 'createConversationApi').mockResolvedValue({ conversation: { id: 'c-1' } } as any);
        const onRefreshTransactions = vi.fn();
        const onPostOpened = () => {};
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={onPostOpened}
            transactions={[]} onRefreshTransactions={onRefreshTransactions} />);
        await screen.findByRole('heading', { name: /Pottery course/ });
        await settle();
        fireEvent.click(screen.getByText('🤝 Accept Offer'));
        await screen.findByText('Accept this Offer?');
        fireEvent.click(screen.getByText('Confirm'));

        await waitFor(() => expect(said).toEqual([DEAL_OPEN_WORDS]));
        expect(accept).toHaveBeenCalledWith('offer-course', ME, undefined);
        expect(onRefreshTransactions).toHaveBeenCalled();
        expect(screen.queryByText('Accept this Offer?')).toBeNull();
        // Not the success path: no chat started.
        expect(chat).not.toHaveBeenCalled();

        // The member's deals, refreshed, carry the deal the node named: the listing is at it, and Accept is not offered.
        view.rerender(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={onPostOpened}
            transactions={[deal({})]} onRefreshTransactions={onRefreshTransactions} />);
        await settle();
        expect(screen.getByRole('heading', { name: /Pottery course/ })).toBeInTheDocument();
        expect(screen.queryByText('🤝 Accept Offer')).toBeNull();
    });

    // Deciding review on 509dd543: the deal the refusal pinned belongs to ITS listing; the next listing opened is never at it.
    it('the pinned deal stays with its listing: another listing offers Accept, and one held by someone else shows no Release', async () => {
        const vase = { ...course, id: 'offer-vase', title: 'Glazed vase', repeatable: false, authorPublicKey: 'sam-pk', authorCallsign: 'Sam' };
        const mower = { ...course, id: 'offer-mower', title: 'Old lawn mower', repeatable: false, status: 'pending', pendingTransactionId: 'tx-other',
            authorPublicKey: 'sam-pk', authorCallsign: 'Sam' };
        stubNode([course, vase, mower]);
        vi.spyOn(api, 'acceptMarketplacePost').mockRejectedValue(refused({ error: 'x', code: 'deal_open', transactionId: 'tx-course' }));
        const onPostOpened = () => {};
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={onPostOpened} transactions={[]} />);
        await screen.findByRole('heading', { name: /Pottery course/ });
        await settle();
        fireEvent.click(screen.getByText('🤝 Accept Offer'));
        await screen.findByText('Accept this Offer?');
        fireEvent.click(screen.getByText('Confirm'));
        await waitFor(() => expect(said.length).toBe(1));
        view.rerender(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={onPostOpened} transactions={[deal({})]} />);
        await settle();

        // On to another of the same author's listings, as from Posted by → their profile: no deal of the member's there.
        view.rerender(<MarketplacePage identity={identity} isMember={true} openPostId="offer-vase" onPostOpened={onPostOpened} transactions={[deal({})]} />);
        await screen.findByRole('heading', { name: /Glazed vase/ });
        await settle();
        expect(screen.getByText('🤝 Accept Offer')).toBeInTheDocument();
        expect(screen.queryByText(/Release Credits/)).toBeNull();

        // And a one-off held for someone else: never the member's Release.
        view.rerender(<MarketplacePage identity={identity} isMember={true} openPostId="offer-mower" onPostOpened={onPostOpened} transactions={[deal({})]} />);
        await screen.findByRole('heading', { name: /Old lawn mower/ });
        await settle();
        expect(screen.queryByText(/Release Credits/)).toBeNull();
    });

    it('the deal the node named is the one opened, by its id: a request still waiting (nothing held) as well', async () => {
        stubNode([course]);
        vi.spyOn(api, 'acceptMarketplacePost').mockRejectedValue(refused({ error: 'x', code: 'deal_open', transactionId: 'tx-asked' }));
        const onPostOpened = () => {};
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={onPostOpened} transactions={[]} />);
        await screen.findByRole('heading', { name: /Pottery course/ });
        await settle();
        fireEvent.click(screen.getByText('🤝 Accept Offer'));
        fireEvent.click(await screen.findByText('Confirm'));
        await waitFor(() => expect(said).toEqual([DEAL_OPEN_WORDS]));

        // A request is no deal in trust, so only its id finds it: Accept stays away rather than inviting the same refusal.
        view.rerender(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={onPostOpened}
            transactions={[deal({ id: 'tx-asked', status: 'requested' })]} />);
        await settle();
        expect(screen.queryByText('🤝 Accept Offer')).toBeNull();
    });

    it('an offer to help with a recurring Need already being helped with: the same', async () => {
        stubNode([stall]);
        const ask = vi.spyOn(api, 'requestMarketplacePost').mockRejectedValue(refused({ error: 'x', code: 'deal_open', transactionId: 'tx-stall' }));
        const onRefreshTransactions = vi.fn();
        const onPostOpened = () => {};
        const view = render(<MarketplacePage identity={identity} isMember={true} openPostId="need-stall" onPostOpened={onPostOpened}
            transactions={[]} onRefreshTransactions={onRefreshTransactions} />);
        await screen.findByRole('heading', { name: /Help at the market stall/ });
        await settle();
        fireEvent.click(screen.getByText('✋ Offer to Fulfill'));
        fireEvent.click(await screen.findByText('Confirm'));

        await waitFor(() => expect(said).toEqual([DEAL_OPEN_WORDS]));
        expect(ask).toHaveBeenCalledWith('need-stall', ME, undefined);
        expect(onRefreshTransactions).toHaveBeenCalled();
        expect(screen.queryByText('Offer to Fulfill this Need?')).toBeNull();

        view.rerender(<MarketplacePage identity={identity} isMember={true} openPostId="need-stall" onPostOpened={onPostOpened}
            transactions={[deal({ id: 'tx-stall', postId: 'need-stall', postTitle: 'Help at the market stall', buyerPublicKey: 'ada-pk', buyerCallsign: 'Ada', sellerPublicKey: ME, sellerCallsign: 'Mia', credits: 20 })]}
            onRefreshTransactions={onRefreshTransactions} />);
        await settle();
        expect(screen.queryByText('✋ Offer to Fulfill')).toBeNull();
    });

    it('in the member\'s language: the words are the page\'s own, through t()', async () => {
        stubNode([course]);
        vi.spyOn(api, 'acceptMarketplacePost').mockRejectedValue(refused({ error: 'x', code: 'deal_open', transactionId: 'tx-course' }));
        await showIn('xx');
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={() => {}} transactions={[]} />);
        await screen.findByRole('heading', { name: /Pottery course/ });
        await settle();
        fireEvent.click(screen.getByText(xx('🤝 Accept Offer')));
        fireEvent.click(await screen.findByText(xx('Confirm')));
        await waitFor(() => expect(said).toEqual([xx(DEAL_OPEN_WORDS)]));
    });

    it('any other refusal is as it was: the node\'s words, nothing refreshed, the confirmation left open', async () => {
        stubNode([course]);
        vi.spyOn(api, 'acceptMarketplacePost').mockRejectedValue(refused({ error: 'Insufficient balance to accept this offer' }, 400));
        const onRefreshTransactions = vi.fn();
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-course" onPostOpened={() => {}}
            transactions={[]} onRefreshTransactions={onRefreshTransactions} />);
        await screen.findByRole('heading', { name: /Pottery course/ });
        await settle();
        fireEvent.click(screen.getByText('🤝 Accept Offer'));
        fireEvent.click(await screen.findByText('Confirm'));
        await waitFor(() => expect(said).toEqual(['Insufficient balance to accept this offer']));
        expect(onRefreshTransactions).not.toHaveBeenCalled();
        expect(screen.getByText('Accept this Offer?')).toBeInTheDocument();
    });
});
