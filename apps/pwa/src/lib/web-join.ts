/**
 * Joining through the open door in a web browser (design G11, G11-b): everything the join screens (components/
 * WebJoin.tsx) do that is not drawing.
 *
 * ## The shape of it
 *
 * The browser makes the key and the 12 words first and keeps them as a pending join (identity.ts), asks the node for
 * a sign-in nonce bound to that key (`POST /api/join/sso-nonce`, signed with it), and then LEAVES THE PAGE for the
 * provider: a full-page redirect with the node's nonce as both `nonce` and `state`, back to
 * `<this origin>/app/auth/<provider>`. No provider script runs on this page, there is no popup and no third-party
 * cookie, which is what makes one flow work in every browser (design §3.5). On the way back the page reads the
 * fragment, takes it out of the address bar at once, matches `state` to the pending join, and sends the one signed
 * `POST /api/join`. GitHub needs no redirect: the node runs the device flow and the page shows the code.
 *
 * ## What the return page trusts (design §5.1, §5.2)
 *
 * Only the fragment, and only its named fields: `state`, `id_token`, `error`, `error_description`. The query string
 * is never read (a token there would have been in a request line). Facebook's fragment also carries an access token
 * and a long-lived token beside the id_token: neither is read, kept or sent, and they leave the address bar with the
 * rest. Nothing from the URL is evaluated or rendered as HTML; a provider's `error_description` is shown as text,
 * capped. A return whose `state` is not the pending join's nonce, or whose token does not carry that nonce, is
 * refused before a request is spent on the node, which checks all of it again and is the check that decides.
 *
 * ## The seam for sign-in recovery (G11-c)
 *
 * Every sign-in that reaches `submit` carries the provider's `sub` (the token's claim, or GitHub's poll answer), and
 * `joinBody` takes an optional `recovery`. G11-c seals the seed to that `sub` and passes the shares; nothing here or
 * in the screens changes shape for it.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getNodeApiUrl, signedFetchWithKey } from './api';
import type { BeanPoolIdentity, JoinProvider } from './identity';

/** The sign-ins the browser leaves the page for. GitHub is the node's own device flow. */
export type RedirectProvider = 'google' | 'apple' | 'facebook';
export const REDIRECT_PROVIDERS: readonly RedirectProvider[] = ['google', 'apple', 'facebook'];

export function isRedirectProvider(value: unknown): value is RedirectProvider {
    return typeof value === 'string' && (REDIRECT_PROVIDERS as readonly string[]).includes(value);
}

const PROVIDER_LABELS: Record<JoinProvider, string> = { google: 'Google', apple: 'Apple', facebook: 'Facebook', github: 'GitHub' };

export function providerLabel(provider: JoinProvider): string {
    return PROVIDER_LABELS[provider];
}

/** One of the four sign-ins by its own name: not `toString` or `constructor`, which `in` would find on any object. */
function isJoinProvider(value: unknown): value is JoinProvider {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, value);
}

/** The door's cap on a joining name (apps/server/src/routes/open-join.ts MAX_JOIN_CALLSIGN). */
export const MAX_JOIN_CALLSIGN = 20;

// ===================== THE REQUEST TO THE PROVIDER (design §3) =====================

/** Where the provider sends the browser back: this web app's own origin, so the pending join is there to meet it. */
export const RETURN_PATH_PREFIX = '/app/auth/';

export function returnUri(origin: string, provider: RedirectProvider): string {
    return `${origin}${RETURN_PATH_PREFIX}${provider}`;
}

export interface AuthRequest {
    /** The id the node said a browser uses for this provider (`clientIds` in its nonce answer). */
    clientId: string;
    /** This web app's origin, e.g. https://global.beanpool.org. */
    origin: string;
    /** The node's nonce for this key. It is `state` as well. */
    nonce: string;
}

function query(params: Array<[string, string]>): string {
    return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/**
 * Google's own sign-in page, asking for an id_token for the node's Web client with the node's nonce in it: the
 * request the iPhone app makes (apps/native/utils/sso-signin.ts googleAuthUrl), returning here instead.
 * `prompt=select_account` so a computer with several Google accounts asks which one.
 */
export function googleAuthUrl({ clientId, origin, nonce }: AuthRequest): string {
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + query([
        ['client_id', clientId],
        ['redirect_uri', returnUri(origin, 'google')],
        ['response_type', 'id_token'],
        ['scope', 'openid email'],
        ['nonce', nonce],
        ['state', nonce],
        ['prompt', 'select_account'],
    ]);
}

/**
 * Sign in with Apple, for the Services ID. No `scope`: the door needs only `sub`, and without a scope Apple sends no
 * name or email to handle. Apple answers with a form POST to the return URL, which the node turns into a 303 to the
 * same URL with the answer in the fragment (apps/server/src/routes/apple-return.ts), so it arrives here as Google's
 * does. `code` is asked for because Apple's form_post needs it; it is never exchanged (that needs a client secret).
 */
export function appleAuthUrl({ clientId, origin, nonce }: AuthRequest): string {
    return 'https://appleid.apple.com/auth/authorize?' + query([
        ['client_id', clientId],
        ['redirect_uri', returnUri(origin, 'apple')],
        ['response_type', 'code id_token'],
        ['response_mode', 'form_post'],
        ['nonce', nonce],
        ['state', nonce],
    ]);
}

/**
 * Facebook's dialog, asking for an OIDC id_token for the node's app with its nonce in it.
 *
 * `response_type=token,id_token` and `scope=openid,email`, exactly the request MEASURED on 2026-09-25 (Marty, desktop
 * Chrome): Facebook answered with an RS256 id_token for our app carrying the nonce verbatim, beside an access token
 * and a long-lived token. `id_token` alone is not asked for: Facebook's documentation lists `code`, `token` and
 * `code token` for this dialog and nowhere documents `id_token` on its own, and no sign-in has measured it, so the
 * smaller request would be a guess at the one step a member cannot retry past. Only the id_token is read on the way
 * back (readAuthReturn); the other two leave the address bar unread.
 */
export function facebookAuthUrl({ clientId, origin, nonce }: AuthRequest): string {
    return `https://www.facebook.com/v20.0/dialog/oauth?client_id=${encodeURIComponent(clientId)}`
        + `&redirect_uri=${encodeURIComponent(returnUri(origin, 'facebook'))}&response_type=token,id_token&scope=openid,email`
        + `&nonce=${encodeURIComponent(nonce)}&state=${encodeURIComponent(nonce)}`;
}

export function providerAuthUrl(provider: RedirectProvider, request: AuthRequest): string {
    switch (provider) {
        case 'google': return googleAuthUrl(request);
        case 'apple': return appleAuthUrl(request);
        case 'facebook': return facebookAuthUrl(request);
    }
}

// ===================== THE RETURN (design §2 screen 4, §5.1, §5.2) =====================

/** What came back in the fragment of `/app/auth/<provider>`, by name. Nothing else in it is read. */
export interface AuthReturn {
    /** The provider the path names, or null when it names none this page redirects to. */
    provider: RedirectProvider | null;
    state: string | null;
    idToken: string | null;
    error: string | null;
    errorDescription: string | null;
}

/** The answer in a return URL, from its fragment only, or null when this is not a return URL. */
export function readAuthReturn(pathname: string, hash: string): AuthReturn | null {
    if (!pathname.startsWith(RETURN_PATH_PREFIX)) return null;
    const named = pathname.slice(RETURN_PATH_PREFIX.length).replace(/\/+$/, '');
    const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const field = (name: string): string | null => {
        const v = fragment.get(name);
        return v ? v : null;
    };
    return {
        provider: isRedirectProvider(named) ? named : null,
        state: field('state'),
        idToken: field('id_token'),
        error: field('error'),
        errorDescription: field('error_description'),
    };
}

/** Where the address bar goes once a return is read: the web app, with no fragment and no query. */
export const SCRUBBED_PATH = '/app';

let captured: { value: AuthReturn | null } | null = null;

/**
 * Read a provider's return from this page's URL and take it out of the address bar and the history at once
 * (`history.replaceState`), before anything awaits. Once per page load: later calls answer the same, so React's
 * development double-render cannot read an already-scrubbed URL and lose the return.
 */
export function captureAuthReturn(win: Pick<Window, 'location' | 'history'> = window): AuthReturn | null {
    if (captured) return captured.value;
    const value = readAuthReturn(win.location.pathname, win.location.hash);
    if (value) win.history.replaceState(null, '', SCRUBBED_PATH);
    captured = { value };
    return value;
}

/** The captured return has been dealt with; a later capture on this page load answers nothing. */
export function consumeCapturedAuthReturn(): void {
    captured = { value: null };
}

/** Tests only: forget what was captured, as a new page load would. */
export function resetCapturedAuthReturn(): void {
    captured = null;
}

/** Decode a JWT's claims without verifying it. Only for reading `nonce` and `sub` back; the node verifies. */
export function jwtClaims(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const claims = JSON.parse(atob(padded));
        return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * Whether a token's `nonce` claim is this attempt's, as the node will judge it (apps/server/src/sso.ts): verbatim,
 * and for Apple also its SHA-256 in hex (`nonceMayBeHashed`), which is how Apple's native flow carries it.
 */
export function nonceClaimMatches(provider: RedirectProvider, claim: unknown, nonce: string): boolean {
    if (typeof claim !== 'string' || !nonce) return false;
    if (claim === nonce) return true;
    return provider === 'apple' && claim === bytesToHex(sha256(utf8ToBytes(nonce)));
}

/** The pending join a return is matched against: the sign-in it went to and the nonce it went with. */
export interface ReturnExpectation {
    provider: JoinProvider | null;
    nonce: string | null;
}

export type ReturnRefusal =
    | 'no_pending'      // nothing was started here (or it expired)
    | 'no_state'        // no state at all: an unfinished sign-in, or an error the provider put in the query
    | 'foreign_state'   // another attempt's, another tab's, or a crafted link
    | 'wrong_provider'  // the path names a sign-in other than the one started
    | 'no_id_token'     // e.g. an access token alone, which the node cannot check without a secret
    | 'not_a_token'
    | 'nonce_mismatch'
    | 'no_subject';

export type ReturnOutcome =
    | { kind: 'token'; provider: RedirectProvider; idToken: string; nonce: string; sub: string }
    | { kind: 'cancelled'; provider: RedirectProvider }
    | { kind: 'provider_error'; provider: RedirectProvider; message: string }
    | { kind: 'refused'; reason: ReturnRefusal };

/** OAuth error codes that mean the member backed out: said quietly, not as a failure. */
const CANCELLED = new Set(['access_denied', 'user_cancelled_authorize', 'user_cancelled_login', 'user_cancelled']);

/** A provider's own words, shown as text and never more than this. */
const MAX_PROVIDER_TEXT = 160;

/** Judge a captured return against the pending join. The node checks the token again; this only saves it a request. */
export function matchAuthReturn(ret: AuthReturn, expected: ReturnExpectation | null): ReturnOutcome {
    if (!expected?.nonce || !expected.provider) return { kind: 'refused', reason: 'no_pending' };
    if (!ret.state) return { kind: 'refused', reason: 'no_state' };
    if (ret.state !== expected.nonce) return { kind: 'refused', reason: 'foreign_state' };
    if (!ret.provider || ret.provider !== expected.provider) return { kind: 'refused', reason: 'wrong_provider' };
    const provider = ret.provider;
    if (ret.error) {
        if (CANCELLED.has(ret.error)) return { kind: 'cancelled', provider };
        const said = (ret.errorDescription || ret.error).slice(0, MAX_PROVIDER_TEXT);
        return { kind: 'provider_error', provider, message: `${providerLabel(provider)} couldn't sign you in: ${said}` };
    }
    if (!ret.idToken) return { kind: 'refused', reason: 'no_id_token' };
    const claims = jwtClaims(ret.idToken);
    if (!claims) return { kind: 'refused', reason: 'not_a_token' };
    if (!nonceClaimMatches(provider, claims.nonce, expected.nonce)) return { kind: 'refused', reason: 'nonce_mismatch' };
    const sub = typeof claims.sub === 'string' ? claims.sub : typeof claims.sub === 'number' ? String(claims.sub) : '';
    if (!sub) return { kind: 'refused', reason: 'no_subject' };
    return { kind: 'token', provider, idToken: ret.idToken, nonce: expected.nonce, sub };
}

/** What the member reads when a return is refused. */
export function refusalMessage(reason: ReturnRefusal, provider: JoinProvider | null): string {
    switch (reason) {
        case 'no_pending':
        case 'foreign_state':
        case 'wrong_provider':
            return "That sign-in wasn't started here. Start again.";
        case 'no_state':
            return "That sign-in didn't finish. Try again, or choose another way.";
        default:
            return `${provider ? providerLabel(provider) : 'The sign-in'} didn't send back what we need. Try again, or choose another way.`;
    }
}

// ===================== THE DOOR (apps/server/src/routes/open-join.ts) =====================

/** A door route's answer, whatever its status. */
export interface DoorAnswer {
    status: number;
    body: Record<string, any>;
    /** `Retry-After` in seconds, when the node sent one. */
    retryAfterSeconds: number | null;
}

/** No answer at all: the node could not be reached, or the connection dropped before it answered. */
export class DoorUnreachableError extends Error {
    constructor(cause: unknown) {
        super(`Could not reach the community: ${(cause as Error)?.message || String(cause)}`);
        this.name = 'DoorUnreachableError';
    }
}

export function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
}

/** A door call signed by the joining key (never the stored identity: there is none yet). */
async function door(method: string, path: string, body: unknown, identity: BeanPoolIdentity): Promise<DoorAnswer> {
    let res: Response;
    try {
        res = await signedFetchWithKey(method, path, body, identity.privateKey, identity.publicKey);
    } catch (e) {
        throw new DoorUnreachableError(e);
    }
    const parsed = await res.json().catch(() => null);
    return {
        status: res.status,
        body: parsed && typeof parsed === 'object' ? parsed : {},
        retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')),
    };
}

/** The node's answer to a nonce request (`POST /api/join/sso-nonce`). */
export interface JoinNonce {
    nonce: string;
    expiresInSeconds: number;
    providers: JoinProvider[];
    githubFlow?: string;
    clientIds: Partial<Record<RedirectProvider, string | null>>;
}

export async function requestJoinNonce(identity: BeanPoolIdentity): Promise<{ nonce: JoinNonce } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/join/sso-nonce', {}, identity);
    const b = answer.body;
    if (answer.status !== 200 || typeof b.nonce !== 'string' || !b.nonce) return { answer };
    return {
        nonce: {
            nonce: b.nonce,
            expiresInSeconds: typeof b.expiresInSeconds === 'number' ? b.expiresInSeconds : 600,
            providers: Array.isArray(b.providers) ? b.providers.filter(isJoinProvider) : [],
            githubFlow: typeof b.githubFlow === 'string' ? b.githubFlow : undefined,
            clientIds: b.clientIds && typeof b.clientIds === 'object' ? b.clientIds : {},
        },
    };
}

/**
 * The sign-ins to offer, in the node's order: the ones it takes that a browser can do here. A redirect provider
 * needs the id the node told us to use (a node whose operator left one out answers null, and its button stays
 * hidden rather than sending the member to a sign-in the node would refuse); GitHub needs the node's own flow.
 */
export function offeredProviders(n: JoinNonce): JoinProvider[] {
    return n.providers.filter((p) => p === 'github'
        ? n.githubFlow === 'node'
        : typeof n.clientIds[p] === 'string' && !!n.clientIds[p]);
}

export interface GithubStart {
    sessionId: string;
    userCode: string;
    verificationUri: string;
    expiresInSeconds: number;
    intervalSeconds: number;
}

/** Where GitHub's device page is, if the node's answer names anything else. */
export const GITHUB_DEVICE_PAGE = 'https://github.com/login/device';

export async function startGithubJoin(identity: BeanPoolIdentity): Promise<{ start: GithubStart } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/join/github/start', {}, identity);
    const b = answer.body;
    if (answer.status !== 200 || typeof b.sessionId !== 'string' || typeof b.userCode !== 'string') return { answer };
    return {
        start: {
            sessionId: b.sessionId,
            userCode: b.userCode,
            // A link the page will draw: only GitHub's own page, whatever the answer says.
            verificationUri: typeof b.verificationUri === 'string' && b.verificationUri.startsWith('https://github.com/')
                ? b.verificationUri : GITHUB_DEVICE_PAGE,
            expiresInSeconds: typeof b.expiresInSeconds === 'number' && b.expiresInSeconds > 0 ? b.expiresInSeconds : 900,
            intervalSeconds: typeof b.intervalSeconds === 'number' && b.intervalSeconds > 0 ? b.intervalSeconds : 5,
        },
    };
}

export function pollGithubJoin(identity: BeanPoolIdentity, sessionId: string): Promise<DoorAnswer> {
    return door('POST', '/api/join/github/poll', { sessionId }, identity);
}

export type GithubPollResult =
    | { status: 'ok'; sub: string }
    | { status: 'denied' }
    | { status: 'expired' }
    | { status: 'failed'; answer: DoorAnswer }
    | { status: 'aborted' };

export interface GithubPollOptions {
    poll: () => Promise<DoorAnswer>;
    /** Resolves after `ms`, or early once `signal` aborts. */
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    intervalSeconds: number;
    /** When the code stops working (ms since the epoch): past it the page says so rather than waiting on. */
    expiresAt: number;
    now?: () => number;
    signal?: AbortSignal;
}

/**
 * Wait for the member to enter the code at GitHub: poll the node at GitHub's interval until it says ok, denied or
 * expired. A 429 is "still waiting", and the next poll waits the `Retry-After` it came with (the poll's own
 * per-address bucket, apps/server/src/github-poll-rate-limit.ts). No answer, or a 503 (GitHub could not be asked), is
 * waited through too: the session has its own deadline, and a blip should not throw away a code being typed.
 */
export async function runGithubPoll(opts: GithubPollOptions): Promise<GithubPollResult> {
    const now = opts.now ?? Date.now;
    let intervalSeconds = opts.intervalSeconds;
    let waitMs = intervalSeconds * 1000;
    for (;;) {
        await opts.sleep(waitMs, opts.signal);
        if (opts.signal?.aborted) return { status: 'aborted' };
        if (now() >= opts.expiresAt) return { status: 'expired' };
        let answer: DoorAnswer;
        try {
            answer = await opts.poll();
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) throw e;
            waitMs = intervalSeconds * 1000;
            continue;
        }
        if (opts.signal?.aborted) return { status: 'aborted' };
        if (answer.status === 429) {
            waitMs = (answer.retryAfterSeconds ?? intervalSeconds) * 1000;
            continue;
        }
        if (answer.status === 503) {
            waitMs = intervalSeconds * 1000;
            continue;
        }
        if (answer.status !== 200) return { status: 'failed', answer };
        const b = answer.body;
        switch (b.status) {
            case 'pending':
                if (typeof b.intervalSeconds === 'number' && b.intervalSeconds > 0) intervalSeconds = b.intervalSeconds;
                waitMs = intervalSeconds * 1000;
                continue;
            case 'ok':
                if (typeof b.sub !== 'string' || !b.sub) return { status: 'failed', answer };
                return { status: 'ok', sub: b.sub };
            case 'denied':
                return { status: 'denied' };
            case 'expired':
                return { status: 'expired' };
            default:
                return { status: 'failed', answer };
        }
    }
}

/** A real wait, cut short when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

/**
 * The sign-in a join is sent with. `sub` is the provider's id for the account, read back from the token (or GitHub's
 * poll answer): the door does not need it from us, and it is not sent, but sign-in recovery (G11-c) seals to it.
 */
export type SignInProof =
    | { provider: RedirectProvider; idToken: string; nonce: string; sub: string }
    | { provider: 'github'; sessionId: string; sub: string };

/** Sign-in recovery enrolled in the same request (G11-c): the body `POST /api/recovery/shares/sso` takes. */
export interface JoinRecovery {
    shares: unknown[];
}

/** The `POST /api/join` body. */
export function joinBody(callsign: string, proof: SignInProof, recovery?: JoinRecovery): Record<string, unknown> {
    const credential = proof.provider === 'github'
        ? { proof: { sessionId: proof.sessionId } }
        : { idToken: proof.idToken, nonce: proof.nonce };
    return { callsign, provider: proof.provider, ...credential, ...(recovery ? { recovery } : {}) };
}

export function submitJoin(identity: BeanPoolIdentity, body: Record<string, unknown>): Promise<DoorAnswer> {
    return door('POST', '/api/join', body, identity);
}

/** Is this key a member here? Signed by the key itself, which is not stored yet. */
export async function checkMembershipWithKey(identity: BeanPoolIdentity): Promise<{ isMember: boolean; callsign: string | null }> {
    const answer = await door('GET', `/api/community/membership/${encodeURIComponent(identity.publicKey)}`, undefined, identity);
    if (answer.status !== 200) throw new DoorUnreachableError(new Error(`membership check answered ${answer.status}`));
    return {
        isMember: answer.body.isMember === true,
        callsign: typeof answer.body.callsign === 'string' && answer.body.callsign ? answer.body.callsign : null,
    };
}

/** What the member sees next, for each answer the door can give (design §2, screen 4). */
export type DoorOutcome =
    | { kind: 'joined'; callsign: string | null; recovery: { enrolled?: boolean } | null }
    | { kind: 'already_member' }
    | { kind: 'already_joined'; message: string }
    | { kind: 'expired'; message: string }
    | { kind: 'rate_limited'; message: string }
    | { kind: 'unavailable'; message: string }
    | { kind: 'door_closed'; message: string }
    | { kind: 'refused'; message: string };

const DOOR_CLOSED = "This community isn't taking new members right now.";
const EXPIRED = "That took a while and the sign-in expired. Let's try once more.";

export function doorOutcome(answer: DoorAnswer, provider: JoinProvider): DoorOutcome {
    const { status, body } = answer;
    const said = typeof body.error === 'string' && body.error ? body.error : null;
    if (status === 200 && body.success === true) {
        const callsign = typeof body.member?.callsign === 'string' && body.member.callsign ? body.member.callsign : null;
        const recovery = body.recovery && typeof body.recovery === 'object' ? body.recovery : null;
        return { kind: 'joined', callsign, recovery };
    }
    if (status === 409 && body.code === 'already_member') return { kind: 'already_member' };
    if (status === 409 && body.code === 'already_joined') {
        // The node's sentence offers "your sign-in" too, which the web cannot do yet (G11-d).
        return { kind: 'already_joined', message: `This ${providerLabel(provider)} account already has a BeanPool identity here. Restore it instead.` };
    }
    if (status === 401) return { kind: 'expired', message: EXPIRED };
    if (status === 429) return { kind: 'rate_limited', message: said ?? 'Too many new accounts have joined from this network. Please try again later.' };
    if (status === 503) return { kind: 'unavailable', message: said ?? `${providerLabel(provider)} sign-in could not be checked right now. Please try again in a minute.` };
    if (status === 404) return { kind: 'door_closed', message: DOOR_CLOSED };
    return { kind: 'refused', message: said ?? `The community could not add you (${status}). Please try again.` };
}

/** The same judgement for a refused nonce request or GitHub start, before any sign-in. */
export function doorRefusalMessage(answer: DoorAnswer): string {
    if (answer.status === 404) return DOOR_CLOSED;
    const said = typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : null;
    return said ?? `The community could not start a sign-in (${answer.status}). Please try again in a minute.`;
}

// ===================== THE NAME (design §2 screen 2) =====================

export type CallsignCheck = 'available' | 'taken' | 'unknown';

/** Is `callsign` free here? UX only: the door lands a taken name on a free variant, and never blocks on it. */
export async function checkCallsign(callsign: string): Promise<CallsignCheck> {
    const c = callsign.trim();
    if (c.length < 2) return 'unknown';
    try {
        const res = await fetch(`${getNodeApiUrl()}/api/members/callsign-available/${encodeURIComponent(c)}`, { cache: 'no-store' });
        if (!res.ok) return 'unknown';
        const data = await res.json();
        return data?.available === true ? 'available' : data?.available === false && !data?.tooShort ? 'taken' : 'unknown';
    } catch {
        return 'unknown';
    }
}

// ===================== THE BROWSER =====================

/**
 * Can this browser hold a BeanPool key? The web app signs with WebCrypto Ed25519 (lib/api.ts, lib/mnemonic.ts),
 * which Chrome has from 113, Safari from 17 and Firefox from 130, and keeps it in IndexedDB. Asked before a key is
 * made, so an older browser is told plainly instead of failing halfway through a join.
 */
export async function browserCanHoldKey(): Promise<boolean> {
    try {
        if (!globalThis.crypto?.subtle || typeof globalThis.indexedDB === 'undefined') return false;
        await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' } as unknown as AlgorithmIdentifier, false, ['sign', 'verify']);
        return true;
    } catch {
        return false;
    }
}

/**
 * Ask the browser to keep this site's storage (design §4.2): Chrome grants it quietly to an installed or much-used
 * site, Firefox asks, Safari ignores it. Nothing waits on the answer, and the words warning stays either way.
 */
export async function askPersistentStorage(storage: StorageManager | undefined = globalThis.navigator?.storage): Promise<boolean | null> {
    try {
        if (!storage?.persist) return null;
        if (await storage.persisted?.()) return true;
        return await storage.persist();
    } catch {
        return null;
    }
}
