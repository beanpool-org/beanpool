import { render, waitFor, act, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MapPage, resetSavedMapView } from './MapPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import L from 'leaflet';

vi.mock('leaflet.markercluster', () => ({}));

const mockCreatedMarkers: Array<{ coords: [number, number]; opts: any; listeners: Record<string, (...args: any[]) => any>; addTo?: any }> = [];

vi.mock('leaflet', () => {
    const layerGroup = {
        clearLayers: vi.fn(),
        addLayer: vi.fn(),
        addTo: vi.fn().mockReturnThis(),
    };

    return {
        default: {
            map: vi.fn((_el: unknown, opts: any) => ({
                setView: vi.fn(),
                panBy: vi.fn(),
                fitBounds: vi.fn(),
                on: vi.fn(),
                off: vi.fn(),
                remove: vi.fn(),
                removeLayer: vi.fn(),
                getZoom: vi.fn(() => opts?.zoom ?? 13),
                getCenter: vi.fn(() => ({ lat: opts?.center?.[0] ?? 0, lng: opts?.center?.[1] ?? 0 })),
                getContainer: vi.fn(() => ({ getBoundingClientRect: () => ({ top: 0, bottom: 640, left: 0, right: 320 }) })),
            })),
            tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
            control: {
                attribution: vi.fn(() => ({
                    addAttribution: vi.fn().mockReturnThis(),
                    addTo: vi.fn(),
                })),
            },
            divIcon: vi.fn((opts) => opts),
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
            // Event pins: their own layer, outside the cluster group.
            layerGroup: vi.fn(() => ({ clearLayers: vi.fn(), addLayer: vi.fn(), addTo: vi.fn().mockReturnThis() })),
        },
    };
});

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/geo', () => ({
    haversineDistance: vi.fn(() => 0),
}));

vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));

vi.mock('../lib/peer-prefs', () => ({
    loadEnabledPeers: vi.fn(() => new Set()),
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'user-alice-pubkey',
    privateKey: 'user-alice-privkey',
    callsign: 'Alice',
    createdAt: '2026-09-17T00:00:00.000Z',
};

describe('MapPage Enterprise Location Pins (Slice 6, docs/the-commons.md §2.2)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;

        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([]);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({
            enterprises: [
                {
                    publicKey: 'ent-shed-pk',
                    name: 'Mullum Tool Shed',
                    callsign: 'ToolShed',
                    avatar: '🔧',
                    lat: -28.5495,
                    lng: 153.5005,
                    paused: false,
                    status: 'active',
                },
                {
                    publicKey: 'ent-flock-pk',
                    name: 'Community Eggs',
                    callsign: 'CommunityEggs',
                    avatar: '🥚',
                    lat: -28.552,
                    lng: 153.504,
                    paused: true,
                    status: 'paused',
                },
                {
                    publicKey: 'ent-wound-up-pk',
                    name: 'Wound Up Farm',
                    callsign: 'WoundUpFarm',
                    avatar: '🌱',
                    lat: -28.54,
                    lng: 153.51,
                    paused: false,
                    status: 'completed',
                },
            ],
        });
    });

    it('renders active and paused enterprise pins on the map and excludes completed enterprises', async () => {
        const onOpenTreasury = vi.fn();

        await act(async () => {
            render(
                <MapPage
                    identity={mockIdentity}
                    onOpenTreasury={onOpenTreasury}
                />
            );
        });

        await waitFor(() => {
            expect(api.getEnterpriseMapPins).toHaveBeenCalled();
        });

        await waitFor(() => {
            // Check created markers
            const enterpriseMarkers = mockCreatedMarkers.filter(m =>
                m.opts?.className?.includes('custom-enterprise-pin')
            );
            // Should have 2 enterprise pins (shed and flock); wound-up enterprise is excluded
            expect(enterpriseMarkers.length).toBe(2);
        });

        const shedMarker = mockCreatedMarkers.find(m =>
            m.opts?.className?.includes('custom-enterprise-pin') &&
            m.opts?.html?.includes('Mullum Tool Shed')
        );
        expect(shedMarker).toBeDefined();
        expect(shedMarker?.opts?.html).toContain('border-radius: 12px'); // Visually distinct rounded square
        expect(shedMarker?.opts?.html).not.toContain('PAUSED');

        const flockMarker = mockCreatedMarkers.find(m =>
            m.opts?.className?.includes('custom-enterprise-pin') &&
            m.opts?.html?.includes('Community Eggs')
        );
        expect(flockMarker).toBeDefined();
        // Paused enterprise pin explicitly says PAUSED
        expect(flockMarker?.opts?.html).toContain('PAUSED');

        // Completed enterprise has NO pin
        const completedMarker = mockCreatedMarkers.find(m =>
            m.opts?.html?.includes('Wound Up Farm')
        );
        expect(completedMarker).toBeUndefined();
    });

    it('tapping an enterprise pin navigates through to enterprise detail screen', async () => {
        const onOpenTreasury = vi.fn();

        await act(async () => {
            render(
                <MapPage
                    identity={mockIdentity}
                    onOpenTreasury={onOpenTreasury}
                />
            );
        });

        await waitFor(() => {
            const shedMarker = mockCreatedMarkers.find(m =>
                m.opts?.className?.includes('custom-enterprise-pin') &&
                m.opts?.html?.includes('Mullum Tool Shed')
            );
            expect(shedMarker).toBeDefined();
        });

        const shedMarker = mockCreatedMarkers.find(m =>
            m.opts?.className?.includes('custom-enterprise-pin') &&
            m.opts?.html?.includes('Mullum Tool Shed')
        );

        // Click marker
        act(() => {
            shedMarker?.listeners['click']?.();
        });

        expect(onOpenTreasury).toHaveBeenCalledWith('ent-shed-pk');
    });

    it('sets accessible title and alt attributes on enterprise markers', async () => {
        await act(async () => {
            render(
                <MapPage
                    identity={mockIdentity}
                />
            );
        });

        await waitFor(() => {
            const shedMarker = mockCreatedMarkers.find(m =>
                m.opts?.className?.includes('custom-enterprise-pin') &&
                m.opts?.html?.includes('Mullum Tool Shed')
            );
            expect(shedMarker).toBeDefined();
            expect(shedMarker?.opts?.title).toBe('Mullum Tool Shed (Enterprise)');
            expect(shedMarker?.opts?.alt).toBe('Mullum Tool Shed (Enterprise)');

            const flockMarker = mockCreatedMarkers.find(m =>
                m.opts?.className?.includes('custom-enterprise-pin') &&
                m.opts?.html?.includes('Community Eggs')
            );
            expect(flockMarker).toBeDefined();
            expect(flockMarker?.opts?.title).toBe('Community Eggs (Paused Enterprise)');
            expect(flockMarker?.opts?.alt).toBe('Community Eggs (Paused Enterprise)');
        });
    });

    it('escapes enterprise name and avatar to prevent stored XSS and attribute breakout', async () => {
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValueOnce({
            enterprises: [
                {
                    publicKey: 'ent-malicious-pk',
                    name: '<script>alert("xss")</script>" onmouseover="steal()',
                    callsign: 'BadEnt',
                    avatar: '<img src=x onerror=alert(1)>',
                    lat: -28.5495,
                    lng: 153.5005,
                    paused: false,
                    status: 'active',
                },
            ],
        });

        await act(async () => {
            render(
                <MapPage
                    identity={mockIdentity}
                />
            );
        });

        await waitFor(() => {
            const marker = mockCreatedMarkers.find(m =>
                m.opts?.className?.includes('custom-enterprise-pin')
            );
            expect(marker).toBeDefined();
            const html = marker?.opts?.html;
            expect(html).not.toContain('<script>');
            expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
            expect(html).not.toContain('<img src=x');
        });
    });
});

describe('MapPage: guest balance and the pages that open over the map', () => {
    const post = {
        id: 'post-eggs', type: 'offer', category: 'food', title: 'A dozen eggs', description: 'Fresh',
        credits: 12, priceType: 'fixed', authorPublicKey: 'author-pk', authorCallsign: 'Bob',
        createdAt: '2026-09-17T00:00:00.000Z', active: true, status: 'active', repeatable: true,
        lat: -28.5495, lng: 153.5005,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([post] as any);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    it('never asks for the balance of a guest', async () => {
        await act(async () => {
            render(<MapPage identity={mockIdentity} isMember={false} />);
        });
        await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalled());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(api.getBalance).not.toHaveBeenCalled();
    });

    it('waits for the membership check, then asks once it says member', async () => {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => {
            view = render(<MapPage identity={mockIdentity} isMember={null} />);
        });
        await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalled());
        expect(api.getBalance).not.toHaveBeenCalled();

        await act(async () => {
            view!.rerender(<MapPage identity={mockIdentity} isMember={true} />);
        });
        await waitFor(() => expect(api.getBalance).toHaveBeenCalledTimes(1));
        expect(api.getBalance).toHaveBeenCalledWith(mockIdentity.publicKey);
    });

    it('hides the preview card and New Post panel while an enterprise or profile page covers the map, and brings them back', async () => {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => {
            view = render(<MapPage identity={mockIdentity} openNewPost />);
        });
        await waitFor(() => expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-map-pin'))).toBe(true));
        const postMarker = mockCreatedMarkers.find(m => m.opts?.className?.includes('custom-map-pin'))!;
        act(() => { postMarker.listeners['click']?.(); });

        const preview = await view!.findByTestId('map-preview-card');
        const panel = await view!.findByTestId('map-new-post-panel');
        expect(preview).toBeVisible();
        expect(panel).toBeVisible();

        // Both sit at z-[150] / z-[1000] in the root stacking context, above the z-[110] enterprise page.
        await act(async () => {
            view!.rerender(<MapPage identity={mockIdentity} openNewPost covered />);
        });
        expect(view!.getByTestId('map-preview-card')).not.toBeVisible();
        expect(view!.getByTestId('map-new-post-panel')).not.toBeVisible();

        // Back from the enterprise page: the same preview and the draft panel are still there.
        await act(async () => {
            view!.rerender(<MapPage identity={mockIdentity} openNewPost covered={false} />);
        });
        expect(view!.getByTestId('map-preview-card')).toBeVisible();
        expect(view!.getByTestId('map-preview-card')).toHaveTextContent('A dozen eggs');
        expect(view!.getByTestId('map-new-post-panel')).toBeVisible();
    });

    // The panel is fixed to the VIEWPORT, so left-3/right-3 on its own stretched it across a desktop
    // screen and over the w-64 sidebar. jsdom lays nothing out, so the breakpoint classes are the
    // assertion: the phone gutters stay, and md+ gets a left edge past the sidebar and a capped width.
    it('caps the New Post panel to a card column past the sidebar on md+, and leaves the phone sheet full bleed', async () => {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => {
            view = render(<MapPage identity={mockIdentity} openNewPost />);
        });
        const panel = await view!.findByTestId('map-new-post-panel');
        const classes = panel.className.split(/\s+/);

        // Phone: unchanged, edge to edge inside a 0.75rem gutter.
        expect(classes).toContain('left-3');
        expect(classes).toContain('right-3');

        // md+: starts at the 16rem sidebar plus the same gutter, and stops being a full-width bar.
        expect(classes).toContain('md:left-[16.75rem]');
        expect(classes).toContain('md:right-auto');
        expect(classes).toContain('md:w-[30rem]');
        expect(classes).toContain('md:max-w-[calc(100vw-17.5rem)]');
    });

});

describe('MapPage: events (docs/events-on-the-map.md §3, slice 2)', () => {
    const HOUR = 60 * 60 * 1000;
    const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
    const ev = (id: string, title: string, startInHours: number, extra: Record<string, unknown> = {}) => ({
        id, type: 'event', category: 'community', title, description: '', credits: 0, priceType: 'fixed',
        authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: '2026-09-17T00:00:00.000Z', active: true,
        status: 'active', repeatable: false, lat: -28.55, lng: 153.5, eventStartAt: inHours(startInHours),
        eventState: 'scheduled', goingCount: 2, interestedCount: 1, myRsvp: null, ...extra,
    });
    const offer = {
        id: 'post-eggs', type: 'offer', category: 'food', title: 'A dozen eggs', description: 'Fresh',
        credits: 12, priceType: 'fixed', authorPublicKey: 'author-pk', authorCallsign: 'Bob',
        createdAt: '2026-09-17T00:00:00.000Z', active: true, status: 'active', repeatable: true,
        lat: -28.5495, lng: 153.5005,
    };
    // Starts in a quarter of an hour, so it is inside "Next 7 days" whenever the suite runs.
    const soon = ev('ev-soon', 'Repair café', 0.25);
    const later = ev('ev-later', 'Spring working bee', 24 * 20);
    const cancelled = ev('ev-cancelled', 'Called off', 2, { eventState: 'cancelled' });
    const ended = ev('ev-ended', 'Already over', -5, { eventEndAt: inHours(-3) });

    const eventPins = () => mockCreatedMarkers.filter(m => m.opts?.className?.includes('custom-event-pin'));

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([offer, soon, later, cancelled, ended] as any);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    it('asks the node for events with types=, as old store apps do not', async () => {
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalledWith({ types: 'offer,need,poll,event' }));
    });

    it('pins open events with the purple calendar pin, never cancelled or ended ones, and keeps them off the offer pins', async () => {
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(eventPins().length).toBeGreaterThan(0));
        const titles = eventPins().map(m => m.opts.title);
        expect(new Set(titles)).toEqual(new Set(['Event: Repair café', 'Event: Spring working bee']));
        // A drawn calendar with no date on it: the 📅 emoji printed "JUL 17" on Android (events round 2, B7).
        expect(eventPins()[0].opts.html).toContain('data-event-pin-icon');
        expect(eventPins().every(m => !String(m.opts.html).includes('📅'))).toBe(true);
        expect(eventPins()[0].opts.html).toContain('#7c3aed');
        const offerPins = mockCreatedMarkers.filter(m => m.opts?.className?.includes('custom-map-pin'));
        expect(offerPins.length).toBeGreaterThan(0);
        expect(offerPins.every(m => !String(m.opts.html).includes('data-event-pin-icon'))).toBe(true);
    });

    it('keeps event pins out of the listing clusters, in their own layer drawn above the listings (B2)', async () => {
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(eventPins().length).toBeGreaterThan(0));
        const clusterGroup = (L as any).markerClusterGroup.mock.results[0].value;
        const eventLayer = (L as any).layerGroup.mock.results[0].value;
        expect(eventLayer).not.toBe(clusterGroup);
        for (const pin of eventPins()) {
            expect(pin.addTo).toHaveBeenCalledWith(eventLayer);
            expect(pin.addTo).not.toHaveBeenCalledWith(clusterGroup);
            expect(pin.opts.zIndexOffset).toBeGreaterThan(0);
        }
        const offerPins = mockCreatedMarkers.filter(m => m.opts?.className?.includes('custom-map-pin'));
        expect(offerPins.every(m => m.addTo.mock.calls.every((c: any[]) => c[0] === clusterGroup))).toBe(true);
    });

    it('a date chip fits the map to its events, below the chip row (B2)', async () => {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(view!.getByTestId('event-window-chips')).toBeTruthy());
        const map = (L as any).map.mock.results[0].value;
        map.fitBounds.mockClear();
        await act(async () => { fireEvent.click(view!.getByRole('button', { name: 'All events' })); });
        expect(map.fitBounds).toHaveBeenCalledTimes(1);
        const [points, opts] = map.fitBounds.mock.calls[0];
        expect(points.length).toBe(eventPins().length);
        // The chips' own bottom edge plus the 48px pin and a margin: the pin's head never sits under them.
        expect(opts.paddingTopLeft[1]).toBeGreaterThanOrEqual(48 + 16);
    });

    it('filters event pins with Today / This weekend / Next 7 days / All, in one row', async () => {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        const chips = await view!.findByTestId('event-window-chips');
        expect(chips.className).toContain('flex-nowrap');
        expect(chips.className).toContain('overflow-x-auto');
        const buttons = Array.from(chips.querySelectorAll('button'));
        expect(buttons.map(b => b.textContent)).toEqual(['Today', 'This weekend', 'Next 7 days', 'All events']);
        for (const b of buttons) expect(b.className).toContain('whitespace-nowrap');

        mockCreatedMarkers.length = 0;
        await act(async () => { fireEvent.click(view!.getByRole('button', { name: 'Next 7 days' })); });
        expect(eventPins().map(m => m.opts.title)).toEqual(['Event: Repair café']);
        // The chips never touch offers.
        expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-map-pin'))).toBe(true);

        mockCreatedMarkers.length = 0;
        await act(async () => { fireEvent.click(view!.getByRole('button', { name: 'All events' })); });
        expect(eventPins().length).toBe(2);
    });

    it('opens the event card when an event pin is tapped', async () => {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(eventPins().length).toBe(2));
        const pin = eventPins().find(m => m.opts.title === 'Event: Spring working bee')!;
        act(() => { pin.listeners['click']?.(); });
        const preview = await view!.findByTestId('map-preview-card');
        expect(within(preview).getByTestId('event-card')).toHaveTextContent('Spring working bee');
        expect(within(preview).getByTestId('event-card')).toHaveTextContent('2 going · 1 interested');
    });

    it('creates an event with a dropped pin rounded by Approximate', async () => {
        const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
        const onNavigate = vi.fn();
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost onNavigate={onNavigate} />); });
        const panel = await view!.findByTestId('map-new-post-panel');
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Event' })); });

        fireEvent.change(within(panel).getByLabelText("What's happening"), { target: { value: 'Working bee' } });
        fireEvent.change(within(panel).getByLabelText('Starts'), { target: { value: '2030-09-28T09:00' } });
        fireEvent.change(within(panel).getByLabelText('Place name'), { target: { value: 'Bindarrabi Hall' } });
        fireEvent.change(within(panel).getByLabelText('Note for people who are going'), { target: { value: 'Gate code 1234' } });
        expect(within(panel).getByText('Only people who tap Going see this.')).toBeInTheDocument();
        expect(within(panel).getByTestId('event-location-visibility')).toHaveTextContent("Anyone who opens this node's map will see this spot.");

        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: /Drop a pin/ })); });
        const mapResults = vi.mocked(L.map).mock.results;
        const map = mapResults[mapResults.length - 1].value as any;
        const clickHandlers = map.on.mock.calls.filter((c: any[]) => c[0] === 'click').map((c: any[]) => c[1]);
        await act(async () => { clickHandlers.forEach((h: any) => h({ latlng: { lat: -28.55437, lng: 153.50261 } })); });
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Approximate (~100m)' })); });

        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Create Event' })); });
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        const body = create.mock.calls[0][0];
        expect(body).toMatchObject({
            type: 'event', category: 'community', credits: 0, title: 'Working bee', authorPublicKey: mockIdentity.publicKey,
            lat: -28.554, lng: 153.503, eventPlaceName: 'Bindarrabi Hall', eventPrivateNote: 'Gate code 1234',
            eventStartAt: new Date('2030-09-28T09:00').toISOString(), audienceScope: 'public',
        });
        expect(body).not.toHaveProperty('eventEndAt');
        expect(body).not.toHaveProperty('reach');
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'ev-new');
    });

    describe('address search in the location section (settings app lookup, reused)', () => {
        const nominatim = [
            { display_name: 'Bindarrabi Hall, 12, Main Street, Mullumbimby, NSW, Australia', name: 'Bindarrabi Hall', lat: '-28.5543712', lon: '153.5026149', type: 'community_centre' },
            { display_name: '12, Main Street, Mullumbimby, NSW, Australia', name: '', lat: '-28.5540', lon: '153.5020', type: 'house' },
        ];
        const openEventForm = async (fetchImpl: (url: string) => Promise<any>) => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation(fetchImpl));
            let view: ReturnType<typeof render> | undefined;
            await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost />); });
            const panel = await view!.findByTestId('map-new-post-panel');
            await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Event' })); });
            return panel;
        };
        const search = async (panel: HTMLElement, text: string) => {
            const box = within(panel).getByLabelText('Find an address');
            fireEvent.change(box, { target: { value: text } });
            // The Search key sends at once instead of waiting out the 1 s pause.
            await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
            await act(async () => { await new Promise(r => setTimeout(r, 0)); });
            return box;
        };

        afterEach(() => { vi.unstubAllGlobals(); });

        it('picking a match places the pin there, fills an empty Place name, and Approximate still rounds it', async () => {
            const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
            const panel = await openEventForm(async () => ({ ok: true, json: async () => nominatim }));
            await search(panel, 'bindarrabi hall');
            expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
                'https://nominatim.openstreetmap.org/search?format=json&q=bindarrabi%20hall&limit=5');

            const options = within(panel).getAllByRole('option');
            expect(options).toHaveLength(2);
            expect(options[1]).toHaveTextContent('12 Main Street');
            await act(async () => { fireEvent.click(options[0]); });

            expect((within(panel).getByLabelText('Place name') as HTMLInputElement).value).toBe('Bindarrabi Hall');
            expect(within(panel).getByText(/Location set/)).toBeInTheDocument();
            const preview = mockCreatedMarkers.filter(m => m.opts?.className === 'custom-preview-pin').at(-1)!;
            expect(preview.coords).toEqual([-28.5544, 153.5026]);
            const map = vi.mocked(L.map).mock.results.at(-1)!.value as any;
            expect(map.setView).toHaveBeenLastCalledWith([-28.5544, 153.5026], 16, { animate: false });

            await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Approximate (~100m)' })); });
            fireEvent.change(within(panel).getByLabelText("What's happening"), { target: { value: 'Working bee' } });
            fireEvent.change(within(panel).getByLabelText('Starts'), { target: { value: '2030-09-28T09:00' } });
            await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Create Event' })); });
            await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
            expect(create.mock.calls[0][0]).toMatchObject({ lat: -28.554, lng: 153.503, eventPlaceName: 'Bindarrabi Hall' });
        });

        it('keeps a Place name the member already typed', async () => {
            const panel = await openEventForm(async () => ({ ok: true, json: async () => nominatim }));
            fireEvent.change(within(panel).getByLabelText('Place name'), { target: { value: 'The old bowls club' } });
            await search(panel, '12 main street');
            await act(async () => { fireEvent.click(within(panel).getAllByRole('option')[1]); });
            expect((within(panel).getByLabelText('Place name') as HTMLInputElement).value).toBe('The old bowls club');
            expect(within(panel).getByText(/Location set/)).toBeInTheDocument();
        });

        it('a failed search says so in one line, and dropping a pin still works', async () => {
            const panel = await openEventForm(async () => { throw new TypeError('Failed to fetch'); });
            await search(panel, 'bindarrabi hall');
            expect(within(panel).getByText(/Address search isn.t working right now/)).toBeInTheDocument();
            expect(within(panel).queryAllByRole('option')).toHaveLength(0);

            await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: /Drop a pin/ })); });
            const map = vi.mocked(L.map).mock.results.at(-1)!.value as any;
            const clickHandlers = map.on.mock.calls.filter((c: any[]) => c[0] === 'click').map((c: any[]) => c[1]);
            await act(async () => { clickHandlers.forEach((h: any) => h({ latlng: { lat: -28.55437, lng: 153.50261 } })); });
            expect(within(panel).getByText(/Location set/)).toBeInTheDocument();
        });
    });
});

describe('Copy to a new date (docs/events-on-the-map.md §3, slice 5)', () => {
    const pastEvent: any = {
        id: 'ev-past', type: 'event', category: 'community', title: 'Working bee at the hall',
        description: 'Clearing the back garden', credits: 0, priceType: 'fixed',
        authorPublicKey: 'user-alice-pubkey', authorCallsign: 'Alice', createdAt: '2026-09-01T00:00:00.000Z',
        active: true, status: 'active', repeatable: false, lat: -28.55, lng: 153.5,
        eventStartAt: '2026-09-05T23:00:00.000Z', eventEndAt: '2026-09-06T02:00:00.000Z',
        eventPlaceName: 'Bindarrabi Hall', eventPrivateNote: 'Gate code 1234', eventState: 'scheduled',
        audienceScope: 'public',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
        // The feed list has no ended event in it; the by-id read is what finds one (§2.2).
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (filter?: any) =>
            (filter?.id === 'ev-past' ? [pastEvent] : []) as any);
    });

    it('opens the event form filled from the event, with both dates blank', async () => {
        const onCopyEventHandled = vi.fn();
        let view: ReturnType<typeof render>;
        await act(async () => {
            view = render(
                <MapPage
                    identity={mockIdentity}
                    copyEventPostId="ev-past"
                    onCopyEventHandled={onCopyEventHandled}
                />
            );
        });

        await waitFor(() => expect(view!.getByTestId('map-new-post-panel')).toBeTruthy());
        const panel = view!.getByTestId('map-new-post-panel');

        expect((within(panel).getByLabelText(/What's happening/i) as HTMLInputElement).value).toBe('Working bee at the hall');
        expect((within(panel).getByLabelText(/^Description/i) as HTMLTextAreaElement).value).toBe('Clearing the back garden');
        expect((within(panel).getByLabelText(/Place name/i) as HTMLInputElement).value).toBe('Bindarrabi Hall');
        expect((within(panel).getByLabelText(/Note for people who are going/i) as HTMLTextAreaElement).value).toBe('Gate code 1234');

        // The two things the host is here to re-pick.
        expect((within(panel).getByLabelText(/^Starts/i) as HTMLInputElement).value).toBe('');
        expect((within(panel).getByLabelText(/^Ends/i) as HTMLInputElement).value).toBe('');

        // The pin came with it, and the form says what did not.
        expect(within(panel).getByTestId('event-copy-hint').textContent).toMatch(/photo is not copied/i);
        expect(api.getMarketplacePosts).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-past' }));
        expect(onCopyEventHandled).toHaveBeenCalled();
    });

    it('cannot be submitted until a date is picked — the node would refuse a past start anyway', async () => {
        let view: ReturnType<typeof render>;
        await act(async () => {
            view = render(<MapPage identity={mockIdentity} copyEventPostId="ev-past" onCopyEventHandled={vi.fn()} />);
        });
        await waitFor(() => expect(view!.getByTestId('map-new-post-panel')).toBeTruthy());
        const panel = view!.getByTestId('map-new-post-panel');
        // The pin and the title came across, so the button names the one thing still missing.
        const post = within(panel).getByRole('button', { name: /Add a title and start time/i }) as HTMLButtonElement;
        expect(post.disabled).toBe(true);
    });
});

describe('Edit event (events round 2, A1–A3, decision 29)', () => {
    // Local-time start so the datetime-local value is the same on any machine.
    const start = new Date(2030, 8, 28, 9, 0);
    const hosted: any = {
        id: 'ev-open', type: 'event', category: 'community', title: 'Working bee at the hall',
        description: 'Clearing the back garden', credits: 0, priceType: 'fixed',
        authorPublicKey: 'user-alice-pubkey', authorCallsign: 'Alice', createdAt: '2026-09-01T00:00:00.000Z',
        active: true, status: 'active', repeatable: false, lat: -28.55, lng: 153.5,
        eventStartAt: start.toISOString(), eventEndAt: new Date(start.getTime() + 3 * 3600_000).toISOString(),
        eventPlaceName: 'Bindarrabi Hall', eventPrivateNote: 'Gate code 1234', eventState: 'scheduled',
        audienceScope: 'public', photos: ['https://node/api/marketplace/posts/ev-open/photos/0?v=1'],
        eventRsvps: [{ memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' }],
    };

    function setup(byId: any) {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (filter?: any) => (filter?.id === byId.id ? [byId] : []) as any);
        vi.spyOn(api, 'updateMarketplacePost').mockResolvedValue({ success: true, post: byId });
    }

    async function openEdit(post: any, onNavigate = vi.fn()) {
        let view: ReturnType<typeof render>;
        await act(async () => {
            view = render(<MapPage identity={mockIdentity} editEventPostId={post.id} onEditEventHandled={vi.fn()} onNavigate={onNavigate} />);
        });
        return view!;
    }

    it('opens the event form titled Edit Event with EVERY field filled, dates included', async () => {
        setup(hosted);
        const view = await openEdit(hosted);
        await waitFor(() => expect(view.getByTestId('map-new-post-panel')).toBeTruthy());
        const panel = view.getByTestId('map-new-post-panel');
        expect(within(panel).getByText('Edit Event')).toBeTruthy();
        expect((within(panel).getByLabelText(/What's happening/i) as HTMLInputElement).value).toBe('Working bee at the hall');
        expect((within(panel).getByLabelText(/^Starts/i) as HTMLInputElement).value).toBe('2030-09-28T09:00');
        expect((within(panel).getByLabelText(/^Ends/i) as HTMLInputElement).value).toBe('2030-09-28T12:00');
        expect((within(panel).getByLabelText(/Place name/i) as HTMLInputElement).value).toBe('Bindarrabi Hall');
        expect((within(panel).getByLabelText(/^Description/i) as HTMLTextAreaElement).value).toBe('Clearing the back garden');
        expect((within(panel).getByLabelText(/Note for people who are going/i) as HTMLTextAreaElement).value).toBe('Gate code 1234');
        expect(within(panel).getByText('1/5 photos')).toBeTruthy();
        // Type, audience and host are what the event is; the form says so instead of offering them.
        expect(within(panel).queryByRole('button', { name: 'Offer' })).toBeNull();
        expect(within(panel).getByTestId('event-edit-fixed')).toBeTruthy();
        expect(within(panel).getByRole('button', { name: 'Save changes' })).toBeTruthy();
    });

    // Edit Event is the New Post panel under another title, so it must carry the same md+ width cap:
    // without it this form spanned a desktop screen and lay over the sidebar too.
    it('is the same panel, so it keeps the md+ width cap past the sidebar', async () => {
        setup(hosted);
        const view = await openEdit(hosted);
        await waitFor(() => expect(view.getByTestId('map-new-post-panel')).toBeTruthy());
        const classes = view.getByTestId('map-new-post-panel').className.split(/\s+/);
        expect(classes).toContain('md:left-[16.75rem]');
        expect(classes).toContain('md:right-auto');
        expect(classes).toContain('md:w-[30rem]');
    });

    it('a title edit saves only the title, with the host\'s own key — silent, so no UPDATED warning', async () => {
        setup(hosted);
        const onNavigate = vi.fn();
        const view = await openEdit(hosted, onNavigate);
        await waitFor(() => expect(view.getByTestId('map-new-post-panel')).toBeTruthy());
        const panel = view.getByTestId('map-new-post-panel');
        fireEvent.change(within(panel).getByLabelText(/What's happening/i), { target: { value: 'Working bee and lunch' } });
        expect(within(panel).queryByTestId('event-edit-notifies')).toBeNull();
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' })); });
        expect(api.updateMarketplacePost).toHaveBeenCalledWith('ev-open', 'user-alice-pubkey', { title: 'Working bee and lunch' });
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'ev-open');
    });

    it('a time change is sent, and the form warns that it will show UPDATED and tell everyone going', async () => {
        setup(hosted);
        const view = await openEdit(hosted);
        await waitFor(() => expect(view.getByTestId('map-new-post-panel')).toBeTruthy());
        const panel = view.getByTestId('map-new-post-panel');
        fireEvent.change(within(panel).getByLabelText(/^Starts/i), { target: { value: '2030-09-28T10:00' } });
        expect(within(panel).getByTestId('event-edit-notifies').textContent).toMatch(/UPDATED and everyone going will be told/);
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' })); });
        expect(api.updateMarketplacePost).toHaveBeenCalledWith('ev-open', 'user-alice-pubkey', {
            eventStartAt: new Date(2030, 8, 28, 10, 0).toISOString(),
            eventEndAt: new Date(2030, 8, 28, 12, 0).toISOString(),
        });
    });

    it('is refused for an event that has ended, and says so (A3)', async () => {
        const ended = { ...hosted, id: 'ev-ended', eventStartAt: '2020-01-01T09:00:00.000Z', eventEndAt: '2020-01-01T11:00:00.000Z' };
        setup(ended);
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        const view = await openEdit(ended);
        await waitFor(() => expect(alert).toHaveBeenCalledWith('This event has ended, so it can no longer be edited.'));
        expect(view.queryByTestId('map-new-post-panel')).toBeNull();
        alert.mockRestore();
    });

    it('is refused for a cancelled event, and says so (A3)', async () => {
        const cancelled = { ...hosted, id: 'ev-cancelled', status: 'cancelled', eventState: 'cancelled', active: false };
        setup(cancelled);
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        const view = await openEdit(cancelled);
        await waitFor(() => expect(alert).toHaveBeenCalledWith('This event was cancelled, so it can no longer be edited.'));
        expect(view.queryByTestId('map-new-post-panel')).toBeNull();
        alert.mockRestore();
    });

    it('is refused for someone the node does not treat as a host (no RSVP list in their view)', async () => {
        const notMine = { ...hosted, id: 'ev-theirs', eventRsvps: undefined };
        setup(notMine);
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        const view = await openEdit(notMine);
        await waitFor(() => expect(alert).toHaveBeenCalledWith('Only the host can edit this event.'));
        expect(view.queryByTestId('map-new-post-panel')).toBeNull();
        alert.mockRestore();
    });
});

describe('MapPage: where the map opens (no hard-coded town)', () => {
    // Mullumbimby, where the map used to open for every community that had not set its location.
    const MULLUM: [number, number] = [-28.5495, 153.5005];

    function mapInstance(i = 0): any {
        return vi.mocked(L.map).mock.results[i].value;
    }
    function mapOptions(i = 0): any {
        return (vi.mocked(L.map).mock.calls[i] as any[])[1];
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        resetSavedMapView();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([]);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    it('is created on the neutral world view, not on Mullumbimby', async () => {
        vi.spyOn(api, 'getNodeConfig').mockReturnValue(new Promise(() => {}) as any);
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        expect(mapOptions().zoom).toBe(2);
        expect(mapOptions().center).not.toEqual(MULLUM);
    });

    it('location set: frames the service radius as before, and shows no hint', async () => {
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({ serviceRadius: { lat: -37.06, lng: 144.22, radiusKm: 10 } } as any);
        const { queryByTestId } = render(<MapPage identity={mockIdentity} />);
        await waitFor(() => expect(mapInstance().fitBounds).toHaveBeenCalledTimes(1));
        expect(L.circle).toHaveBeenCalledWith([-37.06, 144.22], expect.objectContaining({ radius: 10_000 }));
        expect(mapInstance().fitBounds.mock.calls[0][0]).toEqual({ circleBoundsOf: [-37.06, 144.22], radius: 10_000 });
        await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalled());
        await act(async () => {});
        expect(queryByTestId('map-location-hint')).toBeNull();
    });

    it('location set with no radius: centres on the node point', async () => {
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({ serviceRadius: { lat: -37.06, lng: 144.22, radiusKm: 0 } } as any);
        render(<MapPage identity={mockIdentity} />);
        await waitFor(() => expect(mapInstance().setView).toHaveBeenCalledWith([-37.06, 144.22], 13));
        expect(mapInstance().fitBounds).not.toHaveBeenCalled();
    });

    it('no location, but the community has pins: fits the view to its own posts and enterprises, with no hint', async () => {
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([
            { id: 'p1', type: 'offer', category: 'general', title: 'Eggs', authorPublicKey: 'bob', lat: -8.65, lng: 115.21, status: 'active' },
            { id: 'p2', type: 'need', category: 'general', title: 'Ladder', authorPublicKey: 'cat', lat: -8.70, lng: 115.17, status: 'active' },
            { id: 'p3', type: 'offer', category: 'general', title: 'Sold', authorPublicKey: 'dan', lat: 40, lng: 40, status: 'completed' },
        ] as any);
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({
            enterprises: [
                { publicKey: 'e1', name: 'Garden', callsign: 'G', lat: -8.60, lng: 115.25, paused: false, status: 'active' },
                { publicKey: 'e2', name: 'Done', callsign: 'D', lat: 50, lng: 50, paused: false, status: 'completed' },
            ],
        } as any);
        const { queryByTestId } = render(<MapPage identity={mockIdentity} />);
        await waitFor(() => expect(mapInstance().fitBounds).toHaveBeenCalledTimes(1));
        const [points, opts] = mapInstance().fitBounds.mock.calls[0];
        // Only what is live on this community: the sold post and the finished enterprise are left out.
        expect(points).toEqual([[-8.65, 115.21], [-8.70, 115.17], [-8.60, 115.25]]);
        expect(opts).toEqual(expect.objectContaining({ maxZoom: 15 }));
        expect(mapInstance().setView).not.toHaveBeenCalled();
        expect(queryByTestId('map-location-hint')).toBeNull();
    });

    it('no location and nothing pinned: stays on the neutral view with a one-line hint', async () => {
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        const { findByTestId } = render(<MapPage identity={mockIdentity} />);
        const hint = await findByTestId('map-location-hint');
        expect(hint.textContent).toBe("This community hasn't set its location yet");
        // It takes no taps, so it never gets in the way of the map.
        expect(hint.className).toContain('pointer-events-none');
        expect(mapInstance().setView).not.toHaveBeenCalled();
        expect(mapInstance().fitBounds).not.toHaveBeenCalled();
    });

    it('a post with no coordinates gets no pin when the community has no location (it used to land in Mullumbimby)', async () => {
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([
            { id: 'nocoords', type: 'offer', category: 'general', title: 'Somewhere', authorPublicKey: 'bob', status: 'active' },
        ] as any);
        const { findByTestId } = render(<MapPage identity={mockIdentity} />);
        await findByTestId('map-location-hint');
        expect(mockCreatedMarkers).toHaveLength(0);
    });

    it('does not claim the location is missing when the config could not be fetched', async () => {
        vi.spyOn(api, 'getNodeConfig').mockRejectedValue(new Error('offline'));
        const { queryByTestId } = render(<MapPage identity={mockIdentity} />);
        await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalled());
        await act(async () => {});
        expect(queryByTestId('map-location-hint')).toBeNull();
    });

    it('centres once: coming back to the tab keeps the view the member left, and does not re-centre', async () => {
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({ serviceRadius: { lat: -37.06, lng: 144.22, radiusKm: 10 } } as any);
        const first = render(<MapPage identity={mockIdentity} />);
        await waitFor(() => expect(mapInstance(0).fitBounds).toHaveBeenCalledTimes(1));
        // The member pans and zooms somewhere else, then leaves the tab (which unmounts the page).
        mapInstance(0).getCenter.mockReturnValue({ lat: -37.5, lng: 144.9 });
        mapInstance(0).getZoom.mockReturnValue(16);
        first.unmount();

        render(<MapPage identity={mockIdentity} />);
        expect(mapOptions(1).center).toEqual([-37.5, 144.9]);
        expect(mapOptions(1).zoom).toBe(16);
        await waitFor(() => expect(L.circle).toHaveBeenCalledTimes(2));
        await act(async () => {});
        // The service radius is still drawn, but the member's view is kept.
        expect(mapInstance(1).fitBounds).not.toHaveBeenCalled();
        expect(mapInstance(1).setView).not.toHaveBeenCalled();
    });

    it('a member who leaves before the node answers is still centred next time', async () => {
        vi.spyOn(api, 'getNodeConfig').mockReturnValueOnce(new Promise(() => {}) as any);
        const first = render(<MapPage identity={mockIdentity} />);
        first.unmount();
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({ serviceRadius: { lat: -37.06, lng: 144.22, radiusKm: 10 } } as any);
        render(<MapPage identity={mockIdentity} />);
        expect(mapOptions(1).zoom).toBe(2);
        await waitFor(() => expect(mapInstance(1).fitBounds).toHaveBeenCalledTimes(1));
    });
});
