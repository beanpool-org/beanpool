/**
 * An event's clock and its zone, on the node (design: scratch/global-node/DESIGN-event-times-fable.md §1, §2, §7).
 *
 * An event keeps the clock the host typed ("2026-10-16T20:50"), the IANA zone that clock belongs to, and the instant. The
 * node turns the first two into the third here, with its own Intl; no app ever converts a time into another zone. The words
 * a zone reads as live in @beanpool/core (zoneLabelFor), so the apps and the push text say the same thing.
 *
 * DST rules (§7): a clock that does not exist (the spring gap) moves FORWARD by the gap, 02:30 → 03:30; a clock that
 * happens twice (the autumn overlap) is the EARLIER of the two.
 */

import { CURRENT_ZONE_IDS, LOCAL_CLOCK_RE, localClockMs, zoneLabelFor } from '@beanpool/core';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        formatters.set(tz, f);
    }
    return f;
}

function intlZoneOf(tz: string): string | null {
    try {
        return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
    } catch {
        return null;
    }
}

/**
 * The node's own spelling of a zone (`US/Pacific` → `America/Los_Angeles`), or null when this node's Intl does not know
 * it. One zone gets one spelling in the database: Intl's canonical id, then the current IANA name where Intl still gives
 * the old one (`Europe/Kiev` → `Europe/Kyiv`, @beanpool/core CURRENT_ZONE_IDS), when this Intl accepts it.
 */
export function canonicalZone(tz: unknown): string | null {
    if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return null;
    const id = intlZoneOf(tz.trim());
    if (!id) return null;
    const current = CURRENT_ZONE_IDS[id];
    return current && intlZoneOf(current) ? current : id;
}

export function isKnownZone(tz: unknown): boolean {
    return canonicalZone(tz) !== null;
}

/** The zone's clock at an instant, "YYYY-MM-DDTHH:MM". */
export function instantToLocal(at: string | number | Date, tz: string): string {
    const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
    const parts: Record<string, string> = {};
    for (const p of formatterFor(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/** How far the zone's clock is ahead of UTC at an instant, in minutes. */
export function offsetMinutesAt(at: string | number, tz: string): number {
    const ms = typeof at === 'number' ? at : Date.parse(at);
    const wholeMinute = Math.floor(ms / 60000) * 60000;
    return Math.round((localClockMs(instantToLocal(wholeMinute, tz)) - wholeMinute) / 60000);
}

export interface ZonedInstant {
    /** ISO UTC. */
    instant: string;
    /** The clock as it will really read: the typed one, or the typed one moved forward past a gap. */
    local: string;
    /** 'gap' when the typed clock does not exist that day, 'overlap' when it happens twice. */
    adjusted: 'gap' | 'overlap' | null;
}

/**
 * The instant a wall clock in a zone stands for. Null when the clock is not a real "YYYY-MM-DDTHH:MM" (30 Feb, 24:00,
 * minute 60 and month 13 have the shape, and would otherwise roll into another date) or the zone is unknown.
 * Every offset the zone uses within a day of the clock is tried; the matches decide plain / overlap (earlier wins), and
 * none at all is a gap, resolved with the offset in force just before it, which lands the clock forward by the gap.
 */
export function zonedToInstant(local: string, tz: string): ZonedInstant | null {
    if (!LOCAL_CLOCK_RE.test(local) || !isKnownZone(tz)) return null;
    const asUtc = localClockMs(local);
    if (!Number.isFinite(asUtc) || new Date(asUtc).toISOString().slice(0, 16) !== local) return null;
    const DAY = 24 * 60 * 60 * 1000;
    const offsets = new Set([offsetMinutesAt(asUtc - DAY, tz), offsetMinutesAt(asUtc, tz), offsetMinutesAt(asUtc + DAY, tz)]);
    const matches = [...offsets]
        .map(off => asUtc - off * 60000)
        .filter(ms => instantToLocal(ms, tz) === local)
        .sort((a, b) => a - b);
    if (matches.length > 0) {
        return { instant: new Date(matches[0]).toISOString(), local, adjusted: matches.length > 1 ? 'overlap' : null };
    }
    // A gap: the offset before it (the one a day earlier) puts the instant past the jump.
    const ms = asUtc - offsetMinutesAt(asUtc - DAY, tz) * 60000;
    return { instant: new Date(ms).toISOString(), local: instantToLocal(ms, tz), adjusted: 'gap' };
}

/** A zone in plain words at an instant: "Sydney time", "Kyiv time", "UTC+1 time" for `Etc/GMT-1`. */
export function zoneLabel(tz: string, at: string | number = Date.now()): string {
    return zoneLabelFor(tz, offsetMinutesAt(at, tz));
}
