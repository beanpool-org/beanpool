/**
 * Invites switched off: the `invites` profile switch (config/node-profile.ts), off on the global profile. Marty on the
 * board (2026-10-01): "Off on global". An invite needs no sign-in, so on global one sign-in account minting 20 a day
 * grew into hundreds of accounts no sign-in stood behind (scratch/reviews/FABLE-sec-global-abuse.md, HIGH-1). There the
 * open door is the only way in.
 *
 * Over REAL HTTPS, through the signature middleware and the feature gate, with signed requests. No provider is
 * contacted: the Google keys are a test key primed into sso.ts's cache, as in test-open-join.
 *
 *   1. A fresh global node, and how its owner is made. /api/community/info says `invites: false`. The admin's seed
 *      invite on the empty node, with the password, is 404 feature_off and writes nothing (no "Admin" genesis member,
 *      no code, no role). Marty joins through the door with a sign-in, the password makes him owner, and his own key
 *      opens Settings as owner. As owner he makes no invite either: not the seed invite (key session or password), not
 *      a member's.
 *   2. Members and node roles alike: a member's generate and an admin's are 404 and write nothing. A code already in
 *      the database (a member's, and a seed invite's) and an offline ticket a member signed join nobody: 404, no member
 *      row, the code still unused, the funnel untouched. The pre-flight is 404. Reads still answer: a member's own
 *      invites and the tree. Knocks are off with invites, even with their own switch on, and say how to join instead.
 *      Underneath the routes the engine refuses each one: generate, the seed invite, both redeems, a knock's answer.
 *      The open door still lets the next person in.
 *   3. The operator's override `nodeProfile.invites=true` turns them back on: a member's code joins someone. Off again,
 *      that new code is refused like the rest.
 *   4. A local community (NODE_PROFILE unset): unchanged. info says `invites: true`; a member's code, an offline ticket,
 *      the pre-flight and the seed invite all work. A member of the global node knocks here and a member here answers:
 *      the invite minted HERE lets them in here. The operator's override `nodeProfile.invites=false` turns invites and
 *      knocks off on a local community too.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-invites-off.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.FACEBOOK_CLIENT_IDS;
delete process.env.APPLE_SERVICES_ID;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, generateInvite, adminGenerateInvite, redeemInvite, redeemOfflineTicket } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { FeatureOffError, NODE_PROFILE_KEY } from './config/node-profile.js';
import { approveKnock } from './engine/knocks.js';
import { getFunnel } from './engine/funnel.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';
const ADMIN_PW = 'Invites-Off-Admin-Pw-71!';
const PASSWORD = { 'X-Admin-Password': ADMIN_PW };

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── the sign-in provider (test-open-join's fixtures) ─────────────────────────────────────────────
const GOOGLE_KID = 'test-invites-off-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function primeJwks(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', {
        keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any],
        expiresAt: Date.now() + 3600_000,
    });
}

function googleToken(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

// ── identities and calls ─────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }

/** A request through the real stack, signed by `id` when given. Fresh limiter windows, so the suite's own count never decides a result. */
async function call(id: Id | null, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = { ...headers };
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${r.text.slice(0, 160)}`;
const info = async () => (await call(null, 'GET', '/api/community/info')).body;

/** Joins through the open door with a fresh Google account: the only way into the global node. */
async function joinThroughDoor(id: Id, sub: string): Promise<Res> {
    const n = await call(id, 'POST', '/api/join/sso-nonce', {});
    if (n.status !== 200 || typeof n.body?.nonce !== 'string') return n;
    return call(id, 'POST', '/api/join', { callsign: id.name, provider: 'google', idToken: googleToken(sub, n.body.nonce), nonce: n.body.nonce });
}

const generate = (id: Id) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const redeemTicket = (id: Id, ticketB64: string) => call(id, 'POST', '/api/invite/redeem-offline', { ticketB64, publicKey: id.pk, callsign: id.name });

/** A paper invite: an offline ticket `inviter` signed on their phone, which the node first sees when someone joins with it. */
function offlineTicket(inviter: Id): string {
    const payload = JSON.stringify({ i: inviter.pk, t: Date.now() });
    return Buffer.from(JSON.stringify({ p: payload, s: crypto.sign(null, Buffer.from(payload), inviter.priv).toString('base64') })).toString('base64');
}

/** The owner's own key opening Settings, as the app's Manage button does: challenge, signature, session. */
async function keySession(id: Id): Promise<{ session: string | null; role: unknown; why: string }> {
    const chal = await call(null, 'POST', '/api/local/admin/auth/challenge', {});
    const signature = crypto.sign(null, Buffer.from(String(chal.body?.challenge), 'utf-8'), id.priv).toString('hex');
    const verified = await call(null, 'POST', '/api/local/admin/auth/verify-challenge', { challengeId: chal.body?.challengeId, memberPubkey: id.pk, signature });
    if (verified.status !== 200) return { session: null, role: null, why: show(verified) };
    const ex = await call(null, 'POST', '/api/local/admin/auth/exchange', { token: verified.body?.handshakeToken });
    return { session: ex.body?.sessionId ?? null, role: verified.body?.role ?? ex.body?.role, why: show(ex) };
}

// ── the database ─────────────────────────────────────────────────────────────────────────────────
const memberRow = (pk: string) => db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk) as any;
const codeRow = (code: string) => db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as any;
const codeCount = () => (db.prepare('SELECT COUNT(*) AS n FROM invite_codes').get() as { n: number }).n;
const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as { role: string } | undefined)?.role ?? null;
const setOverride = (name: string, value: 'true' | 'false') =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const clearOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);
const funnelAttempts = () => getFunnel(1).filter(r => r.event === 'invite_attempt').reduce((n, r) => n + r.count, 0);
/** A code put straight into the database, as one made before the switch went off would be. */
function plantCode(code: string, createdBy: string, genesisType: string = 'standard'): void {
    db.prepare("INSERT INTO invite_codes (code, created_by, created_at, genesis_type) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)")
        .run(code, createdBy, genesisType);
}

/** 404 feature_off for invites, in the words that say what to do instead. */
const invitesOff = (r: Res) => r.status === 404 && r.body?.code === 'feature_off' && r.body?.feature === 'invites'
    && /doesn’t use invites/.test(r.body?.error ?? '');
const engineRefuses = (fn: () => unknown): boolean => {
    try { fn(); return false; } catch (e) { return e instanceof FeatureOffError && e.feature === 'invites'; }
};

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    primeJwks();
    _clearNoncesForTests();

    // ── 1. a fresh global node, and how its owner is made ─────────────────────────────────────────
    console.log('── 1. a fresh global node: no invites, and the owner comes in through the door ──');
    const fresh = await info();
    assert(fresh?.profile === 'global' && fresh?.features?.invites === false && fresh?.features?.openJoin === true && fresh?.features?.knocks === false,
        `/api/community/info on the global profile: invites false, the open door open, no knocks (got ${JSON.stringify(fresh?.features)})`);
    // The rows a fresh node starts with (the system's own), and nobody who can sign in.
    const rowsNow = () => (db.prepare('SELECT public_key FROM members ORDER BY public_key').all() as { public_key: string }[]).map(r => r.public_key).join(',');
    const rowsBefore = rowsNow();
    const genesisMembers = () => (db.prepare("SELECT COUNT(*) AS n FROM members WHERE invited_by = 'genesis' AND public_key != 'SYSTEM'").get() as { n: number }).n;
    assert(genesisMembers() === 0 && (db.prepare("SELECT COUNT(*) AS n FROM members WHERE COALESCE(is_treasury, 0) = 0 AND public_key != 'SYSTEM'").get() as { n: number }).n === 0,
        'the node is fresh: no member yet, and no genesis member');
    const seedFresh = await call(null, 'POST', '/api/admin/seed-invite', { type: 'elder' }, PASSWORD);
    assert(invitesOff(seedFresh), `the seed invite on the empty node, with the admin password → 404 feature_off invites (${show(seedFresh)})`);
    assert(rowsNow() === rowsBefore && genesisMembers() === 0 && codeCount() === 0 && !db.prepare('SELECT 1 FROM node_roles').get(),
        `...and writes nothing: no "Admin" genesis member, no code, no role (codes ${codeCount()}, genesis members ${genesisMembers()})`);

    const marty = newId('Marty');
    const martyJoins = await joinThroughDoor(marty, 'marty-google-sub-0001');
    assert(martyJoins.status === 200 && memberRow(marty.pk)?.invited_by === 'open:google' && memberRow(marty.pk)?.invite_code === null,
        `Marty joins through the open door with a sign-in, no invite (${show(martyJoins)})`);
    const grant = await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: marty.pk, role: 'owner' }, PASSWORD);
    assert(grant.status === 200 && roleOf(marty.pk) === 'owner', `the admin password makes him owner (${show(grant)}; role ${roleOf(marty.pk)})`);
    const martySession = await keySession(marty);
    const roles = martySession.session
        ? await call(null, 'GET', '/api/local/admin/node-roles', undefined, { 'x-admin-session': martySession.session }) : null;
    assert(!!martySession.session && roles?.status === 200 && roles.body?.roles?.some((r: any) => r.member_pubkey === marty.pk && r.role === 'owner'),
        `his own key opens Settings as owner, as the app's Manage button does (${martySession.why}; ${roles ? show(roles) : 'no session'})`);
    const seedByOwner = martySession.session
        ? await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, { 'x-admin-session': martySession.session }) : null;
    const seedByPassword = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD);
    const ownGenerate = await generate(marty);
    assert(!!seedByOwner && invitesOff(seedByOwner) && invitesOff(seedByPassword) && invitesOff(ownGenerate) && codeCount() === 0,
        `as owner he makes none: the seed invite under his key session and under the password, and a member's generate, each 404 (${seedByOwner ? show(seedByOwner) : '-'} | ${show(seedByPassword)} | ${show(ownGenerate)})`);

    // ── 2. members and node roles alike ───────────────────────────────────────────────────────────
    console.log('\n── 2. nobody makes an invite, and none joins anyone ──');
    const nia = newId('Nia');
    const ada = newId('Ada');
    assert((await joinThroughDoor(nia, 'nia-google-sub-0002')).status === 200 && (await joinThroughDoor(ada, 'ada-google-sub-0003')).status === 200,
        'Nia and Ada join through the door');
    const adminGrant = await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: ada.pk, role: 'admin' }, PASSWORD);
    assert(adminGrant.status === 200 && roleOf(ada.pk) === 'admin', `Ada is made an admin (${show(adminGrant)})`);
    const niaMakes = await generate(nia);
    const adaMakes = await generate(ada);
    assert(invitesOff(niaMakes) && invitesOff(adaMakes) && codeCount() === 0,
        `a member's generate and an admin's → 404 feature_off invites, and no code is written (${show(niaMakes)} | ${show(adaMakes)})`);
    const adaSession = await keySession(ada);
    const adaSeed = adaSession.session
        ? await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, { 'x-admin-session': adaSession.session }) : null;
    assert(!!adaSeed && invitesOff(adaSeed) && codeCount() === 0, `nor the admin's seed invite under her own key (${adaSeed ? show(adaSeed) : adaSession.why})`);

    // Codes already in the database: a member's, and a seed invite's.
    plantCode('INV-OLDM-EMBR', nia.pk);
    plantCode('INV-OLDS-EEDS', marty.pk, 'elder');
    const attemptsBefore = funnelAttempts();
    const zed = newId('Zed');
    const zedMember = await redeem(zed, 'INV-OLDM-EMBR');
    const zedSeed = await redeem(zed, 'INV-OLDS-EEDS');
    assert(invitesOff(zedMember) && invitesOff(zedSeed), `a member's code and a seed invite already in the database → 404 feature_off invites (${show(zedMember)} | ${show(zedSeed)})`);
    assert(!memberRow(zed.pk) && codeRow('INV-OLDM-EMBR')?.used_by === null && codeRow('INV-OLDS-EEDS')?.used_by === null,
        '...nobody joined, and both codes are still unused');
    const ticket = offlineTicket(nia);
    const zedTicket = await redeemTicket(zed, ticket);
    assert(invitesOff(zedTicket) && !memberRow(zed.pk) && codeCount() === 2,
        `an offline ticket Nia signed → 404, nobody joined, and no code row is made for it (${show(zedTicket)})`);
    assert(funnelAttempts() === attemptsBefore, `the funnel counts no invite attempt for any of them (${attemptsBefore} → ${funnelAttempts()})`);
    const unsigned = await call(null, 'POST', '/api/invite/redeem', { code: 'INV-OLDM-EMBR', publicKey: zed.pk, callsign: 'Zed' });
    assert(invitesOff(unsigned) && !memberRow(zed.pk), `unsigned, the same → 404 (${show(unsigned)})`);
    const check = await call(null, 'GET', '/api/invite/check?code=INV-OLDM-EMBR');
    const checkTicket = await call(null, 'GET', `/api/invite/check?code=${encodeURIComponent(`BP-${ticket}`)}`);
    assert(invitesOff(check) && invitesOff(checkTicket), `the pre-flight check, for a code and for a ticket → 404 (${show(check)} | ${show(checkTicket)})`);
    const mine = await call(nia, 'GET', `/api/invite/mine/${nia.pk}`);
    const tree = await call(nia, 'GET', '/api/invite/tree');
    assert(mine.status === 200 && mine.body?.invites?.some((i: any) => i.code === 'INV-OLDM-EMBR') && tree.status === 200,
        `reads still answer: Nia's own invites list the old code, and the tree reads (${mine.status}, ${tree.status})`);

    // Knocks are answered with an invite: off with invites, even with their own switch on.
    setOverride('knocks', 'true');
    const knocker = newId('Kit');
    const knock = await call(knocker, 'POST', '/api/join/knock', { callsign: 'Kit', message: 'Hello, may I join?', fromNode: 'https://example.org/' });
    const withKnocksOn = await info();
    assert(invitesOff(knock) && withKnocksOn?.features?.knocks === false && !db.prepare('SELECT 1 FROM join_requests WHERE pubkey = ?').get(knocker.pk),
        `with the operator's knocks override on, a knock is still 404, in the invites' words, and info says knocks false (${show(knock)})`);
    clearOverride('knocks');

    // Underneath the routes.
    const knockId = crypto.randomUUID();
    db.prepare("INSERT INTO join_requests (id, pubkey, callsign, message, status) VALUES (?, ?, 'Kit', 'Hello', 'pending')").run(knockId, knocker.pk);
    const codesBefore = codeCount();
    assert(engineRefuses(() => generateInvite(nia.pk)), 'the engine: generateInvite throws FeatureOffError(invites)');
    assert(engineRefuses(() => adminGenerateInvite(marty.pk, 'elder', undefined, 'owner:password')), 'the engine: adminGenerateInvite throws it');
    assert(engineRefuses(() => redeemInvite('INV-OLDM-EMBR', zed.pk, 'Zed', true)), 'the engine: redeemInvite throws it');
    assert(engineRefuses(() => redeemOfflineTicket(offlineTicket(nia), zed.pk, 'Zed', true)), 'the engine: redeemOfflineTicket throws it');
    assert(engineRefuses(() => approveKnock(knockId, nia.pk)), "the engine: a knock's answer (approveKnock) throws it");
    const knockRow = db.prepare('SELECT status, invite_code FROM join_requests WHERE id = ?').get(knockId) as any;
    assert(codeCount() === codesBefore && !memberRow(zed.pk) && knockRow?.status === 'pending' && knockRow?.invite_code === null,
        '...and none of them wrote anything: no code, no member, the knock still pending');
    db.prepare('DELETE FROM join_requests WHERE id = ?').run(knockId);

    const ola = newId('Ola');
    const olaJoins = await joinThroughDoor(ola, 'ola-google-sub-0004');
    assert(olaJoins.status === 200 && memberRow(ola.pk)?.invited_by === 'open:google', `the open door still lets the next person in (${show(olaJoins)})`);

    // ── 3. the operator turns them back on ───────────────────────────────────────────────────────
    console.log('\n── 3. the operator\'s override ──');
    setOverride('invites', 'true');
    const on = await info();
    const made = await generate(nia);
    const code = made.body?.invite?.code as string | undefined;
    const zedJoins = code ? await redeem(zed, code) : null;
    assert(on?.features?.invites === true && made.status === 200 && !!code && zedJoins?.status === 200 && memberRow(zed.pk)?.status === 'active',
        `global + nodeProfile.invites=true: info says invites true, Nia makes a code and Zed joins with it (${show(made)} | ${zedJoins ? show(zedJoins) : '-'})`);
    const madeToo = await generate(nia);
    clearOverride('invites');
    const quinn = newId('Quinn');
    const lateCode = madeToo.body?.invite?.code as string | undefined;
    const quinnTries = lateCode ? await redeem(quinn, lateCode) : null;
    assert(!!lateCode && !!quinnTries && invitesOff(quinnTries) && !memberRow(quinn.pk) && (await info())?.features?.invites === false,
        `the override gone, a code made while it was on is refused like the rest (${quinnTries ? show(quinnTries) : show(madeToo)})`);

    // ── 4. a local community: unchanged ──────────────────────────────────────────────────────────
    console.log('\n── 4. a local community (NODE_PROFILE unset) ──');
    delete process.env.NODE_PROFILE;
    const local = await info();
    assert(local?.profile === 'local' && local?.features?.invites === true && local?.features?.knocks === true,
        `/api/community/info on a local community: invites true, knocks true (got ${JSON.stringify(local?.features)})`);
    const localCode = await generate(nia);
    const rae = newId('Rae');
    const raeJoins = localCode.body?.invite?.code ? await redeem(rae, localCode.body.invite.code) : null;
    assert(localCode.status === 200 && raeJoins?.status === 200 && memberRow(rae.pk)?.status === 'active',
        `a member's code joins someone (${show(localCode)} | ${raeJoins ? show(raeJoins) : '-'})`);
    const sam = newId('Sam');
    const samTicket = offlineTicket(nia);
    const samCheck = await call(null, 'GET', `/api/invite/check?code=${encodeURIComponent(`BP-${samTicket}`)}`);
    const samJoins = await redeemTicket(sam, samTicket);
    assert(samCheck.status === 200 && samCheck.body?.valid === true && samJoins.status === 200 && memberRow(sam.pk)?.status === 'active',
        `the pre-flight says an offline ticket is good, and it joins someone (${show(samCheck)} | ${show(samJoins)})`);
    const localSeed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'trusted' }, PASSWORD);
    assert(localSeed.status === 200 && typeof localSeed.body?.code === 'string', `the seed invite works with the password (${show(localSeed)})`);

    // A member of the global node asks to join this community, a member here answers, and the invite minted here lets
    // them in here. (The global node is not involved: the phone talks to this community directly.)
    const gina = newId('Gina');
    const asks = await call(gina, 'POST', '/api/join/knock', { callsign: 'Gina', message: 'I found you from the global community.', fromNode: 'https://global.beanpool.org/' });
    const knockRowId = (db.prepare("SELECT id FROM join_requests WHERE pubkey = ? AND status = 'pending'").get(gina.pk) as { id: string } | undefined)?.id;
    const answered = knockRowId ? await call(rae, 'POST', `/api/join/knocks/${knockRowId}/approve`, {}) : null;
    const ginaStatus = await call(gina, 'GET', '/api/join/knock/status');
    const ginaCode = ginaStatus.body?.invite as string | undefined;
    const ginaJoins = ginaCode ? await redeem(gina, ginaCode) : null;
    assert(asks.status === 201 && answered?.status === 200 && ginaStatus.body?.status === 'approved' && ginaJoins?.status === 200
        && memberRow(gina.pk)?.status === 'active' && memberRow(gina.pk)?.invited_by === rae.pk,
        `a global member's knock, answered here by Rae: the invite minted here lets Gina in here (${show(asks)} | ${answered ? show(answered) : '-'} | ${show(ginaStatus)} | ${ginaJoins ? show(ginaJoins) : '-'})`);

    setOverride('invites', 'false');
    const localOff = await info();
    const offGenerate = await generate(nia);
    const offKnock = await call(newId('Lou'), 'POST', '/api/join/knock', { callsign: 'Lou', message: 'Hello there.', fromNode: 'https://global.beanpool.org/' });
    assert(localOff?.features?.invites === false && localOff?.features?.knocks === false && offGenerate.status === 404
        && offGenerate.body?.feature === 'invites' && offKnock.status === 404 && offKnock.body?.feature === 'invites',
        `local + nodeProfile.invites=false: no invites and no knocks there either (${show(offGenerate)} | ${show(offKnock)})`);
    assert(/isn’t taking new members right now/.test(offGenerate.body?.error ?? ''),
        `and with its door shut too, the refusal doesn't tell anyone to sign in (${offGenerate.body?.error})`);
    clearOverride('invites');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ invites-off checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
