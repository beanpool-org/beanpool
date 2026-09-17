/**
 * Events on the web app (docs/events-on-the-map.md §3): how an event's time reads on a card, and which events
 * the map's Today / This weekend / Next 7 days chips keep.
 *
 * Times arrive as ISO UTC and are shown in the viewer's local time. The names are spelled out here rather than
 * taken from `toLocaleDateString`, so a card reads the same on every browser at 320px.
 */

import type { MarketplacePost } from './api';

/** Every post type this client can render. Sent as `types=` so the node includes events (§2.6). */
export const CLIENT_POST_TYPES = 'offer,need,poll,event';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** An event ends at `eventEndAt`; one without falls back to start + 2 hours, as the server defaults it. */
export const EVENT_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

function time(d: Date): string {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function day(d: Date): string {
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function sameLocalDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function eventEndMs(post: Pick<MarketplacePost, 'eventStartAt' | 'eventEndAt'>): number {
    if (post.eventEndAt) return Date.parse(post.eventEndAt);
    return post.eventStartAt ? Date.parse(post.eventStartAt) + EVENT_DEFAULT_DURATION_MS : NaN;
}

/**
 * The two halves of an event's time, each kept whole when a narrow card wraps: ["SAT 27 SEP", "9:00–12:00"],
 * or ["SAT 27 SEP 22:00", "SUN 28 SEP 2:00"] across midnight.
 */
export function eventWhenParts(post: Pick<MarketplacePost, 'eventStartAt' | 'eventEndAt'>): { first: string; second: string; sep: string } | null {
    if (!post.eventStartAt) return null;
    const start = new Date(post.eventStartAt);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(eventEndMs(post));
    if (Number.isNaN(end.getTime())) return { first: day(start), second: time(start), sep: ' · ' };
    if (sameLocalDay(start, end)) return { first: day(start), second: `${time(start)}–${time(end)}`, sep: ' · ' };
    return { first: `${day(start)} ${time(start)}`, second: `${day(end)} ${time(end)}`, sep: ' – ' };
}

/** "SAT 27 SEP · 9:00–12:00", or "SAT 27 SEP 22:00 – SUN 28 SEP 2:00" across midnight. */
export function formatEventWhen(post: Pick<MarketplacePost, 'eventStartAt' | 'eventEndAt'>): string {
    const parts = eventWhenParts(post);
    return parts ? `${parts.first}${parts.sep}${parts.second}` : '';
}

/** True while an event can still be joined: not cancelled, not removed, not over. */
export function isEventOpen(post: MarketplacePost, now = Date.now()): boolean {
    if (post.type !== 'event') return false;
    if (post.eventState === 'cancelled' || post.status === 'cancelled') return false;
    if (post.status && post.status !== 'active') return false;
    const end = eventEndMs(post);
    return Number.isFinite(end) && end > now;
}

export type EventWindow = 'today' | 'weekend' | 'week' | 'all';

export const EVENT_WINDOWS: Array<{ id: EventWindow; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: 'weekend', label: 'This weekend' },
    { id: 'week', label: 'Next 7 days' },
    { id: 'all', label: 'All' },
];

function startOfLocalDay(ms: number): Date {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * The [from, to) span a chip covers, in local time. Today runs to midnight; This weekend is Saturday 00:00 to
 * Monday 00:00 of this week (the current one on a Saturday or Sunday); Next 7 days is now plus seven days.
 */
export function eventWindowRange(window: EventWindow, now = Date.now()): { from: number; to: number } {
    const today = startOfLocalDay(now);
    if (window === 'today') {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return { from: now, to: tomorrow.getTime() };
    }
    if (window === 'weekend') {
        const dow = today.getDay(); // 0 Sunday … 6 Saturday
        const saturday = new Date(today);
        saturday.setDate(today.getDate() + (dow === 0 ? -1 : 6 - dow));
        const monday = new Date(saturday);
        monday.setDate(saturday.getDate() + 2);
        return { from: Math.max(now, saturday.getTime()), to: monday.getTime() };
    }
    if (window === 'week') {
        return { from: now, to: now + 7 * 24 * 60 * 60 * 1000 };
    }
    return { from: now, to: Number.POSITIVE_INFINITY };
}

/** Whether an open event falls in a chip's span: it has not ended and it starts before the span closes. */
export function eventInWindow(post: MarketplacePost, window: EventWindow, now = Date.now()): boolean {
    if (!isEventOpen(post, now)) return false;
    const start = post.eventStartAt ? Date.parse(post.eventStartAt) : NaN;
    if (!Number.isFinite(start)) return false;
    const { from, to } = eventWindowRange(window, now);
    return start < to && eventEndMs(post) > from;
}

/** "2.4 km" / "800 m". */
export function formatDistance(km: number): string {
    if (!Number.isFinite(km)) return '';
    if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
    return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** A `<input type="datetime-local">` value → ISO UTC, or null when blank or unparseable. */
export function localInputToIso(value: string): string | null {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ===================== COPY TO A NEW DATE (docs/events-on-the-map.md §3, decision 8, slice 5) =====================

/**
 * What "Copy to a new date" carries into the create form. One-off events plus this is the whole of repeats in
 * v1: there are no repeat rules and no materialiser (§5).
 *
 * The dates are NOT here, on purpose — the form opens with Starts and Ends blank, because picking the new date
 * is the one thing the host is here to do, and a prefilled old date is the one value that must never be
 * submitted by accident.
 *
 * The photo is not carried either: the node serves an event's photos as URLs and create takes image data, so
 * a copy would post a broken reference. The form says so and the host re-adds it if they want one.
 */
export interface EventCopy {
    title: string;
    description: string;
    placeName: string;
    lat: number | null;
    lng: number | null;
    privateNote: string;
    /** The enterprise that hosts it, when the viewer is a keeper rather than the author; else null. */
    enterprisePubkey: string | null;
    /** The group a group-only event belongs to; null for a whole-community event. */
    groupId: string | null;
}

/**
 * Only a host sees the Copy button, and a host is the author, a keeper of an enterprise author, or an active
 * convenor of the target group. So for a group-only event the copy is posted to the same group, and for any
 * other event whose author is not the viewer the author can only be an enterprise the viewer keeps.
 *
 * `eventPrivateNote` reaches the client only for the host and for people marked Going, so a copy made by
 * anyone else simply carries no note — there is nothing to leak here.
 */
export function buildEventCopy(post: MarketplacePost, viewerPubkey?: string | null): EventCopy {
    const groupId = post.audienceScope === 'group' ? (post.targetGroupId ?? null) : null;
    const author = post.authorPublicKey || null;
    return {
        title: post.title || '',
        description: post.description || '',
        placeName: post.eventPlaceName || '',
        lat: post.lat ?? null,
        lng: post.lng ?? null,
        privateNote: post.eventPrivateNote || '',
        enterprisePubkey: !groupId && author && viewerPubkey && author !== viewerPubkey ? author : null,
        groupId,
    };
}
