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
import { localDealRow } from '../deal-rows';

const post = (id: string, type: 'offer' | 'need', author: string, lendable = 0) => sql
    .prepare("INSERT INTO posts (id, type, category, title, description, author_pubkey, lendable) VALUES (?, ?, 'general', ?, 'd', ?, ?)")
    .run(id, type, `Title of ${id}`, author, lendable);
const deal = (id: string, postId: string, buyer: string, seller: string, status: string, createdAt: string) => sql
    .prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, post_title) VALUES (?, ?, ?, ?, 5, ?, ?, ?)')
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
