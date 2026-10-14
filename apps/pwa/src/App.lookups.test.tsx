/**
 * The web app's recent searches and "near you" answers (lib/members-on-demand, kept two minutes so nothing is asked of a
 * member's daily budget in the background) are kept by path alone, so App forgets them whenever the signed-in account
 * changes (#1965 review N5; confirmation finding 4). Here the change is the stored account signing in: a search kept
 * before it is asked of the node again after it.
 *
 * The whole App, as App.name.test.tsx runs it: the stored identity real (an in-memory IndexedDB), the node's reads mocked.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { App } from './App';
import * as api from './lib/api';
import { generateIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from './lib/identity';
import { memoryIndexedDB } from './lib/memory-indexeddb';
import { searchMembers, forgetRecentLookups } from './lib/members-on-demand';

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false, media: '', onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
}

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => <div>Profile setup</div> }));
vi.mock('./components/NewAccountCard', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./components/NewAccountCard')>()),
    NewAccountCard: () => null,
}));
vi.mock('./pages/MarketplacePage', () => ({
    MarketplacePage: ({ identity }: { identity: BeanPoolIdentity }) => <div data-testid="marketplace-page">{identity.callsign}</div>,
}));
vi.mock('./lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));

vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
}));

vi.mock('./lib/api', () => ({
    // The page's own server unless Settings points it elsewhere: App reads it for the web app's update banner.
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(),
    checkMembership: vi.fn(),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.26' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getCommunityMe: vi.fn(async () => null),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(),
    getMemberCards: vi.fn(async () => [{ publicKey: 'e'.repeat(64), callsign: 'Alma', joinedAt: '2026-01-01T00:00:00.000Z' }]),
}));

let saved: BeanPoolIdentity;

/** This browser's account, saved as `callsign`. */
async function storedAs(callsign: string) {
    saved = await generateIdentity(callsign);
    await importIdentity(saved);
}

/** The member card the node's register answers with (routes/community.ts: the whole row). */
const card = (publicKey: string, callsign: string) => ({ success: true, member: { publicKey, callsign } as any });

/** The name the app hands its pages. */
const shownName = () => screen.getByTestId('marketplace-page').textContent;

/** Opened, and every read the app makes on opening settled. */
async function openApp() {
    render(<App />);
    // Members land on Home (DESIGN-home-dashboard-fable.md §8); the Market's stand-in, which shows the name the app
    // hands its pages, is one tap away.
    const nav = await screen.findByTestId('mobile-bottom-nav');
    fireEvent.click(within(nav).getByText('Market'));
    await screen.findByTestId('marketplace-page');
    await waitFor(() => expect(api.checkMembership).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.mocked(api.registerMember).mockImplementation(async (publicKey, callsign) => card(publicKey, callsign));
});
afterEach(() => {
    vi.unstubAllGlobals();
});


describe('the kept searches are forgotten when the signed-in account changes', () => {
    it('a search kept before the account signs in is asked of the node again after', async () => {
        forgetRecentLookups();
        await searchMembers('al');
        await searchMembers('al');
        expect(api.getMemberCards).toHaveBeenCalledTimes(1);
        await storedAs('Sam');
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true, callsign: 'Sam' });
        await openApp();
        await searchMembers('al');
        expect(api.getMemberCards).toHaveBeenCalledTimes(2);
    });
});
