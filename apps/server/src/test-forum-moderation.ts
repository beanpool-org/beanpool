/**
 * The forum's moderation, slice F2, through the real HTTPS stack and its signature middleware (scratch/fable-design/
 * DESIGN-forums-fable.md §5, §6, §21 F2 "test-forum-moderation.ts"; the joint design §2.4; Marty's answer to Q4, 14 Nov 2026).
 * "The clock" is moved by writing rows back in time (joined_at, created_at), which is all any rule reads.
 *
 *  1. Local: a forum post's report reaches the queue and hides nothing (auto-hide is off); nobody is new; no first look.
 *  2. Global, first looks: a new account's first topic answers 202 and is in no list, no read, no sync copy and no standby
 *     topic row until OK'd; one waits at a time; moderators see "Waiting for a first look (n)", are told by the bell, and
 *     read its photo; a member who is no moderator reads nothing of the list. OK makes the topic in the writer's name,
 *     marks them known (their links are links, their next topic goes up at once) and tells them; No takes a reason and
 *     tells them; the writer withdraws theirs; the one-hour edit rule holds for the OK'd topic.
 *  3. A new account's rules: its link is not a link (`linksOn` false), no photos in a reply, 2 topics and 10 replies a day
 *     (12 words: 1 and 5), and forum posts still up count as kept posts towards the end of its new-account days.
 *  4. Reports: three independent circles hide a reply ("Hidden while moderators look" to others, whole to its writer and the
 *     moderators); one circle hides a 12-words newcomer's; a report needs a post the reporter could see, not their own.
 *  5. A hidden opening post hides its topic from everyone but its writer and the moderators, and the list's tag moves.
 *  6. Settings' list names the forum post with its topic's title; a moderator restores it (its reporters told it was kept),
 *     and can't restore their own; dismissing reports shows a post once they no longer add up.
 *  7. Removal through a report: the words go, the writer hears the reason, the reporters hear it went; the third removal in
 *     30 days mutes the writer, and a muted member writes nothing in the forum.
 *  8. A burst's clean-up hides its accounts' forum posts too, and its undo brings them back.
 *  9. The standby: the new columns and tables travel; delete-account takes a waiting topic with it.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-forum-moderation" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, createPost, exportSyncState, getReports, purgeMemberSelf, broadcast, dispatchPushNotification } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { markForumTold, resetForumStartersCheckForTests } from './engine/forum.js';
import { hideBurstPosts, undoBurstHide } from './engine/burst-cleanup.js';
import { TABLES } from './engine/replication-manifest.js';
import { TEST_PHOTO, TEST_PHOTOS } from './post-test-helper.js';
import { resetPhotoBudgetForTests } from './engine/photo-upload-budget.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost, adminSigninFields } from './signed-request-test-helper.js';
import { setMemberPhoto } from '@beanpool/engine';

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
/** A member who joined `daysAgo` days ago, invited by the owner (so each is their own circle), told the forum is public. */
function member(name: string, daysAgo: number, opts: { words?: boolean } = {}): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, ?, 'TEST', 'active')`)
        .run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    // Posting a listing needs a profile photo.
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    if (opts.words) db.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash) VALUES (?, 'words', ?)`).run(id.pk, crypto.randomBytes(16).toString('hex'));
    markForumTold(id.pk);
    return id;
}
/** Off probation: two months a member, and three listings that stayed up. */
function established(name: string): Id {
    const id = member(name, 60);
    for (let i = 0; i < 3; i++) {
        const p = createPost('offer', 'other', `${name} kept ${i}`, 'kept', 0, 'fixed', id.pk, undefined, undefined, TEST_PHOTOS)!;
        db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
    }
    return id;
}

interface Res { status: number; body: any; text: string; headers: Headers }
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = { ...headers };
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
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');

/** A moderator's key session for Settings, signed in as the app does it. */
function keySession(id: Id): string {
    const chal = createAdminChallenge();
    const { signature, signedFor } = adminSigninFields(id.priv, chal.challengeId);
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: id.pk, signature, signedFor });
    if (!solved.ok) throw new Error(`no session: ${solved.error}`);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(`no session: ${ex.error}`);
    return ex.sessionId!;
}
const settings = (session: string, path: string, body?: unknown) => call(null, 'POST', path, body, { 'x-admin-session': session });

const front = (id: Id) => call(id, 'GET', '/api/forum');
const topics = (id: Id, q = '') => call(id, 'GET', `/api/forum/topics${q}`);
const topic = (id: Id, t: string) => call(id, 'GET', `/api/forum/topics/${t}`);
const start = (id: Id, body: Record<string, unknown>) => call(id, 'POST', '/api/forum/topics', body);
const reply = (id: Id, t: string, body: Record<string, unknown>) => call(id, 'POST', `/api/forum/topics/${t}/replies`, body);
const report = (id: Id, postId: string, reason = 'Spam or a scam') => call(id, 'POST', '/api/reports', { targetForumPostId: postId, reason });
const titles = (r: Res) => ((r.body?.topics ?? []) as any[]).map((t) => t.title);
const notices = (pk: string) => db.prepare('SELECT title, body, data FROM moderation_notices WHERE recipient = ? ORDER BY created_at').all(pk) as { title: string; body: string; data: string }[];
const hiddenAt = (postId: string) => (db.prepare('SELECT hidden_by_reports_at FROM forum_posts WHERE id = ?').get(postId) as { hidden_by_reports_at: string | null } | undefined)?.hidden_by_reports_at ?? null;
/** The callbacks a moderator's notices go out by (state-engine's own), for the burst's engine calls. */
const noticeCb = { broadcast: (e: any, r?: string[]) => broadcast(e, r), dispatchPushNotification: (...a: Parameters<typeof dispatchPushNotification>) => dispatchPushNotification(...a) };

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    markForumTold(owner.pk);
    const mo = member('Mo', 60);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const moSession = keySession(mo);
    const R = [1, 2, 3, 4].map((i) => established(`Rep${i}`));
    const vic = established('Vic');

    // ── 1. Local ────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. a local community ──');
    const general = (await front(vic)).body?.sections?.find((s: any) => s.starter === 'general')?.id;
    require_(general, 'the local forum has its General section');
    const lou = member('Lou', 1);
    const louTopic = await start(lou, { sectionId: general, title: 'Lou asks', words: 'See https://example.com' });
    assert(louTopic.status === 201 && louTopic.body?.post?.linksOn === true, `local: a member who joined yesterday starts a topic at once, links on (${show(louTopic)})`);
    const louPost = louTopic.body?.post?.id as string;
    for (const r of R.slice(0, 3)) assert((await report(r, louPost)).status === 200, `local: ${r.name} reports Lou's post (200)`);
    assert(hiddenAt(louPost) === null && titles(await topics(vic)).includes('Lou asks'), 'local: three established reporters hide nothing (auto-hide is off here)');
    assert(db.prepare('SELECT COUNT(*) FROM abuse_reports WHERE target_forum_post_id = ?').pluck().get(louPost) === 3, 'local: each report is on file, naming the forum post');
    const localFront = await front(lou);
    assert(localFront.body?.firstTopicWaits === false && localFront.body?.linksOn === true && localFront.body?.moderator === false,
        `local: the front says Lou's topic would not wait, links on, no moderator (${show(localFront)})`);

    // ── 2. Global: first looks ──────────────────────────────────────────────────────────────────
    console.log('── 2. global: first looks ──');
    process.env.NODE_PROFILE = 'global';
    db.prepare('DELETE FROM forum_sections').run();
    db.prepare("DELETE FROM node_config WHERE key = 'forum.startersMade'").run();
    resetForumStartersCheckForTests();
    const skills = (await front(vic)).body?.sections?.find((s: any) => s.starter === 'skills')?.id;
    require_(skills, 'the global forum has its starter sections');
    const nia = member('Nia', 1);
    const niaFront = await front(nia);
    assert(niaFront.body?.firstTopicWaits === true && niaFront.body?.linksOn === false, `a new account: the front says its topic waits and its links are plain (${show(niaFront)})`);
    const held = await start(nia, { sectionId: skills, title: 'Nia first', words: 'Hello, see www.example.org', photos: [TEST_PHOTO] });
    assert(held.status === 202 && held.body?.waiting?.title === 'Nia first' && held.body?.waiting?.photos === 1, `a new account's first topic answers 202, waiting (${show(held)})`);
    const waitingId = held.body?.waiting?.id as string;
    assert(!db.prepare("SELECT 1 FROM forum_topics WHERE title = 'Nia first'").get(), 'it is no topic row');
    assert(!titles(await topics(vic)).includes('Nia first') && !titles(await topics(mo)).includes('Nia first') && !titles(await topics(nia)).includes('Nia first'),
        'it is in no list: not a member\'s, not a moderator\'s, not its writer\'s');
    const copy1 = await exportSyncState('test-forum-moderation') as any;
    assert(!(copy1.plainTables?.forum_topics ?? []).some((t: any) => t.title === 'Nia first') && !JSON.stringify(copy1.plainTables?.forum_posts ?? []).includes('Hello, see www.example.org'),
        'a standby\'s copy holds no topic row and no post of it');
    assert((copy1.plainTables?.forum_waiting ?? []).some((w: any) => w.id === waitingId && w.state === 'waiting'), 'the waiting row itself travels, so a standby that takes over can still answer it');
    const again = await start(nia, { sectionId: skills, title: 'Nia second', words: 'Another' });
    assert(again.status === 409 && again.body?.code === 'waiting_already', `one waits at a time (${show(again)})`);
    const modFront = await front(mo);
    assert(modFront.body?.moderator === true && modFront.body?.firstLooksWaiting === 1, `a moderator's front: Waiting for a first look (1) (${show(modFront)})`);
    assert((await front(vic)).body?.firstLooksWaiting === null, 'a member who is no moderator gets no count');
    assert(notices(mo.pk).some((n) => n.title === 'A first topic is waiting for a look.') && notices(owner.pk).some((n) => n.title === 'A first topic is waiting for a look.')
        && !notices(nia.pk).some((n) => n.title === 'A first topic is waiting for a look.'), 'every moderator is told by the bell, never its words; its writer is not');
    const list = await call(mo, 'GET', '/api/forum/first-looks');
    assert(list.status === 200 && list.body?.waiting?.[0]?.id === waitingId && list.body.waiting[0].words === 'Hello, see www.example.org', `a moderator reads the waiting list (${show(list)})`);
    assert((await call(vic, 'GET', '/api/forum/first-looks')).body?.code === 'moderators_only', 'a member who is no moderator reads none of it (403 moderators_only)');
    assert((await call(mo, 'GET', `/api/forum/first-looks/${waitingId}/photos/0`)).status === 200 && (await call(vic, 'GET', `/api/forum/first-looks/${waitingId}/photos/0`)).status === 404,
        'its photo: a moderator reads it, another member gets 404');
    const mine = await call(nia, 'GET', '/api/forum/first-looks/mine');
    assert(mine.body?.waiting?.id === waitingId && 'usuallyWithinHours' in (mine.body ?? {}), `its writer reads their own waiting topic (${show(mine)})`);
    assert((await call(vic, 'POST', `/api/forum/first-looks/${waitingId}/ok`)).body?.code === 'moderators_only', 'a member who is no moderator cannot OK it');
    // OK it, an hour and a half after it was written.
    db.prepare('UPDATE forum_waiting SET created_at = ? WHERE id = ?').run(ago(90 * 60 * 1000), waitingId);
    const ok = await call(mo, 'POST', `/api/forum/first-looks/${waitingId}/ok`);
    require_(ok.status === 200 && typeof ok.body?.topicId === 'string', `a moderator OKs it (${show(ok)})`);
    const niaTopicId = ok.body.topicId as string;
    const niaRead = await topic(vic, niaTopicId);
    assert(niaRead.status === 200 && niaRead.body?.topic?.writer?.publicKey === nia.pk && niaRead.body?.posts?.[0]?.photos === 1 && niaRead.body?.posts?.[0]?.linksOn === true,
        `the topic is up in Nia's name, its photo moved, and as she is known now its links are links (${show(niaRead)})`);
    assert(titles(await topics(vic)).includes('Nia first'), 'it is listed now');
    assert(notices(nia.pk).some((n) => n.title === 'Your first topic has an answer.' && n.body.includes('Nia first') && !n.body.includes('Mo')), 'Nia is told, never who answered');
    const edit = await call(nia, 'POST', `/api/forum/posts/${niaRead.body?.posts?.[0]?.id}/edit`, { words: 'Swapped for an advert' });
    assert(edit.status === 403 && edit.body?.code === 'edit_window', `the OK'd topic can't be swapped: her account is new and it was written over an hour ago (${show(edit)})`);
    const niaNext = await start(nia, { sectionId: skills, title: 'Nia next', words: 'Known now' });
    assert(niaNext.status === 201, `known, her next topic goes up at once (${show(niaNext)})`);
    // No, and withdraw.
    const ned = member('Ned', 1);
    const nedHeld = await start(ned, { sectionId: skills, title: 'Ned sells', words: 'Buy now' });
    require_(nedHeld.status === 202, 'Ned\'s first topic waits');
    assert((await call(mo, 'POST', `/api/forum/first-looks/${nedHeld.body.waiting.id}/no`, { reason: 'whatever' })).body?.code === 'reason_required', 'No needs one of the five reasons');
    assert((await call(mo, 'POST', `/api/forum/first-looks/${nedHeld.body.waiting.id}/no`, { reason: 'spam' })).status === 200, 'a moderator says No, spam');
    assert(notices(ned.pk).some((n) => n.title === 'Your first topic has an answer.' && n.body.includes('spam or a scam')), 'Ned hears it, with the reason');
    assert(!db.prepare("SELECT 1 FROM forum_topics WHERE title = 'Ned sells'").get(), 'no topic was made');
    const ola = member('Ola', 1);
    const olaHeld = await start(ola, { sectionId: skills, title: 'Ola maybe', words: 'Hmm' });
    assert((await call(vic, 'POST', `/api/forum/first-looks/${olaHeld.body?.waiting?.id}/withdraw`)).status === 404, 'only its writer withdraws it');
    assert((await call(ola, 'POST', `/api/forum/first-looks/${olaHeld.body?.waiting?.id}/withdraw`)).status === 200
        && (await front(mo)).body?.firstLooksWaiting === 0, 'Ola withdraws hers; nothing waits now');

    // ── 3. A new account's rules ───────────────────────────────────────────────────────────────
    console.log('── 3. a new account\'s rules ──');
    const pia = member('Pia', 1);
    const piaReply = await reply(pia, niaTopicId, { words: 'Try https://spam.example' });
    assert(piaReply.status === 201 && piaReply.body?.post?.linksOn === false, `a new account replies at once, and its link is not a link (${show(piaReply)})`);
    assert((await topic(vic, niaTopicId)).body?.posts?.find((p: any) => p.id === piaReply.body?.post?.id)?.linksOn === false, 'read by anyone, its link is still plain text');
    resetPhotoBudgetForTests();
    const piaPhoto = await reply(pia, niaTopicId, { words: 'Look', photos: [TEST_PHOTO] });
    assert(piaPhoto.status === 403 && piaPhoto.body?.code === 'new_no_photos', `no photos in a new account's reply (${show(piaPhoto)})`);
    const repliesBy = async (who: Id, n: number) => { const s: number[] = []; for (let i = 0; i < n; i++) s.push((await reply(who, niaTopicId, { words: `${who.name} ${i}` })).status); return s; };
    const piaMore = await repliesBy(pia, 10);
    assert(piaMore.slice(0, 9).every((s) => s === 201) && piaMore[9] === 429, `a new account: 10 replies in any 24 hours, the 11th refused (${piaMore.join(',')})`);
    const wes = member('Wes', 1, { words: true });
    const wesMore = await repliesBy(wes, 6);
    assert(wesMore.slice(0, 5).every((s) => s === 201) && wesMore[5] === 429, `a 12-words account: 5 (${wesMore.join(',')})`);
    // Kept posts: a member three days and more in, with three forum posts still up, is off probation and known.
    const kai = member('Kai', 4);
    assert((await front(kai)).body?.linksOn === false, 'Kai, four days in with no posts, is still new');
    await repliesBy(kai, 3);
    const kaiFront = await front(kai);
    assert(kaiFront.body?.linksOn === true && kaiFront.body?.firstTopicWaits === false, `three forum posts still up count as kept posts: Kai is known (${show(kaiFront)})`);

    // ── 4. Reports and auto-hide ───────────────────────────────────────────────────────────────
    console.log('── 4. reports hide a reply ──');
    const ava = member('Ava', 30);
    const avaReply = await reply(ava, niaTopicId, { words: 'Ava says something rude' });
    require_(avaReply.status === 201, 'Ava replies');
    const avaPost = avaReply.body.post.id as string;
    assert((await report(ava, avaPost)).body?.error === 'own_post', 'nobody reports their own post');
    assert((await call(vic, 'POST', '/api/reports', { targetForumPostId: avaPost, targetPostId: 'x', reason: 'Spam' })).body?.error === 'forum_report_names_more', 'a forum post\'s report names nothing else');
    assert((await report(vic, 'fp-nothere')).status === 404, 'a forum post that is not here: 404');
    const r1 = await report(R[0], avaPost);
    assert(r1.status === 200 && r1.body?.report?.targetPubkey === ava.pk, `a report on a forum post is about its writer (${show(r1)})`);
    assert((await report(R[0], avaPost)).body?.duplicate === true, 'the same reporter again adds nothing');
    await report(R[1], avaPost);
    assert(hiddenAt(avaPost) === null, 'two circles hide nothing');
    await report(R[2], avaPost);
    assert(hiddenAt(avaPost) !== null, 'three independent circles hide the reply');
    const seenByVic = (await topic(vic, niaTopicId)).body?.posts?.find((p: any) => p.id === avaPost);
    assert(seenByVic?.hidden === true && seenByVic.words === '' && seenByVic.photos === 0, `another member reads its place, hidden, no words (${JSON.stringify(seenByVic)})`);
    const seenByAva = (await topic(ava, niaTopicId)).body?.posts?.find((p: any) => p.id === avaPost);
    const seenByMo = (await topic(mo, niaTopicId)).body?.posts?.find((p: any) => p.id === avaPost);
    assert(seenByAva?.words === 'Ava says something rude' && seenByAva.hidden === true && seenByMo?.words === 'Ava says something rude', 'its writer and a moderator still read it, marked hidden');
    assert(notices(ava.pk).some((n) => n.title === '🛡️ Your forum post is hidden for review'), 'Ava is told it is hidden');
    assert((await report(R[3], avaPost)).status === 404, 'hidden, it can\'t be reported by a member who no longer sees it (404)');
    // A 12-words newcomer: one circle.
    const wesPost = db.prepare("SELECT id FROM forum_posts WHERE writer_pubkey = ? ORDER BY number LIMIT 1").pluck().get(wes.pk) as string;
    await report(R[0], wesPost);
    assert(hiddenAt(wesPost) !== null, 'one circle hides a 12-words newcomer\'s reply');

    // ── 5. A hidden opening post hides its topic ───────────────────────────────────────────────
    console.log('── 5. a hidden opening post ──');
    const bea = established('Bea');
    const beaTopic = await start(bea, { sectionId: skills, title: 'Bea spam topic', words: 'Spam' });
    require_(beaTopic.status === 201, `Bea, off probation, starts a topic at once (${show(beaTopic)})`);
    const beaOpening = beaTopic.body?.post?.id as string;
    const tagBefore = (await topics(vic)).headers.get('etag');
    for (const r of R.slice(0, 3)) await report(r, beaOpening);
    assert(hiddenAt(beaOpening) !== null, 'three circles hide the opening post');
    const vicList = await topics(vic, '');
    assert(!titles(vicList).includes('Bea spam topic') && vicList.headers.get('etag') !== tagBefore, 'the topic is out of another member\'s list, and the list\'s tag moved');
    assert((await topic(vic, beaTopic.body.topic.id)).status === 404, 'another member reads it as not found');
    assert(titles(await topics(bea)).includes('Bea spam topic') && titles(await topics(mo)).includes('Bea spam topic'), 'its writer and a moderator still list it');
    assert((await topic(mo, beaTopic.body.topic.id)).body?.topic?.hidden === true, 'marked hidden for them');
    assert((await reply(vic, beaTopic.body.topic.id, { words: 'me too' })).status === 404, 'nobody else replies to it');
    // A reply someone wrote before it hid is still theirs to remove while the topic is hidden.
    const vicEarlier = db.prepare('INSERT INTO forum_posts (id, topic_id, number, writer_pubkey, words, created_at) VALUES (?, ?, 2, ?, ?, ?)')
        .run('fp-vic-earlier', beaTopic.body.topic.id, vic.pk, 'Vic replied before', new Date().toISOString());
    assert(vicEarlier.changes === 1 && (await call(vic, 'POST', '/api/forum/posts/fp-vic-earlier/remove')).status === 200,
        'a reply written before the hide is still its writer\'s to remove');

    // ── 6. Settings: the list, restore, dismiss ────────────────────────────────────────────────
    console.log('── 6. Settings ──');
    const queue = getReports('pending');
    const avaRow = queue.reports.find((r) => r.targetForumPostId === avaPost);
    assert(avaRow?.forumPost?.topicTitle === 'Nia first' && avaRow.forumPost.words === 'Ava says something rude' && avaRow.forumPost.hidden === true && avaRow.targetPubkey === ava.pk,
        `Settings' list names the forum post with its topic's title (${JSON.stringify(avaRow?.forumPost)})`);
    const restored = await settings(moSession, `/api/local/admin/forum/posts/${avaPost}/restore`);
    assert(restored.status === 200 && hiddenAt(avaPost) === null, `a moderator restores it (${show(restored)})`);
    assert(notices(R[0].pk).some((n) => n.body === 'The post you reported was reviewed and kept.') && notices(ava.pk).some((n) => n.title === '🛡️ Your forum post is back'),
        'its reporters hear it was kept; Ava hears it is back');
    assert((await settings(moSession, `/api/local/admin/forum/posts/${avaPost}/restore`)).status === 409, 'not hidden: nothing to restore');
    for (const r of R.slice(0, 3)) await report(r, avaPost);
    assert(hiddenAt(avaPost) === null, 'the same reporters can\'t hide it again');
    assert((await report(R[3], avaPost)).status === 200 && hiddenAt(avaPost) === null, 'a new reporter may report it again: one circle hides nothing');
    // Dismiss: Bea's opening post shows again once the rest no longer add up.
    const beaReports = getReports('pending').reports.filter((r) => r.targetForumPostId === beaOpening);
    assert((await settings(moSession, `/api/local/admin/reports/${beaReports[0].id}/dismiss`)).status === 200 && hiddenAt(beaOpening) === null
        && titles(await topics(vic)).includes('Bea spam topic'), 'one report dismissed: two circles left, the topic is back in the list');
    // A moderator's own forum post.
    const moTopic = await start(mo, { sectionId: skills, title: 'Mo posts', words: 'From a moderator' });
    db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), moTopic.body?.post?.id);
    assert((await settings(moSession, `/api/local/admin/forum/posts/${moTopic.body?.post?.id}/restore`)).status === 403, 'a moderator can\'t restore their own forum post');

    // ── 7. Removal through a report, and the mute ──────────────────────────────────────────────
    console.log('── 7. removal and the mute ──');
    const avaReport = getReports('pending').reports.find((r) => r.targetForumPostId === avaPost && r.reporterPubkey === R[3].pk);
    require_(avaReport, 'a report on Ava\'s reply is open');
    const removed = await settings(moSession, `/api/local/admin/reports/${avaReport!.id}/action`, { deletePost: true, reasonCategory: 'offensive' });
    assert(removed.status === 200, `a moderator removes it through the report (${show(removed)})`);
    const avaRemoved = db.prepare('SELECT words, removed_by FROM forum_posts WHERE id = ?').get(avaPost) as { words: string; removed_by: string };
    assert(avaRemoved.words === '' && avaRemoved.removed_by === 'moderator', 'its words are gone, removed by a moderator');
    assert(notices(ava.pk).some((n) => n.title === '🛡️ Your forum post was removed' && n.body.includes('Reason: offensive content.') && n.body.includes('Nia first')), 'Ava hears it, with the reason');
    assert(notices(R[3].pk).some((n) => n.body === 'The post you reported was removed. Thank you for letting the moderators know.'), 'the reporter hears it went');
    assert((await report(vic, avaPost)).status === 404, 'a removed post can\'t be reported');
    const removeOne = async (words: string) => {
        const p = await reply(ava, niaTopicId, { words });
        await report(R[3], p.body.post.id);
        const rep = getReports('pending').reports.find((r) => r.targetForumPostId === p.body.post.id)!;
        return settings(moSession, `/api/local/admin/reports/${rep.id}/action`, { deletePost: true, reasonCategory: 'spam' });
    };
    await removeOne('Ava again');
    assert(!(db.prepare('SELECT moderation_muted_until FROM members WHERE public_key = ?').pluck().get(ava.pk)), 'two removals: not muted');
    await removeOne('Ava a third time');
    assert(!!db.prepare('SELECT moderation_muted_until FROM members WHERE public_key = ?').pluck().get(ava.pk), 'the third forum removal in 30 days mutes her');
    const muted = await reply(ava, niaTopicId, { words: 'still here' });
    assert(muted.status === 403 && muted.body?.code === 'moderation_muted', `a muted member writes nothing in the forum (${show(muted)})`);
    // An opening post with nobody else's reply: gone, and its writer's own replies go with it as one removal.
    const cal = established('Cal');
    const calTopic = await start(cal, { sectionId: skills, title: 'Cal spam', words: 'Spam' });
    for (const w of ['bump 1', 'bump 2']) await reply(cal, calTopic.body.topic.id, { words: w });
    await report(R[3], calTopic.body.post.id);
    const calRep = getReports('pending').reports.find((r) => r.targetForumPostId === calTopic.body.post.id)!;
    await settings(moSession, `/api/local/admin/reports/${calRep.id}/action`, { deletePost: true, reasonCategory: 'spam' });
    assert(db.prepare('SELECT closed_by FROM forum_topics WHERE id = ?').pluck().get(calTopic.body.topic.id) === 'removed' && (await topic(vic, calTopic.body.topic.id)).status === 404,
        'an opening post removed with nobody else\'s reply: the topic is gone');
    assert(!(db.prepare('SELECT moderation_muted_until FROM members WHERE public_key = ?').pluck().get(cal.pk)), 'its writer\'s own replies under it went with it as one removal, not three: no mute');

    // ── 8. Bursts ──────────────────────────────────────────────────────────────────────────────
    console.log('── 8. a burst\'s clean-up ──');
    const b1 = member('Burst1', 1), b2 = member('Burst2', 1);
    const b1Reply = (await reply(b1, niaTopicId, { words: 'burst one' })).body?.post?.id as string;
    const b2Reply = (await reply(b2, niaTopicId, { words: 'burst two' })).body?.post?.id as string;
    const hide = hideBurstPosts(noticeCb, b1.pk, [b1.pk, b2.pk], 'moderator');
    assert(hide.posts === 2 && hiddenAt(b1Reply) !== null && hiddenAt(b2Reply) !== null, `a burst hide takes their forum posts too (${JSON.stringify(hide)})`);
    const undo = undoBurstHide(noticeCb, hide.id);
    assert(undo.ok && hiddenAt(b1Reply) === null && hiddenAt(b2Reply) === null, `its undo brings them back (${JSON.stringify(undo)})`);

    // ── 9. The standby, and delete-account ─────────────────────────────────────────────────────
    console.log('── 9. the standby ──');
    const T = TABLES as any;
    assert(['forum_waiting', 'forum_waiting_photos'].every((t) => T[t]?.kind === 'replicated' && T[t]?.plain === true) && T.burst_action_forum_posts?.kind === 'local',
        'the manifest classes the new tables');
    const copy2 = await exportSyncState('test-forum-moderation') as any;
    assert((copy2.abuseReports ?? []).some((r: any) => r.targetForumPostId === avaPost), 'a report\'s forum post travels to the standby');
    assert((copy2.plainTables?.forum_posts ?? []).some((p: any) => p.id === beaOpening && 'hidden_by_reports_at' in p)
        && (copy2.plainTables?.forum_members ?? []).some((m: any) => m.member_pubkey === nia.pk && m.known_at), 'the hidden stamp and "known since" travel');
    const una = member('Una', 1);
    const unaHeld = await start(una, { sectionId: skills, title: 'Una waits', words: 'Hello' });
    require_(unaHeld.status === 202, 'Una\'s first topic waits');
    purgeMemberSelf(una.pk);
    assert(!db.prepare('SELECT 1 FROM forum_waiting WHERE writer_pubkey = ?').get(una.pk) && !!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'forum_waiting' AND row_key = ?").get(unaHeld.body.waiting.id),
        'delete-account takes her waiting topic, with its tombstone');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
