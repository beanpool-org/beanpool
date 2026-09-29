import { isSsoProvider, type SsoProvider } from '@beanpool/signin';

/**
 * The sign-in providers the vault keeps copies for and releases them to. The one list: dropping a provider (Facebook
 * once the app stops offering it) is deleting its entry here. A provider not listed is refused at every route before
 * anything else runs, and a copy for one goes when the database next opens (api/server.ts dropRetiredCopies); the
 * checks themselves are @beanpool/signin's. GitHub was dropped (Marty, 2026-09-29): its `sub` is the account's public
 * user id, so a copy locked to it is locked to nothing its owner controls.
 */
export const VAULT_PROVIDERS: readonly SsoProvider[] = ['google', 'apple', 'facebook'];

export function isVaultProvider(value: unknown): value is SsoProvider {
    return isSsoProvider(value) && VAULT_PROVIDERS.includes(value);
}
