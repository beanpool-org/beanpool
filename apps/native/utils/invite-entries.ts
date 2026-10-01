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

/**
 * Said to a guest (a phone with an account elsewhere that added this community) of the global community once it has said
 * its door is open: the way in is the door, with the account on this phone (app/join-global.tsx), under this button.
 */
export const GUEST_DOOR_TEXT = 'You are visiting as a guest. Join as the account on this phone: sign in once and choose your name. Your key and your 12 words stay the same, and nothing changes in your other communities.';
export const GUEST_DOOR_BUTTON = '🌍 Join with a sign-in';

/**
 * Said to a guest on a node that takes no invites where no door is offered: a node other than the global community (the
 * door is the global community's alone), or the global community before it has said, this app start, that its door is
 * open. There is no code to enter here, so no form, and no promise of a way in that isn't there.
 */
export const GUEST_NO_INVITES_TEXT = 'This community doesn’t use invite codes, and it isn’t open to new members from the app right now. Check your connection and try again later.';
