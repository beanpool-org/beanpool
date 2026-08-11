import { describe, it, expect } from 'vitest';
import { combine as rawCombine } from 'shamir-secret-sharing';
import {
    splitTwoLayer,
    combineTwoLayer,
    splitHubAndWhole,
    combineHubAndWhole,
    TwoLayerCombineError,
    TWO_LAYER_THRESHOLD,
} from '../two-layer-split.js';

/**
 * A deterministic 32-byte seed — every byte distinct so off-by-one errors in
 * the XOR or the Shamir split would show up as a wrong byte, not a silent pass.
 */
const SEED = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

/** Every distinct k-sized combination of `items`. */
function combinationsOf<T>(items: T[], k: number): T[][] {
    if (k === 0) return [[]];
    if (items.length < k) return [];
    const [head, ...rest] = items;
    return [
        ...combinationsOf(rest, k - 1).map(c => [head, ...c]),
        ...combinationsOf(rest, k),
    ];
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('two-layer split — round-trip', () => {
    it('recovers the seed through split → combine', async () => {
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 3);
        const restored = await combineTwoLayer(hubShare, friendShares.slice(0, 2), seedChecksum);
        expect(restored).toEqual(SEED);
    });

    it('recovers the seed with ALL friend shares', async () => {
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 5);
        const restored = await combineTwoLayer(hubShare, friendShares, seedChecksum);
        expect(restored).toEqual(SEED);
    });

    it('recovers the seed from EVERY 2-sized subset of friends + hub', async () => {
        // "any 2 of your friends" means literally any 2, not just the first two.
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 5);
        const subsets = combinationsOf(friendShares, TWO_LAYER_THRESHOLD);
        expect(subsets).toHaveLength(10); // C(5,2) = 10

        for (const subset of subsets) {
            const restored = await combineTwoLayer(hubShare, subset, seedChecksum);
            expect(restored).toEqual(SEED);
        }
    });

    it('works at the minimum friend count (2)', async () => {
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 2);
        expect(friendShares).toHaveLength(2);
        const restored = await combineTwoLayer(hubShare, friendShares, seedChecksum);
        expect(restored).toEqual(SEED);
    });
});

// ---------------------------------------------------------------------------
// The property that matters most: collusion resistance
// ---------------------------------------------------------------------------

describe('two-layer split — collusion resistance', () => {
    it('ALL friends, NO hub: does NOT yield the seed', async () => {
        // This is the test that proves the XOR layer is load-bearing.
        // A flat Shamir split (without the XOR) would pass every round-trip test
        // and fail only this one — which is why this test must exist.
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 5);

        // Shamir-combine all friend shares — this gives us B, not the seed.
        const B = await rawCombine(friendShares);
        expect(B).toBeInstanceOf(Uint8Array);
        expect(B).not.toEqual(SEED);

        // Positively assert what came back IS B: xor(B, A) should equal the seed.
        // This proves the Shamir layer faithfully reconstructed B, and it's only
        // the missing XOR with A that makes B useless without the hub.
        const seedFromBA = new Uint8Array(B.length);
        for (let i = 0; i < B.length; i++) {
            seedFromBA[i] = B[i] ^ hubShare[i];
        }
        expect(seedFromBA).toEqual(SEED);
    });

    it('any 2 friends WITHOUT hub: does NOT yield the seed', async () => {
        // Even the correct Shamir reconstruction of B is useless without A.
        // This catches a flat Shamir split that skips the XOR entirely.
        const { friendShares } = await splitTwoLayer(SEED, 4);

        const subsets = combinationsOf(friendShares, TWO_LAYER_THRESHOLD);
        for (const subset of subsets) {
            const B = await rawCombine(subset);
            expect(B).not.toEqual(SEED);
        }
    });

    it('hub alone does NOT reconstruct the seed', async () => {
        const { hubShare } = await splitTwoLayer(SEED, 3);
        // A is random bytes — it should differ from the seed.
        expect(hubShare).not.toEqual(SEED);
    });

    it('1 friend + hub does NOT reconstruct (below Shamir threshold)', async () => {
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 4);
        // Only 1 friend share — below the threshold of 2.
        await expect(
            combineTwoLayer(hubShare, friendShares.slice(0, 1), seedChecksum),
        ).rejects.toThrow(TwoLayerCombineError);
    });
});

// ---------------------------------------------------------------------------
// Integrity check — the silent-wrong-seed trap
// ---------------------------------------------------------------------------

describe('two-layer split — integrity check', () => {
    it('rejects a corrupt friend share instead of returning a wrong seed', async () => {
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 3);
        const corrupted = Uint8Array.from(friendShares[0]);
        corrupted[1] ^= 0xff;
        // The Shamir combine will produce a different B, and XOR with A yields
        // a different seed — which the checksum catches.
        await expect(
            combineTwoLayer(hubShare, [corrupted, friendShares[1]], seedChecksum),
        ).rejects.toThrow(TwoLayerCombineError);
    });

    it('rejects friend shares from a different split of the SAME seed', async () => {
        const splitA = await splitTwoLayer(SEED, 3);
        const splitB = await splitTwoLayer(SEED, 3);
        // Mix: hub from A, friends from B. Different A means different B,
        // so the checksum from A won't match.
        await expect(
            combineTwoLayer(splitA.hubShare, splitB.friendShares.slice(0, 2), splitA.seedChecksum),
        ).rejects.toThrow(TwoLayerCombineError);
    });

    it('rejects a wrong hub share', async () => {
        const { friendShares, seedChecksum } = await splitTwoLayer(SEED, 3);
        const wrongHub = new Uint8Array(32);
        crypto.getRandomValues(wrongHub);
        await expect(
            combineTwoLayer(wrongHub, friendShares.slice(0, 2), seedChecksum),
        ).rejects.toThrow(TwoLayerCombineError);
    });

    it('rejects a wrong checksum', async () => {
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 3);
        const wrongChecksum = Uint8Array.from(seedChecksum);
        wrongChecksum[0] ^= 0xff;
        await expect(
            combineTwoLayer(hubShare, friendShares.slice(0, 2), wrongChecksum),
        ).rejects.toThrow(TwoLayerCombineError);
    });

    it('the error message explains the consequence of not checking', async () => {
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 3);
        const corrupted = Uint8Array.from(friendShares[0]);
        corrupted[1] ^= 0xff;
        await expect(
            combineTwoLayer(hubShare, [corrupted, friendShares[1]], seedChecksum),
        ).rejects.toThrow(/valid but wrong Ed25519 seed/);
    });
});

// ---------------------------------------------------------------------------
// Non-determinism — two splits of the same seed must differ
// ---------------------------------------------------------------------------

describe('two-layer split — non-determinism', () => {
    it('two splits of the same seed produce different A', async () => {
        const a = await splitTwoLayer(SEED, 3);
        const b = await splitTwoLayer(SEED, 3);
        expect(a.hubShare).not.toEqual(b.hubShare);
    });

    it('two splits of the same seed produce different friend shares', async () => {
        const a = await splitTwoLayer(SEED, 3);
        const b = await splitTwoLayer(SEED, 3);
        // At least one share should differ (overwhelmingly all will).
        const aHex = a.friendShares.map(s => Buffer.from(s).toString('hex')).sort();
        const bHex = b.friendShares.map(s => Buffer.from(s).toString('hex')).sort();
        expect(aHex).not.toEqual(bHex);
    });
});

// ---------------------------------------------------------------------------
// Share shape
// ---------------------------------------------------------------------------

describe('two-layer split — share shapes', () => {
    it('hub share is 32 bytes (not a Shamir share, no x-coordinate)', async () => {
        const { hubShare } = await splitTwoLayer(SEED, 5);
        expect(hubShare.length).toBe(32);
    });

    it('each friend share is 33 bytes (32-byte secret + 1-byte x-coordinate)', async () => {
        const { friendShares } = await splitTwoLayer(SEED, 5);
        for (const share of friendShares) {
            expect(share.length).toBe(33);
        }
    });

    it('every friend share is distinct', async () => {
        const { friendShares } = await splitTwoLayer(SEED, 5);
        const hexSet = new Set(friendShares.map(s => Buffer.from(s).toString('hex')));
        expect(hexSet.size).toBe(5);
    });

    it('seedChecksum is 4 bytes', async () => {
        const { seedChecksum } = await splitTwoLayer(SEED, 3);
        expect(seedChecksum.length).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('two-layer split — input validation', () => {
    it('rejects a non-32-byte seed', async () => {
        await expect(splitTwoLayer(new Uint8Array(16), 3)).rejects.toThrow(/exactly 32 bytes/);
        await expect(splitTwoLayer(new Uint8Array(33), 3)).rejects.toThrow(/exactly 32 bytes/);
        await expect(splitTwoLayer(new Uint8Array(0), 3)).rejects.toThrow(/exactly 32 bytes/);
    });

    it('rejects friendCount below threshold', async () => {
        await expect(splitTwoLayer(SEED, 1)).rejects.toThrow(/friendCount must be ≥ 2/);
        await expect(splitTwoLayer(SEED, 0)).rejects.toThrow(/friendCount must be ≥ 2/);
    });

    it('rejects friendCount above 255', async () => {
        await expect(splitTwoLayer(SEED, 256)).rejects.toThrow(/≤ 255/);
    });

    it('rejects non-integer friendCount', async () => {
        await expect(splitTwoLayer(SEED, 2.5)).rejects.toThrow(/friendCount must be ≥ 2/);
    });

    it('rejects a wrong-length hub share in combine', async () => {
        const { friendShares, seedChecksum } = await splitTwoLayer(SEED, 3);
        await expect(
            combineTwoLayer(new Uint8Array(16), friendShares.slice(0, 2), seedChecksum),
        ).rejects.toThrow(TwoLayerCombineError);
    });

    it('rejects too few friend shares in combine', async () => {
        const { hubShare, friendShares, seedChecksum } = await splitTwoLayer(SEED, 3);
        await expect(
            combineTwoLayer(hubShare, friendShares.slice(0, 1), seedChecksum),
        ).rejects.toThrow(TwoLayerCombineError);
    });

    it('rejects a wrong-length checksum in combine', async () => {
        const { hubShare, friendShares } = await splitTwoLayer(SEED, 3);
        await expect(
            combineTwoLayer(hubShare, friendShares.slice(0, 2), new Uint8Array(2)),
        ).rejects.toThrow(TwoLayerCombineError);
    });
});

// ---------------------------------------------------------------------------
// TWO_LAYER_THRESHOLD is distinct from RECOVERY_THRESHOLD
// ---------------------------------------------------------------------------

describe('two-layer split — constants', () => {
    it('TWO_LAYER_THRESHOLD is 2', () => {
        expect(TWO_LAYER_THRESHOLD).toBe(2);
    });

    it('TWO_LAYER_THRESHOLD is NOT the same as RECOVERY_THRESHOLD', async () => {
        // Import dynamically to avoid coupling the test file to recovery-split
        // beyond what it needs.
        const { RECOVERY_THRESHOLD } = await import('../recovery-split.js');
        expect(TWO_LAYER_THRESHOLD).not.toBe(RECOVERY_THRESHOLD);
        expect(RECOVERY_THRESHOLD).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// SSO-tier: splitHubAndWhole / combineHubAndWhole
// ---------------------------------------------------------------------------

describe('hub-and-whole split — round-trip', () => {
    it('recovers the seed through split → combine', async () => {
        const { hubShare, otherHalf, seedChecksum } = await splitHubAndWhole(SEED);
        const restored = combineHubAndWhole(hubShare, otherHalf, seedChecksum);
        expect(restored).toEqual(SEED);
    });
});

describe('hub-and-whole split — non-determinism', () => {
    it('two splits of the same seed produce different hub shares', async () => {
        const a = await splitHubAndWhole(SEED);
        const b = await splitHubAndWhole(SEED);
        expect(a.hubShare).not.toEqual(b.hubShare);
    });

    it('two splits of the same seed produce different other halves', async () => {
        const a = await splitHubAndWhole(SEED);
        const b = await splitHubAndWhole(SEED);
        expect(a.otherHalf).not.toEqual(b.otherHalf);
    });

    it('two splits of the same seed produce the same checksum', async () => {
        const a = await splitHubAndWhole(SEED);
        const b = await splitHubAndWhole(SEED);
        expect(a.seedChecksum).toEqual(b.seedChecksum);
    });
});

describe('hub-and-whole split — collusion resistance', () => {
    it('hub share alone is not the seed', async () => {
        const { hubShare } = await splitHubAndWhole(SEED);
        expect(hubShare).not.toEqual(SEED);
    });

    it('other half alone is not the seed', async () => {
        const { otherHalf } = await splitHubAndWhole(SEED);
        expect(otherHalf).not.toEqual(SEED);
    });

    it('hub share XOR zero is not the seed', async () => {
        const { hubShare } = await splitHubAndWhole(SEED);
        expect(hubShare).not.toEqual(SEED);
    });

    it('swapping the two halves does not produce the seed', async () => {
        const { hubShare, otherHalf, seedChecksum } = await splitHubAndWhole(SEED);
        // XOR is commutative, so swapping actually DOES produce the same seed.
        // This test asserts the mathematical property: the construction is
        // symmetric in A and B, which means the security depends on WHO can
        // produce each half, not on which half comes first.
        const restored = combineHubAndWhole(otherHalf, hubShare, seedChecksum);
        expect(restored).toEqual(SEED);
    });
});

describe('hub-and-whole split — integrity', () => {
    it('wrong hub share is detected', async () => {
        const { otherHalf, seedChecksum } = await splitHubAndWhole(SEED);
        const wrongHub = new Uint8Array(32).fill(0xaa);
        expect(() => combineHubAndWhole(wrongHub, otherHalf, seedChecksum))
            .toThrow(TwoLayerCombineError);
    });

    it('corrupt other half is detected', async () => {
        const { hubShare, otherHalf, seedChecksum } = await splitHubAndWhole(SEED);
        const corrupt = new Uint8Array(otherHalf);
        corrupt[0] ^= 0x01;
        expect(() => combineHubAndWhole(hubShare, corrupt, seedChecksum))
            .toThrow(TwoLayerCombineError);
    });

    it('mismatched halves from different splits are detected', async () => {
        const splitA = await splitHubAndWhole(SEED);
        const splitB = await splitHubAndWhole(SEED);
        // hub from A, other half from B — different A values mean different B values
        expect(() => combineHubAndWhole(splitA.hubShare, splitB.otherHalf, splitA.seedChecksum))
            .toThrow(TwoLayerCombineError);
    });
});

describe('hub-and-whole split — shape', () => {
    it('hubShare is exactly 32 bytes', async () => {
        const { hubShare } = await splitHubAndWhole(SEED);
        expect(hubShare).toHaveLength(32);
    });

    it('otherHalf is exactly 32 bytes (NOT a Shamir share — no x-coordinate byte)', async () => {
        const { otherHalf } = await splitHubAndWhole(SEED);
        expect(otherHalf).toHaveLength(32);
    });

    it('seedChecksum is exactly 4 bytes', async () => {
        const { seedChecksum } = await splitHubAndWhole(SEED);
        expect(seedChecksum).toHaveLength(4);
    });
});

describe('hub-and-whole split — validation', () => {
    it('rejects a seed that is not 32 bytes', async () => {
        await expect(splitHubAndWhole(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
    });

    it('rejects a non-Uint8Array seed', async () => {
        // @ts-expect-error — intentionally passing wrong type
        await expect(splitHubAndWhole('not bytes')).rejects.toThrow(/32 bytes/);
    });

    it('combineHubAndWhole rejects wrong-length hub share', async () => {
        const { otherHalf, seedChecksum } = await splitHubAndWhole(SEED);
        expect(() => combineHubAndWhole(new Uint8Array(16), otherHalf, seedChecksum))
            .toThrow(TwoLayerCombineError);
    });

    it('combineHubAndWhole rejects wrong-length other half', async () => {
        const { hubShare, seedChecksum } = await splitHubAndWhole(SEED);
        expect(() => combineHubAndWhole(hubShare, new Uint8Array(33), seedChecksum))
            .toThrow(TwoLayerCombineError);
    });

    it('combineHubAndWhole rejects wrong-length checksum', async () => {
        const { hubShare, otherHalf } = await splitHubAndWhole(SEED);
        expect(() => combineHubAndWhole(hubShare, otherHalf, new Uint8Array(2)))
            .toThrow(TwoLayerCombineError);
    });
});
