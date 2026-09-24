/**
 * A cancellation is announced only once it is durable.
 *
 * `recordActivity()` (engine/members.ts) does two things when the member is the lead of an open enterprise
 * succession proposal: it flips the proposal to 'cancelled', and it tells clients so. It used to do the
 * second one immediately, on the same line as the UPDATE.
 *
 * That was fine while `recordActivity` only ever ran on its own. Since #1096 it does not: `transfer()`
 * wraps its writes in a `conservingTransaction` and calls `recordActivity(from)` from inside it
 * (state-engine.ts), and every escrow/settlement/wizard caller nests another transaction around that. A
 * statement after the UPDATE can still throw — a floor breach, a constraint, a failed escrow leg — and the
 * UPDATE goes back with the rollback. The announcement does not: a broadcast cannot be recalled. Clients
 * would have retired a proposal that the node still holds as active, and nothing would ever correct them,
 * because the next thing the node sends about that proposal is whatever closes it for real.
 *
 * So the broadcast is queued through `afterTransactionCommit` (db/db.ts), which fires it straight away
 * outside a transaction and defers it to the OUTERMOST commit inside one — discarding the queue if that
 * transaction rolls back instead.
 *
 * WHAT THIS FILE PINS, precisely:
 *   1. rollback  → no announcement at all, and the proposal is still 'active'.
 *   2. commit    → exactly one announcement, per proposal, carrying the right ids.
 *   3. ordering  → the announcement happens AFTER the commit, not merely at some point.
 *   4. nesting   → an inner transaction that commits inside an outer one that then throws announces
 *                  nothing. This is the shape transfer() actually runs in.
 *   5. no transaction at all → still announced, immediately (the plain path is unchanged).
 *
 * KNOWN, AND NOT WHAT THIS FILE IS ABOUT — see the PR. `recordActivity` reaches its broadcast through
 * `(globalThis as any).broadcast?.(...)`, and nothing in the repo ever assigns `globalThis.broadcast`, so
 * on a running node the call is a no-op and no client hears this event from this path at all. The tests
 * below install that global themselves, which is the seam the code reads; they pin the ordering contract
 * of the code as written, so that wiring the broadcast up later cannot quietly reintroduce the hazard.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-succession-broadcast-after-commit.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine, conservingTransaction } from './state-engine.js';
import { recordActivity } from './engine/members.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function member(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`).run(pub, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

/**
 * An open proposal to replace `lead` as the lead keeper of a NEW enterprise, whose key is returned
 * alongside the proposal id. A fresh enterprise each time because only one proposal per enterprise may be
 * 'active' at once (idx_succession_proposals_active_unique), and the rollback cases leave theirs open.
 */
function openProposal(lead: string, candidate: string, enterpriseName: string): { id: string; enterprise: string } {
    const enterprise = member(enterpriseName);
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO enterprise_succession_proposals
                (id, enterprise_pubkey, lead_pubkey, candidate_pubkey, proposer_pubkey, status)
                VALUES (?, ?, ?, ?, ?, 'active')`).run(id, enterprise, lead, candidate, candidate);
    return { id, enterprise };
}

const statusOf = (id: string) =>
    (db.prepare('SELECT status FROM enterprise_succession_proposals WHERE id = ?').get(id) as any)?.status;

type Sent = { type: string; proposalId: string; enterprisePubkey: string; leadPubkey: string };

/** Installs a capturing broadcast, runs `fn`, and hands back everything the code under test announced. */
function capture(fn: () => void): { sent: Sent[]; threw: Error | null } {
    const sent: Sent[] = [];
    const previous = (globalThis as any).broadcast;
    (globalThis as any).broadcast = (msg: any) => { sent.push(msg); };
    let threw: Error | null = null;
    try { fn(); } catch (e: any) { threw = e; }
    (globalThis as any).broadcast = previous;
    return { sent, threw };
}

const cancellations = (sent: Sent[]) => sent.filter(m => m.type === 'enterprise_succession_cancelled');

function main(): void {
    console.log('Running succession-broadcast-after-commit tests...\n');
    initStateEngine();

    const candidate = member('BroadcastCandidate');

    // ── 1. A transaction that throws announces nothing ────────────────────────────────────────────
    console.log('— a transaction that rolls back —');
    {
        const lead = member('LeadRollback');
        const { id: proposalId } = openProposal(lead, candidate, 'CoopRollback');

        const { sent, threw } = capture(() => {
            conservingTransaction(() => {
                recordActivity(lead);
                // Whatever comes after the UPDATE in a real caller and can still fail.
                throw new Error('a later statement failed');
            });
        });

        assert(threw?.message === 'a later statement failed', 'the failure still reaches the caller');
        assert(cancellations(sent).length === 0,
            `no cancellation was announced (sent ${cancellations(sent).length})`);
        assert(statusOf(proposalId) === 'active',
            `and the proposal really did roll back to 'active' (is '${statusOf(proposalId)}')`);
    }

    // ── 2 & 3. A transaction that commits announces exactly once, after the commit ─────────────────
    console.log('\n— a transaction that commits —');
    {
        const lead = member('LeadCommit');
        const { id: proposalId, enterprise } = openProposal(lead, candidate, 'CoopCommit');
        let seenInside = 0;
        let statusWhenAnnounced: string | undefined;
        let inTransactionWhenAnnounced: boolean | undefined;

        const sent: Sent[] = [];
        const previous = (globalThis as any).broadcast;
        (globalThis as any).broadcast = (msg: any) => {
            sent.push(msg);
            // Both recorded at announce time, not afterwards: `inTransaction` is what makes the row read
            // meaningful — with no transaction open, what this SELECT returns is what is committed.
            inTransactionWhenAnnounced = (db as any).inTransaction;
            statusWhenAnnounced = statusOf(msg.proposalId);
        };
        conservingTransaction(() => {
            recordActivity(lead);
            seenInside = cancellations(sent).length;
        });
        (globalThis as any).broadcast = previous;

        assert(seenInside === 0, `nothing was announced while the transaction was still open (saw ${seenInside})`);
        assert(cancellations(sent).length === 1,
            `exactly one cancellation was announced after it committed (sent ${cancellations(sent).length})`);
        assert(inTransactionWhenAnnounced === false, 'and it was announced with no transaction open');
        assert(statusWhenAnnounced === 'cancelled',
            `by which point the proposal was durably 'cancelled' (was '${statusWhenAnnounced}')`);

        const msg = cancellations(sent)[0];
        assert(msg?.proposalId === proposalId, 'it names the proposal');
        assert(msg?.enterprisePubkey === enterprise, 'it names the enterprise');
        assert(msg?.leadPubkey === lead, 'it names the lead who came back');
    }

    // ── 4. An inner transaction commits, the outer one throws ─────────────────────────────────────
    // This is the shape that matters: transfer() has its own conservingTransaction, and escrow,
    // settlement and the wizards nest it inside theirs. The inner "commit" is only a SAVEPOINT.
    console.log('\n— an inner transaction commits inside an outer one that then throws —');
    {
        const lead = member('LeadNested');
        const { id: proposalId } = openProposal(lead, candidate, 'CoopNested');

        const { sent, threw } = capture(() => {
            conservingTransaction(() => {
                conservingTransaction(() => { recordActivity(lead); });
                throw new Error('the outer leg failed');
            });
        });

        assert(threw?.message === 'the outer leg failed', 'the outer failure reaches the caller');
        assert(cancellations(sent).length === 0,
            `the inner commit announced nothing, because only the outer commit is durable (sent ${cancellations(sent).length})`);
        assert(statusOf(proposalId) === 'active',
            `and the proposal is still 'active' (is '${statusOf(proposalId)}')`);
    }

    // ── 5. No transaction at all: unchanged, announced immediately ─────────────────────────────────
    console.log('\n— no transaction at all —');
    {
        const lead = member('LeadBare');
        const { id: proposalId } = openProposal(lead, candidate, 'CoopBare');

        const { sent } = capture(() => { recordActivity(lead); });

        assert(cancellations(sent).length === 1,
            `the plain path still announces once (sent ${cancellations(sent).length})`);
        assert(cancellations(sent)[0]?.proposalId === proposalId, 'naming the proposal it just cancelled');
        assert(statusOf(proposalId) === 'cancelled', `and the proposal is 'cancelled' (is '${statusOf(proposalId)}')`);
    }

    // ── One announcement per proposal, not one per call ───────────────────────────────────────────
    console.log('\n— two open proposals against the same lead —');
    {
        const lead = member('LeadTwoProposals');
        const { id: a } = openProposal(lead, candidate, 'CoopTwoA');
        const { id: b } = openProposal(lead, candidate, 'CoopTwoB');

        const { sent } = capture(() => { conservingTransaction(() => { recordActivity(lead); }); });

        const ids = cancellations(sent).map(m => m.proposalId).sort();
        assert(ids.length === 2, `both were announced (sent ${ids.length})`);
        assert(JSON.stringify(ids) === JSON.stringify([a, b].sort()), 'one announcement each, naming each proposal');
        assert(statusOf(a) === 'cancelled' && statusOf(b) === 'cancelled', 'and both are cancelled');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
