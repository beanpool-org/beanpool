/**
 * Sign-in return screens (app/auth/*) and the routing around them.
 *
 * When a provider's page hands the member back as a link rather than inside an auth session, Expo Router pushes
 * `auth/<provider>` onto the root stack, over the screen that is waiting for the sign-in: welcome running a
 * recovery or onboarding's step 3, or Settings linking an account. On Android that link is the
 * `https://beanpool.org/auth/<provider>` App Link: always for Facebook, and for Google whenever Credential
 * Manager's sheet cannot appear, which is common. The token reaches `openAuthSessionWithLinkingFallback`
 * (utils/sso-signin.ts) through the Linking event; the return screen only has to get out of the way, by going back
 * to the waiting screen.
 */

/** The root segment every sign-in return screen lives under. */
export const AUTH_RETURN_ROOT = 'auth';

/** Where the root guard sends a member: welcome while they are still setting up, home once they are. */
export type GuardTarget = '/welcome' | '/(tabs)';

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
 * A sign-in return screen is left alone. Replacing it put a fresh welcome over the screen doing the work: a failed
 * recovery's error landed on the hidden screen, the new one let a second recovery start on top, and after a
 * successful link onboarding's step 3 showed the member as unprotected. The return screen moves itself 300 ms
 * later, to the waiting screen or, when there is none, to where this guard would have sent it
 * (`authReturnDestination`).
 */
export function setupRedirect(segments: readonly string[], { hasIdentity, pendingOnboarding }: SetupState): '/welcome' | null {
    const root = segments[0];
    if (root === AUTH_RETURN_ROOT) return null;
    if (!hasIdentity) return root === 'welcome' || root === 'recover-identity' ? null : '/welcome';
    if (pendingOnboarding) return root === 'welcome' ? null : '/welcome';
    return null;
}

/**
 * Where a sign-in return screen goes once it has passed the link on: back to the screen waiting for the sign-in when
 * there is one. With nothing to go back to (the link opened the app from cold, or the attempt is long gone) it goes
 * where the root guard would have sent it: welcome with no identity, welcome to resume a pending join wizard (the
 * welcome screen restores its step), and home otherwise, where the guard's node-recognition checks carry on as usual.
 */
export function authReturnDestination({ canGoBack, hasIdentity, pendingOnboarding }: SetupState & { canGoBack: boolean }): 'back' | GuardTarget {
    if (canGoBack) return 'back';
    return !hasIdentity || pendingOnboarding ? '/welcome' : '/(tabs)';
}

/**
 * A sign-in provider's return (`beanpool://auth/...`, or the `https://beanpool.org/auth/...` App Link), which the
 * root layout's invite handler must skip. Read as an invite, Facebook's cancel is the code INV-FACE-BOOK from
 * https://beanpool.org (the path's last part), and an id_token can hold an invite-shaped run of characters anywhere.
 */
export function isAuthReturnLink(url: string): boolean {
    return /^(?:beanpool:\/\/|https:\/\/beanpool\.org\/)auth\//i.test(url.trim());
}
