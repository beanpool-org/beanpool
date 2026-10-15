/**
 * Events on the web app (docs/events-on-the-map.md §3): how an event's time reads on a card, and which events
 * the map's Today / This weekend / Next 7 days chips keep.
 *
 * Times arrive as ISO UTC with the host's clock and its zone beside them (DESIGN-event-times §4). In person, the place's
 * clock leads and the viewer's own follows only when it differs; online, the viewer's own clock leads, "your time".
 * The names are spelled out (@beanpool/core event-when) rather than taken from `toLocaleDateString`, so a card reads
 * the same on every browser at 320px, and no zone arithmetic runs here: the viewer's clock comes from the Date getters.
 */

import {
    deviceLocalClock, eventPlaceTimeText, eventWhenParts as whenParts, formatDate, localClockMs, repeatCaption, repeatChoiceKeyOf, repeatPatternFor,
    t, tn, type EventWhenParts, type RepeatChoiceKey, type RepeatPattern,
} from '@beanpool/core';
import type { MarketplacePost } from './api';

/** Every post type this client can render. Sent as `types=` so the node includes events (§2.6). */
export const CLIENT_POST_TYPES = 'offer,need,poll,event';

/** An event ends at `eventEndAt`; one without falls back to start + 2 hours, as the server defaults it. */
export const EVENT_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

export function eventEndMs(post: Pick<MarketplacePost, 'eventStartAt' | 'eventEndAt'>): number {
    if (post.eventEndAt) return Date.parse(post.eventEndAt);
    return post.eventStartAt ? Date.parse(post.eventStartAt) + EVENT_DEFAULT_DURATION_MS : NaN;
}

/** The post fields an event's time is read from. */
export type EventTimeFields = Pick<MarketplacePost, 'eventStartAt' | 'eventEndAt' | 'eventStartLocal' | 'eventEndLocal' | 'eventTz' | 'eventOnline'>;

/** A wall clock moved by some minutes, as clock arithmetic (no zone): "2026-10-16T20:50" + 120 → "2026-10-16T22:50". */
function addClockMinutes(local: string, minutes: number): string | null {
    const ms = localClockMs(local);
    return Number.isFinite(ms) ? new Date(ms + minutes * 60000).toISOString().slice(0, 16) : null;
}

/**
 * The lines an event's time reads as (DESIGN-event-times §4), each half kept whole when a narrow card wraps:
 *   ["SAT 27 SEP", "9:00–12:00"], or ["SAT 27 SEP 22:00", "SUN 28 SEP 2:00"] across midnight;
 *   in person where the viewer's clock differs, `note` "Lagos time · 15:50 your time";
 *   online, the viewer's own clock with "your time" on the second half, and `hostLine` for the detail.
 * A node that sends no clock or zone gives the viewer's own lines, as before.
 */
export function eventWhenParts(post: EventTimeFields): EventWhenParts | null {
    if (!post.eventStartAt) return null;
    const start = new Date(post.eventStartAt);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(eventEndMs(post));
    const hasEnd = !Number.isNaN(end.getTime());
    // A place clock with no end clock (never sent by a node that stores clocks, but cheap to cover): the same length on the clock.
    const endLocal = post.eventEndLocal
        || (post.eventStartLocal && hasEnd ? addClockMinutes(post.eventStartLocal, Math.round((end.getTime() - start.getTime()) / 60000)) : null);
    return whenParts({
        startAt: post.eventStartAt,
        endAt: hasEnd ? end.toISOString() : null,
        startLocal: post.eventStartLocal ?? null,
        endLocal,
        tz: post.eventTz ?? null,
        online: post.eventOnline ?? false,
        deviceStart: deviceLocalClock(start),
        deviceEnd: hasEnd ? deviceLocalClock(end) : null,
    });
}

/**
 * "SAT 27 SEP · 9:00–12:00", or "SAT 27 SEP 22:00 – SUN 28 SEP 2:00" across midnight, with the second time after it when
 * there is one ("… · Lagos time · 15:50 your time"). The words a screen reader hears and a visitor's page shows.
 */
export function formatEventWhen(post: EventTimeFields): string {
    const parts = eventWhenParts(post);
    if (!parts) return '';
    const line = `${parts.first}${parts.sep}${parts.second}`;
    return parts.note ? `${line} · ${parts.note}` : line;
}

/**
 * The time in a shared message, which is read outside the app by someone whose zone nobody knows, so it always names its
 * zone (§4): "Sat 17 Oct, 20:50 Lagos time"; online "Fri 16 Oct, 20:50 Sydney time (online)". A node that sends no
 * clock gives today's line in the sharer's own time.
 */
export function eventShareWhen(post: EventTimeFields): string {
    const placeTime = post.eventStartLocal && post.eventTz
        ? eventPlaceTimeText(post.eventStartLocal, post.eventTz, post.eventStartAt) : null;
    const ms = post.eventStartLocal ? localClockMs(post.eventStartLocal) : NaN;
    if (!placeTime || !Number.isFinite(ms)) return formatEventWhen(post);
    const d = new Date(ms);
    // placeTime is "Sat 20:50 Lagos time": the date goes after the weekday.
    const rest = placeTime.slice(placeTime.indexOf(' ') + 1);
    // The place's date, read off the stored clock (UTC getters on the clock-as-UTC), in the words layer's date table.
    return `${formatDate(d, 'weekday-day-month', { utc: true })}, ${rest}${post.eventOnline ? ' (online)' : ''}`;
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
    /** Online, with its link (the host sees it), and the zone the host's times are in (DESIGN-event-times §3). */
    online: boolean;
    link: string;
    tz: string | null;
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
        online: post.eventOnline === true,
        link: post.eventLink || '',
        tz: post.eventTz || null,
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

/**
 * What the edit form holds. Dates are datetime-local values; photos are the node's URLs or new data URLs.
 *
 * Start and end are the host's clock in `tz` (DESIGN-event-times §2 Edit), as the node stores them. An event from a node
 * before clocks has none: the form shows it in this device's time and `tz` is null, and a moved time goes as an instant.
 */
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
    /** "Only people I let in see the note and chat". */
    hostLetsIn: boolean;
    /** Online: no pin, and a link to join. */
    online?: boolean;
    link?: string;
    /** The zone the times are in; null when the event has no stored clock. */
    tz?: string | null;
    /** How it repeats, a choice computed from the first date (DESIGN-event-times §8), and its last date ('' = until cancelled). */
    repeat?: RepeatChoiceKey;
    repeatUntil?: string;
}

/** The form, filled from the event as it is now — every field the create form has. */
export function eventEditForm(post: MarketplacePost): EventEditForm {
    const clocks = !!(post.eventStartLocal && post.eventTz);
    return {
        title: post.title || '',
        description: post.description || '',
        start: clocks ? post.eventStartLocal! : isoToLocalInput(post.eventStartAt),
        end: clocks && post.eventEndLocal ? post.eventEndLocal : isoToLocalInput(post.eventEndAt),
        placeName: post.eventPlaceName || '',
        lat: post.lat ?? null,
        lng: post.lng ?? null,
        privateNote: post.eventPrivateNote || '',
        photos: Array.isArray(post.photos) ? post.photos : [],
        hostLetsIn: post.eventHostLetsIn === true,
        online: post.eventOnline === true,
        link: post.eventLink || '',
        tz: clocks ? post.eventTz! : null,
        repeat: repeatChoiceKeyOf(post.eventRepeat),
        repeatUntil: post.eventRepeatUntil || '',
    };
}

export interface EventEditPayload {
    title?: string;
    description?: string;
    eventStartAt?: string;
    eventEndAt?: string;
    eventPlaceName?: string;
    eventPrivateNote?: string;
    eventStartLocal?: string;
    eventEndLocal?: string;
    eventTz?: string;
    eventOnline?: boolean;
    eventLink?: string;
    lat?: number;
    lng?: number;
    photos?: string[];
    eventHostLetsIn?: boolean;
    eventRepeat?: RepeatPattern | null;
    eventRepeatUntil?: string | null;
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
    // The host's clock goes as typed, with its zone, for the node to resolve (DESIGN-event-times §2); a form with no zone
    // (an event from a node before clocks, or an online one whose zone nobody can name) sends instants, as before.
    const clocks = !!after.tz;
    const startMoved = after.start !== before.start;
    if (startMoved) {
        if (clocks) out.eventStartLocal = after.start.slice(0, 16);
        else {
            const iso = localInputToIso(after.start);
            if (iso) out.eventStartAt = iso;
        }
    }
    // A cleared end is sent as an empty string, which the node turns into start + 2 hours. When the start
    // moves, the end the form shows goes with it: the node keeps the old LENGTH when no end is named, so
    // moving 9:00–11:00 to 10:00 would otherwise save 10:00–12:00 while the form said 11:00.
    if (after.end !== before.end || ((out.eventStartAt || out.eventStartLocal) && after.end)) {
        if (clocks) out.eventEndLocal = after.end ? after.end.slice(0, 16) : '';
        else out.eventEndAt = localInputToIso(after.end) ?? '';
    }
    // A new zone with the clock kept is another instant, which the node works out (§2 Edit).
    if (after.tz && after.tz !== before.tz) out.eventTz = after.tz;
    const online = after.online === true;
    if (online !== (before.online === true)) out.eventOnline = online;
    if (online && (after.link ?? '').trim() !== (before.link ?? '').trim()) out.eventLink = (after.link ?? '').trim();
    if (after.placeName.trim() !== before.placeName.trim()) out.eventPlaceName = after.placeName.trim();
    if (after.privateNote.trim() !== before.privateNote.trim()) out.eventPrivateNote = after.privateNote.trim();
    if (!online && after.lat != null && after.lng != null && (after.lat !== before.lat || after.lng !== before.lng)) {
        out.lat = after.lat;
        out.lng = after.lng;
    }
    if (after.photos.length !== before.photos.length || after.photos.some((p, i) => p !== before.photos[i])) out.photos = after.photos;
    // Silent like the note: who reads the note is the host's to change.
    if (after.hostLetsIn !== before.hostLetsIn) out.eventHostLetsIn = after.hostLetsIn;
    Object.assign(out, eventRepeatEdit(before, after));
    return out;
}

/**
 * The series fields an edit sends (DESIGN-event-times §8 Edit). The pattern is the choice read on the NEW first date, so a
 * series moved from a Friday to a Saturday goes as "every Saturday", which is what the select then says; it is sent when the
 * choice changed or the first date moved. A choice the new date does not offer goes as it was chosen on the old date, and
 * the node refuses it in its own words ("The first date must be one of the repeating dates"). "Does not repeat" sends null.
 */
export function eventRepeatEdit(before: EventEditForm, after: EventEditForm): Pick<EventEditPayload, 'eventRepeat' | 'eventRepeatUntil'> {
    const out: Pick<EventEditPayload, 'eventRepeat' | 'eventRepeatUntil'> = {};
    const was = before.repeat ?? 'never';
    const now = after.repeat ?? 'never';
    const dateMoved = after.start.slice(0, 10) !== before.start.slice(0, 10);
    if (now !== was || (now !== 'never' && dateMoved)) {
        out.eventRepeat = now === 'never'
            ? null
            : repeatPatternFor(now, after.start.slice(0, 10)) ?? repeatPatternFor(now, before.start.slice(0, 10));
    }
    if (now !== 'never' && (after.repeatUntil ?? '') !== (before.repeatUntil ?? '')) out.eventRepeatUntil = after.repeatUntil || null;
    return out;
}

/** The series fields a new event sends: none for a one-off. */
export function eventRepeatCreate(choice: RepeatChoiceKey, start: string, until: string): Pick<EventEditPayload, 'eventRepeat' | 'eventRepeatUntil'> {
    const pattern = choice === 'never' ? null : repeatPatternFor(choice, start.slice(0, 10));
    if (!pattern) return {};
    return { eventRepeat: pattern, ...(until ? { eventRepeatUntil: until } : {}) };
}

/**
 * "Change this date only" opens Copy to a new date with one line on top (DESIGN-event-times §8). The copy is asked for by
 * the event's id through the app's navigation; this mark rides on it, and parseCopyEventContext reads it back.
 */
const MOVED_MARK = '#moved';
export function movedCopyContext(postId: string): string {
    return `${postId}${MOVED_MARK}`;
}
export function parseCopyEventContext(context: string): { id: string; moved: boolean } {
    return context.endsWith(MOVED_MARK) ? { id: context.slice(0, -MOVED_MARK.length), moved: true } : { id: context, moved: false };
}

/** The copy's description with the moved-from line on top. */
export function withMovedFromLine(line: string, description: string): string {
    return description.trim() ? `${line}\n\n${description}` : line;
}

/** The ↻ caption beside a repeating event's date ("Every Friday · until 18 Dec"); '' for a one-off. */
export function eventRepeatCaption(post: Pick<MarketplacePost, 'eventRepeat' | 'eventRepeatUntil'>): string {
    return repeatCaption(post.eventRepeat ?? null, post.eventRepeatUntil ?? null);
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

export function eventLetInState(post: Pick<MarketplacePost, 'eventHostLetsIn' | 'myRsvp' | 'myLetIn'>, isHost: boolean): EventLetInState {
    if (!post.eventHostLetsIn || isHost) return 'open';
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
export function eventWaitingCount(rsvps: MarketplacePost['eventRsvps']): number {
    return (rsvps ?? []).filter(r => r.status === 'going' && !r.letInAt).length;
}

export function eventWaitingLine(n: number): string {
    return tn(n, '{n} waiting to be let in', '{n} waiting to be let in');
}

/** The host's Let in button, read aloud: whom it lets in, or that a click takes it back. */
export function letInButtonLabel(letIn: boolean, name: string | null | undefined): string {
    if (name) return letIn ? t('Let in. Take it back from {name}', { name }) : t('Let {name} in', { name });
    return letIn ? t('Let in. Take it back') : t('Let them in');
}

export function letEveryoneInQuestion(n: number): string {
    return tn(n, 'Let {n} in? People who tap Going later still wait.', 'Let all {n} in? People who tap Going later still wait.');
}

/** Whether a node refusal is "you're going, the host hasn't let you in" — never shown as "only the host and people going". */
export function isWaitingForHost(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: unknown }).code === EVENT_CHAT_WAITING_CODE;
}

/** True when a save would move the event in time or place, so the form can say who will be told. */
export function eventEditNotifies(payload: EventEditPayload): boolean {
    return payload.eventStartAt !== undefined || payload.eventEndAt !== undefined || payload.eventPlaceName !== undefined
        || payload.lat !== undefined || payload.lng !== undefined
        || payload.eventStartLocal !== undefined || payload.eventEndLocal !== undefined || payload.eventTz !== undefined
        || payload.eventOnline !== undefined;
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
