/**
 * The web manager's admin sign-in and the admin surface's edges (Fable's web review, scratch/reviews/FABLE-sec-web.md:
 * M1, M2, L3–L6), over REAL HTTPS through the real middleware. Nothing here contacts anything but the server it starts.
 *
 *   1. M1, the password sign-in: POST /api/local/admin/auth/password checks the password once (2FA included) and
 *      answers an httpOnly, SameSite=Strict admin_session cookie and a CSRF token; the body carries neither the
 *      password nor the session's id, and no 2FA session is handed out. The cookie alone then opens the admin routes
 *      (mutations with the CSRF token), survives a reload (/auth/session, a fresh CSRF token), and ends with sign-out.
 *      A new sign-in ends the browser's old session. Turning 2FA on ends every password session opened without it;
 *      turning it off (or changing the password) ends every other password session but keeps the one that did it.
 *      In break-glass mode the password opens no session and an open one ends.
 *  1b. The node, not the browser, ends a session: the cookie has no Max-Age, so at 12 h, 2 h idle (15 min for the phone
 *      hand-off) the node answers `sessionExpired` with the reason. A request with nothing (no cookie, no password)
 *      is answered at once, `sessionExpired`, and not counted by the admin tarpit.
 *   2. L3: the key sign-in's exchange answers the session in the cookie only (HttpOnly, SameSite=Strict), and so
 *      does /settings?token=.
 *   3. L4: a CSRF token counts only for the session it was issued to: a moderator's on an owner's cookie, another
 *      password session's, or one issued to a password caller, is refused; a session's tokens go with it.
 *   4. L5: /ws/logs takes a ticket only; the admin password in its query string (`?auth=`) is refused, 2FA off too.
 *   5. L6: an origin listed in corsAllowedOrigins gets credentialed CORS on the member API, never on the admin surface
 *      (the price-report queue included, which the admin IP allowlist also guards).
 *   6. M2: Settings (the manager) is served under the web app's strict policy, every way it is reached; the old
 *      static page at /settings-legacy keeps its own.
 *
 * The node serves a stand-in manager from a temporary public/ folder (process.chdir before https-server loads).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-web-manager-hardening.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole } from './state-engine.js';
import { db } from './db/db.js';
import { updateLocalConfig, hashPassword, setBreakGlassMode, updateGatewayConfig } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, forgetUsedTotpCodesForTests } from './totp.js';
import { resetAdminAuthTarpit, validateCsrfToken } from './admin-auth.js';
import { mintHandshakeToken, createPasswordSession, validateAdminSession, revokeAdminSession, MAX_PASSWORD_SESSIONS } from './admin-key-auth.js';
import { APP_DOCUMENT_CSP, DOCUMENT_CSP } from './app-document-csp.js';

let PORT = 0;
let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const PW = 'WebManagerHardening1!';
const NEW_PW = 'WebManagerHardening2!';
const SECRET = generateTotpSecret();
const LISTED = 'https://listed.example';

interface Reply { status: number; body: any; text: string; headers: Headers; cookie: string; sessionId: string | null }

async function call(method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
    forgetUsedTotpCodesForTests(); // A code is accepted once (totp.ts useTotpCode, test-storm-smalls); this suite signs in more than once a step.
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
    const sessionId = cookie.match(/^admin_session=([0-9a-f]{64})/)?.[1] ?? null;
    return { status: res.status, body, text, headers: res.headers, cookie, sessionId };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 140)}`;
const asCookie = (sessionId: string | null, csrf?: string): Record<string, string> =>
    ({ Cookie: `admin_session=${sessionId ?? ''}`, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) });

/** What Settings' sign-in card sends. */
function signIn(password: string, totpCode?: string, headers: Record<string, string> = {}): Promise<Reply> {
    return call('POST', '/api/local/admin/auth/password', { body: { password, ...(totpCode ? { totpCode } : {}) }, headers });
}

function setPassword(pw: string): void {
    const { hash, salt } = hashPassword(pw);
    updateLocalConfig({ adminHash: hash, salt });
}
function set2fa(on: boolean): void {
    updateLocalConfig(on
        ? { totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] }
        : { totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
}
function wrongCode(): string {
    for (;;) {
        const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        if (!verifyTotpCode(c, SECRET)) return c;
    }
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

/** A WebSocket upgrade to /ws/logs with this query: the status it was answered with, or 101. */
function logsUpgrade(query: string): Promise<number> {
    return new Promise(resolve => {
        const r = https.request({
            host: '127.0.0.1', port: PORT, path: `/ws/logs${query}`, rejectUnauthorized: false,
            headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') },
        });
        r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode || 101); });
        r.on('response', res => { res.resume(); resolve(res.statusCode || 0); });
        r.on('error', () => resolve(0));
        r.end();
    });
}

function csrfCtx(token: string) {
    return { get: (h: string) => (h.toLowerCase() === 'x-csrf-token' ? token : undefined), request: { headers: { 'x-csrf-token': token } } };
}

async function main(): Promise<void> {
    console.log('\n=== The web manager: the password off the origin, sessions, CSRF, the logs socket, CORS and the CSP ===\n');

    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-web-manager-'));
    const publicDir = path.join(webRoot, 'public');
    fs.mkdirSync(path.join(publicDir, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>BeanPool</title><div id="root">the web app</div>');
    fs.writeFileSync(path.join(publicDir, 'settings', 'index.html'),
        '<!doctype html><title>Settings</title><div id="root">the manager</div><script type="module" src="/settings/assets/index.js"></script>');
    // https-server.ts and routes/settings.ts take public/ from the working directory when it has one, as they load.
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair();
    const mod = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run(mod.pub, 'Moe', new Date().toISOString(), owner.pub, 'TEST');
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(mod.pub);
    grantNodeRole(mod.pub, 'moderator', owner.pub);
    setPassword(PW);
    set2fa(false);
    setBreakGlassMode(false);
    updateGatewayConfig({ corsAllowedOrigins: [LISTED] });

    const { startHttpsServer } = await import('./https-server.js');
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    try {
        // ── 1. M1: the password sign-in ───────────────────────────────────────────────────────────
        console.log('── 1. the password is exchanged once for an httpOnly session ──');
        resetAdminAuthTarpit();
        const none = await signIn('');
        assert(none.status === 400 && !none.cookie, `no password → 400, no cookie (${show(none)})`);
        const wrong = await signIn('not the password');
        assert(wrong.status === 401 && !wrong.cookie, `a wrong password → 401, no cookie (${show(wrong)})`);

        const a = await signIn(PW);
        assert(a.status === 200 && !!a.sessionId, `the right password → 200 and an admin_session cookie (${show(a)})`);
        assert(/;\s*httponly/i.test(a.cookie) && /;\s*samesite=strict/i.test(a.cookie) && /;\s*path=\/(;|$)/i.test(a.cookie),
            `the cookie is HttpOnly, SameSite=Strict, Path=/ (${a.cookie.replace(/=[0-9a-f]{64}/, '=…')})`);
        assert(a.body?.role === 'owner' && typeof a.body?.csrfToken === 'string', `the body names the role and a CSRF token (${a.text.slice(0, 120)})`);
        assert(!a.text.includes(PW), 'the body never holds the password');
        assert(!!a.sessionId && !a.text.includes(a.sessionId), "nor the session's id: it is in the httpOnly cookie only");
        assert(a.headers.get('x-admin-2fa-session') === null && !('tfaSessionToken' in (a.body || {})), 'and no 2FA session is handed out');
        assert((a.headers.get('cache-control') || '').includes('no-store'), 'the answer is not stored');
        const csrfA: string = a.body?.csrfToken ?? '';

        const who = await call('GET', '/api/local/admin/auth/session', { headers: asCookie(a.sessionId) });
        assert(who.body?.authenticated === true && who.body?.isPasswordSession === true && who.body?.isKeySession === false
            && who.body?.role === 'owner' && who.body?.memberPubkey === null,
            `after a reload the cookie still says who: a password session, owner, no member (${who.text})`);
        // With 2FA off a password session opens the 2FA card's routes only (step 6, test-password-totp-gate.ts), so
        // the read and the change here are that card's.
        const diag = await call('GET', '/api/local/admin/2fa/status', { headers: asCookie(a.sessionId) });
        assert(diag.status === 200, `the cookie alone opens an admin read, no password sent (${diag.status})`);
        const noCsrf = await call('POST', '/api/local/admin/2fa/setup', { body: {}, headers: asCookie(a.sessionId) });
        assert(noCsrf.status === 403, `a change on the cookie without the CSRF token → 403 (${show(noCsrf)})`);
        const withCsrf = await call('POST', '/api/local/admin/2fa/setup', { body: {}, headers: asCookie(a.sessionId, csrfA) });
        assert(withCsrf.status === 200 && typeof withCsrf.body?.secret === 'string', `with its CSRF token → 200 (${show(withCsrf)})`);
        const fresh = await call('POST', '/api/local/admin/csrf-token', { body: {}, headers: asCookie(a.sessionId) });
        const withFresh = await call('POST', '/api/local/admin/2fa/setup', { body: {}, headers: asCookie(a.sessionId, fresh.body?.csrfToken) });
        assert(fresh.status === 200 && withFresh.status === 200, `a reload's fresh CSRF token works too (${fresh.status}, ${withFresh.status})`);

        const again = await signIn(PW, undefined, asCookie(a.sessionId));
        const oldAfterAgain = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(a.sessionId) });
        assert(again.status === 200 && again.sessionId !== a.sessionId && oldAfterAgain.status === 401,
            `signing in again from the same browser ends its old session (${again.status}, old → ${oldAfterAgain.status})`);
        const out = await call('POST', '/api/local/admin/auth/logout', { body: {}, headers: asCookie(again.sessionId, again.body?.csrfToken) });
        const afterOut = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(again.sessionId) });
        assert(out.status === 200 && /admin_session=;/.test(out.cookie) && afterOut.status === 401 && afterOut.body?.sessionExpired === true,
            `sign-out clears the cookie and ends the session (${out.status} ${out.cookie.slice(0, 30)}, then ${show(afterOut)})`);

        // 2FA: on, a session opened without it ends; sign-in needs the code; off, other sessions end, the caller's stays.
        resetAdminAuthTarpit();
        const before2fa = await signIn(PW);
        set2fa(true);
        const ended = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(before2fa.sessionId) });
        assert(ended.status === 401, `turning 2FA on ends a password session opened without it (${show(ended)})`);
        const noCode = await signIn(PW);
        assert(noCode.status === 401 && noCode.body?.totpRequired === true && !noCode.cookie, `with 2FA on the password alone opens nothing (${show(noCode)})`);
        const badCode = await signIn(PW, wrongCode());
        assert(badCode.status === 401 && !badCode.cookie, `a wrong code opens nothing (${show(badCode)})`);
        const t1 = await signIn(PW, generateTotpCode(SECRET));
        assert(t1.status === 200 && !!t1.sessionId && t1.headers.get('x-admin-2fa-session') === null,
            `password and code → a session, and no 2FA session token (${show(t1)})`);
        const t1Read = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(t1.sessionId) });
        assert(t1Read.status === 200, `the session then needs no code per request (${t1Read.status})`);
        const t2 = await signIn(PW, generateTotpCode(SECRET));
        const off = await call('POST', '/api/local/admin/2fa/disable', { body: { code: generateTotpCode(SECRET) }, headers: asCookie(t1.sessionId, t1.body?.csrfToken) });
        // 2FA off again: the session that turned it off is held to the 2FA card (step 6), which it still opens.
        const t1AfterOff = await call('GET', '/api/local/admin/2fa/status', { headers: asCookie(t1.sessionId) });
        const t2AfterOff = await call('GET', '/api/local/admin/2fa/status', { headers: asCookie(t2.sessionId) });
        assert(off.status === 200 && t1AfterOff.status === 200 && t2AfterOff.status === 401,
            `turning 2FA off keeps the session that did it and ends the others (${show(off)}; it ${t1AfterOff.status}, another ${t2AfterOff.status})`);

        // The password changed: the session that changed it carries on, every other one ends.
        // With 2FA on: a password session on a node with 2FA off opens nothing but the 2FA card (step 6).
        resetAdminAuthTarpit();
        set2fa(true);
        const p1 = await signIn(PW, generateTotpCode(SECRET));
        const p2 = await signIn(PW, generateTotpCode(SECRET));
        const changed = await call('POST', '/api/local/change-password', {
            body: { currentPassword: PW, newPassword: NEW_PW }, headers: asCookie(p1.sessionId, p1.body?.csrfToken),
        });
        const p1After = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(p1.sessionId) });
        const p2After = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(p2.sessionId) });
        assert(changed.status === 200 && p1After.status === 200 && p2After.status === 401,
            `a password change keeps the session that made it and ends the others (${show(changed)}; it ${p1After.status}, another ${p2After.status})`);
        const oldPw = await signIn(PW, generateTotpCode(SECRET));
        const newPw = await signIn(NEW_PW, generateTotpCode(SECRET));
        assert(oldPw.status === 401 && newPw.status === 200, `the old password signs in no more, the new one does (${oldPw.status}, ${newPw.status})`);
        setPassword(PW);
        set2fa(false);

        // Break-glass mode: the password reaches key enrolment only, so it opens no session and an open one ends.
        resetAdminAuthTarpit();
        const preBreak = await signIn(PW);
        const ownerKey = await keySignIn(owner);
        setBreakGlassMode(true);
        const inBreak = await signIn(PW);
        const preBreakNow = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(preBreak.sessionId) });
        const keyInBreak = await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(ownerKey.sessionId) });
        assert(inBreak.status === 403 && inBreak.body?.breakGlassMode === true && !inBreak.cookie,
            `in break-glass mode the password opens no session (${show(inBreak)})`);
        assert(preBreakNow.status === 401 && keyInBreak.status === 200,
            `an open password session ends, a key session carries on (${preBreakNow.status}, ${keyInBreak.status})`);
        setBreakGlassMode(false);

        // At most MAX_PASSWORD_SESSIONS at once: a new one ends the oldest.
        const opened = Array.from({ length: MAX_PASSWORD_SESSIONS + 1 }, () => createPasswordSession());
        assert(!validateAdminSession(opened[0].sessionId).valid && validateAdminSession(opened[MAX_PASSWORD_SESSIONS].sessionId).valid,
            `at most ${MAX_PASSWORD_SESSIONS} password sessions: the oldest goes`);
        for (const s of opened) revokeAdminSession(s.sessionId);

        // The node, not the browser, ends a session: the cookie has no Max-Age, so at each limit it is still sent and
        // the node answers `sessionExpired` with the reason (the manager's sign-in card shows it). The clock is moved
        // in this process only (Date.now), for the one request.
        console.log('\n── 1b. the node ends the session, and says why ──');
        resetAdminAuthTarpit();
        const realNow = Date.now;
        const later = async (ms: number, sessionId: string | null): Promise<Reply> => {
            const t = realNow();
            Date.now = () => t + ms;
            try { return await call('GET', '/api/local/admin/diagnostics', { headers: asCookie(sessionId) }); } finally { Date.now = realNow; }
        };
        const life = await signIn(PW);
        assert(life.status === 200 && !/;\s*max-age=/i.test(life.cookie) && !/;\s*expires=/i.test(life.cookie),
            `the password sign-in's cookie has no Max-Age or Expires: a browser-session cookie (${life.cookie.replace(/=[0-9a-f]{64}/, '=…')})`);
        const keyLife = await keySignIn(owner);
        assert(keyLife.status === 200 && !/;\s*max-age=/i.test(keyLife.cookie) && !/;\s*expires=/i.test(keyLife.cookie),
            `so has the key sign-in's (${keyLife.cookie.replace(/=[0-9a-f]{64}/, '=…')})`);
        const hard = await later(12 * 3_600_000 + 1_000, life.sessionId);
        assert(hard.status === 401 && hard.body?.sessionExpired === true && /12h hard limit/.test(hard.body?.error ?? ''),
            `12 h on, the cookie still sent: 401, sessionExpired, and the reason (${show(hard)})`);
        const idlePw = await signIn(PW);
        const idleAnswer = await later(2 * 3_600_000 + 1_000, idlePw.sessionId);
        assert(idleAnswer.status === 401 && idleAnswer.body?.sessionExpired === true && /2h idle/.test(idleAnswer.body?.error ?? ''),
            `a password session unused for 2 h: 401, sessionExpired, "2h idle" (${show(idleAnswer)})`);
        const handoff = await call('GET', `/settings?token=${mintHandshakeToken(owner.pub, 'owner').handshakeToken}`);
        const handoffIdle = await later(16 * 60_000, handoff.sessionId);
        assert(handoff.status === 302 && handoffIdle.status === 401 && handoffIdle.body?.sessionExpired === true && /15 min idle/.test(handoffIdle.body?.error ?? ''),
            `the phone hand-off's cookie session still idles out at 15 min, and says so (${show(handoffIdle)})`);
        const handoff2 = await call('GET', `/settings?token=${mintHandshakeToken(owner.pub, 'owner').handshakeToken}`);
        const handoffUsed = await later(14 * 60_000, handoff2.sessionId);
        assert(handoffUsed.status === 200, `used within 15 min, it is still signed in (${handoffUsed.status})`);

        // A browser that holds no cookie any more (cleared, or the browser dropped it) sends nothing: no guess, so no
        // tarpit, and nothing counted against the owner's next sign-in; `sessionExpired` sends the manager to its card.
        resetAdminAuthTarpit();
        const bare: number[] = [];
        let bareOk = true;
        for (let i = 0; i < 8; i++) {
            const t = realNow();
            const r = await call('GET', '/api/local/admin/diagnostics');
            bare.push(realNow() - t);
            if (!(r.status === 401 && r.body?.sessionExpired === true && r.body?.notSignedIn === true)) { bareOk = false; console.error(`   ${show(r)}`); }
        }
        assert(bareOk, 'a request with no cookie and no password: 401, sessionExpired, notSignedIn');
        assert(Math.max(...bare) < 200, `and it is answered at once, not tarpitted (${bare.join(', ')} ms)`);
        const tWrong = realNow();
        const wrongAfter = await signIn('not the password');
        const wrongMs = realNow() - tWrong;
        assert(wrongAfter.status === 401 && wrongMs >= 200 && wrongMs < 1_200,
            `a wrong password after them is tarpitted as the first failure, not the ninth (${wrongMs} ms; 8 counted would be ≥ 2250)`);
        resetAdminAuthTarpit();

        // ── 2. L3: the key sign-in's session id is in the cookie only ───────────────────────────
        console.log('\n── 2. the key sign-in answers its session in the cookie only ──');
        const k = await keySignIn(owner);
        assert(k.status === 200 && !!k.sessionId && /;\s*httponly/i.test(k.cookie) && /;\s*samesite=strict/i.test(k.cookie),
            `the exchange sets an HttpOnly, SameSite=Strict cookie (${k.status} ${k.cookie.replace(/=[0-9a-f]{64}/, '=…')})`);
        assert(k.body?.sessionId === undefined && !!k.sessionId && !k.text.includes(k.sessionId),
            `and its body never holds the session's id (${k.text.slice(0, 160)})`);
        const deep = await call('GET', `/settings?token=${mintHandshakeToken(owner.pub, 'owner').handshakeToken}`);
        assert(deep.status === 302 && !!deep.sessionId && /;\s*samesite=strict/i.test(deep.cookie) && /;\s*httponly/i.test(deep.cookie),
            `/settings?token= sets the same strict cookie (${deep.status} ${deep.cookie.replace(/=[0-9a-f]{64}/, '=…')})`);

        // ── 3. L4: a CSRF token is bound to its session ───────────────────────────────────────────
        console.log('\n── 3. a CSRF token counts for its own session only ──');
        const o = await keySignIn(owner);
        const m = await keySignIn(mod);
        const pw = await signIn(PW);
        const pwCaller = await call('POST', '/api/local/admin/csrf-token', { body: {}, headers: { 'X-Admin-Password': PW } });
        assert(o.status === 200 && m.status === 200 && pw.status === 200 && pwCaller.status === 200, `owner, moderator and password sessions open (${o.status}, ${m.status}, ${pw.status}, ${pwCaller.status})`);
        const ownWorks = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(o.sessionId, o.body?.csrfToken) });
        assert(ownWorks.status === 200, `the owner's own token on the owner's cookie → 200 (${ownWorks.status})`);
        for (const [label, token] of [["the moderator's", m.body?.csrfToken], ["another password session's", pw.body?.csrfToken], ["a password caller's", pwCaller.body?.csrfToken]] as const) {
            const r = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(o.sessionId, token) });
            assert(r.status === 403, `${label} token on the owner's cookie → 403 (${show(r)})`);
        }
        const modToken: string = m.body?.csrfToken;
        assert(validateCsrfToken(csrfCtx(modToken), m.sessionId!), "the moderator's token is good for the moderator's session");
        await call('POST', '/api/local/admin/auth/logout', { body: {}, headers: asCookie(m.sessionId, modToken) });
        assert(!validateCsrfToken(csrfCtx(modToken), m.sessionId!), 'and goes with it at sign-out');

        // ── 4. L5: /ws/logs takes a ticket only ───────────────────────────────────────────────────
        console.log('\n── 4. the logs socket takes a ticket, never the password in a URL ──');
        resetAdminAuthTarpit();
        set2fa(false);
        const viaPassword = await logsUpgrade(`?auth=${encodeURIComponent(PW)}`);
        assert(viaPassword === 401, `/ws/logs?auth=<the password>, 2FA off → 401 (got ${viaPassword})`);
        const ticket = await call('POST', '/api/local/admin/ws-ticket', { body: {}, headers: asCookie(o.sessionId, o.body?.csrfToken) });
        const viaTicket = await logsUpgrade(`?ticket=${encodeURIComponent(ticket.body?.ticket ?? '')}`);
        assert(viaTicket === 101, `/ws/logs?ticket=<a fresh ticket> → 101 (got ${viaTicket})`);
        const replay = await logsUpgrade(`?ticket=${encodeURIComponent(ticket.body?.ticket ?? '')}`);
        assert(replay === 401, `the same ticket again → 401 (got ${replay})`);

        // ── 5. L6: no credentialed CORS on the admin surface ──────────────────────────────────────
        console.log('\n── 5. a listed origin gets no credentials on the admin surface ──');
        const adminRead = await call('GET', '/api/local/admin/diagnostics', { headers: { Origin: LISTED, ...asCookie(o.sessionId) } });
        assert(adminRead.headers.get('access-control-allow-origin') === LISTED && adminRead.headers.get('access-control-allow-credentials') === null,
            `an admin read from the listed origin: its origin, no credentials (ACAO ${adminRead.headers.get('access-control-allow-origin')}, ACAC ${adminRead.headers.get('access-control-allow-credentials')})`);
        const preflight = await call('OPTIONS', '/api/local/admin/ws-ticket', {
            headers: { Origin: LISTED, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-csrf-token' },
        });
        assert(preflight.status === 204 && preflight.headers.get('access-control-allow-credentials') === null,
            `the preflight of an admin change: no credentials, so the browser sends none (${preflight.status}, ACAC ${preflight.headers.get('access-control-allow-credentials')})`);
        for (const adminPath of ['/api/local/verify-password', '/api/local/change-password', '/api/admin/seed-invite', '/settings', '/API/LOCAL/ADMIN/data']) {
            const r = await call('OPTIONS', adminPath, { headers: { Origin: LISTED, 'Access-Control-Request-Method': 'POST' } });
            assert(r.headers.get('access-control-allow-credentials') === null, `OPTIONS ${adminPath}: no credentials (${r.headers.get('access-control-allow-credentials')})`);
        }
        // The price-report queue is admin too (checkAdminAuth): a read with the session, and its status change's preflight.
        const reportsRead = await call('GET', '/api/pricing-guide/reports', { headers: { Origin: LISTED, ...asCookie(o.sessionId) } });
        assert(reportsRead.status === 200 && reportsRead.headers.get('access-control-allow-credentials') === null,
            `GET /api/pricing-guide/reports from the listed origin: no credentials (${reportsRead.status}, ACAC ${reportsRead.headers.get('access-control-allow-credentials')})`);
        for (const reportsPath of ['/api/pricing-guide/reports', '/api/pricing-guide/reports/x/status', '/API/pricing-guide/Reports/x/status']) {
            const r = await call('OPTIONS', reportsPath, { headers: { Origin: LISTED, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-csrf-token' } });
            assert(r.headers.get('access-control-allow-credentials') === null, `OPTIONS ${reportsPath}: no credentials (${r.status}, ACAC ${r.headers.get('access-control-allow-credentials')})`);
        }
        // The admin IP allowlist guards the same list: an allowlist without this address closes the queue too.
        updateGatewayConfig({ corsAllowedOrigins: [LISTED], adminIpAllowlist: ['203.0.113.7'] });
        const reportsBlocked = await call('GET', '/api/pricing-guide/reports', { headers: asCookie(o.sessionId) });
        updateGatewayConfig({ corsAllowedOrigins: [LISTED], adminIpAllowlist: [] });
        assert(reportsBlocked.status === 403 && /allowlist/i.test(reportsBlocked.text),
            `with an admin IP allowlist that leaves this address out, GET /api/pricing-guide/reports → 403 (${show(reportsBlocked)})`);
        // A member's own price report (singular) is the member API, not the queue.
        const ownReport = await call('OPTIONS', '/api/pricing-guide/report', { headers: { Origin: LISTED, 'Access-Control-Request-Method': 'POST' } });
        assert(ownReport.headers.get('access-control-allow-credentials') === 'true', `OPTIONS /api/pricing-guide/report (a member's own report) keeps credentials (${ownReport.headers.get('access-control-allow-credentials')})`);
        const memberRead = await call('GET', '/api/community/info', { headers: { Origin: LISTED } });
        assert(memberRead.headers.get('access-control-allow-origin') === LISTED && memberRead.headers.get('access-control-allow-credentials') === 'true',
            `the member API still answers the listed origin with credentials (ACAC ${memberRead.headers.get('access-control-allow-credentials')})`);
        assert((memberRead.headers.get('vary') || '').toLowerCase().includes('origin'), `and says it varies by Origin (${memberRead.headers.get('vary')})`);
        const unlisted = await call('GET', '/api/community/info', { headers: { Origin: 'https://elsewhere.example' } });
        assert(unlisted.headers.get('access-control-allow-origin') === null, 'an unlisted origin gets nothing');

        // ── 6. M2: the manager under the strict policy ───────────────────────────────────────────
        console.log('\n── 6. Settings runs under the web app\'s strict policy ──');
        for (const p of ['/settings', '/settings/', '/settings/people', '/settings/index.html']) {
            const r = await call('GET', p);
            const csp = r.headers.get('content-security-policy') || '';
            const scriptSrc = (csp.split(';').map(d => d.trim()).find(d => d.startsWith('script-src ')) || '').split(/\s+/).slice(1);
            assert(r.status === 200 && r.text.includes('the manager') && csp === APP_DOCUMENT_CSP,
                `GET ${p}: the manager, under the app document's policy (${r.status}, ${csp === APP_DOCUMENT_CSP ? 'app policy' : csp})`);
            assert(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'") && !scriptSrc.some(s => s.includes('unpkg.com')),
                `GET ${p}: script-src is ${scriptSrc.join(' ')}: no inline, no eval, no unpkg.com`);
            assert(r.headers.get('referrer-policy') === 'strict-origin-when-cross-origin', `GET ${p}: Referrer-Policy kept (${r.headers.get('referrer-policy')})`);
        }
        const failedLink = await call('GET', '/settings?token=deadbeef');
        assert(failedLink.status === 400 && failedLink.headers.get('content-security-policy') === APP_DOCUMENT_CSP && !/<script/i.test(failedLink.text),
            `a sign-in link that fails gets a page with no script, under the strict policy (${failedLink.status})`);
        const legacy = await call('GET', '/settings-legacy');
        assert(legacy.status === 200 && legacy.headers.get('content-security-policy') === DOCUMENT_CSP,
            `/settings-legacy, the old page with inline handlers, keeps its own policy (${legacy.status})`);
    } finally {
        process.chdir(os.tmpdir());
        fs.rmSync(webRoot, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The web manager holds no password; its session is a strict, httpOnly cookie with its own CSRF tokens.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
