/**
 * This community's typed tags in the Tags field (tags/community-tags.ts, DESIGN-tags-free-entry-fable.md §3 and §5, slice
 * F3): what both apps' pickers make of GET /api/free-tags, and what a word an owner merged into a library tag commits as.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TAG_LIBRARY, buildTagIndex, exactTagForms, tagIndex } from '../tags/index.js';
import { COMMUNITY_TAGS_SHOWN, communityTagsFor, communityTagsOf, didYouMeanTag, libraryTagOf, mergedInto } from '../tags/community-tags.js';
import { enterTypedTags, exactLibraryTag, typedTag } from '../tags/typed-tags.js';
import { FREE_TAGS_MAX, freeTagStored } from '../tags/free-tags.js';
import { compoundWords } from '../search-terms.js';
import { wordsFor, type Catalog } from '../words.js';

const LEMON = 'food.fruit.lemon';
const none = { tags: [], freeTags: [] };

describe("the node's answer, held to the rule", () => {
    it('keeps each tag in its stored form, once, in the order sent, with its count', () => {
        expect(communityTagsOf({ tags: [{ tag: '#2nd Hand', listings: 3 }, { tag: '2nd hand', listings: 1 }, { tag: 'vintage', listings: 2 }] }))
            .toEqual([{ tag: '2nd hand', listings: 3 }, { tag: 'vintage', listings: 2 }]);
    });

    it('leaves out what no listing may carry and keeps the rest', () => {
        const list = communityTagsOf({ tags: [{ tag: 'call 0412 345 678', listings: 9 }, { tag: 'x', listings: 9 }, 7, null, { tag: 5 }, { tag: 'retro', listings: 2 }] });
        expect(list).toEqual([{ tag: 'retro', listings: 2 }]);
    });

    it('anything but a list is none', () => {
        for (const answer of [null, undefined, 'tags', { tags: 'x' }, []]) expect(communityTagsOf(answer)).toEqual([]);
    });

    it('a count that is no whole number above nothing reads as 0', () => {
        expect(communityTagsOf({ tags: [{ tag: 'retro', listings: -1 }, { tag: 'vintage', listings: 1.5 }] }).map((c) => c.listings)).toEqual([0, 0]);
    });

    it('a merge only into a library item this app knows: an unknown id or a top is no merge', () => {
        expect(communityTagsOf({ tags: [{ tag: 'limones', listings: 2, mergeInto: LEMON }] })).toEqual([{ tag: 'limones', listings: 2, mergeInto: LEMON }]);
        expect(communityTagsOf({ tags: [{ tag: 'limones', listings: 2, mergeInto: 'food.fruit.not-a-tag' }] })).toEqual([{ tag: 'limones', listings: 2 }]);
        expect(communityTagsOf({ tags: [{ tag: 'limones', listings: 2, mergeInto: 'food' }] })).toEqual([{ tag: 'limones', listings: 2 }]);
    });
});

describe('what the typing reaches', () => {
    const tags = communityTagsOf({ tags: [
        { tag: '2nd hand', listings: 12 }, { tag: 'handmade', listings: 4 }, { tag: 'hanger', listings: 3 }, { tag: 'retro', listings: 2 },
    ] });

    it('a prefix of the tag or of one of its words, most used first', () => {
        expect(communityTagsFor('han', tags, none).map((c) => c.tag)).toEqual(['2nd hand', 'handmade', 'hanger']);
        expect(communityTagsFor('#Ret', tags, none).map((c) => c.tag)).toEqual(['retro']);
    });

    it('nothing from fewer than two characters', () => {
        expect(communityTagsFor('h', tags, none)).toEqual([]);
        expect(communityTagsFor('#', tags, none)).toEqual([]);
    });

    it('not one the listing holds', () => {
        expect(communityTagsFor('han', tags, { tags: [], freeTags: ['handmade'] }).map((c) => c.tag)).toEqual(['2nd hand', 'hanger']);
    });

    it(`at most ${COMMUNITY_TAGS_SHOWN}, or the limit asked`, () => {
        const many = communityTagsOf({ tags: Array.from({ length: 9 }, (_, i) => ({ tag: `tag${i}`, listings: 9 - i })) });
        expect(communityTagsFor('tag', many, none)).toHaveLength(COMMUNITY_TAGS_SHOWN);
        expect(communityTagsFor('tag', many, none, { limit: 2 })).toHaveLength(2);
    });

    it('never shadows the library: a tag with a library label\'s letters is left to the library rows', () => {
        const withLabel = communityTagsOf({ tags: [{ tag: 'lemon', listings: 5 }, { tag: 'lemon curd', listings: 2 }] });
        const shadowed = (tag: string) => exactLibraryTag(tag) !== null;
        expect(communityTagsFor('lem', withLabel, none, { shadowed }).map((c) => c.tag)).toEqual(['lemon curd']);
    });

    it('a merged tag is offered unless its library tag is already held', () => {
        const merged = communityTagsOf({ tags: [{ tag: 'limones', listings: 2, mergeInto: LEMON }] });
        expect(communityTagsFor('lim', merged, none).map((c) => c.tag)).toEqual(['limones']);
        expect(communityTagsFor('lim', merged, { tags: [LEMON], freeTags: [] })).toEqual([]);
    });
});

describe('a word an owner merged into a library tag commits as that tag', () => {
    const merged = mergedInto(communityTagsOf({ tags: [{ tag: 'limones', listings: 2, mergeInto: LEMON }, { tag: 'retro', listings: 2 }] }), tagIndex());

    it('Enter, a comma or Done on it stores the library id, never a free twin', () => {
        for (const text of ['limones', '#Limones', '  LIMONES ']) expect(typedTag(text, none, tagIndex(), merged), text).toEqual({ kind: 'library', id: LEMON });
        expect(enterTypedTags('limones, retro', none, true, tagIndex(), merged)).toEqual({ tags: [LEMON], freeTags: ['retro'], rest: '', refused: null });
    });

    it('a word not merged stays the member\'s own, and without the merges the same word is free', () => {
        expect(typedTag('retro', none, tagIndex(), merged)).toEqual({ kind: 'free', tag: 'retro' });
        expect(typedTag('limones', none)).toEqual({ kind: 'free', tag: 'limones' });
    });

    it('the library tag counts against the library\'s five', () => {
        const full = { tags: ['food.fruit.lime', 'food.fruit.orange', 'food.eggs', 'food.fruit', 'food.vegetables'], freeTags: [] };
        expect(typedTag('limones', full, tagIndex(), merged)?.kind).toBe('refused');
        expect(typedTag('retro', { tags: [], freeTags: Array.from({ length: FREE_TAGS_MAX }, (_, i) => `tag${i}`) }, tagIndex(), merged)?.kind).toBe('refused');
    });

    it('a merge into an id this app cannot label is no merge', () => {
        const unknown = mergedInto([{ tag: 'limones', listings: 2, mergeInto: 'food.fruit.not-a-tag' }], tagIndex());
        expect(unknown('limones')).toBeNull();
    });
});

describe('"Did you mean …?": the library tag a word names in another language (slice F5)', () => {
    it("reads the node's library and lang: a library item with its language; never a top, an unknown id, no language, garbage", () => {
        expect(libraryTagOf({ library: 'food.fruit.orange', lang: 'pt' })).toEqual({ id: 'food.fruit.orange', lang: 'pt' });
        expect(libraryTagOf({ library: 'food.fruit.orange', lang: 'zh-Hant' })).toEqual({ id: 'food.fruit.orange', lang: 'zh-Hant' });
        for (const answer of [
            { library: 'food', lang: 'pt' }, { library: 'food.fruit.not-a-tag', lang: 'pt' }, { library: null, lang: null },
            { library: 7, lang: 'pt' }, { library: 'food.fruit.orange' }, { library: 'food.fruit.orange', lang: null },
            { library: 'food.fruit.orange', lang: '<b>pt</b>' }, { library: 'food.fruit.orange', lang: 'Português' },
            {}, null, 'x', { tags: [] },
        ]) {
            expect(libraryTagOf(answer), JSON.stringify(answer)).toBeNull();
        }
    });

    const none = { tags: [] as string[], freeTags: [] as string[] };
    const orange = { id: 'food.fruit.orange', lang: 'pt' };
    it('offers the tag for exactly the word being added, when the listing does not hold it and no library row shows at all', () => {
        const found = { tag: 'laranja', found: orange };
        expect(didYouMeanTag('laranja', found, none, [])).toEqual(orange);
        expect(didYouMeanTag('laranja', found, none, ['food.fruit.orange']), 'already a library row').toBeNull();
        expect(didYouMeanTag('laranja', found, none, ['food.fruit.mandarin']), 'any library row: the member\'s own words reach it').toBeNull();
        expect(didYouMeanTag('laranja', found, { tags: ['food.fruit.orange'], freeTags: [] }, []), 'held').toBeNull();
        expect(didYouMeanTag('laranj', found, none, []), 'an answer for another word').toBeNull();
        expect(didYouMeanTag(null, found, none, []), 'nothing to add').toBeNull();
        expect(didYouMeanTag('laranja', { tag: 'laranja', found: null }, none, []), 'the node named none').toBeNull();
        expect(didYouMeanTag('laranja', null, none, []), 'not asked yet').toBeNull();
        expect(didYouMeanTag('laranja', { tag: 'laranja', found: { id: 'food.fruit.not-a-tag', lang: 'pt' } }, none, []),
            'an id this app cannot label').toBeNull();
    });

    it("on an English index a word the member's own search reaches gets no row (pan, cat, man); one it reaches nowhere does (mist)", () => {
        const en = tagIndex();
        const bread = { id: 'food.bakery.bread', lang: 'es' };
        for (const typed of ['pan', 'cat', 'man']) {
            const shown = en.search(typed, 12);
            expect(shown.length, `${typed}: the English index lists rows`).toBeGreaterThan(0);
            expect(didYouMeanTag(typed, { tag: typed, found: bread }, none, shown), typed).toBeNull();
        }
        const manure = { id: 'garden.soil.manure', lang: 'de' };
        expect(en.search('mist', 12)).toEqual([]);
        expect(didYouMeanTag('mist', { tag: 'mist', found: manure }, none, en.search('mist', 12))).toEqual(manure);
    });

    it('Enter still adds the word as the member\'s own: a label in a third language is a suggestion, never a swap', () => {
        expect(typedTag('laranja', none, tagIndex())).toEqual({ kind: 'free', tag: 'laranja' });
    });
});

describe("exactTagForms: how the node keys every language's labels, marks kept (slice F5)", () => {
    it("keeps every mark and letter, lower case and NFC, with the index's word split and compound join", () => {
        expect(exactTagForms('Maçã')).toEqual(['maçã']);
        expect(exactTagForms('Cát')).toEqual(['cát']);
        expect(exactTagForms('Mận')).toEqual(['mận']);
        expect(exactTagForms('Œufs')).toEqual(['œufs']);
        expect(exactTagForms('Limão-siciliano')).toEqual(['limão siciliano', 'limãosiciliano']);
        expect(exactTagForms('Wi-Fi')).toEqual(['wi fi', 'wifi']);
    });

    it('reads a word typed decomposed (NFD) as the same key', () => {
        const nfd = 'Limão'.normalize('NFD');
        expect(nfd).not.toBe('Limão');
        expect(exactTagForms(nfd)).toEqual(['limão']);
        expect(exactTagForms('Limão-siciliano'.normalize('NFD'))).toEqual(['limão siciliano', 'limãosiciliano']);
    });

    it("never folds one language's word into another's: cat is no Cát, maca no maçã, man no Mận", () => {
        expect(exactTagForms('cat')).not.toEqual(exactTagForms('Cát'));
        expect(exactTagForms('maca')).not.toEqual(exactTagForms('maçã'));
        expect(exactTagForms('man')).not.toEqual(exactTagForms('Mận'));
    });
});

// Turkish writes I as the capital of ı and İ as the capital of i; every other language writes I as the capital of i. The
// apps ask the node with the stored form (freeTagStored, the default lower case), so "BALIK" (balık) arrives as "balik" and
// "İncir" as "i" with a combining dot. Case never mattering means i, ı and İ are one letter in the node's key.
describe("exactTagForms: case never matters in Turkish either (i, ı, İ, I), and no mark is folded", () => {
    const trCatalog = JSON.parse(readFileSync(new URL('../../words/tr.json', import.meta.url), 'utf8')) as Catalog;
    const tr = wordsFor('tr', [trCatalog]);
    const items = TAG_LIBRARY.filter((tag) => tag.id.includes('.'));
    const label = (id: string) => tr.t(items.find((tag) => tag.id === id)!.en);
    // What the node looks a typed word up by (apps/server engine/free-tags.ts libraryTagNamed): the stored form the apps
    // send, its words with each compound whole, read by exactTagForms.
    const asked = (typed: string) => exactTagForms(compoundWords(freeTagStored(typed)).join(' '));
    const meets = (typed: string, written: string) => asked(typed).some((key) => exactTagForms(written).includes(key));
    // Every way a member may type a label: as written, lower and upper case by Turkish's rule and by the default rule.
    const typings = (written: string) => [
        written, written.toLocaleLowerCase('tr'), written.toLocaleUpperCase('tr'), written.toLowerCase(), written.toUpperCase(),
    ];

    it('the twelve Turkish tags the review of #3164 named are found typed lower case and with the capital', () => {
        const twelve: Array<[string, string, string]> = [
            ['food.fruit.fig', 'İncir', 'incir'],
            ['food.drinks', 'İçecekler', 'içecekler'],
            ['food.seafood.oysters', 'İstiridye', 'istiridye'],
            ['labour.garden-help.spraying', 'İlaçlama', 'ilaçlama'],
            ['services.trades.fabrication', 'İmalat', 'imalat'],
            ['services.business', 'İş ve ofis', 'iş ve ofis'],
            ['goods.materials', 'İnşaat malzemeleri', 'inşaat malzemeleri'],
            ['goods.materials.building-supplies', 'İnşaat gereçleri', 'inşaat gereçleri'],
            ['arts.art.illustration', 'İllüstrasyon', 'illüstrasyon'],
            ['health.first-aid', 'İlk yardım', 'ilk yardım'],
            ['animals.livestock.cows', 'İnekler', 'inekler'],
            ['food.vegetables.spinach', 'Ispanak', 'ıspanak'],
        ];
        for (const [id, written, lower] of twelve) {
            expect(label(id), id).toBe(written);
            for (const typed of [written, lower, written.toLocaleUpperCase('tr')]) expect(meets(typed, written), `${typed} → ${written}`).toBe(true);
        }
    });

    it('closes the class: every Turkish label with i, ı, İ or I anywhere is found typed every way', () => {
        const rows = items.map((tag) => [tag.id, tr.t(tag.en)] as const).filter(([, written]) => /[İIıi]/.test(written));
        expect(rows.length).toBeGreaterThan(300);
        expect(rows.filter(([, written]) => /[İI]/.test(written)).length).toBeGreaterThanOrEqual(13);
        expect(rows.filter(([, written]) => written.includes('ı')).length).toBeGreaterThan(100);
        const missed = rows.flatMap(([id, written]) => typings(written).filter((typed) => !meets(typed, written)).map((typed) => `${id}: ${typed}`));
        expect(missed).toEqual([]);
    });

    it("the device's own Turkish index (tagText) finds every one of them typed every way, as it did", () => {
        const index = buildTagIndex(tr);
        const rows = items.map((tag) => [tag.id, tr.t(tag.en)] as const).filter(([, written]) => /[İIıi]/.test(written));
        const missed = rows.flatMap(([id, written]) => typings(written).filter((typed) => !index.byLabel(typed).includes(id)).map((typed) => `${id}: ${typed}`));
        expect(missed).toEqual([]);
    });

    it('reads i, ı and İ as one letter, and keeps every other mark and letter', () => {
        expect(exactTagForms('İncir')).toEqual(['incir']);
        expect(exactTagForms('İNCİR')).toEqual(['incir']);
        expect(exactTagForms('Ispanak')).toEqual(exactTagForms('ıspanak'));
        expect(exactTagForms('BALIK')).toEqual(exactTagForms('balık'));
        expect(exactTagForms('Çarkıfelek meyvesi')).toEqual(['çarkifelek meyvesi']);
        expect(exactTagForms('İnşaat gereçleri')).toEqual(['inşaat gereçleri']);
        expect(exactTagForms('İllüstrasyon')).toEqual(['illüstrasyon']);
        expect(exactTagForms('Dağ')).toEqual(['dağ']);
        expect(exactTagForms('Maçã')).toEqual(['maçã']);
        expect(exactTagForms('Cát')).toEqual(['cát']);
        expect(exactTagForms('cat')).not.toEqual(exactTagForms('Cát'));
    });
});
