/**
 * Per-item prices on the server, slice P0 (scratch/fable-design/DESIGN-per-item-price-fable.md §3, §4.6, §9). Every request is
 * signed and goes through the real HTTPS server and its signature middleware. Rob's panels: 300 Beans each, 20 of them, or all
 * 20 for 5,500. Each check names the change that turns it red.
 *
 *   1. Create: an Offer priced `each` stores its count and its price for all, bound to that count, never Repeatable; the post
 *      says `unitsLeft` and `lot`. Every refusal of §2.4 with its code, and the bad numbers refused, never rounded: nothing
 *      is stored.
 *   2. The paths that don't change: a Total, an hourly, a Repeatable, a loan and a weekly listing read and store exactly as
 *      before, a count sent with them stored nowhere.
 *   3. Edit: into Each, a count changed with the count the seller saw, a stale or missing one refused 409 `units_changed` with
 *      the count now; an edit that leaves the count alone writes none (a take-up made while the screen was open survives);
 *      the count's own write refuses a row that moved; 0 refused; the price for all bound to the count saved with it, kept
 *      when sent back as it is for the number left or not sent, bound to the count left when sent at its figure for another
 *      number, cleared by null, refused when the price for one drops under it, and a new one refused 409 `units_changed`
 *      when the count moved under the screen; out of Each clears all three. The count is never frozen by an
 *      open deal; the unit is, and a weekly listing with a live standing deal can't be edited into Each.
 *   4. The deal doors as an older app knocks (slice P1 opened them; test-per-item-deals.ts walks them): a one-step accept in
 *      an app's old shape (a number of hours, no way, no total) is refused 409 `price_changed`, and a request 409
 *      `each_accept_only`; nothing is held, the count stays; a Total Offer is still taken up as before.
 *   5. The features answer offers no Each yet (no `perItem`).
 *   6. A standby copy carries the three columns and the deal's item_option, by plain assignment.
 *   7. The CHECKs hold on this fresh file (test-schema-upgrade-fresh-shape.ts holds them on an upgraded one).
 *   8. The Home card (slice P2): the market row of a listing priced each carries the unit, the count and the price for all; any
 *      other listing's row is exactly as before.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-per-item-listings)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { db } from './db/db.js';
import { wrapCreatePost, TEST_PHOTOS } from './post-test-helper.js';
import {
    initStateEngine, transfer, createPost as rawCreatePost, runLedgerAudit, exportSyncState, importRemoteState, setNodeRole, signSyncPayload,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { LEND_PRICE_TYPE_REFUSED, PRICE_FROZEN_ERROR } from './engine/posts.js';
import { writeItemCount } from './engine/per-item.js';
import { setMemberPhoto } from '@beanpool/engine';
import { itemTakeUpRefusalText, lotOffered, perItemEditFields, perItemEditStart, perItemRefusalText, wordsFor } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (!url.startsWith('https://localhost')) throw new Error(`test-per-item-listings: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const EN = wordsFor('en');
const said = (code: Parameters<typeof perItemRefusalText>[0]['code'], extra: { count?: number; total_c?: number } = {}) => perItemRefusalText({ code, ...extra }, EN);
const hc = (beans: number) => Math.round(beans * 100);
const EPOCH_NOW = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
let BASE = '';
type Id = { pk: string; privateKey: crypto.KeyObject };

function makeMember(callsign: string, beans: number): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const id = { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, callsign);
    setMemberPhoto(db, id.pk, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, EPOCH_NOW);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${callsign}`, 'direct', true);
    createPost('offer', 'general', `${callsign} odd jobs`, 'Help around the place', hc(5), 'fixed', id.pk, undefined, undefined, undefined, true);
    return id;
}

async function call(method: 'GET' | 'POST', urlPath: string, id: Id, body?: unknown) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${urlPath}`, {
        method,
        headers: {
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            'X-Public-Key': id.pk,
            'X-Signature': signRequest(id.privateKey, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, ...(method === 'POST' ? { body: raw } : {}) }),
            [SIGNED_FOR_HEADER]: signedForHost(),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        ...(method === 'POST' ? { body: raw } : {}),
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`;
type Row = { price_type: string; price_c: number; repeatable: number; status: string; active: number; units_left: number | null; lot_price_c: number | null; lot_units: number | null; title: string };
const row = (id: string) => db.prepare('SELECT price_type, price_c, repeatable, status, active, units_left, lot_price_c, lot_units, title FROM posts WHERE id = ?').get(id) as Row;
const titled = (title: string) => (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE title = ?').get(title) as { n: number }).n;
const dealsOn = (postId: string) => (db.prepare('SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ?').get(postId) as { n: number }).n;
const bal = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number }).balance_c;

async function main(): Promise<void> {
    console.log('Per-item prices, P0\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const rob = makeMember('Rob', 100);
    const dana = makeMember('Dana', 10_000);

    const offer = (who: Id, body: Record<string, unknown>) => call('POST', '/api/marketplace/posts', who, {
        type: 'offer', category: 'tools', description: 'Second-hand, working', authorPublicKey: who.pk, photos: TEST_PHOTOS, ...body,
    });
    const edit = (who: Id, id: string, body: Record<string, unknown>) => call('POST', '/api/marketplace/posts/update', who, { id, authorPublicKey: who.pk, ...body });
    const byId = async (who: Id, id: string) => ((await call('GET', `/api/marketplace/posts?id=${id}`, who)).body ?? [])[0];
    const PANELS = { priceType: 'each', price_c: hc(300), unitsLeft: 20, lot: { price_c: hc(5500) } };

    // ── 1. Create ────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('— 1. Create');
    const made = await offer(rob, { title: 'Solar panels', ...PANELS, repeatable: true });
    const panels = made.body?.post?.id as string;
    const p0 = row(panels);
    // Red if posts.ts stops writing items.*, or the mapper (engine posts.ts itemFieldsOf) stops reading them.
    assert(made.status === 200 && p0.price_type === 'each' && p0.price_c === hc(300) && p0.units_left === 20 && p0.lot_price_c === hc(5500) && p0.lot_units === 20,
        `an Offer priced for each one keeps 300 each, 20 left, and all 20 for 5,500 (${brief(made)})`);
    assert(p0.repeatable === 0 && made.body.post.repeatable === false, 'and is never Repeatable, even when the tick was sent (the count takes its place, D4)');
    assert(made.body.post.unitsLeft === 20 && made.body.post.lot?.units === 20 && made.body.post.lot?.price_c === hc(5500),
        `the post says unitsLeft and lot (${JSON.stringify({ unitsLeft: made.body.post.unitsLeft, lot: made.body.post.lot })})`);
    const read = await byId(dana, panels);
    assert(read?.unitsLeft === 20 && read?.lot?.price_c === hc(5500) && read?.priceType === 'each', 'and so does a buyer\'s read of it');

    const plainEach = await offer(rob, { title: 'Seedlings', priceType: 'each', price_c: hc(2), unitsLeft: 40 });
    assert(plainEach.status === 200 && row(plainEach.body.post.id).lot_price_c === null && row(plainEach.body.post.id).lot_units === null && !('lot' in plainEach.body.post),
        'a count with no price for all keeps none, and says none');
    const freeEach = await offer(rob, { title: 'Free jars', priceType: 'each', price_c: 0, unitsLeft: 12 });
    assert(freeEach.status === 200 && row(freeEach.body.post.id).units_left === 12, 'a free one with a count is made (Free · 12 left)');

    const refused = async (title: string, body: Record<string, unknown>, code: string, error: string, who: Id = rob) => {
        const r = await offer(who, { title, ...body });
        assert(r.status === 400 && r.body?.code === code && r.body?.error === error && titled(title) === 0, `${title}: refused ${code}, nothing stored (${brief(r)})`);
    };
    await refused('A Need for each', { type: 'need', priceType: 'each', price_c: hc(2), unitsLeft: 10 }, 'each_offer_only', said('each_offer_only'));
    await refused('No count', { priceType: 'each', price_c: hc(300) }, 'units_refused', said('units_refused'));
    // Whole numbers only at the door: 0, −1, 2.5, "3", Infinity (null in JSON), 10,000; never rounded (red if isItemCount rounds).
    for (const bad of [0, -1, 2.5, '3', Infinity, 10_000, [3], { n: 3 }]) {
        await refused(`Count ${JSON.stringify(bad)}`, { priceType: 'each', price_c: hc(300), unitsLeft: bad }, 'units_refused', said('units_refused'));
    }
    await refused('Lot for one', { priceType: 'each', price_c: hc(300), unitsLeft: 1, lot: { price_c: hc(200) } }, 'lot_needs_two', said('lot_needs_two'));
    // Red if the rule becomes <= (a price for all equal to one by one would be shown as a deal that saves nothing).
    await refused('Lot not less', { ...PANELS, lot: { price_c: hc(6000) } }, 'lot_not_less', said('lot_not_less', { count: 20, total_c: hc(6000) }));
    await refused('Free lot', { priceType: 'each', price_c: 0, unitsLeft: 20, lot: { price_c: hc(1) } }, 'lot_not_less', said('lot_not_less', { count: 20, total_c: 0 }));
    for (const bad of [{ price_c: 0 }, { price_c: 5.5 }, { price_c: '5500' }, 5500]) {
        await refused(`Lot ${JSON.stringify(bad)}`, { ...PANELS, lot: bad }, 'lot_price_refused', said('lot_price_refused'));
    }
    const lent = await offer(rob, { title: 'Lent each', priceType: 'each', price_c: hc(3), unitsLeft: 5, lendable: true });
    assert(lent.status === 400 && lent.body?.error === LEND_PRICE_TYPE_REFUSED && titled('Lent each') === 0, `a loan can't be priced for each one (${brief(lent)})`);
    const poll = await call('POST', '/api/marketplace/posts', rob, { type: 'poll', title: 'Each poll', category: 'community', description: '', authorPublicKey: rob.pk, priceType: 'each', unitsLeft: 3, pollOptions: ['A', 'B'] });
    assert(poll.status === 400 && poll.body?.code === 'each_offer_only' && titled('Each poll') === 0, `a poll asked to be priced for each one is refused, not made one (${brief(poll)})`);

    // ── 2. The paths that don't change ──────────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. The paths that don\'t change');
    for (const [title, body] of [
        ['Firewood', { priceType: 'fixed', price_c: hc(30) }], ['Garden help', { priceType: 'hourly', price_c: hc(20) }],
        ['Eggs weekly', { priceType: 'fixed', price_c: hc(5), repeatable: true }], ['Trailer', { priceType: 'daily', price_c: hc(5), lendable: true, lendMaxDays: 3 }],
        ['Veg box', { priceType: 'weekly', price_c: hc(15) }],
    ] as const) {
        // A count and a price for all sent with another unit are stored nowhere (red if itemColumnsOnCreate stops returning none).
        const r = await offer(rob, { title, ...body, unitsLeft: 20, lot: { price_c: hc(1) } });
        const s = r.status === 200 ? row(r.body.post.id) : null;
        assert(!!s && s.price_type === body.priceType && s.units_left === null && s.lot_price_c === null && s.lot_units === null
            && !('unitsLeft' in r.body.post) && !('lot' in r.body.post) && s.repeatable === ('repeatable' in body || 'lendable' in body ? 1 : 0),
            `${title} (${body.priceType}) is made and read exactly as before: no count, no price for all (${brief(r)})`);
    }

    // ── 3. Edit ─────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. Edit');
    const total = await offer(rob, { title: 'Rob\'s panels', priceType: 'fixed', price_c: hc(5500), repeatable: true });
    const robs = total.body.post.id as string;
    const noCount = await edit(rob, robs, { priceType: 'each', price_c: hc(300) });
    assert(noCount.status === 400 && noCount.body?.code === 'units_refused' && row(robs).price_type === 'fixed', `into Each with no count: refused, nothing changed (${brief(noCount)})`);
    // Rob's own edit, the only way a listing becomes per-item (§6): his 5,500 Total becomes 300 each, 20, all for 5,500.
    const into = await edit(rob, robs, { priceType: 'each', price_c: hc(300), unitsLeft: 20, lot: { price_c: hc(5500) }, repeatable: true });
    const r1 = row(robs);
    assert(into.status === 200 && r1.price_type === 'each' && r1.units_left === 20 && r1.lot_price_c === hc(5500) && r1.lot_units === 20 && r1.repeatable === 0,
        `a Repeatable Total edited into Each: 20 left, all 20 for 5,500, no longer Repeatable (${brief(into)})`);
    const changed = await edit(rob, robs, { unitsLeft: 25, unitsLeftWas: 20 });
    assert(changed.status === 200 && row(robs).units_left === 25 && row(robs).lot_units === 20 && changed.body.post.unitsLeft === 25,
        'the count changed with the count the seller saw: written; the price for all keeps the 20 it was for (now not on offer)');
    const stale = await edit(rob, robs, { unitsLeft: 30, unitsLeftWas: 20, title: 'Stale edit' });
    assert(stale.status === 409 && stale.body?.code === 'units_changed' && stale.body?.unitsLeft === 25 && stale.body?.error === said('units_changed', { count: 25 })
        && row(robs).units_left === 25 && row(robs).title === 'Rob\'s panels', `a stale count is refused 409 with the count now, and nothing of the edit lands (${brief(stale)})`);
    const missing = await edit(rob, robs, { unitsLeft: 30 });
    assert(missing.status === 409 && missing.body?.code === 'units_changed' && row(robs).units_left === 25, `a count with no count seen is refused the same (${brief(missing)})`);
    // A take-up while the edit screen was open (P1's write, made here by hand): 25 → 22. The screen sends back 25 as it read it.
    db.prepare('UPDATE posts SET units_left = 22 WHERE id = ?').run(robs);
    const blind = await edit(rob, robs, { title: 'Solar panels, 300 W', unitsLeft: 25, unitsLeftWas: 25 });
    assert(blind.status === 200 && row(robs).units_left === 22 && row(robs).title === 'Solar panels, 300 W',
        `an edit that didn't touch the count writes none: the take-up made meanwhile stands (red if the edit writes units_left blind) (${brief(blind)})`);
    // The count's own write is the authority (red if writeItemCount's WHERE loses `units_left IS ?`).
    let authority = '';
    try { writeItemCount(robs, { from: 25, to: 30 }); } catch (e: any) { authority = `${e?.code}:${e?.unitsLeft}`; }
    assert(authority === 'units_changed:22' && row(robs).units_left === 22, `the guarded write changes no row that moved, and says the count now (${authority})`);
    const zero = await edit(rob, robs, { unitsLeft: 0, unitsLeftWas: 22 });
    assert(zero.status === 400 && zero.body?.code === 'units_zero' && zero.body?.error === said('units_zero') && row(robs).units_left === 22, `0 is refused: pause or remove instead (${brief(zero)})`);
    // The price for all: bound to the count saved with it. Sent at the figure it already had, but stored for another number
    // (the 20 it was set for, 22 left now), it is for the 22 the seller saved it with. Changed on purpose (review of #3089 on
    // per-item-form.ts:265): this check said "keeps the 20 it was for", so the form's "All 22 for 5,500" was not on offer.
    // Red if itemColumnsOnEdit keeps a price sent at its stored figure bound to the old number.
    const sentBack = await edit(rob, robs, { lot: { price_c: hc(5500) }, unitsLeft: 22, unitsLeftWas: 22 });
    assert(sentBack.status === 200 && row(robs).lot_units === 22 && row(robs).lot_price_c === hc(5500) && sentBack.body.post.lot?.units === 22,
        `sent at the figure it had, but set for another number (20, with 22 left): the price for all is for the 22 left (${brief(sentBack)})`);
    const rebound = await edit(rob, robs, { lot: { price_c: hc(6000) }, unitsLeft: 22, unitsLeftWas: 22 });
    assert(rebound.status === 200 && row(robs).lot_units === 22 && row(robs).lot_price_c === hc(6000) && rebound.body.post.lot?.units === 22,
        `a new price for all is for the 22 left (6,000 < 6,600) (${brief(rebound)})`);
    // Sent back as it is, for the number it is for: kept, with or without the count seen (it is not new, so nothing to guard).
    const keptAsIs = await edit(rob, robs, { lot: { price_c: hc(6000) } });
    assert(keptAsIs.status === 200 && row(robs).lot_units === 22 && row(robs).lot_price_c === hc(6000),
        `sent back as it is and still for the 22 left: kept, no count seen needed (${brief(keptAsIs)})`);
    const lower = await edit(rob, robs, { price_c: hc(250) });
    assert(lower.status === 400 && lower.body?.code === 'lot_not_less' && row(robs).price_c === hc(300),
        `the price for one lowered under the price for all (22 × 250 = 5,500 ≤ 6,000) is refused (${brief(lower)})`);
    const withCount = await edit(rob, robs, { unitsLeft: 18, unitsLeftWas: 22, lot: { price_c: hc(5000) } });
    assert(withCount.status === 200 && row(robs).units_left === 18 && row(robs).lot_units === 18 && row(robs).lot_price_c === hc(5000),
        'a new count and a price for all in one edit: the price is for the new count');
    // A cancel while the edit screen was open (P1's settleItemDeal puts 2 back; made here by hand): 18 → 20. Rob's screen
    // still reads 18 and he names all 18 for 4,500. Red if itemColumnsOnEdit binds a new price for all to the stored count
    // without the count seen: 200, and "All 20 for 4,500" on offer, 2 more panels than he priced.
    db.prepare('UPDATE posts SET units_left = 20 WHERE id = ?').run(robs);
    const staleLot = await edit(rob, robs, { lot: { price_c: hc(4500) }, unitsLeft: 18, unitsLeftWas: 18, title: 'Stale price for all' });
    const r8 = row(robs);
    assert(staleLot.status === 409 && staleLot.body?.code === 'units_changed' && staleLot.body?.unitsLeft === 20 && staleLot.body?.error === said('units_changed', { count: 20 })
        && r8.units_left === 20 && r8.lot_price_c === hc(5000) && r8.lot_units === 18 && r8.title === 'Solar panels, 300 W',
        `a new price for all with the count moved under the screen: refused 409 with the count now, nothing of the edit lands (${brief(staleLot)})`);
    const noSeen = await edit(rob, robs, { lot: { price_c: hc(4500) } });
    assert(noSeen.status === 409 && noSeen.body?.code === 'units_changed' && row(robs).lot_price_c === hc(5000), `a new price for all with no count seen is refused the same (${brief(noSeen)})`);
    const reasked = await edit(rob, robs, { lot: { price_c: hc(4500) }, unitsLeft: 20, unitsLeftWas: 20 });
    assert(reasked.status === 200 && row(robs).lot_units === 20 && row(robs).lot_price_c === hc(4500), 'saved again with the count now: the price for all is for the 20 he saw');
    const cleared = await edit(rob, robs, { lot: null });
    assert(cleared.status === 200 && row(robs).lot_price_c === null && row(robs).lot_units === null && !('lot' in cleared.body.post), 'null takes the price for all off');
    // The review of #3089 (per-item-form.ts:265), with the forms' own bodies (core perItemEditStart / perItemEditFields):
    // 20 chairs at 300 each, all 20 for 5,000; 3 taken (P1's write, made here by hand), 17 left. The edit opens with the
    // price-for-all box empty and "was for 20".
    const chairsMade = await offer(rob, { title: 'Chairs', priceType: 'each', price_c: hc(300), unitsLeft: 20, lot: { price_c: hc(5000) } });
    const chairs = chairsMade.body.post.id as string;
    db.prepare('UPDATE posts SET units_left = 17 WHERE id = ?').run(chairs);
    const chairsStored = { wasEach: true, unitsLeft: 17, lot: { units: 20, price_c: hc(5000) } };
    const opened = perItemEditStart(chairsStored);
    // The box left alone: no lot sent, and the price for all keeps the 20 it was for (back if that deal is cancelled).
    const leftAlone = perItemEditFields({ price: '300', count: opened.count, lot: opened.lot }, chairsStored, false);
    const titleOnly = await edit(rob, chairs, { ...(leftAlone.ok ? leftAlone.fields : {}), title: 'Chairs, oak' });
    const c1 = row(chairs);
    assert(opened.lot === '' && leftAlone.ok && !('lot' in leftAlone.fields) && titleOnly.status === 200 && c1.title === 'Chairs, oak'
        && c1.units_left === 17 && c1.lot_units === 20 && c1.lot_price_c === hc(5000) && !lotOffered(await byId(rob, chairs)),
        `an untouched price-for-all box sends no lot: the price for all keeps the 20 it was for, not on offer with 17 left (${brief(titleOnly)})`);
    // A screen opened before the take-up still shows all 20 for 5,000 and sends it back with the 20 it read: refused 409 with
    // the count now, nothing lands. Red if the rebind skips the unitsLeftWas guard (all 17 for 5,000, made from a screen of 20).
    const staleScreen = await edit(rob, chairs, { priceType: 'each', unitsLeft: 20, unitsLeftWas: 20, lot: { price_c: hc(5000) }, title: 'Chairs, stale' });
    const c2 = row(chairs);
    assert(staleScreen.status === 409 && staleScreen.body?.code === 'units_changed' && staleScreen.body?.unitsLeft === 17 && staleScreen.body?.error === said('units_changed', { count: 17 })
        && c2.title === 'Chairs, oak' && c2.units_left === 17 && c2.lot_units === 20 && c2.lot_price_c === hc(5000),
        `the stored figure sent back from a screen that read 20: refused 409 with the 17 now, nothing of the edit lands (${brief(staleScreen)})`);
    // The seller types 5,000 again for the 17 left (the live line says "All 17 for 5,000 Beans"): the form's own body.
    const typed = perItemEditFields({ price: '300', count: opened.count, lot: '5000' }, chairsStored, true);
    const retyped = await edit(rob, chairs, { ...(typed.ok ? typed.fields : {}) });
    const c3 = row(chairs);
    assert(typed.ok && typed.fields.unitsLeftWas === 17 && typed.fields.lot?.price_c === hc(5000) && retyped.status === 200
        && c3.units_left === 17 && c3.lot_price_c === hc(5000) && c3.lot_units === 17 && retyped.body.post.lot?.units === 17 && lotOffered(await byId(rob, chairs)),
        `typed again at the figure it had, for the 17 left: all 17 for 5,000, on offer (red if itemColumnsOnEdit keeps it bound to 20) (${brief(retyped)})`);
    const needEach = await call('POST', '/api/marketplace/posts', rob, { type: 'need', title: 'Seedlings wanted', category: 'garden', description: '', authorPublicKey: rob.pk, photos: TEST_PHOTOS, price_c: hc(2) });
    const needEdit = await edit(rob, needEach.body.post.id, { priceType: 'each', unitsLeft: 10 });
    assert(needEdit.status === 400 && needEdit.body?.code === 'each_offer_only' && row(needEach.body.post.id).price_type === 'fixed', `a Need can't be edited into Each (${brief(needEdit)})`);
    // A deal open on it (P1 makes these; written here by hand): the unit is frozen, the count is not (the seller's stock).
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, hours, status, item_option)
                VALUES ('deal-open', ?, ?, ?, ?, 2, 'pending', 'each')`).run(robs, dana.pk, rob.pk, hc(600));
    const outFrozen = await edit(rob, robs, { priceType: 'fixed', price_c: hc(300) });
    assert(outFrozen.status === 400 && outFrozen.body?.error === PRICE_FROZEN_ERROR && row(robs).price_type === 'each', `out of Each under an open deal: refused, as any unit change is (${brief(outFrozen)})`);
    const stock = await edit(rob, robs, { unitsLeft: 16, unitsLeftWas: 20 });
    assert(stock.status === 200 && row(robs).units_left === 16, 'the count still changes under an open deal: it is the seller\'s stock, never frozen');
    db.prepare("UPDATE marketplace_transactions SET status = 'cancelled' WHERE id = 'deal-open'").run();
    const out = await edit(rob, robs, { priceType: 'fixed', price_c: hc(5000), unitsLeft: 16, unitsLeftWas: 16, lot: { price_c: hc(1) } });
    const r9 = row(robs);
    assert(out.status === 200 && r9.price_type === 'fixed' && r9.units_left === null && r9.lot_price_c === null && r9.lot_units === null && !('unitsLeft' in out.body.post),
        `out of Each: all three cleared, whatever the screen sent back (${brief(out)})`);
    // A weekly Offer with a live standing deal (made here by hand: the arrangement and its paid period in trust). Its periods
    // don't freeze the unit (assertPriceNotFrozen), so the edit into Each is the per-item rule's to refuse. Red if
    // itemColumnsOnEdit lets it in: Repeatable goes to 0, and the next period takes the listing off the board under that
    // standing deal and ends any other on it (design §1: Each is never weekly, no standing deal).
    const box = await offer(rob, { title: 'Weekly veg box', priceType: 'weekly', price_c: hc(15), repeatable: true });
    const veg = box.body.post.id as string;
    const nowIso = new Date().toISOString();
    db.prepare(`INSERT INTO standing_deals (id, post_id, payer_pubkey, payee_pubkey, beans_per_period_c, period_unit, starts_at, phase, periods_done,
                current_tx_id, next_due_at, auth_signer, auth_signature, auth_payload)
                VALUES ('sd-veg', ?, ?, ?, ?, 'week', ?, 'paid', 1, 'period-veg', ?, ?, 'sig', 'text')`)
        .run(veg, dana.pk, rob.pk, hc(15), nowIso, new Date(Date.now() + 7 * 86_400_000).toISOString(), dana.pk);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, hours, status, standing_id, period_no)
                VALUES ('period-veg', ?, ?, ?, ?, 1, 'pending', 'sd-veg', 1)`).run(veg, dana.pk, rob.pk, hc(15));
    const underStanding = await edit(rob, veg, { priceType: 'each', price_c: hc(15), unitsLeft: 5 });
    const v1 = row(veg);
    assert(underStanding.status === 400 && underStanding.body?.error === PRICE_FROZEN_ERROR && v1.price_type === 'weekly' && v1.repeatable === 1 && v1.units_left === null,
        `into Each under a live standing deal: refused, as a unit change under an open deal is; still weekly and Repeatable (${brief(underStanding)})`);
    db.prepare("UPDATE marketplace_transactions SET status = 'completed' WHERE id = 'period-veg'").run();
    db.prepare("UPDATE standing_deals SET phase = 'ended', ended_at = ?, ended_reason = 'stopped' WHERE id = 'sd-veg'").run(nowIso);
    const afterStanding = await edit(rob, veg, { priceType: 'each', price_c: hc(15), unitsLeft: 5 });
    assert(afterStanding.status === 200 && row(veg).price_type === 'each' && row(veg).units_left === 5 && row(veg).repeatable === 0,
        `once that standing deal has ended, the edit into Each is made (${brief(afterStanding)})`);

    // ── 4. The deal doors as an older app knocks ────────────────────────────────────────────────────────────────────
    console.log('\n— 4. The deal doors as an older app knocks');
    const before = bal(dana.pk);
    for (const [door, path, body, code] of [
        ['a one-step accept in the old shape (hours, no way, no total)', '/api/marketplace/posts/accept', { postId: panels, buyerPublicKey: dana.pk, hours: 3 }, 'price_changed'],
        ['an accept for all with no total', '/api/marketplace/posts/accept', { postId: panels, buyerPublicKey: dana.pk, hours: 20, itemOption: 'lot' }, 'price_changed'],
        ['a request', '/api/marketplace/posts/request', { postId: panels, buyerPublicKey: dana.pk, hours: 3 }, 'each_accept_only'],
    ] as const) {
        const r = await call('POST', path, dana, body);
        // Red if acceptPost takes an old-shape body down the hourly path (it would hold 900 and leave the count at 20), or
        // requestPost lets a request wait unfunded against the count.
        assert(r.status === 409 && r.body?.code === code && r.body?.error === itemTakeUpRefusalText({ code }, EN) && dealsOn(panels) === 0
            && bal(dana.pk) === before && row(panels).units_left === 20 && row(panels).status === 'active', `${door} on a per-item Offer: refused ${code}, nothing held (${brief(r)})`);
    }
    const firewood = (db.prepare("SELECT id FROM posts WHERE title = 'Firewood'").get() as { id: string }).id;
    const took = await call('POST', '/api/marketplace/posts/accept', dana, { postId: firewood, buyerPublicKey: dana.pk });
    const audit = runLedgerAudit();
    assert(took.status === 200 && bal(dana.pk) === before - hc(30) && audit.ok && audit.drift === 0, `a Total Offer is still taken up as before (${brief(took)})`);

    // ── 5. The features answer ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 5. The features answer');
    const info = await call('GET', '/api/community/info', dana);
    assert(info.status === 200 && typeof info.body?.features === 'object' && !('perItem' in info.body.features),
        'the forms are offered no Each until every slice is in (red if node-profile.ts PER_ITEM_BUILT is set)');

    // ── 6. A standby copy ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 6. A standby copy');
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, hours, status, item_option)
                VALUES ('deal-lot', ?, ?, ?, ?, 20, 'cancelled', 'lot')`).run(panels, dana.pk, rob.pk, hc(5500));
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4043/p2p/${nodeId}`);
    const payload = await exportSyncState(nodeId);
    const sent = (payload.posts ?? []).find((p: any) => p.id === panels) as any;
    const sentPlain = (payload.posts ?? []).find((p: any) => p.id === firewood) as any;
    const sentDeal = (payload.marketplaceTransactions ?? []).find((t: any) => t.id === 'deal-lot') as any;
    assert(sent?.unitsLeft === 20 && sent?.lot?.units === 20 && sent?.lot?.price_c === hc(5500) && !('unitsLeft' in (sentPlain ?? {})) && sentDeal?.itemOption === 'lot',
        'the copy carries the count, the price for all and the deal\'s way of taking it up, and nothing for another listing');
    db.prepare("UPDATE posts SET units_left = 3, lot_price_c = NULL, lot_units = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(panels);
    db.prepare("UPDATE marketplace_transactions SET item_option = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'deal-lot'").run();
    setNodeRole('backup');
    await importRemoteState(payload as any);
    const copied = row(panels);
    const copiedDeal = db.prepare("SELECT item_option FROM marketplace_transactions WHERE id = 'deal-lot'").get() as { item_option: string | null };
    // Red if sync.ts postItems or the deal upsert's item_option is dropped (a take-over would lose the count).
    assert(copied.units_left === 20 && copied.lot_price_c === hc(5500) && copied.lot_units === 20 && copiedDeal.item_option === 'lot',
        `the standby's rows come back as the main server holds them (${JSON.stringify(copied)} ${JSON.stringify(copiedDeal)})`);
    const { signature: _s, publicKey: _p, ...unsigned } = payload as any;
    const noLot = { ...sent, updatedAt: new Date(Date.now() + 1000).toISOString(), unitsLeft: 19 };
    delete noLot.lot;
    await importRemoteState(await signSyncPayload({ ...unsigned, posts: [noLot], marketplaceTransactions: [] } as any) as any);
    assert(row(panels).units_left === 19 && row(panels).lot_price_c === null && row(panels).lot_units === null,
        'a copy that no longer says a price for all clears it here too, and moves the count');
    setNodeRole('primary');

    // ── 7. The CHECKs on this file ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 7. The CHECKs');
    const refusedWrite = (sql: string, ...args: unknown[]) => { try { db.prepare(sql).run(...args); return false; } catch (e: any) { return /CHECK constraint failed/.test(e?.message ?? ''); } };
    assert(refusedWrite('UPDATE posts SET units_left = -1 WHERE id = ?', panels) && refusedWrite('UPDATE posts SET units_left = 10000 WHERE id = ?', panels)
        && refusedWrite('UPDATE posts SET lot_price_c = 0 WHERE id = ?', panels) && refusedWrite('UPDATE posts SET lot_units = 1 WHERE id = ?', panels)
        && refusedWrite("UPDATE marketplace_transactions SET item_option = 'x' WHERE id = 'deal-lot'"),
        'the table refuses a count below 0 or past 9,999, a price for all of 0, one for fewer than 2, and an unknown way of taking it up');

    // ── 8. The Home card (slice P2) ───────────────────────────────────────────────────────────────────────────────
    console.log('\n— 8. Home: the market card says a listing priced for each one');
    const homePanels = await offer(rob, { title: 'Home panels', ...PANELS });
    const homePlain = await offer(rob, { title: 'Home firewood', priceType: 'fixed', price_c: hc(40) });
    assert(homePanels.status === 200 && homePlain.status === 200, `two listings made for the Home card (${brief(homePanels)} ${brief(homePlain)})`);
    const homeId = (r: { body: any }) => r.body?.post?.id ?? r.body?.id;
    const homeAnswer = await call('GET', '/api/home?cards=market', dana);
    const homeItems: any[] = homeAnswer.body?.cards?.market?.items ?? [];
    const homeEach = homeItems.find((i) => i.id === homeId(homePanels));
    const homeFixed = homeItems.find((i) => i.id === homeId(homePlain));
    // Red if home-answer.ts eachFieldsOf is dropped: the card could not say "300 Beans each" or how many are left.
    assert(homeEach?.priceType === 'each' && homeEach?.unitsLeft === 20 && homeEach?.lot?.units === 20 && homeEach?.lot?.price_c === hc(5500) && homeEach?.price_c === hc(300),
        `the card's row carries the unit, the count and the price for all (${JSON.stringify(homeEach)})`);
    assert(!!homeFixed && !('priceType' in homeFixed) && !('unitsLeft' in homeFixed) && !('lot' in homeFixed),
        `any other listing's row is exactly as it was: no unit, no count (${JSON.stringify(homeFixed)})`);
    db.prepare('UPDATE posts SET units_left = 19, updated_at = ? WHERE id = ?').run(new Date().toISOString(), homeId(homePanels));
    const afterOne = ((await call('GET', '/api/home?cards=market', dana)).body?.cards?.market?.items ?? []).find((i: any) => i.id === homeId(homePanels));
    assert(afterOne?.unitsLeft === 19 && afterOne?.lot?.units === 20, 'one taken: the row says 19 left and keeps the price for all as stored (the card hides it, core lotOffered)');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && process.exitCode !== 1 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
