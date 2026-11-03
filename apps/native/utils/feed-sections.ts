/**
 * The Market feed's section headings in list view. No React Native imports, so vitest can hold it.
 *
 * Listings, events and polls alike are headed by when they were LISTED: Today / Yesterday / This Week / Older Listings, in
 * local calendar days. The order and the headings are @beanpool/core's market-order (DESIGN-market-order-fable.md): newest
 * listed first, an event or poll listed again 24 hours before its moment, no author past two places in a day until the others
 * have had theirs. The headings Upcoming events, Polls and Nearest first are gone: an event comes back in the stream, once.
 * Its card already leads with its own date in the largest text, so the reader sees why it is there.
 *
 * Each heading is a word() key: the screen shows it through t(), in the member's language.
 */

import { word, daySections, marketOrder, type DaySectionId, type WordKey } from '@beanpool/core';

export interface FeedSection<T> {
    id: string;
    title: WordKey;
    posts: T[];
}

const TITLES: Record<DaySectionId, WordKey> = {
    today: word('Today'),
    yesterday: word('Yesterday'),
    thisweek: word('This Week'),
    older: word('Older Listings'),
};

function startOfLocalDay(ms: number): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Whole local calendar days between two instants: 0 for earlier today, 1 for any time yesterday. */
export function localDaysAgo(thenMs: number, nowMs: number): number {
    // Rounded, because a day with a daylight-saving change is 23 or 25 hours long.
    return Math.round((startOfLocalDay(nowMs) - startOfLocalDay(thenMs)) / (24 * 60 * 60 * 1000));
}

/** An already-ordered feed under its day headings (core daySections), empty ones left out; the order within is kept. */
export function sectionsOfOrdered<T extends Record<string, any>>(ordered: readonly T[], nowMs: number): FeedSection<T>[] {
    return daySections(ordered, nowMs).map(s => ({ id: `header-${s.id}`, title: TITLES[s.id], posts: s.posts }));
}

/** Split the (already filtered) feed into the Market's order and its day headings, empty ones left out. */
export function feedSections<T extends Record<string, any>>(posts: T[], nowMs: number = Date.now()): FeedSection<T>[] {
    return sectionsOfOrdered(marketOrder(posts, nowMs), nowMs);
}
