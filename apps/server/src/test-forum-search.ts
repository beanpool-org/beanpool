/**
 * The forum's search, slice F6, through the real HTTPS stack and its signature middleware (scratch/fable-design/
 * DESIGN-forums-fable.md §8, §16, §21 F6 "test-forum-search.ts"; engine/forum-search.ts).
 *
 *  1. It finds: words in titles, opening posts and replies, as the start of a word, every word typed; a topic's place; newest
 *     first; each hit names its post's number, so an app opens the topic at it; the excerpt holds the word found; 20 a page.
 *  2. A Thai and a Chinese phrase are found inside a run of their script (no spaces), in words and in a title.
 *  3. Every way a post stops being readable, one table (close the class): removed by its writer, by a moderator, its
 *     writer's account deleted or removed by the community, hidden while moderators look (a reply; an opening post takes
 *     its whole topic), its topic gone, its writer or its topic's writer blocked by the reader, its section archived, and a
 *     first topic still waiting for a look (the global community). Each is found before and in no answer after, for the
 *     reader, the moderators and its own writer alike (a block: the blocker only); the controls that stay readable (a
 *     closed topic, a moved one, others' replies under a removed opening post) stay found. A section only a group reads is
 *     slice F8's row (engine/forum-search.ts SEARCHABLE_SECTION).
 *  4. A removed post's words leave the index's own bytes at once (`secure-delete`), as they leave the forum's tables.
 *  5. The day limit holds: 100 searches in any 24 hours a member, the 101st 429 with Retry-After; a search refused for its
 *     words is not counted; another member's count is their own. Who may search: members who read as members; unsigned 401,
 *     a stranger and a paused member 403, as the forum's reads.
 *  6. A standby answers the same: the index is this server's own (manifest 'local', in no copy, not hashed, so
 *     TABLE_HASHES_VERSION stays as it is); a standby's import of the whole copy rebuilds it by the triggers, FTS5's own check
 *     passes, and every search answers the same posts in the same order.
 *  7. A boot again leaves the index's own tables byte for byte (FTS5 counts each setting it is told in the index's header,
 *     so `secure-delete` is told once, when the index is made), and `secure-delete` is still on.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-forum-search" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, exportSyncState, purgeMemberSelf, adminPruneUser, COMMUNITY_DECISION_ACTOR, broadcast, dispatchPushNotification } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db, initSchema } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { markForumTold, removeForumPostAsModerator, resetForumStartersCheckForTests } from './engine/forum.js';
import { restoreHiddenForumPost } from './engine/forum-moderation.js';
import { FORUM_SEARCH_PAGE, forumSearchQuery, forumSearchWords, resetForumSearchBudget } from './engine/forum-search.js';
import { importPlainTables } from './engine/plain-tables.js';
import { TABLES } from './engine/replication-manifest.js';
import { TABLE_HASHES_VERSION, hashedTables, tableContentHashes } from './engine/replica-hashes.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import { FORUM_SEARCHES_PER_DAY } from '@beanpool/core';
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
/** A member who joined `daysAgo` days ago, invited by the owner, told the forum is public. */
function member(name: string, daysAgo: number): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, ?, 'TEST', 'active')`)
        .run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    markForumTold(id.pk);
    return id;
}

interface Res { status: number; body: any; text: string; headers: Headers }
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
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 240)}` : '-');

const front = (id: Id) => call(id, 'GET', '/api/forum');
const start = (id: Id, body: Record<string, unknown>) => call(id, 'POST', '/api/forum/topics', body);
const reply = (id: Id, t: string, body: Record<string, unknown>) => call(id, 'POST', `/api/forum/topics/${t}/replies`, body);
/** A search, never stopped by the day's count (section 5 tests the count itself). */
async function search(id: Id, q: string, offset = 0): Promise<Res> {
    resetForumSearchBudget();
    return call(id, 'GET', `/api/forum/search?q=${encodeURIComponent(q)}${offset ? `&offset=${offset}` : ''}`);
}
const hitIds = (r: Res) => ((r.body?.hits ?? []) as any[]).map((h) => h.postId as string);
const found = async (id: Id, q: string, postId: string) => hitIds(await search(id, q)).includes(postId);
const noticeCb = { broadcast: (e: any, r?: string[]) => broadcast(e, r), dispatchPushNotification: (...a: Parameters<typeof dispatchPushNotification>) => dispatchPushNotification(...a) };
const hide = (postId: string) => db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), postId);
const FORUM_TABLES = Object.keys(TABLES).filter((t) => t.startsWith('forum_') && t !== 'forum_search');
/** A mark no key, id or other word holds: z and q are not hex, and each is a run of letters the index reads as one word. */
const mark = () => `zq${crypto.randomBytes(4).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`;

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
    const [mel, sue, bob, ben, cal, gus, wes, ivy] = ['Mel', 'Sue', 'Bob', 'Ben', 'Cal', 'Gus', 'Wes', 'Ivy'].map((n) => member(n, 60));
    const sections = (await front(mel)).body?.sections ?? [];
    const general = sections.find((s: any) => s.starter === 'general')?.id as string;
    const ideas = sections.find((s: any) => s.starter === 'ideas-local')?.id as string;
    require_(general && ideas, 'the local forum has General and Ideas for our community');

    // ── 1. It finds ──────────────────────────────────────────────────────────────────────────────
    console.log('── 1. it finds ──');
    const swap = await start(mel, { sectionId: general, title: 'Seed swap by the river', words: 'Bring jars of tomato seeds and labels.', place: 'near Riverside' });
    require_(swap.status === 201, `Mel starts a topic (${show(swap)})`);
    const swapId = swap.body.topic.id as string;
    const swapOpening = swap.body.post.id as string;
    const basil = await reply(sue, swapId, { words: 'I can bring basil cuttings, and don’t forget the labels.' });
    require_(basil.status === 201, 'Sue replies');
    const basilId = basil.body.post.id as string;
    const tomato = await search(bob, 'tomato');
    assert(tomato.status === 200 && tomato.body?.hits?.length === 1 && tomato.body.hits[0].postId === swapOpening && tomato.body.hits[0].number === 1
        && tomato.body.hits[0].topicId === swapId && tomato.body.hits[0].title === 'Seed swap by the river' && tomato.body.hits[0].writer?.name === 'Mel'
        && tomato.body.hits[0].sectionId === general && tomato.body.next === null, `1. a word in an opening post: its post, number 1, its topic and writer (${show(tomato)})`);
    assert(hitIds(await search(bob, 'Tomat')).includes(swapOpening), '1. as the start of a word, in any case');
    assert(hitIds(await search(bob, 'river')).join() === swapOpening, '1. a word of the title finds the opening post');
    assert(hitIds(await search(bob, 'riverside')).join() === swapOpening, '1. so does its place');
    const b = await search(bob, 'basil');
    assert(b.body?.hits?.length === 1 && b.body.hits[0].postId === basilId && b.body.hits[0].number === 2 && b.body.hits[0].title === 'Seed swap by the river',
        `1. a word in a reply: that reply, number 2, under its topic's title (${show(b)})`);
    assert(hitIds(await search(bob, 'swap jars')).join() === swapOpening, '1. every word typed: one in the title and one in the words of the same post');
    assert(hitIds(await search(bob, 'tomato zebra')).length === 0, '1. a word in no post: nothing, though the other is found');
    assert(hitIds(await search(bob, 'labels')).join() === [basilId, swapOpening].join(), '1. newest first: the reply, then the opening post');
    assert(hitIds(await search(bob, "don't")).join() === basilId && hitIds(await search(bob, 'DON’T')).join() === basilId, '1. an apostrophe typed either way finds the other');
    const long = `${'Words before it. '.repeat(20)}Here is the needle word in the middle. ${'Words after it. '.repeat(20)}`;
    const longPost = await reply(bob, swapId, { words: long });
    const ex = (await search(mel, 'needle')).body?.hits?.[0]?.excerpt as string | undefined;
    assert(longPost.status === 201 && !!ex && ex.includes('needle') && ex.startsWith('…') && ex.endsWith('…') && Array.from(ex).length <= 162,
        `1. the excerpt: the words around the find, cut where it is cut (${ex})`);
    const many = mark();
    for (let i = 0; i < FORUM_SEARCH_PAGE + 5; i++) await reply(wes, swapId, { words: `${many} number ${i}` });
    const p1 = await search(mel, many);
    const p2 = await search(mel, many, p1.body?.next ?? 0);
    assert(p1.body?.hits?.length === FORUM_SEARCH_PAGE && p1.body.next === FORUM_SEARCH_PAGE && p2.body?.hits?.length === 5 && p2.body.next === null
        && new Set([...hitIds(p1), ...hitIds(p2)]).size === FORUM_SEARCH_PAGE + 5, `1. 20 a page, then the rest (${p1.body?.hits?.length}, ${p2.body?.hits?.length})`);
    const bad = [await search(mel, ''), await search(mel, '" "'), await search(mel, '…  -'), await search(mel, 'x'.repeat(201))];
    assert(bad.map((r) => `${r.status} ${r.body?.code}`).join() === '400 no_words,400 no_words,400 no_words,400 too_long',
        `1. nothing to look for, or past 200 characters: 400 (${bad.map((r) => `${r.status} ${r.body?.code}`).join()})`);

    // ── 2. Scripts written without spaces ────────────────────────────────────────────────────────
    console.log('── 2. Thai and Chinese ──');
    const thai = await reply(ivy, swapId, { words: 'เรามีขายผักสดทุกวันเสาร์ที่ตลาด' });
    const zh = await start(ivy, { sectionId: general, title: '周六种子交换', words: '我们周六有种子交换活动，欢迎带种子来。' });
    require_(thai.status === 201 && zh.status === 201, 'Ivy writes in Thai and in Chinese');
    assert(hitIds(await search(mel, 'ผักสด')).join() === thai.body.post.id, '2. a Thai phrase inside a run of Thai ("fresh vegetables" in "we sell fresh vegetables every Saturday at the market")');
    assert(hitIds(await search(mel, '种子交换')).join() === zh.body.post.id, '2. a Chinese phrase inside the title and the words ("seed swap")');
    assert(hitIds(await search(mel, '交换 周六')).join() === zh.body.post.id && hitIds(await search(mel, '交换 tomato')).length === 0, '2. each phrase must be found, Chinese and Latin alike');
    // No search walks forum_posts whole: each words' set of posts is the index's or a range of the newest (the plan, read).
    const plans = ['ผักสด', 'tomato', '交换 tomato'].map((typed) => {
        const { sql, params } = forumSearchQuery(forumSearchWords(typed), { reader: mel.pk, offset: 0 });
        return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[]).map((r) => r.detail);
    });
    console.log(plans.map((p) => p.join(' | ')).join('\n'));
    // The posts asked about (`p`) are reached only by rowid, the sets' own, and the newest posts' scan (`n`) only by its range:
    // never by walking a topic's or a section's posts, which with no word to hold it reads every post there is.
    const postsRead = plans.map((p) => p.filter((d) => /^(SCAN|SEARCH) (p|n|forum_posts)\b/.test(d)));
    assert(postsRead.every((p) => p.length > 0 && p.every((d) => d === 'SEARCH p USING INTEGER PRIMARY KEY (rowid=?)' || d.startsWith('SEARCH n USING INDEX idx_forum_posts_created (created_at>'))),
        `2. no search reads forum_posts whole: by rowid from the index, or a range of the newest posts (${postsRead.map((p) => p.join('; ')).join(' / ')})`);

    // ── 3. Every way a post stops being readable, x search ───────────────────────────────────────
    console.log('── 3. every way a post stops being readable ──');
    // [the way, who no longer finds it, who still does (a control), make the post and return its id + mark, apply the way]
    interface Row { way: string; gone: Id[]; still: Id[]; make: () => Promise<{ id: string; word: string }>; apply: (id: string) => Promise<unknown> | unknown }
    const topicOf = async (who: Id, title = 'A topic') => {
        const w = mark();
        const r = await start(who, { sectionId: general, title: `${title} ${w}`, words: `Opening ${w}` });
        require_(r.status === 201, `${who.name} starts a topic (${show(r)})`);
        return { topicId: r.body.topic.id as string, id: r.body.post.id as string, word: w };
    };
    const replyOf = async (who: Id, topicId = swapId) => {
        const w = mark();
        const r = await reply(who, topicId, { words: `A reply ${w}` });
        require_(r.status === 201, `${who.name} replies (${show(r)})`);
        return { id: r.body.post.id as string, word: w };
    };
    const everyone = [mel, mo, owner];
    let othersReply = '';
    let othersWord = '';
    const rows: Row[] = [
        { way: 'a reply removed by its writer', gone: [...everyone, bob], still: [], make: () => replyOf(bob),
            apply: (id) => call(bob, 'POST', `/api/forum/posts/${id}/remove`) },
        { way: 'a reply removed by a moderator', gone: [...everyone, bob], still: [], make: () => replyOf(bob),
            apply: (id) => db.transaction(() => removeForumPostAsModerator(id))() },
        { way: 'an opening post removed by its writer, nobody else replied (the topic gone, its title too)', gone: [...everyone, bob], still: [],
            make: () => topicOf(bob), apply: (id) => call(bob, 'POST', `/api/forum/posts/${id}/remove`) },
        { way: 'an opening post removed by its writer, with others\' replies (blanked)', gone: [...everyone, bob], still: [],
            make: async () => { const t = await topicOf(bob); const r = await replyOf(sue, t.topicId); othersReply = r.id; othersWord = r.word; return t; },
            apply: (id) => call(bob, 'POST', `/api/forum/posts/${id}/remove`) },
        { way: 'an opening post removed by a moderator', gone: [...everyone, bob], still: [], make: () => topicOf(bob),
            apply: (id) => db.transaction(() => removeForumPostAsModerator(id))() },
        { way: 'a reply hidden while moderators look (the column every hiding path sets: reports, a burst\'s clean-up)', gone: [...everyone, bob], still: [],
            make: () => replyOf(bob), apply: (id) => hide(id) },
        { way: 'an opening post hidden: its topic\'s title and words', gone: [...everyone, bob], still: [], make: () => topicOf(bob), apply: (id) => hide(id) },
        { way: 'its writer deleted their account', gone: [...everyone], still: [], make: () => replyOf(cal), apply: () => require_(purgeMemberSelf(cal.pk).ok, 'Cal deletes their account') },
        { way: 'its writer removed by the community', gone: [...everyone], still: [], make: () => replyOf(gus), apply: () => adminPruneUser(gus.pk, COMMUNITY_DECISION_ACTOR) },
        { way: 'its writer blocked by the reader', gone: [mel], still: [sue, mo], make: () => replyOf(ben),
            apply: async () => require_((await call(mel, 'POST', '/api/blocks', { targetPubkey: ben.pk })).status === 200, 'Mel blocks Ben') },
        { way: 'a reply in a topic whose writer the reader blocked', gone: [sue], still: [mel, mo],
            make: async () => { const t = await topicOf(wes); return replyOf(mel, t.topicId); },
            apply: async () => require_((await call(sue, 'POST', '/api/blocks', { targetPubkey: wes.pk })).status === 200, 'Sue blocks Wes') },
        { way: 'its section archived (out of every list)', gone: [...everyone, bob], still: [],
            make: async () => { const w = mark(); const r = await start(bob, { sectionId: ideas, title: `In ideas ${w}`, words: 'x' }); return { id: r.body.post.id, word: w }; },
            apply: async () => require_((await call(owner, 'POST', `/api/forum/sections/${ideas}/edit`, { archived: true })).status === 200, 'Olive archives Ideas') },
    ];
    for (const row of rows) {
        const post = await row.make();
        const before = await Promise.all([...row.gone, ...row.still].map((who) => found(who, post.word, post.id)));
        require_(before.every(Boolean), `3. ${row.way}: found by everyone before (${before.join()})`);
        await row.apply(post.id);
        const gone = await Promise.all(row.gone.map((who) => found(who, post.word, post.id)));
        const still = await Promise.all(row.still.map((who) => found(who, post.word, post.id)));
        assert(gone.every((f) => !f) && still.every(Boolean),
            `3. ${row.way}: in no answer for ${row.gone.map((w) => w.name).join(', ')}${row.still.length ? `; still found by ${row.still.map((w) => w.name).join(', ')}` : ''} (${gone.join()} / ${still.join()})`);
    }
    assert(await found(mel, othersWord, othersReply) && (await search(mel, othersWord)).body?.hits?.[0]?.title === '',
        '3. control: others\' replies under a removed opening post stay found, under its blanked title');
    const closed = await topicOf(sue, 'Closed');
    require_((await call(sue, 'POST', `/api/forum/topics/${closed.topicId}/close`)).status === 200, 'Sue closes her topic');
    const moved = await topicOf(sue, 'Moved');
    const seeds = await call(owner, 'POST', '/api/forum/sections', { name: 'Seeds' });
    require_((await call(owner, 'POST', `/api/forum/topics/${moved.topicId}/move`, { sectionId: seeds.body?.section?.id })).status === 200, 'Olive moves a topic to a new section');
    assert(await found(mel, closed.word, closed.id) && await found(mel, moved.word, moved.id), '3. control: a topic closed by its writer, and a moved topic, stay found');
    // A hidden reply put back by a moderator is found again: the index never lost it.
    const back = await replyOf(bob);
    hide(back.id);
    assert(!await found(mel, back.word, back.id) && restoreHiddenForumPost(noticeCb, back.id) === 'restored' && await found(mel, back.word, back.id),
        '3. a hidden reply put back is found again');

    // ── 4. A removed post's words leave the index's own bytes ────────────────────────────────────
    console.log('── 4. the index forgets ──');
    const gone = await replyOf(bob);
    const inBytes = (w: string) => (db.prepare('SELECT COUNT(*) AS n FROM forum_search_data WHERE instr(block, CAST(? AS BLOB)) > 0').get(w.slice(1)) as { n: number }).n
        + (db.prepare('SELECT COUNT(*) AS n FROM forum_search_content WHERE instr(c2, ?) > 0 OR instr(c0, ?) > 0').get(w, w) as { n: number }).n;
    require_(inBytes(gone.word) > 0, 'the reply\'s word is in the index');
    await call(bob, 'POST', `/api/forum/posts/${gone.id}/remove`);
    assert(inBytes(gone.word) === 0, '4. removed: its word is in no block and no row of the index, at once (secure-delete)');
    const dan = member('Dan', 60);
    const danPost = await replyOf(dan);
    require_(purgeMemberSelf(dan.pk).ok, 'Dan deletes their account');
    assert(inBytes(danPost.word) === 0, '4. an account deleted: none of its words left in the index');

    // ── 7. A boot again changes nothing in the index ─────────────────────────────────────────────
    // Here, with rows in the index and removals done: initSchema runs schema.sql again, as every boot does.
    console.log('── 7. a boot again ──');
    const indexTables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'forum\\_search%' ESCAPE '\\' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    const indexBytes = () => JSON.stringify(indexTables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).raw().all()]),
        (_k, v) => (typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? v.toString('hex') : v));
    const secureDelete = () => (db.prepare("SELECT v FROM forum_search_config WHERE k = 'secure-delete'").get() as { v: number } | undefined)?.v;
    require_(indexTables.includes('forum_search_data') && indexTables.includes('forum_search_config') && (db.prepare('SELECT COUNT(*) AS n FROM forum_search').get() as { n: number }).n > 0,
        `the index and its own tables are there, with rows (${indexTables.join(', ')})`);
    const bytesBefore = indexBytes();
    initSchema();
    initSchema();
    assert(indexBytes() === bytesBefore, `7. two boots: every row of ${indexTables.join(', ')} as it was, byte for byte`);
    assert(secureDelete() === 1, `7. secure-delete is still on (${secureDelete()})`);

    // ── 5. The day limit, and who may search ─────────────────────────────────────────────────────
    console.log('── 5. the day limit ──');
    resetForumSearchBudget();
    const day: number[] = [];
    for (let i = 0; i < FORUM_SEARCHES_PER_DAY - 1; i++) day.push((await call(mel, 'GET', '/api/forum/search?q=tomato')).status);
    const notCounted = await call(mel, 'GET', '/api/forum/search?q=%22');
    const hundredth = await call(mel, 'GET', '/api/forum/search?q=tomato');
    const over = await call(mel, 'GET', '/api/forum/search?q=tomato');
    assert(day.every((s) => s === 200) && notCounted.status === 400 && hundredth.status === 200,
        `5. ${FORUM_SEARCHES_PER_DAY} searches in a day; one refused for its words is not counted (${notCounted.status}, ${hundredth.status})`);
    assert(over.status === 429 && over.body?.code === 'searches_per_day' && Number(over.headers.get('retry-after')) > 0 && /search the forum 100 times/.test(over.body?.error ?? ''),
        `5. the 101st: 429, with when to try again (${show(over)} retry-after ${over.headers.get('retry-after')})`);
    assert((await call(sue, 'GET', '/api/forum/search?q=tomato')).status === 200, '5. another member\'s count is their own');
    resetForumSearchBudget();
    const stranger = newId('Stranger');
    const unsigned = await call(null, 'GET', '/api/forum/search?q=tomato');
    const outsider = await call(stranger, 'GET', '/api/forum/search?q=tomato');
    // A stranger is stopped by the members' read gate before the route (its own code), as every forum read is (test-forum.ts 2).
    assert(unsigned.status === 401 && outsider.status === 403 && !outsider.text.includes('tomato') && !outsider.text.includes('hits'),
        `5. unsigned 401; a non-member 403, no hits (${show(unsigned)} / ${show(outsider)})`);
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(ivy.pk);
    assert((await call(ivy, 'GET', '/api/forum/search?q=tomato')).body?.code === 'not_active', '5. a paused member 403 not_active');
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(ivy.pk);

    // ── 6. A standby answers the same ────────────────────────────────────────────────────────────
    console.log('── 6. a standby ──');
    assert((TABLES as any).forum_search?.kind === 'local', '6. the manifest keeps the index as this server\'s own');
    const asked = ['tomato', 'labels', 'riverside', 'ผักสด', '种子交换', many, othersWord, closed.word];
    // Bob blocked nobody (Sue blocked Wes, whose replies hold `many`).
    const answers = async () => Promise.all(asked.map(async (q) => hitIds(await search(bob, q)).join()));
    const onMain = await answers();
    const copy = await exportSyncState('test-forum-search') as any;
    assert(!('forum_search' in (copy.plainTables ?? {})) && FORUM_TABLES.every((t) => Array.isArray(copy.plainTables?.[t])),
        `6. a whole copy carries every forum table and not the index (${FORUM_TABLES.join(', ')})`);
    const hashesBefore = tableContentHashes({ only: FORUM_TABLES });
    // TABLE_HASHES_VERSION is not raised for it: no hashed table or column changed (test-replica-hashes.ts holds the columns to it).
    assert(!hashedTables(db).some((t) => t.table.startsWith('forum_search')) && !Object.keys(tableContentHashes().tables).some((t) => t.startsWith('forum_search')),
        `6. the replica hashes leave the index out (hashes version ${TABLE_HASHES_VERSION})`);
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    require_(count('forum_search') === count('forum_posts'), `one index row a post on the main server (${count('forum_search')} / ${count('forum_posts')})`);
    // The standby: its own copy of the forum, from nothing, by the import a puller runs.
    for (const t of [...FORUM_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    require_(count('forum_search') === 0, 'the forum emptied: the index with it');
    setNodeRole('backup');
    const imported = importPlainTables(copy.plainTables, true, copy.generatedAt);
    assert(imported.changes > 0 && imported.skipped === 0, `6. the standby imports the whole copy (${imported.changes} rows, ${imported.skipped} skipped)`);
    let integrity = 'ok';
    try { db.prepare("INSERT INTO forum_search(forum_search, rank) VALUES ('integrity-check', 1)").run(); } catch (e) { integrity = (e as Error).message; }
    assert(count('forum_search') === count('forum_posts') && integrity === 'ok', `6. its triggers built its own index: a row a post, FTS5's check passes (${count('forum_search')} / ${count('forum_posts')}, ${integrity})`);
    const hashesAfter = tableContentHashes({ only: FORUM_TABLES });
    assert(JSON.stringify(hashesAfter) === JSON.stringify(hashesBefore), '6. its forum tables hash as the main server\'s');
    const onStandby = await answers();
    assert(JSON.stringify(onStandby) === JSON.stringify(onMain) && onMain.every((a) => a.length > 0),
        `6. every search answers the same posts in the same order on the standby (${onStandby.map((a) => a.split(',').length).join(' ')})`);
    setNodeRole('primary');

    // ── 3, the last row: a first topic still waiting (the global community) ─────────────────────
    console.log('── 3. a first topic waiting ──');
    process.env.NODE_PROFILE = 'global';
    db.prepare('DELETE FROM forum_sections').run();
    db.prepare("DELETE FROM node_config WHERE key = 'forum.startersMade'").run();
    resetForumStartersCheckForTests();
    const skills = (await front(mel)).body?.sections?.find((s: any) => s.starter === 'skills')?.id as string;
    require_(skills, 'the global forum has its starter sections');
    const nia = member('Nia', 1);
    const waitWord = mark();
    const held = await start(nia, { sectionId: skills, title: `Nia first ${waitWord}`, words: `Hello ${waitWord}` });
    require_(held.status === 202, `a new account's first topic waits for a look (${show(held)})`);
    const waitHits = await Promise.all([mel, mo, owner, nia].map(async (who) => hitIds(await search(who, waitWord)).length));
    assert(waitHits.every((n) => n === 0), `3. a first topic waiting: in no answer, for a member, a moderator, the owner or its writer (${waitHits.join()})`);
    const ok = await call(mo, 'POST', `/api/forum/first-looks/${held.body.waiting.id}/ok`);
    require_(ok.status === 200, `a moderator OKs it (${show(ok)})`);
    assert(hitIds(await search(mel, waitWord)).length === 1, '3. OK\'d, it is a topic, and found');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ The forum\'s search: every word found, Thai and Chinese too, never a post nobody may read, 100 a day, the same on a standby.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
