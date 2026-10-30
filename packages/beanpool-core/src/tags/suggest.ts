/**
 * Tags to suggest for a listing from its own words (DESIGN-owner-seeding-tags-fable.md §4.4): one function for the phone's
 * and the web's pickers and the assistant. Reads the label index, so a Spanish title suggests from Spanish labels, and the
 * English ones and the old synonym words always. Suggests, never sets: the member (or the assistant) picks.
 */
import { plainWords } from '../search-terms.js';
import { TAG_LIBRARY, tagIndex, type TagIndex } from './index.js';

export interface SuggestTagsOptions {
    /** The listing's category (a top): its tags rank first. */
    readonly category?: string;
    /** The label index to read; the device language's when left out. */
    readonly index?: TagIndex;
    /** How many to give; 5 (what a listing holds) when left out. */
    readonly limit?: number;
}

const ORDER = new Map(TAG_LIBRARY.map((tag, i) => [tag.id, i]));
const depth = (id: string) => id.split('.').length;

/** An English plural's singular forms to try: berries → berry, tomatoes → tomato, lemons → lemon. */
function singulars(word: string): string[] {
    const out: string[] = [];
    if (word.length > 4 && word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`);
    if (word.length > 4 && /(?:oes|ches|shes|xes|sses)$/.test(word)) out.push(word.slice(0, -2));
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) out.push(word.slice(0, -1));
    return out;
}

/**
 * Up to `limit` tag ids for a title and description, best first. A tag is named by a label or an old synonym word (three,
 * two, then one word at a time, the longer name first: "sweet potato" is not "potato"; a hyphened word only whole:
 * "free-range" is not "free"). An English broader word in the title ("screen", "citrus") adds the few tags it is on inside
 * the listing's category (at most two), never a family ("food") and never from elsewhere ("hire" on a chainsaw is not
 * a party). Title words count three times a description's. When a tag and one under it are both found, the one under it
 * is kept. Tops are never suggested: the category is its own field.
 */
export function suggestTags(title: string, description = '', options: SuggestTagsOptions = {}): string[] {
    const index = options.index ?? tagIndex();
    const limit = options.limit ?? 5;
    const scores = new Map<string, number>();
    const bump = (ids: readonly string[], by: number) => {
        for (const id of ids) if (id.includes('.')) scores.set(id, (scores.get(id) ?? 0) + by);
    };
    const lookup = (words: string[], find: (text: string) => readonly string[]): readonly string[] => {
        const found = find(words.join(' '));
        if (found.length) return found;
        const head = words.slice(0, -1);
        for (const last of singulars(words[words.length - 1])) {
            const again = find([...head, last].join(' '));
            if (again.length) return again;
        }
        return [];
    };
    const read = (text: string, weight: number, broaderToo: boolean) => {
        // A hyphened chunk ("free-range", "off-grid") is one word made of its parts, so it names only as a whole.
        const words = text.split(/\s+/).map((chunk) => plainWords(chunk).join(' ')).filter(Boolean);
        const used = new Array<boolean>(words.length).fill(false);
        for (const n of [3, 2, 1]) {
            for (let i = 0; i + n <= words.length; i++) {
                if (used.slice(i, i + n).some(Boolean)) continue;
                const ids = lookup(words.slice(i, i + n), index.byName);
                if (ids.length) {
                    bump(ids, weight * (1 + (n - 1) / 2));
                    for (let j = i; j < i + n; j++) used[j] = true;
                } else if (n === 1 && broaderToo && options.category) {
                    const broader = lookup([words[i]], index.byAlias).filter((id) => id.startsWith(`${options.category}.`));
                    if (broader.length <= 2) bump(broader, weight / 2);
                }
            }
        }
    };
    read(title, 3, true);
    read(description, 1, false);
    if (options.category) {
        for (const [id, score] of scores) if (id.startsWith(`${options.category}.`)) scores.set(id, score + 1);
    }
    const ranked = [...scores]
        .sort((a, b) => b[1] - a[1] || depth(b[0]) - depth(a[0]) || (ORDER.get(a[0]) ?? 0) - (ORDER.get(b[0]) ?? 0))
        .map(([id]) => id);
    const out: string[] = [];
    for (const id of ranked) {
        if (out.length >= limit) break;
        if (ranked.some((other) => other.startsWith(`${id}.`))) continue;
        out.push(id);
    }
    return out;
}
