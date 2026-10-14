import { describe, expect, it } from 'vitest';
import { searchTermsFor } from '@beanpool/core';
import { matchesExpandedSearch } from './search';

describe('matchesExpandedSearch', () => {
    it('finds a word between Chinese or full-width punctuation, mid-run (#1781)', () => {
        expect(matchesExpandedSearch('鸡蛋，牛奶', '新鲜牛奶出售', '')).toBe(true);
        expect(matchesExpandedSearch('鸡蛋、牛奶', '新鲜牛奶出售', '')).toBe(true);
        expect(matchesExpandedSearch('（牛奶）', '', '每天新鲜牛奶')).toBe(true);
        expect(matchesExpandedSearch('鸡蛋，牛奶', '自行车', '')).toBe(false);
    });
    it('finds a hyphenated word as typed, never by its two-letter halves (#1808 review, finding 1)', () => {
        expect(matchesExpandedSearch('wi-fi', 'Wi-Fi router', '')).toBe(true);
        expect(matchesExpandedSearch('wi-fi', 'Wifi extender', '')).toBe(true);
        expect(matchesExpandedSearch('wi-fi', 'Window cleaning', '')).toBe(false);
        expect(matchesExpandedSearch('co-op', 'Co-op shares', '')).toBe(true);
        expect(matchesExpandedSearch('co-op', 'Cooking lessons', 'in the office')).toBe(false);
    });
    it('finds a word with an apostrophe whichever apostrophe the listing or the search was typed with (#1828 check, finding 1)', () => {
        for (const q of ["don't", 'don’t', 'donʼt']) {
            for (const title of ['Don’t miss: garden tools', "Don't miss: garden tools", 'Donʼt miss']) expect(matchesExpandedSearch(q, title, '')).toBe(true);
        }
        expect(matchesExpandedSearch("it's", 'It’s a lovely bike', '')).toBe(true);
        expect(matchesExpandedSearch("l'eau", 'L’eau de source', '')).toBe(true);
        expect(matchesExpandedSearch("l'eau", 'Eau de cologne', '')).toBe(true);
        expect(matchesExpandedSearch("п'ять", '', 'пʼять')).toBe(true);
        expect(matchesExpandedSearch('пʼять', '', "п'ять")).toBe(true);
        expect(matchesExpandedSearch("don't", 'Donuts and dolls', '')).toBe(false);
    });
    it("asks with core's words, as the phone and Home do: synonyms, stems, one-letter words dropped", () => {
        expect(matchesExpandedSearch('fruit', 'Fresh lemons', '')).toBe(true);
        expect(matchesExpandedSearch('eggs', 'One dozen egg', '')).toBe(true);
        expect(matchesExpandedSearch('a kale', 'Banana bread', '')).toBe(false);
        expect(matchesExpandedSearch('  ', 'Anything', '')).toBe(true);
        for (const q of ['鸡蛋，牛奶', 'fruit', 'NEAR(a b)']) {
            expect(searchTermsFor(q).length).toBeGreaterThan(0);
        }
    });
});
