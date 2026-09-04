/**
 * Message Attachment API integration tests.
 *
 * Tests lazy-loading E2E encrypted message attachments (images/files):
 *   1. Sending a message with an attachment payload stores the attachment in `message_attachments`.
 *   2. GET /api/messages/:id/attachment fetches the ciphertext, nonce, and mime type.
 *   3. GET /api/messages/:id/attachment defaults mime type to 'image/jpeg' if omitted during creation.
 *   4. GET /api/messages/:id/attachment returns 404 for non-existent attachment IDs.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-message-attachment.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createConversation } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8549;
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
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json, error: json?.error };
}

async function main() {
    console.log('Running message attachment integration tests...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const Alice = makeIdentity('Alice');
    const Bob = makeIdentity('Bob');

    const conv = createConversation('dm', [Alice.pubKeyHex, Bob.pubKeyHex], Alice.pubKeyHex);
    if (!conv) throw new Error('setup: failed to create conversation');

    // 1. Send message with full attachment object (including explicit mime)
    const attachmentData1 = {
        data: Buffer.from('fake-encrypted-image-bytes-1').toString('base64'),
        nonce: 'nonce1234567890',
        mime: 'image/png'
    };

    const sendRes1 = await signedFetch('POST', '/api/messages/send', Alice, {
        conversationId: conv.id,
        authorPubkey: Alice.pubKeyHex,
        ciphertext: 'encrypted-text',
        nonce: 'text-nonce',
        type: 'image',
        attachment: attachmentData1
    });

    assert(sendRes1.status === 200 && sendRes1.json?.success === true, 'Message with attachment sent successfully');
    const msgId1 = sendRes1.json?.message?.id;
    assert(!!msgId1, 'Message ID returned in response');

    // Verify row in DB directly
    const dbRow1 = db.prepare('SELECT * FROM message_attachments WHERE message_id = ?').get(msgId1) as any;
    assert(!!dbRow1 && dbRow1.data === attachmentData1.data && dbRow1.mime === 'image/png', 'Attachment stored in database correctly');

    // 2. GET /api/messages/:id/attachment returns stored attachment (public unauthenticated route)
    const getRes1 = await fetch(`${BASE}/api/messages/${msgId1}/attachment`);
    assert(getRes1.status === 200, 'GET attachment returns 200 OK');
    const getJson1 = await getRes1.json() as any;
    assert(getJson1.data === attachmentData1.data, 'Attachment data matches');
    assert(getJson1.nonce === attachmentData1.nonce, 'Attachment nonce matches');
    assert(getJson1.mime === 'image/png', 'Attachment MIME matches');

    // 3. Send message with attachment lacking explicit MIME (should default to image/jpeg)
    const attachmentData2 = {
        data: Buffer.from('fake-encrypted-image-bytes-2').toString('base64'),
        nonce: 'nonce0987654321'
    };

    const sendRes2 = await signedFetch('POST', '/api/messages/send', Alice, {
        conversationId: conv.id,
        authorPubkey: Alice.pubKeyHex,
        ciphertext: 'encrypted-text-2',
        nonce: 'text-nonce-2',
        type: 'image',
        attachment: attachmentData2
    });

    assert(sendRes2.status === 200 && sendRes2.json?.success === true, 'Second message sent successfully');
    const msgId2 = sendRes2.json?.message?.id;

    const getRes2 = await fetch(`${BASE}/api/messages/${msgId2}/attachment`);
    assert(getRes2.status === 200, 'GET second attachment returns 200 OK');
    const getJson2 = await getRes2.json() as any;
    assert(getJson2.mime === 'image/jpeg', 'Attachment MIME defaults to image/jpeg when unsupplied');

    // 4. GET /api/messages/:id/attachment returns 404 for non-existent attachment
    const nonExistentId = crypto.randomUUID();
    const getRes404 = await fetch(`${BASE}/api/messages/${nonExistentId}/attachment`);
    assert(getRes404.status === 404, 'GET non-existent attachment returns 404 Not Found');
    const getJson404 = await getRes404.json() as any;
    assert(getJson404.error === 'Attachment not found', '404 error message matches');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Message attachment integration tests PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
