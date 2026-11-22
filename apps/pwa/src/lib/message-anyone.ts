/**
 * Message anyone, on the web (slice S5 part 2: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, §6 row S5; Marty
 * 19 Nov 2026, "yes to all 5"). The web holds one community, its own address, so Message on a contact in any other goes
 * across, made from the contact's link, unless a chat with them is already here, direct or across: core's one rule
 * (@beanpool/core message-path.ts messagePathFor) with no held community. A contact in this community, by any of its
 * addresses (lib/community-homes.ts), is messaged here (MessagesPage handleStartDm, which opens an existing chat).
 *
 * A block is asked first, on every path (#3354 review): someone on this community's list for the account, by any key the
 * contact's links name them by (as the phone asks), is refused, an existing chat across included, and the chats weighed are
 * only those the chat list shows (lib/outside-mail.ts chatsShown, open or a request: core acrossChatListed), so nothing a
 * block hid is reopened, and a chat across the member declined (no composer, no Accept) is no existing chat: this community
 * opens, or across reopens it as the address card does. Someone unblocked since is messaged as anyone is (only a held
 * Delivered asks that).
 *
 * Nothing it opens or makes is a chat the member can't write in now (#3354 review round 4, the rule's own invariant), and no
 * message goes to no one: a chat across counts, and one is made, only while this community takes messages from other
 * communities, has an address of its own to send from (core saysNoHome), this account is a member here (its server takes a
 * line across from members alone), and the person is not in this community by any of its addresses.
 */
import { FIND_WORDS, acrossChatListed, messagePathFor, saysNoHome, t, type KnownChat, type MessageLink, type MessagePath } from '@beanpool/core';
import { checkMembership, nodeAddress, type CommunityInfo, type Conversation } from './api';
import { getBlocklistStatus, isUserBlocked, loadBlocklist } from './blocklist';
import { communityInfoKept, communityInfoNow, inTime, namedHere } from './community-homes';
import { chatsShown, openChatFromCard, outsideContext } from './outside-mail';

/** A chat the list shows here, as MessagesPage has it: a direct one is weighed by its people. */
export type HereChat = Pick<Conversation, 'id' | 'type' | 'participants'>;

/** Whether Message refuses this person: on this community's list for the account, by any of `keys` (read first if it hasn't been). Throws when it can't be read. */
async function blockedForMessage(keys: readonly string[]): Promise<boolean> {
    if (!getBlocklistStatus().loaded) await loadBlocklist();
    return keys.some((k) => isUserBlocked(k));
}

/** Whether the account is a member here, asked now. Not known (no answer, or none in time): taken as one, as App does. */
async function memberHere(me: string): Promise<boolean> {
    return (await inTime(() => checkMembership(me)))?.isMember !== false;
}

/**
 * Why this community takes no messages across, by its info, or null: its switch is off (not read: taken as off), or it says it
 * has no address of its own (its server answers every send 503, so a line would stay "Sending…").
 */
function acrossRefusal(info: CommunityInfo | null): 'off' | 'no-home' | null {
    if ((info?.features as { outsideMessages?: unknown } | undefined)?.outsideMessages !== true) return 'off';
    return saysNoHome(info) ? 'no-home' : null;
}

/**
 * Where Message on a person goes from this browser: the block first, then a chat here already (a direct one among `direct`,
 * the chats the list shows; else one across the list shows, open or a request, that can be written in now), this
 * community, or across. Throws when the block list can't be read.
 */
export async function messagePathOnWeb(links: readonly MessageLink[], direct: readonly HereChat[] = []): Promise<MessagePath> {
    const here = nodeAddress();
    const keys = new Set(links.map((l) => l.key));
    const blocked = links.length > 0 && await blockedForMessage([...keys]);
    const ctx = blocked ? null : await outsideContext().catch(() => null);
    const across = (ctx ? await chatsShown(ctx).catch(() => []) : []).filter((c) => keys.has(c.peerKey) && acrossChatListed(c.state));
    const chats: KnownChat[] = [
        ...direct.filter((c) => c.type === 'dm').flatMap((c) => (c.participants ?? []).filter((k) => keys.has(k))
            .map((key) => ({ kind: 'direct' as const, community: here, id: c.id, key }))),
        ...across.map((c) => ({ kind: 'across' as const, community: null, id: c.id, key: c.peerKey, home: c.peerHome })),
    ];
    const info = links.length && !blocked ? await communityInfoKept() : null;
    // Asked only where a chat across is weighed. Not read yet: its chats across still count (only a community that says it takes none is left out).
    const takesAcross = ctx && across.length ? (!info || acrossRefusal(info) === null) && await memberHere(ctx.identity.publicKey) : true;
    return messagePathFor({
        links, chats, setTo: here || null, look: null, held: [], blocked,
        whose: namedHere(info),
        takesAcross: () => takesAcross,
    });
}

/** What became of an across chat asked for: opened (its id); the person is in this community after all (`here`, their key); or why not. */
export type AcrossOpened = { chatId: string } | { here: string } | { refused: 'no-community' | 'off' | 'no-home' | 'not-member' | 'blocked' };

/**
 * A chat across made from a contact's link, as an address card makes one (outside-mail.ts openChatFromCard). Refused with no
 * account here, where this community doesn't take messages from other communities (or its info can't be read yet) or has no
 * address of its own to send from, for an account that is no member here, or for someone the account blocked; nothing is made
 * then. Nor when the link's address is one of this community's own (its info asked now): the chat here is theirs, and its
 * server refuses every line across to one of its own names.
 */
export async function openAcrossOnWeb(target: { key: string; home: string; name: string | null }): Promise<AcrossOpened> {
    const ctx = await outsideContext().catch(() => null);
    if (!ctx) return { refused: 'no-community' };
    const info = await communityInfoNow();
    if (namedHere(info)(target.home) !== null) return { here: target.key };
    const refused = acrossRefusal(info);
    if (refused) return { refused };
    if (!(await memberHere(ctx.identity.publicKey))) return { refused: 'not-member' };
    const chatId = await openChatFromCard(ctx, { key: target.key, home: target.home, name: target.name });
    return chatId ? { chatId } : { refused: 'blocked' };
}

/** What Message on a contact in another community does (MessagesPage): a chat here with `dm`, a chat across by its id, or a refusal in the member's words. */
export type MessageDone = { dm: string } | { across: string } | { refused: string };

/** The refusal Message says for someone blocked, on every path and on both apps (the phone's contacts and New message say it too). */
const BLOCKED_WORDS = () => t('You have blocked this user. Messaging is disabled.');

/**
 * Message on a contact in another community, from this browser ({@link messagePathOnWeb}, then the chat across made or
 * refused): never a tap that does nothing. `links`: every community the contact names them in, the one tapped first (a chat
 * across is made from it); the block is asked by every key they name. `direct`: the chats the list shows here. A block list
 * or a community that can't be read says to try again.
 */
export async function messageOnWeb(links: ReadonlyArray<{ key: string; community: string }>, name: string, direct: readonly HereChat[] = []): Promise<MessageDone> {
    const path = await messagePathOnWeb(links.map((l) => ({ community: l.community, key: l.key, name })), direct).catch(() => null);
    if (!path) return { refused: t("Couldn't reach your community. Check your connection and try again.") };
    if (path.open === 'blocked') return { refused: BLOCKED_WORDS() };
    if (path.open === 'shared') return { dm: path.key };
    if (path.open === 'existing') return path.chat.kind === 'across' ? { across: path.chat.id } : { dm: path.chat.key };
    if (path.open === 'nothing') return { refused: t('Please try again.') };
    const opened = await openAcrossOnWeb(path).catch(() => ({ refused: 'no-community' as const }));
    if ('chatId' in opened) return { across: opened.chatId };
    if ('here' in opened) return { dm: opened.here };
    return {
        refused: opened.refused === 'off' ? t("This community doesn't take messages from other communities.")
            : opened.refused === 'no-home' ? t("This community's server knows none of its own names yet, so it can't send to another community.")
            : opened.refused === 'not-member' ? t(FIND_WORDS.notAMember)
                : opened.refused === 'blocked' ? BLOCKED_WORDS() : t("Couldn't reach your community. Check your connection and try again."),
    };
}
