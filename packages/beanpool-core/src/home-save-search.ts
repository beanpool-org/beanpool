/**
 * "Save to Home" on the Market (Marty, 7 Oct, the Home widgets list): the search a member is looking at in the Market
 * (its words, Offers or Needs, a category, a distance) becomes a saved search on their Home, the `search` card of the
 * card frame (home-frame.ts, CARD-FRAME §4). Both apps' Markets hand their search to Home through
 * {@link searchFromMarket}; Home asks {@link saveSearchState} before it opens the saved search's sheet, so a member is
 * told plainly when the search is there already or Home has no room, never shown a success that didn't happen.
 *
 * Pure: no I/O, no Node built-ins.
 */

import {
    HOME_FRAME_LIMITS, HOME_SEARCH_KMS, homeCardType, readSearchSettings,
    type HomeLayoutV2, type HomeSearchKind, type HomeSearchSettings,
} from './home-frame.js';
import { searchTagsFor } from './tags/index.js';
import { POST_TAGS_MAX } from './tags/post-tags.js';
import { t, tn, word } from './words.js';

/** The Market's search as each app holds it: the words typed, the Offers/Needs tab, a category chip, a distance. */
export interface MarketSearchNow {
    q: string;
    /** `offer` or `need` when the Market shows only that; anything else (All, For You) is both. */
    kind?: HomeSearchKind | null;
    /** The category chip's id, or none (`all`). */
    category?: string | null;
    /** The Market's distance filter in km, or none. */
    radiusKm?: number | null;
    /** Tag ids the member chose (a chip they tapped). The words' own are resolved here. */
    tags?: string[] | null;
}

/**
 * The saved search's distance for the Market's: the smallest of the card's distances (1, 2, 5, 10, 25 km) that holds
 * it, so the card never shows less than the Market did; none past 25 km or with no distance.
 */
export function searchKmFor(radiusKm: number | null | undefined): HomeSearchSettings['km'] | undefined {
    if (typeof radiusKm !== 'number' || !Number.isFinite(radiusKm) || radiusKm <= 0) return undefined;
    return HOME_SEARCH_KMS.find((km) => km >= radiusKm);
}

/** The ids a saved search's words resolve to in the member's language, at most a card's (DESIGN-owner-seeding-tags-fable.md §4.7). */
const wordsTags = (q: string): string[] => searchTagsFor(q, { limit: POST_TAGS_MAX });

/** A saved search's tags: the ones chosen first, so a chip is never cut, then what its words resolve to. */
const savedTags = (q: string, chosen: readonly string[]): string[] => [...new Set([...chosen, ...wordsTags(q)])].slice(0, POST_TAGS_MAX);

/**
 * The Market's search as a saved search's settings, read as the card reads them (`readSearchSettings`: the words cut
 * to 40 characters, an unknown category none), with the tag ids resolved now: the card then finds what the Market found
 * in any language, a Spanish member's "limón" the English lemon listing (§4.7). Null when there are no words: a saved
 * search is a search.
 */
export function searchFromMarket(m: MarketSearchNow): HomeSearchSettings | null {
    const q = typeof m.q === 'string' ? m.q.split(/\s+/).filter(Boolean).join(' ') : '';
    const s = readSearchSettings({ q, kind: m.kind, category: m.category ?? undefined, km: searchKmFor(m.radiusKm) });
    return s.q ? readSearchSettings({ ...s, tags: savedTags(s.q, Array.isArray(m.tags) ? m.tags : []) }) : null;
}

/** The words as two searches are compared: case and spaces aside. */
const wordsKey = (q: string): string => q.split(/\s+/).filter(Boolean).join(' ').toLocaleLowerCase();

/** What a saved search's settings sheet leaves on Home's two apps. Its tags aren't among its fields. */
export interface SearchSheetFields {
    q: string;
    kind: HomeSearchKind;
    category?: string | null;
    km?: number | null;
}

/**
 * A saved search as its settings sheet (AddCardDialog, CardSettingsSheet) leaves it, `before` being what it opened with
 * (nothing, for a new one). Its tags stay when its words do. New words resolve again, and the ids the old words gave go
 * with them; an id they never gave (a chip tapped in the Market) stays, since the sheet doesn't show it to take off.
 */
export function searchFromSheet(before: unknown, fields: SearchSheetFields): HomeSearchSettings {
    const was = readSearchSettings(before);
    const held = was.tags ?? [];
    const old = wordsKey(was.q) === wordsKey(fields.q) ? [] : wordsTags(was.q);
    return readSearchSettings({ ...fields, tags: savedTags(fields.q, held.filter((id) => !old.includes(id))) });
}

/** Whether two saved searches are the same search: the same words (case and spaces aside), kind, category and distance. */
export function sameSearch(a: unknown, b: unknown): boolean {
    const x = readSearchSettings(a);
    const y = readSearchSettings(b);
    return wordsKey(x.q) === wordsKey(y.q) && x.kind === y.kind && (x.category ?? null) === (y.category ?? null) && (x.km ?? null) === (y.km ?? null);
}

/** What saving a search to Home would do: add it, or why it can't (the same search there, five there, Home full). */
export type SaveSearchState = 'add' | 'on-home' | 'type-full' | 'home-full';

/** What saving this search would do to this Home (a null layout is a newcomer's, which has room). */
export function saveSearchState(layout: Pick<HomeLayoutV2, 'cards'> | null, settings: unknown): SaveSearchState {
    const cards = layout?.cards ?? [];
    const searches = cards.filter((c) => c.type === 'search');
    if (searches.some((c) => sameSearch(c.settings, settings))) return 'on-home';
    if (searches.length >= (homeCardType('search')?.multiple?.max ?? 5)) return 'type-full';
    if (cards.length >= HOME_FRAME_LIMITS.cards) return 'home-full';
    return 'add';
}

/** The Market's button (a word() key, shown through t()), and its screen-reader name with the words in it. */
export const SAVE_SEARCH_BUTTON = word('Save this search to Home');
export const saveSearchLabel = (q: string): string => t('Save the search "{q}" to Home', { q: q.trim() });

/**
 * Home's line when it can't keep a search yet: the community hasn't answered (offline with nothing kept, a server older
 * than Home), so there is no list of the member's to add it to. Nothing is lost: the Market still has the search.
 */
export const SAVE_SEARCH_NOT_NOW = word("Home can't keep this search until your community answers. Try again from the Market in a moment.");

/** Home's plain line when the search can't be added, said where the member lands. Null for `add`. */
export function saveSearchLine(state: SaveSearchState, q: string): string | null {
    const words = q.trim();
    switch (state) {
        case 'on-home': return t('"{words}" is on your Home already.', { words });
        case 'type-full': return tn(homeCardType('search')?.multiple?.max ?? 5,
            'Home holds {n} saved search. Remove it, then save "{words}" again.', 'Home holds {n} saved searches. Remove one, then save "{words}" again.', { words });
        case 'home-full': return tn(HOME_FRAME_LIMITS.cards,
            'Home holds {n} card. Remove it, then save "{words}" again.', 'Home holds {n} cards. Remove one, then save "{words}" again.', { words });
        default: return null;
    }
}
