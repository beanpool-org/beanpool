/**
 * The door: who may bring someone into a community (config/door.ts; community modes slice 1,
 * scratch/global-node/DESIGN-community-modes-fable.md §3, §5, §8 item 1). `members` (the default, every local community
 * until now) or `admins` ("Known": only owners and admins invite); `open` is the global node's, set by its profile.
 *
 * Over REAL HTTPS, through the signature middleware and the admin auth, with signed requests, on a local community.
 *
 *   1. As it ships: /api/community/info and /api/node/config say `members`, no row is stored, and a member makes a code
 *      and answers a knock as before. A code Mel makes now, and a knock Mel answers now, are kept for section 3.
 *   2. Setting it: unsigned is 401; an admin's key session is 403 (an owner's choice), and nothing in that request is
 *      written; `open` is 409 (a community with Beans can't open its door), anything else 400. The owner's own key sets
 *      `admins`: the row, the info, the config read.
 *   3. Only admins invite: a member's generate is 403 `admins_only` and writes nothing, nor counts toward a limit; a
 *      moderator's too; an admin's and the owner's work, and a member signing as an admin is refused by the middleware.
 *      Knocks: a member reads none and answers none (403, the knock still pending), an admin reads, declines and
 *      approves, and the applicant joins. A code Mel made before is still good (decided: it was made under the rule of
 *      its day, design §5), and so is the invite Mel's earlier answer made. A ticket Mel signs is refused by the
 *      pre-flight and the redeem, nobody joins and it stays unused; an admin's ticket joins. The seed invite works.
 *      Underneath the routes, the engine refuses the same.
 *   4. Back to `members`: the row goes, Mel invites and reads knocks again, and the ticket refused before now joins.
 *   5. The global profile: the door reads `open`, and Settings can set none (409), `open` included.
 *
 * A standby's copy and a take-over keep it: test-standby-community-settings (the `door` row).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-door-setting.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, generateInvite } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { approveKnock, declineKnock } from './engine/knocks.js';
import { getFunnel } from './engine/funnel.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';

let BASE = '';
const ADMIN_PW = 'Door-Setting-Admin-Pw-48!';
// Step 7c: with the node's 2FA off the admin password alone opens no admin route. The owner's password goes with a
// fresh code once main() has turned 2FA on.
let tfa: ReturnType<typeof turnOn2faForTests> | null = null;
const PASSWORD = (): Record<string, string> => (tfa ? tfa.headers() : { 'X-Admin-Password': ADMIN_PW });

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step the checks after it stand on: stop here rather than report a cascade. */
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

// ── identities and calls ─────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv: privateKey, name };
}

interface Res { status: number; body: any; text: string; cookie: string }

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
    return { status: res.status, body: parsed, text, cookie: res.headers.get('set-cookie') || '' };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 160)}` : '-');
const info = async () => (await call(null, 'GET', '/api/community/info')).body;
const nodeConfig = async () => (await call(null, 'GET', '/api/node/config')).body;

const generate = (id: Id) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const redeemTicket = (id: Id, ticketB64: string) => call(id, 'POST', '/api/invite/redeem-offline', { ticketB64, publicKey: id.pk, callsign: id.name });
const check = (code: string) => call(null, 'GET', `/api/invite/check?code=${encodeURIComponent(code)}`);
const knock = (id: Id) => call(id, 'POST', '/api/join/knock', { callsign: id.name, message: `Hello, I'm ${id.name}. May I join?` });
const knocks = (id: Id) => call(id, 'GET', '/api/join/knocks');
const answer = (id: Id, knockId: string, verb: 'approve' | 'decline') => call(id, 'POST', `/api/join/knocks/${knockId}/${verb}`, {});

/** A paper invite: an offline ticket `inviter` signed on their phone, which the node first sees when someone joins with it. */
function offlineTicket(inviter: Id): string {
    const payload = JSON.stringify({ i: inviter.pk, t: Date.now() });
    return Buffer.from(JSON.stringify({ p: payload, s: crypto.sign(null, Buffer.from(payload), inviter.priv).toString('base64') })).toString('base64');
}

/** A member's own key opening Settings, as the app's Manage button does: challenge, signature, session. */
async function keySession(id: Id): Promise<string | null> {
    const chal = await call(null, 'POST', '/api/local/admin/auth/challenge', {});
    const signature = crypto.sign(null, Buffer.from(String(chal.body?.challenge), 'utf-8'), id.priv).toString('hex');
    const verified = await call(null, 'POST', '/api/local/admin/auth/verify-challenge', { challengeId: chal.body?.challengeId, memberPubkey: id.pk, signature });
    if (verified.status !== 200) return null;
    const ex = await call(null, 'POST', '/api/local/admin/auth/exchange', { token: verified.body?.handshakeToken });
    // The exchange answers the session in its httpOnly cookie only, never in the body (Fable's web review, L3).
    return ex.cookie.match(/admin_session=([0-9a-f]+)/)?.[1] ?? null;
}
const setDoorAs = (headers: Record<string, string> | null, body: Record<string, unknown>) =>
    call(null, 'POST', '/api/local/admin/node/config', body, headers ?? {});

// ── the database ─────────────────────────────────────────────────────────────────────────────────
const memberRow = (pk: string) => db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk) as any;
const codeRow = (code: string) => db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as any;
const codeCount = () => (db.prepare('SELECT COUNT(*) AS n FROM invite_codes').get() as { n: number }).n;
const doorRow = () => (db.prepare("SELECT value FROM node_config WHERE key = 'door'").get() as { value: string } | undefined)?.value ?? null;
const knockRow = (pk: string) => db.prepare('SELECT * FROM join_requests WHERE pubkey = ?').get(pk) as any;
const funnelFailures = (variant: string) => getFunnel(1).filter(r => r.event === 'invite_failed' && r.variant === variant).reduce((n, r) => n + r.count, 0);
const publishHealthNow = () => (db.prepare("SELECT value FROM node_config WHERE key = 'node_config'").get() as { value?: string } | undefined)?.value ?? '';

/** 403 `admins_only`, in words that say only admins do it here, and never a tier. */
const adminsOnly = (r: Res) => r.status === 403 && r.body?.code === 'admins_only' && /only its admins/.test(r.body?.error ?? '')
    && !/Newcomer|Resident|Steward|Elder|tier/i.test(r.body?.error ?? '');

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const alone = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    assert(alone.status === 403 && alone.body?.code === 'password_needs_2fa' && !alone.body?.success,
        `2FA off: the owner's password alone → 403 password_needs_2fa, no invite (${show(alone)})`);
    tfa = turnOn2faForTests(ADMIN_PW);

    // The community: Owen (owner), Ada (admin), Mo (moderator), Mel (a member).
    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the fresh node's seed invite (${show(seed)})`);
    const [ada, mo, mel] = ['Ada', 'Mo', 'Mel'].map(newId);
    for (const who of [ada, mo, mel]) {
        const made = await generate(owen);
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin'], [mo, 'moderator']] as const) {
        const granted = await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD());
        require_(granted.status === 200, `${who.name} is made ${role} (${show(granted)})`);
    }

    // ── 1. as it ships ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. as it ships: any member invites ──');
    const shipped = await info();
    const shippedConfig = await nodeConfig();
    assert(shipped?.features?.door === 'members' && shippedConfig?.door === 'members' && doorRow() === null,
        `/api/community/info and /api/node/config say door members, and nothing is stored (${JSON.stringify({ info: shipped?.features?.door, config: shippedConfig?.door, row: doorRow() })})`);
    const keys = Object.keys(shipped?.features ?? {});
    assert(keys[keys.length - 1] === 'door' && shipped?.features?.invites === true,
        `door comes last in features, so older apps read the rest as before (${keys.join(',')})`);
    const melEarly = await generate(mel);
    const earlyCode = melEarly.body?.invite?.code as string | undefined;
    assert(melEarly.status === 200 && !!earlyCode, `Mel, a member, makes a code (${show(melEarly)})`);
    const kit = newId('Kit');
    assert((await knock(kit)).status === 201, 'Kit asks to join');
    const kitKnock = knockRow(kit.pk);
    const melAnswers = kitKnock ? await answer(mel, kitKnock.id, 'approve') : null;
    assert(melAnswers?.status === 200 && melAnswers.body?.invite?.code, `Mel answers Kit's knock with an invite (${show(melAnswers)})`);

    // ── 2. setting it ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. who may set it ──');
    const unsigned = await setDoorAs(null, { door: 'admins' });
    assert(unsigned.status === 401 && doorRow() === null, `unsigned → 401, nothing stored (${show(unsigned)})`);
    const adaSession = await keySession(ada);
    require_(!!adaSession, "Ada's own key opens Settings as admin");
    const before = publishHealthNow();
    const byAdmin = await setDoorAs({ 'x-admin-session': adaSession! }, { door: 'admins', publishHealth: false });
    assert(byAdmin.status === 403 && /Only an owner/.test(byAdmin.body?.error ?? '') && doorRow() === null && publishHealthNow() === before,
        `an admin's key session → 403 (an owner's choice), and nothing in that request is written (${show(byAdmin)})`);
    const open = await setDoorAs(PASSWORD(), { door: 'open' });
    assert(open.status === 409 && open.body?.code === 'door_open_refused' && /strangers would hold credit/.test(open.body?.error ?? '') && doorRow() === null,
        `the owner asking for an open door on a community with Beans → 409, and why (${show(open)})`);
    for (const bad of ['everyone', 'ADMINS', 1, null, true]) {
        const r = await setDoorAs(PASSWORD(), { door: bad });
        assert(r.status === 400 && r.body?.code === 'bad_door' && doorRow() === null, `door ${JSON.stringify(bad)} → 400 (${show(r)})`);
    }
    const owenSession = await keySession(owen);
    require_(!!owenSession, "Owen's own key opens Settings as owner");
    const set = await setDoorAs({ 'x-admin-session': owenSession! }, { door: 'admins' });
    const nowInfo = await info();
    const nowConfig = await nodeConfig();
    assert(set.status === 200 && set.body?.door === 'admins' && doorRow() === 'admins' && nowInfo?.features?.door === 'admins' && nowConfig?.door === 'admins',
        `the owner's own key sets admins: stored, and info and config say so (${show(set)})`);

    // ── 3. only admins invite ────────────────────────────────────────────────────────────────────
    console.log('\n── 3. only admins invite ──');
    const codesBefore = codeCount();
    const melRefused = await generate(mel);
    const moRefused = await generate(mo);
    assert(adminsOnly(melRefused) && adminsOnly(moRefused) && codeCount() === codesBefore,
        `a member's generate and a moderator's → 403 admins_only, and no code is written (${show(melRefused)} | ${show(moRefused)})`);
    // The daily limit counts codes written, so refusals never spend it: 25 refused, then the door opens below and Mel makes one.
    for (let i = 0; i < 25; i++) await generate(mel);
    assert(codeCount() === codesBefore, 'many refused generates write nothing');
    const posing = await call(mel, 'POST', '/api/invite/generate', { publicKey: ada.pk });
    assert(posing.status !== 200 && codeCount() === codesBefore, `Mel signing a generate that names Ada's key is refused by the signature middleware (${show(posing)})`);
    const adaMakes = await generate(ada);
    const owenMakes = await generate(owen);
    assert(adaMakes.status === 200 && owenMakes.status === 200 && codeCount() === codesBefore + 2,
        `the admin and the owner each make a code (${show(adaMakes)} | ${show(owenMakes)})`);

    const [lia, ned] = ['Lia', 'Ned'].map(newId);
    assert((await knock(lia)).status === 201 && (await knock(ned)).status === 201, 'Lia and Ned ask to join');
    const liaKnock = knockRow(lia.pk), nedKnock = knockRow(ned.pk);
    const melList = await knocks(mel);
    const melApprove = await answer(mel, liaKnock.id, 'approve');
    const melDecline = await answer(mel, nedKnock.id, 'decline');
    const moApprove = await answer(mo, liaKnock.id, 'approve');
    assert(adminsOnly(melList) && adminsOnly(melApprove) && adminsOnly(melDecline) && adminsOnly(moApprove),
        `a member reads no requests and answers none either way, nor a moderator (${show(melList)} | ${show(melApprove)} | ${show(melDecline)} | ${show(moApprove)})`);
    assert(knockRow(lia.pk)?.status === 'pending' && knockRow(ned.pk)?.status === 'pending' && knockRow(lia.pk)?.invite_code === null,
        '...both knocks are still pending, with no invite made');
    const adaList = await knocks(ada);
    assert(adaList.status === 200 && adaList.body?.knocks?.some((k: any) => k.pubkey === lia.pk) && adaList.body?.knocks?.some((k: any) => k.pubkey === ned.pk),
        `the admin reads both requests (${show(adaList)})`);
    const adaDeclines = await answer(ada, nedKnock.id, 'decline');
    const adaApproves = await answer(ada, liaKnock.id, 'approve');
    const liaStatus = await call(lia, 'GET', '/api/join/knock/status');
    const liaJoins = liaStatus.body?.invite ? await redeem(lia, liaStatus.body.invite) : null;
    assert(adaDeclines.status === 200 && adaApproves.status === 200 && liaJoins?.status === 200 && memberRow(lia.pk)?.invited_by === ada.pk,
        `the admin declines Ned and invites Lia, and Lia joins with it (${show(adaDeclines)} | ${show(adaApproves)} | ${show(liaJoins)})`);

    // Made before the door closed, by the rule of that day: still good until it lapses.
    const zed = newId('Zed');
    const zedJoins = earlyCode ? await redeem(zed, earlyCode) : null;
    assert(zedJoins?.status === 200 && memberRow(zed.pk)?.invited_by === mel.pk && codeRow(earlyCode!)?.used_by === zed.pk,
        `a code Mel made before the door closed still joins someone (${show(zedJoins)})`);
    const kitStatus = await call(kit, 'GET', '/api/join/knock/status');
    const kitJoins = kitStatus.body?.invite ? await redeem(kit, kitStatus.body.invite) : null;
    assert(kitJoins?.status === 200 && memberRow(kit.pk)?.invited_by === mel.pk,
        `and so does the invite Mel's earlier answer made for Kit (${show(kitJoins)})`);

    // A ticket is first seen at the join, and its date is its maker's own claim.
    const melTicket = offlineTicket(mel);
    const sue = newId('Sue');
    const refusedBefore = funnelFailures('admins_only');
    const melTicketCheck = await check(`BP-${melTicket}`);
    const codesNow = codeCount();
    const sueTries = await redeemTicket(sue, melTicket);
    assert(melTicketCheck.status === 200 && melTicketCheck.body?.valid === false && melTicketCheck.body?.reason === 'admins_only',
        `the pre-flight says a ticket Mel signed won't do here (${show(melTicketCheck)})`);
    assert(sueTries.status === 400 && /only its admins bring people in/.test(sueTries.body?.error ?? '') && !memberRow(sue.pk) && codeCount() === codesNow,
        `joining with it → 400 in plain words; nobody joins and the ticket stays unused (${show(sueTries)})`);
    assert(funnelFailures('admins_only') === refusedBefore + 1, 'the funnel counts it as its own refusal');
    const adaTicket = offlineTicket(ada);
    const tom = newId('Tom');
    const adaTicketCheck = await check(`BP-${adaTicket}`);
    const tomJoins = await redeemTicket(tom, adaTicket);
    assert(adaTicketCheck.body?.valid === true && tomJoins.status === 200 && memberRow(tom.pk)?.invited_by === ada.pk,
        `a ticket the admin signed passes the pre-flight and joins someone (${show(adaTicketCheck)} | ${show(tomJoins)})`);
    const seedNow = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    assert(seedNow.status === 200 && typeof seedNow.body?.code === 'string', `the seed invite works as on every door (${show(seedNow)})`);

    // Underneath the routes. Uma's knock is planted: this address has knocked 3 times today, the most it may.
    const uma = newId('Uma');
    db.prepare("INSERT INTO join_requests (id, pubkey, callsign, message, status) VALUES (?, ?, 'Uma', 'Hello', 'pending')").run(crypto.randomUUID(), uma.pk);
    const umaKnock = knockRow(uma.pk);
    const codesUnder = codeCount();
    let threw: unknown = null;
    try { generateInvite(mel.pk); } catch (e) { threw = e; }
    assert((threw as any)?.code === 'admins_only' && (threw as any)?.status === 403, `the engine: a member's generateInvite throws admins_only (${(threw as any)?.message})`);
    const engineApprove = approveKnock(umaKnock.id, mel.pk);
    const engineDecline = declineKnock(umaKnock.id, mel.pk);
    assert(!engineApprove.ok && engineApprove.reason === 'admins_only' && !engineDecline.ok && engineDecline.reason === 'admins_only'
        && knockRow(uma.pk)?.status === 'pending' && codeCount() === codesUnder,
        `the engine: a member's approveKnock and declineKnock answer admins_only and write nothing (${JSON.stringify([engineApprove, engineDecline])})`);

    // ── 4. back to members ───────────────────────────────────────────────────────────────────────
    console.log('\n── 4. back to any member ──');
    const back = await setDoorAs(PASSWORD(), { door: 'members' });
    assert(back.status === 200 && back.body?.door === 'members' && doorRow() === null && (await info())?.features?.door === 'members',
        `the owner (password) sets members again: the row goes, and info says members (${show(back)})`);
    const melAgain = await generate(mel);
    const melReads = await knocks(mel);
    const sueNow = await redeemTicket(sue, melTicket);
    assert(melAgain.status === 200 && melReads.status === 200 && melReads.body?.knocks?.some((k: any) => k.pubkey === uma.pk),
        `Mel makes a code and reads the requests again (${show(melAgain)} | ${show(melReads)})`);
    assert(sueNow.status === 200 && memberRow(sue.pk)?.invited_by === mel.pk, `and the ticket refused before now joins Sue (${show(sueNow)})`);

    // ── 5. the global profile ────────────────────────────────────────────────────────────────────
    console.log('\n── 5. the global profile: the door is open, and set by the profile ──');
    process.env.NODE_PROFILE = 'global';
    const g = await info();
    const gConfig = await nodeConfig();
    const gSet = await setDoorAs(PASSWORD(), { door: 'admins' });
    const gOpen = await setDoorAs(PASSWORD(), { door: 'open' });
    assert(g?.features?.door === 'open' && g?.features?.invites === false && gConfig?.door === 'open',
        `info and config say open (${JSON.stringify({ door: g?.features?.door, invites: g?.features?.invites, config: gConfig?.door })})`);
    assert(gSet.status === 409 && gSet.body?.code === 'door_set_by_profile' && gOpen.status === 409 && doorRow() === null,
        `Settings can set no door there, open included (${show(gSet)} | ${show(gOpen)})`);
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ door-setting checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
