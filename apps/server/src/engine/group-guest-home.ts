/**
 * Guests in a group's chat from other communities, on the GUEST'S OWN community's server (slice G1b: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §4.2; DESIGN-forums-messaging-joint-fable.md §2.3; the host's side is
 * engine/group-guests.ts, #3197). A member here is the guest; the group lives at its host. Their phone never talks to the
 * host: everything goes through this server.
 *
 *   in    the host brings what it tells this member's devices in a request it signs, to POST /api/relay/group
 *         (receiveGroupNotice): `{ v: 1, kind, group, host, guests, data }`, one request per community naming that
 *         community's guests, never one per guest. Kinds: an invitation, the roster (the names in the chat and the current
 *         epoch), a line, a line edited or taken down (`edit`), an epoch, a removal (`why`: a convenor's Remove, the owners'
 *         switch, or the group closed). Each named guest gets the notice when, and only when:
 *           - the request's signer is the host it names (the node signature door, engine/node-signature.ts, proved who);
 *           - the guest is a member here who reads as one;
 *           - an invitation: it is not waiting already (counted once per host and group: a repeat holds nothing), they are
 *             not joining or in that group, have not blocked who invited them, it carries at most GROUP_INVITE_MAX_CHARS,
 *             and they have at most GROUP_INVITES_WAITING invitations waiting (GROUP_INVITES_WAITING_PER_HOST from one host);
 *           - anything else: they ANSWERED that host for that group: `in` (group_guest_links), or `joining` (their yes
 *             still queued here, group_guest_sent) for a roster, a line, an edit or an epoch; for a removal also `invited` (the
 *             invitation withdrawn: the link goes, so a host nobody answered keeps no row here). A host nobody here
 *             answered brings nothing but invitations.
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
 *         (`POST /api/mail/group/confirm`); a notice goes once every device listed has it, or after MAIL_HELD_DAYS, and
 *         none held longer is served, swept yet or not: the host offers its takedowns that long and a day more.
 *         TAKEDOWNS (applyToHeldCopies, #3233 round 2): what the host says of a line reaches every copy of it held here
 *         before anything else, whatever the member stands now, whatever the switch, from a host the owners blocked since
 *         too (it only takes away what that host brought): a line taken down (`edit`, `action: 'removed'`) drops the held
 *         line and its edits, words and sealed photo or voice, so no device fetching later is handed them, and the removal
 *         is held as any notice is, for the devices that already took the line; an edit replaces the held line's words and
 *         drops an older edit, so a device is served only the newest words. OUT OF THE GROUP (dropHeldWords), however it
 *         comes: a removal the host sent (any reason, a group closed included), one this server works out (a newer
 *         invitation to someone in, held or not: outOfGroup), their leave taken (moveLinkOn). Every held line of it and
 *         edit with new words goes, as a member who leaves a chat is served none of it after; a held TAKEDOWN stays, for a
 *         device that took the line before and still shows it; and their devices are told they are out by a `removed`
 *         notice, held as the host's own is (their leave excepted: their own device sent it). Each held notice is stored
 *         under the allowance it was checked against (holdFor), worked out from where they stand AFTER what it changed.
 *   kept  the latest roster from each host for each group, per member (group_guest_links.roster), is step 1 of #3197's four:
 *         a phone that heard `epoch-stale` waits for the roster (step 2), then core's guestEpochStep makes the next epoch
 *         (stale or none: step 3) or opens the key and sends the line again (not stale: step 4). The fetch serves it beside
 *         the held notices, so a new device has it too.
 *   out   a member's own items to a group at a host (their yes or no to an invitation, a leave, a line, an epoch:
 *         `group-invite`, `group-leave`, `group-line`, `group-epoch`, recipient `group:<id>`) come through
 *         `POST /api/mail/send` (sendGroupItems) and go to the host's POST /api/relay/mail in a request this server signs.
 *         Checked as the mailbox checks a line (their envelope, signed, naming this server as their home), and against
 *         where they stand with that group: an answer only to an invitation waiting, a line or an epoch only once in, and
 *         nothing more after a leave or an answer still waiting for that group. While their yes is queued they are `joining`,
 *         so the roster that follows it is taken; the link moves ONLY on the host's answer (moveLinkOn): a yes, no or leave
 *         the host took (a 2xx that doesn't refuse it) moves it to `in`, `declined` or `left`, ordered with the host's notices
 *         by the counter the host's answer carries (the order rule: an answer older than the newest word taken moves
 *         nothing, and a newer one is the newest word taken; a roster with a counter naming them, taken while their yes
 *         is queued, is the host's word that they are in, and moves the link there); one it refused, a 400/413,
 *         or a day of no answer leaves it where it was (a yes not taken: the invitation still waiting, to answer again, and
 *         a roster taken meanwhile gone). Kept in group_guest_sent while
 *         the host hasn't taken it, for each host strictly oldest first (an epoch before the line under it), tried again
 *         with backoff by time (group-guests.ts nextFanoutTry) for a day. The host's answer for each item is kept, so the
 *         phone hears `epoch-stale` (and waits for the roster) or `group-refused`.
 *
 * **A standby** copies group_guest_links (a plain table), so a promoted standby still knows which hosts its members
 * answered; the held notices and the sent items are this server's own (`local`), never in a copy, as the mailbox's are.
 * So the copy holds only states a promoted standby can settle from the copy alone (#3217 round 2, invariant D): `joining`
 * is never stored, it is read from this server's own queue (a yes still queued: standingOf). A link copied while a yes
 * waited reads `invited` after a take-over, and the member answers again (a host that took the first yes takes a second
 * as received). A standby takes no notice (it answers as the main server does and writes nothing), sends no member's item,
 * and its timer sweeps only this server's own tables: nothing it runs writes a copied row (setLink throws there,
 * moveLinkOn writes nothing). Its held lines and edits can't be kept up to date there (the host's takedowns go to the
 * server that took over), so it serves none and drops them, as it does at every role change (heldLinesStale, #3233 round 3).
 */
import crypto from 'node:crypto';
import { readRelayEnvelope, relayEnvelopeVerifies, relayPayloadHash, word, type RelayEnvelope } from '@beanpool/core';
import { db } from '../db/db.js';
import { assertPlainTablesWritable, getNodeRole, onNodeRoleChange, STANDBY_WRITE_MESSAGE, standbyWritesNothing } from '../config/node-role.js';
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
export const GROUP_NOTICE_KINDS = ['invite', 'roster', 'line', 'edit', 'epoch', 'removed'] as const;
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

/** What group_guest_links stores: only what the host's answers and notices set, so a copy alone can settle each. */
type LinkState = 'invited' | 'in' | 'declined' | 'left' | 'removed';
/** Where a member stands, as their device reads it: `joining` is an invitation with their yes still queued here. */
type Standing = LinkState | 'joining';
interface LinkRow { member: string; host: string; group_id: string; state: LinkState; roster: string | null; roster_at: number | null }

const KEY_HEX = /^[0-9a-f]{64}$/;
const GROUP_ID = /^[0-9A-Za-z_-]{1,64}$/;
const ITEM_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function linkOf(member: string, host: string, groupId: string): LinkRow | undefined {
    return db.prepare('SELECT * FROM group_guest_links WHERE member = ? AND host = ? AND group_id = ?').get(member, host, groupId) as LinkRow | undefined;
}

/** A yes of the member's to that link's invitation, still queued here (`l` names the link's row). */
const YES_QUEUED = (l: string) => `EXISTS (SELECT 1 FROM group_guest_sent s WHERE s.sender_key = ${l}.member AND s.host = ${l}.host
    AND s.group_id = ${l}.group_id AND s.state = 'queued' AND s.answer = 'yes')`;

/** Where `member` stands with that group (the file's header): the stored state, or `joining` while their yes is queued. */
function standingOf(member: string, host: string, groupId: string): Standing | null {
    const row = db.prepare(`SELECT l.state, ${YES_QUEUED('l')} AS yes FROM group_guest_links l WHERE l.member = ? AND l.host = ? AND l.group_id = ?`)
        .get(member, host, groupId) as { state: LinkState; yes: number } | undefined;
    if (!row) return null;
    return row.state === 'invited' && row.yes ? 'joining' : row.state;
}

/** Writes a link (a copied row): never on a standby (node-role.ts assertPlainTablesWritable). */
function setLink(member: string, host: string, groupId: string, state: LinkState, now: number, roster?: { body: string | null }): void {
    assertPlainTablesWritable();
    db.prepare(`INSERT INTO group_guest_links (member, host, group_id, state, roster, roster_at, state_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)
                ON CONFLICT (member, host, group_id) DO UPDATE SET state = excluded.state, state_at = excluded.state_at`)
        .run(member, host, groupId, state, now);
    if (roster) db.prepare('UPDATE group_guest_links SET roster = ?, roster_at = ? WHERE member = ? AND host = ? AND group_id = ?')
        .run(roster.body, roster.body === null ? null : now, member, host, groupId);
}

// ── What a host brings ──────────────────────────────────────────────────────────────────────

/** `seq`: the host's order counter (engine/group-guests.ts issueGuestSeq), on what says where a guest stands or takes away. */
interface Notice { kind: GroupNoticeKind; group: string; host: string; guests: string[]; seq: number | null; data: Record<string, unknown> }

/** A notice as the host sends one (engine/group-guests.ts queueToHome), or null. */
export function readGroupNotice(raw: unknown): Notice | null {
    if (!isObject(raw) || raw.v !== 1) return null;
    const { kind, group, host, guests, seq, data } = raw;
    if (typeof kind !== 'string' || !(GROUP_NOTICE_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof group !== 'string' || !GROUP_ID.test(group) || typeof host !== 'string' || host.length < 1 || host.length > 260) return null;
    if (!Array.isArray(guests) || guests.length < 1 || guests.length > GROUP_GUESTS_MAX || !guests.every((g) => typeof g === 'string' && KEY_HEX.test(g))) return null;
    if (seq !== undefined && !(typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0)) return null;
    if (new Set(guests).size !== guests.length || !isObject(data)) return null;
    return { kind: kind as GroupNoticeKind, group, host, guests: guests as string[], seq: typeof seq === 'number' ? seq : null, data };
}

// ── The order rule (G2): the newest word of the host's on where a member stands wins ─────────────────

/**
 * The kinds that say where a member stands with a group (engine/group-guests.ts queueToHome stamps each with the group's
 * counter): an invitation, a removal (its withdrawal, when only invited), the roster (they are in).
 */
const STANDING_KINDS: ReadonlySet<GroupNoticeKind> = new Set(['invite', 'removed', 'roster']);

/**
 * THE ORDER RULE at the home (G2; the host's side is engine/group-guests.ts, "The order rule"): of the host's notices that
 * say where `member` stands with a group, only one with a counter newer than the newest this server took for them
 * (group_guest_order) changes anything; an older or repeated one, from either of the host's servers (the main one, the one
 * that took over, the first after a take-back), arriving in any order, after any outage, is dropped, a removal's drop of
 * the held lines included. So nothing undoes a newer invitation or removal, and a home keeps the newest roster. A notice
 * with no counter (a host from before the rule) is taken as before.
 */
function olderThanTaken(member: string, n: Notice): boolean {
    return n.seq !== null && STANDING_KINDS.has(n.kind) && seqOlderThanTaken(member, n.host, n.group, n.seq);
}

/**
 * Whether `seq` is no newer than the newest word on where `member` stands with that group taken here: a notice's, or the
 * host's answer to their own yes, no or leave (moveLinkOn: THE GUEST'S OWN WORD, engine/group-guests.ts).
 */
function seqOlderThanTaken(member: string, host: string, groupId: string, seq: number): boolean {
    const taken = db.prepare('SELECT seq FROM group_guest_order WHERE member = ? AND host = ? AND group_id = ?').pluck().get(member, host, groupId) as number | undefined;
    return taken !== undefined && seq <= taken;
}

/** The newest counter taken for `member` moves on to `n`'s (a copied row: never on a standby). */
function noteTaken(member: string, n: Notice): void {
    if (n.seq === null || !STANDING_KINDS.has(n.kind)) return;
    noteSeq(member, n.host, n.group, n.seq);
}

/** The newest counter taken for `member` with that group moves on to `seq` (a copied row: never on a standby). */
function noteSeq(member: string, host: string, groupId: string, seq: number): void {
    assertPlainTablesWritable();
    db.prepare(`INSERT INTO group_guest_order (member, host, group_id, seq) VALUES (?, ?, ?, ?)
                ON CONFLICT (member, host, group_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`).run(member, host, groupId, seq);
}

/** The lines a takedown names: `ids` (an account's many, engine/group-guests.ts queueTakedowns) or its one `id`. */
function takedownIds(data: Record<string, unknown>): string[] {
    if (Array.isArray(data.ids)) return data.ids.filter((id): id is string => typeof id === 'string');
    return typeof data.id === 'string' ? [data.id] : [];
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
/** A held notice that carries a line's words (a line, an edit with new words): never a takedown, which only takes away. */
const HELD_WORDS = `(kind = 'line' OR (kind = 'edit' AND (CASE WHEN json_valid(body) THEN json_extract(body, '$.action') END) IS NOT 'removed'))`;
const NO_DEVICE_HAS = `NOT EXISTS (SELECT 1 FROM group_guest_mail_got g WHERE g.member = group_guest_mail.member AND g.mail_id = group_guest_mail.id)`;

/**
 * What this server makes of a notice the host `origin` (the home its request was verified as) brought: held for each named
 * guest it may reach, dropped for every other, answered alike (the file's header).
 */
export function receiveGroupNotice(origin: string, raw: unknown, now = Date.now()): GroupNoticeAnswer {
    const n = readGroupNotice(raw);
    if (!n) return { status: 400, body: { error: 'A group notice is { v: 1, kind, group, host, guests, data }.', code: 'bad_notice' } };
    if (n.host !== origin) return { status: 400, body: { error: "A group notice comes from its group's host, which signs it.", code: 'wrong_host' } };
    if (getNodeRole() === 'backup') return RECEIVED;
    // A takedown first, for every guest named: it only takes away what this host brought, so it applies whatever the switch,
    // from a host the owners blocked too (the file's header, "held"). An edit's new words are taken only as the notice is.
    const taking = groupGuestsOn() && !isServerBlocked(origin);
    for (const member of n.guests) {
        try {
            db.transaction(() => applyToHeldCopies(member, n, taking))();
        } catch (e) {
            logger.warn('SYS', `Group guests: a host's takedown could not reach what is held (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
        }
    }
    if (!taking) return RECEIVED;
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

/**
 * What a notice says of the copies held here for `member` (the file's header, "held"), before anything is held: a line
 * taken down drops its held line and edits; a removal (any reason) drops every line of that group held for them; an edit,
 * when the notice is taken (`taking`), replaces the held line's words and drops an older edit. Only that host's own
 * notices for that group are touched.
 */
function applyToHeldCopies(member: string, n: Notice, taking: boolean): void {
    // A removal older than the newest word taken for them (the order rule) drops nothing: they were invited again since.
    if (n.kind === 'removed') { if (!olderThanTaken(member, n)) dropHeldWords(member, n.host, n.group); return; }
    if (n.kind !== 'edit') return;
    if (n.data.action === 'removed') { dropHeldLinesOf(member, n.host, n.group, new Set(takedownIds(n.data))); return; }
    const id = n.data.id;
    if (n.data.action === 'edited' && taking && typeof id === 'string') replaceHeldWords(member, n.host, n.group, id, n.data);
}

/** The edits of line `id` held for `member` (`edited` ones only): what a newer edit, once held, replaces. */
function heldEditsOf(member: string, host: string, groupId: string, id: string): string[] {
    return db.prepare(`SELECT id FROM group_guest_mail WHERE member = ? AND host = ? AND group_id = ? AND kind = 'edit'
                       AND json_extract(body, '$.id') = ? AND json_extract(body, '$.action') = 'edited'`).pluck().all(member, host, groupId, id) as string[];
}

/**
 * OUT OF THE GROUP (the file's header, "held"): `member`'s held copies of `host`'s lines in that group that carry words
 * (HELD_WORDS: each line, each edit with new words) go; a held takedown stays, for a device that still shows the line. How
 * many went.
 */
function dropHeldWords(member: string, host: string, groupId: string): number {
    const ids = db.prepare(`SELECT id FROM group_guest_mail WHERE member = ? AND host = ? AND group_id = ? AND ${HELD_WORDS}`).pluck().all(member, host, groupId) as string[];
    return dropNotices(member, ids);
}

/** `member`'s held copies of `host`'s lines `ids` in that group (each line and its edits), in one read: dropped. How many. */
function dropHeldLinesOf(member: string, host: string, groupId: string, ids: ReadonlySet<string>): number {
    if (!ids.size) return 0;
    const held = db.prepare(`SELECT id, CASE WHEN json_valid(body) THEN json_extract(body, '$.id') END AS line FROM group_guest_mail
                             WHERE member = ? AND host = ? AND group_id = ? AND kind IN ('line', 'edit')`).all(member, host, groupId) as Array<{ id: string; line: unknown }>;
    return dropNotices(member, held.filter((h) => typeof h.line === 'string' && ids.has(h.line)).map((h) => h.id));
}

/**
 * An edit of line `id`: the held line takes its words (and the edit's time). An older edit held for it goes only once this
 * one is held (takeNoticeFor): refused (the host's allowance full), a device that has the line but not the older edit
 * keeps that edit's words, not the first ones (#3233 round 3).
 */
function replaceHeldWords(member: string, host: string, groupId: string, id: string, edit: Record<string, unknown>): void {
    if (typeof edit.ciphertext !== 'string' || typeof edit.nonce !== 'string') return;
    const of = `FROM group_guest_mail WHERE member = ? AND host = ? AND group_id = ? AND json_extract(body, '$.id') = ?`;
    const rewrite = db.prepare('UPDATE group_guest_mail SET body = ?, bytes = ? WHERE id = ?');
    for (const r of db.prepare(`SELECT id, body ${of} AND kind = 'line'`).all(member, host, groupId, id) as Array<{ id: string; body: string }>) {
        const body = JSON.stringify({ ...JSON.parse(r.body), ciphertext: edit.ciphertext, nonce: edit.nonce, metadata: edit.metadata ?? null, editedAt: edit.editedAt ?? null });
        rewrite.run(body, body.length, r.id);
    }
}

/** One named guest: the notice held for them, or dropped (the file's header says when). True when held. */
function takeNoticeFor(member: string, n: Notice, now: number): boolean {
    if (!isNodeMember(member) || !readsAsMember(member)) return false;
    // The order rule: an older word on where they stand changes nothing; a newer one is the newest taken, held or not.
    if (olderThanTaken(member, n)) return false;
    noteTaken(member, n);
    const standing = standingOf(member, n.host, n.group);
    // Under a link they answered: a roster, a line, an edit or an epoch moves no link, so this is where they stand after it
    // too. A notice that moves the link names the allowance where it leaves them (holdFor), never this.
    const answered = standing === 'joining' || standing === 'in';
    const state = linkOf(member, n.host, n.group)?.state ?? null;
    const body = JSON.stringify(dataFor(member, n));
    switch (n.kind) {
        case 'invite': {
            // Once per host and group: waiting or joining already, a repeat holds nothing and moves nothing. In already: a
            // repeat too, unless it is newer than the newest word taken for them (the order rule): the host took them out
            // and asked again, and the removal never came here (it waited on a server that was taken over, or it is
            // older and comes later). Then they are OUT first, exactly as the host's removal makes them (outOfGroup), and
            // invited again; or, if the invitation itself can't be held (too large, from someone they blocked, past an
            // allowance), out all the same: the newest word says they are no longer in.
            const reinvited = standing === 'in' && n.seq !== null;
            if (state === 'invited' || (answered && !reinvited)) return false;
            const inviter = isObject(n.data.invitedBy) ? n.data.invitedBy.key : null;
            // Waiting: an invitation not yet answered (a yes queued is `joining`, not waiting, as it always was).
            const waiting = (host?: string) => sum(`SELECT COUNT(*) AS n FROM group_guest_links l WHERE l.member = ? AND l.state = 'invited' AND NOT ${YES_QUEUED('l')}${host ? ' AND l.host = ?' : ''}`,
                member, ...(host ? [host] : []));
            const refused = body.length > GROUP_INVITE_MAX_CHARS || (typeof inviter === 'string' && KEY_HEX.test(inviter) && hasBlocked(member, inviter))
                || waiting() >= GROUP_INVITES_WAITING || waiting(n.host) >= GROUP_INVITES_WAITING_PER_HOST || !mayHold(member, n.host, false, body.length);
            const out = reinvited && outOfGroup(member, n, now);
            if (refused) return out;
            setLink(member, n.host, n.group, 'invited', now, { body: null });
            // Unanswered, as checked above: an invitation leaves them invited, whatever link it came under.
            return holdFor(member, n, 'invite', body, false, now) || out;
        }
        case 'removed':
            if (standing === 'invited') {
                // The invitation withdrawn: no row is kept for a host they never answered; the notice counts as an invitation.
                assertPlainTablesWritable();
                db.prepare('DELETE FROM group_guest_links WHERE member = ? AND host = ? AND group_id = ?').run(member, n.host, n.group);
                return body.length <= GROUP_INVITE_MAX_CHARS && holdFor(member, n, 'removed', body, false, now);
            }
            if (!answered) return false;
            setLink(member, n.host, n.group, 'removed', now, { body: null });
            // A removal leaves a link they answered (`removed`), and counts there.
            return holdFor(member, n, 'removed', body, true, now);
        case 'roster': {
            if (!answered) return false;
            // While their yes is still queued here (`joining`), a roster with a counter that names them among the guests in is
            // the host's newest word on where they stand (older and repeated ones never reach here: the order rule): they
            // are in, so the link is too, whenever the host's answer to the yes lands, and whatever it says (older: it moves
            // nothing, moveLinkOn). One with no counter (a host from before the rule) moves no link, as before.
            const named = Array.isArray(n.data.guests) && n.data.guests.some((x) => isObject(x) && x.key === member);
            // Kept whatever the caps say (one per group they answered): a phone that missed a held one still has the latest (step 1).
            setLink(member, n.host, n.group, standing === 'joining' && n.seq !== null && named ? 'in' : state!, now, { body });
            return holdFor(member, n, 'roster', body, true, now);
        }
        case 'edit': {
            if (!answered) return false;
            // An edit's new words: the older edit held for that line goes once this one is held, never before (replaceHeldWords).
            const older = n.data.action === 'edited' && typeof n.data.id === 'string' ? heldEditsOf(member, n.host, n.group, n.data.id) : [];
            return holdFor(member, n, 'edit', body, true, now, older);
        }
        case 'line':
        case 'epoch':
            return answered && holdFor(member, n, n.kind, body, true, now);
    }
}

/** What a removal this server works out (outOfGroup) tells the devices: what the host's own convenor's Remove says. */
const OUT_NOTICE = JSON.stringify({ why: 'removed' });

/**
 * A removal this server works out (a newer invitation to someone in, held or not: takeNoticeFor), with exactly what the
 * host's own removal does here (applyToHeldCopies, then takeNoticeFor's `removed`): the lines' words dropped and takedowns
 * kept (dropHeldWords), the link `removed`, and a `removed` notice held for their devices under the answered allowance,
 * before anything the same notice holds, so a device hears it first. True when that notice was held.
 */
function outOfGroup(member: string, n: Notice, now: number): boolean {
    dropHeldWords(member, n.host, n.group);
    setLink(member, n.host, n.group, 'removed', now, { body: null });
    return holdFor(member, n, 'removed', OUT_NOTICE, true, now);
}

/**
 * `body` held for `member`'s devices as a `kind` notice from `n`'s host and group, when the allowance `answered` names has
 * room (mayHold): the flag stored is the one checked, so a notice always counts, and is trimmed (settleGroupMailFor),
 * where it was let in. `replacing` (the older edits a new edit replaces) counts as gone, and goes once this one is held.
 * True when held.
 */
function holdFor(member: string, n: Notice, kind: GroupNoticeKind, body: string, answered: boolean, now: number, replacing: readonly string[] = []): boolean {
    if (!mayHold(member, n.host, answered, body.length, replacing)) return false;
    dropNotices(member, [...replacing]);
    db.prepare('INSERT INTO group_guest_mail (id, member, host, group_id, kind, body, bytes, answered, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), member, n.host, n.group, kind, body, body.length, answered ? 1 : 0, now);
    return true;
}

/**
 * Whether one more notice of `bytes` from `host` may wait for `member`, against its own allowance only (the file's header):
 * unanswered, every one held counts, from that host and in all (each at most GROUP_INVITE_MAX_CHARS); answered, that
 * host's that no device has. Another host's notices never count against a host's allowance, nor push one out. `replacing`
 * (the older edits a new edit replaces once held) counts as gone.
 */
function mayHold(member: string, host: string, answered: boolean, bytes: number, replacing: readonly string[] = []): boolean {
    if (!answered) {
        return sum('SELECT COUNT(*) AS n FROM group_guest_mail WHERE member = ? AND host = ? AND answered = 0', member, host) < GROUP_INVITES_WAITING_PER_HOST
            && sum('SELECT COUNT(*) AS n FROM group_guest_mail WHERE member = ? AND answered = 0', member) < GROUP_INVITES_WAITING;
    }
    const except = replacing.length ? ` AND id NOT IN (${replacing.map(() => '?').join(', ')})` : '';
    const of = `FROM group_guest_mail WHERE member = ? AND host = ? AND answered = 1 AND ${NO_DEVICE_HAS}${except}`;
    return sum(`SELECT COUNT(*) AS n ${of}`, member, host, ...replacing) < GROUP_MAIL_PER_HOST_ITEMS
        && sum(`SELECT COALESCE(SUM(bytes), 0) AS n ${of}`, member, host, ...replacing) + bytes <= GROUP_MAIL_PER_HOST_BYTES;
}

// ── The member's devices: fetch and confirm ─────────────────────────────────────────────────

export interface HeldGroupNotice { id: string; host: string; group: string; kind: GroupNoticeKind; data: unknown; receivedAt: number }
export interface GroupLinkView { host: string; group: string; state: Standing; roster: unknown; rosterAt: number | null }
export interface GroupSentTick { itemId: string; kind: string; host: string; group: string; state: string; refused: string | null; at: number }

/** The last page's `linksAt` (heldGroupMailFor). */
let lastLinksAt = 0;

/**
 * What waits for `member` that `device` has not confirmed, oldest first, a page at a time; where they stand with each group
 * at another community, each with its latest roster (step 1); and what became of their own items to groups after the
 * device's last tick (`since`, `sinceId`, as the mailbox's ticks are paged). `linksAt` is this server's clock when `groups`
 * was read, the whole list as it stood then: a device that has applied a page with a later `linksAt` (another tab or
 * window of the same device, whose fetch went out after and came back first) moves nothing by this page's `groups`, so a
 * stale page never takes away an invitation a later one brought (G2 round 2, #3246 round 2 note: the apps' rule).
 */
export function heldGroupMailFor(member: string, device: string, since = 0, sinceId = ''): {
    items: HeldGroupNotice[]; more: boolean; groups: GroupLinkView[]; linksAt: number; sent: GroupSentTick[]; sentMore: boolean;
} {
    // Strictly later than every page before it (two in the same millisecond included), and after a restart the clock's.
    const linksAt = lastLinksAt = Math.max(Date.now(), lastLinksAt + 1);
    // A standby serves no copy of a line (the copy rule, heldLinesStale): what it holds can't be kept up to date there.
    // Nothing held past MAIL_HELD_DAYS is served, swept yet or not (a server off for a month, back before its first sweep):
    // the host offers a take-away that long and a day more (group-guests.ts guestRowKeptMs), never shorter (#3233 round 4).
    const rows = db.prepare(`SELECT id, host, group_id, kind, body, received_at FROM group_guest_mail m WHERE member = ? AND received_at >= ?
                               AND NOT EXISTS (SELECT 1 FROM group_guest_mail_got g WHERE g.member = m.member AND g.mail_id = m.id AND g.device = ?)
                               ${getNodeRole() === 'backup' ? `AND NOT ${HELD_WORDS}` : ''}
                             ORDER BY received_at, rowid LIMIT ?`).all(member, Date.now() - MAIL_HELD_DAYS * DAY_MS, device, MAIL_FETCH_PAGE + 1) as Array<{
        id: string; host: string; group_id: string; kind: GroupNoticeKind; body: string; received_at: number;
    }>;
    const links = db.prepare(`SELECT l.*, ${YES_QUEUED('l')} AS yes FROM group_guest_links l WHERE l.member = ? AND l.state IN ('invited', 'in', 'removed')
                              ORDER BY l.state_at, l.host, l.group_id`).all(member) as Array<LinkRow & { yes: number }>;
    const sent = db.prepare(`SELECT item_id, kind, host, group_id, state, refused, updated_at FROM group_guest_sent
                             WHERE sender_key = ? AND (updated_at > ? OR (updated_at = ? AND item_id > ?)) ORDER BY updated_at, item_id LIMIT ?`)
        .all(member, since, since, sinceId, MAIL_FETCH_PAGE + 1) as Array<{ item_id: string; kind: string; host: string; group_id: string; state: string; refused: string | null; updated_at: number }>;
    return {
        items: rows.slice(0, MAIL_FETCH_PAGE).map((r) => ({ id: r.id, host: r.host, group: r.group_id, kind: r.kind, data: JSON.parse(r.body), receivedAt: r.received_at })),
        more: rows.length > MAIL_FETCH_PAGE,
        groups: links.map((l) => ({
            host: l.host, group: l.group_id, state: l.state === 'invited' && l.yes ? 'joining' : l.state, roster: l.roster ? JSON.parse(l.roster) : null, rosterAt: l.roster_at,
        })),
        linksAt,
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

/**
 * THE COPY RULE at the home (#3233 round 3): a held copy of a host's line (`line`, `edit`) is served only while this server
 * has been the main one since it was held. On a standby, the host's takedowns go to the server that took over (and one that
 * reaches a standby is answered and dropped, receiveGroupNotice), so a copy held here before can no longer be kept up to
 * date: every held line and edit with new words (HELD_WORDS), for every member, goes at each role change (demoted, or
 * promoted again: everything a standby holds is from before its demotion), at a standby's sweep (one that started as a
 * standby changed no role in this process), and a standby's fetch serves none meanwhile. A device misses the lines it never
 * fetched, as it does after a take-over (the promoted server starts with none held). Invitations, rosters, epochs, removals
 * and TAKEDOWNS stay, and are served (G2): a takedown only takes away, and is never out of date, so a device that took the
 * line before still hears it went. How many went.
 */
function heldLinesStale(): number {
    const rows = db.prepare(`SELECT member, id FROM group_guest_mail WHERE ${HELD_WORDS}`).all() as Array<{ member: string; id: string }>;
    const byMember = new Map<string, string[]>();
    for (const r of rows) byMember.set(r.member, [...(byMember.get(r.member) ?? []), r.id]);
    let gone = 0;
    for (const [member, ids] of byMember) gone += dropNotices(member, ids);
    return gone;
}

/**
 * A restore or a roll-back replaced this server's database before this start (services/restore-points.ts
 * deliverRestoreNotices, at the boot after it; G2, #3233 round 3's "not covered"): the held copies of hosts' lines it brought
 * back are from the backup's day, and the takedowns hosts sent since went to the database that is gone. So every held line
 * and edit with new words goes, as at a role change (heldLinesStale): a device misses lines it never fetched, never a line
 * taken down. Invitations, rosters, epochs, removals and takedowns stay. Never throws. How many went.
 */
export function heldLinesAfterSwap(): number {
    try {
        const gone = heldLinesStale();
        if (gone) logger.warn('SYS', `Group guests: this server's database was restored or rolled back; ${gone} line(s) held for members' devices went, as hosts' takedowns since then went to the database it replaced.`);
        return gone;
    } catch (e) {
        logger.warn('SYS', `Group guests: the lines held for members' devices could not be dropped after a restore (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
        return 0;
    }
}

onNodeRoleChange(() => {
    try {
        const gone = heldLinesStale();
        if (gone) logger.warn('SYS', `Group guests: this server's role changed; ${gone} line(s) held for members' devices went, as they can no longer be kept up to date.`);
    } catch (e) {
        logger.warn('SYS', `Group guests: the lines held for members' devices could not be dropped at a role change (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
    }
});

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
 * answer while one is (a yes queued is `joining`, its stored link still `invited`).
 */
function maySend(member: string, c: Checked): boolean {
    const host = c.envelope.recipientHome;
    const state = linkOf(member, host, c.groupId)?.state ?? null;
    if (waitingFor(member, host, c.groupId, ['group-leave'])) return false;
    if (c.envelope.kind === 'group-invite') return state === 'invited' && answerOf(c.payload) !== null && !waitingFor(member, host, c.groupId, ['group-invite']);
    if (c.envelope.kind === 'group-leave') return state === 'in' || state === 'invited';
    return state === 'in';
}

/**
 * Where the host's answer for one item moves `member`'s link: only a yes, a no or a leave move it, only when the host took
 * it (`taken`: a 2xx that doesn't refuse it), and only from where that item left it. A yes the host did not take (refused
 * in its answer, a 400/413, or a day of no answer) leaves the invitation waiting, so they can answer again, and drops the
 * roster taken while it was queued. THE GUEST'S OWN WORD (the order rule, G2 follow-ups): the host's answer to a yes, no or
 * leave that moved where they stand carries the group's counter it was stamped with (`seq`, engine/group-guests.ts
 * takeGuestItem), and it is ordered with the host's notices by it: older than the newest word taken here (the host removed
 * or invited them again after it, and that came first), it moves nothing; else it moves the link and is the newest word
 * taken, so an invitation the host told again before it (a take-over's retellGroup), arriving after it, is older and
 * never takes them out. An answer with none (a host from before the rule, or a yes that moved nothing there) moves as
 * before. Settling an item is this server's own business: on a standby (a demoted main server with items still queued) it
 * writes no link, which is its main server's copy (node-role.ts standbyWritesNothing).
 */
function moveLinkOn(member: string, kind: string, host: string, groupId: string, item: string | null, taken: boolean, now: number, seq: number | null = null): void {
    if (standbyWritesNothing()) return;
    let payload = '';
    try { payload = item ? String((JSON.parse(item) as { payload?: unknown }).payload ?? '') : ''; } catch { /* no payload */ }
    const answer = kind === 'group-invite' ? answerOf(payload) : null;
    if (taken && seq !== null && (answer !== null || kind === 'group-leave')) {
        if (seqOlderThanTaken(member, host, groupId, seq)) return;
        noteSeq(member, host, groupId, seq);
    }
    const move = (from: LinkState[], to: LinkState) => db.prepare(`UPDATE group_guest_links SET state = ?, state_at = ?,
            roster = CASE WHEN ? = 'in' THEN roster END, roster_at = CASE WHEN ? = 'in' THEN roster_at END
        WHERE member = ? AND host = ? AND group_id = ? AND state IN (${from.map(() => '?').join(', ')})`).run(to, now, to, to, member, host, groupId, ...from);
    if (answer === 'yes' && taken) move(['invited'], 'in');
    else if (answer === 'yes') {
        db.prepare(`UPDATE group_guest_links SET roster = NULL, roster_at = NULL WHERE member = ? AND host = ? AND group_id = ? AND state = 'invited'
                    AND roster IS NOT NULL`).run(member, host, groupId);
    } else if (answer === 'no' && taken) move(['invited'], 'declined');
    // Out of the group: no line of it held for them is served after (the file's header, "held").
    else if (kind === 'group-leave' && taken && move(['invited', 'in'], 'left').changes) dropHeldWords(member, host, groupId);
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
        const insert = db.prepare(`INSERT INTO group_guest_sent (sender_key, item_id, kind, host, group_id, state, answer, item, attempts, next_try_at, created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?) ON CONFLICT (sender_key, item_id) DO NOTHING`);
        for (const c of fresh) {
            if (!maySend(member, c)) throw new OutboxError(403, 'not_in_group', NOT_IN_GROUP_ERROR);
            // Behind every row already waiting for that host, whatever the clock did: each host's items go oldest first. A
            // yes queued makes them `joining` (standingOf), so the roster that follows it is taken meanwhile; their link
            // moves only on the host's answer (moveLinkOn), and no copy holds `joining`.
            const last = db.prepare("SELECT MAX(created_at) FROM group_guest_sent WHERE host = ? AND state = 'queued'").pluck().get(c.envelope.recipientHome) as number | null;
            const at = last !== null && last >= now ? last + 1 : now;
            insert.run(member, c.envelope.itemId, c.envelope.kind, c.envelope.recipientHome, c.groupId,
                c.envelope.kind === 'group-invite' ? answerOf(c.payload) : null, JSON.stringify({ envelope: c.envelope, payload: c.payload }), now, at, now);
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
 * that answer (moveLinkOn, with the counter the host's answer carried, `seq`). A row no longer queued (settled meanwhile) is
 * left as it is.
 */
function settleSent(r: SentRow, state: 'sent' | 'refused' | 'failed', refused: string | null, at: number, seq: number | null = null): void {
    const changed = db.prepare(`UPDATE group_guest_sent SET state = ?, refused = ?, item = NULL, next_try_at = NULL, updated_at = ?
                                WHERE sender_key = ? AND item_id = ? AND state = 'queued'`).run(state, refused, at, r.sender_key, r.item_id).changes;
    if (changed) moveLinkOn(r.sender_key, r.kind, r.host, r.group_id, r.item, state === 'sent', at, seq);
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

/** The host's answer for the item at `index` of a request, read by place (each one's own, or null when it is not that item's). */
function answerAt(answer: unknown, index: number, itemId: string, sent: number): { refused?: unknown; received?: unknown; seq?: unknown } | null {
    const all = (answer as { items?: unknown } | null | undefined)?.items;
    if (!Array.isArray(all) || all.length !== sent) return null;
    const a = all[index] as { itemId?: unknown; refused?: unknown; received?: unknown; seq?: unknown } | null;
    return a?.itemId === itemId ? a : null;
}

/** The host's answer for the item at `index` of a request: its refusal, or null when received. */
function refusedAt(answer: unknown, index: number, itemId: string, sent: number): string | null {
    const a = answerAt(answer, index, itemId, sent);
    if (!a || typeof a.refused !== 'string') return null;
    return /^[a-z-]{1,40}$/.test(a.refused) ? a.refused : 'refused';
}

/** The counter the host's answer for the item at `index` carries (received, a positive whole number), or null (moveLinkOn). */
function seqAt(answer: unknown, index: number, itemId: string, sent: number): number | null {
    const a = answerAt(answer, index, itemId, sent);
    return a && a.received === true && typeof a.seq === 'number' && Number.isSafeInteger(a.seq) && a.seq > 0 ? a.seq : null;
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
                    const itemId = (travelling[i] as { envelope: RelayEnvelope }).envelope.itemId;
                    const refused = refusedAt(body, i, itemId, batch.length);
                    settleSent(r, refused ? 'refused' : 'sent', refused, at, refused ? null : seqAt(body, i, itemId, batch.length));
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
 * rows go GROUP_SENT_KEPT_MS after their last change. On a standby, every held line and edit goes too (heldLinesStale). All
 * of it this server's own tables, a standby's too: there an item failing moves no link (moveLinkOn), so nothing here writes
 * a copied row.
 */
export function sweepGroupGuestMail(now = Date.now()): { gone: number; failed: number } {
    let gone = getNodeRole() === 'backup' ? heldLinesStale() : 0;
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
