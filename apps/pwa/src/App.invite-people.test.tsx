import { render, screen, fireEvent, within } from '@testing-library/react';
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
    loadIdentity: vi.fn(async () => ({ publicKey: '00'.repeat(32), privateKey: '11'.repeat(32), callsign: 'Alice' })),
    updateCallsign: vi.fn(),
}));

vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
}));

vi.mock('./lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('./lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lib/api')>();
    return {
        ...actual,
        getNodeApiUrl: vi.fn(() => ''),
        registerMember: vi.fn(async () => ({ ok: true })),
        checkMembership: vi.fn(async () => ({ isMember: true })),
        getMyUnread: vi.fn(async () => ({ unread: 0, requests: 0, asOf: '2026-11-01T00:00:00.000Z' })),
        getMyMarketplaceTransactions: vi.fn(async () => []),
        getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.30' })),
        getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
        getUnseenNotices: vi.fn(async () => []),
        markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
        getMemberProfile: vi.fn(async () => ({ publicKey: '00'.repeat(32), avatar: null, bio: '', contact: null })),
        getFriends: vi.fn(async () => []),
        getMembers: vi.fn(async () => []),
        getJoinRequests: vi.fn(async () => ({ ok: true, knocks: [] })),
    };
});

vi.mock('./pages/InvitePage', () => ({
    InvitePage: () => <div data-testid="invites-pane">Invite codes</div>,
}));

vi.mock('./pages/HomePage', () => ({
    HomePage: () => <div data-testid="home-page" />,
}));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/MessagesPage', () => ({ MessagesPage: () => <div data-testid="messages-page" /> }));
vi.mock('./pages/ProjectsPage', () => ({ ProjectsPage: () => <div data-testid="projects-page" /> }));
vi.mock('./pages/LedgerPage', () => ({ LedgerPage: () => <div data-testid="ledger-page" /> }));
vi.mock('./pages/SettingsPage', () => ({
    SettingsPage: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>Back</button>,
}));

const sidebar = () => document.querySelector('aside') as HTMLElement;
const sidebarInvite = () => within(sidebar()).getByTestId('sidebar-invite');
const headerInvite = () => screen.getByTestId('header-invite');

describe('tapping Invite friends opens People on Invites from anywhere, including People itself', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it('open People, switch to Friends, tap Invite in header -> Invites shows', async () => {
        render(<App />);
        await screen.findByTestId('home-page');

        // 1. Tap Invite in header -> opens People on Invites
        fireEvent.click(headerInvite());
        expect(await screen.findByTestId('invites-pane')).toBeInTheDocument();

        // 2. In People, switch to Friends sub-view
        const friendsTab = screen.getByRole('tab', { name: /Friends/ });
        fireEvent.click(friendsTab);
        expect(screen.queryByTestId('invites-pane')).toBeNull();
        expect(friendsTab).toHaveAttribute('aria-selected', 'true');

        // 3. Tap Invite in header again -> Invites pane must show
        fireEvent.click(headerInvite());
        expect(await screen.findByTestId('invites-pane')).toBeInTheDocument();
    });

    it('open People, switch to Community, tap Invite in header -> Invites shows', async () => {
        render(<App />);
        await screen.findByTestId('home-page');

        // 1. Tap Invite in header -> opens People on Invites
        fireEvent.click(headerInvite());
        expect(await screen.findByTestId('invites-pane')).toBeInTheDocument();

        // 2. In People, switch to Community sub-view
        const communityTab = screen.getByRole('tab', { name: /Community/ });
        fireEvent.click(communityTab);
        expect(screen.queryByTestId('invites-pane')).toBeNull();
        expect(communityTab).toHaveAttribute('aria-selected', 'true');

        // 3. Tap Invite in header again -> Invites pane must show
        fireEvent.click(headerInvite());
        expect(await screen.findByTestId('invites-pane')).toBeInTheDocument();
    });

    it('open People, switch to Friends or Community, tap Invite in sidebar -> Invites shows', async () => {
        render(<App />);
        await screen.findByTestId('home-page');

        // 1. Tap Invite in sidebar -> opens People on Invites
        fireEvent.click(sidebarInvite());
        expect(await screen.findByTestId('invites-pane')).toBeInTheDocument();

        // 2. In People, switch to Friends sub-view
        const friendsTab = screen.getByRole('tab', { name: /Friends/ });
        fireEvent.click(friendsTab);
        expect(screen.queryByTestId('invites-pane')).toBeNull();
        expect(friendsTab).toHaveAttribute('aria-selected', 'true');

        // 3. Tap Invite in sidebar again -> Invites pane must show
        fireEvent.click(sidebarInvite());
        expect(await screen.findByTestId('invites-pane')).toBeInTheDocument();

        // 4. In People, switch to Community sub-view
        const communityTab = screen.getByRole('tab', { name: /Community/ });
        fireEvent.click(communityTab);
        expect(screen.queryByTestId('invites-pane')).toBeNull();
        expect(communityTab).toHaveAttribute('aria-selected', 'true');

        // 5. Tap Invite in sidebar again -> Invites pane must show
        fireEvent.click(sidebarInvite());
        expect(await screen.findByTestId('invites-pane')).toBeInTheDocument();
    });
});
