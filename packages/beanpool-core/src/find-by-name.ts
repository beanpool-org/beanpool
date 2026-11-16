/**
 * Finding someone in another community by their exact name, when they said yes (slice N1, was F1 in
 * scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.6 and §11; renamed in DESIGN-forums-messaging-joint-fable.md §1
 * item 13). The parts both apps and the server share; the server's half is apps/server/src/engine/find-by-name.ts.
 *
 * A member turns on "People in other communities can find me by name" (off until they do). Their app hands their own
 * community their address card (outside-chat.ts), signed by their key; their community keeps it while the switch is on. Then
 * someone in another community picks this community, types the name exactly, and gets that card, or the one answer
 * {@link FIND_NOBODY}: the same words, the same bytes from the server, for no such member, one who didn't say yes, one who
 * blocked the asker, one who left, and an asker past their day's look-ups at the other end. So nobody can map a community's
 * members, and global introduces communities, never people.
 *
 * The asker's community counts their look-ups (FIND_BY_NAME_PER_DAY a day) and asks the other community in a request it
 * signs (node-request-signing.ts, X1); the other community counts them too, and answers.
 */
import { addressCardName, addressCardVerifies, type AddressCard } from './outside-chat.js';
import { word } from './words.js';

/** Look-ups one member may make in a day, counted at their own community and again at each community they ask. */
export const FIND_BY_NAME_PER_DAY = 10;

/** The path one community's server asks another's on, signed by its server key: `{ v: 1, asker, name }`. */
export const RELAY_FIND_PATH = '/api/relay/find';

/** The other community's answer for every "nobody", in its exact bytes: no field says why. */
export const FIND_NOBODY_BODY = '{"v":1,"card":null}';

/**
 * A typed name as it is looked up: runs of spaces made one, trimmed at both ends, as an address card writes a name. Letter
 * case is the server's name rule (@beanpool/engine foldName: the one rule by which two names on a community are the same).
 * Nothing else is forgiven: a part of a name, a missing letter or a dropped accent is another name. Null for text no card
 * could carry (empty, past 60 characters, a line break).
 */
export function findTypedName(name: unknown): string | null {
    if (typeof name !== 'string') return null;
    return addressCardName(name.replace(/\s+/g, ' '));
}

/**
 * The card in another community's answer (`{ v: 1, card }`), when it is a card signed by the key it names; else null. Never
 * throws. Whether it carries the name asked is the asker's server's check (it holds the name rule).
 */
export function readFindAnswer(json: unknown): AddressCard | null {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    const a = json as { v?: unknown; card?: unknown };
    if (a.v !== 1 || !addressCardVerifies(a.card)) return null;
    const c = a.card as AddressCard;
    return { v: 1, key: c.key, home: c.home, name: c.name, sig: c.sig };
}

// ── Words both apps show (and the server's answers) ────────────────────────────────────────

/** The member's switch, in Settings on the phone and on the web's card page. Off until they turn it on. */
export const FIND_ME_SWITCH = word('People in other communities can find me by name');
/** Under the switch. */
export const FIND_ME_HELP = word('Someone in another community who types your exact name gets your address card, and can send you a message request. Nobody can see a list of names.');
/** The one answer for every "nobody". */
export const FIND_NOBODY = word('Nobody by that name takes messages here.');
/** The asker's own community refuses past FIND_BY_NAME_PER_DAY. */
export const FIND_DAY_USED = word("You've looked up as many names as you can today. Try again tomorrow.");
/** The other community could not be asked (unreachable, or its answer wasn't one). */
export const FIND_NOT_REACHED = word("That community couldn't be asked just now. Try again later.");
/** The community picked is the asker's own. */
export const FIND_OWN_COMMUNITY = word("That's your own community: write to them here.");
/** The address typed is no community's. */
export const FIND_BAD_COMMUNITY = word("That isn't a community's address.");
/** The name typed is none a card could carry. */
export const FIND_BAD_NAME = word('Type their name as they use it, up to 60 characters.');
