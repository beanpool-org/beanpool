/**
 * The nearby 304 (PR #1805 piece 3) only over what the phone holds: the review of #1805's findings 1 and 2, each as it
 * was measured (scratch/reviews/opus-1805-files: midread, resend, blockpush). The harness is pillar-sync-nearby.test.ts's,
 * with a hook that runs before each of the phone's requests (`beforeFetch`: a change made while a read pages, a push that
 * lands then) and the bodies of its posts reads (`bodies`). The first test here is the phone's first read.
 *
 * The phone's sync by area (services/pillar-sync.ts, utils/posts-nearby.ts, DESIGN-global-sync-by-area §2.4) against a
 * REAL global node on this machine: apps/server/src/phone-door-test-harness.ts, the real HTTPS server, signature
 * middleware and posts route (`nearby=1`, the member's set, `ids=`), started from the packages' sources and killed by its
 * PID. The phone is its own code: performSync, applyDelta writing the real schema into an in-memory SQLite, the area copy,
 * the pushed-change writer. Its reads are signed with its key as the app's request signing does, and its fetch keeps a
 * platform HTTP cache (If-None-Match, a 304 handed back as the stored 200), as RN's does (memory phone-http-cache-revalidates).
 *
 * The world: the member near Byron Bay, 520 listings within 100 km of them (the node's cap is 500), 30 in London, the
 * member's own listing in London, and on the phone a listing in Perth they have a conversation about.
 *
 * Nothing else is contacted: the phone's fetch is held to this node's address, and the node's own fetch refuses every
 * host but this machine.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Module from 'node:module';

(globalThis as any).__DEV__ = false;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sql = new DatabaseSync(':memory:');
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
const adapter = {
    runAsync: vi.fn(async (q: string, p?: unknown) => {
        const r = sql.prepare(q).run(...params(p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    }),
    execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
    getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
    getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>(), me: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
    randomUUID: vi.fn(() => randomUUID()),
    digest: vi.fn(async (_algorithm: string, data: Uint8Array) => {
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.async.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.async.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { mem.async.delete(k); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) mem.async.delete(k); }),
        multiGet: vi.fn(async (ks: string[]) => ks.map(k => [k, mem.async.get(k) ?? null])),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
// The phone's one identity: the member drafted below.
vi.mock('../identity', async (original) => ({
    ...(await original<typeof import('../identity')>()),
    loadIdentity: vi.fn(async () => mem.me),
}));

import { draftIdentity } from '../identity';
import { buildSignedHeaders } from '../crypto';
import { getDb } from '../db';
import { fetchNodeProfile } from '../node-profile';
import { writeMemberArea } from '../member-area';
import { nearbyAreaKeyOf, noAreaLineHere, readNearbyAreaCopy } from '../nearby-area';
import { nearbyKm } from '../posts-nearby';
import { applyLivePostChange, performSync, resetSyncFingerprints } from '../../services/pillar-sync';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
/** Every request the phone made: method, path + query, status as the app saw it, and whether a 304 stood behind it. */
let sent: { method: string; url: string; status: number; revalidated: boolean; keys?: string[]; ifNoneMatch?: string }[] = [];
const elsewhere: string[] = [];
/** Runs before each of the phone's requests to the node: a change made while a read pages, a push that lands then. */
let beforeFetch: ((path: string) => Promise<void>) | null = null;
/** Every posts read's answer as the node sent it: path, status, ETag, body (a 200's). */
const bodies: { path: string; status: number; etag: string | null; body: string | null }[] = [];
/** The platform HTTP cache: the last 200 per URL, with its ETag. */
const httpCache = new Map<string, { etag: string; body: string; headers: [string, string][] }>();

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

const BYRON = { lat: -28.6, lng: 153.6 };
const LONDON = { lat: 51.5, lng: -0.1 };
const PERTH = { lat: -31.95, lng: 115.86 };

/** A place `km` from `c` on bearing `deg` (flat-earth, fine within 100 km). */
const at = (c: { lat: number; lng: number }, km: number, deg: number) => ({
    lat: c.lat + (km / 111) * Math.cos((deg * Math.PI) / 180),
    lng: c.lng + (km / (111 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin((deg * Math.PI) / 180),
});

type Place = { id: string; lat: number; lng: number };
let near: Place[] = [];
let me: { publicKey: string; privateKey: string; callsign: string };
const authors: string[] = [];

const postsReads = () => sent.filter(r => r.url.startsWith('/api/marketplace/posts?') && !r.url.includes('ids='));
const idReads = () => sent.filter(r => r.url.startsWith('/api/marketplace/posts?ids='));
const heldIds = () => new Set((sql.prepare('SELECT id FROM posts').all() as { id: string }[]).map(r => r.id));
const sorted = (s: Iterable<string>) => [...s].sort();

/** The node's set for an area, worked out here by brute force: the nearest `max` within 250 km, plus the member's own. */
function expectedSet(area: { lat: number; lng: number }, places: Place[], own: string[], max = 500): Set<string> {
    const within = places.map(p => ({ p, d: nearbyKm(area.lat, area.lng, p.lat, p.lng) })).filter(x => x.d <= 250)
        .sort((a, b) => a.d - b.d).slice(0, max).map(x => x.p.id);
    return new Set([...within, ...own]);
}

/** A cycle that may fail (a fault above): its result, as performSync answers it. */
async function syncAllowingFailure() {
    sent = [];
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        return await performSync();
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

async function sync() {
    const r = await syncAllowingFailure();
    expect(r.success, r.errorMessage).toBe(true);
    return r;
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pillar-sync-nearby-'));
    node = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json' },
        stdio: 'pipe',
    });
    let out = '';
    let log = '';
    const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the test node did not start in time:\n${log.slice(-3000)}`)), START_MS - 5_000);
        node.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            log += chunk.toString();
            let nl: number;
            while ((nl = out.indexOf('\n')) >= 0) {
                const line = out.slice(0, nl);
                out = out.slice(nl + 1);
                const started = /^PHONE-DOOR-NODE-PORT (\d+)$/.exec(line);
                if (started) { clearTimeout(timer); resolve(Number(started[1])); }
                const reply = /^PHONE-DOOR-NODE-REPLY (.*)$/.exec(line);
                if (reply) {
                    const r = JSON.parse(reply[1]) as { id: number; result?: unknown; error?: string };
                    replies.get(r.id)?.(r);
                    replies.delete(r.id);
                }
            }
        });
        node.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
        node.on('exit', (code) => reject(new Error(`the test node exited (${code}):\n${log.slice(-3000)}`)));
    });
    URL_BASE = `https://127.0.0.1:${port}`;
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (beforeFetch && href.startsWith(`${URL_BASE}/`)) await beforeFetch(href.slice(URL_BASE.length));
        if (!href.startsWith(`${URL_BASE}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        const method = String(init?.method ?? 'GET').toUpperCase();
        const headers: Record<string, string> = { ...(init?.headers ?? {}) };
        // The app's request signing (utils/node-request-signing.ts): every GET to the community, signed with the phone's key.
        if (method === 'GET' && me && !Object.keys(headers).some(h => /signature/i.test(h))) {
            Object.assign(headers, await buildSignedHeaders('GET', href, '', me.privateKey, me.publicKey));
        }
        // A request that carries the app's own If-None-Match goes as it is, and its 304 comes back as a 304, as OkHttp does
        // with a conditional the app set itself; otherwise the cache adds the tag it stored for the URL.
        const appTag = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-none-match')?.[1];
        const cached = method === 'GET' && !appTag ? httpCache.get(href) : undefined;
        if (cached) headers['If-None-Match'] = cached.etag;
        const { signal: _drop, ...rest } = init ?? {};
        const res = await realFetch(href, { ...rest, method, headers });
        const bodyCopy = res.status === 200 && href.includes('/api/marketplace/posts?') ? await res.clone().text() : null;

        const path = href.slice(URL_BASE.length);
        if (path.startsWith('/api/marketplace/posts?')) bodies.push({ path, status: res.status, etag: res.headers.get('etag'), body: res.status === 200 ? await res.clone().text() : null });
        if (res.status === 304 && cached) {
            sent.push({ method, url: path, status: 200, revalidated: true });
            // The stored answer, with the 304's headers over the stored ones (the epoch among them), as a platform cache does.
            const merged = new Headers(cached.headers);
            for (const [k, v] of res.headers.entries()) merged.set(k, v);
            return new Response(cached.body, { status: 200, headers: merged });
        }
        // A posts read's answer: which fields it carried (the set once a read names it on the last page only).
        const keys = res.status === 200 && path.startsWith('/api/marketplace/posts?')
            ? (() => { const b = JSON.parse(String(Buffer.from(bodyCopy ?? ''))); return b && !Array.isArray(b) ? Object.keys(b).sort() : []; })() : undefined;
        sent.push({ method, url: path, status: res.status, revalidated: false, keys, ...(appTag ? { ifNoneMatch: appTag } : {}) });
        const etag = res.headers.get('etag');
        if (method === 'GET' && res.status === 200 && etag) {
            const body = await res.clone().text();
            httpCache.set(href, { etag, body, headers: [...res.headers.entries()] });
        }
        return res;
    }) as typeof fetch;

    // The world.
    await control('limiters');
    me = await draftIdentity('Pe');
    mem.me = me;
    await control('join', { key: me.publicKey, callsign: 'Pe', area: BYRON });
    for (let i = 0; i < 6; i++) {
        const key = randomBytes(32).toString('hex');
        authors.push(key);
        await control('join', { key, callsign: `Author ${i}` });
    }
    near = Array.from({ length: 520 }, (_, i) => ({ id: `near-${String(i).padStart(3, '0')}`, ...at(BYRON, 1 + (i * 97) % 99, (i * 137) % 360) }));
    const london = Array.from({ length: 30 }, (_, i) => ({ id: `ldn-${String(i).padStart(2, '0')}`, ...at(LONDON, 1 + i * 2, i * 12) }));
    // Listed a day ago, so a delta carries only what changes from here on.
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    await control('listings', { rows: [...near, ...london].map((p, i) => ({ ...p, author: authors[i % authors.length], at: dayAgo })) });
    await control('listings', { rows: [{ id: 'mine-ldn', author: me.publicKey, at: dayAgo, ...at(LONDON, 3, 45) }, { id: 'tied-perth', author: authors[0], at: dayAgo, ...PERTH }] });
    mem.async.set('beanpool_anchor_url', URL_BASE);
    resetSyncFingerprints();
    await getDb();
    // On the phone: a conversation about the Perth listing, and its row (opened from the chat, by id).
    sql.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, lat, lng, status, active, created_at, updated_at)
                 VALUES ('tied-perth', 'offer', 'food', 'Listing tied-perth', '', ?, ?, ?, 'active', 1, ?, ?)`)
        .run(authors[0], PERTH.lat, PERTH.lng, new Date().toISOString(), new Date().toISOString());
    sql.prepare(`INSERT INTO conversations (id, type, post_id, created_by) VALUES ('conv-perth', 'dm', 'tied-perth', ?)`).run(me.publicKey);
    expect(await fetchNodeProfile(URL_BASE)).toMatchObject({ features: { nearbyListings: { radiusKm: 250, max: 500 } } });
}, START_MS);

afterAll(async () => {
    globalThis.fetch = realFetch;
    if (node && node.exitCode === null) {
        node.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { node.kill('SIGKILL'); resolve(); }, 5_000);
            node.on('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    expect(elsewhere).toEqual([]);
}, START_MS);

const tagHeld = () => (sql.prepare("SELECT v FROM nearby_held WHERE k = 'tag'").get() as { v: string } | undefined)?.v ?? null;
const latOnPhone = (id: string) => (sql.prepare('SELECT lat FROM posts WHERE id = ?').get(id) as { lat: number } | undefined)?.lat ?? null;
const dropCursor = () => { for (const k of [...mem.async.keys()].filter(x => x.startsWith('pillar_sync_') && x.endsWith('_last-sync'))) mem.async.delete(k); };
const nearbyBodies = () => bodies.filter(b => b.path.includes('nearby=1'));

describe('the nearby 304 only over what the phone holds (review of #1805, findings 1 and 2; a real global node)', () => {
    it('a listing edited while the phone pages through a read: the pages\' tags differ, the read keeps none, and the next delta brings the edit', async () => {
        let editedId = '';
        let newLat = 0;
        // Between page 1 and page 2: a listing page 1 carried is moved, so it sorts above every key this read hands out.
        beforeFetch = async (path) => {
            if (editedId || !path.includes('pageAfter=') || !path.includes('nearby=1')) return;
            const rows = JSON.parse(nearbyBodies()[0].body!).posts as any[];
            const row = rows.find(r => r.authorPublicKey !== me.publicKey && near.some(n => n.id === r.id));
            const n = near.find(x => x.id === row.id)!;
            editedId = row.id;
            newLat = n.lat + 0.0007;
            await control('edit', { post: editedId, lat: newLat, lng: n.lng });
        };
        bodies.length = 0;
        await sync();
        beforeFetch = null;
        expect(postsReads()).toHaveLength(3);
        const tags = nearbyBodies().map(b => b.etag);
        expect(tags[0]).not.toBe(tags[2]);
        // No page of this read carried the edit, and its last page's tag describes it: the read keeps no tag.
        expect(latOnPhone(editedId)).not.toBeCloseTo(newLat, 6);
        expect(tagHeld()).toBeNull();
        near = near.map(p => (p.id === editedId ? { ...p, lat: newLat } : p));
        // The next delta goes without a tag: a 200 from the read's start, with the edit.
        await control('limiters');
        await sync();
        expect(postsReads().map(r => `${r.status}${r.ifNoneMatch ? ' (tag)' : ''}`)).toEqual(['200']);
        expect(latOnPhone(editedId)).toBeCloseTo(newLat, 6);
        // That read landed whole on one page: its tag is kept, and with nothing changed the cycle after is a 304.
        expect(tagHeld()).toMatch(/^W\/"near-/);
        await control('limiters');
        await sync();
        expect(postsReads().map(r => `${r.status}${r.ifNoneMatch ? ' (tag)' : ''}`)).toEqual(['304 (tag)']);
        expect(sorted(heldIds())).toEqual(sorted([...expectedSet(BYRON, near, ['mine-ldn']), 'tied-perth']));
    }, START_MS);

    it('an off-board author\'s listing the member is tied to by a chat, with their cancelled deal on it: the deal heal\'s write is never confirmed with a 304', async () => {
        const K = randomBytes(32).toString('hex');
        await control('join', { key: K, callsign: 'Away' });
        const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
        await control('listings', { rows: [{ id: 'held-off', author: K, at: dayAgo, ...at(BYRON, 2, 10) }] });
        await control('sql', { q: "INSERT INTO conversations (id, type, post_id, created_by) VALUES ('conv-off', 'dm', 'held-off', ?)", p: [me.publicKey] });
        await control('sql', { q: "INSERT INTO conversation_participants (conversation_id, public_key) VALUES ('conv-off', ?), ('conv-off', ?)", p: [me.publicKey, K] });
        await control('deal', { post: 'held-off', buyer: me.publicKey, seller: K, status: 'cancelled', at: dayAgo });
        await control('holiday', { key: K });
        const { getPosts } = await import('../db');
        const onMarket = async () => (await getPosts()).some((p: any) => p.id === 'held-off');
        const log: { reads: string; status: string | null; onMarket: boolean }[] = [];
        for (let i = 1; i <= 4; i++) {
            if (i === 3) resetSyncFingerprints(); // the app started again: every table is applied again, the deal heal too
            await control('limiters');
            await sync();
            log.push({
                reads: postsReads().map(r => `${r.status}${r.ifNoneMatch ? ' (tag)' : ''}`).join(','),
                status: (sql.prepare("SELECT status FROM posts WHERE id = 'held-off'").get() as { status: string } | undefined)?.status ?? null,
                onMarket: await onMarket(),
            });
        }
        // Each cycle after one that applied the deals (cycle 1; the cold start, cycle 3) is a 200 that sends it paused again.
        expect(log[1]).toMatchObject({ reads: '200', status: 'paused', onMarket: false });
        expect(log[3]).toMatchObject({ reads: '200', status: 'paused', onMarket: false });
    }, START_MS);

    it('a pushed listing outside the set (an author the member blocked) displaces one in it: the next cycle is a 200 that puts the phone back on the set', async () => {
        await control('limiters');
        await sync();
        await control('limiters');
        await sync();
        // The phone holds a read's tag (the cycles here are 200s while the listing above is sent again: the node's side).
        expect(tagHeld()).toMatch(/^W\/"near-/);
        const B = randomBytes(32).toString('hex');
        await control('join', { key: B, callsign: 'Blocked' });
        await control('sql', { q: 'INSERT INTO member_blocks (owner_pubkey, blocked_pubkey, created_at, updated_at) VALUES (?, ?, ?, ?)', p: [me.publicKey, B, Date.now(), Date.now()] });
        const now = new Date().toISOString();
        await control('listings', { rows: [{ id: 'blocked-near', author: B, at: now, lat: BYRON.lat + 0.001, lng: BYRON.lng }] });
        const want = sorted([...expectedSet(BYRON, near, ['mine-ldn']), 'tied-perth']);
        const post = { id: 'blocked-near', type: 'offer', category: 'food', title: 'Listing blocked-near', description: '', credits: 5, authorPublicKey: B,
            lat: BYRON.lat + 0.001, lng: BYRON.lng, status: 'active', active: true, createdAt: now, updatedAt: now };
        expect(await applyLivePostChange({ kind: 'upsert', post: post as any, created: true }, { anchorUrl: URL_BASE, selfPubkey: me.publicKey })).toBe(true);
        // The push is kept, the set's farthest went for it, and the phone's tag is forgotten with that write.
        expect(heldIds().has('blocked-near')).toBe(true);
        expect(want.filter(id => !heldIds().has(id))).toHaveLength(1);
        expect(tagHeld()).toBeNull();
        await control('limiters');
        await sync();
        expect(postsReads().map(r => `${r.status}${r.ifNoneMatch ? ' (tag)' : ''}`)).toEqual(['200']);
        expect(heldIds().has('blocked-near')).toBe(false);
        expect(want.filter(id => !heldIds().has(id))).toEqual([]);
    }, START_MS);

    it('a push that lands while a read pages: the read stores no tag, and the cycle after puts the phone back on the set', async () => {
        const B = randomBytes(32).toString('hex');
        await control('join', { key: B, callsign: 'Blocked too' });
        await control('sql', { q: 'INSERT INTO member_blocks (owner_pubkey, blocked_pubkey, created_at, updated_at) VALUES (?, ?, ?, ?)', p: [me.publicKey, B, Date.now(), Date.now()] });
        const now = new Date().toISOString();
        await control('listings', { rows: [{ id: 'blocked-mid', author: B, at: now, lat: BYRON.lat - 0.001, lng: BYRON.lng }] });
        const post = { id: 'blocked-mid', type: 'offer', category: 'food', title: 'Listing blocked-mid', description: '', credits: 5, authorPublicKey: B,
            lat: BYRON.lat - 0.001, lng: BYRON.lng, status: 'active', active: true, createdAt: now, updatedAt: now };
        let pushed = false;
        beforeFetch = async (path) => {
            if (pushed || !path.includes('pageAfter=') || !path.includes('nearby=1')) return;
            pushed = true;
            expect(await applyLivePostChange({ kind: 'upsert', post: post as any, created: true }, { anchorUrl: URL_BASE, selfPubkey: me.publicKey })).toBe(true);
        };
        // A whole read (the cursor gone), in three pages; the push lands before page 2. Nothing in the set changes.
        dropCursor();
        bodies.length = 0;
        await control('limiters');
        await sync();
        beforeFetch = null;
        expect(pushed).toBe(true);
        expect(new Set(nearbyBodies().map(b => b.etag)).size).toBe(1);
        // The pushed listing is kept as newer than the set (fresh), so the tag of this read doesn't describe what it holds.
        expect(heldIds().has('blocked-mid')).toBe(true);
        expect(tagHeld()).toBeNull();
        await control('limiters');
        await sync();
        expect(postsReads().map(r => `${r.status}${r.ifNoneMatch ? ' (tag)' : ''}`)).toEqual(['200']);
        expect(heldIds().has('blocked-mid')).toBe(false);
        expect(sorted([...expectedSet(BYRON, near, ['mine-ldn']), 'tied-perth']).filter(id => !heldIds().has(id))).toEqual([]);
    }, START_MS);
});
