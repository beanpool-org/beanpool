/**
 * The tags a member types on a listing (DESIGN-tags-free-entry-fable.md §2, slice F1): `posts.free_tags`, a JSON list of the
 * tags in their stored form, '' for none, beside the library's ids in `posts.tags` and never mixed with them. One rule for
 * the node's door (engine post-fields.ts), its copies (a standby's import, a peer's listings) and, from slice F2, the apps'
 * pickers, which read the refusals below before anything is sent.
 *
 * A tag is the member's own words in their own language: shown as typed, found by its own letters, never translated.
 */
import { replaceLoneSurrogates } from '../text-limits.js';
import { word, type WordKey } from '../words.js';

/** The most a listing carries, beside its five from the library. */
export const FREE_TAGS_MAX = 5;
/** The fewest characters in a tag, counted as a member counts them (Array.from: an emoji is one). */
export const FREE_TAG_MIN_CHARS = 2;
export const FREE_TAG_MAX_CHARS = 30;
export const FREE_TAG_MAX_WORDS = 4;
/**
 * The longest the stored column may be, its JSON counted as `POST_TAGS_CHARS` counts `posts.tags`. Five tags of 30 characters
 * are 150 and fit; this is what bounds the ones that store longer than they read, in emoji or quote marks.
 */
export const FREE_TAGS_CHARS = 200;

export const FREE_TAG_TOO_SHORT = word('A tag needs at least two letters or numbers');
export const FREE_TAG_TOO_LONG = word('A tag is 30 characters at most');
export const FREE_TAG_TOO_MANY_WORDS = word('A tag is four words at most');
export const FREE_TAG_NOT_A_CONTACT = word('A tag is a word to find your listing by, not a contact');
export const FREE_TAG_HIDDEN_CHARACTER = word('A tag cannot hold hidden characters. Type it again.');
/** `free=a,b` parts its tags at a comma, as the pickers commit one, so a tag holding one could never be filtered on. */
export const FREE_TAG_HOLDS_A_COMMA = word('One tag at a time: a comma parts two tags');
export const FREE_TAGS_TOO_MANY = word('Five tags at most');
export const FREE_TAGS_TOO_LONG_TOGETHER = word('These tags are too long together. Take one off.');

function normalised(text: string, form: 'NFC' | 'NFKC'): string {
    // Guarded, as tagText is: old Android engines may lack it.
    try { return text.normalize(form); } catch { return text; }
}

/**
 * A class of characters by Unicode property, or `fallback` where the engine has no such escapes: old Android engines
 * throw on one, and as a literal it would throw when this module loads (search-terms.ts).
 */
function byProperty(source: string, fallback: RegExp): RegExp {
    try { return new RegExp(source, 'gu'); } catch { return fallback; }
}

const LETTER_OR_DIGIT = byProperty('[\\p{L}\\p{N}]',
    /[0-9A-Za-z\u00aa\u00b5\u00ba\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02ff\u0370-\u1fff\u2c00-\u2dff\u3040-\ud7ff\uf900-\ufdff\ufe70-\ufefc\uff66-\uffdc]/g);
const DIGIT = byProperty('\\p{Nd}', /[0-9]/g);
/** A run of digits a phone number could be: only spaces, dots, brackets, a plus and dashes between them. */
const DIGIT_RUN = byProperty('\\p{Nd}(?:[\\s().+\\u2010-\\u2015-]*\\p{Nd})*', /[0-9](?:[\s().+\u2010-\u2015-]*[0-9])*/g);
const PHONE_DIGITS = 7;

// Control characters, and the format characters that change what a tag looks like without showing: a soft hyphen, zero-width
// space, the marks and overrides of text direction, the word joiners. Not U+200C or U+200D, which the words of some
// scripts and emoji are written with (search-terms.ts).
// eslint-disable-next-line no-control-regex -- finding control characters is the point
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufff9-\ufffb]/;

// A web address: a scheme, or a name and a dot before Latin letters ("example.com", "t.me/x", and "node.js" with them).
// Not digits after the dot ("3.5mm"), a single letter ("a.k.a"), or other scripts, whose abbreviations are written with a
// dot and no space ("г.москва", "ดร.สมชาย").
const WEB_ADDRESS = /:\/\/|[^\s.]\.[a-z]{2,}/;

function looksLikeContact(tag: string): boolean {
    // Compatibility forms too: a full-width "＠" or "０４１２" is still an address or a number.
    const folded = normalised(tag, 'NFKC');
    if (folded.includes('@') || WEB_ADDRESS.test(folded)) return true;
    return (folded.match(DIGIT_RUN) ?? []).some((run) => (run.match(DIGIT) ?? []).length >= PHONE_DIGITS);
}

/**
 * A tag as it is stored, which is what equality, the `free=` filter and the node's list of tags read: lone surrogates
 * replaced, NFC, trimmed, its inner whitespace one space, a leading `#` dropped, lower-cased with its accents kept
 * ("#Limón" → "limón"). Nothing is refused here (freeTagRefusal). Reading a stored tag gives the same tag back, so a copy
 * of a listing holds the bytes the node it came from holds.
 */
export function freeTagStored(text: string): string {
    const plain = normalised(replaceLoneSurrogates(text), 'NFC').replace(/\s+/g, ' ').replace(/^[#\uff03\s]+/, '').trim();
    return normalised(plain.toLowerCase(), 'NFC');
}

/** Why no listing may carry this tag, in words, or null when one may. Reads it as it would be stored. */
export function freeTagRefusal(text: string): WordKey | null {
    const tag = freeTagStored(text);
    if (HIDDEN.test(tag)) return FREE_TAG_HIDDEN_CHARACTER;
    if (looksLikeContact(tag)) return FREE_TAG_NOT_A_CONTACT;
    if (tag.includes(',')) return FREE_TAG_HOLDS_A_COMMA;
    const chars = Array.from(tag).length;
    if (chars < FREE_TAG_MIN_CHARS || (tag.match(LETTER_OR_DIGIT) ?? []).length < 2) return FREE_TAG_TOO_SHORT;
    if (chars > FREE_TAG_MAX_CHARS) return FREE_TAG_TOO_LONG;
    if (tag.split(' ').length > FREE_TAG_MAX_WORDS) return FREE_TAG_TOO_MANY_WORDS;
    return null;
}

/** The tags a stored `posts.free_tags` holds, in its order; [] for none, or for anything that is not such a list. */
export function freeTagsOf(stored: unknown): string[] {
    if (typeof stored !== 'string' || !stored) return [];
    try {
        const list: unknown = JSON.parse(stored);
        return Array.isArray(list) ? list.filter((tag): tag is string => typeof tag === 'string') : [];
    } catch {
        return [];
    }
}

/** The column's value for these tags: a JSON list, '' for none, so an untagged listing is byte for byte as before. */
export function storedFreeTags(tags: readonly string[]): string {
    return tags.length > 0 ? JSON.stringify(tags) : '';
}

/**
 * The tags a copy says a listing carries (a main server's row on a standby, a peer's listing), held to the same rule as
 * this node keeps them: each in its stored form, once, in its order, at most FREE_TAGS_MAX in FREE_TAGS_CHARS. Nothing is
 * refused: a tag the rule does not pass is left out and the rest stay, and anything that is not a list is none. A
 * rule made stricter later would leave a standby short of its main server's tags: raise TABLE_HASHES_VERSION with it.
 */
export function copiedFreeTags(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const text of raw) {
        if (typeof text !== 'string' || freeTagRefusal(text) !== null) continue;
        const tag = freeTagStored(text);
        if (out.includes(tag)) continue;
        if (out.length >= FREE_TAGS_MAX || storedFreeTags([...out, tag]).length > FREE_TAGS_CHARS) break;
        out.push(tag);
    }
    return out;
}
