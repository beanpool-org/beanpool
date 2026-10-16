/**
 * A new account's 12 words are standard BIP-39 (verify-audit-key-paths KEY-02): 128 bits of entropy, then the first 4 bits
 * of SHA-256 of them as the checksum. Both apps make them here, so the same entropy gives the same words on the phone and
 * the web, and an outside BIP-39 checker accepts every phrase BeanPool makes.
 */
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { BIP39_ENGLISH, RECOVERY_ENTROPY_LEN, isWellFormedRecoveryPhrase, packRecoveryWords, recoveryWordsFromEntropy } from '../index.js';

/** The BIP-39 reference vectors for 128-bit entropy (trezor/python-mnemonic vectors.json, English). Public test data. */
const VECTORS: [string, string][] = [
    ['00000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
    ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
    ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
    ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
    ['9e885d952ad362caeb4efe34a8e91bd2', 'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic'],
    ['c0ba5a8e914111210f2bd131f3d5e08d', 'scheme spot photo card baby mountain device kick cradle pact join borrow'],
    ['f30f8c1da665478f49b001d94c5fc452', 'vessel ladder alter error federal sibling chat ability sun glass valve picture'],
];

/** The standard check an outside BIP-39 tool makes: the last 4 of the 132 bits are SHA-256(entropy)[0] >>> 4. */
function standardChecksumHolds(words: string[]): boolean {
    const packed = packRecoveryWords(words);
    return (packed[16] >>> 4) === (sha256(packed.slice(0, 16))[0] >>> 4);
}

describe('recoveryWordsFromEntropy', () => {
    it.each(VECTORS)('makes the BIP-39 reference words for %s', (hex, phrase) => {
        expect(recoveryWordsFromEntropy(hexToBytes(hex)).join(' ')).toBe(phrase);
    });

    it('every phrase it makes is well formed and passes the standard checksum, and keeps all 128 bits in order', () => {
        for (let i = 0; i < 500; i++) {
            const entropy = crypto.getRandomValues(new Uint8Array(RECOVERY_ENTROPY_LEN));
            const words = recoveryWordsFromEntropy(entropy);
            expect(words).toHaveLength(12);
            expect(words.every((w) => BIP39_ENGLISH.includes(w))).toBe(true);
            expect(isWellFormedRecoveryPhrase(words)).toBe(true);
            expect(standardChecksumHolds(words)).toBe(true);
            expect(packRecoveryWords(words).slice(0, 16)).toEqual(entropy);
        }
    });

    it('refuses entropy that is not 16 bytes', () => {
        expect(() => recoveryWordsFromEntropy(new Uint8Array(15))).toThrow();
        expect(() => recoveryWordsFromEntropy(new Uint8Array(32))).toThrow();
    });
});
