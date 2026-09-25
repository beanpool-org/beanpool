/**
 * "View Recovery Phrase" on a phone without the 12 words, and the one check behind both places a member types
 * them: the owners' "Check your 12 words" (utils/owner-words.ts) and "Add your 12 words to this phone"
 * (identity.ts addMnemonicToIdentity).
 *
 * - The row and the Account Protection button are there on every phone. With words they show them; without,
 *   they open the add form under one plain line.
 * - Both screens ask one function (identity.ts checkWordsForAccount → @beanpool/core checkOwnerWords, which
 *   decides with recoveryWordsMatchPublicKey), so they can never give a member two answers for one set of words.
 * - The owners' screen, after a match on a phone without words, offers to save them, through the add form's save.
 *
 * Nothing here reaches a network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
// The real check, watched: both screens must reach this one function.
vi.mock('@beanpool/core', async (importOriginal) => {
    const real = await importOriginal<typeof import('@beanpool/core')>();
    return { ...real, checkOwnerWords: vi.fn(real.checkOwnerWords) };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import * as SecureStore from 'expo-secure-store';
import { checkOwnerWords, toEd25519Pkcs8 } from '@beanpool/core';
import { addMnemonicToIdentity, getMnemonic, hasMnemonic, loadIdentity, type BeanPoolIdentity } from '../identity';
import { ADD_WORDS_COPY, viewWordsOpens } from '../add-words';
import { NO_WORDS_MENU, NO_WORDS_VIEW_LINE, VIEW_WORDS_MENU } from '../no-words-copy';
import {
    OWNER_WORDS_COPY, OWNER_WORDS_INITIAL, checkMyWords, ownerWordsFindThem, ownerWordsReducer, saveCheckedWords,
    shouldOfferSaveWords,
} from '../owner-words';

// Test phrases only (BIP-39 vectors), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const OTHER_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const OTHER_SEED = sha256(sha256(utf8ToBytes(OTHER_WORDS.join(' '))));

/** A phone restored with a sign-in before copies carried the words: the key, no words. */
const WORDLESS: BeanPoolIdentity = { publicKey: PUB, privateKey: bytesToHex(SEED), callsign: 'Marty', createdAt: '2026-09-25T00:00:00.000Z' };
const WITH_WORDS: BeanPoolIdentity = { ...WORDLESS, mnemonic: WORDS };

function putIdentity(identity: object | null) {
    store.clear();
    if (identity) store.set('sovereign-identity', JSON.stringify(identity));
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn(async () => { throw new Error('no network in this test'); });
    vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
});

describe('one check, not two', () => {
    it("the owners' check and the add-your-words save ask the same function the same question", async () => {
        putIdentity(WORDLESS);
        const check = vi.mocked(checkOwnerWords);

        expect(await checkMyWords(WORDS.join(' '), WORDLESS)).toEqual({ matches: true });
        expect((await addMnemonicToIdentity(WORDS)).ok).toBe(true);

        expect(check).toHaveBeenCalledTimes(2);
        expect(check.mock.calls[0][1]).toEqual({ publicKeyHex: PUB, privateKey: WORDLESS.privateKey });
        expect(check.mock.calls[1][1]).toEqual(check.mock.calls[0][1]);
    });

    it.each([
        ['the right words (native raw key)', WORDLESS, WORDS, true],
        ['the right words (PWA PKCS8 key)', { ...WORDLESS, privateKey: bytesToHex(toEd25519Pkcs8(SEED)) }, WORDS, true],
        ["another account's words", WORDLESS, OTHER_WORDS, false],
        ['the right words in the wrong order', WORDLESS, [WORDS[1], WORDS[0], ...WORDS.slice(2)], false],
        // The public key says these words; the key this phone signs with says otherwise. The owners' check has
        // always said no here. The add save used to say yes, and would have kept words its own enrolment then
        // refuses to seal (keeper-enrolment.ts recoveryWordsMatchSeed).
        ['words that make the public key but not the key this phone holds', { ...WORDLESS, privateKey: bytesToHex(OTHER_SEED) }, WORDS, false],
    ] as const)('both screens give the same answer: %s', async (_label, identity, typed, right) => {
        putIdentity(identity);

        const owners = await checkMyWords([...typed].join(' '), identity);
        const added = await addMnemonicToIdentity([...typed]);

        expect(owners.matches).toBe(right);
        expect(added.ok).toBe(right);
        if (!right) {
            expect(added).toEqual({ ok: false, reason: 'mismatch' });
            expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
            expect(await loadIdentity()).toEqual(identity);
        }
    });
});

describe('"View Recovery Phrase" on a phone without the 12 words', () => {
    it('reads as it does on a phone with words, and says this phone has no copy', () => {
        expect(VIEW_WORDS_MENU).toEqual({ title: 'View Recovery Phrase', sub: 'View your 12-word backup seed' });
        expect(NO_WORDS_MENU).toEqual({ title: 'View Recovery Phrase', sub: 'No copy on this phone yet. Tap to add your 12 words.' });
    });

    it('opens the add form under one plain line; a phone with words is shown them, as before', () => {
        expect(viewWordsOpens(WORDLESS)).toBe('add-words');
        expect(viewWordsOpens({ ...WORDLESS, mnemonic: [] })).toBe('add-words');
        expect(viewWordsOpens(WITH_WORDS)).toBe('show-words');
        expect(NO_WORDS_VIEW_LINE).toBe(
            'This phone has no copy of your 12 words. Typing them in checks them against this account and saves them on this phone. They are not sent anywhere.');
        expect(ADD_WORDS_COPY.intro).toBe(NO_WORDS_VIEW_LINE);
    });

    it('a match saves the words, and the same button then shows them', async () => {
        putIdentity(WORDLESS);

        const result = await addMnemonicToIdentity(WORDS);

        expect(result.ok).toBe(true);
        const saved = await loadIdentity();
        expect(viewWordsOpens(saved)).toBe('show-words');
        expect(await getMnemonic(saved)).toEqual(WORDS);
    });

    it('a mismatch changes nothing: the button still opens the add form', async () => {
        putIdentity(WORDLESS);

        expect(await addMnemonicToIdentity(OTHER_WORDS)).toEqual({ ok: false, reason: 'mismatch' });

        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        const after = await loadIdentity();
        expect(after).toEqual(WORDLESS);
        expect(viewWordsOpens(after)).toBe('add-words');
    });

    // The screen cannot be rendered here (vitest.config.ts): this checks it asks viewWordsOpens in both places.
    it('Settings: the menu row and the Account Protection button are drawn on every phone and go where viewWordsOpens says', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/settings.tsx'), 'utf-8');
        // The row: one label for both phones.
        expect(src).toMatch(/const viewWordsRow = hasMnemonic\(identity\) \? VIEW_WORDS_MENU : NO_WORDS_MENU;/);
        expect(src).toMatch(/<Text style=\{styles\.menuText\}>\{viewWordsRow\.title\}<\/Text>/);
        // Both entry points open the seed screen through one handler, and it asks viewWordsOpens what to show.
        expect(src).toMatch(/const openViewWords = \(\) => \{[^}]*setMode\('seed'\);\s*\};/);
        expect(src).toContain('onPress={openViewWords}');
        expect(src).toMatch(/\{viewWordsOpens\(identity\) === 'add-words' \? \(\s*<>\s*\{\/\*[^]*?\*\/\}\s*<AddWordsForm/);
        // Account Protection: the words block is no longer drawn only on a phone with words.
        expect(src).not.toMatch(/\{hasMnemonic\(identity\) && \(\s*<View style=\{\{ marginTop: 24, paddingTop: 20/);
        expect(src).toContain('onPress={hasMnemonic(identity) ? handleRevealWords : openViewWords}');
        // The seed screen, on a phone without words, opens with the form and the one plain line.
        expect(src).not.toContain('ADD_WORDS_COPY.fromProtection');
    });
});

describe("the owners' check on a phone without the 12 words", () => {
    const typed = WORDS.join(' ');
    const checked = (offerSave: boolean, matches = true) => {
        const s = ownerWordsReducer({ ...OWNER_WORDS_INITIAL, typed }, { type: 'checking' });
        return ownerWordsReducer(s, {
            type: 'answered',
            result: matches ? { matches: true } : { matches: false, reason: 'mismatch' },
            countSeen: 12,
            offerSave,
        });
    };

    it('offers "Save them on this phone" only on a phone without words, and only after a match', () => {
        expect(shouldOfferSaveWords(WORDLESS)).toBe(true);
        expect(shouldOfferSaveWords({ ...WORDLESS, mnemonic: [] })).toBe(true);
        expect(shouldOfferSaveWords(WITH_WORDS)).toBe(false);

        expect(checked(true).save).toBe('offered');
        expect(checked(false).save).toBe('none');
        expect(checked(true, false).save).toBe('none');
        expect(JSON.stringify(checked(false))).not.toContain('legal');
        expect(JSON.stringify(checked(true, false))).not.toContain('legal');
        expect(OWNER_WORDS_COPY.saveOffer).toBe(
            'This phone has no copy of your 12 words. Save them here and Settings → View Recovery Phrase shows them.');
        expect(OWNER_WORDS_COPY.saveButton).toBe('Save them on this phone');
    });

    it('holds the words only while the offer stands: saved, typed over, or cleared, they are gone', () => {
        const offered = checked(true);
        expect(offered.typed).toBe('');
        expect(offered.unsaved).toBe(typed);

        for (const after of [
            ownerWordsReducer(ownerWordsReducer(offered, { type: 'saving' }), { type: 'saveAnswered', ok: true }),
            ownerWordsReducer(ownerWordsReducer(offered, { type: 'saving' }), { type: 'saveAnswered', ok: false }),
            ownerWordsReducer(offered, { type: 'typed', text: 'a' }),
            ownerWordsReducer(offered, { type: 'clear' }),
        ]) {
            expect(after.unsaved).toBeNull();
            expect(JSON.stringify(after)).not.toContain('legal');
        }
        expect(ownerWordsReducer(offered, { type: 'saving' }).save).toBe('saving');
        expect(ownerWordsReducer(offered, { type: 'saveAnswered', ok: true }).save).toBe('saved');
        expect(ownerWordsReducer(offered, { type: 'saveAnswered', ok: false }).save).toBe('failed');
        expect(ownerWordsReducer(offered, { type: 'typed', text: 'a' }).save).toBe('none');
        expect(ownerWordsReducer(offered, { type: 'clear' })).toEqual(OWNER_WORDS_INITIAL);
    });

    it('saves through the add form\'s save, and View Recovery Phrase then shows the words', async () => {
        putIdentity(WORDLESS);
        const offered = checked(true);

        const result = await saveCheckedWords(offered.unsaved!);

        expect(result.ok).toBe(true);
        const saved = await loadIdentity();
        expect(hasMnemonic(saved)).toBe(true);
        expect(await getMnemonic(saved)).toEqual(WORDS);
        expect(viewWordsOpens(saved)).toBe('show-words');
        // The same save: it checks again, with the one check.
        expect(vi.mocked(checkOwnerWords)).toHaveBeenCalledTimes(1);
    });

    it('"Can\'t find them?" stays true on a phone without words', () => {
        expect(ownerWordsFindThem(true)).toBe(OWNER_WORDS_COPY.findThem);
        expect(OWNER_WORDS_COPY.findThem).toBe("Can't find them? If this phone still has them, Settings → View Recovery Phrase shows them.");
        expect(ownerWordsFindThem(false)).toBe(
            "Can't find them? This phone has no copy of them to show you. When you find them, check them here, then save them on this phone.");
    });

    // The screen cannot be rendered here (vitest.config.ts): this checks it wires the offer the way the tests above assume.
    it('the screen asks shouldOfferSaveWords, and saves with saveCheckedWords', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/owner-words-check.tsx'), 'utf-8');
        expect(src).toMatch(/offerSave: shouldOfferSaveWords\(identity\)/);
        expect(src).toMatch(/await saveCheckedWords\(words\)/);
        expect(src).toContain('{ownerWordsFindThem(hasMnemonic(identity))}');
    });
});
