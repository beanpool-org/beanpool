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
