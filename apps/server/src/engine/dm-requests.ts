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
 *   the badge their pushes carry. They accept or ignore it (routes/messaging.ts), or Ignore all. Their own line in it, their
 *   own open of the chat (Message on the opener's profile), adding the opener as a friend, or a trade between the two
 *   opening, each accepts it too. Accepting makes nobody a friend.
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
 * A block lifted is the one exception, as lifting it is meant to be: the line kept for the opener during it never reaches
 * the other person, so it no longer counts as the request's one line, and the opener's next line is (openerLinesSince).
 *
 * ## The switch turned off
 *
 * Where requests were on and are turned off, nothing waits: every line goes through, and a request still waiting, or one
 * that lapsed, is an ordinary chat. One the person ignored, or a removal ignored (dropRequestsOf), stays out of their
 * lists, their unread count and their badge: that was their decision, or the removal's (PR #2392 review 4354581049). Their
 * own act brings it back as an ordinary chat, as it accepts one when on ({@link acceptable}), and so does the opener's next
 * line, which makes it a new request from then, an ordinary chat while off (lineWhileOff), as one after its 30 days is:
 * nothing is stored or pushed into a chat the person can't find.
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
 * waits in a real conversation, which is ignored so it never becomes an ordinary chat (dropRequestsOf); a re-key moves them
 * (engine/key-move.ts).
 */
import { wordsFor } from '@beanpool/core';
import { db, deletePlainRows, afterTransactionCommit } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { assertPlainTablesWritable, standbyWritesNothing } from '../config/node-role.js';
import { nodeRoleOf } from './node-roles.js';
import { hasBlocked } from './member-blocks.js';

// The words layer in English: a node never writes in the device language (core words.test N11).
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
}

/** A request as one of its two people reads it: its state for them, who opened it, and when it was made. */
export interface RequestView {
    state: RequestState;
    from: string;
    at: string;
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
 * it"); the person it is for reads what they did with it, and 'expired' for one that waited 30 days.
 */
function viewOf(row: RequestRow, viewer: string, now: number): RequestView {
    let state: RequestState;
    if (row.state === 'accepted') state = 'accepted';
    else if (viewer === row.from_pubkey) state = over(row, now) ? 'expired' : 'pending';
    else state = row.state === 'pending' && over(row, now) ? 'expired' : row.state;
    return { state, from: row.from_pubkey, at: row.requested_at };
}

/**
 * Whether a direct conversation `from` opens with `to` is a request (the header's "Who goes straight through"). Read as
 * the rule is at the open, and again at each of the opener's lines while it waits, so a role granted or a trade begun since
 * lets them through.
 */
export function requestNeeded(from: string, to: string): boolean {
    if (nodeRoleOf(from)) return false;
    return !db.prepare(`
        SELECT 1 WHERE
            EXISTS (SELECT 1 FROM friends WHERE owner_pubkey = @to AND friend_pubkey = @from)
         OR EXISTS (SELECT 1 FROM marketplace_transactions
                     WHERE status IN ('pending', 'completed')
                       AND ((buyer_pubkey = @from AND seller_pubkey = @to) OR (buyer_pubkey = @to AND seller_pubkey = @from)))
         OR EXISTS (SELECT 1 FROM conversation_participants theirs
                      JOIN conversations c ON c.id = theirs.conversation_id AND c.type = 'dm'
                      JOIN conversation_participants mine ON mine.conversation_id = c.id AND mine.public_key = @from
                     WHERE theirs.public_key = @to
                       AND (c.created_by = @to OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.author_pubkey = @to)))
         OR EXISTS (SELECT 1 FROM withheld_conversations w WHERE w.owner_pubkey = @to AND w.other_pubkey = @from)
    `).get({ from, to });
}

/**
 * Whether an act of the person a request is for accepts it (their line, their own open of the chat, adding the opener, a
 * trade between the two): any request not accepted yet, where requests are on. Where they were turned off since, only one
 * they ignored, the one kind still kept out of their lists then (sortRequestsOut), so their act brings it back.
 */
function acceptable(row: RequestRow | undefined): row is RequestRow {
    return !!row && row.state !== 'accepted' && (requestsOn() || row.state === 'ignored');
}

/** Accept it: its state, and both people's sockets (the opener's app can write again). After the write commits. */
function accept(row: RequestRow, now: number): void {
    assertPlainTablesWritable();
    const changed = db.prepare("UPDATE dm_requests SET state = 'accepted', decided_at = ? WHERE conversation_id = ? AND state != 'accepted'")
        .run(iso(now), row.conversation_id).changes;
    if (changed === 0) return;
    const request: RequestView = { state: 'accepted', from: row.from_pubkey, at: row.requested_at };
    afterTransactionCommit(() => ring({ type: 'dm_request_updated', conversationId: row.conversation_id, request }, [row.from_pubkey, row.to_pubkey]));
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
 */
export function acceptOnOpen(conversationId: string, who: string, now: number = Date.now()): void {
    const row = rowOf(conversationId);
    if (acceptable(row) && row.to_pubkey === who) accept(row, now);
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
    | { kind: 'request'; to: string }
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
    return (db.prepare('SELECT COUNT(*) AS n FROM withheld_lines WHERE conversation_id = @c AND author_pubkey = @a AND timestamp >= @at')
        .get(args) as { n: number }).n;
}

/** The refusal of the opener's line or reaction while their request waits for `to`. */
function waitingFor(to: string, what: 'write' | 'react'): string {
    const name = (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(to) as { callsign?: string | null } | undefined)?.callsign;
    if (what === 'write') {
        return name
            ? t('Your first message is waiting for {name}. You can write more once they accept it.', { name })
            : t('Your first message is waiting. You can write more once it is accepted.');
    }
    return name
        ? t('Your first message is waiting for {name}. You can react once they accept it.', { name })
        : t('Your first message is waiting. You can react once it is accepted.');
}

/**
 * A member's line in a direct conversation (engine/messaging.ts sendMessage), after every refusal of who may write there and
 * of the line itself, and before it is stored or kept for its sender alone, so the answer is the same either way:
 * - the person a request waits for writing in it accepts it;
 * - the opener, when the rule no longer holds them (a friend add, a role, a trade since), is let through and it is accepted;
 * - the opener's first line is the request's line, and so is their first after the 30 days, which makes it a new request;
 * - any other line of the opener's is refused.
 */
export function lineThroughRequest(conversationId: string, author: string, now: number = Date.now()): LineThroughRequest {
    const row = rowOf(conversationId);
    if (!row || row.state === 'accepted') return DIRECT;
    if (!requestsOn()) {
        lineWhileOff(row, author, now);
        return DIRECT;
    }
    if (author === row.to_pubkey) {
        accept(row, now);
        return DIRECT;
    }
    if (author !== row.from_pubkey) return DIRECT;
    if (!requestNeeded(row.from_pubkey, row.to_pubkey)) {
        accept(row, now);
        return DIRECT;
    }
    if (over(row, now)) {
        assertPlainTablesWritable();
        db.prepare("UPDATE dm_requests SET state = 'pending', requested_at = ?, decided_at = NULL WHERE conversation_id = ?")
            .run(iso(now), row.conversation_id);
        return { kind: 'request', to: row.to_pubkey };
    }
    if (openerLinesSince(row) > 0) return { kind: 'refused', message: waitingFor(row.to_pubkey, 'write') };
    // The request's line: the request is made by it, so its 30 days run from it, not from the open (PR #2392 review
    // 4354580417). Stored after this, so it is a line since the request was made (OPENER_WROTE). A standby stamps nothing.
    if (!standbyWritesNothing()) {
        db.prepare('UPDATE dm_requests SET requested_at = ? WHERE conversation_id = ?').run(iso(now), row.conversation_id);
    }
    return { kind: 'request', to: row.to_pubkey };
}

/**
 * A line where requests were turned off since: it goes through, but a request the person ignored is still kept out of
 * their lists, and the line would be stored where they never look. Their own line accepts it, as when on; the opener's
 * makes it a new request from then, which is an ordinary chat while off (the header's "The switch turned off"). A
 * standby, which writes no request, leaves it.
 */
function lineWhileOff(row: RequestRow, author: string, now: number): void {
    if (row.state !== 'ignored' || standbyWritesNothing()) return;
    if (author === row.to_pubkey) accept(row, now);
    else if (author === row.from_pubkey) {
        db.prepare("UPDATE dm_requests SET state = 'pending', requested_at = ?, decided_at = NULL WHERE conversation_id = ?")
            .run(iso(now), row.conversation_id);
    }
}

/** The refusal of a reaction by the opener of a request still waiting, or null (engine/messaging.ts toggleMessageReaction). */
export function reactionRefusal(conversationId: string, author: string, now: number = Date.now()): string | null {
    if (!requestsOn()) return null;
    const row = rowOf(conversationId);
    if (!row || row.state === 'accepted' || author !== row.from_pubkey) return null;
    if (!requestNeeded(row.from_pubkey, row.to_pubkey)) {
        accept(row, now);
        return null;
    }
    return waitingFor(row.to_pubkey, 'react');
}

// ── acts elsewhere that accept ─────────────────────────────────────────────────────────────────────────────────

/**
 * `owner` added `friend` (engine/social.ts addFriend): a request from them waiting for `owner` is accepted, as the design's
 * "I chose you". A standby, which adds a friend as the main server does, writes no request of its own: it gets the
 * acceptance with the main server's copy.
 */
export function acceptOnFriendAdd(owner: string, friend: string, now: number = Date.now()): void {
    if (standbyWritesNothing()) return;
    const rows = db.prepare("SELECT * FROM dm_requests WHERE from_pubkey = ? AND to_pubkey = ? AND state != 'accepted'").all(friend, owner) as RequestRow[];
    for (const row of rows) if (acceptable(row)) accept(row, now);
}

/** A trade between the two opening its chat (engine/messaging.ts ensureTransactionConversation) accepts a request in it. */
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
        if (row.to_pubkey !== viewer || request.state === 'accepted') { listed.push(entry); continue; }
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

/** The requests for `viewer` they ignored (or a removal of their opener ignored). */
function ignoredBy(viewer: string): Set<string> {
    return new Set((db.prepare("SELECT conversation_id FROM dm_requests WHERE to_pubkey = ? AND state = 'ignored'").all(viewer) as { conversation_id: string }[])
        .map(r => r.conversation_id));
}

/**
 * The conversations `viewer`'s badge and unread count leave out (state-engine.ts getListedUnreadCounts): every request for
 * them they haven't accepted. Where requests are off, the ones they ignored, which their list leaves out too.
 */
export function heldFromUnread(viewer: string): Set<string> {
    if (!requestsOn()) return ignoredBy(viewer);
    return new Set((db.prepare("SELECT conversation_id FROM dm_requests WHERE to_pubkey = ? AND state != 'accepted'").all(viewer) as { conversation_id: string }[])
        .map(r => r.conversation_id));
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
 */
export function decideRequest(conversationId: string, actor: string, decision: 'accept' | 'ignore', now: number = Date.now()): RequestView {
    const row = typeof conversationId === 'string' && requestsOn() ? rowOf(conversationId) : undefined;
    if (row && row.from_pubkey === actor) {
        throw new RequestDecisionError(403, 'not_request_recipient', t('Only the person a message request was sent to can accept or ignore it.'));
    }
    const real = !!row && !!db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(row.conversation_id, actor);
    // An open with nothing written in it yet asks nothing (OPENER_WROTE): ignoring it would swallow the line after it.
    const asked = !!row && (row.state === 'accepted'
        || !!db.prepare(`SELECT 1 FROM dm_requests r WHERE r.conversation_id = ? AND ${OPENER_WROTE}`).get(row.conversation_id));
    if (!row || row.to_pubkey !== actor || !real || !asked) {
        throw new RequestDecisionError(404, 'request_not_found', t('There is no message request for you in this chat.'));
    }
    if (decision === 'accept') {
        accept(row, now);
    } else if (row.state === 'accepted') {
        throw new RequestDecisionError(409, 'request_accepted', t('You have accepted this chat already, so it is no longer a request.'));
    } else if (row.state !== 'ignored') {
        assertPlainTablesWritable();
        db.prepare("UPDATE dm_requests SET state = 'ignored', decided_at = ? WHERE conversation_id = ?").run(iso(now), row.conversation_id);
        ring({ type: 'dm_request_updated', conversationId: row.conversation_id, request: viewOf({ ...row, state: 'ignored' }, actor, now) }, [actor]);
    }
    return viewOf(rowOf(row.conversation_id)!, actor, now);
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
            dispatch([to], 'SYSTEM', '💬 New Message', t('Someone new wants to message you'), {}, 'chat', 'chat.message');
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
 * is held from the badge. Every other request of theirs goes, with a tombstone: an accepted one (an ordinary chat either
 * way), one in a conversation kept for them alone (dropWithheldOf took it), and every one waiting for them.
 */
export function dropRequestsOf(publicKey: string, now: number = Date.now()): void {
    db.prepare(`UPDATE dm_requests SET state = 'ignored', decided_at = ?
                 WHERE from_pubkey = ? AND state = 'pending' AND conversation_id IN (SELECT id FROM conversations)`).run(iso(now), publicKey);
    deletePlainRows('dm_requests', `(from_pubkey = ? AND (state = 'accepted' OR conversation_id NOT IN (SELECT id FROM conversations)))
                                    OR to_pubkey = ?`, publicKey, publicKey);
}
