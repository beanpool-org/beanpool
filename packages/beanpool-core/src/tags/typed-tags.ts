/**
 * What the one Tags field makes of what a member types (DESIGN-tags-free-entry-fable.md §3, slice F2): the rule both apps'
 * pickers read, so Enter, a comma, Done and the "Add" row commit the same thing on the phone and the web. A word that is a
 * library label picks the library tag, never a free twin; anything else that passes the rule (free-tags.ts) is the member's
 * own tag; what does not pass is said in words before anything is sent.
 */
import { compoundWords } from '../search-terms.js';
import { word, type WordKey } from '../words.js';
import {
    FREE_TAGS_CHARS, FREE_TAGS_MAX, FREE_TAGS_TOO_LONG_TOGETHER, FREE_TAGS_TOO_MANY, freeTagRefusal, freeTagStored, storedFreeTags,
} from './free-tags.js';
import { lookupPhrase, tagIndex, type TagIndex } from './index.js';
import { POST_TAGS_MAX } from './post-tags.js';

export const TYPED_TAG_WORDS = {
    /** The last row of the sheet: what pressing Enter would add. `{tag}` is the tag with its `#`. */
    add: word('Add “{tag}”'),
    /** The composer's two hints, under the field (§5, §7). */
    arePublic: word('Tags are public with your listing'),
    yourWords: word('A tag you type is in your own words. Pick a library tag to be found in every language.'),
};

/** What commits a typed tag as a comma does: the comma of the keyboards a member has, Arabic's and Chinese's among them. */
export const TAG_COMMA = /[,،、，]/;

/** The tags a composer holds: the library's ids and the member's own, as stored. */
export interface TagsHeld {
    readonly tags: readonly string[];
    readonly freeTags: readonly string[];
}

/** A tag no listing may carry, and why, in words. */
export interface RefusedTag {
    kind: 'refused';
    why: WordKey;
}

/** What typed text would become: a library tag, the member's own, or a refusal in words. */
export type TypedTag =
    | { kind: 'library'; id: string }
    | { kind: 'free'; tag: string }
    | RefusedTag;

/** The refusal of a tag past the five of its kind, for a picker that stops a tap on one. */
export const TOO_MANY_TAGS: RefusedTag = { kind: 'refused', why: FREE_TAGS_TOO_MANY };

/**
 * The library tag a text names exactly: a label in the member's language or in English, a plural's singular too, as a
 * search resolves one (lookupPhrase), with the row a search would put first. Never a top: the category is its own field. A
 * word the library knows only as a synonym or an alias is not its label: the member's own word stays theirs, and the
 * library's tag stays one tap away in the results.
 */
export function exactLibraryTag(text: string, index: TagIndex = tagIndex()): string | null {
    const named = (phrase: string) => {
        const mine = index.byLabel(phrase).filter((id) => id.includes('.'));
        return mine.length > 0 ? mine : index.byEnglish(phrase).filter((id) => id.includes('.'));
    };
    const ids = lookupPhrase(compoundWords(freeTagStored(text)), named);
    if (ids.length === 0) return null;
    return index.search(text, 12).find((id) => ids.includes(id)) ?? ids[0];
}

/** What this text would become beside the tags held, or null for nothing to commit (an empty field, a lone `#`). */
export function typedTag(text: string, held: TagsHeld, index: TagIndex = tagIndex()): TypedTag | null {
    const tag = freeTagStored(text);
    if (!tag) return null;
    const id = exactLibraryTag(text, index);
    if (id) {
        if (!held.tags.includes(id) && held.tags.length >= POST_TAGS_MAX) return TOO_MANY_TAGS;
        return { kind: 'library', id };
    }
    const why = freeTagRefusal(text);
    if (why) return { kind: 'refused', why };
    if (held.freeTags.includes(tag)) return { kind: 'free', tag };
    if (held.freeTags.length >= FREE_TAGS_MAX) return TOO_MANY_TAGS;
    if (storedFreeTags([...held.freeTags, tag]).length > FREE_TAGS_CHARS) return { kind: 'refused', why: FREE_TAGS_TOO_LONG_TOGETHER };
    return { kind: 'free', tag };
}

/** The field after a commit: the tags as they now stand, what stays in the field, and why it stayed, in words. */
export interface TagEntry {
    tags: string[];
    freeTags: string[];
    rest: string;
    refused: RefusedTag | null;
}

/**
 * Commits what is typed, piece by piece at each comma, so a pasted "used, 2nd hand" is two tags. `done`: Enter or Done ended
 * the last piece; without it the piece after the last comma is still being typed and stays in the field. A refused piece
 * stops there: the ones before it are in, and it stays in the field with the words to say why.
 */
export function enterTypedTags(text: string, held: TagsHeld, done: boolean, index: TagIndex = tagIndex()): TagEntry {
    const pieces = text.split(TAG_COMMA);
    const typing = done ? '' : pieces.pop() ?? '';
    const tags = [...held.tags];
    const freeTags = [...held.freeTags];
    for (let i = 0; i < pieces.length; i++) {
        const typed = typedTag(pieces[i], { tags, freeTags }, index);
        if (!typed) continue;
        if (typed.kind === 'refused') {
            const rest = [...pieces.slice(i).map((piece) => piece.trim()), typing.trimStart()].filter(Boolean).join(', ');
            return { tags, freeTags, rest, refused: typed };
        }
        if (typed.kind === 'library' && !tags.includes(typed.id)) tags.push(typed.id);
        if (typed.kind === 'free' && !freeTags.includes(typed.tag)) freeTags.push(typed.tag);
    }
    return { tags, freeTags, rest: typing, refused: null };
}

/** The tags with the last chip off, as backspace on an empty field takes it: the member's own come after the library's. */
export function lastTagOff(held: TagsHeld): { tags: string[]; freeTags: string[] } {
    return held.freeTags.length > 0
        ? { tags: [...held.tags], freeTags: held.freeTags.slice(0, -1) }
        : { tags: held.tags.slice(0, -1), freeTags: [] };
}
