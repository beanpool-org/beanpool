import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Who the phone's invite screen offers Vouch for them to (people.tsx): the node's word now, never this phone's copy of an
 * older answer. getBalance answers from the copy and refreshes it behind that answer, so a read of it alone shows someone
 * appointed since the last read no control, and someone stood down a control the node then refuses. Through the real
 * utils/db.ts, over a fake store and a fake node.
 */
const stored = vi.hoisted(() => new Map<string, string>());

const dbAdapter = {
    runAsync: vi.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    execAsync: vi.fn(async () => {}),
    getAllAsync: vi.fn(async () => []),
    getFirstAsync: vi.fn(async (query?: string) => (query?.includes('PRAGMA user_version') ? { user_version: 100 } : null) as any),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};

vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => dbAdapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { stored.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { stored.delete(key); }),
        getAllKeys: vi.fn(async () => [...stored.keys()]),
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'a'.repeat(64), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
    clearGuestNode: vi.fn(async () => {}),
}));

import { askCanVouch, getBalance } from '../db';

const KEY = 'a'.repeat(64);
const COPY = `bp_tier_${KEY}`;
const nodeSays = (canVouch: boolean) => vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ balance: 0, floor: 0, tier: { name: 'Newcomer', emoji: '' }, canVouch }),
})));
const copyHolds = (canVouch: boolean) => stored.set(COPY, JSON.stringify({ canVouch }));
const copied = () => JSON.parse(stored.get(COPY) ?? '{}').canVouch;

beforeEach(() => {
    stored.clear();
    stored.set('beanpool_anchor_url', 'https://node.example');
});

describe('askCanVouch', () => {
    it('is needed: getBalance alone answers from the copy, and the node\'s word lands after it', async () => {
        copyHolds(false);
        nodeSays(true);
        expect((await getBalance(KEY)).canVouch).toBe(false);
        await vi.waitFor(() => expect(copied()).toBe(true));
    });

    it('someone appointed since the last read is offered the choice the first time the screen opens', async () => {
        copyHolds(false);
        nodeSays(true);
        expect(await askCanVouch(KEY)).toBe(true);
    });

    it('someone stood down since the last read is not', async () => {
        copyHolds(true);
        nodeSays(false);
        expect(await askCanVouch(KEY)).toBe(false);
    });

    it('a phone with no copy yet, such as a first open, takes the node\'s word too', async () => {
        nodeSays(true);
        expect(await askCanVouch(KEY)).toBe(true);
    });

    it('with no answer from the node the copy stands, and nothing throws', async () => {
        copyHolds(true);
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no connection'); }));
        expect(await askCanVouch(KEY)).toBe(true);
    });
});
