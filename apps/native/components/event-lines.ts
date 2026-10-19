/**
 * The phone's own sentences an event's page shows from utils/db.ts, in the member's language (words S3l).
 *
 * utils/db.ts signs the RSVP, the cancel, the let-in, the report and the reminder with the member's key, so it never
 * reaches the words layer: what rsvpEvent, deletePost, letInToEvent and reportAbuse (_signedRequest) and setEventReminder
 * throw as written is worded again here as word() keys and looked up by the exact sentence where
 * components/EventDetail.tsx and EventExtras.tsx show it. db.ts is not touched. A node's own words (a refusal's reason)
 * are shown exactly as given (slice S4). utils/__tests__/events-words-render.test.ts holds each to the throw in db.ts it
 * stands for.
 */
import { t, word, type WordKey } from '@beanpool/core';
import { UNSIGNABLE_RSVP_MESSAGE } from '../utils/events';

const FIXED: Readonly<Record<string, WordKey>> = {
    // rsvpEvent: an id the phone won't sign for, no community set, no key, and a refusal without the node's words.
    [UNSIGNABLE_RSVP_MESSAGE]: UNSIGNABLE_RSVP_MESSAGE,
    'You are currently offline.': word('You are currently offline.'),
    'No identity found.': word('No identity found.'),
    'Could not save your RSVP': word('Could not save your RSVP'),
    // setEventReminder: the same two as rsvpEvent, and a refusal without the node's words.
    'Could not save your reminder': word('Could not save your reminder'),
    // deletePost: no community set, no key, and a refusal without the node's words (inside "Offline or …", below).
    'Action requires internet connection.': word('Action requires internet connection.'),
    'Not logged in. Identity required.': word('Not logged in. Identity required.'),
    'Failed to remove post on Node': word('Failed to remove post on Node'),
    // _signedRequest (letInToEvent, reportAbuse): no community set, no key, and a send that failed without a reason.
    'You are off-grid. Please connect to a BeanPool Node to perform this action.': word('You are off-grid. Please connect to a BeanPool Node to perform this action.'),
    'No identity found. You must be logged in.': word('No identity found. You must be logged in.'),
    'Network request failed. You must be connected to a node.': word('Network request failed. You must be connected to a node.'),
};

/** One of db.ts's sentences above in the member's language; a node's own words, or anything else, exactly as given. */
export function eventLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    // deletePost wraps every failure of its send: the reason is db.ts's own sentence, the node's words, or the platform's.
    const unreachable = english.match(/^Offline or anchor node unreachable: ([\s\S]*)$/);
    if (unreachable) return t('Offline or anchor node unreachable: {reason}', { reason: eventLineWords(unreachable[1]) });
    // _signedRequest: a refusal with no body at all.
    const status = english.match(/^Server returned (\d+)$/);
    if (status) return t('Server returned {status}', { status: status[1] });
    return english;
}
