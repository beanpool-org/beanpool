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

import fs from 'node:fs';
import path from 'node:path';
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

    const downloadDbTraversal = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=../../secret`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadDbTraversal.status === 400, `download-db rejects path-traversal nodeId (got ${downloadDbTraversal.status})`);

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

    const downloadHistoryBackslash = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=node1&filename=..\\secret.txt`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadHistoryBackslash.status === 400, `download-history rejects backslash traversal filename (got ${downloadHistoryBackslash.status})`);

    const downloadHistoryInvalidPattern = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=node1&filename=arbitrary.txt`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadHistoryInvalidPattern.status === 400, `download-history rejects non-snapshot filename pattern (got ${downloadHistoryInvalidPattern.status})`);

    // 5. GET /api/manager/backups/download-identity
    const downloadIdentityTraversal = await fetch(`${BASE}/api/manager/backups/download-identity?nodeId=../../secret`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadIdentityTraversal.status === 400, `download-identity rejects path-traversal nodeId (got ${downloadIdentityTraversal.status})`);

    // 6. Sealed backups (sealed-keys slice 3): a locked node's .bpsealed files are served as they are. The plain
    //    identity bundle is gone (410), and nothing here is gzip.
    const sealedDir = path.join(process.env.BEANPOOL_DATA_DIR!, 'backups', 'mullum', 'sealed');
    fs.mkdirSync(sealedDir, { recursive: true });
    const fakeSealed = Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from('{}'), Buffer.from('ciphertext')]);
    fs.writeFileSync(path.join(sealedDir, 'beanpool-2026-09-19T01-02-03.bpsealed'), fakeSealed);
    const isGz = (b: Buffer) => b[0] === 0x1f && b[1] === 0x8b;
    const dbRes = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const dbBody = Buffer.from(await dbRes.arrayBuffer());
    assert(dbRes.status === 200 && dbBody.equals(fakeSealed) && /\.bpsealed"/.test(dbRes.headers.get('content-disposition') || ''),
        `download-db serves the newest sealed file as it is (got ${dbRes.status})`);
    const histRes = await fetch(`${BASE}/api/manager/backups/history?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const hist = await histRes.json() as any;
    assert(hist.history?.length === 1 && hist.history[0].filename === 'beanpool-2026-09-19T01-02-03.bpsealed' && hist.history[0].sealed === true,
        'history lists the sealed files');
    const oneRes = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-2026-09-19T01-02-03.bpsealed`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const oneBody = Buffer.from(await oneRes.arrayBuffer());
    assert(oneRes.status === 200 && oneBody.equals(fakeSealed), `download-history serves a sealed file (got ${oneRes.status})`);
    const missing = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-2026-09-10.db`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    assert(missing.status === 404, `download-history: a daily .db copy that is not held is 404 (got ${missing.status})`);
    const badName = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-2026-09-10.tar.gz`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    assert(badName.status === 400, `download-history refuses any other kind of name (got ${badName.status})`);
    const idRes = await fetch(`${BASE}/api/manager/backups/download-identity?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const idBody = Buffer.from(await idRes.arrayBuffer());
    assert(idRes.status === 410 && !isGz(idBody) && /locked backup/.test(idBody.toString()), `download-identity is gone: 410 with the reason (got ${idRes.status})`);

    // 7. A node whose backups are not locked yet (seal review round 1): the harvester keeps the readable state.db and
    //    daily copies as before, and these routes serve them as before, marked not locked. The locked legacy key
    //    file is listed (identity: true) and downloadable.
    const nodeDir = path.join(process.env.BEANPOOL_DATA_DIR!, 'backups', 'mullum');
    fs.mkdirSync(path.join(nodeDir, 'history'), { recursive: true });
    const sqlite = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]);
    fs.writeFileSync(path.join(nodeDir, 'state.db'), sqlite);
    fs.writeFileSync(path.join(nodeDir, 'history', 'beanpool-2026-09-18.db'), sqlite);
    const past = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(path.join(sealedDir, 'beanpool-2026-09-19T01-02-03.bpsealed'), past, past);
    fs.writeFileSync(path.join(sealedDir, 'beanpool-identity-2026-09-01-legacy.bpsealed'), fakeSealed);
    fs.utimesSync(path.join(sealedDir, 'beanpool-identity-2026-09-01-legacy.bpsealed'), past, past);
    const plainRes = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const plainBody = Buffer.from(await plainRes.arrayBuffer());
    assert(plainRes.status === 200 && plainBody.equals(sqlite) && plainRes.headers.get('x-backup-locked') === 'no'
        && /beanpool-backup-mullum\.db"/.test(plainRes.headers.get('content-disposition') || ''),
        `download-db serves the readable state.db when it is newer than any locked file, marked not locked (got ${plainRes.status})`);
    const hist2 = (await (await fetch(`${BASE}/api/manager/backups/history?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } })).json() as any).history;
    const names = hist2.map((h: any) => `${h.filename}:${h.sealed}:${h.identity}`).sort();
    assert(JSON.stringify(names) === JSON.stringify([
        'beanpool-2026-09-18.db:false:false',
        'beanpool-2026-09-19T01-02-03.bpsealed:true:false',
        'beanpool-identity-2026-09-01-legacy.bpsealed:true:true',
    ]), `history lists readable daily copies, locked backups and the locked key file (${names.join(', ')})`);
    const dayRes = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-2026-09-18.db`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    assert(dayRes.status === 200 && Buffer.from(await dayRes.arrayBuffer()).equals(sqlite) && dayRes.headers.get('x-backup-locked') === 'no',
        `download-history serves a readable daily copy, marked not locked (got ${dayRes.status})`);
    const keyRes = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-identity-2026-09-01-legacy.bpsealed`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    assert(keyRes.status === 200 && Buffer.from(await keyRes.arrayBuffer()).equals(fakeSealed), `the locked legacy key file downloads (got ${keyRes.status})`);
    assert(![dbBody, oneBody, idBody, plainBody].some(isGz), 'no manager download starts with gzip magic');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ Fleet Manager Backups tests PASSED.');
    process.exit(0);
}

main().catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
