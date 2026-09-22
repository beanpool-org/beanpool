/**
 * Integration test for POST /api/local/admin/unlock/cancel (apps/server/src/routes/owner-unlock.ts).
 *
 * Checks:
 * 1. Unauthenticated /api/local/admin/unlock/cancel returns 401.
 * 2. canceling a restore unlock session deletes its temporary file from disk and removes the session.
 * 3. following or describing a cancelled session returns 'gone' / 404 unknown-session.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-unlock-cancel.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdminPassword123!';

import fs from 'node:fs';
import path from 'node:path';
import type { SealedEnvelopeHeader } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { startRestoreUnlock, followUnlock, describeUnlock } from './services/owner-unlock.js';

const PORT = 8692;
const BASE = `https://localhost:${PORT}`;
const CANCEL_PATH = '/api/local/admin/unlock/cancel';
const ADMIN_PW = 'TestAdminPassword123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

async function postJson(p: string, headers: Record<string, string>, body: unknown) {
    const res = await fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    let json: Record<string, unknown> | null = null;
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* not json */ }
    return { status: res.status, body: json };
}

async function main() {
    console.log('Running unlock cancel integration test...\n');

    initAdminPassword();
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const dataDir = process.env.BEANPOOL_DATA_DIR!;

    // 1. Unauthenticated request to /api/local/admin/unlock/cancel is rejected with 401
    {
        const unauth = await postJson(CANCEL_PATH, {}, { sessionId: 'nonexistent-session-id' });
        assert(unauth.status === 401, `unauthenticated cancel returns 401 (got ${unauth.status})`);
    }

    // 2. Start a restore unlock session with a temporary file
    const tempFile = path.join(dataDir, 'restore-test-file.bpsealed');
    fs.writeFileSync(tempFile, 'dummy-sealed-backup-content');
    assert(fs.existsSync(tempFile), 'temporary restore file created on disk');

    const dummyHeader: SealedEnvelopeHeader = {
        v: 'bpseal/v1',
        kind: 'backup',
        envelopeId: '0123456789abcdef0123456789abcdef',
        communityId: 'testcomm12345678',
        nodePeerId: 'testnode12345678',
        createdAt: new Date().toISOString(),
        recipients: [{
            type: 'owner',
            pubkey: '00'.repeat(32),
            callsign: 'alice',
            eph: '00'.repeat(32),
            nonce: '00'.repeat(24),
            wrappedDek: '00'.repeat(48),
        }],
        chunkSize: 1048576,
        sig: '00'.repeat(64),
    };

    const sessionInfo = startRestoreUnlock({
        serverUrl: BASE,
        file: tempFile,
        header: dummyHeader,
        describe: { backupType: 'full' },
        databaseOnly: false,
        finish: async () => ({ ok: true, status: 200, body: { success: true } }),
    });

    const sessionId = sessionInfo.sessionId;
    assert(typeof sessionId === 'string' && sessionId.length > 0, `session started with sessionId: ${sessionId.slice(0, 8)}...`);

    // Verify session is active before cancellation
    const followBefore = followUnlock(sessionId, 'restore');
    assert(followBefore.state === 'waiting', `session follow state before cancel is waiting (got ${followBefore.state})`);

    const descBefore = await describeUnlock(sessionId);
    assert(descBefore.status === 200, `describeUnlock returns 200 before cancel (got ${descBefore.status})`);

    // 3. Authenticated POST to cancel session
    const cancelRes = await postJson(CANCEL_PATH, { 'x-admin-password': ADMIN_PW }, { sessionId });
    assert(cancelRes.status === 200 && cancelRes.body?.success === true, `authenticated cancel returns 200 success (got ${cancelRes.status})`);

    // 4. Verify temporary restore file was deleted from disk
    assert(!fs.existsSync(tempFile), 'temporary restore file was removed from disk upon session cancellation');

    // 5. Verify session is no longer active in memory
    const followAfter = followUnlock(sessionId, 'restore');
    assert(followAfter.state === 'gone', `session follow state after cancel is gone (got ${followAfter.state})`);

    const descAfter = await describeUnlock(sessionId);
    assert(descAfter.status === 404, `describeUnlock returns 404 unknown-session after cancel (got ${descAfter.status})`);

    // 6. Canceling an unknown / already cancelled session with valid admin auth succeeds safely
    const cancelAgain = await postJson(CANCEL_PATH, { 'x-admin-password': ADMIN_PW }, { sessionId });
    assert(cancelAgain.status === 200 && cancelAgain.body?.success === true, `canceling an unknown sessionId returns 200 success (got ${cancelAgain.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
