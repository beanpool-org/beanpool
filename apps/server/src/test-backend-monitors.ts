/**
 * Backend Visibility Monitors Regression Tests (Aggregate Invariant, Cohort Velocity, Delinquency)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backend-monitors.ts
 */

import {
    initStateEngine,
    runWashSybilMetricsAudit, runWashSybilMetricsAuditSliced, getCommunityHealth,
    reconcileLedgerFromDb, washAnalysisCount, createTreasury, getMemberTrustProfile
} from './state-engine.js';
import { db } from './db/db.js';
import { grantNodeRole } from './engine/node-roles.js';
/** A floor set by hand in the granted lane (members.earned_credit_c): a tier badge gives no credit (engine/badges.ts). */
const grantLine = (pk: string, c: number) => { db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(c, pk); };

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** The story's Beans as the node's whole hundredths: balances, floors, transfers and the metrics (total negative balance). */
const hc = (beans: number) => Math.round(beans * 100);

let seq = 0;
/** `balance`: whole hundredths. */
function seedMember(pk: string, balance = 0, joinedAtDaysAgo = 0) {
    const joinedAt = new Date(Date.now() - joinedAtDaysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, ?)`).run(pk, pk.slice(0, 8), joinedAt);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, 0)`).run(pk, balance);
}

// A direct peer-to-peer transfer (gift) to establish transaction timestamps. `amount`: whole hundredths.
function tx(from: string, to: string, amount: number, daysAgo = 0) {
    const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, memo, timestamp) VALUES (?,?,?,?,?,?)`)
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
        seedMember(user1, -hc(100), 20); // 20 days old, balance -100
        seedMember(user2, -hc(50), 20);  // 20 days old, balance -50
        reconcileLedgerFromDb();

        // Give them some floor so their balances are valid credit uses
        grantLine(user1, hc(200)); // floor -200
        grantLine(user2, hc(200)); // floor -200

        // Run the audit
        const metrics1 = runWashSybilMetricsAudit()!;
        assert(metrics1.totalNegative === hc(150), `Total negative balance metric computed: 150 (got ${metrics1.totalNegative} hundredths)`);
        assert(metrics1.accountsNearFloor === 0, `No accounts near floor yet (got ${metrics1.accountsNearFloor})`);

        // Move user1 closer to their floor (-195, floor is -200)
        db.prepare("UPDATE accounts SET balance_c = ? WHERE public_key = ?").run(-hc(195), user1);
        reconcileLedgerFromDb();
        const metrics2 = runWashSybilMetricsAudit()!;
        assert(metrics2.accountsNearFloor === 1, `1 account near floor detected (got ${metrics2.accountsNearFloor})`);

        // --- Test 2: Delinquency report ---
        // user1 balance is -195, floor is -200 (spent 97.5% >= 80%).
        // They haven't had transactions, so they should be dormant (no tx in last 7 days).
        // delinquentCount should be 1.
        assert(metrics2.delinquentCount === 1, `1 delinquent account detected (got ${metrics2.delinquentCount})`);

        // Perform a recent transaction for user1 (makes them active, not dormant)
        tx(user1, user2, hc(5), 0); // 0 days ago (recent)
        const metrics3 = runWashSybilMetricsAudit()!;
        assert(metrics3.delinquentCount === 0, `0 delinquent accounts after recent transaction (got ${metrics3.delinquentCount})`);

        // --- Test 3c: a new community enterprise is no new member, even one an owner's pledge funds (the deciding review of
        // #3121, engine audit.ts: two enterprises an owner pledged 800 and 700 Beans to were named as new members whose
        // allowance came from "Trades", counted, and the flag said "not counting what an owner or admin gave") ---
        // One new person and two new enterprises of one join week, two days old, before any other cohort of these 14 days
        // exists (Test 3's members join this week later, so they meet the same three).
        const pledger = `plgo-${Date.now()}`;
        seedMember(pledger, 0, 60);
        grantNodeRole(pledger, 'owner', 'SYSTEM');
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const newPerson = `newp-${Date.now()}`;
        seedMember(newPerson, 0, 2);
        const enterprises = [hc(800), hc(700)].map((amount, i) => {
            const { publicKey } = createTreasury(`Pledged Enterprise ${i}`, '', 0, { systemCreated: true });
            db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(twoDaysAgo, publicKey);
            // The owner's pledge as the node keeps it (enterprise_pledges, which the enterprise's line reads: engine trust.ts
            // enterpriseAllowance); pledgeEnterpriseBacking's own rules are test-derived-enterprise-floor's.
            db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount_c) VALUES (?, ?, ?, ?)').run('pl' + (seq++), pledger, publicKey, amount);
            return publicKey;
        });
        assert(enterprises.every((e, i) => getMemberTrustProfile(e).earnedCredit === [hc(800), hc(700)][i]),
            `each enterprise's line is the owner's pledge (${enterprises.map(e => getMemberTrustProfile(e).earnedCredit).join(', ')})`);
        const metricsEnterprises = runWashSybilMetricsAudit()!;
        assert(!metricsEnterprises.cohortMembers.some(m => enterprises.includes(m.pubkey)),
            `no enterprise is named as a new member (${JSON.stringify(metricsEnterprises.cohortMembers)})`);
        assert(metricsEnterprises.cohortAnomalies === 0, `one new person and two enterprises are no cohort anomaly (${metricsEnterprises.cohortAnomalies})`);
        assert(!getCommunityHealth().flags.some(f => f.type === 'cohort_velocity'), 'and raise no flag');

        // --- Test 3a: a cohort on the Resident tier's floor is no velocity anomaly ---
        // Floors are whole hundredths: a Resident's -200 Beans is -20000. The line is the Resident threshold (-600 Beans),
        // not -600 hundredths (6 Beans), which every new member with a vouch or the known grant passes (the deciding review
        // of #3033, engine audit.ts). Nine days old: under 14, and a week apart from Test 3's cohort.
        const residents = Array.from({ length: 3 }, (_, i) => `res${i}-${Date.now()}`);
        for (const u of residents) {
            seedMember(u, 0, 9);
            grantLine(u, hc(200)); // floor -200
        }
        const metricsResidents = runWashSybilMetricsAudit()!;
        assert(metricsResidents.cohortAnomalies === 0,
            `a week's cohort of new members at a -200 Beans floor is not fast-growing: the line is -600 Beans (got ${metricsResidents.cohortAnomalies})`);

        // --- Test 3b: an allowance an owner or admin gave on purpose is never counted (Marty, 14 Nov 2026: the flag fired on
        // presets and grants the owners gave, and named nobody) ---
        const owner = `ownr-${Date.now()}`;
        seedMember(owner, 0, 60);
        grantNodeRole(owner, 'owner', 'SYSTEM');
        const voucher = `vouc-${Date.now()}`;
        seedMember(voucher, 0, 60); // a voucher who is no owner or admin
        const vouch = (from: string, to: string, c: number) => db.prepare(`INSERT INTO room_gifts (id, from_pubkey, to_pubkey, root_pubkey, kind, amount_c)
            VALUES (?, ?, ?, ?, 'vouch', ?)`).run('rg' + (seq++), from, to, from, c);
        const given = Array.from({ length: 4 }, (_, i) => `givn${i}-${Date.now()}`);
        given.forEach((u, i) => {
            seedMember(u, 0, 9); // 9 days old: Test 3a's week, where 4 of its 7 now stand at 600 Beans
            if (i % 2 === 0) grantLine(u, hc(600)); // granted by hand: 600 Beans
            else vouch(owner, u, hc(600)); // the owner's vouch (a preset): 600 Beans
        });
        const metricsGiven = runWashSybilMetricsAudit()!;
        assert(metricsGiven.cohortAnomalies === 0 && metricsGiven.cohortMembers.length === 0,
            `four of a week's seven new members at a 600-Bean allowance an owner gave are no anomaly (${metricsGiven.cohortAnomalies}, ${JSON.stringify(metricsGiven.cohortMembers)})`);
        assert(!getCommunityHealth().flags.some(f => f.type === 'cohort_velocity'), 'and raise no flag');

        // --- Test 3: Cohort Velocity Report: who, how deep, when, and what gave it ---
        // Four new accounts of one week, each vouched 600 Beans by a voucher who is no owner or admin: the line reached by a
        // route other than an owner's grant.
        const cohortUsers = Array.from({ length: 4 }, (_, i) => `coh${i}-${Date.now()}`);
        for (const u of cohortUsers) {
            seedMember(u, 0, 2); // 2 days old (new member)
            vouch(voucher, u, hc(600)); // floor -600, from a voucher
        }
        const metrics4 = runWashSybilMetricsAudit()!;
        assert(metrics4.cohortAnomalies === 1, `Cohort velocity anomaly detected (got ${metrics4.cohortAnomalies})`);
        const named = new Set(metrics4.cohortMembers.map(m => m.pubkey));
        assert(named.size === 4 && cohortUsers.every(u => named.has(u)) && given.every(u => !named.has(u)),
            `the check keeps WHO: the four the voucher vouched, none of those the owner gave to (${[...named].join(', ')})`);
        const one = metrics4.cohortMembers.find(m => m.pubkey === cohortUsers[0]);
        assert(!!one && one.allowance_c === hc(600) && one.counted_c === hc(600) && one.daysAfterJoining === 2
            && JSON.stringify(one.parts) === JSON.stringify([{ kind: 'vouch', from: voucher, amount_c: hc(600), counted: true }]),
            `per member: how deep (600 Beans), days after joining (2), and who gave it (the voucher's vouch) (${JSON.stringify(one)})`);

        // --- Test 4: getCommunityHealth Alerts ---
        const health1 = getCommunityHealth();
        const cohortFlag = health1.flags.find(f => f.type === 'cohort_velocity');
        assert(!!cohortFlag, 'the cohort flag was raised in community health report');
        assert(!!cohortFlag && cohortFlag.members.length === 4 && cohortUsers.every(u => cohortFlag.members.includes(u)),
            `it names the four members (${cohortFlag?.members.length})`);
        assert(!!cohortFlag && cohortFlag.allowances?.length === 4 && cohortFlag.allowances.every(a => a.allowance_c === hc(600) && a.daysAfterJoining === 2 && a.parts[0]?.from === voucher),
            `with each one's allowance, days after joining and giver (${JSON.stringify(cohortFlag?.allowances?.[0])})`);
        assert(!!cohortFlag && /allowance/.test(cohortFlag.description) && /not what they spent/.test(cohortFlag.description) && !/floor/i.test(cohortFlag.description),
            `in plain words: allowance, not spending, never "floor" (${cohortFlag?.description})`);
        // The day it got there is the day the check first found it, not the account's age at each run.
        db.prepare('DELETE FROM room_gifts WHERE to_pubkey = ?').run(cohortUsers[3]);
        runWashSybilMetricsAudit();
        const kept = db.prepare('SELECT member_pubkey FROM cohort_allowance_members').pluck().all() as string[];
        assert(!kept.includes(cohortUsers[3]), `a member no longer past the line goes at the next run (${kept.length} kept)`);
        vouch(voucher, cohortUsers[3], hc(600));
        runWashSybilMetricsAudit();
        db.prepare('UPDATE cohort_allowance_members SET days_after_joining = 1 WHERE member_pubkey = ?').run(cohortUsers[0]);
        runWashSybilMetricsAudit();
        const days0 = (db.prepare('SELECT days_after_joining AS d FROM cohort_allowance_members WHERE member_pubkey = ?').get(cohortUsers[0]) as { d: number } | undefined)?.d;
        assert(days0 === 1, `a member found before keeps the day it was first found on the next run (${days0})`);

        // --- Test 4b: the invite-funnel alert's line is the owner's Beans (100 by default), the sums whole hundredths ---
        // (the deciding review of #3033, state-engine.ts: it compared hundredths with Beans, so it fired at 1 Bean, and its
        // words said "15000B" for 150 Beans).
        const farmer = `farm-${Date.now()}`;
        seedMember(farmer, 0, 30);
        const puppets = [`pupA-${Date.now()}`, `pupB-${Date.now()}`];
        for (const p of puppets) {
            seedMember(p, 0, 20);
            db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(farmer, p);
        }
        const funnelOf = () => getCommunityHealth().flags.find((f) => f.type === 'sybil_funnel' && (f as { members?: string[] }).members?.[0] === farmer);
        tx(puppets[0], farmer, hc(0.5), 1);
        tx(puppets[1], farmer, hc(0.5), 1);
        assert(!funnelOf(), 'two invitees sending their inviter 1 Bean in all raise no invite-funnel alert: the line is 100 Beans');
        tx(puppets[0], farmer, hc(75), 1);
        tx(puppets[1], farmer, hc(74), 1);
        const funnel = funnelOf();
        assert(!!funnel && funnel.description.includes('sent 150 Beans back'),
            `at 150 Beans in all it is raised, its figure in Beans (${funnel?.description ?? 'no flag'})`);

        // Let's test the Aggregate Credit Spike alert.
        // We need a previous metric from system_metrics table created at <datetime('now', '-23 hours')
        // Let's manually insert a yesterday metric with total_negative_balance = 100 (Beans: the metric is whole hundredths)
        const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        db.prepare("INSERT INTO system_metrics (timestamp, metric_key, metric_value) VALUES (?, ?, ?)")
            .run(yesterday, 'total_negative_balance', hc(100));

        // Current metrics should be around 150 + 195 + 50... wait, let's see.
        // Let's force-insert the current metric to be 1000 (growth: (1000-100)/100 = 900% growth, absolute 900 beans >= 500)
        db.prepare("INSERT INTO system_metrics (timestamp, metric_key, metric_value) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)")
            .run('total_negative_balance', hc(1000));

        const health2 = getCommunityHealth();
        const spikeFlag = health2.flags.find(f => f.type === 'aggregate_spike' && f.description.includes('Aggregate credit spike'));
        assert(!!spikeFlag, 'Aggregate credit spike alert was raised in community health report');
        assert(!!spikeFlag?.description.includes('increased by 900.0%'), `Description is correct (got: "${spikeFlag?.description}")`);

        // --- Test 5: the audit as the node's timers run it, a slice at a time ---
        // In one go it held a 20,000-member node for 20 s (the global load test, 2026-10-11). Sliced, it gives the event
        // loop a turn between slices; with sliceMs 0 a turn after every step, and every active member is at least one
        // step. The turns are counted, not timed, so a slow CI machine cannot fail it.
        for (let i = 0; i < 20; i++) seedMember(`slice${i}-${Date.now()}`, i % 3 === 0 ? -hc(5) : hc(10), 30 + i);
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

        // --- Test 8: members with no trades are no flag (Marty, 4 Nov: "do I really care about inactive users? ... I dont think I need to scan for this") ---
        const idle = 'idleA-' + Date.now();
        seedMember(idle, 0, 200); // joined 200 days ago, no trades at all
        db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(user1, idle);
        const health8 = getCommunityHealth();
        assert(health8.activity.inactiveMemberCount >= 1, `The member who has not traded is still in the activity count (${health8.activity.inactiveMemberCount})`);
        assert(!health8.flags.some(f => (f.type as string) === 'inactive_member'), `No inactive-member flag is raised (${JSON.stringify(health8.flags.map(f => f.type))})`);
        assert(!health8.flags.some(f => f.members.includes(idle)), 'No flag names the member who has not traded');

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
