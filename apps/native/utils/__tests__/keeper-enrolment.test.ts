import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => 'https://test.beanpool.org') },
}));

vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///docs/',
    EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: vi.fn(async () => {}),
    deleteAsync: vi.fn(async () => {}),
}));

vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async () => ({ 'Content-Type': 'application/json' })),
    encodeBase64: (b: Uint8Array) => Buffer.from(b).toString('base64'),
    mnemonicToSeed: vi.fn(async () => new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)),
    hexToBytes: (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex')),
}));

vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://test.beanpool.org'),
    signedPost: vi.fn(),
    signedDelete: vi.fn(),
}));

import { ed25519 } from '@noble/curves/ed25519.js';
import {
    enrolKeepers, enrolSsoKeeper, disconnectSsoKeeper,
} from '../keeper-enrolment';
import { signedPost, signedDelete, anchorUrl } from '../node-post';
import { openShareFromSso, isSingleBlobSso, toEd25519Pkcs8 } from '@beanpool/core';

/**
 * Route the `signedPost` mock.
 */
function mockNode(opts: { deposit?: any } = {}) {
    const { deposit = { ok: true, json: async () => ({ generation: 2 }) } } = opts;
    (signedPost as any).mockImplementation(async (_url: string, _path: string) => {
        return deposit;
    });
}

/** The SSO share the client actually deposited. */
function depositedSsoShare(): any {
    const call = (signedPost as any).mock.calls.find((c: any[]) => c[1] === '/api/recovery/shares/sso');
    return call?.[2]?.shares?.find((sh: any) => sh.holderType === 'sso');
}

/** The sealed member half as the client built it, decoded back to bytes. */
function depositedSsoCiphertextLength(): number {
    const sso = depositedSsoShare();
    return Buffer.from(sso.encryptedShare, 'base64').length;
}

const IDENTITY = {
    callsign: 'Alice',
    publicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(9))).toString('hex'),
    privateKey: Buffer.from(new Uint8Array(32).fill(9)).toString('hex'),
    createdAt: '2026-08-14T00:00:00.000Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

const FRIEND_KEYS = [
    Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(1))).toString('hex'),
    Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(2))).toString('hex'),
    Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(3))).toString('hex'),
];

describe('keeper-enrolment.ts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (anchorUrl as any).mockResolvedValue('https://test.beanpool.org');
    });

    // ---------------------------------------------------------------------------
    // Signup — sovereign by default
    // ---------------------------------------------------------------------------
    describe('enrolKeepers at signup — sovereign', () => {
        it('returns sovereign (nothing enrolled) for every member at signup', async () => {
            const result = await enrolKeepers(IDENTITY);
            expect(result.enrolled).toEqual([]);
            expect(result.generation).toBeNull();
            expect(result.available).toBe(0);
            expect(result.error).toBeUndefined();
        });

        it('never throws — the never-throws contract is unchanged', async () => {
            await expect(enrolKeepers(IDENTITY)).resolves.toBeDefined();
            await expect(enrolKeepers({ ...IDENTITY, mnemonic: [] })).resolves.toBeDefined();
            await expect(enrolKeepers({ ...IDENTITY, mnemonic: undefined })).resolves.toBeDefined();
        });

        it('returns empty skipped array — nothing was attempted', async () => {
            const result = await enrolKeepers(IDENTITY);
            expect(result.skipped).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------------
    // SSO-tier enrolment
    // ---------------------------------------------------------------------------
    describe('enrolSsoKeeper', () => {
        it('rejects if identity has no mnemonic', async () => {
            const result = await enrolSsoKeeper({
                identity: { ...IDENTITY, mnemonic: undefined },
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });
            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('no recovery words');
        });

        it('successfully seals and deposits single-blob SSO share', async () => {
            mockNode();

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.enrolled).toEqual(['sso']);
            expect(result.generation).toBe(2);
            expect(result.available).toBe(1);
            expect(result.error).toBeUndefined();
            expect(signedPost).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/shares/sso',
                expect.objectContaining({
                    provider: 'google',
                    idToken: 'mock-jwt-token',
                    nonce: 'mock-nonce',
                    shares: [
                        expect.objectContaining({ holderType: 'sso', shareIndex: 1 }),
                    ],
                }),
                IDENTITY,
            );
        });

        it('handles network throw gracefully without throwing', async () => {
            (signedPost as any).mockRejectedValueOnce(new Error('Network connection timeout'));

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'apple',
                sub: 'apple-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('could not reach the node');
        });

        it('maps multiple enrolled SSO providers so spare counter does not desync', async () => {
            mockNode({
                deposit: {
                    ok: true,
                    json: async () => ({ generation: 3, enrolledSso: ['google', 'apple'], threshold: 1 }),
                },
            });

            const result = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'apple',
                sub: 'apple-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(result.enrolled).toEqual(['sso', 'sso']);
            expect(result.available).toBe(2);
            expect(result.enrolledSso).toEqual(['google', 'apple']);
            expect(result.threshold).toBe(1);
        });

        it('deposits single-blob SSO share with explicit single-blob algorithm in kdfParams', async () => {
            mockNode();

            await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            const sso = depositedSsoShare();
            expect(sso).toBeDefined();
            expect(isSingleBlobSso(sso.kdfParams)).toBe(true);
            expect(depositedSsoCiphertextLength()).toBeGreaterThan(0);
        });

        it('does not request a hub fragment or include a hub row in deposit', async () => {
            mockNode();

            await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            const call = (signedPost as any).mock.calls.find((c: any[]) => c[1] === '/api/recovery/shares/sso');
            expect(call[2].shares.length).toBe(1);
            expect(call[2].shares.some((sh: any) => sh.holderType === 'hub')).toBe(false);
        });

        it('deposited share can be decrypted back to the original seed', async () => {
            mockNode();

            await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            const sso = depositedSsoShare();
            const opened = await openShareFromSso(sso, 'google', 'google-sub-12345');
            expect(Array.from(opened)).toEqual(Array.from(new Uint8Array(32).fill(9)));
        });

        it('enrols with a 48-byte PKCS8 key (PWA-origin) and produces the same decrypted seed as the equivalent 32-byte seed', async () => {
            mockNode();

            // 1. Enrol with 32-byte seed identity
            const rawResult = await enrolSsoKeeper({
                identity: IDENTITY,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });
            const rawSso = depositedSsoShare();
            const rawOpened = await openShareFromSso(rawSso, 'google', 'google-sub-12345');

            // 2. Enrol with 48-byte PKCS8 identity
            vi.clearAllMocks();
            mockNode();

            const pkcs8Bytes = toEd25519Pkcs8(Buffer.from(IDENTITY.privateKey, 'hex'));
            expect(pkcs8Bytes.length).toBe(48);
            const pwaIdentity = {
                ...IDENTITY,
                privateKey: Buffer.from(pkcs8Bytes).toString('hex'),
            };
            expect(pwaIdentity.privateKey.length).toBe(96); // 48 hex bytes

            const pkcs8Result = await enrolSsoKeeper({
                identity: pwaIdentity,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });

            expect(pkcs8Result.error).toBeUndefined();
            expect(pkcs8Result.enrolled).toEqual(rawResult.enrolled);
            expect(pkcs8Result.generation).toEqual(rawResult.generation);
            expect(pkcs8Result.available).toEqual(rawResult.available);

            const pkcs8Sso = depositedSsoShare();
            const pkcs8Opened = await openShareFromSso(pkcs8Sso, 'google', 'google-sub-12345');
            expect(Array.from(pkcs8Opened)).toEqual(Array.from(rawOpened));
        });

        it('rejects an invalid private key with a clear error', async () => {
            const invalidIdentity = {
                ...IDENTITY,
                privateKey: '12345678', // 4 bytes
            };
            const result = await enrolSsoKeeper({
                identity: invalidIdentity,
                provider: 'google',
                sub: 'google-sub-12345',
                idToken: 'mock-jwt-token',
                nonce: 'mock-nonce',
            });
            expect(result.enrolled).toEqual([]);
            expect(result.error).toContain('could not read the private key');
        });
    });

    // ---------------------------------------------------------------------------
    // Disconnect
    // ---------------------------------------------------------------------------
    describe('disconnectSsoKeeper', () => {
        it('uses DELETE, which is the verb the route is registered under and the one signed', async () => {
            (signedDelete as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ enrolledSso: ['google'] }),
            });

            const result = await disconnectSsoKeeper('apple', IDENTITY);

            expect(result.success).toBe(true);
            expect(result.enrolledSso).toEqual(['google']);
            expect(signedDelete).toHaveBeenCalledWith(
                'https://test.beanpool.org',
                '/api/recovery/shares/sso/apple',
                IDENTITY,
            );
            // A signed POST here 404s: koa-router has no POST at that path.
            expect(signedPost).not.toHaveBeenCalled();
        });

        it('surfaces the node refusing a disconnect that would strand the account', async () => {
            (signedDelete as any).mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: async () => 'would leave this account unrecoverable',
            });

            const result = await disconnectSsoKeeper('google', IDENTITY);

            expect(result.success).toBe(false);
            expect(result.error).toContain('unrecoverable');
        });
    });
});
