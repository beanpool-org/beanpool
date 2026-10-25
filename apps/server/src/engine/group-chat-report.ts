// Reporting one message of a locked group chat, with its key (group chat photos S6: scratch/fable-design/
// DESIGN-group-chat-photos-fable.md §5 S6; the encryption design §13, never built before).
//
// In an end-to-end encrypted group the operators otherwise have only the reporter's word. The reporter's app hands over
// that one message's own key (core groupMessageKey, HKDF of the epoch key and the message id, encryption design §7.1),
// which opens that message's words and its photo and nothing else: every other line has another key. The node keeps the
// key with the report (abuse_reports.disclosure, copied to a standby with the row) and opens nothing when it takes one.
// The moderators' view opens the line from what the node stores, with core's openGroupLineWithMessageKey, and checks the
// inner signature against the key that signed it: a forged key, a line the node re-attributed or altered, or a swapped
// photo reads "could not be verified", never as the author's words.
//
// Who may report a line: whoever may read it, by the chat's own bar (groupChatRole + groupLineForReader, as its words and
// its photo are served). Anything else, and any line that is no sealed member's line, answers as an id nobody has.

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { isNodeMember } from '@beanpool/engine';
import { isGroupEncryptedNonce, openGroupLineWithMessageKey, type GroupLineBinding, type GroupLinePart } from '@beanpool/core';
import { GROUP_THREAD_TYPE, groupChatRole, groupLineForReader } from './group-thread.js';
import { fromEpochOf } from './group-keys.js';
import { attachmentDataOfAsync, type AttachmentRow } from '../storage/image-columns.js';
import { getImageStore } from '../storage/image-store.js';

/** The one answer for a line the reporter may not report, whatever the reason: an id nobody has says no more. */
export const GROUP_LINE_REPORT_NOT_FOUND = 'Message not found';
export const GROUP_LINE_REPORT_OWN = 'You cannot report your own message.';
export const GROUP_LINE_REPORT_FORM = "A report of a message names it, gives a reason and hands over its key: { messageId, reason, disclosure: { epoch, mk } }.";
export const GROUP_LINE_REPORT_EPOCH = "The key handed over is for another epoch than the message's.";

/** A refusal, with the status and code the route answers. */
export class GroupLineReportError extends Error {
    constructor(readonly status: 400 | 404, readonly code: string, message: string) {
        super(message);
        this.name = 'GroupLineReportError';
    }
}

/** What a reporter hands over for one message: its epoch and its own key, 32 bytes as base64 (core groupMessageKey). */
export interface GroupLineDisclosure { epoch: number; mk: string }

/** A report of one group chat message, as the reporter's app and the Reports queue read it. */
export interface GroupLineReport {
    id: string;
    reporterPubkey: string;
    targetPubkey: string;
    targetMessageId: string;
    reason: string;
    createdAt: string;
    status: string;
}

/** A report the route may file: the line it names (one the reporter may read), its author, and what was handed over. */
export interface CheckedGroupLineReport {
    messageId: string;
    authorPubkey: string;
    reason: string;
    disclosure: GroupLineDisclosure;
}

const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUB_HEX = /^[0-9a-f]{64}$/;
const PHOTO_DATA_URI = /^data:image\/[a-z0-9.+-]+;base64,/i;

/** The disclosure's shape: a whole epoch and exactly 32 bytes of strict base64. Null for anything else. */
export function disclosureOf(v: unknown): GroupLineDisclosure | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const { epoch, mk } = v as { epoch?: unknown; mk?: unknown };
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0 || typeof mk !== 'string') return null;
    const key = Buffer.from(mk, 'base64');
    if (key.length !== 32 || key.toString('base64') !== mk) return null;
    return { epoch, mk };
}

function metadataOf(metadata: unknown): Record<string, any> {
    try {
        const m = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
        return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    } catch {
        return {};
    }
}

function epochIn(meta: Record<string, any>): number | null {
    return typeof meta.epoch === 'number' && Number.isSafeInteger(meta.epoch) ? meta.epoch : null;
}

/**
 * Check a report before anything is filed: its form, then the line, which must be a sealed member's line of this group's
 * chat that the reporter may read now, and not their own; the disclosure must be under the line's own epoch (an edit keeps
 * it: group-thread.ts groupChatEdit). Throws GroupLineReportError. The disclosure is never opened here.
 */
export function checkGroupLineReport(groupId: string, reporter: string, body: { messageId?: unknown; reason?: unknown; disclosure?: unknown }): CheckedGroupLineReport {
    const { messageId, reason } = body;
    if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId) || typeof reason !== 'string' || !reason.trim()) {
        throw new GroupLineReportError(400, 'report_form', GROUP_LINE_REPORT_FORM);
    }
    const disclosure = disclosureOf(body.disclosure);
    if (!disclosure) throw new GroupLineReportError(400, 'disclosure_form', GROUP_LINE_REPORT_FORM);
    const id = messageId.toLowerCase();
    const notFound = () => new GroupLineReportError(404, 'not_found', GROUP_LINE_REPORT_NOT_FOUND);
    if (!groupChatRole(groupId, reporter)) throw notFound();
    const line = db.prepare(`SELECT m.id, m.author_pubkey, m.type, m.system_type, m.metadata, m.nonce FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = ? AND m.conversation_id = ? AND c.type = ?`).get(id, groupId, GROUP_THREAD_TYPE) as
        { id: string; author_pubkey: string | null; type: string; system_type: string | null; metadata: string | null; nonce: string | null } | undefined;
    if (!line || line.system_type || (line.type !== 'text' && line.type !== 'image') || !isGroupEncryptedNonce(line.nonce)) throw notFound();
    const epoch = epochIn(metadataOf(line.metadata));
    if (epoch === null || !groupLineForReader(line.metadata, fromEpochOf(groupId, reporter))) throw notFound();
    if (!line.author_pubkey || !db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(line.author_pubkey)) throw notFound();
    if (line.author_pubkey === reporter) throw new GroupLineReportError(400, 'own_message', GROUP_LINE_REPORT_OWN);
    if (disclosure.epoch !== epoch) throw new GroupLineReportError(400, 'disclosure_epoch', GROUP_LINE_REPORT_EPOCH);
    return { messageId: id, authorPubkey: line.author_pubkey, reason, disclosure };
}

function reportOfRow(r: any): GroupLineReport {
    return {
        id: r.id, reporterPubkey: r.reporter_pubkey, targetPubkey: r.target_pubkey, targetMessageId: r.target_message_id,
        reason: r.reason, createdAt: r.created_at, status: r.status || 'pending',
    };
}

/** The reporter's report of this message, whatever its status, or null: one report per reporter per message. */
export function groupLineReportOnFile(reporter: string, messageId: string): GroupLineReport | null {
    const r = db.prepare(`SELECT id, reporter_pubkey, target_pubkey, target_message_id, reason, created_at, status FROM abuse_reports
        WHERE reporter_pubkey = ? AND target_message_id = ? ORDER BY created_at ASC LIMIT 1`).get(reporter, messageId.toLowerCase());
    return r ? reportOfRow(r) : null;
}

/** A pending report given the reason its reporter picked on a repeat (a change to Child safety), or null once not pending. */
export function changeGroupLineReportReason(reportId: string, reason: string): GroupLineReport | null {
    const res = db.prepare(`UPDATE abuse_reports SET reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND target_message_id IS NOT NULL AND (status = 'pending' OR status IS NULL)`).run(reason.slice(0, 500), reportId);
    if (res.changes === 0) return null;
    return reportOfRow(db.prepare('SELECT id, reporter_pubkey, target_pubkey, target_message_id, reason, created_at, status FROM abuse_reports WHERE id = ?').get(reportId));
}

/** File a checked report: one row naming the line, its author and the key handed over. Null for a key that is no member's. */
export function submitGroupLineReport(reporter: string, checked: CheckedGroupLineReport): GroupLineReport | null {
    if (!isNodeMember(db, reporter)) return null;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const reason = checked.reason.slice(0, 500);
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, reporter, checked.authorPubkey, checked.messageId,
        JSON.stringify({ epoch: checked.disclosure.epoch, mk: checked.disclosure.mk }), reason, createdAt);
    return { id, reporterPubkey: reporter, targetPubkey: checked.authorPubkey, targetMessageId: checked.messageId, reason, createdAt, status: 'pending' };
}

/** A reported message as the moderators read it: only what its key opens, each part verified or not. */
export interface ReportedGroupLine {
    id: string;
    groupId: string | null;
    groupName: string | null;
    sentAt: string | null;
    editedAt: string | null;
    /** Who the node says wrote it (author_pubkey), and their name. */
    authorPubkey: string | null;
    authorCallsign: string | null;
    /** The key whose signature the words verified under, or null. */
    signer: string | null;
    /**
     * 'gone': deleted or removed since, so there is nothing left to open; `by` who, as the tombstone records it ('author':
     * its author's delete, their account's deletion included; 'convenor': a convenor's removal), null when not known.
     */
    words: { state: 'verified'; text: string } | { state: 'unverified' } | { state: 'gone'; by: 'author' | 'convenor' | null };
    /**
     * A photo line's photo, null for a text line. 'unavailable': this server holds no photo for it, as after a standby took
     * over (chat photos are not copied to a standby, gap G4).
     */
    photo: { state: 'verified'; dataUri: string } | { state: 'unverified' } | { state: 'unavailable' } | null;
}

/** Opened under this binding with the disclosed key, signed by `signer`: its text, or null. */
function opened(payload: { ciphertext: string; nonce: string }, binding: GroupLineBinding, mk: Uint8Array): string | null {
    try {
        return openGroupLineWithMessageKey(payload, binding, mk).text;
    } catch {
        return null;
    }
}

/**
 * The message a report is about, opened with the key its reporter handed over: its words (as an edit when it was edited),
 * tried as the key the node stored it under (metadata.sender) and then its author's, as both apps open a line; then, only
 * when the words verified, its photo under the same signer. Null for a report that names no message.
 */
export async function openReportedGroupLine(reportId: string): Promise<ReportedGroupLine | null> {
    const report = db.prepare('SELECT target_message_id, disclosure FROM abuse_reports WHERE id = ?').get(reportId) as
        { target_message_id: string | null; disclosure: string | null } | undefined;
    if (!report?.target_message_id) return null;
    const m = db.prepare(`SELECT m.id, m.conversation_id, m.author_pubkey, m.ciphertext, m.nonce, m.type, m.metadata, m.timestamp, m.edited_at,
            g.name AS group_name, mem.callsign AS author_callsign
        FROM messages m LEFT JOIN groups g ON g.id = m.conversation_id LEFT JOIN members mem ON mem.public_key = m.author_pubkey
        WHERE m.id = ?`).get(report.target_message_id) as any;
    const view: ReportedGroupLine = {
        id: report.target_message_id, groupId: m?.conversation_id ?? null, groupName: m?.group_name ?? null,
        sentAt: m?.timestamp ?? null, editedAt: m?.edited_at ?? null,
        authorPubkey: m?.author_pubkey ?? null, authorCallsign: m?.author_callsign ?? null,
        signer: null, words: { state: 'gone', by: null }, photo: null,
    };
    const meta = metadataOf(m?.metadata);
    if (m?.type === 'removed') {
        const by = meta.accountDeleted === true || (meta.removedBy && meta.removedBy === m.author_pubkey) ? 'author' : meta.removedBy ? 'convenor' : null;
        view.words = { state: 'gone', by };
        return view;
    }
    if (!m || !isGroupEncryptedNonce(m.nonce)) return view;
    const isPhoto = m.type === 'image';
    view.words = { state: 'unverified' };
    if (isPhoto) view.photo = { state: 'unverified' };
    let disclosure: GroupLineDisclosure | null = null;
    try { disclosure = disclosureOf(JSON.parse(report.disclosure ?? '')); } catch { disclosure = null; }
    const epoch = epochIn(meta);
    if (!disclosure || epoch === null) return view;
    const mk = new Uint8Array(Buffer.from(disclosure.mk, 'base64'));
    const replyToId = typeof meta.replyToId === 'string' && meta.replyToId ? meta.replyToId : null;
    const bound = (signer: string, part: GroupLinePart): GroupLineBinding => ({ groupId: m.conversation_id, epoch, senderPubHex: signer, messageId: m.id, part, replyToId });
    const candidates = [...new Set([meta.sender, m.author_pubkey].filter((k): k is string => typeof k === 'string' && PUB_HEX.test(k)))];
    for (const signer of candidates) {
        const text = opened({ ciphertext: m.ciphertext, nonce: m.nonce }, bound(signer, m.edited_at ? 'edit' : 'body'), mk);
        if (text === null) continue;
        view.signer = signer;
        view.words = { state: 'verified', text };
        break;
    }
    if (!isPhoto || !view.signer) return view;
    const att = db.prepare('SELECT data, nonce, mime, storage_key FROM message_attachments WHERE message_id = ?').get(m.id) as AttachmentRow | undefined;
    let data: string | null = null;
    try { data = att ? await attachmentDataOfAsync(att, getImageStore()) : null; } catch { data = null; }
    if (!att || !data) {
        view.photo = { state: 'unavailable' };
        return view;
    }
    const photo = opened({ ciphertext: data, nonce: att.nonce ?? '' }, bound(view.signer, 'attachment'), mk);
    view.photo = photo === null ? { state: 'unverified' } : PHOTO_DATA_URI.test(photo) ? { state: 'verified', dataUri: photo } : { state: 'unavailable' };
    return view;
}
