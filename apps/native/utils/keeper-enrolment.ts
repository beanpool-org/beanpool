/**
 * Keeper enrolment — splitting a member's seed into the two-layer model.
 *
 * ## The two-layer model (docs/recovery-model.md)
 *
 * ```
 * seed  =  A  ⊕  B
 *   A  →  hub share. Plaintext on the node. Released under D7.
 *   B  →  members' half. SSO: sealed whole. Non-SSO: Shamir 2-of-N across friends.
 * ```
 *
 * ## What happens at signup
 *
 * Nothing. At signup a member is sovereign — no keepers, no fragments, just the 12 words.
 * This is not a gap; it is the design. There is nobody to split to yet:
 *
 * - **SSO keepers** are added later when the member signs in with Google or Apple (Step 5).
 * - **Friend keepers** are added later through add-a-friend (Step 6).
 * - **The PWA** is excluded from the keeper system entirely (docs/recovery-model.md §PWA).
 *
 * {@link enrolKeepers} still runs at signup to maintain the call site contract, but it
 * returns immediately with `enrolled: []` and `generation: null`. The caller
 * (`welcome.tsx`) renders the words-only screen, which is correct.
 *
 * The one exception is joining the global community (utils/global-join.ts): its door needs a
 * sign-in anyway, so the join carries the sealed seed ({@link sealSsoShares}) and the node
 * stores it from the sign-in it has just verified. {@link enrolmentFromJoin} reads the answer,
 * and the Safety Backup step shows that sign-in as protecting the member without asking again.
 *
 ## Entry point
 *
 * An SSO sign-in triggers a split which calls `POST /api/recovery/shares/sso` — the node
 * verifies the token and derives the lookup hash server-side, then writes a full generation
 * atomically through `putShareGeneration`.
 *
 * {@link enrolSsoKeeper} below holds the client-side split logic. It is not called at signup:
 * it runs when the member signs in with a provider for the first time. The friend-keeper
 * counterpart and its `POST /api/recovery/shares` endpoint are deleted — social recovery is
 * scrapped, and the only paths back in are SSO and the member's twelve words.
 */

import {
    recoveryWordsMatchSeed,
    sealSeedToSso,
    toEd25519Seed,
    type SealedShare,
} from '@beanpool/core';
import { anchorUrl, signedPost, signedDelete } from './node-post';
import { hexToBytes } from './crypto';
import { getMnemonic, type BeanPoolIdentity } from './identity';
import type { SsoProvider } from './sso-signin';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The keeper kinds this function can enrol.
 *
 * Retired: `'device'` — the two-layer model has no device fragment. See
 * docs/recovery-model.md §"Where the fragments actually live".
 */
export type EnrolledKeeper = 'hub' | 'member' | 'sso';

export interface KeeperEnrolmentResult {
    /** Keepers that actually received a piece. The step 3 state is chosen by counting this. */
    enrolled: EnrolledKeeper[];
    /** The node's generation number, or null if nothing was uploaded. */
    generation: number | null;
    /** Why a keeper was not enrolled — for logs and for deciding what step 3 offers next. */
    skipped: { keeper: string; reason: string }[];
    /**
     * How many keepers were AVAILABLE, which is not the same as how many were enrolled.
     *
     * At signup this is 0 — no keepers are available until the member adds them later
     * through SSO sign-in or add-a-friend. Step 3 reads this as "your words are the way back".
     */
    available: number;
    /** Specific SSO providers currently protecting the account. */
    enrolledSso?: string[];
    /** Effective threshold required for recovery. */
    threshold?: number;
    /** Whether single-blob SSO format is in use. */
    isSingleBlob?: boolean;
    /** Whether this deposit carries the 12 words, so a sign-in restore from it gives them back. */
    wordsSealed?: boolean;
    /** Set when enrolment did not happen at all. For logs, never for a member. */
    error?: string;
}

// ---------------------------------------------------------------------------
// Signup entry point — sovereign by default
// ---------------------------------------------------------------------------

/**
 * Called at signup. Under the two-layer model, a new member is sovereign until they add
 * keepers — so this does nothing and says so.
 *
 * Never throws. The call site contract is unchanged: `welcome.tsx` fires this in a
 * `useEffect`, renders `protectionFrom(result)`, and the words-only screen is correct
 * for every member at signup.
 */
export async function enrolKeepers(_identity: BeanPoolIdentity): Promise<KeeperEnrolmentResult> {
    // Under the two-layer model, signup produces no keepers. The member is sovereign
    // until they sign in with Google/Apple (SSO tier) or pick friends (non-SSO tier).
    // Both are separate, user-initiated flows that did not exist in the old model.
    return {
        enrolled: [],
        generation: null,
        skipped: [],
        available: 0,
        enrolledSso: [],
    };
}

// ---------------------------------------------------------------------------
// SSO-tier enrolment — called from the sign-in flow (not at signup)
// ---------------------------------------------------------------------------

interface SsoEnrolmentBase {
    /** The identity of the member being enrolled. */
    identity: BeanPoolIdentity;
    /** The provider's subject (user id), used to derive the sealing key. */
    sub: string;
}

/**
 * What the deposit proves the sign-in with. Apple, Google and Facebook: the provider's `id_token` and
 * the node's nonce inside it. GitHub: the node's own finished sign-in session (`proof: { sessionId }`),
 * because a GitHub token proves nothing a node can check — never a token.
 */
export type SsoEnrolmentInput =
    | SsoEnrolmentBase & { provider: Exclude<SsoProvider, 'github'>; idToken: string; nonce: string }
    | SsoEnrolmentBase & { provider: 'github'; proof: { sessionId: string } };

/**
 * Seal the member's entire seed (and the 12 words, when this phone has them) into a single
 * device-encrypted AEAD blob under scrypt(provider:sub), then deposit through
 * `POST /api/recovery/shares/sso` which verifies the token server-side.
 *
 * This is NOT called at signup. It is called when the member signs in with Google or
 * Apple for the first time, which is a separate user-initiated flow.
 *
 * Never throws — returns an error string on failure, matching the never-throws contract
 * of the keeper enrolment module.
 */
export async function enrolSsoKeeper(input: SsoEnrolmentInput): Promise<KeeperEnrolmentResult> {
    const { identity, provider, sub } = input;
    const skipped: { keeper: string; reason: string }[] = [];
    const nothing = (error: string): KeeperEnrolmentResult => {
        // Logged, not just returned: every enrolment failure to date has been invisible in
        // logcat, so the only evidence was the member reporting that nothing happened.
        console.log(`[KEEPER] ${provider}: enrolment failed — ${error}`);
        return { enrolled: [], generation: null, skipped, available: 0, error };
    };

    // Checked here as well as by the type: a GitHub deposit that carries a token rather than the
    // node's session is exactly the credential the node must not be handed, so it is not sent.
    let credential: { idToken: string; nonce: string } | { proof: { sessionId: string } };
    if (input.provider === 'github') {
        const sessionId = input.proof?.sessionId;
        if (typeof sessionId !== 'string' || !sessionId) {
            return nothing('GitHub is connected through your community\'s server, and this sign-in did not come from it');
        }
        credential = { proof: { sessionId } };
    } else {
        credential = { idToken: input.idToken, nonce: input.nonce };
    }

    // The 12 words are never required: a phone restored from a sign-in copy made before copies carried
    // them holds none (they can't be rebuilt from the seed), and it belongs to exactly the member who
    // most needs a connected sign-in. Such a phone deposits the seed alone.
    const url = await anchorUrl();
    if (!url) return nothing('no node configured yet');

    let sealed: SealedSsoShares;
    try {
        sealed = await sealSsoShares(identity, provider, sub);
    } catch (e) {
        return nothing((e as Error).message);
    }
    const { shares, wordsSealed } = sealed;

    try {
        const res = await signedPost(url, '/api/recovery/shares/sso', {
            provider,
            shares,
            ...credential,
        }, identity);
        console.log(`[KEEPER] ${provider}: deposit responded ${res.status}`);
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return nothing(`node refused the fragments (${res.status}): ${detail.slice(0, 200)}`);
        }
        const body = await res.json() as { generation?: number; enrolledSso?: string[]; threshold?: number };
        const enrolledSso = body.enrolledSso ?? [provider];
        return {
            enrolled: enrolledSso.map(() => 'sso' as const),
            generation: body.generation ?? null,
            skipped,
            available: enrolledSso.length,
            enrolledSso,
            threshold: body.threshold ?? 1,
            isSingleBlob: true,
            wordsSealed,
        };
    } catch (e) {
        return nothing(`could not reach the node: ${(e as Error).message}`);
    }
}

/** The deposit's one piece: the whole seed (and the words, when they make it) sealed to a sign-in. */
export interface SealedSsoShares {
    shares: Array<SealedShare & { holderType: 'sso'; holderRef: SsoProvider; shareIndex: 1 }>;
    /** Whether the 12 words travel with the seed, so a sign-in restore gives them back. */
    wordsSealed: boolean;
}

/**
 * Seal the member's entire seed (and the 12 words, when this phone has them) into a single
 * device-encrypted AEAD blob under scrypt(provider:sub): the shares a deposit carries.
 *
 * Shared by the two deposits: `enrolSsoKeeper` (the protection sheet, its own sign-in) and the global
 * community's join (utils/global-join.ts), which carries these in the join itself so one sign-in
 * both joins and protects. Throws with a reason for a log, never words or keys.
 */
export async function sealSsoShares(identity: BeanPoolIdentity, provider: SsoProvider, sub: string): Promise<SealedSsoShares> {
    // The identity's privateKey is either a raw 32-byte Ed25519 seed or a
    // 48-byte PKCS8 envelope (as created by the PWA), hex-encoded.
    let seed: Uint8Array;
    try {
        seed = toEd25519Seed(hexToBytes(identity.privateKey));
    } catch (e) {
        throw new Error(`could not read the private key: ${(e as Error).message}`);
    }

    // When this phone has the 12 words, they travel with the seed, so a sign-in restore gives them back
    // (keeper-crypto.ts sealSeedToSso). Only words that make this seed's key: anything else would be
    // thrown away at restore, so it is left out here and the seed goes alone. Never the words in a log.
    const words = await getMnemonic(identity);
    const sealWords = words && recoveryWordsMatchSeed(words, seed) ? words : null;
    if (words && !sealWords) {
        console.log(`[KEEPER] ${provider}: this phone's 12 words do not make its key; sealing the key alone`);
    }

    // Seal the entire 32-byte Ed25519 seed to the SSO provider under scrypt(provider:sub).
    // The server will independently verify the token and derive the same key during recovery.
    let ssoSealed: SealedShare;
    try {
        ssoSealed = await sealSeedToSso(seed, provider, sub, { words: sealWords });
    } catch (e) {
        throw new Error(`could not seal the SSO fragment: ${(e as Error).message}`);
    }

    return {
        shares: [{ holderType: 'sso', holderRef: provider, shareIndex: 1, ...ssoSealed }],
        wordsSealed: !!sealWords,
    };
}

/**
 * The join's recovery answer (`POST /api/join` with `recovery: { shares }`, apps/server/src/routes/open-join.ts)
 * as an enrolment result, so the Safety Backup step shows the sign-in the member joined with as already
 * protecting them. Null when the node did not store it: the step then offers the ordinary connect, and the
 * member signs in a second time only in that case.
 */
export function enrolmentFromJoin(
    recovery: unknown, provider: SsoProvider, wordsSealed: boolean,
): KeeperEnrolmentResult | null {
    if (!recovery || typeof recovery !== 'object') return null;
    const r = recovery as { enrolled?: unknown; generation?: unknown; enrolledSso?: unknown; threshold?: unknown; error?: unknown };
    if (r.enrolled !== true) {
        console.log(`[KEEPER] ${provider}: the join did not store the recovery copy — ${typeof r.error === 'string' ? r.error.slice(0, 200) : 'no reason given'}`);
        return null;
    }
    const enrolledSso = Array.isArray(r.enrolledSso) && r.enrolledSso.every(p => typeof p === 'string')
        ? r.enrolledSso as string[]
        : [provider];
    return {
        enrolled: enrolledSso.map(() => 'sso' as const),
        generation: typeof r.generation === 'number' ? r.generation : null,
        skipped: [],
        available: enrolledSso.length,
        enrolledSso,
        threshold: typeof r.threshold === 'number' ? r.threshold : 1,
        isSingleBlob: true,
        wordsSealed,
    };
}

/**
 * Disconnect a single SSO provider from the node's recovery set.
 */
export async function disconnectSsoKeeper(
    provider: string,
    identity: BeanPoolIdentity,
): Promise<{ success: boolean; error?: string; enrolledSso?: string[] }> {
    const url = await anchorUrl();
    if (!url) return { success: false, error: 'No node configured.' };

    try {
        const res = await signedDelete(url, `/api/recovery/shares/sso/${encodeURIComponent(provider)}`, identity);
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return { success: false, error: `Could not disconnect ${provider}: ${detail.slice(0, 150)}` };
        }
        const data = await res.json() as { enrolledSso?: string[] };
        return { success: true, enrolledSso: data.enrolledSso ?? [] };
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
}
