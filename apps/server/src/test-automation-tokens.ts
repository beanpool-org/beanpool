/**
 * Node sign-in, design step 7a (D8): owner automation tokens. Over REAL HTTPS through the real middleware; nothing here
 * contacts anything but the server it starts.
 *
 *   1. Making one: an owner's key session (fresh), not a stale phone session (step-up), the password session (with its
 *      2FA code); never an admin, never a token. Shown once: the list carries no secret and no hash. Unknown scope,
 *      no name, an expiry in the past: refused.
 *   2. Using one: `Authorization: Bearer bp_<id>_<secret>`, with no 2FA code on a 2FA-on node, within its scope only.
 *      read: GETs; backups: BACKUPS_SCOPE_ROUTES; admin: admin-level routes. Every admin route of every router is swept
 *      with each scope: read refuses every change, backups everything off its list, and the admin token is refused on
 *      every route an admin's key session is refused on (so on every owner-only route), and on the sign-in, session
 *      and token routes.
 *   3. Wrong secret, unknown id, malformed, expired: 401, the same answer, with no measurable time difference.
 *   4. Revoked: 401 on its next request. A token never opens a Settings session (no cookie, the sign-in routes refuse).
 *   5. The secret is in no log line, and local-config.json keeps only its hash; a backup file's config has none.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-automation-tokens" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { updateLocalConfig, getLocalConfig, hashPassword, setBreakGlassMode, redactLocalConfig } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, forgetUsedTotpCodesForTests } from './totp.js';
import { resetAdminAuthTarpit, TOKEN_REFUSED_CODE } from './admin-auth.js';
import { backdateAdminSessionForTests } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { db } from './db/db.js';
import { BACKUPS_SCOPE_ROUTES, resetAutomationTokenUseThrottle, issueAutomationToken } from './automation-tokens.js';
import { TOKEN_NEEDS_KEY_CODE } from './routes/automation-tokens.js';
import { LOCAL_CONFIG_FIELDS } from './engine/replication-manifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
/** For the sweeps: only failures are printed, one count at the end. */
function quietly(cond: boolean, msg: string, failures: string[]): void {
    if (!cond) failures.push(msg);
}

const PW = 'AutomationTokens1!';
const SECRET = generateTotpSecret();

interface Reply { status: number; body: any; text: string; sessionId: string | null; setCookie: string[] }

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
    const setCookie = res.headers.getSetCookie();
    const cookie = setCookie.find(c => c.startsWith('admin_session=')) ?? '';
    return { status: res.status, body, text, sessionId: cookie.match(/^admin_session=([0-9a-f]{64})/)?.[1] ?? null, setCookie };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 140)}`;
const asSession = (id: string | null): Record<string, string> => ({ 'X-Admin-Session': id ?? '' });
const asCookie = (id: string | null, csrf?: string): Record<string, string> =>
    ({ Cookie: `admin_session=${id ?? ''}`, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) });
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
async function keySignIn(k: Key): Promise<Reply> {
    const chal = await call('POST', '/api/local/admin/auth/challenge', { body: {} });
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        body: { challengeId: chal.body?.challengeId, memberPubkey: k.pub, signature: crypto.sign(null, Buffer.from(chal.body?.challenge ?? ''), k.priv).toString('hex') },
    });
    return call('POST', '/api/local/admin/auth/exchange', { body: { token: solved.body?.handshakeToken } });
}

/** Every admin route the server mounts, read from the route sources (method, path with its :params). */
function adminRoutes(): Array<[string, string]> {
    const files = [path.join(HERE, 'https-server.ts'), ...fs.readdirSync(path.join(HERE, 'routes')).filter(f => f.endsWith('.ts')).map(f => path.join(HERE, 'routes', f))];
    const out = new Map<string, [string, string]>();
    const re = /router\.(get|post|put|delete|patch)\(\s*'([^']+)'/g;
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(re)) {
            const p = m[2];
            if (!(p.startsWith('/api/local/admin') || p.startsWith('/api/admin') || p === '/api/local/change-password')) continue;
            out.set(`${m[1].toUpperCase()} ${p}`, [m[1].toUpperCase(), p]);
        }
    }
    return [...out.values()].sort((a, b) => (a[1] + a[0]).localeCompare(b[1] + b[0]));
}

async function main(): Promise<void> {
    console.log('\n=== Step 7a: owner automation tokens ===\n');

    const tmp = path.resolve(os.tmpdir());
    const webRoot = fs.mkdtempSync(path.join(tmp, 'bp-tokens-'));
    fs.mkdirSync(path.join(webRoot, 'public', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    fs.writeFileSync(path.join(webRoot, 'public', 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    process.chdir(webRoot);

    // Every log line this process writes, to look for a secret in (section 5).
    const logged: string[] = [];
    for (const k of ['log', 'info', 'warn', 'error'] as const) {
        const orig = console[k].bind(console);
        (console as any)[k] = (...a: unknown[]) => { logged.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); orig(...a); };
    }

    await initTls();
    initStateEngine();
    const owner = keypair();
    const admin = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, 'Adam', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(admin.pub);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(admin.pub);
    grantNodeRole(admin.pub, 'admin', owner.pub);
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
    setBreakGlassMode(false);

    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const secrets: string[] = [];

    try {
        // ── 1. Making one ─────────────────────────────────────────────────────────────────────────
        console.log('── 1. Only an owner makes a token; it is shown once ──');
        resetAdminAuthTarpit();
        const ownerS = await keySignIn(owner);
        assert(ownerS.status === 200 && !!ownerS.sessionId, `the owner signs in with the key (${show(ownerS)})`);
        const adminS = await keySignIn(admin);
        assert(adminS.status === 200 && !!adminS.sessionId, `the admin signs in with the key (${show(adminS)})`);

        const make = (h: Record<string, string>, body: unknown) => call('POST', '/api/local/admin/automation-tokens', { headers: h, body });
        const tRead = await make(asSession(ownerS.sessionId), { name: 'nightly read', scope: 'read' });
        assert(tRead.status === 201 && /^bp_[0-9a-f]{12}_[0-9a-f]{64}$/.test(tRead.body?.token ?? ''), `an owner's fresh key session makes a read token (${tRead.status})`);
        const tBackups = await make(asSession(ownerS.sessionId), { name: 'backup pull', scope: 'backups' });
        const tAdmin = await make(asSession(ownerS.sessionId), { name: 'fleet manager', scope: 'admin' });
        assert(tBackups.status === 201 && tAdmin.status === 201, 'and a backups token and an admin token');
        const READ: string = tRead.body.token, BACKUPS: string = tBackups.body.token, ADMIN: string = tAdmin.body.token;
        secrets.push(READ, BACKUPS, ADMIN);
        assert(tRead.body?.record?.createdBy === owner.pub && !('hash' in (tRead.body?.record ?? {})), 'the record names the owner who made it, and has no hash');

        const byAdmin = await make(asSession(adminS.sessionId), { name: 'x', scope: 'read' });
        assert(byAdmin.status === 403, `an admin cannot make one (${show(byAdmin)})`);
        const byToken = await make(bearer(ADMIN), { name: 'x', scope: 'read' });
        assert(byToken.status === 403 && byToken.body?.code === TOKEN_REFUSED_CODE, `a token cannot make one (${show(byToken)})`);
        for (const [body, why] of [[{ name: 'x', scope: 'owner' }, 'an unknown scope'], [{ name: '', scope: 'read' }, 'no name'],
            [{ name: 'x', scope: 'read', expiresAt: Date.now() - 1000 }, 'an expiry in the past']] as const) {
            const r = await make(asSession(ownerS.sessionId), body);
            assert(r.status === 400, `${why} is refused (${show(r)})`);
        }

        const stale = await keySignIn(owner);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const byStale = await make(asSession(stale.sessionId), { name: 'x', scope: 'read' });
        assert(byStale.status === 403 && byStale.body?.code === 'step_up_required', `a stale phone session needs the step-up (${show(byStale)})`);

        // Only an owner's key makes a token, never the admin password by any path, whatever the node's 2FA: so every token
        // belongs to a person and stops when they are no longer an owner (PR #1540 deciding review, fix round 1).
        const stored = () => (getLocalConfig().automationTokens ?? []).length;
        const storedBefore = stored();
        const needsKey = (r: Reply) => r.status === 403 && r.body?.code === TOKEN_NEEDS_KEY_CODE;
        const code = () => { forgetUsedTotpCodesForTests(); return generateTotpCode(SECRET); };
        const pw = await call('POST', '/api/local/admin/auth/password', { body: { password: PW, totpCode: code() } });
        assert(pw.status === 200 && !!pw.sessionId, `the password signs in with its 2FA code (${show(pw)})`);
        const byPw = await make(asCookie(pw.sessionId, pw.body?.csrfToken), { name: 'pw made', scope: 'read' });
        assert(needsKey(byPw), `2FA on: the password session cannot make one (${show(byPw)})`);
        const byHeader = await make({ 'X-Admin-Password': PW, 'X-Admin-TOTP': code() }, { name: 'pw made', scope: 'admin' });
        assert(needsKey(byHeader), `2FA on: the password and its code in the headers cannot make one (${show(byHeader)})`);
        const byBodyPw = await make({}, { name: 'pw made', scope: 'admin', password: PW, totpCode: code() });
        assert(needsKey(byBodyPw), `2FA on: the password and its code in the body cannot make one (${show(byBodyPw)})`);
        updateLocalConfig({ totpEnabled: false });
        try {
            const pwOff = await call('POST', '/api/local/admin/auth/password', { body: { password: PW } });
            assert(pwOff.status === 200 && !!pwOff.sessionId, `2FA off: the password signs in alone (${show(pwOff)})`);
            const byPwOff = await make(asCookie(pwOff.sessionId, pwOff.body?.csrfToken), { name: 'pw made', scope: 'admin' });
            assert(byPwOff.status === 403 && ['totp_setup_required', TOKEN_NEEDS_KEY_CODE].includes(byPwOff.body?.code), `2FA off: the password session cannot make one (${show(byPwOff)})`);
            const byHeaderOff = await make({ 'X-Admin-Password': PW }, { name: 'pw made', scope: 'admin' });
            // Step 7c: with 2FA off the password per request is refused before the route runs (password_needs_2fa).
            const refusedOff = (r: Reply) => r.status === 403 && ['password_needs_2fa', TOKEN_NEEDS_KEY_CODE].includes(r.body?.code);
            assert(refusedOff(byHeaderOff), `2FA off: the password in the header cannot make one (${show(byHeaderOff)})`);
            const byBodyOff = await make({}, { name: 'pw made', scope: 'admin', password: PW });
            assert(refusedOff(byBodyOff), `2FA off: the password in the body cannot make one (${show(byBodyOff)})`);
        } finally {
            updateLocalConfig({ totpEnabled: true });
        }
        assert(stored() === storedBefore, `no password path stored a token (${stored() - storedBefore} stored)`);
        assert(/owner's key|owner key/i.test(byHeader.body?.error ?? ''), `and the answer says to make it with an owner's key (${byHeader.body?.error})`);

        const list = await call('GET', '/api/local/admin/automation-tokens', { headers: asSession(ownerS.sessionId) });
        assert(list.status === 200 && list.body?.tokens?.length === 3, `the list shows the three (${show(list)})`);
        const listByPw = await call('GET', '/api/local/admin/automation-tokens', { headers: asCookie(pw.sessionId) });
        assert(listByPw.status === 200 && listByPw.body?.tokens?.length === 3, `the password session lists them (${show(listByPw)})`);
        const spare = await make(asSession(ownerS.sessionId), { name: 'spare', scope: 'read' });
        assert(spare.status === 201, `the owner's key makes a spare (${spare.status})`);
        secrets.push(spare.body.token);
        const revByPw = await call('POST', `/api/local/admin/automation-tokens/${spare.body.record.id}/revoke`, { headers: asCookie(pw.sessionId, pw.body?.csrfToken), body: {} });
        assert(revByPw.status === 200, `the password session revokes it (${show(revByPw)})`);
        const spareAfter = await call('GET', '/api/local/admin/diagnostics', { headers: bearer(spare.body.token) });
        assert(spareAfter.status === 401, `and it is refused at once (${spareAfter.status})`);

        // A stored token whose maker is not a member key is refused on use (none can be made now; defence in depth).
        for (const createdBy of ['owner:password', 'not-a-key']) {
            const legacy = issueAutomationToken({ name: 'legacy', scope: 'read', createdBy });
            assert(legacy.ok, 'a record with a non-key maker is stored directly');
            if (!legacy.ok) continue;
            secrets.push(legacy.token);
            const r = await call('GET', '/api/local/admin/diagnostics', { headers: bearer(legacy.token) });
            assert(r.status === 401, `a token made by '${createdBy}' is refused on use (${show(r)})`);
            const rv = await call('POST', `/api/local/admin/automation-tokens/${legacy.record.id}/revoke`, { headers: asSession(ownerS.sessionId), body: {} });
            assert(rv.status === 200, 'and the owner can still revoke it');
        }
        assert(!secrets.some(s => list.text.includes(s.split('_')[2])) && !/"hash"/.test(list.text), 'the list carries no secret and no hash');
        const listByAdmin = await call('GET', '/api/local/admin/automation-tokens', { headers: asSession(adminS.sessionId) });
        assert(listByAdmin.status === 403, 'an admin cannot list them');

        // ── 2. Using one ──────────────────────────────────────────────────────────────────────────
        console.log('── 2. A token works with no 2FA code, within its scope only ──');
        const diag = await call('GET', '/api/local/admin/diagnostics', { headers: bearer(READ) });
        assert(diag.status === 200, `a read token reads, with no 2FA code on a 2FA-on node (${diag.status})`);
        assert(!diag.setCookie.some(c => c.startsWith('admin_session=')), 'and is handed no session cookie');
        const bstat = await call('POST', '/api/local/admin/backup-status', { headers: bearer(BACKUPS), body: {} });
        assert(bstat.status === 200, `a backups token reads the backup status (${show(bstat)})`);
        const snaps = await call('POST', '/api/local/admin/snapshots/list', { headers: bearer(BACKUPS), body: {} });
        assert(snaps.status === 200, `and lists the snapshots (${show(snaps)})`);
        const adminOk = await call('GET', '/api/local/admin/reports', { headers: bearer(ADMIN) });
        assert(adminOk.status === 200, `an admin token reads the reports (${show(adminOk)})`);
        const wrongCode = await call('GET', '/api/local/admin/diagnostics', { headers: { ...bearer(READ), 'X-Admin-TOTP': '000000' } });
        assert(wrongCode.status === 200, 'a 2FA code sent with a token changes nothing: the token is the credential');

        const routes = adminRoutes();
        assert(routes.length > 150, `the sweep has every admin route of every router (${routes.length})`);
        const fill = (p: string) => p.replace(/:pubkey/g, owner.pub).replace(/:[A-Za-z]+/g, 'x1');
        const isRead = (m: string) => m === 'GET';
        // Routes whose handler the admin session must not run in this process (a restore restarts it).
        const NOT_RUN_AS_ADMIN = new Set(['POST /api/local/admin/restore']);

        const readFails: string[] = [], backupsFails: string[] = [], adminFails: string[] = [], refusedEvery: string[] = [];
        let ownerOnlySeen = 0;
        // Refused: 403 token_not_allowed before the route runs; or 401 where the route takes another credential only
        // (the standby's copy routes take the replication token; revoke-all takes a session or signature).
        const refused = (r: Reply) => (r.status === 403 && r.body?.code === TOKEN_REFUSED_CODE) || r.status === 401;
        let publicSeen = 0;
        for (const [m, p] of routes) {
            resetAdminRateLimit(); // the sweep is a few hundred requests: tokens share the admin limiter (checked below)
            const url = fill(p);
            const opts = (h: Record<string, string>) => ({ headers: h, ...(m === 'GET' ? {} : { body: {} }) });
            const key = `${m} ${p}`;
            const lowered = p.toLowerCase();
            // A route that answers a request with no credential at all is not behind checkAdminAuth (the sign-in steps,
            // public status): a token there is just ignored. It must still never come back with a Settings session.
            const anon = await call(m, url, opts({}));
            if (anon.status !== 401) {
                publicSeen++;
                for (const t of [READ, BACKUPS, ADMIN]) {
                    const r = await call(m, url, opts(bearer(t)));
                    quietly(!r.sessionId && r.status !== 200 || anon.status === r.status, `public ${key}: a token changes the answer (${anon.status} → ${show(r)})`, refusedEvery);
                    quietly(!r.sessionId, `public ${key}: a token got a session`, refusedEvery);
                }
                continue;
            }
            const everyTokenRefused = lowered.startsWith('/api/local/admin/auth/') || lowered.startsWith('/api/local/admin/automation-tokens')
                || lowered.startsWith('/api/local/admin/2fa/') || lowered === '/api/local/admin/ws-ticket' || lowered === '/api/local/admin/csrf-token';

            if (!isRead(m) || everyTokenRefused) {
                const r = await call(m, url, opts(bearer(READ)));
                quietly(refused(r), `read token: ${key} → ${show(r)}`, readFails);
            }
            const inBackups = BACKUPS_SCOPE_ROUTES.some(b => b.method === m && b.path === lowered);
            if (!inBackups) {
                const r = await call(m, url, opts(bearer(BACKUPS)));
                quietly(refused(r), `backups token: ${key} → ${show(r)}`, backupsFails);
            }
            if (everyTokenRefused) {
                const r = await call(m, url, opts(bearer(ADMIN)));
                // 429: the sign-in limiter, ahead of every credential (the sweep sends these routes many requests).
                quietly((refused(r) || r.status === 429) && !r.sessionId, `admin token on a sign-in/token route: ${key} → ${show(r)}`, refusedEvery);
                continue;
            }
            // The admin token is refused wherever an admin's key session is refused for its role (403): every
            // owner-only route, and every owner-only action on an owner (:pubkey is the owner's).
            let adminRefused = true;
            if (!NOT_RUN_AS_ADMIN.has(key)) {
                const a = await call(m, url, opts(asSession(adminS.sessionId)));
                adminRefused = a.status === 403;
            }
            if (adminRefused) {
                ownerOnlySeen++;
                const r = await call(m, url, opts(bearer(ADMIN)));
                quietly(r.status === 403, `admin token on owner-only ${key} → ${show(r)}`, adminFails);
            }
        }
        for (const f of [...readFails, ...backupsFails, ...adminFails, ...refusedEvery].slice(0, 30)) console.error(`   ✗ ${f}`);
        assert(publicSeen > 0, `${publicSeen} routes need no credential (sign-in steps): a token there opens no session and changes nothing`);
        assert(readFails.length === 0, `read token: every change refused, before the route runs (${readFails.length} not)`);
        assert(backupsFails.length === 0, `backups token: every route off its list refused (${backupsFails.length} not)`);
        assert(refusedEvery.length === 0, `admin token: the sign-in, session, 2FA and token routes refused (${refusedEvery.length} not)`);
        assert(ownerOnlySeen > 20 && adminFails.length === 0, `admin token: refused on all ${ownerOnlySeen} routes an admin's session is refused on (${adminFails.length} not)`);

        resetAdminRateLimit();
        // Named owner-only changes, with a fresh owner's step-up in hand: still refused to every token.
        for (const [m, p, b] of [
            ['POST', '/api/local/admin/node-roles', { pubkey: admin.pub, role: 'owner' }],
            ['POST', '/api/local/admin/auth/break-glass-mode', { enabled: true }],
            ['POST', '/api/local/admin/replication-token/generate', {}],
            ['POST', '/api/local/admin/restore', {}],
        ] as const) {
            for (const t of [READ, BACKUPS, ADMIN]) {
                const r = await call(m, p, { headers: bearer(t), body: b });
                assert(r.status === 403, `${p} refused to the ${t === READ ? 'read' : t === BACKUPS ? 'backups' : 'admin'} token (${r.status})`);
            }
        }
        assert(getLocalConfig().totpEnabled === true && getLocalConfig().adminHash === hash, 'and the node\'s 2FA and password are as they were');

        // Tokens go through the admin limiter like every admin request (ADMIN_RATE_LIMIT a minute, per source).
        resetAdminRateLimit();
        let limited = 0;
        for (let i = 0; i < 320 && !limited; i++) if ((await call('GET', '/api/local/admin/reports', { headers: bearer(ADMIN) })).status === 429) limited = i + 1;
        assert(limited > 0 && limited <= 301, `a token is held by the admin limiter (429 at request ${limited})`);
        resetAdminRateLimit();

        // ── 3. Bad tokens ─────────────────────────────────────────────────────────────────────────
        console.log('── 3. Wrong secret, unknown id, malformed, expired: 401 alike ──');
        const [, id] = READ.split('_');
        const wrongSecret = `bp_${id}_${crypto.randomBytes(32).toString('hex')}`;
        const unknownId = `bp_${crypto.randomBytes(6).toString('hex')}_${READ.split('_')[2]}`;
        const malformed = 'bp_nothing-like-a-token';
        const bad = [wrongSecret, unknownId, malformed];
        for (const t of bad) {
            const r = await call('GET', '/api/local/admin/diagnostics', { headers: bearer(t) });
            assert(r.status === 401 && r.body?.error === 'Invalid, revoked or expired automation token', `${t === malformed ? 'malformed' : t === wrongSecret ? 'wrong secret' : 'unknown id'} → 401 (${show(r)})`);
        }
        // Timing: the check itself, in-process (the network's jitter would hide nothing and prove nothing).
        const { verifyAutomationToken } = await import('./automation-tokens.js');
        const time = (t: string) => { const s = process.hrtime.bigint(); for (let i = 0; i < 4000; i++) verifyAutomationToken(t); return Number(process.hrtime.bigint() - s) / 4000; };
        for (let i = 0; i < 2; i++) bad.forEach(time); // warm up
        // The fastest of five interleaved rounds for each: other work on a busy machine only ever adds time. A shared CI
        // runner can still slow one kind for all five rounds, so a measurement over the bound is taken again, up to three
        // times: a real difference (a lookup that leaks) shows every time, a busy neighbour does not.
        const measure = () => {
            const ns = bad.map(() => Infinity);
            for (let round = 0; round < 5; round++) bad.forEach((t, i) => { ns[i] = Math.min(ns[i], time(t)); });
            return ns;
        };
        const attempts: number[][] = [];
        for (let a = 0; a < 3; a++) { const ns = measure(); attempts.push(ns); if (Math.max(...ns) / Math.min(...ns) < 2) break; }
        const last = attempts[attempts.length - 1];
        assert(Math.max(...last) / Math.min(...last) < 2,
            `the three take about the same time (${attempts.map(ns => ns.map(n => n.toFixed(0)).join(' / ')).join('; then ')} ns per check)`);
        const exp = await make(asSession(ownerS.sessionId), { name: 'short', scope: 'read', expiresAt: Date.now() + 1500 });
        assert(exp.status === 201, 'a token with an expiry is made');
        secrets.push(exp.body.token);
        await new Promise(r => setTimeout(r, 1700));
        const expired = await call('GET', '/api/local/admin/diagnostics', { headers: bearer(exp.body.token) });
        assert(expired.status === 401, `after its expiry it is refused (${expired.status})`);

        // ── 4. Revoked, and never a session ───────────────────────────────────────────────────────
        console.log('── 4. Revoking; a token never opens a Settings session ──');
        const pwSignIn = await call('POST', '/api/local/admin/auth/password', { headers: bearer(ADMIN), body: {} });
        assert(pwSignIn.status !== 200 && !pwSignIn.sessionId, `the password sign-in takes no token (${pwSignIn.status})`);
        const who = await call('GET', '/api/local/admin/auth/session', { headers: bearer(ADMIN) });
        assert(who.body?.authenticated !== true && !who.sessionId, `the session check does not count a token as a Settings session (${show(who)})`);
        resetAutomationTokenUseThrottle();
        await call('GET', '/api/local/admin/diagnostics', { headers: bearer(READ) });
        const used = (await call('GET', '/api/local/admin/automation-tokens', { headers: asSession(ownerS.sessionId) })).body?.tokens?.find((t: any) => t.id === id);
        assert(typeof used?.lastUsedAt === 'number' && used?.lastUsedRoute === 'GET /api/local/admin/diagnostics', `the list shows when and where it was last used (${JSON.stringify(used)})`);
        const rev = await call('POST', `/api/local/admin/automation-tokens/${id}/revoke`, { headers: asSession(ownerS.sessionId), body: {} });
        assert(rev.status === 200, `an owner revokes it (${show(rev)})`);
        const after = await call('GET', '/api/local/admin/diagnostics', { headers: bearer(READ) });
        assert(after.status === 401, `the revoked token is refused at once (${after.status})`);
        const revByToken = await call('POST', `/api/local/admin/automation-tokens/${tAdmin.body.record.id}/revoke`, { headers: bearer(ADMIN), body: {} });
        assert(revByToken.status === 403, 'a token cannot revoke one');

        // ── 5. Never the secret in a log, a backup or the config ──────────────────────────────────
        console.log('── 5. The secret is in no log, and only its hash is kept ──');
        const rows = db.prepare('SELECT message, metadata FROM system_logs').all() as Array<{ message: string; metadata: string | null }>;
        for (const r of rows) logged.push(`${r.message} ${r.metadata ?? ''}`);
        const used2 = logged.filter(l => l.includes('Automation token used'));
        assert(used2.length > 0 && used2.some(l => l.includes(tAdmin.body.record.id)), 'every use is logged with the token id');
        const leaked = secrets.filter(s => logged.some(l => l.includes(s.split('_')[2])));
        assert(leaked.length === 0, `no secret in any log line (${leaked.length} found)`);
        const cfgText = fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR || path.join(webRoot, 'data'), 'local-config.json'), 'utf8');
        assert(!secrets.some(s => cfgText.includes(s.split('_')[2])) && cfgText.includes('"automationTokens"'), 'local-config.json keeps the tokens, hashes only');
        assert(!('automationTokens' in redactLocalConfig(getLocalConfig())), "a backup file's config leaves them out");
        assert(LOCAL_CONFIG_FIELDS.automationTokens?.kind === 'per-server', 'the manifest keeps them with this server');
    } finally {
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
