/**
 * A display label (community name, contact) made fit for the address registrar: what apps/registrar/src/index.js
 * labelProblem accepts. Control characters, line and paragraph separators and bidi embedding/override/isolate characters
 * (Android's BidiFormatter wraps right-to-left text in U+2068…U+2069, so copy-paste carries them in) are dropped, a tab or
 * line break becomes a space, and the result is trimmed and cut to `max` characters (the registrar counts characters,
 * not UTF-16 units). Keep BAD_TEXT in step with the registrar's.
 */
const BREAKS = /[\t\n\r\u2028\u2029]+/g;
const BAD_TEXT = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

export const REGISTRAR_COMMUNITY_NAME_MAX = 120;
export const REGISTRAR_CONTACT_MAX = 254;

export function cleanLabel(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const t = value.replace(BREAKS, ' ').replace(BAD_TEXT, '').replace(/ {2,}/g, ' ').trim();
    const cut = [...t].slice(0, max).join('').trim();
    return cut || undefined;
}
