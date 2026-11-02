import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { freshBannerDay, parseFreshBannerDismissal } from '@beanpool/core';

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

const identity: BeanPoolIdentity = {
    publicKey: 'my-web-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Alice',
    createdAt: '2026-09-17T00:00:00.000Z',
};

const makeListing = (id: string, title: string, authorPublicKey = 'other-author-pubkey', createdAt = new Date().toISOString()) => ({
    id,
    title,
    description: 'Description of ' + title,
    type: 'offer' as const,
    category: 'services',
    credits: 10,
    status: 'active' as const,
    authorPublicKey,
    authorCallsign: 'Bob',
    createdAt,
});

describe('MarketplacePage fresh listings banner on web', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, isBlockedFromTrading: false } as any);
    });

    it('renders fresh banner as an accessible button, dismissing it hides it and writes to localStorage', async () => {
        const freshPosts = [
            makeListing('post-1', 'Organic Honey', 'neighbour-1'),
            makeListing('post-2', 'Sourdough Loaf', 'neighbour-2'),
        ];
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(freshPosts as any);

        render(<MarketplacePage identity={identity} isMember={true} />);

        // The banner should appear with 2 listings
        const bannerTitle = await screen.findByText('2 fresh listings posted today!');
        expect(bannerTitle).toBeInTheDocument();
        const bannerSub = screen.getByText('Tap to dismiss • Scroll down to explore');
        expect(bannerSub).toBeInTheDocument();

        // The banner is an interactive button with keyboard focus support
        const bannerBtn = bannerSub.closest('button');
        expect(bannerBtn).toBeTruthy();
        expect(bannerBtn?.tagName).toBe('BUTTON');
        expect(bannerBtn?.getAttribute('type')).toBe('button');
        expect(bannerBtn?.className).toContain('focus-visible:ring-2');

        // Dismiss the banner
        await act(async () => {
            fireEvent.click(bannerBtn!);
        });

        // Banner is hidden
        expect(screen.queryByText('Tap to dismiss • Scroll down to explore')).toBeNull();
        expect(screen.queryByText('2 fresh listings posted today!')).toBeNull();

        // Stored dismissal in localStorage
        const stored = localStorage.getItem('bp_dismissed_fresh_count');
        expect(stored).toBeTruthy();
        const parsed = parseFreshBannerDismissal(stored);
        expect(parsed).toEqual({ day: freshBannerDay(), count: 2 });
    });

    it('leaves own posts out of the fresh count', async () => {
        // Only own posts posted today
        const ownPosts = [
            makeListing('post-own-1', 'My lemons', identity.publicKey),
        ];
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(ownPosts as any);

        render(<MarketplacePage identity={identity} isMember={true} />);

        // Wait for feed to load
        await screen.findByText('My lemons');

        // Banner should not be shown because own listings are excluded
        expect(screen.queryByText('Tap to dismiss • Scroll down to explore')).toBeNull();
        expect(screen.queryByText(/fresh listing posted today/)).toBeNull();
    });

    it('more listings posted today bring the banner back', async () => {
        // Dismissed at 1 listing earlier today
        const dismissal = JSON.stringify({ day: freshBannerDay(), count: 1 });
        localStorage.setItem('bp_dismissed_fresh_count', dismissal);

        // Feed now has 2 fresh listings from other members
        const freshPosts = [
            makeListing('post-1', 'Organic Honey', 'neighbour-1'),
            makeListing('post-2', 'Sourdough Loaf', 'neighbour-2'),
        ];
        vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(freshPosts as any);

        render(<MarketplacePage identity={identity} isMember={true} />);

        // Count (2) > dismissed (1), so banner is shown again
        const bannerTitle = await screen.findByText('2 fresh listings posted today!');
        expect(bannerTitle).toBeInTheDocument();
        expect(screen.getByText('Tap to dismiss • Scroll down to explore')).toBeInTheDocument();
    });
});
