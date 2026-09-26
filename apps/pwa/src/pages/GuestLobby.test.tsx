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
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { saveRadiusSettings, clearRadiusSettings } from '../lib/geo';
import * as sync from '../lib/sync';

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
 * PUBLIC_READ_EXACT and PUBLIC_READ_PATTERNS) less what it makes members-only with the visitors' view on
 * (MEMBERS_ONLY_ON_GUEST_LISTINGS_*: Commons decisions and balance, the Pulse feed, enterprises, treasuries,
 * crowdfunds and Commons projects). Copied, since the server can't be imported here: a read added to the lobby that
 * isn't one of these fails the test below.
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

/** The node, answering a visitor as the global node does. `members`: keys the membership probe says are members. */
function stubNode(info: unknown, members: Map<string, string> = new Map()) {
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
        if (path === '/api/node/info') return json(200, { peerNodes: [] });
        if (path.startsWith('/api/community/membership/')) {
            const key = decodeURIComponent(path.split('/').pop()!);
            return json(200, { isMember: members.has(key), callsign: members.get(key) ?? null });
        }
        return json(200, {});
    }));
    return calls;
}

beforeEach(() => {
    stubMatchMedia();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    resetCommunityInfoOnce();
    clearRadiusSettings();
    markers.length = 0;
    window.history.replaceState(null, '', '/app');
    vi.mocked(sync.connectToAnchor).mockClear();
    vi.mocked(sync.reconnectToAnchor).mockClear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearRadiusSettings();
});

async function openLobby() {
    render(<App />);
    return await screen.findByTestId('guest-lobby');
}

describe('a visitor with no key on the global node', () => {
    it('gets the lobby, not the welcome page alone: the header with Join where Settings sits, the Market and the Map', async () => {
        stubNode(GLOBAL);
        await openLobby();

        expect(screen.queryByText('Welcome to BeanPool')).toBeNull();
        expect(screen.queryByTestId('join-screen-lobby')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
        expect(screen.getAllByTestId('header-join').length).toBeGreaterThan(0);
        const nav = screen.getByTestId('lobby-bottom-nav');
        expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual(['🤝Market', '🗺️Map']);
        expect(await screen.findByTestId('lobby-join-card')).toHaveTextContent('No invite needed');
        expect(screen.getByTestId('lobby-have-account')).toHaveTextContent('Already have BeanPool?');
        // No key was made just to look.
        expect(await loadIdentity()).toBeNull();
        // The doorbell socket, opened with no key.
        expect(sync.connectToAnchor).toHaveBeenCalled();
    });

    it('shows each listing without the person: no author, face or tier, the terms with no Beans, and the one line once, under the first card', async () => {
        stubNode(GLOBAL);
        await openLobby();
        const list = await screen.findByTestId('visitor-list');

        const cards = within(list).getAllByTestId('visitor-card');
        expect(cards.map(c => within(c).getByText(/Sourdough|ladder/).textContent)).toEqual(['Sourdough loaves', 'Borrow a ladder']);
        for (const card of cards) {
            expect(within(card).getByTestId('visitor-card-terms')).toHaveTextContent('Free, a swap, or ask');
            expect(card).not.toHaveTextContent(/hidden|Anonymous|Elder|Steward|Resident|Newcomer|⛰️|Beans|\bB\b/);
            for (const img of Array.from(card.querySelectorAll('img'))) expect(img.getAttribute('src')).not.toMatch(/\/api\/avatar\//);
        }
        expect(within(cards[0]).getByTestId('visitor-card-category')).toHaveTextContent('Food & Produce');
        // No point shared: no distance at all.
        expect(within(list).queryAllByTestId('visitor-card-distance')).toHaveLength(0);

        const notes = within(list).getAllByTestId('visitor-list-note');
        expect(notes).toHaveLength(1);
        expect(notes[0]).toHaveTextContent('Names, photos of people and exact places appear when you join.');
        // Right after the first card in the list, before the second.
        const order = Array.from(list.querySelectorAll('[data-testid="visitor-card"], [data-testid="visitor-list-note"], [data-testid="event-card"]'));
        expect(order[1]).toBe(notes[0]);

        // The poll: its answers and counts, no author row and nothing to vote with.
        expect(within(list).getAllByTestId('poll-option-readonly')).toHaveLength(2);
        expect(within(list).queryByText(/Your vote is visible/)).toBeNull();
        expect(within(list).queryByRole('button', { name: /View .*'s profile/ })).toBeNull();
        // The event: its time, no RSVP.
        expect(within(list).getByTestId('event-card')).toHaveTextContent('Seed swap in the park');
        expect(within(list).queryByTestId('event-rsvp-row')).toBeNull();
        expect(document.body.textContent).not.toMatch(/\bhidden\b/);
    });

    it('from a point the visitor shared: "about N km" in whole km, and "About N km away · area only" on the sheet', async () => {
        saveRadiusSettings({ lat: -28.55, lng: 153.55, radiusKm: 50, label: 'Home' });
        stubNode(GLOBAL);
        await openLobby();
        const list = await screen.findByTestId('visitor-list');
        const distances = within(list).getAllByTestId('visitor-card-distance').map(d => d.textContent);
        expect(distances).toEqual(['about 1 km', 'about 11 km']);

        fireEvent.click(within(list).getAllByTestId('visitor-card')[1]);
        expect(await screen.findByTestId('visitor-detail-distance')).toHaveTextContent('About 11 km away · area only');
    });

    it('hides every write affordance: no new post, deals, pricing, Beans-only, RSVP, vote or message', async () => {
        stubNode(GLOBAL);
        await openLobby();
        await screen.findByTestId('visitor-list');
        for (const name of [/ADD POST/, /My Deals/, /Pricing Guide/, /Beans only/, /New members/, /^Going/, /^Interested/, /Message/, /Accept/]) {
            expect(screen.queryByRole('button', { name })).toBeNull();
        }

        // The Map: no New Post button either.
        fireEvent.click(within(screen.getByTestId('lobby-bottom-nav')).getByRole('button', { name: /Map/ }));
        await waitFor(() => expect(markers.length).toBeGreaterThan(0));
        expect(screen.queryByRole('button', { name: 'New Post' })).toBeNull();
    });

    it("the detail sheet: photos, words, category, and one action, Join to see who's offering, which opens screen 1", async () => {
        stubNode(GLOBAL);
        await openLobby();
        fireEvent.click(within(await screen.findByTestId('visitor-list')).getAllByTestId('visitor-card')[0]);

        const sheet = await screen.findByTestId('visitor-detail');
        expect(within(sheet).getAllByRole('img')).toHaveLength(2);
        expect(sheet).toHaveTextContent('Fresh on Saturdays. Happy to swap for eggs.');
        expect(sheet).toHaveTextContent('Food & Produce');
        expect(within(sheet).getByTestId('visitor-detail-terms')).toHaveTextContent('In return: Free, a swap, or ask');
        expect(sheet).not.toHaveTextContent(/Posted by|hidden|Anonymous|No ratings/);
        // Back, and Join: nothing else to press.
        expect(within(sheet).getAllByRole('button').map(b => b.textContent)).toEqual(['← Back to Market', "Join to see who's offering"]);

        fireEvent.click(within(sheet).getByTestId('visitor-join'));
        const overlay = await screen.findByTestId('lobby-join-overlay');
        expect(await within(overlay).findByTestId('join-screen-guard')).toHaveTextContent('Have you used BeanPool before?');
    });

    it("an event's sheet: its time, and its place held back until joining", async () => {
        stubNode(GLOBAL);
        await openLobby();
        fireEvent.click(within(within(await screen.findByTestId('visitor-list')).getByTestId('event-card')).getByRole('button', { name: /Open event/ }));
        const when = await screen.findByTestId('visitor-detail-when');
        expect(when).toHaveTextContent('Place shown after you join');
        expect(within(screen.getByTestId('visitor-detail')).getAllByRole('button').map(b => b.textContent))
            .toEqual(['← Back to Market', "Join to see who's hosting"]);
    });

    it('the map: pins where the node puts them, and a pin card of the title and "near here", to the detail sheet', async () => {
        stubNode(GLOBAL);
        await openLobby();
        fireEvent.click(within(screen.getByTestId('lobby-bottom-nav')).getByRole('button', { name: /Map/ }));
        await waitFor(() => expect(markers.some(m => m.coords[0] === -28.55 && m.coords[1] === 153.55)).toBe(true));
        const pin = markers.find(m => m.coords[0] === -28.55 && m.coords[1] === 153.55 && !String((m as any).opts?.title ?? '').startsWith('Event'))!;
        act(() => { pin.listeners.click(); });

        const card = await screen.findByTestId('map-preview-card');
        expect(within(card).getByTestId('map-preview-title')).toHaveTextContent('Sourdough loaves');
        expect(within(card).getByTestId('map-preview-near')).toHaveTextContent('near here');
        expect(card).not.toHaveTextContent(/0B|Elder|hidden|Anonymous/);
        fireEvent.click(within(card).getByRole('button', { name: 'View Details' }));
        expect(await screen.findByTestId('visitor-detail')).toHaveTextContent('Sourdough loaves');
    });

    it('never calls a member-only route, and never signs a request: it has no key', async () => {
        saveRadiusSettings({ lat: -28.55, lng: 153.55, radiusKm: 50, label: 'Home' });
        const calls = stubNode(GLOBAL);
        await openLobby();
        fireEvent.click(within(await screen.findByTestId('visitor-list')).getAllByTestId('visitor-card')[0]);
        await screen.findByTestId('visitor-detail');
        fireEvent.click(within(screen.getByTestId('lobby-bottom-nav')).getByRole('button', { name: /Map/ }));
        await waitFor(() => expect(markers.length).toBeGreaterThan(0));
        act(() => { markers[0].listeners.click(); });
        await screen.findByTestId('map-preview-card');
        fireEvent.click(within(screen.getByTestId('lobby-bottom-nav')).getByRole('button', { name: /Market/ }));
        await screen.findByTestId('visitor-list');
        // Give any late effect its turn.
        await act(async () => { await new Promise(r => setTimeout(r, 50)); });

        expect(calls.length).toBeGreaterThan(0);
        const refused = calls.filter(c => !visitorMayRead(c.path)).map(c => c.path);
        expect(refused).toEqual([]);
        expect(calls.filter(c => c.headers['X-Public-Key'])).toEqual([]);
        // /api/community/info once, shared by the lobby's decision and everything after it.
        expect(calls.filter(c => c.path === '/api/community/info')).toHaveLength(1);
    });

    it('Join in the header opens screen 1 over the lobby, and ← Back returns to the listings', async () => {
        stubNode(GLOBAL);
        await openLobby();
        const join = screen.getAllByTestId('header-join')[0];
        await waitFor(() => expect(join).not.toBeDisabled());
        fireEvent.click(join);
        const overlay = await screen.findByTestId('lobby-join-overlay');
        await within(overlay).findByTestId('join-screen-guard');
        // The lobby is screen 0: the door's own lobby screen is not shown on the way.
        expect(within(overlay).queryByTestId('join-screen-lobby')).toBeNull();

        fireEvent.click(within(overlay).getByRole('button', { name: '← Back' }));
        await waitFor(() => expect(screen.queryByTestId('lobby-join-overlay')).toBeNull());
        expect(screen.getByTestId('visitor-list')).toBeInTheDocument();
    });

    it('"Already have BeanPool?" opens the ways back (G11-d), and ← Back returns to the listings', async () => {
        stubNode(GLOBAL);
        await openLobby();
        fireEvent.click(await screen.findByTestId('lobby-have-account'));
        const overlay = await screen.findByTestId('lobby-join-overlay');
        const restore = await within(overlay).findByTestId('join-screen-restore');
        expect(within(restore).getByTestId('join-restore-signin')).toHaveTextContent('Use my sign-in');
        fireEvent.click(within(overlay).getByRole('button', { name: '← Back' }));
        await waitFor(() => expect(screen.queryByTestId('lobby-join-overlay')).toBeNull());
    });

    it('a member of the global node restores with 12 words from Join: the page re-renders as a member, and the socket reopens signed', async () => {
        const member: BeanPoolIdentity = await generateIdentity('Rowan');
        stubNode(GLOBAL, new Map([[member.publicKey, 'Rowan']]));
        await openLobby();
        const join = screen.getAllByTestId('header-join')[0];
        await waitFor(() => expect(join).not.toBeDisabled());
        fireEvent.click(join);
        const overlay = await screen.findByTestId('lobby-join-overlay');
        fireEvent.click(await within(overlay).findByRole('button', { name: 'I have my 12 words' }));
        const words = member.mnemonic!;
        for (let i = 0; i < 12; i++) fireEvent.change(await within(overlay).findByLabelText(`Recovery word ${i + 1}`), { target: { value: words[i] } });
        fireEvent.click(within(overlay).getByRole('button', { name: 'Recover Identity' }));

        await waitFor(() => expect(screen.queryByTestId('guest-lobby')).toBeNull());
        expect(await screen.findByTestId('mobile-bottom-nav')).toBeInTheDocument();
        expect((await loadIdentity())?.publicKey).toBe(member.publicKey);
        expect(sync.reconnectToAnchor).toHaveBeenCalledTimes(1);
    });

    it("a browser too old to hold a key: the Join card says so, and Join opens the door's own screen that says it too", async () => {
        const subtle = globalThis.crypto.subtle;
        vi.spyOn(subtle, 'generateKey').mockRejectedValue(new Error('Ed25519 not supported'));
        stubNode(GLOBAL);
        await openLobby();
        expect(await screen.findByTestId('lobby-too-old')).toHaveTextContent('This browser is too old to hold a BeanPool account.');
        expect(screen.queryByTestId('lobby-join')).toBeNull();
        fireEvent.click(screen.getAllByTestId('header-join')[0]);
        const overlay = await screen.findByTestId('lobby-join-overlay');
        expect(await within(overlay).findByTestId('join-too-old')).toBeInTheDocument();
    });
});

describe('where the lobby does not show', () => {
    it('a local node (the switch off): the welcome page, as today', async () => {
        const calls = stubNode(LOCAL);
        render(<App />);
        await screen.findByText(/Join with Invite Code/);
        expect(screen.queryByTestId('guest-lobby')).toBeNull();
        // Nothing of the Market is read for a visitor there.
        expect(calls.some(c => c.path === '/api/marketplace/posts')).toBe(false);
    });

    it('a node that cannot be asked: the welcome page, which says so', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        render(<App />);
        expect(await screen.findByTestId('door-unreachable')).toBeInTheDocument();
        expect(screen.queryByTestId('guest-lobby')).toBeNull();
    });

    it('a join part way through in this browser: the welcome page settles it first, as always', async () => {
        const pending = await generateIdentity('Alice');
        const t0 = Date.now();
        await savePendingJoin({ identity: pending, provider: 'google', nonce: null, startedAt: t0, expiresAt: t0 + PENDING_JOIN_TTL_MS, restored: false, sentAt: t0 });
        stubNode(GLOBAL, new Map([[pending.publicKey, 'Alice']]));
        render(<App />);
        // The node has it as a member: the steps after a join follow, not the lobby.
        expect(await screen.findByText(/Choose your look/)).toBeInTheDocument();
        expect(screen.queryByTestId('guest-lobby')).toBeNull();
    });

    it('an invite in the address: the welcome page', async () => {
        window.history.replaceState(null, '', '/app?invite=BP-7K3X-9M2W');
        stubNode(GLOBAL);
        render(<App />);
        await screen.findByTestId('join-screen-lobby');
        expect(screen.queryByTestId('guest-lobby')).toBeNull();
    });
});
