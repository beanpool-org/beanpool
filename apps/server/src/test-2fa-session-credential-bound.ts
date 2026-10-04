/**
 * test-2fa-session-credential-bound.ts — a 2FA session (X-Admin-2FA-Session) ends with the password and 2FA it was made under.
 *
 * A header client signs in with the password and a code and gets a 2FA session, so its next requests need no code. That
 * session only checked its expiry, which slides for 4 hours: after the authenticator was replaced (because it leaked),
 * the same password and an old 2FA session still got a /ws-ticket (the log stream opened again) and the diagnostics
 * (#1577's review). Now each 2FA session carries the password and 2FA it was made under, and on any other it is refused
 * with the usual 401 totpRequired, so the caller asks for a new code. The request that made the change keeps its own.
 *
 * Real HTTPS server, the password and 2FA session in headers (as the legacy Settings page sends them), the real
 * 2FA and password routes. Then:
 *   1. a 2FA session opens /ws-ticket and the diagnostics, and still does after a backup code is used and the backup
 *      codes are made again;
 *   2. the authenticator replaced: every other 2FA session is refused (ticket and diagnostics), the one that replaced it
 *      and the one it was handed work, the stream opens on its ticket, and a new code signs in;
 *   3. 2FA turned off, then on again: every 2FA session from before is refused, the new one works;
 *   4. the password changed: the other 2FA sessions are refused with the new password, the one that changed it carries on;
 *   5. the 2FA secret replaced outside the routes (as a takeover or `beanpool recover` writes it): every session is refused;
 *   6. a key session goes on working through all of it.
 *
 * Local only: it talks to the server it starts on localhost and nothing else.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { consumeHandshakeToken, createAdminChallenge, verifyAndSolveChallenge } from './admin-key-auth.js';
import { updateLocalConfig, hashPassword } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, generateBackupCodes, hashBackupCode, forgetUsedTotpCodesForTests } from './totp.js';

let BASE = '', WSS = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Who { pub: string; priv: crypto.KeyObject }
function seedMember(callsign: string): Who {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pub, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return { pub, priv: privateKey };
}
function keySession(who: Who): Record<string, string> {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), who.priv).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: who.pub, signature });
    if (!solved.ok) throw new Error(solved.error);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(ex.error);
    return { Cookie: `admin_session=${ex.sessionId}`, 'X-CSRF-Token': ex.csrfToken! };
}

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
}
/** A code from this authenticator that the server has not seen used yet. */
function code(secret: string): string {
    forgetUsedTotpCodesForTests();
    return generateTotpCode(secret);
}
/** Each sign-in from its own address (loopback is a trusted proxy), so the per-address sign-in limit is never reached. */
let signIns = 0;
const nextAddress = () => ({ 'X-Forwarded-For': `198.51.${++signIns}.7` });
/** Signs in with the password and a code (or a backup code): the 2FA session it is handed. */
async function signIn(password: string, totpCode: string): Promise<string> {
    const r = await call('POST', '/api/local/verify-password', nextAddress(), { password, totpCode });
    if (r.status !== 200 || typeof r.body?.tfaSessionToken !== 'string') throw new Error(`verify-password answered ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.tfaSessionToken;
}
const with2fa = (password: string, tfa: string) => ({ 'X-Admin-Password': password, 'X-Admin-2FA-Session': tfa });
const ticket = (password: string, tfa: string) => call('POST', '/api/local/admin/ws-ticket', with2fa(password, tfa));
const diagnostics = (password: string, tfa: string) => call('GET', '/api/local/admin/diagnostics', with2fa(password, tfa));
const refused = (r: { status: number; body: any }) => r.status === 401 && r.body?.totpRequired === true;
const show = (r: { status: number; body: any }) => `${r.status}${r.body?.totpRequired ? ' totpRequired' : ''}`;
/** Whether this 2FA session opens both, or is refused by both with 401 totpRequired. */
async function opens(password: string, tfa: string): Promise<{ both: boolean; neither: boolean; seen: string }> {
    const t = await ticket(password, tfa);
    const d = await diagnostics(password, tfa);
    return { both: t.status === 200 && d.status === 200, neither: refused(t) && refused(d), seen: `ticket ${show(t)}, diagnostics ${show(d)}` };
}
/** The secret in an otpauth:// URI from /2fa/setup. */
function secretOf(setup: { body: any }): string {
    const s = setup.body?.secret || new URL(setup.body?.otpauthUri).searchParams.get('secret');
    if (!s) throw new Error(`2fa/setup gave no secret: ${JSON.stringify(Object.keys(setup.body || {}))}`);
    return s;
}
function openLogs(t: string): Promise<WebSocket | number> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${WSS}/ws/logs?ticket=${t}`, { rejectUnauthorized: false });
        ws.on('open', () => resolve(ws));
        ws.on('unexpected-response', (req, res) => { resolve(res.statusCode ?? 0); req.destroy(); });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 3000);
    });
}

async function main() {
    console.log('--- TEST: a 2FA session ends with the password and 2FA it was made under ---');
    await initTls();
    initStateEngine();
    const PW = 'TfaBound-Session-123!';
    const { hash, salt } = hashPassword(PW);
    const S1 = generateTotpSecret();
    const BACKUP = generateBackupCodes(4);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: true, totpSecret: S1, totpBackupCodesHashes: BACKUP.map(hashBackupCode),
        totpPendingSecret: null, totpPendingBackupCodesHashes: [], breakGlassMode: false, replicationTokenOnly: false } as any);
    const PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    WSS = `wss://localhost:${PORT}`;
    const owner = seedMember('tfaOwner');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');
    const asKey = keySession(owner);

    // ── 1. A 2FA session works, and a backup code used or the backup codes made again end none ──
    const bystander = await signIn(PW, code(S1));
    let o = await opens(PW, bystander);
    assert(o.both, `password + 2FA session: ws-ticket and diagnostics → 200 (${o.seen})`);
    const viaBackup = await signIn(PW, BACKUP[0]);
    o = await opens(PW, viaBackup);
    assert(o.both, `a 2FA session from a backup code works (${o.seen})`);
    o = await opens(PW, bystander);
    assert(o.both, `a backup code used ends no other 2FA session (${o.seen})`);
    const again = await call('POST', '/api/local/admin/2fa/backup-codes', with2fa(PW, bystander), { code: code(S1) });
    assert(again.status === 200, `backup codes made again → 200 (got ${again.status})`);
    o = await opens(PW, bystander);
    assert(o.both, `backup codes made again end no 2FA session (${o.seen})`);

    // ── 2. The authenticator replaced ──
    const replacer = await signIn(PW, code(S1));
    const setup = await call('POST', '/api/local/admin/2fa/setup', with2fa(PW, replacer));
    assert(setup.status === 200, `2fa/setup while 2FA is on → 200 (got ${setup.status})`);
    const S2 = secretOf(setup);
    // The current code first (it is checked against S1), then the new one.
    const currentCode = code(S1);
    const verify = await call('POST', '/api/local/admin/2fa/verify', with2fa(PW, replacer), { code: code(S2), currentCode });
    assert(verify.status === 200 && typeof verify.body?.tfaSessionToken === 'string', `2fa/verify replaces the authenticator → 200 with a 2FA session (got ${verify.status})`);
    const handed = verify.body?.tfaSessionToken as string;
    o = await opens(PW, bystander);
    assert(o.neither, `after the authenticator is replaced, an older 2FA session + the same password → 401 totpRequired (${o.seen})`);
    o = await opens(PW, viaBackup);
    assert(o.neither, `…and so is the one from a backup code (${o.seen})`);
    o = await opens(PW, bystander);
    assert(o.neither, `…and it stays refused (${o.seen})`);
    o = await opens(PW, handed);
    assert(o.both, `the 2FA session 2fa/verify handed back works (${o.seen})`);
    o = await opens(PW, replacer);
    assert(o.both, `the 2FA session that replaced the authenticator carries on (${o.seen})`);
    const t = await ticket(PW, handed);
    const ws = t.status === 200 ? await openLogs(t.body.ticket) : t.status;
    assert(ws instanceof WebSocket, `a ticket on the new 2FA session opens the log stream (got ${ws instanceof WebSocket ? 'open' : ws})`);
    if (ws instanceof WebSocket) ws.terminate();
    const oldCode = await call('POST', '/api/local/verify-password', nextAddress(), { password: PW, totpCode: code(S1) });
    assert(oldCode.status === 401, `a code from the replaced authenticator signs nobody in → 401 (got ${oldCode.status})`);
    const fresh = await signIn(PW, code(S2));
    o = await opens(PW, fresh);
    assert(o.both, `a fresh sign-in with the new authenticator works (${o.seen})`);

    // ── 3. 2FA turned off, then on again ──
    const beforeOff = await signIn(PW, code(S2));
    const turnsOff = await signIn(PW, code(S2));
    const off = await call('POST', '/api/local/admin/2fa/disable', with2fa(PW, turnsOff), { code: code(S2) });
    assert(off.status === 200, `2FA turned off with a current code → 200 (got ${off.status})`);
    // With 2FA off the password opens no admin route, so it is turned on again from the owner's key session.
    const setup3 = await call('POST', '/api/local/admin/2fa/setup', asKey);
    assert(setup3.status === 200, `2fa/setup from a key session → 200 (got ${setup3.status})`);
    const S3 = secretOf(setup3);
    const on = await call('POST', '/api/local/admin/2fa/verify', asKey, { code: code(S3) });
    assert(on.status === 200, `2FA turned on again → 200 (got ${on.status})`);
    for (const [label, tfa] of [['from before it was off', beforeOff], ['that turned it off', turnsOff], ['handed back by the earlier re-enrol', handed], ['from the earlier fresh sign-in', fresh]] as const) {
        o = await opens(PW, tfa);
        assert(o.neither, `2FA off then on: the 2FA session ${label} → 401 totpRequired (${o.seen})`);
    }
    const afterOn = await signIn(PW, code(S3));
    o = await opens(PW, afterOn);
    assert(o.both, `a sign-in under the 2FA turned on again works (${o.seen})`);

    // ── 4. The password changed ──
    const PW2 = 'TfaBound-Session-456!';
    const changer = await signIn(PW, code(S3));
    const changed = await call('POST', '/api/local/change-password', with2fa(PW, changer), { currentPassword: PW, newPassword: PW2 });
    assert(changed.status === 200, `change-password with the password + a 2FA session → 200 (got ${changed.status})`);
    o = await opens(PW2, afterOn);
    assert(o.neither, `after the password changes, an older 2FA session with the NEW password → 401 totpRequired (${o.seen})`);
    o = await opens(PW2, changer);
    assert(o.both, `the 2FA session that changed the password carries on with the new one (${o.seen})`);
    const withOld = await ticket(PW, changer);
    assert(withOld.status === 401, `…and not with the old password → 401 (got ${withOld.status})`);
    const onNew = await signIn(PW2, code(S3));
    o = await opens(PW2, onNew);
    assert(o.both, `a fresh sign-in with the new password works (${o.seen})`);

    // ── 5. The 2FA secret replaced outside the routes ──
    const S4 = generateTotpSecret();
    updateLocalConfig({ totpEnabled: true, totpSecret: S4 } as any);
    for (const [label, tfa] of [['that changed the password', changer], ['from the last sign-in', onNew]] as const) {
        o = await opens(PW2, tfa);
        assert(o.neither, `the 2FA secret replaced in the settings file: the 2FA session ${label} → 401 totpRequired (${o.seen})`);
    }
    const last = await signIn(PW2, code(S4));
    o = await opens(PW2, last);
    assert(o.both, `a sign-in with the replaced secret works (${o.seen})`);

    // ── 6. A key session was never touched ──
    const kt = await call('POST', '/api/local/admin/ws-ticket', asKey);
    const kd = await call('GET', '/api/local/admin/diagnostics', asKey);
    assert(kt.status === 200 && kd.status === 200, `the owner's key session still gets a ticket and the diagnostics (${kt.status}, ${kd.status})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch(err => { console.error(err); process.exit(1); });
