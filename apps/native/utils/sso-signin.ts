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

/** How long to wait for a provider callback before giving up entirely. */
const AUTH_CALLBACK_TIMEOUT_MS = 120_000;

/**
 * How long to keep listening after the browser claims the member cancelled.
 *
 * On Android that cancel is frequently a lie. `beanpool.org` is a verified App Link with no path
 * restriction, so the OAuth return leg is delivered straight to MainActivity, which destroys the
 * Custom Tab; `openAuthSessionAsync` then reports `cancel` while the real callback is still in
 * flight. MEASURED 2026-08-28 (Pixel 9 Pro, builds 229–233): across every attempt the gap between
 * the spurious cancel and the App Link arriving was under a second, so two seconds is ample.
 *
 * Zero on iOS: `ASWebAuthenticationSession` reports cancellation deterministically and nothing
 * can pre-empt it, so waiting there only freezes the UI on a member who genuinely backed out.
 * The window is a workaround for one Android behaviour, not a general safety margin — every
 * millisecond of it is paid by someone who pressed Cancel and meant it.
 *
 * It is deliberately NOT long enough to cover the Facebook app hijacking the flow into a separate
 * browser tab, where completion takes however long the member takes. That path is not worth
 * designing around — see the note on `signInWithFacebook`.
 */
const SPURIOUS_CANCEL_GRACE_MS = Platform.OS === 'ios' ? 0 : 2_000;

/** Give up on a token exchange rather than hanging the sign-in with no error and no UI change. */
const EXCHANGE_TIMEOUT_MS = 20_000;

const TIMED_OUT = Symbol('sso-timeout');

/**
 * Every parameter in a callback URL, from the query and the fragment together.
 *
 * Slicing from `?` to the end swept a trailing fragment into the last value — and Facebook appends
 * a bare `#_=_` to its redirects, so `?code=abc#_=_` yielded a code of `abc#_=_` and the exchange
 * failed. Providers also disagree about which half they use, so read both rather than guessing.
 */
function callbackParams(url: string): string {
    const q = url.indexOf('?');
    const h = url.indexOf('#');
    const query = q === -1 ? '' : url.slice(q + 1, h > q ? h : undefined);
    const fragment = h === -1 ? '' : url.slice(h + 1);
    return [query, fragment].filter(Boolean).join('&');
}

/** Read `state` from a callback URL, whether the provider put it in the query or the fragment. */
function callbackState(url: string): string | null {
    for (const marker of ['?', '#']) {
        const idx = url.indexOf(marker);
        if (idx === -1) continue;
        const rest = url.slice(idx + 1);
        const cut = marker === '?' ? rest.indexOf('#') : -1;
        const state = new URLSearchParams(cut === -1 ? rest : rest.slice(0, cut)).get('state');
        if (state) return state;
    }
    return null;
}

/**
 * Wait for the provider's callback URL, however Android chooses to deliver it.
 *
 * Three sources are watched because no single one is reliable: the browser promise (correct only
 * when the Custom Tab survives), `Linking`'s url event (fires when the App Link foregrounds
 * MainActivity), and the `SSO_AUTH_CALLBACK` broadcast from `+native-intent.ts` (fires when Expo
 * Router sees the intent first). MEASURED 2026-08-28: across 11 attempts on build 229 every single
 * callback arrived via the App Link, and not one via the browser promise.
 *
 * ## `state` is what makes the race safe
 *
 * Matching on a substring like `auth/github` was not enough, and that is the bug this replaces.
 * Any URL containing it satisfied the match — including a stale callback from an earlier attempt,
 * which `Linking.getInitialURL()` hands back for the entire life of the process. So the race could
 * resolve against an already-consumed authorization code, and which of the stale and fresh URLs
 * won was pure timing: the same tap succeeded or failed at random, which is exactly what was
 * observed on device. Comparing `state` against the nonce this attempt was issued fixes that, and
 * it is the CSRF check OAuth requires of us regardless.
 *
 * `getInitialURL()` is no longer consulted. For a process that is already running it can only ever
 * return a stale URL, so it was pure downside.
 */
async function openAuthSessionWithLinkingFallback(
    authUrl: string,
    completionUri: string,
    expectedState: string,
    provider: SsoProvider
): Promise<string> {
    let resolveArrival: (url: string) => void = () => {};
    const arrival = new Promise<string>((resolve) => {
        resolveArrival = resolve;
    });

    const accept = (incomingUrl: string | null | undefined, source: string): void => {
        if (!incomingUrl) return;
        const state = callbackState(incomingUrl);
        if (state !== expectedState) {
            console.log(`[SSO] ${provider}: ignored ${source} callback (state ${state ? 'mismatch' : 'absent'})`);
            return;
        }
        console.log(`[SSO] ${provider}: accepted callback from ${source}`);
        resolveArrival(incomingUrl);
    };

    const linkingSub = Linking.addEventListener('url', (event) => accept(event.url, 'Linking'));
    const deviceEventSub = DeviceEventEmitter.addListener('SSO_AUTH_CALLBACK', (url: string) =>
        accept(url, 'native-intent')
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), AUTH_CALLBACK_TIMEOUT_MS);
    });

    // Never fails the sign-in on the browser's word alone — it only stops being a candidate once
    // the grace period has passed without a valid callback landing.
    const browser = WebBrowser.openAuthSessionAsync(authUrl, completionUri)
        .then(async (result) => {
            if (result.type === 'success' && result.url) {
                accept(result.url, 'browser');
            } else {
                console.log(`[SSO] ${provider}: browser said '${result.type}' — may be spurious, still listening`);
            }
            await new Promise((r) => setTimeout(r, SPURIOUS_CANCEL_GRACE_MS));
            return null;
        })
        .catch((e) => {
            console.log(`[SSO] ${provider}: browser threw`, e);
            return null;
        });

    console.log(`[SSO] ${provider}: opening auth session`);
    try {
        const outcome = await Promise.race([arrival, browser, deadline]);
        if (typeof outcome === 'string') return outcome;
        if (outcome === TIMED_OUT) {
            console.log(`[SSO] ${provider}: no callback within ${AUTH_CALLBACK_TIMEOUT_MS}ms`);
            throw new SsoSignInError('provider', `${provider} sign-in timed out.`);
        }
        console.log(`[SSO] ${provider}: no valid callback after browser closed`);
        throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    } finally {
        linkingSub?.remove?.();
        deviceEventSub?.remove?.();
        if (timer) clearTimeout(timer);
        try {
            WebBrowser.dismissAuthSession();
        } catch {}
    }
}

export async function signInWithFacebook(nonce: string): Promise<Omit<SsoSignIn, 'provider'>> {
    const redirectUri = 'https://beanpool.org/auth/facebook';
    const completionUri = 'beanpool://auth/facebook';
    const authUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${encodeURIComponent(FACEBOOK_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token,id_token&scope=openid,email&nonce=${encodeURIComponent(nonce)}&state=${encodeURIComponent(nonce)}`;

    const url = await openAuthSessionWithLinkingFallback(authUrl, completionUri, nonce, 'facebook');

    const params = new URLSearchParams(callbackParams(url));
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

    console.log(`[SSO] facebook: resolved sub=${sub ? 'yes' : 'MISSING'} email=${email ? 'yes' : 'no'}`);
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

/** Sleep that gives up early when the caller cancels, so a close is felt at once. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}

/**
 * Bring BeanPool back to the front once a device-flow sign-in is done.
 *
 * `WebBrowser.dismissBrowser()` is `@platform ios`. On Android it throws, so the Custom Tab simply
 * stayed on GitHub's "Congratulations, you're all set!" page with the member stranded in front of
 * a finished web page while their account was already connected behind it. MEASURED 2026-08-28.
 *
 * Android gives an app no way to close a Custom Tab it launched. What it does allow is bringing our
 * own activity forward, which backgrounds the tab — and launching our own scheme does exactly that.
 * It is the same App Link foregrounding that broke the OAuth redirect flow all day; here it is the
 * mechanism that fixes it.
 *
 * `beanpool://foreground` is a no-op route: `+native-intent.ts` returns null for it, so the app
 * comes forward without navigating the member off whatever screen they were on.
 */
export async function returnToApp(): Promise<void> {
    if (Platform.OS === 'ios') {
        try {
            await WebBrowser.dismissBrowser();
        } catch {}
        return;
    }
    try {
        await Linking.openURL('beanpool://foreground');
    } catch {
        // Nothing to fall back to. The member is on a page that says it worked, and the sign-in
        // really did work — worth no more than a log.
        console.log('[SSO] could not bring the app back to the front');
    }
}

/** What the member has to be shown to complete a device-flow sign-in. */
export interface GithubDevicePrompt {
    /** The short code the member types at `verificationUri`. */
    userCode: string;
    /** Where they type it — `https://github.com/login/device`. */
    verificationUri: string;
}

/**
 * Sign in with GitHub, via the device flow.
 *
 * ## Why not the ordinary web flow
 *
 * GitHub OAuth Apps are not an OIDC provider. Google and Apple hand back a signed `id_token` that
 * any node verifies against public JWKS — public keys verify, they do not authorise, so nothing
 * secret is needed and every node can do it unaided. GitHub hands back an opaque token, and the
 * only way to get one through the web flow is a code exchange authenticated with the app's
 * `client_secret`. PKCE does not change that: GitHub's parameter table still lists `client_secret`
 * as Required, and its July 2025 PKCE changelog says plainly that GitHub "does not distinguish
 * between public and confidential clients". PKCE is additive there, not a substitute.
 *
 * That is fatal for a federated network. A secret the exchange needs is a secret every node needs,
 * and BeanPool nodes are run by other people. Shipping it to them makes it not a secret, and no
 * one could rotate it without coordinating every operator at once.
 *
 * The device flow's token request takes `client_id`, `device_code` and `grant_type` — no secret at
 * all. Nothing to distribute, nothing to rotate, and no server proxy in the path: this talks to
 * GitHub directly and behaves the same on a node we have never heard of.
 *
 * It also removes the redirect, which is what all the Custom Tab work was fighting. MEASURED
 * 2026-08-28: `beanpool.org` is a verified App Link with no path restriction, so the return leg was
 * captured by MainActivity and the browser reported a spurious `cancel` on every single attempt.
 * No redirect, no interception, no race.
 *
 * The cost is that the member types a short code instead of tapping. For a one-off recovery setup
 * that is a fair trade, and more legible than being thrown out to a browser and back.
 *
 * Requires "Enable Device Flow" on the OAuth app in GitHub's settings.
 */
export async function signInWithGithub(
    nonce: string,
    onPrompt?: (prompt: GithubDevicePrompt) => void,
    signal?: AbortSignal,
): Promise<Omit<SsoSignIn, 'provider'>> {
    const scopes = 'read:user user:email';

    console.log('[SSO] github: requesting device code');
    let start: {
        device_code?: string; user_code?: string; verification_uri?: string;
        expires_in?: number; interval?: number; error?: string; error_description?: string;
    };
    try {
        const abort = new AbortController();
        const t = setTimeout(() => abort.abort(), EXCHANGE_TIMEOUT_MS);
        try {
            const res = await fetch('https://github.com/login/device/code', {
                method: 'POST',
                signal: abort.signal,
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: scopes }),
            });
            start = await res.json();
        } finally {
            clearTimeout(t);
        }
    } catch (e: any) {
        throw new SsoSignInError('provider', `Could not reach GitHub: ${e.message}`);
    }

    if (start.error || !start.device_code || !start.user_code || !start.verification_uri) {
        // `device_flow_disabled` is worth naming: it is a setting on the OAuth app, nothing the
        // member did, and it would otherwise read as an outage.
        const detail = start.error === 'device_flow_disabled'
            ? 'GitHub sign-in is not enabled for this app yet.'
            : (start.error_description || start.error || 'GitHub did not issue a device code.');
        throw new SsoSignInError('provider', detail);
    }

    const deviceCode = start.device_code;
    const deadlineMs = (start.expires_in ?? 900) * 1000;
    // GitHub's own interval, not a guess. Polling faster than this earns `slow_down`.
    let intervalMs = (start.interval ?? 5) * 1000;

    console.log(`[SSO] github: device code issued, expires in ${Math.round(deadlineMs / 1000)}s`);
    onPrompt?.({ userCode: start.user_code, verificationUri: start.verification_uri });

    // The browser is NOT opened here any more.
    //
    // MEASURED 2026-08-28: opening it immediately covered the code the moment it appeared, so the
    // member had to background the browser, return to the app, copy the code, switch back and
    // paste. The first attempt of that run was abandoned outright and the second took 40 seconds.
    // Anyone less patient reads that as broken.
    //
    // The sheet now owns the launch: it copies the code, says so, and opens GitHub on a tap — so
    // the code is read and in the clipboard BEFORE the browser takes the screen.

    let waited = 0;
    let accessToken: string | undefined;
    while (waited < deadlineMs) {
        // Checked around the wait, not just before it: the sheet can close mid-interval, and a
        // loop nobody is watching would otherwise keep polling GitHub for the full 15 minutes.
        if (signal?.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
        await sleep(intervalMs, signal);
        if (signal?.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
        waited += intervalMs;

        let poll: { access_token?: string; error?: string; error_description?: string };
        try {
            const abort = new AbortController();
            const t = setTimeout(() => abort.abort(), EXCHANGE_TIMEOUT_MS);
            try {
                const res = await fetch('https://github.com/login/oauth/access_token', {
                    method: 'POST',
                    signal: abort.signal,
                    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: GITHUB_CLIENT_ID,
                        device_code: deviceCode,
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    }),
                });
                poll = await res.json();
            } finally {
                clearTimeout(t);
            }
        } catch {
            // A dropped poll is not a failed sign-in — the member may still be typing. Try again.
            continue;
        }

        if (poll.access_token) { accessToken = poll.access_token; break; }
        if (poll.error === 'authorization_pending') continue;
        if (poll.error === 'slow_down') { intervalMs += 5_000; continue; }
        if (poll.error === 'access_denied') {
            throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
        }
        if (poll.error === 'expired_token') break;
        throw new SsoSignInError('provider', poll.error_description || poll.error || 'GitHub refused the sign-in.');
    }

    if (!accessToken) {
        throw new SsoSignInError('provider', 'The GitHub code expired before it was entered.');
    }
    console.log('[SSO] github: device flow authorised');

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
            if (userData.id !== undefined && userData.id !== null) sub = String(userData.id);
            email = userData.email || undefined;
        }
        if (!email) {
            const emailsRes = await fetch('https://api.github.com/user/emails', {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'User-Agent': 'BeanPool-App',
                    Accept: 'application/vnd.github.v3+json',
                },
            });
            if (emailsRes.ok) {
                const emailsData = await emailsRes.json() as Array<{ email: string; primary?: boolean }>;
                if (Array.isArray(emailsData)) {
                    const primary = emailsData.find((e) => e.primary) || emailsData[0];
                    if (primary?.email) email = primary.email;
                }
            }
        }
    } catch (e) {
        console.warn('[SSO] Could not fetch GitHub user profile:', e);
    }

    console.log(`[SSO] github: resolved sub=${sub ? 'yes' : 'MISSING'} email=${email ? 'yes' : 'no'}`);
    // Refuse rather than enrol against a missing subject. `sealShareToSso` keys on `provider:sub`,
    // so an undefined `sub` seals to the literal `github:undefined`: the deposit succeeds, the
    // panel shows a tick, and recovery can never work because the real `sub` derives another key.
    if (!sub) {
        throw new SsoSignInError('provider', 'GitHub did not return a user id, so this account cannot be protected yet.');
    }

    return { idToken: accessToken, nonce, sub, email };
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
    onGithubPrompt?: (prompt: GithubDevicePrompt) => void,
    signal?: AbortSignal,
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
        return { provider, ...await signInWithGithub(nonce, onGithubPrompt, signal) };
    }
    throw new SsoSignInError('unsupported', `Provider ${provider} is not supported on this device.`);
}
