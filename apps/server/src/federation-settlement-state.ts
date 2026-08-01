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

export type SettlementDirection = 'outbound' | 'inbound';
export type SettlementState =
    | 'escrowed' | 'reserved' | 'committed' | 'held' | 'settled' | 'reversed' | 'abandoned';

/** Terminal states. Recovery ignores these. */
const TERMINAL = ['settled', 'reversed', 'abandoned'] as const;

/**
 * The states recovery must resolve. Listed POSITIVELY, not as `NOT IN (TERMINAL)` — review finding.
 *
 * `idx_settlements_unfinalised` is a partial index defined `WHERE state IN ('escrowed','reserved',
 * 'committed','held')`, and SQLite's planner cannot match a `NOT IN` predicate against a partial index's
 * condition. The equivalent-looking negative form therefore full-scans `settlements` on every boot, and the
 * cost grows with settlement history — exactly the table that only ever gets longer.
 */
const UNFINALISED = ['escrowed', 'reserved', 'committed', 'held'] as const;

// The two lists must partition the state space: a state in neither would be invisible to recovery AND
// never finalised, which is the one outcome this table exists to prevent. Asserted at import so a future
// state added to the union without a home fails loudly instead of silently going unrecovered.
{
    const all: SettlementState[] = ['escrowed', 'reserved', 'committed', 'held', 'settled', 'reversed', 'abandoned'];
    const covered = new Set<string>([...TERMINAL, ...UNFINALISED]);
    const missing = all.filter(s => !covered.has(s));
    if (missing.length || covered.size !== all.length) {
        throw new Error(`[Settlement] states not partitioned into terminal/unfinalised: ${missing.join(', ') || 'overlap'}`);
    }
}

export interface SettlementRow {
    key: string;
    direction: SettlementDirection;
    peerId: string;
    buyerPubkey: string;
    buyerHomeNode: string | null;
    /** Inbound: the local member we pay when the receipt lands. Outbound: the peer's seller, informational. */
    sellerPubkey: string | null;
    postId: string | null;
    amount: number;
    /** Outbound only: the fee charged to the buyer on top of `amount` (§2.1). Refunded on reversal. */
    fee: number;
    /** Inbound only: ISO timestamp at which the cap reservation lapses. */
    reservedUntil: string | null;
    state: SettlementState;
    receipt: string | null;
    /** Outbound: the exact canonical receipt object that was signed, as JSON. Replayed verbatim. */
    receiptPayload: string | null;
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
    sellerPubkey: r.seller_pubkey ?? null,
    postId: r.post_id ?? null,
    amount: r.amount,
    fee: r.fee ?? 0,
    reservedUntil: r.reserved_until ?? null,
    state: r.state,
    receipt: r.receipt ?? null,
    receiptPayload: r.receipt_payload ?? null,
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
    sellerPubkey?: string | null;
    postId?: string | null;
    amount: number;
    fee?: number;
    reservedUntil?: string | null;
    state: Extract<SettlementState, 'escrowed' | 'reserved'>;
}): SettlementRow {
    // Insert-then-validate, NOT validate-then-insert (review finding). A pre-insert check plus
    // `ON CONFLICT DO NOTHING` has a hole: if a conflicting row appears between the check and the insert,
    // the conflict clause silently skips the write and the mismatched row is returned as if it were ours.
    // Validating whatever row actually ends up in the table closes both orderings with one check.
    db.prepare(`
        INSERT INTO settlements (key, direction, peer_id, buyer_pubkey, buyer_home_node, seller_pubkey,
                                 post_id, amount, fee, reserved_until, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO NOTHING
    `).run(
        input.key, input.direction, input.peerId, input.buyerPubkey,
        input.buyerHomeNode ?? null, input.sellerPubkey ?? null, input.postId ?? null,
        input.amount, input.fee ?? 0, input.reservedUntil ?? null, input.state,
    );

    const row = getSettlement(input.key)!;

    // Idempotent ONLY for the same trade. Returning the row for a DIFFERENT payload would be silent trade
    // aliasing: a peer re-using a key with a larger amount, or a different counterparty, would get a
    // success back and the caller would proceed believing the new terms were registered. The identity of a
    // settlement is the whole tuple, not just the key.
    //
    // Amount is compared at 4dp because it round-trips through JSON as a float.
    const same = row.direction === input.direction
        && row.peerId === input.peerId
        && row.buyerPubkey === input.buyerPubkey
        && (row.sellerPubkey ?? null) === (input.sellerPubkey ?? null)
        // postId included (review finding): reusing a key for a DIFFERENT post returned the original row as
        // an idempotent success, so the caller proceeded with new terms while the receipt was built from the
        // old row — an avoidable mismatch and reversal. `fee` and `buyerHomeNode` are deliberately excluded:
        // fee is derived from amount, and buyerHomeNode is informational rather than trade-defining.
        && (row.postId ?? null) === (input.postId ?? null)
        && Math.round(row.amount * 10000) === Math.round(input.amount * 10000);
    if (!same) {
        throw new Error(`Settlement key collision for ${input.key}: payload does not match the existing row`);
    }
    return row;
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
    extra?: { receipt?: string; receiptPayload?: string; failureReason?: string },
): SettlementRow {
    const row = getSettlement(key);
    if (!row) throw new Error(`Unknown settlement ${key}`);

    // A same-state call carrying NEW metadata must still write it. Returning early on `state === to`
    // silently dropped it (review finding) — so a row that reached `held` without its receipt could never
    // have one attached afterwards, and the receipt is the only thing that makes the payment replayable.
    const newReceipt = extra?.receipt !== undefined && extra.receipt !== row.receipt;
    const newPayload = extra?.receiptPayload !== undefined && extra.receiptPayload !== row.receiptPayload;
    const newReason = extra?.failureReason !== undefined && extra.failureReason !== row.failureReason;
    if (row.state === to && !newReceipt && !newPayload && !newReason) return row;   // idempotent replay

    if (row.state !== to && !LEGAL[row.state].includes(to)) {
        throw new Error(`Illegal settlement transition ${row.state} → ${to} for ${key}`);
    }

    // Compare-and-swap on the state we validated against, not just the key. As with openSettlement, the
    // interleaving this defends against is not reachable in-process — but the difference between "refused
    // an illegal transition" and "performed one silently" is worth making structural in SQL rather than
    // resting on the read and the write staying adjacent.
    const result = db.prepare(`
        UPDATE settlements
        SET state = ?, receipt = COALESCE(?, receipt), receipt_payload = COALESCE(?, receipt_payload),
            failure_reason = COALESCE(?, failure_reason),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE key = ? AND state = ?
    `).run(to, extra?.receipt ?? null, extra?.receiptPayload ?? null, extra?.failureReason ?? null, key, row.state);

    if (result.changes === 0) {
        const current = getSettlement(key);
        if (current?.state !== to) {
            throw new Error(`Concurrent settlement transition conflict for ${key} (expected ${row.state})`);
        }
        // Someone else reached the same state first, so the OUTCOME agrees — but they may have got there
        // without the metadata we were asked to attach, and returning here would strand it (review finding).
        // The receipt is what makes a payment replayable, so losing it is not cosmetic. Re-apply it against
        // the state we now know the row is in.
        if ((extra?.receipt && !current.receipt) || (extra?.receiptPayload && !current.receiptPayload)
            || (extra?.failureReason && !current.failureReason)) {
            // NOTE the COALESCE order, which is DELIBERATELY THE OPPOSITE of the main update above, and was
            // read as a bug in review — so it is worth spelling out.
            //
            //   main path:  COALESCE(?, col)  → "prefer what the caller passed"      (a normal transition)
            //   here:       COALESCE(col, ?)  → "fill a gap, never overwrite"        (we LOST the race)
            //
            // We are the loser here: another writer already reached this state. Their receipt is the one the
            // peer holds, so overwriting it with ours would leave two different valid signatures for one
            // settlement — exactly what idempotency exists to prevent. We may only fill in what nobody set.
            // The guard above is what makes this reachable at all: it fires only when a field is still null,
            // and COALESCE(null, ?) is ?.
            db.prepare(`
                UPDATE settlements
                SET receipt = COALESCE(receipt, ?), receipt_payload = COALESCE(receipt_payload, ?),
                    failure_reason = COALESCE(failure_reason, ?),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE key = ? AND state = ?
            `).run(extra?.receipt ?? null, extra?.receiptPayload ?? null, extra?.failureReason ?? null, key, to);
            return getSettlement(key)!;
        }
        return current;
    }
    return getSettlement(key)!;
}

/**
 * The unfinalised state list as a SQL literal.
 *
 * Bound placeholders defeat the partial index (review finding, and my previous test for this was
 * VACUOUS — it EXPLAINed a literal query while production bound parameters). SQLite matches a partial
 * index by proving the query's predicate implies the index's WHERE condition, and it does that at PREPARE
 * time, when a bound parameter's value is still unknown. So `state IN (?,?,?,?)` cannot be proven to imply
 * `state IN ('escrowed',…)` and the index is skipped.
 *
 * Safe to interpolate: the values come from a `const` tuple in this file, never from input.
 */
const UNFINALISED_SQL = UNFINALISED.map(s => `'${s}'`).join(',');

/** Unfinalised settlements, oldest first — what boot recovery iterates. */
export function unfinalisedSettlements(direction?: SettlementDirection): SettlementRow[] {
    const sql = `SELECT * FROM settlements WHERE state IN (${UNFINALISED_SQL})`
        + (direction ? ' AND direction = ?' : '')
        + ' ORDER BY created_at';
    const rows = direction
        ? db.prepare(sql).all(direction)
        : db.prepare(sql).all();
    return (rows as any[]).map(rowToSettlement);
}

/** The exact SQL production runs, so a test can EXPLAIN the real thing rather than a lookalike. */
export const unfinalisedSettlementsSql = (direction?: SettlementDirection): string =>
    `SELECT * FROM settlements WHERE state IN (${UNFINALISED_SQL})`
    + (direction ? ' AND direction = ?' : '')
    + ' ORDER BY created_at';

/**
 * Beans already promised to a peer by open reservations and unpaid held receipts.
 *
 * §2.5 calls a reservation "a hint that reduces headroom", and this is what makes that true (review
 * finding). Without it every concurrent PURCHASE is measured against the same full headroom, so several
 * can be accepted that together exceed the cap — and their receipts then predictably lapse *after* the
 * buyers have committed, forcing compensating reversals that were avoidable.
 *
 * @param excludeKey the reservation being re-checked at payment time, which must not count against itself.
 */
export function reservedAgainstPeer(peerId: string, excludeKey?: string): number {
    const row = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total FROM settlements
        WHERE direction = 'inbound' AND peer_id = ? AND state IN ('reserved', 'held')
          AND (? IS NULL OR key != ?)
    `).get(peerId, excludeKey ?? null, excludeKey ?? '') as any;
    return Math.round((row?.total ?? 0) * 10000) / 10000;
}

/**
 * Inbound reservations whose hold has lapsed with no receipt.
 *
 * A reservation moves no beans on either side, so letting one go is free — it just returns the headroom
 * it was holding. Rows are compared as ISO-8601 strings, which sort lexicographically in the same order
 * they sort chronologically, so a plain string comparison is a correct time comparison here.
 */
export function expiredReservations(nowIso = new Date().toISOString()): SettlementRow[] {
    return (db.prepare(`
        SELECT * FROM settlements
        WHERE direction = 'inbound' AND state = 'reserved'
          AND reserved_until IS NOT NULL AND reserved_until < ?
        ORDER BY created_at
    `).all(nowIso) as any[]).map(rowToSettlement);
}

/**
 * A member's committed foreign exposure — Rule 4's aggregate figure, across ALL peers (§3.1).
 *
 * READ ONLY, deliberately. Rule 4 caps a member's foreign spending in aggregate, and that cap is already
 * enforced, by the ordinary escrow floor check: a cross-node purchase moves the beans into local escrow
 * through `transfer(..., 'escrow')`, which bounds the debit by `usableFloor`. Spending abroad therefore
 * draws down the same single pot as spending at home, automatically, with no second gate to keep in step.
 *
 * So what is missing is not enforcement but *visibility* — the spec's "what still has to be tracked is
 * committed foreign exposure". This is that number. Adding a separate cap here would be a second
 * authority on the same limit, and the two would eventually disagree.
 *
 * Counts price + fee (what actually left the member) for rows that are still live or complete. Reversed
 * and abandoned rows are excluded because their entries have been compensated — the member got it back.
 */
export function memberForeignExposure(publicKey: string): number {
    const row = db.prepare(`
        SELECT COALESCE(SUM(amount + fee), 0) AS total FROM settlements
        WHERE direction = 'outbound' AND buyer_pubkey = ?
          AND state IN ('escrowed', 'committed', 'settled')
    `).get(publicKey) as any;
    return Math.round((row?.total ?? 0) * 10000) / 10000;
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
