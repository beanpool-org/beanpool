/**
 * The address Settings' "Use BeanPool on a computer: open <address>" row tells a member to open (computer-line, round 4).
 *
 * The community's MAIN address (mainAddressToOpen in core: what the community last said of its own names) only when this phone
 * would take a Link a device code from it, and the phone's own address otherwise. The next row down, Link a device, reads the
 * code the computer's page shows and sends the account only to a server the phone already uses: the community it is on, or one
 * in its saved list (utils/pair-device-target.ts transferTarget). A Byron member whose phone is still on mullum.beanpool.org and
 * has never saved byron.beanpool.org was told to open byron, whose page's code Link a device then refused: "This code is for
 * byron.beanpool.org. Your phone uses mullum.beanpool.org" (the deciding review of round 3, 13 Nov 2026). So the row asks
 * transferTarget itself, the very function Link a device asks, and the two cannot disagree.
 *
 * Display only: which node the phone talks to is never changed.
 */
import { addressToOpenOnAComputer, mainAddressToOpen, type CommunityOwnAddresses } from '@beanpool/core';
import { transferTarget } from './pair-device-target';

/**
 * @param anchor the community this phone is on (`beanpool_anchor_url`, utils/node-post.ts anchorUrl)
 * @param info what that community last said of its own names, as the phone kept it (utils/node-profile.ts getCachedNodeProfile)
 * @param savedNodeUrls the phone's saved communities (utils/nodes.ts getSavedNodes), as Link a device reads them
 * @returns an http(s) origin, or null when the anchor is no address (then there is no row)
 */
export function computerAddressForThisPhone(
    anchor: string | null | undefined,
    info: CommunityOwnAddresses | null | undefined,
    savedNodeUrls: readonly string[],
): string | null {
    const own = addressToOpenOnAComputer(anchor);
    const main = mainAddressToOpen(anchor, info);
    // No other main address (or none to weigh): the phone's own, as round 2 said it.
    if (!own || !main || main === own) return own;
    // A code the computer's page makes at `main` names it; Link a device takes it only when transferTarget says ok.
    return transferTarget(main, anchor ?? null, savedNodeUrls).kind === 'ok' ? main : own;
}
