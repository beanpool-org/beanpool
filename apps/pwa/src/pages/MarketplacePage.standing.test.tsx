/**
 * Standing deals S2 on the web's listing page, round 2 of #3000 (deciding review on e07a97d3; DESIGN-standing-deals-fable
 * §2.2, §4). Finding 1: a FREE listing priced per week or per month (0 Beans) is no standing deal: there is nothing to hold
 * each period, and core's authorisation can't carry 0 Beans, so it is taken up, or its helper approved, as the one-off deal
 * of 0 Beans it was before S2. Finding 3: a short standing deal opened from Your deals or Home (the period last settled, so
 * `completed`) never tells its payee "That deal is done." above the panel that says it is still running.
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
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Mia', createdAt: '2026-09-17T00:00:00.000Z' };
const TODAY = new Date().toISOString();

/** Rob's Vehicle Storage, by the month, on the board while its deals run. */
const storage = {
    id: 'offer-storage', type: 'offer', category: 'services', title: 'Vehicle Storage', description: 'A dry shed', credits: 50,
    priceType: 'monthly', status: 'active', active: true, repeatable: true, authorPublicKey: 'rob-pk', authorCallsign: 'Rob', createdAt: TODAY,
};
/** Mia's own Need, by the week. */
const minding = {
    id: 'need-minding', type: 'need', category: 'care', title: 'Dog minding', description: 'Tuesdays', credits: 0,
    priceType: 'weekly', status: 'active', active: true, repeatable: true, authorPublicKey: ME, authorCallsign: 'Mia', createdAt: TODAY,
};
const tx = (extra: Record<string, unknown>) => ({
    id: 'tx-1', postId: 'offer-storage', postTitle: 'Vehicle Storage', buyerPublicKey: ME, buyerCallsign: 'Mia', sellerPublicKey: 'rob-pk',
    sellerCallsign: 'Rob', credits: 50, status: 'pending', createdAt: TODAY, ...extra,
}) as unknown as api.MarketplaceTransaction;

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
    vi.spyOn(api, 'createConversationApi').mockResolvedValue({ conversation: { id: 'c-1' } } as any);
}

async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

const said: string[] = [];
beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    said.length = 0;
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
});
afterEach(() => { cleanup(); });

describe('finding 1: a free weekly or monthly listing is taken up as the one-off deal of 0 Beans it was', () => {
    it('a free monthly Offer: Accept opens the one-off box, never "Agree and hold 0 Beans", and the accept carries no standing deal', async () => {
        stubNode([{ ...storage, credits: 0 }]);
        const accept = vi.spyOn(api, 'acceptMarketplacePost').mockResolvedValue({ transaction: tx({ credits: 0 }) } as any);
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-storage" onPostOpened={() => {}} transactions={[]} onRefreshTransactions={vi.fn()} />);
        await screen.findByRole('heading', { name: /Vehicle Storage/ });
        await settle();
        fireEvent.click(screen.getByText('🤝 Accept Offer'));
        await screen.findByText('Accept this Offer?');
        expect(screen.queryByTestId('standing-take-up')).toBeNull();
        expect(screen.queryByText('Agree and hold 0 Beans')).toBeNull();
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '2' } });
        fireEvent.click(screen.getByText('Confirm'));
        await waitFor(() => expect(accept).toHaveBeenCalledWith('offer-storage', ME, 2));
        expect(said).toEqual([]);
    });

    it('a priced monthly Offer still opens the standing take-up (the price unit decides it, Marty 9 Nov)', async () => {
        stubNode([storage]);
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-storage" onPostOpened={() => {}} transactions={[]} onRefreshTransactions={vi.fn()} />);
        await screen.findByRole('heading', { name: /Vehicle Storage/ });
        await settle();
        fireEvent.click(screen.getByText('🤝 Accept Offer'));
        expect(await screen.findByTestId('standing-take-up')).toBeTruthy();
        expect(screen.getByTestId('standing-agree').textContent).toBe('Agree and hold 50 Beans');
    });

    it("a free weekly Need: its author approves a helper's request at once, as a one-off deal, with no take-up to sign", async () => {
        stubNode([minding]);
        const approve = vi.spyOn(api, 'approveMarketplaceRequest').mockResolvedValue({ success: true } as any);
        const request = tx({ id: 'tx-req', postId: 'need-minding', postTitle: 'Dog minding', status: 'requested', buyerPublicKey: ME, buyerCallsign: 'Mia',
            sellerPublicKey: 'kofi-pk', sellerCallsign: 'Kofi', credits: 0 });
        render(<MarketplacePage identity={identity} isMember={true} openPostId="need-minding" onPostOpened={() => {}} transactions={[request]} onRefreshTransactions={vi.fn()} />);
        await screen.findByRole('heading', { name: /Dog minding/ });
        await settle();
        fireEvent.click(await screen.findByText('Approve & Hold in Trust'));
        await waitFor(() => expect(approve).toHaveBeenCalledWith('tx-req', ME));
        expect(screen.queryByTestId('standing-take-up')).toBeNull();
    });
});

describe('finding 3: a short standing deal opened from Your deals or Home is never "done"', () => {
    const SHORT = {
        id: 'tx-short', status: 'completed', buyerPublicKey: 'marty-pk', buyerCallsign: 'Marty', sellerPublicKey: ME, sellerCallsign: 'Mia',
        standingId: 'sd-1', periodNo: 2, standingPhase: 'short', standingBeans: 50, standingUnit: 'month', standingMaxPeriods: null,
        standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: '2026-12-09T08:00:00.000Z',
        standingStopped: false,
    };
    it('its payee (the Offer\'s author) reads the panel, "isn\'t covered yet" and Stop now, with no "That deal is done." above it', async () => {
        stubNode([{ ...storage, authorPublicKey: ME, authorCallsign: 'Mia' }]);
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-storage" openTxId="tx-short" onPostOpened={() => {}}
            transactions={[tx(SHORT)]} onRefreshTransactions={vi.fn()} />);
        await screen.findByRole('heading', { name: /Vehicle Storage/ });
        await settle();
        expect(screen.getByTestId('standing-panel-tx-short').textContent).toContain("Next month isn't covered yet · we'll keep trying until 16 Dec");
        expect(screen.getByTestId('standing-stop').textContent).toBe('Stop now');
        expect(screen.queryByTestId('pinned-deal-over')).toBeNull();
        expect(screen.queryByText('That deal is done.')).toBeNull();
    });
    it('once it has ended, the same link says what became of it, as for any deal', async () => {
        stubNode([{ ...storage, authorPublicKey: ME, authorCallsign: 'Mia' }]);
        render(<MarketplacePage identity={identity} isMember={true} openPostId="offer-storage" openTxId="tx-short" onPostOpened={() => {}}
            transactions={[tx({ ...SHORT, standingPhase: 'ended' })]} onRefreshTransactions={vi.fn()} />);
        await screen.findByRole('heading', { name: /Vehicle Storage/ });
        await settle();
        expect(screen.getByTestId('pinned-deal-over').textContent).toBe('That deal is done.');
    });
});
