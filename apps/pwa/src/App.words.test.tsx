/**
 * The app shell in the member's language (words S3, web sweep W3): the tab names (the phone's tab words), the mobile
 * header's title and its pill, the sidebar, and the community's status under the title, in the pseudo-locale (`xx`).
 * The tabs' own screens are their sweeps' (Home S2, the Market W1, ...), so this checks the shell alone. And a
 * language change redraws the shell at once, each tab's share of the row following its name in that language.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { App, navTabWeight } from './App';
import { backToEnglish, bracketed, showIn, xx } from './words-xx.test-support';
import { AS_WRITTEN, bypassing } from './words-w3.test-support';

window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
    matches: false, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
}));

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'my-user-pubkey', privateKey: 'my-user-privkey', callsign: 'Alice' })),
    updateCallsign: vi.fn(),
}));
vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSyncActivity: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
}));
vi.mock('./lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.18', nodeName: 'Riverbend', memberCount: 14, postCount: 30 })),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 100, creditLimit: 50 })),
    getPulseFeed: vi.fn(async () => ({ items: [], nextCursor: null })),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'my-user-pubkey', callsign: 'Alice', role: 'member', bio: '', elderVouchedBy: null })),
    getMemberRatings: vi.fn(async () => []),
    getRatingsGiven: vi.fn(async () => []),
    getFriends: vi.fn(async () => []),
    getPublicChannels: vi.fn(async () => []),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getTreasuryDetail: vi.fn(async () => null),
    getTreasuries: vi.fn(async () => []),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
}));
// The tabs' screens are their own sweeps': stand-ins, so the shell is what is drawn.
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status" /> }));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/HomePage', () => ({ HomePage: () => <div data-testid="home-page" /> }));

const TAB_WORDS = ['Home', 'Market', 'Map', 'Commons', 'Chat', 'People', 'Ledger'];

beforeEach(() => { localStorage.clear(); });
afterEach(() => { backToEnglish(); });

async function openApp() {
    render(<App />);
    return screen.findByTestId('mobile-bottom-nav');
}
const shellUnwrapped = () => [
    screen.getByTestId('mobile-bottom-nav'),
    document.querySelector('aside')!,
    screen.getByTestId('header-pill'),
    screen.getByTestId('header-title').parentElement!,
].flatMap((el) => bypassing(el, { others: ['Alice', 'AL', 'Riverbend', ...AS_WRITTEN] }));

describe('the app shell in the pseudo-locale: every word on it came through t() (words W3)', () => {
    it('the tab names, the header\'s title and pill, the sidebar, and the community\'s status under the title', async () => {
        await showIn('xx');
        const nav = await openApp();
        expect([...nav.querySelectorAll('[data-nav-label]')].map((l) => l.textContent)).toEqual(TAB_WORDS.map((w) => xx(w)));
        expect(screen.getByTestId('header-title')).toHaveTextContent(xx('Home'));
        expect(within(screen.getByTestId('header-pill')).getByRole('button', { name: xx('Help for this screen') })).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('header-title'));
        expect(await screen.findByText(xx('Members:'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(15);
        expect(shellUnwrapped()).toEqual([]);
        // Each tab's share of the row follows its name as drawn (a longer language's longer word gets the room).
        for (const label of nav.querySelectorAll<HTMLElement>('[data-nav-label]')) {
            expect((label.closest('button') as HTMLButtonElement).style.flexGrow).toBe(String(navTabWeight(label.textContent!)));
        }
    });

    it('a language change redraws the shell at once: from English to the pseudo-locale and back', async () => {
        const nav = await openApp();
        expect(within(nav).getByText('Market')).toBeInTheDocument();
        await showIn('xx');
        expect(within(nav).getByText(xx('Market'))).toBeInTheDocument();
        expect(screen.getByTestId('header-title')).toHaveTextContent(xx('Home'));
        await act(async () => { backToEnglish(); });
    });
});
