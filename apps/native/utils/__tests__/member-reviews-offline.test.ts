import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Another member's reviews offline (#1914 review, finding 2). Since #1914 a member who is neither party reads a review as
// stars, words, side and month, with no rater, no deal and no id, so none of it goes into the phone's ratings table. The
// phone keeps the node's answer by member (member_reviews_read) and shows it offline: the same count, average and rows
// as online, on the Reviews tab and on a market card's stars. No warning per review. The member's own reviews stay in
// ratings, as before. getMemberRatings runs against a fake node, writing the phone's real schema in an in-memory SQLite.

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

const A_URL = 'https://a.beanpool.org';
const OWN = 'e'.repeat(64);
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

import { getDb, getMemberRatings } from '../db';
const REVIEWS_READ_KEPT = 300; // db.ts keeps the 300 members read last (module-private there)

const ANA = 'b'.repeat(64);
const BEN = 'c'.repeat(64);
const hexKey = (i: number) => i.toString(16).padStart(64, '0');
function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const online = (body: unknown) => { (globalThis as any).fetch = vi.fn(async () => answer(200, body)); };
const offline = () => { (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); }); };

// Ana's reviews as this phone's member reads them from a node with #1914: two others' stripped, the member's own in full.
const stripped = (stars: number, i: number) => ({ stars, comment: `Words ${i}`, role: 'provider', createdAt: '2026-09-01T12:00:00Z' });
const mineRow = { id: 'r-mine', targetPubkey: ANA, raterPubkey: OWN, stars: 5, comment: 'Mine', role: 'receiver', transactionId: 'deal-mine', createdAt: '2026-09-13T08:01:02.345Z', rater_callsign: 'Me', rater_avatar: null, mine: true };
const anaBody = { ratings: [stripped(4, 1), mineRow, stripped(3, 2)], average: 4, count: 3, raters: 3, asProvider: { average: 3.5, count: 2 }, asReceiver: { average: 5, count: 1 } };
// What each screen draws from the answer (public-profile.tsx, PostAuthorTrust.tsx).
const drawn = (r: any) => ({ average: r.average, count: r.count, asProvider: r.asProvider, asReceiver: r.asReceiver,
    rows: r.ratings.map((x: any) => `${x.stars}★ ${x.role} ${x.createdAt} ${x.comment}`) });

describe('another member\'s reviews offline (#1914 review, finding 2)', () => {
    beforeEach(async () => {
        store.clear();
        store.set('beanpool_anchor_url', A_URL);
        await getDb();
        sql.exec('DELETE FROM ratings');
        sql.exec('DELETE FROM member_reviews_read');
    });

    it('after an online read, offline shows the same count, average and rows, with no warning per review', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        online(anaBody);
        const on = await getMemberRatings(ANA);
        expect(on).toEqual(anaBody);
        const reviewWarnings = warn.mock.calls.filter(c => /rating/i.test(String(c[0]))).length;
        offline();
        const off = await getMemberRatings(ANA);
        expect(drawn(off)).toEqual(drawn(on));
        expect(off.ratings).toHaveLength(3);
        expect(reviewWarnings).toBe(0);
        warn.mockRestore();
    });

    it('keeps no rater and no deal for another member\'s list; the member\'s own review still goes into ratings', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        online(anaBody);
        await getMemberRatings(ANA);
        const kept = sql.prepare('SELECT answer FROM member_reviews_read WHERE target_pubkey = ?').get(ANA) as { answer: string };
        expect(kept.answer).not.toMatch(/raterPubkey|rater_pubkey|transactionId|transaction_id|"id"|rater_callsign|rater_avatar|deal-mine|r-mine/);
        expect(kept.answer).not.toContain(OWN);
        expect(JSON.parse(kept.answer).ratings.filter((r: any) => r.mine === true)).toHaveLength(1);
        expect(sql.prepare('SELECT id, rater_pubkey, transaction_id FROM ratings').all()).toEqual([{ id: 'r-mine', rater_pubkey: OWN, transaction_id: 'deal-mine' }]);
    });

    it('a market of 120 cards, 10 reviews each: 120 members kept, no warning, and each card\'s stars offline', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        (globalThis as any).fetch = vi.fn(async (url: string) => {
            const idx = parseInt(new URL(url).pathname.split('/').pop()!, 16);
            const ratings = Array.from({ length: 10 }, (_, j) => stripped(1 + ((idx + j) % 5), j));
            return answer(200, { ratings, average: 3, count: 10, raters: 10, asProvider: { average: 3, count: 10 }, asReceiver: { average: 0, count: 0 } });
        });
        for (let i = 1; i <= 120; i++) await getMemberRatings(hexKey(i));
        const reviewWarnings = warn.mock.calls.filter(c => /rating/i.test(String(c[0]))).length;
        expect(reviewWarnings).toBe(0);
        expect((sql.prepare('SELECT COUNT(*) AS n FROM ratings').get() as any).n).toBe(0);
        expect((sql.prepare('SELECT COUNT(*) AS n FROM member_reviews_read').get() as any).n).toBe(120);
        offline();
        for (const i of [1, 60, 120]) {
            const off = await getMemberRatings(hexKey(i));
            expect({ average: off.average, count: off.count, rows: off.ratings.length }).toEqual({ average: 3, count: 10, rows: 10 });
        }
        warn.mockRestore();
    });

    it(`keeps the ${REVIEWS_READ_KEPT} members read last`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        online({ ratings: [stripped(5, 1)], average: 5, count: 1, raters: 1, asProvider: { average: 5, count: 1 }, asReceiver: { average: 0, count: 0 } });
        for (let i = 1; i <= REVIEWS_READ_KEPT + 5; i++) await getMemberRatings(hexKey(i));
        expect((sql.prepare('SELECT COUNT(*) AS n FROM member_reviews_read').get() as any).n).toBe(REVIEWS_READ_KEPT);
        const has = (i: number) => !!sql.prepare('SELECT 1 FROM member_reviews_read WHERE target_pubkey = ?').get(hexKey(i));
        expect([1, 5, 6, REVIEWS_READ_KEPT + 5].map(has)).toEqual([false, false, true, true]);
    });

    it('a node from before #1914 (every review in full): still written to ratings as before, kept without its raters', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const full = (i: number) => ({ id: `r${i}`, targetPubkey: BEN, raterPubkey: hexKey(100 + i), stars: 4, comment: `Words ${i}`, role: 'provider', transactionId: `d${i}`, createdAt: `2026-09-1${i}T08:00:00.000Z`, rater_callsign: `x${i}`, rater_avatar: null });
        const body = { ratings: [1, 2, 3].map(full), average: 4, count: 3, asProvider: { average: 4, count: 3 }, asReceiver: { average: 0, count: 0 } };
        online(body);
        const on = await getMemberRatings(BEN);
        expect((sql.prepare('SELECT COUNT(*) AS n FROM ratings WHERE target_pubkey = ?').get(BEN) as any).n).toBe(3);
        const kept = (sql.prepare('SELECT answer FROM member_reviews_read WHERE target_pubkey = ?').get(BEN) as { answer: string }).answer;
        expect(kept).not.toMatch(/raterPubkey|transactionId|rater_callsign|"id"/);
        offline();
        expect(drawn(await getMemberRatings(BEN))).toEqual(drawn(on));
    });

    it('the member\'s own reviews: read into ratings with their raters, nothing kept by member, offline from ratings as before', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        sql.prepare('INSERT OR REPLACE INTO members (public_key, callsign) VALUES (?, ?)').run(ANA, 'Ana');
        const own = { ratings: [{ id: 'r-own', targetPubkey: OWN, raterPubkey: ANA, stars: 4, comment: 'Paid promptly', role: 'receiver', transactionId: 'deal-own', createdAt: '2026-09-13T08:01:02.345Z', rater_callsign: 'Ana', rater_avatar: null }], average: 4, count: 1, raters: 1, asProvider: { average: 0, count: 0 }, asReceiver: { average: 4, count: 1 } };
        online(own);
        await getMemberRatings(OWN);
        expect(sql.prepare('SELECT COUNT(*) AS n FROM member_reviews_read').get()).toEqual({ n: 0 });
        offline();
        const off = await getMemberRatings(OWN);
        expect(off.ratings.map((r: any) => [r.raterPubkey, r.transactionId, r.rater_callsign])).toEqual([[ANA, 'deal-own', 'Ana']]);
    });
});
