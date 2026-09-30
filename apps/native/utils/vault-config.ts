/**
 * Where this build's key vault is, and so where its members' sign-in copies are kept (utils/vault.ts has the rest).
 * Kept apart from vault.ts, with no native modules, so any screen or helper can ask which kind of build it is.
 */

import { isVaultKeyHex, vaultUnb64 } from '@beanpool/core';
import { isPlainNodeAddress, shouldBlockCleartextNodeUrl } from './node-url';

export interface VaultConfig {
    /** `https://vault.beanpool.org` in a release build; a test vault's address in a test build. No trailing slash. */
    url: string;
    /** The vault's Ed25519 ticket keys (hex), newest first. A ticket signed by none of them is refused. */
    ticketKeys: string[];
    /** The vault's X25519 deposit keys (base64url), newest first. A deposit is sealed to the first. */
    depositKeys: string[];
}

/**
 * A vault from its three build values, or null when any is missing or malformed: an address that isn't a plain
 * `https://host[:port]` (plain http only on a private address, for a test vault on a laptop), or a key list
 * (comma-separated, newest first) that is empty or holds anything but keys.
 */
export function readVaultConfig(url: string | undefined, ticketKeys: string | undefined, depositKeys: string | undefined): VaultConfig | null {
    const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const address = (url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/?#@\\]+$/i.test(address) || !isPlainNodeAddress(address) || shouldBlockCleartextNodeUrl(address)) return null;
    const tickets = list(ticketKeys);
    const deposits = list(depositKeys);
    if (!tickets.length || !tickets.every(isVaultKeyHex)) return null;
    if (!deposits.length || !deposits.every(k => vaultUnb64(k, 32)?.length === 32)) return null;
    return { url: address, ticketKeys: tickets, depositKeys: deposits };
}

/**
 * This build's vault. Expo writes `process.env.EXPO_PUBLIC_*` into the app when it is built (babel-preset-expo), so
 * each is read by its full name, never through a variable. Public keys and an address: nothing secret. Until the
 * custodians' parts are reshared, only a test vault's values go in a build: never point a real build at a live vault.
 */
export function vaultConfig(): VaultConfig | null {
    return readVaultConfig(
        process.env.EXPO_PUBLIC_BEANPOOL_VAULT_URL,
        process.env.EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS,
        process.env.EXPO_PUBLIC_BEANPOOL_VAULT_DEPOSIT_KEYS,
    );
}

/** Whether this build has a vault. Without one, sign-in copies stay at the member's community ({@link signInCopiesAt}). */
export function hasVault(): boolean {
    return vaultConfig() !== null;
}

/**
 * Where this build keeps members' sign-in copies, and so where it deposits, checks, disconnects and restores them:
 * - `'vault'`: BeanPool's key vault, when the build has one ({@link vaultConfig}: an address and both pinned key lists,
 *   all well formed). Everything in this file.
 * - `'community'`: otherwise, the member's own community, exactly as the app did before the vault (utils/sso-signin.ts
 *   `startSsoSignIn`, keeper-enrolment.ts, sso-recovery.ts `recoverAccountWithSso`, global-join.ts's copy in the join).
 *
 * Nothing in between: a build with a missing or malformed vault value is a community build, so no build ends up with
 * neither (the release gate, PR #1336 review finding 6). app.config.js refuses a build that sets only some of the three.
 */
export type SignInCopies = 'vault' | 'community';

export function signInCopiesAt(): SignInCopies {
    return hasVault() ? 'vault' : 'community';
}
