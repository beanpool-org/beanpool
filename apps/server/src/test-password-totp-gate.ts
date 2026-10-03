/**
 * Node sign-in, design step 6 (D3): a second factor is mandatory on the PASSWORD path, as a soft gate. Over REAL HTTPS
 * through the real middleware; nothing here contacts anything but the server it starts.
 *
 *   1. With the node's 2FA off, a password session (POST /api/local/admin/auth/password) says so at sign-in and after
 *      a reload (`totpSetupRequired`), and every admin route but the 2FA setup ones answers 403 totp_setup_required.
 *      The refusal ends nothing: the session stays signed in.
 *   2. The 2FA card's routes open: status, a CSRF token, setup (with its eight backup codes), and verify.
 *   3. Confirming a code lifts the gate at once, in the same session (no new sign-in).
 *   4. A key session on a node with 2FA off is never gated, and the per-request X-Admin-Password header is not gated
 *      yet (a legacy standby's pull and the fleet profiles send it; step 7 moves them onto owner tokens).
 *   5. With 2FA on, a password sign-in (with its code) is not gated. Turning 2FA off again holds the password session
 *      that did it to the card once more.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-password-totp-gate" node ../../scripts/run-server-suites.mjs
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
import { resetAdminAuthTarpit, TOTP_SETUP_REQUIRED_CODE } from './admin-auth.js';
import { validateAdminSession } from './admin-key-auth.js';

let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const PW = 'PasswordTotpGate1!';
const SECRET = generateTotpSecret();

interface Reply { status: number; body: any; text: string; sessionId: string | null }

async function call(method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
    forgetUsedTotpCodesForTests();
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
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 140)}`;
const asCookie = (sessionId: string | null, csrf?: string): Record<string, string> =>
    ({ Cookie: `admin_session=${sessionId ?? ''}`, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) });

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

/** Admin routes across the routers, each behind checkAdminAuth: a gated password session must get none of them. */
const GATED: Array<[string, string]> = [
    ['GET', '/api/local/admin/diagnostics'],
    ['POST', '/api/local/admin/ws-ticket'],
    ['GET', '/api/local/admin/reports'],
    ['POST', '/api/local/admin/announcements'],
    ['POST', '/api/local/admin/auth/break-glass-mode'],
    ['POST', '/api/local/admin/auth/enrol'],
    ['POST', '/api/local/admin/2fa/disable'],
    ['POST', '/api/local/admin/node/config'],
    ['POST', '/api/admin/thresholds/get'],
    ['POST', '/api/admin/seed-invite'],
    ['POST', '/api/local/change-password'],
    ['POST', '/api/local/admin/backup-status'],
    ['POST', '/api/local/admin/replication-token/generate'],
];

async function main(): Promise<void> {
    console.log('\n=== Step 6: the admin password needs a second factor (soft gate) ===\n');

    const tmp = path.resolve(os.tmpdir()); // absolute: TMPDIR may be relative, and the suite changes directory
    const webRoot = fs.mkdtempSync(path.join(tmp, 'bp-totp-gate-'));
    fs.mkdirSync(path.join(webRoot, 'public', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    fs.writeFileSync(path.join(webRoot, 'public', 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt });
    set2fa(false);
    setBreakGlassMode(false);

    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    try {
        // ── 1. 2FA off: the password session is held to the 2FA card ─────────────────────────────────
        console.log('── 1. 2FA off: a password session reaches the 2FA card only ──');
        resetAdminAuthTarpit();
        const a = await call('POST', '/api/local/admin/auth/password', { body: { password: PW } });
        assert(a.status === 200 && !!a.sessionId, `the password still signs in: the node is not locked out (${show(a)})`);
        assert(a.body?.totpSetupRequired === true, `the sign-in says the 2FA card comes first (${a.text.slice(0, 160)})`);
        const csrf: string = a.body?.csrfToken ?? '';
        const who = await call('GET', '/api/local/admin/auth/session', { headers: asCookie(a.sessionId) });
        assert(who.body?.isPasswordSession === true && who.body?.totpSetupRequired === true,
            `after a reload the session says so too (${who.text.slice(0, 160)})`);

        for (const [method, p] of GATED) {
            const r = await call(method, p, { headers: asCookie(a.sessionId, csrf), ...(method === 'POST' ? { body: {} } : {}) });
            assert(r.status === 403 && r.body?.code === TOTP_SETUP_REQUIRED_CODE && r.body?.totpSetupRequired === true
                && /two-factor/i.test(r.body?.error || ''),
                `${method} ${p} → 403 ${TOTP_SETUP_REQUIRED_CODE} (${show(r)})`);
        }
        assert(validateAdminSession(a.sessionId!).valid, 'the refusals end nothing: the session is still signed in');

        // ── 2. The card's own routes open ─────────────────────────────────────────────────────────────
        console.log('── 2. the 2FA card opens ──');
        const status = await call('GET', '/api/local/admin/2fa/status', { headers: asCookie(a.sessionId) });
        assert(status.status === 200 && status.body?.totpEnabled === false, `2FA status → 200, off (${show(status)})`);
        const fresh = await call('POST', '/api/local/admin/csrf-token', { body: {}, headers: asCookie(a.sessionId) });
        assert(fresh.status === 200 && typeof fresh.body?.csrfToken === 'string', `a reload's CSRF token → 200 (${show(fresh)})`);
        const setup = await call('POST', '/api/local/admin/2fa/setup', { body: {}, headers: asCookie(a.sessionId, csrf) });
        assert(setup.status === 200 && typeof setup.body?.secret === 'string', `2FA setup → 200 with a secret (${setup.status})`);
        assert(Array.isArray(setup.body?.backupCodes) && setup.body.backupCodes.length === 8, 'and the eight backup codes, shown at setup');
        const wrong = await call('POST', '/api/local/admin/2fa/verify', { body: { code: '000000' === generateTotpCode(setup.body.secret) ? '111111' : '000000' }, headers: asCookie(a.sessionId, csrf) });
        assert(wrong.status === 400, `a wrong confirm code → 400 (${show(wrong)})`);
        const stillGated = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(a.sessionId) });
        assert(stillGated.status === 403 && stillGated.body?.code === TOTP_SETUP_REQUIRED_CODE, `…and the gate stays (${show(stillGated)})`);

        // ── 3. Confirming lifts the gate in the same session ──────────────────────────────────────────
        console.log('── 3. a confirmed code opens Settings at once ──');
        const verify = await call('POST', '/api/local/admin/2fa/verify', { body: { code: generateTotpCode(setup.body.secret) }, headers: asCookie(a.sessionId, csrf) });
        assert(verify.status === 200 && verify.body?.totpEnabled === true, `the right code → 2FA on (${show(verify)})`);
        const diag = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(a.sessionId) });
        assert(diag.status === 200, `the same session now opens an admin read, no new sign-in (${show(diag)})`);
        const ticket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(a.sessionId, csrf) });
        assert(ticket.status === 200, `and an admin change with its CSRF token (${show(ticket)})`);
        const who2 = await call('GET', '/api/local/admin/auth/session', { headers: asCookie(a.sessionId) });
        assert(who2.body?.totpSetupRequired === false, `the session no longer says the card comes first (${who2.text.slice(0, 160)})`);

        // ── 4. Keys are never gated; the per-request header is not gated yet ─────────────────────────
        console.log('── 4. key sessions and the header path ──');
        set2fa(false);
        const k = await keySignIn(owner);
        assert(k.status === 200 && !!k.sessionId, `an owner's key signs in on a node with 2FA off (${show(k)})`);
        const kDiag = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(k.sessionId) });
        assert(kDiag.status === 200, `a key session is never held to the 2FA card (${show(kDiag)})`);
        const kTicket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(k.sessionId, k.body?.csrfToken) });
        assert(kTicket.status === 200, `…a change too (${show(kTicket)})`);
        const kWho = await call('GET', '/api/local/admin/auth/session', { headers: asCookie(k.sessionId) });
        assert(kWho.body?.isKeySession === true && kWho.body?.totpSetupRequired === undefined, `and its session never mentions the card (${kWho.text.slice(0, 160)})`);
        const header = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Admin-Password': PW } });
        assert(header.status === 200, `X-Admin-Password on each request is not gated yet (step 7 moves its callers) (${show(header)})`);

        // ── 5. 2FA on: nothing changes; turning it off holds that session to the card again ───────────
        console.log('── 5. 2FA on ──');
        set2fa(true);
        resetAdminAuthTarpit();
        const b = await call('POST', '/api/local/admin/auth/password', { body: { password: PW, totpCode: generateTotpCode(SECRET) } });
        assert(b.status === 200 && b.body?.totpSetupRequired === false, `with 2FA on the password + code signs in, not gated (${b.text.slice(0, 160)})`);
        const bDiag = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(b.sessionId) });
        assert(bDiag.status === 200, `and opens Settings (${show(bDiag)})`);
        const off = await call('POST', '/api/local/admin/2fa/disable', { body: { code: generateTotpCode(SECRET) }, headers: asCookie(b.sessionId, b.body?.csrfToken) });
        assert(off.status === 200, `the owner turns 2FA off with a current code (${show(off)})`);
        const bAfter = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(b.sessionId) });
        assert(bAfter.status === 403 && bAfter.body?.code === TOTP_SETUP_REQUIRED_CODE,
            `that password session is held to the 2FA card again (${show(bAfter)})`);
        const bStatus = await call('GET', '/api/local/admin/2fa/status', { headers: asCookie(b.sessionId) });
        assert(bStatus.status === 200, `while the card itself still opens (${show(bStatus)})`);
    } finally {
        process.chdir(tmp);
        fs.rmSync(webRoot, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
