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
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as Crypto from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeBase64 } from './crypto';
import { signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

/**
 * Web client ID — the `aud` claim the node expects in a Google id_token.
 *
 * This is the "Web application" client ID from the Google Cloud project, and it is the audience on
 * both platforms: Android hands it to Credential Manager as the server client id, and the iPhone
 * signs in on Google's web page as this client. The Android client IDs stay implicit (matched on
 * package name + signing key); the first entry in the node's audience list is this one (`sso.ts`).
 */
export const GOOGLE_WEB_CLIENT_ID = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
export const FACEBOOK_APP_ID = '818892721251369';
// No GitHub client id here: the node runs GitHub's sign-in with its own (`signInWithGithubViaNode`).

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

/** A sign-in that ends in a token from the provider: Apple, Google and Facebook. */
export interface SsoSignIn {
    provider: Exclude<SsoProvider, 'github'>;
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

/**
 * A GitHub sign-in the node ran itself. No GitHub token ever reaches the phone: the node collected
 * it, read who signed in, and dropped it. What the phone holds is the node's session id, which the
 * deposit or recovery that follows spends as `proof: { sessionId }`.
 */
export interface GithubSignIn {
    provider: 'github';
    sessionId: string;
    /** GitHub's numeric user id as the node read it: what the seed is sealed to. */
    sub: string;
    /** Display only. */
    email?: string;
}

/**
 * What a node that runs GitHub's sign-in itself says in its nonce answer (`githubFlow`). A node that
 * does not say it is one no GitHub sign-in can be used with: it would want a GitHub token, and a
 * token handed to a node proves nothing (any app's token reads the same `/user`).
 */
export const GITHUB_FLOW_NODE = 'node';

/** The node's answer to a nonce request. `providers` is what this node will actually accept. */
interface NonceResponse {
    nonce?: unknown;
    expiresInSeconds?: unknown;
    providers?: unknown;
    githubFlow?: unknown;
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
): Promise<NodeNonce> {
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
export function readNonceResponse(body: unknown): NodeNonce {
    const b = (body ?? {}) as NonceResponse;
    if (typeof b.nonce !== 'string' || b.nonce.length === 0) {
        throw new SsoSignInError('nonce', 'Your node did not send a sign-in nonce.');
    }
    const providers = Array.isArray(b.providers)
        ? b.providers.filter((p): p is SsoProvider => p === 'apple' || p === 'google' || p === 'facebook' || p === 'github')
        : [];
    return b.githubFlow === GITHUB_FLOW_NODE
        ? { nonce: b.nonce, providers, githubFlow: GITHUB_FLOW_NODE }
        : { nonce: b.nonce, providers };
}

export interface NodeNonce {
    nonce: string;
    providers: SsoProvider[];
    /** Present only when the node runs GitHub's sign-in itself. */
    githubFlow?: typeof GITHUB_FLOW_NODE;
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
 * Both native platforms, never the web. Android uses Credential Manager, or Google's web sign-in
 * page when its sheet cannot appear; the iPhone uses the web page (see `signInWithGoogle`), where it
 * is a secondary option to Apple.
 */
export function googleSignInAvailable(): boolean {
    if (Platform.OS === 'web') return false;
    return Platform.OS === 'android' || Platform.OS === 'ios';
}

function isErrorWithCode(e: unknown): e is { code: string } {
    return typeof e === 'object' && e !== null && 'code' in e;
}

/**
 * Credential Manager has no dedicated code for a phone without Google Play services: it fails
 * generically, naming the missing "provider dependencies". So that case is read from the message.
 */
function lacksPlayServices(e: unknown): boolean {
    if (isErrorWithCode(e) && e.code === 'PLAY_SERVICES_NOT_AVAILABLE') return true;
    return /provider dependencies|play services/i.test(extractErrorMessage(e));
}

/**
 * Credential Manager answered without showing its sheet, so the member had nothing to choose from
 * and nothing to cancel.
 *
 * NO_CREDENTIALS is what a suppressed sheet looks like, once the module has already fallen back to
 * every account: no Google account on the phone, "Sign-in prompts" turned off for any account on it,
 * or the sheet held back after a few dismissals. A phone without Play services has no provider for
 * Credential Manager at all. Google's button flow (`GetSignInWithGoogleOption`) would cover the first
 * two, but the module only ever builds `GetGoogleIdOption` (`GoogleSignInModule.kt`), so
 * `signInWithGoogleCredentialManager` opens Google's web page instead.
 */
function googleSheetCannotShow(e: unknown): boolean {
    return (isErrorWithCode(e) && e.code === 'NO_CREDENTIALS') || lacksPlayServices(e);
}

/**
 * Map Google Sign-In errors to SsoFailure reasons.
 *
 * Same pattern as describeAppleError: a discriminant the caller can act on. The codes are the ones
 * @thoughtbot/react-native-social-auth's Android module rejects with. SIGN_IN_CANCELLED is the one
 * that matters — the member opened the sheet, looked, and decided not to. Not a failure.
 *
 * `unsupported` is a phone where Credential Manager's sheet cannot appear (`googleSheetCannotShow`).
 * The sign-in does not end there: Google's web page takes over.
 */
export function describeGoogleError(e: unknown): SsoFailure {
    if (isErrorWithCode(e) && e.code === 'SIGN_IN_CANCELLED') return 'cancelled';
    if (googleSheetCannotShow(e)) return 'unsupported';
    return 'provider';
}

/** The error a failed Google sheet surfaces as, once `googleSheetCannotShow` is ruled out. */
function googleSignInFailure(e: unknown): SsoSignInError {
    if (describeGoogleError(e) === 'cancelled') return new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    return new SsoSignInError('provider', formatGoogleErrorMessage(e));
}

/** Decode a JWT payload without verifying it. Only for reading claims back; the node verifies. */
function jwtClaims(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const claims = JSON.parse(globalThis.atob(pad));
        return claims && typeof claims === 'object' ? claims as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * Sign in with Google, getting back an id_token that carries the node's nonce.
 *
 * The nonce is the whole point. The node refuses a Google token without it (S1), because a token
 * bound to no request is replayable: any node it was once shown to could present it to another
 * within the hour and release the member's sealed seed. The old library's free `signIn()` cannot
 * set a nonce, so neither platform uses it any more:
 *
 * - Android: Credential Manager, through @thoughtbot/react-native-social-auth, which passes the
 *   nonce to `GetGoogleIdOption.setNonce()`. When its sheet cannot appear at all, Google's web page
 *   instead, as on the iPhone.
 * - iPhone: Google's own web sign-in page. The same library's iOS side does not pass the nonce
 *   yet (its own comment in `ios/GoogleSignIn.mm`), so it is not even linked there
 *   (`react-native.config.js`).
 *
 * Either way the audience is our Web client, which every node already accepts.
 */
export async function signInWithGoogle(nonce: string): Promise<Omit<SsoSignIn, 'provider'>> {
    if (!googleSignInAvailable()) {
        throw new SsoSignInError('unsupported', 'This device or build cannot sign in with Google.');
    }
    const { idToken, email } = Platform.OS === 'ios'
        ? await signInWithGoogleWebPage(nonce)
        : await signInWithGoogleCredentialManager(nonce);
    requireGoogleNonce(idToken, nonce);
    return { idToken, nonce, email };
}

/**
 * Refuse a token that does not carry this attempt's nonce, before it is sent anywhere.
 *
 * The node would refuse it too, but as "could not be matched to this request", which reads like an
 * attack rather than a sign-in that came back unbound. Verbatim, like the node: `sso.ts` does not
 * accept a hashed nonce from Google.
 */
function requireGoogleNonce(idToken: string, nonce: string): void {
    if (jwtClaims(idToken)?.nonce !== nonce) {
        throw new SsoSignInError(
            'provider',
            "Google signed you in but did not include this sign-in's security code, so your community would refuse it. Try again.",
        );
    }
}

/** Android: Credential Manager, with the nonce and our Web client as the server client id. */
async function signInWithGoogleCredentialManager(nonce: string): Promise<{ idToken: string; email?: string }> {
    let GoogleSignIn: typeof import('@thoughtbot/react-native-social-auth').GoogleSignIn;
    try {
        // Loaded here, not at the top: its native half is linked on Android only, and it throws on
        // first use in a build that lacks it.
        ({ GoogleSignIn } = await import('@thoughtbot/react-native-social-auth'));
        // On every attempt: the nonce is per sign-in, and the module keeps whatever it was last given.
        GoogleSignIn.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, nonce });
    } catch (e) {
        console.warn('[SSO] Google sign-in module unavailable:', e);
        throw new SsoSignInError('unsupported', 'This version of BeanPool cannot sign in with Google. Update BeanPool and try again.');
    }

    // Forget the account used last time. The module first tries a silent sign-in with a previously
    // used account; after this, Credential Manager shows its sheet instead, so the member sees which
    // Google account is about to protect or restore their account. The iPhone page asks the same
    // way (`prompt=select_account`). Not fatal if it fails: the sign-in still carries the nonce.
    try {
        await GoogleSignIn.signOut();
    } catch (e) {
        console.warn('[SSO] Could not clear the remembered Google account:', e);
    }

    let credential: Awaited<ReturnType<typeof GoogleSignIn.signIn>>;
    try {
        credential = await GoogleSignIn.signIn();
    } catch (e) {
        if (googleSheetCannotShow(e)) {
            // Same nonce: the sheet never appeared, so no token carries it and the node, which spends
            // a nonce only when a token bearing it comes back (`consumeNonce` in sso.ts), has not seen
            // it. A cancelled sheet never gets here; the member chose not to go on.
            console.log(`[SSO] google: Credential Manager could not show its sheet (${extractErrorMessage(e)}), opening Google's web page`);
            return signInWithGoogleWebPage(nonce);
        }
        throw googleSignInFailure(e);
    }
    if (!credential?.idToken) {
        throw new SsoSignInError('no-token', 'Google completed the sign-in but returned no token.');
    }
    const email = jwtClaims(credential.idToken)?.email ?? credential.user?.email;
    return { idToken: credential.idToken, email: typeof email === 'string' && email ? email : undefined };
}

/** How long to wait for a provider callback before giving up entirely. */
const AUTH_CALLBACK_TIMEOUT_MS = 120_000;

/**
 * How long Google's web page may stay open: just under the node's nonce, which lives ten minutes
 * (`NONCE_TTL_MS`, apps/server/src/sso.ts).
 *
 * The page holds the whole Google sign-in: email, password, 2-Step Verification and the first-time
 * consent screen. On a new phone that can mean waiting for an SMS code because the prompt went to the
 * phone that was lost, and 120 s would close the page under a member still doing it. This deadline only has
 * to catch a session that never settles. A member who closes the page is told at once: iOS reports
 * that cancel itself, and Android waits only SPURIOUS_CANCEL_GRACE_MS.
 */
const GOOGLE_PAGE_TIMEOUT_MS = 9 * 60_000;

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
 * browser tab, where completion takes however long the member takes. That path is not designed
 * around — see the note on `signInWithFacebook`.
 */
const SPURIOUS_CANCEL_GRACE_MS = Platform.OS === 'ios' ? 0 : 2_000;

/** Give up on a request to the node rather than hanging the sign-in with no error and no UI change. */
const EXCHANGE_TIMEOUT_MS = 20_000;

const TIMED_OUT = Symbol('sso-timeout');

interface AuthSessionOptions {
    /** How long the page may stay open with no callback. AUTH_CALLBACK_TIMEOUT_MS unless given. */
    timeoutMs?: number;
    /**
     * What to tell the member when the browser cannot open the page at all. Without it a browser
     * that throws ends the sign-in as a cancel, as it always has for Facebook.
     */
    browserFailure?: string;
}

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
    provider: SsoProvider,
    { timeoutMs = AUTH_CALLBACK_TIMEOUT_MS, browserFailure }: AuthSessionOptions = {},
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
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
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
            return browserFailure === undefined ? null : new SsoSignInError('provider', browserFailure);
        });

    console.log(`[SSO] ${provider}: opening auth session`);
    try {
        const outcome = await Promise.race([arrival, browser, deadline]);
        if (typeof outcome === 'string') return outcome;
        if (outcome instanceof SsoSignInError) throw outcome;
        if (outcome === TIMED_OUT) {
            console.log(`[SSO] ${provider}: no callback within ${timeoutMs}ms`);
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

/**
 * Where Google's web page sends the member back. Registered as an authorised redirect URI on the
 * Web client.
 *
 * On the iPhone, `apps/website/auth/google.html` answers it and bounces to `beanpool://auth/google`,
 * which `ASWebAuthenticationSession` catches: the iOS associated domains cover only `/` and `/app*`,
 * so this https page is loaded, not claimed by the app. On Android `beanpool.org/auth/` is a verified
 * App Link (`app.json`), so the redirect opens the app directly, as Facebook's does, and the bounce
 * page only matters if the link is not claimed.
 */
export const GOOGLE_REDIRECT_URI = 'https://beanpool.org/auth/google';
const GOOGLE_COMPLETION_URI = 'beanpool://auth/google';

/**
 * Google's web sign-in page, asking for an id_token for our Web client with the node's nonce in it.
 *
 * The nonce doubles as `state`, as for Facebook: it is what `openAuthSessionWithLinkingFallback`
 * matches, so a stale callback from an earlier attempt cannot finish this one.
 * `prompt=select_account` shows the account chooser even when one account is signed in, so the
 * member sees which Google account they are linking.
 */
export function googleAuthUrl(nonce: string): string {
    const params: Array<[string, string]> = [
        ['client_id', GOOGLE_WEB_CLIENT_ID],
        ['redirect_uri', GOOGLE_REDIRECT_URI],
        ['response_type', 'id_token'],
        ['scope', 'openid email'],
        ['nonce', nonce],
        ['state', nonce],
        ['prompt', 'select_account'],
    ];
    return 'https://accounts.google.com/o/oauth2/v2/auth?'
        + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/**
 * Read the id_token out of Google's callback, or say why there is none.
 *
 * Only an id_token will do. An access token proves nothing a node can check without a secret, so a
 * callback carrying one and nothing else is refused rather than passed on. `state` is checked again
 * here even though the race already matched it, so this function is safe on its own.
 */
export function readGoogleCallback(url: string, expectedState: string): { idToken: string; email?: string } {
    const params = new URLSearchParams(callbackParams(url));
    if (params.get('state') !== expectedState) {
        throw new SsoSignInError('provider', "Google's answer did not belong to this sign-in. Try again.");
    }
    const error = params.get('error');
    if (error === 'access_denied') {
        throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    }
    if (error) {
        throw new SsoSignInError('provider', `Google could not sign you in: ${params.get('error_description') || error}`);
    }
    const idToken = params.get('id_token');
    if (!idToken) {
        throw new SsoSignInError('no-token', 'Google completed the sign-in but returned no token.');
    }
    const email = jwtClaims(idToken)?.email;
    return { idToken, email: typeof email === 'string' && email ? email : undefined };
}

/**
 * Google's web sign-in page: always on the iPhone, and on Android when Credential Manager's sheet
 * cannot appear (`googleSheetCannotShow`).
 *
 * On Android this is the Facebook flow exactly: the App Link brings the app forward over the Custom
 * Tab, which Android gives an app no way to close, and `openAuthSessionWithLinkingFallback` takes the
 * callback from the link rather than from the browser's spurious cancel.
 *
 * A page that cannot open at all is said so plainly. For a member who got here because the sheet
 * could not appear, reading that as a cancel would mean tapping and seeing nothing happen. The page
 * gets GOOGLE_PAGE_TIMEOUT_MS, not the 120 s every other provider gets.
 */
async function signInWithGoogleWebPage(nonce: string): Promise<{ idToken: string; email?: string }> {
    const url = await openAuthSessionWithLinkingFallback(googleAuthUrl(nonce), GOOGLE_COMPLETION_URI, nonce, 'google', {
        timeoutMs: GOOGLE_PAGE_TIMEOUT_MS,
        browserFailure: "Google's sign-in page could not open on this phone. Try again.",
    });
    return readGoogleCallback(url, nonce);
}

/**
 * Where Facebook's dialog sends the member back. On Android `beanpool.org/auth/` is a verified App Link, handed to
 * the waiting sign-in without navigating (utils/auth-return.ts). On the iPhone `apps/website/auth/facebook.html`
 * answers it and bounces to `beanpool://auth/facebook`, which `ASWebAuthenticationSession` catches.
 */
const FACEBOOK_REDIRECT_URI = 'https://beanpool.org/auth/facebook';
const FACEBOOK_COMPLETION_URI = 'beanpool://auth/facebook';

/** What the member reads when Facebook's return cannot be used. A cancel is not this: it stays quiet. */
const FACEBOOK_UNFINISHED = "Facebook didn't finish the sign-in. Try again, or use Google, Apple or your 12 words.";

/**
 * Facebook's dialog, asking for an OIDC id_token for our app with the node's nonce in it. The nonce doubles as
 * `state`, as for Google.
 *
 * `response_type=token,id_token`, not `id_token` alone. MEASURED 2026-09-25 (Marty, desktop Chrome, this exact
 * request): Facebook returns an id_token signed RS256 with a `kid` in its published keys, iss
 * `https://www.facebook.com`, aud our app id and the nonce verbatim, beside an access token and a long-lived token.
 * Facebook's documentation lists `code`, `token` and `code token` for this dialog and nowhere documents `id_token`
 * alone, so the smaller grant is not asked for until it has been measured. The other two tokens are never read
 * (`readFacebookCallback`).
 */
function facebookAuthUrl(nonce: string): string {
    return `https://www.facebook.com/v20.0/dialog/oauth?client_id=${encodeURIComponent(FACEBOOK_APP_ID)}`
        + `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}&response_type=token,id_token&scope=openid,email`
        + `&nonce=${encodeURIComponent(nonce)}&state=${encodeURIComponent(nonce)}`;
}

/**
 * Read the id_token out of Facebook's return, or say why there is none. Nothing else in the return is read.
 *
 * Only an id_token the node can verify will do (S1). A return without one is refused, never downgraded to the
 * access token beside it, which only the app secret can check. That token and the long-lived one are in the same
 * fragment, and are not read, kept, logged or sent. The nonce is compared verbatim, as the node compares it
 * (`nonceMayBeHashed: false` for Facebook in sso.ts), and `state` again here even though the race already matched
 * it, so this function is safe on its own.
 *
 * Every refusal reads the same to the member: none is anything they can fix except by trying again or choosing
 * another way back. Why it was refused goes to the log. Only a cancel is quiet.
 */
function readFacebookCallback(url: string, nonce: string): { idToken: string; email?: string } {
    const params = new URLSearchParams(callbackParams(url));
    const refuse = (reason: SsoFailure, why: string): SsoSignInError => {
        console.log(`[SSO] facebook: refused the return (${why})`);
        return new SsoSignInError(reason, FACEBOOK_UNFINISHED);
    };
    if (params.get('state') !== nonce) throw refuse('provider', "state is not this attempt's");
    const error = params.get('error');
    if (error === 'access_denied') throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    if (error) throw refuse('provider', `Facebook answered ${error.slice(0, 40)}`);
    const idToken = params.get('id_token');
    if (!idToken) throw refuse('no-token', 'no id_token');
    const claims = jwtClaims(idToken);
    if (!claims) throw refuse('provider', 'the id_token is not a JWT');
    if (claims.nonce !== nonce) throw refuse('provider', "the id_token does not carry this attempt's nonce");
    const email = claims.email;
    return { idToken, email: typeof email === 'string' && email ? email : undefined };
}

/**
 * Sign in with Facebook, getting back an id_token that carries the node's nonce.
 *
 * The node takes Facebook only as that id_token (S1): it checks it against Facebook's published keys, the issuer,
 * our app id and its own nonce, with no secret. Nothing else Facebook hands back can be checked without the app
 * secret, so nothing else is used, and no request goes to Graph. The `sub` the seed is sealed to comes from the
 * token, which is where the node reads it.
 *
 * ## The Facebook app on Android
 *
 * An installed Facebook app can claim the dialog out of the Custom Tab and finish in its own time, in another
 * browser tab, or with only an access token. Those sign-ins are allowed to fail rather than designed around (Marty's
 * decision, 2026-09-25): a return with only an access token gets the plain message, and one that comes back after
 * SPURIOUS_CANCEL_GRACE_MS finds the sign-in already ended as a cancel. The native SDK's login would not help: it
 * yields an access token, which only the app secret can validate, so the web dialog's id_token is the one
 * secret-less route there is.
 */
export async function signInWithFacebook(nonce: string): Promise<Omit<SsoSignIn, 'provider'>> {
    const url = await openAuthSessionWithLinkingFallback(
        facebookAuthUrl(nonce), FACEBOOK_COMPLETION_URI, nonce, 'facebook',
    );
    const { idToken, email } = readFacebookCallback(url, nonce);
    console.log(`[SSO] facebook: signed in, email=${email ? 'yes' : 'no'}`);
    return { idToken, nonce, email };
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
    // Android only. On web a custom scheme raises a browser protocol prompt, and there is no
    // Custom Tab to background there in any case — the PWA opens GitHub in a tab the member closes
    // themselves.
    if (Platform.OS !== 'android') return;
    try {
        await Linking.openURL('beanpool://foreground');
    } catch (e) {
        // Nothing to fall back to: the member is on a page that says it worked, and it did. Logged
        // with the error because if this fails it will be on some OEM build with its own rules
        // about background activity starts, and the reason is the only clue anyone will get.
        console.warn('[SSO] could not bring the app back to the front:', e);
    }
}

/** What the member has to be shown to complete a GitHub sign-in. */
export interface GithubDevicePrompt {
    /** The short code the member types at `verificationUri`. */
    userCode: string;
    /** Where they type it — `https://github.com/login/device`. */
    verificationUri: string;
}

/** Where the node starts and polls a GitHub sign-in, and what both calls carry. */
export interface GithubNodeRoutes {
    start: string;
    poll: string;
    /** Sent with both calls: a recovering device's `collectionId`, nothing for a member. */
    body?: Record<string, unknown>;
}

/** A signed POST to the node, as the member or as a recovering device's ephemeral key. */
export type NodePost = (path: string, body: Record<string, unknown>) => Promise<Response>;

/** The member's pair (routes/keepers.ts). A recovering device has its own, in sso-recovery.ts. */
export const GITHUB_MEMBER_ROUTES: GithubNodeRoutes = {
    start: '/api/recovery/sso/github/start',
    poll: '/api/recovery/sso/github/poll',
};

export const GITHUB_NODE_UPDATE_MESSAGE =
    "This community's server needs an update before GitHub sign-in works. Use Google, Apple or your 12 words for now.";
const GITHUB_CODE_RAN_OUT = 'The GitHub code ran out before it was entered. Try again.';
const GITHUB_UNAVAILABLE = 'GitHub could not be reached just now. Please try again in a minute.';

/** The node's poll bucket is a one-minute window, so no honest Retry-After is longer. */
const MAX_RETRY_AFTER_MS = 60_000;

function cancelledSignIn(): SsoSignInError {
    return new SsoSignInError('cancelled', 'Sign-in was cancelled.');
}

/**
 * One request to the node that a cancel does not wait for. `null` when there was no answer: the
 * network failed, or nothing came back within EXCHANGE_TIMEOUT_MS.
 */
async function askNode(request: () => Promise<Response>, signal?: AbortSignal): Promise<Response | null> {
    if (signal?.aborted) throw cancelledSignIn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(request).catch(() => null),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), EXCHANGE_TIMEOUT_MS);
            }),
            new Promise<never>((_, reject) => {
                onAbort = () => reject(cancelledSignIn());
                signal?.addEventListener('abort', onAbort, { once: true });
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
}

async function nodeAnswer(res: Response): Promise<Record<string, unknown>> {
    const body = await res.json().catch(() => null);
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

function nodeError(body: Record<string, unknown>): string | undefined {
    return typeof body.error === 'string' && body.error ? body.error.slice(0, 300) : undefined;
}

/** The node's answer when GitHub could not be asked (#1129): the member did nothing wrong. */
function isGithubOutage(status: number, body: Record<string, unknown>): boolean {
    return status === 503 && body.code === 'sign_in_unavailable';
}

function secondsOr(value: unknown, fallback: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function retryAfterMs(res: Response): number | undefined {
    const raw = res.headers?.get?.('Retry-After');
    const seconds = raw == null ? NaN : Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

function githubStartRefused(status: number, body: Record<string, unknown>): SsoSignInError {
    const said = nodeError(body);
    if (isGithubOutage(status, body)) return new SsoSignInError('provider', said ?? GITHUB_UNAVAILABLE);
    // It said it runs GitHub's sign-in and has no route for it: it is the node it says it is not.
    if (status === 404) return new SsoSignInError('unsupported', GITHUB_NODE_UPDATE_MESSAGE);
    // GitHub, or the node's GitHub settings, would not start one ("not enabled for this app yet").
    if (status === 400) return new SsoSignInError('provider', said ?? 'GitHub sign-in could not start. Try again.');
    return new SsoSignInError('nonce', `Your node would not start a GitHub sign-in (${status})${said ? `: ${said}` : ''}`);
}

/** GitHub's device-flow page, the one `verification_uri` it ever sends (RFC 8628 §3.2). */
const GITHUB_DEVICE_PAGE = 'https://github.com/login/device';

/**
 * The node's `start` answer, checked before the member sees any of it. The address is opened on the
 * member's phone, so it has to be GitHub's device page and nothing else: a phone should not open
 * whatever a server names. Any github.com page is not enough. A node is run by someone else, and
 * github.com also hosts other apps' "Authorize" buttons and repo pages that can say anything,
 * "paste your 12 words here" included.
 */
function readGithubStart(body: Record<string, unknown>): {
    sessionId: string; prompt: GithubDevicePrompt; intervalMs: number; expiresMs: number;
} {
    const { sessionId, userCode, verificationUri } = body;
    if (typeof sessionId !== 'string' || !sessionId
        || typeof userCode !== 'string' || !userCode || userCode.length > 64
        || verificationUri !== GITHUB_DEVICE_PAGE) {
        throw new SsoSignInError('provider', 'Your node did not send a usable GitHub code. Try again.');
    }
    return {
        sessionId,
        prompt: { userCode, verificationUri },
        intervalMs: secondsOr(body.intervalSeconds, 5, 60) * 1000,
        expiresMs: secondsOr(body.expiresInSeconds, 900, 1800) * 1000,
    };
}

function finishedGithubSignIn(sessionId: string, body: Record<string, unknown>): Omit<GithubSignIn, 'provider'> {
    // Refuse rather than seal to a missing subject. `sealSeedToSso` keys on `provider:sub`, so an
    // empty `sub` seals to `github:`: the deposit succeeds, the panel shows a tick, and recovery can
    // never work because the real `sub` derives another key.
    const sub = typeof body.sub === 'string' ? body.sub : '';
    if (!sub) {
        throw new SsoSignInError('provider', 'GitHub did not return a user id, so this sign-in cannot be used. Try again.');
    }
    const email = typeof body.email === 'string' && body.email ? body.email : undefined;
    console.log(`[SSO] github: the node says signed in, email=${email ? 'yes' : 'no'}`);
    return email ? { sessionId, sub, email } : { sessionId, sub };
}

/**
 * Sign in with GitHub, with the node running GitHub's device flow (design §2.4; the node's half is
 * S2, #1115).
 *
 * ## Why the device flow
 *
 * GitHub OAuth Apps are not an OIDC provider. Google and Apple hand back a signed `id_token` that any
 * node verifies against public keys; GitHub hands back an opaque token, and its web flow's code
 * exchange needs the app's `client_secret` (PKCE does not change that: GitHub "does not distinguish
 * between public and confidential clients"). A secret every node needs is no secret in a network of
 * nodes other people run. The device flow's token request takes no secret.
 *
 * ## Why the node runs it, not the phone
 *
 * The phone used to, and handed the node the token. But `api.github.com/user` answers for a token
 * minted for ANY app, so a node that trusts a token handed to it releases a member's sealed seed to
 * whoever holds one. The one proof a node can trust is a token it obtained itself. So the phone asks
 * the node to start, shows the member the code, and asks the node whether the member has finished;
 * the node answers `pending`, `ok` with the GitHub user id the seed is sealed to, `denied` or
 * `expired`, and the deposit or recovery that follows carries the node's session id. Not one request
 * goes to GitHub from here, and a node that does not run the flow (`githubFlow` absent) is refused
 * outright, never answered by running it here instead.
 *
 * ## A poll answered 429 is still pending
 *
 * The node's three GitHub poll routes share one bucket per address, 60 a minute
 * (github-poll-rate-limit.ts), and answer 429 with `Retry-After` past it. Six phones on one wifi must
 * each simply wait longer, so a 429 waits `Retry-After` (or the interval) and asks again. It is never
 * a failed sign-in.
 *
 * Cancelling stops the polling at once. Nothing tells the node: an unfinished session proves nothing,
 * and it expires there.
 *
 * The browser is not opened here. MEASURED 2026-08-28: opening it the moment the code appeared
 * covered the code, and the member had to come back for it. The caller shows the code first.
 */
export async function signInWithGithubViaNode(options: {
    post: NodePost;
    routes: GithubNodeRoutes;
    /** The node's nonce answer's `githubFlow`. */
    githubFlow: unknown;
    onPrompt: (prompt: GithubDevicePrompt) => void;
    signal?: AbortSignal;
}): Promise<Omit<GithubSignIn, 'provider'>> {
    const { post, routes, onPrompt, signal } = options;
    if (options.githubFlow !== GITHUB_FLOW_NODE) {
        throw new SsoSignInError('unsupported', GITHUB_NODE_UPDATE_MESSAGE);
    }
    const extra = routes.body ?? {};

    console.log('[SSO] github: asking the node to start');
    const started = await askNode(() => post(routes.start, extra), signal);
    if (!started) {
        throw new SsoSignInError('nonce', 'Could not reach your node to start the GitHub sign-in. Check your connection and try again.');
    }
    const startBody = await nodeAnswer(started);
    if (!started.ok) throw githubStartRefused(started.status, startBody);
    const start = readGithubStart(startBody);
    const { sessionId } = start;
    let intervalMs = start.intervalMs;
    const deadline = Date.now() + start.expiresMs;

    console.log(`[SSO] github: the node issued a code, expires in ${Math.round(start.expiresMs / 1000)}s`);
    onPrompt(start.prompt);

    let waitMs = intervalMs;
    for (;;) {
        // Checked around the wait, not just before it: the sheet can close mid-interval, and a loop
        // nobody is watching would otherwise keep polling the node until the code ran out.
        await sleep(waitMs, signal);
        if (signal?.aborted) throw cancelledSignIn();
        const res = await askNode(() => post(routes.poll, { ...extra, sessionId }), signal);
        waitMs = intervalMs;
        if (res?.status === 429) {
            waitMs = retryAfterMs(res) ?? intervalMs;
        } else if (res) {
            const body = await nodeAnswer(res);
            if (isGithubOutage(res.status, body)) {
                throw new SsoSignInError('provider', nodeError(body) ?? GITHUB_UNAVAILABLE);
            }
            if (res.ok) {
                if (body.status === 'ok') return finishedGithubSignIn(sessionId, body);
                if (body.status === 'denied') throw cancelledSignIn();
                if (body.status === 'expired') throw new SsoSignInError('provider', GITHUB_CODE_RAN_OUT);
                if (body.status === 'pending') {
                    // Longer after GitHub said slow_down; the node has already taken it on.
                    intervalMs = secondsOr(body.intervalSeconds, intervalMs / 1000, 120) * 1000;
                    waitMs = intervalMs;
                }
            } else if (res.status < 500) {
                // The node ended it: the session is gone (a restart, a refusal from GitHub) or is not
                // this device's. Its message says to start again.
                throw new SsoSignInError('provider', nodeError(body) ?? `Your node stopped the GitHub sign-in (${res.status}). Try again.`);
            }
            // Any other 5xx is a gateway in front of a node that is briefly away: no answer, like a
            // dropped poll. The node's session outlives it, or the next poll says it did not.
        }
        // No answer, a gateway error, a 429 or pending: the member may still be typing. Ask again,
        // unless the code has certainly run out by now.
        if (Date.now() >= deadline) throw new SsoSignInError('provider', GITHUB_CODE_RAN_OUT);
    }
}

/**
 * Nonce, then sheet, then hand both back — the whole client half of a sign-in.
 *
 * Deliberately stops here rather than depositing anything. What a fragment gets sealed to and how
 * many pieces a member ends up with belongs to enrolment, and the split shape is changing
 * (docs/recovery-model.md); wiring this into a deposit today would mean writing it twice.
 */
export function startSsoSignIn(
    provider: 'github', url: string, identity: BeanPoolIdentity,
    onGithubPrompt?: (prompt: GithubDevicePrompt) => void, signal?: AbortSignal,
): Promise<GithubSignIn>;
export function startSsoSignIn(
    provider: Exclude<SsoProvider, 'github'>, url: string, identity: BeanPoolIdentity,
    onGithubPrompt?: (prompt: GithubDevicePrompt) => void, signal?: AbortSignal,
): Promise<SsoSignIn>;
export function startSsoSignIn(
    provider: SsoProvider, url: string, identity: BeanPoolIdentity,
    onGithubPrompt?: (prompt: GithubDevicePrompt) => void, signal?: AbortSignal,
): Promise<SsoSignIn | GithubSignIn>;
export async function startSsoSignIn(
    provider: SsoProvider, url: string, identity: BeanPoolIdentity,
    onGithubPrompt?: (prompt: GithubDevicePrompt) => void,
    signal?: AbortSignal,
): Promise<SsoSignIn | GithubSignIn> {
    const { nonce, providers, githubFlow } = await fetchSsoNonce(url, identity);
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
        // The nonce goes unused: GitHub's proof is the node's session, already bound to this member
        // and single use. What this answer was asked for is `githubFlow`.
        const signin = await signInWithGithubViaNode({
            post: (path, body) => signedPost(url, path, body, identity),
            routes: GITHUB_MEMBER_ROUTES,
            githubFlow,
            onPrompt: onGithubPrompt ?? (() => {}),
            signal,
        });
        return { provider, ...signin };
    }
    throw new SsoSignInError('unsupported', `Provider ${provider} is not supported on this device.`);
}
