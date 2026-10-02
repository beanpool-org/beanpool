/**
 * Home's one request and what the phone keeps (utils/home-store.ts; design §4.2, §5.2; slice H2), against a stubbed node
 * that answers GET /api/home as apps/server routes/home.ts does: a weak ETag over the answer, `private, max-age=0,
 * must-revalidate`, a 304 when `If-None-Match` names it, 401/403 to a key that is no member. Every request is recorded and
 * its signature checked as the node checks it (server-signature-check.ts).
 *
 * - the first read is one signed GET naming the cards; a repeat sends the kept tag and gets a 304, the copy kept;
 * - a copy for another list of cards, account or community is no copy;
 * - a refusal, a failure, a bad body: the copy stays as it was;
 * - overlapping reads are one request; the header reads the answer while it is fresher than two minutes;
 * - the layout and the interests saves (POST /api/members/preferences) and the interests' one truth;
 * - Sign Out takes Home's copies with the account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(), emit: vi.fn() } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((n: number) => new Uint8Array(randomBytes(n))) }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined),
}));
const mem = vi.hoisted(() => ({ store: new Map<string, string>(), broken: false }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => { if (mem.broken) throw new Error('storage'); return mem.store.get(k) ?? null; }),
        setItem: vi.fn(async (k: string, v: string) => { if (mem.broken) throw new Error('storage'); mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...mem.store.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach(k => mem.store.delete(k)); }),
    },
}));
vi.mock('../pulse-token-store', () => ({ forgetAllPulseTokens: vi.fn(async () => undefined) }));

import {
    FAV_CATEGORIES_STORE_KEY, HOME_HEADER_WAIT_MS, freshHomeForHeader, homeForHeader, loadHome, readHomeFromNode, readStoredHome,
    reconcileInterests, resetHomeStoreForTests, saveHomePreferences, saveInterests,
} from '../home-store';
import { HOME_FRESH_FOR_HEADER_MS, cardsToAsk, type HomeAnswer, type HomeLayout } from '../home-cards';
import { homeAnswerStoreKey, homeHintStoreKey, homeLayoutStoreKey, homeRevealStoreKey } from '../storage-keys';
import { draftIdentity, wipeIdentityScopedStorage, type BeanPoolIdentity } from '../identity';
import { boundSignatureValid, type SentRequest } from './server-signature-check';

const NODE = 'https://mullum.beanpool.org';
const OTHER = 'https://castlemaine.beanpool.org';

const node = {
    answer: null as HomeAnswer | null,
    status: 200,
    down: false,
    body: null as string | null,
    kept: { layout: null as unknown, interests: null as unknown },
    requests: [] as (SentRequest & { status: number })[],
};

function answer(over: Partial<HomeAnswer> = {}): HomeAnswer {
    return {
        generatedAt: new Date().toISOString(), profile: 'local', features: { beans: true, escrow: true, invites: true },
        me: { joinedAt: '2026-09-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: true, standing: 'member' },
        layout: null,
        cards: { community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 } },
        ...over,
    };
}
/** routes/home.ts homeEtag: the reader and the answer, never the moment it was made. */
const etagOf = (who: string, a: HomeAnswer) => {
    const { generatedAt: _g, ...rest } = a;
    return `W/"home-${createHash('sha256').update(`${who}\n${JSON.stringify(rest)}`).digest('hex').slice(0, 24)}"`;
};

let me: BeanPoolIdentity;

beforeEach(async () => {
    mem.store.clear();
    mem.broken = false;
    resetHomeStoreForTests();
    node.answer = answer();
    node.status = 200;
    node.down = false;
    node.body = null;
    node.kept = { layout: null, interests: null };
    node.requests = [];
    me = await draftIdentity();
    globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
        const url = String(input);
        const headers = { ...(init.headers ?? {}) } as Record<string, string>;
        const req = { url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : '' };
        const u = new URL(url);
        const record = (status: number) => { node.requests.push({ ...req, status }); };
        if (node.down) { record(0); throw new TypeError('Network request failed'); }
        if (!boundSignatureValid(req, me.publicKey)) { record(401); return new Response('{"error":"bad signature"}', { status: 401 }); }
        if (u.pathname === '/api/home' && req.method === 'GET') {
            if (node.status !== 200) { record(node.status); return new Response('{"code":"members_only"}', { status: node.status }); }
            if (node.body !== null) { record(200); return new Response(node.body, { status: 200 }); }
            const tag = etagOf(me.publicKey, node.answer!);
            if (headers['If-None-Match'] === tag) { record(304); return new Response(null, { status: 304, headers: { ETag: tag } }); }
            record(200);
            return new Response(JSON.stringify(node.answer), { status: 200, headers: { ETag: tag, 'Cache-Control': 'private, max-age=0, must-revalidate' } });
        }
        if (u.pathname === '/api/members/preferences' && req.method === 'POST') {
            const body = JSON.parse(req.body);
            const out: Record<string, unknown> = { success: true };
            if ('home.layout' in body.preferences) { node.kept.layout = body.preferences['home.layout']; out['home.layout'] = node.kept.layout; }
            if ('interests' in body.preferences) { node.kept.interests = body.preferences.interests; out.interests = node.kept.interests; }
            record(200);
            return new Response(JSON.stringify(out), { status: 200 });
        }
        record(404);
        return new Response('{}', { status: 404 });
    }) as any;
});

afterEach(() => {
    vi.useRealTimers();
});

const asked = cardsToAsk(null);
const homeReads = () => node.requests.filter(r => new URL(r.url).pathname === '/api/home');

describe('one signed read for the whole screen, and the 304', () => {
    it('the first read: one GET naming the cards in the catalogue\'s order, signed for this node, no tag; the answer kept', async () => {
        const read = await readHomeFromNode(NODE, me, asked, null);
        expect(read.kind).toBe('answer');
        expect(homeReads()).toHaveLength(1);
        const [r] = homeReads();
        expect(r.url).toBe(`${NODE}/api/home?cards=needs,safety,steps,deals,enterprise,events,market,decide,groups,joined,pulse,beans,notices,community`);
        expect(r.headers['If-None-Match']).toBeUndefined();
        expect(boundSignatureValid(r, me.publicKey)).toBe(true);
        const kept = await readStoredHome(me.publicKey, NODE);
        expect(kept?.answer.cards.community?.name).toBe('Mullumbimby');
        expect(kept?.etag).toBe(etagOf(me.publicKey, node.answer!));
    });

    it('a repeat sends the kept tag: a 304 with no body, the copy confirmed and its time renewed', async () => {
        const first = await readHomeFromNode(NODE, me, asked, null, { now: () => 1000 });
        if (first.kind !== 'answer') throw new Error('no answer');
        const again = await readHomeFromNode(NODE, me, asked, first.stored, { now: () => 5000 });
        expect(again).toMatchObject({ kind: 'answer', confirmed: true });
        if (again.kind !== 'answer') throw new Error('no answer');
        expect(again.stored.at).toBe(5000);
        expect(again.stored.answer).toEqual(first.stored.answer);
        expect(homeReads().map(r => r.status)).toEqual([200, 304]);
        expect(homeReads()[1].headers['If-None-Match']).toBe(first.stored.etag);
        expect((await readStoredHome(me.publicKey, NODE))?.at).toBe(5000);
    });

    it('a change on the node: a new answer (200), and the new tag kept', async () => {
        const first = await readHomeFromNode(NODE, me, asked, null);
        if (first.kind !== 'answer') throw new Error('no answer');
        node.answer = answer({ cards: { ...node.answer!.cards, beans: { balance: 5, room: 5, tier: 'Resident', activated: true, frozen: false } } });
        const again = await readHomeFromNode(NODE, me, asked, first.stored);
        expect(again).toMatchObject({ kind: 'answer', confirmed: false });
        expect(homeReads().map(r => r.status)).toEqual([200, 200]);
        expect((await readStoredHome(me.publicKey, NODE))?.answer.cards.beans?.balance).toBe(5);
    });

    it('a copy for another list of cards is no copy: no tag sent', async () => {
        const first = await readHomeFromNode(NODE, me, asked, null);
        if (first.kind !== 'answer') throw new Error('no answer');
        await readHomeFromNode(NODE, me, asked.filter(c => c !== 'pulse'), first.stored);
        expect(homeReads()[1].headers['If-None-Match']).toBeUndefined();
        expect(homeReads()[1].url).not.toContain('pulse');
    });

    it('another account\'s or community\'s copy is never read back', async () => {
        await readHomeFromNode(NODE, me, asked, null);
        const someoneElse = await draftIdentity();
        expect(await readStoredHome(someoneElse.publicKey, NODE)).toBeNull();
        expect(await readStoredHome(me.publicKey, OTHER)).toBeNull();
        expect(await readStoredHome(me.publicKey, `${NODE}/`)).not.toBeNull();
    });

    it('a refusal (401, 403) is members_only; down, a 5xx or a body that isn\'t one fails; the copy stays as it was', async () => {
        const first = await readHomeFromNode(NODE, me, asked, null);
        if (first.kind !== 'answer') throw new Error('no answer');
        const before = mem.store.get(homeAnswerStoreKey(me.publicKey, NODE));
        node.status = 403;
        expect((await readHomeFromNode(NODE, me, asked, first.stored)).kind).toBe('members_only');
        node.status = 401;
        expect((await readHomeFromNode(NODE, me, asked, first.stored)).kind).toBe('members_only');
        node.status = 500;
        expect((await readHomeFromNode(NODE, me, asked, first.stored)).kind).toBe('failed');
        node.status = 200;
        node.body = '<html>captive portal</html>';
        expect((await readHomeFromNode(NODE, me, asked, first.stored)).kind).toBe('failed');
        node.body = null;
        node.down = true;
        expect((await readHomeFromNode(NODE, me, asked, first.stored)).kind).toBe('failed');
        expect(mem.store.get(homeAnswerStoreKey(me.publicKey, NODE))).toBe(before);
    });

    it('a phone whose storage refuses every write still reads Home (never a gate)', async () => {
        mem.broken = true;
        const read = await readHomeFromNode(NODE, me, asked, null);
        expect(read.kind).toBe('answer');
    });
});

describe('one read at a time, and the header', () => {
    it('a focus, a doorbell and a pull that meet are one request', async () => {
        const reads = await Promise.all([loadHome(NODE, me, asked, null), loadHome(NODE, me, asked, null), loadHome(NODE, me, asked, null)]);
        expect(homeReads()).toHaveLength(1);
        expect(new Set(reads).size).toBe(1);
        // Once it settled, the next is its own read.
        await loadHome(NODE, me, asked, null);
        expect(homeReads()).toHaveLength(2);
    });

    it('the header reads Home\'s answer while it is fresher than two minutes, for this account and community, when it asked for `needs`', async () => {
        vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
        expect(freshHomeForHeader(NODE, me.publicKey)).toBeNull();
        await loadHome(NODE, me, asked, null);
        expect(freshHomeForHeader(NODE, me.publicKey)?.answer.cards.community?.name).toBe('Mullumbimby');
        expect(freshHomeForHeader(`${NODE}/`, me.publicKey)).not.toBeNull();
        expect(freshHomeForHeader(OTHER, me.publicKey)).toBeNull();
        expect(freshHomeForHeader(NODE, 'f'.repeat(64))).toBeNull();
        vi.setSystemTime(1_000_000 + HOME_FRESH_FOR_HEADER_MS - 1);
        expect(freshHomeForHeader(NODE, me.publicKey)).not.toBeNull();
        vi.setSystemTime(1_000_000 + HOME_FRESH_FOR_HEADER_MS);
        expect(freshHomeForHeader(NODE, me.publicKey)).toBeNull();
        resetHomeStoreForTests();
        await loadHome(NODE, me, asked.filter(c => c !== 'needs'), null);
        expect(freshHomeForHeader(NODE, me.publicKey)).toBeNull();
    });

    it('on Home the header waits for the read under way, and gets its answer without a request of its own', async () => {
        const waiting = homeForHeader(NODE, me.publicKey, HOME_HEADER_WAIT_MS);
        const read = loadHome(NODE, me, asked, null);
        const got = await waiting;
        await read;
        expect(got?.answer.cards.community?.name).toBe('Mullumbimby');
        expect(homeReads()).toHaveLength(1);
    });

    it('a read that fails ends the header\'s wait at once (it then asks for itself); off Home it never waits', async () => {
        node.down = true;
        const started = Date.now();
        const waiting = homeForHeader(NODE, me.publicKey, HOME_HEADER_WAIT_MS);
        await loadHome(NODE, me, asked, null);
        expect(await waiting).toBeNull();
        expect(Date.now() - started).toBeLessThan(HOME_HEADER_WAIT_MS);
        expect(await homeForHeader(NODE, me.publicKey, 0)).toBeNull();
    });
});

describe('the layout and the interests are the account\'s, with a copy on the phone', () => {
    const layout: HomeLayout = { v: 1, order: ['beans', 'market'], hidden: ['pulse'], dismissed: { safety: '2026-10-02T08:00:00.000Z' }, updatedAt: '2026-10-02T09:00:00.000Z' };

    it('a layout is saved signed, in the shape the node takes (home-preferences.ts), and what it kept comes back', async () => {
        const saved = await saveHomePreferences(NODE, me, { layout });
        const post = node.requests.find(r => r.method === 'POST')!;
        expect(new URL(post.url).pathname).toBe('/api/members/preferences');
        expect(boundSignatureValid(post, me.publicKey)).toBe(true);
        expect(JSON.parse(post.body)).toEqual({ publicKey: me.publicKey, preferences: { 'home.layout': layout } });
        expect(saved?.layout).toEqual(layout);
        // No date: the node stamps it.
        await saveHomePreferences(NODE, me, { layout: { ...layout, updatedAt: null } });
        expect(JSON.parse(node.requests.at(-1)!.body).preferences['home.layout']).not.toHaveProperty('updatedAt');
        node.down = true;
        expect(await saveHomePreferences(NODE, me, { layout })).toBeNull();
    });

    it('a star is the phone\'s at once and the account\'s behind it; one that can\'t land is owed and sent at the next landing', async () => {
        node.down = true;
        expect(await saveInterests(NODE, me, ['food'])).toBe(false);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food']);
        node.down = false;
        // The node still says none; the phone's owed save wins and is sent.
        expect(await reconcileInterests(NODE, me, [])).toEqual(['food']);
        expect(node.kept.interests).toEqual(['food']);
        // Synced now: the account's word wins from here (cleared in the web app, say).
        expect(await reconcileInterests(NODE, me, [])).toEqual([]);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual([]);
    });

    it('the Market\'s For You stars from before Home go to an account that has none, once', async () => {
        mem.store.set(FAV_CATEGORIES_STORE_KEY, JSON.stringify(['garden', 'tools']));
        expect(await reconcileInterests(NODE, me, [])).toEqual(['garden', 'tools']);
        expect(node.kept.interests).toEqual(['garden', 'tools']);
        const posts = node.requests.filter(r => r.method === 'POST').length;
        await reconcileInterests(NODE, me, ['garden', 'tools']);
        expect(node.requests.filter(r => r.method === 'POST').length).toBe(posts);
    });

    it('the account\'s stars win over the phone\'s and the phone\'s copy follows (For You keeps working offline)', async () => {
        mem.store.set(FAV_CATEGORIES_STORE_KEY, JSON.stringify(['arts']));
        await reconcileInterests(NODE, me, ['food']).then(() => undefined);
        // Never compared before and the account has some: the account's.
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food']);
        expect(node.requests.filter(r => r.method === 'POST')).toHaveLength(0);
    });
});

describe('Sign Out takes Home\'s copies with the account', () => {
    it('the answer, the layout and an owed save go; the one-time reveal and hint flags stay (the same account restored here)', async () => {
        await readHomeFromNode(NODE, me, asked, null);
        mem.store.set(homeLayoutStoreKey(me.publicKey, NODE), '{}');
        mem.store.set(homeRevealStoreKey(me.publicKey), '1');
        mem.store.set(homeHintStoreKey(me.publicKey), '1');
        const { default: storage } = await import('@react-native-async-storage/async-storage');
        await wipeIdentityScopedStorage(storage as never);
        expect([...mem.store.keys()].filter(k => k.startsWith('beanpool_home:'))).toEqual([]);
        expect(mem.store.get(homeRevealStoreKey(me.publicKey))).toBe('1');
        expect(mem.store.get(homeHintStoreKey(me.publicKey))).toBe('1');
    });
});
