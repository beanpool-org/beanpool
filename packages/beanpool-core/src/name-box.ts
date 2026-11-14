/**
 * A name box that holds no name (Marty, 14 Nov 2026, card callsign-link-guard: "Yes, both apps"). On 5 Sep a member pasted
 * her invite link into the name box, and her account on Byron is named "https://mullum.beanpool.org/?inv…". Every name
 * box on both apps (joining, the open door, a claim, asking to join, the profile, Settings) and every node route that
 * writes a name refuse the same two things, read here once:
 *
 *   - an invite: the code the invite step reads (invite-text.ts inviteCodeIn: a link's `invite=`, an `INV-xxxx-xxxx`
 *     or `BP-xxxx-xxxx` anywhere, a whole long `BP-` ticket), with or without its link;
 *   - a web address: a scheme (`https://`, any `x://`), `www.`, a host with a path, a host on a common ending (a
 *     community's `byron.beanpool.org`, `example.com`) or a bare IPv4 address.
 *
 * A name with a dot in it stays a name ("J.R. Smith", "St.Kilda", "Dr.Who"): a dot alone is no address. Names already
 * held are never changed (no conversion code): only a new name, or a change of one, is refused.
 */
import { inviteCodeIn } from './invite-text.js';
import { t, word, type WordKey } from './words.js';

/** The node's code for a refused name (with the sentence in `message`/`error`): an old app or a script reads it. */
export const CALLSIGN_LINK_CODE = 'callsign_link';

export const NAME_BOX_WORDS = {
    inviteLink: word('That looks like an invite link: it goes in the invite box, not your name.'),
    inviteCode: word('That looks like an invite code: it goes in the invite box, not your name.'),
    webLink: word('That looks like a web address: your name can’t be a link.'),
} as const;

/** What a name box held instead of a name: the keys of {@link NAME_BOX_WORDS}, so a screen says `t(NAME_BOX_WORDS[kind])`. */
export type NotAName = keyof typeof NAME_BOX_WORDS;

/** Endings a name never has after a dot, so a host on one reads as an address. Short on purpose: no `.me` or `.de`. */
const HOST_ENDINGS = 'com|org|net|io|app|dev|info|biz|xyz|site|online|link|au|nz|uk';

/**
 * How much of a name box's text {@link notANameIn} reads, after its leading spaces. That covers the longest name a node
 * keeps (32 characters), with room to spare for a whole Share message pasted into the box, in any language (its link,
 * code and community address, so a pasted invite is still found and moved). A node reads a name from a request body of
 * up to 2 MB, from anyone who may join, so no pattern ever reads more than this (review of #3122: a 150,000-character
 * name held one node's every request for 11.9 s). A node keeps at most 32 characters of a name, from its first one or
 * from after its leading spaces, so what it keeps lies within what was read. Asking to join also drops control
 * characters and runs of spaces from inside a name, so it reads the name it keeps again (routes/knocks.ts).
 */
export const NAME_BOX_READ_CHARS = 2000;

/**
 * What makes text an address rather than a name (see the header). Read case-insensitively. Every part reads a bounded
 * number of characters from where it starts, so the time grows with the text's length, never its square. A scheme is
 * read for at most 32 characters, where an unbounded one read each run of letters to its end from every letter in it.
 * A longer scheme is still found, by its last 32 characters, as every start is tried.
 */
const WEB_ADDRESS = new RegExp([
    String.raw`[a-z][a-z0-9+.-]{0,31}:\/\/`,
    String.raw`(?:^|[^a-z0-9])www\.`,
    String.raw`[a-z0-9-]\.[a-z]{2,}(?::\d{1,5})?\/`,
    String.raw`[a-z0-9-]\.(?:${HOST_ENDINGS})(?![a-z0-9])`,
    String.raw`(?:^|[^0-9.])\d{1,3}(?:\.\d{1,3}){3}(?![0-9])`,
].join('|'), 'i');

/** Whether `text` has a web address in it, read whole: in time that grows with its length (a name box cuts it first). */
export function hasWebAddress(text: string): boolean {
    return WEB_ADDRESS.test(text);
}

/**
 * Whether `raw` holds an invite or a web address instead of a name, and which; null for a name (or nothing typed). Reads
 * its first {@link NAME_BOX_READ_CHARS} characters after any leading spaces, so a huge paste or request costs no more
 * than that.
 */
export function notANameIn(raw: string | null | undefined): NotAName | null {
    const text = String(raw ?? '').trimStart().slice(0, NAME_BOX_READ_CHARS);
    if (!text.trim()) return null;
    const address = hasWebAddress(text);
    if (inviteCodeIn(text) !== null) return address ? 'inviteLink' : 'inviteCode';
    return address ? 'webLink' : null;
}

/** The English sentence for what {@link notANameIn} found: the node's `word()`, translated on its way out. */
export function notANameWords(kind: NotAName): WordKey {
    return NAME_BOX_WORDS[kind];
}

/** The one line a name box shows when `raw` is no name, in the reader's language; null when it is a name. */
export function notANameLine(raw: string | null | undefined): string | null {
    const kind = notANameIn(raw);
    return kind ? t(NAME_BOX_WORDS[kind]) : null;
}

/**
 * The text to move into the invite box when a name box was given an invite (the paste as it came, for the invite box's
 * own reading: its code and the community it names), else null. A web address with no invite in it stays where it was,
 * refused.
 */
export function inviteForInviteBox(raw: string | null | undefined): string | null {
    const kind = notANameIn(raw);
    return kind === 'inviteLink' || kind === 'inviteCode' ? String(raw ?? '').trim() : null;
}
