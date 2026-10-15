/**
 * Test Suite: Fable's security review of authentication, 2026-10-01 (scratch/reviews/FABLE-sec-auth.md).
 *
 * 1. MEDIUM 1. A break-glass code enrols a new admin key and does nothing else, whatever the mode (docs/admin-surface.md
 *    §2.2). On main it was a second owner password on every admin route while break-glass mode was off (the default):
 *    node-roles read and granted with it. Now any other route answers it as a wrong password, braked as one. The code is
 *    stored as salted scrypt; an old unsalted SHA-256 row is rewritten at boot, or on its code's next use.
 * 2. MEDIUM 2 was a brake on the 2FA code at key sign-in. Since decision D2 (2026-10-03) a key sign-in is not asked
 *    for the code at all (the phone's unlock is the key's second factor), so there is nothing to brake: with 2FA on, an
 *    owner's, an admin's and a moderator's key sign in with no code, a stray code is not looked at, a signature by
 *    another key opens nothing, and the password alone is still asked for the code.
 * 3. LOW 4. An invite redeem, or an offline-ticket redeem, must be signed by the key it registers. On main anyone
 *    holding a code registered any key, unsigned, under a name of their choosing. A real join (old app or new) still
 *    works.
 *
 * The real servers, on the tunnel-origin port: the client connects from loopback (a trusted local proxy), so
 * CF-Connecting-IP names the client, as cloudflared does.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-security-followups-1001.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// This community's one address, so a redeem signed for another community is 421 (engine/own-addresses.ts).
process.env.BEANPOOL_ADDRESSES = 'home.test';

import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, getNodeRoleBreakGlassHash, setNodeRoleBreakGlassHash, generateInvite } from './state-engine.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateLocalConfig, hashPassword, isBreakGlassMode, setBreakGlassMode, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';
import { setTrustConfigForTests } from './client-ip.js';
import { generateBreakGlassCode, verifyBreakGlassCode } from './admin-key-auth.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { SOURCE_FREE_FAILURES } from './password-brake.js';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, forgetUsedTotpCodesForTests } from './totp.js';
import { pairingMessage } from './settings-signin-pairing.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const PW = 'Followups-1001-Password!';
const viaTunnel = (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip });
let ipSeq = 10;
const freshIp = () => `198.51.100.${ipSeq++}`;
let BASE = '';

interface Reply { status: number; headers: Headers; json: any; text: string }
async function req(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: string } = {}): Promise<Reply> {
    forgetUsedTotpCodesForTests(); // A code is accepted once (totp.ts useTotpCode, test-storm-smalls); this suite signs in more than once a step.
    const raw = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
    const r = await fetch(`${BASE}${path}`, {
        method: opts.method || 'GET',
        headers: { ...(raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: raw,
        redirect: 'manual',
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, headers: r.headers, json, text };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 140)}`;

type Key = { pub: string; priv: Uint8Array; callsign: string };
function member(callsign: string): Key {
    const priv = new Uint8Array(crypto.randomBytes(32));
    const pub = Buffer.from(ed25519.getPublicKey(priv)).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return { pub, priv, callsign };
}
function stranger(callsign: string): Key {
    const priv = new Uint8Array(crypto.randomBytes(32));
    return { pub: Buffer.from(ed25519.getPublicKey(priv)).toString('hex'), priv, callsign };
}
const signText = (k: Key, text: string) => Buffer.from(ed25519.sign(Buffer.from(text, 'utf-8'), k.priv)).toString('base64');

/** An old-format signed POST (METHOD\nPATH\nTS\nNONCE\nBODY), as the phone app has signed every request since its first release. */
function unboundHeaders(k: Key, path: string, raw: string, at = Date.now()): Record<string, string> {
    const ts = String(at);
    const nonce = crypto.randomBytes(16).toString('hex');
    return { 'X-Public-Key': k.pub, 'X-Signature': signText(k, `POST\n${path}\n${ts}\n${nonce}\n${raw}`), 'X-Timestamp': ts, 'X-Nonce': nonce };
}

const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as { role: string } | undefined)?.role ?? null;
const rolesSnapshot = () => JSON.stringify(db.prepare('SELECT member_pubkey, role, granted_by, session_epoch FROM node_roles ORDER BY member_pubkey').all());
const sha256 = (s: string) => crypto.createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

async function part1BreakGlass(owner: Key): Promise<void> {
    console.log('— 1. a break-glass code enrols a key, and does nothing else —');
    resetAdminAuthTarpit();
    const pwHeaders = { 'x-admin-password': PW };
    // Step 7c: with the node's 2FA off, the password alone enrols nothing and changes no code; with 2FA on, the password and a
    // code do. The owner already holds the role, and re-enrolling them keeps their code (#1531), so the code is made the way
    // Settings makes it, naming the owner. 2FA goes off again after, so the checks below run on a node with 2FA off, as before.
    const hashBefore = getNodeRoleBreakGlassHash(owner.pub);
    const aloneEnrol = await req('/api/local/admin/auth/enrol', { method: 'POST', headers: { ...pwHeaders, ...viaTunnel(freshIp()) }, body: { memberPubkey: owner.pub, role: 'owner' } });
    assert(aloneEnrol.status === 403 && aloneEnrol.json?.code === 'password_needs_2fa' && !aloneEnrol.json?.breakGlassCode && getNodeRoleBreakGlassHash(owner.pub) === hashBefore,
        `with 2FA off the password alone enrols nothing and changes no code (${show(aloneEnrol)})`);
    const twoFa = turnOn2faForTests(PW);
    const twoFaOff = () => updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] } as any);
    resetAdminAuthTarpit();
    const enrolled = await req('/api/local/admin/auth/break-glass/issue', { method: 'POST', headers: { ...twoFa.headers(), ...viaTunnel(freshIp()) }, body: { memberPubkey: owner.pub } });
    twoFaOff();
    const code: string = enrolled.json?.breakGlassCode;
    assert(enrolled.status === 200 && /^bg-[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(code ?? ''), `the password makes the owner a code (${enrolled.status})`);

    // Stored salted and slow, not as the code's plain SHA-256.
    const stored = getNodeRoleBreakGlassHash(owner.pub) ?? '';
    assert(stored.startsWith('scrypt$') && !stored.includes(sha256(code)) && stored.split('$').length === 3 && stored.split('$')[1].length === 64,
        `the code is stored as salted scrypt, not its unsalted SHA-256 (${stored.slice(0, 20)}…)`);

    const helper = member('BgHelper');
    const target = member('BgTarget');
    const before = rolesSnapshot();
    const modeBefore = isBreakGlassMode();
    const X = freshIp();
    const asCode = (h: 'x-admin-password' | 'x-break-glass-code') => ({ [h]: code, ...viaTunnel(X) });
    const attempts: [string, () => Promise<Reply>][] = [
        ['GET node-roles (as x-admin-password)', () => req('/api/local/admin/node-roles', { headers: asCode('x-admin-password') })],
        ['POST node-roles granting a moderator (as x-admin-password)', () => req('/api/local/admin/node-roles', { method: 'POST', headers: asCode('x-admin-password'), body: { pubkey: target.pub, role: 'moderator' } })],
        ['GET node-roles (as x-break-glass-code)', () => req('/api/local/admin/node-roles', { headers: asCode('x-break-glass-code') })],
        ['GET diagnostics', () => req('/api/local/admin/diagnostics', { headers: asCode('x-admin-password') })],
        ['POST break-glass-mode on', () => req('/api/local/admin/auth/break-glass-mode', { method: 'POST', headers: asCode('x-admin-password'), body: { enabled: true } })],
    ];
    const answers: Reply[] = [];
    for (const [what, send] of attempts) {
        const r = await send();
        answers.push(r);
        assert(r.status === 401 && r.json?.error === 'Invalid password', `the code on ${what} is refused as a wrong password (${show(r)})`);
    }
    assert(rolesSnapshot() === before && roleOf(target.pub) === null && isBreakGlassMode() === modeBefore,
        `…and moves nothing: no role granted, break-glass mode unchanged (${roleOf(target.pub)}, ${isBreakGlassMode()})`);
    const wrongPw = await req('/api/local/admin/diagnostics', { headers: { 'x-admin-password': 'not-the-password', ...viaTunnel(freshIp()) } });
    assert(wrongPw.status === answers[0].status && wrongPw.text === answers[3].text, `the same answer as a wrong password (${show(wrongPw)})`);
    // The brake counts it: X has sent five, so one more is checked and then X waits.
    const sixth = await req('/api/local/admin/node-roles', { headers: asCode('x-admin-password') });
    const seventh = await req('/api/local/admin/node-roles', { headers: asCode('x-admin-password') });
    assert(SOURCE_FREE_FAILURES === 5 && sixth.status === 401 && seventh.status === 429 && seventh.json?.passwordBackoff === true,
        `the password brake counts each one: the ${SOURCE_FREE_FAILURES + 1}th is checked and then that address waits (${sixth.status}, ${seventh.status})`);

    // The enrol route takes it, as the docs say: from a clean address, and from the braked one too.
    const enrolByCode = await req('/api/local/admin/auth/break-glass/enrol', {
        method: 'POST', headers: { 'x-break-glass-code': code, ...viaTunnel(freshIp()) }, body: { memberPubkey: helper.pub, role: 'admin' },
    });
    assert(enrolByCode.status === 200 && enrolByCode.json?.alertEmitted === true && roleOf(helper.pub) === 'admin',
        `on the enrol route the code enrols a new admin key, with the public alert (${show(enrolByCode)})`);
    const other = member('BgFromBraked');
    const fromBraked = await req('/api/local/admin/auth/enrol', { method: 'POST', headers: asCode('x-admin-password'), body: { memberPubkey: other.pub, role: 'admin' } });
    assert(fromBraked.status === 200 && roleOf(other.pub) === 'admin', `and from the braked address too, on the enrol route (${show(fromBraked)})`);

    // Break-glass mode, turned on as the docs say (an owner, here with the password) and off again with a key session.
    // Step 7c: the password needs 2FA on and a code to turn it on; the rest of the mode's checks run with 2FA off again.
    const twoFaForMode = turnOn2faForTests(PW);
    resetAdminAuthTarpit();
    const on = await req('/api/local/admin/auth/break-glass-mode', { method: 'POST', headers: { ...twoFaForMode.headers(), ...viaTunnel(freshIp()) }, body: { enabled: true } });
    twoFaOff();
    assert(on.status === 200 && isBreakGlassMode() === true, `the owner turns break-glass mode on with the password, as before (${show(on)})`);
    const pwElsewhere = await req('/api/local/admin/node-roles', { headers: { ...pwHeaders, ...viaTunnel(freshIp()) } });
    const codeElsewhere = await req('/api/local/admin/node-roles', { headers: { 'x-admin-password': code, ...viaTunnel(freshIp()) } });
    assert(pwElsewhere.status === 403 && pwElsewhere.json?.breakGlassMode === true && codeElsewhere.status === 403,
        `in the mode, the password and the code reach no other route (${pwElsewhere.status}, ${codeElsewhere.status})`);
    const inMode1 = member('BgInMode1'), inMode2 = member('BgInMode2');
    // Step 7c: in the mode, with 2FA off, the password alone no longer enrols (it did); the password and a code do. The
    // break-glass code is the recovery factor itself and still enrols alone.
    const pwAloneEnrol = await req('/api/local/admin/auth/enrol', { method: 'POST', headers: { ...pwHeaders, ...viaTunnel(freshIp()) }, body: { memberPubkey: inMode1.pub, role: 'admin' } });
    assert(pwAloneEnrol.status === 403 && pwAloneEnrol.json?.code === 'password_needs_2fa' && roleOf(inMode1.pub) === null,
        `in the mode, with 2FA off, the password alone enrols no key (${show(pwAloneEnrol)})`);
    const twoFaInMode = turnOn2faForTests(PW);
    resetAdminAuthTarpit();
    const pwEnrol = await req('/api/local/admin/auth/enrol', { method: 'POST', headers: { ...twoFaInMode.headers(), ...viaTunnel(freshIp()) }, body: { memberPubkey: inMode1.pub, role: 'admin' } });
    twoFaOff();
    const codeEnrol = await req('/api/local/admin/auth/enrol', { method: 'POST', headers: { 'x-break-glass-code': code, ...viaTunnel(freshIp()) }, body: { memberPubkey: inMode2.pub, role: 'admin' } });
    assert(pwEnrol.status === 200 && codeEnrol.status === 200 && pwEnrol.json?.alertEmitted === true && roleOf(inMode2.pub) === 'admin',
        `and both still enrol a key there, with the alert (the password with a code) (${pwEnrol.status}, ${codeEnrol.status})`);
    const session = await keySession(owner, freshIp());
    const off = await req('/api/local/admin/auth/break-glass-mode', { method: 'POST', headers: { 'x-admin-session': session ?? '', ...viaTunnel(freshIp()) }, body: { enabled: false } });
    assert(session && off.status === 200 && isBreakGlassMode() === false, `the owner's key session turns it off (${show(off)})`);

    // An old unsalted row: rewritten at boot (break-glass-code.ts upgradeBreakGlassHashes) ...
    const legacyOwner = member('LegacyOwner');
    grantNodeRole(legacyOwner.pub, 'owner', owner.pub);
    const legacyCode = generateBreakGlassCode();
    setNodeRoleBreakGlassHash(legacyOwner.pub, sha256(legacyCode));
    const held = 'dec-legacy-' + crypto.randomBytes(4).toString('hex');
    db.prepare(`INSERT INTO suspended_node_roles (decision_id, member_pubkey, role, granted_by, session_epoch, break_glass_hash) VALUES (?, ?, 'owner', 'test', 0, ?)`)
        .run(held, member('HeldOwner').pub, sha256(generateBreakGlassCode()));
    const bgModule: any = await import('./break-glass-code.js').catch(() => null);
    const upgraded = bgModule?.upgradeBreakGlassHashes ? bgModule.upgradeBreakGlassHashes(db, { suspendedToo: true }) : 0;
    const legacyAfter = getNodeRoleBreakGlassHash(legacyOwner.pub) ?? '';
    const heldAfter = (db.prepare('SELECT break_glass_hash AS h FROM suspended_node_roles WHERE decision_id = ?').get(held) as { h: string }).h;
    assert(upgraded === 2 && legacyAfter.startsWith('scrypt$') && heldAfter.startsWith('scrypt$'),
        `the boot upgrade rewrites old unsalted hashes, a held role's too (${upgraded}; ${legacyAfter.slice(0, 12)}…, ${heldAfter.slice(0, 12)}…)`);
    const legacyEnrol = member('LegacyEnrolled');
    const legacyUse = await req('/api/local/admin/auth/enrol', { method: 'POST', headers: { 'x-break-glass-code': legacyCode, ...viaTunnel(freshIp()) }, body: { memberPubkey: legacyEnrol.pub, role: 'admin' } });
    assert(legacyUse.status === 200 && roleOf(legacyEnrol.pub) === 'admin', `and the owner's code still enrols after it (${show(legacyUse)})`);

    // ... and one that arrives later in the old form (a take-over bundle, a restore) works, and is rewritten on its use.
    const lateCode = generateBreakGlassCode();
    setNodeRoleBreakGlassHash(legacyOwner.pub, sha256(lateCode));
    const direct = await verifyBreakGlassCode(lateCode);
    const lateRow = getNodeRoleBreakGlassHash(legacyOwner.pub) ?? '';
    assert(direct?.member_pubkey === legacyOwner.pub && lateRow.startsWith('scrypt$'),
        `an old-form row that arrives later is accepted and rewritten as scrypt on its code's use (${lateRow.slice(0, 12)}…)`);
    const lateUse = await req('/api/local/admin/auth/enrol', { method: 'POST', headers: { 'x-break-glass-code': lateCode, ...viaTunnel(freshIp()) }, body: { memberPubkey: member('LateEnrolled').pub, role: 'admin' } });
    assert(lateUse.status === 200, `and keeps working after (${show(lateUse)})`);
}

/** A key sign-in, signing the challenge's own text (the old form, accepted until the switch). */
async function signIn(k: Key, ip: string, totpCode?: string, challenge?: { challengeId: string; challenge: string }): Promise<Reply> {
    const c = challenge ?? (await req('/api/local/admin/auth/challenge', { method: 'POST', headers: viaTunnel(ip) })).json;
    return req('/api/local/admin/auth/verify-challenge', {
        method: 'POST', headers: viaTunnel(ip),
        body: { challengeId: c.challengeId, memberPubkey: k.pub, signature: signText(k, c.challenge), ...(totpCode ? { totpCode } : {}) },
    });
}
async function keySession(k: Key, ip: string, totpCode?: string): Promise<string | null> {
    const solved = await signIn(k, ip, totpCode);
    const ex = await req('/api/local/admin/auth/exchange', { method: 'POST', headers: viaTunnel(ip), body: { token: solved.json?.handshakeToken } });
    // The exchange answers the session in its httpOnly cookie only, never in the body (Fable's web review, L3).
    return (ex.headers.get('set-cookie') || '').match(/admin_session=([0-9a-f]+)/)?.[1] ?? null;
}

async function part2KeySignin2fa(owner: Key): Promise<void> {
    // Decision D2 (2026-10-03): the node's 2FA code is the password's second factor; a key's is the phone's own unlock.
    // So a key sign-in is not asked for the code and there is no code to guess or brake; the password still is.
    console.log('\n— 2. with 2FA on, a key sign-in asks for no code; the password still does —');
    resetAdminAuthTarpit();
    const secret = generateTotpSecret();
    updateLocalConfig({ totpEnabled: true, totpSecret: secret, totpBackupCodesHashes: [] } as any);
    const right = () => generateTotpCode(secret);
    const wrong = () => {
        for (let n = 0; ; n++) {
            const c = String((Number(right()) + 123457 + n * 7919) % 1_000_000).padStart(6, '0');
            if (!verifyTotpCode(c, secret)) return c;
        }
    };
    const X = freshIp();

    const plain = await signIn(owner, X);
    assert(plain.status === 200 && typeof plain.json?.handshakeToken === 'string' && plain.json?.totpRequired === undefined,
        `an owner's key signs in with no code (${show(plain)})`);
    // An older app that still sends a code, even a wrong one, many times over: the code is not looked at, nothing is held.
    const many: number[] = [];
    for (let i = 0; i < 8; i++) many.push((await signIn(owner, X, wrong())).status);
    assert(many.every((s) => s === 200), `eight sign-ins carrying a wrong code all sign in: no code is checked, no brake (${many.join(',')})`);

    const bob = member('BobAdmin2fa');
    grantNodeRole(bob.pub, 'admin', owner.pub);
    const bobIn = await signIn(bob, X);
    assert(bobIn.status === 200 && typeof bobIn.json?.handshakeToken === 'string', `an admin's key signs in with no code (${show(bobIn)})`);
    const mo = member('MoModerator2fa');
    grantNodeRole(mo.pub, 'moderator', owner.pub);
    const moSession = await keySession(mo, freshIp());
    assert(!!moSession, 'a moderator\'s key opens a session with no code');

    // Without the key, nothing: a signature by another key under the owner's name is refused, and is not asked for a code.
    const c = (await req('/api/local/admin/auth/challenge', { method: 'POST', headers: viaTunnel(X) })).json;
    const forged = await req('/api/local/admin/auth/verify-challenge', {
        method: 'POST', headers: viaTunnel(X),
        body: { challengeId: c.challengeId, memberPubkey: owner.pub, signature: signText(bob, c.challenge) },
    });
    assert(forged.status !== 200 && !forged.json?.handshakeToken && forged.json?.totpRequired === undefined,
        `a signature by another key opens nothing (${show(forged)})`);

    // The QR pairing: the same.
    const pairing = (await req('/api/local/admin/auth/pairing', { method: 'POST', headers: viaTunnel(freshIp()), body: {} })).json;
    const qr = await req(`/api/local/admin/auth/pairing/${pairing.pairingId}/approve`, {
        method: 'POST', headers: viaTunnel(freshIp()),
        body: { memberPubkey: owner.pub, signature: signText(owner, pairingMessage('approve', pairing.pairingId, pairing.shortCode)) },
    });
    assert(qr.status === 200, `the QR sign-in approves with no code (${show(qr)})`);

    // The password path is exactly as before: the password alone opens nothing, the password and a code do.
    resetAdminAuthTarpit();
    const pwOnly = await req('/api/local/admin/auth/password', { method: 'POST', headers: viaTunnel(freshIp()), body: { password: PW } });
    assert(pwOnly.status === 401 && pwOnly.json?.totpRequired === true && !(pwOnly.headers.get('set-cookie') || '').includes('admin_session='),
        `the password alone is still asked for the code (${show(pwOnly)})`);
    const pwWrong = await req('/api/local/admin/auth/password', { method: 'POST', headers: viaTunnel(freshIp()), body: { password: PW, totpCode: wrong() } });
    assert(pwWrong.status === 401 && !(pwWrong.headers.get('set-cookie') || '').includes('admin_session='), `the password and a wrong code open nothing (${show(pwWrong)})`);
    const pwRight = await req('/api/local/admin/auth/password', { method: 'POST', headers: viaTunnel(freshIp()), body: { password: PW, totpCode: right() } });
    assert(pwRight.status === 200 && (pwRight.headers.get('set-cookie') || '').includes('admin_session='), `the password and the right code sign in (${show(pwRight)})`);

    updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] } as any);
    resetAdminAuthTarpit();
}

async function part3Redeem(owner: Key): Promise<void> {
    console.log('\n— 3. an invite redeem must be signed by the key it registers —');
    const codeUser = (code: string) => (db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(code) as { used_by: string | null } | undefined)?.used_by ?? null;
    const hasRow = (pk: string) => !!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(pk);
    const ticketOf = (inviter: Key) => {
        const p = JSON.stringify({ i: inviter.pub, t: Date.now() });
        return Buffer.from(JSON.stringify({ p, s: signText(inviter, p) })).toString('base64');
    };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => {
        const raw = JSON.stringify(body);
        return req(path, { method: 'POST', raw, headers: { ...headers, ...viaTunnel(freshIp()) } });
    };
    const signedBy = (k: Key, path: string, body: unknown) => {
        const raw = JSON.stringify(body);
        return req(path, { method: 'POST', raw, headers: { ...unboundHeaders(k, path, raw), ...viaTunnel(freshIp()) } });
    };

    const victim = stranger('Victim');   // a key held by someone else (a member of another community, say)
    const mallory = member('Mallory');   // holds an invite code here
    const code = generateInvite(owner.pub)!.code;
    const unsigned = await post('/api/invite/redeem', { code, publicKey: victim.pub, callsign: 'Official Admin' });
    assert(unsigned.status === 401 && unsigned.json?.code === 'redeem_unsigned' && !hasRow(victim.pub) && codeUser(code) === null,
        `an unsigned redeem naming someone else's key is refused; no member, the code unused (${show(unsigned)})`);
    const byMallory = await signedBy(mallory, '/api/invite/redeem', { code, publicKey: victim.pub, callsign: 'Official Admin' });
    assert(byMallory.status === 401 && !hasRow(victim.pub) && codeUser(code) === null, `so is one signed by another key (${show(byMallory)})`);
    const ticket = ticketOf(owner);
    const ticketUnsigned = await post('/api/invite/redeem-offline', { ticketB64: ticket, publicKey: victim.pub, callsign: 'Official Admin' });
    const ticketByMallory = await signedBy(mallory, '/api/invite/redeem-offline', { ticketB64: ticket, publicKey: victim.pub, callsign: 'Official Admin' });
    assert(ticketUnsigned.status === 401 && ticketByMallory.status === 401 && !hasRow(victim.pub),
        `the same for an offline ticket, unsigned or signed by another key (${ticketUnsigned.status}, ${ticketByMallory.status})`);

    // Signed by the key, but by a phone whose clock is ten minutes out: the verifier's own answer, not "unsigned".
    const skewed = stranger('SkewedClock');
    const skewedCode = generateInvite(owner.pub)!.code;
    const skewedRaw = JSON.stringify({ code: skewedCode, publicKey: skewed.pub, callsign: skewed.callsign });
    const skewedJoin = await req('/api/invite/redeem', { method: 'POST', raw: skewedRaw, headers: { ...unboundHeaders(skewed, '/api/invite/redeem', skewedRaw, Date.now() - 10 * 60_000), ...viaTunnel(freshIp()) } });
    assert(skewedJoin.status === 401 && /timestamp/i.test(skewedJoin.json?.error ?? '') && skewedJoin.json?.code !== 'redeem_unsigned' && !hasRow(skewed.pub) && codeUser(skewedCode) === null,
        `a redeem signed with a clock ten minutes out is refused with the verifier's answer, and nobody joins (${show(skewedJoin)})`);

    // A real join: the phone app's old-format signature (every version in the stores), and a current app's.
    const oldApp = stranger('OldApp');
    const oldJoin = await signedBy(oldApp, '/api/invite/redeem', { code, publicKey: oldApp.pub, callsign: oldApp.callsign });
    assert(oldJoin.status === 200 && oldJoin.json?.success === true && hasRow(oldApp.pub) && codeUser(code) === oldApp.pub,
        `an old app's signed redeem joins, and uses the code (${show(oldJoin)})`);
    const tj = stranger('TicketJoiner');
    const tjJoin = await signedBy(tj, '/api/invite/redeem-offline', { ticketB64: ticketOf(owner), publicKey: tj.pub, callsign: tj.callsign });
    assert(tjJoin.status === 200 && hasRow(tj.pub), `an old app's signed offline-ticket redeem joins (${show(tjJoin)})`);

    const core = await import('@beanpool/core');
    const bound = async (k: Key, host: string, path: string, body: unknown) => {
        const raw = JSON.stringify(body);
        const headers = await core.buildBoundRequestHeaders({ method: 'POST', url: `https://${host}${path}`, body: raw, publicKeyHex: k.pub, sign: core.ed25519Signer(k.priv) });
        return req(path, { method: 'POST', raw, headers: { ...headers, ...viaTunnel(freshIp()) } });
    };
    const newApp = stranger('NewApp');
    const newJoin = await bound(newApp, 'home.test', '/api/invite/redeem', { code: generateInvite(owner.pub)!.code, publicKey: newApp.pub, callsign: newApp.callsign });
    assert(newJoin.status === 200 && hasRow(newApp.pub), `a current app's redeem, signed for this community, joins (${show(newJoin)})`);
    const elsewhere = stranger('Elsewhere');
    const elsewhereCode = generateInvite(owner.pub)!.code;
    const forOther = await bound(elsewhere, 'other.test', '/api/invite/redeem', { code: elsewhereCode, publicKey: elsewhere.pub, callsign: elsewhere.callsign });
    assert(forOther.status === 421 && forOther.json?.code === 'wrong_community' && !hasRow(elsewhere.pub) && codeUser(elsewhereCode) === null,
        `one signed for another community is 421, and nobody joins (${show(forOther)})`);
}

async function main(): Promise<void> {
    console.log('Running the 2026-10-01 security follow-ups...\n');
    await initTls();
    initStateEngine();
    setTrustConfigForTests(undefined);
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, breakGlassMode: false, totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] } as any);
    setBreakGlassMode(false);
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    const httpPort = await startHttpServer(0);
    await startHttpsServer(0);
    BASE = `http://127.0.0.1:${httpPort}`;

    const owner = member('OwnerOlive');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');

    for (const [name, part] of [['1', part1BreakGlass], ['2', part2KeySignin2fa], ['3', part3Redeem]] as const) {
        try {
            await part(owner);
        } catch (e: any) {
            assert(false, `part ${name} ran to the end (${e?.stack || e})`);
        }
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
