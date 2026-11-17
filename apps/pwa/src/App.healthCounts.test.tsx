/**
 * The header's community status (opened from its title) on a node whose owners share no counts (Share Member Count off,
 * #3292): the node gives the member and listing counts only to a reader it answers as a member, so
 *   - a count the answer left out is not drawn: never "Members: 0" (a suspended member, a visitor's row);
 *   - someone who signs in without reloading gets health read again as them, and sees the figures;
 *   - a member back with a stored key is read once at load, never twice;
 *   - a slow read made before the sign-in never lands on top of the member's read made after it.
 * The whole App, with the pages stood in for and the node's reads mocked at lib/api. Drawn in light and in dark.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const who = vi.hoisted(() => ({ stored: null as null | { publicKey: string; privateKey: string; callsign: string } }));
const welcome = vi.hoisted(() => ({ onComplete: null as null | ((id: unknown) => void) }));

vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => who.stored),
    updateCallsign: vi.fn(),
}));
vi.mock('./lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ commonsBalance_c: 0, profile: 'local', features: {} })),
    joinInFlight: vi.fn(async () => false),
}));
vi.mock('./pages/WelcomePage', () => ({
    WelcomePage: (props: { onComplete: (id: unknown) => void }) => { welcome.onComplete = props.onComplete; return <div data-testid="welcome-page" />; },
}));
vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/FormerAddressBanner', () => ({ FormerAddressBanner: () => null }));
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
    getMyUnread: vi.fn(async () => ({ unread: 0, requests: 0, asOf: '2026-11-01T00:00:00.000Z' })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 100, creditLimit: 50 })),
    getPulseFeed: vi.fn(async () => ({ items: [], nextCursor: null })),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'kim-key', callsign: 'Kim', role: 'member', bio: '' })),
    getMemberRatings: vi.fn(async () => []),
    getRatingsGiven: vi.fn(async () => []),
    getFriends: vi.fn(async () => []),
    getPublicChannels: vi.fn(async () => []),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getTreasuryDetail: vi.fn(async () => null),
    getTreasuries: vi.fn(async () => []),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
    getCommunityMe: vi.fn(async () => null),
}));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status" /> }));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/HomePage', () => ({ HomePage: () => <div data-testid="home-page" /> }));

import { App } from './App';
import { getCommunityHealth } from './lib/api';

const KIM = { publicKey: 'kim-key', privateKey: 'kim-priv', callsign: 'Kim' };
/** What a stranger, a suspended member or a visitor's row reads where the owners share no counts: no tree, no totals. */
const UNSHARED = { version: '1.4.7', nodeName: 'Riverbend', activity: {} };
/** What a member's signed read gets: the counts as the node gives them. */
const SHARED = { version: '1.4.7', nodeName: 'Riverbend', tree: { totalMembers: 14 }, activity: { totalPosts: 30 } };
const health = vi.mocked(getCommunityHealth);

beforeEach(() => {
    window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    localStorage.clear();
    who.stored = null;
    welcome.onComplete = null;
    health.mockReset();
    document.documentElement.classList.remove('dark');
});
afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('dark');
});

async function openStatus() {
    fireEvent.click(await screen.findByTestId('header-title'));
    return (await screen.findByText('Node:')).closest('.absolute') as HTMLElement;
}

for (const theme of ['light', 'dark'] as const) {
    describe(`the header's community status, in ${theme}`, () => {
        beforeEach(() => { if (theme === 'dark') document.documentElement.classList.add('dark'); });

        it('an answer without the counts (a suspended member, a visitor\'s row): no Members or Active Posts row, never a 0', async () => {
            who.stored = KIM;
            health.mockResolvedValue(UNSHARED);
            render(<App />);
            const panel = await openStatus();
            expect(within(panel).getByText('Riverbend')).toBeInTheDocument();
            expect(within(panel).queryByText('Members:')).toBeNull();
            expect(within(panel).queryByText('Active Posts:')).toBeNull();
            expect(screen.queryByTestId('community-status-members')).toBeNull();
            expect(screen.queryByTestId('community-status-posts')).toBeNull();
            expect([...panel.querySelectorAll('.font-mono')].map(n => n.textContent)).toEqual(['Riverbend']);
        });

        it('a member back with a stored key: health read once, at load, and the figures shown as the node gave them', async () => {
            who.stored = KIM;
            health.mockResolvedValue(SHARED);
            render(<App />);
            const panel = await openStatus();
            expect(within(screen.getByTestId('community-status-members')).getByText('14')).toBeInTheDocument();
            expect(within(screen.getByTestId('community-status-posts')).getByText('30')).toBeInTheDocument();
            expect(within(panel).getByText('Members:')).toBeInTheDocument();
            // Settled: nothing asks again for the key the page-load read already signed with.
            await act(async () => { await new Promise(r => setTimeout(r, 20)); });
            expect(health).toHaveBeenCalledTimes(1);
        });

        it('someone who signs in without reloading: health is read again as them, and the panel shows the figures', async () => {
            health.mockResolvedValueOnce(UNSHARED).mockResolvedValue(SHARED);
            render(<App />);
            await screen.findByTestId('welcome-page');
            expect(health).toHaveBeenCalledTimes(1);
            await act(async () => { welcome.onComplete!(KIM); });
            await waitFor(() => expect(health).toHaveBeenCalledTimes(2));
            await openStatus();
            expect(within(await screen.findByTestId('community-status-members')).getByText('14')).toBeInTheDocument();
            expect(within(screen.getByTestId('community-status-posts')).getByText('30')).toBeInTheDocument();
        });

        it("a slow read made before the sign-in never lands on top of the member's read made after it", async () => {
            let answerFirst: (h: unknown) => void = () => {};
            health.mockImplementationOnce(() => new Promise(r => { answerFirst = r as (h: unknown) => void; })).mockResolvedValue(SHARED);
            render(<App />);
            await screen.findByTestId('welcome-page');
            await act(async () => { welcome.onComplete!(KIM); });
            await waitFor(() => expect(health).toHaveBeenCalledTimes(2));
            await openStatus();
            await screen.findByTestId('community-status-members');
            await act(async () => { answerFirst(UNSHARED); await Promise.resolve(); });
            expect(within(screen.getByTestId('community-status-members')).getByText('14')).toBeInTheDocument();
            expect(within(screen.getByTestId('community-status-posts')).getByText('30')).toBeInTheDocument();
        });
    });
}
