
/**
 * A poll's typed Other (Marty, 2 Nov: "if the answer isnt in the 4 answers you can do an other"), one set of rules for the
 * node and both apps. The maker chooses whether a poll offers it. Everyone who can see the poll sees how many chose Other;
 * the words reach only the poll's maker and the owners (apps/server engine/poll-other.ts).
 *
 * An anonymous poll that offers Other is sealed: the node keeps that a member has answered and, with nothing leading from one
 * to the other, what was answered. So the answer is final (nothing can find it to change it), and the node can't say which it
 * was: only the phone it was given on remembers, in its own cache. Its words show only once it has closed, in no order of arrival, so a person
 * who was seen answering at a certain moment can't be matched to a line.
 */

import { t } from './words.js';

/** A typed answer at most: a sentence, the length of a poll's question. Enough to say what's missing, too short for a story that names its teller. */
export const POLL_OTHER_WORDS_MAX = 140;

/** poll_votes.option_id on a sealed poll: says the member has answered, and nothing of how. */
export const POLL_BALLOT_SEALED = 'sealed';

/** The option that is Other, or null. Only the node marks one. */
export function pollOtherOption<T extends { other?: unknown }>(options: readonly T[] | null | undefined): T | null {
    return options?.find(o => o?.other === true) ?? null;
}

/** Whether this poll's ballots are sealed: it offers Other and it is anonymous. */
export function pollIsSealed(options: readonly { other?: unknown }[] | null | undefined, openVote: unknown): boolean {
    return pollOtherOption(options) !== null && openVote !== true && openVote !== 1;
}

/**
 * A typed answer as it is kept: one line, with control and direction-changing characters gone, trimmed. Empty when nothing
 * is left. Length is the caller's to hold, on what this returns. Not U+200C or U+200D, which the words of some scripts and
 * emoji are written with (tags/free-tags.ts).
 */
export function cleanPollOtherWords(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return raw
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028-\u202F\u2066-\u206F\uFEFF]+/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();
}

/** Both apps' words around Other, in one place, so the two say the same. */
export const pollOtherLines = {
    other: () => t('Other'),
    placeholder: () => t('Your answer'),
    noName: () => t("Don't put your name"),
    send: () => t('Send my answer'),
    cancel: () => t('Cancel'),
    sealedNote: () => t('Your answer is final: nothing links it to you, so it cannot be changed.'),
    answered: () => t('You have answered this poll.'),
    tick: () => t('Offer "Other" with a typed answer'),
    tickHint: () => t("Members can write their own answer. Everyone sees how many chose Other; only you and the community's owners read the words."),
    tickHintAnonymous: () => t('On an anonymous poll each answer is final, and the words show once the poll closes.'),
    readWords: () => t('Read the typed answers'),
    wordsHeld: () => t('The typed answers show here once the poll closes.'),
    wordsNone: () => t('No typed answers to read.'),
    wordsWho: () => t("Only the poll's maker and the owners can read these."),
    report: () => t('Report'),
    reported: () => t('Reported'),
    remove: () => t('Remove'),
    wordsFailed: () => t('The typed answers could not be read.'),
    removeConfirm: () => t('Remove this typed answer? The vote still counts.'),
} as const;
