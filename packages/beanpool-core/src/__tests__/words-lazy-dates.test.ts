/**
 * The web build's date words (#1941 review N-f): words-dates.ts is replaced by an empty table there
 * (apps/pwa/vite.config.ts), so the first chunk carries English alone, and each language's own module
 * (words-dates/<lang>.ts) arrives with its words through addDateWords. Until it does, that language's dates read
 * English, never a throw; once it has, they read exactly as on the phone and the server, which carry every language.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLDR_DATE_WORDS } from '../words-dates.js';
import { dateWords as ruDates } from '../words-dates/ru.js';
import { dateWords as zhHansDates } from '../words-dates/zh-Hans.js';

const OCT_15 = new Date(Date.UTC(2026, 9, 15, 9, 5));

async function wordsWithoutTables() {
    vi.resetModules();
    vi.doMock('../words-dates.js', () => ({ CLDR_DATE_WORDS: {} }));
    return import('../words.js');
}

describe('date words loaded one language at a time (the web build)', () => {
    afterEach(() => {
        vi.doUnmock('../words-dates.js');
        vi.resetModules();
    });

    it('every language has its own module, and words-dates.ts gathers exactly those', () => {
        expect(CLDR_DATE_WORDS.ru).toBe(ruDates);
        expect(CLDR_DATE_WORDS['zh-Hans']).toBe(zhHansDates);
        expect(Object.keys(CLDR_DATE_WORDS)).toHaveLength(24);
    });

    it('without the tables only English is carried, and a language not yet loaded reads English without throwing', async () => {
        const w = await wordsWithoutTables();
        expect(Object.keys(w.DATE_WORDS)).toEqual(['en']);
        w.setLanguage('ru');
        expect(w.formatDate(OCT_15, 'day-month', { utc: true })).toBe('15 Oct');
        expect(w.formatNumber(12.5)).toBe('12.5');
        expect(w.wordsFor('zh-Hans').formatDate(OCT_15, 'day-month-year', { utc: true })).toBe('15 Oct 2026');
    });

    it('a language added with its module reads as it does where every table ships', async () => {
        const w = await wordsWithoutTables();
        w.addDateWords('ru', ruDates);
        w.addDateWords('zh-Hans', zhHansDates);
        w.setLanguage('ru');
        expect(w.formatDate(OCT_15, 'day-month', { utc: true })).toBe('15 окт.');
        expect(w.formatNumber(12.5)).toBe('12,5');
        expect(w.wordsFor('zh-Hans').formatDate(OCT_15, 'day-month-year', { utc: true })).toBe('2026年10月15日');
        // The same text the full build writes.
        vi.doUnmock('../words-dates.js');
        vi.resetModules();
        const full = await import('../words.js');
        expect(full.wordsFor('ru').formatDate(OCT_15, 'day-month', { utc: true })).toBe('15 окт.');
    });

    it('English is never replaced', async () => {
        const w = await wordsWithoutTables();
        w.addDateWords('en' as never, ruDates);
        expect(w.wordsFor('en').formatDate(OCT_15, 'day-month', { utc: true })).toBe('15 Oct');
    });
});
