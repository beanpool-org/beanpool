/**
 * Knock ceiling operator alerts (engine/knocks.ts, services/alerts.ts):
 *
 * The first time in a UTC day that the node-wide knock ceiling (KNOCK_RULES: 30 per node per day / the open cap)
 * turns an applicant away as `busy`, the node raises ONE operator alert through the node's existing alert path
 * ('knock.busy'), with counts only, never names or keys, plus a log line. At most once per node per day.
 *
 * Checks:
 *   1. 30 knocks in a day are accepted without alert.
 *   2. The 31st knock in 24 hours → 429 `busy` + exactly one 'knock.busy' operator alert.
 *   3. The alert detail and log line contain counts only (no applicant keys or names).
 *   4. The 32nd knock in the same UTC day → 429 `busy` + NO second alert.
 *   5. Next UTC day (with knocks still within 24h) → 429 `busy` + can alert again (exactly 2 alerts in history).
 *   6. A second knock on the next day → 429 `busy` + no third alert.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-knock-ceiling.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import {
    KNOCK_RULES, submitKnock, _resetKnockCeilingAlertForTests,
} from './engine/knocks.js';
import { getAlertsStatus, resetAlertsForTests } from './services/alerts.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Id { pk: string; name: string }
function newId(name: string): Id {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, name };
}

async function waitForAlert(key: string, expectedCount: number, maxWaitMs = 2000): Promise<any[]> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const matches = getAlertsStatus().history.filter(e => e.key === key);
        if (matches.length >= expectedCount) return matches;
        await new Promise(r => setTimeout(r, 25));
    }
    return getAlertsStatus().history.filter(e => e.key === key);
}

async function main() {
    await initTls();
    await initStateEngine();
    resetAlertsForTests();
    _resetKnockCeilingAlertForTests();

    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        if (line.includes('Requests to join') || line.includes('ceiling reached') || line.includes('busy')) {
            logged.push(line);
        }
        realLog(...args);
    };

    try {
        console.log('\n── 1. 30 knocks accepted on day 1 ──');
        // t0: 18:00 UTC on 2026-10-30
        const t0 = Date.parse('2026-10-30T18:00:00.000Z');
        for (let i = 0; i < 30; i++) {
            const id = newId(`User${i}`);
            const res = submitKnock({
                pubkey: id.pk,
                callsign: id.name,
                message: `Hello from ${id.name}`,
                avatar: null,
                fromNode: null,
                address: `198.51.100.${i + 1}`,
            }, t0);
            assert(res.ok === true, `knock ${i + 1} of 30 accepted`);
        }

        // Verify no knock.busy alert was raised during the first 30 knocks
        const alertsBeforeCeiling = getAlertsStatus().history.filter(e => e.key === 'knock.busy');
        assert(alertsBeforeCeiling.length === 0, `no ceiling alert for the first 30 knocks (${alertsBeforeCeiling.length})`);

        console.log('\n── 2. 31st knock → busy + exactly one alert (counts only) ──');
        const user31 = newId('User31');
        const res31 = submitKnock({
            pubkey: user31.pk,
            callsign: user31.name,
            message: `Hello from ${user31.name}`,
            avatar: null,
            fromNode: null,
            address: '198.51.100.31',
        }, t0 + 1000);

        assert(res31.ok === false && res31.reason === 'busy', `the 31st knock is refused as busy (${JSON.stringify(res31)})`);

        const alertsAfter31 = await waitForAlert('knock.busy', 1);
        assert(alertsAfter31.length === 1, `exactly one 'knock.busy' alert raised (${alertsAfter31.length})`);
        assert(alertsAfter31[0].kind === 'raised', `alert kind is 'raised' (${alertsAfter31[0]?.kind})`);

        const detail = alertsAfter31[0]?.detail ?? '';
        assert(/\b30\b/.test(detail) && /ceiling/i.test(detail) && /busy/i.test(detail), `alert detail describes ceiling reached (${detail})`);
        assert(!detail.includes(user31.pk) && !detail.includes(user31.name), `alert detail contains counts only, no keys or names (${detail})`);

        // Check log line
        assert(logged.length >= 1 && logged.some(l => l.includes('Requests to join ceiling reached') || l.includes('Requests to join are busy')),
            `a log line was printed for the ceiling alert (${logged.join(' | ')})`);
        assert(!logged.some(l => l.includes(user31.pk) || l.includes(user31.name)), 'log lines contain no keys or names');

        console.log('\n── 3. 32nd knock (same UTC day) → busy + no second alert ──');
        const user32 = newId('User32');
        const res32 = submitKnock({
            pubkey: user32.pk,
            callsign: user32.name,
            message: `Hello from ${user32.name}`,
            avatar: null,
            fromNode: null,
            address: '198.51.100.32',
        }, t0 + 2000);

        assert(res32.ok === false && res32.reason === 'busy', `the 32nd knock is refused as busy`);
        // Wait a brief moment to ensure no asynchronous second alert is fired
        await new Promise(r => setTimeout(r, 100));
        const alertsAfter32 = getAlertsStatus().history.filter(e => e.key === 'knock.busy');
        assert(alertsAfter32.length === 1, `32nd knock in the same UTC day produces NO second alert (still ${alertsAfter32.length})`);

        console.log('\n── 4. Next UTC day → busy + can alert again ──');
        // t1: 06:00 UTC on 2026-10-31 (12 hours after t0; new UTC day, but knocks from t0 are still within 24h)
        const t1 = Date.parse('2026-10-31T06:00:00.000Z');
        const userNextDay = newId('UserNextDay');
        const resNextDay = submitKnock({
            pubkey: userNextDay.pk,
            callsign: userNextDay.name,
            message: `Hello from ${userNextDay.name}`,
            avatar: null,
            fromNode: null,
            address: '198.51.100.33',
        }, t1);

        assert(resNextDay.ok === false && resNextDay.reason === 'busy', `next day knock is refused as busy (${JSON.stringify(resNextDay)})`);
        const alertsNextDay = await waitForAlert('knock.busy', 2);
        assert(alertsNextDay.length === 2, `next day knock raises second alert (${alertsNextDay.length})`);

        console.log('\n── 5. Second knock on next UTC day → busy + no third alert ──');
        const userNextDay2 = newId('UserNextDay2');
        const resNextDay2 = submitKnock({
            pubkey: userNextDay2.pk,
            callsign: userNextDay2.name,
            message: `Hello from ${userNextDay2.name}`,
            avatar: null,
            fromNode: null,
            address: '198.51.100.34',
        }, t1 + 1000);

        assert(resNextDay2.ok === false && resNextDay2.reason === 'busy', `second next-day knock refused as busy`);
        await new Promise(r => setTimeout(r, 100));
        const alertsAfterNextDay2 = getAlertsStatus().history.filter(e => e.key === 'knock.busy');
        assert(alertsAfterNextDay2.length === 2, `second knock on next day produces NO third alert (still ${alertsAfterNextDay2.length})`);

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    } finally {
        console.log = realLog;
    }
}

main().then(() => process.exit(0)).catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
