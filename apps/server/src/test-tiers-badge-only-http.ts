/**
 * Tiers are badges only (Marty, 12 Nov 2026, board card tier-credit-lever, answer A: "tiers badge only"), over HTTPS through
 * the real middleware. A tier is recognition: it gives no credit (engine/badges.ts).
 *
 *   1. The owner gives Sid the Elder badge (POST /api/local/admin/users/:pk/tier): Sid shows Elder (balance answer, profile,
 *      post card), and members.earned_credit_c, the floor, the usable floor and tierCredit are what they were. Before: 1,400
 *      Beans of granted credit, floor -1,400.
 *   2. Newcomer takes a badge back and no longer wipes credit: Kim's 300 Beans of granted credit stay. Before: wiped to 0.
 *   3. Nobody gives themselves a badge: an admin's own is refused in words (403 own_badge), with no row, log line or notice.
 *   4. Each change is a line in known_floor_log (who, whom, from, to, when); the same badge again writes, logs and tells nothing.
 *   5. The member alone is told: one kept notice ("@Founder gave you the Elder badge."), none to anyone else.
 *   6. A genesis invite of type elder gives its joiner the Elder badge, not credit: earned_credit_c 0, floor 0.
 *   7. A key session only: an automation token is refused (key_session_only), and an unknown tier (400) and an enterprise or
 *      unknown member (404) are refused too.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-tiers-badge-only-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { TIER_LEVELS } from '@beanpool/core';
import { initStateEngine, seedGenesisMember, createPost as rawCreatePost, getMemberTrustProfile, getPosts } from './state-engine.js';
import { wrapCreatePost } from './post-test-helper.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const hc = (beans: number) => Math.round(beans * 100);
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, opts: { treasury?: boolean } = {}): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active', ?)`).run(id.pk, name, ago(30 * DAY), opts.treasury ? 1 : 0);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

function sessionHeaders(pub: string, role: 'owner' | 'admin'): Record<string, string> {
    const { handshakeToken } = mintHandshakeToken(pub, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

const grantedOf = (who: Id) => (db.prepare('SELECT earned_credit_c AS c FROM members WHERE public_key = ?').get(who.pk) as { c: number }).c;
const badgeRow = (who: Id) => db.prepare('SELECT tier, set_by FROM member_badges WHERE member_pubkey = ?').get(who.pk) as { tier: string; set_by: string } | undefined;
const badgeLog = (who: Id) => db.prepare("SELECT actor_pubkey, old_value, new_value, at FROM known_floor_log WHERE action = 'badge' AND member_pubkey = ? ORDER BY rowid")
    .all(who.pk) as Array<{ actor_pubkey: string; old_value: string; new_value: string; at: string }>;
const badgeNotices = () => (db.prepare('SELECT recipient, title, body, data FROM moderation_notices ORDER BY rowid').all() as any[])
    .filter(n => { try { return JSON.parse(n.data)?.kind === 'badge'; } catch { return false; } });

/** A member's own signed balance read: the tier it shows and every credit figure in it. */
async function ownRead(who: Id): Promise<{ tier: string; floor_c: number; usableFloor_c: number; tierCredit_c: number }> {
    const r = await call('GET', who, `/api/ledger/balance/${who.pk}`);
    if (r.status !== 200) throw new Error(`${who.name}'s own read: ${show(r)}`);
    return { tier: r.body?.tier?.name, floor_c: r.body?.floor_c, usableFloor_c: r.body?.usableFloor_c, tierCredit_c: r.body?.tierCredit_c };
}
const credit = (b: { floor_c: number; usableFloor_c: number; tierCredit_c: number }) => ({ floor_c: b.floor_c, usableFloor_c: b.usableFloor_c, tierCredit_c: b.tierCredit_c });

async function main(): Promise<void> {
    console.log('Tiers are badges only\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = sessionHeaders(founder.pk, 'owner');
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const adaAdmin = sessionHeaders(ada.pk, 'admin');
    const sid = makeMember('Sid');
    const kim = makeMember('Kim');
    const pat = makeMember('Pat');
    const setBadge = (who: Id, tier: string, as: Record<string, string> = owner) => call('POST', null, `/api/local/admin/users/${who.pk}/tier`, { tier }, as);

    // ── 1. Elder is a badge: no credit ──────────────────────────────────────────────────────────────────────────────
    console.log('── 1. the owner gives Sid the Elder badge ──');
    createPost('offer', 'produce', 'Sid mends bikes', 'Bike repairs', hc(40), 'fixed', sid.pk); // a live offer, so a line would show
    const sidBefore = await ownRead(sid);
    const r1 = await setBadge(sid, 'Elder');
    assert(r1.status === 200 && r1.body?.tier === 'Elder' && r1.body?.changed === true, `the owner gives Sid the Elder badge (${show(r1)})`);
    const sidAfter = await ownRead(sid);
    assert(grantedOf(sid) === 0, `members.earned_credit_c stays 0 (was set to 140000 before: got ${grantedOf(sid)})`);
    assert(JSON.stringify(credit(sidAfter)) === JSON.stringify(credit(sidBefore)) && sidAfter.floor_c === 0 && sidAfter.usableFloor_c === 0,
        `Sid's floor, usable floor and tierCredit are what they were (${JSON.stringify(credit(sidBefore))} → ${JSON.stringify(credit(sidAfter))})`);
    assert(sidAfter.tier === 'Elder' && getMemberTrustProfile(sid.pk).tier.name === 'Elder', `and Sid shows Elder (answer ${sidAfter.tier}, profile ${getMemberTrustProfile(sid.pk).tier.name})`);
    const card = getPosts({ authorPubkey: sid.pk, viewerPubkey: kim.pk })[0];
    assert(card?.authorEnergyCycled === TIER_LEVELS[3].minCredit, `Sid's post card carries the Elder badge (${card?.authorEnergyCycled})`);
    assert(badgeRow(sid)?.tier === 'Elder' && badgeRow(sid)?.set_by === founder.pk, `the badge is kept in the owner's name (${JSON.stringify(badgeRow(sid))})`);

    // ── 2. Newcomer takes the badge back and wipes no credit ────────────────────────────────────────────────────────
    console.log('── 2. Newcomer no longer wipes credit ──');
    db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(hc(300), kim.pk); // credit she already had
    createPost('offer', 'produce', 'Kim bakes', 'Bread', hc(10), 'fixed', kim.pk);
    const kimBefore = await ownRead(kim);
    assert((await setBadge(kim, 'Resident')).status === 200, 'the owner gives Kim the Resident badge');
    assert((await setBadge(kim, 'Newcomer')).status === 200, 'and takes it back with Newcomer');
    const kimAfter = await ownRead(kim);
    assert(grantedOf(kim) === hc(300), `Kim's 300 Beans of credit stay (was wiped to 0 before: got ${grantedOf(kim)})`);
    assert(JSON.stringify(credit(kimAfter)) === JSON.stringify(credit(kimBefore)) && kimBefore.floor_c === -hc(300),
        `her floor and usable floor are unchanged (${JSON.stringify(credit(kimBefore))} → ${JSON.stringify(credit(kimAfter))})`);
    assert(!badgeRow(kim), 'and she holds no badge');

    // ── 3. never your own ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 3. nobody gives themselves a badge ──');
    const own = await setBadge(ada, 'Steward', adaAdmin);
    assert(own.status === 403 && own.body?.code === 'own_badge' && /nobody gives themselves one/.test(own.body?.error ?? ''),
        `Ada's own badge is refused in words (${show(own)})`);
    assert(!badgeRow(ada) && badgeLog(ada).length === 0 && badgeNotices().every(n => n.recipient !== ada.pk), 'no row, no log line, no notice');
    const byAdmin = await setBadge(pat, 'Steward', adaAdmin);
    assert(byAdmin.status === 200 && badgeRow(pat)?.tier === 'Steward' && badgeRow(pat)?.set_by === ada.pk, `an admin may give someone else one (${show(byAdmin)})`);

    // ── 4. the log ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 4. each change is logged ──');
    const sidLog = badgeLog(sid);
    assert(sidLog.length === 1 && sidLog[0].actor_pubkey === founder.pk && sidLog[0].old_value === 'Newcomer' && sidLog[0].new_value === 'Elder' && !!sidLog[0].at,
        `known_floor_log: who, whom, from, to, when (${JSON.stringify(sidLog)})`);
    const kimLog = badgeLog(kim).map(l => `${l.old_value}→${l.new_value}`);
    assert(JSON.stringify(kimLog) === JSON.stringify(['Newcomer→Resident', 'Resident→Newcomer']), `Kim's two changes (${kimLog.join(', ')})`);
    const again = await setBadge(sid, 'Elder');
    assert(again.status === 200 && again.body?.changed === false && badgeLog(sid).length === 1, `the same badge again changes, logs and tells nothing (${show(again)})`);
    const shown = await call('GET', null, '/api/local/admin/known-floor', undefined, owner);
    assert(shown.status === 200 && (shown.body?.log ?? []).some((l: any) => l.action === 'badge' && l.memberPubkey === sid.pk), 'every owner and admin reads it in the log');

    // ── 5. the member alone is told ─────────────────────────────────────────────────────────────────────────────────
    console.log('── 5. the member is told ──');
    const notices = badgeNotices();
    const toSid = notices.filter(n => n.recipient === sid.pk);
    assert(toSid.length === 1 && toSid[0].body.includes('@Founder gave you the Elder badge.') && toSid[0].body.includes('it gives no credit'),
        `Sid has one kept notice (${JSON.stringify(toSid.map(n => n.body))})`);
    assert(notices.every(n => [sid.pk, kim.pk, pat.pk].includes(n.recipient)) && notices.length === 4,
        `nobody else is told: Sid 1, Kim 2 (given, taken back), Pat 1 (${JSON.stringify(notices.map(n => n.recipient.slice(0, 6)))})`);
    assert(notices.filter(n => n.recipient === kim.pk).some(n => n.body.includes('took back the Resident badge')), 'Kim is told it was taken back');

    // ── 6. a genesis invite gives the badge, not credit ─────────────────────────────────────────────────────────────
    console.log('── 6. a genesis invite ──');
    const seed = await call('POST', null, '/api/admin/seed-invite', { type: 'elder' }, owner);
    assert(seed.status === 200 && typeof seed.body?.code === 'string', `the owner makes an elder invite (${show(seed)})`);
    const joiner = keypair('Jo');
    const joined = await call('POST', joiner, '/api/invite/redeem', { code: seed.body.code, publicKey: joiner.pk, callsign: 'Jo' });
    assert(joined.status === 200 && joined.body?.success === true, `Jo joins with it (${show(joined)})`);
    const jo = await ownRead(joiner);
    assert(grantedOf(joiner) === 0 && jo.floor_c === 0 && jo.tierCredit_c === 0, `Jo has no credit from it: earned_credit_c ${grantedOf(joiner)}, floor ${jo.floor_c} (was 140000 / -140000)`);
    assert(jo.tier === 'Elder' && badgeRow(joiner)?.tier === 'Elder', `Jo shows the Elder badge (${jo.tier}, ${JSON.stringify(badgeRow(joiner))})`);
    assert(badgeLog(joiner).length === 1 && badgeNotices().filter(n => n.recipient === joiner.pk).length === 1, 'logged, and Jo has a kept notice');

    // ── 7. refusals ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 7. refusals ──');
    const token = await setBadge(pat, 'Elder', ownerTokenHeaders('admin', founder.pk));
    assert(token.status === 403 && token.body?.code === 'key_session_only' && badgeRow(pat)?.tier === 'Steward', `an automation token is refused (${show(token)})`);
    const bad = await setBadge(pat, 'Legend');
    assert(bad.status === 400 && bad.body?.code === 'bad_tier', `an unknown badge is refused (${show(bad)})`);
    const ent = makeMember('Seed Co', { treasury: true });
    const toEnt = await setBadge(ent, 'Elder');
    assert(toEnt.status === 404 && !badgeRow(ent), `an enterprise has no badge (${show(toEnt)})`);
    const nobody = await call('POST', null, `/api/local/admin/users/${'ab'.repeat(32)}/tier`, { tier: 'Elder' }, owner);
    assert(nobody.status === 404, `an unknown member is refused (${show(nobody)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
