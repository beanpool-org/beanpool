import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildCalendarMonth,
    calendarDayHeading,
    calendarMonthEmptyText,
    calendarMonthHeading,
    calendarNextEventLabel,
    calendarNoEventsComingUpText,
    calendarStartOneText,
    calendarTitle,
    calendarWeekdayLabels,
    addDays,
    daysInMonth,
    eventLocalDate,
    expandEventSeries,
    findNextEventDateAfter,
    findNextOccurrenceAfter,
    groupEventsByLocalDay,
    isLeapYear,
    weekdayCodeOf,
    type CalendarEventInput,
} from '../calendar-month.js';
import { setLanguage } from '../words.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const loadCatalog = (lang: string) =>
    JSON.parse(readFileSync(join(root, `packages/beanpool-core/words/${lang}.json`), 'utf8')) as Record<string, unknown>;

describe('calendar-month: pure (no Intl, no clock read, now passed in)', () => {
    it('does not read the clock: now is passed in and determines isToday and isPast', () => {
        const events: CalendarEventInput[] = [
            { id: 'ev-1', eventStartLocal: '2026-11-10T14:00', title: 'Bee' },
            { id: 'ev-2', eventStartLocal: '2026-11-15T10:00', title: 'Market' },
        ];

        // Now set to 10 Nov 2026
        const m1 = buildCalendarMonth({ year: 2026, month: 11, now: '2026-11-10', events });
        const cell10 = m1.cells.find((c) => c.date === '2026-11-10')!;
        const cell9 = m1.cells.find((c) => c.date === '2026-11-09')!;
        const cell11 = m1.cells.find((c) => c.date === '2026-11-11')!;

        expect(cell10.isToday).toBe(true);
        expect(cell10.isPast).toBe(false);
        expect(cell9.isToday).toBe(false);
        expect(cell9.isPast).toBe(true);
        expect(cell11.isToday).toBe(false);
        expect(cell11.isPast).toBe(false);
        expect(m1.firstActiveDate).toBe('2026-11-10');

        // Now shifted to 12 Nov 2026: 10 Nov becomes past, firstActiveDate advances to 15 Nov
        const m2 = buildCalendarMonth({ year: 2026, month: 11, now: '2026-11-12', events });
        const cell10m2 = m2.cells.find((c) => c.date === '2026-11-10')!;
        expect(cell10m2.isToday).toBe(false);
        expect(cell10m2.isPast).toBe(true);
        // Past days show no dots and have eventCount 0 (active events only), while preserving cell.events
        expect(cell10m2.hasEvents).toBe(false);
        expect(cell10m2.eventCount).toBe(0);
        expect(cell10m2.events).toHaveLength(1);
        const cell15m2 = m2.cells.find((c) => c.date === '2026-11-15')!;
        expect(cell15m2.isToday).toBe(false);
        expect(cell15m2.isPast).toBe(false);
        expect(cell15m2.hasEvents).toBe(true);
        expect(cell15m2.eventCount).toBe(1);
        expect(m2.firstActiveDate).toBe('2026-11-15');

        // Date object passed to now formats the local device calendar date
        const localNow = new Date(2026, 10, 10, 8, 30); // Nov 10 in device timezone
        const mDate = buildCalendarMonth({ year: 2026, month: 11, now: localNow, events });
        const cell10Date = mDate.cells.find((c) => c.date === '2026-11-10')!;
        expect(cell10Date.isToday).toBe(true);
        expect(cell10Date.isPast).toBe(false);
    });

    it('navigation target and isCurrentOrPastMonth grey state', () => {
        // Today is in Nov 2026
        const nov = buildCalendarMonth({ year: 2026, month: 11, now: '2026-11-10' });
        expect(nov.isCurrentOrPastMonth).toBe(true); // ‹ greyed on current month
        expect(nov.prevMonth).toEqual({ year: 2026, month: 10 });
        expect(nov.nextMonth).toEqual({ year: 2026, month: 12 });

        const dec = buildCalendarMonth({ year: 2026, month: 12, now: '2026-11-10' });
        expect(dec.isCurrentOrPastMonth).toBe(false); // ‹ active in future month
        expect(dec.prevMonth).toEqual({ year: 2026, month: 11 });
        expect(dec.nextMonth).toEqual({ year: 2027, month: 1 });

        const jan = buildCalendarMonth({ year: 2026, month: 1, now: '2026-11-10' });
        expect(jan.prevMonth).toEqual({ year: 2025, month: 12 });
    });

    it('eventLocalDate validates dates strictly with isLocalDate (rejects invalid days/months)', () => {
        expect(eventLocalDate({ id: 'bad-1', eventStartLocal: '2026-02-30T10:00' })).toBeNull();
        expect(eventLocalDate({ id: 'bad-2', eventStartLocal: '2026-00-00T10:00' })).toBeNull();
        expect(eventLocalDate({ id: 'bad-3', eventStartLocal: '2026-13-01T10:00' })).toBeNull();
        expect(eventLocalDate({ id: 'bad-4', eventStartAt: '2026-04-31T10:00:00.000Z' })).toBeNull();
        expect(eventLocalDate({ id: 'good-1', eventStartLocal: '2026-02-28T10:00' })).toBe('2026-02-28');
        expect(eventLocalDate({ id: 'good-2', event_start_local: '2026-11-10T14:00' })).toBe('2026-11-10');
    });
});

describe('calendar-month: dates by local day', () => {
    it('Southern hemisphere DST change (Australia/Sydney in October): weekly series keeps local clock and day', () => {
        // In Sydney, DST begins on the first Sunday in October (4 Oct 2026): clocks jump from 02:00 to 03:00.
        // A weekly Friday 20:50 event:
        // Before DST: Friday 2 Oct 2026 20:50 Sydney (UTC+10 -> 10:50 UTC)
        // After DST:  Friday 9 Oct 2026 20:50 Sydney (UTC+11 -> 09:50 UTC)
        // Both occurrences must stay on Friday 2 Oct and Friday 9 Oct, at 20:50 local.
        const series: CalendarEventInput = {
            id: 'ev-syd-weekly',
            title: 'Sydney Friday Drinks',
            eventStartLocal: '2026-10-02T20:50',
            eventEndLocal: '2026-10-02T22:50',
            eventStartAt: '2026-10-02T10:50:00.000Z',
            eventEndAt: '2026-10-02T12:50:00.000Z',
            eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' },
        };

        const occurrences = expandEventSeries(series, { start: '2026-10-01', end: '2026-10-31' });
        const dates = occurrences.map((o) => o.date);
        expect(dates).toEqual(['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']);

        // Every occurrence keeps its local clock 20:50, never drifting to 21:50 or 19:50
        for (const occ of occurrences) {
            expect(occ.eventStartLocal).toBe(`${occ.date}T20:50`);
            expect(occ.eventEndLocal).toBe(`${occ.date}T22:50`);
            expect(weekdayCodeOf(occ.date)).toBe('FR');
        }

        // Grouping places them on exact local Fridays
        const grouped = groupEventsByLocalDay([series], { start: '2026-10-01', end: '2026-10-31' });
        expect(Object.keys(grouped).sort()).toEqual(['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']);
    });

    it('Northern hemisphere DST change (America/New_York in November): weekly series keeps local clock and day', () => {
        // In New York, DST ends on the first Sunday in November (1 Nov 2026): clocks jump back 02:00 -> 01:00.
        // A Sunday 10:00 event:
        // 1 Nov 2026 (day of DST change)
        // 8 Nov 2026 (after DST change)
        const series: CalendarEventInput = {
            id: 'ev-ny-weekly',
            title: 'Sunday Brunch',
            eventStartLocal: '2026-11-01T10:00',
            eventEndLocal: '2026-11-01T12:00',
            eventStartAt: '2026-11-01T14:00:00.000Z',
            eventRepeat: { freq: 'weekly', interval: 1, byDay: 'SU' },
        };

        const occurrences = expandEventSeries(series, { start: '2026-11-01', end: '2026-11-30' });
        expect(occurrences.map((o) => o.date)).toEqual(['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
        for (const occ of occurrences) {
            expect(occ.eventStartLocal).toBe(`${occ.date}T10:00`);
            expect(weekdayCodeOf(occ.date)).toBe('SU');
        }
    });

    it('event at the very end of a day (23:59) belongs to its local day, not the UTC day', () => {
        // E.g., event in New York (UTC-5) at 23:59 on 17 Oct:
        // Local: 2026-10-17T23:59
        // UTC:   2026-10-18T04:59:00.000Z (next calendar day in UTC!)
        const lateEvent: CalendarEventInput = {
            id: 'ev-midnight',
            title: 'Late Night Jam',
            eventStartLocal: '2026-10-17T23:59',
            eventEndLocal: '2026-10-18T02:00',
            eventStartAt: '2026-10-18T04:59:00.000Z',
            eventEndAt: '2026-10-18T07:00:00.000Z',
        };

        expect(eventLocalDate(lateEvent)).toBe('2026-10-17');

        const month = buildCalendarMonth({
            year: 2026,
            month: 10,
            now: '2026-10-01',
            events: [lateEvent],
        });

        const cell17 = month.cells.find((c) => c.date === '2026-10-17')!;
        const cell18 = month.cells.find((c) => c.date === '2026-10-18')!;

        expect(cell17.hasEvents).toBe(true);
        expect(cell17.events.map((e) => e.id)).toEqual(['ev-midnight']);
        expect(cell18.hasEvents).toBe(false);
    });

    it('months starting on each weekday (Monday through Sunday)', () => {
        // Weeks start on Monday:
        // Monday -> column 0 (0 padding)
        // Tuesday -> column 1 (1 padding)
        // Wednesday -> column 2 (2 padding)
        // Thursday -> column 3 (3 padding)
        // Friday -> column 4 (4 padding)
        // Saturday -> column 5 (5 padding)
        // Sunday -> column 6 (6 padding)
        const cases = [
            { year: 2021, month: 2, name: 'Monday', expectedPad: 0, firstDayCol: 0 },
            { year: 2022, month: 2, name: 'Tuesday', expectedPad: 1, firstDayCol: 1 },
            { year: 2021, month: 9, name: 'Wednesday', expectedPad: 2, firstDayCol: 2 },
            { year: 2021, month: 4, name: 'Thursday', expectedPad: 3, firstDayCol: 3 },
            { year: 2021, month: 1, name: 'Friday', expectedPad: 4, firstDayCol: 4 },
            { year: 2021, month: 5, name: 'Saturday', expectedPad: 5, firstDayCol: 5 },
            { year: 2026, month: 11, name: 'Sunday', expectedPad: 6, firstDayCol: 6 },
        ];

        for (const c of cases) {
            const m = buildCalendarMonth({ year: c.year, month: c.month, now: `${c.year}-01-01` });
            // Total cells is always a multiple of 7 (full weeks)
            expect(m.cells.length % 7).toBe(0);

            // Leading padding cells count
            const leadingPadding = m.cells.findIndex((cell) => cell.day === 1);
            expect(leadingPadding, `${c.year}-${c.month} (${c.name}) should have ${c.expectedPad} leading padding cells`).toBe(c.expectedPad);

            // Day 1 sits at expected column in the first week
            expect(m.weeks[0][c.firstDayCol].day).toBe(1);
            expect(m.weeks[0][c.firstDayCol].inMonth).toBe(true);

            // Padding cells have null date/day
            for (let i = 0; i < leadingPadding; i++) {
                expect(m.cells[i].inMonth).toBe(false);
                expect(m.cells[i].date).toBeNull();
                expect(m.cells[i].day).toBeNull();
            }
        }
    });

    it('leap February handling (2024, 2028, 2000 vs 2025, 2100)', () => {
        expect(isLeapYear(2024)).toBe(true);
        expect(daysInMonth(2024, 2)).toBe(29);

        expect(isLeapYear(2028)).toBe(true);
        expect(daysInMonth(2028, 2)).toBe(29);

        expect(isLeapYear(2000)).toBe(true);
        expect(daysInMonth(2000, 2)).toBe(29);

        expect(isLeapYear(2025)).toBe(false);
        expect(daysInMonth(2025, 2)).toBe(28);

        expect(isLeapYear(2100)).toBe(false);
        expect(daysInMonth(2100, 2)).toBe(28);

        const feb2024 = buildCalendarMonth({ year: 2024, month: 2, now: '2024-02-01' });
        const day29 = feb2024.cells.find((c) => c.date === '2024-02-29');
        expect(day29).toBeDefined();
        expect(day29?.day).toBe(29);
        expect(day29?.inMonth).toBe(true);

        const feb2025 = buildCalendarMonth({ year: 2025, month: 2, now: '2025-02-01' });
        const noDay29 = feb2025.cells.find((c) => c.date === '2025-02-29');
        expect(noDay29).toBeUndefined();
    });
});

describe('calendar-month: series expansion (pattern, until, skips)', () => {
    it('expands fortnightly series', () => {
        const series: CalendarEventInput = {
            id: 'ev-fortnightly',
            eventStartLocal: '2026-11-03T18:00',
            eventRepeat: { freq: 'weekly', interval: 2, byDay: 'TU' },
        };
        const occ = expandEventSeries(series, { start: '2026-11-01', end: '2026-11-30' });
        expect(occ.map((o) => o.date)).toEqual(['2026-11-03', '2026-11-17']);
    });

    it('expands monthly by day (skips months without that day)', () => {
        const series31: CalendarEventInput = {
            id: 'ev-31st',
            eventStartLocal: '2026-01-31T12:00',
            eventRepeat: { freq: 'monthly', interval: 1, byMonthDay: 31 },
        };
        // Jan -> March (Feb skipped, Apr skipped, May has 31)
        const occ = expandEventSeries(series31, { start: '2026-01-01', end: '2026-05-31' });
        expect(occ.map((o) => o.date)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    });

    it('expands monthly nth weekday (3rd Friday)', () => {
        const series: CalendarEventInput = {
            id: 'ev-third-fri',
            eventStartLocal: '2026-10-16T19:00',
            eventRepeat: { freq: 'monthly', interval: 1, byDay: 'FR', pos: 3 },
        };
        const occ = expandEventSeries(series, { start: '2026-10-01', end: '2026-12-31' });
        // 3rd Friday of Oct (16th), Nov (20th), Dec (18th)
        expect(occ.map((o) => o.date)).toEqual(['2026-10-16', '2026-11-20', '2026-12-18']);
    });

    it('expands monthly last weekday (pos: -1)', () => {
        const series: CalendarEventInput = {
            id: 'ev-last-fri',
            eventStartLocal: '2026-10-30T19:00',
            eventRepeat: { freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 },
        };
        const occ = expandEventSeries(series, { start: '2026-10-01', end: '2026-11-30' });
        // Last Friday of Oct: 30 Oct; last Friday of Nov: 27 Nov
        expect(occ.map((o) => o.date)).toEqual(['2026-10-30', '2026-11-27']);
    });

    it('honours until: stops at last date', () => {
        const series: CalendarEventInput = {
            id: 'ev-until',
            eventStartLocal: '2026-11-06T10:00',
            eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' },
            eventRepeatUntil: '2026-11-20',
        };
        const occ = expandEventSeries(series, { start: '2026-11-01', end: '2026-11-30' });
        expect(occ.map((o) => o.date)).toEqual(['2026-11-06', '2026-11-13', '2026-11-20']);
        // 2026-11-27 is past until, so omitted
    });

    it('honours skips: cancelled dates are omitted and show no dot', () => {
        const series: CalendarEventInput = {
            id: 'ev-skips',
            eventStartLocal: '2026-11-06T10:00',
            eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' },
            eventRepeatSkips: ['2026-11-13'],
        };
        const occ = expandEventSeries(series, { start: '2026-11-01', end: '2026-11-30' });
        expect(occ.map((o) => o.date)).toEqual(['2026-11-06', '2026-11-20', '2026-11-27']);

        // In month grid, 13 Nov has no dot
        const month = buildCalendarMonth({
            year: 2026,
            month: 11,
            now: '2026-11-01',
            events: [series],
        });
        const cell13 = month.cells.find((c) => c.date === '2026-11-13')!;
        expect(cell13.hasEvents).toBe(false);
        expect(cell13.events).toHaveLength(0);

        const cell20 = month.cells.find((c) => c.date === '2026-11-20')!;
        expect(cell20.hasEvents).toBe(true);
    });

    it('no unbounded loop on bad, malformed, or endless series', () => {
        // Bad interval: 0, negative, NaN
        const badInterval0: CalendarEventInput = {
            id: 'ev-bad-0',
            eventStartLocal: '2026-11-06T10:00',
            eventRepeat: { freq: 'weekly', interval: 0, byDay: 'FR' },
        };
        const occ0 = expandEventSeries(badInterval0, { start: '2026-11-01', end: '2026-11-30' });
        expect(occ0.length).toBeGreaterThan(0);
        expect(occ0.length).toBeLessThanOrEqual(5);

        // Unknown frequency
        const badFreq: CalendarEventInput = {
            id: 'ev-bad-freq',
            eventStartLocal: '2026-11-06T10:00',
            eventRepeat: { freq: 'yearly' as unknown as 'weekly', interval: 1 },
        };
        const occFreq = expandEventSeries(badFreq, { start: '2026-11-01', end: '2026-11-30' });
        expect(occFreq).toEqual([{ ...badFreq, date: '2026-11-06', isExpanded: false, baseEvent: badFreq }]);

        // Endless series queried across a wide range: stays bounded by MAX_SERIES_STEPS
        const endless: CalendarEventInput = {
            id: 'ev-endless',
            eventStartLocal: '2026-01-01T10:00',
            eventRepeat: { freq: 'weekly', interval: 1, byDay: 'TH' },
        };
        const occEndless = expandEventSeries(endless, { start: '2026-01-01', end: '2040-01-01' });
        expect(occEndless.length).toBeLessThanOrEqual(500);

        // A repeating series queried 10+ years out (> 500 weeks) fast-forwards and does not leave a silent empty month
        const occTenYears = expandEventSeries(endless, { start: '2036-11-01', end: '2036-11-30' });
        expect(occTenYears.length).toBe(4);
        expect(occTenYears.map((o) => o.date)).toEqual(['2036-11-06', '2036-11-13', '2036-11-20', '2036-11-27']);

        // Monthly series 10+ years out also expands properly
        const monthlyByDay: CalendarEventInput = {
            id: 'ev-monthly-day',
            eventStartLocal: '2026-01-15T10:00',
            eventRepeat: { freq: 'monthly', interval: 1, byMonthDay: 15 },
        };
        const occMonthlyDay = expandEventSeries(monthlyByDay, { start: '2036-11-01', end: '2036-11-30' });
        expect(occMonthlyDay).toHaveLength(1);
        expect(occMonthlyDay[0].date).toBe('2036-11-15');

        const monthlyNth: CalendarEventInput = {
            id: 'ev-monthly-nth',
            eventStartLocal: '2026-01-02T10:00', // First Friday of Jan 2026
            eventRepeat: { freq: 'monthly', interval: 1, byDay: 'FR', pos: 1 },
        };
        const occMonthlyNth = expandEventSeries(monthlyNth, { start: '2036-11-01', end: '2036-11-30' });
        expect(occMonthlyNth).toHaveLength(1);
        expect(occMonthlyNth[0].date).toBe('2036-11-07'); // First Friday of Nov 2036

        // Past until
        const pastUntil: CalendarEventInput = {
            id: 'ev-past-until',
            eventStartLocal: '2026-11-06T10:00',
            eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' },
            eventRepeatUntil: '2026-10-01',
        };
        expect(expandEventSeries(pastUntil, { start: '2026-11-01', end: '2026-11-30' })).toHaveLength(0);

        // Corrupt or unparseable event timestamps never throw RangeError
        const corrupt: CalendarEventInput = {
            id: 'ev-corrupt',
            eventStartLocal: '2026-11-06T10:00',
            eventEndLocal: 'invalid-end-date-string',
            eventStartAt: 'not-a-valid-timestamp',
            eventEndAt: 'garbage-time',
            eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' },
        };
        const occCorrupt = expandEventSeries(corrupt, { start: '2026-11-01', end: '2026-11-15' });
        expect(occCorrupt).toHaveLength(2);
        expect(occCorrupt[0].eventStartAt).toBe('2026-11-06T10:00:00.000Z');
        expect(occCorrupt[0].eventEndAt).toBeNull();
        expect(occCorrupt[0].eventEndLocal).toBeNull();
        expect(occCorrupt[1].eventStartAt).toBe('2026-11-13T10:00:00.000Z');
        expect(occCorrupt[1].eventEndAt).toBeNull();
        expect(occCorrupt[1].eventEndLocal).toBeNull();
    });
});

describe('calendar-month: day heading & empty states in words layer', () => {
    it('calendarDayHeading in English: count 0, 1, 2', () => {
        expect(calendarDayHeading('2026-11-10', 0)).toBe('Nothing on Tue 10 Nov');
        expect(calendarDayHeading('2026-11-11', 0)).toBe('Nothing on Wed 11 Nov');
        expect(calendarDayHeading('2026-11-07', 1)).toBe('Sat 7 Nov: 1 event');
        expect(calendarDayHeading('2026-11-07', 2)).toBe('Sat 7 Nov: 2 events');
        expect(calendarDayHeading('2026-11-07', 5)).toBe('Sat 7 Nov: 5 events');
    });

    it('calendarDayHeading and month strings in Spanish (es)', () => {
        try {
            setLanguage('es', [loadCatalog('es')]);
            expect(calendarDayHeading('2026-11-07', 1)).toBe('sáb, 7 nov: 1 evento');
            expect(calendarDayHeading('2026-11-07', 2)).toBe('sáb, 7 nov: 2 eventos');
            expect(calendarDayHeading('2026-11-10', 0)).toBe('Nada el mar, 10 nov');
            expect(calendarMonthEmptyText(2026, 11)).toBe('Nada en noviembre.');
            expect(calendarNextEventLabel('2026-12-06')).toBe('Siguiente: dom, 6 dic ›');
            expect(calendarNoEventsComingUpText()).toBe('Aún no hay eventos próximos.');
            expect(calendarStartOneText()).toBe('Crear uno ›');
            expect(calendarTitle()).toBe('Calendario');
        } finally {
            setLanguage('en');
        }
    });

    it('calendarDayHeading in French (fr)', () => {
        try {
            setLanguage('fr', [loadCatalog('fr')]);
            expect(calendarDayHeading('2026-11-07', 1)).toBe('sam. 7 nov. : 1 événement');
            expect(calendarDayHeading('2026-11-07', 3)).toBe('sam. 7 nov. : 3 événements');
            expect(calendarMonthEmptyText(2026, 11)).toBe('Rien en novembre.');
        } finally {
            setLanguage('en');
        }
    });

    it('calendarDayHeading in German (de)', () => {
        try {
            setLanguage('de', [loadCatalog('de')]);
            expect(calendarDayHeading('2026-11-07', 1)).toBe('Sa., 7. Nov.: 1 Veranstaltung');
            expect(calendarDayHeading('2026-11-07', 2)).toBe('Sa., 7. Nov.: 2 Veranstaltungen');
        } finally {
            setLanguage('en');
        }
    });

    it('calendarDayHeading in Russian (ru) with 1, 2, 5 plural categories', () => {
        try {
            setLanguage('ru', [loadCatalog('ru')]);
            expect(calendarDayHeading('2026-11-07', 1)).toBe('сб, 7 нояб.: 1 мероприятие');
            expect(calendarDayHeading('2026-11-07', 2)).toBe('сб, 7 нояб.: 2 мероприятия');
            expect(calendarDayHeading('2026-11-07', 5)).toBe('сб, 7 нояб.: 5 мероприятий');
            expect(calendarMonthEmptyText(2026, 11)).toBe('На ноябрь ничего нет.');
        } finally {
            setLanguage('en');
        }
    });

    it('calendarMonthEmptyText in ja, uk, el with grammar-checked templates', () => {
        try {
            setLanguage('ja', [loadCatalog('ja')]);
            expect(calendarMonthEmptyText(2026, 11)).toBe('11月には何もありません。');

            setLanguage('uk', [loadCatalog('uk')]);
            expect(calendarMonthEmptyText(2026, 11)).toBe('На листопад нічого немає.');

            setLanguage('el', [loadCatalog('el')]);
            expect(calendarMonthEmptyText(2026, 11)).toBe('Τίποτα τον μήνα Νοεμβρίου.');
        } finally {
            setLanguage('en');
        }
    });

    it('calendarDayHeading in Chinese (zh-Hans)', () => {
        try {
            setLanguage('zh-Hans', [loadCatalog('zh-Hans')]);
            expect(calendarDayHeading('2026-11-07', 2)).toBe('11月7日周六：2 场活动');
            expect(calendarMonthEmptyText(2026, 11)).toBe('十一月无活动。');
        } finally {
            setLanguage('en');
        }
    });

    it('calendarMonthHeading and weekday labels in various languages', () => {
        expect(calendarMonthHeading(2026, 11, 'en')).toBe('November 2026');
        expect(calendarMonthHeading(2026, 11, 'fr')).toBe('novembre 2026');
        expect(calendarMonthHeading(2026, 11, 'ru')).toBe('ноябрь 2026 г.');
        expect(calendarMonthHeading(2026, 11, 'zh-Hans')).toBe('2026年11月');

        const enWeekdays = calendarWeekdayLabels('en');
        expect(enWeekdays).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

        const esWeekdays = calendarWeekdayLabels('es');
        expect(esWeekdays).toEqual(['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']);
    });

    it('month empty states and next event jumping in English', () => {
        expect(calendarMonthEmptyText(2026, 11)).toBe('Nothing on in November.');
        expect(calendarNextEventLabel('2026-12-06')).toBe('Next: Sun 6 Dec ›');
        expect(calendarNextEventLabel('2025-12-06')).toBe('Next: Sat 6 Dec ›');
        expect(calendarNoEventsComingUpText()).toBe('No events coming up yet.');
        expect(calendarStartOneText()).toBe('Start one ›');
        expect(calendarTitle()).toBe('Calendar');
    });

    it('findNextEventDateAfter correctly finds upcoming date after month', () => {
        const events: CalendarEventInput[] = [
            { id: 'ev-nov', eventStartLocal: '2026-11-15T10:00' },
            { id: 'ev-dec', eventStartLocal: '2026-12-06T14:00' },
            { id: 'ev-jan', eventStartLocal: '2027-01-10T14:00' },
        ];
        expect(findNextEventDateAfter(events, '2026-11-30')).toBe('2026-12-06');
        expect(findNextEventDateAfter(events, '2026-12-31')).toBe('2027-01-10');
        expect(findNextEventDateAfter(events, '2027-02-01')).toBeNull();
    });

    it('groupEventsByLocalDay sorts same-day events soonest first with snake_case and local times', () => {
        const events: CalendarEventInput[] = [
            // SQLite replica row (snake_case)
            { id: 'ev-late', event_start_at: '2026-11-10T16:00:00.000Z', event_start_local: '2026-11-10T16:00' },
            // Earlier one-off event with camelCase
            { id: 'ev-early', eventStartAt: '2026-11-10T09:00:00.000Z', eventStartLocal: '2026-11-10T09:00' },
            // Event with only local clock string (no UTC timestamp)
            { id: 'ev-mid', event_start_local: '2026-11-10T12:00' },
        ];
        const grouped = groupEventsByLocalDay(events, { start: '2026-11-10', end: '2026-11-10' });
        const ids = grouped['2026-11-10'].map((e) => e.id);
        expect(ids).toEqual(['ev-early', 'ev-mid', 'ev-late']);
        // Verify field normalization on one-off occurrence
        expect(grouped['2026-11-10'][0].eventStartLocal).toBe('2026-11-10T09:00');
        expect(grouped['2026-11-10'][1].eventStartLocal).toBe('2026-11-10T12:00');
        expect(grouped['2026-11-10'][2].eventStartLocal).toBe('2026-11-10T16:00');
    });

    it('findNextEventDateAfter sees one-off event more than 365 days past viewed month', () => {
        // Event 14 months past November 2026 (> 365 days)
        const events: CalendarEventInput[] = [
            { id: 'ev-far-oneoff', eventStartLocal: '2028-01-15T10:00' },
        ];
        // Must not be capped at 365 days; empty month is never a dead end
        expect(findNextEventDateAfter(events, '2026-11-30')).toBe('2028-01-15');

        // And in buildCalendarMonth model
        const month = buildCalendarMonth({
            year: 2026,
            month: 11,
            now: '2026-11-01',
            events,
        });
        expect(month.nextEventDate).toBe('2028-01-15');
    });

    it('findNextOccurrenceAfter steps repeating series directly to first occurrence after date', () => {
        // Weekly series starting long ago (2025-01-01 was Wednesday)
        const weeklySeries: CalendarEventInput = {
            id: 'ev-weekly',
            eventStartLocal: '2025-01-01T10:00',
            eventRepeat: { freq: 'weekly', byDay: 'WE' },
        };
        // Stepping directly past 2026-11-30 (Monday) -> first Wednesday is 2026-12-02
        expect(findNextOccurrenceAfter(weeklySeries, '2026-11-30')).toBe('2026-12-02');

        // Series with skips on the first candidate steps to the next
        const weeklyWithSkip: CalendarEventInput = {
            ...weeklySeries,
            eventRepeatSkips: ['2026-12-02'],
        };
        expect(findNextOccurrenceAfter(weeklyWithSkip, '2026-11-30')).toBe('2026-12-09');

        // Series with until capped before afterDate returns null
        const expiredSeries: CalendarEventInput = {
            ...weeklySeries,
            eventRepeatUntil: '2026-11-20',
        };
        expect(findNextOccurrenceAfter(expiredSeries, '2026-11-30')).toBeNull();

        // Monthly by day starting long ago
        const monthlyByDay: CalendarEventInput = {
            id: 'ev-month-day',
            eventStartLocal: '2025-05-15T14:00',
            eventRepeat: { freq: 'monthly', byMonthDay: 15 },
        };
        expect(findNextOccurrenceAfter(monthlyByDay, '2026-11-30')).toBe('2026-12-15');

        // Monthly nth weekday (2nd Thursday)
        const monthlyNthWeekday: CalendarEventInput = {
            id: 'ev-nth-weekday',
            eventStartLocal: '2025-05-01T10:00',
            eventRepeat: { freq: 'monthly', pos: 2, byDay: 'TH' },
        };
        // 2nd Thursday of December 2026 is 2026-12-10
        expect(findNextOccurrenceAfter(monthlyNthWeekday, '2026-11-30')).toBe('2026-12-10');

        // Repeating series starting > 365 days in future
        const futureSeries: CalendarEventInput = {
            id: 'ev-future-series',
            eventStartLocal: '2028-03-01T10:00',
            eventRepeat: { freq: 'weekly', byDay: 'WE' },
        };
        expect(findNextOccurrenceAfter(futureSeries, '2026-11-30')).toBe('2028-03-01');
    });

    it('findNextOccurrenceAfter keeps bad or endless series bounded and returns null', () => {
        // Endless series with 600 skipped dates (exceeds MAX_SERIES_STEPS = 500)
        const allSkippedSeries: CalendarEventInput = {
            id: 'ev-endless-skip',
            eventStartLocal: '2026-11-01T10:00',
            eventRepeat: { freq: 'weekly', byDay: 'SU' },
            eventRepeatSkips: Array.from({ length: 600 }, (_, i) => addDays('2026-11-01', i * 7)),
        };
        // Must terminate bounded without hanging and return null
        expect(findNextOccurrenceAfter(allSkippedSeries, '2026-11-30')).toBeNull();

        // Malformed series rules
        const malformedPos: CalendarEventInput = {
            id: 'ev-malformed-pos',
            eventStartLocal: '2026-11-01T10:00',
            eventRepeat: { freq: 'monthly', pos: 99 as unknown as 1, byDay: 'SU' },
        };
        expect(findNextOccurrenceAfter(malformedPos, '2026-11-30')).toBeNull();

        const malformedDay: CalendarEventInput = {
            id: 'ev-malformed-day',
            eventStartLocal: '2026-11-01T10:00',
            eventRepeat: { freq: 'monthly', byMonthDay: 40 },
        };
        expect(findNextOccurrenceAfter(malformedDay, '2026-11-30')).toBeNull();
    });

    it('sentence helpers do not offer lang parameter and guarantee single language from active device words', () => {
        // Lang is dropped from sentence helpers so they always use active device words
        expect(calendarTitle.length).toBe(0);
        expect(calendarDayHeading.length).toBe(2);
        expect(calendarMonthEmptyText.length).toBe(2);
        expect(calendarNextEventLabel.length).toBe(1);
        expect(calendarNoEventsComingUpText.length).toBe(0);
        expect(calendarStartOneText.length).toBe(0);

        // With active language English
        setLanguage('en');
        expect(calendarTitle()).toBe('Calendar');
        expect(calendarDayHeading('2026-11-07', 2)).toBe('Sat 7 Nov: 2 events');
        expect(calendarMonthEmptyText(2026, 11)).toBe('Nothing on in November.');
        expect(calendarNextEventLabel('2026-12-06')).toBe('Next: Sun 6 Dec ›');
        expect(calendarNoEventsComingUpText()).toBe('No events coming up yet.');
        expect(calendarStartOneText()).toBe('Start one ›');

        // With active language Spanish
        try {
            setLanguage('es', [loadCatalog('es')]);
            expect(calendarTitle()).toBe('Calendario');
            expect(calendarDayHeading('2026-11-07', 2)).toBe('sáb, 7 nov: 2 eventos');
            expect(calendarMonthEmptyText(2026, 11)).toBe('Nada en noviembre.');
            expect(calendarNextEventLabel('2026-12-06')).toBe('Siguiente: dom, 6 dic ›');
            expect(calendarNoEventsComingUpText()).toBe('Aún no hay eventos próximos.');
            expect(calendarStartOneText()).toBe('Crear uno ›');
        } finally {
            setLanguage('en');
        }
    });
});
