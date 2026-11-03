import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { App } from './App';

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

// The pages are stood in for by their doors: each calls onNavigate the way the real Home and Market do
// (HomePage.test.tsx and MarketplacePage.test.tsx pin those calls on the real pages).
vi.mock('./pages/HomePage', () => ({
    HomePage: ({ onNavigate }: any) => (
        <div data-testid="home-page">
            <button data-testid="home-events-calendar" onClick={() => onNavigate('map-calendar')}>Calendar</button>
            <button data-testid="home-events-all" onClick={() => onNavigate('marketplace', 'events')}>All events</button>
        </div>
    ),
}));
vi.mock('./pages/MarketplacePage', () => ({
    MarketplacePage: ({ onNavigate, openFilter, onFilterOpened }: any) => {
        // Takes the door's filter once, as the real page does.
        const [filter, setFilter] = React.useState('');
        React.useEffect(() => { if (openFilter) { setFilter(openFilter); onFilterOpened?.(); } }, [openFilter, onFilterOpened]);
        return (
            <div data-testid="marketplace-page" data-filter={filter}>
                <button data-testid="market-calendar-button" onClick={() => onNavigate('map-calendar')}>Calendar</button>
            </div>
        );
    },
}));
// The Map page keeps what the real one does for a calendar a door opened: it opens on openCalendar, and ✕ calls back
// (MapPage.test.tsx pins that on the real page).
vi.mock('./pages/MapPage', () => ({
    MapPage: ({ openCalendar, onOpenCalendarHandled, onCalendarClosedBack }: any) => {
        const [open, setOpen] = React.useState(false);
        const fromDoor = React.useRef(false);
        React.useEffect(() => {
            if (!openCalendar) return;
            fromDoor.current = true;
            setOpen(true);
            onOpenCalendarHandled?.();
        }, [openCalendar, onOpenCalendarHandled]);
        return (
            <div data-testid="map-page">
                {open && (
                    <div data-testid="map-calendar">
                        <button data-testid="calendar-close" onClick={() => { setOpen(false); if (fromDoor.current) onCalendarClosedBack?.(); }}>✕</button>
                    </div>
                )}
            </div>
        );
    },
}));
vi.mock('./pages/MessagesPage', () => ({ MessagesPage: () => <div data-testid="messages-page" /> }));
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => <div data-testid="people-page" /> }));

describe('App: the calendar doors return the member to where they came from', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('Home: Calendar › opens the calendar on the Map, and ✕ lands back on Home', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-events-calendar'));

        expect(await screen.findByTestId('map-calendar')).toBeInTheDocument();
        expect(screen.queryByTestId('home-page')).toBeNull();

        await act(async () => { fireEvent.click(screen.getByTestId('calendar-close')); });
        expect(await screen.findByTestId('home-page')).toBeInTheDocument();
        expect(screen.queryByTestId('map-page')).toBeNull();
    });

    it('Market: the calendar button opens the calendar on the Map, and ✕ lands back on the Market', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-events-all'));
        expect(await screen.findByTestId('marketplace-page')).toBeInTheDocument();
        expect(screen.getByTestId('marketplace-page')).toHaveAttribute('data-filter', 'event');

        fireEvent.click(screen.getByTestId('market-calendar-button'));
        expect(await screen.findByTestId('map-calendar')).toBeInTheDocument();
        expect(screen.queryByTestId('marketplace-page')).toBeNull();

        await act(async () => { fireEvent.click(screen.getByTestId('calendar-close')); });
        expect(await screen.findByTestId('marketplace-page')).toBeInTheDocument();
        expect(screen.queryByTestId('home-page')).toBeNull();
    });

    it('Home\'s All events › goes to the Market\'s Events pill, not the Map', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-events-all'));
        expect(await screen.findByTestId('marketplace-page')).toHaveAttribute('data-filter', 'event');
        expect(screen.queryByTestId('map-page')).toBeNull();
    });
});
