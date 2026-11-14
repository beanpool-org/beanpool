/**
 * Local knowledge in the Pulse, slice KP node (scratch/fable-design/DESIGN-local-knowledge-amend-fable.md §2.12, §3.8, §A6,
 * §A8 `test-knowledge-pulse`): the knowledge card on GET /api/pulse/feed, through the real HTTPS stack and its signature
 * middleware.
 *
 *  1. The old-app promise: a read without `with=knowledge` holds no card; with it, one card for the day, in a feed item's
 *     fields (the owner's empty), its rows the row card's (never the body), "by {name}" only on a single page a member wrote.
 *  2. One card a day: a day's pages grouped (count, the newest three, the newest's title and time, no name); other days
 *     their own cards, newest first; a page gathered with the assistant names nobody.
 *  3. 30 days and the newest 20 only: a 31-day-old page and the 21st newest are not counted.
 *  4. Where it never goes: under `category=`, where the switch is off, on a node with the visitors' view (the global
 *     community), to a suspended member, a visitor, a stranger or an unsigned read.
 *  5. The feed's own order: the cards merge into the keyset order; a page boundary through a day's card neither repeats nor
 *     skips an item at any page size, with a creator's item tied on the card's time on either side of its id; a page holds
 *     `limit` items.
 *  6. The class: every way a page stops showing (taken down by an owner or an admin, hidden by reports, its writer removed,
 *     paused or gone of their own accord) takes its card at the next read with no other write, as Learn drops it; a fix,
 *     "Still right", a mark and its clearing, holiday and a suspension add no card and keep it, as Learn keeps it.
 *  7. A standby answers the same.
 *  8. Mute and report of a `know_` id answer not found.
 *  9. Home's Pulse card holds none.
 * 10. Nothing stored: no table, no Pulse row, written by any of it.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knowledge-pulse" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast, adminPruneUser, adminSetUserStatus, purgeMemberSelf, COMMUNITY_DECISION_ACTOR } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';
import { setNodeRole } from './config/node-role.js';
import { registerMemberInternal, registerVisitor } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { nodeLocalDay } from './engine/knowledge.js';
import { PULSE_KNOWLEDGE_DAYS, PULSE_KNOWLEDGE_MAX_PAGES, PULSE_KNOWLEDGE_ROWS } from '@beanpool/core';
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
    return { status: res.status, body: parsed, text };
}
const show = (v: unknown) => JSON.stringify(v ?? null).slice(0, 300);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);

/** A feed read; `with=knowledge` is the app's word for "I draw the knowledge card". */
const feed = (id: Id | null, query = 'with=knowledge&limit=50') => call(id, 'GET', `/api/pulse/feed?${query}`);
const itemsOf = (r: Res): any[] => (Array.isArray(r.body?.items) ? r.body.items : []);
const cardsOf = (r: Res): any[] => itemsOf(r).filter((i) => i.source === 'knowledge');
const cardOn = (r: Res, day: string): any => cardsOf(r).find((c) => c.id === `know_${day}`);
/** Every page id a read's cards name (each card names at most three). */
const namedPages = (r: Res): string[] => cardsOf(r).flatMap((c) => (c.knowledge?.posts ?? []).map((p: any) => p.id));
const countedPages = (r: Res): number => cardsOf(r).reduce((n, c) => n + (c.knowledge?.count ?? 0), 0);

/** Midnight at the start of the node's local day holding `ms`, to the minute (a zone's offset can be a half hour). */
function localMidnight(ms: number): number {
    const day = nodeLocalDay(ms);
    let t = ms - (ms % 60_000);
    while (nodeLocalDay(t - HOUR_MS) === day) t -= HOUR_MS;
    while (nodeLocalDay(t - 60_000) === day) t -= 60_000;
    return t;
}
/** Local noon `k` days before today: a moment well inside that day whatever the zone or a clock change. */
const noonDaysAgo = (k: number) => localMidnight(localMidnight(Date.now()) - k * DAY_MS + 12 * HOUR_MS) + 12 * HOUR_MS;
/** When a page first showed. A test's own clock: the node reads it as it reads every post's. */
const setShown = (postId: string, ms: number) => db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(iso(ms), postId);
/** Every page so far first showed two months ago: out of the Pulse, still in Learn. */
const ageAllOut = () => db.prepare("UPDATE posts SET created_at = ? WHERE type = 'knowledge'").run(iso(Date.now() - 60 * DAY_MS));
/** What the Pulse's own table holds: no knowledge card is ever one of its rows, and nothing here writes one. */
const pulseRows = () => JSON.stringify(db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS u FROM pulse_items").get());
const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name").all() as { name: string }[]).map((r) => r.name).join(',');

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const tablesBefore = tables();

    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community: its first member');
    grantNodeRole(owen.pk, 'owner', claim);
    const names = ['Ada', 'Mel', 'Pat', 'Rhea', 'Sam', 'Tia', 'Uma', 'Vic', 'Wren', 'Xan', 'Yul', 'Zed', 'Bo', 'Cy', 'Di', 'Eli', 'Fen'];
    const people = names.map(newId);
    for (const who of people) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    const [ada, mel, pat, rhea, sam, ...writers] = people;
    grantNodeRole(ada.pk, 'admin', owen.pk);
    for (const who of [owen, ...people]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);
    const stranger = newId('Stranger');

    const publish = async (who: Id, title: string, topic = 'local-services', body = `What to know about ${title}.\nMore on the next line.`): Promise<string> => {
        const r = await call(who, 'POST', '/api/knowledge/posts', { title, body, topic });
        require_(r.status === 201, `${who.name} publishes "${title}" (${r.status} ${r.text.slice(0, 120)})`);
        return r.body.post.id as string;
    };
    /** A member's suggestion, approved by Owen: the page is the member's (the writer), shown at approval. */
    const suggestApproved = async (who: Id, title: string, topic = 'good-to-know'): Promise<string> => {
        const s = await call(who, 'POST', '/api/knowledge/drafts', { title, body: `${title}, as ${who.name} knows it.`, topic });
        require_(s.status === 201, `${who.name} suggests "${title}" (${s.status} ${s.text.slice(0, 120)})`);
        const a = await call(owen, 'POST', `/api/knowledge/drafts/${s.body.draft.id}/approve`, {});
        require_(a.status === 200 && a.body?.post?.id, `Owen approves "${title}" (${a.status} ${a.text.slice(0, 120)})`);
        return a.body.post.id as string;
    };

    // A creator's channel with items, so the cards have a feed to merge into.
    db.prepare(`INSERT INTO creator_channels (id, owner_pubkey, platform, url, category, created_at, updated_at)
                VALUES ('chan-pat', ?, 'youtube', 'https://youtube.example/@pat', 'food', ?, ?)`).run(pat.pk, iso(Date.now()), iso(Date.now()));
    const addItem = (id: string, publishedAt: string | null, title = id) => db.prepare(
        `INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, url, title, published_at, category, source)
         VALUES (?, 'chan-pat', ?, 'youtube', ?, ?, ?, 'food', 'autolist')`,
    ).run(id, pat.pk, `https://youtube.example/watch?v=${id}`, title, publishedAt);
    addItem('item_pat_recent', iso(Date.now() - 2 * HOUR_MS), 'Sourdough at dawn');

    // ── 1. The old-app promise ───────────────────────────────────────────────────────────────────
    console.log('── 1. the old-app promise ──');
    const today = nodeLocalDay(Date.now());
    const first = await suggestApproved(mel, 'Where the tip takes glass');
    const plain = await feed(mel, 'limit=50');
    require_(plain.status === 200, `Mel reads the Pulse (${plain.status} ${plain.text.slice(0, 120)})`);
    assert(cardsOf(plain).length === 0 && !plain.text.includes('know_') && !plain.text.includes(first),
        `1. a read without with=knowledge holds no knowledge card (${show(itemsOf(plain).map((i) => i.id))})`);
    assert(itemsOf(plain).some((i) => i.id === 'item_pat_recent'), "1. and is the creators' feed it always was");
    const asked = await feed(mel);
    const card = cardOn(asked, today);
    assert(cardsOf(asked).length === 1 && !!card, `1. with it: one card, know_${today} (${show(cardsOf(asked))})`);
    const shown = db.prepare('SELECT created_at FROM posts WHERE id = ?').get(first) as { created_at: string };
    assert(card?.source === 'knowledge' && card.platform === 'beanpool' && card.category === 'knowledge' && card.url === null && card.thumbnailUrl === null
        && card.ownerPubkey === '' && card.callsign === '' && card.avatarUrl === null && card.isVerified === false
        && card.title === 'Where the tip takes glass' && card.publishedAt === iso(Date.parse(shown.created_at)),
        `1. in a feed item's fields, the owner's empty, placed at the page's own time (${show(card)})`);
    const row = card?.knowledge?.posts?.[0];
    assert(card?.knowledge?.count === 1 && card.knowledge.posts.length === 1 && row?.id === first && row.title === 'Where the tip takes glass'
        && row.topic === 'good-to-know' && row.line === 'Where the tip takes glass, as Mel knows it.' && row.photo === null && row.gathered === false,
        `1. its row is the row card's: id, title, topic, first line, photo (${show(row)})`);
    assert(row && !('description' in row) && !('body' in row) && Object.keys(row).sort().join() === 'by,gathered,id,line,photo,title,topic',
        `1. a row never carries the body, nor anything but its seven fields (${Object.keys(row ?? {}).join()})`);
    assert(row?.by === 'Mel', `1. "by {name}" on a single page a member wrote (${row?.by})`);
    assert(!asked.text.includes(mel.pk) && !asked.text.includes(owen.pk), '1. no key of its writer or approver anywhere in the card');

    // ── 2. One card a day ────────────────────────────────────────────────────────────────────────
    console.log('── 2. one card a day ──');
    const p2 = await publish(owen, 'Bins day');
    const p3 = await publish(owen, 'Recycling at the hall');
    const p4 = await publish(ada, 'Library hours');
    // Four pages on one day, a second apart, the approval of Mel's first the oldest: inside today even just after midnight.
    const t0 = Math.max(Date.now() - 5 * 60_000, localMidnight(Date.now()) + 10_000);
    [first, p2, p3, p4].forEach((id, i) => setShown(id, t0 + i * 1000));
    const day = await feed(mel);
    const todays = cardOn(day, today);
    assert(cardsOf(day).length === 1 && todays?.knowledge?.count === 4, `2. four pages the same day: one card, count 4 (${show(cardsOf(day))})`);
    assert(JSON.stringify((todays?.knowledge?.posts ?? []).map((p: any) => p.id)) === JSON.stringify([p4, p3, p2]) && PULSE_KNOWLEDGE_ROWS === 3,
        `2. its rows: the newest three, newest first (${show(todays?.knowledge?.posts?.map((p: any) => p.title))})`);
    assert(todays?.title === 'Library hours' && todays.publishedAt === iso(t0 + 3000), `2. the newest's title, at the newest's time (${todays?.title} ${todays?.publishedAt})`);
    assert((todays?.knowledge?.posts ?? []).every((p: any) => p.by === null), '2. grouped: no name on any row');
    // Two other days.
    setShown(p2, noonDaysAgo(2));
    setShown(p3, noonDaysAgo(5));
    const days = await feed(mel);
    const want = [today, nodeLocalDay(noonDaysAgo(2)), nodeLocalDay(noonDaysAgo(5))].map((d) => `know_${d}`);
    assert(JSON.stringify(cardsOf(days).map((c) => c.id)) === JSON.stringify(want), `2. three days, three cards, newest first (${cardsOf(days).map((c) => c.id).join(',')})`);
    assert(cardOn(days, nodeLocalDay(noonDaysAgo(2)))?.knowledge?.posts?.[0]?.by === 'Owen', '2. a single page an owner wrote names them too: they are a member');
    // A page gathered with the assistant names nobody, alone on its day.
    db.prepare("UPDATE posts SET created_via = 'assistant-draft:grant-test' WHERE id = ?").run(p2);
    const gathered = cardOn(await feed(mel), nodeLocalDay(noonDaysAgo(2)))?.knowledge?.posts?.[0];
    assert(gathered?.gathered === true && gathered.by === null, `2. gathered with the assistant: marked, and no name (${show(gathered)})`);
    db.prepare('UPDATE posts SET created_via = NULL WHERE id = ?').run(p2);

    // ── 3. 30 days and the newest 20 ─────────────────────────────────────────────────────────────
    console.log('── 3. 30 days, the newest 20 ──');
    ageAllOut();
    assert(cardsOf(await feed(mel)).length === 0, '3. pages that first showed two months ago: no card (they stay in Learn)');
    const old = await publish(owen, 'An old page');
    setShown(old, Date.now() - (PULSE_KNOWLEDGE_DAYS + 1) * DAY_MS);
    const recentish = await publish(owen, 'A month-old page');
    setShown(recentish, Date.now() - (PULSE_KNOWLEDGE_DAYS - 1) * DAY_MS);
    const window = await feed(mel);
    assert(!namedPages(window).includes(old) && namedPages(window).includes(recentish) && countedPages(window) === 1,
        `3. a ${PULSE_KNOWLEDGE_DAYS + 1}-day-old page is not counted; a ${PULSE_KNOWLEDGE_DAYS - 1}-day-old one is (${show(cardsOf(window))})`);
    ageAllOut();
    const many: string[] = [];
    for (let i = 0; i <= PULSE_KNOWLEDGE_MAX_PAGES; i++) many.push(await publish(owen, `Page ${String(i).padStart(2, '0')}`));
    // One a day, the first the oldest: 21 days, 21 cards of one page each, if all were counted.
    many.forEach((id, i) => setShown(id, noonDaysAgo(PULSE_KNOWLEDGE_MAX_PAGES - i)));
    const capped = await feed(mel);
    assert(countedPages(capped) === PULSE_KNOWLEDGE_MAX_PAGES && cardsOf(capped).length === PULSE_KNOWLEDGE_MAX_PAGES,
        `3. 21 pages in the window: the newest ${PULSE_KNOWLEDGE_MAX_PAGES} counted (${countedPages(capped)} in ${cardsOf(capped).length} cards)`);
    assert(!namedPages(capped).includes(many[0]) && namedPages(capped).includes(many[1]), '3. the 21st newest is the one left out');
    ageAllOut();

    // ── 4. Where it never goes ───────────────────────────────────────────────────────────────────
    console.log('── 4. where it never goes ──');
    const fresh = await publish(owen, 'Who to call in a flood', 'emergencies');
    require_(!!cardOn(await feed(mel), today), 'a fresh page: a card today');
    for (const category of ['food', 'learn', 'knowledge']) {
        const r = await feed(mel, `with=knowledge&category=${category}&limit=50`);
        assert(r.status === 200 && cardsOf(r).length === 0 && !r.text.includes('know_'), `4. category=${category}: no card (${show(itemsOf(r).map((i) => i.id))})`);
    }
    setOverride('knowledge', 'false');
    const off = await feed(mel);
    assert(off.status === 200 && cardsOf(off).length === 0 && itemsOf(off).some((i) => i.id === 'item_pat_recent'), `4. the switch off: no card, the creators' feed still (${show(itemsOf(off).map((i) => i.id))})`);
    dropOverride('knowledge');
    setOverride('guestListingsOnly', 'true');
    const globalLike = await feed(mel);
    assert(globalLike.status === 200 && cardsOf(globalLike).length === 0, `4. a node with the visitors' view (the global community), even with Learn's switch on: no card (${show(cardsOf(globalLike))})`);
    dropOverride('guestListingsOnly');
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(sam.pk);
    const suspended = await feed(sam);
    assert(suspended.status === 200 && cardsOf(suspended).length === 0, `4. a suspended member: the feed, and no card (${suspended.status} ${show(cardsOf(suspended))})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(sam.pk);
    assert(!!cardOn(await feed(sam), today), '4. active again: the card');
    const strangers = await feed(stranger);
    assert(strangers.status === 403 && !strangers.text.includes('know_') && !strangers.text.includes(fresh), `4. a stranger: 403, nothing of it (${strangers.status})`);
    // A visitor: a key from another community with a row here (as a message across communities makes one).
    const visitor = newId('Visitor');
    registerVisitor(visitor.pk, 'Visitor', 'https://elsewhere.example');
    require_(!!db.prepare('SELECT 1 FROM members WHERE public_key = ? AND is_visitor = 1').get(visitor.pk), 'a visitor has a row here');
    const visitors = await feed(visitor);
    assert(visitors.status !== 200 && !visitors.text.includes('know_') && !visitors.text.includes(fresh), `4. a visitor: refused, nothing of it (${visitors.status})`);
    const unsigned = await feed(null);
    assert(unsigned.status === 401 && !unsigned.text.includes('know_'), `4. unsigned: 401 (${unsigned.status})`);
    ageAllOut();

    // ── 5. The feed's own order ──────────────────────────────────────────────────────────────────
    console.log("── 5. the feed's own order ──");
    const a = await publish(owen, 'Order one');
    const b = await publish(owen, 'Order two');
    const c = await publish(owen, 'Order three');
    const tA = noonDaysAgo(1), tB = noonDaysAgo(2), tC = noonDaysAgo(4);
    setShown(a, tA); setShown(b, tB); setShown(c, tC);
    // A creator's item on each side of each card's time, and two tied on day 1's card's very time: one whose id sorts
    // below `know_…`, one above, so the tie breaks each way.
    addItem('item_tie_below', iso(tA));
    addItem('zz_tie_above', iso(tA));
    addItem('item_after_b', iso(tB + 60_000));
    addItem('item_before_b', iso(tB - 60_000));
    addItem('item_day3', iso(noonDaysAgo(3)));
    addItem('item_tie_c', iso(tC));
    addItem('item_undated', null);
    const whole = await feed(mel);
    const all = itemsOf(whole).map((i) => i.id);
    const key = (i: any) => i.publishedAt ?? '';
    const sorted = [...itemsOf(whole)].sort((x, y) => (key(x) < key(y) ? 1 : key(x) > key(y) ? -1 : x.id < y.id ? 1 : x.id > y.id ? -1 : 0)).map((i) => i.id);
    assert(whole.body?.nextCursor === null && JSON.stringify(all) === JSON.stringify(sorted), `5. one page of everything is in the feed's order (time, then id, newest first): ${all.join(' ')}`);
    const dayA = `know_${nodeLocalDay(tA)}`;
    const at = (id: string) => all.indexOf(id);
    assert(at('zz_tie_above') < at(dayA) && at(dayA) < at('item_tie_below'), `5. tied on the card's time: the higher id first, either side (${all.slice(at('zz_tie_above'), at('item_tie_below') + 1).join(' ')})`);
    assert(at('item_after_b') < at(`know_${nodeLocalDay(tB)}`) && at(`know_${nodeLocalDay(tB)}`) < at('item_before_b'), '5. a card between the items either side of its time');
    assert(at('item_undated') === all.length - 1, '5. an item with no date still last');
    let pagedOk = true;
    const report: string[] = [];
    for (let limit = 1; limit <= all.length + 1; limit++) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let sizesOk = true;
        for (let guard = 0; guard < 100; guard++) {
            const r = await feed(mel, `with=knowledge&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            const ids = itemsOf(r).map((i) => i.id);
            seen.push(...ids);
            cursor = r.body?.nextCursor ?? null;
            if (cursor && ids.length !== limit) sizesOk = false;
            if (!cursor) break;
        }
        const same = JSON.stringify(seen) === JSON.stringify(all);
        if (!same || !sizesOk) { pagedOk = false; report.push(`limit ${limit}: ${seen.join(' ')}`); }
    }
    assert(pagedOk, `5. paged at every size from 1 to ${all.length + 1}, each boundary through a card or beside it: nothing repeated, nothing skipped, a full page until the last${report.length ? ` (${report.join(' | ')})` : ''}`);
    const throughCard = await feed(mel, `with=knowledge&limit=1&cursor=${encodeURIComponent(`${iso(tA)}|${dayA}`)}`);
    assert(itemsOf(throughCard)[0]?.id === 'item_tie_below', `5. a cursor on the card itself resumes after it (${show(itemsOf(throughCard).map((i) => i.id))})`);
    const plainPaged = await feed(mel, 'limit=50');
    assert(cardsOf(plainPaged).length === 0 && itemsOf(plainPaged).length === all.length - 3, '5. without the word the same feed has the three cards fewer, and nothing else changes');
    const capLimit = await feed(mel, 'with=knowledge&limit=500');
    assert(itemsOf(capLimit).length <= 50, `5. a page is still at most 50 (${itemsOf(capLimit).length})`);
    ageAllOut();

    // ── 6. The class: every way a page stops showing, and every change that is not one ──────────
    console.log('── 6. every way a page stops showing ──');
    const learnHas = async (id: string, topic: string) =>
        ((await call(rhea, 'GET', `/api/knowledge/front?topic=${topic}`)).body?.rows ?? []).some((r: any) => r.id === id);
    interface Way { name: string; byMember: boolean; gone: boolean; act: (page: string, writer: Id) => Promise<void> | void; after?: (r: Res, page: string, day: string) => void }
    const ok = (r: Res, what: string) => require_(r.status === 200, `${what} (${r.status} ${r.text.slice(0, 120)})`);
    const ways: Way[] = [
        { name: 'taken down by an owner', byMember: false, gone: true, act: async (p) => ok(await call(owen, 'POST', `/api/knowledge/posts/${p}/take-down`, {}), 'Owen takes it down') },
        { name: 'taken down by an admin', byMember: true, gone: true, act: async (p) => ok(await call(ada, 'POST', `/api/knowledge/posts/${p}/take-down`, { reasonCategory: 'misleading' }), 'Ada takes it down') },
        { name: 'hidden by reports', byMember: true, gone: true, act: (p) => { db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(iso(Date.now()), p); } },
        // Removing a member is the community's vote: the prune the passed Decision makes.
        { name: 'its writer removed (pruned)', byMember: true, gone: true, act: (_p, w) => { adminPruneUser(w.pk, COMMUNITY_DECISION_ACTOR); } },
        { name: "its writer's account paused by an admin", byMember: true, gone: true, act: (_p, w) => { adminSetUserStatus(w.pk, 'disabled'); } },
        { name: 'its writer deletes their own account', byMember: true, gone: true, act: (_p, w) => { purgeMemberSelf(w.pk); } },
        { name: 'its writer on holiday', byMember: true, gone: false, act: async (_p, w) => ok(await call(w, 'POST', '/api/members/holiday', { enabled: true }), 'the writer goes on holiday') },
        { name: 'its writer suspended', byMember: true, gone: false, act: (_p, w) => { db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(w.pk); } },
        {
            name: 'a fix by an owner', byMember: true, gone: false,
            act: async (p) => ok(await call(owen, 'POST', `/api/knowledge/posts/${p}/edit`, { title: 'Fixed title', body: 'Corrected words.', topic: 'good-to-know' }), 'Owen fixes it'),
            after: (r, _p, d) => assert(cardOn(r, d)?.title === 'Fixed title' && cardOn(r, d)?.knowledge?.posts?.[0]?.line === 'Corrected words.', '6. a fix: the corrected title and line are in the card'),
        },
        { name: '"Still right"', byMember: true, gone: false, act: async (p) => ok(await call(ada, 'POST', `/api/knowledge/posts/${p}/checked`, {}), 'Ada says "Still right"') },
        { name: 'marked "may be out of date" by its writer', byMember: true, gone: false, act: async (p, w) => ok(await call(w, 'POST', `/api/knowledge/posts/${p}/outdated`, { note: 'moved' }), 'the writer marks it') },
        {
            name: 'the mark cleared by an owner', byMember: true, gone: false,
            act: async (p, w) => {
                ok(await call(w, 'POST', `/api/knowledge/posts/${p}/outdated`, { note: 'moved' }), 'the writer marks it');
                ok(await call(owen, 'POST', `/api/knowledge/posts/${p}/outdated/clear`, {}), 'Owen clears the mark');
            },
        },
    ];
    const memberWays = ways.filter((way) => way.byMember).length;
    require_(writers.length >= memberWays, `a writer for each way a member's page is tried (${writers.length} for ${memberWays})`);
    let w = 0;
    for (const [i, way] of ways.entries()) {
        const writer = way.byMember ? writers[w++] : owen;
        const page = way.byMember ? await suggestApproved(writer, `Page for ${way.name}`) : await publish(owen, `Page for ${way.name}`, 'good-to-know');
        // Alone on its own day, so its card is its own.
        const shownAt = noonDaysAgo(6 + i);
        setShown(page, shownAt);
        const dayOf = nodeLocalDay(shownAt);
        const before = await feed(rhea);
        const cardBefore = cardOn(before, dayOf);
        require_(cardBefore?.knowledge?.count === 1 && cardBefore.knowledge.posts[0].id === page, `${way.name}: its card before (${show(cardBefore)})`);
        require_(await learnHas(page, 'good-to-know'), `${way.name}: in Learn before`);
        const pulse = pulseRows();
        const cardsBefore = cardsOf(before).map((c) => c.id).join();
        await way.act(page, writer);
        const after = await feed(rhea);
        const inLearn = await learnHas(page, 'good-to-know');
        const cardAfter = cardOn(after, dayOf);
        if (way.gone) {
            assert(!cardAfter && !namedPages(after).includes(page) && !inLearn, `6. ${way.name}: the card goes at the next read, as the page leaves Learn (${show(cardAfter)})`);
            assert(cardsOf(after).map((c) => c.id).join() === cardsOf(before).filter((c) => c.id !== `know_${dayOf}`).map((c) => c.id).join(), `6. ${way.name}: every other card as it was`);
        } else {
            assert(!!cardAfter && cardAfter.knowledge.count === 1 && cardAfter.publishedAt === cardBefore.publishedAt && inLearn,
                `6. ${way.name}: the card stays, at the same time, as the page stays in Learn (${show(cardAfter)})`);
            assert(cardsOf(after).map((c) => c.id).join() === cardsBefore, `6. ${way.name}: no card added (${cardsOf(after).map((c) => c.id).join()})`);
        }
        assert(pulseRows() === pulse, `6. ${way.name}: no Pulse row written`);
        way.after?.(after, page, dayOf);
        // Put back what can be: a holiday ended, a suspension lifted, a paused account resumed (each card back as it was).
        if (way.name === 'its writer on holiday') await call(writer, 'POST', '/api/members/holiday', { enabled: false });
        if (way.name === 'its writer suspended') db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(writer.pk);
        if (way.name === "its writer's account paused by an admin") {
            adminSetUserStatus(writer.pk, 'active');
            const back = cardOn(await feed(rhea), dayOf);
            assert(back?.knowledge?.posts?.[0]?.id === page && back.publishedAt === cardBefore.publishedAt, `6. resumed: the card is back, as it was (${show(back)})`);
        }
    }
    ageAllOut();

    // ── 7. A standby answers the same ────────────────────────────────────────────────────────────
    console.log('── 7. a standby ──');
    const s1 = await publish(owen, 'Standby one');
    const s2 = await publish(ada, 'Standby two');
    setShown(s2, noonDaysAgo(3));
    const onMain = await feed(mel);
    require_(cardsOf(onMain).length === 2, `two cards on the main server (${show(cardsOf(onMain))})`);
    setNodeRole('backup');
    const onStandby = await feed(mel);
    const onStandbyPaged = await feed(mel, 'with=knowledge&limit=2');
    setNodeRole('primary');
    assert(onStandby.status === 200 && JSON.stringify(onStandby.body) === JSON.stringify(onMain.body), `7. a standby answers the same, from the posts it holds (${show(cardsOf(onStandby))})`);
    assert(JSON.stringify(itemsOf(onStandbyPaged).map((i) => i.id)) === JSON.stringify(itemsOf(onMain).slice(0, 2).map((i) => i.id)), '7. a page of it too');
    void s1;

    // ── 8. Mute and report ───────────────────────────────────────────────────────────────────────
    console.log('── 8. mute and report ──');
    const knowId = `know_${today}`;
    const mute = await call(mel, 'POST', `/api/member/pulse/items/${encodeURIComponent(knowId)}/mute`, { muted: true });
    assert(mute.status === 404, `8. mute of a know_ id: not found (${mute.status} ${mute.text.slice(0, 120)})`);
    const ownerMute = await call(owen, 'POST', `/api/member/pulse/items/${encodeURIComponent(knowId)}/mute`, { muted: true });
    assert(ownerMute.status === 404, `8. its page's writer neither (${ownerMute.status})`);
    const reported = await call(mel, 'POST', '/api/reports', { reporterPubkey: mel.pk, reason: 'spam', targetPulseItemId: knowId });
    assert(reported.status === 404 && reported.body?.error === 'not_found', `8. a report of a know_ id: not found (${reported.status} ${reported.text.slice(0, 120)})`);
    assert(!(db.prepare('SELECT 1 FROM abuse_reports WHERE target_pulse_item_id = ?').get(knowId)), '8. no report written');
    assert(!!cardOn(await feed(mel), today), '8. and the card is there as before');

    // ── 9. Home's Pulse card ─────────────────────────────────────────────────────────────────────
    console.log("── 9. Home's Pulse card ──");
    const home = await call(mel, 'GET', '/api/home?cards=needs,pulse,community');
    const homeItems = home.body?.cards?.pulse?.items ?? [];
    assert(home.status === 200 && homeItems.some((i: any) => i.id === 'item_pat_recent'), `9. Home's Pulse card holds the creators' items (${show(homeItems.map((i: any) => i.id))})`);
    assert(!home.text.includes('know_') && !homeItems.some((i: any) => i.source === 'knowledge' || i.category === 'knowledge'), '9. and no knowledge card');

    // ── 10. Nothing stored ───────────────────────────────────────────────────────────────────────
    console.log('── 10. nothing stored ──');
    assert(tables() === tablesBefore, '10. no table or trigger added by anything here');
    assert(!(db.prepare("SELECT 1 FROM pulse_items WHERE id LIKE 'know%' OR source = 'knowledge'").get()), '10. no Pulse row is a knowledge card');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
