/**
 * The last Home answer this browser had, kept in IndexedDB per community and per reader (design §5.2 "Offline / 2G",
 * §8: the web has no local database, so the cached answer is what draws Home before the network answers). With it the
 * layout the member last saw, which may be newer than the node's while a save is still to reach it.
 *
 * Nothing here ever blocks Home: a browser that can't open IndexedDB (a private window, an old browser, a full disk)
 * simply has no copy, and Home waits for the node as any page does (onboarding-no-hard-gates).
 *
 * The copy is the member's own (their Beans, who wrote to them, their groups, their layout), so it goes wherever this
 * browser's account storage goes: {@link clearHomeCache} is part of lib/device-prefs.ts `clearAccountStorage`, which
 * every sign-out and delete runs. And once it has gone, nothing puts it back: a page still open in another tab, holding
 * the answer in memory or with a read still out, may write a member's copy only while lib/account-epoch.ts says the
 * account is still this browser's and nothing was cleared since that answer was read.
 */
import { getNodeApiUrl } from './api';
import { accountEpoch, accountEpochHolds, endAccountEpoch, type AccountEpochEnd } from './account-epoch';
import { type HomeAnswer } from './home-cards';
import { readLayout, type HomeLayoutV2 } from './home-layout';

const DB_NAME = 'beanpool-home';
const STORE = 'answers';

export interface CachedHome {
    answer: HomeAnswer;
    /**
     * The cards `answer` was built for (the `cards=` it was read with, or the node's own choice from the account's
     * layout): a card left out of it may have something to say, so showing it again needs a new read. Null: not known.
     */
    asked?: string[] | null;
    /** The node's tag for `answer`: sent with the next read, which is a 304 while it is still the answer. */
    etag: string | null;
    /** The layout as this browser last had it: the node's, or a newer one of the member's not yet saved there. */
    layout: HomeLayoutV2 | null;
    /** Whether `layout` still has to be saved on the account. */
    layoutUnsaved: boolean;
    /**
     * Set while `layout` is an edit made on the newcomer's list drawn for an unknown (empty version-1) account list: this
     * browser's only, never sent by itself, until a version-2 answer dated at or after this says what the account holds
     * (lib/home-layout.ts pickLayout). Undefined: not marked.
     */
    localOnlyOver?: string;
    savedAt: number;
}

/** One copy per community and per reader: a member's own, or the lobby's (no key). */
export function homeCacheKey(publicKey: string | null | undefined): string {
    const node = getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    return `${node}|${publicKey || 'visitor'}`;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    const opened: Promise<IDBDatabase | null> = new Promise<IDBDatabase | null>((resolve) => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                try { req.result.createObjectStore(STORE); } catch { /* already there */ }
            };
            req.onsuccess = () => {
                const db = req.result;
                // Another tab clearing the copy (a sign-out there) asks to delete the database: this tab lets go of it.
                db.onversionchange = () => {
                    try { db.close(); } catch { /* already closed */ }
                    if (dbPromise === opened) dbPromise = null;
                };
                resolve(db);
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    }).then((db) => {
        // A failed open is not remembered: the next landing tries again.
        if (!db && dbPromise === opened) dbPromise = null;
        return db;
    });
    dbPromise = opened;
    return opened;
}

/** The copy for `key`, read back through the layout's checks; null when there is none or it can't be read. */
export async function readCachedHome(key: string): Promise<CachedHome | null> {
    const db = await openDb();
    if (!db) return null;
    return new Promise<CachedHome | null>((resolve) => {
        try {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            req.onsuccess = () => {
                const v = req.result as Partial<CachedHome> | undefined;
                if (!v || !v.answer || typeof v.answer !== 'object' || !v.answer.cards) return resolve(null);
                resolve({
                    answer: v.answer as HomeAnswer,
                    etag: typeof v.etag === 'string' && v.etag.length <= 200 ? v.etag : null,
                    layout: readLayout(v.layout),
                    layoutUnsaved: v.layoutUnsaved === true,
                    ...(typeof v.localOnlyOver === 'string' && v.localOnlyOver.length <= 40 ? { localOnlyOver: v.localOnlyOver } : {}),
                    asked: Array.isArray(v.asked) ? [...new Set(v.asked.filter((x): x is string => typeof x === 'string' && x.length <= 64))].slice(0, 64) : null,
                    savedAt: Number(v.savedAt) || 0,
                });
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

/**
 * Keep `value` as the copy for `key`. A write that fails is dropped: the next answer is kept instead.
 *
 * A member's copy is dropped too once this page may no longer write their state (lib/account-epoch.ts): signed out,
 * here or in another tab, or, given the `epoch` the answer was read under, cleared since. One that lands as that
 * happens is taken out again. The lobby's copy holds no account, so only a clear since `epoch` drops it.
 */
export async function writeCachedHome(key: string, value: CachedHome, epoch?: number): Promise<void> {
    const holds = () => key.endsWith('|visitor') ? epoch === undefined || epoch === accountEpoch() : accountEpochHolds(epoch);
    if (!holds()) return;
    const db = await openDb();
    if (!db || !holds()) return;
    const kept = await new Promise<boolean>((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch {
            resolve(false);
        }
    });
    if (!kept || holds()) return;
    // Signed out or cleared while it was written: out again. A connection already let go of is in a database that is
    // being deleted, this copy with it.
    await new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

/** How long a sign-out waits for the database to be deleted: the copy in it is already emptied by then. */
const CLEAR_WAIT_MS = 2_000;

/**
 * Every copy this file keeps, for every community and reader, gone: part of lib/device-prefs.ts `clearAccountStorage`
 * (Sign Out (Device Only), a delete at the last community: `'signed-out'`), of leaving a community the web app was
 * pointed at, and of Force Clear & Re-Sync (`'cleared'`: the account stays).
 *
 * The epoch ends first (lib/account-epoch.ts), so no page, here or in another tab, writes back what it holds; Home
 * pages still open drop it at once. Then the store is emptied, through a connection (that works even while another tab
 * holds the database open, which holds up a delete), then the database itself is deleted; other tabs of this app let
 * go of it when asked. Never throws, and never waits long: a browser with no IndexedDB has nothing to clear.
 */
export async function clearHomeCache(end: AccountEpochEnd): Promise<void> {
    endAccountEpoch(end);
    const held = dbPromise;
    dbPromise = null;
    const db = held ? await held : await openDb().then((d) => { dbPromise = null; return d; });
    if (db) {
        await new Promise<void>((resolve) => {
            try {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
            } catch {
                resolve();
            }
        });
        try { db.close(); } catch { /* already closed */ }
    }
    await new Promise<void>((resolve) => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.deleteDatabase !== 'function') return resolve();
            const timer = setTimeout(resolve, CLEAR_WAIT_MS);
            const done = () => { clearTimeout(timer); resolve(); };
            const req = indexedDB.deleteDatabase(DB_NAME);
            req.onsuccess = done;
            req.onerror = done;
            // Another tab still has it open: the copy is already emptied, and the delete finishes once that tab lets go.
            req.onblocked = done;
        } catch {
            resolve();
        }
    });
}

/** Tests only: forget the open database, so a test's own stand-in is opened next. */
export function resetHomeCacheForTest(): void {
    dbPromise = null;
}
