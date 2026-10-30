/**
 * Reading the tag library (library.ts): a tag by its id, its place in the tree, and the label index that turns a word typed
 * in any of the 25 languages into tag ids (DESIGN-owner-seeding-tags-fable.md §4.2, §4.7). The picker's search, suggestTags,
 * the Market's search and the assistant's tags_search all read one index, built once per language.
 */
import { CONTEXT_SEPARATOR, currentLanguage, currentWords, t, type Words } from '../words.js';
import { joinCompounds, plainWords } from '../search-terms.js';
import { TAG_LIBRARY, type TagDef } from './library.js';

export { TAG_LIBRARY, type TagDef } from './library.js';

/**
 * Letters of the scripts written without spaces between words: Thai, Lao, Myanmar, Khmer, the kana, and the Han characters
 * (with the supplementary planes' as surrogate pairs), the engine's UNSPACED_SCRIPT (posts.ts). A title in them is one run of
 * words, so the index looks for its names inside the run.
 */
const UNSPACED = /[\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]|[\ud840-\ud87f][\udc00-\udfff]/;

/** At most three levels: `top.group.item`, lowercase ASCII; the top is a Market category. */
export const TAG_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*){0,2}$/;

const BY_ID: ReadonlyMap<string, TagDef> = new Map(TAG_LIBRARY.map((tag) => [tag.id, tag]));
const ORDER: ReadonlyMap<string, number> = new Map(TAG_LIBRARY.map((tag, i) => [tag.id, i]));
const CHILDREN = new Map<string, TagDef[]>();
for (const tag of TAG_LIBRARY) {
    const parent = tagParent(tag.id);
    if (parent === null) continue;
    let list = CHILDREN.get(parent);
    if (!list) CHILDREN.set(parent, (list = []));
    list.push(tag);
}

export function tagById(id: string): TagDef | undefined {
    return BY_ID.get(id);
}

/** Whether an id is a tag in this library. An id from a newer library is not: it shows as nothing, never breaks (§4.3). A top
 *  is in the library (its root, the listing's category), but the picker's search and suggestTags never offer one: the
 *  category is its own field. */
export function isTagId(id: string): boolean {
    return BY_ID.has(id);
}

/** The id one level up, or null for a top. */
export function tagParent(id: string): string | null {
    const at = id.lastIndexOf('.');
    return at < 0 ? null : id.slice(0, at);
}

/** The tags one level down, in the library's order. */
export function tagChildren(id: string): readonly TagDef[] {
    return CHILDREN.get(id) ?? [];
}

/** The 17 tops, the Market's categories, in the library's order. */
export const TAG_TOPS: readonly TagDef[] = TAG_LIBRARY.filter((tag) => !tag.id.includes('.'));

/** The tag's English label ("Lemon"), as its word() key is written. */
export function tagEnglish(tag: TagDef): string {
    return tag.en.split(CONTEXT_SEPARATOR)[0];
}

/**
 * Every English word a tag is found by: its label, the words of it and every tag above it, its aliases. What the node folds
 * into a tagged listing's search_keywords (slice T2), so "fruit" or "citrus" finds a listing tagged lemon in any language.
 */
export function tagSearchWords(id: string): string[] {
    const tag = BY_ID.get(id);
    if (!tag) return [];
    const parts = id.split('.');
    const chain = parts.map((_, i) => BY_ID.get(parts.slice(0, i + 1).join('.')));
    const out = new Set<string>(plainWords(tagEnglish(tag)));
    for (const above of chain) for (const w of above?.words ?? []) out.add(w);
    for (const w of tag.aliases ?? []) out.add(w);
    return [...out];
}

const LETTER_FOLDS: Record<string, string> = {
    'œ': 'oe', 'Œ': 'oe',
    'æ': 'ae', 'Æ': 'ae',
    'ø': 'o', 'Ø': 'o',
    'đ': 'd', 'Đ': 'd',
    'ł': 'l', 'Ł': 'l',
    'ß': 'ss',
    'ı': 'i',
};
const FOLD_LETTERS = /[œæøđłßıŒÆØĐŁ]/g;

/** A label, title or typed word as the index holds it: its words, lower case, without accents (limón, limon; œ, oe; đ, d). */
export function tagText(text: string): string {
    let out = plainWords(text).join(' ');
    // A guarded normalize, as member-guide.ts: old Android engines may lack it. The combining marks U+0300–U+036F go (this
    // merges й/и in Cyrillic, accepted), while the matras of Hindi, Tamil, Bengali stay with their letters.
    try { out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC'); } catch { /* keep accents */ }
    return out.replace(FOLD_LETTERS, (c) => LETTER_FOLDS[c] ?? c);
}

/** The forms a text is keyed and found by: tagText, and tagText with each compound joined as a search looks it up ("wi-fi" →
 *  wifi, search-terms.ts queryWords), so "Wi-Fi" finds the label "Wifi" and "tshirt" a label "T-shirt". */
function tagForms(text: string): string[] {
    const words = tagText(text);
    const joined = tagText(joinCompounds(text));
    return joined === words ? [words] : [words, joined];
}

/** The words of one language turned into tag ids. */
export interface TagIndex {
    readonly lang: string;
    /** The word count of the longest name in the index, so suggestTags knows how wide a window to slide. */
    readonly maxWords: number;
    /** The tags a word or phrase names: a label in this language or in English, or a word the old synonym map keyed; a
     *  compound as written or joined ("Wi-Fi" finds "Wifi"). A label in this language beats the rest: Spanish "pan" is
     *  bread, never frying pans by the English synonym word "pan". */
    byName(text: string): readonly string[];
    /** The tags a label in this language names (an untranslated tag's is its English), as byName reads it: never by a
     *  translated tag's English label or an old synonym word. */
    byLabel(text: string): readonly string[];
    /** The tags an English broader word is on: a tag's words (for it and everything under it) or its aliases. */
    byAlias(text: string): readonly string[];
    /** The tags named inside a word of a script written without spaces: "新鲜柠檬出售" (fresh lemons for sale) holds 柠檬. The
     *  longer name first, each letter read once ("柠檬草" is lemongrass, not lemon). Empty for a word of any other script. */
    inside(text: string): readonly string[];
    /** The picker's search, from 2 characters: tags whose label (in this language or English) or old synonym word ("plumber",
     *  "sofa") has a word starting with what is typed, or in a script written without spaces holds it anywhere; the nearest
     *  first (the label itself, then a label starting with it, then a later word starting with it, then inside; within each,
     *  this language's labels, then English's, then the synonym words, and the shorter first). Never a top: the category is
     *  its own field. */
    search(text: string, limit?: number): string[];
    /** The label in this language; the English when the words have none. An unknown id gives ''. */
    label(id: string): string;
}

type Translate = Pick<Words, 'lang' | 't'>;

function add(map: Map<string, string[]>, text: string, id: string): void {
    for (const key of tagForms(text)) {
        if (!key) continue;
        const list = map.get(key);
        if (!list) map.set(key, [id]);
        else if (!list.includes(id)) list.push(id);
    }
}

function find(map: ReadonlyMap<string, readonly string[]>, text: string): readonly string[] {
    for (const key of tagForms(text)) {
        const ids = map.get(key);
        if (ids) return ids;
    }
    return [];
}

/**
 * The label index for one language: built from `words` (wordsFor(lang, catalogs), or the device's language when left
 * out). 546 tags, two labels each: a few milliseconds, once per language.
 */
export function buildTagIndex(words?: Translate): TagIndex {
    const lang = words?.lang ?? currentLanguage();
    const translate = words ? words.t : t;
    const names = new Map<string, string[]>();
    const ownNames = new Map<string, string[]>();
    const aliases = new Map<string, string[]>();
    const labels = new Map<string, string>();
    const own: Array<[string, string]> = [];
    const english: Array<[string, string]> = [];
    const keys: Array<[string, string]> = [];
    for (const tag of TAG_LIBRARY) {
        const en = tagEnglish(tag);
        const label = translate(tag.en) || en;
        labels.set(tag.id, label);
        add(names, label, tag.id);
        add(ownNames, label, tag.id);
        add(names, en, tag.id);
        for (const key of tag.synonymKeys ?? []) add(names, key, tag.id);
        for (const w of tag.words ?? []) add(aliases, w, tag.id);
        for (const w of tag.aliases ?? []) add(aliases, w, tag.id);
        for (const form of tagForms(label)) own.push([form, tag.id]);
        if (lang !== 'en') for (const form of tagForms(en)) english.push([form, tag.id]);
        for (const key of tag.synonymKeys ?? []) for (const form of tagForms(key)) keys.push([form, tag.id]);
    }
    // This language's names written without spaces, the longest first: what inside() looks for in a run.
    const unspaced = [...names.keys()].filter((name) => UNSPACED.test(name) && !name.includes(' ')).sort((a, b) => b.length - a.length);
    let maxWords = 1;
    for (const key of names.keys()) {
        const count = key.split(' ').length;
        if (count > maxWords) maxWords = count;
    }
    // How near a label is to what is typed: the label itself 0, the label's start 1, a later word's start 2, anywhere in a
    // label of a script written without spaces 3; none -1.
    const nearness = (label: string, q: string) => (label === q ? 0 : label.startsWith(q) ? 1 : label.includes(` ${q}`) ? 2
        : UNSPACED.test(q) && label.includes(q) ? 3 : -1);
    return {
        lang,
        maxWords,
        byName(text) {
            const mine = find(ownNames, text);
            return mine.length ? mine : find(names, text);
        },
        byLabel: (text) => find(ownNames, text),
        byAlias: (text) => find(aliases, text),
        inside(text) {
            let run = tagText(text);
            if (!UNSPACED.test(run)) return [];
            const out: string[] = [];
            for (const name of unspaced) {
                for (let at = run.indexOf(name); at >= 0; at = run.indexOf(name, at + name.length)) {
                    for (const id of names.get(name) ?? []) if (!out.includes(id)) out.push(id);
                    run = `${run.slice(0, at)}${' '.repeat(name.length)}${run.slice(at + name.length)}`;
                }
            }
            return out;
        },
        search(text, limit = 8) {
            const qs = tagForms(text);
            if (qs[0].length < 2) return [];
            // id → its best rank: how near, then this language, English, the synonym words, then the shorter. A tag found by
            // a synonym word still shows its label.
            const ranks = new Map<string, number>();
            [own, english, keys].forEach((list, which) => {
                for (const [name, id] of list) {
                    if (!id.includes('.')) continue; // a top is the listing's category, its own field
                    for (const q of qs) {
                        const near = nearness(name, q);
                        if (near < 0) continue;
                        const rank = (near * 3 + which) * 1000 + Math.min(name.length, 999);
                        if (rank < (ranks.get(id) ?? Infinity)) ranks.set(id, rank);
                    }
                }
            });
            return [...ranks]
                .sort((a, b) => a[1] - b[1] || (ORDER.get(a[0]) ?? 0) - (ORDER.get(b[0]) ?? 0))
                .slice(0, limit)
                .map(([id]) => id);
        },
        label: (id) => labels.get(id) ?? '',
    };
}

let cached: { words: Words; index: TagIndex } | undefined;

/** The device language's index, built on first use and again after every setLanguage (a language switch, or new words for
 *  the same language). */
export function tagIndex(): TagIndex {
    const words = currentWords();
    if (cached?.words !== words) cached = { words, index: buildTagIndex(words) };
    return cached.index;
}
