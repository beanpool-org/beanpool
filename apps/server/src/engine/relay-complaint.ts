/**
 * Reports of lines from other communities, and the complaints one community's server sends another's (messages across
 * communities X5: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.5, §7 "Moderation", §11 row X5;
 * DESIGN-cross-community-chat-fable.md §2.5; DESIGN-reaching-across-fable.md §3 "What a reporter hands over" and "the line
 * crosses, the authority does not"; DESIGN-forums-messaging-joint-fable.md §2.4). The mailbox itself is engine/relay-mail.ts
 * (receiving) and engine/relay-outbox.ts (sending).
 *
 * **A member here reports a line from another community** (`POST /api/mail/report`, member-signed): they hand over the
 * item as it crossed (the sender's signed relay envelope and the sealed format-4 line inside it, which their device kept)
 * and their word for what it says. This server checks that the envelope is its sender's and names the reporter, here, as
 * its recipient, and that the line inside is signed by the same sender to the reporter under the item's id: else 400
 * `line_not_verified`, nothing filed. Then it files one report (abuse_reports: the sender's key, `target_home` their home,
 * the line's id, what was handed over), blocks the sender for the reporter at this server's door (engine/member-blocks.ts),
 * and tells the sender's home. The line crosses; the authority does not: only the sender's home may act on its member.
 *
 * **The complaint** goes to `https://<sender home>/api/relay/complaint` in a request this server signs (engine/node-key.ts,
 * checked at the other end by engine/node-signature.ts). It is {@link ComplaintBody}: the member there, the line's id and
 * time, the report's kind and the reporter's word for the line. **It never names the reporter**: not their key, not their
 * name, not the conversation (made from their key), nor the sealed line, whose signatures bind their key. What ties it to
 * a real line is the home's own record: an item its member sent, by that id, to the community whose server signed the
 * complaint (relay_outbox, kept 30 days after its last change). The complaint is signed as this server's home now; the line
 * may have been addressed to another of its names (a former name after a rename, an alias), which it takes lines for all the
 * same (engine/node-key.ts isOwnNodeHome), and the home matches it by that name's key document (below). Told is `sent` only
 * at the home's 202, which it answers only for a complaint it has on file; a complaint the other server does not take at
 * once is tried again by the minute timer with the outbox's backoff for a day, and one it answers it will not take (422)
 * or refuses as not one (400, 413) is `failed`, its state kept beside the report (`told`).
 *
 * **At the sender's home** a complaint lands in Settings → Moderation beside the community's own reports, marked "from
 * another community": abuse_reports with `community:<home>` as its reporter (a community, never a person), the member,
 * the line's id, and `{"kind":"relay-complaint","from":<home>,...}` as its disclosure, which the reports queue never reads:
 * the moderators open its words with the message (GET /api/local/admin/reports/:id/message, {@link openReportedComplaint}).
 * The line is found by its sender and id (relay_outbox's own key), and it must have gone to the signing server: to its home
 * as signed, or to a name whose key document (engine/node-signature.ts, fetched as for the door) names the key that signed
 * the complaint, so a former name or an alias of the reporting server is one of its names here too, and no other server's.
 * Answered 202 `{received:true}` when filed or on file already from that community. Every drop is answered alike, 422
 * `not_taken`, whatever the reason (no line by that id from that member, a key that is no member here now, a line that went
 * to another server's name, the owner's switch off), so the reporting server learns only whether its complaint is on file,
 * never which of these it was; and it can ask only of lines it was sent (it needs the line's random id). Refused: a request
 * that is not one (400 bad_complaint), past COMPLAINTS_PER_ORIGIN_DAY from one server (429), and 503 while the name the
 * line went to can't be confirmed yet (its key document not had: try again later).
 *
 * **Counts, never names.** No log line here names a member or a reporter; the owners' notice is the reports' own
 * (services/alerts.ts noteNewReport: a kind and a count).
 */
import crypto from 'node:crypto';
import {
    dmLineSignedBy, readRelayEnvelope, relayConversationId, relayEnvelopeVerifies, relayPayloadHash, reportKind, word,
    OUTSIDE_LINE_TEXT_MAX, type RelayEnvelope, type ReportKind,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeRole, isNodeMember, readsAsMember } from '../state-engine.js';
import { addBlocks, BlockRefusal, hasBlocked } from './member-blocks.js';
import { isOwnNodeHome } from './node-key.js';
import { NODE_BUSY_RETRY_AFTER_SEC, keptNodeKeyDocument, originKeyStanding, type NodeOrigin } from './node-signature.js';
import { GroupLineReportError, type GroupLineReport } from './group-chat-report.js';
import { outsideMessagesOn, RELAY_LINE_MAX_CHARS } from './relay-mail.js';
import { RETRY_BACKOFF_MS, OUTBOX_QUEUE_MS, forwardSigned } from './relay-outbox.js';
import { logger } from '../logger.js';

/** The path a community's server brings complaints to (engine/node-signature.ts NODE_SIGNED_PATHS). */
export const RELAY_COMPLAINT_PATH = '/api/relay/complaint';
/** What a report of an outside line keeps as its disclosure, and a complaint from another community as its. */
export const OUTSIDE_LINE_DISCLOSURE_KIND = 'outside-line';
export const RELAY_COMPLAINT_DISCLOSURE_KIND = 'relay-complaint';
/** Complaints one community may bring in any 24 hours; past it, 429. */
export const COMPLAINTS_PER_ORIGIN_DAY = 100;
/** A complaint's reporter: the community it came from, `community:<home>`. Never a person; never a member key. */
export const COMPLAINT_REPORTER_PREFIX = 'community:';
const DAY_MS = 24 * 60 * 60_000;

export const OUTSIDE_REPORT_FORM = 'A report of a message from another community hands over the item as it came and says why: { item: { envelope, payload }, reason, words }.';
export const LINE_NOT_VERIFIED = word("This message couldn't be verified as its sender's, so it can't be reported.");

/** The report kinds a complaint carries: core's, never the reporter's own words beside the choice. */
const KINDS: readonly ReportKind[] = ['child safety', 'spam or scam', 'offensive content', 'misleading post', 'other'];
const KEY_HEX = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What crosses: the whole of it. Nothing here is the reporter's, but their word for what the line said. */
export interface ComplaintBody {
    v: 1;
    /** The complaint's own id, at the server that sends it: a repeat of it is the same complaint. */
    id: string;
    /** The member at the receiving home who sent the line. */
    member: string;
    /** The line's item id (its envelope's), and when its sender signed it, by their clock. */
    itemId: string;
    at: number;
    /** The report's kind (core reportKind). */
    reason: ReportKind;
    /** The reporter's word for what the line said: nothing proves it (v1 hands over no message key). */
    words: string;
}

// ── A member here reports a line from another community ─────────────────────────────────────

export interface CheckedOutsideLineReport {
    envelope: RelayEnvelope;
    payload: string;
    reason: string;
    words: string;
}

/** Whether `payload` is a format-4 line its envelope's sender signed to `reporter` under the item's id. */
function lineSignedBySender(env: RelayEnvelope, payload: string, reporter: string): boolean {
    let p: { v?: unknown; c?: unknown; n?: unknown; r?: unknown };
    try { p = JSON.parse(payload); } catch { return false; }
    if (!p || p.v !== 1 || typeof p.c !== 'string' || typeof p.n !== 'string') return false;
    if (p.r !== undefined && (typeof p.r !== 'string' || !p.r || p.r.length > 64)) return false;
    return !!dmLineSignedBy({ ciphertext: p.c, nonce: p.n }, {
        conversationId: relayConversationId(env.senderKey, reporter),
        metadata: typeof p.r === 'string' ? { replyToId: p.r } : undefined,
        recipients: [reporter], messageId: env.itemId,
    }, [env.senderKey]);
}

/**
 * Check a report of an outside line before anything is filed (the file header). Throws GroupLineReportError: 400
 * `report_form` for a body that is not one, 400 `line_not_verified` for a line that is not its sender's to this reporter.
 */
export function checkOutsideLineReport(reporter: string, body: { item?: unknown; reason?: unknown; words?: unknown } | undefined): CheckedOutsideLineReport {
    const { item, reason, words } = body ?? {};
    const raw = item as { envelope?: unknown; payload?: unknown } | null | undefined;
    if (typeof reason !== 'string' || !reason.trim() || typeof words !== 'string' || words.length > OUTSIDE_LINE_TEXT_MAX
        || !raw || typeof raw !== 'object' || typeof raw.payload !== 'string' || raw.payload.length > RELAY_LINE_MAX_CHARS) {
        throw new GroupLineReportError(400, 'report_form', OUTSIDE_REPORT_FORM);
    }
    const env = readRelayEnvelope(raw.envelope);
    const notVerified = () => new GroupLineReportError(400, 'line_not_verified', LINE_NOT_VERIFIED);
    if (!env || env.kind !== 'dm-line' || !UUID_V4.test(env.itemId)) throw notVerified();
    if (env.recipient !== reporter || env.senderKey === reporter || !isOwnNodeHome(env.recipientHome) || isOwnNodeHome(env.senderHome)) throw notVerified();
    if (relayPayloadHash(raw.payload) !== env.payloadHash || !relayEnvelopeVerifies(env)) throw notVerified();
    if (!lineSignedBySender(env, raw.payload, reporter)) throw notVerified();
    return { envelope: env, payload: raw.payload, reason, words };
}

/** Whether the sender's home has the complaint: still trying, on file there, or it will not be. */
export type ToldState = 'queued' | 'sent' | 'failed';
/** A report's `told`: whether the sender's home has the complaint yet. */
interface Told { state: ToldState; tries: number; next: number | null; id: string }

/**
 * File a checked report: one row (the sender's key, their home, the line's id, what was handed over, and the complaint's
 * state), the sender blocked for the reporter. Null for a reporter who is no member here.
 */
export function submitOutsideLineReport(reporter: string, checked: CheckedOutsideLineReport, now = Date.now()): GroupLineReport | null {
    if (!isNodeMember(reporter) || !readsAsMember(reporter)) return null;
    const env = checked.envelope;
    const id = crypto.randomUUID();
    const createdAt = new Date(now).toISOString();
    const reason = checked.reason.slice(0, 500);
    const told: Told = { state: 'queued', tries: 0, next: now, id: crypto.randomUUID() };
    db.transaction(() => {
        db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_home, target_message_id, disclosure, reason, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, reporter, env.senderKey, env.senderHome, env.itemId,
            JSON.stringify({ kind: OUTSIDE_LINE_DISCLOSURE_KIND, v: 1, envelope: env, payload: checked.payload, words: checked.words, told }), reason, createdAt);
        try {
            addBlocks(reporter, [env.senderKey], now);
        } catch (e) {
            // A full list (409) keeps the report: the member can block from their list once there is room.
            if (!(e instanceof BlockRefusal)) throw e;
        }
    })();
    return { id, reporterPubkey: reporter, targetPubkey: env.senderKey, targetMessageId: env.itemId, reason, createdAt, status: 'pending' };
}

// ── Telling the sender's home ───────────────────────────────────────────────────────────────

interface QueuedRow { id: string; target_pubkey: string; target_home: string; reason: string; disclosure: string }

/** The complaint a report of an outside line sends: what {@link ComplaintBody} says, and nothing else. */
function complaintOf(row: QueuedRow, told: Told): ComplaintBody | null {
    let d: { envelope?: RelayEnvelope; words?: unknown };
    try { d = JSON.parse(row.disclosure); } catch { return null; }
    const env = readRelayEnvelope(d.envelope);
    if (!env || typeof d.words !== 'string') return null;
    return { v: 1, id: told.id, member: row.target_pubkey, itemId: env.itemId, at: env.at, reason: reportKind(row.reason), words: d.words };
}

function setTold(reportId: string, told: Told): void {
    db.prepare(`UPDATE abuse_reports SET disclosure = json_set(disclosure, '$.told', json(?)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id = ?`).run(JSON.stringify(told), reportId);
}

function toldOf(disclosure: string): Told | null {
    try {
        const t = (JSON.parse(disclosure) as { told?: Told }).told;
        return t && typeof t.id === 'string' && (t.state === 'queued' || t.state === 'sent' || t.state === 'failed') ? t : null;
    } catch {
        return null;
    }
}

/** What the home answers for a complaint it will not take, whatever the reason (the file header): final, never `sent`. */
export const COMPLAINT_NOT_TAKEN_STATUS = 422;

/**
 * A complaint's state after the home's answer `status`: `sent` only at 202 (the home has it on file: no other answer, 2xx or
 * not, says so), `failed` at a refusal that is final (400, 413, 422) or past a day, else `queued` (tried again later).
 */
export function toldAfter(status: number, sinceCreated: number): ToldState {
    if (status === 202) return 'sent';
    if (status === 400 || status === 413 || status === COMPLAINT_NOT_TAKEN_STATUS || sinceCreated >= OUTBOX_QUEUE_MS) return 'failed';
    return 'queued';
}

/** One complaint to its home, and its state after ({@link toldAfter}). */
async function tell(row: QueuedRow, told: Told, createdAt: number): Promise<Told['state']> {
    const complaint = complaintOf(row, told);
    if (!complaint) {
        setTold(row.id, { ...told, state: 'failed', next: null });
        return 'failed';
    }
    const status = await forwardSigned(`https://${row.target_home}${RELAY_COMPLAINT_PATH}`, JSON.stringify({ complaint }));
    const at = Date.now();
    const tries = told.tries + 1;
    const state = toldAfter(status, at - createdAt);
    const next = state === 'queued' ? at + RETRY_BACKOFF_MS[Math.min(told.tries, RETRY_BACKOFF_MS.length - 1)] : null;
    setTold(row.id, { ...told, state, tries, next });
    return state;
}

/** Tell the sender's home of one report now (the report route, after filing). */
export async function tellHomeOf(reportId: string): Promise<void> {
    const row = db.prepare('SELECT id, target_pubkey, target_home, reason, disclosure, created_at FROM abuse_reports WHERE id = ? AND target_home IS NOT NULL')
        .get(reportId) as (QueuedRow & { created_at: string }) | undefined;
    const told = row ? toldOf(row.disclosure) : null;
    if (!row || told?.state !== 'queued' || !outsideMessagesOn()) return;
    const state = await tell(row, told, Date.parse(row.created_at));
    logger.info('SYS', `Complaints to other communities: 1 ${state === 'sent' ? 'taken by' : state === 'failed' ? 'refused by' : 'waits to be tried again at'} ${row.target_home}.`);
}

let telling = false;

/**
 * The minute timer's turn (https-server.ts): complaints that are due are tried again. Counts in the log, never names. Never
 * on a standby: its reports are a copy of the main server's, which tells their homes itself.
 */
export async function retryComplaints(now = Date.now()): Promise<number> {
    if (telling || !outsideMessagesOn() || getNodeRole() === 'backup') return 0;
    telling = true;
    try {
        const rows = db.prepare(`SELECT id, target_pubkey, target_home, reason, disclosure, created_at FROM abuse_reports
                                 WHERE target_home IS NOT NULL AND json_extract(disclosure, '$.kind') = ? AND json_extract(disclosure, '$.told.state') = 'queued'
                                   AND json_extract(disclosure, '$.told.next') <= ? ORDER BY created_at LIMIT 32`)
            .all(OUTSIDE_LINE_DISCLOSURE_KIND, now) as Array<QueuedRow & { created_at: string }>;
        const states = { sent: 0, queued: 0, failed: 0 };
        for (const row of rows) {
            const told = toldOf(row.disclosure);
            if (told) states[await tell(row, told, Date.parse(row.created_at))]++;
        }
        if (rows.length) logger.info('SYS', `Complaints to other communities: ${states.sent} taken, ${states.queued} wait, ${states.failed} refused.`);
        return rows.length;
    } finally {
        telling = false;
    }
}

// ── A complaint from another community ──────────────────────────────────────────────────────

/**
 * What the route answers (`status`, `body`, `retryAfterSec`), and whether a report was filed (`filed`: the owners' notice,
 * told by the route). `filed` is never in the answer: 202 is the same body whether it was filed now or was on file already.
 */
export type ComplaintAnswer =
    | { status: 202; body: { received: true }; filed: boolean }
    | { status: 400 | 422 | 429 | 503; body: { error: string; code: string }; retryAfterSec?: number; filed?: false };

/** The one answer every drop gets (the file header): the same words and code whatever the reason. */
export const COMPLAINT_NOT_TAKEN = {
    error: 'This community has not taken this complaint.',
    code: 'not_taken',
} as const;

/** A complaint's body read back in exactly its fields, or null. */
export function readComplaintBody(json: unknown): ComplaintBody | null {
    const c = (json as { complaint?: unknown } | null | undefined)?.complaint as Record<string, unknown> | undefined;
    if (!c || typeof c !== 'object' || Array.isArray(c) || c.v !== 1) return null;
    if (typeof c.id !== 'string' || !UUID_V4.test(c.id) || typeof c.member !== 'string' || !KEY_HEX.test(c.member)) return null;
    if (typeof c.itemId !== 'string' || !UUID_V4.test(c.itemId) || !Number.isSafeInteger(c.at) || (c.at as number) < 0) return null;
    if (!KINDS.includes(c.reason as ReportKind) || typeof c.words !== 'string' || c.words.length > OUTSIDE_LINE_TEXT_MAX) return null;
    return { v: 1, id: c.id, member: c.member, itemId: c.itemId, at: c.at as number, reason: c.reason as ReportKind, words: c.words };
}

/**
 * Whether the name a line went to is one of the signing server's (the file header): its home as signed, or a name whose key
 * document names the key it signed with. 'busy' while this server can't ask yet, or that name's document can't be had.
 */
async function wentToSigner(recipientHome: string, from: NodeOrigin, now: number): Promise<boolean | 'busy'> {
    if (recipientHome === from.origin) return true;
    const standing = await originKeyStanding(recipientHome, from.key, now);
    if (standing === 'current' || standing === 'previous') return true;
    if (standing === 'busy' || (standing === 'unknown' && !keptNodeKeyDocument(recipientHome, now))) return 'busy';
    return false;
}

/**
 * What this server makes of a complaint the server `from` signed (the file header): filed (or on file already), dropped and
 * answered alike, or refused for its form, past the cap, or while the name its line went to can't be confirmed yet.
 */
export async function receiveComplaint(from: NodeOrigin, body: unknown, now = Date.now()): Promise<ComplaintAnswer> {
    const c = readComplaintBody(body);
    if (!c) return { status: 400, body: { error: 'A complaint is { complaint: { v: 1, id, member, itemId, at, reason, words } }.', code: 'bad_complaint' } };
    const notTaken = { status: COMPLAINT_NOT_TAKEN_STATUS, body: { ...COMPLAINT_NOT_TAKEN } } as const;
    if (!outsideMessagesOn()) return notTaken;
    const origin = from.origin;
    // Counted by the community (its complaints' reporter, read on idx_abuse_reports_reporter), never from a disclosure.
    const reporter = `${COMPLAINT_REPORTER_PREFIX}${origin}`;
    const fromOrigin = (db.prepare(`SELECT COUNT(*) AS n FROM abuse_reports WHERE reporter_pubkey = ? AND created_at > ?`)
        .get(reporter, new Date(now - DAY_MS).toISOString()) as { n: number }).n;
    if (fromOrigin >= COMPLAINTS_PER_ORIGIN_DAY) {
        return { status: 429, body: { error: word("This community isn't taking more complaints from there today."), code: 'rate_limited' }, retryAfterSec: 3_600 };
    }
    // A real line: this member sent an item by that id (one row: the outbox's own key), and it went to the signing server.
    const sent = db.prepare("SELECT recipient_home FROM relay_outbox WHERE sender_key = ? AND item_id = ? AND kind = 'dm-line'")
        .get(c.member, c.itemId) as { recipient_home: string } | undefined;
    if (!sent || !isNodeMember(c.member)) return notTaken;
    const received = { status: 202 as const, body: { received: true as const }, filed: false };
    const onFile = () => !!db.prepare('SELECT 1 FROM abuse_reports WHERE reporter_pubkey = ? AND target_message_id = ?').get(reporter, c.itemId);
    // One complaint a line from one community: one on file already is taken (the first went to the signer, checked then).
    if (onFile()) return received;
    const toSigner = await wentToSigner(sent.recipient_home, from, now);
    if (toSigner === 'busy') {
        return { status: 503, body: { error: 'This server can\'t yet confirm that your server is the one this message went to. Please try again later.', code: 'busy' }, retryAfterSec: NODE_BUSY_RETRY_AFTER_SEC };
    }
    if (!toSigner) return notTaken;
    // Asked again after the wait: the same community's complaint that came meanwhile may be on file now.
    if (onFile()) return received;
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_message_id, disclosure, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), reporter, c.member, c.itemId,
        JSON.stringify({ kind: RELAY_COMPLAINT_DISCLOSURE_KIND, v: 1, from: origin, complaintId: c.id, at: c.at, words: c.words }),
        c.reason === 'child safety' ? 'Child safety' : c.reason, new Date(now).toISOString());
    logger.info('SYS', `Complaints from other communities: 1 filed from ${origin}.`);
    return { ...received, filed: true };
}

// ── What the moderators read ────────────────────────────────────────────────────────────────

/** A complaint from another community, as the moderators open it: where from, about whom, and its reporter's word. */
export interface ReportedComplaint {
    kind: 'complaint';
    /** The line's id, as the member's own outbox names it. */
    id: string;
    from: string;
    authorPubkey: string;
    authorCallsign: string | null;
    /** When the member signed the line, by their clock, as the complaint says. */
    signedAt: string | null;
    words: { state: 'reported'; text: string };
}

export function openReportedComplaint(reportId: string): ReportedComplaint | null {
    const row = db.prepare(`SELECT ar.target_pubkey, ar.target_message_id, ar.disclosure, m.callsign FROM abuse_reports ar
                            LEFT JOIN members m ON m.public_key = ar.target_pubkey WHERE ar.id = ? AND ar.reporter_pubkey LIKE ?`)
        .get(reportId, `${COMPLAINT_REPORTER_PREFIX}%`) as { target_pubkey: string; target_message_id: string | null; disclosure: string | null; callsign: string | null } | undefined;
    if (!row?.disclosure || !row.target_message_id) return null;
    let d: { kind?: unknown; from?: unknown; at?: unknown; words?: unknown };
    try { d = JSON.parse(row.disclosure); } catch { return null; }
    if (d.kind !== RELAY_COMPLAINT_DISCLOSURE_KIND || typeof d.from !== 'string' || typeof d.words !== 'string') return null;
    return {
        kind: 'complaint', id: row.target_message_id, from: d.from, authorPubkey: row.target_pubkey, authorCallsign: row.callsign ?? null,
        signedAt: Number.isSafeInteger(d.at) ? new Date(d.at as number).toISOString() : null, words: { state: 'reported', text: d.words },
    };
}

/** A reported outside line, as the moderators open it (GET /api/local/admin/reports/:id/message): signatures checked again. */
export interface ReportedOutsideLine {
    kind: 'dm';
    id: string;
    sentAt: null;
    signedAt: string | null;
    authorPubkey: string;
    authorCallsign: null;
    /** The sender's community. */
    from: string;
    signer: string | null;
    signature: 'verified' | 'unverified';
    words: { state: 'reported'; text: string };
    photo: false;
    voice: null;
    /** No server keeps a line from outside: what the moderators read is what was handed over. */
    line: 'gone';
    /** Whether the sender's community has the complaint: still trying, taken, or it would not take it. */
    told: ToldState | null;
    /** Whether the reporter has its sender blocked now: not when their list was full at the report, or they unblocked since. */
    blocked: boolean;
}

export function openReportedOutsideLine(reportId: string): ReportedOutsideLine | null {
    const row = db.prepare('SELECT reporter_pubkey, target_pubkey, target_home, disclosure FROM abuse_reports WHERE id = ? AND target_home IS NOT NULL').get(reportId) as
        { reporter_pubkey: string; target_pubkey: string; target_home: string; disclosure: string | null } | undefined;
    if (!row?.disclosure?.startsWith(`{"kind":"${OUTSIDE_LINE_DISCLOSURE_KIND}"`)) return null;
    let d: { envelope?: unknown; payload?: unknown; words?: unknown };
    try { d = JSON.parse(row.disclosure); } catch { return null; }
    const env = readRelayEnvelope(d.envelope);
    if (!env || typeof d.payload !== 'string' || typeof d.words !== 'string') return null;
    const verified = env.senderKey === row.target_pubkey && env.recipient === row.reporter_pubkey && relayPayloadHash(d.payload) === env.payloadHash
        && relayEnvelopeVerifies(env) && lineSignedBySender(env, d.payload, row.reporter_pubkey);
    return {
        kind: 'dm', id: env.itemId, sentAt: null, signedAt: verified ? new Date(env.at).toISOString() : null, authorPubkey: row.target_pubkey,
        authorCallsign: null, from: row.target_home, signer: verified ? env.senderKey : null, signature: verified ? 'verified' : 'unverified',
        words: { state: 'reported', text: d.words }, photo: false, voice: null, line: 'gone', told: toldOf(row.disclosure)?.state ?? null,
        blocked: hasBlocked(row.reporter_pubkey, row.target_pubkey),
    };
}
