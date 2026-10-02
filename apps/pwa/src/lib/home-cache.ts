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
 * every sign-out and delete runs.
 */
import { getNodeApiUrl } from './api';
import { isHomeCardId, normalizeLayout, type HomeAnswer, type HomeCardId, type HomeLayout } from './home-cards';

const DB_NAME = 'beanpool-home';
const STORE = 'answers';

export interface CachedHome {
    answer: HomeAnswer;
    /**
     * The cards `answer` was built for (the `cards=` it was read with, or the node's own choice from the account's
     * layout): a card left out of it may have something to say, so showing it again needs a new read. Null: not known.
     */
    asked?: HomeCardId[] | null;
    /** The node's tag for `answer`: sent with the next read, which is a 304 while it is still the answer. */
    etag: string | null;
    /** The layout as this browser last had it: the node's, or a newer one of the member's not yet saved there. */
    layout: HomeLayout | null;
    /** Whether `layout` still has to be saved on the account. */
    layoutUnsaved: boolean;
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
                    layout: normalizeLayout(v.layout),
                    layoutUnsaved: v.layoutUnsaved === true,
                    asked: Array.isArray(v.asked) ? [...new Set(v.asked.filter(isHomeCardId))] : null,
                    savedAt: Number(v.savedAt) || 0,
                });
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

/** Keep `value` as the copy for `key`. A write that fails is dropped: the next answer is kept instead. */
export async function writeCachedHome(key: string, value: CachedHome): Promise<void> {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
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
 * (Sign Out (Device Only), a delete at the last community) and of leaving a community the web app was pointed at.
 *
 * The store is emptied first, through a connection (that works even while another tab holds the database open, which
 * holds up a delete), then the database itself is deleted; other tabs of this app let go of it when asked. Never
 * throws, and never waits long: a browser with no IndexedDB has nothing to clear.
 */
export async function clearHomeCache(): Promise<void> {
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
