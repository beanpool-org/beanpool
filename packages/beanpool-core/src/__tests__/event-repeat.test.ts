import { afterEach, describe, expect, it } from 'vitest';
import { PSEUDO_LANG, pluralKey, setLanguage } from '../words.js';
import {
    repeatCaption,
    repeatLengthProblem,
    repeatUntilLabel,
    seriesBackOnLine,
    repeatChoiceKeyOf,
    repeatChoicesFor,
    repeatPatternFor,
    repeatRefusalText,
    repeatSkipNote,
    repeatUntilMax,
    repeatUntilProblem,
    seriesCancelledLine,
    seriesDateLabel,
    seriesMovedFromLine,
} from '../event-repeat.js';

const labels = (date: string) => repeatChoicesFor(date).map((c) => c.label);
const keys = (date: string) => repeatChoicesFor(date).map((c) => c.key);

describe('repeatChoicesFor: the Repeats select, from the first date', () => {
    it('Fri 16 Oct 2026 (the third Friday): never, weekly, fortnightly, the 16th, the third Friday', () => {
        expect(labels('2026-10-16')).toEqual([
            'Does not repeat',
            'Every week on Friday',
            'Every 2 weeks on Friday',
            'Every month on the 16th',
            'Every month on the third Friday',
        ]);
    });

    it('Fri 30 Oct 2026 (the last Friday, a 5th): the last Friday, never a "fifth"', () => {
        expect(keys('2026-10-30')).toEqual(['never', 'weekly', 'fortnightly', 'monthly-day', 'monthly-last']);
        expect(labels('2026-10-30')[4]).toBe('Every month on the last Friday');
        expect(labels('2026-10-30')[3]).toBe('Every month on the 30th');
    });

    it('Fri 27 Nov 2026 (4th and last Friday): both the fourth and the last', () => {
        expect(keys('2026-11-27')).toEqual(['never', 'weekly', 'fortnightly', 'monthly-day', 'monthly-nth', 'monthly-last']);
        expect(labels('2026-11-27').slice(4)).toEqual(['Every month on the fourth Friday', 'Every month on the last Friday']);
    });

    it('ordinals: 1st, 2nd, 3rd, 11th, 12th, 13th, 21st, 22nd, 23rd, 31st', () => {
        const day = (d: string) => labels(d)[3];
        expect(day('2026-10-01')).toBe('Every month on the 1st');
        expect(day('2026-10-02')).toBe('Every month on the 2nd');
        expect(day('2026-10-03')).toBe('Every month on the 3rd');
        expect(day('2026-10-11')).toBe('Every month on the 11th');
        expect(day('2026-10-12')).toBe('Every month on the 12th');
        expect(day('2026-10-13')).toBe('Every month on the 13th');
        expect(day('2026-10-21')).toBe('Every month on the 21st');
        expect(day('2026-10-22')).toBe('Every month on the 22nd');
        expect(day('2026-10-23')).toBe('Every month on the 23rd');
        expect(day('2026-10-31')).toBe('Every month on the 31st');
    });

    it('the first, second weekday of a month', () => {
        expect(labels('2026-10-05')[4]).toBe('Every month on the first Monday');
        expect(labels('2026-10-14')[4]).toBe('Every month on the second Wednesday');
    });

    it('an unreadable date offers only "Does not repeat"', () => {
        expect(keys('')).toEqual(['never']);
        expect(keys('2026-02-30')).toEqual(['never']);
    });
});

describe('repeatPatternFor: what the form sends as eventRepeat (the node fills time and minutes)', () => {
    it('each choice is the closed shape the node takes', () => {
        expect(repeatPatternFor('never', '2026-10-16')).toBeNull();
        expect(repeatPatternFor('weekly', '2026-10-16')).toEqual({ freq: 'weekly', interval: 1, byDay: 'FR' });
        expect(repeatPatternFor('fortnightly', '2026-10-16')).toEqual({ freq: 'weekly', interval: 2, byDay: 'FR' });
        expect(repeatPatternFor('monthly-day', '2026-10-16')).toEqual({ freq: 'monthly', interval: 1, byMonthDay: 16 });
        expect(repeatPatternFor('monthly-nth', '2026-10-16')).toEqual({ freq: 'monthly', interval: 1, byDay: 'FR', pos: 3 });
        expect(repeatPatternFor('monthly-last', '2026-10-30')).toEqual({ freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 });
    });

    it('a choice the new first date no longer has falls back to never (the select resets)', () => {
        expect(repeatPatternFor('monthly-last', '2026-10-16')).toBeNull();
        expect(repeatPatternFor('monthly-nth', '2026-10-30')).toBeNull();
    });

    it('repeatChoiceKeyOf reads a stored rule back to its choice', () => {
        expect(repeatChoiceKeyOf(null)).toBe('never');
        expect(repeatChoiceKeyOf({ freq: 'weekly', interval: 1, byDay: 'FR' })).toBe('weekly');
        expect(repeatChoiceKeyOf({ freq: 'weekly', interval: 2, byDay: 'FR' })).toBe('fortnightly');
        expect(repeatChoiceKeyOf({ freq: 'monthly', interval: 1, byMonthDay: 16 })).toBe('monthly-day');
        expect(repeatChoiceKeyOf({ freq: 'monthly', interval: 1, byDay: 'FR', pos: 3 })).toBe('monthly-nth');
        expect(repeatChoiceKeyOf({ freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 })).toBe('monthly-last');
    });

    it('a rule the form cannot make (every 3 weeks, every 3 months, a frequency it does not know) reads as "other", never as a choice it would re-send', () => {
        expect(repeatChoiceKeyOf({ freq: 'weekly', interval: 3, byDay: 'FR' })).toBe('other');
        expect(repeatChoiceKeyOf({ freq: 'monthly', interval: 3, byMonthDay: 16 })).toBe('other');
        expect(repeatChoiceKeyOf({ freq: 'monthly', interval: 6, byDay: 'FR', pos: 3 })).toBe('other');
        expect(repeatChoiceKeyOf({ freq: 'monthly', interval: 2, byDay: 'FR', pos: -1 })).toBe('other');
        expect(repeatChoiceKeyOf({ freq: 'daily', interval: 1 } as any)).toBe('other');
        // "other" is never offered and never becomes a pattern, so nothing re-sends it as another rule.
        expect(keys('2026-10-16')).not.toContain('other');
        expect(repeatPatternFor('other', '2026-10-16')).toBeNull();
    });
});

describe('repeatLengthProblem: a date must end before the next one starts (the node\'s tooLong)', () => {
    const DAY = 1440;
    it('says why before Save, in the node\'s own sentence', () => {
        const why = 'An event that repeats must end before its next date starts';
        expect(repeatLengthProblem('weekly', '2026-10-16', 7 * DAY)).toBe(why);
        expect(repeatLengthProblem('weekly', '2026-10-16', 7 * DAY - 1)).toBeNull();
        expect(repeatLengthProblem('fortnightly', '2026-10-16', 14 * DAY)).toBe(why);
        expect(repeatLengthProblem('fortnightly', '2026-10-16', 8 * DAY)).toBeNull();
        expect(repeatLengthProblem('monthly-day', '2026-10-16', 28 * DAY)).toBe(why);
        expect(repeatLengthProblem('monthly-nth', '2026-10-16', 27 * DAY)).toBeNull();
        expect(repeatLengthProblem('weekly', '2026-10-16', 120)).toBeNull();
    });
    it('nothing for a one-off, an unoffered choice or an unknown length', () => {
        expect(repeatLengthProblem('never', '2026-10-16', 30 * DAY)).toBeNull();
        expect(repeatLengthProblem('monthly-last', '2026-10-16', 30 * DAY)).toBeNull();
        expect(repeatLengthProblem('other', '2026-10-16', 30 * DAY)).toBeNull();
        expect(repeatLengthProblem('weekly', '2026-10-16', NaN)).toBeNull();
    });
});

describe('repeatSkipNote: the 29th to 31st', () => {
    it('says which months are skipped, only for monthly on a day past the 28th', () => {
        expect(repeatSkipNote('monthly-day', '2026-10-31')).toBe('(months without a 31st are skipped)');
        expect(repeatSkipNote('monthly-day', '2026-10-30')).toBe('(months without a 30th are skipped)');
        expect(repeatSkipNote('monthly-day', '2027-01-29')).toBe('(months without a 29th are skipped)');
        expect(repeatSkipNote('monthly-day', '2026-10-28')).toBeNull();
        expect(repeatSkipNote('weekly', '2026-10-31')).toBeNull();
        expect(repeatSkipNote('monthly-last', '2026-10-30')).toBeNull();
    });
});

describe('repeatCaption: the ↻ line on a card, Home and the map popup', () => {
    it('reads each rule short', () => {
        expect(repeatCaption({ freq: 'weekly', interval: 1, byDay: 'FR' })).toBe('Every Friday');
        expect(repeatCaption({ freq: 'weekly', interval: 2, byDay: 'FR' })).toBe('Every 2 weeks on Friday');
        expect(repeatCaption({ freq: 'weekly', interval: 3, byDay: 'MO' })).toBe('Every 3 weeks on Monday');
        expect(repeatCaption({ freq: 'monthly', interval: 1, byMonthDay: 16 })).toBe('Monthly on the 16th');
        expect(repeatCaption({ freq: 'monthly', interval: 1, byDay: 'FR', pos: 3 })).toBe('Monthly, third Friday');
        expect(repeatCaption({ freq: 'monthly', interval: 1, byDay: 'FR', pos: -1 })).toBe('Monthly, last Friday');
    });

    it('says a monthly interval above 1, and a weekly one above 2, as whole sentences', () => {
        expect(repeatCaption({ freq: 'monthly', interval: 3, byMonthDay: 16 })).toBe('Every 3 months on the 16th');
        expect(repeatCaption({ freq: 'monthly', interval: 6, byDay: 'FR', pos: 3 })).toBe('Every 6 months, third Friday');
        expect(repeatCaption({ freq: 'monthly', interval: 2, byDay: 'MO', pos: 1 })).toBe('Every 2 months, first Monday');
        expect(repeatCaption({ freq: 'monthly', interval: 12, byDay: 'FR', pos: -1 }, '2030-12-27')).toBe('Every 12 months, last Friday · until 27 Dec 2030');
        expect(repeatCaption({ freq: 'weekly', interval: 3, byDay: 'FR' })).toBe('Every 3 weeks on Friday');
        expect(repeatCaption({ freq: 'weekly', interval: 12, byDay: 'FR' })).toBe('Every 12 weeks on Friday');
    });

    it('says the weekly count with the language\'s plural forms (the confirmation of #1993, NB2: Russian 2–4 and 5–12 differ)', () => {
        setLanguage('ru', [{ [pluralKey('Every {weekday}', 'Every {n} weeks on {weekday}')]: {
            one: 'Каждую {n} неделю: {weekday}', few: 'Каждые {n} недели: {weekday}', many: 'Каждые {n} недель: {weekday}', other: 'Каждые {n} недели: {weekday}',
        } }]);
        try {
            expect(repeatCaption({ freq: 'weekly', interval: 2, byDay: 'FR' })).toMatch(/^Каждые 2 недели: /);
            expect(repeatCaption({ freq: 'weekly', interval: 4, byDay: 'FR' })).toMatch(/^Каждые 4 недели: /);
            expect(repeatCaption({ freq: 'weekly', interval: 5, byDay: 'FR' })).toMatch(/^Каждые 5 недель: /);
            expect(repeatCaption({ freq: 'weekly', interval: 12, byDay: 'FR' })).toMatch(/^Каждые 12 недель: /);
        } finally {
            setLanguage('en');
        }
    });

    it('adds the last date when there is one', () => {
        expect(repeatCaption({ freq: 'weekly', interval: 1, byDay: 'FR' }, '2026-12-18')).toBe('Every Friday · until 18 Dec 2026');
    });

    it('nothing for a one-off or an unreadable rule', () => {
        expect(repeatCaption(null)).toBe('');
        expect(repeatCaption(undefined)).toBe('');
        expect(repeatCaption({ freq: 'daily' } as any)).toBe('');
    });
});

describe('Until', () => {
    it('is at most five years after the first date', () => {
        expect(repeatUntilMax('2026-10-16')).toBe('2031-10-16');
        expect(repeatUntilProblem('', '2026-10-16')).toBeNull();
        expect(repeatUntilProblem('2026-10-16', '2026-10-16')).toBeNull();
        expect(repeatUntilProblem('2031-10-16', '2026-10-16')).toBeNull();
        expect(repeatUntilProblem('2026-10-15', '2026-10-16')).toBe('The last date must be a date on or after the first one');
        expect(repeatUntilProblem('2031-10-17', '2026-10-16')).toBe('The last date can be at most 5 years after the first one');
    });

    it('a last date reads with its year, as the caption has it ("15 Dec 2028", never "Fri 15 Dec")', () => {
        expect(repeatUntilLabel('2028-12-15')).toBe('15 Dec 2028');
        expect(repeatUntilLabel('not a date')).toBe('');
    });
});

describe('the detail\'s Next dates and the host\'s lines', () => {
    it('a date reads "Fri 23 Oct"', () => {
        expect(seriesDateLabel('2026-10-23')).toBe('Fri 23 Oct');
    });

    it('cancelling the current date: "Fri 16 Oct is cancelled. Next: Fri 23 Oct"', () => {
        expect(seriesCancelledLine('2026-10-16', '2026-10-23T20:50')).toBe('Fri 16 Oct is cancelled. Next: Fri 23 Oct');
        expect(seriesCancelledLine('2026-10-16', null)).toBe('Fri 16 Oct is cancelled.');
    });

    it('bringing it back: "Fri 16 Oct is back on", as the node tells those going', () => {
        expect(seriesBackOnLine('2026-10-16')).toBe('Fri 16 Oct is back on');
    });

    it('Change this date only: "Moved from the regular Friday"', () => {
        expect(seriesMovedFromLine({ freq: 'weekly', interval: 1, byDay: 'FR' })).toBe('Moved from the regular Friday');
        expect(seriesMovedFromLine({ freq: 'monthly', interval: 1, byMonthDay: 16 })).toBe('Moved from the regular date');
    });
});

describe('repeatRefusalText: the node\'s sentence, through t()', () => {
    it('a known refusal comes back as the words layer has it; anything else as sent', () => {
        expect(repeatRefusalText('The first date must be one of the repeating dates')).toBe('The first date must be one of the repeating dates');
        expect(repeatRefusalText('Something else entirely')).toBe('Something else entirely');
        expect(repeatRefusalText(undefined)).toBe('');
    });

    afterEach(() => setLanguage('en'));
    it('the two refusals a host meets outside the form ("This event has been cancelled", "Pick a time zone from the list") go through t() too', () => {
        setLanguage(PSEUDO_LANG);
        for (const m of ['This event has been cancelled', 'Pick a time zone from the list', 'The first date must be one of the repeating dates']) {
            expect(repeatRefusalText(m)).not.toBe(m);
            expect(repeatRefusalText(m)).toContain('[');
        }
        expect(repeatRefusalText('Something else entirely')).toBe('Something else entirely');
    });
});
