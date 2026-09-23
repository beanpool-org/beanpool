/**
 * Event extras on the phone: reminder choices, the share text, the event's link, and the calendar hand-off.
 *
 * This is the mirror of apps/pwa/src/lib/event-extras.ts. The two apps share no runtime, so the parts that
 * MUST agree — the five offsets the node accepts, the link's shape, the share text and the .ics — are
 * written twice and tested twice, with the same expectations on both sides.
 *
 * Nothing here touches a device module, so all of it is testable in the node runner.
 */

/** Minutes before the start. The only values the node accepts (the shared contract). */
export const REMINDER_OFFSETS = [10080, 1440, 120, 60, 30] as const;

/** Everyone's default until they change it: the day before. */
export const DEFAULT_REMINDER_OFFSETS: number[] = [1440];

/** The preference key the member's default is stored under. */
export const REMINDER_PREF_KEY = 'eventReminderOffsets';

const OFFSET_LABELS: Record<number, string> = {
    10080: '1 week',
    1440: '1 day',
    120: '2 hours',
    60: '1 hour',
    30: '30 minutes',
};

/** "1 week", "30 minutes" — the tick's label in the settings list. */
export function reminderOffsetLabel(minutes: number): string {
    return OFFSET_LABELS[minutes] ?? `${minutes} minutes`;
}

/**
 * Whatever the node sent for a member's or an event's offsets, as a clean list.
 *
 * Tolerant on purpose: preferences come back from `/api/members/preferences` as strings, an event's come
 * back as JSON, and an older node sends nothing at all. Anything unrecognised is `null` — "my default
 * applies" — which is the reading that can never turn a member's reminders off behind their back.
 */
export function parseReminderOffsets(value: unknown): number[] | null {
    if (value == null) return null;
    let raw: unknown = value;
    if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) return null;
        try {
            raw = JSON.parse(text);
        } catch {
            // "1440,30" — what a preferences bag that only holds strings may give back.
            raw = text.split(',');
        }
    }
    if (!Array.isArray(raw)) return null;
    // An empty list is the member saying "off". A list that held only values the node would refuse is not a
    // choice at all — it is junk, or a newer node's offsets — so it reads as "my default", never as off.
    if (raw.length === 0) return [];
    const allowed = new Set<number>(REMINDER_OFFSETS);
    const kept = new Set<number>();
    for (const item of raw) {
        const n = typeof item === 'number' ? item : Number(String(item).trim());
        if (Number.isFinite(n) && allowed.has(n)) kept.add(n);
    }
    if (kept.size === 0) return null;
    return [...kept].sort((a, b) => b - a);
}

/** The offsets as the node wants them written: allowed values only, largest first. `[]` means off. */
export function normaliseReminderOffsets(offsets: number[]): number[] {
    return parseReminderOffsets(offsets) ?? [];
}

/** "1 week", "1 week and 2 hours", "1 week, 1 day and 30 minutes". */
function joinOffsets(offsets: number[]): string {
    const parts = offsets.map(reminderOffsetLabel);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Off", or "1 day before" — how a set of offsets reads on its own. */
export function formatReminderOffsets(offsets: number[]): string {
    const clean = normaliseReminderOffsets(offsets);
    return clean.length === 0 ? 'Off' : `${joinOffsets(clean)} before`;
}

/**
 * The line under "Remind me" on an event: "1 day before (your default)" while the member has chosen
 * nothing for this event, or their choice for this one on its own.
 */
export function formatReminderChoice(offsets: number[] | null, fallback: number[] = DEFAULT_REMINDER_OFFSETS): string {
    if (offsets === null) return `${formatReminderOffsets(fallback)} (your default)`;
    return formatReminderOffsets(offsets);
}

// ===================== THE EVENT'S LINK, AND SHARING IT =====================

/**
 * Where an event lives for someone who was sent it: the community's own address with `?post=<id>`.
 *
 * Path "/" is the one this app's Android app links claim on every node host
 * (utils/__tests__/android-app-links.test.ts), which is why every invite link is `/?invite=` too. So one
 * link opens the event in this app where it is installed, and in the web app everywhere else; somebody who
 * is not a member of that community lands on its join page, which is what `/` already shows them.
 */
export function eventLink(anchorUrl: string, postId: string): string {
    return `${anchorUrl.replace(/\/+$/, '')}/?post=${encodeURIComponent(postId)}`;
}

/**
 * The post id in an incoming link, or null. Used by the deep-link handler so a shared event opens on the
 * event, and by nothing else — an invite link or an auth callback must fall straight through.
 */
export function postIdFromLink(url: string | null | undefined): string | null {
    if (!url) return null;
    const m = /[?&]post=([^&#\s]+)/.exec(url);
    if (!m) return null;
    try {
        const id = decodeURIComponent(m[1]);
        return id.trim() ? id : null;
    } catch {
        return m[1];
    }
}

/** What an event needs to be shared or put in a calendar. Both apps build this from their own post shape. */
export interface ShareableEvent {
    id: string;
    title: string;
    /** ISO UTC. */
    startAt: string;
    /** ISO UTC; when absent the calendar entry runs two hours, as the node defaults it. */
    endAt?: string | null;
    placeName?: string | null;
    description?: string | null;
}

/**
 * The message the share sheet carries: what it is, when, where, and the link. One line each, because it is
 * pasted into a chat as often as it is sent by a share sheet, and a wrapped paragraph reads worse there.
 */
export function buildShareText(event: ShareableEvent, when: string, link: string): string {
    return [event.title, when, event.placeName || '', link].filter(Boolean).join('\n');
}

// ===================== ADD TO CALENDAR =====================

export const ICS_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

/** RFC 5545 §3.3.5 UTC date-time: 20260927T090000Z. */
function icsStamp(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** RFC 5545 §3.3.11: backslash, semicolon and comma are escaped, and newlines become `\n`. */
export function icsEscape(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * RFC 5545 §3.1 content lines: no line over 75 octets, continuations start with one space. Folded on
 * OCTETS, not characters, so a title in a non-Latin script cannot push a line over the limit.
 */
export function icsFold(line: string): string {
    const bytes = new TextEncoder().encode(line);
    if (bytes.length <= 75) return line;
    const out: string[] = [];
    const decoder = new TextDecoder();
    let start = 0;
    let limit = 75;
    while (start < bytes.length) {
        let end = Math.min(start + limit, bytes.length);
        // Never split a UTF-8 sequence: back off to the start of the character.
        while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        out.push(decoder.decode(bytes.subarray(start, end)));
        start = end;
        limit = 74; // a continuation line spends one octet on its leading space
    }
    return out.join('\r\n ');
}

/** The end a calendar entry gets: the host's, or start + 2 hours, which is what the node defaults it to. */
export function calendarEndMs(event: ShareableEvent): number {
    const startMs = Date.parse(event.startAt);
    const endMs = event.endAt ? Date.parse(event.endAt) : NaN;
    return Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + ICS_DEFAULT_DURATION_MS;
}

/**
 * One VEVENT, in a VCALENDAR iOS opens straight into "Add to Calendar".
 *
 * UID is the post's id at the community's host, so re-adding the same event updates the entry instead of
 * making a second one. Times are UTC (the `Z` form), which needs no VTIMEZONE and cannot be read in the
 * wrong zone. The link goes in both URL and DESCRIPTION, because several calendars show one and not the
 * other.
 */
export function buildIcs(event: ShareableEvent, link: string, now: number = Date.now()): string {
    const startMs = Date.parse(event.startAt);
    const host = (() => {
        const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(link);
        return m ? m[1] : 'beanpool';
    })();
    const description = [event.description || '', link].filter(Boolean).join('\n\n');
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//BeanPool//Events//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${icsEscape(event.id)}@${host}`,
        `DTSTAMP:${icsStamp(now)}`,
        `DTSTART:${icsStamp(startMs)}`,
        `DTEND:${icsStamp(calendarEndMs(event))}`,
        `SUMMARY:${icsEscape(event.title)}`,
        ...(event.placeName ? [`LOCATION:${icsEscape(event.placeName)}`] : []),
        `DESCRIPTION:${icsEscape(description)}`,
        `URL:${icsEscape(link)}`,
        'END:VEVENT',
        'END:VCALENDAR',
    ];
    return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

/** A file name the share sheet shows: the title, kept to letters, digits and dashes. */
export function icsFileName(event: ShareableEvent): string {
    const slug = (event.title || 'event')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return `${slug || 'event'}.ics`;
}

/**
 * Google Calendar's "add an event" template — what Android gets.
 *
 * Android has no system "add this file to a calendar" action: Google Calendar answers ACTION_VIEW for a
 * calendar file, not the ACTION_SEND a share sheet produces, so sharing the .ics there mostly offers Drive
 * and Gmail. This URL is claimed by the Google Calendar app and opens a filled-in new event; a phone
 * without it gets the same page in a browser. iOS takes the .ics instead, which it opens properly.
 */
export function googleCalendarUrl(event: ShareableEvent, link: string): string {
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: event.title,
        dates: `${icsStamp(Date.parse(event.startAt))}/${icsStamp(calendarEndMs(event))}`,
        details: [event.description || '', link].filter(Boolean).join('\n\n'),
    });
    if (event.placeName) params.set('location', event.placeName);
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ===================== WHO CAN SEE AN EVENT (#1054's leftover) =====================

/**
 * Who an event is for, given who is hosting it and what the member picked.
 *
 * Three rules, in order: a GROUP host posts to its own group and nothing else; an ENTERPRISE host posts to
 * the whole community, because the node refuses an enterprise event aimed at a group — and it used to do so
 * with a message about signatures (#1054); anyone else gets what they picked.
 *
 * Out here rather than in the form so the last rule cannot be lost to a stale piece of screen state: the
 * form hides the group chips while an enterprise hosts, and this is what it actually sends.
 */
export function effectiveEventAudience(
    host: { key: string; groupId: string | null },
    chosenGroupId: string | null,
): string | null {
    if (host.groupId) return host.groupId;
    if (host.key.startsWith('ent:')) return null;
    return chosenGroupId;
}

// ===================== "YOUR EVENTS" =====================

/** One row of `GET /api/events/mine` (the shared contract). */
export interface MyEvent {
    postId: string;
    title: string;
    startAt: string;
    endAt: string | null;
    placeName: string | null;
    rsvp: 'going' | 'interested';
    photo: string | null;
    /** `null` means "my default applies". */
    reminderOffsets: number[] | null;
}

/**
 * The node's rows, cleaned up and put in order. The contract says soonest first, but the row order is the
 * node's word and this list is the member's own: sorting here as well costs nothing and means a node that
 * gets it wrong cannot show somebody next month's event above tonight's.
 */
export function sortMyEvents(rows: MyEvent[]): MyEvent[] {
    return [...rows]
        .filter(r => r && typeof r.postId === 'string' && Number.isFinite(Date.parse(r.startAt)))
        .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
}

/**
 * A row of `/api/events/mine` in the shape the feed's cards read (snake_case, like the local SQLite rows).
 *
 * The counts are deliberately absent, not zero: this route does not carry them, and the card leaves the
 * line out rather than telling a member that nobody is coming to the thing they are going to.
 */
export function myEventAsPost(row: MyEvent): Record<string, unknown> {
    return {
        id: row.postId,
        type: 'event',
        category: 'community',
        title: row.title,
        description: '',
        event_start_at: row.startAt,
        event_end_at: row.endAt,
        event_place_name: row.placeName,
        event_state: 'scheduled',
        status: 'active',
        photos: row.photo ? [row.photo] : null,
        myRsvp: row.rsvp,
    };
}
