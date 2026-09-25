/**
 * The account-protection sheet's connect (components/SsoEnrolSheet.tsx): sign in with the provider, then
 * deposit the seed, sealed to that sign-in, with the member's node.
 *
 * The sheet offers Cancel only while a cancel is honoured, which is until the deposit is sent:
 * - While the provider is going (a GitHub code waiting to be entered), a cancel stops the sign-in.
 * - `onSignedIn` runs the moment the provider is done. The sheet takes the code and its Cancel down there.
 * - A cancel that landed while the sign-in was finishing, before the sheet caught up, is still honoured
 *   after `onSignedIn`: nothing has been deposited, so nothing is.
 *
 * Past that the deposit goes ahead, and its outcome is reported even if the sheet was closed meanwhile.
 * Once sent it may be on the node, and "cancelled" over a deposit the node kept would be untrue the other
 * way round. With GitHub the sheet used to leave the code and Cancel up through the deposit: a tap closed
 * the sheet, the deposit went ahead, and a second later the sheet reported the account covered.
 */

import { startSsoSignIn, SsoSignInError } from './sso-signin';
import type { SsoProvider, GithubDevicePrompt } from './sso-signin';
import { enrolSsoKeeper, type KeeperEnrolmentResult } from './keeper-enrolment';
import type { BeanPoolIdentity } from './identity';

/**
 * Decode the `sub` claim from a JWT id_token without signature verification,
 * or use the directly-resolved `fallbackSub` (Facebook, when its token is not a JWT).
 */
function extractSub(idToken: string, fallbackSub?: string): string {
    if (fallbackSub) return fallbackSub;
    const parts = idToken?.split('.');
    if (!parts || parts.length < 2 || !parts[1]) {
        throw new Error('Could not determine user identifier for this sign-in.');
    }
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(globalThis.atob(pad)) as Record<string, unknown>;
        if (typeof payload?.sub === 'string' && payload.sub) {
            return payload.sub;
        }
    } catch {}
    throw new Error('ID token missing subject claim (sub).');
}

export async function connectAndDeposit(options: {
    provider: SsoProvider;
    url: string;
    identity: BeanPoolIdentity;
    onGithubPrompt: (prompt: GithubDevicePrompt) => void;
    /** The provider is done and the deposit is next: the code and Cancel no longer apply. */
    onSignedIn: () => void | Promise<void>;
    signal: AbortSignal;
}): Promise<KeeperEnrolmentResult> {
    const { provider, url, identity, signal } = options;
    const signin = await startSsoSignIn(provider, url, identity, options.onGithubPrompt, signal);
    await options.onSignedIn();
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');

    // GitHub's proof is the node's own session, never a token (keeper-enrolment.ts).
    return enrolSsoKeeper(signin.provider === 'github'
        ? { identity, provider: 'github', sub: signin.sub, proof: { sessionId: signin.sessionId } }
        : {
            identity,
            provider: signin.provider,
            sub: extractSub(signin.idToken, signin.sub),
            idToken: signin.idToken,
            nonce: signin.nonce,
        });
}
