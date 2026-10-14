import { describe, expect, it } from 'vitest';
import { HOME_FRAME_LIMITS, addCard, type HomeLayoutV2 } from '../home-frame.js';
import {
    SAVE_SEARCH_BUTTON, sameSearch, saveSearchLabel, saveSearchLine, saveSearchState, searchFromMarket, searchKmFor,
} from '../home-save-search.js';

const AT = '2026-10-14T10:00:00.000Z';
const layout = (cards: HomeLayoutV2['cards']): HomeLayoutV2 => ({ v: 2, cards, dismissed: {}, updatedAt: AT });
const search = (id: string, settings: Record<string, unknown>) => ({ id, type: 'search', settings });

describe('Save to Home: the Market\'s search as a saved search', () => {
    it('takes the words, Offers or Needs, the category and the distance', () => {
        expect(searchFromMarket({ q: 'eggs', kind: 'offer', category: 'food', radiusKm: 5 })).toEqual({ q: 'eggs', kind: 'offer', category: 'food', km: 5 });
        expect(searchFromMarket({ q: 'help moving', kind: 'need' })).toEqual({ q: 'help moving', kind: 'need' });
    });

    it('is nothing without words: a saved search is a search', () => {
        expect(searchFromMarket({ q: '' })).toBeNull();
        expect(searchFromMarket({ q: '   \n ' })).toBeNull();
    });

    it('reads the words as the card does: spaces folded, cut to 40 characters', () => {
        expect(searchFromMarket({ q: '  fresh   eggs \n' })?.q).toBe('fresh eggs');
        expect(searchFromMarket({ q: `eggs ${'q'.repeat(60)}` })?.q).toHaveLength(40);
    });

    it('reads All, For You or anything else as both kinds, and drops a category it does not know (all, polls)', () => {
        expect(searchFromMarket({ q: 'eggs', kind: null })?.kind).toBe('any');
        expect(searchFromMarket({ q: 'eggs', kind: 'poll' as never })?.kind).toBe('any');
        expect(searchFromMarket({ q: 'eggs', category: 'all' })?.category).toBeUndefined();
        expect(searchFromMarket({ q: 'eggs', category: 'not-a-category' })?.category).toBeUndefined();
    });

    it('keeps a distance the card has, else the smallest that holds the Market\'s, never a smaller one', () => {
        expect([1, 2, 5, 10, 25].map(searchKmFor)).toEqual([1, 2, 5, 10, 25]);
        expect(searchKmFor(0.5)).toBe(1);
        expect(searchKmFor(3)).toBe(5);
        expect(searchKmFor(15)).toBe(25);
        expect(searchKmFor(50)).toBeUndefined();
        for (const none of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(searchKmFor(none)).toBeUndefined();
    });
});

describe('Save to Home: the same search, and room on Home', () => {
    it('is the same search with the same words (case and spaces aside), kind, category and distance', () => {
        expect(sameSearch({ q: 'Eggs ', kind: 'any', km: 5 }, { q: 'eggs', kind: 'any', km: 5 })).toBe(true);
        expect(sameSearch({ q: 'eggs', kind: 'any' }, { q: 'eggs', kind: 'offer' })).toBe(false);
        expect(sameSearch({ q: 'eggs', kind: 'any', km: 5 }, { q: 'eggs', kind: 'any' })).toBe(false);
        expect(sameSearch({ q: 'eggs', kind: 'any', category: 'food' }, { q: 'eggs', kind: 'any' })).toBe(false);
    });

    it('adds a new search to a newcomer\'s Home, or beside other searches', () => {
        expect(saveSearchState(null, { q: 'eggs', kind: 'any' })).toBe('add');
        expect(saveSearchState(layout([search('search-aaaa', { q: 'honey', kind: 'any' })]), { q: 'eggs', kind: 'any' })).toBe('add');
    });

    it('says when the same search is on Home already, so no second copy is made', () => {
        const home = layout([{ id: 'steps', type: 'steps' }, search('search-aaaa', { q: 'eggs', kind: 'offer', km: 5 })]);
        expect(saveSearchState(home, { q: 'EGGS', kind: 'offer', km: 5 })).toBe('on-home');
        expect(saveSearchState(home, { q: 'eggs', kind: 'offer', km: 10 })).toBe('add');
    });

    it('says when five searches are there: the sixth is never a silent no', () => {
        const five = layout(['a', 'b', 'c', 'd', 'e'].map((k, i) => search(`search-${k}aaa`, { q: `w${i}`, kind: 'any' })));
        expect(saveSearchState(five, { q: 'eggs', kind: 'any' })).toBe('type-full');
        // core's addCard refuses the same, so Home and the frame agree.
        expect(addCard(five, 'search', { settings: { q: 'eggs', kind: 'any' } })).toEqual({ ok: false, refused: 'type-full' });
    });

    it('says when Home holds 24 cards', () => {
        const full = layout(Array.from({ length: HOME_FRAME_LIMITS.cards }, (_, i) => ({ id: `zzz-${i}`, type: 'zzz-future' })));
        expect(saveSearchState(full, { q: 'eggs', kind: 'any' })).toBe('home-full');
        expect(addCard(full, 'search', { settings: { q: 'eggs', kind: 'any' } })).toEqual({ ok: false, refused: 'home-full' });
    });
});

describe('Save to Home: the words', () => {
    it('names the search for a screen reader, and says each refusal plainly, never as locked', () => {
        expect(SAVE_SEARCH_BUTTON).toBe('Save this search to Home');
        expect(saveSearchLabel(' eggs ')).toBe('Save the search "eggs" to Home');
        expect(saveSearchLine('add', 'eggs')).toBeNull();
        expect(saveSearchLine('on-home', 'eggs')).toBe('"eggs" is on your Home already.');
        expect(saveSearchLine('type-full', 'eggs')).toBe('Home holds 5 saved searches. Remove one, then save "eggs" again.');
        expect(saveSearchLine('home-full', 'eggs')).toBe('Home holds 24 cards. Remove one, then save "eggs" again.');
        for (const s of ['on-home', 'type-full', 'home-full'] as const) expect(saveSearchLine(s, 'eggs')).not.toMatch(/lock|unlock|upgrade/i);
    });
});
