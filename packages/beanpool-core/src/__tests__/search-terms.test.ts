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
        // Punctuation parts words, as posts_fts's unicode61 parts them: "NEAR(a" is two words, never "neara".
        expect(expandSearchTerms('NEAR(a b)')).toEqual(['near']);
    });
    it('parts words at Chinese and full-width punctuation, so a word between them is found (#1781)', () => {
        expect(searchTermsFor('鸡蛋，牛奶')).toEqual(['鸡蛋', '牛奶']);
        expect(searchTermsFor('鸡蛋、牛奶')).toEqual(['鸡蛋', '牛奶']);
        expect(searchTermsFor('鸡蛋。牛奶；面包：米！鱼？')).toEqual(['鸡蛋', '牛奶', '面包', '米', '鱼']);
        expect(searchTermsFor('（牛奶）【鸡蛋】「パン」')).toEqual(['牛奶', '鸡蛋', 'パン']);
        expect(searchTermsFor('鸡蛋＠牛奶＃面包～米｡ﾊﾟﾝ')).toEqual(['鸡蛋', '牛奶', '面包', '米', 'ﾊﾟﾝ']);
        expect(searchTermsFor('eggs,milk')).toEqual(expect.arrayContaining(['eggs', 'milk']));
        // The letters inside U+3000–303F stay: 々 repeats the character before it (人々, people).
        expect(searchTermsFor('人々、時々')).toEqual(['人々', '時々']);
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
    it('asks FTS5 nothing it cannot take: quote marks alone are no words, and control characters go (#1716 confirmation)', () => {
        expect(searchTermsFor('"')).toEqual([]);
        expect(searchTermsFor("' \"")).toEqual([]);
        expect(searchTermsFor('eggs\u0000')).toEqual(expandSearchTerms('eggs'));
        expect(searchTermsFor('\u0000')).toEqual([]);
        expect(searchTermsFor('x\u0000y').join(' ')).not.toContain('\u0000');
    });
});

describe('one-character words', () => {
    it('keeps a one-character word outside ASCII beside another word; a lone a-z letter still goes (#1716 confirmation)', () => {
        expect(expandSearchTerms('大米 鱼')).toEqual(['大米', '鱼']);
        expect(expandSearchTerms('알 우유')).toEqual(['알', '우유']);
        expect(expandSearchTerms('米 rice')).toEqual(expect.arrayContaining(['米', 'rice']));
        expect(expandSearchTerms('a kale')).not.toContain('a');
    });
});
