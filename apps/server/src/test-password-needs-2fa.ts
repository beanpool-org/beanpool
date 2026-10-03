/**
 * Node sign-in, design step 7c (D3): with the node's 2FA off, the admin password sent with a request opens no admin
 * route. Over REAL HTTPS through the real middleware; nothing here contacts anything but the server it starts.
 *
 *   1. 2FA off: the X-Admin-Password header, a body `password`, and the password in X-Break-Glass-Code are refused on
 *      admin routes with 403 password_needs_2fa, reads and writes alike, and on every route that copies the header into
 *      a body password (backup-enroll, snapshots/download, restore, offbox-backups/download). A wrong password is still
 *      401 (the brake and the tarpit as before), and a break-glass code off the enrol routes is still a wrong password.
 *   2. What still takes it: the password sign-in (its session held to the 2FA card, #1537), verify-password, and a
 *      break-glass code on the enrol routes (the recovery factor itself). The password alone on enrol is refused.
 *   3. A legacy standby's copy route takes the header while token-only is off, as before; with token-only on it doesn't.
 *   4. A key session and an automation token are unaffected.
 *   5. 2FA on: the header + a code works, the header alone answers 401 totpRequired, the 2FA session works: as before.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-password-needs-2fa" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { updateLocalConfig, hashPassword, setBreakGlassMode } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, forgetUsedTotpCodesForTests } from './totp.js';
import { resetAdminAuthTarpit, PASSWORD_NEEDS_2FA_CODE } from './admin-auth.js';
import { issueBreakGlassCode } from './admin-key-auth.js';

let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const PW = 'PasswordNeeds2fa1!';
const SECRET = generateTotpSecret();

interface Reply { status: number; body: any; text: string; sessionId: string | null }

async function call(method: string, p: string, opts: { body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}): Promise<Reply> {
    forgetUsedTotpCodesForTests();
    resetAdminAuthTarpit();
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.raw ? new Uint8Array(opts.raw) : (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        redirect: 'manual',
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    const cookie = res.headers.getSetCookie().find(c => c.startsWith('admin_session=')) ?? '';
    return { status: res.status, body, text, sessionId: cookie.match(/^admin_session=([0-9a-f]{64})/)?.[1] ?? null };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 140)}`;
const asCookie = (sessionId: string | null, csrf?: string): Record<string, string> =>
    ({ Cookie: `admin_session=${sessionId ?? ''}`, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) });
const refused = (r: Reply) => r.status === 403 && r.body?.code === PASSWORD_NEEDS_2FA_CODE
    && /two-factor/i.test(r.body?.error || '') && /automation token/i.test(r.body?.error || '');

function set2fa(on: boolean): void {
    updateLocalConfig(on
        ? { totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] }
        : { totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
}

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
/** The app's key sign-in over HTTP: challenge → signature → handshake token → exchange. */
async function keySignIn(k: Key): Promise<Reply> {
    const chal = await call('POST', '/api/local/admin/auth/challenge', { body: {} });
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        body: { challengeId: chal.body?.challengeId, memberPubkey: k.pub, signature: crypto.sign(null, Buffer.from(chal.body?.challenge ?? ''), k.priv).toString('hex') },
    });
    return call('POST', '/api/local/admin/auth/exchange', { body: { token: solved.body?.handshakeToken } });
}

/** Admin routes across the routers, reads and writes: the password alone must open none of them while 2FA is off. */
const ADMIN_ROUTES: Array<[string, string]> = [
    ['GET', '/api/local/admin/diagnostics'],
    ['POST', '/api/local/admin/ws-ticket'],
    ['GET', '/api/local/admin/reports'],
    ['POST', '/api/local/admin/announcements'],
    ['POST', '/api/local/admin/auth/break-glass-mode'],
    ['POST', '/api/local/admin/auth/break-glass/issue'],
    ['POST', '/api/local/admin/2fa/setup'],
    ['POST', '/api/local/admin/node/config'],
    ['POST', '/api/admin/thresholds/get'],
    ['POST', '/api/admin/seed-invite'],
    ['POST', '/api/local/change-password'],
    ['POST', '/api/local/admin/backup-status'],
    ['POST', '/api/local/admin/replication-token/status'],
    ['POST', '/api/local/admin/replication-token/generate'],
    ['GET', '/api/local/admin/automation-tokens'],
];

/** Every route that copies the X-Admin-Password header into a body password before checkAdminAuth. */
const HEADER_COPY_ROUTES: Array<[string, string]> = [
    ['GET', '/api/local/admin/backup-enroll'],
    ['GET', '/api/local/admin/snapshots/download?name=none.db'],
    ['POST', '/api/local/admin/restore'],
    ['GET', '/api/local/admin/offbox-backups/download?id=none'],
];

async function main(): Promise<void> {
    console.log('\n=== Step 7c: the admin password per request needs 2FA ===\n');

    const tmp = path.resolve(os.tmpdir()); // absolute: TMPDIR may be relative, and the suite changes directory
    const webRoot = fs.mkdtempSync(path.join(tmp, 'bp-pw-needs-2fa-'));
    fs.mkdirSync(path.join(webRoot, 'public', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    fs.writeFileSync(path.join(webRoot, 'public', 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, replicationTokenOnly: false });
    set2fa(false);
    setBreakGlassMode(false);

    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    try {
        // ── 1. 2FA off: the password per request is refused ───────────────────────────────────────────
        console.log('── 1. 2FA off: the header, the body and the break-glass header are refused ──');
        for (const [method, p] of ADMIN_ROUTES) {
            const h = await call(method, p, { headers: { 'X-Admin-Password': PW }, ...(method === 'POST' ? { body: {} } : {}) });
            assert(refused(h), `X-Admin-Password: ${method} ${p} → 403 ${PASSWORD_NEEDS_2FA_CODE} (${show(h)})`);
        }
        for (const [method, p] of ADMIN_ROUTES.filter(([m]) => m === 'POST')) {
            const b = await call(method, p, { body: { password: PW } });
            assert(refused(b), `body password: ${method} ${p} → 403 ${PASSWORD_NEEDS_2FA_CODE} (${show(b)})`);
        }
        // revoke-all falls back to a member's signature when checkAdminAuth says no, and answers with that path's 401.
        const revokeAll = await call('POST', '/api/local/admin/auth/revoke-all', { headers: { 'X-Admin-Password': PW }, body: {} });
        assert(revokeAll.status === 401 || refused(revokeAll), `X-Admin-Password: POST auth/revoke-all is refused (${show(revokeAll)})`);
        const bg = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Break-Glass-Code': PW } });
        assert(refused(bg), `the password in X-Break-Glass-Code → 403 ${PASSWORD_NEEDS_2FA_CODE} (${show(bg)})`);
        const bodyBg = await call('POST', '/api/local/admin/ws-ticket', { body: { breakGlassCode: PW } });
        assert(refused(bodyBg), `the password as a body breakGlassCode → 403 ${PASSWORD_NEEDS_2FA_CODE} (${show(bodyBg)})`);
        for (const [method, p] of HEADER_COPY_ROUTES) {
            const r = await call(method, p, { headers: { 'X-Admin-Password': PW, ...(method === 'POST' ? { 'Content-Type': 'application/octet-stream' } : {}) }, ...(method === 'POST' ? { raw: Buffer.from('not a backup') } : {}) });
            assert(refused(r), `header copied to the body: ${method} ${p} → 403 ${PASSWORD_NEEDS_2FA_CODE} (${show(r)})`);
        }
        const wrong = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Admin-Password': 'not-the-password' } });
        assert(wrong.status === 401 && wrong.body?.error === 'Invalid password', `a wrong password is still 401 Invalid password (${show(wrong)})`);
        const code = issueBreakGlassCode(owner.pub, 'test');
        const codeOff = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Break-Glass-Code': code } });
        assert(codeOff.status === 401, `a real break-glass code off the enrol routes is still a wrong password (${show(codeOff)})`);

        // ── 2. What still takes it ────────────────────────────────────────────────────────────────────
        console.log('── 2. sign-in, verify-password and break-glass enrol still work ──');
        const signIn = await call('POST', '/api/local/admin/auth/password', { body: { password: PW } });
        assert(signIn.status === 200 && !!signIn.sessionId && signIn.body?.totpSetupRequired === true,
            `the password sign-in opens a session held to the 2FA card (${show(signIn)})`);
        const verify = await call('POST', '/api/local/verify-password', { body: { password: PW } });
        assert(verify.status === 200 && verify.body?.success === true, `verify-password still answers (${show(verify)})`);
        const newKey = keypair();
        seedGenesisMember(newKey.pub, 'Nia');
        const pwEnrol = await call('POST', '/api/local/admin/auth/break-glass/enrol', { body: { password: PW, memberPubkey: newKey.pub, role: 'owner' } });
        assert(refused(pwEnrol), `the password alone does not enrol an owner key (${show(pwEnrol)})`);
        const codeEnrol = await call('POST', '/api/local/admin/auth/break-glass/enrol', { headers: { 'X-Break-Glass-Code': code }, body: { memberPubkey: newKey.pub, role: 'owner' } });
        assert(codeEnrol.status === 200 && codeEnrol.body?.success === true, `a break-glass code enrols an owner key: it is the recovery factor (${show(codeEnrol)})`);

        // ── 3. A legacy standby's copy route ─────────────────────────────────────────────────────────
        console.log('── 3. the copy routes take the password while token-only is off ──');
        const copy = await call('GET', '/api/local/admin/sync-snapshot', { headers: { 'X-Admin-Password': PW } });
        // Past the auth this harness has no ledger file to export (500): what matters is that the password got in.
        assert(copy.status !== 401 && copy.status !== 403, `GET sync-snapshot with the password, token-only off, gets past the auth (${copy.status})`);
        updateLocalConfig({ replicationTokenOnly: true });
        const copyTokenOnly = await call('GET', '/api/local/admin/sync-snapshot', { headers: { 'X-Admin-Password': 'another-string-not-remembered' } });
        assert(copyTokenOnly.status === 401 && /replication token required/i.test(copyTokenOnly.body?.error || ''), `with token-only on it is refused, as before (${show(copyTokenOnly)})`);
        updateLocalConfig({ replicationTokenOnly: false });

        // ── 4. A key session and an automation token ─────────────────────────────────────────────────
        console.log('── 4. a key session and an automation token are unaffected ──');
        const k = await keySignIn(owner);
        assert(k.status === 200 && !!k.sessionId, `the owner's key signs in (${show(k)})`);
        const kDiag = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(k.sessionId) });
        assert(kDiag.status === 200, `a key session opens an admin read (${show(kDiag)})`);
        const kTicket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(k.sessionId, k.body?.csrfToken) });
        assert(kTicket.status === 200, `…and a change (${show(kTicket)})`);
        const made = await call('POST', '/api/local/admin/automation-tokens', { body: { name: 'fleet', scope: 'admin' }, headers: asCookie(k.sessionId, k.body?.csrfToken) });
        assert(made.status === 201 && typeof made.body?.token === 'string', `the owner's key makes an automation token (${show(made)})`);
        const tDiag = await call('GET', '/api/local/admin/diagnostics', { headers: { Authorization: `Bearer ${made.body?.token}` } });
        assert(tDiag.status === 200, `the token opens an admin read with 2FA off (${show(tDiag)})`);
        const tChange = await call('POST', '/api/local/admin/announcements', { body: { message: 'Hall open at 6', type: 'info' }, headers: { Authorization: `Bearer ${made.body?.token}` } });
        assert(tChange.status !== 401 && tChange.status !== 403, `…and an admin change (${show(tChange)})`);

        // ── 5. 2FA on: unchanged ──────────────────────────────────────────────────────────────────────
        console.log('── 5. 2FA on: the header + a code works, as before ──');
        set2fa(true);
        const alone = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Admin-Password': PW } });
        assert(alone.status === 401 && alone.body?.totpRequired === true, `the header alone → 401 totpRequired, as before (${show(alone)})`);
        const withCode = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Admin-Password': PW, 'X-Admin-TOTP': generateTotpCode(SECRET) } });
        assert(withCode.status === 200, `the header + a code → 200 (${show(withCode)})`);
        const bodyCode = await call('POST', '/api/local/admin/ws-ticket', { body: { password: PW, totpCode: generateTotpCode(SECRET) } });
        assert(bodyCode.status === 200, `a body password + code → 200 (${show(bodyCode)})`);
        const login = await call('POST', '/api/local/verify-password', { body: { password: PW, totpCode: generateTotpCode(SECRET) } });
        const tfa: string = login.body?.tfaSessionToken ?? '';
        assert(login.status === 200 && !!tfa, `verify-password + code hands out a 2FA session (${show(login)})`);
        const viaSession = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: { 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfa } });
        assert(viaSession.status === 200, `the header + that 2FA session → 200 (${show(viaSession)})`);
        const enrolCode = await call('GET', '/api/local/admin/backup-enroll', { headers: { 'X-Admin-Password': PW, 'X-Admin-TOTP': generateTotpCode(SECRET) } });
        assert(enrolCode.status !== 401 && enrolCode.status !== 403, `a header-copy route with the code is not refused (${show(enrolCode)})`);
    } finally {
        process.chdir(tmp);
        fs.rmSync(webRoot, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
