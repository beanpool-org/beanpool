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
 * Every refusal leaves invites working. A door that refuses for good puts the phone back as it was
 * (`releaseJoinKey`): a key this join made comes off it again, and a wizard it was in comes back.
 */

import { importIdentity, loadIdentity, draftIdentity, discardUnjoinedIdentity, type BeanPoolIdentity } from './identity';
import { signedPost } from './node-post';
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
import { getPendingOnboarding, setPendingOnboarding, clearPendingOnboarding } from './onboarding-state';
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

/** Give up on the join request rather than hold a spinner with no answer. */
const JOIN_TIMEOUT_MS = 30_000;

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

/** The key the join signs with, and whether this join made it. */
export interface JoinKey {
    identity: BeanPoolIdentity;
    /** True: made for this join, not yet accepted anywhere. False: the phone already had it. */
    createdHere: boolean;
}

/** The phone's own key when it has one (never a second), otherwise a new one in memory, not yet saved. */
export async function joinKeyForThisPhone(): Promise<JoinKey> {
    const stored = await loadIdentity();
    if (stored) return { identity: stored, createdHere: false };
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
    let res: Response;
    try {
        res = await signedPost(url, JOIN_NONCE_PATH, {}, identity);
    } catch {
        return { kind: 'answered', answer: { kind: 'unreachable', message: DOOR_MESSAGES.unreachable } };
    }
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
 * Send the join, signed by `identity` (whose key the sign-in is bound to), carrying the recovery copy
 * sealed to the same sign-in. Never throws: every outcome is a `DoorAnswer`.
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
 */
export async function commitJoinKey(key: JoinKey, callsign: string): Promise<BeanPoolIdentity> {
    const identity = { ...key.identity, callsign };
    const current = await getPendingOnboarding();
    // A record with no key behind it describes nothing; only a key the phone already had has a wizard to keep.
    const before = key.createdHere ? null : current?.flow === 'global' ? current.before ?? null : current;
    if (key.createdHere) await importIdentity(identity);
    await setPendingOnboarding({
        step: 'globalJoin',
        flow: 'global',
        inviteCode: '',
        anchorUrl: GLOBAL_NODE_URL,
        callsign,
        redeemed: false,
        ...(key.createdHere ? { freshKey: identity.publicKey } : {}),
        ...(before ? { before } : {}),
    });
    return identity;
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
 * After a refusal for good (restore, or the door shut), put the phone back as it was before the door.
 * Returns whether a key came off it.
 *
 * - A key this join made comes off the phone, and the join's record with it.
 * - A key the phone already had stays. The record the join wrote gives way to the one the phone had before
 *   (`before`), or to none if it had none.
 * - A door that refused before anything was written (at the sign-in) leaves every record alone.
 */
export async function releaseJoinKey(key: JoinKey): Promise<boolean> {
    const current = await getPendingOnboarding();
    const removed = key.createdHere ? await discardUnjoinedIdentity(key.identity.publicKey) : false;
    if (current?.flow !== 'global') return removed;
    const before = key.createdHere ? null : current.before ?? null;
    if (before) {
        await setPendingOnboarding(before);
    } else {
        await clearPendingOnboarding();
    }
    return removed;
}
