import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

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
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? activeAnchor : k === 'beanpool_node_profiles' ? JSON.stringify({ [ANCHOR]: { profile: 'local', features: { pins: true, beans: true }, checkedAt: new Date().toISOString() } }) : null)),
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
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pubkey', privateKey: 'aa', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string, body: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { applyDelta, getDb, getPosts, getPost } from '../db';
import { perItemCard } from '@beanpool/core';

/**
 * Per-item prices, slice P2 (DESIGN-per-item-price-fable.md §3): the phone's copy of a listing keeps its count and the price for all
 * of them beside the price (`units_left`, `lot_price_c`, `lot_units`, NULL on every other listing), written by the sync's one row
 * writer and read back by the Market's list and the listing's page, which draw them through core's perItemCard.
 */
describe('a listing priced for each one in the phone\'s copy', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await getDb();
        sql.exec('DELETE FROM posts');
    });
    const node = (over: Record<string, unknown> = {}) => ({
        id: 'p-panels', type: 'offer', category: 'tools', title: 'Solar panels', description: 'Second-hand', price_c: 30000, priceType: 'each',
        unitsLeft: 20, lot: { units: 20, price_c: 550000 }, author_pubkey: 'rob-key', status: 'active', ...over,
    });
    const stored = (id: string) => sql.prepare('SELECT price_type, price_c, units_left, lot_price_c, lot_units FROM posts WHERE id = ?').get(id) as any;

    it('the table has the three columns, INTEGER and empty by default', () => {
        const columns = sql.prepare('PRAGMA table_info(posts)').all() as Array<{ name: string; type: string }>;
        for (const name of ['units_left', 'lot_price_c', 'lot_units']) expect(columns.find((c) => c.name === name)?.type, name).toBe('INTEGER');
    });

    it('the sync writes the count and the price for all (red if the row writer leaves a column out)', async () => {
        await applyDelta({ posts: [node()] });
        expect(stored('p-panels')).toEqual({ price_type: 'each', price_c: 30000, units_left: 20, lot_price_c: 550000, lot_units: 20 });
    });

    it('the list and the page read the row as the card draws it: 300 each, 20 left, or all for 5,500', async () => {
        await applyDelta({ posts: [node()] });
        const fromList = (await getPosts()).find((p: any) => p.id === 'p-panels');
        const fromPage = await getPost('p-panels');
        for (const row of [fromList, fromPage]) {
            expect(perItemCard(row)?.line, 'the row').toBe('20 left · or all for 5,500 🫘');
            expect(perItemCard(row)?.price).toBe('300 🫘 each');
        }
    });

    it('one taken singly: the node sends 19 and the price for all as stored; the card then hides it (a later sync moves the count)', async () => {
        await applyDelta({ posts: [node()] });
        await applyDelta({ posts: [node({ unitsLeft: 19, updatedAt: new Date().toISOString() })] });
        expect(stored('p-panels')).toMatchObject({ units_left: 19, lot_units: 20, lot_price_c: 550000 });
        expect(perItemCard((await getPosts()).find((p: any) => p.id === 'p-panels'))?.line).toBe('19 left');
    });

    it('a price for all that is taken off clears the two columns (the row writer names every column)', async () => {
        await applyDelta({ posts: [node()] });
        await applyDelta({ posts: [node({ lot: null })] });
        expect(stored('p-panels')).toMatchObject({ units_left: 20, lot_price_c: null, lot_units: null });
    });

    it('any other listing, and a listing from an older node that sends no count, keeps all three NULL and reads as it did', async () => {
        await applyDelta({ posts: [
            node({ id: 'p-fixed', priceType: 'fixed', unitsLeft: undefined, lot: undefined, price_c: 4000 }),
            node({ id: 'p-old', unitsLeft: undefined, lot: undefined }),
            // A count sent with another unit is stored nowhere (the node never sends one).
            node({ id: 'p-stray', priceType: 'hourly', price_c: 2000 }),
        ] });
        for (const id of ['p-fixed', 'p-old', 'p-stray']) expect(stored(id), id).toMatchObject({ units_left: null, lot_price_c: null, lot_units: null });
        const rows = await getPosts();
        for (const id of ['p-fixed', 'p-old', 'p-stray']) expect(perItemCard(rows.find((p: any) => p.id === id)), id).toBeNull();
    });
});
