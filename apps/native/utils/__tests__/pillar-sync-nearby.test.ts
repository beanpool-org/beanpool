/**
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
let sent: { method: string; url: string; status: number; revalidated: boolean }[] = [];
const elsewhere: string[] = [];
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

async function sync() {
    sent = [];
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        const r = await performSync();
        expect(r.success, r.errorMessage).toBe(true);
        return r;
    } finally {
        (Module as any)._load = nodeLoad;
    }
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
        const cached = method === 'GET' ? httpCache.get(href) : undefined;
        if (cached) headers['If-None-Match'] = cached.etag;
        const { signal: _drop, ...rest } = init ?? {};
        const res = await realFetch(href, { ...rest, method, headers });

        const path = href.slice(URL_BASE.length);
        if (res.status === 304 && cached) {
            sent.push({ method, url: path, status: 200, revalidated: true });
            // The stored answer, with the 304's headers over the stored ones (the epoch among them), as a platform cache does.
            const merged = new Headers(cached.headers);
            for (const [k, v] of res.headers.entries()) merged.set(k, v);
            return new Response(cached.body, { status: 200, headers: merged });
        }
        sent.push({ method, url: path, status: res.status, revalidated: false });
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

describe('the phone syncs the listings near its member (a real global node)', () => {
    it('the first read by area is whole, in three pages: the nearest 500, the member\'s own far away, and the tied one stays', async () => {
        await sync();
        const reads = postsReads();
        expect(reads).toHaveLength(3);
        expect(reads.every(r => r.url.includes('nearby=1') && r.url.includes('limit=200') && !r.url.includes('updatedAfter'))).toBe(true);
        expect(reads[0].url).toContain('paged=1');
        expect(reads.slice(1).every(r => r.url.includes('pageAfter='))).toBe(true);
        // The area was asked of the node once (the copy is new) and is kept per community.
        expect(sent.filter(r => r.url === '/api/community/me')).toHaveLength(1);
        expect(await readNearbyAreaCopy(URL_BASE, me.publicKey)).toMatchObject({ area: BYRON, whole: false });
        const want = expectedSet(BYRON, near, ['mine-ldn']);
        expect(want.size).toBe(501);
        expect(sorted(heldIds())).toEqual(sorted([...want, 'tied-perth']));
        expect(idReads()).toEqual([]);
        // The author's name rides on the row (author_callsign), for a listing whose author the directory copy lacks.
        sql.exec('DELETE FROM members');
        const row = sql.prepare("SELECT author_callsign FROM posts WHERE id = 'near-000'").get() as { author_callsign: string };
        expect(row.author_callsign).toMatch(/^Author \d$/);
        const { getPosts } = await import('../db');
        const shown = (await getPosts()).find((p: any) => p.id === 'near-000');
        expect(shown?.author_callsign).toBe(row.author_callsign);
    }, START_MS);

    it('a delta: what leaves the set goes, what comes in without changing is fetched by ids=, own and tied stay', async () => {
        const before = expectedSet(BYRON, near, ['mine-ldn']);
        const inner = near.filter(p => before.has(p.id)).slice(0, 2);
        // One moves to Perth, one is taken off: both leave the set, and the next two nearest come into it unchanged.
        await control('edit', { post: inner[0].id, ...PERTH });
        await control('edit', { post: inner[1].id, status: 'cancelled' });
        const left = near.filter(p => p.id !== inner[0].id && p.id !== inner[1].id);
        const after = expectedSet(BYRON, left, ['mine-ldn']);
        const cameIn = [...after].filter(id => !before.has(id));
        expect(cameIn).toHaveLength(2);

        await sync();
        // A delta (from the cursor less the phone's 5 minutes for clock drift: every listing here changed within them, so
        // it pages as the whole set did), every page by area.
        expect(postsReads().length).toBeGreaterThanOrEqual(1);
        expect(postsReads().every(r => /nearby=1/.test(r.url) && /updatedAfter=/.test(r.url))).toBe(true);
        expect(idReads(), JSON.stringify(sent.map(r => `${r.status} ${r.url.slice(0, 120)}`))).toHaveLength(1);
        expect(sorted(new URL(`${URL_BASE}${idReads()[0].url}`).searchParams.get('ids')!.split(','))).toEqual(sorted(cameIn));
        expect(sorted(heldIds())).toEqual(sorted([...after, 'tied-perth']));
        near = left;
    }, START_MS);

    it('a push beyond the nearest 500 is pruned; a nearer one stays and the farthest goes', async () => {
        const self = me.publicKey;
        const farPost = { id: 'push-far', type: 'offer', category: 'food', title: 'Far', description: '', credits: 0, authorPublicKey: authors[1],
            lat: PERTH.lat + 0.5, lng: PERTH.lng, status: 'active', active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        expect(await applyLivePostChange({ kind: 'upsert', post: farPost as any, created: true }, { anchorUrl: URL_BASE, selfPubkey: self })).toBe(true);
        expect(heldIds().has('push-far'), JSON.stringify({ held: heldIds().size, copy: await readNearbyAreaCopy(URL_BASE, self) })).toBe(false);
        expect(heldIds().has('tied-perth')).toBe(true);

        const held = expectedSet(BYRON, near, []);
        const farthest = near.filter(p => held.has(p.id))
            .sort((a, b) => nearbyKm(BYRON.lat, BYRON.lng, b.lat, b.lng) - nearbyKm(BYRON.lat, BYRON.lng, a.lat, a.lng))[0];
        const nearPost = { ...farPost, id: 'push-near', lat: BYRON.lat, lng: BYRON.lng };
        expect(await applyLivePostChange({ kind: 'upsert', post: nearPost as any, created: true }, { anchorUrl: URL_BASE, selfPubkey: self })).toBe(true);
        const now = heldIds();
        expect(now.has('push-near')).toBe(true);
        expect(now.has(farthest.id)).toBe(false);
        expect(now.has('mine-ldn') && now.has('tied-perth')).toBe(true);
        expect(now.size).toBe(500 + 2);
    }, START_MS);

    it('the member moves to London: the next read is whole, and the phone holds London\'s listings', async () => {
        const moved = await writeMemberArea(URL_BASE, me, LONDON);
        expect(moved).toMatchObject({ ok: true, area: { lat: 51.5, lng: -0.1 } });
        expect(await readNearbyAreaCopy(URL_BASE, me.publicKey)).toMatchObject({ area: { lat: 51.5, lng: -0.1 }, whole: true });

        await sync();
        expect(postsReads().length).toBeGreaterThanOrEqual(1);
        expect(postsReads().every(r => !r.url.includes('updatedAfter'))).toBe(true);
        const ldn = Array.from({ length: 30 }, (_, i) => `ldn-${String(i).padStart(2, '0')}`);
        expect(sorted(heldIds())).toEqual(sorted([...ldn, 'mine-ldn', 'tied-perth']));
        expect((await readNearbyAreaCopy(URL_BASE, me.publicKey))?.whole).toBe(false);
        expect(await noAreaLineHere(me.publicKey)).toBe(false);
    }, START_MS);

    it('a member with no area gets the newest listings worldwide, and the Market\'s line says so', async () => {
        expect(await writeMemberArea(URL_BASE, me, null)).toMatchObject({ ok: true, area: null });
        await sync();
        expect(postsReads().every(r => !r.url.includes('updatedAfter'))).toBe(true);
        const held = heldIds();
        expect(held.has('mine-ldn') && held.has('tied-perth')).toBe(true);
        expect(held.size).toBeLessThanOrEqual(100 + 2);
        expect(held.size).toBeGreaterThan(50);
        expect(await noAreaLineHere(me.publicKey)).toBe(true);
        // Back near Byron for what follows.
        expect(await writeMemberArea(URL_BASE, me, BYRON)).toMatchObject({ ok: true });
        await sync();
        expect(await noAreaLineHere(me.publicKey)).toBe(false);
    }, START_MS);

    it('a take-over: the whole read replaces the cache by the set (held − set), never the member\'s own or tied', async () => {
        const now = new Date().toISOString();
        // What the old main server wrote after its standby's last copy: a listing nearby, and one of the member's own.
        for (const [id, author] of [['ghost', authors[2]], ['ghost-own', me.publicKey]] as const) {
            sql.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, lat, lng, status, active, created_at, updated_at)
                         VALUES (?, 'offer', 'food', ?, '', ?, ?, ?, 'active', 1, ?, ?)`).run(id, id, author, BYRON.lat, BYRON.lng, now, now);
        }
        const epochKey = [...mem.async.keys()].find(k => k.endsWith('_identity-epoch'))!;
        const before = mem.async.get(epochKey);
        const epoch = await control<number>('epoch');
        expect(String(epoch)).not.toBe(before);

        await sync();
        // The delta that found the new epoch, then the whole read.
        expect(postsReads().some(r => !r.url.includes('updatedAfter'))).toBe(true);
        const held = heldIds();
        expect(held.has('ghost')).toBe(false);
        expect(held.has('ghost-own') && held.has('mine-ldn') && held.has('tied-perth')).toBe(true);
        expect(sorted([...held].filter(id => id.startsWith('near-')))).toEqual(sorted([...expectedSet(BYRON, near, [])]));
        expect(mem.async.get(epochKey), JSON.stringify(sent.map(r => `${r.status}${r.revalidated ? ' (304)' : ''} ${r.url.slice(0, 110)}`))).toBe(String(epoch));
    }, START_MS);

    it('a deal the phone holds no row for (a restored phone; one older than the 50 it reads): kept past the cap, through pushes', async () => {
        // The near part holds 500 others, so a far listing the phone can't tie itself is the farthest "other" and goes first.
        expect([...heldIds()].filter(id => id.startsWith('near-')).length).toBe(500);
        const now = new Date().toISOString();
        const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
        const MELBOURNE = { lat: -37.81, lng: 144.96 };
        await control('listings', { rows: [{ id: 'deal-perth', author: authors[1], at: now, ...at(PERTH, 5, 90) }, { id: 'deal-old-melb', author: authors[2], at: sixDaysAgo, ...MELBOURNE }] });
        await control('deal', { post: 'deal-perth', buyer: me.publicKey, seller: authors[1], status: 'requested' });
        await control('deal', { post: 'deal-old-melb', buyer: me.publicKey, seller: authors[2], status: 'pending', at: sixDaysAgo });
        // The phone holds neither deal: its deal rows are read after the listings in a cycle, and only its newest 50.
        sql.exec('DELETE FROM marketplace_transactions');

        await sync();
        const held = heldIds();
        expect(held.has('deal-perth') && held.has('deal-old-melb'), JSON.stringify(idReads().map(r => r.url.slice(0, 120)))).toBe(true);
        expect([...held].filter(id => id.startsWith('near-')).length).toBe(500);

        // Its deal rows gone again (the 51st newest, or a restored phone), a near push: the node's ties still hold.
        sql.exec('DELETE FROM marketplace_transactions');
        const nearPost = { id: 'push-near-2', type: 'offer', category: 'food', title: 'Near', description: '', credits: 0, authorPublicKey: authors[3],
            lat: BYRON.lat + 0.01, lng: BYRON.lng, status: 'active', active: true, createdAt: now, updatedAt: now };
        expect(await applyLivePostChange({ kind: 'upsert', post: nearPost as any, created: true }, { anchorUrl: URL_BASE, selfPubkey: me.publicKey })).toBe(true);
        const afterPush = heldIds();
        expect(afterPush.has('push-near-2') && afterPush.has('deal-perth') && afterPush.has('deal-old-melb') && afterPush.has('tied-perth')).toBe(true);

        // And the next cycle asks for neither by id: nothing it holds is dropped and fetched again.
        sql.exec('DELETE FROM marketplace_transactions');
        await sync();
        expect(idReads().filter(r => /deal-/.test(r.url))).toEqual([]);
        expect(heldIds().has('deal-perth') && heldIds().has('deal-old-melb')).toBe(true);
    }, START_MS);

    it('a node with the switch off: today\'s request, byte for byte, and no area read', async () => {
        await control('profileSwitch', { name: 'nearbyListings', value: 'false' });
        expect((await fetchNodeProfile(URL_BASE))?.features.nearbyListings).toBeUndefined();
        await sync();
        const reads = postsReads();
        expect(reads.length).toBeGreaterThanOrEqual(1);
        expect(reads[0].url).toMatch(/^\/api\/marketplace\/posts\?limit=1000&sync=true&types=[^&]+&updatedAfter=[^&]+&paged=1$/);
        expect(reads.every(r => !r.url.includes('nearby'))).toBe(true);
        expect(sent.filter(r => r.url === '/api/community/me')).toEqual([]);
        expect(idReads()).toEqual([]);
        expect(mem.async.has(nearbyAreaKeyOf(URL_BASE))).toBe(true);
    }, START_MS);
});
