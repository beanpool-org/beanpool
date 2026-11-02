/**
 * Which of the member's listings have a copy on the global community, in IndexedDB (@beanpool/core show-on-global.ts). This
 * browser's own, as a phone's are its own. One record under one key: each change is one transaction, so two tabs of this address
 * can't lose each other's tap. Signing out clears it (lib/device-prefs.ts clearAccountStorage).
 */
import type { CopyPair, CopyStore } from '@beanpool/core';

const DB_NAME = 'beanpool-copies';
const STORE = 'pairs';
const KEY = 'pairs';

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
        if (!db && dbPromise === opened) dbPromise = null;
        return db;
    });
    dbPromise = opened;
    return opened;
}

const listOf = (value: unknown): CopyPair[] => (Array.isArray(value) ? value as CopyPair[] : []);

export const copyPairs: CopyStore = {
    async read() {
        const db = await openDb();
        if (!db) return [];
        return new Promise<CopyPair[]>((resolve) => {
            try {
                const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
                req.onsuccess = () => resolve(listOf(req.result));
                req.onerror = () => resolve([]);
            } catch {
                resolve([]);
            }
        });
    },
    async change(edit) {
        const db = await openDb();
        if (!db) throw new Error('This browser can keep nothing');
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.get(KEY);
            req.onsuccess = () => { store.put(edit(listOf(req.result)), KEY); };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
    },
};

/** Sign-out: nothing of which listings were shown stays in this browser. */
export async function clearCopyPairs(): Promise<void> {
    const db = await openDb();
    if (!db) return;
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
}
