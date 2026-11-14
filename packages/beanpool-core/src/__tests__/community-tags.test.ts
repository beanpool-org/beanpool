/**
 * This community's typed tags in the Tags field (tags/community-tags.ts, DESIGN-tags-free-entry-fable.md §3 and §5, slice
 * F3): what both apps' pickers make of GET /api/free-tags, and what a word an owner merged into a library tag commits as.
 */
import { describe, expect, it } from 'vitest';
import { tagIndex } from '../tags/index.js';
import { COMMUNITY_TAGS_SHOWN, communityTagsFor, communityTagsOf, didYouMeanTag, libraryTagOf, mergedInto } from '../tags/community-tags.js';
import { enterTypedTags, exactLibraryTag, typedTag } from '../tags/typed-tags.js';
import { FREE_TAGS_MAX } from '../tags/free-tags.js';

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
    it("reads the node's library field: a library item, never a top, an unknown id or garbage", () => {
        expect(libraryTagOf({ library: 'food.fruit.orange' })).toBe('food.fruit.orange');
        for (const answer of [{ library: 'food' }, { library: 'food.fruit.not-a-tag' }, { library: null }, { library: 7 }, {}, null, 'x', { tags: [] }]) {
            expect(libraryTagOf(answer), JSON.stringify(answer)).toBeNull();
        }
    });

    const none = { tags: [] as string[], freeTags: [] as string[] };
    it('offers the tag for exactly the word being added, when the listing does not hold it and no library row shows it', () => {
        const found = { tag: 'laranja', id: 'food.fruit.orange' };
        expect(didYouMeanTag('laranja', found, none, [])).toBe('food.fruit.orange');
        expect(didYouMeanTag('laranja', found, none, ['food.fruit.orange']), 'already a library row').toBeNull();
        expect(didYouMeanTag('laranja', found, { tags: ['food.fruit.orange'], freeTags: [] }, []), 'held').toBeNull();
        expect(didYouMeanTag('laranj', found, none, []), 'an answer for another word').toBeNull();
        expect(didYouMeanTag(null, found, none, []), 'nothing to add').toBeNull();
        expect(didYouMeanTag('laranja', { tag: 'laranja', id: null }, none, []), 'the node named none').toBeNull();
        expect(didYouMeanTag('laranja', null, none, []), 'not asked yet').toBeNull();
        expect(didYouMeanTag('laranja', { tag: 'laranja', id: 'food.fruit.not-a-tag' }, none, []), 'an id this app cannot label').toBeNull();
    });

    it('Enter still adds the word as the member\'s own: a label in a third language is a suggestion, never a swap', () => {
        expect(typedTag('laranja', none, tagIndex())).toEqual({ kind: 'free', tag: 'laranja' });
    });
});
