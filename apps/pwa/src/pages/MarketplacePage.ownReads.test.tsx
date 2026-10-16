/**
 * The Market and a listing read nothing of the member's where a feature is in preview (global previews audit, "Across
 * all five", P3): on the global node the page asked for the member's balance (the Offer-first gate, which holds only
 * where Beans are on) and, on opening a Need, for the member's deals, while Beans and deals there are Example
 * Valley's. In preview: never asked. A local community: asked, as before.
 */
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({ loadRadiusSettings: vi.fn(() => null), saveRadiusSettings: vi.fn(), clearRadiusSettings: vi.fn(), haversineDistance: vi.fn(() => 0) }));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', () => ({ getProfileStatus: vi.fn(async () => ({ complete: true })), describeMissing: vi.fn(() => '') }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));
// The node's /api/community/info: what the page and the feature modes read.
const info = vi.hoisted(() => ({ value: { profile: 'local', features: {} } as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/visitor-lobby-gate')>()),
    communityInfoOnce: vi.fn(async () => info.value),
}));

const identity: BeanPoolIdentity = { publicKey: 'viewer-pubkey', privateKey: 'mock-private-key-hex', callsign: 'Viewer', createdAt: '2026-09-17T00:00:00.000Z' };
const need = {
    id: 'p-need', title: 'Help moving a sofa', description: 'Saturday', type: 'need', category: 'services', credits: 0, status: 'active', active: true,
    authorPublicKey: 'member-ana', authorCallsign: 'Ana', createdAt: '2026-09-14T00:00:00Z',
};
const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([need] as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue(null as any);
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ average: 0, count: 0, ratings: [] } as any);
});
afterEach(() => { info.value = { profile: 'local', features: {} }; });

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const openNeed = async () => {
    render(<MarketplacePage identity={identity} isMember />);
    fireEvent.click(await screen.findByText('Help moving a sofa'));
    await waitFor(() => expect(api.getMemberProfile).toHaveBeenCalled());
    await settle();
};

describe("the Market and a listing: the member's own balance and deals", () => {
    it('global (Beans and deals in preview): neither is asked, opening a Need included', async () => {
        info.value = { profile: 'global', features: WORLDWIDE };
        await openNeed();
        expect(api.getBalance).not.toHaveBeenCalled();
        expect(api.getMyMarketplaceTransactions).not.toHaveBeenCalled();
    });

    it('local (live): the balance at open and the deals on opening a Need, as before', async () => {
        await openNeed();
        expect(api.getBalance).toHaveBeenCalledWith('viewer-pubkey');
        await waitFor(() => expect(api.getMyMarketplaceTransactions).toHaveBeenCalledWith('viewer-pubkey'));
    });
});

// Review of #2035, N1: where the light statuses read fails, the Market read the whole enterprise list instead. On the
// global node (enterprises a preview) that read is refused too, and there is no enterprise to hide: never asked. A local
// community whose node is older (no statuses route): asked, as before.
describe("the Market's enterprise list where the statuses read fails (review of #2035, N1)", () => {
    const refusal = (code?: string) => Object.assign(new Error('Not found'), { status: 404, ...(code ? { code } : {}) });
    const openMarket = async (statusesError: Error) => {
        vi.spyOn(api, 'getEnterpriseStatuses').mockRejectedValue(statusesError);
        render(<MarketplacePage identity={identity} isMember />);
        await screen.findByText('Help moving a sofa');
        await settle();
    };

    it('global, the statuses refused as feature_off: the list is not asked', async () => {
        info.value = { profile: 'global', features: WORLDWIDE };
        await openMarket(refusal('feature_off'));
        expect(api.getEnterpriseStatuses).toHaveBeenCalled();
        expect(api.getTreasuries).not.toHaveBeenCalled();
    });

    it('global, the statuses read failing any other way: not asked either (enterprises are a preview)', async () => {
        info.value = { profile: 'global', features: WORLDWIDE };
        await openMarket(new TypeError('Failed to fetch'));
        expect(api.getTreasuries).not.toHaveBeenCalled();
    });

    it('local, an older node with no statuses route: the list is asked, as before', async () => {
        await openMarket(refusal());
        await waitFor(() => expect(api.getTreasuries).toHaveBeenCalled());
    });
});
