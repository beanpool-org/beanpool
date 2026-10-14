import crypto from 'node:crypto';
import { SsoVerificationError } from './errors.js';
import type { JwksCache } from './jwks.js';
import {
    providerConfig,
    type SsoIdentity,
    type SsoProvider,
} from './providers.js';

/**
 * OIDC `id_token` verification for the sign-in keyholder. Zero dependencies.
 *
 * Was `sso-google.ts` (#218), then `apps/server/src/sso.ts`. Moved here unchanged so that the key vault
 * checks a sign-in with exactly the code every community uses (key vault V1). Everything below the
 * provider table (providers.ts) is OIDC.
 *
 * WHY NO LIBRARY
 * --------------
 * `jose` would do this in three lines and is well regarded. It is not used because every
 * self-hosted node ships this code, and D5 already forces the design to be the kind that needs
 * no secrets; adding a dependency to the trust path of an account-recovery keyholder is a cost
 * paid by operators who cannot audit it. Node's `crypto` builds an RSA key straight from a JWK
 * and verifies RS256 natively, so the whole thing is standard-library calls.
 *
 * WHAT THIS IS FOR
 * ----------------
 * K4 in the keyholder model: "your sign-in account". Signing in with Google or Apple does NOT log
 * anybody in and creates no account (D9) — it returns ONE fragment of a Shamir split. The only
 * thing this module establishes is *which provider account* is presenting itself, as a stable
 * `sub`.
 *
 * NO CLIENT SECRET, EITHER PROVIDER. This is D5, and it is why these two providers survived D11.
 * Apple's `.p8` key and the 6-month client-secret JWT belong to the authorization-code exchange
 * (`/auth/token`) and to `/auth/revoke`. We never call either: both the native flow and the web
 * `form_post` hand us the `id_token` directly, and it verifies against public JWKS. So there is
 * no secret to rotate and no expiry to miss.
 *
 * WHAT IS ACTUALLY CHECKED, and why each one matters:
 *
 *   signature   RS256 against the provider's published JWKS. Without it everything below is
 *               decoration.
 *   alg         pinned to RS256 and read from the header ONLY to reject anything else. The classic
 *               JWT breaks are `alg: none` and HS256-with-the-public-key-as-HMAC-secret; both are
 *               impossible here because the algorithm is never chosen from the token.
 *   kid         selects the key. Both providers publish several and rotate them.
 *   iss         the provider's issuer, exactly. Google uses two spellings; Apple uses one.
 *   aud         must be one of OUR client IDs. This is the check that distinguishes "a valid
 *               provider token" from "a token issued to us" — without it, any app's token
 *               verifies, which is token substitution.
 *   exp / iat   with a small clock skew allowance, because self-hosted nodes are not NTP-perfect.
 *   nonce       must equal the one the caller issued. Every node accepts the same audiences, so
 *               without nonce binding a token obtained at one node is replayable at every other
 *               node in the federation. See issueNonce() in apps/server/src/sso.ts.
 *
 * NOT checked here: `email_verified`. Email is not an identifier in this design — `sub` is. An
 * account with an unverified email still has a stable, unique `sub`, and the keeper lookup is a
 * hash of the subject, never the address. This matters more for Apple than for Google: Apple's
 * private-relay addresses are per-app aliases, and Apple omits the email entirely on every sign-in
 * after the first.
 */

/**
 * Ceiling on a token before it is split, decoded or verified.
 *
 * Real `id_token`s are ~1 KB — Google's runs to about 1.3 KB with the profile scope attached,
 * Apple's to roughly 0.9 KB — so 8 KB is several times any legitimate token and rejects nothing
 * real. Without it, `decodeSegment` must `JSON.parse` the header before anything is verified (the
 * `kid` lives there), so a 10 MB base64 blob buys an attacker a multi-megabyte buffer allocation
 * and a large JSON parse per request, on 1-CPU VMs, for free.
 *
 * Review called this defence-in-depth on the grounds that the route's rate limiter bounds it. That
 * is the right instinct and the wrong fact: the routes did not exist yet, so there was no limiter,
 * and the guard that belongs in the verifier should not be waiting on the layer above to be written.
 * Same reasoning as making ssoLookupHash async in #218 — cheapest to fix while the function has no
 * callers.
 */
export const MAX_ID_TOKEN_BYTES = 8192;

/** Tolerance for exp/iat. Nodes run on cheap VMs whose clocks drift; 2 minutes is enough to
 *  survive that without meaningfully extending the life of a stolen token. */
export const CLOCK_SKEW_SECONDS = 120;

/** Nonces expire fast. The window only has to cover one sign-in round trip. */
export const NONCE_TTL_MS = 10 * 60 * 1000;

/** Constant-time compare of the token's nonce against one candidate spelling of ours. */
function nonceEquals(presented: Buffer, candidate: string): boolean {
    const expected = Buffer.from(candidate, 'utf-8');
    return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

function decodeSegment(segment: string, label: string): any {
    try {
        return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
    } catch {
        throw new SsoVerificationError(`${label} token is not valid JWT JSON`);
    }
}

/**
 * Apple sends `email_verified` and `is_private_email` as the STRINGS "true"/"false" in some
 * flows and as real booleans in others. #218 read it with `typeof === 'boolean'`, which silently
 * dropped Apple's string form to undefined. Nothing depends on the value — email is not an
 * identifier here — but a field that is sometimes right and sometimes undefined is worse than one
 * that is simply absent, because the next person to use it will not know which they have.
 */
function coerceBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
}

/** The proof a sign-in arrives with: the provider's `id_token`. */
export interface SignInCredential {
    idToken?: string;
}

/** The credential in a deposit, collect or join body: its `idToken`. */
export function signInCredentialFrom(body: unknown): SignInCredential {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
    return { idToken: typeof b.idToken === 'string' && b.idToken ? b.idToken : undefined };
}

/** What a verifier is built from. Nothing here reaches a database or a node's config. */
export interface SignInVerifierOptions {
    /** Where the providers' signing keys come from: one createJwksCache() per process. */
    jwks: Pick<JwksCache, 'getSigningKey'>;
    /**
     * Spend the nonce issued to `subject`: true only when it was issued to them, is unspent and has
     * not expired. Called only once the token's nonce has MATCHED `expectedNonce` (see the note in
     * verifyIdToken), and must leave a nonce that belongs to someone else unspent.
     */
    consumeNonce: (nonce: string, subject: string) => boolean;
    /** Milliseconds since the epoch, for `exp` and `iat`. Defaults to `Date.now()`. */
    now?: () => number;
}

export interface SignInVerifier {
    verifyIdToken(
        provider: SsoProvider,
        idToken: string,
        allowedAudiences: string[],
        expectedNonce: string,
        subject: string,
    ): Promise<SsoIdentity>;
    verifySignIn(
        provider: SsoProvider,
        credential: SignInCredential,
        allowedAudiences: string[],
        expectedNonce: string,
        subject: string,
    ): Promise<SsoIdentity>;
}

export function createSignInVerifier(options: SignInVerifierOptions): SignInVerifier {
    const { jwks, consumeNonce } = options;
    const now = options.now ?? (() => Date.now());

    /**
     * Verify a provider `id_token`.
     *
     * @param provider           which provider's rules to apply. Never taken from the token — a token
     *                           is checked against the issuer the CALLER named, so a Google token
     *                           presented as an Apple one fails on the issuer rather than quietly
     *                           being filed under Apple.
     * @param idToken            the raw JWT from the client
     * @param allowedAudiences   the caller's accepted client IDs for that provider. A caller that has
     *                           none configured cannot verify anything, and says so rather than
     *                           accepting a token it cannot bind to itself.
     * @param expectedNonce      the nonce the caller issued for this sign-in. Required — see the
     *                           replay note at the top of the file.
     * @param subject            the authenticated caller. The nonce must have been issued to
     *                           THEM; a nonce issued to someone else is refused even if valid.
     */
    async function verifyIdToken(
        provider: SsoProvider,
        idToken: string,
        allowedAudiences: string[],
        expectedNonce: string,
        subject: string,
    ): Promise<SsoIdentity> {
        // First, before any check or request: a provider this package does not know is refused by name.
        const config = providerConfig(provider);
        if (!subject) {
            throw new SsoVerificationError(
                `A ${config.label} sign-in must be verified against a known member.`,
            );
        }
        if (!allowedAudiences?.length) {
            throw new SsoVerificationError(
                `This node has no ${config.label} client ID configured, so it cannot verify a `
                + `${config.label} sign-in.`,
            );
        }
        if (!expectedNonce) {
            throw new SsoVerificationError(`${config.label} sign-in is missing its nonce.`);
        }

        // Length first, before split/decode/parse — see MAX_ID_TOKEN_BYTES. Byte length, not character
        // length: a JWT is base64url so the two agree, but measuring what is actually allocated is the
        // point of the check.
        if (typeof idToken === 'string' && Buffer.byteLength(idToken, 'utf-8') > MAX_ID_TOKEN_BYTES) {
            throw new SsoVerificationError(`${config.label} token is implausibly large.`);
        }

        // Facebook has no special case: its OIDC id_token takes the path below, the same as Google's
        // and Apple's. An access token is refused as malformed, never sent to Graph — Graph answers for
        // a token from ANY app, and only the app secret can ask which one issued it (D5).
        const parts = idToken?.split('.');
        if (!parts || parts.length !== 3) {
            throw new SsoVerificationError(`${config.label} token is malformed.`);
        }
        const [headerB64, payloadB64, signatureB64] = parts;

        const header = decodeSegment(headerB64, config.label);
        // Pinned, not selected. The algorithm is never taken from the token — this reads it purely to
        // refuse anything that is not RS256, which is what closes alg-confusion and `alg: none`.
        // Both providers sign with RS256.
        if (header.alg !== 'RS256') {
            throw new SsoVerificationError(
                `${config.label} token uses unexpected algorithm ${header.alg}`,
            );
        }
        if (!header.kid) throw new SsoVerificationError(`${config.label} token has no key id.`);

        const jwk = await jwks.getSigningKey(provider, header.kid);
        const publicKey = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });

        const signed = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
        const signature = Buffer.from(signatureB64, 'base64url');
        if (!crypto.verify('RSA-SHA256', signed, publicKey, signature)) {
            throw new SsoVerificationError(`${config.label} token signature is not valid.`);
        }

        // Everything below this line is only meaningful because the signature held.
        const claims = decodeSegment(payloadB64, config.label);

        if (!config.issuers.includes(claims.iss)) {
            throw new SsoVerificationError(`${config.label} token has wrong issuer (${claims.iss})`);
        }
        if (!claims.aud || !allowedAudiences.includes(claims.aud)) {
            throw new SsoVerificationError(
                `${config.label} token was issued to a different application.`,
            );
        }

        const nowSeconds = Math.floor(now() / 1000);
        if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
            throw new SsoVerificationError(`${config.label} token has expired.`);
        }
        if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
            throw new SsoVerificationError(`${config.label} token is dated in the future.`);
        }

        // Compared in constant time, then consumed. The comparison guards the value; the consume makes
        // it single-use.
        //
        // DELIBERATE: the nonce is consumed only when it MATCHED. Review suggested consuming
        // unconditionally so single-use holds "regardless of match result" — declined, because a
        // mismatch means this token was not issued for this request, and burning the pending nonce on
        // someone else's bad token turns a failed attempt into a denial of service against the person
        // legitimately signing in.
        //
        // Nothing is gained by consuming early. Replay requires a token that is validly signed by the
        // provider AND carries this exact nonce; that path consumes, and is covered by a test. An
        // attacker cannot mint a token bearing a nonce they do not know, so unlimited failed attempts
        // within the TTL buy them nothing. Unconsumed nonces are bounded by NONCE_TTL_MS and the sweep.
        //
        // This does assume the caller binds `expectedNonce` to the requesting session rather than
        // taking it from the request body — otherwise an attacker could aim failures at someone else's
        // pending nonce. That is a constraint on the route, and it is why this is written down here.
        const presented = Buffer.from(String(claims.nonce ?? ''), 'utf-8');
        let nonceMatches = nonceEquals(presented, expectedNonce);
        if (!nonceMatches && config.nonceMayBeHashed) {
            // See OidcProviderConfig.nonceMayBeHashed. Apple's native flow conventionally carries
            // SHA-256(nonce); the digest of 32 random bytes is exactly as unguessable as the nonce.
            nonceMatches = nonceEquals(
                presented,
                crypto.createHash('sha256').update(expectedNonce, 'utf-8').digest('hex'),
            );
        }
        // No exception for a token that carries no nonce, Google's included. Consuming the caller's
        // nonce proves nothing about a token that does not name it: it is bound to no request, so a
        // node it was once shown to could replay it anywhere, under a nonce of its own.
        if (!nonceMatches || !consumeNonce(expectedNonce, subject)) {
            throw new SsoVerificationError(
                `${config.label} sign-in could not be matched to this request.`,
            );
        }

        if (!claims.sub) throw new SsoVerificationError(`${config.label} token has no subject.`);

        return {
            provider,
            sub: String(claims.sub),
            email: claims.email ? String(claims.email) : undefined,
            emailVerified: coerceBoolean(claims.email_verified),
            privateEmail: coerceBoolean(claims.is_private_email),
            audience: String(claims.aud),
            issuedAt: Number(claims.iat ?? 0),
            expiresAt: Number(claims.exp),
        };
    }

    /** Verify a sign-in, whichever provider it is: its `id_token`, through verifyIdToken. The one entry point every route uses. */
    async function verifySignIn(
        provider: SsoProvider,
        credential: SignInCredential,
        allowedAudiences: string[],
        expectedNonce: string,
        subject: string,
    ): Promise<SsoIdentity> {
        return verifyIdToken(provider, credential.idToken ?? '', allowedAudiences, expectedNonce, subject);
    }

    return { verifyIdToken, verifySignIn };
}
