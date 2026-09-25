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
 *      and one more removal after the lift does not re-mute; removals 31+ days apart never mute; a keeper can't edit
 *      a muted enterprise's post through the marketplace route
 *   6. replication: the export carries hidden_by_reports_at, removed_by_moderator_at and moderation_muted_until, and
 *      a standby importing it (insert and update) holds all three
 *   7. with Beans, escrow and enterprises on (a live community switched to global keeps them; forced on here with the
 *      overrides): a request or an accept on a hidden offer is answered as for an id nobody has, writes no trade and
 *      moves no Beans; its author can't approve a request into a new escrow while it is hidden, but can decline one,
 *      and an escrow opened before the hide can still finish or be called off; a hidden listing can't be commissioned;
 *      after a restore it all works again. A muted member writes nothing anyone else reads: the enterprise thread,
 *      groups (start, rename, invite, chat), event chat, reactions, Decisions, Commons projects, crowdfunds,
 *      enterprises, ratings, putting a post back up, a note with Beans or a pledge, and the Pulse (submit, ingest,
 *      add or change a channel), each 403 moderation_muted with nothing stored; they still read, pause a post, join
 *      and leave, and send Beans without a note; after a lift the thread takes their line again
 *
 * Section 1 also shows a request on a reported local post, an enterprise thread line and a new group from a member
 * with 3 removals all going through on the local profile; section 3 shows a hidden event's chat closed to everyone
 * but its author (who reads it but can't post into it), and open again once it is un-hidden.
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
    payFromCommons, createGroup,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db, createCrowdfundProject } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';
import { originOfCachedPost } from './federation-commission.js';
import { REMOVALS_SINCE_SQL } from './engine/auto-moderation.js';

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
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
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
    // Nor is it closed to a deal. The trade row is taken out again, so the ledger has never moved and the global
    // sections below run as a fresh global node does, with Beans off.
    const lena = member('Lena', 30);
    oldPost(lena, 'Lena listing'); // a listed offer: the contribution rule
    const localReq = await call('POST', lena, '/api/marketplace/posts/request', { postId: localPost, buyerPublicKey: lena.pk });
    assert(localReq.status === 200 && localReq.body?.transaction?.status === 'requested',
        `local: a request on that reported post goes through (${localReq.status} ${localReq.body?.error ?? ''})`);
    if (localReq.body?.transaction?.id) db.prepare('DELETE FROM marketplace_transactions WHERE id = ?').run(localReq.body.transaction.id);
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
    const localShop = member('Loco', 60);
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(localShop.pk);
    const larsThread = await call('POST', localMax, `/api/enterprise/${localShop.pk}/thread/message`, { text: 'Hello from Lars' });
    const larsGroup = await call('POST', localMax, '/api/groups', { name: 'Lars club' });
    assert(larsThread.status === 201 && larsGroup.status === 201,
        `local: and writes in an enterprise's thread and starts a group (${larsThread.status} ${larsThread.body?.error ?? ''}, ${larsGroup.status} ${larsGroup.body?.error ?? ''})`);
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
    const vicChatBefore = await call('GET', viewer, `/api/marketplace/posts/${ev}/chat`);
    const vicListBefore = (await call('GET', viewer, `/api/messages/conversations/${viewer.pk}`)).body?.conversations ?? [];
    const vicYoursBefore = (await call('GET', viewer, '/api/your-groups')).body?.items ?? [];
    assert(vicChatBefore.status === 200 && vicListBefore.some((c: any) => c.id === ev) && vicYoursBefore.some((c: any) => c.id === ev),
        `before: someone Going opens the event's chat, and it is in both their chat lists (${vicChatBefore.status})`);
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
    // The event's chat is the event's own: not there for anyone but its author, who still reads it but can't post a
    // line, which would reach the people Going.
    const vicChat = await call('GET', viewer, `/api/marketplace/posts/${ev}/chat`);
    const vicLine = await call('POST', viewer, `/api/marketplace/posts/${ev}/chat/message`, { text: 'Still on?' });
    const vicConv = await call('GET', viewer, `/api/messages/${ev}`);
    assert(vicChat.status === 404 && vicChat.body?.error === 'Event not found' && vicLine.status === 404 && vicConv.status === 404
        && !JSON.stringify([vicChat.body, vicLine.body, vicConv.body]).includes('Hidden gathering'),
        `its chat is "not found" to someone Going: read, post, and read as a conversation (${vicChat.status}, ${vicLine.status}, ${vicConv.status})`);
    const vicList = (await call('GET', viewer, `/api/messages/conversations/${viewer.pk}`)).body?.conversations ?? [];
    const vicYours = (await call('GET', viewer, '/api/your-groups')).body?.items ?? [];
    assert(!vicList.some((c: any) => c.id === ev) && !vicYours.some((c: any) => c.id === ev), 'and it is gone from both their chat lists');
    const avaChat = await call('GET', ava, `/api/marketplace/posts/${ev}/chat`);
    const avaLine = await call('POST', ava, `/api/marketplace/posts/${ev}/chat/message`, { text: 'Bring cash' });
    const evLines = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(ev) as any).c;
    assert(avaChat.status === 200 && avaChat.body?.title === 'Hidden gathering' && avaLine.status === 409 && evLines === 0,
        `its author still reads it, but can't post into it while it is hidden, and nothing is stored (${avaChat.status}, ${avaLine.status} ${avaLine.body?.error})`);
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
    const vicBack = await call('GET', viewer, `/api/marketplace/posts/${ev}/chat`);
    const vicLineBack = await call('POST', viewer, `/api/marketplace/posts/${ev}/chat/message`, { text: 'See you there' });
    assert(vicBack.status === 200 && vicLineBack.status === 201, `and its chat is open again to the people Going (${vicBack.status}, ${vicLineBack.status})`);

    // A hidden event's unread lines leave the unread badge with its chat: totalUnread counts only the chats listed.
    const T = [1, 2, 3].map(i => member(`Tia${i}`, 20)); // reporters of their own, under the hourly report limit
    const meetup = createPost('event', 'other', 'Hidden meetup', 'Another event to hide', 0, 'fixed', ava.pk, -28.55, 153.5, [], false, undefined, false,
        { eventStartAt: new Date(Date.now() + 2 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 2 * DAY + 2 * HOUR).toISOString(), eventPlaceName: 'Hall' })!.id;
    await call('POST', viewer, `/api/marketplace/posts/${meetup}/rsvp`, { status: 'going' });
    const hostLine = await call('POST', ava, `/api/marketplace/posts/${meetup}/chat/message`, { text: 'Doors at six' });
    const vicChats = async () => (await call('GET', viewer, `/api/messages/conversations/${viewer.pk}`)).body ?? {};
    const listedUnread = (b: any) => (b.conversations ?? []).reduce((n: number, c: any) => n + (c.unreadCount ?? 0), 0);
    const unreadBefore = await vicChats();
    const meetupUnread = (unreadBefore.conversations ?? []).find((c: any) => c.id === meetup)?.unreadCount ?? 0;
    assert(hostLine.status === 201 && meetupUnread >= 1 && unreadBefore.totalUnread === listedUnread(unreadBefore),
        `before: the host's line is unread for someone Going, and counted in their totalUnread (${hostLine.status}, ${meetupUnread}, ${unreadBefore.totalUnread})`);
    for (const r of T) await report(r, meetup, ava);
    const unreadAfter = await vicChats();
    assert(!!hiddenAt(meetup) && !(unreadAfter.conversations ?? []).some((c: any) => c.id === meetup)
        && unreadAfter.totalUnread === unreadBefore.totalUnread - meetupUnread && unreadAfter.totalUnread === listedUnread(unreadAfter),
        `hidden: its chat leaves their list, and its unread lines leave totalUnread with it (${unreadBefore.totalUnread} → ${unreadAfter.totalUnread}, listed ${listedUnread(unreadAfter)})`);

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

    // Opening a conversation reaches someone whether or not a message follows: it is a line in their inbox.
    const dee = member('Dee', 0);
    const open = (from: Id, to: Id) => call('POST', from, '/api/messages/conversation', { type: 'dm', participants: [from.pk, to.pk], createdBy: from.pk });
    const line = (from: Id, conversationId: string) => call('POST', from, '/api/messages/send', { conversationId, authorPubkey: from.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' });
    const convs: string[] = [];
    for (const t of targets.slice(0, 10)) convs.push((await open(dee, t)).body?.conversation?.id);
    assert(convs.every(Boolean), 'a new member opens conversations with 10 new people, writing nothing');
    const eleventhOpen = await open(dee, targets[10]);
    const openedWith = (a: Id, b: Id) => (db.prepare(`SELECT COUNT(*) AS c FROM conversations c
        JOIN conversation_participants x ON x.conversation_id = c.id AND x.public_key = ?
        JOIN conversation_participants y ON y.conversation_id = c.id AND y.public_key = ? WHERE c.type = 'dm'`).get(a.pk, b.pk) as any).c;
    assert(eleventhOpen.status === 429 && eleventhOpen.body?.limit === 'new_dm_recipients' && /10 new people/.test(eleventhOpen.body?.error ?? '')
        && openedWith(dee, targets[10]) === 0,
        `opening one with an 11th → 429, limit new_dm_recipients, and none is opened (got ${eleventhOpen.status} ${eleventhOpen.body?.error})`);
    const sends: number[] = [];
    for (const c of convs) sends.push((await line(dee, c)).status);
    assert(sends.every(s => s === 200), `they write in all 10 they opened: nobody new there (${sends.join(',')})`);
    // A line is checked as well as an opening: in a DM nobody is recorded as opening (a row from before created_by
    // was kept), the first line is what reaches the other person.
    const unopened = crypto.randomUUID();
    db.prepare(`INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', NULL, ?)`).run(unopened, ago(2 * DAY));
    for (const pk of [dee.pk, targets[11].pk]) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(unopened, pk);
    const eleventh = await line(dee, unopened);
    assert(eleventh.status === 429 && eleventh.body?.limit === 'new_dm_recipients' && /10 new people/.test(eleventh.body?.error ?? ''),
        `a DM to an 11th new person → 429, limit new_dm_recipients (got ${eleventh.status} ${eleventh.body?.error})`);
    const zed = member('Zed', 40);
    const zedWrites = await dm(zed, dee);
    const reply = await line(dee, zedWrites.conv.body.conversation.id);
    assert(zedWrites.send?.status === 200 && reply.status === 200, `a reply to someone who wrote first is allowed (${reply.status})`);
    const yan = member('Yan', 40);
    const yanOpens = await open(yan, dee);
    const replyToOpen = await line(dee, yanOpens.body?.conversation?.id);
    assert(yanOpens.status === 200 && replyToOpen.status === 200, `and to someone who only opened one with them, writing nothing (${replyToOpen.status} ${replyToOpen.body?.error ?? ''})`);
    const known = await line(dee, convs[0]);
    assert(known.status === 200, 'so is another message to someone already written to');
    const deeMe = await me(dee);
    assert(deeMe?.probation?.limits?.new_dm_recipients?.used === 10 && deeMe?.probation?.limits?.new_dm_recipients?.limit === 10,
        `/api/community/me: 10 of 10 new people (got ${JSON.stringify(deeMe?.probation?.limits?.new_dm_recipients)})`);
    db.prepare('UPDATE messages SET timestamp = ? WHERE author_pubkey = ?').run(ago(25 * HOUR), dee.pk);
    db.prepare('UPDATE conversations SET created_at = ? WHERE created_by = ?').run(ago(25 * HOUR), dee.pk);
    const rolled = await open(dee, targets[10]);
    assert(rolled.status === 200, `the window rolls: 25 hours later the 11th opens (${rolled.status} ${rolled.body?.error ?? ''})`);

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
    // The count runs on every removal: through the partial index on (author, removal time), not a scan of every post.
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${REMOVALS_SINCE_SQL}`).all(ray.pk, ago(30 * DAY)) as { detail: string }[]).map(r => r.detail).join('; ');
    assert(/idx_posts_author_removed/.test(plan) && !/SCAN posts\b/.test(plan), `auto-mute's count reads idx_posts_author_removed (${plan})`);

    // A muted enterprise: its keeper can't edit its posts through the marketplace route either. For an offer the
    // signature check refuses it before the route runs (a body authorPublicKey must be the signer; keepers act for an
    // enterprise through /api/treasury/:treasury/..., which checks both mutes); pinned so a change there can't open it.
    // An event lets every host edit it with their own key, so there updatePost checks its author's mute.
    const shop = member('Shop', 60);
    const kit = member('Kit', 60);
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(shop.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(kit.pk);
    db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, 'keeper', ?)`).run(shop.pk, kit.pk, owner.pk);
    const shopPost = oldPost(shop, 'Shop listing');
    const shopEvent = createPost('event', 'other', 'Shop open day', 'Come along', 0, 'fixed', shop.pk, -28.55, 153.5, [], false, undefined, false,
        { eventStartAt: new Date(Date.now() + 2 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 2 * DAY + 2 * HOUR).toISOString(), eventPlaceName: 'Shop' })!.id;
    attempt(() => db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run('9999-12-31T23:59:59.999Z', shop.pk));
    const kitEdit = await call('POST', kit, '/api/marketplace/posts/update', { id: shopPost, authorPublicKey: shop.pk, description: 'Buy now' });
    const shopDescription = (db.prepare('SELECT description FROM posts WHERE id = ?').get(shopPost) as any)?.description;
    assert(kitEdit.status === 403 && shopDescription !== 'Buy now',
        `a keeper can't edit a muted enterprise's post through the marketplace route (got ${kitEdit.status} ${kitEdit.body?.error})`);
    const kitEventEdit = await call('POST', kit, '/api/marketplace/posts/update', { id: shopEvent, authorPublicKey: kit.pk, description: 'Buy now at spam.example' });
    const shopEventStored = (db.prepare('SELECT description FROM posts WHERE id = ?').get(shopEvent) as any)?.description;
    const shopEventRead = (await call('GET', viewer, `/api/marketplace/posts?id=${shopEvent}`)).body?.[0]?.description;
    assert(kitEventEdit.status === 403 && kitEventEdit.body?.code === 'moderation_muted' && shopEventStored === 'Come along' && shopEventRead === 'Come along',
        `nor its event, which they host, signing as themselves: 403 moderation_muted, and nobody reads the new words (got ${kitEventEdit.status} ${kitEventEdit.body?.error ?? ''}; stored "${shopEventStored}", read "${shopEventRead}")`);

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
    // Every writer of the mute stamps updated_at itself; the members trigger lists the column too, so a write that
    // doesn't (a script, a future path) still reaches delta sync.
    const quinn = member('Quinn', 30);
    db.prepare(`UPDATE members SET updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?`).run(quinn.pk);
    attempt(() => db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run('9999-12-31T23:59:59.999Z', quinn.pk));
    const quinnTouched = (db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(quinn.pk) as any)?.updated_at;
    assert(quinnTouched > '2000-01-01T00:00:00.000Z', `an UPDATE that sets only moderation_muted_until moves updated_at (${quinnTouched})`);

    // ── 7. Beans, escrow and enterprises on ──────────────────────────────────────────────────────
    // A live community switched to global keeps them (the ledger lock), and an operator can override them on. Forced
    // on here with the overrides, as the reviewer did; on a fresh global node the routes below answer 404.
    console.log('\n── 7. global with Beans, escrow and enterprises on ──');
    const setOverride = (name: string, value: string) =>
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`nodeProfile.${name}`, value);
    for (const k of ['beans', 'escrow', 'enterprises', 'treasuries', 'crowdfund']) setOverride(k, 'true');
    f = (await info()).features ?? {};
    assert(f.beans === true && f.escrow === true && f.enterprises === true && f.autoHideReports === true && f.autoMute === true,
        `setup: global, with Beans, escrow and enterprises on (${JSON.stringify(f)})`);

    // 7a. Acting on a hidden post.
    console.log('\n── 7a. a deal on a hidden post ──');
    const U = [1, 2, 3].map(i => member(`Una${i}`, 20)); // reporters of their own, under the hourly report limit
    const hide = async (postId: string, author: Id) => { for (const r of U) await report(r, postId, author); };
    const [bob, cat, dan] = ['Bob', 'Cat', 'Dan'].map(name => member(name, 40));
    for (const m of [bob, cat, dan]) {
        oldPost(m, `${m.name} listing`); // a listed offer: the contribution rule
        payFromCommons(m.pk, 100, 'Test: Beans to trade with', { allowDeficit: true });
    }
    const offer = (title: string) => createPost('offer', 'other', title, `${title}, for Beans`, 10, 'fixed', ava.pk)!.id;
    const balanceOf = async (id: Id) => Number((await call('GET', id, `/api/ledger/balance/${id.pk}`)).body?.balance);
    const near = (a: number, b: number) => Math.abs(a - b) < 0.01; // demurrage moves a balance by a hair between reads
    const trades = (postId: string) => db.prepare('SELECT id, buyer_pubkey, status FROM marketplace_transactions WHERE post_id = ?').all(postId) as { id: string; buyer_pubkey: string; status: string }[];
    const tradeStatus = (txId: string) => (db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(txId) as any)?.status;

    const lamp = offer('Lamp for Beans');
    const catAsks = await call('POST', cat, '/api/marketplace/posts/request', { postId: lamp, buyerPublicKey: cat.pk });
    const danAsks = await call('POST', dan, '/api/marketplace/posts/request', { postId: lamp, buyerPublicKey: dan.pk });
    const kettle = offer('Kettle for Beans');
    const chair = offer('Chair for Beans');
    const bobTakesChair = await call('POST', bob, '/api/marketplace/posts/accept', { postId: chair, buyerPublicKey: bob.pk });
    const table = offer('Table for Beans');
    const catTakesTable = await call('POST', cat, '/api/marketplace/posts/accept', { postId: table, buyerPublicKey: cat.pk });
    assert(catAsks.status === 200 && danAsks.status === 200 && bobTakesChair.status === 200 && catTakesTable.status === 200,
        `setup: before the hide, Cat and Dan ask for Ava's lamp, and Bob and Cat take her chair and table into escrow (${[catAsks, danAsks, bobTakesChair, catTakesTable].map(r => `${r.status} ${r.body?.error ?? ''}`).join(', ')})`);
    for (const p of [lamp, kettle, chair, table]) await hide(p, ava);
    assert([lamp, kettle, chair, table].every(p => !!hiddenAt(p)), 'setup: 3 established reporters hide all four');

    const bobBefore = await balanceOf(bob);
    const nobodyAsks = await call('POST', bob, '/api/marketplace/posts/request', { postId: crypto.randomUUID(), buyerPublicKey: bob.pk });
    const bobAsks = await call('POST', bob, '/api/marketplace/posts/request', { postId: lamp, buyerPublicKey: bob.pk });
    assert(bobAsks.status === nobodyAsks.status && bobAsks.body?.error === 'Post not found' && JSON.stringify(bobAsks.body) === JSON.stringify(nobodyAsks.body),
        `a request on a hidden offer is answered as for an id nobody has (got ${bobAsks.status} ${JSON.stringify(bobAsks.body)?.slice(0, 160)})`);
    assert(!trades(lamp).some(t => t.buyer_pubkey === bob.pk) && !JSON.stringify(bobAsks.body ?? '').includes('Lamp'),
        'no trade row is written, and nothing of the post comes back');
    const nobodyTakes = await call('POST', bob, '/api/marketplace/posts/accept', { postId: crypto.randomUUID(), buyerPublicKey: bob.pk });
    const bobTakesKettle = await call('POST', bob, '/api/marketplace/posts/accept', { postId: kettle, buyerPublicKey: bob.pk });
    assert(bobTakesKettle.status === nobodyTakes.status && JSON.stringify(bobTakesKettle.body) === JSON.stringify(nobodyTakes.body)
        && !JSON.stringify(bobTakesKettle.body ?? '').includes('Kettle'),
        `accepting a hidden offer: the same answer as for an id nobody has (got ${bobTakesKettle.status} ${JSON.stringify(bobTakesKettle.body)?.slice(0, 160)})`);
    assert(trades(kettle).length === 0 && near(await balanceOf(bob), bobBefore), 'no escrow opens, and Bob\'s Beans stay where they were');
    const avaAsksOwn = await call('POST', ava, '/api/marketplace/posts/request', { postId: lamp, buyerPublicKey: ava.pk });
    assert(avaAsksOwn.status === 400 && /your own post/.test(avaAsksOwn.body?.error ?? ''),
        `its author is not told "not found": they get the answers they always did (${avaAsksOwn.body?.error})`);
    const catTx = catAsks.body?.transaction?.id as string, danTx = danAsks.body?.transaction?.id as string;
    const catBefore = await balanceOf(cat);
    const approveHidden = await call('POST', ava, '/api/marketplace/transactions/approve', { transactionId: catTx, authorPublicKey: ava.pk });
    assert(approveHidden.status === 409 && /hidden while a moderator/.test(approveHidden.body?.error ?? '') && tradeStatus(catTx) === 'requested'
        && near(await balanceOf(cat), catBefore),
        `its author can't approve a request into a new escrow while it is hidden: 409, the request waits, Cat's Beans stay put (got ${approveHidden.status} ${approveHidden.body?.error})`);
    const declined = await call('POST', ava, '/api/marketplace/transactions/reject', { transactionId: danTx, authorPublicKey: ava.pk });
    assert(declined.status === 200 && tradeStatus(danTx) === 'rejected', `but can decline one made before the hide (${declined.status} ${declined.body?.error ?? ''})`);
    const avaBefore = await balanceOf(ava);
    const chairDone = await call('POST', bob, '/api/marketplace/transactions/complete', { transactionId: bobTakesChair.body?.transaction?.id, confirmerPublicKey: bob.pk });
    assert(chairDone.status === 200 && (await balanceOf(ava)) > avaBefore,
        `an escrow opened before the hide can still finish: Bob confirms, and Ava is paid (${chairDone.status} ${chairDone.body?.error ?? ''})`);
    const catBeforeCancel = await balanceOf(cat);
    const tableOff = await call('POST', cat, '/api/marketplace/transactions/cancel', { transactionId: catTakesTable.body?.transaction?.id, cancellerPublicKey: cat.pk });
    assert(tableOff.status === 200 && near(await balanceOf(cat), catBeforeCancel + 10),
        `or be called off: Cat cancels and has her 10 Beans back (${tableOff.status} ${tableOff.body?.error ?? ''})`);

    // An enterprise's Need, approved through its own route: the same refusal.
    const hub = member('Hub', 60);
    const kim = member('Kim', 60);
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(hub.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key IN (?, ?)').run(kim.pk, max.pk);
    for (const keeper of [kim, max]) {
        db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, 'keeper', ?)`).run(hub.pk, keeper.pk, owner.pk);
    }
    oldPost(hub, 'Hub eggs'); // the offer covenant: an enterprise's Need needs a live Offer
    payFromCommons(hub.pk, 100, 'Test: Beans for the Need', { allowDeficit: true }); // on a Need the author pays
    const hubNeed = createPost('need', 'other', 'Tend the hens', 'Mornings', 10, 'fixed', hub.pk)!.id;
    const danHelps = await call('POST', dan, '/api/marketplace/posts/request', { postId: hubNeed, buyerPublicKey: dan.pk });
    await hide(hubNeed, hub);
    const kimApproves = await call('POST', kim, `/api/treasury/${hub.pk}/approve`, { transactionId: danHelps.body?.transaction?.id });
    assert(danHelps.status === 200 && !!hiddenAt(hubNeed) && kimApproves.status === 409 && tradeStatus(danHelps.body?.transaction?.id) === 'requested',
        `a keeper can't approve a request on the enterprise's hidden Need either (${danHelps.status}, ${kimApproves.status} ${kimApproves.body?.error})`);

    // A partner's listing on this board, hidden here, is not a live listing to commission. (The route itself needs
    // FEDERATION_SETTLEMENT=true at boot; its lookup is this.)
    const cached = offer('A partner community\'s listing');
    db.prepare("UPDATE posts SET origin_node = 'https://partner.example' WHERE id = ?").run(cached);
    const resolvable = originOfCachedPost(cached)?.originNode === 'https://partner.example';
    await hide(cached, ava);
    assert(resolvable && !!hiddenAt(cached) && originOfCachedPost(cached) === null,
        'a partner\'s listing hidden here by reports can\'t be commissioned (its lookup finds no live listing)');

    for (const p of [lamp, kettle]) assert((await admin('POST', `/api/local/admin/posts/${p}/restore`)).status === 200 && hiddenAt(p) === null, 'a moderator restores it');
    const bobAsksAgain = await call('POST', bob, '/api/marketplace/posts/request', { postId: lamp, buyerPublicKey: bob.pk });
    assert(bobAsksAgain.status === 200 && trades(lamp).some(t => t.buyer_pubkey === bob.pk && t.status === 'requested'),
        `after the restore, Bob's request goes through (${bobAsksAgain.status} ${bobAsksAgain.body?.error ?? ''})`);
    const catBeforeApprove = await balanceOf(cat);
    const approveBack = await call('POST', ava, '/api/marketplace/transactions/approve', { transactionId: catTx, authorPublicKey: ava.pk });
    assert(approveBack.status === 200 && tradeStatus(catTx) === 'pending' && near(await balanceOf(cat), catBeforeApprove - 10),
        `Ava approves Cat's request, and 10 of Cat's Beans go into escrow (${approveBack.status} ${approveBack.body?.error ?? ''})`);
    const bobTakesKettleAgain = await call('POST', bob, '/api/marketplace/posts/accept', { postId: kettle, buyerPublicKey: bob.pk });
    assert(bobTakesKettleAgain.status === 200 && trades(kettle).some(t => t.buyer_pubkey === bob.pk && t.status === 'pending'),
        `and Bob's accept opens an escrow (${bobTakesKettleAgain.status} ${bobTakesKettleAgain.body?.error ?? ''})`);

    // Probation's new people and a trade (engine/probation.ts dmContacts): escrow opens the trade's chat in the buyer's
    // name without the new-people check, so it is nobody's opening. It uses none of a new buyer's allowance, and it
    // doesn't let them write to the seller freely either: their first line there counts, as it always has.
    const tess = member('Tess', 0);
    oldPost(tess, 'Tess listing'); // a listed offer: the contribution rule
    payFromCommons(tess.pk, 100, 'Test: Beans to trade with', { allowDeficit: true });
    const tessTakes = await call('POST', tess, '/api/marketplace/posts/accept', { postId: offer('Vase for Beans'), buyerPublicKey: tess.pk });
    const tradeChat = (db.prepare(`SELECT c.id, c.created_by FROM conversations c
        JOIN conversation_participants x ON x.conversation_id = c.id AND x.public_key = ?
        JOIN conversation_participants y ON y.conversation_id = c.id AND y.public_key = ? WHERE c.type = 'dm'`).get(tess.pk, ava.pk) as { id: string; created_by: string } | undefined);
    const tessOpens: number[] = [];
    for (const t of targets.slice(0, 10)) tessOpens.push((await call('POST', tess, '/api/messages/conversation', { type: 'dm', participants: [tess.pk, t.pk], createdBy: tess.pk })).status);
    assert(tessTakes.status === 200 && tradeChat?.created_by === tess.pk && tessOpens.every(s => s === 200),
        `a new member takes an offer into escrow, which opens a chat with the seller in their name, and still opens conversations with 10 new people (${tessTakes.status} ${tessTakes.body?.error ?? ''}; ${tessOpens.join(',')})`);
    const tessLine = await call('POST', tess, '/api/messages/send', { conversationId: tradeChat?.id, authorPubkey: tess.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' });
    assert(tessLine.status === 429 && tessLine.body?.limit === 'new_dm_recipients',
        `their first line in the trade's chat is an 11th new person: 429, as before (got ${tessLine.status} ${tessLine.body?.error ?? ''})`);

    // 7b. A muted member writes nothing anyone else reads.
    console.log('\n── 7b. a muted member writes nothing anyone else reads ──');
    assert(!!mutedUntil(max), 'setup: Max is muted (section 6 muted him again)');
    const refused = (r: Res) => r.status === 403 && r.body?.code === 'moderation_muted';
    const linesBy = (id: Id) => (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE author_pubkey = ?').get(id.pk) as any).c;
    const maxClub = createGroup({ name: 'Max club', description: 'Before the mute', createdBy: max.pk }); // a group he already convenes
    const openClub = createGroup({ name: 'Open club', createdBy: kim.pk });
    const joined = await call('POST', max, `/api/groups/${openClub.id}/join`);
    const kimEvent = createPost('event', 'other', 'Hub open day', 'Come along', 0, 'fixed', kim.pk, -28.55, 153.5, [], false, undefined, false,
        { eventStartAt: new Date(Date.now() + 3 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 3 * DAY + 2 * HOUR).toISOString(), eventPlaceName: 'Hub' })!.id;
    const going = await call('POST', max, `/api/marketplace/posts/${kimEvent}/rsvp`, { status: 'going' });
    const maxPost = (db.prepare('SELECT id FROM posts WHERE author_pubkey = ? AND active = 1 AND status = \'active\' LIMIT 1').get(max.pk) as { id: string }).id;
    const paused = await call('POST', max, '/api/marketplace/posts/pause', { postId: maxPost, authorPublicKey: max.pk });
    assert(joined.status === 200 && going.status === 200 && paused.status === 200,
        `a muted member still joins a group, says they're going to an event, and pauses a post: none of that says anything (${joined.status}, ${going.status}, ${paused.status})`);
    const maxLines = linesBy(max);
    const zedLine = zedToMax.send?.body?.message?.id as string;
    const zedLineMeta = () => (db.prepare('SELECT metadata FROM messages WHERE id = ?').get(zedLine) as any)?.metadata ?? null;
    const metaBefore = zedLineMeta();
    const tries: [string, Res][] = [
        ['a line in an enterprise\'s thread', await call('POST', max, `/api/enterprise/${hub.pk}/thread/message`, { text: 'Buy now' })],
        ['a line in the group chat', await call('POST', max, `/api/groups/${openClub.id}/chat/message`, { text: 'Buy now' })],
        ['a line in the event chat', await call('POST', max, `/api/marketplace/posts/${kimEvent}/chat/message`, { text: 'Buy now' })],
        ['a reaction', await call('POST', max, '/api/messages/react', { messageId: zedLine, emoji: 'Buy now at spam.example' })],
        ['starting a group', await call('POST', max, '/api/groups', { name: 'Spam club', description: 'Buy now' })],
        ['new words on his group\'s card', await call('PATCH', max, `/api/groups/${maxClub.id}`, { description: 'Buy now' })],
        ['inviting someone to his group', await call('POST', max, `/api/groups/${maxClub.id}/members`, { targetPubkey: viewer.pk })],
        ['proposing a Decision', await call('POST', max, '/api/commons/decisions', { title: 'Buy now', description: 'Buy now at spam.example', touches: 'member', effect: 'freeze_credit', subject: viewer.pk })],
        ['proposing a Commons project', await call('POST', max, '/api/commons/projects', { title: 'Buy now', description: 'spam.example', requestedAmount: 10 })],
        ['starting a crowdfund', await call('POST', max, '/api/crowdfund/projects', { title: 'Buy now', description: 'spam.example', goalAmount: 50 })],
        ['editing a crowdfund', await call('POST', max, '/api/crowdfund/projects/update', { id: crypto.randomUUID(), title: 'Buy now', goalAmount: 50 })],
        ['starting an enterprise', await call('POST', max, '/api/enterprise', { name: 'Max Co', purpose: 'Buy now' })],
        ['posting as an enterprise he keeps', await call('POST', max, `/api/treasury/${hub.pk}/offer`, { title: 'Buy now', category: 'other' })],
        ['posting for a muted enterprise, as a keeper who isn\'t muted', await call('POST', kit, `/api/treasury/${shop.pk}/offer`, { title: 'Buy now', category: 'other' })],
        ['a rating', await call('POST', max, '/api/ratings', { targetPubkey: zed.pk, stars: 5, comment: 'Buy now', transactionId: crypto.randomUUID() })],
        ['putting a paused post back up', await call('POST', max, '/api/marketplace/posts/resume', { postId: maxPost, authorPublicKey: max.pk })],
        ['a note with Beans', await call('POST', max, '/api/ledger/transfer', { to: zed.pk, amount: 1, memo: 'Buy now' })],
        ['a note with a crowdfund pledge', await call('POST', max, `/api/crowdfund/projects/${crypto.randomUUID()}/pledge`, { amount: 1, memo: 'Buy now' })],
        ['a note with an enterprise pledge', await call('POST', max, `/api/enterprise/${hub.pk}/pledge`, { amount: 1, memo: 'Buy now' })],
        ['submitting to the Pulse', await call('POST', max, '/api/member/pulse/submit', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })],
        ['adding a Pulse channel', await call('POST', max, '/api/member/channels', { platform: 'youtube', url: 'https://www.youtube.com/@maxspam' })],
        ['changing a Pulse channel', await call('POST', max, `/api/member/channels/${crypto.randomUUID()}`, { category: 'music' })],
        ['ingesting Pulse items', await call('POST', max, '/api/member/pulse/oauth-ingest', { channelId: crypto.randomUUID(), items: [] })],
    ];
    for (const [what, r] of tries) assert(refused(r), `muted: ${what} → 403 moderation_muted (got ${r.status} ${JSON.stringify(r.body)?.slice(0, 140)})`);
    const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any)?.c ?? 0;
    const stored = {
        lines: linesBy(max) - maxLines,
        reaction: zedLineMeta() !== metaBefore ? 1 : 0,
        groups: one("SELECT COUNT(*) AS c FROM groups WHERE name = 'Spam club'"),
        card: one("SELECT COUNT(*) AS c FROM groups WHERE id = ? AND description = 'Buy now'", maxClub.id),
        invite: one('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ? AND member_pubkey = ?', maxClub.id, viewer.pk),
        decisions: one('SELECT COUNT(*) AS c FROM decisions WHERE author_pubkey = ?', max.pk),
        commons: JSON.stringify((await call('GET', viewer, '/api/commons/projects')).body ?? '').includes('spam.example') ? 1 : 0,
        crowdfunds: one('SELECT COUNT(*) AS c FROM projects WHERE creator_pubkey = ?', max.pk),
        enterprises: one("SELECT COUNT(*) AS c FROM members WHERE callsign = 'Max Co'"),
        posts: one("SELECT COUNT(*) AS c FROM posts WHERE title = 'Buy now'"),
        ratings: one('SELECT COUNT(*) AS c FROM ratings WHERE rater_pubkey = ?', max.pk),
        resumed: one("SELECT COUNT(*) AS c FROM posts WHERE id = ? AND status = 'active'", maxPost),
        notes: one("SELECT COUNT(*) AS c FROM transactions WHERE memo = 'Buy now'"),
        pulse: one('SELECT COUNT(*) AS c FROM pulse_items WHERE owner_pubkey = ?', max.pk) + one('SELECT COUNT(*) AS c FROM creator_channels WHERE owner_pubkey = ?', max.pk),
    };
    assert(Object.values(stored).every(v => v === 0), `and none of it is stored (${JSON.stringify(stored)})`);
    const unnoted = await call('POST', max, '/api/ledger/transfer', { to: zed.pk, amount: 1 });
    assert(unnoted.body?.code !== 'moderation_muted', `a send without a note is not refused for the mute (${unnoted.status} ${unnoted.body?.error})`);
    // A note that is a number is words too (a phone number), on all three routes. Bob has Beans and a finished trade,
    // so a route that let the note through would store it for the other side to read.
    const hens = crypto.randomUUID();
    createCrowdfundProject(hens, kim.pk, 'Hen house', 'Wire and timber', [], 50, null);
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run('9999-12-31T23:59:59.999Z', bob.pk);
    const digits = 412345678;
    const numeric: [string, Res][] = [
        ['with Beans', await call('POST', bob, '/api/ledger/transfer', { to: zed.pk, amount: 1, memo: digits })],
        ['with a crowdfund pledge', await call('POST', bob, `/api/crowdfund/projects/${hens}/pledge`, { amount: 1, memo: digits })],
        ['with an enterprise pledge', await call('POST', bob, `/api/enterprise/${hub.pk}/pledge`, { amount: 1, memo: digits })],
    ];
    for (const [what, r] of numeric) assert(refused(r), `muted: a note that is a number, ${what} → 403 moderation_muted (got ${r.status} ${JSON.stringify(r.body)?.slice(0, 140)})`);
    const digitNotes = one(`SELECT COUNT(*) AS c FROM transactions WHERE CAST(memo AS TEXT) LIKE '${digits}%'`);
    assert(digitNotes === 0, `and none of them is stored (${digitNotes})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(bob.pk);
    const reads = [await call('GET', max, '/api/marketplace/posts'), await call('GET', max, `/api/enterprise/${hub.pk}/thread`), await call('GET', max, `/api/groups/${openClub.id}/chat`)];
    const left = await call('DELETE', max, `/api/groups/${openClub.id}/members/${max.pk}`);
    assert(reads.every(r => r.status === 200) && left.status === 200,
        `he still reads the listing, the thread and the group chat, and leaves the group (${reads.map(r => r.status).join(', ')}, ${left.status})`);
    const beforeLift = linesBy(max);
    const liftAgain = await admin('POST', `/api/local/admin/members/${max.pk}/unmute`);
    const threadBack = await call('POST', max, `/api/enterprise/${hub.pk}/thread/message`, { text: 'Hello again' });
    assert(liftAgain.status === 200 && threadBack.status === 201 && linesBy(max) === beforeLift + 1,
        `after a moderator lifts the mute, the thread takes his line again (${liftAgain.status}, ${threadBack.status} ${threadBack.body?.error ?? ''})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The lobby moderates itself, a moderator can undo it, and a local community is untouched.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
