/**
 * Integration test coverage for apple-return route and helper.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { startHttpsServer } from './https-server.js';
import { appleReturnFragment, APPLE_RETURN_PATH } from './routes/apple-return.js';

const PORT = 8565;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function setOverride(name: string, value: string) {
    db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(`nodeProfile.${name}`, value);
}

async function main() {
    console.log('Running apple-return tests...');

    // 1. Unit tests for appleReturnFragment
    const f1 = appleReturnFragment(new URLSearchParams('state=abc123_456&id_token=header.payload.signature'));
    assert(f1 === 'state=abc123_456&id_token=header.payload.signature', 'appleReturnFragment parses state and id_token');

    const f2 = appleReturnFragment(new URLSearchParams('state=abc123_456&error=user_cancelled_authorize'));
    assert(f2 === 'state=abc123_456&error=user_cancelled_authorize', 'appleReturnFragment parses state and error');

    const f3 = appleReturnFragment(new URLSearchParams('state=abc123_456&error=invalid<script>'));
    assert(f3 === 'state=abc123_456&error=invalid_response', 'appleReturnFragment sanitizes malformed error');

    const f4 = appleReturnFragment(new URLSearchParams('state=abc123_456&id_token=invalid_token'));
    assert(f4 === 'state=abc123_456&error=invalid_response', 'appleReturnFragment sanitizes malformed id_token');

    const f5 = appleReturnFragment(new URLSearchParams('state=invalid state space&id_token=header.payload.sig'));
    assert(f5 === 'id_token=header.payload.sig', 'appleReturnFragment drops invalid state');

    // 2. HTTP Integration tests
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // Test POST when openJoin is false (default for local profile)
    const resOff = await fetch(`${BASE}${APPLE_RETURN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'state=teststate&id_token=a.b.c'
    });
    assert(resOff.status === 404, 'POST /app/auth/apple returns 404 when openJoin is disabled');

    // Enable openJoin
    setOverride('openJoin', 'true');

    // Test POST with non-form content-type
    const res415 = await fetch(`${BASE}${APPLE_RETURN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'teststate' })
    });
    assert(res415.status === 415, 'POST /app/auth/apple with non-form content-type returns 415');

    // Test POST with Content-Length > 16KB header check
    const largeBody = 'state=teststate&id_token=' + 'a'.repeat(17 * 1024);
    const res413Header = await fetch(`${BASE}${APPLE_RETURN_PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(Buffer.byteLength(largeBody))
        },
        body: largeBody
    });
    assert(res413Header.status === 413, 'POST /app/auth/apple with Content-Length header > 16KB returns 413');

    // Test POST with streamed body > 16KB triggering readForm ReturnTooLargeError
    const largeChunk = new Uint8Array(17 * 1024);
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(largeChunk);
            controller.close();
        }
    });
    const res413Body = await fetch(`${BASE}${APPLE_RETURN_PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: stream,
        duplex: 'half'
    } as RequestInit);
    assert(res413Body.status === 413, 'POST /app/auth/apple with streamed body > 16KB returns 413');

    // Test successful POST redirect with state & id_token
    const validBody = 'state=validState123&id_token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.sig123';
    const resSuccess = await fetch(`${BASE}${APPLE_RETURN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: validBody,
        redirect: 'manual'
    });
    assert(resSuccess.status === 303, 'POST /app/auth/apple returns 303 See Other');
    const location = resSuccess.headers.get('location');
    assert(
        location === `${APPLE_RETURN_PATH}#state=validState123&id_token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.sig123`,
        'Location header contains expected return fragment'
    );
    assert(resSuccess.headers.get('cache-control') === 'no-store', 'Response sets Cache-Control: no-store');
    assert(resSuccess.headers.get('referrer-policy') === 'no-referrer', 'Response sets Referrer-Policy: no-referrer');

    // Test successful POST redirect with error
    const errorBody = 'state=validState123&error=user_cancelled_authorize';
    const resError = await fetch(`${BASE}${APPLE_RETURN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: errorBody,
        redirect: 'manual'
    });
    assert(resError.status === 303, 'POST /app/auth/apple with error returns 303');
    const errorLocation = resError.headers.get('location');
    assert(
        errorLocation === `${APPLE_RETURN_PATH}#state=validState123&error=user_cancelled_authorize`,
        'Location header carries error fragment'
    );

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ apple-return checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
