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
import { DEFAULT_MARKET_FILTERS, feedPostVisible } from '../market-filters';

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

    /**
     * The sync's deal heal closes a one-off listing when its deal completes. An Each listing is never a one-off: the node closes it
     * itself (settleItemDeal) when the count reaches 0, and it does not send the post again while units are left, so a heal here
     * would leave the phone saying "Sold out" until the page is opened (review of #3090, design D3).
     */
    describe('a deal released on it', () => {
        const dealOn = (postId: string, over: Record<string, unknown> = {}) => ({
            id: 'tx-1', postId, buyerPublicKey: 'buyer-key', sellerPublicKey: 'rob-key', amount_c: 30000, status: 'completed', ...over,
        });
        const row = (id: string) => sql.prepare('SELECT status, active, units_left FROM posts WHERE id = ?').get(id) as any;
        // The Market reads getPosts (active, pending and completed rows only), then feedPostVisible: a paused row never reaches it.
        const inFeed = async (id: string) => {
            const post = (await getPosts()).find((p: any) => p.id === id);
            return !!post && feedPostVisible(post, DEFAULT_MARKET_FILTERS, { blockedUsers: [], favCategories: [] });
        };

        it('19 left on the node, one deal released: the row stays active, the card says 19 left, and it stays in the Market feed (red if the heal closes it)', async () => {
            await applyDelta({ posts: [node({ unitsLeft: 19 })] });
            await applyDelta({ marketplaceTransactions: [dealOn('p-panels')] });
            expect(row('p-panels')).toMatchObject({ status: 'active', active: 1, units_left: 19 });
            const card = perItemCard((await getPosts()).find((p: any) => p.id === 'p-panels'));
            expect(card?.line).toBe('19 left');
            expect(card?.line).not.toMatch(/sold out/i);
            expect(await inFeed('p-panels')).toBe(true);
        });

        it('a real sold-out (the node sends count 0 and completed) still closes it', async () => {
            await applyDelta({ posts: [node({ unitsLeft: 1, lot: null })] });
            await applyDelta({ marketplaceTransactions: [dealOn('p-panels')] });
            expect(row('p-panels').status).toBe('active');
            await applyDelta({ posts: [node({ unitsLeft: 0, lot: null, status: 'completed', active: 0, updatedAt: new Date().toISOString() })] });
            expect(row('p-panels')).toMatchObject({ status: 'completed', units_left: 0 });
            expect(await inFeed('p-panels')).toBe(false);
        });

        /**
         * The same holds for a cancelled deal (review of #3090, round 3). The phone reads the member's latest deals, newest first, and the
         * heal runs after the node's own post row in the same delta; a cancelled deal puts a one-off listing back on offer, but an Each
         * listing's status is the node's alone: settleItemDeal('returned') never changes it ("a paused listing stays paused, a removed one
         * removed"), and the node moves updated_at when a count comes back, so the post arrives with its true count and status.
         */
        it('sold out on the node (0 left, completed) with an older deal cancelled in the same list: the row stays completed and leaves the feed (red if the cancelled heal reopens it)', async () => {
            await applyDelta({
                posts: [node({ unitsLeft: 0, lot: null, status: 'completed', active: 0, updatedAt: new Date().toISOString() })],
                // Newest first, as the node lists them: the last deal completed, an older one cancelled.
                marketplaceTransactions: [
                    dealOn('p-panels', { id: 'tx-new', status: 'completed', createdAt: '2026-11-12T03:00:00.000Z' }),
                    dealOn('p-panels', { id: 'tx-old', status: 'cancelled', createdAt: '2026-11-12T01:00:00.000Z' }),
                ],
            });
            expect(row('p-panels')).toMatchObject({ status: 'completed', units_left: 0 });
            expect(perItemCard((await getPosts()).find((p: any) => p.id === 'p-panels'))?.line).toMatch(/sold out/i);
            expect(await inFeed('p-panels')).toBe(false);
        });

        it('paused on the node (20 left) after a held deal is cancelled: the row stays paused and out of the feed (red if the cancelled heal reopens it)', async () => {
            await applyDelta({
                posts: [node({ unitsLeft: 20, status: 'paused', updatedAt: new Date().toISOString() })],
                marketplaceTransactions: [dealOn('p-panels', { id: 'tx-held', status: 'cancelled' })],
            });
            expect(row('p-panels')).toMatchObject({ status: 'paused', units_left: 20 });
            expect(await inFeed('p-panels')).toBe(false);
        });

        it('an Each listing that is active keeps its count and stays in the feed when a deal on it is cancelled', async () => {
            await applyDelta({ posts: [node({ unitsLeft: 20 })], marketplaceTransactions: [dealOn('p-panels', { id: 'tx-c', status: 'cancelled' })] });
            expect(row('p-panels')).toMatchObject({ status: 'active', active: 1, units_left: 20 });
            expect(await inFeed('p-panels')).toBe(true);
        });

        it('a one-off listing is put back on offer by its cancelled deal (the heal is unchanged for it)', async () => {
            await applyDelta({ posts: [node({ id: 'p-fixed', priceType: 'fixed', unitsLeft: undefined, lot: undefined, price_c: 4000 })] });
            sql.prepare("UPDATE posts SET status = 'pending', accepted_by = 'buyer-key', pending_transaction_id = 'tx-3' WHERE id = 'p-fixed'").run();
            await applyDelta({ marketplaceTransactions: [dealOn('p-fixed', { id: 'tx-3', status: 'cancelled' })] });
            expect(sql.prepare('SELECT status, accepted_by, pending_transaction_id FROM posts WHERE id = ?').get('p-fixed')).toEqual({ status: 'active', accepted_by: null, pending_transaction_id: null });
        });

        it('a one-off listing is still closed by its released deal (the heal is unchanged for it)', async () => {
            await applyDelta({ posts: [node({ id: 'p-fixed', priceType: 'fixed', unitsLeft: undefined, lot: undefined, price_c: 4000 })] });
            await applyDelta({ marketplaceTransactions: [dealOn('p-fixed', { id: 'tx-2' })] });
            expect(row('p-fixed')).toMatchObject({ status: 'completed', active: 0 });
        });
    });
});
