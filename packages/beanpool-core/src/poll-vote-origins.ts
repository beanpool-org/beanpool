/**
 * Where a poll's votes came from, in words (FABLE-sec-global-abuse LOW-7: many cheap accounts voting). On the global
 * node anyone may join, by a sign-in or with 12 words, so one person with many accounts could tip a count. The node says
 * how many of a public poll's votes came from new or 12-word accounts (`pollNewOrWordsVotes`) and, when there are enough
 * on each side to say nobody's choice, how many of each option's (`newOrWordsVotes`): apps/server engine/probation.ts
 * pollVotesFromNewOrWords. Each vote counts as its account was when it voted: new is an account still on its new-account
 * limits; 12-word is one made with 12 words that had added no sign-in. One set of words for both apps.
 *
 * Every vote still counts: these lines say where the votes came from, never whose they are, and never leave a vote out.
 * Nothing here is shown where the node says nothing (a local community, a group's poll).
 */

/** The poll's line: "6 of 12 votes came from new or 12-word accounts". Null when none did, or the node doesn't say. */
export function pollVoteOriginsLine(totalVotes: number | null | undefined, fromNew: number | null | undefined): string | null {
    const total = typeof totalVotes === 'number' && Number.isFinite(totalVotes) ? Math.max(0, Math.floor(totalVotes)) : 0;
    const n = typeof fromNew === 'number' && Number.isFinite(fromNew) ? Math.min(total, Math.floor(fromNew)) : 0;
    if (n <= 0) return null;
    if (n === total) return total === 1 ? 'The 1 vote came from a new or 12-word account' : `All ${total} votes came from new or 12-word accounts`;
    return `${n} of ${total} votes came from ${n === 1 ? 'a new or 12-word account' : 'new or 12-word accounts'}`;
}

/** An option's line: "4 of these 7 from new or 12-word accounts". Null when none, or the node gives no split. */
export function pollOptionOriginsLine(votes: number | null | undefined, fromNew: number | null | undefined): string | null {
    const count = typeof votes === 'number' && Number.isFinite(votes) ? Math.max(0, Math.floor(votes)) : 0;
    const n = typeof fromNew === 'number' && Number.isFinite(fromNew) ? Math.min(count, Math.floor(fromNew)) : 0;
    if (n <= 0) return null;
    if (n === count) return count === 1 ? 'This 1 from a new or 12-word account' : `All ${count} from new or 12-word accounts`;
    return `${n} of these ${count} from ${n === 1 ? 'a new or 12-word account' : 'new or 12-word accounts'}`;
}
