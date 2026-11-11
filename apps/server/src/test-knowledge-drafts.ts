/**
 * Local knowledge, slice K3: the waiting list, through the real HTTPS stack and its signature middleware
 * (scratch/fable-design/DESIGN-local-knowledge-fable.md §2.2, §2.4, §3.4, §4.1, §4.2, §5, §9 test-knowledge-drafts and
 * test-knowledge-standby, as amended).
 *
 *  1. A member suggests: 201, it waits, and no post is made (no posts row, not in Learn, not in a read naming the type).
 *     Each owner and admin gets one push naming who and what; a moderator and a member none.
 *  2. Who may suggest, and the form's refusals: an owner or admin publishes instead (409); unsigned 401; a stranger 403; a
 *     paused member 403; a muted member 403; no title, no topic, a bad link, a photo that isn't one.
 *  3. Limits: 3 waiting; taken back, a fourth fits; 5 sent in 24 hours, taken back or not.
 *  4. My suggestions and Take it back: their own only; taken back, its words and photos go (tombstones), nobody lists it.
 *  5. To check: owners and admins read it, the longest waiting first, naming the member, the whole suggestion with its
 *     photos; a moderator and a member are refused every admin route, read or write.
 *  6. Approve: one page with the member as its writer, Checked stamped, their photos its own and charged once; the member's
 *     kept notice and push name the title and nobody who answered; the suggestion's photos go.
 *  7. Edit first: the page holds the owner's edits.
 *  8. Two answers at once: the second reads "already answered", one page.
 *  9. Not this one: a reason from the list, the admin's words, a notice that names nobody; a bad reason, words too long.
 * 10. A paused writer can't be added now; a writer on holiday can (a page is no trade).
 * 11. An assistant's draft (slice K6 files them): approving waits for the sources tick; the page is the approver's, marked
 *     assistant-draft:<grant>; nobody gets a notice.
 * 12. Who is told: the admin queue's kind for an app that opens To check (?learn=1) and the assistant's overview; Needs you's
 *     `learn` line for lands=learn only, never in the admin line; nothing for a moderator or a member.
 * 13. No automation token and no Settings session reaches any route.
 * 14. A standby: the copy holds the suggestions and their photos; it refuses every write and reads its copy; a tombstone's
 *     delete takes its row.
 * 15. The switch off: every route 404 feature_off.
 * 16. A re-key moves them; a member removed or gone takes them with tombstones; 30 days after an answer the tidy-up deletes it.
 * 17. No log line holds a suggestion's words.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knowledge-drafts" node ../../scripts/run-server-suites.mjs
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
import { NODE_PROFILE_KEY } from './config/node-profile.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { registerMemberInternal } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { issueAutomationToken } from './automation-tokens.js';
import { TABLES } from './engine/replication-manifest.js';
import { deletePlainRow } from './engine/plain-tables.js';
import { moveMemberKeyRows } from './engine/key-move.js';
import { getAdminQueue } from './engine/admin-queue.js';
import { AGENT_TOOLS } from './agent/tools.js';
import { tidyKnowledgeDrafts } from './engine/knowledge-drafts.js';
import { getMemberPhotoUsageForTests, resetPhotoBudgetForTests } from './engine/photo-upload-budget.js';
import { TEST_PHOTO } from './post-test-helper.js';
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

interface Res { status: number; body: any; text: string }
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
    return { status: res.status, body: parsed, text };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');

const PAGE = {
    title: 'How recycling works at the tip',
    body: 'Bring glass, cans and paper sorted.\nGreen waste is free on the first Saturday.',
    topic: 'local-services',
    place: 'The tip on Manse Road',
    sources: [{ url: 'https://council.example/waste', label: 'Council waste page' }],
    lang: 'fr',
};
const suggest = (id: Id, over: Record<string, unknown> = {}) => call(id, 'POST', '/api/knowledge/drafts', { ...PAGE, ...over });
const mine = (id: Id) => call(id, 'GET', '/api/knowledge/drafts/mine');
const toCheck = (id: Id) => call(id, 'GET', '/api/knowledge/drafts');
const approve = (id: Id, draft: string, body: Record<string, unknown> = {}) => call(id, 'POST', `/api/knowledge/drafts/${draft}/approve`, body);
const no = (id: Id, draft: string, body: Record<string, unknown> = { reason: 'copied' }) => call(id, 'POST', `/api/knowledge/drafts/${draft}/no`, body);
const knowledgePosts = () => (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE type = 'knowledge'").get() as { n: number }).n;
const draftRow = (id: string) => db.prepare('SELECT * FROM knowledge_drafts WHERE id = ?').get(id) as any;
const photoRows = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM knowledge_draft_photos WHERE draft_id = ?').get(id) as { n: number }).n;
const tombstone = (table: string, key: string) => !!db.prepare('SELECT 1 FROM tombstones WHERE table_name = ? AND row_key = ?').get(table, key);
const pushes = (kind: string) => db.prepare('SELECT recipient, title, body, data FROM push_notices WHERE kind = ?').all(kind) as { recipient: string; title: string; body: string; data: string }[];
const notices = (pk: string) => db.prepare("SELECT title, body, data FROM moderation_notices WHERE recipient = ? AND data LIKE '%knowledge_draft%'").all(pk) as { title: string; body: string; data: string }[];
const clear = () => {
    for (const t of ['knowledge_drafts', 'knowledge_draft_photos', 'moderation_notices', 'push_notices']) db.prepare(`DELETE FROM ${t}`).run();
    resetPhotoBudgetForTests();
};
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);
/** An assistant's draft as slice K6's tool will file one: straight into the table, for the owner or admin it acts for. */
const assistantDraft = (forKey: string, grant = 'grant-1') => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO knowledge_drafts (id, kind, member_pubkey, via, assistant_name, title, body, topic, sources, about, state, created_at)
                VALUES (?, 'new', ?, ?, 'Claude', 'Where to find the bus timetable', 'The 64 runs hourly from the post office.', 'getting-around', ?, 'service', 'waiting', ?)`)
        .run(id, forKey, `assistant:${grant}`, JSON.stringify([{ url: 'https://buses.example/64', label: 'Route 64' }]), new Date().toISOString());
    return id;
};

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
    const OWNER = () => ownerPhoneSessionHeaders(owen.pk);
    const [ada, mod, mel, pat, gus] = ['Ada', 'Mod', 'Mel', 'Pat', 'Gus'].map(newId);
    for (const who of [ada, mod, mel, pat, gus]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[ada, 'admin'], [mod, 'moderator']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, OWNER())).status === 200, `${who.name} is made ${role}`);
    }
    // A face each, as posting asks of anyone (engine/posts.ts assertProfileComplete).
    for (const who of [owen, ada, mod, mel, pat, gus]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);

    // ── 1. A member suggests ─────────────────────────────────────────────────────────────────────
    console.log('── 1. a member suggests ──');
    const before = knowledgePosts();
    const sent = await suggest(mel, { photos: [TEST_PHOTO] });
    const d1 = sent.body?.draft?.id as string;
    assert(sent.status === 201 && sent.body?.draft?.state === 'waiting' && sent.body?.draft?.title === PAGE.title && !('member_pubkey' in (sent.body?.draft ?? {})),
        `1. 201, waiting (${show(sent)})`);
    const row1 = draftRow(d1);
    assert(row1?.member_pubkey === mel.pk && row1?.via === 'app' && row1?.kind === 'new' && row1?.lang === 'fr' && JSON.parse(row1?.sources)?.[0]?.url === 'https://council.example/waste',
        '1. the row holds the member, the form and their language');
    assert(knowledgePosts() === before, '1. no posts row is made: what waits is never a post');
    const front = await call(owen, 'GET', '/api/knowledge/front');
    const read = await call(owen, 'GET', '/api/marketplace/posts?type=knowledge');
    assert(front.status === 200 && front.body?.total === 0 && read.status === 200 && !read.text.includes(PAGE.title), `1. not in Learn, not in a read naming the type (${show(front)})`);
    const told = pushes('knowledge.suggested');
    const toldTo = told.map((p) => p.recipient).sort();
    assert(toldTo.length === 2 && toldTo.join() === [owen.pk, ada.pk].sort().join(), `1. one push to each owner and admin, none to a moderator or member (${toldTo.length})`);
    assert(told.every((p) => p.body === `Mel suggested local knowledge: "${PAGE.title}". Check it in Learn.` && JSON.parse(p.data).screen === 'learn-check' && JSON.parse(p.data).draftId === d1),
        `1. its details name who and what, and land on To check (${told[0]?.body})`);
    assert(photoRows(d1) === 1 && (db.prepare('SELECT photo_data FROM knowledge_draft_photos WHERE draft_id = ?').get(d1) as any)?.photo_data?.startsWith('data:image/png;base64,'),
        '1. its photo is kept in the row, as a data URL');
    const charged = getMemberPhotoUsageForTests(mel.pk);
    assert(charged.entryCount === 1 && charged.usedBytes > 0, `1. the photo is charged to Mel's budget when sent (${JSON.stringify(charged)})`);

    // ── 2. Who may suggest, and the form's refusals ──────────────────────────────────────────────
    console.log('── 2. who may suggest ──');
    for (const who of [owen, ada]) {
        const r = await suggest(who);
        assert(r.status === 409 && r.body?.code === 'publish_instead', `2. ${who.name} (owner or admin) publishes instead (${show(r)})`);
    }
    const unsigned = await call(null, 'POST', '/api/knowledge/drafts', PAGE);
    assert(unsigned.status === 401, `2. unsigned: 401 (${show(unsigned)})`);
    const stranger = await suggest(newId('Stranger'));
    assert(stranger.status === 403 && stranger.body?.code === 'not_member', `2. a stranger: 403 (${show(stranger)})`);
    setUserStatusRow(gus.pk, 'disabled');
    const paused = await suggest(gus);
    assert(paused.status === 403 && paused.body?.code === 'not_active', `2. a paused member: 403 (${show(paused)})`);
    setUserStatusRow(gus.pk, 'active');
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 3_600_000).toISOString(), gus.pk);
    const muted = await suggest(gus);
    assert(muted.status === 403 && muted.body?.code === 'moderation_muted', `2. a muted member: 403 (${show(muted)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(gus.pk);
    for (const [over, code] of [[{ title: ' ' }, 'no_title'], [{ topic: 'food' }, 'no_topic'], [{ sources: [{ url: 'ftp://x.example' }] }, 'bad_link'],
        [{ photos: ['https://elsewhere.example/a.jpg'] }, 'bad_photos'], [{ photos: [TEST_PHOTO, TEST_PHOTO, TEST_PHOTO, TEST_PHOTO] }, 'too_many_photos']] as const) {
        const r = await suggest(gus, over as Record<string, unknown>);
        assert(r.status === 400 && r.body?.code === code, `2. ${code}: 400 (${show(r)})`);
    }
    assert((db.prepare('SELECT COUNT(*) AS n FROM knowledge_drafts WHERE member_pubkey = ?').get(gus.pk) as { n: number }).n === 0, '2. a refusal keeps nothing');

    // ── 3. Limits ───────────────────────────────────────────────────────────────────────────────
    console.log('── 3. limits ──');
    clear();
    const three = [await suggest(pat), await suggest(pat), await suggest(pat)];
    require_(three.every((r) => r.status === 201), 'Pat sends three');
    const fourth = await suggest(pat);
    assert(fourth.status === 429 && fourth.body?.code === 'too_many_waiting' && fourth.body?.error === 'You have 3 waiting already. Wait for an answer, or take one back.',
        `3. a fourth waiting: 429, in the form's words (${show(fourth)})`);
    require_((await call(pat, 'POST', `/api/knowledge/drafts/${three[0].body.draft.id}/withdraw`, {})).status === 200, 'Pat takes one back');
    assert((await suggest(pat)).status === 201, '3. taken back, a fourth fits');
    require_((await call(pat, 'POST', `/api/knowledge/drafts/${three[1].body.draft.id}/withdraw`, {})).status === 200, 'Pat takes another back');
    const fifth = await suggest(pat);
    assert(fifth.status === 201, `3. a fifth in the day (${show(fifth)})`);
    require_((await call(pat, 'POST', `/api/knowledge/drafts/${three[2].body.draft.id}/withdraw`, {})).status === 200, 'Pat takes a third back');
    const overDay = await suggest(pat);
    assert(overDay.status === 429 && overDay.body?.code === 'sent_enough_today' && overDay.body?.error === 'You’ve sent 5 today. Try again tomorrow.',
        `3. a sixth in 24 hours: 429, taken back or not (${show(overDay)})`);
    db.prepare("UPDATE knowledge_drafts SET created_at = ? WHERE member_pubkey = ?").run(new Date(Date.now() - 25 * 3_600_000).toISOString(), pat.pk);
    assert((await suggest(pat)).status === 201, '3. a day on, it fits again');

    // ── 4. My suggestions, and Take it back ──────────────────────────────────────────────────────
    console.log('── 4. my suggestions ──');
    clear();
    const m1 = (await suggest(mel, { title: 'Mel first', photos: [TEST_PHOTO] })).body?.draft?.id as string;
    const m2 = (await suggest(mel, { title: 'Mel second' })).body?.draft?.id as string;
    const melMine = await mine(mel);
    assert(melMine.status === 200 && melMine.body?.waiting?.map((d: any) => d.title).join() === 'Mel second,Mel first' && melMine.body?.answered?.length === 0,
        `4. their own, newest first (${show(melMine)})`);
    assert((await mine(pat)).body?.waiting?.length === 0, "4. nobody else's");
    const notTheirs = await call(pat, 'POST', `/api/knowledge/drafts/${m1}/withdraw`, {});
    assert(notTheirs.status === 404 && draftRow(m1)?.state === 'waiting', `4. someone else's reads as none (${show(notTheirs)})`);
    const back = await call(mel, 'POST', `/api/knowledge/drafts/${m1}/withdraw`, {});
    const gone = draftRow(m1);
    assert(back.status === 200 && gone?.state === 'withdrawn' && gone?.title === '' && gone?.body === '' && gone?.sources === null && gone?.place === null,
        `4. taken back: no words kept (${show(back)})`);
    assert(photoRows(m1) === 0 && tombstone('knowledge_draft_photos', `${m1}|0`), '4. its photo goes, with a tombstone');
    assert((await mine(mel)).body?.waiting?.map((d: any) => d.id).join() === m2 && !(await toCheck(owen)).text.includes(m1), '4. nobody lists it now');
    assert((await call(mel, 'POST', `/api/knowledge/drafts/${m1}/withdraw`, {})).status === 404, '4. twice: 404');

    // ── 5. To check ─────────────────────────────────────────────────────────────────────────────
    console.log('── 5. to check ──');
    const g1 = (await suggest(gus, { title: 'Gus on the creek', photos: [TEST_PHOTO] })).body?.draft?.id as string;
    const list = await toCheck(owen);
    assert(list.status === 200 && list.body?.total === 2 && list.body?.drafts?.map((d: any) => d.id).join() === [m2, g1].join()
        && list.body?.drafts?.[0]?.from?.name === 'Mel' && list.body?.drafts?.[0]?.assistant === null, `5. an owner's list: the longest waiting first, naming the member (${show(list)})`);
    assert((await toCheck(ada)).status === 200, '5. an admin reads it');
    const whole = await call(ada, 'GET', `/api/knowledge/drafts/${g1}`);
    assert(whole.status === 200 && whole.body?.draft?.body === PAGE.body && whole.body?.draft?.photos?.length === 1 && whole.body?.draft?.photos?.[0]?.startsWith('data:image/png')
        && whole.body?.draft?.needsSourcesTicked === false && whole.body?.draft?.sources?.[0]?.label === 'Council waste page', `5. the whole suggestion, its photo included (${show(whole)})`);
    assert((await call(owen, 'GET', '/api/knowledge/drafts/no-such')).status === 404, '5. one that isn\'t waiting: 404');
    for (const who of [mod, mel]) {
        const reads = [await toCheck(who), await call(who, 'GET', `/api/knowledge/drafts/${g1}`), await approve(who, g1), await no(who, g1)];
        assert(reads.every((r) => r.status === 403 && r.body?.code === 'admins_only') && !reads.some((r) => r.text.includes('Gus on the creek')),
            `5. ${who.name} (${who === mod ? 'a moderator' : 'a member'}) is refused every admin route (${reads.map((r) => r.status).join()})`);
    }
    assert(draftRow(g1)?.state === 'waiting', '5. and changes nothing');

    // ── 6. Approve ──────────────────────────────────────────────────────────────────────────────
    console.log('── 6. approve ──');
    db.prepare('DELETE FROM push_notices').run();
    const gusCharged = getMemberPhotoUsageForTests(gus.pk);
    const postsBefore = knowledgePosts();
    const yes = await approve(owen, g1);
    const post = yes.body?.post;
    assert(yes.status === 200 && post?.type === 'knowledge' && post?.title === 'Gus on the creek' && knowledgePosts() === postsBefore + 1, `6. one page (${show(yes)})`);
    const made = db.prepare('SELECT * FROM posts WHERE id = ?').get(post?.id) as any;
    assert(made?.author_pubkey === gus.pk && made?.created_via === null && !!made?.knowledge_checked_at && made?.knowledge_lang === 'fr' && made?.lat === null,
        '6. the member is its writer; Checked is stamped; their language kept; no place');
    assert((db.prepare('SELECT COUNT(*) AS n FROM post_photos WHERE post_id = ?').get(post?.id) as { n: number }).n === 1, "6. their photo is the page's own");
    const after = getMemberPhotoUsageForTests(gus.pk);
    assert(after.usedBytes === gusCharged.usedBytes && after.entryCount === gusCharged.entryCount && getMemberPhotoUsageForTests(owen.pk).entryCount === 0,
        `6. the photo is charged once, when sent: not again to Gus, nothing to Owen (${JSON.stringify(after)})`);
    const answered = draftRow(g1);
    assert(answered?.state === 'approved' && answered?.result_post_id === post?.id && answered?.answered_by === owen.pk && photoRows(g1) === 0 && tombstone('knowledge_draft_photos', `${g1}|0`),
        "6. the suggestion is answered, its photo gone with a tombstone");
    const gusNotice = notices(gus.pk);
    assert(gusNotice.length === 1 && gusNotice[0].title === 'Your local knowledge is in' && gusNotice[0].body === '"Gus on the creek" is now in Learn. Thank you.'
        && !/Owen|owner|admin/.test(JSON.stringify(gusNotice[0])) && !gusNotice[0].data.includes(owen.pk), `6. Gus's kept notice names the page and nobody who answered (${JSON.stringify(gusNotice)})`);
    const gusPush = pushes('knowledge.answered');
    assert(gusPush.length === 1 && gusPush[0].recipient === gus.pk && JSON.parse(gusPush[0].data).postId === post?.id && JSON.parse(gusPush[0].data).noticeId
        && !gusPush[0].data.includes(owen.pk), `6. and a push naming its kept copy (${JSON.stringify(gusPush[0])})`);
    const gusMine = await mine(gus);
    assert(gusMine.body?.answered?.[0]?.state === 'approved' && gusMine.body?.answered?.[0]?.postId === post?.id && !gusMine.text.includes(owen.pk),
        `6. My suggestions says added, with the page (${show(gusMine)})`);
    const frontNow = await call(mel, 'GET', '/api/knowledge/front');
    assert(frontNow.body?.total === 1 && frontNow.body?.topics?.[0]?.rows?.[0]?.id === post?.id, '6. the page shows in Learn');

    // ── 7. Edit first ───────────────────────────────────────────────────────────────────────────
    console.log('── 7. edit first ──');
    const edited = await approve(ada, m2, { title: 'Mel second, tidied', topic: 'good-to-know', sources: [] });
    const editedRow = db.prepare('SELECT * FROM posts WHERE id = ?').get(edited.body?.post?.id) as any;
    assert(edited.status === 200 && editedRow?.title === 'Mel second, tidied' && editedRow?.category === 'good-to-know' && editedRow?.knowledge_sources === null
        && editedRow?.description === PAGE.body && editedRow?.author_pubkey === mel.pk, `7. the page holds the admin's edits, the rest the member's (${show(edited)})`);

    // ── 8. Two answers at once ──────────────────────────────────────────────────────────────────
    console.log('── 8. two answers at once ──');
    clear();
    const twice = (await suggest(mel, { title: 'Two at once' })).body?.draft?.id as string;
    const count8 = knowledgePosts();
    const [first, second] = await Promise.all([approve(owen, twice), approve(ada, twice)]);
    const okOnes = [first, second].filter((r) => r.status === 200);
    const late = [first, second].find((r) => r.status !== 200);
    assert(okOnes.length === 1 && late?.status === 409 && late?.body?.code === 'already_answered' && late?.body?.error === 'This one was already answered.' && knowledgePosts() === count8 + 1,
        `8. one page; the second reads "This one was already answered." (${show(late ?? null)})`);
    const thenNo = await no(owen, twice);
    assert(thenNo.status === 409 && thenNo.body?.code === 'already_answered', `8. and a no after it too (${show(thenNo)})`);

    // ── 9. Not this one ─────────────────────────────────────────────────────────────────────────
    console.log('── 9. not this one ──');
    const n1 = (await suggest(mel, { title: 'Rumours about the mayor', photos: [TEST_PHOTO] })).body?.draft?.id as string;
    const badReason = await no(owen, n1, { reason: 'boring' });
    assert(badReason.status === 400 && badReason.body?.code === 'bad_reason', `9. a reason off the list: 400 (${show(badReason)})`);
    const tooLong = await no(owen, n1, { reason: 'person', words: 'x'.repeat(201) });
    assert(tooLong.status === 400 && tooLong.body?.code === 'too_long' && draftRow(n1)?.state === 'waiting', `9. words past 200: 400 (${show(tooLong)})`);
    const countNo = knowledgePosts();
    const said = await no(ada, n1, { reason: 'person', words: 'Knowledge is about places, not people.' });
    const declined = draftRow(n1);
    assert(said.status === 200 && declined?.state === 'declined' && declined?.reason === 'person' && declined?.answered_by === ada.pk && knowledgePosts() === countNo
        && photoRows(n1) === 0, `9. answered no: no page, its photo gone (${show(said)})`);
    const melNotice = notices(mel.pk).find((n) => n.body.includes('Rumours'));
    assert(melNotice?.title === "Your local knowledge wasn't added"
        && melNotice?.body === `"Rumours about the mayor" wasn't added. Reason: It's about a person. Knowledge is about places, not people.`
        && !/Ada|admin/.test(melNotice?.body ?? '') && !melNotice?.data.includes(ada.pk), `9. the notice: the reason and the admin's words, no name (${JSON.stringify(melNotice)})`);
    const melAnswered = (await mine(mel)).body?.answered?.find((d: any) => d.id === n1);
    assert(melAnswered?.state === 'declined' && melAnswered?.reason === 'person' && melAnswered?.reasonWords === 'Knowledge is about places, not people.' && !('answeredBy' in melAnswered),
        `9. My suggestions says not added, with the reason (${JSON.stringify(melAnswered)})`);
    const n2 = (await suggest(mel, { title: 'Second guess' })).body?.draft?.id as string;
    require_((await no(owen, n2, { reason: 'duplicate' })).status === 200, 'Owen says no with no words');
    assert(notices(mel.pk).some((n) => n.body === `"Second guess" wasn't added. Reason: We already have this.`), '9. with no words, the reason alone');

    // ── 10. A paused writer; a writer on holiday ────────────────────────────────────────────────
    console.log('── 10. paused, and on holiday ──');
    clear();
    const p1 = (await suggest(pat, { title: 'Pat on the hall' })).body?.draft?.id as string;
    setUserStatusRow(pat.pk, 'disabled');
    const pausedYes = await approve(owen, p1);
    assert(pausedYes.status === 409 && pausedYes.body?.code === 'writer_paused' && pausedYes.body?.error === 'This member’s account is paused, so it can’t be added now.'
        && draftRow(p1)?.state === 'waiting', `10. a paused writer: it can't be added now (${show(pausedYes)})`);
    const pausedMine = await mine(pat);
    assert(pausedMine.status === 200 && pausedMine.body?.waiting?.length === 1, '10. a paused member still reads their own');
    setUserStatusRow(pat.pk, 'active');
    require_((await call(pat, 'POST', '/api/members/holiday', { enabled: true })).status === 200, 'Pat goes on holiday');
    const holidayYes = await approve(owen, p1);
    assert(holidayYes.status === 200 && holidayYes.body?.post?.title === 'Pat on the hall', `10. a writer on holiday is added: a page is no trade (${show(holidayYes)})`);
    require_((await call(pat, 'POST', '/api/members/holiday', { enabled: false })).status === 200, 'Pat is back');

    // ── 11. An assistant's draft ────────────────────────────────────────────────────────────────
    console.log("── 11. an assistant's draft ──");
    clear();
    const a1 = assistantDraft(ada.pk);
    const aList = await toCheck(owen);
    assert(aList.body?.drafts?.[0]?.assistant === 'Claude' && aList.body?.drafts?.[0]?.from?.name === 'Ada', `11. listed as gathered with the assistant for Ada (${show(aList)})`);
    assert((await call(owen, 'GET', `/api/knowledge/drafts/${a1}`)).body?.draft?.needsSourcesTicked === true, '11. the whole draft says the tick is needed');
    const unticked = await approve(owen, a1);
    assert(unticked.status === 400 && unticked.body?.code === 'sources_not_checked' && draftRow(a1)?.state === 'waiting', `11. approving waits for the tick (${show(unticked)})`);
    const ticked = await approve(owen, a1, { checkedSources: true, photos: [TEST_PHOTO] });
    const aRow = db.prepare('SELECT * FROM posts WHERE id = ?').get(ticked.body?.post?.id) as any;
    assert(ticked.status === 200 && aRow?.author_pubkey === owen.pk && aRow?.created_via === 'assistant-draft:grant-1' && ticked.body?.post?.knowledge?.gathered === true,
        `11. the page is the approver's, marked assistant-draft:, read as gathered (${show(ticked)})`);
    assert(getMemberPhotoUsageForTests(owen.pk).entryCount === 1, "11. the approver's own photo is charged to them");
    assert(notices(ada.pk).length === 0 && pushes('knowledge.answered').length === 0, '11. nobody gets a notice for an assistant\'s draft');
    const m11 = (await suggest(mel, { title: 'Photos stay the member\'s' })).body?.draft?.id as string;
    const addPhotos = await approve(owen, m11, { photos: [TEST_PHOTO] });
    assert(addPhotos.status === 400 && addPhotos.body?.code === 'bad_photos', `11. a member's suggestion keeps its own photos (${show(addPhotos)})`);

    // ── 12. Who is told ─────────────────────────────────────────────────────────────────────────
    console.log('── 12. who is told ──');
    const home = (id: Id, lands = 'enterprise,group,invite,people,asks,learn') => call(id, 'GET', `/api/home?cards=needs&lands=${lands}`);
    const line = (r: Res) => (r.body?.cards?.needs?.items ?? []).find((i: any) => i.kind === 'learn');
    for (const who of [owen, ada]) {
        const l = line(await home(who));
        assert(l?.count === 1 && l?.label === 'Local knowledge to check: 1' && l?.target?.to === 'learn-check' && l?.accent === true && !/Mel|Photos/.test(JSON.stringify(l)),
            `12. ${who.name}'s Needs you: a count, landing on To check, no name (${JSON.stringify(l)})`);
        const adminLine = ((await home(who)).body?.cards?.needs?.items ?? []).find((i: any) => i.kind === 'admin');
        assert(!adminLine || !/knowledge/i.test(adminLine.label), `12. never in ${who.name}'s admin line, which opens Settings`);
    }
    assert(!line(await home(mod)) && !line(await home(mel)), '12. not a moderator\'s, not a member\'s');
    assert(!line(await home(owen, 'enterprise,group,invite,people,asks')), '12. not for an app that has nowhere to land it');
    const q = await call(owen, 'GET', '/api/node-admin/queue?learn=1');
    assert(q.body?.items?.find((i: any) => i.kind === 'knowledge_drafts')?.count === 1, `12. the header's queue says it for an app that opens To check (${show(q)})`);
    assert(!(await call(owen, 'GET', '/api/node-admin/queue')).body?.items?.some((i: any) => i.kind === 'knowledge_drafts'), "12. not an older app's");
    assert(!(await call(mod, 'GET', '/api/node-admin/queue?learn=1')).body?.items?.some((i: any) => i.kind === 'knowledge_drafts'), "12. nor a moderator's");
    assert(getAdminQueue({ forModerator: true, knowledgeDrafts: true }).items.length === getAdminQueue({ forModerator: true }).items.length, '12. the queue never counts it for a moderator');
    const overview = AGENT_TOOLS.find((t) => t.name === 'node_overview')!;
    const toolAnswer = await overview.run({ id: 'g', role: 'admin', memberPubkey: ada.pk } as any, {}, 'boundary') as any;
    const toolItem = toolAnswer?.result?.needsAdmin?.items?.find((i: any) => i.kind === 'knowledge_drafts');
    assert(toolItem?.count === 1 && !JSON.stringify(toolAnswer).includes('Photos stay'), `12. the assistant's overview counts it, no words (${JSON.stringify(toolItem)})`);

    // ── 13. No token, no Settings session ────────────────────────────────────────────────────────
    console.log('── 13. no token, no Settings session ──');
    const issued = issueAutomationToken({ name: 'suite', scope: 'admin', createdBy: owen.pk }) as any;
    const token = issued.token ?? issued.plaintext ?? issued.secret;
    require_(typeof token === 'string', 'an admin token is made');
    const routes = [['POST', '/api/knowledge/drafts'], ['GET', '/api/knowledge/drafts/mine'], ['POST', `/api/knowledge/drafts/${m11}/withdraw`], ['GET', '/api/knowledge/drafts'],
        ['GET', `/api/knowledge/drafts/${m11}`], ['POST', `/api/knowledge/drafts/${m11}/approve`], ['POST', `/api/knowledge/drafts/${m11}/no`]] as const;
    for (const [method, path] of routes) {
        const byToken = await call(null, method, path, { ...PAGE, reason: 'other' }, { Authorization: `Bearer ${token}`, 'X-Admin-Token': token });
        const bySession = await call(null, method, path, { ...PAGE, reason: 'other' }, OWNER());
        assert(byToken.status === 401 && bySession.status === 401, `13. ${method} ${path.replace(m11, ':id')}: a token 401, a Settings session 401 (${byToken.status}, ${bySession.status})`);
    }
    assert(draftRow(m11)?.state === 'waiting', '13. and nothing changed');

    // ── 14. A standby ───────────────────────────────────────────────────────────────────────────
    console.log('── 14. a standby ──');
    clear();
    const s1 = (await suggest(mel, { title: 'Kept through a take-over', photos: [TEST_PHOTO] })).body?.draft?.id as string;
    const copy = await exportSyncState('test-knowledge-drafts') as any;
    const copied = copy.plainTables?.knowledge_drafts as any[] | undefined;
    const copiedPhotos = copy.plainTables?.knowledge_draft_photos as any[] | undefined;
    assert(copied?.length === 1 && copied[0].id === s1 && copied[0].title === 'Kept through a take-over' && copiedPhotos?.length === 1 && copiedPhotos[0].photo_data?.startsWith('data:image/png'),
        `14. the copy holds the suggestion and its photo whole (${copied?.length}, ${copiedPhotos?.length})`);
    for (const t of ['knowledge_drafts', 'knowledge_draft_photos', 'knowledge_helped']) {
        assert((TABLES as any)[t]?.kind === 'replicated' && (TABLES as any)[t]?.plain === true, `14. the manifest copies ${t} as a plain table`);
    }
    setNodeRole('backup');
    const onStandby = [await suggest(gus), await call(mel, 'POST', `/api/knowledge/drafts/${s1}/withdraw`, {}), await approve(owen, s1), await no(owen, s1)];
    assert(onStandby.every((r) => r.status === 503 && r.body?.code === 'standby') && draftRow(s1)?.state === 'waiting',
        `14. a standby refuses every write (${onStandby.map((r) => `${r.status} ${r.body?.code}`).join(', ')})`);
    assert((await mine(mel)).body?.waiting?.length === 1 && (await toCheck(owen)).body?.total === 1, '14. and reads from its copy');
    setNodeRole('primary');
    assert(deletePlainRow('knowledge_drafts', s1) === true && !draftRow(s1), "14. a tombstone's delete takes a standby's copy of the row");

    // ── 15. The switch ──────────────────────────────────────────────────────────────────────────
    console.log('── 15. the switch ──');
    const s2 = (await suggest(mel, { title: 'While it is off' })).body?.draft?.id as string;
    setOverride('knowledge', 'false');
    const off = [await suggest(gus), await mine(mel), await call(mel, 'POST', `/api/knowledge/drafts/${s2}/withdraw`, {}), await toCheck(owen),
        await call(owen, 'GET', `/api/knowledge/drafts/${s2}`), await approve(owen, s2), await no(owen, s2)];
    assert(off.every((r) => r.status === 404 && r.body?.code === 'feature_off'), `15. off: every route 404 feature_off (${off.map((r) => r.status).join()})`);
    assert(getAdminQueue({ knowledgeDrafts: true }).items.every((i) => i.kind !== 'knowledge_drafts') && !line(await home(owen)), '15. off: nothing counts it');
    dropOverride('knowledge');
    assert((await toCheck(owen)).body?.total === 1, '15. on again: it waits as before');

    // ── 16. A re-key, a member leaving, the tidy-up ─────────────────────────────────────────────
    console.log('── 16. a re-key, leaving, the tidy-up ──');
    const mel2 = newId('Mel2');
    moveMemberKeyRows(mel.pk, mel2.pk, new Date().toISOString(), { keepStamps: false });
    assert(draftRow(s2)?.member_pubkey === mel2.pk && (await mine(mel2)).body?.waiting?.[0]?.id === s2, '16. a re-key moves the suggestion to the new key, which reads it');
    moveMemberKeyRows(mel2.pk, mel.pk, new Date().toISOString(), { keepStamps: false });
    db.prepare("INSERT INTO knowledge_helped (post_id, member_pubkey, counted, at) VALUES ('p-1', ?, 1, ?)").run(mel.pk, new Date().toISOString());
    adminPruneUser(mel.pk, COMMUNITY_DECISION_ACTOR);
    assert(!draftRow(s2) && tombstone('knowledge_drafts', s2) && tombstone('knowledge_helped', `p-1|${mel.pk}`), '16. removing a member takes their suggestions and taps, with tombstones');
    const lp = (await suggest(pat, { title: 'Pat leaves', photos: [TEST_PHOTO] })).body?.draft?.id as string;
    purgeMemberSelf(pat.pk);
    assert(!draftRow(lp) && photoRows(lp) === 0 && tombstone('knowledge_draft_photos', `${lp}|0`), '16. so does a member deleting their own account, photos and all');
    const t1 = (await suggest(gus, { title: 'Old answer' })).body?.draft?.id as string;
    const t2 = (await suggest(gus, { title: 'Still waiting' })).body?.draft?.id as string;
    require_((await no(owen, t1, { reason: 'other' })).status === 200, 'Owen answers one');
    db.prepare('UPDATE knowledge_drafts SET answered_at = ?, created_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), new Date(Date.now() - 32 * 86_400_000).toISOString(), t1);
    db.prepare('UPDATE knowledge_drafts SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 90 * 86_400_000).toISOString(), t2);
    assert(tidyKnowledgeDrafts() === 1 && !draftRow(t1) && tombstone('knowledge_drafts', t1) && draftRow(t2)?.state === 'waiting',
        '16. 30 days after an answer the tidy-up deletes it, with a tombstone; one waiting stays');

    // ── 17. No log line holds the words ─────────────────────────────────────────────────────────
    console.log('── 17. no log line holds the words ──');
    const logged: string[] = [];
    const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    const w1 = (await suggest(gus, { title: 'Zebra crossing secret', body: 'Quokka words inside' })).body?.draft?.id as string;
    await no(owen, w1, { reason: 'other', words: 'Wombat reason' });
    const w2 = (await suggest(gus, { title: 'Zebra crossing second', body: 'Quokka words again' })).body?.draft?.id as string;
    await approve(owen, w2);
    Object.assign(console, real);
    const logRows = (db.prepare("SELECT message, metadata FROM system_logs WHERE category = 'ADMIN' AND message LIKE 'Local knowledge%'").all() as { message: string; metadata: string | null }[]);
    assert(!logged.some((l) => /Zebra|Quokka|Wombat/.test(l)) && logRows.length >= 2 && !logRows.some((r) => /Zebra|Quokka|Wombat/.test(`${r.message} ${r.metadata}`)),
        `17. neither the console nor the ADMIN lines hold the words (${logged.length} lines read, ${logRows.length} ADMIN lines)`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
