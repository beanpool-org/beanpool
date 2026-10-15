/**
 * Integration test suite for ephemeral QR device pairing HTTP routes (#89):
 *   POST /api/pair/init
 *   GET  /api/pair/poll
 *   POST /api/pair/transfer
 *   POST /api/pair/cancel
 *   POST /api/pair/confirm (number matching, fable-security-signin finding 1: the phone's payload waits for its two
 *   digits, typed by the browser that opened the session, which holds the binding cookie)
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

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';

let run = 0, passed = 0;
/** The binding cookie init sets, as the browser sends it back. */
const cookieOf = (res: Response) => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith('bp_pair_')) || '';
const poll = (id: string, cookie: string) => fetch(`${BASE}/api/pair/poll?session=${id}`, { headers: cookie ? { cookie } : {} });
const confirmDigits = (id: string, code: unknown, cookie: string) => fetch(`${BASE}/api/pair/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ sessionId: id, code }),
});
const otherDigits = (code: string) => String((Number(code) + 1) % 100).padStart(2, '0');

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
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

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
    const cookie = cookieOf(goodInitRes);
    const setCookie = (goodInitRes.headers.getSetCookie?.() || []).join(' | ').toLowerCase();
    assert(!!cookie && setCookie.includes('httponly') && setCookie.includes('samesite=strict') && setCookie.includes('path=/api/pair'),
        'POST /api/pair/init sets the binding cookie: httpOnly, SameSite=Strict, /api/pair only');
    assert(!JSON.stringify(goodInitBody).includes(cookie.split('=')[1] || '-'), 'and its secret is not in the answer body');

    // ── 2. GET /api/pair/poll Validation & Waiting State ───────────────────────
    const noPollRes = await fetch(`${BASE}/api/pair/poll`);
    assert(noPollRes.status === 400, 'GET /api/pair/poll returns 400 when session query parameter is missing');

    const invalidPollRes = await fetch(`${BASE}/api/pair/poll?session=invalid-session-id!`);
    assert(invalidPollRes.status === 400, 'GET /api/pair/poll returns 400 when session query parameter is invalid format');

    const pollWaitingRes = await poll(session.sessionId, cookie);
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
    const digits = String(goodTransferBody.confirmCode || '');
    assert(/^\d{2}$/.test(digits), `POST /api/pair/transfer answers the phone two digits to show (${digits})`);

    // Number matching: nothing leaves the relay until the opening browser types the digits.
    const heldRes = await poll(session.sessionId, cookie);
    const heldBody = (await heldRes.json()) as any;
    assert(heldRes.status === 200 && heldBody.status === 'confirming' && !heldBody.payload,
        'GET /api/pair/poll answers "confirming" and no payload until the right digits are typed');
    const strangerRes = await poll(session.sessionId, '');
    const strangerBody = (await strangerRes.json()) as any;
    assert(strangerRes.status === 403 && strangerBody.status === 'wrong-browser' && !strangerBody.payload,
        'a poll from a browser without the init cookie gets 403 wrong-browser and nothing');
    const strangerConfirm = await confirmDigits(session.sessionId, digits, '');
    assert(strangerConfirm.status === 403 && ((await poll(session.sessionId, cookie)).status === 200),
        'the right digits from a browser without the cookie are refused (403) and release nothing');
    const wrongRes = await confirmDigits(session.sessionId, otherDigits(digits), cookie);
    const wrongBody = (await wrongRes.json()) as any;
    assert(wrongRes.status === 400 && wrongBody.result === 'wrong' && wrongBody.triesLeft === 2, 'wrong digits: 400, two tries left');
    assert(((await (await poll(session.sessionId, cookie)).json()) as any).status === 'confirming', 'and still no payload');
    const rightRes = await confirmDigits(session.sessionId, digits, cookie);
    assert(rightRes.status === 200 && ((await rightRes.json()) as any).result === 'released', 'POST /api/pair/confirm with the right digits and the cookie releases it');

    // Verify polling now receives transferred status and payload
    const pollTransferredRes = await poll(session.sessionId, cookie);
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

    const pollExpiredRes = await poll(session.sessionId, cookie);
    const pollExpiredBody = (await pollExpiredRes.json()) as any;
    assert(pollExpiredBody.status === 'expired', 'GET /api/pair/poll returns status "expired" after cancellation');

    // Three wrong digits burn the session: the payload is dropped, the right digits then give nothing.
    {
        const s2 = createPairingSession();
        const init2 = await fetch(`${BASE}/api/pair/init`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: s2.sessionId, desktopPubHex: s2.publicKeyHex }),
        });
        const c2 = cookieOf(init2);
        const e2 = encryptPairingPayload(samplePayload, s2.publicKeyHex, s2.sessionId);
        const t2 = (await (await fetch(`${BASE}/api/pair/transfer`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: s2.sessionId, mobilePubHex: e2.mobilePubHex, nonceHex: e2.nonceHex, ciphertextHex: e2.ciphertextHex }),
        })).json()) as any;
        const statuses: number[] = [];
        for (let i = 0; i < 3; i++) statuses.push((await confirmDigits(s2.sessionId, otherDigits(t2.confirmCode), c2)).status);
        const late = await confirmDigits(s2.sessionId, t2.confirmCode, c2);
        const after = (await (await poll(s2.sessionId, c2)).json()) as any;
        assert(statuses.join() === '400,400,410' && late.status === 410 && after.status === 'burned' && !after.payload,
            `three wrong digits burn the session; the right digits then give nothing and no poll gets the payload (${statuses.join()}, then ${late.status}, poll "${after.status}")`);
    }

    // ── 5. A real pairing's time (#1950): a held session lives at most its 120 s ─────────────────
    // The computer polls every 1.5 s (apps/pwa WelcomePage); the phone sends its payload once it is scanned. Timed from
    // the computer's init to the poll that brings the payload, over the real server.
    const realStart = Date.now();
    const real = createPairingSession();
    const realInit = await fetch(`${BASE}/api/pair/init`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: real.sessionId, desktopPubHex: real.publicKeyHex }),
    });
    const realCookie = cookieOf(realInit);
    let collectedAt = 0;
    let polls = 0;
    const poller = setInterval(async () => {
        if (collectedAt) return;
        polls++;
        const r = (await (await poll(real.sessionId, realCookie)).json()) as any;
        if (r.status === 'transferred' && r.payload && !collectedAt) collectedAt = Date.now();
    }, 1500);
    await new Promise((r) => setTimeout(r, 2_000)); // the phone scans the code
    const realPayload = encryptPairingPayload(samplePayload, real.publicKeyHex, real.sessionId);
    const transferStart = Date.now();
    const realTransfer = await fetch(`${BASE}/api/pair/transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: real.sessionId, mobilePubHex: realPayload.mobilePubHex, nonceHex: realPayload.nonceHex, ciphertextHex: realPayload.ciphertextHex }),
    });
    const transferMs = Date.now() - transferStart;
    // The member reads the two digits off the phone and types them on the computer.
    await confirmDigits(real.sessionId, ((await realTransfer.json()) as any).confirmCode, realCookie);
    for (let i = 0; i < 100 && !collectedAt; i++) await new Promise((r) => setTimeout(r, 50));
    clearInterval(poller);
    const toCollectMs = collectedAt - transferStart;
    const wholeMs = collectedAt - realStart;
    assert(realInit.status === 200 && realTransfer.status === 200 && collectedAt > 0 && toCollectMs < 5_000 && wholeMs < 120_000,
        `a real pairing: transfer answered in ${transferMs} ms, the computer had the payload ${toCollectMs} ms after the phone sent it (${polls} polls), ${wholeMs} ms from init; well inside the 120 s`);

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
