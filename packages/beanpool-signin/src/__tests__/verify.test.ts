import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    createJwksCache,
    createSignInVerifier,
    GITHUB_TOKEN_REFUSED,
    SsoProviderUnavailableError,
    SsoVerificationError,
    type FetchLike,
    type Jwk,
    type SsoIdentity,
    type SsoProvider,
} from '../index.js';

/**
 * The id_token checks against a stub JWKS. No provider is contacted: `fetch` is this file's own, it answers
 * the providers' pinned JWKS URLs with a key generated here, and anything else throws. Every refusal is
 * checked for today's error kind (the class) and today's words (the message), because both reach callers:
 * the routes pick a status by class, and the member reads the message.
 */

const KID = 'test-kid-1';
const JWKS_URLS: Record<string, string> = {
    google: 'https://www.googleapis.com/oauth2/v3/certs',
    apple: 'https://appleid.apple.com/auth/keys',
    facebook: 'https://www.facebook.com/.well-known/oauth/openid/jwks/',
};

const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...signingKey.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function mint(claims: Record<string, unknown>, opts: { header?: Record<string, unknown>; key?: crypto.KeyObject } = {}): string {
    const header = { alg: 'RS256', kid: KID, typ: 'JWT', ...opts.header };
    const signingInput = `${b64url(header)}.${b64url(claims)}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), opts.key ?? signingKey.privateKey);
    return `${signingInput}.${signature.toString('base64url')}`;
}

interface Case {
    provider: SsoProvider;
    label: string;
    iss: string;
    aud: string;
}
const CASES: Case[] = [
    { provider: 'google', label: 'Google', iss: 'https://accounts.google.com', aud: 'google-client.apps.googleusercontent.com' },
    { provider: 'apple', label: 'Apple', iss: 'https://appleid.apple.com', aud: 'org.beanpool.pillar' },
    { provider: 'facebook', label: 'Facebook', iss: 'https://www.facebook.com', aud: '818892721251369' },
];

const SUBJECT = 'member-key-a';
const T0 = 1_800_000_000_000; // a fixed "now", in ms

let now = T0;
let fetchCalls: string[] = [];
let providerAnswer: (url: string) => Response = () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200, headers: { 'cache-control': 'public, max-age=3600' },
});

const stubFetch: FetchLike = async (input) => {
    fetchCalls.push(input);
    if (!Object.values(JWKS_URLS).includes(input)) throw new Error(`the test tried to contact ${input}`);
    return providerAnswer(input);
};

/** A nonce store like a node's: bound to a subject, single use, left unspent for anyone else. */
const nonces = new Map<string, string>();
function issueNonce(subject: string): string {
    const nonce = crypto.randomBytes(32).toString('base64url');
    nonces.set(nonce, subject);
    return nonce;
}
function consumeNonce(nonce: string, subject: string): boolean {
    if (nonces.get(nonce) !== subject) return false;
    nonces.delete(nonce);
    return true;
}

let jwks = createJwksCache({ fetch: stubFetch, now: () => now });
let githubSpent: string[] = [];
function makeVerifier() {
    return createSignInVerifier({
        jwks,
        consumeNonce,
        consumeGithubSession: (sessionId: string, subject: string): SsoIdentity => {
            githubSpent.push(`${sessionId}:${subject}`);
            return { provider: 'github', sub: '42', audience: 'gh-client', issuedAt: 0, expiresAt: 0 };
        },
        now: () => now,
    });
}
let verifier = makeVerifier();

beforeEach(() => {
    now = T0;
    fetchCalls = [];
    nonces.clear();
    githubSpent = [];
    providerAnswer = () => new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200, headers: { 'cache-control': 'public, max-age=3600' },
    });
    jwks = createJwksCache({ fetch: stubFetch, now: () => now });
    verifier = makeVerifier();
});

/** The refusal a verification ends in, so its class and its words can both be checked. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (e) {
        return e as Error;
    }
    throw new Error('expected the sign-in to be refused, and it was accepted');
}

/** A token fault is a plain SsoVerificationError (the member's sign-in did not check out), never "try again". */
function expectRefused(e: Error, message: string): void {
    expect(e).toBeInstanceOf(SsoVerificationError);
    expect(e).not.toBeInstanceOf(SsoProviderUnavailableError);
    expect(e.name).toBe('SsoVerificationError');
    expect(e.message).toBe(message);
}

describe.each(CASES)('$label id_token', ({ provider, label, iss, aud }) => {
    const nowSeconds = () => Math.floor(now / 1000);
    const claims = (nonce: string, extra: Record<string, unknown> = {}) => ({
        iss, aud, sub: `${provider}-sub-1`, nonce, email: 'someone@example.com',
        iat: nowSeconds(), exp: nowSeconds() + 600, ...extra,
    });
    const verify = (token: string, nonce: string, subject = SUBJECT) =>
        verifier.verifyIdToken(provider, token, [aud], nonce, subject);

    it('accepts a valid token, fetching the provider keys from its pinned URL once', async () => {
        const nonce = issueNonce(SUBJECT);
        const identity = await verify(mint(claims(nonce)), nonce);
        expect(identity).toEqual({
            provider,
            sub: `${provider}-sub-1`,
            email: 'someone@example.com',
            emailVerified: undefined,
            privateEmail: undefined,
            audience: aud,
            issuedAt: nowSeconds(),
            expiresAt: nowSeconds() + 600,
        });
        expect(fetchCalls).toEqual([JWKS_URLS[provider]]);
        // Spent: the same nonce and token again are refused.
        expectRefused(await refusal(verify(mint(claims(nonce)), nonce)), `${label} sign-in could not be matched to this request.`);
    });

    it('refuses a wrong issuer', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce, { iss: 'https://evil.example' })), nonce)),
            `${label} token has wrong issuer (https://evil.example)`);
        expect(nonces.has(nonce)).toBe(true);
    });

    it('refuses a token issued to another application', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce, { aud: 'someone-elses-app' })), nonce)),
            `${label} token was issued to a different application.`);
        expect(nonces.has(nonce)).toBe(true);
    });

    it('refuses an expired token, allowing two minutes of clock skew', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce, { exp: nowSeconds() - 121 })), nonce)),
            `${label} token has expired.`);
        const inSkew = await verify(mint(claims(nonce, { exp: nowSeconds() - 119 })), nonce);
        expect(inSkew.sub).toBe(`${provider}-sub-1`);
    });

    it('refuses a token with no expiry', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce, { exp: undefined })), nonce)), `${label} token has expired.`);
    });

    it('refuses a token that is not valid yet (issued in the future), allowing the same skew', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce, { iat: nowSeconds() + 121 })), nonce)),
            `${label} token is dated in the future.`);
        const inSkew = await verify(mint(claims(nonce, { iat: nowSeconds() + 119 })), nonce);
        expect(inSkew.issuedAt).toBe(nowSeconds() + 119);
    });

    it('checks expiry against the injected clock', async () => {
        const nonce = issueNonce(SUBJECT);
        const token = mint(claims(nonce));
        now += 600_000 + 121_000;
        // The cached keys have not expired (max-age is 3600 s): only the token has.
        expectRefused(await refusal(verify(token, nonce)), `${label} token has expired.`);
    });

    it('refuses a bad signature: the right kid, signed by another key', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce), { key: otherKey.privateKey }), nonce)),
            `${label} token signature is not valid.`);
        expect(nonces.has(nonce)).toBe(true);
    });

    it('refuses a token whose payload was changed after signing', async () => {
        const nonce = issueNonce(SUBJECT);
        const [h, , s] = mint(claims(nonce)).split('.');
        const forged = `${h}.${b64url(claims(nonce, { sub: 'someone-else' }))}.${s}`;
        expectRefused(await refusal(verify(forged, nonce)), `${label} token signature is not valid.`);
    });

    it('refuses an unknown kid after refetching the key set exactly once', async () => {
        const nonce = issueNonce(SUBJECT);
        // Warm the cache, so the unknown kid meets a cache the verifier believes is fresh.
        await verify(mint(claims(nonce)), nonce);
        fetchCalls = [];
        const next = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(next), { header: { kid: 'rotated-away' } }), next)),
            `${label} token signed by unknown key (kid=rotated-away)`);
        expect(fetchCalls).toEqual([JWKS_URLS[provider]]);
    });

    it('refuses a token with no kid', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce), { header: { kid: undefined } }), nonce)),
            `${label} token has no key id.`);
        expect(fetchCalls).toEqual([]);
    });

    it('refuses alg: none, with no signature and no key fetch', async () => {
        const nonce = issueNonce(SUBJECT);
        const unsigned = `${b64url({ alg: 'none', kid: KID })}.${b64url(claims(nonce))}.`;
        expectRefused(await refusal(verify(unsigned, nonce)), `${label} token uses unexpected algorithm none`);
        expect(fetchCalls).toEqual([]);
    });

    it('refuses HS256 signed with the public key as the HMAC secret', async () => {
        const nonce = issueNonce(SUBJECT);
        const input = `${b64url({ alg: 'HS256', kid: KID })}.${b64url(claims(nonce))}`;
        const secret = signingKey.publicKey.export({ format: 'pem', type: 'spki' });
        const mac = crypto.createHmac('sha256', secret).update(input).digest('base64url');
        expectRefused(await refusal(verify(`${input}.${mac}`, nonce)), `${label} token uses unexpected algorithm HS256`);
    });

    it('refuses a wrong nonce and leaves the real one unspent', async () => {
        const nonce = issueNonce(SUBJECT);
        const stranger = crypto.randomBytes(32).toString('base64url');
        expectRefused(await refusal(verify(mint(claims(stranger)), nonce)), `${label} sign-in could not be matched to this request.`);
        expect(nonces.has(nonce)).toBe(true);
        expect((await verify(mint(claims(nonce)), nonce)).sub).toBe(`${provider}-sub-1`);
    });

    it('refuses a token that carries no nonce', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce, { nonce: undefined })), nonce)),
            `${label} sign-in could not be matched to this request.`);
        expect(nonces.has(nonce)).toBe(true);
    });

    it('refuses a nonce issued to someone else, without spending it', async () => {
        const nonce = issueNonce('member-key-b');
        expectRefused(await refusal(verify(mint(claims(nonce)), nonce, SUBJECT)),
            `${label} sign-in could not be matched to this request.`);
        expect(nonces.get(nonce)).toBe('member-key-b');
    });

    it(provider === 'apple' ? 'accepts SHA-256(nonce), as Apple native sends it' : 'refuses SHA-256(nonce): only Apple may hash it', async () => {
        const nonce = issueNonce(SUBJECT);
        const hashed = crypto.createHash('sha256').update(nonce, 'utf-8').digest('hex');
        const attempt = verify(mint(claims(hashed)), nonce);
        if (provider === 'apple') {
            expect((await attempt).sub).toBe('apple-sub-1');
        } else {
            expectRefused(await refusal(attempt), `${label} sign-in could not be matched to this request.`);
        }
    });

    it('refuses a token with no subject', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify(mint(claims(nonce, { sub: undefined })), nonce)), `${label} token has no subject.`);
    });

    it('refuses before any request when the caller has no audience, no nonce or no subject', async () => {
        const nonce = issueNonce(SUBJECT);
        const token = mint(claims(nonce));
        expectRefused(await refusal(verifier.verifyIdToken(provider, token, [], nonce, SUBJECT)),
            `This node has no ${label} client ID configured, so it cannot verify a ${label} sign-in.`);
        expectRefused(await refusal(verifier.verifyIdToken(provider, token, [aud], '', SUBJECT)),
            `${label} sign-in is missing its nonce.`);
        expectRefused(await refusal(verifier.verifyIdToken(provider, token, [aud], nonce, '')),
            `A ${label} sign-in must be verified against a known member.`);
        expect(fetchCalls).toEqual([]);
    });

    it('refuses a malformed or implausibly large token', async () => {
        const nonce = issueNonce(SUBJECT);
        expectRefused(await refusal(verify('not-a-jwt', nonce)), `${label} token is malformed.`);
        expectRefused(await refusal(verify('a'.repeat(8193), nonce)), `${label} token is implausibly large.`);
        expectRefused(await refusal(verify('!!.!!.!!', nonce)), `${label} token is not valid JWT JSON`);
    });

    it('says the provider could not be asked when its keys do not come (a subclass, so callers can say try again)', async () => {
        providerAnswer = () => new Response('unavailable', { status: 503 });
        const nonce = issueNonce(SUBJECT);
        const e = await refusal(verify(mint(claims(nonce)), nonce));
        expect(e).toBeInstanceOf(SsoProviderUnavailableError);
        expect(e).toBeInstanceOf(SsoVerificationError);
        expect(e.name).toBe('SsoProviderUnavailableError');
        expect(e.message).toBe(`${label} is not answering right now (HTTP 503), so the sign-in could not be checked. Please try again in a minute.`);
        // Nothing was learned about the token, so the nonce is still unspent.
        expect(nonces.has(nonce)).toBe(true);
    });

    it('verifySignIn sends an OIDC credential to verifyIdToken', async () => {
        const nonce = issueNonce(SUBJECT);
        const identity = await verifier.verifySignIn(provider, { idToken: mint(claims(nonce)) }, [aud], nonce, SUBJECT);
        expect(identity.provider).toBe(provider);
        expect(githubSpent).toEqual([]);
    });
});

describe('the key cache', () => {
    it('keeps the providers apart: one provider fetching does not evict or answer for another', async () => {
        const nonce = issueNonce(SUBJECT);
        const google = CASES[0];
        const apple = CASES[1];
        const nowSeconds = Math.floor(now / 1000);
        await verifier.verifyIdToken('google', mint({ iss: google.iss, aud: google.aud, sub: 'g', nonce, iat: nowSeconds, exp: nowSeconds + 600 }),
            [google.aud], nonce, SUBJECT);
        const next = issueNonce(SUBJECT);
        await verifier.verifyIdToken('apple', mint({ iss: apple.iss, aud: apple.aud, sub: 'a', nonce: next, iat: nowSeconds, exp: nowSeconds + 600 }),
            [apple.aud], next, SUBJECT);
        expect(fetchCalls).toEqual([JWKS_URLS.google, JWKS_URLS.apple]);
    });

    it('refetches once the cached set has expired, clamping max-age to at least five minutes', async () => {
        providerAnswer = () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'cache-control': 'max-age=1' } });
        await jwks.getSigningKey('google', KID);
        now += 299_000;
        await jwks.getSigningKey('google', KID);
        expect(fetchCalls.length).toBe(1);
        now += 2_000;
        await jwks.getSigningKey('google', KID);
        expect(fetchCalls.length).toBe(2);
    });

    it('takes a seeded set without asking anyone, and reset() puts it back to cold', async () => {
        jwks.reset('google', { keys: [publicJwk as Jwk], expiresAt: now + 60_000 });
        expect((await jwks.getSigningKey('google', KID)).kid).toBe(KID);
        expect(fetchCalls).toEqual([]);
        jwks.reset();
        await jwks.getSigningKey('google', KID);
        expect(fetchCalls).toEqual([JWKS_URLS.google]);
    });

    it('says an unreachable provider and an unusable key set are the provider failing', async () => {
        providerAnswer = () => { throw new Error('ECONNREFUSED'); };
        const unreachable = await refusal(jwks.getSigningKey('apple', KID));
        expect(unreachable).toBeInstanceOf(SsoProviderUnavailableError);
        expect(unreachable.message).toBe('Apple could not be reached to check the sign-in. Please try again in a minute.');
        providerAnswer = () => new Response(JSON.stringify({ keys: [{ kty: 'EC', kid: KID }] }), { status: 200 });
        const unusable = await refusal(jwks.getSigningKey('apple', KID));
        expect(unusable).toBeInstanceOf(SsoProviderUnavailableError);
        expect(unusable.message).toBe('Apple sent sign-in keys this node could not use, so the sign-in could not be checked. Please try again in a minute.');
    });
});

describe('GitHub through the verifier', () => {
    it('refuses a GitHub id_token by name, before any request', async () => {
        expectRefused(await refusal(verifier.verifyIdToken('github', 'gho_anything', ['gh-client'], 'n', SUBJECT)), GITHUB_TOKEN_REFUSED);
        expectRefused(await refusal(verifier.verifySignIn('github', { idToken: 'gho_anything' }, ['gh-client'], 'n', SUBJECT)), GITHUB_TOKEN_REFUSED);
        expect(fetchCalls).toEqual([]);
        expect(githubSpent).toEqual([]);
    });

    it('spends the session for the subject, and refuses one run for an application no longer accepted', async () => {
        expect((await verifier.verifySignIn('github', { sessionId: 's1' }, ['gh-client'], '', SUBJECT)).sub).toBe('42');
        expect(githubSpent).toEqual([`s1:${SUBJECT}`]);
        expectRefused(await refusal(verifier.verifySignIn('github', { sessionId: 's2' }, ['another-client'], '', SUBJECT)),
            'GitHub sign-in was run for a different application.');
        expectRefused(await refusal(verifier.verifySignIn('github', {}, ['gh-client'], '', SUBJECT)), 'GitHub sign-in is missing its session.');
        expectRefused(await refusal(verifier.verifySignIn('github', { sessionId: 's3' }, ['gh-client'], '', '')),
            'A GitHub sign-in must be verified against a known member.');
    });

    it('refuses a provider it does not know by name', async () => {
        expectRefused(await refusal(verifier.verifySignIn('twitter' as SsoProvider, { idToken: 'x' }, ['a'], 'n', SUBJECT)),
            "Unknown sign-in provider 'twitter'.");
    });
});
