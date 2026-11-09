/**
 * Getting an account back in a web browser with the sign-in it joined with (design G11 §4.4, G11-d; Marty, D-1 = a,
 * 2026-09-25): a browser that was cleared, or a new one, gets the member's own key back, never a second identity.
 * Everything the restore screens (components/WebRestore.tsx) do that is not drawing.
 *
 * ## The shape of it: the community finds the account from the sign-in (recovery S1)
 *
 * Nothing is typed (scratch design DESIGN-recovery-no-callsign-fable.md §3, §5; Marty, 9 Nov). The community is the one
 * this page belongs to. Against the node's recovery routes (apps/server/src/routes/recovery-collect.ts):
 *
 *   1. A throwaway key is made for this restore (`makeEphemeralKey`). It is not an account and is never saved as one.
 *      It signs every call below, and the node binds the find, its hold and the recovery session to it.
 *   2. `POST /api/recovery/find-nonce` gives the sign-in nonce for the throwaway key, with the ids a browser puts in its
 *      request to each provider (`clientIds`). A server from before the find answers 404: it can't find an account from a
 *      sign-in yet, and the member is told so (design §4).
 *   3. The sign-in: Google, Apple and Facebook leave the page exactly as the join does (lib/web-join.ts builds the same
 *      requests, and they come back to the same `/app/auth/<provider>` page); the throwaway key waits as a pending
 *      restore (identity.ts).
 *   4. `POST /api/recovery/find` with the token: the accounts this sign-in protects here, by name and key (none, one, or
 *      several when one sign-in protects several). The node holds the verified sign-in for 5 minutes, for this key.
 *   5. `POST /api/recovery/collect { candidatePublicKey }` for the account picked, by that hold: the node opens the session
 *      and releases the account's sign-in copy in the same request (the account's owner is told), and
 *      `POST /api/recovery/collect/fragments` hands it over, sealed to the throwaway key, while the session is live.
 *   6. core's `openSeedFromSso` opens it with the sign-in's `sub`: the account's seed, and its 12 words when the copy
 *      carried them. The format is core's alone: nothing here reads the blob but that function.
 *
 * ## Nothing is saved unless it is the account the find named
 *
 * `openRestoredAccount` builds the key from the seed, and keeps the words only when this app's own derivation of them
 * (lib/mnemonic.ts, as a 12-words restore would run it) makes that same key. Then the key must equal the public key the
 * find named for the account the member picked. Anything else (another account's copy, a node answering for someone
 * else) is refused and nothing is written. The phone's restore at a community makes the same check (apps/native/utils/
 * sso-recovery.ts `recoverAccountWithSso`, #1951). What is saved goes through the identity store's guarded write
 * (identity.ts importIdentity: one browser, one account), from WelcomePage, which also settles a join this browser sent
 * first.
 *
 * ## What is not done here
 *
 * The old two-part copy (`scrypt-xc20p-v1`, half a seed, the other half from the node after a wait) is not opened on
 * the web: every copy the global community holds is the single kind (both apps' joins seal nothing else), and a copy of
 * the old kind is said plainly, with the 12 words and the phone as the ways back.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    isSingleBlobSso,
    KEEPER_ALG_RELEASE,
    openListedFragment,
    openSeedFromSso,
    toEd25519Pkcs8,
    type CopyCommunity,
    type ListedFragment,
    type SealedShare,
} from '@beanpool/core';
import { identityFromMnemonic, JOIN_PROVIDERS, type BeanPoolIdentity, type JoinProvider } from './identity';
import { door, isWrongClock, providerLabel, WRONG_CLOCK, type DoorAnswer } from './web-join';

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

// ===================== THE NODE'S FIND AND COLLECT (routes/recovery-collect.ts) =====================

/** The node's answer to a find nonce request: which sign-ins a browser can use for it, and the nonce. */
export interface RestoreNonce {
    nonce: string;
    clientIds: Partial<Record<JoinProvider, string | null>>;
}

/**
 * A sign-in nonce for finding the account, bound to `eph` (`POST /api/recovery/find-nonce`). `tooOld`: the community's
 * server answers 404, so it has no find yet and can't find an account from a sign-in (design §4).
 */
export async function requestFindNonce(eph: EphemeralKey): Promise<{ nonce: RestoreNonce } | { tooOld: true } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/recovery/find-nonce', {}, signer(eph));
    if (answer.status === 404) return { tooOld: true };
    const b = answer.body;
    if (answer.status !== 200 || typeof b.nonce !== 'string' || !b.nonce) return { answer };
    return {
        nonce: {
            nonce: b.nonce,
            clientIds: b.clientIds && typeof b.clientIds === 'object' ? b.clientIds : {},
        },
    };
}

/**
 * The sign-ins to offer, in JOIN_PROVIDERS' order (the node does not say which one an account has: the member knows):
 * each one the node gave a browser id for. One without stays hidden rather than sending the member to a sign-in the
 * node would refuse.
 */
export function restoreProviders(n: RestoreNonce): JoinProvider[] {
    return JOIN_PROVIDERS.filter((p) => typeof n.clientIds[p] === 'string' && !!n.clientIds[p]);
}

/** The sign-in a find goes with: the provider's token and its nonce, and the `sub` the copy opens with. */
export interface RestoreProof {
    provider: JoinProvider;
    idToken: string;
    nonce: string;
    sub: string;
}

/** One account the find named: the name it has here, and its key. */
export interface RestoreCandidate {
    publicKey: string;
    callsign: string;
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * The accounts this sign-in protects here (`POST /api/recovery/find`), each with a key and a name, in the node's order;
 * one named twice is listed once. Empty: no account here uses this sign-in. The node holds the verified sign-in for
 * `collectAccount`, for this throwaway key, for 5 minutes.
 */
export async function findAccounts(eph: EphemeralKey, proof: RestoreProof): Promise<{ accounts: RestoreCandidate[] } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/recovery/find', { provider: proof.provider, idToken: proof.idToken, nonce: proof.nonce }, signer(eph));
    if (answer.status !== 200 || !Array.isArray(answer.body.accounts)) return { answer };
    const seen = new Set<string>();
    const accounts = (answer.body.accounts as Array<Record<string, unknown> | null>).flatMap((c): RestoreCandidate[] => {
        const publicKey = typeof c?.publicKey === 'string' ? c.publicKey.trim().toLowerCase() : '';
        const callsign = typeof c?.callsign === 'string' ? c.callsign : '';
        if (!HEX_KEY.test(publicKey) || !callsign.trim() || seen.has(publicKey)) return [];
        seen.add(publicKey);
        return [{ publicKey, callsign }];
    });
    return { accounts };
}

/**
 * Open the node's recovery session for the account picked, by the find's hold (`POST /api/recovery/collect
 * { candidatePublicKey }`): the node releases the account's sign-in copy to it in the same request, and tells its owner.
 */
export async function collectAccount(eph: EphemeralKey, account: RestoreCandidate): Promise<{ collectionId: string } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/recovery/collect', { candidatePublicKey: account.publicKey }, signer(eph));
    const id = answer.body.collectionId;
    if (answer.status !== 200 || typeof id !== 'string' || !id) return { answer };
    return { collectionId: id };
}

/**
 * The released sign-in copy, as core opens it; null when the node has none for this session.
 *
 * Asked for sealed to the throwaway key (`seal`, defence review FABLE-sec-sso finding 2), and opened here with it
 * (core `openListedFragment`): the copy that crosses the wire, or lands in a log, is nothing without that key, which
 * never leaves this browser. A community from before the seal ignores the request and sends the copy as stored, and
 * that is taken as it comes. `unopened`: it came sealed and did not open with this restore's key, so nothing of it is
 * returned.
 */
export async function fetchSignInCopy(eph: EphemeralKey, collectionId: string): Promise<{ copy: SealedShare | null } | { unopened: true } | { answer: DoorAnswer }> {
    const answer = await door('POST', '/api/recovery/collect/fragments', { collectionId, seal: KEEPER_ALG_RELEASE }, signer(eph));
    if (answer.status !== 200 || !Array.isArray(answer.body.fragments)) return { answer };
    const listed = (answer.body.fragments as Array<Record<string, unknown> | null>).find((x) => x?.holderType === 'sso');
    if (!listed || typeof listed.payload !== 'string' || typeof listed.payloadIv !== 'string' || typeof listed.payloadTag !== 'string') {
        return { copy: null };
    }
    let f: ListedFragment;
    try {
        f = openListedFragment(listed as unknown as ListedFragment, eph.privateKey, collectionId);
    } catch (e) {
        console.warn(`[WebRestore] the copy sealed to this restore did not open: ${(e as Error)?.message || e}`);
        return { unopened: true };
    }
    if (typeof f.kdfParams !== 'string') return { copy: null };
    return { copy: { encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams } };
}

// ===================== OPENING IT, AND THE ONE CHECK THAT DECIDES =====================

export type OpenedAccount =
    /**
     * The account the find named: its key, and its 12 words when they came back and make it. `communities`: the
     * member's list, when the copy carried one (vault rethink VR5, core copy-communities.ts), else empty.
     */
    | { kind: 'ok'; identity: BeanPoolIdentity; communities: CopyCommunity[] }
    /** It opened to another key than the one the find named. Nothing of it is returned. */
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
    let communities: CopyCommunity[];
    try {
        const opened = await openSeedFromSso(copy, provider, sub);
        seed = opened.seed;
        words = opened.words;
        // The list never fails a restore: one that didn't open is no list (core says 'unreadable').
        communities = opened.communities ?? [];
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
        return { kind: 'ok', identity, communities };
    } finally {
        seed.fill(0);
    }
}

// ===================== WHAT THE MEMBER READS =====================
//
// In English, never through the words layer: this file opens the account's copy and checks its 12 words against the
// key, so it is on the 12 words' key path, and nothing on it may reach t() or word() (core recovery-path-files.test.ts).
// The restore screen shows these sentences in the member's language through components/key-lines.ts, which reads each
// one back by its English (key-lines.test.ts holds every sentence here to its pattern there).

/** No account at this community uses this sign-in (design §5). */
export function noAccountMessage(community: string, provider: JoinProvider): string {
    return `No account at ${community} uses this ${providerLabel(provider)} account. Try another community, or your 12 words.`;
}

/** The community's server has no find yet (design §4): it answered the find nonce with 404. */
export function serverTooOldMessage(community: string): string {
    return `${community}'s server is older than this app and can't find your account from a sign-in yet. Ask its admin to update, or use your 12 words.`;
}

/**
 * The node's refusal of a find (`provider`: the sign-in it went with), or of a find nonce (null: no sign-in yet), in
 * plain words. The node's own sentence where it gave one: a busy scan, a standby, a server without its seal key.
 */
export function findRefusalMessage(answer: DoorAnswer, provider: JoinProvider | null): string {
    const said = typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : null;
    if (isWrongClock(answer)) return WRONG_CLOCK;
    if (answer.status === 429) return said ?? 'Too many tries from this network. Please try again later.';
    if (provider) {
        const label = providerLabel(provider);
        if (answer.status === 401) return `${label} sign-in couldn't be checked or took too long. Try again.`;
        if (answer.status === 503) return said ?? `${label} sign-in could not be checked right now. Please try again in a minute.`;
    }
    return said ?? `The community could not bring the account back (${answer.status}). Please try again.`;
}

/** The node's answer to a collect, or to a fetch of the copy, that let nothing go, in plain words. */
export function collectRefusalMessage(answer: DoorAnswer): string {
    const said = typeof answer.body.error === 'string' && answer.body.error ? answer.body.error : null;
    if (isWrongClock(answer)) return WRONG_CLOCK;
    if (answer.status === 429) return said ?? 'Too many tries from this network. Please try again later.';
    return said ?? `The community could not bring the account back (${answer.status}). Please try again.`;
}
