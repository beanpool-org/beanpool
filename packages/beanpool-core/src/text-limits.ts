/**
 * How much free text a row may hold, and how much of it a list sends (#1493).
 *
 * WHY THIS EXISTS. A group's description had no bound but the 2 MB request body, and every group read sent it whole:
 * on a node held to a 256 MB heap (NODE_PROFILE=global), 100 open groups with a 1.9 MB description each made the list
 * of groups a 90 MB answer, and a page of 200 ran the node out of memory (#1490's deciding review). The same held for
 * the other free text a list sends for every row it holds. So:
 *  - ON THE WAY IN, a new text is held to its limit, in characters as the apps' fields count them (`maxLength` in both
 *    apps counts UTF-16 code units, which is JavaScript's `.length`), and in UTF-8 bytes. Each limit's bytes are three
 *    times its characters: one UTF-16 unit is at most three UTF-8 bytes (a 4-byte emoji is two units), so text that fits
 *    in characters fits in bytes whatever its script, and no script is held to fewer characters than another. The byte
 *    bound is still checked, because it is the one a heap is measured in.
 *  - A LIST sends a bounded preview of a long text (previewText) and says so; the row's own read sends it whole. A row
 *    stored before its limit, longer than it, is kept as it is: nothing is cut on disk, a standby's copy carries it
 *    unchanged, and an edit that sends it back unchanged (or sends back the preview a list gave) leaves it as it is.
 *
 * Plain functions only: this file is in the barrel the phone app bundles (barrel-is-universal.test.ts).
 */

/** A text's limit: the most characters (UTF-16 code units, as `maxLength` counts) and the most UTF-8 bytes. */
export interface TextLimit {
    chars: number;
    bytes: number;
}

/** A limit of `chars` characters, and three bytes for each (any text that fits in characters fits in bytes). */
function limitOf(chars: number): TextLimit {
    return { chars, bytes: chars * 3 };
}

/**
 * A group's description: 2,000 characters, so at most 6,000 bytes of UTF-8 in any script (Latin 2,000 B, Greek, Cyrillic,
 * Arabic or Hebrew 4,000 B, Chinese, Japanese, Korean or Devanagari 6,000 B; 1,000 emoji, as two units each, 4,000 B).
 * About 350 words of English: room for what a group is for, who it is for, when it meets and its house rules. Both apps'
 * create forms stop at 300 (`maxLength`), so nothing either app sends is refused, and a longer field later needs no
 * server change. The same as the most a knock may say (2,000).
 */
export const GROUP_DESCRIPTION_LIMIT: TextLimit = limitOf(2_000);

/** A group's name: 100 characters, as the engine has always held it to. */
export const GROUP_NAME_LIMIT: TextLimit = limitOf(100);

// The other free text a list sends for every row it holds, with nothing but the 2 MB body to bound it until #1493. Each
// is held to its limit where a member writes it, and only there: a row stored before, longer, is kept and sent as it is.

/**
 * A listing's title (offers, needs, events, polls): 200 characters. The phone's fields stop at 50 to 140 (an event's is
 * the longest), and every list shows a title on one or two lines.
 */
export const LISTING_TITLE_LIMIT: TextLimit = limitOf(200);
/** A listing's description: 5,000 characters, about 850 words. Neither app's field has a limit; this is room for any. */
export const LISTING_DESCRIPTION_LIMIT: TextLimit = limitOf(5_000);
/** A listing's category: a key such as `food` or `tools`, which no app lets a member type. */
export const LISTING_CATEGORY_LIMIT: TextLimit = limitOf(50);
/** An enterprise's (and a crowdfund's) name: 100 characters, as a group's. The phone's field stops at 60. */
export const ENTERPRISE_NAME_LIMIT: TextLimit = limitOf(100);
/** An enterprise's (and a crowdfund's) purpose: 2,000 characters, as a group's description. */
export const ENTERPRISE_PURPOSE_LIMIT: TextLimit = limitOf(2_000);
/** The note sent with Beans or a pledge (a ledger line's memo): 500 characters. */
export const BEANS_NOTE_LIMIT: TextLimit = limitOf(500);
/** A Decision's title: 200 characters. */
export const DECISION_TITLE_LIMIT: TextLimit = limitOf(200);
/** A Decision's description: 5,000 characters. */
export const DECISION_DESCRIPTION_LIMIT: TextLimit = limitOf(5_000);
/** How to reach a member (a phone number, an email, a handle): 200 characters. */
export const CONTACT_VALUE_LIMIT: TextLimit = limitOf(200);

/** The words a refusal of `what` over `limit` says, as both apps show it: "A listing's title can be at most 200 characters. …" */
export function textTooLongMessage(what: string, limit: TextLimit): string {
    return `${what} can be at most ${limit.chars.toLocaleString('en-US')} characters. Please shorten it.`;
}

/**
 * How much of a long text a list sends for each row: 300 characters, then "…". The most either app's create form takes
 * for a group's description (`maxLength={300}`), so a list sends whole every description an app can write; only text
 * written past the forms (a script, or a row from before its limit) is cut. Every list row in both apps shows two lines
 * of it, and a search still matches the whole text (the node searches what it stores).
 */
export const LIST_PREVIEW_CHARS = 300;

/** The words both apps show when a group's description is over its limit. */
export const GROUP_DESCRIPTION_TOO_LONG = textTooLongMessage("A group's description", GROUP_DESCRIPTION_LIMIT);

/**
 * The bytes `text` takes in UTF-8, counted without encoding it: a lone surrogate counts as U+FFFD (3 bytes), as
 * TextEncoder and Node's Buffer write it.
 */
export function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80) bytes += 1;
        else if (c < 0x800) bytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { bytes += 4; i++; } else bytes += 3;
        } else bytes += 3;
    }
    return bytes;
}

/**
 * `text` with every lone (unpaired) UTF-16 surrogate replaced with U+FFFD (#1496).
 *
 * A lone surrogate counts as 1 unit / 3 bytes, but better-sqlite3 binds it as 3 bytes
 * (ED xx xx, CESU-8) that read back as three U+FFFD characters (3 units / 9 bytes).
 * Normalising before counting and storing ensures stored text never exceeds the limit.
 */
export function replaceLoneSurrogates(text: string): string {
    const candidate = text as unknown as { toWellFormed?: () => string };
    if (typeof candidate.toWellFormed === 'function') {
        return candidate.toWellFormed();
    }
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            if (i + 1 < text.length) {
                const next = text.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    result += text[i] + text[i + 1];
                    i++;
                    continue;
                }
            }
            result += '\ufffd';
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            result += '\ufffd';
        } else {
            result += text[i];
        }
    }
    return result;
}

/** Does `text` fit `limit`, in characters and in bytes? */
export function fitsTextLimit(text: string, limit: TextLimit): boolean {
    return text.length <= limit.chars && utf8ByteLength(text) <= limit.bytes;
}

/**
 * What a list sends of `text`: the text itself when it is `chars` characters or fewer, else its first `chars` characters
 * (never half of a surrogate pair), less trailing space, and "…". Only text longer than `chars` is ever cut, so a preview
 * is never the text it came from.
 */
export function previewText(text: string, chars: number = LIST_PREVIEW_CHARS): string {
    if (text.length <= chars) return text;
    let end = chars;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * `text` when it fits `limit`, else its preview one character short of it, so that with its "…" it fits. For a copy this
 * node only shows and never edits (a peer community's listing).
 */
export function cutToLimit(text: string, limit: TextLimit): string {
    const normalised = replaceLoneSurrogates(text);
    return fitsTextLimit(normalised, limit) ? normalised : previewText(normalised, limit.chars - 1);
}

/** Is `text` cut by previewText at `chars`? */
export function isPreviewed(text: string | null | undefined, chars: number = LIST_PREVIEW_CHARS): boolean {
    return typeof text === 'string' && text.length > chars;
}

