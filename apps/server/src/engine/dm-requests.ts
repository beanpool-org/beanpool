/**
 * Message requests (scratch/fable-design/DESIGN-message-a-friend-fable.md §4, slice S1; Marty accepted the design's ten
 * recommendations on 23 Oct 2026): where the community's `dmRequests` switch is on (config/node-profile.ts: the global
 * community by default, a local one only if its operator turns it on in Settings), a member's first message to someone who
 * hasn't added them, written to them or traded with them waits as a request. The person it is for reads it (their own key
 * opens it, on their own device; the node never reads it) and accepts, ignores or blocks; the sender writes more once they
 * accept. A request is a direct conversation with one more state: nothing here touches sealing, keys or pins.
 *
 * ## Who goes straight through (requestNeeded)
 *
 * Decided when a new direct conversation is opened, in favour of the person it is for: they have added the opener as a
 * friend; they have written to the opener, or opened a chat with them; the opener holds a node role (owner, admin,
 * moderator); or the two have a trade under way or done (`marketplace_transactions` pending or completed). A chat the node
 * opens (a trade's, chat consolidation: `asNode` in engine/messaging.ts) is never a request, nor is one opened while
 * requests were off. A listing's author is no exception: "pay me first" to sellers is the common scam on an open door.
 *
 * ## What each side can do
 *
 * - The opener writes ONE line (a photo with its caption is one), then every line and every reaction is refused in words
 *   (403 `dm_request_pending`) until it is accepted. Their own line edits and deletes as any line. The request is made by
 *   that line, not by the open: until the opener writes, nobody is asked anything (the apps open the chat when someone
 *   taps Message, before they type), so it isn't listed, counted or ignored, and its 30 days start at the line.
 * - The person it is for has it in their list apart (`requests`, newest first), not in their chats, their unread count or
 *   the badge their pushes carry. They accept or ignore it (routes/messaging.ts), or Ignore all. Their own line in it (an
 *   admin's answer from the node's inbox too, nodeLineInRequest), their own open of the chat (Message on the opener's
 *   profile), adding the opener as a friend, or a trade between the two opening, each accepts it too. Accepting makes
 *   nobody a friend. A visitor's row it is for (a key a member messaged, or a member of another community reached over the
 *   relay) decides it as a member does, and nothing else new (the director's option b on PR #2392 review 4355750376).
 * - The opener can cancel it (Cancel request): their lines in it go, and it is withdrawn. Nothing of the other person's
 *   accepts a withdrawn request (Marty, 28 Oct 2026, PR #2540: the node's state is the authority): their Accept and Ignore
 *   find none (404), and their line or their asking for the chat is a request of their own to the opener, unless the rule
 *   lets them through on their own; their adding the opener lets the opener's next line through, and nothing of theirs.
 *   While the opener blocks them, that request of theirs reaches the opener no more than their lines do ("A block the
 *   opener made", below): the row stays as the opener left it, and theirs is kept for them alone (`reached_out_at`,
 *   reachedOutRow), read and answered as the row turned round is. Once the block is lifted, a line kept during it is no
 *   request's line, as an opener's isn't (openerLinesSince), and their next line turns it round (PR #2540 review
 *   4396980737). The opener's own line answers that request of theirs, as it would the row turned round (Marty, 28 Oct
 *   2026: "B: shows as accepted"): they read it accepted, in their chats, and nothing tells them they are blocked, an
 *   Ignore of theirs from before it notwithstanding (review 4397305910); the opener reads the request their line made as
 *   waiting, until they lift the block (answerReachOut). Once they cancel theirs, the opener's line is a request of the
 *   opener's own again, as it is when nobody blocks anyone (cancelReachOut, review 4399348393).
 * - Neither side's read marker reaches the other until it is accepted.
 * - 30 days after it was made, a request nobody accepted is over (expireOldRequests): the opener's next line is a new
 *   request, from then.
 *
 * ## What the opener reads: the same, whatever became of it
 *
 * Every answer the opener gets is the one a request nobody has opened gets, whether it was ignored or the other blocked them
 * (before it, or after it): the open's `request`, a second line's and a reaction's refusal, their list's entry, their read of
 * the chat, and nothing on their sockets. A blocked opener's conversation is kept for them alone (engine/withheld-lines.ts)
 * and has its request row too, under the id it keeps when it becomes real. So the opener's view of the state is read from
 * the request's age and its acceptance only ({@link viewOf}): 'pending', 'expired' once 30 days have passed (an ignored
 * request too, or ignoring would show), or 'accepted', which is visible because the opener can write again.
 *
 * A block lifted is one exception, as lifting it is meant to be: the line kept for the opener during it never reaches the
 * other person, so it no longer counts as the request's one line, and the opener's next line is (openerLinesSince). Until
 * that line makes a conversation kept for them the real one, it is still theirs alone: an acceptance in it rings only them
 * ({@link accept}, PR #2392 review 4355143120). The opener's own view says so (`nextLineIsRequest`, by that same count), as
 * their apps can't tell from the lines: the kept one is among those they read, and must not be told apart (PR #2404 review
 * 4356625513). It shows a lifted block no more than their next line going through does, which Marty accepted on 23 Oct
 * 2026; while the block holds it reads as any waiting request's, after the 30 days too, and nothing in it says which line
 * was kept. Nor does it tell an opener of an acceptance they read as not made (the next part): their line is answered
 * as a waiting request's, and their view says what that answer is.
 *
 * A block the opener made is the other. What a blocked member does never reaches the person who blocked them
 * (engine/member-blocks.ts), and an acceptance would, by the composer coming back. So while the opener blocks the person
 * it was for, an acceptance that person made after the block reads to the opener as not made ({@link acceptanceHiddenFrom}):
 * 'pending', or 'expired' once 30 days have passed, and their next line and reaction are refused as a waiting request's
 * are. It shows once they lift the block. The person who accepted reads it as they left it (the director's option b on
 * PR #2392 review 4354581168). Nor does a request of their own that the person makes once the opener has withdrawn theirs
 * (reachedOutRow): the opener reads their own, withdrawn, as they left it, and once they write, the request their line
 * makes, which that person's reaching out accepted, as waiting (answerReachOut).
 *
 * ## A block the person it is for made
 *
 * The mirror (the director's, 23 Oct, on the PR #2392 deciding pass at 7d20c62d). While the person it is for blocks the
 * opener, an acceptance of the opener's own act after the block (their line or reaction, once a role or a trade lets them
 * through) reads to that person as not made ({@link acceptanceHiddenFrom}): as they left it (`state_before`: waiting,
 * lapsed or ignored), in neither of their lists, nor their unread count or badge. They may Ignore it, and read it ignored;
 * the opener, whose own act accepted it, reads nothing new and writes on. Their own act (an Accept, a line, their open of
 * the chat) or a trade's accepts it again, and lifting the block shows it: an Ignore made meanwhile was
 * of a request the opener had accepted already, as option b's opener reads one once they lift theirs. Once each of them has
 * accepted it, it shows to both. A removal of the opener ignores it, as one nobody accepted. The opener's line after the
 * 30 days makes no new request either, while the block holds: it is kept for them alone, so it moves only the request's
 * time, and one the person ignored, or that lapsed, stays as they left it (PR #2410 review 4356319500); once they lift the
 * block, the opener's next line is the new request (openerLinesSince). Where requests are off, one
 * the person ignored stays out of their lists, whether the opener's act accepted it while on or he writes while off: his
 * line is kept for him alone then, so it makes no new request ({@link lineWhileOff}).
 *
 * ## The switch turned off
 *
 * Where requests were on and are turned off, nothing waits: every line goes through, and a request still waiting, or one
 * that lapsed, is an ordinary chat. One the person ignored, or a removal ignored (dropRequestsOf), stays out of their
 * lists, their unread count and their badge: that was their decision, or the removal's (PR #2392 review 4354581049). Their
 * own act accepts any of them, as when on ({@link acceptable}): one ignored comes back as an ordinary chat, and one waiting
 * or lapsed stays in their chats when the switch goes on again (review 4354806252). The opener's next line in one ignored
 * makes it a new request from then, an ordinary chat while off (lineWhileOff), as one after its 30 days is: nothing is
 * stored or pushed into a chat the person can't find.
 *
 * ## Pushes
 *
 * The request's first line pushes "{name} wants to message you" instead of "sent you a message", at most once an hour per
 * person: requests in the hour after one are folded into one "Someone new wants to message you" when the hour is over
 * (tickRequestPushFolds), if any is still waiting. A folded line does the push's work all the same and drops it, as a
 * withheld one does, so the work after the answer never tells a sender which happened (#1403 re-review).
 *
 * ## Where it is kept
 *
 * `dm_requests` (schema.sql section 30), one row per request, copied verbatim to a standby for a real conversation (a plain
 * table, engine/replication-manifest.ts). A standby makes none of its own: every decision is refused there, and so is an
 * open or a line that would write one. A removal or self-deletion of either person deletes theirs, except one they made that
 * nobody accepted, in a real conversation, which is ignored so it never becomes an ordinary chat (dropRequestsOf); a re-key
 * moves them (engine/key-move.ts).
 */
import { word, wordsFor } from '@beanpool/core';
import { db, deletePlainRows, afterTransactionCommit, writeTombstone } from '../db/db.js';
import { deleteStoredObjects } from '../storage/image-columns.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { assertPlainTablesWritable, standbyWritesNothing } from '../config/node-role.js';
import { nodeRoleOf } from './node-roles.js';
import { hasBlocked } from './member-blocks.js';
import { withheldConversationOwnedBy } from './withheld-lines.js';

// The words layer in English: a node never writes in the device language (core words.test N11). A refusal a member reads
// is marked with word() instead, and member-words.ts translates it on the way out; one with a {name} in it is written here in
// English, as the server's other templated refusals still are (PR #2400, part 2 item 3).
const { t } = wordsFor('en');

/** A request nobody accepted is over this many days after it was made (Marty's answer 10). */
export const REQUEST_DAYS = 30;
const REQUEST_MS = REQUEST_DAYS * 24 * 60 * 60 * 1000;
/** The most waiting requests one list names; the rest are counted (the apps show 50, then "and {n} more"). */
export const REQUESTS_LISTED_MAX = 100;
/** One request push per person per this long; the rest fold into one (Marty's answer 7). */
export const REQUEST_PUSH_EVERY_MS = 60 * 60 * 1000;
/** A second line, or a reaction, from the opener of a request still waiting. */
export const DM_REQUEST_PENDING_CODE = 'dm_request_pending';

export type RequestState = 'pending' | 'accepted' | 'ignored' | 'expired';

interface RequestRow {
    conversation_id: string;
    from_pubkey: string;
    to_pubkey: string;
    state: RequestState;
    requested_at: string;
    decided_at: string | null;
    accepted_by: string | null;
    state_before: 'pending' | 'ignored' | 'expired' | null;
    reached_out_at: string | null;
    reach_out_withdrawn_at: string | null;
}

/** A request as one of its two people reads it: its state for them, who opened it, and when it was made. */
export interface RequestView {
    state: RequestState;
    from: string;
    at: string;
    /**
     * The opener's own view of one not accepted only: whether their next line is the request's line, as the node counts
     * their lines (openerLinesSince), and not refused (the header's "What the opener reads"). Never in the other's view.
     */
    nextLineIsRequest?: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

type Ring = (event: any, recipients: string[]) => void;
let ring: Ring = () => {};
/** The live events, wired by state-engine.ts at boot (its `broadcast`), as engine/messaging.ts gets them by callback. */
export function setRequestBroadcast(fn: Ring): void {
    ring = fn;
}

/** Whether this community holds a stranger's first message as a request (the `dmRequests` switch). */
export function requestsOn(): boolean {
    return getProfileSwitches().dmRequests;
}

function rowOf(conversationId: string): RequestRow | undefined {
    return db.prepare('SELECT * FROM dm_requests WHERE conversation_id = ?').get(conversationId) as RequestRow | undefined;
}

/** 30 days or more since it was made (a time that can't be read counts as over). */
function over(row: RequestRow, now: number): boolean {
    const at = Date.parse(row.requested_at);
    return !Number.isFinite(at) || at <= now - REQUEST_MS;
}

/**
 * The request as `viewer` reads it. The opener reads only its age and its acceptance (the header's "same, whatever became of
 * it"), and not an acceptance made while they block the one who made it (acceptanceHiddenFrom), and, while it isn't
 * accepted, whether their next line is its line, by the count their line is judged by (lineThroughRequest); the person it is
 * for reads what they did with it, and 'expired' for one that waited 30 days, and one whose acceptance is hidden from them as
 * they left it (`state_before`).
 */
function viewOf(row: RequestRow, viewer: string, now: number): RequestView {
    // A request of their own the viewer made while the opener of a withdrawn one blocked them is read as its opener reads one.
    row = reachedOutRow(row, viewer) ?? row;
    let state: RequestState;
    const hidden = acceptanceHiddenFrom(row, viewer);
    if (row.state === 'accepted' && !hidden) state = 'accepted';
    else if (viewer === row.from_pubkey) state = over(row, now) ? 'expired' : 'pending';
    else {
        const was = hidden ? row.state_before ?? 'pending' : row.state;
        state = was === 'pending' && over(row, now) ? 'expired' : was;
    }
    const view: RequestView = { state, from: row.from_pubkey, at: row.requested_at };
    if (viewer === row.from_pubkey && state !== 'accepted') view.nextLineIsRequest = state === 'expired' || openerLinesSince(row) === 0;
    return view;
}

/**
 * Whether `viewer`, one of the two, reads the request's acceptance as not made: the other accepted it by their own act after
 * `viewer` had blocked them, and the block still holds (the header's "A block the opener made" and "A block the person it
 * is for made"). An acceptance of the viewer's own act, a trade's, or one each of them made (accepted_by null) always shows.
 */
function acceptanceHiddenFrom(row: RequestRow, viewer: string): boolean {
    const other = viewer === row.from_pubkey ? row.to_pubkey : viewer === row.to_pubkey ? row.from_pubkey : null;
    if (row.state !== 'accepted' || !other || row.accepted_by !== other) return false;
    const block = db.prepare('SELECT created_at FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?')
        .get(viewer, other) as { created_at: string } | undefined;
    return !!block && Date.parse(block.created_at) <= Date.parse(row.decided_at ?? '');
}

/**
 * What lets `from` through whatever `to` has done: a node role of theirs, or a trade between the two under way or done,
 * which each of them has in the open. Nothing `to` did that a block of theirs would keep from `from`.
 */
function throughOnTheirOwn(from: string, to: string): boolean {
    if (nodeRoleOf(from)) return true;
    return !!db.prepare(`
        SELECT 1 FROM marketplace_transactions
         WHERE status IN ('pending', 'completed')
           AND ((buyer_pubkey = @from AND seller_pubkey = @to) OR (buyer_pubkey = @to AND seller_pubkey = @from))
    `).get({ from, to });
}

/**
 * Whether a direct conversation `from` opens with `to` is a request (the header's "Who goes straight through"). Read as
 * the rule is at the open, and again at each of the opener's lines while it waits, so a role granted or a trade begun since
 * lets them through. Read for the request in `conversationId`, that conversation's own open is no chat `to` opened with
 * them: it is `to`'s withdrawn request's, which `from` asking for the chat or writing in it turned into theirs
 * (reachOutAfterWithdrawal).
 */
export function requestNeeded(from: string, to: string, conversationId?: string): boolean {
    if (throughOnTheirOwn(from, to)) return false;
    return !db.prepare(`
        SELECT 1 WHERE
            EXISTS (SELECT 1 FROM friends WHERE owner_pubkey = @to AND friend_pubkey = @from)
         OR EXISTS (SELECT 1 FROM conversation_participants theirs
                      JOIN conversations c ON c.id = theirs.conversation_id AND c.type = 'dm'
                      JOIN conversation_participants mine ON mine.conversation_id = c.id AND mine.public_key = @from
                     WHERE theirs.public_key = @to
                       AND ((c.created_by = @to AND c.id IS NOT @conv)
                            OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.author_pubkey = @to)))
         OR EXISTS (SELECT 1 FROM withheld_conversations w WHERE w.owner_pubkey = @to AND w.other_pubkey = @from)
    `).get({ from, to, conv: conversationId ?? null });
}

/**
 * A request its opener withdrew (Cancel request, which stamps `decided_at`), or one ignored or run out, with no line of
 * theirs left in it, stored or kept for them alone. It asks the person it was for nothing, and nothing of theirs accepts it
 * (Marty, 28 Oct 2026, PR #2540: the node's state is the authority): not their Accept (decideRequest's 404, as for an open
 * with nothing written in it), their line, their asking for the chat, nor their adding the opener. An open its opener
 * hasn't written in yet was never decided (`decided_at` null), and isn't one: their act accepts that, as the header says.
 */
function withdrawn(row: RequestRow): boolean {
    if (row.state === 'accepted' || row.decided_at === null) return false;
    return !db.prepare(`SELECT 1 FROM dm_requests r WHERE r.conversation_id = ? AND ${OPENER_WROTE}`).get(row.conversation_id)
        && keptLinesSince(row) === 0;
}

/**
 * The person a withdrawn request was for (`who`) reaching out to its opener themselves, by their line or their asking for
 * the chat: a request of their own, in the one conversation the two have, where the rule holds them (requestNeeded, apart
 * from the opener's open of it). It is made from now, as an open makes one, so their next line is its line
 * (lineThroughRequest), and until then it asks the opener nothing. True when it was made; false where the rule lets them
 * through on their own (the opener added them, a line of the opener's from before, a role, a trade), and their act accepts
 * the request as before. A standby refuses it, as it refuses an open that would make one.
 *
 * While the opener blocks them, nothing of theirs reaches the opener (engine/member-blocks.ts), and turning the row round
 * would: it takes the chat out of the opener's list and their chat reads someone else's request (PR #2540 review
 * 4396980737). So the row stays as the opener left it, and their own request is kept for them alone from `reached_out_at`,
 * as their lines then are (reachedOutRow). Their asking again while it stands changes nothing, as an opener's asking for
 * their own chat doesn't. 'turned' when the row was turned round, 'kept' when theirs is kept for them.
 */
function reachOutAfterWithdrawal(row: RequestRow, who: string, now: number): false | 'turned' | 'kept' {
    if (!requestNeeded(who, row.from_pubkey, row.conversation_id)) return false;
    if (hasBlocked(row.from_pubkey, who)) {
        if (!row.reached_out_at) {
            assertPlainTablesWritable();
            db.prepare('UPDATE dm_requests SET reached_out_at = ? WHERE conversation_id = ?').run(iso(now), row.conversation_id);
        }
        return 'kept';
    }
    assertPlainTablesWritable();
    db.prepare(`UPDATE dm_requests SET from_pubkey = ?, to_pubkey = ?, state = 'pending', requested_at = ?, decided_at = NULL,
                       accepted_by = NULL, state_before = NULL, reached_out_at = NULL, reach_out_withdrawn_at = NULL
                 WHERE conversation_id = ?`).run(who, row.from_pubkey, iso(now), row.conversation_id);
    return 'turned';
}

/**
 * The request of their own that `who`, the person a withdrawn request was for, made while its opener blocked them
 * (reachOutAfterWithdrawal): the row turned round, made at `reached_out_at`, which only they read and are answered by, as
 * one not blocked reads the row itself. The opener reads the row as they left it. Waiting while the request is still
 * withdrawn; accepted once anything has accepted the row since (the opener's line, answerReachOut; a trade; a role or a
 * friend add letting one of them through), as the row turned round would be: by the opener's act, unless each of them
 * accepted it or a trade did (`accepted_by` null), so one hidden from them reads as such (acceptanceHiddenFrom). Withdrawn
 * once they cancel it (`reach_out_withdrawn_at`, cancelReachOut), as the row turned round is by their cancel. Null for
 * anyone else, and once the request is no longer withdrawn with nothing having accepted it.
 */
function reachedOutRow(row: RequestRow, who: string): RequestRow | null {
    if (!row.reached_out_at || who !== row.to_pubkey) return null;
    const turned: RequestRow = {
        ...row, from_pubkey: row.to_pubkey, to_pubkey: row.from_pubkey, requested_at: row.reached_out_at, state_before: null,
        reached_out_at: null, reach_out_withdrawn_at: null,
    };
    if (row.state === 'accepted') return { ...turned, accepted_by: row.accepted_by === null ? null : row.from_pubkey };
    if (!withdrawn(row)) return null;
    return { ...turned, state: 'pending', decided_at: row.reach_out_withdrawn_at, accepted_by: null };
}

/**
 * The opener's line once the person their withdrawn request was for has reached out to them while they blocked them
 * (reachedOutRow): it answers that person's request, as the line of the person a request is for does when nobody blocks
 * anyone (Marty, 28 Oct 2026, PR #2540: "B: shows as accepted"). The one who reached out reads their request accepted,
 * still in their chats, with the opener's line in it as an ordinary one, pushed and counted as one: nothing tells them they
 * are blocked. The opener reads a request of their own made by this line, as any line of theirs makes one: the row is
 * theirs again, made now, and accepted by the other's act (their reach-out came first), so while they block that person it
 * reads to them as not made (acceptanceHiddenFrom): waiting, their next line and reaction refused as a waiting request's
 * are, until they lift the block. `reached_out_at` stays, for the one who reached out (reachedOutRow). An Ignore of theirs
 * from before the reach-out is gone, as their reaching out turns the row round when nobody blocks them (PR #2540 review
 * 4397305910). Each of the two hears what they now read, if it is accepted: the opener, only once they have lifted the block.
 */
function answerReachOut(row: RequestRow, now: number): void {
    assertPlainTablesWritable();
    db.prepare(`UPDATE dm_requests SET state = 'accepted', requested_at = ?, decided_at = ?, accepted_by = to_pubkey, state_before = state,
                       reach_out_withdrawn_at = NULL
                 WHERE conversation_id = ?`).run(iso(now), iso(now), row.conversation_id);
    afterTransactionCommit(() => ringAccepted(row.conversation_id, [row.to_pubkey, row.from_pubkey], now));
}

/** `who`, each on their own sockets, hear the request as they now read it (viewOf), if that is accepted. */
function ringAccepted(conversationId: string, who: string[], now: number): void {
    const row = rowOf(conversationId);
    if (!row) return;
    for (const one of who) {
        const request = viewOf(row, one, now);
        if (request.state === 'accepted') ring({ type: 'dm_request_updated', conversationId, request }, [one]);
    }
}

/**
 * Whether an act of the person a request is for (`actor`: their Accept, line or own open of the chat), or a trade between
 * the two (no actor), accepts it: any request not accepted yet, whatever the switch says, and one whose
 * acceptance reads as not made to the actor, or for a trade to either of them (acceptanceHiddenFrom). Where requests were
 * turned off since, one they ignored is still kept out of their lists (sortRequestsOut), so their act brings it back; and
 * one waiting or lapsed, an ordinary chat while off, stays where they put it when the switch goes on again (PR #2392 review
 * 4354806252).
 */
function acceptable(row: RequestRow | undefined, actor?: string): row is RequestRow {
    if (!row) return false;
    if (row.state !== 'accepted') return true;
    return actor ? acceptanceHiddenFrom(row, actor) : acceptanceHiddenFrom(row, row.from_pubkey) || acceptanceHiddenFrom(row, row.to_pubkey);
}

/**
 * Accept it: its state, whose act it was, the state it had (`state_before`), and the two people's sockets (the opener's app
 * can write again), after the write commits. Never the socket of one who has blocked the other: what a blocked member does
 * never reaches the person who blocked them (engine/member-blocks.ts), nor does an acceptance that comes of it (PR #2392
 * review 4354581168). `actor`, whose act it is, always hears their own. One accepted already is accepted again only where
 * it reads as not made to one of the two (acceptable): by that one's own act, or a trade's. Each of them has accepted it
 * then, so it shows to both (accepted_by null), and only the actor hears: the other reads nothing new. A trade has no
 * actor: the one it was hidden from hears, as what they read is now accepted, though they block the other. The trade is
 * the node's act, not the blocked member's (PR #2410 review 4356205998).
 *
 * A conversation still kept for its opener alone when the write commits (engine/withheld-lines.ts; a block lifted since,
 * then the person adding them, or a role letting them through) is no chat the person it was for has: only the opener
 * hears, even when the act was the other's. The event names it and its opener, so it would tell that person someone wrote
 * to them while blocked (PR #2392 review 4355143120). They hear of it when the opener's next line makes it real.
 */
function accept(row: RequestRow, now: number, actor?: string): void {
    const again = row.state === 'accepted';
    if (again && !acceptable(row, actor)) return;
    const shownTo = again && !actor ? [row.from_pubkey, row.to_pubkey].filter(who => acceptanceHiddenFrom(row, who)) : [];
    assertPlainTablesWritable();
    // `reached_out_at` stays: one who reached out after a withdrawal reads the acceptance as of their own request (reachedOutRow).
    const changed = db.prepare(`UPDATE dm_requests SET state = 'accepted', decided_at = ?, accepted_by = ?,
                                       state_before = CASE WHEN state = 'accepted' THEN state_before ELSE state END
                                 WHERE conversation_id = ? AND (state != 'accepted' OR ?)`)
        .run(iso(now), again ? null : actor ?? null, row.conversation_id, again ? 1 : 0).changes;
    if (changed === 0) return;
    const hears = again ? (actor ? [actor] : shownTo) : [[row.from_pubkey, row.to_pubkey], [row.to_pubkey, row.from_pubkey]]
        .filter(([who, other]) => who === actor || !hasBlocked(who, other)).map(([who]) => who);
    if (hears.length === 0) return;
    afterTransactionCommit(() => {
        const real = !!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(row.conversation_id);
        const heard = real ? hears : hears.filter(who => who === row.from_pubkey);
        if (heard.length > 0) ringAccepted(row.conversation_id, heard, now);
    });
}

// ── the open ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A new direct conversation `from` opens with `to` (engine/messaging.ts createConversation, inside its write; a blocked
 * opener's kept one too): a request when requests are on and the rule says so. On a standby, which writes none of these
 * rows, that open is refused (409 `standby`) rather than made with no request.
 */
export function openRequest(conversationId: string, from: string, to: string, at: string): void {
    if (!requestsOn() || !requestNeeded(from, to)) return;
    assertPlainTablesWritable();
    db.prepare(`INSERT INTO dm_requests (conversation_id, from_pubkey, to_pubkey, state, requested_at) VALUES (?, ?, ?, 'pending', ?)
                ON CONFLICT(conversation_id) DO NOTHING`).run(conversationId, from, to, at);
}

/**
 * `who` asks for a conversation they are in (engine/messaging.ts createConversation finding the one the two have): when it
 * is a request waiting for them, asking for it themselves is reaching out to its opener, as writing is, and accepts it.
 * Where requests are on, a standby refuses that open (409 `standby`) rather than leave it waiting; where they are off,
 * nothing waits, and a standby, which writes no request, leaves it, as for a line (lineWhileOff).
 */
export function acceptOnOpen(conversationId: string, who: string, now: number = Date.now()): void {
    const row = rowOf(conversationId);
    if (!acceptable(row, who) || row.to_pubkey !== who) return;
    if (!requestsOn() && standbyWritesNothing()) return;
    // One its opener withdrew is no request of theirs to accept: asking for the chat is reaching out anew.
    if (requestsOn() && withdrawn(row) && reachOutAfterWithdrawal(row, who, now)) return;
    accept(row, now, who);
}

/**
 * A conversation kept for a blocked opener alone becoming the real one, under its id (engine/messaging.ts): its request,
 * if it has one, is stamped, so it starts travelling to a standby with the conversation (the manifest's REAL_CONVERSATIONS).
 */
export function requestBecameReal(conversationId: string): void {
    db.prepare("UPDATE dm_requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE conversation_id = ?").run(conversationId);
}

/** A kept conversation that won't become real (the two had a real one already): its request goes with it. */
export function dropRequestOf(conversationId: string): void {
    deletePlainRows('dm_requests', 'conversation_id = ?', conversationId);
}

// ── a line, a reaction ─────────────────────────────────────────────────────────────────────────────────────────

/** What a line does to a request: nothing, it is the request's line, or it is refused (in these words, 403). */
export type LineThroughRequest =
    | { kind: 'direct' }
    /** `ignored`: one the person ignored, which the line leaves ignored: its push is done and dropped, and only its author hears it. */
    | { kind: 'request'; to: string; ignored?: boolean }
    | { kind: 'refused'; message: string };
const DIRECT: LineThroughRequest = { kind: 'direct' };

/**
 * The opener's lines in the conversation since the request was made: stored, and, while the person it is for still blocks
 * them, kept for them alone. A line kept during a block never reaches that person, not even once it is lifted
 * (engine/withheld-lines.ts), so after an unblock only a stored line is the request's: the opener's next line is, and it
 * makes a conversation kept for them the real one (PR #2392 review 4354388176). Counted otherwise, the request would wait
 * 30 days with nothing for the person to accept, nor any chat to find it in.
 */
function openerLinesSince(row: RequestRow): number {
    const args = { c: row.conversation_id, a: row.from_pubkey, at: row.requested_at };
    const stored = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = @c AND author_pubkey = @a AND timestamp >= @at')
        .get(args) as { n: number }).n;
    if (stored > 0 || !hasBlocked(row.to_pubkey, row.from_pubkey)) return stored;
    return keptLinesSince(row);
}

/** The opener's lines since the request was made that were kept for them alone, during a block then or still. */
function keptLinesSince(row: RequestRow): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM withheld_lines WHERE conversation_id = ? AND author_pubkey = ? AND timestamp >= ?')
        .get(row.conversation_id, row.from_pubkey, row.requested_at) as { n: number }).n;
}

/** The refusal of the opener's line or reaction while their request waits for `to`. */
function waitingFor(to: string, what: 'write' | 'react'): string {
    const name = (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(to) as { callsign?: string | null } | undefined)?.callsign;
    if (what === 'write') {
        return name
            ? t('Your first message is waiting for {name}. You can write more once they accept it.', { name })
            : word('Your first message is waiting. You can write more once it is accepted.');
    }
    return name
        ? t('Your first message is waiting for {name}. You can react once they accept it.', { name })
        : word('Your first message is waiting. You can react once it is accepted.');
}

/**
 * A member's line in a direct conversation (engine/messaging.ts sendMessage), after every refusal of who may write there and
 * of the line itself, and before it is stored or kept for its sender alone, so the answer is the same either way:
 * - the person a request waits for writing in it accepts it, and one whose acceptance they read as not made;
 * - the opener, when the rule no longer holds them (a friend add, a role, a trade since), is let through and it is accepted;
 * - the opener's first line is the request's line, and so is their first after the 30 days, which makes it a new request;
 *   while the person blocks them, that line, kept for them alone, only starts the 30 days again, and the request stays as
 *   the person left it;
 * - any other line of the opener's is refused.
 * An opener who reads its acceptance as not made (acceptanceHiddenFrom) is answered as if it still waited: only what lets
 * them through on their own (throughOnTheirOwn) does, and a line of theirs that would be the request's goes through and
 * starts the 30 days again for them, but it is an ordinary line to the person who accepted it.
 */
export function lineThroughRequest(conversationId: string, author: string, now: number = Date.now()): LineThroughRequest {
    const row = rowOf(conversationId);
    if (!row) return DIRECT;
    if (!requestsOn()) {
        if (acceptable(row, author)) lineWhileOff(row, author, now);
        return DIRECT;
    }
    // One who reached out after a withdrawal, while its opener blocked them, whose request something has accepted since.
    const mine = reachedOutRow(row, author);
    if (mine?.state === 'accepted') return lineInAnsweredReachOut(row, mine, author, now);
    const hidden = acceptanceHiddenFrom(row, author);
    if (row.state === 'accepted' && !hidden) return DIRECT;
    if (author === row.to_pubkey) {
        // A request its opener withdrew is never accepted by the line of the person it was for: the line is a request of
        // their own (reachOutAfterWithdrawal), answered as any opener's line is, and nothing reaches the opener's chats.
        const reached = withdrawn(row) && reachOutAfterWithdrawal(row, author, now);
        if (reached === 'turned') return lineThroughRequest(conversationId, author, now);
        if (reached === 'kept') return lineOfReachOut(rowOf(conversationId)!, author, now);
        accept(row, now, author);
        return DIRECT;
    }
    if (author !== row.from_pubkey) return DIRECT;
    if (hidden ? throughOnTheirOwn(row.from_pubkey, row.to_pubkey) : !requestNeeded(row.from_pubkey, row.to_pubkey, row.conversation_id)) {
        accept(row, now, author);
        return DIRECT;
    }
    // The other reached out after the opener withdrew it, while the opener blocked them (reachedOutRow): this line answers
    // them, and to them it is an ordinary line, whatever the opener reads (answerReachOut). Before any branch below, an
    // Ignore of theirs from before the reach-out among them (PR #2540 review 4397305910). Not once they cancelled it
    // (cancelReachOut): the line is a request of the opener's own then, from now, as it is when it turns round a request
    // withdrawn by one nobody blocks (reachOutAfterWithdrawal), so it is made below, their Ignore from before notwithstanding
    // (review 4399348393).
    const theirs = !hidden && !!reachedOutRow(row, row.to_pubkey);
    if (theirs && !row.reach_out_withdrawn_at) {
        answerReachOut(row, now);
        return DIRECT;
    }
    const requestLine: LineThroughRequest = hidden ? DIRECT : { kind: 'request', to: row.to_pubkey };
    // The request's line makes it one waiting from then. Not one whose acceptance the opener reads as not made, nor while the
    // person it is for blocks them: the line is kept for the opener alone then (engine/withheld-lines.ts), so it moves only
    // the request's time, and what the person made of it stays as they left it (PR #2410 review 4356319500). One answered
    // after the other reached out keeps `reached_out_at`, which is what that person reads (reachedOutRow).
    const made = hidden || hasBlocked(row.to_pubkey, author)
        ? 'UPDATE dm_requests SET requested_at = ? WHERE conversation_id = ?'
        : "UPDATE dm_requests SET state = 'pending', requested_at = ?, decided_at = NULL, reached_out_at = NULL, reach_out_withdrawn_at = NULL WHERE conversation_id = ?";
    if (over(row, now)) {
        assertPlainTablesWritable();
        db.prepare(made).run(iso(now), row.conversation_id);
        return requestLine;
    }
    if (openerLinesSince(row) > 0) return { kind: 'refused', message: waitingFor(row.to_pubkey, 'write') };
    // One the person ignored whose line its opener withdrew since (Cancel request, decideRequest), with nothing of theirs
    // kept during a block either, stays ignored for the rest of its 30 days: the line moves only the request's time, as one
    // kept during a block does, so the opener's answers stay a waiting request's, and its push is done and dropped, as a
    // folded one's is (PR #2540 review 4393642102). Cancelling and writing again never undoes an Ignore; the person reaching
    // out since does (answered above). One ignored before a block lifted since has the line kept during it, and is a new
    // request with this one, as above. One the person reached out in since, and cancelled, is no Ignore of theirs (above).
    if (row.state === 'ignored' && keptLinesSince(row) === 0 && !theirs) {
        if (!standbyWritesNothing()) db.prepare('UPDATE dm_requests SET requested_at = ? WHERE conversation_id = ?').run(iso(now), row.conversation_id);
        return { kind: 'request', to: row.to_pubkey, ignored: true };
    }
    // The request's line: the request is made by it, so its 30 days run from it, not from the open (PR #2392 review
    // 4354580417). Stored after this, so it is a line since the request was made (OPENER_WROTE). A standby stamps nothing.
    // One the person had ignored, or that had lapsed, when a line kept during their block moved its time is a new request
    // with it, once the block is lifted (openerLinesSince).
    if (!standbyWritesNothing()) db.prepare(made).run(iso(now), row.conversation_id);
    return requestLine;
}

/**
 * A line in a request of their own that the person a withdrawn request was for made while its opener blocks them
 * (reachedOutRow), answered as a line in the row turned round is (lineThroughRequest, the opener's): the first, or the first
 * after its 30 days, is its line and makes it from then, one they cancelled again too (cancelReachOut); any other is
 * refused. The line is kept for them alone (engine/withheld-lines.ts), so only the time of their own request moves, and
 * nothing the opener reads.
 */
function lineOfReachOut(row: RequestRow, author: string, now: number): LineThroughRequest {
    const mine = reachedOutRow(row, author)!;
    if (over(mine, now)) assertPlainTablesWritable();
    else if (openerLinesSince(mine) > 0) return { kind: 'refused', message: waitingFor(row.from_pubkey, 'write') };
    if (!standbyWritesNothing()) {
        db.prepare('UPDATE dm_requests SET reached_out_at = ?, reach_out_withdrawn_at = NULL WHERE conversation_id = ?').run(iso(now), row.conversation_id);
    }
    return { kind: 'request', to: row.from_pubkey };
}

/**
 * A line of the one who reached out (`mine`, reachedOutRow) once something accepted the row since, answered as a line of
 * the opener of the row turned round is (lineThroughRequest): it goes through, unless the acceptance reads to them as not
 * made, as it does while they block the opener themselves (acceptanceHiddenFrom). Then, as an opener's who reads it so,
 * their first line, or first after its 30 days, goes through and moves their own request's time (`reached_out_at`), any
 * other is refused, and only what lets them through on their own lets more through.
 */
function lineInAnsweredReachOut(row: RequestRow, mine: RequestRow, author: string, now: number): LineThroughRequest {
    if (!acceptanceHiddenFrom(mine, author) || throughOnTheirOwn(author, mine.to_pubkey)) return DIRECT;
    if (over(mine, now)) assertPlainTablesWritable();
    else if (openerLinesSince(mine) > 0) return { kind: 'refused', message: waitingFor(mine.to_pubkey, 'write') };
    if (!standbyWritesNothing()) db.prepare('UPDATE dm_requests SET reached_out_at = ? WHERE conversation_id = ?').run(iso(now), row.conversation_id);
    return DIRECT;
}

/**
 * The node's own line in a direct conversation (engine/messaging.ts sendMessage `nodeAuthored`: the admin page's message,
 * written as the node admin it is sent as). It is never held or refused, and is no request's line; but in the chat it is
 * that admin's line, which requestNeeded counts as their having written to the opener. So a request waiting for them is
 * accepted by it, as their own line accepts it (lineThroughRequest), and its opener reads it answered (PR #2392 review
 * 4355066390).
 */
export function nodeLineInRequest(conversationId: string, author: string, now: number = Date.now()): void {
    const row = rowOf(conversationId);
    if (!acceptable(row, author) || row.to_pubkey !== author) return;
    if (requestsOn()) accept(row, now, author);
    else lineWhileOff(row, author, now);
}

/**
 * A line where requests were turned off since, in a request not accepted: it goes through. The person's own line accepts
 * it, as when on, so it stays in their chats when the switch goes on again (PR #2392 review 4354806252). The opener's
 * leaves one waiting or lapsed as it is (an ordinary chat while off), but one the person ignored is still kept out of their
 * lists, and the line would be stored where they never look: it makes that one a new request from then, an ordinary chat
 * while off (the header's "The switch turned off"). Not while the person blocks the opener: the line is kept for the opener
 * alone then (engine/withheld-lines.ts), stored nowhere the person looks, and the request stays as they left it (the
 * header's "A block the person it is for made"). The opener's line once the other reached out after a withdrawal, while the
 * opener blocked them, answers them, as when on (answerReachOut). A standby, which writes no request, leaves it.
 */
function lineWhileOff(row: RequestRow, author: string, now: number): void {
    if (standbyWritesNothing()) return;
    if (author === row.to_pubkey) accept(row, now, author);
    else if (author === row.from_pubkey && row.state !== 'accepted' && reachedOutRow(row, row.to_pubkey)) answerReachOut(row, now);
    else if (author === row.from_pubkey && row.state === 'ignored' && !hasBlocked(row.to_pubkey, author)) {
        db.prepare("UPDATE dm_requests SET state = 'pending', requested_at = ?, decided_at = NULL, reached_out_at = NULL, reach_out_withdrawn_at = NULL WHERE conversation_id = ?")
            .run(iso(now), row.conversation_id);
    }
}

/**
 * The refusal of a reaction by the opener of a request still waiting, or of one they read as not accepted
 * (acceptanceHiddenFrom), or null (engine/messaging.ts toggleMessageReaction). One who made a request of their own after
 * a withdrawal, while its opener blocked them (reachedOutRow), is answered as its opener.
 */
export function reactionRefusal(conversationId: string, author: string, now: number = Date.now()): string | null {
    if (!requestsOn()) return null;
    const stored = rowOf(conversationId);
    const row = stored && (reachedOutRow(stored, author) ?? stored);
    if (!stored || !row || author !== row.from_pubkey) return null;
    const hidden = acceptanceHiddenFrom(row, author);
    if (row.state === 'accepted' && !hidden) return null;
    if (hidden ? throughOnTheirOwn(row.from_pubkey, row.to_pubkey) : !requestNeeded(row.from_pubkey, row.to_pubkey, row.conversation_id)) {
        accept(stored, now, author);
        return null;
    }
    return waitingFor(row.to_pubkey, 'react');
}

// ── acts elsewhere that accept ─────────────────────────────────────────────────────────────────────────────────

/**
 * `owner` added `friend` (engine/social.ts addFriend): a request from them waiting for `owner` is accepted, as the design's
 * "I chose you". A standby, which adds a friend as the main server does, writes no request of its own: it gets the
 * acceptance with the main server's copy. (No acceptance is hidden from `owner` here: nobody adds someone they block.)
 */
export function acceptOnFriendAdd(owner: string, friend: string, now: number = Date.now()): void {
    if (standbyWritesNothing()) return;
    const rows = db.prepare("SELECT * FROM dm_requests WHERE from_pubkey = ? AND to_pubkey = ? AND state != 'accepted'").all(friend, owner) as RequestRow[];
    // One `friend` withdrew stays theirs: the add lets their next line through (requestNeeded), and lets nothing of
    // `owner`'s reach them.
    for (const row of rows) if (acceptable(row, owner) && !withdrawn(row)) accept(row, now, owner);
}

/**
 * A trade between the two opening its chat (engine/messaging.ts ensureTransactionConversation) accepts a request in it, and
 * one whose acceptance either of them reads as not made.
 */
export function acceptOnTrade(conversationId: string, now: number = Date.now()): void {
    if (standbyWritesNothing()) return;
    const row = rowOf(conversationId);
    if (acceptable(row)) accept(row, now);
}

// ── the lists ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The opener of request `r` has a line stored in it since it was made. Until then it asks nothing of anyone: the apps ask
 * for the chat when someone taps Message, before they type, so an open alone is no request to list, count or ignore
 * (PR #2392 review 4354580417).
 */
const OPENER_WROTE = `EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = r.conversation_id
                                  AND mm.author_pubkey = r.from_pubkey AND mm.timestamp >= r.requested_at)`;

/**
 * The requests waiting for `viewer`, newest first: in a real conversation they are in, made in the last 30 days, with the
 * opener's line in it, from a member still here (not removed, not deleted) whom the viewer hasn't blocked. A blocked
 * member's request never lists.
 */
function waitingRows(viewer: string, now: number, onlyId?: string): RequestRow[] {
    return db.prepare(`
        SELECT r.* FROM dm_requests r
          JOIN members m ON m.public_key = r.from_pubkey AND m.status != 'pruned' AND m.deleted_by_owner_at IS NULL
         WHERE r.to_pubkey = @viewer AND r.state = 'pending' AND r.requested_at > @since
           AND (@only IS NULL OR r.conversation_id = @only)
           AND r.conversation_id IN (SELECT conversation_id FROM conversation_participants WHERE public_key = @viewer)
           AND NOT EXISTS (SELECT 1 FROM member_blocks b WHERE b.owner_pubkey = @viewer AND b.blocked_pubkey = r.from_pubkey)
           AND ${OPENER_WROTE}
         ORDER BY r.requested_at DESC, r.conversation_id
    `).all({ viewer, since: iso(now - REQUEST_MS), only: onlyId ?? null }) as RequestRow[];
}

/** A list entry or a conversation, with the fields this reads and changes. */
interface Listed {
    id: string;
    type: string;
    peerLastReadAt?: string | null;
}

/**
 * A member's conversation list (GET /api/messages/conversations): each direct conversation with its `request` (null for an
 * ordinary one), neither side's read marker on one not accepted, and the requests waiting for the viewer taken out into
 * `requests` (at most REQUESTS_LISTED_MAX, and how many in all). A request for the viewer that isn't waiting (ignored,
 * expired, from someone they blocked or who is gone) is in neither. Where requests are off, `requests` is null and the list
 * is as it always was, less the requests the viewer ignored (the header's "The switch turned off").
 */
export function sortRequestsOut<T extends Listed>(viewer: string, convs: T[], now: number = Date.now()):
    { listed: (T & { request?: RequestView | null })[]; requests: (T & { request: RequestView; addedYou: boolean })[] | null; count: number } {
    if (!requestsOn()) {
        const ignored = ignoredBy(viewer);
        return { listed: ignored.size === 0 ? convs : convs.filter(c => c.type !== 'dm' || !ignored.has(c.id)), requests: null, count: 0 };
    }
    const rows = new Map((db.prepare('SELECT * FROM dm_requests WHERE from_pubkey = ? OR to_pubkey = ?').all(viewer, viewer) as RequestRow[])
        .map(r => [r.conversation_id, r]));
    const waiting = new Map(waitingRows(viewer, now).map((r, i) => [r.conversation_id, i]));
    const listed: (T & { request?: RequestView | null })[] = [];
    const requests: { at: number; entry: T & { request: RequestView; addedYou: boolean } }[] = [];
    const addedMe = db.prepare('SELECT 1 FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?');
    for (const c of convs) {
        if (c.type !== 'dm') { listed.push(c); continue; }
        const row = rows.get(c.id);
        if (!row) { listed.push({ ...c, request: null }); continue; }
        const request = viewOf(row, viewer, now);
        const entry = request.state === 'accepted' ? { ...c, request } : { ...c, request, peerLastReadAt: null };
        // Their own request is in their chats, as an accepted one is: the opener's, and one the viewer made after a withdrawal
        // while its opener blocked them, which they read as its opener (reachedOutRow).
        if (request.from === viewer || request.state === 'accepted') { listed.push(entry); continue; }
        const at = waiting.get(c.id);
        if (at !== undefined) requests.push({ at, entry: { ...entry, request, addedYou: !!addedMe.get(row.from_pubkey, viewer) } });
    }
    requests.sort((a, b) => a.at - b.at);
    return { listed, requests: requests.slice(0, REQUESTS_LISTED_MAX).map(r => r.entry), count: requests.length };
}

/**
 * One conversation as `viewer` reads it (the open's answer, GET /api/messages/:id): with its `request` (null for an ordinary
 * direct one), and the other's read marker left out while it isn't accepted. Unchanged where requests are off, or for
 * anything but a direct conversation.
 */
export function withRequestFor<T extends { id: string; type: string }>(conv: T, viewer: string | undefined, now: number = Date.now()): T {
    if (!viewer || conv.type !== 'dm' || !requestsOn()) return conv;
    const row = rowOf(conv.id);
    if (!row) return { ...conv, request: null };
    const request = viewOf(row, viewer, now);
    const out: any = { ...conv, request };
    if (request.state !== 'accepted' && Array.isArray(out.readCursors)) {
        out.readCursors = out.readCursors.map((c: any) => (c?.publicKey === viewer ? c : { ...c, lastReadAt: null }));
    }
    return out;
}

/**
 * The requests for `viewer` they ignored (or a removal of their opener ignored), and one they had ignored, or ignored since,
 * whose acceptance by its opener's own act is hidden from them (acceptanceHiddenFrom).
 */
function ignoredBy(viewer: string): Set<string> {
    const rows = db.prepare(`SELECT * FROM dm_requests WHERE to_pubkey = ?
                                AND (state = 'ignored' OR (state = 'accepted' AND state_before = 'ignored' AND accepted_by = from_pubkey))`)
        .all(viewer) as RequestRow[];
    return new Set(rows.filter(r => (r.state === 'ignored' && !reachedOutRow(r, viewer)) || acceptanceHiddenFrom(r, viewer)).map(r => r.conversation_id));
}

/**
 * The conversations `viewer`'s badge and unread count leave out (state-engine.ts getListedUnreadCounts): every request for
 * them they haven't accepted, or whose acceptance is hidden from them, but not one they read as their own (reachedOutRow).
 * Where requests are off, the ones they ignored, which their list leaves out too.
 */
export function heldFromUnread(viewer: string): Set<string> {
    if (!requestsOn()) return ignoredBy(viewer);
    const rows = db.prepare("SELECT * FROM dm_requests WHERE to_pubkey = ? AND (state != 'accepted' OR accepted_by = from_pubkey)").all(viewer) as RequestRow[];
    return new Set(rows.filter(r => (r.state !== 'accepted' && !reachedOutRow(r, viewer)) || acceptanceHiddenFrom(r, viewer)).map(r => r.conversation_id));
}

// ── the decisions (routes/messaging.ts) ────────────────────────────────────────────────────────────────────────

export class RequestDecisionError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'RequestDecisionError';
    }
}

/**
 * The person a request is for accepts or ignores it. The opener may do neither (403), whether their conversation is real or
 * kept for them alone; to anyone else, and for a conversation with no request waiting for them (one its opener hasn't
 * written in yet among them), it is a request nobody has (404, the same answer as an id nobody has). Accepting an accepted one, or ignoring an ignored one, changes nothing; an
 * accepted one can't be ignored (409). Ignoring rings only the ignorer's own sockets: the opener is never told.
 *
 * One whose acceptance by its opener's own act is hidden from the person (acceptanceHiddenFrom) is answered as they read it,
 * as it was: Accept accepts it again, and Ignore makes it read to them as ignored (`state_before`) while it stays accepted
 * for its opener, who reads nothing new (the header's "A block the person it is for made").
 */
export function decideRequest(conversationId: string, actor: string, decision: 'accept' | 'ignore' | 'cancel', now: number = Date.now()): RequestView {
    const row = typeof conversationId === 'string' && requestsOn() ? rowOf(conversationId) : undefined;
    // A request of their own the actor made after a withdrawal, while its opener blocked them, is decided as its opener's.
    const reachedOut = row ? reachedOutRow(row, actor) : null;
    if (decision === 'cancel') {
        if (row && reachedOut) return cancelReachOut(row, reachedOut, actor, now);
        if (row && row.to_pubkey === actor) {
            throw new RequestDecisionError(403, 'not_request_opener', word('Only the person who sent a message request can cancel it.'));
        }
        const real = !!row && (
            !!db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(row.conversation_id, actor)
            || !!withheldConversationOwnedBy(row.conversation_id, actor)
        );
        if (!row || row.from_pubkey !== actor || !real) {
            throw new RequestDecisionError(404, 'request_not_found', word('There is no message request for you in this chat.'));
        }
        const isAccepted = row.state === 'accepted' && !acceptanceHiddenFrom(row, actor);
        const asked = isAccepted || openerLinesSince(row) > 0;
        if (isAccepted || over(row, now) || !asked) {
            throw new RequestDecisionError(409, 'request_not_pending', word('Only a pending message request can be cancelled.'));
        }
        assertPlainTablesWritable();
        withdrawOpenerLines(row);
        // The opener's decision: what marks it withdrawn (withdrawn), so nothing of the other's accepts it. Its state, which
        // the opener's own view never reads, stays; an acceptance hidden from them keeps the time it was made.
        if (row.state !== 'accepted') db.prepare('UPDATE dm_requests SET decided_at = ?, reached_out_at = NULL, reach_out_withdrawn_at = NULL WHERE conversation_id = ?').run(iso(now), row.conversation_id);
        const isReal = !!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(row.conversation_id);
        const openerView = viewOf(row, actor, now);
        const recipientHears = isReal && !hasBlocked(row.to_pubkey, actor) && row.state !== 'ignored';
        ring({ type: 'dm_request_updated', conversationId: row.conversation_id, request: openerView }, [actor]);
        if (recipientHears) {
            const recipientView = viewOf(row, row.to_pubkey, now);
            ring({ type: 'dm_request_updated', conversationId: row.conversation_id, request: recipientView }, [row.to_pubkey]);
        }
        return openerView;
    }
    if (row && (row.from_pubkey === actor || reachedOut)) {
        throw new RequestDecisionError(403, 'not_request_recipient', word('Only the person a message request was sent to can accept or ignore it.'));
    }
    const real = !!row && !!db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(row.conversation_id, actor);
    const hidden = !!row && acceptanceHiddenFrom(row, actor);
    // An open with nothing written in it yet asks nothing (OPENER_WROTE): ignoring it would swallow the line after it.
    const asked = !!row && ((row.state === 'accepted' && !hidden)
        || !!db.prepare(`SELECT 1 FROM dm_requests r WHERE r.conversation_id = ? AND ${OPENER_WROTE}`).get(row.conversation_id));
    if (!row || row.to_pubkey !== actor || !real || !asked) {
        throw new RequestDecisionError(404, 'request_not_found', word('There is no message request for you in this chat.'));
    }
    if (decision === 'accept') {
        accept(row, now, actor);
    } else if (hidden) {
        if (row.state_before !== 'ignored') {
            assertPlainTablesWritable();
            db.prepare("UPDATE dm_requests SET state_before = 'ignored' WHERE conversation_id = ?").run(row.conversation_id);
            ring({ type: 'dm_request_updated', conversationId: row.conversation_id, request: viewOf({ ...row, state_before: 'ignored' }, actor, now) }, [actor]);
        }
    } else if (row.state === 'accepted') {
        throw new RequestDecisionError(409, 'request_accepted', word('You have accepted this chat already, so it is no longer a request.'));
    } else if (row.state !== 'ignored') {
        assertPlainTablesWritable();
        db.prepare("UPDATE dm_requests SET state = 'ignored', decided_at = ? WHERE conversation_id = ?").run(iso(now), row.conversation_id);
        ring({ type: 'dm_request_updated', conversationId: row.conversation_id, request: viewOf({ ...row, state: 'ignored' }, actor, now) }, [actor]);
    }
    return viewOf(rowOf(row.conversation_id)!, actor, now);
}

/**
 * The cancel of a request of their own that the person a withdrawn request was for made while its opener blocked them
 * (`mine`, reachedOutRow), answered as an opener's is: their lines in it, kept for them alone, go, and it stays theirs, their
 * next line its line. It is withdrawn (`reach_out_withdrawn_at`), as an opener's cancel stamps theirs, so the opener's line
 * no longer answers it (lineThroughRequest; PR #2540 review 4399348393). The row stays as its opener left it otherwise, and
 * only the actor hears. One they read as accepted (the opener answered it, answerReachOut) is no pending request (409), as
 * for any opener.
 */
function cancelReachOut(row: RequestRow, mine: RequestRow, actor: string, now: number): RequestView {
    if ((mine.state === 'accepted' && !acceptanceHiddenFrom(mine, actor)) || over(mine, now) || openerLinesSince(mine) === 0) {
        throw new RequestDecisionError(409, 'request_not_pending', word('Only a pending message request can be cancelled.'));
    }
    assertPlainTablesWritable();
    withdrawOpenerLines(mine);
    if (mine.state !== 'accepted') {
        db.prepare('UPDATE dm_requests SET reach_out_withdrawn_at = ? WHERE conversation_id = ?').run(iso(now), row.conversation_id);
    }
    const view = viewOf(rowOf(row.conversation_id)!, actor, now);
    ring({ type: 'dm_request_updated', conversationId: row.conversation_id, request: view }, [actor]);
    return view;
}

/**
 * A cancel's withdrawal: the opener's lines since the request was made, the ones openerLinesSince counts, stored and kept
 * for them alone. Never the other person's: one they wrote after accepting it while the opener blocks them is kept for them,
 * and stays theirs (PR #2540 review 4393642111). Each stored line leaves its tombstone, which is how a delta carries a
 * delete to a standby, and a photo's row goes with its line, its object once the rows are gone; so do the edits and
 * reactions kept for the opener alone on them (withheld_overlays; review 4393642119).
 */
function withdrawOpenerLines(row: RequestRow): void {
    const args = { c: row.conversation_id, a: row.from_pubkey, at: row.requested_at };
    const stored = (db.prepare('SELECT id FROM messages WHERE conversation_id = @c AND author_pubkey = @a AND timestamp >= @at').all(args) as { id: string }[])
        .map(r => r.id);
    const kept = db.prepare('SELECT id, storage_key FROM withheld_lines WHERE conversation_id = @c AND author_pubkey = @a AND timestamp >= @at')
        .all(args) as { id: string; storage_key: string | null }[];
    if (stored.length === 0 && kept.length === 0) return;
    const ids = JSON.stringify(stored);
    db.transaction(() => {
        const keys = (db.prepare('SELECT storage_key FROM message_attachments WHERE storage_key IS NOT NULL AND message_id IN (SELECT value FROM json_each(?))')
            .all(ids) as { storage_key: string }[]).map(r => r.storage_key);
        for (const k of kept) if (k.storage_key) keys.push(k.storage_key);
        db.prepare('DELETE FROM message_attachments WHERE message_id IN (SELECT value FROM json_each(?))').run(ids);
        db.prepare('DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))').run(ids);
        for (const id of stored) writeTombstone('messages', id);
        db.prepare('DELETE FROM withheld_lines WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(kept.map(k => k.id)));
        db.prepare('DELETE FROM withheld_overlays WHERE message_id IN (SELECT value FROM json_each(?))').run(JSON.stringify([...stored, ...kept.map(k => k.id)]));
        if (keys.length > 0) afterTransactionCommit(() => deleteStoredObjects(db, keys));
    })();
}

/** Ignore all: every request waiting for `actor` (the ones their list shows), at once. The openers are never told. */
export function ignoreAllRequests(actor: string, now: number = Date.now()): number {
    if (!requestsOn()) return 0;
    const ids = waitingRows(actor, now).map(r => r.conversation_id);
    if (ids.length === 0) return 0;
    assertPlainTablesWritable();
    const ignore = db.prepare("UPDATE dm_requests SET state = 'ignored', decided_at = ? WHERE conversation_id = ? AND state = 'pending'");
    const done = db.transaction(() => ids.reduce((n, id) => n + ignore.run(iso(now), id).changes, 0))();
    ring({ type: 'dm_requests_ignored', conversationIds: ids }, [actor]);
    return done;
}

// ── time ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Requests that waited 30 days are over: 'expired', and out of the person's list (their list leaves them out from the 30th
 * day all the same). The main server's hourly tick (state-engine.ts); a standby gets the change with its copy. Returns how
 * many.
 */
export function expireOldRequests(now: number = Date.now()): number {
    if (standbyWritesNothing()) return 0;
    return db.prepare("UPDATE dm_requests SET state = 'expired', decided_at = ? WHERE state = 'pending' AND requested_at <= ?")
        .run(iso(now), iso(now - REQUEST_MS)).changes;
}

// ── pushes ─────────────────────────────────────────────────────────────────────────────────────────────────────

type PushFn = (targets: string[], actor: string, title: string, body: string, data: Record<string, any>, category: 'chat', kind: 'chat.message') => unknown;

/** Per person: when a request last pushed them, and the requests folded since. In memory: a restart may send one more. */
const requestPushes = new Map<string, { lastAt: number; folded: Set<string> }>();
const FOLDED_MAX = 1_000;

/** For a suite: forget every person's last request push, as a restart does. */
export function resetRequestPushes(): void {
    requestPushes.clear();
}

/** The words of a request's own push: its first line, or its first after the 30 days. */
export function requestPushBody(senderName: string): string {
    return t('{name} wants to message you', { name: senderName });
}

/**
 * Whether a request's line pushes `to` now: the first in an hour does; one after it in the same hour is folded (its push's
 * work is done and dropped by the caller), and told in the one push the hour's end sends (tickRequestPushFolds).
 */
export function requestPushDue(to: string, conversationId: string, now: number = Date.now()): boolean {
    const had = requestPushes.get(to);
    if (!had || now - had.lastAt >= REQUEST_PUSH_EVERY_MS) {
        if (requestPushes.size >= 10_000) {
            for (const [k, v] of requestPushes) if (now - v.lastAt >= REQUEST_PUSH_EVERY_MS && v.folded.size === 0) requestPushes.delete(k);
        }
        requestPushes.set(to, { lastAt: now, folded: new Set() });
        return true;
    }
    if (had.folded.size < FOLDED_MAX) had.folded.add(conversationId);
    return false;
}

/**
 * Every minute on the main server (state-engine.ts): each person whose hour since a request push is over, with a folded
 * request still waiting for them, gets one push naming nobody, "Someone new wants to message you", and their next hour
 * starts. Anyone with nothing waiting is forgotten, so their next request pushes at once.
 */
export function tickRequestPushFolds(dispatch: PushFn, now: number = Date.now()): void {
    for (const [to, s] of requestPushes) {
        if (now - s.lastAt < REQUEST_PUSH_EVERY_MS) continue;
        const stillWaiting = [...s.folded].some(id => waitingRows(to, now, id).length > 0);
        if (!stillWaiting) {
            requestPushes.delete(to);
            continue;
        }
        s.lastAt = now;
        s.folded.clear();
        try {
            dispatch([to], 'SYSTEM', '💬 New Message', t('Someone new wants to message you'), { screen: 'requests' }, 'chat', 'chat.message');
        } catch (e: any) {
            console.warn('[Push] A folded request push failed:', e?.message ?? e);
        }
    }
}

// ── a member leaving ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A removal or self-deletion (state-engine.ts). A request they made that nobody accepted, in a real conversation, is ignored
 * rather than deleted: the conversation stays (and for a removal, their line in it), and with no row it would be an
 * ordinary chat in the other person's list and unread count (PR #2392 review 4354387983). An ignored one is in neither, and
 * is held from the badge, whatever the switch says. So is one that had lapsed: where requests are off, an expired one is an
 * ordinary chat (review 4354806402). So is one whose acceptance by their own act is hidden from the person it was for
 * (acceptanceHiddenFrom; that person's block of them stays, dropBlocksOf): to that person, nobody accepted it. Every other
 * request of theirs goes, with a tombstone: an accepted one (an ordinary chat either way), one in a conversation kept for
 * them alone (dropWithheldOf took it), and every one waiting for them.
 */
export function dropRequestsOf(publicKey: string, now: number = Date.now()): void {
    const ignore = db.prepare(`UPDATE dm_requests SET state = 'ignored', decided_at = ?
                                WHERE conversation_id = ? AND conversation_id IN (SELECT id FROM conversations)`);
    for (const row of db.prepare("SELECT * FROM dm_requests WHERE from_pubkey = ? AND state = 'accepted' AND accepted_by = from_pubkey").all(publicKey) as RequestRow[]) {
        if (acceptanceHiddenFrom(row, row.to_pubkey)) ignore.run(iso(now), row.conversation_id);
    }
    db.prepare(`UPDATE dm_requests SET state = 'ignored', decided_at = ?
                 WHERE from_pubkey = ? AND state IN ('pending', 'expired') AND conversation_id IN (SELECT id FROM conversations)`).run(iso(now), publicKey);
    deletePlainRows('dm_requests', `(from_pubkey = ? AND (state = 'accepted' OR conversation_id NOT IN (SELECT id FROM conversations)))
                                    OR to_pubkey = ?`, publicKey, publicKey);
}
