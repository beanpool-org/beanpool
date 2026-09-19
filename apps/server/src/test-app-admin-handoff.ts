/**
 * The app's "Manage <community>" entry — over a REAL HTTPS round trip through the signature middleware.
 *
 *   1. GET /api/node-admin/me answers only for the signing key: unsigned → 401, member → null,
 *      owner/admin → their role; a pubkey in the query cannot change whose role is answered.
 *   2. GET /api/node-admin/queue: owners/admins only; counts pending reports, stalled trades,
 *      emergency suspensions, removals in grace; each item carries its /settings section.
 *   3. The one-time sign-in link (challenge → signed → 60 s token → exchange):
 *      expiry, single use, wrong key, non-admin refused, role revoked between request and use,
 *      role CHANGED between request and use (session takes the live role), demoted mid-session,
 *      no actor from the body, and the node's own TOTP still applies on top.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-app-admin-handoff.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, revokeNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { consumeHandshakeToken, createAdminChallenge, verifyAndSolveChallenge } from './admin-key-auth.js';
import { updateLocalConfig } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode } from './totp.js';

const PORT = 8688;
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

/** A member-signed GET, exactly as the native app's signedGet sends it (the query is not signed). */
async function signedGet(path: string, signer?: Identity): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const signPath = path.split('?')[0];
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = signText(signer, `GET\n${signPath}\n${ts}\n${nonce}\n`);
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { headers });
    let body: any = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers };
}

/** What the app does: fetch a challenge, sign it with the member key, submit it. */
async function requestLink(signer: Identity, claimedPubkey = signer.pub, totpCode?: string) {
    const chal = await postJson('/api/local/admin/auth/challenge', {});
    return postJson('/api/local/admin/auth/verify-challenge', {
        challengeId: chal.body.challengeId,
        memberPubkey: claimedPubkey,
        signature: signText(signer, chal.body.challenge),
        ...(totpCode ? { totpCode } : {}),
    });
}

/** What /settings does with #handoff=<token>. Returns the session id and the cookie, if any. */
async function exchange(token: string, extraBody: Record<string, unknown> = {}) {
    const r = await postJson('/api/local/admin/auth/exchange', { token, ...extraBody });
    const cookie = r.headers.get('set-cookie') || '';
    const m = cookie.match(/admin_session=([0-9a-f]+)/);
    return { ...r, sessionId: m?.[1] ?? null };
}

async function sessionInfo(sessionId: string) {
    const res = await fetch(`${BASE}/api/local/admin/auth/session`, { headers: { Cookie: `admin_session=${sessionId}` } });
    return res.json() as Promise<any>;
}

async function main() {
    console.log('Running app → node /settings hand-off tests (real HTTPS)...\n');
    await initTls();
    initStateEngine();

    const owner = keypair();
    const owner2 = keypair();
    const admin = keypair();
    const member = keypair();
    const outsider = keypair(); // never registered
    seedMember(owner.pub, 'hoOwner');
    seedMember(owner2.pub, 'hoOwner2');
    seedMember(admin.pub, 'hoAdmin');
    seedMember(member.pub, 'hoMember');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');
    grantNodeRole(owner2.pub, 'owner', owner.pub);
    grantNodeRole(admin.pub, 'admin', owner.pub);
    updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false, communityName: 'Handoff Test' } as any);

    await startHttpsServer(PORT);

    // ── 1. Whose role ──
    console.log('\n1. GET /api/node-admin/me');
    {
        const anon = await signedGet('/api/node-admin/me');
        assert(anon.status === 401, `unsigned request is refused (got ${anon.status})`);
        const stranger = await signedGet('/api/node-admin/me', outsider);
        assert(stranger.status === 403, `a key that is not a member is refused (got ${stranger.status})`);
        const m = await signedGet('/api/node-admin/me', member);
        assert(m.status === 200 && m.body.role === null, 'a plain member is told they hold no role');
        const o = await signedGet('/api/node-admin/me', owner);
        assert(o.status === 200 && o.body.role === 'owner', 'the owner is told owner');
        assert(o.body.communityName === 'Handoff Test', 'the answer names the community for the button');
        const a = await signedGet('/api/node-admin/me', admin);
        assert(a.status === 200 && a.body.role === 'admin', 'an admin is told admin');
        const spoof = await signedGet(`/api/node-admin/me?pubkey=${owner.pub}&memberPubkey=${owner.pub}`, member);
        assert(spoof.status === 200 && spoof.body.role === null, "naming the owner's key in the query does not answer for them");
    }

    // ── 2. Admin queue ──
    console.log('\n2. GET /api/node-admin/queue');
    {
        const m = await signedGet('/api/node-admin/queue', member);
        assert(m.status === 403, `a plain member cannot read the admin queue (got ${m.status})`);
        const anon = await signedGet('/api/node-admin/queue');
        assert(anon.status === 401, 'unsigned queue read is refused');

        db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at)
                    VALUES ('ho-r1', ?, ?, NULL, 'spam', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(member.pub, admin.pub);
        db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at)
                    VALUES ('ho-r2', ?, ?, NULL, 'spam', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(admin.pub, member.pub);
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params,
                        franchise, status, opens_at, closes_at, created_at, updated_at)
                    VALUES ('ho-d1', 'SYSTEM', 'Keep x suspension?', 'd', 'member', 'keep_suspension', ?, '{}', '1m1v', 'open',
                        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'),
                        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(member.pub);

        const q = await signedGet('/api/node-admin/queue', admin);
        assert(q.status === 200, `an admin can read the queue (got ${q.status})`);
        const byKind = Object.fromEntries((q.body?.items || []).map((i: any) => [i.kind, i]));
        assert(byKind.reports?.count === 2, 'two open reports are counted');
        assert(byKind.reports?.settingsPath === '/settings#section=moderation', 'reports deep-link to the moderation section');
        assert(byKind.suspensions?.count === 1 && byKind.suspensions?.section === 'decisions', 'the open emergency suspension is counted, linked to decisions');
        assert(!byKind.disputes, 'kinds with nothing waiting are left out');
        assert(q.body.total === 3, `total is the sum of the counts (got ${q.body.total})`);
        assert(!JSON.stringify(q.body).includes(member.pub), 'the queue carries counts, not who is involved');
    }

    // ── 3. The one-time sign-in link ──
    console.log('\n3. One-time sign-in link');
    {
        // Happy path, and the session is the member — never 'owner:password'.
        const link = await requestLink(admin);
        assert(link.status === 200 && typeof link.body.handshakeToken === 'string', 'an admin signing the challenge gets a one-time token');
        assert(link.body.expiresAt - Date.now() <= 60_000, 'the token lives 60 seconds at most');
        const ex = await exchange(link.body.handshakeToken);
        assert(ex.status === 200 && !!ex.sessionId, 'the browser exchanges it for an admin session cookie');
        const info = await sessionInfo(ex.sessionId!);
        assert(info.authenticated === true && info.isKeySession === true, 'the session is a key session');
        assert(info.memberPubkey === admin.pub && info.role === 'admin', 'the session acts as the member who signed');
        const tfaWithSession = await fetch(`${BASE}/api/local/admin/2fa/status`, { headers: { Cookie: `admin_session=${ex.sessionId}` } });
        assert(tfaWithSession.status === 200, `/settings can read its 2FA status under the key session (got ${tfaWithSession.status})`);
        const tfaBogus = await fetch(`${BASE}/api/local/admin/2fa/status`, { headers: { Cookie: 'admin_session=deadbeef' } });
        assert(tfaBogus.status === 401, `…but not with a made-up session (got ${tfaBogus.status})`);

        // Single use.
        const replay = await exchange(link.body.handshakeToken);
        assert(replay.status === 401 && replay.body.replay === true && !replay.sessionId, 'the same token cannot be used twice');

        // Expiry (the store is in this process, so time can be moved forward directly).
        const late = await requestLink(admin);
        const lateRes = consumeHandshakeToken(late.body.handshakeToken, Date.now() + 61_000);
        assert(lateRes.ok === false && lateRes.expired === true, 'a token older than 60 s is refused');

        // Wrong key: signed by a plain member while claiming the owner's key.
        const wrong = await requestLink(member, owner.pub);
        assert(wrong.status === 403 && !wrong.body.handshakeToken, 'a challenge signed with a different key than the one claimed is refused');
        const wrong2 = await requestLink(admin, owner.pub);
        assert(wrong2.status === 403 && !wrong2.body.handshakeToken, "an admin cannot sign in as the owner by naming the owner's key");

        // Non-admin refused.
        const plain = await requestLink(member);
        assert(plain.status === 403 && !plain.body.handshakeToken, 'a member with no node role gets no link');
        const stranger = await requestLink(outsider);
        assert(stranger.status === 403 && !stranger.body.handshakeToken, 'a key that is not a member gets no link');

        // Role revoked between request and use.
        const beforeRevoke = await requestLink(admin);
        revokeNodeRole(admin.pub, 'admin', owner.pub);
        const afterRevoke = await exchange(beforeRevoke.body.handshakeToken);
        assert(afterRevoke.status === 401 && !afterRevoke.sessionId, 'a link issued before the role was revoked no longer signs in');
        const oldSession = await sessionInfo(ex.sessionId!);
        assert(oldSession.authenticated === false, "and the admin's existing session stops working too");
        grantNodeRole(admin.pub, 'admin', owner.pub);

        // Role CHANGED between request and use: owner → admin by revoke + grant, which leaves session_epoch
        // at 0 both times. The session must carry the live role, not the one recorded at issue.
        const ownerLink = await requestLink(owner2);
        assert(ownerLink.body.role === 'owner', 'second owner is issued a link as owner');
        revokeNodeRole(owner2.pub, 'owner', owner.pub);
        grantNodeRole(owner2.pub, 'admin', owner.pub);
        const demoted = await exchange(ownerLink.body.handshakeToken);
        assert(demoted.status === 200 && demoted.body.role === 'admin', `demoted before use → session role is admin (got ${demoted.body?.role})`);
        const demotedInfo = await sessionInfo(demoted.sessionId!);
        assert(demotedInfo.role === 'admin', 'the session reports the live role');

        // Demoted mid-session: an owner-only route must stop working at once.
        revokeNodeRole(owner2.pub, 'admin', owner.pub);
        grantNodeRole(owner2.pub, 'owner', owner.pub);
        const o2 = await exchange((await requestLink(owner2)).body.handshakeToken);
        const csrf = o2.body.csrfToken;
        const asOwner = await postJson('/api/local/admin/auth/break-glass-mode', { enabled: false },
            { Cookie: `admin_session=${o2.sessionId}`, 'X-CSRF-Token': csrf });
        assert(asOwner.status === 200, `an owner session can use an owner-only route (got ${asOwner.status})`);
        revokeNodeRole(owner2.pub, 'owner', owner.pub);
        grantNodeRole(owner2.pub, 'admin', owner.pub);
        const asDemoted = await postJson('/api/local/admin/auth/break-glass-mode', { enabled: false },
            { Cookie: `admin_session=${o2.sessionId}`, 'X-CSRF-Token': csrf });
        assert(asDemoted.status === 403, `after demotion the same session is refused the owner-only route (got ${asDemoted.status})`);

        // No actor from the body: the exchange ignores any identity it is sent.
        const adminLink = await requestLink(admin);
        const spoofed = await exchange(adminLink.body.handshakeToken, { memberPubkey: owner.pub, actor: owner.pub, role: 'owner' });
        assert(spoofed.status === 200 && spoofed.body.memberPubkey === admin.pub && spoofed.body.role === 'admin',
            'identity fields in the exchange body are ignored');
        const spoofedInfo = await sessionInfo(spoofed.sessionId!);
        assert(spoofedInfo.memberPubkey === admin.pub, 'the resulting session is still the signer');
        const enrolAsOwner = await postJson('/api/local/admin/auth/enrol', { memberPubkey: member.pub, role: 'owner' },
            { Cookie: `admin_session=${spoofed.sessionId}`, 'X-CSRF-Token': spoofed.body.csrfToken });
        assert(enrolAsOwner.status === 403, 'an admin session cannot act as owner whatever the body says');

        // The node's own 2FA still applies on top of the key.
        const secret = generateTotpSecret();
        updateLocalConfig({ totpEnabled: true, totpSecret: secret } as any);
        const noCode = await requestLink(owner);
        assert(noCode.status === 401 && noCode.body.totpRequired === true && !noCode.body.handshakeToken,
            'with 2FA on, a correctly signed request without a code gets no link');
        const badCode = await requestLink(owner, owner.pub, '000000' === generateTotpCode(secret) ? '111111' : '000000');
        assert(badCode.status === 401 && !badCode.body.handshakeToken, 'a wrong 2FA code gets no link');
        const withCode = await requestLink(owner, owner.pub, generateTotpCode(secret));
        assert(withCode.status === 200 && typeof withCode.body.handshakeToken === 'string', 'the right 2FA code does');
        updateLocalConfig({ totpEnabled: false, totpSecret: null } as any);

        // Sanity: the direct API agrees about the wrong-key case (no HTTP in between).
        const c = createAdminChallenge();
        const direct = verifyAndSolveChallenge({ challengeId: c.challengeId, memberPubkey: owner.pub, signature: signText(member, c.challenge) });
        assert(direct.ok === false && !direct.handshakeToken, 'verifyAndSolveChallenge refuses a signature from another key');
    }

    console.log(`\nApp admin hand-off suite: ${passed}/${run} assertions passed.`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
