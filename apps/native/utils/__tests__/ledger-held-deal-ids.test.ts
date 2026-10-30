import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A Held in Trust row on the Ledger carries the deal it belongs to (deals S6): getTransactions joins the phone's own
// copy of the deal (marketplace_transactions, by the escrow account's deal id, or by the listing id an older hold was
// keyed by) and hands the row's `held` its `dealId` and `postId`, which the Ledger opens (app/(tabs)/ledger.tsx). A hold
// the phone has no deal for carries neither, and the Ledger draws it as a plain row. Read from the phone's real schema in
// an in-memory SQLite, the deals arriving through applyDelta as in a sync.

const sql = new DatabaseSync(':memory:');
// expo-sqlite ignores a bound value with no `?` to go to (getTransactions binds the key seven times for five); node:sqlite throws.
const params = (q: string, p: unknown) => ((p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[]).slice(0, (q.match(/\?/g) ?? []).length);
const adapter = {
    runAsync: vi.fn(async (q: string, p?: unknown) => {
        const r = sql.prepare(q).run(...params(q, p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    }),
    execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
    getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(q, p))),
    getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(q, p)) ?? null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};

const NODE = 'https://held.example';
const ME = 'e'.repeat(64);
const ANA = 'b'.repeat(64);
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'e'.repeat(64), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import { applyDelta, getDb, getTransactions } from '../db';

/** A deal as the node sends it in a sync (MarketplaceTransaction), this member the buyer unless said otherwise. */
const deal = (id: string, postId: string, side: { buyer?: string; seller?: string } = {}) => ({
    id, postId, postTitle: `Title of ${id}`, buyerPublicKey: side.buyer ?? ME, sellerPublicKey: side.seller ?? ANA,
    credits: 30, status: 'pending', createdAt: '2026-10-16T09:00:00.000Z', completedAt: null,
});
const ledgerRow = (id: string, from: string, to: string) => {
    sql.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, ?, 30, 0, ?, ?)')
        .run(id, from, to, 'Escrow hold', '2026-10-16T10:00:00.000Z');
};

describe('a Held in Trust row on the Ledger carries the deal it belongs to', () => {
    beforeEach(async () => {
        store.clear();
        // Anchored, as a phone is; the background read of the node getTransactions starts is refused and changes nothing.
        store.set('beanpool_anchor_url', NODE);
        globalThis.fetch = vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch;
        await getDb();
        sql.exec('DELETE FROM marketplace_transactions');
        sql.exec('DELETE FROM transactions');
    });

    it('the hold of a deal this phone has: its deal id and its listing id, with the title and the other side', async () => {
        expect(await applyDelta({ marketplaceTransactions: [deal('deal-1', 'post-1')] })).toBe(true);
        ledgerRow('t1', ME, 'escrow_deal-1');
        const [row] = await getTransactions(ME);
        expect(row.held).toMatchObject({ title: 'Title of deal-1', toCounterparty: true, dealId: 'deal-1', postId: 'post-1' });
        expect(row.peerPubkey).toBe('escrow_deal-1');
    });

    it('the payout from the escrow is the same deal, seen from the seller', async () => {
        expect(await applyDelta({ marketplaceTransactions: [deal('deal-2', 'post-2', { buyer: ANA, seller: ME })] })).toBe(true);
        ledgerRow('t2', 'escrow_deal-2', ME);
        const [row] = await getTransactions(ME);
        expect(row.held).toMatchObject({ toCounterparty: false, dealId: 'deal-2', postId: 'post-2' });
    });

    it('an older hold keyed by the listing id finds the deal on that listing', async () => {
        expect(await applyDelta({ marketplaceTransactions: [deal('deal-3', 'post-3')] })).toBe(true);
        ledgerRow('t3', ME, 'escrow_post-3');
        const [row] = await getTransactions(ME);
        expect(row.held).toMatchObject({ dealId: 'deal-3', postId: 'post-3' });
    });

    it('a hold this phone has no deal for has no ids: the Ledger draws it as a plain row', async () => {
        ledgerRow('t4', ME, 'escrow_nobody');
        const [row] = await getTransactions(ME);
        expect(row.held).toEqual({ title: null, counterparty: null, toCounterparty: false });
        expect(row.peer).toBe('Held in Trust');
    });

    it('Beans between members are no hold at all', async () => {
        ledgerRow('t5', ME, ANA);
        const [row] = await getTransactions(ME);
        expect(row.held).toBeNull();
    });
});
