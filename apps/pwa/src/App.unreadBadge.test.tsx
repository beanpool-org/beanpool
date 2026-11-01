/**
 * The Chat badge and the browser tab (chat stage 1, S1.2: scratch/fable-design/DESIGN-cross-community-chat-fable.md §1.2 R3,
 * §1.3). The badge asks GET /api/me/unread for its number and no longer reads the whole conversation list for it; the tab
 * shows the same number; and a message request makes neither move until it is accepted (Marty, 1 Nov 2026). The web app
 * reads its own community only: a browser at one origin can't sign for another.
 *
 * The badge is drawn by the app shell, not MessagesPage: the whole App, with the pages stood in for and the node's reads
 * mocked at lib/api.
 */
import { render, screen, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { App } from './App';
import { getConversations, getMyMarketplaceTransactions, getMyUnread } from './lib/api';

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
vi.mock('./components/OneWayBack', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./components/OneWayBack')>()),
    OneWayBackCard: () => null,
}));
vi.mock('./pages/HomePage', () => ({ HomePage: () => <div data-testid="home-page" /> }));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
vi.mock('./pages/MessagesPage', () => ({ MessagesPage: () => <div data-testid="messages-page" /> }));
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

vi.mock('./lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} })),
    joinInFlight: vi.fn(async () => false),
}));

const asOf = '2026-11-01T00:00:00.000Z';

vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getMyUnread: vi.fn(),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.28' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getCommunityMe: vi.fn(async () => null),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(),
}));

/** The Chat tab's row in the sidebar: the badge is the last thing in it. */
async function chatRow(): Promise<HTMLElement> {
    await screen.findByTestId('home-page');
    const aside = document.querySelector('aside') as HTMLElement;
    return await within(aside).findByRole('button', { name: /Chat/ });
}

/** Comes back to the tab: the poll that a member's return makes, at once. */
async function comeBack(): Promise<void> {
    await act(async () => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

describe('the Chat badge and the tab read the counts route', () => {
    beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); document.title = 'BeanPool'; });
    afterEach(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); });

    it('shows `unread`, in the badge and the tab, without reading the conversation list', async () => {
        vi.mocked(getMyUnread).mockResolvedValue({ unread: 7, requests: 0, asOf });
        render(<App />);
        const row = await chatRow();
        await waitFor(() => expect(row.textContent).toContain('7'));
        expect(document.title).toBe('(7) BeanPool');
        expect(getConversations).not.toHaveBeenCalled();
    });

    it('a message request makes no badge and no number in the tab', async () => {
        vi.mocked(getMyUnread).mockResolvedValue({ unread: 0, requests: 4, asOf });
        render(<App />);
        const row = await chatRow();
        await waitFor(() => expect(getMyUnread).toHaveBeenCalled());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(row.textContent).not.toMatch(/\d/);
        expect(document.title).toBe('BeanPool');
    });

    it('requests never add to the lines beside them', async () => {
        vi.mocked(getMyUnread).mockResolvedValue({ unread: 2, requests: 40, asOf });
        render(<App />);
        const row = await chatRow();
        await waitFor(() => expect(row.textContent).toContain('2'));
        expect(row.textContent).not.toContain('42');
        expect(document.title).toBe('(2) BeanPool');
    });

    it('past 99 both say 99+', async () => {
        vi.mocked(getMyUnread).mockResolvedValue({ unread: 120, requests: 0, asOf });
        render(<App />);
        const row = await chatRow();
        await waitFor(() => expect(row.textContent).toContain('99+'));
        expect(document.title).toBe('(99+) BeanPool');
    });

    it('both clear when the lines are read', async () => {
        vi.mocked(getMyUnread).mockResolvedValue({ unread: 3, requests: 0, asOf });
        render(<App />);
        const row = await chatRow();
        await waitFor(() => expect(document.title).toBe('(3) BeanPool'));
        vi.mocked(getMyUnread).mockResolvedValue({ unread: 0, requests: 0, asOf });
        await comeBack();
        await waitFor(() => expect(document.title).toBe('BeanPool'));
        expect(row.textContent).not.toMatch(/\d/);
    });

    it('a refused read keeps the number it had, and the deals are still read', async () => {
        vi.mocked(getMyUnread).mockResolvedValue({ unread: 5, requests: 0, asOf });
        render(<App />);
        const row = await chatRow();
        await waitFor(() => expect(row.textContent).toContain('5'));
        vi.mocked(getMyMarketplaceTransactions).mockClear();
        vi.mocked(getMyUnread).mockRejectedValue(new Error('offline'));
        await comeBack();
        await waitFor(() => expect(getMyMarketplaceTransactions).toHaveBeenCalled());
        expect(row.textContent).toContain('5');
        expect(document.title).toBe('(5) BeanPool');
    });
});
