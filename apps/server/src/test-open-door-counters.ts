/**
 * The open door's counters on the operator's Onboarding screen (routes/admin.ts GET/POST /api/local/admin/onboarding-funnel,
 * engine/funnel.ts). Over REAL HTTPS through the real signature middleware, with real joins through POST /api/join; no
 * provider is contacted (test keys primed into sso.ts's cache, as test-open-join does).
 *
 *   1. a local community: `openDoor: false`, no open-door rows; a member who joined with an invite is in `member_created`
 *      and not in `cohort_open_door`
 *   2. the global profile, real joins: two with Google, one with Apple; a Google account that already has an identity
 *      here (409) and a forged token (401). The route then says `openDoor: true` and counts, for today: the attempts
 *      per provider (`open_join_attempt`, 5), the people who came in through the door per provider (`cohort_open_door`,
 *      a subset of `member_created`: 3 of 6), and each refusal by its reason (`open_join_failed`)
 *   3. who may read them: unsigned, a wrong password and a member's signature 401, a moderator's session 403, none of
 *      them with a count; an admin's session and the owner's password 200; POST with `{ days }` answers the same
 *   4. back to the local profile: `openDoor: false`, and the joins that happened are still counted
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-door-counters.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.FACEBOOK_CLIENT_IDS;
delete process.env.APPLE_SERVICES_ID;

import crypto from 'node:crypto';
import https from 'node:https';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole } from './state-engine.js';
import { db } from './db/db.js';
import { updateLocalConfig, hashPassword } from './config/local-config.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const show = (v: unknown) => JSON.stringify(v);
let PORT = 0;
const ROUTE = '/api/local/admin/onboarding-funnel';

// ── provider fixtures (as test-open-join) ───────────────────────────────────────────────────────
const GOOGLE_KID = 'test-open-door-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const APPLE_KID = 'test-open-door-apple';
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
function mint(provider: Provider, sub: string, nonce: string, signer?: crypto.KeyObject): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: provider === 'google' ? GOOGLE_KID : APPLE_KID, typ: 'JWT' });
    const payload = b64({
        iss: provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com',
        aud: provider === 'google' ? GOOGLE_AUD : APPLE_AUD,
        sub, email_verified: true, iat: now, exp: now + 3600, nonce,
    });
    const key = signer ?? (provider === 'google' ? google.privateKey : apple.privateKey);
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

// ── people and requests ─────────────────────────────────────────────────────────────────────────
interface Key { pk: string; privateKey: crypto.KeyObject }
function makeKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { privateKey, pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex') };
}
function addMember(pk: string, callsign: string, invitedBy: string): void {
    db.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)')
        .run(pk, callsign, new Date().toISOString(), invitedBy, 'TEST');
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
}
function keySession(k: Key): string | undefined {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), k.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: k.pk, signature });
    if (!solved.ok) return undefined;
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    return ex.ok ? ex.sessionId : undefined;
}
function signed(k: Key, method: string, urlPath: string, raw = ''): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': k.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), k.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

interface Answer { status: number; body: string; json: any }
function send(method: string, urlPath: string, headers: Record<string, string>, raw?: string): Promise<Answer> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    return new Promise((resolve, reject) => {
        const req = https.request({ host: 'localhost', port: PORT, path: urlPath, method, headers, rejectUnauthorized: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let json: any;
                try { json = JSON.parse(body); } catch { json = undefined; }
                resolve({ status: res.statusCode ?? 0, body, json });
            });
        });
        req.on('error', reject);
        if (raw !== undefined) req.write(raw);
        req.end();
    });
}
function post(k: Key, urlPath: string, body: unknown): Promise<Answer> {
    const raw = JSON.stringify(body);
    return send('POST', urlPath, { 'Content-Type': 'application/json', ...signed(k, 'POST', urlPath, raw) }, raw);
}

async function joinWith(provider: Provider, sub: string, callsign: string, forged = false): Promise<Answer> {
    const k = makeKey();
    const n = await post(k, '/api/join/sso-nonce', {});
    if (n.status !== 200 || typeof n.json?.nonce !== 'string') throw new Error(`no join nonce: ${n.status} ${n.body}`);
    return post(k, '/api/join', { callsign, provider, idToken: mint(provider, sub, n.json.nonce, forged ? impostor.privateKey : undefined), nonce: n.json.nonce });
}

/** Today's total of one event per variant, from a funnel answer. */
function counts(rows: Array<{ day: string; event: string; variant: string; count: number }>, event: string): Record<string, number> {
    const today = new Date().toISOString().slice(0, 10);
    const out: Record<string, number> = {};
    for (const r of rows) if (r.event === event && r.day === today) out[r.variant] = (out[r.variant] ?? 0) + r.count;
    return out;
}
const total = (c: Record<string, number>) => Object.values(c).reduce((n, v) => n + v, 0);
const same = (a: Record<string, number>, b: Record<string, number>) =>
    show(Object.entries(a).sort()) === show(Object.entries(b).sort());

async function main(): Promise<void> {
    console.log('\n=== The open door\'s counters on the Onboarding screen ===\n');
    await initTls();
    initStateEngine();
    const PW = 'OpenDoor-Counters-Owner-7!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false });
    const olive = makeKey(), adam = makeKey(), mo = makeKey(), mem = makeKey();
    seedGenesisMember(olive.pk, 'Olive');
    addMember(adam.pk, 'Adam', olive.pk);
    addMember(mo.pk, 'Mo', olive.pk);
    addMember(mem.pk, 'Mem', olive.pk);
    grantNodeRole(adam.pk, 'admin', 'owner:password');
    grantNodeRole(mo.pk, 'moderator', 'owner:password');
    const { startHttpsServer } = await import('./https-server.js');
    PORT = await startHttpsServer(0);
    primeJwks();
    _clearNoncesForTests();
    // Step 7c: the password alone opens no admin route with 2FA off; the owner reads with an automation token made from
    // Olive's key (the genesis member, the owner), as an owner makes one from the phone.
    const asOwner = ownerTokenHeaders('admin', olive.pk);
    const owner = () => { resetAdminAuthTarpit(); return send('GET', ROUTE, asOwner); };

    // ── 1. a local community ─────────────────────────────────────────────────────────────────────
    console.log('── 1. a local community: the door is shut ──');
    let r = await owner();
    assert(r.status === 200 && r.json?.openDoor === false, `local: openDoor false (got ${r.status} ${show(r.json?.openDoor)})`);
    // The three invited here, and the node's own treasury row, which `member_created` counts too (funnel.ts JOINED_HERE
    // has no is_treasury clause; reported on the PR, not changed here).
    const base = total(counts(r.json.rows, 'member_created'));
    assert(base >= 3, `the three members invited here joined today (got ${base})`);
    assert(total(counts(r.json.rows, 'cohort_open_door')) === 0 && total(counts(r.json.rows, 'open_join_attempt')) === 0,
        'none of them came through the open door, and nobody tried it');

    // ── 2. the global profile, real joins ────────────────────────────────────────────────────────
    console.log('\n── 2. the global profile: real joins through the door ──');
    process.env.NODE_PROFILE = 'global';
    const ada = await joinWith('google', 'google-sub-ada', 'Ada');
    const bea = await joinWith('apple', 'apple-sub-bea', 'Bea');
    const cy = await joinWith('google', 'google-sub-cy', 'Cy');
    assert(ada.status === 200 && bea.status === 200 && cy.status === 200, `three people join: two with Google, one with Apple (got ${ada.status}, ${bea.status}, ${cy.status})`);
    const again = await joinWith('google', 'google-sub-ada', 'Dan');
    assert(again.status === 409 && again.json?.code === 'already_joined', `a Google account that already has an identity here: 409 already_joined (got ${again.status} ${again.json?.code})`);
    const forged = await joinWith('google', 'google-sub-eve', 'Eve', true);
    assert(forged.status === 401 && forged.json?.code === 'sign_in', `a forged token: 401 sign_in (got ${forged.status} ${forged.json?.code})`);

    r = await owner();
    assert(r.status === 200 && r.json?.openDoor === true, `global: openDoor true (got ${r.status} ${show(r.json?.openDoor)})`);
    const attempts = counts(r.json.rows, 'open_join_attempt');
    assert(same(attempts, { google: 4, apple: 1 }), `attempts per provider: Google 4, Apple 1 (got ${show(attempts)})`);
    const through = counts(r.json.rows, 'cohort_open_door');
    assert(same(through, { google: 2, apple: 1 }), `came in through the door, per provider: Google 2, Apple 1 (got ${show(through)})`);
    const joined = total(counts(r.json.rows, 'member_created'));
    assert(joined === base + 3 && total(through) <= joined, `they are part of everyone who joined today: 3 more joined (${base} → ${joined})`);
    const refused = counts(r.json.rows, 'open_join_failed');
    assert(same(refused, { already_joined: 1, sign_in: 1 }), `refusals by reason: already_joined 1, sign_in 1 (got ${show(refused)})`);
    const fromTable = (db.prepare("SELECT COUNT(*) AS n FROM members WHERE invited_by LIKE 'open:%'").get() as { n: number }).n;
    assert(fromTable === 3, `the members table agrees: 3 rows invited_by open:<provider> (got ${fromTable})`);
    const keys = [olive, adam, mo, mem].map((k) => k.pk);
    assert(!keys.some((pk) => r.body.includes(pk)) && !/google-sub|apple-sub/.test(r.body), 'the answer holds counts only: no key, no sign-in account');

    // ── 3. who may read them ─────────────────────────────────────────────────────────────────────
    console.log('\n── 3. owners and admins only ──');
    resetAdminAuthTarpit();
    r = await send('GET', ROUTE, {});
    assert(r.status === 401 && !r.body.includes('open_join'), `unsigned: 401, no counts (got ${r.status})`);
    r = await send('GET', ROUTE, { 'X-Admin-Password': 'not-the-password' });
    assert(r.status === 401 && !r.body.includes('open_join'), `a wrong password: 401, no counts (got ${r.status})`);
    resetAdminAuthTarpit();
    r = await send('GET', ROUTE, signed(mem, 'GET', ROUTE));
    assert(r.status === 401 && !r.body.includes('open_join'), `a member's signature: 401, no counts (got ${r.status})`);
    const moSid = keySession(mo);
    assert(!!moSid, 'a moderator signs in with their key');
    r = await send('GET', ROUTE, { 'X-Admin-Session': moSid! });
    assert(r.status === 403 && !r.body.includes('open_join') && !r.body.includes('openDoor'), `a moderator's session: 403, no counts (got ${r.status})`);
    const adminSid = keySession(adam);
    r = await send('GET', ROUTE, { 'X-Admin-Session': adminSid! });
    assert(r.status === 200 && r.json?.openDoor === true && same(counts(r.json.rows, 'cohort_open_door'), { google: 2, apple: 1 }),
        `an admin's session: 200, the same counts (got ${r.status})`);
    resetAdminAuthTarpit();
    const raw = JSON.stringify({ days: 7 });
    r = await send('POST', ROUTE, { ...asOwner, 'Content-Type': 'application/json' }, raw);
    assert(r.status === 200 && r.json?.days === 7 && r.json?.openDoor === true && same(counts(r.json.rows, 'open_join_attempt'), { google: 4, apple: 1 }),
        `POST { days: 7 }: 7 days, openDoor, the same counts (got ${r.status} ${r.json?.days})`);

    // ── 4. back to local ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. back to the local profile ──');
    delete process.env.NODE_PROFILE;
    r = await owner();
    assert(r.status === 200 && r.json?.openDoor === false, `local again: openDoor false (got ${show(r.json?.openDoor)})`);
    assert(same(counts(r.json.rows, 'cohort_open_door'), { google: 2, apple: 1 }) && same(counts(r.json.rows, 'open_join_attempt'), { google: 4, apple: 1 }),
        'the joins that happened are still counted');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
