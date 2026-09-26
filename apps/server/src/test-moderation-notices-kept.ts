/**
 * Moderation notices are kept for the member they are for, so the web app, which has no push, shows them the next time
 * it opens (#1175's deciding pass, 4109443831): every notice engine/moderation-notices.ts sends is also kept, one row per
 * recipient (engine/kept-notices.ts), read and marked seen by that member only (routes/notices.ts).
 *
 * Over REAL HTTPS through the real signature middleware; moderators on real key sessions; the node on the global
 * profile, so reports hide and removals pause:
 *
 *   1. a post hidden by reports: its author, and nobody else, has one kept notice: the title, body, kind and post the
 *      live notice carried, and the live notice names that copy's id; nothing kept names a reporter or the moderator
 *   2. a moderator's removal: the author has "removed" with the reason, each reporter whose report it closed has "the
 *      post you reported was removed", and nobody else anything; no reporter's copy names another reporter
 *   3. a report's outcome: a dismissed report leaves its reporter "kept", and the author nothing
 *   4. a pause: the third removal in 30 days leaves the author "Posting paused" (and /api/community/me says so); the
 *      lift leaves "You can post again"; nobody else has either
 *   5. the read: the signer's own only, whatever the query or the path names; unseen=1 the unseen only; unsigned 401,
 *      a key that is no member 403, a visitor's row 403; a suspended member reads their own; private, no-store
 *   6. the mark: a member marks their own only (another member's ids mark nothing, and those stay unseen), once; a bad
 *      body 400; a key that is no member 403, unsigned 401; the full read then has seenAt, and unseen=1 leaves it out
 *   7. the bounds: a member's newest 50 (each new one past that drops the oldest, with a tombstone); nothing older than 60
 *      days is read, and the hourly hygiene job deletes it (tombstoned); nothing kept for an enterprise's key, a visitor's
 *      row or a closed account, nor past the size limits; a prune and a self-deletion take a member's notices (and a closed account
 *      reads nothing); a re-key moves them to the new key
 *   8. replication: the export carries each notice with when it was seen; a standby importing it holds them (insert, and
 *      a seen mark over an older copy), keeps a newer copy of its own, keeps deleted a notice it has a tombstone for,
 *      applies the copy's tombstones, and leaves out a row for nobody here and a malformed one without failing the
 *      copy; a force-resync clears the table; the replica audit counts it
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-moderation-notices-kept.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, grantNodeRole, createPost, exportSyncState, signSyncPayload, importRemoteState, setNodeRole,
    adminPruneUser, runMarketplaceHygiene, clearReplicatedTables,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';
import { getReplicaConsistency } from '@beanpool/engine';
import * as mod from './engine/moderation-notices.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without kept notices (no such table, no such module) must fail its assertion, not abort the run. */
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
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
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

/** A post written straight into the engine, as it would be by a member long before the test, out of any window. */
function oldPost(id: Id, title: string): string {
    const p = createPost('offer', 'other', title, `${title} description`, 0, 'fixed', id.pk)!;
    db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
    return p.id;
}
const report = (reporter: Id, postId: string, author: Id) =>
    call('POST', reporter, '/api/reports', { reporterPubkey: reporter.pk, targetPubkey: author.pk, targetPostId: postId, reason: 'spam' });
const hiddenAt = (postId: string) => (db.prepare('SELECT hidden_by_reports_at FROM posts WHERE id = ?').get(postId) as any)?.hidden_by_reports_at ?? null;

// ── what is kept, read straight from the database (the routes are checked on their own) ───────────
interface Row { id: string; recipient: string; title: string; body: string; data: string; created_at: string; seen_at: string | null; updated_at: string }
const rowsOf = (id: Id | string): Row[] =>
    attempt(() => db.prepare('SELECT * FROM moderation_notices WHERE recipient = ? ORDER BY created_at, rowid').all(typeof id === 'string' ? id : id.pk) as Row[]) ?? [];
/** How many notices each member holds: the before-and-after of an action says exactly who it left one for. */
const holdings = (): Map<string, number> => new Map(
    (attempt(() => db.prepare('SELECT recipient, COUNT(*) AS n FROM moderation_notices GROUP BY recipient').all() as { recipient: string; n: number }[]) ?? [])
        .map(r => [r.recipient, r.n]));
function gained(before: Map<string, number>): Map<string, number> {
    const out = new Map<string, number>();
    for (const [pk, n] of holdings()) if (n > (before.get(pk) ?? 0)) out.set(pk, n - (before.get(pk) ?? 0));
    return out;
}
const tombstoned = (noticeId: string) => !!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'moderation_notices' AND row_key = ?").get(noticeId);
const dataOf = (r: Row | undefined) => { try { return JSON.parse(r?.data ?? 'null') ?? {}; } catch { return {}; } };
const readNotices = async (id: Id, query = '') => {
    const r = await call('GET', id, `/api/notices${query}`);
    return { status: r.status, notices: Array.isArray(r.body?.notices) ? r.body.notices as any[] : [], res: r };
};

// ── signed member sockets, for the live notices ─────────────────────────────────────────────────
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
const liveNotices = (s: Sock) => s.events.filter(e => e.type === 'system_announcement');

async function main(): Promise<void> {
    console.log('\n=== Moderation notices kept for the web app ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    // Absent on a tree without them: every check that needs one fails, and the rest still run.
    const kept: any = await import('./engine/kept-notices.js').catch(() => null);

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const mo = member('Mo', 60);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    modSession = keySession(mo);
    const ava = member('Ava', 40);
    const R = [1, 2, 3].map(i => member(`Rep${i}`, 20 + i));
    const bea = member('Bea', 30);
    const nobody = newId('Nemo'); // a key that is no member here
    process.env.NODE_PROFILE = 'global';
    const f = (await call('GET', null, '/api/community/info')).body?.features ?? {};
    assert(f.autoHideReports === true && f.autoMute === true, `setup: the global profile hides on reports and pauses on removals (${JSON.stringify({ h: f.autoHideReports, m: f.autoMute })})`);

    const avaSock = await socket(ava);
    const beaSock = await socket(bea);
    await sleep(100);
    const everyone = [ava, ...R, bea, mo, owner];
    const nameOf = new Map(everyone.map(m => [m.pk, m.name]));
    const who = (m: Map<string, number>) => JSON.stringify([...m].map(([pk, n]) => `${nameOf.get(pk) ?? pk.slice(0, 8)}×${n}`));
    /** Nothing in these rows names any of `people`, by key or by name. */
    const namesNone = (rows: Row[], people: Id[]) => {
        const text = JSON.stringify(rows.map(r => ({ title: r.title, body: r.body, data: r.data })));
        return people.every(p => !text.includes(p.pk) && !text.includes(p.name));
    };

    // ── 1. a post hidden by reports ──────────────────────────────────────────────────────────────
    console.log('── 1. a post hidden by reports ──');
    const hidTitle = 'Hidden honey';
    const hid = oldPost(ava, hidTitle);
    let before = holdings();
    avaSock.events.length = 0; beaSock.events.length = 0;
    for (const r of R) assert((await report(r, hid, ava)).status === 200, `${r.name} reports Ava's post (200)`);
    assert(!!hiddenAt(hid), 'setup: 3 established reporters hide it');
    let g = gained(before);
    assert(g.size === 1 && g.get(ava.pk) === 1, `the hide leaves one notice, for its author, and none for anyone else (${who(g)})`);
    const hiddenRow = rowsOf(ava).find(r => dataOf(r).postId === hid);
    assert(hiddenRow?.title === mod.POST_HIDDEN_TITLE && hiddenRow?.body === mod.postHiddenBody(hidTitle)
        && dataOf(hiddenRow).kind === 'post_hidden' && dataOf(hiddenRow).reason === 'reports' && hiddenRow?.seen_at === null,
        `it says what the live notice said: hidden for review, the reason "reports", unseen (${hiddenRow?.title} / ${hiddenRow?.data})`);
    await sleep(200);
    const live = liveNotices(avaSock).find(e => e.kind === 'post_hidden' && e.postId === hid);
    assert(!!live && !!hiddenRow && live.noticeId === hiddenRow.id, `the live notice names the kept copy's id, so the web app that shows it marks it seen (${live?.noticeId})`);
    assert(liveNotices(beaSock).length === 0, 'a bystander gets no live notice');
    assert(namesNone(rowsOf(ava), [...R, mo]), "nothing kept for the author names a reporter or the moderator");

    // ── 2. a moderator's removal ─────────────────────────────────────────────────────────────────
    console.log('\n── 2. a moderator removes a post ──');
    const goneTitle = 'Removed rhubarb';
    const gone = oldPost(ava, goneTitle);
    for (const r of R.slice(0, 2)) assert((await report(r, gone, ava)).status === 200, `${r.name} reports it`);
    assert(!hiddenAt(gone), 'setup: 2 reports hide nothing');
    before = holdings();
    const del = await admin('POST', `/api/local/admin/posts/${gone}/delete`, { reasonCategory: 'spam' });
    assert(del.status === 200, `the moderator removes it (${del.status} ${del.body?.error ?? ''})`);
    g = gained(before);
    assert(g.size === 3 && g.get(ava.pk) === 1 && g.get(R[0].pk) === 1 && g.get(R[1].pk) === 1,
        `the removal leaves one notice each for the author and the 2 reporters, and none for anyone else (${who(g)})`);
    const removedRow = rowsOf(ava).find(r => dataOf(r).postId === gone);
    assert(removedRow?.title === mod.POST_REMOVED_TITLE && removedRow?.body === mod.postRemovedBody(goneTitle, 'spam') && dataOf(removedRow).kind === 'post_removed',
        `the author's says removed by the moderators, and why (${removedRow?.body})`);
    for (const [i, r] of R.slice(0, 2).entries()) {
        const mine = rowsOf(r).filter(x => dataOf(x).postId === gone);
        assert(mine.length === 1 && mine[0].title === mod.REPORT_OUTCOME_TITLE && mine[0].body === mod.reportedPostRemovedBody()
            && dataOf(mine[0]).outcome === 'removed', `${r.name}'s says the post they reported was removed`);
        assert(namesNone(rowsOf(r), [ava, mo, R[1 - i]]), `${r.name}'s names neither the author, the moderator, nor the other reporter`);
    }
    assert(namesNone(rowsOf(ava), [...R, mo]), 'nor does anything kept for the author');

    // ── 3. a report's outcome ────────────────────────────────────────────────────────────────────
    console.log('\n── 3. a dismissed report ──');
    const keep = oldPost(ava, 'Kept kale');
    const rep = await report(R[2], keep, ava);
    assert(rep.status === 200 && typeof rep.body?.report?.id === 'string', 'Rep3 reports another post');
    before = holdings();
    const dis = await admin('POST', `/api/local/admin/reports/${rep.body?.report?.id}/dismiss`);
    assert(dis.status === 200, `the moderator dismisses the report (${dis.status} ${dis.body?.error ?? ''})`);
    g = gained(before);
    assert(g.size === 1 && g.get(R[2].pk) === 1, `the outcome leaves one notice, for the reporter, and none for the author or anyone else (${who(g)})`);
    const keptRow = rowsOf(R[2]).find(r => dataOf(r).postId === keep);
    assert(keptRow?.body === mod.reportedPostKeptBody() && dataOf(keptRow).outcome === 'kept', `it says the post was reviewed and kept (${keptRow?.body})`);

    // ── 4. a pause, and its lift ─────────────────────────────────────────────────────────────────
    console.log('\n── 4. a pause, and its lift ──');
    // Ava has one moderator removal (section 2). Two more within 30 days pause her; each needs an open report on the post.
    let flags = 0;
    const removeByModerator = async (postId: string) => {
        const flagger = member(`Flag${++flags}`, 90);
        everyone.push(flagger); nameOf.set(flagger.pk, flagger.name);
        await report(flagger, postId, ava);
        return { flagger, status: (await admin('POST', `/api/local/admin/posts/${postId}/delete`, { reasonCategory: 'spam' })).status };
    };
    const second = await removeByModerator(oldPost(ava, 'Second spam'));
    before = holdings();
    const third = await removeByModerator(oldPost(ava, 'Third spam'));
    assert(second.status === 200 && third.status === 200, `setup: two more removals (${second.status}, ${third.status})`);
    g = gained(before);
    assert(g.size === 2 && g.get(ava.pk) === 2 && g.get(third.flagger.pk) === 1,
        `the third removal leaves Ava its removal and the pause, its reporter the outcome, and nobody anything else (${who(g)})`);
    const pausedRow = rowsOf(ava).find(r => dataOf(r).kind === 'moderation_muted');
    assert(pausedRow?.title === mod.MUTED_TITLE && pausedRow?.body === mod.mutedBody(), `Ava's says posting is paused, in the refusal's words (${pausedRow?.title})`);
    const standing = (await call('GET', ava, '/api/community/me')).body;
    assert(standing?.mute?.muted === true && typeof standing?.mute?.until === 'string', `and /api/community/me says she is paused (${JSON.stringify(standing?.mute)})`);
    before = holdings();
    const lift = await admin('POST', `/api/local/admin/members/${ava.pk}/unmute`);
    assert(lift.status === 200, `the moderator lifts it (${lift.status} ${lift.body?.error ?? ''})`);
    g = gained(before);
    assert(g.size === 1 && g.get(ava.pk) === 1 && dataOf(rowsOf(ava).at(-1)).kind === 'moderation_unmuted' && rowsOf(ava).at(-1)?.title === mod.UNMUTED_TITLE,
        `the lift leaves Ava "You can post again", and nobody else anything (${who(g)})`);
    const pauses = attempt(() => (db.prepare(`SELECT COUNT(*) AS n FROM moderation_notices WHERE recipient != ? AND (data LIKE '%moderation_muted%' OR data LIKE '%moderation_unmuted%')`).get(ava.pk) as any).n);
    assert(pauses === 0, `nobody but Ava holds a pause or a lift (${pauses})`);

    // ── 5. the read ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. the read: the signer\'s own ──');
    const avaAll = await readNotices(ava);
    assert(avaAll.status === 200 && avaAll.notices.length === rowsOf(ava).length && avaAll.notices.length >= 6,
        `Ava reads her own ${rowsOf(ava).length} (${avaAll.status}, ${avaAll.notices.length})`);
    assert(JSON.stringify(avaAll.notices.map(n => n.id)) === JSON.stringify(rowsOf(ava).map(r => r.id)), 'oldest first');
    const first = avaAll.notices.find(n => n.id === hiddenRow?.id);
    assert(first?.title === mod.POST_HIDDEN_TITLE && first?.body === mod.postHiddenBody(hidTitle) && first?.severity === 'info'
        && first?.data?.kind === 'post_hidden' && first?.data?.postId === hid && first?.seenAt === null && typeof first?.createdAt === 'string',
        `each with its title, body, severity, data, when, and not seen (${JSON.stringify(first)?.slice(0, 160)})`);
    assert(/private/.test(avaAll.res.headers.get('cache-control') ?? '') && /no-store/.test(avaAll.res.headers.get('cache-control') ?? ''),
        `private, no-store (${avaAll.res.headers.get('cache-control')})`);
    const r1Own = await readNotices(R[0]);
    const r1Ids = new Set(rowsOf(R[0]).map(r => r.id));
    assert(r1Own.status === 200 && r1Own.notices.length === r1Ids.size && r1Own.notices.every(n => r1Ids.has(n.id)), `Rep1 reads only their own ${r1Ids.size}`);
    const naming = await readNotices(R[0], `?unseen=1&recipient=${ava.pk}&publicKey=${ava.pk}&pubkey=${ava.pk}&member=${ava.pk}`);
    assert(naming.status === 200 && naming.notices.length === r1Ids.size && naming.notices.every(n => r1Ids.has(n.id)),
        'a query naming Ava still reads Rep1\'s own');
    const byPath = await call('GET', R[0], `/api/notices/${ava.pk}`);
    assert(byPath.status === 404 && !JSON.stringify(byPath.body).includes(hid), `there is no route for someone else's (${byPath.status})`);
    assert((await readNotices(bea)).notices.length === 0, 'a member who was told nothing reads none');
    const unsigned = await call('GET', null, '/api/notices');
    assert(unsigned.status === 401, `unsigned: 401 (${unsigned.status})`);
    const stranger = await call('GET', nobody, '/api/notices');
    assert(stranger.status === 403 && !Array.isArray(stranger.body?.notices), `a key that is no member here: 403 (${stranger.status})`);
    const vis = member('Visitor-5a5a', 0);
    attempt(() => db.prepare('UPDATE members SET is_visitor = 1 WHERE public_key = ?').run(vis.pk));
    const visitorRead = await call('GET', vis, '/api/notices');
    assert(visitorRead.status === 403 && !Array.isArray(visitorRead.body?.notices), `a visitor's row: 403 (${visitorRead.status})`);
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(R[0].pk);
    const suspendedRead = await readNotices(R[0]);
    assert(suspendedRead.status === 200 && suspendedRead.notices.length === r1Ids.size, `a suspended member still reads their own, as /api/community/me (${suspendedRead.status})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(R[0].pk);

    // ── 6. the mark ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. marking seen: one\'s own only ──');
    const avaUnseen = (await readNotices(ava, '?unseen=1')).notices.map(n => n.id);
    assert(avaUnseen.length === rowsOf(ava).length && avaUnseen.length > 0, `unseen=1: Ava's ${avaUnseen.length}, none seen yet`);
    const theft = await call('POST', R[0], '/api/notices/seen', { ids: avaUnseen });
    assert(theft.status === 200 && theft.body?.marked === 0, `Rep1 marking Ava's ids marks nothing (${theft.status} ${JSON.stringify(theft.body)})`);
    assert(rowsOf(ava).every(r => r.seen_at === null), "and Ava's stay unseen");
    const before6 = rowsOf(ava).find(r => r.id === avaUnseen[0]);
    const once = await call('POST', ava, '/api/notices/seen', { ids: [avaUnseen[0]] });
    assert(once.status === 200 && once.body?.marked === 1, `Ava marks one of hers (${once.status} ${JSON.stringify(once.body)})`);
    const after6 = rowsOf(ava).find(r => r.id === avaUnseen[0]);
    assert(typeof after6?.seen_at === 'string' && !!before6 && after6!.updated_at > before6.updated_at, 'it is stamped seen, and updated_at moves, so a standby gets the mark');
    const twice = await call('POST', ava, '/api/notices/seen', { ids: [avaUnseen[0]] });
    assert(twice.status === 200 && twice.body?.marked === 0, `marking it again marks nothing (${JSON.stringify(twice.body)})`);
    const unseenNow = (await readNotices(ava, '?unseen=1')).notices;
    const allNow = (await readNotices(ava)).notices;
    assert(!unseenNow.some(n => n.id === avaUnseen[0]) && unseenNow.length === avaUnseen.length - 1, 'unseen=1 leaves it out');
    assert(typeof allNow.find(n => n.id === avaUnseen[0])?.seenAt === 'string', 'and the full read has when she saw it');
    const rest = await call('POST', ava, '/api/notices/seen', { ids: avaUnseen.slice(1) });
    assert(rest.body?.marked === avaUnseen.length - 1 && (await readNotices(ava, '?unseen=1')).notices.length === 0, 'she marks the rest, and nothing is unseen');
    for (const [what, body] of [['no ids', {}], ['ids not a list', { ids: avaUnseen[0] }], ['an empty list', { ids: [] }],
        ['a number', { ids: [42] }], ['101 ids', { ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) }]] as const) {
        const r = await call('POST', ava, '/api/notices/seen', body);
        assert(r.status === 400, `${what}: 400 (${r.status})`);
    }
    const strangerMark = await call('POST', nobody, '/api/notices/seen', { ids: [avaUnseen[0]] });
    assert(strangerMark.status === 403, `a key that is no member here: 403 (${strangerMark.status})`);
    assert((await call('POST', null, '/api/notices/seen', { ids: [avaUnseen[0]] })).status === 401, 'unsigned: 401');

    // ── 7. the bounds ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. the bounds ──');
    const keepFor = (id: Id | string, body: string, at: number, data: Record<string, unknown> = { kind: 'test' }) =>
        attempt(() => kept.keepNotice(typeof id === 'string' ? id : id.pk, 'A test notice', body, data, at)) as string | null | undefined;
    const t0 = Date.now() - 10 * DAY;
    const beaIds: (string | null | undefined)[] = [];
    for (let i = 0; i < 55; i++) beaIds.push(keepFor(bea, `Body ${i}`, t0 + i * 1000));
    const beaRows = rowsOf(bea);
    assert(beaRows.length === 50 && beaRows[0]?.body === 'Body 5' && beaRows[49]?.body === 'Body 54',
        `a member keeps their newest 50: 55 kept, the 5 oldest gone (${beaRows.length}, from "${beaRows[0]?.body}")`);
    assert(beaIds.slice(0, 5).every(id => !!id && tombstoned(id)), 'each one dropped leaves a tombstone, so a standby drops it too');
    const beaRead = (await readNotices(bea)).notices;
    assert(beaRead.length === 50 && beaRead[0]?.body === 'Body 5', `the read gives the 50 (${beaRead.length})`);
    // Three past 60 days, one just inside.
    const setCreated = (at: string, id: string | undefined) => attempt(() => db.prepare('UPDATE moderation_notices SET created_at = ? WHERE id = ?').run(at, id));
    const [o1, o2, o3, inside] = beaRows.slice(0, 4).map(r => r.id);
    for (const id of [o1, o2, o3]) setCreated(ago(61 * DAY), id);
    setCreated(ago(59 * DAY), inside);
    const beforeTidy = (await readNotices(bea)).notices;
    assert(beforeTidy.length === 47 && !beforeTidy.some(n => [o1, o2, o3].includes(n.id)) && beforeTidy.some(n => n.id === inside),
        `nothing older than 60 days is read, even before the tidy runs (${beforeTidy.length})`);
    // And more than 50, as a copy could leave for a moment: the tidy trims those too.
    const insertRaw = { run: (...args: unknown[]) => db.prepare(`INSERT INTO moderation_notices (id, recipient, title, body, data, created_at, updated_at) VALUES (?, ?, 'Extra', ?, '{}', ?, ?)`).run(...args) };
    const extra = [0, 1, 2, 3, 4, 5].map(i => { const id = `extra-${i}`; attempt(() => insertRaw.run(id, bea.pk, `Extra ${i}`, ago((9 - i) * DAY), ago((9 - i) * DAY))); return id; });
    assert(rowsOf(bea).length === 56, `setup: Bea holds 56 for a moment (${rowsOf(bea).length})`);
    runMarketplaceHygiene();
    const tidied = rowsOf(bea);
    assert(tidied.length === 50 && [o1, o2, o3].every(id => !tidied.some(r => r.id === id) && tombstoned(id)),
        `the hourly hygiene job deletes the 3 past 60 days, with tombstones (${tidied.length} left)`);
    const dropped = beaRows.slice(3).map(r => r.id).filter(id => !tidied.some(r => r.id === id));
    assert(tidied.some(r => r.id === inside) === false && dropped.length === 3 && dropped.every(tombstoned) && extra.every(id => tidied.some(r => r.id === id)),
        `and the oldest past her newest 50, tombstoned: the 59-day one and the next two go, the 6 newer stay (${dropped.length})`);

    const shop = member('ShopKey', 30);
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(shop.pk);
    assert(keepFor(shop, 'For an enterprise', Date.now()) === null && rowsOf(shop).length === 0, "nothing is kept for an enterprise's key");
    assert(keepFor(nobody.pk, 'For nobody', Date.now()) === null && rowsOf(nobody.pk).length === 0, 'nor for a key that is no member here');
    assert(keepFor(vis, 'For a visitor', Date.now()) === null && rowsOf(vis).length === 0, "nor for a visitor's row");
    assert(keepFor(bea, 'x'.repeat(401), Date.now()) === null && keepFor(bea, 'Long data', Date.now(), { kind: 'x'.repeat(300) }) === null
        && attempt(() => kept.keepNotice(bea.pk, 'T'.repeat(81), 'Long title', {}, Date.now())) === null && rowsOf(bea).length === 50,
        'nor anything past the size limits (title 80, body 400, data 300)');
    const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'moderation_notices'").get();
    let sizeRefused = false;
    try { insertRaw.run('too-long', bea.pk, 'x'.repeat(401), ago(0), ago(0)); } catch (e: any) { sizeRefused = /CHECK constraint/.test(e?.message ?? ''); }
    assert(hasTable && sizeRefused === true && !rowsOf(bea).some(r => r.id === 'too-long'), 'and the table itself refuses a row past them');

    const carl = member('Carl', 30);
    const dora = member('Dora', 30);
    for (const m of [carl, dora]) { keepFor(m, 'One', Date.now() - 2000); keepFor(m, 'Two', Date.now() - 1000); }
    const carlIds = rowsOf(carl).map(r => r.id), doraIds = rowsOf(dora).map(r => r.id);
    assert(carlIds.length === 2 && doraIds.length === 2, 'setup: Carl and Dora hold 2 each');
    attempt(() => adminPruneUser(carl.pk, owner.pk));
    assert(rowsOf(carl).length === 0 && carlIds.every(tombstoned), "a prune takes the member's notices, tombstoned");
    const closed = await call('GET', carl, '/api/notices');
    assert(closed.status === 403 && closed.body?.code === 'account_closed', `a closed account reads nothing (${closed.status} ${closed.body?.code})`);
    const purge = await call('POST', dora, '/api/member/purge', {});
    assert(purge.status === 200 && rowsOf(dora).length === 0 && doraIds.every(tombstoned), `a self-deletion takes them too (${purge.status})`);
    assert(keepFor(carl, 'After the prune', Date.now()) === null, 'and nothing is kept for a closed account afterwards');

    const rex = member('Rex', 30);
    keepFor(rex, 'Before the re-key', Date.now() - 1000);
    const rexRow = rowsOf(rex)[0];
    const rexNew = newId('Rex new');
    const moved = attempt(() => { const code = issueRekeyCode(rex.pk, owner.pk).code; return completeRekey(rex.pk, rexNew.pk, code, owner.pk); });
    assert(!!moved, 'setup: Rex is re-keyed to a new phone');
    const onNew = rowsOf(rexNew);
    assert(rowsOf(rex).length === 0 && onNew.length === 1 && onNew[0].id === rexRow?.id && onNew[0].updated_at > (rexRow?.updated_at ?? ''),
        'a re-key moves the notice to the new key, stamped so the move replicates');
    const rexRead = await readNotices(rexNew, '?unseen=1');
    assert(rexRead.status === 200 && rexRead.notices.length === 1 && rexRead.notices[0].id === rexRow?.id, `and Rex reads it with the new key (${rexRead.status})`);

    // ── 8. replication ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. replication: a standby holds them ──');
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4283/p2p/${nodeId}`, 'mirror', 'self-test-peer');
    const payload: any = await exportSyncState(nodeId);
    const exported: any[] = payload.moderationNotices ?? [];
    const allRows = attempt(() => db.prepare('SELECT * FROM moderation_notices').all() as Row[]) ?? [];
    assert(exported.length === allRows.length && allRows.length > 60, `the export carries every notice (${exported.length} of ${allRows.length})`);
    const exSeen = exported.find(n => n.id === avaUnseen[0]);
    assert(exSeen?.recipient === ava.pk && exSeen?.title === after6?.title && exSeen?.body === after6?.body && exSeen?.data === after6?.data
        && typeof exSeen?.seenAt === 'string' && typeof exSeen?.createdAt === 'string' && typeof exSeen?.updatedAt === 'string' && typeof exSeen?.data === 'string',
        `each with its member, words, data, when, and when they saw it (${JSON.stringify(exSeen)?.slice(0, 160)})`);
    const delta: any = await exportSyncState(nodeId, after6?.updated_at);
    assert((delta.moderationNotices ?? []).some((n: any) => n.id === avaUnseen[0]), 'a seen mark goes out in the next delta copy');

    // The standby: one notice it never had (insert), one it holds unseen and older (the mark arrives), one it holds newer
    // (kept), one it has a tombstone for (stays deleted); and the copy carries a tombstone, a row for nobody here and a bad row.
    const [insId, markId, newerId, deadId, tombId] = [avaUnseen[1], avaUnseen[0], avaUnseen[2], avaUnseen[3], avaUnseen[4]];
    attempt(() => db.prepare('DELETE FROM moderation_notices WHERE id IN (?, ?)').run(insId, deadId));
    attempt(() => db.prepare("UPDATE moderation_notices SET seen_at = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(markId));
    attempt(() => db.prepare("UPDATE moderation_notices SET body = 'The standby''s own, newer', updated_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(newerId));
    if (deadId) db.prepare("INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES ('moderation_notices', ?, ?)").run(deadId, new Date().toISOString());
    if (tombId) payload.tombstones = [...(payload.tombstones ?? []), { tableName: 'moderation_notices', rowKey: tombId, deletedAt: new Date().toISOString() }];
    payload.moderationNotices = [...exported,
        { id: 'for-nobody-here', recipient: nobody.pk, title: 'Stray', body: 'For nobody here', data: '{}', createdAt: ago(0), seenAt: null, updatedAt: ago(0) },
        { id: 'malformed', recipient: ava.pk, title: 'x'.repeat(500), body: '', data: 7, createdAt: 'yesterday', seenAt: 3, updatedAt: null },
    ];
    // Signed again as the main server signs a copy: the standby checks the signature over everything it carries.
    const { signature: _s, publicKey: _k, ...unsignedCopy } = payload;
    const copy = await signSyncPayload(unsignedCopy);
    setNodeRole('backup');
    let importError = '';
    try { await importRemoteState(copy); } catch (e: any) { importError = e?.message || String(e); }
    setNodeRole('primary');
    assert(importError === '', `the copy imports, a bad row and all (${importError})`);
    const one = (id: string) => attempt(() => db.prepare('SELECT * FROM moderation_notices WHERE id = ?').get(id) as Row | undefined);
    const ins = one(insId);
    const exIns = exported.find(n => n.id === insId);
    assert(!!ins && ins.recipient === ava.pk && ins.title === exIns?.title && ins.body === exIns?.body && ins.data === exIns?.data && ins.created_at === exIns?.createdAt,
        'a notice the standby never had is inserted, as the main server holds it');
    assert(typeof one(markId)?.seen_at === 'string' && one(markId)?.updated_at === exSeen?.updatedAt, 'a seen mark reaches an older copy');
    assert(one(newerId)?.body === "The standby's own, newer", 'a newer copy of its own is kept');
    assert(!!deadId && one(deadId) === undefined, 'a notice it has a tombstone for stays deleted');
    assert(!!tombId && one(tombId) === undefined && tombstoned(tombId), "the copy's tombstone deletes its notice");
    assert(one('for-nobody-here') === undefined && one('malformed') === undefined, 'a row for nobody here and a malformed one are left out');
    if (kept?.mergeReplicatedNotices) {
        const m = kept.mergeReplicatedNotices([{ id: 'bad' }, null, 'x', exported.find(n => n.id === insId)]);
        assert(m.invalid === 3 && m.kept === 1 && m.written === 0, `the merge counts what it left out, and a row it already has is kept (${JSON.stringify(m)})`);
    } else assert(false, 'the merge counts what it left out (no merge on this tree)');

    // The replica audit counts the table, and a force-resync clears it.
    const audit = attempt(() => getReplicaConsistency(db, { moderationNotices: exported }, 0));
    const auditRow = audit?.tables.find(t => t.name === 'moderation_notices');
    assert(!!auditRow && auditRow.primary === exported.length, `the replica audit counts moderation_notices (${JSON.stringify(auditRow)})`);
    attempt(() => clearReplicatedTables());
    const cleared = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM moderation_notices').get() as any).n);
    assert(cleared === 0, `a force-resync clears the table before the full copy comes in (${cleared})`);
    await p2p.stop();

    avaSock.ws.close(); beaSock.ws.close();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Kept moderation notices checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
