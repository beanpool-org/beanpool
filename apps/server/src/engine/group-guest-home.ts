/**
 * Guests in a group's chat from other communities, on the GUEST'S OWN community's server (slice G1b: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §4.2; DESIGN-forums-messaging-joint-fable.md §2.3; the host's side is
 * engine/group-guests.ts, #3197). A member here is the guest; the group lives at its host. Their phone never talks to the
 * host: everything goes through this server.
 *
 *   in    the host brings what it tells this member's devices in a request it signs, to POST /api/relay/group
 *         (receiveGroupNotice): `{ v: 1, kind, group, host, guests, data }`, one request per community naming that
 *         community's guests, never one per guest. Kinds: an invitation, the roster (the names in the chat and the current
 *         epoch), a line, an epoch, a removal. Each named guest gets the notice when, and only when:
 *           - the request's signer is the host it names (the node signature door, engine/node-signature.ts, proved who);
 *           - the guest is a member here who reads as one;
 *           - an invitation: it is not waiting already (counted once per host and group: a repeat holds nothing), they are
 *             not joining or in that group, have not blocked who invited them, it carries at most GROUP_INVITE_MAX_CHARS,
 *             and they have at most GROUP_INVITES_WAITING invitations waiting (GROUP_INVITES_WAITING_PER_HOST from one host);
 *           - anything else: they ANSWERED that host for that group (group_guest_links): `joining` or `in` for a roster, a
 *             line or an epoch; for a removal also `invited` (the invitation withdrawn: the link goes, so a host nobody
 *             answered keeps no row here). A host nobody here answered brings nothing but invitations.
 *         Two allowances per member, neither reachable by another host's notices (mayHold): what came unanswered (each
 *         invitation and its withdrawal) is held at most GROUP_INVITES_WAITING_PER_HOST from a host and
 *         GROUP_INVITES_WAITING in all, counting every one held; what came under a link they answered, at most
 *         GROUP_MAIL_PER_HOST_ITEMS / _BYTES from each host that no device has, and as much again that one device has (the
 *         oldest past it go, that host's only). Nothing held is ever pushed out by another host's.
 *         Every other notice is dropped, and the answer is the same 202 `{ received: true }` (nothing tells a host who is
 *         a member here, nor who answered it), as it is with the owners' switch off, from a server the owners blocked
 *         (connector-manager.ts isServerBlocked), and on a standby, which writes nothing. What the answer does say depends
 *         on nothing about the members: a body that is not a notice (400), a host that is not its signer (400), this
 *         server's mailbox or disk full (503, the mailbox's own rule, so the host tries again).
 *   held  each notice is held for that member's devices (group_guest_mail), with ONLY that member's own wrap in an epoch
 *         or a roster: nothing reaches a device that isn't that guest's. Each device (the mailbox's list of them,
 *         relay_mail_devices) fetches what it has not confirmed (`GET /api/mail/group?device=`) and confirms it
 *         (`POST /api/mail/group/confirm`); a notice goes once every device listed has it, or after MAIL_HELD_DAYS.
 *   kept  the latest roster from each host for each group, per member (group_guest_links.roster), is step 1 of #3197's four:
 *         a phone that heard `epoch-stale` waits for the roster (step 2), then core's guestEpochStep makes the next epoch
 *         (stale or none: step 3) or opens the key and sends the line again (not stale: step 4). The fetch serves it beside
 *         the held notices, so a new device has it too.
 *   out   a member's own items to a group at a host (their yes or no to an invitation, a leave, a line, an epoch:
 *         `group-invite`, `group-leave`, `group-line`, `group-epoch`, recipient `group:<id>`) come through
 *         `POST /api/mail/send` (sendGroupItems) and go to the host's POST /api/relay/mail in a request this server signs.
 *         Checked as the mailbox checks a line (their envelope, signed, naming this server as their home), and against
 *         where they stand with that group: an answer only to an invitation waiting, a line or an epoch only once in, and
 *         nothing more after a leave or an answer still waiting for that group. Their yes makes the link `joining`, so the
 *         roster that follows it is taken; the link moves ONLY on the host's answer (moveLinkOn): a yes, no or leave the
 *         host took (a 2xx that doesn't refuse it) moves it to `in`, `declined` or `left`; one it refused, a 400/413, or
 *         a day of no answer leaves it where it was, and a yes not taken puts the invitation back, to answer again. Kept in group_guest_sent while
 *         the host hasn't taken it, for each host strictly oldest first (an epoch before the line under it), tried again
 *         with backoff by time (group-guests.ts nextFanoutTry) for a day. The host's answer for each item is kept, so the
 *         phone hears `epoch-stale` (and waits for the roster) or `group-refused`.
 *
 * **A standby** copies group_guest_links (a plain table), so a promoted standby still knows which hosts its members
 * answered; the held notices and the sent items are this server's own (`local`), never in a copy, as the mailbox's are.
 * A standby takes no notice (it answers as the main server does and writes nothing), sends no member's item, and its
 * timer does nothing here.
 */
import crypto from 'node:crypto';
import { readRelayEnvelope, relayEnvelopeVerifies, relayPayloadHash, word, type RelayEnvelope } from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeRole, STANDBY_WRITE_MESSAGE } from '../config/node-role.js';
import { isServerBlocked } from '../connector-manager.js';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { hasBlocked } from './member-blocks.js';
import { isOwnNodeHome, ownNodeHome } from './node-key.js';
import { GROUP_GUESTS_MAX, GUESTS_OFF_ERROR, GUEST_ITEM_KINDS, fanoutNow, groupGuestsOn, guestItemMaxChars, nextFanoutTry } from './group-guests.js';
import {
    MAILBOX_FULL_ERROR, MAIL_DEVICE_LAPSE_MS, MAIL_FETCH_PAGE, MAIL_HELD_DAYS, MAIL_ITEM_MAX_AGE_MS, MAIL_ITEM_MAX_AHEAD_MS,
    MAIL_RETRY_AFTER_SEC, MAIL_SERVER_BYTES, RELAY_ITEMS_PER_REQUEST, RELAY_MAIL_PATH, relayMailDir,
} from './relay-mail.js';
import { NO_HOME_ERROR, OUTBOX_PER_MEMBER_DAY, OUTBOX_RATE_ERROR, OutboxError, forwardSignedForAnswer } from './relay-outbox.js';
import { assertFolderFloorSpace, StorageNearlyFullError } from './photo-upload-budget.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60_000;
/** The path a group's host brings notices to (engine/node-signature.ts NODE_SIGNED_PATHS; the host's GROUP_GUEST_PATH). */
export const GROUP_NOTICE_PATH = '/api/relay/group';
export const GROUP_NOTICE_KINDS = ['invite', 'roster', 'line', 'epoch', 'removed'] as const;
export type GroupNoticeKind = (typeof GROUP_NOTICE_KINDS)[number];
/** Invitations waiting for one member here, and from one host (a request each, as a stranger's message request is). */
export const GROUP_INVITES_WAITING = 20;
export const GROUP_INVITES_WAITING_PER_HOST = 5;
/** An invitation (`{ name, invitedBy: { key, name } }`), or its withdrawal, carries at most this much, as JSON; a larger one is dropped. */
export const GROUP_INVITE_MAX_CHARS = 2048;
/**
 * Notices from one host under links one member here answered that no device of theirs has confirmed: past either, a new
 * one is dropped. As much again may wait that one device has and another not yet, the oldest of that host's past it going.
 */
export const GROUP_MAIL_PER_HOST_ITEMS = 500;
export const GROUP_MAIL_PER_HOST_BYTES = 50 * 1024 * 1024;
/** A host is tried this long before an item to it fails; a settled row goes this long after its last change. */
export const GROUP_SENT_QUEUE_MS = DAY_MS;
export const GROUP_SENT_KEPT_MS = MAIL_HELD_DAYS * DAY_MS;
/** One request to a host carries items up to this many characters together, or one larger item alone. */
const GROUP_SENT_REQUEST_CHARS = 64 * 1024;

export const NOT_IN_GROUP_ERROR = word("You're not in that group, or its invitation is no longer waiting.");

type LinkState = 'invited' | 'joining' | 'in' | 'declined' | 'left' | 'removed';
interface LinkRow { member: string; host: string; group_id: string; state: LinkState; roster: string | null; roster_at: number | null }

const KEY_HEX = /^[0-9a-f]{64}$/;
const GROUP_ID = /^[0-9A-Za-z_-]{1,64}$/;
const ITEM_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function linkOf(member: string, host: string, groupId: string): LinkRow | undefined {
    return db.prepare('SELECT * FROM group_guest_links WHERE member = ? AND host = ? AND group_id = ?').get(member, host, groupId) as LinkRow | undefined;
}

function setLink(member: string, host: string, groupId: string, state: LinkState, now: number, roster?: { body: string | null }): void {
    db.prepare(`INSERT INTO group_guest_links (member, host, group_id, state, roster, roster_at, state_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)
                ON CONFLICT (member, host, group_id) DO UPDATE SET state = excluded.state, state_at = excluded.state_at`)
        .run(member, host, groupId, state, now);
    if (roster) db.prepare('UPDATE group_guest_links SET roster = ?, roster_at = ? WHERE member = ? AND host = ? AND group_id = ?')
        .run(roster.body, roster.body === null ? null : now, member, host, groupId);
}

// ── What a host brings ──────────────────────────────────────────────────────────────────────

interface Notice { kind: GroupNoticeKind; group: string; host: string; guests: string[]; data: Record<string, unknown> }

/** A notice as the host sends one (engine/group-guests.ts queueToHome), or null. */
export function readGroupNotice(raw: unknown): Notice | null {
    if (!isObject(raw) || raw.v !== 1) return null;
    const { kind, group, host, guests, data } = raw;
    if (typeof kind !== 'string' || !(GROUP_NOTICE_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof group !== 'string' || !GROUP_ID.test(group) || typeof host !== 'string' || host.length < 1 || host.length > 260) return null;
    if (!Array.isArray(guests) || guests.length < 1 || guests.length > GROUP_GUESTS_MAX || !guests.every((g) => typeof g === 'string' && KEY_HEX.test(g))) return null;
    if (new Set(guests).size !== guests.length || !isObject(data)) return null;
    return { kind: kind as GroupNoticeKind, group, host, guests: guests as string[], data };
}

/** What a notice carries for one member: an epoch's or a roster's wraps cut to that member's own. */
function dataFor(member: string, n: Notice): Record<string, unknown> {
    const own = (wraps: unknown) => (Array.isArray(wraps) ? wraps.filter((w) => isObject(w) && w.recipient === member) : []);
    if (n.kind === 'epoch') return { ...n.data, wraps: own(n.data.wraps) };
    if (n.kind === 'roster' && isObject(n.data.epoch) && 'wraps' in n.data.epoch) return { ...n.data, epoch: { ...n.data.epoch, wraps: own(n.data.epoch.wraps) } };
    return n.data;
}

export type GroupNoticeAnswer =
    | { status: 202; body: { received: true } }
    | { status: 400 | 503; body: { error: string; code: string }; retryAfterSec?: number };

const RECEIVED: GroupNoticeAnswer = { status: 202, body: { received: true } };

const sum = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n;
const NO_DEVICE_HAS = `NOT EXISTS (SELECT 1 FROM group_guest_mail_got g WHERE g.member = group_guest_mail.member AND g.mail_id = group_guest_mail.id)`;

/**
 * What this server makes of a notice the host `origin` (the home its request was verified as) brought: held for each named
 * guest it may reach, dropped for every other, answered alike (the file's header).
 */
export function receiveGroupNotice(origin: string, raw: unknown, now = Date.now()): GroupNoticeAnswer {
    const n = readGroupNotice(raw);
    if (!n) return { status: 400, body: { error: 'A group notice is { v: 1, kind, group, host, guests, data }.', code: 'bad_notice' } };
    if (n.host !== origin) return { status: 400, body: { error: "A group notice comes from its group's host, which signs it.", code: 'wrong_host' } };
    if (!groupGuestsOn() || isServerBlocked(origin) || getNodeRole() === 'backup') return RECEIVED;
    // The server's own room, as the mailbox's: counted on the notice, whoever it is for, so the answer says nothing of them.
    const incoming = JSON.stringify(n.data).length;
    let roomy = sum('SELECT COALESCE(SUM(bytes), 0) AS n FROM relay_mail') + sum('SELECT COALESCE(SUM(bytes), 0) AS n FROM group_guest_mail') + incoming <= MAIL_SERVER_BYTES;
    try {
        if (roomy) assertFolderFloorSpace(relayMailDir());
    } catch (e) {
        if (!(e instanceof StorageNearlyFullError)) throw e;
        roomy = false;
    }
    if (!roomy) return { status: 503, body: { error: MAILBOX_FULL_ERROR, code: 'mailbox_full' }, retryAfterSec: MAIL_RETRY_AFTER_SEC };
    for (const member of n.guests) {
        try {
            db.transaction(() => takeNoticeFor(member, n, now))();
        } catch (e) {
            logger.warn('SYS', `Group guests: a notice from a group's host could not be held (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
        }
    }
    return RECEIVED;
}

/** One named guest: the notice held for them, or dropped (the file's header says when). True when held. */
function takeNoticeFor(member: string, n: Notice, now: number): boolean {
    if (!isNodeMember(member) || !readsAsMember(member)) return false;
    const state = linkOf(member, n.host, n.group)?.state ?? null;
    const answered = state === 'joining' || state === 'in';
    const body = JSON.stringify(dataFor(member, n));
    switch (n.kind) {
        case 'invite': {
            // Once per host and group: waiting, joining or in already, a repeat holds nothing and moves nothing.
            if (state === 'invited' || answered || body.length > GROUP_INVITE_MAX_CHARS) return false;
            const inviter = isObject(n.data.invitedBy) ? n.data.invitedBy.key : null;
            if (typeof inviter === 'string' && KEY_HEX.test(inviter) && hasBlocked(member, inviter)) return false;
            const waiting = (host?: string) => sum(`SELECT COUNT(*) AS n FROM group_guest_links WHERE member = ? AND state = 'invited'${host ? ' AND host = ?' : ''}`, member, ...(host ? [host] : []));
            if (waiting() >= GROUP_INVITES_WAITING || waiting(n.host) >= GROUP_INVITES_WAITING_PER_HOST) return false;
            if (!mayHold(member, n.host, false, body.length)) return false;
            setLink(member, n.host, n.group, 'invited', now, { body: null });
            break;
        }
        case 'removed':
            if (state === 'invited') {
                // The invitation withdrawn: no row is kept for a host they never answered; the notice counts as an invitation.
                db.prepare('DELETE FROM group_guest_links WHERE member = ? AND host = ? AND group_id = ?').run(member, n.host, n.group);
                if (body.length > GROUP_INVITE_MAX_CHARS || !mayHold(member, n.host, false, body.length)) return true;
                break;
            }
            if (!answered) return false;
            setLink(member, n.host, n.group, 'removed', now, { body: null });
            if (!mayHold(member, n.host, true, body.length)) return true;
            break;
        case 'roster':
            if (!answered) return false;
            // Kept whatever the caps say (one per group they answered): a phone that missed a held one still has the latest (step 1).
            setLink(member, n.host, n.group, state as LinkState, now, { body });
            if (!mayHold(member, n.host, true, body.length)) return true;
            break;
        case 'line':
        case 'epoch':
            if (!answered || !mayHold(member, n.host, true, body.length)) return false;
            break;
    }
    db.prepare('INSERT INTO group_guest_mail (id, member, host, group_id, kind, body, bytes, answered, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), member, n.host, n.group, n.kind, body, body.length, answered ? 1 : 0, now);
    return true;
}

/**
 * Whether one more notice of `bytes` from `host` may wait for `member`, against its own allowance only (the file's header):
 * unanswered, every one held counts, from that host and in all (each at most GROUP_INVITE_MAX_CHARS); answered, that
 * host's that no device has. Another host's notices never count against a host's allowance, nor push one out.
 */
function mayHold(member: string, host: string, answered: boolean, bytes: number): boolean {
    if (!answered) {
        return sum('SELECT COUNT(*) AS n FROM group_guest_mail WHERE member = ? AND host = ? AND answered = 0', member, host) < GROUP_INVITES_WAITING_PER_HOST
            && sum('SELECT COUNT(*) AS n FROM group_guest_mail WHERE member = ? AND answered = 0', member) < GROUP_INVITES_WAITING;
    }
    const of = `FROM group_guest_mail WHERE member = ? AND host = ? AND answered = 1 AND ${NO_DEVICE_HAS}`;
    return sum(`SELECT COUNT(*) AS n ${of}`, member, host) < GROUP_MAIL_PER_HOST_ITEMS
        && sum(`SELECT COALESCE(SUM(bytes), 0) AS n ${of}`, member, host) + bytes <= GROUP_MAIL_PER_HOST_BYTES;
}

// ── The member's devices: fetch and confirm ─────────────────────────────────────────────────

export interface HeldGroupNotice { id: string; host: string; group: string; kind: GroupNoticeKind; data: unknown; receivedAt: number }
export interface GroupLinkView { host: string; group: string; state: LinkState; roster: unknown; rosterAt: number | null }
export interface GroupSentTick { itemId: string; kind: string; host: string; group: string; state: string; refused: string | null; at: number }

/**
 * What waits for `member` that `device` has not confirmed, oldest first, a page at a time; where they stand with each group
 * at another community, each with its latest roster (step 1); and what became of their own items to groups after the
 * device's last tick (`since`, `sinceId`, as the mailbox's ticks are paged).
 */
export function heldGroupMailFor(member: string, device: string, since = 0, sinceId = ''): {
    items: HeldGroupNotice[]; more: boolean; groups: GroupLinkView[]; sent: GroupSentTick[]; sentMore: boolean;
} {
    const rows = db.prepare(`SELECT id, host, group_id, kind, body, received_at FROM group_guest_mail m WHERE member = ?
                               AND NOT EXISTS (SELECT 1 FROM group_guest_mail_got g WHERE g.member = m.member AND g.mail_id = m.id AND g.device = ?)
                             ORDER BY received_at, rowid LIMIT ?`).all(member, device, MAIL_FETCH_PAGE + 1) as Array<{
        id: string; host: string; group_id: string; kind: GroupNoticeKind; body: string; received_at: number;
    }>;
    const links = db.prepare(`SELECT * FROM group_guest_links WHERE member = ? AND state IN ('invited', 'joining', 'in', 'removed') ORDER BY state_at, host, group_id`).all(member) as LinkRow[];
    const sent = db.prepare(`SELECT item_id, kind, host, group_id, state, refused, updated_at FROM group_guest_sent
                             WHERE sender_key = ? AND (updated_at > ? OR (updated_at = ? AND item_id > ?)) ORDER BY updated_at, item_id LIMIT ?`)
        .all(member, since, since, sinceId, MAIL_FETCH_PAGE + 1) as Array<{ item_id: string; kind: string; host: string; group_id: string; state: string; refused: string | null; updated_at: number }>;
    return {
        items: rows.slice(0, MAIL_FETCH_PAGE).map((r) => ({ id: r.id, host: r.host, group: r.group_id, kind: r.kind, data: JSON.parse(r.body), receivedAt: r.received_at })),
        more: rows.length > MAIL_FETCH_PAGE,
        groups: links.map((l) => ({ host: l.host, group: l.group_id, state: l.state, roster: l.roster ? JSON.parse(l.roster) : null, rosterAt: l.roster_at })),
        sent: sent.slice(0, MAIL_FETCH_PAGE).map((r) => ({ itemId: r.item_id, kind: r.kind, host: r.host, group: r.group_id, state: r.state, refused: r.refused, at: r.updated_at })),
        sentMore: sent.length > MAIL_FETCH_PAGE,
    };
}

/**
 * `member`'s notices that are done: one a LISTED device has confirmed, and every device listed has (relay_mail_devices,
 * seen within MAIL_DEVICE_LAPSE_MS: the mailbox's own list). A confirm by a device no longer listed counts for nothing.
 */
function settleGroupMailFor(member: string, now: number): number {
    const since = now - MAIL_DEVICE_LAPSE_MS;
    const done = db.prepare(`SELECT m.id FROM group_guest_mail m WHERE m.member = ?
                               AND EXISTS (SELECT 1 FROM group_guest_mail_got g JOIN relay_mail_devices d ON d.member = g.member AND d.device = g.device
                                           WHERE g.member = m.member AND g.mail_id = m.id AND d.seen_at >= ?)
                               AND NOT EXISTS (SELECT 1 FROM relay_mail_devices d WHERE d.member = m.member AND d.seen_at >= ?
                                   AND NOT EXISTS (SELECT 1 FROM group_guest_mail_got g WHERE g.member = m.member AND g.mail_id = m.id AND g.device = d.device))`)
        .pluck().all(member, since, since) as string[];
    // What one device has and another listed one not yet: under links they answered, as much again as each host's
    // allowance, the oldest of THAT host's past it going (as the mailbox's settleMailFor); invitations all count (mayHold).
    const half = db.prepare(`SELECT id, host, bytes FROM group_guest_mail WHERE member = ? AND answered = 1 AND NOT ${NO_DEVICE_HAS}
                             ORDER BY received_at DESC, rowid DESC`).all(member) as Array<{ id: string; host: string; bytes: number }>;
    const kept = new Map<string, { n: number; bytes: number; full: boolean }>();
    const past: string[] = [];
    const going = new Set(done);
    for (const r of half) {
        if (going.has(r.id)) continue;
        const k = kept.get(r.host) ?? { n: 0, bytes: 0, full: false };
        k.full ||= k.n >= GROUP_MAIL_PER_HOST_ITEMS || k.bytes + r.bytes > GROUP_MAIL_PER_HOST_BYTES;
        if (k.full) past.push(r.id);
        else { k.n++; k.bytes += r.bytes; }
        kept.set(r.host, k);
    }
    return dropNotices(member, [...done, ...past]);
}

function dropNotices(member: string, ids: string[]): number {
    if (!ids.length) return 0;
    const del = db.prepare('DELETE FROM group_guest_mail WHERE member = ? AND id = ?');
    const delGot = db.prepare('DELETE FROM group_guest_mail_got WHERE member = ? AND mail_id = ?');
    db.transaction(() => { for (const id of ids) { del.run(member, id); delGot.run(member, id); } })();
    return ids.length;
}

/** `device` of `member`'s has these notices (written or dropped); each one every listed device has goes. How many were new to it. */
export function confirmGroupMail(member: string, device: string, ids: string[], now = Date.now()): number {
    const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id.length >= 8 && id.length <= 64))];
    if (!wanted.length) return 0;
    const n = db.transaction(() => {
        const held = db.prepare(`SELECT id FROM group_guest_mail WHERE member = ? AND id IN (${wanted.map(() => '?').join(', ')})`).pluck().all(member, ...wanted) as string[];
        const mark = db.prepare('INSERT INTO group_guest_mail_got (member, mail_id, device) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
        return held.reduce((c, id) => c + mark.run(member, id, device).changes, 0);
    })();
    settleGroupMailFor(member, now);
    return n;
}

// ── A member's own items to a group at a host ───────────────────────────────────────────────

export interface GroupSentState { itemId: string; state: string; refused?: string }

type Checked = { envelope: RelayEnvelope; payload: string; groupId: string };

/** Why `raw` is not a group item `member` may send from `home`, or the item. */
function groupItemProblem(raw: unknown, member: string, home: string, now: number): { item: Checked } | { problem: string; status?: 413 } {
    const o = raw as { envelope?: unknown; payload?: unknown } | null;
    const env = readRelayEnvelope(o?.envelope);
    if (!env || typeof o?.payload !== 'string') return { problem: 'Each item is { envelope, payload }, the envelope signed by its sender.' };
    if (!GUEST_ITEM_KINDS.has(env.kind)) return { problem: 'A request carries group items or direct items, not both.' };
    const max = guestItemMaxChars(env.kind)!;
    if (o.payload.length > max) return { problem: `A ${env.kind} item carries at most ${max} characters.`, status: 413 };
    if (env.senderKey !== member) return { problem: 'An item you send names you as its sender.' };
    if (env.senderHome !== home) return { problem: `An item sent from here names this community's server as its sender's home (${home}).` };
    if (!env.recipient.startsWith('group:') || !GROUP_ID.test(env.recipient.slice(6))) return { problem: 'A group item goes to group:<id> at its host.' };
    if (isOwnNodeHome(env.recipientHome)) return { problem: "That group is this community's own: write in it here." };
    if (relayPayloadHash(o.payload) !== env.payloadHash) return { problem: 'The payload is not the one the envelope names.' };
    if (env.at < now - MAIL_ITEM_MAX_AGE_MS || env.at > now + MAIL_ITEM_MAX_AHEAD_MS) return { problem: "The item's time is too far from this server's clock." };
    if (!relayEnvelopeVerifies(env)) return { problem: 'The envelope is not signed by its sender.' };
    return { item: { envelope: env, payload: o.payload, groupId: env.recipient.slice(6) } };
}

/** A yes or no to an invitation, read from a group-invite's payload (anything else: null). */
function answerOf(payload: string): 'yes' | 'no' | null {
    try {
        const o = JSON.parse(payload) as { v?: unknown; answer?: unknown } | null;
        return o?.v === 1 && (o.answer === 'yes' || o.answer === 'no') ? o.answer : null;
    } catch {
        return null;
    }
}

/** Whether `member` has an item of one of `kinds` still queued for that group at that host. */
function waitingFor(member: string, host: string, groupId: string, kinds: string[]): boolean {
    return !!db.prepare(`SELECT 1 FROM group_guest_sent WHERE sender_key = ? AND host = ? AND group_id = ? AND state = 'queued'
                         AND kind IN (${kinds.map(() => '?').join(', ')}) LIMIT 1`).get(member, host, groupId, ...kinds);
}

/**
 * Whether `member` may send `c` (the file's header, "out"): an answer only to an invitation waiting, a leave when invited,
 * joining or in, a line or an epoch only once in; nothing more after a leave still queued for that group, and no second
 * answer while one is.
 */
function maySend(member: string, c: Checked): boolean {
    const host = c.envelope.recipientHome;
    const state = linkOf(member, host, c.groupId)?.state ?? null;
    if (waitingFor(member, host, c.groupId, ['group-leave'])) return false;
    if (c.envelope.kind === 'group-invite') return state === 'invited' && answerOf(c.payload) !== null && !waitingFor(member, host, c.groupId, ['group-invite']);
    if (c.envelope.kind === 'group-leave') return state === 'in' || state === 'joining' || state === 'invited';
    return state === 'in';
}

/**
 * Where the host's answer for one item moves `member`'s link: only a yes, a no or a leave move it, only when the host took
 * it (`taken`: a 2xx that doesn't refuse it), and only from where that item left it. A yes the host did not take (refused
 * in its answer, a 400/413, or a day of no answer) puts the invitation back, so they can answer again.
 */
function moveLinkOn(member: string, kind: string, host: string, groupId: string, item: string | null, taken: boolean, now: number): void {
    let payload = '';
    try { payload = item ? String((JSON.parse(item) as { payload?: unknown }).payload ?? '') : ''; } catch { /* no payload */ }
    const answer = kind === 'group-invite' ? answerOf(payload) : null;
    const move = (from: LinkState[], to: LinkState) => db.prepare(`UPDATE group_guest_links SET state = ?, state_at = ?,
            roster = CASE WHEN ? = 'in' THEN roster END, roster_at = CASE WHEN ? = 'in' THEN roster_at END
        WHERE member = ? AND host = ? AND group_id = ? AND state IN (${from.map(() => '?').join(', ')})`).run(to, now, to, to, member, host, groupId, ...from);
    if (answer === 'yes') move(['joining'], taken ? 'in' : 'invited');
    else if (answer === 'no' && taken) move(['invited'], 'declined');
    else if (kind === 'group-leave' && taken) move(['invited', 'joining', 'in'], 'left');
}

/**
 * `member`'s group items (the file's header, "out"), checked, kept and sent to each host now; each item's state after the
 * first try, with the host's refusal when it gave one. Throws OutboxError, having stored nothing, when guests or the mailbox
 * are switched off, on a standby, or when an item is not theirs to send. An item sent again keeps its row and answers it.
 */
export async function sendGroupItems(member: string, items: unknown[], now = Date.now()): Promise<GroupSentState[]> {
    if (!groupGuestsOn()) throw new OutboxError(403, 'guests_off', GUESTS_OFF_ERROR);
    if (getNodeRole() === 'backup') throw new OutboxError(503, 'standby', STANDBY_WRITE_MESSAGE);
    const home = ownNodeHome();
    if (!home) throw new OutboxError(503, 'no_home', NO_HOME_ERROR);
    if (items.length === 0 || items.length > RELAY_ITEMS_PER_REQUEST) throw new OutboxError(400, 'bad_items', `items is a list of 1 to ${RELAY_ITEMS_PER_REQUEST} relay items.`);
    const checked: Checked[] = [];
    for (const raw of items) {
        const c = groupItemProblem(raw, member, home, now);
        if ('problem' in c) throw new OutboxError(c.status ?? 400, c.status === 413 ? 'too_large' : 'bad_item', c.problem);
        if (!checked.some((x) => x.envelope.itemId === c.item.envelope.itemId)) checked.push(c.item);
    }
    const had = new Set(db.prepare(`SELECT item_id FROM group_guest_sent WHERE sender_key = ? AND item_id IN (${checked.map(() => '?').join(', ')})`)
        .pluck().all(member, ...checked.map((c) => c.envelope.itemId)) as string[]);
    const fresh = checked.filter((c) => !had.has(c.envelope.itemId));
    const today = sum('SELECT COUNT(*) AS n FROM relay_outbox WHERE sender_key = ? AND created_at > ?', member, now - DAY_MS)
        + sum('SELECT COUNT(*) AS n FROM group_guest_sent WHERE sender_key = ? AND created_at > ?', member, now - DAY_MS);
    if (today + fresh.length > OUTBOX_PER_MEMBER_DAY) throw new OutboxError(429, 'rate_limited', OUTBOX_RATE_ERROR);
    db.transaction(() => {
        const insert = db.prepare(`INSERT INTO group_guest_sent (sender_key, item_id, kind, host, group_id, state, item, attempts, next_try_at, created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?) ON CONFLICT (sender_key, item_id) DO NOTHING`);
        for (const c of fresh) {
            if (!maySend(member, c)) throw new OutboxError(403, 'not_in_group', NOT_IN_GROUP_ERROR);
            // Their yes: `joining` until the host's answer (moveLinkOn), so the roster that follows it is taken meanwhile.
            if (c.envelope.kind === 'group-invite' && answerOf(c.payload) === 'yes') setLink(member, c.envelope.recipientHome, c.groupId, 'joining', now);
            // Behind every row already waiting for that host, whatever the clock did: each host's items go oldest first.
            const last = db.prepare("SELECT MAX(created_at) FROM group_guest_sent WHERE host = ? AND state = 'queued'").pluck().get(c.envelope.recipientHome) as number | null;
            const at = last !== null && last >= now ? last + 1 : now;
            insert.run(member, c.envelope.itemId, c.envelope.kind, c.envelope.recipientHome, c.groupId,
                JSON.stringify({ envelope: c.envelope, payload: c.payload }), now, at, now);
        }
    })();
    await Promise.all([...new Set(fresh.map((c) => c.envelope.recipientHome))].map((host) => sendToHost(host)));
    const rows = db.prepare(`SELECT item_id, state, refused FROM group_guest_sent WHERE sender_key = ? AND item_id IN (${checked.map(() => '?').join(', ')})`)
        .all(member, ...checked.map((c) => c.envelope.itemId)) as Array<{ item_id: string; state: string; refused: string | null }>;
    const of = new Map(rows.map((r) => [r.item_id, r]));
    return checked.filter((c) => of.has(c.envelope.itemId)).map((c) => {
        const r = of.get(c.envelope.itemId)!;
        return r.refused ? { itemId: r.item_id, state: r.state, refused: r.refused } : { itemId: r.item_id, state: r.state };
    });
}

interface SentRow { sender_key: string; item_id: string; kind: string; host: string; group_id: string; item: string; attempts: number; next_try_at: number; created_at: number }

/**
 * Settles one queued row as the host answered it (`sent`, `refused` and why, or `failed`), and moves its sender's link on
 * that answer (moveLinkOn). A row no longer queued (settled meanwhile) is left as it is.
 */
function settleSent(r: SentRow, state: 'sent' | 'refused' | 'failed', refused: string | null, at: number): void {
    const changed = db.prepare(`UPDATE group_guest_sent SET state = ?, refused = ?, item = NULL, next_try_at = NULL, updated_at = ?
                                WHERE sender_key = ? AND item_id = ? AND state = 'queued'`).run(state, refused, at, r.sender_key, r.item_id).changes;
    if (changed) moveLinkOn(r.sender_key, r.kind, r.host, r.group_id, r.item, state === 'sent', at);
}

/** Every row queued for `host` (or for any host) since before `before` fails: the host never took it in GROUP_SENT_QUEUE_MS. */
function failQueuedBefore(before: number, at: number, host?: string): number {
    const rows = db.prepare(`SELECT sender_key, item_id, kind, host, group_id, item, attempts, next_try_at, created_at FROM group_guest_sent
                             WHERE state = 'queued' AND created_at ${host ? '<=' : '<'} ?${host ? ' AND host = ?' : ''}`).all(before, ...(host ? [host] : [])) as SentRow[];
    for (const r of rows) settleSent(r, 'failed', null, at);
    return rows.length;
}

/** Each host being sent to now: one send a host at a time, every host on its own (as the host's fan-out is). */
const sendingTo = new Map<string, Promise<void>>();

function sendToHost(host: string): Promise<void> {
    const running = sendingTo.get(host);
    if (running) return running.then(() => sendToHost(host));
    const send = sendHostQueue(host).finally(() => sendingTo.delete(host));
    sendingTo.set(host, send);
    return send;
}

/** The host's answer for the item at `index` of a request, read by place: its refusal, or null when received. */
function refusedAt(answer: unknown, index: number, itemId: string, sent: number): string | null {
    const all = (answer as { items?: unknown } | null | undefined)?.items;
    if (!Array.isArray(all) || all.length !== sent) return null;
    const a = all[index] as { itemId?: unknown; refused?: unknown } | null;
    if (a?.itemId !== itemId || typeof a.refused !== 'string') return null;
    return /^[a-z-]{1,40}$/.test(a.refused) ? a.refused : 'refused';
}

/**
 * One host's queue, oldest first, until none is left or the host doesn't take a request: up to RELAY_ITEMS_PER_REQUEST
 * items a request (GROUP_SENT_REQUEST_CHARS together, a larger item alone). A 2xx settles each item as its answer says
 * (`sent`, or `refused` and why); a 400 or 413 fails them; anything else and every item for that host waits one backoff, by
 * time (nextFanoutTry), for GROUP_SENT_QUEUE_MS.
 */
async function sendHostQueue(host: string): Promise<void> {
    const url = `https://${host}${RELAY_MAIL_PATH}`;
    for (;;) {
        const queue = db.prepare(`SELECT sender_key, item_id, kind, host, group_id, item, attempts, next_try_at, created_at FROM group_guest_sent
                                  WHERE host = ? AND state = 'queued' ORDER BY created_at, rowid LIMIT ?`).all(host, RELAY_ITEMS_PER_REQUEST) as SentRow[];
        if (!queue.length) return;
        const batch: SentRow[] = [];
        let chars = 0;
        for (const r of queue) {
            if (batch.length && chars + r.item.length > GROUP_SENT_REQUEST_CHARS) break;
            batch.push(r);
            chars += r.item.length;
        }
        const travelling = batch.map((r) => JSON.parse(r.item) as unknown);
        const { status, body } = await forwardSignedForAnswer(url, JSON.stringify({ items: travelling }));
        const at = fanoutNow();
        if (status >= 200 && status < 300) {
            db.transaction(() => {
                batch.forEach((r, i) => {
                    const refused = refusedAt(body, i, (travelling[i] as { envelope: RelayEnvelope }).envelope.itemId, batch.length);
                    settleSent(r, refused ? 'refused' : 'sent', refused, at);
                });
                db.prepare("UPDATE group_guest_sent SET attempts = 0 WHERE host = ? AND state = 'queued' AND attempts > 0").run(host);
            })();
            continue;
        }
        if (status === 400 || status === 413) {
            db.transaction(() => { for (const r of batch) settleSent(r, 'failed', null, at); })();
            logger.warn('SYS', `Group guests: ${host} refused a request of ${batch.length} item(s) (status ${status}); their senders see Not delivered.`);
            continue;
        }
        const next = nextFanoutTry(batch[0].attempts, batch[0].next_try_at, at);
        db.transaction(() => {
            failQueuedBefore(at - GROUP_SENT_QUEUE_MS, at, host);
            db.prepare("UPDATE group_guest_sent SET attempts = ?, next_try_at = ? WHERE host = ? AND state = 'queued'").run(next.attempts, next.nextTryAt, host);
        })();
        return;
    }
}

/** The minute timer's turn (https-server.ts): each host with an item due is sent to again. Never on a standby. */
export async function retryGroupSent(now = Date.now()): Promise<number> {
    if (getNodeRole() === 'backup' || !groupGuestsOn()) return 0;
    const hosts = db.prepare("SELECT DISTINCT host FROM group_guest_sent WHERE state = 'queued' AND next_try_at <= ?").pluck().all(now) as string[];
    await Promise.all(hosts.map((h) => sendToHost(h)));
    return hosts.length;
}

/**
 * The sweep (the minute timer): notices held past MAIL_HELD_DAYS or for a key that is no longer a member here go, and what a
 * device confirmed of a notice gone or by a device no longer listed; items queued past GROUP_SENT_QUEUE_MS fail, and settled
 * rows go GROUP_SENT_KEPT_MS after their last change. All of it this server's own tables: a standby's too.
 */
export function sweepGroupGuestMail(now = Date.now()): { gone: number; failed: number } {
    let gone = 0;
    for (const r of db.prepare('SELECT DISTINCT member FROM group_guest_mail').pluck().all() as string[]) {
        const ids = isNodeMember(r)
            ? db.prepare('SELECT id FROM group_guest_mail WHERE member = ? AND received_at < ?').pluck().all(r, now - MAIL_HELD_DAYS * DAY_MS) as string[]
            : db.prepare('SELECT id FROM group_guest_mail WHERE member = ?').pluck().all(r) as string[];
        gone += dropNotices(r, ids);
        settleGroupMailFor(r, now);
    }
    db.prepare(`DELETE FROM group_guest_mail_got WHERE NOT EXISTS (SELECT 1 FROM group_guest_mail m WHERE m.member = group_guest_mail_got.member AND m.id = group_guest_mail_got.mail_id)
                OR NOT EXISTS (SELECT 1 FROM relay_mail_devices d WHERE d.member = group_guest_mail_got.member AND d.device = group_guest_mail_got.device)`).run();
    const failed = db.transaction(() => failQueuedBefore(now - GROUP_SENT_QUEUE_MS, now))();
    db.prepare("DELETE FROM group_guest_sent WHERE state != 'queued' AND updated_at < ?").run(now - GROUP_SENT_KEPT_MS);
    return { gone, failed };
}

/** Whether `item` (as a member posts it) is one of the group kinds, by its envelope: routes/relay.ts sends those here. */
export function isGroupItem(item: unknown): boolean {
    const kind = (item as { envelope?: { kind?: unknown } } | null)?.envelope?.kind;
    return typeof kind === 'string' && GUEST_ITEM_KINDS.has(kind);
}

/** An item id as the mailbox spells one (the fetch's `sinceId`). */
export const isGroupItemId = (id: unknown): id is string => typeof id === 'string' && ITEM_ID.test(id);
