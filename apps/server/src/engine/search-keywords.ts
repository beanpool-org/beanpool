// A listing's search words on this node (posts.search_keywords, which posts_fts indexes beside its title and description).
//
// One door for every writer: a create and an edit (engine/posts.ts), the boot's backfills (state-engine.ts), a linked
// community's listings as they are cached (federation-listings.ts). Each folds the synonym map's words and the listing's
// tags (DESIGN-owner-seeding-tags-fable.md §4.6). Until slice T2 the create and edit paths called the engine's builder
// without the map, so a listing made on the node held its category alone, and only a boot's backfill of empty rows ever
// added synonyms.

import { SYNONYM_MAP } from '@beanpool/core';
import { generateSearchKeywords } from '@beanpool/engine';

// The map from @beanpool/core, generated from the tag library (scripts/tags/to-synonyms.mjs).
const synonymMap: Record<string, string[]> = { ...SYNONYM_MAP };
delete (synonymMap as Record<string, unknown>)._meta;

/** The words a listing is also found by: its category, its words' synonyms, its tags' words. */
export function postSearchKeywords(title: string, description: string, category: string, tags: readonly string[] = []): string {
    return generateSearchKeywords(title, description, category, synonymMap, tags);
}
