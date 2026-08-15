/**
 * Trusted Friend Recovery Service (K4+ Keepers).
 *
 * Implements the Two-Layer Trusted Friend Recovery flow ($A \oplus B$, Shamir 2-of-N):
 *
 * Recovering device:
 * 1. Generates a temporary ephemeral Ed25519 keypair.
 * 2. Opens a collection session via POST /api/recovery/collect.
 * 3. Polls recovery progress and automatically attempts Hub fragment release (D7) once a friend approves.
 * 4. When threshold (2 friend fragments + Hub fragment) is reached:
 *    - Opens rewrapped friend fragments with ephemeral private key.
 *    - Shamir-combines friend shares to reconstruct B.
 *    - Reads Hub share A.
 *    - Computes Seed = A ⊕ B and restores original Ed25519 identity.
 *
 * Approving keeper (Friend):
 * 1. Fetches context from POST /api/recovery/approve-keeper/context.
 * 2. Unseals held fragment using openShareAsMember(sealed, myPrivateKey).
 * 3. Re-wraps fragment to recovering device using rewrapShareToDevice(share, requesterPubkey).
 * 4. Submits approval via POST /api/recovery/approve-keeper.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import {
    openShareAsMember,
    rewrapShareToDevice,
    openRewrappedShare,
    readHubShare,
    combineBytes,
    TWO_LAYER_THRESHOLD,
} from '@beanpool/core';
import { signedPost } from './node-post';
import { seedToKeypair } from './crypto';
import { importIdentity, type BeanPoolIdentity } from './identity';
import { normalizeNodeUrl, looksLikeNodeAddress, shouldBlockCleartextNodeUrl } from './node-url';

export interface FriendRecoveryProgress {
    step: 'opening' | 'waiting-friends' | 'hub-released' | 'reconstructing' | 'done';
    message: string;
    collected: number;
    threshold: number;
    enough: boolean;
    hubEligibleAt?: string | null;
    hubReason?: string | null;
}

export interface InboundApprovalContext {
    collectionId: string;
    callsign: string;
    live: boolean;
    reason?: string;
    fragment: {
        encryptedShare: string;
        shareIv: string;
        shareTag: string;
        ephemeralPubkey: string;
        shareIndex: number;
    };
    recipientEphemeralPubkey: string;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length !== b.length) {
        throw new Error(`XOR mismatch: lengths ${a.length} and ${b.length}`);
    }
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) {
        out[i] = a[i] ^ b[i];
    }
    return out;
}

/**
 * Starts a new friend recovery session on the target node.
 */
export async function startFriendRecoverySession(options: {
    callsign: string;
    anchorUrl: string;
}): Promise<{
    collectionId: string;
    ephIdentity: BeanPoolIdentity;
    finalAnchorUrl: string;
    threshold: number;
}> {
    const rawCallsign = options.callsign.trim();
    if (!rawCallsign) {
        throw new Error('Enter your callsign to recover your account.');
    }

    const rawAnchor = options.anchorUrl.trim();
    if (!rawAnchor) {
        throw new Error('Enter your community node address.');
    }

    const finalAnchorUrl = normalizeNodeUrl(rawAnchor);
    if (!looksLikeNodeAddress(finalAnchorUrl)) {
        throw new Error("That node address doesn't look right. Use something like node.yourcommunity.org");
    }
    if (shouldBlockCleartextNodeUrl(finalAnchorUrl)) {
        throw new Error('That node address is insecure (http on a public host). Use https:// instead.');
    }

    // Generate throwaway ephemeral keypair for this recovery session
    const ephSeed = Crypto.getRandomBytes(32);
    const ephKey = await seedToKeypair(ephSeed);
    const ephIdentity: BeanPoolIdentity = {
        publicKey: ephKey.publicKeyHex,
        privateKey: ephKey.privateKeyHex,
        callsign: 'ephemeral-recovery',
        createdAt: new Date().toISOString(),
    };

    const openRes = await signedPost(finalAnchorUrl, '/api/recovery/collect', {
        callsign: rawCallsign,
    }, ephIdentity);

    if (!openRes.ok) {
        const err = await openRes.json().catch(() => ({}));
        throw new Error(err.error || `Could not open recovery session (${openRes.status})`);
    }

    const openBody = await openRes.json();
    const collectionId = openBody.collectionId;
    if (!collectionId) {
        throw new Error('Node did not return a valid recovery session ID.');
    }

    return {
        collectionId,
        ephIdentity,
        finalAnchorUrl,
        threshold: openBody.threshold ?? 3,
    };
}

/**
 * Polls collection status and triggers Hub release if eligible.
 */
export async function pollFriendRecovery(
    anchorUrl: string,
    collectionId: string,
    ephIdentity: BeanPoolIdentity,
): Promise<{
    collected: number;
    threshold: number;
    enough: boolean;
    hubAvailable: boolean;
}> {
    // Attempt hub release (instant if at least 1 human approved under D7)
    await signedPost(anchorUrl, '/api/recovery/collect/hub', { collectionId }, ephIdentity).catch(() => {});

    const statusRes = await signedPost(anchorUrl, '/api/recovery/collect/status', {
        collectionId,
    }, ephIdentity);

    if (!statusRes.ok) {
        const err = await statusRes.json().catch(() => ({}));
        throw new Error(err.error || `Could not check status (${statusRes.status})`);
    }

    const status = await statusRes.json();
    const releasedTypes: string[] = status.releasedTypes || [];

    return {
        collected: status.collected || 0,
        threshold: status.threshold || 3,
        enough: !!status.enough,
        hubAvailable: releasedTypes.includes('hub'),
    };
}

async function fetchRecoveryFragments(anchorUrl: string, collectionId: string, ephIdentity: BeanPoolIdentity) {
    const fragRes = await signedPost(anchorUrl, '/api/recovery/collect/fragments', { collectionId }, ephIdentity);
    if (!fragRes.ok) {
        const err = await fragRes.json().catch(() => ({}));
        throw new Error(err.error || `Could not fetch recovery fragments (${fragRes.status})`);
    }
    return await fragRes.json();
}

/**
 * Fetches all released fragments, decrypts, and reconstructs the original identity keypair.
 */
export async function completeFriendRecovery(
    anchorUrl: string,
    collectionId: string,
    ephIdentity: BeanPoolIdentity,
    expectedCallsign?: string,
    expectedPublicKey?: string,
): Promise<BeanPoolIdentity> {
    const rawFragments = await fetchRecoveryFragments(anchorUrl, collectionId, ephIdentity);
    if (!rawFragments.enough) {
        throw new Error('Not enough recovery fragments released yet.');
    }

    const hubFragment = rawFragments.fragments.find((f: any) => f.holderType === 'hub');
    const memberFragments = rawFragments.fragments.filter((f: any) => f.holderType === 'member');

    if (!hubFragment) {
        throw new Error('Hub recovery fragment is missing from response.');
    }
    if (memberFragments.length < TWO_LAYER_THRESHOLD) {
        throw new Error(`Need at least ${TWO_LAYER_THRESHOLD} friend approvals, received ${memberFragments.length}.`);
    }

    // 1. Read Hub share A
    const hubShare = readHubShare({
        encryptedShare: hubFragment.payload,
        shareIv: hubFragment.payloadIv,
        shareTag: hubFragment.payloadTag,
        kdfParams: hubFragment.kdfParams || JSON.stringify({ alg: 'plaintext-v1' }),
    });

    // 2. Open rewrapped friend shares B_i with ephemeral key
    const openedFriendShares: Uint8Array[] = memberFragments.map((f: any) => {
        return openRewrappedShare({
            encryptedShare: f.payload,
            shareIv: f.payloadIv,
            shareTag: f.payloadTag,
            ephemeralPubkey: f.ephemeralPubkey,
        }, ephIdentity.privateKey);
    });

    // 3. Shamir combine to reconstruct B
    const B = await combineBytes(openedFriendShares);

    // 4. XOR combine: Seed = A ⊕ B
    const restoredSeed = xorBytes(hubShare, B);

    // 5. Derive original Ed25519 identity keypair
    const restoredKeypair = await seedToKeypair(restoredSeed);

    if (expectedPublicKey && restoredKeypair.publicKeyHex.toLowerCase() !== expectedPublicKey.toLowerCase()) {
        throw new Error('Reconstructed keypair does not match expected public key. Recovery shares may be corrupt or mismatched.');
    }

    const callsign = expectedCallsign || 'restored-member';

    const restoredIdentity: BeanPoolIdentity = {
        publicKey: restoredKeypair.publicKeyHex,
        privateKey: restoredKeypair.privateKeyHex,
        callsign,
        createdAt: new Date().toISOString(),
    };

    await AsyncStorage.setItem('beanpool_anchor_url', anchorUrl);
    await importIdentity(restoredIdentity);

    try {
        const { clearPendingOnboarding } = await import('./onboarding-state');
        await clearPendingOnboarding();
    } catch {}

    return restoredIdentity;
}

/**
 * Keeper side: Fetches inbound recovery context for a collection.
 */
export async function getInboundApprovalContext(
    anchorUrl: string,
    collectionId: string,
    myIdentity: BeanPoolIdentity,
): Promise<InboundApprovalContext> {
    const res = await signedPost(anchorUrl, '/api/recovery/approve-keeper/context', {
        collectionId,
    }, myIdentity);

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Could not fetch approval context (${res.status})`);
    }

    const data = await res.json();
    return {
        collectionId,
        callsign: data.callsign || 'Unknown Member',
        live: !!data.live,
        reason: data.reason,
        fragment: data.fragment,
        recipientEphemeralPubkey: data.recipientEphemeralPubkey,
    };
}

/**
 * Keeper side: Approves an inbound recovery request by unsealing the held fragment
 * and re-wrapping it to the recovering device's ephemeral public key.
 */
export async function approveInboundRecovery(
    anchorUrl: string,
    context: InboundApprovalContext,
    myIdentity: BeanPoolIdentity,
): Promise<{ success: boolean; released: string }> {
    if (!context.live) {
        throw new Error(`This recovery session is no longer active (${context.reason || 'expired'}).`);
    }
    if (!context.fragment) {
        throw new Error('Recovery fragment data is missing for this account.');
    }
    if (!context.recipientEphemeralPubkey) {
        throw new Error('Recipient ephemeral public key is missing from the recovery session.');
    }

    // 1. Unseal the held fragment using keeper's identity private key
    const heldShare = {
        encryptedShare: context.fragment.encryptedShare,
        shareIv: context.fragment.shareIv,
        shareTag: context.fragment.shareTag,
        ephemeralPubkey: context.fragment.ephemeralPubkey,
        kdfParams: JSON.stringify({ alg: 'x25519-xc20p-v1' }),
    };

    const openedShare = openShareAsMember(heldShare, myIdentity.privateKey);

    // 2. Re-wrap to the recovering device's ephemeral public key
    const rewrapped = rewrapShareToDevice(openedShare, context.recipientEphemeralPubkey);

    // 3. Post the re-wrapped share to the node
    const res = await signedPost(anchorUrl, '/api/recovery/approve-keeper', {
        collectionId: context.collectionId,
        payload: rewrapped.encryptedShare,
        payloadIv: rewrapped.shareIv,
        payloadTag: rewrapped.shareTag,
        ephemeralPubkey: rewrapped.ephemeralPubkey,
    }, myIdentity);

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to approve recovery (${res.status})`);
    }

    const body = await res.json();
    return {
        success: true,
        released: body.released || 'member',
    };
}
