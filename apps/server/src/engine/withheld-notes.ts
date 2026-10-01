/**
 * Withheld notes: the note on Beans a member sends to someone who has blocked them (engine/member-blocks.ts; Marty on the
 * board, 2026-10-01: "Drop the note, keep the Beans"). #1403 kept a blocked member's direct messages from the person who
 * blocked them (engine/withheld-lines.ts); a send of Beans with a note was the channel left, tiny payments carrying words.
 *
 * - The Beans move exactly as any send's (state-engine transfer: the same amount, rows, fee, floor and checks), and the
 *   send is never refused for it. Only where its note is kept changes: the ledger row stores none (`transactions.memo`
 *   is ''), and the note is kept HERE, for its sender alone. The row, every copy of it and every read of it by the person
 *   who blocked them carry no note: their history, their export and their live update say BLOCKED_BEANS_NOTE
 *   (@beanpool/core) in its place, then and after an unblock (what never reached them never arrives).
 * - The sender reads their note as they wrote it (noteAsReadBy): the send's answer, its live update on their own sockets,
 *   their history and their export, each in the shape any send's has, so nothing they read tells them of the block.
 * - Only Beans from one person to another: a member's or a visitor's key to a member's, not an enterprise's or a system
 *   account's (withholdsNote). An enterprise's book is read by its keepers and the member on each line
 *   (routes/treasury.ts), so a note there is shared, as a line in its chat is. A block the community keeps is one made in
 *   the web app; a phone app's block stays on the phone, and the phone app shows BLOCKED_BEANS_NOTE in place of the note
 *   itself (@beanpool/core ledgerLineNote).
 * - Local to this server, never in a copy (engine/replication-manifest.ts): a promoted standby has the row with no note,
 *   and the sender's own note is what a take-over loses, as with withheld lines. The signed request a send keeps
 *   (`auth_payload`, SRV-20) still holds the words it was signed with: it is the sender's signature, which a standby
 *   re-checks for who moved the Beans (engine/sync.ts verifyTransactionAuthorship takes a note kept blank), and no
 *   member's read ever serves it.
 * - Its words gone with its sender on a prune or a self-deletion (dropWithheldNotesOf); the recipient keeps the neutral line. A re-key moves the ledger row, which names
 *   the sender (engine/key-move.ts); the note, kept by the row's id, follows it.
 */
import { BLOCKED_BEANS_NOTE, isSyntheticAccount } from '@beanpool/core';
import { db } from '../db/db.js';
import { hasBlocked } from './member-blocks.js';

/** An enterprise's treasury: a member row, but no person. */
function isTreasuryKey(key: string): boolean {
    return !!(db.prepare('SELECT is_treasury FROM members WHERE public_key = ?').get(key) as { is_treasury: number | null } | undefined)?.is_treasury;
}

/**
 * Whether the note on this send is kept from its recipient: a note (any text but blank), from one person to another who
 * has blocked them. Decided before the send's transaction (state-engine transfer); it refuses nothing.
 */
export function withholdsNote(from: string, to: string, memo: unknown): boolean {
    // The same rule as isNote (routes/profile-feature-gate.ts): the transfer route takes a memo of any JSON type and the
    // ledger stores a number as text, so 412345678 is a note as '412345678' is.
    if (memo == null || String(memo).trim() === '') return false;
    if (!from || !to || from === to || isSyntheticAccount(from) || isSyntheticAccount(to)) return false;
    // The block first: one lookup on its key, and false for nearly every send.
    return hasBlocked(to, from) && !isTreasuryKey(from) && !isTreasuryKey(to);
}

/** The send's note, kept for its sender: in the send's own transaction, with the row that names them. */
export function keepWithheldNote(transactionId: string, memo: unknown): void {
    // The value as given: SQLite stores it as the same text an unblocked send's row holds, so the sender reads the same.
    db.prepare('INSERT INTO withheld_notes (transaction_id, memo) VALUES (?, ?)').run(transactionId, memo);
}

/**
 * The join a read of `transactions t` adds to bring each row's withheld note, as `withheld_memo` (null for a row with
 * none): `SELECT t.*, ${WITHHELD_NOTE_COLUMN} FROM transactions t ${WITHHELD_NOTE_JOIN}`.
 */
export const WITHHELD_NOTE_COLUMN = 'wn.memo AS withheld_memo';
export const WITHHELD_NOTE_JOIN = 'LEFT JOIN withheld_notes wn ON wn.transaction_id = t.id';

/**
 * A row's note as the account `reader` reads it, from the row as read with WITHHELD_NOTE_JOIN: its sender, the note they
 * wrote; its recipient, BLOCKED_BEANS_NOTE; anyone else, and every row with no withheld note, the row's own.
 */
export function noteAsReadBy(row: { from_pubkey: string; to_pubkey: string; memo: string | null; withheld_memo?: string | null }, reader: string): string {
    if (row.withheld_memo == null) return row.memo ?? '';
    if (row.from_pubkey === reader) return row.withheld_memo;
    if (row.to_pubkey === reader) return BLOCKED_BEANS_NOTE;
    return row.memo ?? '';
}

/**
 * A prune or a self-deletion: the words kept for them alone go, as nobody can read them now. Their ledger rows stay, and so
 * do the withheld_notes rows, blank: a row's existence is what makes the recipient read BLOCKED_BEANS_NOTE (noteAsReadBy).
 */
export function dropWithheldNotesOf(sender: string): void {
    db.prepare("UPDATE withheld_notes SET memo = '' WHERE transaction_id IN (SELECT id FROM transactions WHERE from_pubkey = ?)").run(sender);
}
