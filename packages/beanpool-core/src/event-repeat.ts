/**
 * How a repeating event reads, for both apps (design: scratch/global-node/DESIGN-event-times-fable.md §3, §4 and §8; the
 * node's side is @beanpool/engine event-series.ts, #1945). The form's "Repeats" choices are computed from the first date
 * the host picked, so there is nothing to type; the card's ↻ caption, the detail's "Next dates" and the host's lines read
 * the rule the node sends back. String work on "YYYY-MM-DD" dates: no Intl, no zone (the dates are already the event's own).
 *
 * The app sends the PATTERN only ({freq, interval, byDay | byMonthDay, pos}); the node adds the host's clock and each
 * date's length (`time`, `minutes`) from the form's start and end, and refuses a first date that is not one of the rule's.
 */

import { formatDate, t } from './words.js';

/** Weekday codes, Sunday first, like Date#getUTCDay (the node's EVENT_REPEAT_WEEKDAYS). */
export const REPEAT_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type RepeatWeekdayCode = (typeof REPEAT_WEEKDAYS)[number];

/** What an app sends as `eventRepeat`: the closed shape, never RRULE text. */
export type RepeatPattern =
    | { freq: 'weekly'; interval: number; byDay: RepeatWeekdayCode }
    | { freq: 'monthly'; interval: number; byMonthDay: number }
    | { freq: 'monthly'; interval: number; byDay: RepeatWeekdayCode; pos: 1 | 2 | 3 | 4 | -1 };

/** The form's choices. */
export type RepeatChoiceKey = 'never' | 'weekly' | 'fortnightly' | 'monthly-day' | 'monthly-nth' | 'monthly-last';

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

function nthWeekdayCaption(pos: 1 | 2 | 3 | 4 | -1, weekday: string): string {
    if (pos === 1) return t('Monthly, first {weekday}', { weekday });
    if (pos === 2) return t('Monthly, second {weekday}', { weekday });
    if (pos === 3) return t('Monthly, third {weekday}', { weekday });
    if (pos === 4) return t('Monthly, fourth {weekday}', { weekday });
    return t('Monthly, last {weekday}', { weekday });
}

/** The pattern a choice means on this first date; null for "Does not repeat" or a choice this date does not offer. */
export function repeatPatternFor(key: RepeatChoiceKey, firstDate: string): RepeatPattern | null {
    if (key === 'never' || !choiceKeysFor(firstDate).includes(key)) return null;
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

/** A stored rule (or pattern) back to its choice, for the edit form. Anything the form cannot show reads as weekly-ish never. */
export function repeatChoiceKeyOf(rule: Partial<RepeatPattern> | null | undefined): RepeatChoiceKey {
    if (!rule || typeof rule !== 'object') return 'never';
    const r = rule as Record<string, unknown>;
    if (r.freq === 'weekly') return r.interval === 2 ? 'fortnightly' : 'weekly';
    if (r.freq === 'monthly') {
        if (typeof r.byMonthDay === 'number') return 'monthly-day';
        return r.pos === -1 ? 'monthly-last' : 'monthly-nth';
    }
    return 'never';
}

/** "(months without a 31st are skipped)", shown under the select for monthly on the 29th–31st; null otherwise. */
export function repeatSkipNote(key: RepeatChoiceKey, firstDate: string): string | null {
    if (key !== 'monthly-day' || !isDate(firstDate)) return null;
    const day = dateOf(utcOf(firstDate)).getUTCDate();
    return day >= 29 ? t('(months without a {day} are skipped)', { day: dayOrdinal(day) }) : null;
}

/** "18 Dec": a local date, from the tables. */
function shortDate(date: string): string {
    return formatDate(dateOf(utcOf(date)), 'day-month', { utc: true });
}

/**
 * The ↻ caption beside a repeating event's date: "Every Friday", "Every 2 weeks on Friday", "Monthly on the 16th",
 * "Monthly, third Friday", and " · until 18 Dec" when it has a last date. '' for a one-off or a rule this build cannot read.
 */
export function repeatCaption(rule: Partial<RepeatPattern> | null | undefined, until?: string | null): string {
    if (!rule || typeof rule !== 'object') return '';
    const r = rule as Record<string, unknown>;
    const interval = typeof r.interval === 'number' ? r.interval : 1;
    const byDay = (REPEAT_WEEKDAYS as readonly unknown[]).includes(r.byDay) ? (r.byDay as RepeatWeekdayCode) : null;
    let caption = '';
    if (r.freq === 'weekly' && byDay) {
        const weekday = weekdayName(byDay);
        caption = interval === 1
            ? t('Every {weekday}', { weekday })
            : t('Every {n} weeks on {weekday}', { n: String(interval), weekday });
    } else if (r.freq === 'monthly' && typeof r.byMonthDay === 'number') {
        caption = t('Monthly on the {day}', { day: dayOrdinal(r.byMonthDay) });
    } else if (r.freq === 'monthly' && byDay && [1, 2, 3, 4, -1].includes(r.pos as number)) {
        caption = nthWeekdayCaption(r.pos as 1 | 2 | 3 | 4 | -1, weekdayName(byDay));
    }
    if (!caption) return '';
    return isDate(until) ? t('{repeats} · until {date}', { repeats: caption, date: shortDate(until) }) : caption;
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

/** The one line "Change this date only" prefills the copy with: "Moved from the regular Friday". */
export function seriesMovedFromLine(rule: Partial<RepeatPattern> | null | undefined): string {
    const r = (rule ?? {}) as Record<string, unknown>;
    const byDay = (REPEAT_WEEKDAYS as readonly unknown[]).includes(r.byDay) ? (r.byDay as RepeatWeekdayCode) : null;
    return byDay ? t('Moved from the regular {weekday}', { weekday: weekdayName(byDay) }) : t('Moved from the regular date');
}
