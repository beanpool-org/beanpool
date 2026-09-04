/**
 * Test coverage for apple-probe
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.APPLE_PROBE = '1';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8552;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running apple-probe tests...');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // Test GET without APPLE_PROBE_REDIRECT_URI
    const res1 = await fetch(`${BASE}/apple-probe`, {
        headers: {
            'Host': 'localhost:8552'
        }
    });
    assert(res1.status === 200, 'GET /apple-probe works');
    const text1 = await res1.text();
    assert(text1.includes('Apple probe') || text1.includes('Apple Sign In'), 'GET /apple-probe returns HTML');

    // Test POST without token
    const res3 = await fetch(`${BASE}/apple-probe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'a=1'
    });
    assert(res3.status === 400, 'POST /apple-probe without token returns 400');
    const text3 = await res3.text();
    assert(text3.includes('No <code>id_token</code>'), 'POST without token handles error');

    // Test POST with error
    const res4 = await fetch(`${BASE}/apple-probe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'error=invalid_client'
    });
    assert(res4.status === 400, 'POST /apple-probe with Apple error returns 400');
    const text4 = await res4.text();
    assert(text4.includes('invalid_client'), 'POST handles Apple error');

    // Test POST body too large
    const largeBody = 'a=' + 'x'.repeat(17 * 1024);
    const res5 = await fetch(`${BASE}/apple-probe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: largeBody
    });
    assert(res5.status === 413, 'POST /apple-probe large body rejected');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ apple-probe checks PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
