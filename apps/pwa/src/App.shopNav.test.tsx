import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false, media: '', onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
}

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => null }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => null }));

vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'my-user-pubkey', privateKey: 'my-user-privkey', callsign: 'Alice' })),
    updateCallsign: vi.fn(),
}));

vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
}));

vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getMyUnread: vi.fn(async () => ({ unread: 0, requests: 0, asOf: '2026-11-01T00:00:00.000Z' })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.30' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'my-user-pubkey', avatar: null, bio: '', contact: null })),
}));

vi.mock('./pages/HomePage', () => ({
    HomePage: ({ onNavigate }: any) => (
        <div data-testid="home-page">
            <button data-testid="home-open-shop" onClick={() => onNavigate('shop', 'shop-456')}>Open shop</button>
        </div>
    ),
}));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/MessagesPage', () => ({ MessagesPage: () => <div data-testid="messages-page" /> }));
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => <div data-testid="people-page" /> }));

vi.mock('./pages/YourShopPage', () => ({
    YourShopPage: ({ onBack, onOpenShop }: any) => (
        <div data-testid="shop-screen">
            <button data-testid="shop-back" onClick={onBack}>Back</button>
            <button data-testid="shop-see-front" onClick={() => onOpenShop('shop-123')}>See it as members do</button>
        </div>
    ),
}));

vi.mock('./pages/PublicProfilePage', () => ({
    PublicProfilePage: ({ onBack }: any) => (
        <div data-testid="profile-page">
            <button data-testid="profile-back" onClick={onBack}>Back</button>
        </div>
    ),
}));

vi.mock('./pages/ShopDetailPage', () => ({
    ShopDetailPage: ({ id, onBack, onOpenYourShop, onOpenProfile, onOpenEnterprise }: any) => (
        <div data-testid="shop-page">
            <span data-testid="shop-id">{id}</span>
            <button data-testid="shop-page-back" onClick={onBack}>Back</button>
            <button data-testid="shop-page-change" onClick={onOpenYourShop}>Change your shop</button>
            <button data-testid="shop-page-profile" onClick={() => onOpenProfile?.('owner-pubkey')}>Owner profile</button>
            <button data-testid="shop-page-enterprise" onClick={() => onOpenEnterprise?.('enterprise-pubkey')}>Enterprise</button>
        </div>
    ),
}));

let mockShopParam: string | null = null;
vi.mock('./lib/shop', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lib/shop')>();
    return {
        ...actual,
        takeShopParam: () => mockShopParam,
    };
});

describe('App shop navigation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockShopParam = 'mine';
    });

    it('Back from "See it as members do" returns to Your shop', async () => {
        render(<App />);

        // Your shop overlay appears on load with ?shop=mine
        expect(await screen.findByTestId('shop-screen')).toBeInTheDocument();

        // Click "See it as members do"
        fireEvent.click(screen.getByTestId('shop-see-front'));

        // Shop detail overlay appears
        expect(await screen.findByTestId('shop-page')).toBeInTheDocument();
        expect(screen.queryByTestId('shop-screen')).not.toBeInTheDocument();

        // Click Back on the shop detail page
        fireEvent.click(screen.getByTestId('shop-page-back'));

        // Should return to Your shop
        expect(await screen.findByTestId('shop-screen')).toBeInTheDocument();
        expect(screen.queryByTestId('shop-page')).not.toBeInTheDocument();
    });

    it('leaving shopfront to profile resets shopFromYourShop flag so viewing another shop does not return to YourShopPage on back', async () => {
        render(<App />);

        expect(await screen.findByTestId('shop-screen')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('shop-see-front'));

        expect(await screen.findByTestId('shop-page')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('shop-page-profile'));

        expect(await screen.findByTestId('profile-page')).toBeInTheDocument();
        expect(screen.queryByTestId('shop-page')).not.toBeInTheDocument();
        expect(screen.queryByTestId('shop-screen')).not.toBeInTheDocument();

        // Close profile page (Back)
        fireEvent.click(screen.getByTestId('profile-back'));
        expect(screen.queryByTestId('profile-page')).not.toBeInTheDocument();

        // Open another shop from home
        fireEvent.click(screen.getByTestId('home-open-shop'));
        expect(await screen.findByTestId('shop-page')).toBeInTheDocument();
        expect(screen.getByTestId('shop-id')).toHaveTextContent('shop-456');

        // Back should simply close the shop page, NOT open shop-screen
        fireEvent.click(screen.getByTestId('shop-page-back'));
        expect(screen.queryByTestId('shop-page')).not.toBeInTheDocument();
        expect(screen.queryByTestId('shop-screen')).not.toBeInTheDocument();
    });
});
