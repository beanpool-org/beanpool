/**
 * Node sign-in, design step 10 (D1(c), D6): an owner retires the admin password for good. Over REAL HTTPS through the
 * real middleware; nothing here contacts anything but the server it starts.
 *
 *   1. Who may retire it: an owner's key session only. The password (session, header + code), an admin's key, a
 *      moderator's key and an automation token are refused, and nothing changes.
 *   2. An owner with no break-glass code is sent to make one first; one owner without "I accept one owner" is refused;
 *      with it the password is retired, and the log says the owner accepted being the only owner.
 *   3. After it: the header, the body password, the password sign-in, verify-password, change-password (a key session's
 *      too) and ws tickets answer 403 password_retired; the live password session, its 2FA session and the log stream it
 *      opened end at once; /api/local/status says passwordRetired; the community got a critical announcement.
 *   4. Still works: the owner's key, a break-glass code on the enrol route (the recovery factor).
 *   5. A start with ADMIN_PASSWORD in .env keeps it retired (the hash stays gone, the password still refused), and so
 *      does Wipe & Reset.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-retire-admin-password" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ADMIN_PASSWORD;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, addWsClient, removeWsClient } from './state-engine.js';
import { db } from './db/db.js';
import { updateLocalConfig, getLocalConfig, hashPassword, setBreakGlassMode, initAdminPassword } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, forgetUsedTotpCodesForTests } from './totp.js';
import { resetAdminAuthTarpit, PASSWORD_RETIRED_CODE } from './admin-auth.js';
import { issueBreakGlassCode, retireBreakGlassCode } from './admin-key-auth.js';
import { logger } from './logger.js';

let BASE = '', WSS = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const PW = 'RetireThePassword1!';
const SECRET = generateTotpSecret();

interface Reply { status: number; body: any; text: string; sessionId: string | null; csrf: string | null }

async function call(method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
    forgetUsedTotpCodesForTests();
    resetAdminAuthTarpit();
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
    return { status: res.status, body, text, sessionId: cookie.match(/^admin_session=([0-9a-f]{64})/)?.[1] ?? null, csrf: body?.csrfToken ?? null };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 160)}`;
const asCookie = (sessionId: string | null, csrf?: string | null): Record<string, string> =>
    ({ Cookie: `admin_session=${sessionId ?? ''}`, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) });
const retiredRefusal = (r: Reply) => r.status === 403 && r.body?.code === PASSWORD_RETIRED_CODE && r.body?.passwordRetired === true
    && /retired/i.test(r.body?.error || '') && /beanpool recover/.test(r.body?.error || '') && /break-glass/.test(r.body?.error || '');

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
function seedMember(callsign: string): Key {
    const k = keypair();
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(k.pub, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(k.pub);
    return k;
}
/** The app's key sign-in over HTTP: challenge → signature → handshake token → exchange. */
async function keySignIn(k: Key): Promise<Reply> {
    const chal = await call('POST', '/api/local/admin/auth/challenge', { body: {} });
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        body: { challengeId: chal.body?.challengeId, memberPubkey: k.pub, signature: crypto.sign(null, Buffer.from(chal.body?.challenge ?? ''), k.priv).toString('hex') },
    });
    return call('POST', '/api/local/admin/auth/exchange', { body: { token: solved.body?.handshakeToken } });
}

interface LogSocket { ws: WebSocket; closed: Promise<{ code: number }> }
function openLogs(ticket: string): Promise<LogSocket | number> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${WSS}/ws/logs?ticket=${ticket}`, { rejectUnauthorized: false });
        const closed = new Promise<{ code: number }>(r => ws.on('close', code => r({ code })));
        ws.on('open', () => resolve({ ws, closed }));
        ws.on('unexpected-response', (req, res) => { resolve(res.statusCode ?? 0); req.destroy(); });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 3000);
    });
}

async function main(): Promise<void> {
    console.log('\n=== Step 10: retire the admin password ===\n');

    const tmp = path.resolve(os.tmpdir()); // absolute: TMPDIR may be relative, and the suite changes directory
    const webRoot = fs.mkdtempSync(path.join(tmp, 'bp-retire-pw-'));
    fs.mkdirSync(path.join(webRoot, 'public', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    fs.writeFileSync(path.join(webRoot, 'public', 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const admin = seedMember('Ada');
    const moderator = seedMember('Mo');
    grantNodeRole(admin.pub, 'admin', owner.pub);
    grantNodeRole(moderator.pub, 'moderator', owner.pub);
    const { hash, salt } = hashPassword(PW);
    // 2FA on, so a password session opens every admin route (not held to the 2FA card) and can open a log stream.
    updateLocalConfig({ adminHash: hash, salt, isLocked: true, replicationTokenOnly: false, totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: [] });
    setBreakGlassMode(false);

    const securityLines: string[] = [];
    const origSecurity = logger.security.bind(logger);
    (logger as any).security = (tag: string, msg: string, ...rest: unknown[]) => { securityLines.push(msg); return (origSecurity as any)(tag, msg, ...rest); };

    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    WSS = `wss://localhost:${port}`;
    const code = () => generateTotpCode(SECRET);

    try {
        // ── 1. Who may retire it ──────────────────────────────────────────────────────────────────────
        console.log('── 1. only an owner\'s key session may retire the password ──');
        const pwSession = await call('POST', '/api/local/admin/auth/password', { body: { password: PW, totpCode: code() } });
        assert(pwSession.status === 200 && !!pwSession.sessionId, `the password + code opens a password session (${show(pwSession)})`);
        const byPwSession = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: true }, headers: asCookie(pwSession.sessionId, pwSession.csrf) });
        assert(byPwSession.status === 403 && byPwSession.body?.code === 'owner_key_required', `a password session cannot retire the password (${show(byPwSession)})`);
        const byHeader = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: true }, headers: { 'X-Admin-Password': PW, 'X-Admin-TOTP': code() } });
        assert(byHeader.status === 403 && byHeader.body?.code === 'owner_key_required', `the password + code per request cannot (${show(byHeader)})`);
        const a = await keySignIn(admin);
        const byAdmin = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: true }, headers: asCookie(a.sessionId, a.csrf) });
        assert(byAdmin.status === 403, `an admin's key cannot (${show(byAdmin)})`);
        const m = await keySignIn(moderator);
        const byMod = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: true }, headers: asCookie(m.sessionId, m.csrf) });
        assert(byMod.status === 403, `a moderator's key cannot (${show(byMod)})`);
        const o = await keySignIn(owner);
        assert(o.status === 200 && !!o.sessionId, `the owner's key signs in (${show(o)})`);
        const made = await call('POST', '/api/local/admin/automation-tokens', { body: { name: 'fleet', scope: 'admin' }, headers: asCookie(o.sessionId, o.csrf) });
        assert(made.status === 201 && typeof made.body?.token === 'string', `the owner makes an automation token (${show(made)})`);
        const byToken = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: true }, headers: { Authorization: `Bearer ${made.body?.token}` } });
        assert(byToken.status === 403, `an automation token cannot (${show(byToken)})`);
        assert(!getLocalConfig().passwordRetired && !!getLocalConfig().adminHash, 'none of those changed anything');

        // ── 2. The break-glass code and the one-owner tick ────────────────────────────────────────────
        console.log('── 2. a break-glass code first; one owner needs the tick ──');
        retireBreakGlassCode(owner.pub);
        const noCode = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: true }, headers: asCookie(o.sessionId, o.csrf) });
        assert(noCode.status === 409 && noCode.body?.code === 'break_glass_code_needed', `an owner with no break-glass code is sent to make one (${show(noCode)})`);
        const madeCode = await call('POST', '/api/local/admin/auth/break-glass/issue', { body: {}, headers: asCookie(o.sessionId, o.csrf) });
        assert(madeCode.status === 200 && typeof madeCode.body?.breakGlassCode === 'string', `Settings makes the owner's break-glass code (${show(madeCode)})`);
        const view = await call('GET', '/api/local/admin/auth/password-retirement', { headers: asCookie(o.sessionId) });
        assert(view.status === 200 && view.body?.passwordRetired === false && view.body?.owners === 1 && view.body?.hasBreakGlassCode === true,
            `the card's read: not retired, one owner, a code held (${show(view)})`);
        const viewAdmin = await call('GET', '/api/local/admin/auth/password-retirement', { headers: asCookie(a.sessionId) });
        assert(viewAdmin.status === 403, `an admin cannot read it (${show(viewAdmin)})`);
        const oneOwner = await call('POST', '/api/local/admin/auth/retire-password', { body: {}, headers: asCookie(o.sessionId, o.csrf) });
        assert(oneOwner.status === 409 && oneOwner.body?.code === 'one_owner' && oneOwner.body?.owners === 1, `one owner without the tick is refused (${show(oneOwner)})`);
        const notTrue = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: 'yes' }, headers: asCookie(o.sessionId, o.csrf) });
        assert(notTrue.status === 409 && notTrue.body?.code === 'one_owner', `only acceptOneOwner: true counts as the tick (${show(notTrue)})`);
        assert(!getLocalConfig().passwordRetired, 'still not retired');

        // A live password session, its log stream and a 2FA session, opened before the retirement.
        const pwTicket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(pwSession.sessionId, pwSession.csrf) });
        assert(pwTicket.status === 200 && typeof pwTicket.body?.ticket === 'string', `the password session gets a ws ticket (${show(pwTicket)})`);
        const pwLogs = await openLogs(pwTicket.body.ticket);
        assert(typeof pwLogs !== 'number', 'the password session opens a log stream');
        const spareTicket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(pwSession.sessionId, pwSession.csrf) });
        const tfa = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Admin-Password': PW, 'X-Admin-TOTP': code() } });
        const tfaToken: string | undefined = tfa.body?.tfaSessionToken ?? undefined;
        const kTicket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(o.sessionId, o.csrf) });
        const keyLogs = await openLogs(kTicket.body?.ticket ?? '');
        assert(typeof keyLogs !== 'number', "the owner's key session opens a log stream");

        const memberEvents: any[] = [];
        const memberWs = { _memberPubkey: moderator.pub, _memberFeed: true, send: (d: string) => { try { memberEvents.push(JSON.parse(d)); } catch { /* not json */ } } };
        addWsClient(memberWs);
        securityLines.length = 0;
        const retired = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: true }, headers: asCookie(o.sessionId, o.csrf) });
        assert(retired.status === 200 && retired.body?.passwordRetired === true && retired.body?.retiredByCallsign === 'Olive' && retired.body?.acceptedOneOwner === true,
            `one owner with the tick retires the password (${show(retired)})`);
        assert(securityLines.some(l => /retired for good by Olive/.test(l) && /accepted being the only owner/.test(l)), `the log says who, and that they accepted one owner (${securityLines.join(' | ')})`);
        const cfg = getLocalConfig();
        assert(!cfg.adminHash && !cfg.salt && !cfg.totpSecret && !cfg.totpEnabled, 'the hash, the salt and the 2FA that guarded the password are gone');
        assert(cfg.passwordRetired?.by === owner.pub && typeof cfg.passwordRetired?.at === 'number', 'local-config records when and by whom');
        const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR || path.join(webRoot, 'data'), 'local-config.json'), 'utf-8'));
        assert(!!onDisk.passwordRetired && !onDisk.adminHash, 'and so does the file on disk');
        assert(memberEvents.some(e => e.type === 'system_announcement' && e.title === 'Admin Password Retired' && e.severity === 'critical' && /Olive/.test(e.body)),
            `the community gets a critical announcement (${JSON.stringify(memberEvents).slice(0, 200)})`);
        removeWsClient(memberWs);

        // ── 3. Every password path refused; live password sessions end ────────────────────────────────
        console.log('── 3. after it, every password path is refused ──');
        if (typeof pwLogs !== 'number') {
            const closed = await Promise.race([pwLogs.closed, sleep(2000).then(() => null)]);
            assert(!!closed, 'the log stream the password session opened closes at once');
        }
        if (typeof keyLogs !== 'number') {
            await sleep(200);
            assert(keyLogs.ws.readyState === WebSocket.OPEN, "the owner's key-session stream stays open");
            keyLogs.ws.terminate();
        }
        const spare = await openLogs(spareTicket.body?.ticket ?? '');
        assert(spare === 401, `a ticket the password session got before is refused (${typeof spare === 'number' ? spare : 'open'})`);
        if (typeof spare !== 'number') spare.ws.terminate();
        const oldSession = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(pwSession.sessionId) });
        assert(oldSession.status === 401, `the live password session has ended (${show(oldSession)})`);
        if (tfaToken) {
            const oldTfa = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfaToken } });
            assert(retiredRefusal(oldTfa), `the password with its 2FA session is refused (${show(oldTfa)})`);
        }
        for (const [method, p] of [['GET', '/api/local/admin/diagnostics'], ['POST', '/api/local/admin/ws-ticket'], ['POST', '/api/local/admin/announcements'], ['POST', '/api/local/admin/auth/break-glass-mode']] as const) {
            const h = await call(method, p, { headers: { 'X-Admin-Password': PW, 'X-Admin-TOTP': code() }, ...(method === 'POST' ? { body: {} } : {}) });
            assert(retiredRefusal(h), `X-Admin-Password: ${method} ${p} → 403 ${PASSWORD_RETIRED_CODE} (${show(h)})`);
        }
        const bodyPw = await call('POST', '/api/local/admin/ws-ticket', { body: { password: PW, totpCode: code() } });
        assert(retiredRefusal(bodyPw), `a body password → 403 ${PASSWORD_RETIRED_CODE} (${show(bodyPw)})`);
        const wrongPw = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Admin-Password': 'any-other-string' } });
        assert(retiredRefusal(wrongPw), `any string at all gets the same answer (${show(wrongPw)})`);
        const signIn = await call('POST', '/api/local/admin/auth/password', { body: { password: PW, totpCode: code() } });
        assert(retiredRefusal(signIn) && !signIn.sessionId, `the password sign-in is refused (${show(signIn)})`);
        const signInEmpty = await call('POST', '/api/local/admin/auth/password', { body: {} });
        assert(retiredRefusal(signInEmpty), `…even with nothing typed, so the page knows (${show(signInEmpty)})`);
        const verify = await call('POST', '/api/local/verify-password', { body: { password: PW, totpCode: code() } });
        assert(retiredRefusal(verify), `verify-password is refused (${show(verify)})`);
        const change = await call('POST', '/api/local/change-password', { body: { currentPassword: PW, newPassword: 'A-New-Password-99!' } });
        assert(retiredRefusal(change), `change-password with the password is refused (${show(change)})`);
        const changeByKey = await call('POST', '/api/local/change-password', { body: { newPassword: 'A-New-Password-99!' }, headers: asCookie(o.sessionId, o.csrf) });
        assert(retiredRefusal(changeByKey) && !getLocalConfig().adminHash, `no route sets a password again, an owner's key included (${show(changeByKey)})`);
        const again = await call('POST', '/api/local/admin/auth/retire-password', { body: { acceptOneOwner: true }, headers: asCookie(o.sessionId, o.csrf) });
        assert(again.status === 409 && again.body?.passwordRetired === true, `retiring twice answers 409 (${show(again)})`);
        const status = await call('GET', '/api/local/status');
        assert(status.status === 200 && status.body?.passwordRetired === true, `/api/local/status says passwordRetired (${show(status)})`);
        const view2 = await call('GET', '/api/local/admin/auth/password-retirement', { headers: asCookie(o.sessionId) });
        assert(view2.body?.passwordRetired === true && view2.body?.retiredByCallsign === 'Olive' && typeof view2.body?.retiredAt === 'number', `the card reads who and when (${show(view2)})`);

        // ── 4. What still works ───────────────────────────────────────────────────────────────────────
        console.log('── 4. keys, tokens and break-glass still work ──');
        const kDiag = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(o.sessionId) });
        assert(kDiag.status === 200, `the owner's key session opens admin routes (${show(kDiag)})`);
        const tDiag = await call('GET', '/api/local/admin/diagnostics', { headers: { Authorization: `Bearer ${made.body?.token}` } });
        assert(tDiag.status === 200, `the automation token still works (${show(tDiag)})`);
        const newOwner = seedMember('Nia');
        const codeEnrol = await call('POST', '/api/local/admin/auth/break-glass/enrol', { headers: { 'X-Break-Glass-Code': madeCode.body.breakGlassCode }, body: { memberPubkey: newOwner.pub, role: 'owner' } });
        assert(codeEnrol.status === 200 && codeEnrol.body?.success === true, `a break-glass code enrols an owner key: it is the recovery factor (${show(codeEnrol)})`);
        const codeOff = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Break-Glass-Code': madeCode.body.breakGlassCode } });
        assert(codeOff.status === 403 || codeOff.status === 401, `a break-glass code off the enrol routes opens nothing (${show(codeOff)})`);

        // ── 5. A start with ADMIN_PASSWORD in .env, and Wipe & Reset ──────────────────────────────────
        console.log('── 5. ADMIN_PASSWORD in .env and Wipe & Reset never bring it back ──');
        process.env.ADMIN_PASSWORD = 'Brought-Back-By-Env-1!';
        const lines: string[] = [];
        const origLog = console.log;
        console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
        try { initAdminPassword(); } finally { console.log = origLog; }
        assert(lines.some(l => /retired/.test(l) && /ADMIN_PASSWORD/.test(l) && /ignored/.test(l)), `the start logs one line saying ADMIN_PASSWORD is ignored (${lines.join(' | ')})`);
        assert(!getLocalConfig().adminHash && !!getLocalConfig().passwordRetired, 'the hash stays gone');
        const envPw = await call('GET', '/api/local/admin/diagnostics', { headers: { 'X-Admin-Password': 'Brought-Back-By-Env-1!' } });
        assert(retiredRefusal(envPw), `the .env password is refused (${show(envPw)})`);
        const k2 = await keySignIn(owner);
        const reset = await call('POST', '/api/local/reset', { body: {}, headers: asCookie(k2.sessionId, k2.csrf) });
        assert(reset.status === 200, `the owner wipes and resets (${show(reset)})`);
        assert(!!getLocalConfig().passwordRetired, 'Wipe & Reset keeps the password retired');
        try { initAdminPassword(); } catch { /* asserted below */ }
        assert(!getLocalConfig().adminHash, 'and the start after it takes no ADMIN_PASSWORD');
        delete process.env.ADMIN_PASSWORD;
    } finally {
        (logger as any).security = origSecurity;
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
