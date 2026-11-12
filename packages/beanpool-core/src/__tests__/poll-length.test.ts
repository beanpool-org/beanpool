import { describe, expect, it } from 'vitest';
import {
    POLL_DAYS_DEFAULT, POLL_DAYS_LONG, POLL_DAYS_MEMBERS, decidePollOrder, isLongPollDays, mayChooseLongPolls, pollDayChoices, pollDaysAllowed, pollRunsLong,
} from '../poll-length.js';

/**
 * How long a poll may run (Damo's ask, Marty's yes, 12 Nov 2026): 3, 7 or 14 days for anyone who can start a poll, and 30 or 90
 * for an owner or an admin only. One list for the node, the assistant's tool and both apps' pickers, so they never disagree.
 */
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('pollDayChoices: what the length picker offers', () => {
    it('a member is offered 3, 7 and 14 days, as it always was', () => {
        expect(pollDayChoices(false)).toEqual([3, 7, 14]);
        expect(POLL_DAYS_MEMBERS).toEqual([3, 7, 14]);
    });

    it('an owner or an admin is offered 30 and 90 days as well, after the short ones', () => {
        expect(pollDayChoices(true)).toEqual([3, 7, 14, 30, 90]);
        expect(POLL_DAYS_LONG).toEqual([30, 90]);
    });

    it('the default is 7 days, and every role is offered it', () => {
        expect(POLL_DAYS_DEFAULT).toBe(7);
        expect(pollDayChoices(false)).toContain(POLL_DAYS_DEFAULT);
        expect(pollDayChoices(true)).toContain(POLL_DAYS_DEFAULT);
    });
});

describe('the role a picker reads', () => {
    it('only an owner or an admin gets the long lengths; a moderator, a member, no role and "not heard" do not', () => {
        for (const [role, long] of [['owner', true], ['admin', true], ['moderator', false], [null, false], [undefined, false], ['', false], ['Owner', false]] as const) {
            expect(mayChooseLongPolls(role)).toBe(long);
            expect(pollDayChoices(mayChooseLongPolls(role))).toEqual(long ? [3, 7, 14, 30, 90] : [3, 7, 14]);
        }
    });
});

describe('pollDaysAllowed: the one test the node and the assistant use', () => {
    it('holds a member to 3, 7 and 14', () => {
        for (const d of [3, 7, 14]) expect(pollDaysAllowed(d, false)).toBe(true);
        for (const d of [30, 90, 0, 1, 5, 15, 31, 89, 91, 365, -7, Number.NaN, Number.POSITIVE_INFINITY]) expect(pollDaysAllowed(d, false)).toBe(false);
    });

    it('holds an owner or an admin to those and 30 and 90, and nothing in between', () => {
        for (const d of [3, 7, 14, 30, 90]) expect(pollDaysAllowed(d, true)).toBe(true);
        for (const d of [0, 1, 5, 15, 29, 31, 60, 89, 91, 365, -30, Number.NaN]) expect(pollDaysAllowed(d, true)).toBe(false);
    });

    it('is not fooled by a number that is not a whole day count', () => {
        expect(pollDaysAllowed(30.5, true)).toBe(false);
        expect(pollDaysAllowed('30' as unknown as number, true)).toBe(false);
        expect(pollDaysAllowed(null as unknown as number, true)).toBe(false);
    });
});

describe('isLongPollDays', () => {
    it('is true for 30 and 90 only', () => {
        expect([3, 7, 14, 30, 90, 60].map(isLongPollDays)).toEqual([false, false, false, true, true, false]);
    });
});

describe('pollRunsLong: a poll that was made to run 30 or 90 days, read from when it began and when it ends', () => {
    const start = Date.parse('2026-11-12T00:00:00.000Z');
    it('is true for 30 and 90 days, and false for the short ones', () => {
        expect(pollRunsLong(iso(start), iso(start + 30 * DAY))).toBe(true);
        expect(pollRunsLong(iso(start), iso(start + 90 * DAY))).toBe(true);
        for (const d of [3, 7, 14]) expect(pollRunsLong(iso(start), iso(start + d * DAY))).toBe(false);
    });

    it('allows for the few milliseconds between a poll being stamped and its closing time being worked out', () => {
        expect(pollRunsLong(iso(start + 12), iso(start + 30 * DAY))).toBe(true);
        expect(pollRunsLong(iso(start), iso(start + 30 * DAY + 40))).toBe(true);
    });

    it('is false when either time is missing or unreadable', () => {
        expect(pollRunsLong(undefined, iso(start + 30 * DAY))).toBe(false);
        expect(pollRunsLong(iso(start), null)).toBe(false);
        expect(pollRunsLong('soon', 'later')).toBe(false);
        expect(pollRunsLong('', '')).toBe(false);
    });
});

describe('decidePollOrder: Decide shows the polls that still want your vote first', () => {
    const start = Date.parse('2026-11-12T00:00:00.000Z');
    const poll = (id: string, days: number, voted: boolean, openedAt = start) => ({ id, voted, createdAt: iso(openedAt), pollClosesAt: iso(openedAt + days * DAY) });
    const order = (list: ReturnType<typeof poll>[]) => decidePollOrder(list, p => p.voted).map(p => p.id);

    it('puts a long poll you have voted in below the polls still waiting for your vote, even when it closes sooner', () => {
        // The 30-day poll closes on day 30; the 90-day one on day 90, so it is the later by closing time. Voted in a 30-day
        // poll must still sit below a 14-day poll that is waiting.
        expect(order([poll('long-voted', 30, true), poll('short-waiting', 14, false), poll('long-waiting', 90, false)]))
            .toEqual(['short-waiting', 'long-waiting', 'long-voted']);
    });

    it('a long poll you have not voted in keeps its place by closing time', () => {
        expect(order([poll('b-90', 90, false), poll('a-30', 30, false), poll('c-7', 7, false)])).toEqual(['c-7', 'a-30', 'b-90']);
    });

    it('a short poll you have voted in keeps its place: only the long ones move down', () => {
        expect(order([poll('later', 14, false), poll('voted-short', 3, true)])).toEqual(['voted-short', 'later']);
    });

    it('between two long polls you have voted in, the sooner closing is still first', () => {
        expect(order([poll('v90', 90, true), poll('v30', 30, true), poll('waiting', 14, false)])).toEqual(['waiting', 'v30', 'v90']);
    });

    it('a voted long poll that is alone is still there, and an empty list stays empty', () => {
        expect(order([poll('only', 90, true)])).toEqual(['only']);
        expect(order([])).toEqual([]);
    });

    it('does not change the list it is given', () => {
        const list = [poll('x', 30, true), poll('y', 7, false)];
        const before = list.map(p => p.id);
        decidePollOrder(list, p => p.voted);
        expect(list.map(p => p.id)).toEqual(before);
    });
});
