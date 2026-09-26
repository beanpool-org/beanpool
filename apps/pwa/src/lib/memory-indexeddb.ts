/**
 * Tests only: an in-memory stand-in for `indexedDB`, as much of it as identity.ts uses (open, one object store,
 * get / put / delete in a transaction, oncomplete once the transaction's requests have answered, abort). jsdom has no
 * IndexedDB. Values are structured-cloned in and out, as the real one does, so a test cannot pass by holding a
 * reference to what it saved (and a value that can't be cloned throws DataCloneError from put, as there).
 * `failNextCommit` makes a write fail as a full disk does.
 *
 *   vi.stubGlobal('indexedDB', memoryIndexedDB());
 */

type Store = Map<IDBValidKey, unknown>;

interface FakeRequest<T = unknown> {
    result: T | undefined;
    error: unknown;
    onsuccess: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onupgradeneeded?: ((ev: unknown) => void) | null;
}

function request<T>(): FakeRequest<T> {
    return { result: undefined, error: null, onsuccess: null, onerror: null };
}

export interface MemoryIndexedDB {
    open(name: string, version?: number): FakeRequest;
    /** What is stored: database → store → key → value. For assertions. */
    peek(db: string, store: string, key: IDBValidKey): unknown;
    /**
     * The next readwrite transaction fails as it commits, as the real one does when the disk is full: its writes are
     * undone, `error` is set, and it fires `abort`, never `error` or `complete`.
     */
    failNextCommit(error?: unknown): void;
}

export function memoryIndexedDB(): MemoryIndexedDB {
    const databases = new Map<string, Map<string, Store>>();
    let failCommit: { error: unknown } | null = null;

    function database(stores: Map<string, Store>) {
        return {
            createObjectStore(name: string) {
                stores.set(name, new Map());
                return {};
            },
            close() { /* nothing to release */ },
            transaction(storeName: string, mode: IDBTransactionMode = 'readonly') {
                const store = stores.get(storeName);
                if (!store) throw new Error(`NotFoundError: no object store ${storeName}`);
                const failing = mode === 'readwrite' ? failCommit : null;
                if (failing) failCommit = null;
                const before = failing ? new Map(store) : null;
                // What this transaction's own writes replaced, for abort(): the value each key held before its first write.
                const undo = new Map<IDBValidKey, { had: boolean; value: unknown }>();
                const remember = (key: IDBValidKey) => {
                    if (!undo.has(key)) undo.set(key, { had: store.has(key), value: store.get(key) });
                };
                let finished = false;
                const tx = {
                    oncomplete: null as null | (() => void),
                    onerror: null as null | (() => void),
                    onabort: null as null | (() => void),
                    error: null as unknown,
                    objectStore() {
                        return {
                            get(key: IDBValidKey) {
                                const req = request();
                                setTimeout(() => {
                                    const v = store.get(key);
                                    req.result = v === undefined ? undefined : structuredClone(v);
                                    req.onsuccess?.({ target: req });
                                }, 0);
                                return req;
                            },
                            put(value: unknown, key: IDBValidKey) {
                                const copy = structuredClone(value);
                                remember(key);
                                store.set(key, copy);
                                return request();
                            },
                            delete(key: IDBValidKey) {
                                remember(key);
                                store.delete(key);
                                return request();
                            },
                        };
                    },
                    /** As the real one: this transaction's writes are undone, `error` stays null, and `abort` fires, never `complete`. */
                    abort() {
                        if (finished) throw new DOMException('The transaction has finished.', 'InvalidStateError');
                        finished = true;
                        for (const [key, was] of undo) {
                            if (was.had) store.set(key, was.value);
                            else store.delete(key);
                        }
                        setTimeout(() => tx.onabort?.(), 0);
                    },
                };
                // After the caller has queued its requests (synchronously), and after their answers.
                queueMicrotask(() => setTimeout(() => {
                    if (finished) return;
                    finished = true;
                    if (failing && before) {
                        store.clear();
                        for (const [k, v] of before) store.set(k, v);
                        tx.error = failing.error;
                        tx.onabort?.();
                        return;
                    }
                    tx.oncomplete?.();
                }, 0));
                return tx;
            },
        };
    }

    return {
        open(name: string) {
            const req = request() as FakeRequest & { onupgradeneeded: ((ev: unknown) => void) | null };
            req.onupgradeneeded = null;
            setTimeout(() => {
                let stores = databases.get(name);
                const fresh = !stores;
                if (!stores) {
                    stores = new Map();
                    databases.set(name, stores);
                }
                req.result = database(stores);
                if (fresh) req.onupgradeneeded?.({ target: req });
                req.onsuccess?.({ target: req });
            }, 0);
            return req;
        },
        peek(db: string, store: string, key: IDBValidKey) {
            return databases.get(db)?.get(store)?.get(key);
        },
        failNextCommit(error: unknown = new DOMException('The quota has been exceeded.', 'QuotaExceededError')) {
            failCommit = { error };
        },
    };
}
