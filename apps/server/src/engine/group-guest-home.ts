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
 *           - an invitation: they are not in that group already, have not blocked who invited them, and have at most
 *             GROUP_INVITES_WAITING invitations waiting (GROUP_INVITES_WAITING_PER_HOST from one host);
 *           - anything else: they ANSWERED that host for that group (group_guest_links): `in` for a roster, a line or an
 *             epoch; `invited` or `in` for a removal. A host nobody here answered brings nothing but invitations.
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
 *         where they stand with that group: an answer only to an invitation waiting, a line or an epoch only once in. Their
 *         yes makes the link `in` before it goes, so the roster that follows it is taken. Kept in group_guest_sent while
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
import { getNodeRole } from '../config/node-role.js';
import { isServerBlocked } from '../connector-manager.js';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { hasBlocked } from './member-blocks.js';
import { isOwnNodeHome, ownNodeHome } from './node-key.js';
import { GROUP_GUESTS_MAX, GUESTS_OFF_ERROR, GUEST_ITEM_KINDS, groupGuestsOn, guestItemMaxChars, nextFanoutTry } from './group-guests.js';
import {
    MAILBOX_FULL_ERROR, MAIL_DEVICE_LAPSE_MS, MAIL_FETCH_PAGE, MAIL_HELD_DAYS, MAIL_ITEM_MAX_AGE_MS, MAIL_ITEM_MAX_AHEAD_MS,
    MAIL_RETRY_AFTER_SEC, MAIL_SERVER_BYTES, RELAY_ITEMS_PER_REQUEST, RELAY_MAIL_PATH, relayMailDir,
} from './relay-mail.js';
import { OUTBOX_PER_MEMBER_DAY, OutboxError, forwardSignedForAnswer } from './relay-outbox.js';
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
/** Group notices waiting for one member here that no device of theirs has confirmed: past either, a new one is dropped. */
export const GROUP_MAIL_PER_MEMBER_ITEMS = 500;
export const GROUP_MAIL_PER_MEMBER_BYTES = 50 * 1024 * 1024;
/** A host is tried this long before an item to it fails; a settled row goes this long after its last change. */
export const GROUP_SENT_QUEUE_MS = DAY_MS;
export const GROUP_SENT_KEPT_MS = MAIL_HELD_DAYS * DAY_MS;
/** One request to a host carries items up to this many characters together, or one larger item alone. */
const GROUP_SENT_REQUEST_CHARS = 64 * 1024;

export const NOT_IN_GROUP_ERROR = word("You're not in that group, or its invitation is no longer waiting.");

type LinkState = 'invited' | 'in' | 'declined' | 'left' | 'removed';
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
const UNCONFIRMED = `member = ? AND NOT EXISTS (SELECT 1 FROM group_guest_mail_got g WHERE g.member = group_guest_mail.member AND g.mail_id = group_guest_mail.id)`;

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
    const data = dataFor(member, n);
    switch (n.kind) {
        case 'invite': {
            if (state === 'in') return false;
            const inviter = isObject(n.data.invitedBy) ? n.data.invitedBy.key : null;
            if (typeof inviter === 'string' && KEY_HEX.test(inviter) && hasBlocked(member, inviter)) return false;
            if (state !== 'invited') {
                const waiting = (host?: string) => sum(`SELECT COUNT(*) AS n FROM group_guest_links WHERE member = ? AND state = 'invited'${host ? ' AND host = ?' : ''}`, member, ...(host ? [host] : []));
                if (waiting() >= GROUP_INVITES_WAITING || waiting(n.host) >= GROUP_INVITES_WAITING_PER_HOST) return false;
            }
            if (!mayHold(member, data)) return false;
            setLink(member, n.host, n.group, 'invited', now, { body: null });
            break;
        }
        case 'removed':
            if (state !== 'invited' && state !== 'in') return false;
            setLink(member, n.host, n.group, 'removed', now, { body: null });
            if (!mayHold(member, data)) return true;
            break;
        case 'roster':
            if (state !== 'in') return false;
            // Kept whatever the caps say: a phone that missed a held one still has the latest (step 1).
            setLink(member, n.host, n.group, 'in', now, { body: JSON.stringify(data) });
            if (!mayHold(member, data)) return true;
            break;
        case 'line':
        case 'epoch':
            if (state !== 'in' || !mayHold(member, data)) return false;
            break;
    }
    const body = JSON.stringify(data);
    db.prepare('INSERT INTO group_guest_mail (id, member, host, group_id, kind, body, bytes, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), member, n.host, n.group, n.kind, body, body.length, now);
    return true;
}

/** Whether one more notice of this size may wait for `member`: their unconfirmed notices under both caps. */
function mayHold(member: string, data: Record<string, unknown>): boolean {
    if (sum(`SELECT COUNT(*) AS n FROM group_guest_mail WHERE ${UNCONFIRMED}`, member) >= GROUP_MAIL_PER_MEMBER_ITEMS) return false;
    return sum(`SELECT COALESCE(SUM(bytes), 0) AS n FROM group_guest_mail WHERE ${UNCONFIRMED}`, member) + JSON.stringify(data).length <= GROUP_MAIL_PER_MEMBER_BYTES;
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
    const links = db.prepare(`SELECT * FROM group_guest_links WHERE member = ? AND state IN ('invited', 'in', 'removed') ORDER BY state_at, host, group_id`).all(member) as LinkRow[];
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
    return dropNotices(member, done);
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

/** The link an item moves `member` to, or why they may not send it (an answer only to an invitation waiting, the rest only once in). */
function linkAfter(member: string, c: Checked): LinkState | null | 'refused' {
    const state = linkOf(member, c.envelope.recipientHome, c.groupId)?.state ?? null;
    if (c.envelope.kind === 'group-invite') {
        let answer: unknown;
        try { answer = (JSON.parse(c.payload) as { v?: unknown; answer?: unknown }).v === 1 ? JSON.parse(c.payload).answer : null; } catch { answer = null; }
        if (state !== 'invited' || (answer !== 'yes' && answer !== 'no')) return 'refused';
        return answer === 'yes' ? 'in' : 'declined';
    }
    if (c.envelope.kind === 'group-leave') return state === 'in' || state === 'invited' ? 'left' : 'refused';
    return state === 'in' ? null : 'refused';
}

/**
 * `member`'s group items (the file's header, "out"), checked, kept and sent to each host now; each item's state after the
 * first try, with the host's refusal when it gave one. Throws OutboxError, having stored nothing, when guests or the mailbox
 * are switched off, on a standby, or when an item is not theirs to send. An item sent again keeps its row and answers it.
 */
export async function sendGroupItems(member: string, items: unknown[], now = Date.now()): Promise<GroupSentState[]> {
    if (!groupGuestsOn()) throw new OutboxError(403, 'guests_off', GUESTS_OFF_ERROR);
    if (getNodeRole() === 'backup') throw new OutboxError(503, 'standby', "This is a community's standby server: send from its main server.");
    const home = ownNodeHome();
    if (!home) throw new OutboxError(503, 'no_home', "This community's server knows none of its own names yet, so it can't send to another community.");
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
    if (today + fresh.length > OUTBOX_PER_MEMBER_DAY) throw new OutboxError(429, 'rate_limited', word("You've sent a lot to other communities today. Try again tomorrow."));
    db.transaction(() => {
        const insert = db.prepare(`INSERT INTO group_guest_sent (sender_key, item_id, kind, host, group_id, state, item, attempts, next_try_at, created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?) ON CONFLICT (sender_key, item_id) DO NOTHING`);
        for (const c of fresh) {
            const next = linkAfter(member, c);
            if (next === 'refused') throw new OutboxError(403, 'not_in_group', NOT_IN_GROUP_ERROR);
            if (next) setLink(member, c.envelope.recipientHome, c.groupId, next, now, next === 'in' ? undefined : { body: null });
            // Behind every row already waiting for that host, whatever the clock did: each host's items go oldest first.
            const last = db.prepare("SELECT MAX(created_at) FROM group_guest_sent WHERE host = ? AND state = 'queued'").pluck().get(c.envelope.recipientHome) as number | null;
            const at = last !== null && last >= now ? last + 1 : now;
            insert.run(member, c.envelope.itemId, c.envelope.kind, c.envelope.recipientHome, c.groupId,
                JSON.stringify({ envelope: c.envelope, payload: c.payload }), now, at, now);
        }
    })();
    await Promise.all([...new Set(fresh.map((c) => c.envelope.recipientHome))].map((host) => sendToHost(host, now)));
    const rows = db.prepare(`SELECT item_id, state, refused FROM group_guest_sent WHERE sender_key = ? AND item_id IN (${checked.map(() => '?').join(', ')})`)
        .all(member, ...checked.map((c) => c.envelope.itemId)) as Array<{ item_id: string; state: string; refused: string | null }>;
    const of = new Map(rows.map((r) => [r.item_id, r]));
    return checked.filter((c) => of.has(c.envelope.itemId)).map((c) => {
        const r = of.get(c.envelope.itemId)!;
        return r.refused ? { itemId: r.item_id, state: r.state, refused: r.refused } : { itemId: r.item_id, state: r.state };
    });
}

interface SentRow { sender_key: string; item_id: string; item: string; attempts: number; next_try_at: number; created_at: number }

/** Each host being sent to now: one send a host at a time, every host on its own (as the host's fan-out is). */
const sendingTo = new Map<string, Promise<void>>();

function sendToHost(host: string, now: number): Promise<void> {
    const running = sendingTo.get(host);
    if (running) return running.then(() => sendToHost(host, now));
    const send = sendHostQueue(host, now).finally(() => sendingTo.delete(host));
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
 * time (nextFanoutTry), for GROUP_SENT_QUEUE_MS. `now` is the clock the send starts at.
 */
async function sendHostQueue(host: string, now: number): Promise<void> {
    const started = Date.now();
    const clock = () => now + (Date.now() - started);
    const url = `https://${host}${RELAY_MAIL_PATH}`;
    for (;;) {
        const queue = db.prepare(`SELECT sender_key, item_id, item, attempts, next_try_at, created_at FROM group_guest_sent
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
        const at = clock();
        const settle = db.prepare(`UPDATE group_guest_sent SET state = ?, refused = ?, item = NULL, next_try_at = NULL, updated_at = ?
                                   WHERE sender_key = ? AND item_id = ? AND state = 'queued'`);
        if (status >= 200 && status < 300) {
            db.transaction(() => {
                batch.forEach((r, i) => {
                    const refused = refusedAt(body, i, (travelling[i] as { envelope: RelayEnvelope }).envelope.itemId, batch.length);
                    settle.run(refused ? 'refused' : 'sent', refused, at, r.sender_key, r.item_id);
                });
                db.prepare("UPDATE group_guest_sent SET attempts = 0 WHERE host = ? AND state = 'queued' AND attempts > 0").run(host);
            })();
            continue;
        }
        if (status === 400 || status === 413) {
            db.transaction(() => { for (const r of batch) settle.run('failed', null, at, r.sender_key, r.item_id); })();
            logger.warn('SYS', `Group guests: ${host} refused a request of ${batch.length} item(s) (status ${status}); their senders see Not delivered.`);
            continue;
        }
        const next = nextFanoutTry(batch[0].attempts, batch[0].next_try_at, at);
        db.transaction(() => {
            db.prepare(`UPDATE group_guest_sent SET state = 'failed', item = NULL, next_try_at = NULL, updated_at = ?
                        WHERE host = ? AND state = 'queued' AND created_at <= ?`).run(at, host, at - GROUP_SENT_QUEUE_MS);
            db.prepare("UPDATE group_guest_sent SET attempts = ?, next_try_at = ? WHERE host = ? AND state = 'queued'").run(next.attempts, next.nextTryAt, host);
        })();
        return;
    }
}

/** The minute timer's turn (https-server.ts): each host with an item due is sent to again. Never on a standby. */
export async function retryGroupSent(now = Date.now()): Promise<number> {
    if (getNodeRole() === 'backup' || !groupGuestsOn()) return 0;
    const hosts = db.prepare("SELECT DISTINCT host FROM group_guest_sent WHERE state = 'queued' AND next_try_at <= ?").pluck().all(now) as string[];
    await Promise.all(hosts.map((h) => sendToHost(h, now)));
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
    const failed = db.prepare(`UPDATE group_guest_sent SET state = 'failed', item = NULL, next_try_at = NULL, updated_at = ? WHERE state = 'queued' AND created_at < ?`)
        .run(now, now - GROUP_SENT_QUEUE_MS).changes;
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
