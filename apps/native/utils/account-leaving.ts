/**
 * An account is leaving this phone (Sign Out, the self-delete purge, "Delete this account from this phone", Replace): what
 * this phone kept of its groups' keys goes with it, and from the moment the leave begins nothing more of them is read or
 * written for it (utils/db.ts groupKeyStore, noteGroupLocked). Before, a group's locked answer that landed as Sign Out cleared
 * the copy put its mark in the new one: the departed account's key and a group's id, left on the phone (max review of #3358, N1).
 *
 * A module of its own: account-leaves-phone.ts and restore-account.ts, which say an account leaves, never load the database.
 */
let leaving = 0;
let leaves = 0;

/**
 * `leave` takes an account off this phone: from this call, no await before it, until `leave` settles (the account gone, or the
 * leave failed and it stays). `oneLeaves` false (a restore that replaces none): just `leave`.
 */
export async function whileAccountLeaves<T>(leave: () => Promise<T>, oneLeaves = true): Promise<T> {
    if (!oneLeaves) return leave();
    leaves++;
    leaving++;
    try {
        return await leave();
    } finally {
        leaving--;
    }
}

/** Taken before a wait. What it answers, asked after the wait with no await since: true while no account was leaving as it was taken, and none has begun to since. */
export function accountStays(): () => boolean {
    const from = leaves;
    const staying = leaving === 0;
    return () => staying && leaves === from;
}
