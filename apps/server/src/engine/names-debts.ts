/**
 * Debts and a second chance (community modes slice 5; scratch/global-node/DESIGN-community-modes-fable.md §4.2, §4.5):
 * a debt record on a names-list entry. Written when a confirmed member leaves in debt (a removal, by the community's
 * Decision or an admin, or deleting their own account): the debt went to the Commons then, as it always has, and the
 * record says so. Nothing is ever taken back from anyone.
 *
 * The record names the entry by its id only: the list is sealed on the admins' phones, so no name is on this server.
 * While a record is `open`, no key may be confirmed against its entry (engine/names-list.ts confirmMember). It is
 * settled by paying it back (payments to the Commons made for it: each counts toward `repaid` as it is paid, and the one
 * that reaches the amount settles it), worked off (confirmed with a known floor of 0 and a repayment flag: every Bean above
 * 0 they receive goes to the Commons until it is cleared), or forgiven by an admin (what is left; what was repaid stays
 * recorded). Every path reads and writes the same `repaid`, so no Bean is counted twice and none is taken past the amount. Every record goes 3 years after the member left (Marty's answer 8), whatever its status.
 *
 * A plain table (engine/replication-manifest.ts): a standby copies it as it is.
 */
import crypto from 'node:crypto';
import { getMember, isVisitorKey } from '@beanpool/engine';
import { db, deletePlainRows } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';

export const DEBT_RECORD_KEPT_MS = 3 * 365 * 24 * 60 * 60 * 1000;

export type DebtStatus = 'open' | 'settled' | 'forgiven';

export interface DebtRecord {
    id: string; entry_id: string; amount: number; reason: 'removed' | 'account_deleted'; removed_at: string; status: DebtStatus;
    repaying_pubkey: string | null; repaid: number; settled_how: 'pay_back' | 'work_off' | 'forgiven' | null;
    settled_by: string | null; settled_at: string | null; settle_ref: string | null; note: string | null;
    work_off_confirmation_id: string | null; work_off_floor_before: string | null; work_off_floor_set_at: string | null;
}

export class DebtError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const nowIso = () => new Date().toISOString();

/**
 * A confirmed member leaving with `balance` below 0: one open record on the entry they were confirmed against, for the
 * debt the Commons just took on. Called inside adminPruneUser's and purgeMemberSelf's transactions, before their
 * confirmation is revoked (engine/names-list.ts dropNamesListHoldOf). A member working off an older debt who leaves
 * stops repaying it: that record stays open, with nobody repaying.
 */
export function recordDepartedDebt(pubkey: string, entryId: string | null, balance: number, reason: 'removed' | 'account_deleted'): void {
    db.prepare(`UPDATE names_debts SET repaying_pubkey = NULL, work_off_confirmation_id = NULL, work_off_floor_before = NULL, work_off_floor_set_at = NULL
                WHERE repaying_pubkey = ? AND status = 'open'`).run(pubkey);
    const amount = round2(-balance);
    if (!entryId || !(amount > 0)) return;
    db.prepare('INSERT INTO names_debts (id, entry_id, amount, reason, removed_at) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), entryId, amount, reason, nowIso());
}

/** The open record on an entry, if any: the one that stops a key being confirmed against it. */
export function openDebtOfEntry(entryId: string): DebtRecord | undefined {
    return db.prepare("SELECT * FROM names_debts WHERE entry_id = ? AND status = 'open' ORDER BY removed_at LIMIT 1").get(entryId) as DebtRecord | undefined;
}

/** Every record, newest first, for the admins (the entries' debt history; the names open on their phones). */
export function listDebts(): DebtRecord[] {
    return db.prepare('SELECT * FROM names_debts ORDER BY removed_at DESC').all() as DebtRecord[];
}

/** The open record a member is working off, if any: what the app shows them, and what the repayment sweep reads. */
export function repaymentOf(pubkey: string): DebtRecord | undefined {
    // Only while the member's confirmation against the debt's own entry is live: not revoked, and seconded where a second
    // admin was needed. A flag without one sweeps nothing (Beans would be taken from someone who owes nothing).
    return db.prepare(`SELECT d.* FROM names_debts d JOIN confirmations c ON c.member_pubkey = d.repaying_pubkey AND c.entry_id = d.entry_id
                       WHERE d.repaying_pubkey = ? AND d.status = 'open' AND c.revoked_at IS NULL AND (c.needs_second = 0 OR c.seconded_at IS NOT NULL)`)
        .get(pubkey) as DebtRecord | undefined;
}

/** The 3-year sweep (Marty's answer 8): every record whose member left more than 3 years ago goes, with a tombstone. */
export function sweepExpiredDebts(now = Date.now()): number {
    const gone = deletePlainRows('names_debts', 'removed_at < ?', new Date(now - DEBT_RECORD_KEPT_MS).toISOString());
    deletePlainRows('names_debt_payments', 'debt_id NOT IN (SELECT id FROM names_debts)');
    return gone;
}

/**
 * A payment of `beans` to the Commons a member is making FOR debt `debtId` (POST /api/commons/pay): the debt must be open,
 * and the payment no more than is left on it. A pay-back link carries what was left when an admin shared it, and a
 * work-off or another payment may have lowered it since: the node says the true amount, so nobody pays the Commons more
 * than they owe. Once nothing is left the debt is settled, so a further payment is refused as not open. Before the
 * payment's conservingTransaction (a refusal is no ledger rebuild); countDebtPayment checks again inside it.
 */
export function assertPayableDebt(debtId: unknown, beans: number): { id: string; left: number } {
    const row = debtRow(debtId);
    requireOpen(row);
    const left = round2(row.amount - row.repaid);
    if (beans > left) throw new DebtError(409, 'more_than_left', `Only ${left} Beans are left on that debt. Pay ${left} Beans to settle it.`);
    return { id: row.id, left };
}

/**
 * Counts payment `txId` (`amount` Beans from `payer` to the Commons) toward debt `debtId`, inside the payment's own
 * transaction: the link is written, `repaid` goes up by the amount, and the payment that reaches the amount settles the
 * debt (pay_back, its reference the settle_ref). Refused, and so the payment rolled back, when the debt is no longer open
 * or the amount is more than is left: never counted past the amount, whatever else ran first. `settledBy` is 'node' for a
 * member's own payment, the admin for a payment an admin names (settleByPayment). Returns what is left after it.
 */
export function countDebtPayment(debtId: string, txId: string, payer: string, amount: number, settledBy = 'node'): number {
    db.prepare('INSERT INTO names_debt_payments (transaction_id, debt_id, payer_pubkey, amount, paid_at) VALUES (?, ?, ?, ?, ?)').run(txId, debtId, payer, amount, nowIso());
    const counted = db.prepare(`UPDATE names_debts SET repaid = ROUND(repaid + ?, 2) WHERE id = ? AND status = 'open' AND ROUND(repaid + ?, 2) <= amount`)
        .run(amount, debtId, amount);
    if (counted.changes !== 1) {
        const row = debtRecord(debtId);
        if (row && row.status !== 'open') throw new DebtError(409, 'not_open', `That debt is ${row.status} already.`);
        const left = row ? round2(row.amount - row.repaid) : 0;
        throw new DebtError(409, 'more_than_left', `Only ${left} Beans are left on that debt. Pay ${left} Beans to settle it.`);
    }
    db.prepare(`UPDATE names_debts SET status = 'settled', settled_how = 'pay_back', settled_by = ?, settled_at = ?, settle_ref = ?
                WHERE id = ? AND status = 'open' AND repaid >= amount`).run(settledBy, nowIso(), txId, debtId);
    const after = debtRecord(debtId)!;
    return round2(after.amount - after.repaid);
}

export function debtRecord(id: string): DebtRecord | undefined {
    return db.prepare('SELECT * FROM names_debts WHERE id = ?').get(id) as DebtRecord | undefined;
}

const WORK_OFF_FLOOR = '0 (working off a debt)';

type FloorRow = { amount: number | null; frozen: number; set_at: string };
const floorRow = (member: string) => db.prepare('SELECT amount, frozen, set_at FROM known_floor_exceptions WHERE member_pubkey = ?').get(member) as FloorRow | undefined;
const describeFloor = (r: FloorRow | undefined) => !r ? 'default' : r.frozen ? 'frozen' : String(r.amount);
// What a work-off replaced, put back whole on its revoke: a freeze keeps the amount it froze ('frozen 50'; plain 'frozen'
// kept the community's known floor), so the 0 the work-off wrote over it must go back too.
const floorBefore = (r: FloorRow | undefined) => r?.frozen && r.amount !== null ? `frozen ${r.amount}` : describeFloor(r);
const logFloor = (actor: string, action: string, member: string, oldValue: string, newValue: string) =>
    db.prepare('INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, action, member, oldValue, newValue);

/**
 * The repayment flag for the member confirmed (confirmation `confirmationId`) to work debt `debtId` off, and, once that
 * confirmation is live, a known floor of 0. Inside confirmMember's transaction (engine/names-list.ts confirmToWorkOff).
 * Where a second admin must agree, the flag only reserves the debt: the floor waits for secondConfirmation
 * (workOffGoesLive), and the sweep reads a live confirmation (repaymentOf). A new work-off of the debt starts with no
 * floor of its own: what an earlier one lowered is no business of this one.
 */
export function startWorkOff(actor: string, debtId: string, member: string, confirmationId: string, live: boolean): void {
    db.prepare(`UPDATE names_debts SET repaying_pubkey = ?, work_off_confirmation_id = ?, work_off_floor_before = NULL, work_off_floor_set_at = NULL
                WHERE id = ? AND status = 'open'`).run(member, confirmationId, debtId);
    if (live) setWorkOffFloor(actor, debtId, member);
}

/** A seconded confirmation: where it is a work-off (the open debt it started flags this member), the 0 floor starts. */
export function workOffGoesLive(actor: string, member: string, confirmationId: string): void {
    const debt = db.prepare("SELECT id FROM names_debts WHERE work_off_confirmation_id = ? AND repaying_pubkey = ? AND status = 'open'").get(confirmationId, member) as { id: string } | undefined;
    if (debt) setWorkOffFloor(actor, debt.id, member);
}

/**
 * A work-off confirmation revoked: the flag ends, and the known floor goes back to what it was before THIS work-off
 * lowered it (recorded on the debt when it did), never anything an older work-off or an admin wrote. Nothing goes back
 * when this one set no floor (revoked before a second admin agreed), and nothing when the floor isn't the one it wrote
 * any more (an admin set it since, even to 0): the admin's stands, and the log says why. Inside the revoke's transaction.
 * Nothing already repaid moves back: it was swept while the confirmation was live.
 */
export function endWorkOff(actor: string, member: string, confirmationId: string): void {
    const debt = db.prepare("SELECT id, work_off_floor_before, work_off_floor_set_at FROM names_debts WHERE work_off_confirmation_id = ? AND repaying_pubkey = ? AND status = 'open'")
        .get(confirmationId, member) as Pick<DebtRecord, 'id' | 'work_off_floor_before' | 'work_off_floor_set_at'> | undefined;
    if (!debt) return;
    db.prepare('UPDATE names_debts SET repaying_pubkey = NULL, work_off_confirmation_id = NULL, work_off_floor_before = NULL, work_off_floor_set_at = NULL WHERE id = ?').run(debt.id);
    const before = debt.work_off_floor_before;
    if (before === null) return;
    const now = floorRow(member);
    if (!now || now.frozen || now.amount !== 0 || now.set_at !== debt.work_off_floor_set_at) {
        logFloor(actor, 'exception_kept', member, describeFloor(now), `${describeFloor(now)} (an admin set it during the work-off, so the ${before} it had before isn't put back)`);
        return;
    }
    if (before === 'default') db.prepare('DELETE FROM known_floor_exceptions WHERE member_pubkey = ?').run(member);
    else if (before.startsWith('frozen')) {
        const kept = before === 'frozen' ? null : Number(before.slice('frozen '.length));
        db.prepare(`UPDATE known_floor_exceptions SET amount = ?, frozen = 1, set_by = ?, set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE member_pubkey = ?`).run(kept, actor, member);
    }
    else db.prepare(`UPDATE known_floor_exceptions SET amount = ?, set_by = ?, set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE member_pubkey = ?`).run(Number(before), actor, member);
    logFloor(actor, 'exception_restored', member, WORK_OFF_FLOOR, (before.startsWith('frozen') ? 'frozen' : before) + ' (the work-off confirmation was revoked)');
}

/**
 * Whether the member's known floor is still the 0 a live work-off wrote: the one its revoke would put back (endWorkOff).
 * An admin's 0 over it is a change, not the same line again: it takes the floor over, so the revoke keeps it.
 */
export function workOffHoldsFloor(member: string): boolean {
    const now = floorRow(member);
    if (!now || now.frozen || now.amount !== 0) return false;
    return !!db.prepare("SELECT 1 FROM names_debts WHERE repaying_pubkey = ? AND status = 'open' AND work_off_floor_before IS NOT NULL AND work_off_floor_set_at = ?")
        .get(member, now.set_at);
}

/** The 0 floor, with what it replaced and the set_at it wrote kept on the debt: what its revoke may put back (endWorkOff). */
function setWorkOffFloor(actor: string, debtId: string, member: string): void {
    const before = floorBefore(floorRow(member));
    db.prepare(`INSERT INTO known_floor_exceptions (member_pubkey, amount, frozen, set_by, set_at) VALUES (?, 0, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                ON CONFLICT(member_pubkey) DO UPDATE SET amount = 0, frozen = 0, set_by = excluded.set_by, set_at = excluded.set_at`).run(member, actor);
    db.prepare('UPDATE names_debts SET work_off_floor_before = ?, work_off_floor_set_at = ? WHERE id = ?').run(before, floorRow(member)!.set_at, debtId);
    logFloor(actor, 'exception_lowered', member, before.startsWith('frozen') ? 'frozen' : before, WORK_OFF_FLOOR);
}

function debtRow(id: unknown): DebtRecord {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new DebtError(400, 'bad_debt_id', 'A debt record id is 32 hexadecimal characters.');
    const row = db.prepare('SELECT * FROM names_debts WHERE id = ?').get(id) as DebtRecord | undefined;
    if (!row) throw new DebtError(404, 'no_debt', 'There is no such debt record.');
    return row;
}

function requireOpen(row: DebtRecord): void {
    if (row.status !== 'open') throw new DebtError(409, 'not_open', `That debt is ${row.status} already.`);
}

function cleanNote(v: unknown): string | null {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 200) throw new DebtError(400, 'bad_note', "'note' is up to 200 characters. Write no name in it: it is kept unsealed.");
    return v;
}

/** The memo payToCommons writes on a member's own payment to the Commons: the only kind an admin may count (settleByPayment). */
export const PAID_TO_COMMONS_MEMO = 'Paid to the Commons';

/**
 * Pay back with a payment made for no debt: a member's own payment to the Commons (`transactionId`) made without the debt's
 * id (before they had it), which an admin counts toward this record. It counts as a payment made for the debt would have
 * (countDebtPayment): `repaid` goes up by it, never past the amount (what is above what is left stays the Commons'), and
 * the debt is settled once nothing is left. Only once: a payment made for a debt counted when it was paid, and one an
 * admin has counted is linked from then on, so neither counts again. Never a repayment sweep's row (counted already) or
 * any other move to the Commons. Nothing moves here.
 */
export function settleByPayment(actor: string, id: unknown, body: { transactionId?: unknown; note?: unknown }): DebtRecord {
    assertPlainTablesWritable();
    const row = debtRow(id);
    requireOpen(row);
    const note = cleanNote(body.note);
    const txId = typeof body.transactionId === 'string' ? body.transactionId : '';
    const tx = txId ? db.prepare('SELECT id, from_pubkey, to_pubkey, amount, memo FROM transactions WHERE id = ?').get(txId) as { id: string; from_pubkey: string; to_pubkey: string; amount: number; memo: string | null } | undefined : undefined;
    if (!tx || tx.to_pubkey !== 'COMMONS_POOL' || tx.memo !== PAID_TO_COMMONS_MEMO) throw new DebtError(400, 'not_a_payment', 'Name a payment to the Commons that a member made.');
    const payer = getMember(db, tx.from_pubkey);
    if (!payer || payer.isTreasury || isVisitorKey(db, tx.from_pubkey) || tx.from_pubkey === 'SYSTEM') {
        throw new DebtError(400, 'not_a_payment', 'Name a payment to the Commons that a member made.');
    }
    if (db.prepare('SELECT 1 FROM names_debt_payments WHERE transaction_id = ?').get(tx.id) || db.prepare('SELECT 1 FROM names_debts WHERE settle_ref = ?').get(tx.id)) {
        throw new DebtError(409, 'payment_counted', 'That payment counted toward a debt already. A payment made for a debt pays it off as it is paid.');
    }
    const left = round2(row.amount - row.repaid);
    db.transaction(() => {
        countDebtPayment(row.id, tx.id, tx.from_pubkey, Math.min(round2(tx.amount), left), actor);
        if (note !== null) db.prepare('UPDATE names_debts SET note = ? WHERE id = ?').run(note, row.id);
    })();
    return debtRow(row.id);
}

/**
 * Forgiven: what is left is written off. The record stays, marked forgiven, with what was repaid before (by payments or a
 * work-off) still on it: those Beans counted, and nothing goes back. The Commons took the debt when the member left.
 */
export function forgiveDebt(actor: string, id: unknown, body: { note?: unknown; ref?: string } = {}): DebtRecord {
    assertPlainTablesWritable();
    const row = debtRow(id);
    requireOpen(row);
    const note = cleanNote(body.note);
    db.prepare(`UPDATE names_debts SET status = 'forgiven', settled_how = 'forgiven', settled_by = ?, settled_at = ?, settle_ref = ?,
                note = COALESCE(?, note), repaying_pubkey = NULL WHERE id = ?`).run(actor, nowIso(), body.ref ?? null, note, row.id);
    return debtRow(row.id);
}
