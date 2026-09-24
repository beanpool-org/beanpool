/**
 * A sign-in provider that cannot be asked is "try again" (503 sign_in_unavailable), not "your sign-in did not check
 * out" (400), on the keeper deposit and on the recovering device's sign-in. Over REAL HTTPS through the real
 * signature middleware.
 *
 * No provider is contacted. `fetch` is stubbed for the whole run: requests to this test's own server go through,
 * Google's key endpoint is answered by the outage under test (between outages its keys are primed into sso.ts's
 * cache, so it is not asked at all), GitHub's device-code endpoint is answered by an outage, `exp.host` (push) is
 * recorded, and anything else is recorded and refused.
 *
 *   1. POST /api/recovery/shares/sso, the member's keeper deposit: Google's key endpoint answering 503, answering
 *      with no usable keys, answering something that is not JSON, or unreachable → 503 sign_in_unavailable, and
 *      nothing stored. A forged token → 400 { error } as before, and a split refused before the sign-in → 400 as
 *      before. The same token and nonce then succeed, so "try again" is true: no outage spent the nonce.
 *   2. POST /api/recovery/collect/sso, the recovering device: the same four outages → 503 sign_in_unavailable, and
 *      nothing released. A forged token → 400 { error } as before. The same token and nonce then release the
 *      fragment. The session's other refusals (asking for a hub a single-blob keeper does not have) still answer 400.
 *   3. The GitHub start routes, the member's and the recovering device's: GitHub answering 5xx, or unreachable →
 *      503 sign_in_unavailable. The deposit and collect routes never ask GitHub themselves: they spend a sign-in
 *      this node already finished (consumeGithubSession), so a GitHub outage can only surface at start and poll.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sso-unavailable.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.GITHUB_CLIENT_IDS;
delete process.env.GITHUB_CLIENT_ID;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { countCurrentShares } from './engine/recovery-shares.js';
import { listReleases } from './engine/recovery-release.js';
import { _clearGithubSessionsForTests } from './engine/github-device.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { pruneGithubPolls } from './github-poll-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { sealSeedToSso } from '@beanpool/core';

const PORT = 8745;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── the providers ────────────────────────────────────────────────────────────────────────────────
const GOOGLE_KID = 'test-sso-unavailable-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const impostor = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any;

function primeGoogle(): void {
    _resetJwksCacheForTests('google', { keys: [googleJwk], expiresAt: Date.now() + 3600_000 });
}

function mint(sub: string, nonce: string, signer: crypto.KeyObject = google.privateKey): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({
        iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub,
        email: 'someone@example.com', email_verified: true, iat: now, exp: now + 3600, nonce,
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), signer).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** How Google's key endpoint answers when the verifier has to ask it. */
type KeyOutage = '503' | 'no-keys' | 'not-json' | 'unreachable';
const KEY_OUTAGES: Array<[KeyOutage, string]> = [
    ['503', 'Google\'s key endpoint answering 503'],
    ['no-keys', 'Google\'s key endpoint answering with no usable keys'],
    ['not-json', 'Google\'s key endpoint answering something that is not JSON'],
    ['unreachable', 'Google\'s key endpoint unreachable'],
];
let googleKeys: KeyOutage = '503';
/** How GitHub answers: every GitHub request in this suite meets an outage. */
let githubDown: '5xx' | 'unreachable' = '5xx';

const realFetch = globalThis.fetch;
/** Every request that left for somewhere other than this test's own server. */
const outbound: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith(BASE)) return realFetch(input, init);
    outbound.push(url);
    if (url.startsWith('https://exp.host/')) return json({ data: [] });
    if (url.startsWith('https://www.googleapis.com/')) {
        if (googleKeys === 'unreachable') throw new TypeError('fetch failed');
        if (googleKeys === 'no-keys') return json({ keys: [] });
        if (googleKeys === 'not-json') return new Response('<html>Service Unavailable</html>', { status: 200 });
        return new Response('unavailable', { status: 503 });
    }
    if (url.startsWith('https://github.com/') || url.startsWith('https://api.github.com/')) {
        if (githubDown === 'unreachable') throw new TypeError('fetch failed');
        return new Response('unavailable', { status: 502 });
    }
    return new Response('stubbed: test-sso-unavailable contacts nobody', { status: 503 });
}) as typeof fetch;

// ── callers ──────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; seed: Uint8Array }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const seed = new Uint8Array((privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32));
    return { pk, priv: privateKey, seed };
}

function newMember(): Id & { callsign: string } {
    const id = newId();
    const callsign = `ssou-${id.pk.slice(0, 8)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(id.pk, callsign);
    return { ...id, callsign };
}

async function call(id: Id, path: string, body: unknown): Promise<{ status: number; body: any; raw: string }> {
    // Fresh limiter windows, so the suite's own request count never decides a result it isn't testing.
    pruneAuthAttempts(Date.now() + 120_000);
    pruneGithubPolls(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, raw: text };
}

const unavailable = (r: { status: number; body: any }) =>
    r.status === 503 && r.body?.code === 'sign_in_unavailable' && typeof r.body?.error === 'string' && r.body.error.length > 0;
/** A refusal answered exactly as before this change: 400 and an `error`, nothing else. */
const refusedAsBefore = (r: { status: number; body: any }) =>
    r.status === 400 && typeof r.body?.error === 'string' && JSON.stringify(Object.keys(r.body)) === '["error"]';

/** Run `attempt` once per key outage, with Google's keys dropped from the cache, then prime them again. */
async function eachKeyOutage(attempt: () => Promise<{ status: number; body: any; raw: string }>, then: (label: string, r: { status: number; body: any; raw: string }) => void): Promise<void> {
    for (const [outage, label] of KEY_OUTAGES) {
        googleKeys = outage;
        _resetJwksCacheForTests('google', null);
        const asked = outbound.length;
        const r = await attempt();
        assert(outbound.length > asked, `${label}: the node did ask Google's key endpoint (the outage is real, not a cached key)`);
        then(label, r);
    }
    primeGoogle();
}

async function main(): Promise<void> {
    console.log('\n=== A sign-in provider outage answers 503 try again, over real HTTPS ===\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);
    _resetJwksCacheForTests();
    _clearNoncesForTests();
    _clearGithubSessionsForTests();
    primeGoogle();

    // ── 1. the keeper deposit ────────────────────────────────────────────────────────────────────
    console.log('── 1. POST /api/recovery/shares/sso ──');
    const ada = newMember();
    const ADA_SUB = '110169484474386200001';
    const sealed = await sealSeedToSso(ada.seed, 'google', ADA_SUB);
    const shares = [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed }];

    const nonceRes = await call(ada, '/api/recovery/sso-nonce', {});
    assert(nonceRes.status === 200 && typeof nonceRes.body?.nonce === 'string', `Ada gets a sign-in nonce (got ${nonceRes.status})`);
    const nonce = nonceRes.body.nonce as string;
    const token = mint(ADA_SUB, nonce);
    const deposit = (body: Record<string, unknown>) => call(ada, '/api/recovery/shares/sso', { provider: 'google', shares, ...body });

    await eachKeyOutage(() => deposit({ idToken: token, nonce }), (label, r) => {
        assert(unavailable(r), `${label} → 503 sign_in_unavailable, not a refused sign-in (got ${r.status} ${r.raw})`);
    });
    assert(countCurrentShares(ada.pk) === 0, '...and none of them stored anything');

    const forged = await deposit({ idToken: mint(ADA_SUB, nonce, impostor.privateKey), nonce });
    assert(refusedAsBefore(forged), `a forged token (right kid, wrong key) → 400 { error }, as before (got ${forged.status} ${forged.raw})`);
    const clientHash = await deposit({ idToken: token, nonce, shares: shares.map(s => ({ ...s, ssoLookupHash: 'chosen-by-the-client' })) });
    assert(refusedAsBefore(clientHash), `a split refused before the sign-in → 400 { error }, as before (got ${clientHash.status} ${clientHash.raw})`);
    assert(countCurrentShares(ada.pk) === 0, '...and neither stored anything');

    const good = await deposit({ idToken: token, nonce });
    assert(good.status === 200 && good.body?.provider === 'google',
        `the same token and nonce succeed once Google answers: no outage spent the nonce (got ${good.status} ${good.raw})`);
    assert(countCurrentShares(ada.pk) === 1, '...and the sign-in keeper is stored');

    // ── 2. the recovering device ─────────────────────────────────────────────────────────────────
    console.log('\n── 2. POST /api/recovery/collect/sso ──');
    const device = newId();
    const opened = await call(device, '/api/recovery/collect', { callsign: ada.callsign });
    assert(opened.status === 200 && typeof opened.body?.collectionId === 'string', `a device opens a recovery for Ada (got ${opened.status} ${opened.raw})`);
    const cid = opened.body.collectionId as string;
    const collectNonceRes = await call(device, '/api/recovery/collect/sso-nonce', { collectionId: cid });
    assert(collectNonceRes.status === 200 && typeof collectNonceRes.body?.nonce === 'string', `...and gets a nonce bound to its key (got ${collectNonceRes.status})`);
    const collectNonce = collectNonceRes.body.nonce as string;
    const collectToken = mint(ADA_SUB, collectNonce);
    const collect = (idToken: string) => call(device, '/api/recovery/collect/sso', { collectionId: cid, provider: 'google', idToken, nonce: collectNonce });

    await eachKeyOutage(() => collect(collectToken), (label, r) => {
        assert(unavailable(r), `${label} → 503 sign_in_unavailable, not a refused sign-in (got ${r.status} ${r.raw})`);
    });
    assert(listReleases(cid).length === 0, '...and none of them released anything');

    const forgedCollect = await collect(mint(ADA_SUB, collectNonce, impostor.privateKey));
    assert(refusedAsBefore(forgedCollect), `a forged token → 400 { error }, as before (got ${forgedCollect.status} ${forgedCollect.raw})`);
    assert(listReleases(cid).length === 0, '...and it released nothing');

    const recovered = await collect(collectToken);
    assert(recovered.status === 200 && listReleases(cid).length === 1,
        `the same token and nonce release the fragment once Google answers: no outage spent the nonce (got ${recovered.status} ${recovered.raw})`);

    const otherDevice = newId();
    const coldOpen = await call(otherDevice, '/api/recovery/collect', { callsign: ada.callsign });
    const coldHub = await call(otherDevice, '/api/recovery/collect/hub', { collectionId: coldOpen.body?.collectionId });
    assert(refusedAsBefore(coldHub), `the session's own refusals are unchanged: a hub this account does not have → 400 { error } (got ${coldHub.status} ${coldHub.raw})`);

    // ── 3. GitHub, where it is asked ─────────────────────────────────────────────────────────────
    console.log('\n── 3. the GitHub start routes ──');
    const bea = newMember();
    const beaDevice = newId();
    const beaOpened = await call(beaDevice, '/api/recovery/collect', { callsign: ada.callsign });
    const starts: Array<[string, () => Promise<{ status: number; body: any; raw: string }>]> = [
        ['a member\'s GitHub start', () => call(bea, '/api/recovery/sso/github/start', {})],
        ['a recovering device\'s GitHub start', () => call(beaDevice, '/api/recovery/collect/github/start', { collectionId: beaOpened.body?.collectionId })],
    ];
    for (const [label, start] of starts) {
        for (const down of ['5xx', 'unreachable'] as const) {
            githubDown = down;
            const r = await start();
            assert(unavailable(r), `${label} with GitHub ${down === '5xx' ? 'answering 502' : 'unreachable'} → 503 sign_in_unavailable (got ${r.status} ${r.raw})`);
        }
    }

    const strays = outbound.filter(u => !/^https:\/\/(www\.googleapis\.com|github\.com|api\.github\.com|exp\.host)\//.test(u));
    assert(strays.length === 0, `nothing else was contacted (${strays.join(', ') || 'none'})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Sign-in provider outage checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
