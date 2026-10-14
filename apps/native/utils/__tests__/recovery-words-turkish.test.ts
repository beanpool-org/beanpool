/**
 * The 12 words typed on a Turkish keyboard, on the phone (review of #1941, N10): the restore screen's boxes
 * (components/RecoveryWordsEntry.tsx), the add-your-words boxes (add-words.ts) and the key the words make
 * (crypto.ts validateMnemonic / mnemonicToKeypair). A Turkish capital `İ` lowercases to "i" plus a combining dot and
 * the dotless `ı` stays `ı`, so with a bare toLowerCase() these words were "not valid recovery words".
 *
 * The plain words' key is pinned from origin/main (934ece92): the same 12 ASCII words make the same key, byte for byte.
 */
import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

vi.mock('react-native', () => ({ StyleSheet: { create: (s: unknown) => s }, View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Platform: { OS: 'android' } }));
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn(async () => '') }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)) }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('../../components/WordsOnScreen', () => ({ NoScreenCapture: 'NoScreenCapture' }));

import { mnemonicToKeypair, validateMnemonic } from '../crypto';
import { wordsAfterTyping, wordsFromText } from '../../components/RecoveryWordsEntry';
import { applyWordBoxChange, emptyWordBoxes, wordBoxState } from '../add-words';

// Test phrase only: twelve listed words that start with "i". Never a real account's.
const I_WORDS = 'item idea ice icon identify idle ignore ill illegal illness image imitate';
const PLAIN = I_WORDS.split(' ');
/** SHA256(SHA256(I_WORDS)) and its public key, from origin/main 934ece92. */
const PINNED = {
    seed: '4648afba93e15c6ed0b9707d20eb3d26c74cf89911b5cbf3f509568975aa0341',
    publicKey: 'ecd6b6b61cea54584fee1dcbf4e3e7d626b02c255ba1be4a5431cb9de7773c94',
};

/** What a Turkish keyboard gives for the same words, one entry per box. */
const TURKISH: [string, string[]][] = [
    ['all Turkish capitals', PLAIN.map((w) => w.toLocaleUpperCase('tr-TR'))],
    ['each box auto-capitalised', PLAIN.map((w) => 'İ' + w.slice(1))],
    ['decomposed capital İ', PLAIN.map((w) => w.toLocaleUpperCase('tr-TR').normalize('NFD'))],
    ['lowercased in tr-TR', PLAIN.map((w) => w.toUpperCase().toLocaleLowerCase('tr-TR'))],
    ['Turkish capitals lowercased', PLAIN.map((w) => w.toLocaleUpperCase('tr-TR').toLowerCase())],
];

describe('the key the words make (crypto.ts)', () => {
    it('the plain words make the pinned key, as before', async () => {
        expect(validateMnemonic(PLAIN)).toBe(true);
        expect(await mnemonicToKeypair(PLAIN)).toEqual({ publicKeyHex: PINNED.publicKey, privateKeyHex: PINNED.seed });
    });

    it.each(TURKISH)('%s: valid, and the same key byte for byte', async (_, boxes) => {
        expect(boxes.some((w) => /[İı̇]/.test(w))).toBe(true);
        expect(validateMnemonic(boxes)).toBe(true);
        expect(await mnemonicToKeypair(boxes)).toEqual({ publicKeyHex: PINNED.publicKey, privateKeyHex: PINNED.seed });
    });

    it('the same key when the runtime lowercases the Turkish way (toLowerCase following a tr-TR locale)', async () => {
        const plain = String.prototype.toLowerCase;
        // eslint-disable-next-line no-extend-native
        String.prototype.toLowerCase = function (this: string) { return this.toLocaleLowerCase('tr-TR'); };
        try {
            const caps = PLAIN.map((w) => w.toUpperCase());
            expect(validateMnemonic(caps)).toBe(true);
            expect(await mnemonicToKeypair(caps)).toEqual({ publicKeyHex: PINNED.publicKey, privateKeyHex: PINNED.seed });
        } finally {
            String.prototype.toLowerCase = plain;
        }
    });
});

describe('the restore screen\'s 12 boxes (RecoveryWordsEntry)', () => {
    it.each(TURKISH)('%s: each box holds the listed word', (_, boxes) => {
        let typed: string[] = Array(12).fill('');
        boxes.forEach((w, i) => { typed = wordsAfterTyping(typed, i, w); });
        expect(typed).toEqual(PLAIN);
    });

    it.each(TURKISH)('%s: a pasted phrase fills the boxes with the listed words', (_, boxes) => {
        expect(wordsFromText(boxes.join(' '))).toEqual(PLAIN);
        expect(wordsAfterTyping(Array(12).fill(''), 5, boxes.join('  '))).toEqual(PLAIN);
    });
});

describe('the add-your-words boxes (add-words.ts)', () => {
    it.each(TURKISH)('%s: every box is a listed word', (_, boxes) => {
        expect(boxes.map(wordBoxState)).toEqual(Array(12).fill('ok'));
        expect(applyWordBoxChange(emptyWordBoxes(), 0, boxes.join(' '))).toEqual(PLAIN);
    });

    it('the start of a word typed with a Turkish capital is still "typing", not a typo', () => {
        expect(wordBoxState('İDE')).toBe('typing');
        expect(wordBoxState('ıde')).toBe('typing');
        expect(wordBoxState('İDEAZ')).toBe('unknown');
    });
});
