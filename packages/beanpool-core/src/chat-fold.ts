/**
 * A long chat message folds (Marty, 28 Oct: "in messaging - DM and groups - long messages should get a ...more like they
 * do in FB and other message apps"): past CHAT_FOLD_LINES lines, a bubble shows its first lines and a "…more" control, in
 * every chat (a one-to-one chat, a group, an enterprise or event chat), sent and received, on the phone and the web.
 *
 * WHY THE LINES ARE MEASURED, NOT COUNTED. Where a line wraps depends on the bubble's width, the font and the member's
 * font scale; no function of the text alone knows it. Each app measures what it drew (the phone from the text's own
 * layout, the web from the clamped box) against this one constant. What can be known from the text alone is whether
 * measuring is worth doing at all: `mayFoldChatText`. A message that fails it is drawn exactly as it always was, with no
 * measuring and nothing extra in its tree.
 *
 * Plain functions only: this file is in the barrel the phone app bundles (barrel-is-universal.test.ts).
 */

/** How many lines of a message show before "…more". The same on the phone and the web. */
export const CHAT_FOLD_LINES = 12;

/**
 * The fewest characters a wrapped line can hold, at the narrowest bubble either app draws (a 320 dp phone at 1.3× font is
 * about 11 of the widest glyphs, a CJK character; 4 leaves room for the largest accessibility font sizes). A bound, not a
 * measurement: it only has to be too small, never too large.
 */
const FEWEST_CHARS_PER_LINE = 4;

/**
 * Whether this text could run past CHAT_FOLD_LINES lines at ANY width: each paragraph (the text between line breaks) is at
 * least one line and at most one per FEWEST_CHARS_PER_LINE characters. False means it cannot, so it is never measured.
 * True means only "worth measuring".
 */
export function mayFoldChatText(text: string | null | undefined): boolean {
    if (!text) return false;
    let lines = 0;
    for (const paragraph of text.split('\n')) {
        lines += Math.max(1, Math.ceil(paragraph.length / FEWEST_CHARS_PER_LINE));
        if (lines > CHAT_FOLD_LINES) return true;
    }
    return false;
}
