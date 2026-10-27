import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunAsync = vi.fn().mockResolvedValue({ changes: 1 });
const mockGetAllAsync = vi.fn().mockResolvedValue([]);
const mockGetFirstAsync = vi.fn().mockResolvedValue(null);
const mockDb = {
    runAsync: mockRunAsync,
    execAsync: vi.fn().mockResolvedValue(undefined),
    getAllAsync: mockGetAllAsync,
    getFirstAsync: mockGetFirstAsync,
    closeAsync: vi.fn().mockResolvedValue(undefined),
    withTransactionAsync: vi.fn().mockImplementation(async (cb: () => Promise<void>) => { await cb(); }),
};

vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
    signData: vi.fn(async (msg: Uint8Array) => msg),
}));

let currentIdentity = { publicKey: 'opener-pub', privateKey: 'aa', callsign: 'Opener' };
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => currentIdentity),
}));

import { syncSingleConversation } from '../db';

const fetchMock = vi.fn();
function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('syncSingleConversation request purge', () => {
    beforeEach(() => {
        mockRunAsync.mockClear();
        mockGetAllAsync.mockReset().mockResolvedValue([]);
        mockGetFirstAsync.mockReset().mockResolvedValue(null);
        fetchMock.mockReset();
        (globalThis as any).fetch = fetchMock;
    });

    it('never deletes the opener\'s own lines during poll on empty/pending request', async () => {
        currentIdentity = { publicKey: 'opener-pub', privateKey: 'aa', callsign: 'Opener' };
        fetchMock.mockResolvedValue(reply(200, {
            conversation: {
                id: 'conv-opener',
                type: 'dm',
                createdBy: 'opener-pub',
                request: { state: 'pending', from: 'opener-pub', at: '2026-10-27T00:00:00Z' },
            },
            messages: [],
        }));

        await syncSingleConversation('conv-opener');

        const deleteCalls = mockRunAsync.mock.calls.filter(
            ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM messages')
        );
        expect(deleteCalls).toHaveLength(0);
    });

    it('purges cancelled request messages on the recipient phone while preserving recipient lines', async () => {
        currentIdentity = { publicKey: 'recipient-pub', privateKey: 'bb', callsign: 'Recipient' };
        fetchMock.mockResolvedValue(reply(200, {
            conversation: {
                id: 'conv-recipient',
                type: 'dm',
                createdBy: 'opener-pub',
                request: { state: 'pending', from: 'opener-pub', at: '2026-10-27T00:00:00Z' },
            },
            messages: [],
        }));

        await syncSingleConversation('conv-recipient');

        const deleteCalls = mockRunAsync.mock.calls.filter(
            ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM messages')
        );
        expect(deleteCalls.length).toBeGreaterThan(0);
        expect(deleteCalls[0][0]).toContain('AND author_pubkey != ?');
        expect(deleteCalls[0][1]).toEqual(['conv-recipient', 'recipient-pub']);
    });
});
