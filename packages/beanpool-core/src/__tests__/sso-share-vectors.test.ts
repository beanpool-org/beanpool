/**
 * The frozen sign-in recovery copies (sso-share-vectors.ts) from core's side: each opens with core's opener to the
 * vector key (and its words, when it carries them), and core's sealer, given the same random stream, makes the
 * same seed box byte for byte. The native app's and the PWA's suites hold their own clients to the same list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { openSeedFromSso, sealSeedToSso } from '../keeper-crypto.js';
import { toEd25519Seed } from '../ed25519-key.js';
import {
    SSO_SHARE_VECTORS,
    SSO_SHARE_VECTOR_PKCS8_HEX,
    SSO_SHARE_VECTOR_PUBLIC_KEY,
    SSO_SHARE_VECTOR_SEED_HEX,
    SSO_SHARE_VECTOR_WORDS,
    seededGetRandomValues,
} from '../sso-share-vectors.js';
import { recoveryWordsMatchSeed } from '../recovery-words.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('sign-in recovery copy vectors', () => {
    it('the vector key is the one the apps make from the words, in both forms', () => {
        const seed = hexToBytes(SSO_SHARE_VECTOR_SEED_HEX);
        expect(bytesToHex(ed25519.getPublicKey(seed))).toBe(SSO_SHARE_VECTOR_PUBLIC_KEY);
        expect(bytesToHex(toEd25519Seed(hexToBytes(SSO_SHARE_VECTOR_PKCS8_HEX)))).toBe(SSO_SHARE_VECTOR_SEED_HEX);
        expect(recoveryWordsMatchSeed(SSO_SHARE_VECTOR_WORDS, seed)).toBe(true);
    });

    it.each(SSO_SHARE_VECTORS.map((v) => [v.name, v] as const))('%s: opens to the vector key, words as sealed', async (_name, v) => {
        expect(v.shares).toHaveLength(1);
        const [share] = v.shares;
        expect(share).toMatchObject({ holderType: 'sso', holderRef: v.provider, shareIndex: 1 });
        const opened = await openSeedFromSso(share, v.provider, v.sub);
        expect(bytesToHex(opened.seed)).toBe(SSO_SHARE_VECTOR_SEED_HEX);
        expect(opened.wordsStatus).toBe(v.withWords ? 'carried' : 'absent');
        expect(opened.words).toEqual(v.withWords ? SSO_SHARE_VECTOR_WORDS : null);
        // Another sign-in account does not open it.
        await expect(openSeedFromSso(share, v.provider, `${v.sub}0`)).rejects.toThrow();
    });

    it.each(SSO_SHARE_VECTORS.map((v) => [v.name, v] as const))('%s: core seals the same bytes from the same random stream', async (_name, v) => {
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(seededGetRandomValues(v.name) as never);
        const sealed = await sealSeedToSso(hexToBytes(SSO_SHARE_VECTOR_SEED_HEX), v.provider, v.sub, {
            words: v.withWords ? SSO_SHARE_VECTOR_WORDS : null,
        });
        const { holderType: _t, holderRef: _r, shareIndex: _i, ...box } = v.shares[0];
        expect(sealed).toEqual(box);
    });

    it('the seeded stream is the same stream each time, whatever sizes it is asked for', () => {
        const a = seededGetRandomValues('x');
        const b = seededGetRandomValues('x');
        const one = a(new Uint8Array(80));
        const parts = [b(new Uint8Array(32)), b(new Uint8Array(24)), b(new Uint8Array(24))];
        expect(bytesToHex(one)).toBe(parts.map(bytesToHex).join(''));
        expect(bytesToHex(seededGetRandomValues('y')(new Uint8Array(80)))).not.toBe(bytesToHex(one));
    });
});
