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
 * each is read by its full name, never through a variable. Public keys and an address: nothing secret. A real build
 * may point at the live vault (Marty, 2026-10-05): until the reshare one person holds all three shares, as
 * apps/vault/README.md says, and the reshare comes before the public launch.
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
 * A community's rule for where members' copies go (vault rethink VR2; apps/server config/recovery-copies.ts): its
 * /api/community/info says `recoveryCopies`. `vault`, the default: BeanPool's key vault, in a build that has one.
 * `server`: the community's own server keeps them. `none`: this community keeps none and its screens offer none.
 */
export type RecoveryCopiesRule = 'vault' | 'server' | 'none';

/**
 * The rule an info answer's `recoveryCopies` says. Not said (a server from before the rule): `vault`, the default, which
 * is what every build did there. Anything else is a rule this version doesn't know, read as `none`: a copy is never made
 * where the community may not want one.
 */
export function readRecoveryCopiesRule(v: unknown): RecoveryCopiesRule {
    if (v === undefined || v === null) return 'vault';
    return v === 'vault' || v === 'server' ? v : 'none';
}

/**
 * Where a sign-in copy is kept, and so where it is deposited, checked, disconnected and restored:
 * - `'vault'`: BeanPool's key vault, when the build has one ({@link vaultConfig}: an address and both pinned key lists,
 *   all well formed). Everything in this file.
 * - `'community'`: otherwise, the member's own community, exactly as the app did before the vault (utils/sso-signin.ts
 *   `startSsoSignIn`, keeper-enrolment.ts, sso-recovery.ts `recoverAccountWithSso`, global-join.ts's copy in the join).
 *   The restore from a community's copy, `recoverAccountWithSso`, is not only a community build's: a vault build runs it
 *   too, with a provider the vault said, signed, that it keeps no copy for (sso-recovery.ts `vaultKeepsNoCopyFor`, PR
 *   #1336 review finding 3).
 * - `'none'`: nowhere, for a community whose rule is `none`.
 *
 * Nothing in between: a build with a missing or malformed vault value is a community build, so no build ends up with
 * neither (the release gate, PR #1336 review finding 6). app.config.js refuses a build that sets only some of the three.
 *
 * With a community's rule (VR2), the community decides where a copy made from its screens goes: `server` keeps it at
 * the community whatever the build, `none` keeps none, and `vault` keeps it where the build does. Without one (no rule
 * asked, as for a restore, which finds a copy wherever it is), the build's own place, as before the rule. A copy a
 * member already has stays where it is under any rule: the rule decides only where a new one goes.
 */
export type SignInCopies = 'vault' | 'community' | 'none';

export function signInCopiesAt(): 'vault' | 'community';
export function signInCopiesAt(rule: RecoveryCopiesRule | null | undefined): SignInCopies;
export function signInCopiesAt(rule?: RecoveryCopiesRule | null): SignInCopies {
    if (rule === 'none') return 'none';
    if (rule === 'server') return 'community';
    return hasVault() ? 'vault' : 'community';
}
