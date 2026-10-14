/**
 * The auth limiter's buckets, one per route (auth-rate-limit.ts; the privacy review's S8, 2026-10-14), through the
 * real middleware, from one address: a hall's Wi-Fi or a carrier's NAT. Pairing, the name check, the recovery lookup
 * and the password check each keep their own 15 a minute per address; none spends another's. The password check
 * still shares one bucket with every other route that takes the admin password, so a guesser gets no more than before.
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
const lookup = async (name: string) => (await fetch(`${BASE}/api/recovery/lookup/${name}`)).status;
const passwordCheck = async () => (await fetch(`${BASE}/api/local/verify-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
})).status;
const changePassword = async () => (await fetch(`${BASE}/api/local/change-password`, {
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
    const lookupAfterPairs = await lookup('hallnewcomer');
    assert(lookupAfterPairs === 200, `FAIL-FIRST: and the recovery lookup (${lookupAfterPairs}; was 429)`);
    const passwordAfterPairs = await passwordCheck();
    assert(passwordAfterPairs === 400, `FAIL-FIRST: and the password check reads the request (${passwordAfterPairs}: 400 no password; was 429)`);

    // ── 2. Each route still meets its own limit at its own number ──
    console.log('\n── 2. each route keeps its own 15 a minute ──');
    resetGatewayRateLimit();
    const names = await statuses(N - 1, i => nameCheck(`Name${i}`));
    assert(names.every(s => s === 200) && await nameCheck('NameLast') === 429,
        `the name check: ${N} in the minute, then 429 (${names.length + 1} answered)`);
    const lookups = await statuses(N - 1, i => lookup(`name${i}`));
    assert(lookups.every(s => s === 200) && await lookup('namelast') === 429,
        `the recovery lookup: ${N} in the minute, then 429`);
    resetGatewayRateLimit();
    const passwords = await statuses(N - 1, () => passwordCheck());
    assert(passwords.every(s => s === 400) && await passwordCheck() === 429,
        `the password check: ${N} in the minute, then 429 (${passwords.join(',')})`);
    const change = await changePassword();
    assert(change === 429, `no looser than before: change-password shares the password check's bucket, so it is spent too (${change})`);

    // ── 3. The minute ends (the limiter's own clock: its sweep, two minutes on) ──
    console.log('\n── 3. the windows reopen ──');
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const reopened = [await pairInit(), await nameCheck('Again'), await lookup('again'), await passwordCheck()];
    assert(reopened.join(',') === '200,200,200,400', `a minute on, every bucket answers again (${reopened.join(',')})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ People sharing one address no longer lock each other out of pairing, the name check or a recovery lookup.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
