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
 * Characters that show nothing and that no name is spelled with anywhere: every format character (Unicode's Cf: the soft
 * hyphen, the zero-width space, the direction marks, embeddings, overrides and isolates, the word joiner and invisible
 * operators, the byte-order mark, the interlinear annotation marks, the language tag, the Arabic, Syriac, Kaithi, Egyptian,
 * shorthand and musical format marks) but the two joiners and the tag characters, which spell real names and go only
 * where they spell nothing (below); the combining grapheme joiner, the Khmer inherent vowels and the Hangul fillers. Written
 * out, never as a Unicode property escape (\p{Cf}): core loads at app start on old Android engines, where those throw
 * (search-terms.ts). A test checks every \p{Cf} as Node knows it (name-line.test.ts).
 */
// eslint-disable-next-line no-misleading-character-class -- these characters are what it removes
const INVISIBLE = /[\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u115F\u1160\u17B4\u17B5\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{110BD}\u{110CD}\u{13430}-\u{1343F}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}]/gu;

/**
 * The tag characters (U+E0020 to U+E007F), kept only as a flag's own: the black flag, a region's code in tag letters and
 * digits (2 to 7 of them), the cancel tag, as Scotland's, Wales' and England's flags are written. Every other one goes.
 */
const TAGS = /(\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,7}\u{E007F})|[\u{E0020}-\u{E007F}]/gu;
const TAG = /[\u{E0020}-\u{E007F}]/u;
/** The zero-width non-joiner and joiner: Persian and Urdu spell names with the first, emoji and Indic conjuncts with the second. */
const JOINER = /[\u200C\u200D]/u;
/** The variation selectors, which pick how the character before them looks: an emoji's or a text's, a kanji's form. */
const SELECTOR = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
/** The Indic viramas: a joiner after one makes a half form or a chillu, at a word's end too (Malayalam's older spelling). */
const VIRAMA = /[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D3B\u0D3C\u0D4D\u0DCA]/u;
/** One space of its own kind between two words is kept as written: a no-break space, Japanese's ideographic space. */
const ONE_SPACE = /^[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$/u;

/** A character that shows: none of the above, and no space. */
function shows(ch: string | undefined): boolean {
    return ch !== undefined && !/\s/u.test(ch) && !JOINER.test(ch) && !SELECTOR.test(ch) && !TAG.test(ch);
}

/**
 * A person's name as it is read and shown: a name a person really writes, in any script or emoji, reads exactly as it is
 * written, and only padding and spoofing go (#3275 round 4). Taken out: the characters that show nothing (above); a tag
 * character outside a flag; a variation selector that isn't the one straight after a character that shows; a joiner that
 * isn't one alone between two characters that show (a selector on the first counts with it), or straight after a virama.
 * So runs of them go, and any at either end or beside a space. Each run of spaces is made one (a single no-break or
 * ideographic space stays as written), and the name is trimmed. "Ana" padded with zero-width spaces or joiners, or wrapped
 * in a right-to-left override, reads "Ana" however long it was; "Sam" with a rainbow flag, a Persian surname with its
 * non-joiner and a Malayalam chillu read as written. An address card's name is this (outside-chat.ts addressCardName),
 * and so is every guest's line. Reading it again changes nothing.
 */
export function cleanName(name: unknown): string {
    if (typeof name !== 'string') return '';
    const chars = Array.from(name.replace(INVISIBLE, '').replace(TAGS, (_tag: string, flag: string | undefined) => flag ?? ''));
    const kept = chars.filter((ch, i) => {
        const before = chars[i - 1], after = chars[i + 1];
        if (SELECTOR.test(ch)) return shows(before);
        if (!JOINER.test(ch)) return true;
        const joined = shows(before) || (before !== undefined && SELECTOR.test(before) && shows(chars[i - 2]));
        if (!joined || (after !== undefined && JOINER.test(after))) return false;
        return shows(after) || VIRAMA.test(before!);
    });
    return kept.join('').replace(/\s+/g, (run) => (ONE_SPACE.test(run) ? run : ' ')).trim();
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
 * "…" (never fewer than its first character and "…"). Characters are whole code points, so no emoji is split in two halves;
 * a cut inside an emoji's sequence or a flag's tags keeps what of it reads clean (a joiner with nothing after it goes), so a
 * place passing the cut name on reads it unchanged.
 */
export function clipName(name: unknown, max: number = NAME_LINE_CHARS): string {
    const chars = Array.from(cleanName(name));
    const room = Math.max(2, Math.floor(max));
    return chars.length <= room ? chars.join('') : `${cleanName(chars.slice(0, room - 1).join(''))}…`;
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
