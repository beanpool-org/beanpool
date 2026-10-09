/**
 * The Market's search words, expanded with the synonym map so the node's FTS5 (which ORs the terms) finds "lemon"
 * when a member asks for "fruit". One function for the phone's Market search and the node's saved-search card
 * (Home's `search` type), so the card finds what the Market finds for the same words.
 */
import { SYNONYM_MAP } from './synonyms.js';

// Build reverse synonym index: given a category/synonym, find all words that map to it
// e.g. "fruit" → ["lemon", "lime", "orange", "apple", ...]
const reverseSynonyms: Record<string, string[]> = {};
for (const [word, syns] of Object.entries(SYNONYM_MAP)) {
    if (word === '_meta') continue;
    for (const syn of syns) {
        if (!reverseSynonyms[syn]) reverseSynonyms[syn] = [];
        reverseSynonyms[syn].push(word);
    }
}

function own(map: Record<string, string[]>, w: string): string[] | undefined {
    return Object.prototype.hasOwnProperty.call(map, w) ? map[w] : undefined;
}

/** Expand a search query using synonyms: "fruit" → ["fruit", "lemon", "lime", ...] */
export function expandSearchTerms(query: string): string[] {
    const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);
    const expanded = new Set<string>(words);
    for (const w of words) {
        // Forward: word → its synonyms (e.g. "lemon" → ["fruit", "citrus"])
        const fwd = own(SYNONYM_MAP, w);
        if (fwd) for (const s of fwd) expanded.add(s);
        // Reverse: word → all words that have it as synonym (e.g. "fruit" → ["lemon", "lime"])
        const rev = own(reverseSynonyms, w);
        if (rev) for (const s of rev) expanded.add(s);
        // Also try stemmed forms
        let stem = w;
        if (w.endsWith('ies')) stem = w.slice(0, -3) + 'y';
        else if (w.endsWith('es')) stem = w.slice(0, -2);
        else if (w.endsWith('s') && w.length > 3) stem = w.slice(0, -1);
        else if (w.endsWith('ing') && w.length > 5) stem = w.slice(0, -3);
        if (stem !== w) {
            expanded.add(stem);
            const fwdStem = own(SYNONYM_MAP, stem);
            if (fwdStem) for (const s of fwdStem) expanded.add(s);
            const revStem = own(reverseSynonyms, stem);
            if (revStem) for (const s of revStem) expanded.add(s);
        }
    }
    return [...expanded];
}
