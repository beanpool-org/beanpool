/**
 * Who can read the members the new members' allowance flag names (cohort_velocity; Marty, 14 Nov 2026: owners and admins,
 * the people who may see a member's + or −), over HTTPS through the real middleware. A member past the line is seeded in
 * cohort_allowance_members, as the metrics audit leaves it (engine audit.ts, test-backend-monitors), then:
 *
 *   owner key session, admin key session   POST /api/local/admin/health: the flag names her, with her allowance
 *   the owner's automation token           the same (a token acts for the owner who made it), and its look is logged
 *   a moderator                            403 before the route runs (admin-auth MODERATOR_ROUTES)
 *   a member, signed; nobody                refused; the public GET /api/community/health has no flags at all
 *   the background check (alerts-summary)  the kind and severity only: no member, no allowance
 *   every look that names her              a line in the access log the owners read
 *
 * Registered in scripts/server-suites.mjs.
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-cohort-allowance-readers.ts
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
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;

function makeMember(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active')`).run(pk, name);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    return { pk, priv: privateKey, name };
}

function session(who: Id, role: 'owner' | 'admin' | 'moderator'): Record<string, string> {
    const { handshakeToken } = mintHandshakeToken(who.pk, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

async function call(method: string, path: string, opts: { headers?: Record<string, string>; signer?: Id; body?: unknown } = {}): Promise<Res> {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
    const bodyString = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.signer.pk;
        headers['X-Signature'] = signRequest(opts.signer.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? bodyString : undefined });
    let body: any; try { body = await res.json(); } catch { /* empty */ }
    return { status: res.status, body };
}

const cohortFlag = (r: Res) => (r.body?.flags ?? []).find((f: any) => f.type === 'cohort_velocity');
/** The access log the owners read (health_access_log, engine/community-health.ts logAlertsLook): looks at this member. */
const looksAt = (pk: string) => (db.prepare("SELECT COUNT(*) AS n FROM health_access_log WHERE action = 'alerts_read' AND subject_pubkey = ?").get(pk) as { n: number }).n;

async function main(): Promise<void> {
    console.log('Who reads the members the new members\' allowance flag names\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = makeMember('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = makeMember('Olga');
    const admin = makeMember('Rob');
    const mod = makeMember('Moe');
    const plain = makeMember('Pat');
    const voucher = makeMember('Vic');
    const mia = makeMember('Mia');
    grantNodeRole(owner.pk, 'owner', 'SYSTEM');
    grantNodeRole(admin.pk, 'admin', 'SYSTEM');
    grantNodeRole(mod.pk, 'moderator', 'SYSTEM');
    db.prepare(`INSERT INTO cohort_allowance_members (member_pubkey, allowance_c, counted_c, days_after_joining, parts) VALUES (?, 60000, 60000, 3, ?)`)
        .run(mia.pk, JSON.stringify([{ kind: 'vouch', from: voucher.pk, amount_c: 60000, counted: true }]));

    for (const [who, headers] of [['the owner', session(owner, 'owner')], ['an admin', session(admin, 'admin')], ["the owner's automation token", ownerTokenHeaders('admin', owner.pk)]] as const) {
        const before = looksAt(mia.pk);
        const r = await call('POST', '/api/local/admin/health', { headers, body: {} });
        const f = cohortFlag(r);
        assert(r.status === 200 && f?.members?.includes(mia.pk) && f?.allowances?.[0]?.member === mia.pk && f.allowances[0].allowance_c === 60000,
            `${who} reads the flag naming Mia, with her allowance (${r.status} ${JSON.stringify(f)?.slice(0, 120)})`);
        assert(looksAt(mia.pk) > before, `and the look is a line in the access log (${looksAt(mia.pk) - before})`);
    }
    const byMod = await call('POST', '/api/local/admin/health', { headers: session(mod, 'moderator'), body: {} });
    assert(byMod.status === 403 && !JSON.stringify(byMod.body ?? {}).includes(mia.pk), `a moderator is refused, and reads no name (${show(byMod)})`);
    const bySigned = await call('POST', '/api/local/admin/health', { signer: plain, body: {} });
    assert(bySigned.status === 401 || bySigned.status === 403, `a member's signed request is refused (${show(bySigned)})`);
    assert(!JSON.stringify(bySigned.body ?? {}).includes(mia.pk), 'and reads no name');
    const byNobody = await call('POST', '/api/local/admin/health', { body: {} });
    assert(byNobody.status === 401 || byNobody.status === 403, `nobody signed is refused (${show(byNobody)})`);
    const pub = await call('GET', '/api/community/health');
    assert(pub.status === 200 && pub.body?.flags === undefined && !JSON.stringify(pub.body).includes(mia.pk),
        `the public health answer carries no flags and no name (${pub.status}, flags ${JSON.stringify(pub.body?.flags)})`);
    const summary = await call('POST', '/api/local/admin/alerts-summary', { headers: session(admin, 'admin'), body: {} });
    const sf = cohortFlag(summary);
    assert(summary.status === 200 && !!sf && Array.isArray(sf.members) && sf.members.length === 0 && sf.allowances === undefined && !JSON.stringify(summary.body).includes(mia.pk),
        `the background check gets the kind only: no member, no allowance (${JSON.stringify(sf)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error('❌', e); process.exit(1); });
