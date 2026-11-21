/**
 * Message anyone, on the web (slice S5 part 2: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, §6 row S5; Marty
 * 19 Nov 2026, "yes to all 5"). The web holds one community, its own address, so Message on a contact in any other goes
 * across, made from the contact's link, unless a chat across with them is already here: core's one rule
 * (@beanpool/core message-path.ts messagePathFor) with no held community. A contact in this community is messaged here as
 * before (MessagesPage handleStartDm, which opens an existing chat).
 *
 * A block is asked first, on every path (#3354 review): someone on this community's list for the account is refused, an
 * existing chat across included, and the chats weighed are only those the chat list shows (lib/outside-mail.ts chatsShown),
 * so nothing a block hid is reopened. Someone unblocked since is messaged as anyone is (only a held Delivered asks that).
 */
import { messagePathFor, t, type MessageLink, type MessagePath } from '@beanpool/core';
import { nodeAddress } from './api';
import { getBlocklistStatus, isUserBlocked, loadBlocklist } from './blocklist';
import { sameOrigin } from './contact-invite-names';
import { chatsShown, openChatFromCard, outsideContext, outsideMessagesHere } from './outside-mail';

/** Whether Message refuses this person: on this community's list for the account, by any of `keys` (read first if it hasn't been). Throws when it can't be read. */
async function blockedForMessage(keys: readonly string[]): Promise<boolean> {
    if (!getBlocklistStatus().loaded) await loadBlocklist();
    return keys.some((k) => isUserBlocked(k));
}

/** Where Message on a person goes from this browser: the block first, then an across chat the list shows, this community, or across. Throws when the block list can't be read. */
export async function messagePathOnWeb(links: readonly MessageLink[]): Promise<MessagePath> {
    const blocked = links.length > 0 && await blockedForMessage(links.map((l) => l.key));
    const ctx = blocked ? null : await outsideContext().catch(() => null);
    const across = ctx ? await chatsShown(ctx).catch(() => []) : [];
    return messagePathFor({
        links,
        chats: across.map((c) => ({ kind: 'across' as const, community: null, id: c.id, key: c.peerKey })),
        setTo: nodeAddress() || null,
        held: [],
        same: sameOrigin,
        blocked,
    });
}

/** What became of an across chat asked for: opened (its id), or why not. */
export type AcrossOpened = { chatId: string } | { refused: 'no-community' | 'off' | 'blocked' };

/**
 * A chat across made from a contact's link, as an address card makes one (outside-mail.ts openChatFromCard). Refused with no
 * account here, where this community doesn't take messages from other communities (or its info can't be read yet), or for
 * someone the account blocked; nothing is made then.
 */
export async function openAcrossOnWeb(target: { key: string; home: string; name: string | null }): Promise<AcrossOpened> {
    const ctx = await outsideContext().catch(() => null);
    if (!ctx) return { refused: 'no-community' };
    if ((await outsideMessagesHere().catch(() => null)) !== true) return { refused: 'off' };
    const chatId = await openChatFromCard(ctx, { key: target.key, home: target.home, name: target.name });
    return chatId ? { chatId } : { refused: 'blocked' };
}

/** What Message on a contact in another community does (MessagesPage): a chat here with `dm`, a chat across by its id, or a refusal in the member's words. */
export type MessageDone = { dm: string } | { across: string } | { refused: string };

/** The refusal Message says for someone blocked, on every path and on both apps (the phone's contacts and New message say it too). */
const BLOCKED_WORDS = () => t('You have blocked this user. Messaging is disabled.');

/**
 * Message on a contact in another community, from this browser ({@link messagePathOnWeb}, then the chat across made or
 * refused): never a tap that does nothing. A block list or a community that can't be read says to try again.
 */
export async function messageOnWeb(link: { key: string; community: string }, name: string): Promise<MessageDone> {
    const path = await messagePathOnWeb([{ community: link.community, key: link.key, name }]).catch(() => null);
    if (!path) return { refused: t("Couldn't reach your community. Check your connection and try again.") };
    if (path.open === 'blocked') return { refused: BLOCKED_WORDS() };
    if (path.open === 'shared') return { dm: path.key };
    if (path.open === 'existing') return path.chat.kind === 'across' ? { across: path.chat.id } : { dm: path.chat.key };
    if (path.open === 'nothing') return { refused: t('Please try again.') };
    const opened = await openAcrossOnWeb(path).catch(() => ({ refused: 'no-community' as const }));
    if ('chatId' in opened) return { across: opened.chatId };
    return {
        refused: opened.refused === 'off' ? t("This community doesn't take messages from other communities.")
            : opened.refused === 'blocked' ? BLOCKED_WORDS() : t("Couldn't reach your community. Check your connection and try again."),
    };
}
