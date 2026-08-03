/**
 * The cross-node settlement exchange — the ledger half of #104 (step 3b).
 *
 * Spec: docs/federation-economics.md §2.5. Step 3a built the durable state machine; this drives it and
 * writes the actual entries. The libp2p wire actions live in `federation-protocol.ts`; everything here is
 * local and synchronous-ish, which is what makes both halves testable on one node.
 *
 * THE FOUR ENTRIES (§2.1). Buyer B on BRISBANE buys a 5-bean service from seller S on BYRON:
 *
 *     BYRON                                    BRISBANE
 *       S                     +5.000            B                     −5.075
 *       bridge_brisbane       −5.000            COMMONS_POOL          +0.075
 *                                               bridge_byron          +5.000
 *       ─────────────────────────────           ─────────────────────────────
 *       node total             0.000            node total             0.000
 *
 * Two invariants the code below exists to preserve, and which the tests assert directly:
 *   • the bridge entries are equal and opposite and carry the PRICE ONLY — never price plus fee. The fee
 *     is a local matter and must not cross the border.
 *   • the seller receives EXACTLY the agreed amount. They quoted 5, they get 5. So every transfer here is
 *     explicitly fee-exempt and the fee is moved by hand — the automatic 1.5% deducts from the *recipient*
 *     (§8), which is the local convention and the wrong one here (§2.1).
 *
 * WHO WRITES WHAT (Rule 3a). Each node writes only its own ledger. Brisbane debits its own member on that
 * member's own signed instruction; Byron pays its own seller under its own cap. Neither ever asks the
 * other to touch a member account, so a compromised peer's maximum reach is exactly the cap its
 * counterparty chose.
 *
 * ORDER (Rule 3c). Byron never credits its seller before it holds a signed receipt. The one reachable
 * failure state is Brisbane owing outward for something not yet delivered — recoverable, and never an
 * unbacked local mint.
 */

import { db } from './db/db.js';
import { TRANSACTION_FEE_RATE } from '@beanpool/core';
import {
    transfer, registerVisitor, getMember, moveToCommons, payFromCommons,
    conservingTransaction, getNodeRole,
} from './state-engine.js';
import { bridgeAccountId, ensureBridgeAccount, settlementCapacityForPeer } from './federation-bridge.js';
import { getConnectors } from './connector-manager.js';
import {
    openSettlement, advanceSettlement, getSettlement, unfinalisedSettlements, expiredReservations,
    receiptStatus, actionForReceiptStatus, type SettlementRow, type ReceiptStatus,
} from './federation-settlement-state.js';
import { signReceipt, verifyReceipt, type SettlementReceipt } from './federation-receipt.js';

/**
 * Timeouts, and the ordering constraint between them.
 *
 * §2.5: "Byron's reservation must outlive Brisbane's step-3 timeout, by a clear margin." If it doesn't,
 * `CAPACITY_LAPSED` fires in *normal* operation instead of only on a genuine fault, and the rare
 * compensating path becomes the routine one. The assertion below encodes that so a future edit to one
 * number can't silently invert the relationship.
 *
 * These are starting values tuned for a healthy link. They are NOT trustworthy until measured on the real
 * 1cpu/1GB test pair — that added latency is the entire reason to test there rather than on localhost.
 */
export const PURCHASE_ASK_TIMEOUT_MS = 10_000;
export const RECEIPT_DELIVERY_TIMEOUT_MS = 15_000;
export const RESERVATION_TTL_MS = 120_000;

/**
 * How long an outbound settlement may sit unresolved before it is reported as STUCK (review finding).
 *
 * `UNKNOWN` from `GET_RECEIPT_STATUS` means wait, and that is right — `NOT_FOUND` instructs a reversal, so
 * treating an unrecognised key as permission to reverse is how a settled trade gets silently undone. But
 * "wait" with no bound means a buyer's beans can sit in a committed settlement forever, re-counted as
 * "still open" on every boot and never surfacing to anyone.
 *
 * So the wait is bounded, and what the bound triggers is **escalation, not reversal**. A cross-node
 * settlement that stays ambiguous for a day is a genuine dispute between two communities: it needs a human
 * who can talk to the other operator, not a node guessing which way to write the ledger. 24h so a sleeping
 * solar node that misses an overnight window is not immediately an incident.
 */
export const STUCK_SETTLEMENT_AFTER_MS = 24 * 60 * 60 * 1000;

if (RESERVATION_TTL_MS <= PURCHASE_ASK_TIMEOUT_MS + RECEIPT_DELIVERY_TIMEOUT_MS) {
    throw new Error(
        '[Federation] RESERVATION_TTL_MS must outlive the ask + delivery timeouts by a clear margin — '
        + 'otherwise CAPACITY_LAPSED fires in normal operation (docs/federation-economics.md §2.5)',
    );
}

/** Beans are carried to 4dp internally; round every derived figure so escrow closes to exactly zero. */
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** The fee the buyer pays ON TOP of the price (§2.1). */
export const crossNodeFee = (amount: number): number => round4(amount * TRANSACTION_FEE_RATE);

/** The local escrow account holding a pending cross-node purchase. Derived from the key, so no column. */
const escrowAccountFor = (key: string): string => `escrow_${key}`;

/** Read a balance straight from the rows. Used to tell "already funded" from "not yet". */
const balanceOfAccount = (id: string): number =>
    round4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(id) as any)?.balance ?? 0);

export class SettlementError extends Error {
    constructor(message: string, readonly reason: string) { super(message); }
}

function requireAmount(amount: number): void {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new SettlementError('A settlement amount must be a positive number', 'invalid_amount');
    }
}

/** `transfer()` answers failure with null. Turn that into a throw so an enclosing db.transaction rolls back. */
function mustTransfer(from: string, to: string, amount: number, memo: string): void {
    if (amount === 0) return;
    const txn = transfer(from, to, amount, memo, 'direct', /* isFeeExempt */ true);
    if (!txn) throw new SettlementError(`Ledger move refused: ${from} → ${to} (${amount})`, 'ledger_refused');
}

/**
 * Run a settlement's writes in a DB transaction that also unwinds the IN-MEMORY ledger on failure.
 *
 * THE PROBLEM THIS SOLVES (review finding, and the most consequential one in #123). `transfer()`,
 * `moveToCommons()` and `payFromCommons()` mutate the in-memory `ledger` as well as writing SQLite, and
 * `db.transaction()` rolls back only the SQLite half — so a later throw leaves the two disagreeing
 * permanently. `conservingTransaction` in state-engine unwinds both halves; its comment carries the full
 * reasoning, and it lives there because the hazard belongs to the ledger primitives rather than to
 * federation (a later review found `adminPruneUser` had exactly the same hole).
 *
 * It is reachable HERE specifically because the compare-and-swap in `advanceSettlement` throws on a lost
 * race, and it runs *after* the ledger moves in every write path in this file — so hardening the state
 * machine introduced this hazard at exactly the wrong point.
 */
const settlementTransaction = conservingTransaction;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// BUYER'S NODE (outbound) — steps 1, 3, and the compensating reversal
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: hold the buyer's beans in ordinary local escrow. Nothing has crossed the border yet.
 *
 * Escrow deliberately happens BEFORE asking the peer (§2.5). Step 2 is the sole gate on the peer's cap and
 * the peer is the only authority on it, so asking first would be advisory and stale by the time it
 * mattered. Escrow is cheap and fully reversible; discovering the buyer can't afford it after a round trip
 * is not.
 *
 * This is also what retires the old `usableFloor` reservation arithmetic (§3.1): the beans have already
 * left the spendable balance, so the local/foreign double-spend window closes by itself. The floor check
 * inside `transfer(..., 'escrow')` is what enforces Rule 4's aggregate cap — there is no second limit.
 */
export function beginOutboundSettlement(input: {
    key: string;
    peerId: string;
    buyerPublicKey: string;
    /** Persisted so the receipt can be replayed byte-identically after a retry. */
    buyerHomeNode?: string | null;
    sellerPublicKey: string;
    postId?: string | null;
    amount: number;
}): SettlementRow {
    requireAmount(input.amount);

    const amount = round4(input.amount);
    const fee = crossNodeFee(amount);
    const escrowAccount = escrowAccountFor(input.key);

    return settlementTransaction(() => {
        // Claim the KEY FIRST, inside the transaction, and only debit the buyer if this call is the one
        // that created the row.
        //
        // The previous order — check `getSettlement` outside the transaction, transfer, then insert — could
        // debit the buyer TWICE (review finding): two calls with the same key both see no row, both
        // transfer, and then one `ON CONFLICT DO NOTHING` quietly discards the second row while its escrow
        // debit stands. The row's PRIMARY KEY is a perfectly good mutex; use it as one rather than checking
        // and hoping. `openSettlement` also validates the payload, so a mismatched retry throws here instead
        // of being treated as an idempotent hit.
        const row = openSettlement({
            key: input.key,
            direction: 'outbound',
            peerId: input.peerId,
            buyerPubkey: input.buyerPublicKey,
            sellerPubkey: input.sellerPublicKey,
            buyerHomeNode: input.buyerHomeNode ?? null,
            postId: input.postId ?? null,
            amount,
            fee,
            state: 'escrowed',
        });

        // Not ours to fund: either an earlier call already escrowed for this key, or it has moved on.
        if (row.state !== 'escrowed' || row.createdAt !== row.updatedAt) return row;
        if (balanceOfAccount(escrowAccount) > 0) return row;   // already funded by an earlier attempt

        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`)
            .run(escrowAccount);

        // 'escrow' method, not 'direct': that is what bounds the debit by the member's offer-banded
        // usableFloor rather than by a positive balance, which is the whole point of a credit line.
        const held = transfer(
            input.buyerPublicKey, escrowAccount, round4(amount + fee),
            `Cross-community purchase hold (${input.key})`, 'escrow', /* isFeeExempt */ true,
        );
        if (!held) {
            throw new SettlementError(
                'Not enough credit to cover this purchase and its fee', 'insufficient_credit',
            );
        }
        return row;
    });
}

/**
 * Step 3: the peer accepted, so convert escrow into the real entries and issue the signed receipt.
 *
 * The state row moves to `committed` inside the same transaction as the entries, and the receipt is
 * returned only after that commits. That ordering is what makes a bridge disagreement DETECTABLE later
 * (§2.5): without a persisted `committed`, a receipt that was never acted on is invisible and the mismatch
 * surfaces much later as unexplained drift between the two nodes' bridge rows.
 *
 * Idempotent: a retry after the entries were written returns the SAME stored receipt rather than signing a
 * second one, so a redelivery can never produce two different valid receipts for one key.
 */
export async function commitOutboundSettlement(
    key: string,
    ourPeerId: string,
    privateKey: any,
    buyerHomeNode?: string | null,
): Promise<{ receipt: SettlementReceipt; signature: string }> {
    const row = getSettlement(key);
    if (!row) throw new SettlementError(`Unknown settlement ${key}`, 'unknown_settlement');
    if (row.direction !== 'outbound') {
        throw new SettlementError(`${key} is not ours to commit`, 'wrong_direction');
    }

    // Already committed: replay the STORED receipt object verbatim, alongside its stored signature.
    //
    // Rebuilding it from the row does NOT work, and this was broken (review finding). `committedAt` was
    // reconstructed from `row.updatedAt` — a different clock and a different string format from the
    // `new Date().toISOString()` that was actually signed — and `buyerHomeNode` was never persisted on the
    // outbound row at all. So a retry returned the old signature next to a *different* receipt, and the
    // peer's `verifyReceipt` rejected it. The retry path is precisely the path that runs after a network
    // failure, so it was broken exactly when it was needed.
    if (row.state === 'committed' || row.state === 'settled') {
        if (!row.receipt || !row.receiptPayload) {
            throw new SettlementError(`${key} is ${row.state} with no stored receipt`, 'receipt_missing');
        }
        return { receipt: JSON.parse(row.receiptPayload) as SettlementReceipt, signature: row.receipt };
    }
    if (row.state !== 'escrowed') {
        throw new SettlementError(`${key} is ${row.state}, not awaiting commit`, 'wrong_state');
    }

    const receipt: SettlementReceipt = {
        key: row.key,
        issuerPeerId: ourPeerId,
        buyerPublicKey: row.buyerPubkey,
        buyerHomeNode: buyerHomeNode ?? row.buyerHomeNode ?? null,
        sellerPublicKey: row.sellerPubkey ?? '',
        postId: row.postId,
        amount: row.amount,
        committedAt: new Date().toISOString(),
    };

    // Signing is async and better-sqlite3 transactions are synchronous, so sign first, then write. Safe in
    // this order: a crash between the two leaves the row `escrowed`, which boot recovery refunds.
    const signature = await signReceipt(receipt, privateKey);
    const escrowAccount = escrowAccountFor(key);
    const bridge = bridgeAccountId(row.peerId);
    ensureBridgeAccount(row.peerId);

    return settlementTransaction(() => {
        // RE-READ INSIDE THE TRANSACTION, and let the first writer win.
        //
        // This closes a genuine double-spend (review finding), and unlike the earlier "not reachable
        // in-process" races this one WAS reachable: `signReceipt` is awaited between the state read above
        // and this transaction, so two overlapping retries both observed `escrowed` and both arrived here.
        // The second would repeat the bridge and Commons moves — and because a synthetic `escrow_` account
        // has an unbounded floor, `mustTransfer` happily drives it NEGATIVE rather than refusing. The bridge
        // would be credited twice for one purchase, and the same-state metadata write would then replace the
        // first receipt with the second. Two valid receipts, double the tab, one trade.
        const fresh = getSettlement(key);
        if (!fresh) throw new SettlementError(`Unknown settlement ${key}`, 'unknown_settlement');
        if (fresh.state !== 'escrowed') {
            if (!fresh.receipt || !fresh.receiptPayload) {
                throw new SettlementError(`${key} is ${fresh.state} with no stored receipt`, 'receipt_missing');
            }
            return {
                receipt: JSON.parse(fresh.receiptPayload) as SettlementReceipt,
                signature: fresh.receipt,
            };
        }

        // Price to the bridge; fee to our OWN Commons. The bridge entry carries the price alone, so the
        // two nodes' bridge rows can be equal and opposite.
        mustTransfer(escrowAccount, bridge, fresh.amount, `Cross-community purchase (${key})`);
        // moveToCommons, NOT transfer(..., 'COMMONS_POOL', ...) — see its docstring. A transfer into the
        // COMMONS_POOL *account* is overwritten by the next persistCommonsBalance() flush, so the fee
        // would vanish from the books and the node would stop summing to zero.
        if (fresh.fee > 0 && !moveToCommons(escrowAccount, fresh.fee, `Cross-community purchase fee (${key})`)) {
            throw new SettlementError(`Could not move the fee for ${key} to the Commons`, 'fee_failed');
        }
        // Persist the payload as well as the signature, so a retry can hand back byte-identical bytes.
        advanceSettlement(key, 'committed', { receipt: signature, receiptPayload: JSON.stringify(receipt) });
        return { receipt, signature };
    });
}

/**
 * Undo a committed settlement with COMPENSATING ENTRIES against the same key — never by deleting rows.
 *
 * Called when the peer answers `CAPACITY_LAPSED`, or when `GET_RECEIPT_STATUS` answers `NOT_FOUND`.
 *
 * Why compensate rather than delete (§2.5): removing the rows would make a settled trade
 * indistinguishable from one that never happened, defeat `runLedgerAudit`, and hand a spoofed or replayed
 * `CAPACITY_LAPSED` the power to quietly rewrite history. Both the original and the reversal stay in the
 * ledger, which is self-documenting and idempotent on the key.
 *
 * The fee is refunded too. The trade did not happen, so the buyer is made whole — the fee is a charge on a
 * completed crossing, not a fee for asking.
 */
/**
 * Plain-language memo for a reversal, keyed off the internal reason code.
 *
 * The code itself stays in `failure_reason` for operators and audits; a member's ledger gets words (review
 * finding). "CAPACITY_LAPSED" tells someone reading their own transaction history nothing about what
 * happened or whether it was their fault — and it wasn't.
 */
function reversalMemo(reason: string): string {
    switch (reason) {
        case 'CAPACITY_LAPSED':
            return 'Refunded — the other community had reached its credit limit';
        // Both spellings of the same thing (review finding). Recovery reverses with `RECEIPT_NOT_FOUND`
        // after a status query; the live delivery path reverses with the peer's own `NOT_FOUND`. Only one
        // was listed, so a member whose purchase reversed on the live path read the generic fallback.
        case 'RECEIPT_NOT_FOUND':
        case 'NOT_FOUND':
            return 'Refunded — the other community did not complete the sale';
        // The cause is a signature or a mismatched receipt, and naming that would tell a member nothing
        // except that something sounded alarming. What is true and useful: it could not be confirmed, it was
        // not their fault, and they have their beans back.
        case 'BAD_SIGNATURE':
        case 'RECEIPT_MISMATCH':
            return 'Refunded — this purchase could not be confirmed with the other community';
        default:
            return 'Refunded — this cross-community purchase could not be completed';
    }
}

/**
 * OUR words for our own member, chosen by reason code — never the peer's words.
 *
 * A refusal arrives over the wire from a node we do not control, running a build we did not ship. Passing
 * its `message` (or worse its `error`) through to a member renders remote text in our own UI: a peer that is
 * hostile, buggy, or simply on an older version can write whatever it likes into someone's purchase history.
 * The review finding framed this as leaking internal diagnostics, which is the milder half — the sharper
 * point is that `message` is no more trustworthy than `error`, so type-checking it is not enough.
 *
 * The peer's own text is kept: it goes to the log for operators, and the reason CODE is what the ledger row
 * records. Only the sentence a member reads is ours.
 */
function refusalMessage(reason: string): string {
    switch (reason) {
        case 'ASK_UNREACHABLE':
            return 'That community could not be reached just now, so nothing was charged. Please try again.';
        case 'cap_exhausted':
        case 'no_cap_configured':
            return 'That community is not accepting purchases from ours at the moment. Nothing was charged.';
        case 'seller_not_local':
            return 'That seller is no longer listed with their community. Nothing was charged.';
        case 'settlement_closed':
        case 'RESERVATION_EXPIRED':
            return 'This purchase took too long to complete, so it was cancelled. Nothing was charged.';
        // key_conflict, invalid_*, buyer_is_local, unknown_home_node: all of them mean the two nodes
        // disagree about something a member has no part in and cannot act on. One honest sentence.
        default:
            return 'That community did not accept this purchase. Nothing was charged.';
    }
}

export function reverseOutboundSettlement(key: string, reason: string): SettlementRow {
    const row = getSettlement(key);
    if (!row) throw new SettlementError(`Unknown settlement ${key}`, 'unknown_settlement');
    if (row.state === 'reversed') return row;                       // idempotent
    if (row.direction !== 'outbound') {
        throw new SettlementError(`${key} is not ours to reverse`, 'wrong_direction');
    }
    if (row.state !== 'committed') {
        throw new SettlementError(`${key} is ${row.state}, not reversible`, 'wrong_state');
    }

    const bridge = bridgeAccountId(row.peerId);

    return settlementTransaction(() => {
        // The PRINCIPAL always goes back. Naming the reason in the memo so a member sees why their purchase
        // reversed rather than only that it did.
        mustTransfer(bridge, row.buyerPubkey, row.amount, `${reversalMemo(reason)} (${key})`);

        // Drawn from the Commons pot, not from the shadow account — otherwise the refund is funded from
        // nowhere and the node's books stop balancing.
        //
        // `allowDeficit`, and NOT a throw (review finding). Throwing rolled the whole transaction back
        // including the principal refund, so a depleted Commons held the buyer's entire purchase hostage in
        // `committed` — a far worse outcome than the fractional fee it was protecting. Letting the pot go
        // negative also matches the documented Solvency Rule for write-offs
        // (docs/commons-pool-transparency.md): a negative Commons is the honest record of a community that
        // has paid out more than it has collected, and the network still sums to zero.
        if (row.fee > 0) {
            payFromCommons(row.buyerPubkey, row.fee, `Refunded cross-community fee (${key})`, { allowDeficit: true });
        }
        return advanceSettlement(key, 'reversed', { failureReason: reason });
    });
}

/**
 * Release an escrow hold for a purchase the peer never accepted. Nothing crossed the border, so this is a
 * plain refund rather than a compensating entry — there is nothing to compensate.
 */
export function abandonOutboundSettlement(key: string, reason: string): SettlementRow {
    const row = getSettlement(key);
    if (!row) throw new SettlementError(`Unknown settlement ${key}`, 'unknown_settlement');
    if (row.state === 'abandoned') return row;                      // idempotent
    if (row.direction !== 'outbound' || row.state !== 'escrowed') {
        throw new SettlementError(`${key} is ${row.state}, not an unasked hold`, 'wrong_state');
    }

    return settlementTransaction(() => {
        mustTransfer(
            escrowAccountFor(key), row.buyerPubkey, round4(row.amount + row.fee),
            `Released cross-community hold (${key})`,
        );
        return advanceSettlement(key, 'abandoned', { failureReason: reason });
    });
}

/** The peer confirmed it paid its seller. Both bridges agree; nothing left to do but record it. */
export function finaliseOutboundSettlement(key: string): SettlementRow {
    const row = getSettlement(key);
    if (!row) throw new SettlementError(`Unknown settlement ${key}`, 'unknown_settlement');
    if (row.state === 'settled') return row;
    return advanceSettlement(key, 'settled');
}

/**
 * What the buyer is told, and it is deliberately about THEIR BEANS rather than about our state machine.
 *
 *   settled  — done, the seller has been paid.
 *   refused  — the other community said no before anything crossed. Beans already back.
 *   reversed — it crossed and could not be completed. Beans back, by compensating entries.
 *   pending  — still in flight. Beans held, and recovery will resolve it either way.
 *
 * `pending` covers two different internal states on purpose: `escrowed` (the commit never landed, so boot
 * recovery refunds) and `committed` (we owe outward and only the peer knows whether it paid). Both mean the
 * same thing to the person waiting — held, not lost, no action from you.
 */
export type OutboundOutcome =
    | { status: 'settled'; key: string }
    | { status: 'refused' | 'reversed' | 'pending'; key: string; reason: string; message: string };

/**
 * The wire, injected rather than imported.
 *
 * `federation-protocol.ts` already imports this module for the responder half, so importing its dialling
 * functions back would be a cycle. Injecting also means the orchestration below — which is where the
 * money-losing mistakes live — can be driven without libp2p at all.
 */
export interface SettlementWire {
    ask(payload: {
        key: string;
        buyerPublicKey: string;
        buyerCallsign?: string;
        buyerHomeNode?: string | null;
        sellerPublicKey: string;
        postId?: string | null;
        amount: number;
    }): Promise<any>;
    deliver(payload: { key: string; receipt: SettlementReceipt; signature: string }): Promise<any>;
}

/**
 * A refusal we may act on by REVERSING. Anything else means "not yet", and must be left to recovery.
 *
 * This asymmetry is the most important line in the file. Waiting on an ambiguous answer costs a delay;
 * reversing on one risks compensating a trade the peer actually completed — paying its seller from the
 * bridge while we hand the buyer their beans back, so the pair no longer sums to zero and the difference is
 * real beans. So only answers that mean "we will never pay this" are allowed to trigger a reversal:
 *
 *   CAPACITY_LAPSED   — they latched it `reversed`; terminal on their side.
 *   NOT_FOUND         — no reservation exists for the key, so no payment can ever be made against it.
 *   BAD_SIGNATURE     — they cannot verify our receipt, so they will never honour it.
 *   RECEIPT_MISMATCH  — the receipt describes a different trade from the one they reserved.
 *
 * Notably ABSENT: `settlement_error`. That is `handleReceiptDelivery` failing to pay a receipt it has
 * already persisted as `held` — it will retry on its next boot, so reversing would be the double-spend
 * above. It maps to `pending`.
 */
const TERMINAL_REFUSALS = new Set(['CAPACITY_LAPSED', 'NOT_FOUND', 'BAD_SIGNATURE', 'RECEIPT_MISMATCH']);

/**
 * Release a hold that was never accepted, and answer the buyer. Only valid while the row is `escrowed`.
 *
 * Re-reads the state rather than trusting the one read a moment ago (review finding, generalised). Recovery
 * runs on a timer over every unfinalised settlement and refunds `escrowed` rows, so it can move this row
 * between the read and here — and `abandonOutboundSettlement` throws on anything that is not an unasked
 * hold. It is idempotent for an already-`abandoned` row, so the only real risk is a state it cannot handle;
 * checking is cheaper than reasoning about which timer might have won.
 */
function releaseUnaskedHold(key: string, reason: string): OutboundOutcome {
    const now = getSettlement(key);
    if (now?.state === 'escrowed' || now?.state === 'abandoned') {
        abandonOutboundSettlement(key, reason);
        return { status: 'refused', key, reason, message: refusalMessage(reason) };
    }
    // Something else has moved it on. Say so honestly rather than forcing a transition that would throw.
    console.warn(`[Federation] ${key} was ${now?.state} when releasing the hold (${reason}) — left as is.`);
    return {
        status: 'pending', key, reason,
        message: 'This purchase is still completing. It will finish on its own, or your beans will be returned.',
    };
}

/**
 * Drive one cross-node purchase end to end, from the BUYER's node. Steps 1–4 of §2.5.
 *
 * This is the piece that was missing: both halves of the wire existed and the whole local state machine
 * existed, but nothing composed them, so no cross-node purchase was reachable in production and the
 * acceptance criteria in #104 could not be met by any code path a member could trigger.
 *
 * Throws only if step 1 fails — the local escrow. Nothing has happened at that point, and the reason (they
 * cannot afford it, the amount is invalid) is the buyer's to see. Everything after step 1 returns an
 * outcome, because once beans are held, "what happened to them" is the only useful answer.
 */
export async function runOutboundSettlement(
    input: {
        key: string;
        peerId: string;
        buyerPublicKey: string;
        buyerCallsign?: string;
        buyerHomeNode?: string | null;
        sellerPublicKey: string;
        postId?: string | null;
        amount: number;
    },
    wire: SettlementWire,
    ourPeerId: string,
    privateKey: any,
): Promise<OutboundOutcome> {
    const { key } = input;

    // Step 1 — hold the buyer's beans locally. Throws if they cannot cover it; nothing to undo.
    //
    // IDEMPOTENT ON THE KEY: a retry returns the EXISTING row rather than debiting the buyer twice. So the
    // state it comes back in is what decides where to resume, and ignoring it was a real bug (review
    // finding) — a retry of an already-`committed` key would re-ask, and if that ask then timed out the
    // catch below called `abandonOutboundSettlement`, which throws `not an unasked hold` on a committed row.
    // An unhandled throw, out of the compensation path, for a settlement we already owe outward on.
    const opened = beginOutboundSettlement(input);

    // A key that has already finished is answered from the row, not re-run. This is the retry path, so it is
    // exactly the path a member hits after a network wobble — and the row is the authority on what happened.
    if (opened.state === 'settled') return { status: 'settled', key };
    if (opened.state === 'abandoned') {
        const reason = opened.failureReason ?? 'REFUSED';
        return { status: 'refused', key, reason, message: refusalMessage(reason) };
    }
    if (opened.state === 'reversed') {
        const reason = opened.failureReason ?? 'REVERSED';
        return { status: 'reversed', key, reason, message: reversalMemo(reason) };
    }

    // Step 2 — ask the seller's node. Their cap is the only authority, and this is where it is applied.
    //
    // SKIPPED ENTIRELY on a `committed` row: the border is already crossed, the receipt already signed, and
    // what is unfinished is the delivery. Re-asking would be harmless on their side (the responder is
    // idempotent on the key) but it is the wrong question — resume at step 3, which replays the stored
    // receipt byte-for-byte.
    if (opened.state === 'escrowed') {
        let decision: any;
        try {
            decision = await wire.ask({
                key,
                buyerPublicKey: input.buyerPublicKey,
                buyerCallsign: input.buyerCallsign,
                buyerHomeNode: input.buyerHomeNode ?? null,
                sellerPublicKey: input.sellerPublicKey,
                postId: input.postId ?? null,
                amount: input.amount,
            });
        } catch (e: any) {
            // A LOST ASK IS SAFE TO RELEASE, and this is the one transport failure that is. Step 2 moves no
            // beans on either side — the seller's node reserves headroom and nothing more — so releasing our
            // hold cannot leave the two ledgers disagreeing. The buyer gets their beans back immediately,
            // which beats holding them for the two minutes a reservation takes to lapse.
            //
            // If the ask did arrive and only the reply was lost, their reservation expires on its own via
            // `expireStaleReservations`, and a retry on the SAME key is idempotent there anyway.
            return releaseUnaskedHold(key, 'ASK_UNREACHABLE');
        }

        if (!decision || decision.accepted !== true) {
            const reason = decision?.reason ?? decision?.code ?? 'REFUSED';
            // The peer's own words go to the LOG, for an operator. What the member reads is ours — see
            // `refusalMessage`.
            const peerSaid = decision?.message ?? decision?.error;
            if (peerSaid) console.log(`[Federation] ${key} refused by peer (${reason}): ${peerSaid}`);
            return releaseUnaskedHold(key, reason);
        }
    }

    // Step 3 — commit: sign the receipt and move the hold into the bridge. The border is crossed here.
    let committed: { receipt: SettlementReceipt; signature: string };
    try {
        committed = await commitOutboundSettlement(key, ourPeerId, privateKey, input.buyerHomeNode ?? null);
    } catch (e: any) {
        console.error(`[Federation] Committing ${key} failed:`, e?.message || e);
        const reason = e?.reason ?? 'commit_failed';
        // Read the state back before answering (review finding). This one IS reachable: the commit awaits
        // `signReceipt`, and recovery runs on a timer, so it can refund this row during that await. Recovery
        // ignores terminal states, so reporting `pending` for a row it has already ABANDONED would promise a
        // refund that has in fact already happened and leave the caller waiting for it forever.
        const fresh = getSettlement(key);
        if (fresh?.state === 'abandoned') {
            return { status: 'refused', key, reason: fresh.failureReason ?? reason, message: refusalMessage(reason) };
        }
        if (fresh?.state === 'reversed') {
            return { status: 'reversed', key, reason: fresh.failureReason ?? reason, message: reversalMemo(reason) };
        }
        // Still `escrowed`, which boot recovery refunds. Pending rather than refused, because the refund has
        // not happened yet and telling someone their beans are back before they are is worse than waiting.
        return {
            status: 'pending', key, reason,
            message: 'This purchase could not be completed. Your beans are held and will be returned.',
        };
    }

    // Step 4 — deliver the receipt, which is what authorises their local payment.
    let outcome: any;
    try {
        outcome = await wire.deliver({ key, receipt: committed.receipt, signature: committed.signature });
    } catch (e: any) {
        // AMBIGUOUS, AND THE ONE PLACE NOT TO ACT. We are committed and they may already have paid their
        // seller — the failure could be the reply, not the request. Reversing here is the double-spend
        // described on TERMINAL_REFUSALS. `recoverSettlements(askPeer)` resolves it with GET_RECEIPT_STATUS,
        // whose UNKNOWN answer means wait.
        console.warn(`[Federation] Receipt delivery for ${key} unresolved: ${e?.message || e}`);
        return {
            status: 'pending', key, reason: 'DELIVERY_UNRESOLVED',
            message: 'This purchase is still completing. It will finish on its own, or your beans will be returned.',
        };
    }

    if (outcome?.settled === true) {
        finaliseOutboundSettlement(key);
        return { status: 'settled', key };
    }

    const reason = outcome?.reason ?? outcome?.code ?? 'DELIVERY_REFUSED';
    if (TERMINAL_REFUSALS.has(reason)) {
        reverseOutboundSettlement(key, reason);
        // Our copy, not theirs — same reasoning as `refusalMessage`, and `reversalMemo` is already the
        // sentence written into the member's own ledger row, so the two now agree by construction.
        if (outcome?.message) console.log(`[Federation] ${key} reversed, peer said (${reason}): ${outcome.message}`);
        return { status: 'reversed', key, reason, message: reversalMemo(reason) };
    }
    // Not a terminal refusal: they hold the receipt and will retry. Leave it committed for recovery.
    console.warn(`[Federation] ${key} not settled yet (${reason}): ${outcome?.message ?? 'no detail'}`
        + ' — left committed for recovery.');
    return {
        status: 'pending', key, reason,
        message: 'This purchase is still completing. It will finish on its own, or your beans will be returned.',
    };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// SELLER'S NODE (inbound) — steps 2 and 4
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PurchaseDecision =
    | { accepted: true; key: string; reservedUntil: string }
    | { accepted: false; reason: string; message: string };

/**
 * Step 2: the peer asks whether we will accept a purchase from one of their members.
 *
 * We check our OWN cap on them and reserve against it. We do not pay our seller yet — that needs the
 * receipt (Rule 3c). Nothing about the cap is negotiable over the wire: the number comes from our own
 * connector record and a peer cannot raise the limit that constrains it (§3.2).
 *
 * IDEMPOTENCY. An accepted reservation is persisted, so a retried ask returns the same acceptance. A
 * refusal is deliberately NOT persisted: refusing is not a commitment, and the honest answer to "will you
 * accept now?" may legitimately have changed — headroom returns when the balance moves back.
 *
 * A key already held for a DIFFERENT peer is refused outright. Keys are minted by the buyer's node, so two
 * peers can collide by accident as well as on purpose, and silently answering for the wrong settlement
 * would let one peer's receipt be paid out of another's credit line.
 */
export function handlePurchaseRequest(input: {
    key: string;
    peerId: string;
    buyerPublicKey: string;
    buyerCallsign?: string;
    buyerHomeNode?: string | null;
    sellerPublicKey: string;
    postId?: string | null;
    amount: number;
}): PurchaseDecision {
    if (!input.key || typeof input.key !== 'string') {
        return { accepted: false, reason: 'invalid_key', message: 'A settlement key is required.' };
    }
    // `peer_id` is NOT NULL, so a missing one would surface as a raw SQLite exception from openSettlement
    // rather than a structured refusal the peer can act on. Every decision here is keyed on it anyway.
    if (!input.peerId || typeof input.peerId !== 'string') {
        return { accepted: false, reason: 'invalid_peer', message: 'Settlement requires an identified peer.' };
    }
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0) {
        return { accepted: false, reason: 'invalid_amount', message: 'A settlement amount must be a positive number.' };
    }
    if (!input.sellerPublicKey || !input.buyerPublicKey) {
        return { accepted: false, reason: 'invalid_parties', message: 'Both parties must be identified.' };
    }

    const existing = getSettlement(input.key);
    if (existing) {
        if (existing.peerId !== input.peerId || existing.direction !== 'inbound') {
            return {
                accepted: false, reason: 'key_conflict',
                message: 'That settlement reference is already in use.',
            };
        }
        // Re-asking with the same key must match the WHOLE reserved trade, not just peer and direction
        // (review finding). Amount alone was not enough: a key reused with a different buyer, seller or post
        // returned `accepted: true`, the buyer then committed against those new terms, and receipt delivery
        // compared them to the old row and refused — a compensating reversal that need never have happened.
        // Idempotency has to mean "the same trade", and a trade is the whole tuple.
        const sameTrade = round4(existing.amount) === round4(input.amount)
            && existing.buyerPubkey === input.buyerPublicKey
            && (existing.sellerPubkey ?? null) === input.sellerPublicKey
            && (existing.postId ?? null) === (input.postId ?? null);
        if (!sameTrade) {
            return {
                accepted: false, reason: 'key_conflict',
                message: 'That settlement reference is already in use for a different purchase.',
            };
        }
        if (existing.state === 'reserved' || existing.state === 'held' || existing.state === 'settled') {
            return {
                accepted: true, key: existing.key,
                reservedUntil: existing.reservedUntil ?? new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
            };
        }
        return {
            accepted: false, reason: existing.failureReason ?? 'settlement_closed',
            message: 'That purchase was already closed and cannot be reopened.',
        };
    }

    // The seller must actually be one of ours. Paying a stranger out of a bridge account would mint local
    // beans for someone with no local standing — the #102 defect wearing a different hat.
    const seller = getMember(input.sellerPublicKey);
    if (!seller || seller.homeNodeUrl) {
        return {
            accepted: false, reason: 'seller_not_local',
            message: 'That seller is not a member of this community.',
        };
    }

    // ...and the buyer must NOT be. Same shape as the `relay_message` impersonation guard (A2-28): the
    // connection is trusted, but that authorises the CONNECTION, not the asserted identity.
    //
    // This one has teeth beyond a bogus trade. Accepting it reaches `registerVisitor`, which stamps a
    // `home_node_url` onto an existing member row that has none — quietly converting one of OUR members
    // into a visitor. `assertLocalSettlement` then refuses that member's own local spending (#102). So any
    // peer that knows a local member's public key could freeze their account by naming them as a buyer.
    const claimedBuyer = getMember(input.buyerPublicKey);
    if (claimedBuyer && !claimedBuyer.homeNodeUrl) {
        console.warn(`[Federation] Peer ${input.peerId.slice(-8)} claimed local member ${input.buyerPublicKey.slice(0, 8)} as a cross-node buyer`);
        return {
            accepted: false, reason: 'buyer_is_local',
            message: 'That buyer is a member of this community, so their purchase is settled here, not across nodes.',
        };
    }

    const capacity = settlementCapacityForPeer(input.peerId, input.amount);
    if (!capacity.ok) return { accepted: false, reason: capacity.reason, message: capacity.message };

    const reservedUntil = new Date(Date.now() + RESERVATION_TTL_MS).toISOString();

    // The seller needs to know who they are serving, and a visitor record is how a cross-community
    // counterparty already renders in the clients. Tagged with their home node so it is never confused
    // with a local member.
    // The home node must be NON-EMPTY, and we fall back to the peer's own configured URL rather than
    // trusting the payload to carry one (review finding).
    //
    // `registerVisitor(pk, callsign, undefined)` inserts `home_node_url = NULL` — a row indistinguishable
    // from a LOCAL member. That is bad in both directions: the member appears local (so their next purchase
    // trips the `buyer_is_local` guard and is refused forever), and a remote key has entered the member
    // table without going through the normal local membership path at all.
    //
    // Deriving it from the connector is also strictly better than believing the payload: we know who the
    // peer is from the authenticated connection, whereas `buyerHomeNode` is just a string they sent.
    const resolvedHomeNode = input.buyerHomeNode?.trim()
        || getConnectors().find(c => c.peerId === input.peerId)?.publicUrl
        || null;
    if (!resolvedHomeNode) {
        return {
            accepted: false, reason: 'unknown_home_node',
            message: 'We cannot tell which community that buyer belongs to, so this purchase cannot be settled.',
        };
    }
    try {
        registerVisitor(input.buyerPublicKey, input.buyerCallsign, resolvedHomeNode);
    } catch (e: any) {
        console.warn('[Federation] Visitor record for cross-node buyer failed:', e?.message || e);
    }

    openSettlement({
        key: input.key,
        direction: 'inbound',
        peerId: input.peerId,
        buyerPubkey: input.buyerPublicKey,
        buyerHomeNode: resolvedHomeNode,
        sellerPubkey: input.sellerPublicKey,
        postId: input.postId ?? null,
        amount: round4(input.amount),
        reservedUntil,
        state: 'reserved',
    });

    return { accepted: true, key: input.key, reservedUntil };
}

export type ReceiptOutcome =
    | { settled: true; key: string }
    | { settled: false; reason: string; message: string };

/**
 * Step 4a: persist an arriving receipt, then attempt payment.
 *
 * Persist-then-pay is the order that makes payment REPLAYABLE (§2.5): a crash mid-payment resumes from the
 * stored receipt instead of losing the fact that we owe our seller. So `held` is committed on its own,
 * before any ledger write.
 *
 * Everything the receipt claims is re-checked against what we reserved. A receipt is a bearer instrument
 * for a local mint, so it must not be able to name a different amount, a different seller, or a different
 * peer than the reservation it settles — each of those would route real beans somewhere the cap check
 * never authorised.
 */
export async function handleReceiptDelivery(input: {
    key: string;
    receipt: SettlementReceipt;
    signature: string;
    peerId: string;
}): Promise<ReceiptOutcome> {
    const row = getSettlement(input.key);
    if (!row) {
        return { settled: false, reason: 'NOT_FOUND', message: 'No reservation exists for that settlement.' };
    }
    if (row.direction !== 'inbound' || row.peerId !== input.peerId) {
        return { settled: false, reason: 'NOT_FOUND', message: 'That settlement does not belong to this peer.' };
    }
    if (row.state === 'settled') return { settled: true, key: row.key };          // idempotent redelivery
    if (row.state === 'reversed' || row.state === 'abandoned') {
        return {
            settled: false,
            reason: row.failureReason ?? 'CAPACITY_LAPSED',
            message: 'That reservation is no longer open, so this purchase was not completed.',
        };
    }

    // Bind the receipt to the peer that presented it, and to the reservation it claims to settle.
    const ok = await verifyReceipt(input.receipt, input.signature, input.peerId);
    if (!ok) {
        return { settled: false, reason: 'BAD_SIGNATURE', message: 'That settlement receipt could not be verified.' };
    }
    if (!receiptMatchesRow(input.receipt, row)) {
        return { settled: false, reason: 'RECEIPT_MISMATCH', message: 'That receipt does not match the reserved purchase.' };
    }

    // Persist the receipt OBJECT as well as its signature (review finding). Storing only the signature
    // meant that after a reboot the seller's node could no longer verify what it holds — `committedAt` lived
    // nowhere else, so the payload could not be rebuilt — and `settleHeldReceipt` paid from the row's own
    // mutable fields instead. That contradicted §2.6's claim that the persisted receipt is the evidence
    // authorising the payment and stays checkable in an audit. Now it genuinely is.
    // Attach on the reserved→held transition AND to a `held` row that is missing either artifact.
    //
    // The second case is not hypothetical, and it is a trap the previous commit created (review finding): a
    // settlement that was already `held` before this build stored only a signature. Recovery now refuses to
    // pay a row it cannot re-verify, so without repairing it here that row would be **rejected forever** —
    // an in-flight trade permanently unpayable because of an upgrade. A redelivery is exactly the moment the
    // missing payload is back in our hands, so take it.
    if (row.state === 'reserved' || !row.receipt || !row.receiptPayload) {
        advanceSettlement(row.key, 'held', {
            receipt: input.signature,
            receiptPayload: JSON.stringify(input.receipt),
        });
    }

    // Answer with a structured refusal rather than letting a throw escape (review finding). A ledger error
    // here would propagate to the stream handler, which logs and closes WITHOUT writing a response — so the
    // peer sees a timeout instead of a reason, and its retry logic can't tell "refused" from "unreachable".
    // The receipt is already persisted as `held` at this point, so the payment stays replayable either way.
    try {
        return settleHeldReceipt(row.key);
    } catch (e: any) {
        console.error(`[Federation] Settling ${row.key} failed:`, e?.message || e);
        return {
            settled: false,
            reason: e?.reason ?? 'settlement_error',
            message: 'We could not complete that purchase just now. It is recorded and will be retried.',
        };
    }
}

/**
 * Step 4b: pay our seller from the peer's bridge account, or refuse with `CAPACITY_LAPSED`.
 *
 * Split out from delivery because boot recovery calls it directly, with no network and no receipt to
 * re-verify — the `held` row already is the verified receipt.
 *
 * The cap is re-evaluated HERE, atomically, and not trusted from the reservation. A slow network or a
 * sleeping VM can land a receipt late, and paying blindly could push us past the number our operator
 * chose. That makes a reservation *a hint that reduces headroom*, not a promise — the right shape, since a
 * node's own cap is the only authority on what it may extend and should never be bound by a decision it
 * made in the past.
 */
export function settleHeldReceipt(key: string, opts?: { latchOnRefusal?: boolean }): ReceiptOutcome {
    const latch = opts?.latchOnRefusal ?? true;
    const row = getSettlement(key);
    if (!row) return { settled: false, reason: 'NOT_FOUND', message: 'No such settlement.' };
    if (row.state === 'settled') return { settled: true, key };
    if (row.state !== 'held') {
        return { settled: false, reason: 'wrong_state', message: `Settlement is ${row.state}, not awaiting payment.` };
    }
    if (!row.sellerPubkey) {
        return { settled: false, reason: 'seller_unknown', message: 'No seller recorded for that settlement.' };
    }

    // excludeKey: this row's own reservation already counts toward `reservedAgainstPeer`, so without
    // excluding it the check would measure the payment against itself and always lapse.
    const capacity = settlementCapacityForPeer(row.peerId, row.amount, row.key);
    if (!capacity.ok) {
        // Do NOT pay. Whether to LATCH that refusal depends on who is asking, and the distinction matters
        // (review finding):
        //
        //   • Live delivery (latch): the peer is on the other end of a stream waiting for an answer, and
        //     `reversed` is what tells them to compensate their own entries. On this side there is nothing
        //     to compensate, because nothing was ever paid out.
        //   • Boot recovery (no latch): nobody is waiting. Latching here would turn a TEMPORARY cap change
        //     — an operator lowering a limit during maintenance, or a trust level briefly edited — into a
        //     permanent outcome, because `reversed` is terminal. Restoring the cap afterwards would not
        //     let the seller be paid, and we would owe someone with no way left to pay them.
        //
        // So recovery leaves it `held` and tries again next boot, and `stuckSettlements()` surfaces it if it
        // never clears.
        if (latch) {
            advanceSettlement(key, 'reversed', { failureReason: 'CAPACITY_LAPSED' });
        } else {
            console.warn(
                `[Federation] Held receipt ${key} cannot be settled yet (${capacity.message}). `
                + `Left held — it will be retried, and reported if it persists.`,
            );
        }
        return { settled: false, reason: 'CAPACITY_LAPSED', message: capacity.message };
    }

    ensureBridgeAccount(row.peerId);

    return settlementTransaction((): ReceiptOutcome => {
        // Re-read and let the first writer win, same as the commit path. Not currently reachable in-process
        // — `settleHeldReceipt` is fully synchronous, so no await can interleave between the read above and
        // this transaction — but the guarantee should not rest on that staying true, and here the cost of
        // being wrong is paying a seller twice out of a bridge account.
        const fresh = getSettlement(key);
        if (fresh?.state === 'settled') return { settled: true, key };
        if (fresh?.state !== 'held') {
            return { settled: false, reason: 'wrong_state', message: `Settlement is ${fresh?.state}, not awaiting payment.` };
        }

        // The seller receives exactly the agreed amount — fee-exempt, because the buyer already paid the
        // fee on their own node and it never crossed the border.
        mustTransfer(
            bridgeAccountId(fresh.peerId), fresh.sellerPubkey!, fresh.amount,
            `Cross-community sale (${key})`,
        );
        advanceSettlement(key, 'settled');
        return { settled: true, key };
    });
}

/**
 * Does a receipt describe the same trade as the settlement row it claims to settle?
 *
 * Shared by live delivery and by re-verification on recovery. A signature only proves WHO signed; this is
 * what proves WHAT they signed for — and payment is made from the ROW's fields, so if the two disagree the
 * signature is authorising terms nobody agreed to.
 */
function receiptMatchesRow(r: SettlementReceipt, row: SettlementRow): boolean {
    return !!r
        && r.key === row.key
        && round4(r.amount) === round4(row.amount)
        && r.buyerPublicKey === row.buyerPubkey
        && r.sellerPublicKey === (row.sellerPubkey ?? '')
        && (r.postId ?? null) === (row.postId ?? null);
}

/**
 * Re-verify the receipt stored on an inbound settlement: signed by the recorded peer, AND for this trade.
 *
 * Both halves are needed (review finding). Checking only the signature proved that *some* valid receipt was
 * stored, not that it describes the settlement we are about to pay — and `settleHeldReceipt` pays from the
 * ROW's amount and seller. A row that drifted from its receipt, by corruption or by a bug, would turn a
 * genuinely signed receipt into authorisation for different terms. So recovery reapplies exactly the match
 * live delivery applies.
 *
 * Returns false for a row with no stored payload — what a settlement written by an older build looks like.
 * Deliberately fail-closed: such a row is not payable without evidence, and having an operator see it
 * reported is far better than paying on the strength of a mutable database row.
 */
export async function verifyStoredReceipt(row: SettlementRow): Promise<boolean> {
    if (!row.receipt || !row.receiptPayload) return false;
    try {
        const receipt = JSON.parse(row.receiptPayload) as SettlementReceipt;
        if (!receiptMatchesRow(receipt, row)) return false;
        return await verifyReceipt(receipt, row.receipt, row.peerId);
    } catch {
        return false;
    }
}

/** The `GET_RECEIPT_STATUS(key)` answer. Scoped to the asking peer so no peer can probe another's keys. */
export function answerReceiptStatus(key: string, askingPeerId: string): ReceiptStatus {
    const row = getSettlement(key);
    // An unrecognised key — including one belonging to a different peer — is UNKNOWN, never NOT_FOUND.
    // NOT_FOUND instructs the asker to REVERSE, so defaulting to it would let a fabricated or truncated
    // key talk a node into undoing a trade that actually settled.
    if (!row || row.peerId !== askingPeerId) return 'UNKNOWN';
    return receiptStatus(key);
}

/**
 * Release inbound reservations that lapsed with no receipt, returning the headroom they were holding.
 *
 * Free to do: a reservation moves no beans on either side. A receipt arriving after this is not lost — it
 * is answered with `CAPACITY_LAPSED` and the buyer's node compensates.
 */
export function expireStaleReservations(): number {
    const stale = expiredReservations();
    for (const row of stale) {
        try {
            advanceSettlement(row.key, 'abandoned', { failureReason: 'RESERVATION_EXPIRED' });
        } catch (e: any) {
            console.warn(`[Federation] Could not expire reservation ${row.key}:`, e?.message || e);
        }
    }
    if (stale.length) console.log(`[Federation] Released ${stale.length} lapsed cap reservation(s)`);
    return stale.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// BOOT RECOVERY
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RecoveryResult {
    expired: number;
    paid: number;
    refunded: number;
    reversed: number;
    finalised: number;
    stillOpen: number;
    /** Unresolved for longer than STUCK_SETTLEMENT_AFTER_MS — needs an operator, not another retry. */
    stuck: SettlementRow[];
}

/**
 * Settlements unresolved long enough to need a human, on either side.
 *
 * Two shapes, both of which mean real value is in limbo and no amount of retrying will move it:
 *   • outbound `committed` — we debited our buyer and issued a receipt, and still don't know its fate.
 *   • inbound `held` — we hold a verified receipt and owe our seller, but cannot pay within our own cap.
 *     Recovery deliberately does not latch that as reversed, so without this it would retry silently
 *     forever while a local member goes unpaid.
 */
export function stuckSettlements(now = Date.now()): SettlementRow[] {
    const tooOld = (r: SettlementRow) => now - new Date(r.updatedAt).getTime() > STUCK_SETTLEMENT_AFTER_MS;
    return unfinalisedSettlements().filter(r =>
        tooOld(r) && (
            (r.direction === 'outbound' && r.state === 'committed')
            || (r.direction === 'inbound' && r.state === 'held')
        ),
    );
}

/**
 * Resolve every unfinalised settlement at boot. This is what makes "recoverable by replay" true rather
 * than aspirational (§2.5).
 *
 * DELIBERATELY NOT GATED on `FEDERATION_SETTLEMENT_ENABLED`. Turning settlement off is a decision about
 * accepting NEW cross-node trades; it must not strand beans already sitting in escrow or a seller already
 * owed money. An operator flipping the flag off is the most likely moment for in-flight rows to exist.
 *
 * @param askPeer resolves `GET_RECEIPT_STATUS` for an outbound row. Omitted (or throwing) leaves those
 *                rows alone for the next boot — waiting is always safe, reversing on a guess is not.
 */
export async function recoverSettlements(
    askPeer?: (peerId: string, key: string) => Promise<ReceiptStatus>,
): Promise<RecoveryResult> {
    const result: RecoveryResult = {
        expired: 0, paid: 0, refunded: 0, reversed: 0, finalised: 0, stillOpen: 0, stuck: [],
    };

    // PRIMARY ONLY (review finding). A backup's settlement rows arrive by snapshot import, and its ledger is
    // replaced by the next one — so recovery here would write entries that are about to be overwritten,
    // while telling a peer its trade was resolved. The rows stay untouched and are resolved by whichever
    // node is actually primary; after a promotion, this node becomes that node.
    if (getNodeRole() !== 'primary') return result;

    result.expired = expireStaleReservations();

    for (const row of unfinalisedSettlements()) {
        try {
            if (row.direction === 'inbound') {
                // We hold a verified receipt and owe our seller. No network needed — replay the payment.
                // latchOnRefusal: false — nobody is waiting on an answer here, so a cap that is temporarily
                // too low must not permanently reverse a receipt we hold (see settleHeldReceipt).
                if (row.state === 'held') {
                    // RE-VERIFY before paying. The receipt is the authority for this payment (§2.6), and on
                    // this path we are acting on it minutes or a reboot later with no live connection to
                    // re-authenticate against — so the signature is the only evidence, and evidence that is
                    // never checked is not evidence. A row whose stored receipt does not verify against the
                    // peer recorded on it is left alone for an operator rather than paid or reversed.
                    if (!(await verifyStoredReceipt(row))) {
                        console.error(
                            `[Federation] Held receipt ${row.key} FAILED verification against peer `
                            + `${row.peerId.slice(-8)} — not paying. This needs an operator.`,
                        );
                        result.stillOpen++;
                        continue;
                    }
                    if (settleHeldReceipt(row.key, { latchOnRefusal: false }).settled) result.paid++;
                    else result.stillOpen++;
                } else {
                    result.stillOpen++;      // 'reserved' — still within its hold, wait for the receipt
                }
                continue;
            }

            // Outbound. An `escrowed` row means we crashed after taking the buyer's beans and before
            // asking the peer. Nothing crossed the border, and the buyer has long since seen an error and
            // moved on, so refund rather than hold their beans hostage to a purchase nobody is waiting on.
            if (row.state === 'escrowed') {
                abandonOutboundSettlement(row.key, 'INTERRUPTED_BEFORE_ASK');
                result.refunded++;
                continue;
            }

            // `committed` — we wrote real entries and issued a receipt but never learned what became of
            // it. Only the peer knows.
            if (!askPeer) { result.stillOpen++; continue; }

            const status = await askPeer(row.peerId, row.key);
            switch (actionForReceiptStatus(status)) {
                case 'finalise': finaliseOutboundSettlement(row.key); result.finalised++; break;
                case 'reverse':  reverseOutboundSettlement(row.key, 'RECEIPT_NOT_FOUND'); result.reversed++; break;
                case 'wait':     result.stillOpen++; break;
            }
        } catch (e: any) {
            // One unrecoverable row must not stop the rest. Left unfinalised, so the next boot retries.
            console.warn(`[Federation] Settlement recovery failed for ${row.key}:`, e?.message || e);
            result.stillOpen++;
        }
    }

    // Anything still committed after a day of asking is not going to resolve by asking again. Surface it
    // rather than counting it as "still open" forever (review finding) — a buyer's beans are sitting in it.
    // Reported, NOT auto-reversed: an ambiguous cross-node settlement is a dispute between two communities,
    // and reversing on a guess is exactly what the UNKNOWN/NOT_FOUND split exists to prevent.
    result.stuck = stuckSettlements();
    for (const row of result.stuck) {
        const whatIsStuck = row.direction === 'outbound'
            ? `The buyer's beans are still committed`
            : `A local seller is owed and we cannot pay within our own credit limit`;
        console.warn(
            `[Federation] ⚠️  Settlement ${row.key} has been unresolved since ${row.updatedAt} `
            + `(${row.amount} beans, peer ${row.peerId.slice(-8)}). ${whatIsStuck}. `
            + `An operator needs to reconcile this with the other community — it will not clear by retrying.`,
        );
    }

    const touched = result.expired + result.paid + result.refunded + result.reversed + result.finalised;
    if (touched || result.stillOpen) {
        console.log(
            `[Federation] Settlement recovery: ${result.paid} paid, ${result.refunded} refunded, `
            + `${result.reversed} reversed, ${result.finalised} finalised, ${result.expired} reservations released, `
            + `${result.stillOpen} still open, ${result.stuck.length} needing an operator`,
        );
    }
    return result;
}
