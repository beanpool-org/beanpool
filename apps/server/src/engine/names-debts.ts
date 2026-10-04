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
    db.prepare("UPDATE names_debts SET repaying_pubkey = NULL WHERE repaying_pubkey = ? AND status = 'open'").run(pubkey);
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
    return db.prepare("SELECT * FROM names_debts WHERE repaying_pubkey = ? AND status = 'open'").get(pubkey) as DebtRecord | undefined;
}

/** The 3-year sweep (Marty's answer 8): every record whose member left more than 3 years ago goes, with a tombstone. */
export function sweepExpiredDebts(now = Date.now()): number {
    return deletePlainRows('names_debts', 'removed_at < ?', new Date(now - DEBT_RECORD_KEPT_MS).toISOString());
}

export function debtRecord(id: string): DebtRecord | undefined {
    return db.prepare('SELECT * FROM names_debts WHERE id = ?').get(id) as DebtRecord | undefined;
}

/**
 * The repayment flag and a known floor of 0 for the member confirmed to work debt `debtId` off. Inside confirmMember's
 * transaction (engine/names-list.ts confirmToWorkOff). The floor change is a line in the known floor's log.
 */
export function startWorkOff(actor: string, debtId: string, member: string): void {
    db.prepare("UPDATE names_debts SET repaying_pubkey = ? WHERE id = ? AND status = 'open'").run(member, debtId);
    const old = db.prepare('SELECT amount, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(member) as { amount: number | null; frozen: number } | undefined;
    db.prepare(`INSERT INTO known_floor_exceptions (member_pubkey, amount, frozen, set_by, set_at) VALUES (?, 0, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                ON CONFLICT(member_pubkey) DO UPDATE SET amount = 0, frozen = 0, set_by = excluded.set_by, set_at = excluded.set_at`).run(member, actor);
    db.prepare('INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, 'exception_lowered', member, !old ? 'default' : old.frozen ? 'frozen' : String(old.amount), '0 (working off a debt)');
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
 * Pay back: a member's own payment to the Commons (`transactionId`) settles the record, when it is at least what is
 * left to repay and no other record is settled by it. The admin links the two; nothing moves here.
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
    if (db.prepare("SELECT 1 FROM names_debts WHERE settle_ref = ? AND settled_how = 'pay_back'").get(tx.id)) {
        throw new DebtError(409, 'payment_used', 'That payment settled another debt already.');
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
