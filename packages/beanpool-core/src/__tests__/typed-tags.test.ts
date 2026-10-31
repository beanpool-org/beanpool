/**
 * What the one Tags field makes of what a member types (tags/typed-tags.ts, DESIGN-tags-free-entry-fable.md §3, slice F2): the
 * rule both apps' pickers read. Enter, a comma, Done and the Add row commit through this, so one suite pins them for both.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../words.js';
import { buildTagIndex, tagIndex } from '../tags/index.js';
import {
    FREE_TAGS_MAX, FREE_TAGS_TOO_LONG_TOGETHER, FREE_TAGS_TOO_MANY, FREE_TAG_HOLDS_A_COMMA, FREE_TAG_NOT_A_CONTACT, FREE_TAG_TOO_LONG,
    FREE_TAG_TOO_MANY_WORDS, FREE_TAG_TOO_SHORT, freeTagsOf, listingFreeTags,
} from '../tags/free-tags.js';
import { POST_TAGS_MAX, editedTagsOver } from '../tags/post-tags.js';
import { TAG_COMMA, enterTypedTags, exactLibraryTag, lastTagOff, typedTag } from '../tags/typed-tags.js';

const coreEs = JSON.parse(readFileSync(new URL('../../words/es.json', import.meta.url), 'utf8'));
const LEMON = 'food.fruit.lemon';
const none = { tags: [], freeTags: [] };

afterEach(() => setLanguage('en'));

describe('a word that is a library label picks the library tag, never a free twin', () => {
    it('by the label, its case and its #', () => {
        for (const text of ['Lemon', 'lemon', 'LEMON', '#lemon', '  lemon  ']) expect(typedTag(text, none), text).toEqual({ kind: 'library', id: LEMON });
    });

    it('by a plural, as a search resolves one', () => {
        expect(typedTag('lemons', none)).toEqual({ kind: 'library', id: LEMON });
    });

    it("by the label in the member's language, with or without its accent, and by the English on the same device", () => {
        setLanguage('es', [coreEs]);
        for (const text of ['limón', 'Limón', 'limon', 'lemon']) expect(typedTag(text, none), text).toEqual({ kind: 'library', id: LEMON });
    });

    it('never a top: the category is its own field, so its name is the member\'s own word', () => {
        expect(exactLibraryTag('food')).toBeNull();
        expect(typedTag('food', none)).toEqual({ kind: 'free', tag: 'food' });
    });

    it('a word the library knows only as a synonym or an alias stays the member\'s, and is still offered in the results', () => {
        expect(exactLibraryTag('citrus')).toBeNull();
        expect(typedTag('citrus', none)).toEqual({ kind: 'free', tag: 'citrus' });
        expect(tagIndex().search('citrus').length).toBeGreaterThan(0);
    });

    it('a word in a third language is the member\'s own (the device holds its language and English)', () => {
        setLanguage('es', [coreEs]);
        expect(typedTag('limão', none)).toEqual({ kind: 'free', tag: 'limão' });
    });

    it('the index it reads may be another language\'s', () => {
        const index = buildTagIndex();
        expect(exactLibraryTag('lemon', index)).toBe(LEMON);
    });
});

describe('anything else that passes the rule is the member\'s own tag, as it is stored', () => {
    it('lower-cased, accents kept, one space, the # not stored', () => {
        expect(typedTag('#2nd   Hand', none)).toEqual({ kind: 'free', tag: '2nd hand' });
        expect(typedTag('##Último Modelo', none)).toEqual({ kind: 'free', tag: 'último modelo' });
    });

    it('nothing to commit is nothing: an empty field, spaces, a lone #', () => {
        for (const text of ['', '   ', '#', '# ']) expect(typedTag(text, none), JSON.stringify(text)).toBeNull();
    });

    it('a tag the listing already holds is not a second one', () => {
        expect(enterTypedTags('Vintage', { tags: [], freeTags: ['vintage'] }, true)).toEqual({ tags: [], freeTags: ['vintage'], rest: '', refused: null });
        expect(enterTypedTags('lemon', { tags: [LEMON], freeTags: [] }, true).tags).toEqual([LEMON]);
    });
});

describe('what no listing may carry is said in words, before anything is sent', () => {
    it.each([
        ['a', FREE_TAG_TOO_SHORT],
        ['x'.repeat(31), FREE_TAG_TOO_LONG],
        ['one two three four five', FREE_TAG_TOO_MANY_WORDS],
        ['me@example.org', FREE_TAG_NOT_A_CONTACT],
        ['0412 345 678', FREE_TAG_NOT_A_CONTACT],
        ['example.com', FREE_TAG_NOT_A_CONTACT],
    ])('%s', (text, why) => {
        expect(typedTag(text, none)).toEqual({ kind: 'refused', why });
    });

    it('the cap, on each kind, in words', () => {
        const five = ['aa', 'bb', 'cc', 'dd', 'ee'];
        expect(FREE_TAGS_MAX).toBe(5);
        expect(typedTag('ff', { tags: [], freeTags: five })).toEqual({ kind: 'refused', why: FREE_TAGS_TOO_MANY });
        const library = ['food.fruit.apple', 'food.fruit.orange', 'food.produce.herbs', 'food.preserve.jam', 'food.bakery.bread'];
        expect(POST_TAGS_MAX).toBe(5);
        expect(typedTag('lemon', { tags: library, freeTags: [] })).toEqual({ kind: 'refused', why: FREE_TAGS_TOO_MANY });
        // A tag already on the list needs no room.
        expect(typedTag('aa', { tags: [], freeTags: five })).toEqual({ kind: 'free', tag: 'aa' });
        // Five of one kind leave the other kind's five.
        expect(typedTag('lemon', { tags: [], freeTags: five })).toEqual({ kind: 'library', id: LEMON });
        expect(typedTag('ff', { tags: library, freeTags: [] })).toEqual({ kind: 'free', tag: 'ff' });
    });

    it('five that store too long together', () => {
        const held = { tags: [], freeTags: ['"'.repeat(30), '"'.repeat(29) + 'a', '"'.repeat(28) + 'ab', '"'.repeat(27) + 'abc'] };
        expect(typedTag(`${'"'.repeat(26)}abcd`, held)).toEqual({ kind: 'refused', why: FREE_TAGS_TOO_LONG_TOGETHER });
    });
});

describe('a comma commits, Enter and Done end the last piece', () => {
    it('a comma commits what is before it; what follows is still being typed', () => {
        expect(enterTypedTags('used,', none, false)).toEqual({ tags: [], freeTags: ['used'], rest: '', refused: null });
        expect(enterTypedTags('used, 2n', none, false)).toEqual({ tags: [], freeTags: ['used'], rest: ' 2n', refused: null });
    });

    it('Enter and Done take the last piece too', () => {
        expect(enterTypedTags('used, 2nd hand', none, true)).toEqual({ tags: [], freeTags: ['used', '2nd hand'], rest: '', refused: null });
    });

    it('each piece on its own: a pasted list with a library word in it', () => {
        expect(enterTypedTags('lemons, 2nd hand, Vintage', none, true)).toEqual({ tags: [LEMON], freeTags: ['2nd hand', 'vintage'], rest: '', refused: null });
    });

    it('the comma of each keyboard, none held in a tag', () => {
        for (const comma of [',', '،', '、', '，']) {
            expect(TAG_COMMA.test(comma), comma).toBe(true);
            expect(enterTypedTags(`aa${comma}bb`, none, true).freeTags, comma).toEqual(['aa', 'bb']);
        }
    });

    it('a refused piece stops there: those before it are in, and it stays in the field with its words', () => {
        expect(enterTypedTags('used, me@example.org, vintage', none, true)).toEqual({
            tags: [], freeTags: ['used'], rest: 'me@example.org, vintage', refused: { kind: 'refused', why: FREE_TAG_NOT_A_CONTACT },
        });
    });

    it('a refused piece reads the same as more is typed, so the field does not shift under the member', () => {
        const first = enterTypedTags('me@example.org, ab', none, false);
        expect(first.rest).toBe('me@example.org, ab');
        expect(enterTypedTags(first.rest, none, false).rest).toBe(first.rest);
    });

    it('no comma ever reaches a tag, so its chip can always be filtered on', () => {
        expect(enterTypedTags('a,b', none, true).freeTags.join('')).not.toContain(',');
        expect(FREE_TAG_HOLDS_A_COMMA).toBeTruthy();
    });

    it('an empty field commits nothing and refuses nothing', () => {
        expect(enterTypedTags('', { tags: [LEMON], freeTags: ['aa'] }, true)).toEqual({ tags: [LEMON], freeTags: ['aa'], rest: '', refused: null });
    });
});

describe('backspace on an empty field', () => {
    it('takes the last chip off: the member\'s own come after the library\'s', () => {
        expect(lastTagOff({ tags: [LEMON], freeTags: ['aa', 'bb'] })).toEqual({ tags: [LEMON], freeTags: ['aa'] });
        expect(lastTagOff({ tags: [LEMON], freeTags: [] })).toEqual({ tags: [], freeTags: [] });
        expect(lastTagOff(none)).toEqual({ tags: [], freeTags: [] });
    });
});

describe('an open edit form when the tags a member typed move under it', () => {
    it('a reload brings them; what the member took off stays off and what they put on stays on', () => {
        expect(editedTagsOver([], [], ['aa', 'bb'], FREE_TAGS_MAX)).toEqual(['aa', 'bb']);
        expect(editedTagsOver([], ['cc'], ['aa', 'bb'], FREE_TAGS_MAX)).toEqual(['aa', 'bb', 'cc']);
        expect(editedTagsOver(['aa'], [], ['aa', 'bb'], FREE_TAGS_MAX)).toEqual(['bb']);
    });
});

describe("a listing's typed tags, however it reached the app", () => {
    it('the node answers a list, a phone\'s row holds the column', () => {
        expect(freeTagsOf(['aa', 7, 'bb'])).toEqual(['aa', 'bb']);
        expect(listingFreeTags({ freeTags: ['aa'] })).toEqual(['aa']);
        expect(listingFreeTags({ free_tags: '["2nd hand"]' })).toEqual(['2nd hand']);
        expect(listingFreeTags({ free_tags: '' })).toEqual([]);
        expect(listingFreeTags(null)).toEqual([]);
        expect(listingFreeTags(undefined)).toEqual([]);
    });
});
