/**
 * The forum, slice F1, through the real HTTPS stack and its signature middleware (scratch/fable-design/DESIGN-forums-fable.md
 * §2 to §4, §16, §20, §21 F1 "test-forum.ts"; Marty's answers to Q3 and Q4, 14 Nov 2026).
 *
 *  1. A local community's forum is on from the start with its two starter sections, made once.
 *  2. A non-member reads nothing and writes nothing; unsigned is 401.
 *  3. Topics list pinned first, then the newest activity; a reply moves its topic up.
 *  4. Pins: owners and admins only, 2 a section. Move: owners and admins, to a section that is there.
 *  5. A closed topic refuses a reply; its writer, an owner or an admin closes it, nobody else.
 *  6. Edit: the writer only, the earlier wording kept for moderators; the form's limits (title, words, links, mentions).
 *  7. Remove: a reply leaves a marker; an opening post with others' replies blanks the topic and keeps them; with none the
 *     topic is gone from every list and read.
 *  8. Sections: owners and admins make, rename and archive them, 12 at most; a staff section takes topics from staff only.
 *  9. Daily limits: 10 topics and 100 replies in any 24 hours, removed ones counted; owners and admins the owners' number.
 * 10. A muted member writes nothing; a paused one reads but writes nothing.
 * 11. Blocks: a member never sees topics or posts by someone they blocked.
 * 12. Photos: kept in the row, served to members only, deleted with the post.
 * 13. List versions: an unchanged list answers 304; a change answers the new list.
 * 14. A public forum (the global community's switch): a first post without the told stamp is refused; told once, it posts.
 * 15. The owners' off-switch (How this community works): every route 404 feature_off, members told, topics kept; on again.
 * 16. A standby: the manifest classes every forum table; the copy holds them; every write 503 `standby`; reads answer.
 * 17. Delete account and removal by the community leave none of the member's words on the main server or in what a standby
 *     is sent; a re-key moves their rows.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-forum" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast, exportSyncState, adminPruneUser, purgeMemberSelf, setUserStatusRow, COMMUNITY_DECISION_ACTOR } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { NODE_PROFILE_KEY, getNodeFeatures } from './config/node-profile.js';
import { ownerPhoneSessionHeaders, ownerSessionHeaders } from './admin-auth-test-harness.js';
import { registerMemberInternal } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { TABLES } from './engine/replication-manifest.js';
import { moveMemberKeyRows } from './engine/key-move.js';
import { FORUM_STARTERS_MADE_KEY, resetForumStartersCheckForTests, tidyForumEdits } from './engine/forum.js';
import { resetPhotoBudgetForTests } from './engine/photo-upload-budget.js';
import { TEST_PHOTO } from './post-test-helper.js';
import { setAgentPostsPerDay } from './agent/limits.js';
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

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
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
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 200)}` : '-');

const front = (id: Id) => call(id, 'GET', '/api/forum');
const topics = (id: Id, q = '') => call(id, 'GET', `/api/forum/topics${q}`);
const topic = (id: Id, t: string, q = '') => call(id, 'GET', `/api/forum/topics/${t}${q}`);
const start = (id: Id, body: Record<string, unknown>) => call(id, 'POST', '/api/forum/topics', body);
const reply = (id: Id, t: string, body: Record<string, unknown>) => call(id, 'POST', `/api/forum/topics/${t}/replies`, body);
const titles = (r: Res) => ((r.body?.topics ?? []) as any[]).map((t) => t.title);
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);
const tombstone = (table: string, key: string) => !!db.prepare('SELECT 1 FROM tombstones WHERE table_name = ? AND row_key = ?').get(table, key);
const FORUM_TABLES = ['forum_sections', 'forum_topics', 'forum_posts', 'forum_post_photos', 'forum_post_edits', 'forum_members'];

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community: its first member');
    grantNodeRole(owen.pk, 'owner', claim);
    const [ada, mod, mel, pat, gus, sue] = ['Ada', 'Mod', 'Mel', 'Pat', 'Gus', 'Sue'].map(newId);
    for (const who of [ada, mod, mel, pat, gus, sue]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[ada, 'admin'], [mod, 'moderator']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, ownerPhoneSessionHeaders(owen.pk))).status === 200, `${who.name} is made ${role}`);
    }
    const stranger = newId('Stranger');

    // ── 1. On from the start, two starter sections, made once ─────────────────────────────────────
    console.log('── 1. starter sections ──');
    assert(getNodeFeatures().forum === true && !('forumPublic' in getNodeFeatures()), '1. a local community says it has a forum, not a public one');
    const f1 = await front(mel);
    const sections = (f1.body?.sections ?? []) as any[];
    assert(f1.status === 200 && sections.map((s) => s.starter).join() === 'general,ideas-local' && sections.every((s) => s.name === null && s.starts === 'members' && !s.listed && !s.archived)
        && f1.body?.public === false && f1.body?.told === false, `1. General and Ideas for our community, members start topics, not public (${show(f1)})`);
    const general = sections[0]?.id as string;
    const ideas = sections[1]?.id as string;
    resetForumStartersCheckForTests();
    await front(owen);
    assert((db.prepare('SELECT COUNT(*) AS n FROM forum_sections').get() as { n: number }).n === 2 && !!db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(FORUM_STARTERS_MADE_KEY),
        '1. read again, none is made twice, and the marker is kept');

    // ── 2. A non-member reads nothing ─────────────────────────────────────────────────────────────
    console.log('── 2. a non-member ──');
    const t0 = await start(mel, { sectionId: general, title: 'Seed swap at the hall', words: 'Bring seeds in paper bags.', place: 'The hall', lang: 'fr' });
    const seed = t0.body?.topic?.id as string;
    assert(t0.status === 201 && t0.body?.topic?.title === 'Seed swap at the hall' && t0.body?.topic?.writer?.name === 'Mel' && t0.body?.topic?.place === 'The hall'
        && t0.body?.post?.number === 1 && t0.body?.post?.words === 'Bring seeds in paper bags.' && t0.body?.post?.lang === 'fr', `2. Mel starts a topic: 201 (${show(t0)})`);
    const strangerReads = [await front(stranger), await topics(stranger), await topic(stranger, seed), await call(stranger, 'GET', `/api/forum/posts/${t0.body?.post?.id}/photos/0`)];
    assert(strangerReads.every((r) => r.status === 403 && !r.text.includes('Seed swap')),
        `2. a stranger's every read: 403, no words (${strangerReads.map((r) => `${r.status} ${r.body?.code}`).join()})`);
    const strangerWrites = [await start(stranger, { sectionId: general, title: 'x', words: 'y' }), await reply(stranger, seed, { words: 'hi' }), await call(stranger, 'POST', '/api/forum/told', {})];
    assert(strangerWrites.every((r) => r.status === 403), `2. and every write: 403 (${strangerWrites.map((r) => r.status).join()})`);
    const unsigned = [await call(null, 'GET', '/api/forum'), await call(null, 'GET', `/api/forum/topics/${seed}`)];
    assert(unsigned.every((r) => (r.status === 401 || r.status === 403) && !r.text.includes('Seed swap')), `2. unsigned: refused, no words (${unsigned.map((r) => r.status).join()})`);

    // ── 3. Newest activity first ──────────────────────────────────────────────────────────────────
    console.log('── 3. newest activity first ──');
    const tb = (await start(pat, { sectionId: general, title: 'Bike repair Saturdays', words: 'Who has a pump?' })).body?.topic?.id as string;
    const tc = (await start(gus, { sectionId: ideas, title: 'A tool library', words: 'Shall we start one?' })).body?.topic?.id as string;
    let list = await topics(sue);
    assert(list.status === 200 && titles(list).join('|') === 'A tool library|Bike repair Saturdays|Seed swap at the hall', `3. the newest first, across sections (${titles(list).join('|')})`);
    const r1 = await reply(pat, seed, { words: 'I will bring beans.' });
    assert(r1.status === 201 && r1.body?.post?.number === 2 && r1.body?.post?.writer?.name === 'Pat', `3. Pat replies: post 2 (${show(r1)})`);
    list = await topics(sue);
    assert(titles(list)[0] === 'Seed swap at the hall' && list.body?.topics?.[0]?.replyCount === 1, `3. a reply moves its topic to the top (${titles(list).join('|')})`);
    const inGeneral = await topics(sue, `?section=${general}`);
    assert(titles(inGeneral).join('|') === 'Seed swap at the hall|Bike repair Saturdays', `3. one section's list holds its own (${titles(inGeneral).join('|')})`);
    assert((await topics(sue, '?section=nope')).status === 404, '3. a section that is not there: 404');

    // ── 4. Pins and moves ─────────────────────────────────────────────────────────────────────────
    console.log('── 4. pins and moves ──');
    const memberPin = await call(mel, 'POST', `/api/forum/topics/${tb}/pin`, { pinned: true });
    const modPin = await call(mod, 'POST', `/api/forum/topics/${tb}/pin`, { pinned: true });
    assert(memberPin.status === 403 && memberPin.body?.code === 'staff_only' && modPin.status === 403, `4. a member and a moderator can't pin (${memberPin.status}, ${modPin.status})`);
    const pinned = await call(ada, 'POST', `/api/forum/topics/${tb}/pin`, { pinned: true });
    list = await topics(sue, `?section=${general}`);
    assert(pinned.status === 200 && pinned.body?.topic?.pinned === true && titles(list)[0] === 'Bike repair Saturdays', `4. an admin pins it: first in its section though older (${titles(list).join('|')})`);
    const extra = (await start(sue, { sectionId: general, title: 'Third topic', words: 'words' })).body?.topic?.id as string;
    const extra2 = (await start(sue, { sectionId: general, title: 'Fourth topic', words: 'words' })).body?.topic?.id as string;
    assert((await call(owen, 'POST', `/api/forum/topics/${extra}/pin`, { pinned: true })).status === 200, '4. a second pin');
    const third = await call(owen, 'POST', `/api/forum/topics/${extra2}/pin`, { pinned: true });
    assert(third.status === 409 && third.body?.code === 'too_many_pins', `4. a third in one section: 409 (${show(third)})`);
    const moved = await call(owen, 'POST', `/api/forum/topics/${extra}/move`, { sectionId: ideas });
    assert(moved.status === 200 && moved.body?.topic?.sectionId === ideas && moved.body?.topic?.pinned === true, `4. the owner moves a pinned topic to a section with room: pinned there (${show(moved)})`);
    const badMove = [await call(owen, 'POST', `/api/forum/topics/${extra}/move`, { sectionId: ideas }), await call(owen, 'POST', `/api/forum/topics/${extra}/move`, { sectionId: 'nope' }),
        await call(mel, 'POST', `/api/forum/topics/${extra}/move`, { sectionId: general })];
    assert(badMove[0].status === 409 && badMove[1].status === 404 && badMove[2].status === 403, `4. to its own section 409, nowhere 404, by a member 403 (${badMove.map((r) => r.status).join()})`);
    assert((await call(owen, 'POST', `/api/forum/topics/${extra}/pin`, { pinned: false })).body?.topic?.pinned === false, '4. unpinned');

    // ── 5. Closed ─────────────────────────────────────────────────────────────────────────────────
    console.log('── 5. closed ──');
    const notWriter = await call(pat, 'POST', `/api/forum/topics/${tc}/close`, {});
    assert(notWriter.status === 403 && notWriter.body?.code === 'not_yours', `5. Pat can't close Gus's topic (${show(notWriter)})`);
    const closed = await call(gus, 'POST', `/api/forum/topics/${tc}/close`, {});
    assert(closed.status === 200 && closed.body?.topic?.closed === 'writer', `5. Gus closes his own (${show(closed)})`);
    const late = await reply(pat, tc, { words: 'Too late?' });
    assert(late.status === 409 && late.body?.code === 'closed' && (await topic(sue, tc)).body?.topic?.replyCount === 0, `5. a closed topic refuses a reply (${show(late)})`);
    assert((await call(gus, 'POST', `/api/forum/topics/${tc}/close`, {})).body?.code === 'already_closed', '5. closed twice: already_closed');
    const byOwner = await call(owen, 'POST', `/api/forum/topics/${extra2}/close`, {});
    assert(byOwner.body?.topic?.closed === 'moderator', `5. an owner closes another's: by a moderator (${show(byOwner)})`);
    assert((await topic(sue, tc)).status === 200, '5. a closed topic still reads');

    // ── 6. Edit and the form's limits ─────────────────────────────────────────────────────────────
    console.log('── 6. edit ──');
    const openingId = t0.body?.post?.id as string;
    const edited = await call(mel, 'POST', `/api/forum/posts/${openingId}/edit`, { words: 'Bring seeds in paper bags, labelled.', title: 'Seed swap at the old hall' });
    assert(edited.status === 200 && edited.body?.post?.editedAt && edited.body?.topic?.title === 'Seed swap at the old hall' && edited.body?.post?.words === 'Bring seeds in paper bags, labelled.',
        `6. Mel edits her opening post and title (${show(edited)})`);
    const kept = db.prepare('SELECT words, title FROM forum_post_edits WHERE post_id = ?').get(openingId) as { words: string; title: string } | undefined;
    assert(kept?.words === 'Bring seeds in paper bags.' && kept?.title === 'Seed swap at the hall', '6. the wording before is kept, with the title before');
    const notHers = await call(pat, 'POST', `/api/forum/posts/${openingId}/edit`, { words: 'Mine now' });
    assert(notHers.status === 403 && notHers.body?.code === 'not_yours', `6. Pat can't edit it (${show(notHers)})`);
    const limits = [
        await start(sue, { sectionId: general, title: '', words: 'x' }),
        await start(sue, { sectionId: general, title: 'x'.repeat(101), words: 'x' }),
        await start(sue, { sectionId: general, title: 'ok', words: 'x'.repeat(5001) }),
        await reply(sue, seed, { words: 'x'.repeat(3001) }),
        await reply(sue, seed, { words: 'https://a.example '.repeat(6) }),
        await reply(sue, seed, { words: '@a @b @c @d @e @f' }),
        await reply(sue, seed, { words: 'quote', quotes: 99 }),
        await start(sue, { sectionId: general, title: 'ok', words: 'ok', place: 'p'.repeat(81) }),
    ];
    assert(limits.map((r) => r.body?.code).join() === 'title_required,too_long,too_long,too_long,too_many_links,too_many_mentions,bad_quote,too_long' && limits.every((r) => r.status === 400),
        `6. no title, a title over 100, words over 5,000, a reply over 3,000, 6 links, 6 mentions, a quote of nothing, a place over 80: 400 (${limits.map((r) => r.body?.code).join()})`);
    const quoting = await reply(sue, seed, { words: 'Agreed!', quotes: 2 });
    assert(quoting.status === 201 && quoting.body?.post?.quotes === 2, `6. a reply quoting post 2 (${show(quoting)})`);
    db.prepare("UPDATE forum_post_edits SET edited_at = '2026-01-01T00:00:00.000Z' WHERE post_id = ?").run(openingId);
    assert(tidyForumEdits() >= 1 && !db.prepare('SELECT 1 FROM forum_post_edits WHERE post_id = ?').get(openingId), '6. the wording before goes 30 days after');

    // ── 7. Remove ─────────────────────────────────────────────────────────────────────────────────
    console.log('── 7. remove ──');
    const patReply = r1.body?.post?.id as string;
    const rm = await call(pat, 'POST', `/api/forum/posts/${patReply}/remove`, {});
    let read = await topic(sue, seed);
    const marker = (read.body?.posts as any[])?.find((p) => p.id === patReply);
    assert(rm.status === 200 && marker?.removed === 'writer' && marker?.words === '' && read.body?.topic?.replyCount === 1 && !read.text.includes('I will bring beans'),
        `7. Pat's reply: a marker, its words gone, the count down (${show(read)})`);
    assert((await call(pat, 'POST', `/api/forum/posts/${patReply}/remove`, {})).status === 404, '7. removed twice: 404');
    const rmOpening = await call(mel, 'POST', `/api/forum/posts/${openingId}/remove`, {});
    read = await topic(sue, seed);
    assert(rmOpening.status === 200 && read.status === 200 && read.body?.topic?.title === '' && read.body?.topic?.removed === true && read.body?.topic?.closed === 'writer'
        && (read.body?.posts as any[]).some((p) => p.words === 'Agreed!') && !read.text.includes('Bring seeds'),
        `7. Mel removes her opening post with others' replies: blanked, closed, the replies stay (${show(read)})`);
    const lone = await start(sue, { sectionId: ideas, title: 'A lonely idea', words: 'Nobody answers this.' });
    await reply(sue, lone.body?.topic?.id, { words: 'Bump.' });
    assert((await call(sue, 'POST', `/api/forum/posts/${lone.body?.post?.id}/remove`, {})).status === 200, '7. Sue removes a topic nobody else replied to');
    const goneRead = await topic(sue, lone.body?.topic?.id);
    assert(goneRead.status === 404 && !titles(await topics(owen)).includes('A lonely idea') && !(db.prepare("SELECT 1 FROM forum_posts WHERE topic_id = ? AND words != ''").get(lone.body?.topic?.id)),
        `7. gone: 404, in no list, and her reply under it blanked too (${goneRead.status})`);

    // ── 8. Sections ───────────────────────────────────────────────────────────────────────────────
    console.log('── 8. sections ──');
    const memberSection = await call(mel, 'POST', '/api/forum/sections', { name: 'Mine' });
    assert(memberSection.status === 403 && memberSection.body?.code === 'staff_only', `8. a member can't make a section (${show(memberSection)})`);
    const news = await call(ada, 'POST', '/api/forum/sections', { name: 'Notices', about: 'From the admins', starts: 'staff' });
    assert(news.status === 201 && news.body?.section?.name === 'Notices' && news.body?.section?.starts === 'staff' && news.body?.section?.position === 2, `8. an admin makes a staff section, last (${show(news)})`);
    const staffOnly = await start(mel, { sectionId: news.body?.section?.id, title: 'Can I?', words: 'x' });
    assert(staffOnly.status === 403 && staffOnly.body?.code === 'staff_only', `8. a member can't start a topic there (${show(staffOnly)})`);
    const notice = await start(owen, { sectionId: news.body?.section?.id, title: 'Welcome: start here', words: 'Hello all.' });
    assert(notice.status === 201 && (await reply(mel, notice.body?.topic?.id, { words: 'Thanks!' })).status === 201, '8. the owner starts one there, and a member replies');
    const renamed = await call(owen, 'POST', `/api/forum/sections/${general}/edit`, { name: 'Anything goes', position: 5 });
    assert(renamed.status === 200 && renamed.body?.section?.starter === null && renamed.body?.section?.name === 'Anything goes', `8. a starter renamed: as typed (${show(renamed)})`);
    for (let i = 0; i < 9; i++) require_((await call(owen, 'POST', '/api/forum/sections', { name: `S${i}` })).status === 201, `8. section ${i + 4}`);
    const thirteenth = await call(owen, 'POST', '/api/forum/sections', { name: 'One too many' });
    assert(thirteenth.status === 409 && thirteenth.body?.code === 'too_many_sections', `8. a 13th: 409 (${show(thirteenth)})`);
    const archived = await call(owen, 'POST', `/api/forum/sections/${news.body?.section?.id}/edit`, { archived: true });
    const memberFront = await front(mel);
    const staffFront = await front(ada);
    assert(archived.body?.section?.archived === true && !(memberFront.body?.sections as any[]).some((s) => s.name === 'Notices')
        && (staffFront.body?.sections as any[]).some((s) => s.name === 'Notices' && s.archived) && !titles(await topics(mel)).includes('Welcome: start here'),
        '8. archived: out of members\' lists, owners and admins still see it');
    assert((await reply(mel, notice.body?.topic?.id, { words: 'Again' })).body?.code === 'closed', '8. a topic in an archived section takes no reply');
    const byId = [await topics(mel, `?section=${news.body?.section?.id}`), await topics(ada, `?section=${news.body?.section?.id}`)];
    assert(byId[0].status === 404 && byId[1].status === 200 && titles(byId[1]).includes('Welcome: start here'),
        `8. an archived section's list by its id: 404 to a member, there for an admin (${byId.map((r) => r.status).join()})`);
    assert((await call(owen, 'POST', '/api/forum/sections', { name: 'Room again' })).status === 201, '8. archiving one made room');

    // ── 9. Daily limits ───────────────────────────────────────────────────────────────────────────
    console.log('── 9. daily limits ──');
    const day = new Date().toISOString();
    const pad = db.prepare(`INSERT INTO forum_topics (id, section_id, title, writer_pubkey, last_activity_at, created_at, closed_by, closed_at) VALUES (?, ?, '', ?, ?, ?, 'removed', ?)`);
    const usedTopics = (db.prepare('SELECT COUNT(*) AS n FROM forum_topics WHERE writer_pubkey = ?').get(pat.pk) as { n: number }).n;
    for (let i = usedTopics; i < 10; i++) pad.run(`pad-${i}`, ideas, pat.pk, day, day, day);
    const eleventh = await start(pat, { sectionId: ideas, title: 'Eleventh', words: 'x' });
    assert(eleventh.status === 429 && eleventh.body?.code === 'topics_per_day' && /10 topics/.test(eleventh.body?.error), `9. an 11th topic in 24 hours (removed ones counted): 429 (${show(eleventh)})`);
    const padPost = db.prepare(`INSERT INTO forum_posts (id, topic_id, number, writer_pubkey, words, created_at, removed_by, removed_at) VALUES (?, ?, ?, ?, '', ?, 'writer', ?)`);
    for (let i = 0; i < 100; i++) padPost.run(`pp-${i}`, 'pad-x', 1000 + i, pat.pk, day, day);
    const hundredFirst = await reply(pat, tb, { words: 'One more' });
    assert(hundredFirst.status === 429 && hundredFirst.body?.code === 'replies_per_day', `9. a 101st reply: 429 (${show(hundredFirst)})`);
    for (let i = 0; i < 100; i++) padPost.run(`po-${i}`, 'pad-x', 2000 + i, owen.pk, day, day);
    assert((await reply(owen, tb, { words: 'At the owners number' })).body?.code === 'replies_per_day', "9. an owner at the owners' number (100 out of the box): 429");
    setAgentPostsPerDay(200);
    assert((await reply(owen, tb, { words: 'The owners allow more' })).status === 201, "9. the owners raise their number to 200: an owner past 100 replies");
    db.prepare("UPDATE forum_posts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id LIKE 'pp-%'").run();
    assert((await reply(pat, tb, { words: 'A day later' })).status === 201, '9. 24 hours on, a reply fits again');

    // ── 10. Muted and paused ──────────────────────────────────────────────────────────────────────
    console.log('── 10. muted, paused ──');
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 86_400_000).toISOString(), gus.pk);
    const muted = [await start(gus, { sectionId: ideas, title: 'x', words: 'y' }), await reply(gus, tb, { words: 'y' })];
    assert(muted.every((r) => r.status === 403 && r.body?.code === 'moderation_muted'), `10. a muted member starts and replies nothing (${muted.map((r) => r.body?.code).join()})`);
    assert((await topics(gus)).status === 200, '10. and still reads');
    const gusOwn = (db.prepare('SELECT id FROM forum_posts WHERE topic_id = ? AND number = 1').get(tc) as { id: string }).id;
    const mutedRemove = await call(gus, 'POST', `/api/forum/posts/${gusOwn}/remove`, {});
    assert(mutedRemove.status === 200, `10. but may take his own words down: a mute blocks posting, not removing (${show(mutedRemove)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(gus.pk);
    setUserStatusRow(gus.pk, 'disabled');
    const paused = await reply(gus, tb, { words: 'y' });
    assert(paused.status === 403 && paused.body?.code === 'not_active' && (await topic(gus, tb)).status === 200, `10. a paused member writes nothing, reads (${show(paused)})`);
    setUserStatusRow(gus.pk, 'active');

    // ── 11. Blocks ────────────────────────────────────────────────────────────────────────────────
    console.log('── 11. blocks ──');
    require_((await call(sue, 'POST', '/api/blocks', { targetPubkey: pat.pk })).status === 200, 'Sue blocks Pat');
    const sueList = await topics(sue);
    const sueRead = await topic(sue, tb);
    const patInSeed = await reply(pat, tb, { words: 'Pat writes again' });
    const sueSeesReply = await topic(sue, tb);
    assert(!titles(sueList).includes('Bike repair Saturdays') && sueRead.status === 404 && patInSeed.status === 201, `11. Pat's topic: in no list of Sue's, and 404 to her (${sueRead.status})`);
    const melTopic = (await start(mel, { sectionId: ideas, title: 'Mel asks', words: 'Anyone?' })).body?.topic?.id as string;
    await reply(pat, melTopic, { words: 'Pat answers Mel' });
    const sueOnMel = await topic(sue, melTopic);
    assert(sueOnMel.status === 200 && !sueOnMel.text.includes('Pat answers Mel') && (await topic(mel, melTopic)).text.includes('Pat answers Mel') && sueSeesReply.status === 404,
        '11. Pat\'s reply in someone else\'s topic: left out for Sue, there for Mel');
    await call(sue, 'POST', '/api/blocks/remove', { targetPubkey: pat.pk });
    assert((await topic(sue, melTopic)).text.includes('Pat answers Mel'), '11. unblocked: there again');

    // ── 12. Photos ────────────────────────────────────────────────────────────────────────────────
    console.log('── 12. photos ──');
    resetPhotoBudgetForTests();
    const withPhoto = await start(sue, { sectionId: ideas, title: 'With a photo', words: 'Look.', photos: [TEST_PHOTO] });
    const photoPost = withPhoto.body?.post?.id as string;
    assert(withPhoto.status === 201 && withPhoto.body?.post?.photos === 1, `12. a topic with a photo (${show(withPhoto)})`);
    const bytes = await call(mel, 'GET', `/api/forum/posts/${photoPost}/photos/0`);
    assert(bytes.status === 200 && bytes.headers.get('content-type') === 'image/png' && /private/.test(bytes.headers.get('cache-control') ?? ''), `12. served to a member, private (${bytes.status} ${bytes.headers.get('content-type')})`);
    assert((await call(mel, 'GET', `/api/forum/posts/${photoPost}/photos/1`)).status === 404 && (await call(stranger, 'GET', `/api/forum/posts/${photoPost}/photos/0`)).status === 403,
        '12. no second photo: 404; a stranger: 403');
    const fourPhotos = await reply(sue, melTopic, { words: 'x', photos: [TEST_PHOTO, TEST_PHOTO, TEST_PHOTO, TEST_PHOTO] });
    const notPhoto = await reply(sue, melTopic, { words: 'x', photos: ['https://evil.example/x.png'] });
    assert(fourPhotos.body?.code === 'too_many_photos' && notPhoto.body?.code === 'bad_photos', `12. four photos, or an address: 400 (${fourPhotos.body?.code}, ${notPhoto.body?.code})`);
    await reply(mel, withPhoto.body?.topic?.id, { words: 'Nice' });
    await call(sue, 'POST', `/api/forum/posts/${photoPost}/remove`, {});
    assert(!db.prepare('SELECT 1 FROM forum_post_photos WHERE post_id = ?').get(photoPost) && tombstone('forum_post_photos', `${photoPost}|0`)
        && (await call(mel, 'GET', `/api/forum/posts/${photoPost}/photos/0`)).status === 404, '12. removed: the photo goes, with a tombstone');

    // ── 13. List versions ─────────────────────────────────────────────────────────────────────────
    console.log('── 13. list versions ──');
    const first = await topics(mel);
    const tag = first.headers.get('etag') ?? '';
    const again = await call(mel, 'GET', '/api/forum/topics', undefined, { 'If-None-Match': tag });
    assert(tag.length > 10 && again.status === 304, `13. unchanged: 304 (${again.status})`);
    assert((await call(sue, 'GET', '/api/forum/topics', undefined, { 'If-None-Match': tag })).status === 200, "13. another member's copy never confirms Mel's");
    await reply(sue, melTopic, { words: 'Something new' });
    const after = await call(mel, 'GET', '/api/forum/topics', undefined, { 'If-None-Match': tag });
    const unpinned = ((after.body?.topics ?? []) as any[]).filter((t) => !t.pinned).map((t) => t.title);
    assert(after.status === 200 && after.headers.get('etag') !== tag && unpinned[0] === 'Mel asks', `13. a reply later: the new list (${after.status} ${unpinned[0]})`);
    await call(mel, 'POST', '/api/blocks', { targetPubkey: sue.pk });
    assert((await call(mel, 'GET', '/api/forum/topics', undefined, { 'If-None-Match': after.headers.get('etag') ?? '' })).status === 200, '13. a block later: the new list');
    await call(mel, 'POST', '/api/blocks/remove', { targetPubkey: sue.pk });

    // ── 14. A public forum: told first ────────────────────────────────────────────────────────────
    console.log('── 14. told first ──');
    setOverride('forumPublic', 'true');
    assert(getNodeFeatures().forumPublic === true && (await front(ada)).body?.public === true, '14. the switch on: features and the front say it is public');
    const untold = [await start(ada, { sectionId: ideas, title: 'Untold', words: 'x' }), await reply(ada, melTopic, { words: 'Untold reply' })];
    assert(untold.every((r) => r.status === 409 && r.body?.code === 'tell_first'), `14. a first post without the told stamp is refused, topic and reply (${untold.map((r) => r.body?.code).join()})`);
    const told = await call(ada, 'POST', '/api/forum/told', {});
    assert(told.status === 200 && told.body?.told === true && (await front(ada)).body?.told === true, `14. Ada is told (${show(told)})`);
    const stamp = (db.prepare('SELECT told_public_at FROM forum_members WHERE member_pubkey = ?').get(ada.pk) as { told_public_at: string }).told_public_at;
    await call(ada, 'POST', '/api/forum/told', {});
    assert((db.prepare('SELECT told_public_at FROM forum_members WHERE member_pubkey = ?').get(ada.pk) as { told_public_at: string }).told_public_at === stamp, '14. told twice: the first time kept');
    assert((await start(ada, { sectionId: ideas, title: 'Told now', words: 'x' })).status === 201, '14. told, she posts');
    dropOverride('forumPublic');
    assert((await reply(mod, melTopic, { words: 'Local again' })).status === 201, '14. a members-only forum asks no telling');

    // ── 15. The owners' off-switch ────────────────────────────────────────────────────────────────
    console.log('── 15. the off-switch ──');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM forum_topics').get() as { n: number }).n;
    const noticeMark = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM moderation_notices').get() as { m: number }).m;
    const off = await call(null, 'POST', '/api/local/admin/community-shape', { changes: { forum: false } }, ownerSessionHeaders(owen.pk));
    assert(off.status === 200, `15. the owner switches the forum off in How this community works (${show(off)})`);
    const offAnswers = [await front(mel), await topics(mel), await topic(mel, melTopic), await start(mel, { sectionId: ideas, title: 'x', words: 'y' }),
        await reply(mel, melTopic, { words: 'y' }), await call(mel, 'POST', '/api/forum/told', {}), await call(owen, 'POST', '/api/forum/sections', { name: 'x' })];
    assert(offAnswers.every((r) => r.status === 404 && r.body?.code === 'feature_off'), `15. off: every route 404 feature_off (${offAnswers.map((r) => r.status).join()})`);
    assert(!('forum' in getNodeFeatures()), '15. off: features say nothing of a forum');
    const told15 = db.prepare("SELECT body FROM moderation_notices WHERE rowid > ? AND recipient = ?").all(noticeMark, mel.pk) as { body: string }[];
    assert(told15.some((n) => n.body.includes('the forum is off')), `15. members are told (${told15.map((n) => n.body).join(' | ').slice(0, 160)})`);
    const shape = await call(null, 'GET', '/api/local/admin/community-shape', undefined, ownerSessionHeaders(owen.pk));
    assert(shape.body?.settings?.forum?.value === false && shape.body?.settings?.forum?.source === 'owner', `15. the shape reads it off, the owners' (${JSON.stringify(shape.body?.settings?.forum)})`);
    const on = await call(null, 'POST', '/api/local/admin/community-shape', { changes: { forum: true } }, ownerSessionHeaders(owen.pk));
    assert(on.status === 200 && (db.prepare('SELECT COUNT(*) AS n FROM forum_topics').get() as { n: number }).n === before && (await topic(mel, melTopic)).status === 200,
        '15. on again: every topic kept');

    // ── 16. A standby ─────────────────────────────────────────────────────────────────────────────
    console.log('── 16. a standby ──');
    for (const t of FORUM_TABLES) assert((TABLES as any)[t]?.kind === 'replicated' && (TABLES as any)[t]?.plain === true, `16. the manifest copies ${t} as a plain table`);
    const copy = await exportSyncState('test-forum') as any;
    assert(FORUM_TABLES.every((t) => Array.isArray(copy.plainTables?.[t])) && copy.plainTables.forum_topics.some((r: any) => r.title === 'Mel asks'),
        '16. a whole copy carries every forum table, the topics whole');
    setNodeRole('backup');
    const onStandby = [await start(mel, { sectionId: ideas, title: 'x', words: 'y' }), await reply(mel, melTopic, { words: 'y' }), await call(mel, 'POST', '/api/forum/told', {}),
        await call(owen, 'POST', `/api/forum/topics/${melTopic}/pin`, { pinned: true }), await call(owen, 'POST', '/api/forum/sections', { name: 'x' })];
    assert(onStandby.every((r) => r.status === 503 && r.body?.code === 'standby'), `16. a standby refuses every write (${onStandby.map((r) => `${r.status} ${r.body?.code}`).join()})`);
    assert((await topic(mel, melTopic)).status === 200 && (await topics(mel)).status === 200, '16. and reads from its copy');
    setNodeRole('primary');

    // ── 17. Delete account, removal, re-key ──────────────────────────────────────────────────────
    console.log('── 17. leaving ──');
    const melWords = 'Mel private words 7f3a';
    const melT = await start(mel, { sectionId: ideas, title: 'Mel title 7f3a', words: melWords, photos: [TEST_PHOTO] });
    await reply(sue, melT.body?.topic?.id, { words: 'Sue answers' });
    const melR = await reply(mel, tb, { words: `${melWords} in a reply` });
    await call(mel, 'POST', `/api/forum/posts/${melR.body?.post?.id}/edit`, { words: `${melWords} edited` });
    const since = new Date(Date.now() - 1000).toISOString();
    const cut = (db.prepare('SELECT MAX(updated_at) AS u FROM forum_posts').get() as { u: string }).u;
    require_(db.prepare('SELECT 1 FROM forum_post_edits WHERE post_id = ?').get(melR.body?.post?.id) && db.prepare('SELECT 1 FROM forum_post_photos WHERE post_id = ?').get(melT.body?.post?.id), 'Mel has an earlier wording and a photo');
    const purged = purgeMemberSelf(mel.pk);
    require_(purged.ok, `Mel deletes her account (${purged.message})`);
    const hers = db.prepare('SELECT words, removed_by FROM forum_posts WHERE writer_pubkey = ?').all(mel.pk) as { words: string; removed_by: string }[];
    const hersAnywhere = JSON.stringify(FORUM_TABLES.map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    assert(hers.length > 0 && hers.every((p) => p.words === '' && p.removed_by !== null) && !hersAnywhere.includes('7f3a') && !hersAnywhere.includes('Bring seeds'),
        `17. on the main server none of her words is left in any forum table (${hers.length} markers)`);
    assert(!db.prepare('SELECT 1 FROM forum_post_photos WHERE post_id = ?').get(melT.body?.post?.id) && tombstone('forum_post_photos', `${melT.body?.post?.id}|0`)
        && !db.prepare('SELECT 1 FROM forum_post_edits WHERE post_id = ?').get(melR.body?.post?.id) && !db.prepare('SELECT 1 FROM forum_members WHERE member_pubkey = ?').get(mel.pk),
        '17. her photos, earlier wordings and stamp gone, with tombstones');
    const melTopicAfter = await topic(sue, melT.body?.topic?.id);
    assert(melTopicAfter.status === 200 && melTopicAfter.body?.topic?.title === '' && melTopicAfter.text.includes('Sue answers'), '17. her topic with Sue\'s reply: blanked, Sue\'s reply stays');
    const delta = await exportSyncState('test-forum', since) as any;
    const deltaText = JSON.stringify(delta.plainTables ?? {});
    const deltaTombs = JSON.stringify(delta.tombstones ?? delta);
    const wholeAfter = JSON.stringify((await exportSyncState('test-forum') as any).plainTables ?? {});
    assert(cut && !deltaText.includes('7f3a') && (delta.plainTables?.forum_posts as any[] ?? []).some((r) => r.writer_pubkey === mel.pk && r.words === '' && r.removed_by === 'account')
        && deltaTombs.includes(`${melT.body?.post?.id}|0`) && !wholeAfter.includes('7f3a'),
        '17. what a standby is sent: her blanked rows and the tombstones of her photo and earlier wording, none of her words, whole or delta');
    const gusWords = 'Gus words 9c1e';
    await start(gus, { sectionId: ideas, title: 'Gus topic', words: gusWords });
    adminPruneUser(gus.pk, COMMUNITY_DECISION_ACTOR);
    assert(!JSON.stringify(FORUM_TABLES.map((t) => db.prepare(`SELECT * FROM ${t}`).all())).includes('9c1e'), '17. a member the community removes: their forum words taken down too');
    const pat2 = newId('Pat2');
    const patPosts = (db.prepare('SELECT COUNT(*) AS n FROM forum_posts WHERE writer_pubkey = ?').get(pat.pk) as { n: number }).n;
    moveMemberKeyRows(pat.pk, pat2.pk, new Date().toISOString(), { keepStamps: false });
    const movedPosts = (db.prepare('SELECT COUNT(*) AS n FROM forum_posts WHERE writer_pubkey = ?').get(pat2.pk) as { n: number }).n;
    assert(patPosts > 0 && movedPosts === patPosts && !db.prepare('SELECT 1 FROM forum_topics WHERE writer_pubkey = ?').get(pat.pk)
        && !!db.prepare('SELECT 1 FROM forum_topics WHERE writer_pubkey = ?').get(pat2.pk), `17. a re-key moves Pat's topics and posts to the new key (${movedPosts})`);
    moveMemberKeyRows(pat2.pk, pat.pk, new Date().toISOString(), { keepStamps: false });

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ The forum: members read and write, a non-member nothing, newest first, closed means closed, told first where public, and leaving leaves no words.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
