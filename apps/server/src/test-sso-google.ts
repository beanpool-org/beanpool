/**
 * Google id_token verification — proven against real RSA signatures, not mocks.
 *
 * The suite mints its own keypair and issues tokens with it, then substitutes that key into the
 * JWKS cache. So every "valid token" here carries a genuine RS256 signature over genuine claims,
 * and every rejection test proves the verifier refuses something it could otherwise have accepted.
 *
 * The tests that matter most are the negative ones. A verifier that accepts good tokens but also
 * accepts `alg: none`, or a token minted for someone else's client ID, is worse than no verifier —
 * it looks like security while granting a stranger a fragment of somebody's account.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sso-google.ts
 */
import crypto from 'node:crypto';
import {
    verifyGoogleIdToken,
    issueNonce,
    ssoLookupHash,
    newSsoLookupSalt,
    getConfiguredGoogleAudiences,
    SsoVerificationError,
    _resetJwksCacheForTests,
    _clearNoncesForTests,
} from './sso-google.js';

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
const KID = 'test-key-1';
const AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const OTHER_AUD = '999999999999-someoneelsesapp.apps.googleusercontent.com';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' } as any;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');

/** Mint a token signed by our test key. Overrides let each test bend exactly one thing. */
function mint(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
    const p = b64({
        iss: 'https://accounts.google.com',
        aud: AUD,
        sub: '110169484474386276334',
        email: 'someone@gmail.com',
        email_verified: true,
        iat: now,
        exp: now + 3600,
        ...claims,
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), privateKey);
    return `${h}.${p}.${sig.toString('base64url')}`;
}

/** Pin the cache to our test key so nothing reaches the network. */
function primeJwks(): void {
    _resetJwksCacheForTests({ keys: [jwk], expiresAt: Date.now() + 3600_000 });
}

async function main(): Promise<void> {
    console.log('\nGoogle id_token verification\n');

    // ── the happy path ────────────────────────────────────────────────────────────────────────
    primeJwks(); _clearNoncesForTests();
    let nonce = issueNonce(SUBJECT);
    const identity = await verifyGoogleIdToken(mint({ nonce }), [AUD], nonce, SUBJECT);
    assert(identity.sub === '110169484474386276334', 'a genuine token verifies and returns its sub');
    assert(identity.email === 'someone@gmail.com', 'and carries the email through for display');
    assert(identity.audience === AUD, 'and reports which of our client IDs it was issued to');

    // ── the substitution attack aud exists to stop ─────────────────────────────────────────────
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    await rejects(
        () => verifyGoogleIdToken(mint({ nonce, aud: OTHER_AUD }), [AUD], nonce, SUBJECT),
        'a token minted for a DIFFERENT application is refused (token substitution)',
    );

    // Same token, but the node is configured to accept that audience. Proves the check is reading
    // config rather than a hardcoded constant — the multi-client-ID requirement depends on this.
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const multi = await verifyGoogleIdToken(mint({ nonce, aud: OTHER_AUD }), [AUD, OTHER_AUD], nonce, SUBJECT);
    assert(multi.audience === OTHER_AUD, 'but a node configured for several client IDs accepts each');

    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    await rejects(
        () => verifyGoogleIdToken(mint({ nonce }), [], nonce, SUBJECT),
        'a node with NO client ID configured refuses rather than accepting anything',
    );

    // ── signature ─────────────────────────────────────────────────────────────────────────────
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const tampered = (() => {
        const t = mint({ nonce });
        const [h, , s] = t.split('.');
        // Same shape, different subject — the exact edit an attacker wants to make.
        const p = b64({
            iss: 'https://accounts.google.com', aud: AUD, sub: 'somebody-elses-account',
            iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce,
        });
        return `${h}.${p}.${s}`;
    })();
    await rejects(() => verifyGoogleIdToken(tampered, [AUD], nonce, SUBJECT),
        'a token whose claims were edited after signing is refused');

    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const selfSigned = (() => {
        const now = Math.floor(Date.now() / 1000);
        const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
        const p = b64({ iss: 'https://accounts.google.com', aud: AUD, sub: 'attacker', iat: now, exp: now + 3600, nonce });
        return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), foreign.privateKey).toString('base64url')}`;
    })();
    await rejects(() => verifyGoogleIdToken(selfSigned, [AUD], nonce, SUBJECT),
        'a perfectly-formed token signed by the WRONG key is refused');

    // ── algorithm confusion ───────────────────────────────────────────────────────────────────
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const algNone = (() => {
        const now = Math.floor(Date.now() / 1000);
        const h = b64({ alg: 'none', kid: KID, typ: 'JWT' });
        const p = b64({ iss: 'https://accounts.google.com', aud: AUD, sub: 'attacker', iat: now, exp: now + 3600, nonce });
        return `${h}.${p}.`;
    })();
    await rejects(() => verifyGoogleIdToken(algNone, [AUD], nonce, SUBJECT),
        'alg:none is refused (the oldest JWT break there is)');

    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const hs256 = (() => {
        const now = Math.floor(Date.now() / 1000);
        const h = b64({ alg: 'HS256', kid: KID, typ: 'JWT' });
        const p = b64({ iss: 'https://accounts.google.com', aud: AUD, sub: 'attacker', iat: now, exp: now + 3600, nonce });
        const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
        const mac = crypto.createHmac('sha256', pem).update(`${h}.${p}`).digest('base64url');
        return `${h}.${p}.${mac}`;
    })();
    await rejects(() => verifyGoogleIdToken(hs256, [AUD], nonce, SUBJECT),
        'HS256 signed with the PUBLIC key as the HMAC secret is refused (alg confusion)');

    // ── issuer / expiry ───────────────────────────────────────────────────────────────────────
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyGoogleIdToken(mint({ nonce, iss: 'https://evil.example.com' }), [AUD], nonce, SUBJECT),
        'a wrong issuer is refused');

    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const bare = await verifyGoogleIdToken(mint({ nonce, iss: 'accounts.google.com' }), [AUD], nonce, SUBJECT);
    assert(bare.sub.length > 0, 'both of Google\'s issuer spellings are accepted');

    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const then = Math.floor(Date.now() / 1000) - 7200;
    await rejects(() => verifyGoogleIdToken(mint({ nonce, iat: then, exp: then + 3600 }), [AUD], nonce, SUBJECT),
        'an expired token is refused');

    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const soon = Math.floor(Date.now() / 1000) + 7200;
    await rejects(() => verifyGoogleIdToken(mint({ nonce, iat: soon, exp: soon + 3600 }), [AUD], nonce, SUBJECT),
        'a token dated in the future is refused');

    // Clock skew is a real allowance, not an accident: nodes on cheap VMs drift.
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const justExpired = Math.floor(Date.now() / 1000) - 30;
    const skewed = await verifyGoogleIdToken(mint({ nonce, exp: justExpired }), [AUD], nonce, SUBJECT);
    assert(skewed.sub.length > 0, 'but one that expired 30s ago still passes, for clock drift');

    // ── nonce / replay ────────────────────────────────────────────────────────────────────────
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyGoogleIdToken(mint({ nonce: 'not-the-one-we-issued' }), [AUD], nonce, SUBJECT),
        'a token carrying someone else\'s nonce is refused');

    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyGoogleIdToken(mint({}), [AUD], nonce, SUBJECT),
        'a token with NO nonce is refused');

    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    const token = mint({ nonce });
    await verifyGoogleIdToken(token, [AUD], nonce, SUBJECT);
    await rejects(() => verifyGoogleIdToken(token, [AUD], nonce, SUBJECT),
        'REPLAY: the same valid token cannot be used twice — the nonce is consumed');

    primeJwks(); _clearNoncesForTests();
    const nonceA = issueNonce(SUBJECT);
    const nonceB = issueNonce(SUBJECT);
    await rejects(() => verifyGoogleIdToken(mint({ nonce: nonceA }), [AUD], nonceB, SUBJECT),
        'a token for one sign-in cannot be presented against another node\'s nonce');

    assert(issueNonce(SUBJECT) !== issueNonce(SUBJECT), 'nonces are unique per issue');

    // The binding #218 promised the routes would provide, now enforced here instead of trusted.
    primeJwks(); _clearNoncesForTests();
    const OTHER_SUBJECT = 'b'.repeat(64);
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyGoogleIdToken(mint({ nonce }), [AUD], nonce, OTHER_SUBJECT),
        'a nonce issued to one member cannot be used by another');
    const ownerStillWorks = await verifyGoogleIdToken(mint({ nonce }), [AUD], nonce, SUBJECT);
    assert(ownerStillWorks.sub.length > 0,
        '...and the member it WAS issued to can still use it — the wrong-member attempt did not burn it');

    // A failed attempt must NOT burn the pending nonce. Review proposed consuming unconditionally
    // "regardless of match result"; declined, because that turns anyone able to submit a bad token
    // into a denial of service against the person legitimately signing in. Locked in with a test so
    // it reads as a decision rather than an oversight — the next person to spot the short-circuit
    // will otherwise "fix" it.
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyGoogleIdToken(mint({ nonce: 'wrong' }), [AUD], nonce, SUBJECT),
        'a bad token is refused...');
    const survivor = await verifyGoogleIdToken(mint({ nonce }), [AUD], nonce, SUBJECT);
    assert(survivor.sub.length > 0,
        '...and the legitimate sign-in still succeeds afterwards — a failure does not burn the nonce');

    // ── malformed input ───────────────────────────────────────────────────────────────────────
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    for (const [bad, what] of [['', 'empty'], ['a.b', 'two segments'], ['a.b.c.d', 'four segments'],
                               ['not-a-jwt', 'no dots'], ['!!.??.$$', 'unparseable base64']] as const) {
        await rejects(() => verifyGoogleIdToken(bad, [AUD], nonce, SUBJECT), `malformed input is refused (${what})`);
    }

    // ── unknown kid ───────────────────────────────────────────────────────────────────────────
    // Cache holds a key, token names a different one. The verifier refetches once and then gives up
    // rather than trusting a key it does not have — here the refetch fails (no network in tests),
    // which is exactly the "Google unreachable" case, and it must fail closed.
    primeJwks(); _clearNoncesForTests();
    nonce = issueNonce(SUBJECT);
    await rejects(() => verifyGoogleIdToken(mint({ nonce }, { kid: 'rotated-away' }), [AUD], nonce, SUBJECT),
        'a token signed by an unknown key id fails CLOSED');

    // ── lookup hash ───────────────────────────────────────────────────────────────────────────
    const salt1 = newSsoLookupSalt();
    const salt2 = newSsoLookupSalt();
    const sub = '110169484474386276334';
    const h1 = await ssoLookupHash('google', sub, salt1);
    const h1again = await ssoLookupHash('google', sub, salt1);
    const h2 = await ssoLookupHash('google', sub, salt2);
    const hApple = await ssoLookupHash('apple', sub, salt1);
    assert(h1 === h1again,
        'the lookup hash is deterministic for the same sub and salt');
    assert(h1 !== h2,
        'and differs across salts, so two nodes holding the same person cannot be correlated');
    assert(h1 !== hApple,
        'and differs across providers, so a Google sub cannot masquerade as an Apple one');
    assert(!h1.includes(sub),
        'and never contains the raw subject');
    assert(salt1 !== salt2, 'salts are random per share');

    // ── configured audiences ──────────────────────────────────────────────────────────────────
    delete process.env.GOOGLE_CLIENT_IDS;
    const defaults = getConfiguredGoogleAudiences();
    assert(defaults.length === 4, 'a node with no config accepts all four BeanPool client IDs');
    assert(defaults.every(id => id.startsWith('653933790375-')),
        'and all of them belong to the beanpool project (653933790375)');
    assert(defaults.includes(AUD), 'including the Web client the app sends as serverClientId');

    process.env.GOOGLE_CLIENT_IDS = ` ${OTHER_AUD} , ,  ${AUD} `;
    const configured = getConfiguredGoogleAudiences();
    assert(configured.length === 2 && configured[0] === OTHER_AUD && configured[1] === AUD,
        'GOOGLE_CLIENT_IDS is parsed, trimmed, and empty entries dropped');
    assert(!configured.includes(defaults[1]),
        'and REPLACES the defaults — an operator restricting their node is not silently overridden');

    process.env.GOOGLE_CLIENT_IDS = '   ';
    assert(getConfiguredGoogleAudiences().length === 4,
        'a blank value falls back to the defaults rather than accepting nothing');
    delete process.env.GOOGLE_CLIENT_IDS;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Google SSO verification checks PASSED.');
}

main().then(() => {
    // Explicit, per the convention the rest of the suites now follow.
    process.exit(0);
}).catch((e) => {
    console.error(e);
    process.exit(1);
});
