/**
 * The key vault's sentences a member reads in their language, marked with word() and keyed by plain codes; the screen
 * that shows one translates it with t() (welcome.tsx, RecoveryAlertBanner.tsx).
 *
 * Not in vault.ts on purpose: vault.ts opens a sign-in copy to the account's seed, so it is on the 12 words' key path,
 * and nothing on that path may reach the words layer (#1944, core __tests__/recovery-path-files.test.ts). vault.ts keeps
 * plain English and the vault's codes, and never imports this file (vault-phone.test.ts).
 */
import { word, type TFunction } from '@beanpool/core';

export const VAULT_WORDS = {
    /**
     * checkSsoRestore's `{status: 'stopped'}`: also the answer when a newer restore of the same account, from another
     * device, took this one's place (server.ts /v1/restore): F6, case 16, so it doesn't say a phone stopped it. Only the
     * phone app can Stop (the web app has no vault client), so it says a phone, never a computer.
     */
    stopped: word("This restore was stopped, from a phone that has your account or by a newer restore started on another device, so nothing came back. If that wasn't you, use your 12 words."),
    /**
     * A Stop (or "Yes, it's me") after the other device already collected (VaultError code `collected`): it has the
     * account now. The same English as vault.ts VAULT_MESSAGES.holdCollected, the error's own message.
     */
    /** VaultError reason `rate_limited`, signed or not (VLT-01): the same English as vault.ts VAULT_MESSAGES.tooMany. */
    tooMany: word('Too many tries just now. Please try again later.'),
    holdCollected: word("That restore has already gone through: the other phone has your account now. If it wasn't you, someone else has your account: make sure the sign-in account it used is yours alone, and ask your community's admins for help."),
} as const;

/**
 * Whether a vault error is "too many tries just now" (vault.ts VaultError reason `rate_limited`). Read by its fields, not
 * `instanceof`: this file never imports vault.ts's native modules for a screen that only shows words.
 */
export function vaultTooMany(e: unknown): boolean {
    const err = e as { name?: unknown; reason?: unknown } | null;
    return err?.name === 'VaultError' && err.reason === 'rate_limited';
}

/** A vault error as the member reads it: too many tries in their language (VLT-01), anything else in its own words. */
export function vaultErrorText(e: unknown, t: TFunction): string {
    return vaultTooMany(e) ? t(VAULT_WORDS.tooMany) : (e as Error).message;
}
