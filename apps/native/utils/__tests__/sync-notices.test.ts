/**
 * The floor under push: the background sync posts a notice on the phone for each unseen notice the member's own node
 * keeps, once each, matched by the notice's id (scratch/global-node/DESIGN-push-relay-fable.md §4.5;
 * utils/sync-notices.ts).
 *
 * The community is a fake that answers `GET /api/notices?unseen=1` as the server does (apps/server routes/notices.ts,
 * engine/kept-notices.ts: the signer's own, oldest first), and refuses a request whose signature core and noble don't
 * accept (server-signature-check.ts). Nothing here contacts a node, and nothing is posted on a phone: `post` records.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nodeCrypto from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { markNoticeShown, postNoticesFromSync, KNOCK_ROLE_RECHECK_MS, SYNC_NOTICE_MAX_AGE_MS, type LocalNotice } from '../sync-notices';
import { PUSH_REGISTERED_AT_STORE_KEY, PUSH_REGISTRATIONS_DUE_STORE_KEY } from '../storage-keys';
import { pushNoticeWords } from '@beanpool/core';
import { checkTap, checkWhileOpen, LOCAL_NOTICE_DATA } from '../push-notice-check';
import { boundSignatureValid } from './server-signature-check';

const MULLUM = 'https://mullum.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const DAY = 24 * 60 * 60 * 1000;

type Account = { publicKey: string; privateKey: string };

function account(): Account {
    const seed = nodeCrypto.randomBytes(32);
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: seed.toString('hex') };
}

interface Row { id: string; recipient: string; title: string; body: string; createdAt: string; seenAt: string | null }

let kim: Account;
let rows: Row[];
let requests: Array<{ url: string; signedBy: boolean }>;
let isDown: boolean;
let posted: LocalNotice[];

function row(title: string, body: string, ageMs = 60_000, recipient = kim.publicKey): Row {
    const r = { id: nodeCrypto.randomUUID(), recipient, title, body, createdAt: new Date(Date.now() - ageMs).toISOString(), seenAt: null };
    rows.push(r);
    return r;
}

const run = (who: Account | null = kim) => postNoticesFromSync({
    storage: AsyncStorage, account: who, post: async (n) => { posted.push(n); },
});

beforeEach(() => {
    mem.async.clear();
    mem.async.set(ANCHOR, `${MULLUM}/`);
    kim = account();
    rows = [];
    requests = [];
    isDown = false;
    posted = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const signer = headers['X-Public-Key'];
        const signedBy = !!signer && boundSignatureValid({ url: String(input), method: init?.method ?? 'GET', headers, body: String(init?.body ?? '') }, signer);
        requests.push({ url: String(input), signedBy });
        if (isDown) throw new TypeError('Network request failed');
        if (url.origin !== MULLUM || url.pathname !== '/api/notices') return new Response('{}', { status: 404 });
        if (!signedBy) return new Response(JSON.stringify({ error: 'A signed request is required' }), { status: 401 });
        const mine = rows.filter((r) => r.recipient === signer && (url.searchParams.get('unseen') !== '1' || r.seenAt === null));
        return new Response(JSON.stringify({
            notices: mine.map((r) => ({
                id: r.id, title: r.title, body: r.body, createdAt: r.createdAt, seenAt: r.seenAt, severity: 'info',
                data: { kind: 'post_hidden', screen: 'post', postId: 'x' },
            })),
        }), { status: 200 });
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('local notices from the background sync', () => {
    it('one for each unseen notice, with the words the node kept, oldest first, asked of the community the phone is set to, signed', async () => {
        row('Post hidden', 'Your listing "Ladder" was hidden after reports.', 2 * 60_000);
        row('Report outcome', 'The post you reported was removed. Thank you.', 60_000);

        expect(await run()).toBe(2);
        expect(posted).toEqual([
            { title: 'Post hidden', body: 'Your listing "Ladder" was hidden after reports.', data: { ...LOCAL_NOTICE_DATA } },
            { title: 'Report outcome', body: 'The post you reported was removed. Thank you.', data: { ...LOCAL_NOTICE_DATA } },
        ]);
        expect(requests).toEqual([{ url: `${MULLUM}/api/notices?unseen=1`, signedBy: true }]);
    });

    it('each once: the next sync posts nothing again, and only a new one when it comes', async () => {
        row('Post hidden', 'Your listing was hidden.');
        expect(await run()).toBe(1);
        expect(await run()).toBe(0);
        const later = row('Post back', 'Your listing is back up.');
        expect(await run()).toBe(1);
        expect(posted.map((n) => n.title)).toEqual(['Post hidden', later.title]);
    });

    it('two syncs at once still post each once', async () => {
        row('Post hidden', 'Your listing was hidden.');
        row('Post back', 'Your listing is back up.');
        const counts = await Promise.all([run(), run()]);
        expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
        expect(posted).toHaveLength(2);
    });

    it('one the app showed live while open (the socket\'s alert named its id) is never posted', async () => {
        const live = row('Post hidden', 'Your listing was hidden.');
        row('Post back', 'Your listing is back up.');
        await markNoticeShown(live.id, AsyncStorage);
        expect(await run()).toBe(1);
        expect(posted.map((n) => n.title)).toEqual(['Post back']);
    });

    it('a notice older than a week is left to the node (and the web app): a phone back after a while isn\'t buried', async () => {
        row('Old', 'From a month ago.', 30 * DAY);
        row('Edge', 'Just past a week.', SYNC_NOTICE_MAX_AGE_MS + 60_000);
        row('Recent', 'From yesterday.', DAY);
        expect(await run()).toBe(1);
        expect(posted.map((n) => n.title)).toEqual(['Recent']);
    });

    it('only the member\'s own and only unseen ones: the node\'s rows for others, and those seen on the web app, are not posted', async () => {
        row('For Lee', 'Not Kim\'s.', 60_000, account().publicKey);
        const seen = row('Seen', 'Seen on the web app.');
        seen.seenAt = new Date().toISOString();
        row('Kim', 'Kim\'s.');
        expect(await run()).toBe(1);
        expect(posted.map((n) => n.title)).toEqual(['Kim']);
    });

    it('a node that is down posts nothing and claims nothing: the next sync posts them', async () => {
        row('Post hidden', 'Your listing was hidden.');
        isDown = true;
        expect(await run()).toBe(0);
        isDown = false;
        expect(await run()).toBe(1);
    });

    it('a notice that couldn\'t be posted is not posted again later (never twice, even at that cost)', async () => {
        row('Post hidden', 'Your listing was hidden.');
        const failing = await postNoticesFromSync({ storage: AsyncStorage, account: kim, post: async () => { throw new Error('no permission'); } });
        expect(failing).toBe(0);
        expect(await run()).toBe(0);
    });

    it('no account or no community on the phone: no request at all', async () => {
        row('Post hidden', 'Your listing was hidden.');
        expect(await run(null)).toBe(0);
        mem.async.delete(ANCHOR);
        expect(await run()).toBe(0);
        expect(requests).toEqual([]);
    });

    it('an answer that isn\'t a list of notices posts nothing; rows without an id or words are skipped; long words are cut', async () => {
        vi.mocked(fetch).mockImplementationOnce(async () => new Response('<html>Sign in to the Wi-Fi</html>', { status: 200 }));
        expect(await run()).toBe(0);
        const now = new Date().toISOString();
        vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({
            notices: [
                { title: 'No id', body: 'x', createdAt: now },
                { id: 'a', title: '', body: 'x', createdAt: now },
                { id: 'b', title: 'x', body: 'y', createdAt: 'yesterday' },
                { id: 'c', title: 'T'.repeat(500), body: 'B'.repeat(5000), createdAt: now },
            ],
        }), { status: 200 }));
        expect(await run()).toBe(1);
        expect(posted[0].title.length).toBeLessThanOrEqual(80);
        expect(posted[0].body.length).toBeLessThanOrEqual(400);
    });

    it('its notices are the app\'s own: shown while open, and a tap on one opens the app where it was, with no warning', async () => {
        row('Post hidden', 'Your listing was hidden.');
        await run();
        const own = { identifier: 'local-1', remote: false, title: posted[0].title, body: posted[0].body, data: posted[0].data };
        expect(await checkWhileOpen(own, { storage: AsyncStorage, recipient: kim.publicKey })).toEqual({ kind: 'show' });
        expect(await checkTap(own, { storage: AsyncStorage, recipient: kim.publicKey })).toEqual({ kind: 'nothing', reason: 'local' });
    });

    it('background sync polls open knock status and posts a notice when answered', async () => {
        const { postKnockStatusNoticesFromSync } = await import('../sync-notices');
        const knocker = account();
        mem.async.set('beanpool_knocks', JSON.stringify({
            pubkey: knocker.publicKey,
            knocks: [{ url: MULLUM, name: 'Mullumbimby', key: 'mullum', sentAt: new Date().toISOString() }],
        }));

        vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({
            status: 'approved',
            invite: 'INV-TEST-1234',
            expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
        }), { status: 200 }));

        const postedKnocks: LocalNotice[] = [];
        const count = await postKnockStatusNoticesFromSync({
            storage: AsyncStorage,
            account: knocker,
            post: async (n) => { postedKnocks.push(n); },
        });

        expect(count).toBe(1);
        expect(postedKnocks[0].title).toBe('BeanPool');
        expect(postedKnocks[0].body).toBe('A community answered your request.');
    });
});

// ── Requests to join (front doors S1): the floor under the community.knock push, and the answers to the asker ──────

describe('requests to join, from the background sync', () => {
    type Route = (url: URL, signedBy: boolean) => Response | Promise<Response>;
    /** The community: each path's answer; every request recorded, as the fake above does. */
    function community(routes: Record<string, Route>) {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const headers = (init?.headers ?? {}) as Record<string, string>;
            const signer = headers['X-Public-Key'];
            const signedBy = !!signer && boundSignatureValid({ url: String(input), method: init?.method ?? 'GET', headers, body: String(init?.body ?? '') }, signer);
            requests.push({ url: String(input), signedBy });
            const route = routes[`${url.origin}${url.pathname}`];
            if (!route) return new Response('{}', { status: 404 });
            if (!signedBy) return new Response('{}', { status: 401 });
            return route(url, signedBy);
        }));
    }
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    let role: string | null;
    let open: number;
    const adminRoutes = () => community({
        [`${MULLUM}/api/node-admin/me`]: () => json({ role, communityName: 'Mullumbimby' }),
        [`${MULLUM}/api/node-admin/queue`]: () => (role ? json({ total: open, items: open ? [{ kind: 'knocks', count: open, label: 'Requests to join', section: 'home' }] : [] })
            : json({ error: 'Only the node owner, an admin or a moderator can see the admin queue' }, 403)),
    });
    const admin = async (now = Date.now()) => {
        const { postAdminKnockNoticesFromSync } = await import('../sync-notices');
        return postAdminKnockNoticesFromSync({ storage: AsyncStorage, account: kim, post: async (n) => { posted.push(n); }, now });
    };
    const asked = (path: string) => requests.filter((r) => new URL(r.url).pathname === path).length;

    beforeEach(() => { role = 'owner'; open = 0; });

    it('an owner with no push here (GrapheneOS): the first look only writes the count down; a new request is one notice, in the push\'s words', async () => {
        adminRoutes();
        open = 2;
        expect(await admin()).toBe(0);
        expect(posted).toEqual([]);
        open = 3;
        expect(await admin()).toBe(1);
        expect(posted).toHaveLength(1);
        expect({ title: posted[0].title, body: posted[0].body }).toEqual(pushNoticeWords('community.knock'));
        expect(posted[0].body).toBe('Someone asked to join your community.');
        expect(posted[0].data).toMatchObject(LOCAL_NOTICE_DATA);
        // No name, key or id: counts and kinds only.
        expect(JSON.stringify(posted[0])).not.toMatch(/[0-9a-f]{64}/);
        // The same count, or fewer (one answered), says nothing.
        expect(await admin()).toBe(0);
        open = 1;
        expect(await admin()).toBe(0);
        expect(requests.every((r) => r.signedBy)).toBe(true);
    });

    it('an owner whose phone has push from this community is told by the push alone: no read, no second notice', async () => {
        adminRoutes();
        mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([MULLUM]));
        open = 1;
        expect(await admin()).toBe(0);
        open = 4;
        expect(await admin()).toBe(0);
        expect(posted).toEqual([]);
        expect(requests).toEqual([]);
        // Push from another community only: this one still gets the floor.
        mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify(['https://castlemaine.beanpool.org']));
        expect(await admin()).toBe(0);
        open = 5;
        expect(await admin()).toBe(1);
    });

    it('a registration that never landed (on the record, still due: refused, or no answer) is no push: the floor tells the owner', async () => {
        adminRoutes();
        // The community goes on the record before the request goes out, and the registration stays due until it lands
        // (push-registrations.ts): until then the node holds no token for this phone.
        mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([MULLUM]));
        const due = (community: string, publicKey = kim.publicKey) => ({ publicKey: publicKey.toLowerCase(), community, refusals: 3, retryAt: Date.now() + 60 * 60 * 1000 });
        mem.async.set(PUSH_REGISTRATIONS_DUE_STORE_KEY, JSON.stringify([due(MULLUM)]));
        open = 1;
        expect(await admin()).toBe(0);
        open = 2;
        expect(await admin()).toBe(1);
        expect({ title: posted[0].title, body: posted[0].body }).toEqual(pushNoticeWords('community.knock'));

        // Due at another community only, or for another key: this one's registration landed, and the push tells it.
        posted = [];
        requests = [];
        mem.async.set(PUSH_REGISTRATIONS_DUE_STORE_KEY, JSON.stringify([due('https://castlemaine.beanpool.org'), due(MULLUM, account().publicKey)]));
        open = 3;
        expect(await admin()).toBe(0);
        expect(posted).toEqual([]);
        expect(requests).toEqual([]);

        // It lands: nothing due. The push alone, as above.
        mem.async.delete(PUSH_REGISTRATIONS_DUE_STORE_KEY);
        open = 4;
        expect(await admin()).toBe(0);
        expect(posted).toEqual([]);
    });

    it("a member's sync never reads the admin-only queue: it asks its role once a day, any member's read", async () => {
        adminRoutes();
        role = null;
        open = 3;
        const t0 = Date.now();
        expect(await admin(t0)).toBe(0);
        expect(await admin(t0 + 60_000)).toBe(0);
        expect(await admin(t0 + 23 * 60 * 60 * 1000)).toBe(0);
        expect(asked('/api/node-admin/queue')).toBe(0);
        expect(asked('/api/node-admin/me')).toBe(1);
        // A day on, asked again: made an admin since, the queue is read from then.
        role = 'admin';
        expect(await admin(t0 + KNOCK_ROLE_RECHECK_MS)).toBe(0);
        expect(asked('/api/node-admin/me')).toBe(2);
        expect(asked('/api/node-admin/queue')).toBe(1);
        open = 4;
        expect(await admin(t0 + KNOCK_ROLE_RECHECK_MS + 60_000)).toBe(1);
    });

    it('a community that said yes is asked once per sync, and a request the member cancelled is not asked at all', async () => {
        const CASTLE = 'https://castlemaine.beanpool.org';
        community({
            [`${MULLUM}/api/join/knock/status`]: () => json({ status: 'approved', invite: 'INV-1', expiresAt: null }),
            [`${CASTLE}/api/join/knock/status`]: () => json({ status: 'pending' }),
        });
        mem.async.set('beanpool_knocks', JSON.stringify({
            pubkey: kim.publicKey,
            knocks: [
                { url: MULLUM, name: 'Mullumbimby', key: 'mullum', sentAt: new Date().toISOString() },
                { url: CASTLE, name: 'Castlemaine', key: 'castle', sentAt: new Date().toISOString(), cancelledAt: new Date().toISOString() },
            ],
        }));
        const { postKnockStatusNoticesFromSync } = await import('../sync-notices');
        const once = () => postKnockStatusNoticesFromSync({ storage: AsyncStorage, account: kim, post: async (n) => { posted.push(n); } });
        expect(await once()).toBe(1);
        expect(await once()).toBe(0);
        expect(posted.map((n) => n.body)).toEqual(['A community answered your request.']);
        expect(requests.map((r) => r.url)).toEqual([`${MULLUM}/api/join/knock/status`, `${MULLUM}/api/join/knock/status`]);
    });

    it('a request too old to be answered (61 days: an open month, an invite\'s month, a day) is asked nothing, and the sync writes nothing back', async () => {
        const CASTLE = 'https://castlemaine.beanpool.org';
        community({
            [`${MULLUM}/api/join/knock/status`]: () => json({ status: 'pending' }),
            [`${CASTLE}/api/join/knock/status`]: () => json({ status: 'approved', invite: 'INV-OLD', expiresAt: null }),
        });
        const now = Date.now();
        const store = JSON.stringify({
            pubkey: kim.publicKey,
            knocks: [
                { url: MULLUM, name: 'Mullumbimby', key: 'mullum', sentAt: new Date(now - 60 * DAY).toISOString() },
                { url: CASTLE, name: 'Castlemaine', key: 'castle', sentAt: new Date(now - 61 * DAY).toISOString() },
                { url: 'https://c.example.org', name: null, key: null },
            ],
        });
        mem.async.set('beanpool_knocks', store);
        const { postKnockStatusNoticesFromSync } = await import('../sync-notices');
        expect(await postKnockStatusNoticesFromSync({ storage: AsyncStorage, account: kim, post: async (n) => { posted.push(n); }, now })).toBe(0);
        expect(requests.map((r) => r.url)).toEqual([`${MULLUM}/api/join/knock/status`]);
        expect(posted).toEqual([]);
        // Forgetting it is the screens' job (utils/knock.ts rememberedKnocks), never a background write under them.
        expect(mem.async.get('beanpool_knocks')).toBe(store);
    });

    it('a tap on either of its notices opens where it is answered: Invites for the owner, Find a community for the asker', async () => {
        adminRoutes();
        open = 1;
        await admin();
        open = 2;
        expect(await admin()).toBe(1);
        community({ [`${MULLUM}/api/join/knock/status`]: () => json({ status: 'approved', invite: 'INV-1', expiresAt: null }) });
        mem.async.set('beanpool_knocks', JSON.stringify({ pubkey: kim.publicKey, knocks: [{ url: MULLUM, name: 'Mullumbimby', key: 'mullum', sentAt: new Date().toISOString() }] }));
        const { postKnockStatusNoticesFromSync } = await import('../sync-notices');
        expect(await postKnockStatusNoticesFromSync({ storage: AsyncStorage, account: kim, post: async (n) => { posted.push(n); } })).toBe(1);
        const taps = await Promise.all(posted.map((n, i) => checkTap({ identifier: `local-${i}`, remote: false, title: n.title, body: n.body, data: n.data }, { storage: AsyncStorage, recipient: kim.publicKey })));
        expect(taps).toEqual([{ kind: 'route', route: '/(tabs)/people?view=invites' }, { kind: 'route', route: '/find-community' }]);
    });

    it("all of it under one deadline: a community that never answers can't hold the task past it (iOS gives ~30 s)", async () => {
        // Every read hangs until it is aborted.
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(input), signedBy: true });
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            });
        }));
        mem.async.set('beanpool_knocks', JSON.stringify({
            pubkey: kim.publicKey,
            knocks: ['https://a.example.org', 'https://b.example.org', 'https://c.example.org'].map((url) => ({ url, name: null, key: null, sentAt: new Date().toISOString() })),
        }));
        const { postAllNoticesFromSync } = await import('../sync-notices');
        const started = Date.now();
        const n = await postAllNoticesFromSync({ storage: AsyncStorage, account: kim, post: async (x) => { posted.push(x); }, timeoutMs: 300 });
        const took = Date.now() - started;
        expect(n).toBe(0);
        // The unseen notices, three answers and the role: asked side by side, so the whole waits one deadline, not five.
        expect(requests).toHaveLength(5);
        expect(took).toBeLessThan(900);
    });
});
