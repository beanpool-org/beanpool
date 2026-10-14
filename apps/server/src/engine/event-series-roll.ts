/**
 * Repeating events on the node (design: scratch/global-node/DESIGN-event-times-fable.md §8, slice 4). The dates themselves
 * are @beanpool/engine event-series.ts's, pure; this is where a series meets its row, its RSVPs and its reminders.
 *
 * One series is ONE post row. Its times are the NEXT date, and the main server's minute tick moves them on (rollDueSeries):
 * every query, index, card, Home line, reminder, standby copy and old app keeps working unchanged, and a series looks to an
 * old app like a one-off that moves forward by itself. A standby never rolls (its rows are its main server's); after a
 * take-over the new main server rolls the same way, because the next date is worked out from the row alone.
 *
 * An RSVP is for one date (event_rsvps.occurrence_at, the start it was written for): it counts while that date is the
 * event's, so the next date starts at nobody going. The roll removes nobody from the chat; the 30-day prune
 * (pruneStaleRsvps) takes RSVPs for dates a month gone, with their tombstones and the chat's participant mirror, so a
 * regular who stops coming leaves the chat a month after their last date. The host never leaves.
 *
 * A series with no date left (its last date passed, or every date left cancelled) ends as a one-off does: it stays where it
 * is, ended, and the 30-day scrub (engine/posts.ts scrubEndedEvents) takes it. Its `until` is set to its last date so the
 * roll never looks at it again. (The design said status 'completed'; the scrub skips completed rows, so it never would.)
 */

import {
    getPosts,
    publicBroadcastPost,
    isEventHost,
    isLocalDate,
    isSeriesDate,
    latestUntil,
    nextOccurrence,
    occurrenceOn,
    parseRepeatPattern,
    patternFallsOn,
    readRepeatRule,
    readRepeatSkips,
    repeatRuleCell,
    repeatSkipsCell,
    shortestGapMinutes,
    wallMinutesBetween,
    weekdayOf,
    EVENT_REPEAT_SKIPS_MAX,
    REPEAT_ERRORS,
    type EventRepeatPattern,
    type EventRepeatRule,
    type MarketplacePost,
} from '@beanpool/engine';
import type { PushNoticeKind } from '@beanpool/core';
import { db, deletePlainRows, writeTombstone } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { bumpPostsVersion } from './versions.js';
import { syncEventThreadMembership } from './event-thread.js';
import { eventGoingPubkeys, EVENT_PUSH_CATEGORY } from './posts.js';

type BroadcastFn = (event: any, recipients?: string[]) => void;
type PushFn = (
    targetPubkeys: string[],
    actorPubkey: string,
    title: string,
    body: string,
    data: Record<string, any>,
    categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery',
    kind: PushNoticeKind,
) => void;

/** An RSVP counts for the event's current date (DESIGN-event-times §8): stamped with it, or from before the stamp. */
export const RSVP_IS_CURRENT = (r: string, p: string) => `(${r}.occurrence_at IS NULL OR ${r}.occurrence_at = ${p}.event_start_at)`;

/** How long an RSVP for a date gone by is kept: a month after that date, like an ended event's (§8). */
export const STALE_RSVP_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const SERIES_NOT_REPEATING = 'This event does not repeat';
export const SKIP_HOST_ONLY = 'Only the host can cancel or restore a date';
export const SKIP_LAST_DATE = 'This is the last date left: cancel the event instead';
export const SKIPS_TOO_MANY = `At most ${EVENT_REPEAT_SKIPS_MAX} dates can be cancelled`;
export const DATE_CANCELLED_PUSH_TITLE = 'Date cancelled';

/** The three series columns, as written. */
export interface SeriesCells {
    repeat: string | null;
    until: string | null;
    skips: string | null;
}

const NO_SERIES: SeriesCells = { repeat: null, until: null, skips: null };

/** "YYYY-MM-DD" → "Fri 16 Oct", from the date alone (no zone: the date is already the event's own). */
export function localDateWords(date: string): string {
    const DAYS: Record<string, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${DAYS[weekdayOf(date)]} ${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]}`;
}

function cleanUntil(raw: unknown, firstDate: string): string | null {
    if (raw == null || raw === '') return null;
    if (!isLocalDate(raw) || raw < firstDate) throw new Error(REPEAT_ERRORS.until);
    if (raw > latestUntil(firstDate)) throw new Error(REPEAT_ERRORS.untilTooFar);
    return raw;
}

function ruleOf(pattern: EventRepeatPattern, time: string, minutes: number, firstDate: string): EventRepeatRule {
    if (!patternFallsOn(pattern, firstDate)) throw new Error(REPEAT_ERRORS.firstDate);
    if (minutes < 1 || minutes >= shortestGapMinutes(pattern)) throw new Error(REPEAT_ERRORS.tooLong);
    return { ...pattern, time, minutes };
}

/**
 * A new event's series columns from the app's `eventRepeat` and `eventRepeatUntil` (§8): none for a one-off. `askedStart`
 * and `askedEnd` are the clocks the host set ("YYYY-MM-DDTHH:MM", before a DST gap moved them), whose date must be one of
 * the rule's and whose time and length every date keeps.
 */
export function seriesOnCreate(rawRepeat: unknown, rawUntil: unknown, askedStart: string, askedEnd: string): SeriesCells {
    const pattern = parseRepeatPattern(rawRepeat);
    if (!pattern) return NO_SERIES;
    const firstDate = askedStart.slice(0, 10);
    const rule = ruleOf(pattern, askedStart.slice(11), wallMinutesBetween(askedStart, askedEnd), firstDate);
    return { repeat: repeatRuleCell(rule), until: cleanUntil(rawUntil, firstDate), skips: null };
}

/**
 * An edit's series columns, or undefined when they stay as they are. `askedStart` / `askedEnd` are the clocks this edit
 * set (null when it set none: the rule keeps its own clock and length, which a gap-day's stored clock would not say);
 * `nextStartLocal` / `nextEndLocal` the date the event will have. Cancelled dates no longer on the rule are dropped.
 */
export function seriesOnEdit(
    existing: MarketplacePost,
    rawRepeat: unknown,
    rawUntil: unknown,
    asked: { start: string | null; end: string | null },
    next: { startLocal: string; endLocal: string; tz: string; timeChanged: boolean },
): SeriesCells | undefined {
    const repeatSent = rawRepeat !== undefined;
    const untilSent = rawUntil !== undefined;
    const kept = existing.eventRepeat ?? null;
    const pattern = repeatSent ? parseRepeatPattern(rawRepeat) : kept;
    if (!pattern) return kept ? NO_SERIES : undefined;
    if (!repeatSent && !untilSent && !next.timeChanged) return undefined;
    const firstDate = next.startLocal.slice(0, 10);
    const time = asked.start ? asked.start.slice(11) : (kept?.time ?? next.startLocal.slice(11));
    const minutes = asked.start || asked.end
        ? wallMinutesBetween(asked.start ?? `${firstDate}T${time}`, asked.end ?? next.endLocal)
        : (kept?.minutes ?? wallMinutesBetween(next.startLocal, next.endLocal));
    const rule = ruleOf(pattern, time, minutes, firstDate);
    const until = untilSent ? cleanUntil(rawUntil, firstDate) : cleanUntil(existing.eventRepeatUntil ?? null, firstDate);
    const walk = { rule, anchorDate: firstDate, tz: next.tz, until };
    const skips = (existing.eventRepeatSkips ?? []).filter(d => d >= firstDate && isSeriesDate(walk, d));
    return { repeat: repeatRuleCell(rule), until, skips: repeatSkipsCell(skips) };
}

/**
 * An edit moved the event's date (§8 Edit): the RSVPs and the reminder marks for the date it had go with it, so the people
 * going are still going and a reminder already sent is not sent again, as for an edit before repeating events. Each RSVP is
 * stamped after its last write or tombstone, so a standby's last-write-wins takes it; each mark moves with a tombstone
 * for its old key. Inside the edit's transaction.
 */
export function moveOccurrence(postId: string, fromStart: string, toStart: string): void {
    if (fromStart === toStart) return;
    const nowIso = new Date().toISOString();
    const rsvps = db.prepare(`SELECT member_pubkey, updated_at FROM event_rsvps WHERE post_id = ? AND (occurrence_at = ? OR occurrence_at IS NULL)`)
        .all(postId, fromStart) as { member_pubkey: string; updated_at: string | null }[];
    const restamp = db.prepare(`UPDATE event_rsvps SET occurrence_at = ?, updated_at = ? WHERE post_id = ? AND member_pubkey = ?`);
    for (const r of rsvps) {
        const writeAt = r.updated_at && r.updated_at >= nowIso ? new Date(Date.parse(r.updated_at) + 1).toISOString() : nowIso;
        restamp.run(toStart, writeAt, postId, r.member_pubkey);
    }
    const marks = db.prepare(`SELECT member_pubkey, offset_min, sent_at FROM event_reminders_sent WHERE post_id = ? AND occurrence_at = ?`)
        .all(postId, fromStart) as { member_pubkey: string; offset_min: number; sent_at: string | null }[];
    if (marks.length === 0) return;
    deletePlainRows('event_reminders_sent', 'post_id = ? AND occurrence_at = ?', postId, fromStart);
    const insert = db.prepare(`INSERT OR IGNORE INTO event_reminders_sent (post_id, member_pubkey, offset_min, occurrence_at, sent_at) VALUES (?, ?, ?, ?, ?)`);
    for (const m of marks) insert.run(postId, m.member_pubkey, m.offset_min, toStart, m.sent_at);
}

interface SeriesRow {
    id: string;
    title: string;
    author_pubkey: string;
    audience_scope: string | null;
    target_group_id: string | null;
    event_start_at: string;
    event_end_at: string;
    event_start_local: string | null;
    event_tz: string | null;
    event_state: string | null;
    active: number;
    status: string;
    event_repeat: string | null;
    event_repeat_until: string | null;
    event_repeat_skips: string | null;
}

const SERIES_COLUMNS = `id, title, author_pubkey, audience_scope, target_group_id, event_start_at, event_end_at, event_start_local,
    event_tz, event_state, active, status, event_repeat, event_repeat_until, event_repeat_skips`;

function recipientsOf(row: { audience_scope: string | null; target_group_id: string | null }): string[] | undefined {
    if (row.audience_scope === 'group' && row.target_group_id) {
        return (db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(row.target_group_id) as any[])
            .map(r => r.member_pubkey as string);
    }
    return undefined;
}

function broadcastSeries(broadcast: BroadcastFn | undefined, row: SeriesRow): void {
    if (!broadcast) return;
    try {
        const post = getPosts(db, { id: row.id, includeAllScopes: true })[0];
        if (post) broadcast({ type: 'post_updated', post: publicBroadcastPost(post) }, recipientsOf(row));
    } catch (e) {
        console.warn('[Events] series change not broadcast:', e);
    }
}

/** Writes a date onto the row as its current one: its four times, scheduled (UPDATED told of the date gone by), the skips left. */
function writeCurrentDate(row: SeriesRow, occ: ReturnType<typeof occurrenceOn> & object, skips: string[], nowIso: string): boolean {
    return db.prepare(`
        UPDATE posts
           SET event_start_at = ?, event_end_at = ?, event_start_local = ?, event_end_local = ?,
               event_state = 'scheduled', event_repeat_skips = ?, updated_at = ?
         WHERE id = ? AND event_start_at = ?`)
        .run(occ.startAt, occ.endAt, occ.startLocal, occ.endLocal, repeatSkipsCell(skips.filter(d => d >= occ.date)), nowIso, row.id, row.event_start_at)
        .changes > 0;
}

/**
 * The roll (§8): every series whose current date has ended moves to its next one. Run each minute on a main server only
 * (state-engine armMainServerTimers); a standby never rolls. One indexed range over the series that have ended
 * (idx_posts_event_series). Returns how many rows moved or ended.
 */
export function rollDueSeries(broadcast?: BroadcastFn, nowMs = Date.now()): number {
    if (getNodeRole() !== 'primary') return 0;
    const nowIso = new Date(nowMs).toISOString();
    let due: SeriesRow[];
    try {
        due = db.prepare(`
            SELECT ${SERIES_COLUMNS} FROM posts
             WHERE type = 'event' AND event_repeat IS NOT NULL AND event_end_at <= ?
               AND active = 1 AND status = 'active' AND COALESCE(event_state, '') != 'cancelled'
               AND event_start_local IS NOT NULL AND event_tz IS NOT NULL
               AND (event_repeat_until IS NULL OR event_repeat_until > substr(event_start_local, 1, 10))
             ORDER BY event_end_at ASC LIMIT 500`).all(nowIso) as SeriesRow[];
    } catch {
        return 0; // series columns absent on an older schema
    }
    const moved: SeriesRow[] = [];
    for (const row of due) {
        try {
            const rule = readRepeatRule(row.event_repeat);
            if (!rule) continue;
            const skips = readRepeatSkips(row.event_repeat_skips);
            const currentDate = row.event_start_local!.slice(0, 10);
            const next = nextOccurrence({ rule, anchorDate: currentDate, tz: row.event_tz!, skips, until: row.event_repeat_until }, nowIso);
            const changed = next
                ? writeCurrentDate(row, next, skips, nowIso)
                // No date left: it ends as a one-off does, its last date its `until`, out of the roll for good.
                : db.prepare(`UPDATE posts SET event_repeat_until = ?, updated_at = ? WHERE id = ? AND event_start_at = ?`)
                    .run(currentDate, nowIso, row.id, row.event_start_at).changes > 0;
            if (changed) moved.push(row);
        } catch (e) {
            // One bad row must not stop the rest, and the tick must not die on it.
            console.warn(`[Events] could not roll ${row.id.slice(0, 8)}:`, e);
        }
    }
    if (moved.length > 0) {
        bumpPostsVersion();
        for (const row of moved) broadcastSeries(broadcast, row);
    }
    return moved.length;
}

/**
 * "Cancel this date" and its undo (§8): `POST /api/events/:id/skip { date }` and `DELETE` the same, the host only. A
 * cancelled current date rolls the series on at once, and Going for it are told "Fri 16 Oct is cancelled. Next: Fri 23
 * Oct". Restoring a date the roll had passed for its cancelling moves the series back to it. The only date left can't
 * be cancelled: that is cancelling the event, which has its own way.
 */
export function setSeriesDateSkipped(
    broadcast: BroadcastFn | undefined,
    push: PushFn | undefined,
    postId: string,
    actorPubkey: string,
    date: unknown,
    skipped: boolean,
    nowMs = Date.now(),
): { post: MarketplacePost; skips: string[] } {
    const row = db.prepare(`SELECT ${SERIES_COLUMNS}, type, hidden_by_reports_at FROM posts WHERE id = ?`).get(postId) as (SeriesRow & { type: string; hidden_by_reports_at: string | null }) | undefined;
    if (!row || row.type !== 'event' || (row.hidden_by_reports_at && !isEventHost(db, row, actorPubkey))) throw new Error('Event not found');
    if (!isEventHost(db, row, actorPubkey)) throw new Error(SKIP_HOST_ONLY);
    if (!row.active || row.status !== 'active' || row.event_state === 'cancelled') throw new Error('This event has been cancelled');
    const rule = readRepeatRule(row.event_repeat);
    if (!rule || !row.event_start_local || !row.event_tz) throw new Error(SERIES_NOT_REPEATING);
    const nowIso = new Date(nowMs).toISOString();
    const currentDate = row.event_start_local.slice(0, 10);
    const tz = row.event_tz;
    const walk = { rule, anchorDate: currentDate, tz, until: row.event_repeat_until };
    const occ = isLocalDate(date) && isSeriesDate(walk, date) ? occurrenceOn(rule, date, tz) : null;
    if (!occ || Date.parse(occ.endAt) <= nowMs) throw new Error(REPEAT_ERRORS.skipDate);
    const day = occ.date;

    const skips = readRepeatSkips(row.event_repeat_skips).filter(d => d >= currentDate || d === day);
    const nextSkips = skipped ? [...new Set([...skips, day])].sort() : skips.filter(d => d !== day);
    if (nextSkips.length > EVENT_REPEAT_SKIPS_MAX) throw new Error(SKIPS_TOO_MANY);

    let notify: { going: string[]; body: string } | null = null;
    db.transaction(() => {
        if (skipped && day === currentDate) {
            const next = nextOccurrence({ ...walk, skips: nextSkips }, nowIso);
            if (!next) throw new Error(SKIP_LAST_DATE);
            const going = eventGoingPubkeys(postId);
            writeCurrentDate(row, next, nextSkips, nowIso);
            notify = { going, body: `${(row.title || 'An event').trim() || 'An event'}: ${localDateWords(day)} is cancelled. Next: ${localDateWords(next.date)}.` };
        } else if (!skipped && day < currentDate) {
            // A date the roll passed because it was cancelled, restored: it is the next date again.
            writeCurrentDate(row, occ, nextSkips, nowIso);
        } else {
            db.prepare(`UPDATE posts SET event_repeat_skips = ?, updated_at = ? WHERE id = ?`).run(repeatSkipsCell(nextSkips), nowIso, postId);
        }
    })();
    bumpPostsVersion();
    broadcastSeries(broadcast, row);
    const sent = notify as { going: string[]; body: string } | null;
    if (push && sent && sent.going.length > 0) {
        try {
            push(sent.going, actorPubkey, DATE_CANCELLED_PUSH_TITLE, sent.body, { screen: 'post', postId }, EVENT_PUSH_CATEGORY, 'event.update');
        } catch (e) {
            console.warn('[Events] date-cancelled notice not sent:', e);
        }
    }
    const post = getPosts(db, { id: postId, viewerPubkey: actorPubkey, includeAllScopes: true })[0]!;
    return { post, skips: post.eventRepeatSkips ?? [] };
}

let lastPruneMs = 0;
/** How often the prune runs inside the minute tick: hourly is plenty for a 30-day rule. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * The 30-day prune (§8): RSVPs for a date a month gone that is not the event's current date, each with its tombstone, and
 * the member's seat in the chat's participant mirror with its own (the host keeps theirs, syncEventThreadMembership); and
 * the reminder marks for such dates (a plain table: deletePlainRows writes their tombstones). A one-off's RSVPs are its
 * current date's until the scrub takes the whole event, so this only ever reaches a series. Main server only. Returns
 * the RSVPs pruned.
 */
export function pruneStaleRsvps(nowMs = Date.now(), force = false): number {
    if (getNodeRole() !== 'primary') return 0;
    if (!force && nowMs - lastPruneMs < PRUNE_EVERY_MS) return 0;
    lastPruneMs = nowMs;
    const cutoff = new Date(nowMs - STALE_RSVP_PRUNE_AFTER_MS).toISOString();
    let stale: { post_id: string; member_pubkey: string }[];
    try {
        stale = db.prepare(`
            SELECT r.post_id, r.member_pubkey FROM event_rsvps r JOIN posts p ON p.id = r.post_id
             WHERE r.occurrence_at IS NOT NULL AND r.occurrence_at < ? AND r.occurrence_at != p.event_start_at`).all(cutoff) as any[];
    } catch {
        return 0;
    }
    let pruned = 0;
    for (const r of stale) {
        try {
            db.transaction(() => {
                if (db.prepare('DELETE FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').run(r.post_id, r.member_pubkey).changes === 0) return;
                writeTombstone('event_rsvps', `${r.post_id}|${r.member_pubkey}`);
                // Not going any more, for the chat's mirror: the read rule (canReadEventThread) already finds no RSVP.
                syncEventThreadMembership(r.post_id, r.member_pubkey, null);
                pruned++;
            })();
        } catch (e) {
            console.warn(`[Events] could not prune an RSVP on ${r.post_id.slice(0, 8)}:`, e);
        }
    }
    try {
        deletePlainRows('event_reminders_sent', `occurrence_at != '' AND occurrence_at < ?
            AND occurrence_at != COALESCE((SELECT p.event_start_at FROM posts p WHERE p.id = event_reminders_sent.post_id), '')`, cutoff);
    } catch (e) {
        console.warn('[Events] could not prune old reminder marks:', e);
    }
    if (pruned > 0) bumpPostsVersion();
    return pruned;
}
