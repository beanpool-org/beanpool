/**
 * Getting an account back with a sign-in ("Recover with Social"), through BeanPool's key vault (utils/vault.ts; key
 * vault design §1.3, V4). No name and no community address: the sign-in itself finds the copy, and no community is
 * asked for anything until the account is back.
 *
 * 1. {@link startSsoRestore}: a throwaway key, a restore ticket for it (checked against the vault's pinned keys before
 *    any sheet opens), the provider's sheet with the ticket's nonce, then `/v1/restore`. Every restore is held (D2):
 *    24 hours, or less once a phone or computer that has the account taps "Yes, it's me". That device is told at once
 *    and can Stop it.
 * 2. {@link checkSsoRestore}: asks the vault, while the member waits and whenever the app comes back. Released: the
 *    copy opens with the throwaway key and the sign-in's subject, and counts only if its seed makes the key the
 *    vault's release names. The 12 words come back when the copy carried them and they make that key.
 * 3. {@link finishSsoRestore}: the member chooses the community to go to, global by default (as a 12-words restore
 *    asks for one), and the account is saved through "Replace this phone's account?" when the phone holds another.
 *
 * The waiting restore lives on this phone (SecureStore, this device only) until the account is saved, so a restart, a
 * lost answer or a failed save comes back to the same hold.
 */

import { signInWithProvider } from './sso-signin';
import type { SsoProvider } from './sso-providers';
import type { BeanPoolIdentity } from './identity';
import { restoreFromVault, type ConfirmReplace } from './restore-account';
import {
    clearPendingVaultRestore,
    collectVaultRestore,
    loadPendingVaultRestore,
    startVaultRestore,
    type PendingVaultRestore,
    type RestoredFromVault,
    type VaultCollect,
} from './vault';

export type { PendingVaultRestore, RestoredFromVault, VaultCollect } from './vault';

/**
 * Sign in with `provider` and ask the vault for this account's copy. Resolves with the hold: when it goes through.
 * `onSignedIn` runs once the provider is done (the screen brings the app back to the front there). `signal`, aborted
 * before the restore is sent, sends nothing.
 */
export async function startSsoRestore(
    provider: SsoProvider,
    options: { signal?: AbortSignal; onSignedIn?: () => void | Promise<void> } = {},
): Promise<PendingVaultRestore> {
    return startVaultRestore(provider, (p, nonce) => signInWithProvider(p, nonce), options);
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

/** Stop waiting on this phone: the member chose to start again, or to use their 12 words instead. */
export async function abandonSsoRestore(): Promise<void> {
    await clearPendingVaultRestore();
}

/**
 * Save the account the vault released onto `anchorUrl`, the community the member chose. Never over another account
 * without the member's yes (`confirmReplace`); the name comes from that community (`nameOnNode`).
 */
export async function finishSsoRestore(
    restored: RestoredFromVault,
    anchorUrl: string,
    options: { confirmReplace?: ConfirmReplace; nameOnNode: (publicKey: string) => Promise<string | null> },
): Promise<BeanPoolIdentity> {
    return restoreFromVault(restored, anchorUrl, { ...options, clearPending: clearPendingVaultRestore });
}
