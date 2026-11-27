/**
 * Words for a one-line label, with every ordinary space made a no-break space (U+00A0), so the line breaker has no place to
 * break them. People's sub-tab pills draw "🏘️ Community" as one Text with numberOfLines={1}: Android broke that line at the
 * space after the emoji, the first line was the emoji alone and numberOfLines cut the word (Marty, 28 Oct and again
 * 28 Nov 2026, Android 1.4.8: the unselected middle tab read "🏘️"). On one line a break can only cut, so the emoji and its
 * words go as one unit; a name too wide for its pill shrinks (adjustsFontSizeToFit) instead.
 *
 * Applied where the label is drawn, never to a words key: the 25 catalogs keep their plain spaces.
 *
 * Drawn the width of the space it replaces: Roboto's U+00A0 and U+0020 are both 508/2048 em, and Noto Color Emoji has no
 * U+00A0 glyph, so Android takes it from the text's own font, not from the emoji font (whose space is 1.245 em). Only U+0020
 * changes: a zero-width non-joiner (Persian's دعوت‌ها) shapes a word and is no break, and a language written without spaces
 * has none to change.
 */
export function unbreakable(words: string): string {
    return words.replace(/ /g, '\u00A0');
}
