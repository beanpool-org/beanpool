/**
 * Event reminders — "remind me before this one" (docs/events-on-the-map.md §2.2).
 *
 * Every member who is Going or Interested gets reminders for that event. Which ones is their own choice:
 * a default they set once in Settings → Notifications (everyone starts at `[1440]`, the day before), and
 * an optional per-event override that replaces it. `null` on the RSVP row means "my default applies";
 * `[]` means none at all. Offsets are minutes before the start, from a closed set — a picker, not a
 * free-text field, so there is nothing to sanitise downstream and nothing to render that we have not seen.
 *
 * ── What "due" means ──────────────────────────────────────────────────────────────────────────────────
 *
 * A reminder for (event, member, offset) has a moment: `event_start_at - offset`. The sweep sends it when
 * that moment is behind us but not far behind, and only when it was in the FUTURE at the point the person
 * chose it. Three conditions, and each one exists for a case the design names:
 *
 *   armedAt <= due     "Never for an offset whose moment had already passed when the member RSVPed or
 *                      chose it." `armedAt` is the RSVP row's `updated_at`, which every RSVP and every
 *                      reminder change bumps — so choosing a 1-week reminder three days before the event
 *                      is silently ignored rather than firing instantly.
 *
 *   due <= now         It has come round.
 *
 *   now - due <= GRACE "If the host changes the time, reminders re-arm against the new time, but offsets
 *                      already in the past stay silent." A start pulled forward moves several moments into
 *                      the past at once; without the window they would all fire together, telling somebody
 *                      an event starts in a week when it starts on Thursday. The window is what makes a
 *                      reminder either timely or not sent, never late. It is also the whole tolerance for a
 *                      node that was restarting when the minute came round: 15 minutes of downtime is
 *                      covered, an hour is not, and an hour-late "starts in 30 minutes" would be a lie.
 *
 * Whether the reminder is then actually delivered is the push dispatcher's business, as it is for every
 * other push: it drops members who have turned Marketplace notifications off, and members with no device.
 *
 * ── Never twice ───────────────────────────────────────────────────────────────────────────────────────
 *
 * `event_reminders_sent` is keyed on exactly (post_id, member_pubkey, offset_min), and nothing about
 * "already sent" lives in this process — which is what makes a restart a non-event. `dueEventReminders`
 * drops anything the table already holds, and the sweep then CLAIMS each one with `INSERT OR IGNORE` and
 * sends only if the insert changed a row. The claim is not the ordinary gate (the filter is): it is the
 * atomic one, for the case the filter cannot see — two processes on the same `state.db`. One push per
 * (event, member, offset), for the life of the event.
 */

import { db } from '../db/db.js';
import { getNodeRole } from './sync.js';

/** The five offsets the picker offers, in minutes before the start. Nothing else is storable. */
export const EVENT_REMINDER_OFFSETS = [10080, 1440, 120, 60, 30] as const;

/** What everyone gets until they say otherwise: the day before (board decision, 2026-09-23). */
export const DEFAULT_EVENT_REMINDER_OFFSETS: number[] = [1440];

/** The member preference key holding a member's own default, as a JSON array. */
export const EVENT_REMINDER_PREF_KEY = 'event_reminder_offsets';

/** How late a reminder may be and still be worth sending. See the note above. */
export const EVENT_REMINDER_GRACE_MS = 15 * 60 * 1000;

/** The furthest ahead any reminder can look, used to bound the sweep's query. */
const MAX_OFFSET_MS = Math.max(...EVENT_REMINDER_OFFSETS) * 60 * 1000;

/** The category and payload every event push already uses — see engine/posts.ts. */
const REMINDER_PUSH_CATEGORY = 'marketplace' as const;

type PushFn = (
    targetPubkeys: string[],
    actorPubkey: string,
    title: string,
    body: string,
    data: Record<string, any>,
    categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery',
) => void;

export const BAD_OFFSETS_MESSAGE =
    `Reminders must be chosen from ${EVENT_REMINDER_OFFSETS.join(', ')} minutes before the start`;

/**
 * A client's `offsets` value, checked into a stored one.
 *
 * `null` (and only a literal null) is "my default applies". Anything else must be an array whose every
 * entry is one of the five, with duplicates collapsed and the order fixed by us, so two clients sending the
 * same choice in a different order store the same bytes and sync does not see a change that is not one.
 */
export function parseReminderOffsets(raw: unknown): number[] | null {
    if (raw === null) return null;
    if (!Array.isArray(raw)) throw new Error(BAD_OFFSETS_MESSAGE);
    const allowed = new Set<number>(EVENT_REMINDER_OFFSETS as readonly number[]);
    const seen = new Set<number>();
    for (const v of raw) {
        // Not `Number(v)`: '' and null both become 0 and true becomes 1, and a client that sent one of
        // those means a bug, not "30 minutes". Only a real number is a real offset.
        if (typeof v !== 'number' || !Number.isInteger(v) || !allowed.has(v)) throw new Error(BAD_OFFSETS_MESSAGE);
        seen.add(v);
    }
    return (EVENT_REMINDER_OFFSETS as readonly number[]).filter(o => seen.has(o));
}

/** A stored `reminder_offsets` cell back into offsets. Unreadable or unknown values read as "none". */
export function readStoredOffsets(cell: unknown): number[] | null {
    if (cell == null) return null;
    try {
        const parsed = JSON.parse(String(cell));
        if (!Array.isArray(parsed)) return [];
        const allowed = new Set<number>(EVENT_REMINDER_OFFSETS as readonly number[]);
        return (EVENT_REMINDER_OFFSETS as readonly number[])
            .filter(o => parsed.some((v: unknown) => v === o && allowed.has(o)));
    } catch {
        return [];
    }
}

/**
 * This member's own default.
 *
 * Read straight from `member_preferences` rather than through `getMemberPreference`, which answers 'true'
 * for any key nobody has set — that default is right for the notification toggles and meaningless here.
 */
export function getMemberDefaultReminderOffsets(memberPubkey: string): number[] {
    const row = db.prepare(
        `SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = ?`
    ).get(memberPubkey, EVENT_REMINDER_PREF_KEY) as { pref_value: string } | undefined;
    if (!row) return [...DEFAULT_EVENT_REMINDER_OFFSETS];
    return readStoredOffsets(row.pref_value) ?? [...DEFAULT_EVENT_REMINDER_OFFSETS];
}

/** Store a member's own default. Validated by the caller through `parseReminderOffsets`. */
export function setMemberDefaultReminderOffsets(memberPubkey: string, offsets: number[]): void {
    db.prepare(
        `INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)`
    ).run(memberPubkey, EVENT_REMINDER_PREF_KEY, JSON.stringify(offsets));
}

/** Refused when the signer has no RSVP on the event. The route turns this into a 403. */
export const NO_RSVP_MESSAGE = 'You can only set a reminder on an event you have RSVPed to';

/**
 * A member's reminders for ONE event. `null` returns it to their default.
 *
 * The RSVP's `updated_at` is bumped, which does two things at once: delta sync carries the change to a
 * replica on the same last-write-wins rule as the RSVP itself, and `armedAt` moves to now — so an offset
 * whose moment has already gone is chosen, not fired.
 */
export function setEventReminderOffsets(
    postId: string,
    memberPubkey: string,
    offsets: number[] | null,
): { offsets: number[] | null } {
    const stored = offsets === null ? null : JSON.stringify(offsets);
    const res = db.prepare(
        `UPDATE event_rsvps
            SET reminder_offsets = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE post_id = ? AND member_pubkey = ?`
    ).run(stored, postId, memberPubkey);
    if (res.changes === 0) throw new Error(NO_RSVP_MESSAGE);
    return { offsets };
}

/**
 * "Your events" — the signer's own RSVPs, soonest first.
 *
 * Upcoming and not cancelled only: an event that has ended or been called off is not something to show
 * under "★ For you". The photo is the same versioned URL `getPosts` builds for the event card, so the
 * client resolves it exactly as it does there, and the first photo is the card's photo.
 */
export interface MyEvent {
    postId: string;
    title: string;
    startAt: string;
    endAt: string;
    placeName: string | null;
    rsvp: 'going' | 'interested';
    photo: string | null;
    reminderOffsets: number[] | null;
}

export function listMyEvents(memberPubkey: string, nowMs = Date.now()): MyEvent[] {
    const nowIso = new Date(nowMs).toISOString();
    const rows = db.prepare(`
        SELECT p.id, p.title, p.event_start_at, p.event_end_at, p.event_place_name,
               r.status, r.reminder_offsets,
               (SELECT ph.order_num FROM post_photos ph
                 WHERE ph.post_id = p.id ORDER BY ph.order_num ASC LIMIT 1) AS photo_order,
               (SELECT ph.updated_at FROM post_photos ph
                 WHERE ph.post_id = p.id ORDER BY ph.order_num ASC LIMIT 1) AS photo_updated_at
          FROM event_rsvps r
          JOIN posts p ON p.id = r.post_id
         WHERE r.member_pubkey = ?
           AND p.type = 'event'
           AND p.active = 1
           AND p.status = 'active'
           AND COALESCE(p.event_state, '') != 'cancelled'
           AND p.event_end_at > ?
         ORDER BY p.event_start_at ASC
    `).all(memberPubkey, nowIso) as any[];

    return rows.map(r => ({
        postId: r.id,
        title: r.title,
        startAt: r.event_start_at,
        endAt: r.event_end_at,
        placeName: r.event_place_name ?? null,
        rsvp: r.status as 'going' | 'interested',
        photo: r.photo_order == null
            ? null
            : `/api/marketplace/posts/${r.id}/photos/${r.photo_order}?v=${r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : 0}`,
        reminderOffsets: readStoredOffsets(r.reminder_offsets),
    }));
}

// ===================== DELIVERY =====================

export const reminderPushTitle = (eventTitle: string): string =>
    `📅 ${(eventTitle || 'An event').trim() || 'An event'}`;

/**
 * "Starts tomorrow at 10:00", "Starts in 2 hours".
 *
 * Under two hours it is relative, which needs no calendar and cannot be wrong. From a day out it names the
 * day and the clock time, because "in 7 days" is not something anyone can act on — and the day is worked
 * out from the actual local dates rather than from the offset, so a daylight-saving change cannot make a
 * reminder say "tomorrow" about today.
 *
 * The clock is the NODE's: a BeanPool node serves one locality and its members are in it. A member reading
 * this on a phone in another timezone sees their community's time, which is the time the event happens in.
 */
export function reminderPushBody(offsetMin: number, startAtIso: string, nowMs: number): string {
    const start = new Date(startAtIso);
    if (offsetMin < 1440) {
        if (offsetMin >= 120 && offsetMin % 60 === 0) return `Starts in ${offsetMin / 60} hours`;
        if (offsetMin === 60) return 'Starts in an hour';
        return `Starts in ${offsetMin} minutes`;
    }
    const at = start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const days = calendarDaysBetween(new Date(nowMs), start);
    if (days === 0) return `Starts today at ${at}`;
    if (days === 1) return `Starts tomorrow at ${at}`;
    return `Starts ${start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${at}`;
}

/** Whole local days from one instant to another, counted on the calendar rather than in milliseconds. */
function calendarDaysBetween(from: Date, to: Date): number {
    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
    return Math.round((b - a) / 86_400_000);
}

/** One reminder that has come round and has not been sent. */
export interface DueReminder {
    postId: string;
    title: string;
    startAt: string;
    memberPubkey: string;
    offsetMin: number;
}

/**
 * Every reminder due at `nowMs`, for events that are still on.
 *
 * The SQL narrows to events starting inside the widest offset — a reminder can never be for an event that
 * has already started, since the smallest offset is 30 minutes and the grace window is shorter than that —
 * and the per-offset arithmetic is done here, where the member's default and their per-event override can
 * both be seen. A cancelled event, an ended event and a withdrawn RSVP all drop out of the join, which is
 * the whole of "never for a cancelled or ended event, or a removed RSVP".
 */
export function dueEventReminders(nowMs = Date.now()): DueReminder[] {
    const nowIso = new Date(nowMs).toISOString();
    const horizonIso = new Date(nowMs + MAX_OFFSET_MS).toISOString();
    let rows: any[];
    let alreadySent: { get: (...params: any[]) => unknown };
    try {
        alreadySent = db.prepare(
            `SELECT 1 FROM event_reminders_sent WHERE post_id = ? AND member_pubkey = ? AND offset_min = ?`
        );
        rows = db.prepare(`
            SELECT p.id, p.title, p.event_start_at, r.member_pubkey, r.reminder_offsets, r.updated_at
              FROM event_rsvps r
              JOIN posts p ON p.id = r.post_id
             WHERE p.type = 'event'
               AND p.active = 1
               AND p.status = 'active'
               AND COALESCE(p.event_state, '') != 'cancelled'
               AND p.event_start_at > ?
               AND p.event_start_at <= ?
             ORDER BY p.event_start_at ASC
        `).all(nowIso, horizonIso) as any[];
    } catch {
        return []; // event columns or the sent-marks table absent on an older schema
    }

    const defaultsByMember = new Map<string, number[]>();
    const due: DueReminder[] = [];

    for (const r of rows) {
        const startMs = Date.parse(r.event_start_at);
        if (!Number.isFinite(startMs)) continue;
        let offsets = readStoredOffsets(r.reminder_offsets);
        if (offsets === null) {
            if (!defaultsByMember.has(r.member_pubkey)) {
                defaultsByMember.set(r.member_pubkey, getMemberDefaultReminderOffsets(r.member_pubkey));
            }
            offsets = defaultsByMember.get(r.member_pubkey)!;
        }
        if (offsets.length === 0) continue;
        // The RSVP's own clock, not the post's: this is when THIS person opted in.
        const armedMs = Date.parse(r.updated_at ?? '');
        for (const offsetMin of offsets) {
            const dueMs = startMs - offsetMin * 60 * 1000;
            if (dueMs > nowMs) continue;                              // not yet
            if (nowMs - dueMs > EVENT_REMINDER_GRACE_MS) continue;    // gone by; never sent late
            if (Number.isFinite(armedMs) && dueMs < armedMs) continue; // already past when they chose it
            if (alreadySent.get(r.id, r.member_pubkey, offsetMin)) continue;
            due.push({
                postId: r.id,
                title: r.title,
                startAt: r.event_start_at,
                memberPubkey: r.member_pubkey,
                offsetMin,
            });
        }
    }
    return due;
}

/**
 * One pass of the scheduler: claim what is due and push it.
 *
 * Returns the number of reminders CLAIMED, which is not always the number of phones that buzz — the
 * dispatcher still drops anyone with Marketplace notifications off or no registered device. The mark is
 * written either way, and deliberately: the moment has passed, and a member who turns notifications back on
 * an hour later should not then hear about an event that started meanwhile.
 *
 * Members due the same reminder for the same event are dispatched as one call, because the title, the body
 * and the payload are identical for all of them.
 */
export function runEventReminderSweep(push: PushFn | undefined, nowMs = Date.now()): number {
    if (!push) return 0;
    const due = dueEventReminders(nowMs);
    if (due.length === 0) return 0;

    const claim = db.prepare(
        `INSERT OR IGNORE INTO event_reminders_sent (post_id, member_pubkey, offset_min, sent_at)
         VALUES (?, ?, ?, ?)`
    );
    const sentAt = new Date(nowMs).toISOString();

    // Keyed on the push that would be sent, not on the event: two members of the same event with different
    // offsets get different words and must not be collapsed into one message.
    const batches = new Map<string, { postId: string; title: string; startAt: string; offsetMin: number; targets: string[] }>();
    for (const d of due) {
        // The due list already excludes everything marked. This is the atomic re-check on top of it:
        // losing the insert means another process claimed the same reminder between the read and here.
        if (claim.run(d.postId, d.memberPubkey, d.offsetMin, sentAt).changes === 0) continue;
        const key = `${d.postId}|${d.offsetMin}`;
        if (!batches.has(key)) {
            batches.set(key, { postId: d.postId, title: d.title, startAt: d.startAt, offsetMin: d.offsetMin, targets: [] });
        }
        batches.get(key)!.targets.push(d.memberPubkey);
    }

    let claimed = 0;
    for (const b of batches.values()) {
        claimed += b.targets.length;
        try {
            push(
                b.targets,
                'SYSTEM',
                reminderPushTitle(b.title),
                reminderPushBody(b.offsetMin, b.startAt, nowMs),
                { screen: 'post', postId: b.postId },
                REMINDER_PUSH_CATEGORY,
            );
        } catch (e) {
            // Same rule as every other event push: a delivery failure never becomes a node failure. The
            // mark stays written — retrying a reminder we could not dispatch would mean sending it late.
            console.warn('[Events] reminder not sent:', e);
        }
    }
    return claimed;
}

/**
 * The scheduler, as one tick.
 *
 * Primary only, like every other background job here with a side effect out in the world: a backup node
 * holds the same RSVPs and the same push tokens by design, and a replica that reminded people on its own
 * would double every reminder the moment a mirror existed.
 */
export function tickEventReminders(push: PushFn | undefined, nowMs = Date.now()): number {
    if (getNodeRole() !== 'primary') return 0;
    return runEventReminderSweep(push, nowMs);
}
