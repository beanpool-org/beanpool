/**
 * Whose Home a read or a save is for, and whether that account is still the one on the phone (PR #1483 review 4166559191).
 *
 * Home's reads and saves can take seconds on a slow link (utils/home-store.ts), and the account can leave the phone while
 * one is out: Sign Out and Replace wipe everything Home kept for it (identity.ts `wipeIdentityScopedStorage`). A read
 * that landed after the wipe wrote the account's answer back, and in a narrow window its stars too, which the next
 * account then sent to its community as its own. So each read and save takes a {@link HomeAccount} as it begins, and
 * each Home write (the answer, the layout, the stars, the owed save, the reveal and hint) is made only while
 * {@link stillOnPhone} holds for it, checked at the moment of writing, in the same tick as the write. A write for an
 * account that has gone is dropped. (The same race blocklist.ts guards with its own account generation.)
 *
 * - The one wipe calls {@link homeAccountLeft} first, before it removes anything: from then until an account is written
 *   to the phone again, Home writes nothing for anyone, and a write let through just before it is one the wipe removes.
 * - Each change of the account on the phone (account-on-phone.ts) starts a new generation: a read or save begun before it
 *   never writes after it, even for the same account signed out and restored.
 *
 * Import-free but for account-on-phone.ts, so identity.ts and its tests load it without React Native.
 */
import { onAccountOnPhone } from './account-on-phone';

/** The account a read or save was begun for, and the generation it was begun in. */
export interface HomeAccount {
    readonly publicKey: string;
    readonly generation: number;
}

/** Goes up at each wipe and each change of the account on the phone. */
let generation = 0;
/** The account the phone holds as last announced; undefined until one is announced this app start. */
let onPhone: string | null | undefined;
/** Between a wipe (or a key taken off) and the next account written to the phone. */
let between = false;
const changeListeners = new Set<() => void>();

function nextGeneration(): void {
    generation += 1;
    for (const listener of [...changeListeners]) {
        try { listener(); } catch { /* the next read starts afresh anyway */ }
    }
}

onAccountOnPhone((publicKey) => {
    // The same account written again (a new name, its words added): nothing changes.
    if (!between && publicKey !== null && (onPhone === undefined || onPhone === publicKey)) {
        onPhone = publicKey;
        return;
    }
    onPhone = publicKey;
    between = publicKey === null;
    nextGeneration();
});

/** The account a read or save is for, as it begins. */
export function homeAccount(publicKey: string): HomeAccount {
    return { publicKey, generation };
}

/** The generation now, for a mark taken before the account is known (home-store.ts `interestsTurnNow`). */
export function homeGeneration(): number {
    return generation;
}

/** Whether Home may still write for `account`: nothing has left or arrived on the phone since it began. */
export function stillOnPhone(account: HomeAccount): boolean {
    return account.generation === generation && !between && (onPhone === undefined || onPhone === account.publicKey);
}

/** The one wipe (identity.ts `wipeIdentityScopedStorage`), before it removes anything: Home writes nothing more for the account. */
export function homeAccountLeft(): void {
    between = true;
    nextGeneration();
}

/** Each wipe or change of account: home-store.ts drops what it holds in memory for the last one. Returns the unsubscribe. */
export function onHomeAccountChange(listener: () => void): () => void {
    changeListeners.add(listener);
    return () => { changeListeners.delete(listener); };
}

/** For the tests: no account announced, nothing left. */
export function resetHomeAccountForTests(): void {
    onPhone = undefined;
    between = false;
    generation += 1;
}
