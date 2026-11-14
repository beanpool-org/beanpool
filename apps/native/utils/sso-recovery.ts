/**
 * Getting an account back with a sign-in ("Recover with Social"). Where the copy is depends on the build
 * (utils/vault.ts `signInCopiesAt`):
 *
 * ## A build with BeanPool's key vault (key vault design §1.3, V4)
 *
 * No name and no community address: the sign-in itself finds the copy, and no community is asked for anything until
 * the account is back.
 *
 * 1. {@link startSsoRestore}: a throwaway key, a restore ticket for it (checked against the vault's pinned keys before
 *    any sheet opens), the provider's sheet with the ticket's nonce, then `/v1/restore`. Every restore is held (D2):
 *    24 hours, or less once another phone that has the account taps "Yes, it's me". That device is told at once
 *    and can Stop it.
 * 2. {@link checkSsoRestore}: asks the vault, while the member waits and whenever the app comes back. Released: the
 *    copy opens with the throwaway key and the sign-in's subject, and counts only if its seed makes the key the
 *    vault's release names. The 12 words come back when the copy carried them and they make that key.
 * 3. {@link finishSsoRestore}: the member chooses the community to go to, global by default (as a 12-words restore
 *    asks for one), and the account is saved through "Replace this phone's account?" when the phone holds another.
 *
 * The waiting restore lives on this phone (SecureStore, this device only) until the account is saved, so a restart, a
 * lost answer or a failed save comes back to the same hold.
 *
 * When the vault answers, signed, that it keeps no copy for a sign-in, the phone remembers that per provider
 * ({@link vaultKeepsNoCopyFor}), and the copy may still be at the member's community, made before the vault and never
 * moved: the restore goes on there, as below, with the community the member chooses and a second sign-in for the
 * community's own nonce. Then the move card is offered at once (PR #1336 review finding 3).
 *
 * ## A build without one: at the member's community ({@link recoverAccountWithSso})
 *
 * The community finds the account from the sign-in itself, with nothing typed (recovery S2, scratch design
 * DESIGN-recovery-no-callsign-fable.md §3-§6; Marty, 9 Nov), as the web's restore does (apps/pwa/src/lib/web-restore.ts,
 * S1). Against the community's recovery routes (apps/server routes/recovery-collect.ts):
 * 1. A throwaway Ed25519 key is made for this restore. It signs every call below, and the community binds the find, its
 *    hold and the recovery session to it. It is never saved.
 * 2. `POST /api/recovery/find-nonce`: the sign-in nonce, for the throwaway key. A community whose server has no find
 *    answers 404, and the member is told to ask its admin to update (`server_too_old`), before any sign-in.
 * 3. The provider's sheet (Apple, Google or Facebook) with that nonce: the id_token.
 * 4. `POST /api/recovery/find` with the token: the accounts this sign-in protects there, by name and key. None: the
 *    member is told no account there uses it (`no_account_here`). Several (one sign-in can protect a parent's account
 *    and a child's): the member picks ({@link PickAccount}). The community holds the verified sign-in for 5 minutes.
 * 5. `POST /api/recovery/collect { candidatePublicKey }` for the account picked: the community opens the session by the
 *    find's hold and releases the account's sign-in copy in the same request (its owner is told).
 * 6. An old two-part copy's hub half: `POST /api/recovery/collect/hub` in the same session.
 * 7. `POST /api/recovery/collect/fragments`, sealed to the throwaway key, opened with it ({@link fetchReleasedFragments};
 *    a community from before the seal sends them as stored).
 * 8. The copy opens with the sign-in's `sub`: the whole seed (a single-blob copy, the only kind the app deposits now, with
 *    the 12 words too when the sign-in was connected from a phone that had them), or half of it beside the hub's half.
 * 9. The key it makes must be the key the find named for the account picked, compared case-folded as the web compares it
 *    (#1951; launch-readiness review 3, 2026-10-15). Another key (a wrong or stale copy, a community answering for
 *    someone else) saves nothing. The words are saved only if they make that key.
 * 10. Saved under the name the find gives the account, at the community chosen, through "Replace this phone's account?"
 *    when the phone holds another.
 */

import * as Crypto from 'expo-crypto';
import {
    openShareFromSso,
    openSeedFromSso,
    readHubShare,
    combineHubAndWhole,
    isSingleBlobSso,
    recoveryWordsMatchPublicKey,
    openListedFragment,
    KEEPER_ALG_RELEASE,
    type CopyCommunity,
} from '@beanpool/core';
import { signedPost } from './node-post';
import { seedToKeypair, decodeBase64 } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { clearToRestore, restoreFromVault, saveRestoredAccount, type ConfirmReplace, type NameOnNode } from './restore-account';
import { saveCommunitiesFromCopy } from './copy-communities';
import { signInWithGoogle, signInWithApple, signInWithFacebook, signInWithProvider, SsoSignInError } from './sso-signin';
import { SSO_PROVIDER_NAMES, type SsoProvider } from './sso-providers';
import { normalizeNodeUrl, looksLikeNodeAddress, shouldBlockCleartextNodeUrl } from './node-url';
import {
    clearPendingVaultRestore,
    collectVaultRestore,
    forgetVaultCopyKnowledge,
    hasVault,
    loadPendingVaultRestore,
    noteVaultCopy,
    startVaultRestore,
    stopVaultHold,
    VaultError,
    type PendingVaultRestore,
    type RestoredFromVault,
    type VaultCollect,
    type VaultSigner,
} from './vault';

export type { PendingVaultRestore, RestoredFromVault, VaultCollect } from './vault';

/**
 * Where a restore at the community is (the screen shows `message`, which welcome-lines.ts says in the member's language):
 * signing in (the find nonce and the provider's sheet), finding the account, getting the one picked back, done.
 */
export interface SsoRecoveryProgress {
    step: 'signing-in' | 'finding' | 'restoring' | 'done';
    message: string;
}

export interface SsoRecoveryResult {
    identity: BeanPoolIdentity;
    provider: SsoProvider;
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

/** Why a restore stopped when the community's copy didn't open with this restore's own key. Nothing was saved. */
export const RELEASED_COPY_NOT_OPENED = "Your community's copy didn't open on this phone, so nothing was changed. "
    + 'Start again, or use your 12 words.';

/**
 * The fragments released to this restore, each as the account deposited it (POST /api/recovery/collect/fragments).
 *
 * Asked for sealed to the restore's throwaway key (`seal`, defence review FABLE-sec-sso finding 2): what crosses the
 * wire, or lands in a log, opens only with that key, which never leaves this phone; core's `openListedFragment` opens
 * it. A community from before the seal ignores the request and lists them as stored, and those are taken as they come,
 * so a restore there works as it always did. A sealed one that doesn't open stops the restore with nothing saved.
 */
async function fetchReleasedFragments(anchorUrl: string, collectionId: string, eph: BeanPoolIdentity): Promise<any[]> {
    const res = await signedPost(anchorUrl, '/api/recovery/collect/fragments', {
        collectionId,
        seal: KEEPER_ALG_RELEASE,
    }, eph);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to fetch fragments (${res.status})`);
    }
    const body = await res.json();
    const listed: any[] = Array.isArray(body?.fragments) ? body.fragments.filter((f: unknown) => !!f && typeof f === 'object') : [];
    try {
        return listed.map(f => openListedFragment(f, eph.privateKey, collectionId));
    } catch (e) {
        console.log(`[SSO-RECOVERY] a released copy sealed to this restore did not open: ${(e as Error)?.message}`);
        throw new Error(RELEASED_COPY_NOT_OPENED);
    }
}

/** One account the community's find named for this sign-in: the name it has there, and its key (lower-cased). */
export interface FoundAccount {
    publicKey: string;
    callsign: string;
}

/**
 * Asked when the find names several accounts (design §3 "Several accounts, one sign-in"): the member's pick, one of
 * `accounts`, or null when they go back instead, and then nothing is collected. The screen shows "Which account is
 * yours?" and resolves it.
 */
export type PickAccount = (accounts: FoundAccount[]) => Promise<FoundAccount | null>;

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * The accounts in a find's answer, in the community's order: each with a key and a name, keys lower-cased as the web
 * reads them (apps/pwa/src/lib/web-restore.ts `findAccounts`), one named twice listed once. Null when the answer holds no
 * list.
 */
function foundAccounts(body: unknown): FoundAccount[] | null {
    const listed = (body as { accounts?: unknown } | null)?.accounts;
    if (!Array.isArray(listed)) return null;
    const seen = new Set<string>();
    return listed.flatMap((c): FoundAccount[] => {
        const publicKey = typeof c?.publicKey === 'string' ? c.publicKey.trim().toLowerCase() : '';
        const callsign = typeof c?.callsign === 'string' ? c.callsign : '';
        if (!HEX_KEY.test(publicKey) || !callsign.trim() || seen.has(publicKey)) return [];
        seen.add(publicKey);
        return [{ publicKey, callsign }];
    });
}

/**
 * Why {@link recoverAccountWithSso} stopped, as data. The screen says it in the member's language, in the web's words
 * for the same answer (community-restore-copy.ts `restoreRefusalText`, welcome.tsx). Never a sentence here: this module
 * turns a sign-in copy into the key and checks its 12 words, so nothing in it reaches the words layer
 * (packages/beanpool-core/src/__tests__/recovery-path-files.test.ts).
 *
 * - `unreachable`: the community didn't answer at all (its find nonce, its find or its collect). Nothing was saved.
 * - `server_too_old`: the community's server has no find (its find nonce answered 404, design §4): it is older than this
 *   app. No sign-in was started.
 * - `no_account_here`: no account at the community uses this sign-in. Nothing was released.
 * - `refused`: the community refused the find nonce (`provider` null: no sign-in yet), the find, or the collect, with its
 *   status, its own words when it gave some (`said`), and whether its answer carried a code (a 401 without one is the
 *   signature check's: this phone's clock).
 * - `not_that_account`: with the copy open, it made another key than the account picked (`name`). Nothing was saved.
 */
export type CommunityRestoreRefusal =
    | { code: 'unreachable' }
    | { code: 'server_too_old' }
    | { code: 'no_account_here'; provider: SsoProvider }
    | { code: 'refused'; step: 'find' | 'collect'; provider: SsoProvider | null; status: number; said: string | null; coded: boolean }
    | { code: 'not_that_account'; name: string };

/** {@link recoverAccountWithSso} refused, for one of the {@link CommunityRestoreRefusal} reasons. */
export class CommunityRestoreRefused extends Error {
    readonly refusal: CommunityRestoreRefusal;

    constructor(refusal: CommunityRestoreRefusal) {
        super(`Community restore refused: ${refusal.code}`);
        this.name = 'CommunityRestoreRefused';
        this.refusal = refusal;
    }
}

/** Why {@link recoverAccountWithSso} refused in a build with a vault: never met by a member (the screen doesn't offer it). */
export const COMMUNITY_RESTORE_NOT_OFFERED = "Getting back in with a sign-in goes through BeanPool's key vault in this version "
    + 'of the app. Your 12 words work any time.';

/**
 * A signed POST to the community for this restore: a request the community never answered (no connection, no server) is
 * `unreachable`, never the network's own English.
 */
async function postToCommunity(anchorUrl: string, path: string, body: unknown, eph: BeanPoolIdentity): Promise<Response> {
    try {
        return await signedPost(anchorUrl, path, body, eph);
    } catch (e) {
        console.log(`[SSO-RECOVERY] ${path} had no answer: ${(e as Error)?.message || e}`);
        throw new CommunityRestoreRefused({ code: 'unreachable' });
    }
}

/** The community's refusal of a step, as data ({@link CommunityRestoreRefusal} `refused`): its status, words and code. */
async function refusedBy(res: Response, step: 'find' | 'collect', provider: SsoProvider | null): Promise<CommunityRestoreRefused> {
    const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
    const said = typeof body?.error === 'string' && body.error.trim() ? body.error : null;
    return new CommunityRestoreRefused({ code: 'refused', step, provider, status: res.status, said, coded: typeof body?.code === 'string' });
}

/**
 * The restore at the member's community, chosen by the member, found from the sign-in alone: a build without a vault's
 * only sign-in restore. In a build with a vault, only with a provider the vault has said, signed, that it keeps no copy
 * for ({@link vaultKeepsNoCopyFor}, per provider); otherwise it refuses before anything is sent.
 */
export async function recoverAccountWithSso(options: {
    anchorUrl: string;
    provider: SsoProvider;
    onProgress?: (progress: SsoRecoveryProgress) => void;
    /**
     * Stops a restore whose sign-in has finished and whose copy has not yet been released (welcome.tsx aborts it when the
     * screen goes away). Not after the release: see below. The providers' own sheets have their own cancel.
     */
    signal?: AbortSignal;
    /**
     * Runs once the provider has handed back its token, before anything is released. From then on its page may still be
     * in front of the app (Android's Custom Tab), so a screen that shows a refusal brings the app back first
     * (welcome.tsx), as the vault's {@link startSsoRestore} does here. Never run when the sign-in itself didn't finish.
     */
    onSignedIn?: () => void | Promise<void>;
    /**
     * Asked when the find names several accounts. Without it, a find that names several collects nothing. Never asked
     * when it names one.
     */
    pickAccount?: PickAccount;
    /**
     * Asked before this restore writes another account over the one the phone holds ("Replace this phone's
     * account?", restore-account.ts). Called after the account has been rebuilt and before anything is written: the
     * community's address, the key and the onboarding record all stay as they are unless it says yes. Without it, a
     * phone holding another account refuses the restore. Never asked when the phone has no account, or this one.
     */
    confirmReplace?: ConfirmReplace;
}): Promise<SsoRecoveryResult> {
    if (hasVault() && !vaultKeepsNoCopyFor(options.provider)) throw new Error(COMMUNITY_RESTORE_NOT_OFFERED);

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

    // 1. A throwaway key for this restore: it signs every call below, and the community binds the nonce, the find's hold
    // and the session to it.
    const ephSeed = Crypto.getRandomBytes(32);
    const ephKey = await seedToKeypair(ephSeed);
    const ephIdentity: BeanPoolIdentity = {
        publicKey: ephKey.publicKeyHex,
        privateKey: ephKey.privateKeyHex,
        callsign: 'ephemeral-recovery',
        createdAt: new Date().toISOString(),
    };

    // 2. The find's sign-in nonce. A server with no find (404) is older than this app: said before any sheet opens.
    options.onProgress?.({ step: 'signing-in', message: `Signing in with ${SSO_PROVIDER_NAMES[options.provider]}...` });
    const nonceRes = await postToCommunity(finalAnchorUrl, '/api/recovery/find-nonce', {}, ephIdentity);
    if (nonceRes.status === 404) throw new CommunityRestoreRefused({ code: 'server_too_old' });
    if (!nonceRes.ok) throw await refusedBy(nonceRes, 'find', null);
    const nonceBody = await nonceRes.json().catch(() => null);
    if (typeof nonceBody?.nonce !== 'string' || !nonceBody.nonce) {
        throw new Error('Node returned an empty sign-in nonce.');
    }
    const nonce = nonceBody.nonce as string;

    // 3. The provider's sheet (Apple / Google / Facebook), with that nonce.
    let signInResult: { idToken: string; nonce: string; email?: string };
    if (options.provider === 'google') {
        signInResult = await signInWithGoogle(nonce);
    } else if (options.provider === 'apple') {
        signInResult = await signInWithApple(nonce);
    } else {
        signInResult = await signInWithFacebook(nonce);
    }
    await options.onSignedIn?.();
    const sub = parseJwtSub(signInResult.idToken);

    // 4. The accounts this sign-in protects at the community, by name and key. The community holds the verified sign-in
    // for the collect, for this throwaway key, for 5 minutes. Nothing is released by a find.
    options.onProgress?.({ step: 'finding', message: 'Finding your account…' });
    const findRes = await postToCommunity(finalAnchorUrl, '/api/recovery/find', {
        provider: options.provider,
        idToken: signInResult.idToken,
        nonce: signInResult.nonce,
    }, ephIdentity);
    if (!findRes.ok) throw await refusedBy(findRes, 'find', options.provider);
    const found = foundAccounts(await findRes.json().catch(() => null));
    if (!found) throw new CommunityRestoreRefused({ code: 'refused', step: 'find', provider: options.provider, status: findRes.status, said: null, coded: false });
    if (!found.length) throw new CommunityRestoreRefused({ code: 'no_account_here', provider: options.provider });

    // 5. The one to bring back: the only one, or the member's pick of several. A pick that is none of them collects nothing.
    let account = found[0];
    if (found.length > 1) {
        if (!options.pickAccount) throw new Error('This sign-in protects more than one account here, and this screen cannot ask which.');
        const picked = await options.pickAccount(found);
        if (!picked) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
        const chosen = found.find(a => a.publicKey === picked.publicKey.trim().toLowerCase());
        if (!chosen) throw new Error('That account is not one this sign-in protects here.');
        account = chosen;
    }

    // The last point a cancel can be honoured: nothing has been released yet, so nothing is. The release cannot be
    // taken back: the community lets the copy go and tells the owner it did.
    if (options.signal?.aborted) {
        throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    }

    // 6. The collect by the find's hold: the session opens for the account picked, and its sign-in copy is released in the
    // same request (routes/recovery-collect.ts collectByHold, through the release's own per-row proof).
    options.onProgress?.({ step: 'restoring', message: `Getting ${account.callsign} back…` });
    const openRes = await postToCommunity(finalAnchorUrl, '/api/recovery/collect', { candidatePublicKey: account.publicKey }, ephIdentity);
    if (!openRes.ok) throw await refusedBy(openRes, 'collect', options.provider);
    const openBody = await openRes.json().catch(() => null);
    const collectionId = openBody?.collectionId;
    if (typeof collectionId !== 'string' || !collectionId) {
        throw new Error('Node did not return a valid recovery session ID.');
    }

    // 7. The released copy, sealed to the throwaway key, opened with it.
    let fragments = await fetchReleasedFragments(finalAnchorUrl, collectionId, ephIdentity);
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
    /** The member's communities, when the copy carried a list (vault rethink VR5): saved once the account is. */
    let restoredCommunities: CopyCommunity[] | null = null;

    if (isSingleBlobSso(ssoFrag.kdfParams)) {
        // New-format single-blob SSO: entire seed is sealed in this one fragment, and the 12 words with
        // it when the phone that connected the sign-in had them.
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
        restoredCommunities = opened.communities;
        // Why a copy gave no words, never the words themselves. 'absent' is every copy made before copies
        // carried them, and every copy from a phone without them: the ordinary case, and not a problem.
        if (opened.wordsStatus === 'unreadable' || opened.wordsStatus === 'mismatch') {
            console.log(`[SSO-RECOVERY] ${options.provider}: the copy's 12 words ${opened.wordsStatus === 'mismatch'
                ? 'make a different key' : 'did not open'}; restoring the key alone`);
        }
    } else {
        // Old-format two-layer split (seed = A ⊕ B): request hub fragment (A), then combine with B.
        const hubRes = await signedPost(finalAnchorUrl, '/api/recovery/collect/hub', {
            collectionId,
        }, ephIdentity);

        if (!hubRes.ok) {
            const err = await hubRes.json().catch(() => ({}));
            throw new Error(err.error || `Hub release failed (${hubRes.status})`);
        }

        fragments = await fetchReleasedFragments(finalAnchorUrl, collectionId, ephIdentity);
        const hubFrag = fragments.find(f => f.holderType === 'hub');
        if (!hubFrag) {
            throw new Error('Hub recovery piece was not returned by the node.');
        }

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

    // 8. The key must be the one the find named for the account picked, compared case-folded as the web compares it.
    // Another key (a wrong or stale copy, a community answering for someone else) stops here, before the gate below:
    // nothing on the phone changes.
    if (restoredKeypair.publicKeyHex.toLowerCase() !== account.publicKey) {
        console.log(`[SSO-RECOVERY] ${options.provider}: the copy opened to another key than the account the find named; nothing saved`);
        throw new CommunityRestoreRefused({ code: 'not_that_account', name: account.callsign });
    }

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
        // The name the find gives the account picked.
        callsign: account.callsign,
        createdAt: new Date().toISOString(),
        ...(mnemonic ? { mnemonic } : {}),
    };

    // 9. Never over another account without the member's yes: until then nothing on the phone changes.
    const cleared = await clearToRestore(restoredIdentity, options.confirmReplace);

    // 10. Save the anchor URL and the identity, and end any half-finished join wizard. Replacing another account, its
    // app storage goes first (restore-account.ts `saveRestoredAccount`). Nothing after the gate reads the old anchor:
    // every node call above went to `finalAnchorUrl`.
    await saveRestoredAccount(cleared, finalAnchorUrl);
    // The copy's list of communities, when it carried one: saved beside the community the account was restored at. Never
    // fails the restore.
    await saveCommunitiesFromCopy(restoredCommunities);

    options.onProgress?.({ step: 'done', message: 'Account restored successfully!' });
    return {
        identity: cleared.identity,
        provider: options.provider,
    };
}

// ─── A build with a key vault ─────────────────────────────────────────────────────────────

/**
 * The sign-ins BeanPool's key vault said, in its own signed answer to this phone's last restore with each, that it keeps
 * no copy for, in this run of the app (PR #1336 review finding 3). A member whose copy is still at their community
 * (made before the vault, and never moved) gets back in there with such a sign-in, exactly as a build without a vault
 * restores ({@link recoverAccountWithSso}), and the move card is offered at once.
 *
 * Only the vault's signed "no copy" counts (utils/vault.ts `VaultFailure` 'no_copy'). An answer the phone can't check,
 * a 5xx, a timeout or no answer at all never does: otherwise a server at the vault's address could send members down
 * the old path. Each restore with a provider starts by forgetting it, so it is always the vault's latest word.
 *
 * Kept per provider, not per sign-in account: a "no copy" for one Google account opens the community's restore to
 * another Google account on this phone too, until the next restore with Google. That exposes nothing new: the
 * community's copy answers a build without a vault, for any account, anyway.
 */
const noCopyAtVault = new Set<SsoProvider>();

/**
 * Whether the vault's signed answer to this phone's last restore with `provider`, whichever of its accounts, was "no
 * copy" ({@link noCopyAtVault}: per provider, not per sign-in account).
 */
export function vaultKeepsNoCopyFor(provider: SsoProvider): boolean {
    return noCopyAtVault.has(provider);
}

/**
 * Sign in with `provider` and ask the vault for this account's copy. Resolves with the hold: when it goes through.
 * `onSignedIn` runs once the provider is done (the screen brings the app back to the front there). `signal`, aborted
 * before the restore is sent, sends nothing. A restore this phone already started keeps its key, so the same sign-in
 * comes back to the same hold ("Start again", a restart, a lost answer). The vault's signed "no copy" is kept for
 * {@link vaultKeepsNoCopyFor}, and thrown as ever.
 */
export async function startSsoRestore(
    provider: SsoProvider,
    options: { signal?: AbortSignal; onSignedIn?: () => void | Promise<void> } = {},
): Promise<PendingVaultRestore> {
    noCopyAtVault.delete(provider);
    try {
        return await startVaultRestore(provider, (p, nonce) => signInWithProvider(p, nonce), options);
    } catch (e) {
        if (e instanceof VaultError && e.reason === 'no_copy') noCopyAtVault.add(provider);
        throw e;
    }
}

/** The restore this phone is waiting on, or null. Nothing is asked of the vault. */
export async function waitingSsoRestore(): Promise<PendingVaultRestore | null> {
    return loadPendingVaultRestore();
}

/** Ask the vault for the restore this phone is waiting on. Null when there is none waiting. */
export async function checkSsoRestore(): Promise<VaultCollect | null> {
    const pending = await loadPendingVaultRestore();
    if (!pending?.holdId) return null;
    return collectVaultRestore(pending);
}

/**
 * Forget the restore this phone is waiting on, key and all. Not what "Start again" or "Use my 12 words instead" do: the
 * key is what lets the same sign-in come back to its hold ({@link startSsoRestore}), and a hold whose key is gone can't
 * be collected or replaced for up to two days (PR #1336 review finding 2). See {@link stopSsoRestoreAfterWords}.
 */
export async function abandonSsoRestore(): Promise<void> {
    await clearPendingVaultRestore();
}

/**
 * After the 12 words brought an account back on this phone:
 * - whatever the phone knew about a vault copy for the account is forgotten, so the next app open asks the vault and
 *   this phone sees, and can stop, any sign-in restore of it (confirmation review NEW-1);
 * - a sign-in restore this phone left waiting is stopped at the vault with the account's own key, so the member's
 *   devices stop asking "Is this you?" about their own phone, and the phone forgets it. A hold the vault won't stop for
 *   this key (another account's, or one already over) stays on record: its own sign-in may still collect it, and
 *   collecting one that is over forgets it.
 * Never throws.
 */
export async function stopSsoRestoreAfterWords(identity: VaultSigner): Promise<void> {
    if (!hasVault()) return;
    await forgetVaultCopyKnowledge(identity.publicKey);
    const pending = await loadPendingVaultRestore();
    if (!pending) return;
    // No hold on record: the answer was lost, so there is nothing this phone can name to stop.
    if (!pending.holdId) return clearPendingVaultRestore();
    try {
        await stopVaultHold(identity, pending.holdId);
        await clearPendingVaultRestore();
    } catch (e) {
        console.log(`[VAULT] the restore left waiting was not stopped: ${(e as Error).message}`);
    }
}

/**
 * Save the account the vault released onto `anchorUrl`, the community the member chose. Never over another account
 * without the member's yes (`confirmReplace`); the name comes from that community (`nameOnNode`).
 */
export async function finishSsoRestore(
    restored: RestoredFromVault,
    anchorUrl: string,
    options: { confirmReplace?: ConfirmReplace; nameOnNode: NameOnNode },
): Promise<BeanPoolIdentity> {
    const identity = await restoreFromVault(restored, anchorUrl, { ...options, clearPending: clearPendingVaultRestore });
    // The vault keeps a copy for this account (it just released one): its holds are worth asking about at app open.
    await noteVaultCopy(identity.publicKey, true);
    // The copy's list of communities, when it carried one (vault rethink VR5): the rest of the member's communities, saved
    // beside the one they chose. Never fails the restore.
    await saveCommunitiesFromCopy(restored.communities);
    return identity;
}
