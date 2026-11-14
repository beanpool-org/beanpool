/**
 * Local knowledge, slice K1: who reads it and where it never goes, through the real HTTPS stack and its signature middleware
 * (scratch/fable-design/DESIGN-local-knowledge-fable.md §2.3, §9 test-knowledge-reads; amended §4.2, §A8).
 *
 *  1. The posts read leaves it out unless the read names it: a list, a sync, a delta, an `author=` read, an `id=` and an
 *     `ids=` read get none; with `types=…,knowledge` or `type=knowledge` a member gets it, with its knowledge fields.
 *  2. Never to a visitor: a signed non-member gets none, and a visitor's copy of a post drops the field.
 *  3. Never a deal, an RSVP, a vote or a pin: each refused, nothing written.
 *  4. Never a listing: the active listings count doesn't move; no map pin (no place).
 *  5. GET /api/knowledge/front: grouped by topic in the fixed order, three rows a topic with its count; Learn's order inside
 *     a topic (out of date last, then most helped, then A to Z), never by date; a row never carries the body.
 *  6. `topic=`: every row of one topic, paged; `q=`: best match first (title, then place, then words), the topic's words
 *     and the place found too.
 *  7. Off (the global community): Learn 404, and a read that names the type gets none.
 *  8. Its writer's own reads: an Offer read by author still has no knowledge, and a page taken down leaves Learn.
 *  9. The standby copy carries every knowledge column; a take-over's copy is the main server's.
 * 10. Its writer on holiday: every page stays in Learn (front, topic=, q=, a read naming the type, a sync never as paused),
 *     while their Offer leaves the Market as ever (the review of #3063).
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knowledge-reads" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast, exportSyncState, getActivePostCount } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { registerMemberInternal } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { TEST_PHOTO } from './post-test-helper.js';
import { guestPost, getPosts } from '@beanpool/engine';
import { KNOWLEDGE_TOPICS } from '@beanpool/core';
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
/** The posts a read answered, whatever its shape (a list, or a member's set's `{ posts }`). */
const postsOf = (r: Res): any[] => (Array.isArray(r.body) ? r.body : Array.isArray(r.body?.posts) ? r.body.posts : []);
const kinds = (r: Res) => postsOf(r).map((p) => p.type);
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
    const [mel, pat] = ['Mel', 'Pat'].map(newId);
    for (const who of [mel, pat]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const who of [owen, mel, pat]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);

    const offer = await call(mel, 'POST', '/api/marketplace/posts', { type: 'offer', category: 'food', title: 'Lemons', description: 'A bag', price_c: 0, authorPublicKey: mel.pk, photos: [TEST_PHOTO] });
    require_(offer.status === 200, `Mel posts an Offer (${show(offer)})`);
    const offerId = offer.body.post.id as string;
    const countBefore = getActivePostCount();

    // Owen's pages: two in Local services, one in Emergencies, one in Getting around, one in Good to know.
    const pages: Array<Record<string, unknown>> = [
        { title: 'Bins day', body: 'Bins go out on Tuesday night.\nRecycling every other week.', topic: 'local-services', place: '' },
        { title: 'At the tip', body: 'Bring glass sorted.', topic: 'local-services', place: 'The tip on Manse Road' },
        { title: 'Who to call in a flood', body: 'Call the roads line first.', topic: 'emergencies', place: 'The low bridge' },
        { title: 'Valley bus times', body: 'Leaves the shop at 8.', topic: 'getting-around', place: '' },
        { title: 'Wifi at the hall', body: 'Ask the caretaker for the code.', topic: 'good-to-know', place: 'The hall' },
    ];
    const ids: string[] = [];
    for (const p of pages) {
        const r = await call(owen, 'POST', '/api/knowledge/posts', p);
        require_(r.status === 201, `Owen publishes "${p.title}" (${show(r)})`);
        ids.push(r.body.post.id);
    }
    const [kBins, kTip, kFlood, kBus, kWifi] = ids;

    // ── 1. The posts read leaves it out unless asked ─────────────────────────────────────────────
    console.log('── 1. the posts read ──');
    const reads: Array<[string, string]> = [
        ['a list with no types', '/api/marketplace/posts'],
        ["an app's whole feed (today's four kinds)", '/api/marketplace/posts?types=offer,need,poll,event'],
        ['a sync', '/api/marketplace/posts?sync=true'],
        ['a paged sync', '/api/marketplace/posts?sync=true&paged=1&types=offer,need,poll,event'],
        ['a delta', `/api/marketplace/posts?updatedAfter=${encodeURIComponent('2020-01-01T00:00:00.000Z')}`],
        ["one member's listings (author=)", `/api/marketplace/posts?author=${owen.pk}`],
        ['by id', `/api/marketplace/posts?id=${kBins}`],
        ['by id, as a sync', `/api/marketplace/posts?id=${kBins}&sync=true`],
        ['by ids, with an Offer', `/api/marketplace/posts?ids=${kBins},${offerId},${kFlood}`],
        ['a search for its words', '/api/marketplace/posts?q=flood'],
        ['the Market with a category', '/api/marketplace/posts?category=local-services'],
        ["a made-up type", '/api/marketplace/posts?type=zebra'],
    ];
    for (const [what, url] of reads) {
        const r = await call(mel, 'GET', url);
        assert(r.status === 200 && !kinds(r).includes('knowledge'), `1. ${what}: no knowledge (${r.status}, ${kinds(r).join(',') || 'none'})`);
    }
    const byIds = await call(mel, 'GET', `/api/marketplace/posts?ids=${kBins},${offerId}`);
    assert(postsOf(byIds).length === 1 && postsOf(byIds)[0].id === offerId, '1. by ids: the Offer, and the page is as if no such id');
    const named = await call(mel, 'GET', '/api/marketplace/posts?types=offer,need,poll,event,knowledge');
    assert(kinds(named).filter((k) => k === 'knowledge').length === 5 && kinds(named).includes('offer'), `1. naming it beside the four: all five pages and the Offer (${kinds(named).join(',')})`);
    const only = await call(mel, 'GET', '/api/marketplace/posts?type=knowledge');
    assert(kinds(only).length === 5 && kinds(only).every((k) => k === 'knowledge'), `1. type=knowledge: the five pages only (${kinds(only).join(',')})`);
    const one = await call(mel, 'GET', `/api/marketplace/posts?type=knowledge&id=${kTip}`);
    const k = postsOf(one)[0];
    assert(k?.id === kTip && k.knowledge?.place === 'The tip on Manse Road' && k.knowledge?.gathered === false && typeof k.knowledge?.checkedAt === 'string'
        && k.lat == null && k.lng == null && k.price_c === 0, `1. one page by id with its type named: its knowledge fields, no place, no price (${show(one)})`);
    const syncNamed = await call(mel, 'GET', '/api/marketplace/posts?sync=true&types=offer,need,poll,event,knowledge');
    assert(kinds(syncNamed).filter((x) => x === 'knowledge').length === 5, '1. a sync that names it gets them (the phone\'s copy, slice K2)');
    const authorNamed = await call(mel, 'GET', `/api/marketplace/posts?author=${owen.pk}&type=knowledge`);
    assert(kinds(authorNamed).length === 5, '1. author= with the type named: Owen\'s five');

    // ── 2. Never to a visitor ────────────────────────────────────────────────────────────────────
    console.log('── 2. never to a visitor ──');
    const stranger = await call(newId('Stranger'), 'GET', '/api/marketplace/posts?type=knowledge');
    assert(!kinds(stranger).includes('knowledge'), `2. a signed non-member: none (${stranger.status})`);
    const unsigned = await call(null, 'GET', '/api/marketplace/posts?type=knowledge');
    assert(!kinds(unsigned).includes('knowledge'), `2. unsigned: none (${unsigned.status})`);
    const read = getPosts(db, { id: kTip, type: 'knowledge', withKnowledge: true, viewerPubkey: mel.pk })[0]!;
    assert(!!read.knowledge && !('knowledge' in guestPost(read)), "2. a visitor's copy of a post drops its knowledge fields (GUEST_FIELDS: drop)");
    const front401 = await call(null, 'GET', '/api/knowledge/front');
    assert(front401.status === 401 || front401.status === 403, `2. Learn to an unsigned caller: refused (${front401.status})`);
    const front403 = await call(newId('Other'), 'GET', '/api/knowledge/front');
    assert(front403.status === 403, `2. Learn to a key that is no member: 403 (${show(front403)})`);

    // ── 3. No deal, RSVP, vote or pin ────────────────────────────────────────────────────────────
    console.log('── 3. no deal, RSVP, vote or pin ──');
    const deals = () => (db.prepare('SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ?').get(kTip) as { n: number }).n;
    const request = await call(pat, 'POST', '/api/marketplace/posts/request', { postId: kTip, requesterPublicKey: pat.pk });
    assert(request.status >= 400 && deals() === 0, `3. a request for a page: refused, no deal (${show(request)})`);
    const accept = await call(pat, 'POST', '/api/marketplace/posts/accept', { postId: kTip, buyerPublicKey: pat.pk });
    assert(accept.status >= 400 && deals() === 0, `3. a one-step buy of a page: refused (${show(accept)})`);
    const rsvp = await call(pat, 'POST', `/api/marketplace/posts/${kTip}/rsvp`, { status: 'going', memberPublicKey: pat.pk });
    assert(rsvp.status >= 400 && !(db.prepare('SELECT 1 FROM event_rsvps WHERE post_id = ?').get(kTip)), `3. an RSVP: refused (${show(rsvp)})`);
    const vote = await call(pat, 'POST', `/api/marketplace/posts/${kTip}/vote`, { optionId: 'opt_1', voterPublicKey: pat.pk });
    assert(vote.status >= 400 && !(db.prepare('SELECT 1 FROM poll_votes WHERE post_id = ?').get(kTip)), `3. a vote: refused (${show(vote)})`);
    const pin = await call(null, 'POST', `/api/marketplace/posts/${kTip}/pin`, { days: 7 }, ownerPhoneSessionHeaders(owen.pk));
    const pinSigned = await call(owen, 'POST', `/api/marketplace/posts/${kTip}/pin`, { days: 7 });
    const pinned = (db.prepare('SELECT pinned_until FROM posts WHERE id = ?').get(kTip) as { pinned_until: string | null }).pinned_until;
    assert(pinned === null && pin.status >= 400 && pinSigned.status >= 400, `3. a Market pin: refused, none set (${show(pinSigned)})`);

    // ── 4. Never a listing ───────────────────────────────────────────────────────────────────────
    console.log('── 4. never a listing ──');
    assert(getActivePostCount() === countBefore, `4. the active listings count doesn't move (${countBefore} → ${getActivePostCount()})`);
    const placed = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE type = 'knowledge' AND (lat IS NOT NULL OR lng IS NOT NULL)").get() as { n: number };
    assert(placed.n === 0, '4. no page has a place, so no map and no distance ever meets one');
    const near = await call(mel, 'GET', '/api/marketplace/posts?lat=-28.55&lng=153.5&radiusKm=50&types=offer,need,poll,event,knowledge');
    assert(!kinds(near).includes('knowledge'), '4. a read within a radius meets none, even naming it');

    // ── 5. Learn's front ─────────────────────────────────────────────────────────────────────────
    console.log("── 5. Learn's front ──");
    // A third page in Local services, and the order's own facts: one helped most, one marked out of date.
    const third = await call(owen, 'POST', '/api/knowledge/posts', { title: 'Allotments', body: 'Ask at the hall.', topic: 'local-services' });
    const kAllot = third.body.post.id as string;
    const fourth = await call(owen, 'POST', '/api/knowledge/posts', { title: 'Aardvark rescue', body: 'Not really.', topic: 'local-services' });
    const kAard = fourth.body.post.id as string;
    db.prepare('UPDATE posts SET knowledge_helped = 12 WHERE id = ?').run(kTip);
    await call(owen, 'POST', `/api/knowledge/posts/${kAard}/outdated`, { note: 'gone' });
    const front = await call(mel, 'GET', '/api/knowledge/front');
    assert(front.status === 200 && front.body?.total === 7, `5. Mel reads Learn: 7 pages (${show(front)})`);
    const topicIds = (front.body?.topics ?? []).map((t: any) => t.id);
    assert(JSON.stringify(topicIds) === JSON.stringify(['emergencies', 'local-services', 'getting-around', 'good-to-know']),
        `5. only the topics that hold something, in the fixed order, Emergencies first (${topicIds.join(',')})`);
    const services = front.body.topics.find((t: any) => t.id === 'local-services');
    assert(services.count === 4 && services.rows.length === 3, `5. Local services: its count 4, three rows (${services.count}, ${services.rows.length})`);
    assert(JSON.stringify(services.rows.map((r: any) => r.title)) === JSON.stringify(['At the tip', 'Allotments', 'Bins day']),
        `5. most helped first, then A to Z; the one marked out of date goes last, off the front (${services.rows.map((r: any) => r.title).join(' · ')})`);
    const row = services.rows[0];
    assert(row && !('body' in row) && !('description' in row) && row.line === 'Bring glass sorted.' && row.helped === 12 && row.outdated === false
        && row.photo === null && typeof row.checkedAt === 'string' && row.pinned === false,
        `5. a row is the card's fields and the first line, never the body (${JSON.stringify(row)})`);
    const bins = services.rows.find((r: any) => r.id === kBins);
    assert(bins?.line === 'Bins go out on Tuesday night.', '5. the first line stops at the first line break');
    assert(Array.isArray(front.body.pinned) && front.body.pinned.length === 0, '5. nothing pinned');
    assert(!front.text.includes(owen.pk), '5. no writer key in Learn\'s rows');

    // ── 6. topic= and q= ─────────────────────────────────────────────────────────────────────────
    console.log('── 6. one topic, and a search ──');
    const topic = await call(mel, 'GET', '/api/knowledge/front?topic=local-services');
    assert(topic.status === 200 && topic.body?.count === 4 && topic.body.rows.length === 4 && topic.body.next === null
        && topic.body.rows[3].id === kAard && topic.body.rows[3].outdated === true, `6. topic=: every row, out of date last (${show(topic)})`);
    const badTopic = await call(mel, 'GET', '/api/knowledge/front?topic=food');
    assert(badTopic.status === 400, '6. a topic that isn\'t one: 400');
    const both = await call(mel, 'GET', '/api/knowledge/front?topic=emergencies&q=x');
    assert(both.status === 400, '6. topic and q together: 400');
    const byPlace = await call(mel, 'GET', `/api/knowledge/front?q=${encodeURIComponent('manse')}`);
    assert(byPlace.status === 200 && byPlace.body?.rows?.[0]?.id === kTip, `6. q finds a page by its place (${show(byPlace)})`);
    const byTopicWord = await call(mel, 'GET', '/api/knowledge/front?q=emergency');
    assert(byTopicWord.body?.rows?.some((r: any) => r.id === kFlood), `6. q finds a page by its topic's words (${show(byTopicWord)})`);
    const best = await call(mel, 'GET', '/api/knowledge/front?q=hall');
    const order = (best.body?.rows ?? []).map((r: any) => r.id);
    assert(order[0] === kWifi && order.includes(kAllot), `6. best match first: "hall" in the title before "hall" in the words (${order.join(',')})`);
    assert((best.body?.rows ?? []).every((r: any) => !('description' in r)), '6. a search row carries no body either');
    const none = await call(mel, 'GET', '/api/knowledge/front?q=zzzzqqq');
    assert(none.status === 200 && none.body?.total === 0 && none.body.rows.length === 0, '6. nothing found is an empty list');
    const longQ = await call(mel, 'GET', `/api/knowledge/front?q=${'w'.repeat(101)}`);
    assert(longQ.status === 400, '6. q over 100 characters: 400');

    // ── 7. Off ───────────────────────────────────────────────────────────────────────────────────
    console.log('── 7. off ──');
    setOverride('knowledge', 'false');
    const offFront = await call(mel, 'GET', '/api/knowledge/front');
    assert(offFront.status === 404 && offFront.body?.code === 'feature_off', `7. off: Learn is 404 feature_off (${show(offFront)})`);
    const offNamed = await call(mel, 'GET', '/api/marketplace/posts?types=offer,need,poll,event,knowledge');
    assert(!kinds(offNamed).includes('knowledge') && kinds(offNamed).includes('offer'), '7. off: a read that names it gets none, the Offer still');
    const offById = await call(mel, 'GET', `/api/marketplace/posts?type=knowledge&id=${kTip}`);
    assert(postsOf(offById).length === 0, '7. off: not even by id');
    dropOverride('knowledge');

    // ── 8. Taken down leaves Learn ───────────────────────────────────────────────────────────────
    console.log('── 8. a page taken down ──');
    require_((await call(owen, 'POST', `/api/knowledge/posts/${kBus}/take-down`, {})).status === 200, 'Owen takes the bus page down');
    const after = await call(mel, 'GET', '/api/knowledge/front');
    assert(after.body?.total === 6 && !after.text.includes(kBus), '8. it leaves Learn');
    const authorOffer = await call(mel, 'GET', `/api/marketplace/posts?author=${mel.pk}`);
    assert(kinds(authorOffer).join() === 'offer', '8. a member\'s own read of their listings is as before');

    // ── 9. The standby copy ──────────────────────────────────────────────────────────────────────
    console.log('── 9. the standby copy ──');
    const copy = await exportSyncState('test-knowledge-reads') as any;
    const copied = (copy.posts ?? []).find((p: any) => p.id === kTip);
    assert(copied?.type === 'knowledge' && copied.knowledgeColumns?.place === 'The tip on Manse Road' && copied.knowledgeColumns?.helped === 12
        && typeof copied.knowledgeColumns?.checkedAt === 'string' && 'sources' in copied.knowledgeColumns,
        `9. the copy carries every knowledge column (${JSON.stringify(copied?.knowledgeColumns)})`);
    const copiedOffer = (copy.posts ?? []).find((p: any) => p.id === offerId);
    assert(copiedOffer && !('knowledgeColumns' in copiedOffer), '9. an Offer carries none');
    assert(KNOWLEDGE_TOPICS.length === 7, '(seven topics)');

    // ── 10. Its writer on holiday ────────────────────────────────────────────────────────────────
    // Holiday is a member's trade pause: their listings leave the Market. A page is no trade, so it stays in Learn
    // (the review of #3063): Emergencies is never emptied because its writer is away.
    console.log('── 10. its writer on holiday ──');
    const owenOffer = await call(owen, 'POST', '/api/marketplace/posts', { type: 'offer', category: 'food', title: 'Spare jars', description: 'A box', price_c: 0, authorPublicKey: owen.pk, photos: [TEST_PHOTO] });
    require_(owenOffer.status === 200, `Owen posts an Offer (${show(owenOffer)})`);
    const owenOfferId = owenOffer.body.post.id as string;
    const marketIds = async () => postsOf(await call(mel, 'GET', '/api/marketplace/posts?types=offer,need,poll,event')).map((p) => p.id);
    require_((await marketIds()).includes(owenOfferId), "Owen's Offer is on Mel's Market");
    const learnBefore = await call(mel, 'GET', '/api/knowledge/front');
    const holiday = await call(owen, 'POST', '/api/members/holiday', { enabled: true });
    require_(holiday.status === 200 && holiday.body?.enabled === true, `Owen goes on holiday (${show(holiday)})`);
    const away = await call(mel, 'GET', '/api/knowledge/front');
    const awayEmergencies = (away.body?.topics ?? []).find((t: any) => t.id === 'emergencies');
    assert(away.status === 200 && away.body?.total === learnBefore.body?.total && away.body.total === 6 && awayEmergencies?.count === 1
        && awayEmergencies.rows[0]?.id === kFlood, `10. Learn's front keeps every page, Emergencies too (${learnBefore.body?.total} → ${away.body?.total}; ${show(away)})`);
    const awayTopic = await call(mel, 'GET', '/api/knowledge/front?topic=emergencies');
    assert(awayTopic.status === 200 && awayTopic.body?.count === 1 && awayTopic.body.rows[0]?.id === kFlood, `10. topic=emergencies still holds the flood page (${show(awayTopic)})`);
    const awaySearch = await call(mel, 'GET', '/api/knowledge/front?q=flood');
    assert(awaySearch.status === 200 && awaySearch.body?.total === 1 && awaySearch.body.rows[0]?.id === kFlood, `10. q=flood still finds it (${show(awaySearch)})`);
    const awayNamed = await call(mel, 'GET', '/api/marketplace/posts?type=knowledge');
    assert(kinds(awayNamed).length === 6, `10. a read that names the type still gets the six pages (${kinds(awayNamed).length})`);
    const awaySync = await call(mel, 'GET', '/api/marketplace/posts?sync=true&types=offer,need,poll,event,knowledge');
    // A sync carries the page taken down in 8 too, as taken down (cancelled): the six showing pages are as they are.
    const syncPages = postsOf(awaySync).filter((p) => p.type === 'knowledge');
    const syncShowing = syncPages.filter((p) => p.id !== kBus);
    const syncOffer = postsOf(awaySync).find((p) => p.id === owenOfferId);
    assert(syncShowing.length === 6 && syncShowing.every((p) => p.status === 'active') && !syncPages.some((p) => p.status === 'paused'),
        `10. a sync gives the pages as they are, never as paused (${syncPages.map((p) => `${p.id === kBus ? 'taken down ' : ''}${p.status}`).join(',')})`);
    assert(syncOffer?.status === 'paused', `10. and the same sync gives Owen's Offer as paused, as before (${syncOffer?.status})`);
    const market = await marketIds();
    assert(!market.includes(owenOfferId) && market.includes(offerId), `10. the Market still hides Owen's Offer, and Mel's stays (${market.join(',')})`);
    const marketSearch = await call(mel, 'GET', '/api/marketplace/posts?q=jars');
    assert(!postsOf(marketSearch).some((p) => p.id === owenOfferId), "10. a Market search doesn't find it either");
    require_((await call(owen, 'POST', '/api/members/holiday', { enabled: false })).status === 200, 'Owen is back');
    assert((await marketIds()).includes(owenOfferId), '10. back from holiday, the Offer is on the Market again');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
