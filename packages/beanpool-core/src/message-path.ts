/**
 * Which chat Message opens (slice S5 part 2, "Message anyone": scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3
 * "Which path a new chat takes"; Marty 19 Nov 2026, "yes to all 5"). One rule for every Message on both apps: a contact's,
 * a profile's, a New message result's. One thread per person wherever possible:
 *
 * 1. **An existing chat wins.** A direct chat with them in the community the device is set to (one the member only looks at
 *    as a guest included: the chat a visitor has there is theirs to write in), else in another community it holds (in the
 *    order it lists them), else a chat across with them. Same key, same person.
 * 2. **Else the community you share**: the one the device is set to first, else another it holds as a member.
 * 3. **Else across**: a chat with them in a community the device shares none with, made from the contact's link (their
 *    key, the address of their community as other servers name it, their name), through the member's own server.
 *
 * **The invariant** (#3354 review, round 4: each round had found one more chat Message opened that no line could go from):
 * Message never opens, picks as the existing chat, or makes a chat the member can't write in now. A direct chat is writable
 * where the member is (a community that removed them is none the device holds: the app leaves it out of `held`). A chat
 * across is only while all three hold, and {@link messagePathFor} asks them of every one: Chat lists it ({@link
 * acrossChatListed}); the community that carries it takes messages from other communities and has an address
 * of its own to send from (`takesAcross`; community-homes.ts saysNoHome); and its person is for certain in none of the
 * communities the device shares with them (`whose`: community-homes.ts whoseName, the address card's rule). Its carrier
 * refuses every line to one of its own names for good, and in another the direct chat there is the one to write in. A chat
 * across that fails stays in Chat as it is. And a message never silently goes to no one (rounds 5 and 6): an address whose
 * community isn't known for certain opens nothing here, neither a direct chat nor one across. Message then offers what the
 * contact offered before it (`switch`): to go to that address.
 *
 * It replaces "Open {community} ›" and the switch question. The web holds one community (`held` empty), so a contact in any
 * other goes across there.
 *
 * A block is asked first, before any of these (#3354 review): someone the account blocked is refused on every path, an
 * existing chat included, with the same words on both apps. Each app reads its own lists (`blocked`) and hands in only the
 * chats its chat list shows ({@link acrossChatListed} for a chat across), so nothing a block hid is reopened, and no chat
 * across the member declined is opened as "the existing chat": its thread has no composer and no Accept.
 */
import type { WhoseName } from './community-homes.js';
import { nodeHomeOf } from './node-request-signing.js';
import type { OutsideChatState } from './outside-chat.js';
import { word } from './words.js';

/**
 * Whether Chat lists a chat across, so Message may open it as the existing chat (#3354 review, round 3): an open one among
 * the chats, a request behind the Requests row. A declined one is listed nowhere and its thread can't be written in, so it
 * is no existing chat: Message goes on to the community shared, or across, which reopens it as an address card does.
 */
export function acrossChatListed(state: OutsideChatState): boolean {
    return state === 'open' || state === 'request';
}

/** A person as Message knows them: each community they are a member of, as the contact or result names it, with their key there. */
export interface MessageLink {
    community: string;
    key: string;
    /** The name the contact or result shows (an across chat is named with it until their own line names them). */
    name?: string | null;
    /** The app has its own reason not to know where this link's person is: its address then counts as uncertain. */
    doubted?: boolean;
}

/**
 * A chat the device already has: direct, in a community it holds; or across, kept in a community's file (null: the one set
 * to), with the home its lines go to (`home`: the person's, as their last line, their card or a link named it).
 */
export type KnownChat =
    | { kind: 'direct'; community: string; id: string; key: string }
    | { kind: 'across'; community: string | null; id: string; key: string; home: string | null };

export type MessagePath =
    | { open: 'existing'; chat: KnownChat }
    | { open: 'shared'; community: string; key: string }
    | { open: 'across'; key: string; home: string; name: string | null }
    | { open: 'switch'; community: string }
    | { open: 'blocked' }
    | { open: 'nothing' };

/**
 * Where Message on a person goes ({@link MessagePath}). `setTo`: the community the device is set to as a member (null: none,
 * a guest's look). `look`: the one it is set to as a guest only: the direct chats the member has there count, and nothing
 * else of it does. `held`: the other communities it holds as a member, in the order it lists them (the web: none). `whose`:
 * which of those an address is a name of, none of them, or not known for certain (community-homes.ts whoseName). `chats`:
 * every chat the device's chat list shows that may be with this person (a chat across only when {@link acrossChatListed}), its
 * `community` as `setTo`, `look` or `held` has it; only those under one of `links`' keys count, and a direct one only in one
 * of those. `takesAcross`: whether a community takes messages from other communities and can send to one, as far as the
 * device knows. `blocked`: the app's block rule for this person, by any of `links`' keys (the phone: on its own list, Marty
 * 22 Nov, the S7 rule; the web: on this community's list); asked before anything, so no path opens. `switch`: nothing is
 * certain, so nothing opens; the app offers to go to that address. `nothing`: no link (not on BeanPool yet), or across to
 * an address that isn't one.
 */
export function messagePathFor(input: {
    links: readonly MessageLink[];
    chats: readonly KnownChat[];
    setTo: string | null;
    look: string | null;
    held: readonly string[];
    whose: (address: string | null | undefined) => WhoseName;
    takesAcross: (community: string) => boolean;
    blocked: boolean;
}): MessagePath {
    const { links, chats, setTo, look, held, whose, takesAcross } = input;
    if (links.length === 0) return { open: 'nothing' };
    // 0. A block first: no chat opens, an existing one included (a chat a block hid stays hidden).
    if (input.blocked) return { open: 'blocked' };
    const keys = new Set(links.map((l) => l.key));
    const theirs = chats.filter((c) => keys.has(c.key));
    const shared = [...(setTo ? [setTo] : []), ...held];
    const isShared = (community: string | null): community is string => community !== null && shared.includes(community);
    const whoseLink = (l: MessageLink): WhoseName => (l.doubted ? { whose: 'uncertain' } : whose(l.community));
    const sharedOf = (name: WhoseName): string | null => (name.whose === 'one' && isShared(name.community) ? name.community : null);
    // 1. An existing chat: direct where the device is set to (a guest's look too), then in a held community (the held order) ...
    for (const community of [setTo ?? look, ...held]) {
        const there = community ? theirs.find((c) => c.kind === 'direct' && c.community === community) : undefined;
        if (there) return { open: 'existing', chat: there };
    }
    // ... then across, only one that can be written in now (the invariant above), the set-to community's file first.
    const across = theirs.flatMap((c) => {
        const carriedBy = c.kind === 'across' ? c.community ?? setTo : null;
        return c.kind === 'across' && isShared(carriedBy) ? [{ chat: c, carriedBy }] : [];
    });
    const writable = across.filter(({ chat, carriedBy }) => {
        const name = whose(chat.home);
        return takesAcross(carriedBy) && name.whose !== 'uncertain' && sharedOf(name) === null;
    });
    const acrossChat = writable.find((c) => c.carriedBy === setTo) ?? writable[0];
    if (acrossChat) return { open: 'existing', chat: acrossChat.chat };
    // 2. The community you share, the one set to first, then the held ones in order: named by a link; or, when no link names
    // one, by the home of a chat across with them (their own server's, or their card's, word that they are there).
    for (const community of shared) {
        const link = links.find((l) => sharedOf(whoseLink(l)) === community);
        if (link) return { open: 'shared', community, key: link.key };
    }
    for (const community of shared) {
        const there = across.find(({ chat }) => sharedOf(whose(chat.home)) === community);
        if (there) return { open: 'shared', community, key: there.chat.key };
    }
    // 3. Across, from the contact's first link that is for certain in none of them: never to one of their names.
    const away = links.find((l) => whoseLink(l).whose !== 'uncertain' && nodeHomeOf(l.community) !== null);
    if (away) return { open: 'across', key: away.key, home: nodeHomeOf(away.community)!, name: away.name?.trim() || null };
    // Nothing is certain: nothing opens (the invariant). The app offers to go to the address itself.
    const unsure = links.find((l) => whoseLink(l).whose === 'uncertain');
    return unsure ? { open: 'switch', community: unsure.community } : { open: 'nothing' };
}

/**
 * Under the first line of a chat across to someone who has not let the member in (DESIGN §3 "Member-facing words"). Core's,
 * so the phone and the web say it the same.
 */
export const ACROSS_FIRST_LINE_NOTE = word('They will see this if they take messages from other communities.');

/**
 * The line the note goes under, or null: the member's first line in a chat across in which the other person has written
 * nothing yet. A sender can't know whether they were let in (a request waits, a door is closed, a block is hidden alike: the
 * hold of Delivered, Marty 22 Nov 2026), so "has not let you in" reads as "no line of theirs here yet". Never in a chat
 * brought back from 12 words (`restored`): its earlier lines, theirs among them, are on another phone.
 */
export function acrossFirstLineNoteUnder(lines: readonly { id: string; author: string }[], me: string, restored = false): string | null {
    if (restored || lines.some((l) => l.author !== me)) return null;
    return lines.find((l) => l.author === me)?.id ?? null;
}
