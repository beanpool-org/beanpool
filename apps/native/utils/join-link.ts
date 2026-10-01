/**
 * Adding a sign-in later, for a member who joined the global community with 12 words (two-doors design §2.5): from
 * Safety Backup ("Add a sign-in as a second way back") and from Settings (Account Protection, and the "one way back"
 * card, utils/one-way-back.ts).
 *
 * One sign-in, two jobs, as at the door: `POST /api/join/link/sso-nonce` then `POST /api/join/link` (apps/server
 * routes/open-join.ts), both signed by the member. The node checks the sign-in against its door's records (one sign-in
 * account, one member: a sign-in already someone else's is refused, and so is a removed member's), rewrites the member's
 * row from `words` to the provider, and lifts them to the usual new-account limits at once. The same sign-in also makes
 * the recovery copy, where copies go today:
 * - a build with BeanPool's key vault: the vault's deposit ticket for this key when the door takes it (its nonce answer
 *   lists the ticket keys, global-join.ts `doorTicketKeys`), and once the node has linked it, the copy goes to the vault
 *   (`depositDoorCopy`). No ticket the door takes: the door's own nonce, linked without a copy.
 * - a build without one: the door's own nonce, and the copy rides in the link (`recovery: { shares }`).
 * If the copy can't be made or kept, the link still stands: never a gate, either way round.
 *
 * The backstop is the door's (global-join.ts `submitJoin`): a 401 to a link that carried a ticket opens the provider's
 * sheet once more, with the door's own nonce, and links without a copy.
 *
 * Every refusal is a sentence ({@link LINK_MESSAGES}), never a code. Nothing here changes the key on the phone, and a
 * refusal changes nothing anywhere.
 */

import { readNonceResponse, signInWithProvider, SsoSignInError } from './sso-signin';
import { SSO_PROVIDER_NAMES, type SsoProvider } from './sso-providers';
import { signedPost } from './node-post';
import { extractSub } from './sso-sheet-connect';
import { enrolmentFromJoin, sealSsoShares, type KeeperEnrolmentResult } from './keeper-enrolment';
import { signInCopiesAt } from './vault-config';
import { depositDoorCopy, doorTicketKeys, doorVaultTicket, providerSignIn, retryAfterSeconds, tryAgainIn, JOIN_TIMEOUT_MS, type DoorSignIn } from './global-join';
import type { BeanPoolIdentity } from './identity';

export const LINK_NONCE_PATH = '/api/join/link/sso-nonce';
export const LINK_PATH = '/api/join/link';

/** Why a sign-in wasn't added. */
export type LinkRefusal =
    | 'already_joined' | 'removed' | 'not_words_member' | 'already_linked' | 'not_a_member' | 'door_closed'
    | 'door_key_missing' | 'rate_limited' | 'sign_in_again' | 'sign_in_unavailable' | 'unsupported' | 'try_again' | 'unreachable';

export type LinkAnswer =
    /** Added: this sign-in is a second way back, and the new-account limits are the usual ones from now. */
    | { kind: 'linked'; provider: SsoProvider; enrolment: KeeperEnrolmentResult | null }
    | { kind: 'refused'; reason: LinkRefusal; message: string };

/** What the member reads when a sign-in isn't added. `{provider}` is the sign-in's name. */
export const LINK_MESSAGES: Record<LinkRefusal, string> = {
    already_joined: 'This {provider} account is already the sign-in of another BeanPool account in the global community, so it can\'t be added to yours. Nothing was changed. You can try a different sign-in.',
    removed: 'The BeanPool account this {provider} account joined with was removed from the global community, so it can\'t be added to yours. Nothing was changed.',
    not_words_member: 'Your account joined the global community another way, so there is no sign-in to add here. Nothing was changed.',
    already_linked: 'Your account in the global community already has a sign-in. Nothing was changed.',
    not_a_member: 'Only a member of the global community can add a sign-in there, and this phone\'s account isn\'t one now. Nothing was changed.',
    door_closed: 'The global community isn\'t adding sign-ins right now. Nothing was changed. Please try again later.',
    door_key_missing: 'The global community can\'t check sign-ins right now, so nothing was added. Please try again later.',
    rate_limited: 'There were too many tries in a short time, so nothing was added. Please try again {when}.',
    sign_in_again: 'Your sign-in could not be used, so nothing was added. Please sign in again.',
    sign_in_unavailable: '{provider} sign-in could not be checked right now, so nothing was added. Please try again in a minute.',
    unsupported: 'The global community doesn\'t take {provider} sign-in. You can try a different one.',
    try_again: 'Your sign-in could not be added, and nothing was changed. Please try again in a minute.',
    unreachable: 'Can\'t reach the global community right now, so nothing was added. Check your connection and try again.',
};

function sentence(reason: LinkRefusal, provider: SsoProvider, retryAfter: number | null = null): string {
    return LINK_MESSAGES[reason]
        .replace('{provider}', SSO_PROVIDER_NAMES[provider] ?? 'This sign-in')
        .replace('{when}', retryAfter ? tryAgainIn(retryAfter) : 'later');
}

function refused(reason: LinkRefusal, provider: SsoProvider, retryAfter: number | null = null): LinkAnswer {
    return { kind: 'refused', reason, message: sentence(reason, provider, retryAfter) };
}

const CODES: Partial<Record<string, LinkRefusal>> = {
    already_joined: 'already_joined',
    removed: 'removed',
    not_words_member: 'not_words_member',
    already_linked: 'already_linked',
    not_a_member: 'not_a_member',
    door_key_missing: 'door_key_missing',
    sign_in_unavailable: 'sign_in_unavailable',
    invite_only: 'door_closed',
};

/** Read one answer from a link route (the nonce or the link) into what the member meets. Never the node's code. */
export function readLinkAnswer(status: number, body: unknown, provider: SsoProvider, retryAfter: number | null = null): LinkAnswer {
    if (status >= 200 && status < 300) return { kind: 'linked', provider, enrolment: null };
    const code = (body as { code?: unknown } | null)?.code;
    const known = typeof code === 'string' ? CODES[code] : undefined;
    if (known) return refused(known, provider);
    if (status === 429) return refused('rate_limited', provider, retryAfter);
    if (status === 401) return refused('sign_in_again', provider);
    if (status === 404 || status === 403) return refused('door_closed', provider);
    return refused('try_again', provider);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** The link's nonce, signed by the member, or the refusal. */
async function askForLink(url: string, identity: BeanPoolIdentity, provider: SsoProvider): Promise<
    { kind: 'nonce'; nonce: string; ticketKeys: string[] } | { kind: 'answer'; answer: LinkAnswer }
> {
    let res: Response | null;
    try {
        res = await withTimeout(signedPost(url, LINK_NONCE_PATH, {}, identity), JOIN_TIMEOUT_MS);
    } catch {
        res = null;
    }
    if (!res) return { kind: 'answer', answer: refused('unreachable', provider) };
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { kind: 'answer', answer: readLinkAnswer(res.status, body, provider, retryAfterSeconds(res)) };
    let nonce;
    try {
        nonce = readNonceResponse(body);
    } catch {
        return { kind: 'answer', answer: refused('try_again', provider) };
    }
    if (nonce.providers.length > 0 && !nonce.providers.includes(provider)) return { kind: 'answer', answer: refused('unsupported', provider) };
    return { kind: 'nonce', nonce: nonce.nonce, ticketKeys: doorTicketKeys(nonce.vault) };
}

export interface LinkSignInOptions {
    /** The global community (the door's node). */
    url: string;
    identity: BeanPoolIdentity;
    provider: SsoProvider;
    /**
     * The phone's lock, asked before anything starts: the sign-in also gets a copy of the account. Null only for a key
     * the join has just made (Safety Backup, the member's own new account), as the account-protection sheet does.
     */
    phoneLock: (() => Promise<boolean>) | null;
    /** The provider is done and the link is next: Cancel no longer applies. */
    onSignedIn?: () => void | Promise<void>;
    /** Closed before the provider was done: nothing is sent. */
    signal?: AbortSignal;
    /** Under the busy line while the provider's sheet opens once more (the backstop). */
    onSignInAgain?: (notice: string) => void;
}

/**
 * Add `provider` as a second way back. Resolves with the answer; throws `SsoSignInError` with `cancelled` when the
 * member stopped it (the phone's lock not passed, the provider's sheet cancelled, or the sheet closed), as the
 * account-protection sheet's connect does.
 */
export async function linkSignIn(o: LinkSignInOptions): Promise<LinkAnswer> {
    const { url, identity, provider } = o;
    if (o.phoneLock && !(await o.phoneLock())) {
        throw new SsoSignInError('cancelled', "The phone's lock was not passed, so no sign-in was added.");
    }
    if (o.signal?.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    const asked = await askForLink(url, identity, provider);
    if (asked.kind === 'answer') return asked.answer;

    // A build without a vault: the door's nonce, and the copy rides in the link, as at the door.
    let signin: DoorSignIn;
    if (signInCopiesAt() === 'community') {
        const done = await signInWithProvider(provider, asked.nonce);
        signin = { provider, idToken: done.idToken, nonce: done.nonce, sub: '', email: done.email };
        try {
            signin.sub = extractSub(done.idToken);
        } catch {
            throw new SsoSignInError('provider', 'That sign-in did not say who you are, so it can\'t be used. Try again.');
        }
    } else {
        const grant = await doorVaultTicket(provider, identity, asked.ticketKeys);
        if (o.signal?.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
        signin = await providerSignIn(provider, grant ? grant.nonce : asked.nonce, grant?.ticket);
    }
    await o.onSignedIn?.();
    if (o.signal?.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');

    const first = await sendLink(url, identity, signin);
    if (!signin.vaultTicket || first.status !== 401) return first.answer;

    // The backstop: the door wouldn't take the vault's ticket. Its own nonce, the sheet once more, and no copy.
    console.log(`[LINK] ${provider}: the door refused the key vault ticket; signing in once more with its own nonce`);
    o.onSignInAgain?.('Checking your sign-in another way…');
    try {
        const again = await askForLink(url, identity, provider);
        if (again.kind === 'answer') return again.answer;
        const second = await providerSignIn(provider, again.nonce);
        return (await sendLink(url, identity, second)).answer;
    } catch (e) {
        console.log(`[LINK] ${provider}: no second sign-in (${(e as { reason?: string } | null)?.reason ?? (e as Error).message})`);
        return first.answer;
    }
}

/** One link sent, with the recovery copy where this build keeps it. */
async function sendLink(url: string, identity: BeanPoolIdentity, signin: DoorSignIn): Promise<{ answer: LinkAnswer; status: number | null }> {
    let recovery: { shares: unknown[] } | null = null;
    let wordsSealed = false;
    if (signInCopiesAt() === 'community') {
        try {
            const sealed = await sealSsoShares(identity, signin.provider, signin.sub);
            recovery = { shares: sealed.shares };
            wordsSealed = sealed.wordsSealed;
        } catch (e) {
            console.log(`[LINK] ${signin.provider}: no recovery copy with the link — ${(e as Error).message}`);
        }
    }
    const body = {
        provider: signin.provider,
        idToken: signin.idToken,
        nonce: signin.nonce,
        ...(recovery ? { recovery } : {}),
        ...(signin.vaultTicket ? { vaultTicket: signin.vaultTicket } : {}),
    };
    let res: Response | null;
    try {
        res = await withTimeout(signedPost(url, LINK_PATH, body, identity), JOIN_TIMEOUT_MS);
    } catch {
        res = null;
    }
    if (!res) return { answer: refused('unreachable', signin.provider), status: null };
    const answerBody = await res.json().catch(() => ({}));
    const answer = readLinkAnswer(res.status, answerBody, signin.provider, retryAfterSeconds(res));
    console.log(`[LINK] ${signin.provider}: the door answered ${res.status} (${answer.kind === 'linked' ? 'linked' : answer.reason})`);
    if (answer.kind !== 'linked') return { answer, status: res.status };
    if (recovery) {
        return { answer: { ...answer, enrolment: enrolmentFromJoin((answerBody as { recovery?: unknown }).recovery, signin.provider, wordsSealed) }, status: res.status };
    }
    if (signin.vaultTicket) return { answer: { ...answer, enrolment: await depositDoorCopy(identity, signin) }, status: res.status };
    return { answer, status: res.status };
}

/** What Safety Backup and Settings say once a sign-in was added. */
export function linkedNotice(answer: Extract<LinkAnswer, { kind: 'linked' }>): string {
    const name = SSO_PROVIDER_NAMES[answer.provider] ?? 'Your sign-in';
    const copy = answer.enrolment
        ? (signInCopiesAt() === 'vault'
            ? ` If you lose this phone, sign in with ${name} to get back in.`
            : ` If you lose this phone, sign in with ${name} to get back into the global community.`)
        : ' It couldn\'t keep a copy of your account right now, so for getting back in, your 12 words are still the way: Account Protection in Settings can link it again.';
    return `Your ${name} sign-in is added: your account now has the usual new-account limits.${copy}`;
}
