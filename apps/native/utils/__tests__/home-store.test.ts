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
    FAV_CATEGORIES_STORE_KEY, HOME_HEADER_WAIT_MS, coarseHomePoint, freshHomeForHeader, homeForHeader, homePath, loadHome, readHomeFromNode, readStoredHome,
    interestsTurnNow, reconcileInterests, resetHomeStoreForTests, saveHomePreferences, saveInterests,
} from '../home-store';
import { HOME_FRESH_FOR_HEADER_MS, cardsToAsk, type HomeAnswer, type HomeLayout } from '../home-cards';
import { homeAnswerStoreKey, homeHintStoreKey, homeInterestsOwedStoreKey, homeLayoutStoreKey, homeRevealStoreKey } from '../storage-keys';
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
    /** How each preferences save is answered, in turn: kept at once, no answer, or held until released. */
    saves: [] as ('ok' | 'fail' | 'hold')[],
    held: [] as (() => void)[],
    /** A preferences save refused with this status (the node keeps a Home only for its members). */
    refuse: 0,
    /** While set, GET /api/home is answered (as it was when it arrived) only once released. */
    holdHome: false,
    homeHeld: [] as (() => void)[],
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
    node.saves = [];
    node.held = [];
    node.refuse = 0;
    node.holdHome = false;
    node.homeHeld = [];
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
            const body = JSON.stringify(node.answer);
            if (node.holdHome) await new Promise<void>(r => { node.homeHeld.push(r); });
            if (headers['If-None-Match'] === tag) { record(304); return new Response(null, { status: 304, headers: { ETag: tag } }); }
            record(200);
            return new Response(body, { status: 200, headers: { ETag: tag, 'Cache-Control': 'private, max-age=0, must-revalidate' } });
        }
        if (u.pathname === '/api/members/preferences' && req.method === 'POST') {
            if (node.refuse) { record(node.refuse); return new Response('{"error":"Only a member of this community keeps a Home here."}', { status: node.refuse }); }
            const plan = node.saves.shift() ?? 'ok';
            if (plan === 'fail') { record(0); throw new TypeError('Network request failed'); }
            const body = JSON.parse(req.body);
            const land = () => {
                const out: Record<string, unknown> = { success: true };
                if ('home.layout' in body.preferences) { node.kept.layout = body.preferences['home.layout']; out['home.layout'] = node.kept.layout; }
                if ('interests' in body.preferences) { node.kept.interests = body.preferences.interests; out.interests = node.kept.interests; }
                record(200);
                return new Response(JSON.stringify(out), { status: 200 });
            };
            if (plan === 'hold') return new Promise<Response>(resolve => { node.held.push(() => resolve(land())); });
            return land();
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
        expect(r.url).toBe(`${NODE}/api/home?cards=needs,safety,find,steps,deals,enterprise,events,market,decide,groups,joined,pulse,beans,notices,community`);
        expect(r.headers['If-None-Match']).toBeUndefined();
        expect(boundSignatureValid(r, me.publicKey)).toBe(true);
        const kept = await readStoredHome(me.publicKey, NODE);
        expect(kept?.answer.cards.community?.name).toBe('Mullumbimby');
        expect(kept?.etag).toBe(etagOf(me.publicKey, node.answer!));
    });

    it('a point (the global node, H4): two decimals in the address, outside the signature, and the kept tag still sent', async () => {
        expect(homePath(['market'], { lat: -28.548_31, lng: 153.499_97 })).toBe('/api/home?cards=market&lat=-28.55&lng=153.50');
        expect(coarseHomePoint({ lat: -28.548_31, lng: 153.499_97 })).toEqual({ lat: -28.55, lng: 153.5 });
        // No point, or one that isn't a place: the address is H2's.
        expect(homePath(['market'])).toBe('/api/home?cards=market');
        expect(homePath(['market'], { lat: NaN, lng: 1 })).toBe('/api/home?cards=market');
        expect(homePath(['market'], { lat: 91, lng: 1 })).toBe('/api/home?cards=market');
        // A street's move is the same address, so a repeat read is still a 304.
        expect(homePath(['market'], { lat: -28.5481, lng: 153.4999 })).toBe(homePath(['market'], { lat: -28.5517, lng: 153.4962 }));
        const first = await readHomeFromNode(NODE, me, asked, null, { point: { lat: -28.548_31, lng: 153.499_97 } });
        if (first.kind !== 'answer') throw new Error('no answer');
        const again = await readHomeFromNode(NODE, me, asked, first.stored, { point: { lat: -28.5517, lng: 153.4962 } });
        expect(again).toMatchObject({ kind: 'answer', confirmed: true });
        const [r1, r2] = homeReads();
        expect(new URL(r1.url).searchParams.get('lat')).toBe('-28.55');
        expect(new URL(r1.url).searchParams.get('lng')).toBe('153.50');
        expect(boundSignatureValid(r1, me.publicKey)).toBe(true);
        expect(r2.headers['If-None-Match']).toBe(first.stored.etag);
        // The answer the header reads keeps its own list of cards (the point is not part of it).
        expect(first.stored.asked).toBe(asked.join(','));
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

    it('a refusal (401, 403) is members_only; a 404 is needs_update; down, a 5xx or a body that isn\'t one fails; the copy stays as it was', async () => {
        const first = await readHomeFromNode(NODE, me, asked, null);
        if (first.kind !== 'answer') throw new Error('no answer');
        const before = mem.store.get(homeAnswerStoreKey(me.publicKey, NODE));
        node.status = 403;
        expect((await readHomeFromNode(NODE, me, asked, first.stored)).kind).toBe('members_only');
        node.status = 401;
        expect((await readHomeFromNode(NODE, me, asked, first.stored)).kind).toBe('members_only');
        node.status = 404;
        expect((await readHomeFromNode(NODE, me, asked, first.stored)).kind).toBe('needs_update');
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
        expect(saved !== 'refused' && saved?.layout).toEqual(layout);
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

describe('interests saves: one at a time, only the latest counts (PR #1483 review 4165383880)', () => {
    const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 0)); expect(done()).toBe(true); };
    const owed = () => mem.store.get(`beanpool_home:interests-owed:${me.publicKey.toLowerCase()}:${NODE}`) ?? null;
    const interestPosts = () => node.requests.filter(r => r.method === 'POST' && 'interests' in JSON.parse(r.body).preferences)
        .map(r => JSON.parse(r.body).preferences.interests);

    it('a first save landing late, after a second failed, leaves the second owed; the next landing sends it and keeps both stars', async () => {
        node.saves = ['hold', 'fail'];
        const first = saveInterests(NODE, me, ['food']);
        await until(() => node.held.length === 1);
        const second = saveInterests(NODE, me, ['food', 'tools']);
        await new Promise(r => setTimeout(r, 0));
        node.held.shift()!();
        await Promise.all([first, second]);
        expect(node.kept.interests).toEqual(['food']);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food', 'tools']);
        expect(owed()).toBe('owed');
        // The next landing: the account still says ['food']; the phone's newer list is owed, so it is sent and kept.
        expect(await reconcileInterests(NODE, me, ['food'])).toEqual(['food', 'tools']);
        expect(node.kept.interests).toEqual(['food', 'tools']);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food', 'tools']);
        expect(owed()).toBe('synced');
    });

    it('stars tapped while a save is out wait for it, and the node takes the latest list last; one overtaken is never sent', async () => {
        node.saves = ['hold'];
        const first = saveInterests(NODE, me, ['food']);
        await until(() => node.held.length === 1);
        const second = saveInterests(NODE, me, ['food', 'tools']);
        const third = saveInterests(NODE, me, ['food', 'tools', 'garden']);
        await new Promise(r => setTimeout(r, 0));
        // Nothing else is sent while the first is out.
        expect(interestPosts()).toEqual([]);
        node.held.shift()!();
        expect(await Promise.all([first, second, third])).toEqual([false, false, true]);
        expect(interestPosts()).toEqual([['food'], ['food', 'tools', 'garden']]);
        expect(node.kept.interests).toEqual(['food', 'tools', 'garden']);
        expect(owed()).toBe('synced');
    });

    it('an answer asked before a star was tapped can\'t undo it at the landing', async () => {
        const since = interestsTurnNow();
        expect(await saveInterests(NODE, me, ['food'])).toBe(true);
        // The landing's answer was made before the save: its account list is the old one.
        expect(await reconcileInterests(NODE, me, [], since)).toEqual(['food']);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food']);
        expect(node.kept.interests).toEqual(['food']);
    });
});

describe('a save the node refuses is not sent again and again (PR #1483 review 4165383753)', () => {
    it('saveHomePreferences tells a refusal (4xx) from a save that didn\'t land (no answer, 5xx, 429)', async () => {
        node.refuse = 400;
        expect(await saveHomePreferences(NODE, me, { interests: ['food'] })).toBe('refused');
        node.refuse = 403;
        expect(await saveHomePreferences(NODE, me, { interests: ['food'] })).toBe('refused');
        node.refuse = 429;
        expect(await saveHomePreferences(NODE, me, { interests: ['food'] })).toBeNull();
        node.refuse = 503;
        expect(await saveHomePreferences(NODE, me, { interests: ['food'] })).toBeNull();
        node.refuse = 0;
        node.down = true;
        expect(await saveHomePreferences(NODE, me, { interests: ['food'] })).toBeNull();
    });

    it('a refused star stays on the phone and is sent at most once more, never at every landing', async () => {
        node.refuse = 400;
        expect(await saveInterests(NODE, me, ['food'])).toBe(false);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food']);
        for (let i = 0; i < 4; i++) await reconcileInterests(NODE, me, []);
        expect(node.requests.filter(r => r.method === 'POST').length).toBeLessThanOrEqual(2);
    });

    it('an owed list the node refuses at a landing: the account\'s list is drawn at once and the phone follows it', async () => {
        node.saves = ['fail'];
        expect(await saveInterests(NODE, me, ['food'])).toBe(false);
        node.refuse = 400;
        expect(await reconcileInterests(NODE, me, ['garden'])).toEqual(['garden']);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['garden']);
        const posts = node.requests.filter(r => r.method === 'POST').length;
        expect(await reconcileInterests(NODE, me, ['garden'])).toEqual(['garden']);
        expect(node.requests.filter(r => r.method === 'POST').length).toBe(posts);
    });
});

describe('Sign Out takes Home\'s copies with the account', () => {
    it('the answer, the layout, an owed save, the reveal and hint seen, and the stars all go: nothing of Home stays', async () => {
        await readHomeFromNode(NODE, me, asked, null);
        mem.store.set(homeLayoutStoreKey(me.publicKey, NODE), '{}');
        mem.store.set(homeRevealStoreKey(me.publicKey), '1');
        mem.store.set(homeHintStoreKey(me.publicKey), '1');
        mem.store.set(FAV_CATEGORIES_STORE_KEY, '["food"]');
        const { default: storage } = await import('@react-native-async-storage/async-storage');
        await wipeIdentityScopedStorage(storage as never);
        expect([...mem.store.keys()].filter(k => k.startsWith('beanpool_home') || k === FAV_CATEGORIES_STORE_KEY)).toEqual([]);
    });

    it('every key Home writes for an account starts with the one prefix the wipe takes', () => {
        const keys = [
            homeAnswerStoreKey(me.publicKey, NODE), homeLayoutStoreKey(me.publicKey, NODE), homeInterestsOwedStoreKey(me.publicKey, NODE),
            homeRevealStoreKey(me.publicKey), homeHintStoreKey(me.publicKey),
        ];
        expect(keys.filter(k => !k.startsWith('beanpool_home:'))).toEqual([]);
    });
});

describe('an answer older than a save that has landed never overwrites it (PR #1483 review 4166559374)', () => {
    const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 0)); expect(done()).toBe(true); };
    const interestPosts = () => node.requests.filter(r => r.method === 'POST' && 'interests' in JSON.parse(r.body).preferences)
        .map(r => JSON.parse(r.body).preferences.interests);

    it('the review\'s row: two quick stars on a slow link, a read between the saves; the stars stay, and the next star keeps them all', async () => {
        node.saves = ['hold', 'hold'];
        // Tap Food (its save goes out and is slow), then Tools (its save waits behind it).
        const food = saveInterests(NODE, me, ['food']);
        await until(() => node.held.length === 1);
        const tools = saveInterests(NODE, me, ['food', 'tools']);
        // A bell: Home asks the node now (app/(tabs)/index.tsx takes the turn as it asks). The node builds its answer from
        // the member's row as it is at that moment: nothing starred yet.
        const since = interestsTurnNow();
        const read = await loadHome(NODE, me, asked, null);
        if (read.kind !== 'answer') throw new Error('no answer');
        expect(read.stored.answer.me!.interests).toEqual([]);
        // Both saves land, in turn.
        node.held.shift()!();
        await until(() => node.held.length === 1);
        node.held.shift()!();
        await Promise.all([food, tools]);
        expect(node.kept.interests).toEqual(['food', 'tools']);
        // Then the landing takes the answer: it was built before a save that has since landed, so the phone's list stands.
        const drawn = await reconcileInterests(NODE, me, read.stored.answer.me!.interests, since);
        expect(drawn).toEqual(['food', 'tools']);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food', 'tools']);
        // The member sees both stars and adds Garden: the row keeps all three (the review measured ["garden"]).
        expect(await saveInterests(NODE, me, [...drawn, 'garden'])).toBe(true);
        expect(node.kept.interests).toEqual(['food', 'tools', 'garden']);
        // The next landing agrees with the row, and sends nothing.
        const posts = interestPosts().length;
        expect(await reconcileInterests(NODE, me, ['food', 'tools', 'garden'])).toEqual(['food', 'tools', 'garden']);
        expect(interestPosts()).toHaveLength(posts);
    });

    it('an owed save another landing sent after this answer was asked: this answer doesn\'t undo it either', async () => {
        node.saves = ['fail'];
        expect(await saveInterests(NODE, me, ['food'])).toBe(false);
        // Landing A asks; the node's row is still empty.
        const sinceA = interestsTurnNow();
        const readA = await loadHome(NODE, me, asked, null);
        if (readA.kind !== 'answer') throw new Error('no answer');
        // Landing B (a pull) asks too, and sends the owed list, which lands.
        expect(await reconcileInterests(NODE, me, [], interestsTurnNow())).toEqual(['food']);
        expect(node.kept.interests).toEqual(['food']);
        // Landing A's answer arrives last: older than B's save, so it leaves the phone's list as it is.
        expect(await reconcileInterests(NODE, me, readA.stored.answer.me!.interests, sinceA)).toEqual(['food']);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food']);
    });

    it('an answer asked with no save out and none since is the account\'s word: it wins (cleared in the web app, say)', async () => {
        expect(await saveInterests(NODE, me, ['food'])).toBe(true);
        const since = interestsTurnNow();
        expect(await reconcileInterests(NODE, me, [], since)).toEqual([]);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual([]);
    });
});

describe('a landing that joins the read already out takes that read\'s mark, not its own (PR #1483 review 4168250992)', () => {
    const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 0)); expect(done()).toBe(true); };

    it('the review\'s cross-check: a star saved while the read is out stands at both landings, and the next star keeps it', async () => {
        node.holdHome = true;
        // Landing 1 (a focus) sends the read; the node builds its answer as it arrives: nothing starred.
        const first = loadHome(NODE, me, asked, null);
        await until(() => node.homeHeld.length === 1);
        // The member taps Food; its save lands.
        expect(await saveInterests(NODE, me, ['food'])).toBe(true);
        expect(node.kept.interests).toEqual(['food']);
        // Landing 2 (the app back to the front) joins the read already out.
        const second = loadHome(NODE, me, asked, null);
        expect(second).toBe(first);
        node.homeHeld.shift()!();
        const read = await second;
        if (read.kind !== 'answer') throw new Error('no answer');
        expect(homeReads()).toHaveLength(1);
        expect(read.stored.answer.me!.interests).toEqual([]);
        // Each landing reconciles with the mark of the read it got (app/(tabs)/index.tsx): the phone's Food stands.
        expect(await reconcileInterests(NODE, me, read.stored.answer.me!.interests, read.since)).toEqual(['food']);
        expect(await reconcileInterests(NODE, me, read.stored.answer.me!.interests, read.since)).toEqual(['food']);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual(['food']);
        // The next star keeps it (the review measured ["garden"]).
        expect(await saveInterests(NODE, me, ['food', 'garden'])).toBe(true);
        expect(node.kept.interests).toEqual(['food', 'garden']);
    });

    it('the control: a read sent with no save out, and none since, is the account\'s word at both landings', async () => {
        expect(await saveInterests(NODE, me, ['food'])).toBe(true);
        node.holdHome = true;
        const first = loadHome(NODE, me, asked, null);
        await until(() => node.homeHeld.length === 1);
        const second = loadHome(NODE, me, asked, null);
        expect(second).toBe(first);
        node.homeHeld.shift()!();
        const read = await second;
        if (read.kind !== 'answer') throw new Error('no answer');
        // The node's answer says none (cleared in the web app, say): it wins.
        expect(await reconcileInterests(NODE, me, read.stored.answer.me!.interests, read.since)).toEqual([]);
        expect(JSON.parse(mem.store.get(FAV_CATEGORIES_STORE_KEY)!)).toEqual([]);
    });
});
