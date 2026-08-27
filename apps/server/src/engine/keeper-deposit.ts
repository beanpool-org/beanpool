import {
    verifyIdToken,
    getConfiguredAudiences,
    isSsoProvider,
    ssoLookupHash,
    newSsoLookupSalt,
    SsoVerificationError,
    SSO_PROVIDERS,
    type SsoProvider,
} from '../sso.js';
import {
    putShareGeneration,
    getCurrentShares,
    RecoveryShareError,
    type KeeperShareInput,
} from './recovery-shares.js';

/**
 * Depositing a keeper generation that includes a sign-in (K3) fragment — Google or Apple.
 *
 * THE ONE PROPERTY THIS FILE EXISTS FOR
 * ------------------------------------
 * `sso_lookup_hash` is derived HERE, from the `sub` inside a token this node just verified — never
 * taken from the request. If the client supplied it, anyone could deposit a fragment indexed under
 * someone else's provider account and then "recover" it by signing in as themselves; the lookup is
 * what a restore flow searches on, so a client-controlled value is a client-controlled account
 * takeover. A request that carries one is refused rather than ignored, because a client sending it
 * is a client that believes it decides identity, and silently overwriting the value would leave
 * that belief intact until it mattered.
 *
 * The provider gets the same treatment for the same reason. `holderRef` is not the string the
 * request asked for — it is the provider whose issuer, audience and signature the token actually
 * satisfied. A request claiming 'apple' with a Google token fails verification rather than filing
 * a Google fragment under Apple, which would be undiscoverable until the member tried to recover
 * with the wrong account and was told, correctly and uselessly, that no fragment matched.
 *
 * WHY A WHOLE GENERATION
 * ----------------------
 * `putShareGeneration` writes every fragment of a split together and drops the previous generation
 * in the same transaction (#214). There is no single-fragment writer, so "add Google as a keeper"
 * is really "re-split and store the new set". That is not overhead — fragments from two different
 * splits cannot be recombined, so a partial write is an unrecoverable account, discovered only at
 * restore.
 *
 * It also means Google and Apple cannot both be added in one call: each deposit is a fresh split,
 * so adding the second provider is a re-split that carries the first one's fragment along. That is
 * a constraint on the route, and the multi-`sso` rejection below is where it is enforced.
 */

export class KeeperDepositError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KeeperDepositError';
    }
}

export interface SsoKeeperDeposit {
    /** Which provider the client believes it signed in with. Verified, not trusted. */
    provider: SsoProvider;
    /** The authenticated caller — `ctx.state.actor`. Owner of the split. */
    ownerPubkey: string;
    /** The COMPLETE new generation. Exactly one fragment must be the sign-in one. */
    shares: KeeperShareInput[];
    /** The provider's `id_token` from the client. */
    idToken: string;
    /** The nonce this node issued to THIS member (see issueNonce). */
    nonce: string;
}

export interface SsoKeeperResult {
    generation: number;
    /** The provider that actually verified. Equals the requested one or the call threw. */
    provider: SsoProvider;
    /**
     * For display only — "Google (m•••@gmail.com)". Never persisted.
     *
     * Routinely undefined for Apple, which returns the email on first authorization only. The
     * keeper list must render "Apple" on its own rather than treating a missing address as an
     * error; there is nothing wrong and nothing to retry.
     */
    email?: string;
    shareCount: number;
}

/** Mask an email for the keeper list. `martin@cytec.com.au` → `m•••@cytec.com.au`. */
export function maskEmail(email: string | undefined): string | undefined {
    if (!email) return undefined;
    // Trimmed first (CR): a stray leading space otherwise becomes the "initial", rendering as
    // ' •••@domain' in the keeper list.
    const trimmed = email.trim();
    const at = trimmed.indexOf('@');
    if (at <= 0) return undefined;
    return `${trimmed[0]}•••${trimmed.slice(at)}`;
}

export async function depositSsoKeeperGeneration(
    deposit: SsoKeeperDeposit,
): Promise<SsoKeeperResult> {
    const { provider, ownerPubkey, shares, idToken, nonce } = deposit;

    // Checked before anything else because `provider` becomes `holderRef`, which is a stored,
    // member-visible string taking part in a UNIQUE constraint. An unrecognised value must not
    // reach storage even by way of a verification error.
    if (!isSsoProvider(provider)) {
        // The supported list comes from the provider table, not from this line (CR). Un-pausing a
        // provider is one row in sso.ts, and a hardcoded list here would go stale silently — in a
        // message whose entire job is to tell the caller which values are valid. `String()` rather
        // than bare interpolation because a symbol would throw inside the template.
        throw new KeeperDepositError(
            `'${String(provider)}' is not a sign-in provider this node can verify. `
            + `Supported: ${SSO_PROVIDERS.join(', ')}.`,
        );
    }
    if (!ownerPubkey) throw new KeeperDepositError('No member is signed in for this deposit.');
    if (!Array.isArray(shares) || shares.length === 0) {
        throw new KeeperDepositError('No recovery fragments were supplied.');
    }

    const ssoShares = shares.filter(s => s.holderType === 'sso');
    if (ssoShares.length === 0) {
        throw new KeeperDepositError(
            "This deposit has no 'sso' fragment. Use putShareGeneration directly for a split that "
            + 'does not include a sign-in keeper.',
        );
    }
    if (ssoShares.length > 1) {
        throw new KeeperDepositError(
            `Only one sign-in keeper can be deposited at a time, got ${ssoShares.length}. Deposit `
            + 'each provider through its own verified flow.',
        );
    }
    const ssoShare = ssoShares[0];

    // Refused, not ignored, and checked across EVERY fragment rather than just the sso one (CR).
    if (shares.some(s => s.ssoLookupHash || s.ssoLookupSalt)) {
        throw new KeeperDepositError(
            'The lookup hash for a sign-in keeper is derived by the node, not supplied by the client.',
        );
    }

    // Order matters: verify BEFORE touching storage. A failed sign-in must leave the existing
    // generation exactly as it was — the member's current keepers are what they fall back on.
    let identity;
    try {
        identity = await verifyIdToken(
            provider,
            idToken,
            getConfiguredAudiences(provider),
            nonce,
            ownerPubkey,
        );
    } catch (e) {
        if (e instanceof SsoVerificationError) throw e;
        throw new KeeperDepositError(`Sign-in could not be checked: ${(e as Error).message}`);
    }

    const salt = newSsoLookupSalt();
    const lookupHash = await ssoLookupHash(identity.provider, identity.sub, salt);

    const current = getCurrentShares(ownerPubkey);
    // Find existing SSO shares for other active providers to carry over
    const existingOtherSso = current.filter(
        s => s.holderType === 'sso' && s.holderRef !== identity.provider && s.ssoLookupHash && s.ssoLookupSalt
    );

    let nextIndex = 1;
    const finalShares: KeeperShareInput[] = [];

    // 1. Hub share
    const hubShare = shares.find(s => s.holderType === 'hub');
    if (hubShare) {
        finalShares.push({ ...hubShare, shareIndex: nextIndex++ });
    }

    // 2. Newly verified SSO share
    finalShares.push({
        ...ssoShare,
        holderType: 'sso',
        holderRef: identity.provider,
        shareIndex: nextIndex++,
        ssoLookupHash: lookupHash,
        ssoLookupSalt: salt,
    });

    // 3. Existing other SSO shares
    for (const existing of existingOtherSso) {
        finalShares.push({
            holderType: 'sso',
            holderRef: existing.holderRef,
            shareIndex: nextIndex++,
            encryptedShare: existing.encryptedShare,
            shareIv: existing.shareIv,
            shareTag: existing.shareTag,
            ssoLookupHash: existing.ssoLookupHash,
            ssoLookupSalt: existing.ssoLookupSalt,
            kdfParams: existing.kdfParams,
        });
    }

    // 4. Member shares (if any)
    const memberShares = shares.filter(s => s.holderType === 'member');
    for (const ms of memberShares) {
        finalShares.push({ ...ms, shareIndex: nextIndex++ });
    }

    try {
        const generation = putShareGeneration(ownerPubkey, finalShares);
        return {
            generation,
            provider: identity.provider,
            email: maskEmail(identity.email),
            shareCount: finalShares.length,
        };
    } catch (e) {
        if (e instanceof RecoveryShareError) throw e;
        throw new KeeperDepositError(`Could not store the recovery fragments: ${(e as Error).message}`);
    }
}
