/**
 * A sign-in restore from a copy that carries the 12 words saves them, only when they make the restored key.
 * A copy without words (every copy made before copies carried them) restores exactly as before: the key alone.
 *
 * Since V4 the copy comes back from BeanPool's key vault (utils/vault.ts `openRelease`), sealed to the restoring
 * phone's throwaway key; fake-vault.ts plays the vault, with core's real releases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));
vi.mock('../sso-signin', () => ({
    signInWithProvider: vi.fn(),
}));
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
import { signInWithProvider } from '../sso-signin';
import { checkSsoRestore, finishSsoRestore, startSsoRestore } from '../sso-recovery';
import { fakeJwt, HOLD_MS, installNetwork, noVault, useVault, type Network } from './fake-vault';

// Test phrases only (BIP-39 vectors), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const OTHER_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const PUB = Buffer.from(ed25519.getPublicKey(SEED)).toString('hex');
const SUB = '110169484474386276334';

let net: Network;
const originalFetch = globalThis.fetch;

/** Google hands back a token whose `sub` is SUB; the vault keeps `sealed` for it, for PUB. */
function mockSignInAndNode(sealed: SealedShare) {
    vi.mocked(signInWithProvider).mockImplementation(async (provider, nonce) => ({ provider, idToken: fakeJwt({ sub: SUB, nonce }), nonce }));
    net.vault.keep('google', SUB, PUB, sealed);
}

/** A sign-in restore, start to finish: the sign-in, the day's wait, the release, and the save. */
async function restore() {
    await startSsoRestore('google');
    vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
    const collected = await checkSsoRestore();
    vi.useRealTimers();
    if (collected?.status !== 'released') throw new Error(`expected a release, got ${JSON.stringify(collected)}`);
    const identity = await finishSsoRestore(collected.restored, 'https://test.beanpool.org', { nameOnNode: async () => 'Marty' });
    return { identity };
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
        mem.async.clear();
        mem.secure.clear();
        useVault();
        net = installNetwork();
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        noVault();
        vi.useRealTimers();
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
