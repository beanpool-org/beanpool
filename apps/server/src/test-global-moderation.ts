/**
 * Moderation on the global profile (G3, design §2.5, D3 = a): probation for new accounts, auto-hide on reports,
 * auto-mute, and a moderator undoing the last two. Over REAL HTTPS through the real signature middleware; the
 * notices on signed member sockets; moderators on real key sessions. "The clock" is faked by moving rows back in time
 * (joined_at, created_at, a message's timestamp, removed_by_moderator_at), which is all any of the rules read.
 *
 *   1. local profile (NODE_PROFILE unset): /api/community/info reports probation, autoHideReports and autoMute false;
 *      3 established reporters hide nothing; a brand-new member makes 4 posts in a row and messages 11 new people;
 *      3 posts removed by a moderator mute nobody; /api/community/me says so
 *   2. global profile: /api/community/info reports all three true
 *   3. auto-hide: 3 reporters under 7 days old hide nothing; 2 reporters plus one of them twice hide nothing; 3
 *      distinct reporters of 7+ days hide it; a member report never hides anyone's posts. Hidden: absent from the
 *      listing, search, read by id, the map read (events and pins) and the activity feed for other members and
 *      strangers; its photos 404 unless the author or a moderator signs; a sync read gives others a removal; the
 *      author and moderators still see it, marked; only the author's socket gets the notice (reason "reports"), and an
 *      edit of it reaches only the author in full; a vote in a hidden poll or an RSVP to a hidden event is refused to
 *      anyone but its author, and hands nothing back. A moderator restore un-hides it and its author hears, the same
 *      reporters can't hide it again, new ones can; dismissing reports un-hides once they no longer add up; a
 *      moderator can still remove it. A moderator can't restore their own post or dismiss a report on it (another
 *      can), and restoring a post its author took down tells them nothing
 *   4. probation: the 4th post in 24 hours → 429 with the limit and when it resets; the window rolls after 24 hours;
 *      photos past 5 → 429, on a new post and on an edit; after 72 hours with 3 kept posts no limits; an old account
 *      with no posts is on probation until it has 3; DMs to an 11th new person → 429 (start and send), a reply to
 *      someone who wrote first and a known contact → allowed, and the window rolls; /api/community/me reports it all
 *   5. auto-mute: 3 moderator removals in 30 days → posting, editing, starting and sending messages refused 403; still
 *      reads and edits the profile; the moderators' muted list names them; a moderator lifts it and both come back,
 *      and one more removal after the lift does not re-mute; removals 31+ days apart never mute
 *   6. replication: the export carries hidden_by_reports_at, removed_by_moderator_at and moderation_muted_until, and
 *      a standby importing it (insert and update) holds all three
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-global-moderation.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, grantNodeRole, createPost, exportSyncState, importRemoteState, setNodeRole,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without G3 (no such column) must fail its assertion, not abort the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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
/** A member who joined `daysAgo` days ago, with a profile photo (posting needs one). */
function member(name: string, daysAgo: number): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; headers: Headers }
async function call(method: 'GET' | 'POST', id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
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
    try { parsed = JSON.parse(text); } catch { /* binary or empty */ }
    return { status: res.status, body: parsed, headers: res.headers };
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

// ── what the member does ────────────────────────────────────────────────────────────────────────
const photo = (seed: string) => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.createHash('sha512').update(seed).digest(), Buffer.from([0xff, 0xd9])]);
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};
let n = 0;
const post = (id: Id, extra: Record<string, unknown> = {}) =>
    call('POST', id, '/api/marketplace/posts', { type: 'offer', category: 'other', title: `${id.name} offer ${++n}`, description: 'An offer', credits: 0, authorPublicKey: id.pk, ...extra });
/** A post written straight into the engine, as it would be by a member long before the test, out of any window. */
function oldPost(id: Id, title: string, extra: { lat?: number; lng?: number; photos?: string[] } = {}): string {
    const p = createPost('offer', 'other', title, `${title} description`, 0, 'fixed', id.pk, extra.lat, extra.lng, extra.photos)!;
    db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
    return p.id;
}
const report = (reporter: Id, postId: string, author: Id) =>
    call('POST', reporter, '/api/reports', { reporterPubkey: reporter.pk, targetPubkey: author.pk, targetPostId: postId, reason: 'spam' });
async function dm(from: Id, to: Id): Promise<{ conv: Res; send: Res | null }> {
    const conv = await call('POST', from, '/api/messages/conversation', { type: 'dm', participants: [from.pk, to.pk], createdBy: from.pk });
    if (conv.status !== 200) return { conv, send: null };
    const send = await call('POST', from, '/api/messages/send', { conversationId: conv.body.conversation.id, authorPubkey: from.pk, ciphertext: 'c2VjcmV0', nonce: 'bm9uY2U=' });
    return { conv, send };
}
const hiddenAt = (postId: string) => attempt(() => (db.prepare('SELECT hidden_by_reports_at FROM posts WHERE id = ?').get(postId) as any)?.hidden_by_reports_at) ?? null;
const mutedUntil = (id: Id) => attempt(() => (db.prepare('SELECT moderation_muted_until FROM members WHERE public_key = ?').get(id.pk) as any)?.moderation_muted_until) ?? null;
const listIds = async (viewer: Id | null, query = '') => {
    const r = await call('GET', viewer, `/api/marketplace/posts${query}`);
    return Array.isArray(r.body) ? r.body.map((p: any) => p.id) as string[] : [];
};
const info = async () => (await call('GET', null, '/api/community/info')).body;
const me = async (id: Id) => (await call('GET', id, '/api/community/me')).body;
/** A moderator removes one post, as they may: through an open report on it (each by a new reporter, 10 an hour each). */
let reporters = 0;
async function removeByModerator(poster: Id, postId: string): Promise<number> {
    const r = await report(member(`Flag${++reporters}`, 90), postId, poster);
    if (r.status !== 200) throw new Error(`report refused: ${r.status}`);
    return (await admin('POST', `/api/local/admin/posts/${postId}/delete`, { reasonCategory: 'spam' })).status;
}

// ── signed member sockets, for the notices ──────────────────────────────────────────────────────
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}

async function main(): Promise<void> {
    console.log('\n=== Moderation on the global profile (G3) ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const mo = member('Mo', 60);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    modSession = keySession(mo);
    const viewer = member('Vic', 60);
    const stranger = null;
    // Established reporters (8+ days), and new ones.
    const R = [1, 2, 3, 4, 5, 6].map(i => member(`Rep${i}`, 8 + i));
    const N = [1, 2, 3].map(i => member(`New${i}`, 1));

    // ── 1. local profile ─────────────────────────────────────────────────────────────────────────
    console.log('── 1. local profile: nothing here fires ──');
    let f = (await info()).features ?? {};
    assert(f.probation === false && f.autoHideReports === false && f.autoMute === false,
        `local: /api/community/info reports probation, autoHideReports and autoMute false (got ${JSON.stringify({ p: f.probation, h: f.autoHideReports, m: f.autoMute })})`);
    const localAuthor = member('Lou', 30);
    const localPost = oldPost(localAuthor, 'Local listing');
    for (const r of R.slice(0, 3)) assert((await report(r, localPost, localAuthor)).status === 200, `local: ${r.name} reports it (200)`);
    assert(hiddenAt(localPost) === null && (await listIds(viewer)).includes(localPost), 'local: 3 established reporters hide nothing; the post is still listed for everyone');
    const localNew = member('Lenny', 0);
    const localPosts = [];
    for (let i = 0; i < 4; i++) localPosts.push((await post(localNew)).status);
    assert(localPosts.every(s => s === 200), `local: a member who joined just now makes 4 posts in a row (${localPosts.join(',')})`);
    const targets = Array.from({ length: 12 }, (_, i) => member(`Target${i + 1}`, 30));
    const localDms: number[] = [];
    for (const t of targets.slice(0, 11)) { const r = await dm(localNew, t); localDms.push(r.send?.status ?? r.conv.status); }
    assert(localDms.every(s => s === 200), `local: they message 11 new people (${localDms.join(',')})`);
    const localMax = member('Lars', 30);
    const removedLocal: number[] = [];
    for (let i = 0; i < 3; i++) removedLocal.push(await removeByModerator(localMax, oldPost(localMax, `Lars listing ${i}`)));
    assert(removedLocal.every(s => s === 200), `local: a moderator removes 3 of Lars's posts (${removedLocal.join(',')})`);
    assert(mutedUntil(localMax) === null && (await post(localMax)).status === 200 && (await dm(localMax, targets[0])).send?.status === 200,
        'local: 3 removals mute nobody: Lars still posts and messages');
    const localMe = await me(localNew);
    assert(localMe?.probation?.onProbation === false && localMe?.probation?.exemptBecause === 'off' && localMe?.mute?.muted === false,
        `local: /api/community/me says no probation (off here) and no mute (got ${JSON.stringify({ p: localMe?.probation?.onProbation, e: localMe?.probation?.exemptBecause, m: localMe?.mute })})`);

    // ── 2. global profile ────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. global profile ──');
    process.env.NODE_PROFILE = 'global';
    f = (await info()).features ?? {};
    assert(f.probation === true && f.autoHideReports === true && f.autoMute === true,
        `global: /api/community/info reports probation, autoHideReports and autoMute true (got ${JSON.stringify({ p: f.probation, h: f.autoHideReports, m: f.autoMute })})`);

    // ── 3. auto-hide ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. auto-hide ──');
    const ava = member('Ava', 40);
    for (let i = 0; i < 3; i++) oldPost(ava, `Ava kept ${i}`);
    const byNew = oldPost(ava, 'Reported by new accounts');
    for (const r of N) await report(r, byNew, ava);
    assert(hiddenAt(byNew) === null, '3 reporters who joined under 7 days ago hide nothing');
    const byTwo = oldPost(ava, 'Reported by two');
    await report(R[0], byTwo, ava);
    await report(R[1], byTwo, ava);
    const again = await report(R[0], byTwo, ava);
    assert(again.status === 200 && again.body?.duplicate === true && hiddenAt(byTwo) === null, '2 established reporters, one of them twice, hide nothing');

    const avaSock = await socket(ava);
    const vicSock = await socket(viewer);
    await sleep(100);
    avaSock.events.length = 0; vicSock.events.length = 0;
    const word = `zebrawidget${crypto.randomBytes(3).toString('hex')}`;
    const target = createPost('offer', 'other', `Hidden ${word}`, `The ${word} to hide`, 0, 'fixed', ava.pk, -28.55, 153.5, [photo('hidden')])!.id;
    const ev = createPost('event', 'other', 'Hidden gathering', 'An event to hide', 0, 'fixed', ava.pk, -28.55, 153.5, [], false, undefined, false,
        { eventStartAt: new Date(Date.now() + 2 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 2 * DAY + 2 * HOUR).toISOString(), eventPlaceName: 'Hall' })!.id;
    await call('POST', viewer, `/api/marketplace/posts/${ev}/rsvp`, { status: 'going' });
    const feedBefore = (await call('GET', viewer, '/api/activity/feed')).body?.feed ?? [];
    assert(feedBefore.some((e: any) => e.eventType === 'post_created' && e.metadata?.postId === target), 'before: the activity feed announces the post');
    const photoUrl = `/api/marketplace/posts/${target}/photos/0`;
    assert((await call('GET', null, photoUrl)).status === 200, 'before: its photo is served to anyone');
    for (const r of R.slice(0, 3)) await report(r, target, ava);
    for (const r of R.slice(0, 3)) await report(r, ev, ava);
    assert(!!hiddenAt(target) && !!hiddenAt(ev), '3 distinct reporters of 7+ days hide the post, and the event');
    const row = db.prepare('SELECT active, status FROM posts WHERE id = ?').get(target) as any;
    assert(row.active === 1 && row.status === 'active', 'hidden is not removed: active and status are untouched');

    assert(!(await listIds(viewer)).includes(target) && !(await listIds(stranger)).includes(target), 'absent from the listing for another member and for a stranger');
    assert(!(await listIds(viewer, `?q=${word}`)).includes(target), 'absent from search');
    assert((await listIds(viewer, `?id=${target}`)).length === 0, 'absent when read by id');
    const mapRead = await listIds(viewer, '?types=offer,need,poll,event');
    assert(!mapRead.includes(target) && !mapRead.includes(ev), 'absent from the map read (pins and events)');
    assert(!(await listIds(viewer, '?type=event')).includes(ev), 'absent from the events list');
    const myEvents = (await call('GET', viewer, '/api/events/mine')).body?.events ?? [];
    assert(!myEvents.some((e: any) => e.postId === ev), 'gone from the calendar of someone who said they were going');
    const feedAfter = (await call('GET', viewer, '/api/activity/feed')).body?.feed ?? [];
    assert(!feedAfter.some((e: any) => e.eventType === 'post_created' && e.metadata?.postId === target), 'gone from the activity feed');
    const sync = await call('GET', viewer, '/api/marketplace/posts?sync=true&limit=1000&types=offer,need,poll,event');
    const stub = (sync.body as any[]).find(p => p.id === target);
    assert(!!stub && stub.active === false && stub.status === 'cancelled' && stub.title === '' && stub.description === ''
        && (stub.photos ?? []).length === 0 && !('hiddenByReportsAt' in stub),
        `a sync read gives another member a removal with nothing of what it said, so their phone drops it (got ${JSON.stringify(stub)?.slice(0, 160)})`);
    assert((await call('GET', null, photoUrl)).status === 404 && (await call('GET', viewer, photoUrl)).status === 404,
        'its photo is 404 to a stranger and to another member');
    assert((await call('GET', ava, photoUrl)).status === 200 && (await call('GET', mo, photoUrl)).status === 200,
        'and served to its author and to a moderator, when they sign');
    const avaView = (await call('GET', ava, `/api/marketplace/posts?id=${target}`)).body;
    assert(avaView?.[0]?.id === target && typeof avaView[0].hiddenByReportsAt === 'string', 'the author still sees it, marked hiddenByReportsAt');
    assert((await listIds(ava)).includes(target), 'and in their listing');
    const moView = await call('GET', mo, '/api/marketplace/posts?types=offer,need,poll,event');
    const moPost = (moView.body as any[]).find(p => p.id === target);
    assert(!!moPost && typeof moPost.hiddenByReportsAt === 'string', 'a moderator sees it, marked');
    await sleep(200);
    const avaNotice = avaSock.events.find(e => e.type === 'system_announcement' && e.kind === 'post_hidden' && e.postId === target);
    assert(!!avaNotice && avaNotice.reason === 'reports' && /hidden/.test(avaNotice.body) && /not been removed/.test(avaNotice.body),
        `the author gets the notice, reason "reports", hidden not removed (got ${JSON.stringify(avaNotice)?.slice(0, 200)})`);
    assert(!vicSock.events.some(e => e.type === 'system_announcement'), 'nobody else gets a notice');
    assert(vicSock.events.some(e => e.type === 'post_updated' && e.id === target && !e.post), 'other sockets get a doorbell only, never the post');
    avaSock.events.length = 0; vicSock.events.length = 0;
    const edit = await call('POST', ava, '/api/marketplace/posts/update', { id: target, authorPublicKey: ava.pk, description: `Edited ${word}` });
    await sleep(200);
    assert(edit.status === 200, `the author can still edit it (${edit.status})`);
    assert(avaSock.events.some(e => e.type === 'post_updated' && e.post?.id === target && e.post?.hiddenByReportsAt),
        'the edit reaches the author in full');
    assert(!vicSock.events.some(e => e.post?.id === target) && vicSock.events.some(e => e.type === 'post_updated' && e.id === target),
        'and every other socket only as a doorbell: the edit never publishes a hidden post');
    const q = (await admin('GET', '/api/local/admin/reports?status=pending')).body?.reports ?? [];
    assert(q.some((r: any) => r.postId === target && r.postHiddenByReports === true), 'the moderators\' queue marks the reports as on a hidden post');

    // A hidden poll or event is not there for anyone but its author to vote in or RSVP to either: the answer would
    // hand the whole post back. Reporters of their own, so the ones above stay under the hourly report limit.
    const S = [1, 2, 3].map(i => member(`Sam${i}`, 20));
    const poll = createPost('poll', 'other', `Hidden poll ${word}`, `Which ${word}?`, 0, 'fixed', ava.pk, undefined, undefined, [], false, undefined, false,
        { pollOptions: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] })!.id;
    for (const r of S) await report(r, poll, ava);
    assert(!!hiddenAt(poll), 'setup: a poll hidden by reports');
    const vote = await call('POST', viewer, `/api/marketplace/posts/${poll}/vote`, { optionId: 'a' });
    assert(vote.status === 400 && !vote.body?.post && !JSON.stringify(vote.body ?? '').includes(word),
        `another member's vote in a hidden poll is refused, and hands nothing of it back (got ${vote.status} ${JSON.stringify(vote.body)?.slice(0, 120)})`);
    const rsvp = await call('POST', viewer, `/api/marketplace/posts/${ev}/rsvp`, { status: 'interested' });
    assert(rsvp.status === 400 && !rsvp.body?.post,
        `so is an RSVP to a hidden event, even from someone who said they were going (got ${rsvp.status} ${JSON.stringify(rsvp.body)?.slice(0, 120)})`);
    const votes = (db.prepare('SELECT COUNT(*) AS c FROM poll_votes WHERE post_id = ?').get(poll) as any).c;
    const viewerRsvp = db.prepare('SELECT status FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(ev, viewer.pk) as any;
    assert(votes === 0 && viewerRsvp?.status === 'going', 'and neither is recorded');
    const ownVote = await call('POST', ava, `/api/marketplace/posts/${poll}/vote`, { optionId: 'b' });
    assert(ownVote.status === 200 && ownVote.body?.post?.id === poll, `its author can still vote in it (${ownVote.status})`);

    const restored = await admin('POST', `/api/local/admin/posts/${target}/restore`);
    assert(restored.status === 200 && hiddenAt(target) === null, `a moderator restores it (${restored.status})`);
    assert((await listIds(viewer)).includes(target) && (await call('GET', null, photoUrl)).status === 200, 'everyone sees it again, photo included');
    await sleep(200);
    assert(avaSock.events.some(e => e.type === 'system_announcement' && e.kind === 'post_restored' && e.postId === target), 'and its author hears it is back');
    const openLeft = (db.prepare(`SELECT COUNT(*) AS c FROM abuse_reports WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL)`).get(target) as any).c;
    assert(openLeft === 0, 'the restore dismissed the reports that hid it');
    assert((await admin('POST', `/api/local/admin/posts/${target}/restore`)).status === 409, 'restoring a post that is not hidden → 409');
    for (const r of R.slice(0, 3)) assert((await report(r, target, ava)).status === 200, `${r.name} reports it again (a new report)`);
    assert(hiddenAt(target) === null, 'the reporters a moderator already answered cannot hide it again');
    await report(R[3], target, ava);
    await report(R[4], target, ava);
    assert(hiddenAt(target) === null, '2 new reporters are not enough');
    await report(R[5], target, ava);
    assert(!!hiddenAt(target), 'a third NEW established reporter hides it again: restore wins until new reports add up');

    // Dismissing one report at a time un-hides once what hid it no longer adds up.
    const evReports = db.prepare(`SELECT id FROM abuse_reports WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL)`).all(ev) as { id: string }[];
    assert((await admin('POST', `/api/local/admin/reports/${evReports[0].id}/dismiss`)).status === 200 && hiddenAt(ev) === null,
        'dismissing one of the event\'s 3 reports un-hides it (2 left is not enough)');
    assert((await listIds(viewer, '?type=event')).includes(ev), 'and it is back on the events list');

    // A moderator removal of a hidden post works as always.
    const openOnTarget = db.prepare(`SELECT id FROM abuse_reports WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL)`).get(target) as { id: string };
    const actioned = await admin('POST', `/api/local/admin/reports/${openOnTarget.id}/action`, { deletePost: true, reasonCategory: 'spam' });
    const gone = attempt(() => db.prepare('SELECT active, status, removed_by_moderator_at FROM posts WHERE id = ?').get(target) as any);
    assert(actioned.status === 200 && gone?.active === 0 && gone?.status === 'cancelled' && !!gone?.removed_by_moderator_at,
        'a moderator can remove a hidden post, and the removal is recorded');

    // A report of a MEMBER never hides anyone.
    const mia = member('Mia', 40);
    const miaPost = oldPost(mia, 'Mia listing');
    for (const r of R.slice(0, 3)) await call('POST', r, '/api/reports', { reporterPubkey: r.pk, targetPubkey: mia.pk, reason: 'rude' });
    assert(hiddenAt(miaPost) === null && (await listIds(viewer)).includes(miaPost), '3 established reports of a member hide nothing of theirs');
    const miaQueued = (db.prepare(`SELECT COUNT(*) AS c FROM abuse_reports WHERE target_pubkey = ? AND target_post_id IS NULL AND status = 'pending'`).get(mia.pk) as any).c;
    assert(miaQueued === 3, 'they wait in the queue');

    // A moderator can't undo a hide on their own post, by restoring it or by dismissing a report on it; another can.
    const moOwn = oldPost(mo, 'Mo listing');
    for (const r of S) await report(r, moOwn, mo);
    assert(!!hiddenAt(moOwn), 'setup: established reporters hide a moderator\'s own post');
    const moOwnReport = db.prepare(`SELECT id FROM abuse_reports WHERE target_post_id = ? AND (status = 'pending' OR status IS NULL)`).get(moOwn) as { id: string };
    const selfRestore = await admin('POST', `/api/local/admin/posts/${moOwn}/restore`);
    const selfDismiss = await admin('POST', `/api/local/admin/reports/${moOwnReport.id}/dismiss`);
    assert(selfRestore.status === 403 && selfDismiss.status === 403 && !!hiddenAt(moOwn),
        `a moderator can't restore their own hidden post, or dismiss a report on it (${selfRestore.status}, ${selfDismiss.status}): it stays hidden`);
    const moe = member('Moe', 60);
    grantNodeRole(moe.pk, 'moderator', owner.pk);
    const moeRestore = await call('POST', null, `/api/local/admin/posts/${moOwn}/restore`, undefined, { 'x-admin-session': keySession(moe) });
    assert(moeRestore.status === 200 && hiddenAt(moOwn) === null, `another moderator restores it (${moeRestore.status})`);

    // A hidden post its author then took down, restored later: the author is not told it is back, because it isn't.
    const takenDown = oldPost(ava, 'Hidden, then taken down');
    for (const r of S) await report(r, takenDown, ava);
    const takeDown = await call('POST', ava, '/api/marketplace/posts/remove', { id: takenDown, authorPublicKey: ava.pk });
    assert(!!hiddenAt(takenDown) && takeDown.status === 200, `setup: hidden, then its author takes it down (${takeDown.status})`);
    avaSock.events.length = 0;
    const restoreDown = await admin('POST', `/api/local/admin/posts/${takenDown}/restore`);
    await sleep(200);
    assert(restoreDown.status === 200 && !avaSock.events.some(e => e.type === 'system_announcement' && e.kind === 'post_restored'),
        `restoring it tells its author nothing (${restoreDown.status}, ${JSON.stringify(avaSock.events.filter(e => e.type === 'system_announcement'))?.slice(0, 160)})`);
    avaSock.ws.close(); vicSock.ws.close();

    // ── 4. probation ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. probation ──');
    const nia = member('Nia', 0);
    const three = [await post(nia), await post(nia), await post(nia)].map(r => r.status);
    assert(three.every(s => s === 200), `a new member makes 3 posts (${three.join(',')})`);
    const fourth = await post(nia);
    assert(fourth.status === 429 && fourth.body?.code === 'probation_limit' && fourth.body?.limit === 'posts',
        `the 4th post in 24 hours → 429 probation_limit, limit posts (got ${fourth.status} ${JSON.stringify(fourth.body)?.slice(0, 120)})`);
    assert(/3 posts in any 24 hours/.test(fourth.body?.error ?? '') && /post again in about/.test(fourth.body?.error ?? ''),
        `the message says which limit and when it lets up (${fourth.body?.error})`);
    const resetsAt = Date.parse(fourth.body?.resetsAt);
    assert(Number.isFinite(resetsAt) && resetsAt > Date.now() + 23 * HOUR && Number(fourth.headers.get('retry-after')) > 23 * 3600,
        `resetsAt is a day after the oldest post, and Retry-After says so (${fourth.body?.resetsAt}, ${fourth.headers.get('retry-after')})`);
    let niaMe = await me(nia);
    assert(niaMe?.probation?.onProbation === true && niaMe?.probation?.limits?.posts?.used === 3 && niaMe?.probation?.limits?.posts?.limit === 3
        && typeof niaMe?.probation?.ageEndsAt === 'string' && Date.parse(niaMe.probation.ageEndsAt) > Date.now() + 71 * HOUR,
        `/api/community/me: on probation, 3 of 3 posts used, the first 72 hours end in 3 days (got ${JSON.stringify(niaMe?.probation)?.slice(0, 200)})`);
    db.prepare('UPDATE posts SET created_at = ? WHERE author_pubkey = ?').run(ago(25 * HOUR), nia.pk);
    assert((await post(nia)).status === 200, 'the counter rolls: with those posts 25 hours old, the next post goes through');
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(73 * HOUR), nia.pk);
    const after = [await post(nia), await post(nia), await post(nia), await post(nia)].map(r => r.status);
    assert(after.every(s => s === 200), `after 72 hours with 3 kept posts there are no limits: 5 posts in a day (${after.join(',')})`);
    niaMe = await me(nia);
    assert(niaMe?.probation?.onProbation === false && niaMe?.probation?.exemptBecause === null, '/api/community/me: off probation');

    const oli = member('Oli', 10);
    assert((await me(oli))?.probation?.onProbation === true, 'an account 10 days old with no posts is still on probation (fewer than 3 kept)');
    for (let i = 0; i < 3; i++) await post(oli);
    assert((await me(oli))?.probation?.onProbation === false && (await post(oli)).status === 200, 'with 3 kept posts it is off, and posts freely');

    const pia = member('Pia', 0);
    const withThree = await post(pia, { photos: [photo('p1'), photo('p2'), photo('p3')] });
    assert(withThree.status === 200, 'a new member posts 3 photos');
    const tooMany = await post(pia, { photos: [photo('p4'), photo('p5'), photo('p6')] });
    assert(tooMany.status === 429 && tooMany.body?.limit === 'photos' && /5 photos/.test(tooMany.body?.error ?? ''),
        `3 more would pass 5 photos in a day → 429, limit photos (got ${tooMany.status} ${tooMany.body?.limit})`);
    const two = await post(pia, { photos: [photo('p7'), photo('p8')] });
    assert(two.status === 200 && (await me(pia))?.probation?.limits?.photos?.used === 5, '2 more fit exactly: 5 used');
    const piaPostB = two.body.post;
    const editMore = await call('POST', pia, '/api/marketplace/posts/update', { id: piaPostB.id, authorPublicKey: pia.pk, photos: [...piaPostB.photos, photo('p9')] });
    assert(editMore.status === 429 && editMore.body?.limit === 'photos', `an edit that brings in a photo past the allowance → 429 (got ${editMore.status})`);
    const editSame = await call('POST', pia, '/api/marketplace/posts/update', { id: piaPostB.id, authorPublicKey: pia.pk, title: 'Renamed', photos: piaPostB.photos });
    assert(editSame.status === 200, `an edit that keeps the same photos is fine (got ${editSame.status})`);

    const dee = member('Dee', 0);
    const convs: string[] = [];
    for (const t of targets.slice(0, 11)) {
        const c = await call('POST', dee, '/api/messages/conversation', { type: 'dm', participants: [dee.pk, t.pk], createdBy: dee.pk });
        convs.push(c.body?.conversation?.id);
    }
    assert(convs.every(Boolean), 'a new member opens conversations with 11 people');
    const sends: number[] = [];
    for (const c of convs.slice(0, 10)) sends.push((await call('POST', dee, '/api/messages/send', { conversationId: c, authorPubkey: dee.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' })).status);
    assert(sends.every(s => s === 200), `and messages 10 of them (${sends.join(',')})`);
    const eleventh = await call('POST', dee, '/api/messages/send', { conversationId: convs[10], authorPubkey: dee.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' });
    assert(eleventh.status === 429 && eleventh.body?.limit === 'new_dm_recipients' && /10 new people/.test(eleventh.body?.error ?? ''),
        `a DM to an 11th new person → 429, limit new_dm_recipients (got ${eleventh.status} ${eleventh.body?.error})`);
    const twelfth = await call('POST', dee, '/api/messages/conversation', { type: 'dm', participants: [dee.pk, targets[11].pk], createdBy: dee.pk });
    assert(twelfth.status === 429, `starting a conversation with a 12th → 429 too (got ${twelfth.status})`);
    const zed = member('Zed', 40);
    const zedWrites = await dm(zed, dee);
    const reply = await call('POST', dee, '/api/messages/send', { conversationId: zedWrites.conv.body.conversation.id, authorPubkey: dee.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' });
    assert(zedWrites.send?.status === 200 && reply.status === 200, `a reply to someone who wrote first is allowed (${reply.status})`);
    const known = await call('POST', dee, '/api/messages/send', { conversationId: convs[0], authorPubkey: dee.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' });
    assert(known.status === 200, 'so is another message to someone already written to');
    const deeMe = await me(dee);
    assert(deeMe?.probation?.limits?.new_dm_recipients?.used === 10 && deeMe?.probation?.limits?.new_dm_recipients?.limit === 10,
        `/api/community/me: 10 of 10 new people (got ${JSON.stringify(deeMe?.probation?.limits?.new_dm_recipients)})`);
    db.prepare('UPDATE messages SET timestamp = ? WHERE author_pubkey = ?').run(ago(25 * HOUR), dee.pk);
    const rolled = await call('POST', dee, '/api/messages/send', { conversationId: convs[10], authorPubkey: dee.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' });
    assert(rolled.status === 200, `the window rolls: 25 hours later the 11th goes through (${rolled.status})`);

    // ── 5. auto-mute ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. auto-mute ──');
    const max = member('Max', 30);
    for (let i = 0; i < 3; i++) oldPost(max, `Max kept ${i}`);
    const maxSock = await socket(max);
    await sleep(100);
    const firstTwo = [await removeByModerator(max, oldPost(max, 'Max spam 1')), await removeByModerator(max, oldPost(max, 'Max spam 2'))];
    assert(firstTwo.every(s => s === 200) && mutedUntil(max) === null, 'two removals: not muted');
    assert((await removeByModerator(max, oldPost(max, 'Max spam 3'))) === 200, 'a moderator removes a third post');
    assert(!!mutedUntil(max) && Date.parse(mutedUntil(max)) > Date.now() + 365 * DAY, `3 removals in 30 days mute Max until a moderator lifts it (${mutedUntil(max)})`);
    await sleep(200);
    assert(maxSock.events.some(e => e.type === 'system_announcement' && e.kind === 'moderation_muted'), 'Max is told');
    const mutedPost = await post(max);
    assert(mutedPost.status === 403 && mutedPost.body?.code === 'moderation_muted' && /until a moderator lifts this/.test(mutedPost.body?.error ?? ''),
        `a muted member's post → 403 moderation_muted, in words (got ${mutedPost.status} ${mutedPost.body?.error})`);
    const maxKept = db.prepare(`SELECT id FROM posts WHERE author_pubkey = ? AND active = 1 LIMIT 1`).get(max.pk) as { id: string };
    assert((await call('POST', max, '/api/marketplace/posts/update', { id: maxKept.id, authorPublicKey: max.pk, description: 'Buy now' })).status === 403,
        'editing a post → 403');
    const mutedDm = await dm(max, targets[0]);
    assert(mutedDm.conv.status === 403 && mutedDm.conv.body?.code === 'moderation_muted', `starting a conversation → 403 (got ${mutedDm.conv.status})`);
    const zedToMax = await dm(zed, max);
    const mutedSend = await call('POST', max, '/api/messages/send', { conversationId: zedToMax.conv.body.conversation.id, authorPubkey: max.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' });
    assert(zedToMax.send?.status === 200 && mutedSend.status === 403 && mutedSend.body?.code === 'moderation_muted',
        `sending a DM, even a reply to someone who wrote first → 403 (got ${mutedSend.status})`);
    assert((await call('GET', max, '/api/marketplace/posts')).status === 200, 'a muted member still reads');
    assert((await call('POST', max, '/api/profile/update', { bio: 'Still here' })).status === 200, 'and edits their profile');
    assert((await me(max))?.mute?.muted === true, '/api/community/me says muted');
    const mutedList = (await admin('GET', '/api/local/admin/members/muted')).body?.members ?? [];
    assert(mutedList.some((m: any) => m.publicKey === max.pk), 'the moderators\' muted list names Max');
    const lifted = await admin('POST', `/api/local/admin/members/${max.pk}/unmute`);
    assert(lifted.status === 200 && (await me(max))?.mute?.muted === false, `a moderator lifts it (${lifted.status})`);
    await sleep(200);
    assert(maxSock.events.some(e => e.type === 'system_announcement' && e.kind === 'moderation_unmuted'), 'and Max is told');
    assert((await post(max)).status === 200 && (await dm(max, targets[0])).send?.status === 200, 'posting and messaging are back');
    assert((await admin('POST', `/api/local/admin/members/${max.pk}/unmute`)).status === 409, 'lifting a mute that is not there → 409');
    assert((await removeByModerator(max, oldPost(max, 'Max spam 4'))) === 200 && !(await me(max))?.mute?.muted,
        'one more removal after the lift does not re-mute: only removals since the lift count');
    maxSock.ws.close();

    const ray = member('Ray', 90);
    for (let i = 0; i < 3; i++) oldPost(ray, `Ray kept ${i}`);
    for (let i = 0; i < 2; i++) await removeByModerator(ray, oldPost(ray, `Ray old ${i}`));
    attempt(() => db.prepare('UPDATE posts SET removed_by_moderator_at = ? WHERE author_pubkey = ? AND removed_by_moderator_at IS NOT NULL').run(ago(31 * DAY), ray.pk));
    await removeByModerator(ray, oldPost(ray, 'Ray new'));
    assert(mutedUntil(ray) === null && (await post(ray)).status === 200, 'removals 31+ days apart never mute');

    // ── 6. replication ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. replication: a standby holds the hide, the takedowns and the mute ──');
    const muteMax = await (async () => { // mute Max again, so the export has a live mute to carry
        for (let i = 5; i < 7; i++) await removeByModerator(max, oldPost(max, `Max spam ${i}`));
        return mutedUntil(max);
    })();
    assert(!!muteMax, 'setup: Max is muted again');
    const hideOnly = oldPost(ava, 'Hidden for replication');
    const hideInsert = oldPost(ava, 'Hidden, never on the standby');
    for (const r of R.slice(0, 3)) { await report(r, hideOnly, ava); await report(r, hideInsert, ava); }
    const hideOnlyAt = hiddenAt(hideOnly);
    const hideInsertAt = hiddenAt(hideInsert);
    assert(!!hideOnlyAt && !!hideInsertAt, 'setup: two hidden posts');
    const p2p = await startP2P(4282, 4283);
    const nodeId = p2p.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4283/p2p/${nodeId}`, 'mirror', 'self-test-peer');
    const payload: any = await exportSyncState(nodeId);
    const exported = (payload.posts ?? []).find((p: any) => p.id === hideOnly);
    const exportedRemoved = (payload.posts ?? []).find((p: any) => p.id === target);
    const exportedMax = (payload.members ?? []).find((m: any) => m.publicKey === max.pk);
    assert(exported?.hiddenByReportsAt === hideOnlyAt && typeof exportedRemoved?.removedByModeratorAt === 'string' && exportedMax?.moderationMutedUntil === muteMax,
        'the export carries hiddenByReportsAt, removedByModeratorAt and moderationMutedUntil');
    // A standby that holds older copies: the update path.
    attempt(() => db.prepare(`UPDATE posts SET hidden_by_reports_at = NULL, removed_by_moderator_at = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id IN (?, ?)`).run(hideOnly, target));
    attempt(() => db.prepare(`UPDATE members SET moderation_muted_until = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?`).run(max.pk));
    // And one that never had the post: the insert path.
    db.prepare('DELETE FROM posts WHERE id = ?').run(hideInsert);
    setNodeRole('backup');
    await importRemoteState(payload);
    setNodeRole('primary');
    const back = (postId: string) => attempt(() => db.prepare('SELECT hidden_by_reports_at, removed_by_moderator_at FROM posts WHERE id = ?').get(postId) as any);
    assert(!!hideOnlyAt && back(hideOnly)?.hidden_by_reports_at === hideOnlyAt, 'the standby holds the hide (update)');
    assert(typeof back(target)?.removed_by_moderator_at === 'string', 'and the takedown record (update)');
    assert(!!hideInsertAt && back(hideInsert)?.hidden_by_reports_at === hideInsertAt, 'and the hide on a post it never had (insert)');
    assert(mutedUntil(max) === muteMax, 'and the mute');
    await p2p.stop();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The lobby moderates itself, a moderator can undo it, and a local community is untouched.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
