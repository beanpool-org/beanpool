import { describe, it, expect } from 'vitest';
import { restoreDoneWords, rollBackDoneWords } from './restore-words';

/**
 * What the owner is told after a restore (design case 18 §3.4). The server reports `restoredKeys: true` for every sealed
 * bundle. A node has no admin password, so the words about sign-in never offer one: the way in is an owner's phone.
 */
const NOTES = { restartNote: 'The server restarts now; sign in again.' };
const KEY_ONLY = { success: true, complete: true, restoredKeys: true, keysWritten: ['identity.json', 'local-config.json'], ...NOTES };

describe('restoreDoneWords', () => {
    it('after a restore that brought the keys back: the owners are the backup\'s, and no password is offered', () => {
        const said = restoreDoneWords(KEY_ONLY);
        expect(said).toContain("The backup brought back the community's keys and its recovery code. Sign in as one of its owners.");
        expect(said).not.toMatch(/password|two-factor|2FA/i);
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
