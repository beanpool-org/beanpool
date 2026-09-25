/**
 * Tests only: an in-memory stand-in for `indexedDB`, as much of it as identity.ts uses (open, one object store,
 * get / put / delete in a transaction, oncomplete once the transaction's requests have answered). jsdom has no
 * IndexedDB. Values are structured-cloned in and out, as the real one does, so a test cannot pass by holding a
 * reference to what it saved.
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
}

export function memoryIndexedDB(): MemoryIndexedDB {
    const databases = new Map<string, Map<string, Store>>();

    function database(stores: Map<string, Store>) {
        return {
            createObjectStore(name: string) {
                stores.set(name, new Map());
                return {};
            },
            close() { /* nothing to release */ },
            transaction(storeName: string) {
                const store = stores.get(storeName);
                if (!store) throw new Error(`NotFoundError: no object store ${storeName}`);
                const tx = {
                    oncomplete: null as null | (() => void),
                    onerror: null as null | (() => void),
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
                                store.set(key, structuredClone(value));
                                return request();
                            },
                            delete(key: IDBValidKey) {
                                store.delete(key);
                                return request();
                            },
                        };
                    },
                };
                // After the caller has queued its requests (synchronously), and after their answers.
                queueMicrotask(() => setTimeout(() => tx.oncomplete?.(), 0));
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
    };
}
