/**
 * Backend Visibility Monitors Regression Tests (Aggregate Invariant, Cohort Velocity, Delinquency)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backend-monitors.ts
 */

import {
    initStateEngine, adminSetTier,
    runWashSybilMetricsAudit, runWashSybilMetricsAuditSliced, getCommunityHealth,
    reconcileLedgerFromDb, washAnalysisCount
} from './state-engine.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let seq = 0;
function seedMember(pk: string, balance = 0, joinedAtDaysAgo = 0) {
    const joinedAt = new Date(Date.now() - joinedAtDaysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)`).run(pk, pk.slice(0, 8), joinedAt);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(pk, balance);
}

// A direct peer-to-peer transfer (gift) to establish transaction timestamps
function tx(from: string, to: string, amount: number, daysAgo = 0) {
    const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?,?,?,?,?,?)`)
        .run('btx' + (seq++), from, to, amount, 'gift', ts);
}

async function main() {
    console.log('Running Backend Visibility Monitors tests...\n');
    // The node's own metrics-audit timer (initStateEngine: once 2.5 min after boot, then daily), kept for Test 7 to fire.
    const realSetTimeout = globalThis.setTimeout;
    const auditTimers: (() => void)[] = [];
    (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => {
        if (ms === 2.5 * 60 * 1000) { auditTimers.push(fn); return realSetTimeout(() => {}, 0); }
        return (realSetTimeout as any)(fn, ms, ...rest);
    };
    try { initStateEngine(); } finally { globalThis.setTimeout = realSetTimeout; }

    try {
        // --- Test 1: Aggregate Invariant Monitor ---
        // Seed some accounts with negative balances
        const user1 = 'metricA-' + Date.now();
        const user2 = 'metricB-' + Date.now();
        seedMember(user1, -100, 20); // 20 days old, balance -100
        seedMember(user2, -50, 20);  // 20 days old, balance -50
        reconcileLedgerFromDb();

        // Give them some floor so their balances are valid credit uses
        adminSetTier(user1, 'Resident'); // floor -200
        adminSetTier(user2, 'Resident'); // floor -200

        // Run the audit
        const metrics1 = runWashSybilMetricsAudit()!;
        assert(metrics1.totalNegative === 150, `Total negative balance metric computed: 150 (got ${metrics1.totalNegative})`);
        assert(metrics1.accountsNearFloor === 0, `No accounts near floor yet (got ${metrics1.accountsNearFloor})`);

        // Move user1 closer to their floor (-195, floor is -200)
        db.prepare("UPDATE accounts SET balance = -195 WHERE public_key = ?").run(user1);
        reconcileLedgerFromDb();
        const metrics2 = runWashSybilMetricsAudit()!;
        assert(metrics2.accountsNearFloor === 1, `1 account near floor detected (got ${metrics2.accountsNearFloor})`);

        // --- Test 2: Delinquency report ---
        // user1 balance is -195, floor is -200 (spent 97.5% >= 80%).
        // They haven't had transactions, so they should be dormant (no tx in last 7 days).
        // delinquentCount should be 1.
        assert(metrics2.delinquentCount === 1, `1 delinquent account detected (got ${metrics2.delinquentCount})`);

        // Perform a recent transaction for user1 (makes them active, not dormant)
        tx(user1, user2, 5, 0); // 0 days ago (recent)
        const metrics3 = runWashSybilMetricsAudit()!;
        assert(metrics3.delinquentCount === 0, `0 delinquent accounts after recent transaction (got ${metrics3.delinquentCount})`);

        // --- Test 3: Cohort Velocity Report ---
        // Let's seed a cohort of new accounts created on the same week.
        // We'll join them 2 days ago.
        const cohortUsers = Array.from({ length: 4 }, (_, i) => `coh${i}-${Date.now()}`);
        for (const u of cohortUsers) {
            seedMember(u, 0, 2); // 2 days old (new member)
            adminSetTier(u, 'Steward'); // sets floor to -600 (reached Stewardship in under 14 days)
        }

        // Run metrics audit. Since all 4 accounts in the same week cohort reached floor <= -600 in <14 days,
        // cohortAnomalies should be flagged.
        const metrics4 = runWashSybilMetricsAudit()!;
        assert(metrics4.cohortAnomalies === 1, `Cohort velocity anomaly detected (got ${metrics4.cohortAnomalies})`);

        // --- Test 4: getCommunityHealth Alerts ---
        // Verify that the health flags show the cohort anomaly and delinquency
        const health1 = getCommunityHealth();
        const cohortFlag = health1.flags.find(f => f.type === 'cohort_velocity' && f.description.includes('Cohort Velocity Anomaly'));
        assert(!!cohortFlag, 'Cohort Velocity Anomaly flag was raised in community health report');

        // Let's test the Aggregate Credit Spike alert.
        // We need a previous metric from system_metrics table created at <datetime('now', '-23 hours')
        // Let's manually insert a yesterday metric with total_negative_balance = 100
        const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        db.prepare("INSERT INTO system_metrics (timestamp, metric_key, metric_value) VALUES (?, ?, ?)")
            .run(yesterday, 'total_negative_balance', 100);

        // Current metrics should be around 150 + 195 + 50... wait, let's see.
        // Let's force-insert the current metric to be 1000 (growth: (1000-100)/100 = 900% growth, absolute 900 beans >= 500)
        db.prepare("INSERT INTO system_metrics (timestamp, metric_key, metric_value) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)")
            .run('total_negative_balance', 1000);

        const health2 = getCommunityHealth();
        const spikeFlag = health2.flags.find(f => f.type === 'aggregate_spike' && f.description.includes('Aggregate credit spike'));
        assert(!!spikeFlag, 'Aggregate credit spike alert was raised in community health report');
        assert(!!spikeFlag?.description.includes('increased by 900.0%'), `Description is correct (got: "${spikeFlag?.description}")`);

        // --- Test 5: the audit as the node's timers run it, a slice at a time ---
        // In one go it held a 20,000-member node for 20 s (the global load test, 2026-10-11). Sliced, it gives the event
        // loop a turn between slices; with sliceMs 0 a turn after every step, and every active member is at least one
        // step. The turns are counted, not timed, so a slow CI machine cannot fail it.
        for (let i = 0; i < 20; i++) seedMember(`slice${i}-${Date.now()}`, i % 3 === 0 ? -5 : 10, 30 + i);
        reconcileLedgerFromDb();
        const activeCount = (db.prepare("SELECT COUNT(*) AS n FROM members WHERE status = 'active'").get() as { n: number }).n;
        const oneGo = runWashSybilMetricsAudit()!;
        let turns = 0, otherWork = 0, ticking = true;
        const tick = () => { if (ticking) { otherWork++; setImmediate(tick); } };
        setImmediate(tick);
        const sliced = await runWashSybilMetricsAuditSliced({ sliceMs: 0, onYield: () => turns++ });
        ticking = false;
        assert(activeCount >= 20 && turns >= activeCount, `Sliced audit gave the loop a turn per step: ${turns} turns for ${activeCount} active members`);
        assert(otherWork >= turns / 2, `Other work ran while the sliced audit ran (${otherWork} turns of a ticker for ${turns} yields)`);
        assert(JSON.stringify(sliced) === JSON.stringify(oneGo), `Sliced audit gives the one-go numbers (${JSON.stringify(sliced)} vs ${JSON.stringify(oneGo)})`);
        const [a, b] = [runWashSybilMetricsAuditSliced({ sliceMs: 0 }), runWashSybilMetricsAuditSliced({ sliceMs: 0 })];
        assert(a === b, 'A second start while the sliced audit runs joins the run in progress');
        assert(JSON.stringify(await a) === JSON.stringify(oneGo), 'The joined run gives the one-go numbers');

        // --- Test 6: one wash-trading analysis per audit run ---
        // Every floor reads the analysis, and a live floor reads the one kept for 10 s (engine trust.ts
        // getWashTradingEnforcement). A walk over 100,000 members lasts minutes, so floors read that way made a new analysis
        // every 10 s of the walk, each a pass over every trade: the audit grew with the square of the members. The run takes
        // one analysis and reads every floor with it. Here each turn the run gives moves the clock on 11 s, as a long walk
        // would, and the analyses are counted (engine trust.ts washAnalysisCount: every complete one, by any path; the pair
        // totals' query, which this used to count, now runs a page of buyers at a time).
        const realNow = Date.now;
        let clockAhead = 0;
        const analysesBefore = washAnalysisCount();
        Date.now = () => realNow() + clockAhead;
        let longWalk;
        try {
            longWalk = await runWashSybilMetricsAuditSliced({ sliceMs: 0, onYield: () => { clockAhead += 11_000; } });
        } finally {
            Date.now = realNow;
        }
        const analyses = washAnalysisCount() - analysesBefore;
        assert(clockAhead >= activeCount * 11_000, `The run walked past the live analysis's 10 s keep (${clockAhead / 1000} s on the clock)`);
        assert(analyses === 1, `One wash-trading analysis for the whole run (${analyses})`);
        assert(JSON.stringify(longWalk) === JSON.stringify(oneGo), 'It gives the one-go numbers');

        // --- Test 7: the node's own timer runs the audit in slices ---
        // Calling the one-go audit from initStateEngine's timer would hold the loop for the whole run again (20 s at 20,000
        // members). Fired here with the slices' clock (performance.now) moving 5 ms each time it is read, so a 20 ms slice
        // ends every few steps on any machine: the callback returns before the rows land, and the loop gets turns meanwhile.
        // Counted, not timed. The one-go audit would write its rows before the callback returned, with no turn given.
        const metricRows = () => (db.prepare("SELECT COUNT(*) AS n FROM system_metrics WHERE metric_key IN ('total_negative_balance', 'accounts_near_floor', 'delinquent_accounts', 'cohort_anomalies')").get() as { n: number }).n;
        assert(auditTimers.length === 1, `initStateEngine set one 2.5-minute metrics-audit timer (${auditTimers.length})`);
        const rowsBefore = metricRows();
        let loopTurns = 0, looping = true, rowsAtReturn = -1;
        const turn = () => { if (looping) { loopTurns++; setImmediate(turn); } };
        const realPerfNow = performance.now;
        let sliceClock = realPerfNow.call(performance);
        performance.now = () => (sliceClock += 5);
        try {
            setImmediate(turn);
            auditTimers[0]();
            rowsAtReturn = metricRows();
            while (metricRows() === rowsBefore) await new Promise((r) => setImmediate(r));
        } finally {
            looping = false;
            performance.now = realPerfNow;
        }
        const turnsBeforeRows = loopTurns;
        assert(rowsAtReturn === rowsBefore, `The timer's callback returned before the audit wrote its rows (${rowsAtReturn - rowsBefore} rows at return)`);
        // One turn comes from this test's own wait even when nothing yields (the rows are saved in a microtask), so >= 2.
        assert(turnsBeforeRows >= 2, `The loop ran other work while the timer's audit ran (${turnsBeforeRows} turns before its rows landed)`);
        assert(metricRows() === rowsBefore + 4, `The timer's audit wrote its four rows (${metricRows() - rowsBefore})`);
        const timerRun = Object.fromEntries((db.prepare('SELECT metric_key, metric_value FROM system_metrics ORDER BY id DESC LIMIT 4').all() as { metric_key: string; metric_value: number }[]).map(r => [r.metric_key, r.metric_value]));
        const after = runWashSybilMetricsAudit()!;
        assert(timerRun.total_negative_balance === after.totalNegative && timerRun.accounts_near_floor === after.accountsNearFloor
            && timerRun.delinquent_accounts === after.delinquentCount && timerRun.cohort_anomalies === after.cohortAnomalies,
            `The timer's rows are the one-go numbers (${JSON.stringify(timerRun)} vs ${JSON.stringify(after)})`);

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ Backend Visibility Monitors tests PASSED.');
    } catch (e) {
        console.error('❌ Test failed:', e);
        process.exit(1);
    }
    process.exit(0);
}

main();
