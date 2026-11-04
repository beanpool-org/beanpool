import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING_CATALOG, PRICING_CATEGORIES, pricingItemFor, type PricingCategory } from '../pricing-catalog.js';
import {
    STARTER_FALLBACK_CATEGORIES, STARTER_OFFERS, STARTER_OFFER_COUNT, starterOffersFor, type StarterDraft, type StarterOffer,
} from '../starter-offers.js';

const CATEGORY_IDS = PRICING_CATEGORIES.map((c) => c.id);
/**
 * What a guide unit means to a member who reads the composer's price type beside the figure. The composer's types are
 * Total, / Hr, / Dy, / Wk and / Mo. A unit that is a span of time is priced per that span; a night has no type of its
 * own, so a draft that sells a stay of several nights opens at the day rate, and a draft that sells one night is a Total
 * and says so in its title (checked below). Any other unit counts things
 * (a loaf, a trip, a job, an event): one price, a Total. A unit not named here fails the test until someone says what it
 * means, so a new "per fortnight" can't slip through as a Total.
 */
const PER_SPAN: Record<string, 'hourly' | 'daily' | 'weekly' | 'monthly'> = { hr: 'hourly', day: 'daily', night: 'daily', week: 'weekly', month: 'monthly' };
const ONE_PRICE_UNITS = [
    'loaf', 'plate', 'jar', 'service', 'set', 'each', 'slab', 'punnet', 'trailer', 'tree', 'trip', 'session', 'class', 'seat',
    'bundle', 'walk', 'dozen', 'job', 'project', 'm³', 'bag', 'event',
];
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

    it("a draft is priced the way the pricing guide prices it: the figure and the price type the composer opens with say the same thing", () => {
        const guided = CATEGORY_IDS.filter((c) => DEFAULT_PRICING_CATALOG.some((i) => i.category === c));
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
            expect(Object.keys(PER_SPAN).includes(unit) || ONE_PRICE_UNITS.includes(unit),
                `${at}: the guide prices it per "${unit}": say here what that means to a member`).toBe(true);
            if (unit === 'night' && offer.priceType === 'fixed') {
                // A Total is honest for a night only where the draft sells that one night, and its own title says so.
                expect(offer.title, `${at}: ${item!.priceBeans} is the price of one night, but the composer opens it as a Total`).toMatch(/\bnight\b/i);
                continue;
            }
            const meant = PER_SPAN[unit] ?? 'fixed';
            expect(offer.priceType, `${at}: the guide's ${item!.priceBeans} is per ${unit}, so a member reads it as ${meant}, and the draft opens as ${offer.priceType}`).toBe(meant);
        }
    });

    it("the three drafts that sit or camp for a stay carry the guide's nightly figure as a day rate, never as a Total", () => {
        const rate = (id: string) => {
            const [category, position] = id.split('.');
            const offer = STARTER_OFFERS[category as PricingCategory][Number(position) - 1];
            const item = pricingItemFor(DEFAULT_PRICING_CATALOG, category, offer.guide!)!;
            return { offer, item };
        };
        for (const id of ['labour.3', 'housing.2', 'animals.2']) {
            const { offer, item } = rate(id);
            expect(item.unit, id).toBe('night');
            expect(offer.priceType, `${id} ${offer.title}: ${item.priceBeans} a night must not open as a Total`).toBe('daily');
        }
        // The two that really are one night (a guest room for a night, an outdoor movie night) stay a Total.
        for (const id of ['housing.1', 'general.3']) {
            const { offer, item } = rate(id);
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
        first[0].priceType = 'daily';
        expect(starterOffersFor(stars)[0].title).toBe(STARTER_OFFERS.health[0].title);
        expect(starterOffersFor(stars)[0].priceType).toBe('hourly');
        expect(starterOffersFor(stars)[0].id).toBe('health.1');
    });
});
