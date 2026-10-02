/**
 * The last Home answer this browser had, kept in IndexedDB per community and per reader (design §5.2 "Offline / 2G",
 * §8: the web has no local database, so the cached answer is what draws Home before the network answers). With it the
 * layout the member last saw, which may be newer than the node's while a save is still to reach it.
 *
 * Nothing here ever blocks Home: a browser that can't open IndexedDB (a private window, an old browser, a full disk)
 * simply has no copy, and Home waits for the node as any page does (onboarding-no-hard-gates).
 */
import { getNodeApiUrl } from './api';
import { normalizeLayout, type HomeAnswer, type HomeLayout } from './home-cards';

const DB_NAME = 'beanpool-home';
const STORE = 'answers';

export interface CachedHome {
    answer: HomeAnswer;
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
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                try { req.result.createObjectStore(STORE); } catch { /* already there */ }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    }).then((db) => {
        // A failed open is not remembered: the next landing tries again.
        if (!db) dbPromise = null;
        return db;
    });
    return dbPromise;
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
                    layout: normalizeLayout(v.layout),
                    layoutUnsaved: v.layoutUnsaved === true,
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

/** Tests only: forget the open database, so a test's own stand-in is opened next. */
export function resetHomeCacheForTest(): void {
    dbPromise = null;
}
