/**
 * The enterprise page on the web is its shopfront, and its keepers' controls are a Manage tab (slice S8 of
 * scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6; Marty's answers of 23 Oct 2026). The page shows
 * what the phone's shows (S5, apps/native/app/treasury-detail.tsx) in the same order from the same fields: the banner, the
 * logo, the name, its kind and since, what it is for, its keepers with their badges (recognition, gating nothing), a
 * project's goal, About, Featured, what its keepers do together, its sections, How we deal, Message the lead keeper, the
 * money in one line with Money and backing, the discussion, Report. A visitor's page ends after How we deal.
 *
 * Manage (the phone's S7 console): only for its keepers, and a node admin whose keeper requests they are. Every keeper
 * action the page had moves there and none stays on the page; the face (any keeper: About, logo, kind, how we deal; the
 * lead: name and purpose, the others told why) with one Save, through PUT /api/treasury/:t/profile and /shop, the node's
 * refusals in its own words; Featured, up to six of its live Offers in its shop.
 *
 * The node is a fake behind fetch, answering the routes in the shapes test-enterprise-shopfront.ts pins, so the page's real
 * api.ts calls are what is measured. Rendered at 320 px.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
import axe from 'axe-core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import * as identityLib from '../lib/identity';
import * as photoResize from '../lib/photo-resize';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const secret = ed25519.utils.randomSecretKey();
const ME = toHex(ed25519.getPublicKey(secret));
const me = { publicKey: ME, privateKey: toHex(secret), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as any;
const KOFI = '2'.repeat(64);
const MIA = '3'.repeat(64);
const ZOE = '4'.repeat(64);
const ENT = '9'.repeat(64);

const NAME = 'Hill Bakery';
const PURPOSE = 'Bread for the whole valley';
const ABOUT = 'We bake on Saturdays in the old hall.';
const HOW = 'Pick up at the hall on Saturday mornings.';
const SHOP_ID = 'shop-1';
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const b64 = (s: string) => btoa(s);
const SHOP = { id: SHOP_ID, kind: 'baking', counts: { things: 2 }, name: NAME, ownerPublicKey: ENT, ownerName: NAME, enterprise: true, blurb: null, howToDeal: HOW, paused: false, backOn: null, openedAt: iso(now - 30 * DAY) };

/** The enterprise as its lead keeper reads it (GET /api/treasury/:t, E2 + S5's fields): a request and a change waiting, a bid, two deals. */
function leadsView(over: Record<string, unknown> = {}) {
    return {
        publicKey: ENT, name: NAME, purpose: PURPOSE, about: ABOUT, since: '2026-09-03T10:00:00.000Z', offerCategories: ['baking', 'tools'],
        avatar: null, lifecycle: 'ongoing', status: 'active', paused: false,
        balance: 40, creditLine: 100, liveOffers: 2, earnedSurplus: 7, workingCapitalCeiling: 400,
        isLeadOrSoleKeeperOrAdmin: true, availableToBack: 40, shop: SHOP, lat: null, lng: null,
        keepers: [
            { publicKey: ME, callsign: 'Ana', role: 'lead', avatarUrl: null, tier: 'Resident', rating: { average: 4.6, count: 9 }, trades: 14, offerCategories: ['baking'] },
            { publicKey: KOFI, callsign: 'Kofi', role: 'keeper', backing: 20, tier: 'Newcomer', rating: { average: 0, count: 0 }, trades: 2, offerCategories: ['tools'] },
            { publicKey: MIA, callsign: 'Mia', role: 'keeper', tier: 'Newcomer', rating: { average: 0, count: 0 }, trades: 0, offerCategories: [] },
        ],
        keeperRequests: [{ id: 'r1', memberPubkey: '5'.repeat(64), callsign: 'Ivo', pledgedBacking: 15, canBackPledge: true }],
        keeperChanges: [{ id: 'c1', kind: 'add', memberPubkey: ZOE, memberCallsign: 'Zoe', proposedBy: KOFI, proposedByCallsign: 'Kofi', pledgedBacking: 10, appliesAt: iso(now + 2 * DAY) }],
        deferredClaims: [],
        posts: [{ id: 'p1', type: 'offer', category: 'baking', title: 'Sourdough loaf', credits: 4, price_type: 'fixed', status: 'active' }],
        flow: [],
        pendingBids: [{ id: 'b1', post_title: 'Oven repair', peer_callsign: 'Ivo', credits: 30 }],
        activeDeals: [
            { id: 'x1', post_id: 'p1', post_title: 'Sourdough loaf', peer_callsign: 'Zoe', credits: 4, action_required: 'fulfill' },
            { id: 'x2', post_id: 'p2', post_title: 'Oven repair', peer_callsign: 'Mia', credits: 30, action_required: 'pay', price_type: 'fixed' },
        ],
        pledges: [],
        leadInactivity: null,
        succession: { proposals: [] },
        ...over,
    };
}
/** A member who keeps none of it. */
function membersView(over: Record<string, unknown> = {}) {
    return leadsView({
        isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [], pendingBids: [], activeDeals: [],
        keepers: [
            { publicKey: KOFI, callsign: 'Kofi', role: 'lead', backing: 20, tier: 'Resident', rating: { average: 4.6, count: 9 }, trades: 14, offerCategories: ['baking'] },
            { publicKey: MIA, callsign: 'Mia', role: 'keeper', tier: 'Newcomer', rating: { average: 0, count: 0 }, trades: 2, offerCategories: [] },
        ],
        ...over,
    });
}
/** A visitor's read of a node with the shopfront: about and since, no badges, no categories, the shop's kind only. */
function visitorsView() {
    const { offerCategories: _gone, ...rest } = membersView({
        keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }, { publicKey: MIA, callsign: 'Mia', role: 'keeper' }],
        shop: { id: SHOP_ID, kind: 'baking', counts: { things: 2 } }, posts: [],
    });
    return rest;
}
/** A project whose leader has gone quiet, as one of its other collaborators reads it. */
function quietProject(over: Record<string, unknown> = {}) {
    return leadsView({
        lifecycle: 'bounded', status: 'active', isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [], goalAmount: 500, currentAmount: 120,
        keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }, { publicKey: ME, callsign: 'Ana', role: 'keeper' }, { publicKey: ZOE, callsign: 'Zoe', role: 'keeper' }],
        leadInactivity: { isEligible: true, leadPubkey: KOFI, leadCallsign: 'Kofi', daysInactive: 34 },
        succession: { proposals: [] },
        ...over,
    });
}
const PROPOSAL = { id: 's1', status: 'active', candidatePubkey: ZOE, candidateCallsign: 'Zoe', votesCount: 1, noVotesCount: 0, requiredVotes: 2, totalEligible: 3, deadlineAt: iso(now + 13 * DAY), votes: [] };
const THREAD = [{ id: 'm1', type: 'text', ciphertext: b64('see you at the stall'), authorCallsign: 'Kofi', authorPubkey: KOFI, timestamp: iso(now - DAY) }];
const DECISIONS = { decisions: [], canPropose: true, rollSize: 3 };
/** What `author=` answers a keeper: three of its Offers in its shop (one featured), one not in it yet, one Need. */
const OFFERS = [
    { id: 'p1', type: 'offer', category: 'baking', title: 'Sourdough loaf', credits: 4, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: iso(now - DAY), shopId: SHOP_ID, photos: ['/api/marketplace/posts/p1/photos/0'] },
    { id: 'p3', type: 'offer', category: 'baking', title: 'Rye loaf', credits: 5, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: null, shopId: SHOP_ID },
    { id: 'p4', type: 'offer', category: 'baking', title: 'Seed bread', credits: 6, priceType: 'hourly', status: 'pending', audienceScope: 'public', featuredAt: null, shopId: SHOP_ID },
    { id: 'p5', type: 'offer', category: 'baking', title: 'Fruit buns', credits: 3, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: null, shopId: null },
    { id: 'n1', type: 'need', category: 'tools', title: 'A new oven door', credits: 30, priceType: 'fixed', status: 'active', audienceScope: 'public', shopId: null },
];

type Answer = { status: number; body?: unknown } | 'down';
type Writer = (method: string, path: string, body: any) => Answer;
interface NodeOpts { detail?: unknown; keeperOf?: string[]; offers?: unknown; write?: Writer }

/** The node takes every change and answers it as its routes do. */
const okWrites: Writer = (_method, path, body) => {
    if (path === `/api/treasury/${ENT}/profile`) return { status: 200, body: { success: true, publicKey: ENT, name: NAME, purpose: PURPOSE, about: ABOUT, ...body } };
    if (path === `/api/treasury/${ENT}/shop`) return { status: 200, body: { success: true, shop: { ...SHOP, ...body }, paused: [], resumed: [] } };
    if (path === `/api/treasury/${ENT}/shop/offers`) return { status: 200, body: { success: true, added: body.postIds } };
    if (/^\/api\/marketplace\/posts\/[^/]+\/feature$/.test(path)) return { status: 200, body: { success: true, postId: path.split('/')[4], featuredAt: body.featured ? iso(now) : null } };
    return { status: 500, body: { error: `unexpected ${path}` } };
};

let fetchMock: ReturnType<typeof vi.fn>;
let node: NodeOpts = {};
const writes = () => fetchMock.mock.calls
    .filter(([, init]) => init?.method && init.method !== 'GET')
    .map(([url, init]) => ({ method: init.method, path: new URL(String(url), 'http://node').pathname, body: init.body ? JSON.parse(String(init.body)) : undefined }))
    .filter((w) => !w.path.endsWith('/thread'));
const reads = () => fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === 'GET').map(([url]) => {
    const u = new URL(String(url), 'http://node');
    return u.pathname + u.search;
});

function answer(a: Answer) {
    if (a === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, statusText: 'x', json: async () => a.body ?? {} } as any);
}

beforeEach(() => {
    vi.restoreAllMocks();
    node = {};
    vi.spyOn(identityLib, 'loadIdentity').mockResolvedValue(me);
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
        const u = new URL(String(url), 'http://node');
        const path = u.pathname;
        const method = init?.method ?? 'GET';
        if (method !== 'GET') {
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            if (path.endsWith('/thread')) return answer({ status: 200, body: { success: true } });
            return answer((node.write ?? okWrites)(method, path, body));
        }
        if (path === `/api/treasury/${ENT}`) return answer({ status: 200, body: node.detail ?? leadsView() });
        if (path === `/api/ledger/balance/${ME}`) return answer({ status: 200, body: { balance: 10, keeperOf: node.keeperOf ?? [ENT] } });
        if (path === `/api/enterprise/${ENT}/ledger`) return answer({ status: 200, body: { summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 40, endingBalance: 40, transactionCount: 0 }, entries: [] } });
        if (path === `/api/treasury/${ENT}/thread`) return answer({ status: 200, body: { conversation: null, messages: THREAD, readOnly: false } });
        if (path === `/api/enterprise/${ENT}/decisions`) return answer({ status: 200, body: DECISIONS });
        if (path === '/api/marketplace/posts' && u.searchParams.get('author') === ENT) {
            if (node.offers === 'down') return answer('down');
            return answer({ status: 200, body: node.offers ?? OFFERS });
        }
        return answer({ status: 404, body: { error: 'Not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    document.documentElement.style.fontSize = '130%';
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.style.fontSize = '';
});

async function open(opts: NodeOpts = {}, props: Record<string, unknown> = {}) {
    node = opts;
    const onMessage = vi.fn();
    const onOpenProfile = vi.fn();
    const view = render(<TreasuryDetailPage identity={me} pubkey={ENT} onBack={vi.fn()} onMessage={onMessage} onOpenProfile={onOpenProfile} {...props} />);
    await screen.findByTestId('shopfront-name');
    return { ...view, onMessage, onOpenProfile };
}
const byId = (id: string) => screen.queryByTestId(id);
const before = (a: Element | null, b: Element | null, what: string) => {
    expect(a, what).not.toBeNull();
    expect(b, what).not.toBeNull();
    expect(!!(a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING), what).toBe(true);
};
async function manage() {
    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    return screen.findByTestId('manage-panel');
}
async function axeProblems(root: HTMLElement): Promise<string[]> {
    // jsdom computes no colours: contrast is the central tokens' and dark-class-check's.
    const result = await axe.run(root, { rules: { 'color-contrast': { enabled: false } } });
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe("the enterprise page is its shopfront (a member's read)", () => {
    it("draws round 3 §3's order: banner, logo, name, kind and since, what it is for, keepers, About, Featured, together, sections, How we deal, Message, money, discussion, Report", async () => {
        await open({ detail: membersView(), keeperOf: [] });
        await screen.findByTestId('shopfront-featured');
        expect(byId('shopfront-name')?.textContent).toBe(NAME);
        expect(byId('shopfront-name')?.tagName).toBe('H1');
        expect(byId('shopfront-line-0')?.textContent).toBe('🍞 Cooked food and baking · since Sep 2026');
        const order = ['shopfront-banner', 'shopfront-logo', 'shopfront-name', 'shopfront-line-0', 'shopfront-purpose', 'shopfront-keepers', 'shopfront-about',
            'shopfront-featured', 'shopfront-together', 'shopfront-sections', 'shopfront-how', 'shopfront-message', 'shopfront-money', 'enterprise-thread', 'enterprise-report'];
        for (let i = 1; i < order.length; i++) before(byId(order[i - 1]), byId(order[i]), `${order[i - 1]} before ${order[i]}`);
        expect(byId('shopfront-purpose')?.textContent).toContain(PURPOSE);
        expect(byId('shopfront-about')?.textContent).toContain(ABOUT);
        expect(byId('shopfront-how')?.textContent).toContain(HOW);
    });

    it("each keeper is a row with their badges, said once to gate nothing; a tap opens their own profile", async () => {
        const { onOpenProfile } = await open({ detail: membersView(), keeperOf: [] });
        const keepers = byId('shopfront-keepers')!;
        expect(within(keepers).getByRole('heading', { name: 'Kept by' })).toBeInTheDocument();
        expect(byId(`shopfront-badges-${KOFI}`)?.textContent).toBe('🏠 Resident · ★★★★★ · 14 trades');
        expect(byId(`shopfront-badges-${MIA}`)?.textContent).toBe('🌱 Newcomer · 2 trades');
        expect(byId('shopfront-badges-note')?.textContent).toBe('Badges show what each person has done here. They gate nothing.');
        expect(byId(`shopfront-keeper-${KOFI}`)?.textContent).toContain('Kofi · Lead keeper');
        expect(byId(`shopfront-keeper-${MIA}`)?.textContent).toContain('Mia · Keeper');
        // The lead first, and a 48px target.
        before(byId(`shopfront-keeper-${KOFI}`), byId(`shopfront-keeper-${MIA}`), 'the lead first');
        const row = byId(`shopfront-keeper-${KOFI}`)!;
        expect(row.tagName).toBe('BUTTON');
        expect(row.className).toContain('min-h-[48px]');
        fireEvent.click(row);
        expect(onOpenProfile).toHaveBeenCalledWith(KOFI);
    });

    it('Featured is its live featured Offers as tiles with their photos; the sections list its live listings; a tap opens one', async () => {
        const onNavigatePost = vi.fn();
        await open({ detail: membersView(), keeperOf: [] }, { onNavigatePost });
        const featured = await screen.findByTestId('shopfront-featured');
        expect(within(featured).getByRole('heading', { name: 'Featured' })).toBeInTheDocument();
        expect(byId('shopfront-featured-p1')?.textContent).toContain('Sourdough loaf');
        expect(byId('shopfront-featured-p1')?.textContent).toContain('4 🫘');
        expect(byId('shopfront-featured-p1')?.querySelector('img')?.getAttribute('src')).toBe('/api/marketplace/posts/p1/photos/0?size=thumb');
        expect(byId('shopfront-featured-p3')).toBeNull();
        expect(byId('shopfront-together')?.textContent).toContain('🛠️ Tools');
        expect(byId('shopfront-section-toBuy')?.textContent).toContain('To buy (3)');
        expect(byId('shopfront-section-byTime')?.textContent).toContain('Book a time (1)');
        expect(byId('shopfront-section-lookingFor')?.textContent).toContain('Looking for (1)');
        expect(byId('shopfront-row-p4')?.textContent).toContain('6 🫘 an hour · In a deal');
        fireEvent.click(byId('shopfront-featured-p1')!);
        expect(onNavigatePost).toHaveBeenCalledWith('p1');
        // Its listings with photos were asked once, with author=.
        expect(reads().filter((r) => r.startsWith('/api/marketplace/posts?'))).toEqual([`/api/marketplace/posts?author=${ENT}&limit=200`]);
    });

    it("Message writes to the lead keeper, named; never to themselves", async () => {
        const { onMessage } = await open({ detail: membersView(), keeperOf: [] });
        const message = byId('shopfront-message')!;
        expect(message.textContent).toBe('Message Kofi (lead keeper)');
        fireEvent.click(message);
        expect(onMessage).toHaveBeenCalledWith(KOFI);
        cleanup();
        await open();
        expect(byId('shopfront-message')).toBeNull();
    });

    it('the money is one line; Money and backing opens the figures, the keepers\' backing and the ledger', async () => {
        await open({ detail: membersView(), keeperOf: [] });
        expect(byId('shopfront-money-line')?.textContent).toBe('40 🫘 · credit line 100 🫘');
        expect(byId('enterprise-balance-tiles')).toBeNull();
        const toggle = byId('shopfront-money-toggle')!;
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle.textContent).toBe('Money and backing ›');
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const opened = await screen.findByTestId('shopfront-money-open');
        expect(within(opened).getByTestId('enterprise-balance-tiles')).toBeInTheDocument();
        expect(within(opened).getByTestId('enterprise-backing').textContent).toContain('Kofi · 20 🫘');
        expect(within(opened).getByText('Income & Spend (P&L)')).toBeInTheDocument();
    });

    it("the banner is its shop's photo, drawn across the top; with none, or one that won't load, a quiet block in its kind's emoji", async () => {
        const BANNER = `/api/shops/${SHOP_ID}/photo?v=ab12cd34&k=${'K'.repeat(22)}`;
        await open({ detail: membersView({ shop: { ...SHOP, photoUrl: BANNER } }), keeperOf: [] });
        const photo = within(byId('shopfront-banner')!).getByTestId('shopfront-banner-photo');
        expect(photo.getAttribute('src')).toBe(BANNER);
        expect(photo.className).toContain('object-cover');
        expect(byId('shopfront-banner')?.textContent).toBe('');
        fireEvent.error(photo);
        expect(byId('shopfront-banner-photo')).toBeNull();
        expect(byId('shopfront-banner')?.textContent).toBe('🍞');
        cleanup();
        await open({ detail: membersView(), keeperOf: [] });
        expect(byId('shopfront-banner-photo')).toBeNull();
        expect(byId('shopfront-banner')?.textContent).toBe('🍞');
    });

    it("a project's goal card sits above About", async () => {
        await open({ detail: quietProject({ keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }], isLeadOrSoleKeeperOrAdmin: false }), keeperOf: [] });
        before(screen.getByText('Funding Progress'), byId('shopfront-about'), 'the goal before About');
        before(byId('shopfront-keepers'), screen.getByText('Funding Progress'), 'the keepers before the goal');
        expect(within(byId('shopfront-keepers')!).getByRole('heading', { name: 'Run by' })).toBeInTheDocument();
    });

    it("a visitor's page ends after How we deal, with a sentence; no listings are asked for", async () => {
        await open({ detail: visitorsView(), keeperOf: [] }, { isMember: false });
        // The node sends a visitor its shop's kind and counts only (engine/shops.ts visitorShop): no How we deal to show.
        expect(byId('shopfront-line-0')?.textContent).toBe('🍞 Cooked food and baking · since Sep 2026');
        expect(byId('shopfront-how')).toBeNull();
        before(byId('shopfront-about'), byId('shopfront-visitor'), 'the note where the page ends');
        expect(byId('shopfront-visitor')?.textContent).toBe("Members of this community see what it offers, its keepers' badges and its accounts.");
        for (const gone of ['shopfront-featured', 'shopfront-together', 'shopfront-sections', 'shopfront-message', 'shopfront-money', 'enterprise-thread', `shopfront-badges-${KOFI}`]) {
            expect(byId(gone), gone).toBeNull();
        }
        expect(reads().some((r) => r.startsWith('/api/marketplace/posts'))).toBe(false);
    });

    it('axe finds nothing on the page, at 320 px', async () => {
        const { container } = await open({ detail: membersView(), keeperOf: [] });
        await screen.findByTestId('shopfront-featured');
        fireEvent.click(byId('shopfront-money-toggle')!);
        expect(await axeProblems(container)).toEqual([]);
    });
});

/** Another enterprise opened over this one (a keeper row's profile, a link): App.tsx changes the key, not the page. */
describe('from one enterprise to another', () => {
    const MILL = '8'.repeat(64);
    const millsView = () => membersView({
        publicKey: MILL, name: 'River Mill', shop: { ...SHOP, id: 'shop-2', name: 'River Mill', ownerPublicKey: MILL, ownerName: 'River Mill' },
        posts: [{ id: 'f2', type: 'offer', category: 'baking', title: 'Rye flour', credits: 3, price_type: 'fixed', status: 'active' }],
    });
    const MILLS = [{ id: 'f1', type: 'offer', category: 'baking', title: 'Wholemeal flour', credits: 3, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: iso(now - DAY), shopId: 'shop-2' }];
    /** The node answers for the mill too; a read named in `held` waits until its gate opens. */
    function serveTheMillToo(held: Record<string, Promise<void>>) {
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            const u = new URL(String(url), 'http://node');
            const answered = u.pathname === `/api/treasury/${MILL}` ? answer({ status: 200, body: millsView() })
                : u.pathname === '/api/marketplace/posts' && u.searchParams.get('author') === MILL ? answer({ status: 200, body: MILLS })
                : base(url, init);
            const gate = held[u.pathname + u.search];
            return gate ? gate.then(() => answered) : answered;
        });
    }
    const gate = () => { let open!: () => void; const shut = new Promise<void>((r) => { open = r; }); return { shut, open }; };
    const toTheMill = (rerender: (ui: React.ReactElement) => void) => rerender(<TreasuryDetailPage identity={me} pubkey={MILL} onBack={vi.fn()} />);
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    it("the one before's listings never show under the next one's name while its own are read", async () => {
        const mills = gate();
        serveTheMillToo({ [`/api/marketplace/posts?author=${MILL}&limit=200`]: mills.shut });
        const { rerender } = await open({ detail: membersView(), keeperOf: [] });
        await screen.findByTestId('shopfront-featured-p1');
        toTheMill(rerender);
        await waitFor(() => expect(byId('shopfront-name')?.textContent).toBe('River Mill'));
        expect(byId('shopfront-featured-p1')).toBeNull();
        expect(byId('shopfront-row-p3')).toBeNull();
        // Its own text listings stand in meanwhile.
        expect(byId('shopfront-row-f2')).not.toBeNull();
        await act(async () => { mills.open(); });
        expect(await screen.findByTestId('shopfront-featured-f1')).toBeInTheDocument();
        expect(byId('shopfront-featured-p1')).toBeNull();
    });

    it("the one before's listings, read late, are dropped", async () => {
        const bakery = gate();
        serveTheMillToo({ [`/api/marketplace/posts?author=${ENT}&limit=200`]: bakery.shut });
        const { rerender } = await open({ detail: membersView(), keeperOf: [] });
        await waitFor(() => expect(reads()).toContain(`/api/marketplace/posts?author=${ENT}&limit=200`));
        toTheMill(rerender);
        await screen.findByTestId('shopfront-featured-f1');
        bakery.open();
        await settle();
        expect(byId('shopfront-name')?.textContent).toBe('River Mill');
        expect(byId('shopfront-featured-f1')).not.toBeNull();
        expect(byId('shopfront-featured-p1')).toBeNull();
        expect(byId('shopfront-row-p3')).toBeNull();
    });

    it('the one before, read late, never takes the page', async () => {
        const bakery = gate();
        serveTheMillToo({ [`/api/treasury/${ENT}`]: bakery.shut });
        node = { detail: membersView(), keeperOf: [] };
        const { rerender } = render(<TreasuryDetailPage identity={me} pubkey={ENT} onBack={vi.fn()} />);
        await waitFor(() => expect(reads()).toContain(`/api/treasury/${ENT}`));
        toTheMill(rerender);
        await screen.findByTestId('shopfront-featured-f1');
        bakery.open();
        await settle();
        expect(byId('shopfront-name')?.textContent).toBe('River Mill');
        expect(byId('shopfront-featured-f1')).not.toBeNull();
        expect(byId('shopfront-featured-p1')).toBeNull();
        expect(reads()).not.toContain(`/api/marketplace/posts?author=${ENT}&limit=200`);
    });

    it("a Featured change for the one before, answered late, stays off the next one's page", async () => {
        const feature = gate();
        serveTheMillToo({ '/api/marketplace/posts/p3/feature': feature.shut });
        const { rerender } = await open();
        const panel = await manage();
        await within(panel).findByTestId('manage-featured');
        fireEvent.click(byId('manage-feature-p3')!);
        await waitFor(() => expect(writes()).toEqual([{ method: 'PUT', path: '/api/marketplace/posts/p3/feature', body: { featured: true } }]));
        toTheMill(rerender);
        await screen.findByTestId('shopfront-featured-f1');
        feature.open();
        await settle();
        expect(byId('shopfront-name')?.textContent).toBe('River Mill');
        expect(byId('shopfront-featured-f1')).not.toBeNull();
        expect(byId('shopfront-featured-p1')).toBeNull();
        expect(byId('shopfront-featured-p3')).toBeNull();
    });
});

/**
 * Every keeper action the web page had before the console (TreasuryDetailPage.tsx at f6104d01), each with the view of the
 * enterprise it shows for and how a member finds it: its spoken name, or its words on a button.
 */
type View = 'lead' | 'paused' | 'windingUp' | 'quietProject' | 'quietProjectVote';
const ACTIONS: Array<{ what: string; view: View; label?: string; button?: string; testID?: string }> = [
    { what: "approve a member's request to keep it", view: 'lead', label: 'Approve Ivo as a keeper' },
    { what: "decline a member's request to keep it", view: 'lead', label: 'Decline Ivo as a keeper' },
    { what: 'object to a keeper change', view: 'lead', label: 'Object: Adding Zoe as a keeper, backing 10 beans' },
    { what: 'remove a keeper', view: 'lead', button: 'Remove Kofi' },
    { what: 'step down', view: 'lead', button: 'Step down as a keeper' },
    { what: 'post its Offer', view: 'lead', button: '🏷️ Post Offer' },
    { what: 'post its Need', view: 'lead', button: '🤝 Post Need' },
    { what: 'sweep its surplus to the Commons', view: 'lead', button: 'To Commons 🌱' },
    { what: 'set its map pin', view: 'lead', testID: 'enterprise-map-pin-control' },
    { what: 'approve a bid on its Need', view: 'lead', button: 'Approve Bid (30 🫘)' },
    { what: 'decline a bid on its Need', view: 'lead', label: 'Decline the bid on Oven repair' },
    { what: 'open a deal it is fulfilling', view: 'lead', button: 'Fulfill Deal · Awaiting Customer Release' },
    { what: 'release the payment of a deal', view: 'lead', button: 'Release Payment (30 🫘)' },
    { what: 'propose a vote among the keepers', view: 'lead', testID: 'enterprise-decisions' },
    { what: 'remove a message from its discussion', view: 'lead', label: 'Remove message from Kofi' },
    { what: 'pause for the season', view: 'lead', button: '❄️ Pause for Season' },
    { what: 'start the wind-up', view: 'lead', button: '⚠️ Start Wind-Up' },
    { what: 'resume after a pause', view: 'paused', button: '▶️ Resume Enterprise' },
    { what: 'stop the wind-up', view: 'windingUp', button: '🛑 Stop Wind-Up' },
    { what: 'finalise the wind-up', view: 'windingUp', button: '🏁 Finalise Wind-Up' },
    { what: 'propose a new leader while the leader is quiet', view: 'quietProject', button: 'Propose Leader' },
    { what: 'cancel an initiative and refund its backers', view: 'quietProject', button: '🛑Cancel Initiative & Refund Escrow' },
    { what: 'vote yes on a new leader', view: 'quietProjectVote', label: 'Yes, make Zoe leader' },
    { what: 'vote no on a new leader', view: 'quietProjectVote', label: 'No, do not make Zoe leader' },
];
const VIEWS: Record<View, () => Record<string, unknown>> = {
    lead: () => leadsView(),
    paused: () => leadsView({ paused: true, pausedAt: iso(now - 5 * DAY) }),
    windingUp: () => leadsView({ status: 'winding_up', windUpInitiatedBy: KOFI, windUpInitiatedAt: iso(now - 8 * DAY), windUpGraceEndsAt: iso(now - 3600_000) }),
    quietProject: () => quietProject(),
    quietProjectVote: () => quietProject({ succession: { proposals: [PROPOSAL] } }),
};
const found = (a: (typeof ACTIONS)[number], root: HTMLElement = document.body) => {
    if (a.testID) return root.querySelector(`[data-testid="${a.testID}"]`);
    if (a.label) return root.querySelector(`[aria-label="${a.label}"]`);
    return Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === a.button!.replace(/\s+/g, ' ')) ?? null;
};

describe("the keepers' Manage tab", () => {
    it('a keeper reads the tabs, the page first; a member who keeps none of it reads none; a node admin who keeps none does', async () => {
        await open();
        const tabs = screen.getByRole('tablist');
        expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Page', 'Manage']);
        expect(screen.getByRole('tab', { name: 'Page' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Manage' }).className).toContain('min-h-[44px]');
        cleanup();

        await open({ detail: membersView(), keeperOf: [] });
        expect(screen.queryByRole('tablist')).toBeNull();
        expect(screen.queryByRole('tab', { name: 'Manage' })).toBeNull();
        cleanup();

        await open({ detail: membersView({ isLeadOrSoleKeeperOrAdmin: true }), keeperOf: [] });
        expect(screen.getByRole('tab', { name: 'Manage' })).toBeInTheDocument();
    });

    it('the page keeps no keeper control, in every state a keeper had one', async () => {
        for (const view of Object.keys(VIEWS) as View[]) {
            await open({ detail: VIEWS[view]() });
            await screen.findByTestId('enterprise-thread');
            await waitFor(() => expect(screen.getByText('see you at the stall')).toBeInTheDocument());
            for (const a of ACTIONS.filter((x) => x.view === view)) expect(found(a), `${a.what}, on the page (${view})`).toBeNull();
            for (const words of ['Operator Controls', 'Season & Lifecycle Controls', 'Keeper changes waiting', 'Pending Bids on Needs', 'Active Deals', 'Asking to join as keepers']) {
                expect(document.body.textContent, `${words} (${view})`).not.toContain(words);
            }
            cleanup();
        }
    });

    it('every keeper action of today is in Manage, in the state it had it', async () => {
        for (const view of Object.keys(VIEWS) as View[]) {
            await open({ detail: VIEWS[view]() });
            const panel = await manage();
            if (view === 'lead') await within(panel).findByTestId('enterprise-decisions');
            await waitFor(() => {
                for (const a of ACTIONS.filter((x) => x.view === view)) expect(found(a, panel), `${a.what}, in Manage (${view})`).not.toBeNull();
            });
            cleanup();
        }
    });

    it('a member who keeps none of it still sees the discussion, Report and the money; what every member does stays on the page', async () => {
        await open({ detail: membersView(), keeperOf: [] });
        expect(byId('enterprise-thread')).not.toBeNull();
        expect(screen.getByRole('button', { name: /Report Enterprise/ })).toBeInTheDocument();
        expect(byId('shopfront-money-line')).not.toBeNull();
        expect(screen.getByText('Request to join as a keeper')).toBeInTheDocument();
    });

    it('axe finds nothing in Manage, at 320 px', async () => {
        const { container } = await open();
        const panel = await manage();
        await within(panel).findByTestId('manage-featured');
        expect(await axeProblems(container)).toEqual([]);
    });

    it("an action that ends the reader's Manage says so at the top of the page they are left on", async () => {
        const wordsOnTop = async (words: string) => {
            expect(await screen.findByText(words)).toBeInTheDocument();
            // The words can be drawn a render before the read that takes Manage away lands: wait for that too.
            await waitFor(() => {
                expect(byId('manage-panel')).toBeNull();
                expect(screen.queryByRole('tab', { name: 'Manage' })).toBeNull();
            });
            before(screen.getByText(words), byId('shopfront-name'), `"${words}", then the page`);
        };

        // Stepping down is at once ("You stop being a keeper"): the read after it lists them no more.
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        await open({
            write: (method, path, body) => {
                if (path !== `/api/enterprise/${ENT}/keepers/step-down`) return okWrites(method, path, body);
                node.detail = leadsView({ isLeadOrSoleKeeperOrAdmin: false, keepers: (leadsView().keepers as Array<{ publicKey: string }>).filter((k) => k.publicKey !== ME) });
                node.keeperOf = [];
                return { status: 200, body: { success: true, promoted: KOFI, paused: false, releasedBacking: 0 } };
            },
        });
        let panel = await manage();
        let scrollTo = vi.fn();
        (screen.getByTestId('page-overlay') as any).scrollTo = scrollTo;
        fireEvent.click(within(panel).getByRole('button', { name: 'Step down as a keeper' }));
        await wordsOnTop('You have stepped down as a keeper.');
        // Step down sits far down Manage: the page goes back up to the words.
        await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
        cleanup();

        // Finalising a wind-up releases every keeper (the node deletes them all), so it ends the lead's Manage too.
        await open({
            detail: VIEWS.windingUp(),
            write: (method, path, body) => {
                if (path !== `/api/enterprise/${ENT}/wind-up/finalise`) return okWrites(method, path, body);
                node.detail = leadsView({ status: 'completed', windUpFinalisedAt: iso(now), balance: 0, isLeadOrSoleKeeperOrAdmin: false, keepers: [] });
                node.keeperOf = [];
                return { status: 200, body: { success: true, status: 'completed', finalisedAt: iso(now), sweptAmount: 40 } };
            },
        });
        panel = await manage();
        scrollTo = vi.fn();
        (screen.getByTestId('page-overlay') as any).scrollTo = scrollTo;
        fireEvent.click(found(ACTIONS.find((a) => a.what === 'finalise the wind-up')!, panel) as HTMLElement);
        fireEvent.click(within(panel).getByRole('button', { name: 'Finalise Wind-Up' }));
        await wordsOnTop('Wind-up finalised. Swept 40 🫘 to Commons and released keepers.');
        await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
    });

    describe('its face, with one Save', () => {
        it('the lead changes its name and kind: one Save sends each field that changed, to its own route, and says it is saved', async () => {
            await open();
            const panel = await manage();
            const face = within(panel).getByTestId('manage-face');
            expect((within(face).getByTestId('manage-face-name') as HTMLInputElement).value).toBe(NAME);
            expect((within(face).getByTestId('manage-face-purpose') as HTMLTextAreaElement).value).toBe(PURPOSE);
            expect((within(face).getByTestId('manage-face-about') as HTMLTextAreaElement).value).toBe(ABOUT);
            expect((within(face).getByTestId('manage-face-how') as HTMLTextAreaElement).value).toBe(HOW);
            expect((within(face).getByTestId('manage-face-kind') as HTMLSelectElement).value).toBe('baking');
            expect(byId('manage-face-lead-only')).toBeNull();
            expect(byId('manage-face-save')).toBeDisabled();
            fireEvent.change(byId('manage-face-name')!, { target: { value: 'Hill Bakery and Mill' } });
            fireEvent.change(byId('manage-face-kind')!, { target: { value: 'food' } });
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-saved')?.textContent).toBe('Saved.'));
            expect(writes()).toEqual([
                { method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { name: 'Hill Bakery and Mill' } },
                { method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { kind: 'food' } },
            ]);
        });

        it('a new logo goes as the picture the keeper chose, made 800 px, with nothing else', async () => {
            const PICKED = 'data:image/jpeg;base64,/9j/AAAA';
            const resize = vi.spyOn(photoResize, 'resizePhotoFile').mockResolvedValue(PICKED);
            await open();
            const panel = await manage();
            const file = new File(['x'], 'logo.jpg', { type: 'image/jpeg' });
            fireEvent.change(within(panel).getByTestId('manage-face-logo-input'), { target: { files: [file] } });
            await waitFor(() => expect(byId('manage-face-logo-image')?.getAttribute('src')).toBe(PICKED));
            expect(resize).toHaveBeenCalledWith(file);
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-saved')).not.toBeNull());
            expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { avatar: PICKED } }]);
        });

        it('the logo and the banner photo are two pictures, each labelled, each with its own choice', async () => {
            await open();
            const panel = await manage();
            expect(within(panel).getByTestId('manage-face-logo-label').textContent).toBe('Logo');
            expect(within(panel).getByTestId('manage-face-banner-label').textContent).toBe('Banner photo');
            expect(within(panel).getByTestId('manage-face-banner').textContent).toBe('Choose a banner photo');
            expect(within(panel).queryByTestId('manage-face-banner-remove')).toBeNull();
            expect(within(panel).getByTestId('manage-face-banner-input')).toHaveAttribute('accept', 'image/*');
        });

        it('a keeper puts up a banner photo, made 800 px, sent to its shop alone', async () => {
            const PICKED = 'data:image/jpeg;base64,/9j/BBBB';
            const resize = vi.spyOn(photoResize, 'resizePhotoFile').mockResolvedValue(PICKED);
            await open();
            const panel = await manage();
            const file = new File(['x'], 'banner.jpg', { type: 'image/jpeg' });
            fireEvent.change(within(panel).getByTestId('manage-face-banner-input'), { target: { files: [file] } });
            await waitFor(() => expect(byId('manage-face-banner-image')?.getAttribute('src')).toBe(PICKED));
            expect(resize).toHaveBeenCalledWith(file);
            expect(byId('manage-face-banner')?.textContent).toBe('Change the banner photo');
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-saved')).not.toBeNull());
            expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { photo: PICKED } }]);
        });

        it('the banner photo it has shows in Manage; Remove takes it down with one Save, and the page shows the quiet block', async () => {
            const BANNER = `/api/shops/${SHOP_ID}/photo?v=ab12cd34&k=${'K'.repeat(22)}`;
            const opts: NodeOpts = {
                detail: leadsView({ shop: { ...SHOP, photoUrl: BANNER } }),
                write: (method, path, body) => {
                    if (path.endsWith('/shop')) opts.detail = leadsView({ shop: { ...SHOP, photoUrl: null } });
                    return okWrites(method, path, body);
                },
            };
            await open(opts);
            const panel = await manage();
            expect(within(panel).getByTestId('manage-face-banner-image').getAttribute('src')).toBe(BANNER);
            fireEvent.click(within(panel).getByTestId('manage-face-banner-remove'));
            expect(byId('manage-face-banner-image')).toBeNull();
            expect(byId('manage-face-banner-remove')).toBeNull();
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-saved')).not.toBeNull());
            expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { photo: null } }]);
            fireEvent.click(screen.getByRole('tab', { name: 'Page' }));
            await waitFor(() => expect(byId('shopfront-banner')?.textContent).toBe('🍞'));
            expect(byId('shopfront-banner-photo')).toBeNull();
        });

        it('a banner photo that cannot be read says so, and nothing is sent', async () => {
            vi.spyOn(photoResize, 'resizePhotoFile').mockRejectedValue(new Error('bad'));
            await open();
            const panel = await manage();
            fireEvent.change(within(panel).getByTestId('manage-face-banner-input'), { target: { files: [new File(['x'], 'b.heic')] } });
            await waitFor(() => expect(byId('manage-face-error')?.textContent).toBe("That picture couldn't be read. Try another."));
            expect(byId('manage-face-save')).toBeDisabled();
            expect(writes()).toEqual([]);
        });

        it("a keeper who does not lead reads its name and purpose, and why they are the lead's; their About goes alone", async () => {
            await open({ detail: leadsView({ isLeadOrSoleKeeperOrAdmin: false, keepers: [{ publicKey: KOFI, callsign: 'Kofi', role: 'lead' }, { publicKey: ME, callsign: 'Ana', role: 'keeper' }] }) });
            const panel = await manage();
            expect(within(panel).queryByTestId('manage-face-name')).toBeNull();
            expect(within(panel).queryByTestId('manage-face-purpose')).toBeNull();
            expect(byId('manage-face-name-shown')?.textContent).toContain(NAME);
            expect(byId('manage-face-purpose-shown')?.textContent).toContain(PURPOSE);
            expect(byId('manage-face-lead-only')?.textContent).toBe("Only the lead keeper can change the enterprise's name or what it is for.");
            fireEvent.change(byId('manage-face-about')!, { target: { value: 'We bake on Saturdays and Wednesdays.' } });
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-saved')).not.toBeNull());
            expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { about: 'We bake on Saturdays and Wednesdays.' } }]);
        });

        it("a refusal is the node's own sentence; nothing after it is sent", async () => {
            await open({
                write: (method, path, body) => path.endsWith('/profile')
                    ? { status: 409, body: { error: 'That name is already taken here. Pick another.', code: 'name_taken' } }
                    : okWrites(method, path, body),
            });
            await manage();
            fireEvent.change(byId('manage-face-name')!, { target: { value: 'Kofi' } });
            fireEvent.change(byId('manage-face-how')!, { target: { value: 'Saturdays only.' } });
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-error')?.textContent).toBe('That name is already taken here. Pick another.'));
            expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { name: 'Kofi' } }]);
            expect(byId('manage-face-saved')).toBeNull();
        });

        it('no answer from the community says so, and keeps what was typed', async () => {
            await open({ write: () => 'down' });
            await manage();
            fireEvent.change(byId('manage-face-about')!, { target: { value: 'New words.' } });
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-error')?.textContent).toBe("Your community couldn't be reached. Try again."));
            expect((byId('manage-face-about') as HTMLTextAreaElement).value).toBe('New words.');
        });

        it("what is typed in it stays while another Manage action runs and the enterprise is read again", async () => {
            const opts: NodeOpts = {
                write: (method, path, body) => {
                    if (path !== `/api/enterprise/${ENT}/keepers/requests/r1/approve`) return okWrites(method, path, body);
                    opts.detail = leadsView({ keeperRequests: [] });
                    return { status: 200, body: { success: true, backing: 15, applied: false, change: null } };
                },
            };
            // The node takes a moment to answer the read again, as a real one does: the page has a frame to draw meanwhile.
            const base = fetchMock.getMockImplementation()!;
            let detailReads = 0;
            fetchMock.mockImplementation((url: string, init?: RequestInit) => {
                const again = new URL(String(url), 'http://node').pathname === `/api/treasury/${ENT}` && (init?.method ?? 'GET') === 'GET' && detailReads++ > 0;
                return again ? new Promise((r) => setTimeout(r, 30)).then(() => base(url, init)) : base(url, init);
            });
            await open(opts);
            const panel = await manage();
            fireEvent.change(within(panel).getByTestId('manage-face-about'), { target: { value: 'We bake on Saturdays and Wednesdays.' } });
            fireEvent.change(within(panel).getByTestId('manage-face-how'), { target: { value: 'Saturdays only.' } });
            fireEvent.click(within(panel).getByRole('button', { name: 'Approve Ivo as a keeper' }));
            await screen.findByText('Approved. They become a keeper in 3 days, unless another keeper objects first.');
            // Read again: the request it answered has gone.
            await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve Ivo as a keeper' })).toBeNull());
            expect(reads().filter((r) => r === `/api/treasury/${ENT}`)).toHaveLength(2);
            expect((byId('manage-face-about') as HTMLTextAreaElement).value).toBe('We bake on Saturdays and Wednesdays.');
            expect((byId('manage-face-how') as HTMLTextAreaElement).value).toBe('Saturdays only.');
            expect(byId('manage-face-save')).not.toBeDisabled();
        });

        it('a picture saved before its shop change got no answer shows as the node holds it, read again; a retry sends the shop alone', async () => {
            const PICKED = 'data:image/jpeg;base64,/9j/AAAA';
            const HELD = `/api/treasury/${ENT}/avatar?v=2`;
            vi.spyOn(photoResize, 'resizePhotoFile').mockResolvedValue(PICKED);
            let shopTries = 0;
            const opts: NodeOpts = {
                write: (method, path, body) => {
                    if (path.endsWith('/profile')) opts.detail = leadsView({ avatar: HELD });
                    if (path.endsWith('/shop') && shopTries++ === 0) return 'down';
                    return okWrites(method, path, body);
                },
            };
            await open(opts);
            const panel = await manage();
            fireEvent.change(within(panel).getByTestId('manage-face-logo-input'), { target: { files: [new File(['x'], 'logo.jpg', { type: 'image/jpeg' })] } });
            await waitFor(() => expect(byId('manage-face-logo-image')?.getAttribute('src')).toBe(PICKED));
            fireEvent.change(byId('manage-face-how')!, { target: { value: 'Saturdays only.' } });
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-error')?.textContent).toBe("Your community couldn't be reached. Try again."));
            await waitFor(() => expect(byId('manage-face-logo-image')?.getAttribute('src')).toBe(HELD));
            expect(reads().filter((r) => r === `/api/treasury/${ENT}`)).toHaveLength(2);
            expect(byId('manage-face-saved')).toBeNull();
            expect((byId('manage-face-how') as HTMLTextAreaElement).value).toBe('Saturdays only.');
            fireEvent.click(byId('manage-face-save')!);
            await waitFor(() => expect(byId('manage-face-saved')).not.toBeNull());
            expect(writes()).toEqual([
                { method: 'PUT', path: `/api/treasury/${ENT}/profile`, body: { avatar: PICKED } },
                { method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { howToDeal: 'Saturdays only.' } },
                { method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: { howToDeal: 'Saturdays only.' } },
            ]);
        });

        it('About says its limit; a node admin who keeps none of it changes the face but not the shop', async () => {
            await open({ detail: membersView({ isLeadOrSoleKeeperOrAdmin: true }), keeperOf: [] });
            const panel = await manage();
            expect(within(panel).getByTestId('manage-face-about')).toHaveAttribute('maxLength', '600');
            expect(within(panel).getByTestId('manage-face-name')).toBeInTheDocument();
            expect(within(panel).queryByTestId('manage-face-kind')).toBeNull();
            expect(within(panel).queryByTestId('manage-face-how')).toBeNull();
            expect(within(panel).queryByTestId('manage-face-banner')).toBeNull();
            expect(within(panel).queryByTestId('manage-featured')).toBeNull();
        });
    });

    describe('Featured', () => {
        it('its live Offers in its shop, each on or off the shelf; a tap puts one on, through the feature route', async () => {
            await open();
            const panel = await manage();
            const shelf = await within(panel).findByTestId('manage-featured');
            expect(within(shelf).getByTestId('manage-feature-p1')).toBeChecked();
            expect(within(shelf).getByTestId('manage-feature-p3')).not.toBeChecked();
            expect(within(shelf).getByTestId('manage-feature-p4')).toBeInTheDocument();
            expect(within(shelf).queryByTestId('manage-feature-p5')).toBeNull();
            expect(within(shelf).queryByTestId('manage-feature-n1')).toBeNull();
            expect(shelf.textContent).toContain('1 of 6 on the shelf');
            fireEvent.click(within(shelf).getByTestId('manage-feature-p3'));
            await waitFor(() => expect(within(shelf).getByTestId('manage-feature-p3')).toBeChecked());
            expect(writes()).toEqual([{ method: 'PUT', path: '/api/marketplace/posts/p3/feature', body: { featured: true } }]);
            expect(shelf.textContent).toContain('2 of 6 on the shelf');
            // Each is named for a screen reader by its title.
            expect(within(shelf).getByRole('checkbox', { name: 'Rye loaf' })).toBeInTheDocument();
        });

        it('six on the shelf: the rest wait, said once; one comes off with a tap', async () => {
            const seven = Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, type: 'offer', title: `Loaf ${i}`, credits: 4, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: i < 6 ? iso(now - i * 1000) : null, shopId: SHOP_ID }));
            await open({ offers: seven });
            const panel = await manage();
            await within(panel).findByTestId('manage-featured');
            expect(byId('manage-featured-full')?.textContent).toBe('Six is the shelf; un-feature one first.');
            expect(byId('manage-feature-q6')).toBeDisabled();
            fireEvent.click(byId('manage-feature-q0')!);
            await waitFor(() => expect(byId('manage-featured-full')).toBeNull());
            expect(writes()).toEqual([{ method: 'PUT', path: '/api/marketplace/posts/q0/feature', body: { featured: false } }]);
            expect(byId('manage-feature-q6')).not.toBeDisabled();
        });

        it('its live Offers not in its shop yet go in with one tap, so they can be featured', async () => {
            await open();
            const panel = await manage();
            await within(panel).findByTestId('manage-featured');
            expect(byId('manage-shop-outside')?.textContent).toBe("1 of its live Offers isn't in its shop yet, so it can't be featured.");
            fireEvent.click(byId('manage-shop-add')!);
            await waitFor(() => expect(writes()).toEqual([{ method: 'POST', path: `/api/treasury/${ENT}/shop/offers`, body: { postIds: ['p5'] } }]));
        });

        const listingsReads = () => reads().filter((r) => r.startsWith('/api/marketplace/posts?')).length;
        const saveAbout = (panel: HTMLElement) => {
            fireEvent.change(within(panel).getByTestId('manage-face-about'), { target: { value: 'We bake on Sundays now.' } });
            fireEvent.click(within(panel).getByTestId('manage-face-save'));
        };

        it('an Offer posted from Manage shows on the shelf without opening the tab again; a pause takes its Offers off', async () => {
            const HONEY = { id: 'p6', type: 'offer', category: 'food', title: 'Honey cake', credits: 7, priceType: 'fixed', status: 'active', audienceScope: 'public', featuredAt: null, shopId: null };
            await open({
                // The node's next read of its listings answers what each change made.
                write: (method, path, body) => {
                    if (path === `/api/treasury/${ENT}/offer`) {
                        node.offers = [...OFFERS, HONEY];
                        return { status: 200, body: { success: true, post: HONEY } };
                    }
                    if (path === `/api/enterprise/${ENT}/pause`) {
                        node.offers = (node.offers as Array<{ type: string }>).map((o) => (o.type === 'offer' ? { ...o, status: 'paused' } : o));
                        node.detail = leadsView({ paused: true, pausedAt: iso(now) });
                        return { status: 200, body: { success: true, paused: true, pausedAt: iso(now) } };
                    }
                    return okWrites(method, path, body);
                },
            });
            const panel = await manage();
            await within(panel).findByTestId('manage-featured');
            expect(byId('manage-shop-outside')?.textContent).toBe("1 of its live Offers isn't in its shop yet, so it can't be featured.");

            fireEvent.click(found(ACTIONS.find((a) => a.what === 'post its Offer')!, panel) as HTMLElement);
            fireEvent.change(screen.getByPlaceholderText('e.g. Dozen fresh eggs'), { target: { value: 'Honey cake' } });
            fireEvent.change(screen.getByPlaceholderText('20'), { target: { value: '7' } });
            fireEvent.click(screen.getByRole('button', { name: 'Publish Listing' }));
            await waitFor(() => expect(byId('manage-shop-outside')?.textContent).toBe("2 of its live Offers aren't in its shop yet, so they can't be featured."));
            expect(byId('manage-feature-p3')).toBeInTheDocument();

            fireEvent.click(found(ACTIONS.find((a) => a.what === 'pause for the season')!, panel) as HTMLElement);
            fireEvent.click(within(panel).getByRole('button', { name: 'Confirm Season Pause' }));
            await waitFor(() => expect(byId('manage-feature-p3')).toBeNull());
            expect(byId('manage-feature-p1')).toBeNull();
            expect(byId('manage-shop-outside')).toBeNull();
            // The featured one, paused, keeps its place on the shelf for the resume (the node counts it).
            expect(byId('manage-featured')?.textContent).toContain('1 of 6 on the shelf');
        });

        it('an Offer put on the shelf while its listings are being read again keeps its place, here and on its page', async () => {
            await open();
            const panel = await manage();
            await within(panel).findByTestId('manage-featured');
            // The next read of its listings is held. It left before the tap below, so it answers as the node was then.
            let release!: () => void;
            const held = new Promise<void>((r) => { release = r; });
            const base = fetchMock.getMockImplementation()!;
            fetchMock.mockImplementation((url: string, init?: RequestInit) => {
                const answered = base(url, init);
                return new URL(String(url), 'http://node').pathname === '/api/marketplace/posts' ? held.then(() => answered) : answered;
            });
            const asked = listingsReads();
            saveAbout(panel);
            await waitFor(() => expect(listingsReads()).toBe(asked + 1));
            fireEvent.click(byId('manage-feature-p3')!);
            await waitFor(() => expect(byId('manage-feature-p3')).toBeChecked());
            await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
            expect(byId('manage-feature-p3')).toBeChecked();
            expect(byId('manage-featured')?.textContent).toContain('2 of 6 on the shelf');
            fireEvent.click(screen.getByRole('tab', { name: 'Page' }));
            expect(await screen.findByTestId('shopfront-featured-p3')).toBeInTheDocument();
        });

        it('a read again that fails leaves the shelf as it was', async () => {
            await open();
            const panel = await manage();
            await within(panel).findByTestId('manage-featured');
            const asked = listingsReads();
            node.offers = 'down';
            saveAbout(panel);
            await waitFor(() => expect(listingsReads()).toBe(asked + 1));
            await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
            expect(byId('manage-featured-unread')).toBeNull();
            expect(byId('manage-feature-p1')).toBeChecked();
            expect(byId('manage-feature-p3')).toBeInTheDocument();
        });

        it("a refusal is the node's own sentence; Offers that couldn't be read say so", async () => {
            await open({ write: () => ({ status: 400, body: { error: "This Offer has ended, so it can't be featured.", code: 'feature_ended' } }) });
            let panel = await manage();
            await within(panel).findByTestId('manage-featured');
            fireEvent.click(byId('manage-feature-p3')!);
            await waitFor(() => expect(byId('manage-featured-error')?.textContent).toBe("This Offer has ended, so it can't be featured."));
            expect(byId('manage-feature-p3')).not.toBeChecked();
            cleanup();

            await open({ offers: 'down' });
            panel = await manage();
            await waitFor(() => expect(within(panel).getByTestId('manage-featured-unread').textContent).toBe("Its Offers couldn't be read just now."));
        });

        it('no shop yet: one tap opens it', async () => {
            await open({ detail: leadsView({ shop: null }) });
            const panel = await manage();
            expect((await within(panel).findByTestId('manage-shop-none')).textContent).toContain('It has no shop yet.');
            fireEvent.click(byId('manage-shop-open')!);
            await waitFor(() => expect(writes()).toEqual([{ method: 'PUT', path: `/api/treasury/${ENT}/shop`, body: {} }]));
        });
    });
});
