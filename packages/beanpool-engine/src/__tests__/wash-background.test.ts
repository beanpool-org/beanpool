import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    PER_COUNTERPARTY_VOLUME_CAP, WASH_PAIR_PAGE_BUYERS, runWashTradingAnalysis, runWashAnalysisInSlices, closeWashSnapshotHandle,
    washAnalysisCount, type WashAnalysis,
} from '../trust.js';

// The wash analysis in the background (#1811, scratch/global-node/DESIGN-wash-analysis-background-fable.md).

const SCHEMA = `
    CREATE TABLE members (public_key TEXT PRIMARY KEY, joined_at TEXT);
    CREATE TABLE marketplace_transactions (
        id TEXT PRIMARY KEY, buyer_pubkey TEXT NOT NULL, seller_pubkey TEXT NOT NULL, credits REAL, status TEXT, completed_at TEXT
    );
    CREATE INDEX idx_mt_buyer_status ON marketplace_transactions(buyer_pubkey, status);
    CREATE INDEX idx_mt_seller_status ON marketplace_transactions(seller_pubkey, status);
`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fileDb(): Database.Database {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wash-bg-'));
    dirs.push(dir);
    const db = new Database(path.join(dir, 'state.db'));
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    return db;
}

const key = (i: number) => `k${String(i).padStart(6, '0')}`;
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
let tradeN = 0;
function trade(db: Database.Database, buyer: string, seller: string, credits: number, at = daysAgo(60)): void {
    db.prepare(`INSERT INTO marketplace_transactions (id, buyer_pubkey, seller_pubkey, credits, status, completed_at) VALUES (?, ?, ?, ?, 'completed', ?)`)
        .run(`t${tradeN++}`, buyer, seller, credits, at);
}
function member(db: Database.Database, pk: string, joinedDaysAgo: number): void {
    db.prepare('INSERT OR IGNORE INTO members (public_key, joined_at) VALUES (?, ?)').run(pk, daysAgo(joinedDaysAgo));
}

/** The pair step as it was before the paging: one GROUP BY over every completed trade (origin/main 78b24da0). */
function unpagedPairs(db: Database.Database): { flagged: string[]; details: WashAnalysis['pairDetails'] } {
    const rows = db.prepare(`SELECT buyer_pubkey, seller_pubkey, SUM(credits) as vol FROM marketplace_transactions
        WHERE status = 'completed' AND buyer_pubkey != seller_pubkey GROUP BY buyer_pubkey, seller_pubkey`).all() as { buyer_pubkey: string; seller_pubkey: string; vol: number }[];
    const pairs = new Map<string, { u: string; v: string; uv: number; vu: number }>();
    for (const r of rows) {
        const [u, v] = r.buyer_pubkey < r.seller_pubkey ? [r.buyer_pubkey, r.seller_pubkey] : [r.seller_pubkey, r.buyer_pubkey];
        const k = `${u}|${v}`;
        const d = pairs.get(k) ?? { u, v, uv: 0, vu: 0 };
        pairs.set(k, d);
        if (r.buyer_pubkey === u) d.uv += r.vol; else d.vu += r.vol;
    }
    const flagged: string[] = [];
    const details: WashAnalysis['pairDetails'] = [];
    for (const [k, d] of pairs) {
        const gross = d.uv + d.vu;
        if (gross < PER_COUNTERPARTY_VOLUME_CAP) continue;
        const r = Math.abs(d.uv - d.vu) / gross;
        details.push({ a: d.u, b: d.v, gross, r });
        if (r < 0.15) flagged.push(k);
    }
    return { flagged, details };
}

const json = (a: WashAnalysis) => JSON.stringify({ p: [...a.flaggedPairs], c: [...a.flaggedClusters], cd: a.clusterDetails, pd: a.pairDetails });

/** A world over several pages of buyers, with wash pairs whose two sides' buyers lie pages apart, and a ring of new members. */
function seedPagedWorld(db: Database.Database): string[] {
    const n = WASH_PAIR_PAGE_BUYERS * 2 + 500;
    db.transaction(() => {
        for (let i = 0; i < n; i++) {
            member(db, key(i), 90);
            trade(db, key(i), key((i * 7 + 3) % n), 20 + (i % 50) + 0.37);
        }
        // Wash pairs: one side's buyer in the first page, the other's in the last; and the pages' edge buyers.
        for (const [a, b] of [[0, n - 1], [5, n - 7], [WASH_PAIR_PAGE_BUYERS - 1, WASH_PAIR_PAGE_BUYERS], [WASH_PAIR_PAGE_BUYERS * 2 - 1, 1]]) {
            trade(db, key(a), key(b), 300.11);
            trade(db, key(b), key(a), 289.93);
        }
        // An honest pair: lopsided.
        trade(db, key(10), key(11), 500);
        trade(db, key(11), key(10), 50);
        // A ring of four new members, trading among themselves this month.
        const ring = ['ring-a', 'ring-b', 'ring-c', 'ring-d'];
        for (const r of ring) member(db, r, 3);
        for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) trade(db, ring[i], ring[j], 80, daysAgo(2));
    })();
    return [key(0), key(n - 1)];
}

describe('wash analysis: paged pair totals (S1)', () => {
    it('reads the pair totals a page of buyers at a time and gives the one-query totals exactly', () => {
        const db = new Database(':memory:');
        db.exec(SCHEMA);
        const [a, b] = seedPagedWorld(db);
        const analysis = runWashTradingAnalysis(db);
        const ref = unpagedPairs(db);
        expect(JSON.stringify(analysis.pairDetails)).toBe(JSON.stringify(ref.details));
        expect([...analysis.flaggedPairs]).toEqual(ref.flagged);
        expect(analysis.flaggedPairs.size).toBe(4);
        expect(analysis.flaggedPairs.has(`${a}|${b}`)).toBe(true);
        expect(new Set(analysis.flaggedClusters.values()).size).toBe(1);
    });

    it('a refresh in slices, through a read-only snapshot or at 0 ms, gives the one-go analysis', async () => {
        const db = fileDb();
        seedPagedWorld(db);
        const oneGo = runWashTradingAnalysis(db);
        let turns = 0;
        const sliced = await runWashAnalysisInSlices(db, { sliceMs: 0, onYield: () => turns++ });
        expect(json(sliced.analysis)).toBe(json(oneGo));
        // At 0 ms every step is a slice: more than one page of buyers, so more than one turn before the pairs are done.
        expect(turns).toBeGreaterThan(3);
        expect(sliced.stepMs).toBeGreaterThan(0);
        expect(sliced.wallMs).toBeGreaterThanOrEqual(sliced.stepMs);
        const memory = new Database(':memory:');
        memory.exec(SCHEMA);
        seedPagedWorld(memory);
        expect(json((await runWashAnalysisInSlices(memory, { sliceMs: 0 })).analysis)).toBe(json(runWashTradingAnalysis(memory)));
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('reads one snapshot: rows rewritten and added between its slices change nothing in what it lands', async () => {
        const db = fileDb();
        seedPagedWorld(db);
        const atStart = json(runWashTradingAnalysis(db));
        let wrote = false;
        const run = await runWashAnalysisInSlices(db, {
            sliceMs: 0,
            onYield: () => {
                if (wrote) return;
                wrote = true;
                // Every trade row rewritten with a new rowid, a new wash pair and 500 more trades, between two slices.
                db.transaction(() => {
                    const rows = db.prepare('SELECT * FROM marketplace_transactions').all() as Record<string, unknown>[];
                    db.prepare('DELETE FROM marketplace_transactions').run();
                    const ins = db.prepare(`INSERT OR REPLACE INTO marketplace_transactions (id, buyer_pubkey, seller_pubkey, credits, status, completed_at)
                        VALUES (@id, @buyer_pubkey, @seller_pubkey, @credits, @status, @completed_at)`);
                    for (const r of rows.reverse()) ins.run(r);
                    trade(db, 'late-a', 'late-b', 400);
                    trade(db, 'late-b', 'late-a', 390);
                    for (let i = 0; i < 500; i++) trade(db, key(i), key(i + 1), 11);
                })();
            },
        });
        expect(wrote).toBe(true);
        expect(json(run.analysis)).toBe(atStart);
        expect(run.analysis.flaggedPairs.has('late-a|late-b')).toBe(false);
        // The rows as they now stand: the next analysis sees the late pair.
        expect(runWashTradingAnalysis(db).flaggedPairs.has('late-a|late-b')).toBe(true);
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('a refresh whose snapshot handle closes under it lands nothing', async () => {
        const db = fileDb();
        seedPagedWorld(db);
        let closed = false;
        const run = runWashAnalysisInSlices(db, { sliceMs: 0, onYield: () => { if (!closed) { closed = true; closeWashSnapshotHandle(db); } } });
        await expect(run).rejects.toThrow();
        expect(closed).toBe(true);
        // The next refresh opens a new handle.
        expect(json((await runWashAnalysisInSlices(db)).analysis)).toBe(json(runWashTradingAnalysis(db)));
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('counts every complete analysis for the node\'s own handle, a refresh through the snapshot included', async () => {
        const db = fileDb();
        seedPagedWorld(db);
        const before = washAnalysisCount(db);
        runWashTradingAnalysis(db);
        await runWashAnalysisInSlices(db);
        expect(washAnalysisCount(db) - before).toBe(2);
        closeWashSnapshotHandle(db);
        db.close();
    });
});
