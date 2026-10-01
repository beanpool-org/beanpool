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
import { markNoticeShown, postNoticesFromSync, SYNC_NOTICE_MAX_AGE_MS, type LocalNotice } from '../sync-notices';
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
});
