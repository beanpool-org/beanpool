/**
 * The web app's block list is the one the community keeps for the account (Marty's card web-blocklist-where,
 * 2026-09-27): the whole App, signed in on a browser, reads it from the node, and on the first sign-in with this build
 * moves up a list an older build left in this browser, then deletes the local key.
 *
 * The node's routes are mocked at lib/api and the socket's subscriptions at lib/sync; lib/blocklist is the real one.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';
import * as api from './lib/api';
import { isUserBlocked, resetBlocklistForTests, BLOCKLIST_STORAGE_KEY, LEGACY_BLOCKLIST_KEY } from './lib/blocklist';

const ME = 'a1'.repeat(32);
const BO = 'b2'.repeat(32);
const CY = 'c3'.repeat(32);

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
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));

vi.mock('./lib/identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'a1'.repeat(32), privateKey: 'my-user-privkey', callsign: 'Alice' })),
    updateCallsign: vi.fn(),
}));

vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
}));

vi.mock('./lib/api', () => ({
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.26' })),
    getMyActiveRecoveryCollections: vi.fn(async () => []),
    getCommunityMe: vi.fn(async () => ({ publicKey: 'a1'.repeat(32), mute: { muted: false, until: null } })),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(),
    reportAbuse: vi.fn(async () => ({ success: true })),
    getBlockList: vi.fn(),
    addToBlockList: vi.fn(),
    removeFromBlockList: vi.fn(),
    clearBlockList: vi.fn(),
}));

const listOf = (keys: string[]) => ({ blocked: keys.map(k => ({ publicKey: k, blockedAt: '2026-09-27T00:00:00.000Z' })), max: 500 });
const storedAboutBlocks = () => Object.keys(localStorage).filter(k => /block/i.test(k));

describe('The web app keeps no block list of its own: the community keeps it for the account', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        resetBlocklistForTests();
    });

    it('signed in on a fresh browser, the list comes from the community, and nothing about it is stored here', async () => {
        vi.mocked(api.getBlockList).mockResolvedValue(listOf([BO]));
        render(<App />);
        await waitFor(() => expect(api.getBlockList).toHaveBeenCalled());
        await waitFor(() => expect(isUserBlocked(BO)).toBe(true));
        expect(isUserBlocked(CY)).toBe(false);
        expect(api.addToBlockList).not.toHaveBeenCalled();
        expect(storedAboutBlocks()).toEqual([]);
    });

    it('the first sign-in with this build moves a list an older build kept here up to the account, then deletes the local key', async () => {
        // The member's own key in an old list (a build from before let one in) is not moved up.
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([BO, ME, CY]));
        localStorage.setItem(LEGACY_BLOCKLIST_KEY, JSON.stringify([BO, CY]));
        vi.mocked(api.getBlockList).mockResolvedValue(listOf([]));
        vi.mocked(api.addToBlockList).mockResolvedValue({ ...listOf([BO, CY]), added: [BO, CY] });
        render(<App />);
        await waitFor(() => expect(api.addToBlockList).toHaveBeenCalledWith([BO, CY]));
        await waitFor(() => expect(storedAboutBlocks()).toEqual([]));
        expect(isUserBlocked(BO) && isUserBlocked(CY)).toBe(true);
        expect(api.addToBlockList).toHaveBeenCalledTimes(1);
    });
});
