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
    sealSeedToSso,
    toEd25519Seed,
    type SealedShare,
} from '@beanpool/core';
import { anchorUrl, signedPost, signedDelete } from './node-post';
import { hexToBytes } from './crypto';
import type { BeanPoolIdentity } from './identity';
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
 * Seal the member's entire seed into a single device-encrypted AEAD blob under
 * scrypt(provider:sub), then deposit through `POST /api/recovery/shares/sso`
 * which verifies the token server-side.
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

    const words = identity.mnemonic;
    if (!words || words.length === 0) {
        return nothing('this identity has no recovery words to split');
    }

    const url = await anchorUrl();
    if (!url) return nothing('no node configured yet');

    // The identity's privateKey is either a raw 32-byte Ed25519 seed or a
    // 48-byte PKCS8 envelope (as created by the PWA), hex-encoded.
    let seed: Uint8Array;
    try {
        seed = toEd25519Seed(hexToBytes(identity.privateKey));
    } catch (e) {
        return nothing(`could not read the private key: ${(e as Error).message}`);
    }

    // Seal the entire 32-byte Ed25519 seed to the SSO provider under scrypt(provider:sub).
    // The server will independently verify the token and derive the same key during recovery.
    let ssoSealed: SealedShare;
    try {
        ssoSealed = await sealSeedToSso(seed, provider, sub);
    } catch (e) {
        return nothing(`could not seal the SSO fragment: ${(e as Error).message}`);
    }

    const shares = [
        {
            holderType: 'sso' as const, holderRef: provider, shareIndex: 1,
            ...ssoSealed,
        },
    ];

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
        };
    } catch (e) {
        return nothing(`could not reach the node: ${(e as Error).message}`);
    }
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
