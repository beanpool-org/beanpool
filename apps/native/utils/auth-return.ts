/**
 * Sign-in return links and the routing around them.
 *
 * When a provider's page hands the member back as a link rather than inside an auth session, the link reaches the
 * running app as a Linking event, which is what the waiting sign-in listens for (`openAuthSessionWithLinkingFallback`
 * in utils/sso-signin.ts, and utils/pulse-oauth.ts). On Android that is the `https://beanpool.org/auth/<provider>`
 * App Link: always for Facebook, and for Google whenever Credential Manager's sheet cannot appear, which is common.
 *
 * app/+native-intent.ts passes the link on and cancels the navigation, so the member stays on the screen waiting for
 * the sign-in. When Expo Router navigated to `auth/<provider>` as well, it put a screen over the waiting one, and every
 * screen that reacts to navigation got a chance to disturb it (the root guard, then welcome's invite params).
 */

import { LOOK_DOOR, isLookRoute } from './look-around';

export interface SetupState {
    hasIdentity: boolean;
    /** A join wizard was interrupted before it finished (utils/onboarding-state.ts). */
    pendingOnboarding: boolean;
    /**
     * That wizard is a claim whose answer the phone has not had yet (onboarding-state.ts `claimInFlight`): its key is on
     * the phone, and the node may hold it as owner. The claim screen is left where it is, so the node can say.
     */
    claimOut?: boolean;
    /**
     * No identity, and the phone is looking around the global community as a visitor, chosen on the first screen
     * (utils/look-around.ts `lookingAroundHere`, slice S12). Read only when there is no identity, and only then can the
     * answer be the door ({@link LOOK_DOOR}).
     */
    lookingAround?: boolean;
}

/** Where the guard sends a screen: the first screen, the door opened from the look, or nowhere (null). */
export type SetupLanding = '/welcome' | typeof LOOK_DOOR | null;

/**
 * The first two checks of the root guard in app/_layout.tsx: while the member has no identity yet or a join wizard
 * pending, every root except welcome (and, with no identity, guardian recovery, a re-key code and a claim, which run
 * without one; with a claim whose answer is not in, the claim screen) is replaced with welcome. Null means leave the
 * screen where it is. Once the member is set up this is always null, and the guard's node-recognition checks decide as
 * before.
 *
 * A sign-in return screen (app/auth/*) gets no exemption. On a phone it never mounts, because the return link does
 * not navigate. Anywhere it does mount (the web preview), the guard replaces it before its own 300 ms timer can open
 * a member screen such as /channels.
 *
 * Looking around with no identity (`lookingAround`, slice S12): the look's screens stay (utils/look-around.ts
 * `isLookRoute`), and any other screen, each of which needs a key, is replaced with the door ({@link LOOK_DOOR}), whose
 * Back returns to the look. The key is made there, at Join, as before.
 */
export function setupRedirect(segments: readonly string[], state: SetupState & { lookingAround: true }): SetupLanding;
export function setupRedirect(segments: readonly string[], state: SetupState): '/welcome' | null;
export function setupRedirect(segments: readonly string[], { hasIdentity, pendingOnboarding, claimOut = false, lookingAround = false }: SetupState): SetupLanding {
    const root = segments[0];
    // `rekey-code`: a new phone taking over an account with an admin's re-key code (app/rekey-code.tsx) holds no identity
    // until the admin binds it (utils/rekey-redeem.ts).
    // `claim-community`: the `beanpool claim` QR scanned on a phone with no account yet (Dax, 23 Oct 2026). The claim makes
    // the account there, on the member's tap: a self-hosted community's first owner needs nothing of ours.
    // `community-card`: a community's public card from its bare address (front doors S15, app/community-card.tsx). It reads
    // the community's public card and nothing else, and its doors lead to welcome; a stranger with no account is who it is for.
    // `peek`: one post a member shared outside their community (front doors S6, app/peek.tsx), read from it as a visitor,
    // with Ask to join leading to that community's card. A stranger with no account is who it is for too.
    if (!hasIdentity) {
        if (root === 'welcome' || root === 'recover-identity' || root === 'rekey-code' || root === 'claim-community' || root === 'community-card' || root === 'peek') return null;
        // The bare root is the app's start: the first screen, looking around or not (a restart lands there).
        if (lookingAround && root !== undefined) return isLookRoute(segments) ? null : LOOK_DOOR;
        return '/welcome';
    }
    // A claim whose answer is not in: its screen stays, where the node says whether it landed (app/claim-community.tsx).
    if (pendingOnboarding) return root === 'welcome' || (claimOut && root === 'claim-community') ? null : '/welcome';
    return null;
}

/**
 * A sign-in provider's return: `beanpool://auth/...` (Android may add a slash after the scheme), the
 * `https://beanpool.org/auth/...` App Link, or the bare `/auth/...` path. app/+native-intent.ts does not navigate for
 * these, and the root layout's invite handler skips them. Read as an invite, Facebook's cancel is the code
 * INV-FACE-BOOK from https://beanpool.org (the path's last part), and an id_token can hold an invite-shaped run of
 * characters anywhere.
 */
export function isAuthReturnLink(url: string): boolean {
    return /^(?:beanpool:\/\/\/?|https:\/\/beanpool\.org\/|\/)?auth\//i.test(url.trim());
}
