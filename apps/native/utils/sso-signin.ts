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

import { Platform, DeviceEventEmitter } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as Crypto from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeBase64 } from './crypto';
import { signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

let GoogleSigninModule: any = null;
try {
    GoogleSigninModule = require('@react-native-google-signin/google-signin');
} catch (e) {
    console.warn('[SSO] Native GoogleSignin module unavailable:', e);
}

/**
 * Web client ID — the `aud` claim the node expects in a Google id_token.
 *
 * This is the "Web application" client ID from the Google Cloud project. The Android and iOS
 * client IDs are implicit (derived from package name + signing key + google-services.json).
 * The web client ID is what makes the SDK return an `idToken` rather than just an access token.
 */
export const GOOGLE_WEB_CLIENT_ID = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
export const FACEBOOK_APP_ID = '818892721251369';
export const GITHUB_CLIENT_ID = 'Ov23li8mmDfBr7GyJVRU';

export type SsoProvider = 'apple' | 'google' | 'facebook' | 'github';

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
     * Subject identifier (user id) if resolved directly by client (e.g. GitHub OAuth).
     */
    sub?: string;
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
 * How long the 401 self-heal may block an interactive sign-in before we give up on it.
 *
 * Long enough for a sync on a slow link, short enough that a member watching a spinner does not
 * conclude the app is broken.
 */
const SYNC_RETRY_TIMEOUT_MS = 5000;

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
    // A 401 here means the node does not recognise this member yet — `activeSigner` found no
    // member row for the signing key. A sync usually fixes exactly that, so one retry is worth it.
    //
    // Bounded, though, because this is an interactive path: the member is looking at a sign-in
    // sheet. `performSync` pulls history and takes SQLite write locks that this codebase has
    // already been bitten by (the lock-queue work in #32/#35/#38/#40/#41), and its own timeouts
    // run to 30s. An auth flow that can sit dead for half a minute reads as a hung app, so the
    // sync gets SYNC_RETRY_TIMEOUT_MS and then we go on to report the 401 honestly.
    if (res.status === 401) {
        try {
            const { performSync } = await import('../services/pillar-sync');
            await Promise.race([
                performSync(),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error(`sync did not finish within ${SYNC_RETRY_TIMEOUT_MS}ms`)),
                    SYNC_RETRY_TIMEOUT_MS,
                )),
            ]);
            res = await signedPost(url, '/api/recovery/sso-nonce', {}, identity);
        } catch (syncErr) {
            // Deliberately swallowed: the 401 below is the real error to report, and a failed
            // self-heal should not replace it with a message about syncing.
            console.warn('[SSO] Self-healing sync retry failed:', syncErr);
        }
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
        ? b.providers.filter((p): p is SsoProvider => p === 'apple' || p === 'google' || p === 'facebook' || p === 'github')
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
    credential?: { identityToken?: string | null; email?: string | null } | null,
): { idToken: string; email?: string } {
    // Optional chaining, and the parameter accepts null (CR): a nullish credential would otherwise
    // throw a TypeError from the property read, which is the one failure this function exists to
    // convert into a named `no-token` error. Losing that to a crash defeats the point.
    if (!credential?.identityToken) {
        throw new SsoSignInError('no-token', 'Apple completed the sign-in but returned no token.');
    }
    return { idToken: credential.identityToken, email: credential.email ?? undefined };
}

function extractErrorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    if (typeof e === 'object' && e !== null) {
        const obj = e as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof obj.message === 'string') parts.push(obj.message);
        if (typeof obj.code === 'string' || typeof obj.code === 'number') parts.push(String(obj.code));
        if (typeof obj.error === 'string') parts.push(obj.error);
        if (parts.length > 0) return parts.join(' - ');
    }
    return String(e);
}

export function formatAppleErrorMessage(e: unknown): string {
    const msg = extractErrorMessage(e);
    if (
        msg.includes('unknown reason') ||
        msg.includes('Authorization attempt failed') ||
        msg.includes('1000') ||
        msg.includes('ERR_UNAVAILABLE')
    ) {
        return 'Apple Sign-In requires an active Apple ID in device or simulator settings (Settings → Apple ID).';
    }
    return `Apple could not sign you in: ${msg}`;
}

export function formatGoogleErrorMessage(e: unknown): string {
    const msg = extractErrorMessage(e);
    if (
        msg.includes('Play Services') ||
        msg.includes('PLAY_SERVICES') ||
        msg.includes('12500') ||
        msg.includes('DEVELOPER_ERROR') ||
        msg.includes('code 10')
    ) {
        return 'Google Sign-In requires Google Play Services and an active Google account on this device / emulator.';
    }
    return `Google could not sign you in: ${msg}`;
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
            reason === 'cancelled' ? 'Sign-in was cancelled.' : formatAppleErrorMessage(e),
        );
    }
    return { ...readAppleCredential(credential), nonce };
}

/**
 * Can this device offer Sign in with Google?
 *
 * Google Sign-In works on both Android and iOS native, but not on web.
 * On iOS it is a secondary option (Apple is native there); on Android it is the primary.
 */
export function googleSignInAvailable(): boolean {
    if (Platform.OS === 'web') return false;
    return Platform.OS === 'android' || Platform.OS === 'ios';
}

function isErrorWithCode(e: unknown): e is { code: string } {
    return typeof e === 'object' && e !== null && 'code' in e;
}

/**
 * Map Google Sign-In errors to SsoFailure reasons.
 *
 * Same pattern as describeAppleError: a discriminant the caller can act on.
 * SIGN_IN_CANCELLED is the one that matters — the member opened the sheet, looked, and
 * decided not to. Not a failure.
 */
export function describeGoogleError(e: unknown): SsoFailure {
    if (isErrorWithCode(e)) {
        const sc = GoogleSigninModule?.statusCodes;
        if (e.code === 'SIGN_IN_CANCELLED' || (sc && e.code === sc.SIGN_IN_CANCELLED)) return 'cancelled';
        if (e.code === 'PLAY_SERVICES_NOT_AVAILABLE' || (sc && e.code === sc.PLAY_SERVICES_NOT_AVAILABLE)) return 'unsupported';
    }
    return 'provider';
}

/**
 * Run the Google Sign-In sheet.
 *
 * NONCE HANDLING — not available in the free `GoogleSignin.signIn()` API.
 *
 * The "Original Google Sign In" API (`GoogleSignin.signIn()`) does not accept a custom nonce.
 * Nonce support requires the premium "Universal Sign In" API (`GoogleOneTapSignIn`). The server's
 * `verifyIdToken` checks the nonce claim, and if none is present the nonce check will fail.
 *
 * Two paths forward:
 *   1. Use the premium API (licence cost, but full nonce binding like Apple).
 *   2. Skip the nonce for Google and instead have the server issue + verify a challenge via a
 *      different channel (e.g. the signed request body).
 *
 * For now, `signInWithGoogle` obtains the `idToken` without nonce binding. The probe screen
 * exists to measure what the token contains and whether the server can verify it (which requires
 * the server to tolerate a missing nonce for Google, or an alternative binding).
 *
 * The raw nonce is still passed through so the caller's signature stays unchanged and the server
 * can log it even though the token won't contain it.
 */
export async function signInWithGoogle(nonce: string): Promise<Omit<SsoSignIn, 'provider'>> {
    if (!googleSignInAvailable()) {
        throw new SsoSignInError('unsupported', 'This device or build cannot sign in with Google.');
    }

    const { GoogleSignin } = GoogleSigninModule;

    GoogleSignin.configure({
        webClientId: GOOGLE_WEB_CLIENT_ID,
    });

    let result;
    try {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        result = await GoogleSignin.signIn();
    } catch (e) {
        const reason = describeGoogleError(e);
        throw new SsoSignInError(
            reason,
            reason === 'cancelled'
                ? 'Sign-in was cancelled.'
                : reason === 'unsupported'
                    ? 'Google Play Services is not available on this device.'
                    : formatGoogleErrorMessage(e),
        );
    }

    if (result.type === 'cancelled') {
        throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    }

    const idToken = result.data?.idToken;
    if (!idToken) {
        throw new SsoSignInError('no-token', 'Google completed the sign-in but returned no token.');
    }

    return {
        idToken,
        nonce,
        email: result.data?.user?.email ?? undefined,
    };
}

async function openAuthSessionWithLinkingFallback(
    authUrl: string,
    completionUri: string,
    redirectKeywords: string[]
): Promise<string> {
    let capturedUrl: string | null = null;
    let linkingSub: any = null;
    let deviceEventSub: any = null;

    const promise = new Promise<string>((resolve) => {
        const handler = (incomingUrl: string) => {
            if (incomingUrl && redirectKeywords.some((kw) => incomingUrl.includes(kw))) {
                capturedUrl = incomingUrl;
                resolve(incomingUrl);
            }
        };

        try {
            linkingSub = Linking.addEventListener('url', (event) => handler(event.url));
        } catch {}
        try {
            deviceEventSub = DeviceEventEmitter.addListener('SSO_AUTH_CALLBACK', (url: string) => handler(url));
        } catch {}

        Linking.getInitialURL().then((initUrl) => {
            if (initUrl) handler(initUrl);
        }).catch(() => {});
    });

    const browserPromise = WebBrowser.openAuthSessionAsync(authUrl, completionUri, { preferEphemeralSession: true })
        .then((result) => {
            if (result.type === 'success' && result.url) {
                capturedUrl = result.url;
                return result.url;
            }
            return null;
        })
        .catch(() => null);

    const resolvedUrl = await Promise.race([
        promise,
        browserPromise.then(async (res) => {
            if (res) return res;
            for (let i = 0; i < 20; i++) {
                if (capturedUrl) return capturedUrl;
                await new Promise((r) => setTimeout(r, 100));
            }
            return capturedUrl;
        }),
    ]);

    if (linkingSub?.remove) linkingSub.remove();
    if (deviceEventSub?.remove) deviceEventSub.remove();

    try {
        WebBrowser.dismissAuthSession();
    } catch {}

    if (!resolvedUrl) {
        throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    }

    return resolvedUrl;
}

export async function signInWithFacebook(nonce: string): Promise<Omit<SsoSignIn, 'provider'>> {
    const redirectUri = 'https://beanpool.org/auth/facebook';
    const completionUri = 'beanpool://auth/facebook';
    const authUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${encodeURIComponent(FACEBOOK_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token,id_token&scope=openid,email&nonce=${encodeURIComponent(nonce)}`;

    const url = await openAuthSessionWithLinkingFallback(authUrl, completionUri, ['auth/facebook', 'beanpool://auth/facebook']);

    const hashIndex = url.indexOf('#');
    const queryIndex = url.indexOf('?');
    const paramStr = hashIndex !== -1 ? url.slice(hashIndex + 1) : (queryIndex !== -1 ? url.slice(queryIndex + 1) : '');
    const params = new URLSearchParams(paramStr);
    const idToken = params.get('id_token') || params.get('access_token');

    if (!idToken) {
        throw new SsoSignInError('no-token', 'Facebook returned no authentication token.');
    }

    let sub: string | undefined;
    let email: string | undefined;

    if (idToken.includes('.')) {
        try {
            const parts = idToken.split('.');
            if (parts.length >= 2) {
                const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
                const payload = JSON.parse(globalThis.atob(pad));
                if (payload?.sub) sub = String(payload.sub);
                if (payload?.email) email = String(payload.email);
            }
        } catch {}
    }

    if (!sub) {
        try {
            const userRes = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,email&access_token=${encodeURIComponent(idToken)}`);
            if (userRes.ok) {
                const data = await userRes.json() as { id?: string | number; email?: string };
                if (data.id) sub = String(data.id);
                if (data.email) email = data.email;
            }
        } catch (e) {
            console.warn('[SSO] Could not fetch Facebook user profile:', e);
        }
    }

    return {
        idToken,
        nonce,
        sub,
        email,
    };
}

function toBase64Url(bytes: Uint8Array): string {
    return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair(): { verifier: string; challenge: string } {
    const randomBytes = Crypto.getRandomBytes(32);
    const verifier = toBase64Url(randomBytes);
    const challengeBytes = sha256(new TextEncoder().encode(verifier));
    const challenge = toBase64Url(challengeBytes);
    return { verifier, challenge };
}

export async function signInWithGithub(nonce: string): Promise<Omit<SsoSignIn, 'provider'>> {
    const redirectUri = 'https://beanpool.org/auth/github';
    const completionUri = 'beanpool://auth/github';
    const { verifier, challenge } = generatePkcePair();
    const scopes = 'read:user user:email';
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(nonce)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;

    const url = await openAuthSessionWithLinkingFallback(authUrl, completionUri, ['auth/github', 'beanpool://auth/github']);

    const queryIndex = url.indexOf('?');
    const hashIndex = url.indexOf('#');
    const paramStr = queryIndex !== -1 ? url.slice(queryIndex + 1) : (hashIndex !== -1 ? url.slice(hashIndex + 1) : '');
    const params = new URLSearchParams(paramStr);
    const code = params.get('code');
    const directToken = params.get('access_token') || params.get('token');

    let accessToken = directToken;
    if (!accessToken && code) {
        // Exchange authorization code for access token via node exchange proxy
        try {
            const anchorUrl = (await AsyncStorage.getItem('beanpool_anchor_url')) || 'https://mullum.beanpool.org';
            const tokenRes = await fetch(`${anchorUrl}/api/recovery/sso/github-exchange`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    code,
                    redirectUri,
                    codeVerifier: verifier,
                }),
            });
            if (!tokenRes.ok) {
                const errData = await tokenRes.json().catch(() => ({ error: `Status ${tokenRes.status}` }));
                throw new Error(errData.error || `Token exchange failed with status ${tokenRes.status}`);
            }
            const tokenData = (await tokenRes.json()) as { accessToken?: string; error?: string };
            if (tokenData.error || !tokenData.accessToken) {
                throw new Error(tokenData.error || 'No access token returned');
            }
            accessToken = tokenData.accessToken;
        } catch (e: any) {
            throw new SsoSignInError('provider', `GitHub token exchange failed: ${e.message}`);
        }
    }

    if (!accessToken) {
        throw new SsoSignInError('no-token', 'GitHub returned no authorization token.');
    }

    // Fetch user profile to extract user id (sub) and email
    let sub: string | undefined;
    let email: string | undefined;
    try {
        const userRes = await fetch('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'User-Agent': 'BeanPool-App',
                Accept: 'application/vnd.github.v3+json',
            },
        });
        if (userRes.ok) {
            const userData = await userRes.json() as { id?: number | string; email?: string };
            if (userData.id !== undefined && userData.id !== null) {
                sub = String(userData.id);
            }
            email = userData.email || undefined;
        }

        // If email is private on the main profile, fetch from /user/emails
        if (!email) {
            const emailsRes = await fetch('https://api.github.com/user/emails', {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'User-Agent': 'BeanPool-App',
                    Accept: 'application/vnd.github.v3+json',
                },
            });
            if (emailsRes.ok) {
                const emailsData = await emailsRes.json() as Array<{ email: string; primary?: boolean; verified?: boolean }>;
                if (Array.isArray(emailsData)) {
                    const primary = emailsData.find((e) => e.primary) || emailsData[0];
                    if (primary?.email) {
                        email = primary.email;
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[SSO] Could not fetch GitHub user profile:', e);
    }

    return {
        idToken: accessToken,
        nonce,
        sub,
        email,
    };
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
    if (provider === 'google') {
        return { provider, ...await signInWithGoogle(nonce) };
    }
    if (provider === 'facebook') {
        return { provider, ...await signInWithFacebook(nonce) };
    }
    if (provider === 'github') {
        return { provider, ...await signInWithGithub(nonce) };
    }
    throw new SsoSignInError('unsupported', `Provider ${provider} is not supported on this device.`);
}
