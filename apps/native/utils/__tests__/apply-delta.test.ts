import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunAsync = vi.fn().mockResolvedValue({ changes: 1 });
const mockDb = {
    runAsync: mockRunAsync,
    execAsync: vi.fn().mockResolvedValue(undefined),
    getAllAsync: vi.fn().mockResolvedValue([]),
    getFirstAsync: vi.fn().mockResolvedValue(null),
    closeAsync: vi.fn().mockResolvedValue(undefined),
    withTransactionAsync: vi.fn().mockImplementation(async (cb: () => Promise<void>) => {
        await cb();
    }),
};

// Mock dependencies required by db.ts
vi.mock('expo-sqlite', () => ({
    openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(undefined),
        removeItem: vi.fn().mockResolvedValue(undefined),
        getAllKeys: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('expo-crypto', () => ({
    randomUUID: () => 'test-uuid',
}));

vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../identity', () => ({
    loadIdentity: vi.fn().mockResolvedValue(null),
}));

vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'),
    addSavedNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../canonical-profile', () => ({
    getCanonicalProfile: vi.fn().mockResolvedValue(null),
    saveCanonicalProfile: vi.fn().mockResolvedValue(undefined),
}));

import { applyDelta } from '../db';

describe('applyDelta batch accounts sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRunAsync.mockResolvedValue({ changes: 1 });
    });

    it('batches account insertions into chunks of 100 rather than N single-row queries', async () => {
        const accounts = Array.from({ length: 250 }, (_, i) => ({
            public_key: `pk_${i}`,
            balance: i * 10,
            last_demurrage_epoch: i % 5,
        }));

        await applyDelta({ accounts });

        // For 250 accounts with batch size 100, we expect 3 calls to runAsync for accounts (100 + 100 + 50)
        const accountCalls = mockRunAsync.mock.calls.filter(([sql]) =>
            typeof sql === 'string' && sql.includes('INSERT OR REPLACE INTO accounts')
        );

        expect(accountCalls).toHaveLength(3);

        // Verify batch 1 has 100 items (300 parameters)
        expect(accountCalls[0][1]).toHaveLength(300);
        expect(accountCalls[0][0]).toContain('VALUES ' + Array(100).fill('(?, ?, ?)').join(', '));
        expect(accountCalls[0][1].slice(0, 3)).toEqual(['pk_0', 0, 0]);

        // Verify batch 2 has 100 items (300 parameters)
        expect(accountCalls[1][1]).toHaveLength(300);

        // Verify batch 3 has 50 items (150 parameters)
        expect(accountCalls[2][1]).toHaveLength(150);
        expect(accountCalls[2][0]).toContain('VALUES ' + Array(50).fill('(?, ?, ?)').join(', '));
        expect(accountCalls[2][1].slice(0, 3)).toEqual(['pk_200', 2000, 0]);
    });

    it('handles null/undefined fallback values in account batching', async () => {
        const accounts = [
            { public_key: 'pk_1' }, // balance & last_demurrage_epoch undefined
            { balance: 100 }, // public_key undefined
        ];

        await applyDelta({ accounts });

        const accountCalls = mockRunAsync.mock.calls.filter(([sql]) =>
            typeof sql === 'string' && sql.includes('INSERT OR REPLACE INTO accounts')
        );

        expect(accountCalls).toHaveLength(1);
        expect(accountCalls[0][1]).toEqual([
            'pk_1', 0, 0,
            null, 100, 0,
        ]);
    });

    it('does nothing when delta.accounts is empty or undefined', async () => {
        await applyDelta({});
        await applyDelta({ accounts: [] });

        const accountCalls = mockRunAsync.mock.calls.filter(([sql]) =>
            typeof sql === 'string' && sql.includes('INSERT OR REPLACE INTO accounts')
        );

        expect(accountCalls).toHaveLength(0);
    });
});
