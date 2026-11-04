import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';

/**
 * The two doors "Asked near you" and First steps open (cold-start N2): "See all Needs" takes the Market to its Needs pill, and
 * "Ask for one thing you'd pay a neighbour for" opens the composer on a Need (not on Offer, not on whatever it was last on).
 * HomePage.test.tsx pins the calls the real Home makes; here App takes them the way it takes the Events pill's.
 *
 * App's MapPage is React.lazy: the first test to render it gets the node from the commit that inserts it, before the mock's effect has
 * taken the door and drawn the kind. So the kind is waited for (same expected value), never read once from `findByTestId`. Read once,
 * it failed intermittently for whichever test rendered MapPage first: the Need test in the full file (merge queue run 41912953363),
 * and either test run alone. The door itself was never lost: App passed `openNewPost` and `initialPostType: 'need'` to MapPage.
 */
const composerKind = (kind: string) => waitFor(() => expect(screen.getByTestId('map-page')).toHaveAttribute('data-composer', kind));
if (typeof window !== 'undefined') {
    window.matchMedia = window.matchMedia || vi.fn().mockImplementation(() => ({
        matches: false, media: '', onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
}

vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/SyncStatus', () => ({ SyncStatus: () => null }));
vi.mock('./components/ProfileSetup', () => ({ ProfileSetup: () => null }));

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
    getMyUnread: vi.fn(async () => ({ unread: 0, requests: 0, asOf: '2026-11-01T00:00:00.000Z' })),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    getCommunityHealth: vi.fn(async () => ({ online: true, version: '1.2.30' })),
    getMyActiveRecoveryCollections: vi.fn(async () => ({ count: 0, collections: [] })),
    getUnseenNotices: vi.fn(async () => []),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 0 })),
    getMemberProfile: vi.fn(async () => ({ publicKey: 'my-user-pubkey', avatar: null, bio: '', contact: null })),
}));

vi.mock('./pages/HomePage', () => ({
    HomePage: ({ onNavigate }: any) => (
        <div data-testid="home-page">
            <button data-testid="home-asked-all" onClick={() => onNavigate('marketplace', 'needs')}>See all Needs</button>
            <button data-testid="home-step-need" onClick={() => onNavigate('map-post-need')}>Ask for one thing</button>
            <button data-testid="home-step-offer" onClick={() => onNavigate('map-post')}>Something else (the blank composer)</button>
        </div>
    ),
}));
vi.mock('./pages/MarketplacePage', () => ({
    MarketplacePage: ({ openFilter, onFilterOpened }: any) => {
        // Takes the door's filter once, as the real page does.
        const [filter, setFilter] = React.useState('');
        React.useEffect(() => { if (openFilter) { setFilter(openFilter); onFilterOpened?.(); } }, [openFilter, onFilterOpened]);
        return <div data-testid="marketplace-page" data-filter={filter} />;
    },
}));
vi.mock('./pages/MapPage', () => ({
    MapPage: ({ openNewPost, initialPostType, onOpenNewPostHandled }: any) => {
        // Takes the door once, as the real page does: the composer opens on the kind the door names, else as it was.
        const [opened, setOpened] = React.useState<string | null>(null);
        React.useEffect(() => { if (openNewPost) { setOpened(initialPostType ?? 'as it was'); onOpenNewPostHandled?.(); } }, [openNewPost, initialPostType, onOpenNewPostHandled]);
        return <div data-testid="map-page" data-composer={opened ?? ''} />;
    },
}));
vi.mock('./pages/MessagesPage', () => ({ MessagesPage: () => <div data-testid="messages-page" /> }));
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => <div data-testid="people-page" /> }));

describe('App: the doors of Asked near you and First steps\' Need line', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('See all Needs opens the Market on its Needs pill', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-asked-all'));
        expect(await screen.findByTestId('marketplace-page')).toHaveAttribute('data-filter', 'need');
        expect(screen.queryByTestId('map-page')).toBeNull();
    });

    it('Ask for one thing you\'d pay a neighbour for opens the composer on a Need', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-step-need'));
        await composerKind('need');
    });

    // The blank composer's door ('map-post'): Something else on O2's starter dialog and a finished first-Offer step go here. The
    // Offer step itself opens the starter dialog first (HomePage.test.tsx), so this door is the one that stays as it was.
    it('the blank composer door is as it was: the composer opens with no kind named', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-step-offer'));
        await composerKind('as it was');
    });
});
