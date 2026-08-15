import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    splitTwoLayer,
    sealShareToMember,
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

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));

vi.mock('../node-post', () => ({
    signedPost: vi.fn(),
}));

import { signedPost } from '../node-post';
import {
    startFriendRecoverySession,
    pollFriendRecovery,
    completeFriendRecovery,
    getInboundApprovalContext,
    approveInboundRecovery,
} from '../friend-recovery';
import { seedToKeypair } from '../crypto';
import type { BeanPoolIdentity } from '../identity';

describe('Friend Recovery Service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects an empty callsign or node address', async () => {
        await expect(startFriendRecoverySession({
            callsign: '',
            anchorUrl: 'https://test.beanpool.org',
        })).rejects.toThrow(/callsign/i);

        await expect(startFriendRecoverySession({
            callsign: 'Alice',
            anchorUrl: '',
        })).rejects.toThrow(/node address/i);
    });

    it('completes the full friend recovery lifecycle (deposit -> collect -> approve -> reconstruct)', async () => {
        // 1. Original Alice setup
        const aliceSeed = new Uint8Array(32).fill(42);
        const aliceKeypair = await seedToKeypair(aliceSeed);
        const aliceCallsign = 'Alice';

        // 2. Friends Bob & Carol setup
        const bobSeed = new Uint8Array(32).fill(11);
        const bobKeypair = await seedToKeypair(bobSeed);
        const bobIdentity: BeanPoolIdentity = {
            publicKey: bobKeypair.publicKeyHex,
            privateKey: bobKeypair.privateKeyHex,
            callsign: 'Bob',
            createdAt: new Date().toISOString(),
        };

        const carolSeed = new Uint8Array(32).fill(22);
        const carolKeypair = await seedToKeypair(carolSeed);
        const carolIdentity: BeanPoolIdentity = {
            publicKey: carolKeypair.publicKeyHex,
            privateKey: carolKeypair.privateKeyHex,
            callsign: 'Carol',
            createdAt: new Date().toISOString(),
        };

        // 3. Alice splits seed: 2-of-2 Shamir over Bob & Carol
        const split = await splitTwoLayer(aliceSeed, 2);
        const hubRecorded = recordShareForHub(split.hubShare);
        const bobSealed = sealShareToMember(split.friendShares[0], bobKeypair.publicKeyHex);
        const carolSealed = sealShareToMember(split.friendShares[1], carolKeypair.publicKeyHex);

        const collectionId = 'test-collection-123';

        // Mock start session
        (signedPost as any).mockImplementation(async (_url: string, path: string, body: any) => {
            if (path === '/api/recovery/collect') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ collectionId, threshold: 3, generation: 1 }),
                };
            }
            if (path === '/api/recovery/collect/status') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        collected: 3,
                        threshold: 3,
                        enough: true,
                        releasedTypes: ['hub', 'member', 'member'],
                    }),
                };
            }
            if (path === '/api/recovery/approve-keeper/context') {
                const isBob = body.collectionId === collectionId;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        callsign: 'Alice',
                        live: true,
                        fragment: isBob ? bobSealed : carolSealed,
                        recipientEphemeralPubkey: 'ephemeral-device-pubkey',
                    }),
                };
            }
            if (path === '/api/recovery/approve-keeper') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ released: 'member' }),
                };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });

        // 4. Start recovery session
        const session = await startFriendRecoverySession({
            callsign: aliceCallsign,
            anchorUrl: 'https://test.beanpool.org',
        });
        expect(session.collectionId).toBe(collectionId);
        expect(session.ephIdentity.publicKey).toBeTruthy();

        // 5. Check status
        const progress = await pollFriendRecovery(
            session.finalAnchorUrl,
            session.collectionId,
            session.ephIdentity,
        );
        expect(progress.enough).toBe(true);
        expect(progress.hubAvailable).toBe(true);

        // 6. Bob approves
        const bobContext = await getInboundApprovalContext(
            session.finalAnchorUrl,
            collectionId,
            bobIdentity,
        );
        // Replace mock recipient with Alice's real ephemeral public key
        bobContext.recipientEphemeralPubkey = session.ephIdentity.publicKey;
        bobContext.fragment = {
            encryptedShare: bobSealed.encryptedShare,
            shareIv: bobSealed.shareIv,
            shareTag: bobSealed.shareTag,
            ephemeralPubkey: bobSealed.ephemeralPubkey!,
            shareIndex: 1,
        };

        const bobApprove = await approveInboundRecovery(
            session.finalAnchorUrl,
            bobContext,
            bobIdentity,
        );
        expect(bobApprove.success).toBe(true);

        // 7. Carol approves
        const carolContext = await getInboundApprovalContext(
            session.finalAnchorUrl,
            collectionId,
            carolIdentity,
        );
        carolContext.recipientEphemeralPubkey = session.ephIdentity.publicKey;
        carolContext.fragment = {
            encryptedShare: carolSealed.encryptedShare,
            shareIv: carolSealed.shareIv,
            shareTag: carolSealed.shareTag,
            ephemeralPubkey: carolSealed.ephemeralPubkey!,
            shareIndex: 2,
        };

        const carolApprove = await approveInboundRecovery(
            session.finalAnchorUrl,
            carolContext,
            carolIdentity,
        );
        expect(carolApprove.success).toBe(true);

        // Bob & Carol's real rewrapped shares to Alice's ephemeral key
        const { openShareAsMember, rewrapShareToDevice } = await import('@beanpool/core');
        const bobRewrapped = rewrapShareToDevice(
            openShareAsMember(bobSealed, bobIdentity.privateKey),
            session.ephIdentity.publicKey,
        );
        const carolRewrapped = rewrapShareToDevice(
            openShareAsMember(carolSealed, carolIdentity.privateKey),
            session.ephIdentity.publicKey,
        );

        // Mock /api/recovery/collect/fragments
        (signedPost as any).mockImplementation(async (_url: string, path: string) => {
            if (path === '/api/recovery/collect/fragments') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        collected: 3,
                        threshold: 3,
                        enough: true,
                        fragments: [
                            {
                                holderType: 'hub',
                                shareIndex: 1,
                                payload: hubRecorded.encryptedShare,
                                payloadIv: hubRecorded.shareIv,
                                payloadTag: hubRecorded.shareTag,
                                kdfParams: hubRecorded.kdfParams,
                            },
                            {
                                holderType: 'member',
                                shareIndex: 2,
                                payload: bobRewrapped.encryptedShare,
                                payloadIv: bobRewrapped.shareIv,
                                payloadTag: bobRewrapped.shareTag,
                                ephemeralPubkey: bobRewrapped.ephemeralPubkey,
                            },
                            {
                                holderType: 'member',
                                shareIndex: 3,
                                payload: carolRewrapped.encryptedShare,
                                payloadIv: carolRewrapped.shareIv,
                                payloadTag: carolRewrapped.shareTag,
                                ephemeralPubkey: carolRewrapped.ephemeralPubkey,
                            },
                        ],
                    }),
                };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        });

        // 8. Alice completes recovery
        const restored = await completeFriendRecovery(
            session.finalAnchorUrl,
            session.collectionId,
            session.ephIdentity,
            aliceCallsign,
        );

        expect(restored.publicKey).toBe(aliceKeypair.publicKeyHex);
        expect(restored.privateKey).toBe(aliceKeypair.privateKeyHex);
        expect(restored.callsign).toBe('Alice');
    });
});
