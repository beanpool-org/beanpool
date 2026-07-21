/**
 * Info-disclosure / DoS hardening tests (A2-13, A2-22, A2-24).
 *
 *   A2-13 the signature-validation error is GENERIC (no leaked body field name).
 *   A2-22 ?limit is clamped (limit=-1 / huge no longer dumps the whole table).
 *   A2-24 the DNS-shim source-address guard accepts LAN/loopback, rejects public.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-hardening.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { __test_isPrivateSource } from './dns-shim.js';

const PORT = 8549;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running info-disclosure / DoS hardening tests (A2-13/A2-22/A2-24)...\n');

    // A2-24 — DNS source-address policy (pure function).
    assert(__test_isPrivateSource('192.168.1.5') === true, 'A2-24: 192.168/16 accepted');
    assert(__test_isPrivateSource('10.0.0.9') === true, 'A2-24: 10/8 accepted');
    assert(__test_isPrivateSource('172.20.1.1') === true, 'A2-24: 172.16/12 accepted');
    assert(__test_isPrivateSource('127.0.0.1') === true, 'A2-24: loopback accepted');
    assert(__test_isPrivateSource('8.8.8.8') === false, 'A2-24: public source REJECTED (no open forwarder)');
    assert(__test_isPrivateSource('172.32.0.1') === false, 'A2-24: 172.32 (outside 16-31) rejected');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // A2-13 — a signed request with a mismatched identity field gets a GENERIC error.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const path = '/api/ledger/transfer';
    const body = JSON.stringify({ from: 'someoneElsePubkeyNotMe', to: 'x', amount: 1 });
    const ts = Date.now(), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${body}`), privateKey).toString('base64');
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Public-Key': pubHex, 'X-Signature': sig, 'X-Timestamp': String(ts), 'X-Nonce': nonce },
        body,
    });
    const err = (await res.json())?.error ?? '';
    assert(res.status === 403, `A2-13: identity-mismatch request rejected (got ${res.status})`);
    assert(err === 'Signature validation failed', `A2-13: error is generic, no field name leaked (got "${err}")`);
    assert(!/from|body field/i.test(err), 'A2-13: response does not name the identity field');

    // A2-22 — seed >200 transactions, then ?limit=-1 must NOT return them all.
    const ins = db.prepare(`INSERT OR IGNORE INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?,?,?,?,?,?)`);
    db.transaction(() => { for (let i = 0; i < 250; i++) ins.run('tx' + i, 'A', 'B', 1, 'm', new Date(Date.now() - i * 1000).toISOString()); })();
    const r = await fetch(`${BASE}/api/ledger/transactions?limit=-1`);
    const rows = await r.json();
    assert(Array.isArray(rows) && rows.length <= 200, `A2-22: ?limit=-1 is clamped to ≤200 (got ${Array.isArray(rows) ? rows.length : 'non-array'})`);
    const r2 = await fetch(`${BASE}/api/ledger/transactions?limit=999999`);
    const rows2 = await r2.json();
    assert(Array.isArray(rows2) && rows2.length <= 200, `A2-22: huge ?limit is clamped to ≤200 (got ${Array.isArray(rows2) ? rows2.length : 'non-array'})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Hardening checks PASSED (A2-13/A2-22/A2-24).');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
