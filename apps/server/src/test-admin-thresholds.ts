/**
 * Integration tests for admin thresholds endpoints (/api/admin/thresholds and /api/admin/thresholds/get).
 *
 * Verifies:
 * 1. POST /api/admin/thresholds/get returns current thresholds and defaults when authenticated via x-admin-password header.
 * 2. POST /api/admin/thresholds/get rejects unauthenticated or invalid auth requests with 401.
 * 3. POST /api/admin/thresholds updates valid threshold keys when correct password is provided in body.
 * 4. POST /api/admin/thresholds rejects updates with invalid password with 401.
 * 5. POST /api/admin/thresholds ignores unknown/disallowed keys.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestThresholdsAdmin123!';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword, getThresholds, DEFAULT_THRESHOLDS } from './config/local-config.js';

const PORT = 8556;
const BASE = `https://localhost:${PORT}`;
const PW = 'TestThresholdsAdmin123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running admin thresholds endpoint tests...\n');
    initAdminPassword();

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // 1. Test POST /api/admin/thresholds/get with valid admin header auth
    const getResOk = await fetch(`${BASE}/api/admin/thresholds/get`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-admin-password': PW,
        },
    });
    assert(getResOk.status === 200, `POST /api/admin/thresholds/get with valid auth returns 200 (got ${getResOk.status})`);
    const getBodyOk = await getResOk.json() as any;
    assert(getBodyOk.thresholds !== undefined && getBodyOk.defaults !== undefined, 'Response includes thresholds and defaults');
    assert(getBodyOk.defaults.circulationRate === DEFAULT_THRESHOLDS.circulationRate, 'Defaults match DEFAULT_THRESHOLDS');

    // 2. Test POST /api/admin/thresholds/get without auth
    const getResNoAuth = await fetch(`${BASE}/api/admin/thresholds/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    assert(getResNoAuth.status === 401, `POST /api/admin/thresholds/get without auth returns 401 (got ${getResNoAuth.status})`);

    // 3. Test POST /api/admin/thresholds with invalid password
    const postResBadPw = await fetch(`${BASE}/api/admin/thresholds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'WrongPassword123!', circulationRate: 0.05 }),
    });
    assert(postResBadPw.status === 401, `POST /api/admin/thresholds with bad password returns 401 (got ${postResBadPw.status})`);

    // 4. Test POST /api/admin/thresholds with valid password and valid threshold updates
    const postResOk = await fetch(`${BASE}/api/admin/thresholds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PW, circulationRate: 0.08, unknownKey: 999 }),
    });
    assert(postResOk.status === 200, `POST /api/admin/thresholds with valid password returns 200 (got ${postResOk.status})`);
    const postBodyOk = await postResOk.json() as any;
    assert(postBodyOk.thresholds?.circulationRate === 0.08, 'Threshold circulationRate updated successfully');
    assert(postBodyOk.thresholds?.unknownKey === undefined, 'Unknown threshold keys filtered out');

    // Verify persistence via getThresholds()
    const currentThresholds = getThresholds();
    assert(currentThresholds.circulationRate === 0.08, 'Updated threshold persists in local config');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Admin thresholds checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
