/**
 * Settings can make a break-glass code, the app can fetch its owner's own, and Settings shows the 2FA backup codes to an
 * owner who types a current code — over a REAL HTTPS round trip through the server's middleware.
 *
 *   1. POST /api/local/admin/auth/break-glass/issue: an owner's key session gets a code for its own key (never another
 *      owner's); the password gets one for a named owner (never for a member without the owner role); an admin and a
 *      moderator are refused; a break-glass code is not a credential here; break-glass mode closes it to the password.
 *      The code is stored scrypt-hashed, opens the break-glass enrol route, and a new code retires the old one.
 *   2. POST /api/node-admin/break-glass, signed with the member key (what the app sends): an owner gets a code for
 *      their own key; an admin, a member and an unsigned request do not.
 *   3. POST /api/local/admin/2fa/backup-codes: new backup codes for an owner who types the 6-digit code the
 *      authenticator shows now. Missing, wrong, reused, a backup code in its place, an admin, a moderator, and 2FA off
 *      are refused, and nothing changes. The old codes stop working.
 *   4. Every log line written meanwhile is free of every code shown.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-breakglass-and-backup-codes.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { buildBoundRequestHeaders, ed25519Signer } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { consumeHandshakeToken, createAdminChallenge, verifyAndSolveChallenge } from './admin-key-auth.js';
import { updateLocalConfig, getLocalConfig, hashPassword } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, generateBackupCodes, hashBackupCode, forgetUsedTotpCodesForTests, verifyAndFindBackupCodeHash } from './totp.js';
import { logger } from './logger.js';

let BASE = '';
let run = 0, passed = 0;
// The suite's own lines carry codes (an assert prints an answer); they are written past the capture below.
const say = console.log.bind(console);
const shout = console.error.bind(console);
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; say(`✓ ${msg}`); } else { shout(`✗ ${msg}`); process.exitCode = 1; }
}

// Every line the server logs, through the logger or the console, kept to check that no code shown is in any of them.
const logged: string[] = [];
for (const level of Object.keys(logger) as (keyof typeof logger)[]) {
    const real = (logger as any)[level];
    if (typeof real !== 'function') continue;
    (logger as any)[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); return real.apply(logger, args); };
}
for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const real = console[level].bind(console);
    console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); real(...args); };
}

const PW = 'BreakGlass123!';
const SECRET = generateTotpSecret();
const OLD_BACKUP = generateBackupCodes(8);

interface Who { pub: string; priv: crypto.KeyObject; sign: ReturnType<typeof ed25519Signer> }
function seedMember(callsign: string): Who {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pub, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    const pkcs8 = new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer);
    return { pub, priv: privateKey, sign: ed25519Signer(pkcs8) };
}
function keySession(who: Who): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), who.priv).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: who.pub, signature });
    if (!solved.ok) throw new Error(solved.error);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(ex.error);
    return ex.sessionId!;
}
const hashOf = (pub: string) => (db.prepare('SELECT break_glass_hash AS h FROM node_roles WHERE member_pubkey = ?').get(pub) as { h: string | null } | undefined)?.h ?? null;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers };
}
async function signedPost(path: string, body: unknown, who?: Who) {
    const bodyString = JSON.stringify(body);
    const url = `${BASE}${path}`;
    const headers = who ? await buildBoundRequestHeaders({ method: 'POST', url, body: bodyString, publicKeyHex: who.pub, sign: who.sign }) : {};
    const res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: bodyString });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers };
}
/** A six-digit code the authenticator would not show now (nor in the windows either side). */
function wrongCode(): string {
    const near = new Set([-1, 0, 1].map(w => generateTotpCode(SECRET, w)));
    for (;;) {
        const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        if (!near.has(c)) return c;
    }
}

const BG_SHAPE = /^bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
const ISSUE = '/api/local/admin/auth/break-glass/issue';
const APP_ISSUE = '/api/node-admin/break-glass';
const BACKUP = '/api/local/admin/2fa/backup-codes';

async function main() {
    console.log('--- TEST: break-glass codes from Settings and the app, 2FA backup codes in Settings ---');
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false } as any);

    const owner = seedMember('bgOwner');
    const owner2 = seedMember('bgOwner2');
    const admin = seedMember('bgAdmin');
    const moderator = seedMember('bgMod');
    const member = seedMember('bgMember');
    const newcomer = seedMember('bgNewcomer');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');
    grantNodeRole(owner2.pub, 'owner', owner.pub);
    grantNodeRole(admin.pub, 'admin', owner.pub);
    grantNodeRole(moderator.pub, 'moderator', admin.pub);

    BASE = `https://localhost:${await startHttpsServer(0)}`;
    // Key sessions are made while 2FA is off (a key sign-in under 2FA asks for the code too).
    const asOwner = { 'x-admin-session': keySession(owner) };
    const asAdmin = { 'x-admin-session': keySession(admin) };
    const asMod = { 'x-admin-session': keySession(moderator) };
    const asPassword = { 'x-admin-password': PW };
    const shown: string[] = [];

    console.log('\n1. Break-glass code from Settings');
    {
        const before = hashOf(owner.pub);
        const r = await post(ISSUE, {}, asOwner);
        assert(r.status === 200 && BG_SHAPE.test(r.body?.breakGlassCode), `an owner's key session gets a code (${r.status} ${JSON.stringify(r.body)})`);
        assert(r.body?.memberPubkey === owner.pub, 'the code is for the owner\'s own key');
        assert((r.headers.get('cache-control') || '').includes('no-store'), 'the answer is never cached');
        const code1 = r.body?.breakGlassCode as string;
        shown.push(code1);
        const stored = hashOf(owner.pub);
        assert(!!stored && stored !== before && stored.startsWith('scrypt$') && !stored.includes(code1), 'stored scrypt-hashed, never in the clear');

        const other = await post(ISSUE, { memberPubkey: owner2.pub }, asOwner);
        assert(other.status === 403 && hashOf(owner2.pub) === null, `a key session cannot make a code for another owner (${other.status})`);

        const r2 = await post(ISSUE, {}, asOwner);
        const code2 = r2.body?.breakGlassCode as string;
        shown.push(code2);
        assert(r2.status === 200 && code2 !== code1, 'a second press makes a new code');

        const oldUse = await post('/api/local/admin/auth/break-glass/enrol', { memberPubkey: newcomer.pub, role: 'admin' }, { 'x-break-glass-code': code1 });
        assert(oldUse.status === 401, `the old code no longer opens the enrol route (${oldUse.status})`);
        const newUse = await post('/api/local/admin/auth/break-glass/enrol', { memberPubkey: newcomer.pub, role: 'admin' }, { 'x-break-glass-code': code2 });
        assert(newUse.status === 200, `the new code opens the enrol route (${newUse.status} ${JSON.stringify(newUse.body)})`);

        const asCode = await post(ISSUE, {}, { 'x-break-glass-code': code2 });
        assert(asCode.status === 401 && !asCode.body?.breakGlassCode, `a break-glass code cannot make a code (${asCode.status})`);

        const a = await post(ISSUE, {}, asAdmin);
        assert(a.status === 403 && !a.body?.breakGlassCode, `an admin is refused (${a.status})`);
        const m = await post(ISSUE, {}, asMod);
        assert(m.status === 403 && !m.body?.breakGlassCode, `a moderator is refused (${m.status})`);
        assert(hashOf(admin.pub) === null && hashOf(moderator.pub) === null, 'no code was stored for the admin or the moderator');

        const pwNone = await post(ISSUE, {}, asPassword);
        assert(pwNone.status === 400 && !pwNone.body?.breakGlassCode, `the password must name the owner (${pwNone.status})`);
        const pwMember = await post(ISSUE, { memberPubkey: member.pub }, asPassword);
        assert(pwMember.status === 409 && hashOf(member.pub) === null, `the password cannot make a code for a member who is not an owner (${pwMember.status})`);
        const pwAdmin = await post(ISSUE, { memberPubkey: admin.pub }, asPassword);
        assert(pwAdmin.status === 409 && hashOf(admin.pub) === null, `…nor for an admin (${pwAdmin.status})`);
        const pwOwner = await post(ISSUE, { memberPubkey: owner2.pub }, asPassword);
        assert(pwOwner.status === 200 && BG_SHAPE.test(pwOwner.body?.breakGlassCode) && pwOwner.body?.memberPubkey === owner2.pub,
            `the password makes a code for a named owner (${pwOwner.status})`);
        shown.push(pwOwner.body?.breakGlassCode);

        updateLocalConfig({ breakGlassMode: true } as any);
        const pwMode = await post(ISSUE, { memberPubkey: owner2.pub }, asPassword);
        assert(pwMode.status === 403 && !pwMode.body?.breakGlassCode, `break-glass mode closes it to the password (${pwMode.status})`);
        const keyMode = await post(ISSUE, {}, asOwner);
        assert(keyMode.status === 200 && BG_SHAPE.test(keyMode.body?.breakGlassCode), `…not to an owner's key (${keyMode.status})`);
        shown.push(keyMode.body?.breakGlassCode);
        updateLocalConfig({ breakGlassMode: false } as any);
    }

    console.log('\n2. Break-glass code from the app (signed with the member key)');
    {
        const unsigned = await signedPost(APP_ISSUE, {});
        assert(unsigned.status === 401 && !unsigned.body?.breakGlassCode, `unsigned is refused (${unsigned.status})`);
        const m = await signedPost(APP_ISSUE, {}, member);
        assert(m.status === 403 && !m.body?.breakGlassCode, `a member is refused (${m.status})`);
        const a = await signedPost(APP_ISSUE, {}, admin);
        assert(a.status === 403 && !a.body?.breakGlassCode && hashOf(admin.pub) === null, `an admin is refused (${a.status})`);
        const before = hashOf(owner2.pub);
        const o = await signedPost(APP_ISSUE, {}, owner2);
        assert(o.status === 200 && BG_SHAPE.test(o.body?.breakGlassCode) && o.body?.memberPubkey === owner2.pub, `an owner gets a code for their own key (${o.status} ${JSON.stringify(o.body)})`);
        assert((o.headers.get('cache-control') || '').includes('no-store'), 'the answer is never cached');
        assert(hashOf(owner2.pub) !== before && hashOf(owner2.pub)!.startsWith('scrypt$'), 'and it replaces the owner\'s stored code');
        shown.push(o.body?.breakGlassCode);
        const use = await post('/api/local/admin/auth/break-glass/enrol', { memberPubkey: member.pub, role: 'admin' }, { 'x-break-glass-code': o.body?.breakGlassCode });
        assert(use.status === 200, `the app's code opens the enrol route (${use.status})`);
    }

    console.log('\n3. 2FA backup codes in Settings');
    {
        const off = await post(BACKUP, { code: '123456' }, asOwner);
        assert(off.status === 409 && !off.body?.backupCodes, `with 2FA off there are none to show (${off.status})`);

        updateLocalConfig({ totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: OLD_BACKUP.map(hashBackupCode) } as any);
        const oldHashes = () => JSON.stringify(getLocalConfig().totpBackupCodesHashes);
        const start = oldHashes();

        const missing = await post(BACKUP, {}, asOwner);
        assert(missing.status === 401 && missing.body?.totpRequired && !missing.body?.backupCodes && oldHashes() === start, `no code: refused, nothing changes (${missing.status})`);
        const wrong = await post(BACKUP, { code: wrongCode() }, asOwner);
        assert(wrong.status === 401 && !wrong.body?.backupCodes && oldHashes() === start, `a wrong code: refused (${wrong.status})`);
        const backupInstead = await post(BACKUP, { code: OLD_BACKUP[0] }, asOwner);
        assert(backupInstead.status === 401 && !backupInstead.body?.backupCodes && oldHashes() === start,
            `a backup code in place of the authenticator's code: refused, and not spent (${backupInstead.status})`);

        forgetUsedTotpCodesForTests();
        const now = generateTotpCode(SECRET);
        const a = await post(BACKUP, { code: now }, asAdmin);
        assert(a.status === 403 && !a.body?.backupCodes && oldHashes() === start, `an admin with a right code: refused (${a.status})`);
        const m = await post(BACKUP, { code: now }, asMod);
        assert(m.status === 403 && !m.body?.backupCodes && oldHashes() === start, `a moderator with a right code: refused (${m.status})`);

        forgetUsedTotpCodesForTests();
        const ok = await post(BACKUP, { code: now }, asOwner);
        const codes: string[] = ok.body?.backupCodes || [];
        shown.push(...codes);
        assert(ok.status === 200 && codes.length === 8 && new Set(codes).size === 8, `an owner with the current code gets 8 new codes (${ok.status} ${JSON.stringify(ok.body)})`);
        assert((ok.headers.get('cache-control') || '').includes('no-store'), 'the answer is never cached');
        const stored = getLocalConfig().totpBackupCodesHashes || [];
        assert(codes.every(c => verifyAndFindBackupCodeHash(c, stored) !== -1) && stored.every(h => !codes.includes(h)), 'stored hashed, each new code matches');
        assert(OLD_BACKUP.every(c => verifyAndFindBackupCodeHash(c, stored) === -1), 'the old backup codes no longer work');

        const reuse = await post(BACKUP, { code: now }, asOwner);
        assert(reuse.status === 401 && !reuse.body?.backupCodes && JSON.stringify(getLocalConfig().totpBackupCodesHashes) === JSON.stringify(stored),
            `the same code a second time: refused (${reuse.status})`);

        // The password with this request's own code inline: the code checked here is the body's, and must be current too.
        const inline = generateTotpCode(SECRET, -1);
        let body = generateTotpCode(SECRET, 0);
        if (body === inline) body = generateTotpCode(SECRET, 1);
        forgetUsedTotpCodesForTests();
        const pwWrong = await post(BACKUP, { code: wrongCode() }, { ...asPassword, 'x-admin-totp': inline });
        assert(pwWrong.status === 401 && !pwWrong.body?.backupCodes, `the password + an inline code, with a wrong code to check: refused (${pwWrong.status})`);
        forgetUsedTotpCodesForTests();
        const pw = await post(BACKUP, { code: body }, { ...asPassword, 'x-admin-totp': inline });
        assert(pw.status === 200 && pw.body?.backupCodes?.length === 8, `the password + its code, with a current code: new codes (${pw.status} ${JSON.stringify(pw.body)})`);
        shown.push(...(pw.body?.backupCodes || []));
    }

    console.log('\n4. The log');
    {
        const leaks = shown.filter(Boolean).filter(c => logged.some(line => line.toLowerCase().includes(c.toLowerCase())));
        assert(shown.length >= 20 && leaks.length === 0, `no code shown was logged (${shown.length} codes, ${leaks.length} in the log)`);
        assert(logged.some(l => /break-glass code was made/i.test(l)), 'making a break-glass code is logged');
        assert(logged.some(l => /backup codes were made/i.test(l)), 'making backup codes is logged');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
