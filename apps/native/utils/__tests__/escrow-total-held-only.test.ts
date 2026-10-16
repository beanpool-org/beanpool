import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// The Ledger's "In Escrow" is what the node holds for this member, nothing more (#2030 review, "Outside this PR"). The node
// moves a deal's Beans into its escrow only when the deal is approved, or accepted in one step: a request is written with
// no transfer (apps/server/src/engine/escrow.ts requestPost, status 'requested'), the hold is the transfer that takes it to
// 'pending' (approvePostRequest, acceptPost), and release, cancel, refund and a dispute ruling all take it out of 'pending'
// to 'completed' or 'cancelled'. A request that is turned down, superseded or left to expire becomes 'rejected' or
// 'cancelled' having held nothing. So the figure is the member's own 'pending' deals as the buyer, which is also what the
// node's own ledger export lists as their Pending_Trade rows (engine/audit.ts exportLedgerFor). Deals reach the phone
// through applyDelta, as in a sync, and getEscrowTotal reads them from the phone's real schema in an in-memory SQLite.

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

const NODE = 'https://escrow.example';
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

import { applyDelta, getDb, getEscrowTotal } from '../db';

/** A deal as the node sends it in a sync (MarketplaceTransaction), this member the buyer unless said otherwise. */
const deal = (id: string, status: string, credits: number, side: { buyer?: string; seller?: string } = {}) => ({
    id, postId: `post-${id}`, buyerPublicKey: side.buyer ?? ME, sellerPublicKey: side.seller ?? ANA,
    credits, status, createdAt: '2026-10-16T09:00:00.000Z',
    completedAt: status === 'requested' || status === 'pending' ? null : '2026-10-16T10:00:00.000Z',
});
const sync = async (...marketplaceTransactions: ReturnType<typeof deal>[]) => {
    expect(await applyDelta({ marketplaceTransactions })).toBe(true);
};

describe("the Ledger's In Escrow is the Beans the node holds for this member", () => {
    beforeEach(async () => {
        store.clear();
        store.set('beanpool_anchor_url', NODE);
        await getDb();
        sql.exec('DELETE FROM marketplace_transactions');
    });

    it('a request nobody has approved yet holds nothing: 0', async () => {
        // The finding: a member whose Need someone offered on, or who asked for an Offer, saw its price as In Escrow.
        await sync(deal('asked', 'requested', 40));
        expect(await getEscrowTotal(ME)).toBe(0);
    });

    it('approving the request moves its Beans into escrow: In Escrow is its amount', async () => {
        await sync(deal('asked', 'requested', 40));
        await sync(deal('asked', 'pending', 40));
        expect(await getEscrowTotal(ME)).toBe(40);
    });

    it('a one-step accept is held from the start, as on the node', async () => {
        await sync(deal('took', 'pending', 12.5));
        expect(await getEscrowTotal(ME)).toBe(12.5);
    });

    it('every state that leaves escrow, or never reached it, holds nothing', async () => {
        await sync(
            deal('turned-down', 'rejected', 7),       // declined, or another member's request was approved first
            deal('withdrawn', 'cancelled', 9),        // the buyer withdrew the request, or it expired unanswered
            deal('released', 'completed', 11),        // the buyer released it, or a dispute released or split it
            deal('refunded', 'cancelled', 13),        // cancelled after approval, or a dispute refunded it
        );
        expect(await getEscrowTotal(ME)).toBe(0);
    });

    it('a deal held from the other side is the buyer\'s escrow, not this member\'s', async () => {
        await sync(deal('i-sell', 'pending', 30, { buyer: ANA, seller: ME }));
        expect(await getEscrowTotal(ME)).toBe(0);
        expect(await getEscrowTotal(ANA)).toBe(30);
    });

    it('with deals in every state, In Escrow sums only the held ones', async () => {
        await sync(
            deal('asked', 'requested', 40),
            deal('held-1', 'pending', 15),
            deal('held-2', 'pending', 2.25),
            deal('turned-down', 'rejected', 7),
            deal('withdrawn', 'cancelled', 9),
            deal('released', 'completed', 11),
            deal('i-sell', 'pending', 30, { buyer: ANA, seller: ME }),
        );
        expect(await getEscrowTotal(ME)).toBe(17.25);
    });
});
