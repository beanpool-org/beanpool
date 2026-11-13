// Reporting one line of a direct message (R0: scratch/fable-design/DESIGN-reaching-across-fable.md §3 and §6 item 5), on a
// group line's pattern (engine/group-chat-report.ts): one row in abuse_reports, target_message_id naming the line and
// disclosure holding what the reporter handed over. core's dm-line-report.ts says what that is and what it proves.
//
// The node never opens the line and holds no key for it. Its one check is the sender's signature, which a format-4 line
// carries in its ciphertext column beside the sealed bytes (core dm-crypto.ts), checked when a report is taken and again
// when a moderator reads it, from what is stored, so a stored flag can't stand in for it.
//
// What a report stands on:
// - A signature that verifies needs no row. The sealed line is kept as handed over, with the report, so a sender who edits
//   or deletes the line, or cancels the request, takes back nothing once it is reported, nor from a copy the reporter still
//   holds. An app holding only the tombstone has nothing to hand over: Report on a request then blocks, and reports the
//   person (POST /api/reports) with no line. S2.5's lines, which no node keeps, report the same way.
// - A handed line whose signature doesn't verify: the line must be the node's own encrypted row, and the node's copy is
//   what is kept, so a reporter's bytes their sender never signed are never filed as the line. The node's copy with a
//   signature that fails reads as such.
// - A voice part kept with a report (submitDmLineReport) is held to the gates a stored voice line is: its reporter's day of
//   photo bytes and the free-disk floor, refused in the send path's words with nothing filed. Its signature alone doesn't
//   need the line to be stored, and a report is kept for good, so this is the one limit on what a pair can file that way.
//
// Who may report a line: the other person in a direct conversation it is in, and only that line. Anything else answers as
// an id nobody has (GROUP_LINE_REPORT_NOT_FOUND), a conversation they are not in included.

import crypto from 'node:crypto';
import path from 'node:path';
import { DM_LINE_DISCLOSURE_KIND, dmLineDisclosureOf, dmLineKind, dmLineSigOf, dmLineSignedBy, type DmLineDisclosure } from '@beanpool/core';
import { isNodeMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { verifiedFormerKeysReader } from './key-succession.js';
import { GROUP_LINE_REPORT_NOT_FOUND, GROUP_LINE_REPORT_OWN, GroupLineReportError, type GroupLineReport } from './group-chat-report.js';
import { requestReceived, wordingOf } from './request-limits.js';
import { assertFolderFloorSpace, assertMayStorePhotoBytes, incomingPhotoBytes, recordStoredPhotoBytes } from './photo-upload-budget.js';

export const DM_LINE_REPORT_FORM = 'A report of a direct message names it, gives a reason and hands over the line: { messageId, reason, disclosure }.';

const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A report the route may file: the line it names, who wrote it, and what is kept. */
export interface CheckedDmLineReport {
    messageId: string;
    authorPubkey: string;
    reason: string;
    disclosure: DmLineDisclosure;
}

interface LineRow {
    id: string;
    conversation_id: string;
    author_pubkey: string | null;
    ciphertext: string;
    nonce: string | null;
    type: string;
    metadata: string | null;
    timestamp: string;
}

function lineRow(id: string): LineRow | undefined {
    return db.prepare('SELECT id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp FROM messages WHERE id = ?')
        .get(id) as LineRow | undefined;
}

/** The other person in a direct conversation `who` is in, or null: for anything else, an id nobody has. */
function otherIn(conversationId: string, who: string): string | null {
    if (!db.prepare("SELECT 1 FROM conversations WHERE id = ? AND type = 'dm'").get(conversationId)) return null;
    const keys = (db.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ?').all(conversationId) as { public_key: string }[])
        .map(r => r.public_key);
    if (keys.length !== 2 || !keys.includes(who)) return null;
    return keys.find(k => k !== who) ?? null;
}

/** A member's key and the ones it replaced by a re-key they attested: a line may be signed by, or to, any of them. */
function keysOf(formerKeysOf: ReturnType<typeof verifiedFormerKeysReader>, pubkey: string): string[] {
    return [pubkey, ...formerKeysOf(pubkey).map(k => k.pubkey)];
}

/**
 * Check a report before anything is filed: its form, then the line (the file header). Throws GroupLineReportError, as a
 * group line's check does, in the same words.
 */
export function checkDmLineReport(reporter: string, body: { messageId?: unknown; reason?: unknown; disclosure?: unknown }): CheckedDmLineReport {
    const { messageId, reason } = body;
    if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId) || typeof reason !== 'string' || !reason.trim()) {
        throw new GroupLineReportError(400, 'report_form', DM_LINE_REPORT_FORM);
    }
    const handed = dmLineDisclosureOf(body.disclosure);
    if (!handed) throw new GroupLineReportError(400, 'disclosure_form', DM_LINE_REPORT_FORM);
    const id = messageId.toLowerCase();
    const notFound = () => new GroupLineReportError(404, 'not_found', GROUP_LINE_REPORT_NOT_FOUND);
    const row = lineRow(id);
    const conversationId = row?.conversation_id ?? handed.conversationId;
    const other = otherIn(conversationId, reporter);
    if (!other) throw notFound();
    if (row?.author_pubkey === reporter) throw new GroupLineReportError(400, 'own_message', GROUP_LINE_REPORT_OWN);
    if (row && row.author_pubkey !== other) throw notFound();
    const kind = row ? dmLineKind({ authorPubkey: row.author_pubkey ?? '', nonce: row.nonce, type: row.type, metadata: row.metadata }) : null;
    if (kind && kind !== 'encrypted' && kind !== 'tombstone') throw notFound();
    const formerKeysOf = verifiedFormerKeysReader();
    const to = { conversationId, metadata: row?.metadata, recipients: keysOf(formerKeysOf, reporter), messageId: id };
    const signers = keysOf(formerKeysOf, other);
    const handedSigned = dmLineSignedBy(handed, to, signers);
    const stored = kind === 'encrypted' ? { ciphertext: row!.ciphertext, nonce: row!.nonce as string } : null;
    const sealed = handedSigned ? handed : stored;
    if (!sealed) throw notFound();
    const signed = handedSigned ?? dmLineSignedBy(sealed, to, signers);
    // A voice line's sealed voice part, handed over beside it, is kept only when its sender signed it to the reporter as
    // this message's voice part: else it is left out, as bytes their sender never signed are never filed as the line.
    const voice = handed.voice && dmLineSignedBy(handed.voice, to, signers, 'voice') ? handed.voice : undefined;
    return {
        messageId: id, authorPubkey: other, reason,
        disclosure: {
            v: 1, ciphertext: sealed.ciphertext, nonce: sealed.nonce, conversationId: signed?.conversationId ?? conversationId, words: handed.words,
            ...(voice ? { voice: { ciphertext: voice.ciphertext, nonce: voice.nonce } } : {}),
        },
    };
}

/**
 * File a checked report: one row naming the line, its author and what was handed over, and the request it reports, if its
 * reporter received one from them (engine/request-limits.ts). Null for a key that is no member's.
 *
 * A voice part kept with it is held where a stored voice line is (engine/messaging.ts sendMessage): counted in its reporter's
 * day of photo bytes, and refused below the free-disk floor, as PhotoBudgetExceededError (429) or StorageNearlyFullError
 * (507), the send path's own answers, with nothing filed. The row lands in this server's database, on its own disk whatever
 * store keeps the photos (IMAGE_STORE=s3 skips the image store's floor), so that disk's floor is checked too. A report with no
 * voice part meets neither.
 */
export function submitDmLineReport(reporter: string, checked: CheckedDmLineReport): GroupLineReport | null {
    if (!isNodeMember(db, reporter)) return null;
    const voice = checked.disclosure.voice;
    const voiceBytes = voice ? incomingPhotoBytes(voice.ciphertext) : 0;
    if (voice) {
        assertFolderFloorSpace(path.dirname(db.name));
        assertMayStorePhotoBytes(reporter, voiceBytes);
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const reason = checked.reason.slice(0, 500);
    const request = requestReceived(reporter, checked.authorPubkey, true);
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason, created_at, request_conversation_id, request_wording)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, reporter, checked.authorPubkey, checked.messageId,
        JSON.stringify({ kind: DM_LINE_DISCLOSURE_KIND, ...checked.disclosure }), reason, createdAt, request, request ? wordingOf(checked.disclosure.words) : null);
    recordStoredPhotoBytes(reporter, voiceBytes);
    return { id, reporterPubkey: reporter, targetPubkey: checked.authorPubkey, targetMessageId: checked.messageId, reason, createdAt, status: 'pending' };
}

/** A reported line as the moderators read it. S2.6 adds a words state of 'verified'; a v1 report has only the reporter's word. */
export interface ReportedDmLine {
    kind: 'dm';
    id: string;
    /** When the node took the line, while it has it. */
    sentAt: string | null;
    /** When its sender signed it, by their own clock. */
    signedAt: string | null;
    authorPubkey: string;
    authorCallsign: string | null;
    /** The key whose signature verified, or null. */
    signer: string | null;
    /**
     * 'verified': that key signed this sealed line, to the reporter. 'unsigned': it carries no signature in its column (a line
     * of a format before 4, sent before the 1.4.0 cutover: whatever a 1.3.x app sent beside it is not read). 'unverified': it
     * carries one that doesn't verify.
     */
    signature: 'verified' | 'unsigned' | 'unverified';
    /** Always the reporter's own account of the line: nothing here proves the words. */
    words: { state: 'reported'; text: string };
    /** The line had a photo. It stays sealed: no key for it was handed over. */
    photo: boolean;
    /**
     * A voice line's voice part, kept with the report when its reporter handed it over and its sender's signature verified
     * (checked again here, as the words' is): who sent it to the reporter and when, by their own clock. It stays sealed: no
     * key for it was handed over. Null when none was kept.
     */
    voice: { signature: 'verified' | 'unverified'; signedAt: string | null } | null;
    /** The line now: as reported, changed since (an edit), or gone (deleted, or a request withdrawn). */
    line: 'same' | 'changed' | 'gone';
}

/** The DM line a report names, from what its reporter handed over, its signature checked again. Null for any other report. */
export function openReportedDmLine(reportId: string): ReportedDmLine | null {
    const report = db.prepare('SELECT reporter_pubkey, target_pubkey, target_message_id, disclosure FROM abuse_reports WHERE id = ?').get(reportId) as
        { reporter_pubkey: string; target_pubkey: string; target_message_id: string | null; disclosure: string | null } | undefined;
    if (!report?.target_message_id || !report.disclosure) return null;
    let stored: any;
    try { stored = JSON.parse(report.disclosure); } catch { return null; }
    if (stored?.kind !== DM_LINE_DISCLOSURE_KIND) return null;
    const handed = dmLineDisclosureOf(stored);
    if (!handed) return null;
    const row = lineRow(report.target_message_id);
    const formerKeysOf = verifiedFormerKeysReader();
    const signed = dmLineSignedBy(handed, {
        conversationId: handed.conversationId, metadata: row?.metadata, recipients: keysOf(formerKeysOf, report.reporter_pubkey), messageId: report.target_message_id,
    }, keysOf(formerKeysOf, report.target_pubkey));
    const lineSig = dmLineSigOf(handed.ciphertext);
    const voiceSigned = handed.voice ? dmLineSignedBy(handed.voice, {
        conversationId: handed.conversationId, metadata: row?.metadata, recipients: keysOf(formerKeysOf, report.reporter_pubkey), messageId: report.target_message_id,
    }, keysOf(formerKeysOf, report.target_pubkey), 'voice') : null;
    const voice = handed.voice
        ? { signature: voiceSigned ? 'verified' as const : 'unverified' as const, signedAt: voiceSigned ? dmLineSigOf(handed.voice.ciphertext)?.at ?? null : null }
        : null;
    const member = db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(report.target_pubkey) as { callsign: string | null } | undefined;
    const gone = !row || row.type === 'removed';
    return {
        kind: 'dm', id: report.target_message_id, sentAt: row?.timestamp ?? null, signedAt: signed ? lineSig?.at ?? null : null,
        authorPubkey: report.target_pubkey, authorCallsign: member?.callsign ?? null, signer: signed?.signer ?? null,
        signature: signed ? 'verified' : lineSig ? 'unverified' : 'unsigned',
        words: { state: 'reported', text: handed.words }, photo: row?.type === 'image', voice,
        line: gone ? 'gone' : row.ciphertext === handed.ciphertext && row.nonce === handed.nonce ? 'same' : 'changed',
    };
}
