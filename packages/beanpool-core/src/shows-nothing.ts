/**
 * The characters that show as nothing, one list for every reader in core: Unicode's Default_Ignorable_Code_Point (the soft
 * hyphen, the combining grapheme joiner, the Arabic letter mark, the Hangul and Khmer fillers, the Mongolian free variation
 * selectors and vowel separator, the zero-width space, the joiners, the direction marks, embeddings, overrides and isolates,
 * the word joiner and invisible operators, the variation selectors, the byte-order mark, the shorthand and musical format
 * marks, the tag characters, and the places Unicode keeps for more of them), plus U+2800, the blank braille cell, which is
 * a letter to Unicode but shows as a space.
 *
 * Who reads it: a free tag reads a contact past them (tags/free-tags.ts looksLikeContact), and a person's name loses them
 * where they spell nothing (name-line.ts cleanName). Each keeps or drops the ones it spells with itself.
 *
 * The inside of a RegExp character class, for the `u` flag. Written out, never as a Unicode property escape (\p{DI}): core
 * loads at app start on old Android engines, where those throw (search-terms.ts). A test checks it against \p{DI} as Node
 * knows it (shows-nothing.test.ts).
 */
export const SHOWS_NOTHING_CHARS = '\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E'
    + '\\u2060-\\u206F\\u2800\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF0-\\uFFF8\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E0FFF}';
