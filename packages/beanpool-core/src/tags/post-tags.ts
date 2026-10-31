/**
 * A listing's tags as the node stores them (DESIGN-owner-seeding-tags-fable.md §4.5, slice T2): `posts.tags`, the ids
 * space-separated, at most POST_TAGS_MAX of them in POST_TAGS_CHARS characters. One rule for the node's door (engine
 * post-fields.ts), its copies (a standby's import, a peer's listings) and, from slice T3, the apps' pickers.
 */
import { TAG_ID_PATTERN, isTagId } from './index.js';

/** The most tags one listing carries: a picker of five chips, and a short column every filter reads with LIKE. */
export const POST_TAGS_MAX = 5;
/** The longest the stored ids may be together, spaces included. Five ids of three levels fit with room to spare. */
export const POST_TAGS_CHARS = 200;

/** The ids a stored `posts.tags` holds, in its order; [] for none. */
export function postTagsOf(stored: unknown): string[] {
    if (Array.isArray(stored)) return stored.filter((t): t is string => typeof t === 'string' && Boolean(t));
    if (typeof stored === 'string' && stored.trim()) return stored.trim().split(/\s+/).filter(Boolean);
    return [];
}

/** The column's value for these ids: space-separated, '' for none. */
export function storedPostTags(ids: readonly string[]): string {
    return ids.join(' ');
}

/**
 * An open edit form's tags once the listing's own move under it, from `from` (what the form opened with) to `now` (what a
 * reload read): `now`, less what the member took off, plus what they put on, at most POST_TAGS_MAX. A phone's copy from
 * before the tags column opens the form with none and reads the real ones a moment later: they stay, since an edit takes
 * off only what the member took off (DESIGN-owner-seeding-tags-fable.md §4.4, §4.7).
 */
export function editedTagsOver(from: readonly string[], edited: readonly string[], now: readonly string[]): string[] {
    const put = edited.filter((id) => !from.includes(id));
    const stay = now.filter((id) => !from.includes(id) || edited.includes(id));
    return [...new Set([...stay, ...put])].slice(0, POST_TAGS_MAX);
}

/**
 * The tags a copy says a listing carries (a main server's row on a standby, a peer's listing), as this node keeps them:
 * each a well-formed id once, in its order, at most POST_TAGS_MAX in POST_TAGS_CHARS. An id this library does not know
 * stays, since the copy may come from a node with a newer library: an app shows a tag it cannot label as nothing (§4.3).
 * Anything that is not a list of ids is no tags.
 */
export function copiedPostTags(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const id of raw) {
        if (typeof id !== 'string' || !TAG_ID_PATTERN.test(id) || out.includes(id)) continue;
        if (out.length >= POST_TAGS_MAX || storedPostTags([...out, id]).length > POST_TAGS_CHARS) break;
        out.push(id);
    }
    return out;
}

/** The most tag ids one search asks for: a word or two of the member's resolved through the label index ("citrus" alone is
 *  five tags). Each costs two LIKEs a listing. */
export const SEARCH_TAGS_MAX = 20;

/**
 * The ids a search asks for (the Market's `tags=`, a saved-search card's setting): those this library knows, each once,
 * at most SEARCH_TAGS_MAX. An id from a newer app's library matches nothing here and is left out, never refused, so the
 * search still finds by its words.
 */
export function knownSearchTags(raw: readonly unknown[]): string[] {
    const out: string[] = [];
    for (const id of raw) {
        if (typeof id === 'string' && isTagId(id) && !out.includes(id)) out.push(id);
        if (out.length >= SEARCH_TAGS_MAX) break;
    }
    return out;
}
