/**
 * group-chat-lock-store — the two facts the web app keeps about each group chat between visits, in IndexedDB, per
 * identity and group (lib/group-chat-keys.ts GroupLockStore): the highest epoch this browser has verified or made, which
 * never falls, and whether it has seen the group locked (DESIGN-group-chat-wrap-provenance-fable.md §10 pick 1; the
 * director's sticky lock). Nothing secret and no message: keys stay in memory and wraps are fetched again on each load.
 *
 * Its own database (`beanpool-group-chat-locks`), one per web address, as every store of this app is: a node's web app
 * never reads another node's rows. Rows are keyed "<identity public key>/<group id>", so another identity in this
 * browser starts on its own (review of #1788, finding 8). One more row per identity, "<identity public key>/", lists the
 * groups it holds locked, so the conversations list can ask once.
 *
 * Reads THROW when the store can't be read (no IndexedDB, an open or a transaction that fails): the caller fails closed,
 * never "never held" (confirmation 2 of #1788, finding 1). Writes never throw. Sign Out and the delete at the last
 * community clear it (lib/device-prefs.ts clearAccountStorage); Force Clear & Re-Sync keeps it, as the phone keeps its
 * tables (a security fact, not a cache).
 */
import type { GroupLockState, GroupLockStore } from './group-chat-keys';

const DB_NAME = 'beanpool-group-chat-locks';
const STORE = 'locks';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('This browser has no IndexedDB.');
            req = indexedDB.open(DB_NAME, 1);
        } catch (e) {
            reject(e);
            return;
        }
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('The group chat lock store did not open.'));
        (req as IDBOpenDBRequest & { onblocked: unknown }).onblocked = () => reject(new Error('The group chat lock store is blocked.'));
    });
    dbPromise = p;
    // A failed open is tried again next time, never remembered.
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
    return p;
}

function get(key: string): Promise<unknown> {
    return openDb().then((db) => new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('The group chat lock store did not read.'));
        tx.onabort = () => reject(tx.error ?? new Error('The group chat lock store did not read.'));
    }));
}

/** Read-modify-write one row in one transaction. Never throws. */
function update(key: string, change: (prev: unknown) => unknown): Promise<void> {
    return openDb().then((db) => new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.get(key);
            req.onsuccess = () => { store.put(change(req.result), key); };
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    })).catch(() => { });
}

function asState(v: unknown): GroupLockState {
    const o = v && typeof v === 'object' ? v as Record<string, unknown> : {};
    const highest = typeof o.highest === 'number' && Number.isSafeInteger(o.highest) && o.highest > 0 ? o.highest : 0;
    return { highest, locked: o.locked === true || highest > 0 };
}

const indexKey = (rowKey: string) => rowKey.slice(0, rowKey.indexOf('/') + 1);
const groupOf = (rowKey: string) => rowKey.slice(rowKey.indexOf('/') + 1);

function noteInIndex(rowKey: string): Promise<void> {
    return update(indexKey(rowKey), (prev) => {
        const list = Array.isArray(prev) ? prev.filter((x): x is string => typeof x === 'string') : [];
        const g = groupOf(rowKey);
        return list.includes(g) ? list : [...list, g];
    });
}

/** The browser's store. */
export const indexedDbGroupLockStore: GroupLockStore = {
    async load(key) {
        return asState(await get(key));
    },
    async raiseHighest(key, epoch) {
        await update(key, (prev) => {
            const s = asState(prev);
            return { highest: Math.max(s.highest, epoch), locked: true };
        });
        await noteInIndex(key);
    },
    async markLocked(key) {
        await update(key, (prev) => ({ ...asState(prev), locked: true }));
        await noteInIndex(key);
    },
};

/**
 * The groups this identity holds locked in this browser. Throws when the store can't be read: the caller then treats
 * every group conversation as possibly locked.
 */
export async function lockedGroupsOf(identityPub: string): Promise<Set<string>> {
    const v = await get(`${identityPub}/`);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
}

/** Sign Out, the delete at the last community: every row goes. Never throws, never waits long. */
export async function clearGroupChatLocks(): Promise<void> {
    const held = dbPromise;
    dbPromise = null;
    try { (await held)?.close(); } catch { /* not open */ }
    await new Promise<void>((resolve) => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.deleteDatabase !== 'function') return resolve();
            const timer = setTimeout(resolve, 2_000);
            const done = () => { clearTimeout(timer); resolve(); };
            const req = indexedDB.deleteDatabase(DB_NAME);
            req.onsuccess = done;
            req.onerror = done;
            (req as IDBOpenDBRequest & { onblocked: unknown }).onblocked = done;
        } catch {
            resolve();
        }
    });
}

/** Tests only: forget the open database, so a test's own stand-in is opened next. */
export function resetGroupChatLockStoreForTest(): void {
    dbPromise = null;
}
