/**
 * The Market's search on the web: core's `searchTermsFor`, the words the phone's Market and Home's saved-search card ask
 * with, so a search finds the same listings everywhere: synonyms ("fruit" finds "lemon"), stems, and words parted at any
 * punctuation, Chinese and full-width included ("鸡蛋，牛奶" finds 牛奶 mid-run, #1781).
 */

import { foldApostrophes, HOME_SEARCH_MAX_CHARS, searchFromMarket, searchTermsFor, type HomeSearchSettings } from '@beanpool/core';

/**
 * Whether a listing's title or description holds one of the search's terms; an empty search matches everything. The
 * apostrophes are folded on both sides, so "don't" finds "Don’t miss", typed on iOS (#1828 check, finding 1).
 */
export function matchesExpandedSearch(searchQuery: string, title: string, description: string): boolean {
    if (!searchQuery.trim()) return true;
    const searchText = foldApostrophes(`${title} ${description}`.toLowerCase());
    return searchTermsFor(searchQuery).some(term => searchText.includes(foldApostrophes(term)));
}

/**
 * The words a saved search's "See more" on Home fills the Market's search with: trimmed, at most a saved search's 40
 * characters; null for none, and the search stays as it was.
 */
export function marketSearchFromLink(value: string | null | undefined): string | null {
    const v = value?.trim().slice(0, HOME_SEARCH_MAX_CHARS).trim();
    return v ? v : null;
}

/**
 * "Save this search to Home" (core home-save-search.ts): the Market's search as a saved search's settings, or null where
 * there is none to save: no words, or the Events or Polls tab (a saved search is Offers and Needs). Offers or Needs from
 * the tab (All and For You are both), the category chip, and the distance filter as the card's smallest distance that
 * holds it.
 */
export function marketSearchToSave(
    state: { type: string; category: string; radiusKm: number | null | undefined }, search: string,
): HomeSearchSettings | null {
    if (state.type === 'event' || state.type === 'poll') return null;
    return searchFromMarket({
        q: search,
        kind: state.type === 'offer' ? 'offer' : state.type === 'need' ? 'need' : 'any',
        category: state.category === 'all' ? null : state.category,
        radiusKm: state.radiusKm,
    });
}
