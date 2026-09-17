import { render, waitFor, act, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MapPage } from './MapPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import L from 'leaflet';

vi.mock('leaflet.markercluster', () => ({}));

const mockCreatedMarkers: Array<{ coords: [number, number]; opts: any; listeners: Record<string, (...args: any[]) => any> }> = [];

vi.mock('leaflet', () => {
    const layerGroup = {
        clearLayers: vi.fn(),
        addLayer: vi.fn(),
        addTo: vi.fn().mockReturnThis(),
    };

    return {
        default: {
            map: vi.fn(() => ({
                setView: vi.fn(),
                on: vi.fn(),
                off: vi.fn(),
                remove: vi.fn(),
                getZoom: vi.fn(() => 13),
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
            circle: vi.fn(() => ({ addTo: vi.fn(), setLatLng: vi.fn(), setRadius: vi.fn() })),
            markerClusterGroup: vi.fn(() => layerGroup),
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
        expect(eventPins()[0].opts.html).toContain('📅');
        expect(eventPins()[0].opts.html).toContain('#7c3aed');
        const offerPins = mockCreatedMarkers.filter(m => m.opts?.className?.includes('custom-map-pin'));
        expect(offerPins.length).toBeGreaterThan(0);
        expect(offerPins.every(m => !String(m.opts.html).includes('📅'))).toBe(true);
    });

    it('filters event pins with Today / This weekend / Next 7 days / All, in one row', async () => {
        let view: ReturnType<typeof render> | undefined;
        await act(async () => { view = render(<MapPage identity={mockIdentity} />); });
        const chips = await view!.findByTestId('event-window-chips');
        expect(chips.className).toContain('flex-nowrap');
        expect(chips.className).toContain('overflow-x-auto');
        const buttons = Array.from(chips.querySelectorAll('button'));
        expect(buttons.map(b => b.textContent)).toEqual(['Today', 'This weekend', 'Next 7 days', '📅 All']);
        for (const b of buttons) expect(b.className).toContain('whitespace-nowrap');

        mockCreatedMarkers.length = 0;
        await act(async () => { fireEvent.click(view!.getByRole('button', { name: 'Next 7 days' })); });
        expect(eventPins().map(m => m.opts.title)).toEqual(['Event: Repair café']);
        // The chips never touch offers.
        expect(mockCreatedMarkers.some(m => m.opts?.className?.includes('custom-map-pin'))).toBe(true);

        mockCreatedMarkers.length = 0;
        await act(async () => { fireEvent.click(view!.getByRole('button', { name: '📅 All' })); });
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
        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '📅 Event' })); });

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

        await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '📅 Create Event' })); });
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
