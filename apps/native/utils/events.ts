/**
 * Events on the phone — the logic under the chooser row, NewEventModal, the feed card and the event detail
 * (docs/events-on-the-map.md §3, slice 3). No React Native imports, so vitest can hold it to the design.
 *
 * Times travel as ISO UTC and are shown in the phone's local time.
 */

export type EventRsvpStatus = 'going' | 'interested';
export type EventState = 'scheduled' | 'updated' | 'cancelled';

/**
 * Events are OPT-IN on `GET /api/marketplace/posts` (§2.6): a list request that does not name them never
 * receives one, which is what keeps every app already in the store blind to events. This app renders them,
 * so every list request it makes asks for them.
 */
export const POST_TYPES_WITH_EVENTS = 'offer,need,poll,event';
export const EVENT_TYPES_QUERY = `types=${POST_TYPES_WITH_EVENTS}`;

export const EVENT_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
export const EVENT_TITLE_MAX = 140;
export const EVENT_PLACE_NAME_MAX = 80;
export const EVENT_PRIVATE_NOTE_MAX = 1000;
export const EVENT_DESCRIPTION_MAX = 2000;

/** The pin warning enterprise pins use (PWA EnterpriseLocationPicker), worded for a gathering. */
export const EVENT_PIN_WARNING = "Anyone who opens this node's map will see this spot.";
export const EVENT_PIN_HINT = "Gatherings are often at someone's house. Use Approximate to round the location to roughly 100 m, and put the exact spot or gate code in the note for people who are going.";

/** Round to three decimals, ~100 m — the same rounding as @beanpool/core `approximateLocation`. */
export function approximatePin(lat: number, lng: number): { lat: number; lng: number } {
    return { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000 };
}

/** End time when the host leaves it blank: start + 2 hours (decision 32). */
export function defaultEventEnd(start: Date): Date {
    return new Date(start.getTime() + EVENT_DEFAULT_DURATION_MS);
}

export interface EventFormInput {
    title: string;
    description: string;
    start: Date | null;
    end: Date | null;
    placeName: string;
    lat: number | null;
    lng: number | null;
    privateNote: string;
    /** 'public' for this community, or a group id for group-only. */
    audienceGroupId: string | null;
    /** The member, or an enterprise pubkey the member keeps. */
    authorPubkey: string;
}

export interface EventPostDraft {
    type: 'event';
    category: 'community';
    title: string;
    description: string;
    credits: 0;
    price_type: 'fixed';
    author_pubkey: string;
    lat: number;
    lng: number;
    reach: 'local';
    eventStartAt: string;
    eventEndAt: string;
    eventPlaceName: string;
    eventPrivateNote?: string;
    audienceScope?: 'group';
    targetGroupId?: string;
}

/**
 * Check the form the way the server will (posts.ts event branch) and build the create payload, so a member
 * hears about a past start or a missing pin before a round trip on a poor network. `end` blank → start + 2 h.
 * Reach is always local in v1 (§2.4): the linked-communities option is not offered.
 */
export function buildEventDraft(input: EventFormInput, now: Date = new Date()):
    { ok: true; draft: EventPostDraft } | { ok: false; error: string } {
    const title = input.title.trim();
    if (!title) return { ok: false, error: 'Give the event a title.' };
    if (title.length > EVENT_TITLE_MAX) return { ok: false, error: `Keep the title under ${EVENT_TITLE_MAX} characters.` };
    if (!input.start) return { ok: false, error: 'Pick when the event starts.' };
    if (input.start.getTime() <= now.getTime()) return { ok: false, error: 'The start time has already passed. Pick a time in the future.' };
    const end = input.end ?? defaultEventEnd(input.start);
    if (end.getTime() <= input.start.getTime()) return { ok: false, error: 'The end time must be after the start.' };
    if (input.lat == null || input.lng == null || !Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
        return { ok: false, error: 'Put a pin on the map so people can find it.' };
    }
    const placeName = input.placeName.trim();
    if (!placeName) return { ok: false, error: 'Name the place, e.g. "The old bowls club".' };
    if (placeName.length > EVENT_PLACE_NAME_MAX) return { ok: false, error: `Keep the place name under ${EVENT_PLACE_NAME_MAX} characters.` };
    const note = input.privateNote.trim();
    if (note.length > EVENT_PRIVATE_NOTE_MAX) return { ok: false, error: `Keep the note under ${EVENT_PRIVATE_NOTE_MAX} characters.` };
    const description = input.description.trim();
    if (description.length > EVENT_DESCRIPTION_MAX) return { ok: false, error: `Keep the description under ${EVENT_DESCRIPTION_MAX} characters.` };

    const draft: EventPostDraft = {
        type: 'event',
        category: 'community',
        title,
        description,
        credits: 0,
        price_type: 'fixed',
        author_pubkey: input.authorPubkey,
        lat: input.lat,
        lng: input.lng,
        reach: 'local',
        eventStartAt: input.start.toISOString(),
        eventEndAt: end.toISOString(),
        eventPlaceName: placeName,
        ...(note ? { eventPrivateNote: note } : {}),
        ...(input.audienceGroupId ? { audienceScope: 'group' as const, targetGroupId: input.audienceGroupId } : {}),
    };
    return { ok: true, draft };
}

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dayLabel(d: Date): string {
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function timeLabel(d: Date): string {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The card's first line, local time: "SAT 27 SEP · 9:00–12:00", or across midnight
 * "SAT 27 SEP 22:00 – SUN 28 SEP 2:00".
 */
export function formatEventWhen(startIso: string | null | undefined, endIso?: string | null): string {
    if (!startIso) return '';
    const start = new Date(startIso);
    if (isNaN(start.getTime())) return '';
    const end = endIso ? new Date(endIso) : defaultEventEnd(start);
    if (isNaN(end.getTime())) return `${dayLabel(start)} · ${timeLabel(start)}`;
    const sameDay = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth() && start.getDate() === end.getDate();
    if (sameDay) return `${dayLabel(start)} · ${timeLabel(start)}–${timeLabel(end)}`;
    return `${dayLabel(start)} ${timeLabel(start)} – ${dayLabel(end)} ${timeLabel(end)}`;
}

/** A form row's value: "Sat 27 Sep, 9:00". */
export function formatPickerValue(d: Date | null): string {
    if (!d) return '';
    const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
    return `${title(DAYS[d.getDay()])} ${d.getDate()} ${title(MONTHS[d.getMonth()])}, ${timeLabel(d)}`;
}

export function eventEndMs(post: any): number {
    const end = post?.event_end_at ?? post?.eventEndAt;
    if (end) return Date.parse(end);
    const start = post?.event_start_at ?? post?.eventStartAt;
    return start ? Date.parse(start) + EVENT_DEFAULT_DURATION_MS : NaN;
}

export function eventStateOf(post: any): EventState {
    const s = post?.event_state ?? post?.eventState;
    if (post?.status === 'cancelled' || s === 'cancelled') return 'cancelled';
    return s === 'updated' ? 'updated' : 'scheduled';
}

export function isEventEnded(post: any, nowMs: number = Date.now()): boolean {
    const end = eventEndMs(post);
    return Number.isFinite(end) && end <= nowMs;
}

/**
 * Whether an event belongs in the Market feed. The sync pull carries ended and cancelled rows (it is a
 * replica of the list, not the list), so the phone applies the server's feed rule itself: an event leaves
 * the feed when it ends or is cancelled (§2.2).
 */
export function isEventInFeed(post: any, nowMs: number = Date.now()): boolean {
    if (post?.type !== 'event') return false;
    if (post.status !== 'active') return false;
    if (post.active === 0 || post.active === false) return false;
    if (eventStateOf(post) === 'cancelled') return false;
    return !isEventEnded(post, nowMs);
}

/** CANCELLED / UPDATED badge on the card's first line; nothing for a scheduled event. */
export function eventBadge(post: any): 'CANCELLED' | 'UPDATED' | null {
    const s = eventStateOf(post);
    if (s === 'cancelled') return 'CANCELLED';
    if (s === 'updated') return 'UPDATED';
    return null;
}

export interface RsvpCounts {
    going: number;
    interested: number;
    mine: EventRsvpStatus | null;
}

/**
 * Tapping the button you already hold clears it ("not going"); tapping the other one switches.
 * Returns the status to send.
 */
export function nextRsvp(current: EventRsvpStatus | null, tapped: EventRsvpStatus): EventRsvpStatus | null {
    return current === tapped ? null : tapped;
}

/** Optimistic counts for the card while the RSVP request is in flight. */
export function applyRsvp(counts: RsvpCounts, next: EventRsvpStatus | null): RsvpCounts {
    let { going, interested } = counts;
    if (counts.mine === 'going') going = Math.max(0, going - 1);
    if (counts.mine === 'interested') interested = Math.max(0, interested - 1);
    if (next === 'going') going += 1;
    if (next === 'interested') interested += 1;
    return { going, interested, mine: next };
}

export function formatRsvpCounts(going: number, interested: number): string {
    return `${going} going · ${interested} interested`;
}

export function formatDistance(km: number | null | undefined): string | null {
    if (km == null || !Number.isFinite(km)) return null;
    if (km < 1) return `${Math.max(10, Math.round(km * 1000 / 10) * 10)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
}

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The local cache columns for an event, from a server row (camelCase) or a local row (snake_case). Counts
 * are the public ones; the viewer's own RSVP and the private note are not cached here — the sync pull is
 * unsigned and never carries them.
 */
export function eventCacheColumns(p: any): [string | null, string | null, string | null, string | null, number, number] {
    if (p?.type !== 'event') return [null, null, null, null, 0, 0];
    return [
        p.event_start_at ?? p.eventStartAt ?? null,
        p.event_end_at ?? p.eventEndAt ?? null,
        p.event_place_name ?? p.eventPlaceName ?? null,
        p.event_state ?? p.eventState ?? 'scheduled',
        Number(p.event_going_count ?? p.goingCount ?? 0) || 0,
        Number(p.event_interested_count ?? p.interestedCount ?? 0) || 0,
    ];
}

/** The message the server checks an RSVP signature against (engine/posts.ts rsvpEvent). */
export function rsvpSignedMessage(postId: string, status: EventRsvpStatus | null): string {
    return `${postId}:${status ?? 'none'}`;
}
