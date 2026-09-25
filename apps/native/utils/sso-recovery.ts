/**
 * SSO Account Recovery Service (Google & Apple).
 *
 * Implements §6 Step 5b recovery round-trip:
 * 1. Generates a temporary ephemeral Ed25519 keypair for the recovering device.
 * 2. Opens a collection session for the callsign via POST /api/recovery/collect.
 * 3. Requests an SSO nonce bound to the ephemeral key via POST /api/recovery/collect/sso-nonce.
 * 4. Signs in with Google/Apple/Facebook to obtain the id_token, or has the node run GitHub's
 *    sign-in (POST /api/recovery/collect/github/start, then …/poll) for a session id.
 * 5. Releases the SSO fragment via POST /api/recovery/collect/sso, with the id_token and nonce, or
 *    with `proof: { sessionId }` for GitHub.
 * 6. Releases the Hub fragment via POST /api/recovery/collect/hub (instant under SSO tier, D7 bypassed).
 * 7. Fetches the released fragments via POST /api/recovery/collect/fragments.
 * 8. Decrypts the SSO share (B) via openShareFromSso(sealed, provider, sub).
 * 9. Reads the Hub share (A) via readHubShare(hub).
 * 10. Reconstructs seed = combineHubAndWhole(A, B) and derives the Ed25519 keypair.
 * 11. Validates and saves the restored identity and node anchor URL.
 *
 * A single-blob fragment (the only kind the app deposits now) skips 9 and 10: it holds the whole seed, and
 * the 12 words too when the sign-in was connected from a phone that had them. The words are saved only if
 * they make the restored key; a copy without them restores the key alone, as it always did.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import {
    openShareFromSso,
    openSeedFromSso,
    readHubShare,
    combineHubAndWhole,
    isSingleBlobSso,
    recoveryWordsMatchPublicKey,
} from '@beanpool/core';
import { signedPost } from './node-post';
import { seedToKeypair, decodeBase64 } from './crypto';
import { importIdentity, type BeanPoolIdentity } from './identity';
import {
    signInWithGoogle, signInWithApple, signInWithFacebook, signInWithGithubViaNode, SsoSignInError,
    type SsoProvider, type GithubDevicePrompt,
} from './sso-signin';
import { normalizeNodeUrl, looksLikeNodeAddress, shouldBlockCleartextNodeUrl } from './node-url';

/** The recovering device's pair (routes/recovery-collect.ts), bound to its ephemeral key. */
const GITHUB_RECOVERY_START = '/api/recovery/collect/github/start';
const GITHUB_RECOVERY_POLL = '/api/recovery/collect/github/poll';

export interface SsoRecoveryProgress {
    step: 'opening' | 'nonce' | 'signing-in' | 'awaiting-sso' | 'releasing-sso' | 'releasing-hub' | 'fetching-fragments' | 'reconstructing' | 'done';
    message: string;
}

export interface SsoRecoveryResult {
    identity: BeanPoolIdentity;
    provider: SsoProvider;
}

/**
 * Whether recovery is waiting on the member at GitHub: the one time welcome.tsx shows the code, Copy,
 * Open GitHub and Cancel. It takes them down at the first step past it. From the release on a cancel
 * cannot be honoured, so none is offered, and the steps that follow show instead.
 *
 * `onDeviceCode` runs before the `awaiting-sso` progress, so the panel still goes up when it should.
 */
export function waitingOnGithub(step: SsoRecoveryProgress['step']): boolean {
    return step === 'awaiting-sso';
}

function parseJwtSub(idToken: string): string {
    const parts = idToken?.split('.');
    if (!parts || parts.length < 2) {
        throw new Error('Could not determine user identifier for this sign-in.');
    }
    try {
        let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4 !== 0) {
            base64 += '=';
        }
        const bytes = decodeBase64(base64);
        const decoded = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(decoded);
        if (parsed.sub && typeof parsed.sub === 'string') {
            return parsed.sub;
        }
    } catch {}
    throw new Error('Sign-in token does not contain a valid subject claim (sub).');
}

export async function recoverAccountWithSso(options: {
    callsign: string;
    anchorUrl: string;
    provider: SsoProvider;
    onProgress?: (progress: SsoRecoveryProgress) => void;
    /**
     * Shown the GitHub device code, and responsible for getting the member to GitHub.
     *
     * REQUIRED, not optional. GitHub's device flow has no redirect and cannot complete unless the
     * member sees the code — a caller that omitted this left recovery polling silently for fifteen
     * minutes, which is exactly the bug this parameter was added to fix. Optional would leave that
     * trap open for the next caller; the compiler should refuse instead.
     *
     * Never invoked for google, apple or facebook, so an implementation that only handles GitHub
     * is correct.
     */
    onDeviceCode: (prompt: GithubDevicePrompt) => void;
    /**
     * Stops a GitHub sign-in that is waiting for the member to finish at GitHub, or that has just
     * finished there and not yet been released. Not after the release: see below. The other
     * providers' own sheets have their own cancel.
     */
    signal?: AbortSignal;
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

    // 3. Request SSO Nonce bound to ephemeral key. Its answer also says whether this node runs
    // GitHub's sign-in itself (`githubFlow`), which is the only way a GitHub recovery can go.
    options.onProgress?.({ step: 'nonce', message: 'Requesting secure sign-in challenge...' });
    const nonceRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/sso-nonce', {
        collectionId,
    }, ephIdentity);
    if (!nonceRes.ok) {
        const err = await nonceRes.json().catch(() => ({}));
        throw new Error(err.error || `Could not obtain sign-in challenge (${nonceRes.status})`);
    }
    const nonceBody = await nonceRes.json();
    if (!nonceBody?.nonce) {
        throw new Error('Node returned an empty sign-in nonce.');
    }
    const nonce = nonceBody.nonce as string;

    // 4. Sign in with Provider (Google / Apple / Facebook / GitHub)
    const providerLabel = options.provider === 'google' ? 'Google'
        : options.provider === 'apple' ? 'Apple'
        : options.provider === 'facebook' ? 'Facebook'
        : 'GitHub';

    options.onProgress?.({
        step: 'signing-in',
        message: `Signing in with ${providerLabel}...`,
    });

    // What the release carries: the provider's token and the nonce inside it, or for GitHub the
    // node's own finished session. Never a GitHub token: the node refuses one, rightly.
    let sub: string;
    let credential: { idToken: string; nonce: string } | { proof: { sessionId: string } };
    if (options.provider === 'github') {
        // GitHub is the device flow, run by the node: it has no redirect and cannot complete unless
        // the member is SHOWN a code. Recovery has no sheet, so without `onDeviceCode` the code went
        // nowhere: no prompt, no browser, and a silent fifteen-minute wait. Recovery is the entire
        // point of these fragments, so it cannot be the one path that quietly hangs.
        //
        // No nonce is re-minted afterwards, as the phone-run flow had to: the session id is the
        // node's single-use challenge, bound to this ephemeral key.
        const github = await signInWithGithubViaNode({
            post: (path, body) => signedPost(finalAnchorUrl, path, body, ephIdentity),
            routes: { start: GITHUB_RECOVERY_START, poll: GITHUB_RECOVERY_POLL, body: { collectionId } },
            githubFlow: nonceBody.githubFlow,
            onPrompt: (prompt) => {
                options.onDeviceCode(prompt);
                options.onProgress?.({
                    step: 'awaiting-sso',
                    message: `Enter code ${prompt.userCode} at ${prompt.verificationUri.replace('https://', '')}`,
                });
            },
            signal: options.signal,
        });
        sub = github.sub;
        credential = { proof: { sessionId: github.sessionId } };
    } else {
        let signInResult: { idToken: string; nonce: string; email?: string };
        if (options.provider === 'google') {
            signInResult = await signInWithGoogle(nonce);
        } else if (options.provider === 'apple') {
            signInResult = await signInWithApple(nonce);
        } else {
            signInResult = await signInWithFacebook(nonce);
        }
        sub = parseJwtSub(signInResult.idToken);
        credential = { idToken: signInResult.idToken, nonce: signInResult.nonce };
    }

    // The last point a cancel can be honoured. A member can tap Cancel after GitHub has said yes but
    // before the poll carrying it has been acted on, and nothing has been released yet, so nothing is.
    // The release cannot be taken back: the node lets the piece go and tells the owner it did. So
    // welcome.tsx takes Cancel down at the progress step below (`waitingOnGithub`), rather than
    // leaving one up that does nothing.
    if (options.signal?.aborted) {
        throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    }

    // 5. Submit SSO verification to Node
    options.onProgress?.({ step: 'releasing-sso', message: 'Verifying sign-in with node...' });
    const ssoRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/sso', {
        collectionId,
        provider: options.provider,
        ...credential,
    }, ephIdentity);

    if (!ssoRes.ok) {
        const err = await ssoRes.json().catch(() => ({}));
        throw new Error(err.error || `Sign-in verification failed (${ssoRes.status})`);
    }

    // 6. Retrieve Released Fragments
    options.onProgress?.({ step: 'fetching-fragments', message: 'Downloading recovery fragments...' });
    let fragsRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/fragments', {
        collectionId,
    }, ephIdentity);

    if (!fragsRes.ok) {
        const err = await fragsRes.json().catch(() => ({}));
        throw new Error(err.error || `Failed to fetch fragments (${fragsRes.status})`);
    }

    let fragsBody = await fragsRes.json();
    let fragments: any[] = fragsBody.fragments || [];
    const ssoFrag = fragments.find(f => f.holderType === 'sso');

    if (!ssoFrag) {
        throw new Error('Sign-in recovery piece was not returned by the node.');
    }
    if (!ssoFrag.kdfParams) {
        throw new Error('Sign-in piece is missing derivation parameters (kdfParams).');
    }

    let restoredSeed: Uint8Array;
    /** The 12 words, when the copy carried them (a sign-in connected from a phone that had them). */
    let restoredWords: string[] | null = null;

    if (isSingleBlobSso(ssoFrag.kdfParams)) {
        // New-format single-blob SSO: entire seed is sealed in this one fragment, and the 12 words with
        // it when the phone that connected the sign-in had them.
        options.onProgress?.({ step: 'reconstructing', message: 'Reconstructing account identity...' });
        const opened = await openSeedFromSso(
            {
                encryptedShare: ssoFrag.payload,
                shareIv: ssoFrag.payloadIv,
                shareTag: ssoFrag.payloadTag,
                kdfParams: ssoFrag.kdfParams,
            },
            options.provider,
            sub,
        );
        restoredSeed = opened.seed;
        if (restoredSeed.length !== 32) {
            throw new Error('Decrypted recovery seed has invalid length.');
        }
        restoredWords = opened.words;
        // Why a copy gave no words, never the words themselves. 'absent' is every copy made before copies
        // carried them, and every copy from a phone without them: the ordinary case, and not a problem.
        if (opened.wordsStatus === 'unreadable' || opened.wordsStatus === 'mismatch') {
            console.log(`[SSO-RECOVERY] ${options.provider}: the copy's 12 words ${opened.wordsStatus === 'mismatch'
                ? 'make a different key' : 'did not open'}; restoring the key alone`);
        }
    } else {
        // Old-format two-layer split (seed = A ⊕ B): request hub fragment (A), then combine with B.
        options.onProgress?.({ step: 'releasing-hub', message: 'Collecting node fragment...' });
        const hubRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/hub', {
            collectionId,
        }, ephIdentity);

        if (!hubRes.ok) {
            const err = await hubRes.json().catch(() => ({}));
            throw new Error(err.error || `Hub release failed (${hubRes.status})`);
        }

        fragsRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/fragments', {
            collectionId,
        }, ephIdentity);

        if (!fragsRes.ok) {
            const err = await fragsRes.json().catch(() => ({}));
            throw new Error(err.error || `Failed to fetch fragments (${fragsRes.status})`);
        }

        fragsBody = await fragsRes.json();
        fragments = fragsBody.fragments || [];
        const hubFrag = fragments.find(f => f.holderType === 'hub');
        if (!hubFrag) {
            throw new Error('Hub recovery piece was not returned by the node.');
        }

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

        let checksum: Uint8Array | undefined;
        try {
            const parsed = JSON.parse(ssoFrag.kdfParams);
            if (parsed.checksum && typeof parsed.checksum === 'string') {
                const decoded = decodeBase64(parsed.checksum);
                if (decoded.length === 4) {
                    checksum = decoded;
                }
            }
        } catch {}

        try {
            restoredSeed = combineHubAndWhole(hubShare, otherHalf, checksum);
        } catch (e) {
            throw new Error(
                (e as Error).message || 'Failed to combine recovery fragments.',
            );
        }
    }

    const restoredKeypair = await seedToKeypair(restoredSeed);

    // The words are kept only if they make the key being saved, compared by public key. openSeedFromSso
    // already checked them against the seed; this checks them against the identity actually written.
    let mnemonic: string[] | undefined;
    if (restoredWords) {
        if (recoveryWordsMatchPublicKey(restoredWords, restoredKeypair.publicKeyHex)) {
            mnemonic = restoredWords;
        } else {
            console.log(`[SSO-RECOVERY] ${options.provider}: the copy's 12 words do not make the restored key; restoring the key alone`);
        }
    }

    const restoredIdentity: BeanPoolIdentity = {
        publicKey: restoredKeypair.publicKeyHex,
        privateKey: restoredKeypair.privateKeyHex,
        callsign: rawCallsign,
        createdAt: new Date().toISOString(),
        ...(mnemonic ? { mnemonic } : {}),
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
