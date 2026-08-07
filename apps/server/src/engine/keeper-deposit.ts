import {
    verifyGoogleIdToken,
    getConfiguredGoogleAudiences,
    ssoLookupHash,
    newSsoLookupSalt,
    SsoVerificationError,
} from '../sso-google.js';
import {
    putShareGeneration,
    RecoveryShareError,
    type KeeperShareInput,
} from './recovery-shares.js';

/**
 * Depositing a keeper generation that includes a Google (K4) fragment.
 *
 * THE ONE PROPERTY THIS FILE EXISTS FOR
 * ------------------------------------
 * `sso_lookup_hash` is derived HERE, from the `sub` inside a token this node just verified — never
 * taken from the request. If the client supplied it, anyone could deposit a fragment indexed under
 * someone else's Google account and then "recover" it by signing in as themselves; the lookup is
 * what a restore flow searches on, so a client-controlled value is a client-controlled account
 * takeover. A request that carries one is refused rather than ignored, because a client sending it
 * is a client that believes it decides identity, and silently overwriting the value would leave
 * that belief intact until it mattered.
 *
 * WHY A WHOLE GENERATION
 * ----------------------
 * `putShareGeneration` writes every fragment of a split together and drops the previous generation
 * in the same transaction (#214). There is no single-fragment writer, so "add Google as a keeper"
 * is really "re-split and store the new set". That is not overhead — fragments from two different
 * splits cannot be recombined, so a partial write is an unrecoverable account, discovered only at
 * restore.
 */

export class KeeperDepositError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KeeperDepositError';
    }
}

export interface GoogleKeeperDeposit {
    /** The authenticated caller — `ctx.state.actor`. Owner of the split. */
    ownerPubkey: string;
    /** The COMPLETE new generation. Exactly one fragment must be the Google one. */
    shares: KeeperShareInput[];
    /** Google `id_token` from the client. */
    googleIdToken: string;
    /** The nonce this node issued to THIS member (see issueNonce). */
    nonce: string;
}

export interface GoogleKeeperResult {
    generation: number;
    /** For display only — "Google (m•••@gmail.com)". Never persisted. */
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

export async function depositGoogleKeeperGeneration(
    deposit: GoogleKeeperDeposit,
): Promise<GoogleKeeperResult> {
    const { ownerPubkey, shares, googleIdToken, nonce } = deposit;

    if (!ownerPubkey) throw new KeeperDepositError('No member is signed in for this deposit.');
    if (!Array.isArray(shares) || shares.length === 0) {
        throw new KeeperDepositError('No recovery fragments were supplied.');
    }

    const ssoShares = shares.filter(s => s.holderType === 'sso');
    // Split rather than one message (CR): the two cases need different actions from the caller, and
    // "got 0" versus "got 2" reads as the same mistake when it is not.
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
    // Only inspecting `ssoShare` left the invariant enforced on one row out of three: a hash set on
    // a 'device' or 'hub' fragment sailed through and was persisted verbatim. That matters because
    // findShareBySsoLookup matches on `sso_lookup_hash` alone with NO holder_type filter, so a
    // planted row is returned as the match — the column, not the keeper type, is what a restore
    // resolves. Whether that is reachable today depends on a restore flow which does not exist yet,
    // which is exactly why it should not be left for that flow to be written around.
    if (shares.some(s => s.ssoLookupHash || s.ssoLookupSalt)) {
        throw new KeeperDepositError(
            'The lookup hash for a sign-in keeper is derived by the node, not supplied by the client.',
        );
    }

    // Order matters: verify BEFORE touching storage. A failed sign-in must leave the existing
    // generation exactly as it was — the member's current keepers are what they fall back on.
    let identity;
    try {
        identity = await verifyGoogleIdToken(
            googleIdToken,
            getConfiguredGoogleAudiences(),
            nonce,
            ownerPubkey,
        );
    } catch (e) {
        if (e instanceof SsoVerificationError) throw e;
        throw new KeeperDepositError(`Google sign-in could not be checked: ${(e as Error).message}`);
    }

    const salt = newSsoLookupSalt();
    const lookupHash = await ssoLookupHash('google', identity.sub, salt);

    const resolved: KeeperShareInput[] = shares.map(s =>
        s === ssoShare
            ? {
                  ...s,
                  // 'google' rather than the sub: holder_ref is shown to the member and takes part in
                  // the UNIQUE(owner, generation, holder_type, holder_ref) constraint, so it must not
                  // carry the identifier the lookup hash exists to keep out of the database.
                  holderRef: 'google',
                  ssoLookupHash: lookupHash,
                  ssoLookupSalt: salt,
              }
            : s,
    );

    try {
        const generation = putShareGeneration(ownerPubkey, resolved);
        return { generation, email: maskEmail(identity.email), shareCount: resolved.length };
    } catch (e) {
        if (e instanceof RecoveryShareError) throw e;
        throw new KeeperDepositError(`Could not store the recovery fragments: ${(e as Error).message}`);
    }
}
