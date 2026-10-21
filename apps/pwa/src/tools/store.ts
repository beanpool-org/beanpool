/**
 * The one store of every tool on the web (scratch/tools/DESIGN-tool-template-fable.md §1.6, slice T0.3): IndexedDB, one
 * object store `tool_docs`, one record per community, owner and tool, the document whole as JSON with the browser's write
 * time and its last sync with the node's private copy (tools/node-copy.ts, slice T0.4). Beside each record, under the same
 * key and `|settings`, the host's settings for that tool (the node copy's toggle and its marks). The phone keeps the
 * same rows in its community's SQLite file (T0.2).
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
import type { ToolCopyMarks } from '@beanpool/core';
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

/**
 * In one transaction: what is kept under `key` now, handed to `next`, and what it answers put in its place (null: nothing
 * written). True once a value is on disk; false when nothing was written or it couldn't be, or the account has left.
 */
async function update(key: string, next: (current: unknown) => unknown | null): Promise<boolean> {
    if (!accountEpochHolds()) return false;
    const db = await openDb();
    if (!db || !accountEpochHolds()) return false;
    const wrote = await new Promise<boolean>((resolve) => {
        try {
            const tx = db.transaction(TOOL_STORE, 'readwrite');
            const store = tx.objectStore(TOOL_STORE);
            let put = false;
            const req = store.get(key);
            req.onsuccess = () => {
                const value = next(req.result);
                if (value !== null) { store.put(value, key); put = true; }
            };
            tx.oncomplete = () => resolve(put);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch {
            resolve(false);
        }
    });
    if (wrote && !accountEpochHolds()) {
        await run(db, (s) => s.delete(key));
        return false;
    }
    return wrote;
}

const same = (v: unknown, was: ToolRecord | null) =>
    was === null ? !isRecord(v) : isRecord(v) && v.body === was.body && v.updatedAt === was.updatedAt;

/** A write of the document: the body whole, this browser's time, and the last sync kept as it was. */
export async function keepToolDoc(owner: string, tool: string, body: string, updatedAt: string): Promise<boolean> {
    const kept = await update(toolRecordKey(owner, tool), (v) => ({ body, updatedAt, syncedAt: isRecord(v) && typeof v.syncedAt === 'string' ? v.syncedAt : null }));
    if (kept) notifyToolStore(owner, tool);
    return kept;
}

/** The node's copy taken (tools/node-copy.ts): kept with both times `at`, unless the record is no longer `was`. */
export async function takeToolRecord(owner: string, tool: string, body: string, at: string, was: ToolRecord | null): Promise<boolean> {
    const kept = await update(toolRecordKey(owner, tool), (v) => (same(v, was) ? { body, updatedAt: at, syncedAt: at } : null));
    if (kept) notifyToolStore(owner, tool);
    return kept;
}

/**
 * The node keeps `body` as of `at`: the last sync becomes `at`, and the write time too unless the record moved on since
 * `was`. `was` null: nothing was kept here, and the empty document sent is kept now.
 */
export async function toolRecordSent(owner: string, tool: string, was: ToolRecord | null, body: string, at: string): Promise<void> {
    const made = await update(toolRecordKey(owner, tool), (v) => {
        if (!isRecord(v)) return was === null ? { body, updatedAt: at, syncedAt: at } : null;
        return { body: v.body, updatedAt: same(v, was) && was !== null ? at : v.updatedAt, syncedAt: at };
    });
    if (made && was === null) notifyToolStore(owner, tool);
}

/** The host's own settings for one tool, for one owner, in this browser's community. Absent fields are the defaults. */
export interface ToolSettings {
    /** "Keep a private copy on your community's server": the node's answer, kept here (tools/node-copy.ts). */
    nodeCopy?: boolean;
    /** The node copy's own marks (core ToolCopyMarks: a PUT that may yet land after the copy went off), its alone. */
    nodeCopyMarks?: ToolCopyMarks;
}

const settingsKeyOf = (owner: string, tool: string) => `${toolRecordKey(owner, tool)}|settings`;

export async function readToolSettings(owner: string, tool: string): Promise<ToolSettings> {
    const db = await openDb();
    if (!db) return {};
    return new Promise<ToolSettings>((resolve) => {
        try {
            const req = db.transaction(TOOL_STORE, 'readonly').objectStore(TOOL_STORE).get(settingsKeyOf(owner, tool));
            req.onsuccess = () => {
                const v: unknown = req.result;
                resolve(v && typeof v === 'object' && !Array.isArray(v) ? v as ToolSettings : {});
            };
            req.onerror = () => resolve({});
        } catch {
            resolve({});
        }
    });
}

/** The settings with `patch` over what is kept now. False when it couldn't be kept. */
export function patchToolSettings(owner: string, tool: string, patch: ToolSettings): Promise<boolean> {
    return update(settingsKeyOf(owner, tool), (v) => ({ ...(v && typeof v === 'object' && !Array.isArray(v) ? v : {}), ...patch }));
}

/**
 * The settings `change` makes of what is kept now, read and written in one transaction: another tab's write between is
 * never lost (the node copy's marks). False when it couldn't be kept.
 */
export function changeToolSettings(owner: string, tool: string, change: (now: ToolSettings) => ToolSettings): Promise<boolean> {
    return update(settingsKeyOf(owner, tool), (v) => change(v && typeof v === 'object' && !Array.isArray(v) ? v as ToolSettings : {}));
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
    const normalized = (nodeUrl || (typeof window !== 'undefined' ? window.location.origin : '')).trim().replace(/\/+$/, '');
    const prefix = `${normalized}|`;
    const KeyRange = typeof IDBKeyRange !== 'undefined'
        ? IDBKeyRange
        : (globalThis as unknown as { IDBKeyRange?: { bound: (...a: unknown[]) => unknown } }).IDBKeyRange;
    if (!KeyRange) return false;
    const range = KeyRange.bound(prefix, prefix + '\ufffd', false, false);
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
