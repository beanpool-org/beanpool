import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRICING_CATALOG, PRICING_CATEGORIES, type PricingCategory, type PricingGuideItem } from '../pricing-catalog.js';
import { STARTER_OFFERS, starterOffersFor, type StarterDraft } from '../starter-offers.js';
import { STARTER_SHEET_WORDS, starterFigureFor, starterOpeningFor, starterRows, starterSheet } from '../starter-sheet.js';
import { setLanguage, type Catalog } from '../words.js';

const CATEGORY_IDS = PRICING_CATEGORIES.map((c) => c.id);
const draftOf = (id: string): StarterDraft => {
    const [category, position] = id.split('.');
    return { ...STARTER_OFFERS[category as PricingCategory][Number(position) - 1], category: category as PricingCategory, id };
};
/** The default guide with one item's price or unit changed, as an owner can on their node. */
const guideWith = (name: RegExp, change: Partial<PricingGuideItem>): PricingGuideItem[] =>
    DEFAULT_PRICING_CATALOG.map((i) => (name.test(i.name) ? { ...i, ...change } : i));
const es = JSON.parse(readFileSync(fileURLToPath(new URL('../../words/es.json', import.meta.url)), 'utf8')) as Catalog;

afterEach(() => setLanguage('en'));

describe('the starter sheet: the rows for a member with nothing starred (design §3.1)', () => {
    it('labour, tools and the garden, each with its figure from the community guide and the composer\'s price type', () => {
        const rows = starterRows([], { beans: true, guide: DEFAULT_PRICING_CATALOG });
        expect(rows.map((r) => r.id)).toEqual(['labour.1', 'tools.1', 'garden.1']);
        expect(rows.map((r) => [r.emoji, r.title, r.price])).toEqual([
            ['👷', 'An hour of help', '25 Beans an hour'],
            ['🛠️', 'Lend a tool', 'Free'],
            ['🌻', 'Extra from the garden', '6 Beans'],
        ]);
        expect(rows.map((r) => r.opening)).toEqual([
            { title: 'An hour of help', description: 'An extra pair of hands for jobs around the house or yard. Tell me what and when.', category: 'labour', credits: 25, priceType: 'hourly' },
            { title: 'Lend a tool', description: 'A tool from my shed, free to borrow. Message me to say which one and for how long.', category: 'tools', credits: 0, priceType: 'fixed' },
            { title: 'Extra from the garden', description: 'Spare seedlings, cuttings and produce from my garden. Message me to arrange pickup.', category: 'garden', credits: 6, priceType: 'fixed' },
        ]);
    });

    it('a row says its title, its price and what a tap does, for a screen reader', () => {
        const [hour, lend] = starterRows([], { beans: true, guide: DEFAULT_PRICING_CATALOG });
        expect(hour.label).toBe('An hour of help, 25 Beans an hour. Opens a new Offer with this filled in.');
        expect(lend.label).toBe('Lend a tool, Free. Opens a new Offer with this filled in.');
    });

    it('the rows follow the stars: a member who starred Animals and Transport sees dog walking and a lift, not firewood', () => {
        const rows = starterRows(['animals', 'transport'], { beans: true, guide: DEFAULT_PRICING_CATALOG });
        expect(rows.map((r) => r.title)).toEqual(['Dog walking', 'A lift into town', 'Pet sitting']);
        expect(rows.map((r) => r.emoji)).toEqual(['🐾', '🚗', '🐾']);
        expect(rows.map((r) => r.id)).toEqual(starterOffersFor(['animals', 'transport']).map((d) => d.id));
    });
});

describe('the starter sheet: the price is the community\'s guide, or it is left for the member', () => {
    it('with no guide (not reached, or a node with none) a paid draft opens with the price blank, and a free one stays free', () => {
        for (const guide of [undefined, null, [] as PricingGuideItem[]]) {
            const [hour, lend, extra] = starterRows([], { beans: true, guide });
            expect([hour.price, lend.price, extra.price], String(guide)).toEqual([null, 'Free', null]);
            expect([hour.opening.credits, lend.opening.credits, extra.opening.credits], String(guide)).toEqual([null, 0, null]);
            // The price type stays the draft's own, so a blank per-hour price is still asked per hour.
            expect([hour.opening.priceType, extra.opening.priceType]).toEqual(['hourly', 'fixed']);
            expect(hour.label).toBe('An hour of help. Opens a new Offer with this filled in.');
        }
    });

    it('the figure follows the owner\'s guide: a re-priced item is the new figure', () => {
        const guide = guideWith(/Moving & Heavy Lifting/, { priceBeans: 30 });
        const [hour] = starterRows([], { beans: true, guide });
        expect(hour.price).toBe('30 Beans an hour');
        expect(hour.opening.credits).toBe(30);
    });

    it('an item the owner has re-united is dropped: a Total at one week\'s price must not stand for "to hire for the day"', () => {
        const trailer = draftOf('transport.2');
        expect(trailer.title).toBe('Trailer hire');
        expect(starterFigureFor(DEFAULT_PRICING_CATALOG, trailer)).toBe(20);
        const reunited = guideWith(/^Box Trailer/, { unit: 'week' });
        expect(starterFigureFor(reunited, trailer)).toBeNull();
        const [row] = starterRows(['transport'], { beans: true, guide: reunited }).filter((r) => r.id === 'transport.2');
        expect(row.price).toBeNull();
        expect(row.opening.credits).toBeNull();
        // Per hour turned into per day is dropped too: the draft is "An hour of help".
        expect(starterFigureFor(guideWith(/Moving & Heavy Lifting/, { unit: 'day' }), draftOf('labour.1'))).toBeNull();
    });

    it('a price that is not a whole number of Beans, or not a price, gives no figure (the composers open whole Beans)', () => {
        const hour = draftOf('labour.1');
        expect(starterFigureFor(guideWith(/Moving & Heavy Lifting/, { priceBeans: 12.5 }), hour)).toBeNull();
        expect(starterFigureFor(guideWith(/Moving & Heavy Lifting/, { priceBeans: 0 }), hour)).toBeNull();
        expect(starterFigureFor(guideWith(/Moving & Heavy Lifting/, { priceBeans: Number.NaN }), hour)).toBeNull();
    });

    it('a Free draft and a draft with no guide words never get a figure, whatever the guide holds', () => {
        expect(starterFigureFor(DEFAULT_PRICING_CATALOG, draftOf('tools.1'))).toBeNull();
        expect(starterFigureFor(DEFAULT_PRICING_CATALOG, draftOf('health.1'))).toBeNull();
        expect(starterFigureFor(DEFAULT_PRICING_CATALOG, draftOf('mindset.3'))).toBeNull();
        expect(starterFigureFor(null, draftOf('labour.1'))).toBeNull();
        expect(starterFigureFor('nope' as unknown as PricingGuideItem[], draftOf('labour.1'))).toBeNull();
    });

    it('with the default guide every paid draft that names guide words gets a whole-Beans figure, and nothing else does', () => {
        const wrong: string[] = [];
        for (const category of CATEGORY_IDS) {
            STARTER_OFFERS[category].forEach((offer, i) => {
                const id = `${category}.${i + 1}`;
                const figure = starterFigureFor(DEFAULT_PRICING_CATALOG, draftOf(id));
                const expected = offer.priceType !== 'free' && !!offer.guide;
                if (expected !== (figure !== null)) wrong.push(`${id} ${offer.title}: figure ${figure}`);
                if (figure !== null && !(Number.isSafeInteger(figure) && figure > 0)) wrong.push(`${id}: ${figure} is not whole Beans`);
            });
        }
        expect(wrong).toEqual([]);
    });
});

describe('the starter sheet: where Beans are off (the global community)', () => {
    it('no price column, and every draft opens free', () => {
        const rows = starterRows([], { beans: false, guide: DEFAULT_PRICING_CATALOG });
        expect(rows.map((r) => r.price)).toEqual([null, null, null]);
        expect(rows.map((r) => r.opening.credits)).toEqual([0, 0, 0]);
        // Not "per hour" at nothing: it is a free post, one fee of nothing.
        expect(rows.map((r) => r.opening.priceType)).toEqual(['fixed', 'fixed', 'fixed']);
        expect(rows[0].label).toBe('An hour of help. Opens a new Offer with this filled in.');
    });

    it('a draft that says nothing about Beans in its words is the same either way', () => {
        const on = starterRows(['mindset'], { beans: true, guide: DEFAULT_PRICING_CATALOG });
        const off = starterRows(['mindset'], { beans: false, guide: DEFAULT_PRICING_CATALOG });
        expect(on.map((r) => r.title)).toEqual(off.map((r) => r.title));
        expect(on.map((r) => r.opening.description)).toEqual(off.map((r) => r.opening.description));
    });
});

describe('the starter sheet: what the composer is opened with (design §3.3: nothing posts itself)', () => {
    it('every draft of every category opens a composer-valid Offer: a known category, a title and words within the composer\'s limits, no photo, no place', () => {
        for (const category of CATEGORY_IDS) {
            STARTER_OFFERS[category].forEach((_, i) => {
                const draft = draftOf(`${category}.${i + 1}`);
                for (const beans of [true, false]) {
                    const o = starterOpeningFor(draft, beans, null);
                    const at = `${draft.id} beans=${beans}`;
                    expect(CATEGORY_IDS, at).toContain(o.category);
                    expect(o.title.trim().length, at).toBeGreaterThan(0);
                    expect([...o.title].length, at).toBeLessThanOrEqual(120);
                    expect([...o.description].length, at).toBeLessThanOrEqual(2000);
                    expect(['fixed', 'hourly'], at).toContain(o.priceType);
                    expect(Object.keys(o).sort(), `${at}: the opening carries words and a price only`).toEqual(['category', 'credits', 'description', 'priceType', 'title']);
                    if (!beans) expect(o.credits, at).toBe(0);
                }
            });
        }
    });

    it('the opening is the draft in the member\'s language, and the table is not touched', () => {
        const before = JSON.stringify(STARTER_OFFERS);
        setLanguage('es', [es]);
        const row = starterRows([], { beans: true, guide: DEFAULT_PRICING_CATALOG })[0];
        expect(row.title).not.toBe('An hour of help');
        expect(row.opening.title).toBe(row.title);
        expect(row.opening.description).not.toBe('An extra pair of hands for jobs around the house or yard. Tell me what and when.');
        expect(row.opening.credits).toBe(25);
        expect(row.opening.priceType).toBe('hourly');
        setLanguage('en');
        expect(JSON.stringify(STARTER_OFFERS)).toBe(before);
    });
});

describe('the starter sheet: its own words', () => {
    it('the heading, the note and the last row, in English', () => {
        const sheet = starterSheet([], { beans: true, guide: DEFAULT_PRICING_CATALOG });
        expect(sheet.title).toBe('What could you offer?');
        expect(sheet.note).toBe('Pick one. Every word is yours to change before it posts.');
        expect(sheet.other).toEqual({ title: 'Something else', label: 'Something else. Opens a blank new Offer.' });
        expect(sheet.rows).toHaveLength(3);
    });

    it('never says anything was posted, sent or saved (a sheet is a door, not a result)', () => {
        const sheet = starterSheet(['food'], { beans: true, guide: DEFAULT_PRICING_CATALOG });
        const all = [sheet.title, sheet.note, sheet.other.title, sheet.other.label, ...sheet.rows.map((r) => r.label)].join(' ');
        expect(all).not.toMatch(/\b(posted|sent|saved|published|listed|done)\b/i);
        // "before it posts" is the note's promise that nothing posts until Post: it is the one use of the word.
        expect(sheet.note).toMatch(/before it posts/);
    });

    it('words no member should read: no "resilience", no "survival", no currency mark', () => {
        for (const w of Object.values(STARTER_SHEET_WORDS)) expect(w).not.toMatch(/resilien|surviv|Ʀ/i);
    });

    it('is shown in the member\'s language through the catalog', () => {
        setLanguage('es', [es]);
        const sheet = starterSheet([], { beans: true, guide: DEFAULT_PRICING_CATALOG });
        expect(sheet.title).not.toBe('What could you offer?');
        expect(sheet.note).not.toBe('Pick one. Every word is yours to change before it posts.');
        expect(sheet.other.title).not.toBe('Something else');
        expect(sheet.rows[0].label).toContain(sheet.rows[0].title);
        expect(sheet.rows[0].label).toContain(sheet.rows[0].price!);
    });
});
