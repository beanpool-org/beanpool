import { describe, it, expect, vi, beforeEach } from 'vitest';

// Adding a friend tells the person added (their People tab's "added you"), so the node can refuse an add: past 100 in a
// day, or someone you blocked. The phone used to write its own row first and tell the node fire-and-forget, so a refused
// add showed as "✓ Added" here and was never made. Now (utils/db.ts addFriendLocal) the node answers first: a refusal in
// its own words is thrown for the screen to show, and nothing is written here; a node that can't be reached keeps the
// add on the phone, as before. And fetchAddedYou reads the member's own "added you" with a signed request.
//
// The phone's real schema runs over an in-memory SQLite (node:sqlite). Nothing here contacts a node: fetch is a stub.

const h = vi.hoisted(() => ({ store: new Map<string, string>([['beanpool_anchor_url', 'https://community.example']]) }));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    (globalThis as any).__phoneSql = sql;
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
    return { openDatabaseAsync: vi.fn(async () => adapter) };
});
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_community.example.db'), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import * as phoneDb from '../db';
import { getDb, addFriendLocal } from '../db';

const sql = (globalThis as any).__phoneSql as import('node:sqlite').DatabaseSync;
const fetchMock = vi.fn();
const reply = (status: number, body: any) =>
    ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const rowFor = (friend: string) => sql.prepare('SELECT 1 AS x FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?').get('me-pub', friend);

beforeEach(async () => {
    await getDb();
    sql.exec('DELETE FROM friends');
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('adding a friend on the phone', () => {
    it("past the day's adds: the node's words are thrown and no row is written here", async () => {
        fetchMock.mockResolvedValueOnce(reply(429, { error: 'You can add 100 people in any 24 hours. You can add someone again in about 5 hours.', code: 'friend_adds_per_day', resetsAt: new Date().toISOString() }));
        const err: any = await addFriendLocal('me-pub', 'them-1').catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('You can add 100 people in any 24 hours. You can add someone again in about 5 hours.');
        expect(rowFor('them-1')).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toBe('https://community.example/api/friends/add');
    });

    it('someone you blocked: refused in words, nothing written', async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'You have blocked them. Unblock them first to add them.', code: 'blocked' }));
        const err: any = await addFriendLocal('me-pub', 'them-2').catch(e => e);
        expect(err?.message).toBe('You have blocked them. Unblock them first to add them.');
        expect(rowFor('them-2')).toBeUndefined();
    });

    it('an add the node takes is written here too', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, friend: { publicKey: 'them-3', callsign: 'Three' } }));
        await addFriendLocal('me-pub', 'them-3');
        expect(rowFor('them-3')).toBeTruthy();
    });

    it("a node that can't be reached keeps the add on the phone, as before", async () => {
        fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
        await addFriendLocal('me-pub', 'them-4');
        expect(rowFor('them-4')).toBeTruthy();
    });
});

describe('who added you', () => {
    it('is read with a signed request for your own, newest first, with how many more', async () => {
        const fetchAddedYou = (phoneDb as any).fetchAddedYou;
        expect(typeof fetchAddedYou).toBe('function');
        const addedYou = [{ publicKey: 'a', callsign: 'Ana', avatarUrl: null, addedAt: '2026-10-14T00:00:00.000Z' }];
        fetchMock.mockResolvedValueOnce(reply(200, { addedYou, more: 3 }));
        expect(await fetchAddedYou()).toEqual({ addedYou, more: 3 });
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://community.example/api/friends/added-you');
        expect(JSON.stringify(init?.headers ?? {})).toContain('X-Signed');
    });

    it('an older node (no such read) shows nothing', async () => {
        const fetchAddedYou = (phoneDb as any).fetchAddedYou;
        fetchMock.mockResolvedValueOnce(reply(403, { error: 'You may only read your own friends' }));
        expect(await fetchAddedYou()).toEqual({ addedYou: [], more: 0 });
    });
});
