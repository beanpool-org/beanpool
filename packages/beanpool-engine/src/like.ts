// Searching text with SQL LIKE.
//
// `%` and `_` are LIKE's wildcards, and `\` is the escape every caller here names (`ESCAPE '\'`). Text a person typed is
// a substring to find, never a pattern: bound straight in, `%` matched everything and `_` any one character
// (FABLE-sec-sql LOW, 2026-10-01). Use as `col LIKE ? ESCAPE '\'` with `likeContains(text)` bound.

/** `text` with LIKE's wildcards and the escape character escaped, so each matches only itself. */
export function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, c => '\\' + c);
}

/** A LIKE pattern for `text` anywhere in the value, taken literally. Bind it to `LIKE ? ESCAPE '\'`. */
export function likeContains(text: string): string {
    return `%${escapeLike(text)}%`;
}
