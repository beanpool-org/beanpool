/**
 * Per-item prices, core (DESIGN-per-item-price-fable.md §9 "Core": amounts, lotOffered, the fee figures, every word in
 * en/ru/fr/pt/es with one and many). Rob's panels: 300 Beans each, 20 of them, or all 20 for 5,500. Each check names the change
 * that turns it red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    EACH, ITEM_COUNT_MAX, NOT_PER_ITEM, isItemCount, isUnitsLeft, itemColumnsRefusal, itemTotal, itemsAmount, lotOffered, lotPriceIn,
    lotSaving, PER_ITEM_REFUSALS, perItemLine, perItemLines, perItemOffered, perItemRefusalText, sellerReceives, type PerItemListing,
} from '../per-item';
import { feeOf, formatHundredths } from '../hundredths';
import { beansPriceWords, copyPriceLine, copyPriceOf, copyPriceText } from '../event-copy';
import { setLanguage, wordsFor, type Catalog } from '../words';

const c = (beans: number) => Math.round(beans * 100);
const panels = (unitsLeft: number, lot: { units: number; beans: number } | null = { units: 20, beans: 5500 }): PerItemListing =>
    ({ priceType: EACH, price_c: c(300), unitsLeft, lot: lot ? { units: lot.units, price_c: c(lot.beans) } : null });

afterEach(() => setLanguage('en'));

describe('a count is a whole number from 1 to 9,999, never rounded', () => {
    it('takes 1 and 9,999 and refuses everything else at the door (red if isItemCount rounds or reads a string)', () => {
        expect(isItemCount(1)).toBe(true);
        expect(isItemCount(ITEM_COUNT_MAX)).toBe(true);
        for (const bad of [0, -1, 2.5, '3', Infinity, NaN, 10_000, null, undefined, [3], { n: 3 }]) expect(isItemCount(bad)).toBe(false);
        // A stored count may be 0 (all taken for now); a seller's never is.
        expect(isUnitsLeft(0)).toBe(true);
        expect(isUnitsLeft(-1) || isUnitsLeft(10_000) || isUnitsLeft(1.5)).toBe(false);
    });
});

describe('lotOffered: the price for all is on offer exactly while that many are left', () => {
    it('20 left with a price for 20: on (red if the count compare is dropped)', () => {
        expect(lotOffered(panels(20))).toBe(true);
    });
    it('one taken singly: off; the deal cancelled: on again (red if the lot stays "for all that is left")', () => {
        expect(lotOffered(panels(19))).toBe(false);
        expect(lotOffered(panels(0))).toBe(false);
        expect(lotOffered(panels(20))).toBe(true);
    });
    it('no lot, another unit, or a lot for fewer than 2: off', () => {
        expect(lotOffered(panels(20, null))).toBe(false);
        expect(lotOffered({ ...panels(20), priceType: 'fixed' })).toBe(false);
        expect(lotOffered({ priceType: EACH, price_c: c(300), unitsLeft: 1, lot: { units: 1, price_c: c(200) } })).toBe(false);
        expect(lotOffered(null)).toBe(false);
    });
});

describe('amounts: exact integers, the price for all only while it is on offer', () => {
    it('3 of 20 at 300 is 900; all 20 is 5,500 (red if itemTotal pays the lot when it is off, or more than are left)', () => {
        expect(itemTotal(panels(20), { option: 'each', n: 3 })).toBe(c(900));
        expect(itemTotal(panels(20), { option: 'lot' })).toBe(c(5500));
        expect(itemTotal(panels(19), { option: 'lot' })).toBeNull();
        expect(itemTotal(panels(2), { option: 'each', n: 3 })).toBeNull();
        expect(itemTotal(panels(20), { option: 'each', n: 2.5 })).toBeNull();
        expect(itemTotal({ ...panels(20), priceType: 'hourly' }, { option: 'each', n: 3 })).toBeNull();
        // The largest: a million Beans each, 9,999 of them, exact.
        expect(itemsAmount(c(1_000_000), ITEM_COUNT_MAX)).toBe(c(1_000_000) * ITEM_COUNT_MAX);
    });
    it('the saving is one by one less the price for all: 6,000 − 5,500 = 500', () => {
        expect(lotSaving(panels(20))).toBe(c(500));
        expect(lotSaving(panels(17))).toBeNull();
    });
    it("the design's fee figures: 900 → 13.50 and 886.50; 5,500 → 82.50 and 5,417.50; 300 → 295.50 (red if the fee rounds twice)", () => {
        expect([feeOf(c(900)), sellerReceives(c(900))]).toEqual([c(13.5), c(886.5)]);
        expect([feeOf(c(5500)), sellerReceives(c(5500))]).toEqual([c(82.5), c(5417.5)]);
        expect(sellerReceives(c(300))).toBe(c(295.5));
    });
});

describe('the rules on the three columns, as they will be stored (create and edit alike)', () => {
    const cols = (units_left: number | null, lot_price_c: number | null, lot_units: number | null) => ({ units_left, lot_price_c, lot_units });
    it('a count alone, and a count with a price for all of them for exactly that many, hold', () => {
        expect(itemColumnsRefusal(c(300), cols(20, null, null))).toBeNull();
        expect(itemColumnsRefusal(c(300), cols(20, c(5500), 20))).toBeNull();
        // Bound to a number no longer left (17 now): kept, and it holds while it is less than 20 one by one.
        expect(itemColumnsRefusal(c(300), cols(17, c(5500), 20))).toBeNull();
    });
    it('the price for all must be less than one by one (red if <= becomes <)', () => {
        expect(itemColumnsRefusal(c(300), cols(20, c(6000), 20))).toEqual({ code: 'lot_not_less', count: 20, total_c: c(6000) });
        expect(itemColumnsRefusal(c(300), cols(20, c(5999.99), 20))).toBeNull();
        // The price for one lowered under a kept price for all: refused, never a lot that costs more than one by one.
        expect(itemColumnsRefusal(c(200), cols(20, c(5500), 20))?.code).toBe('lot_not_less');
        // A free listing has no price for all.
        expect(itemColumnsRefusal(0, cols(20, c(1), 20))?.code).toBe('lot_not_less');
    });
    it('a price for all needs 2 or more, set together with its number, and a count is 0 to 9,999', () => {
        expect(itemColumnsRefusal(c(300), cols(1, c(200), 1))?.code).toBe('lot_needs_two');
        expect(itemColumnsRefusal(c(300), cols(20, c(5500), null))?.code).toBe('lot_needs_two');
        expect(itemColumnsRefusal(c(300), cols(20, null, 20))?.code).toBe('lot_price_refused');
        expect(itemColumnsRefusal(c(300), cols(10_000, null, null))?.code).toBe('units_refused');
        expect(itemColumnsRefusal(c(300), { ...NOT_PER_ITEM })?.code).toBe('units_refused');
    });
    it('a price for all as sent: { price_c } in whole hundredths above 0, or none; anything else refused, never rounded', () => {
        expect(lotPriceIn({ price_c: c(5500) })).toEqual({ ok: true, price_c: c(5500) });
        expect(lotPriceIn(null)).toEqual({ ok: true, price_c: null });
        expect(lotPriceIn(undefined)).toEqual({ ok: true, price_c: null });
        for (const bad of [{ price_c: 0 }, { price_c: -100 }, { price_c: 5.5 }, { price_c: '5500' }, 5500, [5500], {}]) expect(lotPriceIn(bad).ok).toBe(false);
    });
    it("the features answer: offered only where it says perItem: true (red if absent reads as on)", () => {
        expect(perItemOffered({ perItem: true })).toBe(true);
        expect(perItemOffered({})).toBe(false);
        expect(perItemOffered({ perItem: 'true' })).toBe(false);
        expect(perItemOffered(null)).toBe(false);
    });
});

describe('the words, in English', () => {
    it('the card line: three whole phrases, the price for all only while it is on offer (§2.1)', () => {
        expect(perItemLine(panels(20))).toBe('300 Beans each · 20 left · or all for 5,500');
        expect(perItemLine(panels(19))).toBe('300 Beans each · 19 left');
        expect(perItemLine(panels(0))).toBe('300 Beans each · All taken for now');
        expect(perItemLine({ ...panels(0), status: 'completed' })).toBe('300 Beans each · Sold out');
        expect(perItemLine({ priceType: EACH, price_c: 0, unitsLeft: 20, lot: null })).toBe('Free · 20 left');
        expect(perItemLine({ priceType: 'fixed', price_c: c(300) })).toBeNull();
    });
    it("the buyer's box and the seller's lines say the design's figures (§2.2-§2.4)", () => {
        expect(perItemLines.timesEquals(3, c(300))).toBe('3 × 300 = 900 Beans');
        expect(perItemLines.intoTrust(c(900), 'Rob')).toBe('900 Beans go into trust now. Rob receives 886.50 when you release them (1.5% goes to the community).');
        expect(perItemLines.intoTrust(c(5500), 'Rob')).toBe('5,500 Beans go into trust now. Rob receives 5,417.50 when you release them (1.5% goes to the community).');
        expect(perItemLines.allCountFor(20, c(5500))).toBe('All 20 for 5,500 Beans');
        expect(perItemLines.lessOneByOne(c(500))).toBe('500 less than one by one');
        expect(perItemLines.feeLine(c(300), c(5500))).toBe('1.5% goes to the community. You receive 295.50 Beans for each one, or 5,417.50 Beans for all of them.');
        expect(perItemLines.lotGood(20, c(5500), c(300))).toBe('All 20 for 5,500 Beans. One by one they come to 6,000.');
        expect(perItemLines.lotNotLess(20, c(300))).toBe('One by one, 20 come to 6,000 Beans. A price for all of them has to be less.');
        expect(perItemLines.dealTitle('each', 3, 'Solar Panels')).toBe('3 × Solar Panels');
        expect(perItemLines.dealTitle('lot', 20, 'Solar Panels')).toBe('All 20 × Solar Panels');
        expect(perItemLines.pushTook('each', 'Dana', 3, 'Solar Panels', c(900))).toBe('Dana took 3 of "Solar Panels". 900 Beans are held in trust.');
        expect(perItemLines.youTookUp('lot', 20, '11 Nov', c(5500))).toBe('✅ You took up all 20 on 11 Nov · 5,500 Beans held in trust');
    });
    it('one and many read differently where English does (red if tn is given the wrong count)', () => {
        expect(perItemLines.heldNotCounted(1)).toBe('1 is held for a buyer now. It is not counted here.');
        expect(perItemLines.heldNotCounted(3)).toBe('3 are held for buyers now. They are not counted here.');
        expect(perItemRefusalText({ code: 'units_changed', count: 1 })).toBe('Someone took some while you were editing. There is 1 left now. Check the number and save again.');
        expect(perItemRefusalText({ code: 'units_changed', count: 17 })).toBe('Someone took some while you were editing. There are 17 left now. Check the number and save again.');
    });
    it('every refusal has its sentence, and the node writes them in English whatever the active language', () => {
        const en = wordsFor('en');
        setLanguage('fr');
        expect(PER_ITEM_REFUSALS.length).toBe(7);
        for (const code of PER_ITEM_REFUSALS) {
            const text = perItemRefusalText({ code, count: 20, total_c: c(6000) }, en);
            expect(text.length).toBeGreaterThan(10);
            expect(text).not.toMatch(/[{}]/);
        }
        expect(perItemRefusalText({ code: 'lot_not_less', count: 20, total_c: c(6000) }, en)).toBe('One by one, 20 come to 6,000 Beans. A price for all of them has to be less.');
    });
});

describe('a copy on global says the price for one only (§6, the copy per)', () => {
    it("'each' is read back and said as the card says it (red if copyPriceOf drops the unit)", () => {
        expect(copyPriceOf(copyPriceText({ price_c: c(300), per: 'each' }))).toEqual({ price_c: c(300), per: 'each' });
        expect(beansPriceWords({ price_c: c(300), per: 'each' })).toBe('300 Beans each');
        const from = { host: 'byron.example', postId: null, name: 'Byron', url: 'https://byron.example', door: 'ask' as const };
        expect(copyPriceLine({ from, price: { price_c: c(300), per: 'each' } })).toBe("300 Beans each in Byron · You can't buy or take this until Byron welcomes you.");
        expect(copyPriceOf('30000 dozen')).toBeNull();
    });
});

describe('every sentence, in en/ru/fr/pt/es, with one and with many (§9 Core)', () => {
    const CATALOG_DIR = join(__dirname, '..', '..', 'words');
    const catalogOf = (lang: string): Catalog[] => {
        try { return [JSON.parse(readFileSync(join(CATALOG_DIR, `${lang}.json`), 'utf8')) as Catalog]; } catch { return []; }
    };
    // Every line, with a count or a figure of one and of many. Red when a line is added without a case here.
    const say: Record<keyof typeof perItemLines, (n: number) => string> = {
        each: (n) => perItemLines.each(c(n)), left: (n) => perItemLines.left(n), orAllFor: (n) => perItemLines.orAllFor(c(n)),
        allTakenForNow: () => perItemLines.allTakenForNow(), soldOut: () => perItemLines.soldOut(),
        eachShort: (n) => perItemLines.eachShort(c(n)), orAllForShort: (n) => perItemLines.orAllForShort(c(n)),
        allShort: (n) => perItemLines.allShort(c(n)), leftChip: (n) => perItemLines.leftChip(n),
        orAllCountFor: (n) => perItemLines.orAllCountFor(n, c(n)), howMany: () => perItemLines.howMany(), chooseHowMany: () => perItemLines.chooseHowMany(),
        allCountFor: (n) => perItemLines.allCountFor(n, c(n)), lessOneByOne: (n) => perItemLines.lessOneByOne(c(n)),
        timesEquals: (n) => perItemLines.timesEquals(n, c(1)), intoTrust: (n) => perItemLines.intoTrust(c(n), 'Rob'),
        onlyLeft: (n) => perItemLines.onlyLeft(n), allTakenUp: () => perItemLines.allTakenUp(), lotGone: () => perItemLines.lotGone(),
        priceChanged: () => perItemLines.priceChanged(), wholeNumber: () => perItemLines.wholeNumber(),
        youTookUp: (n) => `${perItemLines.youTookUp('each', n, '11 Nov', c(n))} ${perItemLines.youTookUp('lot', n, '11 Nov', c(n))}`,
        heldForBuyers: (n) => perItemLines.heldForBuyers(n),
        dealRow: (n) => `${perItemLines.dealRow('each', 'Dana', n, c(n), '11 Nov')} ${perItemLines.dealRow('lot', 'Dana', n, c(n), '11 Nov')}`,
        dealTitle: (n) => `${perItemLines.dealTitle('each', n, 'Panels')} ${perItemLines.dealTitle('lot', n, 'Panels')}`,
        pushTook: (n) => `${perItemLines.pushTook('each', 'Dana', n, 'Panels', c(n))} ${perItemLines.pushTook('lot', 'Dana', n, 'Panels', c(n))}`,
        releaseOtherCount: (n) => perItemLines.releaseOtherCount(n), unitEach: () => perItemLines.unitEach(),
        priceForOne: () => perItemLines.priceForOne(), howManyHave: () => perItemLines.howManyHave(), orAllOfThemFor: () => perItemLines.orAllOfThemFor(),
        lotEmpty: () => perItemLines.lotEmpty(), lotGood: (n) => perItemLines.lotGood(n, c(n), c(n)), lotNotLess: (n) => perItemLines.lotNotLess(n, c(1)),
        feeLine: (n) => `${perItemLines.feeLine(c(n), null)} ${perItemLines.feeLine(c(n), c(n))}`,
        howManyLeft: () => perItemLines.howManyLeft(), heldNotCounted: (n) => perItemLines.heldNotCounted(n),
        lotForOtherCount: (n) => perItemLines.lotForOtherCount(n + 3, n), unitsZero: () => perItemLines.unitsZero(),
    };
    // The seller's fee line says what they receive, not the price: that figure, in the language's own way of writing it.
    const figureOf: Partial<Record<keyof typeof perItemLines, (n: number) => string>> = { feeLine: (n) => formatHundredths(sellerReceives(c(n))) };
    it('names every line', () => {
        expect(Object.keys(say).sort()).toEqual(Object.keys(perItemLines).sort());
    });
    for (const lang of ['en', 'ru', 'fr', 'pt', 'es'] as const) {
        it(`${lang}: each is whole, every placeholder filled, the count or figure in it`, () => {
            setLanguage(lang, catalogOf(lang));
            for (const [name, line] of Object.entries(say) as [keyof typeof perItemLines, (n: number) => string][]) {
                for (const n of [1, 17]) {
                    const text = line(n);
                    expect(text.length, `${name}(${n})`).toBeGreaterThan(0);
                    expect(text, `${name}(${n})`).not.toMatch(/\{[A-Za-z0-9_]+\}/);
                    const figure = figureOf[name]?.(n);
                    if (figure) expect(text, `${name}(${n})`).toContain(figure);
                    else if (line.length > 0) expect(text, `${name}(${n})`).toMatch(new RegExp(`(^|\\D)${n}(\\D|$)`));
                }
            }
        });
    }
});
