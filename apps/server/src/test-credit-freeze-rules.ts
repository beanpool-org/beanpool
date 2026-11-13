/**
 * Who may freeze or unfreeze a member's credit line (POST /api/local/admin/users/:pubkey/freeze, the manager's "Freeze"),
 * over HTTPS through the real middleware. Marty, 14 Nov 2026: an admin could freeze the owner and himself, and the log named
 * nobody. Now:
 *
 *   1. nobody freezes or unfreezes their own account (403 own_account), owner or admin;
 *   2. an admin never freezes or unfreezes an owner (403 owner_only); an owner may (another owner, an admin, a member);
 *   3. only by the person's own key session: an owner's automation token is refused (403 key_session_only);
 *      a phone hand-off whose unlock is stale is asked for it again on an owner (403 step_up_required), not on a member;
 *   4. the log line names who froze whom, both short keys, and the row carries when;
 *   5. an admin still freezes and unfreezes a member and another admin; an unknown key is 404.
 *
 * Registered in scripts/server-suites.mjs.
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-credit-freeze-rules.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken, backdateAdminSessionForTests, PHONE_HANDOFF_IDLE_TTL_MS } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
type Id = { pk: string; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;

function makeMember(name: string): Id {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active')`).run(pk, name);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    return { pk, name };
}

function session(who: Id, role: 'owner' | 'admin', opts: { phone?: boolean } = {}): { headers: Record<string, string>; id: string } {
    const { handshakeToken } = mintHandshakeToken(who.pk, role);
    const s = consumeHandshakeToken(handshakeToken, Date.now(), opts.phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : undefined);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { headers: { 'X-Admin-Session': s.sessionId }, id: s.sessionId };
}

async function freeze(by: Record<string, string>, who: Id | string, on: boolean): Promise<Res> {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
    const pk = typeof who === 'string' ? who : who.pk;
    const res = await fetch(`${BASE}/api/local/admin/users/${pk}/freeze`, {
        method: 'POST', headers: { ...by, 'Content-Type': 'application/json' }, body: JSON.stringify({ freeze: on }),
    });
    let body: any; try { body = await res.json(); } catch { /* empty */ }
    return { status: res.status, body };
}

const frozen = (who: Id) => (db.prepare('SELECT credit_frozen FROM members WHERE public_key = ?').get(who.pk) as any)?.credit_frozen === 1;
const short = (who: Id) => who.pk.substring(0, 12);
function logLineFor(actor: Id, target: Id, verb: 'Froze' | 'Unfroze'): { message: string; timestamp: string } | undefined {
    return (db.prepare(`SELECT message, timestamp FROM system_logs WHERE category = 'ADMIN' ORDER BY id DESC LIMIT 50`).all() as any[])
        .find(r => String(r.message).startsWith(verb + ' ') && r.message.includes(short(target)) && r.message.includes(short(actor)));
}

async function main(): Promise<void> {
    console.log('Who may freeze a member\'s credit line\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = makeMember('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const marty = makeMember('Marty');
    const otto = makeMember('Otto');
    const rob = makeMember('Rob');
    const ada = makeMember('Ada');
    const mia = makeMember('Mia');
    grantNodeRole(marty.pk, 'owner', 'SYSTEM');
    grantNodeRole(otto.pk, 'owner', 'SYSTEM');
    grantNodeRole(rob.pk, 'admin', 'SYSTEM');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const M = session(marty, 'owner').headers;
    const O = session(otto, 'owner').headers;
    const R = session(rob, 'admin').headers;

    // 1. Never your own account.
    const robSelf = await freeze(R, rob, true);
    assert(robSelf.status === 403 && robSelf.body?.code === 'own_account' && !frozen(rob),
        `an admin can't freeze himself: 403 own_account, in words (${show(robSelf)})`);
    assert(typeof robSelf.body?.error === 'string' && /your own/i.test(robSelf.body.error), `the refusal says so in plain words (${robSelf.body?.error})`);
    const martySelf = await freeze(M, marty, true);
    assert(martySelf.status === 403 && martySelf.body?.code === 'own_account' && !frozen(marty),
        `nor can an owner freeze herself (${show(martySelf)})`);

    // 2. An admin never freezes an owner.
    const robOnMarty = await freeze(R, marty, true);
    assert(robOnMarty.status === 403 && robOnMarty.body?.code === 'owner_only' && !frozen(marty),
        `an admin freezing the owner is refused: 403 owner_only, and she is not frozen (${show(robOnMarty)})`);
    assert(typeof robOnMarty.body?.error === 'string' && /owner/i.test(robOnMarty.body.error), `in words (${robOnMarty.body?.error})`);

    // 4. An owner freezes an admin, and the log names who froze whom, and when.
    const martyOnRob = await freeze(M, rob, true);
    assert(martyOnRob.status === 200 && martyOnRob.body?.frozen === true && frozen(rob), `the owner freezes the admin (${show(martyOnRob)})`);
    const froze = logLineFor(marty, rob, 'Froze');
    assert(!!froze && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(froze.timestamp)),
        `the log line names both, ${short(marty)} froze ${short(rob)}, and when (${JSON.stringify(froze)})`);
    assert(!!froze && froze.message.indexOf(short(rob)) < froze.message.indexOf(short(marty)),
        `whom first, then by whom (${froze?.message})`);
    // Unfreeze follows the same rules: not his own.
    const robUnSelf = await freeze(R, rob, false);
    assert(robUnSelf.status === 403 && robUnSelf.body?.code === 'own_account' && frozen(rob),
        `the frozen admin can't unfreeze himself (${show(robUnSelf)})`);
    const martyUnRob = await freeze(M, rob, false);
    assert(martyUnRob.status === 200 && !frozen(rob) && !!logLineFor(marty, rob, 'Unfroze'),
        `the owner unfreezes him, and that is logged with both keys too (${show(martyUnRob)})`);

    // An owner may freeze another owner; an admin may not unfreeze one.
    const ottoOnMarty = await freeze(O, marty, true);
    assert(ottoOnMarty.status === 200 && frozen(marty), `another owner may freeze an owner (${show(ottoOnMarty)})`);
    const robUnMarty = await freeze(R, marty, false);
    assert(robUnMarty.status === 403 && robUnMarty.body?.code === 'owner_only' && frozen(marty),
        `an admin can't unfreeze an owner either (${show(robUnMarty)})`);
    const ottoUnMarty = await freeze(O, marty, false);
    assert(ottoUnMarty.status === 200 && !frozen(marty), `the other owner unfreezes her (${show(ottoUnMarty)})`);

    // 3. Only by the person's own key session.
    const token = ownerTokenHeaders('admin', marty.pk);
    const byToken = await freeze(token, mia, true);
    assert(byToken.status === 403 && byToken.body?.code === 'key_session_only' && !frozen(mia),
        `the owner's automation token can't freeze a member: 403 key_session_only (${show(byToken)})`);
    const tokenOnRob = await freeze(token, rob, true);
    assert(tokenOnRob.status === 403 && !frozen(rob), `nor an admin (${show(tokenOnRob)})`);
    const phone = session(otto, 'owner', { phone: true });
    backdateAdminSessionForTests(phone.id, 10 * 60_000);
    const stalePhoneOnOwner = await freeze(phone.headers, marty, true);
    assert(stalePhoneOnOwner.status === 403 && stalePhoneOnOwner.body?.code === 'step_up_required' && !frozen(marty),
        `a phone hand-off with a stale unlock is asked for it again before freezing an owner (${show(stalePhoneOnOwner)})`);
    const stalePhoneOnMember = await freeze(phone.headers, mia, true);
    assert(stalePhoneOnMember.status === 200 && frozen(mia), `but not before freezing a member (${show(stalePhoneOnMember)})`);
    await freeze(O, mia, false);

    // 5. An admin still freezes a member and another admin.
    const robOnMia = await freeze(R, mia, true);
    assert(robOnMia.status === 200 && frozen(mia) && !!logLineFor(rob, mia, 'Froze'), `an admin freezes a member, logged in his name (${show(robOnMia)})`);
    const robUnMia = await freeze(R, mia, false);
    assert(robUnMia.status === 200 && !frozen(mia), `and unfreezes her (${show(robUnMia)})`);
    const robOnAda = await freeze(R, ada, true);
    assert(robOnAda.status === 200 && frozen(ada), `an admin may freeze another admin (${show(robOnAda)})`);
    const unknown = await freeze(M, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', true);
    assert(unknown.status === 404, `an unknown key is 404 (${show(unknown)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error('❌', e); process.exit(1); });
