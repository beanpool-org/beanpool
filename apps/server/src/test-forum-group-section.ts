/**
 * A forum section tied to a group, a poll in a topic, the polls' own pool and the Decision chip: slice F8, through the real
 * HTTPS stack and its signature middleware (scratch/fable-design/DESIGN-forums-fable.md §4, §8, §9, §10.1, §11, §16, §20,
 * §21 F8 "test-forum-group-section.ts"; the joint design §2.3; engine/forum-sections.ts holds the one rule).
 *
 *  1. Sections: an owner or admin ties a new section to a group (its name comes back with it); never listed for search
 *     engines; the group is fixed once made; a convenor who is no owner cannot make one; an unknown group is refused.
 *  2. Close the class: one table over every read and write that can touch a section (the front's list, the topic list, the
 *     section's list, a topic, a photo, a reply, a new topic, search, follow, the bell, a poll vote, a poll result, a report)
 *     x (member, convenor, observer, a member of the community outside the group, a pending, an invited and a removed one,
 *     a member who left, a guest from another community, a visitor, an owner, a moderator) -> the expected answer. A
 *     non-member of the group gets "not found", exactly as for an id nobody has: no section, no topic, no hit, no row, no
 *     count. The group's convenors and members write; its observers, the owners and the moderators read.
 *  3. The bell and the doorbells: a member who leaves loses the section's bell rows at once (the list and by id), is told of
 *     nothing more there (a quote of their reply included), and hears no doorbell; activity in the section nudges only its
 *     readers' lists.
 *  4. A poll in a topic: its writer only, one a topic, an open topic; in a group's section only the group's convenors and
 *     members vote (the result counts members' votes alone); a topic's answer names its poll to whoever may see it.
 *  5. The polls' pool: three open a section, still one open a member, and the community's five untouched (topic polls are
 *     not counted there, nor in the one community poll a week).
 *  6. The Decision chip: the topic's writer or an owner or admin links one of the community's Decisions; anyone who may read
 *     the topic sees its title and state; an unknown Decision is refused; switched off where Decisions are off.
 *  7. A topic never moves into or out of a group's section; a writer who left may still remove their own words, not edit
 *     them; a first topic waiting in a group's section is answered `section_gone` once its writer cannot write there.
 *  8. A standby answers the same: every read of the table answers on it as on the main server, from an import of the copy
 *     (the new table and columns in it), and every write answers 503 `standby`.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-forum-group-section" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, exportSyncState, broadcast, createPost } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { markForumTold, resetForumStartersCheckForTests } from './engine/forum.js';
import { resetForumSearchBudget } from './engine/forum-search.js';
import { resetForumDoorbellsForTests, tellForumReply, tellForumTopic, type ForumNoticeCallbacks } from './engine/forum-notices.js';
import { importPlainTables } from './engine/plain-tables.js';
import { TABLES } from './engine/replication-manifest.js';
import { nextPollStartAt } from './engine/poll-week.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import { TEST_PHOTO } from './post-test-helper.js';
import { FORUM_LIMITS } from '@beanpool/core';
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
/** A member who joined 60 days ago (known in the forum), invited by the owner, told the forum is public. */
function member(name: string, visitor = false): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor) VALUES (?, ?, ?, ?, 'TEST', 'active', ?)`)
        .run(id.pk, name, ago(60 * DAY), owner.pk, visitor ? 1 : 0);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    if (!visitor) markForumTold(id.pk);
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
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 200)}` : '-');
/** The Market's feed answers a list of posts. */
const feed = (r: Res): any[] => (Array.isArray(r.body) ? r.body : []);
/** The two codes a key that is no member here is turned away with, at the gateway or the forum's own door, read as one. */
const stranger = (code: unknown) => (code === 'not_member' || code === 'not_a_member' ? 'stranger' : code);

const start = (id: Id, body: Record<string, unknown>) => call(id, 'POST', '/api/forum/topics', body);
const reply = (id: Id, t: string, body: Record<string, unknown>) => call(id, 'POST', `/api/forum/topics/${t}/replies`, body);
const addPoll = (id: Id, t: string, body: Record<string, unknown> = {}) =>
    call(id, 'POST', `/api/forum/topics/${t}/poll`, { question: 'Which day suits?', options: ['Monday', 'Tuesday'], durationDays: 7, ...body });
async function search(id: Id, q: string): Promise<Res> {
    resetForumSearchBudget();
    return call(id, 'GET', `/api/forum/search?q=${encodeURIComponent(q)}`);
}
/** A mark no key, id or other word holds: z and q are not hex, and each is a run of letters the index reads as one word. */
const mark = () => `zq${crypto.randomBytes(4).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`;
const FORUM_TABLES = Object.keys(TABLES).filter((t) => t.startsWith('forum_') && t !== 'forum_search');
const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** A poll for everyone here, by the server's own door (createPost), as a member's app makes one. */
function communityPoll(author: Id): { ok: boolean; error: string } {
    try {
        createPost('poll', 'community', `Community poll by ${author.name}`, 'Say which.', 0, 'fixed', author.pk, undefined, undefined, [], false, undefined, false,
            { pollOptions: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }], durationDays: 7 });
        return { ok: true, error: '' };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    markForumTold(owner.pk);
    const mo = member('Mo');
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const [cora, gil, obi, lea, pat, rex, ian, nel] = ['Cora', 'Gil', 'Obi', 'Lea', 'Pat', 'Rex', 'Ian', 'Nel'].map((n) => member(n));
    const vic = member('Vic', true);
    // A guest from another community: a key with no row here. Where group guests exist (slice G1), one who is IN the group.
    const gwen = newId('Gwen');

    const GROUP = 'grp-workers-f8';
    const OTHER_GROUP = 'grp-garden-f8';
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, lead_pubkey, join_policy) VALUES (?, 'Workers', 'workers-f8', ?, ?, 'invite_only')`).run(GROUP, cora.pk, cora.pk);
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, lead_pubkey, join_policy) VALUES (?, 'Garden', 'garden-f8', ?, ?, 'open')`).run(OTHER_GROUP, nel.pk, nel.pk);
    const addMember = (g: string, who: Id, role: string, status: string) =>
        db.prepare('INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, ?, ?, 1)').run(g, who.pk, role, status);
    addMember(GROUP, cora, 'convenor', 'active');
    addMember(GROUP, gil, 'member', 'active');
    addMember(GROUP, obi, 'observer', 'active');
    addMember(GROUP, lea, 'member', 'active');
    addMember(GROUP, pat, 'member', 'pending_approval');
    addMember(GROUP, ian, 'member', 'invited');
    addMember(GROUP, rex, 'member', 'removed');
    addMember(OTHER_GROUP, nel, 'convenor', 'active');
    addMember(OTHER_GROUP, gil, 'member', 'active');
    if (hasTable('group_guests')) {
        db.prepare(`INSERT INTO group_guests (group_id, guest_key, home, name, state, invited_by, invited_at, state_at) VALUES (?, ?, 'riverside.example', 'Gwen', 'in', ?, ?, ?)`)
            .run(GROUP, gwen.pk, cora.pk, new Date().toISOString(), new Date().toISOString());
    }

    // ── 1. Sections ─────────────────────────────────────────────────────────────────────────────
    console.log('── 1. sections ──');
    const general = ((await call(nel, 'GET', '/api/forum')).body?.sections ?? []).find((s: any) => s.starter === 'general')?.id as string;
    const ideas = ((await call(nel, 'GET', '/api/forum')).body?.sections ?? []).find((s: any) => s.starter === 'ideas-local')?.id as string;
    require_(general && ideas, 'the local forum has General and Ideas for our community');
    const made = await call(owner, 'POST', '/api/forum/sections', { name: 'Workers talk', groupId: GROUP });
    require_(made.status === 201 && made.body?.section?.group?.id === GROUP && made.body.section.group.name === 'Workers' && made.body.section.listed === false,
        `1. an owner ties a new section to a group, its name with it (${show(made)})`);
    const S = made.body.section.id as string;
    const gardenSection = await call(owner, 'POST', '/api/forum/sections', { name: 'Garden talk', groupId: OTHER_GROUP });
    require_(gardenSection.status === 201, `an owner ties another section to another group (${show(gardenSection)})`);
    const G2 = gardenSection.body.section.id as string;
    const listedRefused = await call(owner, 'POST', '/api/forum/sections', { name: 'Listed', groupId: GROUP, listed: true });
    assert(listedRefused.status === 400 && listedRefused.body?.code === 'group_unlisted', `1. a group's section is never listed for search engines (${show(listedRefused)})`);
    const noGroup = await call(owner, 'POST', '/api/forum/sections', { name: 'Nobody', groupId: 'grp-none' });
    assert(noGroup.status === 404 && noGroup.body?.code === 'group_not_found', `1. an unknown group is refused (${show(noGroup)})`);
    const convenorMakes = await call(cora, 'POST', '/api/forum/sections', { name: 'Ours', groupId: GROUP });
    assert(convenorMakes.status === 403 && convenorMakes.body?.code === 'staff_only', `1. a convenor who is no owner or admin cannot make one (${show(convenorMakes)})`);
    const fixed = await call(owner, 'POST', `/api/forum/sections/${S}/edit`, { groupId: OTHER_GROUP });
    const unlist = await call(owner, 'POST', `/api/forum/sections/${S}/edit`, { listed: true });
    const untie = await call(owner, 'POST', `/api/forum/sections/${S}/edit`, { groupId: null });
    assert(fixed.status === 400 && fixed.body?.code === 'group_fixed' && untie.status === 400 && untie.body?.code === 'group_fixed'
        && unlist.status === 400 && unlist.body?.code === 'group_unlisted',
        `1. the group is fixed once made, and the section stays unlisted (${show(fixed)} | ${show(untie)} | ${show(unlist)})`);
    const renamed = await call(owner, 'POST', `/api/forum/sections/${S}/edit`, { about: 'Our working group' });
    assert(renamed.status === 200 && renamed.body?.section?.group?.id === GROUP, `1. an edit keeps its group (${show(renamed)})`);
    const tooManySections = (db.prepare('SELECT COUNT(*) FROM forum_sections WHERE archived_at IS NULL').pluck().get() as number) <= FORUM_LIMITS.sections;
    require_(tooManySections, 'within the section limit');

    // The section's talk: Gil's topic with a photo, Lea's reply, Cora's reply; and a control topic in General by Nel.
    const word = mark();
    const T0 = await start(gil, { sectionId: S, title: `Workers plan ${word}`, words: `Opening words ${word}`, photos: [TEST_PHOTO] });
    require_(T0.status === 201, `a group member starts a topic in the group's section (${show(T0)})`);
    const T = T0.body.topic.id as string;
    const opening = T0.body.post.id as string;
    const leaReply = await reply(lea, T, { words: `Lea here ${word}` });
    require_(leaReply.status === 201, `a group member replies (${show(leaReply)})`);
    const coraReply = await reply(cora, T, { words: `Cora here ${word}` });
    require_(coraReply.status === 201, `the convenor replies (${show(coraReply)})`);
    const coraPost = coraReply.body.post.id as string;
    const P0 = await start(nel, { sectionId: general, title: `Open plan ${word}`, words: `Everyone ${word}` });
    require_(P0.status === 201, `a control topic in General (${show(P0)})`);
    const P = P0.body.topic.id as string;

    // ── 4. A poll in a topic (made here, so the table can vote) ──────────────────────────────────
    console.log('── 4. a poll in a topic ──');
    const notWriter = await addPoll(cora, T);
    assert(notWriter.status === 403 && notWriter.body?.code === 'not_yours', `4. only the topic's writer adds a poll (${show(notWriter)})`);
    const outsider = await addPoll(nel, T);
    assert(outsider.status === 404 && outsider.body?.code === 'not_found', `4. someone outside the group: the topic is not found (${show(outsider)})`);
    const badPoll = await addPoll(gil, T, { options: ['Only one'] });
    assert(badPoll.status === 400, `4. the ordinary poll's checks hold (two to four answers) (${show(badPoll)})`);
    const poll0 = await addPoll(gil, T);
    require_(poll0.status === 201 && typeof poll0.body?.pollId === 'string' && poll0.body?.topic?.pollId === poll0.body.pollId,
        `4. the writer adds a poll; the topic names it (${show(poll0)})`);
    const POLL = poll0.body.pollId as string;
    const pollRow = db.prepare('SELECT audience_scope, target_group_id, type, status FROM posts WHERE id = ?').get(POLL) as any;
    assert(pollRow?.type === 'poll' && pollRow.audience_scope === 'group' && pollRow.target_group_id === GROUP && pollRow.status === 'active',
        `4. it is the ordinary poll, for the section's group (${JSON.stringify(pollRow)})`);
    const second = await addPoll(gil, T);
    assert(second.status === 409 && second.body?.code === 'poll_already', `4. one poll a topic (${show(second)})`);

    // Lea leaves the group after writing (her row goes, as leaving deletes it): from here she is a member who left.
    resetForumDoorbellsForTests();
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?').run(GROUP, lea.pk);

    // ── 2. The table ────────────────────────────────────────────────────────────────────────────
    console.log('── 2. every read and write x every reader ──');
    type Who = 'writer' | 'reader' | 'observer' | 'staff' | 'outside' | 'stranger';
    const actors: { id: Id; label: string; who: Who }[] = [
        { id: gil, label: 'member (the topic\'s writer)', who: 'writer' },
        { id: cora, label: 'convenor', who: 'reader' },
        { id: obi, label: 'observer', who: 'observer' },
        { id: owner, label: 'owner', who: 'staff' },
        { id: mo, label: 'moderator', who: 'staff' },
        { id: nel, label: 'member outside the group', who: 'outside' },
        { id: pat, label: 'pending', who: 'outside' },
        { id: ian, label: 'invited', who: 'outside' },
        { id: rex, label: 'removed', who: 'outside' },
        { id: lea, label: 'left', who: 'outside' },
        { id: gwen, label: 'guest', who: 'stranger' },
        { id: vic, label: 'visitor', who: 'stranger' },
    ];
    // Everyone tries to follow the topic first: readers may, nobody else hears it exists.
    for (const a of actors) await call(a.id, 'POST', `/api/forum/topics/${T}/follow`, { follow: 'following' });
    // A reply by the convenor that names everyone: the bell rows the table reads.
    const named = await reply(cora, T, { words: `Hello ${actors.map((a) => `@${a.id.name}`).slice(0, FORUM_LIMITS.mentions).join(' ')} ${word}` });
    require_(named.status === 201, `the convenor replies again (${show(named)})`);

    /** One row of answers for one reader: the reads first (the standby runs them again), then the writes. */
    async function readsOf(id: Id): Promise<Record<string, string>> {
        const front = await call(id, 'GET', '/api/forum');
        const all = await call(id, 'GET', '/api/forum/topics');
        const inS = await call(id, 'GET', `/api/forum/topics?section=${S}`);
        const topic = await call(id, 'GET', `/api/forum/topics/${T}`);
        const photo = await call(id, 'GET', `/api/forum/posts/${opening}/photos/0`);
        const hits = await search(id, word);
        const bell = await call(id, 'GET', '/api/notices/push');
        // A group's posts are read by the feed's group scope (the engine's getPosts): its members' and its author's.
        const result = await call(id, 'GET', `/api/marketplace/posts?id=${POLL}&audienceScope=group`);
        const sections = (front.body?.sections ?? []) as any[];
        return {
            front: front.status !== 200 ? `${front.status}` : sections.some((s) => s.id === S) ? 'sees' : 'none',
            all: all.status !== 200 ? `${all.status}` : (all.body?.topics ?? []).some((t: any) => t.id === T) ? 'sees' : 'none',
            section: inS.status === 200 ? 'sees' : `${inS.status} ${stranger(inS.body?.code) ?? ''}`.trim(),
            topic: topic.status === 200 ? `sees poll=${topic.body?.topic?.pollId === POLL ? 'yes' : topic.body?.topic?.pollId === null ? 'no' : '?'}` : `${topic.status} ${stranger(topic.body?.code) ?? ''}`.trim(),
            photo: `${photo.status}`,
            search: hits.status !== 200 ? `${hits.status}` : `${(hits.body?.hits ?? []).filter((h: any) => h.topicId === T).length > 0 ? 'hits' : 'none'}`,
            bell: bell.status !== 200 ? `${bell.status}` : (bell.body?.notices ?? []).some((n: any) => n.data?.topicId === T) ? 'row' : 'none',
            result: result.status !== 200 ? `${result.status}` : feed(result).some((p: any) => p.id === POLL) ? 'sees' : 'none',
        };
    }
    const expectedReads = (who: Who): Record<string, string> => {
        const reads = who === 'writer' || who === 'reader' || who === 'observer' || who === 'staff';
        const sees = who === 'writer' || who === 'reader' || who === 'observer';
        // A key that is no member here is turned away at the door, before any section is read: the gateway's 403 (not_a_member) or
        // the forum's own (not_member), the same for every section and every id.
        if (who === 'stranger') return { front: '403', all: '403', section: '403 stranger', topic: '403 stranger', photo: '403', search: '403', bell: 'stranger', result: 'stranger' };
        return {
            front: reads ? 'sees' : 'none',
            all: reads ? 'sees' : 'none',
            section: reads ? 'sees' : '404 not_found',
            topic: reads ? `sees poll=${sees ? 'yes' : 'no'}` : '404 not_found',
            photo: reads ? '200' : '404',
            search: reads ? 'hits' : 'none',
            // The topic's writer is followed by Cora's reply; the convenor wrote it; readers followed it.
            bell: who === 'reader' ? 'none' : reads ? 'row' : 'none',
            result: sees ? 'sees' : 'none',
        };
    };
    const onMain = new Map<string, Record<string, string>>();
    for (const a of actors) {
        const got = await readsOf(a.id);
        onMain.set(a.id.pk, got);
        const want = expectedReads(a.who);
        // A guest or visitor: whatever the bell and the market answer a key that is no member here, never the row or the poll.
        if (want.bell === 'stranger') want.bell = got.bell === 'row' ? 'LEAK' : got.bell;
        if (want.result === 'stranger') want.result = got.result === 'sees' ? 'LEAK' : got.result;
        const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
        assert(wrong.length === 0, `2. reads, ${a.label}: ${wrong.length === 0 ? JSON.stringify(got) : wrong.map((k) => `${k} got ${got[k]} want ${want[k]}`).join('; ')}`);
    }
    // "Not found" is exactly an id nobody has: the same status, code and words.
    const nobodysTopic = await call(nel, 'GET', '/api/forum/topics/ft-nobody');
    const nelTopic = await call(nel, 'GET', `/api/forum/topics/${T}`);
    const nobodysSection = await call(nel, 'GET', '/api/forum/topics?section=fs-nobody');
    const nelSection = await call(nel, 'GET', `/api/forum/topics?section=${S}`);
    assert(nelTopic.text === nobodysTopic.text && nelSection.text === nobodysSection.text,
        `2. a group's topic and section answer an outsider exactly as an id nobody has (${show(nelTopic)} | ${show(nobodysSection)})`);
    // No count gives it away: an outsider's front holds as many sections as before the groups' were made (Nel convenes the
    // other group, so hers holds its section too).
    const patCount = ((await call(pat, 'GET', '/api/forum')).body?.sections ?? []).length;
    const nelCount = ((await call(nel, 'GET', '/api/forum')).body?.sections ?? []).length;
    assert(patCount === 2 && nelCount === 3, `2. an outsider's front counts only the sections they read (${patCount}, ${nelCount})`);

    // The writes, each by every reader, in an order that leaves the next one something to act on.
    async function writesOf(a: { id: Id; who: Who }): Promise<Record<string, string>> {
        const r = await reply(a.id, T, { words: `A reply by ${a.id.name}` });
        const s = await start(a.id, { sectionId: S, title: `New by ${a.id.name}`, words: 'Words.' });
        const v = await call(a.id, 'POST', `/api/marketplace/posts/${POLL}/vote`, { optionId: 'opt_1' });
        const rep = await call(a.id, 'POST', '/api/reports', { targetForumPostId: coraPost, reason: 'Spam or a scam' });
        const vote = v.status === 200 ? 'voted' : /Poll not found/.test(v.body?.error ?? '') ? 'not found' : /convenor or member/.test(v.body?.error ?? '') ? 'members only'
            : /active members|Member not found|not_a_member/.test(`${v.body?.error ?? ''} ${v.body?.code ?? ''}`) ? 'no member' : `${v.status} ${v.text.slice(0, 80)}`;
        return {
            reply: `${r.status} ${r.status === 201 ? '' : stranger(r.body?.code) ?? ''}`.trim(),
            start: `${s.status} ${s.status === 201 ? '' : stranger(s.body?.code) ?? ''}`.trim(),
            vote,
            report: rep.status === 200 || rep.status === 201 ? 'reported' : `${rep.status} ${rep.body?.error ?? rep.body?.code ?? ''}`.trim(),
        };
    }
    const expectedWrites = (a: { id: Id; who: Who }): Record<string, string> => {
        switch (a.who) {
            case 'writer':
            case 'reader': return { reply: '201', start: '201', vote: 'voted', report: a.id === cora ? '400 own_post' : 'reported' };
            case 'observer': return { reply: '403 group_only', start: '403 group_only', vote: 'members only', report: 'reported' };
            case 'staff': return { reply: '403 group_only', start: '403 group_only', vote: 'not found', report: 'reported' };
            case 'outside': return { reply: '404 not_found', start: '404 not_found', vote: 'not found', report: '404 not_found' };
            case 'stranger': return { reply: '403 stranger', start: '403 stranger', vote: 'no member', report: 'stranger' };
        }
    };
    for (const a of actors) {
        const got = await writesOf(a);
        const want = expectedWrites(a);
        // A key that is no member here is turned away by the reports' own door, before any post is read.
        if (want.report === 'stranger') want.report = got.report === 'reported' ? 'LEAK' : got.report;
        const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
        assert(wrong.length === 0, `2. writes, ${a.label}: ${wrong.length === 0 ? JSON.stringify(got) : wrong.map((k) => `${k} got ${got[k]} want ${want[k]}`).join('; ')}`);
    }
    // Only members' votes count: the writer's and the convenor's, nobody else's.
    const tally = db.prepare('SELECT COUNT(*) FROM poll_votes WHERE post_id = ?').pluck().get(POLL) as number;
    const shown = feed(await call(gil, 'GET', `/api/marketplace/posts?id=${POLL}&audienceScope=group`))[0]?.totalVotes;
    assert(tally === 2 && shown === 2, `4. only the group's members' votes count (${tally} stored, ${shown} shown)`);
    // Follow and read, by each reader: the same rule.
    const follows = await Promise.all(actors.map(async (a) => (await call(a.id, 'POST', `/api/forum/topics/${T}/read`, { upTo: 1 })).status));
    const wantFollows = actors.map((a) => (a.who === 'stranger' ? 403 : a.who === 'outside' ? 404 : 200));
    assert(JSON.stringify(follows) === JSON.stringify(wantFollows), `2. marking a topic read: readers 200, outsiders 404, strangers 403 (${follows.join()})`);

    // ── 3. The bell and the doorbells ───────────────────────────────────────────────────────────
    console.log('── 3. the bell and the doorbells ──');
    // Lea, still in, would have had a row: give her one as the bell keeps it, then see it go from both reads.
    const leaRow = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO push_notices (id, recipient, kind, title, body, data, sent_at) VALUES (?, ?, 'forum.reply', ?, ?, ?, ?)`)
        .run(leaRow, lea.pk, `Workers plan ${word}`, 'There is 1 new reply in a topic you follow.', JSON.stringify({ screen: 'forum_topic', topicId: T, count: 1 }), Math.floor(Date.now() / 1000));
    const leaList = (await call(lea, 'GET', '/api/notices/push')).body?.notices ?? [];
    const leaOne = await call(lea, 'GET', `/api/notices/push/${leaRow}`);
    assert(!leaList.some((n: any) => n.id === leaRow) && leaOne.status === 404, `3. a member who left: the section's bell row is in neither the list nor by id (${leaList.length} rows, ${leaOne.status})`);
    // A quote of her reply tells her nothing now.
    const before = db.prepare('SELECT COUNT(*) FROM push_notices WHERE recipient = ?').pluck().get(lea.pk) as number;
    const quoted = await reply(cora, T, { words: `As @Lea said ${word}`, quotes: leaReply.body.post.number });
    require_(quoted.status === 201, `the convenor quotes Lea (${show(quoted)})`);
    const after = db.prepare('SELECT COUNT(*) FROM push_notices WHERE recipient = ?').pluck().get(lea.pk) as number;
    assert(after === before, `3. a member who left is told of nothing more there, a quote of her reply included (${before} -> ${after})`);
    // The doorbells, by the notices' own door with a fake set of callbacks.
    const heard: { to: readonly string[] | null; type: string }[] = [];
    const fake: ForumNoticeCallbacks = {
        deliverPushNotices: () => ({ sent: 0, told: 0 }), bellRowChanged: () => {}, bellSeenWhere: () => [],
        tellForum: (to, event) => { heard.push({ to, type: event.type }); },
    };
    resetForumDoorbellsForTests();
    tellForumReply(fake, { id: coraPost, topicId: T, number: 3, writer: cora.pk, words: 'x', quotes: null });
    const replyBell = heard.find((h) => h.type === 'forum_reply');
    const listBell = heard.find((h) => h.type === 'forum_list');
    const outsiders = [nel, pat, ian, rex, lea, vic].map((x) => x.pk);
    assert(!!replyBell && Array.isArray(replyBell.to) && replyBell.to.includes(gil.pk) && !replyBell.to.some((k) => outsiders.includes(k)),
        `3. a reply's doorbell reaches its readers only (${replyBell?.to?.length ?? 'none'})`);
    assert(!!listBell && Array.isArray(listBell.to) && listBell.to.includes(gil.pk) && listBell.to.includes(obi.pk) && !listBell.to.some((k) => outsiders.includes(k)),
        `3. activity in a group's section nudges only its readers' lists (${listBell ? (listBell.to === null ? 'everyone' : listBell.to.length) : 'none'})`);
    heard.length = 0;
    resetForumDoorbellsForTests();
    tellForumTopic(fake, Date.now(), S);
    const topicBell = heard.find((h) => h.type === 'forum_list');
    assert(!!topicBell && Array.isArray(topicBell.to) && !topicBell.to.some((k) => outsiders.includes(k)), `3. a new topic there nudges only its readers' lists (${topicBell ? (topicBell.to === null ? 'everyone' : topicBell.to.length) : 'none'})`);
    heard.length = 0;
    resetForumDoorbellsForTests();
    tellForumTopic(fake, Date.now(), general);
    assert(heard.some((h) => h.type === 'forum_list' && h.to === null), '3. a new topic in an open section still nudges every member\'s list');

    // ── 5. The polls' pool ──────────────────────────────────────────────────────────────────────
    console.log('── 5. the polls\' pool ──');
    const pool = ['Ada', 'Bea', 'Cy', 'Di', 'Ed', 'Flo', 'Hal', 'Ivo', 'Jo', 'Kai'].map((n) => member(n));
    // Four community polls, with Gil's topic poll open: the fifth community poll still goes up (a topic poll is not counted
    // there), and the sixth is refused, the community's five as before.
    for (const m of pool.slice(0, 5)) {
        const made5 = communityPoll(m);
        assert(made5.ok, `5. community poll by ${m.name} goes up (${made5.error || 'ok'})`);
    }
    const sixth = communityPoll(pool[5]);
    assert(!sixth.ok && /5 active polls/.test(sixth.error), `5. the community's five hold, topic polls not counted in them (${sixth.error})`);
    // Three open a section: General takes three topic polls, the fourth is refused; Ideas still takes one.
    const generalTopics: string[] = [];
    for (const m of pool.slice(5, 9)) {
        const t = await start(m, { sectionId: general, title: `Poll topic by ${m.name}`, words: 'Words.' });
        require_(t.status === 201, `a topic by ${m.name} (${show(t)})`);
        generalTopics.push(t.body.topic.id);
    }
    const gp = [];
    for (let i = 0; i < 4; i++) gp.push(await addPoll(pool[5 + i], generalTopics[i]));
    assert(gp.slice(0, 3).every((r) => r.status === 201) && gp[3].status === 409 && gp[3].body?.code === 'section_polls',
        `5. three open polls a section, the fourth refused (${gp.map((r) => `${r.status} ${r.body?.code ?? ''}`).join(' | ')})`);
    const inIdeas = await start(pool[8], { sectionId: ideas, title: 'Poll topic in Ideas', words: 'Words.' });
    const ideasPoll = await addPoll(pool[8], inIdeas.body?.topic?.id);
    assert(ideasPoll.status === 201, `5. another section's pool is its own (${show(ideasPoll)})`);
    // Still one open a member: Ada has a community poll open.
    const adaTopic = await start(pool[0], { sectionId: ideas, title: 'Ada asks', words: 'Words.' });
    const adaPoll = await addPoll(pool[0], adaTopic.body?.topic?.id);
    assert(adaPoll.status === 400 && /1 active poll/.test(adaPoll.body?.error ?? ''), `5. still one open poll a member (${show(adaPoll)})`);
    // The one community poll a week: a topic poll takes nobody's week. Ada's community poll closes to make room in the five;
    // Flo, whose topic poll is open, closes it and starts a community poll at once.
    const floTopicPoll = gp[0].body?.pollId as string;
    assert(nextPollStartAt(pool[5].pk) === null, '5. a topic poll does not start its writer\'s community-poll week');
    db.prepare("UPDATE posts SET status = 'completed' WHERE type = 'poll' AND author_pubkey = ? AND status = 'active'").run(pool[0].pk);
    db.prepare("UPDATE posts SET status = 'completed' WHERE id = ?").run(floTopicPoll);
    const floCommunity = communityPoll(pool[5]);
    assert(floCommunity.ok, `5. with her topic poll closed, Flo starts a community poll the same day (${floCommunity.error || 'ok'})`);
    const seventh = communityPoll(pool[9]);
    assert(!seventh.ok && /5 active polls/.test(seventh.error), `5. and the five are full again (${seventh.error})`);
    // A topic that is closed takes no poll.
    const closedTopic = await start(pool[9], { sectionId: ideas, title: 'Closed one', words: 'Words.' });
    await call(pool[9], 'POST', `/api/forum/topics/${closedTopic.body?.topic?.id}/close`);
    const onClosed = await addPoll(pool[9], closedTopic.body?.topic?.id);
    assert(onClosed.status === 409 && onClosed.body?.code === 'closed', `4. a closed topic takes no poll (${show(onClosed)})`);

    // ── 6. The Decision chip ────────────────────────────────────────────────────────────────────
    console.log('── 6. the Decision chip ──');
    const DECISION = 'dec-f8-roof';
    db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, closes_at)
        VALUES (?, ?, 'Fix the hall roof', 'Fix it.', 'pool', 'spend', '1m1v', ?)`).run(DECISION, owner.pk, new Date(Date.now() + 7 * DAY).toISOString());
    const linkBy = (id: Id, t: string, decisionId: unknown) => call(id, 'POST', `/api/forum/topics/${t}/decision`, { decisionId });
    const byOutsider = await linkBy(nel, T, DECISION);
    const byObserver = await linkBy(obi, T, DECISION);
    const unknown = await linkBy(gil, T, 'dec-nobody');
    const byWriter = await linkBy(gil, T, DECISION);
    assert(byOutsider.status === 404 && byOutsider.body?.code === 'not_found', `6. someone outside the group: not found (${show(byOutsider)})`);
    assert(byObserver.status === 403 && byObserver.body?.code === 'not_yours', `6. a reader who is not its writer, owner or admin cannot link one (${show(byObserver)})`);
    assert(unknown.status === 404 && unknown.body?.code === 'decision_not_found', `6. an unknown Decision is refused (${show(unknown)})`);
    assert(byWriter.status === 200 && byWriter.body?.topic?.decision?.id === DECISION && byWriter.body.topic.decision.title === 'Fix the hall roof'
        && byWriter.body.topic.decision.status === 'open', `6. the topic's writer links one: its title and state (${show(byWriter)})`);
    const seenByObserver = (await call(obi, 'GET', `/api/forum/topics/${T}`)).body?.topic?.decision?.id;
    const seenInList = ((await call(owner, 'GET', `/api/forum/topics?section=${S}`)).body?.topics ?? []).find((t: any) => t.id === T)?.decision?.id;
    assert(seenByObserver === DECISION && seenInList === DECISION, '6. anyone who may read the topic sees the chip, in the topic and the list');
    const byOwnerOnP = await linkBy(owner, P, DECISION);
    assert(byOwnerOnP.status === 200 && byOwnerOnP.body?.topic?.decision?.id === DECISION, `6. an owner links one on someone else's topic (${show(byOwnerOnP)})`);
    const cleared = await linkBy(gil, T, null);
    assert(cleared.status === 200 && cleared.body?.topic?.decision === null, `6. null takes it off (${show(cleared)})`);
    const linkRows = db.prepare("SELECT COUNT(*) FROM forum_links WHERE topic_id = ? AND kind = 'decision'").pluck().get(T) as number;
    assert(linkRows === 0, '6. taken off, its row is gone');

    // ── 7. Moves, a writer who left, a first topic waiting ──────────────────────────────────────
    console.log('── 7. moves, a writer who left, a first look ──');
    const outOf = await call(owner, 'POST', `/api/forum/topics/${T}/move`, { sectionId: general });
    const into = await call(owner, 'POST', `/api/forum/topics/${P}/move`, { sectionId: S });
    const across = await call(owner, 'POST', `/api/forum/topics/${T}/move`, { sectionId: G2 });
    const plain = await call(owner, 'POST', `/api/forum/topics/${P}/move`, { sectionId: ideas });
    assert([outOf, into, across].every((r) => r.status === 409 && r.body?.code === 'group_section') && plain.status === 200,
        `7. a topic never moves into, out of or across a group's section; between open sections it still does (${[outOf, into, across, plain].map((r) => `${r.status} ${r.body?.code ?? ''}`).join(' | ')})`);
    const leaEdit = await call(lea, 'POST', `/api/forum/posts/${leaReply.body.post.id}/edit`, { words: 'Changed' });
    const leaRemove = await call(lea, 'POST', `/api/forum/posts/${leaReply.body.post.id}/remove`);
    const leaGone = db.prepare('SELECT removed_by, words FROM forum_posts WHERE id = ?').get(leaReply.body.post.id) as any;
    assert(leaEdit.status === 404 && leaRemove.status === 200 && leaGone?.removed_by === 'writer' && leaGone.words === '',
        `7. a writer who left may remove their own words, not edit them (${show(leaEdit)} | ${show(leaRemove)})`);
    // A first topic waiting in the group's section, its writer gone from the group before the look.
    const WAIT = 'fw-f8-wait';
    db.prepare(`INSERT INTO forum_waiting (id, section_id, writer_pubkey, title, words, state, created_at) VALUES (?, ?, ?, 'Waiting one', 'Words.', 'waiting', ?)`)
        .run(WAIT, S, rex.pk, new Date().toISOString());
    const okGone = await call(mo, 'POST', `/api/forum/first-looks/${WAIT}/ok`);
    assert(okGone.status === 409 && okGone.body?.code === 'section_gone', `7. a first topic whose writer cannot write in the group's section is answered section_gone (${show(okGone)})`);

    // ── 8. A standby answers the same ───────────────────────────────────────────────────────────
    console.log('── 8. a standby ──');
    assert((TABLES.forum_links as any)?.plain === true && (TABLES.forum_sections as any)?.columns?.includes('group_id') && (TABLES.forum_topics as any)?.columns?.includes('poll_post_id'),
        '8. the manifest copies the new table and both new columns');
    const mainReads = new Map<string, Record<string, string>>();
    for (const a of actors) mainReads.set(a.id.pk, await readsOf(a.id));
    const copy = await exportSyncState('test-forum-group-section') as any;
    assert(Array.isArray(copy.plainTables?.forum_links) && (copy.plainTables?.forum_sections ?? []).some((r: any) => r.group_id === GROUP)
        && (copy.plainTables?.forum_topics ?? []).some((r: any) => r.poll_post_id === POLL), '8. the copy carries the links, the section\'s group and the topic\'s poll');
    for (const t of [...FORUM_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    setNodeRole('backup');
    const imported = importPlainTables(copy.plainTables, true, copy.generatedAt);
    assert(imported.changes > 0 && imported.skipped === 0, `8. the standby imports the whole copy (${imported.changes} rows, ${imported.skipped} skipped)`);
    const differ: string[] = [];
    for (const a of actors) {
        const got = await readsOf(a.id);
        if (JSON.stringify(got) !== JSON.stringify(mainReads.get(a.id.pk))) differ.push(`${a.label}: ${JSON.stringify(got)} vs ${JSON.stringify(mainReads.get(a.id.pk))}`);
    }
    assert(differ.length === 0, `8. every read answers on the standby as on the main server, for every reader${differ.length ? ` (${differ.join(' | ')})` : ''}`);
    const standbyWrites = await Promise.all([
        reply(gil, T, { words: 'On the standby' }), addPoll(gil, T), call(gil, 'POST', `/api/forum/topics/${T}/decision`, { decisionId: DECISION }),
        call(owner, 'POST', '/api/forum/sections', { name: 'On standby', groupId: GROUP }),
    ]);
    assert(standbyWrites.every((r) => r.status === 503 && r.body?.code === 'standby'), `8. every write answers 503 standby (${standbyWrites.map((r) => `${r.status} ${r.body?.code}`).join()})`);
    setNodeRole('primary');

    // ── 6, the last row: where Decisions are off ────────────────────────────────────────────────
    process.env.NODE_PROFILE = 'global';
    resetForumStartersCheckForTests();
    const off = await call(gil, 'POST', `/api/forum/topics/${T}/decision`, { decisionId: DECISION });
    assert(off.status === 404 && off.body?.code === 'decisions_off', `6. where Decisions are off, no chip (${show(off)})`);
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ A group\'s forum section: its members and the moderators read it, nobody else learns it exists; its polls are the group\'s, in their own pool; the Decision chip; the same on a standby.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
