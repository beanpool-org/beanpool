/**
 * Local knowledge on Home, slice K7 (scratch/fable-design/DESIGN-local-knowledge-amend-fable.md §3.6, §A4 "Home"): the node's
 * half of "Learn something local" and the "Your community" card's figure, through the real HTTPS stack and its signature
 * middleware, and buildHome for the clock.
 *
 *  1. Nothing showing: a member gets no card and no figure; an owner gets the card with `first` alone (their row "Add the
 *     first thing worth knowing about {community}"), whether or not their app opens To check.
 *  2. Pages showing: up to three rows, the newest page first and marked new while it first showed in the last 14 days, then
 *     the day's pick; the same rows for every member and the owner; a row never carries the body, its line is cut; the
 *     community card counts the pages ("{n} things worth knowing"), and is the same with or without the Learn card asked.
 *  3. The day's pick: the same all day (at every hour of one local day, and for every member), another order on other days;
 *     the newest page stops being new after 14 days; a page hidden by reports is neither counted nor drawn.
 *  4. Members only: unsigned 401, a stranger 403, a suspended member no card and no figure; the card is built only when
 *     asked (or held in a version-2 layout).
 *  5. To check: an owner's or admin's count of members' suggestions, only for an app that opens To check (lands=learn);
 *     never a member's.
 *  6. Off: no card and no figure, an owner's `first` included.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knowledge-home" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';
import { registerMemberInternal } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { buildHome, homeCardBuilds } from './routes/home-answer.js';
import { nodeLocalDay } from './engine/knowledge.js';
import { LEARN_HOME_NEW_DAYS, LEARN_HOME_ROWS } from '@beanpool/core';
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
const show = (v: unknown) => JSON.stringify(v ?? null).slice(0, 260);
const home = (id: Id | null, query = 'cards=needs,learn,community&lands=learn') => call(id, 'GET', `/api/home?${query}`);
const rowIds = (card: any): string[] => (Array.isArray(card?.rows) ? card.rows.map((r: any) => r.id) : []);
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The card as buildHome answers this reader at this moment, asked as an app asks it. */
const learnAt = (who: Id, now: number, lands: string[] = ['learn']) =>
    buildHome({ actor: who.pk, point: null, asked: ['needs', 'learn', 'community'], lands: new Set(lands as any), now }).body.cards as any;
/** Midnight at the start of the node's local day holding `ms`. */
function localMidnight(ms: number): number {
    const day = nodeLocalDay(ms);
    let t = ms - (ms % HOUR_MS);
    while (nodeLocalDay(t - HOUR_MS) === day) t -= HOUR_MS;
    return t;
}

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
    const [mel, pat, sam, ada] = ['Mel', 'Pat', 'Sam', 'Ada'].map(newId);
    for (const who of [mel, pat, sam, ada]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    grantNodeRole(ada.pk, 'admin', owen.pk);
    for (const who of [owen, mel, pat, sam, ada]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);
    const stranger = newId('Stranger');

    // ── 1. Nothing showing ───────────────────────────────────────────────────────────────────────
    console.log('── 1. nothing showing ──');
    const melEmpty = await home(mel);
    require_(melEmpty.status === 200, `Mel reads Home (${melEmpty.status} ${melEmpty.text.slice(0, 120)})`);
    assert(melEmpty.body.features?.knowledge === true, '1. Learn is on here (a local community)');
    assert(melEmpty.body.cards.learn === undefined, `1. a member with nothing to show gets no card (${show(melEmpty.body.cards.learn)})`);
    assert(melEmpty.body.cards.community && !('knowledge' in melEmpty.body.cards.community), `1. no figure at 0 (${show(melEmpty.body.cards.community)})`);
    const owenEmpty = await home(owen);
    assert(JSON.stringify(owenEmpty.body.cards.learn) === JSON.stringify({ rows: [], first: true }), `1. an owner gets the card with "first" alone (${show(owenEmpty.body.cards.learn)})`);
    const owenNoLands = await home(owen, 'cards=needs,learn,community');
    assert(owenNoLands.body.cards.learn?.first === true && owenNoLands.body.cards.learn?.toCheck === undefined, `1. "first" whatever the app opens (${show(owenNoLands.body.cards.learn)})`);
    const adaEmpty = await home(ada);
    assert(adaEmpty.body.cards.learn?.first === true, `1. so does an admin (${show(adaEmpty.body.cards.learn)})`);

    // ── 2. Pages showing ─────────────────────────────────────────────────────────────────────────
    console.log('── 2. pages showing ──');
    const longLine = 'Bins go out on Tuesday night, ' + 'and the truck comes early, '.repeat(20);
    const pages = [
        { title: 'Bins day', body: `${longLine}\nRecycling every other week.`, topic: 'local-services' },
        { title: 'At the tip', body: 'Bring glass sorted.', topic: 'local-services' },
        { title: 'Who to call in a flood', body: 'Call the roads line first.', topic: 'emergencies' },
        { title: 'Valley bus times', body: 'Leaves the shop at 8.', topic: 'getting-around' },
        { title: 'Wifi at the hall', body: 'Ask the caretaker for the code.', topic: 'good-to-know' },
        { title: 'Seed swap shelf', body: 'At the library, by the door.', topic: 'growing-animals' },
    ];
    const ids: string[] = [];
    for (const p of pages) {
        const r = await call(owen, 'POST', '/api/knowledge/posts', p);
        require_(r.status === 201, `Owen publishes "${p.title}" (${r.status} ${r.text.slice(0, 120)})`);
        ids.push(r.body.post.id);
    }
    // Five of them first showed a month ago; the last one today.
    const monthAgo = new Date(Date.now() - 30 * DAY_MS).toISOString();
    for (const id of ids.slice(0, 5)) db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(monthAgo, id);
    const fresh = ids[5];
    const melFull = await home(mel);
    const card = melFull.body.cards.learn;
    assert(Array.isArray(card?.rows) && card.rows.length === LEARN_HOME_ROWS, `2. three rows (${show(card)})`);
    assert(card?.rows?.[0]?.id === fresh && card.rows[0].isNew === true, `2. the newest page first, marked new (${show(card?.rows?.[0])})`);
    assert(card?.rows?.slice(1).every((r: any) => r.isNew === undefined && ids.slice(0, 5).includes(r.id)), '2. then two of the others, not marked');
    assert(new Set(rowIds(card)).size === rowIds(card).length, '2. no page twice');
    assert(card?.toCheck === undefined && card?.first === undefined, `2. a member gets rows only (${show(card)})`);
    assert(card?.rows?.every((r: any) => !('description' in r) && !('body' in r) && typeof r.line === 'string' && typeof r.title === 'string' && typeof r.topic === 'string'),
        '2. a row is the row card: title, line, topic, never the body');
    const bins = (await call(mel, 'GET', `/api/knowledge/front?q=${encodeURIComponent('Bins day')}`)).body?.rows?.find((r: any) => r.id === ids[0]);
    assert(!!bins && bins.line.length > 140, `2. (Learn's own row of "Bins day" holds its whole first line: ${bins?.line?.length})`);
    // Every page is drawn on some day: from 20 days on (nothing new), a month of picks of three from six.
    const allRows = Array.from({ length: 30 }, (_, d) => learnAt(mel, Date.now() + (20 + d) * DAY_MS).learn?.rows ?? []).flat();
    const binsRow = allRows.find((r: any) => r.id === ids[0]);
    assert(!!binsRow && binsRow.line.length <= 140, `2. the card's line is cut to a line (${binsRow?.line?.length})`);
    assert(melFull.body.cards.community?.knowledge === 6, `2. the community card counts the pages: 6 (${show(melFull.body.cards.community)})`);
    const patFull = await home(pat);
    assert(JSON.stringify(patFull.body.cards.learn) === JSON.stringify(card), '2. the same rows for another member');
    const owenFull = await home(owen);
    assert(JSON.stringify(rowIds(owenFull.body.cards.learn)) === JSON.stringify(rowIds(card)) && owenFull.body.cards.learn.first === undefined,
        `2. and for the owner, with no "first" now (${show(owenFull.body.cards.learn)})`);
    const communityOnly = await home(mel, 'cards=needs,community');
    assert(communityOnly.body.cards.learn === undefined && communityOnly.body.cards.community?.knowledge === 6, '2. the figure is there without the Learn card asked');

    // ── 3. The day's pick ────────────────────────────────────────────────────────────────────────
    console.log("── 3. the day's pick ──");
    // From 20 days on, the newest is no longer new, so every row is the day's pick.
    const base = localMidnight(Date.now() + 20 * DAY_MS);
    const pickOf = (who: Id, at: number) => rowIds(learnAt(who, at).learn).join(',');
    const morning = pickOf(mel, base + 30 * 60_000);
    const sameDay = [1, 6, 12, 18, 23].map((h) => pickOf(mel, base + h * HOUR_MS));
    assert(morning.split(',').length === LEARN_HOME_ROWS && sameDay.every((p) => p === morning), `3. the same rows at every hour of one local day (${morning} | ${sameDay.join(' | ')})`);
    assert(pickOf(pat, base + 9 * HOUR_MS) === morning && pickOf(owen, base + 15 * HOUR_MS) === morning, '3. and for every member that day');
    assert(learnAt(mel, base + 3 * HOUR_MS).learn.rows.every((r: any) => r.isNew === undefined), `3. after ${LEARN_HOME_NEW_DAYS} days the newest is no longer new`);
    const days = new Set<string>();
    for (let d = 0; d < 14; d++) days.add(pickOf(mel, base + d * DAY_MS + 12 * HOUR_MS));
    assert(days.size > 1, `3. other days pick otherwise (${days.size} different picks in 14 days)`);
    // Within the 14 days the newest page stays first.
    assert(rowIds(learnAt(mel, Date.parse(monthAgo) + 30 * DAY_MS + (LEARN_HOME_NEW_DAYS - 1) * DAY_MS).learn)[0] === fresh, '3. on day 13 the newest page is still first');
    // A page hidden by reports leaves Learn, the figure and the card at the next read, with no other write.
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), fresh);
    const hidden = await home(mel);
    assert(hidden.body.cards.community?.knowledge === 5 && !rowIds(hidden.body.cards.learn).includes(fresh), `3. a page hidden by reports is neither counted nor drawn (${show(hidden.body.cards.community)})`);
    db.prepare('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?').run(fresh);

    // ── 4. Members only ──────────────────────────────────────────────────────────────────────────
    console.log('── 4. members only ──');
    const unsigned = await home(null);
    assert(unsigned.status === 401 && !unsigned.text.includes(ids[0]), `4. unsigned: 401 (${unsigned.status})`);
    const strangerHome = await home(stranger);
    assert(strangerHome.status === 403 && !strangerHome.text.includes(ids[0]), `4. a stranger: 403 (${strangerHome.status})`);
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(sam.pk);
    const suspended = await home(sam);
    assert(suspended.status === 200 && suspended.body.cards.learn === undefined && suspended.body.cards.community && !('knowledge' in suspended.body.cards.community),
        `4. a suspended member: no card, no figure (${suspended.status} ${show(suspended.body?.cards?.community)})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(sam.pk);
    const builtBefore = homeCardBuilds.learn ?? 0;
    await home(mel, 'cards=needs,community');
    assert((homeCardBuilds.learn ?? 0) === builtBefore, '4. not asked: not built');
    await home(mel, 'cards=needs,learn,community');
    assert((homeCardBuilds.learn ?? 0) === builtBefore + 1, '4. asked: built once');

    // ── 5. To check ──────────────────────────────────────────────────────────────────────────────
    console.log('── 5. to check ──');
    const suggested = await call(mel, 'POST', '/api/knowledge/drafts', { title: 'Where to swim', body: 'The weir pool in summer.', topic: 'places-history' });
    require_(suggested.status === 201, `Mel suggests a page (${suggested.status} ${suggested.text.slice(0, 120)})`);
    const owenCheck = await home(owen);
    assert(owenCheck.body.cards.learn?.toCheck === 1, `5. the owner's card counts it, for an app that opens To check (${show(owenCheck.body.cards.learn)})`);
    assert((await home(ada)).body.cards.learn?.toCheck === 1, '5. so does the admin\'s');
    assert((await home(owen, 'cards=needs,learn,community')).body.cards.learn?.toCheck === undefined, '5. an app that does not open To check is not told');
    assert((await home(mel)).body.cards.learn?.toCheck === undefined, '5. never a member\'s, the sender\'s included');
    assert((await home(owen)).body.cards.community?.knowledge === 6, '5. a suggestion waiting is not a page: still 6');

    // ── 6. Off ───────────────────────────────────────────────────────────────────────────────────
    console.log('── 6. off ──');
    setOverride('knowledge', 'false');
    const offMel = await home(mel);
    const offOwen = await home(owen);
    assert(offMel.body.features?.knowledge === undefined, '6. Learn is off');
    assert(offMel.body.cards.learn === undefined && !('knowledge' in (offMel.body.cards.community ?? {})), `6. a member: no card, no figure (${show(offMel.body.cards.community)})`);
    assert(offOwen.body.cards.learn === undefined && !('knowledge' in (offOwen.body.cards.community ?? {})), `6. an owner neither, "first" and To check included (${show(offOwen.body.cards.learn)})`);
    dropOverride('knowledge');
    assert((await home(mel)).body.cards.learn?.rows?.length === LEARN_HOME_ROWS, '6. on again: the card is back');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
