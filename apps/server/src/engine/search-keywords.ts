// A listing's search words on this node (posts.search_keywords, which posts_fts indexes beside its title and description).
//
// Two writers, as before tags, each now folding the listing's tags (DESIGN-owner-seeding-tags-fable.md §4.6, slice T2) and
// the tags its author typed (DESIGN-tags-free-entry-fable.md §4, slice F1):
// - a create and an edit (engine/posts.ts), and a linked community's listing as it is cached (federation-listings.ts):
//   the category and the tags' words (postSearchKeywords). These never passed the synonym map: an untagged listing's
//   words are its category alone, exactly as before T2.
// - the boot's backfill of a listing with no words (state-engine.ts backfillSearchKeywords) and the once-only pass
//   (keywordsWithTagsOnce): the synonyms of its words too (postSearchKeywordsWithSynonyms).
// Whether a listing made on the node should get its words' synonyms is an open question for the project (the slice T2
// PR): with them, the apps' expansion of a search ("organic" asks "worm farm", which the node reads as "worm" or "farm")
// finds more listings it should not, as test-search-unspaced-scripts shows.

import { SYNONYM_MAP } from '@beanpool/core';
import { generateSearchKeywords } from '@beanpool/engine';

// The map from @beanpool/core, generated from the tag library (scripts/tags/to-synonyms.mjs).
const synonymMap: Record<string, string[]> = { ...SYNONYM_MAP };
delete (synonymMap as Record<string, unknown>)._meta;

/** The words a listing made or edited here is also found by: its category and its tags' words. */
export function postSearchKeywords(title: string, description: string, category: string, tags: readonly string[] = [], freeTags: readonly string[] = []): string {
    return generateSearchKeywords(title, description, category, undefined, tags, freeTags);
}

/** The same, with its own words' synonyms too: what the boot's backfill writes. */
export function postSearchKeywordsWithSynonyms(title: string, description: string, category: string, tags: readonly string[] = [], freeTags: readonly string[] = []): string {
    return generateSearchKeywords(title, description, category, synonymMap, tags, freeTags);
}
