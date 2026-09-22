import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
// The stylesheet as text: jsdom applies no CSS, so the rules .page-overlay must carry are asserted
// against the source. It is read off disk rather than imported, because vitest stubs a CSS import to
// the empty string, `?raw` and all; and by import.meta.dirname rather than new URL(..., import.meta.url),
// which Vite rewrites at transform time into a served http asset URL.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

vi.mock('./pages/SettingsPage', () => ({
    SettingsPage: ({ onBack, onReRunSetup }: { onBack: () => void; onReRunSetup?: () => void }) => (
        <>
            <button onClick={onBack}>← Back</button>
            <button onClick={onReRunSetup}>Re-run setup</button>
        </>
    ),
}));

vi.mock('./components/ProfileSetup', () => ({
    ProfileSetup: () => <div>Profile setup</div>,
}));

describe('App mobile bottom nav dynamic visibility & CSS variable regression (#791 / #792)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.documentElement.removeAttribute('data-bottom-nav');
        document.documentElement.classList.remove('bottom-nav-hidden');
        document.documentElement.style.removeProperty('--bottom-nav-height');
        document.documentElement.style.removeProperty('--bottom-nav-offset');
    });

    // Visibility is asserted through classes, not computed `display`. jsdom loads no stylesheet
    // here, so getComputedStyle only ever saw the element's INLINE style — which is exactly the
    // inline `display` that was overriding `md:hidden` and putting the bottom bar on desktop
    // beside the sidebar. Asserting on it would re-require the bug these tests now guard against.
    it('renders bottom nav as visible on default tabs and hides it when opening a profile', async () => {
        render(<App />);

        // Wait for identity to load and marketplace to mount
        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });

        const bottomNav = screen.getByTestId('mobile-bottom-nav');
        expect(bottomNav).toBeInTheDocument();
        expect(bottomNav.classList.contains('flex')).toBe(true);
        expect(bottomNav.classList.contains('hidden')).toBe(false);

        // Document root should not have data-bottom-nav=hidden
        expect(document.documentElement.getAttribute('data-bottom-nav')).toBeNull();
        expect(document.documentElement.classList.contains('bottom-nav-hidden')).toBe(false);

        // Open a profile
        const openProfileBtn = screen.getByText('Open Peer Profile');
        fireEvent.click(openProfileBtn);

        // Once profile is open, bottom nav must be hidden
        await waitFor(() => {
            expect(bottomNav.classList.contains('hidden')).toBe(true);
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
            expect(bottomNav.classList.contains('flex')).toBe(true);
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
        expect(bottomNav.classList.contains('flex')).toBe(true);

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
            expect(bottomNav.classList.contains('hidden')).toBe(true);
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
            expect(bottomNav.classList.contains('flex')).toBe(true);
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

// On a phone the mobile header is sticky at zIndex 100. Overlays that carry their own Back bar
// were mounted at z-50 / zIndex 60, so Back sat under the header and a tap on it did nothing.
describe('Overlays with their own Back bar stack above the mobile header', () => {
    const mobileHeader = () => document.querySelector('header.md\\:hidden') as HTMLElement;

    it('draws the profile and enterprise pages above the header', async () => {
        render(<App />);
        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });
        expect(mobileHeader().style.zIndex).toBe('100');

        // `fixed inset-0` became `.page-overlay`: the same fixed layer, full bleed on a phone, but
        // stopping at the desktop sidebar instead of covering it (index.css). The stacking this
        // describe block is about — z-[110], over the zIndex-100 header — is unchanged.
        fireEvent.click(screen.getByText('Open Peer Profile'));
        const profile = await screen.findByTestId('page-overlay');
        expect(profile).toHaveClass('page-overlay', 'z-[110]');
        expect(profile).not.toHaveClass('inset-0');
        fireEvent.click(screen.getByRole('button', { name: /back/i }));
        await waitFor(() => expect(screen.queryByTestId('page-overlay')).not.toBeInTheDocument());

        fireEvent.click(within(screen.getByTestId('mobile-bottom-nav')).getByText(/Commons/i));
        fireEvent.click(await screen.findByText('Open Treasury'));
        const enterprise = await screen.findByTestId('page-overlay');
        expect(enterprise).toHaveClass('page-overlay', 'z-[110]');
        expect(enterprise).not.toHaveClass('inset-0');
    });

    it('draws Settings over the header but under the bottom nav, which stays usable', async () => {
        render(<App />);
        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });
        const header = mobileHeader();
        fireEvent.click(within(header).getByRole('button', { name: 'Settings' }));

        const back = await screen.findByRole('button', { name: '← Back' });
        const wrapper = back.closest('main > div') as HTMLElement;
        const nav = screen.getByTestId('mobile-bottom-nav');
        // The inline `position: fixed` moved into .page-overlay, which also insets the layer past the
        // desktop sidebar; the class is now what carries it. zIndex stayed inline on purpose.
        expect(wrapper).toHaveClass('page-overlay');
        // Equal zIndex: document order decides, so the header must come before Settings and the nav after.
        expect(wrapper.style.zIndex).toBe(header.style.zIndex);
        expect(wrapper.style.zIndex).toBe(nav.style.zIndex);
        expect(header.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(wrapper.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('draws profile setup above both the header and the bottom nav, so its last step\'s Back is tappable', async () => {
        render(<App />);
        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });
        const header = mobileHeader();
        fireEvent.click(within(header).getByRole('button', { name: 'Settings' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Re-run setup' }));

        const setup = await screen.findByTestId('profile-setup-overlay');
        const nav = screen.getByTestId('mobile-bottom-nav');
        expect(Number(setup.style.zIndex)).toBeGreaterThan(Number(header.style.zIndex));
        expect(Number(setup.style.zIndex)).toBeGreaterThan(Number(nav.style.zIndex));
    });
});

// ——— Full-page views and the desktop sidebar ———
// Settings, a member's profile and an enterprise page are mounted as fixed layers over the content
// column. At `inset: 0` they covered the whole viewport, the w-64 sidebar included. Since the doodle
// wallpaper landed, Settings' .page-surface is transparent, so on md+ the sidebar was plainly visible
// through a layer that swallowed every click on it. They now carry .page-overlay.
//
// jsdom applies no stylesheet, so the class is the assertion in the DOM tests and the stylesheet
// itself is read as text for the rules that class has to carry.
describe('Full-page views clear the desktop sidebar', () => {
    const sidebar = () => document.querySelector('aside.md\\:flex') as HTMLElement;

    it('mounts Settings as .page-overlay, outside the sidebar, whose tabs still close it', async () => {
        render(<App />);
        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });

        fireEvent.click(within(sidebar()).getByRole('button', { name: 'Settings' }));
        const overlay = await screen.findByTestId('settings-overlay');
        expect(overlay).toHaveClass('page-overlay');
        // Whatever else changes, the layer must not be a viewport-wide sheet again.
        expect(overlay.className).not.toContain('inset-0');
        expect(overlay.style.position).toBe('');

        // The sidebar is a sibling of the content column, never inside the layer that covers it.
        expect(overlay.contains(sidebar())).toBe(false);

        // And a sidebar tab leaves Settings — the handler was always there, the layer just ate the click.
        fireEvent.click(within(sidebar()).getByRole('button', { name: /Ledger/ }));
        await waitFor(() => expect(screen.queryByTestId('settings-overlay')).not.toBeInTheDocument());
    });

    it('mounts a profile as .page-overlay, outside the sidebar', async () => {
        render(<App />);
        await waitFor(() => {
            expect(screen.getByTestId('marketplace-page')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('Open Peer Profile'));
        const profile = await screen.findByTestId('page-overlay');
        expect(profile).toHaveClass('page-overlay');
        expect(profile.contains(sidebar())).toBe(false);
    });

    it('index.css insets .page-overlay past the sidebar on md+ and gives it the wallpaper over its own ground', () => {
        const css = readFileSync(join(import.meta.dirname, 'index.css'), 'utf8');

        const base = css.match(/\n\.page-overlay\s*\{([^}]*)\}/);
        expect(base).not.toBeNull();
        const baseBody = base![1];
        expect(baseBody).toMatch(/position:\s*fixed/);
        expect(baseBody).toMatch(/left:\s*0/);                                   // full bleed on a phone
        expect(baseBody).toMatch(/background-color:\s*var\(--page-ground\)/);    // opaque: no tab content through it
        expect(baseBody).toMatch(/background-image:\s*var\(--pattern-image\)/);  // and the wallpaper on top of it

        // md+ starts the layer at the sidebar's own w-64, so the sidebar is neither covered nor click-blocked.
        const md = css.match(/@media\s*\(min-width:\s*768px\)\s*\{\s*\.page-overlay\s*\{([^}]*)\}/);
        expect(md).not.toBeNull();
        expect(md![1]).toMatch(/left:\s*16rem/);

        // "Plain background" turns the pattern off, so the ground has to be the flat page colour these
        // pages had — the same pair .page-surface uses, light and dark.
        expect(css).toMatch(/:root\s*\{\s*--page-ground:\s*var\(--pattern-bg\)/);
        expect(css).toMatch(/:root\.plain-background\s*\{\s*--page-ground:\s*#fbfaf8/);
        expect(css).toMatch(/:root\.dark-theme\.plain-background\s*\{\s*--page-ground:\s*#1d231d/);
    });
});
