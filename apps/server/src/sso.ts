import crypto from 'node:crypto';
import {
    configuredAudiences,
    createJwksCache,
    createSignInVerifier,
    defaultAudiences,
    NONCE_TTL_MS,
    SsoVerificationError,
    webClientId as webClientIdFor,
    webClientIds as webClientIdsFor,
    type AudienceSettings,
    type JwksEntry,
    type SignInCredential,
    type SsoIdentity,
    type SsoProvider,
    type WebSignInProvider,
} from '@beanpool/signin';
import { consumeGithubSession } from './engine/github-device.js';

/**
 * Sign-in verification for the sign-in keyholder, as this node runs it.
 *
 * The checks themselves (the provider table, `id_token` verification, the JWKS cache, BeanPool's client ids
 * and GitHub's device flow) live in @beanpool/signin (packages/beanpool-signin), shared with the key vault so
 * that both check a sign-in with exactly the same code (key vault V1). What stays here is what belongs to this
 * node: the nonces it issues, its one key cache and verifier, the keeper lookup hash, and the client ids its
 * operator configured in its env. Every name this file exported before the move is still exported from here.
 */

export {
    SsoVerificationError,
    SsoProviderUnavailableError,
    isSsoProvider,
    ssoProviderLabel,
    SSO_PROVIDERS,
    GITHUB_TOKEN_REFUSED,
    NONCE_TTL_MS,
    signInCredentialFrom,
    type SsoProvider,
    type SsoIdentity,
    type SignInCredential,
    type WebSignInProvider,
} from '@beanpool/signin';

// ─── JWKS cache ───────────────────────────────────────────────────────────────────────────────
//
// One per node process, keyed by provider (see packages/beanpool-signin/src/jwks.ts for why).

const jwks = createJwksCache();

/** Exposed for tests, which need a deterministic starting point. Omit `provider` to clear all. */
export function _resetJwksCacheForTests(
    provider?: SsoProvider,
    seed?: JwksEntry | null,
): void {
    jwks.reset(provider, seed);
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

// ─── verification ─────────────────────────────────────────────────────────────────────────────

const verifier = createSignInVerifier({
    jwks,
    consumeNonce,
    // Resolved at call time: engine/github-device.ts imports this file too.
    consumeGithubSession: (sessionId, subject) => consumeGithubSession(sessionId, subject),
});

/**
 * Verify a provider `id_token` (packages/beanpool-signin/src/verify.ts has what is checked, and why).
 *
 * @param provider           which provider's rules to apply. Never taken from the token.
 * @param idToken            the raw JWT from the client
 * @param allowedAudiences   this node's configured client IDs for that provider (getConfiguredAudiences)
 * @param expectedNonce      the nonce this node issued for this sign-in (issueNonce). Required.
 * @param subject            the authenticated caller. The nonce must have been issued to
 *                           THEM; a nonce issued to someone else is refused even if valid.
 */
export function verifyIdToken(
    provider: SsoProvider,
    idToken: string,
    allowedAudiences: string[],
    expectedNonce: string,
    subject: string,
): Promise<SsoIdentity> {
    return verifier.verifyIdToken(provider, idToken, allowedAudiences, expectedNonce, subject);
}

/**
 * Verify a sign-in, whichever provider it is. The one entry point every route uses.
 *
 * OIDC providers go to verifyIdToken. GitHub spends the node's own finished device-flow session, bound
 * to `subject` and single use (engine/github-device.ts); a GitHub `idToken` is refused before anything
 * else runs, network included.
 */
export function verifySignIn(
    provider: SsoProvider,
    credential: SignInCredential,
    allowedAudiences: string[],
    expectedNonce: string,
    subject: string,
): Promise<SsoIdentity> {
    return verifier.verifySignIn(provider, credential, allowedAudiences, expectedNonce, subject);
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
//
// BeanPool's own ids, and the rule that an operator's list replaces them, are in
// packages/beanpool-signin/src/audiences.ts. This node's settings come from its env.

/** Read once, when this module loads: these two only ever were. */
const FACEBOOK_APP_ID_AT_START = process.env.FACEBOOK_APP_ID;
const GITHUB_CLIENT_ID_AT_START = process.env.GITHUB_CLIENT_ID;

/** BeanPool's GitHub client ids, plus this node's `GITHUB_CLIENT_ID`. */
export const BEANPOOL_GITHUB_CLIENT_IDS = defaultAudiences('github', { githubClientId: GITHUB_CLIENT_ID_AT_START });

/** Env var whose value REPLACES the baked-in list for that provider. */
const CLIENT_ID_ENV: Record<SsoProvider, string> = {
    google: 'GOOGLE_CLIENT_IDS',
    apple: 'APPLE_CLIENT_IDS',
    facebook: 'FACEBOOK_CLIENT_IDS',
    github: 'GITHUB_CLIENT_IDS',
};

/** This node's audience settings, read from its env at each call (APPLE_SERVICES_ID and the *_CLIENT_IDS lists). */
function audienceSettings(): AudienceSettings {
    return {
        facebookAppId: FACEBOOK_APP_ID_AT_START,
        githubClientId: GITHUB_CLIENT_ID_AT_START,
        appleServicesId: process.env.APPLE_SERVICES_ID,
        replace: {
            google: process.env[CLIENT_ID_ENV.google],
            apple: process.env[CLIENT_ID_ENV.apple],
            facebook: process.env[CLIENT_ID_ENV.facebook],
            github: process.env[CLIENT_ID_ENV.github],
        },
    };
}

/**
 * The audiences this node will accept for a provider, newest config winning.
 *
 * `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS` (comma separated) REPLACE the defaults rather than
 * adding to them. An operator who sets one is saying "only my application may deposit keeper
 * fragments here", and silently continuing to accept BeanPool's would defeat that. An operator
 * who wants both lists theirs alongside ours explicitly.
 */
export function getConfiguredAudiences(provider: SsoProvider): string[] {
    return configuredAudiences(provider, audienceSettings());
}

/**
 * The client id a BROWSER puts in its sign-in request to `provider`, or null when this node accepts none a browser
 * can use. Answered beside every sign-in nonce (`clientIds`), so the web app learns it from the node it is on, not
 * from its build: a self-hosted node with its own ids serves web sign-in with the same web app.
 *
 * GitHub has none: the node runs its sign-in itself (engine/github-device.ts).
 */
export function webClientId(provider: WebSignInProvider): string | null {
    return webClientIdFor(provider, audienceSettings());
}

/** `webClientId` for each provider a browser redirects to, as the nonce answers carry it. */
export function webClientIds(): Record<WebSignInProvider, string | null> {
    return webClientIdsFor(audienceSettings());
}
