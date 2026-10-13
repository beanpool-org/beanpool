import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    PER_COUNTERPARTY_VOLUME_CAP, WASH_PAIR_PAGE_BUYERS, WASH_KEEP_MS, WASH_MIN_DUE_MS, WASH_HARD_CAP_MS, WASH_BACKGROUND_STEP_MS, runWashTradingAnalysis,
    runWashAnalysisInSlices, closeWashSnapshotHandle, washAnalysisCount, getWashTradingEnforcement, qualifiedTradeValue,
    clearWashTradingCache, refreshWashTradingInBackground, washRefreshRunning, type WashAnalysis,
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

    it('a refresh whose handle closes after its last step, before it returns, lands nothing', async () => {
        const db = fileDb();
        seedPagedWorld(db);
        let turns = 0;
        await runWashAnalysisInSlices(db, { sliceMs: 0, onYield: () => turns++ });
        let turn = 0;
        const run = runWashAnalysisInSlices(db, { sliceMs: 0, onYield: () => { if (++turn === turns) closeWashSnapshotHandle(db); } });
        await expect(run).rejects.toThrow(/snapshot ended/);
        expect(turn).toBe(turns);
        db.close();
    });

    it('a refresh with a step whose query fails lands nothing, where the one-go goes on without that step', async () => {
        const db = fileDb();
        seedPagedWorld(db);
        db.exec('DROP TABLE members');
        // One go, as today: the ages' query fails, is logged, and the analysis comes back without the clusters.
        expect(runWashTradingAnalysis(db).flaggedPairs.size).toBe(4);
        await expect(runWashAnalysisInSlices(db)).rejects.toThrow(/members/);
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('a file database whose snapshot does not open: the refresh lands nothing, and the next tries again', async () => {
        const db = fileDb();
        seedPagedWorld(db);
        const file = db.name;
        fs.renameSync(file, `${file}.away`); // the node's handle keeps the file open; a new handle on the path can't
        await expect(runWashAnalysisInSlices(db)).rejects.toThrow(/snapshot did not open/);
        fs.renameSync(`${file}.away`, file);
        // The next opens one: a wash pair completed between its slices is not in what it lands, which only a snapshot gives
        // (read through the node's own handle, the later pages of buyers would see it).
        const atStart = json(runWashTradingAnalysis(db));
        let wrote = false;
        const retry = await runWashAnalysisInSlices(db, {
            sliceMs: 0,
            onYield: () => {
                if (wrote) return;
                wrote = true;
                trade(db, 'late-a', 'late-b', 400);
                trade(db, 'late-b', 'late-a', 390);
            },
        });
        expect(wrote).toBe(true);
        expect(json(retry.analysis)).toBe(atStart);
        expect(runWashTradingAnalysis(db).flaggedPairs.has('late-a|late-b')).toBe(true);
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

// --- S2: what floors read: modes, due time, hard cap, newer wins, the live pair rule ---

/** Date.now and performance.now under the test's hand: \`perStep\` is what each performance.now read adds (a step's time). */
function fakeClocks() {
    const realNow = Date.now;
    const realPerf = performance.now;
    const c = { wall: realNow(), perf: 0, perStep: 0 };
    Date.now = () => c.wall;
    performance.now = () => (c.perf += c.perStep);
    return Object.assign(c, { restore: () => { Date.now = realNow; performance.now = realPerf; } });
}
let clock: ReturnType<typeof fakeClocks> | null = null;
afterEach(() => { clock?.restore(); clock = null; });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Old members with honest trades, a pair (pa, pb) each with an honest partner, and a ring of four members three days old. */
function seedRaceWorld(db: Database.Database) {
    for (const k of ['o1', 'o2', 'o3', 'o4', 'pa', 'pb']) member(db, k, 90);
    const ring = ['r1', 'r2', 'r3', 'r4'];
    for (const k of ring) member(db, k, 3);
    trade(db, 'pa', 'o1', 120);
    trade(db, 'o2', 'pb', 130);
    trade(db, 'o3', 'o4', 75);
    return ring;
}
function completeRaceTrades(db: Database.Database, ring: string[]): void {
    trade(db, 'pa', 'pb', 300, daysAgo(0));
    trade(db, 'pb', 'pa', 290, daysAgo(0));
    for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) trade(db, ring[i], ring[j], 90, daysAgo(0));
}

describe('wash analysis: what floors read (S2)', () => {
    it('race: writes between a refresh\'s slices never give more than today\'s rules; pairs are caught at once, rings when a refresh with them lands', async () => {
        const db = fileDb();
        const ring = seedRaceWorld(db);
        const members = ['pa', 'pb', ...ring, 'o1', 'o2'];
        clock = fakeClocks();
        clock.perStep = 60; // every step "holds the loop" 60 ms: background mode
        const before = getWashTradingEnforcement(db); // none yet: one go, now
        expect(washRefreshRunning(db)).toBeNull();
        clock.wall += WASH_KEEP_MS;
        expect(getWashTradingEnforcement(db)).toBe(before); // due: a refresh starts, the read gets the last one at once
        const refresh = washRefreshRunning(db);
        expect(refresh).not.toBeNull();
        await turn(); // the refresh takes its snapshot and its first slice
        completeRaceTrades(db, ring);
        let reads = 0;
        while (washRefreshRunning(db)) {
            const now = runWashTradingAnalysis(db);
            for (const k of members) {
                const q = qualifiedTradeValue(db, k);
                expect(q).toBeLessThanOrEqual(Math.max(qualifiedTradeValue(db, k, before), qualifiedTradeValue(db, k, now)));
            }
            // The pair counts for nothing from the first read after its trades; each keeps its honest partner.
            expect(qualifiedTradeValue(db, 'pa')).toBe(120);
            expect(qualifiedTradeValue(db, 'pb')).toBe(130);
            // The ring's trades count, as they did with the analysis in hand before (today's rule within its window).
            for (const k of ring) expect(qualifiedTradeValue(db, k)).toBe(qualifiedTradeValue(db, k, before));
            reads++;
            await turn();
        }
        expect(reads).toBeGreaterThan(2);
        // That refresh read the rows from before the trades: the ring is still not flagged.
        const landed = getWashTradingEnforcement(db);
        expect(landed).not.toBe(before);
        for (const k of ring) expect(qualifiedTradeValue(db, k)).toBeGreaterThan(0);
        // The next refresh, due 10 s after that snapshot, reads them: then the ring counts for nothing, as a one go now.
        clock.wall += WASH_KEEP_MS;
        getWashTradingEnforcement(db);
        await washRefreshRunning(db);
        const now = runWashTradingAnalysis(db);
        for (const k of members) expect(qualifiedTradeValue(db, k)).toBe(qualifiedTradeValue(db, k, now));
        for (const k of ring) expect(qualifiedTradeValue(db, k)).toBe(0);
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('the live pair rule: a wash pair counts for nothing with an analysis from before its trades; lopsided pairs still count', () => {
        const db = new Database(':memory:');
        db.exec(SCHEMA);
        seedRaceWorld(db);
        const before = runWashTradingAnalysis(db);
        completeRaceTrades(db, []);
        trade(db, 'o3', 'o4', 500);
        trade(db, 'o4', 'o3', 60);
        expect(qualifiedTradeValue(db, 'pa', before)).toBe(120);
        expect(qualifiedTradeValue(db, 'pb', before)).toBe(130);
        expect(qualifiedTradeValue(db, 'o3', before)).toBe(500);
        // Exactly on the line is not a wash pair (r < 0.15): 287.50 / 212.50 over a gross of 500.
        trade(db, 'o1', 'o2', 287.5);
        trade(db, 'o2', 'o1', 212.5);
        expect(qualifiedTradeValue(db, 'o1', before)).toBe(120 + 500);
    });

    it('no analysis: one is worked out in one go at the read, with no turn given; a clear drops a refresh in flight', async () => {
        const db = fileDb();
        seedRaceWorld(db);
        clock = fakeClocks();
        clock.perStep = 60;
        const n0 = washAnalysisCount(db);
        const first = getWashTradingEnforcement(db);
        expect(washAnalysisCount(db) - n0).toBe(1);
        expect(washRefreshRunning(db)).toBeNull();
        expect(qualifiedTradeValue(db, 'pa')).toBe(qualifiedTradeValue(db, 'pa', runWashTradingAnalysis(db)));
        // A refresh takes its snapshot; the cache is cleared; it lands nothing, and the next read works one out now.
        clock.wall += WASH_KEEP_MS;
        expect(getWashTradingEnforcement(db)).toBe(first);
        await turn();
        clearWashTradingCache(db);
        completeRaceTrades(db, []);
        await washRefreshRunning(db);
        const n1 = washAnalysisCount(db);
        const fresh = getWashTradingEnforcement(db);
        expect(washAnalysisCount(db) - n1).toBe(1);
        expect(fresh.flaggedPairs.has('pa|pb')).toBe(true);
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('a background result whose snapshot is older than the one serving never replaces it (the boot\'s refresh, a read first)', async () => {
        const db = fileDb();
        seedRaceWorld(db);
        clock = fakeClocks();
        clock.perStep = 60;
        const boot = refreshWashTradingInBackground(db);
        await turn(); // its snapshot is taken
        clock.wall += 1;
        const atRead = getWashTradingEnforcement(db); // none yet: one go, now, a later snapshot
        await boot;
        expect(getWashTradingEnforcement(db)).toBe(atRead);
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('hard cap: with a refresh in flight that never lands, a snapshot 60 s old is worked out in one go at the read; 1 ms short of it, the read waits for nothing', async () => {
        const db = fileDb();
        seedRaceWorld(db);
        clock = fakeClocks();
        clock.perStep = 60;
        const first = getWashTradingEnforcement(db);
        const n = washAnalysisCount(db);
        // A due read starts a refresh; the loop never turns here, so it never lands.
        clock.wall += WASH_KEEP_MS;
        expect(getWashTradingEnforcement(db)).toBe(first);
        const inFlight = washRefreshRunning(db);
        expect(inFlight).not.toBeNull();
        clock.wall += WASH_HARD_CAP_MS - WASH_KEEP_MS - 1;
        expect(getWashTradingEnforcement(db)).toBe(first);
        expect(washAnalysisCount(db)).toBe(n);
        expect(washRefreshRunning(db)).toBe(inFlight);
        clock.wall += 1;
        const capped = getWashTradingEnforcement(db);
        expect(capped).not.toBe(first);
        expect(washAnalysisCount(db)).toBe(n + 1);
        await inFlight;
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('race: after a quiet spell, a read never gives more than today\'s rule (one go at any read 10 s after the last finished)', async () => {
        // The clock today's rule is judged by: a step's time passes on the wall too, so an analysis finishes `c` after it
        // started, as in real time.
        const realNow = Date.now;
        const realPerf = performance.now;
        const t = { jump: 0, perf: 0 };
        const base = realNow();
        performance.now = () => (t.perf += 60);
        Date.now = () => base + t.jump + Math.floor(t.perf);
        try {
            for (const quietMs of [3_000, 4_000, 5_500, 7_000, 20_000, 35_000, WASH_HARD_CAP_MS - 7_000]) {
                const db = fileDb();
                const ring = seedRaceWorld(db);
                const members = [...ring, 'pa', 'pb', 'o1'];
                // No analysis yet: the head works one out in one go; what that held the loop, today's one-go holds it too.
                const w0 = Date.now();
                getWashTradingEnforcement(db);
                const oneGoMs = Date.now() - w0;
                expect(oneGoMs).toBeGreaterThanOrEqual(WASH_BACKGROUND_STEP_MS); // background mode from here
                // Today's rule, beside the head on the same rows at the same moments.
                let today: { analysis: WashAnalysis; finishedAt: number } | null = null;
                const todays = () => {
                    if (!today || Date.now() - today.finishedAt >= WASH_KEEP_MS) {
                        const analysis = runWashTradingAnalysis(db);
                        t.perf += oneGoMs;
                        today = { analysis, finishedAt: Date.now() };
                    }
                    return today.analysis;
                };
                const read = (label: string) => {
                    const head = members.map((k) => qualifiedTradeValue(db, k));
                    const oracle = todays();
                    members.forEach((k, i) => {
                        const allowed = qualifiedTradeValue(db, k, oracle);
                        if (head[i] > allowed) throw new Error(`quiet ${quietMs} ms, ${label}: ${k} qualifies ${head[i]}, today's rule ${allowed}`);
                    });
                    return head.slice(0, ring.length);
                };
                read('t0');
                t.jump += 1_000;
                completeRaceTrades(db, ring); // a ring of new members completes its trades
                t.jump += 4_000;
                expect(read('t+5 s').every((q) => q > 0)).toBe(true); // inside today's 10 s window, both still count it
                t.jump += quietMs; // no floor read
                const spend = read('the spend read');
                // Past today's window both work one out now; short of it both still read the last.
                if (quietMs + 5_000 >= WASH_KEEP_MS + 1_000) expect(spend.every((q) => q === 0)).toBe(true);
                // Then a read every 50 ms, up to and including the one that starts a refresh. (While a refresh runs, reads get
                // the last analysis for its D: the design's accepted "D growing" residual, measured on real nodes by race C.)
                for (let i = 0; !washRefreshRunning(db) && i < 600; i++) {
                    t.jump += 50;
                    read(`read ${i} after the spend`);
                }
                expect(washRefreshRunning(db)).not.toBeNull();
                await washRefreshRunning(db);
                closeWashSnapshotHandle(db);
                db.close();
            }
        } finally {
            Date.now = realNow;
            performance.now = realPerf;
        }
    });

    it('after a quiet spell, the bound on a refresh that landed is 10 s + its step time c, not its wall time D: one go 50 ms past it, none 50 ms short', async () => {
        for (const past of [-50, 50]) {
            const db = fileDb();
            const ring = seedRaceWorld(db);
            clock = fakeClocks();
            clock.perStep = 60;
            const first = getWashTradingEnforcement(db);
            // The refresh's c on these rows: every step reads the clock twice, 60 ms apart.
            const { stepMs: c } = await runWashAnalysisInSlices(db);
            clock.wall += WASH_KEEP_MS;
            getWashTradingEnforcement(db); // due: refresh R starts
            const snapshotAt = clock.wall;
            await turn(); // R has taken its snapshot
            completeRaceTrades(db, ring); // a ring completes after it
            // Each turn R gives costs it 1 s of wall time: its D − c is seconds.
            let turns = 0;
            while (washRefreshRunning(db)) { await turn(); clock.perf += 1000; turns++; }
            expect(turns).toBeGreaterThanOrEqual(2);
            const landed = getWashTradingEnforcement(db);
            expect(landed).not.toBe(first);
            for (const k of ring) expect(qualifiedTradeValue(db, k)).toBeGreaterThan(0); // R read the rows before the ring
            // A quiet spell: no read until 10 s + c after R's snapshot, ± 50 ms.
            clock.wall = snapshotAt + WASH_KEEP_MS + c + past;
            const n = washAnalysisCount(db);
            const q = ring.map((k) => qualifiedTradeValue(db, k));
            if (past > 0) {
                expect(washAnalysisCount(db) - n).toBe(1); // one go at the read, as today
                expect(q.every((v) => v === 0)).toBe(true);
            } else {
                expect(washAnalysisCount(db)).toBe(n); // short of the bound: the read gets R's and starts the next (due)
                expect(getWashTradingEnforcement(db)).toBe(landed);
                expect(washRefreshRunning(db)).not.toBeNull();
            }
            await washRefreshRunning(db);
            clock.restore();
            clock = null;
            closeWashSnapshotHandle(db);
            db.close();
        }
    });

    it('race: a refresh that can no longer land holds off no one-go read (a take-over at boot, then Step 6.1: `again` chains a second)', async () => {
        // An in-process promotion at boot (takeover.ts resumeTakeoverAtBoot): the take-over hook clears the analysis and
        // starts refresh R_t; Step 6.1 asks for one while R_t runs, so R_2 starts when R_t ends. The first floor read finds no
        // analysis and works one out in one go: R_t's older snapshot can no longer land. A ring forms; each refresh stalls
        // (the clock moves, the loop does not turn) 15 s, past 10 s + c. Today's rule beside the head, as in the race above.
        const realNow = Date.now;
        const realPerf = performance.now;
        const t = { jump: 0, perf: 0 };
        const base = realNow();
        performance.now = () => (t.perf += 60);
        Date.now = () => base + t.jump + Math.floor(t.perf);
        try {
            const db = fileDb();
            const ring = seedRaceWorld(db);
            const members = [...ring, 'pa', 'pb', 'o1'];
            clearWashTradingCache(db); // the take-over hook...
            void refreshWashTradingInBackground(db); // ...and its refresh R_t
            const rT = washRefreshRunning(db);
            void refreshWashTradingInBackground(db); // Step 6.1 while R_t runs: again
            await turn(); // R_t has taken its snapshot
            const w0 = Date.now();
            const oneGo = getWashTradingEnforcement(db); // the first floor read: none yet, one go
            const oneGoMs = Date.now() - w0;
            expect(oneGoMs).toBeGreaterThanOrEqual(WASH_BACKGROUND_STEP_MS);
            expect(washRefreshRunning(db)).toBe(rT);
            let today: { analysis: WashAnalysis; finishedAt: number } | null = null;
            const todays = () => {
                if (!today || Date.now() - today.finishedAt >= WASH_KEEP_MS) {
                    const analysis = runWashTradingAnalysis(db);
                    t.perf += oneGoMs;
                    today = { analysis, finishedAt: Date.now() };
                }
                return today.analysis;
            };
            const read = (label: string) => {
                const head = members.map((k) => qualifiedTradeValue(db, k));
                const oracle = todays();
                members.forEach((k, i) => {
                    const allowed = qualifiedTradeValue(db, k, oracle);
                    if (head[i] > allowed) throw new Error(`${label}: ${k} qualifies ${head[i]}, today's rule ${allowed}`);
                });
                return head.slice(0, ring.length);
            };
            read('the one go');
            t.jump += 1_000;
            completeRaceTrades(db, ring); // a ring of new members completes its trades
            const n = washAnalysisCount(db);
            for (let i = 0; i < 300; i++) { t.jump += 50; read(`R_t stalled, read ${i}`); }
            expect(washRefreshRunning(db)).toBe(rT);
            expect(washAnalysisCount(db) - n).toBeGreaterThanOrEqual(1); // past 10 s + c: one go at the read
            expect(getWashTradingEnforcement(db)).not.toBe(oneGo);
            expect(read('R_t stalled, last').every((q) => q === 0)).toBe(true);
            // R_t ends, landing nothing; R_2 starts.
            for (let i = 0; washRefreshRunning(db) === rT && i < 1000; i++) { await turn(); read(`R_t running, turn ${i}`); }
            const r2 = washRefreshRunning(db);
            expect(r2).not.toBeNull();
            expect(r2).not.toBe(rT);
            await turn(); // R_2 has taken its snapshot, after the last one go: it can land
            for (let i = 0; i < 300; i++) { t.jump += 50; read(`R_2 stalled, read ${i}`); }
            const m = washAnalysisCount(db);
            await r2;
            expect(washAnalysisCount(db) - m).toBe(1); // R_2's own
            read('R_2 landed');
            const now = runWashTradingAnalysis(db);
            for (const k of members) expect(qualifiedTradeValue(db, k)).toBe(qualifiedTradeValue(db, k, now));
            closeWashSnapshotHandle(db);
            db.close();
        } finally {
            Date.now = realNow;
            performance.now = realPerf;
        }
    });

    it('mode: a quick analysis (under 50 ms of steps) stays one go, every 10 s of reads, and never starts a refresh', () => {
        const db = fileDb();
        seedRaceWorld(db);
        clock = fakeClocks();
        clock.perStep = 0.1;
        const n = washAnalysisCount(db);
        for (let i = 0; i < 100; i++) {
            getWashTradingEnforcement(db);
            expect(washRefreshRunning(db)).toBeNull();
            clock.wall += 600;
        }
        // 60 s of reads: one at the start, then one each 10 s (the reads at 10.2, 20.4, ... s).
        expect(washAnalysisCount(db) - n).toBe(6);
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('due time: 10 s after the snapshot less the time a refresh\'s turns took, never sooner than 7 s', async () => {
        const db = fileDb();
        seedRaceWorld(db);
        clock = fakeClocks();
        clock.perStep = 60;
        const first = getWashTradingEnforcement(db);
        // After a one-go analysis, due within 10 s and not before 7 s (here each clock read "takes" 60 ms, so D > c a little).
        clock.wall += WASH_MIN_DUE_MS - 1;
        expect(getWashTradingEnforcement(db)).toBe(first);
        expect(washRefreshRunning(db)).toBeNull();
        clock.wall += WASH_KEEP_MS - WASH_MIN_DUE_MS + 1;
        getWashTradingEnforcement(db);
        const running = washRefreshRunning(db);
        expect(running).not.toBeNull();
        const snapshotAt = clock.wall;
        // Each turn the refresh gives costs it 1 s of wall time: D − c is several seconds.
        let turns = 0;
        // The wall clock moves too, so a stamp at the finish would be seconds later than the snapshot.
        while (washRefreshRunning(db)) { await turn(); clock.perf += 1000; clock.wall += 500; turns++; }
        expect(turns).toBeGreaterThanOrEqual(4); // D − c ≥ 4 s
        const landed = getWashTradingEnforcement(db);
        expect(landed).not.toBe(first);
        // D − c > 3 s: due at the 7 s floor, not before.
        clock.wall = snapshotAt + WASH_MIN_DUE_MS - 1;
        getWashTradingEnforcement(db);
        expect(washRefreshRunning(db)).toBeNull();
        clock.wall = snapshotAt + WASH_MIN_DUE_MS;
        getWashTradingEnforcement(db);
        expect(washRefreshRunning(db)).not.toBeNull();
        await washRefreshRunning(db);
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('a due read starts the refresh at the loop\'s next turn, never inside the read', async () => {
        const db = fileDb();
        seedRaceWorld(db);
        clock = fakeClocks();
        clock.perStep = 60;
        getWashTradingEnforcement(db);
        clock.wall += WASH_KEEP_MS;
        getWashTradingEnforcement(db);
        // Written in the same turn as the read: the refresh has read nothing yet, so it lands with these rows.
        completeRaceTrades(db, []);
        await washRefreshRunning(db);
        expect(getWashTradingEnforcement(db).flaggedPairs.has('pa|pb')).toBe(true);
        closeWashSnapshotHandle(db);
        db.close();
    });

    it('a refresh asked for while one runs starts when that one ends', async () => {
        const db = fileDb();
        seedRaceWorld(db);
        const n = washAnalysisCount(db);
        const a = refreshWashTradingInBackground(db);
        const b = refreshWashTradingInBackground(db);
        await a;
        await b;
        expect(washAnalysisCount(db) - n).toBe(2);
        expect(washRefreshRunning(db)).toBeNull();
        closeWashSnapshotHandle(db);
        db.close();
    });
});
