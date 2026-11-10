/**
 * A tap anywhere on a small card opens the ITEM, never the owner's profile (Marty, 4 Nov 2026: "from small cards you should be
 * able to click anywhere on the card and have the card come up and then be able to click on the profile pic from there").
 *
 * The map's pin card is one. The owner's name is shown, and a press on it, or on any bare part of the card, opens the listing.
 * The ✕ is the card's one other control and does not; the photo is part of the card, so a press on it opens the listing too (the
 * enlarge lives on the listing's own page, as on the phone). The card itself is the door for the keyboard and a screen reader:
 * one button named by the listing, as the Market's tiles are, since the card is the Market's list card (slice M1: the View
 * Details button went, DESIGN-card-style-box-fable.md §2, "a tap anywhere on a card opens the item").
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
    price_c: 1200, priceType: 'fixed', authorPublicKey: 'author-pk', authorCallsign: 'Bob',
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
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance_c: 0, isBlockedFromTrading: false } as any);
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
        const img = within(card).getByTestId('listing-list-photo').querySelector('img');
        expect(img).not.toBeNull();
        // One element opens the item and one closes the card: no third control for the photo.
        expect(within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Open listing: A dozen eggs', 'Close preview']);
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
        // The photo's slot (the list card's, M1): the card's other image is the bean sign beside the price.
        const slot = () => within(card).getByTestId('listing-list-photo');
        const photo = () => slot().querySelector('img');
        expect(photo()?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2`);
        // card-photo-blank (#2853): the small copy is asked once more past every cache before the photo's own URL.
        fireEvent.error(photo()!);
        expect(photo()?.getAttribute('src')).toBe(`${PHOTO}&size=thumb2&retry=1`);
        expect(within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Open listing: A dozen eggs', 'Close preview']);
        fireEvent.error(photo()!);
        expect(photo()?.getAttribute('src')).toBe(PHOTO);
        expect(within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Open listing: A dozen eggs', 'Close preview']);
        fireEvent.error(photo()!);
        expect(photo()).toBeNull();
        expect(within(slot()).getByText('🥕')).toBeInTheDocument();
        expect(within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Open listing: A dozen eggs', 'Close preview']);
        fireEvent.click(within(card).getByTestId('map-preview-tap'));
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-eggs');
    });

    it('the card is the door for the keyboard and a screen reader: one button named by the listing, Enter or Space opens it once, and no View button (M1)', async () => {
        const onNavigate = vi.fn();
        const { card } = await openPinCard(onNavigate);
        const door = within(card).getByRole('button', { name: 'Open listing: A dozen eggs' });
        expect(door).toBe(within(card).getByTestId('map-preview-tap'));
        expect(door.tabIndex).toBe(0);
        expect(within(card).queryByRole('button', { name: /View/ })).toBeNull();
        expect(card).not.toHaveTextContent(/View Details|View listing/);
        fireEvent.keyDown(door, { key: 'Enter' });
        expect(onNavigate).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(door, { key: ' ' });
        expect(onNavigate).toHaveBeenCalledTimes(2);
        expect(onNavigate).toHaveBeenLastCalledWith('marketplace', 'post-eggs');
        // Any other key opens nothing.
        fireEvent.keyDown(door, { key: 'a' });
        expect(onNavigate).toHaveBeenCalledTimes(2);
    });

    it('the ✕ closes the card and opens nothing', async () => {
        const onNavigate = vi.fn();
        const { view, card } = await openPinCard(onNavigate);
        fireEvent.click(within(card).getByRole('button', { name: 'Close preview' }));
        await waitFor(() => expect(view.queryByTestId('map-preview-card')).toBeNull());
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it("a visitor's pin card opens the listing from anywhere on it too, and its ✕ opens nothing", async () => {
        const GLOBAL = { memberCount: 3, postCount: 1, transactionCount: 0, commonsBalance_c: 0, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false } };
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

/**
 * Slice M1 (DESIGN-card-style-box-fable.md §2, §4; Marty, 4 Nov 2026: "yes restyle - look at the similar market place offer and
 * map card offer"): the map's pop-up is the Market's list card with a ✕. The same photo slot (80 wide, the card's full height,
 * first in the card so its corners round it), the same chips, title, who or date, place, and the price or the event's answer;
 * no View button, since a tap anywhere opens the item; no zero counts; the web event pop-up keeps Going / Interested (decided).
 */
describe("MapPage: the pin card is the Market's list card with a ✕ (M1)", () => {
    const HOUR = 60 * 60 * 1000;
    const bee = (extra: Record<string, unknown> = {}) => ({
        id: 'ev-bee', type: 'event', category: 'community', title: 'Working bee', description: '', price_c: 0, priceType: 'fixed',
        authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: '2026-09-17T00:00:00.000Z', active: true, status: 'active',
        repeatable: false, lat: -28.55, lng: 153.5, eventStartAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        eventState: 'scheduled', goingCount: 0, interestedCount: 0, myRsvp: null, ...extra,
    });
    const names = (card: HTMLElement) => within(card).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent);
    const slotIsTheListSlot = (slot: HTMLElement) => {
        // 80 wide and the card's full height (at least 80), never a fixed height of its own (market-card-shell LIST_PHOTO).
        expect(slot.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-20', 'min-h-20', 'self-stretch', 'shrink-0']));
        expect(slot.className.split(/\s+/).some(c => /^h-/.test(c))).toBe(false);
    };

    async function openEventCard(onNavigate: (...a: any[]) => void) {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} isMember={true} onNavigate={onNavigate} />); });
        await waitFor(() => expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-event-pin'))).toBe(true));
        act(() => { mockCreatedMarkers.find(m => m.opts?.className?.includes('custom-event-pin'))!.listeners['click']?.(); });
        return { view: view!, card: await view!.findByTestId('map-preview-card') };
    }

    it("an Offer: the list card's photo slot, chips, title, who and price, the floating shadow, and no button but the card and the ✕", async () => {
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([{ ...post, photos: ['/api/marketplace/posts/post-eggs/photos/0?v=1&k=KEY0'] }] as any);
        const onNavigate = vi.fn();
        const { card } = await openPinCard(onNavigate);
        const listCard = within(card).getByTestId('listing-list-card');
        const slot = within(listCard).getByTestId('listing-list-photo');
        expect(listCard.firstElementChild).toBe(slot);
        slotIsTheListSlot(slot);
        const chips = within(listCard).getByTestId('listing-list-chips');
        expect(chips).toHaveTextContent('OFFER');
        expect(chips).toHaveTextContent('🥕 Food & Produce');
        expect(chips).toHaveTextContent('↻ RECURRING');
        expect(within(listCard).getByTestId('listing-list-title')).toHaveTextContent('A dozen eggs');
        expect(within(listCard).getByTestId('listing-list-price')).toHaveTextContent('12');
        expect(listCard).toHaveTextContent('Bob');
        expect(names(card)).toEqual(['Open listing: A dozen eggs', 'Close preview']);
        expect(card).not.toHaveTextContent(/View/);
        expect(within(card).getByTestId('map-preview-tap').className).toContain('shadow-[0_10px_20px_rgba(0,0,0,0.15)]');
        fireEvent.click(slot);
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-eggs');
    });

    it('an event nobody has answered yet: the list card with EVENT, the when and the title, no "0 going", Going and Interested, and no View button', async () => {
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([bee()] as any);
        const onNavigate = vi.fn();
        const { view, card } = await openEventCard(onNavigate);
        const eventCard = within(card).getByTestId('event-card');
        // The card's own frame is the list card's (corners 14, the card ground), not the old sheet's radius 24.
        expect(eventCard.className.split(/\s+/)).toEqual(expect.arrayContaining(['rounded-[14px]', 'bg-[var(--bg-card)]']));
        expect(card.innerHTML).not.toMatch(/rounded-\[24px\]/);
        const slot = within(eventCard).getByTestId('event-list-photo');
        slotIsTheListSlot(slot);
        expect(slot.parentElement!.firstElementChild).toBe(slot);
        expect(within(eventCard).getByTestId('event-type-chip')).toHaveTextContent('EVENT');
        // The chip row stops short of the ✕.
        expect(within(eventCard).getByTestId('event-chips').className.split(/\s+/)).toContain('pe-8');
        expect(within(eventCard).getByTestId('event-when')).toBeInTheDocument();
        expect(eventCard).toHaveTextContent('Working bee');
        expect(within(eventCard).queryByTestId('event-counts')).toBeNull();
        expect(card).not.toHaveTextContent(/0 going|0 interested/);
        expect(names(card)).toEqual(['Open event: Working bee', 'Going', 'Interested', 'Close preview']);
        expect(card).not.toHaveTextContent(/View/);
        fireEvent.click(within(eventCard).getByRole('button', { name: 'Open event: Working bee' }));
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'ev-bee');
        fireEvent.click(within(card).getByRole('button', { name: 'Close preview' }));
        await waitFor(() => expect(view.queryByTestId('map-preview-card')).toBeNull());
        expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it('an event you are going to: your answer is the filled Going ✓, and the counts show once they are above zero', async () => {
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([bee({ myRsvp: 'going', goingCount: 1, interestedCount: 2 })] as any);
        const { card } = await openEventCard(vi.fn());
        const going = within(card).getByRole('button', { name: 'Going ✓' });
        expect(going).toHaveAttribute('aria-pressed', 'true');
        expect(within(card).getByTestId('event-counts')).toHaveTextContent('1 going · 2 interested');
    });

    it("a visitor's card: the list card's slot and chips, the title and \"near here\", and no price, name or View button", async () => {
        const GLOBAL = { memberCount: 3, postCount: 1, transactionCount: 0, commonsBalance_c: 0, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false } };
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(GLOBAL as any);
        const onNavigate = vi.fn();
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={null} isMember={false} visitor onNavigate={onNavigate} />); });
        await waitFor(() => expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-map-pin'))).toBe(true));
        act(() => { pinOf().listeners['click']?.(); });
        const card = await view!.findByTestId('map-preview-card');
        const tap = within(card).getByTestId('map-preview-tap');
        const listCard = tap.firstElementChild as HTMLElement;
        expect(listCard.className.split(/\s+/)).toEqual(expect.arrayContaining(['rounded-[14px]', 'bg-[var(--bg-card)]']));
        slotIsTheListSlot(listCard.firstElementChild as HTMLElement);
        expect(card).toHaveTextContent('OFFER');
        expect(card).toHaveTextContent('🥕 Food & Produce');
        expect(within(card).getByTestId('map-preview-title')).toHaveTextContent('A dozen eggs');
        expect(within(card).getByTestId('map-preview-near')).toHaveTextContent('near here');
        expect(card).not.toHaveTextContent(/Bob|12|View/);
        expect(names(card)).toEqual(['Open listing: A dozen eggs', 'Close preview']);
        fireEvent.click(tap);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-eggs');
    });
});
