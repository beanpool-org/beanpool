/**
 * Links in a chat message, for both apps (Marty, 9 Nov: a link was underlined and tappable on the phone and plain words on the
 * web). One copy here, so the two cannot disagree about what is a link or where it goes.
 *
 * A link is `http://…`, `https://…` or a bare `www.…`, up to the next space. Nothing else is one: no `ftp:`, no `mailto:`, no
 * `javascript:`, and no bare `example.org` (it is just words). The phone draws each link run as a tappable `Text`
 * (apps/native/components/chat/ChatBubble.tsx); the web draws it as an `<a>` (apps/pwa/src/components/ChatLinkedText.tsx).
 */

// The capturing group keeps the matched URLs in the split output so they can be rendered inline.
const URL_SPLIT_REGEX = /((?:https?:\/\/|www\.)[^\s]+)/gi;
const URL_TEST_REGEX = /^(?:https?:\/\/|www\.)[^\s]+$/i;

export interface TextRun {
    text: string;
    isUrl: boolean;
}

/** Split a message into plain runs and URL runs, in order. Empty runs are dropped. */
export function splitTextWithLinks(text: string | null | undefined): TextRun[] {
    if (!text) return [];
    return String(text)
        .split(URL_SPLIT_REGEX)
        .filter(part => part !== '' && part !== undefined)
        .map(part => ({ text: part, isUrl: URL_TEST_REGEX.test(part) }));
}

/**
 * The address a tapped run actually opens: trailing punctuation dropped (a URL at the end of a sentence),
 * a bare `www.` given a scheme, and anything that is still not http(s) refused.
 */
export function normaliseTappedUrl(raw: string): string | null {
    let url = (raw || '').replace(/[.,;:!?)\]}'"]+$/, '');
    if (/^www\./i.test(url)) url = 'https://' + url;
    return /^https?:\/\//i.test(url) ? url : null;
}
