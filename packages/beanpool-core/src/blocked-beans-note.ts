/**
 * Beans from someone you've blocked arrive without their note (Marty on the board, 2026-10-01: "Drop the note, keep the
 * Beans"). One definition for the server, which keeps the note from the member who blocked its sender, and the apps,
 * which show the same words in its place.
 *
 * - The community: a note sent with Beans to someone who has blocked its sender (a block the community keeps, made in the
 *   web app) is never stored where they can read it. They read {@link BLOCKED_BEANS_NOTE} in its place, then and after
 *   an unblock; the sender reads their note as they wrote it (apps/server engine/withheld-notes.ts).
 * - The apps: a line of Beans that came from someone the member has blocked shows {@link BLOCKED_BEANS_NOTE} in place of
 *   whatever came with it ({@link ledgerLineNote}). A phone app's block stays on the phone, so this is what keeps their
 *   words off its ledger; and on a standby, which has the row without the note, the web app says the same.
 *
 * The words say what the line is and nothing of what was sent with it.
 */

/** What a member reads in place of the note on Beans from someone they have blocked. */
export const BLOCKED_BEANS_NOTE = 'Beans from a member you blocked';

/** A ledger line as the member reading it sees it. */
export interface LedgerLineForNote {
    /** The Beans came to the reader. */
    incoming: boolean;
    /** The other account on the line: for incoming Beans, who sent them. */
    counterparty: string | null | undefined;
    /** The note the line carries, if any. */
    memo: string | null | undefined;
}

/**
 * The note a ledger line shows the member reading it: {@link BLOCKED_BEANS_NOTE} on Beans that came from someone on
 * their block list, whatever came with them; any other line's own note, or ''.
 */
export function ledgerLineNote(line: LedgerLineForNote, blocked: { has(key: string): boolean }): string {
    if (line.incoming && line.counterparty && blocked.has(line.counterparty)) return BLOCKED_BEANS_NOTE;
    return line.memo ?? '';
}
