/**
 * Lights-out H2: the move to the hall laptop and back carries the community's copy (utils/community-copy-carry.ts, the
 * real carry), from a named https address to a plain-http number and back again.
 *
 * The phone keeps one SQLite file per address (utils/nodes.ts getDatabaseFilenameForNode), and its sync cursors under that
 * file's name. Without the carry the hall would be an empty copy and a whole sync on the hall Wi-Fi for every phone. With
 * it: the old address's cursors are left behind (removed, never pointing at a file that is gone), and the new address has
 * the copy whole, with its cursors and the take-over count it was read at, so only an epoch change (the hall's record is
 * a restored copy) makes the next sync a whole one (takeover-epoch-sync.test.ts).
 *
 * The files are a map here (cache-file-migration.ts stood in for); the storage is a map; everything else is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
    },
}));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => ({ closeAsync: async () => {} })) }));
// The group chats' keys added into a copy already there: their own merge, run over real SQLite in community-copy-carry.test.ts.
const groupKeysAdded = vi.hoisted(() => ({ n: 0 }));
vi.mock('../group-chat-store', () => ({ addGroupKeyState: vi.fn(async () => { groupKeysAdded.n++; }) }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
vi.mock('../cache-file-migration', () => ({
    databaseDirectory: () => 'file:///data/SQLite/',
    fileUri: (dir: string, name: string) => `${dir}${name}`,
    exists: vi.fn(async (uri: string) => files.has(uri.replace('file:///data/SQLite/', ''))),
    copyCopyFile: vi.fn(async (_dir: string, from: string, to: string) => { files.set(to, files.get(from)!); }),
    deleteCopyFile: vi.fn(async (_dir: string, name: string) => { files.delete(name); }),
}));
vi.mock('../db', () => ({
    seedDmPinsBeforeCarry: vi.fn(async () => {}),
    linesHeldWithCarried: (_here: string | null, carried: string) => carried,
}));

import { carryCommunityCopy } from '../community-copy-carry';
import { getDatabaseFilenameForNode } from '../nodes';
import { syncCursorKeysOf } from '../../services/pillar-sync';

const HOME = 'https://byron.beanpool.org';
const HALL = 'http://192.168.8.1:8080';
const homeFile = getDatabaseFilenameForNode(HOME);
const hallFile = getDatabaseFilenameForNode(HALL);
const cursor = (file: string, id: string) => `pillar_sync_${file}_${id}`;
const cursorsOf = (file: string) => [...store.keys()].filter((k) => k.startsWith(`pillar_sync_${file}_`)).sort();

vi.mock('../../services/pillar-sync', () => ({
    syncCursorKeysOf: (f: string) => ['last-sync', 'checkpoint', 'members_last_sync', 'identity-epoch'].map((id) => `pillar_sync_${f}_${id}`),
}));

beforeEach(() => {
    store.clear();
    files.clear();
    store.set('beanpool_anchor_url', HOME);
    files.set(homeFile, 'the community, as this phone holds it');
    for (const k of syncCursorKeysOf(homeFile)) store.set(k, k.endsWith('identity-epoch') ? '0' : '1793740000000');
});

describe('the hall move carries the copy: the old address\'s cursors left behind, the new copy whole', () => {
    it('to the hall laptop\'s number and back', async () => {
        expect(homeFile).not.toBe(hallFile);
        const before = Object.fromEntries(syncCursorKeysOf(homeFile).map((k) => [k.slice(`pillar_sync_${homeFile}_`.length), store.get(k)]));

        const order: string[] = [];
        expect(await carryCommunityCopy(HOME, HALL, async () => { order.push(`address with ${cursorsOf(hallFile).length} cursors`); store.set('beanpool_anchor_url', HALL); })).toBe('carried');

        // The new copy whole: the same file, every cursor with its value (the epoch too), before the address was written.
        expect(files.get(hallFile)).toBe('the community, as this phone holds it');
        for (const [id, value] of Object.entries(before)) expect(store.get(cursor(hallFile, id)), id).toBe(value);
        expect(order).toEqual([`address with ${Object.keys(before).length} cursors`]);
        // The old address's copy and cursors left behind: gone from the phone, so nothing points at a file that isn't there.
        expect(files.has(homeFile)).toBe(false);
        expect(cursorsOf(homeFile)).toEqual([]);
        expect(store.get('beanpool_anchor_url')).toBe(HALL);

        // Home again: the same, the other way.
        store.set(cursor(hallFile, 'last-sync'), '1793750000000');
        expect(await carryCommunityCopy(HALL, HOME, async () => { store.set('beanpool_anchor_url', HOME); })).toBe('carried');
        expect(files.get(homeFile)).toBe('the community, as this phone holds it');
        expect(store.get(cursor(homeFile, 'last-sync'))).toBe('1793750000000');
        expect(files.has(hallFile)).toBe(false);
        expect(cursorsOf(hallFile)).toEqual([]);
    });

    it('a copy already under the hall\'s number (an earlier hall) keeps its own rows and cursors: nothing laid over it', async () => {
        files.set(hallFile, 'the copy from the last drill');
        store.set(cursor(hallFile, 'last-sync'), '1700000000000');
        expect(await carryCommunityCopy(HOME, HALL, async () => { store.set('beanpool_anchor_url', HALL); })).toBe('kept-both');
        expect(files.get(hallFile)).toBe('the copy from the last drill');
        expect(store.get(cursor(hallFile, 'last-sync'))).toBe('1700000000000');
        expect(groupKeysAdded.n).toBe(1);
        // The home copy stays on the phone with its cursors, for the way back.
        expect(files.has(homeFile)).toBe(true);
        expect(cursorsOf(homeFile).length).toBe(4);
    });
});
