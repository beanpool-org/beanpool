import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    WASH_30_DAY_PAGE_ROWS, WASH_BFS_STEP_NODES, thirtyDayTradePages, runWashTradingAnalysis, runWashAnalysisInSlices,
    closeWashSnapshotHandle, type WashAnalysis,
} from '../trust.js';

// The cluster step's 30-day query, a page at a time (#1908): the same rows in the same order as the one query, so the
// same analysis as main's, to the last bit.

// The node's own index on the 30-day query (apps/server/src/db/schema.sql): the one query reads through it, and its order
// is the order the pages keep.
const SCHEMA = `
    CREATE TABLE members (public_key TEXT PRIMARY KEY, joined_at TEXT);
    CREATE TABLE marketplace_transactions (
        id TEXT PRIMARY KEY, buyer_pubkey TEXT NOT NULL, seller_pubkey TEXT NOT NULL, credits REAL NOT NULL, status TEXT,
        completed_at DATETIME
    );
    CREATE INDEX idx_marketplace_transactions_status_completed ON marketplace_transactions(status, completed_at);
    CREATE INDEX idx_mt_buyer_status ON marketplace_transactions(buyer_pubkey, status);
    CREATE INDEX idx_mt_seller_status ON marketplace_transactions(seller_pubkey, status);
`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fileDb(): Database.Database {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wash-30d-'));
    dirs.push(dir);
    const db = new Database(path.join(dir, 'state.db'));
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    return db;
}

type Row = { buyer_pubkey: string; seller_pubkey: string; credits: number };

/** The 30-day query as it was before the paging: one query (origin/main 48d2b72a, trust.ts). */
function mainRows(db: Database.Database): Row[] {
    return db.prepare(`
        SELECT buyer_pubkey, seller_pubkey, credits
        FROM marketplace_transactions
        WHERE status = 'completed' AND buyer_pubkey != seller_pubkey
          AND completed_at > datetime('now', '-30 days')
    `).all() as Row[];
}

/** The cluster step as it was before the paging, on main's rows (origin/main 48d2b72a, trust.ts, verbatim but the yields). */
function mainClusters(db: Database.Database): { flaggedClusters: Map<string, number>; clusterDetails: WashAnalysis['clusterDetails'] } {
    const flaggedClusters = new Map<string, number>();
    const clusterDetails: WashAnalysis['clusterDetails'] = [];
    const txs30 = mainRows(db);
    const adj = new Map<string, Set<string>>();
    const edgeVol30 = new Map<string, number>();
    const nodes30 = new Set<string>();
    for (const tx of txs30) {
        const u = tx.buyer_pubkey;
        const v = tx.seller_pubkey;
        nodes30.add(u);
        nodes30.add(v);
        if (!adj.has(u)) adj.set(u, new Set());
        if (!adj.has(v)) adj.set(v, new Set());
        adj.get(u)!.add(v);
        adj.get(v)!.add(u);
        const key = u < v ? `${u}|${v}` : `${v}|${u}`;
        edgeVol30.set(key, (edgeVol30.get(key) || 0) + tx.credits);
    }
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const node of nodes30) {
        if (visited.has(node)) continue;
        const comp: string[] = [];
        const queue = [node];
        visited.add(node);
        while (queue.length > 0) {
            const curr = queue.shift()!;
            comp.push(curr);
            for (const next of adj.get(curr) || new Set()) {
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
        components.push(comp);
    }
    const uniqueNodes = Array.from(nodes30);
    const memberAges = new Map<string, number>();
    for (let i = 0; i < uniqueNodes.length; i += 100) {
        const chunk = uniqueNodes.slice(i, i + 100);
        const rows = db.prepare(`SELECT public_key, joined_at FROM members WHERE public_key IN (${chunk.map(() => '?').join(',')})`)
            .all(...chunk) as { public_key: string; joined_at: string }[];
        for (const m of rows) {
            const joined = m.joined_at ? new Date(m.joined_at) : new Date();
            memberAges.set(m.public_key, (Date.now() - joined.getTime()) / (1000 * 60 * 60 * 24));
        }
    }
    let compIdx = 0;
    for (const comp of components) {
        if (comp.length > 12) continue;
        let internalVol = 0;
        for (let i = 0; i < comp.length; i++) {
            for (let j = i + 1; j < comp.length; j++) {
                const u = comp[i] < comp[j] ? comp[i] : comp[j];
                const v = comp[i] < comp[j] ? comp[j] : comp[i];
                internalVol += edgeVol30.get(`${u}|${v}`) || 0;
            }
        }
        const placeholders = comp.map(() => '?').join(',');
        const res = db.prepare(`
            SELECT COALESCE(SUM(credits), 0) as s FROM marketplace_transactions
            WHERE status = 'completed' AND (buyer_pubkey IN (${placeholders}) OR seller_pubkey IN (${placeholders}))
        `).get(...comp, ...comp) as { s: number };
        const totalVol = res ? res.s : 0;
        const insularity = totalVol > 0 ? (internalVol / totalVol) : 0;
        let newMembers = 0;
        for (const m of comp) if ((memberAges.get(m) ?? 0) < 14) newMembers++;
        const newRatio = comp.length > 0 ? (newMembers / comp.length) : 0;
        clusterDetails.push({ members: comp, internalVol, totalVol, insularity, newRatio, size: comp.length, newMembers });
        if (insularity >= 0.8 && newMembers >= comp.length / 2) for (const m of comp) flaggedClusters.set(m, compIdx);
        compIdx++;
    }
    return { flaggedClusters, clusterDetails };
}

/** SQLite's 30-day cutoff, to the second, as main's one query and the pages work it out. */
const cutoff = (db: Database.Database) => (db.prepare(`SELECT datetime('now', '-30 days') AS c`).get() as { c: string }).c;

/**
 * `f` run until no row's completed_at lies between the 30-day cutoff before it and the cutoff after it: then every cutoff
 * in between takes the same rows, so main's read and the pages' compare, whichever second each took its cutoff in. A row
 * can send it round again once at most, as the cutoff only moves on past it, so it always ends. (It asked for the same
 * second at both ends before, which a read pair taking a second or more on a busy machine can never meet: #1919's CI.)
 */
async function atOneCutoff<T>(db: Database.Database, f: () => T | Promise<T>): Promise<T> {
    const between = db.prepare('SELECT count(*) AS n FROM marketplace_transactions WHERE completed_at > ? AND completed_at <= ?');
    for (;;) {
        const before = cutoff(db);
        const r = await f();
        const after = cutoff(db);
        const [lo, hi] = before <= after ? [before, after] : [after, before];
        if ((between.get(lo, hi) as { n: number }).n === 0) return r;
    }
}

const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The large world: more than two default pages of the 30-day query, and a component larger than WASH_BFS_STEP_NODES. */
const LARGE = { members: WASH_BFS_STEP_NODES + 1500, trades: WASH_30_DAY_PAGE_ROWS + 3000, older: 2000, times: 300, selfTrades: 50 };
/** The small world, for pages of a few rows (a page a statement: thousands of them over the large one held a busy machine
 *  for seconds): a few hundred rows, about 25 on each completed_at, so ties still run across every page edge. */
const SMALL = { members: 120, trades: 200, older: 40, times: 12, selfTrades: 10 };

/**
 * A seeded graph over the 30-day query: completed_at drawn from few values, so ties run across every page edge; rows
 * around the 30-day boundary (the day before, the cutoff's own second and the next, ISO and SQLite forms); self-trades,
 * other statuses, older trades, 2-dp amounts in random row order; one component holding every member (the large world's
 * larger than WASH_BFS_STEP_NODES); rings of new members trading among themselves this month.
 */
function seedGraph(db: Database.Database, seed: number, size: typeof LARGE = LARGE): void {
    const rnd = mulberry32(seed);
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const sqliteForm = (msAgo: number) => iso(msAgo).slice(0, 19).replace('T', ' ');
    const day = 86400_000;
    const n = size.members;
    const key = (i: number) => `m${String(i).padStart(6, '0')}`;
    // Few distinct times: many rows share each.
    const times = Array.from({ length: size.times }, () => iso(Math.floor(rnd() * 29 * day) + 60_000));
    let id = 0;
    const ins = db.prepare('INSERT INTO marketplace_transactions (id, buyer_pubkey, seller_pubkey, credits, status, completed_at) VALUES (?, ?, ?, ?, ?, ?)');
    const trade = (b: string, s: string, credits: number, at: string | null, status = 'completed') =>
        ins.run(`t${seed}-${(id++).toString(36)}-${Math.floor(rnd() * 1e9).toString(36)}`, b, s, credits, status, at);
    const addMember = db.prepare('INSERT OR IGNORE INTO members (public_key, joined_at) VALUES (?, ?)');
    db.transaction(() => {
        for (let i = 0; i < n; i++) addMember.run(key(i), iso((rnd() < 0.3 ? 1 + rnd() * 10 : 20 + rnd() * 300) * day));
        const rows: [string, string, number, string | null, string][] = [];
        // A connected spine, so one component holds every member.
        for (let i = 1; i < n; i++) rows.push([key(i), key(Math.floor(rnd() * i)), Math.round(rnd() * 9000) / 100, times[Math.floor(rnd() * times.length)], 'completed']);
        for (let i = 0; i < size.trades; i++) {
            const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n);
            rows.push([key(a), key(b), Math.round(rnd() * 9000) / 100, times[Math.floor(rnd() * times.length)], rnd() < 0.05 ? 'pending' : 'completed']);
        }
        // Older trades: they count in the all-time totals, not in the 30-day graph.
        for (let i = 0; i < size.older; i++) rows.push([key(Math.floor(rnd() * n)), key(Math.floor(rnd() * n)), Math.round(rnd() * 9000) / 100, iso((31 + rnd() * 200) * day), 'completed']);
        // The boundary: the day before, the cutoff's day (ISO sorts after SQLite's form there), the cutoff's second and the next, NULL.
        for (const [b, s] of [[3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14]]) {
            for (const at of [iso(31 * day), iso(30 * day + 3_600_000), iso(30 * day - 3_600_000), sqliteForm(30 * day), sqliteForm(30 * day - 1000), sqliteForm(30 * day - 2000), null]) {
                rows.push([key(b), key(s), 12.34, at, 'completed']);
            }
        }
        // Rings of four new members, trading among themselves this month: flagged clusters.
        for (let r = 0; r < 6; r++) {
            const ring = [0, 1, 2, 3].map((j) => `ring${seed}-${r}-${j}`);
            for (const m of ring) addMember.run(m, iso(3 * day));
            for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) rows.push([ring[i], ring[j], 80.05, times[(r * 7 + i + j) % times.length], 'completed']);
        }
        // Self-trades.
        for (let i = 0; i < size.selfTrades; i++) rows.push([key(i), key(i), 10, times[i % times.length], 'completed']);
        // Random row order.
        for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
        for (const [b, s, c, at, st] of rows) trade(b, s, c, at, st);
    })();
}

/** The pages, but never more rows than `max`: pages that double a row could otherwise run on for ever. */
function pagesUpTo(db: Database.Database, size: number, max: number): Row[][] {
    const pages: Row[][] = [];
    let rows = 0;
    for (const p of thirtyDayTradePages(db, size)) {
        pages.push(p);
        if ((rows += p.length) > max) break;
    }
    return pages;
}

/** 'same', or where two long texts first differ: a short message, where a diff of two large texts can take minutes. */
function sameText(a: string, b: string): string {
    if (a === b) return 'same';
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `differ at ${i} of ${a.length} / ${b.length}: …${a.slice(Math.max(0, i - 60), i + 60)}… against …${b.slice(Math.max(0, i - 60), i + 60)}…`;
}

const json = (a: Pick<WashAnalysis, 'flaggedClusters' | 'clusterDetails'>) => JSON.stringify({ c: [...a.flaggedClusters], cd: a.clusterDetails });

/** Main's one query's rows and the pages' at each page size, compared (one cutoff's rows: atOneCutoff). */
async function samePagesAsMain(db: Database.Database, sizes: number[]): Promise<void> {
    for (const size of sizes) {
        const [ref, pages] = await atOneCutoff(db, () => { const r = mainRows(db); return [r, pagesUpTo(db, size, r.length)] as const; });
        const got = pages.flat().map(({ buyer_pubkey, seller_pubkey, credits }) => ({ buyer_pubkey, seller_pubkey, credits }));
        expect(got.length).toBe(ref.length);
        expect(sameText(JSON.stringify(got), JSON.stringify(ref))).toBe('same');
        // Full pages up to the last.
        for (const p of pages.slice(0, -1)) expect(p.length).toBe(size);
    }
}

// A minute a test: under CI's load, one with vitest's default 5 s timed out (#1919's CI, 3 of 7).
describe('wash analysis: the 30-day query in pages (#1908)', { timeout: 60_000 }, () => {
    for (const seed of [1, 2, 3]) {
        it(`seed ${seed}: the pages are main's one query's rows, in its order, none dropped and none doubled, at any page size`, async () => {
            const small = fileDb();
            seedGraph(small, seed, SMALL);
            await samePagesAsMain(small, [1, 2, 3, 7, 64]);
            // The small world holds what it is meant to: a few hundred rows, more than one page of 64.
            expect(mainRows(small).length).toBeGreaterThan(64 * 3);
            small.close();

            const db = fileDb();
            seedGraph(db, seed);
            const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT buyer_pubkey FROM marketplace_transactions WHERE status = 'completed'
                AND buyer_pubkey != seller_pubkey AND completed_at > datetime('now', '-30 days')`).all() as { detail: string }[]).map((p) => p.detail).join(' ');
            expect(plan).toMatch(/USING INDEX idx_marketplace_transactions_status_completed/);
            await samePagesAsMain(db, [7, 64, 1000, WASH_30_DAY_PAGE_ROWS]);
            const ref = mainRows(db);
            // The world holds what it is meant to: more than two default pages, and ties across every page edge.
            expect(ref.length).toBeGreaterThan(WASH_30_DAY_PAGE_ROWS * 2);
            db.close();
        });

        it(`seed ${seed}: the analysis is main's, to the last bit, in one go and in slices at 0 ms`, async () => {
            const db = fileDb();
            seedGraph(db, seed);
            const [ref, oneGo] = await atOneCutoff(db, () => [mainClusters(db), runWashTradingAnalysis(db)] as const);
            expect(ref.flaggedClusters.size).toBeGreaterThanOrEqual(24);
            expect(sameText(json(oneGo), json(ref))).toBe('same');
            const [ref2, sliced] = await atOneCutoff(db, async () => [mainClusters(db), await runWashAnalysisInSlices(db, { sliceMs: 0 })] as const);
            expect(sameText(json(sliced.analysis), json(ref2))).toBe('same');
            closeWashSnapshotHandle(db);
            db.close();
        });
    }

    it('a tie on completed_at across a page edge: the next page goes on by rowid', () => {
        const db = fileDb();
        const at = new Date(Date.now() - 86400_000).toISOString();
        const ins = db.prepare(`INSERT INTO marketplace_transactions (id, buyer_pubkey, seller_pubkey, credits, status, completed_at) VALUES (?, ?, ?, ?, 'completed', ?)`);
        for (let i = 0; i < 10; i++) ins.run(`z${9 - i}`, `b${i}`, `s${i}`, i, at);
        for (const size of [1, 2, 3, 4, 9, 10, 11]) {
            const got = pagesUpTo(db, size, 10).flat().map((r) => r.credits);
            expect(got).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        }
        db.close();
    });
});
