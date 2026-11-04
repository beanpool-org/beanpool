import { describe, expect, it } from 'vitest';
import { isLendablePriceType } from '../lending.js';
import { DEFAULT_PRICING_CATALOG, PRICING_CATEGORIES, pricingItemFor, type PricingCategory } from '../pricing-catalog.js';
import {
    STARTER_FALLBACK_CATEGORIES, STARTER_OFFERS, STARTER_OFFER_COUNT, starterOffersFor, type StarterDraft, type StarterOffer,
} from '../starter-offers.js';

const CATEGORY_IDS = PRICING_CATEGORIES.map((c) => c.id);
/**
 * What a guide unit means to a member who reads the composer's price type beside the figure, given what a node keeps.
 * A node keeps a price type per day, week or month only on a loan; any other Offer is stored as one fee or by the hour
 * (apps/server/src/routes/marketplace.ts, "Any other listing is one fee or by the hour"; test-lendable-offers.ts pins it
 * and posts every draft below). So a guide unit that is an hour is a draft by the hour, and every other unit is a Total.
 * A figure per day, night, week or month is a Total only where the draft's own words say it is for one such span: a Total
 * that says nothing would read as the whole stay or hire at one span's price. A unit not named here fails the test until
 * someone says what it means, so a new "per fortnight" can't slip through as a Total.
 */
const SPAN_WORDS: Record<string, RegExp> = {
    day: /\bfor (a|the) day\b/i,
    night: /\bnight\b/i,
    week: /\bfor (a|the) week\b/i,
    month: /\bfor (a|the) month\b/i,
};
const ONE_PRICE_UNITS = [
    'loaf', 'plate', 'jar', 'service', 'set', 'each', 'slab', 'punnet', 'trailer', 'tree', 'trip', 'session', 'class', 'seat',
    'bundle', 'walk', 'dozen', 'job', 'project', 'm³', 'bag', 'event',
];
/** The price types a node keeps on an Offer that is not lent: one fee (a Free draft is one fee of nothing), or by the hour. */
const KEPT_WHEN_NOT_LENT = ['free', 'fixed', 'hourly'];
/** The eight drafts that were `daily` before the review of 5 Nov: the node would have kept each as a Total. */
const WERE_PER_DAY = ['labour.3', 'housing.2', 'animals.2', 'housing.3', 'tools.2', 'tools.3', 'transport.2', 'general.1'];
const ids = (drafts: readonly StarterDraft[]) => drafts.map((d) => d.id);
const ALL: { category: PricingCategory; position: number; offer: StarterOffer }[] = CATEGORY_IDS.flatMap((category) =>
    STARTER_OFFERS[category].map((offer, position) => ({ category, position, offer })));

describe('starter drafts: the table (design DESIGN-cold-start-trades-fable.md §3.4)', () => {
    it('every one of the 17 categories has exactly three drafts, and nothing else is in the table', () => {
        expect(CATEGORY_IDS).toHaveLength(17);
        expect(Object.keys(STARTER_OFFERS).sort()).toEqual([...CATEGORY_IDS].sort());
        for (const id of CATEGORY_IDS) expect(STARTER_OFFERS[id], id).toHaveLength(STARTER_OFFER_COUNT);
        expect(ALL).toHaveLength(51);
    });

    it('no two drafts share a title or a description (a row is told apart by its words)', () => {
        expect(new Set(ALL.map((a) => a.offer.title)).size).toBe(51);
        expect(new Set(ALL.map((a) => a.offer.description)).size).toBe(51);
    });

    it('a draft posted as it stands reads as a whole listing: short title, one-line description, no blank left in it', () => {
        for (const { category, position, offer } of ALL) {
            const at = `${category}.${position + 1}`;
            expect(offer.title.length, `${at} title`).toBeGreaterThan(3);
            expect(offer.title.length, `${at} title`).toBeLessThanOrEqual(26);
            expect(offer.description.length, `${at} description`).toBeLessThanOrEqual(100);
            expect(offer.description, `${at} description`).toMatch(/[.]$/);
            expect(offer.title, `${at} title`).toMatch(/^[A-Z]/);
            for (const text of [offer.title, offer.description]) {
                expect(text, `${at}: "${text}"`).not.toMatch(/…|\.\.\.|___|[[\]{}<>]|\n/);
            }
        }
    });

    it("no draft uses the glossary's terms, a currency mark or a word Marty took out (a translation never has to guess one)", () => {
        const names = /\b(Beans?|Offers?|Needs?)\b/;
        const terms = /\b(communit(y|ies)|members?|events?|groups?|shops?|invites?|listings?|deals?|resilience|survival)\b/i;
        for (const { category, position, offer } of ALL) {
            for (const text of [offer.title, offer.description]) {
                const at = `${category}.${position + 1}: "${text}"`;
                expect(text, at).not.toMatch(names);
                expect(text, at).not.toMatch(terms);
                expect(text, at).not.toMatch(/Ʀ|[$€£¥]|\d/);
            }
        }
    });

    it("a draft that is not lent has a price type a node keeps: one fee, Free or by the hour (per day or per week is only a loan's)", () => {
        const wrong: string[] = [];
        for (const { category, position, offer } of ALL) {
            const at = `${category}.${position + 1} ${offer.title}`;
            if (offer.lendable) {
                const posted = offer.priceType === 'free' ? 'fixed' : offer.priceType;
                if (!isLendablePriceType(posted)) wrong.push(`${at}: a loan can be one fee, per day or per week, not ${posted}`);
            } else if (!KEPT_WHEN_NOT_LENT.includes(offer.priceType)) {
                wrong.push(`${at}: opens as ${offer.priceType}, but a node stores an Offer that is not lent as one fee or by the hour`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it("a draft is priced the way the pricing guide prices it: the figure, the price type and the words say the same thing", () => {
        const guided = CATEGORY_IDS.filter((c) => DEFAULT_PRICING_CATALOG.some((i) => i.category === c));
        const wrong: string[] = [];
        for (const { category, position, offer } of ALL) {
            const at = `${category}.${position + 1} ${offer.title}`;
            if (offer.priceType === 'free') {
                // Free is a fixed price of nothing: there is no figure to look up.
                expect(offer.guide, at).toBeUndefined();
                continue;
            }
            if (!offer.guide) {
                // A paid draft with no figure only where the guide has no item in that category at all.
                expect(guided, `${at} has no guide words, but the guide has items in ${category}`).not.toContain(category);
                continue;
            }
            const item = pricingItemFor(DEFAULT_PRICING_CATALOG, category, offer.guide);
            expect(item, `${at}: the guide finds nothing for "${offer.guide}"`).not.toBeNull();
            expect(item!.priceBeans, at).toBeGreaterThan(0);
            const unit = item!.unit ?? '';
            // This reads the guide item's own unit, not `pricingHintFor`'s price type: that turns a unit it has no type for
            // ("night") into one price, and a test against it would agree with the mistake it is here to catch.
            expect(unit === 'hr' || unit in SPAN_WORDS || ONE_PRICE_UNITS.includes(unit),
                `${at}: the guide prices it per "${unit}": say here what that means to a member`).toBe(true);
            if (unit === 'hr') {
                if (offer.priceType !== 'hourly') wrong.push(`${at}: the guide's ${item!.priceBeans} is per hour, and the draft opens as ${offer.priceType}`);
            } else if (offer.priceType !== 'fixed') {
                wrong.push(`${at}: the guide's ${item!.priceBeans} is per ${unit}, and the draft opens as ${offer.priceType}, not one fee`);
            } else if (unit in SPAN_WORDS && !SPAN_WORDS[unit].test(`${offer.title} ${offer.description}`)) {
                wrong.push(`${at}: ${item!.priceBeans} is the price of one ${unit}, and as a Total the draft's own words must say it is for one ${unit}: "${offer.description}"`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it("the eight drafts that were priced per day are a Total for one day or one night, and their words say so", () => {
        const stay = (id: string) => {
            const [category, position] = id.split('.');
            const offer = STARTER_OFFERS[category as PricingCategory][Number(position) - 1];
            return { offer, item: pricingItemFor(DEFAULT_PRICING_CATALOG, category, offer.guide!)! };
        };
        for (const id of WERE_PER_DAY) {
            const { offer, item } = stay(id);
            expect(offer.priceType as string, `${id} ${offer.title}: ${item.priceBeans} a ${item.unit} opens as ${offer.priceType}`).toBe('fixed');
            expect(offer.guide, id).toBeTruthy();
        }
        // The stays and the camping spot name the one night the figure is for, in their own description.
        for (const id of ['labour.3', 'housing.2', 'animals.2']) {
            const { offer, item } = stay(id);
            expect(item.unit, id).toBe('night');
            expect(offer.description, id).toMatch(/\bfor a night\b/);
        }
        // The hires and the bench name the one day.
        for (const id of ['housing.3', 'tools.2', 'tools.3', 'transport.2', 'general.1']) {
            const { offer, item } = stay(id);
            expect(item.unit, id).toBe('day');
            expect(offer.description, id).toMatch(/\bfor the day\b/);
        }
        // The two that really are one night by their own title (a guest room for a night, a movie night kit) were always a Total.
        for (const id of ['housing.1', 'general.3']) {
            const { offer, item } = stay(id);
            expect(item.unit, id).toBe('night');
            expect(offer.priceType, id).toBe('fixed');
        }
    });

    it('only a free draft can be lent (a loan is one fee, and a Free loan is one fee of nothing)', () => {
        const lendable = ALL.filter((a) => a.offer.lendable);
        expect(lendable.map((a) => `${a.category}.${a.position + 1}`)).toEqual(['tools.1', 'mindset.2']);
        for (const { offer } of lendable) expect(offer.priceType).toBe('free');
    });
});

describe('starter drafts: which three a member is shown (design §3.1)', () => {
    it('with nothing starred, or nothing the node knows: labour, tools and the garden, their first drafts', () => {
        const fallback = ['labour.1', 'tools.1', 'garden.1'];
        for (const none of [[], null, undefined, ['nope'], ['food_produce'], [1, null, {}], 'food' as unknown as string[]]) {
            expect(ids(starterOffersFor(none as readonly unknown[])), JSON.stringify(none)).toEqual(fallback);
        }
        expect(STARTER_FALLBACK_CATEGORIES).toEqual(['labour', 'tools', 'garden']);
        const [hour, lend, extra] = starterOffersFor([]);
        expect([hour.title, lend.title, extra.title]).toEqual(['An hour of help', 'Lend a tool', 'Extra from the garden']);
        expect([hour.priceType, lend.priceType, extra.priceType]).toEqual(['hourly', 'free', 'fixed']);
        expect(lend.lendable).toBe(true);
    });

    it('one star: that category\'s three, in order, for each of the 17 categories', () => {
        for (const category of CATEGORY_IDS) {
            const drafts = starterOffersFor([category]);
            expect(ids(drafts), category).toEqual([`${category}.1`, `${category}.2`, `${category}.3`]);
            expect(drafts.map((d) => d.category), category).toEqual([category, category, category]);
            expect(drafts.map((d) => d.title), category).toEqual(STARTER_OFFERS[category].map((o) => o.title));
        }
    });

    it('two stars: the first of each, then the second of the star they gave first', () => {
        expect(ids(starterOffersFor(['animals', 'transport']))).toEqual(['animals.1', 'transport.1', 'animals.2']);
        expect(ids(starterOffersFor(['transport', 'animals']))).toEqual(['transport.1', 'animals.1', 'transport.2']);
    });

    it('three stars: each one\'s first draft, in the order they starred; more than three: the first three stars only', () => {
        expect(ids(starterOffersFor(['food', 'tech', 'arts']))).toEqual(['food.1', 'tech.1', 'arts.1']);
        expect(ids(starterOffersFor(['arts', 'tech', 'food']))).toEqual(['arts.1', 'tech.1', 'food.1']);
        expect(ids(starterOffersFor(['food', 'tech', 'arts', 'energy', 'care']))).toEqual(['food.1', 'tech.1', 'arts.1']);
        expect(ids(starterOffersFor([...CATEGORY_IDS]))).toEqual(['food.1', 'services.1', 'labour.1']);
    });

    it('a repeat, an unknown id and a non-string are dropped, and what is left keeps the order it first appeared in', () => {
        expect(ids(starterOffersFor(['nope', 'tools', 'tools', 7, null, 'food']))).toEqual(['tools.1', 'food.1', 'tools.2']);
        // A listing's old category name is not a star: it must not turn into General's drafts.
        expect(ids(starterOffersFor(['tools_hardware', 'general']))).toEqual(['general.1', 'general.2', 'general.3']);
    });

    it('always three for anyone who starred something, whatever they starred', () => {
        for (const a of CATEGORY_IDS) {
            expect(starterOffersFor([a]), a).toHaveLength(STARTER_OFFER_COUNT);
            for (const b of CATEGORY_IDS) {
                const drafts = starterOffersFor([a, b]);
                expect(drafts, `${a},${b}`).toHaveLength(STARTER_OFFER_COUNT);
                expect(new Set(ids(drafts)).size, `${a},${b}`).toBe(STARTER_OFFER_COUNT);
            }
        }
    });

    it('is pure: the same stars give the same drafts, a frozen list is fine, and a draft handed out is a copy', () => {
        const stars = Object.freeze(['health', 'mindset']);
        const first = starterOffersFor(stars);
        expect(starterOffersFor(stars)).toEqual(first);
        expect(stars).toEqual(['health', 'mindset']);
        first[0].title = 'changed' as StarterDraft['title'];
        first[0].priceType = 'free';
        expect(starterOffersFor(stars)[0].title).toBe(STARTER_OFFERS.health[0].title);
        expect(starterOffersFor(stars)[0].priceType).toBe('hourly');
        expect(starterOffersFor(stars)[0].id).toBe('health.1');
    });
});
