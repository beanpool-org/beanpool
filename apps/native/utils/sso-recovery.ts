/**
 * SSO Account Recovery Service (Google & Apple).
 *
 * Implements §6 Step 5b recovery round-trip:
 * 1. Generates a temporary ephemeral Ed25519 keypair for the recovering device.
 * 2. Opens a collection session for the callsign via POST /api/recovery/collect.
 * 3. Requests an SSO nonce bound to the ephemeral key via POST /api/recovery/collect/sso-nonce.
 * 4. Signs in with Google/Apple to obtain the id_token.
 * 5. Releases the SSO fragment via POST /api/recovery/collect/sso.
 * 6. Releases the Hub fragment via POST /api/recovery/collect/hub (instant under SSO tier, D7 bypassed).
 * 7. Fetches the released fragments via POST /api/recovery/collect/fragments.
 * 8. Decrypts the SSO share (B) via openShareFromSso(sealed, provider, sub).
 * 9. Reads the Hub share (A) via readHubShare(hub).
 * 10. Reconstructs seed = combineHubAndWhole(A, B) and derives the Ed25519 keypair.
 * 11. Validates and saves the restored identity and node anchor URL.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import {
    openShareFromSso,
    readHubShare,
    combineHubAndWhole,
} from '@beanpool/core';
import { signedPost } from './node-post';
import { seedToKeypair, decodeBase64 } from './crypto';
import { importIdentity, type BeanPoolIdentity } from './identity';
import { signInWithGoogle, signInWithApple, signInWithFacebook, signInWithGithub, type SsoProvider } from './sso-signin';
import { normalizeNodeUrl, looksLikeNodeAddress, shouldBlockCleartextNodeUrl } from './node-url';

export interface SsoRecoveryProgress {
    step: 'opening' | 'nonce' | 'signing-in' | 'releasing-sso' | 'releasing-hub' | 'fetching-fragments' | 'reconstructing' | 'done';
    message: string;
}

export interface SsoRecoveryResult {
    identity: BeanPoolIdentity;
    provider: SsoProvider;
}

function parseJwtSub(idToken: string): string {
    const parts = idToken.split('.');
    if (parts.length < 2) {
        throw new Error('Malformed ID token from sign-in provider.');
    }
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
        base64 += '=';
    }
    const bytes = decodeBase64(base64);
    const decoded = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(decoded);
    if (!parsed.sub || typeof parsed.sub !== 'string') {
        throw new Error('Sign-in token does not contain a valid subject claim (sub).');
    }
    return parsed.sub;
}

export async function recoverAccountWithSso(options: {
    callsign: string;
    anchorUrl: string;
    provider: SsoProvider;
    onProgress?: (progress: SsoRecoveryProgress) => void;
}): Promise<SsoRecoveryResult> {
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

    // 1. Generate throwaway ephemeral keypair to bind this recovery session
    const ephSeed = Crypto.getRandomBytes(32);
    const ephKey = await seedToKeypair(ephSeed);
    const ephIdentity: BeanPoolIdentity = {
        publicKey: ephKey.publicKeyHex,
        privateKey: ephKey.privateKeyHex,
        callsign: 'ephemeral-recovery',
        createdAt: new Date().toISOString(),
    };

    // 2. Open recovery collection
    options.onProgress?.({ step: 'opening', message: 'Connecting to node recovery session...' });
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

    // 3. Request SSO Nonce bound to ephemeral key
    options.onProgress?.({ step: 'nonce', message: 'Requesting secure sign-in challenge...' });
    const nonceRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/sso-nonce', {
        collectionId,
    }, ephIdentity);

    if (!nonceRes.ok) {
        const err = await nonceRes.json().catch(() => ({}));
        throw new Error(err.error || `Could not obtain sign-in challenge (${nonceRes.status})`);
    }
    const { nonce } = await nonceRes.json();
    if (!nonce) {
        throw new Error('Node returned an empty sign-in nonce.');
    }

    // 4. Sign in with Provider (Google / Apple / Facebook / GitHub)
    const providerLabel = options.provider === 'google' ? 'Google'
        : options.provider === 'apple' ? 'Apple'
        : options.provider === 'facebook' ? 'Facebook'
        : 'GitHub';

    options.onProgress?.({
        step: 'signing-in',
        message: `Signing in with ${providerLabel}...`,
    });

    let signInResult: { idToken: string; nonce: string; email?: string };
    if (options.provider === 'google') {
        signInResult = await signInWithGoogle(nonce);
    } else if (options.provider === 'apple') {
        signInResult = await signInWithApple(nonce);
    } else if (options.provider === 'facebook') {
        signInResult = await signInWithFacebook(nonce);
    } else {
        signInResult = await signInWithGithub(nonce);
    }

    const sub = parseJwtSub(signInResult.idToken);

    // 5. Submit SSO verification to Node
    options.onProgress?.({ step: 'releasing-sso', message: 'Verifying sign-in with node...' });
    const ssoRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/sso', {
        collectionId,
        provider: options.provider,
        idToken: signInResult.idToken,
        nonce: signInResult.nonce,
    }, ephIdentity);

    if (!ssoRes.ok) {
        const err = await ssoRes.json().catch(() => ({}));
        throw new Error(err.error || `Sign-in verification failed (${ssoRes.status})`);
    }

    // 6. Request Hub Fragment Release (instant under SSO tier)
    options.onProgress?.({ step: 'releasing-hub', message: 'Collecting node fragment...' });
    const hubRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/hub', {
        collectionId,
    }, ephIdentity);

    if (!hubRes.ok) {
        const err = await hubRes.json().catch(() => ({}));
        throw new Error(err.error || `Hub release failed (${hubRes.status})`);
    }

    // 7. Retrieve Released Fragments
    options.onProgress?.({ step: 'fetching-fragments', message: 'Downloading recovery fragments...' });
    const fragsRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/fragments', {
        collectionId,
    }, ephIdentity);

    if (!fragsRes.ok) {
        const err = await fragsRes.json().catch(() => ({}));
        throw new Error(err.error || `Failed to fetch fragments (${fragsRes.status})`);
    }

    const fragsBody = await fragsRes.json();
    const fragments: any[] = fragsBody.fragments || [];
    const ssoFrag = fragments.find(f => f.holderType === 'sso');
    const hubFrag = fragments.find(f => f.holderType === 'hub');

    if (!ssoFrag) {
        throw new Error('Sign-in recovery piece was not returned by the node.');
    }
    if (!hubFrag) {
        throw new Error('Hub recovery piece was not returned by the node.');
    }
    if (!ssoFrag.kdfParams) {
        throw new Error('Sign-in piece is missing derivation parameters (kdfParams).');
    }

    // 8. Reconstruct Seed (A ⊕ B)
    options.onProgress?.({ step: 'reconstructing', message: 'Reconstructing account identity...' });
    const otherHalf = await openShareFromSso(
        {
            encryptedShare: ssoFrag.payload,
            shareIv: ssoFrag.payloadIv,
            shareTag: ssoFrag.payloadTag,
            kdfParams: ssoFrag.kdfParams,
        },
        options.provider,
        sub,
    );

    const hubShare = readHubShare({
        encryptedShare: hubFrag.payload,
        shareIv: hubFrag.payloadIv,
        shareTag: hubFrag.payloadTag,
        kdfParams: hubFrag.kdfParams,
    });

    const restoredSeed = combineHubAndWhole(hubShare, otherHalf);
    const restoredKeypair = await seedToKeypair(restoredSeed);

    const restoredIdentity: BeanPoolIdentity = {
        publicKey: restoredKeypair.publicKeyHex,
        privateKey: restoredKeypair.privateKeyHex,
        callsign: rawCallsign,
        createdAt: new Date().toISOString(),
    };

    // 9. Save Anchor URL and Identity
    await AsyncStorage.setItem('beanpool_anchor_url', finalAnchorUrl);
    await importIdentity(restoredIdentity);

    // Clear any pending onboarding state
    try {
        const { clearPendingOnboarding } = await import('./onboarding-state');
        await clearPendingOnboarding();
    } catch {}

    options.onProgress?.({ step: 'done', message: 'Account restored successfully!' });
    return {
        identity: restoredIdentity,
        provider: options.provider,
    };
}
