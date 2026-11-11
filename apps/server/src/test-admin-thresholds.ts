/**
 * Integration tests for admin thresholds endpoints (/api/admin/thresholds and /api/admin/thresholds/get).
 *
 * Verifies:
 * 0. The node has no admin password: an old one in the X-Admin-Password header or the body opens neither route (401).
 * 1. POST /api/admin/thresholds/get returns current thresholds and defaults to an owner's automation token.
 * 2. POST /api/admin/thresholds/get rejects unauthenticated requests with 401.
 * 3. POST /api/admin/thresholds rejects updates with a wrong token with 401.
 * 4. POST /api/admin/thresholds updates valid threshold keys for an owner's token.
 * 5. POST /api/admin/thresholds ignores unknown/disallowed keys, the circulation rate and its epoch among them: read by
 *    nothing that moves Beans, they are no threshold any more (How this community works S3, the design's Q10). One stored
 *    before is never read, and leaves the file at the next save.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { getThresholds, DEFAULT_THRESHOLDS, getLocalConfig, updateLocalConfig } from './config/local-config.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';
/** What an older install's admin password looked like: no credential now. */
const PW = 'TestThresholdsAdmin123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running admin thresholds endpoint tests...\n');

    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    // 0. The node has no admin password: one sent in the header or the body is no credential.
    const aloneHeader = await fetch(`${BASE}/api/admin/thresholds/get`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': PW } });
    const aloneHeaderBody = await aloneHeader.json() as any;
    assert(aloneHeader.status === 401 && aloneHeaderBody.notSignedIn === true && aloneHeaderBody.thresholds === undefined,
        `thresholds/get with a password header → 401 notSignedIn (got ${aloneHeader.status})`);
    const aloneBody = await fetch(`${BASE}/api/admin/thresholds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW, inactiveMemberDays: 70 }) });
    assert(aloneBody.status === 401 && getThresholds().inactiveMemberDays !== 70,
        `thresholds update with a body password → 401, nothing changed (got ${aloneBody.status})`);
    const asOwner = ownerTokenHeaders('admin');

    // 1. Test POST /api/admin/thresholds/get with valid admin header auth
    const getResOk = await fetch(`${BASE}/api/admin/thresholds/get`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...asOwner,
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

    // 3. Test POST /api/admin/thresholds with a wrong token
    const postResBadPw = await fetch(`${BASE}/api/admin/thresholds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer bp_${'0'.repeat(12)}_${'0'.repeat(64)}` },
        body: JSON.stringify({ inactiveMemberDays: 50 }),
    });
    assert(postResBadPw.status === 401 && getThresholds().inactiveMemberDays !== 50, `POST /api/admin/thresholds with a wrong token returns 401 (got ${postResBadPw.status})`);

    // 4. Test POST /api/admin/thresholds with an owner's token and valid threshold updates. A circulation rate stored before
    //    S3 is in the file: never read, and gone after the save.
    updateLocalConfig({ thresholds: { ...DEFAULT_THRESHOLDS, circulationRate: 0.02, circulationEpochDays: 20 } as any });
    assert(!('circulationRate' in getThresholds()), 'a circulation rate stored before is never read');
    const postResOk = await fetch(`${BASE}/api/admin/thresholds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...asOwner },
        body: JSON.stringify({ inactiveMemberDays: 80, unknownKey: 999, circulationRate: 0.08 }),
    });
    assert(postResOk.status === 200, `POST /api/admin/thresholds with an owner's token returns 200 (got ${postResOk.status})`);
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
