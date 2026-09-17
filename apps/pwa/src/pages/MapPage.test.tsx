import { render, waitFor, act } from '@testing-library/react';
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
