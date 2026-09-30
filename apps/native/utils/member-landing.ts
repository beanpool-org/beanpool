/**
 * Where the root guard (app/_layout.tsx) lands a member it finds on the welcome screen, or on the bare root, once they
 * have an identity.
 *
 * Always the tabs' index, except once: a screen that knows better says so before it sets the identity, and the guard's
 * next landing from welcome goes there instead. The screen must not navigate there itself. `router.replace` only queues
 * (expo-router's routing queue, run in a passive effect of its NavigationContainer, an ancestor of the root layout), so
 * in the commit that brings the identity the guard's own replace is queued behind the screen's and wins. PR #1357's
 * deciding review measured that: a vault build's community restore asked for Settings and landed on Home.
 *
 * Kept in memory for this run only, and read once.
 */

export type MemberLanding = '/(tabs)' | '/(tabs)/settings';

/** The tabs' index: every landing from welcome but the one a screen asked for. */
export const DEFAULT_MEMBER_LANDING: MemberLanding = '/(tabs)';

let next: MemberLanding | null = null;

/**
 * The guard's next landing from welcome goes to `to`. Call it before `setIdentity`, and don't navigate: the guard does.
 * Today only the welcome screen's community restore in a vault build uses it (Settings, whose first card is the move).
 */
export function landNextOn(to: MemberLanding): void {
    next = to;
}

/**
 * The root guard's last check, for a member with an identity whose node has not said otherwise: on welcome or the bare
 * root, where to go (a landing asked for with `landNextOn`, taken once, else the tabs' index). Anywhere else, null:
 * stay, and leave a landing asked for untouched.
 */
export function memberRedirect(segments: readonly string[]): MemberLanding | null {
    if (segments.length !== 0 && segments[0] !== 'welcome') return null;
    const to = next ?? DEFAULT_MEMBER_LANDING;
    next = null;
    return to;
}
