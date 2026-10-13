// The web Market's faces on a community where people are asked for, not read whole (features.membersOnDemand, design
// DESIGN-global-members-by-area slice M3): each card's face is the one its listing carries (authorAvatarUrl) and the
// member directory is never read for it. A community without the switch reads the directory for faces, as before.
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { loadRadiusSettings } from '../lib/geo';

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
const GLOBAL = { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 }, membersOnDemand: true } };
const LOCAL = { profile: 'local', features: { beans: true } };
const AREA = { lat: -28.5, lng: 153.5, updatedAt: '2026-10-01T00:00:00Z' };


const ROW_FACE = '/api/avatar/member-ada?size=thumb&v=row';
const DIRECTORY_FACE = '/api/avatar/member-ada?v=directory';
const faces = () => [...document.querySelectorAll('img')].map(i => i.getAttribute('src')).filter(s => s?.startsWith('/api/avatar/'));

describe('MarketplacePage: authors\' faces (members on demand, M3)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(loadRadiusSettings).mockReturnValue(null);
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f) => (f?.author ? [] : [{ ...offer, authorAvatarUrl: ROW_FACE }]) as any);
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: 'member-me', area: AREA } as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([
            { publicKey: 'member-ada', callsign: 'Ada', joinedAt: '2026-01-01', invitedBy: '', inviteCode: '', avatarUrl: DIRECTORY_FACE },
        ]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('with the switch: the face the listing carries, and no read of the member directory', async () => {
        info.current = GLOBAL;
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        await waitFor(() => expect(faces()).toContain(ROW_FACE));
        expect(faces()).not.toContain(DIRECTORY_FACE);
        expect(api.getMembers).not.toHaveBeenCalled();
    });

    it('a listing with no face carried shows the initial, never a stale directory face', async () => {
        info.current = GLOBAL;
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (f) => (f?.author ? [] : [{ ...offer, authorAvatarUrl: null }]) as any);
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        expect(faces()).toEqual([]);
        expect(api.getMembers).not.toHaveBeenCalled();
    });

    it('without the switch: the directory is read once for faces, as before', async () => {
        info.current = LOCAL;
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        await waitFor(() => expect(faces()).toContain(DIRECTORY_FACE));
        expect(api.getMembers).toHaveBeenCalledTimes(1);
    });
});

describe('MarketplacePage on global with previews AND members on demand (where #1853 meets #1861)', () => {
    // The worldwide community as it answers: every showcase feature off, previews on, people asked for, not read whole.
    const GLOBAL_SHOWCASE = {
        profile: 'global',
        features: { ...GLOBAL.features, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true },
    };
    const fetchSpy = vi.fn(async (..._args: unknown[]): Promise<Response> => { throw new TypeError('offline'); });
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.stubGlobal('fetch', fetchSpy);
        fetchSpy.mockClear();
        vi.mocked(loadRadiusSettings).mockReturnValue(null);
        vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (f) => (f?.author ? [] : [{ ...offer, authorAvatarUrl: ROW_FACE }]) as any);
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ publicKey: 'member-me', area: AREA } as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([
            { publicKey: 'member-ada', callsign: 'Ada', joinedAt: '2026-01-01', invitedBy: '', inviteCode: '', avatarUrl: DIRECTORY_FACE },
        ]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
        info.current = GLOBAL_SHOWCASE;
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('the row face and no directory read; My Deals draws the sample deals; no press sends a sample id', async () => {
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Bicycle Repair');
        await waitFor(() => expect(faces()).toContain(ROW_FACE));
        fireEvent.click(screen.getByRole('button', { name: /My Deals/ }));
        const deals = await screen.findByTestId('deals-preview');
        fireEvent.click(within(deals).getByRole('button', { name: /Approve and release/ }));
        const sheet = await screen.findByTestId('local-community-sheet');
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(faces()).not.toContain(DIRECTORY_FACE);
        expect(api.getMembers).not.toHaveBeenCalled();
        // Every call the page made, to the node's api or to fetch: none names a sample id, and nothing was written.
        const calls = [...(Object.values(api) as unknown[]).filter(vi.isMockFunction).flatMap(f => f.mock.calls), ...fetchSpy.mock.calls];
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.map(c => JSON.stringify(c)).filter(s => /\bsample-[a-z0-9]/.test(s))).toEqual([]);
        expect(fetchSpy.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET')).toEqual([]);
    });
});
