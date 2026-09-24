// Writing off a stranded NEGATIVE escrow from the Commons, as a recorded admin action.
//
// WHY THIS EXISTS. Before #1099 an escrow had no floor, so a moderator's post removal could refund a buyer out of
// an escrow that had never been funded. The test node was left with two escrow accounts at -5 and -10 Beans (each
// with exactly one transaction ever, "Escrow refund for removed post", 2026-09-20), and the ledger audit has read
// FAILED on "stranded escrows=2" ever since. #1099 stops new ones; this clears the old ones. Any self-hosted node
// that ran the old code can carry the same state, so it is a general tool, not a fix for one node.
//
// WHAT A WRITE-OFF IS. The buyer already has those Beans, and nobody can be made to hand them back. So the
// community absorbs the hole: exactly |balance| is paid from the Commons into the escrow through `payFromCommons`,
// which lands the escrow at exactly 0. COMMONS_POOL is itself an accounts row, so SUM(balances) does not move,
// the audit's drift stays 0, and the stranded count drops. The same Solvency Rule that lets a prune write off a
// departing member's debt (docs/commons-pool-transparency.md) is what makes this legitimate.
//
// Decided by Marty, 2026-09-24:
//   - Only a NEGATIVE escrow whose trade is not pending/requested — the audit's own stranded definition. A
//     POSITIVE stranded escrow holds Beans a member paid in, and those never go to the Commons: refused.
//   - The Commons may go (further) into deficit, but only with explicit confirmation. Without it, a write-off that
//     would leave the Commons below 0 is refused, and the refusal states the Commons before and after.
//   - Owner level only. The actor comes from auth, never the request body. A reason is required.
//   - Never a script and never raw SQL: a second process writing balances would fight the node's in-memory ledger.
//
// GUARDS OUTSIDE, MUTATION INSIDE. Every refusal is decided before `conservingTransaction` opens, because a throw
// inside it is treated as a possible conservation breach (rollback plus a full resync of memory to rows). All of
// this is synchronous, so nothing can run between the guards and the payment on Node's one thread.

import { DUST_THRESHOLD, ESCROW_FLOOR, isEscrowAccount, ESCROW_ACCOUNT_PREFIX } from '@beanpool/core';
import { db } from '../db/db.js';
import { ledger } from './ledger.js';
import { adminActorName } from './admin-actor-name.js';
import {
    payFromCommons,
    conservingTransaction,
    getCommonsBalanceExact,
    isOwnerLevelActor,
} from '../state-engine.js';

/** A reason long enough to say why, and short enough to sit in a ledger memo. */
export const WRITE_OFF_REASON_MIN = 10;
export const WRITE_OFF_REASON_MAX = 300;

/** Trade statuses whose escrow is legitimately holding (or about to hold) Beans. Same set as the audit. */
const OPEN_TRADE_STATUSES = ['pending', 'requested'];

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface StrandedEscrow {
    /** The account id, `escrow_<trade id>`. */
    escrowId: string;
    balance: number;
    tradeId: string;
    /** The trade row, or null when the node has none (a legacy escrow can outlive its trade row). */
    trade: { status: string; credits: number; postId: string; createdAt: string | null; completedAt: string | null } | null;
    transactionCount: number;
    /** The newest ledger row touching this escrow — for a legacy hole, the refund that dug it. */
    lastTransaction: { memo: string; amount: number; timestamp: string } | null;
    /** Whether the Commons may cover this one, and what the Commons would read if only this one were written off. */
    writeOff: { eligible: boolean; refusal: string | null; commonsAfter: number | null; wouldDeficit: boolean };
}

export interface StrandedEscrowList {
    commonsBalance: number;
    escrows: StrandedEscrow[];
    /** What the Commons would read after every eligible escrow is written off. */
    commonsAfterAll: number;
    eligibleCount: number;
}

export type WriteOffCode =
    | 'reason_required' | 'reason_too_long' | 'not_owner' | 'not_escrow' | 'already_written_off' | 'not_found'
    | 'trade_open' | 'positive_balance' | 'nothing_to_write_off' | 'ledger_mismatch' | 'deficit_unconfirmed';

export type WriteOffResult =
    | {
        ok: true;
        escrowId: string;
        tradeId: string;
        amount: number;
        transactionId: string;
        memo: string;
        commonsBefore: number;
        commonsAfter: number;
        escrowBalanceAfter: number;
    }
    | {
        ok: false;
        status: number;
        code: WriteOffCode;
        error: string;
        /** Present on `deficit_unconfirmed`: the two figures the admin must see before confirming. */
        commonsBalance?: number;
        commonsAfter?: number;
        /** Present on `already_written_off`. */
        writtenOffAt?: string;
    };

/**
 * A reason with control characters flattened to spaces (they could forge log lines or smuggle terminal escapes
 * into an operator's console — the same treatment as the rebaseline note), or null when none was given.
 */
export function normaliseWriteOffReason(reason: unknown): string | null {
    if (typeof reason !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const clean = reason.replace(/[\r\n\t\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.length > 0 ? clean : null;
}

function tradeIdOf(escrowId: string): string {
    return escrowId.slice(ESCROW_ACCOUNT_PREFIX.length);
}

/** Why the Commons may not cover this escrow, or null when it may. The balance-shape rules only. */
function balanceRefusal(balance: number, tradeStatus: string | null): { code: WriteOffCode; error: string } | null {
    if (tradeStatus && OPEN_TRADE_STATUSES.includes(tradeStatus)) {
        return { code: 'trade_open', error: `This escrow belongs to a trade that is still ${tradeStatus} — it is not stranded` };
    }
    if (balance > DUST_THRESHOLD) {
        return {
            code: 'positive_balance',
            error: `This escrow holds ${balance} Beans that a member paid in. Those never go to the Commons — settle the trade instead`,
        };
    }
    if (balance >= ESCROW_FLOOR) {
        return { code: 'nothing_to_write_off', error: 'This escrow is at zero (or within rounding dust of it) — there is nothing to write off' };
    }
    return null;
}

/**
 * Every escrow the audit would call stranded, plus any negative one too small for the audit's 0.01 cut but still
 * a real hole. Positive ones are listed so the count the admin sees in the audit matches this list, and are marked
 * ineligible.
 */
export function listStrandedEscrows(): StrandedEscrowList {
    const rows = db.prepare(`
        SELECT a.public_key AS escrowId, a.balance AS rowBalance,
               mt.status, mt.credits, mt.post_id AS postId, mt.created_at AS createdAt, mt.completed_at AS completedAt,
               mt.id AS tradeRowId
        FROM accounts a
        LEFT JOIN marketplace_transactions mt ON mt.id = SUBSTR(a.public_key, 8)
        WHERE a.public_key LIKE 'escrow_%' AND ABS(a.balance) > ?
          AND SUBSTR(a.public_key, 8) NOT IN (SELECT id FROM marketplace_transactions WHERE status IN ('pending', 'requested'))
        ORDER BY a.balance ASC, a.public_key ASC
    `).all(DUST_THRESHOLD) as any[];

    const commons = getCommonsBalanceExact();
    const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?`);
    const lastStmt = db.prepare(`SELECT memo, amount, timestamp FROM transactions WHERE from_pubkey = ? OR to_pubkey = ? ORDER BY timestamp DESC LIMIT 1`);
    const priorStmt = db.prepare(`SELECT 1 FROM transactions WHERE from_pubkey = 'COMMONS_POOL' AND to_pubkey = ? LIMIT 1`);

    let totalEligible = 0;
    let eligibleCount = 0;
    const escrows: StrandedEscrow[] = rows.map(r => {
        const balance = Number(r.rowBalance);
        const last = lastStmt.get(r.escrowId, r.escrowId) as any;
        let refusal = balanceRefusal(balance, r.status ?? null);
        if (!refusal && priorStmt.get(r.escrowId)) {
            refusal = { code: 'already_written_off', error: 'The Commons has already covered this escrow once' };
        }
        const eligible = refusal === null;
        const commonsAfter = eligible ? round2(commons + balance) : null;
        if (eligible) { totalEligible += -balance; eligibleCount++; }
        return {
            escrowId: r.escrowId,
            balance,
            tradeId: tradeIdOf(r.escrowId),
            trade: r.tradeRowId
                ? { status: r.status, credits: Number(r.credits), postId: r.postId, createdAt: r.createdAt ?? null, completedAt: r.completedAt ?? null }
                : null,
            transactionCount: Number((countStmt.get(r.escrowId, r.escrowId) as any)?.c ?? 0),
            lastTransaction: last ? { memo: last.memo ?? '', amount: Number(last.amount), timestamp: last.timestamp } : null,
            writeOff: { eligible, refusal: refusal?.error ?? null, commonsAfter, wouldDeficit: eligible && commons < -balance },
        };
    });

    return { commonsBalance: round2(commons), escrows, commonsAfterAll: round2(commons - totalEligible), eligibleCount };
}

/**
 * Write off one stranded negative escrow from the Commons. `actor` is the authenticated admin (a pubkey or
 * 'owner:password'), never one read from a request body. `confirmDeficit` must be true when the Commons would
 * end below zero.
 */
export function writeOffStrandedEscrow(
    escrowId: string,
    actor: string,
    reason: unknown,
    opts?: { confirmDeficit?: boolean },
): WriteOffResult {
    const refuse = (status: number, code: WriteOffCode, error: string, extra?: Partial<Extract<WriteOffResult, { ok: false }>>): WriteOffResult =>
        ({ ok: false, status, code, error, ...extra });

    const why = normaliseWriteOffReason(reason);
    if (!why || why.length < WRITE_OFF_REASON_MIN) {
        return refuse(400, 'reason_required', `A reason is required (at least ${WRITE_OFF_REASON_MIN} characters) — it is recorded on the ledger`);
    }
    if (why.length > WRITE_OFF_REASON_MAX) {
        return refuse(400, 'reason_too_long', `The reason must be at most ${WRITE_OFF_REASON_MAX} characters`);
    }
    if (!isOwnerLevelActor(actor)) {
        return refuse(403, 'not_owner', 'Only an owner of this node can write off an escrow from the Commons');
    }
    if (typeof escrowId !== 'string' || !isEscrowAccount(escrowId) || tradeIdOf(escrowId).length === 0) {
        return refuse(400, 'not_escrow', 'Only an escrow account (escrow_<trade id>) can be written off here');
    }

    // Before the existence check: once written off, the hygiene sweep deletes the zeroed row, and "already
    // written off" is the answer the admin needs then, not "not found".
    const prior = db.prepare(`SELECT timestamp FROM transactions WHERE from_pubkey = 'COMMONS_POOL' AND to_pubkey = ? ORDER BY timestamp ASC LIMIT 1`)
        .get(escrowId) as { timestamp: string } | undefined;
    if (prior) {
        return refuse(409, 'already_written_off', `The Commons already covered this escrow on ${prior.timestamp}`, { writtenOffAt: prior.timestamp });
    }

    const row = db.prepare(`SELECT balance FROM accounts WHERE public_key = ?`).get(escrowId) as { balance: number } | undefined;
    if (!row) return refuse(404, 'not_found', 'No such escrow account on this node');

    const tradeId = tradeIdOf(escrowId);
    const trade = db.prepare(`SELECT status FROM marketplace_transactions WHERE id = ?`).get(tradeId) as { status: string } | undefined;

    // The in-memory ledger is what `payFromCommons` moves, so its figure is the one that must reach exactly 0.
    // Read after the row check: `getAccount` would otherwise create an account for an id nobody holds.
    const balance = ledger.getAccount(escrowId).balance;
    const shape = balanceRefusal(balance, trade?.status ?? null);
    if (shape) return refuse(409, shape.code, shape.error);

    // Memory and row must agree, or paying |memory| lands the row somewhere other than 0 and the audit drifts.
    if (Math.abs(Number(row.balance) - balance) > DUST_THRESHOLD) {
        return refuse(409, 'ledger_mismatch',
            `This escrow reads ${balance} in memory but ${row.balance} on disk. Restart the node so it reloads the ledger, then try again`);
    }

    const amount = -balance;
    const commonsBefore = getCommonsBalanceExact();
    // The same comparison `deductFromCommons` makes, so this can never disagree with what the payment does.
    const deficit = commonsBefore < amount;
    if (deficit && opts?.confirmDeficit !== true) {
        const before = round2(commonsBefore);
        const after = round2(commonsBefore - amount);
        return refuse(409, 'deficit_unconfirmed',
            `The Commons holds ${before} Beans; writing off ${round2(amount)} Beans would leave it at ${after}. Confirm to let the Commons go into deficit`,
            { commonsBalance: before, commonsAfter: after });
    }

    const memo = `Stranded escrow written off from the Commons by ${adminActorName(actor)} — trade ${tradeId}: ${why}`;
    const txn = conservingTransaction(() => {
        const paid = payFromCommons(escrowId, amount, memo, { allowDeficit: deficit, authSigner: actor });
        if (!paid) throw new Error(`Commons payment for the write-off of ${escrowId} was refused`);
        const after = ledger.getAccount(escrowId).balance;
        if (after !== 0) throw new Error(`Write-off of ${escrowId} left it at ${after}, not 0 — rolled back`);
        return paid;
    });

    return {
        ok: true,
        escrowId,
        tradeId,
        amount,
        transactionId: txn.id,
        memo,
        commonsBefore: round2(commonsBefore),
        commonsAfter: round2(getCommonsBalanceExact()),
        escrowBalanceAfter: ledger.getAccount(escrowId).balance,
    };
}
