import { afterEach, describe, expect, it } from 'vitest';
import { HOME_FRAME_LIMITS, addCard, readSearchSettings, type HomeLayoutV2 } from '../home-frame.js';
import {
    SAVE_SEARCH_BUTTON, SAVE_SEARCH_NOT_NOW, sameSearch, saveSearchLabel, saveSearchLine, saveSearchState, searchFromMarket, searchFromSheet, searchKmFor,
} from '../home-save-search.js';
import { TAG_LIBRARY } from '../tags/index.js';
import { CONTEXT_SEPARATOR, setLanguage } from '../words.js';

const AT = '2026-10-14T10:00:00.000Z';
const layout = (cards: HomeLayoutV2['cards']): HomeLayoutV2 => ({ v: 2, cards, dismissed: {}, updatedAt: AT });
const search = (id: string, settings: Record<string, unknown>) => ({ id, type: 'search', settings });

describe('a saved search stores the tags it resolved at save time (DESIGN-owner-seeding-tags-fable.md §4.7)', () => {
    afterEach(() => { setLanguage('en', []); });

    it('typed words resolve in the member\'s language: "limón" keeps the lemon tag, so the card finds the English listing', () => {
        expect(searchFromMarket({ q: 'lemon' })?.tags).toEqual(['food.fruit.lemon']);
        expect(searchFromMarket({ q: 'limón' })?.tags).toBeUndefined();
        setLanguage('es', [{ [`Lemon${CONTEXT_SEPARATOR}tag`]: 'Limón' }]);
        expect(searchFromMarket({ q: 'limón' })?.tags).toEqual(['food.fruit.lemon']);
    });

    it('a chip the member tapped comes first and is never cut; each id once, at most five', () => {
        expect(searchFromMarket({ q: 'lemon', tags: ['food.fruit.orange'] })?.tags).toEqual(['food.fruit.orange', 'food.fruit.lemon']);
        expect(searchFromMarket({ q: 'lemon', tags: ['food.fruit.lemon'] })?.tags).toEqual(['food.fruit.lemon']);
        expect(searchFromMarket({ q: 'citrus', tags: ['food.eggs'] })?.tags).toEqual(['food.eggs', 'food.fruit.lemon', 'food.fruit.lime', 'food.fruit.orange', 'food.fruit.mandarin']);
    });

    it('the words cut to a card\'s 40 characters are the ones resolved', () => {
        expect(searchFromMarket({ q: `${'q'.repeat(50)} lemon` })?.tags).toBeUndefined();
    });

    it('five of the longest ids, with the longest words, fit a card\'s settings', () => {
        const longest = TAG_LIBRARY.map(tag => tag.id).sort((a, b) => b.length - a.length).slice(0, 5);
        const settings = readSearchSettings({ q: '語'.repeat(40), kind: 'offer', category: 'food', km: 25, tags: longest });
        expect(settings.tags).toHaveLength(5);
        expect(new TextEncoder().encode(JSON.stringify(settings)).length).toBeLessThanOrEqual(HOME_FRAME_LIMITS.settingsBytes);
    });
});

describe('a saved search through its settings sheet (both apps\' sheets call this)', () => {
    const lemon = { q: 'lemon', kind: 'offer', km: 5, tags: ['food.fruit.orange', 'food.fruit.lemon'] };

    it('the words as they were: its tags stay, whatever else changed', () => {
        expect(searchFromSheet(lemon, { q: 'lemon', kind: 'need', category: 'food', km: null })).toEqual({ q: 'lemon', kind: 'need', category: 'food', tags: ['food.fruit.orange', 'food.fruit.lemon'] });
        expect(searchFromSheet(lemon, { q: ' LEMON ', kind: 'offer', km: 5 })?.tags).toEqual(['food.fruit.orange', 'food.fruit.lemon']);
    });

    it('new words resolve again: the old words\' ids go, and a chip\'s stays, the sheet not showing it to take off', () => {
        expect(searchFromSheet(lemon, { q: 'jam', kind: 'offer', km: 5 }).tags).toEqual(['food.fruit.orange', 'food.preserves.jam']);
        expect(searchFromSheet({ q: 'lemon', tags: ['food.fruit.lemon'] }, { q: 'xyzzy', kind: 'any' })).toEqual({ q: 'xyzzy', kind: 'any' });
    });

    it('a new card, opened with nothing, resolves its words', () => {
        expect(searchFromSheet(undefined, { q: 'lemon', kind: 'any' })).toEqual({ q: 'lemon', kind: 'any', tags: ['food.fruit.lemon'] });
    });

    it('a card saved before it held tags gets them the next time its sheet saves', () => {
        expect(searchFromSheet({ q: 'lemon', kind: 'any' }, { q: 'lemon', kind: 'any' }).tags).toEqual(['food.fruit.lemon']);
    });

    it('an empty category and no distance are none, as the sheets hold them', () => {
        expect(searchFromSheet({}, { q: 'xyzzy', kind: 'any', category: '', km: null })).toEqual({ q: 'xyzzy', kind: 'any' });
    });
});

describe('Save to Home: the Market\'s search as a saved search', () => {
    it('takes the words, Offers or Needs, the category and the distance', () => {
        expect(searchFromMarket({ q: 'eggs', kind: 'offer', category: 'food', radiusKm: 5 })).toEqual({ q: 'eggs', kind: 'offer', category: 'food', km: 5, tags: ['food.eggs'] });
        expect(searchFromMarket({ q: 'help moving', kind: 'need' })).toEqual({
            q: 'help moving', kind: 'need', tags: ['tech.repair.it-support', 'general.sharing.volunteer', 'transport.delivery.moving'],
        });
    });

    it('words that name no tag save none', () => {
        expect(searchFromMarket({ q: 'xyzzy plugh', kind: 'need' })).toEqual({ q: 'xyzzy plugh', kind: 'need' });
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
        expect(SAVE_SEARCH_NOT_NOW).toMatch(/Try again from the Market/);
    });
});
