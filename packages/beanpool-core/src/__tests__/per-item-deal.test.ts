/**
 * Per-item prices P3, core (DESIGN-per-item-price-fable.md §2.2, §2.3, §9 "Apps: the box's totals"): the buyer's box, what it
 * sends, the refusals it shows, and both sides' deal lines. Rob's panels: 300 Beans each, 20 of them, or all 20 for 5,500.
 * Each check names the change that turns it red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    ITEM_BOX_START, itemBoxPick, itemBoxStep, itemBoxTyped, itemDealOf, itemDealRow, itemDealTakenLine, itemDealTitle,
    itemSellerStock, itemTakeUpBox, itemTakeUpRefusalIn, itemTrustLine, type ItemBoxState,
} from '../per-item-deal';
import { EACH, ITEM_TAKE_UP_REFUSALS, itemStockRefusal, itemTakeUpOf, type PerItemListing } from '../per-item';
import { formatHundredths } from '../hundredths';
import { releaseAmount, releaseLine } from '../deal-step';
import { setLanguage } from '../words';

const c = (beans: number) => Math.round(beans * 100);
const panels = (unitsLeft: number, lot: { units: number; beans: number } | null = { units: 20, beans: 5500 }, price = 300): PerItemListing =>
    ({ priceType: EACH, price_c: c(price), unitsLeft, lot: lot ? { units: lot.units, price_c: c(lot.beans) } : null });
const at = (count: string, option: 'each' | 'lot' = 'each'): ItemBoxState => ({ option, count });
const box = (p: unknown, s: ItemBoxState = ITEM_BOX_START) => itemTakeUpBox(p, s, 'Rob')!;

afterEach(() => setLanguage('en'));

describe('the box (§2.2): the lines, the total and what Confirm sends', () => {
    it('opens at one: the price and count beside the stepper, the price for all as the second choice', () => {
        const b = box(panels(20));
        expect(b.title).toBe('How many would you like?');
        expect(b.chooseLabel).toBe('Choose how many');
        expect(b.eachLine).toBe('300 Beans each · 20 left');
        expect(b.lot).toEqual({ label: 'All 20 for 5,500 Beans', saving: '500 less than one by one' });
        expect(b.total).toBe('1 × 300 = 300 Beans');
        expect(b.send).toEqual({ hours: 1, itemOption: 'each', expect_c: c(300) });
        expect(b.canLess).toBe(false);
        expect(b.canMore).toBe(true);
    });
    it('3 of them: 3 × 300 = 900, and what Rob receives (red if the total or the fee is worked out apart from itemTotal)', () => {
        const b = box(panels(20), at('3'));
        expect(b.total).toBe('3 × 300 = 900 Beans');
        expect(b.trust).toBe('900 Beans go into trust now. Rob receives 886.50 when you release them (1.5% goes to the community).');
        expect(b.send).toEqual({ hours: 3, itemOption: 'each', expect_c: c(900) });
        expect(b.refusal).toBeNull();
    });
    it('stepping up to all 20 while the price for all shows chooses it: nobody pays 6,000 where 5,500 is on offer (red if 20 stays one by one)', () => {
        let s: ItemBoxState = at('19');
        s = itemBoxStep(panels(20), s, 1);
        expect(s.option).toBe('lot');
        const b = box(panels(20), s);
        expect(b.option).toBe('lot');
        expect(b.total).toBe('All 20 for 5,500 Beans');
        expect(b.trust).toBe('5,500 Beans go into trust now. Rob receives 5,417.50 when you release them (1.5% goes to the community).');
        expect(b.send).toEqual({ hours: 20, itemOption: 'lot', expect_c: c(5500) });
        expect(b.canMore).toBe(false);
        // Typed rather than stepped: the same.
        expect(box(panels(20), itemBoxTyped(panels(20), '20')).send).toEqual({ hours: 20, itemOption: 'lot', expect_c: c(5500) });
        // Even with "Choose how many" ticked: 20 one by one is not on offer while the price for all is.
        expect(box(panels(20), at('20', 'each')).send).toEqual({ hours: 20, itemOption: 'lot', expect_c: c(5500) });
    });
    it('one fewer from all of them, or "Choose how many" tapped, is 19 one by one', () => {
        expect(itemBoxStep(panels(20), at('20', 'lot'), -1)).toEqual(at('19'));
        expect(itemBoxPick(panels(20), at('20', 'lot'), 'each')).toEqual(at('19'));
        expect(itemBoxPick(panels(20), at('3'), 'lot')).toEqual(at('20', 'lot'));
        expect(box(panels(20), itemBoxPick(panels(20), at('3'), 'lot')).send?.itemOption).toBe('lot');
    });
    it('one taken singly (19 left): no second choice, 19 is 19 × 300, and + stops there (red if the lot shows for another count)', () => {
        const b = box(panels(19), at('19'));
        expect(b.lot).toBeNull();
        expect(b.eachLine).toBe('300 Beans each · 19 left');
        expect(b.total).toBe('19 × 300 = 5,700 Beans');
        expect(b.send).toEqual({ hours: 19, itemOption: 'each', expect_c: c(5700) });
        expect(b.canMore).toBe(false);
        expect(itemBoxStep(panels(19), at('19'), 1)).toEqual(at('19'));
        // The price for all can't be picked while it is off.
        expect(itemBoxPick(panels(19), at('3'), 'lot')).toEqual(at('3'));
        expect(box(panels(19), at('19', 'lot')).send).toEqual({ hours: 19, itemOption: 'each', expect_c: c(5700) });
    });
    it('no price for all: 20 is just a number, 20 × 300', () => {
        const b = box(panels(20, null), at('20'));
        expect(b.lot).toBeNull();
        expect(b.total).toBe('20 × 300 = 6,000 Beans');
        expect(b.send).toEqual({ hours: 20, itemOption: 'each', expect_c: c(6000) });
    });
    it('- stops at 1; a count that is not one starts again at 1', () => {
        expect(itemBoxStep(panels(20), at('1'), -1)).toEqual(at('1'));
        expect(itemBoxStep(panels(20), at('2.5'), 1)).toEqual(at('1'));
        expect(itemBoxStep(panels(20), at('25'), -1)).toEqual(at('20', 'lot'));
    });
});

describe('the refusals in the box, before anything is sent', () => {
    it('not a whole number from 1: "Choose a whole number, 1 or more." and nothing to send (red if 2.5 is rounded)', () => {
        for (const typed of ['', '0', '2.5', '-1', '+3', 'abc', '10000']) {
            const b = box(panels(20), at(typed));
            expect(b.refusal, typed).toBe('Choose a whole number, 1 or more.');
            expect(b.send, typed).toBeNull();
            expect(b.total, typed).toBeNull();
        }
    });
    it('more than are left: "Only 2 left now. Choose 2 or fewer." (red if the box sends what the node would refuse)', () => {
        const b = box(panels(2, null), at('3'));
        expect(b.refusal).toBe('Only 2 left now. Choose 2 or fewer.');
        expect(b.send).toBeNull();
    });
    it('none left: "They have all been taken up." and the stepper is off', () => {
        const b = box(panels(0, null));
        expect(b.refusal).toBe('They have all been taken up.');
        expect(b.eachLine).toBe('300 Beans each · All taken for now');
        expect(b.send).toBeNull();
        expect(b.canMore || b.canLess).toBe(false);
        expect(box({ ...panels(4, null), status: 'completed' }).send).toBeNull();
    });
});

describe('what Confirm sends is what the node takes, at the listing\'s own figures', () => {
    it('every count from 1 to 20 and all of them: itemTakeUpOf and itemStockRefusal let it through, and the total shown names expect_c (red if the box and the node work the amount out differently)', () => {
        for (const p of [panels(20), panels(20, null), panels(13, { units: 13, beans: 3000 }), panels(7, null, 0.35)]) {
            const states = [...Array.from({ length: p.unitsLeft! }, (_, i) => at(String(i + 1))), at(String(p.unitsLeft), 'lot')];
            for (const s of states) {
                const b = box(p, s);
                expect(b.send, JSON.stringify(s)).not.toBeNull();
                const take = itemTakeUpOf(p, { n: b.send!.hours, option: b.send!.itemOption, expect_c: b.send!.expect_c });
                expect(take.ok, JSON.stringify(s)).toBe(true);
                if (take.ok) expect(itemStockRefusal(p, take.take)).toBeNull();
                expect(b.total).toContain(formatHundredths(b.send!.expect_c));
                expect(b.trust).toContain(formatHundredths(b.send!.expect_c));
            }
        }
    });
    it('a free one: "Free · 20 left", no total or trust line, 0 sent (the node holds nothing)', () => {
        const free = panels(20, null, 0);
        const b = box(free, at('3'));
        expect(b.eachLine).toBe('Free · 20 left');
        expect(b.total).toBeNull();
        expect(b.trust).toBeNull();
        expect(b.send).toEqual({ hours: 3, itemOption: 'each', expect_c: 0 });
        expect(itemTakeUpOf(free, { n: 3, option: 'each', expect_c: 0 }).ok).toBe(true);
    });
    it('a listing not priced each has no box (red if a Total Offer gets the per-item confirm)', () => {
        expect(itemTakeUpBox({ priceType: 'fixed', price_c: c(300) }, ITEM_BOX_START, 'Rob')).toBeNull();
        expect(itemTakeUpBox({ priceType: 'each', price_c: c(300) }, ITEM_BOX_START, 'Rob')).toBeNull();
    });
});

describe('a refusal from the node, said in the box', () => {
    it('each take-up code has its sentence, with the count now (red if a code loses its words)', () => {
        expect(itemTakeUpRefusalIn({ code: 'units_gone', unitsLeft: 2 })?.text).toBe('Only 2 left now. Choose 2 or fewer.');
        expect(itemTakeUpRefusalIn({ code: 'units_gone', unitsLeft: 0 })?.text).toBe('They have all been taken up.');
        expect(itemTakeUpRefusalIn({ code: 'lot_gone' })?.text).toBe('One has just been taken, so the price for all of them is off. You can still take what is left one by one.');
        expect(itemTakeUpRefusalIn({ code: 'price_changed' })?.text).toBe('The price changed while you were looking. Check it and try again.');
        expect(itemTakeUpRefusalIn({ code: 'count_refused' })?.text).toBe('Choose a whole number, 1 or more.');
        for (const code of ITEM_TAKE_UP_REFUSALS) expect(itemTakeUpRefusalIn({ code, unitsLeft: 3 })?.code).toBe(code);
    });
    it('any other error is not one: deal_open keeps its own words', () => {
        for (const e of [{ code: 'deal_open' }, new Error('Server returned 500'), null, undefined, { code: 7 }]) expect(itemTakeUpRefusalIn(e)).toBeNull();
    });
});

describe('both sides of the deal (§2.3)', () => {
    const web3 = { itemOption: 'each', hours: 3, amount_c: c(900) };
    const phoneAll = { item_option: 'lot', hours: 20, amount_c: c(5500) };
    it('reads the web\'s deal and the phone\'s copy; any other deal is not one (red if a deal for hours reads as items)', () => {
        expect(itemDealOf(web3)).toEqual({ option: 'each', count: 3, amount_c: c(900) });
        expect(itemDealOf(phoneAll)).toEqual({ option: 'lot', count: 20, amount_c: c(5500) });
        for (const other of [{ hours: 3, amount_c: c(900) }, { itemOption: 'each', hours: 2.5 }, { itemOption: 'x', hours: 3 }, null, { itemOption: 'each', hours: 0 }]) {
            expect(itemDealOf(other)).toBeNull();
        }
    });
    it('Your deals: "3 × Solar Panels", "All 20 × Solar Panels", and any other deal its title', () => {
        expect(itemDealTitle(web3, 'Solar Panels')).toBe('3 × Solar Panels');
        expect(itemDealTitle(phoneAll, 'Solar Panels')).toBe('All 20 × Solar Panels');
        expect(itemDealTitle({ hours: 3 }, 'Solar Panels')).toBe('Solar Panels');
    });
    it('the seller\'s row and the buyer\'s line', () => {
        expect(itemDealRow(web3, 'Dana', '11 Nov')).toBe('Dana · 3 for 900 Beans held · since 11 Nov');
        expect(itemDealRow(phoneAll, 'Dana', '11 Nov')).toBe('Dana · all 20 for 5,500 Beans held · since 11 Nov');
        expect(itemDealRow({ hours: 3, amount_c: c(900) }, 'Dana', '11 Nov')).toBeNull();
        expect(itemDealTakenLine(web3, '11 Nov')).toBe('✅ You took up 3 on 11 Nov · 900 Beans held in trust');
        expect(itemDealTakenLine(phoneAll, '11 Nov')).toBe('✅ You took up all 20 on 11 Nov · 5,500 Beans held in trust');
        expect(itemDealTakenLine({ hours: 3 }, '11 Nov')).toBeNull();
    });
    it('the seller\'s stock: "17 left · 3 held for buyers", the held deals\' counts added (red if a deal for hours is counted)', () => {
        expect(itemSellerStock(panels(17), [web3])).toBe('17 left · 3 held for buyers');
        expect(itemSellerStock(panels(16), [web3, { itemOption: 'each', hours: 1, amount_c: c(300) }, { hours: 5, amount_c: 1 }])).toBe('16 left · 4 held for buyers');
        expect(itemSellerStock(panels(0), [phoneAll])).toBe('All taken for now · 20 held for buyers');
        expect(itemSellerStock(panels(20), [])).toBe('20 left');
        expect(itemSellerStock({ priceType: 'fixed', price_c: 1 }, [web3])).toBeNull();
    });
    it('the chat\'s trust line carries the count as the push does, from the line\'s own metadata', () => {
        expect(itemTrustLine({ itemOption: 'each', count: 3, amount_c: c(900) }, 'Dana', 'Solar Panels'))
            .toBe('Dana took 3 of "Solar Panels". 900 Beans are held in trust.');
        expect(itemTrustLine({ itemOption: 'lot', count: 20, amount_c: c(5500) }, 'Dana', 'Solar Panels'))
            .toBe('Dana took all 20 of "Solar Panels". 5,500 Beans are held in trust.');
        expect(itemTrustLine({ amount_c: c(900) }, 'Dana', 'Solar Panels')).toBeNull();
        expect(itemTrustLine({ itemOption: 'each', count: 3, amount_c: c(900) }, null, 'Solar Panels')).toBeNull();
        expect(itemTrustLine({ itemOption: 'each', count: 3, amount_c: c(900) }, 'Dana', '')).toBeNull();
    });
});

describe('Release pays what a per-item deal holds (D5, F7)', () => {
    it('whatever count is confirmed, from the deal or the listing (red if releaseAmount re-rates a deal for items)', () => {
        expect(releaseAmount({ amount_c: c(900), hours: 3, itemOption: 'each' }, 1, { priceType: 'each' })).toBe(c(900));
        expect(releaseAmount({ amount_c: c(900), hours: 3 }, 1, { priceType: 'each' })).toBe(c(900));
        expect(releaseAmount({ amount_c: c(5500), hours: 20, itemOption: 'lot' }, 5, { priceType: 'fixed' })).toBe(c(5500));
        expect(releaseLine({ amount_c: c(900), hours: 3, itemOption: 'each' }, { priceType: 'each' }, null, 'Rob')).toBe('Transferring 900 B to Rob');
    });
    it('an hourly deal is still re-rated by the time confirmed (unchanged)', () => {
        expect(releaseAmount({ amount_c: c(30), hours: 3 }, 1, { priceType: 'hourly' })).toBe(c(10));
    });
});
