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

// Punctuation and symbols only (ASCII, Latin-1, general punctuation, CJK punctuation), so letters of every script stay:
// яйца, अंडे, 鸡蛋, jardín. No Unicode property escapes (\p{L}): this module loads at app start on old Android engines,
// where they throw (member-guide.ts SEPARATORS, the same ranges). Spaces are made plain first so they still part words,
// and the zero-width joiners (U+200C, U+200D) stay inside the words that use them (Persian, emoji). Control characters go
// too: a NUL reaching FTS5 breaks the read (#1716 confirmation, finding 2).
const PUNCTUATION = /[\u0000-\u001f\u007f-\u009f!-/:-@[-`{-~\u00a0-\u00bf\u2000-\u200b\u200e-\u206f\u3000-\u303f]/g;

/** Expand a search query using synonyms: "fruit" → ["fruit", "lemon", "lime", ...] */
export function expandSearchTerms(query: string): string[] {
    // A one-character word outside ASCII (鱼, 알) is a word; a lone a-z letter or digit is not.
    const words = query.toLowerCase().replace(/\s+/g, ' ').replace(PUNCTUATION, '').split(' ').filter(w => w.length > 1 || w > '\u007f');
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

/**
 * The terms a search asks for: the expanded words, or, when expanding leaves none (a one-character word such as 蛋, or
 * punctuation alone), the words as typed. Typed words never become no words, so a search never reads every listing
 * under the member's words. The node's saved-search card and the phone's Market both ask with these.
 */
export function searchTermsFor(query: string): string[] {
    const terms = expandSearchTerms(query);
    // Quotes go as the engine strips them, and control characters as above: what is left is what FTS5 can be asked.
    return terms.length ? terms : query.toLowerCase().replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/["']/g, '').split(/\s+/).filter(Boolean);
}
