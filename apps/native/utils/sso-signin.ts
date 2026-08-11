/**
 * Signing in with Apple or Google, for the sole purpose of obtaining an `id_token` this node will
 * accept.
 *
 * This is the half of SSO that has never existed. `apps/server/src/sso.ts` has verified provider
 * tokens since PR #220 and #222 — audiences, JWKS, expiry, nonce — and not one token has ever
 * reached it, because nothing in any client could produce one. Every claim about the sign-in tier
 * is theoretical until this file works on a device.
 *
 * ## Nothing here is a login
 *
 * A member who taps "Sign in with Google" in BeanPool is not signing in to BeanPool. Their account
 * is an Ed25519 key and stays that way. The provider is being asked for one thing: proof that this
 * person still controls that account, which is what unseals a fragment sealed to the provider's
 * subject claim.
 *
 * That distinction has to survive into the UI, because a member who taps a sign-in button during
 * setup WILL tap it on a new phone expecting to be logged in. See `KeeperProtectionPanel`, which
 * carries the same warning for the same reason.
 *
 * ## The nonce
 *
 * Node-issued, never client-chosen: the anti-replay property is that this node minted the value
 * for this member and has not seen it come back. Every node in the federation accepts the same
 * provider audiences, so without it a token obtained at one node is replayable at every other.
 *
 * We hand the provider the RAW nonce and send the RAW nonce back. Apple may echo either it or its
 * SHA-256 — which of the two depends on platform and SDK version, and the server tolerates both
 * deliberately (`nonceMayBeHashed`). That tolerance is why this file does not have to know or care,
 * and it is the reason not to "helpfully" pre-hash here: a client that hashed and a server that
 * only accepted raw would fail with a nonce mismatch, which reads as an attack rather than a
 * version skew.
 *
 * MEASURED 2026-08-11, iPhone XR / iOS 18.7.9 / expo-apple-authentication, via `app/apple-probe`:
 * Apple echoed the nonce VERBATIM, and the token's audience was `org.beanpool.pillar`. So on this
 * path the hashed branch is not exercised. Do NOT take that as licence to delete it — the reading
 * is one platform, one OS version, one SDK, and Google on Android is still unmeasured. Delete it
 * when there is a measurement for every provider we ship, not before.
 */

import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

export type SsoProvider = 'apple' | 'google';

/**
 * Why a sign-in did not produce a token.
 *
 * A discriminant rather than a message, because the caller has to make a decision with it and
 * matching on prose is how that decision silently changes. `cancelled` in particular must never
 * surface as an error: a member who thought better of it and pressed Cancel has done nothing
 * wrong, and telling them something failed is how a tap becomes a support ticket.
 */
export type SsoFailure =
    /** This platform or OS version cannot offer this provider at all. */
    | 'unsupported'
    /** The member backed out of the sheet. Not an error. Say nothing. */
    | 'cancelled'
    /** The sheet completed but handed back no token. Rare, and not the member's doing. */
    | 'no-token'
    /** The node would not issue a nonce — not signed in, rate limited, or unreachable. */
    | 'nonce'
    /** The provider's own machinery failed. */
    | 'provider';

export class SsoSignInError extends Error {
    constructor(readonly reason: SsoFailure, message: string) {
        super(message);
        this.name = 'SsoSignInError';
    }
}

export interface SsoSignIn {
    provider: SsoProvider;
    /** The provider's signed assertion. Opaque here; `verifyIdToken` on the node reads it. */
    idToken: string;
    /** The raw nonce, to be sent back alongside the token so the node can match its own. */
    nonce: string;
    /**
     * Apple returns this on the FIRST authorization only, and never again — so it is absent far
     * more often than it is present, and a keeper list that treated its absence as a failure would
     * be wrong for every member after their first sign-in. Display only.
     */
    email?: string;
}

/** The node's answer to a nonce request. `providers` is what this node will actually accept. */
interface NonceResponse {
    nonce?: unknown;
    expiresInSeconds?: unknown;
    providers?: unknown;
}

/**
 * Ask the node for a nonce bound to this member.
 *
 * Signed, so the node knows who it is minting for — the binding is what stops a caller aiming
 * somebody else's sign-in at their own fragment.
 */
export async function fetchSsoNonce(
    url: string, identity: BeanPoolIdentity,
): Promise<{ nonce: string; providers: SsoProvider[] }> {
    let res: Response;
    try {
        res = await signedPost(url, '/api/recovery/sso-nonce', {}, identity);
    } catch (e) {
        throw new SsoSignInError('nonce', `Could not reach your node: ${(e as Error).message}`);
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new SsoSignInError('nonce', `Your node would not start a sign-in (${res.status}): ${detail.slice(0, 200)}`);
    }
    return readNonceResponse(await res.json().catch(() => ({})));
}

/**
 * Validate the nonce response, separately from fetching it.
 *
 * Split out to be testable without a network, and because the failure it guards is quiet: an
 * empty or non-string nonce would sail through to the provider, come back inside a token, and
 * fail server-side as a nonce mismatch — which looks exactly like replay. Better to say the node
 * sent nothing.
 */
export function readNonceResponse(body: unknown): { nonce: string; providers: SsoProvider[] } {
    const b = (body ?? {}) as NonceResponse;
    if (typeof b.nonce !== 'string' || b.nonce.length === 0) {
        throw new SsoSignInError('nonce', 'Your node did not send a sign-in nonce.');
    }
    const providers = Array.isArray(b.providers)
        ? b.providers.filter((p): p is SsoProvider => p === 'apple' || p === 'google')
        : [];
    return { nonce: b.nonce, providers };
}

/**
 * Can this device offer Sign in with Apple?
 *
 * Two gates, and both matter. The platform check is the cheap one — Apple's sheet exists on iOS
 * only, and `isAvailableAsync` on Android resolves false rather than throwing, so relying on it
 * alone would work but would also mean loading the module's native side on a platform that has
 * none. The runtime check is the real one: iOS 13 is the floor, and this app supports older.
 */
export async function appleSignInAvailable(): Promise<boolean> {
    if (Platform.OS !== 'ios') return false;
    try {
        return await AppleAuthentication.isAvailableAsync();
    } catch {
        return false;
    }
}

/**
 * Map whatever the Apple sheet threw onto a reason the caller can act on.
 *
 * `ERR_REQUEST_CANCELED` is the one that matters. It is by far the most common outcome — people
 * open the sheet to see what it says — and it is not a failure. Everything else is.
 */
export function describeAppleError(e: unknown): SsoFailure {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED') return 'cancelled';
    return 'provider';
}

/**
 * Pull the token out of an Apple credential.
 *
 * `identityToken` is typed as nullable and genuinely can be null — a simulator without an Apple
 * ID, a revoked authorization mid-flow. Without this check the null travels as the string "null"
 * into a request body and the node reports a malformed token, which sends whoever is debugging
 * after the JWT rather than after the sheet that returned nothing.
 */
export function readAppleCredential(
    credential: { identityToken?: string | null; email?: string | null },
): { idToken: string; email?: string } {
    if (!credential.identityToken) {
        throw new SsoSignInError('no-token', 'Apple completed the sign-in but returned no token.');
    }
    return { idToken: credential.identityToken, email: credential.email ?? undefined };
}

/**
 * Run the Apple sheet against a node-issued nonce.
 *
 * Scopes: the full name is not requested. It is offered once, never again, and BeanPool has no
 * use for it — the member already has a callsign and a profile. Asking for data a feature does
 * not need is how a consent screen starts looking like a data grab.
 */
export async function signInWithApple(nonce: string): Promise<Omit<SsoSignIn, 'provider'>> {
    if (!await appleSignInAvailable()) {
        throw new SsoSignInError('unsupported', 'This device cannot sign in with Apple.');
    }
    let credential: AppleAuthentication.AppleAuthenticationCredential;
    try {
        credential = await AppleAuthentication.signInAsync({
            requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
            nonce,
        });
    } catch (e) {
        const reason = describeAppleError(e);
        throw new SsoSignInError(
            reason,
            reason === 'cancelled' ? 'Sign-in was cancelled.' : `Apple could not sign you in: ${(e as Error).message}`,
        );
    }
    return { ...readAppleCredential(credential), nonce };
}

/**
 * Nonce, then sheet, then hand both back — the whole client half of a sign-in.
 *
 * Deliberately stops here rather than depositing anything. What a fragment gets sealed to and how
 * many pieces a member ends up with belongs to enrolment, and the split shape is changing
 * (docs/recovery-model.md); wiring this into a deposit today would mean writing it twice.
 */
export async function startSsoSignIn(
    provider: SsoProvider, url: string, identity: BeanPoolIdentity,
): Promise<SsoSignIn> {
    const { nonce, providers } = await fetchSsoNonce(url, identity);
    // The node's list, not a local constant: nodes may be configured with different audiences, and
    // offering a provider this one will refuse produces a sign-in that succeeds and is then thrown
    // away — the worst possible order to discover it in.
    if (providers.length > 0 && !providers.includes(provider)) {
        throw new SsoSignInError('unsupported', `Your node does not accept ${provider} sign-in.`);
    }
    if (provider === 'apple') {
        return { provider, ...await signInWithApple(nonce) };
    }
    // Google needs a package this app does not yet carry. Named rather than silently unsupported,
    // so the button that gets built next fails loudly here instead of appearing to work.
    throw new SsoSignInError('unsupported', 'Google sign-in is not built yet.');
}
