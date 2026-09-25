/**
 * The 12 words as data: checking them against an account, and packing them small enough to seal.
 *
 * A member's key is made from the words one way only — `seed = SHA256(SHA256(words joined by single spaces,
 * lowercase))`, the derivation both apps use (native `utils/crypto.ts` `mnemonicToKeypair`, PWA `lib/mnemonic.ts`).
 * Nothing turns a seed back into words. So a phone that got its key some other way (a sign-in restore, before the
 * sign-in copy carried the words) can only get the words back by being given them, and every place that is given
 * words — a sealed sign-in copy being opened, a member typing them in — has to prove they are THIS account's before
 * keeping them. {@link recoveryWordsMatchPublicKey} is that proof, and it compares public keys only: the stored
 * private key may be the native raw seed or the PWA's PKCS8 (identity-key-format-divergence), and a public key has
 * one form.
 *
 * ## Why 17 bytes and not the 16 of BIP-39 entropy
 *
 * The words are BIP-39: 128 random bits and a 4-bit checksum, 11 bits a word. Sixteen bytes of entropy would
 * rebuild the words exactly — for a phrase whose checksum is right. Neither app checks the checksum when a member
 * types words in (`validateMnemonic` checks only that each word is on the list), so an account can have been made
 * from 12 listed words with a wrong last word, and its key is made from THOSE words. Rebuilding the checksum would
 * change the last word and the key it makes. {@link packRecoveryWords} keeps all 132 bits as they are, in 17 bytes,
 * so every 12 listed words come back exactly. It is also a fixed length: a sealed copy of it says nothing about
 * which words are in it, where the words as text would give away how many letters they have.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { BIP39_ENGLISH } from './bip39-english.js';
import { toEd25519Seed } from './ed25519-key.js';
import { splitTypedWords } from './owner-words-check.js';

export { BIP39_ENGLISH };

/** How many words an account has. */
export const RECOVERY_WORD_COUNT = 12;

/** 12 words of 11 bits = 132 bits, in 17 bytes with the last 4 bits zero. */
export const PACKED_RECOVERY_WORDS_LEN = 17;

const BITS_PER_WORD = 11;

let indexOf: Map<string, number> | null = null;
function wordIndex(word: string): number | undefined {
    if (!indexOf) indexOf = new Map(BIP39_ENGLISH.map((w, i) => [w, i]));
    return indexOf.get(word);
}

/**
 * What was typed or stored, as words: any whitespace, any case, surrounding space ignored. The same split the
 * owners' words check uses, so "the words" means one thing everywhere.
 *
 * Not only the typed shapes: stored words are parsed JSON. Anything that is not text or a list of text is no
 * words, never a throw, so every check built on this answers false for it.
 */
export function normaliseRecoveryWords(input: string | readonly string[]): string[] {
    if (typeof input === 'string') return splitTypedWords(input);
    if (Array.isArray(input) && input.every((w) => typeof w === 'string')) return splitTypedWords([...input]);
    return [];
}

/** The words that are not on the list, in the order typed, for a screen that checks as the member types. */
export function unknownRecoveryWords(input: string | readonly string[]): string[] {
    return normaliseRecoveryWords(input).filter((w) => wordIndex(w) === undefined);
}

/** Exactly 12 words, every one on the list. Says nothing about whose they are. */
export function isWellFormedRecoveryPhrase(input: string | readonly string[]): boolean {
    const words = normaliseRecoveryWords(input);
    return words.length === RECOVERY_WORD_COUNT && words.every((w) => wordIndex(w) !== undefined);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/** The account key the words make: the apps' own derivation, over the normalised words. */
function seedFromWords(words: readonly string[]): Uint8Array {
    const phrase = utf8ToBytes(words.join(' '));
    const inner = sha256(phrase);
    const seed = sha256(inner);
    phrase.fill(0);
    inner.fill(0);
    return seed;
}

/**
 * Do these 12 words make the account with this public key?
 *
 * False for anything that is not 12 listed words, for a public key that will not parse, and for words that make
 * another account. Never throws, and returns nothing derived from the words.
 *
 * @param publicKey the account's Ed25519 public key, hex or bytes.
 */
export function recoveryWordsMatchPublicKey(
    input: string | readonly string[],
    publicKey: string | Uint8Array,
): boolean {
    if (!isWellFormedRecoveryPhrase(input)) return false;
    let expected: Uint8Array;
    try {
        expected = typeof publicKey === 'string' ? hexToBytes(publicKey.trim().toLowerCase()) : publicKey;
    } catch {
        return false;
    }
    // Not only the typed shapes: a stored identity is parsed JSON, and one without a public key must not throw.
    if (!expected || expected.length !== 32) return false;
    const seed = seedFromWords(normaliseRecoveryWords(input));
    try {
        return constantTimeEqual(ed25519.getPublicKey(seed), expected);
    } catch {
        return false;
    } finally {
        seed.fill(0);
    }
}

/**
 * Do these 12 words make this private key? Compared by PUBLIC key: the private key may be a raw seed or PKCS8,
 * and is only ever read through {@link toEd25519Seed}. False, never a throw, for a key that will not parse.
 */
export function recoveryWordsMatchSeed(input: string | readonly string[], privateKey: Uint8Array): boolean {
    let publicKey: Uint8Array;
    try {
        publicKey = ed25519.getPublicKey(toEd25519Seed(privateKey));
    } catch {
        return false;
    }
    return recoveryWordsMatchPublicKey(input, publicKey);
}

/**
 * 12 listed words as the 132 bits they stand for, in 17 bytes. Throws on anything else: the caller checks with
 * {@link isWellFormedRecoveryPhrase} first, and packing words that are not on the list would lose them.
 */
export function packRecoveryWords(input: string | readonly string[]): Uint8Array {
    const words = normaliseRecoveryWords(input);
    if (words.length !== RECOVERY_WORD_COUNT) {
        throw new Error(`Recovery words must be ${RECOVERY_WORD_COUNT} words, got ${words.length}.`);
    }
    const out = new Uint8Array(PACKED_RECOVERY_WORDS_LEN);
    let bit = 0;
    for (const word of words) {
        const index = wordIndex(word);
        if (index === undefined) throw new Error('A recovery word is not on the BIP-39 English list.');
        for (let b = BITS_PER_WORD - 1; b >= 0; b--, bit++) {
            if ((index >> b) & 1) out[bit >> 3] |= 0x80 >> (bit & 7);
        }
    }
    return out;
}

/**
 * The 17 bytes back to the 12 words. Throws on the wrong length or on the 4 spare bits set, which no packer
 * writes: a byte string that is not exactly what {@link packRecoveryWords} makes is not trusted to be words.
 */
export function unpackRecoveryWords(packed: Uint8Array): string[] {
    if (!(packed instanceof Uint8Array) || packed.length !== PACKED_RECOVERY_WORDS_LEN) {
        throw new Error(`Packed recovery words must be ${PACKED_RECOVERY_WORDS_LEN} bytes.`);
    }
    if ((packed[PACKED_RECOVERY_WORDS_LEN - 1] & 0x0f) !== 0) {
        throw new Error('Packed recovery words have their spare bits set.');
    }
    const words: string[] = [];
    let bit = 0;
    for (let w = 0; w < RECOVERY_WORD_COUNT; w++) {
        let index = 0;
        for (let b = 0; b < BITS_PER_WORD; b++, bit++) {
            index = (index << 1) | ((packed[bit >> 3] >> (7 - (bit & 7))) & 1);
        }
        words.push(BIP39_ENGLISH[index]);
    }
    return words;
}
