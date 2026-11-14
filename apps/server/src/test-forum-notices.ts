/**
 * The forum's notices, slice F5, through the real HTTPS stack and its signature middleware (scratch/fable-design/
 * DESIGN-forums-fable.md §9, §16, §21 F5 "test-forum-notices.ts"). Every push is caught where it leaves for Expo: nothing
 * here contacts any host but this machine. "The clock" is moved by writing rows back in time, which is all a rule reads.
 *
 *  1. Follows: who starts or replies in a topic follows it; anyone who reads it follows, mutes or leaves it by its bell;
 *     the topic says the reader's follow and how far they read.
 *  2. Ten replies make one row and one push: each follower gets one bell row for the topic, its count 10, and one push
 *     with the kind's words alone; opening the topic takes the row off, moves the unread dot, and the next reply pushes
 *     again.
 *  3. A mention from one sender pushes once an hour: an @name of someone in the topic, or a quote of their post, tells them
 *     by a mention (not the reply's fold too); a second from the same sender folds into its row; within the hour after a
 *     push a new row comes with no push, after it one pushes again. A name not in the topic tells nobody.
 *  4. A muted topic tells nothing: no reply, no mention, a reply of their own keeps it muted.
 *  5. The Forum switch: off, nothing of the forum reaches the member; the features say forumNotices.
 *  6. Who may read: someone who blocked the writer is not told; while the opening post is hidden only the topic's writer and
 *     the moderators are.
 *  7. Doorbells: only apps that said `forum=1`, members only: a reply's to its followers and its recent readers, the list's
 *     to every member's socket, at most once in 15 seconds.
 *  8. First looks: the waiting topic and its answer go out as forum.first-look and forum.first-look-answer, under the Forum
 *     switch; the OK'd topic's writer follows it.
 *  9. Every new kind is in the kinds table and the push suite's prefix list; a browser's delivery folds them as a chat's.
 * 10. The standby and the account: forum_follows travels; delete-account and a new key take a member's follows.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-forum-notices" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPushNoticeKind, PUSH_NOTICE_KINDS } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, registerPushToken, addWsClient, exportSyncState, purgeMemberSelf } from './state-engine.js';
import { getNodeFeatures } from './config/node-profile.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { markForumTold, resetForumStartersCheckForTests } from './engine/forum.js';
import { resetForumDoorbellsForTests } from './engine/forum-notices.js';
import { webPushDelivery } from './engine/web-push-subscriptions.js';
import { moveMemberKeyRows } from './engine/key-move.js';
import { TABLES } from './engine/replication-manifest.js';
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

// Every push is caught here; the only other host is this machine.
const expo: any[] = [];
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).hostname;
    if (host === 'exp.host') {
        const batch = JSON.parse(init?.body ?? '[]');
        expo.push(...batch);
        return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`test-forum-notices: refused a request off this machine: ${url}`);
    return realFetch(input, init);
};

interface Id { pk: string; priv: crypto.KeyObject; name: string; token: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name, token: `ExponentPushToken[${name}-${crypto.randomBytes(9).toString('hex')}]` };
}
let owner: Id;
/** A member who joined `daysAgo` days ago, with a phone registered here. */
function member(name: string, daysAgo = 60): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, ?, 'TEST', 'active')`)
        .run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    markForumTold(id.pk);
    require_(registerPushToken(id.pk, id.token, 'android') !== 'failed', `${name}'s phone registers`);
    return id;
}

interface Res { status: number; body: any; text: string }
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = {};
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');

const front = (id: Id) => call(id, 'GET', '/api/forum');
const topic = (id: Id, t: string) => call(id, 'GET', `/api/forum/topics/${t}`);
const topics = (id: Id) => call(id, 'GET', '/api/forum/topics');
const start = (id: Id, body: Record<string, unknown>) => call(id, 'POST', '/api/forum/topics', body);
const reply = (id: Id, t: string, body: Record<string, unknown>) => call(id, 'POST', `/api/forum/topics/${t}/replies`, body);
const follow = (id: Id, t: string, f: unknown) => call(id, 'POST', `/api/forum/topics/${t}/follow`, { follow: f });
const readTo = (id: Id, t: string, upTo: number) => call(id, 'POST', `/api/forum/topics/${t}/read`, { upTo });
const setPref = (id: Id, preferences: Record<string, unknown>) => call(id, 'POST', '/api/members/preferences', { publicKey: id.pk, preferences });

/** What reached a member's phone since `from` (an index into the caught pushes), of a kind. */
const pushesTo = (id: Id, kind: string, from = 0) => expo.slice(from).filter((m) => m.to === id.token && m.data?.k === kind);
/** A member's bell rows of a kind, newest first. */
const rows = (id: Id, kind: string, unseenOnly = true) => (db.prepare(`SELECT id, title, body, data, seen_at FROM push_notices WHERE recipient = ? AND kind = ?
        ${unseenOnly ? 'AND seen_at IS NULL' : ''} ORDER BY sent_at DESC, rowid DESC`).all(id.pk, kind) as { id: string; title: string; body: string; data: string; seen_at: number | null }[])
    .map((r) => ({ ...r, data: JSON.parse(r.data) }));
/** The pushes in flight leave on the next turn (fetch is called inside the dispatcher's promise chain). */
const settle = () => new Promise((r) => setTimeout(r, 30));

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    markForumTold(owner.pk);
    const asha = member('Asha'), ben = member('Ben'), cleo = member('Cleo'), dev = member('Dev'), eve = member('Eve');
    const mo = member('Mo');
    grantNodeRole(mo.pk, 'moderator', owner.pk);

    // ── 1. Follows ──────────────────────────────────────────────────────────────────────────────
    console.log('── 1. follows ──');
    const general = (await front(asha)).body?.sections?.find((s: any) => s.starter === 'general')?.id;
    require_(general, 'the local forum has its General section');
    const started = await start(asha, { sectionId: general, title: 'Seed swap ideas', words: 'Who has beans to swap?' });
    require_(started.status === 201, `Asha starts a topic (${show(started)})`);
    const T = started.body.topic.id as string;
    const ashaRead = await topic(asha, T);
    assert(ashaRead.body?.topic?.follow === 'following' && ashaRead.body?.lastRead === 1, `who starts a topic follows it, read to their opening post (${show(ashaRead)})`);
    const benFirst = await reply(ben, T, { words: 'I have runner beans.' });
    require_(benFirst.status === 201, `Ben replies (${show(benFirst)})`);
    assert((await topic(ben, T)).body?.topic?.follow === 'following', 'who replies follows it');
    const cleoFollows = await follow(cleo, T, 'following');
    assert(cleoFollows.status === 200 && cleoFollows.body?.follow === 'following', `a reader follows it by its bell (${show(cleoFollows)})`);
    const devMutes = await follow(dev, T, 'muted');
    assert(devMutes.status === 200 && devMutes.body?.follow === 'muted', `a reader mutes it (${show(devMutes)})`);
    assert((await topic(eve, T)).body?.topic?.follow === null, 'a reader who did neither follows nothing');
    assert((await follow(eve, T, 'loudly')).status === 400, 'a follow that is none of the three is refused (400)');
    assert((await follow(eve, 'ft-nope', 'following')).status === 404, 'a topic that is not there can\'t be followed (404)');
    assert((await call(null, 'POST', `/api/forum/topics/${T}/follow`, { follow: 'following' })).status === 401, 'unsigned: 401');
    const eveOn = await follow(eve, T, 'following');
    const eveOff = await follow(eve, T, null);
    assert(eveOn.body?.follow === 'following' && eveOff.status === 200 && eveOff.body?.follow === null && (await topic(eve, T)).body?.topic?.follow === null,
        'and leaves it again with null');

    // ── 2. Ten replies make one row and one push ────────────────────────────────────────────────
    console.log('── 2. ten replies, one row, one push ──');
    db.prepare("UPDATE push_notices SET seen_at = 1 WHERE kind LIKE 'forum.%'").run();
    let mark = expo.length;
    for (let i = 1; i <= 10; i++) require_((await reply(asha, T, { words: `Swap note ${i}` })).status === 201, `Asha's reply ${i}`);
    await settle();
    for (const who of [ben, cleo]) {
        const r = rows(who, 'forum.reply');
        const p = pushesTo(who, 'forum.reply', mark);
        assert(r.length === 1 && r[0].data.topicId === T && r[0].data.count === 10 && r[0].title === 'Seed swap ideas' && /10 new replies/.test(r[0].body),
            `${who.name}: ten replies make one bell row for the topic, its count 10 (${JSON.stringify(r.map((x) => [x.title, x.body, x.data.count]))})`);
        assert(p.length === 1, `${who.name}: and one push (${p.length})`);
    }
    const one = pushesTo(ben, 'forum.reply', mark)[0];
    assert(one?.title === 'BeanPool' && one?.body === PUSH_NOTICE_KINDS['forum.reply'].body && Object.keys(one?.data ?? {}).every((k) => ['bp', 'k', 'i', 't', 'c', 's'].includes(k))
        && !JSON.stringify(one).includes('Seed swap') && !JSON.stringify(one).includes('Swap note') && !JSON.stringify(one).includes(T),
        `the push says the kind's sentence alone, its data the notice's fields (signed where the server has its node key): no title, no words, no id (${JSON.stringify(one)})`);
    assert(rows(dev, 'forum.reply', false).length === 0 && pushesTo(dev, 'forum.reply').length === 0, 'Dev, who muted it: nothing');
    assert(rows(eve, 'forum.reply', false).length === 0 && pushesTo(eve, 'forum.reply').length === 0, 'Eve, who follows nothing: nothing');
    assert(rows(asha, 'forum.reply').length === 0 && pushesTo(asha, 'forum.reply', mark).length === 0, 'Asha is never told of her own replies');
    const cleoList = await topics(cleo);
    assert(cleoList.body?.topics?.find((t: any) => t.id === T)?.unread === true, 'Cleo\'s list shows the topic unread');
    const last = (await topic(ben, T)).body?.posts?.slice(-1)[0]?.number as number;
    const benRead = await readTo(ben, T, last);
    assert(benRead.status === 200 && benRead.body?.lastRead === last && rows(ben, 'forum.reply').length === 0, `Ben opens it: his row comes off the bell (${show(benRead)})`);
    assert((await readTo(ben, T, 1)).body?.lastRead === last, 'reading an earlier post moves nothing back');
    assert((await readTo(ben, T, 9999)).body?.lastRead === last, 'nor past the last post');
    assert((await topics(ben)).body?.topics?.find((t: any) => t.id === T)?.unread === false && (await topics(cleo)).body?.topics?.find((t: any) => t.id === T)?.unread === true,
        'his unread dot goes; Cleo\'s stays');
    mark = expo.length;
    require_((await reply(asha, T, { words: 'One more' })).status === 201, 'Asha replies again');
    await settle();
    assert(rows(ben, 'forum.reply').length === 1 && rows(ben, 'forum.reply')[0].data.count === 1 && pushesTo(ben, 'forum.reply', mark).length === 1,
        'once he opened it, the next reply makes a new row and a push');
    assert(rows(cleo, 'forum.reply').length === 1 && rows(cleo, 'forum.reply')[0].data.count === 11 && pushesTo(cleo, 'forum.reply', mark).length === 0,
        'Cleo, who has not opened it: the eleventh folds in, no push');
    assert((await readTo(eve, T, 1)).status === 200, 'a reader who follows nothing may still say how far they read (nothing is kept)');

    // ── 3. A mention from one sender pushes once an hour ────────────────────────────────────────
    console.log('── 3. mentions ──');
    require_((await reply(cleo, T, { words: 'Count me in.' })).status === 201, 'Cleo replies, so she is in the topic');
    await readTo(cleo, T, 999);
    db.prepare("UPDATE push_notices SET seen_at = 1 WHERE kind LIKE 'forum.%'").run();
    mark = expo.length;
    require_((await reply(ben, T, { words: '@Cleo do you have broad beans?' })).status === 201, 'Ben mentions Cleo');
    await settle();
    assert(pushesTo(cleo, 'forum.mention', mark).length === 1 && rows(cleo, 'forum.mention').length === 1 && rows(cleo, 'forum.mention')[0].body === 'Ben mentioned you in the forum.',
        `the mention: one row and one push (${JSON.stringify(rows(cleo, 'forum.mention').map((r) => r.body))})`);
    assert(rows(cleo, 'forum.reply').length === 0 && pushesTo(cleo, 'forum.reply', mark).length === 0, 'and not the reply\'s fold as well');
    assert(rows(asha, 'forum.reply').length === 1 && pushesTo(asha, 'forum.reply', mark).length === 1, 'the other followers get the reply as usual');
    mark = expo.length;
    require_((await reply(ben, T, { words: '@cleo and runner beans?' })).status === 201, 'Ben mentions her again (any case)');
    await settle();
    assert(pushesTo(cleo, 'forum.mention', mark).length === 0 && rows(cleo, 'forum.mention').length === 1 && rows(cleo, 'forum.mention')[0].data.count === 2
        && rows(cleo, 'forum.mention')[0].body === 'Ben mentioned you 2 times in the forum.', 'a second mention from him folds into that row, no push');
    await readTo(cleo, T, 999);
    assert(rows(cleo, 'forum.mention').length === 0, 'opening the topic takes the mention off the bell');
    mark = expo.length;
    require_((await reply(ben, T, { words: 'Also @Cleo, thanks' })).status === 201, 'Ben mentions her a third time, within the hour');
    await settle();
    assert(pushesTo(cleo, 'forum.mention', mark).length === 0 && rows(cleo, 'forum.mention').length === 1, 'within the hour after his push: a new row, no push');
    db.prepare(`UPDATE push_notices SET seen_at = 1, data = json_set(data, '$.pushedAt', json_extract(data, '$.pushedAt') - 3601) WHERE recipient = ? AND kind = 'forum.mention'`).run(cleo.pk);
    mark = expo.length;
    require_((await reply(ben, T, { words: '@Cleo one more' })).status === 201, 'an hour after his push, Ben mentions her again');
    await settle();
    assert(pushesTo(cleo, 'forum.mention', mark).length === 1, 'an hour on: it pushes again');
    mark = expo.length;
    require_((await reply(asha, T, { words: '@Cleo @Ben and @Eve, welcome' })).status === 201, 'Asha mentions Cleo, Ben and Eve, who never wrote here');
    await settle();
    assert(pushesTo(cleo, 'forum.mention', mark).length === 1, 'a mention from another sender is its own: it pushes');
    assert(rows(eve, 'forum.mention', false).length === 0, 'Eve, who is not in the topic, is told nothing');
    db.prepare("UPDATE push_notices SET seen_at = 1 WHERE kind LIKE 'forum.%'").run();
    mark = expo.length;
    require_((await reply(dev, T, { words: 'Quoting that.', quotes: 1 })).status === 201, 'Dev quotes Asha\'s opening post');
    await settle();
    assert(pushesTo(asha, 'forum.mention', mark).length === 1 && rows(asha, 'forum.mention')[0]?.body === 'Dev mentioned you in the forum.', 'a quote tells the writer quoted, as a mention');

    // ── 4. A muted topic tells nothing ──────────────────────────────────────────────────────────
    console.log('── 4. muted ──');
    assert((await topic(dev, T)).body?.topic?.follow === 'muted', 'Dev\'s reply kept his mute');
    mark = expo.length;
    require_((await reply(asha, T, { words: '@Dev thanks for that' })).status === 201, 'Asha mentions Dev');
    require_((await reply(ben, T, { words: 'More news' })).status === 201, 'Ben replies');
    await settle();
    assert(rows(dev, 'forum.reply', false).length === 0 && rows(dev, 'forum.mention', false).length === 0 && expo.slice(mark).every((m) => m.to !== dev.token),
        'a muted topic tells nothing: no reply, no mention, no push');

    // ── 5. The Forum switch ─────────────────────────────────────────────────────────────────────
    console.log('── 5. the Forum switch ──');
    assert(getNodeFeatures().forumNotices === true, 'the features say forumNotices where the forum is on');
    const info = await call(null, 'GET', '/api/community/info');
    assert(info.body?.features?.forumNotices === true, `and so does the community's info (${JSON.stringify(info.body?.features?.forumNotices)})`);
    const off = await setPref(cleo, { notify_forum: false });
    assert(off.status === 200, `Cleo turns the Forum switch off (${show(off)})`);
    const prefs = await call(cleo, 'GET', `/api/members/preferences?publicKey=${cleo.pk}`);
    assert(prefs.body?.notify_forum === 'false', `her preferences say so (${show(prefs)})`);
    assert((await call(eve, 'GET', `/api/members/preferences?publicKey=${eve.pk}`)).body?.notify_forum === 'true', 'everyone else\'s is on until they turn it off');
    db.prepare("UPDATE push_notices SET seen_at = 1 WHERE kind LIKE 'forum.%'").run();
    mark = expo.length;
    require_((await reply(asha, T, { words: '@Cleo are you there?' })).status === 201, 'Asha mentions Cleo and replies');
    await settle();
    assert(rows(cleo, 'forum.reply').length === 0 && rows(cleo, 'forum.mention').length === 0 && expo.slice(mark).every((m) => m.to !== cleo.token),
        'off: nothing of the forum reaches her, bell or phone');
    assert((await setPref(cleo, { notify_forum: 'yes' })).status === 400, 'the switch is true or false (400)');
    require_((await setPref(cleo, { notify_forum: true })).status === 200, 'she turns it back on');

    // ── 6. Who may read ─────────────────────────────────────────────────────────────────────────
    console.log('── 6. blocks and a hidden topic ──');
    db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(ben.pk, dev.pk);
    db.prepare("UPDATE push_notices SET seen_at = 1 WHERE kind LIKE 'forum.%'").run();
    mark = expo.length;
    require_((await reply(dev, T, { words: 'Dev again' })).status === 201, 'Dev replies');
    await settle();
    assert(rows(ben, 'forum.reply').length === 0 && pushesTo(ben, 'forum.reply', mark).length === 0 && rows(asha, 'forum.reply').length === 1,
        'Ben, who blocked Dev, is not told of his reply; Asha is');
    const t2 = await start(asha, { sectionId: general, title: 'A topic to hide', words: 'Hello' });
    const T2 = t2.body.topic.id as string;
    require_((await reply(ben, T2, { words: 'Ben here' })).status === 201 && (await follow(mo, T2, 'following')).status === 200, 'Ben replies in it, Mo follows it');
    db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE topic_id = ? AND number = 1').run(new Date().toISOString(), T2);
    db.prepare("UPDATE push_notices SET seen_at = 1 WHERE kind LIKE 'forum.%'").run();
    mark = expo.length;
    require_((await reply(asha, T2, { words: 'Still here' })).status === 201, 'with its opening post hidden, Asha replies in her own topic');
    await settle();
    assert(rows(ben, 'forum.reply').length === 0 && pushesTo(ben, 'forum.reply', mark).length === 0, 'Ben, who reads nothing of the hidden topic, is not told');
    assert(rows(mo, 'forum.reply').length === 1, 'a moderator who follows it is');
    assert((await follow(eve, T2, 'following')).status === 404, 'nobody follows a topic they can\'t read (404)');

    // ── 7. Doorbells ────────────────────────────────────────────────────────────────────────────
    console.log('── 7. doorbells ──');
    const fay = member('Fay'), gil = member('Gil');
    const heard: Record<string, any[]> = {};
    const socket = (who: Id, opts: { forum?: boolean; visitor?: boolean } = {}) => {
        heard[who.name] = [];
        addWsClient({ _memberPubkey: who.pk, _memberFeed: !opts.visitor, _visitor: !!opts.visitor, _forum: opts.forum !== false, send: (m: string) => heard[who.name].push(JSON.parse(m)) });
    };
    socket(ben); socket(eve); socket(fay); socket(gil, { forum: false });
    const vis = newId('Vis');
    socket(vis, { visitor: true });
    const heardOf = (type: string) => Object.keys(heard).filter((k) => heard[k].some((e) => e.type === type)).sort().join(',');
    const clear = () => { for (const k of Object.keys(heard)) heard[k].length = 0; };
    db.prepare('DELETE FROM member_blocks').run();
    resetForumDoorbellsForTests();
    await topic(eve, T);
    clear();
    const bell = await reply(asha, T, { words: 'Ring' });
    require_(bell.status === 201, 'Asha replies');
    const rang = heard.Ben.find((e) => e.type === 'forum_reply');
    assert(rang?.topicId === T && rang?.number === bell.body.post.number && Object.keys(rang).sort().join() === 'number,topicId,type',
        `a follower's app hears forum_reply with the topic and number, no words (${JSON.stringify(rang)})`);
    assert(heardOf('forum_reply') === 'Ben,Eve', `the followers and who read it lately hear it; not Fay, nor an old app, nor a visitor (${heardOf('forum_reply')})`);
    assert(heardOf('forum_list') === 'Ben,Eve,Fay', `every member's app that reads the forum hears the list's doorbell; no old app, no visitor (${heardOf('forum_list')})`);
    clear();
    require_((await reply(asha, T, { words: 'Ring again' })).status === 201, 'Asha replies again at once');
    assert(heardOf('forum_reply') === 'Ben,Eve' && heardOf('forum_list') === '', `each reply rings the topic; the list at most once in 15 seconds (${heardOf('forum_list')})`);
    resetForumDoorbellsForTests();

    // ── 8. First looks ──────────────────────────────────────────────────────────────────────────
    console.log('── 8. first looks ──');
    process.env.NODE_PROFILE = 'global';
    db.prepare('DELETE FROM forum_sections').run();
    db.prepare("DELETE FROM node_config WHERE key = 'forum.startersMade'").run();
    resetForumStartersCheckForTests();
    const skills = (await front(mo)).body?.sections?.find((s: any) => s.starter === 'skills')?.id;
    require_(skills, 'the global forum has its starter sections');
    const nia = member('Nia', 1);
    require_((await setPref(owner, { notify_forum: false })).status === 200, 'Olive, an owner, has the Forum switch off');
    require_(registerPushToken(owner.pk, owner.token, 'android') !== 'failed', 'Olive\'s phone registers');
    mark = expo.length;
    const held = await start(nia, { sectionId: skills, title: 'Nia first', words: 'Hello all' });
    require_(held.status === 202, `Nia's first topic waits (${show(held)})`);
    await settle();
    assert(pushesTo(mo, 'forum.first-look', mark).length === 1 && pushesTo(mo, 'community.notice', mark).length === 0,
        'a moderator is pushed forum.first-look (no longer a community notice)');
    assert(pushesTo(owner, 'forum.first-look', mark).length === 0, 'an owner with the Forum switch off is not pushed');
    mark = expo.length;
    const ok = await call(mo, 'POST', `/api/forum/first-looks/${held.body.waiting.id}/ok`);
    require_(ok.status === 200, `Mo OKs it (${show(ok)})`);
    await settle();
    assert(pushesTo(nia, 'forum.first-look-answer', mark).length === 1, 'Nia is pushed forum.first-look-answer');
    assert((await topic(nia, ok.body.topicId)).body?.topic?.follow === 'following', 'and follows the topic it became');
    const noRow = rows(nia, 'forum.first-look-answer')[0];
    assert(noRow?.data?.topicId === ok.body.topicId && (await readTo(nia, ok.body.topicId, 1)).status === 200 && rows(nia, 'forum.first-look-answer').length === 0,
        'opening the topic takes the answer off her bell');
    delete process.env.NODE_PROFILE;

    // ── 9. The kinds ────────────────────────────────────────────────────────────────────────────
    console.log('── 9. the kinds ──');
    const KINDS = ['forum.reply', 'forum.mention', 'forum.first-look', 'forum.first-look-answer'];
    assert(KINDS.every((k) => isPushNoticeKind(k) && PUSH_NOTICE_KINDS[k as keyof typeof PUSH_NOTICE_KINDS].tab === 'chats'), 'every new kind is in the kinds table, opening the Chat tab');
    const pushSuite = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-push-notices.ts'), 'utf8');
    const prefixes = /const KIND = String\.raw`\(\?:([a-z|]+)\)/.exec(pushSuite)?.[1]?.split('|') ?? [];
    assert(prefixes.includes('forum'), `and its prefix is in the push suite's list (${prefixes.join('|')})`);
    assert(webPushDelivery('forum.reply', undefined).topic === 'forum-reply' && webPushDelivery('forum.mention', undefined).topic === 'forum-mention'
        && webPushDelivery('forum.reply', undefined).ttlSeconds === 24 * 60 * 60, 'a browser away for a while wakes to one reply and one mention, as for a chat');

    // ── 10. The standby, a new key, delete-account ──────────────────────────────────────────────
    console.log('── 10. the standby and the account ──');
    assert((TABLES as any).forum_follows?.kind === 'replicated' && (TABLES as any).forum_follows?.plain === true, 'the manifest copies forum_follows');
    const copy = await exportSyncState('test-forum-notices') as any;
    assert((copy.plainTables?.forum_follows ?? []).some((f: any) => f.member_pubkey === dev.pk && f.state === 'muted'), 'a standby\'s copy holds the follows, mutes too');
    const newBen = newId('Ben2');
    db.transaction(() => moveMemberKeyRows(ben.pk, newBen.pk, new Date().toISOString(), { keepStamps: false }))();
    assert(db.prepare('SELECT COUNT(*) FROM forum_follows WHERE member_pubkey = ?').pluck().get(newBen.pk) as number >= 2
        && db.prepare('SELECT COUNT(*) FROM forum_follows WHERE member_pubkey = ?').pluck().get(ben.pk) === 0, 'a new key takes the follows with it');
    const cleoFollowsBefore = db.prepare('SELECT COUNT(*) FROM forum_follows WHERE member_pubkey = ?').pluck().get(cleo.pk) as number;
    purgeMemberSelf(cleo.pk);
    assert(cleoFollowsBefore > 0 && !db.prepare('SELECT 1 FROM forum_follows WHERE member_pubkey = ?').get(cleo.pk)
        && !!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'forum_follows'").get(), 'delete-account takes her follows, with their tombstones');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
