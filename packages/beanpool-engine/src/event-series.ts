/**
 * A repeating event's dates, on the node (design: scratch/global-node/DESIGN-event-times-fable.md §8, slice 4). Pure: no
 * database, no clock of its own; the zone arithmetic is event-time.ts's.
 *
 * A series is ONE post row. Its `event_start_at` / `event_end_at` and their local clocks hold the NEXT occurrence, and the
 * main server's minute tick moves them on (apps/server engine/event-series-roll.ts). The rule is a closed JSON shape, not
 * RRULE text:
 *   {"freq":"weekly","interval":1,"byDay":"FR","time":"20:50","minutes":120}
 *   {"freq":"monthly","interval":1,"byMonthDay":16,"time":"20:50","minutes":120}
 *   {"freq":"monthly","interval":1,"byDay":"FR","pos":3,"time":"20:50","minutes":120}   (pos -1 = the last)
 * `time` is the clock the host typed and `minutes` how long each date lasts on the wall clock; the node fills both from the
 * form's start and end. They are on the rule because the row's own clock is the one a date really reads, which a DST gap
 * moves (02:30 → 03:30 on that one Sunday): read back as the rule, every later Sunday would drift to 03:30.
 *
 * Each date's clock is resolved in the zone on its own date (§7.1): "every Friday 20:50 Sydney time" is 20:50 on both sides
 * of the DST change and its instants are an hour apart. Monthly on the 29th-31st skips the months without that day (RFC
 * 5545's rule). A walk is bounded (MAX_STEPS): a rule and its skips can never spin the tick.
 */

import { instantToLocal, zonedToInstant } from './event-time.js';

/** Index = the UTC weekday of a date (Date.getUTCDay): Sunday first. */
export const EVENT_REPEAT_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type RepeatWeekday = (typeof EVENT_REPEAT_WEEKDAYS)[number];
export type RepeatPos = 1 | 2 | 3 | 4 | -1;

/** What an app sends: the pattern, taken from the first date (§8). */
export type EventRepeatPattern =
    | { freq: 'weekly'; interval: number; byDay: RepeatWeekday }
    | { freq: 'monthly'; interval: number; byMonthDay: number }
    | { freq: 'monthly'; interval: number; byDay: RepeatWeekday; pos: RepeatPos };

/** What the node stores in `event_repeat`: the pattern, the host's clock and each date's length. */
export type EventRepeatRule = EventRepeatPattern & { time: string; minutes: number };

/** One date of a series. */
export interface EventOccurrence {
    /** The local date, "YYYY-MM-DD", in the series' zone. */
    date: string;
    /** The clocks as they really read that day ("YYYY-MM-DDTHH:MM"): a gap moves one forward. */
    startLocal: string;
    endLocal: string;
    /** ISO UTC. */
    startAt: string;
    endAt: string;
}

export const EVENT_REPEAT_INTERVAL_MAX = 12;
/** Cancelled dates kept on a series (§2: ≤ 100 entries, ≤ 1.3 KB). */
export const EVENT_REPEAT_SKIPS_MAX = 100;
/** The latest `until`: five years after the first date (§8). */
export const EVENT_REPEAT_UNTIL_MAX_YEARS = 5;
/** How many candidate dates one walk looks at: past 5 years of weekly dates, so `until` ends it first. */
const MAX_STEPS = 400;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

/** Refusals, in the words the form shows. */
export const REPEAT_ERRORS = {
    shape: 'Choose how the event repeats from the list',
    interval: `An event can repeat every 1 to ${EVENT_REPEAT_INTERVAL_MAX} weeks or months`,
    firstDate: 'The first date must be one of the repeating dates',
    until: 'The last date must be a date on or after the first one',
    untilTooFar: `The last date can be at most ${EVENT_REPEAT_UNTIL_MAX_YEARS} years after the first one`,
    tooLong: 'An event that repeats must end before its next date starts',
    skipDate: 'Pick one of the dates this event repeats on',
} as const;

function utcOfDate(date: string): number {
    const m = DATE_RE.exec(date);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function dateOfUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/** A real "YYYY-MM-DD" (not 30 Feb, not month 13). */
export function isLocalDate(v: unknown): v is string {
    if (typeof v !== 'string') return false;
    const ms = utcOfDate(v);
    return Number.isFinite(ms) && dateOfUtc(ms) === v;
}

function daysInMonth(y: number, m0: number): number {
    return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/** The weekday code of a local date. */
export function weekdayOf(date: string): RepeatWeekday {
    return EVENT_REPEAT_WEEKDAYS[new Date(utcOfDate(date)).getUTCDay()];
}

/** Which of its weekday in the month a date is: 1-4, or -1 when it is the last (a 5th is always the last). */
export function weekdayPosOf(date: string): { nth: number; last: boolean } {
    const d = new Date(utcOfDate(date));
    const day = d.getUTCDate();
    return { nth: Math.ceil(day / 7), last: day + 7 > daysInMonth(d.getUTCFullYear(), d.getUTCMonth()) };
}

/** The nth (or last) `weekday` of a month, as a local date; null when the month has no such day. */
function nthWeekdayOfMonth(y: number, m0: number, weekday: RepeatWeekday, pos: RepeatPos): string | null {
    const want = EVENT_REPEAT_WEEKDAYS.indexOf(weekday);
    const dim = daysInMonth(y, m0);
    if (pos === -1) {
        const lastDow = new Date(Date.UTC(y, m0, dim)).getUTCDay();
        return dateOfUtc(Date.UTC(y, m0, dim - ((lastDow - want + 7) % 7)));
    }
    const firstDow = new Date(Date.UTC(y, m0, 1)).getUTCDay();
    const day = 1 + ((want - firstDow + 7) % 7) + (pos - 1) * 7;
    return day <= dim ? dateOfUtc(Date.UTC(y, m0, day)) : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * An app's `eventRepeat`, checked into a pattern, or null for "never" (null, absent, false or {"freq":"never"}).
 * Throws REPEAT_ERRORS words. Only the keys of its own shape are kept, so what is stored is always the closed shape.
 */
export function parseRepeatPattern(raw: unknown): EventRepeatPattern | null {
    if (raw == null || raw === false || raw === '') return null;
    if (!isPlainObject(raw)) throw new Error(REPEAT_ERRORS.shape);
    if (raw.freq === 'never') return null;
    const interval = raw.interval ?? 1;
    if (typeof interval !== 'number' || !Number.isInteger(interval)) throw new Error(REPEAT_ERRORS.shape);
    if (interval < 1 || interval > EVENT_REPEAT_INTERVAL_MAX) throw new Error(REPEAT_ERRORS.interval);
    const byDay = raw.byDay;
    if (byDay != null && !(EVENT_REPEAT_WEEKDAYS as readonly unknown[]).includes(byDay)) throw new Error(REPEAT_ERRORS.shape);
    if (raw.freq === 'weekly') {
        if (byDay == null || raw.byMonthDay != null || raw.pos != null) throw new Error(REPEAT_ERRORS.shape);
        return { freq: 'weekly', interval, byDay: byDay as RepeatWeekday };
    }
    if (raw.freq === 'monthly') {
        if (byDay != null) {
            if (raw.byMonthDay != null || ![1, 2, 3, 4, -1].includes(raw.pos as number)) throw new Error(REPEAT_ERRORS.shape);
            return { freq: 'monthly', interval, byDay: byDay as RepeatWeekday, pos: raw.pos as RepeatPos };
        }
        const md = raw.byMonthDay;
        if (raw.pos != null || typeof md !== 'number' || !Number.isInteger(md) || md < 1 || md > 31) throw new Error(REPEAT_ERRORS.shape);
        return { freq: 'monthly', interval, byMonthDay: md };
    }
    throw new Error(REPEAT_ERRORS.shape);
}

/** A stored `event_repeat` cell back into a rule; null when it is empty or not one (never thrown: the tick reads it). */
export function readRepeatRule(cell: unknown): EventRepeatRule | null {
    if (typeof cell !== 'string' || !cell) return null;
    try {
        const raw = JSON.parse(cell);
        const pattern = parseRepeatPattern(raw);
        if (!pattern || typeof raw.time !== 'string' || !TIME_RE.test(raw.time)) return null;
        if (typeof raw.minutes !== 'number' || !Number.isInteger(raw.minutes) || raw.minutes < 1) return null;
        return { ...pattern, time: raw.time, minutes: raw.minutes };
    } catch {
        return null;
    }
}

/** A stored `event_repeat_skips` cell back into sorted dates. Unreadable reads as none. */
export function readRepeatSkips(cell: unknown): string[] {
    if (typeof cell !== 'string' || !cell) return [];
    try {
        const raw = JSON.parse(cell);
        return Array.isArray(raw) ? [...new Set(raw.filter(isLocalDate))].sort() : [];
    } catch {
        return [];
    }
}

/** Whether a local date is one of the pattern's dates, ignoring the interval's phase (the first date sets that). */
export function patternFallsOn(pattern: EventRepeatPattern, date: string): boolean {
    if (!isLocalDate(date)) return false;
    if (pattern.freq === 'weekly') return weekdayOf(date) === pattern.byDay;
    if ('byMonthDay' in pattern) return +date.slice(8, 10) === pattern.byMonthDay;
    if (weekdayOf(date) !== pattern.byDay) return false;
    const { nth, last } = weekdayPosOf(date);
    return pattern.pos === -1 ? last : nth === pattern.pos;
}

/** The shortest time between two dates of a pattern, in minutes: an occurrence must end inside it. */
export function shortestGapMinutes(pattern: EventRepeatPattern): number {
    return (pattern.freq === 'weekly' ? 7 : 28) * pattern.interval * 1440;
}

/** A local clock plus wall minutes ("2026-10-16T23:30" + 90 → "2026-10-17T01:00"). */
export function addWallMinutes(local: string, minutes: number): string {
    const ms = Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +local.slice(11, 13), +local.slice(14, 16));
    return new Date(ms + minutes * 60_000).toISOString().slice(0, 16);
}

/** How many wall minutes lie between two local clocks. */
export function wallMinutesBetween(fromLocal: string, toLocal: string): number {
    const at = (l: string) => Date.UTC(+l.slice(0, 4), +l.slice(5, 7) - 1, +l.slice(8, 10), +l.slice(11, 13), +l.slice(14, 16));
    return Math.round((at(toLocal) - at(fromLocal)) / 60_000);
}

/** One date's clocks resolved in the zone (each on its own date, §7.1); null when the zone is unknown. */
export function occurrenceOn(rule: EventRepeatRule, date: string, tz: string): EventOccurrence | null {
    const askedStart = `${date}T${rule.time}`;
    const start = zonedToInstant(askedStart, tz);
    const end = zonedToInstant(addWallMinutes(askedStart, rule.minutes), tz);
    if (!start || !end) return null;
    // A date that starts in a gap and ends just past it can't end before it starts; it keeps its length then, and its end
    // clock is that end's (Sunday 02:30–03:30 Sydney on the gap day reads 03:30–04:30, not 03:30–03:30).
    if (Date.parse(end.instant) > Date.parse(start.instant)) {
        return { date, startLocal: start.local, endLocal: end.local, startAt: start.instant, endAt: end.instant };
    }
    const endAt = new Date(Date.parse(start.instant) + rule.minutes * 60_000).toISOString();
    return { date, startLocal: start.local, endLocal: instantToLocal(endAt, tz), startAt: start.instant, endAt };
}

/**
 * The pattern's dates from `anchorDate` on, in order, `anchorDate` first when it is one: weekly every `interval` weeks
 * from it; monthly every `interval` months from its month, a month without the day left out. At most MAX_STEPS candidates.
 */
function* patternDates(pattern: EventRepeatPattern, anchorDate: string): Generator<string> {
    const anchorMs = utcOfDate(anchorDate);
    if (!Number.isFinite(anchorMs)) return;
    if (pattern.freq === 'weekly') {
        for (let k = 0; k < MAX_STEPS; k++) yield dateOfUtc(anchorMs + k * pattern.interval * 7 * DAY_MS);
        return;
    }
    const a = new Date(anchorMs);
    for (let k = 0; k < MAX_STEPS; k++) {
        const months = a.getUTCMonth() + k * pattern.interval;
        const y = a.getUTCFullYear() + Math.floor(months / 12);
        const m0 = months % 12;
        const date = 'byMonthDay' in pattern
            ? (pattern.byMonthDay <= daysInMonth(y, m0) ? dateOfUtc(Date.UTC(y, m0, pattern.byMonthDay)) : null)
            : nthWeekdayOfMonth(y, m0, pattern.byDay, pattern.pos);
        if (date && date >= anchorDate) yield date;
    }
}

export interface SeriesWalk {
    rule: EventRepeatRule;
    /** A date of the series (the current occurrence's), which sets the interval's phase. */
    anchorDate: string;
    tz: string;
    skips?: readonly string[];
    /** The last local date, inclusive; null = until cancelled. */
    until?: string | null;
}

/**
 * The first date of the series that has not ended at `afterIso`: on the pattern, from the anchor on, not skipped, not past
 * `until`. Null when there is none (`until` passed, or every date left is cancelled): the series is over.
 */
export function nextOccurrence(walk: SeriesWalk, afterIso: string): EventOccurrence | null {
    const after = Date.parse(afterIso);
    const skips = new Set(walk.skips ?? []);
    for (const date of patternDates(walk.rule, walk.anchorDate)) {
        if (walk.until && date > walk.until) return null;
        if (skips.has(date)) continue;
        const occ = occurrenceOn(walk.rule, date, walk.tz);
        if (!occ) return null;
        if (Date.parse(occ.endAt) > after) return occ;
    }
    return null;
}

/**
 * The series' next `n` dates from the anchor on, for the detail's "Next dates" (§4): cancelled ones included and marked,
 * so the host can un-cancel one. Stops at `until`.
 */
export function upcoming(walk: SeriesWalk, n: number, afterIso: string): (EventOccurrence & { skipped: boolean })[] {
    const out: (EventOccurrence & { skipped: boolean })[] = [];
    const after = Date.parse(afterIso);
    const skips = new Set(walk.skips ?? []);
    for (const date of patternDates(walk.rule, walk.anchorDate)) {
        if (out.length >= n || (walk.until && date > walk.until)) break;
        const occ = occurrenceOn(walk.rule, date, walk.tz);
        if (!occ) break;
        if (Date.parse(occ.endAt) > after) out.push({ ...occ, skipped: skips.has(date) });
    }
    return out;
}

/**
 * Whether `date` is one of the series' dates: on the pattern, in phase with the anchor (before it or after), not past
 * `until`. A date before the anchor counts, so a host can un-cancel a date the roll has already moved past.
 */
export function isSeriesDate(walk: SeriesWalk, date: string): boolean {
    if (!patternFallsOn(walk.rule, date) || (walk.until && date > walk.until)) return false;
    const a = new Date(utcOfDate(walk.anchorDate));
    const d = new Date(utcOfDate(date));
    if (!Number.isFinite(a.getTime())) return false;
    if (walk.rule.freq === 'weekly') return Math.round((d.getTime() - a.getTime()) / DAY_MS) % (7 * walk.rule.interval) === 0;
    const months = (d.getUTCFullYear() - a.getUTCFullYear()) * 12 + (d.getUTCMonth() - a.getUTCMonth());
    return months % walk.rule.interval === 0;
}

/**
 * A series' final date: the last of its dates on or before `until`, from the anchor on; null with no `until` (it goes on
 * until cancelled). It can't be cancelled (apps/server engine/event-series-roll.ts): a series ends on it, so the host's
 * `until` is never lost to dates cancelled before it.
 */
export function lastSeriesDate(walk: SeriesWalk): string | null {
    if (!walk.until) return null;
    let last: string | null = null;
    for (const date of patternDates(walk.rule, walk.anchorDate)) {
        if (date > walk.until) break;
        last = date;
    }
    return last;
}

/** The latest `until` a series whose first date is `firstDate` may have. */
export function latestUntil(firstDate: string): string {
    const d = new Date(utcOfDate(firstDate));
    d.setUTCFullYear(d.getUTCFullYear() + EVENT_REPEAT_UNTIL_MAX_YEARS);
    return dateOfUtc(d.getTime());
}

/**
 * A rule as `event_repeat` holds it: one spelling for one rule (the keys in a fixed order), so a standby's copy of the
 * row is the main server's byte for byte. Null for none, or for anything that is not a rule.
 */
export function repeatRuleCell(rule: unknown): string | null {
    if (!isPlainObject(rule)) return null;
    const r = readRepeatRule(JSON.stringify(rule));
    if (!r) return null;
    const pattern = r.freq === 'weekly'
        ? { freq: r.freq, interval: r.interval, byDay: r.byDay }
        : 'byMonthDay' in r
            ? { freq: r.freq, interval: r.interval, byMonthDay: r.byMonthDay }
            : { freq: r.freq, interval: r.interval, byDay: r.byDay, pos: r.pos };
    return JSON.stringify({ ...pattern, time: r.time, minutes: r.minutes });
}

/** Cancelled dates as `event_repeat_skips` holds them: sorted, once each, real dates; NULL (null) for none. */
export function repeatSkipsCell(skips: unknown): string | null {
    if (!Array.isArray(skips)) return null;
    const clean = [...new Set(skips.filter(isLocalDate))].sort();
    return clean.length > 0 ? JSON.stringify(clean) : null;
}
