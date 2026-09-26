/**
 * Getting an account back in a web browser with the sign-in it joined with (design G11 §4.4, G11-d; Marty, D-1 = a,
 * 2026-09-25): a browser that was cleared, or a new one, gets the member's own key back, never a second identity.
 * Everything the restore screens (components/WebRestore.tsx) do that is not drawing.
 *
 * ## The shape of it: the phone's restore, in a browser
 *
 * The phone's template is apps/native/utils/sso-recovery.ts, against the node's recovery routes
 * (apps/server/src/routes/recovery-collect.ts), which this does not change:
 *
 *   1. The member names their account: the node's public lookup (`GET /api/recovery/lookup/:name`) lists the members
 *      whose name starts so and who have a sign-in copy, each with their public key. The member picks theirs.
 *   2. A throwaway key is made for this restore (`makeEphemeralKey`). It is not an account and is never saved as one.
 *      It signs every call below, and the node binds the recovery session to it: the session id alone opens nothing.
 *   3. `POST /api/recovery/collect { callsign }` opens the session (the node tells the account's owner at once), and
 *      `POST /api/recovery/collect/sso-nonce` gives the sign-in nonce for the throwaway key, with the ids a browser
 *      puts in its request to each provider (`clientIds`) and whether the node runs GitHub's sign-in (`githubFlow`).
 *   4. The sign-in: Google, Apple and Facebook leave the page exactly as the join does (lib/web-join.ts builds the same
 *      requests, and they come back to the same `/app/auth/<provider>` page); the throwaway key and the session wait as
 *      a pending restore (identity.ts). GitHub is the node's device flow, as at the door.
 *   5. `POST /api/recovery/collect/sso` with the token (or GitHub's session) releases the account's sign-in copy, and
 *      `POST /api/recovery/collect/fragments` hands it over.
 *   6. core's `openSeedFromSso` opens it with the sign-in's `sub`: the account's seed, and its 12 words when the copy
 *      carried them. The format is core's alone: nothing here reads the blob but that function.
 *
 * ## Nothing is saved unless it is the account the lookup named
 *
 * `openRestoredAccount` builds the key from the seed, and keeps the words only when this app's own derivation of them
 * (lib/mnemonic.ts, as a 12-words restore would run it) makes that same key. Then the key must equal the public key the
 * lookup named for the account the member picked. Anything else (another account's copy, a node answering for someone
 * else) is refused and nothing is written: the phone's restore has no such check (memory `recovery-model`), this one
 * does. What is saved goes through the identity store's guarded write (identity.ts importIdentity: one browser, one
 * account), from WelcomePage, which also settles a join this browser sent first.
 *
 * ## What is not done here
 *
 * The old two-part copy (`scrypt-xc20p-v1`, half a seed, the other half from the node after a wait) is not opened on
 * the web: every copy the global community holds is the single kind (both apps' joins seal nothing else), and a copy of
 * the old kind is said plainly, with the 12 words and the phone as the ways back.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isSingleBlobSso, openSeedFromSso, toEd25519Pkcs8, type SealedShare } from '@beanpool/core';
import { getNodeApiUrl } from './api';
import { identityFromMnemonic, type BeanPoolIdentity, type JoinProvider } from './identity';
import { door, providerLabel, type DoorAnswer, type RedirectProvider } from './web-join';

// ===================== THE ACCOUNT (the node's lookup) =====================

/** One account the lookup named: the name it has here, and its key. */
export interface RestoreCandidate {
    publicKey: string;
    callsign: string;
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * The accounts here whose name starts with `name` and that a sign-in can bring back, as the node's public lookup lists
 * them (`GET /api/recovery/lookup/:callsign`, rate limited, unsigned: this browser has no key yet). Null when the node
 * could not be asked or did not answer with a list. Never throws.
 */
export async function lookupRestorable(name: string): Promise<RestoreCandidate[] | null> {
    const typed = name.trim();
    if (!typed) return [];
    try {
        const res = await fetch(`${getNodeApiUrl()}/api/recovery/lookup/${encodeURIComponent(typed)}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const all: unknown = await res.json();
        if (!Array.isArray(all)) return null;
        return all.flatMap((c): RestoreCandidate[] => {
            const publicKey = typeof c?.publicKey === 'string' ? c.publicKey.trim().toLowerCase() : '';
            const callsign = typeof c?.callsign === 'string' ? c.callsign : '';
            return c?.canRecoverBySso === true && HEX_KEY.test(publicKey) && callsign.trim() ? [{ publicKey, callsign }] : [];
        });
    } catch {
        return null;
    }
}

// ===================== THE THROWAWAY KEY =====================

/** The key a restore signs with. Held as the web app holds keys: hex, the private half PKCS8 (identity.ts). */
export interface EphemeralKey {
    publicKey: string;
    privateKey: string;
}

/** A new throwaway key, from 32 random bytes. */
export function makeEphemeralKey(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): EphemeralKey {
    const seed = randomBytes(32);
    try {
        return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)) };
    } finally {
        seed.fill(0);
    }
}

/** The throwaway key in the shape the node calls sign with. Never stored as, or mistaken for, an account. */
function signer(eph: EphemeralKey): BeanPoolIdentity {
    return { publicKey: eph.publicKey, privateKey: eph.privateKey, callsign: 'ephemeral-recovery', createdAt: new Date(0).toISOString() };
}

// ===================== THE NODE'S RECOVERY SESSION (routes/recovery-collect.ts) =====================

/** Open the node's recovery session for `callsign` (the name as the lookup gave it), bound to `eph`. */
export async function openRestoreSession(eph: EphemeralKey, callsign: string): Promise<{ collectionId: string } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/recovery/collect', { callsign }, signer(eph));
    const id = answer.body.collectionId;
    if (answer.status !== 200 || typeof id !== 'string' || !id) return { answer };
    return { collectionId: id };
}

/** The node's answer to a recovery nonce request: which sign-ins a browser can use for it, and the nonce. */
export interface RestoreNonce {
    nonce: string;
    githubFlow?: string;
    clientIds: Partial<Record<RedirectProvider, string | null>>;
}

export async function requestRestoreNonce(eph: EphemeralKey, collectionId: string): Promise<{ nonce: RestoreNonce } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/recovery/collect/sso-nonce', { collectionId }, signer(eph));
    const b = answer.body;
    if (answer.status !== 200 || typeof b.nonce !== 'string' || !b.nonce) return { answer };
    return {
        nonce: {
            nonce: b.nonce,
            githubFlow: typeof b.githubFlow === 'string' ? b.githubFlow : undefined,
            clientIds: b.clientIds && typeof b.clientIds === 'object' ? b.clientIds : {},
        },
    };
}

/** The order the sign-ins are offered in. The node does not say which one an account has: the member knows. */
const RESTORE_ORDER: readonly JoinProvider[] = ['google', 'apple', 'facebook', 'github'];

/**
 * The sign-ins to offer: each redirect one the node gave a browser id for (one without stays hidden rather than sending
 * the member to a sign-in the node would refuse), and GitHub when the node runs its sign-in itself.
 */
export function restoreProviders(n: RestoreNonce): JoinProvider[] {
    return RESTORE_ORDER.filter((p) => p === 'github'
        ? n.githubFlow === 'node'
        : typeof n.clientIds[p] === 'string' && !!n.clientIds[p]);
}

export async function startGithubRestore(eph: EphemeralKey, collectionId: string): Promise<{ sessionId: string; userCode: string; expiresInSeconds: number; intervalSeconds: number } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/recovery/collect/github/start', { collectionId }, signer(eph));
    const b = answer.body;
    if (answer.status !== 200 || typeof b.sessionId !== 'string' || typeof b.userCode !== 'string') return { answer };
    return {
        sessionId: b.sessionId,
        userCode: b.userCode,
        expiresInSeconds: typeof b.expiresInSeconds === 'number' && b.expiresInSeconds > 0 ? b.expiresInSeconds : 900,
        intervalSeconds: typeof b.intervalSeconds === 'number' && b.intervalSeconds > 0 ? b.intervalSeconds : 5,
    };
}

export function pollGithubRestore(eph: EphemeralKey, collectionId: string, sessionId: string): Promise<DoorAnswer> {
    return door('POST', '/api/recovery/collect/github/poll', { collectionId, sessionId }, signer(eph));
}

/** The sign-in a restore releases the copy with: the provider's token and its nonce, or GitHub's finished session. */
export type RestoreProof =
    | { provider: RedirectProvider; idToken: string; nonce: string; sub: string }
    | { provider: 'github'; sessionId: string; sub: string };

/** Ask the node to release the account's sign-in copy to this session, with a fresh sign-in. */
export function releaseSignInCopy(eph: EphemeralKey, collectionId: string, proof: RestoreProof): Promise<DoorAnswer> {
    const credential = proof.provider === 'github'
        ? { proof: { sessionId: proof.sessionId } }
        : { idToken: proof.idToken, nonce: proof.nonce };
    return door('POST', '/api/recovery/collect/sso', { collectionId, provider: proof.provider, ...credential }, signer(eph));
}

/** The released sign-in copy, as core opens it; null when the node has none for this session. */
export async function fetchSignInCopy(eph: EphemeralKey, collectionId: string): Promise<{ copy: SealedShare | null } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/recovery/collect/fragments', { collectionId }, signer(eph));
    if (answer.status !== 200 || !Array.isArray(answer.body.fragments)) return { answer };
    const f = (answer.body.fragments as Array<Record<string, unknown> | null>).find((x) => x?.holderType === 'sso');
    if (!f || typeof f.payload !== 'string' || typeof f.payloadIv !== 'string' || typeof f.payloadTag !== 'string' || typeof f.kdfParams !== 'string') {
        return { copy: null };
    }
    return { copy: { encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams } };
}

// ===================== OPENING IT, AND THE ONE CHECK THAT DECIDES =====================

export type OpenedAccount =
    /** The account the lookup named: its key, and its 12 words when they came back and make it. */
    | { kind: 'ok'; identity: BeanPoolIdentity }
    /** It opened to another key than the one the lookup named. Nothing of it is returned. */
    | { kind: 'wrong_account' }
    /** The old two-part kind of copy, which the web does not open. */
    | { kind: 'old_format' }
    /** It did not open with this sign-in (another account's sign-in, or a damaged copy). */
    | { kind: 'unreadable' };

/**
 * Open the released copy with the sign-in's `sub` (core's openSeedFromSso: the one reader of the format), and make the
 * identity this browser will hold, as `account.callsign`. Only returned when its public key is `account.publicKey`.
 * The 12 words are kept only when this app's own derivation of them makes the same key. The seed is wiped after.
 */
export async function openRestoredAccount(
    copy: SealedShare,
    provider: JoinProvider,
    sub: string,
    account: RestoreCandidate,
): Promise<OpenedAccount> {
    if (!isSingleBlobSso(copy.kdfParams)) return { kind: 'old_format' };
    let seed: Uint8Array;
    let words: string[] | null;
    try {
        const opened = await openSeedFromSso(copy, provider, sub);
        seed = opened.seed;
        words = opened.words;
    } catch (e) {
        console.warn(`[WebRestore] ${provider}: the sign-in copy did not open: ${(e as Error)?.message || e}`);
        return { kind: 'unreadable' };
    }
    try {
        if (seed.length !== 32) return { kind: 'unreadable' };
        const publicKey = bytesToHex(ed25519.getPublicKey(seed));
        if (publicKey !== account.publicKey.trim().toLowerCase()) {
            console.warn(`[WebRestore] ${provider}: the copy opened to another key than the account named; nothing saved`);
            return { kind: 'wrong_account' };
        }
        const identity: BeanPoolIdentity = {
            publicKey,
            privateKey: bytesToHex(toEd25519Pkcs8(seed)),
            callsign: account.callsign,
            createdAt: new Date().toISOString(),
        };
        if (words) {
            // Re-derived the way this app makes a key from words, so a 12-words restore here later lands on this account.
            const fromWords = await identityFromMnemonic(words, account.callsign).catch(() => null);
            if (fromWords?.publicKey === publicKey) identity.mnemonic = words;
            else console.warn(`[WebRestore] ${provider}: the copy's 12 words do not make its key here; restoring the key alone`);
        }
        return { kind: 'ok', identity };
    } finally {
        seed.fill(0);
    }
}

// ===================== WHAT THE MEMBER READS =====================

/** The node's answer to a release that did not let the copy go, in plain words. */
export function releaseRefusalMessage(answer: DoorAnswer, provider: JoinProvider, callsign: string): string {
    const said = typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : null;
    const label = providerLabel(provider);
    if (answer.status === 400) return `That ${label} account isn't a way back into ${callsign}. Try the sign-in you joined with, or your 12 words.`;
    if (answer.status === 401) return `${label} sign-in couldn't be checked or took too long. Try again.`;
    if (answer.status === 429 || answer.status === 503) return said ?? `${label} sign-in could not be checked right now. Please try again in a minute.`;
    if (answer.status === 404) return 'That restore timed out on the community. Start again.';
    return said ?? `The community could not bring the account back (${answer.status}). Please try again.`;
}

/** A refused request to open the session or get a nonce, in plain words. */
export function sessionRefusalMessage(answer: DoorAnswer, callsign: string): string {
    const said = typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : null;
    if (answer.status === 400) return `${callsign} has no sign-in to come back with here. Use your 12 words, or the phone app.`;
    if (answer.status === 409) return `More than one account here is called ${callsign}. Use your 12 words, or the phone app.`;
    if (answer.status === 429) return said ?? 'Too many tries from this network. Please try again later.';
    return said ?? `The community could not start a restore (${answer.status}). Please try again in a minute.`;
}
