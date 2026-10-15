/**
 * How a repeating event reads, for both apps (design: scratch/global-node/DESIGN-event-times-fable.md §3, §4 and §8; the
 * node's side is @beanpool/engine event-series.ts, #1945). The form's "Repeats" choices are computed from the first date
 * the host picked, so there is nothing to type; the card's ↻ caption, the detail's "Next dates" and the host's lines read
 * the rule the node sends back. String work on "YYYY-MM-DD" dates: no Intl, no zone (the dates are already the event's own).
 *
 * The app sends the PATTERN only ({freq, interval, byDay | byMonthDay, pos}); the node adds the host's clock and each
 * date's length (`time`, `minutes`) from the form's start and end, and refuses a first date that is not one of the rule's.
 */

import { formatDate, t, tn, word, type WordKey } from './words.js';

/** Weekday codes, Sunday first, like Date#getUTCDay (the node's EVENT_REPEAT_WEEKDAYS). */
export const REPEAT_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type RepeatWeekdayCode = (typeof REPEAT_WEEKDAYS)[number];

/** What an app sends as `eventRepeat`: the closed shape, never RRULE text. */
export type RepeatPattern =
    | { freq: 'weekly'; interval: number; byDay: RepeatWeekdayCode }
    | { freq: 'monthly'; interval: number; byMonthDay: number }
    | { freq: 'monthly'; interval: number; byDay: RepeatWeekdayCode; pos: 1 | 2 | 3 | 4 | -1 };

/**
 * The form's choices. 'other' is a stored rule the form cannot make (every 3 weeks, every 3 months: the node takes an
 * interval of 1 to 12): never offered and never a pattern, so an edit keeps the rule as it is or asks the host to choose.
 */
export type RepeatChoiceKey = 'never' | 'weekly' | 'fortnightly' | 'monthly-day' | 'monthly-nth' | 'monthly-last' | 'other';

export interface RepeatChoice {
    key: RepeatChoiceKey;
    label: string;
}

/** How many years after the first date `until` may be (the node's EVENT_REPEAT_UNTIL_MAX_YEARS). */
export const REPEAT_UNTIL_MAX_YEARS = 5;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcOf(date: string): number {
    const m = DATE_RE.exec(date);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

/** A real "YYYY-MM-DD". */
function isDate(v: unknown): v is string {
    if (typeof v !== 'string') return false;
    const ms = utcOf(v);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}

function dateOf(ms: number): Date {
    return new Date(ms);
}

/** The weekday's name, in the reader's language ("Friday"), from the tables (formatDate, never Intl). */
function weekdayName(code: RepeatWeekdayCode): string {
    // 4 Oct 2026 is a Sunday: Sunday + index is that weekday.
    return formatDate(dateOf(Date.UTC(2026, 9, 4 + REPEAT_WEEKDAYS.indexOf(code))), 'weekday', { utc: true, width: 'long' });
}

/** "16th", "1st", "22nd": the day of the month as an ordinal, each ending its own sentence so a language can drop it. */
function dayOrdinal(day: number): string {
    const n = String(day);
    const teen = day % 100 >= 11 && day % 100 <= 13;
    if (!teen && day % 10 === 1) return t('{n}st', { n }, 'day of the month');
    if (!teen && day % 10 === 2) return t('{n}nd', { n }, 'day of the month');
    if (!teen && day % 10 === 3) return t('{n}rd', { n }, 'day of the month');
    return t('{n}th', { n }, 'day of the month');
}

function weekdayCodeOf(date: string): RepeatWeekdayCode {
    return REPEAT_WEEKDAYS[dateOf(utcOf(date)).getUTCDay()];
}

/** Which of its weekday in the month a date is (1–5), and whether it is the last one. */
function weekdayPos(date: string): { nth: number; last: boolean } {
    const d = dateOf(utcOf(date));
    const day = d.getUTCDate();
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return { nth: Math.ceil(day / 7), last: day + 7 > dim };
}

/** The keys the first date offers, in the select's order. A 5th weekday is only ever "the last". */
function choiceKeysFor(firstDate: string): RepeatChoiceKey[] {
    if (!isDate(firstDate)) return ['never'];
    const { nth, last } = weekdayPos(firstDate);
    const keys: RepeatChoiceKey[] = ['never', 'weekly', 'fortnightly', 'monthly-day'];
    if (nth <= 4) keys.push('monthly-nth');
    if (last) keys.push('monthly-last');
    return keys;
}

/** "Every month on the third Friday": one whole sentence per position, so a language orders it its own way. */
function nthWeekdayLabel(pos: 1 | 2 | 3 | 4 | -1, weekday: string): string {
    if (pos === 1) return t('Every month on the first {weekday}', { weekday });
    if (pos === 2) return t('Every month on the second {weekday}', { weekday });
    if (pos === 3) return t('Every month on the third {weekday}', { weekday });
    if (pos === 4) return t('Every month on the fourth {weekday}', { weekday });
    return t('Every month on the last {weekday}', { weekday });
}

function nthWeekdayCaption(pos: 1 | 2 | 3 | 4 | -1, weekday: string, interval: number): string {
    if (interval > 1) {
        // Every 3 months, third Friday: the count with its own plural forms, one whole sentence per position.
        if (pos === 1) return tn(interval, 'Monthly, first {weekday}', 'Every {n} months, first {weekday}', { weekday });
        if (pos === 2) return tn(interval, 'Monthly, second {weekday}', 'Every {n} months, second {weekday}', { weekday });
        if (pos === 3) return tn(interval, 'Monthly, third {weekday}', 'Every {n} months, third {weekday}', { weekday });
        if (pos === 4) return tn(interval, 'Monthly, fourth {weekday}', 'Every {n} months, fourth {weekday}', { weekday });
        return tn(interval, 'Monthly, last {weekday}', 'Every {n} months, last {weekday}', { weekday });
    }
    if (pos === 1) return t('Monthly, first {weekday}', { weekday });
    if (pos === 2) return t('Monthly, second {weekday}', { weekday });
    if (pos === 3) return t('Monthly, third {weekday}', { weekday });
    if (pos === 4) return t('Monthly, fourth {weekday}', { weekday });
    return t('Monthly, last {weekday}', { weekday });
}

/** The pattern a choice means on this first date; null for "Does not repeat" or a choice this date does not offer. */
export function repeatPatternFor(key: RepeatChoiceKey, firstDate: string): RepeatPattern | null {
    if (key === 'never' || key === 'other' || !choiceKeysFor(firstDate).includes(key)) return null;
    const byDay = weekdayCodeOf(firstDate);
    if (key === 'weekly') return { freq: 'weekly', interval: 1, byDay };
    if (key === 'fortnightly') return { freq: 'weekly', interval: 2, byDay };
    if (key === 'monthly-day') return { freq: 'monthly', interval: 1, byMonthDay: dateOf(utcOf(firstDate)).getUTCDate() };
    if (key === 'monthly-last') return { freq: 'monthly', interval: 1, byDay, pos: -1 };
    return { freq: 'monthly', interval: 1, byDay, pos: weekdayPos(firstDate).nth as 1 | 2 | 3 | 4 };
}

/** The Repeats select's options for a first date, labelled in the reader's language. */
export function repeatChoicesFor(firstDate: string): RepeatChoice[] {
    return choiceKeysFor(firstDate).map((key) => {
        const p = repeatPatternFor(key, firstDate);
        if (!p) return { key, label: t('Does not repeat') };
        if (p.freq === 'weekly') {
            const weekday = weekdayName(p.byDay);
            return { key, label: p.interval === 1 ? t('Every week on {weekday}', { weekday }) : t('Every 2 weeks on {weekday}', { weekday }) };
        }
        if ('byMonthDay' in p) return { key, label: t('Every month on the {day}', { day: dayOrdinal(p.byMonthDay) }) };
        return { key, label: nthWeekdayLabel(p.pos, weekdayName(p.byDay)) };
    });
}

/**
 * A stored rule (or pattern) back to its choice, for the edit form. A rule the form cannot make (every 3 weeks, every 3
 * months, a frequency this build does not know) is 'other', never the nearest choice: the form would re-send that one and
 * quietly turn a quarterly series monthly (the deciding review of #1993, N3).
 */
export function repeatChoiceKeyOf(rule: Partial<RepeatPattern> | null | undefined): RepeatChoiceKey {
    if (!rule || typeof rule !== 'object') return 'never';
    const r = rule as Record<string, unknown>;
    if (r.freq == null) return 'never';
    const interval = r.interval ?? 1;
    if (r.freq === 'weekly') return interval === 1 ? 'weekly' : interval === 2 ? 'fortnightly' : 'other';
    if (r.freq === 'monthly' && interval === 1) {
        if (typeof r.byMonthDay === 'number') return 'monthly-day';
        if (r.pos === -1) return 'monthly-last';
        if ([1, 2, 3, 4].includes(r.pos as number)) return 'monthly-nth';
    }
    return 'other';
}

/** The shortest gap between two dates of a choice, in minutes (the node's shortestGapMinutes); null for none. */
function choiceGapMinutes(key: RepeatChoiceKey): number | null {
    if (key === 'weekly') return 7 * 1440;
    if (key === 'fortnightly') return 14 * 1440;
    if (key === 'monthly-day' || key === 'monthly-nth' || key === 'monthly-last') return 28 * 1440;
    return null;
}

/**
 * Why a date this long (wall minutes, start to end) can't repeat this way, before Save, in the node's own sentence: each
 * date must end before the next one starts (an 8-day event is never "Every week"). Null when it can, for "Does not
 * repeat", a choice the first date does not offer (that has its own line) and an unknown length.
 */
export function repeatLengthProblem(key: RepeatChoiceKey, firstDate: string, minutes: number): string | null {
    const gap = choiceGapMinutes(key);
    if (gap == null || !Number.isFinite(minutes) || !choiceKeysFor(firstDate).includes(key)) return null;
    return minutes >= gap ? t('An event that repeats must end before its next date starts') : null;
}

/** "(months without a 31st are skipped)", shown under the select for monthly on the 29th–31st; null otherwise. */
export function repeatSkipNote(key: RepeatChoiceKey, firstDate: string): string | null {
    if (key !== 'monthly-day' || !isDate(firstDate)) return null;
    const day = dateOf(utcOf(firstDate)).getUTCDate();
    return day >= 29 ? t('(months without a {day} are skipped)', { day: dayOrdinal(day) }) : null;
}

/**
 * "18 Dec 2026": a series' last date, from the tables, for the caption and the phone's Until button. With its year: a
 * last date can be years away, and "until 15 Dec" reads as this one. '' for an unreadable date.
 */
export function repeatUntilLabel(date: string): string {
    return isDate(date) ? formatDate(dateOf(utcOf(date)), 'day-month-year', { utc: true }) : '';
}

/**
 * The ↻ caption beside a repeating event's date: "Every Friday", "Every 2 weeks on Friday", "Monthly on the 16th",
 * "Monthly, third Friday", "Every 3 months on the 16th" (the node takes an interval of 1 to 12, whoever wrote the rule), and
 * " · until 18 Dec 2026" when it has a last date. '' for a one-off or a rule this build cannot read.
 */
export function repeatCaption(rule: Partial<RepeatPattern> | null | undefined, until?: string | null): string {
    if (!rule || typeof rule !== 'object') return '';
    const r = rule as Record<string, unknown>;
    const interval = typeof r.interval === 'number' ? r.interval : 1;
    const byDay = (REPEAT_WEEKDAYS as readonly unknown[]).includes(r.byDay) ? (r.byDay as RepeatWeekdayCode) : null;
    let caption = '';
    if (r.freq === 'weekly' && byDay) {
        const weekday = weekdayName(byDay);
        // The count with its own plural forms, as the monthly ones: Russian says 2–4 weeks and 5–12 weeks differently.
        caption = interval > 1
            ? tn(interval, 'Every {weekday}', 'Every {n} weeks on {weekday}', { weekday })
            : t('Every {weekday}', { weekday });
    } else if (r.freq === 'monthly' && typeof r.byMonthDay === 'number') {
        const day = dayOrdinal(r.byMonthDay);
        caption = interval > 1
            ? tn(interval, 'Monthly on the {day}', 'Every {n} months on the {day}', { day })
            : t('Monthly on the {day}', { day });
    } else if (r.freq === 'monthly' && byDay && [1, 2, 3, 4, -1].includes(r.pos as number)) {
        caption = nthWeekdayCaption(r.pos as 1 | 2 | 3 | 4 | -1, weekdayName(byDay), interval);
    }
    if (!caption) return '';
    return isDate(until) ? t('{repeats} · until {date}', { repeats: caption, date: repeatUntilLabel(until) }) : caption;
}

/** The latest Until a first date allows ("YYYY-MM-DD"), the node's latestUntil. '' for an unreadable date. */
export function repeatUntilMax(firstDate: string): string {
    if (!isDate(firstDate)) return '';
    const d = dateOf(utcOf(firstDate));
    d.setUTCFullYear(d.getUTCFullYear() + REPEAT_UNTIL_MAX_YEARS);
    return d.toISOString().slice(0, 10);
}

/** Why an Until cannot be saved, in the node's own words, or null (empty = until cancelled). */
export function repeatUntilProblem(until: string | null | undefined, firstDate: string): string | null {
    if (!until) return null;
    if (!isDate(until) || until < firstDate) return t('The last date must be a date on or after the first one');
    if (until > repeatUntilMax(firstDate)) return t('The last date can be at most {n} years after the first one', { n: String(REPEAT_UNTIL_MAX_YEARS) });
    return null;
}

/** "Fri 23 Oct": one of the detail's Next dates. */
export function seriesDateLabel(date: string): string {
    if (!isDate(date)) return '';
    return formatDate(dateOf(utcOf(date)), 'weekday-day-month', { utc: true });
}

/**
 * What the host reads after cancelling the event's current date, as the node tells those going: "Fri 16 Oct is
 * cancelled. Next: Fri 23 Oct". `nextStartLocal` is the date the node moved the event to ("YYYY-MM-DDTHH:MM").
 */
export function seriesCancelledLine(cancelledDate: string, nextStartLocal: string | null | undefined): string {
    const date = seriesDateLabel(cancelledDate);
    const next = nextStartLocal ? seriesDateLabel(nextStartLocal.slice(0, 10)) : '';
    return next ? t('{date} is cancelled. Next: {next}', { date, next }) : t('{date} is cancelled.', { date });
}

/** What the host reads after bringing back the date they cancelled, as the node tells those going: "Fri 16 Oct is back on". */
export function seriesBackOnLine(date: string): string {
    return t('{date} is back on', { date: seriesDateLabel(date) });
}

/** One of the node's Next dates, as far as the list's timing needs it: a cancelled date the event has passed has its end. */
export interface SeriesListedDate { date: string; endAt?: string }

/**
 * The node's Next dates as the detail shows them at `nowMs`: a cancelled date the event has passed (before `current`, its
 * date now) is left out once it has ended, as the node no longer lists it or takes it back then (confirmation 2 of #1993,
 * NB2). An older node's list, without ends, as it is.
 */
export function seriesDatesShown<T extends SeriesListedDate>(dates: readonly T[] | null | undefined, current: string | null | undefined, nowMs: number): T[] {
    return (dates ?? []).filter(d => !(current && d.date < current && d.endAt && Date.parse(d.endAt) <= nowMs));
}

/** When the next passed cancelled date on the list ends (ms), for the detail to drop it then; null when none is listed. */
export function seriesPassedDateEndMs(dates: readonly SeriesListedDate[] | null | undefined, current: string | null | undefined, nowMs: number): number | null {
    const ends = (dates ?? []).filter(d => current && d.date < current && d.endAt).map(d => Date.parse(d.endAt!)).filter(ms => ms > nowMs);
    return ends.length > 0 ? Math.min(...ends) : null;
}

/** The one line "Change this date only" prefills the copy with: "Moved from the regular Friday". */
export function seriesMovedFromLine(rule: Partial<RepeatPattern> | null | undefined): string {
    const r = (rule ?? {}) as Record<string, unknown>;
    const byDay = (REPEAT_WEEKDAYS as readonly unknown[]).includes(r.byDay) ? (r.byDay as RepeatWeekdayCode) : null;
    return byDay ? t('Moved from the regular {weekday}', { weekday: weekdayName(byDay) }) : t('Moved from the regular date');
}

/**
 * The node's refusals for a repeating event (@beanpool/engine REPEAT_ERRORS, apps/server engine/event-series-roll.ts), marked
 * for the words layer, so the form and the detail can show the node's own sentence in the reader's language.
 */
const REPEAT_REFUSALS: readonly WordKey[] = [
    word('Choose how the event repeats from the list'),
    word('An event can repeat every 1 to 12 weeks or months'),
    word('The first date must be one of the repeating dates'),
    word('The last date must be a date on or after the first one'),
    word('The last date can be at most 5 years after the first one'),
    word('An event that repeats must end before its next date starts'),
    word('Pick one of the dates this event repeats on'),
    word('This event does not repeat'),
    word('Only the host can cancel or restore a date'),
    word('This is the last date: change when the event ends, or cancel the event'),
    word('At most 100 dates can be cancelled'),
    // Not the series' own, but a host meets them here: a date changed on an event cancelled meanwhile (the skip route), and
    // a repeating online event saved with no zone (the node's create and edit).
    word('This event has been cancelled'),
    word('Pick a time zone from the list'),
];

/** A node's refusal of a series write, in the reader's language when it is one of the node's repeat sentences; else as sent. */
export function repeatRefusalText(message: string | null | undefined): string {
    const m = typeof message === 'string' ? message.trim() : '';
    const i = REPEAT_REFUSALS.indexOf(m as WordKey);
    return i >= 0 ? t(REPEAT_REFUSALS[i]) : m;
}
