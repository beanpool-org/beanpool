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
 *           group-invite  their answer to an invitation: `{"v":1,"answer":"yes"}` goes `in`, `"no"` goes `left`;
 *                         a no from a guest already `in` is their leave (their home showed the invitation again after a
 *                         take-over or a day of lost answers, and they said no: #3217 round 3), a yes from one `in` received
 *           group-leave   they leave: `left`
 *           group-line    a sealed line, as a member posts one (engine/group-thread.ts postGroupThreadMessage), under the
 *                         current epoch: stored as theirs, UNDER ITS ITEM'S ID (a payload naming another id is refused), so
 *                         a report of it names the one item their home sent (group-chat-report.ts, relay-complaint.ts),
 *                         then fanned out
 *           group-epoch   a key epoch they made (on joining, or a rotation): stored as a member's is (engine/group-keys.ts)
 *         An item from anyone who is not that group's guest in that state, from another home than the one invited, from a
 *         home the owners blocked (connector-manager.ts isServerBlocked), to a group its members closed, or with the owners'
 *         switch off is dropped and answered as received, as the mailbox drops (nothing tells a server who is in a group
 *         here). An in-guest's line refused for its epoch answers `epoch-stale`, any other refusal of theirs
 *         `group-refused`: they are in the group, so that tells them nothing new.
 *   out   this server tells each guest's home in a request it signs (engine/node-key.ts), to POST /api/relay/group there
 *         (GROUP_GUEST_PATH), queued in group_guest_outbox and tried again with backoff for a day; a row that only takes
 *         away (a line's takedown, a removal) for as long as the home may still hold what it takes away, MAIL_HELD_DAYS
 *         and a day (guestRowKeptMs), and it goes even with the switch off or the group closed. ONE request per community
 *         for each thing told, naming the guests there in it, never one per guest: an invitation, the roster at every
 *         change of it, each new line, each line edited or taken down (`edit`: its author's edit or delete, a convenor's
 *         removal), each new epoch (with only that home's guests' wraps), a removal. Never to a home the owners blocked
 *         (cross-chat design §4.2 "Caps"): nothing is queued for it, and what was queued before the block is dropped
 *         unsent. TAKEDOWNS (queueLineChange): a line taken down (its author's delete, a convenor's removal, its author's
 *         account deleted: takeDownLinesOf) withdraws every copy of it still queued here, its line and its edits, for
 *         every home, whoever is a guest now; a group closed withdraws every line of it still queued (closeGroupGuests);
 *         an edit rewrites the words of the line still queued and withdraws an older edit, so only the newest words go.
 *         A send reads each row as it is when its turn comes (sendToHome), so a row withdrawn or rewritten meanwhile goes
 *         as the table says; the one row already on the wire is followed by the takedown or edit, queued behind it. THE
 *         SEND RULE (SEND_RULES, #3233 round 5): what changed while a row waited, here or on the server that took over
 *         (whose writes this server's copy carries), is checked as its turn comes, one rule for each kind, and a row goes
 *         only while what it says is still true here, naming only the guests it may still name: a line or an edit's new
 *         words while the line stands, to guests still in, with its words now; a takedown always; a removal naming only
 *         the guests not in here now; an invitation to guests still invited; a roster while it is still the chat's; an
 *         epoch while it is still this group's, to guests still in. Each home is sent
 *         to on its own (flushGuestOutbox): one that doesn't answer holds up no other, and a row queued while its home is
 *         being sent to goes as soon as that send ends. QUEUE ORDER: for each home, rows go out strictly oldest first,
 *         always (an invitation, a removal and a roster carry no time, so the home can't put them back in order). A new
 *         row is due at once and its try sends the home's queue from the oldest row, so it never leaves before an older
 *         row waiting in backoff; once the home takes a row, every row behind it goes in the same send (sendToHome).
 *
 * **Roster and epochs.** A guest who is `in` is in the chat's key roster (engine/group-keys.ts groupKeyRoster), so each
 * epoch must wrap the key to them, and a member's or a guest's line goes in only under an epoch that covers the roster. A
 * guest leaving or removed takes their key out of the roster: the epoch goes stale, nothing more is sent to them, and the
 * next epoch (the next member's phone rotates it, as for a member who leaves) is wrapped without them.
 *
 * **The roster, at every change** (queueGroupRoster). groupKeyRoster reads three things: active group_members rows, whether
 * each key is a member here (isNodeMember: not pruned, not a key a re-key holds or replaced) and guests `in`. Every write
 * that can change one of them ends in group-keys.ts markGroupEpochStale (directly, or markGroupEpochsStaleFor) or
 * withMembershipEpoch's new epoch, and each calls queueGroupRoster: the names in the chat, members and guests, the names
 * of people out of it whose lines those guests may have (`former`, names only: formerInChat), and the current epoch, to
 * every home with guests in. The paths: a member joins (with or without an epoch), says yes to an
 * invitation, is approved, is seated in a circle, leaves, is removed by a convenor or a vote (state-engine.ts,
 * withMembershipEpoch or removeGroupMemberByVote); deletes their account (purgeMemberSelf); is pruned or reinstated, both
 * through setUserStatusRow across 'pruned'; a re-key starts, is cancelled, completes (member-wizards.ts issueRekeyCode,
 * cancelRekeyCode, completeRekey); a guest is in, leaves, is removed, or the switch removes them all (here). What changes
 * no roster: a pause (the account keeps its memberships and its key), an invitation or a request to join (no key until the
 * yes or the approval), a role. A standby queues nothing (queueToHome): the main server made the change and sends it. A
 * roster still waiting for its home is withdrawn for the newer one. test-group-guests §12 is the table of all of them.
 *
 * **Back from epoch-stale.** A guest's line or epoch refused for its epoch answers `epoch-stale`, and the roster follows to
 * their home: who is in now (the keys a new epoch must wrap to, exactly) and the current epoch, with that home's guests'
 * wraps when it is not stale. Their phone (G1b) then makes a `rotate` epoch over exactly those keys when the epoch is
 * stale, or opens the current key from the wraps and sends the line again under it.
 *
 * **Caps** (design §4.2): GROUP_GUESTS_MAX invited or in a group; GUEST_MEDIA_BYTES_DAY of photos and voice a day for each
 * guest at this server (members keep their own budget); no invitation to, and no fan-out to, a server the owners blocked.
 *
 * **A group its members close** (state-engine.ts closeGroupByVote, the one writer of group_closures) takes its guests out
 * in the same transaction (closeGroupGuests): every guest invited or in is `removed` and their home told (`why:
 * 'group-closed'`), so the home's link goes `removed` too. A closed group takes no invitation and nothing from a guest.
 *
 * **The owners' switch** (`groupGuests`, config/node-profile.ts; guests ride the mailbox, so `outsideMessages` too). Off:
 * no invitation is made or taken and nothing from a guest goes in; every guest invited or in is removed and their home
 * told (closeGuestsIfSwitchedOff, the minute timer), as at a convenor's Remove; on again, a convenor invites them again.
 *
 * **A standby** copies group_guests (a plain table, engine/replication-manifest.ts), so it answers the same; the outbox is
 * this server's own. A standby's timer does neither job (closeGuestsIfSwitchedOff, flushGuestOutbox): the main server
 * removes the guests and tells their homes, and its writes reach the standby's copy.
 *
 * **The order rule** (G2; guests-g2-must-include.md, #3233 rounds 3 to 5). Two servers can tell a guest's home about the
 * same guest: the main server, and after a take-over the one that took over (and after a take-back the first again), each
 * from its own outbox. So every notice that says where a guest stands (an invitation, a removal, the roster) or takes a
 * line away carries a counter, `seq`, one per group (group_guest_clock, a COPIED table: issueGuestSeq), and the home keeps
 * per guest the newest it took (group-guest-home.ts): an older one arriving later, from either server, in any order,
 * changes nothing there. THE GUEST'S OWN WORD (G2 follow-ups): their yes, no or leave taken here moves where they stand
 * too, so it is stamped with the group's next counter as it is taken, before the roster that follows, and the answer to it
 * carries that counter (takeGuestItem, GuestItemTaken; relay-mail.ts puts it on the item's `received`); their home orders
 * it with the notices by it, so an invitation told again before the yes (a take-over's retellGroup), arriving after the
 * answer, is older and never takes them out. One that agrees with where they stand already (a yes from a guest in, a no or
 * a leave from one out) confirms it under the next counter (confirmStanding); a yes from a guest out carries none, and
 * their home moves nothing on it. The same item brought
 * again (its answer lost on the way back) hears the same counter, kept as long as its id is spent (relay-mail.ts,
 * relay_mail_answered), never a bare "received" its home could not order. TELLING HOMES AGAIN (retellGuestHomes): the
 * counters THIS server issued are its own record
 * (group_guest_told, local); a copied counter past it means another server issued notices this one never queued, whose
 * outbox this one can't see (a take-over, or a take-back). Then, at its next flush, it tells each home of that group again
 * where its guests stand now, under new counters: every invitation still waiting, every removal and every line taken down
 * within the time a home may hold what they take away, and the roster. An invitation is kept as long as a take-away
 * (guestRowKeptMs), so a home down for days never gets a removal without the invitation queued after it.
 */
import crypto from 'node:crypto';
import { addressCardVerifies, clipName, word, type RelayItem } from '@beanpool/core';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { getNodeRole, STANDBY_WRITE_MESSAGE } from '../config/node-role.js';
import { GROUP_CLOSED, groupClosedAt, isNodeMember, postGuestGroupLine } from '../state-engine.js';
import { isServerBlocked } from '../connector-manager.js';
import { callsignOf, groupChatRole, loadGroupForThread } from './group-thread.js';
import { GroupKeyError, currentGroupEpoch, groupKeyRoster, markGroupEpochStale, storeGroupEpoch } from './group-keys.js';
import { isOwnNodeHome, ownNodeHome } from './node-key.js';
import { forwardSigned } from './relay-outbox.js';
import { getImageStore } from '../storage/image-store.js';
import { attachmentDataOf } from '../storage/image-columns.js';
import { blankedWithAccount } from './message-tombstone.js';
import { MAIL_HELD_DAYS } from './relay-mail.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60_000;
/** Guests invited or in, in one group (design §4.2). */
export const GROUP_GUESTS_MAX = 30;
/** Photos and voice one guest may send into this server's group chats in any 24 hours, in bytes as stored (design §4.2). */
export const GUEST_MEDIA_BYTES_DAY = 20 * 1024 * 1024;
/** Where a guest's home takes what a group hosted elsewhere tells it (engine/node-signature.ts NODE_SIGNED_PATHS there). */
export const GROUP_GUEST_PATH = '/api/relay/group';
/** The waits between tries of a request to a guest's home, and how long a row that adds is tried before it goes. */
export const GUEST_FANOUT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 2 * 60 * 60_000] as const;
export const GUEST_FANOUT_QUEUE_MS = DAY_MS;

/**
 * Whether a row only TAKES AWAY what its home holds: a line's takedown (`edit`, `action: 'removed'`), or a guest's
 * `removed` (any reason: a convenor's Remove, the owners' switch, the group closed), which drops every line of that group
 * held for them there. Every other row adds: a line, an edit's new words, a roster, an invitation, an epoch.
 */
export function takesAway(kind: string, data: unknown): boolean {
    return kind === 'removed' || (kind === 'edit' && (data as { action?: unknown } | null | undefined)?.action === 'removed');
}

/** How long a row that takes away, or an invitation, is kept and tried: MAIL_HELD_DAYS and a day (guestRowKeptMs). */
export function guestHeldWindowMs(): number {
    return MAIL_HELD_DAYS * DAY_MS + GUEST_FANOUT_QUEUE_MS;
}

/**
 * How long a row is kept here and tried (#3233 round 4). A row that adds: GUEST_FANOUT_QUEUE_MS, then it goes unsent. A row
 * that takes away: for as long as its home may still hold what it takes away, never shorter. The home holds a line, words
 * and sealed photo or voice, until each device has it or MAIL_HELD_DAYS pass (group-guest-home.ts: its sweep drops it, and
 * its fetch serves nothing older), and only a take-away drops it sooner; so a home down for a weekend, or a month, still
 * hears it when it comes back. Plus GUEST_FANOUT_QUEUE_MS on top: a line on the wire as it was taken down lands at the home
 * just after the takedown was queued, and the home counts its days by its own clock. AN INVITATION as long (G2): its guest
 * stays invited here until they answer, and a removal queued before it is kept that long, so a home down for more than a
 * day must not get the removal and lose the invitation queued after it (the send rule still sends it only while they are
 * invited here). Read when called, never at load: relay-mail.ts imports this file.
 */
export function guestRowKeptMs(kind: string, data: unknown): number {
    return takesAway(kind, data) || kind === 'invite' ? guestHeldWindowMs() : GUEST_FANOUT_QUEUE_MS;
}

/**
 * THE ORDER RULE's counter (G2, the file's header): the next one for a group whose last was `last`, at `now`. The time in
 * milliseconds, or one past the last when that is later (a clock that went back, two in one millisecond): so it always
 * moves past what this server's copy carries from the other server, and past what the other server issued after its last
 * copy came whenever that was before now by this server's clock.
 */
export function nextGuestSeq(last: number | null, now: number): number {
    return Math.max(Math.floor(now), (last ?? 0) + 1);
}

/** Issues the group's next counter (group_guest_clock, copied) and records it as this server's own (group_guest_told). */
function issueGuestSeq(groupId: string): number {
    const last = db.prepare('SELECT seq FROM group_guest_clock WHERE group_id = ?').pluck().get(groupId) as number | undefined;
    const seq = nextGuestSeq(last ?? null, Date.now());
    db.prepare('INSERT INTO group_guest_clock (group_id, seq) VALUES (?, ?) ON CONFLICT (group_id) DO UPDATE SET seq = excluded.seq').run(groupId, seq);
    db.prepare('INSERT INTO group_guest_told (group_id, seq) VALUES (?, ?) ON CONFLICT (group_id) DO UPDATE SET seq = excluded.seq').run(groupId, seq);
    return seq;
}

/**
 * After a failed try at `at` of a queue whose oldest row has used `attempts` steps and was due at `dueAt`: the steps and
 * when the queue is tried next. The step moves on only when the wait it set has passed, so the backoff follows TIME, not
 * tries: a new row is due at once and costs its home one early try (sendToHome), and that try leaves the wait as it was.
 * A home down for an hour is tried at 1, 6, 21 and 81 minutes however many rows were queued meanwhile (#3197 round 3
 * review: counting tries pushed six rows in a busy minute to the two-hour wait).
 */
export function nextFanoutTry(attempts: number, dueAt: number, at: number, steps: readonly number[] = GUEST_FANOUT_BACKOFF_MS): { attempts: number; nextTryAt: number } {
    if (attempts > 0 && at < dueAt) return { attempts, nextTryAt: dueAt };
    return { attempts: attempts + 1, nextTryAt: at + steps[Math.min(attempts, steps.length - 1)] };
}

let clockForTests: (() => number) | null = null;

/**
 * Tests: the clock a send stamps its tries with (a suite's own time, to walk an outage of hours); null puts Date.now back.
 * Refuses to run unless BEANPOOL_SSRF_TEST_HOOK=1, which nothing in production sets.
 */
export function __useFanoutClockForTests(clock: (() => number) | null): void {
    if (process.env.BEANPOOL_SSRF_TEST_HOOK !== '1') throw new Error('The fan-out clock hook is disabled (BEANPOOL_SSRF_TEST_HOOK is not 1)');
    clockForTests = clock;
}

/** When a try to another community's server happened: now, by this server's clock (or a suite's). */
export function fanoutNow(): number {
    return clockForTests ? clockForTests() : Date.now();
}
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
export const GUEST_SERVER_BLOCKED_ERROR = word("This community's owners have blocked that person's community.");

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
    // group_guests is a copied table: a standby writes none of it, and tells no home (queueToHome).
    if (getNodeRole() === 'backup') throw new GroupGuestError(503, 'standby', STANDBY_WRITE_MESSAGE);
    assertConvenor(groupId, actor);
    if (!addressCardVerifies(card)) throw new GroupGuestError(400, 'bad_card', GUEST_CARD_ERROR);
    if (isOwnNodeHome(card.home) || isNodeMember(card.key)) throw new GroupGuestError(400, 'is_member', GUEST_IS_MEMBER_ERROR);
    if (isServerBlocked(card.home)) throw new GroupGuestError(403, 'server_blocked', GUEST_SERVER_BLOCKED_ERROR);
    if (groupClosedAt(groupId)) throw new GroupGuestError(403, 'group_closed', GROUP_CLOSED);
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
    if (getNodeRole() === 'backup') throw new GroupGuestError(503, 'standby', STANDBY_WRITE_MESSAGE);
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

/**
 * A group its members closed (state-engine.ts closeGroupByVote, inside its transaction): every guest invited or in is
 * `removed`, and each home told in one request naming its guests there (`why: 'group-closed'`), so the home's link goes
 * `removed` as at a convenor's Remove. The row stays, as every guest row does (a state moves); nothing more goes to or comes
 * from them (takeGuestItem drops what a closed group's guest brings, inviteGroupGuest refuses), and no line of the group
 * still queued here goes; a takedown still queued does (it only takes away). How many were removed.
 */
export function closeGroupGuests(groupId: string): number {
    // Its lines go from its guests too: no copy still queued here goes, to any home, a guest's who left before included (the
    // homes of those removed now drop what they hold of it at the removal: group-guest-home.ts dropHeldLines). A line's
    // takedown still queued stays and goes (takesAway): a home whose guests aren't removed now gets no removal to drop it.
    const withdraw = db.prepare('DELETE FROM group_guest_outbox WHERE id = ?');
    for (const q of db.prepare("SELECT id, kind, body FROM group_guest_outbox WHERE group_id = ? AND kind IN ('line', 'edit')").all(groupId) as Array<{ id: string; kind: string; body: string }>) {
        if (!takesAway(q.kind, noticeOf(q.body)?.data)) withdraw.run(q.id);
    }
    const rows = db.prepare("SELECT * FROM group_guests WHERE group_id = ? AND state IN ('invited', 'in')").all(groupId) as GuestRow[];
    const byHome = new Map<string, string[]>();
    for (const r of rows) {
        setState(groupId, r.guest_key, 'removed');
        byHome.set(r.home, [...(byHome.get(r.home) ?? []), r.guest_key]);
    }
    for (const [home, keys] of byHome) queueToHome(groupId, home, keys, 'removed', { why: 'group-closed' });
    if (rows.length) flushSoon();
    return rows.length;
}

// ── What a guest's home brings ─────────────────────────────────────────────────────────────

/** What takeGuestItem answers for one item: null (received, said of everything else) or a refusal an in-guest may hear. */
export type GuestItemRefusal = 'epoch-stale' | 'group-refused';
/**
 * Their yes, no or leave taken, and where they stand moved or confirmed by it: received, with the group's counter it was
 * stamped with (the order rule, the file's header: THE GUEST'S OWN WORD). Their home orders it with the host's notices by it.
 */
export interface GuestItemTaken { seq: number }

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
 * applied, or dropped. See the file's header for each kind. A yes, a no or a leave that moves where they stand answers the
 * counter it was stamped with (GuestItemTaken), and so does one that agrees with where they stand already (confirmStanding);
 * a yes from a guest who is out (left, removed) moves nothing and answers received, with no counter.
 */
export function takeGuestItem(item: RelayItem, now = Date.now()): GuestItemRefusal | GuestItemTaken | null {
    const env = item.envelope;
    if (!GUEST_ITEM_KINDS.has(env.kind) || !env.recipient.startsWith('group:') || !groupGuestsOn()) return null;
    const groupId = env.recipient.slice('group:'.length);
    const row = guestRow(groupId, env.senderKey);
    if (!row || row.home !== env.senderHome || isServerBlocked(row.home)) return null;
    try {
        loadGroupForThread(groupId);
    } catch {
        return null;
    }
    if (groupClosedAt(groupId)) return null;
    const payload = parsePayload(item.payload);
    if (env.kind === 'group-invite') {
        if (payload?.v !== 1 || (payload.answer !== 'yes' && payload.answer !== 'no')) return null;
        // A no from a guest who is in: their home showed the invitation again (a take-over, or a day of lost answers) and
        // they said no, so the home has them `declined`: taken as their leave, never kept in a roster they can't leave.
        if (row.state === 'in' && payload.answer === 'no') return takeGuestLeave(groupId, row);
        if (row.state === 'in' || ((row.state === 'left' || row.state === 'removed') && payload.answer === 'no')) return confirmStanding(groupId, row);
        // A yes from a guest who is out: it says nothing of where they stand (the host's removal, or their own word, does).
        if (row.state !== 'invited') return null;
        // Their yes puts them in the roster: markGroupEpochStale sends it to every guest's home, theirs too (queueGroupRoster).
        // The counter is issued first, so the roster that follows is newer than the answer (the order rule).
        let seq = 0;
        db.transaction(() => {
            setState(groupId, row.guest_key, payload.answer === 'yes' ? 'in' : 'left');
            seq = issueGuestSeq(groupId);
            if (payload.answer === 'yes') markGroupEpochStale(groupId);
        })();
        flushSoon();
        return { seq };
    }
    if (env.kind === 'group-leave') return row.state === 'in' || row.state === 'invited' ? takeGuestLeave(groupId, row) : confirmStanding(groupId, row);
    if (row.state !== 'in') return null;
    if (!payload) return 'group-refused';
    let refusal: GuestItemRefusal | null = null;
    if (env.kind === 'group-line') {
        const att = payload.attachment as { data?: unknown } | undefined;
        const bytes = att && typeof att.data === 'string' ? Buffer.byteLength(att.data, 'base64') : 0;
        if (bytes > 0 && guestMediaBytesToday(row.guest_key, now) + bytes > GUEST_MEDIA_BYTES_DAY) return 'group-refused';
        // Stored under its item's id: the one id their home's record of it has (relay-complaint.ts receiveComplaint).
        if (payload.clientId !== undefined && payload.clientId !== env.itemId) return 'group-refused';
        try {
            postGuestGroupLine(groupId, row.guest_key, {
                ciphertext: payload.ciphertext as string, nonce: payload.nonce as string, metadata: payload.metadata,
                type: payload.type, attachment: payload.attachment,
            }, env.itemId);
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

/**
 * A guest leaves (their leave, or a no once in): `left`; out of the roster when they were in, so the epoch goes stale. The
 * answer carries the counter it was stamped with, issued before the roster that follows (the order rule).
 */
function takeGuestLeave(groupId: string, row: GuestRow): GuestItemTaken {
    let seq = 0;
    db.transaction(() => {
        setState(groupId, row.guest_key, 'left');
        seq = issueGuestSeq(groupId);
        if (row.state === 'in') markGroupEpochStale(groupId);
    })();
    flushSoon();
    return { seq };
}

/**
 * A guest's word that agrees with where they stand here already (a yes from a guest in; a no or a leave from one who left
 * or was removed): nothing moves, and the answer CONFIRMS where they stand under the group's next counter (the order
 * rule, THE GUEST'S OWN WORD), so their home, ordering it with the notices, ends where they stand here (a home whose own
 * take-over lost the first answer: group-guest-home.ts, "A standby"). A yes from a guest in takes the roster to their
 * home again, newer than the answer, so the home holds the newest roster.
 */
function confirmStanding(groupId: string, row: GuestRow): GuestItemTaken {
    let seq = 0;
    db.transaction(() => {
        seq = issueGuestSeq(groupId);
        if (row.state === 'in') queueGroupRoster(groupId, row.home);
    })();
    flushSoon();
    return { seq };
}

// ── What this server tells the guests' homes ───────────────────────────────────────────────

/**
 * Every kind of row this server queues for a guest's home (group_guest_outbox.kind, its CHECK): the send rule is keyed by it
 * (SEND_RULES), so a kind added here without its rule doesn't type-check, and test-group-guests §19f reads this list, the
 * table's CHECK and every kind queueToHome is called with, and fails on a kind its table has no rows for.
 */
export const GUEST_NOTICE_KINDS = ['invite', 'roster', 'line', 'edit', 'epoch', 'removed'] as const;
type NoticeKind = (typeof GUEST_NOTICE_KINDS)[number];

/**
 * One request's body to one home: what it is, the group here, and the guests there it is for. It goes at the back of that
 * home's queue (its created_at is past every row the home has waiting, whatever the clock did), and it is due at once, so
 * it costs its home at most one try: that try sends the home's queue from its OLDEST row (sendToHome), never this row ahead
 * of one waiting, in backoff or not. A roster withdraws one still waiting for that home in the same group (only the latest
 * names count; a send in flight that the delete catches is a no-op when it ends) and goes as the newest row, so nothing it
 * says arrives before an older notice. Never on a standby: its copy of a change came from the main server, which queued and
 * sends it, and rows queued on a standby would go out stale after a promotion. A notice that says where its guests stand
 * (an invitation, a removal, the roster) or takes a line away carries the group's next counter (`seq`, the order rule:
 * the file's header), issued as it is queued.
 */
function queueToHome(groupId: string, home: string, guests: string[], kind: NoticeKind, data: unknown): void {
    const host = ownNodeHome();
    if (!host || !guests.length || getNodeRole() === 'backup' || isServerBlocked(home)) return;
    const ordered = kind === 'invite' || kind === 'roster' || takesAway(kind, data);
    const body = JSON.stringify({ v: 1, kind, group: groupId, host, guests: [...guests].sort(), ...(ordered ? { seq: issueGuestSeq(groupId) } : {}), data });
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

/** At most this many names of people no longer in the chat go in one roster's `former`: those who wrote last first. */
export const ROSTER_FORMER_MAX = 100;

/**
 * The names a home's guests need for lines they may have from people no longer in the chat (a roster's `former`; WALK
 * nov17b finding (a): on a guest's phone a fellow guest who left or was removed was named by a key fragment, because the
 * roster named only who is in). Everyone who wrote a line in the chat since `since` (when the first of that home's guests
 * in now came in: a line goes only to guests in, so an older one never reached them) and is not in the chat now
 * (`inChat`), by the rule a group line's author is named by (group-thread.ts groupLineAuthorName): a member here by their
 * name; else a guest of this group by their card's name and home, with where they stand (`left`, `removed`, or `invited`
 * again); else nobody (an account deleted: its lines are taken down for the guests too). Only names a guest there already
 * had a line from; a line taken down or a system line names nobody. Names only: none of these keys goes in the roster's
 * `members` or `guests`, the keys an epoch wraps to. The newest writers first, ROSTER_FORMER_MAX at most.
 */
function formerInChat(groupId: string, since: string, inChat: ReadonlySet<string>): { members: Array<{ key: string; name: string }>; guests: Array<{ key: string; home: string; name: string; state: GuestState }> } {
    const writers = db.prepare(`SELECT m.author_pubkey AS key, memb.callsign AS callsign, MAX(m.timestamp) AS last FROM messages m
                                LEFT JOIN members memb ON memb.public_key = m.author_pubkey
                                WHERE m.conversation_id = ? AND m.timestamp >= ? AND COALESCE(m.type, 'text') NOT IN ('system', 'removed')
                                GROUP BY m.author_pubkey ORDER BY last DESC, m.author_pubkey`).all(groupId, since) as Array<{ key: string; callsign: string | null }>;
    const members: Array<{ key: string; name: string }> = [];
    const guests: Array<{ key: string; home: string; name: string; state: GuestState }> = [];
    for (const w of writers) {
        if (members.length + guests.length >= ROSTER_FORMER_MAX) break;
        if (inChat.has(w.key) || w.key === 'SYSTEM') continue;
        const name = w.callsign ? clipName(w.callsign) : '';
        if (name) { members.push({ key: w.key, name }); continue; }
        const g = guestRow(groupId, w.key);
        if (g) guests.push({ key: g.guest_key, home: g.home, name: g.name, state: g.state });
    }
    return { members, guests };
}

/**
 * The names in the chat, members (as the chat names them) and guests, and the current epoch, to every home with guests in
 * (or to `onlyHome`, after one of its guests heard epoch-stale). Called at every roster change (group-keys.ts
 * markGroupEpochStale and withMembershipEpoch, inside the change's transaction), so it never throws into it: a roster that
 * can't be made is logged, and the change stands. The epoch carries its record and that home's guests' wraps when it is not
 * stale, so a guest who missed it can open it; a stale one says a new epoch is due, over exactly these keys. `former` names
 * the people out of the chat whose lines that home's guests may have (formerInChat): names only, never a key to wrap to.
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
        const inChat = new Set(roster);
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
            const since = guests.filter((g) => g.home === home).map((g) => g.state_at).sort()[0];
            queueToHome(groupId, home, keys, 'roster', { ...names, former: formerInChat(groupId, since, inChat), epoch });
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
    // Taken down before its turn came (the fan-out runs after the post's answer): its takedown said all there is to say.
    if (!row || row.type === 'removed') return;
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
 * A line of the chat edited, or taken down (its author's delete, a convenor's removal: engine/group-thread.ts
 * broadcastGroupChatUpdate, as members hear it): one `edit` request to each home with guests in, the line's author's
 * included. An edit carries the line as members now read it (sealed again under the line's own epoch); a line taken down
 * carries only its id and who took it down, as its tombstone says (`author` or `convenor`), never its words. An edit has
 * its line's audience: only guests wrapped the line's epoch hear of it (as a member who joined since never does,
 * group-thread.ts groupLineHearers), so a guest in now hears nothing of a line from before they were. Before either, every
 * copy of the line still queued here is withdrawn or rewritten (queueLineChange).
 */
export function fanOutGroupLineChange(groupId: string, messageId: string): void {
    if (queueLineChange(groupId, messageId)) flushSoon();
}

/**
 * A member deleted their account (state-engine.ts purgeMemberSelf, inside its transaction, after message-tombstone.ts
 * blankMessagesOf): each line of theirs it blanked, in a group that has had guests, is taken down for the guests as their
 * own delete is, `by: 'author'`, by THE TAKEDOWN RULE for many lines (queueTakedowns): for each group, one read of what is
 * queued and one request per home for every TAKEDOWN_IDS_MAX lines, never one a line (G2, #3233 round 2 note: a member with
 * years of lines held the purge's transaction for seconds and filled their homes' allowances). A line already down before
 * keeps the takedown it had. How many lines it took down.
 */
export function takeDownLinesOf(author: string): number {
    // Read by blankedWithAccount, which never throws: a row's metadata that is no JSON must not fail the account's deletion.
    const lines = (db.prepare(`SELECT id, conversation_id, metadata FROM messages WHERE author_pubkey = ? AND type = 'removed'
                               AND conversation_id IN (SELECT DISTINCT group_id FROM group_guests)`)
        .all(author) as Array<{ id: string; conversation_id: string; metadata: string | null }>).filter((l) => blankedWithAccount(l.metadata));
    const byGroup = new Map<string, Takedown[]>();
    for (const l of lines) {
        const list = byGroup.get(l.conversation_id) ?? [];
        if (!list.length) byGroup.set(l.conversation_id, list);
        list.push(takedownOf({ id: l.id, author_pubkey: author, metadata: l.metadata }));
    }
    let told = false;
    for (const [groupId, list] of byGroup) told = queueTakedowns(groupId, list) || told;
    if (told) flushSoon();
    return lines.length;
}

/** One line to take down for the guests: its id, who took it down (as its tombstone says), and the epoch it was sealed under. */
interface Takedown { id: string; by: 'author' | 'convenor'; epoch: number | null }

/** At most this many lines' ids in one takedown request (`ids`): one request stays a few tens of KB. */
export const TAKEDOWN_IDS_MAX = 500;

function takedownOf(row: { id: string; author_pubkey: string; metadata: string | null }): Takedown {
    const meta = parsePayload(row.metadata ?? '') ?? {};
    const epoch = typeof meta.epoch === 'number' && Number.isSafeInteger(meta.epoch) ? meta.epoch : null;
    return { id: row.id, by: meta.removedBy === row.author_pubkey ? 'author' : 'convenor', epoch };
}

/**
 * THE TAKEDOWN RULE, for one line or many of one group (#3233 round 2; G2): what a takedown says reaches every copy still
 * queued here before anything is told. Every queued copy of those lines (a line, an edit with new words), for EVERY home,
 * whoever is a guest now and whatever the switch says, is withdrawn, in one read of the group's queue, so their words and
 * sealed photo or voice never leave; a takedown already queued stays (takesAway). Then each home with guests in hears of the
 * lines its guests were wrapped (each line's audience, as fanOutGroupLineChange says), whatever the switch says: lines
 * grouped by who heard them and who took them down, one request each for every TAKEDOWN_IDS_MAX (`{ id, action: 'removed',
 * by }` for one line, `{ ids, action: 'removed', by }` for several), kept for as long as the home may hold the lines
 * (guestRowKeptMs). True when a request was queued.
 */
function queueTakedowns(groupId: string, lines: readonly Takedown[]): boolean {
    if (!lines.length) return false;
    const ids = new Set(lines.map((l) => l.id));
    const withdraw = db.prepare('DELETE FROM group_guest_outbox WHERE id = ?');
    const queued = db.prepare(`SELECT id, CASE WHEN json_valid(body) THEN json_extract(body, '$.data.id') END AS line,
                                      CASE WHEN json_valid(body) THEN json_extract(body, '$.data.action') END AS action
                               FROM group_guest_outbox WHERE group_id = ? AND kind IN ('line', 'edit')`).all(groupId) as Array<{ id: string; line: unknown; action: unknown }>;
    for (const q of queued) if (typeof q.line === 'string' && ids.has(q.line) && q.action !== 'removed') withdraw.run(q.id);
    const homes = guestHomes(groupId);
    if (!homes.size) return false;
    const keys = [...homes.values()].flat();
    const wrapped = new Map<number, Set<string>>();
    for (const w of db.prepare(`SELECT epoch, recipient_pubkey FROM group_key_wraps WHERE group_id = ? AND rejected_at IS NULL
                                AND recipient_pubkey IN (${keys.map(() => '?').join(', ')})`).all(groupId, ...keys) as Array<{ epoch: number; recipient_pubkey: string }>) {
        const set = wrapped.get(w.epoch) ?? new Set<string>();
        if (!set.size) wrapped.set(w.epoch, set);
        set.add(w.recipient_pubkey);
    }
    let told = false;
    for (const [home, homeKeys] of homes) {
        const batches = new Map<string, { heard: string[]; by: string; ids: string[] }>();
        for (const l of lines) {
            const w = l.epoch === null ? undefined : wrapped.get(l.epoch);
            const heard = w ? homeKeys.filter((k) => w.has(k)) : [];
            if (!heard.length) continue;
            const k = `${l.by}\n${heard.join(',')}`;
            const batch = batches.get(k) ?? { heard, by: l.by, ids: [] };
            if (!batch.ids.length) batches.set(k, batch);
            batch.ids.push(l.id);
        }
        for (const b of batches.values()) {
            for (let i = 0; i < b.ids.length; i += TAKEDOWN_IDS_MAX) {
                const chunk = b.ids.slice(i, i + TAKEDOWN_IDS_MAX);
                queueToHome(groupId, home, b.heard, 'edit', chunk.length === 1 ? { id: chunk[0], action: 'removed', by: b.by } : { ids: chunk, action: 'removed', by: b.by });
                told = true;
            }
        }
    }
    return told;
}

/** A line's row, as a copy of it reads its words. */
interface LineWords { type: string; ciphertext: string; nonce: string; metadata: string | null; edited_at: string | null }

/** A line's words as members read them now: what every copy of it still queued carries (queueLineChange, copyOfLine). */
function wordsNow(line: LineWords): { ciphertext: string; nonce: string; metadata: Record<string, unknown>; editedAt: string | null } {
    return { ciphertext: line.ciphertext, nonce: line.nonce, metadata: parsePayload(line.metadata ?? '') ?? {}, editedAt: line.edited_at };
}

/** The rows still queued here, for any home, that carry line `id` of a group (a line and its edits name it as data.id). */
function queuedCopiesOf(groupId: string, id: string, kind: 'line' | 'edit'): Array<{ id: string; kind: string; body: string }> {
    return db.prepare("SELECT id, kind, body FROM group_guest_outbox WHERE group_id = ? AND kind = ? AND json_extract(body, '$.data.id') = ?")
        .all(groupId, kind, id) as Array<{ id: string; kind: string; body: string }>;
}

/**
 * A change of a line (#3233 round 2): what it says reaches every copy of it still queued here before anything is told.
 * Taken down: THE TAKEDOWN RULE (queueTakedowns, the same for one line or an account's many). Edited: the line
 * still queued is rewritten with the newest words and an older edit still queued is withdrawn, so only the newest words
 * go. A send reads each row when its turn comes (sendToHome), so it sends what this leaves; the one row already on the wire
 * is followed by the change, queued behind it. Then the `edit` request to each home (fanOutGroupLineChange says who hears);
 * a takedown whatever the switch says, and kept for as long as the home may hold the line (guestRowKeptMs, #3233 round 4).
 * True when a request was queued.
 */
function queueLineChange(groupId: string, messageId: string): boolean {
    const row = db.prepare('SELECT id, author_pubkey, ciphertext, nonce, type, metadata, edited_at FROM messages WHERE id = ? AND conversation_id = ?')
        .get(messageId, groupId) as { id: string; author_pubkey: string; ciphertext: string; nonce: string; type: string; metadata: string | null; edited_at: string | null } | undefined;
    if (!row || row.type === 'system') return false;
    // A takedown, by the one rule for one line or many (queueTakedowns), told whatever the switch says (it only takes away:
    // takesAway): switched off and on again before the minute's timer removes the guests (closeGuestsIfSwitchedOff), their
    // homes still hold the line and hear of nothing else.
    if (row.type === 'removed') return queueTakedowns(groupId, [takedownOf(row)]);
    const meta = parsePayload(row.metadata ?? '') ?? {};
    const withdraw = db.prepare('DELETE FROM group_guest_outbox WHERE id = ?');
    for (const q of queuedCopiesOf(groupId, row.id, 'edit')) withdraw.run(q.id);
    const rewrite = db.prepare('UPDATE group_guest_outbox SET body = ? WHERE id = ?');
    for (const q of queuedCopiesOf(groupId, row.id, 'line')) {
        const body = JSON.parse(q.body) as { data: Record<string, unknown> };
        body.data = { ...body.data, ...wordsNow(row) };
        rewrite.run(JSON.stringify(body), q.id);
    }
    if (!groupGuestsOn()) return false;
    const homes = guestHomes(groupId);
    if (!homes.size) return false;
    const epoch = typeof meta.epoch === 'number' && Number.isSafeInteger(meta.epoch) ? meta.epoch : null;
    if (epoch === null) return false;
    const data = { id: row.id, action: 'edited', author: row.author_pubkey, ciphertext: row.ciphertext, nonce: row.nonce, metadata: meta, editedAt: row.edited_at };
    const wrapped = db.prepare('SELECT 1 FROM group_key_wraps WHERE group_id = ? AND epoch = ? AND recipient_pubkey = ? AND rejected_at IS NULL');
    let queued = false;
    for (const [home, keys] of homes) {
        const heard = keys.filter((k) => wrapped.get(groupId, epoch, k));
        if (!heard.length) continue;
        queueToHome(groupId, home, heard, 'edit', data);
        queued = true;
    }
    return queued;
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

/**
 * TELLING HOMES AGAIN (the order rule, the file's header): each group whose copied counter (group_guest_clock) is past the
 * last one this server issued for it (group_guest_told, this server's own), or that this server never issued one for: another
 * server told its guests' homes things whose rows this server never had (its outbox is its own), so this one tells each
 * home of the group again where its guests stand now (retellGroup). Run at each flush on the main server (flushGuestOutbox:
 * the minute timer, and after every change), so within a minute of a promotion, whichever way it came (a start as the main
 * server, a promotion in place). Never on a standby. How many groups were told again.
 */
export function retellGuestHomes(now = Date.now()): number {
    if (getNodeRole() === 'backup' || !ownNodeHome()) return 0;
    const behind = db.prepare(`SELECT c.group_id FROM group_guest_clock c LEFT JOIN group_guest_told t ON t.group_id = c.group_id
                               WHERE t.seq IS NULL OR t.seq < c.seq`).pluck().all() as string[];
    for (const groupId of behind) {
        try {
            db.transaction(() => retellGroup(groupId, now))();
        } catch (e) {
            // Never tried again each minute: logged, and this server's record caught up with the copy's counter.
            db.prepare('INSERT INTO group_guest_told (group_id, seq) SELECT group_id, seq FROM group_guest_clock WHERE group_id = ? ON CONFLICT (group_id) DO UPDATE SET seq = excluded.seq').run(groupId);
            logger.warn('SYS', `Group guests: the guests' homes of a group could not be told again after a take-over (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
        }
    }
    if (behind.length) flushSoon();
    return behind.length;
}

/**
 * One group's homes told again, under new counters, of where its guests stand on this server now: every invitation still
 * waiting (an invitation is never lost across a take-over); every removal and every line taken down within the time a home
 * may still hold what they take away (guestHeldWindowMs: past it, the home holds nothing they would drop); and the roster
 * to every home with guests in. Each is queued as at the change itself (queueToHome, queueTakedowns, queueGroupRoster), so
 * the send rule checks it again at its turn and nothing goes to a blocked home. A removal says why as well as this server
 * can tell now (the group closed, the switch off, or a convenor's Remove). Then this server's own record catches up.
 */
function retellGroup(groupId: string, now: number): void {
    const since = now - guestHeldWindowMs();
    const closed = !!groupClosedAt(groupId);
    let name: string | null = null;
    try { name = loadGroupForThread(groupId).name; } catch { /* a group that is gone: only what takes away is told */ }
    const rows = db.prepare('SELECT * FROM group_guests WHERE group_id = ? ORDER BY guest_key').all(groupId) as GuestRow[];
    if (name !== null && !closed && groupGuestsOn()) {
        for (const r of rows) {
            if (r.state === 'invited') queueToHome(groupId, r.home, [r.guest_key], 'invite', { name, invitedBy: { key: r.invited_by, name: callsignOf(r.invited_by) } });
        }
    }
    const removed = new Map<string, string[]>();
    for (const r of rows) {
        if (r.state !== 'removed' || !(Date.parse(r.state_at) >= since)) continue;
        const keys = removed.get(r.home) ?? [];
        if (!keys.length) removed.set(r.home, keys);
        keys.push(r.guest_key);
    }
    const why = closed ? 'group-closed' : groupGuestsOn() ? 'removed' : 'closed';
    for (const [home, keys] of removed) {
        for (let i = 0; i < keys.length; i += GROUP_GUESTS_MAX) queueToHome(groupId, home, keys.slice(i, i + GROUP_GUESTS_MAX), 'removed', { why });
    }
    const downs = db.prepare(`SELECT id, author_pubkey, metadata FROM messages WHERE conversation_id = ? AND type = 'removed'
                              AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.removedAt') END >= ?`)
        .all(groupId, new Date(since).toISOString()) as Array<{ id: string; author_pubkey: string; metadata: string | null }>;
    queueTakedowns(groupId, downs.map(takedownOf));
    queueGroupRoster(groupId);
    issueGuestSeq(groupId);
}

/** After the caller's transaction, the outbox's due rows go (the minute timer catches what this misses). */
function flushSoon(): void {
    setImmediate(() => {
        flushGuestOutbox().catch((e) => logger.warn('SYS', `Group guests: a send to another community failed (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`));
    });
}

interface OutboxRow { id: string; group_id: string; home: string; kind: NoticeKind; attempts: number; next_try_at: number; created_at: number }
/** A queued row's body, as queueToHome wrote it: the guests it names and what it says. */
interface Notice { guests?: unknown; data?: Record<string, unknown> }

/** A queued row's body read back, or null when it is no JSON object (such a row never goes). */
function noticeOf(body: string): Notice | null {
    try {
        const n = JSON.parse(body) as unknown;
        return n && typeof n === 'object' && !Array.isArray(n) ? n as Notice : null;
    } catch { return null; }
}

/** Where a guest a queued row names stands here now, or null when they are no guest of the group from that row's home. */
function standingHere(groupId: string, home: string, key: string): GuestState | null {
    const g = guestRow(groupId, key);
    return g && g.home === home ? g.state : null;
}

/** The notice naming only `keep` of the guests it named: the same notice when that is all of them, null when it is none. */
function narrowed(notice: Notice, named: readonly string[], keep: readonly string[]): Notice | null {
    if (!keep.length) return null;
    return keep.length === named.length ? notice : { ...notice, guests: [...keep] };
}

/**
 * A copy of a line (a `line` row, or an `edit` with new words) as it may still go: while the line stands in this server's
 * chat now (a standby's copy carries the tombstone the main server wrote) and its group is open, to the guests it names who
 * are still in from that home, carrying the line's words as members read them now (edited on the server that took over,
 * the newest words go, as an edit here rewrites a queued copy: queueLineChange).
 */
function copyOfLine(r: OutboxRow, notice: Notice, named: readonly string[]): Notice | null {
    const data = notice.data ?? {};
    if (groupClosedAt(r.group_id)) return null;
    const line = db.prepare('SELECT type, ciphertext, nonce, metadata, edited_at FROM messages WHERE id = ? AND conversation_id = ?').get(data.id, r.group_id) as LineWords | undefined;
    if (!line || line.type === 'removed' || line.type === 'system') return null;
    const out = narrowed(notice, named, named.filter((k) => standingHere(r.group_id, r.home, k) === 'in'));
    if (!out || (data.ciphertext === line.ciphertext && data.nonce === line.nonce)) return out;
    return { ...out, data: { ...data, ...wordsNow(line) } };
}

type SendRule = (r: OutboxRow, notice: Notice, named: readonly string[]) => Notice | null;

/**
 * THE SEND RULE (#3233 round 5), one for each kind: a row waits here for its home while what it says may change, here or on
 * the server that took over (whose writes this server's copy carries), so as its turn comes it is checked again against
 * this server's state AT THAT MOMENT and goes only while what it says is still true. It answers the notice to send (naming
 * only the guests it may still name, a copy of a line with the line's words now) or null: the row goes unsent. Before it,
 * for every kind (bodyToSend): no row once guestRowKeptMs old, nothing to a home the owners blocked (cross-chat design
 * §4.2, take-aways included), and with guests switched off only what takes away.
 */
const SEND_RULES: Record<NoticeKind, { says: string; check: SendRule }> = {
    line: {
        says: "while the line stands here and its group is open, to the guests it names who are still in, with the line's words now",
        check: copyOfLine,
    },
    edit: {
        says: "a takedown always (a line once down stays down); new words as a line goes: while the line stands here and its group is open, to the guests it names who are still in, with the line's words now",
        check: (r, n, named) => (n.data?.action === 'removed' ? n : n.data?.action === 'edited' ? copyOfLine(r, n, named) : null),
    },
    removed: {
        // On one server a guest can't be in again while a removal of theirs is still queued for that home: their new
        // invitation queues behind it, so their yes comes only after the home has it. In here now, they joined again
        // through the server that took over, and their home must keep them (#3233 round 5).
        says: 'naming only the guests it names who are not in here now from that home (invited again and in, here or on the server that took over, their home keeps them)',
        check: (r, n, named) => narrowed(n, named, named.filter((k) => standingHere(r.group_id, r.home, k) !== 'in')),
    },
    invite: {
        says: 'while its group is open, to the guests it names who are still invited here from that home',
        check: (r, n, named) => (groupClosedAt(r.group_id) ? null : narrowed(n, named, named.filter((k) => standingHere(r.group_id, r.home, k) === 'invited'))),
    },
    roster: {
        // A change here queues the newer roster and withdraws this one (queueToHome); one the server that took over made
        // sent its own. Which of two servers' rosters a home keeps: the newer counter (the order rule, G2).
        says: "while its group is open, the guests it names are the guests in from that home now, and the keys it lists are the chat's keys now",
        check: (r, n, named) => {
            if (groupClosedAt(r.group_id)) return null;
            const fromHome = guestsIn(r.group_id).filter((g) => g.home === r.home).map((g) => g.guest_key);
            const d = n.data ?? {};
            const listed = [...(Array.isArray(d.members) ? d.members : []), ...(Array.isArray(d.guests) ? d.guests : [])]
                .map((e) => (e as { key?: unknown } | null)?.key).filter((k): k is string => typeof k === 'string').sort();
            return [...named].sort().join(',') === fromHome.sort().join(',') && listed.join(',') === groupKeyRoster(r.group_id).join(',') ? n : null;
        },
    },
    epoch: {
        says: "while its group is open and it is still this group's epoch of that number here, to the guests it names who are still in, with only their wraps",
        check: (r, n, named) => {
            const d = n.data ?? {};
            const record = (d.record ?? null) as { epoch?: unknown; sig?: unknown } | null;
            if (groupClosedAt(r.group_id)) return null;
            const sig = db.prepare('SELECT sig FROM group_key_epochs WHERE group_id = ? AND epoch = ?').pluck().get(r.group_id, record?.epoch ?? null) as string | undefined;
            if (sig === undefined || sig !== record?.sig) return null;
            const keep = named.filter((k) => standingHere(r.group_id, r.home, k) === 'in');
            const out = narrowed(n, named, keep);
            if (!out || out === n) return out;
            const wraps = (Array.isArray(d.wraps) ? d.wraps : []).filter((w) => keep.includes((w as { recipient?: string } | null)?.recipient ?? ''));
            return { ...out, data: { ...d, wraps } };
        },
    },
};

/** Each kind's send rule in words (test-group-guests §19f: every kind has one, and rows in its table). */
export const GUEST_ROW_RULES: Readonly<Record<NoticeKind, string>> = Object.fromEntries(
    GUEST_NOTICE_KINDS.map((k) => [k, SEND_RULES[k].says]),
) as Record<NoticeKind, string>;

/**
 * A queued row as its turn comes: the body to send, or null when it goes unsent. No row once guestRowKeptMs old (a row that
 * adds once GUEST_FANOUT_QUEUE_MS old, so a server promoted days later sends nothing stale; one that only takes away for as
 * long as its home may still hold what it takes away, #3233 round 4); nothing to a home the owners blocked; with guests
 * switched off, only what takes away; then the kind's own rule (SEND_RULES). A kind with no rule never goes.
 */
function bodyToSend(r: OutboxRow, body: string, at: number, on: boolean, blocked: boolean): string | null {
    const notice = noticeOf(body);
    if (!notice || blocked) return null;
    const data = notice.data ?? {};
    if (at - r.created_at >= guestRowKeptMs(r.kind, data)) return null;
    if (!on && !takesAway(r.kind, data)) return null;
    if (!(GUEST_NOTICE_KINDS as readonly string[]).includes(r.kind)) return null;
    const named = Array.isArray(notice.guests) ? notice.guests.filter((k): k is string => typeof k === 'string') : [];
    const out = SEND_RULES[r.kind].check(r, notice, named);
    return out === null ? null : out === notice ? body : JSON.stringify(out);
}

/** Each home being sent to now, and that send: one at a time for a home, every home on its own. */
const sendingTo = new Map<string, Promise<number>>();

/**
 * Each home with a row due, sent to: one signed request a row, to its home's GROUP_GUEST_PATH. Each home on its own and all
 * at once (as the mailbox's forwards go, engine/relay-outbox.ts forwardRows): a home that doesn't answer costs its own rows
 * one wait (FORWARD_TIMEOUT_MS) and holds up no other home's. A home already being sent to is joined, never sent to twice
 * at once; its send takes every row queued while it ran before it ends, so a row queued meanwhile goes then, not at the
 * next minute. Resolves when every home it started or joined is done; answers how many rows the homes it started handled.
 * Never on a standby (closeGuestsIfSwitchedOff says why). First, homes another server told are told again (retellGuestHomes).
 */
export async function flushGuestOutbox(now = Date.now()): Promise<number> {
    if (getNodeRole() === 'backup') return 0;
    retellGuestHomes();
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
 * 413), and the row goes; anything else and ALL the home's rows wait one backoff, by time (nextFanoutTry: the step moves on
 * only when the oldest row's wait has passed), until the row is guestRowKeptMs old, then it goes: a row that adds after
 * GUEST_FANOUT_QUEUE_MS, a row that only takes away (takesAway) once its home can hold nothing it takes away. A 2xx starts
 * the steps over. Each row is checked again as its turn comes (bodyToSend, SEND_RULES): with guests switched off only the
 * rows that take away go, to a home the owners blocked nothing goes, and a row goes only while what it says is still true
 * here, naming only the guests it may still name; otherwise it goes unsent. Made a standby meanwhile, the send stops.
 */
async function sendToHome(home: string): Promise<number> {
    let handled = 0;
    const url = `https://${home}${GROUP_GUEST_PATH}`;
    const drop = db.prepare('DELETE FROM group_guest_outbox WHERE id = ?');
    for (;;) {
        const queue = db.prepare('SELECT id, group_id, home, kind, attempts, next_try_at, created_at FROM group_guest_outbox WHERE home = ? ORDER BY created_at, rowid LIMIT 64')
            .all(home) as OutboxRow[];
        if (!queue.length) return handled;
        const on = groupGuestsOn();
        const blocked = isServerBlocked(home);
        const bodyNow = db.prepare('SELECT body FROM group_guest_outbox WHERE id = ?').pluck();
        for (const r of queue) {
            // Made a standby while this send ran: nothing more goes from here (its rows wait, and a promotion checks them again).
            if (getNodeRole() === 'backup') return handled;
            // Each row as it reads when its turn comes: one withdrawn while this send ran (a newer roster replaced it, a
            // takedown withdrew it, it aged out) never goes, and one an edit rewrote goes with the newest words (queueLineChange).
            const body = bodyNow.get(r.id) as string | undefined;
            if (body === undefined) continue;
            handled++;
            // The send rule, as this server stands now: what goes (perhaps naming fewer guests, a line with its words now),
            // or nothing, and the row goes unsent. A failed try keeps the row as queued, checked again at its next turn.
            const notice = noticeOf(body);
            const send = bodyToSend(r, body, fanoutNow(), on, blocked);
            if (send === null || !notice) { drop.run(r.id); continue; }
            const status = await forwardSigned(url, send);
            const at = fanoutNow();
            const taken = status >= 200 && status < 300;
            const final = taken || status === 400 || status === 404 || status === 413;
            if (final || at - r.created_at >= guestRowKeptMs(r.kind, notice.data)) {
                drop.run(r.id);
                if (taken) db.prepare('UPDATE group_guest_outbox SET attempts = 0 WHERE home = ? AND attempts > 0').run(home);
                else logger.warn('SYS', `Group guests: ${home} did not take a notice (status ${status}); it is not tried again.`);
                continue;
            }
            // One schedule for the home, held on every row of it: the oldest row's, moved on by time (nextFanoutTry). Read
            // from the table now, not from `queue`: a 2xx earlier in this send started the steps over (#3217 round 2).
            const step = db.prepare('SELECT attempts, next_try_at FROM group_guest_outbox WHERE id = ?').get(r.id) as { attempts: number; next_try_at: number } | undefined;
            const next = nextFanoutTry(step?.attempts ?? r.attempts, step?.next_try_at ?? r.next_try_at, at);
            // The home's rows past the age each is kept (guestRowKeptMs) go: one that adds after a day, one that takes away
            // only once the home can hold nothing it takes away.
            const old = db.prepare('SELECT id, kind, body, created_at FROM group_guest_outbox WHERE home = ? AND created_at <= ?')
                .all(home, at - GUEST_FANOUT_QUEUE_MS) as Array<{ id: string; kind: string; body: string; created_at: number }>;
            db.transaction(() => {
                for (const o of old) if (at - o.created_at >= guestRowKeptMs(o.kind, noticeOf(o.body)?.data)) drop.run(o.id);
                db.prepare('UPDATE group_guest_outbox SET attempts = ?, next_try_at = ? WHERE home = ?').run(next.attempts, next.nextTryAt, home);
            })();
            return handled;
        }
    }
}
