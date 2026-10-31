/**
 * The web find card's two ways on when no community is near (Sonnet global-privacy review S5): its sentence promised
 * "Start one, or ask to be told when one starts here", but the card had neither, and nothing on the web called
 * POST /api/global/watches. Now it has both, as the phone's FindCommunityBody: Start a community opens the Start screen,
 * and "Tell me when one starts here" keeps a watch for a member at the point Home was read from. A visitor is told to
 * join first (a watch is a member's, signed); nothing is sent for them. The node is lib/api.ts mocked.
 *
 * And a community the member came to ask to join (`/?ask=<host>`, front doors S15): the Find card opens on it, and where
 * Home draws no Find card (a global member past their first 30 days, or one who took Find off) it stands above the cards
 * (PR #2551 review: before, nothing was drawn, and the "no Find card" tests here fail there).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NOTICES_SEEN_EVENT, type HomeAnswer, type HomeFind } from '../lib/home-cards';
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
    getListedCommunityByHost: vi.fn(async () => null),
    // lib/knock's own calls (where a test doesn't stub them): no network here, as a browser offline would say.
    signedFetchAt: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
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
import { rememberKnock } from '../lib/knock';
import { circleIntents, setCircleIntent } from '../lib/circle-intent';
import * as knockModule from '../lib/knock';

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

describe('the knock a retired circle owes', () => {
    const retired = (acceptingKnocks: boolean) => ({
        id: 'c1', people: 4, starting: null, doneAt: '2026-11-01T00:00:00.000Z',
        community: { key: 'thrissur', name: 'Thrissur Commons', url: 'https://thrissur.beanpool.org', acceptingKnocks },
    });
    const knocksSent = () => vi.mocked(api.signedFetchAt).mock.calls.filter(c => c[0] === 'POST');
    /** A read of Home with this circle, then the town the member picks, and with it the next read. */
    async function twoReads(first: HomeFind['circle'], then: HomeFind['circle']) {
        vi.mocked(api.signedFetchAt).mockClear();
        setCircleIntent(ME.publicKey, 'c1', true);
        vi.mocked(api.getHome).mockResolvedValueOnce(fresh(globalAnswer({ point: null, circle: first }, true))).mockResolvedValue(fresh(globalAnswer({ circle: then }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('home-type-town'));
        await act(async () => { await Promise.resolve(); });
        const sentAtFirst = knocksSent().length;
        vi.mocked(api.signedFetchAt).mockImplementationOnce(async () => new Response('{}', { status: 201 }));
        fireEvent.click(screen.getByTestId('town-search'));
        await waitFor(() => expect(knocksSent().length).toBe(sentAtFirst + 1));
        return sentAtFirst;
    }

    it('waits for a community that takes no requests yet, and goes on the read that says it does', async () => {
        expect(await twoReads(retired(false), retired(true))).toBe(0);
        await waitFor(() => expect(circleIntents(ME.publicKey)).toEqual([]));
        await waitFor(async () => expect((await knockModule.rememberedKnocks(ME.publicKey)).map(k => k.url)).toEqual(['https://thrissur.beanpool.org']));
    });

    it('tries a community it could not reach again on the next read', async () => {
        expect(await twoReads(retired(true), retired(true))).toBe(1);
        await waitFor(() => expect(circleIntents(ME.publicKey)).toEqual([]));
    });
});

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

    it('watching as many places as the node allows is said in the app\'s own words, with the node\'s number', async () => {
        vi.mocked(api.watchPlace).mockRejectedValue(Object.assign(new Error('the node\'s own words'), { status: 409, code: 'watch_limit', limit: 2 }));
        await memberAtLismore();
        fireEvent.click(screen.getByTestId('home-find-watch'));
        expect(await screen.findByTestId('home-find-watch-note')).toHaveTextContent('You can watch up to 2 places. Remove one to watch another.');
        expect(document.body.textContent).not.toContain('the node\'s own words');
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

describe('a community the member came to ask to join', () => {
    const RIVERSIDE = { key: 'r', name: 'Riverside', url: 'https://riverside.example', memberCount: 40, distanceKm: null };
    /** A global member of more than 30 days (Find no longer held on Home) whose saved Home is `cards`. */
    function longMember(cards: Array<{ id: string; type: string }>): HomeAnswer {
        const a = globalAnswer({}, true);
        return { ...a, layout: { v: 2, cards, dismissed: {}, updatedAt: '2026-10-01T00:00:00.000Z' } } as unknown as HomeAnswer;
    }
    beforeEach(() => { vi.mocked(api.getListedCommunityByHost).mockReset().mockResolvedValue(RIVERSIDE); });

    it('no Find card on Home: it stands above the cards, with Ask to join, and its ✕ lets it go (fails before: nothing)', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(longMember([])));
        const seen = vi.fn();
        render(<HomePage identity={ME} onNavigate={vi.fn()} askedCommunity="riverside.example" onAskedCommunitySeen={seen} />);
        const asked = await screen.findByTestId('home-find-asked');
        // Front doors S2: the web asks by itself (before: "To ask Riverside to join, open Find a community in the BeanPool app …").
        expect(await within(asked).findByRole('button', { name: 'Ask to join Riverside' })).toBeTruthy();
        expect(screen.queryByTestId('home-card-find')).toBeNull();
        expect(api.getListedCommunityByHost).toHaveBeenCalledWith('riverside.example');
        fireEvent.click(within(asked).getByTestId('home-find-asked-close'));
        expect(seen).toHaveBeenCalledTimes(1);
    });

    it('no Find card, and not listed yet: said so, above the cards (fails before: nothing)', async () => {
        vi.mocked(api.getListedCommunityByHost).mockResolvedValue(null);
        vi.mocked(api.getHome).mockResolvedValue(fresh(longMember([])));
        render(<HomePage identity={ME} onNavigate={vi.fn()} askedCommunity="riverside.example" />);
        const asked = await screen.findByTestId('home-find-asked');
        expect(await within(asked).findByRole('status')).toHaveTextContent("riverside.example isn't in the list of communities yet.");
        expect(screen.queryByTestId('home-card-find')).toBeNull();
    });

    it('Find on Home: inside the Find card, drawn once', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(longMember([{ id: 'find', type: 'find' }])));
        render(<HomePage identity={ME} onNavigate={vi.fn()} askedCommunity="riverside.example" />);
        const find = await screen.findByTestId('home-card-find');
        await within(find).findByTestId('home-find-asked');
        expect(screen.getAllByTestId('home-find-asked')).toHaveLength(1);
    });

    it('nothing asked: nothing drawn above the cards', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(longMember([])));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-grid');
        expect(screen.queryByTestId('home-find-asked')).toBeNull();
        expect(api.getListedCommunityByHost).not.toHaveBeenCalled();
    });
});

describe('a community gone quiet on the web find card (front doors S13)', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

    it('says "Not answering lately" under a row past 36 h since its last push, and not before; the row stays a link', async () => {
        const rows = [
            { key: 'q', name: 'Sleepy Hollow', url: 'https://sleepy.example.org', memberCount: 6, distanceKm: 8, lastSeenAt: hoursAgo(40) },
            { key: 'e', name: 'Edge Creek', url: 'https://edge.example.org', memberCount: 3, distanceKm: 12, lastSeenAt: hoursAgo(35) },
            { key: 'f', name: 'Riverbend', url: null, memberCount: 10, distanceKm: 20, lastSeenAt: hoursAgo(2) },
        ];
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: rows }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('home-find-not-answering-q')).toHaveTextContent('Not answering lately');
        expect(screen.queryByTestId('home-find-not-answering-e')).toBeNull();
        expect(screen.queryByTestId('home-find-not-answering-f')).toBeNull();
        expect(screen.getByRole('link', { name: /Sleepy Hollow/ })).toHaveAttribute('href', 'https://sleepy.example.org');
    });

    it('an older global node that sends no lastSeenAt: no such line', async () => {
        const near = { key: 'l', name: 'Lismore', url: 'https://lismore.example.org', memberCount: 12, distanceKm: 12 };
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [near] }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-find-body');
        expect(screen.queryByTestId('home-find-not-answering-l')).toBeNull();
    });
});

describe('Ask to join from the web find card (front doors S2)', () => {
    const SLEEPY = { key: 'q', name: 'Sleepy Hollow', url: 'https://sleepy.example.org', memberCount: 6, distanceKm: 8 };
    const NO_ADDRESS = { key: 'f', name: 'Riverbend', url: null, memberCount: 10, distanceKm: 20 };

    it('each row with an address has Ask to join; the form sends; Home\'s waiting card then says how it fares (fails before: no button)', async () => {
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [SLEEPY, NO_ADDRESS] }, true)));
        const sendSpy = vi.spyOn(knockModule, 'sendKnock').mockResolvedValue({ kind: 'waiting', message: 'You asked to join. No answer yet: communities usually answer within a few days.' });
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const ask = await screen.findByTestId('home-find-ask-q');
        expect(ask).toHaveAccessibleName('Ask to join Sleepy Hollow');
        expect(screen.queryByTestId('home-find-ask-f')).toBeNull();
        // The row itself still links to the community's address: its public card, for a stranger (front doors S15).
        expect(screen.getByRole('link', { name: /Sleepy Hollow/ })).toHaveAttribute('href', 'https://sleepy.example.org');

        fireEvent.click(ask);
        fireEvent.change(screen.getByTestId('home-find-ask-q-message'), { target: { value: 'I fix bikes.' } });
        fireEvent.click(screen.getByTestId('home-find-ask-q-send'));
        expect(await screen.findByTestId('home-waiting-card-https://sleepy.example.org')).toBeTruthy();
        expect(sendSpy).toHaveBeenCalledWith('https://sleepy.example.org', ME, { callsign: 'Ana', message: 'I fix bikes.' });
        // Cancel comes with the card's status read (it says "Checking…" until then).
        expect(await screen.findByTestId('home-cancel-knock-https://sleepy.example.org')).toHaveTextContent('Cancel my request');
        // The card is the one place that says how it fares: the row has no line of its own beside it, which would outlive a
        // Cancel or a Got it in this visit, and no second Ask to join (PR #2625 review: it said "No answer yet" here).
        expect(screen.queryByTestId('home-find-ask-q-said')).toBeNull();
        expect(screen.queryByTestId('home-find-ask-q')).toBeNull();
        sendSpy.mockRestore();
        readSpy.mockRestore();
    });

    it('a community this browser already asked: no second Ask to join on its row', async () => {
        await rememberKnock(ME.publicKey, SLEEPY, new Date());
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [SLEEPY] }, true)));
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-waiting-card-https://sleepy.example.org');
        expect(screen.queryByTestId('home-find-ask-q')).toBeNull();
        readSpy.mockRestore();
    });

    it('the ?ask= landing (S15\'s link): after Join, the Find card opens on that community with its own Ask to join', async () => {
        vi.mocked(api.getListedCommunityByHost).mockReset().mockResolvedValue({ key: 'r', name: 'Riverside', url: 'https://riverside.example', memberCount: 40, distanceKm: null });
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [SLEEPY] }, true)));
        const sendSpy = vi.spyOn(knockModule, 'sendKnock').mockResolvedValue({ kind: 'waiting', message: 'You asked to join. No answer yet: communities usually answer within a few days.' });
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        render(<HomePage identity={ME} onNavigate={vi.fn()} askedCommunity="riverside.example" />);
        const find = await screen.findByTestId('home-card-find');
        const asked = await within(find).findByTestId('home-find-asked');
        expect(within(asked).getByText('Riverside')).toBeTruthy();
        // It stands first in the card, above the listed rows.
        expect(asked.compareDocumentPosition(within(find).getByTestId('home-find-ask-q')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        fireEvent.click(await within(asked).findByRole('button', { name: 'Ask to join Riverside' }));
        fireEvent.change(within(asked).getByTestId('home-find-asked-ask-message'), { target: { value: 'I came from your card.' } });
        fireEvent.click(within(asked).getByTestId('home-find-asked-ask-send'));
        // Home's waiting card says how it fares; the box keeps no line of its own beside it (PR #2625 review).
        expect(await within(find).findByTestId('home-waiting-card-https://riverside.example')).toBeTruthy();
        expect(sendSpy).toHaveBeenCalledWith('https://riverside.example', ME, { callsign: 'Ana', message: 'I came from your card.' });
        const box = screen.getByTestId('home-find-asked');
        expect(within(box).queryByTestId('home-find-asked-ask-said')).toBeNull();
        expect(within(box).queryByRole('button', { name: 'Ask to join Riverside' })).toBeNull();
        sendSpy.mockRestore();
        readSpy.mockRestore();
    });

    /** Ask Sleepy Hollow from its row; resolves with Home's waiting card for it. */
    async function askSleepy() {
        fireEvent.click(await screen.findByTestId('home-find-ask-q'));
        fireEvent.change(screen.getByTestId('home-find-ask-q-message'), { target: { value: 'I fix bikes.' } });
        fireEvent.click(screen.getByTestId('home-find-ask-q-send'));
        return screen.findByTestId('home-waiting-card-https://sleepy.example.org');
    }

    describe('the row after the request is sent, in the same visit (PR #2625 review: "No answer yet" stayed)', () => {
        const WAITING = 'You asked to join. No answer yet: communities usually answer within a few days.';
        afterEach(() => { vi.restoreAllMocks(); });

        it('Cancel my request: the card says it was cancelled, and the row says nothing stale and offers no Ask to join', async () => {
            vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [SLEEPY] }, true)));
            vi.spyOn(knockModule, 'sendKnock').mockResolvedValue({ kind: 'waiting', message: WAITING });
            vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            // The real cancelKnock: the community says yes, and the browser marks the request cancelled.
            vi.mocked(api.signedFetchAt).mockResolvedValueOnce(new Response('{}', { status: 200 }));
            render(<HomePage identity={ME} onNavigate={vi.fn()} />);
            await askSleepy();
            fireEvent.click(await screen.findByTestId('home-cancel-knock-https://sleepy.example.org'));
            expect(await screen.findByTestId('home-waiting-cancelled-https://sleepy.example.org')).toHaveTextContent(CANCELLED_LINE);
            expect(document.body.textContent).not.toContain('No answer yet');
            expect(screen.queryByTestId('home-find-ask-q-said')).toBeNull();
            expect(screen.queryByTestId('home-find-ask-q')).toBeNull();
        });

        it('Got it on a request the community no longer holds: the row offers Ask to join again, with no stale line', async () => {
            vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [SLEEPY] }, true)));
            vi.spyOn(knockModule, 'sendKnock').mockResolvedValue({ kind: 'waiting', message: WAITING });
            vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'none' } });
            render(<HomePage identity={ME} onNavigate={vi.fn()} />);
            await askSleepy();
            fireEvent.click(await screen.findByTestId('home-gotit-knock-https://sleepy.example.org'));
            await waitFor(() => expect(screen.queryByTestId('home-waiting-card-https://sleepy.example.org')).toBeNull());
            expect(await screen.findByTestId('home-find-ask-q')).toHaveAccessibleName('Ask to join Sleepy Hollow');
            expect(screen.queryByTestId('home-find-ask-q-said')).toBeNull();
            expect(document.body.textContent).not.toContain('No answer yet');
        });

        it('one request cancelled, then another sent: the cancelled card keeps its line, and its row offers nothing the node would refuse', async () => {
            const BYRON = { key: 'b', name: 'Byron', url: 'https://byron.example.org', memberCount: 40, distanceKm: 12 };
            await rememberKnock(ME.publicKey, BYRON, new Date(Date.now() - 3_600_000));
            vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [SLEEPY, BYRON] }, true)));
            vi.spyOn(knockModule, 'sendKnock').mockResolvedValue({ kind: 'waiting', message: WAITING });
            vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            vi.mocked(api.signedFetchAt).mockResolvedValueOnce(new Response('{}', { status: 200 }));
            render(<HomePage identity={ME} onNavigate={vi.fn()} />);
            fireEvent.click(await screen.findByTestId(`home-cancel-knock-${BYRON.url}`));
            await screen.findByTestId(`home-waiting-cancelled-${BYRON.url}`);
            await askSleepy();
            expect(screen.getByTestId(`home-waiting-cancelled-${BYRON.url}`)).toHaveTextContent(CANCELLED_LINE);
            expect(screen.queryByTestId('home-find-ask-b')).toBeNull();
        });
    });
});

describe("I'd help on the waiting card (PR #2687 review: its answer was drawn only with no community near, so here, nowhere)", () => {
    const COMM = { key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', memberCount: 40, distanceKm: 12 };
    const DEMAND = { waiting: 4, helping: null };

    async function waitingNearByron(point: 'town' | 'unknown') {
        await rememberKnock(ME.publicKey, COMM, new Date('2026-10-25T00:00:00.000Z'));
        vi.mocked(api.getHome).mockResolvedValueOnce(fresh(globalAnswer({ point: null, communities: [COMM], demand: DEMAND }, true)))
            .mockResolvedValue(fresh(globalAnswer({ communities: [COMM], demand: DEMAND }, true)));
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const help = await screen.findByTestId(`home-waiting-help-${COMM.url}`);
        if (point === 'unknown') return help;
        fireEvent.click(screen.getByTestId('home-type-town'));
        fireEvent.click(screen.getByTestId('town-search'));
        await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2));
        return screen.findByTestId(`home-waiting-help-${COMM.url}`);
    }

    it('a tap that worked says so, and the button goes', async () => {
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        vi.mocked(api.watchPlace).mockResolvedValue({ success: true } as never);
        fireEvent.click(await waitingNearByron('town'));
        const note = await screen.findByTestId('home-find-watch-note');
        expect(note).toHaveTextContent("Thanks. When three of you are near each other, you'll be introduced.");
        expect(note.closest('[role="status"]')).not.toBeNull();
        expect(screen.queryByTestId('home-find-actions')).toBeNull();
        expect(screen.queryByTestId(`home-waiting-help-${COMM.url}`)).toBeNull();
        readSpy.mockRestore();
    });

    it('a refused tap says why, and the button stays for another try', async () => {
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        vi.mocked(api.watchPlace).mockRejectedValue(new Error('You already watch 5 places.'));
        fireEvent.click(await waitingNearByron('town'));
        expect(await screen.findByTestId('home-find-watch-note')).toHaveTextContent('You already watch 5 places.');
        expect(screen.getByTestId(`home-waiting-help-${COMM.url}`)).toBeInTheDocument();
        readSpy.mockRestore();
    });

    it('with no place known it asks for one, and nothing is sent', async () => {
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        fireEvent.click(await waitingNearByron('unknown'));
        expect(screen.getByTestId('home-find-watch-note')).toHaveTextContent(WATCH_NEEDS_PLACE);
        expect(api.watchPlace).not.toHaveBeenCalled();
        readSpy.mockRestore();
    });
});

describe('the honest waiting card on the web find card (Lounge L1)', () => {
    it('shows sent date, arrived status, and measured line for a waiting knock', async () => {
        const comm = {
            key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org',
            memberCount: 40, distanceKm: 12, answers: 'week' as const,
        };
        await rememberKnock(ME.publicKey, comm, new Date('2026-10-25T00:00:00.000Z'));

        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [comm] }, true)));
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({
            ok: true, value: { status: 'pending' },
        });

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-waiting-card-https://byron.example.org');
        expect(within(card).getByTestId('home-waiting-sent-https://byron.example.org')).toHaveTextContent('You asked to join Byron Shire BeanPool on 25 Oct 2026.');
        expect(await within(card).findByTestId('home-waiting-arrived-https://byron.example.org')).toHaveTextContent('Your request arrived.');
        expect(within(card).getByTestId('home-waiting-answers-https://byron.example.org')).toHaveTextContent('Usually answers within a week');
        expect(within(card).getByTestId('home-cancel-knock-https://byron.example.org')).toHaveTextContent('Cancel my request');

        // While a knock is waiting, the Find card remains pinned and cannot be moved or removed (no card menu)
        const findCard = screen.getByTestId('home-card-find');
        expect(within(findCard).queryByTestId('home-card-menu')).toBeNull();

        readSpy.mockRestore();
    });

    it('cancels knock with confirmation and withdraws it', async () => {
        const comm = {
            key: 'mullum', name: 'Mullumbimby BeanPool', url: 'https://mullum.example.org',
            memberCount: 20, distanceKm: 15, answers: 'slow' as const,
        };
        await rememberKnock(ME.publicKey, comm, new Date('2026-10-26T00:00:00.000Z'));

        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [comm] }, true)));
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({
            ok: true, value: { status: 'pending' },
        });
        const cancelSpy = vi.spyOn(knockModule, 'cancelKnock').mockResolvedValue({ ok: true });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const cancelBtn = await screen.findByTestId('home-cancel-knock-https://mullum.example.org');
        fireEvent.click(cancelBtn);

        expect(confirmSpy).toHaveBeenCalledWith('Cancel your request to join Mullumbimby BeanPool? You can ask again after 24 hours.');
        expect(cancelSpy).toHaveBeenCalledWith('https://mullum.example.org', ME);

        // The card stays for this visit: the button is gone, and the card says what happened.
        await waitFor(() => expect(screen.queryByTestId('home-cancel-knock-https://mullum.example.org')).toBeNull());
        expect(screen.getByTestId('home-waiting-card-https://mullum.example.org')).toBeInTheDocument();

        readSpy.mockRestore();
        cancelSpy.mockRestore();
        confirmSpy.mockRestore();
    });

    it('shows error note when cancellation fails (never false success)', async () => {
        const comm = {
            key: 'bangalow', name: 'Bangalow BeanPool', url: 'https://bangalow.example.org',
            memberCount: 15, distanceKm: 25,
        };
        await rememberKnock(ME.publicKey, comm, new Date('2026-10-27T00:00:00.000Z'));

        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [comm] }, true)));
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({
            ok: true, value: { status: 'pending' },
        });
        const cancelSpy = vi.spyOn(knockModule, 'cancelKnock').mockResolvedValue({ ok: false, message: 'Node could not be reached' });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const cancelBtn = await screen.findByTestId('home-cancel-knock-https://bangalow.example.org');
        fireEvent.click(cancelBtn);

        expect(await screen.findByTestId('home-cancel-error-https://bangalow.example.org')).toHaveTextContent('Node could not be reached');
        expect(screen.getByTestId('home-waiting-card-https://bangalow.example.org')).toBeInTheDocument();

        readSpy.mockRestore();
        cancelSpy.mockRestore();
        confirmSpy.mockRestore();
    });

    it('a failed cancel says so under the knock it was for, not under another waiting beside it', async () => {
        const first = { key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', memberCount: 40, distanceKm: 12 };
        const second = { key: 'lismore', name: 'Lismore BeanPool', url: 'https://lismore.example.org', memberCount: 30, distanceKm: 40 };
        await rememberKnock(ME.publicKey, first, new Date(Date.now() - 5 * 3_600_000));
        await rememberKnock(ME.publicKey, second, new Date(Date.now() - 4 * 3_600_000));

        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [first, second] }, true)));
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        const cancelSpy = vi.spyOn(knockModule, 'cancelKnock').mockResolvedValue({ ok: false, message: 'Node could not be reached' });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        fireEvent.click(await screen.findByTestId('home-cancel-knock-https://byron.example.org'));

        const failed = await screen.findByTestId('home-cancel-error-https://byron.example.org');
        expect(failed).toHaveTextContent('Node could not be reached');
        expect(within(screen.getByTestId('home-waiting-card-https://byron.example.org')).getByTestId('home-cancel-error-https://byron.example.org')).toBe(failed);
        // The other request was not touched: no message under it, and its own Cancel is still live.
        expect(screen.queryByTestId('home-cancel-error-https://lismore.example.org')).toBeNull();
        expect(screen.getAllByRole('alert')).toHaveLength(1);
        expect(screen.getByTestId('home-cancel-knock-https://lismore.example.org')).toBeEnabled();

        readSpy.mockRestore();
        cancelSpy.mockRestore();
        confirmSpy.mockRestore();
    });

    it('a community name or a node\'s own words that will not break wrap inside the card (320 dp, 130%)', async () => {
        const long = { key: 'long', name: 'A'.repeat(80), url: 'https://long.example.org', memberCount: 9, distanceKm: 30 };
        await rememberKnock(ME.publicKey, long, new Date(Date.now() - 3_600_000));

        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: [long] }, true)));
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: false, kind: 'refused', status: 500, code: 'x', message: 'B'.repeat(90) });

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const sent = await screen.findByTestId('home-waiting-sent-https://long.example.org');
        const arrived = await screen.findByText('B'.repeat(90));
        for (const line of [sent, arrived]) {
            expect(line).toHaveClass('break-words');
            expect(line).toHaveAttribute('dir', 'auto');
        }

        readSpy.mockRestore();
    });
});

/** KNOCK_MESSAGES.none: what the Home card and the community's own card say of a request nothing holds (decided 29 Oct 2026). */
const NONE_LINE = 'This request is no longer open. You can ask again.';
/** KNOCK_MESSAGES.cancelled: under the sent line of a card whose cancel worked, for the rest of that Home visit. */
const CANCELLED_LINE = 'You cancelled your request. You can ask again after 24 hours.';

describe('the web waiting card tells the truth about what the community now answers (Lounge L1, review of #2573)', () => {
    const BYRON = { key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', memberCount: 40, distanceKm: 12 };
    const LISMORE = { key: 'lismore', name: 'Lismore BeanPool', url: 'https://lismore.example.org', memberCount: 30, distanceKm: 40 };
    const arrivedOf = (url: string) => within(screen.getByTestId(`home-waiting-card-${url}`)).getByTestId(`home-waiting-arrived-${url}`);
    const cancelOf = (url: string) => screen.queryByTestId(`home-cancel-knock-${url}`);

    async function askedOf(...comms: Array<typeof BYRON>) {
        for (const [i, c] of comms.entries()) await rememberKnock(ME.publicKey, c, new Date(Date.now() - (5 - i) * 3_600_000));
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: comms }, true)));
    }
    afterEach(() => { vi.restoreAllMocks(); });

    it('a community with nothing open (lapsed, cancelled elsewhere) says it is no longer open, with no Cancel under it', async () => {
        await askedOf(BYRON);
        vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'none' } });

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await screen.findByTestId('home-waiting-card-https://byron.example.org');
        await waitFor(() => expect(arrivedOf(BYRON.url)).toHaveTextContent(NONE_LINE));
        expect(arrivedOf(BYRON.url)).not.toHaveTextContent('Your request arrived.');
        expect(cancelOf(BYRON.url)).toBeNull();
        expect(document.body.textContent).not.toContain('No answer came');
    });

    it('a read that could not be made, or a refusal, is said as it is, with no Cancel', async () => {
        await askedOf(BYRON, LISMORE);
        vi.spyOn(knockModule, 'readKnockStatus').mockImplementation(async (url) => (url === BYRON.url
            ? { ok: false, kind: 'unreachable', message: "Couldn't reach this community. Check your connection and try again." }
            : { ok: false, kind: 'refused', status: 500, code: null, message: 'Back in an hour.' }));

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(arrivedOf(BYRON.url)).toHaveTextContent("Couldn't reach this community. Check your connection and try again."));
        await waitFor(() => expect(arrivedOf(LISMORE.url)).toHaveTextContent('Back in an hour.'));
        expect(cancelOf(BYRON.url)).toBeNull();
        expect(cancelOf(LISMORE.url)).toBeNull();
    });

    it('a cancel the community answers "not_found" stops offering Cancel, and the card says what it now answers', async () => {
        await askedOf(BYRON);
        // The community holds the request until the cancel is refused, and nothing after: the card reads it again to say so.
        let held = true;
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockImplementation(async () => ({ ok: true, value: { status: held ? 'pending' : 'none' } }));
        vi.spyOn(knockModule, 'cancelKnock').mockImplementation(async () => {
            held = false;
            return { ok: false, message: 'There is no open request from you here.', status: 404, code: 'not_found' };
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(arrivedOf(BYRON.url)).toHaveTextContent('Your request arrived.'));
        const readsBefore = readSpy.mock.calls.length;
        fireEvent.click(screen.getByTestId(`home-cancel-knock-${BYRON.url}`));

        expect(await screen.findByTestId(`home-cancel-error-${BYRON.url}`)).toHaveTextContent('There is no open request from you here.');
        expect(readSpy.mock.calls.length).toBe(readsBefore + 1);
        expect(arrivedOf(BYRON.url)).toHaveTextContent(NONE_LINE);
        expect(screen.getByTestId(`home-gotit-knock-${BYRON.url}`)).toHaveTextContent('Got it');
        expect(cancelOf(BYRON.url)).toBeNull();
    });

    it('a cancel that meets a "yes" (404 not_found, then the community says approved) shows the invite, never "No answer came"', async () => {
        await askedOf(BYRON);
        let said: 'pending' | 'approved' = 'pending';
        vi.spyOn(knockModule, 'readKnockStatus').mockImplementation(async () => (said === 'pending'
            ? { ok: true, value: { status: 'pending' } }
            : { ok: true, value: { status: 'approved', invite: 'ABCD-EFGH', expiresAt: null } }));
        vi.spyOn(knockModule, 'cancelKnock').mockImplementation(async () => {
            said = 'approved';
            return { ok: false, message: 'There is no open request from you here.', status: 404, code: 'not_found' };
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(arrivedOf(BYRON.url)).toHaveTextContent('Your request arrived.'));
        fireEvent.click(screen.getByTestId(`home-cancel-knock-${BYRON.url}`));

        expect(await screen.findByTestId(`home-find-invited-${BYRON.url}`)).toHaveTextContent('said yes');
        expect(screen.queryByTestId(`home-waiting-card-${BYRON.url}`)).toBeNull();
        expect(cancelOf(BYRON.url)).toBeNull();
        expect(document.body.textContent).not.toContain('No answer came');
        expect(document.body.textContent).not.toContain('no open request');
    });

    it('a cancel that gets a 404 whose re-read cannot be made says why, with no Cancel and never "No answer came"', async () => {
        await askedOf(BYRON);
        let down = false;
        vi.spyOn(knockModule, 'readKnockStatus').mockImplementation(async () => (down
            ? { ok: false, kind: 'unreachable', message: "Couldn't reach this community. Check your connection and try again." }
            : { ok: true, value: { status: 'pending' } }));
        vi.spyOn(knockModule, 'cancelKnock').mockImplementation(async () => {
            down = true;
            return { ok: false, message: 'There is no open request from you here.', status: 404, code: 'not_found' };
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(arrivedOf(BYRON.url)).toHaveTextContent('Your request arrived.'));
        fireEvent.click(screen.getByTestId(`home-cancel-knock-${BYRON.url}`));

        await waitFor(() => expect(arrivedOf(BYRON.url)).toHaveTextContent("Couldn't reach this community. Check your connection and try again."));
        expect(cancelOf(BYRON.url)).toBeNull();
        expect(document.body.textContent).not.toContain('No answer came');
    });

    it('two cancels out at once: each button stays its own (the first finishing does not free the second, a press on a busy one sends nothing)', async () => {
        await askedOf(BYRON, LISMORE);
        vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        let finishA: (r: { ok: true }) => void = () => {};
        let finishB: (r: { ok: true }) => void = () => {};
        const cancelSpy = vi.spyOn(knockModule, 'cancelKnock')
            .mockReturnValueOnce(new Promise(resolve => { finishA = resolve; }))
            .mockReturnValueOnce(new Promise(resolve => { finishB = resolve; }));
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const a = await screen.findByTestId(`home-cancel-knock-${BYRON.url}`);
        const b = await screen.findByTestId(`home-cancel-knock-${LISMORE.url}`);
        fireEvent.click(a);
        await waitFor(() => expect(a).toBeDisabled());
        fireEvent.click(b);
        await waitFor(() => expect(b).toBeDisabled());

        // B started while A is out: A's button is still busy, and a press on it sends nothing.
        expect(a).toBeDisabled();
        fireEvent.click(a);
        expect(cancelSpy).toHaveBeenCalledTimes(2);
        expect(confirmSpy).toHaveBeenCalledTimes(2);

        // A finishes: its card stays and says so, its button is gone; B's button is still busy.
        await act(async () => { finishA({ ok: true }); });
        await waitFor(() => expect(screen.getByTestId(`home-waiting-cancelled-${BYRON.url}`)).toHaveTextContent(CANCELLED_LINE));
        expect(screen.queryByTestId(`home-cancel-knock-${BYRON.url}`)).toBeNull();
        expect(screen.getByTestId(`home-cancel-knock-${LISMORE.url}`)).toBeDisabled();
        expect(screen.queryByTestId(`home-waiting-cancelled-${LISMORE.url}`)).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();

        // B finishes: both say so, and A's line did not go when B's came.
        await act(async () => { finishB({ ok: true }); });
        await waitFor(() => expect(screen.getByTestId(`home-waiting-cancelled-${LISMORE.url}`)).toHaveTextContent(CANCELLED_LINE));
        expect(screen.getByTestId(`home-waiting-cancelled-${BYRON.url}`)).toHaveTextContent(CANCELLED_LINE);
        expect(screen.queryByTestId(`home-cancel-knock-${LISMORE.url}`)).toBeNull();
    });
});

describe('the card of a request the community no longer holds, and after a Cancel that worked (decided 29 Oct 2026, PR #2573)', () => {
    const BYRON = { key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', memberCount: 40, distanceKm: 12, answers: 'week' as const };
    const LISMORE = { key: 'lismore', name: 'Lismore BeanPool', url: 'https://lismore.example.org', memberCount: 30, distanceKm: 40 };
    const cardOf = (url: string) => screen.getByTestId(`home-waiting-card-${url}`);
    const stored = () => JSON.parse(localStorage.getItem('beanpool_knocks') ?? '{"knocks":[]}').knocks as Array<{ url: string; cancelledAt?: string }>;

    async function askedOf(...comms: Array<typeof BYRON | typeof LISMORE>) {
        for (const [i, c] of comms.entries()) await rememberKnock(ME.publicKey, c, new Date(Date.now() - (5 - i) * 3_600_000));
        vi.mocked(api.getHome).mockResolvedValue(fresh(globalAnswer({ communities: comms }, true)));
    }
    afterEach(() => { vi.restoreAllMocks(); });

    it('the none card is three lines and Got it: when it was asked, that it is no longer open, that the member can ask again; no Cancel, no measured line', async () => {
        await askedOf(BYRON);
        vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'none' } });

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(within(cardOf(BYRON.url)).getByTestId(`home-waiting-arrived-${BYRON.url}`)).toHaveTextContent(NONE_LINE));

        const card = cardOf(BYRON.url);
        expect(within(card).getByTestId(`home-waiting-sent-${BYRON.url}`)).toHaveTextContent(/^You asked to join Byron Shire BeanPool on \d{1,2} \w{3} \d{4}\.$/);
        expect(within(card).getByRole('button', { name: 'Got it' })).toBeInTheDocument();
        expect(within(card).queryByRole('button', { name: 'Cancel my request' })).toBeNull();
        expect(within(card).queryByTestId(`home-waiting-answers-${BYRON.url}`)).toBeNull();
        expect(document.body.textContent).not.toContain('No answer came');
    });

    it('Got it forgets the knock (the store too), the card goes, and Find is a card like any other: its "…" is back', async () => {
        await askedOf(BYRON, LISMORE);
        vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'none' } });

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(within(cardOf(BYRON.url)).getByTestId(`home-waiting-arrived-${BYRON.url}`)).toHaveTextContent(NONE_LINE));
        // Pinned while a request is shown, even one nothing holds: no "…".
        expect(within(screen.getByTestId('home-card-find')).queryByTestId('home-card-menu')).toBeNull();

        fireEvent.click(screen.getByTestId(`home-gotit-knock-${BYRON.url}`));
        await waitFor(() => expect(screen.queryByTestId(`home-waiting-card-${BYRON.url}`)).toBeNull());
        expect(stored().map(k => k.url)).toEqual([LISMORE.url]);
        // The other still shows, so the pin still holds.
        expect(screen.getByTestId(`home-waiting-card-${LISMORE.url}`)).toBeInTheDocument();
        expect(within(screen.getByTestId('home-card-find')).queryByTestId('home-card-menu')).toBeNull();

        fireEvent.click(screen.getByTestId(`home-gotit-knock-${LISMORE.url}`));
        await waitFor(() => expect(screen.queryByTestId(`home-waiting-card-${LISMORE.url}`)).toBeNull());
        expect(stored()).toEqual([]);
        // Nothing open, no watch: past day 30 the pin is gone, and the card can be moved or removed again.
        await waitFor(() => expect(within(screen.getByTestId('home-card-find')).getByTestId('home-card-menu')).toBeInTheDocument());
    });

    it('a request that waits, or whose answer could not be read, has no Got it', async () => {
        await askedOf(BYRON, LISMORE);
        vi.spyOn(knockModule, 'readKnockStatus').mockImplementation(async (url) => (url === BYRON.url
            ? { ok: true, value: { status: 'pending' } }
            : { ok: false, kind: 'unreachable', message: "Couldn't reach this community. Check your connection and try again." }));

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(within(cardOf(LISMORE.url)).getByTestId(`home-waiting-arrived-${LISMORE.url}`)).toHaveTextContent("Couldn't reach this community"));
        await waitFor(() => expect(within(cardOf(BYRON.url)).getByTestId(`home-waiting-arrived-${BYRON.url}`)).toHaveTextContent('Your request arrived.'));
        expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
    });

    it('a Cancel that worked keeps the card for this visit: no button, the cancelled line under the sent line in a polite live region, nothing stored but the cancel, the pin held', async () => {
        await askedOf(BYRON);
        vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        vi.spyOn(knockModule, 'cancelKnock').mockResolvedValue({ ok: true });
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(within(cardOf(BYRON.url)).getByTestId(`home-waiting-arrived-${BYRON.url}`)).toHaveTextContent('Your request arrived.'));
        fireEvent.click(screen.getByTestId(`home-cancel-knock-${BYRON.url}`));

        const line = await screen.findByTestId(`home-waiting-cancelled-${BYRON.url}`);
        expect(line).toHaveTextContent(CANCELLED_LINE);
        const status = within(cardOf(BYRON.url)).getByRole('status');
        expect(status).toContainElement(line);
        // Under the sent line, in place of the arrived line; no button, no measured line, no Got it.
        const card = cardOf(BYRON.url);
        expect(Array.from(card.children).map(c => c.getAttribute('data-testid') ?? c.getAttribute('role'))).toEqual([
            `home-waiting-sent-${BYRON.url}`, 'status',
        ]);
        expect(screen.queryByTestId(`home-cancel-knock-${BYRON.url}`)).toBeNull();
        expect(screen.queryByTestId(`home-waiting-arrived-${BYRON.url}`)).toBeNull();
        expect(screen.queryByTestId(`home-waiting-answers-${BYRON.url}`)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
        // The card (and the Find card holding it) stays where it was for this visit: still pinned.
        expect(within(screen.getByTestId('home-card-find')).queryByTestId('home-card-menu')).toBeNull();
        // This visit only: the card wrote nothing (the knock is still the one remembered; cancelKnock is mocked here).
        expect(stored().map(k => k.url)).toEqual([BYRON.url]);
    });

    // LG-L1-W (review of #2573): the line is for the whole Home visit, through the visit's later reads of Home, and gone the next visit.
    it('a Cancel that worked: the cancelled line and the pin stay through the next read of Home, and the next visit (Home mounted again) draws no card for it', async () => {
        await askedOf(BYRON);
        vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        // As the real cancelKnock leaves the browser: the knock stays in the store, marked cancelled.
        vi.spyOn(knockModule, 'cancelKnock').mockImplementation(async () => {
            const store = JSON.parse(localStorage.getItem('beanpool_knocks')!);
            localStorage.setItem('beanpool_knocks', JSON.stringify({ ...store, knocks: store.knocks.map((k: object) => ({ ...k, cancelledAt: new Date().toISOString() })) }));
            return { ok: true };
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        const first = render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(within(cardOf(BYRON.url)).getByTestId(`home-waiting-arrived-${BYRON.url}`)).toHaveTextContent('Your request arrived.'));
        fireEvent.click(screen.getByTestId(`home-cancel-knock-${BYRON.url}`));
        expect(await screen.findByTestId(`home-waiting-cancelled-${BYRON.url}`)).toHaveTextContent(CANCELLED_LINE);

        // The visit reads Home again (a notice put away rings it).
        const reads = vi.mocked(api.getHome).mock.calls.length;
        await act(async () => { window.dispatchEvent(new Event(NOTICES_SEEN_EVENT)); });
        await waitFor(() => expect(vi.mocked(api.getHome).mock.calls.length).toBeGreaterThan(reads));
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId(`home-waiting-cancelled-${BYRON.url}`)).toHaveTextContent(CANCELLED_LINE);
        expect(within(screen.getByTestId('home-card-find')).queryByTestId('home-card-menu')).toBeNull();

        // Leaving Home and coming back mounts it again: the browser holds the request cancelled, so no card, and no pin past day 30.
        first.unmount();
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(vi.mocked(api.getHome).mock.calls.length).toBeGreaterThan(reads + 1));
        await act(async () => { await Promise.resolve(); });
        expect(screen.queryByTestId(`home-waiting-card-${BYRON.url}`)).toBeNull();
        expect(document.body.textContent).not.toContain(CANCELLED_LINE);
    });

    it('a Cancel that failed still shows the error and the button, and no cancelled line', async () => {
        await askedOf(BYRON);
        vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });
        vi.spyOn(knockModule, 'cancelKnock').mockResolvedValue({ ok: false, message: 'Node could not be reached' });
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(within(cardOf(BYRON.url)).getByTestId(`home-waiting-arrived-${BYRON.url}`)).toHaveTextContent('Your request arrived.'));
        fireEvent.click(screen.getByTestId(`home-cancel-knock-${BYRON.url}`));

        expect(await screen.findByTestId(`home-cancel-error-${BYRON.url}`)).toHaveTextContent('Node could not be reached');
        expect(screen.getByTestId(`home-cancel-knock-${BYRON.url}`)).toBeInTheDocument();
        expect(screen.queryByTestId(`home-waiting-cancelled-${BYRON.url}`)).toBeNull();
    });
});

/**
 * What a global node answers, built only for the cards asked (`cards=`), as the real one does; asked nothing, it builds the
 * member's own list and Find only in their first 30 days (routes/home-answer.ts `cardsToBuild`), knowing nothing of the
 * knocks a browser remembers.
 */
function answerFor(asked: readonly string[] | undefined, over: { joinedDaysAgo: number; listed: string[]; find: Partial<HomeFind> }): HomeAnswer {
    const joinedAt = new Date(Date.now() - over.joinedDaysAgo * 86_400_000).toISOString();
    const all: Record<string, unknown> = { find: { ...NONE_NEAR, ...over.find }, market: { items: [], total14d: 0, more: false } };
    const built = asked ?? [...over.listed, ...(over.joinedDaysAgo < 30 ? ['find'] : [])];
    const cards = Object.fromEntries(Object.entries(all).filter(([id]) => built.includes(id)));
    return {
        generatedAt: NOW, profile: 'global', welcome: false,
        features: { beans: false, guestListingsOnly: true, invites: false },
        me: { joinedAt, isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
        layout: { v: 2, cards: over.listed.map(id => ({ id, type: id })), dismissed: {}, updatedAt: null },
        cards,
    } as unknown as HomeAnswer;
}

describe('Find your community stays on Home where the list does not hold it (Lounge L1, review of #2573)', () => {
    const BYRON = { key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org', memberCount: 40, distanceKm: 12, answers: 'week' as const };
    const asks = () => vi.mocked(api.getHome).mock.calls.map(c => (c[0] as { cards?: string[] }).cards ?? []);
    let joinedDaysAgo = 3;

    beforeEach(() => {
        joinedDaysAgo = 3;
        vi.mocked(api.getHome).mockImplementation(async (params) => fresh(answerFor((params as { cards?: string[] }).cards, {
            joinedDaysAgo, listed: ['market'], find: { communities: [BYRON] },
        })));
    });

    it('a newcomer on day 3 with no wait: Find is drawn first, from a list that does not hold it, with no "…", as on main', async () => {
        joinedDaysAgo = 3;
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const find = await screen.findByTestId('home-card-find');
        expect(within(find).queryByTestId('home-card-menu')).toBeNull();
    });

    it('past day 30 with no wait it is a card like any other: not asked for, not drawn', async () => {
        joinedDaysAgo = 40;
        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        await waitFor(() => expect(api.getHome).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByTestId('home-card-market')).toBeInTheDocument());
        expect(asks().flat()).not.toContain('find');
        expect(screen.queryByTestId('home-card-find')).toBeNull();
    });

    it('past day 30 with an open knock, from a list without Find: it is asked for, and the waiting card is drawn', async () => {
        joinedDaysAgo = 40;
        await rememberKnock(ME.publicKey, BYRON, new Date(Date.now() - 5 * 3_600_000));
        const readSpy = vi.spyOn(knockModule, 'readKnockStatus').mockResolvedValue({ ok: true, value: { status: 'pending' } });

        render(<HomePage identity={ME} onNavigate={vi.fn()} />);
        const card = await screen.findByTestId('home-waiting-card-https://byron.example.org');
        expect(within(card).getByTestId('home-waiting-sent-https://byron.example.org')).toHaveTextContent('You asked to join Byron Shire BeanPool');
        // The node was told to build it, and the card has no "…" while the request waits.
        expect(asks().some(cards => cards.includes('find'))).toBe(true);
        expect(within(screen.getByTestId('home-card-find')).queryByTestId('home-card-menu')).toBeNull();

        readSpy.mockRestore();
    });
});
