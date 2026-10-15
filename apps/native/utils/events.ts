/**
 * Events on the phone — the logic under the chooser row, NewEventModal, the feed card and the event detail
 * (docs/events-on-the-map.md §3, slice 3). No React Native imports, so vitest can hold it to the design.
 *
 * Times travel as ISO UTC, and from a node with event times (DESIGN-event-times-fable.md, slice 3) also as the host's clock
 * and its zone. The phone never converts a time into another zone: the place's clock is the node's string, the reader's
 * is the Date getters, and @beanpool/core eventWhenParts turns the two into the card's lines.
 */

import {
    eventWhenParts, deviceLocalClock, zoneLabelFor, utcOffsetName, offsetMinutesOf, localClockMs, CURRENT_ZONE_IDS,
    LOCAL_CLOCK_RE, formatDate, t, tn, word, type EventWhenParts,
    repeatCaption, repeatChoiceKeyOf, repeatChoicesFor, repeatPatternFor, repeatUntilProblem, type RepeatChoiceKey, type RepeatPattern,
} from '@beanpool/core';

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

/**
 * A new pin from a tap, the host's location or an address. Where anyone can join in a minute (`features.openMembership`,
 * the global node) it starts Approximate, rounded to about 100 m, and the host can still choose the exact spot, kept as
 * `exact` (DESIGN-global-member-privacy-fable.md, director amendment 1 item 3; #1965). Elsewhere it is the spot, as always.
 */
export function freshEventPin(lat: number, lng: number, openMembership: boolean): { pin: { lat: number; lng: number }; approximate: boolean; exact: { lat: number; lng: number } } {
    const exact = { lat, lng };
    return openMembership ? { pin: approximatePin(lat, lng), approximate: true, exact } : { pin: exact, approximate: false, exact };
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
    /** Online: no pin and no place name, and a link to join (DESIGN-event-times §9). */
    online?: boolean;
    link?: string;
    /** The zone the Starts and Ends clocks are in (the pin's, the device's or a picked one); null while unknown. */
    tz?: string | null;
    /** That zone's offset now, in minutes, for the past check; null while unknown (the device's own clock is used). */
    tzOffsetMinutes?: number | null;
    /** "Only people I let in see the note and chat" (hostLetsInDefault for a new event). */
    hostLetsIn: boolean;
    /** How it repeats, a choice computed from the first date, and its last date ('' = until cancelled; DESIGN-event-times §8). */
    repeat?: RepeatChoiceKey;
    repeatUntil?: string;
}

export interface EventPostDraft {
    type: 'event';
    category: 'community';
    title: string;
    description: string;
    credits: 0;
    price_type: 'fixed';
    author_pubkey: string;
    lat?: number;
    lng?: number;
    reach: 'local';
    /** The instant, for a node from before event times; a node with them reads the clock below instead. */
    eventStartAt: string;
    eventEndAt: string;
    eventStartLocal?: string;
    eventEndLocal?: string;
    eventTz?: string;
    eventOnline?: true;
    eventLink?: string;
    eventPlaceName?: string;
    eventPrivateNote?: string;
    /** Always sent: the host's choice, never left to the node's default. */
    eventHostLetsIn: boolean;
    /** How it repeats (the pattern; the node adds the clock and length) and its last date. Absent on a one-off. */
    eventRepeat?: RepeatPattern;
    eventRepeatUntil?: string;
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
    const startLocal = deviceLocalClock(input.start);
    if (clockInstantMs(startLocal, input.tzOffsetMinutes, input.start) <= now.getTime()) return { ok: false, error: 'The start time has already passed. Pick a time in the future.' };
    const end = input.end ?? defaultEventEnd(input.start);
    if (end.getTime() <= input.start.getTime()) return { ok: false, error: 'The end time must be after the start.' };
    const online = input.online === true;
    let link: string | null = null;
    let placeName = '';
    if (online) {
        const checked = checkEventLink(input.link ?? '');
        if (!checked.ok) return checked;
        link = checked.link;
    } else {
        if (input.lat == null || input.lng == null || !Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
            return { ok: false, error: 'Put a pin on the map so people can find it.' };
        }
        placeName = input.placeName.trim();
        if (!placeName) return { ok: false, error: 'Name the place, e.g. "The old bowls club".' };
        if (placeName.length > EVENT_PLACE_NAME_MAX) return { ok: false, error: `Keep the place name under ${EVENT_PLACE_NAME_MAX} characters.` };
    }
    const note = input.privateNote.trim();
    if (note.length > EVENT_PRIVATE_NOTE_MAX) return { ok: false, error: `Keep the note under ${EVENT_PRIVATE_NOTE_MAX} characters.` };
    const description = input.description.trim();
    if (description.length > EVENT_DESCRIPTION_MAX) return { ok: false, error: `Keep the description under ${EVENT_DESCRIPTION_MAX} characters.` };
    const series = eventRepeatFields(input.repeat ?? 'never', input.repeatUntil ?? '', startLocal.slice(0, 10));
    if (!series.ok) return series;

    const draft: EventPostDraft = {
        type: 'event',
        category: 'community',
        title,
        description,
        credits: 0,
        price_type: 'fixed',
        author_pubkey: input.authorPubkey,
        ...(online ? {} : { lat: input.lat!, lng: input.lng! }),
        reach: 'local',
        eventStartAt: input.start.toISOString(),
        eventEndAt: end.toISOString(),
        // The clock the host picked. In person a node reads it at the pin when no zone goes with it; online it needs the
        // zone, so with none (a device that cannot name its own) only the instant goes and the node keeps it as UTC (§3).
        ...(!online || input.tz ? {
            eventStartLocal: startLocal,
            eventEndLocal: input.end ? deviceLocalClock(input.end) : addClockMinutes(startLocal, EVENT_DEFAULT_DURATION_MS / 60000),
        } : {}),
        ...(input.tz ? { eventTz: input.tz } : {}),
        ...(online ? { eventOnline: true as const, ...(link ? { eventLink: link } : {}) } : { eventPlaceName: placeName }),
        ...(note ? { eventPrivateNote: note } : {}),
        eventHostLetsIn: input.hostLetsIn,
        ...(series.pattern ? { eventRepeat: series.pattern, ...(input.repeatUntil ? { eventRepeatUntil: input.repeatUntil } : {}) } : {}),
        ...(input.audienceGroupId ? { audienceScope: 'group' as const, targetGroupId: input.audienceGroupId } : {}),
    };
    return { ok: true, draft };
}

/**
 * The Repeats and Until rows checked the way the node checks them (DESIGN-event-times §8): a choice the first date offers,
 * and an Until on or after it and at most five years out. The pattern is read on that date; null for "Does not repeat".
 */
export function eventRepeatFields(choice: RepeatChoiceKey, until: string, firstDate: string):
    { ok: true; pattern: RepeatPattern | null } | { ok: false; error: string } {
    if (choice === 'never') return { ok: true, pattern: null };
    const pattern = repeatChoicesFor(firstDate).some(c => c.key === choice) ? repeatPatternFor(choice, firstDate) : null;
    if (!pattern) return { ok: false, error: t('Choose how the event repeats from the list') };
    const problem = repeatUntilProblem(until, firstDate);
    return problem ? { ok: false, error: problem } : { ok: true, pattern };
}

// ===================== THE HOST LETS PEOPLE IN (scratch/global-node/DESIGN-global-member-privacy-fable.md §2) =====================

/** The node's refusal code for "Going, and the host hasn't let you in yet" (403 on the chat). */
export const EVENT_CHAT_WAITING_CODE = 'waiting_for_host';
/** The tickbox's label and the line under it. */
export const hostLetsInLabel = (): string => t('Only people I let in see the note and chat');
export const hostLetsInHint = (): string => t('Tick this if the note is your home address or a gate code.');
/** What the chat entry says, disabled, while the host hasn't let this member in. */
export const eventChatWaitingText = (): string => t('Chat opens when the host lets you in.');

/**
 * An edit from ticked to unticked opens the note and every chat line so far to everyone Going: the form says so before
 * saving (Marty, 15 Oct, board card privacy-global-calls; the #1953 review's N1). Never a hard gate.
 */
export function hostLetsInOffWarning(before: boolean, after: boolean): string | null {
    return before && !after ? t('Everyone going will see the note and the chat so far.') : null;
}

/** The node's system line when the host opens the chat to everyone going (server engine/event-thread.ts). */
export const EVENT_CHAT_OPENED_SYSTEM_TYPE = 'event_opened_to_going';

/** A system line in an event chat, in the reader's language where the app knows its kind; the node's text otherwise. */
export function eventChatSystemText(systemType: string | null | undefined, nodeText: string): string {
    return systemType === EVENT_CHAT_OPENED_SYSTEM_TYPE ? t('The host opened this chat to everyone going.') : nodeText;
}

/** A new event's tickbox: ticked where anyone can join in a minute (`features.openMembership`), unticked elsewhere. */
export function hostLetsInDefault(features: { openMembership?: boolean } | null | undefined): boolean {
    return features?.openMembership === true;
}

/** The words under the note, by the tickbox and the node (§2.3). */
export function privateNoteHelper(hostLetsIn: boolean, openMembership: boolean): string {
    if (hostLetsIn) {
        return openMembership
            ? t("Anyone can join this community in a minute. Only the people you let in will see this note and the event chat. You let people in from Who's going.")
            : t('Only the people you let in see this.');
    }
    return openMembership
        ? t('Everyone who taps Going sees this. Anyone can join this community in a minute.')
        : t('Everyone who taps Going sees this.');
}

/** Where a member stands on an event: 'open' where the host doesn't let people in (and for the host). */
export type EventLetInState = 'open' | 'before' | 'waiting' | 'in';

export function eventLetInState(post: any, isHost: boolean): EventLetInState {
    if (!post?.eventHostLetsIn || isHost) return 'open';
    if ((post.myRsvp ?? null) !== 'going') return 'before';
    return post.myLetIn ? 'in' : 'waiting';
}

/** The line the event shows a member who isn't let in yet; null otherwise. */
export function eventLetInLine(state: EventLetInState): string | null {
    if (state === 'before') return t('The host lets people in. Tap Going, and the note and the chat open once they do.');
    if (state === 'waiting') return t("You're going. The host hasn't let you in yet: the note and the chat open when they do.");
    return null;
}

/** Going and not let in, from the host's RSVP list. */
export function eventWaitingCount(rsvps: any[] | null | undefined): number {
    if (!Array.isArray(rsvps)) return 0;
    return rsvps.filter(r => r?.status === 'going' && !r?.letInAt).length;
}

export function eventWaitingLine(n: number): string {
    return tn(n, '{n} waiting to be let in', '{n} waiting to be let in');
}

/** The host's Let in button, read aloud: whom it lets in, or that a tap takes it back. */
export function letInButtonLabel(letIn: boolean, name: string | null | undefined): string {
    if (name) return letIn ? t('Let in. Tap to take it back from {name}', { name }) : t('Let {name} in', { name });
    return letIn ? t('Let in. Tap to take it back') : t('Let them in');
}

export function letEveryoneInQuestion(n: number): string {
    return tn(n, 'Let {n} in? People who tap Going later still wait.', 'Let all {n} in? People who tap Going later still wait.');
}

/** Whether a node refusal is "you're going, the host hasn't let you in" — never shown as "only the host and people going". */
export function isWaitingForHost(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: unknown }).code === EVENT_CHAT_WAITING_CODE;
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
    /** An online event copies as online, with its link when the copier may see it (event times, §9). */
    online: boolean;
    link: string;
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
        online: isOnlineEvent(post),
        link: post?.eventLink ?? '',
    };
}

function dayLabel(d: Date): string {
    return formatDate(d, 'weekday-day-month', { caps: true });
}

function timeLabel(d: Date): string {
    return formatDate(d, 'time');
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
    return `${formatDate(d, 'weekday-day-month')}, ${timeLabel(d)}`;
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

// ===================== THE MAP'S DATE CHIPS (docs/events-on-the-map.md §3) =====================

/**
 * The windows the map's date chips cover, same as the web map's. They appear only while the Events pill is
 * on, which is what keeps the filter row short at 320dp + 1.3x text.
 */
export type EventWindow = 'all' | 'today' | 'weekend' | 'week';

export const EVENT_WINDOWS: ReadonlyArray<{ id: EventWindow; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'today', label: 'Today' },
    { id: 'weekend', label: 'This weekend' },
    { id: 'week', label: 'Next 7 days' },
] as const;

function startOfLocalDay(ms: number): Date {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * The [from, to) span a chip covers, in local time. Today runs to midnight; This weekend is Saturday 00:00
 * to Monday 00:00 of this week (the current one on a Saturday or Sunday); Next 7 days is now plus seven
 * days. Mirrors the web app's `eventWindowRange` so the same event lands under the same chip on both.
 */
export function eventWindowRange(window: EventWindow, nowMs: number = Date.now()): { from: number; to: number } {
    const today = startOfLocalDay(nowMs);
    if (window === 'today') {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return { from: nowMs, to: tomorrow.getTime() };
    }
    if (window === 'weekend') {
        const dow = today.getDay(); // 0 Sunday … 6 Saturday
        const saturday = new Date(today);
        saturday.setDate(today.getDate() + (dow === 0 ? -1 : 6 - dow));
        const monday = new Date(saturday);
        monday.setDate(saturday.getDate() + 2);
        return { from: Math.max(nowMs, saturday.getTime()), to: monday.getTime() };
    }
    if (window === 'week') {
        return { from: nowMs, to: nowMs + 7 * 24 * 60 * 60 * 1000 };
    }
    return { from: nowMs, to: Number.POSITIVE_INFINITY };
}

/**
 * Whether an event belongs on the map under a chip: it is still in the feed at all — an event that has
 * ended or been cancelled never pins (§2.2) — and it overlaps the chip's span.
 */
export function eventInWindow(post: any, window: EventWindow, nowMs: number = Date.now()): boolean {
    if (!isEventInFeed(post, nowMs)) return false;
    const startIso = post?.event_start_at ?? post?.eventStartAt;
    const start = startIso ? Date.parse(startIso) : NaN;
    if (!Number.isFinite(start)) return false;
    const { from, to } = eventWindowRange(window, nowMs);
    return start < to && eventEndMs(post) > from;
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
 *
 * The host's clock, its zone and online ride along (DESIGN-event-times amendment 1, item 3), so the card reads right from the
 * cache. The join link does not: it is served like the private note, to the host and Going only.
 */
export function eventCacheColumns(p: any): [string | null, string | null, string | null, string | null, number, number, string | null, string | null, string | null, number | null, string | null, string | null] {
    if (p?.type !== 'event') return [null, null, null, null, 0, 0, null, null, null, null, null, null];
    const series = eventRepeatOf(p);
    const online = p.event_online ?? p.eventOnline;
    return [
        p.event_start_at ?? p.eventStartAt ?? null,
        p.event_end_at ?? p.eventEndAt ?? null,
        p.event_place_name ?? p.eventPlaceName ?? null,
        p.event_state ?? p.eventState ?? 'scheduled',
        Number(p.event_going_count ?? p.goingCount ?? 0) || 0,
        Number(p.event_interested_count ?? p.interestedCount ?? 0) || 0,
        p.event_start_local ?? p.eventStartLocal ?? null,
        p.event_end_local ?? p.eventEndLocal ?? null,
        p.event_tz ?? p.eventTz ?? null,
        online == null ? null : (online === true || online === 1 ? 1 : 0),
        // A repeating event's pattern and last date (DESIGN-event-times §8), so the cached card shows its ↻ caption.
        series.rule ? JSON.stringify(series.rule) : null,
        series.until,
    ];
}

/**
 * A repeating event's rule and last date, from the node's row (camelCase `eventRepeat`) or the cache's (snake_case
 * `event_repeat`, JSON text). The pattern only: the host's clock and each date's length are the node's.
 */
export function eventRepeatOf(p: any): { rule: RepeatPattern | null; until: string | null } {
    let raw = p?.eventRepeat ?? p?.event_repeat ?? null;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    const until = (p?.eventRepeatUntil ?? p?.event_repeat_until ?? null) as string | null;
    if (!raw || typeof raw !== 'object' || (raw.freq !== 'weekly' && raw.freq !== 'monthly')) return { rule: null, until: null };
    const { freq, interval, byDay, byMonthDay, pos } = raw;
    const rule = { freq, interval, ...(byDay ? { byDay } : {}), ...(byMonthDay != null ? { byMonthDay } : {}), ...(pos != null ? { pos } : {}) } as RepeatPattern;
    return { rule, until: typeof until === 'string' && until ? until : null };
}

/** The ↻ caption beside a repeating event's date ("Every Friday · until 18 Dec"); '' for a one-off. */
export function eventRepeatCaption(p: any): string {
    const { rule, until } = eventRepeatOf(p);
    return repeatCaption(rule, until);
}

/**
 * The photo the feed card shows: the event's first one, or nothing.
 *
 * A post reaches the card with `photos` already parsed and already resolved against the anchor — db.ts
 * `getPosts` and the server-search path in the Market screen both do that for every post they hand back, so
 * an event's photo arrives absolute exactly as an offer's does, and there is no second resolver here. What is
 * left is the card's own decision, which is the part that can go wrong: a row may still carry the raw JSON
 * string (an unparsed cache row), an empty list, or one of the string placeholders SQLite hands back for a
 * missing value, and none of those is a picture.
 */
export function eventCoverPhoto(post: any): string | null {
    let photos: unknown = post?.photos;
    if (typeof photos === 'string') {
        try { photos = JSON.parse(photos); } catch { return null; }
    }
    if (!Array.isArray(photos) || photos.length === 0) return null;
    const first = photos[0];
    if (typeof first !== 'string') return null;
    const url = first.trim();
    if (!url || url === 'null' || url === 'undefined') return null;
    return url;
}

/** The message the server checks an RSVP signature against (engine/posts.ts rsvpEvent). */
export function rsvpSignedMessage(postId: string, status: EventRsvpStatus | null): string {
    return `${postId}:${status ?? 'none'}`;
}

/**
 * A post id in the shape the node issues them: a UUID (engine/posts.ts createPost, `crypto.randomUUID()`; this app
 * and the web app send one of their own the same shape, or none).
 */
const POST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the app may sign an RSVP for `postId` (utils/db.ts rsvpEvent). The signature is over plain UTF-8,
 * `postId:status`, and the id comes from the node. So the id must be a UUID and the status going, interested or
 * none (null). That leaves one line with one colon, so never a request in the old format. It can match a poll vote's
 * `postId:optionId`, but both routes take the member from the request signature, never from this one. Anything else
 * is refused before anything is signed.
 */
export function isSignableRsvp(postId: unknown, status: unknown): boolean {
    return typeof postId === 'string' && POST_ID_RE.test(postId)
        && (status === null || status === 'going' || status === 'interested');
}

/** Why an RSVP wasn't sent. Shown as is. */
export const UNSIGNABLE_RSVP_MESSAGE =
    "This event's id isn't one BeanPool recognises, so your answer wasn't signed or sent.";

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
    // Where the host lets people in, Going opens it only once they have (the entry shows eventChatWaitingText).
    if (post.eventHostLetsIn && post.myLetIn === false) return false;
    return (post.myRsvp ?? null) === 'going';
}

/**
 * The chat button's label. No number: "Open event chat (1)" showed the going count, which read as one unread
 * message in a chat that had none (events round 2, B3).
 */
export function eventChatEntryLabel(_post?: any): string {
    return 'Open event chat';
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

// ===================== THE HOST, AND EDITING (events round 2, decision 29) =====================

/**
 * Whether the node treats this viewer as a host: it sends the RSVP list to the author, a keeper of an
 * enterprise author and an active convenor of the group, and to nobody else — the same set it lets edit.
 */
export function isEventHostView(post: any): boolean {
    return Array.isArray(post?.eventRsvps);
}

/**
 * The feed card has only the cached row, which carries no RSVP list, so there the host is the author. A
 * keeper or convenor who did not post it still sees the buttons on the card; the event page asks the node.
 */
export function isOwnEvent(post: any, viewerPubkey?: string | null): boolean {
    if (!viewerPubkey || post?.type !== 'event') return false;
    return (post.author_pubkey ?? post.authorPublicKey) === viewerPubkey;
}

/** Why the host cannot edit this event, for the screen; null while it can be. The node refuses both. */
export function eventEditBlockedReason(post: any, nowMs: number = Date.now()): string | null {
    if (eventStateOf(post) === 'cancelled') return 'This event was cancelled, so it can no longer be edited.';
    if (isEventEnded(post, nowMs)) return 'This event has ended, so it can no longer be edited.';
    return null;
}

/** What NewEventModal holds in edit mode. */
export interface EventEditValues {
    title: string;
    description: string;
    start: Date | null;
    end: Date | null;
    placeName: string;
    lat: number | null;
    lng: number | null;
    privateNote: string;
    /** The node's photo URL, a new data URL, or null for none. */
    photo: string | null;
    online?: boolean;
    link?: string;
    /** The zone the clocks above are in; null for an event from a node before zones (the device's clock, as before). */
    tz?: string | null;
    tzOffsetMinutes?: number | null;
    /** "Only people I let in see the note and chat". */
    hostLetsIn: boolean;
    /** How it repeats and its last date ('' = until cancelled). */
    repeat?: RepeatChoiceKey;
    repeatUntil?: string;
}

/** The form, filled from the node's view of the event (camelCase) or the cached row (snake_case). */
export function eventEditValues(post: any): EventEditValues {
    const date = (v: any) => { const d = v ? new Date(v) : null; return d && !isNaN(d.getTime()) ? d : null; };
    const num = (v: any) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    let photos: any = post?.photos;
    if (typeof photos === 'string') { try { photos = JSON.parse(photos); } catch { photos = []; } }
    // The pickers show the host's clock: a Date whose getters read the place's "20:50", wherever this phone is (§2 Edit).
    const f = eventTimeFields(post);
    const clock = (local: string | null, iso: string | null) => (f.tz ? clockDate(local) : null) ?? date(iso);
    const offset = offsetMinutesOf(f.startLocal, f.startAt);
    return {
        title: post?.title || '',
        description: post?.description || '',
        start: clock(f.startLocal, f.startAt),
        end: clock(f.endLocal, f.endAt),
        placeName: post?.eventPlaceName ?? post?.event_place_name ?? '',
        lat: num(post?.lat),
        lng: num(post?.lng),
        privateNote: post?.eventPrivateNote ?? '',
        photo: Array.isArray(photos) && typeof photos[0] === 'string' && photos[0] ? photos[0] : null,
        online: f.online,
        link: post?.eventLink ?? '',
        tz: f.tz,
        tzOffsetMinutes: f.tz && Number.isFinite(offset) ? offset : null,
        hostLetsIn: post?.eventHostLetsIn === true,
        repeat: repeatChoiceKeyOf(eventRepeatOf(post).rule),
        repeatUntil: eventRepeatOf(post).until ?? '',
    };
}

export interface EventEditPatch {
    title?: string;
    description?: string;
    eventStartAt?: string;
    eventEndAt?: string;
    eventStartLocal?: string;
    eventEndLocal?: string;
    eventTz?: string;
    eventOnline?: boolean;
    eventLink?: string;
    eventPlaceName?: string;
    eventPrivateNote?: string;
    lat?: number;
    lng?: number;
    photos?: string[];
    eventHostLetsIn?: boolean;
    eventRepeat?: RepeatPattern | null;
    eventRepeatUntil?: string | null;
}

/**
 * Check an edit the way the node will and build the update: ONLY the fields that changed. A title, description,
 * note or photo edit is silent; a change of time or place marks the event UPDATED and tells everyone going
 * (decision 29), and `notifies` says so before the host saves. A start the host did not touch is not
 * re-checked against the clock, so the note of an event already under way can still be fixed.
 */
export function buildEventEditPatch(before: EventEditValues, after: EventEditValues, now: Date = new Date()):
    { ok: true; patch: EventEditPatch; notifies: boolean } | { ok: false; error: string } {
    const title = after.title.trim();
    if (!title) return { ok: false, error: 'Give the event a title.' };
    if (title.length > EVENT_TITLE_MAX) return { ok: false, error: `Keep the title under ${EVENT_TITLE_MAX} characters.` };
    if (!after.start) return { ok: false, error: 'Pick when the event starts.' };
    const startMoved = !before.start || after.start.getTime() !== before.start.getTime();
    const startLocal = deviceLocalClock(after.start);
    if (startMoved && clockInstantMs(startLocal, after.tzOffsetMinutes, after.start) <= now.getTime()) return { ok: false, error: 'The start time has already passed. Pick a time in the future.' };
    const end = after.end ?? defaultEventEnd(after.start);
    if (end.getTime() <= after.start.getTime()) return { ok: false, error: 'The end time must be after the start.' };
    const online = after.online === true;
    let link = '';
    if (online) {
        const checked = checkEventLink(after.link ?? '');
        if (!checked.ok) return checked;
        link = checked.link ?? '';
    } else if (after.lat == null || after.lng == null || !Number.isFinite(after.lat) || !Number.isFinite(after.lng)) {
        return { ok: false, error: 'Put a pin on the map so people can find it.' };
    }
    const placeName = online ? '' : after.placeName.trim();
    if (!online && !placeName) return { ok: false, error: 'Name the place, e.g. "The old bowls club".' };
    if (placeName.length > EVENT_PLACE_NAME_MAX) return { ok: false, error: `Keep the place name under ${EVENT_PLACE_NAME_MAX} characters.` };
    const note = after.privateNote.trim();
    if (note.length > EVENT_PRIVATE_NOTE_MAX) return { ok: false, error: `Keep the note under ${EVENT_PRIVATE_NOTE_MAX} characters.` };
    const description = after.description.trim();
    if (description.length > EVENT_DESCRIPTION_MAX) return { ok: false, error: `Keep the description under ${EVENT_DESCRIPTION_MAX} characters.` };

    const patch: EventEditPatch = {};
    if (title !== before.title.trim()) patch.title = title;
    if (description !== before.description.trim()) patch.description = description;
    // The clock goes with the instant whenever a zone is known: a node with event times reads the clock (in the zone the
    // event has, or the one sent below), and one from before them reads the instant.
    const clocks = !!(after.tz ?? before.tz);
    if (startMoved) {
        patch.eventStartAt = after.start.toISOString();
        if (clocks) patch.eventStartLocal = startLocal;
    }
    const endBefore = before.end?.getTime() ?? null;
    const endAfter = after.end?.getTime() ?? null;
    // A cleared end goes as '', which the node turns into start + 2 hours. When the start moves, the end the
    // form shows goes with it: the node keeps the old LENGTH when no end is named, so moving 9:00–11:00 to
    // 10:00 would otherwise save 10:00–12:00 while the form said 11:00.
    if (endAfter !== endBefore || (startMoved && after.end)) {
        patch.eventEndAt = after.end ? after.end.toISOString() : '';
        if (clocks) patch.eventEndLocal = after.end ? deviceLocalClock(after.end) : '';
    }
    if (after.tz && after.tz !== before.tz) patch.eventTz = after.tz;
    if (online !== (before.online === true)) patch.eventOnline = online;
    if (online && (patch.eventOnline !== undefined || link !== (before.link ?? '').trim())) patch.eventLink = link;
    if (!online && placeName !== before.placeName.trim()) patch.eventPlaceName = placeName;
    if (note !== before.privateNote.trim()) patch.eventPrivateNote = note;
    if (!online && (after.lat !== before.lat || after.lng !== before.lng)) { patch.lat = after.lat!; patch.lng = after.lng!; }
    if (after.photo !== before.photo) patch.photos = after.photo ? [after.photo] : [];
    // Silent like the note: who reads the note is the host's to change.
    if (after.hostLetsIn !== before.hostLetsIn) patch.eventHostLetsIn = after.hostLetsIn;
    // The series (§8 Edit), as the web app sends it: the choice read on the NEW first date (a series moved from a Friday to a
    // Saturday goes as every Saturday, which is what the list then says), sent when the choice or the first date changed.
    const was = before.repeat ?? 'never';
    const now2 = after.repeat ?? 'never';
    const firstDate = startLocal.slice(0, 10);
    const dateMoved = !before.start || deviceLocalClock(before.start).slice(0, 10) !== firstDate;
    if (now2 !== was || (now2 !== 'never' && dateMoved)) {
        const series = eventRepeatFields(now2, after.repeatUntil ?? '', firstDate);
        if (!series.ok) return series;
        patch.eventRepeat = series.pattern;
    } else if (now2 !== 'never') {
        const problem = repeatUntilProblem(after.repeatUntil ?? '', firstDate);
        if (problem) return { ok: false, error: problem };
    }
    if (now2 !== 'never' && (after.repeatUntil ?? '') !== (before.repeatUntil ?? '')) patch.eventRepeatUntil = after.repeatUntil || null;
    const notifies = patch.eventStartAt !== undefined || patch.eventEndAt !== undefined || patch.eventPlaceName !== undefined
        || patch.lat !== undefined || patch.eventTz !== undefined || patch.eventOnline !== undefined;
    return { ok: true, patch, notifies };
}

// ===================== THE MAP'S PIN CARD (events round 2, B1) =====================

/**
 * What the map shows when an event pin is tapped. An event is not a listing: no category, no bean amount.
 * Date and time first, then the title, the place and how many are going (decision 19's card order).
 */
export interface EventPinCard {
    when: string;
    badge: 'CANCELLED' | 'UPDATED' | null;
    title: string;
    place: string | null;
    going: string;
}

export function eventPinCard(post: any): EventPinCard {
    const going = Number(post?.goingCount ?? post?.event_going_count ?? 0) || 0;
    const place = (post?.eventPlaceName ?? post?.event_place_name ?? '').trim();
    // The pin card is one line of time (map.tsx is protected, so no second line): when the place's clock is not the
    // reader's, it carries the place's zone, so it is never read as the reader's own.
    const parts = eventWhen(post);
    const zone = parts?.note ? parts.note.slice(0, parts.note.indexOf(' · ')) : null;
    // A repeating event's ↻ caption follows the time (DESIGN-event-times §8): last, so a line that runs out of room at 320 dp
    // and 1.3× text cuts the caption, never the time.
    const repeats = eventRepeatCaption(post);
    return {
        when: `${formatEventWhenFor(post)}${zone ? ` · ${zone}` : ''}${repeats ? ` · ↻ ${repeats}` : ''}`,
        badge: eventBadge(post),
        title: post?.title || 'Event',
        place: place || null,
        going: `${going} going`,
    };
}

// ===================== EVENT TIMES: ZONES AND ONLINE (DESIGN-event-times-fable.md §3, §4, §9, slice 3) =====================

export const EVENT_LINK_MAX = 500;

/** Sentences shown from more than one place: marked here, translated where shown (`t(EVENT_TIME_WORDS.linkHint)`). */
export const EVENT_TIME_WORDS = {
    linkHint: word('Link to join · only people who tap Going see it'),
    /** Where the host lets people in, the link waits for them as the note does (engine eventPrivateOpenTo, #1953). */
    linkHintLetIn: word('Link to join · only the people you let in see it'),
    /** The zone line when an online event's zone is not known: the device could not name its own (§3, §7 item 7). */
    zonePrompt: word('Pick the time zone these times are in'),
} as const;

/** One row of the node's `GET /api/events/zone` and of `GET /api/events/zones`. */
export interface EventZone {
    tz: string;
    label: string;
    offsetMinutes: number;
}

/** Where the form's zone came from: the pin's lookup, this phone, or the picker. */
export type EventZoneSource = 'pin' | 'device' | 'picked';

/** Online, from a node row (true) or the cached one (1). */
export function isOnlineEvent(post: any): boolean {
    const v = post?.eventOnline ?? post?.event_online;
    return v === true || v === 1 || v === '1';
}

/** The time fields of an event, from a server row (camelCase) or a cached one (snake_case). */
function eventTimeFields(post: any) {
    return {
        startAt: (post?.eventStartAt ?? post?.event_start_at ?? null) as string | null,
        endAt: (post?.eventEndAt ?? post?.event_end_at ?? null) as string | null,
        startLocal: (post?.eventStartLocal ?? post?.event_start_local ?? null) as string | null,
        endLocal: (post?.eventEndLocal ?? post?.event_end_local ?? null) as string | null,
        tz: (post?.eventTz ?? post?.event_tz ?? null) as string | null,
        online: isOnlineEvent(post),
    };
}

/** A clock as a Date whose getters read it on this phone ("20:50" stays 20:50), or null when it is not a clock. */
function clockDate(local: string | null | undefined): Date | null {
    const m = local ? LOCAL_CLOCK_RE.exec(local) : null;
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return isNaN(d.getTime()) ? null : d;
}

/** The instant of a clock in a zone whose offset is known; else the device's own reading of the picked Date. */
function clockInstantMs(local: string, offsetMinutes: number | null | undefined, picked: Date): number {
    return offsetMinutes != null && Number.isFinite(offsetMinutes) ? localClockMs(local) - offsetMinutes * 60000 : picked.getTime();
}

/** A clock moved on by minutes on the clock itself: "2026-10-17T20:50" + 120 → "2026-10-17T22:50". */
function addClockMinutes(local: string, minutes: number): string {
    const d = new Date(localClockMs(local) + minutes * 60000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * The join link, checked as the node checks it (engine/posts.ts cleanEventLink, compared on 28 links in the #1946 review)
 * so the host hears before a round trip: http(s) only, a host, no space in it, no user name or password
 * (`https://zoom.us@evil.example`; a backslash ends the host, as a URL parser reads it), and at most 500 characters once
 * each space is written `%20`. Blank is allowed. No URL parser: React Native's URL has no `username`.
 */
export function checkEventLink(raw: string): { ok: true; link: string | null } | { ok: false; error: string } {
    const v = (raw || '').trim();
    if (!v) return { ok: true, link: null };
    const notALink = { ok: false as const, error: t('The link to join must start with https:// or http://') };
    if (!/^https?:\/\//i.test(v)) return notALink;
    // A parser skips extra slashes after the scheme (`https:///x` is host x) and ends the host at / ? # or \.
    const authority = v.replace(/^https?:\/\/[/\\]*/i, '').split(/[/?#\\]/)[0];
    if (!authority || /\s/.test(authority)) return notALink;
    if (v.replace(/ /g, '%20').length > EVENT_LINK_MAX) return { ok: false, error: t('Keep the link to join under {max} characters.', { max: EVENT_LINK_MAX }) };
    if (authority.includes('@')) return { ok: false, error: t('The link to join must not hold a user name or password') };
    return { ok: true, link: v };
}

/**
 * The card's lines (§4) for an event, from either row shape: the place's clock first for an event in person, the
 * reader's own for an online one ("your time"). An event from a node before zones reads in device time, as before.
 */
export function eventWhen(post: any): EventWhenParts | null {
    const f = eventTimeFields(post);
    const start = f.startAt ? new Date(f.startAt) : null;
    if (!start || isNaN(start.getTime())) return null;
    const end = f.endAt ? new Date(f.endAt) : defaultEventEnd(start);
    return eventWhenParts({
        startAt: f.startAt, endAt: f.endAt, startLocal: f.startLocal, endLocal: f.endLocal, tz: f.tz, online: f.online,
        deviceStart: deviceLocalClock(start),
        deviceEnd: isNaN(end.getTime()) ? null : deviceLocalClock(end),
    });
}

/** The first line as one string, "SAT 17 OCT · 20:50–22:50"; '' when the event has no readable start. */
export function formatEventWhenFor(post: any): string {
    const p = eventWhen(post);
    return p ? `${p.first}${p.sep}${p.second}` : '';
}

/**
 * A zone that names no place (`UTC`, `Etc/GMT-1`): the node's last resort for an online event saved with no zone (§2),
 * so "for the host (UTC time)" would be a claim about the host nobody made.
 */
export function zoneIsNotAPlace(tz: string | null | undefined): boolean {
    return !tz || tz === 'UTC' || tz.startsWith('Etc/');
}

/** The detail's host line, "20:50 for the host (Sydney time)": only when the event's zone is a place (#1946 finding 4). */
export function eventHostLine(post: any): string | null {
    const line = eventWhen(post)?.hostLine ?? null;
    return line && !zoneIsNotAPlace(eventTimeFields(post).tz) ? line : null;
}

/** The card's place line: "Online" for an online event, else the place name and the distance. */
export function eventPlaceLine(post: any, distance: string | null): string {
    if (isOnlineEvent(post)) return t('Online');
    const placeName = post?.event_place_name ?? post?.eventPlaceName ?? '';
    return [placeName, distance].filter(Boolean).join(' · ');
}

/** A clock's date read as written (the words layer's tables, never Intl): "Sat 17 Oct", "17 Oct". */
function clockDay(local: string): string {
    return formatDate(new Date(localClockMs(local)), 'weekday-day-month', { utc: true });
}

function clockDayMonth(local: string): string {
    return formatDate(new Date(localClockMs(local)), 'day-month', { utc: true });
}

function clockTime(local: string): string {
    return formatDate(new Date(localClockMs(local)), 'time', { utc: true });
}

/**
 * The share text's time, labelled so it is right outside the app (§4): "Sat 17 Oct, 20:50 Lagos time", online "Fri 16 Oct,
 * 20:50 Sydney time (online)". From a node before zones, the form's way of writing the phone's own clock, "Sat 17 Oct,
 * 15:50", with no label.
 */
export function eventShareWhen(post: any): string {
    const f = eventTimeFields(post);
    if (f.startLocal && f.tz && LOCAL_CLOCK_RE.test(f.startLocal)) {
        const values = { day: clockDay(f.startLocal), time: clockTime(f.startLocal), zone: zoneLabelFor(f.tz, offsetMinutesOf(f.startLocal, f.startAt)) };
        return f.online ? t('{day}, {time} {zone} (online)', values) : t('{day}, {time} {zone}', values);
    }
    const start = f.startAt ? new Date(f.startAt) : null;
    if (!start || isNaN(start.getTime())) return '';
    const when = formatPickerValue(start);
    return f.online ? t('{when} (online)', { when }) : when;
}

/**
 * Home's "Coming up" date (§4). From a node that sends the event's clock: "Fri 16 Oct, 20:50", with the place's zone when
 * its clock is not the reader's ("Sat 17 Oct, 20:50 Lagos time"); online, the reader's own ("Fri 16 Oct, 5:50 your
 * time"). From a node that does not, the day only, as before. Reads `startLocal`, `tz` and `online` off the Home answer.
 */
export function eventHomeWhen(item: { startsAt: string; startLocal?: string | null; tz?: string | null; online?: boolean | null }): string {
    const start = new Date(item.startsAt);
    if (isNaN(start.getTime())) return '';
    const device = deviceLocalClock(start);
    if (item.online) return t('{day}, {time} your time', { day: clockDay(device), time: clockTime(device) });
    if (!item.startLocal || !item.tz || !LOCAL_CLOCK_RE.test(item.startLocal)) return clockDay(device);
    if (item.startLocal === device) return t('{day}, {time}', { day: clockDay(device), time: clockTime(device) });
    const zone = zoneLabelFor(item.tz, offsetMinutesOf(item.startLocal, item.startsAt));
    return t('{day}, {time} {zone}', { day: clockDay(item.startLocal), time: clockTime(item.startLocal), zone });
}

/** A zone id spelled the current way (Europe/Kiev → Europe/Kyiv), as the node stores it. */
export function currentZoneId(tz: string): string {
    return CURRENT_ZONE_IDS[tz] ?? tz;
}

/** Whether two zone ids are the same zone, however each is spelled. */
export function sameZone(a: string | null | undefined, b: string | null | undefined): boolean {
    return !!a && !!b && currentZoneId(a) === currentZoneId(b);
}

const ZONE_ID_RE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+)$/;

/**
 * This phone's zone: the ONE Intl call the phone makes (§7 item 7), `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 * Hermes on Android answers it from android.icu; anything that is not an IANA id (missing, empty, "GMT+10:00", a throw)
 * is null, and the form then asks for a zone instead of guessing one. No zone arithmetic ever runs here.
 */
export function deviceTimeZone(intl: any = (globalThis as any).Intl): string | null {
    try {
        const tz = intl?.DateTimeFormat?.().resolvedOptions?.().timeZone;
        return typeof tz === 'string' && ZONE_ID_RE.test(tz) ? currentZoneId(tz) : null;
    } catch {
        return null;
    }
}

/**
 * The zone line as the form draws it: the words before the zone, the zone (in bold), the words after. One translated
 * sentence, split where the zone goes, so a language may put the zone anywhere in it.
 */
export type EventZoneLine = { before: string; zone: string; after: string; text: string } | { prompt: string };

const ZONE_MARK = '\u0001';

/**
 * The muted line under Starts and Ends (§3). In person it shows only when the times are not the phone's own zone (every
 * ordinary local-node case shows nothing); online it always shows, because the zone anchors the clock.
 * "Times are **Lagos time** (where the pin is) · Change"; after the pin moves, "Times are now **Accra time** (where the pin is)".
 */
export function eventZoneLine(s: {
    online: boolean; tz: string | null; source: EventZoneSource | null; deviceTz: string | null; offsetMinutes: number | null; moved?: boolean;
}): EventZoneLine | null {
    if (!s.tz) return s.online ? { prompt: t(EVENT_TIME_WORDS.zonePrompt) } : null;
    if (!s.online && s.source !== 'picked' && sameZone(s.tz, s.deviceTz)) return null;
    const zone = zoneLabelFor(s.tz, s.offsetMinutes ?? NaN);
    const values = { zone: ZONE_MARK };
    const sentence = s.source === 'pin'
        ? (s.moved ? t('Times are now {zone} (where the pin is)', values) : t('Times are {zone} (where the pin is)', values))
        : s.source === 'device' ? t('Times are {zone} (your device)', values) : t('Times are {zone}', values);
    const at = sentence.indexOf(ZONE_MARK);
    const before = at < 0 ? sentence : sentence.slice(0, at);
    const after = at < 0 ? '' : sentence.slice(at + ZONE_MARK.length);
    return { before, zone, after, text: `${before}${zone}${after}` };
}

/** A picker row: "Lagos (UTC+1)", "Kolkata (UTC+5:30)"; a zone that is not a place reads as its offset, "UTC+1". */
export function zonePickerEntry(z: EventZone): string {
    const place = z.label.replace(/ time$/, '');
    const offset = utcOffsetName(z.offsetMinutes);
    return place === offset ? place : t('{place} ({offset})', { place, offset });
}

/** The picker's search box: the place's name or the zone id, any case; blank shows them all. */
export function filterZones(zones: EventZone[], query: string): EventZone[] {
    const q = query.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter(z => z.label.toLowerCase().includes(q) || z.tz.toLowerCase().includes(q) || z.tz.toLowerCase().replace(/_/g, ' ').includes(q));
}

/** One side of the node's `eventTimeAdjusted` (create and edit answer it next to the post). */
export interface EventClockAdjustment { kind: 'gap' | 'overlap'; asked: string; saved: string }

/** "2:30 am": the design's DST words name the clock the host typed the way people say it. */
function clock12(local: string): string {
    const m = LOCAL_CLOCK_RE.exec(local)!;
    const h = +m[4];
    const time = `${h % 12 === 0 ? 12 : h % 12}:${m[5]}`;
    return h < 12 ? t('{time} am', { time }) : t('{time} pm', { time });
}

/** One adjusted side in words; `place` null when the form never knew the zone (the node read the clock at the pin). */
function adjustedSentence(side: 'start' | 'end', a: EventClockAdjustment, place: string | null): string | null {
    if (!LOCAL_CLOCK_RE.test(a.asked) || !LOCAL_CLOCK_RE.test(a.saved)) return null;
    const v = { time: clock12(a.asked), date: clockDayMonth(a.asked), saved: clock12(a.saved), place: place ?? '' };
    if (a.kind === 'gap') {
        if (side === 'start') {
            return place
                ? t('{time} does not exist on {date} in {place} (clocks go forward). It was saved as {saved}.', v)
                : t('{time} does not exist on {date} (clocks go forward). It was saved as {saved}.', v);
        }
        return place
            ? t('The end, {time}, does not exist on {date} in {place} (clocks go forward). It was saved as {saved}.', v)
            : t('The end, {time}, does not exist on {date} (clocks go forward). It was saved as {saved}.', v);
    }
    if (side === 'start') {
        return place
            ? t('{time} happens twice on {date} in {place} (clocks go back). The first one is used.', v)
            : t('{time} happens twice on {date} (clocks go back). The first one is used.', v);
    }
    return place
        ? t('The end, {time}, happens twice on {date} in {place} (clocks go back). The first one is used.', v)
        : t('The end, {time}, happens twice on {date} (clocks go back). The first one is used.', v);
}

/**
 * The DST words (§3, §7 items 1–2), from what the node answered after saving: "2:30 am does not exist on 4 Oct in Sydney
 * (clocks go forward). It was saved as 3:30 am." / "2:30 am happens twice on 5 Apr in Sydney (clocks go back). The first
 * one is used." One line per side the node adjusted; none when it adjusted nothing.
 */
export function eventTimeAdjustedText(adjusted: { start?: EventClockAdjustment | null; end?: EventClockAdjustment | null } | null | undefined, tz: string | null | undefined): string[] {
    if (!adjusted) return [];
    // The zone's place, when the form knew it; the node's answer carries no zone of its own.
    const place = tz ? zoneLabelFor(tz, NaN).replace(/ time$/, '') : null;
    const lines: string[] = [];
    if (adjusted.start) { const s = adjustedSentence('start', adjusted.start, place); if (s) lines.push(s); }
    if (adjusted.end) { const s = adjustedSentence('end', adjusted.end, place); if (s) lines.push(s); }
    return lines;
}

/**
 * What an online event's detail says where the join link would be, when the viewer has none: someone not Going is told
 * how to get it (the web's sentence); someone Going is never told to tap Going (#1946 review, finding 7): offline (the
 * node's view not loaded, and the link is never cached) they hear when it will show, and with the view loaded the host
 * simply set none. Where the host lets people in, the link waits for them like the note (#1953): before Going and while
 * waiting it says so, the web's sentence, never "tap Going" alone.
 */
export function eventLinkWaitWords(myRsvp: EventRsvpStatus | null | undefined, viewLoaded: boolean, letIn: EventLetInState = 'open'): string | null {
    if (letIn === 'before' || letIn === 'waiting') return t('The link to join shows here once the host lets you in.');
    if (myRsvp !== 'going') return t('The link to join shows here once you tap Going.');
    return viewLoaded ? null : t('The link shows when you have signal.');
}

/** The one line "Change this date only" puts on top of the copy's description (DESIGN-event-times §8). */
export function withMovedFromLine(line: string, description: string): string {
    return description.trim() ? `${line}\n\n${description}` : line;
}
