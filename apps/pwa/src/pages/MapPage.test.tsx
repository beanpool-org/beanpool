import { render, waitFor, act, fireEvent, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MapPage, resetSavedMapView } from './MapPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import L from 'leaflet';
import { livePostChange } from '@beanpool/core';
import { routeLivePostChange, resetLivePostsForTest } from '../lib/live-posts';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { getProfileStatus } from '../lib/profile-status';

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
    loadRadiusSettings: vi.fn(() => null),
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
            // The clock as typed, for the node to resolve in the pin's zone (DESIGN-event-times §2), and this device's
            // instant beside it, which a node from before clocks reads (review of #1952, finding 4).
            eventStartLocal: '2030-09-28T09:00', eventStartAt: new Date('2030-09-28T09:00').toISOString(), audienceScope: 'public',
        });
        expect(body).not.toHaveProperty('eventEndAt');
        expect(body).not.toHaveProperty('eventEndLocal');
        expect(body).not.toHaveProperty('eventOnline');
        expect(body).not.toHaveProperty('reach');
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'ev-new');
    });

    // "Post as -> an enterprise" used to fail with "Signature validation failed": the enterprise went in the
    // body as authorPublicKey, and the node refuses any body field ending in publicKey that is not the
    // signer. It now goes through the enterprise's own route, with the enterprise in the PATH.
    describe('Post as', () => {
        const ENT = 'ent-pubkey-aaaa';
        const openAsKeeper = async () => {
            vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false, keeperOf: [ENT] } as any);
            vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [{ publicKey: ENT, name: 'Bindarrabi Hall' }] } as any);
            let view: ReturnType<typeof render> | undefined;
            await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost />); });
            const panel = await view!.findByTestId('map-new-post-panel');
            await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Event' })); });
            return panel;
        };
        const fillAndCreate = async (panel: HTMLElement) => {
            fireEvent.change(within(panel).getByLabelText("What's happening"), { target: { value: 'Working bee' } });
            fireEvent.change(within(panel).getByLabelText('Starts'), { target: { value: '2030-09-28T09:00' } });
            fireEvent.change(within(panel).getByLabelText('Place name'), { target: { value: 'The hall' } });
            await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: /Drop a pin/ })); });
            const map = vi.mocked(L.map).mock.results.at(-1)!.value as any;
            const clickHandlers = map.on.mock.calls.filter((c: any[]) => c[0] === 'click').map((c: any[]) => c[1]);
            await act(async () => { clickHandlers.forEach((h: any) => h({ latlng: { lat: -28.55, lng: 153.5 } })); });
            await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Create Event' })); });
        };

        it("an enterprise host goes to the enterprise's own route, with the enterprise never in the body", async () => {
            const entCreate = vi.spyOn(api, 'treasuryPostEvent').mockResolvedValue({ success: true, post: { id: 'ev-ent' } } as any);
            const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
            const panel = await openAsKeeper();
            await waitFor(() => expect(within(panel).getByRole('option', { name: 'Bindarrabi Hall' })).toBeInTheDocument());
            fireEvent.change(within(panel).getByLabelText('Post as'), { target: { value: `ent:${ENT}` } });
            await fillAndCreate(panel);

            await waitFor(() => expect(entCreate).toHaveBeenCalledTimes(1));
            expect(create).not.toHaveBeenCalled();
            expect(entCreate.mock.calls[0][0]).toBe(ENT);
            const body = entCreate.mock.calls[0][1];
            expect(body).toMatchObject({
                title: 'Working bee', lat: -28.55, lng: 153.5, eventPlaceName: 'The hall',
                eventStartLocal: '2030-09-28T09:00', eventStartAt: new Date('2030-09-28T09:00').toISOString(), audienceScope: 'public',
            });
            // The node refuses any body field ending in publicKey that is not the signer.
            expect(body).not.toHaveProperty('authorPublicKey');
        });

        it('a "Me" host still goes to the marketplace route, signing as the member', async () => {
            const entCreate = vi.spyOn(api, 'treasuryPostEvent').mockResolvedValue({ success: true, post: { id: 'ev-ent' } } as any);
            const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
            const panel = await openAsKeeper();
            await fillAndCreate(panel);

            await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
            expect(entCreate).not.toHaveBeenCalled();
            expect(create.mock.calls[0][0]).toMatchObject({ type: 'event', authorPublicKey: mockIdentity.publicKey });
        });

        // #1054's leftover: an enterprise event aimed at a group was refused by the node, with a message
        // about signatures. The pair can no longer be chosen at all.
        it('an enterprise host clears a group audience, and the Group button says why', async () => {
            vi.spyOn(api, 'getGroups').mockResolvedValue([
                { id: 'grp-1', name: 'Garden Crew', viewerRole: 'convenor', viewerStatus: 'active' },
            ] as any);
            const entCreate = vi.spyOn(api, 'treasuryPostEvent').mockResolvedValue({ success: true, post: { id: 'ev-ent' } } as any);
            const panel = await openAsKeeper();
            await waitFor(() => expect(within(panel).getByRole('option', { name: 'Garden Crew' })).toBeInTheDocument());

            // Aim it at the group first, then hand it to the enterprise.
            fireEvent.click(within(panel).getByRole('button', { name: /Group \(/ }));
            expect(within(panel).getByRole('button', { name: /Group \(/ })).toHaveAttribute('aria-pressed', 'true');

            await waitFor(() => expect(within(panel).getByRole('option', { name: 'Bindarrabi Hall' })).toBeInTheDocument());
            fireEvent.change(within(panel).getByLabelText('Post as'), { target: { value: `ent:${ENT}` } });

            expect(within(panel).getByRole('button', { name: /Everyone \(Public\)/ })).toHaveAttribute('aria-pressed', 'true');
            expect(within(panel).getByRole('button', { name: /Group \(/ })).toBeDisabled();
            expect(within(panel).getByTestId('event-enterprise-audience-note').textContent)
                .toBe('Bindarrabi Hall hosts for the whole community, so this event is not group-only.');

            await fillAndCreate(panel);
            await waitFor(() => expect(entCreate).toHaveBeenCalledTimes(1));
            const body = entCreate.mock.calls[0][1] as any;
            expect(body.audienceScope).toBe('public');
            expect(body).not.toHaveProperty('targetGroupId');
        });

        it('a group host still goes to the marketplace route, signing as the convenor', async () => {
            vi.spyOn(api, 'getGroups').mockResolvedValue([
                { id: 'grp-1', name: 'Garden Crew', viewerRole: 'convenor', viewerStatus: 'active' },
            ] as any);
            const entCreate = vi.spyOn(api, 'treasuryPostEvent').mockResolvedValue({ success: true, post: { id: 'ev-ent' } } as any);
            const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
            const panel = await openAsKeeper();
            await waitFor(() => expect(within(panel).getByRole('option', { name: 'Garden Crew' })).toBeInTheDocument());
            fireEvent.change(within(panel).getByLabelText('Post as'), { target: { value: 'group:grp-1' } });
            await fillAndCreate(panel);

            await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
            expect(entCreate).not.toHaveBeenCalled();
            expect(create.mock.calls[0][0]).toMatchObject({
                type: 'event', authorPublicKey: mockIdentity.publicKey, audienceScope: 'group', targetGroupId: 'grp-1',
            });
        });
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
            // Not calls[0]: with no IndexedDB (jsdom has none) the app's own unsigned reads now go out too.
            expect((globalThis.fetch as any).mock.calls.map((c: unknown[]) => c[0])).toContain(
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

    // Review of #1857, NB2: the panel rides on the offset, which carries the tour bar's height, so a fixed 60vh
    // pushed its title and ✕ off the top at 320 / 130%. It is capped by the room above the offset, under the
    // header; 60vh stays as the cap where a browser has no dvh.
    it('caps its height by the room left above the bottom bar and tour bar, so its title and ✕ stay on screen', async () => {
        setup(hosted);
        const view = await openEdit(hosted);
        await waitFor(() => expect(view.getByTestId('map-new-post-panel')).toBeTruthy());
        const classes = view.getByTestId('map-new-post-panel').className.split(/\s+/);
        expect(classes).toContain('max-h-[60vh]');
        expect(classes).toContain('supports-[height:100dvh]:max-h-[min(60vh,calc(100dvh_-_var(--bottom-nav-offset)_-_4.5rem))]');
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

// A listing the node pushed over /ws, pinned from the payload (lib/live-posts). The live feed itself is mocked
// out in this file, so the change is routed exactly as lib/sync.ts routes it.
describe('MapPage: a listing pushed over the live feed', () => {
    const pushed = {
        id: 'post-lemons', type: 'offer', category: 'food', title: 'Spare lemons', description: 'A bag', credits: 5,
        priceType: 'fixed', authorPublicKey: 'author-erin', authorCallsign: 'Erin', createdAt: '2026-09-24T01:00:00.000Z',
        updatedAt: '2026-09-24T01:00:00.000Z', active: true, status: 'active', audienceScope: 'public', repeatable: false,
        lat: -28.5495, lng: 153.5005,
    };
    const offerPins = () => mockCreatedMarkers.filter(m => m.opts?.className?.includes('custom-map-pin'));

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        resetLivePostsForTest();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([]);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    it('pins a new public offer without asking the node for the list again', async () => {
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(api.getMarketplacePosts).toHaveBeenCalled());
        await act(async () => {});
        const calls = vi.mocked(api.getMarketplacePosts).mock.calls.length;
        expect(offerPins()).toHaveLength(0);

        await act(async () => {
            expect(routeLivePostChange(livePostChange({ type: 'new_post', post: pushed })!, mockIdentity.publicKey)).toBe(true);
        });

        await waitFor(() => expect(offerPins().length).toBeGreaterThan(0));
        expect(vi.mocked(api.getMarketplacePosts).mock.calls.length).toBe(calls);
    });
});

/*
 * G9b (design G9a §7): on a node that shows visitors its listings (the global one), a member's composer says, under
 * the photos, who else will see them; and a visitor to the lobby, with no key, gets the map with nothing to post and
 * a pin card of the listing alone.
 */
describe('the global lobby on the map (G9b)', () => {
    const GLOBAL_INFO = { memberCount: 3, postCount: 1, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false } };
    const guestPost = {
        id: 'post-bread', type: 'offer', category: 'food', title: 'Sourdough loaves', description: 'Swap for eggs',
        credits: 0, priceType: 'fixed', authorPublicKey: 'hidden', authorCallsign: '', authorEnergyCycled: 5000,
        createdAt: '2026-09-17T00:00:00.000Z', active: true, status: 'active', repeatable: false,
        lat: -28.55, lng: 153.55,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        resetSavedMapView();
        resetCommunityInfoOnce();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([guestPost] as any);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    it("a member on the global node: the composer says visitors can see the listing's photos and rough area", async () => {
        const info = vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(GLOBAL_INFO as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost />); });
        const panel = await view!.findByTestId('map-new-post-panel');
        expect(await within(panel).findByTestId('composer-visitor-note'))
            .toHaveTextContent("Visitors to the global community can see this listing's photos and its rough area before they join.");
        expect(info).toHaveBeenCalledTimes(1);
    });

    it('a local node: no such note, as today', async () => {
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue({ ...GLOBAL_INFO, profile: 'local', features: { openJoin: false, guestListingsOnly: false, beans: true } } as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost />); });
        const panel = await view!.findByTestId('map-new-post-panel');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(within(panel).queryByTestId('composer-visitor-note')).toBeNull();
    });

    it('a visitor with no key: no New Post button, nothing asked about people or enterprises, and a pin card of the title and "near here"', async () => {
        const info = vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(GLOBAL_INFO as any);
        const onNavigate = vi.fn();
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={null} isMember={false} visitor onNavigate={onNavigate} />); });
        await waitFor(() => expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-map-pin'))).toBe(true));

        expect(view!.queryByRole('button', { name: 'New Post' })).toBeNull();
        for (const read of [api.getBalance, api.getReachablePeers, api.getEnterpriseMapPins, api.getEnterpriseStatuses, api.getTreasuries, api.getGroups]) {
            expect(read).not.toHaveBeenCalled();
        }
        expect(info).not.toHaveBeenCalled();

        const pin = mockCreatedMarkers.find(m => m.opts?.className?.includes('custom-map-pin'))!;
        expect(pin.coords).toEqual([-28.55, 153.55]);
        // No badge glow for a visitor, whatever the post says.
        expect(pin.opts.html).not.toContain('#fbbf24');
        act(() => { pin.listeners['click']?.(); });
        const card = await view!.findByTestId('map-preview-card');
        expect(within(card).getByTestId('map-preview-title')).toHaveTextContent('Sourdough loaves');
        expect(within(card).getByTestId('map-preview-near')).toHaveTextContent('near here');
        expect(card).not.toHaveTextContent(/0B|Elder|hidden/);
        fireEvent.click(within(card).getByRole('button', { name: 'View Details' }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-bread');
    });

    it("a visitor's pin card: the ✕ is a 44 px touch target with a focus ring, its circle small inside it (4112421737)", async () => {
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(GLOBAL_INFO as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={null} isMember={false} visitor onNavigate={vi.fn()} />); });
        await waitFor(() => expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-map-pin'))).toBe(true));
        act(() => { mockCreatedMarkers.find(m => m.opts?.className?.includes('custom-map-pin'))!.listeners['click']?.(); });
        const card = await view!.findByTestId('map-preview-card');

        const close = within(card).getByRole('button', { name: 'Close preview' });
        const classes = close.className.split(/\s+/);
        expect(classes).toEqual(expect.arrayContaining(['min-w-[44px]', 'min-h-[44px]', 'focus-visible:ring-2']));
        // Nothing that would hold the hit area under 44 px.
        expect(classes.filter(c => /^(w|h|max-w|max-h)-/.test(c))).toEqual([]);
        // The ✕ itself is still the small circle, drawn inside the larger target.
        expect(within(close).getByText('✕').className).toMatch(/\bw-7\b.*\bh-7\b|\bh-7\b.*\bw-7\b/);

        fireEvent.click(close);
        await waitFor(() => expect(view!.queryByTestId('map-preview-card')).toBeNull());
    });
});

describe("MapPage: the node's refusal in the post form (G11-e, design G11 §6)", () => {
    const LIMIT = 'While your account is new you can make 3 posts in any 24 hours. You can post again in about 5 hours. New accounts have these limits for their first 3 days, and until 3 of their posts have stayed up.';
    const MUTED = "Three of your posts were removed by the community's moderators in the last 30 days, so you can't post or send messages here until a moderator lifts this. You can still read, edit your profile and leave.";
    /** What `request` throws for a refusal: the node's `error` as the message, with its status and code. */
    const refusal = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

    beforeEach(() => {
        vi.restoreAllMocks();
        mockCreatedMarkers.length = 0;
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([]);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
        window.alert = vi.fn();
    });

    async function submitPoll(): Promise<HTMLElement> {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost />); });
        const panel = await view!.findByTestId('map-new-post-panel');
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '🗳️ Poll' })); });
        fireEvent.change(within(panel).getByPlaceholderText('What should our community decide?'), { target: { value: 'Bigger compost bays?' } });
        fireEvent.change(within(panel).getByPlaceholderText('Option 1'), { target: { value: 'Yes' } });
        fireEvent.change(within(panel).getByPlaceholderText('Option 2'), { target: { value: 'No' } });
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '🗳️ Create Poll' })); });
        return panel;
    }

    it("429 probation_limit: the node's words in the form, word for word, and the new-account card under them", async () => {
        vi.spyOn(api, 'createMarketplacePost').mockRejectedValue(refusal(429, 'probation_limit', LIMIT));
        const me = vi.spyOn(api, 'getCommunityMe').mockResolvedValue({
            publicKey: mockIdentity.publicKey,
            probation: {
                onProbation: true, exemptBecause: null, ageEndsAt: new Date(Date.now() + 50 * 3600_000).toISOString(),
                keptPosts: 0, keptPostsNeeded: 3, endsWhen: { hours: 72, keptPosts: 3 },
                limits: {
                    posts: { limit: 3, used: 3, remaining: 0, resetsAt: new Date(Date.now() + 5 * 3600_000).toISOString() },
                    photos: { limit: 5, used: 0, remaining: 5, resetsAt: null },
                    new_dm_recipients: { limit: 10, used: 0, remaining: 10, resetsAt: null },
                },
            },
            mute: { muted: false, until: null },
        });
        const panel = await submitPoll();
        const said = await within(panel).findByTestId('post-refusal');
        expect(said.textContent).toBe(LIMIT);
        expect(said).toHaveAttribute('role', 'alert');
        expect(window.alert).not.toHaveBeenCalled();
        const card = await within(panel).findByTestId('new-account-card');
        expect(me).toHaveBeenCalled();
        expect(within(card).getByTestId('new-account-limit-posts')).toHaveTextContent('0 of 3 left');
        // Still in the form: what they typed is kept for later.
        expect(within(panel).getByPlaceholderText('What should our community decide?')).toHaveValue('Bigger compost bays?');
    });

    it("403 moderation_muted: the node's words in the form, and no limits card (it isn't a limit)", async () => {
        vi.spyOn(api, 'createMarketplacePost').mockRejectedValue(refusal(403, 'moderation_muted', MUTED));
        const me = vi.spyOn(api, 'getCommunityMe');
        const panel = await submitPoll();
        const said = await within(panel).findByTestId('post-refusal');
        expect(said.textContent).toBe(MUTED);
        expect(within(panel).queryByTestId('new-account-card')).toBeNull();
        expect(me).not.toHaveBeenCalled();
        expect(window.alert).not.toHaveBeenCalled();
    });

    it('any other failure is left as it was (an alert with its message), and closing the form drops a refusal', async () => {
        const create = vi.spyOn(api, 'createMarketplacePost').mockRejectedValueOnce(new Error('Network down'));
        const panel = await submitPoll();
        expect(window.alert).toHaveBeenCalledWith('Network down');
        expect(within(panel).queryByTestId('post-refusal')).toBeNull();

        create.mockRejectedValueOnce(refusal(403, 'moderation_muted', MUTED));
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '🗳️ Create Poll' })); });
        expect(await within(panel).findByTestId('post-refusal')).toHaveTextContent(MUTED);
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Close new post' })); });
        expect(document.querySelector('[data-testid="post-refusal"]')).toBeNull();
    });
});

// A poll has no place: on a community that syncs by area it takes its author's area, and an author with none is told
// members nearby won't see it in their list, only by searching (design DESIGN-global-sync-by-area §3.4, slice S4).
describe("the poll form's note for a placeless listing (S4)", () => {
    const BY_AREA = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, nearbyListings: { radiusKm: 250, max: 500 } } };
    beforeEach(() => {
        vi.restoreAllMocks();
        resetCommunityInfoOnce();
        mockCreatedMarkers.length = 0;
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([]);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });
    afterEach(() => resetCommunityInfoOnce());

    async function openPoll(info: unknown, area: unknown) {
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(info as any);
        const me = vi.spyOn(api, 'request').mockImplementation((async (method: string, path: string) => {
            if (method === 'GET' && path === '/api/community/me') {
                if (area instanceof Error) throw area;
                return { publicKey: mockIdentity.publicKey, area };
            }
            return {};
        }) as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost />); });
        const panel = await view!.findByTestId('map-new-post-panel');
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '🗳️ Poll' })); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        return { panel, me };
    }

    it('by area, no area set: the note says so', async () => {
        const { panel } = await openPoll(BY_AREA, null);
        await waitFor(() => expect(within(panel).getByTestId('poll-placeless-note').textContent).toBe(
            "📍 You haven't set your area, so members nearby won't see this poll in their list; they can still find it by searching. Set it in Settings → Your area to show it near you."));
    });

    it('by area with an area: the note says the poll is shown at that area (review B1)', async () => {
        const { panel } = await openPoll(BY_AREA, { lat: -28.6, lng: 153.6 });
        await waitFor(() => expect(within(panel).getByTestId('poll-placeless-note').textContent).toBe(
            '📍 This poll is shown at your area (about 10 km around it) to everyone who can read it.'));
    });

    it('by area, a node that cannot be asked: no note', async () => {
        const { panel } = await openPoll(BY_AREA, new Error('offline'));
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
        expect(within(panel).queryByTestId('poll-placeless-note')).toBeNull();
    });

    it('a local community: no note, and the member is never asked for an area', async () => {
        const { panel, me } = await openPoll({ ...BY_AREA, profile: 'local', features: { openJoin: false } }, null);
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
        expect(within(panel).queryByTestId('poll-placeless-note')).toBeNull();
        expect(me).not.toHaveBeenCalledWith('GET', '/api/community/me');
    });
});

// The web Map on a node that reads by area (DESIGN-global-sync-by-area §5, S5): the nearest 200 within the Market's
// distance setting, else within the node's radius of the member's stored area; a local node reads as before.
describe('MapPage: where the pins are read from (S5)', () => {
    const post = {
        id: 'post-eggs', type: 'offer', category: 'food', title: 'A dozen eggs', description: 'Fresh',
        credits: 12, priceType: 'fixed', authorPublicKey: 'author-pk', authorCallsign: 'Bob',
        createdAt: '2026-09-17T00:00:00.000Z', active: true, status: 'active', repeatable: true,
        lat: -28.5495, lng: 153.5005,
    };
    const NEARBY = { radiusKm: 250, max: 500 };
    const TYPES = 'offer,need,poll,event';
    // The read for online events beside a radius read (DESIGN-event-times §9) is its own: `onlineReads`.
    const listReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !f?.author && !f?.id && !f?.online);
    const onlineReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !!f?.online);
    const ownReads = () => vi.mocked(api.getMarketplacePosts).mock.calls.map(([f]) => f).filter(f => !!f?.author);

    beforeEach(async () => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        resetCommunityInfoOnce();
        const geo = await import('../lib/geo');
        vi.mocked(geo.loadRadiusSettings).mockReturnValue(null);
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f) => (f?.author ? [] : [post]) as any);
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue({ profile: 'global', features: { nearbyListings: NEARBY } } as any);
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: mockIdentity.publicKey, area: { lat: -28.5, lng: 153.5 } } as any);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    it('on a by-area node, reads the nearest 200 within the node\'s radius of the member\'s area, once, and the viewer\'s own anywhere', async () => {
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(listReads().length).toBe(1));
        expect(listReads()).toEqual([{ types: TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance', limit: 200 }]);
        expect(ownReads()).toEqual([{ types: TYPES, author: mockIdentity.publicKey, limit: 200 }]);
        // Online events have no place, so the radius read never meets them: read beside it, wherever they are.
        expect(onlineReads()).toEqual([{ types: TYPES, online: true, limit: 200 }]);
    });

    it('the Market\'s distance setting wins over the area', async () => {
        const geo = await import('../lib/geo');
        vi.mocked(geo.loadRadiusSettings).mockReturnValue({ lat: -37.1, lng: 144.2, radiusKm: 30, label: 'Castlemaine' });
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(listReads().length).toBe(1));
        expect(listReads()).toEqual([{ types: TYPES, lat: -37.1, lng: 144.2, radiusKm: 30, sort: 'distance', limit: 200 }]);
    });

    it('a member with no area reads as before', async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue({ publicKey: mockIdentity.publicKey, area: null } as any);
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(listReads().length).toBe(1));
        expect(listReads()).toEqual([{ types: TYPES }]);
        expect(ownReads()).toEqual([]);
    });

    it('a local node reads exactly as before and asks for no area', async () => {
        vi.mocked(api.getCommunityInfo).mockResolvedValue({ profile: 'local', features: { beans: true } } as any);
        const geo = await import('../lib/geo');
        vi.mocked(geo.loadRadiusSettings).mockReturnValue({ lat: -37.1, lng: 144.2, radiusKm: 30, label: 'Castlemaine' });
        await act(async () => { render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(listReads().length).toBe(1));
        expect(listReads()).toEqual([{ types: TYPES }]);
        expect(ownReads()).toEqual([]);
        expect(api.getCommunityMe).not.toHaveBeenCalled();
        expect(onlineReads()).toEqual([]);
    });

    it('nothing near the area is never a dead end: Show everywhere reads the newest', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.lat != null || f?.author || f?.online ? [] : [post]) as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        const note = await view!.findByTestId('map-near-empty');
        expect(note).toHaveTextContent('Nothing within 250 km of your area yet.');
        fireEvent.click(within(note).getByRole('button', { name: 'Show everywhere' }));
        await waitFor(() => expect(listReads().at(-1)).toEqual({ types: TYPES }));
        await waitFor(() => expect(view!.queryByTestId('map-near-empty')).toBeNull());
    });

    it('after Show everywhere, Near your area reads from the area again', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.lat != null || f?.author || f?.online ? [] : [post]) as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        const note = await view!.findByTestId('map-near-empty');
        fireEvent.click(within(note).getByRole('button', { name: 'Show everywhere' }));
        await waitFor(() => expect(listReads().at(-1)).toEqual({ types: TYPES }));
        const back = await view!.findByTestId('map-near-again');
        fireEvent.click(within(back).getByRole('button', { name: 'Near your area' }));
        await waitFor(() => expect(listReads().at(-1)).toMatchObject({ types: TYPES, radiusKm: 250, sort: 'distance', limit: 200 }));
        await waitFor(() => expect(view!.queryByTestId('map-near-again')).toBeNull());
    });

    // #1770: the event chips sat over the note (same spot, same layer, later in the page), so Near your area could not be
    // tapped whenever the newest from everywhere held an upcoming event. jsdom has no layout; e2e/market-near-check.mjs
    // makes the real tap.
    it('online events never pin, so with only those and nothing near, the map still says nothing is near (DESIGN-event-times §9)', async () => {
        const online = {
            ...post, id: 'ev-online', type: 'event', category: 'community', title: 'Vibe coding', credits: 0, repeatable: false, lat: undefined, lng: undefined,
            eventStartAt: new Date(Date.now() + 48 * 3600_000).toISOString(), eventState: 'scheduled', eventOnline: true,
        };
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.online ? [online] : []) as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(onlineReads().length).toBe(1));
        expect(await view!.findByTestId('map-near-empty')).toHaveTextContent('Nothing within 250 km of your area yet.');
        expect(mockCreatedMarkers.filter(m => m.opts?.className?.includes('custom-event-pin'))).toEqual([]);
    });

    it('after Show everywhere with an upcoming event loaded, the note sits under the event chips', async () => {
        const event = {
            ...post, id: 'ev-seed', type: 'event', category: 'community', title: 'Seed swap', credits: 0, repeatable: false,
            eventStartAt: new Date(Date.now() + 48 * 3600_000).toISOString(), eventState: 'scheduled', goingCount: 0, interestedCount: 0, myRsvp: null,
        };
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.lat != null || f?.author || f?.online ? [] : [post, event]) as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        const note = await view!.findByTestId('map-near-empty');
        expect(note.className).toContain('top-[4.25rem]');
        fireEvent.click(within(note).getByRole('button', { name: 'Show everywhere' }));
        await view!.findByTestId('event-window-chips');
        const back = await view!.findByTestId('map-near-again');
        expect(back.className).toContain('top-[calc(5rem+48px)]');
        expect(back.className).toContain('md:top-[calc(1.5rem+48px)]');
        expect(back.className).not.toContain('top-[4.25rem]');
    });

    it('a failed read of the member\'s area says so on the Map, with Try again, as the Market does', async () => {
        vi.mocked(api.getCommunityMe).mockRejectedValueOnce(new Error('503'));
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        const note = await view!.findByTestId('map-area-failed');
        expect(note).toHaveTextContent("Couldn't check your area just now, so this is the newest from everywhere.");
        expect(listReads()).toEqual([{ types: TYPES }]);
        fireEvent.click(within(note).getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(api.getCommunityMe).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(listReads().at(-1)).toEqual({ types: TYPES, lat: -28.5, lng: 153.5, radiusKm: 250, sort: 'distance', limit: 200 }));
        await waitFor(() => expect(view!.queryByTestId('map-area-failed')).toBeNull());
    });

    it('a failed read of the area says nothing when the Market\'s distance setting picks the place anyway', async () => {
        const geo = await import('../lib/geo');
        vi.mocked(geo.loadRadiusSettings).mockReturnValue({ lat: -37.1, lng: 144.2, radiusKm: 30, label: 'Castlemaine' });
        vi.mocked(api.getCommunityMe).mockRejectedValueOnce(new Error('503'));
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        await waitFor(() => expect(listReads().length).toBe(1));
        expect(listReads()).toEqual([{ types: TYPES, lat: -37.1, lng: 144.2, radiusKm: 30, sort: 'distance', limit: 200 }]);
        expect(view!.queryByTestId('map-area-failed')).toBeNull();
    });
});

/*
 * A newcomer's first post where Beans are off (rehearsal 2026-10-14 B4; global review M2): no "Contributions First"
 * notice, no "List an Offer first" button, and a Need's photo is optional. A local community keeps all three, even when
 * an older node still says the member is blocked.
 */
describe('a Need where Beans are off (B4/M2)', () => {
    const info = (beans: boolean) => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: beans ? 'local' : 'global', features: { openJoin: !beans, guestListingsOnly: !beans, beans } });

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        resetSavedMapView();
        resetCommunityInfoOnce();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([] as any);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        // As a node from before this change answers: blocked until an Offer is listed.
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: true } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    async function openNeed(beans: boolean) {
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(info(beans) as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost />); });
        const panel = await view!.findByTestId('map-new-post-panel');
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '🟠 Need' })); });
        return panel;
    }

    it('Beans off (the global node): no Contributions First notice, no "List an Offer first", and the photo is optional', async () => {
        const panel = await openNeed(false);
        expect(within(panel).queryByText(/Contributions First/)).toBeNull();
        expect(within(panel).queryByText(/ask an Elder/)).toBeNull();
        expect(within(panel).queryByText(/List an Offer first/)).toBeNull();
        expect(within(panel).getByText(/0\/5 photos/)).toHaveTextContent('(optional)');
    });

    it('Beans on (a local community): the notice, the button and the photo rule stay', async () => {
        const panel = await openNeed(true);
        expect(within(panel).getByText(/Contributions First/)).toBeInTheDocument();
        expect(within(panel).getByText(/List an Offer first to post Needs/)).toBeInTheDocument();
        expect(within(panel).getByText(/0\/5 photos/)).toHaveTextContent('(at least 1 required)');
    });
});

/*
 * Sending a Need from the global node's real form (review #1936 N2/N3): `showcase` marks Beans, so there is no price box,
 * and a Need with no photo goes up free, even from a member an older node still calls blocked. A local community keeps
 * Offer first and the photo. The button's rule is lib/offer-need-submit (#1933): a call that left out `photoRequired`
 * would ask for the photo on global again.
 */
describe('sending a Need where Beans are off (review #1936 N3)', () => {
    const info = (beans: boolean) => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: beans ? 'local' : 'global', features: beans ? { beans } : { openJoin: true, guestListingsOnly: true, beans, showcase: true } });

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        resetSavedMapView();
        resetCommunityInfoOnce();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([] as any);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    /** A Need with a title, a description and a pin, and no photo; the price too where there is a box. */
    async function fillNeed(beans: boolean, blocked: boolean) {
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(info(beans) as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: blocked } as any);
        const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'n1' } } as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost />); });
        const panel = await view!.findByTestId('map-new-post-panel');
        await act(async () => { await new Promise(r => setTimeout(r, 30)); });
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '🟠 Need' })); });
        fireEvent.change(within(panel).getByPlaceholderText('What do you need/offer?'), { target: { value: 'Help moving a couch' } });
        fireEvent.change(within(panel).getByPlaceholderText('Describe what you need/offer...'), { target: { value: 'Saturday morning' } });
        if (beans) fireEvent.change(within(panel).getByPlaceholderText('B'), { target: { value: '5' } });
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: /Drop a pin/ })); });
        const map = vi.mocked(L.map).mock.results.at(-1)!.value as any;
        const clicks = map.on.mock.calls.filter((c: any[]) => c[0] === 'click').map((c: any[]) => c[1]);
        await act(async () => { clicks.forEach((h: any) => h({ latlng: { lat: -28.55437, lng: 153.50261 } })); });
        const approx = within(panel).queryByRole('button', { name: 'Approximate (~100m)' });
        if (approx) await act(async () => { fireEvent.click(approx); });
        return { panel, create };
    }

    it('Beans off (global, no price box): a Need with no photo says "Post Need", is enabled, and goes up free', async () => {
        const { panel, create } = await fillNeed(false, true);
        expect(within(panel).queryByPlaceholderText('B')).toBeNull();
        const send = within(panel).getByRole('button', { name: 'Post Need' });
        expect(send).toBeEnabled();
        await act(async () => { fireEvent.click(send); });
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        const body = create.mock.calls[0][0] as any;
        expect(body.type).toBe('need');
        expect(body.credits).toBe(0);
        expect(body.photos ?? []).toHaveLength(0);
    });

    it('Beans on: a member the node calls blocked is asked for an Offer first, and nothing is sent', async () => {
        const { panel, create } = await fillNeed(true, true);
        const send = within(panel).getByRole('button', { name: '🔵 List an Offer first to post Needs' });
        expect(send).toBeDisabled();
        await act(async () => { fireEvent.click(send); });
        expect(create).not.toHaveBeenCalled();
    });

    it('Beans on: a Need with a price and no photo stays disabled until a photo is added', async () => {
        const { panel, create } = await fillNeed(true, false);
        expect(within(panel).getByText(/0\/5 photos/)).toHaveTextContent('(at least 1 required)');
        const send = within(panel).getByRole('button', { name: 'Post Need' });
        expect(send).toBeDisabled();
        await act(async () => { fireEvent.click(send); });
        expect(create).not.toHaveBeenCalled();
    });
});

/*
 * The post form opened from another tab (review #1936 N1): the Market's "+", Home's first steps or a group's "post
 * here" mount the map with openNewPost, and App clears it at once. The photo rule must come from the node's info, which
 * has not reached this first render yet; a member with no photo on the global node gets the form, not the photo gate.
 */
describe('the post form opened from another tab (review #1936 N1)', () => {
    const info = (beans: boolean) => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: beans ? 'local' : 'global', features: beans ? { beans } : { openJoin: true, guestListingsOnly: true, beans, showcase: true } });
    const gate = /likes to know who they're dealing with/;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        resetSavedMapView();
        resetCommunityInfoOnce();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([] as any);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
    });

    /** As App mounts it from another tab: openNewPost, cleared as soon as the map says it has it. A member with no photo. */
    async function openFromAnotherTab(beans: boolean) {
        vi.mocked(getProfileStatus).mockResolvedValueOnce({ complete: false, missingName: false, missingAvatar: true });
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue(info(beans) as any);
        function Host() {
            const [open, setOpen] = React.useState(true);
            return <MapPage identity={mockIdentity} openNewPost={open} onOpenNewPostHandled={() => setOpen(false)} />;
        }
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<Host />); });
        return view!;
    }

    it('Beans off (global): the form opens for a member with no photo, with no photo gate', async () => {
        const view = await openFromAnotherTab(false);
        expect(await view.findByTestId('map-new-post-panel')).toBeInTheDocument();
        expect(view.queryByText(gate)).toBeNull();
    });

    it('Beans on: the same member is asked for a photo first, and the form stays shut', async () => {
        const view = await openFromAnotherTab(true);
        expect(await view.findByText(gate)).toBeInTheDocument();
        expect(view.queryByTestId('map-new-post-panel')).toBeNull();
    });
});

describe('Event times in the form (DESIGN-event-times §3, slice 2)', () => {
    const savedTz = process.env.TZ;
    const LAGOS = { tz: 'Africa/Lagos', label: 'Lagos time', offsetMinutes: 60 };
    const ACCRA = { tz: 'Africa/Accra', label: 'Accra time', offsetMinutes: 0 };
    const SYDNEY = { tz: 'Australia/Sydney', label: 'Sydney time', offsetMinutes: 660 };

    beforeEach(() => {
        // The host's device is in Sydney.
        process.env.TZ = 'Australia/Sydney';
        vi.clearAllMocks();
        mockCreatedMarkers.length = 0;
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([] as any);
        vi.spyOn(api, 'getEnterpriseStatuses').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        vi.spyOn(api, 'getReachablePeers').mockResolvedValue({ peers: [] });
        vi.spyOn(api, 'getEnterpriseMapPins').mockResolvedValue({ enterprises: [] });
        vi.spyOn(api, 'getEventZones').mockResolvedValue({ zones: [SYDNEY, LAGOS, ACCRA] });
        // A node that carries online events (features.onlineEvents, review of #1952 finding 5).
        resetCommunityInfoOnce();
        vi.spyOn(api, 'getCommunityInfo').mockResolvedValue({ profile: 'local', features: { beans: true, onlineEvents: true } } as any);
    });
    afterEach(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

    async function openEventForm() {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} openNewPost onNavigate={vi.fn()} />); });
        const panel = await view!.findByTestId('map-new-post-panel');
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Event' })); });
        fireEvent.change(within(panel).getByLabelText("What's happening"), { target: { value: 'Working bee' } });
        fireEvent.change(within(panel).getByLabelText('Starts'), { target: { value: '2030-10-19T20:50' } });
        return panel;
    }

    async function dropPin(panel: HTMLElement, lat: number, lng: number) {
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: /Drop a pin/ })); });
        const mapResults = vi.mocked(L.map).mock.results;
        const map = mapResults[mapResults.length - 1].value as any;
        const clickHandlers = map.on.mock.calls.filter((c: any[]) => c[0] === 'click').map((c: any[]) => c[1]);
        await act(async () => { clickHandlers.forEach((h: any) => h({ latlng: { lat, lng } })); });
    }

    it('in person, a pin in another zone: the line names it, and the typed clock goes with that zone', async () => {
        const zoneOf = vi.spyOn(api, 'getEventZone').mockResolvedValue(LAGOS);
        const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
        const panel = await openEventForm();
        expect(within(panel).queryByTestId('event-zone-line')).toBeNull();
        await dropPin(panel, 6.5244, 3.3792);
        await waitFor(() => expect(zoneOf).toHaveBeenCalledWith(6.5244, 3.3792));
        await waitFor(() => expect(within(panel).getByTestId('event-zone-line').textContent).toBe('Times are Lagos time (where the pin is) · Change'));

        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Create Event' })); });
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        const body = create.mock.calls[0][0];
        expect(body).toMatchObject({ lat: 6.5244, lng: 3.3792, eventStartLocal: '2030-10-19T20:50', eventTz: 'Africa/Lagos' });
        // This device's reading beside it (a node from before clocks reads only that); a node with clocks reads the clock.
        expect(body).toHaveProperty('eventStartAt', new Date('2030-10-19T20:50').toISOString());
        expect(body).not.toHaveProperty('eventOnline');
    });

    it("in person, a pin in this device's zone: nothing new on the form", async () => {
        vi.spyOn(api, 'getEventZone').mockResolvedValue(SYDNEY);
        const panel = await openEventForm();
        await dropPin(panel, -33.86, 151.2);
        await waitFor(() => expect(api.getEventZone).toHaveBeenCalled());
        await act(async () => { await Promise.resolve(); });
        expect(within(panel).queryByTestId('event-zone-line')).toBeNull();
    });

    it('online: no pin and no place; a link only Going sees; the zone is the device\'s and says so', async () => {
        const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
        const panel = await openEventForm();
        const where = within(panel).getByTestId('event-where');
        expect(within(where).getByRole('radio', { name: /At a place/ }).getAttribute('aria-checked')).toBe('true');
        await act(async () => { fireEvent.click(within(where).getByRole('radio', { name: /Online/ })); });
        expect(within(where).getByRole('radio', { name: /Online/ }).getAttribute('aria-checked')).toBe('true');

        expect(within(panel).queryByLabelText('Place name')).toBeNull();
        expect(within(panel).queryByRole('button', { name: /Drop a pin/ })).toBeNull();
        expect(within(panel).queryByTestId('event-location-visibility')).toBeNull();
        expect(within(panel).getByText('Only people who tap Going see it.')).toBeInTheDocument();
        expect(within(panel).getByTestId('event-zone-line').textContent).toBe('Times are Sydney time (your device) · Change');

        fireEvent.change(within(panel).getByLabelText('Link to join'), { target: { value: ' https://meet.example/abc ' } });
        const button = within(panel).getByRole('button', { name: 'Create Event' }) as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        await act(async () => { fireEvent.click(button); });
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        const body = create.mock.calls[0][0];
        expect(body).toMatchObject({
            eventOnline: true, eventLink: 'https://meet.example/abc', eventStartLocal: '2030-10-19T20:50', eventTz: 'Australia/Sydney',
        });
        for (const key of ['lat', 'lng', 'eventPlaceName']) expect(body).not.toHaveProperty(key);
        expect(body).toHaveProperty('eventStartAt', new Date('2030-10-19T20:50').toISOString());
    });

    it('offers Online only where the node carries online events (features.onlineEvents)', async () => {
        const panel = await openEventForm();
        await waitFor(() => expect(within(panel).getByTestId('event-where')).toBeInTheDocument());
        cleanup();
        resetCommunityInfoOnce();
        // A node from before online events says nothing of them: no Where choice, an in-person event as before.
        vi.mocked(api.getCommunityInfo).mockResolvedValue({ profile: 'local', features: { beans: true } } as any);
        const older = await openEventForm();
        await act(async () => { await Promise.resolve(); });
        expect(within(older).queryByTestId('event-where')).toBeNull();
        expect(within(older).queryByRole('radio', { name: /Online/ })).toBeNull();
        expect(within(older).getByLabelText('Place name')).toBeInTheDocument();
    });

    it('refuses a link that is not http(s), in words, before sending', async () => {
        const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
        const panel = await openEventForm();
        await act(async () => { fireEvent.click(within(panel).getByRole('radio', { name: /Online/ })); });
        fireEvent.change(within(panel).getByLabelText('Link to join'), { target: { value: 'javascript:alert(1)' } });
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Create Event' })); });
        expect(create).not.toHaveBeenCalled();
        expect(within(panel).getByText('The link to join must start with https:// or http://')).toBeInTheDocument();
    });

    it("Change opens the node's list, \"Lagos (UTC+1)\"; a picked zone is shown and sent", async () => {
        vi.spyOn(api, 'getEventZone').mockResolvedValue(LAGOS);
        const create = vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({ success: true, post: { id: 'ev-new' } } as any);
        const panel = await openEventForm();
        await dropPin(panel, 6.5244, 3.3792);
        await waitFor(() => expect(within(panel).getByTestId('event-zone-line')).toBeInTheDocument());
        await act(async () => { fireEvent.click(within(panel).getByTestId('event-zone-change')); });
        const select = await within(panel).findByTestId('event-zone-select') as HTMLSelectElement;
        expect(Array.from(select.options).map(o => o.textContent)).toEqual(['Accra (UTC)', 'Lagos (UTC+1)', 'Sydney (UTC+11)']);
        await act(async () => { fireEvent.change(select, { target: { value: 'Africa/Accra' } }); });
        expect(within(panel).getByTestId('event-zone-line').textContent).toBe('Times are Accra time · Change');

        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Create Event' })); });
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0][0]).toMatchObject({ eventStartLocal: '2030-10-19T20:50', eventTz: 'Africa/Accra' });
    });

    it('says what the node did with a clock in a DST gap, once the event is saved', async () => {
        vi.spyOn(api, 'getEventZone').mockResolvedValue(SYDNEY);
        vi.spyOn(api, 'createMarketplacePost').mockResolvedValue({
            success: true,
            post: { id: 'ev-new', eventTz: 'Australia/Sydney', eventStartLocal: '2030-10-06T03:30', eventStartAt: '2030-10-05T16:30:00.000Z' },
            eventTimeAdjusted: { start: { kind: 'gap', asked: '2030-10-06T02:30', saved: '2030-10-06T03:30' }, end: null },
        } as any);
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        const panel = await openEventForm();
        fireEvent.change(within(panel).getByLabelText('Starts'), { target: { value: '2030-10-06T02:30' } });
        await dropPin(panel, -33.86, 151.2);
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Create Event' })); });
        await waitFor(() => expect(alert).toHaveBeenCalledWith('2:30 does not exist on 6 Oct in Sydney (clocks go forward). It was saved as 3:30.'));
        alert.mockRestore();
    });

    it('editing an event that is already online keeps the Where choice, even on a node that does not say onlineEvents', async () => {
        resetCommunityInfoOnce();
        vi.mocked(api.getCommunityInfo).mockResolvedValue({ profile: 'local', features: { beans: true } } as any);
        const hosted: any = {
            id: 'ev-online', type: 'event', category: 'community', title: 'Vibe coding', description: '', credits: 0, priceType: 'fixed',
            authorPublicKey: mockIdentity.publicKey, authorCallsign: 'Alice', createdAt: '2026-09-01T00:00:00.000Z', active: true,
            status: 'active', repeatable: false, eventState: 'scheduled', eventOnline: true, eventLink: 'https://meet.example/a',
            eventStartAt: '2030-10-19T09:50:00.000Z', eventEndAt: '2030-10-19T11:50:00.000Z',
            eventStartLocal: '2030-10-19T20:50', eventEndLocal: '2030-10-19T22:50', eventTz: 'Australia/Sydney',
            audienceScope: 'public', photos: [], eventRsvps: [],
        };
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (filter?: any) => (filter?.id === hosted.id ? [hosted] : []) as any);
        let view: ReturnType<typeof render> | undefined;
        await act(async () => {
            view = render(<MapPage identity={mockIdentity} editEventPostId={hosted.id} onEditEventHandled={vi.fn()} onNavigate={vi.fn()} />);
        });
        const panel = await view!.findByTestId('map-new-post-panel');
        expect(within(panel).getByRole('radio', { name: /Online/ }).getAttribute('aria-checked')).toBe('true');
        expect((within(panel).getByLabelText('Link to join') as HTMLInputElement).value).toBe('https://meet.example/a');
    });

    it("editing an event with a stored clock shows the place's clock and sends the clock, not an instant", async () => {
        const hosted: any = {
            id: 'ev-lagos', type: 'event', category: 'community', title: 'Working bee', description: '', credits: 0, priceType: 'fixed',
            authorPublicKey: mockIdentity.publicKey, authorCallsign: 'Alice', createdAt: '2026-09-01T00:00:00.000Z', active: true,
            status: 'active', repeatable: false, lat: 6.5244, lng: 3.3792, eventPlaceName: 'The hall', eventState: 'scheduled',
            eventStartAt: '2030-10-19T19:50:00.000Z', eventEndAt: '2030-10-19T21:50:00.000Z',
            eventStartLocal: '2030-10-19T20:50', eventEndLocal: '2030-10-19T22:50', eventTz: 'Africa/Lagos', eventOnline: false,
            audienceScope: 'public', photos: [], eventRsvps: [],
        };
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (filter?: any) => (filter?.id === hosted.id ? [hosted] : []) as any);
        vi.spyOn(api, 'getEventZone').mockResolvedValue(LAGOS);
        const update = vi.spyOn(api, 'updateMarketplacePost').mockResolvedValue({ success: true, post: hosted });
        let view: ReturnType<typeof render> | undefined;
        await act(async () => {
            view = render(<MapPage identity={mockIdentity} editEventPostId={hosted.id} onEditEventHandled={vi.fn()} onNavigate={vi.fn()} />);
        });
        const panel = await view!.findByTestId('map-new-post-panel');
        expect((within(panel).getByLabelText(/^Starts/i) as HTMLInputElement).value).toBe('2030-10-19T20:50');
        expect((within(panel).getByLabelText(/^Ends/i) as HTMLInputElement).value).toBe('2030-10-19T22:50');
        expect(within(panel).getByTestId('event-zone-line').textContent).toBe('Times are Lagos time · Change');
        // The form opened on the event's own pin: its stored zone is not looked up again.
        expect(api.getEventZone).not.toHaveBeenCalled();

        fireEvent.change(within(panel).getByLabelText(/^Starts/i), { target: { value: '2030-10-19T21:00' } });
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' })); });
        expect(update).toHaveBeenCalledWith('ev-lagos', mockIdentity.publicKey, { eventStartLocal: '2030-10-19T21:00', eventEndLocal: '2030-10-19T22:50' });
    });
});
