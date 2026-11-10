import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, type UiLang } from '../words.js';
import { beansPriceWords, copyCardLine, copyPriceLine, copyPriceOf, copyPriceText, eventCopyColumn, eventCopyOf, type EventCopy, type ShownFromLine } from '../event-copy.js';

const es = JSON.parse(readFileSync(fileURLToPath(new URL('../../words/es.json', import.meta.url)), 'utf8'));
const from: ShownFromLine = { host: 'mullum.example.org', postId: 'p', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' };

afterEach(() => setLanguage('en'));

describe('a copy of an Offer or a Need, in words (slice G1′)', () => {
    it('reads in another language through the words layer, the community\'s name as the row has it', () => {
        setLanguage('es', [es]);
        const line = copyPriceLine({ from, price: { price_c: 2000, per: 'fixed' } });
        expect(line).toContain('Mullumbimby');
        expect(line).toContain('No puedes comprar ni tomar esto hasta que Mullumbimby te dé la bienvenida.');
        expect(line).not.toContain("You can't buy");
    });

    it('says the line Marty asked for, word for word', () => {
        expect(copyPriceLine({ from, price: { price_c: 2000, per: 'fixed' } })).toBe("20 Beans in Mullumbimby · You can't buy or take this until Mullumbimby welcomes you.");
    });

    it('a Need is answered, not bought: the director\'s words, in all four forms, read from the row\'s own type', () => {
        const price = { price_c: 2000, per: 'fixed' } as const;
        expect(copyPriceLine({ from, price, need: true })).toBe("20 Beans in Mullumbimby · You can't answer this until Mullumbimby welcomes you.");
        expect(copyPriceLine({ from: null, price, need: true })).toBe("20 Beans in another community · You can't answer this here.");
        expect(copyPriceLine({ from, price: null, need: true })).toBe("You can't answer this until Mullumbimby welcomes you.");
        expect(copyPriceLine({ from: null, price: null, need: true })).toBe("This is from another community, so you can't answer it here.");

        const node = { shownCopy: true, shownFrom: from, shownPrice: '2000 fixed' };
        expect(copyPriceLine(eventCopyOf({ ...node, type: 'need' })!)).toContain("You can't answer this");
        expect(copyPriceLine(eventCopyOf({ shown_from: eventCopyColumn(node), type: 'need' })!)).toContain("You can't answer this");
        expect(copyPriceLine(eventCopyOf({ shown_from: '{not json', type: 'need' })!)).toBe("This is from another community, so you can't answer it here.");
        // The Offer's line stays, and an event's row is what it was.
        expect(copyPriceLine(eventCopyOf({ ...node, type: 'offer' })!)).toBe("20 Beans in Mullumbimby · You can't buy or take this until Mullumbimby welcomes you.");
        expect(eventCopyOf({ shownCopy: true, shownFrom: from, type: 'event' })).toEqual({ from });
    });

    it('a Need\'s line reads in every language through the words layer, its name and price where the language puts them', () => {
        const dir = fileURLToPath(new URL('../../words/', import.meta.url));
        const langs = readdirSync(dir).filter((f) => f.endsWith('.json'));
        expect(langs.length).toBeGreaterThanOrEqual(24);
        const english = copyPriceLine({ from, price: { price_c: 2000, per: 'fixed' }, need: true });
        for (const file of langs) {
            setLanguage(file.replace('.json', '') as UiLang, [JSON.parse(readFileSync(join(dir, file), 'utf8'))]);
            const line = copyPriceLine({ from, price: { price_c: 2000, per: 'fixed' }, need: true });
            expect(line, file).not.toBe(english);
            expect(line.split('Mullumbimby').length, file).toBe(3);
            expect(line, file).toContain('20');
            expect(copyPriceLine({ from: null, price: null, need: true }), file).not.toBe("This is from another community, so you can't answer it here.");
        }
    });

    it('says what the Beans are for, and that a free listing is free', () => {
        expect(beansPriceWords({ price_c: 500, per: 'hourly' })).toBe('5 Beans an hour');
        expect(beansPriceWords({ price_c: 300, per: 'daily' })).toBe('3 Beans a day');
        expect(beansPriceWords({ price_c: 200, per: 'weekly' })).toBe('2 Beans a week');
        expect(beansPriceWords({ price_c: 900, per: 'monthly' })).toBe('9 Beans a month');
        // Whole hundredths, shown as formatHundredths shows every figure: two decimals when not whole, a hundredth at the least.
        expect(beansPriceWords({ price_c: 1250, per: 'hourly' })).toBe('12.50 Beans an hour');
        expect(beansPriceWords({ price_c: 1, per: 'fixed' })).toBe('0.01 Beans');
        expect(copyPriceLine({ from, price: { price_c: 0, per: 'fixed' } })).toBe("Free in Mullumbimby · You can't buy or take this until Mullumbimby welcomes you.");
    });

    it('with no row of the directory there is no name to say, and it promises no welcome', () => {
        expect(copyPriceLine({ from: null, price: { price_c: 2000, per: 'fixed' } })).toBe("20 Beans in another community · You can't buy or take this here.");
        expect(copyPriceLine({ from: null, price: null })).toBe("This is from another community, so you can't buy or take it here.");
    });

    it('a price it can\'t read is no price: the line says less, and nothing false', () => {
        for (const raw of [undefined, null, 20, '', 'twenty fixed', '20', '20 fortnightly', '-1 fixed', '20 fixed extra', 'Ring me on 0400 000 000', '12.5 daily', '2000.0 fixed']) expect(copyPriceOf(raw)).toBeNull();
        expect(copyPriceLine({ from, price: copyPriceOf('Ring me') })).toBe("You can't buy or take this until Mullumbimby welcomes you.");
    });

    it('a price is kept and read back', () => {
        expect(copyPriceOf(copyPriceText({ price_c: 1250, per: 'daily' }))).toEqual({ price_c: 1250, per: 'daily' });
    });

    it('reads the same from the node and from the phone\'s cached column', () => {
        const node = { shownCopy: true, shownFrom: from, shownPrice: '2000 hourly' };
        const cached = { shown_from: eventCopyColumn(node) };
        expect(eventCopyOf(node)).toEqual(eventCopyOf(cached));
        expect(eventCopyOf(cached)?.price).toEqual({ price_c: 2000, per: 'hourly' });
        const noRow = { shownCopy: true, shownPrice: '500 fixed' };
        expect(eventCopyOf({ shown_from: eventCopyColumn(noRow) })).toEqual({ from: null, price: { price_c: 500, per: 'fixed' } });
        expect(eventCopyColumn({})).toBeNull();
    });

    it('an event has no price, as before', () => {
        expect(eventCopyOf({ shownCopy: true, shownFrom: from })).toEqual({ from });
    });

    it('the from-line on the page is the row\'s, with its door', () => {
        const copy: EventCopy = { from: { ...from, door: 'invite' } };
        expect(copyCardLine(copy.from!)).toContain('from Mullumbimby');
    });
});
