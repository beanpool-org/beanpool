/**
 * Regression Test Suite: Ledger Rollback & Transaction Invariants
 *
 * Verifies:
 * (a) Forced throw after transfer inside each path unwinds in-memory balances to match DB:
 *     - approvePostRequest
 *     - acceptPost
 *     - completePostTransaction
 *     - cancelPostTransaction
 *     - moveToCommons
 *     - adminDeletePost
 * (b) Two completions of the same deal result in exactly one payout and ledger conservation intact.
 *     CAS prevents duplicate completion and duplicate cancellation.
 * (c) Post-commit hooks inside rolled-back nested transactions do NOT fire on outer commit.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ledger-rollback.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db, afterTransactionCommit } from './db/db.js';
import { ledger } from './engine/ledger.js';
import {
    initStateEngine,
    moveToCommons,
    getCommonsBalanceExact,
    conservingTransaction,
    createTreasury,
    adminAssignTreasuryOperator,
    createPost,
    requestPost,
    approvePostRequest,
    acceptPost,
    completePostTransaction,
    cancelPostTransaction,
    adminDeletePost,
    transfer,
    runLedgerAudit,
} from './state-engine.js';

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

const r4 = (n: number) => Math.round(n * 10000) / 10000;

function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return r4(accounts + getCommonsBalanceExact());
}

function assertMemoryMatchesDb(pk: string): void {
    const dbRow = db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as any;
    const dbBal = dbRow ? dbRow.balance : 0;
    const memBal = ledger.getAccount(pk).balance;
    assert(Math.abs(dbBal - memBal) < 0.0001, `Account ${pk.substring(0, 12)} memory (${memBal}) matches DB (${dbBal})`);
}

function assertCommonsMatchesDb(): void {
    const dbRow = db.prepare("SELECT balance FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as any;
    const dbBal = dbRow ? dbRow.balance : 0;
    const memBal = getCommonsBalanceExact();
    assert(Math.abs(dbBal - memBal) < 0.0001, `Commons pool memory (${memBal}) matches DB (${dbBal})`);
}

function assertConservation(stepName: string): void {
    const audit = runLedgerAudit();
    assert(audit.ok, `[${stepName}] Ledger audit passed`);
    assert(Math.abs(audit.drift) < 0.0001, `[${stepName}] Ledger conservation preserved (drift=${audit.drift})`);
    assert(Math.abs(nodeTotal()) < 0.0001, `[${stepName}] Node total is zero (${nodeTotal()})`);
    assertCommonsMatchesDb();
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function makeMember(callsign: string, initialBalance = 0): string {
    const pk = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`).run(pk, callsign, AVATAR);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch)
                VALUES (?, 0, 0)`).run(pk);
    ledger.initializeGenesisAccount(pk);
    if (initialBalance > 0) {
        transfer('genesis', pk, initialBalance, `seed ${callsign}`, 'direct', true);
    }
    // Give at least 1 trade / earned credit so sender gates pass
    createPost('offer', 'general', `${callsign} service`, 'Help', 5, 'fixed', pk, undefined, undefined, undefined, true);
    return pk;
}

async function main() {
    console.log('Testing ledger rollback & transaction conservation invariants...\n');
    initStateEngine();
    assertConservation('Startup');

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 1: Nested transaction commit hooks (apps/server/src/db/db.ts)
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 1: Nested transaction hook rollback ──');
    {
        let outerFired = false;
        let innerRolledBackFired = false;
        let innerSucceededFired = false;

        db.transaction(() => {
            afterTransactionCommit(() => { outerFired = true; });

            try {
                db.transaction(() => {
                    afterTransactionCommit(() => { innerRolledBackFired = true; });
                    throw new Error('Inner rollback');
                })();
            } catch { }

            db.transaction(() => {
                afterTransactionCommit(() => { innerSucceededFired = true; });
            })();
        })();

        assert(outerFired, 'Outer transaction commit hook executed');
        assert(!innerRolledBackFired, 'Inner transaction hook from rolled-back savepoint did NOT fire');
        assert(innerSucceededFired, 'Inner transaction hook from committed savepoint merged and executed');

        // Outer rollback discards all hooks
        let outerFailedFired = false;
        try {
            db.transaction(() => {
                afterTransactionCommit(() => { outerFailedFired = true; });
                throw new Error('Outer rollback');
            })();
        } catch { }
        assert(!outerFailedFired, 'Outer rolled-back transaction hook did NOT fire');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 2: moveToCommons rollback
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 2: moveToCommons rollback ──');
    {
        const { publicKey: treasury } = createTreasury('RollbackTreasury', AVATAR, 200);
        transfer('genesis', treasury, 100, 'seed treasury', 'direct', true);
        assertConservation('Pre-moveToCommons');

        const balBefore = ledger.getAccount(treasury).balance;
        const commonsBefore = getCommonsBalanceExact();
        let threw = false;
        try {
            conservingTransaction(() => {
                moveToCommons(treasury, 40, 'test sweep');
                throw new Error('Forced crash inside sweep');
            });
        } catch (e: any) {
            threw = true;
            assert(e.message === 'Forced crash inside sweep', 'Caught forced crash');
        }
        assert(threw, 'conservingTransaction caught and rethrew');
        assertMemoryMatchesDb(treasury);
        assertCommonsMatchesDb();
        assert(ledger.getAccount(treasury).balance === balBefore, 'Treasury in-memory balance unwound to pre-crash value');
        assert(getCommonsBalanceExact() === commonsBefore, 'Commons in-memory balance unwound to pre-crash value');
        assertConservation('Post-moveToCommons-rollback');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 3: approvePostRequest rollback
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 3: approvePostRequest rollback ──');
    {
        const { publicKey: enterprise } = createTreasury('NeedBakery', AVATAR, 200);
        const keeper1 = makeMember('NeedKeeper1', 100);
        const keeper2 = makeMember('NeedKeeper2', 100);
        const supplier = makeMember('FlourSupplier', 100);
        adminAssignTreasuryOperator(enterprise, keeper1, 'admin');
        adminAssignTreasuryOperator(enterprise, keeper2, 'admin');

        // Enterprise has active offer and creates a Need
        createPost('offer', 'food', 'Enterprise Bread', 'Fresh bread', 5, 'fixed', enterprise, undefined, undefined, undefined, true);
        const need = createPost('need', 'goods', 'Organic flour', '10kg flour', 30, 'fixed', enterprise)!;
        const bid = requestPost(need.id, supplier);

        const entBalBefore = ledger.getAccount(enterprise).balance;
        const supBalBefore = ledger.getAccount(supplier).balance;

        let threw = false;
        try {
            conservingTransaction(() => {
                approvePostRequest(bid.id, enterprise, { authSigner: keeper1 });
                throw new Error('Forced crash after approvePostRequest');
            });
        } catch (e: any) {
            threw = true;
            assert(e.message === 'Forced crash after approvePostRequest', 'Caught forced crash');
        }
        assert(threw, 'conservingTransaction caught and rethrew error');
        assertMemoryMatchesDb(enterprise);
        assertMemoryMatchesDb(supplier);
        assertMemoryMatchesDb(`escrow_${bid.id}`);
        assert(ledger.getAccount(enterprise).balance === entBalBefore, 'Enterprise balance unwound');
        assert(ledger.getAccount(supplier).balance === supBalBefore, 'Supplier balance unwound');
        assert(ledger.getAccount(`escrow_${bid.id}`).balance === 0, 'Escrow in-memory balance unwound to 0');
        const txRow = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(bid.id) as any;
        assert(txRow.status === 'requested', 'Transaction row status rolled back to requested');
        assertConservation('Post-approvePostRequest-rollback');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 4: acceptPost rollback
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 4: acceptPost rollback ──');
    {
        const seller = makeMember('OfferSeller', 50);
        const buyer = makeMember('OfferBuyer', 100);
        const offer = createPost('offer', 'skills', 'Woodworking', 'Chairs', 40, 'fixed', seller, undefined, undefined, undefined, true)!;

        const buyerBalBefore = ledger.getAccount(buyer).balance;
        const sellerBalBefore = ledger.getAccount(seller).balance;

        let threw = false;
        try {
            conservingTransaction(() => {
                acceptPost(offer.id, buyer);
                throw new Error('Forced crash after acceptPost');
            });
        } catch (e: any) {
            threw = true;
            assert(e.message === 'Forced crash after acceptPost', 'Caught forced crash');
        }
        assert(threw, 'conservingTransaction caught and rethrew error');
        assertMemoryMatchesDb(buyer);
        assertMemoryMatchesDb(seller);
        assert(ledger.getAccount(buyer).balance === buyerBalBefore, 'Buyer in-memory balance unwound');
        assert(ledger.getAccount(seller).balance === sellerBalBefore, 'Seller in-memory balance unwound');
        const postRow = db.prepare('SELECT status, accepted_by FROM posts WHERE id = ?').get(offer.id) as any;
        assert(postRow.status === 'active', 'Post status rolled back to active');
        assert(postRow.accepted_by === null, 'Post accepted_by rolled back to NULL');
        assertConservation('Post-acceptPost-rollback');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 5: completePostTransaction rollback & duplicate completion CAS
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 5: completePostTransaction rollback & duplicate completion CAS ──');
    {
        const seller = makeMember('CompleteSeller', 50);
        const buyer = makeMember('CompleteBuyer', 100);
        const offer = createPost('offer', 'skills', 'Carpentry', 'Shelves', 30, 'fixed', seller, undefined, undefined, undefined, true)!;
        const deal = acceptPost(offer.id, buyer);
        assert(deal.status === 'pending', 'Deal is pending');
        assertMemoryMatchesDb(buyer);
        assertMemoryMatchesDb(`escrow_${deal.id}`);
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 30, '30 beans in escrow');

        // (5a) Forced rollback on completion
        const sellerBalBefore = ledger.getAccount(seller).balance;
        let threw = false;
        try {
            conservingTransaction(() => {
                completePostTransaction(deal.id, buyer);
                throw new Error('Forced crash after completion payout');
            });
        } catch (e: any) {
            threw = true;
            assert(e.message === 'Forced crash after completion payout', 'Caught forced crash');
        }
        assert(threw, 'conservingTransaction caught and rethrew error');
        assertMemoryMatchesDb(seller);
        assertMemoryMatchesDb(buyer);
        assertMemoryMatchesDb(`escrow_${deal.id}`);
        assert(ledger.getAccount(seller).balance === sellerBalBefore, 'Seller did not keep payout on rollback');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 30, 'Escrow retains 30 beans on rollback');
        const dealRow = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(deal.id) as any;
        assert(dealRow.status === 'pending', 'Deal status rolled back to pending');
        assertConservation('Post-completePostTransaction-rollback');

        // (5b) Successful completion
        const completed = completePostTransaction(deal.id, buyer);
        assert(completed !== null && completed.status === 'completed', 'Deal completed successfully');
        const sellerBalAfter = ledger.getAccount(seller).balance;
        // Payout: 30 - 1.5% fee (0.45) = 29.55 beans
        assert(sellerBalAfter === sellerBalBefore + 29.55, 'Seller received payout minus 1.5% fee');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 0, 'Escrow account drained to 0');
        assertConservation('Post-first-completion');

        // (5c) Sequential second completion returns alreadyCompleted: true without extra payout
        const secondRes = completePostTransaction(deal.id, buyer);
        assert(secondRes !== null && secondRes.alreadyCompleted === true, 'Sequential second completion returns alreadyCompleted: true');
        assert(ledger.getAccount(seller).balance === sellerBalAfter, 'Seller received NO extra payout on second completion attempt');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 0, 'Escrow balance remains 0');
        assertMemoryMatchesDb(seller);
        assertMemoryMatchesDb(buyer);
        assertConservation('Post-duplicate-completion-sequential');

        // (5d) Concurrent race: CAS status update fails closed before any transfer
        const offer2 = createPost('offer', 'skills', 'Carpentry 2', 'Shelves 2', 30, 'fixed', seller, undefined, undefined, undefined, true)!;
        const deal2 = acceptPost(offer2.id, buyer);
        completePostTransaction(deal2.id, buyer);
        const sellerBalAfter2 = ledger.getAccount(seller).balance;

        let concurrentThrew = false;
        let concurrentMsg = '';
        try {
            conservingTransaction(() => {
                const updateRes = db.prepare(`UPDATE marketplace_transactions SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'pending'`)
                    .run(new Date().toISOString(), deal2.id);
                if (updateRes.changes === 0) throw new Error('Deal was already completed or cancelled');
                transfer(`escrow_${deal2.id}`, seller, 30, 'Escrow payout', 'escrow', false);
            });
        } catch (e: any) {
            concurrentThrew = true;
            concurrentMsg = e.message;
        }
        assert(concurrentThrew, 'Concurrent second transaction throws on CAS update');
        assert(concurrentMsg.includes('Deal was already completed or cancelled'), 'CAS update throws expected message');
        assert(ledger.getAccount(seller).balance === sellerBalAfter2, 'Seller received NO second payout on race');
        assertMemoryMatchesDb(seller);
        assertConservation('Post-concurrent-race-completion');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 6: cancelPostTransaction rollback & duplicate cancellation CAS
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 6: cancelPostTransaction rollback & duplicate cancellation CAS ──');
    {
        const seller = makeMember('CancelSeller', 50);
        const buyer = makeMember('CancelBuyer', 100);
        const offer = createPost('offer', 'goods', 'Pottery bowl', 'Handmade', 25, 'fixed', seller, undefined, undefined, undefined, true)!;
        const deal = acceptPost(offer.id, buyer);
        assert(deal.status === 'pending', 'Deal is pending');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 25, '25 beans in escrow');

        // (6a) Forced rollback on cancel
        const buyerBalBefore = ledger.getAccount(buyer).balance;
        let threw = false;
        try {
            conservingTransaction(() => {
                cancelPostTransaction(deal.id, buyer);
                throw new Error('Forced crash after cancel refund');
            });
        } catch (e: any) {
            threw = true;
            assert(e.message === 'Forced crash after cancel refund', 'Caught forced crash');
        }
        assert(threw, 'conservingTransaction caught and rethrew error');
        assertMemoryMatchesDb(buyer);
        assertMemoryMatchesDb(`escrow_${deal.id}`);
        assert(ledger.getAccount(buyer).balance === buyerBalBefore, 'Buyer did not keep refund on rollback');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 25, 'Escrow retains 25 beans on rollback');
        const dealRow = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(deal.id) as any;
        assert(dealRow.status === 'pending', 'Deal status rolled back to pending');
        assertConservation('Post-cancelPostTransaction-rollback');

        // (6b) Successful cancellation
        const cancelled = cancelPostTransaction(deal.id, buyer);
        assert(cancelled !== null && cancelled.status === 'cancelled', 'Deal cancelled successfully');
        const buyerBalAfter = ledger.getAccount(buyer).balance;
        assert(buyerBalAfter === buyerBalBefore + 25, 'Buyer received full refund');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 0, 'Escrow account drained to 0');
        assertConservation('Post-first-cancellation');

        // (6c) Sequential second cancel returns null without moving funds
        const secondCancel = cancelPostTransaction(deal.id, buyer);
        assert(secondCancel === null, 'Sequential second cancellation returns null without moving funds');
        assert(ledger.getAccount(buyer).balance === buyerBalAfter, 'Buyer received NO extra refund on second cancel attempt');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 0, 'Escrow balance remains 0');
        assertMemoryMatchesDb(buyer);
        assertConservation('Post-duplicate-cancellation-sequential');

        // (6d) Concurrent cancel race condition: CAS status update fails before transfer
        const offer2 = createPost('offer', 'goods', 'Pottery bowl 2', 'Handmade 2', 25, 'fixed', seller, undefined, undefined, undefined, true)!;
        const deal2 = acceptPost(offer2.id, buyer);
        cancelPostTransaction(deal2.id, buyer);
        const buyerBalAfter2 = ledger.getAccount(buyer).balance;

        let concurrentCancelThrew = false;
        let concurrentCancelMsg = '';
        try {
            conservingTransaction(() => {
                const updateRes = db.prepare(`UPDATE marketplace_transactions SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'pending'`)
                    .run(new Date().toISOString(), deal2.id);
                if (updateRes.changes === 0) throw new Error('Deal was already completed or cancelled');
                transfer(`escrow_${deal2.id}`, buyer, 25, 'Escrow refund', 'escrow', true);
            });
        } catch (e: any) {
            concurrentCancelThrew = true;
            concurrentCancelMsg = e.message;
        }
        assert(concurrentCancelThrew, 'Concurrent second cancellation throws on CAS update');
        assert(concurrentCancelMsg.includes('Deal was already completed or cancelled'), 'CAS update throws expected message on cancel race');
        assert(ledger.getAccount(buyer).balance === buyerBalAfter2, 'Buyer received NO extra refund on cancel race');
        assertMemoryMatchesDb(buyer);
        assertConservation('Post-concurrent-race-cancellation');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 7: adminDeletePost rollback with pending escrow
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 7: adminDeletePost rollback with pending escrow ──');
    {
        const seller = makeMember('AdminDelSeller', 50);
        const buyer = makeMember('AdminDelBuyer', 100);
        const offer = createPost('offer', 'goods', 'Abusive item', 'Bad listing', 20, 'fixed', seller, undefined, undefined, undefined, false)!;
        const deal = acceptPost(offer.id, buyer);
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 20, '20 beans in escrow');

        const buyerBalBefore = ledger.getAccount(buyer).balance;

        // Forced rollback inside adminDeletePost
        let threw = false;
        try {
            conservingTransaction(() => {
                adminDeletePost(offer.id);
                throw new Error('Forced crash after adminDeletePost refund');
            });
        } catch (e: any) {
            threw = true;
            assert(e.message === 'Forced crash after adminDeletePost refund', 'Caught forced crash');
        }
        assert(threw, 'conservingTransaction caught and rethrew error');
        assertMemoryMatchesDb(buyer);
        assertMemoryMatchesDb(`escrow_${deal.id}`);
        assert(ledger.getAccount(buyer).balance === buyerBalBefore, 'Buyer did not keep refund on rollback');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 20, 'Escrow retains 20 beans on rollback');
        const postRow = db.prepare('SELECT active, status FROM posts WHERE id = ?').get(offer.id) as any;
        assert(postRow.active === 1 && postRow.status === 'pending', 'Post row active and status rolled back');
        assertConservation('Post-adminDeletePost-rollback');

        // Successful adminDeletePost
        const deleted = adminDeletePost(offer.id);
        assert(deleted, 'adminDeletePost succeeded');
        assert(ledger.getAccount(buyer).balance === buyerBalBefore + 20, 'Buyer refunded upon post deletion');
        assert(ledger.getAccount(`escrow_${deal.id}`).balance === 0, 'Escrow drained to 0');
        assertConservation('Post-adminDeletePost-success');
    }

    console.log(`\nAll ${passed}/${run} checks passed.`);
    console.log('⭐️ Ledger rollback & conservation invariants verified.');
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
