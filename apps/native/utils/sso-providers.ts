/**
 * The sign-ins BeanPool offers for protecting and restoring an account, and nothing else.
 *
 * Kept free of React Native and Expo, so anything that reads a provider name from outside the app's own code (a node's
 * answer, a record an earlier build saved on the phone) can check it here without loading a sign-in sheet. A name
 * that is not one of these is dropped where it is read, never shown and never counted.
 */

/** Every provider, in the order the app lists them. Apple is offered on the iPhone only (the lists say so). */
export const SSO_PROVIDERS = ['apple', 'google', 'facebook'] as const;

export type SsoProvider = typeof SSO_PROVIDERS[number];

/** What a member reads for each provider. */
export const SSO_PROVIDER_NAMES: Record<SsoProvider, string> = {
    apple: 'Apple',
    google: 'Google',
    facebook: 'Facebook',
};

export function isSsoProvider(value: unknown): value is SsoProvider {
    return typeof value === 'string' && (SSO_PROVIDERS as readonly string[]).includes(value);
}

/** The providers in `values` this app offers, in their order there. Anything that is not a list gives none. */
export function offeredProviders(values: unknown): SsoProvider[] {
    return Array.isArray(values) ? values.filter(isSsoProvider) : [];
}
