/**
 * Message Attachment API integration tests.
 *
 * Tests lazy-loading E2E encrypted message attachments (images/files):
 *   1. Sending a message with an attachment payload stores the attachment in `message_attachments`.
 *   2. GET /api/messages/:id/attachment fetches the ciphertext, nonce, and mime type for conversation participants.
 *      Unsigned requests and strangers (including signed non-members and members not in the DM) are refused.
 *   3. Withheld lines' attachments are served only to their sender.
 *   4. GET /api/messages/:id/attachment defaults mime type to 'image/jpeg' if omitted during creation.
 *   5. GET /api/messages/:id/attachment returns 404 for non-existent attachment IDs.
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
import { getImageStore } from './storage/image-store.js';
import { lockedDm } from './dm-test-payload.js';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';
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

function makeStranger() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
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
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const readAuthOn = process.env.ENFORCE_READ_AUTH !== 'false';
    const Alice = makeIdentity('Alice');
    const Bob = makeIdentity('Bob');
    const Carol = makeIdentity('Carol');
    const stranger = makeStranger();

    const conv = createConversation('dm', [Alice.pubKeyHex, Bob.pubKeyHex], Alice.pubKeyHex);
    if (!conv) throw new Error('setup: failed to create conversation');

    // 1. Send message with full attachment object (including explicit mime). A DM photo goes in the encrypted form.
    const photo1 = lockedDm(64);
    const attachmentData1 = {
        data: photo1.ciphertext,
        nonce: photo1.nonce,
        mime: 'image/png'
    };

    const sendRes1 = await signedFetch('POST', '/api/messages/send', Alice, {
        conversationId: conv.id,
        authorPubkey: Alice.pubKeyHex,
        ...lockedDm(),
        type: 'image',
        attachment: attachmentData1
    });

    assert(sendRes1.status === 200 && sendRes1.json?.success === true, 'Message with attachment sent successfully');
    const msgId1 = sendRes1.json?.message?.id;
    assert(!!msgId1, 'Message ID returned in response');

    // Verify row in DB directly.
    //
    // The ciphertext no longer lives in the row — it is in the image store (storage design §7) and the row
    // names it. So this checks what still has to be true, and more of it than it used to: the row keeps the
    // nonce and the mime, the store holds the ciphertext EXACTLY as it was sent, and the database does not
    // hold a second copy of it.
    const dbRow1 = db.prepare('SELECT * FROM message_attachments WHERE message_id = ?').get(msgId1) as any;
    assert(!!dbRow1 && dbRow1.mime === 'image/png' && dbRow1.nonce === attachmentData1.nonce,
        'Attachment row keeps its nonce and mime');
    assert(!!dbRow1 && dbRow1.data === null && dbRow1.storage_key === `attachments/${msgId1}.bin`,
        'Attachment ciphertext is in the image store, not in the database');
    assert(getImageStore().get(dbRow1.storage_key)!.toString('base64') === attachmentData1.data,
        'and the stored object is exactly the ciphertext that was sent');

    // 2. GET /api/messages/:id/attachment access control (P1)
    // Unsigned request is refused
    const unsignedRes = await fetch(`${BASE}/api/messages/${msgId1}/attachment`);
    assert(readAuthOn ? unsignedRes.status === 401 : unsignedRes.status === 404,
        `unsigned → ${readAuthOn ? 401 : 404} (got ${unsignedRes.status})`);

    // Signed non-member is refused
    const strangerRes = await signedFetch('GET', `/api/messages/${msgId1}/attachment`, stranger);
    assert(strangerRes.status === 403 || strangerRes.status === 404 || strangerRes.status === 401,
        `signed non-member → refused (got ${strangerRes.status})`);

    // Member outside the DM gets 404 (as for no photo)
    const carolRes = await signedFetch('GET', `/api/messages/${msgId1}/attachment`, Carol);
    assert(carolRes.status === 404, `Carol, a member not in the DM → 404 (got ${carolRes.status})`);

    // Both participants in the DM get 200 with the attachment data
    const bobRes = await signedFetch('GET', `/api/messages/${msgId1}/attachment`, Bob);
    const aliceRes = await signedFetch('GET', `/api/messages/${msgId1}/attachment`, Alice);
    assert(bobRes.status === 200 && bobRes.json?.data === attachmentData1.data && bobRes.json?.nonce === attachmentData1.nonce && bobRes.json?.mime === 'image/png',
        'Bob (participant) → 200 with attachment data');
    assert(aliceRes.status === 200 && aliceRes.json?.data === attachmentData1.data,
        'Alice (sender) → 200 with attachment data');

    // 3. Send message with attachment lacking explicit MIME (should default to image/jpeg)
    const photo2 = lockedDm(64);
    const attachmentData2 = {
        data: photo2.ciphertext,
        nonce: photo2.nonce
    };

    const sendRes2 = await signedFetch('POST', '/api/messages/send', Alice, {
        conversationId: conv.id,
        authorPubkey: Alice.pubKeyHex,
        ...lockedDm(),
        type: 'image',
        attachment: attachmentData2
    });

    assert(sendRes2.status === 200 && sendRes2.json?.success === true, 'Second message sent successfully');
    const msgId2 = sendRes2.json?.message?.id;

    const getRes2 = await signedFetch('GET', `/api/messages/${msgId2}/attachment`, Bob);
    assert(getRes2.status === 200, 'GET second attachment returns 200 OK');
    assert(getRes2.json?.mime === 'image/jpeg', 'Attachment MIME defaults to image/jpeg when unsupplied');

    // 4. GET /api/messages/:id/attachment returns 404 for non-existent attachment
    const nonExistentId = crypto.randomUUID();
    const getRes404 = await signedFetch('GET', `/api/messages/${nonExistentId}/attachment`, Bob);
    assert(getRes404.status === 404, 'GET non-existent attachment returns 404 Not Found');
    assert(getRes404.error === 'Attachment not found', '404 error message matches');

    // 5. Withheld line: served to its sender alone
    await signedFetch('POST', '/api/blocks', Bob, { targetPubkey: Alice.pubKeyHex });
    const photoWithheld = lockedDm(256);
    const sendWithheld = await signedFetch('POST', '/api/messages/send', Alice, {
        conversationId: conv.id,
        authorPubkey: Alice.pubKeyHex,
        ...lockedDm(),
        type: 'image',
        attachment: { data: photoWithheld.ciphertext, nonce: photoWithheld.nonce }
    });
    const withheldId = sendWithheld.json?.message?.id;
    assert(!!withheldId, 'withheld message id created');

    const wbRes = await signedFetch('GET', `/api/messages/${withheldId}/attachment`, Bob);
    const wcRes = await signedFetch('GET', `/api/messages/${withheldId}/attachment`, Carol);
    const waRes = await signedFetch('GET', `/api/messages/${withheldId}/attachment`, Alice);
    assert(wbRes.status === 404 && wcRes.status === 404,
        `withheld line's photo: Bob (who blocked her) and Carol → 404 (got ${wbRes.status}, ${wcRes.status})`);
    assert(waRes.status === 200 && waRes.json?.data === photoWithheld.ciphertext,
        `withheld line's photo: Alice (sender) still → 200 (got ${waRes.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Message attachment integration tests PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
