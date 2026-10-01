// One tombstone shape for every "this message is gone" in a chat (chat parity, 2026-09-23).
//
// Three things can take a message down, and they are NOT the same thing:
//   - the author deletes their own message, in a DM or a group chat, at any age (POST /api/messages/delete);
//   - a convenor removes somebody else's message from their group's chat (POST /api/groups/:id/chat/remove);
//   - the author deletes their account, and every line they wrote goes, in every kind of chat (blankMessagesOf).
//
// All leave the row in place as a tombstone — nothing is ever deleted from `messages`, so a replica and a
// backup carry the removal instead of silently re-growing the message. The apps tell them apart by
// `metadata.removedBy`: the author's own key reads "This message was deleted", anyone else's "Removed by a
// convenor"; `metadata.accountDeleted` marks the third, which reads "This message was deleted" in an event or
// enterprise chat too, where every other tombstone is the host's or a keeper's removal. Everything hung off the
// message goes with it — reactions, mentions, the reply it quoted, and any attachment blob, which is node-local
// and so is hard-deleted rather than tombstoned.

import type Database from 'better-sqlite3';
import { db, afterTransactionCommit } from '../db/db.js';
import { deleteStoredObjects } from '../storage/image-columns.js';

/** What a line reads once its author has deleted their account, in every kind of chat (blankMessagesOf). */
export const ACCOUNT_DELETED_TEXT = 'This message was deleted';

export interface MessageTombstone {
    ciphertext: string;
    metadata: string;
    removedAt: string;
}

interface TombstoneStatements { write: Database.Statement; photo: Database.Statement; dropPhoto: Database.Statement }

function prepareTombstone(): TombstoneStatements {
    return {
        // nonce 'plaintext-v1' whatever the message was: a DM tombstone replaces the ciphertext on the node, so
        // the marker must be readable without the conversation key the two phones would otherwise need.
        write: db.prepare(`UPDATE messages SET type = 'removed', ciphertext = ?, nonce = 'plaintext-v1', metadata = ? WHERE id = ?`),
        photo: db.prepare('SELECT storage_key FROM message_attachments WHERE message_id = ?'),
        dropPhoto: db.prepare('DELETE FROM message_attachments WHERE message_id = ?'),
    };
}

/** One row made a tombstone, inside the caller's transaction. The photo's stored object, if any, for after it commits. */
function tombstoneRow(
    s: TombstoneStatements, messageId: string, row: any, removedBy: string, markerText: string, mark: Record<string, unknown>,
): { tombstone: MessageTombstone; photoKey: string | undefined } {
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
    Object.assign(metaObj, mark);
    const metadata = JSON.stringify(metaObj);
    const ciphertext = Buffer.from(markerText, 'utf8').toString('base64');

    s.write.run(ciphertext, metadata, messageId);
    // The photo goes too, or /api/attachment/:id would still serve it after a "delete for everyone".
    // The row inside the transaction, the stored object after it commits (storage design §7): the route
    // reads the row, so the object being a moment behind can never make a removed photo servable.
    const photoKey = (s.photo.get(messageId) as any)?.storage_key as string | undefined;
    s.dropPhoto.run(messageId);
    return { tombstone: { ciphertext, metadata, removedAt }, photoKey };
}

/**
 * Turn one message row into a tombstone. `markerText` is the plain text the row now carries; `removedBy` is
 * whoever took it down. Callers guard idempotency: a row that is already `removed` must not be passed here, or
 * the first remover's name would be overwritten by the second caller's.
 */
export function writeMessageTombstone(messageId: string, row: any, removedBy: string, markerText: string): MessageTombstone {
    const s = prepareTombstone();
    let written!: MessageTombstone;
    db.transaction(() => {
        const { tombstone, photoKey } = tombstoneRow(s, messageId, row, removedBy, markerText, {});
        if (photoKey) afterTransactionCommit(() => deleteStoredObjects(db, [photoKey]));
        written = tombstone;
    })();
    return written;
}

/** True for a tombstone written when its author deleted their account (blankMessagesOf). Never throws. */
export function blankedWithAccount(metadata: string | null | undefined): boolean {
    if (!metadata) return false;
    try { return JSON.parse(metadata)?.accountDeleted === true; } catch { return false; }
}

/**
 * Delete account (report F1; Marty, 2026-10-01: "Yes, blank lines and photos"): every line the member wrote, in every
 * chat — a group's, an enterprise's, an event's, and their own half of each DM — becomes a tombstone of their own
 * (`removedBy` is their key, `accountDeleted` says why), and every photo they sent goes: the row now, the stored object
 * once the caller's transaction has committed. Nobody, the operator included, reads their words after this. DMs too,
 * though the node never could read those: the ciphertext is still their words to anyone who holds either key, and a
 * DM whose other half went while theirs stayed would be the one place they had not left.
 *
 * Each line stays where it was, so a conversation still reads in order ("This message was deleted"), and each one's
 * updated_at moves (messages_touch_updated_at): a standby's next copy carries the tombstone, never the words. A phone's
 * next sync carries it only for the newest 50 lines of a conversation: the app asks GET /api/messages/:id with no limit,
 * so the other person's phone keeps any older DM line of theirs it already holds (the guide page says so). Group, event
 * and enterprise chats are read live from the server and are all blanked. Everyone else's lines are theirs and stay exactly as they are. A line already down keeps whoever took it
 * down first, and loses a photo still hung off it. Returns how many lines it blanked.
 *
 * One transaction (the caller's, when there is one) and statements prepared once: a member with years of lines must not
 * prepare three statements a line (better-sqlite3 compiles on every prepare, and frees only when the collector runs).
 */
export function blankMessagesOf(authorPubkey: string): number {
    const s = prepareTombstone();
    const lines = db.prepare(`SELECT id, metadata FROM messages WHERE author_pubkey = ? AND type IS NOT 'removed'`)
        .all(authorPubkey) as { id: string; metadata: string | null }[];
    const photoKeys: string[] = [];
    db.transaction(() => {
        for (const line of lines) {
            const { photoKey } = tombstoneRow(s, line.id, line, authorPubkey, ACCOUNT_DELETED_TEXT, { accountDeleted: true });
            if (photoKey) photoKeys.push(photoKey);
        }
        // A photo still hung off a line that was already down: nothing in this release leaves one, but the event and
        // enterprise removals never looked.
        const stray = db.prepare(`SELECT storage_key FROM message_attachments
                                  WHERE message_id IN (SELECT id FROM messages WHERE author_pubkey = ?)`).all(authorPubkey) as { storage_key: string | null }[];
        if (stray.length > 0) {
            db.prepare('DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE author_pubkey = ?)').run(authorPubkey);
            for (const { storage_key } of stray) if (storage_key) photoKeys.push(storage_key);
        }
        if (photoKeys.length > 0) afterTransactionCommit(() => deleteStoredObjects(db, photoKeys));
    })();
    return lines.length;
}
