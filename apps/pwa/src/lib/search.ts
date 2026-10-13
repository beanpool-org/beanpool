/**
 * The Market's search on the web: core's `searchTermsFor`, the words the phone's Market and Home's saved-search card ask
 * with, so a search finds the same listings everywhere: synonyms ("fruit" finds "lemon"), stems, and words parted at any
 * punctuation, Chinese and full-width included ("鸡蛋，牛奶" finds 牛奶 mid-run, #1781).
 */

import { HOME_SEARCH_MAX_CHARS, searchTermsFor } from '@beanpool/core';

/** Whether a listing's title or description holds one of the search's terms; an empty search matches everything. */
export function matchesExpandedSearch(searchQuery: string, title: string, description: string): boolean {
    if (!searchQuery.trim()) return true;
    const searchText = `${title} ${description}`.toLowerCase();
    return searchTermsFor(searchQuery).some(term => searchText.includes(term));
}

/**
 * The words a saved search's "See more" on Home fills the Market's search with: trimmed, at most a saved search's 40
 * characters; null for none, and the search stays as it was.
 */
export function marketSearchFromLink(value: string | null | undefined): string | null {
    const v = value?.trim().slice(0, HOME_SEARCH_MAX_CHARS).trim();
    return v ? v : null;
}
