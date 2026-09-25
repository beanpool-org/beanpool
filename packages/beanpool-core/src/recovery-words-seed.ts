/**
 * The account key the 12 words make: `seed = SHA256(SHA256(words joined by single spaces))`, the derivation both
 * apps use (native `utils/crypto.ts` `mnemonicToKeypair`, PWA `lib/mnemonic.ts`).
 *
 * Internal to core, and not exported from the package: recovery-words.ts compares an account with it, and
 * owner-words-check.ts opens its throwaway envelope with it. One derivation for both, so the owners' check and every
 * other place the words are checked cannot drift apart.
 *
 * @param words already normalised: lowercase, one entry per word (recovery-words.ts `normaliseRecoveryWords`).
 * @returns the 32-byte seed. The caller zeroes it when done.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export function seedFromRecoveryWords(words: readonly string[]): Uint8Array {
    const phrase = utf8ToBytes(words.join(' '));
    const inner = sha256(phrase);
    const seed = sha256(inner);
    phrase.fill(0);
    inner.fill(0);
    return seed;
}
