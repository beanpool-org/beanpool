/**
 * Integration Test for Fleet Manager Backup Routes (`routes/manager-backups.ts`).
 *
 * Verifies:
 * 1. GET /api/manager/backups/status enforces admin auth & returns node/harvest status payload.
 * 2. GET /api/manager/backups/download-db returns 400 when missing nodeId, 404 when backup DB missing.
 * 3. GET /api/manager/backups/history returns 400 when missing nodeId, history array when missing history dir.
 * 4. GET /api/manager/backups/download-history returns 400 for path-traversal or missing parameters.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-manager-backups.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestManagerAdmin123!';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';

const PORT = 8563;
const BASE = `https://localhost:${PORT}`;
const ADMIN_PW = 'TestManagerAdmin123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main(): Promise<void> {
    console.log('Running Fleet Manager Backups integration tests...\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // 1. GET /api/manager/backups/status
    // Unauthenticated request -> 401
    const unauthStatus = await fetch(`${BASE}/api/manager/backups/status`);
    assert(unauthStatus.status === 401, `GET /api/manager/backups/status requires admin auth (got ${unauthStatus.status})`);

    // Authenticated request -> 200 with payload
    const authStatus = await fetch(`${BASE}/api/manager/backups/status`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(authStatus.status === 200, `GET /api/manager/backups/status with admin auth succeeds (got ${authStatus.status})`);
    const statusBody = await authStatus.json();
    assert(Array.isArray(statusBody.nodes), 'Status response contains nodes array');
    assert(typeof statusBody.harvestState === 'object' && statusBody.harvestState !== null, 'Status response contains harvestState object');

    // 2. GET /api/manager/backups/download-db
    const downloadDbNoNode = await fetch(`${BASE}/api/manager/backups/download-db`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadDbNoNode.status === 400, `download-db requires nodeId parameter (got ${downloadDbNoNode.status})`);

    const downloadDbNotFound = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=nonexistent-node`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadDbNotFound.status === 404, `download-db returns 404 for missing backup DB (got ${downloadDbNotFound.status})`);

    // 3. GET /api/manager/backups/history
    const historyNoNode = await fetch(`${BASE}/api/manager/backups/history`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(historyNoNode.status === 400, `history requires nodeId parameter (got ${historyNoNode.status})`);

    const historyNotFound = await fetch(`${BASE}/api/manager/backups/history?nodeId=nonexistent-node`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(historyNotFound.status === 200, `history returns 200 empty history array when dir absent (got ${historyNotFound.status})`);
    const historyBody = await historyNotFound.json();
    assert(Array.isArray(historyBody.history) && historyBody.history.length === 0, 'History response is an empty array');

    // 4. GET /api/manager/backups/download-history
    const downloadHistoryNoParams = await fetch(`${BASE}/api/manager/backups/download-history`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadHistoryNoParams.status === 400, `download-history returns 400 when missing parameters (got ${downloadHistoryNoParams.status})`);

    const downloadHistoryTraversal = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=node1&filename=../secret.txt`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadHistoryTraversal.status === 400, `download-history rejects path-traversal filename (got ${downloadHistoryTraversal.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ Fleet Manager Backups tests PASSED.');
    process.exit(0);
}

main().catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
