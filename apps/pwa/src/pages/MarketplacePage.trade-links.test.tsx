import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

// Marty, 15 Oct: "when I click on View Post it just takes me to the marketplace screen", and the chat's Rate your partner
// had nowhere to rate. A finished trade's post has left the feed (status completed); the rating form is My Deals' one.

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null),
    saveRadiusSettings: vi.fn(),
    clearRadiusSettings: vi.fn(),
    haversineDistance: vi.fn(() => 0),
}));

vi.mock('../lib/peer-prefs', () => ({
    loadEnabledPeers: vi.fn(() => new Set()),
    togglePeer: vi.fn(),
}));

vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../components/ActivityWaterfall', () => ({
    ActivityWaterfall: () => null,
}));

const identity: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'k', callsign: 'Alice', createdAt: '2026-09-17T00:00:00.000Z' };

const feed = [{
    id: 'post-1', title: 'Bicycle Repair', description: 'Fix gears', type: 'offer', category: 'services',
    credits: 20, status: 'active', authorPublicKey: 'member-david', authorCallsign: 'David', createdAt: '2026-09-15T00:00:00Z',
}];
const finished = { ...feed[0], id: 'post-done', title: 'Sourdough loaf', authorPublicKey: 'peer-pubkey', authorCallsign: 'Bob', status: 'completed' };

const trade = (id: string, rated: boolean): api.MarketplaceTransaction => ({
    id, postId: 'post-done', postTitle: 'Sourdough loaf', buyerPublicKey: 'my-pubkey', buyerCallsign: 'Alice',
    sellerPublicKey: 'peer-pubkey', sellerCallsign: 'Bob', credits: 5, status: 'completed',
    createdAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:00:00Z', ratedByBuyer: rated, ratedBySeller: false,
});

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getMarketplacePosts').mockImplementation(async (filter?: any) =>
        (filter?.id === 'post-done' ? [finished] : filter?.id ? [] : [...feed]) as any);
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getMembers').mockResolvedValue([]);
    vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 0, isBlockedFromTrading: false } as any);
    vi.spyOn(api, 'getMyMarketplaceTransactions').mockResolvedValue([]);
});

describe('Market: a chat\'s View Post opens the post, even a finished one', () => {
    it('a completed offer not in the feed opens by id, and says it is finished', async () => {
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId="post-done" onPostOpened={onPostOpened} />);
        await screen.findByRole('heading', { name: /Sourdough loaf/ });
        expect(screen.getByText('This offer is finished.')).toBeInTheDocument();
        expect(api.getMarketplacePosts).toHaveBeenCalledWith({ id: 'post-done', types: 'offer,need,poll,event' });
        expect(onPostOpened).toHaveBeenCalled();
    });

    it('a post the node won\'t give this member says so in one sentence, instead of the bare market', async () => {
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId="post-gone" onPostOpened={onPostOpened} sayWhenPostUnopened />);
        await screen.findByText('That listing can no longer be opened. It may have been taken down.');
        expect(onPostOpened).toHaveBeenCalled();
    });

    // A link the app arrived on (a shared /?post=, the lobby's kept listing) lands quietly, as decided before #1980
    // (GuestLobby.test "a listing that has gone"); only a member's own tap is told why.
    it('a shared link to a post that has gone (no sayWhenPostUnopened): the Market, quietly', async () => {
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId="post-gone" onPostOpened={onPostOpened} />);
        await waitFor(() => expect(onPostOpened).toHaveBeenCalled());
        expect(screen.getByText('Bicycle Repair')).toBeInTheDocument();
        expect(screen.queryByText(/no longer be opened|couldn't be loaded/)).toBeNull();
    });

    // Review #1980 N1: a dropped connection is not an answer; it never says the listing was taken down.
    it('a read that fails says to check the connection, never "taken down"', async () => {
        vi.mocked(api.getMarketplacePosts).mockImplementation(async (filter?: any) => {
            if (filter?.id) throw new TypeError('Failed to fetch');
            return [...feed] as any;
        });
        const onPostOpened = vi.fn();
        render(<MarketplacePage identity={identity} openPostId="post-done" onPostOpened={onPostOpened} sayWhenPostUnopened />);
        await screen.findByText("That listing couldn't be loaded. Check your connection and try again.");
        expect(screen.queryByText(/taken down/)).toBeNull();
        expect(onPostOpened).toHaveBeenCalled();
    });
});

describe('Market: a chat\'s Rate your partner opens the rating form for that trade', () => {
    it('from the trades the page holds', async () => {
        const onReviewOpened = vi.fn();
        render(<MarketplacePage identity={identity} transactions={[trade('tx-a', true), trade('tx-b', false)]} openReviewTxId="tx-b" onReviewOpened={onReviewOpened} />);
        const dialog = await screen.findByRole('dialog', { name: 'Deal Complete!' });
        expect(dialog).toHaveTextContent('How was your experience with Bob?');
        expect(onReviewOpened).toHaveBeenCalled();
    });

    it('read from the node when the page has not loaded them yet', async () => {
        vi.mocked(api.getMyMarketplaceTransactions).mockResolvedValue([trade('tx-b', false)]);
        render(<MarketplacePage identity={identity} transactions={[]} openReviewTxId="tx-b" />);
        await screen.findByRole('dialog', { name: 'Deal Complete!' });
        expect(api.getMyMarketplaceTransactions).toHaveBeenCalledWith('my-pubkey');
    });

    it('the trades can\'t be read (a dropped connection): it says so, never "could not be found"', async () => {
        vi.mocked(api.getMyMarketplaceTransactions).mockRejectedValue(new TypeError('Failed to fetch'));
        const onReviewOpened = vi.fn();
        render(<MarketplacePage identity={identity} transactions={[]} openReviewTxId="tx-b" onReviewOpened={onReviewOpened} />);
        await screen.findByText("Your trades couldn't be loaded. Check your connection and try again.");
        expect(screen.queryByText('That trade could not be found.')).toBeNull();
        expect(onReviewOpened).toHaveBeenCalled();
    });

    it('a trade already rated says so, and opens no form', async () => {
        render(<MarketplacePage identity={identity} transactions={[trade('tx-a', true)]} openReviewTxId="tx-a" />);
        await screen.findByText('You have already rated this trade.');
        expect(screen.queryByRole('dialog', { name: 'Deal Complete!' })).toBeNull();
    });
});
