/**
 * The message an "Ask to join" request (a knock) carries: the fewest characters it may have, and how they are counted.
 *
 * At least {@link KNOCK_MESSAGE_MIN_CHARS} characters (Marty, 27 Nov 2026: two automated-looking requests on the test
 * community said "pls" and "hello community"). The one definition: the node refuses fewer (apps/server routes/knocks.ts
 * parseMessage), and the phone's and the web app's forms hold the member to it before sending (apps/native/utils/knock.ts
 * and apps/pwa/src/lib/knock.ts knockFormProblem). The most a message may have is the node's KNOCK_RULES.messageChars.
 *
 * Counted as the node counts, for the fewest and the most alike: control characters but line breaks and tabs taken out, the
 * ends trimmed, then characters (code points), so an emoji or an accented letter is one.
 */

export const KNOCK_MESSAGE_MIN_CHARS = 20;

/**
 * Control characters but line breaks and tabs: the node's `(?![\n\t])\p{Cc}`, spelled as ranges (U+0000-0008, U+000B-001F,
 * U+007F-009F) because this file loads on old Android engines, which throw on Unicode property escapes (search-terms.ts).
 * knock-message.test.ts holds the two to the same characters.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** A knock's message as the node keeps it: control characters but line breaks and tabs taken out, the ends trimmed. */
export function knockMessageText(raw: string): string {
    return raw.replace(CONTROL, '').trim();
}

/** How many characters the node counts in a knock's message ({@link knockMessageText}, in code points). */
export function knockMessageChars(raw: string): number {
    return Array.from(knockMessageText(raw)).length;
}
