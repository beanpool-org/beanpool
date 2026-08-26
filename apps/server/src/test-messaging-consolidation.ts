/**
 * Regression tests for consolidated/legacy conversation-id resolution in sendMessage
 * (PR #436 follow-up fixes).
 *
 *   1. A send addressed to a LEGACY conversation id is remapped to the active DM, and the
 *      original id is preserved in metadata.originalConversationId — without it, the DM
 *      ciphertext (XChaCha20-Poly1305 with conversationId as AEAD associated data, see
 *      the native and pwa e2e-crypto modules) is undecryptable by the recipient and the client fallback,
 *      which keys on metadata.originalConversationId, never fires.
 *   2. Client-supplied metadata is preserved (merged), not clobbered, by that rewrite.
 *   3. A single row with malformed metadata must NOT abort the resolution query
 *      (json_valid() CASE guard), which would otherwise silently disable consolidation
 *      node-wide.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-messaging-consolidation.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createConversation, sendMessage } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8547;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeIdentity(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return pubKeyHex;
}

function seedConsolidatedMarker(activeConvId: string, author: string, legacyId: string): void {
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), activeConvId, author, 'seed-ct', 'seed-nc', 'text',
             JSON.stringify({ originalConversationId: legacyId }), new Date().toISOString());
}

async function main() {
    console.log('Running consolidation-resolution regression tests (PR #436)...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const A = makeIdentity('Alice');
    const B = makeIdentity('Bob');
    const conv = createConversation('dm', [A, B], A);
    if (!conv) throw new Error('setup: failed to create DM');
    const Y = conv.id;

    // 1 + 2. Legacy send resolves to Y, preserving the original id and any client metadata.
    const LEGACY = 'legacy-' + crypto.randomUUID();
    seedConsolidatedMarker(Y, A, LEGACY);
    const msg = sendMessage(LEGACY, A, 'CIPHER', 'NONCE', 'text', undefined, JSON.stringify({ foo: 'bar' }));
    assert(!!msg, 'send addressed to a legacy id resolves and returns a message');
    assert(!!msg && msg.conversationId === Y, `message stored under the active conv Y (got ${msg?.conversationId})`);
    const stored = db.prepare('SELECT metadata FROM messages WHERE id=?').get(msg!.id) as any;
    const meta = stored?.metadata ? JSON.parse(stored.metadata) : {};
    assert(meta.originalConversationId === LEGACY, `originalConversationId preserved for E2EE fallback (got ${meta.originalConversationId})`);
    assert(meta.foo === 'bar', 'existing client metadata is preserved, not clobbered');

    // 3. A malformed-metadata row must not break resolution of an unknown id.
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), Y, A, 'ct', 'nc', 'text', '{not valid json', new Date().toISOString());
    let threw = false;
    let res: ReturnType<typeof sendMessage> = null;
    try { res = sendMessage('unknown-' + crypto.randomUUID(), A, 'C', 'N', 'text', undefined, undefined); }
    catch { threw = true; }
    assert(!threw, 'send to an unknown id does not throw despite a malformed-metadata row');
    assert(res === null, 'send to a genuinely unknown conversation returns null');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Consolidation-resolution regression checks PASSED.');
    process.exit(0);
}

main().catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
