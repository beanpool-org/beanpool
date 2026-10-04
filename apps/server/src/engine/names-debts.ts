/**
 * Debts and a second chance (community modes slice 5; scratch/global-node/DESIGN-community-modes-fable.md §4.2, §4.5):
 * a debt record on a names-list entry. Written when a confirmed member leaves in debt (a removal, by the community's
 * Decision or an admin, or deleting their own account): the debt went to the Commons then, as it always has, and the
 * record says so. Nothing is ever taken back from anyone.
 *
 * The record names the entry by its id only: the list is sealed on the admins' phones, so no name is on this server.
 * While a record is `open`, no key may be confirmed against its entry (engine/names-list.ts confirmMember). It is
 * settled by paying it back (a member's own payment to the Commons, linked by an admin), worked off (confirmed with a
 * known floor of 0 and a repayment flag: every Bean above 0 they receive goes to the Commons until it is cleared), or
 * forgiven by an admin. Every record goes 3 years after the member left (Marty's answer 8), whatever its status.
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
 * A payment to the Commons a member is making FOR debt `debtId` (POST /api/commons/pay): the debt must be open. Inside the
 * payment's conservingTransaction, so the link and the payment are written together or not at all.
 */
export function assertPayableDebt(debtId: unknown): string {
    const row = debtRow(debtId);
    requireOpen(row);
    return row.id;
}

export function linkDebtPayment(debtId: string, txId: string, payer: string, amount: number): void {
    db.prepare('INSERT INTO names_debt_payments (transaction_id, debt_id, payer_pubkey, amount, paid_at) VALUES (?, ?, ?, ?, ?)').run(txId, debtId, payer, amount, nowIso());
}

export function debtRecord(id: string): DebtRecord | undefined {
    return db.prepare('SELECT * FROM names_debts WHERE id = ?').get(id) as DebtRecord | undefined;
}

const WORK_OFF_FLOOR = '0 (working off a debt)';

type FloorRow = { amount: number | null; frozen: number; set_at: string };
const floorRow = (member: string) => db.prepare('SELECT amount, frozen, set_at FROM known_floor_exceptions WHERE member_pubkey = ?').get(member) as FloorRow | undefined;
const describeFloor = (r: FloorRow | undefined) => !r ? 'default' : r.frozen ? 'frozen' : String(r.amount);
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
    else if (before === 'frozen') db.prepare(`UPDATE known_floor_exceptions SET frozen = 1, set_by = ?, set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE member_pubkey = ?`).run(actor, member);
    else db.prepare(`UPDATE known_floor_exceptions SET amount = ?, set_by = ?, set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE member_pubkey = ?`).run(Number(before), actor, member);
    logFloor(actor, 'exception_restored', member, WORK_OFF_FLOOR, before + ' (the work-off confirmation was revoked)');
}

/** The 0 floor, with what it replaced and the set_at it wrote kept on the debt: what its revoke may put back (endWorkOff). */
function setWorkOffFloor(actor: string, debtId: string, member: string): void {
    const before = describeFloor(floorRow(member));
    db.prepare(`INSERT INTO known_floor_exceptions (member_pubkey, amount, frozen, set_by, set_at) VALUES (?, 0, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                ON CONFLICT(member_pubkey) DO UPDATE SET amount = 0, frozen = 0, set_by = excluded.set_by, set_at = excluded.set_at`).run(member, actor);
    db.prepare('UPDATE names_debts SET work_off_floor_before = ?, work_off_floor_set_at = ? WHERE id = ?').run(before, floorRow(member)!.set_at, debtId);
    logFloor(actor, 'exception_lowered', member, before, WORK_OFF_FLOOR);
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

/**
 * Pay back: a member's own payment to the Commons (`transactionId`), made for this record (names_debt_payments, written
 * with the payment), settles it, when it is at least what is left to repay and no record is settled by it already. Never
 * a payment made for another debt or for none, nor a repayment sweep's row (its Beans count as repaid toward its own
 * debt already). The admin confirms it; nothing moves here.
 */
export function settleByPayment(actor: string, id: unknown, body: { transactionId?: unknown; note?: unknown }): DebtRecord {
    assertPlainTablesWritable();
    const row = debtRow(id);
    requireOpen(row);
    const note = cleanNote(body.note);
    const txId = typeof body.transactionId === 'string' ? body.transactionId : '';
    const tx = txId ? db.prepare('SELECT id, from_pubkey, to_pubkey, amount FROM transactions WHERE id = ?').get(txId) as { id: string; from_pubkey: string; to_pubkey: string; amount: number } | undefined : undefined;
    if (!tx || tx.to_pubkey !== 'COMMONS_POOL') throw new DebtError(400, 'not_a_payment', 'Name a payment to the Commons that a member made.');
    const payer = getMember(db, tx.from_pubkey);
    if (!payer || payer.isTreasury || isVisitorKey(db, tx.from_pubkey) || tx.from_pubkey === 'SYSTEM') {
        throw new DebtError(400, 'not_a_payment', 'Name a payment to the Commons that a member made.');
    }
    const left = round2(row.amount - row.repaid);
    if (round2(tx.amount) < left) throw new DebtError(409, 'too_little', `That payment is ${round2(tx.amount)} Beans; ${left} Beans are left to repay.`);
    const link = db.prepare('SELECT debt_id, payer_pubkey FROM names_debt_payments WHERE transaction_id = ?').get(tx.id) as { debt_id: string; payer_pubkey: string } | undefined;
    if (!link || link.debt_id !== row.id || link.payer_pubkey !== tx.from_pubkey) {
        throw new DebtError(409, 'not_for_this_debt', 'That payment wasn’t made for this debt. The member pays it from the debt, so it settles that debt alone.');
    }
    if (db.prepare('SELECT 1 FROM names_debts WHERE settle_ref = ?').get(tx.id)) {
        throw new DebtError(409, 'payment_used', 'That payment settled a debt already.');
    }
    db.prepare(`UPDATE names_debts SET status = 'settled', settled_how = 'pay_back', settled_by = ?, settled_at = ?, settle_ref = ?,
                note = COALESCE(?, note), repaying_pubkey = NULL WHERE id = ?`).run(actor, nowIso(), tx.id, note, row.id);
    return debtRow(row.id);
}

/** Forgiven: written off. The record stays, marked forgiven; the Commons took the debt when the member left. */
export function forgiveDebt(actor: string, id: unknown, body: { note?: unknown; ref?: string } = {}): DebtRecord {
    assertPlainTablesWritable();
    const row = debtRow(id);
    requireOpen(row);
    const note = cleanNote(body.note);
    db.prepare(`UPDATE names_debts SET status = 'forgiven', settled_how = 'forgiven', settled_by = ?, settled_at = ?, settle_ref = ?,
                note = COALESCE(?, note), repaying_pubkey = NULL WHERE id = ?`).run(actor, nowIso(), body.ref ?? null, note, row.id);
    return debtRow(row.id);
}
