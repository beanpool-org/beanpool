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
 * ## One sign-in, two jobs: the door's shared ticket (key vault design §5.4)
 *
 * The phone asks BeanPool's key vault for a deposit ticket naming the joining key, checks it against the vault's
 * pinned keys, and gives the provider the ticket's hash as its nonce (utils/vault.ts `vaultTicket`). The same token
 * then goes twice: in the join to global, with the ticket (`vaultTicket`), which the door checks with its own copy of
 * the vault's public key; and, once the door has let the member in, with the copy to the vault (`depositWithVault`).
 * No copy rides in the join: global never holds one. The Safety Backup step then shows that sign-in as protecting the
 * member, with no second sign-in. If the copy can't be made or stored, the join still stands and the step offers the
 * ordinary connect.
 *
 * When the vault can't give a ticket (paused or unreachable), the door uses its own nonce (`/api/join/sso-nonce`) and
 * the member joins without a copy: the vault is never a gate on joining.
 *
 * ## Only at a door that takes the ticket (V5, scratch/global-node/DESIGN-v5-global-door-vault-fable.md §3)
 *
 * A door takes the vault's tickets only when its operator pinned the vault's public ticket keys
 * (`BEANPOOL_VAULT_TICKET_KEYS`), and its nonce answer says which (`vault.ticketKeys`). So no order of rollout blocks
 * a join:
 * - Ask first ({@link doorTicketKeys}). The ticket path runs only when the door lists a key this build pins, and the
 *   ticket is used only when the door lists the key that signed it. Otherwise (a door from before V5, a door with no
 *   keys set, a stranger's door, another vault's keys) the door's own nonce, nothing asked of the vault, and the member
 *   joins without a copy. Safety Backup then offers the ordinary connect, at the vault only.
 * - The backstop ({@link submitJoin}). A 401 to a join that carried a ticket, whatever its code (an older door says
 *   `sign_in`; a V5 door says `ticket_*`), opens the provider's sheet once more, by itself, with the door's own nonce
 *   and a one-line notice, and the join goes again without the ticket. A second 401 is "sign in again", as ever.
 * A phone at any other community never meets this: the door is the global community's alone.
 *
 * ## A build without a vault (utils/vault.ts `signInCopiesAt`): the copy rides in the join, as before the vault
 *
 * The door's own nonce, and the join carries the seed sealed to the sign-in (`recovery: { shares }`); global stores
 * it from the identity it has just verified, and its answer is read back by keeper-enrolment.ts `enrolmentFromJoin`.
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
    signInWithProvider,
    SsoSignInError,
    type NodeNonce,
    type SsoProvider,
} from './sso-signin';
import { checkVaultTicket } from '@beanpool/core';
import { extractSub } from './sso-sheet-connect';
import { enrolmentFromJoin, enrolmentFromVault, sealSsoShares, type KeeperEnrolmentResult } from './keeper-enrolment';
import { depositWithVault, signInCopiesAt, vaultConfig, vaultTicket, VaultError } from './vault';
import { getPendingOnboarding, setPendingOnboarding, clearPendingOnboarding, type PendingOnboarding } from './onboarding-state';
import { GLOBAL_DOOR_MESSAGES, GLOBAL_NODE_URL } from './node-profile';
import type { DoorWorkDoor } from '@beanpool/core';
import type { DoorWorkOutcome, DoorWorkRun, DoorWorkSolution } from './door-work';

export const JOIN_NONCE_PATH = '/api/join/sso-nonce';
export const JOIN_PATH = '/api/join';

/** The name the server keeps: `/api/join` cuts a longer one at 20 characters. */
export const MAX_JOIN_NAME = 20;

/**
 * Give up on a door request (the nonce, the join) rather than hold a spinner with no answer. Nothing else
 * bounds how long a fetch may wait, and the door's screen can't be left while one is out.
 */
export const JOIN_TIMEOUT_MS = 30_000;

/** A sign-in done at the door: what the join proves itself with, and the subject the recovery copy is sealed to. */
export interface DoorSignIn {
    provider: SsoProvider;
    idToken: string;
    nonce: string;
    sub: string;
    email?: string;
    /**
     * The key vault's deposit ticket the nonce is the hash of: the join carries it for the door to check, and the
     * deposit spends it at the vault. Absent when the vault gave none, and then the join carries no copy.
     */
    vaultTicket?: string;
}

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
    /** 403 `account_closed`: global closed this key's account (deleted by its owner, or removed). It can't join again. */
    | { kind: 'account_closed'; message: string }
    /** 404 (`invite_only`) or another 403: the door is shut. */
    | { kind: 'door_closed'; message: string }
    /**
     * 429: too many joins from this network (`network_busy`, with the door it was about), or the door's own limiter.
     * `timed`: the message already says when to try again, from `Retry-After` ({@link doorMessage} adds nothing).
     */
    | { kind: 'rate_limited'; message: string; retryAfterSeconds: number | null; door?: DoorWorkDoor; timed?: boolean }
    /**
     * 400 `work_required`, `work_invalid`, `work_expired`, `work_spent`: the door work didn't count. The phone fetches a
     * new challenge and solves it by itself; the member reads `message` only when that happens twice.
     */
    | { kind: 'work_again'; code: WorkRefusalCode; message: string }
    /** 403 `sign_in_required`: this door takes no 12-words joins (now). The sign-in door is still open. */
    | { kind: 'sign_in_required'; message: string }
    /** 401: the sign-in was refused (expired, or not this request's). A new sign-in may work. */
    | { kind: 'sign_in_again'; message: string }
    /**
     * 401 with no code on the 12-words path ({@link readWordsDoorAnswer}): the node's signature check refused the request's
     * time, which is the phone's clock. There is no sign-in there to redo: the phone's date and time are the fix.
     */
    | { kind: 'phone_clock'; message: string }
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
    | 'retry'
    /** The 12-words way is shut here: the sign-in buttons, with the message. */
    | 'sign_in';

export const DOOR_MESSAGES = {
    unreachable: GLOBAL_DOOR_MESSAGES.unreachable,
    doorClosed: GLOBAL_DOOR_MESSAGES.door_closed,
    alreadyJoined: 'This sign-in already has a BeanPool identity in the global community. Restore it with your 12 words or your sign-in instead.',
    accountClosed: 'This account\'s place in the global community was closed, so it can\'t join again.',
    removed: 'The BeanPool identity this sign-in joined with was removed from the global community, so it can\'t join again. You can still join a community with an invite.',
    keyInvalidated: 'This phone\'s key was replaced by a new one, so it can\'t join. Use the device or the 12 words that hold the new key.',
    rateLimited: 'Too many new accounts have joined from this network. Please try again later.',
    /** 403 `sign_in_required`: a door that takes no 12-words joins. */
    signInRequired: 'This community needs a sign-in to join: Google, Apple or Facebook. You can sign in below.',
    signInAgain: 'Your sign-in could not be used. Please sign in again.',
    /** A 401 with no code on the 12-words path: the phone's clock (PR #1452 review, finding 3). */
    phoneClock: 'The global community couldn\'t accept this because your phone\'s date and time look wrong. Check them in your phone\'s settings (set them to automatic), then try again.',
    tryAgain: 'Your join could not be completed, and nothing was saved. Please try again in a minute.',
    /** Under the joining spinner while the provider's sheet opens once more, with the door's own nonce ({@link submitJoin}). */
    signInAnotherWay: 'Checking your sign-in another way…',
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

/** The door work's refusals (apps/server services/door-work.ts): each means "fetch a new challenge and solve it". */
export type WorkRefusalCode = 'work_required' | 'work_invalid' | 'work_expired' | 'work_spent';
const WORK_REFUSAL_CODES: readonly string[] = ['work_required', 'work_invalid', 'work_expired', 'work_spent'];

/**
 * What the member reads when the work didn't count twice in a row. The node's own sentence for `work_required` tells an
 * app from before the work to update, which this app is not, so the phone says its own for every code.
 */
export const WORK_MESSAGES: Record<WorkRefusalCode, string> = {
    work_required: 'Setting up your account didn\'t finish. Please try again.',
    work_invalid: 'Setting up your account didn\'t work out. Please try again.',
    work_expired: 'That took a while, so setting up your account had to start again, and it didn\'t finish. Please try again.',
    work_spent: 'Setting up your account didn\'t work out. Please try again.',
};

/**
 * "in 5 minutes", "in a minute", "in about 3 hours": `Retry-After` in the member's words. Under a minute reads as a
 * minute: nobody can act on seconds.
 */
export function tryAgainIn(seconds: number): string {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    if (minutes < 60) return minutes === 1 ? 'in a minute' : `in ${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

/** The node's `Retry-After`, or its body's `retryAfterSeconds` when a header was lost on the way. */
function waitFrom(body: unknown, header: number | null): number | null {
    if (header) return header;
    const own = (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    return typeof own === 'number' && Number.isFinite(own) && own > 0 ? Math.ceil(own) : null;
}

/**
 * A 429, said by the phone with when to try again in it. `network_busy` names its door: the 12-words door's sentence
 * sends the member to the sign-in door, which stays open (design §4.3). Anything else at 429 with no code is the door's
 * own limiter (too many tries from one phone or network in a minute).
 */
function busyAnswer(body: unknown, retryAfter: number | null): Extract<DoorAnswer, { kind: 'rate_limited' }> | null {
    const b = body as { code?: unknown; door?: unknown; window?: unknown } | null;
    const wait = waitFrom(body, retryAfter);
    const when = wait ? tryAgainIn(wait) : 'later';
    const span = b?.window === 'day' ? 'today' : 'in the last hour';
    if (b?.code === 'network_busy' || b?.code === 'network_busy_words') {
        const words = b.door === 'words' || b.code === 'network_busy_words';
        return words
            ? {
                kind: 'rate_limited', door: 'words', timed: true, retryAfterSeconds: wait,
                message: `A very large number of 12-words accounts were made from your network ${span}. Sign in to join now, or try again ${when}.`,
            }
            : {
                kind: 'rate_limited', door: 'sign-in', timed: true, retryAfterSeconds: wait,
                message: `Too many new accounts have joined from your network ${span}. Please try again ${when}.`,
            };
    }
    if (b?.code === undefined && wait) {
        return { kind: 'rate_limited', timed: true, retryAfterSeconds: wait, message: `There were too many tries in a short time. Please try again ${when}.` };
    }
    return null;
}

/**
 * Read one answer from a door route (the work, the nonce, or the join) into what the member meets: a sentence, never a
 * code. The node's own words are kept where they are about the member (already joined, removed); its "This community
 * is invite-only." is not, and is replaced, and the phone says the limits and the work's refusals itself.
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
    if (status === 403 && code === 'account_closed') return { kind: 'account_closed', message: DOOR_MESSAGES.accountClosed };
    if (status === 403 && code === 'sign_in_required') return { kind: 'sign_in_required', message: DOOR_MESSAGES.signInRequired };
    // A node in a private preview (server config/private-preview.ts) says why in its own words: shown as-is.
    if (status === 403 && code === 'private_preview') return { kind: 'door_closed', message: said(body) ?? PRIVATE_PREVIEW_MESSAGE };
    if (status === 403 || status === 404) return { kind: 'door_closed', message: DOOR_MESSAGES.doorClosed };
    if (status === 400 && code && WORK_REFUSAL_CODES.includes(code)) {
        return { kind: 'work_again', code: code as WorkRefusalCode, message: WORK_MESSAGES[code as WorkRefusalCode] };
    }
    if (status === 429) {
        return busyAnswer(body, retryAfter)
            ?? { kind: 'rate_limited', message: said(body) ?? DOOR_MESSAGES.rateLimited, retryAfterSeconds: waitFrom(body, retryAfter) };
    }
    if (status === 401) return { kind: 'sign_in_again', message: DOOR_MESSAGES.signInAgain };
    return { kind: 'try_again', message: said(body) ?? DOOR_MESSAGES.tryAgain };
}

/** The server's sentence for a private preview, for a node that somehow sent none. */
export const PRIVATE_PREVIEW_MESSAGE = 'This community is in a private preview. Ask its owner for an invite.';

/**
 * {@link readDoorAnswer} for the routes the 12-words way meets (the work route, at either door, and the 12-words join):
 * none of them carries a sign-in, so a 401 with no code can only be the signature check refusing the request's time,
 * which is the phone's clock (more than 5 minutes off). Never "sign in again" there: there is no sign-in to redo.
 */
export function readWordsDoorAnswer(status: number, body: unknown, retryAfter: number | null = null): DoorAnswer {
    if (status === 401 && codeOf(body) === undefined) return { kind: 'phone_clock', message: DOOR_MESSAGES.phoneClock };
    if (status === 401) return { kind: 'try_again', message: DOOR_MESSAGES.tryAgain };
    return readDoorAnswer(status, body, retryAfter);
}

export function nextStepFor(answer: DoorAnswer): DoorNext {
    switch (answer.kind) {
        case 'joined': return 'continue';
        case 'already_joined': return 'restore';
        case 'removed':
        case 'key_invalidated':
        case 'account_closed':
        case 'door_closed': return 'closed';
        case 'sign_in_required': return 'sign_in';
        default: return 'retry';
    }
}

/** What the member reads for an answer that is not `joined`, with when to try again if the node said. */
export function doorMessage(answer: Exclude<DoorAnswer, { kind: 'joined' }>): string {
    if (answer.kind === 'rate_limited' && answer.retryAfterSeconds && !answer.timed) {
        return `${answer.message} (Try again ${tryAgainIn(answer.retryAfterSeconds)}.)`;
    }
    return answer.message;
}

/**
 * The door's screen, step by step (welcome.tsx, join-global.tsx). `choose` is the door's first screen on a node with
 * the 12-words door: 12 words, or a sign-in, side by side. A node without it starts at `signIn`, as before.
 */
export type DoorPhase = 'checking' | 'unavailable' | 'choose' | 'signIn' | 'name' | 'joining' | 'restore' | 'closed';

/** Which way in the member chose at the door. */
export type DoorWay = 'words' | 'sign-in';

/**
 * Which ways off the door's screen are open: "← Back to Home", and "Use a different sign-in" on the name step.
 * - The name step never closes them, not even while its check is out: leaving stops the check (`checkNameAtDoor`).
 * - While the join itself is out, neither is offered. The key is on the phone and the join is counted, and its
 *   answer decides where the member goes: bounded by JOIN_TIMEOUT_MS, except the backstop's second sheet
 *   ({@link submitJoin}), which the member can cancel.
 * - At the sign-in, Back waits for the nonce (bounded too) and the provider's own sheet.
 */
export function doorWaysOut(phase: DoorPhase, busy: boolean): { back: boolean; otherSignIn: boolean } {
    if (phase === 'joining') return { back: false, otherSignIn: false };
    if (phase === 'name') return { back: true, otherSignIn: true };
    return { back: !busy, otherSignIn: !busy };
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
        // A key the phone already has is left out: its own name there reads as free. Signed by the joining key, so the
        // door's limiter counts it (20 a minute per key), not the 15 a minute every unsigned check from one network shares.
        const exclude = key.createdHere ? undefined : key.identity.publicKey;
        const availability = await Promise.race([checkCallsignAvailable(name, exclude, url, { signal: stop.signal, signer: key.identity }), stopped]);
        if (availability === STOPPED) return timedOut ? { kind: 'timed_out' } : { kind: 'cancelled' };
        if (availability !== 'taken') return { kind: 'free' };
        // No longer than the join keeps: a suggestion is sent exactly as it was checked and shown.
        const suggestions = await Promise.race([
            suggestCallsigns(name, undefined, 3, url, MAX_JOIN_NAME, { signal: stop.signal, signer: key.identity }),
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
 * The vault ticket keys this door takes that this build pins: the door's own list (its nonce answer's `vault`, V5
 * design §1.3), kept to the keys the build has built in. Empty when the door names none (a door from before V5, or one
 * whose operator set none) or only keys of another vault: then the phone asks the vault for nothing at this door.
 */
export function doorTicketKeys(doorKeys: { ticketKeys: string[] } | null): string[] {
    const pinned = vaultConfig()?.ticketKeys ?? [];
    return (doorKeys?.ticketKeys ?? []).filter(key => pinned.includes(key));
}

/**
 * A key vault deposit ticket for the joining key (design §5.4) that this door takes, or null: the door takes none of
 * this build's keys ({@link doorTicketKeys}, and the vault is not asked), the vault can't give one (paused,
 * unreachable, or an answer that doesn't check out against its pinned keys), or the ticket is signed by a pinned key
 * the door doesn't list (a key rotation the door's list hasn't caught up with). Null is never a refusal: the door's own
 * nonce is used, and the member joins without a copy.
 */
export async function doorVaultTicket(
    provider: SsoProvider, identity: BeanPoolIdentity, ticketKeys: string[],
): Promise<{ ticket: string; nonce: string } | null> {
    if (ticketKeys.length === 0) {
        console.log(`[JOIN] ${provider}: the door takes no key vault ticket this app can get; joining with its own nonce, without a copy`);
        return null;
    }
    let grant: { ticket: string; nonce: string };
    try {
        grant = await vaultTicket(identity, 'deposit', provider);
    } catch (e) {
        console.log(`[JOIN] ${provider}: no key vault ticket (${e instanceof VaultError ? e.reason : (e as Error).message}); joining without a copy`);
        return null;
    }
    // Checked against the door's keys as the door will check it, so a ticket it would refuse never costs a sheet.
    const atTheDoor = checkVaultTicket(grant.ticket, { ticketKeys, now: Date.now(), key: identity.publicKey, purpose: 'deposit' });
    if (!atTheDoor.ok) {
        console.log(`[JOIN] ${provider}: the door would not take this key vault ticket (${atTheDoor.reason}); joining without a copy`);
        return null;
    }
    return grant;
}

/**
 * The door's nonce, asked for signed by `identity`'s key, or the door's answer when it gives none: shut, a limit, this
 * key a member already, or no answer at all. Throws `SsoSignInError` when the door doesn't take `provider`.
 */
async function askTheDoor(
    provider: SsoProvider, url: string, identity: BeanPoolIdentity,
): Promise<{ kind: 'nonce'; nonce: NodeNonce } | { kind: 'answered'; answer: DoorAnswer }> {
    let res: Response | null;
    try {
        res = await withTimeout(signedPost(url, JOIN_NONCE_PATH, {}, identity), JOIN_TIMEOUT_MS);
    } catch {
        res = null;
    }
    if (!res) return { kind: 'answered', answer: { kind: 'unreachable', message: DOOR_MESSAGES.unreachable } };
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { kind: 'answered', answer: readDoorAnswer(res.status, body, retryAfterSeconds(res)) };

    const nonce = readNonceResponse(body);
    // The node's list: offering a provider it will refuse is a sign-in that succeeds and is then thrown away.
    if (nonce.providers.length > 0 && !nonce.providers.includes(provider)) {
        throw new SsoSignInError('unsupported', `The global community does not accept ${provider} sign-in.`);
    }
    return { kind: 'nonce', nonce };
}

/** The provider's sheet with `nonce` (a vault build's one call), read into a door sign-in. */
export async function providerSignIn(provider: SsoProvider, nonce: string, ticket?: string): Promise<DoorSignIn> {
    const signin = await signInWithProvider(provider, nonce);
    let sub: string;
    try {
        sub = extractSub(signin.idToken);
    } catch {
        // Refused here rather than sealed to nothing: a copy sealed to a missing subject can never be opened.
        throw new SsoSignInError('provider', 'That sign-in did not say who you are, so it can\'t be used. Try again.');
    }
    return { provider, idToken: signin.idToken, nonce: signin.nonce, sub, email: signin.email, ...(ticket ? { vaultTicket: ticket } : {}) };
}

/**
 * Sign in at the door with `identity`'s key: a key vault deposit ticket for that key when the door takes the vault's
 * tickets and the vault gives one it takes (the door's shared ticket), otherwise the door's own nonce (signed, bound to
 * that key); then the provider. `answered` is the door refusing before any sign-in (shut, a limit), or `joined` when
 * this key is already a member (an earlier join landed). A provider that fails or is cancelled throws `SsoSignInError`,
 * as everywhere else.
 *
 * Global's nonce route is asked either way, first: it is how the door says it is shut before any sheet opens, and
 * which vault ticket keys it takes.
 */
export async function signInAtDoor(
    provider: SsoProvider,
    url: string,
    identity: BeanPoolIdentity,
): Promise<{ kind: 'signed_in'; signin: DoorSignIn } | { kind: 'answered'; answer: DoorAnswer }> {
    const asked = await askTheDoor(provider, url, identity);
    if (asked.kind === 'answered') return asked;
    const { nonce: doorNonce, vault: doorKeys } = asked.nonce;
    // A build without a vault: the door's own nonce, exactly as before the vault (the copy rides in the join).
    if (signInCopiesAt() === 'community') {
        const signin = provider === 'apple'
            ? await signInWithApple(doorNonce)
            : provider === 'google'
                ? await signInWithGoogle(doorNonce)
                : await signInWithFacebook(doorNonce);
        let sub: string;
        try {
            sub = extractSub(signin.idToken);
        } catch {
            // Refused here rather than sealed to nothing: a copy sealed to a missing subject can never be opened.
            throw new SsoSignInError('provider', 'That sign-in did not say who you are, so it can\'t be used. Try again.');
        }
        return { kind: 'signed_in', signin: { provider, idToken: signin.idToken, nonce: signin.nonce, sub, email: signin.email } };
    }
    // One sheet either way: bound to the vault's ticket when the door takes one, so the same token joins and protects.
    const grant = await doorVaultTicket(provider, identity, doorTicketKeys(doorKeys));
    return { kind: 'signed_in', signin: await providerSignIn(provider, grant ? grant.nonce : doorNonce, grant?.ticket) };
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
        case 'account_closed':
        case 'door_closed':
        case 'rate_limited':
        case 'sign_in_again':
        case 'phone_clock':
        case 'work_again':
        case 'sign_in_required':
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
 * The copy, deposited at the key vault with the door's sign-in once the door has let the member in (design §5.4): the
 * same ticket and token, signed by the key that joined. Null when it can't be made or kept (the vault paused or
 * unreachable, the ticket out of time): the join stands, and Safety Backup offers the ordinary connect. Why goes to the
 * log; never the words or the key.
 */
export async function depositDoorCopy(identity: BeanPoolIdentity, signin: DoorSignIn): Promise<KeeperEnrolmentResult | null> {
    if (!signin.vaultTicket) return null;
    try {
        const sealed = await sealSsoShares(identity, signin.provider, signin.sub);
        const deposit = await depositWithVault({
            identity, provider: signin.provider, ticket: signin.vaultTicket, idToken: signin.idToken,
            clientCopy: sealed.shares[0], wordsSealed: sealed.wordsSealed,
        });
        return enrolmentFromVault([signin.provider], { wordsSealed: deposit.wordsSealed, replaced: deposit.replaced });
    } catch (e) {
        console.log(`[JOIN] ${signin.provider}: joined without a copy — ${e instanceof VaultError ? e.reason : 'local'}: ${(e as Error).message}`);
        return null;
    }
}

/**
 * Send the join, signed by `identity` (whose key the sign-in is bound to). Never throws: every outcome is a
 * `DoorAnswer`.
 * - A build with a vault: with the key vault's ticket when the sign-in was bound to one, and then, once in, the copy
 *   goes to the vault with the same sign-in ({@link depositDoorCopy}). No copy rides in the join.
 * - A build without one: carrying the recovery copy sealed to the same sign-in, as before the vault.
 *
 * The backstop (V5 design §3.A.2, Marty's answer 6): when the door answers 401 to a join that carried a ticket,
 * whatever the code (a V5 door says why, `ticket_*`; an older one says `sign_in`), the provider's sheet opens once
 * more, by itself, with the door's own nonce, and the join goes again without the ticket: joined, without a copy, and
 * Safety Backup offers the ordinary connect. `onSignInAgain` is told first, with the line the screen shows meanwhile.
 * A second 401 is "sign in again", as before: two sheets at most. A second sheet that is cancelled or fails, or a door
 * that won't give its nonce now, leaves the first 401's "sign in again": a refusal at the sign-in is never the join's
 * own, so it takes no key off the phone (`releaseJoinKey`); the member signs in again and meets it there.
 *
 * A join signed by the door's own key is counted on the phone before it goes, and stops counting only when
 * the node refuses it (`joinsOut`, which `releaseJoinKey` reads). Each of the two joins is counted on its own.
 */
export async function submitJoin(
    url: string, identity: BeanPoolIdentity, callsign: string, signin: DoorSignIn,
    options: { onSignInAgain?: (notice: string) => void; work?: DoorWorkRun | null } = {},
): Promise<DoorAnswer> {
    const run = options.work ?? null;
    let work = await workForJoin(run, 'sign-in', false);
    if (work.kind === 'answer') return work.answer;
    let first = await sendJoin(url, identity, callsign, signin, work.work);
    // The work didn't count (a new work key after a restart, or it ran out): a new challenge, quietly, and once more.
    // The door checks the work before the sign-in, so the sign-in was not spent.
    if (first.answer.kind === 'work_again' && run) {
        work = await workForJoin(run, 'sign-in', true);
        if (work.kind === 'answer') return work.answer;
        first = await sendJoin(url, identity, callsign, signin, work.work);
    }
    if (!signin.vaultTicket || first.status !== 401) return first.answer;

    console.log(`[JOIN] ${signin.provider}: the door refused the key vault ticket (${first.code ?? 'no code'}); signing in once more with its own nonce`);
    options.onSignInAgain?.(DOOR_MESSAGES.signInAnotherWay);
    let signinAgain: DoorSignIn;
    try {
        const again = await askTheDoor(signin.provider, url, identity);
        if (again.kind === 'answered') {
            // In already (an earlier join landed), or a refusal the member can try again after: as the door said.
            const next = nextStepFor(again.answer);
            return next === 'continue' || next === 'retry' ? again.answer : first.answer;
        }
        signinAgain = await providerSignIn(signin.provider, again.nonce.nonce);
    } catch (e) {
        console.log(`[JOIN] ${signin.provider}: no second sign-in (${(e as { reason?: string } | null)?.reason ?? (e as Error).message})`);
        return first.answer;
    }
    // Work the first join carried was spent there (the door checks it before the ticket): new work for this one.
    if (work.work) {
        work = await workForJoin(run, 'sign-in', true);
        if (work.kind === 'answer') return work.answer;
    }
    return (await sendJoin(url, identity, callsign, signinAgain, work.work)).answer;
}

/**
 * The door work a join carries, from the door's run ({@link DoorWorkRun}, started when the door opened): a solution,
 * none (the sign-in door at ordinary rates asks none), or the door's answer when it gives no work (a ceiling, the door
 * shut). `again`: the node refused the work it was sent, so a new challenge.
 *
 * The sign-in door needs no work at ordinary rates, so only a ceiling at its work route stops its join; anything else
 * there (no answer, a door from before the work that has no such route, a solver that can't run) leaves the join to
 * the door, which asks for work only when it wants it (`work_again`). The 12-words door always needs it.
 */
async function workForJoin(
    run: DoorWorkRun | null, door: DoorWorkDoor, again: boolean,
): Promise<{ kind: 'work'; work: DoorWorkSolution | null } | { kind: 'answer'; answer: DoorAnswer }> {
    if (!run) return { kind: 'work', work: null };
    const outcome: DoorWorkOutcome = again ? await run.again() : await run.solution();
    switch (outcome.kind) {
        case 'solved': return { kind: 'work', work: outcome.work };
        case 'none': return { kind: 'work', work: null };
        case 'cancelled': return { kind: 'answer', answer: { kind: 'try_again', message: DOOR_MESSAGES.tryAgain } };
        case 'refused':
            if (door === 'sign-in' && outcome.answer.kind !== 'rate_limited' && outcome.answer.kind !== 'joined') {
                return { kind: 'work', work: null };
            }
            return { kind: 'answer', answer: outcome.answer };
    }
}

/**
 * The 12-words join (design §2.1): `POST /api/join` with `door: 'words'`, the name and the door work, signed by the
 * joining key. No provider, no token, no email: nothing about the member reaches the node but the key and the name.
 * Never throws: every outcome is a {@link DoorAnswer}.
 *
 * The screen waits for the work (`run.solution()`) while the member can still leave, then writes the key to the phone
 * (`commitJoinKey`), then calls this: the work is ready by then, unless it ran out meanwhile (then a new challenge,
 * quietly). The join is counted on the phone before it goes (`joinsOut`), as the sign-in door's is, and a work refusal
 * (`work_again`) fetches a new challenge, solves it, and sends once more: the member reads it only if it happens twice.
 */
export async function submitWordsJoin(url: string, identity: BeanPoolIdentity, callsign: string, run: DoorWorkRun): Promise<DoorAnswer> {
    let work = await workForJoin(run, 'words', false);
    if (work.kind === 'answer') return work.answer;
    let answer = await sendWordsJoin(url, identity, callsign, work.work);
    if (answer.kind === 'work_again') {
        work = await workForJoin(run, 'words', true);
        if (work.kind === 'answer') return work.answer;
        answer = await sendWordsJoin(url, identity, callsign, work.work);
    }
    return answer;
}

/** One 12-words join sent ({@link submitWordsJoin}). */
async function sendWordsJoin(url: string, identity: BeanPoolIdentity, callsign: string, work: DoorWorkSolution | null): Promise<DoorAnswer> {
    const body = {
        door: 'words',
        callsign: callsign.trim().slice(0, MAX_JOIN_NAME).trim(),
        ...(work ? { work } : {}),
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
    const answer = readWordsDoorAnswer(res.status, answerBody, retryAfterSeconds(res));
    console.log(`[JOIN] words: the door answered ${res.status} (${answer.kind})`);
    if (refusedByTheNode(answer)) await countJoinRefused(identity.publicKey);
    return answer;
}

/** One join sent ({@link submitJoin}), with the door's status and code when it answered. */
async function sendJoin(
    url: string, identity: BeanPoolIdentity, callsign: string, signin: DoorSignIn, work: DoorWorkSolution | null = null,
): Promise<{ answer: DoorAnswer; status: number | null; code?: string }> {
    // A build without a vault: a copy that can't be made never stops the join: the 12 words are the key, and Safety
    // Backup offers the ordinary connect. Why it failed goes to the log; never the words or the key.
    let recovery: { shares: unknown[] } | null = null;
    let wordsSealed = false;
    if (signInCopiesAt() === 'community') {
        try {
            const sealed = await sealSsoShares(identity, signin.provider, signin.sub);
            recovery = { shares: sealed.shares };
            wordsSealed = sealed.wordsSealed;
        } catch (e) {
            console.log(`[JOIN] ${signin.provider}: no recovery copy with the join — ${(e as Error).message}`);
        }
    }

    const body = {
        callsign: callsign.trim().slice(0, MAX_JOIN_NAME).trim(),
        provider: signin.provider,
        idToken: signin.idToken,
        nonce: signin.nonce,
        ...(recovery ? { recovery } : {}),
        ...(signin.vaultTicket ? { vaultTicket: signin.vaultTicket } : {}),
        // Door work, when the door asked for some (from the 30th join an hour from one network, design §4.2).
        ...(work ? { work } : {}),
    };

    if (!(await countJoinOut(identity.publicKey))) return { answer: { kind: 'try_again', message: DOOR_MESSAGES.tryAgain }, status: null };
    let res: Response | null;
    try {
        res = await withTimeout(signedPost(url, JOIN_PATH, body, identity), JOIN_TIMEOUT_MS);
    } catch {
        res = null;
    }
    if (!res) return { answer: { kind: 'unreachable', message: DOOR_MESSAGES.unreachable }, status: null };
    const answerBody = await res.json().catch(() => ({}));
    const answer = readDoorAnswer(res.status, answerBody, retryAfterSeconds(res));
    const heard = { status: res.status, code: codeOf(answerBody) };
    console.log(`[JOIN] ${signin.provider}: the door answered ${res.status} (${answer.kind})`);
    if (refusedByTheNode(answer)) await countJoinRefused(identity.publicKey);
    if (answer.kind === 'joined' && res.ok && recovery) {
        return {
            answer: { ...answer, enrolment: enrolmentFromJoin((answerBody as { recovery?: unknown }).recovery, signin.provider, wordsSealed) },
            ...heard,
        };
    }
    if (answer.kind === 'joined' && signin.vaultTicket) return { answer: { ...answer, enrolment: await depositDoorCopy(identity, signin) }, ...heard };
    return { answer, ...heard };
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
