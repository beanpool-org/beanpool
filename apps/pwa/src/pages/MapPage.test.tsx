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
});
