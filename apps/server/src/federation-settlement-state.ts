/**
 * The durable state machine behind cross-node settlement (#104, step 3).
 *
 * Spec: docs/federation-economics.md §2.5. This is the outbox the failure-handling rules require, plus
 * the `GET_RECEIPT_STATUS` answer and the compensating-reversal bookkeeping.
 *
 * WHY BOTH SIDES KEEP A ROW, for different reasons — this is the part that is easy to get half-right:
 *   • the BUYER's node persists `committed` BEFORE returning a receipt, so a bridge disagreement is
 *     DETECTABLE. Without it, a receipt that was never acted on is invisible, and the mismatch surfaces
 *     much later as unexplained drift between the two nodes' bridge rows.
 *   • the SELLER's node persists the receipt BEFORE paying its seller, so the payment is REPLAYABLE. A
 *     crash mid-payment resumes from the receipt instead of losing the fact that it owes someone.
 *
 * Every transition is idempotent on `key`, so a retry can never double-charge or double-pay.
 *
 * This module owns state and transitions only. It performs no ledger writes and no network I/O, which is
 * what makes it testable on a single node — the libp2p action and the ledger entries sit on top.
 */

import { db } from './db/db.js';

/** Terminal states. Recovery ignores these; everything else is unfinalised and must be resolved. */
const TERMINAL = ['settled', 'reversed', 'abandoned'] as const;

export type SettlementDirection = 'outbound' | 'inbound';
export type SettlementState =
    | 'escrowed' | 'reserved' | 'committed' | 'held' | 'settled' | 'reversed' | 'abandoned';

export interface SettlementRow {
    key: string;
    direction: SettlementDirection;
    peerId: string;
    buyerPubkey: string;
    buyerHomeNode: string | null;
    postId: string | null;
    amount: number;
    state: SettlementState;
    receipt: string | null;
    failureReason: string | null;
    createdAt: string;
    updatedAt: string;
}

const rowToSettlement = (r: any): SettlementRow => ({
    key: r.key,
    direction: r.direction,
    peerId: r.peer_id,
    buyerPubkey: r.buyer_pubkey,
    buyerHomeNode: r.buyer_home_node ?? null,
    postId: r.post_id ?? null,
    amount: r.amount,
    state: r.state,
    receipt: r.receipt ?? null,
    failureReason: r.failure_reason ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

/**
 * Legal transitions. Encoded as data rather than scattered `if`s so an illegal move is a loud error
 * instead of a silent write — the failure mode this table exists to prevent is a settlement quietly
 * ending up in a state nobody can reconcile.
 */
const LEGAL: Record<SettlementState, SettlementState[]> = {
    escrowed:  ['committed', 'abandoned'],
    reserved:  ['held', 'abandoned'],
    committed: ['settled', 'reversed'],
    held:      ['settled', 'reversed'],
    settled:   [],
    reversed:  [],
    abandoned: [],
};

export function getSettlement(key: string): SettlementRow | null {
    const r = db.prepare('SELECT * FROM settlements WHERE key = ?').get(key) as any;
    return r ? rowToSettlement(r) : null;
}

/**
 * Record a new settlement, or return the existing one unchanged.
 *
 * Idempotent by design: a retried `PURCHASE` must not create a second row or reset the first. Callers
 * should treat a returned row whose state has already moved on as "already in flight", not as an error.
 */
export function openSettlement(input: {
    key: string;
    direction: SettlementDirection;
    peerId: string;
    buyerPubkey: string;
    buyerHomeNode?: string | null;
    postId?: string | null;
    amount: number;
    state: Extract<SettlementState, 'escrowed' | 'reserved'>;
}): SettlementRow {
    const existing = getSettlement(input.key);
    if (existing) return existing;

    db.prepare(`
        INSERT INTO settlements (key, direction, peer_id, buyer_pubkey, buyer_home_node, post_id, amount, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        input.key, input.direction, input.peerId, input.buyerPubkey,
        input.buyerHomeNode ?? null, input.postId ?? null, input.amount, input.state,
    );
    return getSettlement(input.key)!;
}

/**
 * Move a settlement to a new state.
 *
 * Returns the row. Re-applying the state it is already in is a **no-op that succeeds**, because a retried
 * network call must be safe. Any other illegal move **throws** — silently ignoring it would leave the two
 * nodes disagreeing with no record of why.
 */
export function advanceSettlement(
    key: string,
    to: SettlementState,
    extra?: { receipt?: string; failureReason?: string },
): SettlementRow {
    const row = getSettlement(key);
    if (!row) throw new Error(`Unknown settlement ${key}`);
    if (row.state === to) return row;                       // idempotent replay

    if (!LEGAL[row.state].includes(to)) {
        throw new Error(`Illegal settlement transition ${row.state} → ${to} for ${key}`);
    }

    db.prepare(`
        UPDATE settlements
        SET state = ?, receipt = COALESCE(?, receipt), failure_reason = COALESCE(?, failure_reason),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE key = ?
    `).run(to, extra?.receipt ?? null, extra?.failureReason ?? null, key);
    return getSettlement(key)!;
}

/** Unfinalised settlements, oldest first — what boot recovery iterates. */
export function unfinalisedSettlements(direction?: SettlementDirection): SettlementRow[] {
    const placeholders = TERMINAL.map(() => '?').join(',');
    const sql = `SELECT * FROM settlements WHERE state NOT IN (${placeholders})`
        + (direction ? ' AND direction = ?' : '')
        + ' ORDER BY created_at';
    const params: any[] = [...TERMINAL];
    if (direction) params.push(direction);
    return (db.prepare(sql).all(...params) as any[]).map(rowToSettlement);
}

/**
 * The `GET_RECEIPT_STATUS(key)` answer, from the seller's node.
 *
 * Three states, not two, because **"never arrived" and "arrived but not yet acted on" require opposite
 * responses** from the asker: reverse versus wait.
 *
 * `NOT_FOUND` is returned only for a key we can be *sure* we never held. A key we do not recognise is
 * `UNKNOWN`, deliberately distinct: answering `NOT_FOUND` by default would let a fabricated or truncated
 * key convince the buyer's node to reverse a trade that actually settled.
 */
export type ReceiptStatus = 'NOT_FOUND' | 'HELD' | 'SETTLED' | 'UNKNOWN';

export function receiptStatus(key: string): ReceiptStatus {
    const row = getSettlement(key);
    if (!row) return 'UNKNOWN';
    if (row.direction !== 'inbound') return 'UNKNOWN';   // not ours to answer for
    switch (row.state) {
        case 'held':      return 'HELD';
        case 'settled':   return 'SETTLED';
        case 'reversed':
        case 'abandoned': return 'NOT_FOUND';
        default:          return 'UNKNOWN';              // 'reserved' — no receipt ever arrived
    }
}

/** What the buyer's node should do with a `GET_RECEIPT_STATUS` answer. Encoded so the caller can't invert it. */
export function actionForReceiptStatus(status: ReceiptStatus): 'reverse' | 'wait' | 'finalise' {
    switch (status) {
        case 'NOT_FOUND': return 'reverse';
        case 'HELD':      return 'wait';       // reversing now would strand a payment about to happen
        case 'SETTLED':   return 'finalise';
        // An unrecognised key is NOT permission to reverse. Wait and re-ask; a human can intervene if it
        // never resolves. Reversing on ambiguity is how a settled trade gets silently undone.
        case 'UNKNOWN':   return 'wait';
    }
}
