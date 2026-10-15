/**
 * Whether a community wants people asked for, not read whole (`features.membersOnDemand`; lib/members-on-demand), and
 * each node's last answer to this browser. Kept apart so the page's one shared info read (lib/visitor-lobby-gate) keeps
 * the answer too, whatever screen asked first (review of #1861 fix round, F3).
 */
import { getNodeApiUrl, type CommunityInfo } from './api';

/**
 * Whether this community wants people asked for, not read whole. A node that doesn't say: no. Where anyone can join in a
 * minute (`openMembership`) the node refuses the whole directory with 403 `members_on_demand` (apps/server
 * routes/community.ts refusedWholeDirectory), whatever `membersOnDemand` says: asked for there too, the phone's rule
 * (review of #1999, NB3).
 */
export function membersOnDemandOn(info: CommunityInfo | null | undefined): boolean {
    return info?.features?.membersOnDemand === true || info?.features?.openMembership === true;
}

/** Where this browser keeps each node's last answer about the switch: `<prefix><node address>` = '1' or '0'. */
export const MEMBERS_ON_DEMAND_SEEN_PREFIX = 'bp_members_on_demand:';

function seenKey(): string {
    return MEMBERS_ON_DEMAND_SEEN_PREFIX + (getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : ''));
}

/** This node's last answer to this browser, or null when it never gave one (or the store can't be read). */
export function membersOnDemandLastSeen(): boolean | null {
    try {
        const v = localStorage.getItem(seenKey());
        return v === '1' ? true : v === '0' ? false : null;
    } catch {
        return null;
    }
}

/** Keeps the node's answer. Never throws: a store that can't be written leaves the page with its answer. */
export function noteMembersOnDemand(on: boolean): void {
    try { localStorage.setItem(seenKey(), on ? '1' : '0'); } catch { /* this page still has the answer */ }
}
