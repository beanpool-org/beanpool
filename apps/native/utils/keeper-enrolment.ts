/**
 * Sign-in recovery: what protects a member's account, as the screens read it.
 *
 * ## Where the copy lives (key vault design, V4)
 *
 * A linked sign-in account works because BeanPool's key vault keeps a locked copy of the account for it
 * (utils/vault.ts). No community keeps one, and none is asked for one: the deposit, the status, the disconnect and
 * the restore all go to the vault, whatever community the phone is on. The copy itself is what the apps have always
 * sealed ({@link sealSsoShares}: the seed, and the 12 words when this phone has them, under scrypt(provider:sub)); the
 * vault wraps it again under its own key and never holds the plain seed.
 *
 * ## What happens at signup
 *
 * Nothing. At signup a member is sovereign: no copy anywhere, just the 12 words. A sign-in copy is added later, when
 * the member links Google, Apple or Facebook (Account Protection, or Safety Backup's Connect). {@link enrolKeepers}
 * still runs at signup to keep the call site's contract, and returns nothing enrolled.
 *
 * The one exception is joining the global community (utils/global-join.ts): its door needs a sign-in anyway, so that
 * one sign-in also deposits the copy at the vault (the door's shared ticket, design §5.4), and Safety Backup shows it as
 * protecting the member without asking again.
 */

import {
    recoveryWordsMatchSeed,
    sealSeedToSso,
    toEd25519Seed,
    type SealedShare,
} from '@beanpool/core';
import { hexToBytes } from './crypto';
import { getMnemonic, type BeanPoolIdentity } from './identity';
import { offeredProviders, type SsoProvider } from './sso-providers';
import {
    depositWithVault, disconnectFromVault, VaultError, vaultStatus, type VaultFailure,
} from './vault';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The keeper kinds this function can enrol.
 *
 * Retired: `'device'` — the two-layer model has no device fragment. See
 * docs/recovery-model.md §"Where the fragments actually live".
 */
export type EnrolledKeeper = 'hub' | 'member' | 'sso';

export interface KeeperEnrolmentResult {
    /** Keepers that actually received a piece. The step 3 state is chosen by counting this. */
    enrolled: EnrolledKeeper[];
    /** The node's generation number, or null if nothing was uploaded. Always null for a copy at the vault. */
    generation: number | null;
    /** Why a keeper was not enrolled — for logs and for deciding what step 3 offers next. */
    skipped: { keeper: string; reason: string }[];
    /**
     * How many keepers were AVAILABLE, which is not the same as how many were enrolled.
     *
     * At signup this is 0 — no keepers are available until the member adds them later
     * through SSO sign-in or add-a-friend. Step 3 reads this as "your words are the way back".
     */
    available: number;
    /** Specific SSO providers currently protecting the account. */
    enrolledSso?: string[];
    /** Effective threshold required for recovery. */
    threshold?: number;
    /** Whether single-blob SSO format is in use. */
    isSingleBlob?: boolean;
    /** Whether this deposit carries the 12 words, so a sign-in restore from it gives them back. */
    wordsSealed?: boolean;
    /** Set when enrolment did not happen at all, in words a member can read (the vault's, or ours). */
    error?: string;
    /** Why, when the vault said: a paused vault (`locked`) is offered again at the next app open. */
    failure?: VaultFailure;
    /** This sign-in account protected a different BeanPool account until now (the vault told that account's devices). */
    replaced?: boolean;
}

// ---------------------------------------------------------------------------
// Signup entry point — sovereign by default
// ---------------------------------------------------------------------------

/**
 * Called at signup. A new member is sovereign until they link a sign-in, so this does nothing and says so.
 *
 * Never throws. The call site contract is unchanged: `welcome.tsx` fires this in a
 * `useEffect`, renders `protectionFrom(result)`, and the words-only screen is correct
 * for every member at signup.
 */
export async function enrolKeepers(_identity: BeanPoolIdentity): Promise<KeeperEnrolmentResult> {
    return {
        enrolled: [],
        generation: null,
        skipped: [],
        available: 0,
        enrolledSso: [],
    };
}

/** The sign-ins the vault keeps a copy for, as an enrolment result: the screens' one shape. */
export function enrolmentFromVault(providers: readonly string[], extra: Partial<KeeperEnrolmentResult> = {}): KeeperEnrolmentResult {
    const enrolledSso = offeredProviders(providers);
    return {
        enrolled: enrolledSso.map(() => 'sso' as const),
        generation: null,
        skipped: [],
        available: enrolledSso.length,
        enrolledSso,
        threshold: 1,
        isSingleBlob: true,
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// Linking a sign-in — the deposit at the vault
// ---------------------------------------------------------------------------

/**
 * What the deposit proves itself with: the vault's deposit ticket for this member's key, and the provider's
 * `id_token`, which carries the ticket's hash as its nonce (utils/vault.ts `vaultTicket`).
 */
export interface SsoEnrolmentInput {
    identity: BeanPoolIdentity;
    provider: SsoProvider;
    /** The provider's subject (user id): the copy is sealed to it. */
    sub: string;
    idToken: string;
    ticket: string;
}

/**
 * Seal the member's seed (and the 12 words, when this phone has them) to the sign-in, and deposit it at the vault.
 * Resolves with the one sign-in it linked; the screens read the rest from the vault's status.
 *
 * Never throws: a failure comes back as `error`, in words for the member, and `failure` says why (a paused vault is
 * offered again at the next app open, utils/vault.ts `rememberConnectWanted`).
 */
export async function enrolSsoKeeper(input: SsoEnrolmentInput): Promise<KeeperEnrolmentResult> {
    const { identity, provider, sub } = input;
    const nothing = (error: string, failure?: VaultFailure): KeeperEnrolmentResult => {
        // Logged, not just returned: every enrolment failure to date has been invisible in
        // logcat, so the only evidence was the member reporting that nothing happened.
        console.log(`[KEEPER] ${provider}: enrolment failed — ${failure ?? 'local'}: ${error}`);
        return { enrolled: [], generation: null, skipped: [], available: 0, error, ...(failure ? { failure } : {}) };
    };

    // The 12 words are never required: a phone restored from a sign-in copy made before copies carried
    // them holds none (they can't be rebuilt from the seed), and it belongs to exactly the member who
    // most needs a connected sign-in. Such a phone deposits the seed alone.
    let sealed: SealedSsoShares;
    try {
        sealed = await sealSsoShares(identity, provider, sub);
    } catch (e) {
        return nothing(`Your account couldn't be locked to this sign-in (${(e as Error).message}). Nothing was linked.`);
    }

    try {
        const deposit = await depositWithVault({
            identity,
            provider,
            ticket: input.ticket,
            idToken: input.idToken,
            clientCopy: sealed.shares[0],
            wordsSealed: sealed.wordsSealed,
        });
        console.log(`[KEEPER] ${provider}: deposited at the key vault${deposit.replaced ? ' (replaced another account\'s copy)' : ''}`);
        return enrolmentFromVault([provider], { wordsSealed: deposit.wordsSealed, replaced: deposit.replaced });
    } catch (e) {
        if (e instanceof VaultError) return nothing(e.message, e.reason);
        return nothing((e as Error).message || 'The sign-in could not be linked.');
    }
}

/** The deposit's one piece: the whole seed (and the words, when they make it) sealed to a sign-in. */
export interface SealedSsoShares {
    shares: Array<SealedShare & { holderType: 'sso'; holderRef: SsoProvider; shareIndex: 1 }>;
    /** Whether the 12 words travel with the seed, so a sign-in restore gives them back. */
    wordsSealed: boolean;
}

/**
 * Seal the member's entire seed (and the 12 words, when this phone has them) into a single
 * device-encrypted AEAD blob under scrypt(provider:sub): the copy a deposit carries.
 *
 * Shared by the two deposits, both at the vault: {@link enrolSsoKeeper} (the protection sheet, its own sign-in) and the
 * global community's door (utils/global-join.ts), whose one sign-in both joins and protects. Throws with a reason for a
 * log, never words or keys.
 */
export async function sealSsoShares(identity: BeanPoolIdentity, provider: SsoProvider, sub: string): Promise<SealedSsoShares> {
    // The identity's privateKey is either a raw 32-byte Ed25519 seed or a
    // 48-byte PKCS8 envelope (as created by the PWA), hex-encoded.
    let seed: Uint8Array;
    try {
        seed = toEd25519Seed(hexToBytes(identity.privateKey));
    } catch (e) {
        throw new Error(`could not read the private key: ${(e as Error).message}`);
    }

    // When this phone has the 12 words, they travel with the seed, so a sign-in restore gives them back
    // (keeper-crypto.ts sealSeedToSso). Only words that make this seed's key: anything else would be
    // thrown away at restore, so it is left out here and the seed goes alone. Never the words in a log.
    const words = await getMnemonic(identity);
    const sealWords = words && recoveryWordsMatchSeed(words, seed) ? words : null;
    if (words && !sealWords) {
        console.log(`[KEEPER] ${provider}: this phone's 12 words do not make its key; sealing the key alone`);
    }

    // Seal the entire 32-byte Ed25519 seed to the SSO provider under scrypt(provider:sub).
    let ssoSealed: SealedShare;
    try {
        ssoSealed = await sealSeedToSso(seed, provider, sub, { words: sealWords });
    } catch (e) {
        throw new Error(`could not seal the SSO fragment: ${(e as Error).message}`);
    }

    return {
        shares: [{ holderType: 'sso', holderRef: provider, shareIndex: 1, ...ssoSealed }],
        wordsSealed: !!sealWords,
    };
}

// ---------------------------------------------------------------------------
// Status and disconnect — at the vault
// ---------------------------------------------------------------------------

/**
 * What protects this account: the sign-ins the vault keeps a copy for. Throws {@link VaultError} when the vault
 * can't say (paused, unreachable, or no vault in this build): the screen then shows what it can say for certain.
 */
export async function vaultProtection(identity: BeanPoolIdentity): Promise<KeeperEnrolmentResult> {
    const status = await vaultStatus(identity);
    return enrolmentFromVault(status.providers);
}

/**
 * Disconnect one sign-in: the vault deletes its copy at once. Resolves with the sign-ins still linked, as the vault
 * says after the delete.
 */
export async function disconnectSsoKeeper(
    provider: SsoProvider,
    identity: BeanPoolIdentity,
): Promise<{ success: boolean; error?: string; enrolledSso?: string[] }> {
    try {
        await disconnectFromVault(identity, provider);
    } catch (e) {
        return { success: false, error: (e as Error).message };
    }
    try {
        return { success: true, enrolledSso: (await vaultStatus(identity)).providers };
    } catch {
        return { success: true };
    }
}
