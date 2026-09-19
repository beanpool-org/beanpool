import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';

// Wraps openEnvelope so the test can see the key it was handed, and check afterwards that it was zeroed.
vi.mock('../sealed-envelope.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sealed-envelope.js')>();
    return { ...real, openEnvelope: vi.fn(real.openEnvelope) };
});
import { openEnvelope } from '../sealed-envelope.js';
import {
    OWNER_WORDS_CHECK_RENEW_MS,
    checkOwnerWords,
    isOwnerWordsCheckDue,
    ownerWordsPromptRound,
    splitTypedWords,
} from '../owner-words-check.js';

// A fixed phrase. Both clients derive seed = SHA256(SHA256(phrase)) (native utils/crypto.ts, PWA lib/mnemonic.ts).
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const RAW_HEX = bytesToHex(SEED); // native: raw 32-byte seed
const PKCS8_HEX = bytesToHex(toEd25519Pkcs8(SEED)); // PWA: 48-byte PKCS8

describe('checkOwnerWords', () => {
    it('the right words match the account public key', async () => {
        expect(await checkOwnerWords(WORDS, { publicKeyHex: PUB })).toEqual({ matches: true });
    });

    it('accepts one typed string with odd spacing and capitals', async () => {
        const typed = `  ${WORDS.map((w, i) => (i % 2 ? w.toUpperCase() : w)).join('   \n')} `;
        expect(await checkOwnerWords(typed, { publicKeyHex: PUB })).toEqual({ matches: true });
    });

    it('works for a native (raw seed) account and a PWA (PKCS8) account, hex and bytes', async () => {
        for (const privateKey of [RAW_HEX, PKCS8_HEX, SEED.slice(), toEd25519Pkcs8(SEED)]) {
            expect(await checkOwnerWords(WORDS, { publicKeyHex: PUB, privateKey })).toEqual({ matches: true });
        }
    });

    it('the wrong words do not match, and the answer says nothing about which word', async () => {
        const swapped = [...WORDS];
        swapped[7] = 'zoo';
        const r1 = await checkOwnerWords(swapped, { publicKeyHex: PUB });
        const reordered = [WORDS[1], WORDS[0], ...WORDS.slice(2)];
        const r2 = await checkOwnerWords(reordered, { publicKeyHex: PUB });
        expect(r1).toEqual({ matches: false, reason: 'mismatch' });
        expect(r2).toEqual(r1);
        expect(Object.keys(r1).sort()).toEqual(['matches', 'reason']);
    });

    it('the right words for a different account do not match', async () => {
        const other = bytesToHex(ed25519.getPublicKey(sha256(utf8ToBytes('someone else'))));
        expect(await checkOwnerWords(WORDS, { publicKeyHex: other })).toEqual({ matches: false, reason: 'mismatch' });
    });

    it('eleven or thirteen words is a count miss, not a crash', async () => {
        expect(await checkOwnerWords(WORDS.slice(1), { publicKeyHex: PUB })).toEqual({ matches: false, reason: 'count' });
        expect(await checkOwnerWords([...WORDS, 'zoo'], { publicKeyHex: PUB })).toEqual({ matches: false, reason: 'count' });
    });

    it('a stored key for another seed is a mismatch even when the public key agrees with the words', async () => {
        const otherSeed = sha256(utf8ToBytes('not the same'));
        expect(await checkOwnerWords(WORDS, { publicKeyHex: PUB, privateKey: bytesToHex(otherSeed) }))
            .toEqual({ matches: false, reason: 'mismatch' });
    });

    it('a malformed stored key is ignored; the public key decides', async () => {
        expect(await checkOwnerWords(WORDS, { publicKeyHex: PUB, privateKey: 'abcd' })).toEqual({ matches: true });
    });

    it('a malformed public key is a plain no, never a throw', async () => {
        expect(await checkOwnerWords(WORDS, { publicKeyHex: 'not-hex' })).toEqual({ matches: false, reason: 'mismatch' });
    });

    it('opens a sealed envelope with the derived seed, and zeroes the seed it handed over', async () => {
        const open = vi.mocked(openEnvelope);
        open.mockClear();
        let seenAtCall = '';
        open.mockImplementationOnce(async (...args) => {
            seenAtCall = bytesToHex((args[1] as { privateKey: Uint8Array }).privateKey);
            const real = await vi.importActual<typeof import('../sealed-envelope.js')>('../sealed-envelope.js');
            return real.openEnvelope(...args);
        });
        expect(await checkOwnerWords(WORDS, { publicKeyHex: PUB })).toEqual({ matches: true });
        expect(open).toHaveBeenCalledTimes(1);
        expect(seenAtCall).toBe(RAW_HEX);
        const handed = (open.mock.calls[0][1] as { privateKey: Uint8Array }).privateKey;
        expect(Array.from(handed).every((b) => b === 0)).toBe(true);
    });

    it('never opens anything for the wrong words', async () => {
        const open = vi.mocked(openEnvelope);
        open.mockClear();
        await checkOwnerWords([...WORDS.slice(0, 11), 'zoo'], { publicKeyHex: PUB });
        expect(open).not.toHaveBeenCalled();
    });

    it('does not mutate the caller\'s arrays', async () => {
        const typed = [...WORDS];
        const key = SEED.slice();
        await checkOwnerWords(typed, { publicKeyHex: PUB, privateKey: key });
        expect(typed).toEqual(WORDS);
        expect(bytesToHex(key)).toBe(RAW_HEX);
    });
});

describe('splitTypedWords', () => {
    it('splits on any whitespace and lower-cases', () => {
        expect(splitTypedWords(' A  b\tC\n')).toEqual(['a', 'b', 'c']);
        expect(splitTypedWords(['A ', ' b', ''])).toEqual(['a', 'b']);
    });
});

describe('prompt cadence', () => {
    const now = Date.UTC(2026, 8, 20);
    it('due when never checked, not due within 12 months, due again after', () => {
        expect(isOwnerWordsCheckDue(null, now)).toBe(true);
        expect(isOwnerWordsCheckDue(now - 1000, now)).toBe(false);
        expect(isOwnerWordsCheckDue(now - OWNER_WORDS_CHECK_RENEW_MS + 1, now)).toBe(false);
        expect(isOwnerWordsCheckDue(now - OWNER_WORDS_CHECK_RENEW_MS, now)).toBe(true);
    });
    it('the Later round changes only when a new check lands', () => {
        expect(ownerWordsPromptRound(null)).toBe('never');
        expect(ownerWordsPromptRound(undefined)).toBe('never');
        expect(ownerWordsPromptRound(123)).toBe('renew:123');
    });
});
