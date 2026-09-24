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
 * (d) transfer() is ATOMIC on its own (Part 8). Its five persistence steps — the transactions row, the
 *     sender's account row, the recipient's account row, the decay rows, the commons row — used to be
 *     separate autocommits, so a crash between any two left the books torn on disk: the classic one being
 *     the sender debited and the recipient never credited, i.e. beans destroyed. Forced mid-write failures
 *     at each boundary must now leave NOTHING persisted, in memory or in the rows, both when transfer() is
 *     the outermost transaction (the member-to-member send route's shape) and when it is a savepoint inside
 *     a caller's conservingTransaction (every escrow / settlement path).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ledger-rollback.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db, afterTransactionCommit } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { initTls } from './services/tls.js';
import { startHttpsServer } from './https-server.js';
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
    persistDecayEvents,
    persistCommonsBalance,
    reconcileLedgerFromDb,
} from './state-engine.js';

const HTTPS_PORT = 8558;

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

// ─── Part 8 helpers: transfer() atomicity ────────────────────────────────────────────────────────────

let tradeSeq = 0;
/**
 * Record a COMPLETED marketplace trade so `seller` has earned credit.
 *
 * transfer()'s direct-send gate refuses anyone whose `earnedCredit` is 0, and `makeMember`'s live offer
 * does not clear it — only a completed trade does. Every Part 8 sender needs this, because Part 8 is
 * specifically about the member-to-member send path rather than the escrow paths, which are gate-exempt.
 */
function giveEarnedCredit(seller: string, buyer: string, credits: number): void {
    const postId = `atomic-post-${tradeSeq++}`;
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status)
                VALUES (?, 'offer', 'misc', 'atomic', 'atomic', ?, ?, 'completed')`).run(postId, credits, seller);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status)
                VALUES (?, ?, ?, ?, ?, 'completed')`).run(`atomic-mtx-${tradeSeq++}`, postId, buyer, seller, credits);
}

/**
 * Arm a trigger that ABORTs the next write to one account row, and return its disarm function.
 *
 * This is how a crash mid-`transfer()` is simulated without a crash: SQLite refuses the statement, which
 * throws exactly where a torn write would have stopped. The EVENT matters and is not interchangeable —
 * member rows are written with `INSERT … ON CONFLICT DO UPDATE` (so an existing row fires UPDATE), while
 * `persistCommonsBalance` uses `INSERT OR REPLACE` (a delete+insert, which fires INSERT and never UPDATE).
 * An earlier draft armed UPDATE on COMMONS_POOL and silently never fired, so the test passed vacuously.
 */
function armAbort(name: string, event: 'INSERT' | 'UPDATE', publicKey: string): () => void {
    db.exec(`CREATE TEMP TRIGGER ${name} BEFORE ${event} ON accounts WHEN NEW.public_key = '${publicKey}'
             BEGIN SELECT RAISE(ABORT, '${name} forced failure'); END;`);
    return () => db.exec(`DROP TRIGGER ${name}`);
}

/**
 * The in-memory balance WITHOUT applying decay.
 *
 * `ledger.getAccount()` is not a read — it settles any owed demurrage as a side effect. Comparing memory
 * to a row through it on a deliberately backdated account therefore reports a mismatch it just created.
 * `getAllAccounts()` returns the map as it stands.
 */
function memBalanceRaw(pk: string): number {
    return ledger.getAllAccounts().find(a => a.id === pk)?.balance ?? 0;
}

/** A snapshot of everything a transfer would move, taken from the ROWS — what a restart would rebuild from. */
function snapshotRows(pks: string[]): { accounts: Record<string, { balance: number; epoch: number }>; commons: number; total: number } {
    const accounts: Record<string, { balance: number; epoch: number }> = {};
    for (const pk of pks) {
        const r = db.prepare('SELECT balance, last_demurrage_epoch AS epoch FROM accounts WHERE public_key = ?').get(pk) as any;
        accounts[pk] = { balance: r ? r.balance : 0, epoch: r ? r.epoch : 0 };
    }
    const commonsRow = db.prepare("SELECT balance FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as any;
    const sum = (db.prepare(`SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return { accounts, commons: commonsRow ? commonsRow.balance : 0, total: r4(sum + (commonsRow ? commonsRow.balance : 0)) };
}

/**
 * Assert a forced mid-write failure persisted NOTHING: no history row, both account rows untouched,
 * memory agreeing with the rows, and the node still summing to what it summed before.
 */
function assertNothingPersisted(label: string, before: ReturnType<typeof snapshotRows>, memo: string, pks: string[]): void {
    const historyRow = db.prepare('SELECT id FROM transactions WHERE memo = ?').get(memo);
    assert(!historyRow, `[${label}] No transactions row was written`);
    const after = snapshotRows(pks);
    for (const pk of pks) {
        assert(after.accounts[pk].balance === before.accounts[pk].balance,
            `[${label}] Account ${pk.substring(0, 12)} row unchanged (${after.accounts[pk].balance})`);
        assert(Math.abs(memBalanceRaw(pk) - after.accounts[pk].balance) < 0.0001,
            `[${label}] Account ${pk.substring(0, 12)} memory matches its row`);
    }
    assert(Math.abs(after.total - before.total) < 0.0001,
        `[${label}] Node total unchanged (${before.total} → ${after.total})`);
}

/** Sign a request the way the real middleware verifies it: METHOD\npath\nts\nnonce\nbody. */
function signedHeaders(path: string, body: string, pubHex: string, privateKey: crypto.KeyObject): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${body}`), privateKey).toString('base64');
    return {
        'Content-Type': 'application/json',
        'X-Public-Key': pubHex,
        'X-Signature': sig,
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
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

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 8: transfer() is atomic on its own
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 8: transfer() atomicity (unwrapped, nested, and over HTTP) ──');
    {
        // (a) The send route's shape: an UNWRAPPED transfer(), failing on the RECIPIENT's row.
        //     This is the bean-destroying case. The sender's row is written first, so before this fix a
        //     crash here left the debit durable with no matching credit, and boot rebuilds memory from
        //     exactly those rows.
        const alice = makeMember('AtomicAlice', 100);
        const bob = makeMember('AtomicBob', 10);
        const carol = makeMember('AtomicCarol');
        giveEarnedCredit(alice, carol, 50);
        giveEarnedCredit(bob, carol, 50);
        assertConservation('Pre-transfer-atomicity');

        {
            const memo = 'atomic probe: abort on recipient row';
            const before = snapshotRows([alice, bob]);
            const disarm = armAbort('abort_on_to', 'UPDATE', bob);
            let threw = '';
            try {
                transfer(alice, bob, 25, memo, 'direct', true);
            } catch (e: any) {
                threw = e?.message || String(e);
            } finally {
                disarm();
            }
            assert(/abort_on_to forced failure/.test(threw), `Forced failure on the recipient row propagated (got "${threw}")`);
            assertNothingPersisted('abort-on-recipient', before, memo, [alice, bob]);
            assertConservation('Post-abort-on-recipient');
        }

        // (b) The same, failing on the SENDER's row — history written, no balance moved.
        {
            const memo = 'atomic probe: abort on sender row';
            const before = snapshotRows([alice, bob]);
            const disarm = armAbort('abort_on_from', 'UPDATE', alice);
            let threw = '';
            try {
                transfer(alice, bob, 25, memo, 'direct', true);
            } catch (e: any) {
                threw = e?.message || String(e);
            } finally {
                disarm();
            }
            assert(/abort_on_from forced failure/.test(threw), `Forced failure on the sender row propagated (got "${threw}")`);
            assertNothingPersisted('abort-on-sender', before, memo, [alice, bob]);
            assertConservation('Post-abort-on-sender');
        }

        // (b cont.) …and on the COMMONS_POOL row, with a real decay in flight so the last two steps
        //          (persistDecayEvents + persistCommonsBalance) are actually reached.
        {
            const dave = makeMember('AtomicDave', 5000);
            giveEarnedCredit(dave, carol, 50);
            persistDecayEvents();
            persistCommonsBalance();
            // Backdate the window so dave's next read owes demurrage — the decay rows are step 4 of 5.
            const staleEpoch = Math.floor(Date.now() / 86400000) - 60;
            db.prepare('UPDATE accounts SET last_demurrage_epoch = ? WHERE public_key = ?').run(staleEpoch, dave);
            reconcileLedgerFromDb();

            const memo = 'atomic probe: abort on commons row';
            const before = snapshotRows([dave, bob]);
            // INSERT, not UPDATE: persistCommonsBalance is an INSERT OR REPLACE.
            const disarm = armAbort('abort_on_commons', 'INSERT', 'COMMONS_POOL');
            let threw = '';
            try {
                transfer(dave, bob, 25, memo, 'direct', true);
            } catch (e: any) {
                threw = e?.message || String(e);
            } finally {
                disarm();
            }
            assert(/abort_on_commons forced failure/.test(threw), `Forced failure on the commons row propagated (got "${threw}")`);
            assertNothingPersisted('abort-on-commons', before, memo, [dave, bob]);
            assert(db.prepare("SELECT id FROM transactions WHERE from_pubkey = ? AND memo LIKE 'Circulation fee%'").get(dave) === undefined,
                '[abort-on-commons] No demurrage row survived the rollback either');
            assertConservation('Post-abort-on-commons');

            // The successful version of the same send: decay settles, beans move, books still balance.
            const daveBefore = ledger.getAccount(dave).balance;
            const bobBefore = ledger.getAccount(bob).balance;
            const ok = transfer(dave, bob, 25, 'atomic probe: commons path succeeds', 'direct', true);
            assert(!!ok, 'The same send succeeds once the forced failure is disarmed');
            assert(Math.abs(ledger.getAccount(dave).balance - (daveBefore - 25)) < 0.0001, 'Sender debited exactly 25 Beans');
            assert(Math.abs(ledger.getAccount(bob).balance - (bobBefore + 25)) < 0.0001, 'Recipient credited exactly 25 Beans');
            assertMemoryMatchesDb(dave);
            assertMemoryMatchesDb(bob);
            assertConservation('Post-successful-send');
        }

        // (c) The savepoint path: transfer() inside a caller's own conservingTransaction. The inner failure
        //     must leave the OUTER transaction's earlier work intact when the caller swallows it, and the
        //     outer's post-commit hooks must fire exactly once, at the outer commit.
        {
            const erin = makeMember('AtomicErin', 200);
            const frank = makeMember('AtomicFrank', 10);
            giveEarnedCredit(erin, carol, 50);
            assertConservation('Pre-nested-transfer');

            const memo = 'atomic probe: nested abort';
            const before = snapshotRows([erin, frank]);
            let hookFired = 0;
            let hookFiredInsideBlock = false;
            let innerThrew = '';

            conservingTransaction(() => {
                // Outer work that MUST survive the inner failure.
                db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status)
                            VALUES ('atomic-outer-post', 'offer', 'misc', 'outer', 'outer', 1, ?, 'active')`).run(erin);
                afterTransactionCommit(() => { hookFired++; });

                const disarm = armAbort('abort_nested', 'UPDATE', frank);
                try {
                    transfer(erin, frank, 25, memo, 'direct', true);
                } catch (e: any) {
                    innerThrew = e?.message || String(e);
                } finally {
                    disarm();
                }
                hookFiredInsideBlock = hookFired > 0;
                // The caller SWALLOWS the inner failure and commits — the harshest shape for the savepoint,
                // because nothing downstream will repair a torn inner write.
            });

            assert(/abort_nested forced failure/.test(innerThrew), `Nested forced failure propagated to the caller (got "${innerThrew}")`);
            assert(!hookFiredInsideBlock, 'Post-commit hook did NOT fire inside the outer block');
            assert(hookFired === 1, `Post-commit hook fired exactly once, at the outer commit (fired ${hookFired}×)`);
            const outerPost = db.prepare("SELECT id FROM posts WHERE id = 'atomic-outer-post'").get();
            assert(!!outerPost, 'The outer transaction\'s own work survived the inner savepoint rollback');
            assertNothingPersisted('nested-abort', before, memo, [erin, frank]);
            assertConservation('Post-nested-abort');
        }

        // (c cont.) The nesting hazard this fix had to close first, kept as a regression.
        //
        // Lazy demurrage applied between the outer BEGIN and transfer()'s inner call sits queued and
        // UNFLUSHED: the account's debit is memory-only while the Commons credit is already in the global.
        // conservingTransaction used to skip its pre-flush when nested, so it snapshotted that credit,
        // the inner block flushed the debit INSIDE the savepoint, and a rollback then restored the credit
        // with its debit gone — minting beans. Measured at 208.58 Beans on one failed send before the fix.
        {
            const gita = makeMember('AtomicGita', 60);
            const hugo = makeMember('AtomicHugo', 10);
            giveEarnedCredit(gita, carol, 50);
            // A fat, stale bystander that decays the moment anything reads it.
            const stale = makeMember('AtomicStale', 5000);
            persistDecayEvents();
            persistCommonsBalance();
            db.prepare('UPDATE accounts SET last_demurrage_epoch = ? WHERE public_key = ?')
                .run(Math.floor(Date.now() / 86400000) - 60, stale);
            reconcileLedgerFromDb();

            const before = snapshotRows([gita, hugo, stale]);
            conservingTransaction(() => {
                // Touching the stale account queues decay that is not yet in any row.
                const decayed = ledger.getAccount(stale);
                assert(decayed.balance < 5000, 'Bystander account decayed in memory but not yet in its row');
                const disarm = armAbort('abort_mint', 'INSERT', 'COMMONS_POOL');
                try {
                    transfer(gita, hugo, 5, 'atomic probe: mint regression', 'direct', true);
                } catch { /* swallowed by the caller, exactly as the hazard requires */ }
                finally { disarm(); }
            });
            // Flush whatever memory still holds, then read the books from the ROWS alone.
            persistDecayEvents();
            persistCommonsBalance();
            const after = snapshotRows([gita, hugo, stale]);
            assert(Math.abs(after.total - before.total) < 0.0001,
                `No beans minted by the nested rollback (${before.total} → ${after.total})`);
            assertConservation('Post-nested-mint-regression');
        }

        // (d) The real route, over HTTPS, through the real signing middleware.
        {
            await initTls();
            await startHttpsServer(HTTPS_PORT);
            const base = `https://localhost:${HTTPS_PORT}`;
            const path = '/api/ledger/transfer';

            const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
            const senderHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url)
                        VALUES (?, 'AtomicRoute', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`).run(senderHex, AVATAR);
            db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(senderHex);
            ledger.initializeGenesisAccount(senderHex);
            transfer('genesis', senderHex, 100, 'seed route sender', 'direct', true);
            giveEarnedCredit(senderHex, carol, 50);
            const recipient = makeMember('AtomicRouteRecipient', 10);
            assertConservation('Pre-route-send');

            // A successful send still works end to end.
            {
                const senderBefore = ledger.getAccount(senderHex).balance;
                const recipientBefore = ledger.getAccount(recipient).balance;
                const body = JSON.stringify({ from: senderHex, to: recipient, amount: 7, memo: 'route send ok' });
                const res = await fetch(`${base}${path}`, { method: 'POST', headers: signedHeaders(path, body, senderHex, privateKey), body });
                const json: any = await res.json().catch(() => ({}));
                assert(res.status === 200 && json?.success === true, `Signed send returns 200 (got ${res.status} ${JSON.stringify(json)})`);
                assert(Math.abs(ledger.getAccount(senderHex).balance - (senderBefore - 7)) < 0.0001, 'Route send debited the sender by 7 Beans');
                assert(Math.abs(ledger.getAccount(recipient).balance - (recipientBefore + 7)) < 0.0001, 'Route send credited the recipient by 7 Beans');
                assertMemoryMatchesDb(senderHex);
                assertMemoryMatchesDb(recipient);
                assertConservation('Post-route-send-success');
            }

            // …and a forced mid-write failure on the same route persists nothing.
            {
                const before = snapshotRows([senderHex, recipient]);
                const memo = 'route send torn';
                const body = JSON.stringify({ from: senderHex, to: recipient, amount: 7, memo });
                const disarm = armAbort('abort_route', 'UPDATE', recipient);
                let res: Response;
                try {
                    res = await fetch(`${base}${path}`, { method: 'POST', headers: signedHeaders(path, body, senderHex, privateKey), body });
                } finally {
                    disarm();
                }
                assert(res.status >= 400, `Torn route send returns an error status (got ${res.status})`);
                assertNothingPersisted('route-torn-send', before, memo, [senderHex, recipient]);
                assertConservation('Post-route-send-failure');
            }
        }
    }

    console.log(`\nAll ${passed}/${run} checks passed.`);
    console.log('⭐️ Ledger rollback & conservation invariants verified.');
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
