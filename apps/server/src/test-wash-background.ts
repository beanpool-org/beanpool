/**
 * Test Suite: the wash analysis refreshes in the background, as the server runs it (#1811, S3 of
 * scratch/global-node/DESIGN-wash-analysis-background-fable.md). The engine's own tests (packages/beanpool-engine
 * wash-background.test.ts) hold the modes, the due time, the hard cap and the live pair rule; this holds the server's part.
 *  1. Boot: the refresh the server starts once it listens (startWashTradingRefreshAtBoot) lands with no floor read, and
 *     the first floor read takes it rather than working one out.
 *  2. Take-over in this process: a standby's analysis, from before the final copy's rows, is dropped when the role turns
 *     to primary, and a fresh one started; the promoted server's floors then equal a one-go on its final rows.
 *  3. The refresh's read-only handle closes with the data-version probe (a restore, a shutdown): a refresh in flight lands
 *     nothing, and closing the node's own handle after is the last close (state.db-wal folded and gone).
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-wash-background.ts
 */

import fs from 'node:fs';
import {
    initStateEngine, getWashTradingEnforcement, clearWashTradingCache, runWashTradingAnalysis, washAnalysisCount,
    startWashTradingRefreshAtBoot, setNodeRole, getNodeRole,
} from './state-engine.js';
import { db, closeDbDataVersionProbe } from './db/db.js';
import { qualifiedTradeValue, washRefreshRunning, WASH_KEEP_MS } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(condition: boolean, msg: string) {
    run++;
    if (condition) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
let tradeN = 0;
function member(pk: string, joinedDaysAgo: number) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)`).run(pk, pk.slice(0, 8), daysAgo(joinedDaysAgo));
}
function trade(buyer: string, seller: string, credits: number, atDaysAgo = 40) {
    const at = daysAgo(atDaysAgo);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at, completed_at, updated_at)
        VALUES (?, 'wash-bg-post', ?, ?, ?, 1, 'completed', ?, ?, ?)`).run(`wash-bg-${tradeN++}`, buyer, seller, credits, at, at, at);
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** performance.now moved on 60 ms each read while `fn` runs: every analysis step "holds the loop" 60 ms (background mode). */
function slowSteps<T>(fn: () => T): T {
    const real = performance.now;
    let t = real.call(performance);
    performance.now = () => (t += 60);
    try { return fn(); } finally { performance.now = real; }
}
/** slowSteps over an await: the steps a refresh runs in the turns meanwhile are slow too. */
async function slowStepsAcross(fn: () => Promise<void>): Promise<void> {
    const real = performance.now;
    let t = real.call(performance);
    performance.now = () => (t += 60);
    try { await fn(); } finally { performance.now = real; }
}

async function main() {
    try {
        initStateEngine();
        const dbPath = db.name;
        for (const k of ['wbg-o1', 'wbg-o2', 'wbg-o3', 'wbg-o4']) member(k, 90);
        trade('wbg-o1', 'wbg-o2', 120);
        trade('wbg-o3', 'wbg-o4', 75);
        clearWashTradingCache();

        // --- 1. Boot ---
        const n0 = washAnalysisCount();
        const boot = startWashTradingRefreshAtBoot();
        assert(boot !== null, 'A node with Beans on starts the wash analysis\'s first refresh once it listens');
        assert(washAnalysisCount() === n0, 'It runs in the background: nothing ran inside the call');
        await boot;
        assert(washAnalysisCount() === n0 + 1, `It landed with no floor read (${washAnalysisCount() - n0} analysis)`);
        const landed = getWashTradingEnforcement();
        assert(washAnalysisCount() === n0 + 1, 'The first floor read takes it rather than working one out');

        // --- 2. Take-over in this process ---
        // As a standby: an analysis from its copies so far (one go, with steps slow enough for background mode).
        setNodeRole('backup');
        clearWashTradingCache();
        const standbyEra = slowSteps(() => getWashTradingEnforcement());
        assert(standbyEra !== landed, 'The standby worked out its own analysis');
        // The final copy brings a ring of four members three days old trading only among themselves.
        const ring = ['wbg-r1', 'wbg-r2', 'wbg-r3', 'wbg-r4'];
        for (const k of ring) member(k, 3);
        for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) trade(ring[i], ring[j], 90, 1);
        assert(ring.every((k) => qualifiedTradeValue(db, k) > 0), 'With the standby\'s analysis the ring\'s trades still count');
        const nBefore = washAnalysisCount();
        slowSteps(() => setNodeRole('primary'));
        assert(getNodeRole() === 'primary', 'This process is the main server now');
        const refresh = washRefreshRunning(db);
        assert(refresh !== null, 'The take-over started a fresh refresh in the background');
        // A spend before it lands: the standby-era analysis was dropped, so the read works one out on the final rows.
        const firstRead = slowSteps(() => getWashTradingEnforcement());
        assert(firstRead !== standbyEra, 'The first floor read after the take-over does not read the standby-era analysis');
        assert(ring.every((k) => qualifiedTradeValue(db, k) === 0), 'From that first read the ring counts for nothing');
        await refresh;
        const promoted = slowSteps(() => getWashTradingEnforcement());
        assert(promoted !== standbyEra, 'The standby-era analysis is gone for good');
        assert(washAnalysisCount() === nBefore + 2, `Two analyses since the take-over: the first read's, and the refresh it started (${washAnalysisCount() - nBefore})`);
        const oneGo = runWashTradingAnalysis();
        const same = ['wbg-o1', 'wbg-o2', 'wbg-o3', ...ring].every((k) => qualifiedTradeValue(db, k) === qualifiedTradeValue(db, k, oneGo));
        assert(same, 'The promoted server\'s floors equal a one-go on its final rows');
        assert(ring.every((k) => qualifiedTradeValue(db, k) === 0), 'The ring counts for nothing on the promoted server');

        // --- 3. The read-only handle closes with the data-version probe ---
        const realNow = Date.now;
        let ahead = 0;
        Date.now = () => realNow() + ahead;
        let lost: boolean;
        let nAtClose: number;
        try {
            clearWashTradingCache();
            slowSteps(() => getWashTradingEnforcement()); // background mode
            ahead = WASH_KEEP_MS;
            const served = slowSteps(() => getWashTradingEnforcement()); // due: a refresh starts
            const inFlight = washRefreshRunning(db);
            assert(inFlight !== null, 'A due read started a refresh');
            await slowStepsAcross(turn); // it has taken its snapshot and given a turn
            nAtClose = washAnalysisCount();
            closeDbDataVersionProbe();
            await inFlight;
            lost = slowSteps(() => getWashTradingEnforcement()) === served && washAnalysisCount() === nAtClose;
        } finally {
            Date.now = realNow;
        }
        assert(lost, 'Closing the probe closed the refresh\'s handle: the refresh in flight landed nothing');
        closeDbDataVersionProbe();
        db.close();
        assert(!fs.existsSync(`${dbPath}-wal`), 'Closing the node\'s handle after is the last close: state.db-wal is folded and gone');

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ Wash analysis in the background tests PASSED.');
    } catch (e) {
        console.error('❌ Test failed:', e);
        process.exit(1);
    }
    process.exit(0);
}

main();
