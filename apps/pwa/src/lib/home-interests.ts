/**
 * A member's interests, one truth (DESIGN-home-dashboard-fable.md §4.3): kept on their account (the `interests`
 * preference, H1), and in this browser as the Market's For You favourites (`bp_fav_categories`), which work offline.
 * Home's chips and the Market's own "Customize interests" both write both.
 *
 * Which way a copy goes when they differ:
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

/**
 * The member changed their interests here (a chip on Home, the Market's panel): kept in this browser at once, and on
 * their account in the background. A save that fails is left; the next change sends the whole list again.
 */
export function shareInterests(publicKey: string, list: string[]): Promise<boolean> {
    const known = knownInterests(list);
    writeBrowserInterests(known);
    try {
        // Matched with the account only once it took them: a change made offline is moved up later, never cleared.
        return saveHomePreferences(publicKey, { interests: known }).then(() => { markSynced(publicKey); return true; }, () => false);
    } catch {
        return Promise.resolve(false);
    }
}

/**
 * Home's answer said the account's interests: bring this browser's copy in line (the rules above). Returns the list the
 * page should show, and whether this browser's own favourites were sent up to the account.
 */
export function settleInterests(publicKey: string, account: string[]): { interests: string[]; movedUp: boolean } {
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
