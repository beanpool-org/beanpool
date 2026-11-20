/**
 * Years for suites that make events on set dates (date bombs, 19 Nov: close the class). The server refuses an event that
 * starts in the past (engine/posts.ts, "An event must start in the future"), so a suite written on fixed 2027 dates goes red
 * once they pass: test-event-times-http on 15 Jan 2027, test-event-series-http at the end of that month.
 *
 * `Y27` is the first year at least two years from now that is laid out as 2027 is, and `Y28` (the year after) as 2028 is:
 * 2027 + 28k, as the calendar repeats every 28 years from 1901 to 2099. The same weekdays, so "every Friday" lands on the
 * same dates, and the same Sundays, so Sydney's daylight saving (first Sundays of October and April) and Europe's (last
 * Sundays of March and October) change on the same days. Read in 2026 it is 2055; it moves on by itself as the years pass.
 */
export function yearLike2027(now = Date.now()): number {
    const thisYear = new Date(now).getUTCFullYear();
    let year = 2027;
    while (year < thisYear + 2) year += 28;
    return year;
}

export const Y27 = yearLike2027();
export const Y28 = Y27 + 1;
