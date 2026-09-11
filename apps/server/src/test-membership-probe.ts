/**
 * Test coverage for lightweight membership probe GET /api/community/membership/:publicKey
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8588;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running membership probe tests...');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // Case 1: Active registered member (seeded genesis member)
    const memberPubkey = 'pubkey_member_123';
    seedGenesisMember(memberPubkey, 'alice');
    const res1 = await fetch(`${BASE}/api/community/membership/${memberPubkey}`);
    assert(res1.status === 200, 'GET /api/community/membership/:publicKey returns 200 for member');
    const body1 = await res1.json() as any;
    assert(body1.isMember === true, 'isMember is true for registered member');
    assert(body1.callsign === 'alice', 'returns correct callsign for member');

    // Case 2: Non-existent member / unknown public key
    const unknownPubkey = 'pubkey_unknown_456';
    const res2 = await fetch(`${BASE}/api/community/membership/${unknownPubkey}`);
    assert(res2.status === 200, 'GET /api/community/membership/:publicKey returns 200 for unknown key');
    const body2 = await res2.json() as any;
    assert(body2.isMember === false, 'isMember is false for unknown key');
    assert(body2.callsign === null, 'callsign is null for unknown key');
    assert(body2.isRecovering === false, 'isRecovering is false for unknown key');
    assert(body2.recoveryStatus === null, 'recoveryStatus is null for unknown key');

    // Case 3: Another active registered member
    const bobPubkey = 'pubkey_bob_789';
    seedGenesisMember(bobPubkey, 'bob');
    const res3 = await fetch(`${BASE}/api/community/membership/${bobPubkey}`);
    assert(res3.status === 200, 'GET /api/community/membership/:publicKey returns 200 for bob');
    const body3 = await res3.json() as any;
    assert(body3.isMember === true, 'isMember is true for bob');
    assert(body3.callsign === 'bob', 'callsign is bob');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ membership probe checks PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
