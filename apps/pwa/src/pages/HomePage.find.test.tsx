/**
 * The web find card's two ways on when no community is near (Sonnet global-privacy review S5): its sentence promised
 * "Start one, or ask to be told when one starts here", but the card had neither, and nothing on the web called
 * POST /api/global/watches. Now it has both, as the phone's FindCommunityBody: Start a community opens the Start screen,
 * and "Tell me when one starts here" keeps a watch for a member at the point Home was read from. A visitor is told to
 * join first (a watch is a member's, signed); nothing is sent for them. The node is lib/api.ts mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HomeAnswer, HomeFind } from '../lib/home-cards';
import type { HomeRead } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getHome: vi.fn(),
    saveHomePreferences: vi.fn(async () => ({ success: true })),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 1 })),
    getCommunityMe: vi.fn(async () => ({ probation: null })),
    watchPlace: vi.fn(),
}));
vi.mock('../components/AddressSearch', () => ({
    AddressSearch: ({ onPick }: { onPick: (r: unknown) => void }) => (
        <button type="button" data-testid="town-search"
            onClick={() => onPick({ lat: -28.8135, lng: 153.2773, displayName: 'Lismore, New South Wales, Australia', shortName: 'Lismore' })}>
            pick Lismore
        </button>
    ),
}));
vi.mock('../components/StartCommunityScreen', () => ({
    StartCommunityScreen: ({ onClose }: { onClose: () => void }) => (
        <div role="dialog" data-testid="start-community-screen"><button type="button" onClick={onClose}>Back</button></div>
    ),
}));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}), onSocketOpen: vi.fn(() => () => {}), onSystemAnnouncement: vi.fn(() => () => {}) }));

import * as api from '../lib/api';
import { HomePage, WATCH_WORDS } from './HomePage';

const { done: WATCH_DONE, joinFirst: WATCH_JOIN_FIRST, needsPlace: WATCH_NEEDS_PLACE } = WATCH_WORDS;
import { resetHomeCacheForTest } from '../lib/home-cache';
import { resetAccountEpochForTest } from '../lib/account-epoch';

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const NOW = new Date().toISOString();
const NONE_NEAR: HomeFind = { point: 'request', communities: [], communityCount: 38, nearbyPosts: null, watches: null, knock: null, directoryFetchedAt: '2026-10-14T00:00:00.000Z' } as HomeFind;

function globalAnswer(find: Partial<HomeFind>, member: boolean): HomeAnswer {
    return {
        generatedAt: NOW, profile: 'global', welcome: !member,
        features: { beans: false, guestListingsOnly: true, invites: false },
        me: member ? { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } } : null,
        layout: member ? { v: 2, cards: [{ id: 'find', type: 'find' }], dismissed: {}, updatedAt: null } : null,
        cards: { find: { ...NONE_NEAR, ...find } },
    } as unknown as HomeAnswer;
}
const fresh = (a: HomeAnswer): HomeRead => ({ notModified: false, answer: a, etag: 'W/"t"' });

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetHomeCacheForTest();
    localStorage.clear();
    resetAccountEpochForTest();
    vi.mocked(api.getHome).mockReset();
    vi.mocked(api.watchPlace).mockReset();
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A member on global whose Home was read at a town they picked, with no community near it. */
async function memberAtLismore() {
    vi.mocked(api.getHome).mockResolvedValueOnce(fresh(globalAnswer({ point: null }, true))).mockResolvedValue(fresh(globalAnswer({}, true)));
    render(<HomePage identity={ME} onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('home-type-town'));
    fireEvent.click(screen.getByTestId('town-search'));
    return screen.findByTestId('home-find-actions');
}

describe('the web find card with no community near', () => {
    it('a member is told when one starts: the watch is sent at the point Home was read from, then the button goes', async () => {
        vi.mocked(api.watchPlace).mockResolvedValue({ success: true });
        await memberAtLismore();
        fireEvent.click(screen.getByRole('button', { name: 'Tell me when a community starts near here' }));
        expect(await screen.findByTestId('home-find-watch-note')).toHaveTextContent(WATCH_DONE);
        expect(api.watchPlace).toHaveBeenCalledTimes(1);
        const [lat, lng] = vi.mocked(api.watchPlace).mock.calls[0];
        expect(Math.abs(lat + 28.81)).toBeLessThan(0.1);
        expect(Math.abs(lng - 153.28)).toBeLessThan(0.1);
        expect(screen.queryByTestId('home-find-watch')).toBeNull();
    });

    it('a refused watch says why and never "Done"; the button stays for another try', async () => {
        vi.mocked(api.watchPlace).mockRejectedValue(new Error('You already watch 5 places.'));
        await memberAtLismore();
        fireEvent.click(screen.getByTestId('home-find-watch'));
        expect(await screen.findByTestId('home-find-watch-note')).toHaveTextContent('You already watch 5 places.');
        expect(document.body.textContent).not.toContain(WATCH_DONE);
        expect(screen.getByTestId('home-find-watch')).toBeInTheDocument();
    });

    it('Start a community opens the Start screen', async () => {
        await memberAtLismore();
        fireEvent.click(screen.getByTestId('home-find-start'));
        expect(screen.getByTestId('start-community-screen')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(screen.queryByTestId('start-community-screen')).toBeNull();
    });

    it('a visitor is told to join first, and nothing is sent', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({}, false)));
        render(<HomePage identity={null} visitor={{ joinCard: <p>Join</p>, beans: false }} onNavigate={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('home-find-watch'));
        expect(screen.getByTestId('home-find-watch-note')).toHaveTextContent(WATCH_JOIN_FIRST);
        expect(screen.getByTestId('home-find-start')).toBeInTheDocument();
        expect(api.watchPlace).not.toHaveBeenCalled();
    });

    it('a member whose place the browser does not know is asked for it first, and the town search opens', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ point: 'area' }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('home-find-watch'));
        expect(screen.getByTestId('home-find-watch-note')).toHaveTextContent(WATCH_NEEDS_PLACE);
        expect(screen.getByTestId('town-search')).toBeInTheDocument();
        expect(api.watchPlace).not.toHaveBeenCalled();
    });

    it('one Start a community, and one Start screen, never two (the #1935 × #1955 merge)', async () => {
        await memberAtLismore();
        expect(screen.getAllByTestId('home-find-start')).toHaveLength(1);
        expect(screen.getAllByTestId('home-find-actions')).toHaveLength(1);
        fireEvent.click(screen.getByTestId('home-find-start'));
        expect(screen.getAllByTestId('start-community-screen')).toHaveLength(1);
    });

    it('far (nearest listed 12,489 km away) is "none near": one Start and Tell me, as the phone (#1935 250 km rule)', async () => {
        const lismore = { key: 'l', name: 'Lismore', url: 'https://lismore.example.org', memberCount: 12, distanceKm: 12_489 };
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [lismore] }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-find-actions');
        expect(screen.getAllByTestId('home-find-start')).toHaveLength(1);
        expect(screen.getByTestId('home-find-watch')).toBeInTheDocument();
    });

    it('near (12 km) or the list not loaded yet: neither Start nor Tell me', async () => {
        const near = { key: 'l', name: 'Lismore', url: 'https://lismore.example.org', memberCount: 12, distanceKm: 12 };
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [near] }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-find-body')).toHaveTextContent('The community nearest you.');
        expect(screen.queryByTestId('home-find-actions')).toBeNull();
        expect(screen.queryByTestId('home-find-start')).toBeNull();
        expect(screen.queryByTestId('home-find-watch')).toBeNull();
        cleanup();
        resetHomeCacheForTest();
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communityCount: 0, directoryFetchedAt: null }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-find-body')).toHaveTextContent("The list of communities isn't available right now.");
        expect(screen.queryByTestId('home-find-actions')).toBeNull();
        expect(screen.queryByTestId('home-find-start')).toBeNull();
        expect(screen.queryByTestId('home-find-watch')).toBeNull();
    });

    it('a member already watching here is not offered it again', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ watches: [{ id: 'w1' }] }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-find-actions');
        expect(screen.queryByTestId('home-find-watch')).toBeNull();
        await waitFor(() => expect(screen.getByTestId('home-find-start')).toBeInTheDocument());
    });
});
