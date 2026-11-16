/**
 * "Turn into a Learn page" (slice F9's Learn step; scratch/fable-design/DESIGN-forums-fable.md §10.3, §4, §9; Learn's own
 * doors, DESIGN-local-knowledge-fable.md §2.4, §5), through the real HTTPS stack and its signature middleware.
 *
 *  1. Close the class: ONE table over (actor: the answer's writer, another member, a moderator, an owner, the owner's
 *     assistant) x (answer state: live, hidden while moderators look, removed, in a group's section) x (step: Ask, suggest,
 *     publish, approve) -> allowed or refused, each with what it leaves behind: a bell row for the writer (Ask), a waiting
 *     draft that names the answer (suggest), a page and its link (publish, approve), or nothing at all. The expectations
 *     are the design's: only the WRITER turns their answer (an Ask is a request to them, never a draft); the page goes
 *     through Learn's own check; the link is written only when the page is made (approval, or an owner's or admin's own
 *     publish), and only for an answer that is still live; a removed, hidden or group-section answer is never turned.
 *  2. The flow end to end: the writer suggests from their answer, an owner approves, the answer reads "Now a Learn page"
 *     to every member who may see the page, the page's "From the forum" names the topic, the topic's own chips stay as
 *     they were; the same answer can't be turned twice (waiting, then made); Learn switched off: no "Now a Learn page".
 *  3. The Ask's bell row, under the bell's rules: a row with the asker's name and the topic's title, never the answer's
 *     words, no push; asked twice while unseen, still one row; the writer's Forum switch off, the topic muted, or the asker
 *     blocked: no row, and the asker reads the same answer each time (nothing about the writer leaks).
 *  4. The assistant: its draft never carries a forum answer, and approving it writes no link.
 *  5. Learn switched off (as on the worldwide community): no Ask, no suggest from an answer. A standby refuses an Ask.
 *
 * Run: SERVER_SUITES_ONLY=test-forum-learn TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { setSwitchOverride } from './config/node-profile.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { markForumTold } from './engine/forum.js';
import { fileAssistantKnowledgeDraft } from './engine/knowledge-drafts.js';
import { issueAutomationToken } from './automation-tokens.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import { FORUM_PUSH_PREF, PUSH_NOTICE_KINDS } from '@beanpool/core';
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
/** A member who joined 60 days ago (known in the forum), with a name and a face. */
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, ?, 'TEST', 'active')`)
        .run(id.pk, name, ago(60 * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    markForumTold(id.pk);
    return id;
}

interface Res { status: number; body: any; text: string }
async function call(id: Id | string | null, method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = {};
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (typeof id === 'string') {
        // The owner's assistant: its automation token, which no route here takes.
        h.Authorization = `Bearer ${id}`;
    } else if (id) {
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
const mark = () => `zq${crypto.randomBytes(4).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`;

const askRows = (id: Id, postId?: string) => (db.prepare(`SELECT id, title, body, data FROM push_notices WHERE recipient = ? AND kind = 'forum.learn-ask' AND seen_at IS NULL
        ${postId ? "AND json_extract(data, '$.postId') = ?" : ''} ORDER BY sent_at DESC`).all(...(postId ? [id.pk, postId] : [id.pk])) as { id: string; title: string; body: string; data: string }[])
    .map((r) => ({ ...r, data: JSON.parse(r.data) }));
const draftsFrom = (postId: string) => db.prepare("SELECT id, state, result_post_id FROM knowledge_drafts WHERE from_forum_post_id = ?").all(postId) as { id: string; state: string; result_post_id: string | null }[];
const learnLinks = (postId: string) => db.prepare("SELECT topic_id, target_id FROM forum_links WHERE kind = 'learn' AND post_id = ?").all(postId) as { topic_id: string; target_id: string }[];
const knowledgePages = () => db.prepare("SELECT COUNT(*) FROM posts WHERE type = 'knowledge'").pluck().get() as number;

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    setMemberPhoto(db, owner.pk, 'https://example.com/o.jpg');
    markForumTold(owner.pk);
    // Tom starts the topics; Wes answers (a member); Ada answers too (an admin, whose own page publishes at once); Nan is
    // another member; Mo moderates the forum. All but Nan are in the group whose section the group cells use.
    const [tom, wes, ada, nan, mo] = ['Tom', 'Wes', 'Ada', 'Nan', 'Mo'].map((n) => member(n));
    grantNodeRole(ada.pk, 'admin', owner.pk);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const issued = issueAutomationToken({ name: 'Olive helper', scope: 'agent', createdBy: owner.pk, canPost: true });
    require_(issued.ok, 'the owner has an assistant');
    const assistant = (issued as { token: string }).token;

    const GROUP = 'grp-f9-learn';
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, lead_pubkey, join_policy) VALUES (?, 'Garden circle', 'garden-circle', ?, ?, 'invite_only')`).run(GROUP, tom.pk, tom.pk);
    [tom, wes, ada].forEach((m, i) => db.prepare('INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, ?, ?, 1)')
        .run(GROUP, m.pk, i === 0 ? 'convenor' : 'member', 'active'));

    const general = ((await call(tom, 'GET', '/api/forum')).body?.sections ?? []).find((s: any) => s.starter === 'general')?.id as string;
    require_(general, 'the local forum has General');
    const sec = await call(owner, 'POST', '/api/forum/sections', { name: 'Garden talk', groupId: GROUP });
    require_(sec.status === 201, `an owner makes the group's section (${show(sec)})`);
    const groupSection = sec.body.section.id as string;

    /** A topic by Tom and an answer in it by `writer`; both dated back, so the many this suite makes meet no day's limit. */
    async function answerBy(writer: Id, sectionId: string): Promise<{ topicId: string; postId: string; title: string; words: string }> {
        const title = `How do I compost ${mark()}`;
        const t = await call(tom, 'POST', '/api/forum/topics', { sectionId, title, words: 'Mine smells.' });
        require_(t.status === 201, `Tom starts a topic (${show(t)})`);
        db.prepare('UPDATE forum_topics SET created_at = ? WHERE id = ?').run(ago(2 * DAY), t.body.topic.id);
        const words = `Turn it weekly and add dry leaves ${mark()}`;
        const r = await call(writer, 'POST', `/api/forum/topics/${t.body.topic.id}/replies`, { words });
        require_(r.status === 201, `${writer.name} answers (${show(r)})`);
        db.prepare('UPDATE forum_posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), r.body.post.id);
        return { topicId: t.body.topic.id, postId: r.body.post.id, title, words };
    }
    /** A waiting suggestion from an answer, as the writer's suggest makes one (approve cells: past a member's 3 waiting). */
    function draftFrom(answer: { postId: string; title: string; words: string }, writer: Id): string {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO knowledge_drafts (id, kind, post_id, member_pubkey, via, title, body, topic, state, created_at, from_forum_post_id)
            VALUES (?, 'new', NULL, ?, 'app', ?, ?, 'local-services', 'waiting', ?, ?)`).run(id, writer.pk, answer.title, answer.words, ago(2 * DAY), answer.postId);
        return id;
    }

    // ── 1. The table ────────────────────────────────────────────────────────────────────────────
    console.log('── 1. the table: actor x answer state x step ──');
    type Actor = 'writer' | 'member' | 'moderator' | 'owner' | 'assistant';
    type State = 'live' | 'hidden' | 'removed' | 'group';
    type Step = 'ask' | 'suggest' | 'publish' | 'approve';
    const ACTORS: Actor[] = ['writer', 'member', 'moderator', 'owner', 'assistant'];
    const STATES: State[] = ['live', 'hidden', 'removed', 'group'];
    const STEPS: Step[] = ['ask', 'suggest', 'publish', 'approve'];
    /**
     * From the design, not the code. Ask: an owner or admin, of someone else's live answer. Suggest: a member, of their own live
     * answer. Publish: an owner or admin, of their own live answer. Approve: an owner or admin, always (Learn's own check), the
     * link only for a live answer. An answer in a group's section is never turned (nor can a draft name one: its approval
     * writes no link).
     */
    const expected = (step: Step, actor: Actor, state: State): 'allowed' | 'refused' | 'page-only' => {
        if (step === 'ask') return actor === 'owner' && state === 'live' ? 'allowed' : 'refused';
        if (step === 'suggest' || step === 'publish') return actor === 'writer' && state === 'live' ? 'allowed' : 'refused';
        if (actor !== 'owner') return 'refused';
        return state === 'live' ? 'allowed' : 'page-only';
    };
    // Who wrote the answer for each step: a member for Ask, suggest and approve; an admin for publish (their own goes up at once).
    const writerFor = (step: Step) => (step === 'publish' ? ada : wes);
    const actorKey = (actor: Actor, step: Step): Id | string => ({ writer: writerFor(step), member: nan, moderator: mo, owner, assistant }[actor]);
    let cells = 0;
    for (const step of STEPS) {
        for (const state of STATES) {
            for (const actor of ACTORS) {
                const writer = writerFor(step);
                const a = await answerBy(writer, state === 'group' ? groupSection : general);
                const draftId = step === 'approve' ? draftFrom(a, writer) : null;
                if (state === 'hidden') db.prepare('UPDATE forum_posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), a.postId);
                if (state === 'removed') require_((await call(writer, 'POST', `/api/forum/posts/${a.postId}/remove`)).status === 200, `${writer.name} removes the answer`);
                const pagesBefore = knowledgePages();
                const body = { fromForumPostId: a.postId, title: a.title, body: a.words, topic: 'local-services' };
                const who = actorKey(actor, step);
                const r = step === 'ask' ? await call(who, 'POST', `/api/forum/posts/${a.postId}/learn-ask`, {})
                    : step === 'suggest' ? await call(who, 'POST', '/api/knowledge/drafts', body)
                    : step === 'publish' ? await call(who, 'POST', '/api/knowledge/posts', body)
                    : await call(who, 'POST', `/api/knowledge/drafts/${draftId}/approve`, {});
                const want = expected(step, actor, state);
                const ok = r.status >= 200 && r.status < 300;
                const links = learnLinks(a.postId);
                const drafts = draftsFrom(a.postId);
                const rows = askRows(writer, a.postId);
                const pageMade = knowledgePages() - pagesBefore;
                let leaves = false;
                if (step === 'ask') leaves = want === 'allowed' ? rows.length === 1 : rows.length === 0;
                if (step === 'suggest') leaves = links.length === 0 && pageMade === 0 && (want === 'allowed' ? drafts.length === 1 && drafts[0].state === 'waiting' : drafts.length === 0);
                if (step === 'publish') {
                    leaves = drafts.length === 0 && (want === 'allowed'
                        ? pageMade === 1 && links.length === 1 && links[0].topic_id === a.topicId && links[0].target_id === r.body?.post?.id
                        : pageMade === 0 && links.length === 0);
                }
                if (step === 'approve') {
                    leaves = want === 'refused'
                        ? pageMade === 0 && links.length === 0 && drafts[0]?.state === 'waiting'
                        : pageMade === 1 && drafts[0]?.state === 'approved' && (want === 'allowed'
                            ? links.length === 1 && links[0].topic_id === a.topicId && links[0].target_id === drafts[0].result_post_id
                            : links.length === 0);
                }
                cells++;
                assert(ok === (want !== 'refused') && leaves,
                    `1. ${step} x ${state} x ${actor}: want ${want}, got ${r.status}${leaves ? '' : ' WRONG TRACE'} (links ${links.length}, drafts ${drafts.map((d) => d.state)}, rows ${rows.length}, pages +${pageMade}) ${ok === (want !== 'refused') ? '' : show(r)}`);
                // A waiting draft would hold the writer's room (3 waiting): an allowed suggest is taken back once checked.
                if (step === 'suggest' && ok) await call(writer, 'POST', `/api/knowledge/drafts/${r.body?.draft?.id}/withdraw`);
            }
        }
    }
    assert(cells === ACTORS.length * STATES.length * STEPS.length, `1. every cell ran (${cells})`);
    // The refused approve cells left Wes's drafts waiting: taken back, so his own room is his again.
    db.prepare("UPDATE knowledge_drafts SET state = 'withdrawn', answered_at = ? WHERE member_pubkey = ? AND state = 'waiting'").run(new Date().toISOString(), wes.pk);

    // ── 2. The flow end to end ──────────────────────────────────────────────────────────────────
    console.log('\n── 2. the flow ──');
    const a = await answerBy(wes, general);
    const sent = await call(wes, 'POST', '/api/knowledge/drafts', { fromForumPostId: a.postId, title: a.title, body: a.words, topic: 'local-services' });
    require_(sent.status === 201, `Wes suggests his answer as a Learn page (${show(sent)})`);
    const again = await call(wes, 'POST', '/api/knowledge/drafts', { fromForumPostId: a.postId, title: a.title, body: a.words, topic: 'local-services' });
    assert(again.status === 409 && again.body?.code === 'learn_waiting', `2. the same answer can't wait twice (${show(again)})`);
    const askWaiting = await call(owner, 'POST', `/api/forum/posts/${a.postId}/learn-ask`, {});
    assert(askWaiting.status === 409 && askWaiting.body?.code === 'learn_waiting', `2. nor be asked for while it waits (${show(askWaiting)})`);
    const beforeApprove = await call(nan, 'GET', `/api/forum/topics/${a.topicId}`);
    assert(beforeApprove.body?.posts?.find((p: any) => p.id === a.postId)?.learn === null, '2. waiting, the answer is not yet "Now a Learn page"');
    const approved = await call(owner, 'POST', `/api/knowledge/drafts/${sent.body.draft.id}/approve`, {});
    require_(approved.status === 200, `an owner approves it (${show(approved)})`);
    const page = approved.body.post.id as string;
    const read = await call(nan, 'GET', `/api/forum/topics/${a.topicId}`);
    const learnOn = read.body?.posts?.find((p: any) => p.id === a.postId)?.learn;
    assert(learnOn?.id === page && learnOn?.title === a.title, `2. the answer reads "Now a Learn page" to another member (${JSON.stringify(learnOn)})`);
    assert((read.body?.topic?.links ?? []).length === 0, '2. the topic\'s own chips are as they were (the page is the answer\'s, not a chip)');
    assert(read.body?.posts?.find((p: any) => p.number === 1)?.learn === null, '2. and the opening post is no Learn page');
    const from = await call(nan, 'GET', `/api/forum/linked?kind=learn&id=${page}`);
    assert(from.status === 200 && from.body?.topics?.length === 1 && from.body.topics[0].id === a.topicId, `2. the page's "From the forum" names the topic (${show(from)})`);
    const twice = await call(wes, 'POST', '/api/knowledge/drafts', { fromForumPostId: a.postId, title: a.title, body: a.words, topic: 'local-services' });
    assert(twice.status === 409 && twice.body?.code === 'already_learn', `2. an answer that is a Learn page isn't turned again (${show(twice)})`);
    const askMade = await call(owner, 'POST', `/api/forum/posts/${a.postId}/learn-ask`, {});
    assert(askMade.status === 409 && askMade.body?.code === 'already_learn', `2. nor asked for (${show(askMade)})`);
    const opening = read.body?.posts?.find((p: any) => p.number === 1)?.id as string;
    const tomTurns = await call(tom, 'POST', '/api/knowledge/drafts', { fromForumPostId: opening, title: a.title, body: 'Mine smells.', topic: 'local-services' });
    assert(tomTurns.status === 400 && tomTurns.body?.code === 'not_an_answer', `2. an opening post is a question, not an answer (${show(tomTurns)})`);
    setSwitchOverride('knowledge', false);
    const learnOff = await call(nan, 'GET', `/api/forum/topics/${a.topicId}`);
    setSwitchOverride('knowledge', true);
    assert(learnOff.status === 200 && learnOff.body?.posts?.find((p: any) => p.id === a.postId)?.learn === null && !learnOff.text.includes(page),
        '2. Learn switched off: no "Now a Learn page", no page id');
    db.prepare('UPDATE posts SET active = 0 WHERE id = ?').run(page);
    const pageGone = await call(nan, 'GET', `/api/forum/topics/${a.topicId}`);
    db.prepare('UPDATE posts SET active = 1 WHERE id = ?').run(page);
    assert(pageGone.body?.posts?.find((p: any) => p.id === a.postId)?.learn === null && !pageGone.text.includes(page), '2. a page that stopped showing: none either');
    // Someone's suggestion naming another's answer is refused before anything is written.
    const b = await answerBy(wes, general);
    const nanTurns = await call(nan, 'POST', '/api/knowledge/drafts', { fromForumPostId: b.postId, title: b.title, body: b.words, topic: 'local-services' });
    assert(nanTurns.status === 403 && nanTurns.body?.code === 'not_your_answer' && draftsFrom(b.postId).length === 0, `2. another member can't turn Wes's answer (${show(nanTurns)})`);
    const fixFrom = await call(wes, 'POST', '/api/knowledge/drafts', { fromForumPostId: b.postId, fixOf: page, note: 'Weekly, not daily.' });
    assert(fixFrom.status === 400 && draftsFrom(b.postId).length === 0, `2. a fix comes from no answer (${show(fixFrom)})`);

    // ── 3. The Ask's bell row ───────────────────────────────────────────────────────────────────
    console.log('\n── 3. the Ask\'s bell row ──');
    const c = await answerBy(wes, general);
    const asked = await call(owner, 'POST', `/api/forum/posts/${c.postId}/learn-ask`, {});
    const row = askRows(wes, c.postId);
    assert(asked.status === 200 && asked.body?.asked === true && row.length === 1, `3. an owner asks: Wes gets one bell row (${show(asked)})`);
    assert(row[0]?.body.includes('Olive') && row[0]?.title === c.title && !JSON.stringify(row[0]).includes(c.words)
        && row[0]?.data.topicId === c.topicId && row[0]?.data.postId === c.postId && row[0]?.data.screen === 'forum_topic',
        `3. it names who asked and the topic, never the answer's words, and lands on the answer (${JSON.stringify(row[0])})`);
    const pushRow = db.prepare("SELECT data FROM push_notices WHERE recipient = ? AND kind = 'forum.learn-ask'").pluck().get(wes.pk) as string;
    assert(!JSON.parse(pushRow).pushedAt && typeof PUSH_NOTICE_KINDS['forum.learn-ask']?.body === 'string', '3. a bell row, no push (the kind is in core\'s table)');
    const askedAgain = await call(ada, 'POST', `/api/forum/posts/${c.postId}/learn-ask`, {});
    assert(askedAgain.status === 200 && askRows(wes, c.postId).length === 1, `3. asked again while unseen: still one row (${show(askedAgain)})`);
    assert(draftsFrom(c.postId).length === 0 && knowledgePages() >= 0 && learnLinks(c.postId).length === 0, '3. an Ask makes no draft and no link: the writer\'s tap does');
    // The bell's rules: the writer's Forum switch off, the topic muted, the asker blocked -> no row; the asker reads the same.
    const quiet = async (setup: () => void | Promise<void>, undo: () => void | Promise<void>, why: string) => {
        const d = await answerBy(wes, general);
        await setup();
        const r = await call(owner, 'POST', `/api/forum/posts/${d.postId}/learn-ask`, {});
        await undo();
        assert(r.status === 200 && r.body?.asked === true && askRows(wes, d.postId).length === 0, `3. ${why}: no row, and the owner reads the same answer (${show(r)})`);
        return d;
    };
    await quiet(() => { db.prepare("INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, 'false')").run(wes.pk, FORUM_PUSH_PREF); },
        () => { db.prepare('DELETE FROM member_preferences WHERE public_key = ? AND pref_key = ?').run(wes.pk, FORUM_PUSH_PREF); }, 'his Forum switch off');
    let mutedTopic = '';
    await quiet(async () => {
        mutedTopic = (db.prepare('SELECT topic_id FROM forum_posts WHERE writer_pubkey = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').pluck().get(wes.pk) as string);
        require_((await call(wes, 'POST', `/api/forum/topics/${mutedTopic}/follow`, { follow: 'muted' })).status === 200, 'Wes mutes the topic');
    }, () => undefined, 'the topic muted');
    await quiet(() => { db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(wes.pk, owner.pk); },
        () => { db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').run(wes.pk, owner.pk); }, 'the owner blocked');

    // ── 4. The assistant ────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the assistant ──');
    const e = await answerBy(wes, general);
    const filed = fileAssistantKnowledgeDraft({ id: 'grant-f9', member: owner.pk, name: 'Helper' },
        { title: e.title, body: e.words, topic: 'local-services', sources: [{ url: 'https://example.org/compost', label: 'Compost' }], about: 'how_to', fromForumPostId: e.postId } as any);
    const assistantRow = db.prepare('SELECT from_forum_post_id FROM knowledge_drafts WHERE id = ?').get(filed.id) as { from_forum_post_id: string | null };
    assert(assistantRow.from_forum_post_id === null, '4. an assistant\'s draft never carries a forum answer');
    const assistantApproved = await call(owner, 'POST', `/api/knowledge/drafts/${filed.id}/approve`, { checkedSources: true });
    assert(assistantApproved.status === 200 && learnLinks(e.postId).length === 0, `4. approving it writes no link (${show(assistantApproved)})`);

    // ── 5. Learn off; a standby ─────────────────────────────────────────────────────────────────
    console.log('\n── 5. Learn off; a standby ──');
    const f = await answerBy(wes, general);
    setSwitchOverride('knowledge', false);
    const askOff = await call(owner, 'POST', `/api/forum/posts/${f.postId}/learn-ask`, {});
    const suggestOff = await call(wes, 'POST', '/api/knowledge/drafts', { fromForumPostId: f.postId, title: f.title, body: f.words, topic: 'local-services' });
    setSwitchOverride('knowledge', true);
    assert(askOff.status === 404 && suggestOff.status === 404 && askRows(wes, f.postId).length === 0 && draftsFrom(f.postId).length === 0,
        `5. Learn switched off (the worldwide community): no Ask, no suggest (${show(askOff)} / ${show(suggestOff)})`);
    setNodeRole('backup');
    const askStandby = await call(owner, 'POST', `/api/forum/posts/${f.postId}/learn-ask`, {});
    setNodeRole('primary');
    assert(askStandby.status === 503 && askRows(wes, f.postId).length === 0, `5. a standby refuses an Ask (${show(askStandby)})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ Only an answer\'s writer turns it into a Learn page, through Learn\'s own check; the link comes with the page.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
