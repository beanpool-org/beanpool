/**
 * The web app's 12 words carry the standard BIP-39 checksum (verify-audit-key-paths KEY-02), and every account made by
 * the web code before this change still restores.
 *
 * Before, the web's 12th word ended in 4 bits of a home-made hash, so 15 of 16 web phrases failed an outside BIP-39
 * check and the web and the phone made different words from the same entropy. Nothing in BeanPool checks the checksum
 * (validateMnemonic and core's isWellFormedRecoveryPhrase check list membership only; core packs all 132 bits), and the
 * key is SHA-256(SHA-256(the words)), so an old phrase makes the same key it always made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { isWellFormedRecoveryPhrase, packRecoveryWords, recoveryWordsFromEntropy, recoveryWordsMatchPublicKey } from '@beanpool/core';
import { generateMnemonic, mnemonicToKeypair, validateMnemonic } from './mnemonic';
import { WORDLIST } from './bip39-wordlist';

function standardChecksumHolds(words: string[]): boolean {
    const packed = packRecoveryWords(words);
    return (packed[16] >>> 4) === (sha256(packed.slice(0, 16))[0] >>> 4);
}

/** The web's words as origin/main e9d80b05 made them (lib/mnemonic.ts computeChecksum), kept here to prove old phrases. */
function oldWebWords(entropy: Uint8Array): string[] {
    let h = 0x6a09e667;
    for (let i = 0; i < entropy.length; i++) h = ((h << 5) - h + entropy[i]) | 0;
    let bits = '';
    for (const byte of entropy) bits += byte.toString(2).padStart(8, '0');
    bits += ((h >>> 28) & 0xf).toString(2).padStart(4, '0');
    const words: string[] = [];
    for (let i = 0; i < 12; i++) words.push(WORDLIST[parseInt(bits.slice(i * 11, (i + 1) * 11), 2)]);
    return words;
}

afterEach(() => vi.restoreAllMocks());

describe('the web app\'s new words', () => {
    it('every phrase it makes passes the standard checksum', () => {
        for (let i = 0; i < 300; i++) expect(standardChecksumHolds(generateMnemonic())).toBe(true);
    });

    it('the same entropy makes the same 12 words as the phone (core recoveryWordsFromEntropy)', () => {
        const entropy = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
        vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
            (array as unknown as Uint8Array).set(entropy);
            return array;
        });
        expect(generateMnemonic()).toEqual(recoveryWordsFromEntropy(entropy));
    });
});

describe('an account made by the old web code', () => {
    // Pinned with the old code and Node's own Ed25519 (not noble): entropy (i * 37 + 11) & 0xff → these words → this
    // public key. Test material only, never a real account's.
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
    const OLD_PHRASE = 'arctic live gadget display excess mandate sniff autumn people disorder affair hollow';
    const OLD_PUBLIC_KEY = 'e6149c29fc10583c1fed8023f90c06f509b55caeb1fd5ea80885308f18a36667';

    it('still passes every check a restore makes and makes the same key it always made', async () => {
        const words = oldWebWords(entropy);
        expect(words.join(' ')).toBe(OLD_PHRASE);
        // A real old-web phrase: its checksum is not the standard one, and the new code would make a different 12th word.
        expect(standardChecksumHolds(words)).toBe(false);
        expect(recoveryWordsFromEntropy(entropy).slice(0, 11)).toEqual(words.slice(0, 11));
        expect(recoveryWordsFromEntropy(entropy)[11]).not.toBe(words[11]);
        expect(validateMnemonic(words)).toBe(true);
        expect(isWellFormedRecoveryPhrase(words)).toBe(true);
        const { publicKeyHex } = await mnemonicToKeypair(words);
        expect(publicKeyHex).toBe(OLD_PUBLIC_KEY);
        expect(recoveryWordsMatchPublicKey(words, OLD_PUBLIC_KEY)).toBe(true);
    });

    it('so do 200 more old-web phrases: listed words, well formed, and their key matches', async () => {
        let nonStandard = 0;
        for (let i = 0; i < 200; i++) {
            const words = oldWebWords(crypto.getRandomValues(new Uint8Array(16)));
            if (!standardChecksumHolds(words)) nonStandard++;
            expect(validateMnemonic(words)).toBe(true);
            expect(isWellFormedRecoveryPhrase(words)).toBe(true);
            expect(recoveryWordsMatchPublicKey(words, (await mnemonicToKeypair(words)).publicKeyHex)).toBe(true);
        }
        expect(nonStandard).toBeGreaterThan(150);
    });
});
