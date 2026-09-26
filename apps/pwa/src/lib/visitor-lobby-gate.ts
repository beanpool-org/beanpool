/**
 * Whether App shows a key-less visitor the global lobby (design G9a §7, G9b) or the welcome page: the node's own word
 * (`/api/community/info`), and nothing part way through a join or a restore in this browser.
 */

import { getCommunityInfo, type CommunityInfo } from './api';
import { loadInviteSent, loadPendingJoin } from './identity';
import { captureAuthReturn } from './web-join';

let infoOnce: Promise<CommunityInfo> | null = null;

/**
 * `/api/community/info`, read once per page load and shared: the lobby's decision, and a member's composer note. A
 * failed read is not kept, so the next caller asks again.
 */
export function communityInfoOnce(): Promise<CommunityInfo> {
    if (!infoOnce) {
        infoOnce = getCommunityInfo().catch((e) => {
            infoOnce = null;
            throw e;
        });
    }
    return infoOnce;
}

/** Tests only: forget the shared read, as a new page load would. */
export function resetCommunityInfoOnce(): void {
    infoOnce = null;
}

/**
 * Whether this browser is part way through joining or getting an account back: a sign-in coming back, an invite in
 * the address, a join key waiting (sent or not), or a key an invite went with. Then the welcome page opens at once,
 * as it always has, and settles it; the lobby is for a browser with nothing in flight. A store that can't be read is
 * taken as something in flight: the welcome page reads it again and says what it finds.
 */
export async function joinInFlight(): Promise<boolean> {
    if (captureAuthReturn()) return true;
    try {
        if (new URLSearchParams(window.location.search).get('invite')) return true;
    } catch { /* no address to read */ }
    try {
        const [pending, invite] = await Promise.all([loadPendingJoin(), loadInviteSent()]);
        return !!pending || !!invite;
    } catch {
        return true;
    }
}
