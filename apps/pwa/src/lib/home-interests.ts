/**
 * A member's interests, one truth (DESIGN-home-dashboard-fable.md §4.3): kept on their account (the `interests`
 * preference, H1), and in this browser as the Market's For You favourites (`bp_fav_categories`), which work offline.
 * Home's chips and the Market's own "Customize interests" both write both.
 *
 * Which way a copy goes when they differ:
 *   - a change made here hasn't reached the account yet (the node couldn't be reached, or the page was left before it
 *     answered): this browser's list is sent up again, and an answer from before it never overwrites it. The mark is
 *     kept in localStorage, so it outlives the page that made the change (Home, or the Market's panel);
 *   - the account has some: they are this browser's too (another device's choice wins here);
 *   - the account has none and this browser has never matched it: the favourites an older build kept only here move up to
 *     the account, once (as lib/blocklist.ts moves an old local block list);
 *   - the account has none and this browser has matched it before: the member cleared them elsewhere, so they are
 *     cleared here too, never sent back up.
 */
import { saveHomePreferences } from './api';
import { MARKETPLACE_CATEGORIES } from './marketplace';

export const FAV_CATEGORIES_KEY = 'bp_fav_categories';
const syncedKey = (publicKey: string) => `beanpool_interests_synced_${publicKey}`;
/** Set before a change is sent, cleared once the account took it: while set, this browser's list is the one to keep. */
const unsavedKey = (publicKey: string) => `beanpool_interests_unsaved_${publicKey}`;
let unsavedSeq = 0;
const KNOWN: ReadonlySet<string> = new Set(MARKETPLACE_CATEGORIES.map(c => c.id));

/** Category ids only, each once, in the order given. */
export function knownInterests(list: unknown): string[] {
    return Array.isArray(list) ? [...new Set(list.filter((c): c is string => typeof c === 'string' && KNOWN.has(c)))] : [];
}

export function readBrowserInterests(): string[] {
    try {
        return knownInterests(JSON.parse(localStorage.getItem(FAV_CATEGORIES_KEY) || '[]'));
    } catch {
        return [];
    }
}

function writeBrowserInterests(list: string[]): void {
    try { localStorage.setItem(FAV_CATEGORIES_KEY, JSON.stringify(list)); } catch { /* a private window: the account keeps them */ }
}

function syncedHere(publicKey: string): boolean {
    try { return localStorage.getItem(syncedKey(publicKey)) === '1'; } catch { return false; }
}

function markSynced(publicKey: string): void {
    try { localStorage.setItem(syncedKey(publicKey), '1'); } catch { /* asked again next time: harmless */ }
}

/** Whether a change made in this browser has still to reach the account. */
export function interestsUnsaved(publicKey: string): boolean {
    try { return localStorage.getItem(unsavedKey(publicKey)) !== null; } catch { return false; }
}

/**
 * The member changed their interests here (a chip on Home, the Market's panel): kept in this browser at once, and on
 * their account in the background. A save that fails is left; the next change sends the whole list again.
 */
export function shareInterests(publicKey: string, list: string[]): Promise<boolean> {
    const known = knownInterests(list);
    writeBrowserInterests(known);
    // Marked unsaved before it is sent; the mark goes only when the account took this change and no later one was made
    // since (a later change has its own mark, and is sent with its own save).
    const mark = `${Date.now()}-${++unsavedSeq}`;
    try { localStorage.setItem(unsavedKey(publicKey), mark); } catch { /* a private window: the save below still goes */ }
    try {
        return saveHomePreferences(publicKey, { interests: known }).then(() => {
            markSynced(publicKey);
            try { if (localStorage.getItem(unsavedKey(publicKey)) === mark) localStorage.removeItem(unsavedKey(publicKey)); } catch { /* sent again: harmless */ }
            return true;
        }, () => false);
    } catch {
        return Promise.resolve(false);
    }
}

/**
 * A change made here that never reached the account is sent again (after a 304, which carries no interests). Returns
 * whether one was sent.
 */
export function resendUnsavedInterests(publicKey: string): boolean {
    if (!interestsUnsaved(publicKey)) return false;
    void shareInterests(publicKey, readBrowserInterests());
    return true;
}

/**
 * Home's answer said the account's interests: bring this browser's copy in line (the rules above). Returns the list the
 * page should show, and whether this browser's own favourites were sent up to the account.
 */
export function settleInterests(publicKey: string, account: string[]): { interests: string[]; movedUp: boolean } {
    // This browser's change first: the answer may be from before it, and the account hasn't got it yet.
    if (interestsUnsaved(publicKey)) {
        const local = readBrowserInterests();
        void shareInterests(publicKey, local);
        return { interests: local, movedUp: true };
    }
    const fromAccount = knownInterests(account);
    if (fromAccount.length) {
        writeBrowserInterests(fromAccount);
        markSynced(publicKey);
        return { interests: fromAccount, movedUp: false };
    }
    if (syncedHere(publicKey)) {
        writeBrowserInterests([]);
        return { interests: [], movedUp: false };
    }
    const local = readBrowserInterests();
    if (!local.length) return { interests: [], movedUp: false };
    void shareInterests(publicKey, local);
    return { interests: local, movedUp: true };
}
