// The Market tells each poll card whether it is on the global community, from the page's one read of
// /api/community/info: there a poll says it decides nothing (FABLE-sec-global-abuse LOW-7).
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

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
const poll = {
    id: 'poll-1', type: 'poll', category: 'community', title: 'Market on Saturday or Sunday?',
    description: '', credits: 0, priceType: 'fixed', status: 'active', active: true,
    authorPublicKey: 'member-ada', authorCallsign: 'Ada', createdAt: '2026-09-16T00:00:00Z',
    pollOptions: [{ id: 'a', text: 'Saturday', votes: 1, percentage: 100 }, { id: 'b', text: 'Sunday', votes: 0, percentage: 0 }],
    totalVotes: 1, pollVotes: [],
};

describe('MarketplacePage: polls on the global community are informal', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([poll] as any);
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    });

    it('labels a poll on the global community', async () => {
        info.current = { profile: 'global', features: { beans: false } };
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Market on Saturday or Sunday?');
        expect(await screen.findByTestId('poll-informal-note')).toHaveTextContent('An informal poll; it decides nothing');
    });

    it('leaves a local community\'s poll as it was', async () => {
        info.current = { profile: 'local', features: {} };
        render(<MarketplacePage identity={identity} />);
        await screen.findByText('Market on Saturday or Sunday?');
        // The page's read of the node has had its turn by the time the poll is drawn twice over.
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByTestId('poll-informal-note')).toBeNull();
    });
});
