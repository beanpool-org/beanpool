/**
 * The wide screen's sidebar (md+), from a tester's two reports (23 Oct):
 *
 * 1. "when i click on my profile, then i can't click on the settings cog, but if i click on home i can". A member's
 *    profile, an enterprise's page and a tool are each drawn over the tabs at z-[110], beside the sidebar; Settings is
 *    drawn at 100, under them. The cog only opened Settings, so it opened under the page already there and nothing
 *    seemed to happen; a tab worked because a tab closes that page first.
 * 2. "Avatar didn't seem to populate into the small icon in the bottom left": the sidebar's profile button drew the
 *    name's first two letters and never the member's picture. With no picture it now draws the ready-made one the key
 *    picks, never bare initials (Profile S1, DESIGN-per-community-profile-fable.md §3 "No picture yet").
 *
 * The whole App, with the pages stood in for and the node's reads mocked at lib/api. jsdom applies no stylesheet, so the
 * sidebar is in the document at any width: these tests drive it as a wide screen would.
 */
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';
import { getMemberProfile } from './lib/api';
import { resolveAvatarUrl } from './lib/avatar';

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

// The pages that open over the tabs, as App mounts them: each its own fixed layer at z-[110], with its own Back and
// its ways out to the rest of the app.
type ProfileWays = {
    pubkey: string; onBack: () => void; onOpenTreasury: (pk: string) => void; onMessage: (pk: string) => void;
    onNavigatePost: (id: string) => void; onEditProfile: () => void; onNavigateTab: (tab: string, subView?: string) => void;
};
vi.mock('./pages/PublicProfilePage', () => ({
    PublicProfilePage: ({ pubkey, onBack, onOpenTreasury, onMessage, onNavigatePost, onEditProfile, onNavigateTab }: ProfileWays) => (
        <div data-testid="profile-overlay" data-pubkey={pubkey} className="page-overlay z-[110]">
            <button onClick={onBack}>Back from profile</button>
            <button onClick={() => onOpenTreasury('some-treasury-pubkey')}>Profile: open an enterprise</button>
            <button onClick={() => onMessage('someone-pubkey')}>Profile: Message</button>
            <button onClick={() => onNavigatePost('post-1')}>Profile: open a post</button>
            <button onClick={onEditProfile}>Profile: Edit profile</button>
            <button onClick={() => onNavigateTab('people', 'friends')}>Profile: People</button>
            <button onClick={() => onNavigateTab('guide', 'some-page')}>Profile: How it works</button>
        </div>
    ),
}));
type EnterpriseWays = { onBack: () => void; onNearYou: () => void; onGuide: (slug: string) => void; onNavigatePost: (id: string) => void };
vi.mock('./pages/TreasuryDetailPage', () => ({
    TreasuryDetailPage: ({ onBack, onNearYou, onGuide, onNavigatePost }: EnterpriseWays) => (
        <div data-testid="treasury-overlay" className="page-overlay z-[110]">
            <button onClick={onBack}>Back from enterprise</button>
            <button onClick={onNearYou}>Enterprise: Near you</button>
            <button onClick={() => onGuide('some-page')}>Enterprise: How it works</button>
            <button onClick={() => onNavigatePost('post-1')}>Enterprise: open a post</button>
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
vi.mock('./pages/MessagesPage', () => ({ MessagesPage: () => <div data-testid="messages-page" /> }));
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => <div data-testid="people-page" /> }));
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

    // Review (22 Oct): the sidebar's "?" can be tapped with a page open beside it, and the Help dialog's two ways into
    // the guide opened Settings under that page, as the cog did.
    it('the Help dialog\'s Search the guide, from a profile: Settings shows and the profile closes', async () => {
        await landed();
        fireEvent.click(profileButton());
        await screen.findByTestId('profile-overlay');

        fireEvent.click(within(sidebar()).getByTestId('sidebar-help'));
        fireEvent.click(await screen.findByTestId('help-search'));
        expect(await screen.findByTestId('settings-overlay')).toBeInTheDocument();
        expect(screen.queryByTestId('profile-overlay')).toBeNull();
        expect(screen.queryByTestId('help-dialog')).toBeNull();
    });

    it('the Help dialog\'s Read the guide page, from an enterprise\'s page: Settings shows and that page closes', async () => {
        await landed();
        fireEvent.click(within(sidebar()).getByRole('button', { name: /Commons/ }));
        fireEvent.click(await screen.findByText('Open Treasury'));
        await screen.findByTestId('treasury-overlay');

        fireEvent.click(within(sidebar()).getByTestId('sidebar-help'));
        fireEvent.click(await screen.findByTestId('help-read-page'));
        expect(await screen.findByTestId('settings-overlay')).toBeInTheDocument();
        expect(screen.queryByTestId('treasury-overlay')).toBeNull();
        expect(screen.queryByTestId('help-dialog')).toBeNull();
    });

    it('the Help dialog\'s Search the guide, from a tool: Settings shows and the tool closes', async () => {
        await landed();
        fireEvent.click(screen.getByText('Open Tools'));
        await screen.findByTestId('tools-overlay');

        fireEvent.click(within(sidebar()).getByTestId('sidebar-help'));
        fireEvent.click(await screen.findByTestId('help-search'));
        expect(await screen.findByTestId('settings-overlay')).toBeInTheDocument();
        expect(screen.queryByTestId('tools-overlay')).toBeNull();
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

// Review (22 Oct): a tool is drawn at z-[110] from the sidebar's edge, so the sidebar's profile button is tapped with
// one open, and the profile (or an enterprise's page opened from it) is drawn over the tool. Their ways out to the rest
// of the app closed only themselves: the tool stayed on top, over the tab they opened, and over Settings at z 100.
describe('a profile or an enterprise\'s page opened over a tool: leaving it for the app closes the tool too', () => {
    beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); standing.isMember = true; });

    async function profileOverATool() {
        await landed();
        fireEvent.click(screen.getByText('Open Tools'));
        await screen.findByTestId('tools-overlay');
        fireEvent.click(profileButton());
        await screen.findByTestId('profile-overlay');
    }
    async function enterpriseOverATool() {
        await profileOverATool();
        fireEvent.click(screen.getByText('Profile: open an enterprise'));
        await screen.findByTestId('treasury-overlay');
        expect(screen.queryByTestId('profile-overlay')).toBeNull();
        expect(screen.getByTestId('tools-overlay')).toBeInTheDocument();
    }

    it.each([
        ['Profile: Edit profile', 'settings-overlay'],
        ['Profile: How it works', 'settings-overlay'],
        ['Profile: Message', 'messages-page'],
        ['Profile: open a post', 'marketplace-page'],
        ['Profile: People', 'people-page'],
    ])('the profile\'s %s: lands on %s with nothing over it', async (exit, landing) => {
        await profileOverATool();
        fireEvent.click(screen.getByText(exit));
        expect(await screen.findByTestId(landing)).toBeInTheDocument();
        expect(screen.queryByTestId('profile-overlay')).toBeNull();
        expect(screen.queryByTestId('tools-overlay')).toBeNull();
    });

    it.each([
        ['Enterprise: Near you', 'home-page'],
        ['Enterprise: How it works', 'settings-overlay'],
        ['Enterprise: open a post', 'marketplace-page'],
    ])('the enterprise\'s %s: lands on %s with nothing over it', async (exit, landing) => {
        await enterpriseOverATool();
        fireEvent.click(screen.getByText(exit));
        expect(await screen.findByTestId(landing)).toBeInTheDocument();
        expect(screen.queryByTestId('treasury-overlay')).toBeNull();
        expect(screen.queryByTestId('tools-overlay')).toBeNull();
    });

    it('Back from either keeps the tool, the layer it was opened over', async () => {
        await enterpriseOverATool();
        fireEvent.click(screen.getByText('Back from enterprise'));
        await waitFor(() => expect(screen.queryByTestId('treasury-overlay')).toBeNull());
        expect(screen.getByTestId('tools-overlay')).toBeInTheDocument();

        fireEvent.click(profileButton());
        await screen.findByTestId('profile-overlay');
        fireEvent.click(screen.getByText('Back from profile'));
        await waitFor(() => expect(screen.queryByTestId('profile-overlay')).toBeNull());
        expect(screen.getByTestId('tools-overlay')).toBeInTheDocument();
    });
});

describe('the sidebar\'s profile button shows the member\'s own picture', () => {
    beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); standing.isMember = true; });

    const profile = (avatar: string | null) => ({ publicKey: 'my-user-pubkey', avatar, bio: '', contact: null });
    /** The ready-made picture the key picks (@beanpool/core avatarPresetForPubkey), as every other face on the web. */
    const PRESET = resolveAvatarUrl(null, 'my-user-pubkey')!;
    /** The preset, and never the name's first letters in its place. */
    const showsPreset = () => {
        expect(within(profileButton()).getByRole('img', { name: 'Your Photo' })).toHaveAttribute('src', PRESET);
        expect(within(profileButton()).queryByText('AL')).toBeNull();
        expect(within(profileButton()).queryByText('ME')).toBeNull();
    };

    it('the preset while it loads, then the picture, and the new one once the profile is saved', async () => {
        let answer!: (p: ReturnType<typeof profile>) => void;
        vi.mocked(getMemberProfile).mockImplementationOnce(() => new Promise((r) => { answer = r; }));
        await landed();

        await waitFor(() => expect(getMemberProfile).toHaveBeenCalledWith('my-user-pubkey', 'my-user-pubkey'));
        expect(PRESET).toMatch(/^\/avatars\/avatar_[a-z_]+\.webp$/);
        showsPreset();

        await act(async () => { answer(profile('bundled://sun')); });
        // The stored picture, through lib/avatar's safe forms (a bundled one is the app's own file).
        expect(await within(profileButton()).findByRole('img', { name: 'Your Photo' })).toHaveAttribute('src', '/avatars/avatar_sun.webp');
        expect(within(profileButton()).queryByText('AL')).toBeNull();

        // Saved with a new photo (lib/api's updateMemberProfile rings PROFILE_SAVED_EVENT): read again, and shown.
        vi.mocked(getMemberProfile).mockResolvedValue(profile('data:image/jpeg;base64,AAAA'));
        // Resolved when the test runs, not when the file loads, so the cog's tests above report on their own.
        const savedModule = './lib/profile-saved';
        const { PROFILE_SAVED_EVENT } = await import(/* @vite-ignore */ savedModule);
        act(() => { window.dispatchEvent(new Event(PROFILE_SAVED_EVENT)); });
        await waitFor(() => expect(within(profileButton()).getByRole('img', { name: 'Your Photo' })).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA'));
    });

    it('a save read that answers before the first read: the saved picture stays, the older answer is dropped', async () => {
        const answers: ((p: ReturnType<typeof profile>) => void)[] = [];
        vi.mocked(getMemberProfile).mockImplementation(() => new Promise((r) => { answers.push(r); }));
        await landed();
        await waitFor(() => expect(answers).toHaveLength(1));

        const savedModule = './lib/profile-saved';
        const { PROFILE_SAVED_EVENT } = await import(/* @vite-ignore */ savedModule);
        act(() => { window.dispatchEvent(new Event(PROFILE_SAVED_EVENT)); });
        await waitFor(() => expect(answers).toHaveLength(2));

        await act(async () => { answers[1](profile('bundled://moon')); });
        expect(await within(profileButton()).findByRole('img', { name: 'Your Photo' })).toHaveAttribute('src', '/avatars/avatar_moon.webp');
        await act(async () => { answers[0](profile('bundled://sun')); });
        expect(within(profileButton()).getByRole('img', { name: 'Your Photo' })).toHaveAttribute('src', '/avatars/avatar_moon.webp');
    });

    it('no picture, or one that is not a safe form: the preset, never the unsafe value', async () => {
        vi.mocked(getMemberProfile).mockResolvedValue(profile('javascript:alert(1)'));
        await landed();
        await waitFor(() => expect(getMemberProfile).toHaveBeenCalled());
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
        showsPreset();
    });

    it('a picture that fails to load: the preset, not a broken image', async () => {
        vi.mocked(getMemberProfile).mockResolvedValue(profile('/avatars/gone.jpg'));
        await landed();
        await waitFor(() => expect(within(profileButton()).getByRole('img', { name: 'Your Photo' })).toHaveAttribute('src', '/avatars/gone.jpg'));
        fireEvent.error(within(profileButton()).getByRole('img', { name: 'Your Photo' }));
        await waitFor(() => showsPreset());
    });

    it('a key the node does not take as a member: nothing is asked, the preset shows', async () => {
        standing.isMember = false;
        await landed();
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(getMemberProfile).not.toHaveBeenCalled();
        showsPreset();
    });
});
