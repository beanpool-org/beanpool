/**
 * `tierCredit` on GET /api/ledger/balance/:pk over HTTPS, through the real middleware (#1644 review r4183873149).
 *
 * The apps read a member's level and trust figure from their own balance answer (memberLevel in @beanpool/core). With no
 * `tierCredit` there they fall back to CREDIT_BASE_FLOOR − floor, so a member whose whole line the admins froze (floor 0)
 * would read "0 trust" beside a Steward badge. Each own signed read here must carry `tierCredit`, equal to the engine
 * profile's (getMemberTrustProfile), with the answer's tier the one that credit gives:
 *
 *   1. an admin with no trades: 0
 *   2. a member granted Steward by the tier badge: 600 (floor -600); an Elder: 1,400
 *   3. the whole line frozen (the manager's "Freeze"): still 600 / 1,400 with floor 0, and back to the line unfrozen
 *   4. the known floor (dial on, confirmed, one live offer): 1,000; an admin's exception lowers it to 300, then a freeze
 *      of that exception keeps 300
 *   5. another member's read is refused (403) and an unsigned one (401): neither body has a tierCredit, tier or floor
 *
 * Registered in scripts/server-suites.mjs: the plain run (read auth on, the default) and read auth opted out.
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-balance-tier-credit-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'TierCreditHttp123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { tierForCredit, tierIndexForName, memberLevel } from '@beanpool/core';
import { initStateEngine, seedGenesisMember, createPost, getMemberTrustProfile } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

function sessionHeaders(pub: string, role: 'owner' | 'admin'): Record<string, string> {
    const { handshakeToken } = mintHandshakeToken(pub, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

/** A member's own signed balance read: tierCredit is there, is `expected`, is the profile's, and the tier is its tier. */
async function ownRead(who: Id, label: string, expected: number, floor?: number): Promise<any> {
    const r = await call('GET', who, `/api/ledger/balance/${who.pk}`);
    const body = r.body ?? {};
    const profile = getMemberTrustProfile(who.pk);
    assert(r.status === 200 && typeof body.tierCredit === 'number', `${label}: the own read answers 200 with a tierCredit (${show(r)})`);
    assert(body.tierCredit === expected, `${label}: tierCredit is ${expected} (got ${body.tierCredit})`);
    assert(body.tierCredit === profile.tierCredit, `${label}: and equals the engine profile's, ${profile.tierCredit}`);
    assert(body.tier?.name === tierForCredit(body.tierCredit).name && body.tier?.name === profile.tier.name,
        `${label}: the answer's tier ${body.tier?.name} is the one ${body.tierCredit} gives (${tierForCredit(body.tierCredit).name}) and the profile's (${profile.tier.name})`);
    const level = memberLevel(body);
    assert(level.credit === expected && level.index === tierIndexForName(body.tier?.name),
        `${label}: the apps' memberLevel reads ${expected} at ${body.tier?.name} (got ${JSON.stringify(level)})`);
    if (floor !== undefined) assert(body.floor === floor, `${label}: floor ${floor} (got ${body.floor})`);
    return body;
}

async function main(): Promise<void> {
    console.log(`tierCredit on the own balance read (read auth ${process.env.ENFORCE_READ_AUTH === 'false' ? 'opted out' : 'on'})\n`);
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const adaAdmin = sessionHeaders(ada.pk, 'admin');
    const sid = makeMember('Sid');
    const fay = makeMember('Fay');
    const eli = makeMember('Eli');
    const kim = makeMember('Kim');
    const setTier = async (who: Id, tier: string) => {
        const r = await call('POST', null, `/api/local/admin/users/${who.pk}/tier`, { tier }, owner);
        assert(r.status === 200, `the owner gives ${who.name} the ${tier} badge (${show(r)})`);
    };
    const freeze = async (who: Id, on: boolean) => {
        const r = await call('POST', null, `/api/local/admin/users/${who.pk}/freeze`, { freeze: on }, owner);
        assert(r.status === 200 && r.body?.frozen === on, `the owner ${on ? 'freezes' : 'unfreezes'} ${who.name}'s whole line (${show(r)})`);
    };

    // ── 1. an admin with no trades ─────────────────────────────────────────────────────────────
    console.log('── 1. an admin, no trades ──');
    await ownRead(ada, 'Ada (admin, no trades)', 0, 0);

    // ── 2. granted by the tier badge ───────────────────────────────────────────────────────────
    console.log('── 2. granted ──');
    await setTier(sid, 'Steward');
    await ownRead(sid, 'Sid (granted Steward)', 600, -600);
    await setTier(fay, 'Steward');
    await setTier(eli, 'Elder');
    await ownRead(eli, 'Eli (granted Elder)', 1400, -1400);

    // ── 3. the whole line frozen ───────────────────────────────────────────────────────────────
    console.log('── 3. the whole line frozen ──');
    await freeze(fay, true);
    const fayFrozen = await ownRead(fay, 'Fay (Steward, whole line frozen)', 600, 0);
    assert(fayFrozen.creditFrozen === true, `Fay's answer says the line is frozen (creditFrozen ${fayFrozen.creditFrozen})`);
    // What the apps would read without the field: the floor alone, 0 trust beside a Steward badge.
    const fallback = memberLevel({ ...fayFrozen, tierCredit: undefined });
    assert(fallback.credit !== 600, `without tierCredit the apps would read Fay's trust from floor 0 as ${fallback.credit}, not 600: the field is what keeps it`);
    await freeze(eli, true);
    await ownRead(eli, 'Eli (Elder, whole line frozen)', 1400, 0);
    await freeze(fay, false);
    const fayOpen = await ownRead(fay, 'Fay (unfrozen)', 600, -600);
    assert(fayOpen.creditFrozen === false, 'and unfrozen her answer says so');

    // ── 4. the known floor ─────────────────────────────────────────────────────────────────────
    console.log('── 4. the known floor ──');
    const on = await call('POST', null, '/api/local/admin/known-floor', { confirmation: true }, owner);
    assert(on.status === 200 && on.body?.confirmation === true, `the owner turns the known floor on (${show(on)})`);
    createPost('offer', 'produce', 'Kim mends bikes', 'Bike repairs', 40, 'fixed', kim.pk);
    confirm(kim, ada);
    await ownRead(kim, 'Kim (confirmed, one live offer, known floor 1,000)', 1000, -1000);
    const lower = await call('POST', null, '/api/local/admin/known-floor/exception', { memberPubkey: kim.pk, amount: 300 }, adaAdmin);
    assert(lower.status === 200 && lower.body?.exception?.amount === 300, `an admin lowers Kim's known floor to 300 (${show(lower)})`);
    await ownRead(kim, 'Kim (known floor lowered to 300)', 300, -300);
    const kf = await call('POST', null, '/api/local/admin/known-floor/exception', { memberPubkey: kim.pk, frozen: true }, adaAdmin);
    assert(kf.status === 200 && kf.body?.exception?.frozen === true, `an admin freezes Kim's lowered known floor (${show(kf)})`);
    const kimFrozen = await ownRead(kim, 'Kim (lowered known floor, frozen)', 300);
    assert(kimFrozen.knownFrozen === true, `Kim's answer says the known floor is frozen (knownFrozen ${kimFrozen.knownFrozen})`);

    // ── 5. someone else's read ─────────────────────────────────────────────────────────────────
    console.log("── 5. another member's read ──");
    for (const [reader, target] of [[kim, sid], [sid, fay], [ada, eli]] as Array<[Id, Id]>) {
        const r = await call('GET', reader, `/api/ledger/balance/${target.pk}`);
        assert(r.status === 403, `${reader.name} reading ${target.name}'s balance is refused (${show(r)})`);
        assert(r.body && !('tierCredit' in r.body) && !('tier' in r.body) && !('floor' in r.body),
            `and the refusal carries no tierCredit, tier or floor (${show(r)})`);
    }
    const unsigned = await call('GET', null, `/api/ledger/balance/${fay.pk}`);
    assert(unsigned.status === 401 && !('tierCredit' in (unsigned.body ?? {})), `an unsigned read is refused with no tierCredit (${show(unsigned)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
