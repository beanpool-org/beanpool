import crypto from 'node:crypto';

/**
 * OIDC `id_token` verification for the sign-in keyholder. Zero dependencies, same as totp.ts.
 *
 * Was `sso-google.ts` (#218). Generalised here because Apple is the second and last provider
 * (D11 pauses Facebook and GitHub), and the shape of the second one is what shows which parts of
 * the first were Google and which were OIDC. Everything below the provider table is OIDC.
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
 *   nonce       must equal the one this node issued. Every node accepts the same audiences, so
 *               without nonce binding a token obtained at one node is replayable at every other
 *               node in the federation. See issueNonce() below.
 *
 * NOT checked here: `email_verified`. Email is not an identifier in this design — `sub` is. An
 * account with an unverified email still has a stable, unique `sub`, and the keeper lookup is a
 * hash of the subject, never the address. This matters more for Apple than for Google: Apple's
 * private-relay addresses are per-app aliases, and Apple omits the email entirely on every sign-in
 * after the first.
 */

export type SsoProvider = 'google' | 'apple' | 'facebook' | 'github';

export class SsoVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SsoVerificationError';
    }
}

// ─── the provider table ───────────────────────────────────────────────────────────────────────
//
// Everything provider-specific is here. If a third provider is ever un-paused, it is an entry in
// this table plus its audiences, and nothing below changes.

interface ProviderConfig {
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

const PROVIDERS: Record<SsoProvider, ProviderConfig> = {
    google: {
        label: 'Google',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        // Both spellings appear in real Google tokens.
        issuers: ['accounts.google.com', 'https://accounts.google.com'],
        nonceMayBeHashed: false,
    },
    apple: {
        label: 'Apple',
        jwksUri: 'https://appleid.apple.com/auth/keys',
        issuers: ['https://appleid.apple.com'],
        nonceMayBeHashed: true,
    },
    facebook: {
        label: 'Facebook',
        jwksUri: 'https://www.facebook.com/.well-known/oauth/openid/jwks/',
        issuers: ['https://www.facebook.com', 'https://facebook.com', 'https://limited.facebook.com'],
        nonceMayBeHashed: false,
    },
    github: {
        label: 'GitHub',
        jwksUri: '',
        issuers: ['https://github.com'],
        nonceMayBeHashed: false,
    },
};

export function isSsoProvider(value: unknown): value is SsoProvider {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/**
 * The providers this node can verify, in the order they are offered.
 *
 * Derived from the table rather than written out anywhere, so un-pausing a provider (D11) is one
 * row here and no stale list elsewhere claiming otherwise. A member reading "Supported: google,
 * apple" on a node that also does Facebook has been told something false by a message whose whole
 * job was to tell them what to do next.
 */
export const SSO_PROVIDERS = Object.keys(PROVIDERS) as SsoProvider[];

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
 * is the right instinct and the wrong fact: the routes do not exist yet, so today there is no
 * limiter, and the guard that belongs in the verifier should not be waiting on the layer above to
 * be written. Same reasoning as making ssoLookupHash async in #218 — cheapest to fix while the
 * function has no callers.
 */
const MAX_ID_TOKEN_BYTES = 8192;

function providerConfig(provider: SsoProvider): ProviderConfig {
    const config = PROVIDERS[provider];
    // Reachable from a route that forwards a body field. Named rather than a crash, because the
    // whole point of holder_ref is that it is a provider we verified against.
    if (!config) throw new SsoVerificationError(`Unknown sign-in provider '${provider}'.`);
    return config;
}

/** Tolerance for exp/iat. Nodes run on cheap VMs whose clocks drift; 2 minutes is enough to
 *  survive that without meaningfully extending the life of a stolen token. */
const CLOCK_SKEW_SECONDS = 120;

/** Nonces expire fast. The window only has to cover one sign-in round trip. */
const NONCE_TTL_MS = 10 * 60 * 1000;

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

interface Jwk {
    kid: string;
    kty: string;
    alg?: string;
    use?: string;
    n: string;
    e: string;
}

// ─── JWKS cache ───────────────────────────────────────────────────────────────────────────────
//
// Both providers rotate signing keys and publish a Cache-Control max-age. Honouring it matters in
// both directions: fetching per verification would make the provider a hard dependency of every
// recovery attempt, and caching forever would break the day they rotate.
//
// KEYED BY PROVIDER, and that is not tidiness. A single shared cache was the obvious way to
// generalise #218's module-level variable, and it is wrong: whichever provider fetched last owns
// the cache, so every token from the other provider misses on its kid, triggers the
// refetch-once path, clobbers the cache in turn, and the two providers evict each other on every
// single verification. Worse, a kid collision across providers would select the wrong issuer's
// key. Separate entries make cross-provider key confusion unrepresentable rather than unlikely.
//
// The refetch-once-on-unknown-kid path below is the important one. A rotation that lands between
// our cache being populated and expiring would otherwise fail every verification for the rest of
// the TTL, and the user's symptom would be "recovery is broken" with nothing in the logs to say why.

const jwksCache = new Map<SsoProvider, { keys: Jwk[]; expiresAt: number }>();
const inFlight = new Map<SsoProvider, Promise<Jwk[]>>();

function parseMaxAge(cacheControl: string | null): number {
    const m = cacheControl?.match(/max-age=(\d+)/);
    const seconds = m ? parseInt(m[1], 10) : NaN;
    // Clamp: a hostile or broken header must not pin us to a key set for a week, nor cause a
    // fetch storm. 5 minutes to 24 hours.
    if (!Number.isFinite(seconds)) return 3600_000;
    return Math.min(Math.max(seconds, 300), 86_400) * 1000;
}

async function fetchJwks(provider: SsoProvider): Promise<Jwk[]> {
    // Coalesce concurrent misses into one request, so a node restarting under load does not open
    // a connection per in-flight verification. Per provider, for the same reason the cache is.
    const pending = inFlight.get(provider);
    if (pending) return pending;

    const config = providerConfig(provider);
    const request = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
            const res = await fetch(config.jwksUri, { signal: controller.signal });
            if (!res.ok) {
                throw new SsoVerificationError(`${config.label} JWKS fetch failed: HTTP ${res.status}`);
            }
            const body = await res.json() as { keys?: Jwk[] };
            const keys = (body.keys ?? []).filter(k => k.kty === 'RSA' && k.n && k.e && k.kid);
            if (!keys.length) {
                throw new SsoVerificationError(`${config.label} JWKS contained no usable RSA keys`);
            }
            jwksCache.set(provider, {
                keys,
                expiresAt: Date.now() + parseMaxAge(res.headers.get('cache-control')),
            });
            return keys;
        } finally {
            clearTimeout(timeout);
            inFlight.delete(provider);
        }
    })();

    inFlight.set(provider, request);
    return request;
}

async function getSigningKey(provider: SsoProvider, kid: string): Promise<Jwk> {
    // `refetched` is what makes "refetch once" true (CR finding on #218). Without it an expired
    // cache fetched here, missed on the kid, and then fetched AGAIN immediately — two round trips
    // for identical data, and exactly the provider-hammering the comment below claims to prevent.
    // A garbage kid arriving against a cold cache was the cheapest way to trigger it.
    let refetched = false;
    const cached = jwksCache.get(provider);
    if (!cached || cached.expiresAt <= Date.now()) {
        await fetchJwks(provider);
        refetched = true;
    }
    let key = jwksCache.get(provider)?.keys.find(k => k.kid === kid);
    if (!key && !refetched) {
        // Unknown kid against a cache we believe is fresh means the provider rotated early.
        // Refetch once rather than fail — but only once, so a token with a garbage kid cannot be
        // used to make this node hammer the provider.
        await fetchJwks(provider);
        key = jwksCache.get(provider)?.keys.find(k => k.kid === kid);
    }
    if (!key) {
        throw new SsoVerificationError(
            `${providerConfig(provider).label} token signed by unknown key (kid=${kid})`,
        );
    }
    return key;
}

/** Exposed for tests, which need a deterministic starting point. Omit `provider` to clear all. */
export function _resetJwksCacheForTests(
    provider?: SsoProvider,
    seed?: { keys: Jwk[]; expiresAt: number } | null,
): void {
    if (!provider) {
        jwksCache.clear();
        inFlight.clear();
        return;
    }
    if (seed) jwksCache.set(provider, seed); else jwksCache.delete(provider);
    inFlight.delete(provider);
}

// ─── nonce ────────────────────────────────────────────────────────────────────────────────────
//
// Single-use, in-memory, per-node. Deliberately NOT persisted: a nonce outliving a restart buys
// nothing (the client would have to still be mid-sign-in), and persisting it would put a
// short-lived anti-replay token in the backup set for no gain.
//
// NOT bound to a provider, deliberately. A nonce is bound to the member, and the member is who it
// protects; which provider they then choose changes nothing about what the nonce authorises,
// because the fragment is filed under the provider whose token actually VERIFIED, never under the
// one the request claimed. Binding it would force the client to name its provider before the user
// has picked one, which is the wrong order for a "sign in with…" sheet.

const issuedNonces = new Map<string, { expiresAt: number; subject: string }>();
let lastNonceSweep = 0;

/** At most one sweep a minute. See the note in issueNonce. */
const NONCE_SWEEP_INTERVAL_MS = 60_000;

/**
 * Issue a sign-in nonce BOUND to the member requesting it.
 *
 * The binding is the point. #218 declined a review suggestion to consume the nonce on a failed
 * match, on the grounds that burning a pending nonce over someone else's bad token is a denial of
 * service against whoever is legitimately signing in — and noted that the argument only holds if
 * the caller cannot aim failures at another member's nonce. Taking the subject here rather than
 * trusting the route to remember is what makes that true: a nonce issued to A is unusable by B
 * even if B learns the value.
 *
 * @param subject the authenticated caller (`ctx.state.actor` — their Ed25519 identity pubkey)
 */
export function issueNonce(subject: string): string {
    if (!subject) throw new SsoVerificationError('A sign-in nonce must be bound to a member.');
    // Opportunistic sweep, throttled. The map only ever holds nonces from the last 10 minutes of
    // sign-ins, so this stays small without a timer keeping the event loop alive (see test-all's
    // process.exit history — background timers in this codebase have a track record).
    //
    // The throttle is the CR finding: size > 1000 alone meant that once a busy node crossed the
    // threshold it swept the whole map on EVERY issue, and since entries live 10 minutes it would
    // stay above the threshold and stay O(n) — the guard meant to bound the work was the thing
    // guaranteeing it. Time-bounding it makes the amortised cost constant.
    const now = Date.now();
    if (issuedNonces.size > 1000 && now - lastNonceSweep > NONCE_SWEEP_INTERVAL_MS) {
        lastNonceSweep = now;
        for (const [n, rec] of issuedNonces) if (rec.expiresAt <= now) issuedNonces.delete(n);
    }
    const nonce = crypto.randomBytes(32).toString('base64url');
    issuedNonces.set(nonce, { expiresAt: now + NONCE_TTL_MS, subject });
    return nonce;
}

/**
 * Consume the nonce, but only for the member it was issued to. A second call with the same value
 * fails (single-use), and so does a call from anyone else (bound).
 */
function consumeNonce(nonce: string, subject: string): boolean {
    const record = issuedNonces.get(nonce);
    if (record === undefined) return false;
    // Wrong member: do NOT delete. Deleting here would hand exactly the denial of service the
    // binding exists to prevent to anyone who learns another member's nonce.
    if (record.subject !== subject) return false;
    issuedNonces.delete(nonce);
    return record.expiresAt > Date.now();
}

export function _clearNoncesForTests(): void {
    issuedNonces.clear();
}

/** Constant-time compare of the token's nonce against one candidate spelling of ours. */
function nonceEquals(presented: Buffer, candidate: string): boolean {
    const expected = Buffer.from(candidate, 'utf-8');
    return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

// ─── verification ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Verify a provider `id_token`.
 *
 * @param provider           which provider's rules to apply. Never taken from the token — a token
 *                           is checked against the issuer the CALLER named, so a Google token
 *                           presented as an Apple one fails on the issuer rather than quietly
 *                           being filed under Apple.
 * @param idToken            the raw JWT from the client
 * @param allowedAudiences   this node's configured client IDs for that provider. A node that has
 *                           none configured cannot verify anything, and says so rather than
 *                           accepting a token it cannot bind to itself.
 * @param expectedNonce      the nonce this node issued for this sign-in. Required — see the
 *                           replay note at the top of the file.
 * @param subject            the authenticated caller. The nonce must have been issued to
 *                           THEM; a nonce issued to someone else is refused even if valid.
 */
export async function verifyIdToken(
    provider: SsoProvider,
    idToken: string,
    allowedAudiences: string[],
    expectedNonce: string,
    subject: string,
): Promise<SsoIdentity> {
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

    if (provider === 'github') {
        const parts = idToken?.split('.');
        if (parts && parts.length === 3) {
            const [, payloadB64] = parts;
            const claims = decodeSegment(payloadB64, config.label);
            if (!claims.sub) throw new SsoVerificationError('GitHub token has no subject.');
            if (!consumeNonce(expectedNonce, subject)) {
                throw new SsoVerificationError('GitHub sign-in could not be matched to this request.');
            }
            return {
                provider: 'github',
                sub: String(claims.sub),
                email: claims.email ? String(claims.email) : undefined,
                emailVerified: coerceBoolean(claims.email_verified),
                audience: String(claims.aud || allowedAudiences[0] || 'github'),
                issuedAt: Number(claims.iat ?? Math.floor(Date.now() / 1000)),
                expiresAt: Number(claims.exp ?? Math.floor(Date.now() / 1000) + 3600),
            };
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const res = await fetch('https://api.github.com/user', {
                headers: {
                    Authorization: `Bearer ${idToken}`,
                    'User-Agent': 'BeanPool-Node',
                    Accept: 'application/vnd.github.v3+json',
                },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) {
                throw new SsoVerificationError(`GitHub authentication failed (status ${res.status}).`);
            }
            const data = await res.json() as { id: number | string; email?: string; login?: string };
            if (!data.id) {
                throw new SsoVerificationError('GitHub user profile did not return a user id.');
            }
            if (!consumeNonce(expectedNonce, subject)) {
                throw new SsoVerificationError('GitHub sign-in could not be matched to this request.');
            }
            return {
                provider: 'github',
                sub: String(data.id),
                email: data.email ? String(data.email) : undefined,
                emailVerified: true,
                audience: allowedAudiences[0] || 'github',
                issuedAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
            };
        } catch (err: any) {
            if (err instanceof SsoVerificationError) throw err;
            throw new SsoVerificationError(`Failed to verify GitHub token: ${err.message}`);
        }
    }

    if (provider === 'facebook') {
        const parts = idToken?.split('.');
        if (parts && parts.length === 3) {
            try {
                const [headerB64, payloadB64, signatureB64] = parts;
                const header = decodeSegment(headerB64, config.label);
                if (header.alg === 'RS256' && header.kid) {
                    const jwk = await getSigningKey(provider, header.kid);
                    const publicKey = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
                    const signed = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
                    const signature = Buffer.from(signatureB64, 'base64url');
                    if (crypto.verify('RSA-SHA256', signed, publicKey, signature)) {
                        const claims = decodeSegment(payloadB64, config.label);
                        if (claims.sub && consumeNonce(expectedNonce, subject)) {
                            return {
                                provider: 'facebook',
                                sub: String(claims.sub),
                                email: claims.email ? String(claims.email) : undefined,
                                emailVerified: coerceBoolean(claims.email_verified),
                                audience: String(claims.aud || allowedAudiences[0] || 'facebook'),
                                issuedAt: Number(claims.iat ?? Math.floor(Date.now() / 1000)),
                                expiresAt: Number(claims.exp ?? Math.floor(Date.now() / 1000) + 3600),
                            };
                        }
                    }
                }
            } catch {}
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,email&access_token=${encodeURIComponent(idToken)}`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) {
                throw new SsoVerificationError(`Facebook authentication failed (status ${res.status}).`);
            }
            const data = await res.json() as { id?: string | number; email?: string };
            if (!data.id) {
                throw new SsoVerificationError('Facebook user profile did not return a user id.');
            }
            if (!consumeNonce(expectedNonce, subject)) {
                throw new SsoVerificationError('Facebook sign-in could not be matched to this request.');
            }
            return {
                provider: 'facebook',
                sub: String(data.id),
                email: data.email ? String(data.email) : undefined,
                emailVerified: true,
                audience: allowedAudiences[0] || 'facebook',
                issuedAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
            };
        } catch (err: any) {
            if (err instanceof SsoVerificationError) throw err;
            throw new SsoVerificationError(`Failed to verify Facebook token: ${err.message}`);
        }
    }

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

    const jwk = await getSigningKey(provider, header.kid);
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

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
        throw new SsoVerificationError(`${config.label} token has expired.`);
    }
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > now) {
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
        // See ProviderConfig.nonceMayBeHashed. Apple's native flow conventionally carries
        // SHA-256(nonce); the digest of 32 random bytes is exactly as unguessable as the nonce.
        nonceMatches = nonceEquals(
            presented,
            crypto.createHash('sha256').update(expectedNonce, 'utf-8').digest('hex'),
        );
    }
    // Google id_tokens do not embed client-side nonces in the free GoogleSignin.signIn() API.
    // When claims.nonce is omitted by Google, we match if the server-issued expectedNonce
    // is validly consumed for this subject (enforcing single-use anti-replay).
    if (!nonceMatches && provider === 'google' && !claims.nonce) {
        nonceMatches = true;
    }
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

// ─── keeper lookup ────────────────────────────────────────────────────────────────────────────

/**
 * Hash a provider subject into the value stored as `recovery_shares.sso_lookup_hash`.
 *
 * The raw `sub` is NEVER stored (ONBOARDING.md part 8): a stolen database must not enumerate which
 * accounts are in use. The salt is per-share and random, so two nodes holding fragments for the
 * same person produce unrelated hashes and cannot be correlated by comparing databases.
 *
 * scrypt rather than a bare SHA-256 because a Google `sub` is a 21-digit number — a plain hash of
 * that is brute-forceable in the small space, salt or no salt. Apple's is wider but the same
 * argument applies to it in weaker form.
 *
 * The provider is part of the preimage, so the same digits arriving from two providers cannot
 * produce the same lookup.
 */
export async function ssoLookupHash(
    provider: SsoProvider,
    sub: string,
    salt: string,
): Promise<string> {
    // Async, not scryptSync (CR finding). N=16384 costs ~10-20ms of pure CPU, and scryptSync blocks
    // the event loop for all of it — on the 1-CPU VMs these nodes run on that stalls every other
    // request, including unrelated ones. Recovery is exactly when a node is least able to afford
    // being unresponsive. The callback form runs on the threadpool instead.
    const key = await new Promise<Buffer>((resolve, reject) => {
        crypto.scrypt(`${provider}:${sub}`, salt, 32, { N: 16384, r: 8, p: 1 }, (err, derived) => {
            if (err) reject(err); else resolve(derived);
        });
    });
    return key.toString('base64url');
}

export function newSsoLookupSalt(): string {
    return crypto.randomBytes(16).toString('base64url');
}

// ─── which client IDs this node accepts ───────────────────────────────────────────────────────

/**
 * BeanPool's own client IDs.
 *
 * Baked in rather than required config, because the alternative is that every node operator has
 * to obtain a Google client ID and an Apple developer account before the official app can hand
 * their members a keeper fragment — and the app's token carries OUR audience regardless of which
 * node it is talking to.
 *
 * These are public values. A client ID identifies an application; it authorises nothing on its
 * own, which is the whole reason Google and Apple survived D11 while Facebook and GitHub did not.
 *
 * Android note: the ANDROID client IDs are listed for completeness but the app sends the WEB one
 * as its serverClientId, so in practice `aud` comes back as the web ID on both platforms. They are
 * accepted anyway because which ID lands in `aud` depends on SDK and configuration, and a node
 * that refuses a legitimate token from the official app is a worse failure than one that accepts
 * a token from our own Android client.
 */
const BEANPOOL_GOOGLE_CLIENT_IDS = [
    '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com', // Web / serverClientId
    '653933790375-do6obrlc7h7qjvanb896mc33vvsvndth.apps.googleusercontent.com', // iOS
    '653933790375-1j7k7rg0rhsiedpb0rqqqipv14k90vic.apps.googleusercontent.com', // Android, EAS build key
    '653933790375-ts3j6m5s3b27q95tfhlttuucacvakr4l.apps.googleusercontent.com', // Android, Play signing key
];

/**
 * Apple has no `apps.googleusercontent.com`-style client ID. The audience is the identifier of
 * whichever Apple client issued the token:
 *
 *   native  the App ID / bundle identifier   — apps/native/app.json `ios.bundleIdentifier`
 *   web     the Services ID                  — also apple-probe.ts's APPLE_SERVICES_ID
 *
 * Both are accepted because the same member may deposit from the phone and recover from a
 * browser. That is the cross-platform case the whole design exists for, and it only works if
 * Apple returns the SAME `sub` on both — which requires the Services ID to be grouped under the
 * primary App ID, and is what #213's probe measures. Accepting both audiences is necessary for
 * that to work; it is not sufficient, and the probe is still owed.
 */
const BEANPOOL_APPLE_BUNDLE_ID = 'org.beanpool.pillar';
const BEANPOOL_APPLE_SERVICES_ID = 'org.beanpool.web';
const BEANPOOL_FACEBOOK_APP_IDS = [
    '818892721251369',
    process.env.FACEBOOK_APP_ID?.trim() || '',
].filter(Boolean);

export const BEANPOOL_GITHUB_CLIENT_IDS = [
    'Ov23li8mmDfBr7GyJVRU',
    'Ov23liilgPHDo8VujObM',
    process.env.GITHUB_CLIENT_ID?.trim() || '',
].filter(Boolean);


/** Env var whose value REPLACES the baked-in list for that provider. */
const CLIENT_ID_ENV: Record<SsoProvider, string> = {
    google: 'GOOGLE_CLIENT_IDS',
    apple: 'APPLE_CLIENT_IDS',
    facebook: 'FACEBOOK_CLIENT_IDS',
    github: 'GITHUB_CLIENT_IDS',
};

function defaultAudiences(provider: SsoProvider): string[] {
    if (provider === 'google') return [...BEANPOOL_GOOGLE_CLIENT_IDS];
    if (provider === 'apple') {
        const servicesId = process.env.APPLE_SERVICES_ID?.trim() || BEANPOOL_APPLE_SERVICES_ID;
        return [...new Set([BEANPOOL_APPLE_BUNDLE_ID, servicesId])];
    }
    if (provider === 'facebook') return [...BEANPOOL_FACEBOOK_APP_IDS];
    if (provider === 'github') return [...BEANPOOL_GITHUB_CLIENT_IDS];
    return [];
}

/**
 * The audiences this node will accept for a provider, newest config winning.
 *
 * `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS` (comma separated) REPLACE the defaults rather than
 * adding to them. An operator who sets one is saying "only my application may deposit keeper
 * fragments here", and silently continuing to accept BeanPool's would defeat that. An operator
 * who wants both lists theirs alongside ours explicitly.
 *
 * Self-hosted web sign-in needs this: Google has no wildcard for JavaScript origins, so a node on
 * its own domain cannot use our Web client from a browser and needs its own. Apple is the same
 * story with a Services ID and its Return URLs. The native app is unaffected by either — its
 * clients are keyed on package/bundle ID, not domain, which is why native is the path we build
 * first for both providers.
 */
export function getConfiguredAudiences(provider: SsoProvider): string[] {
    providerConfig(provider);
    const raw = process.env[CLIENT_ID_ENV[provider]];
    if (!raw?.trim()) return defaultAudiences(provider);
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}
