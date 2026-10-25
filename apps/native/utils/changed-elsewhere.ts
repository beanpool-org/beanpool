/**
 * Whether a refused trade step means the deal or the post moved on since this screen showed it: another device cancelled
 * the deal, someone else took the post, or the member already has a deal under way on it. The screen then says so in its
 * own words and refreshes (app/post/[id].tsx).
 *
 * The node says it with a code beside its sentence (apps/server/src/engine/escrow.ts): `transaction_gone` when a deal
 * can't be cancelled, `post_gone` when a post can't be accepted or asked for, `deal_open` when the member already has a
 * deal under way on it (asked for, or held in trust). The sentence beside the code is the member's language, so it is never
 * read. A node from before those codes said it only in its English sentence, which such a node never translates: an answer
 * with no code at all is read for the English it always had. A current node gives a code to each of those steps' refusals
 * that holds these words and is the post or the deal moving on (the server's test-member-words.ts reads this list to check).
 */
export type ChangedElsewhereCode = 'transaction_gone' | 'post_gone' | 'deal_open';

/** What an older node's English says for each, before the code. An older node never refuses a second deal: none for that. */
export const OLDER_NODES_WORDS: Record<ChangedElsewhereCode, readonly string[]> = {
    transaction_gone: ['not found', 'not authorized'],
    post_gone: ['not found', 'not active'],
    deal_open: [],
};

export function changedElsewhere(e: unknown, code: ChangedElsewhereCode): boolean {
    const err = (e ?? {}) as { code?: unknown; message?: unknown };
    if (typeof err.code === 'string') return err.code === code;
    const message = typeof err.message === 'string' ? err.message : '';
    return OLDER_NODES_WORDS[code].some((words) => message.includes(words));
}
