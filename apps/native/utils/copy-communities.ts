/**
 * The member's list of communities inside their sign-in copy (vault rethink VR5; scratch/fable-design/
 * DESIGN-vault-rethink-fable.md §3 item 5, Marty's picks of 27 Oct, pick 9: on unless the member unticks it).
 *
 * The 12 words bring back the key, never where the member belongs. So when the member leaves the tick beside Protect
 * with on (components/KeeperProtectionPanel.tsx), the copy a connect makes carries this phone's communities, name and
 * address only, at most 20, sealed inside the copy (@beanpool/core packCopyCommunities, sealSeedToSso): whoever can open
 * the copy can read it, and nobody else; the vault and the community store it without reading it. A restore from such a
 * copy offers those communities to open the account in, and saves them on the new phone.
 *
 * Off, the copy is exactly what it was before lists. A copy made before lists restores exactly as before.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { copyCommunityUrl, type CopyCommunity } from '@beanpool/core';
import { addSavedNode, getSavedNodes } from './nodes';
import { isPlainNodeAddress } from './node-url';
import { copyListsCommunitiesStoreKey } from './storage-keys';

/** Whether a copy made for this account carries its list of communities: on unless the member turned it off. */
export async function copyListsCommunities(publicKey: string): Promise<boolean> {
    try {
        return (await AsyncStorage.getItem(copyListsCommunitiesStoreKey(publicKey))) !== '0';
    } catch {
        return true;
    }
}

/**
 * The member's tick, remembered for the next time it is drawn. Applies to the next copy made where it is drawn (a connect,
 * or Connect again); nothing already kept changes. It never sends a list by itself: the screen that drew the tick hands
 * what it showed to the sheet (`communitiesForCopy`).
 */
export async function setCopyListsCommunities(publicKey: string, on: boolean): Promise<void> {
    await AsyncStorage.setItem(copyListsCommunitiesStoreKey(publicKey), on ? '1' : '0').catch(() => {});
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * This phone's communities, as a copy would list them: the one the phone is on first, then the rest as saved, each by
 * the name the phone shows for it. Name and address only. Never throws: a phone that can't read its list sends none.
 */
export async function communitiesOnPhoneForCopy(): Promise<CopyCommunity[]> {
    try {
        const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
        const saved = await getSavedNodes();
        const ordered = [...saved.filter((n) => n?.url === anchor), ...saved.filter((n) => n?.url !== anchor)];
        return ordered
            .filter((n) => n && typeof n.url === 'string' && isPlainNodeAddress(n.url))
            .map((n) => ({ name: n.alias?.trim() || hostOf(n.url), url: n.url }));
    } catch {
        return [];
    }
}

/**
 * The list a connect seals into the copy: this phone's communities when the member chose it in the flow that opened the
 * sheet (the tick on screen, left on), else null (no list: the copy is as before lists). Only that choice counts, never
 * the stored tick alone: a screen that draws no tick (Settings' move card, welcome's claim-flow Add a sign-in) passes none.
 */
export async function communitiesForCopy(chosen: boolean | undefined): Promise<CopyCommunity[] | null> {
    if (chosen !== true) return null;
    const list = await communitiesOnPhoneForCopy();
    return list.length ? list : null;
}

/**
 * After a restore from a copy that carried a list: each community in it that this phone hasn't saved, saved by its name,
 * so the member finds their communities on the new phone. Only plain community addresses (node-url.ts); a community
 * already saved keeps the name this phone gave it. Never throws, and never fails the restore. Returns how many it added.
 */
export async function saveCommunitiesFromCopy(
    list: readonly CopyCommunity[] | null | undefined,
    registerPush: () => Promise<unknown> = async () => (await import('../services/push-notifications')).retryPushRegistrations(),
): Promise<number> {
    if (!list?.length) return 0;
    let added = 0;
    try {
        const saved = new Set((await getSavedNodes()).map((n) => n.url.toLowerCase()));
        for (const c of list) {
            // A community's address and nothing more (core copyCommunityUrl: no path, no user part), and plain for the phone.
            const url = copyCommunityUrl(c?.url);
            if (!url || !isPlainNodeAddress(url) || saved.has(url.toLowerCase())) continue;
            try {
                await addSavedNode(url, c.name?.trim() || undefined);
                saved.add(url.toLowerCase());
                added++;
            } catch {
                // Not a plain address after all: skipped, the rest still saved.
            }
        }
    } catch (e) {
        console.log(`[RESTORE] the copy's list of communities could not be saved: ${(e as Error).message}`);
    }
    // The member's communities are back: so are their alerts (utils/push-registrations.ts). Without an account on the
    // phone yet this does nothing, and the account's own registration covers them as it arrives.
    if (added > 0) void registerPush().catch(() => {});
    return added;
}
