/**
 * A sign-in restore from a copy that carries the 12 words saves them, only when they make the restored key.
 * A copy without words (every copy made before copies carried them) restores exactly as before: the key alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));
vi.mock('../sso-signin', () => ({
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
    signInWithFacebook: vi.fn(),
    signInWithGithubViaNode: vi.fn(),
}));
vi.mock('../node-post', () => ({ signedPost: vi.fn() }));
// The real opener, wrapped so one test can make it misbehave and show the app checks the words itself.
vi.mock('@beanpool/core', async (importOriginal) => {
    const real = await importOriginal<typeof import('@beanpool/core')>();
    return { ...real, openSeedFromSso: vi.fn(real.openSeedFromSso) };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import * as SecureStore from 'expo-secure-store';
import {
    KEEPER_ALG_SSO_WORDS, openSeedFromSso, packRecoveryWords, sealSeedToSso, type SealedShare,
} from '@beanpool/core';
import { signedPost } from '../node-post';
import { signInWithGoogle } from '../sso-signin';
import { recoverAccountWithSso } from '../sso-recovery';

// Test phrases only (BIP-39 vectors), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const OTHER_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const PUB = Buffer.from(ed25519.getPublicKey(SEED)).toString('hex');
const SUB = '110169484474386276334';

/** Google hands back a token whose `sub` is SUB; the node releases `sealed` as a single blob. */
function mockSignInAndNode(sealed: SealedShare) {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const token = `${b64(JSON.stringify({ alg: 'RS256' }))}.${b64(JSON.stringify({ sub: SUB }))}.sig`;
    (signInWithGoogle as any).mockResolvedValue({ idToken: token, nonce: 'n' });
    (signedPost as any).mockImplementation(async (_url: string, path: string) => {
        const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
        if (path === '/api/recovery/collect') return ok({ collectionId: 'c1', threshold: 1 });
        if (path === '/api/recovery/collect/sso-nonce') return ok({ nonce: 'n' });
        if (path === '/api/recovery/collect/sso') return ok({ collected: 1, threshold: 1, enough: true });
        if (path === '/api/recovery/collect/fragments') {
            return ok({
                collected: 1, threshold: 1, enough: true,
                fragments: [{
                    holderType: 'sso', shareIndex: 1,
                    payload: sealed.encryptedShare, payloadIv: sealed.shareIv, payloadTag: sealed.shareTag,
                    kdfParams: sealed.kdfParams,
                }],
            });
        }
        throw new Error(`Unexpected path: ${path}`);
    });
}

async function restore() {
    return recoverAccountWithSso({
        callsign: 'Marty', anchorUrl: 'https://test.beanpool.org', provider: 'google', onDeviceCode: () => {},
    });
}

/** What the identity module wrote to the phone. */
function savedIdentity(): Record<string, unknown> {
    const call = (SecureStore.setItemAsync as any).mock.calls.find((c: unknown[]) => c[0] === 'sovereign-identity');
    return JSON.parse(call[1]);
}

/** A words box built with the right key around `words`: as someone holding the provider's `sub` could. */
async function withWordsBox(sealed: SealedShare, words: string[]): Promise<SealedShare> {
    const params = JSON.parse(sealed.kdfParams);
    const key = await scryptAsync(utf8ToBytes(`google:${SUB}`), Buffer.from(params.salt, 'base64'), { N: params.N, r: 8, p: 1, dkLen: 32 });
    const nonce = new Uint8Array(24).fill(3);
    const box = xchacha20poly1305(hkdf(sha256, key, undefined, utf8ToBytes('beanpool-keeper-sso-words'), 32), nonce,
        utf8ToBytes('beanpool-keeper-sso-words-v1')).encrypt(packRecoveryWords(words));
    params.words = {
        alg: KEEPER_ALG_SSO_WORDS,
        iv: Buffer.from(nonce).toString('base64'),
        ct: Buffer.from(box.subarray(0, 17)).toString('base64'),
        tag: Buffer.from(box.subarray(17)).toString('base64'),
    };
    return { ...sealed, kdfParams: JSON.stringify(params) };
}

describe('a sign-in restore and the 12 words', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('saves the words when the copy carries them, and they make the restored key', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB, { words: WORDS }));

        const result = await restore();

        expect(result.identity.publicKey).toBe(PUB);
        expect(result.identity.mnemonic).toEqual(WORDS);
        expect(savedIdentity().publicKey).toBe(PUB);
        expect(savedIdentity().mnemonic).toEqual(WORDS);
    });

    it('restores the key alone from a copy without words, exactly as before', async () => {
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB));

        const result = await restore();

        expect(result.identity.publicKey).toBe(PUB);
        expect(result.identity).not.toHaveProperty('mnemonic');
        expect(savedIdentity()).not.toHaveProperty('mnemonic');
    });

    it('restores the key alone when the copy\'s words make another account, and does not log the words', async () => {
        mockSignInAndNode(await withWordsBox(await sealSeedToSso(SEED, 'google', SUB), OTHER_WORDS));
        const log = vi.spyOn(console, 'log');

        const result = await restore();

        expect(result.identity.publicKey).toBe(PUB);
        expect(result.identity).not.toHaveProperty('mnemonic');
        expect(savedIdentity()).not.toHaveProperty('mnemonic');
        const logged = log.mock.calls.flat().join('\n');
        expect(logged).toContain('make a different key');
        for (const w of OTHER_WORDS) expect(logged).not.toMatch(new RegExp(`\\b${w}\\b`));
        log.mockRestore();
    });

    it('restores the key alone when the words box is damaged', async () => {
        const sealed = await sealSeedToSso(SEED, 'google', SUB, { words: WORDS });
        const params = JSON.parse(sealed.kdfParams);
        params.words.tag = Buffer.from(new Uint8Array(16)).toString('base64');
        mockSignInAndNode({ ...sealed, kdfParams: JSON.stringify(params) });

        const result = await restore();

        expect(result.identity.publicKey).toBe(PUB);
        expect(savedIdentity()).not.toHaveProperty('mnemonic');
    });

    it('checks the words against the restored key itself, not only the opener\'s say-so', async () => {
        // An opener that returned words it should not have: the app still refuses them.
        (openSeedFromSso as any).mockResolvedValueOnce({ seed: SEED, words: OTHER_WORDS, wordsStatus: 'carried' });
        mockSignInAndNode(await sealSeedToSso(SEED, 'google', SUB));
        const log = vi.spyOn(console, 'log');

        const result = await restore();

        expect(result.identity.publicKey).toBe(PUB);
        expect(savedIdentity()).not.toHaveProperty('mnemonic');
        expect(log.mock.calls.flat().join('\n')).toContain('do not make the restored key');
        log.mockRestore();
    });
});
