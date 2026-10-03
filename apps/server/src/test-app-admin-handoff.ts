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
 *   4. The hand-off's session locks after 15 minutes idle (PHONE_HANDOFF_IDLE_TTL_MS), through the exchange and an
 *      older app's GET /settings?token=; a session made any other way keeps the 2-hour idle limit.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-app-admin-handoff.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, revokeNodeRole, adminSendMessage } from './state-engine.js';
import { getFirstNodeAdminPubkey } from './engine/node-roles.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { consumeHandshakeToken, createAdminChallenge, verifyAndSolveChallenge, validateAdminSession, PHONE_HANDOFF_IDLE_TTL_MS, SESSION_IDLE_TTL_MS, PHONE_STEP_UP_WINDOW_MS, backdateAdminSessionForTests } from './admin-key-auth.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode } from './totp.js';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';

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

    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

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

        // The node's 2FA code is the password's second factor, not a key's (decision D2, 2026-10-03): the phone's own
        // unlock is the key's. With 2FA on, a key sign-in asks for no code, from an owner, an admin or a moderator.
        const secret = generateTotpSecret();
        updateLocalConfig({ totpEnabled: true, totpSecret: secret } as any);
        const moderator = keypair();
        seedMember(moderator.pub, 'hoModerator');
        grantNodeRole(moderator.pub, 'moderator', admin.pub);
        for (const [who, k, role] of [['an owner', owner, 'owner'], ['an admin', admin, 'admin'], ['a moderator', moderator, 'moderator']] as const) {
            const noCode = await requestLink(k);
            assert(noCode.status === 200 && typeof noCode.body.handshakeToken === 'string' && noCode.body.totpRequired === undefined && noCode.body.role === role,
                `with 2FA on, ${who}'s correctly signed request gets a link without a code (got ${noCode.status} ${JSON.stringify(noCode.body)})`);
            const ex = await exchange(noCode.body.handshakeToken);
            assert(ex.status === 200 && !!ex.sessionId && (await sessionInfo(ex.sessionId!)).role === role, `…and ${who}'s link opens a ${role} session`);
        }
        // An old app that still sends a code: the code is not looked at, right or wrong.
        const staleCode = await requestLink(owner, owner.pub, '000000' === generateTotpCode(secret) ? '111111' : '000000');
        assert(staleCode.status === 200 && typeof staleCode.body.handshakeToken === 'string', 'a code sent by an older app is ignored');
        // Without the key there is still nothing: 2FA on or off, a signature by another key, or none, gets no link.
        const forged = await requestLink(member, owner.pub);
        assert(forged.status !== 200 && !forged.body.handshakeToken && forged.body.totpRequired === undefined,
            `with 2FA on, a request for the owner signed by another key gets no link and is not asked for a code (got ${forged.status})`);
        const chalNoSig = await postJson('/api/local/admin/auth/challenge', {});
        const noSig = await postJson('/api/local/admin/auth/verify-challenge', { challengeId: chalNoSig.body.challengeId, memberPubkey: owner.pub, signature: '' });
        assert(noSig.status !== 200 && !noSig.body.handshakeToken, `an unsigned request gets no link (got ${noSig.status})`);
        revokeNodeRole(moderator.pub, 'moderator', admin.pub);
        updateLocalConfig({ totpEnabled: false, totpSecret: null } as any);

        // Sanity: the direct API agrees about the wrong-key case (no HTTP in between).
        const c = createAdminChallenge();
        const direct = verifyAndSolveChallenge({ challengeId: c.challengeId, memberPubkey: owner.pub, signature: signText(member, c.challenge) });
        assert(direct.ok === false && !direct.handshakeToken, 'verifyAndSolveChallenge refuses a signature from another key');
    }

    // ── 4. The hand-off's session locks itself after a short idle ──
    // The phone opens it in its in-app browser, which App Lock can't cover on Android (deciding review of #1413).
    console.log('\n4. Phone hand-off session idle limit');
    {
        assert(PHONE_HANDOFF_IDLE_TTL_MS === 15 * 60_000, 'the phone hand-off idle limit is 15 minutes');
        const MIN = 60_000;
        const t0 = Date.now();
        const ex = await exchange((await requestLink(admin)).body.handshakeToken);
        assert(ex.status === 200 && !!ex.sessionId, 'the hand-off exchange signs in');
        const idleLeft = ex.body.idleExpiresAt - t0;
        assert(idleLeft > 14 * MIN && idleLeft <= 15 * MIN + 5_000, `its idle limit is 15 minutes, not 2 hours (got ${Math.round(idleLeft / MIN)} min)`);
        const info = await sessionInfo(ex.sessionId!);
        assert(info.authenticated === true, 'the session works now');
        assert(validateAdminSession(ex.sessionId!, t0 + 14 * MIN).valid === true, 'used again within 15 minutes: still signed in');
        assert(validateAdminSession(ex.sessionId!, t0 + 28 * MIN).valid === true, 'each use slides the 15 minutes on');
        const idle = validateAdminSession(ex.sessionId!, t0 + 28 * MIN + 16 * MIN);
        assert(idle.valid === false && idle.idleTimeout === true, '16 minutes unused: signed out');
        assert(/15 min idle/.test(idle.error ?? ''), `the reason names the 15 minutes (got "${idle.error}")`);
        const after = await sessionInfo(ex.sessionId!);
        assert(after.authenticated === false, 'and the node no longer accepts the cookie');

        // An older app's GET /settings?token=… is the same hand-off.
        const legacyLink = await requestLink(admin);
        const legacy = await fetch(`${BASE}/settings?token=${legacyLink.body.handshakeToken}`, { redirect: 'manual' });
        const legacyId = (legacy.headers.get('set-cookie') || '').match(/admin_session=([0-9a-f]+)/)?.[1] ?? null;
        assert(legacy.status === 302 && !!legacyId, `GET /settings?token= signs in (got ${legacy.status})`);
        const tl = Date.now();
        assert(validateAdminSession(legacyId!, tl + 14 * MIN).valid === true, 'GET /settings?token=: still signed in at 14 minutes');
        assert(validateAdminSession(legacyId!, tl + 14 * MIN + 16 * MIN).valid === false, 'GET /settings?token=: signed out after 16 minutes unused');

        // Any other sign-in (the desktop "Sign in with your phone" pairing redeems with no option) keeps 2 hours.
        const direct = consumeHandshakeToken((await requestLink(admin)).body.handshakeToken);
        assert(direct.ok === true && direct.idleExpiresAt! - Date.now() > SESSION_IDLE_TTL_MS - MIN, 'a session made without the hand-off keeps the 2-hour idle limit');
        assert(validateAdminSession(direct.sessionId!, Date.now() + 60 * MIN).valid === true, '…and is still signed in after an hour unused');
        // The option can only shorten it.
        const longer = consumeHandshakeToken((await requestLink(admin)).body.handshakeToken, Date.now(), { idleTtlMs: 48 * 60 * MIN });
        assert(longer.ok === true && longer.idleExpiresAt! - Date.now() <= SESSION_IDLE_TTL_MS, 'an idle limit longer than 2 hours is never granted');
    }

    // ── 5. Owner-only changes from the phone need a recent unlock (decision D2's step-up, 2026-10-03) ──
    // With no 2FA code on a key sign-in, a phone taken while Settings is open must not be enough to change who owns the
    // community or how it is kept safe: those need the phone's lock again, given within the last few minutes.
    console.log('\n5. Owner-only changes from a phone hand-off need a recent unlock');
    {
        assert(PHONE_STEP_UP_WINDOW_MS === 5 * 60_000, 'the step-up window is 5 minutes');
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const target = keypair();
        seedMember(target.pub, 'hoStepUp');
        const phone = await exchange((await requestLink(owner)).body.handshakeToken);
        assert(phone.status === 200 && !!phone.sessionId, 'Manage opens Settings on the phone');
        const grantFresh = await postJson('/api/local/admin/node-roles', { pubkey: target.pub, role: 'owner' }, as(phone));
        assert(grantFresh.status === 200, `just after the phone's unlock, an owner grant works (got ${grantFresh.status} ${JSON.stringify(grantFresh.body)})`);
        revokeNodeRole(target.pub, 'owner', owner.pub);

        backdateAdminSessionForTests(phone.sessionId!, 6 * 60_000);
        const grantStale = await postJson('/api/local/admin/node-roles', { pubkey: target.pub, role: 'owner' }, as(phone));
        assert(grantStale.status === 403 && grantStale.body.code === 'step_up_required' && /Manage/.test(grantStale.body.error ?? ''),
            `six minutes on, an owner grant asks for the phone's unlock again (got ${grantStale.status} ${JSON.stringify(grantStale.body)})`);
        assert(!db.prepare("SELECT 1 FROM node_roles WHERE member_pubkey = ? AND role = 'owner'").get(target.pub), '…and grants nothing');
        const enrolStale = await postJson('/api/local/admin/auth/enrol', { memberPubkey: target.pub, role: 'owner' }, as(phone));
        assert(enrolStale.status === 403 && enrolStale.body.code === 'step_up_required', `so does enrolling an owner key (got ${enrolStale.status})`);
        const otherOwner = keypair();
        seedMember(otherOwner.pub, 'hoOtherOwner');
        grantNodeRole(otherOwner.pub, 'owner', owner.pub);
        const revokeStale = await fetch(`${BASE}/api/local/admin/node-roles/${otherOwner.pub}/owner`, { method: 'DELETE', headers: as(phone) });
        assert(revokeStale.status === 403 && ((await revokeStale.json()) as any).code === 'step_up_required', `so does taking another owner's role (got ${revokeStale.status})`);
        revokeNodeRole(otherOwner.pub, 'owner', owner.pub);
        const tfaStale = await postJson('/api/local/admin/2fa/setup', {}, as(phone));
        assert(tfaStale.status === 403 && tfaStale.body.code === 'step_up_required', `so does any other owner-only change, e.g. 2FA setup (got ${tfaStale.status})`);
        // Everything else goes on as before: an owner's everyday work, and reading Settings.
        const modStale = await postJson('/api/local/admin/node-roles', { pubkey: target.pub, role: 'moderator' }, as(phone));
        assert(modStale.status === 200, `a moderator grant (not owner-only) still works (got ${modStale.status})`);
        revokeNodeRole(target.pub, 'moderator', owner.pub);
        assert((await sessionInfo(phone.sessionId!)).authenticated === true, 'the session is not ended: only owner-only changes wait');

        // Manage again: the phone asks its lock, and the new session may.
        const again = await exchange((await requestLink(owner)).body.handshakeToken);
        const grantAgain = await postJson('/api/local/admin/node-roles', { pubkey: target.pub, role: 'owner' }, as(again));
        assert(grantAgain.status === 200, `after Manage again, the owner grant works (got ${grantAgain.status})`);
        revokeNodeRole(target.pub, 'owner', owner.pub);

        // A computer's session (the QR pairing; any sign-in that is not the phone's own hand-off) is not a phone left open.
        const computer = consumeHandshakeToken((await requestLink(owner)).body.handshakeToken);
        assert(computer.ok === true, 'a computer session opens');
        backdateAdminSessionForTests(computer.sessionId!, 6 * 60_000);
        const grantComputer = await postJson('/api/local/admin/node-roles', { pubkey: target.pub, role: 'owner' }, { Cookie: `admin_session=${computer.sessionId}`, 'X-CSRF-Token': computer.csrfToken! });
        assert(grantComputer.status === 200, `a computer's session six minutes on is not asked (got ${grantComputer.status} ${JSON.stringify(grantComputer.body)})`);
        revokeNodeRole(target.pub, 'owner', owner.pub);
    }

    // ── 6. Every change that needs an owner is asked, not only the ones that name 'owner' (review 4172055076) ──
    // Demoting a co-owner to admin or moderator removes their ownership; granting, revoking or enrolling an admin and
    // switching break-glass mode are owner-only too. From a phone left open past the window, each waits for Manage again.
    console.log('\n6. Demoting an owner, admin changes and break-glass mode from a stale phone session');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const isStepUp = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'step_up_required';
        const coOwner = keypair();
        seedMember(coOwner.pub, 'hoCoOwner');
        grantNodeRole(coOwner.pub, 'owner', owner.pub);
        const member = keypair();
        seedMember(member.pub, 'hoMember6');
        const anAdmin = keypair();
        seedMember(anAdmin.pub, 'hoAdmin6');
        grantNodeRole(anAdmin.pub, 'admin', owner.pub);

        const stale = await exchange((await requestLink(owner)).body.handshakeToken);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const toAdmin = await postJson('/api/local/admin/node-roles', { pubkey: coOwner.pub, role: 'admin' }, as(stale));
        assert(isStepUp(toAdmin), `demoting a co-owner to admin asks for the phone's unlock (got ${toAdmin.status} ${JSON.stringify(toAdmin.body)})`);
        const toMod = await postJson('/api/local/admin/node-roles', { pubkey: coOwner.pub, role: 'moderator' }, as(stale));
        assert(isStepUp(toMod), `demoting a co-owner to moderator asks too (got ${toMod.status} ${JSON.stringify(toMod.body)})`);
        assert(roleOf(coOwner.pub) === 'owner', `…and the co-owner is still an owner (got ${roleOf(coOwner.pub)})`);
        const grantAdmin = await postJson('/api/local/admin/node-roles', { pubkey: member.pub, role: 'admin' }, as(stale));
        assert(isStepUp(grantAdmin) && roleOf(member.pub) === null, `granting admin asks and grants nothing (got ${grantAdmin.status} ${JSON.stringify(grantAdmin.body)})`);
        const revokeAdminRes = await fetch(`${BASE}/api/local/admin/node-roles/${anAdmin.pub}/admin`, { method: 'DELETE', headers: as(stale) });
        const revokeAdminBody = (await revokeAdminRes.json()) as any;
        assert(isStepUp({ status: revokeAdminRes.status, body: revokeAdminBody }) && roleOf(anAdmin.pub) === 'admin',
            `revoking an admin asks and keeps the role (got ${revokeAdminRes.status} ${JSON.stringify(revokeAdminBody)})`);
        const enrolAdmin = await postJson('/api/local/admin/auth/enrol', { memberPubkey: member.pub, role: 'admin' }, as(stale));
        assert(isStepUp(enrolAdmin) && roleOf(member.pub) === null, `enrolling an admin key asks and grants nothing (got ${enrolAdmin.status} ${JSON.stringify(enrolAdmin.body)})`);
        const bgOn = await postJson('/api/local/admin/auth/break-glass-mode', { enabled: true }, as(stale));
        assert(isStepUp(bgOn) && getLocalConfig().breakGlassMode !== true, `turning break-glass mode on asks and changes nothing (got ${bgOn.status} ${JSON.stringify(bgOn.body)})`);
        updateLocalConfig({ breakGlassMode: true } as any);
        const bgOff = await postJson('/api/local/admin/auth/break-glass-mode', { enabled: false }, as(stale));
        assert(isStepUp(bgOff) && getLocalConfig().breakGlassMode === true, `turning it off asks too (got ${bgOff.status} ${JSON.stringify(bgOff.body)})`);
        updateLocalConfig({ breakGlassMode: false } as any);

        // Manage again: each goes through.
        const fresh = await exchange((await requestLink(owner)).body.handshakeToken);
        const freshDemote = await postJson('/api/local/admin/node-roles', { pubkey: coOwner.pub, role: 'admin' }, as(fresh));
        assert(freshDemote.status === 200 && roleOf(coOwner.pub) === 'admin', `after Manage again, demoting a co-owner works (got ${freshDemote.status} ${JSON.stringify(freshDemote.body)})`);
        const freshRevoke = await fetch(`${BASE}/api/local/admin/node-roles/${anAdmin.pub}/admin`, { method: 'DELETE', headers: as(fresh) });
        assert(freshRevoke.status === 200 && roleOf(anAdmin.pub) === null, `…revoking an admin works (got ${freshRevoke.status})`);
        const freshEnrol = await postJson('/api/local/admin/auth/enrol', { memberPubkey: member.pub, role: 'admin' }, as(fresh));
        assert(freshEnrol.status === 200 && roleOf(member.pub) === 'admin', `…enrolling an admin key works (got ${freshEnrol.status} ${JSON.stringify(freshEnrol.body)})`);
        const freshBgOn = await postJson('/api/local/admin/auth/break-glass-mode', { enabled: true }, as(fresh));
        assert(freshBgOn.status === 200 && freshBgOn.body.breakGlassMode === true, `…break-glass mode on works (got ${freshBgOn.status})`);
        const freshBgOff = await postJson('/api/local/admin/auth/break-glass-mode', { enabled: false }, as(fresh));
        assert(freshBgOff.status === 200 && freshBgOff.body.breakGlassMode === false, `…and off (got ${freshBgOff.status})`);
        revokeNodeRole(member.pub, 'admin', owner.pub);
        revokeNodeRole(coOwner.pub, 'admin', owner.pub);

        // An admin's own work is not owner-only: appointing a moderator from a stale phone session is not asked.
        const adminStale = await exchange((await requestLink(admin)).body.handshakeToken);
        assert(adminStale.status === 200, 'an admin opens Settings on the phone');
        backdateAdminSessionForTests(adminStale.sessionId!, 6 * 60_000);
        const modByAdmin = await postJson('/api/local/admin/node-roles', { pubkey: member.pub, role: 'moderator' }, as(adminStale));
        assert(modByAdmin.status === 200 && roleOf(member.pub) === 'moderator', `an admin appoints a moderator six minutes on, unasked (got ${modByAdmin.status} ${JSON.stringify(modByAdmin.body)})`);
        const unmodByAdmin = await fetch(`${BASE}/api/local/admin/node-roles/${member.pub}/moderator`, { method: 'DELETE', headers: as(adminStale) });
        assert(unmodByAdmin.status === 200 && roleOf(member.pub) === null, `…and removes one, unasked (got ${unmodByAdmin.status})`);
    }

    // ── 7. Owner-only reads Settings sends as POST are not asked (review 4172055077) ──
    console.log('\n7. Owner-only reads sent as POST from a stale phone session');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const stale = await exchange((await requestLink(owner)).body.handshakeToken);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const status = await postJson('/api/local/admin/offbox-backups/status', {}, as(stale));
        assert(status.status === 200, `the off-box card's status reads six minutes on (got ${status.status} ${JSON.stringify(status.body)})`);
        const list = await postJson('/api/local/admin/offbox-backups/list', { destination: 'no-such-destination' }, as(stale));
        assert(list.status === 404, `its list reads too: past the step-up to "no such destination" (got ${list.status} ${JSON.stringify(list.body)})`);
        const standby = await postJson('/api/local/admin/standby-health', {}, as(stale));
        assert(standby.status === 200, `the standby banner reads (got ${standby.status} ${JSON.stringify(standby.body)})`);
        // A change on the same card still asks.
        const settings = await postJson('/api/local/admin/offbox-backups/settings', { intervalHours: 24 }, as(stale));
        assert(settings.status === 403 && settings.body.code === 'step_up_required', `changing its settings still asks (got ${settings.status} ${JSON.stringify(settings.body)})`);
    }

    // ── 8. The owner-only bulk downloads are asked although they are GETs (review 4172055079) ──
    // A snapshot is the whole community (readable when the node has no recovery code); so is an off-box backup.
    console.log('\n8. Snapshot and off-box downloads from a stale phone session');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const get = async (path: string, headers: Record<string, string>) => {
            const res = await fetch(`${BASE}${path}`, { headers });
            return { status: res.status, body: await res.json().catch(() => null) as any };
        };
        const downloads = [
            '/api/local/admin/snapshots/download?name=no-such-snapshot.db',
            '/api/local/admin/offbox-backups/download?destination=no-such-destination&key=x',
        ];
        const stale = await exchange((await requestLink(owner)).body.handshakeToken);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const fresh = await exchange((await requestLink(owner)).body.handshakeToken);
        for (const path of downloads) {
            const old = await get(path, as(stale));
            assert(old.status === 403 && old.body?.code === 'step_up_required', `${path} six minutes on asks for the phone's unlock (got ${old.status} ${JSON.stringify(old.body)})`);
            const now = await get(path, as(fresh));
            assert(now.status !== 403, `${path} just after Manage passes the step-up (got ${now.status} ${JSON.stringify(now.body)})`);
        }
    }

    // ── 9. Suspending an owner, and lifting, halting or speeding up what gives back or takes an owner's or admin's role
    // (confirm 1, 4172121241): owner-only in the engine, so asked from a stale phone session, whatever the route. ──
    console.log('\n9. Suspend, lift, halt and accelerate on an owner or admin from a stale phone session');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status ?? null;
        const isStepUp = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'step_up_required';
        const reason = { reason: 'Testing the step-up on suspensions' };
        const coOwner = keypair();
        seedMember(coOwner.pub, 'hoCoOwner9');
        grantNodeRole(coOwner.pub, 'owner', owner.pub);

        const stale = await exchange((await requestLink(owner)).body.handshakeToken);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const fresh = await exchange((await requestLink(owner)).body.handshakeToken);

        const suspendStale = await postJson(`/api/local/admin/users/${coOwner.pub}/suspend`, reason, as(stale));
        assert(isStepUp(suspendStale) && roleOf(coOwner.pub) === 'owner' && statusOf(coOwner.pub) === 'active',
            `suspending a co-owner asks, and they stay an active owner (got ${suspendStale.status} ${JSON.stringify(suspendStale.body)})`);
        const suspendFresh = await postJson(`/api/local/admin/users/${coOwner.pub}/suspend`, reason, as(fresh));
        assert(suspendFresh.status === 200 && statusOf(coOwner.pub) === 'disabled' && roleOf(coOwner.pub) === null,
            `after Manage again, suspending a co-owner works (got ${suspendFresh.status} ${JSON.stringify(suspendFresh.body)})`);
        const keepId: string = suspendFresh.body?.decision?.id;

        const liftStale = await postJson(`/api/local/admin/users/${coOwner.pub}/status`, { status: 'active' }, as(stale));
        assert(isStepUp(liftStale) && statusOf(coOwner.pub) === 'disabled' && roleOf(coOwner.pub) === null,
            `lifting it, which gives the owner role back, asks and changes nothing (got ${liftStale.status} ${JSON.stringify(liftStale.body)})`);
        const haltStale = await postJson(`/api/local/admin/decisions/${keepId}/halt`, reason, as(stale));
        assert(isStepUp(haltStale) && statusOf(coOwner.pub) === 'disabled' && roleOf(coOwner.pub) === null,
            `halting the keep-suspension vote, which gives it back too, asks (got ${haltStale.status} ${JSON.stringify(haltStale.body)})`);
        const liftFresh = await postJson(`/api/local/admin/users/${coOwner.pub}/status`, { status: 'active' }, as(fresh));
        assert(liftFresh.status === 200 && statusOf(coOwner.pub) === 'active' && roleOf(coOwner.pub) === 'owner',
            `after Manage again, lifting it works and the owner role is back (got ${liftFresh.status} ${JSON.stringify(liftFresh.body)})`);
        const suspendAgain = await postJson(`/api/local/admin/users/${coOwner.pub}/suspend`, reason, as(fresh));
        const haltFresh = await postJson(`/api/local/admin/decisions/${suspendAgain.body?.decision?.id}/halt`, reason, as(fresh));
        assert(haltFresh.status === 200 && roleOf(coOwner.pub) === 'owner', `…and so does halting the vote (got ${haltFresh.status} ${JSON.stringify(haltFresh.body)})`);

        // A removal of an admin in its grace window: cutting it short is owner-only.
        const leaving = keypair();
        seedMember(leaving.pub, 'hoLeaving9');
        grantNodeRole(leaving.pub, 'admin', owner.pub);
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params,
                        franchise, status, opens_at, closes_at, created_at, updated_at)
                    VALUES ('ho-d9', 'SYSTEM', 'Remove x?', 'd', 'member', 'remove_member', ?, '{}', '1m1v', 'execution_pending_grace',
                        strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days'),
                        strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(leaving.pub);
        const accelStale = await postJson('/api/local/admin/decisions/ho-d9/accelerate', {}, as(stale));
        const d9 = () => (db.prepare("SELECT status FROM decisions WHERE id = 'ho-d9'").get() as any)?.status;
        assert(isStepUp(accelStale) && d9() === 'execution_pending_grace' && roleOf(leaving.pub) === 'admin',
            `cutting short an admin's removal asks and changes nothing (got ${accelStale.status} ${JSON.stringify(accelStale.body)})`);
        const accelFresh = await postJson('/api/local/admin/decisions/ho-d9/accelerate', {}, as(fresh));
        assert(!isStepUp(accelFresh), `after Manage again it passes the step-up (got ${accelFresh.status} ${JSON.stringify(accelFresh.body)})`);

        // An admin's own work is not asked: suspending and lifting a plain member six minutes on.
        const plain = keypair();
        seedMember(plain.pub, 'hoPlain9');
        const adminStale = await exchange((await requestLink(admin)).body.handshakeToken);
        backdateAdminSessionForTests(adminStale.sessionId!, 6 * 60_000);
        const suspendPlain = await postJson(`/api/local/admin/users/${plain.pub}/suspend`, reason, as(adminStale));
        assert(suspendPlain.status === 200 && statusOf(plain.pub) === 'disabled', `an admin suspends a member six minutes on, unasked (got ${suspendPlain.status} ${JSON.stringify(suspendPlain.body)})`);
        const liftPlain = await postJson(`/api/local/admin/users/${plain.pub}/status`, { status: 'active' }, as(adminStale));
        assert(liftPlain.status === 200 && statusOf(plain.pub) === 'active', `…and lifts it, unasked (got ${liftPlain.status} ${JSON.stringify(liftPlain.body)})`);
    }

    // ── 10. Signing another member out everywhere is owner-only, so asked; signing yourself out is not (4172121324) ──
    console.log('\n10. revoke-all for someone else from a stale phone session');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const epochOf = (pk: string) => (db.prepare('SELECT session_epoch FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.session_epoch ?? null;
        const isStepUp = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'step_up_required';
        const before = epochOf(owner2.pub);
        const stale = await exchange((await requestLink(owner)).body.handshakeToken);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const other = await postJson('/api/local/admin/auth/revoke-all', { memberPubkey: owner2.pub }, as(stale));
        assert(isStepUp(other) && epochOf(owner2.pub) === before,
            `signing a co-owner out everywhere asks and ends nothing (got ${other.status} ${JSON.stringify(other.body)})`);
        const fresh = await exchange((await requestLink(owner)).body.handshakeToken);
        const otherFresh = await postJson('/api/local/admin/auth/revoke-all', { memberPubkey: owner2.pub }, as(fresh));
        assert(otherFresh.status === 200 && epochOf(owner2.pub) === before + 1, `after Manage again it works (got ${otherFresh.status} ${JSON.stringify(otherFresh.body)})`);
        const ownBefore = epochOf(owner.pub);
        const own = await postJson('/api/local/admin/auth/revoke-all', { memberPubkey: owner.pub }, as(stale));
        assert(own.status === 200 && epochOf(owner.pub) === ownBefore + 1, `signing yourself out everywhere six minutes on is not asked (got ${own.status} ${JSON.stringify(own.body)})`);
        const adminStale = await exchange((await requestLink(admin)).body.handshakeToken);
        backdateAdminSessionForTests(adminStale.sessionId!, 6 * 60_000);
        const adminOwn = await postJson('/api/local/admin/auth/revoke-all', {}, as(adminStale));
        assert(adminOwn.status === 200, `nor is an admin's own, with no member named (got ${adminOwn.status} ${JSON.stringify(adminOwn.body)})`);
    }

    // ── 11. Removing an owner or admin (prune, prune a branch holding one, offboard) is owner-only in the engine
    // (state-engine assertMayPrune), so asked; an admin removing a member is not. ──
    console.log('\n11. Prune, branch prune and offboard of an admin from a stale phone session');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status ?? null;
        const isStepUp = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'step_up_required';
        const anAdmin = keypair();
        seedMember(anAdmin.pub, 'hoAdmin11');
        grantNodeRole(anAdmin.pub, 'admin', owner.pub);
        const root = keypair();
        seedMember(root.pub, 'hoRoot11');
        db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(root.pub, anAdmin.pub);

        const stale = await exchange((await requestLink(owner)).body.handshakeToken);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const intact = () => roleOf(anAdmin.pub) === 'admin' && statusOf(anAdmin.pub) === 'active' && statusOf(root.pub) === 'active';
        const prune = await postJson(`/api/local/admin/users/${anAdmin.pub}/prune`, {}, as(stale));
        assert(isStepUp(prune) && intact(), `pruning an admin asks and removes nobody (got ${prune.status} ${JSON.stringify(prune.body)})`);
        const branch = await postJson(`/api/local/admin/branches/${root.pub}/prune`, {}, as(stale));
        assert(isStepUp(branch) && intact(), `pruning a branch that holds an admin asks (got ${branch.status} ${JSON.stringify(branch.body)})`);
        const offboard = await postJson(`/api/local/admin/members/${anAdmin.pub}/offboard`, { resolution: 'prune_zero_balance' }, as(stale));
        assert(isStepUp(offboard) && intact(), `offboarding an admin asks (got ${offboard.status} ${JSON.stringify(offboard.body)})`);
        const offboardUpper = await postJson(`/api/local/admin/members/${anAdmin.pub.toUpperCase()}/offboard`, { resolution: 'prune_zero_balance' }, as(stale));
        assert(isStepUp(offboardUpper) && intact(), `…with the key in capitals too (got ${offboardUpper.status} ${JSON.stringify(offboardUpper.body)})`);

        const fresh = await exchange((await requestLink(owner)).body.handshakeToken);
        const offboardFresh = await postJson(`/api/local/admin/members/${anAdmin.pub}/offboard`, { resolution: 'prune_zero_balance' }, as(fresh));
        assert(!isStepUp(offboardFresh), `after Manage again, offboarding passes the step-up (got ${offboardFresh.status} ${JSON.stringify(offboardFresh.body)})`);

        // An admin removing a plain member six minutes on is not asked.
        const plain = keypair();
        seedMember(plain.pub, 'hoPlain11');
        const adminStale = await exchange((await requestLink(admin)).body.handshakeToken);
        backdateAdminSessionForTests(adminStale.sessionId!, 6 * 60_000);
        const prunePlain = await postJson(`/api/local/admin/users/${plain.pub}/prune`, {}, as(adminStale));
        assert(!isStepUp(prunePlain) && prunePlain.status === 200, `an admin prunes a member six minutes on, unasked (got ${prunePlain.status} ${JSON.stringify(prunePlain.body)})`);
    }

    // ── 12. Actioning a report with suspendUser takes the subject's role: an owner's or admin's is asked ──
    console.log('\n12. Report action with suspendUser on an admin from a stale phone session');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const isStepUp = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'step_up_required';
        const anAdmin = keypair();
        seedMember(anAdmin.pub, 'hoAdmin12');
        grantNodeRole(anAdmin.pub, 'admin', owner.pub);
        const plain = keypair();
        seedMember(plain.pub, 'hoPlain12');
        db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at)
                    VALUES ('ho-r12a', ?, ?, NULL, 'spam', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(member.pub, anAdmin.pub);
        db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at)
                    VALUES ('ho-r12b', ?, ?, NULL, 'spam', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(member.pub, plain.pub);
        const stale = await exchange((await requestLink(owner)).body.handshakeToken);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const onAdmin = await postJson('/api/local/admin/reports/ho-r12a/action', { suspendUser: true }, as(stale));
        assert(isStepUp(onAdmin) && roleOf(anAdmin.pub) === 'admin', `suspending an admin through a report asks and keeps the role (got ${onAdmin.status} ${JSON.stringify(onAdmin.body)})`);
        const fresh = await exchange((await requestLink(owner)).body.handshakeToken);
        const onAdminFresh = await postJson('/api/local/admin/reports/ho-r12a/action', { suspendUser: true }, as(fresh));
        assert(onAdminFresh.status === 200 && roleOf(anAdmin.pub) === null, `after Manage again it goes through (got ${onAdminFresh.status} ${JSON.stringify(onAdminFresh.body)})`);
        const onPlain = await postJson('/api/local/admin/reports/ho-r12b/action', { suspendUser: true }, as(stale));
        assert(onPlain.status === 200, `suspending a plain member through a report six minutes on is not asked (got ${onPlain.status} ${JSON.stringify(onPlain.body)})`);
    }

    // ── 13. A re-key moves an owner's or admin's role to a new key: only an owner may (member-wizards assertMayRekey),
    // so a stale phone session is asked and an admin is refused; an admin re-keying a member or moderator is neither
    // (confirm 2, 4172228423). ──
    console.log('\n13. Re-keying an owner or admin');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status ?? null;
        const pending = (pk: string) => (db.prepare("SELECT COUNT(*) AS c FROM rekey_requests WHERE old_pubkey = ? AND status = 'pending'").get(pk) as any).c as number;
        const isStepUp = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'step_up_required';
        const isOwnerOnly = (r: { status: number; body: any }) => r.status === 403 && r.body?.code !== 'step_up_required' && /Only an owner can re-key an owner or admin/.test(r.body?.error ?? '');
        const issue = (pk: string, s: any) => postJson(`/api/local/admin/members/${pk}/rekey/issue-code`, {}, as(s));
        const complete = (pk: string, code: string, newPubkey: string, s: any) => postJson(`/api/local/admin/members/${pk}/rekey/complete`, { code, newPubkey }, as(s));
        const coOwner = keypair(), coOwnerB = keypair(), anAdmin = keypair(), plain = keypair(), aMod = keypair();
        seedMember(coOwner.pub, 'hoCoOwner13');
        seedMember(coOwnerB.pub, 'hoCoOwnerB13');
        seedMember(anAdmin.pub, 'hoAdmin13');
        seedMember(plain.pub, 'hoPlain13');
        seedMember(aMod.pub, 'hoMod13');
        grantNodeRole(coOwner.pub, 'owner', owner.pub);
        grantNodeRole(coOwnerB.pub, 'owner', owner.pub);
        grantNodeRole(anAdmin.pub, 'admin', owner.pub);
        grantNodeRole(aMod.pub, 'moderator', owner.pub);

        // A stale owner session: both steps asked, nothing changed.
        const stale = await exchange((await requestLink(owner)).body.handshakeToken);
        backdateAdminSessionForTests(stale.sessionId!, 6 * 60_000);
        const issueStale = await issue(coOwner.pub, stale);
        assert(isStepUp(issueStale) && roleOf(coOwner.pub) === 'owner' && statusOf(coOwner.pub) === 'active' && pending(coOwner.pub) === 0,
            `issuing a code for a co-owner asks and changes nothing (got ${issueStale.status} ${JSON.stringify(issueStale.body)})`);
        const issueStaleAdmin = await issue(anAdmin.pub.toUpperCase(), stale);
        assert(isStepUp(issueStaleAdmin) && roleOf(anAdmin.pub) === 'admin' && statusOf(anAdmin.pub) === 'active' && pending(anAdmin.pub) === 0,
            `…and for an admin, key in capitals (got ${issueStaleAdmin.status} ${JSON.stringify(issueStaleAdmin.body)})`);

        const fresh = await exchange((await requestLink(owner)).body.handshakeToken);
        const issued = await issue(coOwner.pub, fresh);
        assert(issued.status === 200 && typeof issued.body.code === 'string', `a fresh owner session issues the co-owner's code (got ${issued.status} ${JSON.stringify(issued.body)})`);
        const code = issued.body.code as string;
        const newKey = keypair();
        const completeStale = await complete(coOwner.pub, code, newKey.pub, stale);
        assert(isStepUp(completeStale) && roleOf(coOwner.pub) === 'owner' && roleOf(newKey.pub) === null && statusOf(coOwner.pub) === 'suspended' && pending(coOwner.pub) === 1,
            `completing it from the stale session asks; the old key keeps the role, no new key gets it (got ${completeStale.status} ${JSON.stringify(completeStale.body)})`);

        // A fresh ADMIN session: refused by the engine on an owner and an admin, at either step; nothing changed.
        const adminFresh = await exchange((await requestLink(admin)).body.handshakeToken);
        const adminComplete = await complete(coOwner.pub, code, newKey.pub, adminFresh);
        assert(isOwnerOnly(adminComplete) && roleOf(coOwner.pub) === 'owner' && roleOf(newKey.pub) === null && statusOf(coOwner.pub) === 'suspended' && pending(coOwner.pub) === 1,
            `an admin completing an owner's re-key is refused (got ${adminComplete.status} ${JSON.stringify(adminComplete.body)})`);
        const adminIssueOwner = await issue(coOwnerB.pub, adminFresh);
        assert(isOwnerOnly(adminIssueOwner) && roleOf(coOwnerB.pub) === 'owner' && statusOf(coOwnerB.pub) === 'active' && pending(coOwnerB.pub) === 0,
            `an admin issuing an owner's code is refused (got ${adminIssueOwner.status} ${JSON.stringify(adminIssueOwner.body)})`);
        const adminIssueAdmin = await issue(anAdmin.pub, adminFresh);
        assert(isOwnerOnly(adminIssueAdmin) && roleOf(anAdmin.pub) === 'admin' && statusOf(anAdmin.pub) === 'active' && pending(anAdmin.pub) === 0,
            `an admin issuing another admin's code is refused (got ${adminIssueAdmin.status} ${JSON.stringify(adminIssueAdmin.body)})`);

        // A fresh owner session completes it: the new key holds the role.
        const completed = await complete(coOwner.pub, code, newKey.pub, fresh);
        assert(completed.status === 200 && roleOf(newKey.pub) === 'owner' && roleOf(coOwner.pub) === null && statusOf(newKey.pub) === 'active',
            `a fresh owner session completes it and the new key is owner (got ${completed.status} ${JSON.stringify(completed.body)})`);

        // An admin's own work, six minutes on: re-keying a plain member and a moderator is not asked.
        const adminStale = await exchange((await requestLink(admin)).body.handshakeToken);
        backdateAdminSessionForTests(adminStale.sessionId!, 6 * 60_000);
        for (const [who, pk, role] of [['a plain member', plain.pub, null], ['a moderator', aMod.pub, 'moderator']] as const) {
            const i = await issue(pk, adminStale);
            const nk = keypair();
            const c = i.status === 200 ? await complete(pk, i.body.code, nk.pub, adminStale) : i;
            assert(i.status === 200 && c.status === 200 && roleOf(nk.pub) === role, `an admin re-keys ${who} six minutes on, unasked (got ${i.status}/${c.status} ${JSON.stringify(c.body)})`);
        }
    }

    // ── 14. Suspending through a report takes the subject's role: on an owner or admin only an owner may
    // (state-engine actionReport), so an admin's fresh session is refused by the engine; actioning the report without
    // suspending stays the admin's, as does suspending a plain member (confirm 2, 4172228479). ──
    console.log('\n14. Report action with suspendUser on an owner or admin from an admin\'s fresh session');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status ?? null;
        const reportStatus = (id: string) => (db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(id) as any)?.status ?? null;
        const isOwnerOnly = (r: { status: number; body: any }) => r.status === 403 && r.body?.code !== 'step_up_required' && /Only an owner can suspend an owner or admin/.test(r.body?.error ?? '');
        const coOwner = keypair(), anAdmin = keypair(), plain = keypair();
        seedMember(coOwner.pub, 'hoCoOwner14');
        seedMember(anAdmin.pub, 'hoAdmin14');
        seedMember(plain.pub, 'hoPlain14');
        grantNodeRole(coOwner.pub, 'owner', owner.pub);
        grantNodeRole(anAdmin.pub, 'admin', owner.pub);
        const report = (id: string, target: string) => db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at)
                    VALUES (?, ?, ?, NULL, 'spam', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id, member.pub, target);
        report('ho-r14o', coOwner.pub);
        report('ho-r14a', anAdmin.pub);
        report('ho-r14p', plain.pub);

        const adminFresh = await exchange((await requestLink(admin)).body.handshakeToken);
        const onOwner = await postJson('/api/local/admin/reports/ho-r14o/action', { suspendUser: true }, as(adminFresh));
        assert(isOwnerOnly(onOwner) && roleOf(coOwner.pub) === 'owner' && statusOf(coOwner.pub) === 'active' && reportStatus('ho-r14o') !== 'actioned',
            `an admin suspending an owner through a report is refused; role, status and report untouched (got ${onOwner.status} ${JSON.stringify(onOwner.body)})`);
        const onAdmin = await postJson('/api/local/admin/reports/ho-r14a/action', { suspendUser: true }, as(adminFresh));
        assert(isOwnerOnly(onAdmin) && roleOf(anAdmin.pub) === 'admin' && statusOf(anAdmin.pub) === 'active' && reportStatus('ho-r14a') !== 'actioned',
            `…and another admin (got ${onAdmin.status} ${JSON.stringify(onAdmin.body)})`);
        const noSuspend = await postJson('/api/local/admin/reports/ho-r14a/action', {}, as(adminFresh));
        assert(noSuspend.status === 200 && reportStatus('ho-r14a') === 'actioned' && roleOf(anAdmin.pub) === 'admin' && statusOf(anAdmin.pub) === 'active',
            `actioning that report without suspending still goes through (got ${noSuspend.status} ${JSON.stringify(noSuspend.body)})`);
        const onPlain = await postJson('/api/local/admin/reports/ho-r14p/action', { suspendUser: true }, as(adminFresh));
        assert(onPlain.status === 200 && statusOf(plain.pub) === 'suspended', `an admin suspends a plain member through a report (got ${onPlain.status} ${JSON.stringify(onPlain.body)})`);
        const ownerFresh = await exchange((await requestLink(owner)).body.handshakeToken);
        const byOwner = await postJson('/api/local/admin/reports/ho-r14o/action', { suspendUser: true }, as(ownerFresh));
        assert(byOwner.status === 200 && roleOf(coOwner.pub) === null && statusOf(coOwner.pub) === 'suspended',
            `an owner's fresh session suspends the co-owner through it, as today (got ${byOwner.status} ${JSON.stringify(byOwner.body)})`);
    }

    // ── 15. A pending re-key code is the whole credential on /api/member/re-enroll, which binds the new key with the
    // issuer as operator: an admin who reads an owner's or admin's code from rekey/status ends with that role on a key
    // they chose. The status answer gives the code for such a target only to its issuer or an owner; self-recovery and
    // an admin's re-key of a plain member keep working end to end (confirm 3, 4172310632). ──
    console.log('\n15. Re-key status: who reads a pending code');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as any)?.status ?? null;
        const issue = (pk: string, s: any) => postJson(`/api/local/admin/members/${pk}/rekey/issue-code`, {}, as(s));
        const readStatus = async (pk: string, s: any) => {
            const res = await fetch(`${BASE}/api/local/admin/members/${pk}/rekey/status`, { headers: as(s) });
            return { status: res.status, body: await res.json() as any };
        };
        // Signed by the new phone, request and proof of possession, as the app sends it.
        const reEnroll = (code: string, nk: Identity) => {
            const bodyString = JSON.stringify({ code, newPublicKey: nk.pub, signature: signText(nk, code) });
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            return postJson('/api/member/re-enroll', JSON.parse(bodyString), {
                'X-Public-Key': nk.pub,
                'X-Signature': signText(nk, `POST\n/api/member/re-enroll\n${ts}\n${nonce}\n${bodyString}`),
                'X-Timestamp': String(ts),
                'X-Nonce': nonce,
            });
        };
        const coOwner = keypair(), coOwnerB = keypair(), anAdmin = keypair(), plain = keypair(), selfOwner = keypair(), selfAdmin = keypair();
        seedMember(coOwner.pub, 'hoCoOwner15');
        seedMember(coOwnerB.pub, 'hoCoOwnerB15');
        seedMember(anAdmin.pub, 'hoAdmin15');
        seedMember(plain.pub, 'hoPlain15');
        seedMember(selfOwner.pub, 'hoSelfOwner15');
        seedMember(selfAdmin.pub, 'hoSelfAdmin15');
        grantNodeRole(coOwner.pub, 'owner', owner.pub);
        grantNodeRole(coOwnerB.pub, 'owner', owner.pub);
        grantNodeRole(anAdmin.pub, 'admin', owner.pub);
        grantNodeRole(selfOwner.pub, 'owner', owner.pub);
        grantNodeRole(selfAdmin.pub, 'admin', owner.pub);

        const ownerFresh = await exchange((await requestLink(owner)).body.handshakeToken);
        const adminFresh = await exchange((await requestLink(admin)).body.handshakeToken);
        const adminStale = await exchange((await requestLink(admin)).body.handshakeToken);
        backdateAdminSessionForTests(adminStale.sessionId!, 6 * 60_000);

        // An owner's code for a co-owner and for an admin: no admin session reads it, fresh or stale, anywhere in the answer.
        for (const [who, target] of [['a co-owner', coOwner], ['an admin', anAdmin]] as const) {
            const issued = await issue(target.pub, ownerFresh);
            assert(issued.status === 200 && typeof issued.body.code === 'string', `an owner issues ${who}'s code (got ${issued.status} ${JSON.stringify(issued.body)})`);
            const code = issued.body.code as string;
            for (const [label, s] of [['fresh', adminFresh], ['stale', adminStale]] as const) {
                const st = await readStatus(target.pub, s);
                assert(st.status === 200 && !!st.body.pendingRequest && !('code' in st.body.pendingRequest) && !JSON.stringify(st.body).includes(code),
                    `a ${label} admin session sees ${who}'s re-key pending but not its code (got ${st.status} ${JSON.stringify(st.body)})`);
                const fromLeak = await reEnroll(String(st.body.pendingRequest?.code ?? ''), keypair());
                assert(fromLeak.status >= 400 && roleOf(target.pub) === (target === coOwner ? 'owner' : 'admin'),
                    `…so it cannot finish it on /api/member/re-enroll; the role stays on the old key (got ${fromLeak.status} ${JSON.stringify(fromLeak.body)})`);
            }
            const byIssuer = await readStatus(target.pub, ownerFresh);
            assert(byIssuer.status === 200 && byIssuer.body.pendingRequest?.code === code,
                `the owner who issued it still reads the code (the manager's RekeyMemberWizard re-shows it) (got ${JSON.stringify(byIssuer.body.pendingRequest)})`);
        }
        // Another owner reads it too: an owner may re-key an owner anyway.
        const coOwnerBFresh = await exchange((await requestLink(coOwnerB)).body.handshakeToken);
        const byCoOwner = await readStatus(coOwner.pub, coOwnerBFresh);
        assert(typeof byCoOwner.body.pendingRequest?.code === 'string', `a co-owner reads it too (got ${JSON.stringify(byCoOwner.body.pendingRequest)})`);

        // The owner's code is still the co-owner's to finish with their new phone.
        const ownerCode = (await readStatus(coOwner.pub, ownerFresh)).body.pendingRequest.code as string;
        const coOwnerNew = keypair();
        const finished = await reEnroll(ownerCode, coOwnerNew);
        assert(finished.status === 200 && roleOf(coOwnerNew.pub) === 'owner' && statusOf(coOwnerNew.pub) === 'active' && roleOf(coOwner.pub) === null,
            `the co-owner finishes it on their new phone and the new key is owner (got ${finished.status} ${JSON.stringify(finished.body)})`);

        // An admin's code for a plain member: the admin reads it back and the member finishes it, as before.
        const plainIssued = await issue(plain.pub, adminStale);
        const plainSt = await readStatus(plain.pub, adminStale);
        assert(plainIssued.status === 200 && plainSt.body.pendingRequest?.code === plainIssued.body.code,
            `an admin who issued a plain member's code still reads it (got ${plainIssued.status} ${JSON.stringify(plainSt.body.pendingRequest)})`);
        const plainNew = keypair();
        const plainDone = await reEnroll(plainIssued.body.code, plainNew);
        assert(plainDone.status === 200 && statusOf(plainNew.pub) === 'active' && roleOf(plainNew.pub) === null,
            `…and the member finishes it on /api/member/re-enroll (got ${plainDone.status} ${JSON.stringify(plainDone.body)})`);

        // Self-recovery: an owner and an admin each issue a code on their own key from Manage, then finish on the member route.
        for (const [who, me, role] of [['an owner', selfOwner, 'owner'], ['an admin', selfAdmin, 'admin']] as const) {
            const mine = await exchange((await requestLink(me)).body.handshakeToken);
            const own = await issue(me.pub, mine);
            const nk = keypair();
            const done = own.status === 200 ? await reEnroll(own.body.code, nk) : own;
            assert(own.status === 200 && done.status === 200 && roleOf(nk.pub) === role && statusOf(nk.pub) === 'active' && roleOf(me.pub) === null,
                `${who} re-keys themselves: issue-code on their own key, finish on /api/member/re-enroll, the new key is ${role} (got ${own.status}/${done.status} ${JSON.stringify(done.body)})`);
        }
    }

    // ── 16. The code an owner's or admin's pending re-key answers is as strong as completing it: /api/member/re-enroll
    // takes it with a key of the caller's choosing. Completing it from a stale phone session is asked (13), so reading it
    // is too: a stale session sees the re-key pending, without its code, and `codeNeedsStepUp`; Manage again (a fresh
    // session) reads it. Issuer or not (#1534, confirm 4 of #1530, 4172426084). ──
    console.log('\n16. Re-key status: a stale phone session reads no owner\'s or admin\'s code');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as any)?.role ?? null;
        const issue = (pk: string, s: any) => postJson(`/api/local/admin/members/${pk}/rekey/issue-code`, {}, as(s));
        const readStatus = async (pk: string, s: any) => {
            const res = await fetch(`${BASE}/api/local/admin/members/${pk}/rekey/status`, { headers: as(s) });
            return { status: res.status, body: await res.json() as any };
        };
        const reEnroll = (code: string, nk: Identity) => {
            const bodyString = JSON.stringify({ code, newPublicKey: nk.pub, signature: signText(nk, code) });
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            return postJson('/api/member/re-enroll', JSON.parse(bodyString), {
                'X-Public-Key': nk.pub,
                'X-Signature': signText(nk, `POST\n/api/member/re-enroll\n${ts}\n${nonce}\n${bodyString}`),
                'X-Timestamp': String(ts),
                'X-Nonce': nonce,
            });
        };
        const coOwner = keypair(), coOwnerB = keypair(), anAdmin = keypair(), plain = keypair();
        seedMember(coOwner.pub, 'hoCoOwner16');
        seedMember(coOwnerB.pub, 'hoCoOwnerB16');
        seedMember(anAdmin.pub, 'hoAdmin16');
        seedMember(plain.pub, 'hoPlain16');
        grantNodeRole(coOwner.pub, 'owner', owner.pub);
        grantNodeRole(coOwnerB.pub, 'owner', owner.pub);
        grantNodeRole(anAdmin.pub, 'admin', owner.pub);

        for (const [who, target, role] of [['a co-owner', coOwner, 'owner'], ['an admin', anAdmin, 'admin']] as const) {
            // The issuer's session issues the code fresh, then goes stale; another owner's session is stale too.
            const issuer = await exchange((await requestLink(owner)).body.handshakeToken);
            const issued = await issue(target.pub, issuer);
            assert(issued.status === 200 && typeof issued.body.code === 'string', `a fresh owner issues ${who}'s code (got ${issued.status} ${JSON.stringify(issued.body)})`);
            const code = issued.body.code as string;
            backdateAdminSessionForTests(issuer.sessionId!, 6 * 60_000);
            const otherStale = await exchange((await requestLink(coOwnerB)).body.handshakeToken);
            backdateAdminSessionForTests(otherStale.sessionId!, 6 * 60_000);

            for (const [label, s] of [['the issuer\'s', issuer], ['another owner\'s', otherStale]] as const) {
                const st = await readStatus(target.pub, s);
                const p = st.body?.pendingRequest;
                assert(st.status === 200 && !!p && !('code' in p) && p.codeNeedsStepUp === true && !JSON.stringify(st.body).includes(code),
                    `${label} stale session sees ${who}'s re-key pending, no code, codeNeedsStepUp (got ${st.status} ${JSON.stringify(st.body)})`);
                assert(!!p && p.old_pubkey === target.pub && typeof p.expires_at === 'string' && p.operator_pubkey === owner.pub && Array.isArray(st.body.history),
                    `…and everything else in the answer as before (got ${JSON.stringify(p)})`);
                const fromStale = await reEnroll(String(p?.code ?? ''), keypair());
                assert(fromStale.status >= 400 && roleOf(target.pub) === role,
                    `…so it cannot finish it on /api/member/re-enroll; the role stays on the old key (got ${fromStale.status} ${JSON.stringify(fromStale.body)})`);
            }

            // Manage again: the issuer's fresh session, and another owner's, read it, with no flag.
            const again = await exchange((await requestLink(owner)).body.handshakeToken);
            const reread = await readStatus(target.pub, again);
            assert(reread.status === 200 && reread.body.pendingRequest?.code === code && !('codeNeedsStepUp' in reread.body.pendingRequest),
                `after Manage again the issuer reads ${who}'s code (got ${JSON.stringify(reread.body.pendingRequest)})`);
            const otherFresh = await exchange((await requestLink(coOwnerB)).body.handshakeToken);
            const byOther = await readStatus(target.pub, otherFresh);
            assert(byOther.body.pendingRequest?.code === code, `…and so does another owner's fresh session (got ${JSON.stringify(byOther.body.pendingRequest)})`);
        }

        // A plain member's code is not an owner's or admin's: a stale admin session that issued it still reads it.
        const adminStale = await exchange((await requestLink(admin)).body.handshakeToken);
        backdateAdminSessionForTests(adminStale.sessionId!, 6 * 60_000);
        const plainIssued = await issue(plain.pub, adminStale);
        const plainSt = await readStatus(plain.pub, adminStale);
        assert(plainIssued.status === 200 && plainSt.body.pendingRequest?.code === plainIssued.body.code && !('codeNeedsStepUp' in plainSt.body.pendingRequest),
            `a stale admin session still reads a plain member's code it issued, unflagged (got ${plainIssued.status} ${JSON.stringify(plainSt.body.pendingRequest)})`);
    }

    // ── 17. The node's inbox (POST /api/local/admin/inbox) is the first owner's own conversations: who they talk to, when,
    // unread counts. An admin reads none of the members' replies there (they are encrypted to that owner's key) and
    // already knows the node lines they sent, so only an owner, or that member themselves, reads it. Sending a notice
    // (inbox/send) stays an admin's (#1534). ──
    console.log('\n17. The node\'s inbox: owners only');
    {
        const as = (s: { sessionId: string | null; body: any }) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.body.csrfToken });
        const pen = keypair();
        seedMember(pen.pub, 'hoPen17');
        adminSendMessage(pen.pub, 'A notice from the node (17)');
        const firstOwner = getFirstNodeAdminPubkey();
        assert(firstOwner === owner.pub, `the inbox is the first owner's (got ${firstOwner})`);

        const adminFresh = await exchange((await requestLink(admin)).body.handshakeToken);
        const byAdmin = await postJson('/api/local/admin/inbox', {}, as(adminFresh));
        const leaked = JSON.stringify(byAdmin.body ?? {});
        assert(byAdmin.status === 403 && !leaked.includes(pen.pub) && !leaked.includes(owner.pub) && !('conversations' in (byAdmin.body ?? {})),
            `an admin's session reads no conversation list or metadata (got ${byAdmin.status} ${leaked.slice(0, 300)})`);

        // owner2 is an admin by now (section 3): another owner is a co-owner made here.
        const coOwner = keypair();
        seedMember(coOwner.pub, 'hoCoOwner17');
        grantNodeRole(coOwner.pub, 'owner', owner.pub);
        for (const [who, s] of [['the first owner', await exchange((await requestLink(owner)).body.handshakeToken)], ['another owner', await exchange((await requestLink(coOwner)).body.handshakeToken)]] as const) {
            const r = await postJson('/api/local/admin/inbox', {}, as(s));
            const conv = (r.body?.conversations ?? []).find((c: any) => c.participants?.includes(pen.pub));
            assert(r.status === 200 && !!conv && r.body.adminPubkey === owner.pub, `${who} reads the inbox (got ${r.status} ${JSON.stringify(r.body).slice(0, 200)})`);
        }

        const send = await postJson('/api/local/admin/inbox/send', { targetPubkey: pen.pub, message: 'An admin\'s notice (17)' }, as(adminFresh));
        assert(send.status === 200, `an admin still sends a notice from the node (got ${send.status} ${JSON.stringify(send.body)})`);
    }

    console.log(`\nApp admin hand-off suite: ${passed}/${run} assertions passed.`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
