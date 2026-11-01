/**
 * Message requests clear themselves (R1: scratch/fable-design/DESIGN-reaching-across-fable.md, "Decided for R1"; Damo, 1 Nov
 * 2026: "it won't scale to 1000 or 10,000 users"; Marty: "a bot could do different messages also"). Enough reports from the
 * people a sender's requests reached clear those requests and stop new ones for a time, and no moderator has to act.
 *
 * ## What counts
 *
 * A report counts when the reporter received a request from the person it is about: at the moment it is filed they are who a
 * request in a real conversation waits for, it is not accepted, and it is under 30 days old (`request_conversation_id` on the
 * report says so, read then, because what becomes of the request later must not change what the report was). Anyone else's
 * report of the same person reaches the moderators as any report does, and counts for nothing here. So a person-report made
 * with a block counts as a line's report does (the apps send one when the line is gone), and an open nobody wrote in is no
 * request received. Accepted, it is an ordinary chat, and a report in it is an ordinary report.
 *
 * There is no 7-day or standing rule on reporters here (Marty, 1 Nov), unlike a post's auto-hide. A reporter has to have been
 * written to first, which is what those rules stand in for on a post, where anyone can report anything.
 *
 * One person's accounts count once: reporters are grouped by auto-moderation.ts's independent circles (`independentCircles`).
 * Reports count from the end of the sender's last limit, or 30 days back if that is sooner: a report a moderator dismissed
 * doesn't count, and one handled does. A reporter who is no longer active doesn't.
 *
 * ## The three ways
 *
 * - 1 circle, for a 12-words newcomer on probation (isWordsNewcomer): their account cost nothing to make.
 * - 2 circles reporting the same wording, on longer lines only.
 * - 3 circles reporting anything: a bot can send every person different words.
 *
 * "The same wording" is compared on the words reporters handed over (R0's disclosure), and only on those. The node holds no
 * key for a line and two people's sealed lines share no bytes, so what a sender wrote to anyone who didn't report it is never
 * read, and the words are each reporter's own account of the line (core dm-line-report.ts): the signature shows the sender
 * wrote that person a line, not what it says. Wording is letters, marks and digits only, folded (NFKC, lower case), so spacing,
 * punctuation and emoji don't make two lines different. `sameWordingMinChars` is 40 of those, about 8 words: two people can
 * innocently get "Hi, is this still available?" (25) from a friendly sender, which is no sign of a bot; 40 is past any
 * greeting, and shorter lines still count towards the 3.
 *
 * ## The limit
 *
 * A row in `request_limits`: 7 days, doubling for each earlier limit a moderator didn't undo, up to 90. While it holds a new
 * request is refused in words (dm-requests.ts): the open of a new chat that would be one, and a line that would be one. A line
 * to someone who wrote first, added them, or accepted goes as ever, and so does a post: this is not a pause, and no member
 * status changes. The requests they made up to the limit stay out of every list (dm-requests.ts waitingRows) after it ends,
 * as they were cleared. They keep their own copy, and Cancel request.
 *
 * A moderator sees it and can undo it: their requests that are still under 30 days old come back, and reports from before the
 * undo no longer count. The reports themselves stay in the queue, each for a moderator to decide: an undo is no ruling on any
 * of them. A moderator's pause or mute clears a sender's requests by its own state (waitingRows), and lifting it brings them
 * back.
 *
 * The switch is `autoHideReports`, as for a post: where a community keeps no automatic moderation, reports only reach the
 * moderators. A standby writes none of this.
 */
import crypto from 'node:crypto';
import { db, deletePlainRows } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { standbyWritesNothing } from '../config/node-role.js';
import { independentCircles } from './auto-moderation.js';
import { isWordsNewcomer } from './probation.js';
import { notifyRequestsBack, notifyRequestsCleared, requestsClearedBody, type ModerationNoticeCallbacks } from './moderation-notices.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

export const REQUEST_LIMIT = {
    /** Independent circles of recipients, reporting anything. */
    anyWordingCircles: 3,
    /** ...or reporting the same wording, on a line of at least `sameWordingMinChars`. */
    sameWordingCircles: 2,
    /** ...or reporting anything from a 12-words newcomer on probation. */
    wordsNewcomerCircles: 1,
    /** Letters, marks and digits in a line, once folded (the file header says why). */
    sameWordingMinChars: 40,
    /** A report counts for this long, and a request can be reported for this long: a request's own 30 days. */
    windowDays: 30,
    /** The first limit, in days. It doubles for each earlier one a moderator didn't undo. */
    firstDays: 7,
    /** The longest limit, in days. */
    longestDays: 90,
} as const;

/** Refused a new request: dm-requests.ts, and the apps read it. */
export const DM_REQUESTS_LIMITED_CODE = 'dm_requests_limited';

export type RequestLimitHow = 'words_newcomer' | 'same_wording' | 'many_reports';

export interface RequestLimit {
    id: string;
    until: string;
    how: RequestLimitHow;
    madeAt: string;
}

interface LimitRow { id: string; until: string; how: RequestLimitHow; made_at: string }

/** The limit that holds on `sender` now, or null. One a moderator undid holds no more. */
export function requestLimitOf(sender: string, now: number = Date.now()): RequestLimit | null {
    const row = db.prepare(`SELECT id, until, how, made_at FROM request_limits
                             WHERE sender_pubkey = ? AND lifted_at IS NULL AND until > ? ORDER BY until DESC LIMIT 1`)
        .get(sender, iso(now)) as LimitRow | undefined;
    return row ? { id: row.id, until: row.until, how: row.how, madeAt: row.made_at } : null;
}

/** The refusal of a new request while a limit holds on `sender`, in the words of their notice, or null. */
export function requestLimitWords(sender: string, now: number = Date.now()): string | null {
    const limit = requestLimitOf(sender, now);
    return limit ? requestsClearedBody(limit.until) : null;
}

/**
 * Whether `reporter` received a request from `sender` that is theirs to report now, and in which conversation (the file
 * header's "What counts"). `lineProved`: the report hands over a line the node checked (dm-line-report.ts checkDmLineReport),
 * which stands even if the sender has since cancelled the request. A person-report has no line, so the sender's line must be
 * in the chat, or a tombstone of it: an open nobody wrote in asks nobody anything.
 */
export function requestReceived(reporter: string, sender: string, lineProved: boolean, now: number = Date.now()): string | null {
    const row = db.prepare(`
        SELECT r.conversation_id FROM dm_requests r
          JOIN conversations c ON c.id = r.conversation_id
         WHERE r.from_pubkey = @sender AND r.to_pubkey = @reporter AND r.state = 'pending' AND r.requested_at > @since
           AND (@lineProved = 1 OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = r.conversation_id
                                            AND m.author_pubkey = r.from_pubkey AND m.timestamp >= r.requested_at))
         LIMIT 1
    `).get({ sender, reporter, since: iso(now - REQUEST_LIMIT.windowDays * DAY_MS), lineProved: lineProved ? 1 : 0 }) as { conversation_id: string } | undefined;
    return row?.conversation_id ?? null;
}

/** A line's wording, folded (the file header), or null for one too short to compare. */
export function wordingOf(words: string): string | null {
    const folded = words.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
    return [...folded].length >= REQUEST_LIMIT.sameWordingMinChars ? folded : null;
}

/** When reports begin to count: the end of the sender's last limit, or `windowDays` back if that is sooner. */
function countingFrom(sender: string, now: number): string {
    const last = (db.prepare('SELECT MAX(COALESCE(lifted_at, until)) AS ended FROM request_limits WHERE sender_pubkey = ?').get(sender) as { ended: string | null }).ended;
    const window = iso(now - REQUEST_LIMIT.windowDays * DAY_MS);
    return last && last > window ? last : window;
}

/** The words a report handed over, if it handed over a line. */
function wordsHandedOver(disclosure: string | null): string {
    try {
        const words = disclosure ? JSON.parse(disclosure)?.words : null;
        return typeof words === 'string' ? words : '';
    } catch {
        return '';
    }
}

/** Which way, if any, the reports counting now reach a limit (the file header's three ways). */
export function requestReportsReach(sender: string, now: number = Date.now()): RequestLimitHow | null {
    const reports = db.prepare(`
        SELECT ar.reporter_pubkey AS reporter, ar.disclosure FROM abuse_reports ar
          JOIN members m ON m.public_key = ar.reporter_pubkey AND m.status = 'active'
         WHERE ar.target_pubkey = ? AND ar.request_conversation_id IS NOT NULL AND ar.created_at > ?
           AND ar.reporter_pubkey != ar.target_pubkey AND (ar.status IS NULL OR ar.status != 'reviewed')
    `).all(sender, countingFrom(sender, now)) as { reporter: string; disclosure: string | null }[];
    if (reports.length === 0) return null;
    const circles = independentCircles([...new Set(reports.map(r => r.reporter))]);
    if (isWordsNewcomer(sender, now) && circles.length >= REQUEST_LIMIT.wordsNewcomerCircles) return 'words_newcomer';
    const circleOf = new Map(circles.flatMap((circle, i) => circle.map(reporter => [reporter, i] as const)));
    const byWording = new Map<string, Set<number>>();
    for (const r of reports) {
        const wording = wordingOf(wordsHandedOver(r.disclosure));
        if (wording) byWording.set(wording, (byWording.get(wording) ?? new Set()).add(circleOf.get(r.reporter)!));
    }
    if ([...byWording.values()].some(reached => reached.size >= REQUEST_LIMIT.sameWordingCircles)) return 'same_wording';
    return circles.length >= REQUEST_LIMIT.anyWordingCircles ? 'many_reports' : null;
}

/**
 * After a report that counts: a limit on `sender` when the reports reach one, and they are told. True when this call made one.
 * Does nothing where `autoHideReports` or `dmRequests` is off, on a standby, or while a limit holds.
 */
export function evaluateRequestReports(cb: ModerationNoticeCallbacks, sender: string, now: number = Date.now()): boolean {
    const { autoHideReports, dmRequests } = getProfileSwitches();
    if (!autoHideReports || !dmRequests || standbyWritesNothing() || requestLimitOf(sender, now)) return false;
    const how = requestReportsReach(sender, now);
    if (!how) return false;
    const earlier = (db.prepare('SELECT COUNT(*) AS c FROM request_limits WHERE sender_pubkey = ? AND lifted_at IS NULL').get(sender) as { c: number }).c;
    const days = Math.min(REQUEST_LIMIT.longestDays, REQUEST_LIMIT.firstDays * 2 ** earlier);
    const until = iso(now + days * DAY_MS);
    db.prepare('INSERT INTO request_limits (id, sender_pubkey, made_at, until, how) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), sender, iso(now), until, how);
    console.log(`🛡️ Member ${sender.slice(0, 12)}… sends no new message requests for ${days} days (${how}).`);
    notifyRequestsCleared(cb, sender, until);
    return true;
}

/**
 * A moderator undoes a limit: it holds no more, the requests it cleared come back, and only reports from now count. True when
 * one held.
 */
export function liftRequestLimit(cb: ModerationNoticeCallbacks, sender: string, now: number = Date.now()): boolean {
    const limit = requestLimitOf(sender, now);
    if (!limit) return false;
    db.prepare('UPDATE request_limits SET lifted_at = ? WHERE id = ?').run(iso(now), limit.id);
    notifyRequestsBack(cb, sender);
    return true;
}

export interface ListedRequestLimit extends RequestLimit {
    publicKey: string;
    callsign: string | null;
}

/** Every limit that holds now, soonest over first, for the moderators. */
export function listRequestLimits(now: number = Date.now()): ListedRequestLimit[] {
    return (db.prepare(`SELECT l.id, l.sender_pubkey, l.made_at, l.until, l.how, m.callsign FROM request_limits l
                          LEFT JOIN members m ON m.public_key = l.sender_pubkey
                         WHERE l.lifted_at IS NULL AND l.until > ? ORDER BY l.until`)
        .all(iso(now)) as (LimitRow & { sender_pubkey: string; callsign: string | null })[])
        .map(r => ({ id: r.id, publicKey: r.sender_pubkey, callsign: r.callsign, how: r.how, madeAt: r.made_at, until: r.until }));
}

/** A removal or self-deletion: their limits go, with a tombstone each (state-engine.ts). */
export function dropRequestLimitsOf(publicKey: string): void {
    deletePlainRows('request_limits', 'sender_pubkey = ?', publicKey);
}
