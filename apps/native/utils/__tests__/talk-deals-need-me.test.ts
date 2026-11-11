import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Talk's Action Required counts the deals whose next step is the member's, by core's dealStep, as the web's chip does
// (deals S7 part 2; the #2607 deciding pass, Decision 2). Read from the phone's real schema in an in-memory SQLite: a
// request on my listing is mine to answer (a Need I posted, a thing I lend), my own request and Beans held for me are not,
// and the chip's count per person is core's dealsNeedingMe for that person.

const sql = new DatabaseSync(':memory:');
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

const NODE = 'https://needme.example';
const ME = 'e'.repeat(64);
const ANA = 'b'.repeat(64);
const BOB = 'c'.repeat(64);
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

import { dealsNeedingMe } from '@beanpool/core';
import { getActionableDeals, getDb, getDealsBetween } from '../db';
import { isChatStripDeal, localDealMoves, localDealRow } from '../deal-rows';

const post = (id: string, type: 'offer' | 'need', author: string, lendable = 0) => sql
    .prepare("INSERT INTO posts (id, type, category, title, description, author_pubkey, lendable) VALUES (?, ?, 'general', ?, 'd', ?, ?)")
    .run(id, type, `Title of ${id}`, author, lendable);
const deal = (id: string, postId: string, buyer: string, seller: string, status: string, createdAt: string) => sql
    .prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, created_at, post_title) VALUES (?, ?, ?, ?, 500, ?, ?, ?)')
    .run(id, postId, buyer, seller, status, createdAt, `Title of ${postId}`);
const dm = (id: string, peer: string) => {
    sql.prepare("INSERT INTO conversations (id, type) VALUES (?, 'dm')").run(id);
    for (const k of [ME, peer]) sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, k);
};

/** With Ana: a request on my Need (mine to answer), my own request on hers (not), Beans I hold for her listing (mine to release), a finished trade (a review). With Bob: a request to borrow my tool (mine to answer), Beans held for me (not). */
function mixed() {
    post('p-need-me', 'need', ME);
    post('p-offer-ana', 'offer', ANA);
    post('p-offer-ana2', 'offer', ANA);
    post('p-offer-ana3', 'offer', ANA);
    post('p-tool-me', 'offer', ME, 1);
    post('p-offer-me', 'offer', ME);
    // On a Need the one who asks is the seller (the helper); the Need's author is the buyer.
    deal('rq-need', 'p-need-me', ME, ANA, 'requested', '2026-10-20T09:00:00.000Z');
    deal('rq-mine', 'p-offer-ana', ME, ANA, 'requested', '2026-10-20T10:00:00.000Z');
    deal('held-pay', 'p-offer-ana2', ME, ANA, 'pending', '2026-10-20T11:00:00.000Z');
    deal('done', 'p-offer-ana3', ME, ANA, 'completed', '2026-10-20T12:00:00.000Z');
    deal('declined', 'p-offer-ana', ME, ANA, 'rejected', '2026-10-20T13:00:00.000Z');
    // On a thing I lend the borrower asks and is the buyer; I am the seller and the listing's author.
    deal('rq-loan', 'p-tool-me', BOB, ME, 'requested', '2026-10-21T09:00:00.000Z');
    deal('held-payee', 'p-offer-me', BOB, ME, 'pending', '2026-10-21T10:00:00.000Z');
    dm('c-ana', ANA);
    dm('c-bob', BOB);
}

describe("Talk's Action Required is core's rule: the deals whose step is the member's", () => {
    beforeEach(async () => {
        store.clear();
        store.set('beanpool_anchor_url', NODE);
        globalThis.fetch = vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch;
        await getDb();
        for (const t of ['marketplace_transactions', 'posts', 'conversation_participants', 'conversations', 'ratings']) sql.exec(`DELETE FROM ${t}`);
        mixed();
    });

    it('a request on my listing is mine to answer; my own request and Beans held for me ask nothing of me', async () => {
        const items = await getActionableDeals(ME);
        const actions = Object.fromEntries(items.map(d => [d.txId, d.action]));
        expect(actions).toEqual({ 'rq-need': 'answer', 'held-pay': 'release', done: 'review', 'rq-loan': 'answer' });
        // The two that wait on the other side, and the declined one, are no item.
        expect(items.map(d => d.txId)).not.toContain('rq-mine');
        expect(items.map(d => d.txId)).not.toContain('held-payee');
        expect(items.map(d => d.txId)).not.toContain('declined');
    });

    it("each person's chip (release + answer) equals core's dealsNeedingMe for that person; a review is not counted", async () => {
        const items = await getActionableDeals(ME);
        for (const peer of [ANA, BOB]) {
            const chip = items.filter(d => d.peerPubkey === peer && (d.action === 'release' || d.action === 'answer')).length;
            const rows = (await getDealsBetween(ME, peer)).map(r => localDealRow(r, ME));
            expect(chip, peer).toBe(dealsNeedingMe(rows, ME).length);
        }
        expect(items.filter(d => d.peerPubkey === ANA && (d.action === 'release' || d.action === 'answer'))).toHaveLength(2);
        expect(items.filter(d => d.peerPubkey === BOB && (d.action === 'release' || d.action === 'answer'))).toHaveLength(1);
    });

    it("the chat's read of the deals with one person carries the listing's author and kind", async () => {
        const rows = await getDealsBetween(ME, ANA);
        const need = rows.find(r => r.txId === 'rq-need');
        expect(need).toMatchObject({ status: 'requested', postAuthorPublicKey: ME, postType: 'need' });
        expect(rows.find(r => r.txId === 'rq-mine')).toMatchObject({ postAuthorPublicKey: ANA, postType: 'offer' });
    });
});

// A standing deal between me (the payer) and Ana (DESIGN-standing-deals-upfront-fable §3): nothing of it is ever held, so
// no row of it is a step to release, whatever status a copy carries; only its first period asks for a review.
const standingRow = (id: string, status: string, periodNo: number, phase: string | null, createdAt: string) => {
    sql.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, created_at, post_title, standing_id, period_no, standing) VALUES (?, ?, ?, ?, 5000, ?, ?, ?, ?, ?, ?)')
        .run(id, 'p-storage', ME, ANA, status, createdAt, 'Vehicle Storage', 'sd-1', periodNo, phase ? JSON.stringify({ phase, beans_c: 5000, unit: 'month', max: null, nextDueAt: '2026-12-09T08:00:00.000Z', startsAt: '2026-10-09T08:00:00.000Z', shortSince: null, stopped: false }) : null);
};

describe('a standing deal asks no Release anywhere the phone lists deals (U2, fail-first)', () => {
    beforeEach(async () => {
        store.clear();
        store.set('beanpool_anchor_url', NODE);
        globalThis.fetch = vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch;
        await getDb();
        for (const t of ['marketplace_transactions', 'posts', 'conversation_participants', 'conversations', 'ratings']) sql.exec(`DELETE FROM ${t}`);
        post('p-storage', 'offer', ANA);
        dm('c-ana', ANA);
        // Month 1 and 2 done, month 3 the current row; and a copy that still reads a period as pending (a stale row).
        standingRow('sd-m1', 'completed', 1, null, '2026-10-09T08:00:00.000Z');
        standingRow('sd-m2', 'pending', 2, null, '2026-11-09T08:00:00.000Z');
        standingRow('sd-m3', 'pending', 3, 'paid', '2026-12-09T08:00:00.000Z');
    });

    it("Talk's Action Required: no Release Credits item for any period; the first period's review only", async () => {
        const items = await getActionableDeals(ME);
        expect(Object.fromEntries(items.map(d => [d.txId, d.action]))).toEqual({ 'sd-m1': 'review' });
    });

    it("the chat's pinned strip and inline bar: no Release, no Cancel on any standing row, for either side", async () => {
        const rows = await getDealsBetween(ME, ANA);
        expect(rows).toHaveLength(3);
        for (const r of rows) {
            for (const me of [ME, ANA]) {
                const m = localDealMoves(r, me)!;
                expect([r.txId, me === ME, m.release, m.cancelHold]).toEqual([r.txId, me === ME, false, false]);
            }
        }
        // The strip lists the first period's review and nothing else of it.
        expect(rows.filter(r => isChatStripDeal(r, ME)).map(r => r.txId)).toEqual(['sd-m1']);
        // The current row carries the standing deal: Stop is offered, by core.
        expect(localDealMoves(rows.find(r => r.txId === 'sd-m3')!, ME)!.stop).toBe(true);
    });
});

// A one-off deal held in trust, read by the chat's own read (getDealsBetween) from the phone's real schema: its payer is
// offered Release and Cancel in the chat's strip and inline bar, its payee waits (U2 round 2: dealMoves routes every chat
// button, and a one-off held deal must still show Release + Cancel to its payer, memory deals-design-badge-means-your-step).
describe("a one-off deal held in trust: the chat's read offers its payer Release and Cancel (U2 round 2)", () => {
    beforeEach(async () => {
        store.clear();
        store.set('beanpool_anchor_url', NODE);
        globalThis.fetch = vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch;
        await getDb();
        for (const t of ['marketplace_transactions', 'posts', 'conversation_participants', 'conversations', 'ratings']) sql.exec(`DELETE FROM ${t}`);
        post('p-eggs', 'offer', ANA);
        dm('c-ana', ANA);
        deal('held-eggs', 'p-eggs', ME, ANA, 'pending', '2026-11-10T09:00:00.000Z');
    });

    it('the payer: Release and Cancel, in the strip; the payee: awaiting release, never Release', async () => {
        const rows = await getDealsBetween(ME, ANA);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        // The keys the chat's dealMoves reads come with the row (the chat's fixture lacked them: #3032 round 2).
        expect(row).toMatchObject({ txId: 'held-eggs', status: 'pending', buyerPubkey: ME, sellerPubkey: ANA, standing_id: null });
        const payer = localDealMoves(row, ME)!;
        expect([payer.release, payer.cancelHold, payer.step.state]).toEqual([true, true, 'to-release']);
        expect(isChatStripDeal(row, ME)).toBe(true);
        const payee = localDealMoves(row, ANA)!;
        expect([payee.release, payee.cancelHold, payee.step.state]).toEqual([false, true, 'to-deliver']);
        expect(isChatStripDeal(row, ANA)).toBe(true);
        // Talk counts it as the payer's step too.
        expect((await getActionableDeals(ME)).map(d => [d.txId, d.action])).toEqual([['held-eggs', 'release']]);
    });
});
