/**
 * Local knowledge, slice K5 "keep it right", the node: "This helped", Suggest a fix, the out-of-date mark, "Still right" and
 * the year list, through the real HTTPS stack and its signature middleware (scratch/fable-design/DESIGN-local-knowledge-fable.md
 * §2.4, §2.10, §3.2, §3.4, §3.5, §5.2, §5.5, §8 K5, §9 test-knowledge-helped; as amended).
 *
 *  1. "This helped": one per member per page, taken back by a second tap; the writer's own refused; only the count is ever
 *     answered; the stamp (counted or not) is made at the tap and never worked out again; a member on probation (where the
 *     node has it) taps but doesn't count; a page taken down takes no tap; nothing pays Beans.
 *  2. Who tapped stays with the node: `helpedByMe` only on the member's own signed read by id, never on a list or a sync, and
 *     no read names a tapper.
 *  3. Suggest a fix: it waits and the page stays as it is; one waiting fix per member per page; the writer's own fix waits too;
 *     an owner or admin edits instead; "the note alone" takes the page's words; the form's refusals; owners and admins told.
 *  4. Answering a fix: To check shows it with the page as it shows ("Now"); approving changes the page (writer and photos
 *     stay, Checked stamped, the mark cleared), "Edit first" too; "Not this one" leaves it; the member's notices name the page
 *     and nobody who answered; two answers at once; a page that stopped showing.
 *  5. The year list: To check lists the pages not checked for a year, the oldest first, rows only; never in the bell or the
 *     queue; "Still right" takes one off.
 *  6. Close the class: each action (helped, suggest a fix, mark out of date, still right) x each reader (member, writer,
 *     owner, admin, moderator, visitor, unsigned, standby, switch off) -> the expected answer, and its effect only on a yes.
 *  7. A standby: the copy holds the taps and the page's count; no token and no Settings session reaches the new route.
 *  8. A member removed takes their tap, and the page's count falls with it.
 *  9. Close the class: two fixes waiting on one page (each changing the body, the title, both or only the note) x approved
 *     A,B or B,A x an owner's edit before, between or none -> the page holds every approved change and the owner's edit, or
 *     the approval is refused with its line ("Edit first" or "Not this one" answers it); nothing is lost without a word.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knowledge-keep-right" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast, exportSyncState, adminDeletePost, adminPruneUser, COMMUNITY_DECISION_ACTOR } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { registerMemberInternal, registerVisitor } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { issueAutomationToken } from './automation-tokens.js';
import { getAdminQueue } from './engine/admin-queue.js';
import { publishKnowledge } from './engine/knowledge.js';
import { DRAFT_WORDS } from './engine/knowledge-drafts.js';
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
    lang: 'en',
};
const helped = (id: Id | null, post: string, on: unknown = true, headers: Record<string, string> = {}) =>
    call(id, 'POST', `/api/knowledge/posts/${post}/helped`, { on }, headers);
const fix = (id: Id | null, post: string, over: Record<string, unknown> = {}) =>
    call(id, 'POST', '/api/knowledge/drafts', { fixOf: post, note: 'The tip is closed on Mondays since March', ...over });
const markOutdated = (id: Id | null, post: string) => call(id, 'POST', `/api/knowledge/posts/${post}/outdated`, { note: 'The road moved' });
const stillRight = (id: Id | null, post: string) => call(id, 'POST', `/api/knowledge/posts/${post}/checked`, {});
const approve = (id: Id, draft: string, body: Record<string, unknown> = {}) => call(id, 'POST', `/api/knowledge/drafts/${draft}/approve`, body);
const no = (id: Id, draft: string, body: Record<string, unknown> = { reason: 'unchecked' }) => call(id, 'POST', `/api/knowledge/drafts/${draft}/no`, body);
const withdrawn = async (id: Id, draft: string) => (await call(id, 'POST', `/api/knowledge/drafts/${draft}/withdraw`, {})).status === 200;
const byId = (id: Id, post: string) => call(id, 'GET', `/api/marketplace/posts?type=knowledge&id=${post}`);
const rowOf = (id: string) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
const tapOf = (post: string, pk: string) => db.prepare('SELECT counted, at FROM knowledge_helped WHERE post_id = ? AND member_pubkey = ?').get(post, pk) as { counted: number; at: string } | undefined;
const taps = (post: string) => (db.prepare('SELECT COUNT(*) AS n FROM knowledge_helped WHERE post_id = ?').get(post) as { n: number }).n;
const draftRow = (id: string) => db.prepare('SELECT * FROM knowledge_drafts WHERE id = ?').get(id) as any;
const waitingFixOf = (pk: string, post: string) => db.prepare("SELECT id FROM knowledge_drafts WHERE member_pubkey = ? AND post_id = ? AND kind = 'fix' AND state = 'waiting'").get(pk, post);
const tombstone = (table: string, key: string) => !!db.prepare('SELECT 1 FROM tombstones WHERE table_name = ? AND row_key = ?').get(table, key);
const pushes = (kind: string) => db.prepare('SELECT recipient, title, body, data FROM push_notices WHERE kind = ?').all(kind) as { recipient: string; title: string; body: string; data: string }[];
const notices = (pk: string) => db.prepare("SELECT title, body, data FROM moderation_notices WHERE recipient = ? AND data LIKE '%knowledge_draft%' ORDER BY rowid").all(pk) as { title: string; body: string; data: string }[];
const ledgerRows = () => (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);
const OLD = '2025-01-01T00:00:00.000Z';

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
    const [ada, mod, mel, wes, pat] = ['Ada', 'Mod', 'Mel', 'Wes', 'Pat'].map(newId);
    for (const who of [ada, mod, mel, wes, pat]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[ada, 'admin'], [mod, 'moderator']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, OWNER())).status === 200, `${who.name} is made ${role}`);
    }
    const vic = newId('Vic');
    registerVisitor(vic.pk, vic.name, 'https://far.example.org');
    require_(!!db.prepare('SELECT 1 FROM members WHERE public_key = ? AND is_visitor = 1').get(vic.pk), "Vic is a visitor's row, not a member");
    // A face each, as posting asks of anyone (engine/posts.ts assertProfileComplete).
    for (const who of [owen, ada, mod, mel, wes, pat]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);

    // Wes's page, approved by Owen (the approval itself is test-knowledge-drafts'), with a photo; and Owen's own.
    const P = publishKnowledge(broadcast, owen.pk, { ...PAGE, photos: [TEST_PHOTO] }, { writer: wes.pk }).id;
    const P0 = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'Who to call when the river floods the road', topic: 'emergencies', place: null, sources: [] }).id;
    require_(rowOf(P)?.author_pubkey === wes.pk && rowOf(P0)?.author_pubkey === owen.pk, 'two pages: Wes wrote one, Owen the other');
    const photosOfP = () => (db.prepare('SELECT COUNT(*) AS n FROM post_photos WHERE post_id = ?').get(P) as { n: number }).n;
    const photosBefore = photosOfP();
    require_(photosBefore === 1, "Wes's page has its photo");

    // ── 1. This helped ───────────────────────────────────────────────────────────────────────────
    console.log('── 1. this helped ──');
    const ledger0 = ledgerRows();
    const t1 = await helped(mel, P);
    assert(t1.status === 200 && t1.body?.helped === 1 && t1.body?.helpedByMe === true && Object.keys(t1.body).sort().join() === 'helped,helpedByMe',
        `1. Mel's tap: the count and her own state, nothing else (${show(t1)})`);
    assert(tapOf(P, mel.pk)?.counted === 1 && rowOf(P).knowledge_helped === 1, '1. one row, counted, and the page carries the count');
    const stamp = tapOf(P, mel.pk)!.at;
    const again = await helped(mel, P);
    assert(again.status === 200 && again.body?.helped === 1 && taps(P) === 1 && tapOf(P, mel.pk)?.at === stamp, `1. a second "on" changes nothing: one per member, the stamp kept (${show(again)})`);
    const own = await helped(wes, P);
    assert(own.status === 403 && own.body?.code === 'own_page' && !tapOf(P, wes.pk), `1. the writer's own tap is refused (${show(own)})`);
    const ownOwen = await helped(owen, P0);
    assert(ownOwen.status === 403 && ownOwen.body?.code === 'own_page' && taps(P0) === 0, '1. an owner\'s on their own page too');
    const owenTap = await helped(owen, P);
    assert(owenTap.status === 200 && owenTap.body?.helped === 2, `1. an owner taps another's page (${show(owenTap)})`);
    const back = await helped(mel, P, false);
    assert(back.status === 200 && back.body?.helped === 1 && back.body?.helpedByMe === false && !tapOf(P, mel.pk) && tombstone('knowledge_helped', `${P}|${mel.pk}`)
        && rowOf(P).knowledge_helped === 1, `1. a second tap takes it back: the row goes with its tombstone, the count falls (${show(back)})`);
    const backAgain = await helped(mel, P, false);
    assert(backAgain.status === 200 && backAgain.body?.helped === 1, '1. taking back a tap that is not there changes nothing');
    require_((await helped(mel, P)).body?.helped === 2, 'Mel taps again');
    for (const bad of ['yes', 1, null]) {
        const r = await helped(mel, P, bad);
        assert(r.status === 400 && r.body?.code === 'bad_request' && taps(P) === 2, `1. on: ${JSON.stringify(bad)} is 400 (${show(r)})`);
    }
    const nowhere = await helped(mel, 'no-such-page');
    assert(nowhere.status === 404 && nowhere.body?.code === 'not_found', `1. a page that isn't there: 404 (${show(nowhere)})`);
    // Probation, where the node has it: Pat (joined today, no kept posts) taps, and it doesn't count. The stamp stays.
    setOverride('probation', 'true');
    const patTap = await helped(pat, P);
    assert(patTap.status === 200 && patTap.body?.helped === 2 && patTap.body?.helpedByMe === true && tapOf(P, pat.pk)?.counted === 0,
        `1. a member on probation taps, and it doesn't count (${show(patTap)})`);
    const adaTap = await helped(ada, P);
    assert(adaTap.body?.helped === 3 && tapOf(P, ada.pk)?.counted === 1, '1. an admin is never on probation: hers counts');
    dropOverride('probation');
    const patAgain = await helped(pat, P);
    assert(patAgain.body?.helped === 3 && tapOf(P, pat.pk)?.counted === 0, '1. probation off later, the stamp is never worked out again');
    assert(ledgerRows() === ledger0, `1. nothing paid: no ledger row for any tap (${ledger0} → ${ledgerRows()})`);

    // ── 2. Who tapped stays with the node ────────────────────────────────────────────────────────
    console.log('── 2. who tapped stays with the node ──');
    const melRead = await byId(mel, P);
    const melPost = melRead.body?.[0] ?? melRead.body?.posts?.[0];
    assert(melRead.status === 200 && melPost?.knowledge?.helped === 3 && melPost?.knowledge?.helpedByMe === true, `2. Mel's read by id: the count, and her own tap (${show(melRead)})`);
    const modPost = (await byId(mod, P)).body?.[0];
    assert(modPost?.knowledge?.helpedByMe === false && modPost?.knowledge?.helped === 3, '2. a member who didn\'t tap reads false');
    const list = await call(mel, 'GET', '/api/marketplace/posts?type=knowledge');
    const listed = (list.body ?? []).find((p: any) => p.id === P);
    assert(listed?.knowledge?.helped === 3 && !('helpedByMe' in (listed?.knowledge ?? {})), `2. a list carries the count, never one member's taps (${JSON.stringify(listed?.knowledge)})`);
    const synced = await call(mel, 'GET', '/api/marketplace/posts?type=knowledge&sync=1');
    assert(!synced.text.includes('helpedByMe'), '2. nor a sync read');
    const front = await call(mel, 'GET', '/api/knowledge/front');
    const reads = [melRead, list, synced, front, await call(owen, 'GET', '/api/knowledge/drafts')];
    assert(reads.every((r) => !r.text.includes(pat.pk) && !r.text.includes(ada.pk)), '2. no read names who tapped');

    // ── 3. Suggest a fix ─────────────────────────────────────────────────────────────────────────
    console.log('── 3. suggest a fix ──');
    const pageBefore = rowOf(P);
    const f1 = await fix(mel, P, { body: 'Closed on Mondays since March.\nBring glass, cans and paper sorted.' });
    const melFix = f1.body?.draft?.id as string;
    assert(f1.status === 201 && f1.body?.draft?.kind === 'fix' && f1.body?.draft?.fixOf === P && f1.body?.draft?.state === 'waiting',
        `3. Mel's fix: 201, waiting (${show(f1)})`);
    const after = rowOf(P);
    assert(after.description === pageBefore.description && after.title === pageBefore.title && after.knowledge_checked_at === pageBefore.knowledge_checked_at,
        '3. the page stays as it is until an owner or admin answers');
    const dr = draftRow(melFix);
    assert(dr?.note === 'The tip is closed on Mondays since March' && dr?.title === PAGE.title && dr?.topic === PAGE.topic && dr?.place === PAGE.place
        && JSON.parse(dr?.sources)?.[0]?.url === PAGE.sources[0].url, '3. the fix holds what changed, and the page\'s own words where none were sent');
    const melBase = JSON.parse(dr?.fix_base ?? 'null');
    assert(Object.keys(melBase ?? {}).join() === 'body' && melBase.body === pageBefore.description,
        `3. it records what Mel changed (the body) and what the page said then, nothing else (${dr?.fix_base})`);
    // The form sent whole, as the app fills it from the page: a field sent as the page has it is not a change.
    const sameAsPage = await fix(pat, P, { ...PAGE, body: 'Closed on Mondays.\nBring glass, cans and paper sorted.' });
    const sameBase = JSON.parse(draftRow(sameAsPage.body?.draft?.id)?.fix_base ?? 'null');
    assert(sameAsPage.status === 201 && Object.keys(sameBase ?? {}).join() === 'body', `3. the whole form sent: only the field that differs is a change (${show(sameAsPage)})`);
    require_(withdrawn(pat, sameAsPage.body?.draft?.id), 'Pat takes that one back');
    const twice = await fix(mel, P);
    assert(twice.status === 409 && twice.body?.code === 'fix_waiting', `3. one waiting fix per member per page (${show(twice)})`);
    const wesFix = await fix(wes, P, { title: 'How the tip works now' });
    assert(wesFix.status === 201 && rowOf(P).title === PAGE.title, `3. the writer's own fix waits too (${show(wesFix)})`);
    for (const who of [owen, ada]) {
        const r = await fix(who, P);
        assert(r.status === 409 && r.body?.code === 'edit_instead', `3. ${who.name} (owner or admin) edits instead (${show(r)})`);
    }
    for (const [over, status, code] of [[{ note: '  ' }, 400, 'no_note'], [{ note: 'x'.repeat(301) }, 400, 'too_long'], [{ photos: [TEST_PHOTO] }, 400, 'fix_photos'],
        [{ title: ' ' }, 400, 'no_title'], [{ sources: [{ url: 'ftp://x.example' }] }, 400, 'bad_link'], [{ fixOf: 'no-such-page' }, 404, 'not_found']] as const) {
        const r = await fix(pat, P0, over as Record<string, unknown>);
        assert(r.status === status && r.body?.code === code && !waitingFixOf(pat.pk, P0), `3. ${code}: ${status}, nothing kept (${show(r)})`);
    }
    const noteAlone = await call(pat, 'POST', '/api/knowledge/drafts', { fixOf: P0, note: 'The SES number changed' });
    const patFix = noteAlone.body?.draft?.id as string;
    assert(noteAlone.status === 201 && draftRow(patFix)?.title === rowOf(P0).title && draftRow(patFix)?.body === rowOf(P0).description,
        `3. the note alone is a fix: it holds the page's own words (${show(noteAlone)})`);
    const told = pushes('community.knowledge');
    assert(told.some((p) => p.recipient === owen.pk && p.body === `Mel suggested a fix to "${PAGE.title}". Check it in Learn.` && JSON.parse(p.data).draftId === melFix)
        && !told.some((p) => p.recipient === mel.pk || p.recipient === mod.pk), `3. owners and admins are told who and what, nobody else (${told.length})`);
    const wesTold = told.filter((p) => JSON.parse(p.data).draftId === wesFix.body?.draft?.id);
    assert(wesTold.length > 0 && wesTold.every((p) => p.body === `Wes suggested a fix to "${PAGE.title}". Check it in Learn.`),
        `3. a fix that renames the page: the push names the page as it shows, not the title it suggests (${wesTold.map((p) => p.body).join(' | ')})`);
    const melMine = await call(mel, 'GET', '/api/knowledge/drafts/mine');
    assert(melMine.body?.waiting?.[0]?.kind === 'fix' && melMine.body?.waiting?.[0]?.fixOf === P, '3. My suggestions lists it as a fix to the page');

    // ── 4. Answering a fix ───────────────────────────────────────────────────────────────────────
    console.log('── 4. answering a fix ──');
    const list4 = await call(owen, 'GET', '/api/knowledge/drafts');
    assert(list4.body?.drafts?.some((d: any) => d.id === melFix && d.kind === 'fix'), '4. To check lists the fix');
    const wesRow = list4.body?.drafts?.find((d: any) => d.id === wesFix.body?.draft?.id);
    assert(wesRow?.title === PAGE.title, `4. a fix that renames the page is listed by the page as it shows (${wesRow?.title})`);
    const whole = await call(owen, 'GET', `/api/knowledge/drafts/${melFix}`);
    assert(whole.status === 200 && whole.body?.draft?.note === 'The tip is closed on Mondays since March' && whole.body?.draft?.post?.id === P
        && whole.body?.draft?.post?.body === PAGE.body && whole.body?.draft?.body.startsWith('Closed on Mondays'),
        `4. the checking screen: what changed, the page as it shows ("Now") and the fix ("Suggested") (${show(whole)})`);
    assert(JSON.stringify(whole.body?.draft?.changed) === '["body"]' && JSON.stringify(whole.body?.draft?.pageChanged) === '[]',
        `4. it names the parts the member changed, and none the page changed under since (${JSON.stringify([whole.body?.draft?.changed, whole.body?.draft?.pageChanged])})`);
    const noteWhole = await call(owen, 'GET', `/api/knowledge/drafts/${patFix}`);
    assert(JSON.stringify(noteWhole.body?.draft?.changed) === '[]' && noteWhole.body?.draft?.body === rowOf(P0).description,
        `4. the note alone changes no part: "Suggested" is the page as it shows (${JSON.stringify(noteWhole.body?.draft?.changed)})`);
    db.prepare('UPDATE posts SET knowledge_outdated_at = ?, knowledge_outdated_note = ?, knowledge_checked_at = ? WHERE id = ?').run(OLD, 'Mondays?', OLD, P);
    const withPhotos = await approve(owen, melFix, { photos: [] });
    assert(withPhotos.status === 400 && withPhotos.body?.code === 'fix_photos' && draftRow(melFix)?.state === 'waiting', `4. "Edit first" can't touch the photos (${show(withPhotos)})`);
    const ok = await approve(owen, melFix);
    const fixed = rowOf(P);
    assert(ok.status === 200 && fixed.description.startsWith('Closed on Mondays') && fixed.author_pubkey === wes.pk && fixed.title === PAGE.title,
        `4. approved: the page takes the fix, its writer stays (${show(ok)})`);
    assert(fixed.knowledge_checked_at > OLD && fixed.knowledge_outdated_at === null && fixed.knowledge_outdated_note === null && photosOfP() === photosBefore,
        '4. Checked is stamped, the mark cleared, the photos kept');
    assert(fixed.knowledge_helped === 3, '4. and the count of "This helped" is the page\'s still');
    assert(draftRow(melFix)?.state === 'approved' && draftRow(melFix)?.result_post_id === P, '4. the fix is answered, naming its page');
    const melNotice = notices(mel.pk).at(-1);
    assert(melNotice?.title === 'Your fix is in' && melNotice?.body === `Your fix to "${PAGE.title}" is showing now. Thank you.` && !/Owen/.test(JSON.stringify(melNotice)),
        `4. Mel keeps "Your fix is in", naming nobody who answered (${JSON.stringify(melNotice)})`);
    const melPush = pushes('community.knowledge-answer').find((p) => p.recipient === mel.pk);
    assert(!!melPush && JSON.parse(melPush.data).postId === P, '4. and a push that lands on the page');
    const second = await approve(ada, melFix);
    assert(second.status === 409 && second.body?.code === 'already_answered', `4. a second answer: already answered (${show(second)})`);
    const wesId = wesFix.body?.draft?.id as string;
    const notUsed = await no(ada, wesId, { reason: 'unchecked', words: 'Ask at the gate first' });
    assert(notUsed.status === 200 && rowOf(P).title === PAGE.title && draftRow(wesId)?.state === 'declined', `4. "Not this one" leaves the page as it is (${show(notUsed)})`);
    const wesNotice = notices(wes.pk).at(-1);
    assert(wesNotice?.title === "Your fix wasn't used" && wesNotice?.body === `Your fix to "${PAGE.title}" wasn't used. Reason: I couldn't check it. Ask at the gate first`
        && !/Ada/.test(JSON.stringify(wesNotice)), `4. Wes keeps "Your fix wasn't used", the reason and the words, no name (${JSON.stringify(wesNotice)})`);
    const edited = await approve(ada, patFix, { body: 'Call the SES on 132 500.' });
    assert(edited.status === 200 && rowOf(P0).description === 'Call the SES on 132 500.' && rowOf(P0).author_pubkey === owen.pk,
        `4. "Edit first" on a fix: the page holds the admin's words, its writer stays (${show(edited)})`);
    // A page taken down while its fix waits: approving is refused, "Not this one" answers it.
    const gone = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'Soon taken down' }).id;
    const goneFix = (await fix(mel, gone)).body?.draft?.id as string;
    require_(!!goneFix && adminDeletePost(gone, { reasonCategory: 'other' }), 'a page with a fix waiting is taken down');
    const late = await approve(owen, goneFix);
    assert(late.status === 404 && late.body?.code === 'not_found' && draftRow(goneFix)?.state === 'waiting', `4. its fix can't be approved (${show(late)})`);
    assert((await no(owen, goneFix)).status === 200 && notices(mel.pk).at(-1)?.body?.includes('"Soon taken down"'), '4. "Not this one" answers it, naming the fix\'s title');
    assert((await helped(pat, gone)).status === 404, '4. and a page taken down takes no tap');

    // ── 5. The year list ─────────────────────────────────────────────────────────────────────────
    console.log('── 5. not checked for a year ──');
    const yearAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    db.prepare('UPDATE posts SET knowledge_checked_at = ? WHERE id = ?').run(yearAgo, P0);
    db.prepare('UPDATE posts SET knowledge_checked_at = ? WHERE id = ?').run(new Date(Date.now() - 100 * 86_400_000).toISOString(), P);
    for (const who of [owen, ada]) {
        const r = await call(who, 'GET', '/api/knowledge/drafts');
        const u = r.body?.unchecked;
        assert(r.status === 200 && u?.total === 1 && u?.rows?.[0]?.id === P0 && u.rows[0].checkedAt === yearAgo && !('body' in u.rows[0]) && !('description' in u.rows[0]),
            `5. ${who.name}'s To check lists the page not checked for a year, as a row (${JSON.stringify(u)})`);
    }
    const older = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'Older still' }).id;
    db.prepare('UPDATE posts SET knowledge_checked_at = ? WHERE id = ?').run(OLD, older);
    assert((await call(owen, 'GET', '/api/knowledge/drafts')).body?.unchecked?.rows?.map((r: any) => r.id).join() === [older, P0].join(), '5. the oldest checked first');
    assert(getAdminQueue({ knowledgeDrafts: true }).items.every((i) => i.kind !== 'knowledge_drafts'), '5. nothing waits, so nothing counts: the year list never reaches the queue or the bell');
    for (const who of [mod, mel]) {
        const r = await call(who, 'GET', '/api/knowledge/drafts');
        assert(r.status === 403 && r.body?.code === 'admins_only', `5. ${who.name} reads no year list`);
    }
    require_((await stillRight(ada, older)).status === 200, 'Ada says "Still right"');
    assert((await call(owen, 'GET', '/api/knowledge/drafts')).body?.unchecked?.rows?.map((r: any) => r.id).join() === P0, '5. "Still right" takes it off the list');

    // ── 6. Close the class: action x reader ──────────────────────────────────────────────────────
    console.log('── 6. every action, every reader ──');
    const T = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'The table page' }, { writer: wes.pk }).id;
    type Reader = 'member' | 'writer' | 'owner' | 'admin' | 'moderator' | 'visitor' | 'unsigned' | 'standby' | 'off';
    type Action = 'helped' | 'fix' | 'outdated' | 'checked';
    const READERS: Record<Reader, Id | null> = { member: mel, writer: wes, owner: owen, admin: ada, moderator: mod, visitor: vic, unsigned: null, standby: owen, off: owen };
    const DO: Record<Action, (id: Id | null) => Promise<Res>> = {
        helped: (id) => helped(id, T),
        fix: (id) => fix(id, T),
        outdated: (id) => markOutdated(id, T),
        checked: (id) => stillRight(id, T),
    };
    // What happened, read from the tables: the action's own effect, and nothing else.
    const EFFECT: Record<Action, (id: Id | null) => boolean> = {
        helped: (id) => !!id && !!tapOf(T, id.pk),
        fix: (id) => !!id && !!waitingFixOf(id.pk, T),
        outdated: () => rowOf(T).knowledge_outdated_at !== null,
        checked: () => rowOf(T).knowledge_checked_at !== OLD,
    };
    const yes = (status: number) => [status, null] as const;
    const EXPECT: Record<Action, Record<Reader, readonly [number, string | null]>> = {
        helped: { member: yes(200), writer: [403, 'own_page'], owner: yes(200), admin: yes(200), moderator: yes(200), visitor: [403, 'not_a_member'], unsigned: [401, null], standby: [503, 'standby'], off: [404, 'feature_off'] },
        fix: { member: yes(201), writer: yes(201), owner: [409, 'edit_instead'], admin: [409, 'edit_instead'], moderator: yes(201), visitor: [403, 'not_a_member'], unsigned: [401, null], standby: [503, 'standby'], off: [404, 'feature_off'] },
        outdated: { member: [403, 'writer_or_admins'], writer: yes(200), owner: yes(200), admin: yes(200), moderator: [403, 'writer_or_admins'], visitor: [403, 'not_a_member'], unsigned: [401, null], standby: [503, 'standby'], off: [404, 'feature_off'] },
        checked: { member: [403, 'admins_only'], writer: [403, 'admins_only'], owner: yes(200), admin: yes(200), moderator: [403, 'admins_only'], visitor: [403, 'not_a_member'], unsigned: [401, null], standby: [503, 'standby'], off: [404, 'feature_off'] },
    };
    const reset = () => {
        db.prepare('DELETE FROM knowledge_helped WHERE post_id = ?').run(T);
        db.prepare('DELETE FROM knowledge_drafts').run();
        db.prepare('UPDATE posts SET knowledge_helped = 0, knowledge_outdated_at = NULL, knowledge_outdated_note = NULL, knowledge_checked_at = ? WHERE id = ?').run(OLD, T);
    };
    for (const action of Object.keys(EXPECT) as Action[]) {
        for (const reader of Object.keys(READERS) as Reader[]) {
            reset();
            const [status, code] = EXPECT[action][reader];
            if (reader === 'standby') setNodeRole('backup');
            if (reader === 'off') setOverride('knowledge', 'false');
            let r: Res;
            try {
                r = await DO[action](READERS[reader]);
            } finally {
                if (reader === 'standby') setNodeRole('primary');
                if (reader === 'off') dropOverride('knowledge');
            }
            const ok = status < 300;
            assert(r.status === status && (code === null || r.body?.code === code) && EFFECT[action](READERS[reader]) === ok,
                `6. ${action} × ${reader}: ${status}${code ? ` ${code}` : ''}, ${ok ? 'done' : 'nothing changed'} (${show(r)})`);
        }
    }
    reset();

    // ── 7. A standby, and no token ───────────────────────────────────────────────────────────────
    console.log('── 7. the standby copy, no token ──');
    require_((await helped(mel, T)).body?.helped === 1, 'Mel taps the table page');
    const copy = await exportSyncState('test-knowledge-keep-right') as any;
    const copiedTaps = (copy.plainTables?.knowledge_helped ?? []) as any[];
    const copiedPage = (copy.posts ?? []).find((p: any) => p.id === T);
    assert(copiedTaps.some((t) => t.post_id === T && t.member_pubkey === mel.pk && t.counted === 1) && copiedPage?.knowledgeColumns?.helped === 1,
        `7. the standby's copy holds the tap and the page's count (${copiedTaps.length}, ${JSON.stringify(copiedPage?.knowledgeColumns?.helped)})`);
    const issued = issueAutomationToken({ name: 'suite', scope: 'admin', createdBy: owen.pk }) as any;
    const token = issued.token ?? issued.plaintext ?? issued.secret;
    require_(typeof token === 'string', 'an admin token is made');
    const byToken = await helped(null, T, true, { Authorization: `Bearer ${token}`, 'X-Admin-Token': token });
    const bySession = await helped(null, T, true, OWNER());
    assert(byToken.status === 401 && bySession.status === 401 && !tapOf(T, owen.pk), `7. a token 401, a Settings session 401 (${byToken.status}, ${bySession.status})`);

    // ── 8. A member removed takes their tap, and the count with it ───────────────────────────────
    console.log('── 8. a member removed ──');
    require_((await helped(mod, T)).body?.helped === 2 && rowOf(T).knowledge_helped === 2, 'Mod taps the table page too');
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(OLD, T);
    adminPruneUser(mod.pk, COMMUNITY_DECISION_ACTOR);
    assert(!tapOf(T, mod.pk) && tombstone('knowledge_helped', `${T}|${mod.pk}`) && rowOf(T).knowledge_helped === 1 && rowOf(T).updated_at !== OLD,
        `8. removing a member takes their tap with its tombstone, and the page counts the taps that are there (${rowOf(T).knowledge_helped})`);
    const front8 = await call(mel, 'GET', `/api/knowledge/front?topic=${PAGE.topic}`);
    assert(front8.body?.rows?.find((r: any) => r.id === T)?.helped === 1, '8. Learn reads the count that is there');

    // ── 9. Close the class: two fixes on one page, every order, an owner's edit or none ──────────
    // An approval writes only what its member changed, over the page as it shows then. A part the page changed under since the
    // fix was sent (another approved fix, the owner's own edit) is never written over: that approval is refused with its line,
    // and the fix keeps waiting for "Edit first" or "Not this one". So the final page holds every approved change and the
    // owner's edit; nothing is lost without a word.
    console.log('── 9. two fixes on one page: every order, an owner\'s edit or none ──');
    type FixKind = 'body' | 'title' | 'both' | 'note';
    type EditAt = 'none' | 'before' | 'between';
    const PARTS: Record<FixKind, ('title' | 'body')[]> = { body: ['body'], title: ['title'], both: ['title', 'body'], note: [] };
    const OWNER_BODY = 'Owen checked it: closed on Mondays and public holidays.';
    const SENDERS = { A: mel, B: pat } as const;
    let n9 = 0;
    for (const ka of Object.keys(PARTS) as FixKind[]) {
        for (const kb of Object.keys(PARTS) as FixKind[]) {
            for (const order of [['A', 'B'], ['B', 'A']] as const) {
                for (const at of ['none', 'before', 'between'] as EditAt[]) {
                    n9++;
                    db.prepare('DELETE FROM knowledge_drafts').run(); // each case starts inside the day's limits, as section 6 does
                    const orig = { title: `Table page ${n9}`, body: PAGE.body };
                    const page = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: orig.title }, { writer: wes.pk }).id;
                    const kinds = { A: ka, B: kb };
                    const words = (x: 'A' | 'B') => ({ title: `${orig.title}, as ${x} has it`, body: `What ${x} knows now.` });
                    const ask = (x: 'A' | 'B'): Record<string, unknown> => {
                        const mine: Record<string, unknown> = {};
                        for (const part of PARTS[kinds[x]]) mine[part] = words(x)[part];
                        // A sends the form whole, as the app fills it from the page; B sends only what it changed.
                        return x === 'A' ? { ...PAGE, title: orig.title, ...mine } : mine;
                    };
                    const sentA = await fix(SENDERS.A, page, ask('A'));
                    const sentB = await fix(SENDERS.B, page, ask('B'));
                    require_(sentA.status === 201 && sentB.status === 201, `9.${n9} both fixes wait (${show(sentA)} | ${show(sentB)})`);
                    const ids = { A: sentA.body.draft.id as string, B: sentB.body.draft.id as string };
                    const model = { ...orig };
                    const steps: ('A' | 'B' | 'edit')[] = at === 'before' ? ['edit', ...order] : at === 'between' ? [order[0], 'edit', order[1]] : [...order];
                    const approved: { x: 'A' | 'B'; editAfter: boolean }[] = [];
                    const wrong: string[] = [];
                    for (const step of steps) {
                        if (step === 'edit') {
                            const now = rowOf(page);
                            const e = await call(owen, 'POST', `/api/knowledge/posts/${page}/edit`, {
                                title: now.title, body: OWNER_BODY, topic: now.category, place: now.knowledge_place,
                                sources: JSON.parse(now.knowledge_sources ?? '[]'), lang: now.knowledge_lang,
                            });
                            require_(e.status === 200, `9.${n9} Owen edits the page as it shows (${show(e)})`);
                            model.body = OWNER_BODY;
                            approved.forEach((a) => { a.editAfter = true; });
                            continue;
                        }
                        const parts = PARTS[kinds[step]];
                        const moved = parts.filter((part) => model[part] !== orig[part] && model[part] !== words(step)[part]);
                        const before = rowOf(page);
                        const seen = moved.length > 0 ? await call(owen, 'GET', `/api/knowledge/drafts/${ids[step]}`) : null;
                        const r = await approve(owen, ids[step]);
                        if (moved.length > 0) {
                            const still = rowOf(page);
                            if (!(r.status === 409 && r.body?.code === 'page_changed' && r.body?.error === DRAFT_WORDS.pageChanged
                                && draftRow(ids[step])?.state === 'waiting' && still.title === before.title && still.description === before.description
                                && JSON.stringify(seen?.body?.draft?.pageChanged) === JSON.stringify(moved))) {
                                wrong.push(`${step} should be refused with its line, ${moved.join('+')} named: ${show(r)} ${JSON.stringify(seen?.body?.draft?.pageChanged)}`);
                            }
                        } else {
                            if (r.status !== 200 || draftRow(ids[step])?.state !== 'approved') wrong.push(`${step} should be approved: ${show(r)}`);
                            for (const part of parts) model[part] = words(step)[part];
                            approved.push({ x: step, editAfter: false });
                        }
                    }
                    const final = rowOf(page);
                    const shows = { title: final.title, body: final.description };
                    if (shows.title !== model.title || shows.body !== model.body) wrong.push(`the page shows ${JSON.stringify(shows)}, not ${JSON.stringify(model)}`);
                    // Nothing silently lost: every approved change is there unless Owen's own edit came after it, and Owen's edit is there.
                    for (const a of approved) {
                        for (const part of PARTS[kinds[a.x]]) {
                            if (shows[part] !== words(a.x)[part] && !(a.editAfter && part === 'body')) wrong.push(`${a.x}'s approved ${part} was lost`);
                        }
                    }
                    if (at !== 'none' && shows.body !== OWNER_BODY) wrong.push('Owen\'s edit was lost');
                    assert(wrong.length === 0, `9. A ${ka} × B ${kb}, approved ${order.join(',')}, owner's edit ${at}: ${wrong.length === 0
                        ? `${approved.map((a) => a.x).join(',') || 'none'} approved, the rest refused with the line` : wrong.join('; ')}`);
                }
            }
        }
    }
    // A refused fix still has its answers: "Edit first" writes the owner's or admin's chosen words, "Not this one" leaves the page.
    db.prepare('DELETE FROM knowledge_drafts').run();
    const R = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'The refused one' }, { writer: wes.pk }).id;
    const r1 = (await fix(mel, R, { body: 'Mel says so.' })).body?.draft?.id as string;
    const r2 = (await fix(pat, R, { body: 'Pat says otherwise.' })).body?.draft?.id as string;
    require_((await approve(owen, r1)).status === 200, "Owen approves Mel's");
    const refusedR = await approve(owen, r2);
    assert(refusedR.status === 409 && refusedR.body?.code === 'page_changed' && rowOf(R).description === 'Mel says so.',
        `9. Pat's over the same part is refused, Mel's stays (${show(refusedR)})`);
    const chosen = await approve(owen, r2, { body: 'Mel says so. Pat adds: on Sundays too.' });
    assert(chosen.status === 200 && rowOf(R).description === 'Mel says so. Pat adds: on Sundays too.' && draftRow(r2)?.state === 'approved',
        `9. "Edit first" with the words chosen goes through (${show(chosen)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
