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
     * That wizard is a join at another community's open door that has not finished (onboarding-state.ts `doorJoinOut`): its
     * key may be on the phone, and the node may hold it. The door screen is left where it is, so the node can say.
     */
    doorOut?: boolean;
    /**
     * No identity, and the phone is looking around the global community as a visitor, chosen on the first screen
     * (utils/look-around.ts `lookingAroundHere`, slice S12). Read only when there is no identity, and only then can the
     * answer be the door ({@link LOOK_DOOR}).
     */
    lookingAround?: boolean;
    /**
     * An identity, no community in use and no wizard part-way: an account that is a member nowhere, waiting to be let in
     * (utils/waiting-to-join.ts, slice S3). Read only with an identity and no wizard pending ({@link WAITING_ROOTS}).
     */
    waiting?: boolean;
}

/**
 * The screens a waiting phone stays on (slice S3): welcome (its waiting mode, an invite, a restore), Find a community (ask
 * another), Start a community and the guide it links to, and the screens a phone with no account may open (guardian
 * recovery, a re-key code, a claim, another community's open door, a community's card, a shared post). Every other screen
 * reads a community the phone is not in, and goes to welcome.
 */
const WAITING_ROOTS: ReadonlySet<string> = new Set([
    'welcome', 'find-community', 'start-community', 'guide', 'recover-identity', 'rekey-code', 'claim-community', 'join-open-door',
    'community-card', 'peek',
]);

/** Where the guard sends a screen: the first screen, the door opened from the look, or nowhere (null). */
export type SetupLanding = '/welcome' | typeof LOOK_DOOR | null;

/**
 * The first checks of the root guard in app/_layout.tsx: while the member has no identity yet or a join wizard
 * pending, every root except welcome (and, with no identity, guardian recovery, a re-key code, a claim, another
 * community's open door and Find a community, which run without one; with a claim whose answer is not in, the claim
 * screen; with another community's door join not finished, the door screen) is replaced with welcome. So, with an
 * identity that is a member nowhere (`waiting`), is every root but the few it stays on. Null means leave the screen where
 * it is. Once the member is set up this is always null, and the guard's node-recognition checks decide as before.
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
export function setupRedirect(segments: readonly string[], { hasIdentity, pendingOnboarding, claimOut = false, doorOut = false, lookingAround = false, waiting = false }: SetupState): SetupLanding {
    const root = segments[0];
    // `rekey-code`: a new phone taking over an account with an admin's re-key code (app/rekey-code.tsx) holds no identity
    // until the admin binds it (utils/rekey-redeem.ts).
    // `claim-community`: the `beanpool claim` QR scanned on a phone with no account yet (Dax, 23 Oct 2026). The claim makes
    // the account there, on the member's tap: a self-hosted community's first owner needs nothing of ours.
    // `join-open-door`: another community's open door, from its link on a phone with no account yet (DESIGN-account-without-
    // global-fable.md §2.3). The door makes the account there, at Join: a self-hoster's open community needs nothing of
    // ours. The global community's own door, with no account, is the first screen's (app/join-open-door.tsx sends it there).
    // `community-card`: a community's public card from its bare address (front doors S15, app/community-card.tsx). It reads
    // the community's public card and nothing else, and its doors lead to welcome; a stranger with no account is who it is for.
    // `peek`: one post a member shared outside their community (front doors S6, app/peek.tsx), read from it as a visitor,
    // with Ask to join leading to that community's card. A stranger with no account is who it is for too.
    // `find-community`: ask a community to let you in, by its address or its code (DESIGN-account-without-global-fable.md
    // §2.4, slice S3). The knock makes the account, at Send: a stranger who knows a community needs nothing of ours. With no
    // account the directory of communities near you is not read.
    if (!hasIdentity) {
        // These stay ahead of the look's check, looking around or not: another community's door link opened while the
        // phone looks around global goes to that door, not global's (S2), a community's card stays (S15), a shared post's
        // peek stays (S6), and so does asking a community by its address (S3; the first screen's quiet row opens it).
        if (root === 'welcome' || root === 'recover-identity' || root === 'rekey-code' || root === 'claim-community' || root === 'community-card'
            || root === 'join-open-door' || root === 'peek' || root === 'find-community') return null;
        // The bare root is the app's start: the first screen, looking around or not (a restart lands there).
        if (lookingAround && root !== undefined) return isLookRoute(segments) ? null : LOOK_DOOR;
        return '/welcome';
    }
    // A claim whose answer is not in, or a door join not finished: its screen stays, where the node says whether it landed
    // (app/claim-community.tsx, app/join-open-door.tsx).
    if (pendingOnboarding) {
        return root === 'welcome' || (claimOut && root === 'claim-community') || (doorOut && root === 'join-open-door') ? null : '/welcome';
    }
    // Waiting to be let in (S3): its screens stay, every other one (the bare root and the tabs among them) goes to welcome,
    // whose waiting mode is its home. Never on to the tabs, and never asked whether a community knows it.
    if (waiting) return root !== undefined && WAITING_ROOTS.has(root) ? null : '/welcome';
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
