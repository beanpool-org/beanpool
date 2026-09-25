import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => 'https://test.beanpool.org') },
}));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///docs/' }));
vi.mock('../crypto', () => ({
    hexToBytes: (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex')),
}));
vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://test.beanpool.org'),
    signedPost: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ generation: 1 }) })),
    signedDelete: vi.fn(),
}));
// The words are read through the identity module (getMnemonic), which imports these at load.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));

import { enrolSsoKeeper, sealSsoShares } from '../keeper-enrolment';
import { signedPost } from '../node-post';
import {
    SSO_SHARE_VECTORS,
    SSO_SHARE_VECTOR_PUBLIC_KEY,
    SSO_SHARE_VECTOR_SEED_HEX,
    SSO_SHARE_VECTOR_WORDS,
    seededGetRandomValues,
    type SsoShareVector,
} from '@beanpool/core/sso-share-vectors';

/**
 * The frozen sign-in recovery copies (@beanpool/core/sso-share-vectors), from the phone's side: with the random
 * stream fixed, the phone builds exactly these shares, for the join to the global community (sealSsoShares, which
 * utils/global-join.ts sends as `recovery: { shares }`) and for a deposit (enrolSsoKeeper). The PWA's suite holds
 * the browser to the same list, so a browser member's copy is the phone's copy, byte for byte.
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

describe('sign-in recovery copy vectors (native)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each(SSO_SHARE_VECTORS.map((v) => [v.name, v] as const))('%s: the join carries these shares', async (_name, v) => {
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(seededGetRandomValues(v.name) as never);
        const sealed = await sealSsoShares(phoneIdentity(v), v.provider, v.sub);
        expect(sealed.shares).toEqual(v.shares);
        expect(JSON.stringify(sealed.shares)).toBe(JSON.stringify(v.shares));
        expect(sealed.wordsSealed).toBe(v.withWords);
    });

    it.each(SSO_SHARE_VECTORS.map((v) => [v.name, v] as const))('%s: a deposit carries the same shares', async (_name, v) => {
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(seededGetRandomValues(v.name) as never);
        const credential = v.provider === 'github'
            ? { provider: 'github' as const, proof: { sessionId: 'node-session' } }
            : { provider: v.provider, idToken: 'fixture.jwt.token', nonce: 'fixture-nonce' };
        const result = await enrolSsoKeeper({ identity: phoneIdentity(v), sub: v.sub, ...credential } as any);
        expect(result.error).toBeUndefined();
        const [, path, body] = (signedPost as any).mock.calls[0];
        expect(path).toBe('/api/recovery/shares/sso');
        expect(body.shares).toEqual(v.shares);
    });
});
