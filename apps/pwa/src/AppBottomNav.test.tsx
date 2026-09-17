import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App, navTabWeight, NAV_LABEL_FONT_SIZE } from './App';
import type { BeanPoolIdentity } from './lib/identity';

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }));
}

vi.mock('./components/InstallPrompt', () => ({
    InstallPrompt: () => null,
}));

vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => ({
        publicKey: 'my-user-pubkey',
        privateKey: 'my-user-privkey',
        callsign: 'Alice',
    })),
    updateCallsign: vi.fn(),
}));

vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('./lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('./lib/api', () => ({
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.18' })),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 100, creditLimit: 50 })),
    getPulseFeed: vi.fn(async () => ({ items: [], nextCursor: null })),
    getMemberProfile: vi.fn(async () => ({
        publicKey: 'my-user-pubkey',
        callsign: 'Alice',
        role: 'member',
        bio: 'Hello world',
        elderVouchedBy: null,
        stats: { totalVouchesGiven: 0, ratingsReceivedCount: 0, averageRating: 0, vouchesReceivedCount: 0 },
    })),
    getMemberRatings: vi.fn(async () => []),
    getRatingsGiven: vi.fn(async () => []),
    getFriends: vi.fn(async () => []),
    getPublicChannels: vi.fn(async () => []),
    getMyActiveRecoveryCollections: vi.fn(async () => []),
    getTreasuryDetail: vi.fn(async () => null),
    getTreasuries: vi.fn(async () => []),
}));

vi.mock('./components/SyncStatus', () => ({
    SyncStatus: () => <div data-testid="sync-status">Synced</div>,
}));

vi.mock('./pages/MarketplacePage', () => ({
    MarketplacePage: ({ onOpenProfile }: { onOpenProfile?: (pk: string) => void }) => (
        <div data-testid="marketplace-page">
            <button onClick={() => onOpenProfile?.('some-peer-pubkey')}>Open Peer Profile</button>
        </div>
    ),
}));

vi.mock('./pages/ProjectsPage', () => ({
    ProjectsPage: ({ onOpenTreasury }: { onOpenTreasury?: (pk: string) => void }) => (
        <div data-testid="projects-page">
            <button onClick={() => onOpenTreasury?.('some-treasury-pubkey')}>Open Treasury</button>
        </div>
    ),
}));

describe('App mobile bottom nav dynamic visibility & CSS variable regression (#791 / #792)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.documentElement.removeAttribute('data-bottom-nav');
        document.documentElement.classList.remove('bottom-nav-hidden');
        document.documentElement.style.removeProperty('--bottom-nav-height');
        document.documentElement.style.removeProperty('--bottom-nav-offset');
    });

    it('renders bottom nav as visible on default tabs and hides it when opening a profile', async () => {
        render(<App />);

        // Wait for identity to load and marketplace to mount
        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });

        const bottomNav = screen.getByTestId('mobile-bottom-nav');
        expect(bottomNav).toBeInTheDocument();
        expect(bottomNav).toHaveStyle({ display: 'flex' });
        expect(bottomNav.classList.contains('hidden')).toBe(false);

        // Document root should not have data-bottom-nav=hidden
        expect(document.documentElement.getAttribute('data-bottom-nav')).toBeNull();
        expect(document.documentElement.classList.contains('bottom-nav-hidden')).toBe(false);

        // Open a profile
        const openProfileBtn = screen.getByText('Open Peer Profile');
        fireEvent.click(openProfileBtn);

        // Once profile is open, bottom nav must be hidden
        await waitFor(() => {
            expect(bottomNav).toHaveStyle({ display: 'none' });
        });
        expect(bottomNav.classList.contains('hidden')).toBe(true);

        // App root container and documentElement must reflect hidden bottom-nav state & CSS variables
        expect(document.documentElement.getAttribute('data-bottom-nav')).toBe('hidden');
        expect(document.documentElement.classList.contains('bottom-nav-hidden')).toBe(true);
        expect(document.documentElement.style.getPropertyValue('--bottom-nav-height')).toBe('0px');
        expect(document.documentElement.style.getPropertyValue('--bottom-nav-offset')).toBe('env(safe-area-inset-bottom, 0px)');

        // Closing the profile restores bottom nav visibility
        const backButton = screen.getByRole('button', { name: /back/i });
        fireEvent.click(backButton);

        await waitFor(() => {
            expect(bottomNav).toHaveStyle({ display: 'flex' });
        });
        expect(document.documentElement.getAttribute('data-bottom-nav')).toBeNull();
        expect(document.documentElement.classList.contains('bottom-nav-hidden')).toBe(false);
        expect(document.documentElement.style.getPropertyValue('--bottom-nav-height')).toBe('');
        expect(document.documentElement.style.getPropertyValue('--bottom-nav-offset')).toBe('');
    });

    it('hides bottom nav when opening a treasury and restores it when closed', async () => {
        render(<App />);

        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });

        const bottomNav = screen.getByTestId('mobile-bottom-nav');
        expect(bottomNav).toHaveStyle({ display: 'flex' });

        // Switch to Commons (projects) tab via mobile bottom nav
        const commonsTab = within(bottomNav).getByText(/Commons/i);
        fireEvent.click(commonsTab);

        await waitFor(() => {
            expect(screen.getByTestId('projects-page')).toBeInTheDocument();
        });

        // Open treasury
        const openTreasuryBtn = screen.getByText('Open Treasury');
        fireEvent.click(openTreasuryBtn);

        await waitFor(() => {
            expect(bottomNav).toHaveStyle({ display: 'none' });
        });
        expect(bottomNav.classList.contains('hidden')).toBe(true);
        expect(document.documentElement.getAttribute('data-bottom-nav')).toBe('hidden');
        expect(document.documentElement.classList.contains('bottom-nav-hidden')).toBe(true);
        expect(document.documentElement.style.getPropertyValue('--bottom-nav-height')).toBe('0px');
        expect(document.documentElement.style.getPropertyValue('--bottom-nav-offset')).toBe('env(safe-area-inset-bottom, 0px)');

        // Close treasury
        const backButton = screen.getByRole('button', { name: /back/i });
        fireEvent.click(backButton);

        await waitFor(() => {
            expect(bottomNav).toHaveStyle({ display: 'flex' });
        });
        expect(document.documentElement.getAttribute('data-bottom-nav')).toBeNull();
        expect(document.documentElement.classList.contains('bottom-nav-hidden')).toBe(false);
        expect(document.documentElement.style.getPropertyValue('--bottom-nav-height')).toBe('');
        expect(document.documentElement.style.getPropertyValue('--bottom-nav-offset')).toBe('');
    });
});

describe('App mobile bottom nav labels on a 320px phone at 1.3x text', () => {
    it('gives each tab a share of the row that follows its label, with a floor for the emoji', () => {
        expect(navTabWeight('Map')).toBe(4);
        expect(navTabWeight('Chat')).toBe(4);
        expect(navTabWeight('Pulse')).toBe(5);
        expect(navTabWeight('Market')).toBe(6);
        expect(navTabWeight('Commons')).toBe(7);
    });

    it('caps the label size by viewport width so whole labels fit, full 0.6rem on wider screens', () => {
        expect(NAV_LABEL_FONT_SIZE).toBe('min(0.6rem, 3.3vw)');
    });

    it('renders every tab with its full label and a weighted width', async () => {
        render(<App />);
        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });

        const bottomNav = screen.getByTestId('mobile-bottom-nav');
        const labels = Array.from(bottomNav.querySelectorAll<HTMLElement>('[data-nav-label]'));
        expect(labels.map(l => l.textContent?.trim())).toEqual(['Market', 'Pulse', 'Map', 'Commons', 'Chat', 'People', 'Ledger']);

        for (const label of labels) {
            const button = label.closest('button') as HTMLButtonElement;
            expect(button.style.flexGrow).toBe(String(navTabWeight(label.textContent!.trim())));
            expect(button.style.flexBasis).toBe('0px');
            expect(button.style.minWidth).toBe('0px');
        }
    });
});
