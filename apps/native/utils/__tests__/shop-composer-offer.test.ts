import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The shop's way into utils/db.ts (slice S4′): the Offer the map's composer posts goes in the member's shop when the List
 * sheet said "Put this in your shop" for it (utils/shop-choice.ts; map.tsx is read, never edited), the Offer edit
 * screen's toggle sends `shopId` (an id puts it in, null takes it out, nothing leaves it), and a refusal keeps the node's
 * code beside its sentence. Device modules are stubbed at the boundary as in events-db.test.ts; the node is a fetch stub.
 */
const mockDb = {
    runAsync: vi.fn().mockResolvedValue({ changes: 1 }),
    execAsync: vi.fn().mockResolvedValue(undefined),
    getAllAsync: vi.fn().mockResolvedValue([]),
    getFirstAsync: vi.fn().mockResolvedValue(null),
    closeAsync: vi.fn().mockResolvedValue(undefined),
    withTransactionAsync: vi.fn().mockImplementation(async (cb: () => Promise<void>) => { await cb(); }),
};
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.map.keys()]),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
    signData: vi.fn(async (msg: Uint8Array) => msg),
}));

import { SHOP_COMPOSER_WAIT_MS, createPost, updatePost, signedRequestWithMethod } from '../db';
import { SHOP_CHOICE_KEY, rememberShopChoice } from '../shop-choice';

const HERE = 'https://mullum.example';
const fetchMock = vi.fn();
const sent: Array<{ method: string; path: string; body: any }> = [];
function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
/** A link that takes the request and never answers: only letting it go (the fetch's signal) settles it, as fetch does. */
const NEVER = Symbol('never');
/** The node: its shop routes and the listing routes, by method and path. */
let routes: Record<string, (body: any) => ReturnType<typeof reply> | typeof NEVER> = {};

beforeEach(() => {
    store.map.clear();
    store.map.set('beanpool_anchor_url', HERE);
    sent.length = 0;
    mockDb.runAsync.mockClear();
    routes = {
        'GET /api/shops/mine': () => reply(200, { shop: { id: 'shop-1', name: null, ownerName: 'Me', paused: false } }),
        'POST /api/marketplace/posts': (body) => reply(200, { success: true, post: { id: body.id, shopId: body.shopId } }),
        'POST /api/marketplace/posts/update': () => reply(200, { success: true }),
    };
    fetchMock.mockReset().mockImplementation(async (url: string, init: { method?: string; body?: string; signal?: AbortSignal }) => {
        const method = init?.method ?? 'GET';
        const path = url.slice(HERE.length);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        sent.push({ method, path, body });
        const route = routes[`${method} ${path}`];
        const answer = route ? route(body) : reply(404, {});
        if (answer === NEVER) return new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        return answer;
    });
    (globalThis as any).fetch = fetchMock;
});

const composerOffer = (title: string, extra: Record<string, unknown> = {}) => ({
    id: 'post-1', type: 'offer', category: 'tools', title, description: 'In good order', credits: 0, price_type: 'fixed',
    repeatable: 0, cash_also_needed: 0, author_pubkey: 'me-pub', lat: -28.5, lng: 153.5, photos: null, created_at: '2026-10-23T08:00:00.000Z',
    reach: 'local', ...extra,
});
const postBody = () => sent.find((r) => r.method === 'POST' && r.path === '/api/marketplace/posts')?.body;
/** The shop's and the listing's requests, in order (createPost also reads the balance after: not these). */
const shopAndPost = () => sent.filter((r) => r.path.startsWith('/api/shops') || r.path === '/api/marketplace/posts').map((r) => `${r.method} ${r.path}`);

describe("the composer's Offer and the List sheet's choice", () => {
    it('the choice holds: the Offer goes in the member\'s shop, and the choice is forgotten once it is posted', async () => {
        await rememberShopChoice(HERE, 'Cordless drill', true);
        await createPost(composerOffer('Cordless drill'));
        expect(postBody()?.shopId).toBe('shop-1');
        expect(store.map.has(SHOP_CHOICE_KEY)).toBe(false);
    });

    it('no shop yet: it is opened first (a PUT with nothing in it), and the Offer goes in it', async () => {
        routes['GET /api/shops/mine'] = () => reply(200, { shop: null });
        routes['PUT /api/shops/mine'] = () => reply(200, { success: true, shop: { id: 'shop-new', name: null, ownerName: 'Me' }, paused: [], resumed: [] });
        await rememberShopChoice(HERE, 'Ladder', true);
        await createPost(composerOffer('Ladder'));
        expect(shopAndPost()).toEqual(['GET /api/shops/mine', 'PUT /api/shops/mine', 'POST /api/marketplace/posts']);
        expect(sent[1].body).toEqual({});
        expect(postBody()?.shopId).toBe('shop-new');
    });

    it('no choice, or one for another Offer: no shop is asked about and none is sent; another\'s choice is kept', async () => {
        await createPost(composerOffer('Couch'));
        expect(shopAndPost()).toEqual(['POST /api/marketplace/posts']);
        expect(postBody()).not.toHaveProperty('shopId');
        sent.length = 0;
        await rememberShopChoice(HERE, 'Cordless drill', true);
        await createPost(composerOffer('Couch'));
        expect(postBody()).not.toHaveProperty('shopId');
        expect(store.map.has(SHOP_CHOICE_KEY)).toBe(true);
    });

    it('a Need is never put in a shop, whatever the choice says', async () => {
        await rememberShopChoice(HERE, 'Cordless drill', true);
        await createPost(composerOffer('Cordless drill', { type: 'need' }));
        expect(postBody()).not.toHaveProperty('shopId');
    });

    it("refused (the shop closed for now since): the node's sentence, nothing posted, and the choice kept for a retry", async () => {
        routes['POST /api/marketplace/posts'] = () => reply(409, { error: 'This shop is closed for now. Reopen it first, then put things in it.', code: 'shop_paused' });
        await rememberShopChoice(HERE, 'Cordless drill', true);
        await expect(createPost(composerOffer('Cordless drill'))).rejects.toThrow('This shop is closed for now. Reopen it first, then put things in it.');
        expect(store.map.has(SHOP_CHOICE_KEY)).toBe(true);
        expect(mockDb.runAsync.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO posts'))).toBe(false);
    });

    it("the shop can't be read, or opened: nothing is posted, it says why, and the choice is kept for a retry", async () => {
        const UNREAD = "Your shop couldn't be read just now. Try again.";
        const notJson = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' });
        const cases: Array<{ name: string; set: () => void; says: string }> = [
            { name: 'GET 500', set: () => { routes['GET /api/shops/mine'] = () => reply(500, {}); }, says: UNREAD },
            { name: 'GET 403', set: () => { routes['GET /api/shops/mine'] = () => reply(403, { error: 'Members only.' }); }, says: UNREAD },
            { name: 'GET 200, not JSON (a captive portal)', set: () => { routes['GET /api/shops/mine'] = notJson as any; }, says: UNREAD },
            { name: 'GET 200, neither a shop nor shop: null', set: () => { routes['GET /api/shops/mine'] = () => reply(200, {}); }, says: UNREAD },
            {
                name: 'the PUT that opens it refused (a muted member)',
                set: () => {
                    routes['GET /api/shops/mine'] = () => reply(200, { shop: null });
                    routes['PUT /api/shops/mine'] = () => reply(403, { error: 'You are muted in this community for now.' });
                },
                says: 'You are muted in this community for now.',
            },
            {
                name: 'the PUT that opens it answering without a shop',
                set: () => {
                    routes['GET /api/shops/mine'] = () => reply(200, { shop: null });
                    routes['PUT /api/shops/mine'] = () => reply(200, { success: true });
                },
                says: UNREAD,
            },
            {
                name: 'no network',
                set: () => { routes['GET /api/shops/mine'] = () => { throw new TypeError('Network request failed'); }; },
                says: 'Network request failed',
            },
        ];
        for (const c of cases) {
            sent.length = 0;
            store.map.delete(SHOP_CHOICE_KEY);
            mockDb.runAsync.mockClear();
            c.set();
            await rememberShopChoice(HERE, 'Cordless drill', true);
            await expect(createPost(composerOffer('Cordless drill')), c.name).rejects.toThrow(c.says);
            expect(shopAndPost(), c.name).not.toContain('POST /api/marketplace/posts');
            expect(store.map.has(SHOP_CHOICE_KEY), c.name).toBe(true);
            expect(mockDb.runAsync.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO posts')), c.name).toBe(false);
        }
    });

    it("the shop never answers (a stalled line): let go at the limit, nothing posted, it says why, and the choice is kept", async () => {
        const stalls: Array<{ name: string; set: () => void }> = [
            { name: 'the read', set: () => { routes['GET /api/shops/mine'] = () => NEVER; } },
            {
                name: 'the PUT that opens it',
                set: () => {
                    routes['GET /api/shops/mine'] = () => reply(200, { shop: null });
                    routes['PUT /api/shops/mine'] = () => NEVER;
                },
            },
        ];
        vi.useFakeTimers();
        try {
            for (const c of stalls) {
                sent.length = 0;
                store.map.delete(SHOP_CHOICE_KEY);
                mockDb.runAsync.mockClear();
                c.set();
                await rememberShopChoice(HERE, 'Cordless drill', true);
                let settled: unknown = 'waiting';
                const posting = createPost(composerOffer('Cordless drill')).then(() => { settled = 'posted'; }, (e) => { settled = e; });
                await vi.advanceTimersByTimeAsync(SHOP_COMPOSER_WAIT_MS - 1);
                expect(settled, c.name).toBe('waiting');
                await vi.advanceTimersByTimeAsync(1);
                await posting;
                expect(settled, c.name).toBeInstanceOf(Error);
                expect((settled as Error).message, c.name).toBe("Your shop couldn't be read just now. Try again.");
                expect(shopAndPost(), c.name).not.toContain('POST /api/marketplace/posts');
                expect(store.map.has(SHOP_CHOICE_KEY), c.name).toBe(true);
                expect(mockDb.runAsync.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO posts')), c.name).toBe(false);
                expect(vi.getTimerCount(), c.name).toBe(0);
            }
            expect(SHOP_COMPOSER_WAIT_MS).toBeLessThanOrEqual(10_000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a node from before shops: the Offer posts on its own', async () => {
        routes['GET /api/shops/mine'] = () => reply(404, {});
        await rememberShopChoice(HERE, 'Cordless drill', true);
        await createPost(composerOffer('Cordless drill'));
        expect(postBody()).not.toHaveProperty('shopId');
    });
});

describe("the Offer edit screen's toggle", () => {
    const edit = { type: 'offer', category: 'tools', title: 'Drill', description: 'x', credits: 0, price_type: 'fixed', repeatable: false, photos: null };
    const updateBody = () => sent.find((r) => r.path === '/api/marketplace/posts/update')?.body;

    it('an id puts it in, null takes it out, and nothing named leaves it as it is', async () => {
        await updatePost('post-1', { ...edit, shopId: 'shop-1' });
        expect(updateBody()?.shopId).toBe('shop-1');
        sent.length = 0;
        await updatePost('post-1', { ...edit, shopId: null });
        expect(updateBody()).toHaveProperty('shopId', null);
        sent.length = 0;
        await updatePost('post-1', edit);
        expect(updateBody()).not.toHaveProperty('shopId');
    });
});

describe('a refusal keeps its code', () => {
    it("signedRequestWithMethod's error carries the node's status and code beside its sentence", async () => {
        routes['POST /api/shops/mine/close'] = () => reply(409, { error: "Finish or cancel the 1 open deal on this shop's things first.", code: 'shop_deals_open' });
        await expect(signedRequestWithMethod('POST', '/api/shops/mine/close', { endOffers: false }, { withStatus: true }))
            .rejects.toMatchObject({ message: "Finish or cancel the 1 open deal on this shop's things first.", status: 409, code: 'shop_deals_open' });
    });
});
