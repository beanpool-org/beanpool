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

// Punctuation and symbols only (ASCII, Latin-1, general punctuation, the CJK block's punctuation, full-width and half-width
// forms), so letters of every script stay: яйца, अंडे, 鸡蛋, jardín, 人々. No Unicode property escapes (\p{L}): this module
// loads at app start on old Android engines, where they throw (member-guide.ts SEPARATORS, whose NFKD folds the full-width
// forms). Each becomes a space, so it parts words as posts_fts's unicode61 parts them: "鸡蛋，牛奶" and "鸡蛋、牛奶" (how a
// Chinese list is written) are two words, each found mid-run (#1781). The zero-width joiners (U+200C, U+200D) stay inside
// the words that use them (Persian, emoji). Control characters go too: a NUL reaching FTS5 breaks the read (#1716
// confirmation, finding 2). U+3000–303F loses its punctuation only: 々 〆 〇 〡–〩 〱–〵 〸–〼 are letters, the combining
// tone marks 〪–〯 belong to their letter.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const PUNCTUATION = /[\u0000-\u001f\u007f-\u009f!-/:-@[-`{-~\u00a0-\u00bf\u2000-\u200b\u200e-\u206f\u3000-\u3004\u3008-\u3020\u3030\u3036\u3037\u303d-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g;

// A Latin word joined by hyphens (wi-fi, co-op, t-shirt), or digits joined by . , / (1,000, 3.5, 24/7), is one word: parted,
// "wi-fi" asked for every word starting "wi" or "fi", most of the board (#1808 review, finding 1). Kept whole it finds what
// holds it: FTS5 reads the engine's "wi-fi"* as the phrase wi fi*, and the web's substring finds it as typed. ASCII marks
// around it come off first ("(t-shirt),"), so they never keep it from being whole.
const COMPOUND = /^(?:[a-z0-9\u00c0-\u024f]+(?:[-\u2010\u2011][a-z0-9\u00c0-\u024f]+)+|[0-9]+(?:[.,/][0-9]+)+)$/;
const COMPOUND_JOINS = /[-\u2010\u2011.,/]/g;
const ASCII_MARKS_AROUND = /^[!-/:-@[-`{-~]+|[!-/:-@[-`{-~]+$/g;
// Control characters and the spaces \s leaves out part chunks before a chunk is read as a compound.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const NOT_WORD_SPACE = /[\u0000-\u001f\u007f-\u009f\u00a0\u3000]/g;

/** The words of a query: a compound whole and joined (wi-fi, wifi: the joined form is what the synonyms are looked up on),
 *  every other chunk parted at its punctuation. */
function queryWords(query: string): string[] {
    const words: string[] = [];
    for (const chunk of query.toLowerCase().replace(NOT_WORD_SPACE, ' ').split(/\s+/)) {
        const bare = chunk.replace(ASCII_MARKS_AROUND, '');
        if (COMPOUND.test(bare)) {
            words.push(bare.replace(/[\u2010\u2011]/g, '-'), bare.replace(COMPOUND_JOINS, ''));
            continue;
        }
        // A one-character word outside ASCII (鱼, 알) is a word; a lone a-z letter or digit is not.
        for (const w of chunk.replace(PUNCTUATION, ' ').split(/\s+/)) if (w.length > 1 || w > '\u007f') words.push(w);
    }
    return words;
}

/** Expand a search query using synonyms: "fruit" → ["fruit", "lemon", "lime", ...] */
export function expandSearchTerms(query: string): string[] {
    const words = queryWords(query);
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
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    return terms.length ? terms : query.toLowerCase().replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/["']/g, '').split(/\s+/).filter(Boolean);
}
