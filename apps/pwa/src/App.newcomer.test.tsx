/**
 * What a new member sees around the tabs (stranger rehearsal, 14 Oct 2026):
 *
 * - S1: "Your account is new" and "One way back" sat above every tab; at 320 px they pushed the Market, Commons and
 *   Ledger previews below the first screen. They show on Home only.
 * - B1: the install banner took the taps meant for the tour's Next and Skip. App holds it back while the tour runs or is
 *   still offered (Home's Getting started card up), and while a screen is drawn over the tabs.
 *
 * The whole App, with the pages stood in for and the node's reads mocked at lib/api.
 */
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';
import { closeTour, offerTour, startTour } from './lib/tour-store';

if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false, media: '', onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
}

vi.mock('./components/InstallPrompt', () => ({
    InstallPrompt: ({ hidden }: { hidden?: boolean }) => <div data-testid="install-prompt" data-held-back={String(!!hidden)} />,
}));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => <div data-testid="sync-status">Synced</div> }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => <div>Profile setup</div> }));
vi.mock('./components/NewAccountCard', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./components/NewAccountCard')>()),
    NewAccountCard: () => <div data-testid="new-account-card">Your account is new</div>,
}));
vi.mock('./components/OneWayBack', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./components/OneWayBack')>()),
    OneWayBackCard: () => <div data-testid="one-way-back">One way back</div>,
}));
vi.mock('./pages/HomePage', () => ({ HomePage: () => <div data-testid="home-page" /> }));
vi.mock('./pages/MarketplacePage', () => ({ MarketplacePage: () => <div data-testid="marketplace-page" /> }));
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

vi.mock('./lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    registerMember: vi.fn(async () => ({ ok: true })),
    checkMembership: vi.fn(async () => ({ isMember: true })),
    getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.28' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getCommunityMe: vi.fn(async () => null),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(),
}));

const PK = 'my-user-pubkey';
const NODE = { global: true, beans: false, showcase: true };

async function openTab(label: string, testId: string) {
    const nav = await screen.findByTestId('mobile-bottom-nav');
    fireEvent.click(within(nav).getByText(label));
    await screen.findByTestId(testId);
}
const heldBack = () => screen.getByTestId('install-prompt').getAttribute('data-held-back');

describe('a new member: the notices above the tabs (S1)', () => {
    beforeEach(() => { localStorage.clear(); act(() => { closeTour(); }); });

    it('"Your account is new" shows on Home and not above the Market or the Ledger', async () => {
        render(<App />);
        await screen.findByTestId('home-page');
        expect(await screen.findByTestId('new-account-card')).toBeInTheDocument();

        await openTab('Market', 'marketplace-page');
        expect(screen.queryByTestId('new-account-card')).toBeNull();
        expect(screen.queryByTestId('one-way-back')).toBeNull();

        await openTab('Ledger', 'ledger-page');
        expect(screen.queryByTestId('new-account-card')).toBeNull();
        expect(screen.queryByTestId('one-way-back')).toBeNull();
    });
});

describe('a new member: the install banner waits for the tour (B1)', () => {
    beforeEach(() => { localStorage.clear(); act(() => { closeTour(); }); });

    it('is held back until Home says the tour is not offered, while the tour is offered, and while it runs', async () => {
        render(<App />);
        await screen.findByTestId('home-page');
        await waitFor(() => expect(screen.getByTestId('install-prompt')).toBeInTheDocument());
        // Home has not said yet: a first visit is the tour's to have.
        expect(heldBack()).toBe('true');

        act(() => { offerTour(PK, true); });
        expect(heldBack()).toBe('true');

        act(() => { startTour(PK, NODE, 0); });
        expect(heldBack()).toBe('true');

        // Done or Skip: the card goes, and the banner may come up.
        act(() => { closeTour(); offerTour(PK, false); });
        expect(heldBack()).toBe('false');

        // The tour taken again from "?": down at once.
        act(() => { startTour(PK, NODE, 0); });
        expect(heldBack()).toBe('true');
        act(() => { closeTour(); });
        expect(heldBack()).toBe('false');
    });

    it("another account's answer does not release it", async () => {
        render(<App />);
        await screen.findByTestId('home-page');
        act(() => { offerTour('someone-else', false); });
        await waitFor(() => expect(screen.getByTestId('install-prompt')).toBeInTheDocument());
        expect(heldBack()).toBe('true');
    });
});
