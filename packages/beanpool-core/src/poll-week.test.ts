/**
 * A member starts one poll a week: the apps' reading of the node's answer and the sentence they show in place of the poll form
 * (apps/server engine/poll-week.ts is the rule; apps/native NewPollModal and apps/pwa MapPage are the screens).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { POLL_NEXT_START_PATH, pollNextStartMs, pollWeekNotice } from './poll-week.js';
import { formatDate, setLanguage } from './words.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const DAY = 86_400_000;

afterEach(() => setLanguage('en'));

describe('pollNextStartMs', () => {
    it('reads the node\'s time when it is still to come', () => {
        expect(pollNextStartMs({ nextAt: '2026-11-11T09:30:00.000Z' }, NOW)).toBe(Date.parse('2026-11-11T09:30:00.000Z'));
    });
    it('reads nothing to wait for as null: the node says null, or the time has passed, or it is now', () => {
        expect(pollNextStartMs({ nextAt: null }, NOW)).toBeNull();
        expect(pollNextStartMs({ nextAt: new Date(NOW - 1000).toISOString() }, NOW)).toBeNull();
        expect(pollNextStartMs({ nextAt: new Date(NOW).toISOString() }, NOW)).toBeNull();
    });
    it('reads an older node\'s answer, an error body, and rubbish as null, never as a wait', () => {
        for (const answer of [undefined, null, {}, { error: 'not found' }, 'x', 7, [], { nextAt: 5 }, { nextAt: '' }, { nextAt: 'next week' }, { nextAt: {} }]) {
            expect(pollNextStartMs(answer, NOW)).toBeNull();
        }
    });
    it('asks the route the node serves', () => {
        expect(POLL_NEXT_START_PATH).toBe('/api/marketplace/polls/next-start');
    });
});

describe('pollWeekNotice', () => {
    it('is the node\'s own sentence with the day in the member\'s calendar', () => {
        const at = NOW + 5 * DAY;
        expect(pollWeekNotice(at)).toBe(`You can start one poll a week. Your next one can start on ${formatDate(new Date(at), 'weekday-day-month')}.`);
    });
    it('writes the day with the weekday, the day and the month, and not the year or the time', () => {
        expect(pollWeekNotice(NOW + 2 * DAY)).toMatch(/start on [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}\.$/);
    });
});
