import { describe, it, expect } from 'vitest';
import CryptoJS from 'crypto-js';
import { combine as rawCombine, split as rawSplit } from 'shamir-secret-sharing';
import {
    RECOVERY_CHECKSUM_LENGTH,
    RECOVERY_ENVELOPE_VERSION,
    RECOVERY_THRESHOLD,
    RecoveryCombineError,
    assertRecoveryCsprngAvailable,
    combineRecoveryPhrase,
    normaliseRecoveryPhrase,
    splitRecoveryPhrase,
} from '../recovery-split.js';

/** A real BIP-39 English phrase — the shape the split actually sees in production. */
const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const OTHER_PHRASE = 'zoo zone zero youth your young yellow year wrong writer worth world';

/**
 * The account derivation from `apps/native/utils/crypto.ts` `mnemonicToKeypair`: lowercase
 * each word, join with single spaces, then double SHA-256 to a 32-byte Ed25519 private key.
 * Replicated here because "the phrase came back" is only interesting insofar as it means
 * "the same account came back".
 */
function deriveKeyHex(phrase: string): string {
    const canonical = phrase.split(/\s+/).map(w => w.toLowerCase().trim()).join(' ');
    return CryptoJS.SHA256(CryptoJS.SHA256(canonical)).toString();
}

/** Every distinct k-sized combination of `items`, so "any k" can be tested as literally any. */
function combinationsOf<T>(items: T[], k: number): T[][] {
    if (k === 0) return [[]];
    if (items.length < k) return [];
    const [head, ...rest] = items;
    return [
        ...combinationsOf(rest, k - 1).map(c => [head, ...c]),
        ...combinationsOf(rest, k),
    ];
}

describe('recovery phrase split', () => {
    it('round-trips through the minimum number of keepers', async () => {
        const shares = await splitRecoveryPhrase(PHRASE, RECOVERY_THRESHOLD);
        expect(shares).toHaveLength(RECOVERY_THRESHOLD);
        expect(await combineRecoveryPhrase(shares)).toBe(PHRASE);
    });

    it('rebuilds the same phrase from ANY threshold-sized subset', async () => {
        // The keeper model promises "any 3 of your keepers can bring you back", so every
        // subset has to work — not just the first three, which is what a single happy-path
        // test would actually be checking.
        const shares = await splitRecoveryPhrase(PHRASE, 5);
        const subsets = combinationsOf(shares, RECOVERY_THRESHOLD);
        expect(subsets).toHaveLength(10); // C(5,3)
        for (const subset of subsets) {
            expect(await combineRecoveryPhrase(subset)).toBe(PHRASE);
        }
    });

    it('does not care what order the fragments arrive in', async () => {
        // Pieces come back from keepers as they respond, not in the order they were made.
        const shares = await splitRecoveryPhrase(PHRASE, 4);
        const [a, b, c] = shares;
        expect(await combineRecoveryPhrase([c, a, b])).toBe(PHRASE);
        expect(await combineRecoveryPhrase([b, c, a])).toBe(PHRASE);
    });

    it('restores an identity that derives the identical key', async () => {
        // The property that actually matters. A phrase that differs by a byte still derives
        // *some* valid keypair, so byte-equality of the phrase is the only thing standing
        // between a recovering user and a stranger's empty account.
        const shares = await splitRecoveryPhrase(PHRASE, 4);
        const restored = await combineRecoveryPhrase(shares.slice(0, RECOVERY_THRESHOLD));
        expect(deriveKeyHex(restored)).toBe(deriveKeyHex(PHRASE));
    });

    it('produces fragments one byte longer than the envelope', async () => {
        // Guards the storage estimate for `recovery_shares`: each fragment is the envelope
        // plus a one-byte x-coordinate.
        const shares = await splitRecoveryPhrase(PHRASE, 3);
        const envelopeLength = 1 + RECOVERY_CHECKSUM_LENGTH + Buffer.byteLength(PHRASE, 'utf8');
        for (const share of shares) {
            expect(share.length).toBe(envelopeLength + 1);
        }
    });

    it('gives every keeper a different fragment', async () => {
        const shares = await splitRecoveryPhrase(PHRASE, 5);
        const distinct = new Set(shares.map(s => Buffer.from(s).toString('hex')));
        expect(distinct.size).toBe(5);
    });
});

describe('too few or wrong fragments', () => {
    it('THROWS rather than returning a plausible wrong phrase', async () => {
        // The whole reason the envelope exists. Demonstrated in two halves so the value the
        // wrapper adds is explicit rather than assumed.
        const shares = await splitRecoveryPhrase(PHRASE, 5);
        const tooFew = shares.slice(0, RECOVERY_THRESHOLD - 1);

        // First: raw Shamir is perfectly happy to answer, and answers wrongly.
        const rawResult = await rawCombine(tooFew);
        expect(rawResult).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(rawResult).toString('utf8')).not.toContain('abandon');

        // Second: ours refuses.
        await expect(combineRecoveryPhrase(tooFew)).rejects.toThrow(RecoveryCombineError);
    });

    it('rejects a single fragment', async () => {
        const shares = await splitRecoveryPhrase(PHRASE, 4);
        await expect(combineRecoveryPhrase(shares.slice(0, 1))).rejects.toThrow(RecoveryCombineError);
    });

    it('rejects fragments from two different splits of the SAME phrase', async () => {
        // A re-split after a keeper changes produces a new generation. Old and new fragments
        // are individually valid and describe the same secret, which is exactly why mixing
        // them has to fail loudly instead of interpolating nonsense.
        const genA = await splitRecoveryPhrase(PHRASE, 4);
        const genB = await splitRecoveryPhrase(PHRASE, 4);
        const mixed = [genA[0], genA[1], genB[2]];
        await expect(combineRecoveryPhrase(mixed)).rejects.toThrow(RecoveryCombineError);
    });

    it('rejects fragments from splits of different phrases', async () => {
        const mine = await splitRecoveryPhrase(PHRASE, 4);
        const theirs = await splitRecoveryPhrase(OTHER_PHRASE, 4);
        await expect(combineRecoveryPhrase([mine[0], mine[1], theirs[0]])).rejects.toThrow(RecoveryCombineError);
    });

    it('rejects a corrupted fragment', async () => {
        const shares = await splitRecoveryPhrase(PHRASE, 3);
        const corrupted = Uint8Array.from(shares[1]);
        corrupted[0] ^= 0xff;
        await expect(combineRecoveryPhrase([shares[0], corrupted, shares[2]])).rejects.toThrow(RecoveryCombineError);
    });

    it('reports a duplicate fragment as a combine error, not a library error', async () => {
        const shares = await splitRecoveryPhrase(PHRASE, 4);
        await expect(combineRecoveryPhrase([shares[0], shares[0], shares[1]]))
            .rejects.toThrow(RecoveryCombineError);
    });

    it('rejects an unrecognised envelope version', async () => {
        // Stands in for a future format change meeting an old client.
        const envelope = new Uint8Array(1 + RECOVERY_CHECKSUM_LENGTH + 4);
        envelope[0] = RECOVERY_ENVELOPE_VERSION + 1;
        const shares = await rawSplit(envelope, 3, RECOVERY_THRESHOLD);
        await expect(combineRecoveryPhrase(shares)).rejects.toThrow(/envelope version/i);
    });
});

describe('input validation', () => {
    it('refuses to split across fewer keepers than the threshold', async () => {
        // Would produce fragments that can never be recombined — a total loss that would
        // only surface at recovery.
        await expect(splitRecoveryPhrase(PHRASE, RECOVERY_THRESHOLD - 1)).rejects.toThrow(/at least 3 keepers/);
        await expect(splitRecoveryPhrase(PHRASE, 0)).rejects.toThrow(/at least 3 keepers/);
    });

    it('refuses a non-integer keeper count', async () => {
        await expect(splitRecoveryPhrase(PHRASE, 3.5)).rejects.toThrow(/at least 3 keepers/);
    });

    it('refuses more than 255 keepers', async () => {
        await expect(splitRecoveryPhrase(PHRASE, 256)).rejects.toThrow(/at most 255/);
    });

    it('refuses an empty phrase', async () => {
        await expect(splitRecoveryPhrase('', 3)).rejects.toThrow(/empty/);
        await expect(splitRecoveryPhrase('   \n ', 3)).rejects.toThrow(/empty/);
    });
});

describe('phrase normalisation', () => {
    it('treats ragged whitespace as the same secret', async () => {
        const messy = `  abandon  ability able\tabout above absent absorb abstract absurd abuse access accident\n`;
        expect(normaliseRecoveryPhrase(messy)).toBe(PHRASE);

        const shares = await splitRecoveryPhrase(messy, 3);
        expect(await combineRecoveryPhrase(shares)).toBe(PHRASE);
    });

    it('leaves case alone, because the derivation already handles it', async () => {
        // Documented deliberate choice: one normalisation rule per concern. A phrase that
        // differs only in case derives the identical key, so the split needn't care.
        const shouty = PHRASE.toUpperCase();
        const shares = await splitRecoveryPhrase(shouty, 3);
        const restored = await combineRecoveryPhrase(shares);
        expect(restored).toBe(shouty);
        expect(deriveKeyHex(restored)).toBe(deriveKeyHex(PHRASE));
    });

    it('round-trips a non-ASCII phrase byte-for-byte', async () => {
        // The English wordlist is ASCII, but the envelope is UTF-8 and a future localised
        // wordlist must not silently mangle. Catches a UTF-16/UTF-8 slip in the encoding.
        const accented = 'café niño über 日本語 emoji 🫘 mixed with plain words here now';
        const shares = await splitRecoveryPhrase(accented, 3);
        expect(await combineRecoveryPhrase(shares)).toBe(accented);
    });
});

describe('CSPRNG preflight', () => {
    it('passes when getRandomValues is present', () => {
        expect(() => assertRecoveryCsprngAvailable()).not.toThrow();
    });

    it('names the fix when getRandomValues is missing', async () => {
        // The Hermes trap: the polyfill is installed as an import side effect, so a split
        // running before it loads would otherwise throw from inside a dependency.
        const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
        try {
            expect(() => assertRecoveryCsprngAvailable()).toThrow(/expo-crypto polyfill/);
            await expect(splitRecoveryPhrase(PHRASE, 3)).rejects.toThrow(/expo-crypto polyfill/);
        } finally {
            if (original) Object.defineProperty(globalThis, 'crypto', original);
        }
    });
});
