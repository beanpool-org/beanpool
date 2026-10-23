/**
 * The note under a line on the Ledger tab (db.ts getTransactions), as @beanpool/core ledgerLineNote decides it with this
 * phone's block list (utils/blocklist.ts): Beans from someone blocked here show BLOCKED_BEANS_NOTE in place of whatever
 * came with them (Marty on the board, 2026-10-01: "Drop the note, keep the Beans").
 *
 * A block made in the phone app reaches the community only once the phone is connected (utils/blocklist.ts syncBlocks),
 * and never one whose node has no block list; until then the community still sends their note, and this keeps it off the
 * ledger. One the community kept from the member already comes as BLOCKED_BEANS_NOTE.
 */
import { BLOCKED_BEANS_NOTE, ledgerLineNote } from '@beanpool/core';

/** A line as the Ledger tab lists it: `type` 'credit' for Beans that came to the member, `peerPubkey` the other account. */
export interface LedgerItemForNote {
    type: string;
    peerPubkey?: string | null;
    memo?: string | null;
}

/** The note to show, and whether it is the neutral line for Beans from someone blocked (shown muted). */
export function ledgerItemNote(item: LedgerItemForNote, blocked: ReadonlySet<string>): { text: string; fromBlocked: boolean } {
    const text = ledgerLineNote({ incoming: item.type === 'credit', counterparty: item.peerPubkey, memo: item.memo }, blocked);
    return { text, fromBlocked: text === BLOCKED_BEANS_NOTE };
}
