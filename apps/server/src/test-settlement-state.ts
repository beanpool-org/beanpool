/**
 * The cross-node settlement state machine + ledger label resolver (#104, step 3a).
 *
 * Spec: docs/federation-economics.md §2.5.
 *
 * What these checks pin:
 *   1. Idempotency on `key` — a retried call never creates a second settlement or resets the first.
 *   2. Illegal transitions THROW rather than writing silently, because a settlement in an unreconcilable
 *      state is exactly what this table exists to prevent.
 *   3. Both sides keep a row, and boot recovery finds the unfinalised ones.
 *   4. GET_RECEIPT_STATUS answers three states, and an UNKNOWN key means WAIT — never reverse. Reversing
 *      on ambiguity is how a settled trade gets silently undone.
 *   5. A bridge counterparty reads as a community name, not a peer id.
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-settlement-state.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initStateEngine } from './state-engine.js';
import { addConnector } from './connector-manager.js';
import { bridgeAccountId, resolveCounterpartyLabel, bridgeDisplayName } from './federation-bridge.js';
import {
    openSettlement, advanceSettlement, getSettlement, unfinalisedSettlements,
    receiptStatus, actionForReceiptStatus,
} from './federation-settlement-state.js';

const PEER_ID = '12D3KooWByronPeer';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function throws(fn: () => unknown, re: RegExp, msg: string) {
    let m = '';
    try { fn(); } catch (e: any) { m = e.message; }
    assert(re.test(m), `${msg} (got "${m}")`);
}

async function main() {
    console.log('Running settlement state machine tests (#104 step 3a)...\n');
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') {
        throw new Error('Run with ENABLE_PEER_CONNECTORS=true — connector reads short-circuit otherwise');
    }
    initStateEngine();

    // ── 1. Idempotency ──────────────────────────────────────────────────────────
    const out = openSettlement({
        key: 'k-out-1', direction: 'outbound', peerId: PEER_ID,
        buyerPubkey: 'buyerpk', buyerHomeNode: 'https://brisbane.beanpool.org',
        postId: 'post-1', amount: 5, state: 'escrowed',
    });
    assert(out.state === 'escrowed' && out.amount === 5, 'an outbound settlement opens in escrowed');

    advanceSettlement('k-out-1', 'committed', { receipt: 'sig-abc' });
    const replay = openSettlement({
        key: 'k-out-1', direction: 'outbound', peerId: PEER_ID,
        buyerPubkey: 'buyerpk', amount: 5, state: 'escrowed',
    });
    assert(replay.state === 'committed', 'reopening an existing key does NOT reset it — a retry is safe');
    assert(replay.receipt === 'sig-abc', 'and the receipt survives the retry');

    assert(advanceSettlement('k-out-1', 'committed').state === 'committed',
        're-applying the current state is an idempotent no-op, not an error');

    // ── 2. Illegal transitions throw ────────────────────────────────────────────
    throws(() => advanceSettlement('k-out-1', 'escrowed'), /Illegal settlement transition/,
        'committed → escrowed is refused');
    throws(() => advanceSettlement('k-out-1', 'held'), /Illegal settlement transition/,
        'an outbound settlement cannot enter an inbound state');
    throws(() => advanceSettlement('nope', 'settled'), /Unknown settlement/,
        'advancing an unknown key is refused');

    advanceSettlement('k-out-1', 'settled');
    throws(() => advanceSettlement('k-out-1', 'reversed'), /Illegal settlement transition/,
        'a settled settlement is terminal — it cannot later be reversed');

    // ── 3. Reversal is a state, not a deletion ──────────────────────────────────
    openSettlement({ key: 'k-out-2', direction: 'outbound', peerId: PEER_ID, buyerPubkey: 'b2', amount: 9, state: 'escrowed' });
    advanceSettlement('k-out-2', 'committed', { receipt: 'sig-def' });
    advanceSettlement('k-out-2', 'reversed', { failureReason: 'CAPACITY_LAPSED' });
    const reversed = getSettlement('k-out-2')!;
    assert(reversed.state === 'reversed', 'a reversed settlement is marked, not removed');
    assert(!!getSettlement('k-out-2'), 'the row SURVIVES reversal — the audit trail keeps both sides');
    assert(reversed.failureReason === 'CAPACITY_LAPSED', 'and records why');

    // ── 4. Boot recovery sees only unfinalised rows ──────────────────────────────
    openSettlement({ key: 'k-in-1', direction: 'inbound', peerId: PEER_ID, buyerPubkey: 'b3', amount: 4, state: 'reserved' });
    advanceSettlement('k-in-1', 'held', { receipt: 'sig-ghi' });
    openSettlement({ key: 'k-in-2', direction: 'inbound', peerId: PEER_ID, buyerPubkey: 'b4', amount: 2, state: 'reserved' });

    const keys = unfinalisedSettlements().map(r => r.key);
    assert(keys.includes('k-in-1') && keys.includes('k-in-2'), 'held and reserved are unfinalised');
    assert(!keys.includes('k-out-1'), 'settled is finalised and excluded');
    assert(!keys.includes('k-out-2'), 'reversed is finalised and excluded');
    assert(unfinalisedSettlements('inbound').every(r => r.direction === 'inbound'), 'recovery can scan one side');

    // ── 5. GET_RECEIPT_STATUS — three states, and UNKNOWN means WAIT ─────────────
    assert(receiptStatus('k-in-1') === 'HELD', 'a persisted-but-unpaid receipt reports HELD');
    advanceSettlement('k-in-1', 'settled');
    assert(receiptStatus('k-in-1') === 'SETTLED', 'a paid seller reports SETTLED');
    assert(receiptStatus('k-in-2') === 'UNKNOWN', 'reserved-but-no-receipt is UNKNOWN, not NOT_FOUND');
    advanceSettlement('k-in-2', 'abandoned');
    assert(receiptStatus('k-in-2') === 'NOT_FOUND', 'an abandoned settlement reports NOT_FOUND');
    assert(receiptStatus('never-existed') === 'UNKNOWN', 'an unrecognised key is UNKNOWN — NOT a default NOT_FOUND');
    assert(receiptStatus('k-out-1') === 'UNKNOWN', 'we do not answer for the outbound side of a trade');

    assert(actionForReceiptStatus('NOT_FOUND') === 'reverse', 'NOT_FOUND → reverse');
    assert(actionForReceiptStatus('SETTLED') === 'finalise', 'SETTLED → finalise');
    assert(actionForReceiptStatus('HELD') === 'wait', 'HELD → wait, not reverse — a payment is about to happen');
    assert(actionForReceiptStatus('UNKNOWN') === 'wait',
        'UNKNOWN → WAIT. Reversing on ambiguity is how a fabricated key silently undoes a settled trade');

    // ── 6. The ledger label ─────────────────────────────────────────────────────
    const bridge = bridgeAccountId(PEER_ID);
    assert(bridgeDisplayName(bridge) === '🌐 Another community', 'an unmet peer gets an honest generic label, not a peer id');

    addConnector('byron.beanpool.org', 'peer', 'Byron Community', 'https://byron.beanpool.org');
    // A configured-but-never-connected peer still has no peerId — that only arrives via libp2p's
    // peer:connect handler, which populates the statuses map. So it correctly stays generic.
    assert(bridgeDisplayName(bridge) === '🌐 Another community',
        'configured but never connected is still generic — a callsign alone does not identify the peer');

    // NOT COVERED HERE: the resolved-callsign path needs a live connection to populate peerId, and
    // getConnectors() returns a merged copy so a test cannot inject it. Deliberately not adding a
    // production seam for a test — the step-3b multi-node harness exercises it against a real handshake.
    assert(resolveCounterpartyLabel(bridge) !== null, 'the resolver claims bridge accounts');
    assert(!bridgeDisplayName(bridge)!.includes(PEER_ID), 'the raw peer id never reaches a member');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Settlement state machine checks PASSED (#104 step 3a).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
