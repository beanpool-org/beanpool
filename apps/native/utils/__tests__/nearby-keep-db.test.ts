import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// What a phone keeps of a community that syncs by area (utils/db.ts keepPostsNearby, utils/posts-nearby.ts), as real SQL
// against the phone's real schema: getDb() runs the app's own _doInitDB over this in-memory database, as
// live-post-apply.test.ts does. The review of #1778: the keep rule's cost on every push (finding 4).

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
let activeAnchor: string | null = ANCHOR;
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? activeAnchor : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
        multiRemove: vi.fn(async () => {}),
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

import { applyDelta, getDb } from '../db';

const ME = 'me'.padEnd(64, '0');
const ANN = 'a'.repeat(64);
const BYRON = { lat: -28.6, lng: 153.6 };

function listing(id: string, lat: number, lng: number, extra: Record<string, unknown> = {}) {
    return {
        id, type: 'offer', category: 'food', title: `Listing ${id}`, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: ANN, authorCallsign: 'Ann', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public', lat, lng, ...extra,
    };
}

beforeEach(async () => {
    await getDb(); // schema in place
    for (const t of ['posts', 'marketplace_transactions', 'conversations', 'nearby_tied']) sql.exec(`DELETE FROM ${t}`);
    adapter.getAllAsync.mockClear();
});

describe('the keep rule reads its ties by index', () => {
    it('the deal and conversation tests of every held listing search an index on post_id, never scan the table', async () => {
        const tx = sql.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, 5, 'completed')`);
        const conv = sql.prepare(`INSERT INTO conversations (id, type, post_id, created_by) VALUES (?, 'dm', ?, ?)`);
        for (let i = 0; i < 300; i++) {
            tx.run(`tx-${i}`, `old-${i}`, ME, ANN);
            conv.run(`c-${i}`, i % 3 === 0 ? `old-${i}` : null, ME);
        }
        await applyDelta({ posts: [listing('near-1', BYRON.lat, BYRON.lng)], postsNearby: { area: BYRON, max: 500 } });
        const keep = adapter.getAllAsync.mock.calls.find(([q]) => String(q).includes('AS kept'));
        expect(keep, 'the keep rule ran').toBeTruthy();
        const [q, p] = keep! as [string, unknown[]];
        const plan = (sql.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...(p ?? [])) as Array<{ detail: string }>).map(r => r.detail);
        expect(plan.filter(d => /^SCAN (t|c)\b/.test(d)), plan.join(' | ')).toEqual([]);
        expect(plan.some(d => /^SEARCH t USING (COVERING )?INDEX \w+ \(post_id=\?\)/.test(d)), plan.join(' | ')).toBe(true);
        expect(plan.some(d => /^SEARCH c USING (COVERING )?INDEX \w+ \(post_id=\?\)/.test(d)), plan.join(' | ')).toBe(true);
    });
});
