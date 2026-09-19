/**
 * Sign in to /settings in a browser by scanning a QR code with the BeanPool app — over a REAL HTTPS round trip.
 *
 *   1. Happy path: browser pairing (binding cookie) → phone looks it up → signed approval → the browser's
 *      long-poll wakes and gets the same key session a key sign-in gets; the audit log names who approved.
 *   2. Bound to the browser: no binding cookie, or another pairing's, is refused — before and after approval —
 *      and does not use up the approval for the real browser.
 *   3. Single use: a second approval, a replayed approval (same body again, or on another pairing), and a
 *      second redemption are all refused.
 *   4. Signers: wrong key (signature by someone else), a member without a role (twice), an unknown key.
 *      A member without a role shows "not-admin" on the waiting page; five refusals burn the code.
 *      A moderator is let in (happy path), with a session that reaches reports and is refused everything else.
 *   5. Expiry: an expired pairing can be neither approved nor redeemed. A role revoked between approval and
 *      redemption gives no session.
 *   6. The node's 2FA code is still asked for, on the phone.
 *   7. Decline, and the brakes: creation per client, approvals through the auth limiter.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-settings-qr-signin.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, revokeNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateLocalConfig } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode } from './totp.js';
import {
    approvePairing,
    redeemPairing,
    pairingMessage,
    bindingCookieName,
    resetPairingsForTests,
    PAIRING_TTL_MS,
    PAIRING_CREATES_PER_MINUTE,
    PAIRING_MAX_REFUSALS,
} from './settings-signin-pairing.js';

const PORT = 8692;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
const signText = (who: Identity, text: string) => crypto.sign(null, Buffer.from(text), who.priv).toString('base64');

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

/** Every scenario comes from its own client address (loopback is a trusted proxy), so limiters don't bleed. */
let ipSeq = 10;
const freshIp = () => `203.0.113.${ipSeq++}`;
const via = (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': ip });

async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json, cookies: res.headers.getSetCookie(), headers: res.headers };
}

interface Browser { ip: string; pairingId: string; shortCode: string; cookie: string; expiresAt: number }

/** What the /settings page does: ask for a pairing, keep the binding cookie. */
async function newPairing(ip = freshIp(), userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'): Promise<Browser> {
    const r = await call('POST', '/api/local/admin/auth/pairing', { body: {}, headers: { ...via(ip), 'User-Agent': userAgent } });
    if (r.status !== 200) throw new Error(`pairing create failed: ${r.status} ${JSON.stringify(r.body)}`);
    const name = bindingCookieName(r.body.pairingId);
    const set = r.cookies.find(c => c.startsWith(`${name}=`)) || '';
    return { ip, pairingId: r.body.pairingId, shortCode: r.body.shortCode, cookie: set.split(';')[0], expiresAt: r.body.expiresAt };
}

/** The page's poll. `wait: false` answers at once. */
async function poll(b: Browser, opts: { cookie?: string | null; wait?: boolean } = {}) {
    const cookie = opts.cookie === undefined ? b.cookie : opts.cookie;
    const r = await call('POST', `/api/local/admin/auth/pairing/${b.pairingId}/wait`, {
        body: { wait: opts.wait ?? false },
        headers: { ...via(b.ip), ...(cookie ? { Cookie: cookie } : {}) },
    });
    const session = r.cookies.find(c => c.startsWith('admin_session='));
    return { ...r, sessionId: session ? session.split(';')[0].slice('admin_session='.length) : null };
}

/** What the app does after the phone's unlock. */
async function approve(pairingId: string, shortCode: string, signer: Identity, opts: { claimed?: string; totpCode?: string; ip?: string } = {}) {
    return call('POST', `/api/local/admin/auth/pairing/${pairingId}/approve`, {
        body: {
            memberPubkey: opts.claimed ?? signer.pub,
            signature: signText(signer, pairingMessage('approve', pairingId, shortCode)),
            ...(opts.totpCode ? { totpCode: opts.totpCode } : {}),
        },
        headers: via(opts.ip ?? freshIp()),
    });
}

async function sessionInfo(sessionId: string) {
    const res = await fetch(`${BASE}/api/local/admin/auth/session`, { headers: { Cookie: `admin_session=${sessionId}` } });
    return res.json() as Promise<any>;
}

function auditLines(): string[] {
    return (db.prepare(`SELECT message FROM system_logs WHERE category = 'AUTH' AND message LIKE '%Settings sign-in by phone%' ORDER BY id`).all() as { message: string }[]).map(r => r.message);
}

async function main() {
    console.log('Running settings sign-in by QR tests (real HTTPS)...\n');
    await initTls();
    initStateEngine();

    const owner = keypair();
    const admin = keypair();
    const moderator = keypair();
    const member = keypair();
    const outsider = keypair(); // never registered
    seedMember(owner.pub, 'qrOwner');
    seedMember(admin.pub, 'qrAdmin');
    seedMember(moderator.pub, 'qrMod');
    seedMember(member.pub, 'qrMember');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');
    grantNodeRole(admin.pub, 'admin', owner.pub);
    grantNodeRole(moderator.pub, 'moderator', owner.pub);
    updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false, communityName: 'QR Test' } as any);

    await startHttpsServer(PORT);

    // ── 1. Happy path ──
    console.log('\n1. Happy path');
    {
        const b = await newPairing();
        assert(/^[0-9a-f]{64}$/.test(b.pairingId), 'the pairing id is 32 random bytes');
        assert(/^[A-HJ-NP-Z2-9]{6}$/.test(b.shortCode), `the short code is 6 unambiguous characters (${b.shortCode})`);
        assert(b.cookie.startsWith(bindingCookieName(b.pairingId) + '='), 'the browser gets its binding cookie');
        const createCookie = (await call('POST', '/api/local/admin/auth/pairing', { body: {}, headers: via(freshIp()) })).cookies.join('\n');
        assert(/HttpOnly/i.test(createCookie) && /SameSite=Strict/i.test(createCookie) && /path=\/api\/local\/admin\/auth\/pairing/i.test(createCookie),
            'the binding cookie is httpOnly, SameSite=Strict and scoped to the pairing routes');
        assert(Math.abs(b.expiresAt - (Date.now() + PAIRING_TTL_MS)) < 5_000, 'the pairing lasts two minutes');

        const info = await call('GET', `/api/local/admin/auth/pairing/${b.pairingId}`, { headers: via(freshIp()) });
        assert(info.status === 200 && info.body.shortCode === b.shortCode, 'the phone looks up the same short code');
        assert(info.body.browser === 'Firefox on Windows', `the phone is told which browser asked (${info.body.browser})`);
        assert(!('secret' in info.body) && !JSON.stringify(info.body).includes(b.cookie.split('=')[1]), 'the lookup does not reveal the binding secret');

        const before = await poll(b);
        assert(before.status === 200 && before.body.status === 'waiting' && !before.sessionId, 'before approval the browser is waiting, with no session');

        // The page is long-polling when the phone approves: it must wake well before the 25 s poll ends.
        const t0 = Date.now();
        const longPoll = poll(b, { wait: true });
        await new Promise(r => setTimeout(r, 300));
        const ok = await approve(b.pairingId, b.shortCode, owner);
        assert(ok.status === 200 && ok.body.role === 'owner', `the owner approves (got ${ok.status})`);
        assert(!('handshakeToken' in (ok.body || {})), 'the phone is never given the sign-in token');
        const got = await longPoll;
        assert(Date.now() - t0 < 5_000, 'the long-poll wakes on approval');
        assert(got.status === 200 && got.body.status === 'signed-in' && got.body.role === 'owner' && got.body.memberPubkey === owner.pub,
            'the browser is signed in as the owner');
        assert(typeof got.body.csrfToken === 'string' && got.body.csrfToken.length > 0, 'with a CSRF token for cookie-authenticated changes');
        assert(!!got.sessionId, 'and the admin_session cookie');
        const s = await sessionInfo(got.sessionId!);
        assert(s.authenticated === true && s.isKeySession === true && s.role === 'owner', 'the session is the same kind a key sign-in gets');

        const lines = auditLines();
        assert(lines.some(l => l.includes('APPROVED by @qrOwner') && l.includes(b.pairingId.slice(0, 8))), 'the audit log names who approved, and which pairing');
        assert(lines.some(l => l.includes('browser signed in as @qrOwner') && l.includes(b.pairingId.slice(0, 8))), 'the audit log records the browser signing in');
        const logged = (db.prepare(`SELECT level FROM system_logs WHERE message LIKE '%APPROVED by @qrOwner%'`).get() as any)?.level;
        assert(logged === 'SECURITY', 'the approval is logged at SECURITY level');

        // An admin works the same way.
        const b2 = await newPairing();
        assert((await approve(b2.pairingId, b2.shortCode, admin)).status === 200, 'an admin can approve too');
        const got2 = await poll(b2);
        assert(got2.body.status === 'signed-in' && got2.body.role === 'admin', 'and the browser gets an admin session');

        // A moderator too: the browser gets a moderator session, which reaches reports and nothing else.
        const b3 = await newPairing();
        const modOk = await approve(b3.pairingId, b3.shortCode, moderator);
        assert(modOk.status === 200 && modOk.body.role === 'moderator', `a moderator can approve (got ${modOk.status})`);
        const got3 = await poll(b3);
        assert(got3.body.status === 'signed-in' && got3.body.role === 'moderator' && !!got3.sessionId, 'and the browser gets a moderator session');
        const s3 = await sessionInfo(got3.sessionId!);
        assert(s3.authenticated === true && s3.role === 'moderator', 'the session says moderator');
        const reports = await call('GET', '/api/local/admin/reports?status=open', { headers: { Cookie: `admin_session=${got3.sessionId}` } });
        assert(reports.status === 200 && Array.isArray(reports.body.reports), `the moderator session lists reports (got ${reports.status})`);
        const data = await call('POST', '/api/local/admin/data', { body: {}, headers: { Cookie: `admin_session=${got3.sessionId}`, 'X-CSRF-Token': got3.body.csrfToken } });
        assert(data.status === 403, `and is refused the members' data (got ${data.status})`);
    }

    // ── 2. Bound to the browser that asked ──
    console.log('\n2. Another browser cannot redeem the QR');
    {
        const b = await newPairing();
        const other = await newPairing();
        const noCookieBefore = await poll(b, { cookie: null });
        assert(noCookieBefore.status === 403 && noCookieBefore.body.status === 'wrong-browser', 'no binding cookie → refused while waiting');
        assert((await approve(b.pairingId, b.shortCode, owner)).status === 200, 'the owner approves the real pairing');
        const noCookie = await poll(b, { cookie: null });
        assert(noCookie.status === 403 && !noCookie.sessionId, 'a browser without the binding cookie is refused, with no session');
        const wrongCookie = await poll(b, { cookie: `${bindingCookieName(b.pairingId)}=${other.cookie.split('=')[1]}` });
        assert(wrongCookie.status === 403 && !wrongCookie.sessionId, "another pairing's secret under this name is refused");
        const forged = await poll(b, { cookie: `${bindingCookieName(b.pairingId)}=${'a'.repeat(64)}` });
        assert(forged.status === 403 && !forged.sessionId, 'a guessed secret is refused');
        const real = await poll(b);
        assert(real.body.status === 'signed-in' && !!real.sessionId, 'the browser that asked is still signed in afterwards');
        assert(auditLines().some(l => l.includes('without its binding secret') && l.includes(b.pairingId.slice(0, 8))), 'the attempt from another browser is logged');
    }

    // ── 3. Single use and replay ──
    console.log('\n3. Single use; the approval replayed');
    {
        const b = await newPairing();
        const body = {
            memberPubkey: owner.pub,
            signature: signText(owner, pairingMessage('approve', b.pairingId, b.shortCode)),
        };
        const first = await call('POST', `/api/local/admin/auth/pairing/${b.pairingId}/approve`, { body, headers: via(freshIp()) });
        assert(first.status === 200, 'the first approval is accepted');
        const again = await call('POST', `/api/local/admin/auth/pairing/${b.pairingId}/approve`, { body, headers: via(freshIp()) });
        assert(again.status === 409 && again.body.reason === 'used', `the same approval replayed is refused (got ${again.status})`);

        const b2 = await newPairing();
        const elsewhere = await call('POST', `/api/local/admin/auth/pairing/${b2.pairingId}/approve`, { body, headers: via(freshIp()) });
        assert(elsewhere.status === 403 && elsewhere.body.reason === 'bad-signature', 'an approval replayed on another pairing is refused (it names its pairing)');
        assert((await poll(b2)).body.status === 'waiting', 'and that other pairing is still waiting');

        const wrongCode = await call('POST', `/api/local/admin/auth/pairing/${b2.pairingId}/approve`, {
            body: { memberPubkey: owner.pub, signature: signText(owner, pairingMessage('approve', b2.pairingId, 'AAAAAA')) },
            headers: via(freshIp()),
        });
        assert(wrongCode.status === 403, 'an approval over a different short code is refused');

        const s1 = await poll(b);
        assert(s1.body.status === 'signed-in', 'the browser redeems once');
        const s2 = await poll(b);
        assert(s2.status === 410 && s2.body.status === 'used' && !s2.sessionId, 'a second redemption is refused');

        const lookupUsed = await call('GET', `/api/local/admin/auth/pairing/${b.pairingId}`, { headers: via(freshIp()) });
        assert(lookupUsed.status === 410, 'a used pairing cannot be looked up to approve');
    }

    // ── 4. Who may approve ──
    console.log('\n4. Signers');
    {
        const b = await newPairing();
        const wrongKey = await approve(b.pairingId, b.shortCode, member, { claimed: owner.pub });
        assert(wrongKey.status === 403 && wrongKey.body.reason === 'bad-signature', "a signature by another key under the owner's pubkey is refused");
        assert((await poll(b)).body.notice === undefined, 'a bad signature says nothing to the waiting page');

        const plain = await approve(b.pairingId, b.shortCode, member);
        assert(plain.status === 403 && plain.body.reason === 'not-admin', 'a member without a role is refused');
        const seen = await poll(b);
        assert(seen.body.status === 'waiting' && seen.body.notice === 'not-admin', 'the waiting page says the phone holds no role here, and keeps waiting');

        const plainAgain = await approve(b.pairingId, b.shortCode, member);
        assert(plainAgain.status === 403 && plainAgain.body.reason === 'not-admin', 'and again (a moderator is let in: see the happy path)');

        const stranger = await approve(b.pairingId, b.shortCode, outsider);
        assert(stranger.status === 403 && stranger.body.reason === 'inactive', 'an unknown key is refused');

        // That was four refusals; the fifth burns the code.
        assert(PAIRING_MAX_REFUSALS === 5, 'five refusals burn a pairing');
        await approve(b.pairingId, b.shortCode, member);
        const burned = await approve(b.pairingId, b.shortCode, owner);
        assert(burned.status === 410 && burned.body.reason === 'refused', 'after five refusals even the owner cannot approve that code');
        const burnedPoll = await poll(b);
        assert(burnedPoll.status === 410 && burnedPoll.body.status === 'refused', 'and the waiting page is told to get a new code');
    }

    // ── 5. Expiry, and a role revoked in between ──
    console.log('\n5. Expiry; role revoked between approval and redemption');
    {
        const b = await newPairing();
        const late = approvePairing({
            pairingId: b.pairingId,
            memberPubkey: owner.pub,
            signature: signText(owner, pairingMessage('approve', b.pairingId, b.shortCode)),
            now: Date.now() + PAIRING_TTL_MS + 1_000,
        });
        assert(!late.ok && late.reason === 'expired', 'an approval after two minutes is refused');
        const secret = b.cookie.split('=')[1];
        const lateRedeem = redeemPairing(b.pairingId, secret, Date.now() + PAIRING_TTL_MS + 1_000);
        assert(lateRedeem.kind === 'expired', 'an expired pairing tells the page so');

        // Approved, but the handshake token's 60 s has passed before the browser came back.
        const b2 = await newPairing();
        assert((await approve(b2.pairingId, b2.shortCode, owner)).status === 200, 'approved');
        const stale = redeemPairing(b2.pairingId, b2.cookie.split('=')[1], Date.now() + 61_000);
        assert(stale.kind === 'expired', 'a redemption after the 60 s sign-in token has lapsed gives no session');

        const b3 = await newPairing();
        assert((await approve(b3.pairingId, b3.shortCode, admin)).status === 200, 'the admin approves');
        revokeNodeRole(admin.pub, 'admin', owner.pub);
        const revoked = await poll(b3);
        assert(revoked.status === 401 && !revoked.sessionId, 'the admin lost the role before the browser redeemed → no session');
        grantNodeRole(admin.pub, 'admin', owner.pub);
    }

    // ── 6. The node's 2FA ──
    console.log("\n6. The node's 2FA code is asked for on the phone");
    {
        const secret = generateTotpSecret();
        updateLocalConfig({ totpEnabled: true, totpSecret: secret } as any);
        const b = await newPairing();
        const noCode = await approve(b.pairingId, b.shortCode, owner);
        assert(noCode.status === 401 && noCode.body.totpRequired === true, 'without the code the phone is asked for it');
        assert((await poll(b)).body.status === 'waiting', 'the pairing is still waiting');
        const wrong = await approve(b.pairingId, b.shortCode, owner, { totpCode: '000000' === generateTotpCode(secret) ? '111111' : '000000' });
        assert(wrong.status === 401 && wrong.body.totpRequired === true, 'a wrong code is refused');
        const right = await approve(b.pairingId, b.shortCode, owner, { totpCode: generateTotpCode(secret) });
        assert(right.status === 200, 'the right code approves');
        assert((await poll(b)).body.status === 'signed-in', 'and the browser is signed in');
        updateLocalConfig({ totpEnabled: false, totpSecret: null } as any);
    }

    // ── 7. Decline, and the brakes ──
    console.log('\n7. Decline; rate limits');
    {
        const b = await newPairing();
        const badDecline = await call('POST', `/api/local/admin/auth/pairing/${b.pairingId}/decline`, {
            body: { memberPubkey: owner.pub, signature: signText(member, pairingMessage('decline', b.pairingId, b.shortCode)) },
            headers: via(freshIp()),
        });
        assert(badDecline.status === 403, 'a decline with a wrong signature is refused');
        const decline = await call('POST', `/api/local/admin/auth/pairing/${b.pairingId}/decline`, {
            body: { memberPubkey: owner.pub, signature: signText(owner, pairingMessage('decline', b.pairingId, b.shortCode)) },
            headers: via(freshIp()),
        });
        assert(decline.status === 200, 'the phone declines');
        const after = await poll(b);
        assert(after.status === 410 && after.body.status === 'declined', 'the waiting page is told it was refused on the phone');
        assert((await approve(b.pairingId, b.shortCode, owner)).status === 409, 'a declined pairing cannot then be approved');

        resetPairingsForTests();
        const ip = freshIp();
        let lastOk = 0, limited: any = null;
        for (let i = 0; i < PAIRING_CREATES_PER_MINUTE + 1; i++) {
            const r = await call('POST', '/api/local/admin/auth/pairing', { body: {}, headers: via(ip) });
            if (r.status === 200) lastOk = i + 1; else { limited = r; break; }
        }
        assert(lastOk === PAIRING_CREATES_PER_MINUTE && limited?.status === 429, `creation is braked at ${PAIRING_CREATES_PER_MINUTE} a minute per client`);
        assert((await call('POST', '/api/local/admin/auth/pairing', { body: {}, headers: via(freshIp()) })).status === 200, 'another client is not affected');

        const target = await newPairing();
        const phoneIp = freshIp();
        let approveLimited = 0;
        for (let i = 0; i < 16; i++) {
            const r = await call('POST', `/api/local/admin/auth/pairing/${'0'.repeat(64)}/approve`, {
                body: { memberPubkey: owner.pub, signature: 'x' }, headers: via(phoneIp),
            });
            if (r.status === 429) approveLimited++;
        }
        assert(approveLimited >= 1, 'approvals from one client are braked by the auth limiter (15 a minute)');
        assert((await call('GET', `/api/local/admin/auth/pairing/${target.pairingId}`, { headers: via(phoneIp) })).status === 429,
            'and so are lookups from that client');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
