import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    splitHubAndWhole,
    sealShareToSso,
    sealSeedToSso,
    recordShareForHub,
} from '@beanpool/core';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

const mockRandomBytes = new Uint8Array(32).fill(7);
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));

vi.mock('../sso-signin', () => ({
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
    signInWithFacebook: vi.fn(),
}));

vi.mock('../node-post', () => ({
    signedPost: vi.fn(),
}));

import { signedPost } from '../node-post';
import { signInWithGoogle, signInWithApple } from '../sso-signin';
import { recoverAccountWithSso } from '../sso-recovery';
import { seedToKeypair } from '../crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

describe('SSO Recovery Service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects an empty callsign', async () => {
        await expect(recoverAccountWithSso({
            callsign: '',
            anchorUrl: 'https://test.beanpool.org',
            provider: 'google',
        })).rejects.toThrow(/callsign/i);
    });

    it('rejects an empty or invalid node address', async () => {
        await expect(recoverAccountWithSso({
            callsign: 'Monnunit',
            anchorUrl: '',
            provider: 'google',
        })).rejects.toThrow(/node address/i);
    });

    it('refuses an address that isn\'t plain host[:port] before any sign-in (#1224 review 4113495290)', async () => {
        for (const anchorUrl of ['https://test.beanpool.org\\@evil.test', 'https://127.0.0.1\\@evil.test', 'https://kim@test.beanpool.org', 'https://test.beanpool.org:123456']) {
            await expect(recoverAccountWithSso({
                callsign: 'Monnunit',
                anchorUrl,
                provider: 'google',
            }), anchorUrl).rejects.toThrow(/node address/i);
        }
        expect(signInWithGoogle).not.toHaveBeenCalled();
        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith('beanpool_anchor_url', expect.anything());
    });

    it('completes the full Google recovery round-trip', async () => {
        // 1. Original account setup
        const originalSeed = new Uint8Array(32).fill(42);
        const originalKeypair = await seedToKeypair(originalSeed);
        const memberCallsign = 'Monnunit';
        const googleSub = '110169484474386276334';

        const { hubShare, otherHalf } = await splitHubAndWhole(originalSeed);
        const ssoSealed = await sealShareToSso(otherHalf, 'google', googleSub);
        const hubRecorded = recordShareForHub(hubShare);

        // Construct fake Google ID token with sub
        const b64 = (s: string) => Buffer.from(s).toString('base64url');
        const tokenHeader = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const tokenPayload = b64(JSON.stringify({
            iss: 'https://accounts.google.com',
            sub: googleSub,
            email: 'monnunit@gmail.com',
        }));
        const fakeIdToken = `${tokenHeader}.${tokenPayload}.fake_signature`;

        // 2. Mock Google Sign-In
        (signInWithGoogle as any).mockResolvedValue({
            idToken: fakeIdToken,
            nonce: 'node-issued-nonce-123',
            email: 'monnunit@gmail.com',
        });

        // 3. Mock Node signedPost responses
        (signedPost as any).mockImplementation(async (_url: string, path: string) => {
            if (path === '/api/recovery/collect') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ collectionId: 'coll_test_123', generation: 1, threshold: 2 }),
                };
            }
            if (path === '/api/recovery/collect/sso-nonce') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ nonce: 'node-issued-nonce-123', expiresInSeconds: 600 }),
                };
            }
            if (path === '/api/recovery/collect/sso') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ collected: 1, threshold: 2, enough: false }),
                };
            }
            if (path === '/api/recovery/collect/hub') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ collected: 2, threshold: 2, enough: true, hubReason: 'sso-approved' }),
                };
            }
            if (path === '/api/recovery/collect/fragments') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        collected: 2,
                        threshold: 2,
                        enough: true,
                        fragments: [
                            {
                                holderType: 'sso',
                                shareIndex: 2,
                                payload: ssoSealed.encryptedShare,
                                payloadIv: ssoSealed.shareIv,
                                payloadTag: ssoSealed.shareTag,
                                kdfParams: ssoSealed.kdfParams,
                            },
                            {
                                holderType: 'hub',
                                shareIndex: 1,
                                payload: hubRecorded.encryptedShare,
                                payloadIv: hubRecorded.shareIv,
                                payloadTag: hubRecorded.shareTag,
                                kdfParams: hubRecorded.kdfParams,
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected path: ${path}`);
        });

        const progressSteps: string[] = [];
        const result = await recoverAccountWithSso({
            callsign: memberCallsign,
            anchorUrl: 'https://test.beanpool.org',
            provider: 'google',
            onProgress: (p) => progressSteps.push(p.step),
        });

        expect(result.identity.publicKey).toEqual(originalKeypair.publicKeyHex);
        expect(result.identity.privateKey).toEqual(originalKeypair.privateKeyHex);
        expect(result.identity.callsign).toEqual(memberCallsign);

        expect(AsyncStorage.setItem).toHaveBeenCalledWith('beanpool_anchor_url', 'https://test.beanpool.org');
        expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
            'sovereign-identity',
            expect.stringContaining(originalKeypair.publicKeyHex),
        );

        expect(progressSteps).toEqual([
            'opening',
            'nonce',
            'signing-in',
            'releasing-sso',
            'fetching-fragments',
            'releasing-hub',
            'reconstructing',
            'done',
        ]);
    });

    it('completes the single-blob Google recovery round-trip without hub release', async () => {
        const originalSeed = new Uint8Array(32).fill(42);
        const originalKeypair = await seedToKeypair(originalSeed);
        const memberCallsign = 'Monnunit-single';
        const googleSub = '110169484474386276334';

        const ssoSealed = await sealSeedToSso(originalSeed, 'google', googleSub);

        const b64 = (s: string) => Buffer.from(s).toString('base64url');
        const tokenHeader = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const tokenPayload = b64(JSON.stringify({
            iss: 'https://accounts.google.com',
            sub: googleSub,
            email: 'monnunit@gmail.com',
        }));
        const fakeIdToken = `${tokenHeader}.${tokenPayload}.fake_signature`;

        (signInWithGoogle as any).mockResolvedValue({
            idToken: fakeIdToken,
            nonce: 'node-issued-nonce-single',
            email: 'monnunit@gmail.com',
        });

        (signedPost as any).mockImplementation(async (_url: string, path: string) => {
            if (path === '/api/recovery/collect') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ collectionId: 'coll_test_single', generation: 1, threshold: 1 }),
                };
            }
            if (path === '/api/recovery/collect/sso-nonce') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ nonce: 'node-issued-nonce-single', expiresInSeconds: 600 }),
                };
            }
            if (path === '/api/recovery/collect/sso') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ collected: 1, threshold: 1, enough: true }),
                };
            }
            if (path === '/api/recovery/collect/hub') {
                throw new Error('Hub should not be called for single-blob SSO');
            }
            if (path === '/api/recovery/collect/fragments') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        collected: 1,
                        threshold: 1,
                        enough: true,
                        fragments: [
                            {
                                holderType: 'sso',
                                shareIndex: 1,
                                payload: ssoSealed.encryptedShare,
                                payloadIv: ssoSealed.shareIv,
                                payloadTag: ssoSealed.shareTag,
                                kdfParams: ssoSealed.kdfParams,
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected path: ${path}`);
        });

        const progressSteps: string[] = [];
        const result = await recoverAccountWithSso({
            callsign: memberCallsign,
            anchorUrl: 'https://test.beanpool.org',
            provider: 'google',
            onProgress: (p) => progressSteps.push(p.step),
        });

        expect(result.identity.publicKey).toEqual(originalKeypair.publicKeyHex);
        expect(result.identity.privateKey).toEqual(originalKeypair.privateKeyHex);
        expect(result.identity.callsign).toEqual(memberCallsign);
        expect(progressSteps).toEqual([
            'opening',
            'nonce',
            'signing-in',
            'releasing-sso',
            'fetching-fragments',
            'reconstructing',
            'done',
        ]);
    });

    it('recovers with Apple: the release carries Apple\'s token and the nonce, and the piece opens with the sub the token names', async () => {
        const originalSeed = new Uint8Array(32).fill(42);
        const originalKeypair = await seedToKeypair(originalSeed);
        const memberCallsign = 'test-apple-pilot';

        const { hubShare, otherHalf } = await splitHubAndWhole(originalSeed);
        const appleSub = '001234.0a1b2c3d4e5f60718293a4b5c6d7e8f9.0123';
        const ssoSealed = await sealShareToSso(otherHalf, 'apple', appleSub);
        const hubRecorded = recordShareForHub(hubShare);

        const b64 = (s: string) => Buffer.from(s).toString('base64url');
        const appleToken = `${b64(JSON.stringify({ alg: 'RS256', kid: 'apple-kid' }))}.${b64(JSON.stringify({
            iss: 'https://appleid.apple.com', sub: appleSub, nonce: 'apple-eph-nonce-456',
        }))}.fake_signature`;
        (signInWithApple as any).mockResolvedValue({ idToken: appleToken, nonce: 'apple-eph-nonce-456' });

        let released: any;
        (signedPost as any).mockImplementation(async (_url: string, path: string, body: any) => {
            if (path === '/api/recovery/collect') {
                return { ok: true, status: 200, json: async () => ({ collectionId: 'coll-apple-1' }) };
            }
            if (path === '/api/recovery/collect/sso-nonce') {
                return { ok: true, status: 200, json: async () => ({ nonce: 'apple-eph-nonce-456' }) };
            }
            if (path === '/api/recovery/collect/sso') {
                released = body;
                return { ok: true, status: 200, json: async () => ({ status: 'sso_verified' }) };
            }
            if (path === '/api/recovery/collect/hub') {
                return { ok: true, status: 200, json: async () => ({ status: 'hub_released' }) };
            }
            if (path === '/api/recovery/collect/fragments') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        collected: 2,
                        threshold: 2,
                        enough: true,
                        fragments: [
                            {
                                holderType: 'sso',
                                shareIndex: 2,
                                payload: ssoSealed.encryptedShare,
                                payloadIv: ssoSealed.shareIv,
                                payloadTag: ssoSealed.shareTag,
                                kdfParams: ssoSealed.kdfParams,
                            },
                            {
                                holderType: 'hub',
                                shareIndex: 1,
                                payload: hubRecorded.encryptedShare,
                                payloadIv: hubRecorded.shareIv,
                                payloadTag: hubRecorded.shareTag,
                                kdfParams: hubRecorded.kdfParams,
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected path: ${path}`);
        });

        const result = await recoverAccountWithSso({
            callsign: memberCallsign,
            anchorUrl: 'https://test.beanpool.org',
            provider: 'apple',
        });

        expect(result.identity.publicKey).toEqual(originalKeypair.publicKeyHex);
        expect(result.identity.privateKey).toEqual(originalKeypair.privateKeyHex);
        expect(result.identity.callsign).toEqual(memberCallsign);
        expect(result.provider).toBe('apple');
        // Apple's sheet was handed the node's nonce, bound to this recovering device's ephemeral key.
        expect(signInWithApple).toHaveBeenCalledWith('apple-eph-nonce-456');
        expect(signInWithGoogle).not.toHaveBeenCalled();
        // The release proves the sign-in with the provider's token and the nonce inside it, and nothing else.
        expect(released).toEqual({
            collectionId: 'coll-apple-1', provider: 'apple', idToken: appleToken, nonce: 'apple-eph-nonce-456',
        });
    });

    it('survives a malformed checksum (not 4 bytes) in kdfParams during legacy recovery', async () => {
        const originalSeed = new Uint8Array(32).fill(77);
        const originalKeypair = await seedToKeypair(originalSeed);
        const memberCallsign = 'MalformedCheck';
        const googleSub = '110169484474386276334';

        const { hubShare, otherHalf } = await splitHubAndWhole(originalSeed);
        const ssoSealed = await sealShareToSso(otherHalf, 'google', googleSub);
        const hubRecorded = recordShareForHub(hubShare);

        // Inject malformed checksum (8 bytes base64 encoded)
        const parsedKdf = JSON.parse(ssoSealed.kdfParams);
        parsedKdf.checksum = Buffer.from('12345678').toString('base64');
        const ssoKdfWithMalformedChecksum = JSON.stringify(parsedKdf);

        const b64 = (s: string) => Buffer.from(s).toString('base64url');
        const tokenHeader = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const tokenPayload = b64(JSON.stringify({
            iss: 'https://accounts.google.com',
            sub: googleSub,
            email: 'malformed@gmail.com',
        }));
        const fakeIdToken = `${tokenHeader}.${tokenPayload}.fake_sig`;

        (signInWithGoogle as any).mockResolvedValue({
            idToken: fakeIdToken,
            nonce: 'nonce-malformed',
            email: 'malformed@gmail.com',
        });

        (signedPost as any).mockImplementation(async (_url: string, path: string) => {
            if (path === '/api/recovery/collect') {
                return { ok: true, status: 200, json: async () => ({ collectionId: 'coll-malformed' }) };
            }
            if (path === '/api/recovery/collect/sso-nonce') {
                return { ok: true, status: 200, json: async () => ({ nonce: 'nonce-malformed' }) };
            }
            if (path === '/api/recovery/collect/sso') {
                return { ok: true, status: 200, json: async () => ({ enough: false, collected: 1 }) };
            }
            if (path === '/api/recovery/collect/hub') {
                return { ok: true, status: 200, json: async () => ({ enough: true, collected: 2 }) };
            }
            if (path === '/api/recovery/collect/fragments') {
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        fragments: [
                            {
                                holderType: 'sso',
                                shareIndex: 2,
                                payload: ssoSealed.encryptedShare,
                                payloadIv: ssoSealed.shareIv,
                                payloadTag: ssoSealed.shareTag,
                                kdfParams: ssoKdfWithMalformedChecksum,
                            },
                            {
                                holderType: 'hub',
                                shareIndex: 1,
                                payload: hubRecorded.encryptedShare,
                                payloadIv: hubRecorded.shareIv,
                                payloadTag: hubRecorded.shareTag,
                                kdfParams: hubRecorded.kdfParams,
                            },
                        ],
                    }),
                };
            }
            throw new Error(`Unexpected path: ${path}`);
        });

        const result = await recoverAccountWithSso({
            callsign: memberCallsign,
            anchorUrl: 'https://test.beanpool.org',
            provider: 'google',
        });

        expect(result.identity.publicKey).toEqual(originalKeypair.publicKeyHex);
        expect(result.identity.privateKey).toEqual(originalKeypair.privateKeyHex);
    });
});
