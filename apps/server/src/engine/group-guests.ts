/**
 * Guests in a group's chat from other communities, on the server that hosts the group (slice G1:
 * scratch/fable-design/DESIGN-forums-messaging-joint-fable.md §2.3, §3.2; DESIGN-cross-chat-voice-fable.md §4.2, §11 row G1).
 *
 * **Their own table, not a role.** A guest is a row of group_guests (key, home, the name their address card gave, state),
 * never of group_members. So nothing that reads group_members (posts, polls, events, Decisions, a group's forum section,
 * succession votes, the members list, pushes) can count a guest, and a guest's key is no member of this server: every
 * route a member uses answers it as it answers any key that is no member here. What a guest gets is the group's CHAT, and
 * only by what this server sends their home: the lines, the key epochs (their own wraps), the roster of names in the chat.
 *
 * **A guest's phone never talks to this server.** Everything comes through the guest's own community's server:
 *
 *   in    their home brings their signed items to POST /api/relay/mail (engine/relay-mail.ts), addressed `group:<id>` here.
 *         Each passed core's envelope checks there first (its form, the home rule, for here, its payload, the signature), so
 *         a guest's line with a bad envelope is refused before it reaches this file. Then (takeGuestItem):
 *           group-invite  their answer to an invitation: `{"v":1,"answer":"yes"}` goes `in`, `"no"` goes `left`
 *           group-leave   they leave: `left`
 *           group-line    a sealed line, as a member posts one (engine/group-thread.ts postGroupThreadMessage), under the
 *                         current epoch: stored as theirs, then fanned out
 *           group-epoch   a key epoch they made (on joining, or a rotation): stored as a member's is (engine/group-keys.ts)
 *         An item from anyone who is not that group's guest in that state, from another home than the one invited, or with
 *         the owners' switch off is dropped and answered as received, as the mailbox drops (nothing tells a server who is in
 *         a group here). An in-guest's line refused for its epoch answers `epoch-stale`, any other refusal of theirs
 *         `group-refused`: they are in the group, so that tells them nothing new.
 *   out   this server tells each guest's home in a request it signs (engine/node-key.ts), to POST /api/relay/group there
 *         (GROUP_GUEST_PATH), queued in group_guest_outbox and tried again with backoff for a day. ONE request per community
 *         for each thing told, naming the guests there in it, never one per guest: an invitation, the roster at every
 *         change of it, each new line, each new epoch (with only that home's guests' wraps), a removal. Each home is sent
 *         to on its own (flushGuestOutbox): one that doesn't answer holds up no other, and a row queued while its home is
 *         being sent to goes as soon as that send ends.
 *
 * **Roster and epochs.** A guest who is `in` is in the chat's key roster (engine/group-keys.ts groupKeyRoster), so each
 * epoch must wrap the key to them, and a member's or a guest's line goes in only under an epoch that covers the roster. A
 * guest leaving or removed takes their key out of the roster: the epoch goes stale, nothing more is sent to them, and the
 * next epoch (the next member's phone rotates it, as for a member who leaves) is wrapped without them.
 *
 * **The roster, at every change** (queueGroupRoster). Every change of the chat's key roster, a member's (a join, a leave,
 * a removal by a convenor or a vote, a prune) or a guest's (in, left, removed), ends in group-keys.ts markGroupEpochStale
 * or withMembershipEpoch's new epoch, and each calls queueGroupRoster: the names in the chat, members and guests, and the
 * current epoch, to every home with guests in. A roster still waiting for its home is replaced by the newer one.
 *
 * **Back from epoch-stale.** A guest's line or epoch refused for its epoch answers `epoch-stale`, and the roster follows to
 * their home: who is in now (the keys a new epoch must wrap to, exactly) and the current epoch, with that home's guests'
 * wraps when it is not stale. Their phone (G1b) then makes a `rotate` epoch over exactly those keys when the epoch is
 * stale, or opens the current key from the wraps and sends the line again under it.
 *
 * **Caps** (design §4.2): GROUP_GUESTS_MAX invited or in a group; GUEST_MEDIA_BYTES_DAY of photos and voice a day for each
 * guest at this server (members keep their own budget).
 *
 * **The owners' switch** (`groupGuests`, config/node-profile.ts; guests ride the mailbox, so `outsideMessages` too). Off:
 * no invitation is made or taken and nothing from a guest goes in; every guest invited or in is removed and their home
 * told (closeGuestsIfSwitchedOff, the minute timer), as at a convenor's Remove; on again, a convenor invites them again.
 *
 * **A standby** copies group_guests (a plain table, engine/replication-manifest.ts), so it answers the same; the outbox is
 * this server's own. A standby's timer does neither job (closeGuestsIfSwitchedOff, flushGuestOutbox): the main server
 * removes the guests and tells their homes, and its writes reach the standby's copy.
 */
import crypto from 'node:crypto';
import { addressCardVerifies, word, type RelayItem } from '@beanpool/core';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { getNodeRole } from '../config/node-role.js';
import { isNodeMember, postGuestGroupLine } from '../state-engine.js';
import { callsignOf, groupChatRole, loadGroupForThread } from './group-thread.js';
import { GroupKeyError, currentGroupEpoch, groupKeyRoster, markGroupEpochStale, storeGroupEpoch } from './group-keys.js';
import { isOwnNodeHome, ownNodeHome } from './node-key.js';
import { forwardSigned } from './relay-outbox.js';
import { getImageStore } from '../storage/image-store.js';
import { attachmentDataOf } from '../storage/image-columns.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60_000;
/** Guests invited or in, in one group (design §4.2). */
export const GROUP_GUESTS_MAX = 30;
/** Photos and voice one guest may send into this server's group chats in any 24 hours, in bytes as stored (design §4.2). */
export const GUEST_MEDIA_BYTES_DAY = 20 * 1024 * 1024;
/** Where a guest's home takes what a group hosted elsewhere tells it (engine/node-signature.ts NODE_SIGNED_PATHS there). */
export const GROUP_GUEST_PATH = '/api/relay/group';
/** The waits between tries of a request to a guest's home, and how long it is tried before it goes. */
export const GUEST_FANOUT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 2 * 60 * 60_000] as const;
export const GUEST_FANOUT_QUEUE_MS = DAY_MS;
/** The kinds a guest's home brings for a group here. */
export const GUEST_ITEM_KINDS: ReadonlySet<string> = new Set(['group-invite', 'group-leave', 'group-line', 'group-epoch']);
/** The most a guest's item of each kind may carry, in characters as it travels. A line carries its sealed photo or voice. */
export const GUEST_LINE_MAX_CHARS = 1_300_000;
export const GUEST_SMALL_MAX_CHARS = 4 * 1024;
export const GUEST_EPOCH_MAX_CHARS = 64 * 1024;

export type GuestState = 'invited' | 'in' | 'left' | 'removed';

export const GUESTS_OFF_ERROR = word("This community doesn't let groups invite guests from other communities.");
export const GUESTS_FULL_ERROR = word('This group has as many guests as it can have.');
export const GUEST_IS_MEMBER_ERROR = word('This person is in this community: invite them to the group as a member.');
export const GUEST_CARD_ERROR = word("That address card can't be read, or it wasn't signed by the person it names.");
export const GUEST_CONVENOR_ERROR = word('Only a convenor can invite or remove guests.');
export const GUEST_NOT_FOUND_ERROR = word('That person is not a guest in this group.');
export const GUEST_NO_HOME_ERROR = word("This community's server knows none of its own names yet, so it can't reach another community.");

export class GroupGuestError extends Error {
    constructor(readonly status: 400 | 403 | 404 | 409 | 503, readonly code: string, message: string) {
        super(message);
        this.name = 'GroupGuestError';
    }
}

interface GuestRow {
    group_id: string; guest_key: string; home: string; name: string; state: GuestState; invited_by: string; invited_at: string; state_at: string;
}

/** Whether groups here may have guests: the owners' switch, and the mailbox their lines ride. */
export function groupGuestsOn(): boolean {
    const s = getProfileSwitches();
    return s.groupGuests && s.outsideMessages;
}

/** The size limit of a guest's item of `kind`, or null when it is no guest kind. */
export function guestItemMaxChars(kind: string): number | null {
    if (kind === 'group-line') return GUEST_LINE_MAX_CHARS;
    if (kind === 'group-epoch') return GUEST_EPOCH_MAX_CHARS;
    if (kind === 'group-invite' || kind === 'group-leave') return GUEST_SMALL_MAX_CHARS;
    return null;
}

function guestRow(groupId: string, key: string): GuestRow | undefined {
    return db.prepare('SELECT * FROM group_guests WHERE group_id = ? AND guest_key = ?').get(groupId, key) as GuestRow | undefined;
}

/** The guests who are in a group's chat now. */
export function guestsIn(groupId: string): GuestRow[] {
    return db.prepare("SELECT * FROM group_guests WHERE group_id = ? AND state = 'in' ORDER BY guest_key").all(groupId) as GuestRow[];
}

function setState(groupId: string, key: string, state: GuestState): void {
    db.prepare('UPDATE group_guests SET state = ?, state_at = ? WHERE group_id = ? AND guest_key = ?').run(state, new Date().toISOString(), groupId, key);
}

function assertConvenor(groupId: string, actor: string): void {
    loadGroupForThread(groupId);
    if (groupChatRole(groupId, actor) !== 'convenor') throw new GroupGuestError(403, 'not_convenor', GUEST_CONVENOR_ERROR);
}

export interface GuestView { key: string; home: string; name: string; state: GuestState; invitedBy: string; invitedAt: string }
const viewOf = (r: GuestRow): GuestView => ({ key: r.guest_key, home: r.home, name: r.name, state: r.state, invitedBy: r.invited_by, invitedAt: r.invited_at });

/** The group's guests as an active member reads them: those in the chat, and for a convenor those invited too. */
export function listGroupGuests(groupId: string, viewer: string): GuestView[] {
    const convenor = groupChatRole(groupId, viewer) === 'convenor';
    const states = convenor ? "('invited', 'in')" : "('in')";
    return (db.prepare(`SELECT * FROM group_guests WHERE group_id = ? AND state IN ${states} ORDER BY invited_at, guest_key`).all(groupId) as GuestRow[]).map(viewOf);
}

/**
 * A convenor invites someone from another community into the group's chat by their address card (core outside-chat.ts:
 * `{v, key, home, name, sig}`, signed by the key it names). Refused, nothing stored: the switch off, not a convenor, a card
 * that doesn't verify, a key that is a member here or a home that is this server, past GROUP_GUESTS_MAX. Someone already
 * invited or in answers as they are; someone who left or was removed is invited again. Their home is told (an invitation,
 * naming them).
 */
export function inviteGroupGuest(groupId: string, actor: string, card: unknown): GuestView {
    if (!groupGuestsOn()) throw new GroupGuestError(403, 'guests_off', GUESTS_OFF_ERROR);
    assertConvenor(groupId, actor);
    if (!addressCardVerifies(card)) throw new GroupGuestError(400, 'bad_card', GUEST_CARD_ERROR);
    if (isOwnNodeHome(card.home) || isNodeMember(card.key)) throw new GroupGuestError(400, 'is_member', GUEST_IS_MEMBER_ERROR);
    if (!ownNodeHome()) throw new GroupGuestError(503, 'no_home', GUEST_NO_HOME_ERROR);
    const view = db.transaction((): GuestView => {
        const had = guestRow(groupId, card.key);
        if (had && (had.state === 'invited' || had.state === 'in')) return viewOf(had);
        const taken = (db.prepare("SELECT COUNT(*) AS n FROM group_guests WHERE group_id = ? AND state IN ('invited', 'in')").get(groupId) as { n: number }).n;
        if (taken >= GROUP_GUESTS_MAX) throw new GroupGuestError(409, 'guests_full', GUESTS_FULL_ERROR);
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO group_guests (group_id, guest_key, home, name, state, invited_by, invited_at, state_at)
                    VALUES (?, ?, ?, ?, 'invited', ?, ?, ?)
                    ON CONFLICT (group_id, guest_key) DO UPDATE SET home = excluded.home, name = excluded.name, state = 'invited',
                        invited_by = excluded.invited_by, invited_at = excluded.invited_at, state_at = excluded.state_at`)
            .run(groupId, card.key, card.home, card.name, actor, now, now);
        const group = loadGroupForThread(groupId);
        queueToHome(groupId, card.home, [card.key], 'invite', { name: group.name, invitedBy: { key: actor, name: callsignOf(actor) } });
        return viewOf(guestRow(groupId, card.key)!);
    })();
    flushSoon();
    return view;
}

/**
 * A convenor removes a guest (invited or in): `removed`, which sticks until a convenor invites them again. Their key leaves
 * the roster, so the epoch goes stale; their home is told (a removal naming them), and the other guests' homes the roster.
 */
export function removeGroupGuest(groupId: string, actor: string, key: string): GuestView {
    assertConvenor(groupId, actor);
    const view = db.transaction((): GuestView => {
        const row = guestRow(groupId, key);
        if (!row || (row.state !== 'invited' && row.state !== 'in')) throw new GroupGuestError(404, 'not_a_guest', GUEST_NOT_FOUND_ERROR);
        setState(groupId, key, 'removed');
        queueToHome(groupId, row.home, [key], 'removed', { why: 'removed' });
        // The roster goes to the other guests' homes from markGroupEpochStale (queueGroupRoster), as at every roster change.
        if (row.state === 'in') markGroupEpochStale(groupId);
        return viewOf(guestRow(groupId, key)!);
    })();
    flushSoon();
    return view;
}

/**
 * The owners switched guests off (or the mailbox): every guest invited or in, in every group here, is removed and their
 * home told, as at a convenor's Remove. The minute timer's turn; nothing to do while the switch is on. Never on a standby:
 * it copies the switch before the main server's own tick removes the guests, and writes no copied row itself
 * (engine/replication-manifest.ts); the main server's removals reach its copy.
 */
export function closeGuestsIfSwitchedOff(): number {
    if (getNodeRole() === 'backup' || groupGuestsOn()) return 0;
    const rows = db.prepare("SELECT * FROM group_guests WHERE state IN ('invited', 'in')").all() as GuestRow[];
    if (!rows.length) return 0;
    db.transaction(() => {
        const byGroupHome = new Map<string, { groupId: string; home: string; keys: string[] }>();
        const stale = new Set<string>();
        for (const r of rows) {
            setState(r.group_id, r.guest_key, 'removed');
            if (r.state === 'in') stale.add(r.group_id);
            const k = `${r.group_id}\n${r.home}`;
            const entry = byGroupHome.get(k) ?? { groupId: r.group_id, home: r.home, keys: [] };
            entry.keys.push(r.guest_key);
            byGroupHome.set(k, entry);
        }
        for (const g of stale) markGroupEpochStale(g);
        for (const e of byGroupHome.values()) queueToHome(e.groupId, e.home, e.keys, 'removed', { why: 'closed' });
    })();
    flushSoon();
    return rows.length;
}

// ── What a guest's home brings ─────────────────────────────────────────────────────────────

/** What takeGuestItem answers for one item: null (received, said of everything else) or a refusal an in-guest may hear. */
export type GuestItemRefusal = 'epoch-stale' | 'group-refused';

const EPOCH_CODES = new Set(['epoch_needed', 'epoch_stale', 'epoch_not_current', 'epoch_conflict']);

/** The bytes of photos and voice `guest` stored in this server's group chats in the last day. */
function guestMediaBytesToday(guest: string, now: number): number {
    return (db.prepare(`SELECT COALESCE(SUM(a.bytes), 0) AS n FROM message_attachments a JOIN messages m ON m.id = a.message_id
                        WHERE m.author_pubkey = ? AND m.timestamp > ?`).get(guest, new Date(now - DAY_MS).toISOString()) as { n: number }).n;
}

function parsePayload(payload: string): Record<string, unknown> | null {
    try {
        const o = JSON.parse(payload) as unknown;
        return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * One item a guest's home brought for a group here (`group:<id>`), its envelope already checked by core (relay-mail.ts):
 * applied, or dropped. See the file's header for each kind.
 */
export function takeGuestItem(item: RelayItem, now = Date.now()): GuestItemRefusal | null {
    const env = item.envelope;
    if (!GUEST_ITEM_KINDS.has(env.kind) || !env.recipient.startsWith('group:') || !groupGuestsOn()) return null;
    const groupId = env.recipient.slice('group:'.length);
    const row = guestRow(groupId, env.senderKey);
    if (!row || row.home !== env.senderHome) return null;
    try {
        loadGroupForThread(groupId);
    } catch {
        return null;
    }
    const payload = parsePayload(item.payload);
    if (env.kind === 'group-invite') {
        if (row.state !== 'invited' || payload?.v !== 1 || (payload.answer !== 'yes' && payload.answer !== 'no')) return null;
        // Their yes puts them in the roster: markGroupEpochStale sends it to every guest's home, theirs too (queueGroupRoster).
        db.transaction(() => {
            setState(groupId, row.guest_key, payload.answer === 'yes' ? 'in' : 'left');
            if (payload.answer === 'yes') markGroupEpochStale(groupId);
        })();
        flushSoon();
        return null;
    }
    if (env.kind === 'group-leave') {
        if (row.state !== 'in' && row.state !== 'invited') return null;
        db.transaction(() => {
            setState(groupId, row.guest_key, 'left');
            if (row.state === 'in') markGroupEpochStale(groupId);
        })();
        flushSoon();
        return null;
    }
    if (row.state !== 'in') return null;
    if (!payload) return 'group-refused';
    let refusal: GuestItemRefusal | null = null;
    if (env.kind === 'group-line') {
        const att = payload.attachment as { data?: unknown } | undefined;
        const bytes = att && typeof att.data === 'string' ? Buffer.byteLength(att.data, 'base64') : 0;
        if (bytes > 0 && guestMediaBytesToday(row.guest_key, now) + bytes > GUEST_MEDIA_BYTES_DAY) return 'group-refused';
        try {
            postGuestGroupLine(groupId, row.guest_key, {
                ciphertext: payload.ciphertext as string, nonce: payload.nonce as string, metadata: payload.metadata,
                type: payload.type, attachment: payload.attachment,
            }, typeof payload.clientId === 'string' ? payload.clientId : undefined);
        } catch (e) {
            refusal = e instanceof GroupKeyError && EPOCH_CODES.has(e.code) ? 'epoch-stale' : 'group-refused';
        }
    } else {
        // group-epoch: a key epoch the guest made, checked and stored as a member's is.
        try {
            db.transaction(() => storeGroupEpoch(groupId, row.guest_key, payload.epoch, { allowed: ['join', 'rotate'] }))();
        } catch (e) {
            refusal = e instanceof GroupKeyError && EPOCH_CODES.has(e.code) ? 'epoch-stale' : 'group-refused';
        }
    }
    // Back from epoch-stale: the roster follows to their home, with who is in now and the current epoch (the header).
    if (refusal === 'epoch-stale') {
        queueGroupRoster(groupId, row.home);
        flushSoon();
    }
    return refusal;
}

// ── What this server tells the guests' homes ───────────────────────────────────────────────

type NoticeKind = 'invite' | 'roster' | 'line' | 'epoch' | 'removed';

/**
 * One request's body to one home: what it is, the group here, and the guests there it is for. It goes at the back of that
 * home's queue (its created_at is past every row the home has waiting, whatever the clock did), and it is due at once, so
 * it costs its home at most one try: that try sends the home's queue from its OLDEST row (sendToHome), never this row ahead
 * of one waiting, in backoff or not. A roster withdraws one still waiting for that home in the same group (only the latest
 * names count; a send in flight that the delete catches is a no-op when it ends) and goes as the newest row, so nothing it
 * says arrives before an older notice. Never on a standby: its copy of a change came from the main server, which queued and
 * sends it, and rows queued on a standby would go out stale after a promotion.
 */
function queueToHome(groupId: string, home: string, guests: string[], kind: NoticeKind, data: unknown): void {
    const host = ownNodeHome();
    if (!host || !guests.length || getNodeRole() === 'backup') return;
    const body = JSON.stringify({ v: 1, kind, group: groupId, host, guests: [...guests].sort(), data });
    if (kind === 'roster') db.prepare("DELETE FROM group_guest_outbox WHERE group_id = ? AND home = ? AND kind = 'roster'").run(groupId, home);
    const now = Date.now();
    const last = db.prepare('SELECT MAX(created_at) FROM group_guest_outbox WHERE home = ?').pluck().get(home) as number | null;
    db.prepare('INSERT INTO group_guest_outbox (id, group_id, home, kind, body, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
        .run(crypto.randomUUID(), groupId, home, kind, body, now, last !== null && last >= now ? last + 1 : now);
}

/** The guests in a group by home: one request per community. `except` (a line's guest author) is named in none. */
export function guestHomes(groupId: string, except?: string): Map<string, string[]> {
    const byHome = new Map<string, string[]>();
    for (const g of guestsIn(groupId)) {
        if (g.guest_key === except) continue;
        byHome.set(g.home, [...(byHome.get(g.home) ?? []), g.guest_key]);
    }
    return byHome;
}

/** An epoch's signed record as it travels to a guest's home, or null when there is no such epoch. */
function epochRecord(groupId: string, epoch: number): Record<string, unknown> | null {
    const e = db.prepare('SELECT * FROM group_key_epochs WHERE group_id = ? AND epoch = ?').get(groupId, epoch) as any;
    if (!e) return null;
    return {
        epoch: e.epoch, reason: e.reason, subject: e.subject_pubkey, createdBy: e.created_by, createdAt: e.created_at,
        keyCommit: e.key_commit, membersDigest: e.members_digest, wrapsDigest: e.wraps_digest, sig: e.sig,
    };
}

/** The wraps of an epoch for these guests only (one home's), never anyone else's. */
function wrapsFor(groupId: string, epoch: number, keys: readonly string[]): Array<Record<string, string>> {
    const wrapsOf = db.prepare(`SELECT recipient_pubkey, wrapper_pubkey, eph_pub, nonce, wrapped FROM group_key_wraps
                                WHERE group_id = ? AND epoch = ? AND recipient_pubkey = ? AND rejected_at IS NULL`);
    return keys.flatMap((k) => (wrapsOf.all(groupId, epoch, k) as any[]).map((w) => ({
        recipient: w.recipient_pubkey, wrapper: w.wrapper_pubkey, ephPub: w.eph_pub, nonce: w.nonce, wrapped: w.wrapped,
    })));
}

/**
 * The names in the chat, members (as the chat names them) and guests, and the current epoch, to every home with guests in
 * (or to `onlyHome`, after one of its guests heard epoch-stale). Called at every roster change (group-keys.ts
 * markGroupEpochStale and withMembershipEpoch, inside the change's transaction), so it never throws into it: a roster that
 * can't be made is logged, and the change stands. The epoch carries its record and that home's guests' wraps when it is not
 * stale, so a guest who missed it can open it; a stale one says a new epoch is due, over exactly these keys.
 */
export function queueGroupRoster(groupId: string, onlyHome?: string): void {
    try {
        if (!groupGuestsOn()) return;
        const homes = guestHomes(groupId);
        if (!homes.size) return;
        const group = loadGroupForThread(groupId);
        const guests = guestsIn(groupId);
        const guestKeys = new Set(guests.map((g) => g.guest_key));
        const roster = groupKeyRoster(groupId);
        const cur = currentGroupEpoch(groupId, roster);
        const record = cur && !cur.stale ? epochRecord(groupId, cur.epoch) : null;
        const names = {
            name: group.name,
            members: roster.filter((k) => !guestKeys.has(k)).map((k) => ({ key: k, name: callsignOf(k) })),
            guests: guests.map((g) => ({ key: g.guest_key, home: g.home, name: g.name })),
        };
        for (const [home, keys] of homes) {
            if (onlyHome !== undefined && home !== onlyHome) continue;
            const epoch = !cur ? null
                : record ? { current: cur.epoch, stale: false, record, wraps: wrapsFor(groupId, cur.epoch, keys) }
                : { current: cur.epoch, stale: true };
            queueToHome(groupId, home, keys, 'roster', { ...names, epoch });
        }
        flushSoon();
    } catch (e) {
        logger.warn('SYS', `Group guests: the roster could not be queued for the guests' homes (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
    }
}

/**
 * A new line in a group's chat, a member's or a guest's (engine/group-thread.ts postGroupThreadMessage, after it is
 * stored): one request to each home with guests in, carrying the line as members read it and its sealed photo or voice.
 */
export function fanOutGroupLine(groupId: string, messageId: string, author: string): void {
    if (!groupGuestsOn()) return;
    const homes = guestHomes(groupId, author);
    if (!homes.size) return;
    const row = db.prepare('SELECT id, author_pubkey, ciphertext, nonce, type, metadata, timestamp FROM messages WHERE id = ? AND conversation_id = ?')
        .get(messageId, groupId) as { id: string; author_pubkey: string; ciphertext: string; nonce: string; type: string; metadata: string | null; timestamp: string } | undefined;
    if (!row) return;
    const att = db.prepare('SELECT * FROM message_attachments WHERE message_id = ?').get(messageId) as any;
    const attachment = att ? { data: attachmentDataOf(att, getImageStore()), nonce: att.nonce, mime: att.mime } : undefined;
    const data = {
        id: row.id, author: row.author_pubkey, ciphertext: row.ciphertext, nonce: row.nonce, type: row.type,
        metadata: row.metadata ? JSON.parse(row.metadata) : null, timestamp: row.timestamp, ...(attachment ? { attachment } : {}),
    };
    for (const [home, keys] of homes) queueToHome(groupId, home, keys, 'line', data);
    flushSoon();
}

/**
 * A new key epoch of a group (engine/group-keys.ts storeGroupEpoch, inside the caller's transaction): one request to each
 * home with guests in, carrying the record and only the wraps for that home's guests.
 */
export function fanOutGroupEpoch(groupId: string, epoch: number): void {
    if (!groupGuestsOn()) return;
    const homes = guestHomes(groupId);
    if (!homes.size) return;
    const record = epochRecord(groupId, epoch);
    if (!record) return;
    for (const [home, keys] of homes) queueToHome(groupId, home, keys, 'epoch', { record, wraps: wrapsFor(groupId, epoch, keys) });
    flushSoon();
}

/** After the caller's transaction, the outbox's due rows go (the minute timer catches what this misses). */
function flushSoon(): void {
    setImmediate(() => {
        flushGuestOutbox().catch((e) => logger.warn('SYS', `Group guests: a send to another community failed (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`));
    });
}

interface OutboxRow { id: string; kind: NoticeKind; body: string; attempts: number; created_at: number }

/** Each home being sent to now, and that send: one at a time for a home, every home on its own. */
const sendingTo = new Map<string, Promise<number>>();

/**
 * Each home with a row due, sent to: one signed request a row, to its home's GROUP_GUEST_PATH. Each home on its own and all
 * at once (as the mailbox's forwards go, engine/relay-outbox.ts forwardRows): a home that doesn't answer costs its own rows
 * one wait (FORWARD_TIMEOUT_MS) and holds up no other home's. A home already being sent to is joined, never sent to twice
 * at once; its send takes every row queued while it ran before it ends, so a row queued meanwhile goes then, not at the
 * next minute. Resolves when every home it started or joined is done; answers how many rows the homes it started handled.
 * Never on a standby (closeGuestsIfSwitchedOff says why).
 */
export async function flushGuestOutbox(now = Date.now()): Promise<number> {
    if (getNodeRole() === 'backup') return 0;
    const homes = db.prepare('SELECT DISTINCT home FROM group_guest_outbox WHERE next_try_at <= ?').pluck().all(now) as string[];
    const counts = await Promise.all(homes.map((home) => {
        const running = sendingTo.get(home);
        if (running) return running.then(() => 0);
        const send = sendToHome(home).finally(() => sendingTo.delete(home));
        sendingTo.set(home, send);
        return send;
    }));
    return counts.reduce((a, b) => a + b, 0);
}

/**
 * One home's queue, OLDEST FIRST, every row of it, until none is left: for each home, rows go out strictly in the order
 * they were queued, always. A row due starts the send, and the send takes the home's rows from the oldest, due or not: a
 * new row never leaves before an older one waiting, and once the home takes one, every row behind it goes in the same
 * send, so none waits out a backoff its home has ended. A 2xx, or an answer that says it will never be taken (400, 404,
 * 413), and the row goes; anything else and ALL the home's rows wait one backoff (set by the try that failed, the oldest
 * row's), until GUEST_FANOUT_QUEUE_MS, then a row goes. With guests switched off, only removals go.
 */
async function sendToHome(home: string): Promise<number> {
    let handled = 0;
    const url = `https://${home}${GROUP_GUEST_PATH}`;
    const drop = db.prepare('DELETE FROM group_guest_outbox WHERE id = ?');
    for (;;) {
        const queue = db.prepare('SELECT id, kind, body, attempts, created_at FROM group_guest_outbox WHERE home = ? ORDER BY created_at, rowid LIMIT 64')
            .all(home) as OutboxRow[];
        if (!queue.length) return handled;
        const on = groupGuestsOn();
        const still = db.prepare('SELECT 1 FROM group_guest_outbox WHERE id = ?');
        for (const r of queue) {
            // A row withdrawn while this send ran (a newer roster replaced it, or it aged out) never goes.
            if (!still.get(r.id)) continue;
            handled++;
            if (!on && r.kind !== 'removed') { drop.run(r.id); continue; }
            const status = await forwardSigned(url, r.body);
            const at = Date.now();
            const final = (status >= 200 && status < 300) || status === 400 || status === 404 || status === 413;
            if (final || at - r.created_at >= GUEST_FANOUT_QUEUE_MS) {
                drop.run(r.id);
                if (status < 200 || status >= 300) logger.warn('SYS', `Group guests: ${home} did not take a notice (status ${status}); it is not tried again.`);
                continue;
            }
            const wait = GUEST_FANOUT_BACKOFF_MS[Math.min(r.attempts, GUEST_FANOUT_BACKOFF_MS.length - 1)];
            db.transaction(() => {
                db.prepare('UPDATE group_guest_outbox SET attempts = attempts + 1 WHERE id = ?').run(r.id);
                db.prepare('DELETE FROM group_guest_outbox WHERE home = ? AND created_at <= ?').run(home, at - GUEST_FANOUT_QUEUE_MS);
                db.prepare('UPDATE group_guest_outbox SET next_try_at = ? WHERE home = ?').run(at + wait, home);
            })();
            return handled;
        }
    }
}
