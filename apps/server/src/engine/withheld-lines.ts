/**
 * Withheld lines: what a member sends in a direct conversation to someone who has blocked them (engine/member-blocks.ts;
 * MEDIUM-5 of scratch/reviews/FABLE-sec-global-abuse.md, 2026-10-01). Blocking was a filter on the blocker's screen: a
 * blocked member went on opening conversations and sending lines, and each was stored, copied to a standby, pushed and
 * counted in the blocker's badge.
 *
 * Now the node answers the blocked member exactly as it answers any send (engine/messaging.ts, after every refusal a
 * send can meet), so the block isn't revealed to them, and keeps the line HERE, for its sender alone, never in
 * `messages`:
 *
 * - The person who blocked them never gets it: not now, not after they unblock (nothing here ever moves into
 *   `messages`), and from no server. Everything that shows a chat, counts a badge or sends a push reads `messages`, and
 *   a standby's copy carries `messages` and not these (engine/replication-manifest.ts: local), so no reader of
 *   `messages`, present or future, and no promoted standby can deliver one.
 * - Its sender's screen looks as it would: their own reads of the chat (routes/messaging.ts) add their own withheld
 *   lines, and their conversation list the conversations below, ordered by their own last line. They edit, delete and
 *   react to their own as to any line of theirs, and the live update goes to their own sockets only. Only the signed
 *   sender reads them: no other key, and no unsigned request.
 * - A conversation such a sender opens, where the two have none, is kept here as well (withheld_conversations), so the
 *   person who blocked them sees no new chat in their list. It becomes the real conversation, under the same id (the id
 *   the apps encrypt against), when either of them opens one with the other, or the sender writes in it once the block
 *   is lifted; the lines withheld before stay withheld.
 * - A reaction on a line of a DM with someone who has blocked them, or an edit of their own line in it, is kept here too
 *   (withheld_overlays), laid over their own reads of that line and heard on their own sockets only, so it doesn't
 *   vanish on their next read (#1403 review); the line itself, which the other person sees, never changes.
 *
 * A promoted standby has none of these: the sender's own copies of lines nobody else ever saw are what a take-over
 * loses. A line's photo is kept in the image store as a chat photo is, its key in the row (a chat photo isn't copied
 * either; replication-manifest message_attachments), and its object goes with the line.
 * Gone with their sender on a prune or a self-deletion (dropWithheldOf); a re-key moves them (engine/key-move.ts).
 */
import { avatarUrlFor } from '@beanpool/core';
import type { Message } from '@beanpool/engine';
import { db, afterTransactionCommit } from '../db/db.js';
import { attachmentKey, getImageStore } from '../storage/image-store.js';
import { storeAttachmentColumns, deleteStoredObjects, type AttachmentRow } from '../storage/image-columns.js';

export interface WithheldConversation {
    id: string;
    owner_pubkey: string;
    other_pubkey: string;
    created_at: string;
    /** Its owner's read marker (POST /api/messages/mark-read), as a participant row keeps one. */
    owner_last_read_at?: string | null;
}

export interface WithheldLine {
    id: string;
    conversation_id: string;
    author_pubkey: string;
    ciphertext: string;
    nonce: string;
    type: string;
    metadata: string | null;
    timestamp: string;
    edited_at: string | null;
    attachment_data: string | null;
    attachment_nonce: string | null;
    attachment_mime: string | null;
    /** Where the photo's ciphertext is in the image store, as a chat photo's is (storage design §7); `attachment_data` then null. */
    storage_key?: string | null;
}

// ── conversations ───────────────────────────────────────────────────────────────────────────────────────────────

/** The withheld conversation `id`, when `owner` opened it. */
export function withheldConversationOwnedBy(id: unknown, owner: string | undefined): WithheldConversation | undefined {
    if (typeof id !== 'string' || !id || !owner) return undefined;
    return db.prepare('SELECT * FROM withheld_conversations WHERE id = ? AND owner_pubkey = ?').get(id, owner) as WithheldConversation | undefined;
}

/** The withheld conversation `id`, whoever opened it: for answering anyone else as a real conversation answers a non-participant. */
export function withheldConversationById(id: unknown): WithheldConversation | undefined {
    if (typeof id !== 'string' || !id) return undefined;
    return db.prepare('SELECT * FROM withheld_conversations WHERE id = ?').get(id) as WithheldConversation | undefined;
}

/** A withheld conversation between these two, opened by either: the older first, when each opened one. */
export function withheldConversationOfPair(a: string, b: string): WithheldConversation | undefined {
    return db.prepare(`SELECT * FROM withheld_conversations
                        WHERE (owner_pubkey = ? AND other_pubkey = ?) OR (owner_pubkey = ? AND other_pubkey = ?)
                        ORDER BY created_at, id LIMIT 1`).get(a, b, b, a) as WithheldConversation | undefined;
}

/** `owner`'s withheld conversation with `other`: the one they have, or a new one with this id. */
export function openWithheldConversation(owner: string, other: string, id: string, at: string): { conversation: WithheldConversation; created: boolean } {
    const had = db.prepare('SELECT * FROM withheld_conversations WHERE owner_pubkey = ? AND other_pubkey = ?').get(owner, other) as WithheldConversation | undefined;
    if (had) return { conversation: had, created: false };
    db.prepare('INSERT INTO withheld_conversations (id, owner_pubkey, other_pubkey, created_at) VALUES (?, ?, ?, ?)').run(id, owner, other, at);
    return { conversation: { id, owner_pubkey: owner, other_pubkey: other, created_at: at }, created: true };
}

/** Its owner reads it: their read marker moves, as on a participant row (engine/messaging.ts markConversationRead). */
export function markWithheldConversationRead(id: string, owner: string, at: string = new Date().toISOString()): void {
    db.prepare('UPDATE withheld_conversations SET owner_last_read_at = ? WHERE id = ? AND owner_pubkey = ?').run(at, id, owner);
}

/** A withheld conversation becoming the real one (engine/messaging.ts): its row goes, its lines stay withheld. */
export function dropWithheldConversation(id: string): void {
    db.prepare('DELETE FROM withheld_conversations WHERE id = ?').run(id);
}

/** A withheld conversation as GET /api/messages/:id answers a conversation (engine getConversation), for its owner. */
export function withheldConversationView(c: WithheldConversation) {
    const participants = [c.owner_pubkey, c.other_pubkey];
    return {
        id: c.id, type: 'dm' as const, postId: null, postTitle: null, postStatus: 'active', name: null,
        createdBy: c.owner_pubkey, createdAt: c.created_at, participants,
        readCursors: participants.map(publicKey => ({ publicKey, lastReadAt: publicKey === c.owner_pubkey ? c.owner_last_read_at ?? null : null })),
    };
}

// ── lines ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The withheld line `id`, whoever wrote it. */
export function withheldLine(id: unknown): WithheldLine | undefined {
    if (typeof id !== 'string' || !id) return undefined;
    return db.prepare('SELECT * FROM withheld_lines WHERE id = ?').get(id) as WithheldLine | undefined;
}

/** The withheld line `id`, when `author` wrote it. */
export function ownWithheldLine(id: unknown, author: string | undefined): WithheldLine | undefined {
    const row = withheldLine(id);
    return row && author && row.author_pubkey === author ? row : undefined;
}

/**
 * Keeps a line for its sender alone. Its photo's ciphertext goes to the image store and the row keeps a key, exactly as
 * a chat photo's does (engine/messaging.ts sendMessage; storage design §7), so a blocked sender's photos don't grow the
 * database file (#1403 review). An id no key is built from, or a store that refuses it, keeps it in the row.
 */
export function storeWithheldLine(msg: Message, attachment?: { data: string; nonce: string; mime?: string }): void {
    const photo = attachment?.data && attachment?.nonce ? attachment : undefined;
    let cols: { data: string | null; storage_key: string | null } = { data: null, storage_key: null };
    if (photo) {
        let key: string | null = null;
        try { key = attachmentKey(msg.id); } catch { /* kept in the row */ }
        cols = key ? storeAttachmentColumns(getImageStore(), key, photo.data) : { data: photo.data, storage_key: null };
    }
    db.prepare(`INSERT INTO withheld_lines (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp,
                                            attachment_data, attachment_nonce, attachment_mime, storage_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(msg.id, msg.conversationId, msg.authorPubkey, msg.ciphertext, msg.nonce, msg.type, msg.metadata ?? null, msg.timestamp,
            cols.data, photo?.nonce ?? null, photo ? (photo.mime || 'image/jpeg') : null, cols.storage_key);
}

/** New words on a withheld line (its sender's edit). */
export function editWithheldLine(id: string, ciphertext: string, nonce: string, editedAt: string): void {
    db.prepare('UPDATE withheld_lines SET ciphertext = ?, nonce = ?, edited_at = ? WHERE id = ?').run(ciphertext, nonce, editedAt, id);
}

/** A withheld line's metadata (its sender's reaction). */
export function setWithheldLineMetadata(id: string, metadata: string): void {
    db.prepare('UPDATE withheld_lines SET metadata = ? WHERE id = ?').run(metadata, id);
}

/** A withheld line made a tombstone (its sender's delete), its photo gone with it, as a line in `messages` is. */
export function tombstoneWithheldLine(id: string, ciphertext: string, metadata: string): void {
    const key = (db.prepare('SELECT storage_key FROM withheld_lines WHERE id = ?').get(id) as { storage_key: string | null } | undefined)?.storage_key;
    db.prepare(`UPDATE withheld_lines SET type = 'removed', ciphertext = ?, nonce = 'plaintext-v1', metadata = ?,
                       attachment_data = NULL, attachment_nonce = NULL, attachment_mime = NULL, storage_key = NULL WHERE id = ?`).run(ciphertext, metadata, id);
    // The stored object once the row no longer names it (after the caller's transaction commits, if there is one).
    if (key) afterTransactionCommit(() => deleteStoredObjects(db, [key]));
}

/** A withheld line in the wire shape of a line in `messages` (engine getConversationMessages). */
export function withheldLineMessage(r: WithheldLine): Message {
    // The nulls a stored line answers with (no system type, no metadata), so the two read alike.
    const none: any = null;
    return {
        id: r.id,
        conversationId: r.conversation_id,
        authorPubkey: r.author_pubkey,
        ciphertext: r.ciphertext,
        nonce: r.nonce,
        type: r.type,
        systemType: none,
        metadata: r.metadata ?? none,
        timestamp: r.timestamp,
        editedAt: r.edited_at,
        updatedAt: r.edited_at ?? r.timestamp,
    };
}

/**
 * A withheld line's photo as an attachment row (routes/marketplace.ts reads its ciphertext from the row or the image
 * store, as for a chat photo). Served by its id to whoever asks, unsigned too, exactly as a stored chat photo is
 * (/api/messages/:id/attachment is a public read): only its sender ever has the id, and a 404 for anyone else would
 * tell them they are blocked (#1403 re-review). The ciphertext is E2E; the node can't read it.
 */
export function withheldAttachmentFor(id: unknown): (AttachmentRow & { nonce: string; mime: string }) | undefined {
    const row = withheldLine(id);
    if ((!row?.attachment_data && !row?.storage_key) || !row.attachment_nonce) return undefined;
    return { data: row.attachment_data, storage_key: row.storage_key ?? null, nonce: row.attachment_nonce, mime: row.attachment_mime || 'image/jpeg' };
}

// ── a blocked member's reaction or edit on a line in `messages` ─────────────────────────────────────────────────

/**
 * What a blocked member did to a line the person who blocked them can see (engine/messaging.ts): their reaction on a
 * line of a DM with that person, or their edit of their own line in it. Never written into the line: kept here for its
 * author alone and laid over their own reads of it (pageWithOwnWithheld), so their screen shows what they did, as it
 * would anyone's, and the other person's shows nothing of it, then or after an unblock. `reaction` null: none of theirs
 * here (the line's own stands); `ciphertext` null: no edit.
 */
export interface WithheldOverlay {
    message_id: string;
    author_pubkey: string;
    reaction: string | null;
    ciphertext: string | null;
    nonce: string | null;
    edited_at: string | null;
    changed_at: string;
}

/** `author`'s overlay on the line `messageId`, if they have one. */
export function overlayOf(messageId: string, author: string): WithheldOverlay | undefined {
    return db.prepare('SELECT * FROM withheld_overlays WHERE message_id = ? AND author_pubkey = ?').get(messageId, author) as WithheldOverlay | undefined;
}

/** A row with nothing left in it goes. */
function tidyOverlay(messageId: string, author: string): void {
    db.prepare('DELETE FROM withheld_overlays WHERE message_id = ? AND author_pubkey = ? AND reaction IS NULL AND ciphertext IS NULL').run(messageId, author);
}

/** `author`'s reaction on the line, for their eyes alone; null takes theirs off the overlay. */
export function setOverlayReaction(messageId: string, author: string, emoji: string | null): void {
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO withheld_overlays (message_id, author_pubkey, reaction, changed_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(message_id, author_pubkey) DO UPDATE SET reaction = excluded.reaction, changed_at = excluded.changed_at`)
        .run(messageId, author, emoji, at);
    if (emoji === null) tidyOverlay(messageId, author);
}

/** `author`'s new words on their own line, for their eyes alone. */
export function setOverlayEdit(messageId: string, author: string, ciphertext: string, nonce: string, editedAt: string): void {
    db.prepare(`INSERT INTO withheld_overlays (message_id, author_pubkey, ciphertext, nonce, edited_at, changed_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(message_id, author_pubkey) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
                    edited_at = excluded.edited_at, changed_at = excluded.changed_at`)
        .run(messageId, author, ciphertext, nonce, editedAt, editedAt);
}

/** The edit is the line's own now (made once the block was lifted): the overlay's goes. */
export function clearOverlayEdit(messageId: string, author: string): void {
    db.prepare('UPDATE withheld_overlays SET ciphertext = NULL, nonce = NULL, edited_at = NULL WHERE message_id = ? AND author_pubkey = ?').run(messageId, author);
    tidyOverlay(messageId, author);
}

/** The line is gone (a tombstone): nothing is laid over it any more. */
export function dropOverlaysOn(messageId: string): void {
    db.prepare('DELETE FROM withheld_overlays WHERE message_id = ?').run(messageId);
}

/**
 * A line's metadata with `author`'s reaction as `emoji`: theirs replaced where it is, or added at the end, exactly as a
 * reaction is stored (engine/messaging.ts toggledReactions), so the author's read is the one a stored reaction gives.
 */
export function withOwnReaction(stored: string | null | undefined, author: string, emoji: string): string {
    let metadata: any = {};
    if (stored) {
        try { metadata = JSON.parse(stored); } catch { metadata = {}; }
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
    if (!Array.isArray(metadata.reactions)) metadata.reactions = [];
    const mine = metadata.reactions.findIndex((r: any) => r?.author === author);
    if (mine > -1) metadata.reactions[mine].emoji = emoji;
    else metadata.reactions.push({ emoji, author });
    return JSON.stringify(metadata);
}

/** One line as `author` sees it: with their overlay laid over it (looked up when not given). A tombstone takes none. */
export function withOwnOverlay(line: Message, author: string, given?: WithheldOverlay | null): Message {
    const ov = given === undefined ? overlayOf(line.id, author) : given;
    if (!ov || line.type === 'removed') return line;
    const seen: Message = { ...line };
    if (ov.reaction) seen.metadata = withOwnReaction(line.metadata, author, ov.reaction);
    if (ov.ciphertext && ov.nonce && line.authorPubkey === author) {
        seen.ciphertext = ov.ciphertext;
        seen.nonce = ov.nonce;
        seen.editedAt = ov.edited_at ?? line.editedAt;
    }
    // As a stored line's stamp moves with each change to it.
    if ('updatedAt' in line && (!line.updatedAt || ov.changed_at > line.updatedAt)) seen.updatedAt = ov.changed_at;
    return seen;
}

/** Lines as `viewer` reads them: their own overlays laid over theirs. */
function withOwnOverlays(lines: Message[], viewer: string): Message[] {
    if (lines.length === 0) return lines;
    const rows = db.prepare(`SELECT * FROM withheld_overlays WHERE author_pubkey = ? AND message_id IN (SELECT value FROM json_each(?))`)
        .all(viewer, JSON.stringify(lines.map(l => l.id))) as WithheldOverlay[];
    if (rows.length === 0) return lines;
    const byId = new Map(rows.map(r => [r.message_id, r]));
    return lines.map(l => withOwnOverlay(l, viewer, byId.get(l.id) ?? null));
}

// ── what the sender reads ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One page of a conversation as `viewer` reads it, oldest first as the engine answers (getConversationMessages): its
 * lines, and the viewer's own withheld lines in it, in time order. `page(limit, offset)` reads its lines, newest first
 * by `offset`. Only the viewer's own: anyone else gets `page` as it is. The lines keep their own order; a withheld one
 * goes before the first line it was sent after.
 */
export function pageWithOwnWithheld(conversationId: string, viewer: string | undefined, limit: number, offset: number,
                                    page: (limit: number, offset: number) => Message[]): Message[] {
    if (!viewer) return page(limit, offset);
    const own = (db.prepare(`SELECT * FROM withheld_lines WHERE conversation_id = ? AND author_pubkey = ?
                              ORDER BY timestamp DESC, rowid DESC LIMIT ?`).all(conversationId, viewer, limit + offset) as WithheldLine[])
        .map(withheldLineMessage);
    // Their own reactions and edits on the lines, kept for them alone, laid over the lines as they read them.
    if (own.length === 0) return withOwnOverlays(page(limit, offset), viewer);
    const lines = withOwnOverlays(page(limit + offset, 0), viewer).reverse();
    const merged: Message[] = [];
    let i = 0, j = 0;
    while (merged.length < limit + offset && (i < lines.length || j < own.length)) {
        if (j < own.length && (i >= lines.length || own[j].timestamp > lines[i].timestamp)) merged.push(own[j++]);
        else merged.push(lines[i++]);
    }
    return merged.slice(offset, offset + limit).reverse();
}

/** One entry of a conversation list (engine getConversationsByMember), as far as this file reads and writes it. */
interface ListedConversation {
    id: string;
    createdAt?: string;
    lastMsgType?: string | null;
    lastSysType?: string | null;
}

/**
 * `viewer`'s conversation list with their own withheld conversations in it, and every chat ordered by its last line,
 * their own withheld lines counted: what it would be had nothing been withheld. Anyone else's, or a viewer with nothing
 * withheld, is the list as it is.
 */
export function listWithOwnWithheld<T extends ListedConversation>(viewer: string | undefined, listed: T[]): T[] {
    if (!viewer) return listed;
    const convs = db.prepare('SELECT * FROM withheld_conversations WHERE owner_pubkey = ?').all(viewer) as WithheldConversation[];
    // SQLite takes the bare column from the row MAX() picked: the type of the newest one.
    const lastOwn = new Map((db.prepare(`SELECT conversation_id, MAX(timestamp) AS at, type FROM withheld_lines
                                          WHERE author_pubkey = ? GROUP BY conversation_id`).all(viewer) as { conversation_id: string; at: string; type: string }[])
        .map(r => [r.conversation_id, r]));
    if (convs.length === 0 && lastOwn.size === 0) return listed;

    const peer = db.prepare('SELECT public_key, callsign, avatar_url FROM members WHERE public_key = ?');
    const added = convs.map(c => {
        const p = peer.get(c.other_pubkey) as { public_key: string; callsign: string | null; avatar_url: string | null } | undefined;
        return {
            id: c.id, type: 'dm', postId: null, postTitle: null, postStatus: 'active', postPhoto: null,
            lastMsgType: null, lastSysType: null, name: null, createdBy: c.owner_pubkey, createdAt: c.created_at,
            participants: [c.owner_pubkey, c.other_pubkey],
            peerCallsign: p?.callsign ?? undefined, peerAvatar: p ? avatarUrlFor(p.public_key, p.avatar_url) : null,
            peerLastReadAt: null, myLastReadAt: c.owner_last_read_at ?? null,
        } as unknown as T;
    });
    const lastLine = db.prepare('SELECT MAX(timestamp) AS at FROM messages WHERE conversation_id = ?');
    const entries = [...listed, ...added].map((c, place) => {
        const real = (lastLine.get(c.id) as { at: string | null }).at;
        const own = lastOwn.get(c.id);
        if (own && (!real || own.at > real)) return { c: { ...c, lastMsgType: own.type, lastSysType: null } as T, at: own.at as string | null, place };
        return { c, at: real, place };
    });
    // As the engine orders them: by the last line, newest first, then those with none, newest first; ties keep their place.
    entries.sort((x, y) => {
        if (x.at && y.at) return x.at === y.at ? x.place - y.place : (x.at > y.at ? -1 : 1);
        if (x.at || y.at) return x.at ? -1 : 1;
        const [cx, cy] = [x.c.createdAt ?? '', y.c.createdAt ?? ''];
        return cx === cy ? x.place - y.place : (cx > cy ? -1 : 1);
    });
    return entries.map(e => e.c);
}

// ── the sender's account ────────────────────────────────────────────────────────────────────────────────────────

/** A prune or a self-deletion: their withheld lines and conversations go. Withheld from them, nothing is theirs. */
export function dropWithheldOf(publicKey: string): void {
    const keys = (db.prepare('SELECT storage_key FROM withheld_lines WHERE author_pubkey = ? AND storage_key IS NOT NULL').all(publicKey) as { storage_key: string }[])
        .map(r => r.storage_key);
    db.prepare('DELETE FROM withheld_lines WHERE author_pubkey = ?').run(publicKey);
    // Their photos' objects, once the rows are gone for good (after the caller's transaction commits).
    if (keys.length > 0) afterTransactionCommit(() => deleteStoredObjects(db, keys));
    db.prepare('DELETE FROM withheld_conversations WHERE owner_pubkey = ?').run(publicKey);
    db.prepare('DELETE FROM withheld_overlays WHERE author_pubkey = ?').run(publicKey);
}
