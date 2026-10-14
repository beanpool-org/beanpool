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
 * `POST /api/join`.
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
 * ## A join that went out is never dropped on the clock
 *
 * Once `POST /api/join` has gone, the node may have the member even if its answer never arrives, and the pending join
 * is then the only copy of that key and its 12 words. So it is marked sent (`sentAt`, identity.ts) before it goes,
 * and from then on identity.ts's releaseSentPendingJoin is the only thing that lets it go. What this file gives it:
 *
 *   - `joinVerdict`: an answer is definite only when its body parsed and names the outcome (a 2xx with `success`, a
 *     409 `already_member`, or one of the refusals the door gives before it writes a member, with its own status).
 *     Anything else (a 2xx or 3xx without `success`, a 409 without a code, a 4xx the door did not word, any 5xx) is
 *     unknown, as is no answer or a timeout: the page asks the node before anything else.
 *   - `probeMembership`: the node's own "is this key a member?", signed by the key. Only a 200 saying `isMember` as a
 *     boolean counts; its "not a member" is the evidence a release needs.
 *   - `checkSentJoin`: for a join that went out before this page opened, whether it is in, can still land, or cannot.
 *
 * ## Sign-in recovery (G11-c)
 *
 * Every sign-in that reaches `submit` carries the provider's `sub` (the token's claim). The join screens seal the key
 * (and its 12 words) to that `sub` (lib/join-recovery.ts) and pass the shares as `joinBody`'s `recovery`, so one
 * sign-in both joins and becomes the member's way back, as on the phone.
 *
 * ## The 12-words door and door work (two-doors design §2, §3; slice S5)
 *
 * Where the node says `features.wordsDoor`, a join may go with the 12 words alone: `POST /api/join { door: 'words',
 * callsign, work }`, signed by the joining key like any door request, with no provider, token or nonce. The work is the
 * node's challenge (`POST /api/join/work`, `requestDoorWork`) solved by lib/door-work.ts. A sign-in join carries work
 * too when the node asks for it (from the 30th join an hour from one network), and none otherwise. The door's answers
 * are said as sentences (`doorOutcome`), a `Retry-After` as "Try again in N minutes" (`tryAgainIn`).
 *
 * A words join can land only while its challenge is good (ten minutes from when the node issued it, which is before
 * the join went), as a sign-in join can only while its nonce is: so SENT_JOIN_CAN_LAND_MS holds for both.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getNodeApiUrl, signedFetchWithKey } from './api';
import type { DoorWorkChallenge, DoorWorkDoor, DoorWorkSolution } from './door-work';
import {
    identityStoreProblem,
    isDefiniteJoinRefusal,
    isJoinProvider,
    lastSentAt,
    SENT_JOIN_CAN_LAND_MS,
    type BeanPoolIdentity,
    type JoinProvider,
    type NodeRefusedJoin,
    type NodeSaidNotMember,
    type PendingJoin,
} from './identity';

export { SENT_JOIN_CAN_LAND_MS };

const PROVIDER_LABELS: Record<JoinProvider, string> = { google: 'Google', apple: 'Apple', facebook: 'Facebook' };

export function providerLabel(provider: JoinProvider): string {
    return PROVIDER_LABELS[provider];
}

/** The door's cap on a joining name (apps/server/src/routes/open-join.ts MAX_JOIN_CALLSIGN). */
export const MAX_JOIN_CALLSIGN = 20;

// ===================== THE REQUEST TO THE PROVIDER (design §3) =====================

/** Where the provider sends the browser back: this web app's own origin, so the pending join is there to meet it. */
export const RETURN_PATH_PREFIX = '/app/auth/';

export function returnUri(origin: string, provider: JoinProvider): string {
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

export function providerAuthUrl(provider: JoinProvider, request: AuthRequest): string {
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
    provider: JoinProvider | null;
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
        provider: isJoinProvider(named) ? named : null,
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
export function nonceClaimMatches(provider: JoinProvider, claim: unknown, nonce: string): boolean {
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
    | { kind: 'token'; provider: JoinProvider; idToken: string; nonce: string; sub: string }
    | { kind: 'cancelled'; provider: JoinProvider }
    | { kind: 'provider_error'; provider: JoinProvider; message: string }
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
    /** The answer's `Retry-After`, in seconds (or its body's `retryAfterSeconds`); null or absent when it named no wait. */
    retryAfterSeconds?: number | null;
}

/** Seconds from a `Retry-After` header (whole seconds, or an HTTP date), else from the body; null when neither says. */
export function retryAfterOf(header: string | null | undefined, body: Record<string, any> = {}, now: number = Date.now()): number | null {
    const raw = (header ?? '').trim();
    if (/^\d{1,9}$/.test(raw)) return Number(raw);
    if (raw) {
        const at = Date.parse(raw);
        if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));
    }
    const said = body.retryAfterSeconds;
    return typeof said === 'number' && Number.isFinite(said) && said >= 0 ? Math.ceil(said) : null;
}

/** "Try again in 5 minutes.": a wait the node named, said as one. Whole minutes, at least one; hours past 90 minutes. */
export function tryAgainIn(seconds: number): string {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    if (minutes <= 90) return minutes === 1 ? 'Try again in 1 minute.' : `Try again in ${minutes} minutes.`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? 'Try again in about an hour.' : `Try again in about ${hours} hours.`;
}

/** No answer at all: the node could not be reached, or the connection dropped before it answered. */
export class DoorUnreachableError extends Error {
    constructor(cause: unknown) {
        super(`Could not reach the community: ${(cause as Error)?.message || String(cause)}`);
        this.name = 'DoorUnreachableError';
    }
}

/**
 * How long a door request may take, its body included, before the page stops waiting. Past it the request is
 * aborted: no answer (DoorUnreachableError), or, when the headers came and the body stopped, an answer with no body.
 * Either way nothing is read into it, and a join is asked about (joinVerdict). The node gives a provider 10 s.
 */
export const DOOR_TIMEOUT_MS = 45_000;

/**
 * A door call signed by the joining key (never the stored identity: there is none yet). Also how a sign-in restore
 * (lib/web-restore.ts) makes its calls, signed by its throwaway key: the same timeout, and the same reading of an answer.
 */
export async function door(method: string, path: string, body: unknown, identity: BeanPoolIdentity): Promise<DoorAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('The community took too long to answer.', 'TimeoutError')), DOOR_TIMEOUT_MS);
    try {
        let res: Response;
        try {
            res = await signedFetchWithKey(method, path, body, identity.privateKey, identity.publicKey, controller.signal);
        } catch (e) {
            throw new DoorUnreachableError(e);
        }
        const parsed = await res.json().catch(() => null);
        const answered = parsed && typeof parsed === 'object' ? parsed : {};
        return { status: res.status, body: answered, retryAfterSeconds: retryAfterOf(res.headers?.get?.('Retry-After'), answered) };
    } finally {
        clearTimeout(timer);
    }
}

/** The node's answer to a nonce request (`POST /api/join/sso-nonce`). */
export interface JoinNonce {
    nonce: string;
    expiresInSeconds: number;
    providers: JoinProvider[];
    clientIds: Partial<Record<JoinProvider, string | null>>;
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
            clientIds: b.clientIds && typeof b.clientIds === 'object' ? b.clientIds : {},
        },
    };
}

/**
 * The sign-ins to offer, in the node's order: the ones it takes that it gave a browser id for. A node whose operator
 * left one out answers null, and its button stays hidden rather than sending the member to a sign-in the node would
 * refuse.
 */
export function offeredProviders(n: JoinNonce): JoinProvider[] {
    return n.providers.filter((p) => typeof n.clientIds[p] === 'string' && !!n.clientIds[p]);
}

/**
 * The sign-in a join is sent with. `sub` is the provider's id for the account, read back from the token: the door does
 * not need it from us, and it is not sent, but sign-in recovery (G11-c) seals to it.
 */
export interface SignInProof {
    provider: JoinProvider;
    idToken: string;
    nonce: string;
    sub: string;
}

/** Sign-in recovery enrolled in the same request (G11-c): the body `POST /api/recovery/shares/sso` takes. */
export interface JoinRecovery {
    shares: unknown[];
}

/** The `POST /api/join` body. `work`: only when the node asked for some (a sign-in from a busy network). */
export function joinBody(callsign: string, proof: SignInProof, recovery?: JoinRecovery, work?: DoorWorkSolution | null): Record<string, unknown> {
    return {
        callsign, provider: proof.provider, idToken: proof.idToken, nonce: proof.nonce,
        ...(recovery ? { recovery } : {}),
        ...(work ? { work: { challenge: work.challenge, counters: work.counters } } : {}),
    };
}

/** The `POST /api/join` body of a 12-words join: the name and the work, nothing about any sign-in. */
export function wordsJoinBody(callsign: string, work: DoorWorkSolution): Record<string, unknown> {
    return { door: 'words', callsign, work: { challenge: work.challenge, counters: work.counters } };
}

/** The node's answer to `POST /api/join/work`. */
export type DoorWorkAnswer =
    /** A challenge to solve. */
    | { kind: 'work'; work: DoorWorkChallenge }
    /** None is needed (a sign-in at ordinary rates, or a node from before the work). */
    | { kind: 'none' }
    /** Refused (a network's ceiling, the 12-words door shut here, …): `answer` says why. */
    | { kind: 'refused'; answer: DoorAnswer };

/**
 * Ask the node for work for `which` door, signed by the joining key. A node from before the work (no such route: a 404
 * without the door's own code) needs none. Throws DoorUnreachableError when there is no answer.
 */
export async function requestDoorWork(identity: BeanPoolIdentity, which: DoorWorkDoor, now: () => number = Date.now): Promise<DoorWorkAnswer> {
    const answer = await door('POST', '/api/join/work', { door: which }, identity);
    const b = answer.body;
    if (answer.status === 404 && b.code !== 'invite_only') return { kind: 'none' };
    if (answer.status !== 200) return { kind: 'refused', answer };
    if (b.work === null) return { kind: 'none' };
    const w = b.work;
    if (!w || typeof w.challenge !== 'string' || !w.challenge) return { kind: 'refused', answer };
    const seconds = typeof w.expiresInSeconds === 'number' && w.expiresInSeconds > 0 ? w.expiresInSeconds : 600;
    return {
        kind: 'work',
        work: {
            challenge: w.challenge,
            level: typeof w.level === 'number' ? w.level : 0,
            parts: typeof w.parts === 'number' ? w.parts : 8,
            bits: typeof w.bits === 'number' ? w.bits : 7,
            expiresAt: now() + seconds * 1000,
        },
    };
}

export function submitJoin(identity: BeanPoolIdentity, body: Record<string, unknown>): Promise<DoorAnswer> {
    return door('POST', '/api/join', body, identity);
}

/**
 * Is this key a member here? Signed by the key itself, which is not stored yet. Only a 200 that says `isMember`
 * true or false is an answer: anything else (another status, a captive portal's page, a body without it) throws
 * DoorUnreachableError, so "not a member" is never read into a reply that does not say it.
 */
export async function checkMembershipWithKey(identity: BeanPoolIdentity): Promise<{ isMember: boolean; callsign: string | null }> {
    const answer = await door('GET', `/api/community/membership/${encodeURIComponent(identity.publicKey)}`, undefined, identity);
    if (answer.status !== 200 || typeof answer.body.isMember !== 'boolean') {
        throw new DoorUnreachableError(new Error(`membership check answered ${answer.status} without an answer`));
    }
    return {
        isMember: answer.body.isMember,
        callsign: typeof answer.body.callsign === 'string' && answer.body.callsign ? answer.body.callsign : null,
    };
}

/** The node's answer to "is this key a member?" (probeMembership). */
export type MembershipProbe =
    | { kind: 'member'; callsign: string | null }
    /** It said no: the evidence identity.ts releaseSentPendingJoin needs, with when it was asked. */
    | { kind: 'not_member'; answer: NodeSaidNotMember }
    /** No answer, or not one this page can read: nothing is known. */
    | { kind: 'unknown' };

/** Ask the node, signed by the key itself, whether it is a member. Never throws. */
export async function probeMembership(identity: BeanPoolIdentity): Promise<MembershipProbe> {
    // Taken before asking: the node answers later than this, so every window is judged on the safe side.
    const askedAt = Date.now();
    try {
        const m = await checkMembershipWithKey(identity);
        return m.isMember
            ? { kind: 'member', callsign: m.callsign }
            : { kind: 'not_member', answer: { publicKey: identity.publicKey, askedAt } };
    } catch (e) {
        if (!(e instanceof DoorUnreachableError)) console.error('[WebJoin] membership check failed:', e);
        return { kind: 'unknown' };
    }
}

/** What the node says about a pending join that went out (checkSentJoin). */
export type SentJoinCheck =
    /** The key is a member: the join landed. */
    | { kind: 'member'; callsign: string | null }
    /**
     * Not a member, and no join it sent can land any more. The key is still kept: only a definite refusal of a new
     * join, or the member choosing to let it go, releases it (identity.ts releaseSentPendingJoin).
     */
    | { kind: 'not_member' }
    /** Not a member yet, but a join it sent could still land: keep the key. */
    | { kind: 'may_still_land' }
    /** No answer, or not one this page can read: keep the key. */
    | { kind: 'unknown' };

/** Ask the node whether a sent pending join's key is a member, and whether a join it sent could still land. */
export async function checkSentJoin(p: PendingJoin): Promise<SentJoinCheck> {
    const probe = await probeMembership(p.identity);
    if (probe.kind !== 'not_member') return probe;
    const sentAt = lastSentAt(p);
    return Number.isFinite(sentAt) && probe.answer.askedAt >= sentAt + SENT_JOIN_CAN_LAND_MS
        ? { kind: 'not_member' }
        : { kind: 'may_still_land' };
}

/** The door work's refusals (apps/server/src/routes/open-join.ts): each answered by new work, solved again. */
export const DOOR_WORK_REFUSALS = ['work_required', 'work_invalid', 'work_expired', 'work_spent'] as const;
export type DoorWorkRefusal = (typeof DOOR_WORK_REFUSALS)[number];

export function isDoorWorkRefusal(code: unknown): code is DoorWorkRefusal {
    return typeof code === 'string' && (DOOR_WORK_REFUSALS as readonly string[]).includes(code);
}

/** What the member sees next, for each answer the door can give (design §2, screen 4; the two-doors design §3, §4). */
export type DoorOutcome =
    | { kind: 'joined'; callsign: string | null; recovery: { enrolled?: boolean } | null }
    | { kind: 'already_member' }
    | { kind: 'already_joined'; message: string }
    | { kind: 'expired'; message: string }
    | { kind: 'rate_limited'; message: string }
    /** The work was refused: the page fetches new work and sends again, once, before it says anything. */
    | { kind: 'work'; code: DoorWorkRefusal; message: string }
    /** The node takes no 12-words joins now (its operator turned that door off): the sign-in is the way in. */
    | { kind: 'sign_in_required'; message: string }
    | { kind: 'unavailable'; message: string }
    | { kind: 'door_closed'; message: string }
    | { kind: 'refused'; message: string };

const DOOR_CLOSED = "This community isn't taking new members right now.";
/** A node in a private preview (apps/server config/private-preview.ts) says this itself; the same words if it says nothing. */
export const PRIVATE_PREVIEW_MESSAGE = 'This community is in a private preview. Ask its owner for an invite.';
/**
 * A 401 with no code: the node's signature check refused the request's timestamp (more than 5 minutes off), the one
 * thing a 12-words joiner can fix. The phone says the same (utils/global-join.ts `phoneClock`); never "sign in again" here.
 */
export const WRONG_CLOCK = "The community couldn't accept this because this device's date and time look wrong. Check them in this device's settings (set them to automatic), then try again.";

/** A refusal with no code at 401: the signature check's stale timestamp, which is a wrong clock on this device. */
export function isWrongClock(answer: { status: number; body: Record<string, unknown> }): boolean {
    return answer.status === 401 && typeof answer.body?.code !== 'string';
}
const EXPIRED = "That took a while and the sign-in expired. Let's try once more.";
/** A work refusal said twice (design §3.3): the node's own words ask an old app to update, which a web page can't. */
const WORK_FAILED = "Setting up your account didn't work out. Please try again.";
const SIGN_IN_REQUIRED = 'This community needs a sign-in to join: Google, Apple or Facebook.';
/** A busy network's ceiling or the door's own limiter, with no sentence from the node. */
const TOO_MANY = 'Too many tries from this network just now.';

/**
 * A wait in a sentence: "Please try again later." becomes "Try again in N minutes." when the node named the wait, and
 * a sentence that names no time gets it added. One that already says when (the 12-words ceiling's) is left as it is.
 */
export function withRetryAfter(sentence: string, seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || /try again in /i.test(sentence)) return sentence;
    const later = /please try again later\.?$/i;
    return later.test(sentence) ? sentence.replace(later, tryAgainIn(seconds)) : `${sentence} ${tryAgainIn(seconds)}`;
}

/** `provider`: the sign-in this join went with, or null for a 12-words join. */
export function doorOutcome(answer: DoorAnswer, provider: JoinProvider | null): DoorOutcome {
    const { status, body } = answer;
    const said = typeof body.error === 'string' && body.error ? body.error : null;
    if (!provider && isWrongClock(answer)) return { kind: 'refused', message: WRONG_CLOCK };
    if (status === 200 && body.success === true) {
        const callsign = typeof body.member?.callsign === 'string' && body.member.callsign ? body.member.callsign : null;
        const recovery = body.recovery && typeof body.recovery === 'object' ? body.recovery : null;
        return { kind: 'joined', callsign, recovery };
    }
    if (status === 409 && body.code === 'already_member') return { kind: 'already_member' };
    if (status === 409 && body.code === 'already_joined' && provider) {
        // Said here rather than in the node's words: the screen under it offers the ways back (G11-d: the sign-in too).
        return { kind: 'already_joined', message: `This ${providerLabel(provider)} account already has a BeanPool identity here. Restore it instead.` };
    }
    if (status === 400 && isDoorWorkRefusal(body.code)) {
        return { kind: 'work', code: body.code, message: body.code === 'work_required' || !said ? WORK_FAILED : said };
    }
    if (status === 403 && body.code === 'sign_in_required') return { kind: 'sign_in_required', message: said ?? SIGN_IN_REQUIRED };
    if (status === 403 && body.code === 'private_preview') return { kind: 'door_closed', message: said ?? PRIVATE_PREVIEW_MESSAGE };
    if (status === 401 && provider) return { kind: 'expired', message: EXPIRED };
    if (status === 429) {
        const sentence = body.code === 'network_busy' && said ? said : said && !/^Too many attempts/.test(said) ? said : TOO_MANY;
        return { kind: 'rate_limited', message: withRetryAfter(sentence, answer.retryAfterSeconds) };
    }
    if (status === 503) {
        return {
            kind: 'unavailable',
            message: said ?? (provider
                ? `${providerLabel(provider)} sign-in could not be checked right now. Please try again in a minute.`
                : "The community couldn't take your join right now. Please try again in a minute."),
        };
    }
    if (status === 404) return { kind: 'door_closed', message: DOOR_CLOSED };
    return { kind: 'refused', message: said ?? `The community could not add you (${status}). Please try again.` };
}

/**
 * What an answer to `POST /api/join` says for sure (see the file's head).
 *   - `joined` / `already_member`: the node has the member.
 *   - `refused`: a refusal the door gives before it writes a member, parsed with its own status. It is the evidence
 *     identity.ts releaseSentPendingJoin needs, together with the node's "not a member" asked afterwards.
 *   - `unknown`: nothing sure. `outcome` is what to show once the node has been asked and has not said "member": by
 *     status for a 4xx (not 409) or a 5xx, and null (the "we can't tell" screen) for the rest.
 */
export type JoinVerdict =
    | { kind: 'joined'; callsign: string | null; recovery: { enrolled?: boolean } | null }
    | { kind: 'already_member' }
    | { kind: 'refused'; refusal: NodeRefusedJoin; outcome: DoorOutcome }
    | { kind: 'unknown'; outcome: DoorOutcome | null };

export function joinVerdict(
    answer: DoorAnswer,
    sent: { identity: BeanPoolIdentity; sentAt?: number },
    provider: JoinProvider | null,
    answeredAt: number = Date.now(),
): JoinVerdict {
    const { status, body } = answer;
    if (status >= 200 && status < 300 && body.success === true) {
        const callsign = typeof body.member?.callsign === 'string' && body.member.callsign ? body.member.callsign : null;
        const recovery = body.recovery && typeof body.recovery === 'object' ? body.recovery : null;
        return { kind: 'joined', callsign, recovery };
    }
    if (status === 409 && body.code === 'already_member') return { kind: 'already_member' };
    if (isDefiniteJoinRefusal(body.code, status) && typeof sent.sentAt === 'number') {
        return {
            kind: 'refused',
            refusal: { publicKey: sent.identity.publicKey, sentAt: sent.sentAt, answeredAt, status, code: body.code },
            outcome: doorOutcome(answer, provider),
        };
    }
    return { kind: 'unknown', outcome: status >= 400 && status < 600 && status !== 409 ? doorOutcome(answer, provider) : null };
}

/** The same judgement for a refused nonce request, before any sign-in. */
export function doorRefusalMessage(answer: DoorAnswer): string {
    if (answer.status === 404) return DOOR_CLOSED;
    const said = typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : null;
    if (answer.status === 429) return withRetryAfter(said && !/^Too many attempts/.test(said) ? said : TOO_MANY, answer.retryAfterSeconds);
    return said ?? `The community could not start a sign-in (${answer.status}). Please try again in a minute.`;
}

/**
 * What a refused `POST /api/join/work` for the 12-words door means for that door: busy (a network's ceiling, or the
 * door's limiter: the sign-in is still open, and the sentence says so), shut here (the operator turned the 12-words
 * door off), or something else, said as the node said it.
 */
export function wordsWorkRefusal(answer: DoorAnswer): { kind: 'busy' | 'closed' | 'failed'; message: string } {
    const said = typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : null;
    if (isWrongClock(answer)) return { kind: 'failed', message: WRONG_CLOCK };
    if (answer.status === 403 && answer.body.code === 'sign_in_required') return { kind: 'closed', message: said ?? SIGN_IN_REQUIRED };
    if (answer.status === 403 && answer.body.code === 'private_preview') return { kind: 'closed', message: said ?? PRIVATE_PREVIEW_MESSAGE };
    if (answer.status === 429) {
        const sentence = answer.body.code === 'network_busy' && said ? said : TOO_MANY;
        return { kind: 'busy', message: withRetryAfter(sentence, answer.retryAfterSeconds) };
    }
    if (answer.status === 404) return { kind: 'closed', message: DOOR_CLOSED };
    return { kind: 'failed', message: said ?? `The community couldn't start a 12-words account (${answer.status}). Try again, or sign in.` };
}

// ===================== THE NAME (design §2 screen 2) =====================

export type CallsignCheck = 'available' | 'taken' | 'unknown';

/** How long the name field rests before its name is checked: a fast typist's pauses don't each cost a request. */
export const NAME_CHECK_DEBOUNCE_MS = 700;

/**
 * Is `callsign` free here? UX only: the door lands a taken name on a free variant, and never blocks on it. `exclude`: a
 * member's own key, whose own name is never taken for a rename (engine/members.ts isCallsignAvailable).
 *
 * `joining`: the key joining through the open door, which signs the check (two-doors design §4.4): the node then counts
 * it against the door's limiter, 20 a minute for that key, instead of the 15 a minute that every check from one
 * address shares, which a hall on one Wi-Fi would spend on names alone. The join screens ask it debounced
 * (NAME_CHECK_DEBOUNCE_MS) and once per name.
 */
export async function checkCallsign(callsign: string, exclude?: string, joining?: BeanPoolIdentity | null): Promise<CallsignCheck> {
    const c = callsign.trim();
    if (c.length < 2) return 'unknown';
    try {
        const qs = exclude ? `?exclude=${encodeURIComponent(exclude)}` : '';
        const path = `/api/members/callsign-available/${encodeURIComponent(c)}${qs}`;
        const res = joining
            ? await signedFetchWithKey('GET', path, undefined, joining.privateKey, joining.publicKey)
            : await fetch(`${getNodeApiUrl()}${path}`, { cache: 'no-store' });
        if (!res.ok) return 'unknown';
        const data = await res.json();
        return data?.available === true ? 'available' : data?.available === false && !data?.tooShort ? 'taken' : 'unknown';
    } catch {
        return 'unknown';
    }
}

// The phone app's words for a taken name's suggestions (native utils/callsign-suggest.ts): "Sarah" → "Sarah Fox".
const NAME_WORDS = [
    'Fox', 'Wren', 'Maple', 'River', 'Willow', 'Otter', 'Clover', 'Finch', 'Reed',
    'Sage', 'Robin', 'Heron', 'Aspen', 'Fern', 'Lark', 'Cedar', 'Moss', 'Kite',
    'Bay', 'Wattle', 'Rosella', 'Pepper', 'Juniper', 'Hazel', 'Bramble', 'Coral',
    'Pippin', 'Sparrow', 'Banjo', 'Poppy', 'Reef', 'Dingo', 'Galah', 'Jarrah',
];

/** "<base> <word>" within `maxLength`, the word kept whole and the base cut between its words (as the phone app does). */
export function nameSuggestionFor(base: string, word: string, maxLength = 32): string {
    const full = `${base} ${word}`;
    if (full.length <= maxLength) return full;
    let head = base.slice(0, Math.max(0, maxLength - word.length - 1));
    if (base[head.length] !== ' ' && head.includes(' ')) head = head.slice(0, head.lastIndexOf(' '));
    head = head.trim();
    return head ? `${head} ${word}` : word.slice(0, maxLength);
}

/**
 * Up to `count` names for a taken `base` that the node says are free, `exclude` as for checkCallsign. Asked three at a
 * time, stopping once there are enough, so a burst doesn't meet the node's rate limit. [] when none could be checked:
 * the name field is the way on either way, and the node has the last word when the name is sent.
 */
export async function suggestCallsigns(base: string, exclude?: string, count = 3, maxLength = 32): Promise<string[]> {
    const clean = base.trim().replace(/\s+/g, ' ');
    if (!clean) return [];
    const words = [...NAME_WORDS];
    for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [words[i], words[j]] = [words[j], words[i]];
    }
    const candidates = words.map((w) => nameSuggestionFor(clean, w, maxLength));
    const free: string[] = [];
    for (let i = 0; i < candidates.length && free.length < count; i += 3) {
        const chunk = candidates.slice(i, i + 3);
        const checks = await Promise.all(chunk.map((c) => checkCallsign(c, exclude)));
        chunk.forEach((c, k) => { if (checks[k] === 'available') free.push(c); });
    }
    return free.slice(0, count);
}

// ===================== THE BROWSER =====================

/**
 * Can this browser hold a BeanPool key? The web app signs with WebCrypto Ed25519 (lib/api.ts, lib/mnemonic.ts),
 * which Chrome has from 113, Safari from 17 and Firefox from 130, and keeps it in IndexedDB. Asked before a key is
 * made, so an older browser is told plainly instead of failing halfway through a join.
 */
export async function browserCanHoldKey(): Promise<boolean> {
    return (await browserKeyProblem()) === null;
}

/**
 * Why this browser can't hold a key, or null when it can: 'storage' when it has nowhere to keep one (no IndexedDB, or open()
 * throws: an in-app browser, an older private mode), 'reload' when the store would not open twice running (not the
 * browser's fault to switch away from), 'old' when it lacks WebCrypto Ed25519. The screens
 * say each in its own words.
 */
export async function browserKeyProblem(): Promise<'storage' | 'reload' | 'old' | null> {
    try {
        const store = await identityStoreProblem();
        if (store === 'absent') return 'storage';
        if (store === 'failed') return 'reload';
        if (!globalThis.crypto?.subtle) return 'old';
        await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' } as unknown as AlgorithmIdentifier, false, ['sign', 'verify']);
        return null;
    } catch {
        return 'old';
    }
}

/** A nonce lives ten minutes on the node; one held longer than this is fetched again before it is sent to a provider. */
export const NONCE_FRESH_MS = 5 * 60 * 1000;

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
