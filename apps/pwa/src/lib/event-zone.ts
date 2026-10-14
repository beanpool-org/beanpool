/**
 * The event form's time zone (DESIGN-event-times §3, slice 2): which zone the typed times are in, the one muted line that
 * says so when it matters, the picker's entries, what goes to the node, and the words for a clock the node had to move.
 *
 * No zone arithmetic runs here. An in-person event's zone is the pin's, looked up by the node (GET /api/events/zone); an
 * online event's is this device's, from one Intl call; the node turns clock + zone into the instant.
 */

import { formatDate, localClockMs, utcOffsetName, zoneLabelFor } from '@beanpool/core';
import type { EventTimeAdjusted, EventZone } from './api';

/** Where the form's zone came from: the pin (in person), this device (online), or the host's own pick. */
export type EventZoneSource = 'pin' | 'device' | 'picked';

/** This device's zone id, or null when the browser cannot name one. */
export function deviceZoneId(): string | null {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return typeof tz === 'string' && tz.includes('/') ? tz : tz === 'UTC' ? 'UTC' : null;
    } catch {
        return null;
    }
}

/** This device's zone as the node would describe it, from its id and this device's offset now. */
export function deviceZone(now: Date = new Date()): EventZone | null {
    const tz = deviceZoneId();
    if (!tz) return null;
    const offsetMinutes = -now.getTimezoneOffset();
    return { tz, label: zoneLabelFor(tz, offsetMinutes), offsetMinutes };
}

/** "Lagos time" → "Lagos"; "UTC+1 time" → "UTC+1". */
export function placeOfLabel(label: string): string {
    return label.replace(/ time$/, '');
}

/** A picker entry: "Lagos (UTC+1)". */
export function zoneOptionText(zone: EventZone): string {
    return `${placeOfLabel(zone.label)} (${utcOffsetName(zone.offsetMinutes)})`;
}

/** The picker's entries, by name, each zone once. */
export function zoneOptions(zones: EventZone[]): Array<{ tz: string; text: string }> {
    const seen = new Set<string>();
    return zones
        .filter(z => z && typeof z.tz === 'string' && !seen.has(z.tz) && seen.add(z.tz))
        .map(z => ({ tz: z.tz, text: zoneOptionText(z) }))
        .sort((a, b) => a.text.localeCompare(b.text, 'en'));
}

export interface EventZoneLine {
    /** "Lagos time"; null when the form has no zone to name (online, and this device cannot name its own). */
    label: string | null;
    /** Why that zone: the pin's ("(where the pin is)"), this device's ("(your device)"), or null when the host picked it.
     *  A reason, not words: the form says it in the member's language (t()). */
    why: 'pin' | 'device' | null;
}

/**
 * The muted line under the times (§3), or null when it would say nothing new:
 *   in person, the pin's zone is this device's       nothing (every ordinary local-node case)
 *   in person, another zone                          "Times are Lagos time (where the pin is) · Change"
 *   online                                           "Times are Sydney time (your device) · Change", always
 *   online, the device cannot name its zone          "Pick the time zone these times are in"
 * A zone the host picked always shows, so they can see it took.
 */
export function eventZoneLine(online: boolean, zone: EventZone | null, source: EventZoneSource | null, deviceTz: string | null): EventZoneLine | null {
    if (online) {
        if (!zone) return { label: null, why: null };
        return { label: zone.label, why: source === 'device' ? 'device' : null };
    }
    if (!zone) return null;
    if (source !== 'picked' && zone.tz === deviceTz) return null;
    return { label: zone.label, why: source === 'pin' ? 'pin' : null };
}

/**
 * Roughly when a typed clock happens, for the form's own "in the future" check before it sends: the clock read in the
 * zone's offset now (a DST change between now and then moves it by an hour; the node's own check is exact). With no zone,
 * the device's reading, as before.
 */
export function approxInstantMs(local: string, zone: EventZone | null): number {
    if (!local) return NaN;
    if (!zone) return new Date(local).getTime();
    const ms = localClockMs(local.slice(0, 16));
    return Number.isFinite(ms) ? ms - zone.offsetMinutes * 60000 : NaN;
}

/**
 * What the event's times go to the node as. The typed clock always, for the node to resolve: with the zone when the form
 * has one, and in person without it the node uses the pin's. An online event whose zone nobody can name goes as the
 * device's instant (§3: a one-off still saves).
 */
export function eventClockBody(start: string, end: string, online: boolean, zone: EventZone | null): {
    eventStartLocal?: string; eventEndLocal?: string; eventTz?: string; eventStartAt?: string; eventEndAt?: string;
} {
    if (online && !zone) {
        const s = start ? new Date(start).getTime() : NaN;
        const e = end ? new Date(end).getTime() : NaN;
        return {
            ...(Number.isFinite(s) ? { eventStartAt: new Date(s).toISOString() } : {}),
            ...(Number.isFinite(e) ? { eventEndAt: new Date(e).toISOString() } : {}),
        };
    }
    return {
        eventStartLocal: start.slice(0, 16),
        ...(end ? { eventEndLocal: end.slice(0, 16) } : {}),
        ...(zone ? { eventTz: zone.tz } : {}),
    };
}

function clockWords(local: string): { time: string; date: string } | null {
    const ms = localClockMs(local);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return { time: `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`, date: formatDate(d, 'day-month', { utc: true }) };
}

/**
 * What the node did with a clock that falls in a DST change (§3, §7; #1937's eventTimeAdjusted), in words for the host:
 *   "2:30 does not exist on 4 Oct in Sydney (clocks go forward). It was saved as 3:30."
 *   "2:30 happens twice on 5 Apr in Sydney (clocks go back). The first one is used."
 */
export function eventAdjustedWords(adjusted: EventTimeAdjusted | null | undefined, zoneLabel: string): string[] {
    if (!adjusted) return [];
    const place = placeOfLabel(zoneLabel);
    const out: string[] = [];
    for (const [which, a] of [['start', adjusted.start], ['end', adjusted.end]] as const) {
        if (!a) continue;
        const asked = clockWords(a.asked);
        const saved = clockWords(a.saved);
        if (!asked || !saved) continue;
        const subject = which === 'end' ? `The end, ${asked.time},` : asked.time;
        out.push(a.kind === 'gap'
            ? `${subject} does not exist on ${asked.date} in ${place} (clocks go forward). It was saved as ${saved.time}.`
            : `${subject} happens twice on ${asked.date} in ${place} (clocks go back). The first one is used.`);
    }
    return out;
}

/** A join link as the form checks it before sending: blank, or http(s). The node checks the rest (no user name, 500 chars). */
export function eventLinkProblem(link: string): string | null {
    const v = link.trim();
    if (!v) return null;
    if (!/^https?:\/\/\S+$/i.test(v)) return 'The link to join must start with https:// or http://';
    if (v.length > 500) return 'The link to join can be at most 500 characters';
    return null;
}
