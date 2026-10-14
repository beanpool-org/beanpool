/**
 * A member's interests, one truth (DESIGN-home-dashboard-fable.md §4.3): kept on their account (the `interests`
 * preference, H1), and in this browser as the Market's For You favourites (`bp_fav_categories`), which work offline.
 * Home's chips and the Market's own "Customize interests" both write both.
 *
 * The node stamps the account's list each time it changes (`interestsUpdatedAt`, engine/home-preferences.ts), and this
 * browser keeps the stamp it last matched. Which way a copy goes when they differ:
 *   - a change made here hasn't reached the account yet (the node couldn't be reached, or the page was left before it
 *     answered): it is marked in localStorage, so it outlives the page that made it (Home, or the Market's panel), with
 *     the stamp it was made on. It is sent again only while the account hasn't changed since: its stamp is still that
 *     one, or it holds a list this browser sent itself whose answer never came. Changed anywhere else since, the
 *     account wins and the mark goes: an older list never overwrites a newer one set on another device (PR #1479's
 *     review). The account already holding the change means it landed. (A node from before the stamp gives none, and
 *     there the change is sent as it always was.);
 *   - the account has some: they are this browser's too (another device's choice wins here);
 *   - the account has none, and has had some (it carries a stamp), or this browser has matched it before: the member
 *     cleared them elsewhere, so they are cleared here too, never sent back up;
 *   - the account has never had any: the favourites an older build kept only here move up to the account, once (as
 *     lib/blocklist.ts moves an old local block list).
 *
 * Nothing here is written once the account has left this browser (lib/account-epoch.ts): a Market or Home still open in
 * another tab after Sign Out keeps no key of the member's.
 */
import { saveHomePreferences } from './api';
import { accountEpochHolds } from './account-epoch';
import { MARKETPLACE_CATEGORIES } from './marketplace';

export const FAV_CATEGORIES_KEY = 'bp_fav_categories';
/** The account's stamp this browser last matched, or '1' where the node gave none. Absent: never matched. */
const syncedKey = (publicKey: string) => `beanpool_interests_synced_${publicKey}`;
/** Set before a change is sent, cleared once the account took it: an {@link UnsavedChange}. */
const unsavedKey = (publicKey: string) => `beanpool_interests_unsaved_${publicKey}`;
let unsavedSeq = 0;
/** How many earlier lists of one run of unsaved changes are remembered as this browser's own. */
const SENT_KEPT = 8;
const KNOWN: ReadonlySet<string> = new Set(MARKETPLACE_CATEGORIES.map(c => c.id));

/** A change made here that the account hasn't confirmed yet. */
interface UnsavedChange {
    /** This change's own: its save clears the mark only while no later change replaced it. */
    id: string;
    /** The list as the member left it here: what is sent. */
    list: string[];
    /** The account's stamp this browser had matched when the run of changes began; null: none (the account had none). */
    base: string | null;
    /** The earlier lists of this run, each sent: the account holding one means that save landed and its answer was lost. */
    sent: string[][];
}

/** Category ids only, each once, in the order given. */
export function knownInterests(list: unknown): string[] {
    return Array.isArray(list) ? [...new Set(list.filter((c): c is string => typeof c === 'string' && KNOWN.has(c)))] : [];
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c === b[i]);
const stampOf = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : null;

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

function matchedHere(publicKey: string): boolean {
    try { return localStorage.getItem(syncedKey(publicKey)) !== null; } catch { return false; }
}

/** The account's stamp this browser last matched, or null (never matched, or the node gave none). */
function matchedStamp(publicKey: string): string | null {
    try {
        const v = localStorage.getItem(syncedKey(publicKey));
        return v === '1' ? null : stampOf(v);
    } catch {
        return null;
    }
}

function markMatched(publicKey: string, stamp: string | null): void {
    try { localStorage.setItem(syncedKey(publicKey), stamp ?? '1'); } catch { /* asked again next time: harmless */ }
}

function readUnsaved(publicKey: string): UnsavedChange | null {
    try {
        const v = JSON.parse(localStorage.getItem(unsavedKey(publicKey)) || 'null') as Partial<UnsavedChange> | null;
        if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !Array.isArray(v.list)) return null;
        return {
            id: v.id,
            list: knownInterests(v.list),
            base: stampOf(v.base),
            sent: Array.isArray(v.sent) ? v.sent.slice(-SENT_KEPT).map(knownInterests) : [],
        };
    } catch {
        return null;
    }
}

function writeUnsaved(publicKey: string, change: UnsavedChange): void {
    try { localStorage.setItem(unsavedKey(publicKey), JSON.stringify(change)); } catch { /* a private window: the save below still goes */ }
}

function dropUnsaved(publicKey: string): void {
    try { localStorage.removeItem(unsavedKey(publicKey)); } catch { /* sent again, and settled then: harmless */ }
}

/** Whether a change made in this browser has still to reach the account. */
export function interestsUnsaved(publicKey: string): boolean {
    return readUnsaved(publicKey) !== null;
}

/** Marked, then sent; the mark goes when the account took this change and no later one was made since. */
function send(publicKey: string, change: UnsavedChange): Promise<boolean> {
    writeUnsaved(publicKey, change);
    try {
        return saveHomePreferences(publicKey, { interests: change.list }).then((r) => {
            // Signed out while it was on its way: nothing more is kept for this account in this browser.
            if (!accountEpochHolds()) return true;
            if (readUnsaved(publicKey)?.id === change.id) {
                dropUnsaved(publicKey);
                markMatched(publicKey, stampOf(r?.interestsUpdatedAt));
            }
            return true;
        }, () => false);
    } catch {
        return Promise.resolve(false);
    }
}

/**
 * The member changed their interests here (a chip on Home, the Market's panel): kept in this browser at once, and on
 * their account in the background. A save that fails stays marked, and is sent again after a later read finds the
 * account unchanged since.
 */
export function shareInterests(publicKey: string, list: string[]): Promise<boolean> {
    if (!accountEpochHolds()) return Promise.resolve(false);
    const known = knownInterests(list);
    // One run of changes made before the account answered is one change, made on the stamp the run began on.
    const pending = readUnsaved(publicKey);
    writeBrowserInterests(known);
    return send(publicKey, {
        id: `${Date.now()}-${++unsavedSeq}`,
        list: known,
        base: pending ? pending.base : matchedStamp(publicKey),
        sent: pending ? [...pending.sent, pending.list].slice(-SENT_KEPT) : [],
    });
}

/**
 * Home's answer said the account's interests and their stamp: bring this browser's copy in line (the rules above).
 * Returns the list the page should show, and whether this browser's own list was sent up to the account.
 */
export function settleInterests(publicKey: string, account: string[], accountStamp?: string | null): { interests: string[]; movedUp: boolean } {
    const fromAccount = knownInterests(account);
    if (!accountEpochHolds()) return { interests: fromAccount, movedUp: false };
    const stamp = stampOf(accountStamp);
    const change = readUnsaved(publicKey);
    if (change) {
        if (sameList(fromAccount, change.list)) {
            // It landed (the page that sent it never heard): the account's list is this browser's.
            dropUnsaved(publicKey);
        } else if (stamp === change.base || change.sent.some(l => sameList(l, fromAccount))) {
            // Nothing changed elsewhere since it was made: the answer is from before it, and it goes up.
            void send(publicKey, change);
            return { interests: change.list, movedUp: true };
        } else {
            // Changed on another device since: the account wins, and this browser's older change goes.
            dropUnsaved(publicKey);
        }
    }
    if (fromAccount.length) {
        writeBrowserInterests(fromAccount);
        markMatched(publicKey, stamp);
        return { interests: fromAccount, movedUp: false };
    }
    if (stamp !== null || matchedHere(publicKey)) {
        writeBrowserInterests([]);
        markMatched(publicKey, stamp);
        return { interests: [], movedUp: false };
    }
    const local = readBrowserInterests();
    if (!local.length) return { interests: [], movedUp: false };
    void send(publicKey, { id: `${Date.now()}-${++unsavedSeq}`, list: local, base: null, sent: [] });
    return { interests: local, movedUp: true };
}
