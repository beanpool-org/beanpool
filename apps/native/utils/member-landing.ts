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
 * Kept in memory for this run only, read once, and only for the account it was asked for: a landing left over (the
 * node called the restored key a stranger, so the guard never reached its landing) is dropped when another account, or
 * none, is on the phone, so a later account never lands on it (PR #1357 confirmation, N1).
 *
 * One more: a claim waiting for the phone's first account ({@link landOnClaim}) lands on the claim screen, ahead of both.
 */

/** The claim screen with a waiting claim's fields (utils/claim-link.ts `claimRouteFor`). */
export type ClaimLanding = `/claim-community${string}`;

export type MemberLanding = '/(tabs)' | '/(tabs)/settings' | ClaimLanding;

/** The tabs' index: every landing from welcome but the one a screen asked for. */
export const DEFAULT_MEMBER_LANDING: MemberLanding = '/(tabs)';

let next: { to: MemberLanding; publicKey: string | null } | null = null;
let claim: { to: ClaimLanding; until: number } | null = null;

/**
 * A claim waits for this phone's account (utils/onboarding-state.ts `PendingClaim`): until `until` (ms), every landing from
 * welcome goes to the claim screen instead of the tabs, for whichever account the phone makes. Not taken once, unlike
 * {@link landNextOn}: a restart part-way through still comes back to it, until the claim screen is up with the account and
 * takes it off the phone (onboarding-state.ts `handOverPendingClaim`), the claim then travelling in that screen's route.
 * Kept in step with the phone by the root layout (null once it is gone); never set by a screen.
 */
export function landOnClaim(to: { route: ClaimLanding; until: number } | null): void {
    claim = to ? { to: to.route, until: to.until } : null;
}

/**
 * The guard's next landing from welcome goes to `to`. Call it before `setIdentity`, and don't navigate: the guard does.
 * Used by the welcome screen's community restore in a vault build (Settings, whose first card is the move), and by a
 * guest visit to the global community before its bounce through Welcome (use-global-guest-visit.ts, {@link guestRedirect}).
 */
export function landNextOn(to: MemberLanding, publicKey: string | null = null): void {
    next = { to, publicKey };
}

/**
 * The root guard's last check, for a member with an identity whose node has not said otherwise: on welcome or the bare
 * root, where to go (a waiting claim's screen, {@link landOnClaim}; else a landing asked for with `landNextOn`, taken
 * once; else the tabs' index). Anywhere else, null: stay, and leave a landing asked for untouched.
 */
export function memberRedirect(segments: readonly string[], publicKey: string | null = null, now: number = Date.now()): MemberLanding | null {
    // Asked for another account than the one now on the phone: never used, whatever the route.
    if (next && next.publicKey !== null && next.publicKey !== publicKey) next = null;
    if (segments.length !== 0 && segments[0] !== 'welcome') return null;
    if (claim && !(now < claim.until)) claim = null;
    const to = claim?.to ?? next?.to ?? DEFAULT_MEMBER_LANDING;
    next = null;
    return to;
}

/**
 * The root guard's check for a chosen guest it finds on welcome: the community in use answered "not a member" and the
 * phone marked it a guest visit (nodes.ts markGuestNode). The guard holds every stranger on welcome (mismatch-plan.ts
 * notRecognisedStays), so {@link memberRedirect} is never reached for one, and a guest visit that bounced through Welcome,
 * as every switch does, stayed there (PR #2320 review). Only a landing a screen asked for with `landNextOn`, taken once:
 * nothing asked (a guest on welcome to use an invite for that community), null, and the guest stays to use it.
 */
export function guestRedirect(segments: readonly string[], publicKey: string | null = null): MemberLanding | null {
    if (next && next.publicKey !== null && next.publicKey !== publicKey) next = null;
    if (!next || segments[0] !== 'welcome') return null;
    const to = next.to;
    next = null;
    return to;
}
