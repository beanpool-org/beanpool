import { restoreShortfall, shortfallSuffix } from './backup-shortfall';

/**
 * What the owner is told after a restore or a roll-back (design case 18 §3.4), from the server's own answer: complete or
 * the shortfall, the restore point it kept first ("kept until at least <date>", and how to roll back), the restart, and,
 * when the backup brought its keys back, that the password and two-factor sign-in are the backup's now.
 */
export function restoreDoneWords(body: unknown, openedBy?: string): string {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const parts = [`Backup restored${openedBy ? `, opened by ${openedBy}'s phone` : ''}.${shortfallSuffix(restoreShortfall(body))}`];
    if (typeof b.restorePointNote === 'string') parts.push(b.restorePointNote);
    parts.push(typeof b.restartNote === 'string' ? b.restartNote : 'The server restarts now; sign in again.');
    if (b.restoredKeys === true) {
        parts.push("The backup brought back the community's keys, and with them the admin password and two-factor sign-in it had when it was made: sign in with those.");
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
