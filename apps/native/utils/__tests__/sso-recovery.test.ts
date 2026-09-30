/**
 * "Recover with Social" (utils/sso-recovery.ts), since V4: BeanPool's key vault finds the copy from the sign-in, so
 * the member types no name and no community address, and the phone asks no community anything until the account is
 * back. Every restore waits (D2) until the vault releases it; the account is then saved onto the community the member
 * chooses, global by default.
 *
 * Before V4 this suite held the community restore: a callsign and an address typed first, a collection opened at that
 * community, and the old two-layer copies (a hub fragment combined with the sign-in's half). Those tests went with
 * that path: the vault keeps only single-blob copies (core vault-wire.ts `isVaultClientCopy`), so no phone combines a
 * hub fragment any more; a member whose only copy is an old one at a community gets back in with the 12 words, or moves
 * it with the move card while they still have their phone. What they held that still applies is held here: the address
 * the account is saved onto must be plain before anything is written, and the copy opens only with the sub the
 * sign-in's token names.
 *
 * Nothing here contacts a node, a vault or a provider: fake-vault.ts plays the vault with core's real tickets and
 * releases, and the providers' sheets are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sealSeedToSso } from '@beanpool/core';

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
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../sso-signin', () => ({
    signInWithProvider: vi.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { signInWithProvider } from '../sso-signin';
import { checkSsoRestore, finishSsoRestore, startSsoRestore } from '../sso-recovery';
import { loadIdentity } from '../identity';
import { seedToKeypair } from '../crypto';
import { fakeJwt, HOLD_MS, installNetwork, noVault, useVault, VAULT, type Network } from './fake-vault';

let net: Network;
const originalFetch = globalThis.fetch;

/** The provider's sheet: a token for `sub`, carrying the nonce it was given (the vault ticket's hash). */
function signsInAs(sub: string, extra: Record<string, unknown> = {}) {
    vi.mocked(signInWithProvider).mockImplementation(async (provider, nonce) => ({
        provider, idToken: fakeJwt({ sub, nonce, ...extra }), nonce,
    }));
}

/** The copy is released: after the day's wait (D2). */
async function afterTheWait() {
    vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
    try {
        const collected = await checkSsoRestore();
        if (collected?.status !== 'released') throw new Error(`expected a release, got ${JSON.stringify(collected)}`);
        return collected.restored;
    } finally {
        vi.useRealTimers();
    }
}

describe('SSO Recovery Service', () => {
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

    it('asks for no name and no community address: the sign-in finds the copy, and only the vault is asked', async () => {
        const seed = new Uint8Array(32).fill(42);
        const keypair = await seedToKeypair(seed);
        net.vault.keep('google', '110169484474386276334', keypair.publicKeyHex, await sealSeedToSso(seed, 'google', '110169484474386276334'));
        signsInAs('110169484474386276334');

        // startSsoRestore takes the provider and nothing else: there is no field for a name or an address.
        expect(startSsoRestore.length).toBe(1);
        await startSsoRestore('google');

        expect(net.sent.map((s) => `${s.origin}${s.path}`)).toEqual([`${VAULT}/v1/ticket`, `${VAULT}/v1/restore`]);
        const restore = net.sent[1].body;
        expect(Object.keys(restore).sort()).toEqual(['challenge', 'idToken', 'provider', 'ticket']);
        expect(JSON.stringify(net.sent)).not.toMatch(/callsign|anchor/);
    });

    it('refuses a community address that isn\'t plain host[:port] before anything is written (#1224 review 4113495290)', async () => {
        const seed = new Uint8Array(32).fill(42);
        const keypair = await seedToKeypair(seed);
        net.vault.keep('google', 's-1', keypair.publicKeyHex, await sealSeedToSso(seed, 'google', 's-1'));
        signsInAs('s-1');
        await startSsoRestore('google');
        const restored = await afterTheWait();

        for (const anchorUrl of ['https://test.beanpool.org\\@evil.test', 'https://127.0.0.1\\@evil.test', 'https://kim@test.beanpool.org', 'https://test.beanpool.org:123456']) {
            await expect(finishSsoRestore(restored, anchorUrl, { nameOnNode: async () => 'x' }), anchorUrl).rejects.toThrow();
        }
        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith('beanpool_anchor_url', expect.anything());
        expect(await loadIdentity()).toBeNull();
    });

    it('completes the single-blob Google recovery round-trip, onto the community chosen, with the name it holds', async () => {
        const originalSeed = new Uint8Array(32).fill(42);
        const originalKeypair = await seedToKeypair(originalSeed);
        const googleSub = '110169484474386276334';
        net.vault.keep('google', googleSub, originalKeypair.publicKeyHex, await sealSeedToSso(originalSeed, 'google', googleSub));
        signsInAs(googleSub);

        const held = await startSsoRestore('google');
        expect(held).toMatchObject({ provider: 'google', sub: googleSub, holdId: expect.any(String) });
        // Held, not released: every restore waits (D2).
        expect(await checkSsoRestore()).toMatchObject({ status: 'held' });

        const restored = await afterTheWait();
        const nameOnNode = vi.fn(async () => 'test-google-pilot');
        const identity = await finishSsoRestore(restored, 'https://global.beanpool.org', { nameOnNode });

        expect(identity.publicKey).toEqual(originalKeypair.publicKeyHex);
        expect(identity.privateKey).toEqual(originalKeypair.privateKeyHex);
        expect(identity.callsign).toBe('test-google-pilot');
        // With the restored key's private half, to sign the question: a community names a key only to its own signer.
        expect(nameOnNode).toHaveBeenCalledWith(originalKeypair.publicKeyHex, originalKeypair.privateKeyHex);
        expect(mem.async.get('beanpool_anchor_url')).toBe('https://global.beanpool.org');
        expect((await loadIdentity())?.publicKey).toBe(originalKeypair.publicKeyHex);
    });

    it('recovers with Apple: the restore carries Apple\'s token and the ticket, and the copy opens with the sub the token names', async () => {
        const originalSeed = new Uint8Array(32).fill(42);
        const originalKeypair = await seedToKeypair(originalSeed);
        const appleSub = '001234.0a1b2c3d4e5f60718293a4b5c6d7e8f9.0123';
        net.vault.keep('apple', appleSub, originalKeypair.publicKeyHex, await sealSeedToSso(originalSeed, 'apple', appleSub));
        signsInAs(appleSub, { iss: 'https://appleid.apple.com' });

        await startSsoRestore('apple');
        const restore = net.sent.find((s) => s.path === '/v1/restore')!.body;
        const ticket = net.sent.find((s) => s.path === '/v1/ticket')!;
        expect(ticket.body).toEqual({ purpose: 'restore', provider: 'apple', challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
        expect(vi.mocked(signInWithProvider).mock.calls[0][0]).toBe('apple');
        expect(restore).toMatchObject({ provider: 'apple', idToken: expect.any(String), ticket: expect.any(String) });

        const restored = await afterTheWait();
        expect(restored).toMatchObject({ provider: 'apple', publicKey: originalKeypair.publicKeyHex, privateKey: originalKeypair.privateKeyHex });
    });

    it('the copy opens only with the sub the sign-in named: another account\'s copy for this key opens to nothing, and nothing is saved', async () => {
        const seed = new Uint8Array(32).fill(42);
        const keypair = await seedToKeypair(seed);
        // The vault's row for this sign-in holds a copy sealed to some other subject.
        net.vault.keep('google', 'the-signed-in-sub', keypair.publicKeyHex, await sealSeedToSso(seed, 'google', 'someone-else'));
        signsInAs('the-signed-in-sub');

        await startSsoRestore('google');
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        await expect(checkSsoRestore()).rejects.toMatchObject({ reason: 'wrong_account' });
        expect(await loadIdentity()).toBeNull();
    });

    it('a vault restore never combines a hub fragment: the vault keeps only single-blob copies', () => {
        const vault = fs.readFileSync(path.resolve(__dirname, '../vault.ts'), 'utf-8');
        expect(vault).not.toMatch(/combineHubAndWhole|readHubShare|\/api\/recovery\/collect/);
        // In sso-recovery.ts the old two-layer path is only the community restore, `recoverAccountWithSso`, which the
        // welcome screen offers in a build without a vault (the release gate) and, in a build with one, only for a sign-in
        // the vault said, signed, that it keeps no copy for (PR #1336 review finding 3; vault-phone-gates.test.ts).
        // Everything after it is the vault's.
        const src = fs.readFileSync(path.resolve(__dirname, '../sso-recovery.ts'), 'utf-8');
        const vaultHalf = src.slice(src.indexOf('export async function startSsoRestore('));
        expect(vaultHalf.length).toBeGreaterThan(0);
        expect(vaultHalf).not.toMatch(/combineHubAndWhole|readHubShare|\/api\/recovery\/collect|signedPost/);
        const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');
        expect(welcome.match(/recoverAccountWithSso\(/g)).toHaveLength(1);
        expect(welcome.match(/handleSsoRecoverAtCommunity\(/g)?.length).toBe(4);
        expect(welcome).toMatch(/if \(mode === 'ssoRecover' && \(!hasVault\(\) \|\| ssoAtCommunity\)\) \{/);
    });
});
