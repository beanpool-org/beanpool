// The web Market on a node that reads by area (DESIGN-global-sync-by-area §5, S5): with `features.nearbyListings` it
// asks for the nearest within the member's distance setting, else within the node's radius of their stored area, and
// shows the distance the node returns. A local node, a visitor and a member with no point read exactly as before.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { loadRadiusSettings, haversineDistance } from '../lib/geo';
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
const offer = {
    id: 'offer-1', type: 'offer', category: 'services', title: 'Bicycle Repair', description: 'Fix gears',
    credits: 20, priceType: 'fixed', status: 'active', active: true, lat: -28.6, lng: 153.4,
    authorPublicKey: 'member-ada', authorCallsign: 'Ada', createdAt: '2026-09-16T00:00:00Z',
};
const GLOBAL = { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 } } };
const LOCAL = { profile: 'local', features: { beans: true } };
const AREA = { lat: -28.5, lng: 153.5, updatedAt: '2026-10-01T00:00:00Z' };

/** The feed's reads of the node (not the viewer's own, which names an author). */
// The read for online events beside a radius read (DESIGN-event-times §9) is its own: `onlineReads`.
const feedReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !f?.author && !f?.id && !f?.online);
const onlineReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !!f?.online);
const ownReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !!f?.author);

// The deciding review's board (#2363): a 10 km setting at -28.6149, 153.5951 goes to the node as -28.61, 153.6 and
// 11 km, 0.73 km to the north-east. A listing 9.8 km out on the far side is inside the circle but 10.5 km from the rounded
// centre; one 10.3 km out on the near side is outside it but 9.6 km from the rounded centre, so the node answers it first.
const BOARD_CENTRE = { lat: -28.6149, lng: 153.5951 };
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
/** The point `km` from BOARD_CENTRE on `bearing` (degrees from north), on lib/geo's 6371 km sphere. */
const boardPoint = (bearing: number, km: number) => {
    const [φ1, λ1, θ, δ] = [toRad(BOARD_CENTRE.lat), toRad(BOARD_CENTRE.lng), toRad(bearing), km / 6371];
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return { lat: toDeg(φ2), lng: toDeg(λ2) };
};
/** Which way the centre moved when it was rounded. */
const SHIFT_BEARING = (() => {
    const [φ1, φ2, Δλ] = [toRad(BOARD_CENTRE.lat), toRad(-28.61), toRad(153.6 - BOARD_CENTRE.lng)];
    return toDeg(Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)));
})();
/** `inside` listings 9.8 km out on the far side, and `ring` 10.3 km out on the near side. */
const board = (inside: number, ring: number) => [
    ...Array.from({ length: inside }, (_, i) => ({ ...offer, id: `in-${i}`, title: `Inside ${i}`, ...boardPoint(SHIFT_BEARING + 180 + (i - inside / 2) * 0.8, 9.8) })),
    ...Array.from({ length: ring }, (_, i) => ({ ...offer, id: `ring-${i}`, title: `Ring ${i}`, ...boardPoint(SHIFT_BEARING + (i - ring / 2) * 0.1, 10.3) })),
];
/** A node that answers a read by radius as the posts route does: nearest first, then by id, `limit` (50 unless asked) from `offset`. */
const pagingNode = (rows: ReturnType<typeof board>, km: typeof haversineDistance) => async (f: Parameters<typeof api.getMarketplacePosts>[0]) => {
    if (f?.author || f?.online || f?.lat == null || f.lng == null || f.radiusKm == null) return [] as any;
    const from = (p: { lat: number; lng: number }) => km(f.lat!, f.lng!, p.lat, p.lng);
    const offset = f.offset ?? 0;
    return rows.filter(p => from(p) <= f.radiusKm!).sort((a, b) => from(a) - from(b) || a.id.localeCompare(b.id))
        .slice(offset, offset + (f.limit ?? 50)).map(p => ({ ...p, distanceKm: from(p) })) as any;
};

describe('MarketplacePage: where the list is read from (S5)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(loadRadiusSettings).mockReturnValue(null);
        vi.mocked(haversineDistance).mockImplementation(() => 0);
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f) => (f?.author ? [] : [
            // The node measured it: the card shows the node's number, not one worked out here (haversine is 0 here).
            f?.lat != null ? { ...offer, distanceKm: 12.3 } : offer,
        ]) as any);
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: 'member-me', area: AREA } as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('on a by-area node, reads the nearest within the node\'s radius of the member\'s area, once, and shows the node\'s distance', async () => {
        info.current = GLOBAL;
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance' }]);
        // The viewer's own listings wherever they are: no point on that read.
        expect(ownReads()).toEqual([{ types: CLIENT_POST_TYPES, author: 'member-me' }]);
        expect(screen.getByTestId('card-distance')).toHaveTextContent('12 km');
        expect(screen.getByTestId('market-near-line')).toHaveTextContent('Nearest to your area first, within 250 km.');
    });

    it('beside a read by radius, reads online events wherever they are, and shows them (DESIGN-event-times §9)', async () => {
        info.current = GLOBAL;
        const online = { ...offer, id: 'ev-online', type: 'event', category: 'community', title: 'Vibe coding', lat: undefined, lng: undefined,
            eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), eventOnline: true, eventState: 'scheduled' };
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.author ? [] : f?.online ? [online] : [{ ...offer, distanceKm: 12.3 }]) as any);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(onlineReads()).toEqual([{ types: CLIENT_POST_TYPES, online: true }]);
        expect(await screen.findByText('Vibe coding')).toBeInTheDocument();
    });

    it('the member\'s distance setting wins over their area', async () => {
        info.current = GLOBAL;
        // The label the picker sets (RadiusPickerPage): never a place name, so the line does not use it.
        vi.mocked(loadRadiusSettings).mockReturnValue({ lat: -37.1, lng: 144.2, radiusKm: 30, label: '30km radius' });
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        // The node is asked for a tenth more than the setting (lib/listings-near nearRead), and for twice the 50 the list
        // keeps (readNearestInCircle); the line says the setting.
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES, lat: -37.1, lng: 144.2, radiusKm: 33, sort: 'distance', limit: 100 }]);
        expect(screen.getByTestId('market-near-line')).toHaveTextContent('Nearest first, within 30 km of the place you picked.');
    });

    it('a precise distance centre goes to the node only as precisely as its radius needs; the list is cut, ordered and measured from the exact centre (N5)', async () => {
        info.current = GLOBAL;
        const real = await vi.importActual<typeof import('../lib/geo')>('../lib/geo');
        vi.mocked(haversineDistance).mockImplementation(real.haversineDistance);
        vi.mocked(loadRadiusSettings).mockReturnValue({ lat: -28.612345, lng: 153.598765, radiusKm: 5, label: '5km radius' });
        // The node ordered and measured from the rounded centre it was sent; here its order and numbers are deliberately
        // unlike the exact ones. From the exact centre: 2.07 km, 5.20 km (past the 5 km edge), 1.10 km.
        const at = (id: string, title: string, lng: number, distanceKm: number) => ({ ...offer, id, title, lat: -28.612345, lng, distanceKm });
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.author ? [] : [
            at('offer-two', 'Bicycle Repair', 153.62, 9.9), at('offer-ring', 'Ring offer', 153.652, 4.4), at('offer-one', 'Garden help', 153.61, 0.5),
        ]) as any);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES, lat: -28.612, lng: 153.599, radiusKm: 5.5, sort: 'distance', limit: 100 }]);
        expect(screen.queryByText('Ring offer')).toBeNull();
        const shown = screen.getAllByTestId('card-distance').map(e => e.textContent?.replace('📍', '').trim());
        expect(shown).toEqual(['1.1 km', '2.1 km']);
        // The setting's radius, not the 5.5 km the node was asked for (lib/events formatDistance writes 5 as 5.0).
        expect(screen.getByTestId('market-near-line')).toHaveTextContent('Nearest first, within 5.0 km of the place you picked.');
    });

    describe('no listing inside the circle is lost when the node\'s page fills with ones past its edge (review of #2363)', () => {
        beforeEach(async () => {
            info.current = GLOBAL;
            const real = await vi.importActual<typeof import('../lib/geo')>('../lib/geo');
            vi.mocked(haversineDistance).mockImplementation(real.haversineDistance);
            vi.mocked(loadRadiusSettings).mockReturnValue({ ...BOARD_CENTRE, radiusKm: 10, label: '10km radius' });
        });
        const cards = () => screen.getAllByTestId('card-distance');

        it('the review\'s board: 45 inside on the far side, 10 past the edge on the near side; all 45 shown', async () => {
            const real = await vi.importActual<typeof import('../lib/geo')>('../lib/geo');
            const rows = board(45, 10);
            // As measured: from the rounded centre, every ring listing is nearer than every inside one.
            const fromRounded = (p: { lat: number; lng: number }) => real.haversineDistance(-28.61, 153.6, p.lat, p.lng);
            expect(Math.max(...rows.slice(45).map(fromRounded))).toBeLessThan(Math.min(...rows.slice(0, 45).map(fromRounded)));
            vi.mocked(api.getMarketplacePosts).mockImplementation(pagingNode(rows, real.haversineDistance));
            render(<MarketplacePage identity={identity} />);
            await screen.findByText('Inside 0');
            await waitFor(() => expect(cards()).toHaveLength(45));
            expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES, lat: -28.61, lng: 153.6, radiusKm: 11, sort: 'distance', limit: 100 }]);
            for (let i = 0; i < 45; i++) expect(screen.getByText(`Inside ${i}`)).toBeInTheDocument();
            expect(screen.queryByText(/^Ring /)).toBeNull();
        });

        it('a first page of only listings past the edge is followed by the next', async () => {
            const real = await vi.importActual<typeof import('../lib/geo')>('../lib/geo');
            vi.mocked(api.getMarketplacePosts).mockImplementation(pagingNode(board(45, 120), real.haversineDistance));
            render(<MarketplacePage identity={identity} />);
            await screen.findByText('Inside 0');
            await waitFor(() => expect(cards()).toHaveLength(45));
            const read = { types: CLIENT_POST_TYPES, lat: -28.61, lng: 153.6, radiusKm: 11, sort: 'distance', limit: 100 };
            expect(feedReads()).toEqual([read, { ...read, offset: 100 }]);
            expect(screen.queryByText(/^Ring /)).toBeNull();
        });
    });

    it('a member with no area and no distance setting reads the newest, with a way to what is near', async () => {
        info.current = GLOBAL;
        vi.mocked(api.getCommunityMe).mockResolvedValue({ publicKey: 'member-me', area: null } as any);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        expect(screen.queryByTestId('card-distance')).toBeNull();
        const line = screen.getByTestId('market-near-line');
        expect(line).toHaveTextContent('Newest from everywhere.');
        expect(screen.getByRole('button', { name: "See what's near you" })).toBeInTheDocument();
    });

    it('Show everywhere reads the newest, and Near your area goes back', async () => {
        info.current = GLOBAL;
        render(<MarketplacePage identity={identity} />);
        await screen.findByTestId('card-distance');
        fireEvent.click(screen.getByRole('button', { name: 'Show everywhere' }));
        await waitFor(() => expect(feedReads().at(-1)).toEqual({ types: CLIENT_POST_TYPES }));
        await waitFor(() => expect(screen.queryByTestId('card-distance')).toBeNull());
        fireEvent.click(screen.getByRole('button', { name: 'Near your area' }));
        await waitFor(() => expect(feedReads().at(-1)).toEqual({ types: CLIENT_POST_TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance' }));
    });

    it('a local node reads exactly as before, asks for no area, and says nothing about where', async () => {
        info.current = LOCAL;
        vi.mocked(loadRadiusSettings).mockReturnValue({ lat: -37.1, lng: 144.2, radiusKm: 30, label: 'Castlemaine' });
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        expect(api.getCommunityMe).not.toHaveBeenCalled();
        expect(screen.queryByTestId('market-near-line')).toBeNull();
        expect(screen.queryByTestId('card-distance')).toBeNull();
        // No radius, so no read for online events beside it: the one read has them.
        expect(onlineReads()).toEqual([]);
    });

    it('a visitor on a by-area node reads the lobby\'s list as before', async () => {
        info.current = GLOBAL;
        render(<MarketplacePage identity={null} visitor={{ beans: false, joinCard: null, onJoin: () => {} } as any} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        expect(api.getCommunityMe).not.toHaveBeenCalled();
        expect(screen.queryByTestId('market-near-line')).toBeNull();
    });

    it('a link to one listing opens it when nothing is near: the by-id read once the first read has settled', async () => {
        info.current = GLOBAL;
        // Nothing within the radius of the member's area; the listing itself is far away.
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.id === 'offer-1' ? [offer] : []) as any);
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId="offer-1" onPostOpened={onPostOpened} />);
        await waitFor(() => expect(onPostOpened).toHaveBeenCalledTimes(1));
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance' }]);
        expect(vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !!f?.id))
            .toEqual([{ id: 'offer-1', types: CLIENT_POST_TYPES }]);
        expect(await screen.findByText('Bicycle Repair')).toBeInTheDocument();
    });

    it('Events are never cut by the area or the distance: no point on their read, every event shown, no line', async () => {
        info.current = GLOBAL;
        const farEvent = {
            ...offer, id: 'ev-oslo', type: 'event', category: 'events', title: 'Oslo choir night', lat: 59.9, lng: 10.7,
            eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), eventEndAt: new Date(Date.now() + 90_000_000).toISOString(),
        };
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.author ? [] : f?.type === 'event' ? [farEvent] : [offer]) as any);
        vi.spyOn(api, 'getMyEvents').mockResolvedValue([]);
        for (const setting of [null, { lat: -37.1, lng: 144.2, radiusKm: 30, label: '30km radius' }]) {
            vi.mocked(loadRadiusSettings).mockReturnValue(setting);
            vi.mocked(api.getMarketplacePosts).mockClear();
            const { unmount } = render(<MarketplacePage identity={identity} />);
            await screen.findByText('Bicycle Repair');
            fireEvent.click(screen.getByRole('button', { name: 'Events' }));
            await screen.findByText('Oslo choir night');
            expect(feedReads().filter(f => f?.type === 'event')).toEqual([{ type: 'event' }]);
            expect(ownReads().filter(f => f?.type === 'event')).toEqual([{ type: 'event', author: 'member-me' }]);
            expect(screen.queryByTestId('market-near-line')).toBeNull();
            unmount();
        }
    });

    it('when the member\'s area cannot be read, the line says so and offers to try again, not the picker', async () => {
        info.current = GLOBAL;
        vi.mocked(api.getCommunityMe).mockRejectedValueOnce(new Error('429'));
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        expect(screen.getByTestId('market-near-line')).toHaveTextContent("Couldn't check your area just now, so this is the newest from everywhere.");
        expect(screen.queryByRole('button', { name: "See what's near you" })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(feedReads().at(-1)).toEqual({ types: CLIENT_POST_TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance' }));
        expect(screen.getByTestId('market-near-line')).toHaveTextContent('Nearest to your area first, within 250 km.');
    });

    it('when the area check meets private_preview, the line shows the node sentence, never "Couldn\'t check your area"', async () => {
        info.current = GLOBAL;
        const previewRefusal = Object.assign(new Error('This community is in a private preview. Ask its owner for an invite.'), {
            status: 403,
            code: 'private_preview',
        });
        vi.mocked(api.getCommunityMe).mockRejectedValueOnce(previewRefusal);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        const line = screen.getByTestId('market-near-line');
        expect(line).toHaveTextContent('This community is in a private preview. Ask its owner for an invite.');
        expect(line).not.toHaveTextContent("Couldn't check your area");
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('when the area check meets account_closed, the line shows closed sentence, never "Couldn\'t check your area"', async () => {
        info.current = GLOBAL;
        const closedRefusal = Object.assign(new Error('Closed'), {
            status: 403,
            code: 'account_closed',
        });
        vi.mocked(api.getCommunityMe).mockRejectedValueOnce(closedRefusal);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
        const line = screen.getByTestId('market-near-line');
        expect(line).toHaveTextContent('Your account in this community was closed.');
        expect(line).not.toHaveTextContent("Couldn't check your area");
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('a node that never answers its info still gets a list, read as before', async () => {
        info.current = GLOBAL;
        const gate = await import('../lib/visitor-lobby-gate');
        vi.mocked(gate.communityInfoOnce).mockImplementationOnce(() => new Promise(() => {}));
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(feedReads()).toEqual([{ types: CLIENT_POST_TYPES }]);
    });
});
