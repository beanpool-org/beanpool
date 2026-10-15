import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// GET /api/marketplace/transactions answers a tag and a 304 while the phone's copy is still the answer (apps/server
// routes/marketplace.ts). The phone never sends the tag itself: its platform HTTP cache does (OkHttp on Android,
// NSURLCache on iOS), and hands the app the stored body as a 200. So a quiet cycle reaches pillar-sync as the same text
// as the cycle before, which parseIfChanged drops before it is parsed: the stored trades stay as they are, nothing is
// written, and the screens are not told to reload. A 304 that reaches the app as itself (no platform cache in between)
// is not `ok`, and leaves them as they are too. performSync runs against a stubbed node and platform cache, writing the
// phone's real schema in an in-memory SQLite, as takeover-epoch-sync.test.ts does.

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

const ANCHOR = 'https://test.beanpool.org';
const ME = 'me'.padEnd(64, '0');
const store = new Map<string, string>();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) store.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getDb } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

const ANN = 'a'.repeat(64);
function deal(id: string, postId: string, status: string, extra: Record<string, unknown> = {}) {
    return {
        id, postId, postTitle: `Listing ${postId}`, buyerPublicKey: ME, buyerCallsign: 'Me', sellerPublicKey: ANN, sellerCallsign: 'Ann',
        credits: 5, status, createdAt: '2026-10-01T00:00:00.000Z', completedAt: status === 'completed' ? '2026-10-02T00:00:00.000Z' : null,
        ratedByBuyer: false, ratedBySeller: false, coverImage: null, ...extra,
    };
}
const HONEY = deal('tx-honey', 'post-honey', 'completed');
const BREAD = deal('tx-bread', 'post-bread', 'requested');

/** The node: its list of this member's trades, and whether a 304 reaches the app as itself (no platform cache). */
const node = { deals: [] as any[], raw304: false };
/** What the node answered for the trades, cycle by cycle. */
let dealAnswers: number[] = [];
/** The platform cache's copy of the trades URL: the body and the tag it came with. */
let cached: { etag: string; body: string } | null = null;

const tagOf = (body: string) => `"mtx-${body.length}-${[...body].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)}"`;

function answer(status: number, body: string, etag: string | null = null) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
        text: async () => body, json: async () => JSON.parse(body),
    };
}

const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/marketplace/transactions')) {
        // The platform cache sends the tag of its copy; the node answers 304 while that is still the answer.
        const body = JSON.stringify(node.deals);
        const etag = tagOf(body);
        if (cached && cached.etag === etag) {
            dealAnswers.push(304);
            // OkHttp and NSURLCache hand the app their copy as a 200; without one in between, the 304 itself.
            return node.raw304 ? answer(304, '', etag) : answer(200, cached.body, etag);
        }
        dealAnswers.push(200);
        cached = { etag, body };
        return answer(200, body, etag);
    }
    if (url.includes('/api/marketplace/posts')) return answer(200, '[]');
    if (url.includes('/api/members')) return answer(200, '[]');
    return answer(404, '');
});

const stored = () => sql.prepare('SELECT id, status, rated_by_buyer FROM marketplace_transactions ORDER BY id').all() as any[];
/** The writes a cycle made to the trades, and to the listings their status heals. */
const dealWrites = () => adapter.runAsync.mock.calls.map(c => String(c[0]))
    .filter(q => /marketplace_transactions/.test(q) || /^UPDATE posts SET status/.test(q.trim()));

/** One sync cycle from a clean slate of writes, with what the screens were told. */
async function cycle(): Promise<string[]> {
    adapter.runAsync.mockClear();
    // pillar-sync tells the screens through `require('react-native')`, which does not load under node: it is stood in
    // for during the cycle, so the test sees what the screens are told.
    const told: string[] = [];
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: (e: string) => { told.push(e); } } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        expect((await performSync()).success).toBe(true);
    } finally {
        (Module as any)._load = nodeLoad;
    }
    return told;
}

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', ANCHOR);
    // A local community, as the phone knows it (utils/node-profile.ts): with no copy, a sync asks the node first.
    store.set('beanpool_node_profiles', JSON.stringify({ [ANCHOR]: { profile: 'local', features: {}, checkedAt: new Date().toISOString() } }));
    resetSyncFingerprints();
    Object.assign(node, { deals: [], raw304: false });
    dealAnswers = [];
    cached = null;
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'marketplace_transactions', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
});

describe('a 304 for the trades leaves the stored trades as they are and does nothing twice', () => {
    for (const raw304 of [false, true]) {
        it(raw304 ? 'a 304 that reaches the app as itself' : 'a 304 the platform cache hands the app as its copy', async () => {
            node.deals = [HONEY, BREAD];
            node.raw304 = raw304;
            const first = await cycle();
            expect(dealAnswers).toEqual([200]);
            expect(stored()).toEqual([
                { id: 'tx-bread', status: 'requested', rated_by_buyer: 0 },
                { id: 'tx-honey', status: 'completed', rated_by_buyer: 0 },
            ]);
            expect(dealWrites().length).toBeGreaterThan(0);
            expect(first).toContain('sync_data_updated');
            const held = stored();

            // Nothing changed on the node: a 304, and the cycle writes no trade, heals no listing, tells no screen.
            const quiet = await cycle();
            expect(dealAnswers).toEqual([200, 304]);
            expect(dealWrites()).toEqual([]);
            expect(quiet).not.toContain('sync_data_updated');
            expect(stored()).toEqual(held);

            // And again.
            expect(await cycle()).not.toContain('sync_data_updated');
            expect(dealAnswers).toEqual([200, 304, 304]);
            expect(dealWrites()).toEqual([]);
            expect(stored()).toEqual(held);

            // A change on the node moves the tag: a 200, written once, and the screens told once.
            node.deals = [HONEY, { ...BREAD, status: 'pending' }, deal('tx-jam', 'post-jam', 'requested')];
            const changed = await cycle();
            expect(dealAnswers).toEqual([200, 304, 304, 200]);
            expect(stored()).toEqual([
                { id: 'tx-bread', status: 'pending', rated_by_buyer: 0 },
                { id: 'tx-honey', status: 'completed', rated_by_buyer: 0 },
                { id: 'tx-jam', status: 'requested', rated_by_buyer: 0 },
            ]);
            expect(changed.filter(e => e === 'sync_data_updated')).toHaveLength(1);

            const after = await cycle();
            expect(dealAnswers).toEqual([200, 304, 304, 200, 304]);
            expect(dealWrites()).toEqual([]);
            expect(after).not.toContain('sync_data_updated');
        });
    }
});
