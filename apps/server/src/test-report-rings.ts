/**
 * Report rings on the global profile (FABLE-sec-global-abuse HIGH-3), over REAL HTTPS through the real signature
 * middleware, the open door included (its sign-ins are test keys primed into sso.ts's cache, as test-open-join does: no
 * provider is contacted). "The clock" is moved by moving rows back in time (members.joined_at, open_joins.joined_at).
 *
 *   1. a ring of three week-old accounts, each with 3 kept posts, reports 3 of an established member's 4 listings:
 *      nothing is hidden, the listings stay on the board, the member stays off probation with all 4 posts kept, and
 *      the ring's reports wait in the moderators' queue, unhidden
 *   2. the same ring still hides a brand-new account's post (its standing is no more than twice theirs)
 *   3. genuine reports still work: three established members who don't know each other hide the established member's
 *      listing; it waits in the queue marked hidden
 *   4. independence, by the door: three accounts that joined from one internet connection within a day count as one,
 *      however established; two more independent reporters make three, and hide it. Two that joined from the same
 *      connection more than a day apart are independent
 *   5. independence, by invites: a member, someone they invited and someone that person invited count as one
 *   6. a reporter with 3 reports the moderators kept in the last 30 days no longer counts towards a hide
 *   7. knocks on probation: 3 in any 24 hours, the 4th refused, and /api/community/me says 3
 *   8. the door's connection label: a standby's copy carries it (never the address hash), a standby merging a newer
 *      row takes it, and a member who deletes their own account takes theirs with them
 *   9. a deep invite tree is still one circle (no depth cut-off), and 300 reports from a 300-deep chain are cheap
 *  10. the connection label is bounded: it lapses 24 hours after its cohort's FIRST join, so joins 20 hours apart
 *      share a label only while within a day of the first
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-report-rings.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.FACEBOOK_CLIENT_IDS;
delete process.env.APPLE_SERVICES_ID;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, createPost, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { installPhotoKeysAtBoot } from './engine/photo-keys.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { _resetJwksCacheForTests } from './sso.js';
import { knockRefusal } from './engine/probation.js';
import { writeOpenJoinRecord } from './engine/open-join.js';
import { hideTally } from './engine/auto-moderation.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let BASE = '';

// ── members and signed requests ─────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
/** A member who joined `daysAgo` days ago with a profile photo, invited by `invitedBy` (the owner by default). */
function member(name: string, daysAgo: number, invitedBy?: Id): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, ago(daysAgo * DAY), (invitedBy ?? owner).pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: parsed };
}

/** A moderator's key session, signed in as the app does it: challenge → signature → handshake → session. */
function keySession(id: Id): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), id.priv).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: id.pk, signature });
    if (!solved.ok) throw new Error(`no session: ${solved.error}`);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(`no session: ${ex.error}`);
    return ex.sessionId!;
}
let modSession = '';
const admin = (method: 'GET' | 'POST', path: string, body?: unknown) => call(method, null, path, body, { 'x-admin-session': modSession });

/** A post written straight into the engine, two days old: a kept post, out of every probation window. */
function oldPost(id: Id, title: string): string {
    const p = createPost('offer', 'other', title, `${title} description`, 0, 'fixed', id.pk)!;
    db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
    return p.id;
}
const report = (reporter: Id, postId: string, author: Id) =>
    call('POST', reporter, '/api/reports', { reporterPubkey: reporter.pk, targetPubkey: author.pk, targetPostId: postId, reason: 'spam' });
const hiddenAt = (postId: string) => (db.prepare('SELECT hidden_by_reports_at FROM posts WHERE id = ?').get(postId) as any)?.hidden_by_reports_at ?? null;
const listIds = async (viewer: Id | null) => {
    const r = await call('GET', viewer, '/api/marketplace/posts');
    return Array.isArray(r.body) ? r.body.map((p: any) => p.id) as string[] : [];
};
const me = async (id: Id) => (await call('GET', id, '/api/community/me')).body;
async function reportAll(reporters: Id[], postId: string, author: Id): Promise<number[]> {
    const out: number[] = [];
    for (const r of reporters) out.push((await report(r, postId, author)).status);
    return out;
}

// ── the open door's sign-in, with test keys ─────────────────────────────────────────────────────
const GOOGLE_KID = 'test-report-rings-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function primeJwks(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', {
        keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any],
        expiresAt: Date.now() + 3600_000,
    });
}
function mint(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url');
    return `${header}.${payload}.${sig}`;
}
/** Join through the open door over HTTPS, as the app does: a join nonce, then the sign-in. Every join here comes from localhost. */
async function doorJoin(name: string): Promise<Id> {
    const id = newId(name);
    const n = await call('POST', id, '/api/join/sso-nonce', {});
    if (n.status !== 200 || typeof n.body?.nonce !== 'string') throw new Error(`no join nonce: ${n.status} ${JSON.stringify(n.body)}`);
    const j = await call('POST', id, '/api/join', { callsign: name, provider: 'google', idToken: mint(`sub-${name}-${crypto.randomUUID()}`, n.body.nonce), nonce: n.body.nonce });
    if (j.status !== 200) throw new Error(`join refused: ${j.status} ${JSON.stringify(j.body)}`);
    db.prepare(`UPDATE members SET avatar_url = 'https://example.com/a.jpg' WHERE public_key = ?`).run(id.pk);
    return id;
}
/** Make a door member as established as `days` days of membership (the join row moves with it). */
function ageMember(id: Id, days: number): void {
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(days * DAY), id.pk);
}

async function main(): Promise<void> {
    console.log('\n=== Report rings on the global profile ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    primeJwks();

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const mo = member('Mo', 200);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    modSession = keySession(mo);
    const viewer = member('Vic', 60);

    process.env.NODE_PROFILE = 'global';
    installPhotoKeysAtBoot();
    const f = (await call('GET', null, '/api/community/info')).body?.features ?? {};
    assert(f.autoHideReports === true && f.probation === true && f.openJoin === true,
        `setup: the global profile, with auto-hide, probation and the open door on (${JSON.stringify({ h: f.autoHideReports, p: f.probation, d: f.openJoin })})`);

    // ── 1. a ring can't hide an established member's listings, or put them back on probation ────
    console.log('\n── 1. a ring of week-old accounts against an established member ──');
    const elle = member('Elle', 120);
    const elles = [1, 2, 3, 4].map(i => oldPost(elle, `Elle listing ${i}`));
    const before = await me(elle);
    assert(before?.probation?.onProbation === false && before?.probation?.keptPosts === 4,
        `setup: Elle, a member for 4 months with 4 posts up, is off probation (${JSON.stringify({ on: before?.probation?.onProbation, kept: before?.probation?.keptPosts })})`);
    // Three accounts with nothing in common, 8 days old, each with 3 posts that stayed up: the cheapest ring there is.
    const ring = [1, 2, 3].map(i => member(`Ring${i}`, 8));
    for (const r of ring) for (let i = 0; i < 3; i++) oldPost(r, `${r.name} filler ${i}`);
    for (const p of elles.slice(0, 3)) {
        const st = await reportAll(ring, p, elle);
        assert(st.every(s => s === 200), `each of the ring reports Elle's listing (${st.join(',')})`);
    }
    assert(elles.slice(0, 3).every(p => hiddenAt(p) === null), 'none of the three listings is hidden');
    const board = await listIds(viewer);
    assert(elles.slice(0, 3).every(p => board.includes(p)), 'all three are still on the board for another member');
    const after = await me(elle);
    assert(after?.probation?.onProbation === false && after?.probation?.keptPosts === 4,
        `Elle is not put back on probation, and all 4 of her posts still count as kept (${JSON.stringify({ on: after?.probation?.onProbation, kept: after?.probation?.keptPosts })})`);
    const queue = (await admin('GET', '/api/local/admin/reports?status=open&limit=200')).body?.reports ?? [];
    const ringReports = queue.filter((r: any) => elles.includes(r.postId) && ring.some(x => x.pk === r.reporterPubkey));
    assert(ringReports.length === 9 && ringReports.every((r: any) => r.postHiddenByReports === false),
        `the ring's 9 reports wait in the moderators' queue, on posts that are not hidden (${ringReports.length})`);

    // ── 2. the same ring still hides a brand-new account's post ──────────────────────────────────
    console.log('\n── 2. the same ring against a brand-new account ──');
    const sid = member('Sid', 0);
    const sidPost = await call('POST', sid, '/api/marketplace/posts', { type: 'offer', category: 'other', title: 'Sid offer', description: 'Cheap watches', credits: 0, authorPublicKey: sid.pk });
    assert(sidPost.status === 200, `setup: a member who joined today posts (${sidPost.status})`);
    await reportAll(ring, sidPost.body?.post?.id, sid);
    assert(!!hiddenAt(sidPost.body?.post?.id), 'three week-old members hide a brand-new account\'s post: it is not well above them');

    // ── 3. genuine reports from established members still work ───────────────────────────────────
    console.log('\n── 3. established members who don\'t know each other ──');
    const est = [1, 2, 3].map(i => member(`Est${i}`, 150));
    await reportAll(est.slice(0, 2), elles[3], elle);
    assert(hiddenAt(elles[3]) === null, 'two established reporters are not enough');
    await reportAll(est.slice(2), elles[3], elle);
    assert(!!hiddenAt(elles[3]), 'a third established, independent reporter hides Elle\'s listing');
    assert(!(await listIds(viewer)).includes(elles[3]), 'it is off the board for another member');
    const queued = ((await admin('GET', '/api/local/admin/reports?status=open&limit=200')).body?.reports ?? [])
        .filter((r: any) => r.postId === elles[3]);
    assert(queued.length === 3 && queued.every((r: any) => r.postHiddenByReports === true),
        `its reports wait in the moderators' queue, marked as on a hidden post, for a moderator to keep or remove it (${queued.length})`);

    // ── 4. independence: one internet connection within a day counts as one ─────────────────────
    console.log('\n── 4. reporters who joined from one connection within a day ──');
    const mara = member('Mara', 60);
    for (let i = 0; i < 3; i++) oldPost(mara, `Mara kept ${i}`);
    const maraPost = oldPost(mara, 'Mara listing');
    // Three accounts through the real door, all from this machine's address within minutes: then as established as can
    // be, so only their being one network keeps them from counting as three.
    const net = [];
    for (let i = 1; i <= 3; i++) net.push(await doorJoin(`Net${i}`));
    for (const n of net) { ageMember(n, 150); for (let i = 0; i < 3; i++) oldPost(n, `${n.name} kept ${i}`); }
    const netRows = net.map(n => db.prepare('SELECT * FROM open_joins WHERE member_pubkey = ?').get(n.pk) as any);
    assert(netRows.every(r => !!r), 'setup: all three joined through the open door');
    await reportAll(net, maraPost, mara);
    assert(hiddenAt(maraPost) === null, 'three established reporters who joined from one connection within a day count as one: nothing hidden');
    const ind = [1, 2].map(i => member(`Ind${i}`, 150));
    await reportAll(ind.slice(0, 1), maraPost, mara);
    assert(hiddenAt(maraPost) === null, 'with one independent reporter that is two');
    await reportAll(ind.slice(1), maraPost, mara);
    assert(!!hiddenAt(maraPost), 'a second independent reporter makes three: hidden');

    // The same connection more than a day apart: two people, not one. Every join here is from this machine, so the joins
    // above go back two days first, or both would share theirs.
    db.prepare('UPDATE open_joins SET joined_at = ? WHERE member_pubkey IN (?, ?, ?)').run(ago(2 * DAY), ...net.map(n => n.pk));
    const day1 = await doorJoin('DayOne');
    db.prepare('UPDATE open_joins SET joined_at = ? WHERE member_pubkey = ?').run(ago(25 * HOUR), day1.pk);
    const day2 = await doorJoin('DayTwo');
    for (const d of [day1, day2]) { ageMember(d, 150); for (let i = 0; i < 3; i++) oldPost(d, `${d.name} kept ${i}`); }
    const nora = member('Nora', 60);
    for (let i = 0; i < 3; i++) oldPost(nora, `Nora kept ${i}`);
    const noraPost = oldPost(nora, 'Nora listing');
    await reportAll([day1, day2], noraPost, nora);
    assert(hiddenAt(noraPost) === null, 'setup: two reporters are not enough');
    await reportAll([member('Ind3', 150)], noraPost, nora);
    assert(!!hiddenAt(noraPost), 'two who joined from the same connection more than a day apart count as two: with one more, hidden');

    // ── 5. independence: one invite tree counts as one ──────────────────────────────────────────
    console.log('\n── 5. reporters from one invite tree ──');
    const ivy = member('Ivy', 150);
    const ian = member('Ian', 150, ivy);
    const ida = member('Ida', 150, ian);
    for (const x of [ivy, ian, ida]) for (let i = 0; i < 3; i++) oldPost(x, `${x.name} kept ${i}`);
    const otto = member('Otto', 60);
    for (let i = 0; i < 3; i++) oldPost(otto, `Otto kept ${i}`);
    const ottoPost = oldPost(otto, 'Otto listing');
    await reportAll([ivy, ian, ida], ottoPost, otto);
    assert(hiddenAt(ottoPost) === null, 'a member, someone they invited and someone that person invited count as one: nothing hidden');
    await reportAll([member('Ind4', 150), member('Ind5', 150)], ottoPost, otto);
    assert(!!hiddenAt(ottoPost), 'with two independent reporters, three: hidden');

    // ── 6. a reporter whose reports the moderators keep stops counting ──────────────────────────
    console.log('\n── 6. a reporter the moderators keep answering ──');
    const xan = member('Xan', 150);
    const kept = [1, 2, 3].map(i => { const a = member(`Kept${i}`, 60); oldPost(a, `Kept${i} other`); return { a, p: oldPost(a, `Kept${i} listing`) }; });
    for (const { a, p } of kept) {
        await report(xan, p, a);
        const id = (db.prepare(`SELECT id FROM abuse_reports WHERE target_post_id = ? AND reporter_pubkey = ?`).get(p, xan.pk) as any)?.id;
        const d = await admin('POST', `/api/local/admin/reports/${id}/dismiss`);
        assert(d.status === 200, `a moderator dismisses Xan's report of ${a.name}'s listing, keeping it (${d.status})`);
    }
    const pia = member('Pia', 60);
    for (let i = 0; i < 3; i++) oldPost(pia, `Pia kept ${i}`);
    const piaPost = oldPost(pia, 'Pia listing');
    await reportAll([xan, member('Ind6', 150), member('Ind7', 150)], piaPost, pia);
    assert(hiddenAt(piaPost) === null, 'with 3 reports kept in 30 days, Xan no longer counts: Xan and two others hide nothing');
    await reportAll([member('Ind8', 150)], piaPost, pia);
    assert(!!hiddenAt(piaPost), 'a third reporter who counts hides it');
    const xanQueued = ((await admin('GET', '/api/local/admin/reports?status=open&limit=200')).body?.reports ?? [])
        .some((r: any) => r.postId === piaPost && r.reporterPubkey === xan.pk);
    assert(xanQueued, 'Xan\'s report still reaches the moderators');

    // ── 7. knocks on probation: 3 a day ─────────────────────────────────────────────────────────
    console.log('\n── 7. knocks on probation ──');
    const kit = member('Kit', 0);
    assert(knockRefusal(kit.pk, []) === null && knockRefusal(kit.pk, [ago(HOUR)]) === null && knockRefusal(kit.pk, [ago(HOUR), ago(2 * HOUR)]) === null,
        'a new account may knock a 1st, 2nd and 3rd time in 24 hours');
    const fourth = knockRefusal(kit.pk, [ago(HOUR), ago(2 * HOUR), ago(3 * HOUR)]);
    assert(fourth?.limit === 'knocks' && /ask 3 communities in any 24 hours/.test(fourth.message) && /ask again in about 21 hours/.test(fourth.message),
        `the 4th is refused, in words, with when it lets up (${fourth?.message})`);
    assert(knockRefusal(kit.pk, [ago(HOUR), ago(2 * HOUR), ago(25 * HOUR)]) === null, 'a knock 25 hours ago no longer counts');
    const kitMe = await me(kit);
    assert(kitMe?.probation?.onProbation === true && kitMe?.probation?.limits?.knocks?.limit === 3,
        `/api/community/me says 3 knocks a day (${JSON.stringify(kitMe?.probation?.limits?.knocks)})`);

    // ── 8. the connection label travels, and goes with a deleted account ───────────────────────
    console.log('\n── 8. the connection label: replicated, never the address, gone with a deleted account ──');
    const payload = await exportSyncState('test');
    const sent = new Map((payload.openJoins ?? []).map(j => [j.memberPubkey, j]));
    const netLabel = sent.get(net[0].pk)?.joinCohort;
    assert(!!netLabel && net.every(n => sent.get(n.pk)?.joinCohort === netLabel)
        && !!sent.get(day1.pk)?.joinCohort && !!sent.get(day2.pk)?.joinCohort && sent.get(day1.pk)?.joinCohort !== sent.get(day2.pk)?.joinCohort
        && sent.get(day1.pk)?.joinCohort !== netLabel,
        'a copy for a standby carries each join\'s label: one for the three, and two different ones a day apart');
    const addressHashes = (db.prepare('SELECT ip_hash FROM open_joins WHERE ip_hash IS NOT NULL').all() as { ip_hash: string }[]).map(r => r.ip_hash);
    const sentText = JSON.stringify(payload.openJoins ?? []);
    assert(addressHashes.length > 0 && addressHashes.every(h => !sentText.includes(h)) && !/ip_?hash/i.test(sentText),
        `and never an address hash (${addressHashes.length} held here)`);
    const later = new Date(Date.now() + 1000).toISOString();
    const merged = writeOpenJoinRecord([{ ...sent.get(day2.pk)!, joinCohort: 'label-from-the-main-server', updatedAt: later }]);
    const day2Label = () => (db.prepare('SELECT join_cohort FROM open_joins WHERE member_pubkey = ?').get(day2.pk) as any)?.join_cohort;
    assert(merged.written === 1 && day2Label() === 'label-from-the-main-server', 'a standby merging a newer row takes its label');
    const purged = await call('POST', day2, '/api/member/purge', {});
    assert(purged.status === 200 && day2Label() === null, `a member who deletes their own account takes their label with them (${purged.status})`);

    // ── 9. a deep invite tree is one circle, and weighing it is cheap ───────────────────────────
    console.log('\n── 9. a deep invite chain ──');
    const chain = (n: number, tag: string): Id[] => {
        const out: Id[] = [];
        for (let i = 0; i < n; i++) out.push(member(`${tag}${i}`, 150, out[i - 1]));
        return out;
    };
    const deep = chain(70, 'Deep');
    const deepReporters = [66, 67, 68].map(i => deep[i]);
    for (const r of deepReporters) for (let i = 0; i < 3; i++) oldPost(r, `${r.name} kept ${i}`);
    const dale = member('Dale', 60);
    for (let i = 0; i < 3; i++) oldPost(dale, `Dale kept ${i}`);
    const dalePost = oldPost(dale, 'Dale listing');
    await reportAll(deepReporters, dalePost, dale);
    const deepTally = hideTally(dalePost);
    assert(deepTally.circles.length === 1 && deepTally.circles[0].length === 3,
        `reporters at depths 66, 67 and 68 of one 70-deep chain are 1 circle (${deepTally.circles.length})`);
    assert(hiddenAt(dalePost) === null, 'and they do not hide the post');
    const long = chain(300, 'Long');
    const dina = member('Dina', 60);
    for (let i = 0; i < 3; i++) oldPost(dina, `Dina kept ${i}`);
    const dinaPost = oldPost(dina, 'Dina listing');
    const ins = db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status, created_at)
                            VALUES (?, ?, ?, ?, 'spam', 'pending', ?)`);
    for (const r of long) ins.run(`long-${r.pk}`, r.pk, dina.pk, dinaPost, ago(1000));
    const t0 = performance.now();
    const longTally = hideTally(dinaPost);
    const ms = performance.now() - t0;
    console.log(`   (one weighing of 300 reports from a 300-deep chain: ${ms.toFixed(1)} ms)`);
    assert(longTally.circles.length === 1 && longTally.circles[0].length === 300, `300 reporters from one 300-deep chain are 1 circle (${longTally.circles.length})`);
    assert(ms < 100, `weighing them takes well under the 204 ms it took before (${ms.toFixed(1)} ms)`);

    // ── 10. the connection label lapses a day after its cohort's first join ─────────────────────
    console.log('\n── 10. the label is bounded ──');
    db.prepare('UPDATE open_joins SET joined_at = ?').run(ago(10 * DAY));
    const labelOf = (id: Id) => (db.prepare('SELECT join_cohort FROM open_joins WHERE member_pubkey = ?').get(id.pk) as any)?.join_cohort as string;
    const chained: Id[] = [];
    for (let i = 0; i < 4; i++) {
        // Every join here is from this machine: before each one, move the earlier ones back 20 hours more.
        chained.forEach((c, k) => db.prepare('UPDATE open_joins SET joined_at = ? WHERE member_pubkey = ?').run(ago((chained.length - k) * 20 * HOUR), c.pk));
        chained.push(await doorJoin(`Chain${i + 1}`));
    }
    chained.forEach((c, k) => db.prepare('UPDATE open_joins SET joined_at = ? WHERE member_pubkey = ?').run(ago((3 - k) * 20 * HOUR), c.pk));
    const [c1, c2, c3, c4] = chained.map(labelOf);
    assert(!!c1 && c1 === c2, 'a join 20 hours after the first shares its label');
    assert(c3 !== c1 && !!c3, 'a join 40 hours after the first does not, though only 20 hours after the previous one');
    assert(c4 === c3, 'and the one after it, within a day of that new cohort\'s first, shares the new label');
    assert(c1 !== c4, 'the first and fourth joins, 60 hours apart, do not share a label');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A ring hides nobody established, and genuine reports still do.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
