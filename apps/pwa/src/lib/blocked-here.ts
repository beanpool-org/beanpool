/**
 * The sentence a block made in the web app adds to its confirmation (slice S7b, scratch/fable-design/DESIGN-s7-blocks-verified-
 * everywhere-fable.md §3.4; Marty, 21 Nov 2026, "all four of Fable's picks", question 2). A block made here is this community's:
 * its own list keeps it (lib/blocklist.ts, routes/blocks.ts). The phone app reads that list back and, for now, only stops
 * letting that person in quietly and hides their message requests; a block made on the phone holds in every community on it.
 * So the member is told where this one holds, and how to hold it everywhere.
 */
import { communityCardName, t } from '@beanpool/core';
import { ownCommunityAddress, ownCommunityCardOnce } from './join-names';

/** "Blocked in {community}. …" for a community named `community`. */
export function blockedHereWords(community: string): string {
    return t('Blocked in {community}. To block them in all your communities, block them in the phone app.', { community });
}

/**
 * {@link blockedHereWords} for this community: its own name from its public card, else the address the page is served from.
 * Never throws: the block is done when this is asked, and a card that can't be read only changes the name.
 */
export async function blockedHereSentence(): Promise<string> {
    let card: Awaited<ReturnType<typeof ownCommunityCardOnce>> = null;
    try {
        card = await ownCommunityCardOnce();
    } catch {
        card = null;
    }
    return blockedHereWords(card ? communityCardName(card, { t }) : ownCommunityAddress());
}
