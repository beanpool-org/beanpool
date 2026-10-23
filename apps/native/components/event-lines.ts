/**
 * The phone's own sentences an event's page shows from utils/db.ts, in the member's language (words S3l).
 *
 * utils/db.ts signs the RSVP, the cancel, the let-in, the report, the reminder and the event itself with the member's
 * key, so it never reaches the words layer: what rsvpEvent, deletePost, setEventReminder and setEventDateCancelled throw
 * as written is worded again here as word() keys and looked up by the exact sentence where components/EventDetail.tsx,
 * EventExtras.tsx, EventCard.tsx, EventNextDates.tsx and NewEventModal.tsx show it; the sentences db.ts throws for every
 * signed send (no community set, no key; createPost's, updateEvent's, letInToEvent's and reportAbuse's) are
 * components/signed-request-lines.ts's, which this hands on to. db.ts is not touched. A node's own words (a refusal's
 * reason) are shown exactly as given (slice S4). utils/__tests__/events-words-render.test.ts holds each to the throw in
 * db.ts it stands for.
 */
import { t, word, type WordKey } from '@beanpool/core';
import { UNSIGNABLE_RSVP_MESSAGE } from '../utils/events';
import { signedRequestWords } from './signed-request-lines';

const FIXED: Readonly<Record<string, WordKey>> = {
    // rsvpEvent: an id the phone won't sign for, and a refusal without the node's words. Its "no community set" and "no
    // key" (as setEventReminder's, setEventDateCancelled's, updateEvent's and createPost's) are signed-request-lines'.
    [UNSIGNABLE_RSVP_MESSAGE]: UNSIGNABLE_RSVP_MESSAGE,
    'Could not save your RSVP': word('Could not save your RSVP'),
    // setEventReminder: a refusal without the node's words.
    'Could not save your reminder': word('Could not save your reminder'),
    // setEventDateCancelled (a repeating event's "Cancel this date"): a refusal without the node's words.
    'Could not change that date': word('Could not change that date'),
    // deletePost: no community set, and a refusal without the node's words (inside "Offline or …", below).
    'Action requires internet connection.': word('Action requires internet connection.'),
    'Failed to remove post on Node': word('Failed to remove post on Node'),
};

/** One of db.ts's sentences above, or _signedRequest's, in the member's language; a node's own words exactly as given. */
export function eventLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    // deletePost wraps every failure of its send: the reason is db.ts's own sentence, the node's words, or the platform's.
    const unreachable = english.match(/^Offline or anchor node unreachable: ([\s\S]*)$/);
    if (unreachable) return t('Offline or anchor node unreachable: {reason}', { reason: eventLineWords(unreachable[1]) });
    // db.ts's sentences for every signed send (createPost, updateEvent, letInToEvent, reportAbuse, …), or what it doesn't
    // know as given.
    return signedRequestWords(english);
}
