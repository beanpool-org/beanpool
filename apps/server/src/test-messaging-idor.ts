/**
 * Messaging authorization tests (audit findings A2-2, A2-3, A2-15) against the
 * REAL server with ENFORCE_READ_AUTH ON.
 *
 *   A2-2  GET /api/messages/:conversationId — only a participant may read it.
 *   A2-3  GET /api/messages/conversations/:publicKey — only the subject may read it.
 *   A2-15 POST /api/messages/conversation — the creator must be a participant.
 *
 * MUST run with ENFORCE_READ_AUTH=true (the gate is a module const read at import):
 *   ENFORCE_READ_AUTH=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-messaging-idor.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './tls.js';
import { initStateEngine, createConversation } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8546;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeIdentity(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let err: string | undefined; try { err = (await res.json())?.error; } catch { /* */ }
    return { status: res.status, error: err };
}

async function main() {
    console.log('Running messaging IDOR tests (A2-2/A2-3/A2-15, ENFORCE_READ_AUTH on)...\n');
    if (process.env.ENFORCE_READ_AUTH !== 'true') throw new Error('Run with ENFORCE_READ_AUTH=true');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const A = makeIdentity('Alice');
    const B = makeIdentity('Bob');
    const C = makeIdentity('Carol');

    // A DM between A and B (C is an outsider).
    const conv = createConversation('dm', [A.pubKeyHex, B.pubKeyHex], A.pubKeyHex);
    if (!conv) throw new Error('setup: failed to create DM');

    // A2-2 — participant reads the thread (200); outsider is rejected (403).
    const a2 = await signedFetch('GET', `/api/messages/${conv.id}`, A);
    assert(a2.status === 200, `A2-2: participant A reads the conversation (got ${a2.status} ${a2.error ?? ''})`);
    const a2c = await signedFetch('GET', `/api/messages/${conv.id}`, C);
    assert(a2c.status === 403, `A2-2: outsider C is DENIED the conversation (got ${a2c.status} ${a2c.error ?? ''})`);

    // A2-3 — subject reads own conversation list (200); other member is denied (403).
    const a3 = await signedFetch('GET', `/api/messages/conversations/${A.pubKeyHex}`, A);
    assert(a3.status === 200, `A2-3: A reads A's own conversation list (got ${a3.status} ${a3.error ?? ''})`);
    const a3c = await signedFetch('GET', `/api/messages/conversations/${A.pubKeyHex}`, C);
    assert(a3c.status === 403, `A2-3: C is DENIED A's conversation graph (got ${a3c.status} ${a3c.error ?? ''})`);

    // A2-15 — creating a conversation the signer is NOT part of is rejected.
    const a15bad = await signedFetch('POST', '/api/messages/conversation', C,
        { type: 'group', createdBy: C.pubKeyHex, participants: [A.pubKeyHex, B.pubKeyHex], name: 'scam' });
    assert(a15bad.status === 403, `A2-15: creator-not-a-participant is DENIED (got ${a15bad.status} ${a15bad.error ?? ''})`);
    const a15ok = await signedFetch('POST', '/api/messages/conversation', C,
        { type: 'group', createdBy: C.pubKeyHex, participants: [C.pubKeyHex, A.pubKeyHex], name: 'legit' });
    assert(a15ok.status === 200, `A2-15: creator-included is allowed (got ${a15ok.status} ${a15ok.error ?? ''})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Messaging IDOR checks PASSED (A2-2/A2-3/A2-15).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
