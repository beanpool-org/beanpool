/**
 * A tap anywhere on a small card opens the ITEM, never the owner's profile (Marty, 4 Nov 2026: "from small cards you should be
 * able to click anywhere on the card and have the card come up and then be able to click on the profile pic from there").
 *
 * The map's pin card is one. The owner's name is shown, and a press on it, or on any bare part of the card, opens the listing.
 * The ✕ is the card's one other control and does not; the photo is part of the card, so a press on it opens the listing too (the
 * enlarge lives on the listing's own page, as on the phone). The View Details button stays the door for the keyboard and a
 * screen reader, described by the title.
 *
 * Its own file, with the leaflet stand-in MapPage.test.tsx uses: that file stubs the global fetch in its later blocks and leaves
 * it stubbed, which this card does not want to inherit.
 */
import { render, waitFor, act, fireEvent, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MapPage, resetSavedMapView } from './MapPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';

vi.mock('leaflet.markercluster', () => ({}));

const mockCreatedMarkers: Array<{ coords: [number, number]; opts: any; listeners: Record<string, (...args: any[]) => any>; addTo?: any }> = [];

vi.mock('leaflet', () => {
    const layerGroup = {
        clearLayers: vi.fn(),
        addLayer: vi.fn(),
        addTo: vi.fn().mockReturnThis(),
        on: vi.fn(),
        getVisibleParent: vi.fn(),
    };

    return {
        default: {
            map: vi.fn((_el: unknown, opts: any) => ({
                setView: vi.fn(),
                getBoundsZoom: vi.fn(() => 18),
                panBy: vi.fn(),
                fitBounds: vi.fn(),
                on: vi.fn(),
                off: vi.fn(),
                remove: vi.fn(),
                removeLayer: vi.fn(),
                getZoom: vi.fn(() => opts?.zoom ?? 13),
                getCenter: vi.fn(() => ({ lat: opts?.center?.[0] ?? 0, lng: opts?.center?.[1] ?? 0 })),
                getContainer: vi.fn(() => ({ getBoundingClientRect: () => ({ top: 0, bottom: 640, left: 0, right: 320 }), appendChild: () => {} })),
                getSize: vi.fn(() => ({ x: 320, y: 640 })),
                latLngToContainerPoint: vi.fn(() => ({ x: 160, y: 300 })),
            })),
            tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
            control: {
                attribution: vi.fn(() => ({
                    addAttribution: vi.fn().mockReturnThis(),
                    addTo: vi.fn(),
                })),
            },
            divIcon: vi.fn((opts) => opts),
            point: (x: number, y: number) => ({ x, y }),
            marker: vi.fn((coords: [number, number], opts: any) => {
                const listeners: Record<string, (...args: any[]) => any> = {};
                const m = {
                    coords,
                    opts: {
                        ...opts,
                        ...(opts?.icon || {}),
                    },
                    listeners,
                    addTo: vi.fn().mockReturnThis(),
                    setLatLng: vi.fn(),
                    remove: vi.fn(),
                    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
                        listeners[event] = handler;
                    }),
                };
                mockCreatedMarkers.push(m);
                return m;
            }),
            circle: vi.fn((center: [number, number], opts: any) => ({
                addTo: vi.fn().mockReturnThis(), setLatLng: vi.fn(), setRadius: vi.fn(),
                getBounds: vi.fn(() => ({ circleBoundsOf: center, radius: opts?.radius })),
            })),
            markerClusterGroup: vi.fn(() => layerGroup),
            layerGroup: vi.fn(() => ({ clearLayers: vi.fn(), addLayer: vi.fn(), addTo: vi.fn().mockReturnThis() })),
        },
    };
});

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({ haversineDistance: vi.fn(() => 0), loadRadiusSettings: vi.fn(() => null) }));
vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()) }));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'user-alice-pubkey',
    privateKey: 'user-alice-privkey',
    callsign: 'Alice',
    createdAt: '2026-09-17T00:00:00.000Z',
};

const post = {
    id: 'post-eggs', type: 'offer', category: 'food', title: 'A dozen eggs', description: 'Fresh',
    credits: 12, priceType: 'fixed', authorPublicKey: 'author-pk', authorCallsign: 'Bob',
    createdAt: '2026-09-17T00:00:00.000Z', active: true, status: 'active', repeatable: true,
    lat: -28.5495, lng: 153.5005,
};

beforeEach(() => {
    vi.clearAllMocks();
    mockCreatedMarkers.length = 0;
    resetSavedMapView();
    resetCommunityInfoOnce();
    vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([post] as any);
    vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
    vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
});
afterEach(() => { cleanup(); resetCommunityInfoOnce(); });

const pinOf = () => mockCreatedMarkers.find(m => m.opts?.className?.includes('custom-map-pin'))!;

async function openPinCard(onNavigate: (...a: any[]) => void) {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => { view = render(<MapPage identity={mockIdentity} isMember={true} onNavigate={onNavigate} />); });
    await waitFor(() => expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-map-pin'))).toBe(true));
    act(() => { pinOf().listeners['click']?.(); });
    return { view: view!, card: await view!.findByTestId('map-preview-card') };
}

describe("MapPage: the pin card opens its listing from anywhere on it", () => {
    it("a press on the owner's name opens the listing", async () => {
        const onNavigate = vi.fn();
        const { card } = await openPinCard(onNavigate);
        fireEvent.click(within(card).getByText(/Bob/));
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-eggs');
    });

    it('a press on a bare part of the card opens the listing', async () => {
        const onNavigate = vi.fn();
        const { card } = await openPinCard(onNavigate);
        fireEvent.click(within(card).getByTestId('map-preview-tap'));
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-eggs');
    });

    it("the photo is part of the card: a press on it opens the listing, and the card holds no enlarge button (4 Nov, small cards open the item)", async () => {
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([{ ...post, photos: ['/api/marketplace/posts/post-eggs/photos/0?v=1&k=KEY0'] }] as any);
        const onNavigate = vi.fn();
        const { card } = await openPinCard(onNavigate);
        const img = card.querySelector('img');
        expect(img).not.toBeNull();
        // One element opens the item and one closes the card: no third control for the photo.
        expect(within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close preview', 'View Details']);
        expect(img!.closest('button')).toBeNull();
        fireEvent.click(img!);
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-eggs');
    });

    // Both halves together (the sync of #2838 with the small-cards rule): a small copy that fails steps down to the full photo,
    // then to the category tile, never an empty slot; and through every step the photo has no control of its own.
    it("a failed small photo is asked once more past every cache, then steps down to the full photo, then the category tile, and the card still opens the listing", async () => {
        const PHOTO = '/api/marketplace/posts/post-eggs/photos/0?v=1&k=KEY0';
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([{ ...post, photos: [PHOTO] }] as any);
        const onNavigate = vi.fn();
        const { card } = await openPinCard(onNavigate);
        expect(card.querySelector('img')?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2`);
        // card-photo-blank (#2853): the small copy is asked once more past every cache before the photo's own URL.
        fireEvent.error(card.querySelector('img')!);
        expect(card.querySelector('img')?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2&retry=1`);
        expect(within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close preview', 'View Details']);
        fireEvent.error(card.querySelector('img')!);
        expect(card.querySelector('img')?.getAttribute('src')).toBe(PHOTO);
        expect(within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close preview', 'View Details']);
        fireEvent.error(card.querySelector('img')!);
        expect(card.querySelector('img')).toBeNull();
        expect(within(card).getByText('🥕')).toBeInTheDocument();
        expect(within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close preview', 'View Details']);
        fireEvent.click(within(card).getByTestId('map-preview-tap'));
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-eggs');
    });

    it('the View Details button opens it once (the press does not reach the card as well), and is described by the title', async () => {
        const onNavigate = vi.fn();
        const { card } = await openPinCard(onNavigate);
        const button = within(card).getByRole('button', { name: 'View Details' });
        expect(button).toHaveAccessibleDescription('A dozen eggs');
        fireEvent.click(button);
        expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it('the ✕ closes the card and opens nothing', async () => {
        const onNavigate = vi.fn();
        const { view, card } = await openPinCard(onNavigate);
        fireEvent.click(within(card).getByRole('button', { name: 'Close preview' }));
        await waitFor(() => expect(view.queryByTestId('map-preview-card')).toBeNull());
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it("a visitor's pin card opens the listing from anywhere on it too, and its ✕ opens nothing", async () => {
        const GLOBAL = { memberCount: 3, postCount: 1, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false } };
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(GLOBAL as any);
        const onNavigate = vi.fn();
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={null} isMember={false} visitor onNavigate={onNavigate} />); });
        await waitFor(() => expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-map-pin'))).toBe(true));
        act(() => { pinOf().listeners['click']?.(); });
        const card = await view!.findByTestId('map-preview-card');
        fireEvent.click(within(card).getByRole('button', { name: 'Close preview' }));
        expect(onNavigate).not.toHaveBeenCalled();
        await waitFor(() => expect(view!.queryByTestId('map-preview-card')).toBeNull());
        act(() => { pinOf().listeners['click']?.(); });
        const again = await view!.findByTestId('map-preview-card');
        fireEvent.click(within(again).getByTestId('map-preview-near'));
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', expect.any(String));
    });
});
