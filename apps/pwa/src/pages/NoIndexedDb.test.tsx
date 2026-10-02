/**
 * The global node's lobby in a web browser (G9b, design G9a §7): a visitor with no key looks at the Market and the Map
 * before joining. The whole App, with the node as a stubbed fetch answering as the global node answers a guest
 * (G9a's `guestPost()`: no author key, name, face or tier; the place at its area's centre), the socket mocked, and
 * Leaflet mocked as MapPage.test does. Nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { generateIdentity, loadIdentity, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import * as gate from '../lib/visitor-lobby-gate';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { saveRadiusSettings, clearRadiusSettings } from '../lib/geo';
import * as sync from '../lib/sync';
import { importIdentity } from '../lib/identity';
import { request } from '../lib/api';


const markers = vi.hoisted(() => [] as Array<{ coords: [number, number]; listeners: Record<string, () => void> }>);

vi.mock('leaflet.markercluster', () => ({}));
vi.mock('leaflet', () => {
    const layer = () => ({ clearLayers: vi.fn(), addLayer: vi.fn(), addTo: vi.fn().mockReturnThis() });
    return {
        default: {
            map: vi.fn((_el: unknown, opts: any) => ({
                setView: vi.fn(), panBy: vi.fn(), fitBounds: vi.fn(), on: vi.fn(), off: vi.fn(), remove: vi.fn(), removeLayer: vi.fn(),
                getZoom: vi.fn(() => opts?.zoom ?? 13),
                getCenter: vi.fn(() => ({ lat: 0, lng: 0 })),
                getContainer: vi.fn(() => ({ getBoundingClientRect: () => ({ top: 0, bottom: 640, left: 0, right: 320 }) })),
                locate: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(),
            })),
            tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
            control: { attribution: vi.fn(() => ({ addAttribution: vi.fn().mockReturnThis(), addTo: vi.fn() })) },
            divIcon: vi.fn((opts) => opts),
            marker: vi.fn((coords: [number, number], opts: any) => {
                const listeners: Record<string, () => void> = {};
                const m = {
                    coords, opts: { ...opts, ...(opts?.icon || {}) }, listeners,
                    addTo: vi.fn().mockReturnThis(), setLatLng: vi.fn(), remove: vi.fn(),
                    on: vi.fn((event: string, handler: () => void) => { listeners[event] = handler; }),
                };
                markers.push(m);
                return m;
            }),
            circle: vi.fn(() => ({ addTo: vi.fn().mockReturnThis(), getBounds: vi.fn(() => ({})) })),
            markerClusterGroup: vi.fn(layer),
            layerGroup: vi.fn(layer),
        },
    };
});
vi.mock('../lib/sync', () => ({
    connectToAnchor: vi.fn(),
    reconnectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSyncChange: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
    getSyncState: vi.fn(() => ({ connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 })),
}));
vi.mock('../components/InstallPrompt', () => ({ InstallPrompt: () => null }));

/** useTheme reads it; jsdom has none. Set before each test, since restoreAllMocks clears a mock's implementation. */
function stubMatchMedia() {
    window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

/*
 * Every read a visitor may make of the global node: the node's public allowlist (apps/server/src/https-server.ts,
 * PUBLIC_READ_EXACT and PUBLIC_READ_PATTERNS) less what is members-only there (MEMBERS_ONLY_READS_*: Commons
 * decisions, the Pulse feed, enterprises, treasuries, crowdfunds and Commons projects, on every node; and
 * MEMBERS_ONLY_ON_GUEST_LISTINGS_EXACT: the Commons pot, with the visitors' view on). Copied, since the server can't be
 * imported here: a read added to the lobby that isn't one of these fails the test below.
 */
const VISITOR_READS_EXACT = new Set([
    '/api/version', '/api/community/info', '/api/community/health', '/api/node/config', '/api/directory/info',
    '/api/invite/check', '/api/attest', '/api/marketplace/posts', '/api/federation/reachable-peers', '/api/pricing-guide',
    '/api/pair/poll', '/api/channels/options', '/api/pulse/oauth/config', '/api/node/info', '/api/federation/links',
    '/api/node/identity-epoch', '/api/global/communities', '/api/global/home', '/api/join/knock/status',
]);
const VISITOR_READS_PATTERNS = [
    /^\/api\/community\/membership\/[^/]+$/,
    /^\/api\/members\/callsign-available\/[^/]+$/,
    /^\/api\/recovery\/lookup\/[^/]+$/,
    /^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/,
    /^\/api\/messages\/[^/]+\/attachment$/,
    /^\/api\/pulse\/items\/[^/]+\/thumbnail$/,
    /^\/api\/avatar\/[^/]+$/,
];
const visitorMayRead = (path: string) => VISITOR_READS_EXACT.has(path) || VISITOR_READS_PATTERNS.some(re => re.test(path));

const GLOBAL = {
    memberCount: 3, postCount: 4, transactionCount: 0, commonsBalance: 0, profile: 'global',
    features: { openJoin: true, guestListingsOnly: true, beans: false },
};
const LOCAL = { ...GLOBAL, profile: 'local', features: { openJoin: false, guestListingsOnly: false, beans: true } };

// The posts as the global node sends them to a guest (G9a guestPost): the person neutralised, the place at the centre
// of its 0.1° cell, no typed event place and no poll voters.
const NOW = new Date().toISOString();
const IN_TWO_DAYS = new Date(Date.now() + 2 * 86_400_000).toISOString();
const IN_TWO_DAYS_LATER = new Date(Date.now() + 2 * 86_400_000 + 7_200_000).toISOString();
const person = { authorPublicKey: 'hidden', authorCallsign: '', authorAvatarUrl: null, authorEnergyCycled: 0, authorFoundingNeeded: false };
const OFFER = {
    id: 'p-offer', type: 'offer', category: 'food', title: 'Sourdough loaves', description: 'Fresh on Saturdays. Happy to swap for eggs.',
    credits: 0, priceType: 'fixed', status: 'active', active: true, repeatable: false, audienceScope: 'public',
    photos: ['/api/marketplace/posts/p-offer/photos/0', '/api/marketplace/posts/p-offer/photos/1'],
    lat: -28.55, lng: 153.55, createdAt: NOW, updatedAt: NOW, ...person,
};
const NEED = {
    ...OFFER, id: 'p-need', type: 'need', category: 'tools', title: 'Borrow a ladder', description: 'Two days next week.', photos: [],
    lat: -28.65, lng: 153.55,
};
const EVENT = {
    ...OFFER, id: 'p-event', type: 'event', category: 'events', title: 'Seed swap in the park', description: 'Bring seeds.', photos: [],
    eventStartAt: IN_TWO_DAYS, eventEndAt: IN_TWO_DAYS_LATER, eventState: 'scheduled', goingCount: 4, interestedCount: 2,
};
const POLL = {
    ...OFFER, id: 'p-poll', type: 'poll', category: 'general', title: 'Market on Sundays?', description: '', photos: [], lat: undefined, lng: undefined,
    pollOptions: [{ id: 'o1', text: 'Yes', votes: 3, percentage: 75 }, { id: 'o2', text: 'No', votes: 1, percentage: 25 }],
    totalVotes: 4, pollClosesAt: IN_TWO_DAYS,
};
const GUEST_POSTS = [OFFER, NEED, EVENT, POLL];

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Call = { path: string; headers: Record<string, string> };

/**
 * The node, answering a visitor as the global node does. `members`: keys the membership probe says are members;
 * `peerNodes`: the peer communities `/api/node/info` names.
 */
function stubNode(info: unknown, members: Map<string, string> = new Map(), peerNodes: unknown[] = []) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        const path = url.split('?')[0];
        calls.push({ path, headers: (init.headers ?? {}) as Record<string, string> });
        if (path === '/api/community/info') return json(200, info);
        if (path === '/api/community/health') return json(200, { status: 'ok', version: '1.2.26' });
        if (path === '/api/marketplace/posts') {
            const id = new URLSearchParams(url.split('?')[1] ?? '').get('id');
            return json(200, id ? GUEST_POSTS.filter(p => p.id === id) : GUEST_POSTS);
        }
        if (path === '/api/node/config') return json(200, { serviceRadius: null });
        if (path === '/api/node/info') return json(200, { peerNodes });
        if (path.startsWith('/api/community/membership/')) {
            const key = decodeURIComponent(path.split('/').pop()!);
            return json(200, { isMember: members.has(key), callsign: members.get(key) ?? null });
        }
        // A member's polls, once someone has joined or restored (the node sends a list and a count, not an object).
        if (path === '/api/marketplace/transactions') return json(200, []);
        if (path.startsWith('/api/messages/conversations/')) return json(200, { conversations: [], totalUnread: 0 });
        if (path === '/api/groups') return json(200, []);
        return json(200, {});
    }));
    return calls;
}


const SENTENCE = /This browser can't keep your account/;

/** indexedDB as an in-app browser or a storage-blocked profile gives it: absent, or present and refusing to open. */
const NO_IDB: Record<string, () => void> = {
    absent: () => vi.stubGlobal('indexedDB', undefined),
    refusing: () => vi.stubGlobal('indexedDB', {
        open: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    }),
    'failing to open': () => vi.stubGlobal('indexedDB', {
        open: () => {
            const req: any = {};
            setTimeout(() => { req.error = new DOMException('blocked', 'UnknownError'); req.onerror?.(); }, 0);
            return req;
        },
    }),
};

beforeEach(() => {
    stubMatchMedia();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    resetCommunityInfoOnce();
    clearRadiusSettings();
    sessionStorage.clear();
    markers.length = 0;
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearRadiusSettings();
    sessionStorage.clear();
});

describe.each(Object.keys(NO_IDB))('a visitor whose browser has IndexedDB %s', (kind) => {
    beforeEach(() => NO_IDB[kind]());

    it('still gets the guest lobby and its listings from the node, every read unsigned', async () => {
        const calls = stubNode(GLOBAL);
        render(<App />);
        await screen.findByTestId('guest-lobby');
        const list = await screen.findByTestId('visitor-list');
        expect(within(list).getAllByTestId('visitor-card').map(c => within(c).getByText(/Sourdough|ladder/).textContent)).toEqual(['Sourdough loaves', 'Borrow a ladder']);
        expect(within(list).getByTestId('event-card')).toHaveTextContent('Seed swap in the park');
        expect(calls.some(c => c.path === '/api/community/info')).toBe(true);
        for (const c of calls) {
            expect(visitorMayRead(c.path)).toBe(true);
            expect(c.headers['X-Public-Key'] ?? c.headers['x-public-key']).toBeUndefined();
        }
    });

    it('is told in one plain sentence, on the Join card and on the join screen, that this browser cannot keep an account', async () => {
        stubNode(GLOBAL);
        render(<App />);
        await screen.findByTestId('guest-lobby');
        expect(await screen.findByTestId('lobby-too-old')).toHaveTextContent(SENTENCE);
        expect(screen.getByTestId('lobby-too-old').textContent).toMatch(/phone's normal browser/);
        expect(screen.getByTestId('lobby-too-old').textContent).toMatch(/BeanPool app/);
        expect(screen.getByTestId('lobby-too-old').textContent).not.toMatch(/too old/);
        expect(screen.queryByTestId('lobby-join')).toBeNull();
        fireEvent.click(screen.getAllByTestId('header-join')[0]);
        const overlay = await screen.findByTestId('lobby-join-overlay');
        expect(await within(overlay).findByTestId('join-too-old')).toHaveTextContent(SENTENCE);
        expect(overlay.textContent).not.toMatch(/went wrong|Reload/i);
        fireEvent.click(within(overlay).getByRole('button', { name: 'Already have BeanPool?' }));
        expect(await within(overlay).findByTestId('restore-too-old')).toHaveTextContent(SENTENCE);
    });
});

describe('a browser whose IndexedDB works', () => {
    it('is unchanged: a visitor gets the lobby and the usual Join, and nothing says the browser cannot keep an account', async () => {
        stubNode(GLOBAL);
        render(<App />);
        await screen.findByTestId('guest-lobby');
        expect(await screen.findByTestId('lobby-join')).toBeEnabled();
        expect(screen.queryByTestId('lobby-too-old')).toBeNull();
        expect(document.body.textContent).not.toMatch(SENTENCE);
    });

    it('signs a request with the stored key', async () => {
        const id = await generateIdentity('Alice');
        await importIdentity(id);
        const calls = stubNode(GLOBAL);
        await request('GET', '/api/marketplace/posts');
        expect(calls[0].headers['X-Public-Key'] ?? calls[0].headers['x-public-key']).toBeTruthy();
    });
});

describe('request() with no IndexedDB', () => {
    it('goes out unsigned and returns the answer', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const calls = stubNode(GLOBAL);
        await expect(request('GET', '/api/community/info')).resolves.toMatchObject({ profile: 'global' });
        expect(calls).toHaveLength(1);
        expect(Object.keys(calls[0].headers).map(k => k.toLowerCase())).toEqual(['content-type']);
    });

    it('refuses a write that needs a key, plainly, and sends nothing for the key', async () => {
        vi.stubGlobal('indexedDB', undefined);
        await expect(importIdentity(await generateIdentity('Bob'))).rejects.toThrow(SENTENCE);
        await expect(savePendingJoin({ identity: await generateIdentity('Bob'), provider: null, nonce: null, startedAt: 1, expiresAt: Date.now() + 1e6, restored: false })).rejects.toThrow(SENTENCE);
    });
});
