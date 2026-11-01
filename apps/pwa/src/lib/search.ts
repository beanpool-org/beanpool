/**
 * The Market's search on the web: core's `searchTermsFor`, the words the phone's Market and Home's saved-search card ask
 * with, so a search finds the same listings everywhere: synonyms ("fruit" finds "lemon"), stems, and words parted at any
 * punctuation, Chinese and full-width included ("鸡蛋，牛奶" finds 牛奶 mid-run, #1781).
 */

import { foldApostrophes, freeTagsOf, HOME_SEARCH_MAX_CHARS, searchFromMarket, searchTermsFor, postTagsOf, searchTagsFor, type HomeSearchSettings } from '@beanpool/core';

/**
 * Whether a listing's title, description or a tag its author typed holds one of the search's terms; an empty search matches
 * everything. The apostrophes are folded on both sides, so "don't" finds "Don’t miss", typed on iOS (#1828 check, finding 1).
 */
export function matchesExpandedSearch(searchQuery: string, title: string, description: string, tags?: unknown, freeTags?: unknown): boolean {
    if (!searchQuery.trim()) return true;
    const searchText = foldApostrophes(`${title} ${description} ${freeTagsOf(freeTags).join(' ')}`.toLowerCase());
    if (searchTermsFor(searchQuery).some(term => searchText.includes(foldApostrophes(term)))) return true;
    const resolved = searchTagsFor(searchQuery);
    if (resolved.length > 0) {
        const postTags = postTagsOf(tags);
        if (resolved.some(r => postTags.some(t => t === r || t.startsWith(`${r}.`)))) return true;
    }
    return false;
}

/**
 * The words the Market's search asks the node for (`q=`): core's `searchTermsFor`, as the phone's Market and Home's card
 * ask, so the node finds a synonym ("sofa" finds "Old couch"), since a listing's keywords hold only its category.
 */
export function marketSearchQuery(search: string): string {
    return searchTermsFor(search).join(' ');
}

/**
 * The rows a search's list is drawn from: the node's answer, in its order, then whatever else the page holds that the words
 * match. That is what the node can't answer for: peers' listings, and what was pushed or read after it answered. So a search
 * finds at least what the filter over the feed found before the node was asked. A peer's copy can share an id with one of
 * this node's, and stays.
 */
export function searchRows<T extends { id: string; title: string; description: string; tags?: unknown; freeTags?: unknown }>(answer: T[], feed: T[], search: string): T[] {
    const answered = new Set(answer.map(p => p.id));
    return [...answer, ...feed.filter(p => ((p as { _remoteNode?: string })._remoteNode || !answered.has(p.id)) && matchesExpandedSearch(search, p.title, p.description, p.tags, p.freeTags))];
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
    state: { type: string; category: string; radiusKm: number | null | undefined }, search: string, tag?: string | null,
): HomeSearchSettings | null {
    if (state.type === 'event' || state.type === 'poll') return null;
    const tags = tag ? [tag] : undefined;
    return searchFromMarket({
        q: search,
        kind: state.type === 'offer' ? 'offer' : state.type === 'need' ? 'need' : 'any',
        category: state.category === 'all' ? null : state.category,
        radiusKm: state.radiusKm,
        tags,
    });
}
