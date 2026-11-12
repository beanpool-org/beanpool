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

import { acceptMarketplacePost, applyDelta, deletePost, getDb, getDealsBetween, getMarketplaceTransactions, getPosts, getPost } from '../db';
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

/**
 * Per-item prices, slice P3 (DESIGN-per-item-price-fable.md §2.3, §3): a deal on a listing priced for each one says which way it
 * was taken up (`item_option`, the node's `itemOption`), kept on the phone's copy of the deal by the sync and by the accept, and
 * read back by Your deals and the chat, so they say "3 × Solar panels". An accept of such a listing leaves it on the board.
 */
describe("a per-item deal in the phone's copy (slice P3)", () => {
    const deal = (over: Record<string, unknown> = {}) => ({
        id: 'tx-3', postId: 'p-panels', buyerPublicKey: 'me-pubkey', sellerPublicKey: 'rob-key', amount_c: 90000, hours: 3, itemOption: 'each',
        status: 'pending', createdAt: '2026-11-11T10:00:00.000Z', postTitle: 'Solar panels', ...over,
    });
    const listing = { id: 'p-panels', type: 'offer', category: 'tools', title: 'Solar panels', description: 'Second-hand', price_c: 30000, priceType: 'each', unitsLeft: 20, lot: { units: 20, price_c: 550000 }, author_pubkey: 'rob-key', status: 'active' };
    const kept = (id: string) => sql.prepare('SELECT item_option, hours, amount_c FROM marketplace_transactions WHERE id = ?').get(id) as any;
    beforeEach(async () => {
        await getDb();
        sql.exec('DELETE FROM posts; DELETE FROM marketplace_transactions');
    });

    it('the sync keeps the way on the deal, NULL on any other (red if the row writer leaves item_option out)', async () => {
        await applyDelta({ posts: [listing], marketplaceTransactions: [deal(), deal({ id: 'tx-all', itemOption: 'lot', hours: 20, amount_c: 550000 }), deal({ id: 'tx-hr', postId: 'p-other', itemOption: undefined, hours: 2 })] });
        expect(kept('tx-3')).toEqual({ item_option: 'each', hours: 3, amount_c: 90000 });
        expect(kept('tx-all')).toEqual({ item_option: 'lot', hours: 20, amount_c: 550000 });
        expect(kept('tx-hr').item_option).toBeNull();
    });

    it('Your deals and the chat read it back: itemOption on such a deal only, item_option and hours beside it in the chat (red if a reader drops it)', async () => {
        await applyDelta({ posts: [listing], marketplaceTransactions: [deal(), deal({ id: 'tx-hr', postId: 'p-other', itemOption: undefined, hours: 2 })] });
        const mine = await getMarketplaceTransactions('me-pubkey');
        expect(mine.find((t) => t.id === 'tx-3')).toMatchObject({ itemOption: 'each', hours: 3 });
        expect(mine.find((t) => t.id === 'tx-hr')).not.toHaveProperty('itemOption');
        const between = await getDealsBetween('me-pubkey', 'rob-key');
        expect(between.find((d) => d.txId === 'tx-3')).toMatchObject({ item_option: 'each', hours: 3 });
    });

    describe('the accept', () => {
        let sent: Array<{ url: string; body: any }> = [];
        const answer = (tx: Record<string, unknown>) => {
            sent = [];
            globalThis.fetch = vi.fn(async (url: any, init?: any) => {
                sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
                return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, transaction: tx }) } as any;
            }) as any;
        };
        const status = (id: string) => (sql.prepare('SELECT status FROM posts WHERE id = ?').get(id) as any)?.status;

        it('of a listing priced each: sends how many, the way and the total shown; the listing stays active; the deal keeps its way (red if the phone takes it off the board)', async () => {
            await applyDelta({ posts: [listing] });
            answer(deal({ id: 'tx-new' }));
            await acceptMarketplacePost('p-panels', 'me-pubkey', 3, undefined, { itemOption: 'each', expect_c: 90000 });
            expect(sent[0].url).toBe(`${ANCHOR}/api/marketplace/posts/accept`);
            expect(sent[0].body).toEqual({ postId: 'p-panels', buyerPublicKey: 'me-pubkey', hours: 3, itemOption: 'each', expect_c: 90000 });
            expect(status('p-panels')).toBe('active');
            expect(kept('tx-new')).toEqual({ item_option: 'each', hours: 3, amount_c: 90000 });
        });

        it('of a one-off listing: unchanged, its body has no way or total and the listing goes pending', async () => {
            await applyDelta({ posts: [{ ...listing, id: 'p-stool', priceType: 'fixed', unitsLeft: undefined, lot: undefined, price_c: 4000 }] });
            answer(deal({ id: 'tx-stool', postId: 'p-stool', itemOption: undefined, hours: undefined, amount_c: 4000 }));
            await acceptMarketplacePost('p-stool', 'me-pubkey');
            expect(sent[0].body).toEqual({ postId: 'p-stool', buyerPublicKey: 'me-pubkey' });
            expect(status('p-stool')).toBe('pending');
            expect(kept('tx-stool').item_option).toBeNull();
        });
    });

    /**
     * P3 follow-up (review of #3093): the phone's seller of an Each listing sees Delete while buyers hold some of the items, and the
     * node refuses it in its own words. deletePost threw that sentence inside "Offline or anchor node unreachable: ...", so the
     * member read that they were offline. Only a send that never reached the node says so.
     */
    describe('deletePost', () => {
        const NODE_SAYS = 'This post has a deal in escrow — complete or cancel the deal before deleting it';
        const answer = (status: number, body: unknown) => {
            globalThis.fetch = vi.fn(async () => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body }) as any) as any;
        };

        const inCopy = (id: string) => sql.prepare('SELECT 1 AS here FROM posts WHERE id = ?').get(id) !== undefined;

        it("the node's refusal comes up as the node wrote it, not as 'Offline or anchor node unreachable' (red if the refusal is wrapped again)", async () => {
            await applyDelta({ posts: [listing] });
            answer(400, { error: NODE_SAYS });
            await expect(deletePost('p-panels')).rejects.toThrow(new Error(NODE_SAYS));
            expect(inCopy('p-panels')).toBe(true); // nothing was erased from the copy
        });

        it("a refusal with no words keeps db.ts's own sentence, and is not 'offline' either", async () => {
            answer(500, {});
            await expect(deletePost('p-panels')).rejects.toThrow(new Error('Failed to remove post on Node'));
        });

        it('a send that never reached the node still says it is offline (red if the offline sentence is lost)', async () => {
            globalThis.fetch = vi.fn(async () => { throw new TypeError('Network request failed'); }) as any;
            await expect(deletePost('p-panels')).rejects.toThrow(new Error('Offline or anchor node unreachable: Network request failed'));
        });

        it('a delete the node accepts erases the copy as before', async () => {
            await applyDelta({ posts: [listing] });
            answer(200, { success: true });
            await deletePost('p-panels');
            expect(inCopy('p-panels')).toBe(false);
        });
    });
});
