import { SsoVerificationError } from './errors.js';

export type SsoProvider = 'google' | 'apple' | 'facebook' | 'github';

// ─── the provider table ───────────────────────────────────────────────────────────────────────
//
// Everything provider-specific is here. If a third provider is ever un-paused, it is an entry in
// this table plus its audiences (audiences.ts), and nothing in verify.ts changes.

export interface OidcProviderConfig {
    kind: 'oidc';
    /** Human name, used in error messages the member may end up reading. */
    label: string;
    /** Hardcoded rather than discovered: a discovery fetch would be one more failure mode at
     *  recovery time, and neither URL has moved. */
    jwksUri: string;
    issuers: string[];
    /**
     * Whether the provider may echo SHA-256(nonce) instead of the nonce.
     *
     * Apple only. Apple's native `ASAuthorization` flow is conventionally driven with a hashed
     * nonce — the pattern every SDK sample follows is "hash it, send the hash to Apple, keep the
     * raw one" — and reports differ on whether the value comes back hashed or verbatim depending
     * on platform and SDK. Accepting both costs nothing: the nonce is 32 random bytes, so its
     * SHA-256 is no more guessable than the nonce itself, and an attacker needs one or the other
     * to forge anything. Getting this wrong in the strict direction fails the way this project
     * likes least — silently, at recovery, months later.
     *
     * Google is left strict because Google echoes the nonce verbatim and always has. A tolerance
     * with no failure mode behind it is just a wider door.
     */
    nonceMayBeHashed: boolean;
}

/**
 * A provider with no token a node could check. GitHub: not OIDC, and the only endpoint that says which
 * app a token belongs to needs the client secret. So the node (or the key vault) runs the device flow
 * itself (github-device.ts) and the client hands in the session id, never a token.
 */
export interface NodeRunProviderConfig {
    kind: 'node-run';
    label: string;
}

export type ProviderConfig = OidcProviderConfig | NodeRunProviderConfig;

const PROVIDERS: Record<SsoProvider, ProviderConfig> = {
    google: {
        kind: 'oidc',
        label: 'Google',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        // Both spellings appear in real Google tokens.
        issuers: ['accounts.google.com', 'https://accounts.google.com'],
        nonceMayBeHashed: false,
    },
    apple: {
        kind: 'oidc',
        label: 'Apple',
        jwksUri: 'https://appleid.apple.com/auth/keys',
        issuers: ['https://appleid.apple.com'],
        nonceMayBeHashed: true,
    },
    facebook: {
        kind: 'oidc',
        label: 'Facebook',
        jwksUri: 'https://www.facebook.com/.well-known/oauth/openid/jwks/',
        issuers: ['https://www.facebook.com', 'https://facebook.com', 'https://limited.facebook.com'],
        nonceMayBeHashed: false,
    },
    github: {
        kind: 'node-run',
        label: 'GitHub',
    },
};

export function isSsoProvider(value: unknown): value is SsoProvider {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/** The provider's name as a member reads it ("Google"), for messages about their account. */
export function ssoProviderLabel(provider: SsoProvider): string {
    return providerConfig(provider).label;
}

/**
 * The providers this package can verify, in the order they are offered.
 *
 * Derived from the table rather than written out anywhere, so un-pausing a provider (D11) is one
 * row here and no stale list elsewhere claiming otherwise. A member reading "Supported: google,
 * apple" on a node that also does Facebook has been told something false by a message whose whole
 * job was to tell them what to do next.
 */
export const SSO_PROVIDERS = Object.keys(PROVIDERS) as SsoProvider[];

/** The provider's rules. An unknown provider is refused by name. */
export function providerConfig(provider: SsoProvider): ProviderConfig {
    const config = PROVIDERS[provider];
    // Reachable from a route that forwards a body field. Named rather than a crash, because the
    // whole point of holder_ref is that it is a provider we verified against.
    if (!config) throw new SsoVerificationError(`Unknown sign-in provider '${provider}'.`);
    return config;
}

/**
 * What an app that hands this node a GitHub token is told. Only an app from before the node ran the
 * GitHub sign-in itself does that, so the next step is an update; the 12 words work either way.
 */
export const GITHUB_TOKEN_REFUSED =
    'Update BeanPool to connect GitHub. This community\'s node now runs the GitHub sign-in itself, so it no '
    + 'longer accepts a GitHub token from the app. Your 12 words still work.';

/** The rules for a provider whose `id_token` is checked. GitHub has none, and is refused by name. */
export function oidcConfig(provider: SsoProvider): OidcProviderConfig {
    const config = providerConfig(provider);
    if (config.kind !== 'oidc') throw new SsoVerificationError(GITHUB_TOKEN_REFUSED);
    return config;
}

export interface SsoIdentity {
    provider: SsoProvider;
    /** Stable, unique per account per developer team/client. THE identifier — never the email. */
    sub: string;
    /**
     * Present for display only ("Google (m•••@gmail.com)"). Never used for lookup.
     *
     * Routinely ABSENT for Apple: Apple returns the email on the first authorization only, and a
     * member re-adding Apple as a keeper is by definition not on their first. An undefined email
     * is normal, not a failure.
     */
    email?: string;
    emailVerified?: boolean;
    /** True when Apple issued a private-relay alias rather than the real address. */
    privateEmail?: boolean;
    /** Which of our client IDs the token was issued to. */
    audience: string;
    issuedAt: number;
    expiresAt: number;
}
