import { authenticateUser } from './LocalAuth';
import { getMnemonic, type BeanPoolIdentity } from './identity';

/**
 * An account's 12 words, for a screen about to show or copy them: the phone's lock first, the words after.
 *
 * The words are the whole account, and a phone left unlocked on a table is the case this is for. Every screen that
 * draws an account's words reads them here, so each asks the same check, and asks it before anything is read:
 * Settings' View Recovery Phrase, Account Protection's Show, "Replace this phone's account?" (the outgoing
 * account's words), node-mismatch's delete, and the join wizard's Safety Backup for a key the phone already had.
 *
 * The rest of the rule (2026-09-27) asks the same check, LocalAuth.authenticateUser, directly: sending the account to a
 * computer (pair-device), linking a sign-in that can restore it (SsoEnrolSheet, the global door with the phone's key),
 * and taking it off the phone (Sign Out, Purge, node-mismatch's delete, Replace Account). The sweep in
 * __tests__/words-behind-lock.test.ts lists every one.
 *
 * The check is LocalAuth.authenticateUser, as Settings has always asked it: the phone's biometric prompt with its
 * passcode as the fallback. A failed or cancelled prompt, or one that throws, reads nothing. A phone with no
 * biometric hardware or nothing enrolled (no passcode set) has nothing to ask with and is let through; that is
 * authenticateUser's own rule, so a member is never locked out of their words by their phone.
 *
 * Returns the words, or null: a check that did not pass, or an account with no words on this phone.
 */
export async function readWordsBehindLock(identity: BeanPoolIdentity | null | undefined, reason: string): Promise<string[] | null> {
    if (!(await authenticateUser(reason))) return null;
    return getMnemonic(identity);
}
