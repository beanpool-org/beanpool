import { restoreShortfall, shortfallSuffix } from './backup-shortfall';

/**
 * What the owner is told after a restore or a roll-back (design case 18 §3.4), from the server's own answer: complete or
 * the shortfall, the restore point it kept first ("kept until at least <date>", and how to roll back), the restart, and,
 * when the backup brought its keys back, that the sign-in settings are the backup's now.
 *
 * Those words hold whether or not the backup had an admin password: the server's answer does not say (`restoredKeys`
 * is true for every bundle), and a password retired here or in the backup stays retired (bundledLocalConfigUpdates).
 * So never "sign in with the password": a key-only community has none (PR #2029's review, N2).
 */
export function restoreDoneWords(body: unknown, openedBy?: string): string {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const parts = [`Backup restored${openedBy ? `, opened by ${openedBy}'s phone` : ''}.${shortfallSuffix(restoreShortfall(body))}`];
    if (typeof b.restorePointNote === 'string') parts.push(b.restorePointNote);
    parts.push(typeof b.restartNote === 'string' ? b.restartNote : 'The server restarts now; sign in again.');
    if (b.restoredKeys === true) {
        parts.push("The backup brought back the community's keys, and with them its sign-in settings as they were when it was made: "
            + 'its admin password and two-factor sign-in, if it had them (a password retired here or in the backup stays retired). '
            + 'Sign in as one of its owners.');
    }
    return parts.join(' ');
}

/** After a roll-back: the point it went back to, the point it kept first, the restart. */
export function rollBackDoneWords(body: unknown, when: string): string {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const parts = [`Rolled back to the restore point of ${when}.`];
    if (typeof b.restorePointNote === 'string') parts.push(b.restorePointNote);
    parts.push(typeof b.restartNote === 'string' ? b.restartNote : 'The server restarts now; sign in again.');
    return parts.join(' ');
}
