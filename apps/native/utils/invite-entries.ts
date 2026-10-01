/**
 * People → Invites on a node that takes no invites (`features.invites === false`: the worldwide community,
 * apps/server config/node-profile.ts). Anyone joins it with a sign-in, so there is nothing to make: no code, no QR, no
 * offline ticket. What's left is the community's own link to share, a plain address and no more (design §1: "a link
 * is just marketing"). Every local community, and a node too old to say, as before (node-profile.ts invitesOn).
 */

/** What the share sheet sends: the community's plain address, which opens its front door. */
export function communityLinkMessage(nodeUrl: string): string {
    return `Join me on BeanPool: ${nodeUrl.trim().replace(/\/+$/, '')}`;
}

/** Said where the node's own words are missing. */
export const INVITES_OFF_FALLBACK = 'This community doesn’t use invites: anyone joins it with a sign-in in the BeanPool app. To bring someone here, share its link.';

/**
 * The node's answer to a generate when it takes no invites (404 `feature_off`), in its own words, or null for any
 * other answer. A phone that hadn't heard the switch yet (an old copy of the node's profile) asks anyway; this stops
 * the screen falling back to an offline ticket, which the node would refuse just the same.
 */
export function invitesOffRefusal(status: number, body: unknown): string | null {
    const b = body as { code?: unknown; error?: unknown } | null | undefined;
    if (status !== 404 || !b || typeof b !== 'object' || b.code !== 'feature_off') return null;
    return typeof b.error === 'string' && b.error.trim() ? b.error : INVITES_OFF_FALLBACK;
}
