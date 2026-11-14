/**
 * This community's typed tags, as its node offers them to the Tags field (DESIGN-tags-free-entry-fable.md §3 and §5, slice
 * F3): GET /api/free-tags answers the tags members here have typed on live listings that passed the two-authors-or-a-week
 * rule, most used first, and the ones an owner or admin merged into a library tag. Both apps' pickers read them through
 * this file, so the phone and the web offer and commit the same thing. Per community: a peer's or global's tags are never
 * offered here, and offline the list is simply empty.
 */
import { freeTagRefusal, freeTagStored } from './free-tags.js';
import { isTagId, tagIndex, type TagIndex } from './index.js';
import type { TagsHeld } from './typed-tags.js';

/** The most of this community's tags the field shows under the library's matches. */
export const COMMUNITY_TAGS_SHOWN = 5;

/** One of this community's typed tags: as stored, on how many live listings, and the library tag an owner merged it into. */
export interface CommunityTag {
    tag: string;
    listings: number;
    mergeInto?: string;
}

/**
 * The tags a node's answer offers, held to the rule as a copy is: each in its stored form, once, in the node's order; a row
 * the rule refuses is left out and the rest stay. A merge into anything but a library item (an id this app's library does
 * not know, or a top: the category is its own field) is dropped, and the tag stays the member's own.
 */
export function communityTagsOf(answer: unknown): CommunityTag[] {
    const list = (answer as { tags?: unknown } | null | undefined)?.tags;
    if (!Array.isArray(list)) return [];
    const out: CommunityTag[] = [];
    const seen = new Set<string>();
    for (const row of list) {
        if (!row || typeof row !== 'object') continue;
        const { tag, listings, mergeInto } = row as Record<string, unknown>;
        if (typeof tag !== 'string' || freeTagRefusal(tag) !== null) continue;
        const stored = freeTagStored(tag);
        if (seen.has(stored)) continue;
        seen.add(stored);
        const count = typeof listings === 'number' && Number.isInteger(listings) && listings > 0 ? listings : 0;
        const into = typeof mergeInto === 'string' && mergeInto.includes('.') && isTagId(mergeInto) ? mergeInto : null;
        out.push(into ? { tag: stored, listings: count, mergeInto: into } : { tag: stored, listings: count });
    }
    return out;
}

/**
 * The community's tags what is typed reaches, for the rows under the library's: a tag that starts with it, or one of whose
 * words does ("hand" finds "2nd hand"), from two characters, in the node's order (most used first), at most `limit`. Not
 * one the listing already holds, and not one whose letters are a library label the library rows already offer: the
 * library is never shadowed.
 */
export function communityTagsFor(
    text: string, tags: readonly CommunityTag[], held: TagsHeld, options: { limit?: number; shadowed?: (tag: string) => boolean } = {},
): CommunityTag[] {
    const typed = freeTagStored(text);
    if (Array.from(typed).length < 2) return [];
    const out: CommunityTag[] = [];
    for (const c of tags) {
        if (out.length >= (options.limit ?? COMMUNITY_TAGS_SHOWN)) break;
        if (!c.tag.startsWith(typed) && !c.tag.split(' ').some((w) => w.startsWith(typed))) continue;
        if (c.mergeInto ? held.tags.includes(c.mergeInto) : held.freeTags.includes(c.tag)) continue;
        if (!c.mergeInto && options.shadowed?.(c.tag)) continue;
        out.push(c);
    }
    return out;
}

/**
 * What a committed typed tag becomes where an owner merged it: the library tag's id, or null for the member's own. Read by
 * typedTag, so Enter, a comma, Done and the "Add" row store the library id as a tap on the row does. A merge into an id
 * this app cannot label is no merge.
 */
export function mergedInto(tags: readonly CommunityTag[], index: TagIndex = tagIndex()): (text: string) => string | null {
    const merges = new Map<string, string>();
    for (const c of tags) if (c.mergeInto && index.label(c.mergeInto)) merges.set(c.tag, c.mergeInto);
    return (text) => merges.get(freeTagStored(text)) ?? null;
}
