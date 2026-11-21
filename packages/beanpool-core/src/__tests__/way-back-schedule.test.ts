/**
 * The way-back schedule (src/way-back-schedule.ts; DESIGN-notify-and-backup-asks-fable.md §5.2, amend2 slice B1).
 *
 * Two halves. The table: one row per guard in the rule, over {days since join, first Beans seen, last put away, a way
 * back kept or not, something to lose or not, the notifications card up}, each with what shows, why, the next return
 * date and the bell's line; every row is red when its guard goes. The sweep: every combination, against the design's
 * invariants (never while kept; once at the first Beans, once at 30 days, then at most every 90 days and only with
 * something to lose; one × answers every return then waiting).
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
    WAY_BACK_EVERY_DAYS, WAY_BACK_MONTH_DAYS, WAY_BACK_WORDS, wayBackBeansSeen, wayBackLine, wayBackSchedule, wayBackSomethingToLose,
    type WayBackScheduleInput,
} from '../way-back-schedule.js';
import { LANGS, PSEUDO_LANG, pseudoLocalise, setLanguage, type Catalog } from '../words.js';

const DAY = 86_400_000;
const JOINED = Date.UTC(2026, 10, 21, 2, 0);
const day = (n: number) => JOINED + n * DAY;

afterEach(() => setLanguage('en'));

describe('the schedule, one row per guard', () => {
    type Row = [name: string, input: Omit<WayBackScheduleInput, 'joinedAt' | 'kept'> & { kept?: boolean }, show: boolean, why: string | null, next: number | null, bell: boolean];
    const ROWS: Row[] = [
        // first: not put away since it started (the join's Later, S4)
        ['the first landing after Later', { now: day(0) }, true, 'first', null, false],
        ['day 3, still not put away', { now: day(3) }, true, 'first', null, false],
        ['a way back kept: never, not even on the first landing', { now: day(0), kept: true }, false, null, null, false],
        ['kept, with Beans, a role and 400 days gone', { now: day(400), kept: true, putAwayAt: day(1), beansAt: day(2), balance_c: 4000, holds: true }, false, null, null, false],
        // put away: the bell's line, and the 30 days' date
        ['put away on day 1: the 30 days next, the bell line', { now: day(2), putAwayAt: day(1) }, false, null, day(WAY_BACK_MONTH_DAYS), true],
        // beans
        ['the first Beans after the ×: back with the fact', { now: day(5), putAwayAt: day(1), beansAt: day(4), balance_c: 4000 }, true, 'beans', null, true],
        ['the first Beans while still up: the fact on that showing', { now: day(5), beansAt: day(4), balance_c: 4000 }, true, 'beans', null, false],
        ['the Beans return answered by a later ×', { now: day(6), putAwayAt: day(5), beansAt: day(4), balance_c: 4000 }, false, null, day(WAY_BACK_MONTH_DAYS), true],
        ['Beans seen, then spent to nothing: no fact to state', { now: day(6), putAwayAt: day(1), beansAt: day(4), balance_c: 0 }, false, null, day(WAY_BACK_MONTH_DAYS), true],
        ['Beans seen, the balance not known now: waits', { now: day(6), putAwayAt: day(1), beansAt: day(4), balance_c: null }, false, null, day(WAY_BACK_MONTH_DAYS), true],
        ['a balance above zero but no date seen: not the Beans return', { now: day(6), putAwayAt: day(1), balance_c: 4000 }, false, null, day(WAY_BACK_MONTH_DAYS), true],
        // month
        ['day 29: not yet', { now: day(WAY_BACK_MONTH_DAYS) - 1, putAwayAt: day(1) }, false, null, day(WAY_BACK_MONTH_DAYS), true],
        ['day 30: once more, nothing to lose needed', { now: day(WAY_BACK_MONTH_DAYS), putAwayAt: day(1) }, true, 'month', null, true],
        ['day 30 answered: nothing to lose, no date', { now: day(31), putAwayAt: day(30) }, false, null, null, true],
        ['day 30 answered with something to lose: 90 days on', { now: day(31), putAwayAt: day(30), holds: true }, false, null, day(30 + WAY_BACK_EVERY_DAYS), true],
        ['put away on day 40 (an old record, or the web): the 30 days already met', { now: day(41), putAwayAt: day(40) }, false, null, null, true],
        // every 90 days
        ['90 days on, a balance: back', { now: day(30 + WAY_BACK_EVERY_DAYS), putAwayAt: day(30), balance_c: 1250 }, true, 'every', null, true],
        ['90 days on, Beans owed count too', { now: day(30 + WAY_BACK_EVERY_DAYS), putAwayAt: day(30), balance_c: -1250 }, true, 'every', null, true],
        ['90 days on, a listing, a deal or a role', { now: day(30 + WAY_BACK_EVERY_DAYS), putAwayAt: day(30), holds: true }, true, 'every', null, true],
        ['90 days on, nothing to lose: stays away', { now: day(30 + WAY_BACK_EVERY_DAYS), putAwayAt: day(30), balance_c: 0 }, false, null, null, true],
        ['89 days on: not yet', { now: day(30 + WAY_BACK_EVERY_DAYS) - 1, putAwayAt: day(30), holds: true }, false, null, day(30 + WAY_BACK_EVERY_DAYS), true],
        ['a year on, put away at day 300: the next 90 days from that ×', { now: day(301), putAwayAt: day(300), holds: true }, false, null, day(300 + WAY_BACK_EVERY_DAYS), true],
        // the slot
        ['the notifications card holds the slot: waits for the next landing', { now: day(0), slotTaken: true }, false, null, day(0), false],
        ['the slot taken on the Beans return', { now: day(5), putAwayAt: day(1), beansAt: day(4), balance_c: 4000, slotTaken: true }, false, null, day(5), true],
        ['the slot taken when nothing is due: the calendar as before', { now: day(2), putAwayAt: day(1), slotTaken: true }, false, null, day(WAY_BACK_MONTH_DAYS), true],
    ];
    it.each(ROWS)('%s', (_name, input, show, why, next, bell) => {
        expect(wayBackSchedule({ joinedAt: JOINED, kept: false, ...input })).toEqual({ show, why, next, bell });
    });

    it('Beans take the card\'s words over the 30 days when both wait', () => {
        expect(wayBackSchedule({ joinedAt: JOINED, now: day(40), kept: false, putAwayAt: day(1), beansAt: day(35), balance_c: 100 }).why).toBe('beans');
    });
});

describe('something to lose, and the first Beans seen', () => {
    it.each([
        [{}, false], [{ balance_c: 0 }, false], [{ balance_c: null }, false], [{ balance_c: 1 }, true], [{ balance_c: -1 }, true],
        [{ holds: true }, true], [{ balance_c: Number.NaN }, false],
    ] as const)('%j: %s', (input, lose) => {
        expect(wayBackSomethingToLose(input)).toBe(lose);
    });

    it.each([
        ['kept once, kept for good', day(4), 0, day(4)],
        ['first seen above zero: now', null, 4000, day(9)],
        ['zero: not yet', null, 0, null],
        ['owed: not Beans arriving', null, -500, null],
        ['not known: not yet', undefined, null, null],
    ] as const)('%s', (_name, beansAt, balance, out) => {
        expect(wayBackBeansSeen(beansAt, balance, day(9))).toBe(out);
    });
});

describe('the sweep: the design\'s invariants over every state', () => {
    const DAYS = [0, 1, 4, 29, 30, 31, 60, 119, 120, 121, 200, 400];
    const AWAYS: (number | null)[] = [null, 0, 1, 5, 30, 40, 119, 300];
    const BEANS: (number | null)[] = [null, 2, 35];
    const BALANCES: (number | null)[] = [null, 0, 4000, -300];
    it('never while kept; the reason always true; a showing put away now ends every return waiting', () => {
        let rows = 0;
        for (const d of DAYS) for (const a of AWAYS) for (const b of BEANS) for (const bal of BALANCES) for (const holds of [false, true]) for (const kept of [false, true]) {
            if ((a !== null && a > d) || (b !== null && b > d)) continue;
            const input: WayBackScheduleInput = { joinedAt: JOINED, now: day(d), kept, putAwayAt: a === null ? null : day(a), beansAt: b === null ? null : day(b), balance_c: bal, holds };
            const out = wayBackSchedule(input);
            rows++;
            if (kept) { expect(out, JSON.stringify(input)).toEqual({ show: false, why: null, next: null, bell: false }); continue; }
            expect(out.bell).toBe(a !== null);
            if (out.why === 'beans') expect(bal! > 0).toBe(true);
            if (out.why === 'every') expect(wayBackSomethingToLose(input) && d - a! >= WAY_BACK_EVERY_DAYS).toBe(true);
            if (out.why === 'month') expect(d >= WAY_BACK_MONTH_DAYS && a! < WAY_BACK_MONTH_DAYS).toBe(true);
            if (out.next !== null) expect(out.next).toBeGreaterThan(input.now);
            if (out.show) {
                // Put away at this moment: nothing is waiting until a new moment comes (the first Beans, the 30 days, 90 days on).
                const after = wayBackSchedule({ ...input, putAwayAt: input.now });
                expect(after.show, JSON.stringify(input)).toBe(false);
            }
        }
        expect(rows).toBeGreaterThan(1000);
    });

    it('at most four showings a year after the first month, with something to lose all year', () => {
        let away: number | null = day(31);
        let shown = 0;
        for (let d = 32; d <= 31 + 365; d++) {
            const out = wayBackSchedule({ joinedAt: JOINED, now: day(d), kept: false, putAwayAt: away, holds: true });
            if (out.show) { shown++; away = day(d); }
        }
        expect(shown).toBe(4);
    });
});

describe('the words', () => {
    it('the one line, and the fact on the first Beans', () => {
        expect(wayBackLine('first', null)).toBe('If this phone is lost, this is how you get back in.');
        expect(wayBackLine('month', '40 Beans')).toBe('If this phone is lost, this is how you get back in.');
        expect(wayBackLine('beans', '40 Beans')).toBe("You have 40 Beans here now. Keep a way back in, so they don't go with a lost phone.");
        expect(wayBackLine('beans', null)).toBe('If this phone is lost, this is how you get back in.');
    });

    it('every word comes through t(): nothing outside the pseudo-locale\'s brackets', () => {
        setLanguage(PSEUDO_LANG);
        expect(wayBackLine('first', null)).toBe(pseudoLocalise(WAY_BACK_WORDS.line));
        expect(wayBackLine('beans', '40 Beans').replace(/\[[^\]]*\]/g, '').replace('40 Beans', '')).not.toMatch(/[A-Za-z]/);
    });

    const catalog = (lang: string): Catalog => JSON.parse(readFileSync(new URL(`../../words/${lang}.json`, import.meta.url), 'utf8')) as Catalog;
    it.each(LANGS.filter((l) => l !== 'en'))('%s: a machine draft for every sentence, its amount kept', (lang) => {
        const c = catalog(lang) as Record<string, unknown>;
        for (const key of Object.values(WAY_BACK_WORDS)) {
            expect(typeof c[key], `${lang} ${key}`).toBe('string');
            if (key.includes('{amount}')) expect(c[key], `${lang} ${key}`).toContain('{amount}');
        }
    });
});
