/**
 * The seller's fields for a price for each one (slice P4, DESIGN-per-item-price-fable.md §2.4, §2.5, §9 "the form's hints and
 * carry-over"). Rob's panels: 300 Beans each, 20 of them, or all 20 for 5,500. Each check names the change that turns it red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    EMPTY_PER_ITEM_TEXT, amountAsTyped, carryTotalToEach, itemsHeldIn, perItemCreateFields, perItemEditFields, perItemEditStart, perItemFeeLine,
    perItemAfterUnitsChanged, perItemFormRefusal, perItemHeldNote, perItemIsFree, perItemLotForOtherLine, perItemLotHint, priceUnitsOffered, readCount,
    readPerItemForm, type PerItemFormText, type PerItemStored,
} from '../per-item-form';
import { AMOUNT_DIGITS } from '../amount-input';
import { parseHundredths } from '../hundredths';
import { itemColumnsRefusal, perItemLines } from '../per-item';
import { setLanguage } from '../words';

afterEach(() => setLanguage('en'));

const text = (price: string, count: string, lot = ''): PerItemFormText => ({ price, count, lot });
const panels = text('300', '20', '5500');
const c = (beans: number) => Math.round(beans * 100);

describe('Each is offered only on an Offer, only where the node says so, right after Total (§2.4, §6)', () => {
    it('off until the node\'s features answer says perItem: the five units it always had (red if Each shows early)', () => {
        const five = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'];
        expect(priceUnitsOffered(undefined, 'offer')).toEqual(five);
        expect(priceUnitsOffered({}, 'offer')).toEqual(five);
        expect(priceUnitsOffered({ perItem: false }, 'offer')).toEqual(five);
        expect(priceUnitsOffered({ perItem: 'true' }, 'offer')).toEqual(five);
    });
    it('on: Each is the second unit, after Total (red if it is last or first)', () => {
        expect(priceUnitsOffered({ perItem: true }, 'offer')).toEqual(['fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly']);
    });
    it('never on a Need or anything but an Offer (red if a Need can pick it)', () => {
        for (const type of ['need', 'poll', 'event', undefined, null]) expect(priceUnitsOffered({ perItem: true }, type)).not.toContain('each');
    });
    it('an Offer already priced each keeps its unit while the node does not say, so an edit never strands it', () => {
        expect(priceUnitsOffered(undefined, 'offer', 'each')).toContain('each');
        expect(priceUnitsOffered(undefined, 'offer', 'fixed')).not.toContain('each');
        expect(priceUnitsOffered(undefined, 'need', 'each')).not.toContain('each');
    });
});

describe('the boxes are read as typed, never rounded', () => {
    it('a count is digits, 0 to 9,999 (red if "2.5", "-3", "1e3", " " or 10000 is let through)', () => {
        expect(readCount('20')).toBe(20);
        expect(readCount(' 9999 ')).toBe(9999);
        expect(readCount('0')).toBe(0);
        for (const bad of ['', ' ', '2.5', '-3', '1e3', '10000', 'twenty', '3,5', '+3']) expect(readCount(bad)).toBe(null);
    });

    it('a count is read in the language\'s own digits, as the amount boxes read them (red if readCount takes ASCII 0-9 only: an Arabic, Hindi or Japanese number pad is refused)', () => {
        // The review's three: Arabic-Indic, Devanagari and full-width, each typed on its own language's number pad.
        expect(readCount('٢٠', 'ar')).toBe(20);
        expect(readCount('२०', 'hi')).toBe(20);
        expect(readCount('２０', 'ja')).toBe(20);
        // Every language the amount boxes read natively reads the same count: the one list, core AMOUNT_DIGITS.
        for (const [lang, digits] of Object.entries(AMOUNT_DIGITS)) {
            const typed = `${digits![2]}${digits![0]}`;
            expect(readCount(typed, lang as never), `${lang} ${typed}`).toBe(20);
            expect(parseHundredths(typed, lang as never), `${lang} as an amount`).toEqual({ ok: true, value: 2000 });
            expect(readCount(`${digits![9]}${digits![9]}${digits![9]}${digits![9]}`, lang as never), lang).toBe(9999);
            // 10,000, a fraction and a sign are still refused, in the language's own digits too.
            expect(readCount(`${digits![1]}${digits![0]}${digits![0]}${digits![0]}${digits![0]}`, lang as never), lang).toBe(null);
            expect(readCount(`${digits![2]}.${digits![5]}`, lang as never), lang).toBe(null);
            expect(readCount(`-${digits![3]}`, lang as never), lang).toBe(null);
        }
        // Not another language's digits, and never two systems in one number.
        expect(readCount('٢٠', 'en')).toBe(null);
        expect(readCount('٢٠', 'hi')).toBe(null);
        expect(readCount('٢0', 'ar')).toBe(null);
        // The boxes carry the language to every door: the same figures typed in Arabic are a good create.
        expect(readPerItemForm(text('٣٠٠', '٢٠', '٥٥٠٠'), 'ar')).toEqual({ price_c: c(300), count: 20, lot_c: c(5500), lotBad: false });
        expect(perItemCreateFields(text('٣٠٠', '٢٠', '٥٥٠٠'), 'ar')).toEqual({ ok: true, fields: { priceType: 'each', unitsLeft: 20, lot: { price_c: c(5500) } } });
        expect(perItemFormRefusal(text('٣٠٠', '٢٠', '٥٥٠٠'), null, 'ar')).toBe(null);
        expect(perItemFormRefusal(text('٣٠٠', '٢٠', '٦٠٠٠'), null, 'ar')).toMatchObject({ field: 'lot', code: 'lot_not_less' });
    });

    it('prices are whole hundredths through parseHundredths (red if a float is used)', () => {
        const r = readPerItemForm(text('300.50', '20', '5500.5'));
        expect(r).toEqual({ price_c: c(300.5), count: 20, lot_c: c(5500.5), lotBad: false });
        expect(readPerItemForm(text('300', '20', '0')).lotBad).toBe(true);
        expect(readPerItemForm(text('300', '20', 'abc')).lotBad).toBe(true);
        expect(readPerItemForm(text('300', '20', '')).lotBad).toBe(false);
        expect(readPerItemForm(text('1.234', '2')).price_c).toBe(null);
    });

    it('an amount comes back as the member types it, with no thousands mark (red if "5,500" is typed back)', () => {
        expect(amountAsTyped(c(5500))).toBe('5500');
        expect(amountAsTyped(c(5500.5))).toBe('5500.50');
        expect(amountAsTyped(null)).toBe('');
        expect(readPerItemForm(text('300', '20', amountAsTyped(c(5500)))).lot_c).toBe(c(5500));
    });
});

describe('the one live line under the price for all (§2.4)', () => {
    it('empty: leave it empty to sell one by one (red if the line is dropped)', () => {
        expect(perItemLotHint(text('300', '20'))).toEqual({ kind: 'empty', text: 'Leave this empty to sell them one by one only.' });
    });
    it('good: "All 20 for 5,500 Beans. One by one they come to 6,000."', () => {
        expect(perItemLotHint(panels)).toEqual({ kind: 'good', text: 'All 20 for 5,500 Beans. One by one they come to 6,000.' });
    });
    it('not less: the sentence names the one-by-one total (red if "less" is compared with <=)', () => {
        expect(perItemLotHint(text('300', '20', '6000'))).toEqual({
            kind: 'notLess', text: 'One by one, 20 come to 6,000 Beans. A price for all of them has to be less.',
        });
        expect(perItemLotHint(text('300', '20', '7000'))?.kind).toBe('notLess');
        expect(perItemLotHint(text('300', '20', '5999.99'))?.kind).toBe('good');
    });
    it('hidden when the count is 1, the price is Free or not yet a price, or the box holds no figure (red if any shows)', () => {
        expect(perItemLotHint(text('300', '1', '200'))).toBe(null);
        expect(perItemLotHint(text('0', '20', '200'))).toBe(null);
        expect(perItemLotHint(text('', '20', '200'))).toBe(null);
        expect(perItemLotHint(text('300', '', '200'))).toBe(null);
        expect(perItemLotHint(text('300', '20', 'x'))).toBe(null);
    });
    it('is the design\'s words, in the member\'s language, one and many (red if the line is not through the words layer)', () => {
        expect(perItemLines.lotGood(20, c(5500), c(300))).toBe('All 20 for 5,500 Beans. One by one they come to 6,000.');
        expect(perItemLines.lotGood(2, c(1), c(1))).toContain('All 2 for 1 Beans');
    });
});

describe('the fee line (§2.4)', () => {
    it('says what the seller receives for one, and for all of them while that price is good', () => {
        expect(perItemFeeLine(panels)).toBe('1.5% goes to the community. You receive 295.50 Beans for each one, or 5,417.50 Beans for all of them.');
    });
    it('names no price for all when there is none, or it is not less (red if a bad lot is promised)', () => {
        expect(perItemFeeLine(text('300', '20'))).toBe('1.5% goes to the community. You receive 295.50 Beans for each one.');
        expect(perItemFeeLine(text('300', '20', '6000'))).toBe('1.5% goes to the community. You receive 295.50 Beans for each one.');
    });
    it('is none for a Free or empty price', () => {
        expect(perItemFeeLine(text('0', '20'))).toBe(null);
        expect(perItemFeeLine(text('', '20'))).toBe(null);
    });
});

describe('Total -> Each: the figure moves to "Or all of them for" (§2.4, Damo\'s way in)', () => {
    it('5,500 typed as the Total becomes the price for all, with the price for one empty (red if it stays in the price box)', () => {
        expect(carryTotalToEach(text('5500', ''))).toEqual(text('', '', '5500'));
        expect(carryTotalToEach(text('5500', '20'))).toEqual(text('', '20', '5500'));
    });
    it('only a figure above 0 moves, and never over a price for all already typed (red if either is overwritten)', () => {
        expect(carryTotalToEach(text('0', ''))).toEqual(text('0', ''));
        expect(carryTotalToEach(text('', ''))).toEqual(text('', ''));
        expect(carryTotalToEach(text('abc', ''))).toEqual(text('abc', ''));
        expect(carryTotalToEach(text('300', '20', '5500'))).toEqual(text('300', '20', '5500'));
    });
});

describe('what the node would refuse, the form refuses first, with the same code and words (§2.4)', () => {
    it('a count must be given, a whole number from 1 (red if 0, empty or a fraction is sent)', () => {
        for (const count of ['', '0', '2.5', '-1', '10000', 'x']) {
            const r = perItemFormRefusal(text('300', count));
            expect(r?.code, count).toBe('units_refused');
            expect(r?.field).toBe('count');
            expect(r?.text).toBe('Say how many you have: a whole number from 1 to 9,999.');
        }
        expect(perItemFormRefusal(text('300', '1'))).toBe(null);
        expect(perItemFormRefusal(text('300', '9999'))).toBe(null);
    });
    it('a price for all of them needs 2 or more, is a Beans figure above 0, and is less than one by one', () => {
        expect(perItemFormRefusal(text('300', '1', '200'))).toMatchObject({ field: 'lot', code: 'lot_needs_two', text: 'A price for all of them needs 2 or more.' });
        expect(perItemFormRefusal(text('300', '20', '0'))).toMatchObject({ field: 'lot', code: 'lot_price_refused' });
        expect(perItemFormRefusal(text('300', '20', 'abc'))).toMatchObject({ field: 'lot', code: 'lot_price_refused' });
        expect(perItemFormRefusal(text('300', '20', '6000'))).toMatchObject({
            field: 'lot', code: 'lot_not_less', text: 'One by one, 20 come to 6,000 Beans. A price for all of them has to be less.',
        });
        expect(perItemFormRefusal(panels)).toBe(null);
    });
    it('is the node\'s own rule: whatever the form lets through, itemColumnsRefusal takes, and the other way (red if they drift apart)', () => {
        const prices = ['0.01', '1', '300', '1000.5'];
        const counts = ['1', '2', '3', '20', '9999'];
        const lots = ['', '0.01', '1', '2', '5', '299.99', '300', '599.99', '600', '5500', '99999'];
        for (const price of prices) for (const count of counts) for (const lot of lots) {
            const form = perItemFormRefusal(text(price, count, lot));
            const r = readPerItemForm(text(price, count, lot));
            const node = itemColumnsRefusal(r.price_c!, {
                units_left: r.count!, lot_price_c: r.lot_c, lot_units: r.lot_c === null ? null : r.count!,
            });
            // The form adds the node's own `lot_price_refused` for a box that is not above 0; the node never sees such a box.
            expect(form?.code ?? null, `${price} × ${count} / ${lot}`).toBe(lot !== '' && r.lot_c === null ? 'lot_price_refused' : node?.code ?? null);
        }
    });
    it('a Free price has no price for all of them: none is refused, none is sent', () => {
        expect(perItemIsFree(text('0', '20', '5500'))).toBe(true);
        expect(perItemFormRefusal(text('0', '20', '5500'))).toBe(null);
        const made = perItemCreateFields(text('0', '20', '5500'));
        expect(made.ok && 'lot' in made.fields).toBe(false);
    });
});

describe('a create sends the unit, the count and the price for all (§3, "On the wire")', () => {
    it('Rob\'s panels: each, 20, and { price_c: 550000 } (red if the lot is sent as a bare number or the count as text)', () => {
        const made = perItemCreateFields(panels);
        expect(made).toEqual({ ok: true, fields: { priceType: 'each', unitsLeft: 20, lot: { price_c: c(5500) } } });
    });
    it('no price for all: no lot key at all (red if null is sent)', () => {
        const made = perItemCreateFields(text('300', '20'));
        expect(made).toEqual({ ok: true, fields: { priceType: 'each', unitsLeft: 20 } });
    });
    it('a refusal comes back, not a body', () => {
        const made = perItemCreateFields(text('300', '0'));
        expect(made.ok).toBe(false);
    });
});

describe('an edit: the count the screen read, the count now, and the price for all (§2.5, §4.6)', () => {
    const stored = (unitsLeft: number, lot: { units: number; beans: number } | null): PerItemStored =>
        ({ wasEach: true, unitsLeft, lot: lot ? { units: lot.units, price_c: c(lot.beans) } : null });

    it('opens with the count and, while it is for the count left, the price for all (red if the box opens empty)', () => {
        expect(perItemEditStart(stored(20, { units: 20, beans: 5500 }))).toEqual({ count: '20', lot: '5500', lotForOther: null });
        expect(perItemEditStart(stored(20, null))).toEqual({ count: '20', lot: '', lotForOther: null });
    });

    it('a price for all that was for another number opens EMPTY, and says why (§2.5): "was for 20. There are 17 left"', () => {
        const start = perItemEditStart(stored(17, { units: 20, beans: 5500 }));
        expect(start).toEqual({ count: '17', lot: '', lotForOther: { units: 20, price_c: c(5500) } });
        expect(perItemLotForOtherLine(start.lotForOther!, 17)).toBe(
            'Your price for all of them was for 20. There are 17 left, so it is not showing. Set a price for the 17 left, or leave this empty.',
        );
        expect(perItemLotForOtherLine({ units: 20, price_c: c(5500) }, 1)).toContain('There is 1 left');
    });

    it('a listing that is not Each opens with empty boxes', () => {
        expect(perItemEditStart({ wasEach: false, unitsLeft: null, lot: null })).toEqual({ count: '', lot: '', lotForOther: null });
        expect(perItemEditStart(null)).toEqual({ count: '', lot: '', lotForOther: null });
    });

    it('sends the count it read as unitsLeftWas, always (red if it is dropped: a blind write undoes a sale)', () => {
        const s = stored(20, { units: 20, beans: 5500 });
        // 18 one by one come to 5,400, so a price for all of 5,500 would be refused as not less; 5,000 is good.
        expect(perItemEditFields(text('300', '18', '5500'), s, false)).toMatchObject({ ok: false, refusal: { code: 'lot_not_less' } });
        const made = perItemEditFields(text('300', '18', '5000'), s, false);
        expect(made).toMatchObject({ ok: true, fields: { priceType: 'each', unitsLeft: 18, unitsLeftWas: 20, lot: { price_c: c(5000) } } });
        const same = perItemEditFields(text('300', '20', '5500'), s, false);
        expect(same).toMatchObject({ ok: true, fields: { unitsLeft: 20, unitsLeftWas: 20, lot: { price_c: c(5500) } } });
    });

    it('a stored price for another number, box left alone: lot is ABSENT, so a title edit keeps it (red if null clears it)', () => {
        const s = stored(17, { units: 20, beans: 5500 });
        const made = perItemEditFields(text('300', '17', ''), s, false);
        expect(made.ok && 'lot' in made.fields).toBe(false);
    });

    it('a box the seller emptied sends null; a new figure sends it; an empty box with nothing stored sends nothing', () => {
        const s = stored(20, { units: 20, beans: 5500 });
        const emptied = perItemEditFields(text('300', '20', ''), s, true);
        expect(emptied.ok && emptied.fields.lot).toBe(null);
        const retyped = perItemEditFields(text('300', '20', '5000'), s, true);
        expect(retyped.ok && retyped.fields.lot).toEqual({ price_c: c(5000) });
        const none = perItemEditFields(text('300', '20', ''), stored(20, null), true);
        expect(none.ok && 'lot' in none.fields).toBe(false);
    });

    it('made Free, the stored price for all is cleared (a free listing has none)', () => {
        const made = perItemEditFields(text('0', '20', '5500'), stored(20, { units: 20, beans: 5500 }), false);
        expect(made.ok && made.fields.lot).toBe(null);
    });

    it('a price for all set for another number that the new price for one makes not-less: the box is empty and untouched, so it is CLEARED, not left for the node to refuse about a box nobody sees (red if lot stays absent)', () => {
        // Rob's panels: 20 for 5,500 at 300; 3 sold, released; 17 left. He lowers the price to 250 and leaves the empty box alone.
        const s = stored(17, { units: 20, beans: 5500 });
        // What the node says if the stale price is kept: 20 × 250 = 5,000, and 5,500 for all is no longer less than that.
        expect(itemColumnsRefusal(c(250), { units_left: 17, lot_price_c: c(5500), lot_units: 20 })).toMatchObject({ code: 'lot_not_less', count: 20 });
        const made = perItemEditFields(text('250', '17', ''), s, false);
        expect(made).toEqual({ ok: true, fields: { priceType: 'each', unitsLeft: 17, unitsLeftWas: 17, lot: null } });
        // The columns the node then holds take: no price for all at all.
        expect(itemColumnsRefusal(c(250), { units_left: 17, lot_price_c: null, lot_units: null })).toBe(null);
    });

    it('a stored price for another number that is STILL less one by one is kept (lot absent), so a title edit or a price that leaves it good does not clear it', () => {
        const s = stored(17, { units: 20, beans: 5500 });
        // 20 × 276 = 5,520 > 5,500: still less.
        for (const price of ['300', '299', '276']) {
            const made = perItemEditFields(text(price, '17', ''), s, false);
            expect(made.ok && 'lot' in made.fields, price).toBe(false);
        }
        // 20 × 275 = 5,500: equal is not less, and below that it is more so.
        for (const price of ['275', '250', '100']) {
            const made = perItemEditFields(text(price, '17', ''), s, false);
            expect(made.ok && made.fields.lot, price).toBe(null);
        }
    });

    it('whatever an untouched or emptied price-for-all box does, the node takes the columns that result (red if the form lets the node refuse a box nobody sees)', () => {
        // The node's own rule for an edit's lot (itemColumnsOnEdit): absent keeps the stored price and the number it is for,
        // null clears it, a figure is bound to the count saved with it. Then itemColumnsRefusal over the columns that result.
        const columns = (fields: { unitsLeft: number; unitsLeftWas?: number; lot?: { price_c: number } | null }, s: PerItemStored) => {
            let lot_price_c: number | null = s.lot?.price_c ?? null;
            let lot_units: number | null = s.lot?.units ?? null;
            if (fields.lot === null) { lot_price_c = null; lot_units = null; }
            else if (fields.lot && (fields.unitsLeft !== fields.unitsLeftWas || fields.lot.price_c !== lot_price_c)) { lot_price_c = fields.lot.price_c; lot_units = fields.unitsLeft; }
            return { units_left: fields.unitsLeft, lot_price_c, lot_units };
        };
        let ran = 0;
        for (const price of ['0', '0.01', '1', '100', '250', '275', '299.99', '300', '1000']) {
            for (const left of [0, 1, 17, 20, 25]) {
                for (const lot of [null, { units: 20, beans: 5500 }, { units: 17, beans: 5000 }, { units: 2, beans: 500 }]) {
                    for (const touched of [false, true]) {
                        const s = stored(left, lot);
                        const made = perItemEditFields(text(price, String(left), ''), s, touched);
                        if (!made.ok) continue;
                        ran++;
                        const price_c = Math.round(Number(price) * 100);
                        expect(itemColumnsRefusal(price_c, columns(made.fields, s)), `${price} / ${left} left / ${JSON.stringify(lot)} / touched ${touched}`).toBe(null);
                    }
                }
            }
        }
        expect(ran).toBeGreaterThan(200);
    });

    it('an unchanged 0 (all taken for now) is fine; changed to 0 it is "To stop selling, pause or remove the listing."', () => {
        const held = stored(0, null);
        expect(perItemEditFields(text('300', '0'), held, false).ok).toBe(true);
        const stop = perItemEditFields(text('300', '0'), stored(5, null), false);
        expect(stop).toMatchObject({ ok: false, refusal: { field: 'count', code: 'units_zero', text: 'To stop selling, pause or remove the listing.' } });
        expect(perItemFormRefusal(text('300', '0'), 5)?.code).toBe('units_zero');
        expect(perItemFormRefusal(text('300', '0'), null)?.code).toBe('units_refused');
    });

    it('made Each by this edit: no unitsLeftWas (the node takes the count as new), and the count is required', () => {
        const made = perItemEditFields(text('300', '20', '5500'), { wasEach: false, unitsLeft: null, lot: null }, true);
        expect(made).toEqual({ ok: true, fields: { priceType: 'each', unitsLeft: 20, lot: { price_c: c(5500) } } });
        expect(perItemEditFields(text('300', '', ''), null, false).ok).toBe(false);
    });
});

describe('a take-up landed while the form was open: the 409 moves the count AND the price for all (§2.5, the node\'s units_changed)', () => {
    // The review's example: all 20 for 5,000 at 300 each; 3 are taken while the seller edits, so 17 are left. 17 × 300 = 5,100,
    // so the old figure still reads as a good price for all 17 in the live line, though the node holds it for 20.
    const lot20 = { units: 20, price_c: c(5000) };

    it('the price-for-all box untouched is rebuilt for the count now: empty, with the "was for 20" line (red if it keeps showing 5000 for the 17 left)', () => {
        const after = perItemAfterUnitsChanged(lot20, 17, '5000', false);
        expect(after).toEqual({ stored: { unitsLeft: 17, lot: lot20 }, count: '17', lot: '' });
        expect(perItemLotForOtherLine(lot20, 17)).toContain('was for 20. There are 17 left');
        // What the seller read before the fix: a box that still said it was on offer for the 17.
        expect(perItemLotHint(text('300', '17', '5000'))?.text).toBe('All 17 for 5,000 Beans. One by one they come to 5,100.');
        // Now the box is empty and the live line is the plain one.
        expect(perItemLotHint(text('300', after.count, after.lot))).toEqual({ kind: 'empty', text: 'Leave this empty to sell them one by one only.' });
    });

    it('so the save does not send the old price back unchanged for the node to keep bound to 20 (red if lot is { price_c: 500000 } with unitsLeft === unitsLeftWas)', () => {
        const after = perItemAfterUnitsChanged(lot20, 17, '5000', false);
        const made = perItemEditFields(text('300', after.count, after.lot), { wasEach: true, ...after.stored }, false);
        expect(made).toEqual({ ok: true, fields: { priceType: 'each', unitsLeft: 17, unitsLeftWas: 17 } });
        // The reading that failed: the box left as it was, sent back for the node to keep bound to 20.
        const stale = perItemEditFields(text('300', '17', '5000'), { wasEach: true, unitsLeft: 17, lot: lot20 }, false);
        expect(stale).toMatchObject({ ok: true, fields: { unitsLeft: 17, unitsLeftWas: 17, lot: { price_c: c(5000) } } });
    });

    it('a price the seller touched stays as they typed it: it is for the count now (the node binds a new price to the count seen)', () => {
        expect(perItemAfterUnitsChanged(lot20, 17, '4800', true)).toEqual({ stored: { unitsLeft: 17, lot: lot20 }, count: '17', lot: '4800' });
        // Emptied by the seller: stays empty (and the save clears it).
        expect(perItemAfterUnitsChanged(lot20, 17, '', true).lot).toBe('');
    });

    it('a price for all that IS for the count now shows again (the count came back to the number it was set for)', () => {
        expect(perItemAfterUnitsChanged(lot20, 20, '', false)).toEqual({ stored: { unitsLeft: 20, lot: lot20 }, count: '20', lot: '5000' });
    });

    it('none stored: the count moves, the box stays as it is', () => {
        expect(perItemAfterUnitsChanged(null, 17, '', false)).toEqual({ stored: { unitsLeft: 17, lot: null }, count: '17', lot: '' });
    });

    it('typed back in the language\'s own way (ar)', () => {
        expect(perItemAfterUnitsChanged({ units: 17, price_c: c(5000) }, 17, '', false, 'ar').lot).toBe(amountAsTyped(c(5000), 'ar'));
    });
});

describe('the deals holding some of them (§2.5)', () => {
    it('adds the counts of the deals held (red if hours are read as money or a fraction is added)', () => {
        expect(itemsHeldIn([{ hours: 3 }, { hours: 2 }])).toBe(5);
        expect(itemsHeldIn([{ hours: 2.5 }, { hours: null }, {}, { hours: '3' }, { hours: 0 }, { hours: -1 }])).toBe(0);
        expect(itemsHeldIn([])).toBe(0);
    });
    it('"3 are held for buyers now. They are not counted here." with one and many, and nothing when none are held', () => {
        expect(perItemHeldNote(3)).toBe('3 are held for buyers now. They are not counted here.');
        expect(perItemHeldNote(1)).toBe('1 is held for a buyer now. It is not counted here.');
        expect(perItemHeldNote(0)).toBe(null);
    });
});

describe('the words for the fields are the design\'s (§2.4, §2.5)', () => {
    it('labels', () => {
        expect(perItemLines.unitEach()).toBe('Each');
        expect(perItemLines.priceForOne()).toBe('PRICE FOR ONE');
        expect(perItemLines.howManyHave()).toBe('HOW MANY DO YOU HAVE?');
        expect(perItemLines.orAllOfThemFor()).toBe('OR ALL OF THEM FOR (OPTIONAL)');
        expect(perItemLines.howManyLeft()).toBe('HOW MANY DO YOU HAVE LEFT?');
    });
    it('the empty text is the empty text', () => {
        expect(EMPTY_PER_ITEM_TEXT).toEqual({ price: '', count: '', lot: '' });
    });
});
