import crypto from 'node:crypto';

/**
 * Google OIDC `id_token` verification. Zero dependencies, same as totp.ts.
 *
 * WHY NO LIBRARY
 * --------------
 * `jose` would do this in three lines and is well regarded. It is not used because every
 * self-hosted node ships this code, and D5 already forces the design to be the kind that needs
 * no secrets; adding a dependency to the trust path of an account-recovery keyholder is a cost
 * paid by operators who cannot audit it. Node's `crypto` builds an RSA key straight from a JWK
 * and verifies RS256 natively, so the whole thing is ~80 lines of standard-library calls.
 *
 * WHAT THIS IS FOR
 * ----------------
 * K4 in the keyholder model: "your sign-in account". Signing in with Google does NOT log anybody
 * in and creates no account (D9) — it returns ONE fragment of a Shamir split. The only thing this
 * module establishes is *which Google account* is presenting itself, as a stable `sub`.
 *
 * WHAT IS ACTUALLY CHECKED, and why each one matters:
 *
 *   signature   RS256 against Google's published JWKS. Without it everything below is decoration.
 *   alg         pinned to RS256 and read from the header ONLY to reject anything else. The classic
 *               JWT breaks are `alg: none` and HS256-with-the-public-key-as-HMAC-secret; both are
 *               impossible here because the algorithm is never chosen from the token.
 *   kid         selects the key. Google publishes several and rotates them.
 *   iss         accounts.google.com or https://accounts.google.com. Google uses both spellings.
 *   aud         must be one of OUR client IDs. This is the check that distinguishes "a valid
 *               Google token" from "a token issued to us" — without it, any app's token verifies,
 *               which is token substitution.
 *   exp / iat   with a small clock skew allowance, because self-hosted nodes are not NTP-perfect.
 *   nonce       must equal the one this node issued. Every node accepts the same audiences, so
 *               without nonce binding a token obtained at one node is replayable at every other
 *               node in the federation. See issueNonce() below.
 *
 * NOT checked here: `email_verified`. Email is not an identifier in this design — `sub` is. A
 * Google account with an unverified email still has a stable, unique `sub`, and the keeper lookup
 * is a hash of the subject, never the address.
 */

/** Google's OIDC discovery document points here; hardcoded because it has not moved and a
 *  discovery fetch would be one more failure mode at recovery time. */
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

/** Both spellings appear in real Google tokens. */
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Tolerance for exp/iat. Nodes run on cheap VMs whose clocks drift; 2 minutes is enough to
 *  survive that without meaningfully extending the life of a stolen token. */
const CLOCK_SKEW_SECONDS = 120;

/** Nonces expire fast. The window only has to cover one sign-in round trip. */
const NONCE_TTL_MS = 10 * 60 * 1000;

export class SsoVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SsoVerificationError';
    }
}

export interface GoogleIdentity {
    /** Stable, unique per Google account per client. THE identifier — never the email. */
    sub: string;
    /** Present for display only ("Google (m•••@gmail.com)"). Never used for lookup. */
    email?: string;
    emailVerified?: boolean;
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
// Google rotates signing keys and publishes a Cache-Control max-age. Honouring it matters in both
// directions: fetching per verification would make Google a hard dependency of every recovery
// attempt, and caching forever would break the day they rotate.
//
// The refetch-once-on-unknown-kid path below is the important one. A rotation that lands between
// our cache being populated and expiring would otherwise fail every verification for the rest of
// the TTL, and the user's symptom would be "recovery is broken" with nothing in the logs to say why.

let jwksCache: { keys: Jwk[]; expiresAt: number } | null = null;
let inFlight: Promise<Jwk[]> | null = null;

function parseMaxAge(cacheControl: string | null): number {
    const m = cacheControl?.match(/max-age=(\d+)/);
    const seconds = m ? parseInt(m[1], 10) : NaN;
    // Clamp: a hostile or broken header must not pin us to a key set for a week, nor cause a
    // fetch storm. 5 minutes to 24 hours.
    if (!Number.isFinite(seconds)) return 3600_000;
    return Math.min(Math.max(seconds, 300), 86_400) * 1000;
}

async function fetchJwks(): Promise<Jwk[]> {
    // Coalesce concurrent misses into one request, so a node restarting under load does not open
    // a connection per in-flight verification.
    if (inFlight) return inFlight;

    inFlight = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
            const res = await fetch(GOOGLE_JWKS_URI, { signal: controller.signal });
            if (!res.ok) throw new SsoVerificationError(`Google JWKS fetch failed: HTTP ${res.status}`);
            const body = await res.json() as { keys?: Jwk[] };
            const keys = (body.keys ?? []).filter(k => k.kty === 'RSA' && k.n && k.e && k.kid);
            if (!keys.length) throw new SsoVerificationError('Google JWKS contained no usable RSA keys');
            jwksCache = { keys, expiresAt: Date.now() + parseMaxAge(res.headers.get('cache-control')) };
            return keys;
        } finally {
            clearTimeout(timeout);
            inFlight = null;
        }
    })();

    return inFlight;
}

async function getSigningKey(kid: string): Promise<Jwk> {
    // `refetched` is what makes "refetch once" true (CR finding). Without it an expired cache
    // fetched here, missed on the kid, and then fetched AGAIN immediately — two round trips for
    // identical data, and exactly the Google-hammering the comment below claims to prevent. A
    // garbage kid arriving against a cold cache was the cheapest way to trigger it.
    let refetched = false;
    if (!jwksCache || jwksCache.expiresAt <= Date.now()) {
        await fetchJwks();
        refetched = true;
    }
    let key = jwksCache?.keys.find(k => k.kid === kid);
    if (!key && !refetched) {
        // Unknown kid against a cache we believe is fresh means Google rotated early. Refetch once
        // rather than fail — but only once, so a token with a garbage kid cannot be used to make
        // this node hammer Google.
        await fetchJwks();
        key = jwksCache?.keys.find(k => k.kid === kid);
    }
    if (!key) throw new SsoVerificationError(`Google token signed by unknown key (kid=${kid})`);
    return key;
}

/** Exposed for tests, which need a deterministic starting point. */
export function _resetJwksCacheForTests(seed?: { keys: Jwk[]; expiresAt: number } | null): void {
    jwksCache = seed ?? null;
    inFlight = null;
}

// ─── nonce ────────────────────────────────────────────────────────────────────────────────────
//
// Single-use, in-memory, per-node. Deliberately NOT persisted: a nonce outliving a restart buys
// nothing (the client would have to still be mid-sign-in), and persisting it would put a
// short-lived anti-replay token in the backup set for no gain.

const issuedNonces = new Map<string, number>();
let lastNonceSweep = 0;

/** At most one sweep a minute. See the note in issueNonce. */
const NONCE_SWEEP_INTERVAL_MS = 60_000;

export function issueNonce(): string {
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
        for (const [n, exp] of issuedNonces) if (exp <= now) issuedNonces.delete(n);
    }
    const nonce = crypto.randomBytes(32).toString('base64url');
    issuedNonces.set(nonce, now + NONCE_TTL_MS);
    return nonce;
}

/** Consumes the nonce: a second call with the same value fails. That is what makes it single-use. */
function consumeNonce(nonce: string): boolean {
    const expiry = issuedNonces.get(nonce);
    if (expiry === undefined) return false;
    issuedNonces.delete(nonce);
    return expiry > Date.now();
}

export function _clearNoncesForTests(): void {
    issuedNonces.clear();
}

// ─── verification ─────────────────────────────────────────────────────────────────────────────

function decodeSegment(segment: string): any {
    try {
        return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
    } catch {
        throw new SsoVerificationError('Google token is not valid JWT JSON');
    }
}

/**
 * Verify a Google `id_token`.
 *
 * @param idToken            the raw JWT from the client
 * @param allowedAudiences   this node's configured Google client IDs. A node that has none
 *                           configured cannot verify anything, and says so rather than
 *                           accepting a token it cannot bind to itself.
 * @param expectedNonce      the nonce this node issued for this sign-in. Required — see the
 *                           replay note at the top of the file.
 */
export async function verifyGoogleIdToken(
    idToken: string,
    allowedAudiences: string[],
    expectedNonce: string,
): Promise<GoogleIdentity> {
    if (!allowedAudiences?.length) {
        throw new SsoVerificationError(
            'This node has no Google client ID configured, so it cannot verify a Google sign-in.',
        );
    }
    if (!expectedNonce) {
        throw new SsoVerificationError('Google sign-in is missing its nonce.');
    }

    const parts = idToken?.split('.');
    if (!parts || parts.length !== 3) throw new SsoVerificationError('Google token is malformed.');
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = decodeSegment(headerB64);
    // Pinned, not selected. The algorithm is never taken from the token — this reads it purely to
    // refuse anything that is not RS256, which is what closes alg-confusion and `alg: none`.
    if (header.alg !== 'RS256') {
        throw new SsoVerificationError(`Google token uses unexpected algorithm ${header.alg}`);
    }
    if (!header.kid) throw new SsoVerificationError('Google token has no key id.');

    const jwk = await getSigningKey(header.kid);
    const publicKey = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });

    const signed = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
    const signature = Buffer.from(signatureB64, 'base64url');
    if (!crypto.verify('RSA-SHA256', signed, publicKey, signature)) {
        throw new SsoVerificationError('Google token signature is not valid.');
    }

    // Everything below this line is only meaningful because the signature held.
    const claims = decodeSegment(payloadB64);

    if (!GOOGLE_ISSUERS.includes(claims.iss)) {
        throw new SsoVerificationError(`Google token has wrong issuer (${claims.iss})`);
    }
    if (!claims.aud || !allowedAudiences.includes(claims.aud)) {
        throw new SsoVerificationError('Google token was issued to a different application.');
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
        throw new SsoVerificationError('Google token has expired.');
    }
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > now) {
        throw new SsoVerificationError('Google token is dated in the future.');
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
    // Nothing is gained by consuming early. Replay requires a token that is validly signed by
    // Google AND carries this exact nonce; that path consumes, and is covered by a test. An
    // attacker cannot mint a token bearing a nonce they do not know, so unlimited failed attempts
    // within the TTL buy them nothing. Unconsumed nonces are bounded by NONCE_TTL_MS and the sweep.
    //
    // This does assume the caller binds `expectedNonce` to the requesting session rather than
    // taking it from the request body — otherwise an attacker could aim failures at someone else's
    // pending nonce. That is a constraint on the route, and it is why this is written down here.
    const presented = Buffer.from(String(claims.nonce ?? ''), 'utf-8');
    const expected = Buffer.from(expectedNonce, 'utf-8');
    const nonceMatches = presented.length === expected.length
        && crypto.timingSafeEqual(presented, expected);
    if (!nonceMatches || !consumeNonce(expectedNonce)) {
        throw new SsoVerificationError('Google sign-in could not be matched to this request.');
    }

    if (!claims.sub) throw new SsoVerificationError('Google token has no subject.');

    return {
        sub: String(claims.sub),
        email: claims.email ? String(claims.email) : undefined,
        emailVerified: typeof claims.email_verified === 'boolean' ? claims.email_verified : undefined,
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
 * Google accounts are in use. The salt is per-share and random, so two nodes holding fragments for
 * the same person produce unrelated hashes and cannot be correlated by comparing databases.
 *
 * scrypt rather than a bare SHA-256 because a `sub` is a 21-digit number — a plain hash of that is
 * brute-forceable in the small space, salt or no salt.
 */
export async function ssoLookupHash(
    provider: 'google' | 'apple',
    sub: string,
    salt: string,
): Promise<string> {
    // Async, not scryptSync (CR finding). N=16384 costs ~10-20ms of pure CPU, and scryptSync blocks
    // the event loop for all of it — on the 1-CPU VMs these nodes run on that stalls every other
    // request, including unrelated ones. Recovery is exactly when a node is least able to afford
    // being unresponsive. The callback form runs on the threadpool instead.
    //
    // Changed now while the function has no callers; once routes exist, the same change would mean
    // touching every call site.
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
 * BeanPool's own Google client IDs (project `beanpool`, cytec.com.au).
 *
 * Baked in rather than required config, because the alternative is that every node operator has
 * to obtain a Google client ID before the official app can hand their members a keeper fragment —
 * and the app's token carries OUR audience regardless of which node it is talking to.
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
 * The audiences this node will accept, newest config winning.
 *
 * `GOOGLE_CLIENT_IDS` (comma separated) REPLACES the defaults rather than adding to them. An
 * operator who sets it is saying "only my application may deposit keeper fragments here", and
 * silently continuing to accept BeanPool's would defeat that. An operator who wants both lists
 * theirs alongside ours explicitly.
 *
 * Self-hosted web sign-in needs this: Google has no wildcard for JavaScript origins, so a node on
 * its own domain cannot use our Web client from a browser and needs its own. The native app is
 * unaffected — its clients are keyed on package/bundle ID, not domain.
 */
export function getConfiguredGoogleAudiences(): string[] {
    const raw = process.env.GOOGLE_CLIENT_IDS;
    if (!raw?.trim()) return [...BEANPOOL_GOOGLE_CLIENT_IDS];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}
