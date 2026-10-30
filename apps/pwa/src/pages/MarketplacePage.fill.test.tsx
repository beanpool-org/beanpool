// The web Market on a node that reads by area, when little is near the member (Damo via Marty, 30 Oct: "Nearby, then
// fill"): fewer than FILL_BELOW listings shown near them, and the newest from elsewhere come beneath, from the read
// "Show everywhere" already makes, without a tap and without repeating one. From 8 near, nothing changes.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FILL_BELOW, FILL_MAX } from '@beanpool/core';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { loadRadiusSettings } from '../lib/geo';
import { CLIENT_POST_TYPES } from '../lib/events';

const info = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => info.current),
    joinInFlight: vi.fn(async () => false),
}));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null), saveRadiusSettings: vi.fn(), clearRadiusSettings: vi.fn(), haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', () => ({ getProfileStatus: vi.fn(async () => ({ complete: true })), describeMissing: vi.fn(() => '') }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));

const identity: BeanPoolIdentity = {
    publicKey: 'member-me', privateKey: 'mock-private-key-hex', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z',
};
const GLOBAL = { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 } } };
const LOCAL = { profile: 'local', features: { beans: true } };
const AREA = { lat: -28.5, lng: 153.5, updatedAt: '2026-10-01T00:00:00Z' };

const listing = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'offer', category: 'services', title, description: 'Some words', credits: 0, priceType: 'fixed', status: 'active',
    active: true, lat: -28.6, lng: 153.4, authorPublicKey: 'member-ada', authorCallsign: 'Ada', createdAt: '2026-10-28T00:00:00Z', ...extra,
});
/** `n` listings near the member, as the node answers a read by area (it measured them). */
const nearOf = (n: number) => Array.from({ length: n }, (_, i) => listing(`near-${i}`, `Near ${i}`, { distanceKm: 3 + i }));
/** `n` listings far away, newest first. */
const farOf = (n: number) => Array.from({ length: n }, (_, i) => listing(`far-${i}`, `Far ${i}`, { lat: 48.8, lng: 2.3, createdAt: `2026-10-29T0${i % 10}:00:00Z` }));

/** The node: a read with a point is the nearby list; one without is the newest from everywhere. */
const node = (near: unknown[], far: unknown[]) => async (f: Parameters<typeof api.getMarketplacePosts>[0]) =>
    (f?.author || f?.online ? [] : f?.lat != null ? near : far) as any;

const reads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !f?.author && !f?.id && !f?.online);
/** The fill's own read: one page, no point (what "Show everywhere" reads, asked for a page). */
const fillReads = () => reads().filter(f => f?.lat == null && f?.limit === FILL_MAX);
const nearReads = () => reads().filter(f => f?.lat != null);

describe('MarketplacePage: a short nearby list is filled with the newest from elsewhere', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(loadRadiusSettings).mockReturnValue(null);
        info.current = GLOBAL;
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(node([], []));
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: 'member-me', area: AREA } as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('nothing near: the newest from elsewhere fill in at once, with a short line above and no tap', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(node([], farOf(3)));
        render(<MarketplacePage identity={identity} />);
        const fill = await screen.findByTestId('market-fill');
        expect(within(fill).getByText('Newest from elsewhere')).toBeInTheDocument();
        for (const title of ['Far 0', 'Far 1', 'Far 2']) expect(within(fill).getByText(title)).toBeInTheDocument();
        expect(screen.getByTestId('market-near-empty')).toHaveTextContent('Nothing within 250 km yet.');
        // The dead end and its link are gone.
        expect(screen.queryByTestId('market-see-elsewhere')).toBeNull();
        expect(screen.queryByTestId('market-empty-tiles')).toBeNull();
        // The near line still says where the list was read from.
        expect(screen.getByTestId('market-near-line')).toHaveTextContent('Nearest to your area first, within 250 km.');
        // The same read "Show everywhere" makes, asked for one page.
        expect(fillReads()).toEqual([{ types: CLIENT_POST_TYPES, limit: FILL_MAX }]);
    });

    it('the fill shows no distance, as "Show everywhere" shows none', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(node([], farOf(2)));
        render(<MarketplacePage identity={identity} />);
        await screen.findByTestId('market-fill');
        expect(screen.queryByTestId('card-distance')).toBeNull();
    });

    it('3 near: those 3 first, then elsewhere without a listing twice', async () => {
        const near = nearOf(3);
        // Elsewhere is the newest from everywhere, so it holds two of the near ones too.
        vi.mocked(api.getMarketplacePosts).mockImplementation(node(near, [near[1], ...farOf(2), near[0]]));
        render(<MarketplacePage identity={identity} />);
        const fill = await screen.findByTestId('market-fill');
        for (const title of ['Near 0', 'Near 1', 'Near 2']) expect(screen.getAllByText(title)).toHaveLength(1);
        expect(within(fill).getByText('Far 0')).toBeInTheDocument();
        expect(within(fill).getByText('Far 1')).toBeInTheDocument();
        expect(within(fill).queryByText('Near 0')).toBeNull();
        expect(within(fill).queryByText('Near 1')).toBeNull();
        // Nearest first is kept: the near ones come before the section.
        expect(screen.getByText('Near 2').compareDocumentPosition(fill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // There is something near, so no "nothing" line.
        expect(screen.queryByTestId('market-near-empty')).toBeNull();
    });

    it('8 near: nothing changes, no section and no extra read', async () => {
        expect(FILL_BELOW).toBe(8);
        vi.mocked(api.getMarketplacePosts).mockImplementation(node(nearOf(FILL_BELOW), farOf(4)));
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Near 7');
        expect(screen.queryByTestId('market-fill')).toBeNull();
        expect(screen.queryByText('Newest from elsewhere')).toBeNull();
        expect(screen.queryByText('Far 0')).toBeNull();
        expect(fillReads()).toEqual([]);
    });

    it('7 near: still filled', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(node(nearOf(FILL_BELOW - 1), farOf(2)));
        render(<MarketplacePage identity={identity} />);
        const fill = await screen.findByTestId('market-fill');
        expect(within(fill).getByText('Far 0')).toBeInTheDocument();
    });

    it('never takes the list past a page', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(node(nearOf(3), farOf(120)));
        render(<MarketplacePage identity={identity} />);
        const fill = await screen.findByTestId('market-fill');
        await waitFor(() => expect(within(fill).getAllByText(/^Far \d+$/)).toHaveLength(FILL_MAX - 3));
    });

    it('a type filter and a category apply to both parts', async () => {
        const mix = (prefix: string, at: Record<string, unknown>) => [
            listing(`${prefix}-offer`, `${prefix} offer`, at), listing(`${prefix}-need`, `${prefix} need`, { ...at, type: 'need' }),
        ];
        vi.mocked(api.getMarketplacePosts).mockImplementation(node(mix('Close', {}), mix('Away', { lat: 48.8, lng: 2.3 })));
        render(<MarketplacePage identity={identity} />);
        await screen.findByTestId('market-fill');
        expect(screen.getByText('Close need')).toBeInTheDocument();
        expect(screen.getByText('Away need')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Offers/ }));
        await waitFor(() => expect(fillReads().at(-1)).toMatchObject({ type: 'offer' }));
        await screen.findByText('Away offer');
        expect(nearReads().at(-1)).toMatchObject({ type: 'offer' });
        const fill = screen.getByTestId('market-fill');
        expect(within(fill).getByText('Away offer')).toBeInTheDocument();
        expect(screen.queryByText('Close need')).toBeNull();
        expect(screen.queryByText('Away need')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /Category/ }));
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Services/ }));
        await waitFor(() => expect(fillReads().at(-1)).toMatchObject({ type: 'offer', category: 'services' }));
        expect(nearReads().at(-1)).toMatchObject({ type: 'offer', category: 'services' });
    });

    it('a search applies to both parts', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(node(
            [listing('near-bike', 'Bicycle repair'), listing('near-jam', 'Jam jars')],
            [listing('far-bike', 'Bicycle pump', { lat: 48.8, lng: 2.3 }), listing('far-tea', 'Tea', { lat: 48.8, lng: 2.3 })],
        ));
        render(<MarketplacePage identity={identity} />);
        await screen.findByTestId('market-fill');
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bicycle' } });
        await waitFor(() => expect(screen.queryByText('Jam jars')).toBeNull());
        expect(screen.getByText('Bicycle repair')).toBeInTheDocument();
        expect(within(screen.getByTestId('market-fill')).getByText('Bicycle pump')).toBeInTheDocument();
        expect(screen.queryByText('Tea')).toBeNull();
    });

    it('Show everywhere and Near your area still work, and the list is not filled on top of everywhere', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(node(nearOf(2), farOf(3)));
        render(<MarketplacePage identity={identity} />);
        await screen.findByTestId('market-fill');
        const fillsBefore = fillReads().length;
        fireEvent.click(screen.getByRole('button', { name: 'Show everywhere' }));
        // The list IS the everywhere read now: far ones as the list, no section beneath, no further fill read.
        await screen.findByText('Far 2');
        expect(screen.queryByTestId('market-fill')).toBeNull();
        expect(fillReads()).toHaveLength(fillsBefore);
        fireEvent.click(screen.getByRole('button', { name: 'Near your area' }));
        await screen.findByTestId('market-fill');
        expect(screen.getByText('Near 1')).toBeInTheDocument();
    });

    it('if the elsewhere read fails, an empty area still ends in the old empty state and its link', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => {
            if (f?.author || f?.online) return [] as any;
            if (f?.lat != null) return [] as any;
            throw new Error('offline');
        });
        render(<MarketplacePage identity={identity} />);
        await screen.findByTestId('market-see-elsewhere');
        expect(screen.queryByTestId('market-fill')).toBeNull();
    });

    it('not for a visitor, a local community, a picked distance, or Events', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(node([], farOf(2)));

        // A visitor on a by-area node: the lobby's list, as before.
        const visitor = render(<MarketplacePage identity={null} visitor={{ beans: false, joinCard: null, onJoin: () => {} } as any} />);
        await screen.findByText('Far 0');
        expect(screen.queryByTestId('market-fill')).toBeNull();
        expect(fillReads()).toEqual([]);
        visitor.unmount();

        // A local community.
        info.current = LOCAL;
        const local = render(<MarketplacePage identity={identity} />);
        await screen.findByText('Far 0');
        expect(screen.queryByTestId('market-fill')).toBeNull();
        expect(fillReads()).toEqual([]);
        local.unmount();

        // A picked distance is the circle they asked for.
        info.current = GLOBAL;
        vi.mocked(loadRadiusSettings).mockReturnValue({ lat: -37.1, lng: 144.2, radiusKm: 30, label: '30km radius' });
        const picked = render(<MarketplacePage identity={identity} />);
        await waitFor(() => expect(nearReads().length).toBeGreaterThan(0));
        await screen.findByTestId('market-near-line');
        expect(screen.queryByTestId('market-fill')).toBeNull();
        expect(fillReads()).toEqual([]);
        picked.unmount();

        // Events keep their rule: the list is not cut there, so there is nothing to fill.
        vi.mocked(loadRadiusSettings).mockReturnValue(null);
        vi.spyOn(api, 'getMyEvents').mockResolvedValue([]);
        render(<MarketplacePage identity={identity} />);
        await screen.findByTestId('market-fill');
        const before = fillReads().length;
        fireEvent.click(screen.getByRole('button', { name: 'Events' }));
        await waitFor(() => expect(screen.queryByTestId('market-fill')).toBeNull());
        expect(fillReads()).toHaveLength(before);
    });
});
