/**
 * The node has no admin password (Marty, 11 Nov 2026): owners sign in to Settings with their key ("Sign in with your
 * phone", the app's Manage), scripts and the fleet with an owner's automation token, a standby with its replication
 * token. Over REAL HTTPS through the real middleware; nothing here contacts anything but the server it starts.
 *
 * The node is booted as an older install might have left it: ADMIN_PASSWORD in the environment, and local-config.json
 * still holding an admin password's hash and salt, a server 2FA secret and break-glass mode on. Nothing reads them.
 *
 *   1. Every password route is gone (404): the password sign-in, verify-password, change-password, the password's
 *      retirement, break-glass mode and its status, the server 2FA's routes and the copy routes' token-only switch.
 *   2. The old password signs nobody in: in X-Admin-Password (with a 2FA code too), in a body `password`, or in
 *      X-Break-Glass-Code, an admin route answers 401 notSignedIn, the logs ticket included; /settings opens (no
 *      break-glass page), /api/local/status says nothing about a password, and /api/local/claim says `password: false`.
 *   3. Key sign-in still works: challenge, signature, exchange, then the cookie reads the admin routes, takes a CSRF
 *      token for a change and gets a logs ticket.
 *   4. An owner's break-glass code still enrols a key, on the enrol routes only and only from X-Break-Glass-Code or
 *      `breakGlassCode`: the same code is no credential anywhere else, nor in `password`; a wrong one is 401.
 *   5. A standby's copy routes take the replication token only: the old password, or an owner's session, is 401. The
 *      replication answers say `tokenOnly: true`, with a token or without, whatever the config's old switch says.
 *   6. The fleet's backup pull needs an owner's automation token: the harvester refuses to run without one, and the
 *      node's backup route refuses the old password and opens to the token.
 *   7. The leftover keys are not converted or deleted by code (that is the operator's hand step), and a backup file's
 *      copy of the settings still leaves them out.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-no-admin-password" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
// An older install's .env line: the server must never read it.
const OLD_PW = 'OldAdminPassword-1!';
process.env.ADMIN_PASSWORD = OLD_PW;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole } from './state-engine.js';
import { db } from './db/db.js';
import {
    getLocalConfig, saveLocalConfig, hashPassword, generateReplicationToken, setReplicationToken, redactLocalConfig,
} from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { issueBreakGlassCode } from './admin-key-auth.js';
import { issueAutomationToken } from './automation-tokens.js';
import { pullBackupForNode } from './services/harvester.js';

let PORT = 0;
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Reply { status: number; body: any; text: string; sessionId: string | null }
async function call(method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'manual',
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    const cookie = res.headers.getSetCookie().find(c => c.startsWith('admin_session=')) ?? '';
    return { status: res.status, body, text, sessionId: cookie.match(/^admin_session=([0-9a-f]{64})/)?.[1] ?? null };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 120)}`;
const asCookie = (sessionId: string | null, csrf?: string): Record<string, string> =>
    ({ Cookie: `admin_session=${sessionId ?? ''}`, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) });

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
function seedMember(k: Key, callsign: string): void {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(k.pub, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(k.pub);
}
/** The app's key sign-in over HTTP: challenge → signature → handshake token → exchange. */
async function keySignIn(k: Key): Promise<Reply> {
    const chal = await call('POST', '/api/local/admin/auth/challenge', { body: {} });
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        body: { challengeId: chal.body?.challengeId, memberPubkey: k.pub, signature: crypto.sign(null, Buffer.from(chal.body?.challenge ?? ''), k.priv).toString('hex') },
    });
    return call('POST', '/api/local/admin/auth/exchange', { body: { token: solved.body?.handshakeToken } });
}
const notSignedIn = (r: Reply) => r.status === 401 && r.body?.notSignedIn === true;

async function main(): Promise<void> {
    console.log('\n=== No admin password: key sign-in, tokens and break-glass codes only ===\n');
    await initTls();
    initStateEngine();
    const owner = keypair();
    const newcomer = keypair();
    seedMember(owner, 'Olive');
    seedMember(newcomer, 'Nell');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');

    // What an older install left in local-config.json: a password's hash and salt, a server 2FA, break-glass mode on, and
    // the copy routes' token-only switch never ticked.
    const { hash, salt } = hashPassword(OLD_PW);
    const leftovers = {
        adminHash: hash, salt, totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', totpBackupCodesHashes: [],
        breakGlassMode: true, passwordRetired: null, backupAdminPassword: OLD_PW, replicationTokenOnly: false,
    };
    saveLocalConfig({ ...getLocalConfig(), ...leftovers } as any);

    const { startHttpsServer } = await import('./https-server.js');
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    try {
        // ── 1. Every password route is gone ──────────────────────────────────────────────────────
        console.log('── 1. the password routes answer 404 ──');
        const signedIn = await keySignIn(owner);
        assert(signedIn.status === 200 && !!signedIn.sessionId, `an owner's key sign-in opens a session (${show(signedIn)})`);
        const gone: Array<[string, string]> = [
            ['POST', '/api/local/admin/auth/password'], ['GET', '/api/local/admin/auth/password-retirement'],
            ['POST', '/api/local/admin/auth/retire-password'], ['POST', '/api/local/admin/auth/break-glass-mode'],
            ['GET', '/api/local/admin/auth/break-glass-status'], ['GET', '/api/local/admin/auth/break-glass/status'],
            ['POST', '/api/local/verify-password'], ['POST', '/api/local/change-password'],
            ['GET', '/api/local/admin/2fa/status'], ['POST', '/api/local/admin/2fa/setup'], ['POST', '/api/local/admin/2fa/verify'],
            ['POST', '/api/local/admin/2fa/disable'], ['POST', '/api/local/admin/2fa/backup-codes'],
            ['POST', '/api/local/admin/replication-token/mode'],
        ];
        for (const [method, route] of gone) {
            const body = method === 'GET' ? undefined : { password: OLD_PW, currentPassword: OLD_PW, newPassword: 'NewAdminPassword-2!', enabled: false, tokenOnly: false };
            const anon = await call(method, route, { body });
            const asOwner = await call(method, route, { body, headers: asCookie(signedIn.sessionId) });
            assert(anon.status === 404 && asOwner.status === 404, `${method} ${route} → 404, signed in or not (${anon.status}, ${asOwner.status})`);
        }

        // ── 2. The old password signs nobody in ──────────────────────────────────────────────────
        console.log('\n── 2. the old password is no credential ──');
        resetAdminAuthTarpit();
        const read = '/api/local/admin/diagnostics';
        const byHeader = await call('GET', read, { headers: { 'X-Admin-Password': OLD_PW } });
        assert(notSignedIn(byHeader), `X-Admin-Password with the old password → 401 notSignedIn (${show(byHeader)})`);
        const withCode = await call('GET', read, { headers: { 'X-Admin-Password': OLD_PW, 'X-Admin-TOTP': '123456' } });
        assert(notSignedIn(withCode), `… and with a 2FA code too (${show(withCode)})`);
        const byBody = await call('POST', '/api/local/admin/csrf-token', { body: { password: OLD_PW } });
        assert(notSignedIn(byBody), `a body password → 401 notSignedIn (${show(byBody)})`);
        const asCode = await call('GET', read, { headers: { 'X-Break-Glass-Code': OLD_PW } });
        assert(notSignedIn(asCode), `the password as a break-glass code off the enrol routes → 401 notSignedIn (${show(asCode)})`);
        const ticket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: { 'X-Admin-Password': OLD_PW } });
        assert(notSignedIn(ticket), `no logs ticket for the password (${show(ticket)})`);
        const settings = await call('GET', '/settings');
        assert(settings.status === 200 && !/Break-Glass Mode Active/.test(settings.text),
            `/settings opens: break-glass mode left in the config shows no 403 page (${settings.status})`);
        const status = await call('GET', '/api/local/status');
        assert(status.status === 200 && !('isLocked' in (status.body || {})) && !('passwordRetired' in (status.body || {})),
            `/api/local/status says nothing about a password (${status.text.slice(0, 120)})`);
        // The hash left in local-config.json makes no difference: the claim check answers password: false, so the manager's
        // sign-in draws no password form (it draws one for any other answer).
        const claim = await call('GET', '/api/local/claim');
        assert(claim.status === 200 && claim.body?.password === false && !('passwordRetired' in (claim.body || {})),
            `/api/local/claim says this server has no admin password, whatever the config still holds (${claim.text.slice(0, 120)})`);

        // ── 3. Key sign-in still works ───────────────────────────────────────────────────────────
        console.log('\n── 3. key sign-in ──');
        const who = await call('GET', '/api/local/admin/auth/session', { headers: asCookie(signedIn.sessionId) });
        assert(who.body?.authenticated === true && who.body?.isKeySession === true && who.body?.memberPubkey === owner.pub && who.body?.role === 'owner',
            `the cookie says who: the owner's key session (${who.text.slice(0, 140)})`);
        const diag = await call('GET', read, { headers: asCookie(signedIn.sessionId) });
        assert(diag.status === 200, `the cookie opens an admin read (${diag.status})`);
        const csrf = await call('POST', '/api/local/admin/csrf-token', { body: {}, headers: asCookie(signedIn.sessionId) });
        assert(csrf.status === 200 && typeof csrf.body?.csrfToken === 'string', `a CSRF token for the session (${show(csrf)})`);
        const noCsrf = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(signedIn.sessionId) });
        assert(noCsrf.status === 403, `a change on the cookie without it → 403 (${show(noCsrf)})`);
        const okTicket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(signedIn.sessionId, csrf.body?.csrfToken) });
        assert(okTicket.status === 200 && typeof okTicket.body?.ticket === 'string', `with it, a logs ticket (${show(okTicket)})`);

        // ── 4. A break-glass code still enrols a key ─────────────────────────────────────────────
        console.log('\n── 4. break-glass codes ──');
        resetAdminAuthTarpit();
        const code = issueBreakGlassCode(owner.pub, 'this suite', 'key-session');
        const elsewhere = await call('GET', read, { headers: { 'X-Break-Glass-Code': code } });
        assert(notSignedIn(elsewhere), `the code off the enrol routes → 401 notSignedIn (${show(elsewhere)})`);
        const asPassword = await call('POST', '/api/local/admin/auth/enrol', { body: { password: code, memberPubkey: newcomer.pub, role: 'admin' } });
        assert(notSignedIn(asPassword), `the code in a body \`password\` is not read (${show(asPassword)})`);
        const wrong = await call('POST', '/api/local/admin/auth/enrol', {
            body: { memberPubkey: newcomer.pub, role: 'admin' }, headers: { 'X-Break-Glass-Code': 'bg-0000-0000-0000-0000' },
        });
        assert(wrong.status === 401 && wrong.body?.error === 'Invalid break-glass code', `a wrong code → 401 (${show(wrong)})`);
        const enrolled = await call('POST', '/api/local/admin/auth/enrol', {
            body: { memberPubkey: newcomer.pub, role: 'admin' }, headers: { 'X-Break-Glass-Code': code },
        });
        assert(enrolled.status === 200 && enrolled.body?.role === 'admin', `the owner's code enrols a key (${show(enrolled)})`);
        const role = db.prepare('SELECT role, granted_by FROM node_roles WHERE member_pubkey = ?').get(newcomer.pub) as { role: string; granted_by: string } | undefined;
        assert(role?.role === 'admin' && role?.granted_by === owner.pub, `… attributed to the code's owner, never 'owner:password' (${JSON.stringify(role)})`);

        // ── 5. A standby copies with its token only ──────────────────────────────────────────────
        console.log('\n── 5. the copy routes ──');
        const copy = '/api/local/admin/sync-snapshot';
        const pwCopy = await call('GET', copy, { headers: { 'X-Admin-Password': OLD_PW } });
        assert(pwCopy.status === 401 && pwCopy.body?.error === 'Replication token required', `the old password → 401 (${show(pwCopy)})`);
        const sessionCopy = await call('GET', copy, { headers: asCookie(signedIn.sessionId) });
        assert(sessionCopy.status === 401, `an owner's session → 401: a copy is the standby's (${show(sessionCopy)})`);
        // What Settings' Replication Access panel reads: token-only, always, whatever the config's old switch says (false
        // here). Without it the panel says the admin password still copies.
        const owned = asCookie(signedIn.sessionId, csrf.body?.csrfToken);
        const statusNone = await call('POST', '/api/local/admin/replication-token/status', { body: {}, headers: owned });
        assert(statusNone.status === 200 && statusNone.body?.tokenOnly === true && statusNone.body?.hasToken === false,
            `with no token, replication-token/status says tokenOnly: true (${show(statusNone)})`);
        const accessNone = await call('POST', '/api/local/admin/replication-access', { body: {}, headers: owned });
        assert(accessNone.status === 200 && accessNone.body?.tokenOnly === true && accessNone.body?.hasToken === false,
            `… and so does replication-access (${show(accessNone)})`);
        const repToken = generateReplicationToken();
        setReplicationToken(repToken);
        const statusSet = await call('POST', '/api/local/admin/replication-token/status', { body: {}, headers: owned });
        assert(statusSet.status === 200 && statusSet.body?.tokenOnly === true && statusSet.body?.hasToken === true,
            `with a token, replication-token/status still says tokenOnly: true (${show(statusSet)})`);
        const accessByToken = await call('POST', '/api/local/admin/replication-access', { body: {}, headers: { 'X-Replication-Token': repToken } });
        assert(accessByToken.status === 200 && accessByToken.body?.tokenOnly === true && accessByToken.body?.hasToken === true,
            `… and so does replication-access, asked with the standby's token (${show(accessByToken)})`);
        // Past the gate the route answers for itself: this suite starts no p2p node, so it has no signing identity and the
        // snapshot says so (503). What is pinned is the gate: the token opens it, nothing else does.
        const tokenCopy = await call('GET', copy, { headers: { 'X-Replication-Token': repToken } });
        assert(tokenCopy.status !== 401 && !/token/i.test(String(tokenCopy.body?.error ?? '')),
            `the replication token passes the gate (${show(tokenCopy)})`);

        // ── 6. The fleet needs an owner's automation token ───────────────────────────────────────
        console.log('\n── 6. the fleet ──');
        let refused = '';
        try { await pullBackupForNode({ id: 'n1', name: 'n1', url: BASE, adminPassword: OLD_PW } as any); } catch (e: any) { refused = String(e?.message || e); }
        assert(/No automationToken configured/.test(refused), `the harvester will not pull with the old password (${refused.slice(0, 100)})`);
        const pwBackup = await call('POST', '/api/local/admin/backup', { body: {}, headers: { 'X-Admin-Password': OLD_PW } });
        assert(notSignedIn(pwBackup), `the node's backup route refuses the old password (${show(pwBackup)})`);
        const issued = issueAutomationToken({ name: 'fleet', scope: 'backups', createdBy: owner.pub });
        assert(issued.ok, 'an owner makes a backups token');
        const tokenBackup = issued.ok ? await fetch(`${BASE}/api/local/admin/backup`, {
            method: 'POST', headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' }, body: '{}',
        }) : null;
        const tokenStatus = tokenBackup?.status ?? 0;
        await tokenBackup?.body?.cancel().catch(() => {});
        assert(tokenStatus === 200, `… which the backup route takes (${tokenStatus})`);

        // ── 7. Leftovers: never converted by code, never in a backup file ────────────────────────
        console.log('\n── 7. the leftover keys ──');
        const file = JSON.parse(fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data'), 'local-config.json'), 'utf8'));
        assert(file.adminHash === hash && file.salt === salt && file.breakGlassMode === true && file.backupAdminPassword === OLD_PW,
            'local-config.json still holds what the older install left: nothing converts or deletes it');
        const redacted = redactLocalConfig(file) as any;
        assert(!('adminHash' in redacted) && !('salt' in redacted) && !('totpSecret' in redacted) && !('backupAdminPassword' in redacted),
            "a backup file's copy of the settings leaves the old hash, salt, 2FA secret and stored password out");
    } finally {
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
