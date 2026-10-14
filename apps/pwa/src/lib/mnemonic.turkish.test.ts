/**
 * The 12 words typed on a Turkish keyboard, on the web (review of #1941, N10): lib/mnemonic.ts validateMnemonic and
 * mnemonicToKeypair. A Turkish capital `İ` lowercases to "i" plus a combining dot and the dotless `ı` stays `ı`, so with
 * a bare toLowerCase() these words were "not valid".
 *
 * The plain words' key is pinned from origin/main (934ece92): the same 12 ASCII words make the same key, byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { toEd25519Seed } from '@beanpool/core';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { mnemonicToKeypair, validateMnemonic } from './mnemonic';

// Test phrase only: twelve listed words that start with "i". Never a real account's.
const PLAIN = 'item idea ice icon identify idle ignore ill illegal illness image imitate'.split(' ');
/** SHA256(SHA256(the words)) and its public key, from origin/main 934ece92. */
const PINNED = {
    seed: '4648afba93e15c6ed0b9707d20eb3d26c74cf89911b5cbf3f509568975aa0341',
    publicKey: 'ecd6b6b61cea54584fee1dcbf4e3e7d626b02c255ba1be4a5431cb9de7773c94',
};

const TURKISH: [string, string[]][] = [
    ['all Turkish capitals', PLAIN.map((w) => w.toLocaleUpperCase('tr-TR'))],
    ['each box auto-capitalised', PLAIN.map((w) => '\u0130' + w.slice(1))],
    ['decomposed capital \u0130', PLAIN.map((w) => w.toLocaleUpperCase('tr-TR').normalize('NFD'))],
    ['lowercased in tr-TR', PLAIN.map((w) => w.toUpperCase().toLocaleLowerCase('tr-TR'))],
];

async function keyOf(words: string[]) {
    const { publicKeyHex, privateKeyHex } = await mnemonicToKeypair(words);
    // The web stores PKCS8; the seed inside it is what the words make.
    return { publicKeyHex, seed: bytesToHex(toEd25519Seed(hexToBytes(privateKeyHex))) };
}

describe('the key the words make on the web (lib/mnemonic.ts)', () => {
    it('the plain words make the pinned key, as before', async () => {
        expect(validateMnemonic(PLAIN)).toBe(true);
        expect(await keyOf(PLAIN)).toEqual({ publicKeyHex: PINNED.publicKey, seed: PINNED.seed });
    });

    it.each(TURKISH)('%s: valid, and the same key byte for byte', async (_, boxes) => {
        expect(boxes.some((w) => /\u0130|\u0131|\u0307/.test(w))).toBe(true);
        expect(validateMnemonic(boxes)).toBe(true);
        expect(await keyOf(boxes)).toEqual({ publicKeyHex: PINNED.publicKey, seed: PINNED.seed });
    });
});
