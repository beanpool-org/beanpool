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
const activeAnchor: string | null = ANCHOR;
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
import { livePostChange } from '@beanpool/core';

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
        const plan = (sql.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...((p ?? []) as any[])) as Array<{ detail: string }>).map(r => r.detail);
        expect(plan.filter(d => /^SCAN (t|c)\b/.test(d)), plan.join(' | ')).toEqual([]);
        expect(plan.some(d => /^SEARCH t USING (COVERING )?INDEX \w+ \(post_id=\?\)/.test(d)), plan.join(' | ')).toBe(true);
        expect(plan.some(d => /^SEARCH c USING (COVERING )?INDEX \w+ \(post_id=\?\)/.test(d)), plan.join(' | ')).toBe(true);
    });
});

describe('a removal pushed frees its slot', () => {
    it('a listing taken off goes at the next push past the cap, not the farthest listing still on the board', async () => {
        // 5 others held near the member, the cap 5; then one of them removed (a post_removed push) and a new one pushed nearer.
        const rows = Array.from({ length: 5 }, (_, i) => listing(`near-${i}`, BYRON.lat + 0.01 * (i + 1), BYRON.lng));
        await applyDelta({ posts: rows, postsNearby: { area: BYRON, max: 5 } });
        await applyDelta({ liveChanges: [livePostChange({ type: 'post_removed', id: 'near-0', audienceScope: 'public' })!], postsNearby: { area: BYRON, max: 5 } });
        expect(sql.prepare("SELECT status FROM posts WHERE id = 'near-0'").get()).toEqual({ status: 'cancelled' });
        const pushed = listing('push-1', BYRON.lat + 0.001, BYRON.lng);
        await applyDelta({ liveChanges: [livePostChange({ type: 'new_post', post: pushed })!], postsNearby: { area: BYRON, max: 5 } });
        const held = (sql.prepare('SELECT id FROM posts ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
        expect(held).toEqual(['near-1', 'near-2', 'near-3', 'near-4', 'push-1']);
    });
});

describe('the author name a listing carries', () => {
    it('every read of a listing names author_callsign once: the directory\'s name, else the one the node carried (the review of #1778, finding 8)', async () => {
        const { getPosts, getPost } = await import('../db');
        sql.exec(`DELETE FROM members WHERE public_key = '${ANN}'`);
        await applyDelta({ posts: [listing('named-1', BYRON.lat, BYRON.lng)] });
        // The posts table keeps the carried name under a name of its own, so \`p.*\` never repeats the alias.
        const columns = (sql.prepare('PRAGMA table_info(posts)').all() as Array<{ name: string }>).map(c => c.name);
        expect(columns).not.toContain('author_callsign');
        adapter.getAllAsync.mockClear();
        adapter.getFirstAsync.mockClear();
        expect((await getPosts()).find((p: any) => p.id === 'named-1')?.author_callsign).toBe('Ann');
        expect((await getPost('named-1'))?.author_callsign).toBe('Ann');
        const reads = [...adapter.getAllAsync.mock.calls, ...adapter.getFirstAsync.mock.calls].map(([q]) => String(q)).filter(q => /as author_callsign/i.test(q));
        expect(reads.length).toBeGreaterThanOrEqual(2);
        for (const q of reads) {
            const stmt = sql.prepare(q) as any;
            // node:sqlite names a statement's columns from Node 22.16; where it can, author_callsign once. (getPost's
            // accepted_by_callsign comes twice, from p.* and its own join, as it does on main: not this change's.)
            if (typeof stmt.columns === 'function') {
                const names = (stmt.columns() as Array<{ name: string }>).map(c => c.name);
                expect(names.filter(n => n === 'author_callsign'), q.slice(0, 80)).toEqual(['author_callsign']);
            }
        }
        // The directory's name wins where it has one.
        sql.prepare(`INSERT INTO members (public_key, callsign) VALUES (?, 'Ann Lee')`).run(ANN);
        expect((await getPost('named-1'))?.author_callsign).toBe('Ann Lee');
    });
});
