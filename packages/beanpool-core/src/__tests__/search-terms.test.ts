import { describe, expect, it } from 'vitest';
import { expandSearchTerms } from '../search-terms.js';

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
});
