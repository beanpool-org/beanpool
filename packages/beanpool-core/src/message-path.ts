/**
 * Which chat Message opens (slice S5 part 2, "Message anyone": scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3
 * "Which path a new chat takes"; Marty 19 Nov 2026, "yes to all 5"). One rule for every Message on both apps: a contact's,
 * a profile's, a New message result's. One thread per person wherever possible:
 *
 * 1. **An existing chat wins.** A direct chat with them in the community the device is set to, else in another community
 *    it holds (in the order it lists them), else a chat across with them. Same key, same person.
 * 2. **Else the community you share**: the one the device is set to first, else another it holds as a member.
 * 3. **Else across**: a chat with them in a community the device shares none with, made from the contact's link (their
 *    key, the address of their community as other servers name it, their name), through the member's own server.
 *
 * It replaces "Open {community} ›" and the switch question. The web holds one community (`held` empty), so a contact in any
 * other goes across there.
 *
 * A block is asked first, before any of these (#3354 review): someone the account blocked is refused on every path, an
 * existing chat included, with the same words on both apps. Each app reads its own lists (`blocked`) and hands in only the
 * chats its chat list shows, so nothing a block hid is reopened.
 */
import { nodeHomeOf } from './node-request-signing.js';
import { word } from './words.js';

/** A person as Message knows them: each community they are a member of, as the contact or result names it, with their key there. */
export interface MessageLink {
    community: string;
    key: string;
    /** The name the contact or result shows (an across chat is named with it until their own line names them). */
    name?: string | null;
}

/** A chat the device already has: direct, in a community it holds; or across, kept in a community's file (null: the one set to). */
export type KnownChat =
    | { kind: 'direct'; community: string; id: string; key: string }
    | { kind: 'across'; community: string | null; id: string; key: string };

export type MessagePath =
    | { open: 'existing'; chat: KnownChat }
    | { open: 'shared'; community: string; key: string }
    | { open: 'across'; key: string; home: string; name: string | null }
    | { open: 'blocked' }
    | { open: 'nothing' };

/**
 * Where Message on a person goes ({@link MessagePath}). `setTo`: the community the device is set to (null: none, a guest's
 * look). `held`: the other communities it holds as a member, in the order it lists them (the web: none). `same`: whether
 * two spellings name one community (the apps' own rule). `chats`: every chat the device has that may be with this person;
 * only those under one of `links`' keys count, and a direct one only in `setTo` or a community in `held`. `blocked`: the
 * app's block rule for this person, by any of `links`' keys (the phone: blocked anywhere it holds; the web: on this
 * community's list); asked before anything, so no path opens. `nothing`: no link (not on BeanPool yet), or across to an
 * address that isn't one.
 */
export function messagePathFor(input: {
    links: readonly MessageLink[];
    chats: readonly KnownChat[];
    setTo: string | null;
    held: readonly string[];
    same: (a: string, b: string) => boolean;
    blocked: boolean;
}): MessagePath {
    const { links, chats, setTo, held, same } = input;
    if (links.length === 0) return { open: 'nothing' };
    // 0. A block first: no chat opens, an existing one included (a chat a block hid stays hidden).
    if (input.blocked) return { open: 'blocked' };
    const keys = new Set(links.map((l) => l.key));
    const theirs = chats.filter((c) => keys.has(c.key));
    const isSetTo = (c: string | null) => c === null || (!!setTo && same(c, setTo));
    // 1. An existing chat: direct here, direct in a held community (the held order), then across (the set-to file first).
    const directHere = setTo ? theirs.find((c) => c.kind === 'direct' && same(c.community, setTo)) : undefined;
    if (directHere) return { open: 'existing', chat: directHere };
    for (const community of held) {
        const there = theirs.find((c) => c.kind === 'direct' && same(c.community, community));
        if (there) return { open: 'existing', chat: there };
    }
    const across = theirs.filter((c) => c.kind === 'across');
    const acrossChat = across.find((c) => isSetTo(c.community)) ?? across.find((c) => c.community !== null && held.some((h) => same(h, c.community as string)));
    if (acrossChat) return { open: 'existing', chat: acrossChat };
    // 2. The community you share: the one set to first, then the held ones in order.
    const linkHere = setTo ? links.find((l) => same(l.community, setTo)) : undefined;
    if (linkHere && setTo) return { open: 'shared', community: setTo, key: linkHere.key };
    for (const community of held) {
        const link = links.find((l) => same(l.community, community));
        if (link) return { open: 'shared', community, key: link.key };
    }
    // 3. Across, from the contact's first link.
    const first = links[0];
    const home = nodeHomeOf(first.community);
    if (!home) return { open: 'nothing' };
    return { open: 'across', key: first.key, home, name: first.name?.trim() || null };
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
