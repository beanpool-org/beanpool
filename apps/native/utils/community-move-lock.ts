/**
 * One move of the phone's community at a time (addresses S5; the leftover race of S4's review, scratch/lanes/followups/
 * addresses-s5-must-include.md). The member's own switch (reconnect.ts switchPhoneTo, which the community sheet's
 * switchCommunity, a notice, a link, the hall and a guest visit all go through) and the address check's writing steps
 * (address-verify.ts: a second record's copy and rows, the record write, the move, the rows following) hold this one lock.
 *
 * Why: a switch closes the community's copy first and waits there for the sync lock (db.ts closeDB) before it writes the
 * new address. A check that read the address in that wait read the OLD one and could follow, or remove a second record's
 * copy, for a community the member was leaving. Now the check's writing steps wait for the switch to finish, then read the
 * address again (the member moved: nothing goes, nothing moves), and a switch tapped while the check writes waits a moment
 * for it (local writes only: the check holds the lock for no network ask).
 *
 * Not re-entrant by itself: a step that already holds the lock and switches the phone passes the `held` it was given
 * (address-verify.ts moveTo), so it never waits for itself.
 */

/** Proof that the caller holds the lock: passed on to a switch made inside it. */
export interface CommunityMoveHeld {
    readonly held: true;
}

const HELD: CommunityMoveHeld = Object.freeze({ held: true as const });

let tail: Promise<void> = Promise.resolve();
let holders = 0;

/** `task` runs once every move started before it has finished, and no other starts until it has. Its result, or its throw. */
export function whileCommunityMoves<T>(task: (held: CommunityMoveHeld) => Promise<T>): Promise<T> {
    holders++;
    const run = tail.then(() => task(HELD));
    tail = run.then(() => undefined, () => undefined).finally(() => { holders--; });
    return run;
}

/** Whether a move holds the lock or waits for it. */
export function communityMoveUnderWay(): boolean {
    return holders > 0;
}
