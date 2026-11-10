/**
 * A listing edit can't poison a balance (review FABLE-sec-input F1/F2/F6, 2026-10-01, measured on the real engine).
 *
 * The finding (in float Beans, before whole hundredths): a seller edited their own offer to `{"credits": "abc"}` through
 * POST /api/marketplace/posts/update. It was
 * accepted, SQLite stored the text in the REAL column, and the first buyer approved (request → approve → complete) or
 * one-step accepted had their balance set to NaN in memory and NULL on disk. Every `<` guard on the money path reads NaN
 * as "fine", and the ledger total silently moved (0 → -120 with 5 NULL rows in the probe).
 *
 *   1. The reviewer's sequence through the real edit route (the price is now `price_c`, whole hundredths): every bad edit
 *      is a 400, nothing is written, and the deals that follow move real Beans — every balance stays whole hundredths
 *      and the ledger total does not move.
 *   2. Each field an edit can name, sent with a type or value no listing may hold, is refused and nothing is written; so
 *      is a price that is not whole hundredths, and the old `credits` key.
 *   3. The money primitives themselves (core LedgerManager, state-engine transfer / moveToCommons / payFromCommons, the
 *      escrow doors) refuse NaN, Infinity, negative, string and fractional amounts and quantities, whatever a caller
 *      hands them.
 *   4. The conservation check flags a NULL, text, non-finite or fractional balance (anything but whole hundredths).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-listing-edit-numbers.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { runConservationCheck, setMemberPhoto } from '@beanpool/engine';
import { db } from './db/db.js';
import { LedgerManager, setCommonsBalance } from '@beanpool/core';
import { wrapCreatePost } from './post-test-helper.js';
import {
    initStateEngine, createPost as rawCreatePost, requestPost, approvePostRequest, completePostTransaction, acceptPost, transfer, getBalance,
    moveToCommons, payFromCommons, getCommonsBalanceExact, cancelPostTransaction, rejectPostRequest, removePost, adminDeletePost,
} from './state-engine.js';
const createPost = wrapCreatePost(rawCreatePost);
import { createMarketplaceRoutes } from './routes/marketplace.js';

let run = 0, passed = 0;
/** Beans to whole hundredths, for the story's figures (exact: each is whole hundredths). */
const hc = (beans: number) => Math.round(beans * 100);
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeMember(callsign: string): string {
    const pk = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign);
    setMemberPhoto(db, pk, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    return pk;
}

async function dispatch(router: any, method: string, path: string, ctx: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route for ${method} ${path}`);
    await layer.stack[layer.stack.length - 1](ctx);
    return ctx;
}

/**
 * Every balance row: the total SQLite sums, how many are NULL or not whole hundredths (text, a float, a non-finite
 * number), and the in-memory balances, each of which must be whole hundredths too.
 */
function ledgerState(keys: string[]) {
    const total = (db.prepare('SELECT COALESCE(SUM(balance_c), 0) AS s FROM accounts').get() as any).s as number;
    const bad = (db.prepare(`SELECT COUNT(*) AS c FROM accounts
        WHERE balance_c IS NULL OR typeof(balance_c) != 'integer'`).get() as any).c as number;
    const memory = keys.map((k) => getBalance(k).balance_c);
    return { total, bad, memory, memoryWhole: memory.every((b) => typeof b === 'number' && Number.isSafeInteger(b)) };
}

function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
    try { return { ok: true, value: fn() }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}

async function main() {
    console.log('Running listing-edit number checks...\n');
    initStateEngine();
    const router = createMarketplaceRoutes({
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        enforceReadAuth: false,
    } as any);

    const seller = makeMember('seller');
    const buyer = makeMember('buyer');
    const third = makeMember('third');
    const everyone = [seller, buyer, third];
    for (const pk of everyone) transfer('genesis', pk, hc(100), 'seed', 'direct', true);
    // A member must list an offer before they can ask for one (CONTRIBUTION_REQUIRED).
    createPost('offer', 'services', 'Buyer mends', 'Mending', hc(5), 'fixed', buyer);
    createPost('offer', 'services', 'Third digs', 'Digging', hc(5), 'fixed', third);

    const edit = async (actor: string, id: string, updates: Record<string, unknown>) =>
        dispatch(router, 'POST', '/api/marketplace/posts/update', { requestBody: { id, authorPublicKey: actor, ...updates }, state: { actor } });
    const row = (id: string) => db.prepare('SELECT title, description, category, price_c, typeof(price_c) AS t, price_type, lat, lng FROM posts WHERE id = ?').get(id) as any;

    // ── 1. The reviewer's sequence ──────────────────────────────────────────────────────────────────
    console.log('— 1. the reviewer\'s sequence: edit the price to "abc", then request → approve → complete, and acceptPost —');
    const before = ledgerState(everyone);
    check(before.bad === 0 && before.memoryWhole, `the ledger starts with every balance whole hundredths (${JSON.stringify(before)})`);

    const offer = createPost('offer', 'food', 'Carrots', 'Organic carrots', hc(10), 'fixed', seller)!;
    const abc = await edit(seller, offer.id, { price_c: 'abc' });
    check(abc.status === 400, `an edit to price_c "abc" is refused with 400 (got ${abc.status ?? 200}: ${JSON.stringify(abc.body)})`);
    const afterAbc = row(offer.id);
    check(afterAbc.price_c === hc(10) && afterAbc.t === 'integer', `and nothing is written: the listing still asks 10 Beans as whole hundredths (${JSON.stringify(afterAbc)})`);

    const req = attempt(() => requestPost(offer.id, buyer));
    const appr = req.ok ? attempt(() => approvePostRequest(req.value.id, seller)) : req;
    const done = req.ok ? attempt(() => completePostTransaction(req.value.id, buyer)) : req;
    check(req.ok && appr.ok && done.ok, `the buyer's request, the seller's approval and the completion go through at the real price (${JSON.stringify([req, appr, done].map((r) => r.ok ? 'ok' : r.error))})`);
    const afterDeal = ledgerState(everyone);
    check(afterDeal.bad === 0 && afterDeal.memoryWhole, `every balance is whole hundredths, in memory and on disk (${JSON.stringify(afterDeal)})`);
    check(afterDeal.total === before.total, `and the ledger total did not move (${before.total} → ${afterDeal.total})`);
    check(getBalance(buyer).balance_c === hc(90), `the buyer paid the real 10 Beans (${getBalance(buyer).balance_c} hundredths)`);

    // The one-step buy, on a second listing a seller also tried to poison.
    const offer2 = createPost('offer', 'food', 'Beans', 'Broad beans', hc(4), 'fixed', seller)!;
    const abc2 = await edit(seller, offer2.id, { price_c: 'abc' });
    check(abc2.status === 400, `an edit of a second listing to price_c "abc" is refused with 400 (got ${abc2.status ?? 200})`);
    const acc = attempt(() => acceptPost(offer2.id, third));
    check(acc.ok, `a third member's one-step accept goes through at the real price (${acc.ok ? 'ok' : acc.error})`);
    const afterAccept = ledgerState(everyone);
    check(afterAccept.bad === 0 && afterAccept.memoryWhole, `every balance is still whole hundredths (${JSON.stringify(afterAccept)})`);
    check(afterAccept.total === before.total, `and the ledger total still did not move (${before.total} → ${afterAccept.total})`);

    // ── 2. Every field an edit can name ─────────────────────────────────────────────────────────────
    console.log('\n— 2. each field an edit names, with a value no listing may hold, is refused and nothing is written —');
    const target = createPost('offer', 'food', 'Plums', 'Plums from the tree', hc(3), 'fixed', seller, -28.5, 153.5)!;
    const pristine = row(target.id);
    const bad: [string, Record<string, unknown>][] = [
        ['price_c "abc"', { price_c: 'abc' }],
        ['price_c "500" (a string)', { price_c: String(hc(5)) }],
        ['price_c -5 Beans', { price_c: hc(-5) }],
        ['price_c Infinity', { price_c: Infinity }],
        ['price_c NaN', { price_c: NaN }],
        ['price_c null', { price_c: null }],
        ['price_c 1e12 Beans', { price_c: hc(1e12) }],
        ['price_c 450.5 (not whole hundredths)', { price_c: 450.5 }],
        ['the old credits 5 (an app from before whole hundredths)', { credits: 5 }],
        ['title 123 (a number)', { title: 123 }],
        ['title "" (empty)', { title: '   ' }],
        ['description 42 (a number)', { description: 42 }],
        ['category 7 (a number)', { category: 7 }],
        ['category "" (empty)', { category: '' }],
        ['priceType "yearly"', { priceType: 'yearly' }],
        ['priceType 1', { priceType: 1 }],
        ['lat "x"', { lat: 'x' }],
        ['lat 91', { lat: 91 }],
        ['lat Infinity', { lat: Infinity }],
        ['lng -181', { lng: -181 }],
        ['lng "153"', { lng: '153' }],
        ['hours Infinity', { hours: Infinity }],
        ['hours "2"', { hours: '2' }],
    ];
    for (const [label, updates] of bad) {
        const r = await edit(seller, target.id, updates);
        const now = row(target.id);
        check(r.status === 400 && JSON.stringify(now) === JSON.stringify(pristine),
            `an edit with ${label} is refused with 400 and the listing is unchanged (got ${r.status ?? 200}: ${JSON.stringify(r.body)})`);
    }
    // And the edits a real app sends still land.
    const good = await edit(seller, target.id, { title: 'Ripe plums', description: '', category: 'food', price_c: hc(4.5), priceType: 'hourly', lat: -28.6, lng: 153.4 });
    const landed = row(target.id);
    check(good.status === undefined && good.body?.success === true && landed.title === 'Ripe plums' && landed.price_c === hc(4.5) && landed.price_type === 'hourly',
        `a well-formed edit still lands (${good.status ?? 200}: ${JSON.stringify(landed)})`);
    const cleared = await edit(seller, target.id, { lat: null, lng: null });
    check(cleared.body?.success === true && row(target.id).lat === null, `and an edit may clear the pin (${cleared.status ?? 200})`);

    // ── 3. The money primitives, whatever a caller hands them ───────────────────────────────────────
    console.log('\n— 3. the ledger primitives refuse NaN, Infinity, negative, string and fractional amounts —');
    const junk: [string, unknown][] = [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['-5 Beans', hc(-5)], ['"500" (a string)', '500'], ['"abc"', 'abc'],
        ['0.5 (a fraction of a hundredth)', 0.5]];
    const commonsAtStart = getCommonsBalanceExact();

    // core LedgerManager, on its own accounts.
    for (const [label, amount] of junk) {
        const lm = new LedgerManager([
            { id: 'a', balance_c: hc(50), lastDemurrageEpoch: 0 },
            { id: 'b', balance_c: 0, lastDemurrageEpoch: 0 },
            { id: 'escrow_t', balance_c: hc(50), lastDemurrageEpoch: 0 },
        ]);
        const pot = getCommonsBalanceExact();
        const t = lm.transfer('a', 'b', amount as number, hc(-100), false);
        const m = lm.moveToCommons('escrow_t', amount as number, -Infinity);
        const d = lm.deductFromCommons(amount as number);
        const bal = lm.getAllAccounts().map((x) => x.balance_c);
        check(!t.ok && t.fee === 0 && !m && !d && JSON.stringify(bal) === JSON.stringify([hc(50), 0, hc(50)]) && getCommonsBalanceExact() === pot,
            `core: transfer, moveToCommons and deductFromCommons refuse ${label}, and nothing moves (${JSON.stringify({ t, m, d, bal, pot: getCommonsBalanceExact() })})`);
        setCommonsBalance(commonsAtStart);
    }
    {
        // An account already holding a broken balance moves nothing, and its demurrage can't spread NaN to the pot.
        const lm = new LedgerManager([
            { id: 'a', balance_c: NaN, lastDemurrageEpoch: 0 },
            { id: 'n', balance_c: null as unknown as number, lastDemurrageEpoch: 0 },
            { id: 'b', balance_c: hc(10), lastDemurrageEpoch: 0 },
        ]);
        const pot = getCommonsBalanceExact();
        const fromNaN = lm.transfer('a', 'b', hc(1), hc(-100), true);
        const toNaN = lm.transfer('b', 'a', hc(1), hc(-100), true);
        const fromNull = lm.transfer('n', 'b', hc(1), hc(-100), true);
        check(!fromNaN.ok && !toNaN.ok && !fromNull.ok && lm.getAccount('b').balance_c === hc(10) && Number.isFinite(getCommonsBalanceExact()) && getCommonsBalanceExact() === pot,
            `core: an account holding NaN or NULL sends and receives nothing, and reading it leaves the pot alone (${JSON.stringify({ fromNaN, toNaN, fromNull, b: lm.getAccount('b').balance_c, pot: getCommonsBalanceExact() })})`);
        setCommonsBalance(commonsAtStart);
    }

    // The server's own primitives, on the live ledger.
    for (const [label, amount] of junk) {
        const start = ledgerState(everyone);
        const pot = getCommonsBalanceExact();
        const t = attempt(() => transfer('genesis', buyer, amount as number, 'junk', 'direct', true));
        const m = attempt(() => moveToCommons(`escrow_nonesuch`, amount as number, 'junk'));
        const p = attempt(() => payFromCommons(buyer, amount as number, 'junk', { allowDeficit: true }));
        const end = ledgerState(everyone);
        check(t.ok && t.value === null && m.ok && m.value === null && p.ok && p.value === null
            && JSON.stringify(end) === JSON.stringify(start) && getCommonsBalanceExact() === pot,
            `server: transfer, moveToCommons and payFromCommons refuse ${label}, and nothing moves (${JSON.stringify({ t, m, p, end, pot: getCommonsBalanceExact() })})`);
        setCommonsBalance(commonsAtStart);
    }

    // The escrow doors: a quantity of Infinity (F6), and a listing row already holding text (poisoned before this fix).
    const hourly = createPost('offer', 'services', 'Weeding', 'By the hour', hc(2), 'hourly', seller)!;
    const zeroHourly = createPost('offer', 'services', 'Free help', 'By the hour', 0, 'hourly', seller)!;
    const s3 = ledgerState(everyone);
    const infReq = attempt(() => requestPost(zeroHourly.id, buyer, Infinity));
    const infAcc = attempt(() => acceptPost(zeroHourly.id, third, Infinity));
    // A quantity given and out of range gets the quantity's own words, with its range (#1445 review); none given, "valid quantity".
    const asQuantity = /valid quantity|quantity must be a number from 0\.01 to 10000/;
    check(!infReq.ok && asQuantity.test(infReq.error) && !infAcc.ok && asQuantity.test(infAcc.error),
        `a request or one-step accept for Infinity hours is refused as a quantity (${JSON.stringify([infReq, infAcc])})`);
    const hReq = attempt(() => requestPost(hourly.id, buyer, 2));
    const hAppr = hReq.ok ? attempt(() => approvePostRequest(hReq.value.id, seller)) : hReq;
    const hDone = hReq.ok ? attempt(() => completePostTransaction(hReq.value.id, buyer, Infinity)) : hReq;
    check(hAppr.ok && !hDone.ok && /final quantity/.test(hDone.error),
        `a completion for a final Infinity hours is refused, not ignored (${JSON.stringify([hAppr.ok ? 'ok' : hAppr.error, hDone.ok ? 'completed' : hDone.error])})`);
    const hFinish = hReq.ok ? attempt(() => completePostTransaction(hReq.value.id, buyer, 2)) : hReq;
    check(hFinish.ok, `and the same deal completes for a real 2 hours (${hFinish.ok ? 'ok' : hFinish.error})`);

    const poisoned = createPost('offer', 'food', 'Leeks', 'Leeks', hc(6), 'fixed', seller, undefined, undefined, undefined, true)!;
    db.prepare(`UPDATE posts SET price_c = 'abc' WHERE id = ?`).run(poisoned.id);
    const pReq = attempt(() => requestPost(poisoned.id, buyer));
    const pAcc = attempt(() => acceptPost(poisoned.id, third));
    check(!pReq.ok && /no valid price/.test(pReq.error) && !pAcc.ok && /no valid price/.test(pAcc.error),
        `a listing row already holding "abc" as its price can't be requested or accepted (${JSON.stringify([pReq.ok ? 'requested' : pReq.error, pAcc.ok ? 'accepted' : pAcc.error])})`);

    // A deal ROW already holding text (struck before this fix): the listing edit can't mend it, since an open deal keeps
    // the price it was struck at (#1374), so each refusal names what does clear it, and that path is measured here.
    const txStatus = (id: string) => (db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(id) as any)?.status;
    const reqListing = createPost('offer', 'food', 'Chard', 'Chard', hc(3), 'fixed', seller)!;
    const rq = requestPost(reqListing.id, buyer);
    db.prepare(`UPDATE marketplace_transactions SET amount_c = 'abc' WHERE id = ?`).run(rq.id);
    const rqAppr = attempt(() => approvePostRequest(rq.id, seller));
    check(!rqAppr.ok && /can't be approved\. Decline it, or remove the listing/.test(rqAppr.error),
        `a request row holding "abc" can't be approved, and the refusal says to decline it (${rqAppr.ok ? 'approved' : rqAppr.error})`);
    const rqRej = attempt(() => rejectPostRequest(rq.id, seller));
    check(rqRej.ok && txStatus(rq.id) === 'rejected', `and declining it clears it (${rqRej.ok ? txStatus(rq.id) : rqRej.error})`);

    const dealListing = createPost('offer', 'food', 'Kale', 'Kale', hc(6), 'fixed', seller)!;
    const buyerBeforeKale = getBalance(buyer).balance_c;
    const dq = requestPost(dealListing.id, buyer);
    approvePostRequest(dq.id, seller);
    db.prepare(`UPDATE marketplace_transactions SET amount_c = 'abc' WHERE id = ?`).run(dq.id);
    const dCancelBuyer = attempt(() => cancelPostTransaction(dq.id, buyer));
    const dCancelSeller = attempt(() => cancelPostTransaction(dq.id, seller));
    const dDone = attempt(() => completePostTransaction(dq.id, buyer));
    const rowMsg = /can't be completed, cancelled or disputed\. Ask a moderator to remove the listing/;
    check(!dCancelBuyer.ok && rowMsg.test(dCancelBuyer.error) && !dCancelSeller.ok && rowMsg.test(dCancelSeller.error)
        && !dDone.ok && rowMsg.test(dDone.error) && txStatus(dq.id) === 'pending',
        `a deal in escrow holding "abc" can't be cancelled by either side or completed, and says a moderator clears it (${JSON.stringify([dCancelBuyer, dCancelSeller, dDone].map((r) => r.ok ? 'ok' : r.error))})`);
    const dRemove = attempt(() => removePost(dealListing.id, seller));
    check(!dRemove.ok && /deal in escrow/.test(dRemove.error), `the seller can't remove a listing with that deal in escrow (${dRemove.ok ? 'removed' : dRemove.error})`);
    const dAdmin = attempt(() => adminDeletePost(dealListing.id));
    check(dAdmin.ok && dAdmin.value === true && txStatus(dq.id) === 'cancelled',
        `a moderator removing the listing closes the deal (${dAdmin.ok ? `${dAdmin.value}, ${txStatus(dq.id)}` : dAdmin.error})`);
    // Where the 6 Beans end up (sync check F1, 2026-10-02): Math.min('abc', 6) is NaN, so the removal used to refund
    // nothing and leave them in the escrow of a cancelled deal, which nothing else can reach.
    const kaleEscrow = `escrow_${dq.id}`;
    const kaleEscrowRow = (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(kaleEscrow) as any)?.balance_c;
    check(getBalance(buyer).balance_c === buyerBeforeKale && getBalance(kaleEscrow).balance_c === 0 && kaleEscrowRow === 0,
        `and the buyer gets the 6 Beans its escrow held back (buyer ${buyerBeforeKale} → ${getBalance(buyer).balance_c}, escrow ${getBalance(kaleEscrow).balance_c}, row ${kaleEscrowRow})`);
    const liveAudit = runConservationCheck(db as any) as ReturnType<typeof runConservationCheck> & { badBalances?: number };
    check(liveAudit.strandedEscrows === 0 && (liveAudit.badBalances ?? 0) === 0,
        `nothing is left stranded in an escrow on the live ledger (${JSON.stringify(liveAudit)})`);

    const s3end = ledgerState(everyone);
    check(s3end.bad === 0 && s3end.memoryWhole && s3end.total === s3.total,
        `every balance is still whole hundredths and the total has not moved (${s3.total} → ${s3end.total}, ${s3end.bad} bad rows)`);

    // ── 4. The conservation check ───────────────────────────────────────────────────────────────────
    // On a table as it stood before the column was NOT NULL (an in-memory one: the live table now refuses a NULL), a
    // balance of 0 wiped to NULL or to text moved no SUM, so the check read "ok". The column holds whole hundredths, as the
    // node's does: a fraction of a hundredth is no balance either.
    console.log('\n— 4. the conservation check flags a NULL, text, infinite or fractional balance —');
    const mem = new Database(':memory:');
    mem.exec(`CREATE TABLE accounts (public_key TEXT PRIMARY KEY, balance_c INTEGER DEFAULT 0);
              CREATE TABLE node_config (key TEXT PRIMARY KEY, value TEXT);
              CREATE TABLE marketplace_transactions (id TEXT PRIMARY KEY, status TEXT);
              INSERT INTO accounts VALUES ('a', 1000), ('b', -1000), ('c', 0);`);
    const clean = runConservationCheck(mem as any);
    check(clean.ok, `a ledger summing to its baseline with every balance whole hundredths is ok (${JSON.stringify(clean)})`);
    for (const [label, value] of [['NULL (a NaN as better-sqlite3 binds it)', null], ['text', 'abc'], ['Infinity', Infinity], ['a fraction of a hundredth (0.5)', 0.5]] as [string, unknown][]) {
        mem.prepare(`UPDATE accounts SET balance_c = ? WHERE public_key = 'c'`).run(value);
        const r = runConservationCheck(mem as any) as ReturnType<typeof runConservationCheck> & { badBalances?: number };
        check(!r.ok && r.badBalances === 1, `a balance of ${label} fails the check and is counted (${JSON.stringify(r)})`);
        mem.prepare(`UPDATE accounts SET balance_c = 0 WHERE public_key = 'c'`).run();
    }
    mem.close();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Listing-edit number checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
