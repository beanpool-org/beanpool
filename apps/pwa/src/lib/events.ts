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

// ===================== EDIT (docs/events-on-the-map.md §2.2, decision 29; events round 2) =====================

/**
 * Who is a host is the node's call: it sends the RSVP list (`eventRsvps`) to the author, a keeper of an
 * enterprise author and an active convenor of the group, and to nobody else — the same set it lets edit.
 */
export function isEventHostView(post: Pick<MarketplacePost, 'eventRsvps'>): boolean {
    return Array.isArray(post.eventRsvps);
}

/**
 * Why the host cannot edit this event, in words for the screen, or null while it can be edited. The node
 * refuses an edit to a cancelled or ended event; the page says so rather than offering a button that fails.
 */
export function eventEditBlockedReason(post: MarketplacePost, now = Date.now()): string | null {
    if (post.eventState === 'cancelled' || post.status === 'cancelled') return 'This event was cancelled, so it can no longer be edited.';
    const end = eventEndMs(post);
    if (Number.isFinite(end) && end <= now) return 'This event has ended, so it can no longer be edited.';
    return null;
}

/** The label on the chat button. No number: the going count next to "chat" read as unread messages. */
export const EVENT_CHAT_ENTRY_LABEL = 'Open event chat';

/** ISO UTC → a `<input type="datetime-local">` value in the viewer's local time ("2026-09-27T09:00"). */
export function isoToLocalInput(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What the edit form holds. Dates are datetime-local values; photos are the node's URLs or new data URLs. */
export interface EventEditForm {
    title: string;
    description: string;
    start: string;
    end: string;
    placeName: string;
    lat: number | null;
    lng: number | null;
    privateNote: string;
    photos: string[];
}

/** The form, filled from the event as it is now — every field the create form has. */
export function eventEditForm(post: MarketplacePost): EventEditForm {
    return {
        title: post.title || '',
        description: post.description || '',
        start: isoToLocalInput(post.eventStartAt),
        end: isoToLocalInput(post.eventEndAt),
        placeName: post.eventPlaceName || '',
        lat: post.lat ?? null,
        lng: post.lng ?? null,
        privateNote: post.eventPrivateNote || '',
        photos: Array.isArray(post.photos) ? post.photos : [],
    };
}

export interface EventEditPayload {
    title?: string;
    description?: string;
    eventStartAt?: string;
    eventEndAt?: string;
    eventPlaceName?: string;
    eventPrivateNote?: string;
    lat?: number;
    lng?: number;
    photos?: string[];
}

/**
 * Only what the host changed. A time or place change marks the event UPDATED and tells everyone going; other
 * edits are silent (decision 29). Sending only the changed fields means a title fix can never look like a
 * move: a datetime-local value drops seconds, so re-sending an unchanged start could differ from the stored
 * one and notify people about nothing.
 */
export function eventEditPayload(before: EventEditForm, after: EventEditForm): EventEditPayload {
    const out: EventEditPayload = {};
    if (after.title.trim() !== before.title.trim()) out.title = after.title.trim();
    if (after.description.trim() !== before.description.trim()) out.description = after.description.trim();
    if (after.start !== before.start) {
        const iso = localInputToIso(after.start);
        if (iso) out.eventStartAt = iso;
    }
    // A cleared end is sent as an empty string, which the node turns into start + 2 hours. When the start
    // moves, the end the form shows goes with it: the node keeps the old LENGTH when no end is named, so
    // moving 9:00–11:00 to 10:00 would otherwise save 10:00–12:00 while the form said 11:00.
    if (after.end !== before.end || (out.eventStartAt && after.end)) out.eventEndAt = localInputToIso(after.end) ?? '';
    if (after.placeName.trim() !== before.placeName.trim()) out.eventPlaceName = after.placeName.trim();
    if (after.privateNote.trim() !== before.privateNote.trim()) out.eventPrivateNote = after.privateNote.trim();
    if (after.lat != null && after.lng != null && (after.lat !== before.lat || after.lng !== before.lng)) {
        out.lat = after.lat;
        out.lng = after.lng;
    }
    if (after.photos.length !== before.photos.length || after.photos.some((p, i) => p !== before.photos[i])) out.photos = after.photos;
    return out;
}

/** True when a save would move the event in time or place, so the form can say who will be told. */
export function eventEditNotifies(payload: EventEditPayload): boolean {
    return payload.eventStartAt !== undefined || payload.eventEndAt !== undefined || payload.eventPlaceName !== undefined
        || payload.lat !== undefined || payload.lng !== undefined;
}

// ===================== THE FEED'S EVENTS FILTER (same behaviour as the phone, #895) =====================

/**
 * Under the Events pill the feed shows events only, soonest first, filtered by the map's date chips, and
 * nothing else filters it: category, distance, beans-only and new members are off screen there, and a filter
 * the member cannot see never hides a post (the phone's rule, apps/native/utils/market-filters.ts).
 */
export function eventsFeedFilter(posts: MarketplacePost[], window: EventWindow, now = Date.now()): MarketplacePost[] {
    return posts
        .filter(p => p.type === 'event' && !(p as any)._remoteNode && eventInWindow(p, window, now))
        .sort((a, b) => Date.parse(a.eventStartAt || '') - Date.parse(b.eventStartAt || ''));
}
