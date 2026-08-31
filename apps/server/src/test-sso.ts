/**
 * OIDC id_token verification for Google and Apple — proven against real RSA signatures, not mocks.
 *
 * The suite mints its own keypair PER PROVIDER and issues tokens with it, then substitutes those
 * keys into the JWKS caches. So every "valid token" here carries a genuine RS256 signature over
 * genuine claims, and every rejection test proves the verifier refuses something it could
 * otherwise have accepted.
 *
 * The tests that matter most are the negative ones. A verifier that accepts good tokens but also
 * accepts `alg: none`, or a token minted for someone else's client ID, is worse than no verifier —
 * it looks like security while granting a stranger a fragment of somebody's account.
 *
 * The whole battery runs against BOTH providers rather than Google with an Apple postscript,
 * because a check that exists for one and not the other is the failure this generalisation was
 * meant to prevent. Both fixtures deliberately share a `kid` so the cross-provider tests are
 * meaningful: a shared JWKS cache would resolve one provider's kid to the other's key.
 *
 * NETWORK: none. Every cache is primed before use. The two "unknown key id" cases are the
 * exception — they exercise the refetch-once path, which reaches for the real JWKS and must fail
 * closed whether or not it gets there, so they pass offline and online alike. The JWKS URLs
 * themselves were checked by hand against both providers on 2026-08-07; a test cannot distinguish
 * "wrong URL" from "no network", so it does not pretend to.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sso.ts
 */
import crypto from 'node:crypto';
import {
    verifyIdToken,
    issueNonce,
    ssoLookupHash,
    newSsoLookupSalt,
    getConfiguredAudiences,
    isSsoProvider,
    SSO_PROVIDERS,
    SsoVerificationError,
    _resetJwksCacheForTests,
    _clearNoncesForTests,
    type SsoProvider,
} from './sso.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
async function rejects(fn: () => Promise<unknown>, msg: string): Promise<void> {
    run++;
    try {
        await fn();
        console.error(`✗ ${msg} — it RESOLVED, which means the check is not there`);
    } catch (e) {
        if (e instanceof SsoVerificationError) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ ${msg} — threw the wrong error type: ${(e as Error).message}`);
    }
}

/** Every nonce is bound to a member; these tests act as one. */
const SUBJECT = 'a'.repeat(64);
const OTHER_SUBJECT = 'b'.repeat(64);

/** Shared on purpose — see the header. Cross-provider confusion is only testable if the kids collide. */
const KID = 'test-key-1';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');

interface Fixture {
    provider: SsoProvider;
    label: string;
    iss: string;
    aud: string;
    otherAud: string;
    jwk: any;
    publicKey: crypto.KeyObject;
    privateKey: crypto.KeyObject;
    sub: string;
    mint(claims?: Record<string, unknown>, header?: Record<string, unknown>): string;
    prime(): void;
}

function makeFixture(
    provider: SsoProvider,
    opts: { iss: string; aud: string; otherAud: string; sub: string; extraClaims?: Record<string, unknown> },
): Fixture {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' } as any;
    const f: Fixture = {
        provider,
        label: provider === 'google' ? 'Google' : 'Apple',
        iss: opts.iss,
        aud: opts.aud,
        otherAud: opts.otherAud,
        jwk,
        publicKey,
        privateKey,
        sub: opts.sub,
        mint(claims = {}, header = {}) {
            const now = Math.floor(Date.now() / 1000);
            const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
            const p = b64({
                iss: opts.iss,
                aud: opts.aud,
                sub: opts.sub,
                iat: now,
                exp: now + 3600,
                ...opts.extraClaims,
                ...claims,
            });
            const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), privateKey);
            return `${h}.${p}.${sig.toString('base64url')}`;
        },
        prime() {
            _resetJwksCacheForTests(provider, { keys: [jwk], expiresAt: Date.now() + 3600_000 });
        },
    };
    return f;
}

const GOOGLE = makeFixture('google', {
    iss: 'https://accounts.google.com',
    aud: '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com',
    otherAud: '999999999999-someoneelsesapp.apps.googleusercontent.com',
    sub: '110169484474386276334',
    extraClaims: { email: 'someone@gmail.com', email_verified: true },
});

const APPLE = makeFixture('apple', {
    iss: 'https://appleid.apple.com',
    aud: 'org.beanpool.pillar',
    otherAud: 'com.someoneelse.app',
    sub: '001234.fedcba9876543210fedcba9876543210.0123',
    // Apple sends these as STRINGS in some flows, which is the whole point of coerceBoolean.
    extraClaims: { email: 'someone@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true' },
});

const FACEBOOK = makeFixture('facebook', {
    iss: 'https://www.facebook.com',
    aud: '123456789012345',
    otherAud: '987654321098765',
    sub: '100084729103847',
    extraClaims: { email: 'someone@example.com', email_verified: true },
});

const GITHUB = makeFixture('github', {
    iss: 'https://github.com',
    aud: 'beanpool_gh_client',
    otherAud: 'someone_else_client',
    sub: '98765432',
    extraClaims: { email: 'developer@github.com', email_verified: true },
});

const FIXTURES = [GOOGLE, APPLE];

/** Reset both providers' caches, then prime just this one. */
function only(f: Fixture): void {
    _resetJwksCacheForTests();
    f.prime();
    _clearNoncesForTests();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The battery every provider must pass. Anything provider-specific lives after it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function battery(f: Fixture): Promise<void> {
    const { provider, aud, otherAud, mint } = f;
    console.log(`\n── ${f.label} ────────────────────────────────────────────`);

    // ── the happy path ────────────────────────────────────────────────────────────────────────
    only(f);
    let nonce = issueNonce(SUBJECT);
    const identity = await verifyIdToken(provider, mint({ nonce }), [aud], nonce, SUBJECT);
    assert(identity.sub === f.sub, 'a genuine token verifies and returns its sub');
    assert(identity.provider === provider, 'and reports which provider verified it');
    assert(identity.audience === aud, 'and reports which of our client IDs it was issued to');

    // ── the substitution attack aud exists to stop ─────────────────────────────────────────────
    only(f);
    nonce = issueNonce(SUBJECT);
    await rejects(
        () => verifyIdToken(provider, mint({ nonce, aud: otherAud }), [aud], nonce, SUBJECT),
        'a token minted for a DIFFERENT application is refused (token substitution)',
    );

    // Same token, but the node is configured to accept that audience. Proves the check is reading
    // config rather than a hardcoded constant — the multi-client-ID requirement depends on this.
    only(f);
    nonce = issueNonce(SUBJECT);
    const multi = await verifyIdToken(provider, mint({ nonce, aud: otherAud }), [aud, otherAud], nonce, SUBJECT);
    assert(multi.audience === otherAud, 'but a node configured for several client IDs accepts each');

    only(f);
    nonce = issueNonce(SUBJECT);
    await rejects(
        () => verifyIdToken(provider, mint({ nonce }), [], nonce, SUBJECT),
        'a node with NO client ID configured refuses rather than accepting anything',
    );

    // ── signature ─────────────────────────────────────────────────────────────────────────────
    only(f);
    nonce = issueNonce(SUBJECT);
    const tampered = (() => {
        const t = mint({ nonce });
        const [h, , s] = t.split('.');
        // Same shape, different subject — the exact edit an attacker wants to make.
        const now = Math.floor(Date.now() / 1000);
        const p = b64({ iss: f.iss, aud, sub: 'somebody-elses-account', iat: now, exp: now + 3600, nonce });
        return `${h}.${p}.${s}`;
    })();
    await rejects(() => verifyIdToken(provider, tampered, [aud], nonce, SUBJECT),
        'a token whose claims were edited after signing is refused');

    only(f);
    nonce = issueNonce(SUBJECT);
    const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const selfSigned = (() => {
        const now = Math.floor(Date.now() / 1000);
        const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
        const p = b64({ iss: f.iss, aud, sub: 'attacker', iat: now, exp: now + 3600, nonce });
        return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), foreign.privateKey).toString('base64url')}`;
    })();
    await rejects(() => verifyIdToken(provider, selfSigned, [aud], nonce, SUBJECT),
        'a perfectly-formed token signed by the WRONG key is refused');

    // ── algorithm confusion ───────────────────────────────────────────────────────────────────
    only(f);
    nonce = issueNonce(SUBJECT);
    const algNone = (() => {
        const now = Math.floor(Date.now() / 1000);
        const h = b64({ alg: 'none', kid: KID, typ: 'JWT' });
        const p = b64({ iss: f.iss, aud, sub: 'attacker', iat: now, exp: now + 3600, nonce });
        return `${h}.${p}.`;
    })();
    await rejects(() => verifyIdToken(provider, algNone, [aud], nonce, SUBJECT),
        'alg:none is refused (the oldest JWT break there is)');

    only(f);
    nonce = issueNonce(SUBJECT);
    const hs256 = (() => {
        const now = Math.floor(Date.now() / 1000);
        const h = b64({ alg: 'HS256', kid: KID, typ: 'JWT' });
        const p = b64({ iss: f.iss, aud, sub: 'attacker', iat: now, exp: now + 3600, nonce });
        const pem = f.publicKey.export({ type: 'spki', format: 'pem' }) as string;
        const mac = crypto.createHmac('sha256', pem).update(`${h}.${p}`).digest('base64url');
        return `${h}.${p}.${mac}`;
    })();
    await rejects(() => verifyIdToken(provider, hs256, [aud], nonce, SUBJECT),
        'HS256 signed with the PUBLIC key as the HMAC secret is refused (alg confusion)');

    // ── issuer / expiry ───────────────────────────────────────────────────────────────────────
    only(f);
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken(provider, mint({ nonce, iss: 'https://evil.example.com' }), [aud], nonce, SUBJECT),
        'a wrong issuer is refused');

    only(f);
    nonce = issueNonce(SUBJECT);
    const then = Math.floor(Date.now() / 1000) - 7200;
    await rejects(() => verifyIdToken(provider, mint({ nonce, iat: then, exp: then + 3600 }), [aud], nonce, SUBJECT),
        'an expired token is refused');

    only(f);
    nonce = issueNonce(SUBJECT);
    const soon = Math.floor(Date.now() / 1000) + 7200;
    await rejects(() => verifyIdToken(provider, mint({ nonce, iat: soon, exp: soon + 3600 }), [aud], nonce, SUBJECT),
        'a token dated in the future is refused');

    // Clock skew is a real allowance, not an accident: nodes on cheap VMs drift.
    only(f);
    nonce = issueNonce(SUBJECT);
    const justExpired = Math.floor(Date.now() / 1000) - 30;
    const skewed = await verifyIdToken(provider, mint({ nonce, exp: justExpired }), [aud], nonce, SUBJECT);
    assert(skewed.sub.length > 0, 'but one that expired 30s ago still passes, for clock drift');

    // ── nonce / replay ────────────────────────────────────────────────────────────────────────
    only(f);
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken(provider, mint({ nonce: 'not-the-one-we-issued' }), [aud], nonce, SUBJECT),
        "a token carrying someone else's nonce is refused");

    only(f);
    nonce = issueNonce(SUBJECT);
    if (provider === 'google') {
        // Google's free GoogleSignin.signIn() API never embeds a nonce claim (see the
        // dedicated comment in sso.ts) — a missing claim is the EXPECTED shape for this
        // provider, tolerated only when expectedNonce itself is validly issued+consumed.
        const identity = await verifyIdToken(provider, mint({}), [aud], nonce, SUBJECT);
        assert(identity.sub === f.sub, 'a Google token with NO nonce still verifies (tolerated for the free API)');
    } else {
        await rejects(() => verifyIdToken(provider, mint({}), [aud], nonce, SUBJECT),
            'a token with NO nonce is refused');
    }

    only(f);
    nonce = issueNonce(SUBJECT);
    const token = mint({ nonce });
    await verifyIdToken(provider, token, [aud], nonce, SUBJECT);
    await rejects(() => verifyIdToken(provider, token, [aud], nonce, SUBJECT),
        'REPLAY: the same valid token cannot be used twice — the nonce is consumed');

    only(f);
    const nonceA = issueNonce(SUBJECT);
    const nonceB = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken(provider, mint({ nonce: nonceA }), [aud], nonceB, SUBJECT),
        "a token for one sign-in cannot be presented against another node's nonce");

    assert(issueNonce(SUBJECT) !== issueNonce(SUBJECT), 'nonces are unique per issue');

    // The binding #218 promised the routes would provide, enforced here instead of trusted.
    only(f);
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken(provider, mint({ nonce }), [aud], nonce, OTHER_SUBJECT),
        'a nonce issued to one member cannot be used by another');
    const ownerStillWorks = await verifyIdToken(provider, mint({ nonce }), [aud], nonce, SUBJECT);
    assert(ownerStillWorks.sub.length > 0,
        '...and the member it WAS issued to can still use it — the wrong-member attempt did not burn it');

    // A failed attempt must NOT burn the pending nonce. Review proposed consuming unconditionally
    // "regardless of match result"; declined, because that turns anyone able to submit a bad token
    // into a denial of service against the person legitimately signing in. Locked in with a test so
    // it reads as a decision rather than an oversight — the next person to spot the short-circuit
    // will otherwise "fix" it.
    only(f);
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken(provider, mint({ nonce: 'wrong' }), [aud], nonce, SUBJECT),
        'a bad token is refused...');
    const survivor = await verifyIdToken(provider, mint({ nonce }), [aud], nonce, SUBJECT);
    assert(survivor.sub.length > 0,
        '...and the legitimate sign-in still succeeds afterwards — a failure does not burn the nonce');

    // ── malformed input ───────────────────────────────────────────────────────────────────────
    only(f);
    nonce = issueNonce(SUBJECT);
    for (const [bad, what] of [['', 'empty'], ['a.b', 'two segments'], ['a.b.c.d', 'four segments'],
                               ['not-a-jwt', 'no dots'], ['!!.??.$$', 'unparseable base64']] as const) {
        await rejects(() => verifyIdToken(provider, bad, [aud], nonce, SUBJECT),
            `malformed input is refused (${what})`);
    }

    // ── oversized input ───────────────────────────────────────────────────────────────────────
    // Rejected on length BEFORE any split, base64 decode or JSON.parse. `decodeSegment` has to
    // parse the header before anything is verified — the kid lives there — so without this a
    // multi-megabyte blob buys an attacker a large allocation and a large parse per request.
    only(f);
    nonce = issueNonce(SUBJECT);
    const real = mint({ nonce });
    assert(real.length < 8192, 'a genuine token is well under the size ceiling');
    // Padded inside the payload segment, so it stays a structurally valid JWT: this proves the
    // rejection is the size guard and not the malformed-input check catching it by accident.
    const huge = (() => {
        const [h, , s] = real.split('.');
        const now = Math.floor(Date.now() / 1000);
        const p = b64({ iss: f.iss, aud, sub: 'x'.repeat(64_000), iat: now, exp: now + 3600, nonce });
        return `${h}.${p}.${s}`;
    })();
    assert(huge.split('.').length === 3 && huge.length > 8192,
        '...and the oversized one is still a three-segment JWT, so the size guard is what catches it');
    await rejects(() => verifyIdToken(provider, huge, [aud], nonce, SUBJECT),
        'an implausibly large token is refused on length, before it is decoded');
    // And the nonce it carried was never reached, let alone consumed.
    const afterHuge = await verifyIdToken(provider, real, [aud], nonce, SUBJECT);
    assert(afterHuge.sub === f.sub, '...and the legitimate token with that nonce still works');

    // ── unknown kid ───────────────────────────────────────────────────────────────────────────
    // Cache holds a key, token names a different one. The verifier refetches once and then gives up
    // rather than trusting a key it does not have. The refetch reaches the real JWKS if there is a
    // network and fails if there is not; either way this must fail CLOSED.
    only(f);
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken(provider, mint({ nonce }, { kid: 'rotated-away' }), [aud], nonce, SUBJECT),
        'a token signed by an unknown key id fails CLOSED');
}

async function main(): Promise<void> {
    console.log('\nOIDC id_token verification — Google and Apple\n');

    for (const f of FIXTURES) await battery(f);

    // ── cross-provider ────────────────────────────────────────────────────────────────────────
    //
    // The reason both fixtures share a `kid`. With a single shared JWKS cache — the obvious way to
    // generalise #218's module-level variable — whichever provider was primed last would answer
    // for both, so one of these two verifications would fail on the signature and the providers
    // would evict each other on every request. Priming both and verifying both is the proof that
    // the caches are separate.
    console.log('\n── cross-provider ───────────────────────────────────────');
    _resetJwksCacheForTests();
    GOOGLE.prime();
    APPLE.prime();
    _clearNoncesForTests();

    let nonce = issueNonce(SUBJECT);
    const g = await verifyIdToken('google', GOOGLE.mint({ nonce }), [GOOGLE.aud], nonce, SUBJECT);
    nonce = issueNonce(SUBJECT);
    const a = await verifyIdToken('apple', APPLE.mint({ nonce }), [APPLE.aud], nonce, SUBJECT);
    assert(g.provider === 'google' && a.provider === 'apple',
        'both providers verify with the same kid in play — the JWKS caches are per provider');

    // A Google token offered as an Apple one must not resolve. It fails at the signature, because
    // the shared kid selects Apple's key — which is precisely the confusion a shared cache invites.
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken('apple', GOOGLE.mint({ nonce }), [GOOGLE.aud, APPLE.aud], nonce, SUBJECT),
        'a Google token presented as an Apple one is refused');
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken('google', APPLE.mint({ nonce }), [GOOGLE.aud, APPLE.aud], nonce, SUBJECT),
        'and an Apple token presented as a Google one is refused');

    // A provider name that is not recognized must not fall through to a default.
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyIdToken('twitter' as SsoProvider, GOOGLE.mint({ nonce }), [GOOGLE.aud], nonce, SUBJECT),
        'a provider this node does not support is refused rather than defaulted');
    assert(isSsoProvider('google') && isSsoProvider('apple') && isSsoProvider('facebook') && isSsoProvider('github'),
        'google, apple, facebook, and github are recognised providers');
    assert(!isSsoProvider('twitter') && !isSsoProvider('') && !isSsoProvider(undefined)
        && !isSsoProvider('constructor'),
        'and twitter, empty and Object.prototype keys are not');

    // GitHub unverified pseudo-JWT verification attempt must fail
    nonce = issueNonce(SUBJECT);
    const unverifiedGithubJwt = GITHUB.mint({ nonce });
    await rejects(() => verifyIdToken('github', unverifiedGithubJwt, [GITHUB.aud], nonce, SUBJECT),
        'an unverified pseudo-JWT for GitHub is refused');

    // The exported list must BE the table, not a copy of it that drifts (CR). Checked against
    // isSsoProvider in both directions so neither can gain an entry the other lacks.
    assert(SSO_PROVIDERS.length === 4 && SSO_PROVIDERS.every(isSsoProvider),
        'SSO_PROVIDERS lists exactly the providers isSsoProvider accepts');
    assert(SSO_PROVIDERS.includes('google') && SSO_PROVIDERS.includes('apple')
        && SSO_PROVIDERS.includes('facebook') && SSO_PROVIDERS.includes('github'),
        'and names all four of them, so a message built from it cannot go stale');

    // ── Apple's quirks ────────────────────────────────────────────────────────────────────────
    console.log('\n── Apple specifics ──────────────────────────────────────');

    // Apple sends email_verified / is_private_email as STRINGS in some flows. #218 read them with
    // `typeof === 'boolean'`, which silently dropped Apple's form to undefined.
    only(APPLE);
    nonce = issueNonce(SUBJECT);
    const strings = await verifyIdToken('apple', APPLE.mint({ nonce }), [APPLE.aud], nonce, SUBJECT);
    assert(strings.emailVerified === true, 'Apple\'s string "true" for email_verified becomes a boolean');
    assert(strings.privateEmail === true, 'and so does is_private_email, flagging a relay address');

    only(GOOGLE);
    nonce = issueNonce(SUBJECT);
    const bools = await verifyIdToken('google', GOOGLE.mint({ nonce }), [GOOGLE.aud], nonce, SUBJECT);
    assert(bools.emailVerified === true, 'and a real boolean still reads as itself');
    assert(bools.privateEmail === undefined, 'a claim that is absent stays undefined rather than false');

    only(APPLE);
    nonce = issueNonce(SUBJECT);
    const junk = await verifyIdToken('apple', APPLE.mint({ nonce, email_verified: 'yes' }), [APPLE.aud], nonce, SUBJECT);
    assert(junk.emailVerified === undefined, 'and an unrecognised value is undefined, not coerced to true');

    // Apple returns the email on the FIRST authorization only. Every later sign-in — which is what
    // a keeper re-deposit is — arrives without one, and that is normal.
    only(APPLE);
    nonce = issueNonce(SUBJECT);
    const noEmail = await verifyIdToken('apple',
        APPLE.mint({ nonce, email: undefined, email_verified: undefined }), [APPLE.aud], nonce, SUBJECT);
    assert(noEmail.sub === APPLE.sub && noEmail.email === undefined,
        'an Apple token with NO email still verifies — Apple sends it on first authorization only');

    // The Services ID audience, for a member recovering from a browser rather than the phone.
    only(APPLE);
    nonce = issueNonce(SUBJECT);
    const web = await verifyIdToken('apple', APPLE.mint({ nonce, aud: 'org.beanpool.web' }),
        getConfiguredAudiences('apple'), nonce, SUBJECT);
    assert(web.audience === 'org.beanpool.web',
        'the web Services ID is accepted as well as the bundle ID — cross-platform recovery needs both');

    // Apple's native flow conventionally carries SHA-256(nonce). Accepting both spellings is what
    // stops a correctly-implemented client from failing at recovery time for a reason nobody sees.
    only(APPLE);
    nonce = issueNonce(SUBJECT);
    const hashed = crypto.createHash('sha256').update(nonce, 'utf-8').digest('hex');
    const viaHash = await verifyIdToken('apple', APPLE.mint({ nonce: hashed }), [APPLE.aud], nonce, SUBJECT);
    assert(viaHash.sub === APPLE.sub, 'Apple may echo SHA-256(nonce) instead of the nonce, and both are accepted');

    only(APPLE);
    nonce = issueNonce(SUBJECT);
    const wrongHash = crypto.createHash('sha256').update('some-other-nonce', 'utf-8').digest('hex');
    await rejects(() => verifyIdToken('apple', APPLE.mint({ nonce: wrongHash }), [APPLE.aud], nonce, SUBJECT),
        "...but the hash of somebody else's nonce is still refused");

    // The tolerance is Apple-only on purpose: Google echoes the nonce verbatim, so a second
    // accepted spelling there would be a wider door with no failure behind it.
    only(GOOGLE);
    nonce = issueNonce(SUBJECT);
    const gHashed = crypto.createHash('sha256').update(nonce, 'utf-8').digest('hex');
    await rejects(() => verifyIdToken('google', GOOGLE.mint({ nonce: gHashed }), [GOOGLE.aud], nonce, SUBJECT),
        'Google stays strict — a hashed nonce is refused there');

    // ── lookup hash ───────────────────────────────────────────────────────────────────────────
    console.log('\n── lookup hash ──────────────────────────────────────────');
    const salt1 = newSsoLookupSalt();
    const salt2 = newSsoLookupSalt();
    const sub = GOOGLE.sub;
    const h1 = await ssoLookupHash('google', sub, salt1);
    const h1again = await ssoLookupHash('google', sub, salt1);
    const h2 = await ssoLookupHash('google', sub, salt2);
    const hApple = await ssoLookupHash('apple', sub, salt1);
    assert(h1 === h1again, 'the lookup hash is deterministic for the same sub and salt');
    assert(h1 !== h2, 'and differs across salts, so two nodes holding the same person cannot be correlated');
    assert(h1 !== hApple, 'and differs across providers, so a Google sub cannot masquerade as an Apple one');
    assert(!h1.includes(sub), 'and never contains the raw subject');
    assert(salt1 !== salt2, 'salts are random per share');

    // ── configured audiences ──────────────────────────────────────────────────────────────────
    console.log('\n── configured audiences ─────────────────────────────────');
    delete process.env.GOOGLE_CLIENT_IDS;
    const googleDefaults = getConfiguredAudiences('google');
    assert(googleDefaults.length === 4, 'a node with no config accepts all four BeanPool Google client IDs');
    assert(googleDefaults.every(id => id.startsWith('653933790375-')),
        'and all of them belong to the beanpool project (653933790375)');
    assert(googleDefaults.includes(GOOGLE.aud), 'including the Web client the app sends as serverClientId');

    process.env.GOOGLE_CLIENT_IDS = ` ${GOOGLE.otherAud} , ,  ${GOOGLE.aud} `;
    const configured = getConfiguredAudiences('google');
    assert(configured.length === 2 && configured[0] === GOOGLE.otherAud && configured[1] === GOOGLE.aud,
        'GOOGLE_CLIENT_IDS is parsed, trimmed, and empty entries dropped');
    assert(!configured.includes(googleDefaults[1]),
        'and REPLACES the defaults — an operator restricting their node is not silently overridden');

    process.env.GOOGLE_CLIENT_IDS = '   ';
    assert(getConfiguredAudiences('google').length === 4,
        'a blank value falls back to the defaults rather than accepting nothing');
    delete process.env.GOOGLE_CLIENT_IDS;

    delete process.env.APPLE_CLIENT_IDS;
    delete process.env.APPLE_SERVICES_ID;
    const appleDefaults = getConfiguredAudiences('apple');
    assert(appleDefaults.length === 2 && appleDefaults.includes('org.beanpool.pillar')
        && appleDefaults.includes('org.beanpool.web'),
        'Apple defaults to the bundle ID (native) and the Services ID (web)');

    // apple-probe.ts already reads APPLE_SERVICES_ID. A node that overrides it there must not end
    // up with a probe and a verifier that disagree about which Services ID is ours.
    process.env.APPLE_SERVICES_ID = 'org.example.signin';
    const overridden = getConfiguredAudiences('apple');
    assert(overridden.includes('org.example.signin') && overridden.includes('org.beanpool.pillar')
        && !overridden.includes('org.beanpool.web'),
        'APPLE_SERVICES_ID replaces the Services ID in the defaults, matching apple-probe.ts');

    process.env.APPLE_SERVICES_ID = 'org.beanpool.pillar';
    assert(getConfiguredAudiences('apple').length === 1,
        'and a Services ID equal to the bundle ID collapses to one entry rather than duplicating');
    delete process.env.APPLE_SERVICES_ID;

    process.env.APPLE_CLIENT_IDS = 'com.operator.app';
    const appleConfigured = getConfiguredAudiences('apple');
    assert(appleConfigured.length === 1 && appleConfigured[0] === 'com.operator.app',
        'APPLE_CLIENT_IDS replaces the Apple defaults, same rule as Google');
    assert(getConfiguredAudiences('google').length === 4,
        'and one provider\'s config does not touch the other\'s');
    delete process.env.APPLE_CLIENT_IDS;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ SSO verification checks PASSED (Google + Apple).');
}

main().then(() => {
    // Explicit, per the convention the rest of the suites now follow.
    process.exit(0);
}).catch((e) => {
    console.error(e);
    process.exit(1);
});
