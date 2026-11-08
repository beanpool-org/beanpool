/**
 * A listing priced at 0 Beans reads as free (listing-price.ts): "Free" on an Offer, "Free" on a Need's card and "Free help
 * wanted" in a Need's price box, whatever the price unit; a listing with a price, or with none sent, is left to the caller.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../words.js';
import { FREE_PRICE_WORDS, freePriceLabel, freePriceWords, isFreePrice } from '../listing-price.js';

afterEach(() => setLanguage('en'));

const TYPES = ['offer', 'need'] as const;
const UNITS = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'] as const;

describe('isFreePrice: only a number that is 0', () => {
    it.each([[0, true], [-0, true], ['0', true], [' 0 ', true], ['0.00', true],
        [1, false], [0.5, false], [40, false], ['40', false], [-1, false],
        [null, false], [undefined, false], ['', false], ['  ', false], ['free', false], [NaN, false], [Infinity, false], [{}, false], [false, false]])(
        '%j -> %s', (credits, free) => expect(isFreePrice(credits)).toBe(free));
});

describe('freePriceWords: the table, 0 and above 0 x Offer and Need x each price unit', () => {
    // The price unit is not an input: a price by the hour, day, week or month at 0 is as free as a total. The table walks
    // every unit anyway, so a future change that lets a unit back in fails here.
    for (const type of TYPES) {
        for (const unit of UNITS) {
            it(`${type} at 0, ${unit}: Free on a card, ${type === 'need' ? 'Free help wanted' : 'Free'} in the box`, () => {
                const post = { credits: 0, type, priceType: unit };
                expect(freePriceWords(post.credits, post.type, 'short')).toBe('Free');
                expect(freePriceWords(post.credits, post.type)).toBe('Free');
                expect(freePriceWords(post.credits, post.type, 'box')).toBe(type === 'need' ? 'Free help wanted' : 'Free');
            });
            it(`${type} at 40, ${unit}: not free, the caller draws the figure`, () => {
                const post = { credits: 40, type, priceType: unit };
                expect(freePriceWords(post.credits, post.type, 'short')).toBeNull();
                expect(freePriceWords(post.credits, post.type, 'box')).toBeNull();
                expect(freePriceLabel(post.credits, post.type)).toBeNull();
            });
        }
    }

    it('a price the node did not send is not free: the card keeps its "?"', () => {
        for (const credits of [undefined, null, '', 'abc', NaN]) {
            expect(freePriceWords(credits, 'offer')).toBeNull();
            expect(freePriceWords(credits, 'need', 'box')).toBeNull();
        }
    });

    it('a type this build does not know reads as an Offer would, never "Free help wanted"', () => {
        for (const type of [undefined, null, '', 'poll', 'event']) expect(freePriceWords(0, type, 'box')).toBe('Free');
    });

    it('the words never carry a Beans sign, a figure or a unit', () => {
        for (const type of TYPES) for (const form of ['short', 'box'] as const) {
            expect(freePriceWords(0, type, form)).not.toMatch(/[0-9Ʀ]|🫘|Beans|\/|hr|day|week|month/i);
        }
    });
});

describe('freePriceLabel: the box label over a free Need', () => {
    it('a free Need is labelled Price, never "Willing to pay"; an Offer and a priced Need keep the page\'s own label (null)', () => {
        expect(freePriceLabel(0, 'need')).toBe('Price');
        expect(freePriceLabel(0, 'offer')).toBeNull();
        expect(freePriceLabel(40, 'need')).toBeNull();
        expect(freePriceLabel(undefined, 'need')).toBeNull();
    });
});

describe('the words', () => {
    it('are the English keys, with the context the shop front, Home and the lobby already use for "Free"', () => {
        expect(String(FREE_PRICE_WORDS.short)).toContain('Free');
        expect(String(FREE_PRICE_WORDS.short)).toContain('a listing with no price');
        expect(String(FREE_PRICE_WORDS.needBox)).toContain('Free help wanted');
    });

    it('translate through the words layer: a catalog for the language carries them, the English shows where it has none', () => {
        setLanguage('fr', [{ 'Free\u0004a listing with no price': 'Gratuit', 'Free help wanted': 'Aide gratuite recherchée' }] as never);
        expect(freePriceWords(0, 'offer')).toBe('Gratuit');
        expect(freePriceWords(0, 'need', 'box')).toBe('Aide gratuite recherchée');
        expect(freePriceLabel(0, 'need')).toBe('Price');
    });
});
