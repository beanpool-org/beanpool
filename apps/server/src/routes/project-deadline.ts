/**
 * A project's deadline, as every route that sets one reads it: POST /api/crowdfund/projects, /update, and
 * POST /api/enterprise (/api/treasury) for a bounded enterprise, which is a crowdfund project. One check, so a value
 * one of them refuses cannot be stored through another (#1705 checked the crowdfund routes only, and both apps make
 * projects through /api/enterprise).
 *
 * Nothing, null or '' is no deadline. Anything else must be an ISO 8601 string, a date (2026-12-31) or a date-time with
 * Z or an offset (2026-12-31T17:00:00.000Z, 2026-12-31T17:00+10:00), that names a real day and time and is at most
 * maxProjectExpiryDays ahead, and not in the past. It is stored as toISOString(), so what both apps send
 * (Date.toISOString()) is stored as sent. V8's `new Date(x)` is not the test: it reads 'garbage 1' as 2001, and a
 * number or a boolean is no date.
 *
 * Not in the past (Marty, 9 Oct: "Refuse it"): a new or edited project must end today or later. Only a deadline that
 * is sent is held to this, so an edit that leaves deadlineAt out keeps a deadline that has since passed.
 */

export const PROJECT_DEADLINE_FORMAT_ERROR =
    "A project's deadline must be a date, like 2026-12-31 or 2026-12-31T17:00:00Z.";
export const projectDeadlineTooFarError = (maxDays: number) =>
    `A project's deadline can be at most ${maxDays} days away.`;
export const PROJECT_DEADLINE_PAST_ERROR = "A project's deadline can't be in the past.";

const ISO_DEADLINE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/;
const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * How far before now a deadline may be and still be today for the member who sent it, in whatever time zone they are.
 * The server cannot know it, so "today" is today anywhere on Earth. The PWA's date field sends the chosen day as UTC
 * midnight (new Date('2026-10-09') is 2026-10-09T00:00:00.000Z), and so does a date alone; that day is still today at
 * UTC-12, the last place it ends, until 12:00 UTC the next day: 36 hours after that midnight. A date-time inside the
 * member's own day (the native picker) is never more than 25 hours old (a day with a clock change). So anything no
 * earlier than 36 hours before now is taken, and anything earlier is yesterday or before in every time zone. 24 hours
 * would not do: at 21:00 in New York (UTC-4) the PWA's "today" is already 25 hours old.
 */
const TODAY_ANYWHERE_MS = 36 * 60 * 60 * 1000;

function daysInMonth(year: number, month: number): number {
    if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The instant an ISO 8601 deadline names, or null when it is not one or names no real day and time. */
function isoDeadlineMs(text: string): number | null {
    const m = ISO_DEADLINE.exec(text);
    if (!m) return null;
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone = 'Z'] = m;
    const year = Number(y), month = Number(mo), day = Number(d);
    const hour = Number(h), minute = Number(mi), second = Number(s);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    let offsetMinutes = 0;
    if (zone !== 'Z') {
        const oh = Number(zone.slice(1, 3)), om = Number(zone.slice(4, 6));
        if (oh > 23 || om > 59) return null;
        offsetMinutes = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om);
    }
    // setUTCFullYear, not Date.UTC, which reads years 0-99 as 1900-1999.
    const at = new Date(0);
    at.setUTCFullYear(year, month - 1, day);
    at.setUTCHours(hour, minute, second, Number(frac.padEnd(3, '0').slice(0, 3)));
    return at.getTime() - offsetMinutes * 60 * 1000;
}

export type ProjectDeadline = { deadline: string | null } | { error: string };

/** Reads a sent deadlineAt: `{ deadline }` to store (null for none), or `{ error }` to answer with a 400. */
export function readProjectDeadline(raw: unknown, maxDays: number, now: number = Date.now()): ProjectDeadline {
    if (raw === undefined || raw === null || raw === '') return { deadline: null };
    if (typeof raw !== 'string') return { error: PROJECT_DEADLINE_FORMAT_ERROR };
    const ms = isoDeadlineMs(raw);
    if (ms === null || Number.isNaN(ms)) return { error: PROJECT_DEADLINE_FORMAT_ERROR };
    if (ms < now - TODAY_ANYWHERE_MS) return { error: PROJECT_DEADLINE_PAST_ERROR };
    if ((ms - now) / DAY_MS > maxDays) return { error: projectDeadlineTooFarError(maxDays) };
    return { deadline: new Date(ms).toISOString() };
}
