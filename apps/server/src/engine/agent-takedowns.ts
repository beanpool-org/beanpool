/**
 * An owner's AI assistant takes posts down (scratch/fable-design/DESIGN-mcp-moderation-fable.md §3.3): hidden at once, final
 * after 7 days, and in between one tap from coming back. It never moves a Bean.
 *
 * ## What a takedown is
 *
 * `takeDownPosts`, in one transaction, on each post it may take: `hidden_by_reports_at` (kept if the post was already hidden, and noted
 * on this record) and `removed_by_moderator_at`, so the hidden state's whole reach applies (every list, search, map and count; no new deal) and the
 * removal counts as a moderator's for standing, probation and the mute. A live, hidden post with that second stamp is a takedown on
 * hold: nothing else leaves both on a live post, and the stamps travel, so that holds on a standby that took over, where this record
 * does not (engine/auto-moderation.ts onHold reads it, so that a report dismissed later, or a burst's undo, can't bring it back).
 * Every open report on it closes as actioned, and this record keeps which, except a Child safety report: nobody may be spared
 * reading one, so it stays open and first in the moderators' queue, and its reporter hears nothing yet. A deal only asked for is
 * declined, as an author's removal declines it.
 *
 * ## What it refuses, and what it never does
 *
 * Refused, one by one and each with why (`kept`): a post with a pending deal (no assistant ever reaches a path that refunds
 * escrow) or a keeper's wage still owed on it (a removal cancels the claim), a post by a role-holder or by an enterprise a role-holder keeps (so an injected "take down the owner's post" does
 * nothing), a post that is another community's (`origin_node`), one already down, and one past the day's cap. The cap is this
 * table's rows of today (UTC), read in the transaction, so a restart keeps the day and nothing is counted twice.
 *
 * ## After
 *
 * Put back (`putBackTakedowns`, a person's only) leaves a post where it stood before the takedown, because nobody reads a post on
 * that tap: it is the answer to a stolen token. The removal's stamp goes, so a mistaken day costs its author nothing, and a mute a
 * takedown brought goes with it. A post that was up is up. One a moderator's burst or the reports had hidden stays hidden on the
 * same stamp, so its burst undo still works, and its author hears that and not that it is back. The reports the takedown closed go
 * back to the moderators' queue, a report filed in the hold stays there, and reporters hear nothing (design §3.5): dismissing a report
 * stays a person's act on that report. The hold stops what would have weighed a hide: a report dismissed during it rechecks nothing
 * (recheckHiddenPost refuses), and a burst undone during it skips this post (engine/burst-cleanup.ts). So Put back weighs a kept stamp
 * no standing burst holds, once the removals are cleared and the reports are open again: a post the reports still hide keeps its
 * stamp, and one they no longer hide comes up, and its author hears it is back. Where reports hide nothing, a kept stamp stays as it
 * is, but for a burst undone during the hold: that stamp has no undo left, so Put back does what the undo would have done, and the
 * post comes up. engine/auto-moderation.ts restoreHiddenPost is the same undo for one post, except that a moderator there looks at
 * that post and means it: it comes up, and the open reports they saw are dismissed.
 *
 * The sweep (`sweepTakedowns`, on the pulse scheduler's tick) makes a post 7 days old final through `setTakedownRemoval`'s function, which
 * has no way to move a Bean: an event is cancelled then and its goers told, unless it has ended, and the author hears nothing more.
 * A post that somehow holds a pending deal by then is left hidden, and so is one with a Child safety report open: this closes what
 * is open, and that report waits for a person. Each shows so in Settings; it goes final once the deal is over or a person has
 * closed the report, or a person removes it, through that report or by itself. A Child safety report shows from the first day
 * (`childSafetyOpen`, on every held line), because one post's Remove now closes it whichever day that is.
 *
 * The record is this server's (a standby never copies it). Records go after `TAKEDOWN.keepDays`, once nothing waits on them.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { getReplacedInfo } from '../services/identity-epoch.js';
import { logger } from '../logger.js';
import { noteSecurityEvent, OWNER_ALERT_WORDS } from '../services/security-signal.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { evaluateAutoMute, hideTally, liftMuteATakedownBrought } from './auto-moderation.js';
import { holdsRole } from './burst-cleanup.js';
import {
    childSafetyOpenOn, closeReportsForTakedown, notifyPostBack, notifyPostsBack, notifyPostsHiddenForReview, notifyPostsTakenDown, notifyReportersRemoved,
    reopenClosedReports, REMOVAL_REASON_LABELS, type ModerationNoticeCallbacks,
} from './moderation-notices.js';
import { bumpActivityVersion, bumpPostsVersion } from './versions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

export const TAKEDOWN = {
    /** A takedown is final after this many days, unless a person put it back. */
    holdDays: 7,
    /** One call takes at most this many posts (state-engine's bulk removal's batch). */
    maxPerCall: 200,
    /** The assistant's own words, for Settings. */
    whyMax: 500,
    /** A record is kept this long once it has been put back or made final. */
    keepDays: 30,
    /** One sweep makes at most this many final: the next tick goes on. */
    sweepBatch: 200,
} as const;

/** Why a post stays up, in words the assistant reads and passes on. */
export const KEPT_WORDS = {
    notHere: 'There is no post with that id here.',
    alreadyRemoved: 'It is already removed.',
    alreadyDown: 'It is already taken down.',
    deal: 'It has a deal in escrow, or a wage still owed on it, so it stays up: that is finished or cancelled first, or a person removes it in Settings.',
    roleHolder: "It is by an owner, an admin or a moderator, or an enterprise one keeps: a person does that in Settings.",
    otherCommunity: "It is another community's listing, copied here: that community's own server takes it down.",
    overLimit: "Over today's limit: the rest wait for tomorrow (UTC), or an owner raises the Owner and admin limit.",
} as const;

export interface TakedownGrant { id: string; name: string; member: string }

export interface TakeDownInput {
    grant: TakedownGrant;
    /** A key of REMOVAL_REASON_LABELS, checked by the tool: what the author reads. */
    reason: string;
    /** The assistant's own words, cleaned: Settings only. */
    why: string;
    via: 'ids' | 'reports';
    postIds: string[];
    /** The owners' "Owner and admin limit" now. */
    perDay: number;
}

export interface TakeDownResult {
    takedownId: string | null;
    removed: string[];
    kept: { postId: string; why: string }[];
    todayCount: number;
    perDay: number;
    finalAfter: string;
}

interface PostRow {
    id: string; title: string | null; author_pubkey: string | null; active: number; status: string; origin_node: string | null;
    hidden_by_reports_at: string | null; removed_by_moderator_at: string | null;
}

const POST_COLS = 'id, title, author_pubkey, active, status, origin_node, hidden_by_reports_at, removed_by_moderator_at';
const isLive = (p: { active: number; status: string }) => p.active === 1 && p.status !== 'cancelled';

/**
 * Money held on a post, by a row whose post is `postId`'s: a deal in escrow, or a keeper's wage owed (deferred_wage_claims), which a
 * removal would cancel. Written once, because the tool, the sweep and Settings must all read the same thing.
 */
const moneyHeldOn = (post: string) => `(EXISTS (SELECT 1 FROM marketplace_transactions d WHERE d.post_id = ${post} AND d.status = 'pending')
    OR EXISTS (SELECT 1 FROM deferred_wage_claims w WHERE w.post_id = ${post} AND w.status = 'pending'))`;

export const hasPendingDeal = (postId: string): boolean =>
    !!(db.prepare(`SELECT ${moneyHeldOn('?')} AS held`).get(postId, postId) as { held: number }).held;

/** A Child safety report still open on this post: it waits for a person, so nothing automatic makes the post final. */
export const hasOpenChildSafetyReport = (postId: string): boolean =>
    !!(db.prepare(`SELECT ${childSafetyOpenOn('?')} AS open`).get(postId) as { open: number }).open;

/** A role-holder's, or an enterprise's with a role-holder among its keepers: the burst guard's rule, and its keepers'. */
function roleHolderPost(author: string | null): boolean {
    if (!author) return false;
    if (holdsRole(author)) return true;
    const keepers = db.prepare('SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ?').all(author) as { member_pubkey: string }[];
    return keepers.some(k => holdsRole(k.member_pubkey));
}

const utcDayStart = (now: number) => `${iso(now).slice(0, 10)}T00:00:00.000Z`;

/** Posts this grant took down today (UTC), put back or not: the day's count. */
export function takedownsTodayBy(grantId: string, now: number = Date.now()): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM agent_takedown_posts tp JOIN agent_takedowns t ON t.id = tp.takedown_id
                         WHERE t.grant_id = ? AND t.at >= ?`).get(grantId, utcDayStart(now)) as { c: number }).c;
}

/** Posts every assistant took down today (UTC): the owners' daily line. */
export function takedownsToday(now: number = Date.now()): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM agent_takedown_posts tp JOIN agent_takedowns t ON t.id = tp.takedown_id WHERE t.at >= ?')
        .get(utcDayStart(now)) as { c: number }).c;
}

function announce(cb: ModerationNoticeCallbacks, type: 'post_removed' | 'post_updated'): void {
    bumpPostsVersion();
    bumpActivityVersion();
    // A bare doorbell (engine/burst-cleanup.ts announce): the author and the moderators keep their copies, everyone else drops it.
    try { cb.broadcast({ type }); } catch (e: any) { console.warn('[Takedown] Doorbell failed:', e?.message || e); }
}

/** Take these posts down for one call (the file header). Notices and the alert go out after the commit. */
export function takeDownPosts(cb: ModerationNoticeCallbacks, input: TakeDownInput, now: number = Date.now()): TakeDownResult {
    const { grant, reason, why, via, perDay } = input;
    const at = iso(now);
    const id = crypto.randomUUID();
    const removed: PostRow[] = [];
    const kept: { postId: string; why: string }[] = [];
    const reporters = new Map<string, string[]>();
    let before = 0;
    db.transaction(() => {
        before = takedownsTodayBy(grant.id, now);
        const read = db.prepare(`SELECT ${POST_COLS} FROM posts WHERE id = ?`);
        const hide = db.prepare(`UPDATE posts SET hidden_by_reports_at = COALESCE(hidden_by_reports_at, ?), removed_by_moderator_at = ?, updated_at = ? WHERE id = ?`);
        // As an author's own removal declines one (engine/posts.ts cancelPostFollowOns): no Bean is held on a request.
        const decline = db.prepare(`UPDATE marketplace_transactions SET status = 'rejected', completed_at = ? WHERE post_id = ? AND status = 'requested'`);
        const record = db.prepare('INSERT INTO agent_takedown_posts (takedown_id, post_id, hidden_before, reports_closed) VALUES (?, ?, ?, ?)');
        for (const postId of new Set(input.postIds)) {
            const p = read.get(postId) as PostRow | undefined;
            const refusal = !p ? KEPT_WORDS.notHere
                : !isLive(p) ? KEPT_WORDS.alreadyRemoved
                    : p.removed_by_moderator_at ? KEPT_WORDS.alreadyDown
                        : p.origin_node ? KEPT_WORDS.otherCommunity
                            : hasPendingDeal(postId) ? KEPT_WORDS.deal
                                : roleHolderPost(p.author_pubkey) ? KEPT_WORDS.roleHolder
                                    : before + removed.length >= perDay ? KEPT_WORDS.overLimit : null;
            if (refusal || !p) { kept.push({ postId, why: refusal ?? KEPT_WORDS.notHere }); continue; }
            hide.run(at, at, at, postId);
            decline.run(at, postId);
            const closed = closeReportsForTakedown(postId);
            reporters.set(postId, closed.reporters);
            record.run(id, postId, p.hidden_by_reports_at, JSON.stringify(closed.ids));
            removed.push(p);
        }
        if (removed.length === 0) return;
        db.prepare('INSERT INTO agent_takedowns (id, grant_id, grant_name, member_pubkey, at, reason, why, via, posts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, grant.id, grant.name, grant.member, at, reason, why, via, removed.length);
    })();
    const out = { removed: removed.map(p => p.id), kept, todayCount: before + removed.length, perDay, finalAfter: iso(now + TAKEDOWN.holdDays * DAY_MS) };
    if (removed.length === 0) return { takedownId: null, ...out };
    announce(cb, 'post_removed');
    const byAuthor = new Map<string, { id: string; title: string | null }[]>();
    for (const p of removed) {
        if (p.author_pubkey) byAuthor.set(p.author_pubkey, [...(byAuthor.get(p.author_pubkey) ?? []), { id: p.id, title: p.title }]);
    }
    for (const [author, posts] of byAuthor) {
        notifyPostsTakenDown(cb, author, posts, reason);
        // One weighing per author: on the global profile, the third removal in 30 days mutes them.
        evaluateAutoMute(cb, author, now);
    }
    notifyReportersRemoved(cb, reporters, new Map(removed.map(p => [p.id, p.author_pubkey])));
    logger.info('ADMIN', 'An AI assistant took posts down', {
        grant: grant.id, grantName: grant.name, member: grant.member.slice(0, 16), takedown: id, posts: removed.length, reason, via,
    });
    // Told at the first of the day for this assistant, so a stolen token's first takedown is never lost behind another's; the
    // count keeps its one line after that.
    noteSecurityEvent({
        key: 'sec.agent', detail: '', perDay: OWNER_ALERT_WORDS.assistantTakedowns, perDayAdds: removed.length,
        actor: grant.member, actorRole: 'owner', ...(before === 0 ? { high: true } : { quiet: true }),
    });
    return { takedownId: id, ...out };
}

export type PutBackScope = { postId: string } | { takedownId: string } | { grantId: string; since: string };

export interface PutBackResult {
    /** Every post back where it stood before the takedown. */
    back: string[];
    /** Of those, the ones hidden before it: they stay hidden, for the moderators. */
    stillHidden: string[];
    gone: number;
}

/**
 * A burst's undo run since this takedown skipped the post, so nothing is left to weigh that stamp but Put back. One run before the
 * takedown is no such thing: it left the stamp on a post only because reports would hide it.
 */
const burstUndoneSince = (postId: string, stamp: string, takenAt: string): boolean =>
    !!db.prepare(`SELECT 1 FROM burst_action_posts bp JOIN burst_actions a ON a.id = bp.action_id
                   WHERE bp.post_id = ? AND a.at = ? AND a.undone_at >= ?`).get(postId, stamp, takenAt);

/**
 * Only the reports can be holding this stamp: no burst stands behind it, and the post has a report. With none, a burst hid it and
 * its record has gone: past BURST.keepActionsDays, or on a standby that took over, where the stamp travels and the record doesn't.
 * Reports never hid that post, so weighing them would bring it up with nobody having looked at it.
 */
const onlyReportsHold = (postId: string, stamp: string): boolean =>
    !db.prepare(`SELECT 1 FROM burst_action_posts bp JOIN burst_actions a ON a.id = bp.action_id
                  WHERE bp.post_id = ? AND a.at = ? AND a.undone_at IS NULL`).get(postId, stamp)
    && !!db.prepare('SELECT 1 FROM abuse_reports WHERE target_post_id = ? AND target_pulse_item_id IS NULL LIMIT 1').get(postId);

/** Put back, a person's (the file header): `postId`, one call, or everything one assistant took down since a time (a stolen token's day, in one call). */
export function putBackTakedowns(cb: ModerationNoticeCallbacks, scope: PutBackScope, now: number = Date.now()): PutBackResult {
    const at = iso(now);
    const where = 'postId' in scope ? 'tp.post_id = ?' : 'takedownId' in scope ? 'tp.takedown_id = ?' : 't.grant_id = ? AND t.at >= ?';
    const args = 'postId' in scope ? [scope.postId] : 'takedownId' in scope ? [scope.takedownId] : [scope.grantId, scope.since];
    const back: { id: string; title: string | null; author: string | null; up: boolean }[] = [];
    let gone = 0;
    const reportsHide = getProfileSwitches().autoHideReports;
    db.transaction(() => {
        const held = db.prepare(`SELECT tp.takedown_id, tp.post_id, tp.hidden_before, tp.reports_closed, t.at, p.title, p.author_pubkey, p.active, p.status
                                   FROM agent_takedown_posts tp JOIN agent_takedowns t ON t.id = tp.takedown_id
                                   LEFT JOIN posts p ON p.id = tp.post_id
                                  WHERE tp.put_back_at IS NULL AND tp.final_at IS NULL AND ${where}`).all(...args) as
            { takedown_id: string; post_id: string; hidden_before: string | null; reports_closed: string; at: string; title: string | null; author_pubkey: string | null; active: number | null; status: string | null }[];
        const toWeigh: { line: (typeof back)[number]; stamp: string }[] = [];
        for (const h of held) {
            if (h.active !== 1 || h.status === 'cancelled') {
                db.prepare('UPDATE agent_takedown_posts SET final_at = ? WHERE takedown_id = ? AND post_id = ?').run(at, h.takedown_id, h.post_id);
                gone++;
                continue;
            }
            const weigh = !!h.hidden_before && (burstUndoneSince(h.post_id, h.hidden_before, h.at) || (reportsHide && onlyReportsHold(h.post_id, h.hidden_before)));
            const stamp = weigh ? null : h.hidden_before;
            db.prepare('UPDATE posts SET hidden_by_reports_at = ?, removed_by_moderator_at = NULL, updated_at = ? WHERE id = ?').run(stamp, at, h.post_id);
            db.prepare('UPDATE agent_takedown_posts SET put_back_at = ? WHERE takedown_id = ? AND post_id = ?').run(at, h.takedown_id, h.post_id);
            reopenClosedReports(JSON.parse(h.reports_closed) as string[]);
            const line = { id: h.post_id, title: h.title, author: h.author_pubkey, up: !stamp };
            back.push(line);
            if (weigh) toWeigh.push({ line, stamp: h.hidden_before as string });
        }
        // As a burst's undo weighs: with every post here un-hidden, cleared and its reports open, all weighed against that same
        // state, so the order of the posts decides nothing.
        const reportsWouldHide = (postId: string) => { const t = hideTally(postId, now); return t.circles.length >= t.circlesNeeded; };
        const hiding = reportsHide ? toWeigh.filter(u => reportsWouldHide(u.line.id)) : [];
        const rehide = db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?');
        for (const u of hiding) {
            rehide.run(u.stamp, u.line.id);
            u.line.up = false;
        }
    })();
    if (back.length === 0) return { back: [], stillHidden: [], gone };
    announce(cb, 'post_updated');
    const byAuthor = new Map<string, typeof back>();
    for (const b of back) if (b.author) byAuthor.set(b.author, [...(byAuthor.get(b.author) ?? []), b]);
    for (const [author, posts] of byAuthor) {
        const up = posts.filter(p => p.up);
        if (up.length === 1) notifyPostBack(cb, { id: up[0].id, title: up[0].title, authorPubkey: author });
        else notifyPostsBack(cb, author, up.length);
        // Not "back", and no longer "removed in 7 days": what they were told at the takedown has to end somewhere.
        notifyPostsHiddenForReview(cb, author, posts.length - up.length);
        liftMuteATakedownBrought(cb, author, now);
    }
    return { back: back.map(b => b.id), stillHidden: back.filter(b => !b.up).map(b => b.id), gone };
}

/** What makes a takedown final: no way to move a Bean (state-engine.ts). False: it refused, and the post stays hidden. */
type TakedownRemoval = (postId: string) => boolean;
let removeForGood: TakedownRemoval | null = null;
export function setTakedownRemoval(fn: TakedownRemoval | null): void {
    removeForGood = fn;
}

/** A post that came to its end, or left the record, whatever ended it: nothing waits on it now. */
export function markTakedownFinal(postId: string, now: number = Date.now()): void {
    db.prepare('UPDATE agent_takedown_posts SET final_at = ? WHERE post_id = ? AND put_back_at IS NULL AND final_at IS NULL').run(iso(now), postId);
}

/** Make these held posts final now: the sweep's work, and Settings' Remove now for a call. A post with a pending deal, or a Child safety report open, stays. */
function makeFinal(rows: { post_id: string }[], now: number): { removed: string[]; left: string[] } {
    const removed: string[] = [];
    const left: string[] = [];
    for (const { post_id: postId } of rows) {
        const p = db.prepare(`SELECT ${POST_COLS} FROM posts WHERE id = ?`).get(postId) as PostRow | undefined;
        // Removed meanwhile, by its author or a person, or an ended event its scrub took: nothing to do.
        if (!p || !isLive(p)) { markTakedownFinal(postId, now); continue; }
        // Back up by a way that left this record behind: it is up, so it stays up.
        if (!p.hidden_by_reports_at) {
            db.prepare('UPDATE agent_takedown_posts SET put_back_at = ? WHERE post_id = ? AND put_back_at IS NULL AND final_at IS NULL').run(iso(now), postId);
            continue;
        }
        if (hasPendingDeal(postId)) { left.push(postId); continue; }
        try {
            if (removeForGood?.(postId)) { markTakedownFinal(postId, now); removed.push(postId); } else left.push(postId);
        } catch (e) {
            console.warn(`[Takedown] Post ${postId} could not be made final this time:`, e);
            left.push(postId);
        }
    }
    return { removed, left };
}

/** The sweep (the file header). Safe on every tick: a standby, or a server replaced, makes nothing final. Returns how many. */
export function sweepTakedowns(now: number = Date.now()): number {
    if (!removeForGood || getNodeRole() === 'backup' || getReplacedInfo()) return 0;
    const due = db.prepare(`SELECT tp.post_id FROM agent_takedown_posts tp JOIN agent_takedowns t ON t.id = tp.takedown_id
                             WHERE tp.put_back_at IS NULL AND tp.final_at IS NULL AND t.at <= ?
                               AND NOT ${moneyHeldOn('tp.post_id')} AND NOT ${childSafetyOpenOn('tp.post_id')}
                             ORDER BY t.at LIMIT ?`).all(iso(now - TAKEDOWN.holdDays * DAY_MS), TAKEDOWN.sweepBatch) as { post_id: string }[];
    const { removed } = makeFinal(due, now);
    const cutoff = iso(now - TAKEDOWN.keepDays * DAY_MS);
    db.transaction(() => {
        db.prepare(`DELETE FROM agent_takedown_posts WHERE (put_back_at IS NOT NULL OR final_at IS NOT NULL)
                     AND takedown_id IN (SELECT id FROM agent_takedowns WHERE at < ?)`).run(cutoff);
        db.prepare('DELETE FROM agent_takedowns WHERE at < ? AND id NOT IN (SELECT takedown_id FROM agent_takedown_posts)').run(cutoff);
    })();
    return removed.length;
}

/** Settings' Remove now for a whole call: a person's, and still never past a deal or an open Child safety report, which they remove one at a time. */
export function removeTakedownNow(takedownId: string, now: number = Date.now()): { removed: string[]; left: string[] } {
    const rows = db.prepare('SELECT post_id FROM agent_takedown_posts WHERE takedown_id = ? AND put_back_at IS NULL AND final_at IS NULL').all(takedownId) as { post_id: string }[];
    return makeFinal(rows, now);
}

export interface TakedownPostLine {
    id: string;
    title: string | null;
    author: string | null;
    type: string | null;
    /** hidden: waiting; left_hidden: past the 7 days and waiting for a person (`leftFor`); put_back; final; gone: removed another way. */
    state: 'hidden' | 'left_hidden' | 'put_back' | 'final';
    /** Why it is left hidden. A deal first, because its removal moves Beans; the Child safety report stays first in the queue either way. */
    leftFor: 'deal' | 'child_safety' | null;
    /** A Child safety report is open on a post still held, on any day of the hold: removing this one post closes it. A flag only. */
    childSafetyOpen: boolean;
    putBackAt: string | null;
    finalAt: string | null;
}

export interface TakedownLine {
    id: string;
    grantId: string;
    grantName: string;
    member: string | null;
    at: string;
    reason: string;
    reasonLabel: string;
    why: string;
    via: 'ids' | 'reports';
    finalAfter: string;
    posts: TakedownPostLine[];
}

/**
 * Settings' list, newest first: names and titles as they are now, for a screen that shows them as plain text. Every call with a post
 * still waiting, because this is where it can be undone and the sweep won't wait (their number is bounded by the day's cap and the
 * 7 days), and otherwise the newest `limit`.
 */
export function listTakedowns(now: number = Date.now(), limit = 100): TakedownLine[] {
    const calls = db.prepare(`SELECT t.*, m.callsign FROM agent_takedowns t LEFT JOIN members m ON m.public_key = t.member_pubkey
                               WHERE t.id IN (SELECT id FROM agent_takedowns ORDER BY at DESC, rowid DESC LIMIT ?)
                                  OR t.id IN (SELECT takedown_id FROM agent_takedown_posts WHERE put_back_at IS NULL AND final_at IS NULL)
                               ORDER BY t.at DESC, t.rowid DESC`).all(limit) as
        { id: string; grant_id: string; grant_name: string; callsign: string | null; at: string; reason: string; why: string; via: 'ids' | 'reports' }[];
    const posts = db.prepare(`SELECT tp.post_id, tp.put_back_at, tp.final_at, p.title, p.type, m.callsign,
                                     ${moneyHeldOn('tp.post_id')} AS deal, ${childSafetyOpenOn('tp.post_id')} AS child_safety
                                FROM agent_takedown_posts tp LEFT JOIN posts p ON p.id = tp.post_id LEFT JOIN members m ON m.public_key = p.author_pubkey
                               WHERE tp.takedown_id = ?`);
    return calls.map((c) => {
        const finalAfter = iso(Date.parse(c.at) + TAKEDOWN.holdDays * DAY_MS);
        return {
            id: c.id, grantId: c.grant_id, grantName: c.grant_name, member: c.callsign, at: c.at, reason: c.reason,
            reasonLabel: REMOVAL_REASON_LABELS[c.reason] ?? c.reason, why: c.why, via: c.via, finalAfter,
            posts: (posts.all(c.id) as { post_id: string; put_back_at: string | null; final_at: string | null; title: string | null; type: string | null; callsign: string | null; deal: number; child_safety: number }[]).map((p) => {
                const held = !p.put_back_at && !p.final_at;
                const waiting = held && Date.parse(finalAfter) <= now;
                const leftFor = !waiting ? null : p.deal ? 'deal' as const : p.child_safety ? 'child_safety' as const : null;
                return {
                    id: p.post_id, title: p.title, author: p.callsign, type: p.type,
                    state: p.put_back_at ? 'put_back' as const : p.final_at ? 'final' as const : leftFor ? 'left_hidden' as const : 'hidden' as const,
                    leftFor, childSafetyOpen: held && !!p.child_safety, putBackAt: p.put_back_at, finalAt: p.final_at,
                };
            }),
        };
    });
}

/** A member deleting their own account leaves this record, as they leave a burst's: their posts, and their key as who it acted for. */
export function forgetTakedownsOf(publicKey: string): void {
    db.prepare('DELETE FROM agent_takedown_posts WHERE post_id IN (SELECT id FROM posts WHERE author_pubkey = ?)').run(publicKey);
    db.prepare("UPDATE agent_takedowns SET member_pubkey = '' WHERE member_pubkey = ?").run(publicKey);
}
