import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A listing whose row the node deletes while its page is open (a dropped federation peer's listings,
// federation-listings.ts) on a community that syncs by area: a near push evicts the phone's row, the page's reloads read
// null and keep the shown listing (utils/shown-post.ts), and the by-id read answers an empty list. The page kept showing
// the listing as active, indefinitely (the confirmation review of #1778, finding 1, probe 13). Now the by-id read says
// "the node answered no such listing" (`post_not_on_node`), and only then: an offline, failed or unreadable read keeps
// the shown listing (decision (a)). Real SQL against the phone's real schema, as in photo-keys-refresh.test.ts.

const sql = new DatabaseSync(':memory:');
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
const adapter = {
    runAsync: vi.fn(async (q: string, p?: unknown) => {
        const r = sql.prepare(q).run(...params(p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    }),
    execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
    getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
    getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};

const ANCHOR = 'https://test.beanpool.org';
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? ANCHOR : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
        multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

// require('react-native').DeviceEventEmitter, answered at node's loader (no vi.mock reaches it): every emit recorded.
const emitted: { name: string; arg: unknown }[] = [];
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: (name: string, arg?: unknown) => { emitted.push({ name, arg }); } } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb, getPost } from '../db';

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
const flush = () => new Promise((r) => setTimeout(r, 0));
const fetchMock = vi.fn();
const gone = () => emitted.filter(e => e.name === 'post_not_on_node');

/** Opens the listing as the page does (getPost), lets its by-id read land, and answers what it emitted. */
async function open(id: string) {
    const row = await getPost(id);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i++) await flush();
    return row;
}

beforeEach(async () => {
    emitted.length = 0;
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (k: string) => (k === 'beanpool_anchor_url' ? ANCHOR : null));
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
    await getDb();
    sql.exec('DELETE FROM posts');
});

describe('the by-id read says when the node answered no such listing', () => {
    it("probe 13: the listing's row gone on the node and on the phone; the node answers []: post_not_on_node, with its id", async () => {
        fetchMock.mockResolvedValue(json(200, []));
        expect(await open('gone-1')).toBeNull();
        expect(gone()).toEqual([{ name: 'post_not_on_node', arg: 'gone-1' }]);
        expect(emitted.map(e => e.name)).not.toContain('sync_data_updated');
    });

    it('never for a read that failed or that this phone cannot read: the shown listing stays (decision (a))', async () => {
        for (const answer of [
            () => Promise.reject(new TypeError('Network request failed')), // offline
            () => Promise.resolve(json(500, { error: 'boom' })),
            () => Promise.resolve(json(503, [])), // an empty list on a failed status is not the node's answer
            () => Promise.resolve(json(404, [])),
            () => Promise.resolve(json(200, { posts: [] })), // not a list
            () => Promise.resolve({ ...json(200, null), json: async () => { throw new SyntaxError('Unexpected token <'); } }),
        ]) {
            fetchMock.mockReset().mockImplementation(answer);
            emitted.length = 0;
            expect(await open('far-1')).toBeNull();
            expect(gone()).toEqual([]);
        }
    });

    it("never once the phone has switched community while the read was out: the answer is about the other node's listing", async () => {
        const OTHER = 'https://other.beanpool.org';
        fetchMock.mockImplementation(async () => {
            vi.mocked(AsyncStorage.getItem).mockImplementation(async (k: string) => (k === 'beanpool_anchor_url' ? OTHER : null));
            await getDb();
            return json(200, []);
        });
        await open('gone-2');
        expect(gone()).toEqual([]);
    });
});
