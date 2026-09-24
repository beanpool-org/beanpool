/**
 * The open door (global node G2): POST /api/join/sso-nonce and POST /api/join, over REAL HTTPS through the real
 * signature middleware. No provider is contacted: the Google and Apple JWKS are test keys primed into sso.ts's
 * cache, the same fixtures as test-sso-recovery-roundtrip.
 *
 *   1. local profile: both routes 404 "invite-only" (signed), an unsigned POST never reaches them, and
 *      /api/community/info says openJoin false
 *   2. global profile: openJoin true; unsigned → 401; a body publicKey naming someone else → refused
 *   3. the sign-in: forged, expired, wrong-audience, wrong-issuer, wrong-nonce, unissued-nonce, another key's
 *      nonce → 401 and nothing written; the other key's nonce still works for them afterwards; the provider's
 *      keys failing (HTTP 503, or no usable keys) → 503 sign_in_unavailable, not 401, and the nonce is kept
 *   4. a good join: member with invited_by open:google and no invite code, the open_joins row, the funnel counts,
 *      and neither the raw sub nor the email anywhere in the database
 *   5. the same sign-in account again → 409 with the restore hint; a replayed nonce → 401; the joined key
 *      again → 409; a join nonce cannot be spent on the recovery routes
 *   6. one sign-in, two jobs: the recovery body enrols the same account from the one verification; the
 *      lookup hash is the node's, from the verified sub, and the stored blob opens with it; a malformed
 *      recovery body, or a two-layer split with no hub fragment, is refused before the nonce is spent
 *   7. sign-ups per address: 5 an hour and 20 a day → 429 without spending the nonce; the address hash is
 *      cleared once a day old, by the next join or by the timer when nobody joins; the auth limiter still applies
 *   8. deleting your own account frees the sign-in account; one deleted while suspended, or a member the community
 *      removed, stays used (403)
 *   9. the door is read per request: back to local, the routes 404 again
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-join.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, adminPruneUser } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests, ssoLookupHash } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { getFunnel } from './engine/funnel.js';
import { OPEN_JOIN_LIMITS, startForgettingJoinAddresses } from './engine/open-join.js';
import { sealSeedToSso, sealShareToSso, openShareFromSso } from '@beanpool/core';

const PORT = 8729;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── provider fixtures ───────────────────────────────────────────────────────────────────────────
const GOOGLE_KID = 'test-open-join-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const APPLE_KID = 'test-open-join-apple';
const APPLE_AUD = 'org.beanpool.pillar';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const apple = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const impostor = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (k: crypto.KeyObject, kid: string) => ({ ...k.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }) as any;

function primeJwks(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [jwk(google.publicKey, GOOGLE_KID)], expiresAt: Date.now() + 3600_000 });
    _resetJwksCacheForTests('apple', { keys: [jwk(apple.publicKey, APPLE_KID)], expiresAt: Date.now() + 3600_000 });
}

type Provider = 'google' | 'apple';
interface TokenOpts { sub: string; nonce: string; email?: string; aud?: string; iss?: string; exp?: number; signer?: crypto.KeyObject }

function mint(provider: Provider, o: TokenOpts): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: provider === 'google' ? GOOGLE_KID : APPLE_KID, typ: 'JWT' });
    const payload = b64({
        iss: o.iss ?? (provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com'),
        aud: o.aud ?? (provider === 'google' ? GOOGLE_AUD : APPLE_AUD),
        sub: o.sub,
        email: o.email,
        email_verified: true,
        iat: now,
        exp: o.exp ?? now + 3600,
        nonce: o.nonce,
    });
    const key = o.signer ?? (provider === 'google' ? google.privateKey : apple.privateKey);
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

// ── joiners ─────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; seed: Uint8Array }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const seed = new Uint8Array((privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32));
    return { pk, priv: privateKey, seed };
}

/** Fresh limiter windows, so the suite's own request count never decides a result it isn't testing. */
function freshLimiters(): void {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
}
/** Set only by the block that tests the auth limiter itself. */
let holdLimiters = false;

async function call(id: Id | null, path: string, body: unknown): Promise<{ status: number; body: any }> {
    if (!holdLimiters) freshLimiters();
    const raw = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: raw });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
}

async function joinNonce(id: Id): Promise<string> {
    const r = await call(id, '/api/join/sso-nonce', {});
    if (r.status !== 200 || typeof r.body?.nonce !== 'string') throw new Error(`no join nonce: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.nonce;
}

const join = (id: Id, body: Record<string, unknown>) => call(id, '/api/join', body);

const memberRow = (pk: string) => db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk) as any;
const joinRow = (pk: string) => db.prepare('SELECT * FROM open_joins WHERE member_pubkey = ?').get(pk) as any;
const countJoins = () => (db.prepare('SELECT COUNT(*) AS n FROM open_joins').get() as any).n as number;
function funnelCount(event: string, variant: string): number {
    return getFunnel(1).filter(r => r.event === event && r.variant === variant).reduce((n, r) => n + r.count, 0);
}
async function info(): Promise<any> {
    return (await (await fetch(`${BASE}/api/community/info`)).json()) as any;
}

async function main(): Promise<void> {
    console.log('\n=== The open door: /api/join over real HTTPS ===\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);
    primeJwks();
    _clearNoncesForTests();

    // ── 1. local profile ─────────────────────────────────────────────────────────────────────────
    console.log('── 1. local profile: the door is shut ──');
    const shut = newId();
    const shutNonce = await call(shut, '/api/join/sso-nonce', {});
    assert(shutNonce.status === 404 && shutNonce.body?.code === 'invite_only' && shutNonce.body?.error === 'This community is invite-only.',
        `local: a signed POST /api/join/sso-nonce answers 404 "This community is invite-only." (got ${shutNonce.status} ${JSON.stringify(shutNonce.body)})`);
    const shutJoin = await join(shut, { callsign: 'Shut', provider: 'google', idToken: mint('google', { sub: '1', nonce: 'x' }), nonce: 'x' });
    assert(shutJoin.status === 404 && shutJoin.body?.code === 'invite_only', `local: a signed POST /api/join answers 404 (got ${shutJoin.status})`);
    assert((await call(null, '/api/join', { callsign: 'Shut' })).status === 401, 'local: an unsigned POST /api/join is refused by the middleware (401)');
    assert(!memberRow(shut.pk), 'local: nobody joined');
    assert((await info()).features?.openJoin === false, 'local: /api/community/info says openJoin false');

    // ── 2. global profile: signed or nothing ─────────────────────────────────────────────────────
    console.log('\n── 2. global profile: the door is signed ──');
    process.env.NODE_PROFILE = 'global';
    assert((await info()).features?.openJoin === true, 'global: /api/community/info says openJoin true');
    const unsignedNonce = await call(null, '/api/join/sso-nonce', {});
    assert(unsignedNonce.status === 401 && /signature/i.test(String(unsignedNonce.body?.error)),
        `global: an unsigned nonce request is refused by the signature middleware (got ${unsignedNonce.status})`);

    const ada = newId();
    const GOOGLE_SUB = '110169484474386276334';
    const GOOGLE_EMAIL = 'open-join-ada@example.com';
    let n = await joinNonce(ada);
    const nonceBody = await call(ada, '/api/join/sso-nonce', {});
    assert(nonceBody.status === 200 && nonceBody.body.expiresInSeconds === 600
        && JSON.stringify(nonceBody.body.providers) === JSON.stringify(['google', 'apple', 'facebook', 'github']),
        'global: the nonce answer has the recovery nonce shape (nonce, expiresInSeconds, providers)');

    const unsignedJoin = await call(null, '/api/join', { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: n }), nonce: n });
    assert(unsignedJoin.status === 401, `global: an unsigned POST /api/join → 401 (got ${unsignedJoin.status})`);
    const someoneElse = newId();
    const spoof = await join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: n }), nonce: n, publicKey: someoneElse.pk });
    assert(spoof.status === 403, `a body publicKey naming another key is refused by the middleware (got ${spoof.status})`);
    assert(!memberRow(someoneElse.pk) && !memberRow(ada.pk) && countJoins() === 0, '...and nobody joined, as either key');

    // ── 3. the sign-in must verify ───────────────────────────────────────────────────────────────
    console.log('\n── 3. the sign-in must verify ──');
    const now = Math.floor(Date.now() / 1000);
    const bad: Array<[string, () => Promise<{ status: number; body: any }>]> = [
        ['a forged token (right kid, wrong key)', () => join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: n, signer: impostor.privateKey }), nonce: n })],
        ['an expired token', () => join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: n, exp: now - 3600 }), nonce: n })],
        ['a token issued to another app (audience)', () => join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: n, aud: 'someone-elses-app.apps.googleusercontent.com' }), nonce: n })],
        ['a token from another issuer', () => join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: n, iss: 'https://evil.example' }), nonce: n })],
        ['a token carrying a different nonce', () => join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: 'not-the-one' }), nonce: n })],
        ['a nonce this node never issued', () => join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: 'never-issued' }), nonce: 'never-issued' })],
    ];
    for (const [label, attempt] of bad) {
        const r = await attempt();
        assert(r.status === 401 && r.body?.code === 'sign_in', `${label} → 401 sign_in (got ${r.status} ${JSON.stringify(r.body)})`);
    }
    assert(!memberRow(ada.pk) && countJoins() === 0, 'none of them joined anybody or marked a sign-in account used');

    // The provider failing is not the member's sign-in failing. Google's keys are dropped from the cache and its
    // key endpoint answers 503, then an empty key set: both must be 503 sign_in_unavailable, not 401 sign_in.
    const realFetch = globalThis.fetch;
    const unavailableBefore = funnelCount('open_join_failed', 'sign_in_unavailable');
    const outages: Array<[string, () => Response]> = [
        ['Google\'s key endpoint answering 503', () => new Response('unavailable', { status: 503 })],
        ['Google\'s key endpoint answering with no usable keys', () => new Response(JSON.stringify({ keys: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ];
    for (const [label, answer] of outages) {
        _resetJwksCacheForTests('google', null);
        globalThis.fetch = (async (input: any, init?: any) =>
            String(input?.url ?? input).startsWith('https://www.googleapis.com/') ? answer() : realFetch(input, init)) as typeof fetch;
        try {
            const r = await join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: n }), nonce: n });
            assert(r.status === 503 && r.body?.code === 'sign_in_unavailable',
                `${label} → 503 sign_in_unavailable, not a refused sign-in (got ${r.status} ${JSON.stringify(r.body)})`);
        } finally {
            globalThis.fetch = realFetch;
        }
    }
    primeJwks();
    assert(funnelCount('open_join_failed', 'sign_in_unavailable') === unavailableBefore + outages.length,
        'the funnel counts them as open_join_failed:sign_in_unavailable');
    assert(!memberRow(ada.pk) && countJoins() === 0, '...and nobody joined (the nonce is still unspent: Ada joins with it in step 4)');

    const bea = newId();
    const beaNonce = await joinNonce(bea);
    const stolen = await join(ada, { callsign: 'Ada', provider: 'apple', idToken: mint('apple', { sub: 'bea.apple.sub', nonce: beaNonce }), nonce: beaNonce });
    assert(stolen.status === 401, `a token and nonce issued for another key cannot join this key (got ${stolen.status})`);
    assert(!memberRow(ada.pk) && !memberRow(bea.pk), '...and neither key joined');
    const beaJoin = await join(bea, { callsign: 'Bea', provider: 'apple', idToken: mint('apple', { sub: 'bea.apple.sub', nonce: beaNonce }), nonce: beaNonce });
    assert(beaJoin.status === 200 && memberRow(bea.pk)?.invited_by === 'open:apple',
        `the failed attempt did not burn it: the key it was issued to joins with it (got ${beaJoin.status})`);

    // ── 4. a good join ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a good join ──');
    const attemptsBefore = funnelCount('open_join_attempt', 'google');
    const createdBefore = funnelCount('member_created', '');
    const good = await join(ada, { callsign: '  Ada  ', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: n, email: GOOGLE_EMAIL }), nonce: n });
    assert(good.status === 200 && good.body?.success === true && good.body?.member?.publicKey === ada.pk && good.body?.provider === 'google',
        `a verified sign-in joins the signing key (got ${good.status} ${JSON.stringify(good.body)})`);
    const adaRow = memberRow(ada.pk);
    assert(adaRow?.callsign === 'Ada' && adaRow?.status === 'active', `the member exists, active, named "Ada" (got ${JSON.stringify(adaRow?.callsign)})`);
    assert(adaRow?.invited_by === 'open:google' && adaRow?.invite_code === null,
        `invited_by is open:google and there is no invite code (got ${adaRow?.invited_by}, ${adaRow?.invite_code})`);
    const adaJoin = joinRow(ada.pk);
    assert(adaJoin?.provider === 'google' && typeof adaJoin?.join_hash === 'string' && adaJoin.join_hash.length >= 40,
        'the open_joins row names the provider and holds a join hash');
    assert(!String(adaJoin.join_hash).includes(GOOGLE_SUB) && typeof adaJoin.ip_hash === 'string'
        && !/127\.0\.0\.1|::1|localhost/.test(adaJoin.ip_hash), 'the row holds hashes, not the sub or the address');
    const image = db.serialize();
    assert(!image.includes(Buffer.from(GOOGLE_SUB)) && !image.includes(Buffer.from(GOOGLE_EMAIL)),
        'neither the raw sub nor the email is anywhere in the database');
    assert(funnelCount('open_join_attempt', 'google') === attemptsBefore + 1, 'the funnel counts the attempt (open_join_attempt:google)');
    assert(funnelCount('member_created', '') === createdBefore + 1, 'the funnel\'s JOINED_HERE cohort counts the new member (member_created)');

    // ── 5. one sign-in account, one identity ─────────────────────────────────────────────────────
    console.log('\n── 5. one sign-in account, one identity ──');
    const cal = newId();
    const calNonce = await joinNonce(cal);
    const calToken = mint('google', { sub: GOOGLE_SUB, nonce: calNonce });
    const dup = await join(cal, { callsign: 'Cal', provider: 'google', idToken: calToken, nonce: calNonce });
    assert(dup.status === 409 && dup.body?.code === 'already_joined'
        && dup.body?.error === 'This Google account already has a BeanPool identity here. Restore it with your 12 words or your sign-in instead.',
        `the same Google account from another key → 409 with the restore hint (got ${dup.status} ${JSON.stringify(dup.body)})`);
    assert(!memberRow(cal.pk) && !joinRow(cal.pk), '...and that key did not join');
    const replay = await join(cal, { callsign: 'Cal', provider: 'google', idToken: calToken, nonce: calNonce });
    assert(replay.status === 401 && replay.body?.code === 'sign_in', `the same token and nonce again (a replay) → 401 (got ${replay.status})`);
    assert(funnelCount('open_join_failed', 'already_joined') >= 1, 'the funnel counts the refusal (open_join_failed:already_joined)');

    const again = await call(ada, '/api/join/sso-nonce', {});
    assert(again.status === 409 && again.body?.code === 'already_member', `a member asking for a join nonce → 409 already_member (got ${again.status})`);
    const againJoin = await join(ada, { callsign: 'Ada', provider: 'google', idToken: mint('google', { sub: 'other', nonce: 'x' }), nonce: 'x' });
    assert(againJoin.status === 409 && againJoin.body?.code === 'already_member', `a member joining again → 409 already_member (got ${againJoin.status})`);

    // A join nonce is not a recovery nonce. Dee takes two join nonces, joins with one, and tries the other on the
    // recovery deposit route as the member she now is.
    const dee = newId();
    const deeJoinNonce = await joinNonce(dee);
    const deeSpare = await joinNonce(dee);
    const DEE_SUB = '001234.deedeedeedeedeedeedeedeedeedee.0001';
    const deeJoin = await join(dee, { callsign: 'Ada', provider: 'apple', idToken: mint('apple', { sub: DEE_SUB, nonce: deeJoinNonce }), nonce: deeJoinNonce });
    assert(deeJoin.status === 200 && memberRow(dee.pk)?.callsign === 'Ada2',
        `a name already taken is made unique, as for an invite (got ${deeJoin.status}, ${memberRow(dee.pk)?.callsign})`);
    assert(memberRow(dee.pk)?.invited_by === 'open:apple', 'the Apple joiner is invited_by open:apple');
    const sealedDee = await sealSeedToSso(dee.seed, 'apple', DEE_SUB);
    const crossRoute = await call(dee, '/api/recovery/shares/sso', {
        provider: 'apple', idToken: mint('apple', { sub: DEE_SUB, nonce: deeSpare }), nonce: deeSpare,
        shares: [{ holderType: 'sso', holderRef: 'apple', shareIndex: 1, ...sealedDee }],
    });
    assert(crossRoute.status === 400 && /could not be matched/i.test(String(crossRoute.body?.error)),
        `a join nonce cannot be spent on the recovery deposit route (got ${crossRoute.status} ${JSON.stringify(crossRoute.body)})`);
    assert((db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(dee.pk) as any).n === 0,
        '...and nothing was stored');

    // ── 6. one sign-in, two jobs ─────────────────────────────────────────────────────────────────
    console.log('\n── 6. one sign-in, two jobs: join and recovery keeper ──');
    const eve = newId();
    const EVE_SUB = '001234.eveeveeveeveeveeveeveeveeveeve.0002';
    const eveNonce = await joinNonce(eve);
    const eveToken = mint('apple', { sub: EVE_SUB, nonce: eveNonce });
    const sealedEve = await sealSeedToSso(eve.seed, 'apple', EVE_SUB);
    const malformed = await join(eve, { callsign: 'Eve', provider: 'apple', idToken: eveToken, nonce: eveNonce, recovery: { shares: 'nope' } });
    assert(malformed.status === 400 && malformed.body?.code === 'recovery_invalid', `a malformed recovery body → 400 recovery_invalid (got ${malformed.status})`);
    const smuggled = await join(eve, {
        callsign: 'Eve', provider: 'apple', idToken: eveToken, nonce: eveNonce,
        recovery: { shares: [{ holderType: 'sso', holderRef: 'apple', shareIndex: 1, ...sealedEve, ssoLookupHash: 'chosen-by-client' }] },
    });
    assert(smuggled.status === 400 && smuggled.body?.code === 'recovery_invalid', `a client-chosen lookup hash → 400 (got ${smuggled.status})`);
    // A two-layer split is only whole with its hub fragment. Without one it would never be stored, so it is refused
    // here too, before the sign-in is checked: otherwise the join would spend the nonce and stand with no keeper.
    const twoLayerSso = await sealShareToSso(crypto.randomBytes(32), 'apple', EVE_SUB);
    const noHub = await join(eve, {
        callsign: 'Eve', provider: 'apple', idToken: eveToken, nonce: eveNonce,
        recovery: { shares: [{ holderType: 'sso', holderRef: 'apple', shareIndex: 1, ...twoLayerSso }] },
    });
    assert(noHub.status === 400 && noHub.body?.code === 'recovery_invalid' && /hub fragment/.test(String(noHub.body?.error)),
        `a two-layer split with no hub fragment → 400 recovery_invalid (got ${noHub.status} ${JSON.stringify(noHub.body)})`);
    assert(!memberRow(eve.pk) && !joinRow(eve.pk), '...and none of them joined');
    const both = await join(eve, {
        callsign: 'Eve', provider: 'apple', idToken: eveToken, nonce: eveNonce,
        recovery: { shares: [{ holderType: 'sso', holderRef: 'apple', shareIndex: 1, ...sealedEve }] },
    });
    assert(both.status === 200 && both.body?.success === true, `the nonce survived the refused bodies, and the join with a keeper succeeds (got ${both.status} ${JSON.stringify(both.body)})`);
    assert(both.body?.recovery?.enrolled === true && both.body.recovery.provider === 'apple' && both.body.recovery.threshold === 1
        && JSON.stringify(both.body.recovery.enrolledSso) === '["apple"]',
        `the answer reports the keeper as /api/recovery/shares/sso would (got ${JSON.stringify(both.body?.recovery)})`);
    const share = db.prepare("SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso'").get(eve.pk) as any;
    assert(!!share && share.holder_ref === 'apple' && share.sso_lookup_hash === await ssoLookupHash('apple', EVE_SUB, share.sso_lookup_salt),
        'the keeper is filed under the node\'s own lookup hash of the VERIFIED sub');
    const reopened = await openShareFromSso(
        { encryptedShare: share.encrypted_share, shareIv: share.share_iv, shareTag: share.share_tag, kdfParams: share.kdf_params },
        'apple', EVE_SUB,
    );
    assert(Buffer.from(reopened).equals(Buffer.from(eve.seed)), 'and the stored blob opens with that sub to the member\'s own seed');
    const twice = await call(eve, '/api/recovery/shares/sso', {
        provider: 'apple', idToken: eveToken, nonce: eveNonce, shares: [{ holderType: 'sso', holderRef: 'apple', shareIndex: 1, ...sealedEve }],
    });
    assert(twice.status === 400, `the one nonce is spent: it cannot enrol again on the recovery route (got ${twice.status})`);

    // ── 7. sign-ups per address ──────────────────────────────────────────────────────────────────
    console.log('\n── 7. sign-ups per address ──');
    const ipHash = joinRow(ada.pk).ip_hash as string;
    assert([bea, dee, eve].every(id => joinRow(id.pk).ip_hash === ipHash), 'joins from one address share one address hash');
    const insertFake = db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash) VALUES (?, ?, ?, ?, ?)');
    const fakes: string[] = [];
    const addFakes = (count: number, at: Date) => {
        for (let i = 0; i < count; i++) {
            const pk = crypto.randomBytes(32).toString('hex');
            fakes.push(pk);
            insertFake.run(pk, 'google', crypto.randomBytes(32).toString('base64url'), at.toISOString(), ipHash);
        }
    };
    const recentFromHere = () => (db.prepare('SELECT COUNT(*) AS n FROM open_joins WHERE ip_hash = ?').get(ipHash) as any).n as number;
    addFakes(OPEN_JOIN_LIMITS.perHour - recentFromHere(), new Date());
    const fay = newId();
    const fayNonce = await joinNonce(fay);
    const fayToken = mint('google', { sub: 'fay-google-sub', nonce: fayNonce });
    const hourly = await join(fay, { callsign: 'Fay', provider: 'google', idToken: fayToken, nonce: fayNonce });
    assert(hourly.status === 429 && hourly.body?.code === 'rate_limited' && /last hour/.test(String(hourly.body?.error)),
        `one join over ${OPEN_JOIN_LIMITS.perHour} from one address in an hour → 429 (got ${hourly.status} ${JSON.stringify(hourly.body)})`);
    assert(!memberRow(fay.pk), '...and did not join');

    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    db.prepare('UPDATE open_joins SET joined_at = ? WHERE ip_hash = ?').run(twoHoursAgo, ipHash);
    addFakes(OPEN_JOIN_LIMITS.perDay - recentFromHere(), new Date(Date.now() - 3 * 3600_000));
    const daily = await join(fay, { callsign: 'Fay', provider: 'google', idToken: fayToken, nonce: fayNonce });
    assert(daily.status === 429 && /today/.test(String(daily.body?.error)),
        `one join over ${OPEN_JOIN_LIMITS.perDay} from one address in a day → 429 (got ${daily.status} ${JSON.stringify(daily.body)})`);

    const dayAndAHourAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
    db.prepare('UPDATE open_joins SET joined_at = ? WHERE ip_hash = ?').run(dayAndAHourAgo, ipHash);
    const fayJoins = await join(fay, { callsign: 'Fay', provider: 'google', idToken: fayToken, nonce: fayNonce });
    assert(fayJoins.status === 200, `a refused-for-limits join kept its nonce: the same sign-in joins once the windows pass (got ${fayJoins.status})`);
    const stale = (db.prepare('SELECT COUNT(*) AS n FROM open_joins WHERE joined_at = ? AND ip_hash IS NOT NULL').get(dayAndAHourAgo) as any).n;
    assert(stale === 0 && joinRow(ada.pk).ip_hash === null, 'address hashes older than a day are cleared');
    assert(typeof joinRow(fay.pk).ip_hash === 'string', 'while the newest join still has its own');
    const delFake = db.prepare('DELETE FROM open_joins WHERE member_pubkey = ?');
    for (const pk of fakes) delFake.run(pk);

    // ...and on a timer, not only when somebody joins: a node nobody joins for a day must not keep them either.
    // The server started the timer; restarted here with a short period, then put back.
    const quietPk = crypto.randomBytes(32).toString('hex');
    insertFake.run(quietPk, 'google', crypto.randomBytes(32).toString('base64url'), dayAndAHourAgo, ipHash);
    startForgettingJoinAddresses(50);
    await new Promise(resolve => setTimeout(resolve, 300));
    startForgettingJoinAddresses();
    assert(joinRow(quietPk)?.ip_hash === null, 'with nobody joining, the timer clears an address once it is a day old');
    assert(typeof joinRow(fay.pk).ip_hash === 'string', '...and leaves a newer one alone');
    delFake.run(quietPk);

    freshLimiters();
    holdLimiters = true;
    const probe = newId();
    let limited = 0;
    for (let i = 0; i < 16; i++) if ((await call(probe, '/api/join/sso-nonce', {})).status === 429) limited++;
    assert(limited === 1, `the auth limiter (15 a minute per address) still covers the door (${limited} of 16 refused)`);
    holdLimiters = false;

    // ── 8. purge and prune ───────────────────────────────────────────────────────────────────────
    console.log('\n── 8. deleting your account frees the sign-in; a removal does not ──');
    const purged = await call(ada, '/api/member/purge', {});
    assert(purged.status === 200 && memberRow(ada.pk)?.status === 'pruned', `Ada deletes her own account (got ${purged.status})`);
    assert(!joinRow(ada.pk), 'her open_joins row goes with it');
    const gus = newId();
    const gusNonce = await joinNonce(gus);
    const gusJoin = await join(gus, { callsign: 'Gus', provider: 'google', idToken: mint('google', { sub: GOOGLE_SUB, nonce: gusNonce }), nonce: gusNonce });
    assert(gusJoin.status === 200 && joinRow(gus.pk)?.provider === 'google', `the same Google account can join again, as a new identity (got ${gusJoin.status})`);

    adminPruneUser(dee.pk, 'owner:password');
    assert(memberRow(dee.pk)?.status === 'pruned' && !!joinRow(dee.pk), 'a member the community removes keeps their open_joins row');
    const hal = newId();
    const halNonce = await joinNonce(hal);
    const halJoin = await join(hal, { callsign: 'Hal', provider: 'apple', idToken: mint('apple', { sub: DEE_SUB, nonce: halNonce }), nonce: halNonce });
    assert(halJoin.status === 403 && halJoin.body?.code === 'removed' && /removed from this community/.test(String(halJoin.body?.error)),
        `so that Apple account cannot come straight back in (got ${halJoin.status} ${JSON.stringify(halJoin.body)})`);
    assert(!memberRow(hal.pk), '...and did not join');

    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(bea.pk);
    const beaPurge = await call(bea, '/api/member/purge', {});
    assert(beaPurge.status === 200 && memberRow(bea.pk)?.status === 'pruned', `a suspended member deletes their own account (got ${beaPurge.status})`);
    assert(!!joinRow(bea.pk), '...and their open_joins row stays: deleting the account is not a way out of the suspension');
    const jon = newId();
    const jonNonce = await joinNonce(jon);
    const jonJoin = await join(jon, { callsign: 'Jon', provider: 'apple', idToken: mint('apple', { sub: 'bea.apple.sub', nonce: jonNonce }), nonce: jonNonce });
    assert(jonJoin.status === 403 && jonJoin.body?.code === 'removed', `so that Apple account cannot rejoin fresh either (got ${jonJoin.status})`);

    // ── 9. the door follows the profile ──────────────────────────────────────────────────────────
    console.log('\n── 9. the door follows the profile, per request ──');
    delete process.env.NODE_PROFILE;
    const ivy = newId();
    assert((await call(ivy, '/api/join/sso-nonce', {})).status === 404, 'back to local: the nonce route is 404 again');
    assert((await join(ivy, { callsign: 'Ivy', provider: 'google', idToken: 'x', nonce: 'x' })).status === 404, 'back to local: the join route is 404 again');
    assert((await info()).features?.openJoin === false, 'and /api/community/info says openJoin false');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The open door: signed, one sign-in account per identity, limited per address, shut on local nodes.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
