/**
 * Money follow-ups from the reviews of #1379 and #1374 (2026-10-02). Every request is signed and goes through the real
 * HTTPS server and its signature middleware; the ledger's conservation check runs after each money step.
 *
 *   1. A moderator removing a listing whose deal row holds an amount that isn't a number of Beans (struck before #1379)
 *      gives the buyer back what the escrow actually holds, and says so. It used to refund nothing: Math.min('abc', 6)
 *      is NaN, so the Beans stayed in an escrow nobody could reach (sync check F1).
 *   2. A completion whose payout at the deal's rate overflows says in plain words what happened and what to do, instead
 *      of "can't be completed, cancelled or disputed" about a deal that can be cancelled (sync check F2).
 *   3. A quantity that is not a finite number of units in range (Infinity, 1e400, a negative, 0, text) is refused at
 *      every door that takes one: the request, the one-step accept, and both completion routes, on a fixed deal as on an
 *      hourly one. A fixed deal used to ignore it at the request and accept, and every deal ignored a negative or text
 *      quantity at completion (sync check F3).
 *      A quantity below 0.01 of a unit (5e-324 hours) is refused at the same doors, and a deal whose booked quantity
 *      can't give a rate that round-trips pays nothing at it: 5e-324 hours rounded the rate, and a 0.4 Beans/h Offer
 *      paid 0 for 10 hours (#1445 review, BLOCKING 2).
 *   4. A take-over's audit record and journal carry the count of balances that are not a finite number, and say so,
 *      where they said "adds up" (decide N3). The Commons pot is never written as 0 when it isn't a number (decide N1).
 *   5. A pledge to an enterprise that has reached its goal, through the door both apps use, gets the plain "already
 *      reached its goal" refusal, not "has been closed" (#1374 NB).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-money-followups.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
const ADMIN_PW = 'Money-Followups-Pw-4417!';
process.env.ADMIN_PASSWORD = ADMIN_PW;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setCommonsBalance } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initAdminPassword, getLocalConfig, updateLocalConfig } from './config/local-config.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { db, createCrowdfundProject } from './db/db.js';
import {
    initStateEngine, transfer, createPost, acceptPost, requestPost, approvePostRequest, getBalance, runLedgerAudit,
    getCommonsBalanceExact, persistCommonsBalance, persistDecayAndCommons,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resumeTakeoverAtBoot, getTakeoverProgress, TAKEOVER_JOURNAL_FILE } from './services/takeover.js';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const EPOCH_NOW = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
const r4 = (n: number) => Math.round(n * 10000) / 10000;
let BASE = '';

type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

/** A member who can sign, trade (a photo, a name, an Offer listed) and pay. */
function makeMember(callsign: string, beans: number): Id {
    const id = keypair(callsign);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, callsign);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, EPOCH_NOW);
    transfer('genesis', id.pk, beans, `seed ${callsign}`, 'direct', true);
    createPost('offer', 'general', `${callsign} odd jobs`, 'Help around the place', 5, 'fixed', id.pk, undefined, undefined, undefined, true);
    return id;
}

/**
 * A signed POST of exactly these bytes. A raw body, because JSON.stringify can't write what a hand-made request can:
 * `1e400` parses to Infinity on the server.
 */
async function signedRaw(urlPath: string, id: Id, raw: string) {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `POST\n${urlPath}\n${ts}\n${nonce}\n${raw}`;
    const res = await fetch(`${BASE}${urlPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}
const signed = (urlPath: string, id: Id, body: unknown) => signedRaw(urlPath, id, JSON.stringify(body));

// Step 7c: the password alone opens no admin route with 2FA off; the admin calls carry an owner's automation token.
let ADMIN: Record<string, string> = {};
async function adminPost(urlPath: string, body: unknown) {
    const res = await fetch(`${BASE}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ADMIN },
        body: JSON.stringify(body),
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const bal = (pk: string): number => r4(getBalance(pk).balance);
const rowBalance = (pk: string): unknown => (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: unknown } | undefined)?.balance;
const txRow = (id: string) => db.prepare('SELECT status, credits, hours FROM marketplace_transactions WHERE id = ?').get(id) as { status: string; credits: unknown; hours: number | null } | undefined;
const dealsOn = (postId: string): number => (db.prepare('SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ?').get(postId) as { n: number }).n;
const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`;
const QUANTITY_REFUSAL = /^The (final )?quantity must be a number from 0\.01 to 10000$/;

/** The conservation check after a money step: no drift, nothing stranded, every balance a finite number. */
function ledgerAddsUp(step: string): void {
    const a = runLedgerAudit();
    assert(a.ok && Math.abs(a.drift) < 0.0001 && a.strandedEscrows === 0 && a.badBalances === 0,
        `the ledger adds up after ${step} (drift ${a.drift}, stranded ${a.strandedEscrows}, not a number ${a.badBalances})`);
}

async function main(): Promise<void> {
    console.log('Money follow-ups from #1379 and #1374\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    ADMIN = ownerTokenHeaders('admin');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const seller = makeMember('Seller', 100);
    const buyer = makeMember('Buyer', 100);
    const third = makeMember('Third', 100);
    ledgerAddsUp('the members are seeded');

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // 1. A moderator's removal refunds what the escrow holds when the deal row holds no valid amount
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. a moderator removing a listing whose deal row holds "abc" gives the buyer the escrow\'s Beans ──');
    const kale = createPost('offer', 'food', 'Kale', 'Kale', 6, 'fixed', seller.pk)!;
    const kaleDeal = requestPost(kale.id, buyer.pk);
    approvePostRequest(kaleDeal.id, seller.pk, { authSigner: seller.pk });
    const buyerBefore = bal(buyer.pk);
    assert(bal(`escrow_${kaleDeal.id}`) === 6 && buyerBefore === 94, `the buyer's 6 Beans are held (${bal(`escrow_${kaleDeal.id}`)}, buyer ${buyerBefore})`);
    db.prepare(`UPDATE marketplace_transactions SET credits = 'abc' WHERE id = ?`).run(kaleDeal.id);

    const removal = await adminPost(`/api/local/admin/posts/${kale.id}/delete`, {});
    assert(removal.status === 200 && removal.body?.success === true, `the moderator's removal goes through (${brief(removal)})`);
    assert(txRow(kaleDeal.id)?.status === 'cancelled', `the deal is closed (${txRow(kaleDeal.id)?.status})`);
    assert(bal(buyer.pk) === 100 && rowBalance(buyer.pk) === 100, `the buyer gets the 6 Beans the escrow held back, in memory and on disk (${bal(buyer.pk)}, row ${rowBalance(buyer.pk)})`);
    assert(bal(`escrow_${kaleDeal.id}`) === 0 && rowBalance(`escrow_${kaleDeal.id}`) === 0,
        `the escrow is empty (${bal(`escrow_${kaleDeal.id}`)}, row ${rowBalance(`escrow_${kaleDeal.id}`)})`);
    const refundRow = db.prepare('SELECT amount FROM transactions WHERE from_pubkey = ? AND to_pubkey = ?').get(`escrow_${kaleDeal.id}`, buyer.pk) as { amount: number } | undefined;
    assert(refundRow?.amount === 6, `one ledger row moves the 6 from the escrow to the buyer (${JSON.stringify(refundRow)})`);
    const report = removal.body?.refundShortfalls?.[0];
    assert(removal.body?.refundShortfalls?.length === 1 && report?.transactionId === kaleDeal.id && report?.owed === null && report?.refunded === 6,
        `the moderator is told the deal held no valid amount and what was refunded (${JSON.stringify(removal.body?.refundShortfalls)})`);
    assert(/held no valid amount/.test(String(removal.body?.warning)) && !/owed abc|owed null/.test(String(removal.body?.warning)),
        `in words (${removal.body?.warning})`);
    ledgerAddsUp('the removal');

    // A healthy deal's removal is as before: its credits back, nothing to report.
    const chard = createPost('offer', 'food', 'Chard', 'Chard', 3, 'fixed', seller.pk)!;
    const chardDeal = requestPost(chard.id, buyer.pk);
    approvePostRequest(chardDeal.id, seller.pk, { authSigner: seller.pk });
    const healthy = await adminPost(`/api/local/admin/posts/${chard.id}/delete`, {});
    assert(healthy.status === 200 && !healthy.body?.refundShortfalls && bal(buyer.pk) === 100 && bal(`escrow_${chardDeal.id}`) === 0,
        `a healthy deal's removal still refunds its 3 and reports nothing (${brief(healthy)}, buyer ${bal(buyer.pk)})`);
    ledgerAddsUp('a healthy removal');

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // 2. A payout that overflows at the deal's rate: plain words, and the way out works
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. a completion whose payout overflows says what happened and what to do ──');
    // (a) A deal row written by hand (or before #1379) whose credits are near the largest number: its rate is real, but
    //     the rate times the confirmed days is Infinity. A daily deal, so the words say days.
    const loan = createPost('offer', 'tools', 'Trailer hire', 'By the day', 2, 'daily', seller.pk)!;
    const loanDeal = acceptPost(loan.id, buyer.pk, 2);
    assert(bal(`escrow_${loanDeal.id}`) === 4, `2 days at 2 are held (${bal(`escrow_${loanDeal.id}`)})`);
    db.prepare('UPDATE marketplace_transactions SET credits = 1e308 WHERE id = ?').run(loanDeal.id);
    const beforeLoan = { buyer: bal(buyer.pk), seller: bal(seller.pk), escrow: bal(`escrow_${loanDeal.id}`) };
    const overflow = await signed('/api/marketplace/transactions/complete', buyer, { transactionId: loanDeal.id, confirmerPublicKey: buyer.pk, finalHours: 4 });
    const words = String(overflow.body?.error);
    assert(overflow.status === 400 && /^Paying for 4 days at this deal's rate comes to more Beans than one payment can carry, so nothing has moved\./.test(words),
        `the refusal says what happened, in days (${brief(overflow)})`);
    assert(/This deal holds an amount the Beans held for it can't cover, so it can't be completed or cancelled\. Ask a moderator to remove the listing to clear it: the Beans held for it go back to whoever paid them\.$/.test(words)
        && !/fewer|Confirm the/.test(words),
        'and the way out that works in this state: a moderator removing the listing (#1445 re-review)');
    const loanSnap = () => JSON.stringify({ buyer: bal(buyer.pk), seller: bal(seller.pk), escrow: bal(`escrow_${loanDeal.id}`) });
    assert(loanSnap() === JSON.stringify(beforeLoan) && txRow(loanDeal.id)?.status === 'pending', 'nothing moved and the deal is still open');
    // Measured, as the words say: neither confirming the booked days (no quantity) nor cancelling can clear such a row.
    const loanBooked = await signed('/api/marketplace/transactions/complete', buyer, { transactionId: loanDeal.id, confirmerPublicKey: buyer.pk });
    const loanCancel = await signed('/api/marketplace/transactions/cancel', buyer, { transactionId: loanDeal.id, cancellerPublicKey: buyer.pk });
    assert(loanBooked.status !== 200 && loanCancel.status !== 200 && loanSnap() === JSON.stringify(beforeLoan) && txRow(loanDeal.id)?.status === 'pending',
        `confirming the booked days and cancelling are both refused, and nothing moves (${brief(loanBooked)}; ${brief(loanCancel)})`);
    const loanRemoved = await adminPost(`/api/local/admin/posts/${loan.id}/delete`, {});
    assert(loanRemoved.status === 200 && txRow(loanDeal.id)?.status === 'cancelled' && bal(buyer.pk) === beforeLoan.buyer + 4 && bal(`escrow_${loanDeal.id}`) === 0,
        `a moderator removing the listing clears it, and the buyer gets the 4 held back (${brief(loanRemoved)}, buyer ${bal(buyer.pk)})`);
    ledgerAddsUp('the overflow and the moderator\'s removal');

    // (b) A booked quantity so small (1e-320) that the deal's rate (4 / 1e-320) is Infinity: no rate is worked out from
    //     it, whatever the quantity confirmed (0.5 h used to get "Confirm fewer hours", which couldn't work).
    const weeding = createPost('offer', 'garden', 'Weeding', 'By the hour', 2, 'hourly', seller.pk)!;
    const weedDeal = acceptPost(weeding.id, buyer.pk, 2);
    assert(bal(`escrow_${weedDeal.id}`) === 4, `2 hours at 2 are held (${bal(`escrow_${weedDeal.id}`)})`);
    db.prepare('UPDATE marketplace_transactions SET hours = 1e-320 WHERE id = ?').run(weedDeal.id);
    const before2 = { buyer: bal(buyer.pk), seller: bal(seller.pk), escrow: bal(`escrow_${weedDeal.id}`) };
    for (const finalHours of [2, 0.5]) {
        const r = await signed('/api/marketplace/transactions/complete', buyer, { transactionId: weedDeal.id, confirmerPublicKey: buyer.pk, finalHours });
        const w = String(r.body?.error);
        assert(r.status === 400 && /^This deal's rate per hour can't be worked out from what it holds, so nothing has moved\. Cancel the deal, and the Beans held for it go back\.$/.test(w),
            `confirming ${finalHours} h is refused in plain words, naming only the cancel, which works (${brief(r)})`);
        assert(JSON.stringify({ buyer: bal(buyer.pk), seller: bal(seller.pk), escrow: bal(`escrow_${weedDeal.id}`) }) === JSON.stringify(before2)
            && txRow(weedDeal.id)?.status === 'pending', 'nothing moved and the deal is still open');
    }
    const cancel = await signed('/api/marketplace/transactions/cancel', buyer, { transactionId: weedDeal.id, cancellerPublicKey: buyer.pk });
    assert(cancel.status === 200 && bal(buyer.pk) === before2.buyer + 4 && bal(`escrow_${weedDeal.id}`) === 0,
        `cancelling the deal, as the words say, gives the buyer the 4 back (${brief(cancel)}, buyer ${bal(buyer.pk)})`);
    ledgerAddsUp('the cancel');

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // 3. A quantity that isn't one is refused at every door, on a fixed deal as on an hourly one
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. a non-finite or absurd quantity is refused at every door ──');
    // Each as the JSON a hand-made request can carry: 1e400 and -1e400 parse to ±Infinity on the server.
    const BAD: [string, string][] = [
        ['"Infinity"', '"Infinity"'], ['1e400', '1e400'], ['-1e400', '-1e400'], ['-2', '-2'], ['0', '0'],
        ['"abc"', '"abc"'], ['20000', '20000'], ['""', '""'], ['true', 'true'], ['[2]', '[2]'],
        // Below 0.01 of a unit (#1445 review, BLOCKING 2): a subnormal, a tiny normal number, and just under the floor.
        ['5e-324', '5e-324'], ['1e-320', '1e-320'], ['1e-300', '1e-300'], ['0.009', '0.009'], ['"5e-324"', '"5e-324"'],
    ];
    const withHours = (fields: Record<string, string>, hoursKey: string, hoursJson: string) =>
        `{${Object.entries(fields).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')},${JSON.stringify(hoursKey)}:${hoursJson}}`;

    // (a) The request door, on a fixed listing.
    const eggs = createPost('offer', 'food', 'Eggs', 'A dozen', 3, 'fixed', seller.pk)!;
    for (const [label, json] of BAD) {
        const r = await signedRaw('/api/marketplace/posts/request', buyer, withHours({ postId: eggs.id, buyerPublicKey: buyer.pk }, 'hours', json));
        assert(r.status === 400 && QUANTITY_REFUSAL.test(String(r.body?.error)) && dealsOn(eggs.id) === 0,
            `a request for a fixed listing with hours ${label} is refused, and no deal is written (${brief(r)})`);
    }
    const plainAsk = await signed('/api/marketplace/posts/request', buyer, { postId: eggs.id, buyerPublicKey: buyer.pk });
    assert(plainAsk.status === 200 && dealsOn(eggs.id) === 1, `the same request with no hours goes through (${brief(plainAsk)})`);

    // (b) The one-step accept, on a fixed Offer.
    const jam = createPost('offer', 'food', 'Jam', 'Plum jam', 2, 'fixed', seller.pk)!;
    const thirdBefore = bal(third.pk);
    for (const [label, json] of BAD) {
        const r = await signedRaw('/api/marketplace/posts/accept', third, withHours({ postId: jam.id, buyerPublicKey: third.pk }, 'hours', json));
        assert(r.status === 400 && QUANTITY_REFUSAL.test(String(r.body?.error)) && dealsOn(jam.id) === 0 && bal(third.pk) === thirdBefore,
            `a one-step accept of a fixed Offer with hours ${label} is refused, and nothing moves (${brief(r)})`);
    }
    const jamAccept = await signed('/api/marketplace/posts/accept', third, { postId: jam.id, buyerPublicKey: third.pk, hours: 3 });
    const jamDeal = jamAccept.body?.transaction?.id as string;
    assert(jamAccept.status === 200 && bal(third.pk) === thirdBefore - 2 && txRow(jamDeal)?.hours === null,
        `a fixed Offer accepted with a real quantity still costs its price, the quantity ignored (${brief(jamAccept)}, ${bal(third.pk)})`);
    ledgerAddsUp('the accept');

    // (c) The completion door, on that fixed deal.
    for (const [label, json] of BAD) {
        const before = { third: bal(third.pk), seller: bal(seller.pk), escrow: bal(`escrow_${jamDeal}`) };
        const r = await signedRaw('/api/marketplace/transactions/complete', third,
            withHours({ transactionId: jamDeal, confirmerPublicKey: third.pk }, 'finalHours', json));
        const after = { third: bal(third.pk), seller: bal(seller.pk), escrow: bal(`escrow_${jamDeal}`) };
        assert(r.status === 400 && QUANTITY_REFUSAL.test(String(r.body?.error)) && txRow(jamDeal)?.status === 'pending'
            && JSON.stringify(after) === JSON.stringify(before),
            `completing a fixed deal with final hours ${label} is refused, and nothing moves (${brief(r)})`);
    }
    const sellerBeforeJam = bal(seller.pk);
    const jamDone = await signed('/api/marketplace/transactions/complete', third, { transactionId: jamDeal, confirmerPublicKey: third.pk, finalHours: 5 });
    assert(jamDone.status === 200 && txRow(jamDeal)?.status === 'completed' && bal(seller.pk) === r4(sellerBeforeJam + 2 * 0.985),
        `with a real quantity it completes at its fixed 2 (${brief(jamDone)}, seller ${bal(seller.pk)})`);
    ledgerAddsUp('the fixed completion');

    // (d) The completion door, on an hourly deal: a negative, 0 or text quantity used to be ignored and the booked
    //     hours paid.
    const mowing = createPost('offer', 'garden', 'Mowing', 'By the hour', 4, 'hourly', seller.pk)!;
    const mowDeal = acceptPost(mowing.id, third.pk, 2);
    for (const [label, json] of BAD) {
        const before = { third: bal(third.pk), seller: bal(seller.pk), escrow: bal(`escrow_${mowDeal.id}`) };
        const r = await signedRaw('/api/marketplace/transactions/complete', third,
            withHours({ transactionId: mowDeal.id, confirmerPublicKey: third.pk }, 'finalHours', json));
        const after = { third: bal(third.pk), seller: bal(seller.pk), escrow: bal(`escrow_${mowDeal.id}`) };
        assert(r.status === 400 && QUANTITY_REFUSAL.test(String(r.body?.error)) && txRow(mowDeal.id)?.status === 'pending'
            && JSON.stringify(after) === JSON.stringify(before),
            `completing an hourly deal with final hours ${label} is refused, and nothing moves (${brief(r)})`);
    }
    const thirdBeforeMow = bal(third.pk), sellerBeforeMow = bal(seller.pk);
    const mowDone = await signed('/api/marketplace/transactions/complete', third, { transactionId: mowDeal.id, confirmerPublicKey: third.pk, finalHours: 3 });
    assert(mowDone.status === 200 && bal(third.pk) === thirdBeforeMow - 4 && bal(seller.pk) === r4(sellerBeforeMow + 12 * 0.985),
        `confirmed at a real 3 hours it pays 3 at the deal's 4 (${brief(mowDone)}, buyer ${bal(third.pk)}, seller ${bal(seller.pk)})`);
    // The legacy spelling `hours` on the same door is held to the same rule.
    const mowing2 = createPost('offer', 'garden', 'Hedging', 'By the hour', 1, 'hourly', seller.pk)!;
    const hedgeDeal = acceptPost(mowing2.id, third.pk, 1);
    for (const json of ['-1e400', '5e-324', '0.009']) {
        const legacy = await signedRaw('/api/marketplace/transactions/complete', third,
            withHours({ transactionId: hedgeDeal.id, confirmerPublicKey: third.pk }, 'hours', json));
        assert(legacy.status === 400 && QUANTITY_REFUSAL.test(String(legacy.body?.error)) && txRow(hedgeDeal.id)?.status === 'pending',
            `the same door's "hours" spelling refuses ${json} too (${brief(legacy)})`);
    }
    const hedgeDone = await signed('/api/marketplace/transactions/complete', third, { transactionId: hedgeDeal.id, confirmerPublicKey: third.pk });
    assert(hedgeDone.status === 200 && txRow(hedgeDeal.id)?.status === 'completed', `and with no quantity it pays the booked hour (${brief(hedgeDone)})`);
    ledgerAddsUp('the hourly completions');

    // (e) The enterprise's completion door (POST /api/treasury/:id/complete), on its fixed Need.
    const lead = makeMember('ToolsLead', 20);
    const helper = makeMember('ToolsHelper', 20);
    const tools = crypto.randomUUID();
    createCrowdfundProject(tools, lead.pk, 'Tool library', 'Shared tools', [AVATAR], 1000, null);
    transfer('genesis', tools, 50, 'seed the tool library', 'direct', true);
    createPost('offer', 'general', 'Tool loans', 'Borrow a drill', 1, 'fixed', tools, undefined, undefined, undefined, true);
    const shelves = createPost('need', 'work', 'Build shelves', 'For the tools', 5, 'fixed', tools)!;
    const shelfDeal = requestPost(shelves.id, helper.pk);
    approvePostRequest(shelfDeal.id, tools, { authSigner: lead.pk });
    assert(bal(`escrow_${shelfDeal.id}`) === 5, `the tool library's 5 are held (${bal(`escrow_${shelfDeal.id}`)})`);
    for (const [label, json] of BAD) {
        const before = { tools: bal(tools), helper: bal(helper.pk), escrow: bal(`escrow_${shelfDeal.id}`) };
        const r = await signedRaw(`/api/treasury/${tools}/complete`, lead, withHours({ transactionId: shelfDeal.id }, 'hours', json));
        const after = { tools: bal(tools), helper: bal(helper.pk), escrow: bal(`escrow_${shelfDeal.id}`) };
        assert(r.status === 400 && QUANTITY_REFUSAL.test(String(r.body?.error)) && txRow(shelfDeal.id)?.status === 'pending'
            && JSON.stringify(after) === JSON.stringify(before),
            `the enterprise's completion with hours ${label} is refused, and nothing moves (${brief(r)})`);
    }
    const shelfDone = await signed(`/api/treasury/${tools}/complete`, lead, { transactionId: shelfDeal.id });
    // The fee is rounded to the cent here (0.075 → 0.07), so the 5 less a fee is what's checked, not 4.925 exactly.
    assert(shelfDone.status === 200 && txRow(shelfDeal.id)?.status === 'completed' && bal(`escrow_${shelfDeal.id}`) === 0
        && bal(helper.pk) > 24.9 && bal(helper.pk) <= 25,
        `with no quantity it pays the helper the 5, less the fee (${shelfDone.status}, helper ${bal(helper.pk)})`);
    ledgerAddsUp('the enterprise\'s completion');

    // (f) The review's measured cases (#1445, BLOCKING 2): an hourly Offer at 1.49, 0.4 and 2.5 Beans/h, asked for or
    //     one-step accepted at 5e-324 hours, then confirmed at 10. It paid 10, 0 and 20 for what lists at 14.90, 4 and 25.
    const near = (a: number, b: number) => Math.abs(a - b) < 0.0001;
    const goodBooked: [string, number][] = [['1', 1], ['"2"', 2], ['2.5', 2.5]];
    for (const [i, price] of [1.49, 0.4, 2.5].entries()) {
        const pruning = createPost('offer', 'garden', `Pruning at ${price}`, 'By the hour', price, 'hourly', seller.pk)!;
        const snap = () => JSON.stringify({ buyer: bal(buyer.pk), seller: bal(seller.pk) });
        const beforeF = snap();
        for (const json of ['5e-324', '1e-320', '0.009']) {
            for (const door of ['/api/marketplace/posts/accept', '/api/marketplace/posts/request']) {
                const r = await signedRaw(door, buyer, withHours({ postId: pruning.id, buyerPublicKey: buyer.pk }, 'hours', json));
                assert(r.status === 400 && QUANTITY_REFUSAL.test(String(r.body?.error)) && dealsOn(pruning.id) === 0 && snap() === beforeF,
                    `${price} Beans/h: ${door.split('/').pop()} for ${json} hours is refused, no deal is written and nothing moves (${brief(r)})`);
            }
        }
        // A good quantity books it, as the apps send it: a number, a numeric string, a fraction.
        const [bookedJson, booked] = goodBooked[i];
        const accepted = await signedRaw('/api/marketplace/posts/accept', buyer, withHours({ postId: pruning.id, buyerPublicKey: buyer.pk }, 'hours', bookedJson));
        const dealId = accepted.body?.transaction?.id as string;
        assert(accepted.status === 200 && txRow(dealId)?.hours === booked && near(bal(`escrow_${dealId}`), price * booked),
            `${price} Beans/h: accepted for ${bookedJson} hours, ${r4(price * booked)} held (${brief(accepted)})`);
        ledgerAddsUp(`the accept at ${price}`);

        // The row as the old accept wrote it at 5e-324 hours: credits price × 5e-324, which can only be a whole multiple
        // of 5e-324 (5e-324 at 1.49, 0 at 0.4, 1e-323 at 2.5). No rate is worked out from it.
        const rowBefore = txRow(dealId)!;
        db.prepare('UPDATE marketplace_transactions SET hours = 5e-324, credits = ? WHERE id = ?').run(price * 5e-324, dealId);
        const beforeConfirm = JSON.stringify({ buyer: bal(buyer.pk), seller: bal(seller.pk), escrow: bal(`escrow_${dealId}`) });
        const tenHours = await signed('/api/marketplace/transactions/complete', buyer, { transactionId: dealId, confirmerPublicKey: buyer.pk, finalHours: 10 });
        assert(tenHours.status === 400 && /rate per hour can't be worked out from what it holds, so nothing has moved/.test(String(tenHours.body?.error))
            && txRow(dealId)?.status === 'pending'
            && JSON.stringify({ buyer: bal(buyer.pk), seller: bal(seller.pk), escrow: bal(`escrow_${dealId}`) }) === beforeConfirm,
            `${price} Beans/h: such a row confirmed at 10 hours is refused and nothing moves, never paid at a rounded rate (${brief(tenHours)})`);
        ledgerAddsUp(`the refused confirmation at ${price}`);
        db.prepare('UPDATE marketplace_transactions SET hours = ?, credits = ? WHERE id = ?').run(rowBefore.hours, rowBefore.credits, dealId);   // put it back

        // A good final quantity, " 3 " as text, pays 3 hours at the deal's own rate.
        const buyerBefore = bal(buyer.pk), sellerBefore = bal(seller.pk);
        const done = await signedRaw('/api/marketplace/transactions/complete', buyer,
            withHours({ transactionId: dealId, confirmerPublicKey: buyer.pk }, 'finalHours', '" 3 "'));
        assert(done.status === 200 && txRow(dealId)?.status === 'completed' && near(bal(buyer.pk), buyerBefore - price * (3 - booked))
            && bal(seller.pk) - sellerBefore > price * 3 * 0.98 && bal(seller.pk) - sellerBefore <= price * 3 && bal(`escrow_${dealId}`) === 0,
            `${price} Beans/h: confirmed at " 3 " hours it pays ${r4(price * 3)} (${brief(done)}, buyer ${bal(buyer.pk)}, seller ${bal(seller.pk)})`);
        ledgerAddsUp(`the completion at ${price}`);
    }
    // The floor itself is a quantity: 0.01 hours books and pays.
    const quick = createPost('offer', 'general', 'Quick look', 'By the hour', 2.5, 'hourly', seller.pk)!;
    const quickDeal = await signed('/api/marketplace/posts/accept', buyer, { postId: quick.id, buyerPublicKey: buyer.pk, hours: 0.01 });
    const quickId = quickDeal.body?.transaction?.id as string;
    const quickDone = await signed('/api/marketplace/transactions/complete', buyer, { transactionId: quickId, confirmerPublicKey: buyer.pk, finalHours: null });
    assert(quickDeal.status === 200 && quickDone.status === 200 && txRow(quickId)?.status === 'completed' && near(Number(txRow(quickId)?.credits), 0.025),
        `0.01 hours, the floor, books and pays its 0.025, with a null final quantity paying the booked hours (${brief(quickDeal)}; ${brief(quickDone)})`);
    ledgerAddsUp('the 0.01-hour deal');

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // 5. A pledge to a funded enterprise, through the door both apps use
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. a pledge to an enterprise that reached its goal gets the plain refusal on the apps\' door ──');
    const wellCreator = makeMember('WellCreator', 50);
    const early = makeMember('EarlyBacker', 200);
    const late = makeMember('LateBacker', 200);
    const well = crypto.randomUUID();
    createCrowdfundProject(well, wellCreator.pk, 'Village well', 'Clean water', [], 20, null);
    const funding = await signed(`/api/treasury/${well}/pledge`, early, { amount: 20, memo: 'For the well' });
    const wellStatus = () => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(well) as { status: string }).status;
    assert(funding.status === 200 && wellStatus() === 'funded' && bal(well) === 20,
        `the well reaches its goal through the apps' door (${brief(funding)}, ${wellStatus()}, ${bal(well)})`);
    ledgerAddsUp('the goal pledge');
    const snapshot = () => JSON.stringify({ late: bal(late.pk), well: bal(well), escrow: bal(`escrow_${well}`) });
    const before5 = snapshot();
    for (const door of [`/api/treasury/${well}/pledge`, `/api/enterprise/${well}/pledge`]) {
        const r = await signed(door, late, { amount: 5, memo: 'Late' });
        assert(r.status === 400 && /already reached its goal, so it is not taking more pledges\. Your Beans have not moved\./.test(String(r.body?.error)),
            `${door.replace(well, ':id')} answers a funded enterprise in plain words (${brief(r)})`);
    }
    assert(snapshot() === before5, `and nothing moves (${snapshot()})`);
    // An enterprise that is winding up is still refused as closed.
    const hall = crypto.randomUUID();
    createCrowdfundProject(hall, wellCreator.pk, 'Hall chairs', 'Forty chairs', [], 100, null);
    db.prepare("UPDATE members SET status = 'winding_up' WHERE public_key = ?").run(hall);
    const closed = await signed(`/api/treasury/${hall}/pledge`, late, { amount: 5, memo: 'Late' });
    assert(closed.status === 403 && /has been closed/.test(String(closed.body?.error)) && snapshot() === before5,
        `an enterprise winding up is still refused as closed, and nothing moves (${brief(closed)})`);
    ledgerAddsUp('the refused pledges');

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // 4. The take-over's audit carries the balances that aren't a number; the pot is never written as 0
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a take-over\'s audit reports balances that are not a number; a NaN pot is never stored as 0 ──');
    // N1: the Commons row is written with INSERT OR REPLACE, where SQLite puts the column's DEFAULT 0 for a NaN.
    const potRow = () => rowBalance('COMMONS_POOL');
    persistCommonsBalance();
    const potBefore = potRow();
    const potMemory = getCommonsBalanceExact();
    setCommonsBalance(NaN);
    let potThrew = '';
    try { persistCommonsBalance(); } catch (e: any) { potThrew = e?.message || String(e); }
    let flushThrew = '';
    try { persistDecayAndCommons(); } catch (e: any) { flushThrew = e?.message || String(e); }
    // In the words a member reads while the pot is unknown (engine/audit.ts COMMONS_POT_PAUSED, #1465 review); the detail is logged.
    assert(/^Payments are paused on this community/.test(potThrew) && /^Payments are paused on this community/.test(flushThrew),
        `writing a pot that is NaN is refused, alone and with the demurrage flush (${JSON.stringify([potThrew, flushThrew])})`);
    assert(potRow() === potBefore, `and the Commons row keeps its value, not 0 (${potBefore} → ${potRow()})`);
    setCommonsBalance(potMemory);
    persistCommonsBalance();
    ledgerAddsUp('the pot is put back');

    // N3: a standby with a broken balance of its own takes over. Its audit and journal say so, with the count.
    const broken = makeMember('BrokenRow', 0);
    db.prepare(`UPDATE accounts SET balance = 'abc' WHERE public_key = ?`).run(broken.pk);
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    /** A take-over's journal at `restarting`, and its audit pending, as the restart leaves them. */
    const restartingTakeover = () => {
        const steps: Record<string, { at: string }> = {};
        for (const s of ['opened', 'undo-copy', 'identity-files', 'admin-settings', 'roles', 'public-address', 'profile', 'open-door',
            'community-settings', 'role', 'pull-config', 'restart']) steps[s] = { at: new Date().toISOString() };
        fs.writeFileSync(path.join(dataDir, TAKEOVER_JOURNAL_FILE), JSON.stringify({
            v: 1, id: crypto.randomUUID(), state: 'restarting', startedAt: new Date().toISOString(), completedAt: null,
            authorisedBy: { type: 'code', codeId: 1 }, sealedAt: null, peerId: 'peer', progressTokenHash: 'x', undoDir: path.join(dataDir, 'undo'),
            steps, error: null,
            result: { roles: { written: 0, owners: [], skipped: [] }, connectors: 0, publicAddress: null, tunnel: null, audit: null, announcement: null, reseal: null },
        }), { mode: 0o600 });
        updateLocalConfig({ promotionAuditPending: true, lastPromotionAudit: null });
    };
    restartingTakeover();
    const boot = resumeTakeoverAtBoot();
    const record = getLocalConfig().lastPromotionAudit as any;
    assert(boot.auditRan && record?.ok === false && record?.badBalances === 1,
        `the take-over's audit record carries the one balance that is not a number (${JSON.stringify(record && { ok: record.ok, drift: record.drift, stranded: record.strandedEscrows, badBalances: record.badBalances })})`);
    const progress = getTakeoverProgress();
    const audit = progress.result?.audit as any;
    assert(audit?.badBalances === 1 && audit?.addsUp === false,
        `the journal carries it, and doesn't say the ledger adds up (${JSON.stringify(audit && { addsUp: audit.addsUp, badBalances: audit.badBalances, drift: audit.drift })})`);
    const auditStep = progress.steps.find((s) => s.step === 'audit');
    assert(/1 balance\(s\) that are not a finite number/.test(String(auditStep?.detail)),
        `and the step's words name the count (${auditStep?.detail})`);

    // An infinite balance (#1445 review, BLOCKING 1): the sum and the drift are Infinity, which local-config.json holds as
    // null. The audit's words called null.toFixed and the take-over stopped at `restarting`. (A real two-process
    // take-over: test-takeover-infinite-balance.)
    const infinite = makeMember('InfiniteRow', 0);
    db.prepare('UPDATE accounts SET balance = 9e999 WHERE public_key = ?').run(infinite.pk);
    restartingTakeover();
    const boot2 = resumeTakeoverAtBoot();
    const record2 = getLocalConfig().lastPromotionAudit as any;
    const progress2 = getTakeoverProgress();
    const audit2 = progress2.result?.audit as any;
    const step2 = String(progress2.steps.find((s) => s.step === 'audit')?.detail);
    assert(boot2.auditRan && record2?.drift === null && record2?.badBalances === 2 && record2?.ok === false,
        `with a balance of Infinity the audit record holds drift null and both bad balances (${JSON.stringify(record2 && { ok: record2.ok, drift: record2.drift, sum: record2.sumBalances, bad: record2.badBalances })})`);
    assert(progress2.steps.find((s) => s.step === 'audit')?.done === true && audit2?.addsUp === false && audit2?.ok === false && audit2?.badBalances === 2,
        `the audit step is done and says the ledger doesn't add up (${JSON.stringify(audit2 && { ok: audit2.ok, addsUp: audit2.addsUp, bad: audit2.badBalances, drift: audit2.drift })})`);
    assert(/the ledger does NOT add up \(drift not a number, 0 stranded escrow\(s\), 2 balance\(s\) that are not a finite number\)/.test(step2) && !/null|NaN|Infinity/.test(step2),
        `in words, with "not a number" for the difference (${step2})`);
    // The operator's ledger audit answers the same, and a new baseline can't be set at an infinite sum.
    const liveAudit = await adminPost('/api/local/admin/ledger-audit', {});
    assert(liveAudit.status === 200 && liveAudit.body?.ok === false && liveAudit.body?.badBalances === 2 && liveAudit.body?.drift === null,
        `the admin ledger audit: not ok, 2 not a number, drift null (${brief(liveAudit)})`);
    const baselineRow = () => (db.prepare(`SELECT value FROM node_config WHERE key = 'ledger_audit_baseline'`).get() as { value: string } | undefined)?.value;
    const baselineBefore = baselineRow();
    const rebase = await adminPost('/api/local/admin/ledger-rebaseline', { reason: 'acknowledging the drift from an infinite row' });
    assert(rebase.status === 409 && /2 account balance\(s\) are not a number, so the ledger has no total to set a new baseline at\. Nothing was changed\./.test(String(rebase.body?.error))
        && baselineRow() === baselineBefore,
        `a rebaseline is refused in plain words, and the baseline stays ${baselineBefore} (${brief(rebase)}, now ${baselineRow()})`);
    // NB 3 of the re-review: both answers name the broken accounts (key and name) and how to mend them.
    const REPAIR = /Stop the server, set each one's balance in state\.db to what its transactions say, start it again, then set a new baseline for any difference left\./;
    const rebaseWords = String(rebase.body?.error);
    assert(rebaseWords.includes(`${broken.pk} (BrokenRow) holds text 'abc'`) && rebaseWords.includes(`${infinite.pk} (InfiniteRow) holds Infinity`) && REPAIR.test(rebaseWords),
        `the refusal names each broken account, its name and what it holds, and the repair (${rebaseWords})`);
    const listed = (liveAudit.body?.brokenBalances ?? []) as { account: string; callsign: string | null; holds: string }[];
    assert(listed.length === 2 && listed.some((b) => b.account === broken.pk && b.callsign === 'BrokenRow' && b.holds === "text 'abc'")
        && listed.some((b) => b.account === infinite.pk && b.callsign === 'InfiniteRow' && b.holds === 'Infinity') && REPAIR.test(String(liveAudit.body?.repair)),
        `the admin ledger audit lists them too, with the repair (${JSON.stringify(listed)})`);

    // BLOCKING 1 of the re-review: the Commons pot itself not a finite number. Its flush refused before anything was
    // counted, so the take-over's audit never recorded (stalled at `restarting`) and the operator's audit answered 500.
    const potRow2 = rowBalance('COMMONS_POOL');
    const potKept = getCommonsBalanceExact();
    for (const pot of [Infinity, -Infinity, NaN]) {
        setCommonsBalance(pot);
        let threw = '';
        let a: ReturnType<typeof runLedgerAudit> | null = null;
        try { a = runLedgerAudit(); } catch (e: any) { threw = e?.message || String(e); }
        assert(!threw && a?.ok === false && a?.badBalances === 3 && rowBalance('COMMONS_POOL') === potRow2,
            `a pot of ${pot}: the audit counts it as a third balance that is not a number, never throws, and writes nothing (${threw || JSON.stringify(a)}, row ${rowBalance('COMMONS_POOL')})`);
        const route = await adminPost('/api/local/admin/ledger-audit', {});
        assert(route.status === 200 && route.body?.ok === false && route.body?.badBalances === 3
            && (route.body?.brokenBalances ?? []).some((b: any) => b.account === 'COMMONS_POOL' && b.holds === `in memory: ${pot}`),
            `the admin ledger audit answers 200 and names the pot (${brief(route)})`);
        const rebase2 = await adminPost('/api/local/admin/ledger-rebaseline', { reason: 'acknowledging the drift from the pot' });
        assert(rebase2.status === 409 && /COMMONS_POOL \(the Commons pot\) holds in memory/.test(String(rebase2.body?.error)) && baselineRow() === baselineBefore,
            `the rebaseline is refused (409, not 500) and names the pot (${brief(rebase2)})`);
        restartingTakeover();
        const boot3 = resumeTakeoverAtBoot();
        const p3 = getTakeoverProgress();
        const step3 = String(p3.steps.find((s) => s.step === 'audit')?.detail);
        assert(boot3.auditRan && p3.steps.find((s) => s.step === 'audit')?.done === true && (p3.result?.audit as any)?.addsUp === false
            && /the ledger does NOT add up \(drift [^,]+, 0 stranded escrow\(s\), 3 balance\(s\) that are not a finite number\)/.test(step3)
            && getLocalConfig().promotionAuditPending === false,
            `and a take-over's audit records it, is marked done and says the ledger doesn't add up (${step3})`);
    }
    setCommonsBalance(potKept);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
