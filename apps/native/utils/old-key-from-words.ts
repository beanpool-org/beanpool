/**
 * The key an account had before a re-key, from its old 12 words (the restore's derivation, @beanpool/core
 * recovery-words-seed.ts: `seed = SHA256(SHA256(words))`). A leaf, so every screen that opens something with the old words
 * (group history, utils/group-history-unlock.ts; the old contacts list, utils/contacts-former.ts) uses this one function.
 */
import { isWellFormedRecoveryPhrase, normaliseRecoveryWords, dmPublicKeyOf } from '@beanpool/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** The old key's seed and public key from typed words, or null when they are not 12 listed words. Kept in memory only. */
export function oldKeyFromWords(typed: string | readonly string[]): { seed: Uint8Array; publicKey: string } | null {
    if (!isWellFormedRecoveryPhrase(typed)) return null;
    const phrase = utf8ToBytes(normaliseRecoveryWords(typed).join(' '));
    const inner = sha256(phrase);
    const seed = sha256(inner);
    phrase.fill(0);
    inner.fill(0);
    return { seed, publicKey: dmPublicKeyOf(bytesToHex(seed)) };
}
