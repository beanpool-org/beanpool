/**
 * One way to write a person's name with where they are from, for both apps (DESIGN-forums-messaging-joint-fable.md §2.6, slice
 * F0): forum posts, message requests, chats with people from other communities, and guests in a group.
 *
 *   "Marty · Riverside"                        their community, proved (the signed note, slice F10, or a sealed envelope)
 *   "Asha · waiting to join"                   their own word: nothing checks it
 *   "Asha · Hillside · name not confirmed"     a community named but not proved
 *   "Dax · guest"                              a guest in a group (slice G1)
 *   "Marty"                                    no community shown
 *
 * On the worldwide forum the community shows only where the member switched it on; in an outside chat, on a message request
 * and as a guest it always shows (Marty, joint design question 3).
 */
import { t, word } from './words.js';

export type NameLineKind = 'name' | 'community' | 'waiting' | 'unconfirmed' | 'guest';

export interface NameLineInput {
    name: string;
    kind?: NameLineKind;
    /** The community's name, for `community` and `unconfirmed`. */
    community?: string | null;
}

const NAME_LINE_WORDS = Object.freeze({
    community: word('{name} · {community}'),
    waiting: word('{name} · waiting to join'),
    unconfirmed: word('{name} · {community} · name not confirmed'),
    guest: word('{name} · guest'),
});

/**
 * Characters that show nothing, which no name keeps: every format character (Unicode's Cf: the soft hyphen, zero-width
 * spaces, non-joiners and joiners, the direction marks, embeddings, overrides and isolates, the word joiner and invisible
 * operators, the byte-order mark, the interlinear annotation marks, the tag characters, the Arabic, Syriac, Kaithi,
 * Egyptian, shorthand and musical format marks), the combining grapheme joiner, the Khmer inherent vowels and the Hangul
 * fillers. Written out, never as a Unicode property escape (\p{Cf}): core loads at app start on old Android engines, where
 * those throw (search-terms.ts). A test checks the list against \p{Cf} as Node knows it (name-line.test.ts).
 */
// eslint-disable-next-line no-misleading-character-class -- these characters are what it removes
const INVISIBLE = /[­͏؀-؅؜۝܏࢐࢑࣢ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ﻿ﾠ￹-￻\u{110BD}\u{110CD}\u{13430}-\u{1343F}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}]/gu;

/**
 * A person's name as it is read and shown: the characters that show nothing taken out (above), each run of spaces made
 * one, trimmed. "Ana" padded with zero-width spaces, or wrapped in a right-to-left override, reads "Ana" and is "Ana",
 * however long it was. An address card's name is this (outside-chat.ts addressCardName), and so is every guest's line.
 */
export function cleanName(name: unknown): string {
    return typeof name === 'string' ? name.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim() : '';
}

/**
 * How many characters a person's name fills where a node serves it in a row or on a card (Home's cards, the moderators'
 * list): a longer one is cut to fit, "…" its last character. A guest's line fits it by cutting their card's name alone
 * (group-guest-chat.ts guestNameLine), never their community or "guest".
 */
export const NAME_LINE_CHARS = 60;

/**
 * The longest line a served name can be: a guest line under {@link NAME_LINE_CHARS} from the longest home a server can have
 * (253 characters and a port, 259), its card's name cut to its first character and "…", is 272 characters; the rest is room
 * for a longer word than "guest". A place that only passes on a name another place made (a list's last line, a report's
 * author) caps it here, with {@link servedName}, so it can never cut what the rule made.
 */
export const NAME_LINE_MAX = 300;

/**
 * `name` cleaned ({@link cleanName}) and, when it is longer than `max` characters, cut to `max`: its first `max - 1` and
 * "…" (never fewer than its first character and "…"). Characters are whole code points, so no emoji is split in two halves.
 */
export function clipName(name: unknown, max: number = NAME_LINE_CHARS): string {
    const chars = Array.from(cleanName(name));
    const room = Math.max(2, Math.floor(max));
    return chars.length <= room ? chars.join('') : `${chars.slice(0, room - 1).join('').trimEnd()}…`;
}

/**
 * A name another place made by the one rule ({@link clipName}, a guest's line by guestNameLine), as a place that passes it
 * on serves it: cleaned and capped at {@link NAME_LINE_MAX}, which cuts nothing the rule made, so a guest's line keeps
 * " · <their community> · guest" wherever it goes.
 */
export function servedName(name: unknown): string {
    return clipName(name, NAME_LINE_MAX);
}

/**
 * The line in the reader's language. A `community` or `unconfirmed` line with no community's name reads as the name alone,
 * so a missing label never shows a dangling " · ".
 */
export function nameLine(input: NameLineInput): string {
    const name = String(input.name ?? '').trim();
    const community = String(input.community ?? '').trim();
    switch (input.kind ?? 'name') {
        case 'community': return community ? t(NAME_LINE_WORDS.community, { name, community }) : name;
        case 'unconfirmed': return community ? t(NAME_LINE_WORDS.unconfirmed, { name, community }) : name;
        case 'waiting': return t(NAME_LINE_WORDS.waiting, { name });
        case 'guest': return t(NAME_LINE_WORDS.guest, { name });
        default: return name;
    }
}
