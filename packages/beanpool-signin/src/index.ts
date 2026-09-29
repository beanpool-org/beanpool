/**
 * @beanpool/signin: the sign-in checks a community node and the key vault share (key vault V1).
 *
 * Google, Apple and Facebook `id_token`s are verified here (verify.ts) against the providers' published keys
 * (jwks.ts). Nothing in this package reads a database, a logger or a node's config: the caller passes in how it
 * spends a nonce, which client ids it accepts (audiences.ts), and, for tests, its fetch and its clock.
 */
export { SsoVerificationError, SsoProviderUnavailableError } from './errors.js';
export {
    SSO_PROVIDERS,
    isSsoProvider,
    ssoProviderLabel,
    providerConfig,
    type SsoProvider,
    type SsoIdentity,
    type OidcProviderConfig,
} from './providers.js';
export {
    createJwksCache,
    parseMaxAge,
    type Jwk,
    type JwksEntry,
    type JwksStore,
    type JwksCache,
    type JwksCacheOptions,
    type FetchLike,
} from './jwks.js';
export {
    createSignInVerifier,
    signInCredentialFrom,
    MAX_ID_TOKEN_BYTES,
    CLOCK_SKEW_SECONDS,
    NONCE_TTL_MS,
    type SignInCredential,
    type SignInVerifier,
    type SignInVerifierOptions,
} from './verify.js';
export {
    BEANPOOL_GOOGLE_CLIENT_IDS,
    BEANPOOL_APPLE_BUNDLE_ID,
    BEANPOOL_APPLE_SERVICES_ID,
    BEANPOOL_FACEBOOK_APP_ID,
    appleServicesId,
    defaultAudiences,
    configuredAudiences,
    webClientId,
    webClientIds,
    type AudienceSettings,
    type WebSignInProvider,
} from './audiences.js';
