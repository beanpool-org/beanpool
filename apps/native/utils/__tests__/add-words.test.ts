/**
 * "Add your 12 words to this phone": the typing (utils/add-words.ts) and the save (identity.ts
 * addMnemonicToIdentity). A match saves the words; a mismatch or a malformed phrase changes nothing; nothing
 * reaches a network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
}));
const store = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: vi.fn(async (k: string) => { store.delete(k); }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import * as SecureStore from 'expo-secure-store';
import { BIP39_ENGLISH, toEd25519Pkcs8 } from '@beanpool/core';
import { WORDLIST } from '../../../pwa/src/lib/bip39-wordlist';
import { addMnemonicToIdentity, getMnemonic, hasMnemonic, loadIdentity } from '../identity';
import {
    ADD_WORDS_COPY, applyWordBoxChange, checkWordBoxes, emptyWordBoxes, wordBoxState, wordBoxesFromPaste, wordBoxesStatus,
} from '../add-words';

// Test phrases only (BIP-39 vectors), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const OTHER_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const PUB = bytesToHex(ed25519.getPublicKey(SEED));

/** A phone restored with a sign-in before copies carried the words: the key, no words. */
const WORDLESS = { publicKey: PUB, privateKey: bytesToHex(SEED), callsign: 'Marty', createdAt: '2026-09-25T00:00:00.000Z' };

function putIdentity(identity: object | null) {
    store.clear();
    if (identity) store.set('sovereign-identity', JSON.stringify(identity));
}

describe('the word list the check uses', () => {
    it('is the list the app makes its words from', () => {
        expect([...BIP39_ENGLISH]).toEqual(WORDLIST);
    });
});

describe('typing the words', () => {
    it('says what each box holds, flagging a typo as soon as no listed word starts like it', () => {
        expect(wordBoxState('')).toBe('empty');
        expect(wordBoxState('  ')).toBe('empty');
        expect(wordBoxState('winn')).toBe('typing');
        expect(wordBoxState('winner')).toBe('ok');
        expect(wordBoxState(' Winner ')).toBe('ok');
        expect(wordBoxState('winnr')).toBe('unknown');
        expect(wordBoxState('qz')).toBe('unknown');
    });

    it('keeps one word in its box, lowercased, spaces dropped', () => {
        const boxes = applyWordBoxChange(emptyWordBoxes(), 3, ' YEAR ');
        expect(boxes[3]).toBe('year');
        expect(boxes.filter(Boolean)).toEqual(['year']);
    });

    it('spreads a pasted phrase across all twelve from the first box, whichever box it went into', () => {
        const messy = `  LEGAL winner\tthank\n\nyear wave sausage worth useful legal winner thank Yellow `;
        expect(applyWordBoxChange(emptyWordBoxes(), 7, messy)).toEqual(WORDS);
        expect(wordBoxesFromPaste(messy)).toEqual(WORDS);
        // A thirteenth word is dropped rather than shifting the rest.
        expect(wordBoxesFromPaste(`${WORDS.join(' ')} extra`)).toEqual(WORDS);
    });

    it('fills a few pasted words from the box they went into', () => {
        const boxes = applyWordBoxChange(emptyWordBoxes(), 10, 'thank yellow');
        expect(boxes.slice(10)).toEqual(['thank', 'yellow']);
        expect(boxes.slice(0, 10).every((b) => b === '')).toBe(true);
    });

    it('is ready only at twelve listed words, and says which are not on the list', () => {
        expect(checkWordBoxes(WORDS).ready).toBe(true);
        expect(wordBoxesStatus(checkWordBoxes(WORDS))).toBe('All 12 words are on the list.');

        const partial = [...WORDS.slice(0, 7), ...Array(5).fill('')];
        expect(checkWordBoxes(partial).ready).toBe(false);
        expect(wordBoxesStatus(checkWordBoxes(partial))).toBe('7 of 12 words.');

        const typo = [...WORDS];
        typo[4] = 'wavv';
        expect(checkWordBoxes(typo)).toMatchObject({ ready: false, unknown: [5] });
        expect(wordBoxesStatus(checkWordBoxes(typo))).toBe('Word 5 is not on the list of recovery words. Check the spelling.');
        typo[11] = 'yelow';
        expect(wordBoxesStatus(checkWordBoxes(typo))).toBe('Words 5, 12 are not on the list of recovery words. Check the spelling.');

        const unfinished = [...WORDS];
        unfinished[0] = 'lega';
        expect(checkWordBoxes(unfinished)).toMatchObject({ ready: false, unknown: [] });
    });

    it('tells the member the words stay on the phone, and after saving, how to get them into a sign-in', () => {
        expect(ADD_WORDS_COPY.intro).toContain('They are not sent anywhere.');
        expect(ADD_WORDS_COPY.mismatch).toBe('Those 12 words belong to a different account. Nothing on this phone has changed.');
        expect(ADD_WORDS_COPY.done).toContain('A sign-in you connected before still brings back your account without them.');
        expect(ADD_WORDS_COPY.done).toContain('tap Connect again');
    });
});

describe('saving the words', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.clearAllMocks();
        fetchSpy = vi.fn(async () => { throw new Error('no network in this test'); });
        vi.stubGlobal('fetch', fetchSpy);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('saves the words when they make this account\'s key, and Show my 12 words has them', async () => {
        putIdentity(WORDLESS);

        const result = await addMnemonicToIdentity(WORDS);

        expect(result.ok).toBe(true);
        const saved = await loadIdentity();
        expect(saved).toEqual({ ...WORDLESS, mnemonic: WORDS });
        expect(hasMnemonic(saved)).toBe(true);
        expect(await getMnemonic(saved)).toEqual(WORDS);
        expect(result.ok && result.identity).toEqual(saved);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('forgives case and spacing, and saves the words normalised', async () => {
        putIdentity(WORDLESS);
        const result = await addMnemonicToIdentity(`  ${WORDS.join('   ').toUpperCase()}\n`);
        expect(result.ok).toBe(true);
        expect((await loadIdentity())?.mnemonic).toEqual(WORDS);
    });

    it('matches a PKCS8 key (a PWA-made identity) by its public key', async () => {
        putIdentity({ ...WORDLESS, privateKey: bytesToHex(toEd25519Pkcs8(SEED)) });
        expect((await addMnemonicToIdentity(WORDS)).ok).toBe(true);
    });

    it('changes nothing when the words belong to a different account', async () => {
        putIdentity(WORDLESS);

        const result = await addMnemonicToIdentity(OTHER_WORDS);

        expect(result).toEqual({ ok: false, reason: 'mismatch' });
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        expect(await loadIdentity()).toEqual(WORDLESS);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['eleven words', WORDS.slice(0, 11)],
        ['thirteen words', [...WORDS, 'legal']],
        ['a word not on the list', [...WORDS.slice(0, 11), 'yelow']],
        ['the right words in the wrong order', [WORDS[1], WORDS[0], ...WORDS.slice(2)]],
        ['nothing', ''],
        ['no words at all (null)', null],
        ['no words at all (undefined)', undefined],
    ])('changes nothing for %s', async (_label, typed) => {
        putIdentity(WORDLESS);

        const result = await addMnemonicToIdentity(typed as string | string[]);

        expect(result.ok).toBe(false);
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        expect(await loadIdentity()).toEqual(WORDLESS);
    });

    it('never replaces words a phone already has', async () => {
        putIdentity({ ...WORDLESS, mnemonic: WORDS });
        expect(await addMnemonicToIdentity(WORDS)).toEqual({ ok: false, reason: 'has-words' });
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    it('says so when there is no account on the phone', async () => {
        putIdentity(null);
        expect(await addMnemonicToIdentity(WORDS)).toEqual({ ok: false, reason: 'no-identity' });
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    it('never logs the words', async () => {
        const log = vi.spyOn(console, 'log');
        const error = vi.spyOn(console, 'error');
        putIdentity(WORDLESS);
        await addMnemonicToIdentity(OTHER_WORDS);
        await addMnemonicToIdentity(WORDS);
        const logged = [...log.mock.calls, ...error.mock.calls].flat().join('\n');
        for (const w of [...WORDS, ...OTHER_WORDS]) expect(logged).not.toMatch(new RegExp(`\\b${w}\\b`));
        log.mockRestore();
        error.mockRestore();
    });
});
