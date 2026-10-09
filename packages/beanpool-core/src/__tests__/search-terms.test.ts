import { describe, expect, it } from 'vitest';
import { expandSearchTerms, searchTermsFor } from '../search-terms.js';

describe('expandSearchTerms', () => {
    it('adds the forward synonyms and the stem', () => {
        expect(expandSearchTerms('eggs')).toEqual(['eggs', 'egg', 'food', 'produce', 'poultry', 'farm', 'chicken']);
    });
    it('adds the reverse synonyms: fruit finds lemon', () => {
        expect(expandSearchTerms('fruit')).toContain('lemon');
    });
    it('drops one-letter words and punctuation, lowercases', () => {
        expect(expandSearchTerms('A  Kale!')).toEqual(expect.arrayContaining(['kale']));
        expect(expandSearchTerms('a')).toEqual([]);
    });
    it('treats a word the map object inherits ("constructor", "valueOf") as a plain word', () => {
        expect(expandSearchTerms('constructor')).toEqual(['constructor']);
        expect(expandSearchTerms('valueOf hasOwnProperty')).toEqual(['valueof', 'hasownproperty']);
    });
    it('keeps the letters of every script and takes off punctuation only', () => {
        for (const word of ['яйца', 'αυγά', 'अंडे', '鸡蛋', 'ไข่ไก่', 'jardín', 'piña', 'œufs', 'straße', '🥚']) {
            expect(expandSearchTerms(word)).toContain(word);
        }
        expect(expandSearchTerms('«Яйца»!')).toEqual(['яйца']);
        expect(expandSearchTerms('¡piña, jardín!')).toEqual(['piña', 'jardín']);
        expect(expandSearchTerms('鸡蛋。')).toEqual(['鸡蛋']);
        // Persian writes some words with a zero-width non-joiner inside: it is part of the word, not a gap.
        expect(expandSearchTerms('می\u200cخواهم')).toEqual(['می\u200cخواهم']);
        // Any space parts words, a no-break or ideographic one too.
        expect(expandSearchTerms('fresh\u00a0kale\u3000jardín')).toEqual(expect.arrayContaining(['fresh', 'kale', 'jardín']));
        expect(expandSearchTerms('eggs!')).toContain('eggs');
        expect(expandSearchTerms('NEAR(a b)')).toEqual(['neara']);
    });
});

describe('searchTermsFor', () => {
    it('is the expanded words when there are any', () => {
        expect(searchTermsFor('eggs')).toEqual(expandSearchTerms('eggs'));
        expect(searchTermsFor('яйца')).toEqual(['яйца']);
    });
    it('is the words as typed when expanding leaves none, never no words', () => {
        expect(searchTermsFor('蛋')).toEqual(['蛋']);
        expect(searchTermsFor(' Ü ')).toEqual(['ü']);
        expect(searchTermsFor('!!!')).toEqual(['!!!']);
        expect(searchTermsFor('a b')).toEqual(['a', 'b']);
        expect(searchTermsFor('')).toEqual([]);
        expect(searchTermsFor('  ')).toEqual([]);
    });
});
