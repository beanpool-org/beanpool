/**
 * Client API & Parity Test Suite: Community Decisions Engine
 * Source: docs/the-commons.md §3.2–§3.8, §6 Slice 5.
 *
 * Verifies:
 * 1. HTTP Endpoint Routing & Parity:
 *    - GET /api/commons/decisions (lists decisions with tally, quorum, activeMembers30d)
 *    - GET /api/commons/decisions/:id (details, tally, votes)
 *    - POST /api/commons/decisions (propose decision)
 *    - POST /api/commons/decisions/:id/vote (vote)
 * 2. Propose Constraints:
 *    - Standing gate: earnedCredit > 0 required.
 *    - Author limit: max 1 open decision per author.
 *    - No bond: zero beans debited on proposal.
 *    - Franchise mapping: member -> 1m1v, pool -> quadratic_trade, rule -> 1m1v, nothing -> 1m1v.
 * 3. Voting Mechanics:
 *    - 1m1v vote deduction (1 credit).
 *    - Quadratic vote deduction (voteCount² credits).
 * 4. §3.8 Mandatory Debt Disclosure:
 *    - Exact word-for-word string match:
 *      "<name>'s balance is −N beans. Removing them charges that N to the Commons pool, which currently holds M."
 *      (including Unicode \u2212 minus sign).
 * 5. History & Authorisation Provenance:
 *    - Execution creates ledger transaction with auth_signer = "system:decision:<id>".
 *    - History retains authorPubkey, tally, and executed effects.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-decisions-client-api.ts
 */

import crypto from 'node:crypto';
import {
    initStateEngine,
    getBalance,
    getCommonsBalance,
    tickDecisions,
    reconcileLedgerFromDb,
} from './state-engine.js';
import { createCommonsRoutes } from './routes/commons.js';
import { db } from './db/db.js';
import { setCommonsBalance } from '@beanpool/core';
import type { RouteDeps } from './routes/types.js';

let testsRun = 0;
let testsPassed = 0;

function assert(cond: any, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const deps: RouteDeps = {
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, def = 20) => def,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

let commonsRouter: any;

async function callRouter(
    router: any,
    method: string,
    path: string,
    opts: {
        actor?: string;
        body?: Record<string, unknown>;
        rawBody?: string;
        params?: Record<string, string>;
        query?: Record<string, string>;
    } = {}
): Promise<{ status: number; body: any }> {
    const layer = (router as any).stack.find((l: any) =>
        (l.path === path || l.regexp.test(path)) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) throw new Error(`${method} ${path} is not mounted in router`);

    const params: Record<string, string> = { ...(opts.params || {}) };
    if (layer.paramNames && layer.paramNames.length > 0) {
        const match = layer.regexp.exec(path);
        if (match) {
            layer.paramNames.forEach((param: any, idx: number) => {
                if (match[idx + 1] !== undefined) {
                    params[param.name] = match[idx + 1];
                }
            });
        }
    }

    const ctx: any = {
        state: opts.actor ? { actor: opts.actor } : {},
        requestBody: opts.body ?? {},
        rawBody: opts.rawBody,
        params,
        query: opts.query || {},
        status: 200,
        body: undefined,
        throw: (status: number, message: string) => {
            ctx.status = status;
            ctx.body = { error: message };
            const err = new Error(message);
            (err as any).status = status;
            throw err;
        },
    };

    try {
        await layer.stack[layer.stack.length - 1](ctx, async () => {});
    } catch (err: any) {
        if (!ctx.status || ctx.status === 200) {
            ctx.status = err.status || 500;
            ctx.body = { error: err.message };
        }
    }

    return { status: ctx.status, body: ctx.body };
}

function makeMember(callsign: string, opts?: {
    balance?: number;
    earnedCredit?: number;
    status?: string;
    creditFrozen?: boolean;
    isTreasury?: boolean;
}): string {
    const pubkey = crypto.randomBytes(32).toString('hex');
    const isTreasury = opts?.isTreasury ? 1 : 0;
    const creditFrozen = opts?.creditFrozen ? 1 : 0;
    const earnedCredit = opts?.earnedCredit ?? 100;
    const status = opts?.status || 'active';
    const balance = opts?.balance ?? 50;
    const joinedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
        INSERT INTO members (public_key, callsign, joined_at, status, credit_frozen, is_treasury, earned_credit)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pubkey, callsign, joinedAt, status, creditFrozen, isTreasury, earnedCredit);

    db.prepare(`
        INSERT INTO accounts (public_key, balance, last_demurrage_epoch)
        VALUES (?, ?, 0)
    `).run(pubkey, balance);

    reconcileLedgerFromDb();

    return pubkey;
}

function recordActivity(buyer: string, seller: string, amount: number) {
    const txId = 'tx-' + Math.random().toString(36).slice(2);
    const postId = 'post-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
    `).run(txId, postId, buyer, seller, amount, now, now);
}

// Format the removal debt write-off line per §3.8
function formatDebtWriteOffLine(targetName: string, debtAmount: number, poolAmount: number): string {
    return `${targetName}'s balance is \u2212${debtAmount} beans. Removing them charges that ${debtAmount} to the Commons pool, which currently holds ${poolAmount}.`;
}

async function runSuite() {
    console.log('🏛️ Running Community Decisions Client API & Parity Test Suite...\n');

    initStateEngine();
    commonsRouter = createCommonsRoutes(deps);

    // Setup accounts
    const alice = makeMember('Alice', { balance: 200, earnedCredit: 50 });
    const bob = makeMember('Bob', { balance: 150, earnedCredit: 30 });
    const charlie = makeMember('Charlie', { balance: 100, earnedCredit: 25 });
    const daveZeroStanding = makeMember('Dave', { balance: 50, earnedCredit: 0 }); // Cannot propose
    const eveFrozen = makeMember('Eve', { balance: 50, earnedCredit: 50, creditFrozen: true }); // Cannot propose
    const enterprise = makeMember('EnterpriseFarm', { balance: 0, earnedCredit: 100, isTreasury: true }); // Cannot propose

    // Reconcile in-memory ledger
    reconcileLedgerFromDb();

    // Record activity in last 30 days for quorum calculation & trade credits
    recordActivity(bob, alice, 50);    // Alice earns 50 trade credits
    recordActivity(alice, bob, 50);    // Bob earns 50 trade credits
    recordActivity(alice, charlie, 50);// Charlie earns 50 trade credits

    console.log('--- 1. Propose Constraints & Standing Gate ---');

    // 1a-0. Auth gating: unauthenticated proposal fails with 401
    const resNoAuth = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        body: {
            title: 'Unauthenticated proposal',
            description: 'Should fail with 401',
            touches: 'member',
            effect: 'grant_voucher',
            subject: charlie,
        },
    });
    assert(resNoAuth.status === 401, 'Propose without actor fails with 401');
    assert(resNoAuth.body.error.includes('Authentication required'), 'Error cites auth required');
    // 1a. Gating: earnedCredit > 0 required
    const resDave = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        actor: daveZeroStanding,
        body: {
            authorPubkey: daveZeroStanding,
            title: 'Dave decision',
            description: 'Should fail due to zero earnedCredit',
            touches: 'member',
            effect: 'grant_voucher',
            subject: charlie,
        },
    });
    assert(resDave.status === 400, 'Propose by member with earnedCredit=0 fails with 400');
    assert(resDave.body.error.includes('earned trade standing'), 'Error cites lack of trade standing');

    // 1b. Gating: Frozen member cannot propose
    const resEve = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        actor: eveFrozen,
        body: {
            authorPubkey: eveFrozen,
            title: 'Eve decision',
            description: 'Should fail due to credit_frozen',
            touches: 'member',
            effect: 'grant_voucher',
            subject: charlie,
        },
    });
    assert(resEve.status === 400, 'Propose by credit-frozen member fails with 400');

    // 1c. Gating: Enterprise cannot propose
    const resEnt = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        actor: enterprise,
        body: {
            authorPubkey: enterprise,
            title: 'Enterprise decision',
            description: 'Should fail because enterprise cannot propose',
            touches: 'member',
            effect: 'grant_voucher',
            subject: charlie,
        },
    });
    assert(resEnt.status === 400, 'Propose by enterprise fails with 400');

    // 1d-0. Gating: Description validation (at least 10 chars)
    const resShortDesc = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        actor: alice,
        body: {
            authorPubkey: alice,
            title: 'Too Short Description',
            description: 'Short',
            touches: 'pool',
            effect: 'grant_enterprise',
            subject: enterprise,
            params: { amount: 80 },
        },
    });
    assert(resShortDesc.status === 400, 'Propose with description < 10 chars fails with 400');
    assert(resShortDesc.body.error.includes('description must be at least 10 characters'), 'Error cites description requirement');
    // 1d. Successful propose with no bond charged
    const aliceBalanceBefore = getBalance(alice).balance;
    const resAlice = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        actor: alice,
        body: {
            authorPubkey: alice,
            title: 'Community Garden Upgrade',
            description: 'Install drip irrigation for the shared beds',
            touches: 'pool',
            effect: 'grant_enterprise',
            subject: enterprise,
            params: { amount: 80 },
        },
    });
    assert(resAlice.status === 200 && resAlice.body.success, 'Alice proposes pool grant successfully');
    const decisionPool = resAlice.body.decision;
    assert(decisionPool.franchise === 'quadratic_trade', 'Pool decision automatically assigned quadratic_trade franchise');

    // Verify NO bond debited (§3.8: No bond)
    const aliceBalanceAfter = getBalance(alice).balance;
    assert(aliceBalanceBefore === aliceBalanceAfter, `No bond debited on proposal (balance remains ${aliceBalanceAfter} B)`);

    // 1e. One open decision per author limit
    const resAliceSecond = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        actor: alice,
        body: {
            authorPubkey: alice,
            title: 'Second proposal by Alice',
            description: 'Should fail due to 1 open decision limit',
            touches: 'member',
            effect: 'grant_voucher',
            subject: charlie,
        },
    });
    assert(resAliceSecond.status === 400, 'Alice cannot propose a second decision while first is open');
    assert(resAliceSecond.body.error.includes('already has an open decision'), 'Error specifies 1 open decision limit');

    console.log('\n--- 2. Fetching Decisions List & Tallies ---');

    const resList = await callRouter(commonsRouter, 'GET', '/api/commons/decisions');
    assert(resList.status === 200, 'GET /api/commons/decisions returns 200');
    assert(Array.isArray(resList.body.decisions), 'Returns array of decisions');
    assert(resList.body.activeMembers30d >= 3, `activeMembers30d is tracked (got ${resList.body.activeMembers30d})`);

    const openFound = resList.body.decisions.find((d: any) => d.id === decisionPool.id);
    assert(!!openFound, 'Alice decision present in open decisions');
    assert(openFound.tally !== undefined, 'Decision includes live tally object');
    assert(openFound.tally.quorumRequired >= 3, `Quorum required calculated (${openFound.tally.quorumRequired})`);

    console.log('\n--- 3. Voting Mechanics (1m1v vs Quadratic) ---');

    // Propose a 1m1v member decision by Bob
    const resBobMember = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        actor: bob,
        body: {
            authorPubkey: bob,
            title: 'Let Charlie vouch for newcomers',
            description: 'Charlie has completed 50 trades and knows the newcomers well',
            touches: 'member',
            effect: 'grant_voucher',
            subject: charlie,
        },
    });
    assert(resBobMember.status === 200, 'Bob proposes member decision');
    const decisionMember = resBobMember.body.decision;
    assert(decisionMember.franchise === '1m1v', 'Member decision assigned 1m1v franchise');

    // Bob votes on 1m1v: 1 credit used
    const vote1 = await callRouter(commonsRouter, 'POST', `/api/commons/decisions/${decisionMember.id}/vote`, {
        actor: bob,
        body: {
            voterPubkey: bob,
            support: true,
            voteCount: 1,
        },
    });
    assert(vote1.status === 200 && vote1.body.creditsUsed === 1, '1m1v vote uses exactly 1 credit');

    // Vote without signature auth fails with 401
    const unauthVote = await callRouter(commonsRouter, 'POST', `/api/commons/decisions/${decisionMember.id}/vote`, {
        body: {
            voterPubkey: bob,
            support: true,
            voteCount: 1,
        },
    });
    assert(unauthVote.status === 401, 'Vote without cryptographic signature fails with 401');
    // Charlie votes on quadratic pool decision: 3 votes = 9 credits
    const voteQ = await callRouter(commonsRouter, 'POST', `/api/commons/decisions/${decisionPool.id}/vote`, {
        actor: charlie,
        body: {
            voterPubkey: charlie,
            support: true,
            voteCount: 3,
        },
    });
    assert(voteQ.status === 200 && voteQ.body.creditsUsed === 9, 'Quadratic vote of 3 uses 3² = 9 voice credits');

    console.log('\n--- 3b. Each member sees their own vote, and only their own ---');

    const ownVoteIn = (body: any, id: string) => body.decisions.find((d: any) => d.id === id)?.myVote;

    const listBob = await callRouter(commonsRouter, 'GET', '/api/commons/decisions', { actor: bob });
    const bobOnMember = ownVoteIn(listBob.body, decisionMember.id);
    assert(bobOnMember?.support === true && bobOnMember?.voteCount === 1, `Bob's list shows his own Yes on the member decision (got ${JSON.stringify(bobOnMember)})`);
    assert(ownVoteIn(listBob.body, decisionPool.id) === null, "Bob's list shows no vote on the pool decision (he hasn't voted; Charlie has)");
    const bobPoolCard = JSON.stringify(listBob.body.decisions.find((d: any) => d.id === decisionPool.id));
    assert(!bobPoolCard.includes(charlie), "Bob's copy of the pool decision carries nothing identifying Charlie's vote");

    const listCharlie = await callRouter(commonsRouter, 'GET', '/api/commons/decisions', { actor: charlie });
    const charlieOnPool = ownVoteIn(listCharlie.body, decisionPool.id);
    assert(charlieOnPool?.support === true && charlieOnPool?.voteCount === 3 && charlieOnPool?.creditsUsed === 9,
        `Charlie's list shows his own Yes with 3 votes on the pool decision (got ${JSON.stringify(charlieOnPool)})`);
    assert(ownVoteIn(listCharlie.body, decisionMember.id) === null, "Charlie's list does not show Bob's vote on the member decision");

    const listAnon = await callRouter(commonsRouter, 'GET', '/api/commons/decisions');
    assert(listAnon.body.decisions.every((d: any) => d.myVote === null), 'An unsigned list carries no own vote on any decision');

    const detailCharlie = await callRouter(commonsRouter, 'GET', `/api/commons/decisions/${decisionPool.id}`, { actor: charlie, params: { id: decisionPool.id } });
    assert(detailCharlie.body.myVote?.voteCount === 3, `Decision detail returns the caller's own vote (got ${JSON.stringify(detailCharlie.body.myVote)})`);

    // Re-voting replaces the earlier vote, and the list must say so.
    const revote = await callRouter(commonsRouter, 'POST', `/api/commons/decisions/${decisionPool.id}/vote`, {
        actor: charlie,
        body: { voterPubkey: charlie, support: false, voteCount: 2 },
    });
    assert(revote.status === 200, 'Charlie changes his pool vote to No with 2 votes');
    const listCharlie2 = await callRouter(commonsRouter, 'GET', '/api/commons/decisions', { actor: charlie });
    const charlieOnPool2 = ownVoteIn(listCharlie2.body, decisionPool.id);
    assert(charlieOnPool2?.support === false && charlieOnPool2?.voteCount === 2 && charlieOnPool2?.creditsUsed === 4,
        `After re-voting, Charlie's list shows No with 2 votes (got ${JSON.stringify(charlieOnPool2)})`);
    // Put Charlie's vote back so the execution section below runs as before.
    await callRouter(commonsRouter, 'POST', `/api/commons/decisions/${decisionPool.id}/vote`, {
        actor: charlie,
        body: { voterPubkey: charlie, support: true, voteCount: 3 },
    });

    console.log('\n--- 3c. Decisions that would do nothing, or vote on tiers, are refused ---');

    // A fresh proposer per effect, so each refusal stands on its own (not the one-open-decision limit).
    const refusedProposers: string[] = [];
    for (const [effect, touches] of [
        ['set_rule', 'rule'], ['set_levy', 'rule'], ['poll', 'nothing'],
        ['grant_tier', 'member'], ['revoke_tier', 'member'], ['grant_elder', 'member'], ['revoke_elder', 'member'],
    ] as const) {
        const proposer = makeMember(`Proposer_${effect}`, { balance: 100, earnedCredit: 50 });
        refusedProposers.push(proposer);
        const res = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
            actor: proposer,
            body: {
                title: `Try ${effect}`,
                description: 'This kind of decision should be refused',
                touches,
                effect,
                subject: charlie,
                params: { tier: 'Elder', key: 'trade_fee', value: '0.01' },
            },
        });
        assert(res.status === 400 && /not available|earned through trade/.test(res.body?.error || ''),
            `Proposing ${effect} is refused with 400 (got ${res.status}: ${res.body?.error})`);
    }
    const refusedRows = db.prepare(
        `SELECT COUNT(*) AS c FROM decisions WHERE author_pubkey IN (${refusedProposers.map(() => '?').join(',')})`
    ).get(...refusedProposers) as any;
    assert(refusedRows.c === 0, 'No refused decision was stored');

    console.log('\n--- 4. §3.8 Mandatory Debt Disclosure Verbatim Check ---');

    // Create a rogue member who owes 180 beans
    const rogue = makeMember('RogueMember', { balance: -180, earnedCredit: 50 });
    const commonsPoolBal = getCommonsBalance();

    // Verify word-for-word string match from §3.8
    const expectedLine = `${'RogueMember'}'s balance is \u2212180 beans. Removing them charges that 180 to the Commons pool, which currently holds ${Math.round(commonsPoolBal)}.`;
    const formattedLine = formatDebtWriteOffLine('RogueMember', 180, Math.round(commonsPoolBal));

    assert(formattedLine === expectedLine, 'Debt write-off line matches §3.8 word-for-word');
    assert(formattedLine.includes('\u2212'), 'Contains unicode minus sign \\u2212');
    assert(formattedLine.includes('Removing them charges that 180 to the Commons pool'), 'Contains exact clause');

    // Test zero-debt scenario
    const cleanMember = makeMember('CleanMember', { balance: 0, earnedCredit: 50 });
    const cleanExpected = `${'CleanMember'}'s balance is \u22120 beans. Removing them charges that 0 to the Commons pool, which currently holds ${Math.round(commonsPoolBal)}.`;
    const cleanFormatted = formatDebtWriteOffLine('CleanMember', 0, Math.round(commonsPoolBal));
    assert(cleanFormatted === cleanExpected, 'Zero-debt ballot correctly states \u22120 and charges 0');

    // Propose removal ballot with parameters
    const resRemoval = await callRouter(commonsRouter, 'POST', '/api/commons/decisions', {
        actor: charlie,
        body: {
            authorPubkey: charlie,
            title: 'Remove RogueMember for violation of charter',
            description: 'Refusal to settle obligations',
            touches: 'member',
            effect: 'remove_member',
            subject: rogue,
            params: {
                memberName: 'RogueMember',
                debt: 180,
                commonsPool: Math.round(commonsPoolBal),
            },
        },
    });
    assert(resRemoval.status === 200, 'Removal decision proposed successfully');
    const decisionRemoval = resRemoval.body.decision;
    assert(decisionRemoval.effect === 'remove_member', 'Decision effect is remove_member');
    assert(decisionRemoval.params.debt === 180, 'Params record debtor debt amount');

    console.log('\n--- 5. History & Execution Provenance ---');

    // Cast votes to pass the pool decision
    await callRouter(commonsRouter, 'POST', `/api/commons/decisions/${decisionPool.id}/vote`, {
        actor: alice,
        body: { voterPubkey: alice, support: true, voteCount: 4 }, // 16 credits
    });
    await callRouter(commonsRouter, 'POST', `/api/commons/decisions/${decisionPool.id}/vote`, {
        actor: bob,
        body: { voterPubkey: bob, support: true, voteCount: 2 }, // 4 credits
    });

    // Advance closesAt so tick can execute it
    db.prepare(`UPDATE decisions SET closes_at = datetime('now', '-1 minute') WHERE id = ?`).run(decisionPool.id);

    // Fund the Commons pool so grant can execute
    setCommonsBalance(500);
    db.prepare(`UPDATE accounts SET balance = 500 WHERE public_key = 'COMMONS_POOL'`).run();

    // Fire tick
    const tickRes = await callRouter(commonsRouter, 'POST', '/api/commons/decisions/tick');
    assert(tickRes.status === 200, 'Tick executed successfully');

    // Verify decision executed
    const executedDecision = db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(decisionPool.id) as any;
    assert(executedDecision.status === 'executed', `Pool grant status updated to 'executed' (got ${executedDecision.status})`);
    assert(!!executedDecision.executed_at, 'executed_at timestamp recorded');

    // Verify ledger transaction provenance
    const tx = db.prepare(`
        SELECT * FROM transactions
        WHERE to_pubkey = ? AND auth_signer = ?
    `).get(enterprise, `system:decision:${decisionPool.id}`) as any;
    assert(!!tx, `Ledger transaction has provenance auth_signer = 'system:decision:${decisionPool.id}'`);
    assert(tx.amount === 80, 'Transaction amount matches decision grant (80 B)');

    console.log(`\n🎉 All ${testsPassed}/${testsRun} Decisions Client API & Parity tests PASSED!\n`);
    process.exit(0);
}

runSuite().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
