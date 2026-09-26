/**
 * Test Suite: the one-slot funding queue can't be held by a grant with an unusable amount (§3.7).
 * Source: docs/the-commons.md §3.7; #1167's review 4108122265.
 *
 * The funding queue takes one underfunded grant at a time, and while it is taken every other grant that
 * passes and needs to queue is marked execution_blocked "Funding queue is full" for good. The tick hands
 * the queued grant to executeDecision once the pool can cover it. A queued row whose amount parses to
 * NaN or Infinity ("ten", "1e999") used to satisfy neither side of that check, so it was never handed
 * over and held the slot for its full 90 days. A row can only get there by corruption: preflight blocks
 * a bad amount before a grant is ever queued.
 *
 * Verifies:
 *  1. A queued grant_enterprise or grant_hardship whose amount is a word, an overflowing string or number,
 *     negative, null, missing, absent params or unparseable params ends execution_blocked within ONE tick
 *     and frees the slot, with a poor pool and with a rich one. Nothing moves: the Commons, the recipient
 *     and the transaction log are unchanged.
 *  2. After each, a real underfunded grant takes the slot (passed_queued_for_funds, not "queue is full")
 *     and executes on the next tick once the pool can cover it.
 *  3. A valid queued grant still waits while the pool is short, and executes when the funds arrive.
 *  4. The enterprise-debt branch: a queued write_off_deficit whose deficit is not a finite number is
 *     blocked and frees the slot without touching the Commons; one whose deficit has already gone still
 *     completes, moving nothing.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-decisions-funding-queue.ts
 */

import {
    initStateEngine,
    getDecision,
    executeDecision,
    tickDecisions,
    getCommonsBalanceExact,
} from './state-engine.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { setCommonsBalance } from '@beanpool/core';

// Every assertion runs and failures are reported together, so one broken case does not hide the others.
let run = 0, passed = 0;
function assert(cond: any, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

function seedMember(pk: string, callsign: string, isTreasury = false): void {
    const joinedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
        INSERT INTO members (public_key, callsign, joined_at, status, credit_frozen, is_treasury, earned_credit)
        VALUES (?, ?, ?, 'active', 0, ?, 50)
    `).run(pk, callsign, joinedAt, isTreasury ? 1 : 0);
    db.prepare(`
        INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)
        ON CONFLICT(public_key) DO NOTHING
    `).run(pk);
}

// A Decision row set up directly at `status`, closed a day ago (well inside the 90-day queue expiry).
// `params` is the raw stored text, so corrupted rows can be written exactly as they would sit on disk.
let seq = 0;
function insertDecision(opts: { effect: string; subject: string; params: string | null; status: string }): string {
    const id = `fq-${Date.now()}-${++seq}`;
    const now = new Date().toISOString();
    const opened = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const closed = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
        INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params,
            franchise, status, opens_at, closes_at, created_at, updated_at)
        VALUES (?, ?, ?, 'Set up directly by the test', 'pool', ?, ?, ?, 'quadratic_trade', ?, ?, ?, ?, ?)
    `).run(id, AUTHOR, `Queue test ${opts.effect}`, opts.effect, opts.subject, opts.params, opts.status,
        opened, closed, opened, now);
    return id;
}

function queuedCount(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM decisions WHERE status = 'passed_queued_for_funds'").get() as any).c;
}

function decisionTxCount(id: string): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE auth_signer = ?').get(`system:decision:${id}`) as any).c;
}

const AUTHOR = 'fq_author_' + Date.now();
const ENTERPRISE = 'fq_ent_' + Date.now();
const MEMBER = 'fq_member_' + Date.now();
const REAL_ENTERPRISE = 'fq_real_ent_' + Date.now();

// Stored params text for each unusable amount. All of them reach preflight's "Invalid grant amount".
const BAD_PARAMS: Array<[string, string | null]> = [
    ['a word ("ten")', '{"amount":"ten"}'],
    ['an overflowing string ("1e999")', '{"amount":"1e999"}'],
    ['an overflowing number (1e999)', '{"amount":1e999}'],
    ['a negative amount (-5)', '{"amount":-5}'],
    ['a null amount', '{"amount":null}'],
    ['a missing amount', '{}'],
    ['no params', null],
    ['unparseable params', '{"amount": 500'],
];

async function runFundingQueueSuite() {
    console.log('🏛️ Funding queue vs unusable amounts (§3.7)...\n');

    initStateEngine();
    seedMember(AUTHOR, 'Queue Author');
    seedMember(ENTERPRISE, 'Queue Enterprise', true);
    seedMember(MEMBER, 'Queue Member');
    seedMember(REAL_ENTERPRISE, 'Real Enterprise', true);

    // ── 1 + 2. Unusable amounts free the slot within one tick; a real grant then takes it ──
    console.log('--- 1. Unusable amounts free the slot; 2. a real grant takes it after ---');
    for (const [effect, recipient, errorText] of [
        ['grant_enterprise', ENTERPRISE, 'Invalid grant amount'],
        ['grant_hardship', MEMBER, 'Invalid hardship grant amount'],
    ] as const) {
        for (const pool of [10, 1000]) {
            for (const [label, params] of BAD_PARAMS) {
                const tag = `${effect}, ${label}, pool ${pool}`;
                setCommonsBalance(pool);
                const recipientBefore = ledger.getAccount(recipient).balance;
                const bad = insertDecision({ effect, subject: recipient, params, status: 'passed_queued_for_funds' });
                assert(queuedCount() === 1, `[${tag}] the corrupted row holds the one queue slot before the tick`);

                tickDecisions();

                const after = getDecision(bad)!;
                assert(after.status === 'execution_blocked' && after.executionError === errorText,
                    `[${tag}] one tick blocks it with "${errorText}" (got ${after.status} / ${after.executionError ?? after.executionReason})`);
                assert(queuedCount() === 0, `[${tag}] the queue slot is free`);
                assert(getCommonsBalanceExact() === pool, `[${tag}] the Commons is unchanged (${getCommonsBalanceExact()})`);
                assert(ledger.getAccount(recipient).balance === recipientBefore && decisionTxCount(bad) === 0,
                    `[${tag}] the recipient got nothing and no transaction was written`);

                // A real grant the pool can't cover yet now takes the slot, then runs once the pool can.
                setCommonsBalance(10);
                const realBefore = ledger.getAccount(REAL_ENTERPRISE).balance;
                const real = insertDecision({ effect: 'grant_enterprise', subject: REAL_ENTERPRISE, params: '{"amount":500}', status: 'passed' });
                const res = executeDecision(real);
                assert(res.status === 'passed_queued_for_funds',
                    `[${tag}] a real 500-bean grant queues after it (got ${res.status}${res.error ? ' / ' + res.error : ''})`);
                setCommonsBalance(510);
                tickDecisions();
                assert(getDecision(real)!.status === 'executed'
                    && ledger.getAccount(REAL_ENTERPRISE).balance === realBefore + 500
                    && getCommonsBalanceExact() === 10,
                    `[${tag}] the real grant executes once the pool covers it`);
                // Leave nothing queued for the next case, whatever the outcome above.
                db.prepare("UPDATE decisions SET status = 'failed' WHERE status = 'passed_queued_for_funds'").run();
            }
        }
    }

    // ── 3. A valid queued grant still waits for funds and runs when they arrive ──
    console.log('\n--- 3. A valid queued grant waits, then runs ---');
    setCommonsBalance(10);
    const entBefore = ledger.getAccount(ENTERPRISE).balance;
    const valid = insertDecision({ effect: 'grant_enterprise', subject: ENTERPRISE, params: '{"amount":500}', status: 'passed_queued_for_funds' });
    tickDecisions();
    tickDecisions();
    assert(getDecision(valid)!.status === 'passed_queued_for_funds', 'A valid 500-bean grant stays queued while the pool holds 10');
    assert(getCommonsBalanceExact() === 10 && ledger.getAccount(ENTERPRISE).balance === entBefore && decisionTxCount(valid) === 0,
        'Nothing moves while it waits');
    setCommonsBalance(600);
    tickDecisions();
    assert(getDecision(valid)!.status === 'executed', 'It executes on the tick after the pool reaches 600');
    assert(ledger.getAccount(ENTERPRISE).balance === entBefore + 500 && getCommonsBalanceExact() === 100,
        'The enterprise gets 500 and the Commons drops to 100');
    assert(decisionTxCount(valid) === 1, 'One grant transaction carries the decision as its signer');
    assert(queuedCount() === 0, 'The slot is free again');

    // ── 4. The enterprise-debt branch ──
    console.log('\n--- 4. write_off_deficit in the queue ---');
    const DEBT_ENT = 'fq_debt_ent_' + Date.now();
    seedMember(DEBT_ENT, 'Debt Enterprise', true);
    setCommonsBalance(10);
    // A balance of minus infinity: corruption, but it makes the deficit Infinity.
    ledger.getAccount(DEBT_ENT).balance = -Infinity;
    const infWriteOff = insertDecision({ effect: 'write_off_deficit', subject: DEBT_ENT, params: null, status: 'passed_queued_for_funds' });
    tickDecisions();
    const infAfter = getDecision(infWriteOff)!;
    assert(infAfter.status === 'execution_blocked' && infAfter.executionError === 'Invalid enterprise deficit',
        `A queued write-off with an infinite deficit is blocked in one tick with "Invalid enterprise deficit" (got ${infAfter.status} / ${infAfter.executionError ?? infAfter.executionReason})`);
    assert(queuedCount() === 0, 'The queue slot is free');
    assert(getCommonsBalanceExact() === 10 && decisionTxCount(infWriteOff) === 0 && ledger.getAccount(DEBT_ENT).balance === -Infinity,
        'The Commons and the enterprise are unchanged, and no transaction was written');
    db.prepare("UPDATE decisions SET status = 'failed' WHERE status = 'passed_queued_for_funds'").run();

    // A write-off whose deficit has since been cleared still completes, moving nothing (unchanged behaviour).
    ledger.getAccount(DEBT_ENT).balance = 0;
    const clearedWriteOff = insertDecision({ effect: 'write_off_deficit', subject: DEBT_ENT, params: null, status: 'passed_queued_for_funds' });
    tickDecisions();
    assert(getDecision(clearedWriteOff)!.status === 'executed', 'A queued write-off with no deficit left completes on the next tick');
    assert(getCommonsBalanceExact() === 10 && decisionTxCount(clearedWriteOff) === 0 && ledger.getAccount(DEBT_ENT).balance === 0,
        'It moves nothing');
    assert(queuedCount() === 0, 'The queue slot is free');

    console.log(`\n${passed}/${run} funding queue checks passed`);
    if (passed !== run) throw new Error(`${run - passed} funding queue check(s) failed`);
    console.log('🎉 All funding queue checks PASSED!');
}

runFundingQueueSuite().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('Test suite failed with error:', err);
    process.exit(1);
});
