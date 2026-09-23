/**
 * Test suite for writeMessageTombstone in apps/server/src/engine/message-tombstone.ts.
 *
 * Verifies:
 * 1. Standard tombstoning of messages:
 *    - Strips mentions, reactions, replyToId from metadata while preserving custom fields.
 *    - Sets removed = true, removedBy, and removedAt in metadata.
 *    - Base64 encodes the marker text into ciphertext and sets nonce = 'plaintext-v1'.
 *    - Updates type = 'removed' on the message DB row.
 *    - Deletes corresponding attachments from message_attachments.
 * 2. Robust handling of malformed or unexpected row metadata shapes:
 *    - Malformed JSON strings.
 *    - Non-object / array / primitive JSON strings.
 *    - Null or undefined row or metadata.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-message-tombstone.ts
 */

import { writeMessageTombstone } from './engine/message-tombstone.js';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

function main() {
    console.log('Running message tombstone engine tests...\n');
    initStateEngine();

    // 1. Seed members and conversation for DB integrity
    const memberAlice = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const memberBob = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status) VALUES (?, 'Alice', 'active')`).run(memberAlice);
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status) VALUES (?, 'Bob', 'active')`).run(memberBob);

    const convId = 'conv_tombstone_test';
    db.prepare(`INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(convId);

    // ── Test Case 1: Standard message tombstoning with attachments and metadata stripping ──
    const msg1Id = 'msg_001';
    const initialMeta = JSON.stringify({
        mentions: [memberBob],
        reactions: { '👍': [memberBob] },
        replyToId: 'msg_000',
        customField: 'preserved_val',
    });

    db.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata)
        VALUES (?, ?, ?, 'original_cipher', 'nonce_123', 'text', ?)
    `).run(msg1Id, convId, memberAlice, initialMeta);

    db.prepare(`
        INSERT INTO message_attachments (message_id, data, nonce, mime)
        VALUES (?, 'attachment_data_base64', 'attach_nonce', 'image/png')
    `).run(msg1Id);

    const row1 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msg1Id) as any;
    const markerText1 = 'This message was deleted';
    const result1 = writeMessageTombstone(msg1Id, row1, memberAlice, markerText1);

    // Check return value
    const expectedCipher1 = Buffer.from(markerText1, 'utf8').toString('base64');
    assert(result1.ciphertext === expectedCipher1, 'writeMessageTombstone returns correct base64 ciphertext');
    assert(typeof result1.removedAt === 'string' && result1.removedAt.length > 0, 'writeMessageTombstone returns valid removedAt ISO string');

    const parsedMeta1 = JSON.parse(result1.metadata);
    assert(parsedMeta1.removed === true, 'metadata.removed is true');
    assert(parsedMeta1.removedBy === memberAlice, 'metadata.removedBy matches remover');
    assert(parsedMeta1.mentions === undefined, 'metadata.mentions stripped');
    assert(parsedMeta1.reactions === undefined, 'metadata.reactions stripped');
    assert(parsedMeta1.replyToId === undefined, 'metadata.replyToId stripped');
    assert(parsedMeta1.customField === 'preserved_val', 'custom metadata fields preserved');

    // Check DB state
    const dbMsg1 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msg1Id) as any;
    assert(dbMsg1.type === 'removed', 'DB message type updated to removed');
    assert(dbMsg1.nonce === 'plaintext-v1', 'DB message nonce updated to plaintext-v1');
    assert(dbMsg1.ciphertext === expectedCipher1, 'DB message ciphertext updated to base64 marker');

    const attachmentCount1 = (db.prepare(`SELECT COUNT(*) as count FROM message_attachments WHERE message_id = ?`).get(msg1Id) as any).count;
    assert(attachmentCount1 === 0, 'Attachment deleted from message_attachments table');

    // ── Test Case 2: Malformed / Invalid JSON string in row.metadata ──
    const msg2Id = 'msg_002';
    db.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata)
        VALUES (?, ?, ?, 'cipher_2', 'nonce_2', 'text', '{invalid_json}')
    `).run(msg2Id, convId, memberAlice);

    const row2 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msg2Id) as any;
    const result2 = writeMessageTombstone(msg2Id, row2, memberBob, 'Removed by moderator');

    const parsedMeta2 = JSON.parse(result2.metadata);
    assert(parsedMeta2.removed === true && parsedMeta2.removedBy === memberBob, 'Handles malformed JSON string without error and writes tombstone metadata');

    // ── Test Case 3: JSON array or primitive in row.metadata ──
    const msg3Id = 'msg_003';
    db.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata)
        VALUES (?, ?, ?, 'cipher_3', 'nonce_3', 'text', '[1, 2, 3]')
    `).run(msg3Id, convId, memberAlice);

    const row3 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(msg3Id) as any;
    const result3 = writeMessageTombstone(msg3Id, row3, memberBob, 'Removed by moderator');

    const parsedMeta3 = JSON.parse(result3.metadata);
    assert(parsedMeta3.removed === true && parsedMeta3.removedBy === memberBob, 'Handles JSON array metadata without error and resets to object');

    // ── Test Case 4: Null / undefined row or row.metadata ──
    const msg4Id = 'msg_004';
    db.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata)
        VALUES (?, ?, ?, 'cipher_4', 'nonce_4', 'text', NULL)
    `).run(msg4Id, convId, memberAlice);

    const result4 = writeMessageTombstone(msg4Id, null, memberAlice, 'Deleted');
    const parsedMeta4 = JSON.parse(result4.metadata);
    assert(parsedMeta4.removed === true && parsedMeta4.removedBy === memberAlice, 'Handles null row input safely');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
