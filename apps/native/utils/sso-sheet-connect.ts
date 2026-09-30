/**
 * The account-protection sheet's connect (components/SsoEnrolSheet.tsx): a ticket from BeanPool's key vault, the
 * provider's sign-in with that ticket's nonce, then the deposit of the seed, sealed to that sign-in, at the vault
 * (utils/vault.ts). Never the member's community: no community is asked for a nonce or sent a token or a copy.
 *
 * The deposit seals the account's key and 12 words to whichever sign-in account is used, so linking one is a way to
 * take the account: the phone's lock is asked first (`phoneLock`), before the vault, the provider or the words. A check
 * that doesn't pass reads as a cancel (PR #1205 review 4112404429).
 *
 * The ticket is checked against the vault's pinned keys and this member's key before the provider's sheet opens
 * (vault.ts `vaultTicket`): a ticket that isn't the vault's, or names another key, opens no sheet.
 *
 * The sheet offers Cancel only while a cancel is honoured, which is until the deposit is sent:
 * - While the provider is going, a cancel means nothing is deposited when it is done. (The provider's own
 *   sheet has its own cancel.)
 * - `onSignedIn` runs the moment the provider is done. The sheet takes its Cancel down there.
 * - A cancel that landed while the sign-in was finishing, before the sheet caught up, is still honoured
 *   after `onSignedIn`: nothing has been deposited, so nothing is.
 *
 * Past that the deposit goes ahead, and its outcome is reported even if the sheet was closed meanwhile.
 * Once sent it may be at the vault, and "cancelled" over a deposit the vault kept would be untrue the other
 * way round.
 *
 * A vault that is paused (locked, design §2.3) links nothing and says so; the sign-in is offered again at the next app
 * open (vault.ts `rememberConnectWanted`, the move card). Nothing is shown as linked that isn't.
 *
 * A build without a vault (vault.ts `signInCopiesAt`) connects exactly as the app did before the vault: the member's
 * community's nonce (sso-signin.ts `startSsoSignIn`), the provider, and the deposit at that community (`url`).
 */

import { signInWithProvider, startSsoSignIn, SsoSignInError } from './sso-signin';
import type { SsoProvider } from './sso-signin';
import { enrolSsoKeeper, type KeeperEnrolmentResult } from './keeper-enrolment';
import type { BeanPoolIdentity } from './identity';
import { rememberConnectWanted, signInCopiesAt, vaultTicket, VaultError, VAULT_MESSAGES, type VaultFailure } from './vault';

/**
 * Decode the `sub` claim from a JWT id_token without signature verification. The copy is sealed to it, and the vault
 * reads the same claim once it has verified the token; a restore reads it again from a fresh token.
 */
export function extractSub(idToken: string): string {
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

/** Nothing linked, in the member's words: the vault's refusal, or ours. A paused vault is offered again later. */
async function notLinked(identity: BeanPoolIdentity, provider: SsoProvider, error: string, failure?: VaultFailure): Promise<KeeperEnrolmentResult> {
    if (failure === 'locked') {
        await rememberConnectWanted(identity.publicKey, provider);
        error = VAULT_MESSAGES.pausedConnect;
    }
    return { enrolled: [], generation: null, skipped: [], available: 0, error, ...(failure ? { failure } : {}) };
}

export async function connectAndDeposit(options: {
    provider: SsoProvider;
    /**
     * The community the phone is set to: where the copy goes in a build without a vault, and nowhere in a build with
     * one (the vault's address is the build's, never a community's).
     */
    url?: string | null;
    identity: BeanPoolIdentity;
    /**
     * The phone's lock, asked before anything starts. The sheet hands it Settings' check (LocalAuth.authenticateUser);
     * null only for a key the join wizard has just made, the member's own new account.
     */
    phoneLock: (() => Promise<boolean>) | null;
    /** The provider is done and the deposit is next: Cancel no longer applies. */
    onSignedIn: () => void | Promise<void>;
    /** The sheet closed: a sign-in still going deposits nothing once it is done. */
    signal: AbortSignal;
}): Promise<KeeperEnrolmentResult> {
    const { provider, identity, signal } = options;
    if (options.phoneLock && !(await options.phoneLock())) {
        throw new SsoSignInError('cancelled', "The phone's lock was not passed, so no sign-in was linked.");
    }
    // Closed while the check was up: nothing starts.
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    if (signInCopiesAt() === 'community') return connectAtCommunity({ ...options, url: options.url ?? null });

    let grant: { ticket: string; nonce: string };
    try {
        grant = await vaultTicket(identity, 'deposit', provider);
    } catch (e) {
        if (e instanceof VaultError) return notLinked(identity, provider, e.message, e.reason);
        throw e;
    }
    // Closed while the ticket was on its way: no sheet opens.
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');

    const signin = await signInWithProvider(provider, grant.nonce);
    await options.onSignedIn();
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');

    let sub: string;
    try {
        sub = extractSub(signin.idToken);
    } catch {
        // Refused here rather than sealed to nothing: a copy sealed to a missing subject can never be opened.
        return notLinked(identity, provider, "That sign-in didn't say which account it was, so nothing was linked. Try again.");
    }
    const result = await enrolSsoKeeper({ identity, provider, sub, idToken: signin.idToken, ticket: grant.ticket });
    return result.error ? notLinked(identity, provider, result.error, result.failure) : result;
}

/** A build without a vault: exactly the connect the app made before the vault, at the member's community. */
async function connectAtCommunity(options: {
    provider: SsoProvider;
    url: string | null;
    identity: BeanPoolIdentity;
    onSignedIn: () => void | Promise<void>;
    signal: AbortSignal;
}): Promise<KeeperEnrolmentResult> {
    const { provider, url, identity, signal } = options;
    if (!url) return { enrolled: [], generation: null, skipped: [], available: 0, error: 'No node configured yet.' };
    const signin = await startSsoSignIn(provider, url, identity);
    await options.onSignedIn();
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');

    return enrolSsoKeeper({
        identity,
        provider: signin.provider,
        sub: extractSub(signin.idToken),
        idToken: signin.idToken,
        nonce: signin.nonce,
    });
}
