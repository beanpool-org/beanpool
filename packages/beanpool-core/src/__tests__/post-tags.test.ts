/**
 * A listing's tags as the node stores and copies them, and a saved search's tag ids (DESIGN-owner-seeding-tags-fable.md
 * §4.5, §4.7, slice T2): tags/post-tags.ts and readSearchSettings in home-frame.ts.
 */
import { describe, expect, it } from 'vitest';
import { POST_TAGS_MAX, SEARCH_TAGS_MAX, copiedPostTags, editedTagsOver, knownSearchTags, postTagsOf, storedPostTags } from '../tags/post-tags.js';
import { readSearchSettings } from '../home-frame.js';

describe('post tags', () => {
    it('round-trips the stored column', () => {
        expect(storedPostTags(['food.fruit.lemon', 'food.eggs'])).toBe('food.fruit.lemon food.eggs');
        expect(postTagsOf('food.fruit.lemon food.eggs')).toEqual(['food.fruit.lemon', 'food.eggs']);
        expect(postTagsOf('')).toEqual([]);
        expect(postTagsOf(null)).toEqual([]);
    });

    it('keeps a copy\'s well-formed ids, a newer library\'s included, once each, five at most', () => {
        const ids = copiedPostTags(['food.fruit.lemon', 'food.fruit.lemon', 'Not Valid', 7, 'food.fruit.from-a-newer-library',
            'food.fruit.lime', 'food.fruit.apple', 'food.fruit.pear', 'food.fruit.fig']);
        expect(ids).toEqual(['food.fruit.lemon', 'food.fruit.from-a-newer-library', 'food.fruit.lime', 'food.fruit.apple', 'food.fruit.pear']);
        expect(ids.length).toBe(POST_TAGS_MAX);
        expect(copiedPostTags('food.fruit.lemon')).toEqual([]);
        expect(copiedPostTags(undefined)).toEqual([]);
    });

    it('asks a search only for ids this library knows, at most SEARCH_TAGS_MAX', () => {
        expect(knownSearchTags(['food.fruit.lemon', 'food.fruit.not-a-tag', 'food.fruit.lemon', 'food'])).toEqual(['food.fruit.lemon', 'food']);
        expect(knownSearchTags(Array(50).fill('food')).length).toBe(1);
        expect(SEARCH_TAGS_MAX).toBeGreaterThanOrEqual(POST_TAGS_MAX);
    });
});

describe('a saved search\'s tags', () => {
    it('keeps known ids, drops unknown ones, at most five, and none when there are none', () => {
        expect(readSearchSettings({ q: 'limón', tags: ['food.fruit.lemon', 'food.fruit.nope', 3, 'food.fruit.lemon'] }))
            .toEqual({ q: 'limón', kind: 'any', tags: ['food.fruit.lemon'] });
        const six = ['food.fruit.lemon', 'food.fruit.lime', 'food.fruit.orange', 'food.fruit.apple', 'food.fruit.pear', 'food.fruit.fig'];
        expect(readSearchSettings({ q: 'x', tags: six }).tags).toEqual(six.slice(0, 5));
        expect(readSearchSettings({ q: 'eggs' })).toEqual({ q: 'eggs', kind: 'any' });
        expect(readSearchSettings({ q: 'eggs', tags: ['nope.nope'] })).toEqual({ q: 'eggs', kind: 'any' });
        expect(readSearchSettings({ q: 'eggs', tags: 'food.eggs' })).toEqual({ q: 'eggs', kind: 'any' });
    });

    it('five ids of three levels fit the 512-byte settings cap', () => {
        const s = readSearchSettings({ q: 'x'.repeat(40), kind: 'offer', category: 'food', km: 25,
            tags: ['food.fruit.passionfruit', 'food.fruit.grapefruit', 'food.fruit.watermelon', 'food.fruit.rockmelon', 'food.fruit.strawberry'] });
        expect(new TextEncoder().encode(JSON.stringify(s)).length).toBeLessThan(512);
    });
});

describe('editedTagsOver: an open edit form when the listing moves under it', () => {
    const A = 'food.fruit.lemon';
    const B = 'food.fruit.orange';
    const C = 'food.eggs';

    it('a form opened with none takes the real ones', () => {
        expect(editedTagsOver([], [], [A, B])).toEqual([A, B]);
    });
    it('what the member put on stays, after them', () => {
        expect(editedTagsOver([], [C], [A, B])).toEqual([A, B, C]);
    });
    it('what the member took off stays off', () => {
        expect(editedTagsOver([A], [], [A, B])).toEqual([B]);
    });
    it('a tag the node took off goes', () => {
        expect(editedTagsOver([A, B], [A, B], [B])).toEqual([B]);
    });
    it('each once, and never past the cap', () => {
        expect(editedTagsOver([], [A], [A, B])).toEqual([A, B]);
        const now = ['a.a', 'a.b', 'a.c', 'a.d', 'a.e'];
        expect(editedTagsOver([], ['a.f'], now)).toEqual(now);
        expect(POST_TAGS_MAX).toBe(now.length);
    });
});
