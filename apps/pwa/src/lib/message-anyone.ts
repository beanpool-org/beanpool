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
 * line across from members alone, none from one it suspended, and nothing from one it removed), and the person is for certain
 * not in this community, by any of its names. Where that can't be said for certain nothing opens: `elsewhere`, the link to that
 * address the contact had before this slice.
 */
import { FIND_WORDS, acrossChatListed, messagePathFor, nodeHomeOf, saysNames, saysNoHome, t, whoseName, type KnownChat, type MessageLink, type MessagePath } from '@beanpool/core';
import { checkMembership, nodeAddress, type CommunityInfo, type Conversation, type ConversationsAnswer } from './api';
import { getBlocklistStatus, isUserBlocked, loadBlocklist } from './blocklist';
import { communityAnswerNow, communityInfoKept, inTime, namesHere } from './community-homes';
import { chatsShown, openChatFromCard, outsideContext } from './outside-mail';
import { standingFromRefusal } from './standing-refusal';

/** A chat the list shows here, as MessagesPage has it: a direct one is weighed by its people. */
export type HereChat = Pick<Conversation, 'id' | 'type' | 'participants'>;

/** The chats the list shows here: as the page has them, or how to ask for them (a tap before the list's first answer). */
export type ListedChats = readonly HereChat[] | (() => Promise<ConversationsAnswer>);

/** The chats in {@link ListedChats}; asked for, and no answer in time: none. */
async function chatsListed(listed: ListedChats): Promise<readonly HereChat[]> {
    if (typeof listed !== 'function') return listed;
    const got = await inTime(listed);
    return [...(got?.conversations ?? []), ...(got?.requests?.conversations ?? [])];
}

/** Whether Message refuses this person: on this community's list for the account, by any of `keys` (read first if it hasn't been). Throws when it can't be read, or isn't in time. */
async function blockedForMessage(keys: readonly string[]): Promise<boolean> {
    if (!getBlocklistStatus().loaded && await inTime(() => loadBlocklist()) === null) throw new Error('The block list was not read in time');
    return keys.some((k) => isUserBlocked(k));
}

/**
 * Whether the account is a member here whose line across this community takes, asked now: not one whose every request it
 * refuses (the account closed or retired here, or its key replaced: 403), nor one it says is suspended (`standing`: it answers
 * in the direct chats it has). Not known (no answer, or none in time): taken as one, as App does.
 */
async function memberHere(me: string): Promise<boolean> {
    const answer = await inTime(() => checkMembership(me).catch((e): Awaited<ReturnType<typeof checkMembership>> => {
        if (standingFromRefusal(e) || (e as { code?: unknown } | null)?.code === 'key_invalidated') return { isMember: false, callsign: null };
        throw e;
    }));
    return answer?.isMember !== false && answer?.standing !== 'suspended';
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
 * community, or across; `switch` where whose a link's address is can't be said for certain. What needs no asking decides
 * first; what that leaves uncertain is asked now, before anything but an existing chat is opened. Throws when the block list
 * can't be read.
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
    const kept = links.length && !blocked ? await communityInfoKept() : null;
    // Asked only where a chat across is weighed.
    const member = ctx && across.length ? await memberHere(ctx.identity.publicKey) : true;
    const pathBy = (answer?: CommunityInfo | null): MessagePath => {
        const info = answer ?? kept;
        return messagePathFor({
            links, chats, setTo: here || null, look: null, held: [], blocked,
            whose: whoseName(namesHere(kept, answer)),
            // Not read yet: its chats across still count (only a community that says it takes none is left out).
            takesAcross: () => member && (!info || acrossRefusal(info) === null),
        });
    };
    const certain = pathBy();
    if (certain.open === 'existing' || certain.open === 'blocked' || certain.open === 'nothing') return certain;
    const whose = whoseName(namesHere(kept));
    if (![...links.map((l) => l.community), ...across.map((c) => c.peerHome)].some((a) => whose(a).whose === 'uncertain')) return certain;
    return pathBy(await communityAnswerNow());
}

/** What became of an across chat asked for: opened (its id); the person is in this community after all (`here`, their key); or why not (`uncertain`: whose the address is can't be said). */
export type AcrossOpened = { chatId: string } | { here: string } | { refused: 'no-community' | 'off' | 'no-home' | 'not-member' | 'blocked' | 'uncertain' };

/**
 * A chat across made from a contact's link, as an address card makes one (outside-mail.ts openChatFromCard). Refused with no
 * account here, where this community doesn't take messages from other communities (or its info can't be read yet) or has no
 * address of its own to send from, for an account that is no member here or is suspended, or for someone the account blocked;
 * nothing is made then. Nor when the link's address is one of this community's own names (asked now): the chat here is theirs,
 * and its server refuses every line across to one of them. Nor when that can't be said for certain.
 */
export async function openAcrossOnWeb(target: { key: string; home: string; name: string | null }): Promise<AcrossOpened> {
    const ctx = await outsideContext().catch(() => null);
    if (!ctx) return { refused: 'no-community' };
    const answer = await communityAnswerNow();
    const kept = saysNames(answer) ? null : await communityInfoKept();
    const { whose } = whoseName(namesHere(kept, answer))(target.home);
    if (whose === 'one') return { here: target.key };
    if (whose === 'uncertain') return { refused: 'uncertain' };
    const refused = acrossRefusal(answer ?? kept);
    if (refused) return { refused };
    if (!(await memberHere(ctx.identity.publicKey))) return { refused: 'not-member' };
    const chatId = await openChatFromCard(ctx, { key: target.key, home: target.home, name: target.name });
    return chatId ? { chatId } : { refused: 'blocked' };
}

/**
 * What Message on a contact in another community does (MessagesPage): a chat here with `dm`, a chat across by its id, a
 * refusal in the member's words, or nothing but the address to go to (`elsewhere`: Contacts then shows the link to it).
 */
export type MessageDone = { dm: string } | { across: string } | { refused: string } | { elsewhere: string };

/** The refusal Message says for someone blocked, on every path and on both apps (the phone's contacts and New message say it too). */
const BLOCKED_WORDS = () => t('You have blocked this user. Messaging is disabled.');

/**
 * Message on a contact in another community, from this browser ({@link messagePathOnWeb}, then the chat across made or
 * refused): never a tap that does nothing. `links`: every community the contact names them in, the one tapped first (a chat
 * across is made from it); the block is asked by every key they name. `listed`: the chats the list shows here. A block list
 * or a community that can't be read says to try again. Contacts' Message waits for this, so every read in it has the one
 * deadline (lib/community-homes.ts inTime), the page's list among them.
 */
export async function messageOnWeb(links: ReadonlyArray<{ key: string; community: string }>, name: string, listed: ListedChats = []): Promise<MessageDone> {
    const direct = await chatsListed(listed);
    const path = await messagePathOnWeb(links.map((l) => ({ community: l.community, key: l.key, name })), direct).catch(() => null);
    if (!path) return { refused: t("Couldn't reach your community. Check your connection and try again.") };
    if (path.open === 'blocked') return { refused: BLOCKED_WORDS() };
    if (path.open === 'shared') return { dm: path.key };
    if (path.open === 'existing') return path.chat.kind === 'across' ? { across: path.chat.id } : { dm: path.chat.key };
    if (path.open === 'nothing') return { refused: t('Please try again.') };
    if (path.open === 'switch') return { elsewhere: path.community };
    const opened = await openAcrossOnWeb(path).catch(() => ({ refused: 'no-community' as const }));
    if ('chatId' in opened) return { across: opened.chatId };
    if ('here' in opened) return { dm: opened.here };
    if (opened.refused === 'uncertain') return { elsewhere: links.find((l) => nodeHomeOf(l.community) === path.home)?.community ?? `https://${path.home}` };
    return {
        refused: opened.refused === 'off' ? t("This community doesn't take messages from other communities.")
            : opened.refused === 'no-home' ? t("This community's server knows none of its own names yet, so it can't send to another community.")
            : opened.refused === 'not-member' ? t(FIND_WORDS.notAMember)
                : opened.refused === 'blocked' ? BLOCKED_WORDS() : t("Couldn't reach your community. Check your connection and try again."),
    };
}
