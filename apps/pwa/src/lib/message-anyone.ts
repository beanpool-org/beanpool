/**
 * Message anyone, on the web (slice S5 part 2: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, §6 row S5; Marty
 * 19 Nov 2026, "yes to all 5"). The web holds one community, its own address, so Message on a contact in any other goes
 * across, made from the contact's link, unless a chat across with them is already here: core's one rule
 * (@beanpool/core message-path.ts messagePathFor) with no held community. A contact in this community is messaged here as
 * before (MessagesPage handleStartDm, which opens an existing chat).
 */
import { messagePathFor, type MessageLink, type MessagePath } from '@beanpool/core';
import { nodeAddress } from './api';
import { sameOrigin } from './contact-invite-names';
import { openChatFromCard, outsideContext, outsideMessagesHere } from './outside-mail';

/** Where Message on a person goes from this browser: an across chat already here, this community, or across. */
export async function messagePathOnWeb(links: readonly MessageLink[]): Promise<MessagePath> {
    const ctx = await outsideContext().catch(() => null);
    const across = ctx ? await ctx.store.chats(ctx.identity.publicKey).catch(() => []) : [];
    return messagePathFor({
        links,
        chats: across.map((c) => ({ kind: 'across' as const, community: null, id: c.id, key: c.peerKey })),
        setTo: nodeAddress() || null,
        held: [],
        same: sameOrigin,
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
