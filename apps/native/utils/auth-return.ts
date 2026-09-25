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

export interface SetupState {
    hasIdentity: boolean;
    /** A join wizard was interrupted before it finished (utils/onboarding-state.ts). */
    pendingOnboarding: boolean;
}

/**
 * The first two checks of the root guard in app/_layout.tsx: while the member has no identity yet or a join wizard
 * pending, every root except welcome (and guardian recovery, which runs without an identity) is replaced with
 * welcome. Null means leave the screen where it is. Once the member is set up this is always null, and the guard's
 * node-recognition checks decide as before.
 *
 * A sign-in return screen (app/auth/*) gets no exemption. On a phone it never mounts, because the return link does
 * not navigate. Anywhere it does mount (the web preview), the guard replaces it before its own 300 ms timer can open
 * a member screen such as /channels.
 */
export function setupRedirect(segments: readonly string[], { hasIdentity, pendingOnboarding }: SetupState): '/welcome' | null {
    const root = segments[0];
    if (!hasIdentity) return root === 'welcome' || root === 'recover-identity' ? null : '/welcome';
    if (pendingOnboarding) return root === 'welcome' ? null : '/welcome';
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
