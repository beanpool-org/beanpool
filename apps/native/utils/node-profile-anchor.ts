/**
 * Which community a screen's node profile belongs to (utils/use-node-profile.ts). The tabs stay mounted when the
 * phone changes community (Settings, a deep link, joining another one), so the profile a screen holds must name
 * the community it was read for: a profile for any other one is never shown, not even while the new one's is
 * still on its way.
 *
 * No imports but types: the hook's React and storage stay out of this, so it runs under vitest as it is.
 */

import type { NodeProfile } from './node-profile';

export interface AnchoredNodeProfile {
    /** The phone's community (`beanpool_anchor_url`) this was read for; null before the first read, or with none. */
    url: string | null;
    /** Null while unknown, which every reader treats as a local community (Beans on). */
    profile: NodeProfile | null;
}

export const UNKNOWN_NODE_PROFILE: AnchoredNodeProfile = { url: null, profile: null };

/**
 * The screen came into view and read the phone's community. The same one keeps what it has; any other one (or
 * none) starts from unknown, before its own copy is read.
 */
export function anchorRead(state: AnchoredNodeProfile, url: string | null): AnchoredNodeProfile {
    return state.url === url ? state : { url, profile: null };
}

/**
 * A profile for `url` arrived (the phone's copy or the node's answer). It is shown only while the phone is still
 * on that community; a missing one changes nothing.
 */
export function profileArrived(state: AnchoredNodeProfile, url: string, profile: NodeProfile | null): AnchoredNodeProfile {
    return profile && state.url === url ? { url, profile } : state;
}
