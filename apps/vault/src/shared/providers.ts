import { isSsoProvider, type SsoProvider } from '@beanpool/signin';

/**
 * The sign-in providers the vault keeps copies for and releases them to. The one list: dropping a provider (Facebook
 * once the app stops offering it, or GitHub if Marty decides so) is deleting its entry here. A provider not listed is
 * refused at every route before anything else runs; the checks themselves are @beanpool/signin's.
 */
export const VAULT_PROVIDERS: readonly SsoProvider[] = ['google', 'apple', 'facebook', 'github'];

export function isVaultProvider(value: unknown): value is SsoProvider {
    return isSsoProvider(value) && VAULT_PROVIDERS.includes(value);
}
