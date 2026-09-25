/**
 * Whether the account-protection sheet (components/SsoEnrolSheet.tsx) starts its sign-in now: once each time it opens.
 * That is when `visible` turns true, or when the identity to protect arrives if it was not there yet. Nothing else
 * starts it while the sheet stays open.
 *
 * The sheet used to start one whenever `visible`, `provider` or `identity` changed while it was open. At onboarding
 * step 3 the identity is welcome's `pendingIdentity`, and welcome's resume effect sets a new copy of it each time it
 * runs, which included right after an Android sign-in. The member who had just picked their account was sent to
 * Google, or Facebook, a second time.
 *
 * `started` is what the previous call returned; it resets when the sheet closes.
 */
export function signInOnOpen(started: boolean, visible: boolean, hasIdentity: boolean): { start: boolean; started: boolean } {
    if (!visible) return { start: false, started: false };
    if (started || !hasIdentity) return { start: false, started };
    return { start: true, started: true };
}
