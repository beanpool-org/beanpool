/**
 * Per-item prices on the server, slice P1: the deals (scratch/fable-design/DESIGN-per-item-price-fable.md §4, §5, §9). Every
 * request is signed and goes through the real HTTPS server and its signature middleware; after every money step the ledger
 * audit is clean and every account plus the Commons sums to 0, with ===. Rob's panels: 300 Beans each, 20 of them, or all 20
 * for 5,500. Each check names the change that turns it red.
 *
 *   1. Take 3 of 20: 900 held in the deal's own escrow, the count 17 in the same step, the listing still on the board; the
 *      deal row alone says what it is (hours 3, item_option each, amount 900); the price for all is off; the seller's push and
 *      the chat's trust line say how many; the seller's stale edit of the count is refused with the count now.
 *   2. Release: the seller +886.50, the Commons +13.50, the count stays 17; a release for another number moves nothing (D5).
 *   3. Cancel: the count back to 20, the price for all on offer again; all 20 for 5,500: the count 0, still on the board, one
 *      more refused; its release pays 5,417.50 and 82.50 and the listing is sold out (completed), and can't be taken up.
 *   4. Sold out only when no deal is held: one releases with another held, the other is cancelled by the seller (1 back), the
 *      last releases (completed).
 *   5. A paused listing stays paused through a cancel, and a release with none left closes it; a pruned seller's stays down.
 *   6. The three rulings: a refund puts the count back; a release and a split don't, and the split of the last closes it.
 *   7. Races: two take-ups for the last one; all against one, in both orders and at once; a double tap opens one deal; every
 *      clause of the guarded write refuses a row that moved (red if the UPDATE's WHERE loses one).
 *   8. The buyer's figures: expect_c wrong or missing, no way given (an app from before), fractions and bad numbers, more than
 *      are left, the price for all changed under the buyer, a buyer who can't afford it: refused, nothing held, the count kept.
 *   9. Doors refused: a request, the approval of a request somehow waiting, a standing body; a take-up for each one of a Total,
 *      a copy, a Need or a loan meets that listing's own refusal or price_changed; the count never moves.
 *  10. The paths that don't change: a Total (with the total it showed, and a wrong one), an hourly with its re-rate,
 *      Repeatable, a loan, a standing deal: one case each.
 *  11. The count never blocks a refund: a cancel with the count at 9,999 puts back what fits, and the Beans go back.
 *  12. An enterprise buying from its own keeper more than are left: told how many are left, and no deferred wage claim is
 *      recorded for items that aren't there (the stock is asked before the funding check, which records one as it refuses).
 *  13. A standby copy carries the hold's row and the count it moved, together.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-per-item-deals)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { db } from './db/db.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { wrapCreatePost, TEST_PHOTOS } from './post-test-helper.js';
import {
    initStateEngine, transfer, createPost as rawCreatePost, runLedgerAudit, getCommonsBalanceExact, registerPushToken, adminPruneUser,
    COMMUNITY_DECISION_ACTOR, exportSyncState, importRemoteState, setNodeRole, createTreasury, acceptPost,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { reserveUnits } from './engine/per-item.js';
import { setMemberPhoto } from '@beanpool/engine';
import {
    feeOf, halves, itemTakeUpRefusalText, lotOffered, perItemLines, standingAuthorisationText, wordsFor, type ItemTakeUp, type ItemTakeUpRefusal,
} from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
// Expo is answered here, so who is told what is read from the notices this server keeps; nothing else off it is reached.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) {
        const msgs = JSON.parse(String(init?.body ?? '[]'));
        return new Response(JSON.stringify({ data: (Array.isArray(msgs) ? msgs : [msgs]).map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!url.startsWith('https://localhost')) throw new Error(`test-per-item-deals: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const EN = wordsFor('en');
const says = (code: ItemTakeUpRefusal, count?: number) => itemTakeUpRefusalText({ code, count }, EN);
/** The story's figures are Beans; the node's are whole hundredths. */
const hc = (beans: number) => Math.round(beans * 100);
const EPOCH_NOW = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
let BASE = '';
let HOST = '';
let ADMIN: Record<string, string> = {};
type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

function makeMember(callsign: string, beans: number): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const id = { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, callsign);
    setMemberPhoto(db, id.pk, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, EPOCH_NOW);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${callsign}`, 'direct', true);
    createPost('offer', 'general', `${callsign} odd jobs`, 'Help around the place', hc(5), 'fixed', id.pk, undefined, undefined, undefined, true);
    registerPushToken(id.pk, `ExponentPushToken[peritem-${callsign}-${id.pk.slice(0, 6)}]`, 'android');
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
const post = (id: Id, urlPath: string, body: unknown) => call('POST', urlPath, id, body);

async function adminPost(urlPath: string, body: unknown) {
    const res = await fetch(`${BASE}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ADMIN }, body: JSON.stringify(body) });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`;
type ListingRow = {
    status: string; active: number; units_left: number | null; lot_units: number | null; lot_price_c: number | null; price_c: number; price_type: string;
    accepted_by: string | null; pending_transaction_id: string | null;
};
const listing = (id: string) => db.prepare(`SELECT status, active, units_left, lot_units, lot_price_c, price_c, price_type, accepted_by, pending_transaction_id
    FROM posts WHERE id = ?`).get(id) as ListingRow;
type DealRow = { status: string; amount_c: number; hours: number | null; item_option: string | null };
const deal = (id: string) => db.prepare('SELECT status, amount_c, hours, item_option FROM marketplace_transactions WHERE id = ?').get(id) as DealRow;
const dealsOn = (postId: string) => (db.prepare('SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ?').get(postId) as { n: number }).n;
const bal = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c ?? 0;
const escrowOf = (txId: string) => bal(`escrow_${txId}`);
const commons = () => getCommonsBalanceExact();
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
const pushMark = (): number => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM push_notices').get() as { m: number }).m;
const toldSince = (to: Id, mark: number) => db.prepare('SELECT title, body FROM push_notices WHERE recipient = ? AND rowid > ? ORDER BY rowid').all(to.pk, mark) as Array<{ title: string; body: string }>;
const fundedLine = (txId: string) => (db.prepare("SELECT metadata FROM messages WHERE system_type = 'ESCROW_FUNDED'").all() as { metadata: string }[])
    .map(r => { try { return JSON.parse(r.metadata); } catch { return {}; } }).find(m => m.transactionId === txId);
const settle = () => new Promise(r => setTimeout(r, 150));

async function main(): Promise<void> {
    console.log('Per-item prices, P1: the deals\n');
    await initTls();
    initStateEngine();
    ADMIN = ownerTokenHeaders('admin');
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    HOST = new URL(BASE).hostname;
    const rob = makeMember('Rob', 100);
    const dana = makeMember('Dana', 20_000);
    const eli = makeMember('Eli', 20_000);
    const fay = makeMember('Fay', 20_000);
    const gus = makeMember('Gus', 10);
    conserved('the members are seeded');

    const offer = (who: Id, body: Record<string, unknown>) => post(who, '/api/marketplace/posts', {
        type: 'offer', category: 'tools', description: 'Second-hand, working', authorPublicKey: who.pk, photos: TEST_PHOTOS, ...body,
    });
    const made = async (who: Id, body: Record<string, unknown>): Promise<string> => {
        const r = await offer(who, body);
        if (r.status !== 200 || typeof r.body?.post?.id !== 'string') throw new Error(`could not make ${String(body.title)}: ${brief(r)}`);
        return r.body.post.id;
    };
    const panels = (title: string) => made(rob, { title, priceType: 'each', price_c: hc(300), unitsLeft: 20, lot: { price_c: hc(5500) } });
    const edit = (who: Id, id: string, body: Record<string, unknown>) => post(who, '/api/marketplace/posts/update', { id, authorPublicKey: who.pk, ...body });
    const byId = async (who: Id, id: string) => ((await call('GET', `/api/marketplace/posts?id=${id}`, who)).body ?? [])[0];
    const take = (who: Id, postId: string, n: unknown, option: unknown, expect_c: unknown) =>
        post(who, '/api/marketplace/posts/accept', { postId, buyerPublicKey: who.pk, hours: n, itemOption: option, expect_c });
    const release = (who: Id, transactionId: string, finalHours?: unknown) =>
        post(who, '/api/marketplace/transactions/complete', { transactionId, confirmerPublicKey: who.pk, ...(finalHours !== undefined ? { finalHours } : {}) });
    const cancel = (who: Id, transactionId: string) => post(who, '/api/marketplace/transactions/cancel', { transactionId, cancellerPublicKey: who.pk });
    const rule = (transactionId: string, action: string) => adminPost(`/api/local/admin/disputes/${transactionId}/resolve`, { action });
    const pause = (postId: string) => post(rob, '/api/marketplace/posts/pause', { postId, authorPublicKey: rob.pk });
    const resume = (postId: string) => post(rob, '/api/marketplace/posts/resume', { postId, authorPublicKey: rob.pk });

    /** A take-up that must be refused with this code and status: nothing held, no deal row, the count as it was. */
    const refused = async (label: string, who: Id, postId: string, body: Record<string, unknown>, want: { status: number; code: ItemTakeUpRefusal; unitsLeft?: number }) => {
        const before = { bal: bal(who.pk), units: listing(postId).units_left, deals: dealsOn(postId), status: listing(postId).status };
        const r = await post(who, '/api/marketplace/posts/accept', { postId, buyerPublicKey: who.pk, ...body });
        const words = says(want.code, want.unitsLeft);
        assert(r.status === want.status && r.body?.code === want.code && r.body?.error === words
            && (want.unitsLeft === undefined || r.body?.unitsLeft === want.unitsLeft)
            && bal(who.pk) === before.bal && listing(postId).units_left === before.units && dealsOn(postId) === before.deals && listing(postId).status === before.status,
            `${label}: refused ${want.status} ${want.code} ("${words}"), nothing held, the count as it was (${brief(r)})`);
    };

    // ── 1. Take 3 of 20 ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('— 1. Take 3 of 20');
    const solar = await panels('Solar panels');
    const danaStart = bal(dana.pk);
    const mark1 = pushMark();
    const took = await take(dana, solar, 3, 'each', hc(900));
    const d1 = took.body?.transaction?.id as string;
    assert(took.status === 200 && took.body.transaction.itemOption === 'each' && took.body.transaction.hours === 3 && took.body.transaction.amount_c === hc(900),
        `Dana takes 3 of 20 at 300: the answer is a deal for 3, each, 900 Beans (${brief(took)})`);
    const dr1 = deal(d1);
    // Red if openHold stops writing item_option, or acceptPost keeps the hourly path's quantity.
    assert(dr1.status === 'pending' && dr1.hours === 3 && dr1.item_option === 'each' && dr1.amount_c === hc(900) && escrowOf(d1) === hc(900) && bal(dana.pk) === danaStart - hc(900),
        `the deal row alone says what it is: 3, each, 900 held in its own escrow (${JSON.stringify(dr1)})`);
    const l1 = listing(solar);
    // Red if reserveUnits is not called in the hold, or takeListing is not null for a listing priced for each one.
    assert(l1.units_left === 17 && l1.status === 'active' && l1.accepted_by === null && l1.pending_transaction_id === null,
        `the count drops to 17 in the same step, and the listing stays on the board (${JSON.stringify(l1)})`);
    const seen = await byId(eli, solar);
    assert(seen?.unitsLeft === 17 && seen?.lot?.units === 20 && !lotOffered(seen), 'another buyer reads 17 left, and the price for all is off (it was for 20)');
    conserved('a take-up of 3');
    await settle();
    const told = toldSince(rob, mark1);
    // Red if the push keeps "accepted … are now in escrow" for a per-item deal.
    assert(told.some(n => n.body === perItemLines.pushTook('each', 'Dana', 3, 'Solar panels', hc(900)) && n.body === 'Dana took 3 of "Solar panels". 900 Beans are held in trust.'),
        `the seller's push says how many (${JSON.stringify(told)})`);
    const line1 = fundedLine(d1);
    assert(line1?.itemOption === 'each' && line1?.count === 3 && line1?.amount_c === hc(900), `the chat's trust line carries the count (${JSON.stringify(line1)})`);
    const listed = await call('GET', `/api/marketplace/transactions?publicKey=${dana.pk}`, dana);
    const listedDeal = (Array.isArray(listed.body) ? listed.body : listed.body?.transactions ?? []).find((t: any) => t.id === d1);
    assert(listedDeal?.itemOption === 'each' && listedDeal?.hours === 3 && listedDeal?.amount_c === hc(900), `Your deals read it the same (${JSON.stringify(listedDeal)?.slice(0, 160)})`);
    const staleEdit = await edit(rob, solar, { unitsLeft: 25, unitsLeftWas: 20 });
    assert(staleEdit.status === 409 && staleEdit.body?.code === 'units_changed' && staleEdit.body?.unitsLeft === 17 && listing(solar).units_left === 17,
        `the seller's edit made with the count read before the take-up is refused with the count now, and the sale stands (${brief(staleEdit)})`);

    // ── 2. Release ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. Release');
    const robBefore = bal(rob.pk);
    const commonsBefore = commons();
    for (const n of [1, 5, 2.5]) {
        const other = await release(dana, d1, n);
        // Red if completePostTransaction re-rates a per-item deal (it would pay 300 for 1 and refund 600).
        assert(other.status === 400 && other.body?.code === 'deal_count_fixed' && other.body?.error === says('deal_count_fixed', 3)
            && deal(d1).status === 'pending' && deal(d1).amount_c === hc(900) && escrowOf(d1) === hc(900) && bal(rob.pk) === robBefore,
            `a release for ${n} of a deal for 3 is refused, nothing moves (D5) (${brief(other)})`);
    }
    const released = await release(dana, d1);
    assert(released.status === 200 && deal(d1).status === 'completed' && deal(d1).amount_c === hc(900) && deal(d1).hours === 3 && escrowOf(d1) === 0,
        `released with no number, it pays what it holds (${brief(released)})`);
    assert(bal(rob.pk) === robBefore + hc(886.5) && commons() === commonsBefore + hc(13.5),
        `Rob receives 886.50 and the Commons 13.50, the 1.5% taken once (${bal(rob.pk) - robBefore}, ${commons() - commonsBefore})`);
    // Red if the release puts the count back, or closes the listing as a one-off sale.
    assert(listing(solar).units_left === 17 && listing(solar).status === 'active', `the count stays 17 and the listing on the board (${JSON.stringify(listing(solar))})`);
    conserved('the release');

    // ── 3. Cancel, then all 20 for 5,500 ────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. Cancel, then all 20');
    const second = await panels('Panels, second lot');
    const eliStart = bal(eli.pk);
    const one = await take(eli, second, 1, 'each', hc(300));
    const dOne = one.body?.transaction?.id as string;
    assert(one.status === 200 && listing(second).units_left === 19, `Eli takes 1: 19 left (${brief(one)})`);
    await refused('all 20 once one is taken singly', fay, second, { hours: 20, itemOption: 'lot', expect_c: hc(5500) }, { status: 409, code: 'lot_gone' });
    const back = await cancel(eli, dOne);
    // Red if cancelPostTransaction leaves the count where it was.
    assert(back.status === 200 && deal(dOne).status === 'cancelled' && listing(second).units_left === 20 && bal(eli.pk) === eliStart && escrowOf(dOne) === 0,
        `the cancel puts the count back to 20 and the Beans back (${brief(back)})`);
    assert(lotOffered(await byId(fay, second)), 'and the price for all is on offer again (D2)');
    conserved('the cancel');
    const all = await take(fay, second, 20, 'lot', hc(5500));
    const dAll = all.body?.transaction?.id as string;
    const drAll = deal(dAll);
    assert(all.status === 200 && drAll.item_option === 'lot' && drAll.hours === 20 && drAll.amount_c === hc(5500) && escrowOf(dAll) === hc(5500) && all.body.transaction.itemOption === 'lot',
        `Fay takes all 20 for 5,500: one deal, lot, 20, 5,500 held (${brief(all)})`);
    assert(listing(second).units_left === 0 && listing(second).status === 'active', 'the count is 0, "All taken for now": still on the board while the deal is held (D3)');
    await refused('one more once all are taken', dana, second, { hours: 1, itemOption: 'each', expect_c: hc(300) }, { status: 409, code: 'units_gone', unitsLeft: 0 });
    await refused('all of them again', dana, second, { hours: 20, itemOption: 'lot', expect_c: hc(5500) }, { status: 409, code: 'units_gone', unitsLeft: 0 });
    const robB = bal(rob.pk);
    const comB = commons();
    const paidAll = await release(fay, dAll, 20);
    assert(paidAll.status === 200 && bal(rob.pk) === robB + hc(5417.5) && commons() === comB + hc(82.5),
        `released with its own number: Rob receives 5,417.50 and the Commons 82.50 (${brief(paidAll)})`);
    // Red if settleItemDeal's sold-out step is lost (the listing would sit at 0 left for ever).
    assert(listing(second).status === 'completed' && listing(second).units_left === 0, `Sold out: the listing closes once none are left and nothing is held (${JSON.stringify(listing(second))})`);
    conserved('all 20 released');
    const gone = await take(dana, second, 1, 'each', hc(300));
    assert(gone.status === 400 && gone.body?.code === 'post_gone' && dealsOn(second) === 2, `a sold-out listing can't be taken up (${brief(gone)})`);

    // ── 4. Sold out only when no deal is held ───────────────────────────────────────────────────────────────────────
    console.log('\n— 4. Sold out only when no deal is held');
    const jars = await made(rob, { title: 'Honey jars', priceType: 'each', price_c: hc(10), unitsLeft: 2 });
    const ja = await take(dana, jars, 1, 'each', hc(10));
    const jb = await take(eli, jars, 1, 'each', hc(10));
    assert(ja.status === 200 && jb.status === 200 && listing(jars).units_left === 0, `two take 1 each of 2: none left (${brief(ja)} ${brief(jb)})`);
    await release(dana, ja.body.transaction.id);
    // Red if sold out ignores the other deal still held.
    assert(listing(jars).status === 'active' && listing(jars).units_left === 0, 'one releases while the other is held: still "All taken for now", on the board');
    const eliJ = bal(eli.pk);
    const sellerCancel = await cancel(rob, jb.body.transaction.id);
    assert(sellerCancel.status === 200 && listing(jars).units_left === 1 && listing(jars).status === 'active' && bal(eli.pk) === eliJ + hc(10),
        `the seller cancels the other: 1 left, on offer again, Eli refunded (${brief(sellerCancel)})`);
    const jc = await take(fay, jars, 1, 'each', hc(10));
    await release(fay, jc.body.transaction.id);
    assert(listing(jars).status === 'completed' && listing(jars).units_left === 0, 'the last one released: Sold out');
    conserved('the last deals');

    // ── 5. A paused listing stays paused; a pruned seller's stays down ──────────────────────────────────────────────
    console.log('\n— 5. Paused and removed listings');
    const bowls = await made(rob, { title: 'Bowls', priceType: 'each', price_c: hc(15), unitsLeft: 5 });
    const bw = await take(dana, bowls, 2, 'each', hc(30));
    assert(bw.status === 200 && (await pause(bowls)).status === 200 && listing(bowls).status === 'paused' && listing(bowls).units_left === 3, 'Dana takes 2 of 5, and Rob pauses it');
    const bwBack = await cancel(dana, bw.body.transaction.id);
    // Red if the cancel's "back on the board" line runs for a per-item deal (a paused listing would go live again).
    assert(bwBack.status === 200 && listing(bowls).status === 'paused' && listing(bowls).units_left === 5, `the cancel puts 2 back and the listing stays paused (${JSON.stringify(listing(bowls))})`);
    assert((await resume(bowls)).status === 200 && listing(bowls).status === 'active', 'resumed by Rob');
    const bwAll = await take(eli, bowls, 5, 'each', hc(75));
    assert(bwAll.status === 200 && (await pause(bowls)).status === 200 && listing(bowls).units_left === 0, 'Eli takes all 5 one by one, and Rob pauses it again');
    await release(eli, bwAll.body.transaction.id);
    assert(listing(bowls).status === 'completed', `released with none left: Sold out, paused or not (${JSON.stringify(listing(bowls))})`);
    const sam = makeMember('Sam', 100);
    const mugs = await made(sam, { title: 'Mugs', priceType: 'each', price_c: hc(4), unitsLeft: 6 });
    const mg = await take(fay, mugs, 2, 'each', hc(8));
    adminPruneUser(sam.pk, COMMUNITY_DECISION_ACTOR);
    assert(mg.status === 200 && listing(mugs).status === 'cancelled' && deal(mg.body.transaction.id).status === 'pending', 'a pruned seller\'s listing is down, its deal left for the buyer to close');
    const fayM = bal(fay.pk);
    const mgBack = await cancel(fay, mg.body.transaction.id);
    // Red if settleItemDeal touches the status on a return.
    assert(mgBack.status === 200 && listing(mugs).status === 'cancelled' && listing(mugs).units_left === 6 && bal(fay.pk) === fayM + hc(8),
        `the buyer's cancel refunds and the count goes back, and the listing stays down (${brief(mgBack)} ${JSON.stringify(listing(mugs))})`);
    conserved('paused and removed');

    // ── 6. The three rulings ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 6. The three rulings');
    const tiles = await made(rob, { title: 'Roof tiles', priceType: 'each', price_c: hc(300), unitsLeft: 12 });
    const tr1 = await take(dana, tiles, 2, 'each', hc(600));
    const danaT = bal(dana.pk);
    const refund = await rule(tr1.body.transaction.id, 'refund_to_buyer');
    // Red if the refund ruling leaves the count where it was.
    assert(refund.status === 200 && deal(tr1.body.transaction.id).status === 'cancelled' && listing(tiles).units_left === 12 && bal(dana.pk) === danaT + hc(600),
        `a refund ruling puts the 2 back and refunds Dana (${brief(refund)})`);
    const tr2 = await take(eli, tiles, 3, 'each', hc(900));
    const robT = bal(rob.pk);
    const comT = commons();
    const toSeller = await rule(tr2.body.transaction.id, 'release_to_seller');
    assert(toSeller.status === 200 && listing(tiles).units_left === 9 && listing(tiles).status === 'active' && bal(rob.pk) === robT + hc(886.5) && commons() === comT + hc(13.5),
        `a release ruling pays Rob 886.50 and keeps the count at 9 (${brief(toSeller)})`);
    const tr3 = await take(fay, tiles, 9, 'each', hc(2700));
    assert(tr3.status === 200 && listing(tiles).units_left === 0, 'Fay takes the 9 left');
    const [buyerHalf, sellerHalf] = halves(hc(2700));
    const fayT = bal(fay.pk);
    const robT2 = bal(rob.pk);
    const split = await rule(tr3.body.transaction.id, 'split');
    // Red if the split ruling puts the count back, or doesn't close the listing it emptied.
    assert(split.status === 200 && bal(fay.pk) === fayT + buyerHalf && bal(rob.pk) === robT2 + sellerHalf - feeOf(sellerHalf)
        && listing(tiles).units_left === 0 && listing(tiles).status === 'completed',
        `a split ruling: half back to Fay, half to Rob less the 1.5%, nothing back to the count, and it is sold out (${brief(split)} ${JSON.stringify(listing(tiles))})`);
    conserved('the rulings');

    // ── 7. Races ────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 7. Races');
    const lamp = await made(rob, { title: 'Lamp', priceType: 'each', price_c: hc(50), unitsLeft: 1 });
    const bals = [bal(dana.pk), bal(eli.pk)];
    const pair = await Promise.all([take(dana, lamp, 1, 'each', hc(50)), take(eli, lamp, 1, 'each', hc(50))]);
    const won = pair.filter(r => r.status === 200);
    const lost = pair.filter(r => r.status !== 200);
    assert(won.length === 1 && lost.length === 1 && lost[0].status === 409 && lost[0].body?.code === 'units_gone' && lost[0].body?.unitsLeft === 0
        && lost[0].body?.error === says('units_gone', 0) && dealsOn(lamp) === 1 && listing(lamp).units_left === 0,
        `two buyers at once for the last one: one holds it, the other is told they have all been taken up (${pair.map(brief).join(' | ')})`);
    const loser = pair[0].status === 200 ? 1 : 0;
    assert(bal([dana, eli][loser].pk) === bals[loser], 'nothing of the second moves');
    conserved('two for the last one');

    const singleFirst = await panels('Panels, one first');
    assert((await take(eli, singleFirst, 1, 'each', hc(300))).status === 200, 'one taken singly first');
    await refused('then all 20', dana, singleFirst, { hours: 20, itemOption: 'lot', expect_c: hc(5500) }, { status: 409, code: 'lot_gone' });
    const nineteen = await take(dana, singleFirst, 19, 'each', hc(5700));
    assert(nineteen.status === 200 && listing(singleFirst).units_left === 0 && deal(nineteen.body.transaction.id).amount_c === hc(5700),
        `who wanted all of them can take the 19 left one by one: 5,700 (${brief(nineteen)})`);
    const allFirst = await panels('Panels, all first');
    assert((await take(dana, allFirst, 20, 'lot', hc(5500))).status === 200, 'all 20 taken first');
    await refused('then one', eli, allFirst, { hours: 1, itemOption: 'each', expect_c: hc(300) }, { status: 409, code: 'units_gone', unitsLeft: 0 });
    const atOnce = await panels('Panels, at once');
    const both = await Promise.all([take(fay, atOnce, 20, 'lot', hc(5500)), take(eli, atOnce, 1, 'each', hc(300))]);
    const lotWon = both[0].status === 200;
    const consistent = lotWon
        ? both[1].status === 409 && both[1].body?.code === 'units_gone' && listing(atOnce).units_left === 0
        : both[1].status === 200 && both[0].status === 409 && both[0].body?.code === 'lot_gone' && listing(atOnce).units_left === 19;
    assert(consistent && dealsOn(atOnce) === 1, `all against one at once: whichever commits first, and the other is told why (${both.map(brief).join(' | ')})`);
    conserved('all against one');

    const tap = await panels('Panels, double tap');
    const fayTap = bal(fay.pk);
    const taps = await Promise.all([take(fay, tap, 2, 'each', hc(600)), take(fay, tap, 2, 'each', hc(600))]);
    const first = taps.find(r => r.status === 200);
    const again = taps.find(r => r.status !== 200);
    assert(!!first && again?.status === 409 && again.body?.code === 'deal_open' && again.body?.transactionId === first.body.transaction.id
        && listing(tap).units_left === 18 && dealsOn(tap) === 1 && bal(fay.pk) === fayTap - hc(600),
        `a double tap: one deal, one reservation, the second answered with the first deal's id (${taps.map(brief).join(' | ')})`);
    const retry = await take(fay, tap, 2, 'each', hc(600));
    assert(retry.status === 409 && retry.body?.code === 'deal_open' && listing(tap).units_left === 18, 'and a retry after a lost answer is the same');

    // The guarded write is the authority: called on a row that moved since it was read, it changes nothing and says why.
    const guard = await panels('Panels, the guarded write');
    const reset = () => db.prepare(`UPDATE posts SET status = 'active', active = 1, price_type = 'each', price_c = ?, units_left = 20, lot_units = 20, lot_price_c = ?
        WHERE id = ?`).run(hc(300), hc(5500), guard);
    const each3: ItemTakeUp = { option: 'each', n: 3, amount_c: hc(900) };
    const all20: ItemTakeUp = { option: 'lot', n: 20, amount_c: hc(5500) };
    const reserve = (take: ItemTakeUp, moved: string) => {
        reset();
        if (moved) db.prepare(`UPDATE posts SET ${moved} WHERE id = ?`).run(guard);
        const before = JSON.stringify(listing(guard));
        try {
            db.transaction(() => reserveUnits(guard, hc(300), take, new Date().toISOString()))();
            return { ok: true as const, units: listing(guard).units_left };
        } catch (e: any) {
            return { ok: false as const, code: e?.code as string, unitsLeft: e?.unitsLeft as number | undefined, same: JSON.stringify(listing(guard)) === before };
        }
    };
    for (const [moved, take, code, why, unitsLeft] of [
        ['units_left = 2', each3, 'units_gone', 'units_left >= ? (the CHECK would throw in its place)', 2],
        ['price_c = 35000', each3, 'price_changed', 'price_c = ? (3 would be held at 300 under a price of 350)', undefined],
        ["status = 'paused'", each3, 'price_changed', "status = 'active'", undefined],
        ['active = 0', each3, 'price_changed', 'active = 1', undefined],
        ["price_type = 'fixed'", each3, 'price_changed', "price_type = 'each'", undefined],
        ['units_left = 19', all20, 'lot_gone', 'units_left = ? (5,500 for 19)', undefined],
        ['lot_units = 18', all20, 'lot_gone', 'lot_units = ? (20 at the price set for 18)', undefined],
        ['lot_price_c = 500000', all20, 'price_changed', 'lot_price_c = ? (a price for all the buyer never saw)', undefined],
        ["status = 'paused'", all20, 'price_changed', "status = 'active' (all of them)", undefined],
    ] as const) {
        const r = reserve(take, moved);
        assert(!r.ok && r.code === code && r.same && (unitsLeft === undefined || r.unitsLeft === unitsLeft),
            `the write refuses a row whose ${moved.split(' = ')[0]} moved (${take.option}): ${code}, nothing changed (red if the WHERE loses ${why}) (${JSON.stringify(r)})`);
    }
    const fits = reserve(each3, '');
    const fitsAll = reserve(all20, '');
    assert(fits.ok && fits.units === 17 && fitsAll.ok && fitsAll.units === 0, 'and on the row as it was read, it takes 3 (17 left), or all 20 (0 left)');
    reset();

    // ── 8. The buyer's figures ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 8. The buyer\'s figures');
    const figures = await panels('Panels, the buyer\'s figures');
    await refused('a total other than 3 × 300', dana, figures, { hours: 3, itemOption: 'each', expect_c: hc(899) }, { status: 409, code: 'price_changed' });
    await refused('the total as text', dana, figures, { hours: 3, itemOption: 'each', expect_c: '90000' }, { status: 409, code: 'price_changed' });
    await refused('no total', dana, figures, { hours: 3, itemOption: 'each' }, { status: 409, code: 'price_changed' });
    await refused('no way given (an app from before)', dana, figures, { hours: 3, expect_c: hc(900) }, { status: 409, code: 'price_changed' });
    await refused('the old shape: hours alone', dana, figures, { hours: 3 }, { status: 409, code: 'price_changed' });
    await refused('a way that is not one', dana, figures, { hours: 3, itemOption: 'some', expect_c: hc(900) }, { status: 409, code: 'price_changed' });
    // Whole numbers only at the door, never rounded: 2.5, 0, −1, "3", 10,000, Infinity (null in JSON), text, a list, true.
    for (const bad of [2.5, 0, -1, '3', 10_000, null, 'abc', [3], true]) {
        await refused(`a count of ${JSON.stringify(bad)}`, dana, figures, { hours: bad, itemOption: 'each', expect_c: hc(900) }, { status: 400, code: 'count_refused' });
    }
    await refused('21 of 20', dana, figures, { hours: 21, itemOption: 'each', expect_c: hc(6300) }, { status: 409, code: 'units_gone', unitsLeft: 20 });
    await refused('all 20 at another price', dana, figures, { hours: 20, itemOption: 'lot', expect_c: hc(6000) }, { status: 409, code: 'price_changed' });
    await refused('all of them as 19', dana, figures, { hours: 19, itemOption: 'lot', expect_c: hc(5500) }, { status: 409, code: 'lot_gone' });
    const relot = await edit(rob, figures, { lot: { price_c: hc(5000) }, unitsLeft: 20, unitsLeftWas: 20 });
    assert(relot.status === 200 && listing(figures).lot_price_c === hc(5000), 'Rob changes the price for all to 5,000 while Dana looks');
    await refused('all 20 at the 5,500 Dana saw', dana, figures, { hours: 20, itemOption: 'lot', expect_c: hc(5500) }, { status: 409, code: 'price_changed' });
    const gusBefore = bal(gus.pk);
    const cant = await take(gus, figures, 20, 'lot', hc(5000));
    assert(cant.status === 400 && /Insufficient balance/.test(cant.body?.error ?? '') && bal(gus.pk) === gusBefore && listing(figures).units_left === 20 && dealsOn(figures) === 0,
        `a buyer who can't afford it is refused before anything is held, the count as it was (${brief(cant)})`);
    conserved('the refused take-ups');

    // ── 9. Doors refused ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 9. Doors refused');
    const asked = await post(dana, '/api/marketplace/posts/request', { postId: figures, buyerPublicKey: dana.pk, hours: 3 });
    // Red if requestPost lets a request wait unfunded against the count.
    assert(asked.status === 409 && asked.body?.code === 'each_accept_only' && asked.body?.error === says('each_accept_only') && dealsOn(figures) === 0,
        `a request is refused: it is taken up in one step (${brief(asked)})`);
    // A request somehow waiting (nothing makes one: written by hand): its approval holds nothing.
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, hours, status, created_at)
                VALUES ('asked-by-hand', ?, ?, ?, ?, 3, 'requested', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(figures, eli.pk, rob.pk, hc(900));
    const eliAsk = bal(eli.pk);
    const approved = await post(rob, '/api/marketplace/transactions/approve', { transactionId: 'asked-by-hand', authorPublicKey: rob.pk });
    assert(approved.status === 409 && approved.body?.code === 'each_accept_only' && deal('asked-by-hand').status === 'requested' && bal(eli.pk) === eliAsk && listing(figures).units_left === 20,
        `its approval is refused, nothing held (red if approvePostRequest loses its check) (${brief(approved)})`);
    db.prepare("UPDATE marketplace_transactions SET status = 'rejected' WHERE id = 'asked-by-hand'").run();
    const startsAt = new Date().toISOString();
    const payload = standingAuthorisationText({
        host: HOST, standingId: crypto.randomUUID(), listingId: figures, payee: rob.pk, beansPerPeriod_c: hc(300), unit: 'week', maxPeriods: 4, startsAt,
        nonce: crypto.randomBytes(12).toString('hex'),
    });
    const signature = crypto.sign(null, Buffer.concat([Buffer.from([0xff]), Buffer.from(payload, 'utf-8')]), dana.privateKey).toString('base64');
    const figuresDeals = dealsOn(figures);
    const standingEach = await post(dana, '/api/marketplace/posts/accept', { postId: figures, buyerPublicKey: dana.pk, standing: { authorisation: { payload, signature }, periods: 4, startsAt } });
    assert(standingEach.status === 400 && standingEach.body?.code === 'standing_auth' && dealsOn(figures) === figuresDeals && listing(figures).units_left === 20,
        `a standing body on a listing priced for each one is refused (checkStandingStart: not per week or month) (${brief(standingEach)})`);
    const load = await made(rob, { title: 'Trailer load', priceType: 'fixed', price_c: hc(40) });
    await refused('a take-up for each one of a Total listing', dana, load, { hours: 1, itemOption: 'each', expect_c: hc(40) }, { status: 409, code: 'price_changed' });
    assert(listing(load).status === 'active', 'and the Total listing stays on the board');
    const copyOf = await made(rob, { title: 'A copy, by hand', priceType: 'fixed', price_c: 0 });
    db.prepare("UPDATE posts SET shown_from_host = 'home.example' WHERE id = ?").run(copyOf);
    const onCopy = await take(dana, copyOf, 1, 'each', 0);
    assert(onCopy.status === 409 && onCopy.body?.code === 'listing_copy' && dealsOn(copyOf) === 0, `of a copy: the copy's own refusal (${brief(onCopy)})`);
    const need = await post(rob, '/api/marketplace/posts', { type: 'need', title: 'Seedlings wanted', category: 'garden', description: '', authorPublicKey: rob.pk, photos: TEST_PHOTOS, price_c: hc(2) });
    const onNeed = await take(dana, need.body.post.id, 1, 'each', hc(2));
    assert(onNeed.status === 400 && /Only Offers can be 1-step accepted/.test(onNeed.body?.error ?? '') && dealsOn(need.body.post.id) === 0, `of a Need: the Need's own refusal (${brief(onNeed)})`);
    const ladder = await made(rob, { title: 'Ladder', priceType: 'daily', price_c: hc(5), lendable: true, lendMaxDays: 3 });
    const onLoan = await take(dana, ladder, 1, 'each', hc(5));
    assert(onLoan.status === 409 && onLoan.body?.code === 'lend_ask_first' && dealsOn(ladder) === 0, `of a loan: the loan's own refusal (${brief(onLoan)})`);
    conserved('the refused doors');

    // ── 10. The paths that don't change ─────────────────────────────────────────────────────────────────────────────
    console.log('\n— 10. The paths that don\'t change');
    const firewood = await made(rob, { title: 'Firewood', priceType: 'fixed', price_c: hc(30) });
    await refused('a Total taken up with a total it does not come to', dana, firewood, { expect_c: hc(25) }, { status: 409, code: 'price_changed' });
    const fw = await post(dana, '/api/marketplace/posts/accept', { postId: firewood, buyerPublicKey: dana.pk, expect_c: hc(30) });
    assert(fw.status === 200 && listing(firewood).status === 'pending' && deal(fw.body.transaction.id).item_option === null && deal(fw.body.transaction.id).amount_c === hc(30),
        `a Total, with the total it showed: one deal, off the board under it, as before (${brief(fw)})`);
    await release(dana, fw.body.transaction.id);
    assert(listing(firewood).status === 'completed' && listing(firewood).units_left === null, 'released: completed, as a one-off sale always was');
    const kindling = await made(rob, { title: 'Kindling', priceType: 'fixed', price_c: hc(8) });
    const kd = await post(eli, '/api/marketplace/posts/accept', { postId: kindling, buyerPublicKey: eli.pk, itemOption: null, expect_c: null });
    // Red if a JSON null for "no way, no total" reads as a way given: the Total would be refused price_changed.
    assert(kd.status === 200 && deal(kd.body.transaction.id).amount_c === hc(8) && deal(kd.body.transaction.id).item_option === null,
        `a Total taken up with null for the way and the total: null is none, taken up as before (${brief(kd)})`);
    const garden = await made(rob, { title: 'Garden help', priceType: 'hourly', price_c: hc(20) });
    const gh = await post(eli, '/api/marketplace/posts/accept', { postId: garden, buyerPublicKey: eli.pk, hours: 2 });
    const robG = bal(rob.pk);
    const ghDone = await release(eli, gh.body.transaction.id, 3);
    assert(gh.status === 200 && ghDone.status === 200 && deal(gh.body.transaction.id).hours === 3 && deal(gh.body.transaction.id).amount_c === hc(60)
        && bal(rob.pk) === robG + hc(60) - feeOf(hc(60)) && listing(garden).status === 'completed',
        `an hourly deal booked for 2 and confirmed for 3 is re-rated to 60, as before (${brief(ghDone)})`);
    const eggs = await made(rob, { title: 'Eggs', priceType: 'fixed', price_c: hc(5), repeatable: true });
    const eg = await post(fay, '/api/marketplace/posts/accept', { postId: eggs, buyerPublicKey: fay.pk });
    assert(eg.status === 200 && listing(eggs).status === 'active', 'a Repeatable Offer stays on the board under its deal');
    await release(fay, eg.body.transaction.id);
    assert(listing(eggs).status === 'active' && listing(eggs).units_left === null, 'and after it, as before');
    const trailer = await made(rob, { title: 'Trailer', priceType: 'daily', price_c: hc(5), lendable: true, lendMaxDays: 3 });
    const borrow = await post(dana, '/api/marketplace/posts/request', { postId: trailer, buyerPublicKey: dana.pk, hours: 2 });
    const lent = await post(rob, '/api/marketplace/transactions/approve', { transactionId: borrow.body?.transaction?.id, authorPublicKey: rob.pk });
    assert(borrow.status === 200 && lent.status === 200 && listing(trailer).status === 'pending', `a loan is asked for and lent, out while it is out (${brief(lent)})`);
    await release(dana, borrow.body.transaction.id);
    assert(listing(trailer).status === 'active', 'and back on the board when it comes back');
    const veg = await made(rob, { title: 'Veg box', priceType: 'weekly', price_c: hc(15), repeatable: true });
    const vegAt = new Date().toISOString();
    const vegId = crypto.randomUUID();
    const vegText = standingAuthorisationText({
        host: HOST, standingId: vegId, listingId: veg, payee: rob.pk, beansPerPeriod_c: hc(15), unit: 'week', maxPeriods: 4, startsAt: vegAt, nonce: crypto.randomBytes(12).toString('hex'),
    });
    const vegSig = crypto.sign(null, Buffer.concat([Buffer.from([0xff]), Buffer.from(vegText, 'utf-8')]), dana.privateKey).toString('base64');
    const robV = bal(rob.pk);
    const standing = await post(dana, '/api/marketplace/posts/accept', { postId: veg, buyerPublicKey: dana.pk, standing: { authorisation: { payload: vegText, signature: vegSig }, periods: 4, startsAt: vegAt } });
    const sd = db.prepare('SELECT phase, periods_done FROM standing_deals WHERE id = ?').get(vegId) as { phase: string; periods_done: number } | undefined;
    assert(standing.status === 200 && sd?.phase === 'paid' && sd.periods_done === 1 && bal(rob.pk) === robV + hc(15) - feeOf(hc(15)),
        `a standing deal starts and pays its first week, as before (${brief(standing)})`);
    conserved('the paths that don\'t change');

    // ── 11. The count never blocks a refund ─────────────────────────────────────────────────────────────────────────
    console.log('\n— 11. The count never blocks a refund');
    const nails = await made(rob, { title: 'Nails', priceType: 'each', price_c: hc(1), unitsLeft: 9999 });
    const nl = await take(dana, nails, 5, 'each', hc(5));
    const topped = await edit(rob, nails, { unitsLeft: 9999, unitsLeftWas: 9994 });
    assert(nl.status === 200 && topped.status === 200 && listing(nails).units_left === 9999, 'Dana takes 5 of 9,999, and Rob counts 9,999 left again');
    const danaN = bal(dana.pk);
    const nlBack = await cancel(dana, nl.body.transaction.id);
    // Red if settleItemDeal's MIN is dropped: the count's CHECK refuses the cancel and the 5 Beans stay held.
    assert(nlBack.status === 200 && deal(nl.body.transaction.id).status === 'cancelled' && bal(dana.pk) === danaN + hc(5) && listing(nails).units_left === 9999,
        `the cancel refunds and the count stays at the most it can hold (${brief(nlBack)})`);
    conserved('a cancel at the most');

    // ── 12. An enterprise buying from its own keeper ────────────────────────────────────────────────────────────────
    console.log('\n— 12. An enterprise buying from its own keeper');
    const kay = makeMember('Kay', 100);   // a keeper of Crate Co, who sells crates
    const kim = makeMember('Kim', 100);   // another keeper, who signs for Crate Co
    const { publicKey: crateCo } = createTreasury('Crate Co', 'data:image/png;base64,iVBORw0KGgo=');
    for (const k of [kay, kim]) {
        db.prepare(`INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, 'keeper', 'admin')`).run(crateCo, k.pk);
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.pk);
    }
    createPost('offer', 'general', 'Crate Co deliveries', 'Deliveries', hc(5), 'fixed', crateCo, undefined, undefined, undefined, true);
    const crates = await made(kay, { title: 'Hand-built crates', priceType: 'each', price_c: hc(10), unitsLeft: 2 });
    const claims = () => (db.prepare('SELECT COUNT(*) AS n FROM deferred_wage_claims WHERE enterprise_pubkey = ? AND post_id = ?').get(crateCo, crates) as { n: number }).n;
    let tooMany = '';
    try { acceptPost(crates, crateCo, undefined, { authSigner: kim.pk, item: { n: 3, option: 'each', expect_c: hc(30) } }); } catch (e: any) { tooMany = `${e?.code}:${e?.unitsLeft}`; }
    // Red if the stock is asked after assertHoldFunded: Crate Co has no earned surplus, so that check refuses first and
    // records a wage claim of 30 Beans, paid later with no further step, for crates that were never there.
    assert(tooMany === 'units_gone:2' && claims() === 0 && listing(crates).units_left === 2 && dealsOn(crates) === 0,
        `Crate Co asks for 3 of Kay's 2 crates: told 2 are left, and no wage claim is recorded (${tooMany}, claims ${claims()})`);

    // ── 13. A standby copy ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 13. A standby copy');
    const copied = await panels('Panels, the standby');
    const held = await take(eli, copied, 4, 'each', hc(1200));
    const heldId = held.body?.transaction?.id as string;
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4043/p2p/${nodeId}`);
    const sync = await exportSyncState(nodeId);
    const sentPost = (sync.posts ?? []).find((p: any) => p.id === copied) as any;
    const sentDeal = (sync.marketplaceTransactions ?? []).find((t: any) => t.id === heldId) as any;
    assert(held.status === 200 && sentPost?.unitsLeft === 16 && sentDeal?.itemOption === 'each' && sentDeal?.status === 'pending' && sentDeal?.amount_c === hc(1200),
        `the copy carries the count the hold moved and the hold's row, together (${JSON.stringify({ unitsLeft: sentPost?.unitsLeft, deal: sentDeal?.itemOption })})`);
    // The standby as it was before them: the count 20, the deal not yet held as per-item.
    db.prepare("UPDATE posts SET units_left = 20, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(copied);
    db.prepare("UPDATE marketplace_transactions SET item_option = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(heldId);
    setNodeRole('backup');
    await importRemoteState(sync as any);
    const after = listing(copied);
    assert(after.units_left === 16 && deal(heldId).item_option === 'each' && deal(heldId).hours === 4,
        `a standby that takes over has both, as the main server held them (${JSON.stringify(after)} ${JSON.stringify(deal(heldId))})`);
    setNodeRole('primary');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && process.exitCode !== 1 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
