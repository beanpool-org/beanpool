import { describe, it, expect } from 'vitest';
import { restoreDoneWords, rollBackDoneWords } from './restore-words';

/**
 * What the owner is told after a restore (design case 18 §3.4). The server reports `restoredKeys: true` for every sealed
 * bundle, with or without an admin password in it, and keeps a retired password retired; so the words about sign-in must
 * hold for a community with a password and for a key-only one (PR #2029's review, N2).
 */
const NOTES = { restartNote: 'The server restarts now; sign in again.' };
// What routes/backup.ts answers for each: the same. local-config.json is written either way (applyBundle), and the answer
// does not say whether a password came with it.
const WITH_PASSWORD = { success: true, complete: true, restoredKeys: true, keysWritten: ['identity.json', 'local-config.json'], ...NOTES };
const KEY_ONLY = { success: true, complete: true, restoredKeys: true, keysWritten: ['identity.json', 'local-config.json'], ...NOTES };

describe('restoreDoneWords', () => {
    it.each([['a backup with an admin password', WITH_PASSWORD], ['a key-only backup (no password, or one retired)', KEY_ONLY]])(
        'after %s: the sign-in settings are the backup\'s, a password only if it had one, and never "sign in with the password"', (_, body) => {
            const said = restoreDoneWords(body);
            expect(said).toContain("The backup brought back the community's keys, and with them its sign-in settings as they were when it was made");
            expect(said).toContain('its admin password and two-factor sign-in, if it had them (a password retired here or in the backup stays retired)');
            expect(said).toContain('Sign in as one of its owners.');
            expect(said).not.toMatch(/sign in with (those|the|its)\b/i);
        });

    it('says nothing about sign-in settings when the keys did not come back', () => {
        const said = restoreDoneWords({ success: true, complete: true, restoredKeys: false, ...NOTES });
        expect(said).toBe('Backup restored. The server restarts now; sign in again.');
    });

    it('includes phone owner attribution and custom restore point note when supplied', () => {
        const said = restoreDoneWords({
            success: true,
            complete: true,
            restorePointNote: 'Restore point saved before applying bundle.',
            restartNote: 'Custom restart msg.'
        }, 'Alice');
        expect(said).toBe("Backup restored, opened by Alice's phone. Restore point saved before applying bundle. Custom restart msg.");
    });
});

describe('rollBackDoneWords', () => {
    it('formats rollback message with default restart note when body is empty or non-object', () => {
        expect(rollBackDoneWords(null, '2026-10-18')).toBe('Rolled back to the restore point of 2026-10-18. The server restarts now; sign in again.');
        expect(rollBackDoneWords({}, '2026-10-18')).toBe('Rolled back to the restore point of 2026-10-18. The server restarts now; sign in again.');
    });

    it('includes restorePointNote and custom restartNote when provided in body', () => {
        const result = rollBackDoneWords({
            restorePointNote: 'Kept until at least 2026-11-01.',
            restartNote: 'Server restarting now.'
        }, '2026-10-18 12:00 UTC');
        expect(result).toBe('Rolled back to the restore point of 2026-10-18 12:00 UTC. Kept until at least 2026-11-01. Server restarting now.');
    });
});
