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

import { describe, it, expect, vi, beforeAll, afterAll, onTestFinished } from 'vitest';
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
import { nearbySetHash } from '../nearby-hash';
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
/** A fault: the body a by-area read answers, rewritten (null leaves it). The node never sends such a body itself. */
let tamper: ((path: string, body: string) => string | null) | null = null;
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
        const tampered = tamper && res.status === 200 ? tamper(path, await res.clone().text()) : null;
        if (tampered !== null) return new Response(tampered, { status: 200, headers: res.headers });
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
        // The set once a read (REPORT-geosync-load-B, item 1): the phone says setOnce=1, and the node names the set on the
        // last page only, which is the one the phone reconciles with.
        expect(reads.every(r => r.url.includes('setOnce=1'))).toBe(true);
        expect(reads.map(r => r.keys?.join('+'))).toEqual(['posts', 'posts', 'posts+set+setHash+tied']);
        // The area was asked of the node once (the copy is new) and is kept per community.
        expect(sent.filter(r => r.url === '/api/community/me')).toHaveLength(1);
        expect(await readNearbyAreaCopy(URL_BASE, me.publicKey)).toMatchObject({ area: BYRON, whole: false });
        const want = expectedSet(BYRON, near, ['mine-ldn']);
        expect(want.size).toBe(501);
        expect(sorted(heldIds())).toEqual(sorted([...want, 'tied-perth']));
        expect(idReads()).toEqual([]);
        // The author's name rides on the row (carried_callsign), for a listing whose author the directory copy lacks.
        sql.exec('DELETE FROM members');
        const row = sql.prepare("SELECT carried_callsign FROM posts WHERE id = 'near-000'").get() as { carried_callsign: string };
        expect(row.carried_callsign).toMatch(/^Author \d$/);
        const { getPosts } = await import('../db');
        const shown = (await getPosts()).find((p: any) => p.id === 'near-000');
        expect(shown?.author_callsign).toBe(row.carried_callsign);
    }, START_MS);

    it('nothing in the set changed: the phone sends the tag of its last read with its delta, and gets the 304', async () => {
        // Every request here comes from one address: the node's limiters cleared before and after, as the door suites do.
        await control('limiters');
        const tag = (sql.prepare("SELECT v FROM nearby_held WHERE k = 'tag'").get() as { v: string } | undefined)?.v;
        expect(tag).toMatch(/^W\/"near-/);
        const cursorKey = [...mem.async.keys()].find(k => k.startsWith('pillar_sync_') && k.endsWith('_last-sync'))!;
        const cursor = mem.async.get(cursorKey);
        const before = heldIds();
        await sync();
        let reads = postsReads();
        // A delta (from the cursor less 5 minutes, a URL this phone never asked), its first page carrying the tag: 304.
        expect(reads).toHaveLength(1);
        expect(reads[0].url).toContain('updatedAfter=');
        expect(reads[0]).toMatchObject({ status: 304, revalidated: false, ifNoneMatch: tag });
        expect(mem.async.get(cursorKey)).toBe(cursor);
        expect(sorted(heldIds())).toEqual(sorted(before));
        // A listing 300 km+ away changes: still nothing in the set, still 304.
        await control('edit', { post: 'ldn-05', lat: LONDON.lat + 0.01, lng: LONDON.lng });
        await sync();
        reads = postsReads();
        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject({ status: 304, ifNoneMatch: tag });
        await control('limiters');
    }, START_MS);

    it('a listing in the set edited: a 200 with it, `setUnchanged` instead of the set, and the phone keeps what it holds', async () => {
        const held = sql.prepare("SELECT k, v FROM nearby_held").all() as { k: string; v: string }[];
        const hash = held.find(r => r.k === 'hash')?.v;
        const tag = held.find(r => r.k === 'tag')?.v;
        const storedSet = JSON.parse(held.find(r => r.k === 'set')?.v ?? '[]') as string[];
        expect(hash).toMatch(/^[0-9a-f]{24}$/);
        expect(sorted(storedSet)).toEqual(sorted(expectedSet(BYRON, near, ['mine-ldn'])));
        const before = heldIds();
        // The nearest listing moves 10 m: still in the set, the same ids, a new row.
        const nearest = [...near].sort((a, b) => nearbyKm(BYRON.lat, BYRON.lng, a.lat, a.lng) - nearbyKm(BYRON.lat, BYRON.lng, b.lat, b.lng))[0];
        await control('edit', { post: nearest.id, lat: nearest.lat + 0.0001, lng: nearest.lng });
        await sync();
        const reads = postsReads();
        expect(reads).toHaveLength(1);
        expect(reads[0].url).toContain(`setHash=${hash}`);
        expect(reads[0]).toMatchObject({ status: 200, ifNoneMatch: tag, keys: ['posts', 'setUnchanged'] });
        expect(idReads()).toEqual([]);
        expect(sorted(heldIds())).toEqual(sorted(before));
        expect((sql.prepare('SELECT lat FROM posts WHERE id = ?').get(nearest.id) as { lat: number }).lat).toBeCloseTo(nearest.lat + 0.0001, 6);
        expect(sql.prepare("SELECT v FROM nearby_held WHERE k = 'hash'").get()).toEqual({ v: hash });
        // The read landed: the phone holds its tag now, and the next cycle with nothing changed is a 304 again.
        const newTag = (sql.prepare("SELECT v FROM nearby_held WHERE k = 'tag'").get() as { v: string } | undefined)?.v;
        expect(newTag && newTag !== tag).toBe(true);
        near = near.map(p => (p.id === nearest.id ? { ...p, lat: p.lat + 0.0001 } : p));
        await sync();
        expect(postsReads()[0]).toMatchObject({ status: 304, ifNoneMatch: newTag });
        await control('limiters');
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
        // The node's world moved whatever this test finds: the tests after it start from it.
        near = left;

        await sync();
        // A delta (from the cursor less the phone's 5 minutes for clock drift: every listing here changed within them, so
        // it pages as the whole set did), every page by area.
        expect(postsReads().length).toBeGreaterThanOrEqual(1);
        expect(postsReads().every(r => /nearby=1/.test(r.url) && /updatedAfter=/.test(r.url))).toBe(true);
        expect(idReads(), JSON.stringify(sent.map(r => `${r.status} ${r.url.slice(0, 120)}`))).toHaveLength(1);
        expect(sorted(new URL(`${URL_BASE}${idReads()[0].url}`).searchParams.get('ids')!.split(','))).toEqual(sorted(cameIn));
        expect(sorted(heldIds())).toEqual(sorted([...after, 'tied-perth']));
        // The set moved: the phone said setDiff=1 beside the hash it held, and the node named what changed (DESIGN-nearby-set-
        // diff-fable §2), not the set; the phone applied it, checked it against the new hash, and holds the new set with it.
        const last = postsReads()[postsReads().length - 1];
        expect(last.url).toMatch(/setHash=[0-9a-f]{24}&setDiff=1/);
        expect(last.keys).toEqual(['posts', 'setAdd', 'setDrop', 'setHash']);
        const held = Object.fromEntries((sql.prepare('SELECT k, v FROM nearby_held').all() as { k: string; v: string }[]).map(r => [r.k, r.v]));
        expect(sorted(JSON.parse(held.set))).toEqual(sorted(after));
        expect(JSON.parse(held.tied)).toEqual(['mine-ldn']);
        expect(held.hash).toBe(nearbySetHash([...after], ['mine-ldn']));
    }, START_MS);

    it('a diff that doesn\'t check out (one setAdd id flipped): nothing of it written, nearby_held forgotten, the cursor kept; the next read is named the set whole', async () => {
        const cursorKey = [...mem.async.keys()].find(k => k.startsWith('pillar_sync_') && k.endsWith('_last-sync'))!;
        const cursor = mem.async.get(cursorKey);
        const before = expectedSet(BYRON, near, ['mine-ldn']);
        const heldBefore = heldIds();
        const gone = near.filter(p => before.has(p.id))[5];
        await control('edit', { post: gone.id, status: 'cancelled' });
        const left = near.filter(p => p.id !== gone.id);
        const after = expectedSet(BYRON, left, ['mine-ldn']);
        // The node's world moved whatever this test finds: the tests after it start from it.
        near = left;
        tamper = (path, body) => {
            if (!path.includes('nearby=1')) return null;
            const b = JSON.parse(body);
            return Array.isArray(b.setAdd) && b.setAdd.length > 0 ? JSON.stringify({ ...b, setAdd: [`${b.setAdd[0]}-flipped`, ...b.setAdd.slice(1)] }) : null;
        };
        await syncAllowingFailure();
        tamper = null;
        expect(postsReads()[postsReads().length - 1].keys).toEqual(['posts', 'setAdd', 'setDrop', 'setHash']);
        expect(idReads()).toEqual([]);
        expect(sorted(heldIds())).toEqual(sorted(heldBefore));
        expect(sql.prepare('SELECT k FROM nearby_held').all()).toEqual([]);
        expect(mem.async.get(cursorKey)).toBe(cursor);
        // The next cycle sends no hash, and is named the set whole.
        await sync();
        const reads = postsReads();
        expect(reads.every(r => !r.url.includes('setHash=') && !r.url.includes('setDiff='))).toBe(true);
        expect(reads[reads.length - 1].keys).toEqual(['posts', 'set', 'setHash', 'tied']);
        expect(sorted([...heldIds()].filter(id => id !== 'tied-perth'))).toEqual(sorted(after));
        const held = Object.fromEntries((sql.prepare('SELECT k, v FROM nearby_held').all() as { k: string; v: string }[]).map(r => [r.k, r.v]));
        expect(sorted(JSON.parse(held.set))).toEqual(sorted(after));
        expect(held.hash).toBe(nearbySetHash([...after], JSON.parse(held.tied)));
    }, START_MS);

    it('a diff of more than one page that doesn\'t check out (its last page\'s setAdd flipped): nearby_held forgotten, the cursor kept; the next read is named the set whole', async () => {
        // The review of #1810, finding 1 (its probe R2): the test above reads a diff that fits on one page, so it pins only
        // the one-page forget. Here 250 listings of the set change (a delta of two pages) and one is taken off (the set moves).
        const cursorKey = [...mem.async.keys()].find(k => k.startsWith('pillar_sync_') && k.endsWith('_last-sync'))!;
        const cursor = mem.async.get(cursorKey);
        const before = expectedSet(BYRON, near, ['mine-ldn']);
        const inSet = near.filter(p => before.has(p.id));
        const touched = inSet.slice(0, 250).map(p => p.id);
        const stamp = new Date().toISOString();
        for (let i = 0; i < touched.length; i += 100) {
            const batch = touched.slice(i, i + 100);
            await control('sql', { sql: `UPDATE posts SET updated_at = ? WHERE id IN (${batch.map(() => '?').join(',')})`, params: [stamp, ...batch] });
        }
        // The 250 back to a day ago when this test ends (passed or not), so a delta of the tests after it (from the cursor
        // less 5 minutes) fits on a page.
        onTestFinished(async () => {
            tamper = null;
            const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
            for (let i = 0; i < touched.length; i += 100) {
                const batch = touched.slice(i, i + 100);
                await control('sql', { sql: `UPDATE posts SET updated_at = ? WHERE id IN (${batch.map(() => '?').join(',')})`, params: [dayAgo, ...batch] });
            }
            await control('limiters');
        });
        const gone = inSet[60];
        await control('edit', { post: gone.id, status: 'cancelled' });
        const left = near.filter(p => p.id !== gone.id);
        const after = expectedSet(BYRON, left, ['mine-ldn']);
        // The node's world moved whatever this test finds: the tests after it start from it.
        near = left;
        let flipped = 0;
        tamper = (path, body) => {
            if (!path.includes('nearby=1') || !path.includes('pageAfter=')) return null;
            const b = JSON.parse(body);
            if (!Array.isArray(b.setAdd) || b.setAdd.length === 0) return null;
            flipped++;
            return JSON.stringify({ ...b, setAdd: [`${b.setAdd[0]}-flipped`, ...b.setAdd.slice(1)] });
        };
        await control('limiters');
        await syncAllowingFailure();
        tamper = null;
        const reads = postsReads();
        expect(reads.length).toBeGreaterThanOrEqual(2);
        expect(reads[reads.length - 1].keys).toEqual(['posts', 'setAdd', 'setDrop', 'setHash']);
        expect(flipped).toBe(1);
        // Set, hash, `tied` and tag all gone, and the cursor where it was: the phone never sends the hash it can't stand behind.
        expect(sql.prepare('SELECT k FROM nearby_held').all()).toEqual([]);
        expect(mem.async.get(cursorKey)).toBe(cursor);
        await control('limiters');
        await sync();
        const next = postsReads();
        expect(next.every(r => !r.url.includes('setHash=') && !r.url.includes('setDiff='))).toBe(true);
        expect(next[next.length - 1].keys).toEqual(['posts', 'set', 'setHash', 'tied']);
        expect(sorted([...heldIds()].filter(id => id !== 'tied-perth'))).toEqual(sorted(after));
        const held = Object.fromEntries((sql.prepare('SELECT k, v FROM nearby_held').all() as { k: string; v: string }[]).map(r => [r.k, r.v]));
        expect(sorted(JSON.parse(held.set))).toEqual(sorted(after));
        expect(JSON.parse(held.tied)).toEqual(['mine-ldn']);
        expect(held.hash).toBe(nearbySetHash([...after], ['mine-ldn']));
    }, START_MS);

    it('a phone upgraded from #1805 (its set and hash held, no `tied`): the next changed read sends no hash and is named the set whole; the one after is a diff', async () => {
        // The review of #1810, its probe R8: a held set without its `tied` can't be checked against a diff, so it is never
        // offered for one.
        await control('limiters');
        await sync();
        sql.prepare("DELETE FROM nearby_held WHERE k = 'tied'").run();
        const held = () => Object.fromEntries((sql.prepare('SELECT k, v FROM nearby_held').all() as { k: string; v: string }[]).map(r => [r.k, r.v]));
        const takeOneOff = async (i: number) => {
            const inSet = near.filter(p => expectedSet(BYRON, near, ['mine-ldn']).has(p.id));
            await control('edit', { post: inSet[i].id, status: 'cancelled' });
            near = near.filter(p => p.id !== inSet[i].id);
            return expectedSet(BYRON, near, ['mine-ldn']);
        };
        for (const [step, want] of [['upgraded', ['posts', 'set', 'setHash', 'tied']], ['next', ['posts', 'setAdd', 'setDrop', 'setHash']]] as const) {
            const after = await takeOneOff(step === 'upgraded' ? 170 : 175);
            await control('limiters');
            await sync();
            const reads = postsReads();
            if (step === 'upgraded') expect(reads.every(r => !r.url.includes('setHash=') && !r.url.includes('setDiff='))).toBe(true);
            else expect(reads[reads.length - 1].url).toMatch(/setHash=[0-9a-f]{24}&setDiff=1/);
            expect(reads[reads.length - 1].keys, step).toEqual(want);
            expect(sorted([...heldIds()].filter(id => id !== 'tied-perth')), step).toEqual(sorted(after));
            const h = held();
            expect(sorted(JSON.parse(h.set)), step).toEqual(sorted(after));
            expect(JSON.parse(h.tied), step).toEqual(['mine-ldn']);
            expect(h.hash, step).toBe(nearbySetHash([...after], ['mine-ldn']));
        }
        await control('limiters');
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

    it('a by-area answer that isn\'t the set\'s shape is a failed read: nothing written or dropped, the posts cursor stays', async () => {
        await sync();
        const cursorKey = [...mem.async.keys()].find(k => k.startsWith('pillar_sync_') && k.endsWith('_last-sync'))!;
        const cursor = mem.async.get(cursorKey);
        expect(cursor).toBeTruthy();
        const heldBefore = heldIds();
        // A listing near the member changes on the node; the answer that carries it names a set the phone can't read.
        const edited = near.find(p => heldBefore.has(p.id))!;
        await control('edit', { post: edited.id, lat: edited.lat + 0.001, lng: edited.lng });
        const before = sql.prepare('SELECT lat, updated_at FROM posts WHERE id = ?').get(edited.id) as { lat: number; updated_at: string };
        for (const bad of [
            (b: any) => ({ ...b, set: [...b.set, 7] }), // an id that isn't a string
            (b: any) => ({ ...b, set: undefined, setUnchanged: undefined }), // no set at all, and nothing said of it
            // No set, and the held hash as `setHash`: what a node before setUnchanged sends, cut short. Never "unchanged".
            (b: any) => ({ posts: b.posts, setHash: (sql.prepare("SELECT v FROM nearby_held WHERE k = 'hash'").get() as { v: string }).v }),
            (b: any) => ({ posts: b.posts, setUnchanged: '0123456789abcdef01234567' }), // "unchanged", but another hash than the one sent
            (b: any) => ({ rows: b.posts }), // another shape altogether
        ]) {
            tamper = (path, body) => (path.includes('nearby=1') ? JSON.stringify(bad(JSON.parse(body))) : null);
            const r = await syncAllowingFailure();
            tamper = null;
            expect(r.success).toBe(false);
            expect(mem.async.get(cursorKey)).toBe(cursor);
            expect(sorted(heldIds())).toEqual(sorted(heldBefore));
            expect(sql.prepare('SELECT lat, updated_at FROM posts WHERE id = ?').get(edited.id)).toEqual(before);
        }
        // The next clean cycle reads the change from the same cursor.
        await sync();
        expect(mem.async.get(cursorKey)).not.toBe(cursor);
        expect((sql.prepare('SELECT lat FROM posts WHERE id = ?').get(edited.id) as { lat: number }).lat).toBeCloseTo(edited.lat + 0.001, 6);
        near = near.map(p => (p.id === edited.id ? { ...p, lat: p.lat + 0.001 } : p));
    }, START_MS);

    it('an unreadable tied (a number in it, a string, null) is read as absent: the read goes on, the stored ties stay', async () => {
        // Probe 12c of the confirmation review of #1778 (finding 2): it refused the whole answer, every cycle, so a node that
        // ever changed the field's shape would stop every listing update on this build. `tied` only adds keeps.
        // Every request here comes from one address: the node's limiters cleared, as the door suites do between steps.
        await control('limiters');
        await sync();
        const cursorKey = [...mem.async.keys()].find(k => k.startsWith('pillar_sync_') && k.endsWith('_last-sync'))!;
        const storedTies = () => sorted(new Set((sql.prepare('SELECT id FROM nearby_tied').all() as { id: string }[]).map(r => r.id)));
        const tiesBefore = storedTies();
        // The node's ties held only by the stored table: the deals of the test above, with no deal row on the phone.
        expect(tiesBefore).toEqual(expect.arrayContaining(['deal-perth', 'deal-old-melb']));
        const heldBefore = heldIds();
        for (const bad of [
            (b: any) => ({ ...b, tied: [...(b.tied ?? []), 7] }),
            (b: any) => ({ ...b, tied: 'x' }),
            (b: any) => ({ ...b, tied: null }),
        ]) {
            const cursor = mem.async.get(cursorKey);
            // A listing near the member changes on the node: the answer that carries it has the odd `tied`.
            const edited = near.find(p => heldBefore.has(p.id))!;
            await control('edit', { post: edited.id, lat: edited.lat + 0.001, lng: edited.lng });
            near = near.map(p => (p.id === edited.id ? { ...p, lat: p.lat + 0.001 } : p));
            // No deal row on the phone: only the stored ties keep the far deals past the cap.
            sql.exec('DELETE FROM marketplace_transactions');
            await control('limiters');
            tamper = (path, body) => (path.includes('nearby=1') ? JSON.stringify(bad(JSON.parse(body))) : null);
            const r = await syncAllowingFailure();
            tamper = null;
            expect(r.success, r.errorMessage).toBe(true);
            expect(mem.async.get(cursorKey)).not.toBe(cursor);
            expect((sql.prepare('SELECT lat FROM posts WHERE id = ?').get(edited.id) as { lat: number }).lat).toBeCloseTo(edited.lat + 0.001, 6);
            // The phone keeps its stored ties, and nothing goes on their account.
            expect(storedTies()).toEqual(tiesBefore);
            expect(sorted(heldIds())).toEqual(sorted(heldBefore));
        }
        await control('limiters');
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
