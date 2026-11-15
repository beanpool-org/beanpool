/**
 * The auth limiter's buckets, one per route (auth-rate-limit.ts; the privacy review's S8, 2026-10-14), through the
 * real middleware, from one address: a hall's Wi-Fi or a carrier's NAT. Pairing, the names (the name check, which says
 * whether a name is here; the recovery lookup by name that shared its bucket was deleted in S3) and the admin routes'
 * bucket each keep their own 15 a minute per address; none spends another's. The admin routes that call this limiter (the first invite, the
 * identity update, the connectors and the rest: auth-rate-limit.ts) still share their one bucket, so across them a
 * guesser gets no more than before. (The password check that was here went with the admin password, 11 Nov 2026.)
 *
 * Before this, one bucket served them all: after 15 pairing calls the name check answered 429 to everyone behind
 * the address (fail-first on origin/main 1b85fb83: the checks marked FAIL-FIRST below fail there).
 *
 * Run (through the repo's runner): SERVER_SUITES_ONLY=test-auth-limit-buckets node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { createPairingSession } from '@beanpool/core';
import { AUTH_RATE_LIMIT, pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const pairInit = async () => {
    const s = createPairingSession();
    return (await fetch(`${BASE}/api/pair/init`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s.sessionId, desktopPubHex: s.publicKeyHex }),
    })).status;
};
const nameCheck = async (name: string) => (await fetch(`${BASE}/api/members/callsign-available/${name}`)).status;
/** The first invite (POST /api/admin/seed-invite), on the admin routes' bucket: with no credential, 401 once it is read. */
const adminRoute = async () => (await fetch(`${BASE}/api/admin/seed-invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
})).status;
/** Another route on the same bucket: the identity update (POST /api/local/update-identity). */
const otherAdminRoute = async () => (await fetch(`${BASE}/api/local/update-identity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
})).status;

async function statuses(n: number, f: (i: number) => Promise<number>): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(await f(i));
    return out;
}

async function main() {
    console.log('🧪 The auth limiter: one bucket per route, from one address\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const N = AUTH_RATE_LIMIT.perAddress;
    assert(N === 15 && AUTH_RATE_LIMIT.windowMs === 60_000, `each bucket is 15 a minute per address, as the one bucket was (${N} per ${AUTH_RATE_LIMIT.windowMs} ms)`);

    // ── 1. A hall pairs its phones ──
    console.log('\n── 1. pairing spends only its own bucket ──');
    resetGatewayRateLimit();
    const pairs = await statuses(N, () => pairInit());
    assert(pairs.every(s => s === 200), `${N} QR pairings from one address: all 200 (${pairs.join(',')})`);
    assert(await pairInit() === 429, `the ${N + 1}th pairing in the minute: 429 (pairing keeps its own limit)`);
    const afterPairs = await nameCheck('HallNewcomer');
    assert(afterPairs === 200, `FAIL-FIRST: after ${N} pairings, the name check still answers (${afterPairs}; was 429)`);
    const adminAfterPairs = await adminRoute();
    assert(adminAfterPairs === 401, `FAIL-FIRST: and an admin route reads the request (${adminAfterPairs}: 401 no credential; was 429)`);

    // ── 2. Each bucket still meets its own limit at its own number ──
    console.log('\n── 2. each bucket keeps its own 15 a minute ──');
    resetGatewayRateLimit();
    // Section 1 spent 1 of the names bucket (one name check).
    const names = await statuses(N - 1, i => nameCheck(`Name${i}`));
    const namesFull = await nameCheck('NameLast');
    assert(names.every(s => s === 200) && namesFull === 429,
        `the name check: ${N} in the minute, then 429 (${[...names, namesFull].join(',')})`);
    resetGatewayRateLimit();
    const admins = await statuses(N - 1, () => adminRoute());
    assert(admins.every(s => s === 401) && await adminRoute() === 429,
        `the admin routes' bucket: ${N} in the minute, then 429 (${admins.join(',')})`);
    const other = await otherAdminRoute();
    assert(other === 429, `no looser than before: the identity update shares that bucket, so it is spent too (${other})`);

    // ── 3. The minute ends (the limiter's own clock: its sweep, two minutes on) ──
    console.log('\n── 3. the windows reopen ──');
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const reopened = [await pairInit(), await nameCheck('Again'), await adminRoute()];
    assert(reopened.join(',') === '200,200,401', `a minute on, every bucket answers again (${reopened.join(',')})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ People sharing one address no longer lock each other out of pairing, the name check or an admin route.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
