// Voice messages on the node (slice V2: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §5.4, §11 V2).
//
// A voice line is a line of type 'voice' with one attachment: its voice part, sealed by the sender's app as bytes under the
// keys a photo uses (core voice.ts, dm-crypto.ts sealDmVoice, group-crypto.ts sealGroupVoice). The node never opens it. It
// checks, without a key, what a photo is checked for and two things more: the attachment is marked VOICE_MIME and is at
// most VOICE_SEALED_MAX_BYTES of base64 as sent. Anything else is refused and nothing is stored. A photo line can't carry a
// part marked VOICE_MIME, so no voice part is ever kept as a photo, which would never expire.
//
// Kept where a photo is: message_attachments and the image store, counted in the member's day of photo bytes and held to
// the storage floor (engine/photo-upload-budget.ts), copied to a standby and kept in a backup as a chat photo is (a plain
// table, engine/replication-manifest.ts message_attachments, gap G4).
//
// Kept VOICE_SERVER_KEEP_DAYS on the server, then deleted there (expireVoiceOnce, daily on the main server): the
// attachment row goes with a tombstone, as a deleted photo's does, so a standby deletes its row and its object too; the
// object goes after the delete commits. The line stays, so the chat still shows the bubble, and the part's read answers
// 410 with VOICE_EXPIRED_CODE. A line kept for its sender alone (engine/withheld-lines.ts) loses its part on the same day,
// so its sender reads the same answer and learns nothing from it. A line under a pending report keeps its part until the
// report is closed: a moderator hears what was reported.

import { VOICE_EXPIRED_CODE, VOICE_MIME, VOICE_SEALED_MAX_BYTES, VOICE_SERVER_KEEP_DAYS } from '@beanpool/core';
import { afterTransactionCommit, db, writeTombstone } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { deleteStoredObjects } from '../storage/image-columns.js';

/** A voice line's type, as `messages.type` and `withheld_lines.type` store it. */
export const VOICE_LINE_TYPE = 'voice';
export const VOICE_LINE_FORM = "A voice line is sent as type 'voice' with its sealed voice part as its attachment, marked audio/mp4.";
export const VOICE_TOO_LARGE = 'This voice message is too large to send.';
/** What a voice part's read answers once the server no longer keeps it (with VOICE_EXPIRED_CODE, status 410). */
export const VOICE_EXPIRED_ERROR = 'This voice message is no longer on the server.';
export { VOICE_EXPIRED_CODE };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a line's attachment is refused: the code a route answers with, and its words. Null when it may be stored. */
export interface VoiceLineRefusal { code: 'voice_line_form' | 'voice_too_large'; message: string }

/**
 * The keyless check of a line's voice part, before anything is stored. A line of type 'voice' carries an attachment
 * { data, nonce, mime } whose mime is exactly VOICE_MIME and whose `data` is at most VOICE_SEALED_MAX_BYTES characters; any
 * other line's attachment is never marked VOICE_MIME. The sealed form of `data` and `nonce` is each chat's own check (a
 * direct line's format 4, a group line's prefix), made beside this one.
 */
export function voiceLineRefusal(type: unknown, attachment: unknown): VoiceLineRefusal | null {
    const form: VoiceLineRefusal = { code: 'voice_line_form', message: VOICE_LINE_FORM };
    const a = attachment && typeof attachment === 'object' && !Array.isArray(attachment) ? attachment as { data?: unknown; nonce?: unknown; mime?: unknown } : null;
    if (type !== VOICE_LINE_TYPE) return a?.mime === VOICE_MIME ? form : null;
    if (!a || typeof a.data !== 'string' || !a.data || typeof a.nonce !== 'string' || !a.nonce || a.mime !== VOICE_MIME) return form;
    if (a.data.length > VOICE_SEALED_MAX_BYTES) return { code: 'voice_too_large', message: VOICE_TOO_LARGE };
    return null;
}

/** The moment before which a voice line's part is no longer kept, as `messages.timestamp` writes it. */
export function voiceKeptSince(now = Date.now()): string {
    return new Date(now - VOICE_SERVER_KEEP_DAYS * DAY_MS).toISOString();
}

/** What one expiry pass did. */
export interface VoiceExpiryPass { expired: number; withheld: number; heldForReport: number; objects: number }

/** Lines a pending report names: their part is kept until the report is closed. */
const UNDER_PENDING_REPORT = `EXISTS (SELECT 1 FROM abuse_reports r WHERE r.target_message_id = m.id AND (r.status = 'pending' OR r.status IS NULL))`;

/**
 * Delete the voice parts the server no longer keeps (VOICE_SERVER_KEEP_DAYS): each stored voice line's attachment row, with
 * a tombstone a standby follows, and each withheld voice line's part; then their objects, once the rows are gone. The lines
 * stay. At most `limit` of each a pass. Idempotent: a part already gone is not counted again.
 */
export function expireVoiceOnce(now = Date.now(), limit = 500): VoiceExpiryPass {
    const since = voiceKeptSince(now);
    const due = db.prepare(`SELECT a.message_id, a.storage_key FROM message_attachments a JOIN messages m ON m.id = a.message_id
        WHERE m.type = ? AND m.timestamp < ? AND NOT ${UNDER_PENDING_REPORT} ORDER BY m.timestamp LIMIT ?`)
        .all(VOICE_LINE_TYPE, since, limit) as { message_id: string; storage_key: string | null }[];
    const heldForReport = (db.prepare(`SELECT COUNT(*) AS n FROM message_attachments a JOIN messages m ON m.id = a.message_id
        WHERE m.type = ? AND m.timestamp < ? AND ${UNDER_PENDING_REPORT}`).get(VOICE_LINE_TYPE, since) as { n: number }).n;
    const withheld = db.prepare(`SELECT w.id, w.storage_key FROM withheld_lines w
        WHERE w.type = ? AND w.timestamp < ? AND (w.attachment_data IS NOT NULL OR w.storage_key IS NOT NULL) ORDER BY w.timestamp LIMIT ?`)
        .all(VOICE_LINE_TYPE, since, limit) as { id: string; storage_key: string | null }[];
    const keys: string[] = [];
    db.transaction(() => {
        const drop = db.prepare('DELETE FROM message_attachments WHERE message_id = ?');
        for (const r of due) {
            if (drop.run(r.message_id).changes === 0) continue;
            writeTombstone('message_attachments', r.message_id);
            if (r.storage_key) keys.push(r.storage_key);
        }
        const clear = db.prepare(`UPDATE withheld_lines SET attachment_data = NULL, attachment_nonce = NULL, attachment_mime = NULL,
            storage_key = NULL WHERE id = ?`);
        for (const w of withheld) {
            clear.run(w.id);
            if (w.storage_key) keys.push(w.storage_key);
        }
        // Every serving path reads the row first, so the objects go once no row names them.
        if (keys.length) afterTransactionCommit(() => deleteStoredObjects(db, keys));
    })();
    return { expired: due.length, withheld: withheld.length, heldForReport, objects: keys.length };
}

/**
 * Whether `id` is a voice line whose part the server no longer keeps, as `who` may read it: a stored voice line with no
 * attachment row, or `who`'s own withheld voice line with no part. The caller has checked that `who` may read the line.
 */
export function voicePartExpired(id: string, row: { type: string } | undefined): boolean {
    if (row?.type !== VOICE_LINE_TYPE) return false;
    return !db.prepare('SELECT 1 FROM message_attachments WHERE message_id = ?').get(id);
}

const VOICE_EXPIRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VOICE_EXPIRY_FIRST_DELAY_MS = 10 * 60 * 1000;
let expiryTimer: NodeJS.Timeout | null = null;

/**
 * Run the expiry every six hours on the main server, the first ten minutes after boot. A standby runs none: it deletes
 * what its main server's tombstones name. Never holds the process open.
 */
export function startVoiceExpiry(): void {
    if (expiryTimer) return;
    const tick = (delay: number) => {
        expiryTimer = setTimeout(() => {
            expiryTimer = null;
            let next = VOICE_EXPIRY_INTERVAL_MS;
            try {
                if (getNodeRole() === 'primary') {
                    const pass = expireVoiceOnce();
                    if (pass.expired + pass.withheld > 0) {
                        console.log(`🎤 [VoiceExpiry] ${pass.expired + pass.withheld} voice message(s) past ${VOICE_SERVER_KEEP_DAYS} days deleted from the server; ${pass.heldForReport} kept for a pending report.`);
                    }
                    // A full batch: the rest soon, not in six hours.
                    if (pass.expired >= 500 || pass.withheld >= 500) next = 60 * 1000;
                }
            } catch (e) {
                console.warn('[VoiceExpiry] A pass failed; the next one tries again:', e);
            }
            tick(next);
        }, delay);
        expiryTimer.unref?.();
    };
    tick(VOICE_EXPIRY_FIRST_DELAY_MS);
}
