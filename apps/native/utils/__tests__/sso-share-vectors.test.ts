import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///docs/' }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
// The words are read through the identity module (getMnemonic), which imports these at load.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));

import { enrolSsoKeeper, sealSsoShares } from '../keeper-enrolment';
import { isSsoProvider, type SsoProvider } from '../sso-providers';
import { vaultTicket } from '../vault';
import {
    SSO_SHARE_VECTORS,
    SSO_SHARE_VECTOR_PUBLIC_KEY,
    SSO_SHARE_VECTOR_SEED_HEX,
    SSO_SHARE_VECTOR_WORDS,
    seededGetRandomValues,
    type SsoShareVector,
} from '@beanpool/core/sso-share-vectors';
import { fakeJwt, installNetwork, noVault, useVault, VAULT, type Network } from './fake-vault';

/**
 * The frozen sign-in recovery copies (@beanpool/core/sso-share-vectors), from the phone's side: with the random
 * stream fixed, the phone builds exactly these shares ({@link sealSsoShares}), and the copy a deposit gives BeanPool's
 * key vault is that share, byte for byte (V4: the global door's join no longer carries one; its one sign-in deposits
 * at the vault too, through the same sealing). The PWA's suite holds the browser to the same list, so a browser
 * member's copy is the phone's copy, byte for byte.
 */
function phoneIdentity(v: SsoShareVector) {
    // The phone keeps the raw 32-byte seed.
    return {
        callsign: 'Vector',
        publicKey: SSO_SHARE_VECTOR_PUBLIC_KEY,
        privateKey: SSO_SHARE_VECTOR_SEED_HEX,
        createdAt: '2026-09-26T00:00:00.000Z',
        ...(v.withWords ? { mnemonic: [...SSO_SHARE_VECTOR_WORDS] } : {}),
    } as any;
}

/** The vectors for the sign-ins this app offers (utils/sso-providers.ts): the phone builds copies for those alone. */
const PHONE_VECTORS = SSO_SHARE_VECTORS.filter(
    (v): v is SsoShareVector & { provider: SsoProvider } => isSsoProvider(v.provider),
);

let net: Network;
const originalFetch = globalThis.fetch;

describe('sign-in recovery copy vectors (native)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mem.async.clear();
        mem.secure.clear();
        useVault();
        net = installNetwork();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        globalThis.fetch = originalFetch;
        noVault();
    });

    it('has a vector for a sign-in this app offers', () => {
        expect(PHONE_VECTORS.length).toBeGreaterThan(0);
    });

    it.each(PHONE_VECTORS.map((v) => [v.name, v] as const))('%s: the phone seals these shares', async (_name, v) => {
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(seededGetRandomValues(v.name) as never);
        const sealed = await sealSsoShares(phoneIdentity(v), v.provider, v.sub);
        expect(sealed.shares).toEqual(v.shares);
        expect(JSON.stringify(sealed.shares)).toBe(JSON.stringify(v.shares));
        expect(sealed.wordsSealed).toBe(v.withWords);
    });

    it.each(PHONE_VECTORS.map((v) => [v.name, v] as const))('%s: a deposit gives the key vault the same copy', async (_name, v) => {
        const identity = phoneIdentity(v);
        const { ticket, nonce } = await vaultTicket(identity, 'deposit', v.provider);
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(seededGetRandomValues(v.name) as never);
        const result = await enrolSsoKeeper({ identity, sub: v.sub, provider: v.provider, ticket, idToken: fakeJwt({ sub: v.sub, nonce }) });
        expect(result.error).toBeUndefined();
        expect(net.sent.filter(s => s.path === '/v1/copies').map(s => s.origin)).toEqual([VAULT]);
        // What the vault opened from the box: the vector's share, without the holder fields a community row had.
        const [copy] = net.vault.copiesOf(SSO_SHARE_VECTOR_PUBLIC_KEY);
        const { encryptedShare, shareIv, shareTag, kdfParams } = v.shares[0] as any;
        expect(copy.clientCopy).toEqual({ encryptedShare, shareIv, shareTag, kdfParams });
    });
});
