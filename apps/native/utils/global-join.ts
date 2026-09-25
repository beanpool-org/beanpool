/**
 * Joining the global community (global.beanpool.org) without an invite: the door's client half.
 *
 * Design §2.3 (scratch/global-node/DESIGN-global-profile-fable.md). The server's half is
 * apps/server/src/routes/open-join.ts, which this file follows answer for answer.
 *
 * ## The order, and why the key comes first
 *
 * The door binds its sign-in to the key that is joining: the nonce request is signed by that key and
 * the nonce is spent only for it (`open-join:<key>`), and the join must be signed by the same key. So
 * the key exists before the sign-in. On a phone without one it is made in memory (`draftIdentity`),
 * the member signs in and chooses a name, and only then, on Join, is it written to the phone
 * (`commitJoinKey`) and the join sent. Nothing is stored for a member who backs out before Join.
 *
 * ## One identity per device
 *
 * A phone that already holds a key (an unfinished join wizard is the only way the welcome screen
 * shows with one) joins with THAT key, never a second one. A phone whose account is set up never
 * sees the welcome screen, so this door is not offered there.
 *
 * ## One sign-in, two jobs
 *
 * The join carries the seed sealed to the sign-in (`recovery: { shares }`), and the node stores it from
 * the identity it has just verified. The Safety Backup step then shows that sign-in as protecting the
 * member, with no second sign-in. A nonce is spent once, so the token could not be shown again anyway.
 * If the copy can't be made or stored, the join still stands and the step offers the ordinary connect.
 *
 * ## Never a hard gate
 *
 * Every refusal leaves invites working. A join that the door refuses for good puts the phone back as it was
 * (`releaseJoinKey`): a wizard it was in comes back, and a key this door made comes off again, but only
 * when no node can hold it.
 *
 * ## A key any node may hold is never taken off the phone
 *
 * The phone takes a key off only when all of these hold, each read from the saved record, never from memory:
 * - the door made it (`freshKey`), and no other join has used it since. An invite join that reuses the key
 *   takes that mark away before it sends it (`adoptJoinKey`), and replaces the record once it has redeemed;
 * - every join it signed was refused by the node (`joinsOut` is 0). A join counts from just before it is
 *   sent until the node refuses it. No answer, an unclear one or a 2xx leaves it counted;
 * - the refusal is the join's own. A refusal at the sign-in never takes a key off: a shut door says so
 *   before it looks for the member (open-join.ts `joiningKey`), so it says nothing about who is in.
 * When in doubt, the key stays with the door's record, and the next launch comes back to the door with it.
 * A key that is in answers `already_member` there once the door is open, and a member can restore instead.
 */

import { importIdentity, loadIdentity, draftIdentity, discardUnjoinedIdentity, type BeanPoolIdentity } from './identity';
import { signedGet, signedPost } from './node-post';
import { checkCallsignAvailable, suggestCallsigns } from './callsign-suggest';
import {
    readNonceResponse,
    signInWithApple,
    signInWithGoogle,
    signInWithFacebook,
    signInWithGithubViaNode,
    SsoSignInError,
    type SsoProvider,
    type GithubDevicePrompt,
    type GithubNodeRoutes,
} from './sso-signin';
import { extractSub } from './sso-sheet-connect';
import { sealSsoShares, enrolmentFromJoin, type KeeperEnrolmentResult } from './keeper-enrolment';
import { getPendingOnboarding, setPendingOnboarding, clearPendingOnboarding, type PendingOnboarding } from './onboarding-state';
import { GLOBAL_DOOR_MESSAGES, GLOBAL_NODE_URL } from './node-profile';

export const JOIN_NONCE_PATH = '/api/join/sso-nonce';
export const JOIN_PATH = '/api/join';
/** The door's own GitHub pair: the session is bound to the joining key, like the door's nonce. */
export const GITHUB_JOIN_ROUTES: GithubNodeRoutes = {
    start: '/api/join/github/start',
    poll: '/api/join/github/poll',
};

/** The name the server keeps: `/api/join` cuts a longer one at 20 characters. */
export const MAX_JOIN_NAME = 20;

/**
 * Give up on a door request (the nonce, the join) rather than hold a spinner with no answer. Nothing else
 * bounds how long a fetch may wait, and the door's screen can't be left while one is out.
 */
export const JOIN_TIMEOUT_MS = 30_000;

/** A sign-in done at the door: what the join proves itself with, and the subject the recovery copy is sealed to. */
export type DoorSignIn =
    | { provider: Exclude<SsoProvider, 'github'>; idToken: string; nonce: string; sub: string; email?: string }
    | { provider: 'github'; sessionId: string; sub: string; email?: string };

/** What the door said, as the member will meet it. */
export type DoorAnswer =
    /**
     * In: a 2xx, or this key is a member already (an earlier attempt landed and its answer was lost).
     * `callsign` is the name the node kept, when it says (it makes a taken name unique).
     */
    | { kind: 'joined'; enrolment: KeeperEnrolmentResult | null; callsign?: string }
    /** 409 `already_joined`: this sign-in account already has an identity there. Restore it. */
    | { kind: 'already_joined'; message: string }
    /** 403 `removed`: the identity this sign-in joined with was removed; it can't join again. */
    | { kind: 'removed'; message: string }
    /** 403 `key_invalidated`: this key was replaced by a re-key. */
    | { kind: 'key_invalidated'; message: string }
    /** 404 (`invite_only`) or another 403: the door is shut. */
    | { kind: 'door_closed'; message: string }
    /** 429: too many joins from this network, or the sign-in limiter. */
    | { kind: 'rate_limited'; message: string; retryAfterSeconds: number | null }
    /** 401: the sign-in was refused (expired, or not this request's). A new sign-in may work. */
    | { kind: 'sign_in_again'; message: string }
    /** 400, 5xx, anything else: nothing is wrong with the member. */
    | { kind: 'try_again'; message: string }
    /** No answer at all. */
    | { kind: 'unreachable'; message: string };

/** Where the member goes after each answer. */
export type DoorNext =
    /** On to Your Photo. */
    | 'continue'
    /** Their account exists: restore it. */
    | 'restore'
    /** This door won't open for this phone. Invites still work. */
    | 'closed'
    /** Stay on the door with the message, and sign in again to retry. */
    | 'retry';

export const DOOR_MESSAGES = {
    unreachable: GLOBAL_DOOR_MESSAGES.unreachable,
    doorClosed: GLOBAL_DOOR_MESSAGES.door_closed,
    alreadyJoined: 'This sign-in already has a BeanPool identity in the global community. Restore it with your 12 words or your sign-in instead.',
    removed: 'The BeanPool identity this sign-in joined with was removed from the global community, so it can\'t join again. You can still join a community with an invite.',
    keyInvalidated: 'This phone\'s key was replaced by a new one, so it can\'t join. Use the device or the 12 words that hold the new key.',
    rateLimited: 'Too many new accounts have joined from this network. Please try again later.',
    signInAgain: 'Your sign-in could not be used. Please sign in again.',
    tryAgain: 'Your join could not be completed, and nothing was saved. Please try again in a minute.',
} as const;

function said(body: unknown): string | undefined {
    const error = (body as { error?: unknown } | null)?.error;
    return typeof error === 'string' && error ? error.slice(0, 300) : undefined;
}

/** The name the node kept for the new member, from a join's `member`. */
function keptName(body: unknown): string | undefined {
    const name = (body as { member?: { callsign?: unknown } } | null)?.member?.callsign;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function codeOf(body: unknown): string | undefined {
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
}

/** `Retry-After` in seconds, when the answer carries a usable one. */
export function retryAfterSeconds(res: { headers?: { get?(name: string): string | null } } | null | undefined): number | null {
    const raw = res?.headers?.get?.('Retry-After');
    const seconds = raw == null ? NaN : Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * Read one answer from a door route (the nonce, GitHub start/poll, or the join) into what the member
 * meets. The node's own words are kept where they are about the member (already joined, removed, the
 * limit); its "This community is invite-only." is not, and is replaced.
 */
export function readDoorAnswer(status: number, body: unknown, retryAfter: number | null = null): DoorAnswer {
    const code = codeOf(body);
    if (status >= 200 && status < 300) {
        const callsign = keptName(body);
        return callsign ? { kind: 'joined', enrolment: null, callsign } : { kind: 'joined', enrolment: null };
    }
    if (status === 409 && code === 'already_member') return { kind: 'joined', enrolment: null };
    if (status === 409 && code === 'already_joined') return { kind: 'already_joined', message: said(body) ?? DOOR_MESSAGES.alreadyJoined };
    if (status === 403 && code === 'removed') return { kind: 'removed', message: said(body) ?? DOOR_MESSAGES.removed };
    if (status === 403 && code === 'key_invalidated') return { kind: 'key_invalidated', message: said(body) ?? DOOR_MESSAGES.keyInvalidated };
    if (status === 403 || status === 404) return { kind: 'door_closed', message: DOOR_MESSAGES.doorClosed };
    if (status === 429) {
        return { kind: 'rate_limited', message: said(body) ?? DOOR_MESSAGES.rateLimited, retryAfterSeconds: retryAfter };
    }
    if (status === 401) return { kind: 'sign_in_again', message: DOOR_MESSAGES.signInAgain };
    return { kind: 'try_again', message: said(body) ?? DOOR_MESSAGES.tryAgain };
}

export function nextStepFor(answer: DoorAnswer): DoorNext {
    switch (answer.kind) {
        case 'joined': return 'continue';
        case 'already_joined': return 'restore';
        case 'removed':
        case 'key_invalidated':
        case 'door_closed': return 'closed';
        default: return 'retry';
    }
}

/** What the member reads for an answer that is not `joined`, with when to try again if the node said. */
export function doorMessage(answer: Exclude<DoorAnswer, { kind: 'joined' }>): string {
    if (answer.kind === 'rate_limited' && answer.retryAfterSeconds) {
        const minutes = Math.ceil(answer.retryAfterSeconds / 60);
        return `${answer.message} (Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.)`;
    }
    return answer.message;
}

/** The door's screen, step by step (welcome.tsx). */
export type DoorPhase = 'checking' | 'unavailable' | 'signIn' | 'name' | 'joining' | 'restore' | 'closed';

/**
 * Which ways off the door's screen are open: "← Back to Home", and "Use a different sign-in" on the name step.
 * - The name step never closes them, not even while its check is out: leaving stops the check (`checkNameAtDoor`).
 * - While the join itself is out, neither is offered. The key is on the phone and the join is counted, and its
 *   answer, bounded by JOIN_TIMEOUT_MS, decides where the member goes.
 * - At the sign-in, Back waits for the nonce (bounded too) and the provider's own sheet. GitHub's code has its
 *   own Cancel, and Back stays open beside it.
 */
export function doorWaysOut(phase: DoorPhase, busy: boolean, showingGithubCode: boolean): { back: boolean; otherSignIn: boolean } {
    if (phase === 'joining') return { back: false, otherSignIn: false };
    if (phase === 'name') return { back: true, otherSignIn: true };
    return { back: !busy || showingGithubCode, otherSignIn: !busy };
}

/** What the door's name step found (`checkNameAtDoor`). */
export type NameCheck =
    /** Free, or the node couldn't say (it answered with an error): Join goes ahead, and the node makes a taken name unique. */
    | { kind: 'free' }
    /** Taken there. `suggestions` are free ones; none when they didn't come in time (`suggestionsTimedOut`). */
    | { kind: 'taken'; suggestions: string[]; suggestionsTimedOut: boolean }
    /** No answer in time. Nothing was stored or sent: the member taps Join again, or goes back. */
    | { kind: 'timed_out' }
    /** The member left the name step while it ran. */
    | { kind: 'cancelled' };

const STOPPED = Symbol('stopped');

/**
 * Check the chosen name at the door before anything is written or sent, as an invite join does, rather than have
 * the node quietly rename the member. Writes nothing.
 *
 * Bounded, like the door's other requests: the check and its suggestions get JOIN_TIMEOUT_MS between them. Nothing
 * else limits how long a fetch may wait, and a node that takes the connection and never answers held the name step
 * with every way out disabled. It also ends at once when `signal` aborts (Back to Home, Use a different sign-in),
 * and its requests are dropped with it. Either way it settles whatever the requests do.
 */
export async function checkNameAtDoor(
    url: string, name: string, key: JoinKey, options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NameCheck> {
    if (options.signal?.aborted) return { kind: 'cancelled' };
    const stop = new AbortController();
    let timedOut = false;
    const leave = () => stop.abort();
    options.signal?.addEventListener('abort', leave);
    const timer = setTimeout(() => { timedOut = true; stop.abort(); }, options.timeoutMs ?? JOIN_TIMEOUT_MS);
    const stopped = new Promise<typeof STOPPED>((resolve) => stop.signal.addEventListener('abort', () => resolve(STOPPED)));
    try {
        // A key the phone already has is left out: its own name there reads as free.
        const exclude = key.createdHere ? undefined : key.identity.publicKey;
        const availability = await Promise.race([checkCallsignAvailable(name, exclude, url, { signal: stop.signal }), stopped]);
        if (availability === STOPPED) return timedOut ? { kind: 'timed_out' } : { kind: 'cancelled' };
        if (availability !== 'taken') return { kind: 'free' };
        // No longer than the join keeps: a suggestion is sent exactly as it was checked and shown.
        const suggestions = await Promise.race([
            suggestCallsigns(name, undefined, 3, url, MAX_JOIN_NAME, { signal: stop.signal }),
            stopped,
        ]);
        if (suggestions === STOPPED) {
            return timedOut ? { kind: 'taken', suggestions: [], suggestionsTimedOut: true } : { kind: 'cancelled' };
        }
        return { kind: 'taken', suggestions, suggestionsTimedOut: false };
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', leave);
    }
}

/** What the name step says when its check doesn't lead to the join. Empty for `free` and `cancelled`. */
export function nameCheckMessage(name: string, check: NameCheck): string {
    switch (check.kind) {
        case 'timed_out':
            return 'The global community didn\'t answer in time, so your name wasn\'t checked and nothing was sent. '
                + 'Check your connection, then tap Join to try again, or go back.';
        case 'taken':
            if (check.suggestionsTimedOut) {
                return `"${name}" is already taken in the global community, and suggestions didn't load in time. Choose another name, then tap Join.`;
            }
            return check.suggestions.length > 0
                ? `"${name}" is already taken in the global community. Pick one of the suggestions below, or choose another name.`
                : `"${name}" is already taken in the global community. Choose another name.`;
        default:
            return '';
    }
}

/** The key the join signs with, and whether this door made it. */
export interface JoinKey {
    identity: BeanPoolIdentity;
    /**
     * True: made by this door, only in memory or with the door's own record saying so (`freshKey`). False: the
     * phone already had it, or an invite join has taken it over since. What the screen shows and checks; nothing
     * is written or taken off on it alone (`commitJoinKey` and `releaseJoinKey` read the record again).
     */
    createdHere: boolean;
}

/** The saved record says the door made this key and no other join has used it (`adoptJoinKey` takes the mark away). */
function madeByTheDoor(record: PendingOnboarding | null, publicKey: string): boolean {
    return record?.flow === 'global' && typeof record.freshKey === 'string' && record.freshKey === publicKey;
}

/**
 * The phone's own key when it has one (never a second), otherwise `held` when it is a key this door made,
 * otherwise a new one in memory, not yet saved.
 *
 * Asked again at every sign-in, with the key the door already holds. A key made on an earlier visit and never
 * written never outranks one the phone has stored since (an invite join started in between): `commitJoinKey`
 * would write it over that account. Whether a stored key is the door's comes from the saved record, never from
 * `held`: an invite join that took the key over has replaced that record, and the key is its now.
 */
export async function joinKeyForThisPhone(held: JoinKey | null = null): Promise<JoinKey> {
    const stored = await loadIdentity();
    if (stored) {
        return { identity: stored, createdHere: madeByTheDoor(await getPendingOnboarding(), stored.publicKey) };
    }
    if (held?.createdHere) return held;
    return { identity: await draftIdentity(), createdHere: true };
}

/**
 * Sign in at the door with `identity`'s key: the node's nonce (signed, bound to that key), then the
 * provider, or GitHub run by the node. `answered` is the door refusing before any sign-in (shut, a
 * limit), or `joined` when this key is already a member (an earlier join landed). A provider that
 * fails or is cancelled throws `SsoSignInError`, as everywhere else.
 */
export async function signInAtDoor(
    provider: SsoProvider,
    url: string,
    identity: BeanPoolIdentity,
    options: { onGithubPrompt?: (prompt: GithubDevicePrompt) => void; signal?: AbortSignal } = {},
): Promise<{ kind: 'signed_in'; signin: DoorSignIn } | { kind: 'answered'; answer: DoorAnswer }> {
    let res: Response | null;
    try {
        res = await withTimeout(signedPost(url, JOIN_NONCE_PATH, {}, identity), JOIN_TIMEOUT_MS);
    } catch {
        res = null;
    }
    if (!res) return { kind: 'answered', answer: { kind: 'unreachable', message: DOOR_MESSAGES.unreachable } };
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { kind: 'answered', answer: readDoorAnswer(res.status, body, retryAfterSeconds(res)) };

    const { nonce, providers, githubFlow } = readNonceResponse(body);
    // The node's list: offering a provider it will refuse is a sign-in that succeeds and is then thrown away.
    if (providers.length > 0 && !providers.includes(provider)) {
        throw new SsoSignInError('unsupported', `The global community does not accept ${provider} sign-in.`);
    }
    if (provider === 'github') {
        const signin = await signInWithGithubViaNode({
            post: (path, postBody) => signedPost(url, path, postBody, identity),
            routes: GITHUB_JOIN_ROUTES,
            githubFlow,
            onPrompt: options.onGithubPrompt ?? (() => {}),
            signal: options.signal,
        });
        return { kind: 'signed_in', signin: { provider, ...signin } };
    }
    const signin = provider === 'apple'
        ? await signInWithApple(nonce)
        : provider === 'google'
            ? await signInWithGoogle(nonce)
            : await signInWithFacebook(nonce);
    let sub: string;
    try {
        sub = extractSub(signin.idToken);
    } catch {
        // Refused here rather than sealed to nothing: a copy sealed to a missing subject can never be opened.
        throw new SsoSignInError('provider', 'That sign-in did not say who you are, so it can\'t be used. Try again.');
    }
    return { kind: 'signed_in', signin: { provider, idToken: signin.idToken, nonce: signin.nonce, sub, email: signin.email } };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * The node refused this join, so it did not put the key on the node: every answer it gives before or instead of
 * adding the member. Not a 2xx (in), no answer, or `try_again` (a 5xx may come from a proxy after the node
 * has taken the join).
 */
function refusedByTheNode(answer: DoorAnswer): boolean {
    switch (answer.kind) {
        case 'already_joined':
        case 'removed':
        case 'key_invalidated':
        case 'door_closed':
        case 'rate_limited':
        case 'sign_in_again':
            return true;
        default:
            return false;
    }
}

/**
 * A join signed by the door's own key is about to go out: count it on the phone first, so a join that lands
 * with its answer lost, or with the app stopped, is never forgotten (`joinsOut`). False when the count could
 * not be written; the join is then not sent. True when there is nothing to count (not the door's key).
 */
async function countJoinOut(publicKey: string): Promise<boolean> {
    const record = await getPendingOnboarding();
    if (!record || !madeByTheDoor(record, publicKey)) return true;
    const joinsOut = (record.joinsOut ?? 0) + 1;
    await setPendingOnboarding({ ...record, joinsOut });
    return (await getPendingOnboarding())?.joinsOut === joinsOut;
}

/** The node refused a join signed by the door's own key: it no longer counts. */
async function countJoinRefused(publicKey: string): Promise<void> {
    const record = await getPendingOnboarding();
    if (!record || !madeByTheDoor(record, publicKey) || !record.joinsOut) return;
    await setPendingOnboarding({ ...record, joinsOut: record.joinsOut - 1 });
}

/**
 * Send the join, signed by `identity` (whose key the sign-in is bound to), carrying the recovery copy
 * sealed to the same sign-in. Never throws: every outcome is a `DoorAnswer`.
 *
 * A join signed by the door's own key is counted on the phone before it goes, and stops counting only when
 * the node refuses it (`joinsOut`, which `releaseJoinKey` reads).
 */
export async function submitJoin(
    url: string, identity: BeanPoolIdentity, callsign: string, signin: DoorSignIn,
): Promise<DoorAnswer> {
    // A copy that can't be made never stops the join: the 12 words are the key, and Safety Backup offers
    // the ordinary connect. Why it failed goes to the log; never the words or the key.
    let recovery: { shares: unknown[] } | null = null;
    let wordsSealed = false;
    try {
        const sealed = await sealSsoShares(identity, signin.provider, signin.sub);
        recovery = { shares: sealed.shares };
        wordsSealed = sealed.wordsSealed;
    } catch (e) {
        console.log(`[JOIN] ${signin.provider}: no recovery copy with the join — ${(e as Error).message}`);
    }

    const proof = signin.provider === 'github'
        ? { proof: { sessionId: signin.sessionId } }
        : { idToken: signin.idToken, nonce: signin.nonce };
    const body = {
        callsign: callsign.trim().slice(0, MAX_JOIN_NAME).trim(),
        provider: signin.provider,
        ...proof,
        ...(recovery ? { recovery } : {}),
    };

    if (!(await countJoinOut(identity.publicKey))) return { kind: 'try_again', message: DOOR_MESSAGES.tryAgain };
    let res: Response | null;
    try {
        res = await withTimeout(signedPost(url, JOIN_PATH, body, identity), JOIN_TIMEOUT_MS);
    } catch {
        res = null;
    }
    if (!res) return { kind: 'unreachable', message: DOOR_MESSAGES.unreachable };
    const answerBody = await res.json().catch(() => ({}));
    const answer = readDoorAnswer(res.status, answerBody, retryAfterSeconds(res));
    console.log(`[JOIN] ${signin.provider}: the door answered ${res.status} (${answer.kind})`);
    if (refusedByTheNode(answer)) await countJoinRefused(identity.publicKey);
    if (answer.kind === 'joined' && res.ok && recovery) {
        return {
            ...answer,
            enrolment: enrolmentFromJoin((answerBody as { recovery?: unknown }).recovery, signin.provider, wordsSealed),
        };
    }
    return answer;
}

/**
 * Write the join's key to the phone (when this join made it) and the wizard's record, just before the
 * join is sent: an app killed while the join is in flight comes back to the door with the same key, and
 * the node then says whether it landed (`already_member` reads as joined).
 *
 * A phone that already had a key may be part-way through an invite join. That record is kept inside this
 * one (`before`), so a door that then refuses can give it back, even after a restart.
 *
 * Whether the key is the door's is read again here, from what the phone holds, never taken from `key`: a key
 * only in memory is the door's; a stored one is the door's only while the door's record says so (`freshKey`).
 * The count of joins that key has signed (`joinsOut`) carries over from the door's earlier tries.
 */
export async function commitJoinKey(key: JoinKey, callsign: string): Promise<BeanPoolIdentity> {
    const identity = { ...key.identity, callsign };
    const stored = await loadIdentity();
    if (stored && stored.publicKey !== identity.publicKey) {
        throw new Error('This phone holds a different BeanPool account, so the join was not sent.');
    }
    const current = await getPendingOnboarding();
    const doorsOwn = madeByTheDoor(current, identity.publicKey);
    const madeHere = stored ? doorsOwn : key.createdHere;
    // A record with no key behind it describes nothing; only a key the phone already had has a wizard to keep.
    const before = !stored ? null : current?.flow === 'global' ? current.before ?? null : current;
    if (!stored || madeHere) await importIdentity(identity);
    await setPendingOnboarding({
        step: 'globalJoin',
        flow: 'global',
        inviteCode: '',
        anchorUrl: GLOBAL_NODE_URL,
        callsign,
        redeemed: false,
        ...(madeHere ? { freshKey: identity.publicKey, joinsOut: doorsOwn ? current?.joinsOut ?? 0 : 0 } : {}),
        ...(before ? { before } : {}),
    });
    return identity;
}

/**
 * An invite join is about to send this key to its community (handleCreate reuses the phone's key): from here
 * the door never takes it off the phone. Its record loses `freshKey` now, before the invite is redeemed, so a
 * redeem that lands with its answer lost is covered too; a redeem that works replaces the record anyway.
 * Leaves any other record alone.
 */
export async function adoptJoinKey(publicKey: string): Promise<void> {
    const record = await getPendingOnboarding();
    if (!record || !madeByTheDoor(record, publicKey)) return;
    const adopted: PendingOnboarding = { ...record };
    delete adopted.freshKey;
    delete adopted.joinsOut;
    await setPendingOnboarding(adopted);
}

/**
 * In: the key the node has just accepted is this phone's, under the name the node kept. Returns the identity
 * the phone now holds, which the rest of the wizard carries on with.
 *
 * Written here as well as at Join, for two reasons:
 * - The node may have kept a different name (it makes a taken one unique). The phone must hold that one,
 *   or a restart reads the old name back and the phone and the node disagree about who this is.
 * - A phone that learns at the sign-in that it is in already (`already_member`) never passes through
 *   `commitJoinKey`. Its key has to be on the phone before the wizard's record says it joined: a record
 *   with no key behind it is dropped on the next launch (onboarding-state.ts `resumePlan`).
 *
 * A key the phone already holds keeps everything but its name. Never writes over a different key: one
 * identity per device, and a phone that somehow holds another account refuses rather than replaces it.
 */
export async function keepJoinedIdentity(identity: BeanPoolIdentity): Promise<BeanPoolIdentity> {
    const stored = await loadIdentity();
    if (stored && stored.publicKey !== identity.publicKey) {
        throw new Error('This phone holds a different BeanPool account, so the join was not saved here.');
    }
    if (!stored) {
        await importIdentity(identity);
        return identity;
    }
    const callsign = identity.callsign || stored.callsign;
    if (stored.callsign === callsign) return stored;
    const kept = { ...stored, callsign };
    await importIdentity(kept);
    return kept;
}

/**
 * The name the node holds for this key, from the member's own profile, read signed by the key: read auth answers a
 * member, and the key is one now. Null when it can't be read in time, or doesn't say: never a guess.
 */
async function nameTheNodeHolds(url: string, identity: BeanPoolIdentity): Promise<string | null> {
    try {
        return await withTimeout((async () => {
            const res = await signedGet(url, `/api/profile/${identity.publicKey}`, identity);
            if (!res.ok) return null;
            const name = ((await res.json().catch(() => null)) as { callsign?: unknown } | null)?.callsign;
            return typeof name === 'string' && name.trim() ? name.trim() : null;
        })(), JOIN_TIMEOUT_MS);
    } catch {
        return null;
    }
}

/**
 * The identity a join the node took is kept under ({@link keepJoinedIdentity} writes it): the name the node kept,
 * which may not be the one typed (it makes a taken name unique, "Sam" → "Sam 2").
 *
 * A join's own 2xx says the name. `already_member` doesn't: an earlier join landed and its answer was lost, and the
 * phone hears so at the next sign-in (after a resume, or a restart) or at the join. Then the node is asked. When it
 * can't be, the typed name stays, as it did before this asked: no screen says the node kept it.
 */
export async function joinedUnderNodeName(
    url: string, answer: Extract<DoorAnswer, { kind: 'joined' }>, identity: BeanPoolIdentity,
): Promise<BeanPoolIdentity> {
    const callsign = answer.callsign ?? await nameTheNodeHolds(url, identity);
    return callsign ? { ...identity, callsign } : identity;
}

/**
 * After the node refused a join for good (restore, removed, or the door shut), put the phone back as it was
 * before the door. Returns whether a key came off it. Only for the join's own refusal: the screen never calls
 * it for a refusal at the sign-in, which leaves every key and record where it is.
 *
 * Decided from the saved record alone, never from `key.createdHere`:
 * - A key the door made (`freshKey`) comes off, with the door's record, only when no join it signed can have
 *   landed (`joinsOut` is 0): every one was refused by the node. It was never offered to another community
 *   (`adoptJoinKey`), so no node holds it.
 * - A key the door made that a join may have put on the node stays, and so does the door's record: the next
 *   launch comes back to the door with it, where a member answers `already_member` once the door is open.
 * - A key the phone already had, or one an invite join has taken over, stays. The record the join wrote gives
 *   way to the one the phone had before (`before`), or to none if it had none.
 * - With no door record on the phone (nothing was written for the door), nothing changes and nothing comes off.
 */
export async function releaseJoinKey(key: JoinKey): Promise<boolean> {
    const current = await getPendingOnboarding();
    if (current?.flow !== 'global') return false;
    const publicKey = key.identity.publicKey;
    if (madeByTheDoor(current, publicKey)) {
        if ((current.joinsOut ?? 0) > 0) return false;
        const removed = await discardUnjoinedIdentity(publicKey);
        await clearPendingOnboarding();
        return removed;
    }
    if (current.before) {
        await setPendingOnboarding(current.before);
    } else {
        await clearPendingOnboarding();
    }
    return false;
}
