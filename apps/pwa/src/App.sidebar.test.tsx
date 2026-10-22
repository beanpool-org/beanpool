/**
 * The wide screen's sidebar (md+), from a tester's two reports (23 Oct):
 *
 * 1. "when i click on my profile, then i can't click on the settings cog, but if i click on home i can". A member's
 *    profile, an enterprise's page and a tool are each drawn over the tabs at z-[110], beside the sidebar; Settings is
 *    drawn at 100, under them. The cog only opened Settings, so it opened under the page already there and nothing
 *    seemed to happen; a tab worked because a tab closes that page first.
 * 2. "Avatar didn't seem to populate into the small icon in the bottom left": the sidebar's profile button drew the
 *    name's first two letters and never the member's picture.
 *
 * The whole App, with the pages stood in for and the node's reads mocked at lib/api. jsdom applies no stylesheet, so the
 * sidebar is in the document at any width: these tests drive it as a wide screen would.
 */
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';
import { getMemberProfile } from './lib/api';

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false, media: '', onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
}

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => <div>Profile setup</div> }));

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

// Whether the node takes this key as a member: App asks for the member's own picture only once it has said yes.
const standing = vi.hoisted(() => ({ isMember: true }));

vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: standing.isMember })),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.30' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'my-user-pubkey', avatar: null, bio: '', contact: null })),
}));

// The pages that open over the tabs, as App mounts them: each its own fixed layer at z-[110], with its own Back.
vi.mock('./pages/PublicProfilePage', () => ({
    PublicProfilePage: ({ pubkey, onBack }: { pubkey: string; onBack: () => void }) => (
        <div data-testid="profile-overlay" data-pubkey={pubkey} className="page-overlay z-[110]">
            <button onClick={onBack}>Back from profile</button>
        </div>
    ),
}));
vi.mock('./pages/TreasuryDetailPage', () => ({
    TreasuryDetailPage: ({ onBack }: { onBack: () => void }) => (
        <div data-testid="treasury-overlay" className="page-overlay z-[110]">
            <button onClick={onBack}>Back from enterprise</button>
        </div>
    ),
}));
vi.mock('./pages/ToolsPage', () => ({
    ToolsPage: ({ onClose }: { onClose: () => void }) => (
        <div data-testid="tools-overlay" className="page-overlay z-[110]">
            <button onClick={onClose}>Back from tools</button>
        </div>
    ),
}));

vi.mock('./pages/HomePage', () => ({
    HomePage: ({ onNavigate }: { onNavigate: (tab: string, ctx?: string) => void }) => (
        <div data-testid="home-page">
            <button onClick={() => onNavigate('tools')}>Open Tools</button>
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
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/SettingsPage', () => ({
    SettingsPage: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>← Back</button>,
}));

const sidebar = () => document.querySelector('aside') as HTMLElement;
const cog = () => within(sidebar()).getByTestId('sidebar-settings');
const profileButton = () => within(sidebar()).getByRole('button', { name: /View Profile/ });

async function landed() {
    render(<App />);
    await screen.findByTestId('home-page');
}

describe('the sidebar\'s Settings cog opens Settings where the member sees it', () => {
    beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); standing.isMember = true; });

    it('from the member\'s own profile: Settings shows and the profile closes', async () => {
        await landed();
        fireEvent.click(profileButton());
        expect(await screen.findByTestId('profile-overlay')).toHaveAttribute('data-pubkey', 'my-user-pubkey');

        fireEvent.click(cog());
        expect(await screen.findByTestId('settings-overlay')).toBeInTheDocument();
        expect(screen.queryByTestId('profile-overlay')).toBeNull();
        expect(cog()).toHaveAttribute('aria-pressed', 'true');

        // And the cog closes it again, as before.
        fireEvent.click(cog());
        await waitFor(() => expect(screen.queryByTestId('settings-overlay')).toBeNull());
        expect(cog()).toHaveAttribute('aria-pressed', 'false');
    });

    it('from an enterprise\'s page: Settings shows and that page closes', async () => {
        await landed();
        fireEvent.click(within(sidebar()).getByRole('button', { name: /Commons/ }));
        fireEvent.click(await screen.findByText('Open Treasury'));
        await screen.findByTestId('treasury-overlay');

        fireEvent.click(cog());
        expect(await screen.findByTestId('settings-overlay')).toBeInTheDocument();
        expect(screen.queryByTestId('treasury-overlay')).toBeNull();
    });

    it('from a tool: Settings shows and the tool closes', async () => {
        await landed();
        fireEvent.click(screen.getByText('Open Tools'));
        await screen.findByTestId('tools-overlay');

        fireEvent.click(cog());
        expect(await screen.findByTestId('settings-overlay')).toBeInTheDocument();
        expect(screen.queryByTestId('tools-overlay')).toBeNull();
    });

    it('Settings open with the profile opened over it: the cog is not pressed, and its tap brings Settings back to view', async () => {
        await landed();
        fireEvent.click(cog());
        await screen.findByTestId('settings-overlay');
        fireEvent.click(profileButton());
        await screen.findByTestId('profile-overlay');
        // Settings is still mounted, under the profile: the cog says what the member sees.
        expect(cog()).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(cog());
        await waitFor(() => expect(screen.queryByTestId('profile-overlay')).toBeNull());
        expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
        expect(cog()).toHaveAttribute('aria-pressed', 'true');
    });

    it('the mobile header\'s cog opens Settings the same way', async () => {
        await landed();
        fireEvent.click(profileButton());
        await screen.findByTestId('profile-overlay');

        fireEvent.click(screen.getByTestId('header-settings'));
        expect(await screen.findByTestId('settings-overlay')).toBeInTheDocument();
        expect(screen.queryByTestId('profile-overlay')).toBeNull();
    });

    // Found checking the other pages over the tabs: a sidebar tab closed a profile and a tool, but left an enterprise's
    // page drawn over the tab it opened.
    it('a sidebar tab closes an enterprise\'s page, as it closes a profile', async () => {
        await landed();
        fireEvent.click(within(sidebar()).getByRole('button', { name: /Commons/ }));
        fireEvent.click(await screen.findByText('Open Treasury'));
        await screen.findByTestId('treasury-overlay');

        fireEvent.click(within(sidebar()).getByRole('button', { name: /Home/ }));
        await waitFor(() => expect(screen.queryByTestId('treasury-overlay')).toBeNull());
        expect(screen.getByTestId('home-page')).toBeInTheDocument();
    });
});

describe('the sidebar\'s profile button shows the member\'s own picture', () => {
    beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); standing.isMember = true; });

    const profile = (avatar: string | null) => ({ publicKey: 'my-user-pubkey', avatar, bio: '', contact: null });

    it('the initials while it loads, then the picture, and the new one once the profile is saved', async () => {
        let answer!: (p: ReturnType<typeof profile>) => void;
        vi.mocked(getMemberProfile).mockImplementationOnce(() => new Promise((r) => { answer = r; }));
        await landed();

        await waitFor(() => expect(getMemberProfile).toHaveBeenCalledWith('my-user-pubkey', 'my-user-pubkey'));
        expect(within(profileButton()).getByText('AL')).toBeInTheDocument();
        expect(within(profileButton()).queryByRole('img')).toBeNull();

        await act(async () => { answer(profile('bundled://sun')); });
        // The stored picture, through lib/avatar's safe forms (a bundled one is the app's own file).
        expect(await within(profileButton()).findByRole('img', { name: 'Your Photo' })).toHaveAttribute('src', '/avatars/avatar_sun.jpg');
        expect(within(profileButton()).queryByText('AL')).toBeNull();

        // Saved with a new photo (lib/api's updateMemberProfile rings PROFILE_SAVED_EVENT): read again, and shown.
        vi.mocked(getMemberProfile).mockResolvedValue(profile('data:image/jpeg;base64,AAAA'));
        // Resolved when the test runs, not when the file loads, so the cog's tests above report on their own.
        const savedModule = './lib/profile-saved';
        const { PROFILE_SAVED_EVENT } = await import(/* @vite-ignore */ savedModule);
        act(() => { window.dispatchEvent(new Event(PROFILE_SAVED_EVENT)); });
        await waitFor(() => expect(within(profileButton()).getByRole('img', { name: 'Your Photo' })).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA'));
    });

    it('no picture, or one that is not a safe form: the initials', async () => {
        vi.mocked(getMemberProfile).mockResolvedValue(profile('javascript:alert(1)'));
        await landed();
        await waitFor(() => expect(getMemberProfile).toHaveBeenCalled());
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
        expect(within(profileButton()).queryByRole('img')).toBeNull();
        expect(within(profileButton()).getByText('AL')).toBeInTheDocument();
    });

    it('a picture that fails to load: the initials, not a broken image', async () => {
        vi.mocked(getMemberProfile).mockResolvedValue(profile('/avatars/gone.jpg'));
        await landed();
        const img = await within(profileButton()).findByRole('img', { name: 'Your Photo' });
        fireEvent.error(img);
        await waitFor(() => expect(within(profileButton()).queryByRole('img')).toBeNull());
        expect(within(profileButton()).getByText('AL')).toBeInTheDocument();
    });

    it('a key the node does not take as a member: nothing is asked, the initials show', async () => {
        standing.isMember = false;
        await landed();
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(getMemberProfile).not.toHaveBeenCalled();
        expect(within(profileButton()).getByText('AL')).toBeInTheDocument();
    });
});
