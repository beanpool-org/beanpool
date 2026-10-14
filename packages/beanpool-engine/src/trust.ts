// Trust & fraud read core — the trust-floor formula and the wash/Sybil trade
// analysis that feeds it. Pure reads: nothing here mutates the database, so it
// is safe to run against a live node DB or a read-only replica alike.
//
// Extracted verbatim from apps/server/src/state-engine.ts (TRUST STATS section)
// so the node and the fleet manager compute an identical floor instead of the
// manager keeping a hand-copied, drift-prone reimplementation.
import type Database from 'better-sqlite3';
import { earnedCreditFromValue, getTier, knownGrantFor, PROTOCOL_CONSTANTS, PER_COUNTERPARTY_VOLUME_CAP } from '@beanpool/core';
import type { TrustStats, TierInfo } from '@beanpool/core';
import { prepared } from './statements.js';
import { memberUsableKnownGrant, creditCap, confirmationDialOn, enterpriseKnownShareOf, isConfirmed, knownFloor, knownFloorException } from './known-floor.js';

type Db = Database.Database;

// A2-26: cap how much volume to a SINGLE counterparty counts toward earned credit /
// governance credit, so a Sybil pair can't wash-trade between themselves to inflate
// either (earned credit deepens the overdraft floor; governance credit buys votes).
// Tuning (owner decision 2026-07-05): Lowered cap from 5000 to 500. One solid trade
// banks a partner; repeat trades add nothing. Legitimate users need more distinct
// counterparties to build deep credit.
// CANONICAL tuning knob — single source of truth for volume caps (defined in @beanpool/core).
export { PER_COUNTERPARTY_VOLUME_CAP };

export interface WashAnalysis {
    flaggedPairs: Set<string>;
    flaggedClusters: Map<string, number>;
    clusterDetails: {
        members: string[];
        internalVol: number;
        totalVol: number;
        insularity: number;
        newRatio: number;
        size: number;
        newMembers: number;
    }[];
    pairDetails: {
        a: string;
        b: string;
        gross: number;
        r: number;
    }[];
}

export function runWashTradingAnalysis(db: Db): WashAnalysis {
    return drainSteps(washTradingAnalysisSteps(db));
}

/** Runs a step generator to its end in one go and returns its result. */
export function drainSteps<T>(steps: Generator<void, T>): T {
    for (;;) {
        const r = steps.next();
        if (r.done) return r.value;
    }
}

/**
 * Steps a slice runs one after another, giving the event loop a turn (setImmediate) whenever a slice has held it for
 * `sliceMs` (default 20). A slice can't split a step. `onYield` is called at each turn given (a test counts them).
 * The wash/Sybil audit (audit.ts computeWashSybilMetricsInSlices) and the wash analysis's background refresh
 * (runWashAnalysisInSlices) both run this way.
 */
export async function runStepsInSlices<T>(steps: Generator<void, T>, opts: { sliceMs?: number; onYield?: () => void } = {}): Promise<T> {
    const sliceMs = opts.sliceMs ?? 20;
    let sliceStart = performance.now();
    for (;;) {
        const r = steps.next();
        if (r.done) return r.value;
        if (performance.now() - sliceStart >= sliceMs) {
            opts.onYield?.();
            await new Promise<void>((resolve) => setImmediate(resolve));
            sliceStart = performance.now();
        }
    }
}

/** `steps`, adding the time each step holds the loop to `time.ms` (the analysis's step time, its `c`). */
function* timedSteps<T>(steps: Generator<void, T>, time: { ms: number }): Generator<void, T> {
    for (;;) {
        const start = performance.now();
        const r = steps.next();
        time.ms += performance.now() - start;
        if (r.done) return r.value;
        yield;
    }
}

/**
 * Buyers one page of the pair totals reads (washTradingAnalysisSteps' first step). Measured on the 100,000-member review
 * world (101,400 completed trades, an M4 at load 30-50, 2026-10-13): 2,000 buyers is 28 pages, the worst 43 ms warm and
 * 273 ms cold; 1,000 was 57 / 137 ms, 5,000 was 268 / 443 ms, and the whole query in one 896 ms warm.
 */
export const WASH_PAIR_PAGE_BUYERS = 2000;

/**
 * Trades one page of the 30-day query reads (the cluster step's first, #1908). Set from the 100,000-member review world
 * (39,925 trades in 30 days): see the PR for the step times.
 */
export const WASH_30_DAY_PAGE_ROWS = 5000;

/** Members the cluster step's search visits between yields (#1908). */
export const WASH_BFS_STEP_NODES = 5000;

/** A row of the 30-day query: a completed trade between two members, completed in the last 30 days. */
export interface ThirtyDayTrade {
    buyer_pubkey: string;
    seller_pubkey: string;
    credits: number;
}

/**
 * The cluster step's 30-day query, a page at a time: every completed trade between two members, completed after
 * datetime('now', '-30 days') (worked out once, before the first page), `pageRows` rows a page. The pages run on in
 * (completed_at, rowid) order, the order of the index the one query read through (idx_marketplace_transactions_status_completed:
 * status, completed_at, then rowid), so together they are its rows in its order: the same edges, summed in the same order.
 * A tie on completed_at goes on by rowid, so a page's edge drops no row and doubles none.
 */
export function* thirtyDayTradePages(db: Db, pageRows = WASH_30_DAY_PAGE_ROWS): Generator<ThirtyDayTrade[]> {
    const { since } = db.prepare(`SELECT datetime('now', '-30 days') AS since`).get() as { since: string };
    const firstPage = db.prepare(`
        SELECT rowid AS rid, completed_at AS at, buyer_pubkey, seller_pubkey, credits
        FROM marketplace_transactions
        WHERE status = 'completed' AND buyer_pubkey != seller_pubkey
          AND completed_at > ?
        ORDER BY completed_at, rowid LIMIT ?
    `);
    const nextPage = db.prepare(`
        SELECT rowid AS rid, completed_at AS at, buyer_pubkey, seller_pubkey, credits
        FROM marketplace_transactions
        WHERE status = 'completed' AND buyer_pubkey != seller_pubkey
          AND completed_at >= ? AND (completed_at > ? OR rowid > ?)
        ORDER BY completed_at, rowid LIMIT ?
    `);
    let rows = firstPage.all(since, pageRows) as (ThirtyDayTrade & { rid: number; at: unknown })[];
    while (rows.length > 0) {
        yield rows;
        if (rows.length < pageRows) return;
        const last = rows[rows.length - 1];
        rows = nextPage.all(last.at, last.at, last.rid, pageRows) as (ThirtyDayTrade & { rid: number; at: unknown })[];
    }
}

/** A pair whose gross is at least the cap and whose flows are this close (|a − b| / gross below it) is a wash pair. */
export const WASH_PAIR_MAX_RATIO = 0.15;

/**
 * runWashTradingAnalysis, one step at a time: it yields after each page of buyers' pair totals and after each cluster's
 * query, so a caller can give the event loop a turn between steps (engine audit.ts computeWashSybilMetricsInSlices) and
 * the analysis never holds it for long. runWashTradingAnalysis drains it in one go, so both give the same analysis.
 */
export function washTradingAnalysisSteps(db: Db): Generator<void, WashAnalysis> {
    return analysisSteps(db, false, db);
}

/**
 * washTradingAnalysisSteps, with `strict`: a step whose query fails throws rather than going on without it (a background
 * refresh then lands nothing, where a part analysis would flag fewer: the wrong way for a credit floor). `countFor`: the
 * handle washAnalysisCount counts it for (a refresh reads through a second handle, for the node's own).
 */
function* analysisSteps(db: Db, strict: boolean, countFor: Db): Generator<void, WashAnalysis> {
    const flaggedPairs = new Set<string>();
    const flaggedClusters = new Map<string, number>();
    const clusterDetails: any[] = [];
    const pairDetails: any[] = [];

    // --- 1. Net-flow ratio (per counterparty pair) ---
    // A page at a time: the buyers in key order, WASH_PAIR_PAGE_BUYERS of them, then their totals per seller. Every
    // (buyer, seller) total lies wholly in one page, so the totals are the one query's over every trade; in one query it
    // held the loop 243 ms warm and up to 953 ms cold at 101,400 trades, which no slice could split.
    try {
        const firstBuyers = db.prepare(`
            SELECT MIN(b) AS lo, MAX(b) AS hi FROM (
                SELECT DISTINCT buyer_pubkey AS b FROM marketplace_transactions
                WHERE status = 'completed' ORDER BY buyer_pubkey LIMIT ?)
        `);
        const nextBuyers = db.prepare(`
            SELECT MIN(b) AS lo, MAX(b) AS hi FROM (
                SELECT DISTINCT buyer_pubkey AS b FROM marketplace_transactions
                WHERE buyer_pubkey > ? AND status = 'completed' ORDER BY buyer_pubkey LIMIT ?)
        `);
        const pageTotals = db.prepare(`
            SELECT buyer_pubkey, seller_pubkey, SUM(credits) as vol
            FROM marketplace_transactions
            WHERE buyer_pubkey >= ? AND buyer_pubkey <= ? AND status = 'completed' AND buyer_pubkey != seller_pubkey
            GROUP BY buyer_pubkey, seller_pubkey
        `);

        const pairVolumes = new Map<string, { u: string; v: string; volUtoV: number; volVtoU: number }>();
        let page = firstBuyers.get(WASH_PAIR_PAGE_BUYERS) as { lo: string | null; hi: string | null };
        while (page.lo !== null && page.hi !== null) {
            const rows = pageTotals.all(page.lo, page.hi) as { buyer_pubkey: string; seller_pubkey: string; vol: number }[];
            for (const row of rows) {
                const u = row.buyer_pubkey;
                const v = row.seller_pubkey;
                const key = u < v ? `${u}|${v}` : `${v}|${u}`;
                let data = pairVolumes.get(key);
                if (!data) {
                    data = { u: u < v ? u : v, v: u < v ? v : u, volUtoV: 0, volVtoU: 0 };
                    pairVolumes.set(key, data);
                }
                if (row.buyer_pubkey === data.u) {
                    data.volUtoV += row.vol;
                } else {
                    data.volVtoU += row.vol;
                }
            }
            yield;
            page = nextBuyers.get(page.hi, WASH_PAIR_PAGE_BUYERS) as { lo: string | null; hi: string | null };
        }

        for (const [key, data] of pairVolumes.entries()) {
            const gross = data.volUtoV + data.volVtoU;
            if (gross >= PER_COUNTERPARTY_VOLUME_CAP) {
                const r = Math.abs(data.volUtoV - data.volVtoU) / gross;
                pairDetails.push({ a: data.u, b: data.v, gross, r });
                if (r < WASH_PAIR_MAX_RATIO) {
                    flaggedPairs.add(key);
                }
            }
        }
    } catch (e) {
        if (strict) throw e;
        console.error('Wash analysis (pair net flow) failed:', e);
    }
    yield;

    // --- 2. Cluster insularity (connected components over rolling 30 days) ---
    try {
        const adj = new Map<string, Set<string>>();
        const edgeVol30 = new Map<string, number>();
        const nodes30 = new Set<string>();

        // A page at a time (#1908): in one query it held the loop 140 ms at 39,925 trades (load 6-8), which no slice could
        // split. Every page reads the rows in the one query's order, so the analysis is the same to the last bit.
        for (const txs30 of thirtyDayTradePages(db)) {
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
            yield;
        }

        const visited = new Set<string>();
        const components: string[][] = [];

        for (const node of nodes30) {
            if (visited.has(node)) continue;
            const comp: string[] = [];
            const queue = [node];
            visited.add(node);

            // A head index, not queue.shift() (the same order), and a yield every WASH_BFS_STEP_NODES members: one
            // component can hold most of the node (#1908).
            for (let head = 0; head < queue.length; head++) {
                const curr = queue[head];
                comp.push(curr);
                const neighbors = adj.get(curr) || new Set();
                for (const next of neighbors) {
                    if (!visited.has(next)) {
                        visited.add(next);
                        queue.push(next);
                    }
                }
                if ((head + 1) % WASH_BFS_STEP_NODES === 0) yield;
            }
            components.push(comp);
            yield;
        }

        if (components.length > 0) {
            const uniqueNodes = Array.from(nodes30);
            const memberAges = new Map<string, number>();

            // 100 keys a query, not SQLite's 999: on a cold 100,000-member database a 999-key lookup held the loop for up
            // to 264 ms, and a slice can't end inside one query (the global load test, 2026-10-11).
            for (let i = 0; i < uniqueNodes.length; i += 100) {
                const chunk = uniqueNodes.slice(i, i + 100);
                const placeholders = chunk.map(() => '?').join(',');
                const membersRows = db.prepare(`
                    SELECT public_key, joined_at FROM members WHERE public_key IN (${placeholders})
                `).all(...chunk) as { public_key: string; joined_at: string }[];

                for (const m of membersRows) {
                    const joined = m.joined_at ? new Date(m.joined_at) : new Date();
                    const ageDays = (Date.now() - joined.getTime()) / (1000 * 60 * 60 * 24);
                    memberAges.set(m.public_key, ageDays);
                }
                yield;
            }

            let compIdx = 0;
            for (const comp of components) {
                if (comp.length <= 12) {
                    // ⚡ Bolt: Look up pairs directly in edgeVol30 O(N^2) instead of scanning all E entries O(E) per component
                    let internalVol = 0;
                    for (let i = 0; i < comp.length; i++) {
                        for (let j = i + 1; j < comp.length; j++) {
                            const u = comp[i] < comp[j] ? comp[i] : comp[j];
                            const v = comp[i] < comp[j] ? comp[j] : comp[i];
                            internalVol += edgeVol30.get(`${u}|${v}`) || 0;
                        }
                    }

                    const placeholders = comp.map(() => '?').join(',');
                    let totalVol = 0;
                    try {
                        const allTimeRes = db.prepare(`
                            SELECT COALESCE(SUM(credits), 0) as s FROM marketplace_transactions
                            WHERE status = 'completed' AND (buyer_pubkey IN (${placeholders}) OR seller_pubkey IN (${placeholders}))
                        `).get(...comp, ...comp) as any;
                        totalVol = allTimeRes ? allTimeRes.s : 0;
                    } catch (e) {
                        if (strict) throw e;
                        console.error('Failed to query all-time volume for component:', e);
                        totalVol = internalVol;
                    }

                    const insularity = totalVol > 0 ? (internalVol / totalVol) : 0;
                    let newMembersCount = 0;
                    for (const m of comp) {
                        const age = memberAges.get(m) ?? 0;
                        if (age < 14) {
                            newMembersCount++;
                        }
                    }

                    const newRatio = comp.length > 0 ? (newMembersCount / comp.length) : 0;

                    clusterDetails.push({
                        members: comp,
                        internalVol,
                        totalVol,
                        insularity,
                        newRatio,
                        size: comp.length,
                        newMembers: newMembersCount
                    });

                    if (insularity >= 0.8 && newMembersCount >= comp.length / 2) {
                        for (const m of comp) {
                            flaggedClusters.set(m, compIdx);
                        }
                    }
                    compIdx++;
                    yield;
                }
            }
        }
    } catch (e) {
        if (strict) throw e;
        console.error('Wash analysis (cluster insularity) failed:', e);
    }

    stateOf(countFor).analyses++;
    return { flaggedPairs, flaggedClusters, clusterDetails, pairDetails };
}

/** A complete analysis and what it took. */
export interface WashRun {
    analysis: WashAnalysis;
    /** Date.now() as its rows were read from: a refresh's snapshot, a one-go's start. */
    snapshotAt: number;
    /** Date.now() as it finished. */
    finishedAt: number;
    /** How long its steps held the event loop, summed: its `c`. */
    stepMs: number;
    /** Its wall time, start to finish, the turns it gave included: its `D`. */
    wallMs: number;
}

// What floors read, per database handle (getWashTradingEnforcement). Keyed by the handle itself so the node's live DB
// keeps its own AND the manager can run the same analysis against many replica DBs without cross-contamination.
interface WashState {
    /** Complete analyses run for this handle (washAnalysisCount). */
    analyses: number;
    /** The analysis floors read, and what it took; null until the first, and after a clear. */
    current: WashRun | null;
    /** Moved on by clearWashTradingCache: a refresh started before it lands nothing. */
    generation: number;
    /** The background refresh running, if one is. */
    refreshing: Promise<void> | null;
    /** Another refresh asked for while one ran (refreshWashTradingInBackground): it starts when that one ends. */
    again: boolean;
    /** The refresh running can no longer land: an analysis worked out in one go since it started read later rows. */
    stale: boolean;
    /** When the refresh running started (Date.now()): one that `again` or the server started past the bound of the
     *  analysis serving floors holds off no one go (a refresh a read started always starts before that bound). */
    refreshStartedAt: number;
    /** When the hard cap was last logged (once a minute). */
    capSaidAt: number;
}

const washState = new WeakMap<Db, WashState>();

function stateOf(db: Db): WashState {
    let s = washState.get(db);
    if (!s) washState.set(db, s = { analyses: 0, current: null, generation: 0, refreshing: null, again: false, stale: false, refreshStartedAt: 0, capSaidAt: 0 });
    return s;
}

/** How many complete wash analyses have run for this handle, by any path (a test counts them). */
export function washAnalysisCount(db: Db): number {
    return washState.get(db)?.analyses ?? 0;
}

/** Each handle's second, read-only handle on the same file, for a refresh's snapshot; null where there can be none. */
const snapshotHandles = new WeakMap<Db, Db | null>();

/**
 * The read-only handle a refresh reads its snapshot through, opened the first time (WAL lets it read one moment's rows
 * while the node's own handle writes). None for an in-memory database (tests): the refresh then reads through the node's
 * own handle, which it says once. A file database's handle that does not open throws, and is tried again at the next
 * refresh: a file database never refreshes without a snapshot (rows read at different moments could miss a ring), so
 * until one opens its analysis is worked out in one go at a read, as before.
 */
function snapshotHandleFor(db: Db): Db | null {
    const kept = snapshotHandles.get(db);
    if (kept === null) return null;
    if (kept?.open) return kept;
    if (db.memory) {
        console.warn('[Wash] The wash analysis refreshes through the node\'s own handle, with no snapshot: the database is in memory.');
        snapshotHandles.set(db, null);
        return null;
    }
    try {
        const Ctor = db.constructor as unknown as new (file: string, options: Database.Options) => Db;
        const handle = new Ctor(db.name, { readonly: true, fileMustExist: true });
        handle.pragma('busy_timeout = 5000');
        snapshotHandles.set(db, handle);
        return handle;
    } catch (e) {
        throw new Error(`the refresh's read-only snapshot did not open (${e instanceof Error ? e.message : String(e)})`);
    }
}

/**
 * Closes the refresh's read-only handle, where the node closes its data-version probe (a restore about to replace the
 * file, a shutdown): open, closing the node's own handle would not be the last close. A refresh reading through it
 * then throws, and lands nothing. The next refresh opens a new one.
 */
export function closeWashSnapshotHandle(db: Db): void {
    const handle = snapshotHandles.get(db);
    snapshotHandles.delete(db);
    try { handle?.close(); } catch { /* closed either way */ }
}

/** A refresh whose snapshot handle was closed under it (closeWashSnapshotHandle): expected, and logged as such. */
class WashSnapshotClosed extends Error {
    constructor() { super('the snapshot ended before the analysis did: its handle was closed (a checkpoint, a VACUUM, a restore or a shutdown)'); }
}

/**
 * The analysis in slices (runStepsInSlices), every slice reading the same snapshot: one read transaction on the
 * read-only handle spans them all, so the result is the one-go analysis of the rows as they stood at its start, whatever
 * is written meanwhile. A step whose query fails, or the handle closing, throws: nothing part-made comes back.
 */
export async function runWashAnalysisInSlices(db: Db, opts: { sliceMs?: number; onYield?: () => void } = {}): Promise<WashRun> {
    const wallStart = performance.now();
    const snap = snapshotHandleFor(db);
    const snapshotAt = Date.now();
    // A deferred transaction takes its snapshot at its first read: the first page of buyers, read before this returns.
    if (snap) snap.exec('BEGIN');
    try {
        const time = { ms: 0 };
        const analysis = await runStepsInSlices(timedSteps(analysisSteps(snap ?? db, true, db), time), opts);
        // Reached with the handle closed too (closed after the last step: the test "closes after its last step"), where
        // the catch below would name it WashSnapshotClosed anyway; named here so this line says which it is (#1908).
        if (snap && !(snap.open && snap.inTransaction)) throw snap.open ? new Error('the snapshot ended before the analysis did') : new WashSnapshotClosed();
        return { analysis, snapshotAt, finishedAt: Date.now(), stepMs: time.ms, wallMs: performance.now() - wallStart };
    } catch (e) {
        throw snap && !snap.open && !(e instanceof WashSnapshotClosed) ? new WashSnapshotClosed() : e;
    } finally {
        if (snap?.open && snap.inTransaction) snap.exec('COMMIT');
    }
}

/** How long an analysis serves floors before the next: 10 s. */
export const WASH_KEEP_MS = 10_000;
/**
 * The step time (an analysis's `c`) from which the next analysis is worked out in the background rather than in one go
 * at a read. Time, not a trade count: it is what the event loop feels, and a slow VM gets there with fewer trades.
 */
export const WASH_BACKGROUND_STEP_MS = 50;
/** The soonest a background refresh is due after the last one's snapshot. */
export const WASH_MIN_DUE_MS = 7_000;
/** The oldest snapshot a floor reads: past it, the read works one out in one go, as before. */
export const WASH_HARD_CAP_MS = 60_000;

/**
 * The wash analysis floors read (#1811, scratch/global-node/DESIGN-wash-analysis-background-fable.md).
 *
 * - None yet (the first read after a boot, a clear, a take-over): one is worked out now, in one go. A fresh, exact
 *   analysis never gives more credit than the rules allow, and making a spend wait for one in the background would refuse
 *   a member who should not be.
 * - The last one's steps held the loop less than WASH_BACKGROUND_STEP_MS (every small node): one go, as before. It serves
 *   reads for WASH_KEEP_MS from when it finished; the first read after that works out the next, in one go.
 * - Otherwise a read never waits. It gets the last complete analysis, and when the next is due it starts one in the
 *   background (runWashAnalysisInSlices: slices, one snapshot) that lands for the reads after. Due WASH_KEEP_MS after the
 *   last one's snapshot, less the time its turns took (its `D` less its `c`), never sooner than WASH_MIN_DUE_MS: so the
 *   next lands about WASH_KEEP_MS after the last one's rows were read, and what a read sees is at most WASH_KEEP_MS + `c`
 *   old, as when it was worked out in one go. A read that finds it older than that with no refresh running that can land
 *   in time (after a quiet spell, when no read started one; or one that read its rows before an analysis worked out in one
 *   go since; or one that `again` or the server started at or past that bound) works the next out in one go, as before.
 *   A refresh that started before that bound holds the one go off, whoever started it: a read, `again`, or the server's
 *   Step 6.1 (a take-over, or once it listens). What a read sees is then at most that refresh's run time past the bound,
 *   under WASH_HARD_CAP_MS. A snapshot WASH_HARD_CAP_MS old (refreshes failing to land) is worked out in one go at the
 *   read, as before, and said once a minute.
 *
 * Wash pairs are also caught live, per member, whatever the analysis's age (qualifiedTradeValue); clusters are the
 * analysis's alone.
 */
export function getWashTradingEnforcement(db: Db): WashAnalysis {
    const s = stateOf(db);
    const current = s.current;
    if (!current) return analyseNow(db, s);
    const now = Date.now();
    if (current.stepMs < WASH_BACKGROUND_STEP_MS) {
        return now - current.finishedAt < WASH_KEEP_MS ? current.analysis : analyseNow(db, s);
    }
    if (now - current.snapshotAt >= WASH_HARD_CAP_MS) {
        if (now - s.capSaidAt >= 60_000) {
            s.capSaidAt = now;
            console.warn(`[Wash] No background refresh of the wash analysis has landed for ${Math.round((now - current.snapshotAt) / 1000)} s: a floor read works one out in one go.`);
        }
        return analyseNow(db, s);
    }
    // Past today's bound with no refresh coming that can land in time (a quiet spell: refreshes start only at reads; or
    // the one running read its rows before an analysis worked out in one go since, so `again`'s next waits behind it; or
    // the one running started after this bound, by `again` or the server, so waiting on it would add how late it
    // started to its run time): one go at the read, as before, so no read gets rows older than today's rules ever served.
    const bound = current.snapshotAt + WASH_KEEP_MS + current.stepMs;
    if ((!s.refreshing || s.stale || s.refreshStartedAt >= bound) && now >= bound) return analyseNow(db, s);
    if (!s.refreshing && now - current.snapshotAt >= washRefreshDueMs(current)) startRefresh(db, s);
    return current.analysis;
}

/** How long after an analysis's snapshot the next background refresh is due (getWashTradingEnforcement). */
function washRefreshDueMs(run: WashRun): number {
    return Math.max(WASH_MIN_DUE_MS, WASH_KEEP_MS - (run.wallMs - run.stepMs));
}

/** The analysis in one go, now, through the node's own handle; it serves floors from here. */
function analyseNow(db: Db, s: WashState): WashAnalysis {
    const time = { ms: 0 };
    const wallStart = performance.now();
    const snapshotAt = Date.now();
    const analysis = drainSteps(timedSteps(analysisSteps(db, false, db), time));
    if (s.refreshing) s.stale = true;
    land(s, { analysis, snapshotAt, finishedAt: Date.now(), stepMs: time.ms, wallMs: performance.now() - wallStart });
    return analysis;
}

/** An analysis serves floors from now, unless the one serving them read its rows later. */
function land(s: WashState, run: WashRun): void {
    if (s.current && run.snapshotAt < s.current.snapshotAt) return;
    s.current = run;
}

/** Starts a background refresh at the loop's next turn (never inline: its first step would run before the read returns). */
function startRefresh(db: Db, s: WashState): void {
    if (s.refreshing) return;
    const generation = s.generation;
    const run = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => runWashAnalysisInSlices(db))
        .then((r) => { if (s.generation === generation) land(s, r); })
        .catch((e) => {
            if (e instanceof WashSnapshotClosed) console.log('[Wash] A background refresh of the wash analysis stopped: its snapshot was closed (a checkpoint, a VACUUM, a restore or a shutdown). Floors read the last one; the next refresh opens a new snapshot.');
            else console.warn('[Wash] A background refresh of the wash analysis failed; floors read the last one:', e);
        })
        .finally(() => {
            s.refreshing = null;
            if (s.again) {
                s.again = false;
                startRefresh(db, s);
            }
        });
    s.refreshing = run;
    s.stale = false;
    s.refreshStartedAt = Date.now();
}

/**
 * Starts a background refresh now, whatever the mode (the server once it listens, and on a take-over after
 * clearWashTradingCache); with one running, another starts when it ends. Resolves when the one asked for has ended,
 * landed or not.
 */
export function refreshWashTradingInBackground(db: Db): Promise<void> {
    const s = stateOf(db);
    if (s.refreshing) {
        s.again = true;
        return s.refreshing.then(() => s.refreshing ?? undefined);
    }
    startRefresh(db, s);
    return s.refreshing ?? Promise.resolve();
}

/** The background refresh running for this handle, if one is (a test awaits it). */
export function washRefreshRunning(db: Db): Promise<void> | null {
    return washState.get(db)?.refreshing ?? null;
}

/** Drops the analysis floors read: the next read works one out in one go. A refresh running now lands nothing. */
export function clearWashTradingCache(db: Db): void {
    const s = washState.get(db);
    if (!s) return;
    s.current = null;
    s.generation++;
}

/**
 * F3 — value that counts toward EARNED TRUST: only COMPLETED marketplace (escrow) trades.
 *
 * Attributed to the REAL counterparty (buyer↔seller), not the intermediating escrow account,
 * and capped per counterparty (PER_COUNTERPARTY_VOLUME_CAP) so diverse trade counts for more
 * than repeat trade with one partner. BOTH sides of a completed trade earn the value (the seller
 * delivered, the buyer paid). Direct peer-to-peer "send credits" are gifts/helping-a-friend —
 * they are deliberately NOT trades and build NO trust (per product decision, 2026-07).
 *
 * Enforcement (soft haircut — Change 3): Excludes flagged wash-trading pairs and intra-cluster trades
 * for flagged insular clusters from the trust sum.
 *
 * A pair is also excluded on the member's own rows as they stand (#1811): the analysis's rule (gross at least the cap,
 * |bought − sold| / gross under WASH_PAIR_MAX_RATIO) on what this member bought from and sold to the counterparty, which
 * are the analysis's two totals for the pair. So a wash pair counts for nothing from the first read after its trades
 * complete, however old the analysis is. It only ever excludes more than the analysis does.
 */
export function qualifiedTradeValue(db: Db, publicKey: string, wash: WashAnalysis = getWashTradingEnforcement(db)): number {
    const { flaggedPairs, flaggedClusters } = wash;

    const rows = prepared(db, `
        SELECT counterparty, COALESCE(SUM(credits), 0) as v,
            COALESCE(SUM(CASE WHEN bought THEN credits END), 0) AS bought,
            COALESCE(SUM(CASE WHEN bought THEN NULL ELSE credits END), 0) AS sold
        FROM (
            SELECT seller_pubkey AS counterparty, credits, 1 AS bought FROM marketplace_transactions
                WHERE buyer_pubkey = ? AND status = 'completed' AND seller_pubkey != ?
            UNION ALL
            SELECT buyer_pubkey AS counterparty, credits, 0 AS bought FROM marketplace_transactions
                WHERE seller_pubkey = ? AND status = 'completed' AND buyer_pubkey != ?
        ) GROUP BY counterparty
    `).all(publicKey, publicKey, publicKey, publicKey) as { counterparty: string; v: number; bought: number; sold: number }[];

    return rows.reduce((sum, r) => {
        const pairKey = publicKey < r.counterparty ? `${publicKey}|${r.counterparty}` : `${r.counterparty}|${publicKey}`;
        // Haircut check:
        // 1. Exclude if pair is flagged as wash trading
        if (flaggedPairs.has(pairKey)) {
            return sum;
        }
        // 1b. Exclude if the pair is a wash pair on its rows as they stand (the analysis's rule, live)
        const gross = r.bought + r.sold;
        if (gross >= PER_COUNTERPARTY_VOLUME_CAP && Math.abs(r.bought - r.sold) / gross < WASH_PAIR_MAX_RATIO) {
            return sum;
        }
        // 2. Exclude if both members are in the same flagged cluster component
        const clusterIdA = flaggedClusters.get(publicKey);
        const clusterIdB = flaggedClusters.get(r.counterparty);
        if (clusterIdA !== undefined && clusterIdA === clusterIdB) {
            return sum;
        }
        return sum + Math.min(r.v, PER_COUNTERPARTY_VOLUME_CAP);
    }, 0);
}

/**
 * Calculates trust metrics for a member used by the dynamic credit formula.
 * Excludes escrow system wallets and self-transactions.
 */
export function getMemberTrustStats(db: Db, publicKey: string): TrustStats {
    // Inlined member lookup: the node's rowToMember maps joined_at → joinedAt with
    // no transformation, so reading joined_at directly is behaviour-identical and
    // keeps this module free of the Member domain type.
    const member = prepared(db, "SELECT joined_at FROM members WHERE public_key = ?").get(publicKey) as { joined_at: string } | undefined;
    if (!member) return { tradeCount: 0, uniquePartners: 0, ageDays: 0 };

    // Trade count: completed transactions (direct and marketplace completed)
    const tradeCountRow = prepared(db, `
        SELECT (
            SELECT COUNT(*) FROM transactions
            WHERE (from_pubkey = ? OR to_pubkey = ?)
            AND from_pubkey != to_pubkey
            AND from_pubkey NOT LIKE 'escrow_%'
            AND to_pubkey NOT LIKE 'escrow_%'
            AND from_pubkey != 'SYSTEM'
            AND to_pubkey != 'SYSTEM'
        ) + (
            SELECT COUNT(*) FROM marketplace_transactions
            WHERE (buyer_pubkey = ? OR seller_pubkey = ?)
            AND status = 'completed'
        ) as count
    `).get(publicKey, publicKey, publicKey, publicKey) as any;

    // Unique trade partners: distinct counterparties (direct and marketplace completed)
    const uniquePartnersRow = prepared(db, `
        SELECT COUNT(DISTINCT partner) as count FROM (
            SELECT to_pubkey as partner FROM transactions
            WHERE from_pubkey = ?
            AND to_pubkey NOT LIKE 'escrow_%'
            AND to_pubkey != 'SYSTEM'
            AND to_pubkey != ?
            UNION
            SELECT from_pubkey as partner FROM transactions
            WHERE to_pubkey = ?
            AND from_pubkey NOT LIKE 'escrow_%'
            AND from_pubkey != 'SYSTEM'
            AND from_pubkey != ?
            UNION
            SELECT seller_pubkey as partner FROM marketplace_transactions
            WHERE buyer_pubkey = ? AND status = 'completed' AND seller_pubkey != ?
            UNION
            SELECT buyer_pubkey as partner FROM marketplace_transactions
            WHERE seller_pubkey = ? AND status = 'completed' AND buyer_pubkey != ?
        )
    `).get(publicKey, publicKey, publicKey, publicKey, publicKey, publicKey, publicKey, publicKey) as any;

    // Account age in days
    const joinedAt = member.joined_at ? new Date(member.joined_at) : new Date();
    const ageDays = Math.floor((Date.now() - joinedAt.getTime()) / (1000 * 60 * 60 * 24));

    return {
        tradeCount: tradeCountRow?.count || 0,
        uniquePartners: uniquePartnersRow?.count || 0,
        ageDays: Math.max(0, ageDays),
    };
}

export interface EnterpriseFloorInfo {
    allowance: number;
    floor: number;
    derivedAllowance: number;
    legacyFloor: number;
    activated: boolean;
}

const enterpriseFloorCache = new WeakMap<Db, Map<string, EnterpriseFloorInfo>>();

export function clearEnterpriseFloorCache(db?: Db, enterprisePubkey?: string): void {
    if (!db) return;
    const cache = enterpriseFloorCache.get(db);
    if (!cache) return;
    if (enterprisePubkey) {
        cache.delete(enterprisePubkey);
    } else {
        cache.clear();
    }
}

/**
 * Enterprise Derived Credit Floor (docs/the-commons.md §2.4 Rules 1-4, §6 Slice 4).
 * The credit floor derives from its keepers — the plain sum of each keeper's explicit
 * backing pledge of their own earned credit, capped by CREDIT_FLOOR_CAP.
 *
 * Grandfathering: existing enterprises keep their fixed line as a legacy floor until
 * keepers' pledges reach or exceed it, at which point the legacy floor is auto-cleared.
 *
 * O(1) reads via an in-memory cache WeakMap per DB handle.
 */
export function getEnterpriseFloor(db: Db, enterprisePubkey: string): EnterpriseFloorInfo {
    let cache = enterpriseFloorCache.get(db);
    if (!cache) {
        cache = new Map();
        enterpriseFloorCache.set(db, cache);
    }
    const cached = cache.get(enterprisePubkey);
    if (cached) return cached;

    const memberRow = db.prepare(
        "SELECT COALESCE(credit_frozen, 0) as credit_frozen, legacy_credit_floor FROM members WHERE public_key = ?"
    ).get(enterprisePubkey) as any;

    const isCreditFrozen = memberRow?.credit_frozen === 1;

    let derivedAllowance = 0;
    try {
        const pledgeRow = db.prepare(`
            SELECT COALESCE(SUM(p.amount), 0) as total
            FROM enterprise_pledges p
            JOIN members m ON m.public_key = p.keeper
            WHERE p.enterprise = ?
              AND p.released_at IS NULL
              AND p.id NOT LIKE 'known:%'
              AND m.status = 'active'
              AND COALESCE(m.credit_frozen, 0) = 0
        `).get(enterprisePubkey) as any;
        derivedAllowance = Number(pledgeRow?.total || 0);
    } catch {
        derivedAllowance = 0;
    }

    let legacyFloor = Number(memberRow?.legacy_credit_floor || 0);

    // Auto-clear legacy floor once keepers' derived pledges reach or exceed it (Slice 4).
    // Strictly read-only here: persistent database UPDATE is executed inside state mutation endpoints.
    if (legacyFloor > 0 && derivedAllowance >= legacyFloor) {
        legacyFloor = 0;
    }

    // The known floor (slice 4): the keepers' known pledges (known-floor.ts, recorded and locked like any pledge) and the
    // community's cap, only with the confirmation dial on; off, both are main's (share 0, cap CREDIT_FLOOR_CAP).
    const knownShare = enterpriseKnownShareOf(db, enterprisePubkey);
    const allowance = isCreditFrozen
        ? 0
        : Math.min(creditCap(db), Math.max(legacyFloor, derivedAllowance + knownShare));

    const floor = PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - allowance;
    const activated = allowance > 0;

    const result: EnterpriseFloorInfo = {
        allowance,
        floor,
        derivedAllowance,
        legacyFloor,
        activated,
    };

    // With the dial on the known share moves with every confirmation and keeper binding, none of which clears this cache:
    // read it fresh each time then.
    if (!confirmationDialOn(db)) cache.set(enterprisePubkey, result);
    return result;
}

/**
 * Returns the full trust profile for a member: stats, floor, ceiling, and tier.
 * Incorporates any pre-seeded earned_credit from admin genesis invites.
 * `extraKnownPledged`: a known pledge of this member's not yet written, counted as if it were (a keeper request's check
 * reads the floor binding them would leave, without writing the pledge). 0 everywhere else; an enterprise ignores it.
 * `wash`: the wash-trading analysis to read, in place of the one kept for 10 s (getWashTradingEnforcement). The metrics
 * audit passes the one it took at its start, so a walk over every member reads one analysis rather than making a new one
 * every 10 s of the walk (engine audit.ts computeWashSybilMetrics).
 */
export function getMemberTrustProfile(db: Db, publicKey: string, extraKnownPledged = 0, wash?: WashAnalysis): {
    stats: TrustStats;
    floor: number;
    tier: TierInfo;
    earnedCredit: number;
    grantedCredit: number;
    /** The known grant (community modes slice 4): 0 unless the confirmation dial is on and the member is confirmed. */
    knownGrant: number;
    /** vouch + earned + granted, before the cap: the part the offer bands meter. */
    otherAllowance: number;
    /** An admin froze this confirmed member's known floor (known_floor_exceptions.frozen): no known line while it lasts. */
    knownFrozen: boolean;
    /** An admin froze this member's whole credit line (members.credit_frozen, the manager's "Freeze"): no line while it lasts. */
    creditFrozen: boolean;
    /**
     * The credit `tier` is read from (tierForCredit(tierCredit) is `tier`): CREDIT_BASE_FLOOR − floor, except that a freeze
     * keeps the line the member holds unfrozen. A post card's badge takes it, so every surface shows the same tier.
     */
    tierCredit: number;
    qualifiedValue: number;
    avgRating: number;
    reviewCount: number;
    vouched: boolean;
    activated: boolean;
} {
    const stats = getMemberTrustStats(db, publicKey);

    const memberRow = prepared(db, "SELECT earned_credit, elder_vouched_by, vouch_credit, COALESCE(credit_frozen, 0) as credit_frozen, is_treasury FROM members WHERE public_key = ?").get(publicKey) as any;
    const isTreasury = memberRow?.is_treasury === 1;

    // Enterprise Derived Floor model (docs/the-commons.md §2.4, §6 Slice 4)
    if (isTreasury) {
        const ef = getEnterpriseFloor(db, publicKey);
        const floor = ef.floor;
        const tier = getTier(floor);
        return {
            stats,
            floor,
            tier,
            earnedCredit: ef.allowance,
            grantedCredit: ef.legacyFloor,
            knownGrant: 0,
            otherAllowance: ef.allowance,
            qualifiedValue: 0,
            avgRating: 5.0,
            reviewCount: 0,
            vouched: false,
            activated: ef.activated,
            knownFrozen: false,
            creditFrozen: false,
            tierCredit: PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - floor,
        };
    }

    // GRANTED-credit lane: genesis pre-seed + admin Elder grants (adminSetElder) + Elder vouch.
    // Stored in members.earned_credit (legacy column name). It is a credit-*limit* input only —
    // it mints/moves no beans — and it is kept SEPARATE from the earned score, so grants deepen
    // the floor but never count as "earned" (governance votes use earned/value only, not grants).
    const grantedCredit = memberRow?.earned_credit || 0;
    const elderVouched = !!memberRow?.elder_vouched_by;
    // The vouch level's credit floor (25/50/100). A vouch recorded before the level system, or
    // with no stored amount, defaults to the light level.
    const vouchCredit = elderVouched ? (memberRow?.vouch_credit > 0 ? memberRow.vouch_credit : PROTOCOL_CONSTANTS.VOUCH_CREDIT_LIGHT) : 0;
    const isCreditFrozen = memberRow?.credit_frozen === 1;

    const c = PROTOCOL_CONSTANTS;

    // EARNED-credit lane (Trust Model v2 / F3): a saturating function of qualified trade VALUE —
    // ONLY completed marketplace (escrow) trades, attributed to the real counterparty and capped
    // per-counterparty (A2-26 diversity), crediting both buyer and seller. Direct "send credits"
    // are gifts, not trades, and build no trust. Earning a deep floor requires real, diverse,
    // completed trade — not gifts or 1-bean pings across sock accounts.
    const value = qualifiedTradeValue(db, publicKey, wash);
    const rawEarned = earnedCreditFromValue(value);

    // Star rating scales EARNED value only (0.5–1.0×); granted credit passes through intact.
    const ratingsRow = prepared(db, `
        SELECT AVG(stars) as avg, COUNT(*) as cnt
        FROM ratings
        WHERE target_pubkey = ?
    `).get(publicKey) as any;
    const reviewCount = ratingsRow?.cnt || 0;
    const avgRating = ratingsRow?.avg || 5.0;
    const multiplier = reviewCount > 0 ? (0.5 + 0.5 * (avgRating / 5.0)) : 1.0;
    const earnedCredit = Math.max(0, Math.floor(rawEarned * multiplier));

    // Activation gate — a member has NO credit line at all (floor stays at 0; no overdraft) until an
    // appointed voucher vouches for them, or an admin/genesis grant graduates a founding member.
    // Trust Model v3: a completed real trade (earnedCredit > 0) opens the floor on its own — no
    // vouch required. Restores the documented behaviour (docs/trust-model-shipped.md §1).
    // The known floor (community modes slice 4): a confirmed member's grant, and the community's cap (default
    // CREDIT_FLOOR_CAP). With the confirmation dial off both are today's: knownGrant 0, cap 2,000.
    // Less what of it they have pledged to enterprises (known-floor.ts: own line + known pledges <= their grant).
    const knownGrant = memberUsableKnownGrant(db, publicKey, undefined, extraKnownPledged);
    const cap = creditCap(db);
    const activated = elderVouched || grantedCredit > 0 || earnedCredit > 0 || knownGrant > 0;
    const otherAllowance = vouchCredit + earnedCredit + grantedCredit;
    const allowance = (activated && !isCreditFrozen)
        ? Math.min(cap, knownGrant + otherAllowance)
        : 0;

    // Floor = -(voucher + earned + granted) once activated, clamped so the deepest floor is
    // -CREDIT_FLOOR_CAP; 0 for an un-vouched member. CREDIT_BASE_FLOOR is 0 — no baked-in overdraft.
    const floor = c.CREDIT_BASE_FLOOR - allowance;

    // An admin's freeze takes the line away, not the tier: tiers are merit badges, and a frozen member keeps the one their
    // line would give them (rehearsal 5 Oct, b: a frozen Resident showed "Newcomer"). That is either freeze: the whole line
    // (members.credit_frozen) or the known floor's: a frozen exception keeps the amount it froze (config/known-floor.ts; NULL
    // is the community's known floor), so the tier reads that amount as if unfrozen, less their counted known pledges exactly
    // as unfrozen. So a freeze never moves a tier, up or down (r4178376530, r4178445093). A lowered or raised exception is
    // the member's line itself, so its tier follows it.
    const exception = knownFloorException(db, publicKey);
    const knownFrozen = confirmationDialOn(db) && exception?.frozen === true && isConfirmed(db, publicKey);
    const tierKnownGrant = knownFrozen
        ? memberUsableKnownGrant(db, publicKey, knownGrantFor({ dialOn: true, confirmed: true, knownFloor: knownFloor(db), cap, exception: { amount: exception!.amount, frozen: false } }), extraKnownPledged)
        : knownGrant;
    const tierAllowance = (activated || tierKnownGrant > 0) ? Math.min(cap, tierKnownGrant + otherAllowance) : 0;
    const tier = getTier(c.CREDIT_BASE_FLOOR - tierAllowance);

    // qualifiedValue: raw diversity-capped trade value (drives the native "value traded"
    // achievement + value-to-next-tier estimate). avgRating/reviewCount: the reputation
    // multiplier inputs, surfaced so the client can show them honestly.
    return { stats, floor, tier, earnedCredit, grantedCredit, knownGrant: isCreditFrozen ? 0 : knownGrant, otherAllowance: isCreditFrozen ? 0 : otherAllowance, qualifiedValue: value, avgRating, reviewCount, vouched: elderVouched, activated, knownFrozen, creditFrozen: isCreditFrozen, tierCredit: tierAllowance };
}

