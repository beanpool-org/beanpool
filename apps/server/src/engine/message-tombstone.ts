// One tombstone shape for every "this message is gone" in a chat (chat parity, 2026-09-23).
//
// Two things can take a message down, and they are NOT the same thing:
//   - the author deletes their own message, in a DM or a group chat, at any age (POST /api/messages/delete);
//   - a convenor removes somebody else's message from their group's chat (POST /api/groups/:id/chat/remove).
//
// Both leave the row in place as a tombstone — nothing is ever deleted from `messages`, so a replica and a
// backup carry the removal instead of silently re-growing the message. The apps tell the two apart by
// `metadata.removedBy`: the author's own key reads "This message was deleted", anyone else's "Removed by a
// convenor". Everything hung off the message goes with it — reactions, mentions, the reply it quoted, and any
// attachment blob, which is node-local and so is hard-deleted rather than tombstoned.

import { db, afterTransactionCommit } from '../db/db.js';
import { deleteStoredObjects } from '../storage/image-columns.js';

export interface MessageTombstone {
    ciphertext: string;
    metadata: string;
    removedAt: string;
}

/**
 * Turn one message row into a tombstone. `markerText` is the plain text the row now carries; `removedBy` is
 * whoever took it down. Callers guard idempotency: a row that is already `removed` must not be passed here, or
 * the first remover's name would be overwritten by the second caller's.
 */
export function writeMessageTombstone(messageId: string, row: any, removedBy: string, markerText: string): MessageTombstone {
    let metaObj: any = {};
    if (row?.metadata) {
        try { metaObj = JSON.parse(row.metadata); } catch { /* keep the replacement metadata */ }
    }
    if (!metaObj || typeof metaObj !== 'object' || Array.isArray(metaObj)) metaObj = {};
    delete metaObj.mentions;
    delete metaObj.reactions;
    delete metaObj.replyToId;
    metaObj.removed = true;
    metaObj.removedBy = removedBy;
    const removedAt = new Date().toISOString();
    metaObj.removedAt = removedAt;
    const metadata = JSON.stringify(metaObj);
    const ciphertext = Buffer.from(markerText, 'utf8').toString('base64');

    db.transaction(() => {
        // nonce 'plaintext-v1' whatever the message was: a DM tombstone replaces the ciphertext on the node, so
        // the marker must be readable without the conversation key the two phones would otherwise need.
        db.prepare(`UPDATE messages SET type = 'removed', ciphertext = ?, nonce = 'plaintext-v1', metadata = ? WHERE id = ?`)
            .run(ciphertext, metadata, messageId);
        // The photo goes too, or /api/attachment/:id would still serve it after a "delete for everyone".
        // The row inside the transaction, the stored object after it commits (storage design §7): the route
        // reads the row, so the object being a moment behind can never make a removed photo servable.
        const key = (db.prepare('SELECT storage_key FROM message_attachments WHERE message_id = ?').get(messageId) as any)?.storage_key as string | undefined;
        db.prepare('DELETE FROM message_attachments WHERE message_id = ?').run(messageId);
        if (key) afterTransactionCommit(() => deleteStoredObjects([key]));
    })();

    return { ciphertext, metadata, removedAt };
}
