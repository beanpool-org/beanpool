// Reporting one line of a direct message (R0: scratch/fable-design/DESIGN-reaching-across-fable.md §3 and §6 item 5), on a
// group line's pattern (engine/group-chat-report.ts): one row in abuse_reports, target_message_id naming the line and
// disclosure holding what the reporter handed over. core's dm-line-report.ts says what that is and what it proves.
//
// The node never opens the line and holds no key for it. Its one check is the sender's signature, made when a report is
// taken and again when a moderator reads it, from what is stored, so a stored flag can't stand in for it.
//
// What a report stands on:
// - A signature that verifies needs no row. The sealed line is kept as handed over, with the report, so a sender who edits
//   or deletes the line, or cancels the request, takes back nothing once it is reported, nor from a copy the reporter still
//   holds. An app holding only the tombstone has nothing to hand over: Report on a request then blocks, and reports the
//   person (POST /api/reports) with no line. S2.5's lines, which no node keeps, report the same way.
// - With none, the line must be the node's own encrypted row, and the node's copy is what is kept: a reporter's bytes that
//   nobody signed are never filed as the line. The node's copy with a signature that fails reads as such.
//
// Who may report a line: the other person in a direct conversation it is in, and only that line. Anything else answers as
// an id nobody has (GROUP_LINE_REPORT_NOT_FOUND), a conversation they are not in included.

import crypto from 'node:crypto';
import {
    DM_LINE_DISCLOSURE_KIND, DM_LINE_SIG_KEY, dmLineDisclosureOf, dmLineKind, dmLineSigInMetadata, dmLineSigOf, dmLineSignedBy,
    type DmLineDisclosure,
} from '@beanpool/core';
import { isNodeMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { verifiedFormerKeysReader } from './key-succession.js';
import { GROUP_LINE_REPORT_NOT_FOUND, GROUP_LINE_REPORT_OWN, GroupLineReportError, type GroupLineReport } from './group-chat-report.js';
import { requestReceived, wordingOf } from './request-limits.js';

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
    const handedSigned = dmLineSignedBy(handed, handed.lineSig, to, signers);
    const stored = kind === 'encrypted' ? { ciphertext: row!.ciphertext, nonce: row!.nonce as string, lineSig: dmLineSigInMetadata(row!.metadata) } : null;
    const sealed = handedSigned ? handed : stored;
    if (!sealed) throw notFound();
    const signed = handedSigned ?? dmLineSignedBy(sealed, sealed.lineSig, to, signers);
    return {
        messageId: id, authorPubkey: other, reason,
        disclosure: {
            v: 1, ciphertext: sealed.ciphertext, nonce: sealed.nonce, conversationId: signed?.conversationId ?? conversationId,
            lineSig: sealed.lineSig, words: handed.words,
        },
    };
}

/**
 * File a checked report: one row naming the line, its author and what was handed over, and the request it reports, if its
 * reporter received one from them (engine/request-limits.ts). Null for a key that is no member's.
 */
export function submitDmLineReport(reporter: string, checked: CheckedDmLineReport): GroupLineReport | null {
    if (!isNodeMember(db, reporter)) return null;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const reason = checked.reason.slice(0, 500);
    const request = requestReceived(reporter, checked.authorPubkey, true);
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason, created_at, request_conversation_id, request_wording)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, reporter, checked.authorPubkey, checked.messageId,
        JSON.stringify({ kind: DM_LINE_DISCLOSURE_KIND, ...checked.disclosure }), reason, createdAt, request, request ? wordingOf(checked.disclosure.words) : null);
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
     * 'verified': that key signed this sealed line, to the reporter. 'unsigned': it has no signature (an app from before
     * them). 'unverified': the node's copy has one that doesn't verify.
     */
    signature: 'verified' | 'unsigned' | 'unverified';
    /** Always the reporter's own account of the line: nothing here proves the words. */
    words: { state: 'reported'; text: string };
    /** The line had a photo. It stays sealed: no key for it was handed over. */
    photo: boolean;
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
    const signed = dmLineSignedBy(handed, handed.lineSig, {
        conversationId: handed.conversationId, metadata: row?.metadata, recipients: keysOf(formerKeysOf, report.reporter_pubkey), messageId: report.target_message_id,
    }, keysOf(formerKeysOf, report.target_pubkey));
    const member = db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(report.target_pubkey) as { callsign: string | null } | undefined;
    const gone = !row || row.type === 'removed';
    return {
        kind: 'dm', id: report.target_message_id, sentAt: row?.timestamp ?? null, signedAt: signed ? handed.lineSig?.at ?? null : null,
        authorPubkey: report.target_pubkey, authorCallsign: member?.callsign ?? null, signer: signed?.signer ?? null,
        signature: signed ? 'verified' : handed.lineSig ? 'unverified' : 'unsigned',
        words: { state: 'reported', text: handed.words }, photo: row?.type === 'image',
        line: gone ? 'gone' : row.ciphertext === handed.ciphertext && row.nonce === handed.nonce ? 'same' : 'changed',
    };
}

/**
 * A DM line's metadata once it is edited: the new sealed bytes' signature in place of the old one, which covers bytes the
 * line no longer has. An app from before signatures sends none, so the line goes on with none, and reports as unsigned
 * rather than as a signature that fails. `sent` is what the edit route took.
 */
export function metadataAfterDmEdit(stored: string | null, sent: unknown): string | null {
    let meta: Record<string, unknown> = {};
    try {
        const parsed = stored ? JSON.parse(stored) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return stored;
        meta = parsed;
    } catch {
        return stored;
    }
    const lineSig = dmLineSigOf((sent as Record<string, unknown> | null | undefined)?.[DM_LINE_SIG_KEY]);
    if (lineSig) meta[DM_LINE_SIG_KEY] = lineSig;
    else delete meta[DM_LINE_SIG_KEY];
    return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
}
