/**
 * Unit/integration tests for withheld lines engine module (apps/server/src/engine/withheld-lines.ts).
 *
 * Asserts withheld conversations, line storage, attachments, editing, metadata,
 * tombstoning, overlays (reactions/edits), page/list merging, and account cleanup.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-withheld-lines.ts
 */

import type { Message } from '@beanpool/engine';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import {
    openWithheldConversation,
    withheldConversationOwnedBy,
    withheldConversationById,
    withheldConversationOfPair,
    markWithheldConversationRead,
    dropWithheldConversation,
    withheldConversationView,
    storeWithheldLine,
    withheldLine,
    ownWithheldLine,
    editWithheldLine,
    setWithheldLineMetadata,
    tombstoneWithheldLine,
    withheldLineMessage,
    withheldAttachmentFor,
    overlayOf,
    setOverlayReaction,
    setOverlayEdit,
    clearOverlayEdit,
    dropOverlaysOn,
    withOwnReaction,
    withOwnOverlay,
    pageWithOwnWithheld,
    listWithOwnWithheld,
    dropWithheldOf,
} from './engine/withheld-lines.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

function main() {
    console.log('Running withheld-lines tests...\n');

    initStateEngine();

    const alice = 'pubkey_alice_11111111111111111111111111111111111111111111111111111111';
    const bob = 'pubkey_bob_222222222222222222222222222222222222222222222222222222222';
    const conv1 = 'conv_1111111111111111111111111111111111111111111111111111111111111111';

    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign) VALUES (?, ?)').run(alice, 'alice');
    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign) VALUES (?, ?)').run(bob, 'bob');

    const now = new Date().toISOString();

    // 1. Withheld Conversations
    assert(withheldConversationById(conv1) === undefined, 'withheldConversationById returns undefined for unknown conv');
    assert(withheldConversationOwnedBy(conv1, alice) === undefined, 'withheldConversationOwnedBy returns undefined when missing');

    const opened = openWithheldConversation(alice, bob, conv1, now);
    assert(opened.created === true, 'openWithheldConversation creates a new withheld conversation');
    assert(opened.conversation.id === conv1, 'opened conversation has expected id');

    const openedAgain = openWithheldConversation(alice, bob, conv1, now);
    assert(openedAgain.created === false, 'openWithheldConversation returns existing conversation on second call');

    const byId = withheldConversationById(conv1);
    assert(byId?.owner_pubkey === alice && byId?.other_pubkey === bob, 'withheldConversationById finds stored conversation');

    const owned = withheldConversationOwnedBy(conv1, alice);
    assert(owned?.id === conv1, 'withheldConversationOwnedBy returns conversation for owner');
    assert(withheldConversationOwnedBy(conv1, bob) === undefined, 'withheldConversationOwnedBy returns undefined for non-owner');

    const pair = withheldConversationOfPair(alice, bob);
    assert(pair?.id === conv1, 'withheldConversationOfPair finds conversation between pair');

    markWithheldConversationRead(conv1, alice, '2026-10-01T12:00:00.000Z');
    const readConv = withheldConversationOwnedBy(conv1, alice);
    assert(readConv?.owner_last_read_at === '2026-10-01T12:00:00.000Z', 'markWithheldConversationRead updates owner_last_read_at');

    const view = withheldConversationView(readConv!);
    assert(view.id === conv1 && view.type === 'dm', 'withheldConversationView formats conversation wire shape');
    assert(view.readCursors.some(rc => rc.publicKey === alice && rc.lastReadAt === '2026-10-01T12:00:00.000Z'), 'withheldConversationView includes read cursor');

    // 2. Withheld Lines
    const msgId1 = 'msg_1111111111111111111111111111111111111111111111111111111111111111';
    const msg1: Message = {
        id: msgId1,
        conversationId: conv1,
        authorPubkey: alice,
        ciphertext: 'cipher_hello',
        nonce: 'nonce_123',
        type: 'text',
        timestamp: '2026-10-01T12:01:00.000Z',
    };

    storeWithheldLine(msg1, { data: 'photo_data_b64', nonce: 'attachment_nonce', mime: 'image/png' });
    const lineRow = withheldLine(msgId1);
    assert(lineRow !== undefined && lineRow.ciphertext === 'cipher_hello', 'storeWithheldLine inserts line');
    assert(ownWithheldLine(msgId1, alice) !== undefined, 'ownWithheldLine finds line for author');
    assert(ownWithheldLine(msgId1, bob) === undefined, 'ownWithheldLine returns undefined for non-author');

    const attachment = withheldAttachmentFor(msgId1);
    assert(attachment !== undefined && attachment.nonce === 'attachment_nonce', 'withheldAttachmentFor retrieves attachment metadata');

    editWithheldLine(msgId1, 'cipher_edited', 'nonce_edited', '2026-10-01T12:02:00.000Z');
    const editedRow = withheldLine(msgId1);
    assert(editedRow?.ciphertext === 'cipher_edited' && editedRow?.edited_at === '2026-10-01T12:02:00.000Z', 'editWithheldLine updates ciphertext and edited_at');

    setWithheldLineMetadata(msgId1, JSON.stringify({ reactions: [{ emoji: '👍', author: alice }] }));
    const metaRow = withheldLine(msgId1);
    assert(Boolean(metaRow?.metadata?.includes('👍')), 'setWithheldLineMetadata updates metadata');

    const msgWire = withheldLineMessage(editedRow!);
    assert(msgWire.id === msgId1 && msgWire.ciphertext === 'cipher_edited', 'withheldLineMessage converts to Message wire shape');

    tombstoneWithheldLine(msgId1, 'tombstone_cipher', JSON.stringify({ tombstone: true }));
    const tombstoned = withheldLine(msgId1);
    assert(tombstoned?.type === 'removed' && tombstoned?.ciphertext === 'tombstone_cipher', 'tombstoneWithheldLine converts line to tombstone');

    // 3. Overlays & Reaction Merging
    const realMsgId = 'msg_real_1111111111111111111111111111111111111111111111111111111111';
    assert(overlayOf(realMsgId, alice) === undefined, 'overlayOf returns undefined when no overlay exists');

    setOverlayReaction(realMsgId, alice, '❤️');
    assert(overlayOf(realMsgId, alice)?.reaction === '❤️', 'setOverlayReaction stores overlay reaction');

    setOverlayEdit(realMsgId, alice, 'cipher_overlay_edit', 'nonce_ov', '2026-10-01T12:05:00.000Z');
    const ov = overlayOf(realMsgId, alice);
    assert(ov?.ciphertext === 'cipher_overlay_edit' && ov?.reaction === '❤️', 'setOverlayEdit updates overlay ciphertext');

    const mergedReactionJson = withOwnReaction(null, alice, '❤️');
    assert(mergedReactionJson.includes('❤️') && mergedReactionJson.includes(alice), 'withOwnReaction formats reaction JSON metadata');

    const baseMessage: Message = {
        id: realMsgId,
        conversationId: conv1,
        authorPubkey: alice,
        ciphertext: 'original_cipher',
        nonce: 'original_nonce',
        type: 'text',
        timestamp: '2026-10-01T12:00:00.000Z',
    };

    const overlayApplied = withOwnOverlay(baseMessage, alice);
    assert(overlayApplied.ciphertext === 'cipher_overlay_edit', 'withOwnOverlay lays edit and reaction over message');

    clearOverlayEdit(realMsgId, alice);
    assert(overlayOf(realMsgId, alice)?.ciphertext === null, 'clearOverlayEdit removes edit from overlay');

    setOverlayReaction(realMsgId, alice, null);
    assert(overlayOf(realMsgId, alice) === undefined, 'setting reaction to null tidies overlay row when empty');

    setOverlayReaction(realMsgId, alice, '🔥');
    dropOverlaysOn(realMsgId);
    assert(overlayOf(realMsgId, alice) === undefined, 'dropOverlaysOn removes all overlays on message');

    // 4. Page and List Helpers
    const paged = pageWithOwnWithheld(conv1, alice, 10, 0, () => [baseMessage]);
    assert(paged.length >= 1, 'pageWithOwnWithheld merges stored messages with withheld lines');

    const listed = listWithOwnWithheld(alice, [] as { id: string; createdAt?: string }[]);
    assert(listed.length === 1 && listed[0].id === conv1, 'listWithOwnWithheld includes withheld conversation');

    // 5. Account Cleanup
    dropWithheldConversation(conv1);
    assert(withheldConversationById(conv1) === undefined, 'dropWithheldConversation deletes withheld conversation');

    dropWithheldOf(alice);
    assert(withheldLine(msgId1) === undefined, 'dropWithheldOf removes author withheld lines');

    console.log(`\n${passed}/${run} withheld-lines tests passed.`);
    process.exit(0);
}

main();
