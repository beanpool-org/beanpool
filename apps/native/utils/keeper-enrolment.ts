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
 * ## Future entry points (not yet built)
 *
 * When an SSO or friend flow triggers a split, it will call the server's deposit endpoint
 * directly — either `POST /api/recovery/shares/sso` (which verifies the token and derives
 * the lookup hash server-side) or `POST /api/recovery/shares` (for friend fragments sealed
 * client-side). Both already exist and both write a full generation atomically through
 * `putShareGeneration`.
 *
 * The functions below — {@link enrolSsoKeeper} and {@link enrolFriendKeepers} — provide the
 * client-side split logic for those flows. They are exported but not called at signup.
 */

import {
    recordShareForHub,
    sealShareToMember,
    sealShareToSso,
    splitTwoLayer,
    splitHubAndWhole,
    type SealedShare,
} from '@beanpool/core';
import { anchorUrl, signedPost } from './node-post';
import { hexToBytes } from './crypto';
import type { BeanPoolIdentity } from './identity';

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
    };
}

// ---------------------------------------------------------------------------
// SSO-tier enrolment — called from the sign-in flow (not at signup)
// ---------------------------------------------------------------------------

export interface SsoEnrolmentInput {
    /** The identity of the member being enrolled. */
    identity: BeanPoolIdentity;
    /** The SSO provider name, e.g. 'google' or 'apple'. */
    provider: string;
    /** The `sub` claim from the provider's id_token, used to derive the sealing key. */
    sub: string;
    /** The provider's `id_token` from the client. */
    idToken: string;
    /** The nonce issued by the node for this sign-in. */
    nonce: string;
}

/**
 * Split the member's seed into hub + SSO using `splitHubAndWhole`, then deposit
 * through `POST /api/recovery/shares/sso` which verifies the token server-side.
 *
 * This is NOT called at signup. It is called when the member signs in with Google or
 * Apple for the first time, which is a separate user-initiated flow.
 *
 * Never throws — returns an error string on failure, matching the never-throws contract
 * of the keeper enrolment module.
 */
export async function enrolSsoKeeper(input: SsoEnrolmentInput): Promise<KeeperEnrolmentResult> {
    const { identity, provider, sub, idToken, nonce } = input;
    const skipped: { keeper: string; reason: string }[] = [];
    const nothing = (error: string): KeeperEnrolmentResult =>
        ({ enrolled: [], generation: null, skipped, available: 0, error });

    const words = identity.mnemonic;
    if (!words || words.length === 0) {
        return nothing('this identity has no recovery words to split');
    }

    const url = await anchorUrl();
    if (!url) return nothing('no node configured yet');

    // The identity's privateKey IS the 32-byte Ed25519 seed, hex-encoded.
    // It was derived from the mnemonic at identity creation time.
    let seed: Uint8Array;
    try {
        seed = hexToBytes(identity.privateKey);
        if (seed.length !== 32) {
            return nothing(`private key is ${seed.length} bytes, expected 32`);
        }
    } catch (e) {
        return nothing(`could not read the private key: ${(e as Error).message}`);
    }

    let hubShare: Uint8Array;
    let otherHalf: Uint8Array;
    let seedChecksum: Uint8Array;
    try {
        const result = await splitHubAndWhole(seed);
        hubShare = result.hubShare;
        otherHalf = result.otherHalf;
        seedChecksum = result.seedChecksum;
    } catch (e) {
        return nothing(`could not split the seed: ${(e as Error).message}`);
    }

    // Seal B to the SSO provider. The scrypt key is derived from `provider:sub`,
    // where `sub` is the subject claim the client read from the id_token. The server
    // will independently verify the token and derive the same key.
    let ssoSealed: SealedShare;
    try {
        ssoSealed = await sealShareToSso(otherHalf, provider, sub);
    } catch (e) {
        return nothing(`could not seal the SSO fragment: ${(e as Error).message}`);
    }

    const shares = [
        {
            holderType: 'hub' as const, holderRef: 'node', shareIndex: 1,
            ...recordShareForHub(hubShare),
        },
        {
            holderType: 'sso' as const, holderRef: provider, shareIndex: 2,
            ...ssoSealed,
        },
    ];

    try {
        const res = await signedPost(url, '/api/recovery/shares/sso', {
            provider,
            shares,
            idToken,
            nonce,
        }, identity);
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return nothing(`node refused the fragments (${res.status}): ${detail.slice(0, 200)}`);
        }
        const body = await res.json() as { generation?: number };
        return {
            enrolled: ['hub', 'sso'],
            generation: body.generation ?? null,
            skipped,
            available: 2,
        };
    } catch (e) {
        return nothing(`could not reach the node: ${(e as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// Friend-tier enrolment — called from add-a-friend (not at signup)
// ---------------------------------------------------------------------------

export interface FriendEnrolmentInput {
    /** The identity of the member being enrolled. */
    identity: BeanPoolIdentity;
    /** Public keys of the friends to split across. Must be ≥ 2. */
    friendPublicKeys: string[];
}

/**
 * Split the member's seed into hub + friend shares using `splitTwoLayer`, then deposit
 * through `POST /api/recovery/shares`.
 *
 * This is NOT called at signup. It is called when the member adds friends through the
 * add-a-friend flow.
 *
 * Never throws.
 */
export async function enrolFriendKeepers(input: FriendEnrolmentInput): Promise<KeeperEnrolmentResult> {
    const { identity, friendPublicKeys } = input;
    const skipped: { keeper: string; reason: string }[] = [];
    const nothing = (error: string): KeeperEnrolmentResult =>
        ({ enrolled: [], generation: null, skipped, available: 0, error });

    if (friendPublicKeys.length < 2) {
        return nothing(`need at least 2 friends, got ${friendPublicKeys.length}`);
    }

    const words = identity.mnemonic;
    if (!words || words.length === 0) {
        return nothing('this identity has no recovery words to split');
    }

    const url = await anchorUrl();
    if (!url) return nothing('no node configured yet');

    let seed: Uint8Array;
    try {
        seed = hexToBytes(identity.privateKey);
        if (seed.length !== 32) {
            return nothing(`private key is ${seed.length} bytes, expected 32`);
        }
    } catch (e) {
        return nothing(`could not read the private key: ${(e as Error).message}`);
    }

    let hubShare: Uint8Array;
    let friendShares: Uint8Array[];
    try {
        const result = await splitTwoLayer(seed, friendPublicKeys.length);
        hubShare = result.hubShare;
        friendShares = result.friendShares;
    } catch (e) {
        return nothing(`could not split the seed: ${(e as Error).message}`);
    }

    const shares: (SealedShare & { holderType: string; holderRef: string; shareIndex: number })[] = [];
    try {
        shares.push({
            holderType: 'hub', holderRef: 'node', shareIndex: 1,
            ...recordShareForHub(hubShare),
        });
        for (let i = 0; i < friendPublicKeys.length; i++) {
            shares.push({
                holderType: 'member', holderRef: friendPublicKeys[i], shareIndex: i + 2,
                ...sealShareToMember(friendShares[i], friendPublicKeys[i]),
            });
        }
    } catch (e) {
        return nothing(`could not seal the pieces: ${(e as Error).message}`);
    }

    try {
        const res = await signedPost(url, '/api/recovery/shares', { shares }, identity);
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return nothing(`node refused the fragments (${res.status}): ${detail.slice(0, 200)}`);
        }
        const body = await res.json() as { generation?: number };
        const enrolled: EnrolledKeeper[] = ['hub', ...friendPublicKeys.map(() => 'member' as const)];
        return {
            enrolled,
            generation: body.generation ?? null,
            skipped,
            available: enrolled.length,
        };
    } catch (e) {
        return nothing(`could not reach the node: ${(e as Error).message}`);
    }
}
