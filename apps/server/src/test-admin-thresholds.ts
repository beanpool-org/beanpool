/**
 * Integration tests for admin thresholds endpoints (/api/admin/thresholds and /api/admin/thresholds/get).
 *
 * Verifies:
 * 1. POST /api/admin/thresholds/get returns current thresholds and defaults when authenticated via x-admin-password header.
 * 2. POST /api/admin/thresholds/get rejects unauthenticated or invalid auth requests with 401.
 * 3. POST /api/admin/thresholds updates valid threshold keys when correct password is provided in body.
 * 4. POST /api/admin/thresholds rejects updates with invalid password with 401.
 * 5. POST /api/admin/thresholds ignores unknown/disallowed keys, the circulation rate and its epoch among them: read by
 *    nothing that moves Beans, they are no threshold any more (How this community works S3, the design's Q10). One stored
 *    before is never read, and leaves the file at the next save.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestThresholdsAdmin123!';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword, getThresholds, DEFAULT_THRESHOLDS, getLocalConfig, updateLocalConfig } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';
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
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    // Step 7c: with the node's 2FA off the password alone opens no admin route (header or body); from then on 2FA is on
    // and each password goes with a code.
    const aloneHeader = await fetch(`${BASE}/api/admin/thresholds/get`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': PW } });
    const aloneHeaderBody = await aloneHeader.json() as any;
    assert(aloneHeader.status === 403 && aloneHeaderBody.code === 'password_needs_2fa' && aloneHeaderBody.thresholds === undefined,
        `2FA off: thresholds/get with the password header alone → 403 password_needs_2fa (got ${aloneHeader.status})`);
    const aloneBody = await fetch(`${BASE}/api/admin/thresholds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW, inactiveMemberDays: 70 }) });
    assert(aloneBody.status === 403 && getThresholds().inactiveMemberDays !== 70,
        `2FA off: thresholds update with the body password alone → 403, nothing changed (got ${aloneBody.status})`);
    const tfa = turnOn2faForTests(PW);

    // 1. Test POST /api/admin/thresholds/get with valid admin header auth
    const getResOk = await fetch(`${BASE}/api/admin/thresholds/get`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...tfa.headers(),
        },
    });
    assert(getResOk.status === 200, `POST /api/admin/thresholds/get with valid auth returns 200 (got ${getResOk.status})`);
    const getBodyOk = await getResOk.json() as any;
    assert(getBodyOk.thresholds !== undefined && getBodyOk.defaults !== undefined, 'Response includes thresholds and defaults');
    assert(getBodyOk.defaults.inactiveMemberDays === DEFAULT_THRESHOLDS.inactiveMemberDays, 'Defaults match DEFAULT_THRESHOLDS');
    assert(!('circulationRate' in getBodyOk.thresholds) && !('circulationEpochDays' in getBodyOk.defaults), 'No circulation rate, read or default: nothing reads one');

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
        body: JSON.stringify({ password: 'WrongPassword123!', inactiveMemberDays: 50 }),
    });
    assert(postResBadPw.status === 401, `POST /api/admin/thresholds with bad password returns 401 (got ${postResBadPw.status})`);

    // 4. Test POST /api/admin/thresholds with valid password and valid threshold updates. A circulation rate stored before
    //    S3 is in the file: never read, and gone after the save.
    updateLocalConfig({ thresholds: { ...DEFAULT_THRESHOLDS, circulationRate: 0.02, circulationEpochDays: 20 } as any });
    assert(!('circulationRate' in getThresholds()), 'a circulation rate stored before is never read');
    const postResOk = await fetch(`${BASE}/api/admin/thresholds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PW, totpCode: tfa.code(), inactiveMemberDays: 80, unknownKey: 999, circulationRate: 0.08 }),
    });
    assert(postResOk.status === 200, `POST /api/admin/thresholds with valid password returns 200 (got ${postResOk.status})`);
    const postBodyOk = await postResOk.json() as any;
    assert(postBodyOk.thresholds?.inactiveMemberDays === 80, 'Threshold inactiveMemberDays updated successfully');
    assert(postBodyOk.thresholds?.unknownKey === undefined, 'Unknown threshold keys filtered out');
    assert(postBodyOk.thresholds?.circulationRate === undefined, 'and so is the circulation rate: no threshold any more');
    const stored = getLocalConfig().thresholds as Record<string, unknown> | undefined;
    assert(!!stored && !('circulationRate' in stored) && !('circulationEpochDays' in stored), `the save left the stored circulation rate out of the file (${JSON.stringify(stored)})`);

    // Verify persistence via getThresholds()
    const currentThresholds = getThresholds();
    assert(currentThresholds.inactiveMemberDays === 80, 'Updated threshold persists in local config');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Admin thresholds checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
