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

// ===================== COPY TO A NEW DATE (docs/events-on-the-map.md §3, decision 8, slice 5) =====================

/**
 * What "Copy to a new date" carries into NewEventModal. One-off events plus this is the whole of repeats in
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
 * `eventPrivateNote` reaches the phone only for the host and for people marked Going, so a copy made by
 * anyone else simply carries no note — there is nothing to leak here. Accepts a server row (camelCase) or the
 * phone's cached row (snake_case), because the event screen paints from the cache first.
 */
export function buildEventCopy(post: any, viewerPubkey?: string | null): EventCopy {
    const scope = post?.audienceScope ?? post?.audience_scope;
    const groupId = scope === 'group' ? (post?.targetGroupId ?? post?.target_group_id ?? null) : null;
    const author = post?.authorPublicKey ?? post?.author_pubkey ?? null;
    const num = (v: any) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    return {
        title: post?.title || '',
        description: post?.description || '',
        placeName: post?.eventPlaceName ?? post?.event_place_name ?? '',
        lat: num(post?.lat),
        lng: num(post?.lng),
        privateNote: post?.eventPrivateNote ?? post?.event_private_note ?? '',
        enterprisePubkey: !groupId && author && viewerPubkey && author !== viewerPubkey ? author : null,
        groupId,
    };
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

// ===================== EVENT CHAT (docs/events-on-the-map.md §2.2, §3, slice 4) =====================

export const EVENT_CHAT_MESSAGE_MAX = 2000;
export const EVENT_CHAT_REMOVED_TEXT = 'removed by the host';
/** The one line the chat carries: node-readable, not end-to-end encrypted (decision 25). */
export const EVENT_CHAT_NOTICE = "Visible to the host, everyone going, and this node's operator.";

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Event chat messages are stored base64 `plaintext-v1`, like the enterprise thread — the node can read
 * them, which is what lets membership follow RSVPs and a host remove a message.
 *
 * Decoded here rather than through utils/crypto, which pulls in expo-crypto: this file stays free of device
 * modules so vitest can hold it to the design. Hermes has no Buffer and no guaranteed atob.
 */
export function decodeEventChatText(ciphertext: string, type: string): string {
    if (type === 'removed') return EVENT_CHAT_REMOVED_TEXT;
    try {
        const clean = (ciphertext || '').replace(/[^A-Za-z0-9+/]/g, '');
        // indexOf('') is 0, so a missing character has to be spelled out as missing or the tail of a
        // padded string decodes to a stray NUL.
        const at = (i: number): number => (i < clean.length ? B64_ALPHABET.indexOf(clean[i]) : -1);
        const bytes: number[] = [];
        for (let i = 0; i < clean.length; i += 4) {
            const [a, b, c, d] = [at(i), at(i + 1), at(i + 2), at(i + 3)];
            if (a < 0 || b < 0) break;
            bytes.push((a << 2) | (b >> 4));
            if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
            if (c >= 0 && d >= 0) bytes.push(((c & 3) << 6) | d);
        }
        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (b < 128) {
                out += String.fromCharCode(b);
            } else if (b > 191 && b < 224) {
                out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63));
                i += 1;
            } else if (b > 223 && b < 240) {
                out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63));
                i += 2;
            } else {
                const cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
                out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 1023));
                i += 3;
            }
        }
        return out;
    } catch {
        return ciphertext;
    }
}

/** The outgoing side: the node takes plain text and stores it; this is only the client-side cap. */
export function trimEventChatDraft(text: string): string {
    return (text || '').trim().slice(0, EVENT_CHAT_MESSAGE_MAX);
}

/**
 * Whether to offer the chat on the event: the host, or someone marked Going. Who the host is stays the
 * node's call — the RSVP list is sent to hosts and to nobody else, so its presence is the signal (the same
 * test the host panel uses).
 */
export function canOpenEventChat(post: any): boolean {
    if (!post || post.type !== 'event') return false;
    if (Array.isArray(post.eventRsvps)) return true;
    return (post.myRsvp ?? null) === 'going';
}

/** "Open event chat (7)" — the going count when the node has given us one. */
export function eventChatEntryLabel(post: any): string {
    const going = Number(post?.goingCount ?? post?.event_going_count);
    return Number.isFinite(going) ? `Open event chat (${going})` : 'Open event chat';
}

/**
 * What the chat screen says instead of a composer. The node decides read-only and sends the line; this is
 * the same rule applied locally so the composer never appears for an event that has clearly finished.
 */
export function eventChatReadOnlyReason(post: any, nowMs: number = Date.now()): string | null {
    if (!post) return null;
    if (eventStateOf(post) === 'cancelled') return 'This event was cancelled. The chat is read-only.';
    if (isEventEnded(post, nowMs)) return 'This event has ended. The chat is read-only.';
    return null;
}
