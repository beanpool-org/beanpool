import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

// The global-previews audit (part a, item 7): "🌱 New members" picks authors with no trade yet. On a node where Beans
// are marked (the worldwide one: off, or a preview) nobody trades, so it matched everyone: no chip there, and no filter.
// A local community keeps it, as before.

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
const posts = [
    { id: 'p-new', title: 'Bicycle Repair', description: 'Fix gears', type: 'offer', category: 'services', credits: 0, status: 'active', active: true,
        authorPublicKey: 'member-david', authorCallsign: 'David', createdAt: '2026-09-15T00:00:00Z', authorFoundingNeeded: true },
    { id: 'p-old', title: 'Sourdough starter', description: 'A jar', type: 'offer', category: 'food', credits: 0, status: 'active', active: true,
        authorPublicKey: 'member-ana', authorCallsign: 'Ana', createdAt: '2026-09-14T00:00:00Z', authorFoundingNeeded: false },
];

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(posts as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
});
afterEach(() => { info.value = { profile: 'local', features: {} }; });

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });

describe('MarketplacePage: the "New members" chip', () => {
    // The chip follows the cards' own test (MarketplaceCard's `beansMarked`, #2022): Beans marked, as global ships.
    for (const [name, features] of [
        ['Beans a preview (showcase on)', { beans: false, escrow: false, showcase: true }],
    ] as const) {
        it(`on the worldwide community, ${name}: no chip; every listing shows`, async () => {
            info.value = { profile: 'global', features };
            render(<MarketplacePage identity={identity} isMember />);
            await screen.findByText('Bicycle Repair');
            await settle();
            expect(screen.queryByRole('button', { name: /New members/ })).toBeNull();
            expect(screen.getByText('Sourdough starter')).toBeInTheDocument();
        });
    }

    it('on a local community: the chip, as before, and it narrows to authors with no trade yet', async () => {
        render(<MarketplacePage identity={identity} isMember />);
        await screen.findByText('Bicycle Repair');
        await settle();
        const chip = screen.getByRole('button', { name: /New members/ });
        expect(chip).toHaveAttribute('aria-pressed', 'false');
        await act(async () => { chip.click(); });
        expect(screen.getByRole('button', { name: /New members/ })).toHaveAttribute('aria-pressed', 'true');
        await waitFor(() => expect(screen.queryByText('Sourdough starter')).toBeNull());
        expect(screen.getByText('Bicycle Repair')).toBeInTheDocument();
    });
});
