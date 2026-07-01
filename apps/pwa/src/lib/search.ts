/**
 * Synonym-Expanded Search — Matches posts using a marketplace synonym map.
 *
 * When a user searches for "lemon", this also matches posts containing
 * "fruit", "citrus", "produce" etc., improving marketplace discovery.
 */

import synonymMap from './synonyms.json';

const SYNONYMS: Record<string, string[]> = synonymMap as any;
delete (SYNONYMS as any)._meta;

/**
 * Expand a search query into additional terms using the synonym map.
 * Returns a Set of all terms to match against (original + expansions).
 */
export function expandSearchTerms(query: string): Set<string> {
    const q = query.toLowerCase().trim();
    const terms = new Set<string>();
    if (!q) return terms;
    terms.add(q);

    // Check if the full query matches a synonym key
    if (SYNONYMS[q]) {
        for (const syn of SYNONYMS[q]) terms.add(syn.toLowerCase());
    }

    // Also check individual words
    const words = q.split(/\s+/);
    for (const word of words) {
        terms.add(word);
        if (SYNONYMS[word]) {
            for (const syn of SYNONYMS[word]) terms.add(syn.toLowerCase());
        }
    }

    // Reverse lookup: if the query is a synonym value, find its keys
    for (const [key, values] of Object.entries(SYNONYMS)) {
        if (values.some(v => v.toLowerCase() === q)) {
            terms.add(key.toLowerCase());
        }
    }

    return terms;
}

/**
 * Check if a post matches the expanded search terms.
 * Searches title and description against all expanded terms.
 */
export function matchesExpandedSearch(searchQuery: string, title: string, description: string): boolean {
    if (!searchQuery.trim()) return true;

    const expandedTerms = expandSearchTerms(searchQuery);
    const searchText = `${title} ${description}`.toLowerCase();

    for (const term of expandedTerms) {
        if (searchText.includes(term)) return true;
    }

    return false;
}
