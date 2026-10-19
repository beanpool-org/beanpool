/**
 * The phone's own sentences an event's page shows from utils/db.ts, in the member's language (words S3l).
 *
 * utils/db.ts signs the RSVP, the cancel, the let-in, the report, the reminder and the event itself with the member's
 * key, so it never reaches the words layer: what rsvpEvent, deletePost, letInToEvent and reportAbuse (_signedRequest),
 * setEventReminder, createPost and updateEvent throw as written is worded again here as word() keys and looked up by the
 * exact sentence where components/EventDetail.tsx, EventExtras.tsx and NewEventModal.tsx show it; _signedRequest's are
 * components/signed-request-lines.ts's, which this hands on to. db.ts is not touched. A node's own words (a refusal's
 * reason) are shown exactly as given (slice S4). utils/__tests__/events-words-render.test.ts holds each to the throw in
 * db.ts it stands for.
 */
import { t, word, type WordKey } from '@beanpool/core';
import { UNSIGNABLE_RSVP_MESSAGE } from '../utils/events';
import { signedRequestWords } from './signed-request-lines';

const FIXED: Readonly<Record<string, WordKey>> = {
    // rsvpEvent: an id the phone won't sign for, no community set, no key, and a refusal without the node's words.
    [UNSIGNABLE_RSVP_MESSAGE]: UNSIGNABLE_RSVP_MESSAGE,
    'You are currently offline.': word('You are currently offline.'),
    'No identity found.': word('No identity found.'),
    'Could not save your RSVP': word('Could not save your RSVP'),
    // setEventReminder: the same two as rsvpEvent, and a refusal without the node's words.
    'Could not save your reminder': word('Could not save your reminder'),
    // createPost: no community set (no key is rsvpEvent's), a refusal without the node's words, and a send that failed
    // without a reason. updateEvent throws rsvpEvent's "No identity found." and _signedRequest's.
    'You are currently offline. Please connect to a BeanPool Node to broadcast your post.': word('You are currently offline. Please connect to a BeanPool Node to broadcast your post.'),
    'Network request failed or server rejected the post.': word('Network request failed or server rejected the post.'),
    'Network request failed. You must be connected to a node to post.': word('Network request failed. You must be connected to a node to post.'),
    // deletePost: no community set, no key, and a refusal without the node's words (inside "Offline or …", below).
    'Action requires internet connection.': word('Action requires internet connection.'),
    'Not logged in. Identity required.': word('Not logged in. Identity required.'),
    'Failed to remove post on Node': word('Failed to remove post on Node'),
};

/** One of db.ts's sentences above, or _signedRequest's, in the member's language; a node's own words exactly as given. */
export function eventLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    // deletePost wraps every failure of its send: the reason is db.ts's own sentence, the node's words, or the platform's.
    const unreachable = english.match(/^Offline or anchor node unreachable: ([\s\S]*)$/);
    if (unreachable) return t('Offline or anchor node unreachable: {reason}', { reason: eventLineWords(unreachable[1]) });
    // _signedRequest (letInToEvent, reportAbuse, updateEvent): its own sentences, or what it doesn't know as given.
    return signedRequestWords(english);
}
