/**
 * Reading the tag library (library.ts): a tag by its id, its place in the tree, and the label index that turns a word typed
 * in any of the 25 languages into tag ids (DESIGN-owner-seeding-tags-fable.md §4.2, §4.7). The picker's search, suggestTags,
 * the Market's search and the assistant's tags_search all read one index, built once per language.
 */
import { CONTEXT_SEPARATOR, currentLanguage, t, type Words } from '../words.js';
import { plainWords } from '../search-terms.js';
import { TAG_LIBRARY, type TagDef } from './library.js';

export { TAG_LIBRARY, type TagDef } from './library.js';

/** At most three levels: `top.group.item`, lowercase ASCII; the top is a Market category. */
export const TAG_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*){0,2}$/;

const BY_ID: ReadonlyMap<string, TagDef> = new Map(TAG_LIBRARY.map((tag) => [tag.id, tag]));
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

/** Whether an id is a tag in this library. An id from a newer library is not: it shows as nothing, never breaks (§4.3). */
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

/** A label, title or typed word as the index holds it: its words, lower case, without accents (limón, limon). */
export function tagText(text: string): string {
    let out = plainWords(text).join(' ');
    // A guarded normalize, as member-guide.ts: old Android engines may lack it. Only the Latin combining marks go, so the
    // matras of Hindi, Tamil, Bengali stay with their letters.
    try { out = out.normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC'); } catch { /* keep accents */ }
    return out;
}

/** The words of one language turned into tag ids. */
export interface TagIndex {
    readonly lang: string;
    /** The tags a word or phrase names: a label in this language or in English, or a word the old synonym map keyed. */
    byName(text: string): readonly string[];
    /** The tags an English broader word is on: a tag's words (for it and everything under it) or its aliases. */
    byAlias(text: string): readonly string[];
    /** Tags whose label (this language first, then English) has a word starting with what is typed; from 2 characters. */
    search(text: string, limit?: number): string[];
    /** The label in this language; the English when the words have none. An unknown id gives ''. */
    label(id: string): string;
}

type Translate = Pick<Words, 'lang' | 't'>;

function add(map: Map<string, string[]>, text: string, id: string): void {
    const key = tagText(text);
    if (!key) return;
    const list = map.get(key);
    if (!list) map.set(key, [id]);
    else if (!list.includes(id)) list.push(id);
}

/**
 * The label index for one language: built from `words` (wordsFor(lang, catalogs), or the device's language when left
 * out). 551 tags, two labels each: a few milliseconds, once per language.
 */
export function buildTagIndex(words?: Translate): TagIndex {
    const lang = words?.lang ?? currentLanguage();
    const translate = words ? words.t : t;
    const names = new Map<string, string[]>();
    const aliases = new Map<string, string[]>();
    const labels = new Map<string, string>();
    const own: Array<[string, string]> = [];
    const english: Array<[string, string]> = [];
    for (const tag of TAG_LIBRARY) {
        const en = tagEnglish(tag);
        const label = translate(tag.en) || en;
        labels.set(tag.id, label);
        add(names, label, tag.id);
        add(names, en, tag.id);
        for (const key of tag.synonymKeys ?? []) add(names, key, tag.id);
        for (const w of tag.words ?? []) add(aliases, w, tag.id);
        for (const w of tag.aliases ?? []) add(aliases, w, tag.id);
        own.push([tagText(label), tag.id]);
        if (lang !== 'en') english.push([tagText(en), tag.id]);
    }
    const matches = (text: string, q: string) => text.startsWith(q) || text.includes(` ${q}`);
    return {
        lang,
        byName: (text) => names.get(tagText(text)) ?? [],
        byAlias: (text) => aliases.get(tagText(text)) ?? [],
        search(text, limit = 8) {
            const q = tagText(text);
            if (q.length < 2) return [];
            const out: string[] = [];
            for (const list of [own, english]) {
                for (const [label, id] of list) {
                    if (out.length >= limit) return out;
                    if (matches(label, q) && !out.includes(id)) out.push(id);
                }
            }
            return out;
        },
        label: (id) => labels.get(id) ?? '',
    };
}

const cached = new Map<string, TagIndex>();

/** The device language's index, built on first use and again after a language switch (or its words arriving: the first
 *  top's label as translated now is part of the cache key). */
export function tagIndex(): TagIndex {
    const key = `${currentLanguage()}\u0000${t(TAG_LIBRARY[0].en)}`;
    let index = cached.get(key);
    if (!index) {
        cached.clear();
        cached.set(key, (index = buildTagIndex()));
    }
    return index;
}
