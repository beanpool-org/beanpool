/**
 * The tag library (DESIGN-owner-seeding-tags-fable.md §4, slice T1): its ids, its tops, every old synonym key on a tag,
 * synonyms.ts made from it, the label index in English and in a drafted language, and suggestTags on thirty listings.
 */
import { describe, expect, it } from 'vitest';
import { PRICING_CATEGORIES } from '../pricing-catalog.js';
import { searchTermsFor } from '../search-terms.js';
import { SYNONYM_MAP } from '../synonyms.js';
import { CONTEXT_SEPARATOR, wordsFor } from '../words.js';
import {
    TAG_ID_PATTERN, TAG_LIBRARY, TAG_TOPS, buildTagIndex, isTagId, tagById, tagChildren, tagEnglish, tagParent, tagSearchWords,
} from '../tags/index.js';
import { suggestTags } from '../tags/suggest.js';
import before from './fixtures/synonym-map-before-tags.json';
import { TITLES } from './fixtures/listing-titles.js';

describe('the tag library', () => {
    const ids = TAG_LIBRARY.map((t) => t.id);

    it('ids are well-formed (lowercase ASCII, at most three levels) and unique', () => {
        expect(ids.filter((id) => !TAG_ID_PATTERN.test(id))).toEqual([]);
        expect(ids.filter((id) => id.split('.').length > 3)).toEqual([]);
        expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    });

    it('every tag below a top hangs from a tag in the library', () => {
        expect(ids.filter((id) => tagParent(id) !== null && !isTagId(tagParent(id)!))).toEqual([]);
    });

    it('the tops are exactly the Market’s 17 categories, with the categories’ own labels', () => {
        expect(TAG_TOPS.map((t) => t.id).sort()).toEqual(PRICING_CATEGORIES.map((c) => c.id).sort());
        expect(TAG_TOPS).toHaveLength(17);
        for (const c of PRICING_CATEGORIES) expect(tagById(c.id)?.en).toBe(c.label);
    });

    it('holds about 600 tags at launch, never past the ceiling of 1,000', () => {
        expect(TAG_LIBRARY.length).toBeGreaterThanOrEqual(500);
        expect(TAG_LIBRARY.length).toBeLessThanOrEqual(1000);
    });

    it('every label below a top is a word() key with the context "tag", unique among its siblings', () => {
        for (const tag of TAG_LIBRARY) {
            if (!tag.id.includes('.')) continue;
            expect(tag.en.split(CONTEXT_SEPARATOR)[1], tag.id).toBe('tag');
        }
        for (const tag of TAG_LIBRARY) {
            const labels = tagChildren(tag.id).map((c) => tagEnglish(c).toLowerCase());
            expect(labels.filter((l, i) => labels.indexOf(l) !== i), tag.id).toEqual([]);
        }
    });

    it('its English words are plain: letters, digits and spaces', () => {
        for (const tag of TAG_LIBRARY) {
            for (const w of [...(tag.words ?? []), ...(tag.aliases ?? [])]) expect(w, tag.id).toMatch(/^[a-z0-9][a-z0-9 ]*$/i);
        }
    });

    it('every key of the old synonym map lands on exactly one tag', () => {
        const landed = TAG_LIBRARY.flatMap((t) => t.synonymKeys ?? []);
        expect([...landed].sort()).toEqual(Object.keys(before).sort());
    });

    it('synonyms.ts is what the library makes (scripts/tags/to-synonyms.mjs)', () => {
        const made: Record<string, string[]> = {};
        for (const tag of TAG_LIBRARY) {
            const parts = tag.id.split('.');
            const chain = parts.map((_, i) => tagById(parts.slice(0, i + 1).join('.')));
            const all = [...new Set([...chain.flatMap((t) => t?.words ?? []), ...(tag.aliases ?? [])])];
            for (const key of tag.synonymKeys ?? []) made[key] = all.filter((w) => w !== key);
        }
        expect(SYNONYM_MAP).toEqual(made);
    });

    it('a tag’s search words are its label, the words above it and its aliases', () => {
        expect(tagSearchWords('food.fruit.lemon').sort()).toEqual(['citrus', 'food', 'fruit', 'lemon', 'produce', 'tree']);
        expect(tagSearchWords('no.such.tag')).toEqual([]);
    });
});

describe('the label index', () => {
    it('round-trips English: every tag is found by its own label', () => {
        const index = buildTagIndex(wordsFor('en'));
        const lost = TAG_LIBRARY.filter((t) => !index.byName(tagEnglish(t)).includes(t.id)).map((t) => t.id);
        expect(lost).toEqual([]);
        for (const t of TAG_LIBRARY) expect(index.label(t.id)).toBe(tagEnglish(t));
    });

    it('finds by an old synonym word, in any case, and by a broader word', () => {
        const index = buildTagIndex(wordsFor('en'));
        expect(index.byName('Plumber')).toEqual(['services.trades.plumbing']);
        expect(index.byName('IT support')).toEqual(['tech.repair.it-support']);
        expect(index.byAlias('citrus')).toEqual(expect.arrayContaining(['food.fruit.lemon', 'food.fruit.lime', 'food.fruit.orange']));
        expect(index.byAlias('fruit')).toContain('food.fruit');
    });

    it('reads a compound as search does, parted and joined: "Wi-Fi" finds the label "Wifi"', () => {
        const index = buildTagIndex(wordsFor('en'));
        expect(searchTermsFor('wi-fi')).toContain('wifi');
        expect(index.byName('Wi-Fi')).toEqual(['tech.internet.wifi']);
        expect(index.byName('wi\u2011fi')).toEqual(['tech.internet.wifi']);
        expect(index.search('wi-fi')).toEqual(['tech.internet.wifi']);
        expect(index.byName('Off-grid power')).toEqual(['energy.solar.off-grid-power']);
        expect(index.byName('offgrid power')).toEqual(['energy.solar.off-grid-power']);
    });

    it('a drafted language: its labels find the tags, with or without accents, and English still does', () => {
        const es = wordsFor('es', [{
            _meta: { language: 'es', review: 'machine' },
            [`Lemon${CONTEXT_SEPARATOR}tag`]: 'Limón',
            [`Lime${CONTEXT_SEPARATOR}tag`]: 'Lima',
            [`Fruit${CONTEXT_SEPARATOR}tag`]: 'Fruta',
            [`Eggs${CONTEXT_SEPARATOR}tag`]: 'Huevos',
        }]);
        const index = buildTagIndex(es);
        expect(index.lang).toBe('es');
        expect(index.byName('limón')).toEqual(['food.fruit.lemon']);
        expect(index.byName('LIMON')).toEqual(['food.fruit.lemon']);
        expect(index.byName('lemon')).toEqual(['food.fruit.lemon']);
        expect(index.byName('huevos')).toEqual(['food.eggs']);
        expect(index.label('food.fruit.lemon')).toBe('Limón');
        expect(index.label('food.fruit.mango')).toBe('Mango');
        expect(index.search('lim')).toEqual(expect.arrayContaining(['food.fruit.lemon', 'food.fruit.lime']));
        expect(index.search('l')).toEqual([]);
        // Cyrillic and other scripts keep their letters.
        const ru = buildTagIndex(wordsFor('ru', [{ [`Eggs${CONTEXT_SEPARATOR}tag`]: 'Яйца' }]));
        expect(ru.byName('яйца')).toEqual(['food.eggs']);
    });

    it('the picker’s search finds a word inside a label, the member’s language first', () => {
        const index = buildTagIndex(wordsFor('en'));
        expect(index.search('beans', 20)).toEqual(expect.arrayContaining(['food.vegetables.green-beans', 'food.vegetables.broad-beans']));
    });
});

describe('suggestTags', () => {
    it('suggests sensible tags for thirty real-looking listings', () => {
        const index = buildTagIndex(wordsFor('en'));
        const out = Object.fromEntries(TITLES.map(([title, description, category]) => [title, suggestTags(title, description, { category, index })]));
        expect(out).toMatchSnapshot();
        for (const ids of Object.values(out)) for (const id of ids) expect(isTagId(id)).toBe(true);
        expect(Object.values(out).every((ids) => ids.length <= 5)).toBe(true);
    });

    it('names before parts, a hyphened word only whole, never a top', () => {
        const index = buildTagIndex(wordsFor('en'));
        expect(suggestTags('Sweet potato slips', '', { index })).toEqual(['food.vegetables.sweet-potato']);
        expect(suggestTags('Free-range eggs', '', { index })).toEqual(['food.eggs']);
        // Only a compound is kept whole: any other mark between two words parts them, as a space does.
        expect(suggestTags('Lemons/limes', '', { index })).toEqual(['food.fruit.lemon', 'food.fruit.lime']);
        expect(suggestTags('Lemons/limes', '', { index })).toEqual(suggestTags('Lemons limes', '', { index }));
        expect(suggestTags('Tomatoes,basil', '', { index })).toEqual(['food.vegetables.tomato', 'food.herbs.basil']);
        expect(suggestTags('Eggs&milk', '', { index })).toEqual(['food.dairy.milk', 'food.eggs']);
        // A compound is also looked up joined, as search looks it up.
        expect(suggestTags('Wi-Fi setup', '', { index })).toEqual(['tech.internet.wifi']);
        expect(suggestTags('Wi-Fi setup', '', { index })).toEqual(suggestTags('Wifi setup', '', { index }));
        expect(suggestTags('Food', '', { index })).toEqual([]);
        expect(suggestTags('', '', { index })).toEqual([]);
    });

    it('suggests from a drafted language’s labels', () => {
        const es = buildTagIndex(wordsFor('es', [{ [`Lemon${CONTEXT_SEPARATOR}tag`]: 'Limón' }]));
        expect(suggestTags('Limones del jardín', '', { index: es })).toEqual([]);
        expect(suggestTags('Limón fresco', '', { index: es })).toEqual(['food.fruit.lemon']);
    });
});
