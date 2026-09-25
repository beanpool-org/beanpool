/**
 * Sign-in recovery at the web door (design G11 §4.3, G11-c; Marty, D-1 = a, 2026-09-25): the browser join enrols the
 * sign-in it joined with as this member's way back, in the same request, as the phone's join does.
 *
 * ## What is sealed, and to what
 *
 * The account's key, as the raw 32-byte Ed25519 seed, and its 12 words when they make that key, sealed with core's
 * `sealSeedToSso` to `provider:sub` (the sign-in's own id for the account: the token's `sub` claim, or GitHub's poll
 * answer). The browser keeps its key as 48-byte PKCS8 (identity.ts), the phone as the bare seed; `toEd25519Seed`
 * takes either, so what is sealed is the seed in both cases, and a phone restore (or the web's, G11-d) gets a key it
 * can sign with. The body is the phone's, byte for byte: `apps/native/utils/keeper-enrolment.ts sealSsoShares`
 * builds the same shares from the same key and sign-in, and both clients are held to one frozen list
 * (`@beanpool/core/sso-share-vectors`).
 *
 * ## Never a gate
 *
 * `sealJoinRecovery` never throws. A key it cannot read, or a seal that fails, gives null: the join goes without a
 * copy, nothing is written here, and Settings then says the sign-in is not connected. The 12 words are still the
 * key. Nothing here touches the pending join: the seal needs only the key and the words it already holds, and
 * whatever it makes lives only in the request.
 *
 * ## The cost
 *
 * One scrypt at `N = 16384, r = 8, p = 1` (about 16 MB), measured in headless Chromium for G11-c (see the PR). The page
 * says "Securing your account…" while it runs.
 */

import { recoveryWordsMatchSeed, sealSeedToSso, toEd25519Seed, type SealedShare } from '@beanpool/core';
import { hexToBytes } from '@noble/hashes/utils.js';
import { getMnemonic, type BeanPoolIdentity, type JoinProvider } from './identity';
import { providerLabel } from './web-join';

/** The one piece a join carries: the whole seed (and the words, when they make it) sealed to the sign-in. */
export type JoinRecoveryShare = SealedShare & { holderType: 'sso'; holderRef: JoinProvider; shareIndex: 1 };

/** `recovery` in the `POST /api/join` body: what `POST /api/recovery/shares/sso` takes, minus the sign-in it already carries. */
export interface SealedJoinRecovery {
    shares: JoinRecoveryShare[];
    /** Whether the 12 words travel with the seed, so a sign-in restore gives them back. Not sent. */
    wordsSealed: boolean;
}

/**
 * Seal `identity`'s key (and its 12 words, when they make it) to this sign-in, as the join's `recovery`. Null when
 * it could not be made; the reason goes to the console, never the words or the key.
 */
export async function sealJoinRecovery(identity: BeanPoolIdentity, provider: JoinProvider, sub: string): Promise<SealedJoinRecovery | null> {
    let seed: Uint8Array | null = null;
    try {
        try {
            seed = toEd25519Seed(hexToBytes(identity.privateKey));
        } catch (e) {
            throw new Error(`could not read the private key: ${(e as Error).message}`);
        }
        // Only words that make this key: anything else would be thrown away at restore, so the seed goes alone.
        const words = await getMnemonic(identity);
        const sealWords = words && recoveryWordsMatchSeed(words, seed) ? words : null;
        if (words && !sealWords) console.warn(`[JoinRecovery] ${provider}: this browser's 12 words do not make its key; sealing the key alone`);
        const sealed = await sealSeedToSso(seed, provider, sub, { words: sealWords });
        return {
            shares: [{ holderType: 'sso', holderRef: provider, shareIndex: 1, ...sealed }],
            wordsSealed: !!sealWords,
        };
    } catch (e) {
        console.warn(`[JoinRecovery] ${provider}: no recovery copy with the join: ${(e as Error)?.message || e}`);
        return null;
    } finally {
        // A copy of the key, made for the seal: not left lying about once it is done.
        seed?.fill(0);
    }
}

/**
 * The node's word on the copy, from its answer to the join (`recovery` in a 200): `enrolled: true` when it stored it.
 * Anything else (no `recovery`, `enrolled: false` with the reason it could not store it) is not connected.
 */
export function recoveryStored(answered: unknown): boolean {
    return !!answered && typeof answered === 'object' && (answered as { enrolled?: unknown }).enrolled === true;
}

/**
 * The sign-ins the node names (its `enrolledSso`) as a member reads them: "Google", "Google and GitHub", "Google,
 * Apple and GitHub". One this app has no name for is left out rather than shown as the node spells it. Null when none.
 */
export function signInNames(providers: readonly string[]): string | null {
    const names = [...new Set(providers)]
        .filter((p): p is JoinProvider => ['google', 'apple', 'facebook', 'github'].includes(p))
        .map(providerLabel);
    if (names.length === 0) return null;
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
