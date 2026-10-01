/**
 * Clean-up by burst on the global profile (two-doors design §4.4, slice S9), over REAL HTTPS through the real signature
 * middleware, the open door included (its sign-ins are test keys primed into sso.ts's cache, as test-report-rings does:
 * no provider is contacted); owners, admins and moderators on real key sessions. "The clock" is moved by moving rows
 * back in time (open_joins.joined_at, members.joined_at).
 *
 *   1. the burst of an account: the others who joined through the door from the same connection within a day of it,
 *      oldest first, each with their standing; never those who joined from it on another day, nor a member who came by
 *      invite. A moderator sees it for an account in a burst the digest lists, or with an open report; an owner or an
 *      admin for any account
 *   2. the digest: one line per burst of 5 or more whose first join was in the last 7 days, never a smaller one; it
 *      says how many were reported and opens on a reported one
 *   3. hide-all and its undo: every post of the accounts named is hidden from everyone but its author and the
 *      moderators, and each author is told once; the undo brings back exactly what the hide hid, never a post reports
 *      had hidden before it, nor one reports from enough independent people would hide now; a second undo is refused
 *   4. the guard: an action names exactly the accounts and how many; a wrong count, one not in the burst, a duplicate,
 *      a role holder, none or too many is refused with nothing done; an established account (by weeks, or by a week and
 *      posts that stayed up) only with includeEstablished, and hiding its posts first doesn't lower that bar
 *   5. remove-all: owners and admins only, never a moderator; each account is removed as one removal removes it, and
 *      its sign-in can't join again; the burst then lists who is left and how many were removed
 *   6. nobody else: unsigned, a member's signature, a member with no role (no session), a moderator whose role was taken
 *   7. no answer carries an address, the address hash, the connection label, or a field naming any of them
 *   8. a member who deletes their own account leaves every burst record, and every burst
 *   9. a report on a post is about the post's author, whoever the reporter names: it is filed so, the reports list
 *      names the author, and a post report that names another member opens that member's group to nobody
 *  10. a moderator's own report opens nobody's group to them; another member's report does
 *  11. a member suspended from a report, or by an admin's status, shows as suspended
 *  12. an undo weighs each post as if the whole hide were undone, so it never keeps hidden what reports would not hide
 *  13. a hide and its undo ring each open socket once, not once per post
 *  14. a local node: every route answers 404, even to an owner, and nothing changes
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-burst-cleanup.ts
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
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, revokeNodeRole, createPost } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { installPhotoKeysAtBoot } from './engine/photo-keys.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { _resetJwksCacheForTests } from './sso.js';

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
/** A member who joined `daysAgo` days ago with a profile photo, invited by the owner. */
function member(name: string, daysAgo: number): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

/** Every answer this suite got from the node, for section 7. */
const answers: string[] = [];

interface Res { status: number; body: any; text: string }
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
    if (path.includes('burst')) answers.push(text);
    return { status: res.status, body: parsed, text };
}

/** A key session, signed in as the app does it: challenge → signature → handshake → session. */
function keySession(id: Id): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), id.priv).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: id.pk, signature });
    if (!solved.ok) throw new Error(`no session: ${solved.error}`);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(`no session: ${ex.error}`);
    return ex.sessionId!;
}
const as = (session: string) => (method: 'GET' | 'POST', path: string, body?: unknown) =>
    call(method, null, path, body, { 'x-admin-session': session });

const post = async (id: Id, title: string): Promise<string> => {
    const r = await call('POST', id, '/api/marketplace/posts', { type: 'offer', category: 'other', title, description: `${title}, cheap`, credits: 0, authorPublicKey: id.pk });
    if (r.status !== 200 || typeof r.body?.post?.id !== 'string') throw new Error(`post refused: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.post.id;
};
const report = (reporter: Id, postId: string, author: Id) =>
    call('POST', reporter, '/api/reports', { reporterPubkey: reporter.pk, targetPubkey: author.pk, targetPostId: postId, reason: 'spam' });
const hiddenAt = (postId: string) => (db.prepare('SELECT hidden_by_reports_at FROM posts WHERE id = ?').get(postId) as any)?.hidden_by_reports_at ?? null;
const statusOf = (id: Id) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(id.pk) as any)?.status ?? null;
const listIds = async (viewer: Id | null) => {
    const r = await call('GET', viewer, '/api/marketplace/posts');
    return Array.isArray(r.body) ? r.body.map((p: any) => p.id) as string[] : [];
};
const notices = async (id: Id) => ((await call('GET', id, '/api/notices')).body?.notices ?? []) as { title: string; body: string; data: any }[];
const keysOf = (list: any[] | undefined) => (Array.isArray(list) ? list.map((a: any) => a?.publicKey) : []) as string[];
/** Every post, its hidden stamp and status, to show an action changed nothing. */
const postsState = () => JSON.stringify(db.prepare('SELECT id, hidden_by_reports_at, status, active FROM posts ORDER BY id').all());
const membersState = () => JSON.stringify(db.prepare('SELECT public_key, status FROM members ORDER BY public_key').all());

/**
 * A member who joined through the door `daysAgo` days ago with this connection label, written straight in: a burst of
 * its own without a second address to join from.
 */
function doorRow(name: string, label: string, daysAgo = 0): Id {
    const id = newId(name);
    const at = ago(daysAgo * DAY + 60_000);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, 'open:google', 'OPEN', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, at);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, join_cohort) VALUES (?, ?, ?, ?, ?)')
        .run(id.pk, 'google', crypto.randomBytes(32).toString('hex'), at, label);
    return id;
}

// ── sockets, for the doorbells ──────────────────────────────────────────────────────────────────
type Sock = { ws: WebSocket; events: any[] };
/** A member's signed socket, or a stranger's unsigned one (null). */
function socket(id: Id | null): Promise<Sock> {
    let url = `${BASE.replace('https', 'wss')}/ws`;
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
        url += `?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    }
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}

// ── the open door's sign-in, with test keys ─────────────────────────────────────────────────────
const GOOGLE_KID = 'test-burst-cleanup-google';
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
/** A join through the open door over HTTPS, as the app does it: a join nonce, then the sign-in. Answers as the door does. */
async function tryDoorJoin(id: Id, sub: string): Promise<Res> {
    const n = await call('POST', id, '/api/join/sso-nonce', {});
    if (n.status !== 200 || typeof n.body?.nonce !== 'string') throw new Error(`no join nonce: ${n.status} ${JSON.stringify(n.body)}`);
    return call('POST', id, '/api/join', { callsign: id.name, provider: 'google', idToken: mint(sub, n.body.nonce), nonce: n.body.nonce });
}
/** Every join here comes from this machine, one address: so all of them share a connection unless moved apart in time. */
const subs = new Map<string, string>();
async function doorJoin(name: string): Promise<Id> {
    const id = newId(name);
    const sub = `sub-${name}-${crypto.randomUUID()}`;
    const j = await tryDoorJoin(id, sub);
    if (j.status !== 200) throw new Error(`join refused: ${j.status} ${JSON.stringify(j.body)}`);
    subs.set(id.pk, sub);
    db.prepare(`UPDATE members SET avatar_url = 'https://example.com/a.jpg' WHERE public_key = ?`).run(id.pk);
    return id;
}
/** The door lets 5 an hour through from one address: the joins of the last hour go back 61 minutes, still within the day. */
function makeRoomThisHour(): void {
    const recent = db.prepare('SELECT member_pubkey, joined_at FROM open_joins WHERE joined_at >= ?').all(ago(HOUR)) as { member_pubkey: string; joined_at: string }[];
    for (const r of recent) db.prepare('UPDATE open_joins SET joined_at = ? WHERE member_pubkey = ?').run(new Date(Date.parse(r.joined_at) - 61 * 60 * 1000).toISOString(), r.member_pubkey);
}

async function main(): Promise<void> {
    console.log('\n=== Clean-up by burst on the global profile ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    primeJwks();

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const mo = member('Mo', 200);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const ada = member('Ada', 200);
    grantNodeRole(ada.pk, 'admin', owner.pk);
    const pat = member('Pat', 60);
    const ivy = member('Ivy', 2);
    const est = [1, 2, 3].map(i => member(`Est${i}`, 150));
    let mod = as(keySession(mo));
    const adm = as(keySession(ada));
    const own = as(keySession(owner));

    process.env.NODE_PROFILE = 'global';
    installPhotoKeysAtBoot();
    const f = (await call('GET', null, '/api/community/info')).body?.features ?? {};
    assert(f.openJoin === true && f.autoHideReports === true,
        `setup: the global profile, with the open door and auto-hide on (${JSON.stringify({ d: f.openJoin, h: f.autoHideReports })})`);

    // Two who joined from this connection two days ago, then seven today: two bursts, the first no longer anyone's day.
    const old = [await doorJoin('Old1'), await doorJoin('Old2')];
    db.prepare('UPDATE open_joins SET joined_at = ? WHERE member_pubkey IN (?, ?)').run(ago(2 * DAY), old[0].pk, old[1].pk);
    const spam: Id[] = [];
    for (let i = 1; i <= 7; i++) {
        if (i === 5) makeRoomThisHour();
        spam.push(await doorJoin(`Spam${i}`));
    }
    const [s1, s2, s3, s4, s5, s6, s7] = spam;
    const labels = (db.prepare('SELECT DISTINCT join_cohort FROM open_joins WHERE join_cohort IS NOT NULL').all() as { join_cohort: string }[]).map(r => r.join_cohort);
    const ipHashes = (db.prepare('SELECT DISTINCT ip_hash FROM open_joins WHERE ip_hash IS NOT NULL').all() as { ip_hash: string }[]).map(r => r.ip_hash);
    assert(labels.length === 2 && ipHashes.length >= 1, `setup: two connection labels (${labels.length}) and the door's address hash (${ipHashes.length})`);

    const p1a = await post(s1, 'Spam1 watches'), p1b = await post(s1, 'Spam1 pills');
    const p2 = await post(s2, 'Spam2 watches');
    const p3 = await post(s3, 'Spam3 watches');
    const p4 = await post(s4, 'Spam4 watches');
    const p5 = await post(s5, 'Spam5 watches');
    const p6 = await post(s6, 'Spam6 watches');
    const pOld = await post(old[0], 'Old1 bike');
    const board0 = await listIds(pat);
    assert([p1a, p1b, p2, p3, p4, p5, p6, pOld].every(p => board0.includes(p)), 'setup: every post is on the board for another member');

    // ── 1. the burst of an account ───────────────────────────────────────────────────────────────
    console.log('\n── 1. the burst of an account ──');
    const b1 = await adm('GET', `/api/local/admin/members/${s1.pk}/burst`);
    assert(b1.status === 200 && b1.body?.account?.publicKey === s1.pk,
        `an admin opens Spam1's burst (${b1.status} ${b1.body?.error ?? ''})`);
    assert(JSON.stringify(keysOf(b1.body?.others)) === JSON.stringify([s2, s3, s4, s5, s6, s7].map(s => s.pk)) && b1.body?.count === 6,
        `the others are the six who joined from the same connection within a day, oldest first (${keysOf(b1.body?.others).length}, count ${b1.body?.count})`);
    assert(!keysOf(b1.body?.others).some(k => k === old[0].pk || k === old[1].pk || k === ivy.pk || k === pat.pk),
        'nobody who joined from it two days earlier, nor anyone who came another way');
    const a2 = (b1.body?.others ?? []).find((a: any) => a.publicKey === s2.pk);
    assert(a2?.callsign === 'Spam2' && typeof a2?.joinedAt === 'string' && typeof a2?.standing === 'number' && a2?.established === false
        && a2?.holdsRole === false && a2?.postsUp === 1 && a2?.postsHidden === 0 && a2?.status === 'active',
        `each comes with their name, when they joined, their standing and posts (${JSON.stringify(a2)})`);
    assert(a2 && typeof a2.standingParts?.weeks === 'number' && typeof a2.standingParts?.keptPosts === 'number' && typeof a2.standingParts?.dealPartners === 'number',
        'and what their standing is made of: weeks, kept posts, people they finished a deal with');
    assert(b1.body?.removedAlready === 0 && b1.body?.joinedThroughDoor === true, 'none of them was removed yet');
    const bOld = await adm('GET', `/api/local/admin/members/${old[0].pk}/burst`);
    assert(bOld.status === 200 && JSON.stringify(keysOf(bOld.body?.others)) === JSON.stringify([old[1].pk]),
        `Old1's burst is Old2 alone: the connection's label lapsed after a day (${JSON.stringify(keysOf(bOld.body?.others).map(k => k.slice(0, 6)))})`);
    const bIvy = await adm('GET', `/api/local/admin/members/${ivy.pk}/burst`);
    assert(bIvy.status === 200 && bIvy.body?.joinedThroughDoor === false && keysOf(bIvy.body?.others).length === 0,
        `a member who came by invite has no burst (${bIvy.status} ${bIvy.body?.joinedThroughDoor})`);
    assert((await adm('GET', `/api/local/admin/members/${'ab'.repeat(32)}/burst`)).status === 404, 'a key that is no member here: 404');
    assert((await adm('GET', '/api/local/admin/members/not-a-key/burst')).status === 400, 'something that is not a key: 400');
    const mS1 = await mod('GET', `/api/local/admin/members/${s1.pk}/burst`);
    assert(mS1.status === 200 && keysOf(mS1.body?.others).length === 6, `a moderator opens a burst the digest lists (${mS1.status})`);
    const mOld = await mod('GET', `/api/local/admin/members/${old[0].pk}/burst`);
    assert(mOld.status === 403 && !keysOf(mOld.body?.others).length,
        `a moderator can't open a small burst with nothing reported in it (${mOld.status} ${mOld.body?.error ?? ''})`);
    assert((await report(pat, pOld, old[0])).status === 200, 'setup: Pat reports Old1\'s post');
    const mOld2 = await mod('GET', `/api/local/admin/members/${old[0].pk}/burst`);
    assert(mOld2.status === 200 && JSON.stringify(keysOf(mOld2.body?.others)) === JSON.stringify([old[1].pk]),
        `once a report on the account is open, a moderator can (${mOld2.status})`);
    const ownS1 = await own('GET', `/api/local/admin/members/${s1.pk}/burst`);
    assert(ownS1.status === 200 && keysOf(ownS1.body?.others).length === 6, `an owner opens one too (${ownS1.status})`);

    // ── 2. the digest ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. the digest ──');
    const d1 = await mod('GET', '/api/local/admin/bursts');
    const lines1 = d1.body?.bursts ?? [];
    assert(d1.status === 200 && lines1.length === 1 && lines1[0]?.accounts === 7 && lines1[0]?.stillHere === 7 && lines1[0]?.removed === 0,
        `one line, for the seven who joined together today; none for the two of two days ago (${d1.status} ${JSON.stringify(lines1)})`);
    assert(spam.some(s => s.pk === lines1[0]?.open?.publicKey) && lines1[0]?.reported === 0 && typeof lines1[0]?.firstJoinAt === 'string',
        'it opens on one of them, and none of them is reported yet');
    assert((await report(pat, p3, s3)).status === 200, 'setup: Pat reports Spam3\'s post');
    const lines2 = (await mod('GET', '/api/local/admin/bursts')).body?.bursts ?? [];
    assert(lines2[0]?.reported === 1 && lines2[0]?.open?.publicKey === s3.pk && lines2[0]?.open?.callsign === 'Spam3',
        `with a report it says so, and opens on the reported account (${JSON.stringify(lines2[0])})`);
    const dOld = (await adm('GET', '/api/local/admin/bursts')).body;
    assert(Array.isArray(dOld?.bursts) && dOld.bursts.length === 1 && Array.isArray(dOld?.actions) && dOld.actions.length === 0,
        'an admin sees the same line, and no action has been taken');

    // ── 3. hide-all, and its undo ────────────────────────────────────────────────────────────────
    console.log('\n── 3. hide-all, and its undo ──');
    // Spam2's post was hidden by reports before anyone looked at the burst.
    const reportsHidAt = ago(HOUR);
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(reportsHidAt, p2);
    const n1before = (await notices(s1)).length;
    const h1 = await mod('POST', `/api/local/admin/members/${s1.pk}/burst/hide`, { members: [s1.pk, s2.pk, s3.pk, s4.pk], count: 4 });
    assert(h1.status === 200 && h1.body?.action?.accounts === 4 && h1.body?.action?.posts === 4 && typeof h1.body?.action?.id === 'string',
        `a moderator hides the posts of four of them in one action: 4 posts, Spam2's was already hidden (${h1.status} ${JSON.stringify(h1.body)})`);
    const hideId: string = h1.body?.action?.id;
    assert([p1a, p1b, p3, p4].every(p => !!hiddenAt(p)) && hiddenAt(p2) === reportsHidAt && !hiddenAt(p5) && !hiddenAt(p6),
        'their posts are hidden; the one reports hid keeps its own stamp; Spam5\'s and Spam6\'s are untouched');
    const board1 = await listIds(pat);
    assert(![p1a, p1b, p2, p3, p4].some(p => board1.includes(p)) && board1.includes(p5) && board1.includes(p6),
        'another member no longer sees them, and still sees the rest');
    const own1 = await listIds(s1);
    assert(own1.includes(p1a) && own1.includes(p1b), 'Spam1 still sees their own');
    const n1 = await notices(s1);
    const hiddenNotice = n1.slice(n1before);
    assert(hiddenNotice.length === 1 && /2 of your posts are hidden/.test(hiddenNotice[0]?.body ?? '') && !/connection|network|address|joined/i.test(hiddenNotice[0]?.body ?? ''),
        `Spam1 is told once, for both posts, and nothing about why or who (${JSON.stringify(hiddenNotice.map(x => x.body))})`);
    const queue = (await mod('GET', '/api/local/admin/reports?status=open&limit=200')).body?.reports ?? [];
    assert(queue.some((r: any) => r.postId === p3 && r.postHiddenByReports === true), 'the open report on Spam3\'s post shows it hidden');
    const dHide = (await mod('GET', '/api/local/admin/bursts')).body;
    assert(dHide?.actions?.[0]?.kind === 'hide' && dHide.actions[0].accounts === 4 && dHide.actions[0].posts === 4 && dHide.actions[0].undoneAt === null
        && dHide.actions[0].by === 'moderator' && dHide.actions[0].id === hideId,
        `the digest has a line for the hide, by a moderator, not undone (${JSON.stringify(dHide?.actions?.[0])})`);
    assert(dHide?.bursts?.[0]?.postsHidden === 5, `and its burst line counts 5 posts hidden (${dHide?.bursts?.[0]?.postsHidden})`);

    // While hidden, three established members who don't know each other report Spam3's post (Pat already has): reports
    // would hide it now, so the undo must not bring it back.
    for (const e of est) assert((await report(e, p3, s3)).status === 200, `setup: ${e.name} reports Spam3's hidden post`);

    const u1 = await mod('POST', `/api/local/admin/bursts/${hideId}/undo`, {});
    assert(u1.status === 200 && u1.body?.restored === 3 && u1.body?.keptHidden === 1,
        `a moderator undoes it: 3 posts back, 1 kept hidden because reports would hide it now (${u1.status} ${JSON.stringify(u1.body)})`);
    assert(!hiddenAt(p1a) && !hiddenAt(p1b) && !hiddenAt(p4) && !!hiddenAt(p3) && hiddenAt(p2) === reportsHidAt,
        'Spam1\'s and Spam4\'s are back; Spam3\'s stays hidden; the one reports hid before is not touched');
    const board2 = await listIds(pat);
    assert(board2.includes(p1a) && board2.includes(p1b) && board2.includes(p4) && !board2.includes(p3) && !board2.includes(p2),
        'another member sees exactly those again');
    const n1after = (await notices(s1)).slice(n1before + 1);
    assert(n1after.length === 1 && /2 of your posts/.test(n1after[0]?.body ?? '') && /see them again/.test(n1after[0]?.body ?? ''),
        `Spam1 is told once that both are back (${JSON.stringify(n1after.map(x => x.body))})`);
    const u2 = await mod('POST', `/api/local/admin/bursts/${hideId}/undo`, {});
    assert(u2.status === 409, `a second undo is refused (${u2.status})`);
    assert((await mod('POST', `/api/local/admin/bursts/${crypto.randomUUID()}/undo`, {})).status === 404, 'an undo of an action that never was: 404');
    const dUndo = (await mod('GET', '/api/local/admin/bursts')).body;
    assert(typeof dUndo?.actions?.[0]?.undoneAt === 'string', 'the digest\'s line for the hide says when it was undone');

    // ── 4. the guard ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the guard ──');
    const before4 = postsState();
    const g = async (what: string, body: unknown, status: number, code?: string) => {
        const r = await mod('POST', `/api/local/admin/members/${s1.pk}/burst/hide`, body);
        assert(r.status === status && (!code || r.body?.code === code) && postsState() === before4,
            `${what}: ${status}${code ? ` ${code}` : ''}, nothing hidden (${r.status} ${r.body?.code ?? ''} ${r.body?.error ?? ''})`);
        return r;
    };
    await g('a count that is not how many it names', { members: [s5.pk], count: 2 }, 400, 'bad_selection');
    await g('no count at all', { members: [s5.pk] }, 400, 'bad_selection');
    await g('none named', { members: [], count: 0 }, 400, 'bad_selection');
    await g('one named twice', { members: [s5.pk, s5.pk], count: 2 }, 400, 'bad_selection');
    await g('more than one action takes', { members: Array.from({ length: 501 }, () => crypto.randomBytes(32).toString('hex')), count: 501 }, 400, 'bad_selection');
    await g('an account from another day', { members: [s5.pk, old[0].pk], count: 2 }, 409, 'not_in_burst');
    await g('a member who came by invite', { members: [s5.pk, ivy.pk], count: 2 }, 409, 'not_in_burst');
    grantNodeRole(s7.pk, 'moderator', owner.pk);
    await g('an account that holds a role', { members: [s5.pk, s7.pk], count: 2 }, 403, 'holds_role');
    revokeNodeRole(s7.pk, 'moderator', owner.pk);
    // Spam6 has been a member for five weeks: established.
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(36 * DAY), s6.pk);
    const est1 = await g('an established account, not said', { members: [s5.pk, s6.pk], count: 2 }, 409, 'established');
    assert(JSON.stringify(est1.body?.established) === JSON.stringify([s6.pk]), `the refusal names which (${JSON.stringify(est1.body?.established)})`);
    const b6 = await mod('GET', `/api/local/admin/members/${s1.pk}/burst`);
    const a6 = (b6.body?.others ?? []).find((a: any) => a.publicKey === s6.pk);
    assert(a6?.established === true && a6?.standing >= 4 && a6?.standingParts?.weeks === 5, `the list shows Spam6 established, with standing ${a6?.standing}`);
    const h2 = await mod('POST', `/api/local/admin/members/${s1.pk}/burst/hide`, { members: [s5.pk, s6.pk], count: 2, includeEstablished: true });
    assert(h2.status === 200 && h2.body?.action?.posts === 2 && !!hiddenAt(p5) && !!hiddenAt(p6),
        `said in so many words, it goes ahead (${h2.status} ${h2.body?.action?.posts})`);
    const u3 = await mod('POST', `/api/local/admin/bursts/${h2.body?.action?.id}/undo`, {});
    assert(u3.status === 200 && !hiddenAt(p5) && !hiddenAt(p6), `and is undone (${u3.status})`);
    // Spam7 is established by its posts: a week as a member and 3 that stayed up. Hiding them must not lower the bar.
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(8 * DAY), s7.pk);
    const p7 = [1, 2, 3].map(i => {
        const p = createPost('offer', 'other', `Spam7 kept ${i}`, 'kept', 0, 'fixed', s7.pk)!;
        db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
        return p.id;
    });
    const before7 = postsState();
    const est7 = await mod('POST', `/api/local/admin/members/${s1.pk}/burst/hide`, { members: [s7.pk], count: 1 });
    assert(est7.status === 409 && est7.body?.code === 'established' && postsState() === before7,
        `an account established by a week and 3 posts that stayed up is held back too (${est7.status} ${est7.body?.code ?? ''})`);
    const h7 = await mod('POST', `/api/local/admin/members/${s1.pk}/burst/hide`, { members: [s7.pk], count: 1, includeEstablished: true });
    assert(h7.status === 200 && p7.every(p => !!hiddenAt(p)), `said so, its 3 posts are hidden (${h7.status})`);
    const a7 = ((await mod('GET', `/api/local/admin/members/${s1.pk}/burst`)).body?.others ?? []).find((a: any) => a.publicKey === s7.pk);
    assert(a7?.established === true && a7?.standing === 4 && a7?.standingParts?.keptPosts === 3,
        `with its posts hidden it is still established: a post hidden for review still counts as kept here (${a7?.standing})`);
    const rm7 = await adm('POST', `/api/local/admin/members/${s1.pk}/burst/remove`, { members: [s7.pk], count: 1 });
    assert(rm7.status === 409 && rm7.body?.code === 'established' && statusOf(s7) === 'active',
        `so hiding first never makes it removable without saying so (${rm7.status} ${rm7.body?.code ?? ''})`);
    const u7 = await mod('POST', `/api/local/admin/bursts/${h7.body?.action?.id}/undo`, {});
    assert(u7.status === 200 && p7.every(p => !hiddenAt(p)), `and that hide is undone (${u7.status})`);

    // ── 5. remove-all ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. remove-all ──');
    const membersBefore = membersState();
    const rm0 = await mod('POST', `/api/local/admin/members/${s1.pk}/burst/remove`, { members: [s1.pk, s2.pk, s3.pk, s4.pk], count: 4 });
    assert(rm0.status === 403 && membersState() === membersBefore, `a moderator can't remove anyone (${rm0.status} ${rm0.body?.error ?? ''})`);
    const rmEst = await adm('POST', `/api/local/admin/members/${s1.pk}/burst/remove`, { members: [s5.pk, s6.pk], count: 2 });
    assert(rmEst.status === 409 && rmEst.body?.code === 'established' && membersState() === membersBefore,
        `an admin is held to the same guard: an established account only when said (${rmEst.status} ${rmEst.body?.code ?? ''})`);
    const rm1 = await adm('POST', `/api/local/admin/members/${s1.pk}/burst/remove`, { members: [s1.pk, s2.pk, s3.pk, s4.pk], count: 4 });
    assert(rm1.status === 200 && rm1.body?.removed === 4 && Array.isArray(rm1.body?.failed) && rm1.body.failed.length === 0,
        `an admin removes four of them in one action (${rm1.status} ${JSON.stringify(rm1.body)})`);
    assert([s1, s2, s3, s4].every(s => statusOf(s) === 'pruned') && [s5, s6, s7].every(s => statusOf(s) === 'active'),
        'those four are removed as one removal removes a member; the rest are as they were');
    const board3 = await listIds(pat);
    assert(![p1a, p1b, p3, p4].some(p => board3.includes(p)) && board3.includes(p5), 'their posts are off the board');
    const rejoin = await tryDoorJoin(newId('Spam1Again'), subs.get(s1.pk)!);
    assert(rejoin.status === 403 && rejoin.body?.code === 'removed', `Spam1's sign-in can't join again (${rejoin.status} ${rejoin.body?.code})`);
    const signed = await call('GET', s1, '/api/community/me');
    assert(signed.status === 403, `and their key is refused (${signed.status})`);
    const b5 = await adm('GET', `/api/local/admin/members/${s5.pk}/burst`);
    assert(b5.status === 200 && JSON.stringify(keysOf(b5.body?.others)) === JSON.stringify([s6.pk, s7.pk]) && b5.body?.removedAlready === 4,
        `the burst now lists who is left, and says 4 were removed (${JSON.stringify(keysOf(b5.body?.others).map(k => k.slice(0, 6)))} ${b5.body?.removedAlready})`);
    const again = await adm('POST', `/api/local/admin/members/${s5.pk}/burst/remove`, { members: [s1.pk], count: 1 });
    assert(again.status === 409 && again.body?.code === 'not_in_burst', `a removed account can't be named again (${again.status} ${again.body?.code ?? ''})`);
    const dRm = (await adm('GET', '/api/local/admin/bursts')).body;
    assert(dRm?.actions?.[0]?.kind === 'remove' && dRm.actions[0].accounts === 4 && dRm.actions[0].by === 'admin',
        `the digest has a line for the removal, by an admin (${JSON.stringify(dRm?.actions?.[0])})`);
    assert(dRm?.bursts?.[0]?.removed === 4 && dRm?.bursts?.[0]?.stillHere === 3, `and the burst's line counts them (${JSON.stringify(dRm?.bursts?.[0])})`);
    assert((await mod('POST', `/api/local/admin/bursts/${dRm?.actions?.[0]?.id}/undo`, {})).status === 409, 'a removal has no undo');

    // ── 6. nobody else ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. nobody else ──');
    const routes: Array<['GET' | 'POST', string, unknown]> = [
        ['GET', '/api/local/admin/bursts', undefined],
        ['GET', `/api/local/admin/members/${s5.pk}/burst`, undefined],
        ['POST', `/api/local/admin/members/${s5.pk}/burst/hide`, { members: [s5.pk], count: 1 }],
        ['POST', `/api/local/admin/members/${s5.pk}/burst/remove`, { members: [s5.pk], count: 1 }],
        ['POST', `/api/local/admin/bursts/${hideId}/undo`, {}],
    ];
    const before6 = postsState() + membersState();
    for (const [method, path, body] of routes) {
        const unsigned = await call(method, null, path, body);
        const signedByMember = await call(method, pat, path, body);
        assert(unsigned.status === 401 && [401, 403].includes(signedByMember.status) && !/Spam5/.test(unsigned.text + signedByMember.text),
            `${method} ${path.replace(s5.pk, ':pubkey').replace(hideId, ':id')}: unsigned ${unsigned.status}, a member's signature ${signedByMember.status}, nobody named`);
    }
    let patSession = '';
    try { patSession = keySession(pat); } catch { /* refused */ }
    assert(patSession === '', 'a member with no role gets no session to try with');
    revokeNodeRole(mo.pk, 'moderator', owner.pk);
    const revoked = await mod('GET', `/api/local/admin/members/${s5.pk}/burst`);
    assert([401, 403].includes(revoked.status) && !/Spam6/.test(revoked.text), `a moderator whose role was taken is refused (${revoked.status})`);
    assert(postsState() + membersState() === before6, 'none of it changed anything');
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    mod = as(keySession(mo));

    // ── 7. no address, no network ────────────────────────────────────────────────────────────────
    console.log('\n── 7. no answer names the connection ──');
    const secrets = [...labels, ...ipHashes, '127.0.0.1', '::1', '::ffff:'];
    const leaked = answers.filter(t => secrets.some(s => t.includes(s)));
    assert(answers.length > 40 && leaked.length === 0,
        `none of the ${answers.length} answers carries an address, the address hash or the connection label${leaked.length ? ` — ${leaked[0].slice(0, 200)}` : ''}`);
    const BAD_FIELD = /(^ip$|^ip[A-Z_]|[a-z]Ip([A-Z]|$)|_ip|hash|cohort|label|address|network|subnet)/;
    const fields = new Set<string>();
    const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { fields.add(k); walk(x); }
    };
    for (const t of answers) { try { walk(JSON.parse(t)); } catch { /* not JSON */ } }
    const badFields = [...fields].filter(k => BAD_FIELD.test(k));
    assert(fields.size > 10 && badFields.length === 0, `nor a field named for one (${badFields.join(', ') || `${fields.size} fields, none`})`);

    // ── 8. a member who deletes their own account leaves every record ────────────────────────────
    console.log('\n── 8. a member who deletes their own account ──');
    const fromS5 = await adm('POST', `/api/local/admin/members/${s5.pk}/burst/hide`, { members: [s7.pk], count: 1, includeEstablished: true });
    assert(fromS5.status === 200, `setup: an action opened from Spam5 (${fromS5.status})`);
    const recordsOf = () => (db.prepare('SELECT COUNT(*) AS c FROM burst_action_posts WHERE post_id = ?').get(p5) as { c: number }).c
        + (db.prepare('SELECT COUNT(*) AS c FROM burst_actions WHERE anchor_pubkey = ?').get(s5.pk) as { c: number }).c;
    assert(recordsOf() === 2, `setup: the records name Spam5's post and Spam5 (${recordsOf()})`);
    const purge = await call('POST', s5, '/api/member/purge', {});
    assert(purge.status === 200 && statusOf(s5) === 'pruned', `Spam5 deletes their own account (${purge.status})`);
    assert(recordsOf() === 0, `and leaves every burst record: their post, and their key as the account an action was opened from (${recordsOf()})`);
    const b6after = await adm('GET', `/api/local/admin/members/${s6.pk}/burst`);
    assert(JSON.stringify(keysOf(b6after.body?.others)) === JSON.stringify([s7.pk]) && b6after.body?.removedAlready === 4,
        `nor are they in anyone's burst any more, as removed or otherwise (${keysOf(b6after.body?.others).length} ${b6after.body?.removedAlready})`);
    const dPurge = (await adm('GET', '/api/local/admin/bursts')).body;
    assert(dPurge?.actions?.[0]?.id === fromS5.body?.action?.id && dPurge.actions[0].account === null, 'the digest\'s line for that action names nobody now');

    // ── 9. a report on a post is about the post's author ─────────────────────────────────────────
    console.log('\n── 9. a report on a post is about its author, whoever it names ──');
    const lA = `label-a-${crypto.randomUUID()}`, lV = `label-v-${crypto.randomUUID()}`;
    const aa6 = doorRow('A6', lA), aa7 = doorRow('A7', lA);
    const v3 = doorRow('V3', lV), v4 = doorRow('V4', lV);
    const pA6 = createPost('offer', 'other', 'A6 watches', 'cheap', 0, 'fixed', aa6.pk)!.id;
    const namesV3 = await call('POST', pat, '/api/reports', { reporterPubkey: pat.pk, targetPubkey: v3.pk, targetPostId: pA6, reason: 'spam' });
    const storedTarget = (db.prepare('SELECT target_pubkey FROM abuse_reports WHERE id = ?').get(namesV3.body?.report?.id) as any)?.target_pubkey;
    assert(namesV3.status === 200 && namesV3.body?.report?.targetPubkey === aa6.pk && storedTarget === aa6.pk,
        `a report on A6's post that names V3 is filed about A6, the post's author (${namesV3.status} ${storedTarget === v3.pk ? 'V3' : storedTarget === aa6.pk ? 'A6' : storedTarget})`);
    // One filed before that rule, naming V3 on A6's post, as a crafted client could.
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at) VALUES (?, ?, ?, ?, 'spam', ?)`)
        .run(crypto.randomUUID(), ivy.pk, v3.pk, pA6, new Date().toISOString());
    const onA6 = ((await mod('GET', '/api/local/admin/reports?status=open&limit=200')).body?.reports ?? []).filter((r: any) => r.postId === pA6);
    assert(onA6.length === 2 && onA6.every((r: any) => r.postAuthorPubkey === aa6.pk),
        `the reports list names the post's author on both, the account "Who joined with them" opens (${JSON.stringify(onA6.map((r: any) => [r.targetPubkey === v3.pk ? 'V3' : 'A6', r.postAuthorPubkey === aa6.pk ? 'A6' : r.postAuthorPubkey]))})`);
    const mV3 = await mod('GET', `/api/local/admin/members/${v3.pk}/burst`);
    assert(mV3.status === 403 && mV3.body?.code === 'not_reported' && !keysOf(mV3.body?.others).includes(v4.pk),
        `neither opens V3's group to a moderator: a post report counts against the post's author only (${mV3.status} ${mV3.body?.code ?? ''})`);
    const mA6 = await mod('GET', `/api/local/admin/members/${aa6.pk}/burst`);
    assert(mA6.status === 200 && JSON.stringify(keysOf(mA6.body?.others)) === JSON.stringify([aa7.pk]), `A6's group opens: A7 (${mA6.status})`);

    // ── 10. a moderator's own report opens nobody's group ────────────────────────────────────────
    console.log('\n── 10. a moderator\'s own report opens nobody\'s group ──');
    const lB = `label-b-${crypto.randomUUID()}`;
    const bb1 = doorRow('B1', lB), bb2 = doorRow('B2', lB);
    const m0 = await mod('GET', `/api/local/admin/members/${bb1.pk}/burst`);
    assert(m0.status === 403 && m0.body?.code === 'not_reported', `a moderator is refused B1's group, nothing reported (${m0.status} ${m0.body?.code ?? ''})`);
    const byMo = await call('POST', mo, '/api/reports', { reporterPubkey: mo.pk, targetPubkey: bb1.pk, reason: 'spam' });
    assert(byMo.status === 200, `setup: the moderator reports B1 from their member key (${byMo.status})`);
    const m1 = await mod('GET', `/api/local/admin/members/${bb1.pk}/burst`);
    assert(m1.status === 403 && m1.body?.code === 'not_reported' && !keysOf(m1.body?.others).includes(bb2.pk),
        `their own report doesn't open it: still 403 not_reported (${m1.status} ${m1.body?.code ?? ''})`);
    const byPat = await call('POST', pat, '/api/reports', { reporterPubkey: pat.pk, targetPubkey: bb1.pk, reason: 'spam' });
    assert(byPat.status === 200, `setup: Pat reports B1 (${byPat.status})`);
    const m2 = await mod('GET', `/api/local/admin/members/${bb1.pk}/burst`);
    assert(m2.status === 200 && JSON.stringify(keysOf(m2.body?.others)) === JSON.stringify([bb2.pk]),
        `another member's report does: B2 (${m2.status})`);

    // ── 11. statuses ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 11. a member suspended from a report shows as suspended ──');
    const onB2 = await call('POST', pat, '/api/reports', { reporterPubkey: pat.pk, targetPubkey: bb2.pk, reason: 'spam' });
    const susp = await adm('POST', `/api/local/admin/reports/${onB2.body?.report?.id}/action`, { suspendUser: true });
    assert(susp.status === 200 && statusOf(bb2) === 'suspended', `setup: an admin suspends B2 from a report (${susp.status} ${statusOf(bb2)})`);
    const sB2 = ((await adm('GET', `/api/local/admin/members/${bb1.pk}/burst`)).body?.others ?? []).find((a: any) => a.publicKey === bb2.pk);
    assert(sB2?.status === 'suspended', `B1's group lists B2 as suspended (${sB2?.status})`);
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(bb2.pk);
    const dB2 = ((await adm('GET', `/api/local/admin/members/${bb1.pk}/burst`)).body?.others ?? []).find((a: any) => a.publicKey === bb2.pk);
    assert(dB2?.status === 'suspended', `and one suspended by an admin's status ('disabled') too (${dB2?.status})`);

    // ── 12. an undo weighs each post with the whole hide undone ──────────────────────────────────
    console.log('\n── 12. an undo weighs each post with the whole hide undone ──');
    const c1 = doorRow('C1', `label-c-${crypto.randomUUID()}`);
    const twin = member('Twin', 0);
    const cPosts = [1, 2, 3].map(i => createPost('offer', 'other', `C1 thing ${i}`, 'thing', 0, 'fixed', c1.pk)!.id);
    const tPosts = [1, 2, 3].map(i => createPost('offer', 'other', `Twin thing ${i}`, 'thing', 0, 'fixed', twin.pk)!.id);
    const hC = await adm('POST', `/api/local/admin/members/${c1.pk}/burst/hide`, { members: [c1.pk], count: 1 });
    assert(hC.status === 200 && hC.body?.action?.posts === 3 && cPosts.every(p => !!hiddenAt(p)), `setup: C1's 3 posts hidden in one action (${hC.status})`);
    // Three reporters in three circles (each invited by the owner), a week and a day a member: standing 1 each.
    const rs = [1, 2, 3].map(i => member(`Rep${i}`, 8));
    for (const r of rs) {
        for (const p of cPosts) if ((await report(r, p, c1)).status !== 200) throw new Error('report refused');
        for (const p of tPosts) if ((await report(r, p, twin)).status !== 200) throw new Error('report refused');
    }
    assert(tPosts.every(p => !hiddenAt(p)),
        'setup: the same reports on a twin\'s 3 posts, never hidden, hide 0 of 3 (its standing is 3, so each needs reporters of 2)');
    const uC = await adm('POST', `/api/local/admin/bursts/${hC.body?.action?.id}/undo`, {});
    assert(uC.status === 200 && uC.body?.restored === 3 && uC.body?.keptHidden === 0 && cPosts.every(p => !hiddenAt(p)),
        `the undo brings all 3 back: weighed with the hide undone, reports would hide none of them (${uC.status} ${JSON.stringify(uC.body)})`);

    // ── 13. one doorbell per action, not one per post ────────────────────────────────────────────
    console.log('\n── 13. one doorbell per action, not one per post ──');
    const lD = `label-d-${crypto.randomUUID()}`;
    const dd = [1, 2, 3].map(i => doorRow(`D${i}`, lD));
    for (const d of dd) for (let i = 1; i <= 20; i++) createPost('offer', 'other', `${d.name} item ${i}`, 'item', 0, 'fixed', d.pk);
    const socks = [await socket(pat), await socket(null)];
    const settle = () => new Promise(r => setTimeout(r, 300));
    await settle();
    const listingFrames = (s: Sock) => s.events.filter(e => e?.type === 'post_updated' || e?.type === 'post_removed' || e?.type === 'new_post');
    for (const s of socks) s.events.length = 0;
    const hD = await adm('POST', `/api/local/admin/members/${dd[0].pk}/burst/hide`, { members: dd.map(d => d.pk), count: 3 });
    await settle();
    const onHide = socks.map(s => listingFrames(s).length);
    assert(hD.status === 200 && hD.body?.action?.posts === 60 && onHide[0] >= 1 && onHide.every(n => n <= 2),
        `a hide of 60 posts rings each open socket at most twice, not once per post (member ${onHide[0]}, guest ${onHide[1]})`);
    for (const s of socks) s.events.length = 0;
    const uD = await adm('POST', `/api/local/admin/bursts/${hD.body?.action?.id}/undo`, {});
    await settle();
    const onUndo = socks.map(s => listingFrames(s).length);
    assert(uD.status === 200 && uD.body?.restored === 60 && onUndo[0] >= 1 && onUndo.every(n => n <= 2),
        `and its undo the same (member ${onUndo[0]}, guest ${onUndo[1]})`);
    for (const s of socks) s.ws.close();

    // ── 14. a local node ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 14. a local node ──');
    delete process.env.NODE_PROFILE;
    const info = (await call('GET', null, '/api/community/info')).body?.features ?? {};
    assert(info.openJoin === false, `setup: the local profile, the door shut (${info.openJoin})`);
    const before8 = postsState() + membersState();
    for (const [method, path, body] of routes) {
        const r = await own(method, path, method === 'POST' && path.includes('/burst/') ? { members: [s5.pk], count: 1, includeEstablished: true } : body);
        assert(r.status === 404 && !/Spam5|Spam6/.test(r.text),
            `${method} ${path.replace(s5.pk, ':pubkey').replace(hideId, ':id')}: 404 to an owner on a local node (${r.status})`);
    }
    assert(postsState() + membersState() === before8, 'and nothing changed');
    assert((await own('GET', '/api/local/admin/reports?status=open')).status === 200, 'the reports screen works as it did');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
