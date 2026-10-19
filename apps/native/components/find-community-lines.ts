/**
 * The phone's own sentences Find a community shows from the layers below it, in the member's language (words S3l).
 *
 * utils/community-directory.ts and utils/knock.ts sign what they send with the member's key, so their fixed English
 * (DIRECTORY_MESSAGES, the knock form's checks, "already a member") is worded again here as word() keys and looked up by
 * the exact sentence where it is shown; KNOCK_MESSAGES are word() keys already. utils/typed-place.ts's lines likewise.
 * None of those files is touched. A community's or the worldwide node's own words are shown exactly as given (slice S4).
 * utils/__tests__/find-community-lines.test.ts holds each to the constant or builder it stands for.
 */
import { FIND_TOWN_SEARCH_WORDS, t, tn, word, type AddressSearchWords, type WordKey } from '@beanpool/core';
import { KNOCK_CALLSIGN_CHARS, KNOCK_MESSAGES, KNOCK_MESSAGE_CHARS } from '../utils/knock';
import type { TypedPlace } from '../utils/typed-place';

const FIXED: Readonly<Record<string, WordKey>> = {
    // utils/community-directory.ts DIRECTORY_MESSAGES.
    'Finding communities works on the worldwide community only.': word('Finding communities works on the worldwide community only.'),
    "Couldn't reach the worldwide community. Check your connection and try again.": word("Couldn't reach the worldwide community. Check your connection and try again."),
    'The worldwide community sent an answer this app could not read. Please try again later.': word('The worldwide community sent an answer this app could not read. Please try again later.'),
    // utils/knock.ts sendKnock: a member already, when the community said so with no words of its own.
    'You are already a member of this community.': word('You are already a member of this community.'),
    // utils/knock.ts knockFormProblem (the two with a limit are below).
    'Please give a name of at least 2 characters.': word('Please give a name of at least 2 characters.'),
    'Please say a few words about yourself.': word('Please say a few words about yourself.'),
    // utils/typed-place.ts LOCATION_NOTES.
    'Location is off for BeanPool. Type your town instead, or search by name below.': word('Location is off for BeanPool. Type your town instead, or search by name below.'),
    "Couldn't find where you are. Type your town instead, or search by name below.": word("Couldn't find where you are. Type your town instead, or search by name below."),
};

/** One of the phone's sentences above (or a KNOCK_MESSAGES note) in the member's language; anything else exactly as given. */
export function findLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    const said = (Object.keys(KNOCK_MESSAGES) as Array<keyof typeof KNOCK_MESSAGES>).find((k) => KNOCK_MESSAGES[k] === english);
    if (said) return t(KNOCK_MESSAGES[said]);
    if (english === `Please keep your name to ${KNOCK_CALLSIGN_CHARS} characters.`) {
        return tn(KNOCK_CALLSIGN_CHARS, 'Please keep your name to {n} character.', 'Please keep your name to {n} characters.');
    }
    if (english === `Please keep your message to ${KNOCK_MESSAGE_CHARS} characters.`) {
        return tn(KNOCK_MESSAGE_CHARS, 'Please keep your message to {n} character.', 'Please keep your message to {n} characters.');
    }
    return english;
}

/** utils/typed-place.ts nearLine: "Near Mullumbimby", or the place with no name. */
export function nearWords(p: TypedPlace): string {
    return p.name ? t('Near {name}', { name: p.name }) : t('Near the place you typed');
}

/** core's FIND_TOWN_SEARCH_WORDS as the town search draws them, in the member's language. */
export function findTownSearchWords(): AddressSearchWords {
    return {
        label: t(FIND_TOWN_SEARCH_WORDS.label),
        placeholder: t(FIND_TOWN_SEARCH_WORDS.placeholder),
        unavailable: t(FIND_TOWN_SEARCH_WORDS.unavailable),
        noMatches: t(FIND_TOWN_SEARCH_WORDS.noMatches),
        source: t(FIND_TOWN_SEARCH_WORDS.source),
        pickLabel: FIND_TOWN_SEARCH_WORDS.pickLabel,
    };
}
