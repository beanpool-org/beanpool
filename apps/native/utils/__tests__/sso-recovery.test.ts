import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    splitHubAndWhole,
    sealShareToSso,
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
    signInWithGithub: vi.fn(),
}));

vi.mock('../node-post', () => ({
    signedPost: vi.fn(),
}));

import { signedPost } from '../node-post';
import { signInWithGoogle, signInWithGithub } from '../sso-signin';
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
            'releasing-hub',
            'fetching-fragments',
            'reconstructing',
            'done',
        ]);
    });

    it('successfully recovers account using GitHub OAuth (with direct sub)', async () => {
        const originalSeed = new Uint8Array(32).fill(42);
        const originalKeypair = await seedToKeypair(originalSeed);
        const memberCallsign = 'test-github-pilot';

        const { hubShare, otherHalf } = await splitHubAndWhole(originalSeed);
        const githubSub = '987654321';
        const ssoSealed = await sealShareToSso(otherHalf, 'github', githubSub);
        const hubRecorded = recordShareForHub(hubShare);

        (signInWithGithub as any).mockResolvedValue({
            idToken: 'gho_oauth_token_xyz',
            nonce: 'github-eph-nonce-456',
            sub: githubSub,
            email: 'damo@github.com',
        });

        (signedPost as any).mockImplementation(async (_url: string, path: string, body: any) => {
            if (path === '/api/recovery/collect') {
                return { ok: true, status: 200, json: async () => ({ collectionId: 'coll-gh-1' }) };
            }
            if (path === '/api/recovery/collect/sso-nonce') {
                return { ok: true, status: 200, json: async () => ({ nonce: 'github-eph-nonce-456' }) };
            }
            if (path === '/api/recovery/collect/sso') {
                expect(body.idToken).toBe('gho_oauth_token_xyz');
                expect(body.provider).toBe('github');
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
            provider: 'github',
        });

        expect(result.identity.publicKey).toEqual(originalKeypair.publicKeyHex);
        expect(result.identity.privateKey).toEqual(originalKeypair.privateKeyHex);
        expect(result.identity.callsign).toEqual(memberCallsign);
        expect(result.provider).toBe('github');
    });
});
