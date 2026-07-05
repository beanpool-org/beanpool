/**
 * Backend Visibility Monitors Regression Tests (Aggregate Invariant, Cohort Velocity, Delinquency)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backend-monitors.ts
 */

import {
    initStateEngine, adminSetTier,
    runWashSybilMetricsAudit, getCommunityHealth,
    reconcileLedgerFromDb
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
    initStateEngine();

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
        const metrics1 = runWashSybilMetricsAudit();
        assert(metrics1.totalNegative === 150, `Total negative balance metric computed: 150 (got ${metrics1.totalNegative})`);
        assert(metrics1.accountsNearFloor === 0, `No accounts near floor yet (got ${metrics1.accountsNearFloor})`);

        // Move user1 closer to their floor (-195, floor is -200)
        db.prepare("UPDATE accounts SET balance = -195 WHERE public_key = ?").run(user1);
        reconcileLedgerFromDb();
        const metrics2 = runWashSybilMetricsAudit();
        assert(metrics2.accountsNearFloor === 1, `1 account near floor detected (got ${metrics2.accountsNearFloor})`);

        // --- Test 2: Delinquency report ---
        // user1 balance is -195, floor is -200 (spent 97.5% >= 80%).
        // They haven't had transactions, so they should be dormant (no tx in last 7 days).
        // delinquentCount should be 1.
        assert(metrics2.delinquentCount === 1, `1 delinquent account detected (got ${metrics2.delinquentCount})`);

        // Perform a recent transaction for user1 (makes them active, not dormant)
        tx(user1, user2, 5, 0); // 0 days ago (recent)
        const metrics3 = runWashSybilMetricsAudit();
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
        const metrics4 = runWashSybilMetricsAudit();
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
