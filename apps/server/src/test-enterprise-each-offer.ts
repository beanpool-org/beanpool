/**
 * An enterprise prices its own Offer for each one, from its own form (scratch/fable-design/DESIGN-stall-consignment-fable.md
 * §6 slice 5, §7; Marty, 26 Nov 2026): a keeper posting as the enterprise sends how many it has, and a price for all of them,
 * exactly as a member does on their own Offer, and POST /api/treasury/:treasury/offer passes them through to the same engine
 * rules (engine/per-item.ts itemColumnsOnCreate). Every request is signed and goes through the real HTTPS server and its
 * signature middleware. Each check names the change that turns it red.
 *
 *   0. The switches, before any Bean moves: enterprises off, and Beans off, refuse an each-priced enterprise Offer before
 *      the handler (404 feature_off), nothing stored; the features answer offers Each (`perItem`) on a local community.
 *   1. A keeper: 6.50 each, 12 of them, all 12 for 70: stored as a member's would be, never Repeatable, the enterprise its
 *      author and the keeper who made it on the row; the answer says unitsLeft and lot; a count with no price for all.
 *   2. Not a keeper: a member who keeps nothing, and a keeper of another enterprise, are refused as for any enterprise
 *      Offer (403), nothing stored. A muted keeper, and a muted enterprise, are refused (403 moderation_muted).
 *   3. Bad counts, the table: every refusal the member's route makes of a count or a price for all, and of a Need priced
 *      each, the enterprise's routes make with the same status, code and words, and store nothing.
 *   4. The one-off price unchanged: a Total, an hourly, a Repeatable and a not-Repeatable Offer, and a Need, are made and
 *      read exactly as before, a count or a price for all sent with them stored nowhere.
 *   5. Buyers take it up as any each-priced Offer: 3 of 12, held, the count 9; released, the enterprise gets the price of 3
 *      less the one fee; the Beans add up after each step.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-enterprise-each-offer)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { db } from './db/db.js';
import { wrapCreatePost, TEST_PHOTOS } from './post-test-helper.js';
import {
    initStateEngine, transfer, createPost as rawCreatePost, runLedgerAudit, getCommonsBalanceExact, createTreasury, adminAssignTreasuryOperator,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { getNodeFeatures, setSwitchOverride } from './config/node-profile.js';
import { setMemberPhoto } from '@beanpool/engine';
import { feeOf, perItemRefusalText, wordsFor } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (!url.startsWith('https://localhost')) throw new Error(`test-enterprise-each-offer: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const EN = wordsFor('en');
const said = (code: Parameters<typeof perItemRefusalText>[0]['code'], extra: { count?: number; total_c?: number } = {}) => perItemRefusalText({ code, ...extra }, EN);
/** The story's figures are Beans; the node's are whole hundredths. */
const hc = (beans: number) => Math.round(beans * 100);
const DAY = 86_400_000;
const EPOCH_NOW = Math.floor(Date.now() / DAY);
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
let BASE = '';
type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

/** A member a month in, with a photo and an Offer of their own; `beans` from genesis. */
function makeMember(callsign: string, beans = 0): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const id = { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, status, updated_at)
                VALUES (?, ?, ?, 'genesis', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, callsign, new Date(Date.now() - 30 * DAY).toISOString());
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, EPOCH_NOW);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${callsign}`, 'direct', true);
    createPost('offer', 'general', `${callsign}'s odd jobs`, 'Help around the place', hc(5), 'fixed', id.pk, undefined, undefined, undefined, true);
    return id;
}

async function call(method: 'GET' | 'POST', urlPath: string, id: Id, body?: unknown) {
    resetGatewayRateLimit();
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
const post = (id: Id, urlPath: string, body: unknown) => call('POST', urlPath, id, body);
const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;

type Row = { price_type: string; price_c: number; repeatable: number; status: string; units_left: number | null; lot_price_c: number | null; lot_units: number | null; author_pubkey: string; created_by: string | null };
const row = (id: string) => db.prepare('SELECT price_type, price_c, repeatable, status, units_left, lot_price_c, lot_units, author_pubkey, created_by FROM posts WHERE id = ?').get(id) as Row;
const titled = (title: string) => (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE title = ?').get(title) as { n: number }).n;
const bal = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c ?? 0;
const commons = () => getCommonsBalanceExact();
type DealRow = { status: string; amount_c: number; hours: number | null; item_option: string | null; buyer_pubkey: string; seller_pubkey: string };
const deal = (id: string) => db.prepare('SELECT status, amount_c, hours, item_option, buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE id = ?').get(id) as DealRow;
function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as { t: number }).t;
    return accounts + getCommonsBalanceExact();
}
/** The conservation check after a money step: the audit clean, and every account plus the Commons summing to 0, exactly. */
function conserved(step: string): void {
    const a = runLedgerAudit();
    assert(a.ok && a.drift === 0 && a.strandedEscrows === 0 && a.badBalances === 0 && nodeTotal() === 0,
        `the Beans add up after ${step} (drift ${a.drift}, stranded ${a.strandedEscrows}, not a number ${a.badBalances}, total ${nodeTotal()})`);
}

async function main(): Promise<void> {
    console.log('An enterprise prices its own Offer for each one\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const kim = makeMember('Kim');          // keeps the Riverside stall
    const sam = makeMember('Sam');          // keeps nothing
    const oli = makeMember('Oli');          // keeps another enterprise
    const { publicKey: riverside } = createTreasury('Riverside stall', AVATAR, 0, { leadKeeperPubkey: kim.pk });
    adminAssignTreasuryOperator(riverside, kim.pk, 'admin');
    const { publicKey: hillside } = createTreasury('Hillside bikes', AVATAR, 0, { leadKeeperPubkey: oli.pk });
    adminAssignTreasuryOperator(hillside, oli.pk, 'admin');

    /** The enterprise's Offer as the phone and the web send it: the enterprise in the path, no key in the body. */
    const entOffer = (who: Id, ent: string, body: Record<string, unknown>) => post(who, `/api/treasury/${ent}/offer`, {
        category: 'food', description: 'From the stall', photos: TEST_PHOTOS, ...body,
    });
    const entNeed = (who: Id, ent: string, body: Record<string, unknown>) => post(who, `/api/treasury/${ent}/need`, {
        category: 'food', description: 'For the stall', photos: TEST_PHOTOS, ...body,
    });
    /** The member's own route, the yardstick: the same fields, the member its author. */
    const ownListing = (who: Id, body: Record<string, unknown>) => post(who, '/api/marketplace/posts', {
        type: 'offer', category: 'food', description: 'From my garden', authorPublicKey: who.pk, photos: TEST_PHOTOS, ...body,
    });
    const JAM = { priceType: 'each', price_c: hc(6.5), unitsLeft: 12, lot: { price_c: hc(70) } };

    // ── 0. The switches, before any Bean moves (a money switch can be off only on a node whose ledger never moved) ─────
    console.log('— 0. The switches');
    assert(getNodeFeatures().perItem === true, 'a local community says perItem, so both apps offer Each on the enterprise\'s Offer form');
    for (const off of ['enterprises', 'beans'] as const) {
        setSwitchOverride(off, false);
        const title = `Jam with ${off} off`;
        const r = await entOffer(kim, riverside, { title, ...JAM });
        // Red if the enterprise's Offer route leaves the enterprises group of routes/profile-feature-gate.ts.
        assert(r.status === 404 && r.body?.code === 'feature_off' && titled(title) === 0,
            `with ${off === 'beans' ? 'Beans' : 'enterprises'} off: an each-priced enterprise Offer is refused before the handler, 404 feature_off, nothing stored (${brief(r)})`);
        setSwitchOverride(off, true);
    }

    // ── 1. A keeper prices the enterprise's Offer for each one ────────────────────────────────────────────────────────
    console.log('\n— 1. A keeper');
    // Repeatable sent true (the route's own default when none is sent): the count takes its place.
    const jam = await entOffer(kim, riverside, { title: 'Plum jam', ...JAM, repeatable: true });
    const jamId = jam.body?.post?.id as string;
    const j0 = jamId ? row(jamId) : null;
    // Red if the route stops passing unitsLeft and lot to createPost (the engine then refuses `units_refused`).
    assert(jam.status === 200 && !!j0 && j0.price_type === 'each' && j0.price_c === hc(6.5) && j0.units_left === 12 && j0.lot_price_c === hc(70) && j0.lot_units === 12,
        `Kim lists the stall's plum jam: 6.50 each, 12 of them, all 12 for 70, stored as a member's would be (${brief(jam)})`);
    assert(!!j0 && j0.repeatable === 0 && jam.body?.post?.repeatable === false, 'and never Repeatable, though Repeatable was sent (the count takes its place)');
    assert(!!j0 && j0.author_pubkey === riverside && j0.created_by === kim.pk, 'the enterprise is its author, and the keeper who made it is on the row');
    assert(jam.body?.post?.unitsLeft === 12 && jam.body?.post?.lot?.units === 12 && jam.body?.post?.lot?.price_c === hc(70) && jam.body?.post?.priceType === 'each',
        `the answer says unitsLeft and lot (${JSON.stringify({ unitsLeft: jam.body?.post?.unitsLeft, lot: jam.body?.post?.lot })})`);
    const read = (await call('GET', `/api/marketplace/posts?id=${jamId}`, sam)).body?.[0];
    assert(read?.unitsLeft === 12 && read?.lot?.price_c === hc(70) && read?.priceType === 'each' && read?.authorPublicKey === riverside,
        'a buyer reads it as any Offer priced for each one');
    const noRepeatSent = await entOffer(kim, riverside, { title: 'Quince paste', priceType: 'each', price_c: hc(4), unitsLeft: 30 });
    const q0 = noRepeatSent.status === 200 ? row(noRepeatSent.body.post.id) : null;
    assert(!!q0 && q0.units_left === 30 && q0.lot_price_c === null && q0.lot_units === null && q0.repeatable === 0 && !('lot' in noRepeatSent.body.post),
        `a count with no price for all keeps none and says none, and no Repeatable sent is still not Repeatable (${brief(noRepeatSent)})`);

    // ── 2. Not a keeper ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. Not a keeper');
    // The same refusal as for any Offer the enterprise lists (requireOperator), Total or each.
    for (const [who, label] of [[sam, 'a member who keeps nothing'], [oli, 'a keeper of another enterprise']] as const) {
        const each = await entOffer(who, riverside, { title: `Jam by ${who.callsign}`, ...JAM });
        const total = await entOffer(who, riverside, { title: `Total by ${who.callsign}`, priceType: 'fixed', price_c: hc(6) });
        assert(each.status === 403 && each.body?.error === 'You are not a keeper of this enterprise' && titled(`Jam by ${who.callsign}`) === 0
            && total.status === each.status && total.body?.error === each.body?.error && titled(`Total by ${who.callsign}`) === 0,
            `${label}: refused 403 as for a Total Offer, nothing stored (${brief(each)})`);
    }
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + DAY).toISOString(), kim.pk);
    const muted = await entOffer(kim, riverside, { title: 'Muted jam', ...JAM });
    assert(muted.status === 403 && muted.body?.code === 'moderation_muted' && titled('Muted jam') === 0, `a muted keeper posts nothing for it (${brief(muted)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(kim.pk);
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + DAY).toISOString(), riverside);
    const mutedEnt = await entOffer(kim, riverside, { title: 'Muted stall jam', ...JAM });
    assert(mutedEnt.status === 403 && mutedEnt.body?.code === 'moderation_muted' && titled('Muted stall jam') === 0, `nobody posts for a muted enterprise (${brief(mutedEnt)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(riverside);

    // ── 3. Bad counts: the enterprise's routes answer exactly as the member's ────────────────────────────────────────
    console.log('\n— 3. Bad counts, as the member route refuses them');
    const ONE = { priceType: 'each', price_c: hc(6.5) };
    const table: Array<[string, Record<string, unknown>, string, string, 'offer' | 'need']> = [
        ['no count', { ...ONE }, 'units_refused', said('units_refused'), 'offer'],
        // Whole numbers only at the door, never rounded: 0, −1, 2.5, "3", Infinity (null in JSON), 10,000, a list, an object.
        ...([0, -1, 2.5, '3', Infinity, 10_000, [3], { n: 3 }] as unknown[]).map((bad): [string, Record<string, unknown>, string, string, 'offer'] =>
            [`count ${JSON.stringify(bad)}`, { ...ONE, unitsLeft: bad }, 'units_refused', said('units_refused'), 'offer']),
        ['a price for all of one', { ...ONE, unitsLeft: 1, lot: { price_c: hc(5) } }, 'lot_needs_two', said('lot_needs_two'), 'offer'],
        ['a price for all above one by one', { ...ONE, unitsLeft: 12, lot: { price_c: hc(78.01) } }, 'lot_not_less', said('lot_not_less', { count: 12, total_c: hc(78) }), 'offer'],
        ...([{ price_c: 0 }, { price_c: 5.5 }, { price_c: '70' }, 7000] as unknown[]).map((bad): [string, Record<string, unknown>, string, string, 'offer'] =>
            [`a price for all ${JSON.stringify(bad)}`, { ...ONE, unitsLeft: 12, lot: bad }, 'lot_price_refused', said('lot_price_refused'), 'offer']),
        ['a Need priced each', { ...ONE, unitsLeft: 12 }, 'each_offer_only', said('each_offer_only'), 'need'],
    ];
    let n = 0;
    for (const [label, body, code, words, kind] of table) {
        const entTitle = `Ent bad ${++n}`;
        const ownTitle = `Own bad ${n}`;
        const ent = kind === 'need' ? await entNeed(kim, riverside, { title: entTitle, ...body }) : await entOffer(kim, riverside, { title: entTitle, ...body });
        const own = await ownListing(sam, { title: ownTitle, ...body, ...(kind === 'need' ? { type: 'need' } : {}) });
        // Red if the treasury route answers a per-item refusal in its own shape (no code), or lets one through.
        assert(ent.status === 400 && ent.body?.code === code && ent.body?.error === words && titled(entTitle) === 0
            && own.status === ent.status && own.body?.code === ent.body?.code && own.body?.error === ent.body?.error && titled(ownTitle) === 0,
            `${label}: the enterprise's route refuses 400 ${code} in the member route's words, nothing stored (enterprise ${brief(ent)}; member ${brief(own)})`);
    }
    // The same as one by one is allowed for the enterprise as for a member (12 × 6.50 = 78).
    const same = await entOffer(kim, riverside, { title: 'Jam, the same for all', ...ONE, unitsLeft: 12, lot: { price_c: hc(78) } });
    assert(same.status === 200 && row(same.body.post.id).lot_price_c === hc(78) && row(same.body.post.id).lot_units === 12,
        `a price for all the same as one by one is taken, as on a member's Offer (${brief(same)})`);

    // ── 4. The one-off price unchanged ───────────────────────────────────────────────────────────────────────────────
    console.log('\n— 4. The one-off price unchanged');
    for (const [title, body, repeatable] of [
        ['Dozen eggs', { priceType: 'fixed', price_c: hc(6) }, 1], // the route's default: Repeatable
        ['A jar, once', { priceType: 'fixed', price_c: hc(6), repeatable: false }, 0],
        ['Stall help', { priceType: 'hourly', price_c: hc(20), repeatable: true }, 1],
    ] as const) {
        // A count and a price for all sent with another unit are stored nowhere (red if the route sets them for any unit).
        const r = await entOffer(kim, riverside, { title, ...body, unitsLeft: 20, lot: { price_c: hc(1) } });
        const s = r.status === 200 ? row(r.body.post.id) : null;
        assert(!!s && s.price_type === body.priceType && s.price_c === body.price_c && s.units_left === null && s.lot_price_c === null && s.lot_units === null
            && s.repeatable === repeatable && !('unitsLeft' in r.body.post) && !('lot' in r.body.post),
            `${title} (${body.priceType}) is made and read exactly as before: no count, no price for all, Repeatable ${repeatable} (${brief(r)})`);
    }
    const need = await entNeed(kim, riverside, { title: 'Mind the stall', priceType: 'fixed', price_c: hc(15), unitsLeft: 3 });
    const nr = need.status === 200 ? row(need.body.post.id) : null;
    assert(!!nr && nr.price_type === 'fixed' && nr.units_left === null && nr.repeatable === 0, `a Need is made as before, a count sent with it stored nowhere (${brief(need)})`);

    // ── 5. Buyers take it up as any each-priced Offer ────────────────────────────────────────────────────────────────
    console.log('\n— 5. A buyer takes 3 of 12');
    const dana = makeMember('Dana', 200);
    conserved('the members are seeded');
    const danaStart = bal(dana.pk);
    const took = await post(dana, '/api/marketplace/posts/accept', { postId: jamId, buyerPublicKey: dana.pk, hours: 3, itemOption: 'each', expect_c: hc(19.5) });
    const d1 = took.body?.transaction?.id as string;
    assert(took.status === 200 && !!d1 && deal(d1).status === 'pending' && deal(d1).item_option === 'each' && deal(d1).hours === 3 && deal(d1).amount_c === hc(19.5)
        && deal(d1).seller_pubkey === riverside && deal(d1).buyer_pubkey === dana.pk && bal(dana.pk) === danaStart - hc(19.5),
        `Dana takes 3 jars at 6.50: 19.50 held in trust, the enterprise the seller (${brief(took)})`);
    assert(row(jamId).units_left === 9 && row(jamId).status === 'active', `the count drops to 9 and the jam stays on the board (${JSON.stringify(row(jamId))})`);
    conserved('the take-up');
    const stallBefore = bal(riverside);
    const commonsBefore = commons();
    const released = await post(dana, '/api/marketplace/transactions/complete', { transactionId: d1, confirmerPublicKey: dana.pk });
    const fee = feeOf(hc(19.5));
    assert(released.status === 200 && deal(d1).status === 'completed' && bal(riverside) === stallBefore + hc(19.5) - fee && commons() === commonsBefore + fee,
        `released: the enterprise gets 19.50 less the one fee (${bal(riverside) - stallBefore}), the Commons the fee (${commons() - commonsBefore}) (${brief(released)})`);
    assert(row(jamId).units_left === 9 && row(jamId).status === 'active', 'the count stays 9 after the release');
    conserved('the release');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ An enterprise pricing its own Offer for each one PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
