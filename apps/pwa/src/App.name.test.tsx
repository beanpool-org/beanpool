/**
 * The web app's name for its member is the community's (#1231's confirmation, NON-BLOCKING 4113964261 and 4113964223).
 * The node may number a joining name another member holds ("Sam" becomes "Sam2") or cut it to 20, and a rename can land
 * on the node while this browser fails to keep it. When the app opens, the node's name for this key is adopted, and no
 * register goes that would rename the member back to this browser's old copy (`/api/community/register` renames an
 * existing member to whatever name it is sent: engine/members.ts registerMemberInternal).
 *
 * The whole App, with the stored identity real (an in-memory IndexedDB) and the node's reads mocked at lib/api.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { App } from './App';
import * as api from './lib/api';
import { generateIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from './lib/identity';
import { memoryIndexedDB } from './lib/memory-indexeddb';

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
    registerMember: vi.fn(),
    checkMembership: vi.fn(),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.26' })),
    getMyActiveRecoveryCollections: vi.fn(async () => []),
    getCommunityMe: vi.fn(async () => null),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(),
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

describe('a member whose name the node has differently: this browser takes the node\'s, and never renames the member back', () => {
    it.each([
        ['a name another member held, numbered at the join', 'Sam', 'Sam2'],
        ['a name longer than a join keeps, cut to 20', 'Rowan of the Valley Farm Wren', 'Rowan of the Valley'],
        ['a rename the node took and this browser could not keep', 'Rowan', 'Robin'],
    ])('%s: this browser keeps the node\'s name and shows it, and sends nothing that renames the member', async (_what, here, node) => {
        await storedAs(here);
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true, callsign: node });
        await openApp();

        await waitFor(() => expect(shownName()).toBe(node));
        // Only the name follows the node: the key, the 12 words and the rest are this browser's as they were.
        expect(await loadIdentity()).toEqual({ ...saved, callsign: node });
        expect(api.registerMember).not.toHaveBeenCalledWith(saved.publicKey, here);
        expect(vi.mocked(api.registerMember).mock.calls.every(([, sent]) => sent === node)).toBe(true);
    });

    it('opened again after that: the node\'s name is the one this browser has, and nothing changes', async () => {
        await storedAs('Sam2');
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true, callsign: 'Sam2' });
        await openApp();

        expect(shownName()).toBe('Sam2');
        expect(await loadIdentity()).toEqual(saved);
        expect(vi.mocked(api.registerMember).mock.calls.every(([, sent]) => sent === 'Sam2')).toBe(true);
    });

    it('a name left empty here (restored while offline) still takes the node\'s', async () => {
        await storedAs('');
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true, callsign: 'Sam' });
        await openApp();

        await waitFor(() => expect(shownName()).toBe('Sam'));
        expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Sam' });
    });

    it('a member the node answers without a name (a node that names a key only to its holder): nothing changes, and nothing renames them', async () => {
        await storedAs('Sam');
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true, callsign: null });
        await openApp();

        expect(await loadIdentity()).toEqual(saved);
        expect(api.registerMember).not.toHaveBeenCalled();
    });

    it('the node not answering: no register goes on this browser\'s word alone', async () => {
        await storedAs('Rowan');
        vi.mocked(api.checkMembership).mockRejectedValue(new Error('Failed to fetch'));
        await openApp();

        expect(await loadIdentity()).toEqual(saved);
        expect(api.registerMember).not.toHaveBeenCalled();
    });
});

describe('a key the node does not have as a member: the register goes as before, and its answer for this key is the name', () => {
    it('the register answers another name for this key: this browser keeps it', async () => {
        await storedAs('Sam');
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: false, callsign: null });
        vi.mocked(api.registerMember).mockImplementation(async (publicKey) => card(publicKey, 'Sam2'));
        await openApp();

        expect(api.registerMember).toHaveBeenCalledWith(saved.publicKey, 'Sam');
        await waitFor(async () => expect(await loadIdentity()).toEqual({ ...saved, callsign: 'Sam2' }));
    });

    it('an answer about another key changes nothing here', async () => {
        await storedAs('Sam');
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: false, callsign: null });
        vi.mocked(api.registerMember).mockResolvedValue(card('a-neighbour', 'Mallory'));
        await openApp();

        expect(api.registerMember).toHaveBeenCalledWith(saved.publicKey, 'Sam');
        expect(await loadIdentity()).toEqual(saved);
        expect(shownName()).toBe('Sam');
    });

    it('a register the node refuses (no open door here) changes nothing', async () => {
        await storedAs('Sam');
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: false, callsign: null });
        vi.mocked(api.registerMember).mockResolvedValue({ success: true, member: null as any });
        await openApp();

        expect(await loadIdentity()).toEqual(saved);
    });
});
