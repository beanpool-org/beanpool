/**
 * Forum posts on an Ask to join, slice F11 (scratch/fable-design/DESIGN-forums-fable.md §13, §21 F11 "test-knock-forum-links.ts":
 * at most three; another person's post fails the check; the request is accepted with global unreachable), through the real
 * HTTPS stack and its signature middleware.
 *
 * One process plays both servers, as test-forum-public and test-membership-note do: with NODE_PROFILE=global it is the
 * worldwide forum (posts, secrets, proofs, the public JSON); without, it is the community asked (knocks, the admins' list).
 * Asha and Ben write on the worldwide forum, then their rows here go, so the community asked meets them as strangers.
 *
 *  1. The worldwide forum: a member told the forum is public has a secret; GET /api/forum/ask-posts gives Asha hers and her
 *     own public posts only, newest first, never cached; a member with none gets one made at the first ask, and a standby
 *     makes none (503) but gives the one its copy holds; unsigned 401, a stranger 403; each public post carries the proof its
 *     writer's key and secret make; no public answer holds any secret; the public topic JSON is readable from another origin,
 *     the secret's route is not. A local community: 404 `not_here`.
 *  2. The request: a fourth post refused (400 `too_many_forum_posts`); a post that doesn't read, the same post twice, posts
 *     without a secret, refused (400 `bad_forum_posts`); a community that points to no worldwide forum takes the request and
 *     keeps none.
 *  3. Closing the class, one table: (post: own / another's / removed / hidden / waiting for a first look / a new person's /
 *     a group's section) x (count 0..4) x (the worldwide forum reachable / unreachable / slow) -> accepted with a tick /
 *     accepted without / refused, the admins' row read through @beanpool/core checkKnockForumPost, the apps' own call. The
 *     request never waits on the worldwide community and no request to it is made while it is taken.
 *  4. The secret is kept nowhere on the community asked: not in the row, not in the list.
 *  5. Kept and cleared like the rest of a request: the copy carries `forum_posts` and a standby merges it; a decline's tidy-up
 *     and a prune clear it. On the worldwide forum a re-key moves the secret with the posts (the proof follows the new key),
 *     and deleting the account deletes it.
 *  6. Nothing left this machine: every fetch the process made was to its own servers.
 *
 * Fail-first: run against origin/main's server (core's forum-ask.ts in place), section 1 stops at its second check with
 * "SqliteError: no such column: proof_secret": no member has a secret, no post a proof, and the table is never reached.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knock-forum-links" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.PRIVATE_PREVIEW;
delete process.env.GLOBAL_COMMUNITY_URL;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;

import crypto from 'node:crypto';
import net from 'node:net';
import {
    FORUM_ASK_POSTS, checkKnockForumPost, forumPostProof, forumPublicShapeProblems, readKnockForum,
    type ForumAskCheck, type ForumAskPick, type KnockForumPost,
} from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { dropForumOf, markForumTold, resetForumStartersCheckForTests } from './engine/forum.js';
import { forumPublicOn } from './engine/forum-public.js';
import { mergeReplicatedKnocks, scrubKnocksOf, tidyKnocks } from './engine/knocks.js';
import { moveMemberKeyRows } from './engine/key-move.js';
import { TABLES } from './engine/replication-manifest.js';
import { setNodeRole } from './config/node-role.js';
import { resetPhotoBudgetForTests } from './engine/photo-upload-budget.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string, daysAgo: number): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, ?, 'TEST', 'active')`)
        .run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    markForumTold(id.pk);
    return id;
}

/** Every fetch the process makes but the suite's own calls: the server's, and the admins' checks. */
const realFetch = globalThis.fetch;
const fetched: string[] = [];
(globalThis as any).fetch = (input: any, init?: any) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return realFetch(input, init);
};

interface Res { status: number; body: any; text: string; headers: Headers }
async function call(id: Id | null, method: 'GET' | 'POST' | 'OPTIONS', urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const h: Record<string, string> = { ...extra };
    if (method === 'POST') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await realFetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'POST' ? raw : undefined });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 200)}` : '-');
const get = (id: Id | null, p: string) => call(id, 'GET', p);
const asWorldwide = () => { process.env.NODE_PROFILE = 'global'; };
const asCommunity = () => { delete process.env.NODE_PROFILE; };

/**
 * A worldwide forum that takes the connection and never answers, not even the TLS handshake (slow), and an address nobody
 * listens on (unreachable). Each connection the slow one takes is counted.
 */
let slowConnections = 0;
async function slowServer(): Promise<{ url: string; close: () => void }> {
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => { slowConnections++; sockets.push(s); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `https://localhost:${(server.address() as net.AddressInfo).port}`, close: () => { sockets.forEach((s) => s.destroy()); server.close(); } };
}
async function closedPort(): Promise<string> {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    return `https://localhost:${port}`;
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    resetPhotoBudgetForTests();
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');

    // ── 1. The worldwide forum ──────────────────────────────────────────────────────────────────
    console.log('── 1. the worldwide forum: secrets, proofs, the asker\'s own posts ──');
    asWorldwide();
    db.prepare("DELETE FROM node_config WHERE key = 'forum.startersMade'").run();
    resetForumStartersCheckForTests();
    require_(forumPublicOn(), 'the worldwide community: its forum is public');
    markForumTold(owner.pk);
    const asha = member('Asha', 60);
    const ben = member('Ben', 60);
    const nia = member('Nia', 1);
    const waiters = [member('Wes', 1), member('Wyn', 1), member('Wil', 1)];
    const secretOf = (id: Id) => (db.prepare('SELECT proof_secret FROM forum_members WHERE member_pubkey = ?').get(id.pk) as { proof_secret: string | null } | undefined)?.proof_secret ?? null;
    assert(/^[0-9a-f]{64}$/.test(secretOf(asha) ?? '') && /^[0-9a-f]{64}$/.test(secretOf(ben) ?? '') && secretOf(asha) !== secretOf(ben),
        'told the forum is public, each member has a secret of their own (64 hex), before any post of theirs');

    // Asha and Ben are known in this forum, as a moderator's OK of a first topic makes a writer known: their posts are public.
    db.prepare('UPDATE forum_members SET known_at = ? WHERE member_pubkey IN (?, ?)').run(ago(30 * DAY), asha.pk, ben.pk);
    const sections = (await get(owner, '/api/forum')).body?.sections ?? [];
    const skills = sections.find((s: any) => s.starter === 'skills')?.id as string;
    require_(skills, `the worldwide forum has Skills & how-to (${show(await get(owner, '/api/forum'))})`);
    const GROUP = 'grp-builders-f11';
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, lead_pubkey, join_policy) VALUES (?, 'Builders', 'builders-f11', ?, ?, 'invite_only')`).run(GROUP, owner.pk, owner.pk);
    db.prepare("INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'convenor', 'active', 1)").run(GROUP, owner.pk);
    db.prepare("INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'member', 'active', 1)").run(GROUP, asha.pk);
    const buildersRes = await call(owner, 'POST', '/api/forum/sections', { name: 'Builders', groupId: GROUP });
    require_(buildersRes.status === 201, `the owner makes the Builders group's section (${show(buildersRes)})`);
    const builders = buildersRes.body.section.id as string;

    type Post = ForumAskPick;
    const topic = async (id: Id, sectionId: string, title: string): Promise<Post> => {
        const r = await call(id, 'POST', '/api/forum/topics', { sectionId, title, words: `${title}, in ${id.name}'s words.` });
        require_(r.status === 201, `${id.name} starts "${title}" (${show(r)})`);
        return { postId: r.body.post.id, topicId: r.body.topic.id, number: 1, title };
    };
    const reply = async (id: Id, t: Post, words: string): Promise<Post> => {
        const r = await call(id, 'POST', `/api/forum/topics/${t.topicId}/replies`, { words });
        require_(r.status === 201, `${id.name} replies in "${t.title}" (${show(r)})`);
        return { postId: r.body.post.id, topicId: t.topicId, number: r.body.post.number, title: t.title };
    };
    const a1 = await topic(asha, skills, 'Starting a seed library');
    const a2 = await topic(asha, skills, 'Fixing bikes on Saturdays');
    const b1 = await topic(ben, skills, 'Ben asks about rainwater');
    const own = [a1, await reply(asha, b1, 'Asha answers Ben.'), a2];
    const spare = await topic(asha, skills, 'Asha\'s fourth public post');
    const another = [b1, await reply(ben, a1, 'Ben replies to Asha.'), await topic(ben, skills, 'Ben on compost')];
    const removed: Post[] = [];
    for (let i = 0; i < 3; i++) {
        const p = await reply(asha, a1, `Asha removed words ${i}`);
        require_((await call(asha, 'POST', `/api/forum/posts/${p.postId}/remove`)).status === 200, `Asha removes reply ${i}`);
        removed.push(p);
    }
    const hidden: Post[] = [];
    for (let i = 0; i < 3; i++) {
        const p = await reply(asha, a1, `Asha hidden words ${i}`);
        db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), p.postId);
        hidden.push(p);
    }
    const g1 = await topic(asha, builders, 'Builders plans');
    const group = [g1, await reply(asha, g1, 'Group words one'), await reply(asha, g1, 'Group words two')];
    const newPerson = [await reply(nia, a1, 'Nia new words 1'), await reply(nia, a1, 'Nia new words 2'), await reply(nia, b1, 'Nia new words 3')];
    const waiting: Post[] = [];
    for (const w of waiters) {
        const r = await call(w, 'POST', '/api/forum/topics', { sectionId: skills, title: `${w.name} waits`, words: 'Waiting words.' });
        require_(r.status === 202, `${w.name}'s first topic waits for a first look (${show(r)})`);
        waiting.push({ postId: r.body.waiting.id, topicId: r.body.waiting.id, number: 1, title: `${w.name} waits` });
    }

    const mine = await get(asha, '/api/forum/ask-posts');
    require_(mine.status === 200 && mine.body?.secret === secretOf(asha), `the worldwide forum gives Asha her secret (${mine.status})`);
    const secret = mine.body.secret as string;
    const ids = (mine.body.posts ?? []).map((p: any) => p.postId);
    const ownIds = [...own, spare].map((p) => p.postId);
    assert(ids.length === ownIds.length && ownIds.every((id) => ids.includes(id)),
        `her own posts anyone on the web can read, and only those: not removed, hidden, a group's, nor anyone else's (${ids.length} of ${ownIds.length})`);
    assert(ids[0] === spare.postId && mine.body.posts.every((p: any) => typeof p.title === 'string' && p.number >= 1 && p.topicId), 'newest first, each with its topic, number and title');
    assert(/no-store/.test(mine.headers.get('cache-control') ?? ''), `never cached (${mine.headers.get('cache-control')})`);
    assert((await get(asha, '/api/forum/ask-posts')).body?.secret === secret, 'asked again, the same secret: it never changes');
    // A member never told the forum is public has no row at all: the first ask makes the secret. A standby makes none.
    const una = newId('Una');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, 'Una', ?, ?, 'TEST', 'active')`).run(una.pk, ago(60 * DAY), owner.pk);
    const uli = newId('Uli');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, 'Uli', ?, ?, 'TEST', 'active')`).run(uli.pk, ago(60 * DAY), owner.pk);
    require_(secretOf(una) === null && secretOf(uli) === null, 'Una and Uli were never told: no secret yet');
    const unaFirst = await get(una, '/api/forum/ask-posts');
    assert(unaFirst.status === 200 && /^[0-9a-f]{64}$/.test(unaFirst.body?.secret ?? '') && unaFirst.body.secret === secretOf(una) && unaFirst.body.posts?.length === 0,
        `a member with no secret asks: one is made and kept, with no posts to pick (${unaFirst.status})`);
    setNodeRole('backup');
    const onStandbyNone = await get(uli, '/api/forum/ask-posts');
    const onStandbyKept = await get(asha, '/api/forum/ask-posts');
    setNodeRole('primary');
    assert(onStandbyNone.status === 503 && onStandbyNone.body?.code === 'standby' && secretOf(uli) === null,
        `a standby makes no secret: 503 standby, nothing written (${onStandbyNone.status})`);
    assert(onStandbyKept.status === 200 && onStandbyKept.body?.secret === secret, `a standby gives a member the secret its copy holds (${onStandbyKept.status})`);
    const stranger = newId('Stranger');
    const unsigned = await get(null, '/api/forum/ask-posts');
    const notMember = await get(stranger, '/api/forum/ask-posts');
    assert(unsigned.status === 401 && !unsigned.text.includes(secret), `unsigned: 401, no secret (${show(unsigned)})`);
    // The read middleware refuses a key that is no member before the route runs (its own code); the route refuses too.
    assert(notMember.status === 403 && !notMember.text.includes(secret), `a stranger's key: 403, no secret (${show(notMember)})`);

    // Each public post's proof: its writer's key and secret, as core makes it; another key or secret makes another.
    const topicJson = await get(null, `/api/forum/public/topics/${a1.topicId}`);
    const a1Posts = (topicJson.body?.posts ?? []) as any[];
    const opening = a1Posts.find((p) => p.id === a1.postId);
    const bensReply = a1Posts.find((p) => p.id === another[1].postId);
    assert(opening?.proof === forumPostProof({ postId: a1.postId, writerKey: asha.pk, secret }),
        `Asha's post carries the proof her key and secret make (${opening?.proof?.slice(0, 12)})`);
    assert(bensReply?.proof === forumPostProof({ postId: bensReply?.id, writerKey: ben.pk, secret: secretOf(ben)! })
        && bensReply?.proof !== forumPostProof({ postId: bensReply?.id, writerKey: asha.pk, secret }), "Ben's reply carries his, which Asha's key and secret don't make");
    assert(a1Posts.length > 0 && a1Posts.every((p) => forumPublicShapeProblems('post', p).length === 0), 'every public post holds only the allowed fields, the proof among them');
    const publicTexts = [topicJson.text, (await get(null, '/api/forum/public')).text, (await get(null, `/forum/t/${a1.topicId}`)).text,
        (await get(asha, `/api/forum/public/topics/${b1.topicId}`)).text];
    assert(publicTexts.every((t) => !t.includes(secret) && !t.includes(secretOf(ben)!)), 'no public answer, JSON or page, signed or not, holds a secret');
    const corsRead = await get(null, `/api/forum/public/topics/${a1.topicId}`);
    const corsHeaders = await call(null, 'GET', `/api/forum/public/topics/${a1.topicId}`, undefined, { Origin: 'https://riverside.example' });
    const preflight = await call(null, 'OPTIONS', `/api/forum/public/topics/${a1.topicId}`, undefined, { Origin: 'https://riverside.example', 'Access-Control-Request-Method': 'GET' });
    const secretCors = await call(asha, 'GET', '/api/forum/ask-posts', undefined, { Origin: 'https://riverside.example' });
    assert(corsRead.status === 200 && corsHeaders.headers.get('access-control-allow-origin') === '*' && !corsHeaders.headers.get('access-control-allow-credentials')
        && preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*',
        `an admin's web app on another community reads the public topic JSON (*, no credentials; preflight ${preflight.status})`);
    assert(!secretCors.headers.get('access-control-allow-origin'), 'the secret\'s route is readable from no other website');

    asCommunity();
    const localMine = await get(owner, '/api/forum/ask-posts');
    assert(localMine.status === 404 && localMine.body?.code === 'not_here' && !forumPublicOn(), `a local community's forum offers none: 404 not_here (${show(localMine)})`);

    // ── 2. The request ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. the request: what is refused, and what is kept ──');
    // Asha and Ben are strangers to the community asked: one process plays both servers.
    db.prepare('DELETE FROM members WHERE public_key IN (?, ?)').run(asha.pk, ben.pk);
    const pick = (p: Post) => ({ postId: p.postId, topicId: p.topicId, number: p.number, title: p.title });
    const fresh = () => db.prepare('DELETE FROM join_requests').run();
    const knock = (id: Id, extra: Record<string, unknown>) => call(id, 'POST', '/api/join/knock', { callsign: id.name, message: 'Hello, I live nearby.', ...extra });
    const rowOf = (id: Id) => db.prepare('SELECT * FROM join_requests WHERE pubkey = ? ORDER BY created_at DESC LIMIT 1').get(id.pk) as any;
    const listed = async (id: Id) => ((await get(owner, '/api/join/knocks')).body?.knocks ?? []).find((k: any) => k.pubkey === id.pk);
    process.env.GLOBAL_COMMUNITY_URL = BASE;
    fresh();
    const refusals: [string, Record<string, unknown>, string][] = [
        ['a fourth post', { forumPosts: [...own, spare].map(pick), forumSecret: secret }, 'too_many_forum_posts'],
        ['posts without a secret', { forumPosts: [pick(a1)] }, 'bad_forum_posts'],
        ['a secret not in lower-case hex', { forumPosts: [pick(a1)], forumSecret: secret.toUpperCase() }, 'bad_forum_posts'],
        ['the same post twice', { forumPosts: [pick(a1), pick(a1)], forumSecret: secret }, 'bad_forum_posts'],
        ['a post with no title', { forumPosts: [{ ...pick(a1), title: '  ' }], forumSecret: secret }, 'bad_forum_posts'],
        ['a post numbered 0', { forumPosts: [{ ...pick(a1), number: 0 }], forumSecret: secret }, 'bad_forum_posts'],
        ['posts that are not a list', { forumPosts: pick(a1), forumSecret: secret }, 'bad_forum_posts'],
    ];
    for (const [what, extra, code] of refusals) {
        const r = await knock(asha, extra);
        assert(r.status === 400 && r.body?.code === code && !rowOf(asha), `${what}: 400 ${code}, nothing kept (${show(r)})`);
    }
    process.env.GLOBAL_COMMUNITY_URL = 'off';
    const plain = await knock(asha, { forumPosts: [pick(a1)], forumSecret: secret });
    assert(plain.status === 201 && rowOf(asha)?.forum_posts === null && (await listed(asha))?.forum === null,
        `a community that points to no worldwide forum takes the request and keeps no posts (${show(plain)})`);
    fresh();

    // ── 3. The table ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. post x count x the worldwide forum -> accepted with a tick / without / refused ──');
    const kinds: Record<string, { posts: Post[]; reachable: ForumAskCheck }> = {
        own: { posts: own, reachable: 'same' },
        "another's": { posts: another, reachable: 'other' },
        removed: { posts: removed, reachable: 'gone' },
        hidden: { posts: hidden, reachable: 'gone' },
        'waiting for a first look': { posts: waiting, reachable: 'gone' },
        "a new person's": { posts: newPerson, reachable: 'gone' },
        "a group's section": { posts: group, reachable: 'gone' },
    };
    const slow = await slowServer();
    const forums = { reachable: BASE, unreachable: await closedPort(), slow: slow.url } as const;
    type Outcome = 'refused' | 'accepted' | 'tick' | 'no tick';
    let cases = 0, rows = 0, ticks = 0;
    const wrong: string[] = [];
    for (const [state, at] of Object.entries(forums) as [keyof typeof forums, string][]) {
        process.env.GLOBAL_COMMUNITY_URL = at;
        for (const [kind, { posts, reachable }] of Object.entries(kinds)) {
            for (let count = 0; count <= FORUM_ASK_POSTS + 1; count++) {
                cases++;
                fresh();
                const sent = count > FORUM_ASK_POSTS ? [...posts, spare] : posts.slice(0, count);
                const before = { fetched: fetched.length, slow: slowConnections };
                const r = await knock(asha, count ? { forumPosts: sent.map(pick), forumSecret: secret } : {});
                const label = `${state} · ${kind} · ${count}`;
                // Never waiting on the worldwide forum: no fetch while the request is taken, and no connection to the slow one (a
                // call to it would hang the request, so it would show here, not as a time).
                if (fetched.length !== before.fetched || slowConnections !== before.slow) wrong.push(`${label}: the community called out while taking it`);
                const want: Outcome = count > FORUM_ASK_POSTS ? 'refused' : 'accepted';
                const got: Outcome = r.status === 400 && r.body?.code === 'too_many_forum_posts' ? 'refused' : r.status === 201 ? 'accepted' : 'refused';
                if (got !== want || (want === 'refused' && rowOf(asha))) { wrong.push(`${label}: ${got}, wanted ${want} (${show(r)})`); continue; }
                if (want === 'refused') continue;
                const row = await listed(asha);
                const forum = readKnockForum(row?.forum);
                if (count === 0) { if (row?.forum !== null) wrong.push(`${label}: rows on a plain request`); continue; }
                if (!forum || forum.at !== at || forum.posts.length !== count) { wrong.push(`${label}: listed ${JSON.stringify(row?.forum)?.slice(0, 120)}`); continue; }
                for (const p of forum.posts as KnockForumPost[]) {
                    rows++;
                    if (p.proof !== forumPostProof({ postId: p.postId, writerKey: asha.pk, secret })) wrong.push(`${label}: the kept proof is not Asha's key's`);
                    // The admin's app, reading the worldwide forum (the server is the worldwide one for the read).
                    if (state === 'reachable') asWorldwide();
                    const result = await checkKnockForumPost(forum.at, p, { timeoutMs: state === 'slow' ? 300 : 3_000 });
                    asCommunity();
                    const wantCheck: ForumAskCheck = state === 'reachable' ? reachable : 'unknown';
                    const tick: Outcome = result.check === 'same' ? 'tick' : 'no tick';
                    if (tick === 'tick') ticks++;
                    if (result.check !== wantCheck || tick !== (wantCheck === 'same' ? 'tick' : 'no tick')) wrong.push(`${label} · ${p.postId}: ${result.check}, wanted ${wantCheck}`);
                }
            }
        }
    }
    slow.close();
    assert(wrong.length === 0, `${cases} requests, ${rows} rows, ${ticks} ticks: a fourth post refused; 0 to 3 taken whatever the worldwide forum does, never waiting on it, never calling it; `
        + `a tick only for her own posts with the forum reachable; another person's post fails the check; removed, hidden, waiting, a new person's and a group's read as not there; `
        + `unreachable or slow reads "Could not check"${wrong.length ? ` — ${wrong.slice(0, 8).join(' | ')}` : ''}`);
    assert(cases === 3 * 7 * 5 && ticks === 1 + 2 + 3 && rows === 3 * 7 * 6, `the whole table ran (${cases} requests, ${rows} rows, ${ticks} ticks)`);

    // ── 4. The secret is kept nowhere ───────────────────────────────────────────────────────────
    console.log('\n── 4. the secret is kept nowhere on the community asked ──');
    process.env.GLOBAL_COMMUNITY_URL = BASE;
    fresh();
    const kept = await knock(asha, { forumPosts: own.map(pick), forumSecret: secret });
    require_(kept.status === 201, `Asha asks with her three posts (${show(kept)})`);
    const list = await get(owner, '/api/join/knocks');
    assert(!JSON.stringify(rowOf(asha)).includes(secret) && !list.text.includes(secret) && list.text.includes(own[0].postId),
        'the row and the admins\' list hold the posts and proofs, never the secret');
    const benKnock = await knock(ben, { forumPosts: [pick(a1)], forumSecret: secretOf(ben) });
    const benRow = readKnockForum((await listed(ben))?.forum);
    asWorldwide();
    const benCheck = benRow ? await checkKnockForumPost(benRow.at, benRow.posts[0], { timeoutMs: 3_000 }) : null;
    asCommunity();
    assert(benKnock.status === 201 && benCheck?.check === 'other', `Ben, sending Asha's post with his own secret, is taken, and the check says it isn't his (${benCheck?.check})`);

    // ── 5. Kept and cleared like the rest ───────────────────────────────────────────────────────
    console.log('\n── 5. the copy, the tidy-up, a prune; a re-key and a deleted account on the worldwide forum ──');
    const columnsOf = (table: string) => ((TABLES as Record<string, { columns?: readonly string[] }>)[table]?.columns ?? []);
    assert(columnsOf('join_requests').includes('forum_posts') && columnsOf('forum_members').includes('proof_secret'), 'the manifest copies both new columns');
    const copy = await exportSyncState('test-knock-forum-links') as any;
    const carried = (copy.joinRequests ?? []).find((r: any) => r.pubkey === asha.pk);
    assert(carried?.forumPosts === rowOf(asha).forum_posts, 'the copy carries the posts and proofs as the row keeps them');
    const keptText = rowOf(asha).forum_posts as string;
    db.prepare('DELETE FROM join_requests WHERE pubkey = ?').run(asha.pk);
    const merged = mergeReplicatedKnocks([carried]);
    assert(merged.written === 1 && rowOf(asha)?.forum_posts === keptText, `a standby merges it whole (${JSON.stringify(merged)})`);
    const ashaKnock = rowOf(asha).id as string;
    const declined = await call(owner, 'POST', `/api/join/knocks/${ashaKnock}/decline`);
    tidyKnocks();
    assert(declined.status === 200 && rowOf(asha)?.forum_posts === null, 'declined, then tidied: cleared with what she sent');
    scrubKnocksOf(ben.pk);
    assert(rowOf(ben)?.forum_posts === null, 'a prune or self-deletion of the applicant clears it too');

    asWorldwide();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, 'Asha', ?, ?, 'TEST', 'active')`).run(asha.pk, ago(60 * DAY), owner.pk);
    const ashaNew = newId('AshaNew');
    db.transaction(() => moveMemberKeyRows(asha.pk, ashaNew.pk, new Date().toISOString(), { keepStamps: false }))();
    const movedProof = ((await get(null, `/api/forum/public/topics/${a1.topicId}`)).body?.posts ?? []).find((p: any) => p.id === a1.postId)?.proof;
    assert(secretOf(ashaNew) === secret && secretOf(asha) === null && movedProof === forumPostProof({ postId: a1.postId, writerKey: ashaNew.pk, secret }),
        'a re-key moves her secret with her posts: the proof is her new key\'s');
    db.transaction(() => dropForumOf(ashaNew.pk))();
    assert(secretOf(ashaNew) === null, 'deleting her account deletes her secret');
    asCommunity();

    // ── 6. Nothing left this machine ────────────────────────────────────────────────────────────
    const away = fetched.filter((u) => !/^https:\/\/localhost:\d+\//.test(u));
    assert(away.length === 0, `every fetch the process made was to its own servers (${fetched.length}; away: ${away.slice(0, 3).join(', ') || 'none'})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
