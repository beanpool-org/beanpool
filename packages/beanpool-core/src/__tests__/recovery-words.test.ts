import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';
import {
    BIP39_ENGLISH,
    PACKED_RECOVERY_WORDS_LEN,
    isWellFormedRecoveryPhrase,
    normaliseRecoveryWords,
    packRecoveryWords,
    recoveryWordsMatchPublicKey,
    recoveryWordsMatchSeed,
    unknownRecoveryWords,
    unpackRecoveryWords,
} from '../recovery-words.js';

// Test phrases only: BIP-39's published vectors and words picked by hand. Never a real account's.
/** Valid BIP-39 checksum (the all-zero entropy vector). */
const VALID = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Twelve listed words whose last word is NOT the BIP-39 checksum. Neither app checks it when typed in. */
const BAD_CHECKSUM = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
/** The last word on the list, twelve times: every index bit set. */
const ALL_ONES = Array(12).fill('zoo').join(' ');

/** The apps' own derivation (native utils/crypto.ts mnemonicToKeypair, PWA lib/mnemonic.ts), written out. */
function accountFrom(phrase: string): { seed: Uint8Array; publicKeyHex: string } {
    const seed = sha256(sha256(utf8ToBytes(phrase.toLowerCase().trim().split(/\s+/).join(' '))));
    return { seed, publicKeyHex: bytesToHex(ed25519.getPublicKey(seed)) };
}

describe('the wordlist', () => {
    it('is BIP-39 English, byte for byte (the SHA-256 of the canonical english.txt)', () => {
        expect(BIP39_ENGLISH.length).toBe(2048);
        expect(bytesToHex(sha256(utf8ToBytes(BIP39_ENGLISH.join('\n') + '\n'))))
            .toBe('2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
    });
});

describe('normalising what was typed', () => {
    it('forgives case, spacing, tabs and new lines, and a list of boxes', () => {
        const messy = `  Abandon\tABANDON  abandon\nabandon abandon  abandon abandon abandon abandon abandon abandon About \n`;
        expect(normaliseRecoveryWords(messy)).toEqual(VALID.split(' '));
        expect(normaliseRecoveryWords(VALID.split(' ').map((w) => ` ${w.toUpperCase()} `))).toEqual(VALID.split(' '));
    });

    it('names the words that are not on the list, in the order typed', () => {
        expect(unknownRecoveryWords('abandon abandonn about zooo')).toEqual(['abandonn', 'zooo']);
        expect(unknownRecoveryWords(VALID)).toEqual([]);
    });

    it('is well formed only at exactly 12 listed words', () => {
        expect(isWellFormedRecoveryPhrase(VALID)).toBe(true);
        expect(isWellFormedRecoveryPhrase(BAD_CHECKSUM)).toBe(true);
        expect(isWellFormedRecoveryPhrase(VALID.split(' ').slice(0, 11))).toBe(false);
        expect(isWellFormedRecoveryPhrase(`${VALID} about`)).toBe(false);
        expect(isWellFormedRecoveryPhrase(VALID.replace('about', 'aboot'))).toBe(false);
        expect(isWellFormedRecoveryPhrase('')).toBe(false);
    });
});

describe('packing the words', () => {
    it.each([
        ['a valid checksum', VALID],
        ['a wrong checksum', BAD_CHECKSUM],
        ['every bit set', ALL_ONES],
    ])('round-trips 12 words with %s exactly, in 17 bytes', (_label, phrase) => {
        const packed = packRecoveryWords(phrase);
        expect(packed.length).toBe(PACKED_RECOVERY_WORDS_LEN);
        expect(unpackRecoveryWords(packed)).toEqual(phrase.split(' '));
    });

    it('keeps BIP-39 entropy in the first 16 bytes (the all-zero vector packs to zeros and the checksum bits)', () => {
        const packed = packRecoveryWords(VALID);
        expect(Array.from(packed.subarray(0, 16))).toEqual(Array(16).fill(0));
        // "about" is index 3: the 4 checksum bits 0011, then the 4 spare bits 0000.
        expect(packed[16]).toBe(0x30);
    });

    it('refuses to pack anything but 12 listed words', () => {
        expect(() => packRecoveryWords(VALID.split(' ').slice(0, 11))).toThrow();
        expect(() => packRecoveryWords(VALID.replace('about', 'aboot'))).toThrow();
    });

    it('refuses to unpack a wrong length or set spare bits', () => {
        expect(() => unpackRecoveryWords(new Uint8Array(16))).toThrow();
        expect(() => unpackRecoveryWords(new Uint8Array(18))).toThrow();
        const spare = packRecoveryWords(VALID);
        spare[16] |= 0x01;
        expect(() => unpackRecoveryWords(spare)).toThrow();
    });
});

describe('whose words these are', () => {
    it('matches the account the apps make from the words, forgiving case and spacing', () => {
        const account = accountFrom(BAD_CHECKSUM);
        expect(recoveryWordsMatchPublicKey(BAD_CHECKSUM, account.publicKeyHex)).toBe(true);
        expect(recoveryWordsMatchPublicKey(`  ${BAD_CHECKSUM.toUpperCase().replace(/ /g, '\n')} `, account.publicKeyHex)).toBe(true);
        expect(recoveryWordsMatchPublicKey(BAD_CHECKSUM, account.publicKeyHex.toUpperCase())).toBe(true);
        expect(recoveryWordsMatchPublicKey(BAD_CHECKSUM, ed25519.getPublicKey(account.seed))).toBe(true);
    });

    it('does not match another account, or words in another order', () => {
        const account = accountFrom(BAD_CHECKSUM);
        expect(recoveryWordsMatchPublicKey(VALID, account.publicKeyHex)).toBe(false);
        const swapped = BAD_CHECKSUM.split(' ');
        [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
        expect(recoveryWordsMatchPublicKey(swapped, account.publicKeyHex)).toBe(false);
    });

    it('is false, never a throw, for malformed words or a public key that will not parse', () => {
        const account = accountFrom(VALID);
        expect(recoveryWordsMatchPublicKey(VALID.split(' ').slice(0, 11), account.publicKeyHex)).toBe(false);
        expect(recoveryWordsMatchPublicKey(VALID.replace('about', 'aboot'), account.publicKeyHex)).toBe(false);
        expect(recoveryWordsMatchPublicKey(VALID, 'not hex')).toBe(false);
        expect(recoveryWordsMatchPublicKey(VALID, 'abcd')).toBe(false);
        expect(recoveryWordsMatchPublicKey(VALID, '')).toBe(false);
    });

    it('is false, never a throw, for a public key that is missing (an identity read back without one)', () => {
        // The type says string or bytes; a stored identity is parsed JSON and may not hold one (CR #1150).
        const missing = [null, undefined, {}, 32] as unknown as (string | Uint8Array)[];
        for (const publicKey of missing) {
            expect(() => recoveryWordsMatchPublicKey(VALID, publicKey)).not.toThrow();
            expect(recoveryWordsMatchPublicKey(VALID, publicKey)).toBe(false);
        }
    });

    it('matches a stored private key in either format, by its public key', () => {
        const account = accountFrom(VALID);
        expect(recoveryWordsMatchSeed(VALID, account.seed)).toBe(true);
        expect(recoveryWordsMatchSeed(VALID, toEd25519Pkcs8(account.seed))).toBe(true);
        expect(recoveryWordsMatchSeed(BAD_CHECKSUM, account.seed)).toBe(false);
        expect(recoveryWordsMatchSeed(VALID, new Uint8Array(7))).toBe(false);
    });
});
