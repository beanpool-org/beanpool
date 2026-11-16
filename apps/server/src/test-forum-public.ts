/**
 * The worldwide community's forum for anyone on the web (slice F7; scratch/fable-design/DESIGN-forums-fable.md §4, §5, §7, §15,
 * §21 F7 "test-forum-public.ts"; Marty's answer to Q2, 14 Nov 2026), through the real HTTPS stack and its middleware.
 *
 *  1. A local community: every public route answers not found (/forum, its pages, the JSON, a photo, the sitemap, robots.txt),
 *     and nothing is stamped public.
 *  2. The worldwide community: public from is stamped when a known writer posts, when a first look's OK makes a writer known,
 *     and by the sweep when a writer becomes known later; never for a new person, never in a group's section.
 *  3. The table: every public route x every reader (visitor, member, removed member) x every post state (a known writer's
 *     topic two days public, one younger, "Introduce yourself", a new person's, a hidden one, a removed one, a group's
 *     section's (Builders), a first topic still waiting) -> shown and listed / shown and noindex / not found. A visitor and a
 *     member read the same bytes; a removed member's signed read is refused and holds nothing.
 *  4. Replies: a known writer's shown; a new person's, a hidden one and a removed one never; a quote of a post not public is
 *     no quote.
 *  5. Every unsigned answer holds only the allowed fields (@beanpool/core FORUM_PUBLIC_FIELDS) and no member's key anywhere.
 *  6. Caching: unsigned `public, max-age=0, s-maxage=60` with Vary; signed `private`; photos an hour at the edge; a refusal
 *     never public.
 *  7. Search engines: noindex until two days, always in "Introduce yourself"; the sitemap and robots.txt; canonical at the
 *     plain address, ?hl= for another language; every link in a post `nofollow ugc`.
 *  8. The invariant, as one table: every public surface (the front, a section, a topic, a quote, a photo, as JSON and as a
 *     page; the sitemap; robots.txt's sitemap line) x every way the forum can stand (public; in a private preview; the forum
 *     off; forumPublic off; a local community) x a visitor and a member -> shown only while public; otherwise closed: never
 *     200, none of its words, never kept by a shared cache. A preview stamps nothing and tells the apps nothing is public.
 *  9. Q2's exclusions hold through every edit an owner can make: "Introduce yourself" and Builders (a group's section) x
 *     (a rename, `listed: true`, `listed` set by hand, a topic moved out) and a new person's topic moved -> never indexed,
 *     never in the sitemap.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-forum-public" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.PRIVATE_PREVIEW;

import crypto from 'node:crypto';
import { FORUM_PUBLIC_FIELDS, FORUM_STARTER_SECTIONS, forumPublicShapeProblems } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, updateNodeConfig } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { markForumTold, resetForumStartersCheckForTests } from './engine/forum.js';
import { forumPublicOn, stampForumPublicFrom } from './engine/forum-public.js';
import { forgetOwnAddresses } from './engine/own-addresses.js';
import { GUEST_CACHE_CONTROL, READER_CACHE_CONTROL } from './guest-cache.js';
import { NODE_PROFILE_KEY, getNodeFeatures } from './config/node-profile.js';
import { TEST_PHOTO } from './post-test-helper.js';
import { resetPhotoBudgetForTests } from './engine/photo-upload-budget.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost, setSignedForHost } from './signed-request-test-helper.js';

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
const ADDRESS = 'riverside.example';

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
const everyone: Id[] = [];
/** A member who joined `daysAgo` days ago, told the forum is public. */
function member(name: string, daysAgo: number): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, ?, 'TEST', 'active')`)
        .run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    markForumTold(id.pk);
    everyone.push(id);
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
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');
const get = (id: Id | null, p: string) => call(id, 'GET', p);
const start = (id: Id, body: Record<string, unknown>) => call(id, 'POST', '/api/forum/topics', body);
const reply = (id: Id, t: string, body: Record<string, unknown>) => call(id, 'POST', `/api/forum/topics/${t}/replies`, body);
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);
const publicFrom = (postId: string) => (db.prepare('SELECT public_from FROM forum_posts WHERE id = ?').get(postId) as { public_from: string | null } | undefined)?.public_from ?? null;
const NOINDEX_META = '<meta name="robots" content="noindex">';

/** Every public route this slice serves, as one table's columns. */
const ROUTES = ['api front', 'api section', 'api topic', 'api photo', 'page front', 'page section', 'page topic', 'sitemap'] as const;
type Want = 'listed' | 'noindex' | 'gone';
interface Case { name: string; topicId: string; sectionId: string; postId: string; photo: boolean; group: boolean; want: Want; words: string }

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    resetPhotoBudgetForTests();

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    markForumTold(owner.pk);
    everyone.push(owner);
    // A community with a name of its own: its pages name it, and its members' apps sign for it.
    updateNodeConfig({ publicAddress: ADDRESS } as any);
    forgetOwnAddresses();
    setSignedForHost(ADDRESS);

    // ── 1. A local community ────────────────────────────────────────────────────────────────────
    console.log('── 1. a local community ──');
    require_(!forumPublicOn(), 'a local community: its forum is not public');
    const general = (await get(owner, '/api/forum')).body?.sections?.find((s: any) => s.starter === 'general')?.id as string;
    require_(general, `the local forum has its General section (${show(await get(owner, '/api/forum'))})`);
    const localTopic = await start(owner, { sectionId: general, title: 'Local words only', words: 'For members', photos: [TEST_PHOTO] });
    require_(localTopic.status === 201, `the owner starts a topic on the local forum (${show(localTopic)})`);
    const localId = localTopic.body.topic.id as string;
    const localPost = localTopic.body.post.id as string;
    assert(publicFrom(localPost) === null, 'a local community stamps nothing public, an owner\'s post included');
    const localPaths = ['/api/forum/public', `/api/forum/public/sections/${general}`, `/api/forum/public/topics/${localId}`, `/api/forum/photos/${localPost}/0`,
        '/forum', `/forum/s/${general}`, `/forum/t/${localId}`, '/forum/sitemap.xml', '/robots.txt'];
    for (const who of [null, owner] as const) {
        const wrong: string[] = [];
        for (const p of localPaths) {
            const r = await get(who, p);
            if (r.status !== 404 || r.text.includes('Local words only') || /public|s-maxage/.test(r.headers.get('cache-control') ?? '')) wrong.push(`${p} → ${show(r)} ${r.headers.get('cache-control')}`);
        }
        assert(wrong.length === 0, `a local community, ${who ? 'its owner, signed' : 'a visitor'}: every one of the ${localPaths.length} public addresses answers not found, never cached for all${wrong.length ? ` — ${wrong.join(' | ')}` : ''}`);
    }

    // ── 2. The worldwide community: public from ────────────────────────────────────────────────
    console.log('\n── 2. the worldwide community: public from ──');
    process.env.NODE_PROFILE = 'global';
    for (const t of ['forum_post_photos', 'forum_posts', 'forum_topics', 'forum_sections']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM node_config WHERE key = 'forum.startersMade'").run();
    resetForumStartersCheckForTests();
    require_(forumPublicOn(), 'the worldwide community: its forum is public');
    const mo = member('Mo', 60);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const vic = member('Vic', 60);
    const rex = member('Rex', 60);
    const kim = member('Kim', 1);
    const nia = member('Nia', 1);
    const wes = member('Wes', 1);
    const dee = member('Dee', 1);
    const sections = (await get(owner, '/api/forum')).body?.sections ?? [];
    const skills = sections.find((s: any) => s.starter === 'skills')?.id as string;
    const introduce = sections.find((s: any) => s.starter === 'introduce')?.id as string;
    require_(skills && introduce, 'the worldwide forum has Skills & how-to and Introduce yourself');
    assert(FORUM_STARTER_SECTIONS.global.find((s) => s.id === 'introduce')?.listed === false && FORUM_STARTER_SECTIONS.global.find((s) => s.id === 'skills')?.listed === true,
        'Introduce yourself is a section search engines never list; Skills & how-to may be (Q2)');
    // Builders: a section that belongs to an invite-only group (slice F8).
    const GROUP = 'grp-builders-f7';
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, lead_pubkey, join_policy) VALUES (?, 'Builders', 'builders-f7', ?, ?, 'invite_only')`).run(GROUP, owner.pk, owner.pk);
    db.prepare("INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, 'convenor', 'active', 1)").run(GROUP, owner.pk);
    const builders = await call(owner, 'POST', '/api/forum/sections', { name: 'Builders', groupId: GROUP });
    require_(builders.status === 201, `the owner makes the Builders group's section (${show(builders)})`);
    const buildersId = builders.body.section.id as string;

    const topicBy = async (id: Id, sectionId: string, title: string, words: string, photos: string[] = []) => {
        const r = await start(id, { sectionId, title, words, photos });
        require_(r.status === 201, `${id.name} starts "${title}" (${show(r)})`);
        return { topicId: r.body.topic.id as string, postId: r.body.post.id as string };
    };
    const old = await topicBy(owner, skills, 'Fixing a bike chain', 'Start at https://example.com/chains and www.example.org then ask.', [TEST_PHOTO]);
    assert(publicFrom(old.postId) !== null, 'a known writer\'s topic (an owner) is public from the moment it is written');
    const intro = await topicBy(owner, introduce, 'Hello from Olive', 'I keep bees.');
    const hidden = await topicBy(owner, skills, 'A topic reports hid', 'Hidden words here', [TEST_PHOTO]);
    db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), hidden.postId);
    const removed = await topicBy(owner, skills, 'A topic its writer removed', 'Removed words here');
    require_((await call(owner, 'POST', `/api/forum/posts/${removed.postId}/remove`)).status === 200, 'the owner removes their own topic (no other replies: gone)');
    const group = await topicBy(owner, buildersId, 'Builders only plans', 'Group words here', [TEST_PHOTO]);
    assert(publicFrom(group.postId) === null, 'a topic in a group\'s section is never stamped public, its writer known');
    // Two days public and more: what search engines may list.
    for (const t of [old, intro]) db.prepare('UPDATE forum_posts SET public_from = ?, created_at = ? WHERE id = ?').run(ago(3 * DAY), ago(3 * DAY), t.postId);

    // Kim: new; her first topic waits; Mo's OK makes her known, and the topic public from then.
    const kimHeld = await start(kim, { sectionId: skills, title: 'Kim asks about seeds', words: 'Which seeds keep?' });
    require_(kimHeld.status === 202, `a new member's first topic waits for a first look (${show(kimHeld)})`);
    const ok = await call(mo, 'POST', `/api/forum/first-looks/${kimHeld.body.waiting.id}/ok`);
    require_(ok.status === 200, `Mo OKs Kim's first topic (${show(ok)})`);
    const young = { topicId: ok.body.topicId as string, postId: db.prepare('SELECT id FROM forum_posts WHERE topic_id = ? AND number = 1').pluck().get(ok.body.topicId) as string };
    assert(publicFrom(young.postId) !== null, 'a first look\'s OK makes its topic public from then: its writer is known');
    // Wes: new; his first topic is still waiting: no topic at all.
    const wesHeld = await start(wes, { sectionId: skills, title: 'Wes waiting topic', words: 'Waiting words here' });
    require_(wesHeld.status === 202, `Wes's first topic waits (${show(wesHeld)})`);
    // Nia: new; with first looks off for a moment her topic goes up at once, and is not public.
    setOverride('forumFirstLook', 'false');
    const niaTopic = await topicBy(nia, skills, 'Nia new person topic', 'New person words here');
    dropOverride('forumFirstLook');
    assert(publicFrom(niaTopic.postId) === null, 'a new person\'s topic is not public, up or not');

    // Replies under the old topic.
    const r = async (id: Id, words: string, extra: Record<string, unknown> = {}) => {
        const res = await reply(id, old.topicId, { words, ...extra });
        require_(res.status === 201, `${id.name} replies (${show(res)})`);
        return res.body.post as { id: string; number: number };
    };
    const kimReply = await r(kim, 'Kim known reply words');
    const niaReply = await r(nia, 'Nia new reply words');
    const kimQuotesNia = await r(kim, 'Kim quoting a new person', { quotes: niaReply.number });
    const kimQuotesKim = await r(kim, 'Kim quoting herself', { quotes: kimReply.number });
    const kimHidden = await r(kim, 'Kim hidden reply words');
    db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), kimHidden.id);
    const olReply = await r(owner, 'Olive removed reply words');
    require_((await call(owner, 'POST', `/api/forum/posts/${olReply.id}/remove`)).status === 200, 'the owner removes her reply');
    const deeReply = await r(dee, 'Dee later known words');
    assert(publicFrom(kimReply.id) !== null && publicFrom(niaReply.id) === null && publicFrom(deeReply.id) === null,
        'stamped as written: a known writer\'s reply public, a new person\'s not');
    // Dee is given a role later: the hourly sweep stamps what she wrote while new.
    grantNodeRole(dee.pk, 'moderator', owner.pk);
    assert(stampForumPublicFrom() >= 1 && publicFrom(deeReply.id) !== null && publicFrom(niaReply.id) === null,
        'the sweep: a writer known since (a role given) goes public; a new person still not');
    // Rex: a member the community removed. His key signs nothing here.
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(rex.pk);

    // ── 3. The table ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. every public route x every reader x every post state ──');
    const cases: Case[] = [
        { name: 'a known writer\'s topic, 2 days public', ...old, sectionId: skills, photo: true, group: false, want: 'listed', words: 'Fixing a bike chain' },
        { name: 'a known writer\'s topic, younger', ...young, sectionId: skills, photo: false, group: false, want: 'noindex', words: 'Kim asks about seeds' },
        { name: 'Introduce yourself', ...intro, sectionId: introduce, photo: false, group: false, want: 'noindex', words: 'Hello from Olive' },
        { name: 'a new person\'s topic', ...niaTopic, sectionId: skills, photo: false, group: false, want: 'gone', words: 'Nia new person topic' },
        { name: 'a hidden topic', ...hidden, sectionId: skills, photo: true, group: false, want: 'gone', words: 'A topic reports hid' },
        { name: 'a removed topic', ...removed, sectionId: skills, photo: false, group: false, want: 'gone', words: 'Removed words here' },
        { name: 'Builders (a group\'s section)', ...group, sectionId: buildersId, photo: true, group: true, want: 'gone', words: 'Builders only plans' },
        { name: 'a first topic still waiting', topicId: wesHeld.body.waiting.id, postId: wesHeld.body.waiting.id, sectionId: skills, photo: false, group: false, want: 'gone', words: 'Wes waiting topic' },
    ];
    /** What one route shows of one case, read by one reader: listed, noindex or gone; and the bytes it answered. */
    const observe = async (route: typeof ROUTES[number], c: Case, who: Id | null): Promise<{ got: Want | 'refused' | 'n/a'; res: Res }> => {
        const sec = c.group ? buildersId : c.sectionId;
        const paths: Record<typeof ROUTES[number], string> = {
            'api front': '/api/forum/public', 'api section': `/api/forum/public/sections/${sec}`, 'api topic': `/api/forum/public/topics/${c.topicId}`,
            'api photo': `/api/forum/photos/${c.postId}/0`, 'page front': '/forum', 'page section': `/forum/s/${sec}`, 'page topic': `/forum/t/${c.topicId}`,
            sitemap: '/forum/sitemap.xml',
        };
        const res = await get(who, paths[route]);
        if (res.status === 403 && res.body?.code === 'account_closed') return { got: 'refused', res };
        if (route === 'api photo' && !c.photo) return { got: 'n/a', res };
        if (res.status === 404) return { got: 'gone', res };
        if (res.status !== 200) return { got: 'refused', res };
        switch (route) {
            case 'api front': case 'api section': {
                const t = (res.body?.topics ?? []).find((x: any) => x.id === c.topicId);
                return { got: !t ? 'gone' : t.indexable ? 'listed' : 'noindex', res };
            }
            case 'api topic': return { got: res.body?.topic?.indexable ? 'listed' : 'noindex', res };
            case 'api photo': return { got: c.want === 'gone' ? 'listed' : c.want, res };
            case 'page front': case 'page section': return { got: res.text.includes(`data-topic="${c.topicId}"`) ? c.want === 'gone' ? 'listed' : c.want : 'gone', res };
            case 'page topic': return { got: res.text.includes(NOINDEX_META) && res.headers.get('x-robots-tag') === 'noindex' ? 'noindex' : 'listed', res };
            case 'sitemap': return { got: res.text.includes(`/forum/t/${c.topicId}<`) ? 'listed' : c.want === 'noindex' ? 'noindex' : 'gone', res };
        }
    };
    let cells = 0;
    for (const c of cases) {
        const wrong: string[] = [];
        for (const route of ROUTES) {
            const visitor = await observe(route, c, null);
            const memberRead = await observe(route, c, vic);
            const removedRead = await observe(route, c, rex);
            cells += 3;
            if (visitor.got !== 'n/a' && visitor.got !== c.want) wrong.push(`${route}: a visitor ${visitor.got} (${show(visitor.res)})`);
            if (memberRead.got !== visitor.got) wrong.push(`${route}: a member ${memberRead.got}, a visitor ${visitor.got}`);
            if (route !== 'api photo' && memberRead.res.text !== visitor.res.text) wrong.push(`${route}: a member's bytes differ from a visitor's`);
            if (removedRead.got !== 'refused' || removedRead.res.text.includes(c.words)) wrong.push(`${route}: a removed member ${removedRead.got} (${show(removedRead.res)})`);
            if (c.want === 'gone' && route !== 'api photo' && visitor.res.text.includes(c.words)) wrong.push(`${route}: its words reach a visitor`);
        }
        assert(wrong.length === 0, `${c.name}: ${c.want} on all ${ROUTES.length} public routes for a visitor and a member alike; a removed member refused${wrong.length ? ` — ${wrong.slice(0, 5).join(' | ')}` : ''}`);
    }
    assert(cells === cases.length * ROUTES.length * 3, `the table read ${cells} cells (${cases.length} states x ${ROUTES.length} routes x 3 readers)`);
    const removedPlain = await get(null, `/forum/t/${old.topicId}`);
    assert(removedPlain.status === 200 && removedPlain.text.includes('Fixing a bike chain'), 'a removed member in a plain browser (unsigned) reads what any visitor reads');

    // ── 4. Replies ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. replies ──');
    const oldTopic = await get(null, `/api/forum/public/topics/${old.topicId}`);
    const numbers = ((oldTopic.body?.posts ?? []) as any[]).map((p) => p.words);
    assert(numbers.includes('Kim known reply words') && numbers.includes('Dee later known words'), `a known writer's replies are shown, one known since included (${numbers.join(' / ')})`);
    for (const words of ['Nia new reply words', 'Kim hidden reply words', 'Olive removed reply words']) {
        assert(!oldTopic.text.includes(words) && !(await get(null, `/forum/t/${old.topicId}`)).text.includes(words), `never on a public answer or page: "${words}"`);
    }
    const posts = (oldTopic.body?.posts ?? []) as any[];
    assert(posts.find((p) => p.id === kimQuotesNia.id)?.quotes === null && posts.find((p) => p.id === kimQuotesKim.id)?.quotes === kimReply.number,
        'a quote of a post that is not public is no quote; of a public one it is its number');
    assert(oldTopic.body?.topic?.replyCount === 4, `the reply count counts public replies only (${oldTopic.body?.topic?.replyCount})`);

    // ── 5. The shape ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. only the allowed fields ──');
    const answers = [await get(null, '/api/forum/public'), await get(null, `/api/forum/public/sections/${skills}`), oldTopic, await get(null, `/api/forum/public/topics/${young.topicId}`)];
    const problems: string[] = [];
    const tops = [['next', 'sections', 'topics'], ['next', 'section', 'topics'], ['next', 'posts', 'section', 'topic'], ['next', 'posts', 'section', 'topic']];
    answers.forEach((a, i) => {
        if (JSON.stringify(Object.keys(a.body ?? {}).sort()) !== JSON.stringify(tops[i])) problems.push(`answer ${i}: ${Object.keys(a.body ?? {}).join(',')}`);
        for (const s of [...(a.body?.sections ?? []), ...(a.body?.section ? [a.body.section] : [])]) problems.push(...forumPublicShapeProblems('section', s));
        for (const t of [...(a.body?.topics ?? []), ...(a.body?.topic ? [a.body.topic] : [])]) problems.push(...forumPublicShapeProblems('topic', t));
        for (const p of a.body?.posts ?? []) problems.push(...forumPublicShapeProblems('post', p));
        for (const who of everyone) if (a.text.includes(who.pk)) problems.push(`answer ${i}: ${who.name}'s key`);
    });
    assert(problems.length === 0 && answers.every((a) => a.status === 200), `every unsigned answer holds only ${Object.values(FORUM_PUBLIC_FIELDS).flat().length} allowed fields and no member's key${problems.length ? ` — ${problems.slice(0, 6).join(' | ')}` : ''}`);
    assert(forumPublicShapeProblems('post', { ...posts[0], publicKey: owner.pk }).includes('post.publicKey'), 'the check fails a field not on the list (it can fail)');
    const groupFront = await get(null, '/api/forum/public');
    assert(!(groupFront.body?.sections ?? []).some((s: any) => s.id === buildersId) && !groupFront.text.includes('Builders'), 'the front never lists the Builders section, nor its name');

    // ── 6. Caching ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. caching ──');
    const reads = ['/api/forum/public', `/api/forum/public/sections/${skills}`, `/api/forum/public/topics/${old.topicId}`, '/forum', `/forum/s/${skills}`, `/forum/t/${old.topicId}`, '/forum/sitemap.xml', '/robots.txt'];
    const cacheWrong: string[] = [];
    for (const p of reads) {
        const u = await get(null, p);
        const s = await get(vic, p);
        if (u.status !== 200 || u.headers.get('cache-control') !== GUEST_CACHE_CONTROL || !/x-public-key/i.test(u.headers.get('vary') ?? '')) cacheWrong.push(`${p} unsigned ${u.status} ${u.headers.get('cache-control')} vary=${u.headers.get('vary')}`);
        if (s.status !== 200 || s.headers.get('cache-control') !== READER_CACHE_CONTROL) cacheWrong.push(`${p} signed ${s.status} ${s.headers.get('cache-control')}`);
    }
    assert(cacheWrong.length === 0, `all ${reads.length} public reads: unsigned ${GUEST_CACHE_CONTROL} varying on the signature, signed ${READER_CACHE_CONTROL}${cacheWrong.length ? ` — ${cacheWrong.join(' | ')}` : ''}`);
    const photoU = await get(null, `/api/forum/photos/${old.postId}/0`);
    const photoS = await get(vic, `/api/forum/photos/${old.postId}/0`);
    assert(photoU.status === 200 && photoU.headers.get('cache-control') === 'public, max-age=31536000, s-maxage=3600, immutable' && (photoU.headers.get('content-type') ?? '').startsWith('image/'),
        `a public photo: a year in the browser, an hour at the edge (${photoU.status} ${photoU.headers.get('cache-control')})`);
    assert(photoS.status === 200 && (photoS.headers.get('cache-control') ?? '').startsWith('private') && !/s-maxage/.test(photoS.headers.get('cache-control') ?? ''),
        `a signed read of it is the reader's own (${photoS.headers.get('cache-control')})`);
    const refusals = [await get(null, `/api/forum/public/topics/${hidden.topicId}`), await get(null, `/forum/t/${hidden.topicId}`), await get(null, `/api/forum/photos/${hidden.postId}/0`)];
    assert(refusals.every((x) => x.status === 404 && !/public|s-maxage/.test(x.headers.get('cache-control') ?? '')), 'a not found is never kept by a shared cache');

    // ── 7. Search engines ───────────────────────────────────────────────────────────────────────
    console.log('\n── 7. search engines ──');
    const robots = await get(null, '/robots.txt');
    assert(robots.status === 200 && /Allow: \/forum/.test(robots.text) && /Disallow: \/api\//.test(robots.text) && /Disallow: \/app\//.test(robots.text) && /Disallow: \/settings/.test(robots.text)
        && robots.text.includes(`Sitemap: https://${ADDRESS}/forum/sitemap.xml`), `robots.txt: the forum read, the API, the web app's pages and Settings not, the sitemap named (${robots.text.replace(/\n/g, ' ')})`);
    const sitemap = await get(null, '/forum/sitemap.xml');
    assert(sitemap.text.includes(`<loc>https://${ADDRESS}/forum</loc>`) && sitemap.text.includes(`/forum/s/${skills}<`) && !sitemap.text.includes(`/forum/s/${introduce}<`) && !sitemap.text.includes(buildersId),
        'the sitemap lists the forum and Skills & how-to, never Introduce yourself or Builders');
    const sectionPages = [await get(null, `/forum/s/${skills}`), await get(null, `/forum/s/${introduce}`)];
    assert(!sectionPages[0].text.includes(NOINDEX_META) && sectionPages[1].text.includes(NOINDEX_META) && sectionPages[1].headers.get('x-robots-tag') === 'noindex',
        'a listed section\'s page may be listed; Introduce yourself\'s page is noindex');
    const page = await get(null, `/forum/t/${old.topicId}`);
    assert(page.text.includes(`<link rel="canonical" href="https://${ADDRESS}/forum/t/${old.topicId}">`), 'a topic page names its plain address as canonical');
    assert(page.text.includes('href="https://example.com/chains" rel="nofollow ugc noopener"') && page.text.includes('href="https://www.example.org" rel="nofollow ugc noopener"'),
        'every link in a post is marked nofollow ugc');
    assert(!page.text.includes('<script') && !page.text.includes('/api/avatar/') && page.text.includes(`/api/forum/photos/${old.postId}/0`), 'the page runs no script, shows no picture of a person, and shows the post\'s photo');
    assert(page.text.includes(`href="/app?forumTopic=${old.topicId}"`), 'Join to reply opens the web app on that topic');
    const fr = await get(null, `/forum/t/${old.topicId}?hl=fr`);
    assert(fr.status === 200 && fr.text.includes('<html lang="fr"') && fr.text.includes(`<link rel="canonical" href="https://${ADDRESS}/forum/t/${old.topicId}">`),
        'another language at ?hl=, its canonical the plain address');

    // ── 8. The invariant: every public surface x every way the forum can stand ──────────────────────────────
    console.log('\n── 8. every public surface x public / private preview / forum off / forumPublic off / local ──');
    const OLD_WORDS = 'Fixing a bike chain';
    const imageOf = (x: Res) => (x.headers.get('content-type') ?? '').startsWith('image/');
    const listsOld = (x: Res) => ((x.body?.topics ?? []) as any[]).some((t) => t.id === old.topicId);
    const SURFACES: { name: string; path: string; shown: (x: Res) => boolean }[] = [
        { name: 'JSON front', path: '/api/forum/public', shown: listsOld },
        { name: 'JSON section', path: `/api/forum/public/sections/${skills}`, shown: listsOld },
        { name: 'JSON topic', path: `/api/forum/public/topics/${old.topicId}`, shown: (x) => x.body?.topic?.id === old.topicId && x.text.includes(OLD_WORDS) },
        { name: 'JSON quote', path: `/api/forum/public/topics/${old.topicId}`, shown: (x) => ((x.body?.posts ?? []) as any[]).find((p) => p.id === kimQuotesKim.id)?.quotes === kimReply.number },
        { name: 'photo', path: `/api/forum/photos/${old.postId}/0`, shown: imageOf },
        { name: 'page front', path: '/forum', shown: (x) => x.text.includes(`data-topic="${old.topicId}"`) },
        { name: 'page section', path: `/forum/s/${skills}`, shown: (x) => x.text.includes(`data-topic="${old.topicId}"`) },
        { name: 'page topic', path: `/forum/t/${old.topicId}`, shown: (x) => x.text.includes(OLD_WORDS) },
        { name: 'sitemap', path: '/forum/sitemap.xml', shown: (x) => x.text.includes(`/forum/t/${old.topicId}<`) },
        { name: 'robots.txt sitemap line', path: '/robots.txt', shown: (x) => x.text.includes(`Sitemap: https://${ADDRESS}/forum/sitemap.xml`) && /Allow: \/forum/.test(x.text) },
    ];
    const MODES: { name: string; public: boolean; on: () => void; off: () => void }[] = [
        { name: 'public', public: true, on: () => {}, off: () => {} },
        { name: 'a private preview', public: false, on: () => { process.env.PRIVATE_PREVIEW = '1'; }, off: () => { delete process.env.PRIVATE_PREVIEW; } },
        { name: 'the forum off', public: false, on: () => setOverride('forum', 'false'), off: () => dropOverride('forum') },
        { name: 'forumPublic off', public: false, on: () => setOverride('forumPublic', 'false'), off: () => dropOverride('forumPublic') },
        { name: 'a local community', public: false, on: () => { delete process.env.NODE_PROFILE; }, off: () => { process.env.NODE_PROFILE = 'global'; } },
    ];
    /** Closed: not a 200, none of the topic's words or address, nothing for robots to follow, and never kept by a shared cache. */
    const closed = (s: typeof SURFACES[number], x: Res) => {
        const cc = x.headers.get('cache-control') ?? '';
        return x.status !== 200 && !x.text.includes(OLD_WORDS) && !x.text.includes(old.topicId) && !imageOf(x)
            && !/Sitemap:|\/forum/.test(s.name.startsWith('robots') ? x.text : '') && !/public|s-maxage/.test(cc) && /private|no-store/.test(cc);
    };
    let surfaceCells = 0;
    for (const mode of MODES) {
        mode.on();
        try {
            assert(forumPublicOn() === mode.public, `${mode.name}: the forum ${mode.public ? 'is' : 'is not'} public (forumPublicOn ${forumPublicOn()})`);
            const wrong: string[] = [];
            for (const s of SURFACES) {
                for (const who of [null, vic] as const) {
                    surfaceCells++;
                    const x = await get(who, s.path);
                    const cc = x.headers.get('cache-control') ?? '';
                    const ok = mode.public
                        ? x.status === 200 && s.shown(x) && (who ? cc.startsWith('private') : s.name === 'photo' ? cc.startsWith('public, max-age=31536000') : cc === GUEST_CACHE_CONTROL)
                        : closed(s, x);
                    if (!ok) wrong.push(`${s.name}, ${who ? 'a member' : 'a visitor'}: ${show(x)} [${cc}]`);
                }
            }
            assert(wrong.length === 0, `${mode.name}: all ${SURFACES.length} public surfaces ${mode.public ? 'shown, cached for all only unsigned' : 'closed to a visitor and a member alike, never cacheable'}${wrong.length ? ` — ${wrong.slice(0, 6).join(' | ')}` : ''}`);
        } finally {
            mode.off();
        }
    }
    assert(surfaceCells === MODES.length * SURFACES.length * 2, `the invariant table read ${surfaceCells} cells (${SURFACES.length} surfaces x ${MODES.length} modes x 2 readers)`);
    // A preview stamps nothing (what is written in it goes public once it ends, by the sweep) and tells the apps nothing is public.
    const featuresPublic = getNodeFeatures();
    process.env.PRIVATE_PREVIEW = '1';
    try {
        const featuresPreview = getNodeFeatures() as any;
        assert(featuresPublic.forumPublic === true && featuresPreview.forumPublic === undefined && featuresPreview.privatePreview === true && featuresPreview.forum === true,
            `a private preview: features keep the forum for members but say nothing is public (${JSON.stringify({ forumPublic: featuresPreview.forumPublic, privatePreview: featuresPreview.privatePreview })})`);
        const inPreview = await reply(owner, old.topicId, { words: 'Written in the preview' });
        require_(inPreview.status === 201, `a member replies in a private preview (${show(inPreview)})`);
        assert(publicFrom(inPreview.body.post.id) === null && stampForumPublicFrom() === 0, 'a private preview stamps nothing public, at the write or by the sweep');
        delete process.env.PRIVATE_PREVIEW;
        assert(stampForumPublicFrom() >= 1 && publicFrom(inPreview.body.post.id) !== null, 'once the preview ends, the sweep makes a known writer\'s words public');
    } finally {
        delete process.env.PRIVATE_PREVIEW;
    }

    // ── 9. Q2's exclusions hold through every edit an owner can make ────────────────────────────────────
    console.log('\n── 9. "Introduce yourself", Builders and a new person\'s words x rename / listed / move ──');
    const intro2 = await topicBy(owner, introduce, 'Bees and honey hello', 'We keep two hives.');
    db.prepare('UPDATE forum_posts SET public_from = ?, created_at = ? WHERE id = ?').run(ago(3 * DAY), ago(3 * DAY), intro2.postId);
    const startCommunity = sections.find((s: any) => s.starter === 'start-community')?.id as string;
    require_(startCommunity, 'the worldwide forum has Start a community near you');
    /** Where a topic (and its section, when given) could still reach a search engine: an empty list means never. */
    const indexedAt = async (topicId: string, sectionId: string | null): Promise<string[]> => {
        const out: string[] = [];
        const j = await get(null, `/api/forum/public/topics/${topicId}`);
        if (!(j.status === 404 || (j.status === 200 && j.body?.topic?.indexable === false))) out.push(`JSON ${j.status} indexable=${j.body?.topic?.indexable}`);
        const p = await get(null, `/forum/t/${topicId}`);
        if (!(p.status === 404 || (p.text.includes(NOINDEX_META) && p.headers.get('x-robots-tag') === 'noindex'))) out.push(`page ${p.status} listed`);
        const map = (await get(null, '/forum/sitemap.xml')).text;
        if (map.includes(`/forum/t/${topicId}<`)) out.push('in the sitemap');
        if (sectionId) {
            if (map.includes(`/forum/s/${sectionId}<`)) out.push('its section in the sitemap');
            const sp = await get(null, `/forum/s/${sectionId}`);
            if (!(sp.status === 404 || (sp.text.includes(NOINDEX_META) && sp.headers.get('x-robots-tag') === 'noindex'))) out.push(`section page ${sp.status} listed`);
        }
        return out;
    };
    const control = await indexedAt(old.topicId, skills);
    assert(control.length >= 4, `the check can fail: a Skills topic 2 days public is indexed everywhere (${control.join(', ')})`);
    const edit = (id: string, body: Record<string, unknown>) => call(owner, 'POST', `/api/forum/sections/${id}/edit`, body);
    const listedNow = (id: string) => db.prepare('SELECT listed FROM forum_sections WHERE id = ?').pluck().get(id);
    const introTopics = [{ id: intro.topicId, section: introduce }, { id: intro2.topicId, section: introduce }];
    const rows: { name: string; act: () => Promise<boolean>; topics: { id: string; section: string | null }[] }[] = [
        {
            name: 'Introduce yourself, renamed', topics: introTopics,
            act: async () => { const x = await edit(introduce, { name: 'Say hello' }); return x.status === 200 && x.body?.section?.starter === null && x.body?.section?.name === 'Say hello'; },
        },
        {
            name: 'Introduce yourself, renamed, then listed: true', topics: introTopics,
            act: async () => { const x = await edit(introduce, { listed: true }); return x.status === 400 && x.body?.code === 'starter_unlisted' && listedNow(introduce) === 0; },
        },
        {
            name: 'Introduce yourself, listed set by hand', topics: introTopics,
            act: async () => { db.prepare('UPDATE forum_sections SET listed = 1 WHERE id = ?').run(introduce); return true; },
        },
        {
            name: 'a topic moved out of Introduce yourself into Skills', topics: [{ id: intro2.topicId, section: null }],
            act: async () => { const x = await call(owner, 'POST', `/api/forum/topics/${intro2.topicId}/move`, { sectionId: skills }); return x.status === 200 && x.body?.topic?.sectionId === skills; },
        },
        { name: 'Builders, renamed', topics: [{ id: group.topicId, section: buildersId }], act: async () => (await edit(buildersId, { name: 'Builders crew' })).status === 200 },
        {
            name: 'Builders, listed: true', topics: [{ id: group.topicId, section: buildersId }],
            act: async () => { const x = await edit(buildersId, { listed: true }); return x.status === 400 && x.body?.code === 'group_unlisted'; },
        },
        {
            name: 'a topic moved out of Builders', topics: [{ id: group.topicId, section: buildersId }],
            act: async () => (await call(owner, 'POST', `/api/forum/topics/${group.topicId}/move`, { sectionId: skills })).body?.code === 'group_section',
        },
        {
            name: 'a new person\'s topic moved to another listed section', topics: [{ id: niaTopic.topicId, section: null }],
            act: async () => (await call(owner, 'POST', `/api/forum/topics/${niaTopic.topicId}/move`, { sectionId: startCommunity })).status === 200,
        },
    ];
    for (const row of rows) {
        const acted = await row.act();
        const leaks: string[] = [];
        for (const t of row.topics) for (const l of await indexedAt(t.id, t.section)) leaks.push(`${t.id === intro2.topicId ? 'Bees' : t.id === intro.topicId ? 'Hello' : 'its topic'}: ${l}`);
        assert(acted && leaks.length === 0, `${row.name}: the edit ${acted ? 'did as it should' : 'did NOT do as it should'}; never indexed, never in the sitemap${leaks.length ? ` — ${leaks.join(' | ')}` : ''}`);
    }
    db.prepare('UPDATE forum_sections SET listed = 0 WHERE id = ?').run(introduce);
    const membersIntro = ((await get(owner, '/api/forum')).body?.sections ?? []).find((s: any) => s.id === introduce);
    assert(membersIntro?.starter === null && membersIntro?.name === 'Say hello', `the members' front reads a renamed starter as before: starter null, the name as typed (${JSON.stringify(membersIntro)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
