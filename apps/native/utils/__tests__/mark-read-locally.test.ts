import { describe, it, expect, vi, beforeEach } from 'vitest';

const events = vi.hoisted(() => ({
    emitted: [] as { name: string; payload?: unknown }[],
    runAsyncCalls: [] as { query: string; params: any[] }[],
}));

vi.mock('../app-events', () => ({
    CONVERSATION_READ_LOCALLY_EVENT: 'conversation_read_locally',
    emitAppEvent: vi.fn((name: string, payload?: unknown) => {
        events.emitted.push({ name, payload });
    }),
}));

const dbAdapter = {
    runAsync: vi.fn(async (query: string, params: any[]) => {
        events.runAsyncCalls.push({ query, params });
        return { changes: 1, lastInsertRowId: 1 };
    }),
    execAsync: vi.fn(async () => {}),
    getAllAsync: vi.fn(async () => []),
    getFirstAsync: vi.fn(async () => null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};

vi.mock('expo-sqlite', () => ({
    openDatabaseAsync: vi.fn(async () => dbAdapter),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'e'.repeat(64), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
    clearGuestNode: vi.fn(async () => {}),
}));

import { markConversationReadLocally } from '../db';
import { CONVERSATION_READ_LOCALLY_EVENT } from '../app-events';

beforeEach(() => {
    events.emitted = [];
    events.runAsyncCalls = [];
    vi.mocked(dbAdapter.getFirstAsync).mockReset();
});

describe('markConversationReadLocally', () => {
    it('updates conversation_participants last_read_at and emits CONVERSATION_READ_LOCALLY_EVENT', async () => {
        vi.mocked(dbAdapter.getFirstAsync).mockResolvedValueOnce({ id: 'msg-1' });
        await markConversationReadLocally('conv-123', 'pk-my-key');

        // Check SQL update
        expect(events.runAsyncCalls.length).toBe(1);
        expect(events.runAsyncCalls[0].query).toContain('UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ?');
        expect(events.runAsyncCalls[0].params[1]).toBe('conv-123');
        expect(events.runAsyncCalls[0].params[2]).toBe('pk-my-key');

        // Check event emitted
        expect(events.emitted).toContainEqual({
            name: CONVERSATION_READ_LOCALLY_EVENT,
            payload: { conversationId: 'conv-123', myPubkey: 'pk-my-key' },
        });
    });

    it('does not update SQLite or emit event when there are no unread messages', async () => {
        vi.mocked(dbAdapter.getFirstAsync).mockResolvedValueOnce(null);
        await markConversationReadLocally('conv-123', 'pk-my-key');

        expect(events.runAsyncCalls.length).toBe(0);
        expect(events.emitted.length).toBe(0);
    });
});
