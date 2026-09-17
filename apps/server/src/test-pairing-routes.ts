/**
 * Integration test suite for ephemeral QR device pairing HTTP routes (#89):
 *   POST /api/pair/init
 *   GET  /api/pair/poll
 *   POST /api/pair/transfer
 *   POST /api/pair/cancel
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-pairing-routes.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { createPairingSession, encryptPairingPayload } from '@beanpool/core';

const PORT = 8553;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function main() {
    console.log('🧪 Starting Pairing Routes Integration Test Suite...\n');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // ── 1. POST /api/pair/init Validation & Success ─────────────────────────────
    const badInitRes = await fetch(`${BASE}/api/pair/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    assert(badInitRes.status === 400, 'POST /api/pair/init rejects missing body parameters with 400');
    const badInitBody = (await badInitRes.json()) as any;
    assert(badInitBody.error === 'Missing sessionId or desktopPubHex', 'POST /api/pair/init returns expected error message');

    const session = createPairingSession();
    const goodInitRes = await fetch(`${BASE}/api/pair/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sessionId: session.sessionId,
            desktopPubHex: session.publicKeyHex,
        }),
    });
    assert(goodInitRes.status === 200, 'POST /api/pair/init returns 200 on valid input');
    const goodInitBody = (await goodInitRes.json()) as any;
    assert(goodInitBody.success === true, 'POST /api/pair/init returns success: true');
    assert(typeof goodInitBody.expiresAt === 'number', 'POST /api/pair/init returns numeric expiresAt timestamp');

    // ── 2. GET /api/pair/poll Validation & Waiting State ───────────────────────
    const noPollRes = await fetch(`${BASE}/api/pair/poll`);
    assert(noPollRes.status === 400, 'GET /api/pair/poll returns 400 when session query parameter is missing');

    const invalidPollRes = await fetch(`${BASE}/api/pair/poll?session=invalid-session-id!`);
    assert(invalidPollRes.status === 400, 'GET /api/pair/poll returns 400 when session query parameter is invalid format');

    const pollWaitingRes = await fetch(`${BASE}/api/pair/poll?session=${session.sessionId}`);
    assert(pollWaitingRes.status === 200, 'GET /api/pair/poll returns 200 for active waiting session');
    const pollWaitingBody = (await pollWaitingRes.json()) as any;
    assert(pollWaitingBody.status === 'waiting', 'GET /api/pair/poll returns status "waiting"');
    assert(pollWaitingBody.desktopPubHex === session.publicKeyHex, 'GET /api/pair/poll returns desktopPubHex');

    // ── 3. POST /api/pair/transfer Validation & Success ─────────────────────────
    const badTransferRes = await fetch(`${BASE}/api/pair/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId }),
    });
    assert(badTransferRes.status === 400, 'POST /api/pair/transfer returns 400 when required fields are missing');

    const samplePayload = {
        callsign: 'TestUser',
        publicKey: '11'.repeat(32),
        privateKey: '22'.repeat(32),
        mnemonic: ['climb', 'ridge', 'forest', 'creek', 'solar', 'harvest', 'garden', 'timber', 'breeze', 'summit', 'valley', 'meadow'],
        createdAt: new Date().toISOString(),
    };
    const encrypted = encryptPairingPayload(samplePayload, session.publicKeyHex, session.sessionId);

    const goodTransferRes = await fetch(`${BASE}/api/pair/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sessionId: session.sessionId,
            mobilePubHex: encrypted.mobilePubHex,
            nonceHex: encrypted.nonceHex,
            ciphertextHex: encrypted.ciphertextHex,
        }),
    });
    assert(goodTransferRes.status === 200, 'POST /api/pair/transfer returns 200 on valid transfer');
    const goodTransferBody = (await goodTransferRes.json()) as any;
    assert(goodTransferBody.success === true, 'POST /api/pair/transfer returns success: true');

    // Verify polling now receives transferred status and payload
    const pollTransferredRes = await fetch(`${BASE}/api/pair/poll?session=${session.sessionId}`);
    assert(pollTransferredRes.status === 200, 'GET /api/pair/poll returns 200 after transfer');
    const pollTransferredBody = (await pollTransferredRes.json()) as any;
    assert(pollTransferredBody.status === 'transferred', 'GET /api/pair/poll status updated to "transferred"');
    assert(pollTransferredBody.payload?.ciphertextHex === encrypted.ciphertextHex, 'GET /api/pair/poll returns transferred ciphertext');

    // ── 4. POST /api/pair/cancel Validation & Success ───────────────────────────
    const badCancelRes = await fetch(`${BASE}/api/pair/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    assert(badCancelRes.status === 400, 'POST /api/pair/cancel returns 400 on missing sessionId');

    const goodCancelRes = await fetch(`${BASE}/api/pair/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId }),
    });
    assert(goodCancelRes.status === 200, 'POST /api/pair/cancel returns 200 on valid session cancellation');

    const pollExpiredRes = await fetch(`${BASE}/api/pair/poll?session=${session.sessionId}`);
    const pollExpiredBody = (await pollExpiredRes.json()) as any;
    assert(pollExpiredBody.status === 'expired', 'GET /api/pair/poll returns status "expired" after cancellation');

    console.log(`\nPairing Routes Test Summary: ${passed}/${run} assertions passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ Pairing routes integration checks PASSED.');
}

main().then(() => process.exit(0)).catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
