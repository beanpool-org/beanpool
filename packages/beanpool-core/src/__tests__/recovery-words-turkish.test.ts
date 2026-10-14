/**
 * The 12 words typed on a Turkish keyboard (review of #1941, N10). Its capital `İ` lowercases to "i" plus a combining
 * dot (U+0307), and its dotless `ı` stays `ı`, so with a bare `toLowerCase()` "İtem" matched no word on the list and a
 * member typing with Turkish capitals could not get back in. BeanPool ships in Turkish.
 *
 * The other half: the same ASCII words still make the same key, byte for byte. The seeds below were computed with
 * origin/main's derivation (934ece92) before this change and are pinned here as literals.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkOwnerWords } from '../owner-words-check.js';
import {
    BIP39_ENGLISH,
    isWellFormedRecoveryPhrase,
    lowercaseRecoveryWords,
    normaliseRecoveryWords,
    packRecoveryWords,
    recoveryWordsMatchPublicKey,
    recoveryWordsMatchSeed,
    unknownRecoveryWords,
} from '../recovery-words.js';
import { seedFromRecoveryWords } from '../recovery-words-seed.js';

// Test phrases only: BIP-39's all-zero vector and twelve listed words that start with "i". Never a real account's.
const VALID = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const I_WORDS = 'item idea ice icon identify idle ignore ill illegal illness image imitate';

/** SHA256(SHA256(phrase)) and its public key, from origin/main 934ece92 (the derivation both apps use). */
const PINNED = {
    [VALID]: {
        seed: 'a0ad2ab3b5964ed3fe03a45f842f41f140fc16a94871a347031fecdeb28cfe20',
        publicKey: 'c27a83e5c9d9d8e462ef760045f68adc59a5a9e5c3f73b9ec8cf7eeb6d023317',
    },
    [I_WORDS]: {
        seed: '4648afba93e15c6ed0b9707d20eb3d26c74cf89911b5cbf3f509568975aa0341',
        publicKey: 'ecd6b6b61cea54584fee1dcbf4e3e7d626b02c255ba1be4a5431cb9de7773c94',
    },
};

const seedHex = (typed: string | string[]) => bytesToHex(seedFromRecoveryWords(normaliseRecoveryWords(typed)));

/** What a Turkish keyboard gives for the same words. */
const TURKISH_TYPINGS: [string, string | string[]][] = [
    // Caps lock on a Turkish keyboard: every i is İ.
    ['all Turkish capitals', I_WORDS.toLocaleUpperCase('tr-TR')],
    // The keyboard's auto-capital on the first word, and on every box when each word is typed in its own box.
    ['first word auto-capitalised', I_WORDS.replace(/^i/, '\u0130')],
    ['each box auto-capitalised', I_WORDS.split(' ').map((w) => '\u0130' + w.slice(1))],
    // The same capital as "I" + combining dot (decomposed, NFD), as some keyboards and pastes send it.
    ['decomposed capital \u0130', I_WORDS.toLocaleUpperCase('tr-TR').normalize('NFD')],
    // Capitals lowercased the Turkish way (a Turkish-locale lowercase on the way in): every I is ı.
    ['lowercased in tr-TR', I_WORDS.toUpperCase().toLocaleLowerCase('tr-TR')],
    ['Turkish capitals lowercased', I_WORDS.toLocaleUpperCase('tr-TR').toLowerCase()],
];

describe('the 12 words typed with Turkish capitals', () => {
    it('the typings really are what a Turkish keyboard sends (not plain ASCII)', () => {
        for (const [, typed] of TURKISH_TYPINGS) {
            expect([typed, /\u0130|\u0131|\u0307/.test(String(typed))]).toEqual([typed, true]);
        }
    });

    it.each(TURKISH_TYPINGS)('%s: every word is on the list', (_, typed) => {
        expect(unknownRecoveryWords(typed)).toEqual([]);
        expect(isWellFormedRecoveryPhrase(typed)).toBe(true);
        expect(normaliseRecoveryWords(typed)).toEqual(I_WORDS.split(' '));
    });

    it.each(TURKISH_TYPINGS)('%s: the same key as the plain words, byte for byte', (_, typed) => {
        expect(seedHex(typed)).toBe(PINNED[I_WORDS].seed);
        expect(recoveryWordsMatchPublicKey(typed, PINNED[I_WORDS].publicKey)).toBe(true);
        expect(bytesToHex(packRecoveryWords(typed))).toBe(bytesToHex(packRecoveryWords(I_WORDS)));
    });

    it.each(TURKISH_TYPINGS)('%s: the owners\' "Check your 12 words" says yes', async (_, typed) => {
        await expect(checkOwnerWords(typed, { publicKeyHex: PINNED[I_WORDS].publicKey })).resolves.toEqual({ matches: true });
    });

    it('the same key when the runtime lowercases the Turkish way (toLowerCase following a tr-TR locale)', () => {
        const plain = String.prototype.toLowerCase;
        String.prototype.toLowerCase = function (this: string) { return this.toLocaleLowerCase('tr-TR'); };
        try {
            expect('ITEM'.toLowerCase()).toBe('\u0131tem');
            const typed = I_WORDS.toUpperCase();
            expect(normaliseRecoveryWords(typed)).toEqual(I_WORDS.split(' '));
            expect(seedHex(typed)).toBe(PINNED[I_WORDS].seed);
            expect(recoveryWordsMatchPublicKey(typed, PINNED[I_WORDS].publicKey)).toBe(true);
        } finally {
            String.prototype.toLowerCase = plain;
        }
        expect('ITEM'.toLowerCase()).toBe('item');
    });

    it('Turkish capitals still make no other account', () => {
        expect(recoveryWordsMatchPublicKey(I_WORDS.toLocaleUpperCase('tr-TR'), PINNED[VALID].publicKey)).toBe(false);
        // A word that is not on the list stays not on the list: only the letter i is folded.
        expect(unknownRecoveryWords('\u0130TEMS \u0130DEA')).toEqual(['items']);
    });
});

describe('the canonical words: unchanged, byte for byte', () => {
    it.each(Object.entries(PINNED))('%s makes the pinned seed and public key', (phrase, pinned) => {
        const seed = seedFromRecoveryWords(normaliseRecoveryWords(phrase));
        expect(bytesToHex(seed)).toBe(pinned.seed);
        expect(bytesToHex(ed25519.getPublicKey(seed))).toBe(pinned.publicKey);
        expect(recoveryWordsMatchPublicKey(phrase, pinned.publicKey)).toBe(true);
        expect(recoveryWordsMatchSeed(phrase, seed)).toBe(true);
        // ASCII capitals, as before.
        expect(seedHex(phrase.toUpperCase())).toBe(pinned.seed);
    });

    it('every one of the 2048 listed words lowercases to itself, and its ASCII capitals to it', () => {
        const changed = BIP39_ENGLISH.filter((w) => lowercaseRecoveryWords(w) !== w || lowercaseRecoveryWords(w.toUpperCase()) !== w);
        expect(changed).toEqual([]);
        // The list really is plain ASCII lowercase, which is what makes the fold safe.
        expect(BIP39_ENGLISH.filter((w) => !/^[a-z]+$/.test(w))).toEqual([]);
    });
});
