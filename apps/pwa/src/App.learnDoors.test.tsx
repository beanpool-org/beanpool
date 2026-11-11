/**
 * Learn is a page with no entry in the nav, as the Pulse is (slice K2; DESIGN-local-knowledge-amend-fable.md §2.11): four doors
 * open it (`learn`, `learn-topic`, `learn-search`, `learn-page`), "‹ Back" returns the member to the tab they came from, the
 * mobile title reads "Learn", and no bottom-nav or sidebar tab is added. The pages are stood in for by their doors.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
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

// The doors the real Home and Market call (HomePage.test.tsx and MarketplacePage.learn.test.tsx pin those calls on the real pages).
vi.mock('./pages/HomePage', () => ({
    HomePage: ({ onNavigate }: any) => (
        <div data-testid="home-page">
            <button data-testid="home-learn" onClick={() => onNavigate('learn')}>Learn</button>
            <button data-testid="home-learn-topic" onClick={() => onNavigate('learn-topic', 'emergencies')}>Emergencies</button>
        </div>
    ),
}));
vi.mock('./pages/MarketplacePage', () => ({
    MarketplacePage: ({ onNavigate }: any) => (
        <div data-testid="marketplace-page">
            <button data-testid="market-learn-line" onClick={() => onNavigate('learn-search', 'tip')}>In Learn</button>
            <button data-testid="market-link-to-page" onClick={() => onNavigate('learn-page', 'know-1')}>A link</button>
        </div>
    ),
}));
// Learn itself: what App hands it is what these tests read.
vi.mock('./pages/LearnPage', () => ({
    LearnPage: ({ target, onTargetTaken, onBack }: any) => {
        const seen = JSON.stringify(target);
        return (
            <div data-testid="learn-page" data-target={seen}>
                <button data-testid="learn-take" onClick={() => onTargetTaken()}>take</button>
                <button data-testid="learn-back" onClick={() => onBack()}>Back</button>
            </div>
        );
    },
}));
vi.mock('./pages/MapPage', () => ({ MapPage: () => <div data-testid="map-page" /> }));
vi.mock('./pages/MessagesPage', () => ({ MessagesPage: () => <div data-testid="messages-page" /> }));
vi.mock('./pages/PeoplePage', () => ({ PeoplePage: () => <div data-testid="people-page" /> }));

const target = () => JSON.parse(screen.getByTestId('learn-page').getAttribute('data-target') ?? 'null');

describe('App: the Learn doors', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { cleanup(); });

    it('Home\'s door opens the front, with the Home page gone, and Back lands on Home', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-learn'));
        expect(await screen.findByTestId('learn-page')).toBeInTheDocument();
        expect(target()).toEqual({ kind: 'front' });
        expect(screen.queryByTestId('home-page')).toBeNull();

        fireEvent.click(screen.getByTestId('learn-back'));
        expect(await screen.findByTestId('home-page')).toBeInTheDocument();
        expect(screen.queryByTestId('learn-page')).toBeNull();
    });

    it('names a topic, the words of a search and a page, each as one request', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-learn-topic'));
        expect(target()).toEqual({ kind: 'topic', topic: 'emergencies' });
        fireEvent.click(screen.getByTestId('learn-back'));

        fireEvent.click(await screen.findByTestId('home-learn'));
        fireEvent.click(screen.getByTestId('learn-take'));
        expect(target()).toBeNull();
    });

    it('the Market\'s line opens Learn on the words, and Back lands on the Market', async () => {
        render(<App />);
        fireEvent.click(await screen.findByTestId('home-learn'));
        fireEvent.click(await screen.findByTestId('learn-back'));
        // To the Market by the nav, as a member would.
        fireEvent.click(screen.getAllByRole('button', { name: /Market/ })[0]);
        fireEvent.click(await screen.findByTestId('market-learn-line'));
        expect(await screen.findByTestId('learn-page')).toBeInTheDocument();
        expect(target()).toEqual({ kind: 'search', q: 'tip' });
        expect(screen.queryByTestId('marketplace-page')).toBeNull();

        fireEvent.click(screen.getByTestId('learn-back'));
        expect(await screen.findByTestId('marketplace-page')).toBeInTheDocument();
    });

    it('a link to a page, which the Market handed on, opens that page, and Back lands on the Market', async () => {
        render(<App />);
        fireEvent.click(await screen.findAllByRole('button', { name: /Market/ }).then((b) => b[0]));
        fireEvent.click(await screen.findByTestId('market-link-to-page'));
        expect(target()).toEqual({ kind: 'page', id: 'know-1' });
        fireEvent.click(screen.getByTestId('learn-back'));
        expect(await screen.findByTestId('marketplace-page')).toBeInTheDocument();
    });

    it('adds no tab: the nav is as it was, and the mobile title reads Learn', async () => {
        render(<App />);
        await screen.findByTestId('home-learn');
        const navs = () => Array.from(document.querySelectorAll('nav')).map((n) => n.textContent).join('|');
        const before = navs();
        expect(before.length).toBeGreaterThan(0);
        expect(before).not.toMatch(/Learn/);
        fireEvent.click(screen.getByTestId('home-learn'));
        await screen.findByTestId('learn-page');
        expect(navs()).toBe(before);
        // The mocked page draws no title of its own: the one "Learn" on screen is the header's.
        expect(screen.getAllByText('Learn')).toHaveLength(1);
    });
});
