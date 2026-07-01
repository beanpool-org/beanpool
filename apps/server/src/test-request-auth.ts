/**
 * X-1 request-auth tests — exercises the REAL requireSignature middleware by
 * starting the HTTPS server and making signed requests against it.
 *
 * Run with a throwaway data dir (self-signed TLS, so we relax cert checking):
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-request-auth.ts
 *
 * Covers:
 *   1. New replay-proof scheme (method+path+ts+nonce+body) is accepted
 *   2. Replaying the same nonce is rejected
 *   3. A stale timestamp is rejected
 *   4. The same signature replayed to a DIFFERENT path is rejected (path binding)
 *   5. Missing headers / tampered body are rejected
 *   6. Legacy body-only signature is still accepted (dual-accept transition)
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // force self-signed / LAN mode

import crypto from 'node:crypto';
import { initTls } from './tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8544;
const BASE = `https://localhost:${PORT}`;
const ENDPOINT = '/api/messages/mark-read';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); }
    else console.error(`✗ ${msg}`);
}

// Ed25519 keypair; pubKeyHex is the raw 32-byte key the server reconstructs into SPKI.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

function sign(message: string): string {
    return crypto.sign(null, Buffer.from(message), privateKey).toString('base64');
}

interface Opts { ts?: number; nonce?: string; legacy?: boolean; tamperBody?: boolean; signPath?: string; omitSig?: boolean; }

async function signedFetch(path: string, body: any, opts: Opts = {}): Promise<{ status: number; error?: string }> {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (!opts.omitSig) {
        if (opts.legacy) {
            headers['X-Public-Key'] = pubKeyHex;
            headers['X-Signature'] = sign(bodyString);
        } else {
            const ts = opts.ts ?? Date.now();
            const nonce = opts.nonce ?? crypto.randomBytes(16).toString('hex');
            const signedBody = opts.tamperBody ? JSON.stringify({ ...body, tampered: true }) : bodyString;
            const canonical = `POST\n${opts.signPath ?? path}\n${ts}\n${nonce}\n${signedBody}`;
            headers['X-Public-Key'] = pubKeyHex;
            headers['X-Signature'] = sign(canonical);
            headers['X-Timestamp'] = String(ts);
            headers['X-Nonce'] = nonce;
        }
    }

    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: bodyString });
    let error: string | undefined;
    try { error = (await res.json())?.error; } catch { /* no json */ }
    return { status: res.status, error };
}

async function main() {
    console.log('Running X-1 request-auth tests (real middleware)...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const body = { pubkey: pubKeyHex, conversationId: 'test-conv' };

    // 1. Valid replay-proof request → middleware passes (route returns 200).
    const fresh = crypto.randomBytes(16).toString('hex');
    const r1 = await signedFetch(ENDPOINT, body, { nonce: fresh });
    assert(r1.status === 200, `valid replay-proof request accepted (got ${r1.status} ${r1.error ?? ''})`);

    // 2. Replaying the same nonce → rejected.
    const r2 = await signedFetch(ENDPOINT, body, { nonce: fresh });
    assert(r2.status === 403 && /replay/i.test(r2.error ?? ''), `replayed nonce rejected (got ${r2.status} ${r2.error ?? ''})`);

    // 3. Stale timestamp → rejected.
    const r3 = await signedFetch(ENDPOINT, body, { ts: Date.now() - 10 * 60 * 1000 });
    assert(r3.status === 401 && /stale|invalid/i.test(r3.error ?? ''), `stale timestamp rejected (got ${r3.status} ${r3.error ?? ''})`);

    // 4. Signature minted for a different path → rejected (path binding).
    const r4 = await signedFetch(ENDPOINT, body, { signPath: '/api/ledger/transfer' });
    assert(r4.status === 403, `cross-path replay rejected (got ${r4.status} ${r4.error ?? ''})`);

    // 5a. Missing signature headers → 401.
    const r5 = await signedFetch(ENDPOINT, body, { omitSig: true });
    assert(r5.status === 401 && /missing/i.test(r5.error ?? ''), `missing signature rejected (got ${r5.status} ${r5.error ?? ''})`);

    // 5b. Body tampered after signing → 403.
    const r6 = await signedFetch(ENDPOINT, body, { tamperBody: true });
    assert(r6.status === 403 && /invalid/i.test(r6.error ?? ''), `tampered body rejected (got ${r6.status} ${r6.error ?? ''})`);

    // 6. Legacy body-only signature still accepted (dual-accept).
    const r7 = await signedFetch(ENDPOINT, body, { legacy: true });
    assert(r7.status === 200, `legacy body-only signature accepted (got ${r7.status} ${r7.error ?? ''})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ ALL X-1 REQUEST-AUTH CHECKS PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
