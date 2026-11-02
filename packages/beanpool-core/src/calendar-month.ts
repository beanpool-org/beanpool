/**
 * The calendar month view, in core (design: scratch/fable-design/DESIGN-map-calendar-fable.md §1, §4, §8 S1).
 *
 * Pure: no Intl, no clock read inside it, no network, no storage. The current date (`now`) is passed in.
 * Dates are by local day ("YYYY-MM-DD"), extracted from each event's stored `eventStartLocal` clock string
 * (or `eventStartAt`), so hours and daylight saving shifts never move a date across a day boundary.
 *
 * Repeating events are expanded on the device from each series' next date through the end of the month
 * being viewed: weekly, fortnightly, every n weeks, monthly by day, and monthly by nth / last weekday.
 * Series patterns, `until` caps, and cancelled `skips` dates are all honoured, with bounded steps so
 * malformed or endless rules can never spin the CPU.
 */

import { currentLanguage, DATE_WORDS, formatDate, t, tn, wordsFor, type DateWords, type UiLang } from './words.js';
import { type RepeatPattern, type RepeatWeekdayCode, REPEAT_WEEKDAYS } from './event-repeat.js';
import { eventRepeatOf } from './show-on-global.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Maximum candidates to walk during repeating series expansion (bounded to prevent infinite loops). */
export const MAX_SERIES_STEPS = 500;

/** Whether a value is a valid "YYYY-MM-DD" local date string. */
export function isLocalDate(v: unknown): v is string {
    if (typeof v !== 'string') return false;
    const m = DATE_RE.exec(v);
    if (!m) return false;
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    return d <= daysInMonth(y, mo);
}

/** Milliseconds in UTC for a "YYYY-MM-DD" date string. */
export function utcOf(date: string): number {
    const m = DATE_RE.exec(date);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

/** Convert UTC milliseconds to a "YYYY-MM-DD" date string. */
export function dateOfUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/** Whether year is a leap year (Gregorian). */
export function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Number of days in month (1..12) for year. */
export function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Add calendar days to a "YYYY-MM-DD" date string. */
export function addDays(date: string, days: number): string {
    const ms = utcOf(date);
    return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** Number of days from dateA to dateB (dateB - dateA). */
export function daysBetween(dateA: string, dateB: string): number {
    return Math.round((utcOf(dateB) - utcOf(dateA)) / 86_400_000);
}

/** The weekday code of a local date (SU, MO, TU, WE, TH, FR, SA). */
export function weekdayCodeOf(date: string): RepeatWeekdayCode {
    return REPEAT_WEEKDAYS[new Date(utcOf(date)).getUTCDay()];
}

/** Which of its weekday in the month a date is: 1-4, or -1 when it is the last. */
export function weekdayPosOf(date: string): { nth: number; last: boolean } {
    const ms = utcOf(date);
    const d = new Date(ms);
    const day = d.getUTCDate();
    const dim = daysInMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
    return { nth: Math.ceil(day / 7), last: day + 7 > dim };
}

/** The nth (or last) weekday of a month, as a "YYYY-MM-DD" date; null if month has no such weekday. */
export function nthWeekdayOfMonth(year: number, month0: number, weekday: RepeatWeekdayCode, pos: 1 | 2 | 3 | 4 | -1): string | null {
    const want = REPEAT_WEEKDAYS.indexOf(weekday);
    const dim = daysInMonth(year, month0 + 1);
    if (pos === -1) {
        const lastDow = new Date(Date.UTC(year, month0, dim)).getUTCDay();
        return dateOfUtc(Date.UTC(year, month0, dim - ((lastDow - want + 7) % 7)));
    }
    const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
    const day = 1 + ((want - firstDow + 7) % 7) + (pos - 1) * 7;
    return day <= dim ? dateOfUtc(Date.UTC(year, month0, day)) : null;
}

/** Parse a "YYYY-MM-DD" date string into numeric year, month (1..12), day. */
export function parseLocalDate(dateStr: string): { year: number; month: number; day: number } | null {
    const m = DATE_RE.exec(dateStr);
    if (!m) return null;
    const year = +m[1];
    const month = +m[2];
    const day = +m[3];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
}

/** Format year, month (1..12), day into "YYYY-MM-DD". */
export function formatLocalDate(year: number, month: number, day: number): string {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Event Types & Extraction ──────────────────────────────────────────────────────────────────────────────────

/** Minimal shape of an event post for calendar month grouping and expansion. */
export interface CalendarEventInput {
    id: string;
    /** The start clock as the node/replica stores it ("YYYY-MM-DDTHH:MM"). */
    eventStartLocal?: string | null;
    event_start_local?: string | null;
    /** The end clock ("YYYY-MM-DDTHH:MM"). */
    eventEndLocal?: string | null;
    event_end_local?: string | null;
    /** ISO UTC start instant. */
    eventStartAt?: string | null;
    event_start_at?: string | null;
    /** ISO UTC end instant. */
    eventEndAt?: string | null;
    event_end_at?: string | null;
    /** The repeating rule, as an object or JSON string. */
    eventRepeat?: unknown;
    event_repeat?: unknown;
    /** The series' last date ("YYYY-MM-DD"). */
    eventRepeatUntil?: string | null;
    event_repeat_until?: string | null;
    /** Cancelled dates of the series (array of "YYYY-MM-DD" or JSON string). */
    eventRepeatSkips?: readonly string[] | string | null;
    event_repeat_skips?: readonly string[] | string | null;
    /** Whether this event is online. */
    eventOnline?: boolean | number | string | null;
    event_online?: boolean | number | string | null;
    [key: string]: unknown;
}

/** An occurrence of an event (original or generated from repeating series expansion). */
export type CalendarOccurrence<T extends CalendarEventInput = CalendarEventInput> = T & {
    /** The local date this occurrence falls on ("YYYY-MM-DD"). */
    date: string;
    /** Whether this occurrence was generated by series expansion. */
    isExpanded: boolean;
    /** The original event input object. */
    baseEvent: T;
};

/** One cell in the calendar month grid. */
export interface CalendarCell<T extends CalendarEventInput = CalendarEventInput> {
    /** The ISO date "YYYY-MM-DD" of this cell, or null for an empty padding cell. */
    date: string | null;
    /** Day of the month (1–31), or null for padding. */
    day: number | null;
    /** Whether this cell is part of the month being viewed. */
    inMonth: boolean;
    /** Whether this day is today (relative to now). */
    isToday: boolean;
    /** Whether this day is before today (relative to now). */
    isPast: boolean;
    /** Whether this day has at least one active event (false on past days: no dots). */
    hasEvents: boolean;
    /** Number of active events on this day. */
    eventCount: number;
    /** The occurrences on this day, sorted soonest first. */
    events: CalendarOccurrence<T>[];
}

/** The complete calendar month model for rendering. */
export interface CalendarMonth<T extends CalendarEventInput = CalendarEventInput> {
    /** The year of this month (e.g. 2026). */
    year: number;
    /** The 1-based month (1–12). */
    month: number;
    /** "YYYY-MM" (e.g. "2026-11"). */
    monthKey: string;
    /** The month heading (e.g. "November 2026"). */
    heading: string;
    /** The 7 weekday labels starting from Monday (e.g. ['Mon', 'Tue', ...]). */
    weekdayHeaders: string[];
    /** The flat list of all cells in the grid (including padding cells). */
    cells: CalendarCell<T>[];
    /** The cells grouped by week (rows of 7 cells). */
    weeks: CalendarCell<T>[][];
    /** Map of date ("YYYY-MM-DD") to events on that date in this month. */
    eventsByDay: Record<string, CalendarOccurrence<T>[]>;
    /** Total active events in this month. */
    totalEvents: number;
    /** The first date in this month on or after today with events, or null if none. */
    firstActiveDate: string | null;
    /** The next event date after this month, if any was in the input events. */
    nextEventDate: string | null;
    /** Previous month navigation target: { year, month }. */
    prevMonth: { year: number; month: number };
    /** Next month navigation target: { year, month }. */
    nextMonth: { year: number; month: number };
    /** Whether the previous month is in the past relative to now (‹ is greyed on current month). */
    isCurrentOrPastMonth: boolean;
}

/** Extract the local date ("YYYY-MM-DD") from an event. */
export function eventLocalDate(event: CalendarEventInput): string | null {
    const local = event.eventStartLocal ?? event.event_start_local;
    if (typeof local === 'string' && local.length >= 10 && isLocalDate(local.slice(0, 10))) {
        return local.slice(0, 10);
    }
    const iso = event.eventStartAt ?? event.event_start_at;
    if (typeof iso === 'string' && iso.length >= 10 && isLocalDate(iso.slice(0, 10))) {
        return iso.slice(0, 10);
    }
    return null;
}

/** Read cancelled skips dates from an event as a Set of "YYYY-MM-DD" strings. */
export function readEventSkips(event: CalendarEventInput): Set<string> {
    const raw = event.eventRepeatSkips ?? event.event_repeat_skips;
    if (!raw) return new Set();
    if (Array.isArray(raw)) {
        return new Set(raw.filter(isLocalDate));
    }
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return new Set(parsed.filter(isLocalDate));
        } catch {
            return new Set();
        }
    }
    return new Set();
}

// ── Series Expansion ──────────────────────────────────────────────────────────────────────────────────────────

export interface DateRange {
    start: string;
    end: string;
}

/**
 * Expand a single event (one-off or repeating series) into occurrences falling within [range.start, range.end].
 * Series: pattern, until and skips are all honoured; loop is bounded to at most MAX_SERIES_STEPS.
 */
export function expandEventSeries<T extends CalendarEventInput>(event: T, range: DateRange): CalendarOccurrence<T>[] {
    const anchorDate = eventLocalDate(event);
    if (!anchorDate) return [];

    const { rule, until } = eventRepeatOf(event);

    // If not repeating or invalid rule, treat as single occurrence
    if (!rule) {
        if (anchorDate >= range.start && anchorDate <= range.end) {
            return [{
                ...event,
                date: anchorDate,
                isExpanded: false,
                baseEvent: event,
            }];
        }
        return [];
    }

    const interval = typeof rule.interval === 'number' && Number.isInteger(rule.interval) && rule.interval >= 1
        ? Math.min(rule.interval, 52)
        : 1;

    const skips = readEventSkips(event);
    const candidateDates: string[] = [];

    if (rule.freq === 'weekly') {
        const byDay = (REPEAT_WEEKDAYS as readonly string[]).includes(rule.byDay) ? rule.byDay : weekdayCodeOf(anchorDate);
        let currDate = anchorDate;
        while (weekdayCodeOf(currDate) !== byDay) {
            currDate = addDays(currDate, 1);
        }
        for (let k = 0; k < MAX_SERIES_STEPS; k++) {
            if (currDate > range.end) break;
            if (until && currDate > until) break;
            if (currDate >= range.start && !skips.has(currDate)) {
                candidateDates.push(currDate);
            }
            currDate = addDays(currDate, interval * 7);
        }
    } else if (rule.freq === 'monthly' && 'byMonthDay' in rule) {
        const day = rule.byMonthDay;
        if (typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 31) {
            const anchorY = +anchorDate.slice(0, 4);
            const anchorM0 = +anchorDate.slice(5, 7) - 1;
            for (let k = 0; k < MAX_SERIES_STEPS; k++) {
                const totalM = anchorM0 + k * interval;
                const y = anchorY + Math.floor(totalM / 12);
                const m0 = totalM % 12;
                const dim = daysInMonth(y, m0 + 1);
                if (day <= dim) {
                    const cand = formatLocalDate(y, m0 + 1, day);
                    if (cand >= anchorDate) {
                        if (cand > range.end) break;
                        if (until && cand > until) break;
                        if (cand >= range.start && !skips.has(cand)) {
                            candidateDates.push(cand);
                        }
                    }
                }
            }
        }
    } else if (rule.freq === 'monthly' && 'pos' in rule && 'byDay' in rule) {
        const pos = rule.pos;
        const byDay = rule.byDay;
        if ([1, 2, 3, 4, -1].includes(pos) && (REPEAT_WEEKDAYS as readonly string[]).includes(byDay)) {
            const anchorY = +anchorDate.slice(0, 4);
            const anchorM0 = +anchorDate.slice(5, 7) - 1;
            for (let k = 0; k < MAX_SERIES_STEPS; k++) {
                const totalM = anchorM0 + k * interval;
                const y = anchorY + Math.floor(totalM / 12);
                const m0 = totalM % 12;
                const cand = nthWeekdayOfMonth(y, m0, byDay, pos);
                if (cand && cand >= anchorDate) {
                    if (cand > range.end) break;
                    if (until && cand > until) break;
                    if (cand >= range.start && !skips.has(cand)) {
                        candidateDates.push(cand);
                    }
                }
            }
        }
    }

    const occurrences: CalendarOccurrence<T>[] = [];
    for (const cand of candidateDates) {
        const isExpanded = cand !== anchorDate;
        const dayOffset = daysBetween(anchorDate, cand);

        const baseStartLocal = event.eventStartLocal ?? event.event_start_local ?? null;
        const startTime = baseStartLocal && baseStartLocal.length >= 16 ? baseStartLocal.slice(11, 16) : '00:00';
        const startLocal = `${cand}T${startTime}`;

        const baseEndLocal = event.eventEndLocal ?? event.event_end_local ?? null;
        let endLocal: string | null = null;
        if (baseEndLocal && baseEndLocal.length >= 16 && isLocalDate(baseEndLocal.slice(0, 10))) {
            const baseStartDate = baseStartLocal && isLocalDate(baseStartLocal.slice(0, 10)) ? baseStartLocal.slice(0, 10) : anchorDate;
            const baseEndDate = baseEndLocal.slice(0, 10);
            const endOffset = daysBetween(baseStartDate, baseEndDate);
            const endTime = baseEndLocal.slice(11, 16);
            if (Number.isFinite(endOffset)) {
                endLocal = `${addDays(cand, endOffset)}T${endTime}`;
            }
        }

        const baseStartAt = event.eventStartAt ?? event.event_start_at ?? null;
        const parsedStart = baseStartAt ? Date.parse(baseStartAt) : NaN;
        const startAt = Number.isFinite(parsedStart)
            ? new Date(parsedStart + dayOffset * 86_400_000).toISOString()
            : `${startLocal}:00.000Z`;

        const baseEndAt = event.eventEndAt ?? event.event_end_at ?? null;
        const parsedEnd = baseEndAt ? Date.parse(baseEndAt) : NaN;
        let endAt: string | null = null;
        if (Number.isFinite(parsedEnd)) {
            endAt = new Date(parsedEnd + dayOffset * 86_400_000).toISOString();
        }

        occurrences.push({
            ...event,
            date: cand,
            eventStartLocal: startLocal,
            eventEndLocal: endLocal,
            eventStartAt: startAt,
            eventEndAt: endAt,
            ...(event.event_start_local !== undefined ? { event_start_local: startLocal } : {}),
            ...(event.event_end_local !== undefined ? { event_end_local: endLocal } : {}),
            ...(event.event_start_at !== undefined ? { event_start_at: startAt } : {}),
            ...(event.event_end_at !== undefined ? { event_end_at: endAt } : {}),
            isExpanded,
            baseEvent: event,
        });
    }

    return occurrences;
}

/** Group a list of events into a dictionary of local day ("YYYY-MM-DD") to occurrences. */
export function groupEventsByLocalDay<T extends CalendarEventInput>(
    events: readonly T[],
    range: DateRange
): Record<string, CalendarOccurrence<T>[]> {
    const result: Record<string, CalendarOccurrence<T>[]> = {};
    for (const event of events) {
        const occurrences = expandEventSeries(event, range);
        for (const occ of occurrences) {
            (result[occ.date] ??= []).push(occ);
        }
    }
    // Sort each day's occurrences soonest start first
    for (const day of Object.keys(result)) {
        result[day].sort((a, b) => {
            const timeA = a.eventStartAt ? Date.parse(a.eventStartAt) : utcOf(a.date);
            const timeB = b.eventStartAt ? Date.parse(b.eventStartAt) : utcOf(b.date);
            return timeA - timeB;
        });
    }
    return result;
}

/** Find the earliest event date occurring strictly after `afterDate`. */
export function findNextEventDateAfter<T extends CalendarEventInput>(
    events: readonly T[],
    afterDate: string
): string | null {
    const nextStart = addDays(afterDate, 1);
    const horizonEnd = addDays(afterDate, 365);
    let soonest: string | null = null;
    for (const event of events) {
        const occurrences = expandEventSeries(event, { start: nextStart, end: horizonEnd });
        for (const occ of occurrences) {
            if (occ.date > afterDate && (!soonest || occ.date < soonest)) {
                soonest = occ.date;
            }
        }
    }
    return soonest;
}

// ── Building the Month ────────────────────────────────────────────────────────────────────────────────────────

export interface BuildCalendarMonthOptions<T extends CalendarEventInput = CalendarEventInput> {
    /** The year to view (e.g. 2026). */
    year: number;
    /** The month to view (1–12). */
    month: number;
    /**
     * Today's local date as "YYYY-MM-DD" or Date or ISO string.
     * Pure: passed in from caller, never read from system clock.
     */
    now: string | Date;
    /** Events to display and expand in this month. */
    events?: readonly T[];
    /** Language to format headings and labels (defaults to active words language). */
    lang?: UiLang;
}

/**
 * Build the full calendar month model: cells, weeks, expanded events by day, headings and navigation targets.
 * Weeks start on Monday everywhere (Mo Tu We Th Fr Sa Su).
 */
export function buildCalendarMonth<T extends CalendarEventInput = CalendarEventInput>(
    options: BuildCalendarMonthOptions<T>
): CalendarMonth<T> {
    const { year, month } = options;
    const todayStr = typeof options.now === 'string'
        ? options.now.slice(0, 10)
        : dateOfUtc(options.now.getTime());

    const dim = daysInMonth(year, month);
    const monthStart = formatLocalDate(year, month, 1);
    const monthEnd = formatLocalDate(year, month, dim);
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;

    const eventsByDay = groupEventsByLocalDay(options.events ?? [], { start: monthStart, end: monthEnd });

    // Monday is index 0: (getUTCDay() + 6) % 7 maps Sun(0)->6, Mon(1)->0, Tue(2)->1...
    const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;

    const cells: CalendarCell<T>[] = [];

    // Leading padding cells
    for (let i = 0; i < firstWeekday; i++) {
        cells.push({
            date: null,
            day: null,
            inMonth: false,
            isToday: false,
            isPast: false,
            hasEvents: false,
            eventCount: 0,
            events: [],
        });
    }

    // Days of the month
    let totalEvents = 0;
    for (let d = 1; d <= dim; d++) {
        const date = formatLocalDate(year, month, d);
        const dayEvents = eventsByDay[date] ?? [];
        const isToday = date === todayStr;
        const isPast = date < todayStr;
        const hasEvents = !isPast && dayEvents.length > 0;
        if (!isPast) totalEvents += dayEvents.length;

        cells.push({
            date,
            day: d,
            inMonth: true,
            isToday,
            isPast,
            hasEvents,
            eventCount: dayEvents.length,
            events: dayEvents,
        });
    }

    // Trailing padding cells to complete full 7-day rows
    const remainder = cells.length % 7;
    const trailingCount = remainder === 0 ? 0 : 7 - remainder;
    for (let i = 0; i < trailingCount; i++) {
        cells.push({
            date: null,
            day: null,
            inMonth: false,
            isToday: false,
            isPast: false,
            hasEvents: false,
            eventCount: 0,
            events: [],
        });
    }

    // Group cells into weeks (7 cells per week)
    const weeks: CalendarCell<T>[][] = [];
    for (let i = 0; i < cells.length; i += 7) {
        weeks.push(cells.slice(i, i + 7));
    }

    // First active date: first date in this month on or after today with events
    let firstActiveDate: string | null = null;
    for (const cell of cells) {
        if (cell.inMonth && !cell.isPast && cell.hasEvents && cell.date) {
            firstActiveDate = cell.date;
            break;
        }
    }

    const nextEventDate = findNextEventDateAfter(options.events ?? [], monthEnd);

    const prevMonth = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    const isCurrentOrPastMonth = monthStart <= todayStr.slice(0, 7) + '-01';

    const heading = calendarMonthHeading(year, month, options.lang);
    const weekdayHeaders = calendarWeekdayLabels(options.lang);

    return {
        year,
        month,
        monthKey,
        heading,
        weekdayHeaders,
        cells,
        weeks,
        eventsByDay,
        totalEvents,
        firstActiveDate,
        nextEventDate,
        prevMonth,
        nextMonth,
        isCurrentOrPastMonth,
    };
}

// ── Words & Headings ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Return date words for a language (or English fallback).
 */
function dateWordsForLang(lang?: UiLang): DateWords {
    const target = lang ?? currentLanguage();
    const wordsTable = DATE_WORDS;
    return (target && wordsTable[target as keyof typeof wordsTable]) ?? wordsTable.en!;
}

/**
 * The month heading: e.g. "November 2026".
 * Uses core's `formatDate` 'month-year' pattern, available in all 25 languages.
 */
export function calendarMonthHeading(year: number, month: number, lang?: UiLang): string {
    const d = new Date(Date.UTC(year, month - 1, 1));
    return formatDate(d, 'month-year', { utc: true, lang, width: 'long' });
}

/**
 * The 7 weekday labels starting from Monday (Mo Tu We Th Fr Sa Su).
 * Formatted with `formatDate` 'weekday', available in all 25 languages.
 */
export function calendarWeekdayLabels(lang?: UiLang, width: 'short' | 'long' = 'short'): string[] {
    // 5 Oct 2026 is a Monday (5=Mon, 6=Tue, 7=Wed, 8=Thu, 9=Fri, 10=Sat, 11=Sun)
    const labels: string[] = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(Date.UTC(2026, 9, 5 + i));
        labels.push(formatDate(d, 'weekday', { utc: true, lang, width }));
    }
    return labels;
}

/**
 * Heading for a day's list in the calendar:
 * When count > 0: "Sat 7 Nov: 2 events" (or "Sat 7 Nov: 1 event")
 * When count = 0: "Nothing on Tue 11 Nov"
 */
export function calendarDayHeading(date: string, count: number, lang?: UiLang): string {
    const d = new Date(utcOf(date));
    const formattedDate = formatDate(d, 'weekday-day-month', { utc: true, lang });
    if (lang) {
        const w = wordsFor(lang);
        if (count <= 0) {
            return w.t('Nothing on {date}', { date: formattedDate });
        }
        return w.tn(count, '{date}: {n} event', '{date}: {n} events', { date: formattedDate });
    }
    if (count <= 0) {
        return t('Nothing on {date}', { date: formattedDate });
    }
    return tn(count, '{date}: {n} event', '{date}: {n} events', { date: formattedDate });
}

/**
 * Text shown under weekday row when a month has no events: "Nothing on in November."
 */
export function calendarMonthEmptyText(year: number, month: number, lang?: UiLang): string {
    const w = dateWordsForLang(lang);
    const monthName = w.monthsStandalone[month - 1] ?? w.monthsLong[month - 1];
    if (lang) {
        return wordsFor(lang).t('Nothing on in {month}.', { month: monthName });
    }
    return t('Nothing on in {month}.', { month: monthName });
}

/**
 * Text for jumping to the next upcoming event: "Next: Sat 6 Dec ›".
 */
export function calendarNextEventLabel(date: string, lang?: UiLang): string {
    const d = new Date(utcOf(date));
    const formattedDate = formatDate(d, 'weekday-day-month', { utc: true, lang });
    if (lang) {
        return wordsFor(lang).t('Next: {date} ›', { date: formattedDate });
    }
    return t('Next: {date} ›', { date: formattedDate });
}

/** Text shown when no events are coming up at all. */
export function calendarNoEventsComingUpText(lang?: UiLang): string {
    if (lang) return wordsFor(lang).t('No events coming up yet.');
    return t('No events coming up yet.');
}

/** Link text to start an event from the empty calendar state. */
export function calendarStartOneText(lang?: UiLang): string {
    if (lang) return wordsFor(lang).t('Start one ›');
    return t('Start one ›');
}

/** Screen title / button accessibility label: "Calendar". */
export function calendarTitle(lang?: UiLang): string {
    if (lang) return wordsFor(lang).t('Calendar');
    return t('Calendar');
}
