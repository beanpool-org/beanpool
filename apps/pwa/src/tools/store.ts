/**
 * The one store of every tool on the web (scratch/tools/DESIGN-tool-template-fable.md §1.6, slice T0.3): IndexedDB, one
 * object store `tool_docs`, one record per community, owner and tool, the document whole as JSON with the browser's write
 * time. The phone keeps the same rows in its community's SQLite file (T0.2); the node's private copy is T0.4.
 *
 * The documents are the member's own (their things, their garden), so they go wherever this browser's account storage
 * goes: {@link clearToolStore} is part of lib/device-prefs.ts `clearAccountStorage`, which every sign-out and delete runs,
 * and nothing is left of them after it. Once that has run nothing puts one back: a page still open in another tab may
 * write only while lib/account-epoch.ts says the account is still this browser's.
 *
 * Nothing here ever blocks a screen: a browser that can't open IndexedDB (a private window, an old browser, a full disk)
 * reads every tool as empty and says a write didn't keep ({@link writeToolRecord} resolves false).
 *
 * Only the host (tools/host.ts) reads and writes this file: a tool's folder is fenced off from it (eslint.config.mjs).
 */
import { getNodeApiUrl } from '../lib/api';
import { accountEpochHolds } from '../lib/account-epoch';

export const TOOL_DB_NAME = 'beanpool-tools';
export const TOOL_STORE = 'tool_docs';

/** One tool's document as kept: `body` the JSON text, `updatedAt` this browser's write time, `syncedAt` the node copy's (T0.4). */
export interface ToolRecord {
    body: string;
    updatedAt: string;
    syncedAt: string | null;
}

/** One record per community, owner and tool: the phone's one file per community, said in the key. */
export function toolRecordKey(owner: string, tool: string): string {
    const node = getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    return `${node}|${owner}|${tool}`;
}

type ToolStoreListener = (owner: string, tool: string) => void;
const listeners = new Set<ToolStoreListener>();

/** Subscribe to document writes, removals and clears in this browser's tool store. */
export function subscribeToolStore(listener: ToolStoreListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function notifyToolStore(owner: string, tool: string): void {
    for (const listener of [...listeners]) {
        try { listener(owner, tool); } catch (e) { console.warn('[Tools] Store listener failed', e); }
    }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    const opened: Promise<IDBDatabase | null> = new Promise<IDBDatabase | null>((resolve) => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
            const req = indexedDB.open(TOOL_DB_NAME, 1);
            req.onupgradeneeded = () => {
                try { req.result.createObjectStore(TOOL_STORE); } catch { /* already there */ }
            };
            req.onsuccess = () => {
                const db = req.result;
                const letGo = () => {
                    try { db.close(); } catch { /* already closed */ }
                    if (dbPromise === opened) dbPromise = null;
                };
                // Another tab signing out asks to delete the database: this tab lets go of it.
                db.onversionchange = letGo;
                // The browser dropped the connection (its storage process gone, iOS after a long background): let go of
                // it too, so the next read or write opens it again instead of failing until a reload.
                db.onclose = letGo;
                resolve(db);
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    }).then((db) => {
        // A failed open is not remembered: the next open tries again.
        if (!db && dbPromise === opened) dbPromise = null;
        return db;
    });
    dbPromise = opened;
    return opened;
}

const isRecord = (v: unknown): v is ToolRecord =>
    !!v && typeof v === 'object' && typeof (v as ToolRecord).body === 'string' && typeof (v as ToolRecord).updatedAt === 'string';

/** The kept record of `tool` for `owner`, or null when there is none or it can't be read. */
export async function readToolRecord(owner: string, tool: string): Promise<ToolRecord | null> {
    const db = await openDb();
    if (!db) return null;
    return new Promise<ToolRecord | null>((resolve) => {
        try {
            const req = db.transaction(TOOL_STORE, 'readonly').objectStore(TOOL_STORE).get(toolRecordKey(owner, tool));
            req.onsuccess = () => {
                const v: unknown = req.result;
                resolve(isRecord(v) ? { body: v.body, updatedAt: v.updatedAt, syncedAt: typeof v.syncedAt === 'string' ? v.syncedAt : null } : null);
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

function run(db: IDBDatabase, write: (store: IDBObjectStore) => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        try {
            const tx = db.transaction(TOOL_STORE, 'readwrite');
            write(tx.objectStore(TOOL_STORE));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch {
            resolve(false);
        }
    });
}

/**
 * Keep `record` as the document of `tool` for `owner`; true once it is on disk. False when it couldn't be (no IndexedDB,
 * a full disk) or this page may no longer write the account's state (signed out here or in another tab): one that lands
 * as the account leaves is taken out again.
 */
export async function writeToolRecord(owner: string, tool: string, record: ToolRecord): Promise<boolean> {
    if (!accountEpochHolds()) return false;
    const db = await openDb();
    if (!db || !accountEpochHolds()) return false;
    const key = toolRecordKey(owner, tool);
    const kept = await run(db, (s) => s.put(record, key));
    if (!kept) return false;
    if (accountEpochHolds()) {
        notifyToolStore(owner, tool);
        return true;
    }
    await run(db, (s) => s.delete(key));
    return false;
}

/** Remove my data from this browser: the document of `tool` for `owner`, gone. True once it is. */
export async function removeToolRecord(owner: string, tool: string): Promise<boolean> {
    const db = await openDb();
    if (!db) return true;
    const ok = await run(db, (s) => s.delete(toolRecordKey(owner, tool)));
    if (ok) notifyToolStore(owner, tool);
    return ok;
}

/**
 * Remove every tool document kept in this browser for `nodeUrl` (a community left or deleted while keeping the key).
 * Deletes all records whose key starts with `${nodeUrl}|`.
 */
export async function clearToolRecordsFor(nodeUrl: string): Promise<boolean> {
    const db = await openDb();
    if (!db) return true;
    const prefix = `${nodeUrl}|`;
    const KeyRange = typeof IDBKeyRange !== 'undefined'
        ? IDBKeyRange
        : (globalThis as unknown as { IDBKeyRange?: { bound: (...a: unknown[]) => unknown } }).IDBKeyRange;
    const range = KeyRange
        ? KeyRange.bound(prefix, prefix + '\ufffd', false, false)
        : { lower: prefix, upper: prefix + '\ufffd' };
    const ok = await run(db, (s) => (s as unknown as { delete(r: unknown): IDBRequest }).delete(range));
    notifyToolStore('*', '*');
    return ok;
}

/** How long a sign-out waits for the database to be deleted: what was in it is already emptied by then. */
const CLEAR_WAIT_MS = 2_000;

/**
 * Every tool's document, for every community and owner in this browser, gone, and the database with them: part of
 * lib/device-prefs.ts `clearAccountStorage` (Sign Out (Device Only), the delete at the last community). That routine
 * ends the account's epoch first, so no page writes one back. The store is emptied through a connection (which works
 * even while another tab holds the database open), then the database is deleted; other tabs let go of it when asked.
 * Never throws, and never waits long: a browser with no IndexedDB has nothing to clear.
 */
export async function clearToolStore(): Promise<void> {
    const held = dbPromise;
    dbPromise = null;
    const db = held ? await held : await openDb().then((d) => { dbPromise = null; return d; });
    if (db) {
        await run(db, (s) => s.clear());
        try { db.close(); } catch { /* already closed */ }
        notifyToolStore('*', '*');
    }
    await new Promise<void>((resolve) => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.deleteDatabase !== 'function') return resolve();
            const timer = setTimeout(resolve, CLEAR_WAIT_MS);
            const done = () => { clearTimeout(timer); resolve(); };
            const req = indexedDB.deleteDatabase(TOOL_DB_NAME);
            req.onsuccess = done;
            req.onerror = done;
            // Another tab still has it open: the store is already emptied, and the delete finishes once that tab lets go.
            req.onblocked = done;
        } catch {
            resolve();
        }
    });
}

/** Tests only: forget the open database, so a test's own stand-in is opened next. */
export function resetToolStoreForTest(): void {
    dbPromise = null;
}
