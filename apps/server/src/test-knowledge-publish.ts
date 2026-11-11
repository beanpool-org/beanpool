/**
 * Local knowledge, slice K1: who makes and changes it, through the real HTTPS stack and its signature middleware
 * (scratch/fable-design/DESIGN-local-knowledge-fable.md §2.2, §2.4, §4.2, §9 test-knowledge-publish).
 *
 *  1. The create route makes offer, need, poll and event only: `type: 'knowledge'` and a made-up word are 400, no row
 *     (finding 4: a made-up type made a post every app drew as a Need, outside "Offer first").
 *  2. An owner publishes at once: price 0, fixed, reach local, public, no place (not even the author's area on a node that
 *     syncs by area), the topic as its category, Checked stamped, no photo needed; an admin too, with a photo of their own.
 *  3. Nobody else: a member and a moderator 403, an unsigned call 401, a stranger 403; an automation token or a Settings
 *     session without a signature reaches no route.
 *  4. The form's refusals, in words: no title, no words, no topic, too long, a bad link, a link with a login, too many.
 *  5. Edit (owner, admin): the words change at once, Checked is stamped, a mark is cleared; nobody else; the Market's own
 *     edit, pause and resume never find one.
 *  6. "May be out of date": its writer, an owner or an admin, with a note; a member is refused. Clear: owner or admin.
 *     "Still right" re-stamps Checked and clears the mark.
 *  7. Take down: an owner or admin, Settings' own removal (its writer reads the usual notice); after it, 404.
 *  8. No activity line ("X posted …") and no words to a socket: the engine refuses the type from any other maker.
 *  9. The switch: off, every /api/knowledge route is 404 `feature_off` and features carry no `knowledge`; on, back.
 * 10. A standby refuses every write, 503.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knowledge-publish" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast, getCommunityInfo } from './state-engine.js';
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
import { createPost, KNOWLEDGE_ONLY_BY_PUBLISH } from './engine/posts.js';
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
const publish = (id: Id, body: Record<string, unknown> = PAGE) => call(id, 'POST', '/api/knowledge/posts', body);
const rowOf = (id: string) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
const knowledgeRows = () => (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE type = 'knowledge'").get() as { n: number }).n;
const postRows = () => (db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n;
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);

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
    const [ada, mod, mel] = ['Ada', 'Mod', 'Mel'].map(newId);
    for (const who of [ada, mod, mel]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[ada, 'admin'], [mod, 'moderator']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, OWNER())).status === 200, `${who.name} is made ${role}`);
    }
    // A face each, as the Market asks of anyone posting (engine/posts.ts assertProfileComplete).
    for (const who of [owen, ada, mod, mel]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);

    // ── 1. The create route's kinds ──────────────────────────────────────────────────────────────
    console.log('── 1. the create route makes four kinds ──');
    const before = postRows();
    for (const type of ['knowledge', 'zebra', 'Offer', 'request']) {
        const r = await call(mel, 'POST', '/api/marketplace/posts', { type, category: 'food', title: 'A made-up kind', description: 'x', price_c: 0, authorPublicKey: mel.pk, photos: [TEST_PHOTO] });
        assert(r.status === 400 && r.body?.code === 'unknown_type' && postRows() === before, `1. type "${type}" on the create route: 400 unknown_type, no row (${show(r)})`);
    }
    const offer = await call(mel, 'POST', '/api/marketplace/posts', { type: 'offer', category: 'food', title: 'Lemons', description: 'A bag', price_c: 0, authorPublicKey: mel.pk, photos: [TEST_PHOTO] });
    assert(offer.status === 200 && offer.body?.post?.type === 'offer', `1. an Offer is made as before (${show(offer)})`);
    assert(throwsWith(() => createPost(broadcast, 'knowledge', 'local-services', 'x', 'y', 0, 'fixed', owen.pk), KNOWLEDGE_ONLY_BY_PUBLISH),
        '1. the engine refuses the type from any maker but publishKnowledge');
    assert(throwsWith(() => createPost(broadcast, 'offer', 'food', 'x', 'y', 0, 'fixed', owen.pk, undefined, undefined, [TEST_PHOTO], false, undefined, false,
        { knowledge: { sources: null, place: null, lang: null, checkedAt: new Date().toISOString(), keywords: '' } }), KNOWLEDGE_ONLY_BY_PUBLISH),
        "1. and an Offer handed knowledge's columns");

    // ── 2. An owner publishes at once ────────────────────────────────────────────────────────────
    console.log('── 2. an owner publishes ──');
    // Where the node syncs by area, a placeless post takes its author's area (engine/posts.ts placelessListingArea): never this one.
    setOverride('nearbyListings', 'true');
    db.prepare('UPDATE members SET area_lat = ?, area_lng = ?, area_updated_at = ? WHERE public_key = ?').run(-28.55, 153.5, new Date().toISOString(), owen.pk);
    const t0 = Date.now();
    const pub = await publish(owen);
    assert(pub.status === 201 && pub.body?.post?.type === 'knowledge', `2. Owen publishes: 201 (${show(pub)})`);
    const k1 = pub.body?.post?.id as string;
    const r1 = rowOf(k1);
    assert(r1 && r1.price_c === 0 && r1.price_type === 'fixed' && r1.repeatable === 0 && r1.cash_also_needed === 0 && r1.reach === 'local'
        && r1.audience_scope === 'public' && r1.status === 'active' && r1.active === 1,
        `2. forced: price 0, fixed, not repeatable, no cash, reach local, public, active (${JSON.stringify({ p: r1?.price_c, r: r1?.reach, a: r1?.audience_scope })})`);
    assert(r1.lat === null && r1.lng === null, `2. no place, even where the node gives a placeless post its author's area (${r1.lat}, ${r1.lng})`);
    dropOverride('nearbyListings');
    assert(r1.category === 'local-services' && r1.author_pubkey === owen.pk && r1.created_via === null, '2. the topic is its category; Owen is its writer');
    assert(Date.parse(r1.knowledge_checked_at) >= t0 - 1000 && r1.knowledge_place === 'The tip on Manse Road' && r1.knowledge_lang === 'en'
        && JSON.parse(r1.knowledge_sources)[0].url === 'https://council.example/waste' && r1.knowledge_outdated_at === null && r1.knowledge_helped === 0,
        '2. Checked stamped now; its place, language and sources kept');
    assert((db.prepare('SELECT COUNT(*) AS n FROM post_photos WHERE post_id = ?').get(k1) as { n: number }).n === 0, '2. no photo needed');
    const wire = pub.body?.post?.knowledge;
    assert(wire && wire.place === 'The tip on Manse Road' && wire.sources?.[0]?.label === 'Council waste page' && wire.gathered === false && wire.helped === 0
        && wire.checkedAt === r1.knowledge_checked_at && wire.outdatedAt === null, `2. the answer carries the knowledge fields (${JSON.stringify(wire)})`);
    assert(/tip|manse/.test(r1.search_keywords) && /emergenc/.test(rowOf(k1).search_keywords) === false && /service/.test(r1.search_keywords),
        `2. its place and topic words are search words (${r1.search_keywords})`);
    const ada1 = await publish(ada, { ...PAGE, title: 'Who to call when the creek floods', topic: 'emergencies', place: '', sources: [], photos: [TEST_PHOTO] });
    assert(ada1.status === 201 && (db.prepare('SELECT COUNT(*) AS n FROM post_photos WHERE post_id = ?').get(ada1.body?.post?.id) as { n: number }).n === 1,
        `2. Ada, an admin, publishes with a photo of her own (${show(ada1)})`);
    const k2 = ada1.body?.post?.id as string;
    assert(rowOf(k2).knowledge_place === null && rowOf(k2).knowledge_sources === null, '2. no place and no source are none');
    const activity = db.prepare("SELECT COUNT(*) AS n FROM activity_feed WHERE event_type = 'post_created' AND json_extract(metadata, '$.postId') IN (?, ?)").get(k1, k2) as { n: number };
    assert(activity.n === 0, '8. no "posted" line in the activity feed for either');

    // ── 3. Nobody else ───────────────────────────────────────────────────────────────────────────
    console.log('── 3. nobody else publishes ──');
    const n0 = knowledgeRows();
    const member = await publish(mel);
    assert(member.status === 403 && member.body?.code === 'admins_only', `3. a member: 403 admins_only (${show(member)})`);
    const moderator = await publish(mod);
    assert(moderator.status === 403 && moderator.body?.code === 'admins_only', `3. a moderator: 403 admins_only (${show(moderator)})`);
    const unsigned = await call(null, 'POST', '/api/knowledge/posts', PAGE);
    assert(unsigned.status === 401, `3. unsigned: 401 (${show(unsigned)})`);
    const stranger = await publish(newId('Stranger'));
    assert(stranger.status === 403, `3. a key that is no member: 403 (${show(stranger)})`);
    const issued = issueAutomationToken({ name: 'knowledge-suite', scope: 'admin', createdBy: owen.pk }) as any;
    require_(issued.ok && typeof issued.token === 'string', 'an owner automation token is made');
    const byToken = await call(null, 'POST', '/api/knowledge/posts', PAGE, { Authorization: `Bearer ${issued.token}`, 'X-Admin-Token': issued.token });
    assert(byToken.status === 401, `3. an owner's automation token with no signature: 401 (${show(byToken)})`);
    const bySession = await call(null, 'POST', '/api/knowledge/posts', PAGE, OWNER());
    assert(bySession.status === 401, `3. an owner's Settings session with no signature: 401 (${show(bySession)})`);
    const frontByToken = await call(null, 'GET', '/api/knowledge/front', undefined, { Authorization: `Bearer ${issued.token}` });
    assert(frontByToken.status === 401, `3. nor does a token read Learn (${show(frontByToken)})`);
    assert(knowledgeRows() === n0, '3. none of them made a row');

    // ── 4. The form's refusals ───────────────────────────────────────────────────────────────────
    console.log("── 4. the form's refusals ──");
    const refusals: Array<[string, Record<string, unknown>, string]> = [
        ['no title', { ...PAGE, title: '   ' }, 'no_title'],
        ['no words', { ...PAGE, body: '' }, 'no_body'],
        ['no topic', { ...PAGE, topic: undefined }, 'no_topic'],
        ['a listing category for a topic', { ...PAGE, topic: 'food' }, 'no_topic'],
        ['a title of 81', { ...PAGE, title: 'x'.repeat(81) }, 'too_long'],
        ['words of 3,001', { ...PAGE, body: 'y'.repeat(3001) }, 'too_long'],
        ['a place of 81', { ...PAGE, place: 'p'.repeat(81) }, 'too_long'],
        ['an ftp link', { ...PAGE, sources: [{ url: 'ftp://council.example/x', label: '' }] }, 'bad_link'],
        ['a link with no scheme', { ...PAGE, sources: [{ url: 'council.example/x', label: '' }] }, 'bad_link'],
        ['a link with a login', { ...PAGE, sources: [{ url: 'https://bank.example@evil.example/', label: '' }] }, 'bad_link'],
        ['six links', { ...PAGE, sources: Array.from({ length: 6 }, (_, i) => ({ url: `https://a.example/${i}`, label: '' })) }, 'too_many_sources'],
        ['four photos', { ...PAGE, photos: [TEST_PHOTO, TEST_PHOTO, TEST_PHOTO, TEST_PHOTO] }, 'too_many_photos'],
    ];
    for (const [what, body, code] of refusals) {
        const r = await publish(owen, body);
        assert(r.status === 400 && r.body?.code === code && typeof r.body?.error === 'string' && r.body.error.length > 5, `4. ${what}: 400 ${code}, in words (${show(r)})`);
    }
    const exact = await publish(owen, { ...PAGE, title: 't'.repeat(80), body: 'b'.repeat(3000), place: 'p'.repeat(80), lang: 'zz', photos: [] });
    assert(exact.status === 201 && rowOf(exact.body?.post?.id).knowledge_lang === null, `4. 80, 3,000 and 80 exactly are taken; a language no app has is none (${show(exact)})`);
    const hidden = await publish(owen, { ...PAGE, title: 'Bins‮ day​', body: 'Line one\n\n\n\nLine two\u0007' });
    assert(hidden.status === 201 && rowOf(hidden.body?.post?.id).title === 'Bins day' && rowOf(hidden.body?.post?.id).description === 'Line one\n\nLine two',
        `4. hidden and direction characters go, and no more than one empty line between paragraphs (${JSON.stringify(rowOf(hidden.body?.post?.id)?.description)})`);
    assert(knowledgeRows() === n0 + 2, '4. no refused one made a row');

    // ── 5. Edit ──────────────────────────────────────────────────────────────────────────────────
    console.log('── 5. edit ──');
    db.prepare("UPDATE posts SET knowledge_outdated_at = '2026-01-01T00:00:00.000Z', knowledge_outdated_note = 'old', knowledge_checked_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(k1);
    const edited = await call(ada, 'POST', `/api/knowledge/posts/${k1}/edit`, { ...PAGE, title: 'How the tip works now', topic: 'good-to-know', place: 'The tip', sources: [] });
    const e1 = rowOf(k1);
    assert(edited.status === 200 && e1.title === 'How the tip works now' && e1.category === 'good-to-know' && e1.knowledge_place === 'The tip' && e1.knowledge_sources === null,
        `5. Ada edits Owen's page: the words change at once (${show(edited)})`);
    assert(e1.knowledge_outdated_at === null && e1.knowledge_outdated_note === null && Date.parse(e1.knowledge_checked_at) > Date.parse('2026-06-01'),
        '5. the edit stamps Checked and clears the mark');
    assert(e1.author_pubkey === owen.pk, '5. the writer stays Owen');
    for (const [who, id] of [[mel, mel], [mod, mod]] as const) {
        const r = await call(id, 'POST', `/api/knowledge/posts/${k1}/edit`, { ...PAGE, title: 'Swapped' });
        assert(r.status === 403 && rowOf(k1).title === 'How the tip works now', `5. ${who.name}: 403, unchanged (${show(r)})`);
    }
    const marketEdit = await call(owen, 'POST', '/api/marketplace/posts/update', { id: k1, title: 'Swapped by the Market', authorPublicKey: owen.pk });
    assert(marketEdit.status >= 400 && rowOf(k1).title === 'How the tip works now', `5. the Market's edit never finds one, even its writer's (${show(marketEdit)})`);
    const pause = await call(owen, 'POST', '/api/marketplace/posts/pause', { postId: k1, authorPublicKey: owen.pk });
    assert(pause.status >= 400 && rowOf(k1).status === 'active', `5. nor does the Market's pause (${show(pause)})`);
    const missing = await call(owen, 'POST', '/api/knowledge/posts/nope/edit', PAGE);
    assert(missing.status === 404 && missing.body?.code === 'not_found', `5. an id that isn't a page: 404 (${show(missing)})`);
    const notKnowledge = await call(owen, 'POST', `/api/knowledge/posts/${offer.body?.post?.id}/edit`, PAGE);
    assert(notKnowledge.status === 404 && rowOf(offer.body?.post?.id).title === 'Lemons', `5. an Offer's id is not a page: 404, the Offer unchanged (${show(notKnowledge)})`);

    // ── 6. Out of date, clear, Still right ───────────────────────────────────────────────────────
    console.log('── 6. out of date ──');
    const melMarks = await call(mel, 'POST', `/api/knowledge/posts/${k2}/outdated`, { note: 'The bridge was raised' });
    assert(melMarks.status === 403 && melMarks.body?.code === 'writer_or_admins' && rowOf(k2).knowledge_outdated_at === null, `6. a member marks nothing (${show(melMarks)})`);
    const writerMarks = await call(ada, 'POST', `/api/knowledge/posts/${k2}/outdated`, { note: 'The bridge was raised in March' });
    assert(writerMarks.status === 200 && rowOf(k2).knowledge_outdated_note === 'The bridge was raised in March' && !!rowOf(k2).knowledge_outdated_at
        && writerMarks.body?.post?.knowledge?.outdatedNote === 'The bridge was raised in March', `6. its writer marks it, with why (${show(writerMarks)})`);
    const ownerMarks = await call(owen, 'POST', `/api/knowledge/posts/${k2}/outdated`, {});
    assert(ownerMarks.status === 200 && rowOf(k2).knowledge_outdated_note === null, '6. an owner marks it again, with no note');
    const longNote = await call(owen, 'POST', `/api/knowledge/posts/${k2}/outdated`, { note: 'n'.repeat(141) });
    assert(longNote.status === 400 && longNote.body?.code === 'too_long', `6. a note of 141: 400 (${show(longNote)})`);
    const melClears = await call(mel, 'POST', `/api/knowledge/posts/${k2}/outdated/clear`, {});
    assert(melClears.status === 403 && !!rowOf(k2).knowledge_outdated_at, '6. a member clears nothing');
    const checkedBefore = rowOf(k2).knowledge_checked_at;
    const cleared = await call(owen, 'POST', `/api/knowledge/posts/${k2}/outdated/clear`, {});
    assert(cleared.status === 200 && rowOf(k2).knowledge_outdated_at === null && rowOf(k2).knowledge_checked_at === checkedBefore,
        '6. an owner clears the mark; Checked stays as it was');
    await call(ada, 'POST', `/api/knowledge/posts/${k2}/outdated`, { note: 'again' });
    await new Promise((r) => setTimeout(r, 5));
    const still = await call(owen, 'POST', `/api/knowledge/posts/${k2}/checked`, {});
    assert(still.status === 200 && rowOf(k2).knowledge_outdated_at === null && rowOf(k2).knowledge_checked_at > checkedBefore,
        `6. "Still right" re-stamps Checked and clears the mark (${show(still)})`);
    const melChecks = await call(mel, 'POST', `/api/knowledge/posts/${k2}/checked`, {});
    assert(melChecks.status === 403, '6. a member confirms nothing');

    // ── 7. Take down ─────────────────────────────────────────────────────────────────────────────
    console.log('── 7. take down ──');
    const melDown = await call(mel, 'POST', `/api/knowledge/posts/${k2}/take-down`, { reasonCategory: 'spam' });
    assert(melDown.status === 403 && rowOf(k2).active === 1, `7. a member takes nothing down (${show(melDown)})`);
    const down = await call(owen, 'POST', `/api/knowledge/posts/${k2}/take-down`, { reasonCategory: 'misleading' });
    assert(down.status === 200 && rowOf(k2).active === 0, `7. Owen takes Ada's page down (${show(down)})`);
    const notice = db.prepare('SELECT COUNT(*) AS n FROM moderation_notices WHERE recipient = ?').get(ada.pk) as { n: number } | undefined;
    assert((notice?.n ?? 0) >= 1, '7. Ada, its writer, has the usual notice');
    const again = await call(owen, 'POST', `/api/knowledge/posts/${k2}/take-down`, {});
    assert(again.status === 404, `7. a page taken down is not found (${show(again)})`);
    const editGone = await call(owen, 'POST', `/api/knowledge/posts/${k2}/checked`, {});
    assert(editGone.status === 404, '7. nor confirmed');

    // ── 9. The switch ────────────────────────────────────────────────────────────────────────────
    console.log('── 9. the switch ──');
    assert((getCommunityInfo() as any).features?.knowledge === true, '9. a local community says features.knowledge');
    setOverride('knowledge', 'false');
    const off = [
        await call(owen, 'GET', '/api/knowledge/front'),
        await publish(owen),
        await call(owen, 'POST', `/api/knowledge/posts/${k1}/checked`, {}),
    ];
    assert(off.every((r) => r.status === 404 && r.body?.code === 'feature_off'), `9. off: every route 404 feature_off (${off.map((r) => r.status).join()})`);
    assert(!('knowledge' in ((getCommunityInfo() as any).features ?? {})), '9. off: features carry no knowledge');
    dropOverride('knowledge');
    assert((await call(owen, 'GET', '/api/knowledge/front')).status === 200, '9. on again: Learn answers');

    // ── 10. A standby ────────────────────────────────────────────────────────────────────────────
    console.log('── 10. a standby ──');
    setNodeRole('backup');
    const writes = [
        await publish(owen),
        await call(owen, 'POST', `/api/knowledge/posts/${k1}/edit`, PAGE),
        await call(owen, 'POST', `/api/knowledge/posts/${k1}/checked`, {}),
        await call(owen, 'POST', `/api/knowledge/posts/${k1}/outdated`, {}),
        await call(owen, 'POST', `/api/knowledge/posts/${k1}/outdated/clear`, {}),
        await call(owen, 'POST', `/api/knowledge/posts/${k1}/take-down`, {}),
    ];
    const reads = await call(owen, 'GET', '/api/knowledge/front');
    setNodeRole('primary');
    assert(writes.every((r) => r.status === 503 && r.body?.code === 'standby'), `10. a standby refuses all six writes (${writes.map((r) => r.status).join()})`);
    assert(reads.status === 200, `10. and reads its copy (${show(reads)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

function throwsWith(fn: () => unknown, message: string): boolean {
    try { fn(); return false; } catch (e: any) { return e?.message === message; }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
