/**
 * What utils/db.ts _signedRequest throws on its own, in the member's language (words S3l).
 *
 * Every signed send that goes through _signedRequest (an event's let-in, edit and report, a vouch, …) is signed with the
 * member's key, so it never reaches the words layer. With no community set, no key, a send that failed without a reason,
 * or a refusal with no body, it throws its own English sentence; the screens that show it word it here by the exact
 * sentence (components/event-lines.ts hands on what it doesn't know; app/public-profile.tsx's vouch). db.ts is not
 * touched. A node's own words (a refusal's reason) are shown exactly as given (slice S4).
 * utils/__tests__/events-words-render.test.ts holds each to the throw in db.ts it stands for.
 */
import { t, word, type WordKey } from '@beanpool/core';

const FIXED: Readonly<Record<string, WordKey>> = {
    // No community set, no key, and a send that failed without a reason.
    'You are off-grid. Please connect to a BeanPool Node to perform this action.': word('You are off-grid. Please connect to a BeanPool Node to perform this action.'),
    'No identity found. You must be logged in.': word('No identity found. You must be logged in.'),
    'Network request failed. You must be connected to a node.': word('Network request failed. You must be connected to a node.'),
};

/** One of _signedRequest's sentences in the member's language; a node's own words, or anything else, exactly as given. */
export function signedRequestWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    // A refusal with no body at all.
    const status = english.match(/^Server returned (\d+)$/);
    if (status) return t('Server returned {status}', { status: status[1] });
    return english;
}
