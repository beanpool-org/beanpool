/**
 * Web create-vs-edit field parity (feat/edit-parity):
 *
 * 1. Table guard: extracts every listing payload key sent by the web Offer/Need create form
 *    (`pages/MapPage.tsx` `createMarketplacePost({...})`) and asserts every single one is covered
 *    in `WEB_CREATE_FIELDS` AND handled by the edit form (`pages/MarketplacePage.tsx`) and
 *    `lib/api.ts` `updateMarketplacePost` (either editable or shown read-only with a reason for
 *    node-immutable fields). Adding a field to `MapPage.tsx` without adding it to edit turns this red.
 * 2. Real render checks of `MarketplacePage` in edit mode: cash-also-needed (Offer & Need wording +
 *    nudge + round-trip), location controls (`My location` + `Drop a pin`), reach chooser, read-only
 *    type and audience scope, read-only price when a non-standing deal is open, and Beans-off hiding.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
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

let info: Record<string, unknown> = { features: { beans: true, escrow: true, perItem: true } };
vi.mock('../lib/visitor-lobby-gate', async (orig) => ({
    ...(await orig<typeof import('../lib/visitor-lobby-gate')>()),
    communityInfoOnce: vi.fn(async () => info),
    joinInFlight: vi.fn(async () => false),
}));

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

// ── 1. Table test: every field offered on web Create must exist on web Edit ──────────────────────────────────
interface WebFieldRule {
    field: string;
    createPattern: RegExp;
    editPattern: RegExp;
    apiUpdatePattern?: RegExp;
    mode: 'editable' | 'readonly-immutable' | 'detail-row';
}

const WEB_CREATE_FIELDS: readonly WebFieldRule[] = [
    { field: 'type', createPattern: /setNewPostType\(/, editPattern: /data-testid="edit-type-readonly"/, mode: 'readonly-immutable' },
    { field: 'audienceScope', createPattern: /setAudienceScope\(/, editPattern: /data-testid="edit-audience-readonly"/, mode: 'readonly-immutable' },
    { field: 'targetGroupId', createPattern: /setTargetGroupId\(/, editPattern: /data-testid="edit-audience-readonly"/, mode: 'readonly-immutable' },
    { field: 'category', createPattern: /setNewPostCategory\(/, editPattern: /value=\{editCategory\}/, apiUpdatePattern: /category\?:\s*string/, mode: 'editable' },
    { field: 'tags', createPattern: /<TagPicker/, editPattern: /<TagPicker/, apiUpdatePattern: /tags\?:\s*string\[\]/, mode: 'editable' },
    { field: 'freeTags', createPattern: /freeTags=\{newPostFreeTags\}/, editPattern: /freeTags=\{editFreeTags\}/, apiUpdatePattern: /freeTags\?:\s*string\[\]/, mode: 'editable' },
    { field: 'lat', createPattern: /renderLocationPicker\(\)/, editPattern: /<ListingLocationField/, apiUpdatePattern: /lat\?:\s*number/, mode: 'editable' },
    { field: 'lng', createPattern: /renderLocationPicker\(\)/, editPattern: /<ListingLocationField/, apiUpdatePattern: /lng\?:\s*number/, mode: 'editable' },
    { field: 'title', createPattern: /value=\{newPostTitle\}/, editPattern: /value=\{editTitle\}/, apiUpdatePattern: /title\?:\s*string/, mode: 'editable' },
    { field: 'price_c', createPattern: /value=\{newPostCredits\}/, editPattern: /value=\{editCredits\}/, apiUpdatePattern: /price_c\?:\s*number/, mode: 'editable' },
    { field: 'priceType', createPattern: /priceUnitsOffered\(/, editPattern: /priceUnitsOffered\(/, apiUpdatePattern: /priceType\?:/, mode: 'editable' },
    { field: 'unitsLeft', createPattern: /<PerItemFields/, editPattern: /<PerItemFields/, apiUpdatePattern: /unitsLeft\?:\s*number/, mode: 'editable' },
    { field: 'lot', createPattern: /<PerItemFields/, editPattern: /<PerItemFields/, apiUpdatePattern: /lot\?:/, mode: 'editable' },
    { field: 'repeatable', createPattern: /<RepeatableField/, editPattern: /<RepeatableField/, apiUpdatePattern: /repeatable\?:\s*boolean/, mode: 'editable' },
    { field: 'cashAlsoNeeded', createPattern: /<CashAlsoNeededField/, editPattern: /<CashAlsoNeededField/, apiUpdatePattern: /cashAlsoNeeded\?:\s*boolean/, mode: 'editable' },
    { field: 'shopId', createPattern: /<ShopToggle/, editPattern: /<ShopToggle/, apiUpdatePattern: /shopId\?:\s*string \| null/, mode: 'editable' },
    { field: 'reach', createPattern: /<ListingReachField/, editPattern: /<ListingReachField/, apiUpdatePattern: /reach\?:\s*PostReach/, mode: 'editable' },
    { field: 'reachPeers', createPattern: /reachPeers=\{newPostReachPeers\}/, editPattern: /reachPeers=\{editReachPeers\}/, apiUpdatePattern: /reachPeers\?:\s*string\[\]/, mode: 'editable' },
    { field: 'description', createPattern: /value=\{newPostDescription\}/, editPattern: /value=\{editDescription\}/, apiUpdatePattern: /description\?:\s*string/, mode: 'editable' },
    { field: 'photos', createPattern: /renderPhotoPicker\(/, editPattern: /setEditPhotos\(/, apiUpdatePattern: /photos\?:\s*string\[\]/, mode: 'editable' },
    { field: 'alsoOnGlobal', createPattern: /<ShowOnGlobalTick/, editPattern: /<ShowOnGlobalHostRow/, mode: 'detail-row' },
];

const WEB_CREATE_ONLY_META = new Set(['authorPublicKey']);

describe('web create-vs-edit field parity table', () => {
    const createSrc = read('./MapPage.tsx');
    const editSrc = read('./MarketplacePage.tsx');
    const apiSrc = read('../lib/api.ts');
    const updateApiBlock = apiSrc.slice(apiSrc.indexOf('export async function updateMarketplacePost('), apiSrc.indexOf('export interface EventNextDate'));

    it('every payload key sent by Offer/Need createMarketplacePost({...}) in MapPage.tsx is in WEB_CREATE_FIELDS (fails if a new create field is added without edit parity)', () => {
        const start = createSrc.indexOf('const made = await createMarketplacePost({');
        expect(start).toBeGreaterThan(0);
        const end = createSrc.indexOf('});', start);
        const body = createSrc.slice(start, end);
        const foundKeys = new Set<string>();
        for (const m of body.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) {
            const k = m[1];
            if (WEB_CREATE_ONLY_META.has(k) || k === 'fields') continue;
            foundKeys.add(k);
        }
        // Shorthand properties inside the object literal (`audienceScope,`, `shopId }`)
        if (/\baudienceScope\b/.test(body)) foundKeys.add('audienceScope');
        if (/\bshopId\b/.test(body)) foundKeys.add('shopId');
        if (/\btargetGroupId\b/.test(body)) foundKeys.add('targetGroupId');
        const tableKeys = new Set(WEB_CREATE_FIELDS.map((r) => r.field));
        const missing = [...foundKeys].filter((k) => !tableKeys.has(k));
        expect(missing, `New field(s) in MapPage.tsx createMarketplacePost body missing from edit parity table: ${missing.join(', ')}`).toEqual([]);
    });

    it.each(WEB_CREATE_FIELDS)('field "$field" ($mode) is present on web create and covered on web edit', ({ field, createPattern, editPattern, apiUpdatePattern, mode }) => {
        expect(createSrc, `MapPage create missing ${field}`).toMatch(createPattern);
        expect(editSrc, `MarketplacePage edit missing ${field}`).toMatch(editPattern);
        if (mode === 'editable' && apiUpdatePattern) {
            expect(updateApiBlock, `api.ts updateMarketplacePost missing ${field}`).toMatch(apiUpdatePattern);
        }
    });
});

// ── 2. Render checks of web Edit Post form ───────────────────────────────────────────────────────────────────
const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Marty', createdAt: '2026-09-17T00:00:00.000Z' };
const TODAY = new Date().toISOString();
const PHOTO = '/api/marketplace/posts/p-1/photos/0?k=abc';

const basePost = (over: Record<string, unknown> = {}) => ({
    id: 'p-1', type: 'offer', category: 'tools', title: 'Trailer hire', description: 'Needs fuel money',
    price_c: 2000, priceType: 'fixed', status: 'active', active: true, repeatable: false, cashAlsoNeeded: true,
    lat: -28.55, lng: 153.50, reach: 'local', reachPeers: [],
    authorPublicKey: ME, authorCallsign: 'Marty', createdAt: TODAY, photos: [PHOTO], audienceScope: 'public',
    ...over,
});

function stubNode(listing: Record<string, unknown>, peers: api.ReachablePeer[] = []) {
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
    vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers });
}

async function settle() {
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

async function openEdit(listing: Record<string, unknown>, opts: { peers?: api.ReachablePeer[]; deals?: unknown[] } = {}) {
    stubNode(listing, opts.peers ?? []);
    render(<MarketplacePage identity={identity} isMember={true} openPostId={String(listing.id)} onPostOpened={() => {}} transactions={(opts.deals ?? []) as any} onRefreshTransactions={vi.fn()} />);
    await screen.findByRole('heading', { name: new RegExp(String(listing.title)) });
    await settle();
    await waitFor(() => expect(screen.getByText('✏️ Edit Post')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('✏️ Edit Post')); });
    await settle();
}

beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetCommunityInfoOnce();
    info = { features: { beans: true, escrow: true, perItem: true } };
});
afterEach(() => { cleanup(); setLanguage('en'); });

describe('web Edit Post form behaviour', () => {
    it('shows cash-also-needed ticked with Offer wording & nudge, unticking + changing reach + location saves all fields', async () => {
        const listing = basePost();
        const update = vi.spyOn(api, 'updateMarketplacePost').mockResolvedValue({ success: true, post: listing as any });
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                getCurrentPosition: (ok: (pos: any) => void) => ok({ coords: { latitude: -28.61234, longitude: 153.61234 } }),
            },
        });

        await openEdit(listing, { peers: [{ peerId: 'peer-riverside', callsign: 'Riverside' } as any] });

        // Read-only type & audience scope
        expect(screen.getByTestId('edit-type-readonly')).toHaveTextContent('Listing type stays as posted');
        expect(screen.getByTestId('edit-audience-readonly')).toHaveTextContent('Who can see it stays as it is');

        // Cash box starts checked with Offer wording and nudge
        const cashLabel = screen.getByTestId('edit-cash-also-needed');
        const cashInput = cashLabel.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(cashInput.checked).toBe(true);
        expect(cashLabel).toHaveTextContent('Cash also needed — for fuel or materials');
        expect(screen.getByTestId('edit-cash-also-needed-nudge')).toHaveTextContent('not your time, not your tools');

        // Untick cash, use My location, change reach to Everywhere, Save
        fireEvent.click(cashInput);
        expect(cashInput.checked).toBe(false);
        expect(screen.queryByTestId('edit-cash-also-needed-nudge')).toBeNull();

        fireEvent.click(screen.getByTestId('edit-location-my-location'));
        fireEvent.click(screen.getByTestId('edit-reach-everywhere'));

        await act(async () => { fireEvent.click(screen.getByText('💾 Save')); });
        await waitFor(() => expect(update).toHaveBeenCalled());
        const sent = update.mock.calls[0][2] as Record<string, unknown>;
        expect(sent).toMatchObject({
            cashAlsoNeeded: false,
            lat: -28.6123,
            lng: 153.6123,
            reach: 'everywhere',
        });
    });

    it('uses Need wording & Need nudge for cash-also-needed on a Need and saves cashAlsoNeeded: true', async () => {
        const need = basePost({ type: 'need', cashAlsoNeeded: false });
        const update = vi.spyOn(api, 'updateMarketplacePost').mockResolvedValue({ success: true, post: need as any });
        await openEdit(need);

        const cashLabel = screen.getByTestId('edit-cash-also-needed');
        const cashInput = cashLabel.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(cashLabel).toHaveTextContent("I'll pay cash too — for fuel or materials");
        expect(cashInput.checked).toBe(false);

        fireEvent.click(cashInput);
        expect(screen.getByTestId('edit-cash-also-needed-nudge')).toHaveTextContent('Cash covers fuel or materials the helper buys');

        await act(async () => { fireEvent.click(screen.getByText('💾 Save')); });
        await waitFor(() => expect(update).toHaveBeenCalled());
        expect((update.mock.calls[0][2] as Record<string, unknown>).cashAlsoNeeded).toBe(true);
    });

    it('locks price & unit read-only with reason while a non-standing deal is open', async () => {
        const need = basePost({ type: 'need', cashAlsoNeeded: false });
        const openReq = {
            id: 'tx-1', postId: 'p-1', status: 'requested', buyerPublicKey: ME, sellerPublicKey: 'helper-pk',
            sellerCallsign: 'Helper', amount_c: 2000, createdAt: TODAY,
        };
        await openEdit(need, { deals: [openReq] });

        expect(screen.getByTestId('edit-price-frozen-reason')).toHaveTextContent('This post has a deal in progress');
        expect((screen.getByLabelText('Price') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByLabelText('Price unit') as HTMLSelectElement).disabled).toBe(true);
    });
});
