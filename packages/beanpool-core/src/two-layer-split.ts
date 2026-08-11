/**
 * Two-layer recovery split — the `A ⊕ B` construction.
 *
 * ## Construction
 *
 * ```
 * seed  =  A  ⊕  B
 *   A  →  the hub share. Random bytes, never a Shamir share, never counted in
 *          any threshold. Stored plaintext in the node's database.
 *   B  →  seed ⊕ A, then Shamir-split across friendCount shares at threshold 2.
 *          Never readable by the node.
 * ```
 *
 * XOR on top makes **both halves mandatory**. Shamir underneath splits `B` and
 * gives *any 2 of n*. This is the whole trick: the node alone can never recover
 * anybody, and all the friends together can never recover anybody either. It is
 * structural, not a policy constant.
 *
 * ## Integrity
 *
 * `combineTwoLayer` with wrong or corrupt friend shares reconstructs a garbage
 * `B`, and `garbage ⊕ A` is 32 bytes that form a perfectly valid Ed25519 seed.
 * Recovery would then "succeed" and silently hand someone a different, empty
 * account. This is the worst failure mode in the system — identical in kind to
 * the raw-Shamir problem the phrase-level API solves with its checksum envelope.
 *
 * So the split carries a 4-byte SHA-256 checksum of the seed. `combineTwoLayer`
 * verifies the reconstructed seed against it and throws {@link TwoLayerCombineError}
 * on mismatch. False accept ≈ 1 in 2³², against a failure whose cost is a user
 * landing in an empty account mid-recovery.
 *
 * ## Constants
 *
 * {@link TWO_LAYER_THRESHOLD} (= 2) is the threshold for layer two's Shamir split.
 * It is deliberately a new constant, not a mutation of `RECOVERY_THRESHOLD` (= 3),
 * which the sovereign/phrase path still uses unchanged.
 */

import CryptoJS from 'crypto-js';
import { Buffer } from 'buffer';
import {
    assertRecoveryCsprngAvailable,
    RecoveryCombineError,
    splitBytes,
    combineBytes,
} from './recovery-split.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Length of an Ed25519 seed in bytes. */
const SEED_LENGTH = 32;

/**
 * Shamir threshold for layer two — any 2 of the friend shares reconstruct `B`.
 *
 * This is intentionally separate from `RECOVERY_THRESHOLD` (= 3) in
 * `recovery-split.ts`, which governs the sovereign/phrase path. Do not merge
 * them — the two layers have different security models and changing one must
 * not silently affect the other.
 */
export const TWO_LAYER_THRESHOLD = 2;

/** Bytes of `SHA-256(seed)` carried alongside the split for integrity. */
const SEED_CHECKSUM_LENGTH = 4;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Raised when friend shares and hub share do not reconstruct a seed matching
 * its checksum. See the module-level note on why this must be an error rather
 * than a wrong answer.
 */
export class TwoLayerCombineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TwoLayerCombineError';
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First {@link SEED_CHECKSUM_LENGTH} bytes of `SHA-256(seed)`. */
function seedChecksum(seed: Uint8Array): Uint8Array {
    // Convert to hex and parse via CryptoJS.enc.Hex so the hash covers the
    // actual 32 bytes, not a zero-padded WordArray reinterpretation.
    const hexSeed = Array.from(seed)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    const hex = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(hexSeed)).toString();
    const out = new Uint8Array(SEED_CHECKSUM_LENGTH);
    for (let i = 0; i < SEED_CHECKSUM_LENGTH; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

/** Byte-wise XOR of two equal-length buffers. Returns a new Uint8Array. */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length !== b.length) {
        throw new Error(
            `xorBytes: buffers must be of equal length (got ${a.length} and ${b.length}).`,
        );
    }
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) {
        out[i] = a[i] ^ b[i];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of {@link splitTwoLayer}.
 *
 * `hubShare` is `A` — random bytes the same length as the seed, stored
 * plaintext on the node. It is **not** a Shamir share.
 *
 * `friendShares` are Shamir shares of `B = seed ⊕ A`, at threshold
 * {@link TWO_LAYER_THRESHOLD}. Each is one byte longer than the seed (the
 * extra byte is the Shamir x-coordinate).
 *
 * `seedChecksum` is the first 4 bytes of `SHA-256(seed)`, carried alongside
 * the shares so that `combineTwoLayer` can verify integrity.
 */
export interface TwoLayerSplitResult {
    hubShare: Uint8Array;
    friendShares: Uint8Array[];
    seedChecksum: Uint8Array;
}

/**
 * Splits a 32-byte Ed25519 seed into a hub share and Shamir-split friend shares.
 *
 * @param seed         exactly 32 bytes — the raw Ed25519 private key seed
 * @param friendCount  how many friend shares to produce; must be ≥ 2 and ≤ 255
 * @returns            `{ hubShare, friendShares, seedChecksum }`
 */
export async function splitTwoLayer(
    seed: Uint8Array,
    friendCount: number,
): Promise<TwoLayerSplitResult> {
    // --- validation ---
    if (!(seed instanceof Uint8Array) || seed.length !== SEED_LENGTH) {
        throw new Error(
            `splitTwoLayer: seed must be exactly ${SEED_LENGTH} bytes, ` +
            `got ${seed instanceof Uint8Array ? seed.length : typeof seed}.`,
        );
    }
    if (!Number.isInteger(friendCount) || friendCount < TWO_LAYER_THRESHOLD) {
        throw new Error(
            `splitTwoLayer: friendCount must be ≥ ${TWO_LAYER_THRESHOLD}, got ${friendCount}.`,
        );
    }
    if (friendCount > 255) {
        throw new Error(`splitTwoLayer: friendCount must be ≤ 255, got ${friendCount}.`);
    }

    assertRecoveryCsprngAvailable();

    // --- layer 1: XOR ---
    const hubShare = new Uint8Array(SEED_LENGTH);
    crypto.getRandomValues(hubShare);

    const B = xorBytes(seed, hubShare);

    // --- layer 2: Shamir on B ---
    const friendShares = await splitBytes(B, friendCount, TWO_LAYER_THRESHOLD);

    // --- integrity checksum ---
    const checksum = seedChecksum(seed);

    return { hubShare, friendShares, seedChecksum: checksum };
}

/**
 * Reconstructs a 32-byte Ed25519 seed from a hub share and friend shares.
 *
 * @param hubShare       the `A` returned by {@link splitTwoLayer}
 * @param friendShares   at least {@link TWO_LAYER_THRESHOLD} shares from the same split
 * @param checksum       the `seedChecksum` from the same split — used to verify integrity
 * @returns              the original 32-byte seed
 * @throws {TwoLayerCombineError} if the reconstructed seed does not match the checksum
 */
export async function combineTwoLayer(
    hubShare: Uint8Array,
    friendShares: Uint8Array[],
    checksum: Uint8Array,
): Promise<Uint8Array> {
    // --- validation ---
    if (!(hubShare instanceof Uint8Array) || hubShare.length !== SEED_LENGTH) {
        throw new TwoLayerCombineError(
            `combineTwoLayer: hubShare must be exactly ${SEED_LENGTH} bytes, ` +
            `got ${hubShare instanceof Uint8Array ? hubShare.length : typeof hubShare}.`,
        );
    }
    if (!Array.isArray(friendShares) || friendShares.length < TWO_LAYER_THRESHOLD) {
        throw new TwoLayerCombineError(
            `combineTwoLayer: need at least ${TWO_LAYER_THRESHOLD} friend shares, ` +
            `got ${friendShares?.length ?? 0}.`,
        );
    }
    if (!(checksum instanceof Uint8Array) || checksum.length !== SEED_CHECKSUM_LENGTH) {
        throw new TwoLayerCombineError(
            `combineTwoLayer: checksum must be exactly ${SEED_CHECKSUM_LENGTH} bytes.`,
        );
    }

    // --- layer 2: Shamir-combine friend shares → B ---
    let B: Uint8Array;
    try {
        B = await combineBytes(friendShares);
    } catch (e) {
        throw new TwoLayerCombineError(
            `Friend shares could not be combined: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    if (B.length !== SEED_LENGTH) {
        throw new TwoLayerCombineError(
            `Reconstructed B has incorrect length: expected ${SEED_LENGTH}, got ${B.length}.`,
        );
    }

    // --- layer 1: XOR → seed ---
    const seed = xorBytes(hubShare, B);

    // --- integrity check (constant-time comparison) ---
    const actual = seedChecksum(seed);
    let diff = 0;
    for (let i = 0; i < SEED_CHECKSUM_LENGTH; i++) {
        diff |= actual[i] ^ checksum[i];
    }
    if (diff !== 0) {
        throw new TwoLayerCombineError(
            'Reconstructed seed does not match its checksum. This usually means the ' +
            'hub share and friend shares come from different splits, or there are too ' +
            'few friend shares. The result was NOT returned — without this check it ' +
            'would have been a valid but wrong Ed25519 seed.',
        );
    }

    return seed;
}

// ---------------------------------------------------------------------------
// SSO-tier variant — hub + whole B (no Shamir)
// ---------------------------------------------------------------------------

/**
 * Result of {@link splitHubAndWhole}.
 *
 * Identical in structure to {@link TwoLayerSplitResult} except there is a
 * single `otherHalf` instead of Shamir friend shares. Used when the member
 * has signed in with Google or Apple and the whole of `B` is sealed to the
 * provider's `sub` claim.
 */
export interface HubAndWholeSplitResult {
    hubShare: Uint8Array;
    /** `B = seed ⊕ A`, un-split. The caller seals this to the SSO provider. */
    otherHalf: Uint8Array;
    seedChecksum: Uint8Array;
}

/**
 * Splits a 32-byte Ed25519 seed into a hub share and a single other half.
 *
 * This is the SSO-tier variant of {@link splitTwoLayer}: same `A ⊕ B` XOR
 * layer, but `B` is kept whole rather than Shamir-split, because the SSO
 * provider seals the single piece. Two keepers (hub + sign-in), no friends
 * required.
 *
 * @param seed  exactly 32 bytes — the raw Ed25519 private key seed
 * @returns     `{ hubShare, otherHalf, seedChecksum }`
 */
export async function splitHubAndWhole(
    seed: Uint8Array,
): Promise<HubAndWholeSplitResult> {
    if (!(seed instanceof Uint8Array) || seed.length !== SEED_LENGTH) {
        throw new Error(
            `splitHubAndWhole: seed must be exactly ${SEED_LENGTH} bytes, ` +
            `got ${seed instanceof Uint8Array ? seed.length : typeof seed}.`,
        );
    }

    assertRecoveryCsprngAvailable();

    // --- layer 1: XOR ---
    const hubShare = new Uint8Array(SEED_LENGTH);
    crypto.getRandomValues(hubShare);

    const otherHalf = xorBytes(seed, hubShare);

    // --- integrity checksum ---
    const checksum = seedChecksum(seed);

    return { hubShare, otherHalf, seedChecksum: checksum };
}

/**
 * Reconstructs a 32-byte Ed25519 seed from a hub share and its other half.
 *
 * This is the SSO-tier variant of {@link combineTwoLayer}: `seed = A ⊕ B`
 * where `B` is the whole un-split other half.
 *
 * @param hubShare   the `A` returned by {@link splitHubAndWhole}
 * @param otherHalf  the `B` from the same split
 * @param checksum   the `seedChecksum` from the same split — used to verify integrity
 * @returns          the original 32-byte seed
 * @throws {TwoLayerCombineError} if the reconstructed seed does not match the checksum
 */
export function combineHubAndWhole(
    hubShare: Uint8Array,
    otherHalf: Uint8Array,
    checksum: Uint8Array,
): Uint8Array {
    if (!(hubShare instanceof Uint8Array) || hubShare.length !== SEED_LENGTH) {
        throw new TwoLayerCombineError(
            `combineHubAndWhole: hubShare must be exactly ${SEED_LENGTH} bytes, ` +
            `got ${hubShare instanceof Uint8Array ? hubShare.length : typeof hubShare}.`,
        );
    }
    if (!(otherHalf instanceof Uint8Array) || otherHalf.length !== SEED_LENGTH) {
        throw new TwoLayerCombineError(
            `combineHubAndWhole: otherHalf must be exactly ${SEED_LENGTH} bytes, ` +
            `got ${otherHalf instanceof Uint8Array ? otherHalf.length : typeof otherHalf}.`,
        );
    }
    if (!(checksum instanceof Uint8Array) || checksum.length !== SEED_CHECKSUM_LENGTH) {
        throw new TwoLayerCombineError(
            `combineHubAndWhole: checksum must be exactly ${SEED_CHECKSUM_LENGTH} bytes.`,
        );
    }

    // --- layer 1: XOR → seed ---
    const seed = xorBytes(hubShare, otherHalf);

    // --- integrity check (constant-time comparison) ---
    const actual = seedChecksum(seed);
    let diff = 0;
    for (let i = 0; i < SEED_CHECKSUM_LENGTH; i++) {
        diff |= actual[i] ^ checksum[i];
    }
    if (diff !== 0) {
        throw new TwoLayerCombineError(
            'Reconstructed seed does not match its checksum. This usually means the ' +
            'hub share and other half come from different splits. The result was NOT ' +
            'returned — without this check it would have been a valid but wrong ' +
            'Ed25519 seed.',
        );
    }

    return seed;
}
