/**
 * Adding a sign-in to an account made with 12 words (two-doors design §2.5, slice S5): one sign-in, two jobs, as at the
 * door. The account gets a second way back (the sign-in also unlocks a copy of it), and the new-account limits a
 * 12-words member starts with are lifted to a sign-in member's at once (apps/server/src/routes/open-join.ts).
 *
 * The browser leaves for the provider exactly as a join does (lib/web-join.ts: a full-page redirect, no provider script
 * on this page), with a nonce the node bound to adding a sign-in for this member (`POST /api/join/link/sso-nonce`, signed
 * by the member's key). What it needs to recognise the return is kept in this browser while it is away (`PendingLink`:
 * the key, the sign-in and the nonce; no secret). On the way back (App.tsx, through captureAuthReturn, which takes the
 * answer out of the address bar at once) the return is matched to it, the key and its 12 words are sealed to the
 * sign-in (lib/join-recovery.ts), and one signed `POST /api/join/link` carries both.
 *
 * Never a gate: the account works the same with or without a sign-in, a copy that fails still leaves the sign-in added,
 * and every refusal is a sentence.
 */

import {
    door, isWrongClock, matchAuthReturn, providerAuthUrl, providerLabel, refusalMessage, tryAgainIn, DoorUnreachableError, WRONG_CLOCK,
    type AuthReturn, type DoorAnswer, type JoinNonce,
} from './web-join';
import { recoveryStored, sealJoinRecovery } from './join-recovery';
import { isJoinProvider, type BeanPoolIdentity, type JoinProvider } from './identity';

/** What this browser keeps while it is away at the provider. */
export interface PendingLink {
    publicKey: string;
    provider: JoinProvider;
    nonce: string;
    startedAt: number;
    expiresAt: number;
}

const PENDING_LINK_KEY = 'beanpool_pending_link';
/** The node's nonce lives ten minutes. */
export const PENDING_LINK_TTL_MS = 10 * 60 * 1000;

export function savePendingLink(link: PendingLink): void {
    localStorage.setItem(PENDING_LINK_KEY, JSON.stringify(link));
}

/** The link this browser left for, or null (none, unreadable, or past its nonce's life). */
export function loadPendingLink(now: number = Date.now()): PendingLink | null {
    let raw: string | null;
    try {
        raw = localStorage.getItem(PENDING_LINK_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        if (v && typeof v.publicKey === 'string' && isJoinProvider(v.provider) && typeof v.nonce === 'string' && v.nonce
            && typeof v.expiresAt === 'number' && v.expiresAt > now) {
            return { publicKey: v.publicKey, provider: v.provider, nonce: v.nonce, startedAt: Number(v.startedAt) || 0, expiresAt: v.expiresAt };
        }
    } catch { /* not ours */ }
    clearPendingLink();
    return null;
}

export function clearPendingLink(): void {
    try { localStorage.removeItem(PENDING_LINK_KEY); } catch { /* private window */ }
}

/** The refusals of `/api/join/link/sso-nonce` and `/api/join/link`, as sentences. */
export function linkRefusalMessage(answer: DoorAnswer, provider: JoinProvider | null): string {
    const said = typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : null;
    const label = provider ? providerLabel(provider) : 'sign-in';
    if (isWrongClock(answer)) return WRONG_CLOCK;
    switch (answer.body.code) {
        case 'already_joined':
            return `This ${label} account already has another BeanPool account here, so it can't be added to this one. Choose another sign-in.`;
        case 'removed':
            return `This ${label} account belonged to an account that was removed from this community, so it can't be added.`;
        case 'sign_in':
            return `${label} couldn't confirm that sign-in. Try again.`;
        case 'already_linked':
        case 'not_words_member':
        case 'not_a_member':
        case 'door_key_missing':
        case 'sign_in_unavailable':
            if (said) return said;
    }
    if (answer.status === 429) return `Too many tries just now. ${tryAgainIn(answer.retryAfterSeconds ?? 60)}`;
    if (answer.status === 404) return "This community doesn't take sign-ins right now.";
    return said ?? `The community couldn't add your sign-in (${answer.status}). Try again in a minute.`;
}

const UNREACHABLE = "Can't reach the community right now. Try again in a minute.";

/**
 * Ask the node for a nonce bound to adding a sign-in to this member (and so which sign-ins it offers a browser), signed
 * by the member's key. Asked when the member chooses to add one, never before: a nonce is single use.
 */
export async function requestLinkNonce(identity: BeanPoolIdentity): Promise<{ nonce: JoinNonce } | { message: string }> {
    let answer: DoorAnswer;
    try {
        answer = await door('POST', '/api/join/link/sso-nonce', {}, identity);
    } catch (e) {
        if (!(e instanceof DoorUnreachableError)) console.error('[LinkSignIn] could not ask for a nonce:', e);
        return { message: UNREACHABLE };
    }
    const b = answer.body;
    if (answer.status !== 200 || typeof b.nonce !== 'string' || !b.nonce) return { message: linkRefusalMessage(answer, null) };
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
 * Leave for `provider` with the link nonce `n`, keeping what the return is matched against. Answers only when the
 * browser stays here: why not, as a sentence. `navigate` leaves the page (swappable in tests).
 */
export function leaveForLink(
    identity: BeanPoolIdentity,
    provider: JoinProvider,
    n: JoinNonce,
    o: { origin?: string; navigate?: (url: string) => void; now?: number } = {},
): { ok: false; message: string } | { ok: true } {
    const clientId = n.clientIds[provider];
    if (typeof clientId !== 'string' || !clientId) return { ok: false, message: `${providerLabel(provider)} sign-in isn't available here.` };
    const now = o.now ?? Date.now();
    try {
        savePendingLink({ publicKey: identity.publicKey, provider, nonce: n.nonce, startedAt: now, expiresAt: now + PENDING_LINK_TTL_MS });
    } catch (e) {
        console.error('[LinkSignIn] could not keep the link while away:', e);
        return { ok: false, message: "This browser couldn't keep track of the sign-in, so it didn't start. Try again." };
    }
    const origin = o.origin ?? window.location.origin;
    (o.navigate ?? ((url: string) => window.location.assign(url)))(providerAuthUrl(provider, { clientId, origin, nonce: n.nonce }));
    return { ok: true };
}

/** What became of a sign-in that came back for a link. */
export type LinkResult =
    /** Added: this sign-in brings the account back when `recoveryStored`, and the account is on the ordinary limits. */
    | { kind: 'linked'; provider: JoinProvider; recoveryStored: boolean }
    | { kind: 'cancelled'; provider: JoinProvider }
    | { kind: 'failed'; provider: JoinProvider | null; message: string };

/**
 * Whether a captured return is this browser's link for `identity`: a pending link for this key whose nonce is the
 * return's `state`. Anything else is not a link's return.
 */
export function isLinkReturn(ret: AuthReturn, identity: BeanPoolIdentity, now: number = Date.now()): boolean {
    const p = loadPendingLink(now);
    return !!p && p.publicKey === identity.publicKey && !!ret.state && ret.state === p.nonce;
}

/** Finish a link from its return: matched, sealed, sent. The pending link is used up whatever happens. Never throws. */
export async function finishLink(identity: BeanPoolIdentity, ret: AuthReturn, now: number = Date.now()): Promise<LinkResult> {
    const pending = loadPendingLink(now);
    clearPendingLink();
    if (!pending || pending.publicKey !== identity.publicKey) {
        return { kind: 'failed', provider: ret.provider, message: refusalMessage('no_pending', ret.provider) };
    }
    const outcome = matchAuthReturn(ret, { provider: pending.provider, nonce: pending.nonce });
    if (outcome.kind === 'cancelled') return { kind: 'cancelled', provider: outcome.provider };
    if (outcome.kind === 'provider_error') return { kind: 'failed', provider: outcome.provider, message: outcome.message };
    if (outcome.kind === 'refused') return { kind: 'failed', provider: pending.provider, message: refusalMessage(outcome.reason, pending.provider) };
    const { provider, idToken, nonce, sub } = outcome;
    // The same copy the join makes: the key and its 12 words, sealed to this sign-in. Null when it can't be made, and
    // the sign-in is added without it.
    const sealed = await sealJoinRecovery(identity, provider, sub);
    const send = (withCopy: boolean) => door('POST', '/api/join/link', {
        provider, idToken, nonce, ...(withCopy && sealed ? { recovery: { shares: sealed.shares } } : {}),
    }, identity);
    let answer: DoorAnswer;
    try {
        answer = await send(true);
        // The node couldn't read the copy, and said so before it checked the sign-in (the nonce is not spent): the
        // sign-in is added without one.
        if (sealed && answer.status === 400 && answer.body.code === 'recovery_invalid') answer = await send(false);
    } catch (e) {
        if (!(e instanceof DoorUnreachableError)) console.error('[LinkSignIn] could not send the sign-in:', e);
        return { kind: 'failed', provider, message: UNREACHABLE };
    }
    if (answer.status === 200 && answer.body.success === true) {
        return { kind: 'linked', provider, recoveryStored: recoveryStored(answer.body.recovery) };
    }
    return { kind: 'failed', provider, message: linkRefusalMessage(answer, provider) };
}

/** The sentence for a link's result, shown in Settings. */
export function linkResultMessage(r: LinkResult): string {
    switch (r.kind) {
        case 'linked':
            return r.recoveryStored
                ? `${providerLabel(r.provider)} is added. Signing in with it also brings this account back, and your new-account limits are now the usual ones.`
                : `${providerLabel(r.provider)} is added, and your new-account limits are now the usual ones. Its copy of your account couldn't be saved, so your 12 words are still your only way back.`;
        case 'cancelled':
            return 'Adding a sign-in was cancelled. Nothing changed.';
        case 'failed':
            return r.message;
    }
}
