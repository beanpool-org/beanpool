/**
 * An escrow can never pay out more than it holds.
 *
 * WHY THIS SUITE EXISTS. The test node was measured on 2026-09-24 carrying two escrow accounts at -5 and
 * -10 Beans. Each had exactly ONE transaction ever against it — an "Escrow refund for removed post" — and
 * no hold had ever been paid in. A moderator removing a post had refunded 15 Beans to two buyers out of
 * escrows that held nothing, and the node stopped summing to zero. Three separate things let that happen,
 * and each is pinned here:
 *
 *   1. Escrow senders carried a `-Infinity` floor, so ANY debit from an escrow succeeded regardless of
 *      what it held (state-engine `transfer`, and `moveToCommons` for the cross-node fee).
 *   2. `adminDeletePost` refunded `tx.credits` straight off the trade row without looking at the escrow,
 *      and ignored the transfer's result.
 *   3. The extra-hours top-up in `completePostTransaction` ignored a failed `transfer`, then released the
 *      topped-up total anyway — paying the seller Beans that were never held.
 *
 * Verifies:
 *   Part 1: the primitive. A debit beyond an escrow's balance is REFUSED, at the core ledger (even when
 *           the caller explicitly asks for `-Infinity`), through `transfer()`, and through
 *           `moveToCommons()`. A debit of exactly the balance still closes the escrow to zero.
 *   Part 2: removing a post whose pending trade's escrow holds NOTHING. The escrow never goes below 0,
 *           the buyer receives nothing that was not held, the shortfall is reported with its trade id,
 *           and SUM(balances) including the Commons is unchanged.
 *   Part 3: a partly funded escrow refunds what it holds and reports the rest as short.
 *   Part 4: a forced top-up failure ABORTS the release — the seller receives nothing, the escrow keeps
 *           its base hold, and the trade is still pending.
 *   Part 6: the same removal through the REPORT flow (`actionReport`, what a moderator actually clicks)
 *           reports its shortfall to the caller too, rather than leaving it in the log.
 *   Part 5: the legitimate paths still close an escrow to exactly zero — release with the 1.5% fee, a
 *           cancel refund, and a dispute split on an amount that is not a round number of cents (the old
 *           split rounded both halves independently and could pay out more than the hold).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-escrow-floor.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { ESCROW_FLOOR, feeOf } from '@beanpool/core';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { completePostTransaction as completePostTransactionEngine } from './engine/escrow.js';
import { runLedgerAudit } from './engine/audit.js';
import { setMemberPhoto } from '@beanpool/engine';
import {
    initStateEngine,
    createPost as rawCreatePost,
    acceptPost,
    cancelPostTransaction,
    completePostTransaction,
    resolveEscrowDispute,
    adminDeletePost,
    submitReport,
    actionReport,
    moveToCommons,
    transfer,
    getBalance,
    getCommonsBalanceExact,
    conservingTransaction,
} from './state-engine.js';
import { wrapCreatePost } from './post-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return accounts + getCommonsBalanceExact();
}

function assertConservation(step: string): void {
    const audit = runLedgerAudit();
    assert(audit.ok, `[${step}] ledger audit ok`);
    assert(audit.drift === 0, `[${step}] no drift (${audit.drift})`);
    assert(nodeTotal() === 0, `[${step}] node sums to zero (${nodeTotal()})`);
}

/** No escrow account anywhere on the node may sit below the floor. The invariant, checked globally. */
function assertNoNegativeEscrows(step: string): void {
    const rows = db.prepare(
        `SELECT public_key, balance_c FROM accounts WHERE public_key LIKE 'escrow_%' AND balance_c < ?`
    ).all(ESCROW_FLOOR) as { public_key: string; balance_c: number }[];
    assert(rows.length === 0,
        `[${step}] no escrow account is below zero${rows.length ? ` (${rows.map(r => `${r.public_key}=${r.balance_c}`).join(', ')})` : ''}`);
    for (const pk of listEscrowAccounts()) {
        assert(ledger.getAccount(pk).balance_c >= ESCROW_FLOOR,
            `[${step}] in-memory ${pk.slice(0, 20)} is not below zero (${ledger.getAccount(pk).balance_c})`);
    }
}

function listEscrowAccounts(): string[] {
    return (db.prepare(`SELECT public_key FROM accounts WHERE public_key LIKE 'escrow_%'`).all() as any[])
        .map(r => r.public_key);
}

function makeMember(callsign: string, initialBalance = 0): string {
    const pk = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign);
    setMemberPhoto(db, pk, AVATAR);
    db.prepare(`INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    ledger.initializeGenesisAccount(pk);
    if (initialBalance > 0) transfer('genesis', pk, initialBalance, `seed ${callsign}`, 'direct', true);
    // An offer apiece, so the contribution gate lets these members trade.
    createPost('offer', 'general', `${callsign} service`, 'Help', 500, 'fixed', pk, undefined, undefined, undefined, true);
    return pk;
}

function escrowBalance(txId: string): number {
    return ledger.getAccount(`escrow_${txId}`).balance_c;
}

async function main() {
    console.log('Testing the escrow floor — an escrow can never pay out more than it holds...\n');
    initStateEngine();
    assertConservation('startup');

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 1: the primitive
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 1: a debit beyond the balance is refused ──');
    {
        const holder = makeMember('FloorHolder', 10000);
        const escrowId = `escrow_${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(escrowId);
        assert(Boolean(transfer(holder, escrowId, 1000, 'fund the test escrow', 'escrow', true)), 'escrow funded with 10');
        assert(escrowBalance(escrowId.slice('escrow_'.length)) === 1000, 'escrow holds 10');

        // (a) The core ledger refuses even when the caller explicitly hands it an unbounded floor. This is
        //     the belt-and-braces half: no caller can re-open the hole by passing its own floor.
        assert(ledger.transfer(escrowId, holder, 2500, -Infinity).ok === false,
            'core ledger.transfer refuses a 25 debit from a 10 escrow even with floorOverride=-Infinity');
        assert(escrowBalance(escrowId.slice('escrow_'.length)) === 1000, 'the refused core debit moved nothing');

        // (b) The server's transfer() answers null rather than driving the escrow negative.
        const overdraw = transfer(escrowId, holder, 2500, 'overdraw the escrow', 'escrow', true);
        assert(overdraw === null, 'transfer() returns null for a 25 debit from a 10 escrow');
        assert(escrowBalance(escrowId.slice('escrow_'.length)) === 1000, 'the refused transfer moved nothing');

        // (c) moveToCommons is the other way value leaves an escrow (#104 moves the cross-node fee this
        //     way), and it was unbounded for the same reason.
        assert(moveToCommons(escrowId, 2500, 'overdraw the escrow to the Commons') === null,
            'moveToCommons() returns null for a 25 debit from a 10 escrow');
        assert(escrowBalance(escrowId.slice('escrow_'.length)) === 1000, 'the refused moveToCommons moved nothing');

        // (d) Draining exactly what is held still works — the floor bounds the debit, it does not block it.
        assert(Boolean(transfer(escrowId, holder, 1000, 'drain the escrow', 'escrow', true)),
            'a debit of exactly the balance succeeds');
        assert(escrowBalance(escrowId.slice('escrow_'.length)) === 0, 'escrow closes to exactly 0');

        assertNoNegativeEscrows('part1');
        assertConservation('part1');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 2: the measured case — a post removal against an escrow that holds nothing
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 2: removing a post whose escrow was never funded ──');
    {
        const seller = makeMember('GhostSeller', 5000);
        const buyer = makeMember('GhostBuyer', 5000);
        const offer = createPost('offer', 'goods', 'Ghost listing', 'Never escrowed', 1500, 'fixed', seller,
            undefined, undefined, undefined, false)!;

        // The measured shape: a pending trade row with NO hold ever paid into its escrow. This is what the
        // two legacy trades on the test node looked like — rows from 2026-05-29 whose holds predate the
        // escrow_<tx_id> wallet key and were never in one.
        const ghostTradeId = crypto.randomUUID();
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status)
                    VALUES (?, ?, ?, ?, ?, 'pending')`).run(ghostTradeId, offer.id, buyer, seller, 1500);
        db.prepare(`UPDATE posts SET status='pending', accepted_by=?, pending_transaction_id=? WHERE id=?`)
            .run(buyer, ghostTradeId, offer.id);

        const buyerBefore = getBalance(buyer).balance_c;
        const totalBefore = nodeTotal();
        const shortfalls: any[] = [];

        const ok = adminDeletePost(offer.id, { onRefundShortfall: s => shortfalls.push(s) });
        assert(ok, 'the post is still removed — a short escrow does not block moderation');

        assert(escrowBalance(ghostTradeId) === 0, 'the unfunded escrow is still 0, never negative');
        assert(getBalance(buyer).balance_c === buyerBefore,
            `the buyer receives nothing that was never held (${buyerBefore} → ${getBalance(buyer).balance_c})`);
        assert(shortfalls.length === 1, 'exactly one shortfall is reported');
        assert(shortfalls[0].transactionId === ghostTradeId, 'the shortfall names the trade id');
        assert(shortfalls[0].owed === 1500 && shortfalls[0].refunded === 0,
            `the shortfall says 15 owed, 0 refunded (got ${shortfalls[0].owed}/${shortfalls[0].refunded})`);
        assert(shortfalls[0].buyerPubkey === buyer, 'the shortfall names the buyer who went short');
        const tradeRow = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(ghostTradeId) as any;
        assert(tradeRow.status === 'cancelled', 'the trade is cancelled');
        assert(nodeTotal() === totalBefore,
            `SUM(balances) including the Commons is unchanged (${totalBefore} → ${nodeTotal()})`);

        assertNoNegativeEscrows('part2');
        assertConservation('part2');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 3: a partly funded escrow refunds what it holds, and says so
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 3: a partly funded escrow ──');
    {
        const seller = makeMember('PartSeller', 5000);
        const buyer = makeMember('PartBuyer', 5000);
        const offer = createPost('offer', 'goods', 'Half-held listing', 'Partly escrowed', 3000, 'fixed', seller,
            undefined, undefined, undefined, false)!;

        // A real hold of 30, then a trade row claiming the same escrow is worth 50. Nothing on a healthy
        // node writes that, which is the point: if the rows and the ledger ever disagree, the LEDGER wins.
        const deal = acceptPost(offer.id, buyer);
        assert(escrowBalance(deal.id) === 3000, 'escrow holds the real 30');
        db.prepare('UPDATE marketplace_transactions SET amount_c = 5000 WHERE id = ?').run(deal.id);

        const buyerBefore = getBalance(buyer).balance_c;
        const totalBefore = nodeTotal();
        const shortfalls: any[] = [];

        assert(adminDeletePost(offer.id, { onRefundShortfall: s => shortfalls.push(s) }), 'the post is removed');
        assert(escrowBalance(deal.id) === 0, 'the escrow drained to exactly 0, not to -20');
        assert(getBalance(buyer).balance_c === buyerBefore + 3000,
            `the buyer got back the 30 that was held, not the 50 the row claimed (${getBalance(buyer).balance_c - buyerBefore})`);
        assert(shortfalls.length === 1 && shortfalls[0].owed === 5000 && shortfalls[0].refunded === 3000,
            'the 20 shortfall is reported with the trade id');
        assert(nodeTotal() === totalBefore, 'node total unchanged');

        assertNoNegativeEscrows('part3');
        assertConservation('part3');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 4: a failed extra-hours top-up aborts the release
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 4: a failed top-up aborts the release ──');
    {
        const seller = makeMember('HourSeller', 5000);
        const buyer = makeMember('HourBuyer', 20000);
        const offer = createPost('offer', 'work', 'Hourly help', 'Per hour', 1000, 'hourly', seller,
            undefined, undefined, undefined, false)!;
        const deal = acceptPost(offer.id, buyer, 1);
        assert(escrowBalance(deal.id) === 1000, 'escrow holds the 1-hour base of 10');

        const sellerBefore = getBalance(seller).balance_c;
        const buyerBefore = getBalance(buyer).balance_c;
        const totalBefore = nodeTotal();
        const escrowAccount = `escrow_${deal.id}`;

        // Force the top-up leg — and only that leg — to fail, the way a refused transfer would. The buyer
        // has plenty of balance, so the pre-flight floor checks pass and the FAILURE IS THE TRANSFER's,
        // which is exactly the case the old code swallowed.
        let topUpAttempts = 0;
        const cb = escrowCallbacks((from, to) => {
            if (from === buyer && to === escrowAccount) { topUpAttempts++; return null; }
            return undefined;   // undefined = fall through to the real transfer
        });

        let threw = false;
        try {
            completePostTransactionEngine(cb, deal.id, buyer, 3);
        } catch (e: any) {
            threw = true;
            assert(/top up escrow/i.test(e.message), `the release throws on the failed top-up (${e.message})`);
        }
        assert(threw, 'the release did not complete');
        assert(topUpAttempts === 1, 'the top-up was attempted exactly once');
        assert(getBalance(seller).balance_c === sellerBefore,
            'the seller receives nothing — no payout out of an escrow that was never topped up');
        assert(getBalance(buyer).balance_c === buyerBefore, 'the buyer is not charged');
        assert(escrowBalance(deal.id) === 1000, 'the escrow still holds exactly its base 10');
        const row = db.prepare('SELECT status, amount_c FROM marketplace_transactions WHERE id = ?').get(deal.id) as any;
        assert(row.status === 'pending', 'the trade is still pending — the status update unwound too');
        assert(row.amount_c === 1000, 'the trade still says 10, not the topped-up 30');
        assert(nodeTotal() === totalBefore, 'the ledger is unchanged');

        assertNoNegativeEscrows('part4');
        assertConservation('part4');

        // And with the real transfer, the same release works and closes the escrow to zero.
        const done = completePostTransaction(deal.id, buyer, 3);
        assert(Boolean(done), 'the unforced release completes');
        assert(escrowBalance(deal.id) === 0, 'escrow closes to exactly 0 after the real top-up and release');
        assertNoNegativeEscrows('part4-real');
        assertConservation('part4-real');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 5: the legitimate paths still close to exactly zero
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 5: every legitimate close-out still drains the escrow ──');
    {
        // (a) Release with the 1.5% community fee. The fee comes off the RECIPIENT's side, so the escrow is
        //     debited exactly what it holds — the floor must not turn that into a refusal.
        const s1 = makeMember('FeeSeller', 5000);
        const b1 = makeMember('FeeBuyer', 20000);
        const o1 = createPost('offer', 'goods', 'Fee deal', 'Fixed price', 4000, 'fixed', s1, undefined, undefined, undefined, false)!;
        const d1 = acceptPost(o1.id, b1);
        assert(escrowBalance(d1.id) === 4000, 'escrow holds 40');
        assert(Boolean(completePostTransaction(d1.id, b1)), 'release succeeds with the fee charged');
        assert(escrowBalance(d1.id) === 0, 'release drains the escrow to exactly 0');
        assertNoNegativeEscrows('part5-release');
        assertConservation('part5-release');

        // (b) Cancel refund.
        const s2 = makeMember('CancelSeller', 5000);
        const b2 = makeMember('CancelBuyer', 20000);
        const o2 = createPost('offer', 'goods', 'Cancelled deal', 'Fixed price', 2500, 'fixed', s2, undefined, undefined, undefined, false)!;
        const d2 = acceptPost(o2.id, b2);
        assert(Boolean(cancelPostTransaction(d2.id, b2)), 'cancel succeeds');
        assert(escrowBalance(d2.id) === 0, 'cancel drains the escrow to exactly 0');
        assertNoNegativeEscrows('part5-cancel');
        assertConservation('part5-cancel');

        // (c) A dispute SPLIT on an odd number of hundredths. The old arithmetic rounded both halves to 2dp
        //     independently (at 12.345, 6.17 + 6.18 = 12.35, half a cent more than the escrow held). In whole
        //     hundredths the split is core halves(): the first share truncated, the second the rest, so 12.35
        //     Beans (1,235) pays 617 and 618, exactly what was held. Nothing is minted and nothing is stranded.
        const s3 = makeMember('SplitSeller', 5000);
        const b3 = makeMember('SplitBuyer', 20000);
        const o3 = createPost('offer', 'goods', 'Odd-cent deal', 'Fixed price', 1235, 'fixed', s3, undefined, undefined, undefined, false)!;
        const d3 = acceptPost(o3.id, b3);
        assert(escrowBalance(d3.id) === 1235, 'escrow holds 12.35');
        const b3Before = getBalance(b3).balance_c;
        const s3Before = getBalance(s3).balance_c;
        const potBefore = getCommonsBalanceExact();
        resolveEscrowDispute(d3.id, 'split', 'admin_pubkey_split_test');
        assert(escrowBalance(d3.id) === 0, `the split drains the escrow to exactly zero (${escrowBalance(d3.id)})`);
        const toBuyer = getBalance(b3).balance_c - b3Before;
        const toSeller = getBalance(s3).balance_c - s3Before;
        const toPot = getCommonsBalanceExact() - potBefore;
        // The seller's half is a sale: it pays the 1.5% fee, truncated (feeOf(618) = 9), and the fee goes to the Commons.
        assert(toBuyer === 617 && toSeller === 618 - feeOf(618) && toPot === feeOf(618),
            `the buyer gets the truncated half, the seller the rest less its fee (${toBuyer} + ${toSeller} + fee ${toPot})`);
        assert(toBuyer + toSeller + toPot === 1235, `together exactly the 12.35 that was held (${toBuyer + toSeller + toPot})`);
        assertNoNegativeEscrows('part5-split');
        assertConservation('part5-split');
    }

    // ──────────────────────────────────────────────────────────────────────────────
    // Part 6: the report flow reports its shortfall too
    // ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 6: the same short refund through actionReport ──');
    {
        // Parts 2 and 3 go through adminDeletePost. A moderator working a report goes through
        // actionReport instead, and that path used to drop the shortfall on the floor: the engine still
        // capped the refund, but the only trace was a console.warn and the moderator saw a plain success.
        const seller = makeMember('ReportSeller', 5000);
        const buyer = makeMember('ReportBuyer', 5000);
        const reporter = makeMember('Reporter', 5000);
        const offer = createPost('offer', 'goods', 'Reported listing', 'Never escrowed', 1200, 'fixed', seller,
            undefined, undefined, undefined, false)!;

        // Same measured shape as Part 2: a pending trade row with no hold ever paid into its escrow.
        const ghostTradeId = crypto.randomUUID();
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status)
                    VALUES (?, ?, ?, ?, ?, 'pending')`).run(ghostTradeId, offer.id, buyer, seller, 1200);
        db.prepare(`UPDATE posts SET status='pending', accepted_by=?, pending_transaction_id=? WHERE id=?`)
            .run(buyer, ghostTradeId, offer.id);

        const report = submitReport(reporter, seller, 'Not as described', offer.id)!;
        assert(Boolean(report), 'the listing is reported');

        const buyerBefore = getBalance(buyer).balance_c;
        const totalBefore = nodeTotal();
        const shortfalls: any[] = [];

        const ok = actionReport(report.id, true, false, false, { onRefundShortfall: s => shortfalls.push(s) });
        assert(ok, 'the report is actioned and the post removed');

        assert(shortfalls.length === 1, 'the report flow reports the shortfall to its caller, not just the log');
        assert(shortfalls[0].transactionId === ghostTradeId, 'the shortfall names the trade id');
        assert(shortfalls[0].owed === 1200 && shortfalls[0].refunded === 0,
            `the shortfall says 12 owed, 0 refunded (got ${shortfalls[0].owed}/${shortfalls[0].refunded})`);
        assert(shortfalls[0].buyerPubkey === buyer, 'the shortfall names the buyer who went short');

        assert(escrowBalance(ghostTradeId) === 0, 'the unfunded escrow is still 0, never negative');
        assert(getBalance(buyer).balance_c === buyerBefore,
            `the buyer receives nothing that was never held (${buyerBefore} → ${getBalance(buyer).balance_c})`);
        const tradeRow = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(ghostTradeId) as any;
        assert(tradeRow.status === 'cancelled', 'the trade is cancelled');
        const reportRow = db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(report.id) as any;
        assert(reportRow.status === 'actioned', 'the report is marked actioned — a short escrow does not block moderation');
        assert(nodeTotal() === totalBefore,
            `SUM(balances) including the Commons is unchanged (${totalBefore} → ${nodeTotal()})`);

        // A healthy trade through the same flow reports nothing: the callback is not just always firing.
        const seller2 = makeMember('ReportSeller2', 5000);
        const buyer2 = makeMember('ReportBuyer2', 5000);
        const offer2 = createPost('offer', 'goods', 'Properly held listing', 'Escrowed', 800, 'fixed', seller2,
            undefined, undefined, undefined, false)!;
        const deal2 = acceptPost(offer2.id, buyer2);
        assert(escrowBalance(deal2.id) === 800, 'the second escrow really holds 8');
        const buyer2Before = getBalance(buyer2).balance_c;
        const report2 = submitReport(reporter, seller2, 'Also not as described', offer2.id)!;
        const clean: any[] = [];
        assert(actionReport(report2.id, true, false, false, { onRefundShortfall: s => clean.push(s) }),
            'the second report is actioned');
        assert(clean.length === 0, 'a fully funded escrow reports no shortfall');
        assert(escrowBalance(deal2.id) === 0, 'the funded escrow drained to exactly 0');
        assert(getBalance(buyer2).balance_c === buyer2Before + 800,
            `the buyer got the whole 8 back (${getBalance(buyer2).balance_c - buyer2Before})`);

        assertNoNegativeEscrows('part6');
        assertConservation('part6');
    }

    // A last global sweep: nothing anywhere on the node ended below the floor.
    assertNoNegativeEscrows('final');
    assertConservation('final');

    console.log(`\nAll ${passed}/${run} checks passed.`);
    console.log('⭐️ An escrow can never pay out more than it holds.');
    process.exit(0);
}

/**
 * The escrow engine's callback bundle, with `transfer` intercepted.
 *
 * `state-engine.getEscrowCb()` is private, so the test assembles the same shape from the module's public
 * exports and stubs the parts that only talk to clients (broadcast, chat, push). `intercept` returns
 * `null` to force that leg to fail, or `undefined` to fall through to the real `transfer`.
 */
function escrowCallbacks(intercept: (from: string, to: string, amount: number) => null | undefined) {
    return {
        broadcast: () => { },
        transfer: ((from: string, to: string, amount: number, memo: string, method?: any, isFeeExempt?: boolean, auth?: any) => {
            const forced = intercept(from, to, amount);
            if (forced === null) return null;
            return transfer(from, to, amount, memo, method, isFeeExempt, auth);
        }) as any,
        ensureTransactionConversation: () => '',
        injectSystemMessage: () => null,
        dispatchPushNotification: () => { },
        getBalance,
        floorLockedError: (publicKey: string, postBalance: number) =>
            new Error(`Floor locked for ${publicKey.slice(0, 8)} at ${postBalance}`),
        SystemMessageType: new Proxy({}, { get: (_t, k) => String(k) }),
        canOperateTreasury: () => false,
        conservingTransaction,
    } as any;
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
