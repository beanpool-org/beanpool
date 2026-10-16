/**
 * The app shell reads nothing of the member's where a feature is in preview (global previews audit, "Across all five",
 * P3): on the global node it asked GET /api/marketplace/transactions for the member's deals on every load and poll,
 * while My Deals there is Example Valley's. Deals in preview: never asked. A local node: asked, as before.
 *
 * The whole App, with the pages stood in for and the node's reads mocked at lib/api.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';
import { getConversations, getMyMarketplaceTransactions } from './lib/api';

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false, media: '', onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
}

vi.mock('./components/InstallPrompt', () => ({
    InstallPrompt: ({ hidden }: { hidden?: boolean }) => <div data-testid="install-prompt" data-held-back={String(!!hidden)} />,
}));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => <div>Profile setup</div> }));
vi.mock('./components/NewAccountCard', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./components/NewAccountCard')>()),
    NewAccountCard: () => <div data-testid="new-account-card">Your account is new</div>,
}));
vi.mock('./components/OneWayBack', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./components/OneWayBack')>()),
    OneWayBackCard: () => <div data-testid="one-way-back">One way back</div>,
}));
vi.mock('./pages/HomePage', () => ({ HomePage: () => <div data-testid="home-page" /> }));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/LedgerPage', () => ({ LedgerPage: () => <div data-testid="ledger-page" /> }));
vi.mock('./pages/ProjectsPage', () => ({ ProjectsPage: () => <div data-testid="projects-page" /> }));
vi.mock('./lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));

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

// The node's /api/community/info, read once per page load: a local node unless a test says otherwise.
const info = vi.hoisted(() => ({ features: {} as Record<string, unknown> }));
vi.mock('./lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: info.features })),
    joinInFlight: vi.fn(async () => false),
}));

vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.28' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getCommunityMe: vi.fn(async () => null),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(),
}));

const WORLDWIDE = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true };

describe("the app shell and the member's own deals", () => {
    beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); info.features = {}; });

    it('global (deals in preview): the unread poll runs, and the deals are never asked', async () => {
        info.features = WORLDWIDE;
        render(<App />);
        await screen.findByTestId('home-page');
        await waitFor(() => expect(getConversations).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 20));
        expect(getMyMarketplaceTransactions).not.toHaveBeenCalled();
    });

    it('local (deals live): the poll asks for them, as before', async () => {
        render(<App />);
        await screen.findByTestId('home-page');
        await waitFor(() => expect(getMyMarketplaceTransactions).toHaveBeenCalledWith('my-user-pubkey'));
    });

    it('deals off with no previews (hidden): still asked, as before', async () => {
        info.features = { ...WORLDWIDE, showcase: false };
        render(<App />);
        await screen.findByTestId('home-page');
        await waitFor(() => expect(getMyMarketplaceTransactions).toHaveBeenCalledWith('my-user-pubkey'));
    });
});
