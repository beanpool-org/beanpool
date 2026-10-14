import { describe, expect, it } from 'vitest';
import {
    isSeriesDate,
    nextOccurrence,
    parseRepeatPattern,
    patternFallsOn,
    readRepeatRule,
    readRepeatSkips,
    REPEAT_ERRORS,
    upcoming,
    type EventRepeatRule,
} from '../event-series.js';

const SYD = 'Australia/Sydney';
const weeklyFri: EventRepeatRule = { freq: 'weekly', interval: 1, byDay: 'FR', time: '20:50', minutes: 120 };

describe('nextOccurrence — DESIGN-event-times §8, §10 slice 4', () => {
    it('across the Sydney DST start: the local clocks are equal and the instants an hour apart', () => {
        const walk = { rule: weeklyFri, anchorDate: '2026-10-02', tz: SYD };
        const first = nextOccurrence(walk, '2026-10-01T00:00:00.000Z')!;
        const second = nextOccurrence(walk, first.endAt)!;
        expect(first).toEqual({
            date: '2026-10-02', startLocal: '2026-10-02T20:50', endLocal: '2026-10-02T22:50',
            startAt: '2026-10-02T10:50:00.000Z', endAt: '2026-10-02T12:50:00.000Z',
        });
        expect(second.startLocal.slice(11)).toBe(first.startLocal.slice(11));
        expect(second.startAt).toBe('2026-10-09T09:50:00.000Z');
        expect(Date.parse(second.startAt) - Date.parse(first.startAt)).toBe(7 * 86_400_000 - 3_600_000);
    });

    it('a Sunday 02:30 series moves to 03:30 on the gap day only, and back to 02:30 the week after', () => {
        const rule: EventRepeatRule = { freq: 'weekly', interval: 1, byDay: 'SU', time: '02:30', minutes: 60 };
        const dates = upcoming({ rule, anchorDate: '2026-09-27', tz: SYD }, 3, '2026-09-01T00:00:00.000Z');
        expect(dates.map(d => d.startLocal)).toEqual(['2026-09-27T02:30', '2026-10-04T03:30', '2026-10-11T02:30']);
    });

    it('monthly on the 31st skips the months without one (February, April …)', () => {
        const rule: EventRepeatRule = { freq: 'monthly', interval: 1, byMonthDay: 31, time: '18:00', minutes: 60 };
        const dates = upcoming({ rule, anchorDate: '2027-01-31', tz: SYD }, 4, '2027-01-01T00:00:00.000Z');
        expect(dates.map(d => d.date)).toEqual(['2027-01-31', '2027-03-31', '2027-05-31', '2027-07-31']);
    });

    it('monthly on the last Friday, and on the 3rd Friday', () => {
        const last: EventRepeatRule = { freq: 'monthly', interval: 1, byDay: 'FR', pos: -1, time: '19:00', minutes: 90 };
        expect(upcoming({ rule: last, anchorDate: '2026-10-30', tz: SYD }, 4, '2026-10-01T00:00:00.000Z').map(d => d.date))
            .toEqual(['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29']);
        const third: EventRepeatRule = { freq: 'monthly', interval: 1, byDay: 'FR', pos: 3, time: '19:00', minutes: 90 };
        expect(upcoming({ rule: third, anchorDate: '2026-10-16', tz: SYD }, 3, '2026-10-01T00:00:00.000Z').map(d => d.date))
            .toEqual(['2026-10-16', '2026-11-20', '2026-12-18']);
    });

    it('every 2 weeks keeps the phase of its first date', () => {
        const rule: EventRepeatRule = { ...weeklyFri, interval: 2 };
        expect(upcoming({ rule, anchorDate: '2026-10-16', tz: SYD }, 3, '2026-10-01T00:00:00.000Z').map(d => d.date))
            .toEqual(['2026-10-16', '2026-10-30', '2026-11-13']);
    });

    it('until: the last date is inclusive, and after it there is no next date', () => {
        const walk = { rule: weeklyFri, anchorDate: '2026-10-16', tz: SYD, until: '2026-10-23' };
        expect(nextOccurrence(walk, '2026-10-16T12:00:00.000Z')!.date).toBe('2026-10-23');
        expect(nextOccurrence(walk, '2026-10-23T12:00:00.000Z')).toBeNull();
    });

    it('skips: a cancelled date is passed over; every date left cancelled means no next date', () => {
        const walk = { rule: weeklyFri, anchorDate: '2026-10-16', tz: SYD, skips: ['2026-10-23'] };
        expect(nextOccurrence(walk, '2026-10-16T12:00:00.000Z')!.date).toBe('2026-10-30');
        const allGone = { ...walk, until: '2026-10-30', skips: ['2026-10-23', '2026-10-30'] };
        expect(nextOccurrence(allGone, '2026-10-16T12:00:00.000Z')).toBeNull();
        const marked = upcoming(walk, 3, '2026-10-01T00:00:00.000Z');
        expect(marked.map(d => [d.date, d.skipped])).toEqual([['2026-10-16', false], ['2026-10-23', true], ['2026-10-30', false]]);
    });

    it('a node that was off for weeks lands on the first date that has not ended, not on a stale one', () => {
        const walk = { rule: weeklyFri, anchorDate: '2026-10-16', tz: SYD };
        expect(nextOccurrence(walk, '2026-11-10T00:00:00.000Z')!.date).toBe('2026-11-13');
    });

    it('an online series in Lagos (no DST) is the same instant every week', () => {
        const rule: EventRepeatRule = { freq: 'weekly', interval: 1, byDay: 'TH', time: '19:00', minutes: 60 };
        const dates = upcoming({ rule, anchorDate: '2026-10-15', tz: 'Africa/Lagos' }, 2, '2026-10-01T00:00:00.000Z');
        expect(dates.map(d => d.startAt)).toEqual(['2026-10-15T18:00:00.000Z', '2026-10-22T18:00:00.000Z']);
    });
});

describe('the rule is a closed shape', () => {
    it('parses the four patterns the form offers, keeping only their own keys', () => {
        expect(parseRepeatPattern({ freq: 'weekly', interval: 1, byDay: 'FR', extra: 'x' })).toEqual({ freq: 'weekly', interval: 1, byDay: 'FR' });
        expect(parseRepeatPattern({ freq: 'weekly', interval: 2, byDay: 'FR' })).toEqual({ freq: 'weekly', interval: 2, byDay: 'FR' });
        expect(parseRepeatPattern({ freq: 'monthly', interval: 1, byMonthDay: 16 })).toEqual({ freq: 'monthly', interval: 1, byMonthDay: 16 });
        expect(parseRepeatPattern({ freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 })).toEqual({ freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 });
        expect(parseRepeatPattern(null)).toBeNull();
        expect(parseRepeatPattern({ freq: 'never' })).toBeNull();
    });

    it('refuses what the form never sends, in words', () => {
        expect(() => parseRepeatPattern({ freq: 'daily' })).toThrow(REPEAT_ERRORS.shape);
        expect(() => parseRepeatPattern({ freq: 'weekly', byDay: 'XX' })).toThrow(REPEAT_ERRORS.shape);
        expect(() => parseRepeatPattern({ freq: 'weekly', interval: 13, byDay: 'FR' })).toThrow(REPEAT_ERRORS.interval);
        expect(() => parseRepeatPattern({ freq: 'monthly', byDay: 'FR', pos: 5 })).toThrow(REPEAT_ERRORS.shape);
        expect(() => parseRepeatPattern({ freq: 'monthly', byMonthDay: 32 })).toThrow(REPEAT_ERRORS.shape);
        expect(() => parseRepeatPattern('FREQ=WEEKLY')).toThrow(REPEAT_ERRORS.shape);
    });

    it('a stored cell that is not a rule reads as none, never throws', () => {
        expect(readRepeatRule('{"freq":"weekly","interval":1,"byDay":"FR","time":"20:50","minutes":120}')).toEqual(weeklyFri);
        expect(readRepeatRule('{"freq":"weekly","interval":1,"byDay":"FR"}')).toBeNull();
        expect(readRepeatRule('not json')).toBeNull();
        expect(readRepeatSkips('["2026-10-30","2026-10-23","2026-02-30","x"]')).toEqual(['2026-10-23', '2026-10-30']);
    });

    it('which dates belong to a series, either side of the current one', () => {
        expect(patternFallsOn({ freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 }, '2026-10-30')).toBe(true);
        expect(patternFallsOn({ freq: 'monthly', interval: 1, byDay: 'FR', pos: 4 }, '2026-10-30')).toBe(false);
        const walk = { rule: { ...weeklyFri, interval: 2 }, anchorDate: '2026-10-30', tz: SYD };
        expect(isSeriesDate(walk, '2026-10-16')).toBe(true);
        expect(isSeriesDate(walk, '2026-10-23')).toBe(false);
        expect(isSeriesDate(walk, '2026-11-13')).toBe(true);
        expect(isSeriesDate({ ...walk, until: '2026-11-01' }, '2026-11-13')).toBe(false);
    });
});
