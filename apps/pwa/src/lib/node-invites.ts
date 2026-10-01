/**
 * Whether members make invites on this node (`features.invites` in `/api/community/info`, config/node-profile.ts on the
 * server). Off on the global node (Marty, 2026-10-01): anyone joins it with a sign-in, one sign-in one member, and the
 * server refuses every invite there. Only a node that says outright it makes none makes none: every node before the
 * switch took them. Where they are off the Invites page offers the community's plain link to share, and nothing else.
 */

import type { CommunityInfo } from './api';

export function invitesOn(info: CommunityInfo | null | undefined): boolean {
    return (info?.features as { invites?: boolean } | undefined)?.invites !== false;
}

/** What the share sends: the community's plain address, which opens its front door. No code rides along. */
export function communityLinkText(origin: string): string {
    return `Join me on BeanPool: ${origin.trim().replace(/\/+$/, '')}`;
}

/** Said where the node's own words are missing. */
export const INVITES_OFF_FALLBACK = 'This community doesn’t use invites: anyone joins it with a sign-in in the BeanPool app. To bring someone here, share its link.';

/**
 * The node's words when it refused a generate because it takes no invites (404 `feature_off`, as `request` throws it in
 * lib/api.ts), or null for any other failure. Read so the page says so instead of making an offline ticket, which the
 * node would refuse just the same.
 */
export function invitesOffRefusal(e: unknown): string | null {
    const err = e as { status?: unknown; code?: unknown; message?: unknown } | null | undefined;
    if (!err || typeof err !== 'object' || err.status !== 404 || err.code !== 'feature_off') return null;
    return typeof err.message === 'string' && err.message.trim() ? err.message : INVITES_OFF_FALLBACK;
}
