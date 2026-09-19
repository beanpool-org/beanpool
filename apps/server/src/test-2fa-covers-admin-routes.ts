/**
 * Two-factor sign-in protects EVERY admin route, not only some (node-manual review #945, "Things operators may push
 * back on" #3).
 *
 * The routes below used to take the node password alone (checkAdminPassword): no 2FA, no break-glass rules, no key
 * sessions. Each now goes through checkAdminAuth and a role gate. For every one, with 2FA on:
 *   1. the password alone is refused (401, totpRequired);
 *   2. the password with a 2FA session gets through;
 *   3. a key session of the right role gets through;
 *   4. a key session of too low a role is refused 403 (owner-only routes, tried with an admin's session). For the
 *      owner-or-admin routes the only role below admin is moderator, which cannot get a key session at all (checked
 *      once), and an admin demoted mid-session loses the session at once (checked for every route: 401);
 *   5. in break-glass mode the password with a 2FA session is refused (403) and a key session still works.
 * Then:
 *   6. turning 2FA off: owner only, and only with a code that is right now (a 2FA session or key session alone is
 *      refused; a wrong code is refused; an admin with the right code is refused);
 *   7. the brake-reset hole (#937 review, finding 1): with 2FA on, a caller who knows the password but not the code
 *      used to wipe their source's count of wrong codes by sending the password alone to one of these routes, and so
 *      guess codes without end. Now the count survives, and the source is braked after the free failures;
 *   8. /ws/logs?auth=<password> (password alone) is refused under 2FA.
 *
 * A Koa app with the real checkAdminAuth and the real community and settings routes, without the per-IP auth rate
 * limit (15 a minute would stop the matrix half way; the password brake is real). No request leaves this process:
 * the update check's call to GitHub is answered here.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-2fa-covers-admin-routes.ts
 */
import crypto from 'node:crypto';
import https from 'node:https';
import Koa from 'koa';
import { initStateEngine, seedGenesisMember, grantNodeRole, revokeNodeRole, nodeRoleOf } from './state-engine.js';
import { db } from './db/db.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { updateLocalConfig, getLocalConfig, hashPassword, setBreakGlassMode } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, generateBackupCodes, hashBackupCode } from './totp.js';
import { createCommunityRoutes } from './routes/community.js';
import { createSettingsRoutes } from './routes/settings.js';
import { SOURCE_FREE_FAILURES } from './password-brake.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const PW = 'TwoFaCover123!';
const SECRET = generateTotpSecret();
const BACKUP = generateBackupCodes(4);

// The update check asks GitHub for the latest release. Answer it here: this test sends nothing off the machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ tag_name: 'v0.0.1', html_url: '', body: '', published_at: '' }), { status: 200 });
    }
    return realFetch(input, init);
}) as typeof fetch;

function setPassword(): void {
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt });
}
function set2fa(on: boolean): void {
    updateLocalConfig(on
        ? { totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: BACKUP.map(hashBackupCode), totpPendingSecret: null, totpPendingBackupCodesHashes: [] }
        : { totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
}
/** A six-digit code the authenticator would not show now (nor in the windows either side). */
function wrongCode(): string {
    for (;;) {
        const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        if (!verifyTotpCode(c, SECRET)) return c;
    }
}

function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { privateKey, pubKeyHex };
}
/** Key sign-in as the app does it: challenge → signature → handshake token → session. */
function keySession(kp: ReturnType<typeof makeKeypair>): { sessionId?: string; error?: string } {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({
        challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature,
        totpCode: getLocalConfig().totpEnabled ? generateTotpCode(SECRET) : undefined,
    });
    if (!solved.ok) return { error: solved.error };
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    return ex.ok ? { sessionId: ex.sessionId } : { error: ex.error };
}

async function main() {
    console.log('--- TEST: 2FA and key sessions cover every admin route ---');
    initStateEngine();
    setPassword();
    set2fa(false);

    const olive = makeKeypair();  // owner
    const adam = makeKeypair();   // admin
    const mo = makeKeypair();     // moderator
    const dee = makeKeypair();    // admin, demoted mid-session
    // Olive is the genesis member, so an owner. The others join as plain members and are given roles.
    seedGenesisMember(olive.pubKeyHex, 'Olive');
    for (const [kp, callsign] of [[adam, 'Adam'], [mo, 'Mo'], [dee, 'Dee']] as const) {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(kp.pubKeyHex, callsign, new Date().toISOString(), olive.pubKeyHex, 'TEST');
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(kp.pubKeyHex);
    }
    assert(nodeRoleOf(olive.pubKeyHex) === 'owner' && nodeRoleOf(adam.pubKeyHex) === null, 'Olive is the owner; Adam starts with no role');
    grantNodeRole(adam.pubKeyHex, 'admin', 'owner:password');
    grantNodeRole(mo.pubKeyHex, 'moderator', 'owner:password');

    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.method !== 'GET') {
            const chunks: Buffer[] = [];
            for await (const chunk of ctx.req) chunks.push(chunk as Buffer);
            const str = Buffer.concat(chunks).toString('utf8');
            try { (ctx as any).requestBody = str ? JSON.parse(str) : {}; } catch { (ctx as any).requestBody = {}; }
        }
        await next();
    });
    const deps: any = {
        checkAdminAuth,
        rateLimit: () => true,
        clampLimit: (v: unknown, d = 50) => Number(v) || d,
        clampOffset: (v: unknown) => Number(v) || 0,
        enforceReadAuth: false,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
    };
    const community = createCommunityRoutes(deps);
    const settings = createSettingsRoutes(deps);
    app.use(community.routes()).use(community.allowedMethods());
    app.use(settings.routes()).use(settings.allowedMethods());
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}`;

    async function call(method: string, path: string, headers: Record<string, string>, body?: any): Promise<{ status: number; body: any }> {
        // A password caller sends it in the body as well as the header, as the old clients did: the old routes read
        // only the body, so this is what reached them without 2FA.
        if (body !== undefined && headers['X-Admin-Password'] && body.password === undefined) {
            body = { password: headers['X-Admin-Password'], ...body };
        }
        const res = await realFetch(`${base}${path}`, {
            method,
            headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let b: any = {};
        try { b = await res.json(); } catch { /* empty */ }
        return { status: res.status, body: b };
    }

    try {
        // Key sessions are made while 2FA is off; a key sign-in under 2FA asks for the code too (admin-key-auth.ts).
        const ownerSid = keySession(olive).sessionId!;
        const adminSid = keySession(adam).sessionId!;
        const deeSid = keySession(dee).sessionId;
        assert(!!ownerSid && !!adminSid, 'owner and admin sign in with their keys');
        assert(!deeSid, 'Dee holds no role yet: no key session');
        const moTry = keySession(mo);
        assert(!moTry.sessionId && /node role/.test(moTry.error || ''), `a moderator cannot get an admin key session (${moTry.error})`);

        set2fa(true);
        resetAdminAuthTarpit();
        const login = await call('POST', '/api/local/verify-password', {}, { password: PW, totpCode: generateTotpCode(SECRET) });
        const tfa = login.body.tfaSessionToken as string;
        assert(login.status === 200 && typeof tfa === 'string', 'password + a right code signs in and gets a 2FA session');

        const pwOnly = { 'X-Admin-Password': PW };
        const pwWith2fa = { 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfa };
        const asOwner = { 'x-admin-session': ownerSid };
        const asAdmin = { 'x-admin-session': adminSid };

        type Route = { method: string; path: string; body?: any; ok: number; owner: boolean; after?: () => void };
        // `ok` is what the route answers once past auth. Bodies are chosen to have no lasting effect where possible:
        // the connector routes stop at "address is required", 2FA verify at "code is required".
        const restoreAfterReset = () => { setPassword(); set2fa(true); };
        const ROUTES: Route[] = [
            { method: 'POST', path: '/api/local/update-identity', body: { callsign: 'TwoFaTest' }, ok: 200, owner: false },
            { method: 'POST', path: '/api/local/change-password', body: { currentPassword: PW, newPassword: PW }, ok: 200, owner: true },
            { method: 'POST', path: '/api/local/connectors', body: {}, ok: 400, owner: false },
            { method: 'POST', path: '/api/local/connectors/connect', body: {}, ok: 400, owner: false },
            { method: 'POST', path: '/api/local/connectors/credit-cap', body: {}, ok: 400, owner: false },
            { method: 'POST', path: '/api/local/federation/links/ceiling', body: {}, ok: 400, owner: false },
            { method: 'POST', path: '/api/local/connectors/disconnect', body: {}, ok: 400, owner: false },
            { method: 'POST', path: '/api/local/connectors/remove', body: {}, ok: 400, owner: false },
            { method: 'POST', path: '/api/local/reset', body: {}, ok: 200, owner: true, after: restoreAfterReset },
            { method: 'POST', path: '/api/admin/thresholds', body: {}, ok: 200, owner: false },
            { method: 'POST', path: '/api/admin/check-update', body: {}, ok: 200, owner: false },
            { method: 'GET', path: '/api/local/admin/2fa/status', ok: 200, owner: false },
            { method: 'POST', path: '/api/local/admin/2fa/setup', body: {}, ok: 200, owner: true },
            { method: 'POST', path: '/api/local/admin/2fa/verify', body: {}, ok: 400, owner: true },
        ];

        for (const r of ROUTES) {
            const name = `${r.method} ${r.path} [${r.owner ? 'owner only' : 'owner or admin'}]`;
            resetAdminAuthTarpit();

            const a = await call(r.method, r.path, pwOnly, r.body);
            assert(a.status === 401 && a.body.totpRequired === true, `${name}: password alone → 401 totpRequired (got ${a.status})`);

            const b = await call(r.method, r.path, pwWith2fa, r.body);
            assert(b.status === r.ok, `${name}: password + 2FA session → ${r.ok} (got ${b.status} ${JSON.stringify(b.body).slice(0, 80)})`);
            r.after?.();

            const c = await call(r.method, r.path, asOwner, r.body);
            assert(c.status === r.ok, `${name}: owner key session → ${r.ok} (got ${c.status})`);
            r.after?.();

            const d = await call(r.method, r.path, asAdmin, r.body);
            if (r.owner) {
                assert(d.status === 403, `${name}: admin key session → 403 (got ${d.status})`);
            } else {
                assert(d.status === r.ok, `${name}: admin key session → ${r.ok} (got ${d.status})`);
            }

            // An admin demoted mid-session: the session dies on its next request.
            grantNodeRole(dee.pubKeyHex, 'admin', 'owner:password');
            set2fa(false);
            const deeNow = keySession(dee).sessionId!;
            set2fa(true);
            revokeNodeRole(dee.pubKeyHex, 'admin', 'owner:password');
            const e = await call(r.method, r.path, { 'x-admin-session': deeNow }, r.body);
            assert(e.status === 401, `${name}: an admin demoted mid-session → 401 (got ${e.status})`);

            setBreakGlassMode(true);
            const f = await call(r.method, r.path, pwWith2fa, r.body);
            assert(f.status === 403 && f.body.breakGlassMode === true, `${name}: break-glass mode refuses password + 2FA session (got ${f.status})`);
            const g = await call(r.method, r.path, asOwner, r.body);
            assert(g.status === r.ok, `${name}: break-glass mode still lets the owner's key session through (got ${g.status})`);
            r.after?.();
            setBreakGlassMode(false);
        }

        // Change password: a key session still has to know the current password.
        resetAdminAuthTarpit();
        const cpNoProof = await call('POST', '/api/local/change-password', asOwner, { newPassword: 'SomethingElse9!' });
        assert(cpNoProof.status === 401, `change password under a key session without the current password → 401 (got ${cpNoProof.status})`);
        const cpWrong = await call('POST', '/api/local/change-password', asOwner, { currentPassword: 'NotIt123!', newPassword: 'SomethingElse9!' });
        assert(cpWrong.status === 401, `…or with a wrong one → 401 (got ${cpWrong.status})`);
        // An old client that sends only { currentPassword, newPassword } still signs in with it, 2FA included.
        const cpOldClientNo2fa = await call('POST', '/api/local/change-password', {}, { currentPassword: PW, newPassword: PW });
        assert(cpOldClientNo2fa.status === 401 && cpOldClientNo2fa.body.totpRequired === true, `a body-only change-password is held to 2FA (got ${cpOldClientNo2fa.status})`);
        const cpOldClient = await call('POST', '/api/local/change-password', { 'X-Admin-2FA-Session': tfa }, { currentPassword: PW, newPassword: PW });
        assert(cpOldClient.status === 200, `a body-only change-password with a 2FA session → 200 (got ${cpOldClient.status})`);

        // ── 6. Turning 2FA off ──
        resetAdminAuthTarpit();
        const offNoCode = await call('POST', '/api/local/admin/2fa/disable', pwWith2fa, {});
        assert(offNoCode.status === 401 && offNoCode.body.totpRequired === true, `2FA off with a 2FA session but no code → 401 (got ${offNoCode.status})`);
        const offWrong = await call('POST', '/api/local/admin/2fa/disable', pwWith2fa, { code: wrongCode() });
        assert(offWrong.status === 401, `2FA off with a wrong code → 401 (got ${offWrong.status})`);
        const offKeyNoCode = await call('POST', '/api/local/admin/2fa/disable', asOwner, {});
        assert(offKeyNoCode.status === 401, `2FA off with the owner's key session but no code → 401 (got ${offKeyNoCode.status})`);
        const offAdmin = await call('POST', '/api/local/admin/2fa/disable', asAdmin, { code: generateTotpCode(SECRET) });
        assert(offAdmin.status === 403, `an admin cannot turn 2FA off, even with the right code → 403 (got ${offAdmin.status})`);
        const offPwOnly = await call('POST', '/api/local/admin/2fa/disable', pwOnly, { code: generateTotpCode(SECRET) });
        // checkAdminAuth takes a sign-in code from X-Admin-TOTP or totpCode, not `code`: this is the password alone.
        assert(offPwOnly.status === 401, `2FA off with the password alone (code in "code") → 401 (got ${offPwOnly.status})`);
        assert(getLocalConfig().totpEnabled === true, '…and 2FA is still on after all of those');

        const offKey = await call('POST', '/api/local/admin/2fa/disable', asOwner, { code: generateTotpCode(SECRET) });
        assert(offKey.status === 200 && getLocalConfig().totpEnabled === false, `owner key session + a right code turns 2FA off (got ${offKey.status})`);
        set2fa(true);
        const offSession = await call('POST', '/api/local/admin/2fa/disable', pwWith2fa, { code: generateTotpCode(SECRET) });
        assert(offSession.status === 200 && getLocalConfig().totpEnabled === false, `password + 2FA session + a right code turns 2FA off (got ${offSession.status})`);
        set2fa(true);
        // The legacy page: password + X-Admin-TOTP, no 2FA session. The one code signs in and proves presence.
        const offInline = await call('POST', '/api/local/admin/2fa/disable', { ...pwOnly, 'X-Admin-TOTP': generateTotpCode(SECRET) }, {});
        assert(offInline.status === 200 && getLocalConfig().totpEnabled === false, `password + X-Admin-TOTP turns 2FA off (got ${offInline.status})`);
        set2fa(true);
        const offBackup = await call('POST', '/api/local/admin/2fa/disable', asOwner, { code: BACKUP[0] });
        assert(offBackup.status === 200 && getLocalConfig().totpEnabled === false, `a backup code turns 2FA off for an owner who lost the phone (got ${offBackup.status})`);
        set2fa(true);

        // ── 7. The brake-reset hole ──
        // Knows the password, not the code. Each round: one wrong code at sign-in, then the password alone to every
        // route that used to take it. Before, any of those cleared the source's record, so the wrong codes never
        // added up. Now the source is braked once they pass the free allowance.
        resetAdminAuthTarpit();
        const statuses: number[] = [];
        for (let i = 0; i < SOURCE_FREE_FAILURES + 3; i++) {
            const guess = await call('POST', '/api/local/verify-password', {}, { password: PW, totpCode: wrongCode() });
            statuses.push(guess.status);
            for (const r of ROUTES) await call(r.method, r.path, pwOnly, r.body);
        }
        const wrongCodesChecked = statuses.filter(s => s === 401).length;
        assert(statuses.includes(429), `wrong codes add up despite the password-only calls between them: braked (statuses ${statuses.join(',')})`);
        assert(wrongCodesChecked <= SOURCE_FREE_FAILURES + 1, `at most ${SOURCE_FREE_FAILURES + 1} wrong codes were checked before the brake (got ${wrongCodesChecked})`);
        const stillBraked = await call('POST', '/api/local/verify-password', {}, { password: PW, totpCode: wrongCode() });
        assert(stillBraked.status === 429, `the next guess is braked too (got ${stillBraked.status})`);
        // And a key session is untouched by the brake.
        const keyStill = await call('GET', '/api/local/admin/2fa/status', asOwner);
        assert(keyStill.status === 200, `the owner's key session still works while the password is braked (got ${keyStill.status})`);

        // ── 8. /ws/logs?auth=<password> is the password alone: refused under 2FA ──
        resetAdminAuthTarpit();
        const { initTls } = await import('./services/tls.js');
        const { startHttpsServer } = await import('./https-server.js');
        await initTls();
        const WS_PORT = 8599;
        await startHttpsServer(WS_PORT);
        const wsStatus = (): Promise<number> => new Promise(resolve => {
            const r = https.request({
                    host: '127.0.0.1', port: WS_PORT, path: `/ws/logs?auth=${encodeURIComponent(PW)}`, rejectUnauthorized: false,
                    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') },
                });
                r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode || 101); });
                r.on('response', res => { res.resume(); resolve(res.statusCode || 0); });
                r.on('error', () => resolve(0));
                r.end();
        });
        const wsOn = await wsStatus();
        assert(wsOn === 401, `/ws/logs?auth=<password> under 2FA → 401 (got ${wsOn})`);
        set2fa(false);
        const wsOff = await wsStatus();
        assert(wsOff === 101, `/ws/logs?auth=<password> with 2FA off still connects, as before (got ${wsOff})`);
    } finally {
        server.close();
    }

    console.log(`\n========================================`);
    console.log(`Test Results: ${passed}/${run} assertions passed`);
    console.log(`========================================`);
    if (passed !== run) throw new Error(`${run - passed} assertions failed`);
}

main().then(() => process.exit(0)).catch(e => {
    console.error('Test failed with error:', e);
    process.exit(1);
});
