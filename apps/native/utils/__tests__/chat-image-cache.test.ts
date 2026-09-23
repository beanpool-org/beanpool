import { describe, it, expect, vi, beforeEach } from 'vitest';

// "Delete for everyone" on a photo has to take the DECRYPTED copy with it, on both phones.
// getDecryptedAttachment writes the plaintext JPEG to ${cacheDirectory}chat-images/${messageId}.jpg, and the
// bubble only stops DRAWING it when the row becomes a tombstone — the file itself outlived the message.
// Device modules are stubbed at the boundary as in events-db.test.ts.

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

const mockDeleteAsync = vi.fn().mockResolvedValue(undefined);

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
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
    // Read at call time, not when the factory runs: vi.mock is hoisted above the const above.
    deleteAsync: (...args: any[]) => mockDeleteAsync(...args),
}));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'aa', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, path: string) => ({ 'X-Signed': `${method} ${path}` })),
    signData: vi.fn(async (msg: Uint8Array) => msg),
}));

import { deleteMessageApi, syncSingleConversation } from '../db';

// syncSingleConversation ends with a require('react-native') to emit a DeviceEventEmitter nudge, which node
// cannot parse. That is AFTER the upsert, and syncSingleConversation swallows it — so each sync test below
// also asserts the INSERT really ran, rather than trusting that it got that far.

const CACHED_JPEG = (id: string) => `/tmp/cache/chat-images/${id}.jpg`;

const fetchMock = vi.fn();
function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    mockRunAsync.mockClear();
    mockGetAllAsync.mockReset().mockResolvedValue([]);
    mockGetFirstAsync.mockReset().mockResolvedValue(null);
    mockDeleteAsync.mockClear();
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('a deleted photo leaves no decrypted copy behind', () => {
    it('removes the cached JPEG on the deleter\'s phone', async () => {
        // The author's own row, an image, as the local mirror in deleteMessageApi reads it.
        mockGetFirstAsync.mockResolvedValue({ metadata: null, author_pubkey: 'me-pub' });
        fetchMock.mockResolvedValue(reply(200, {
            message: { ciphertext: 'dGhpcw==', metadata: { removedBy: 'me-pub', removedAt: '2026-09-23T04:00:00Z' } },
        }));

        await deleteMessageApi('img-1');

        expect(mockDeleteAsync).toHaveBeenCalledWith(CACHED_JPEG('img-1'), { idempotent: true });
    });

    it('still removes it when there is no local row to mirror the tombstone into', async () => {
        // A group chat keeps no local message row, and its image was decrypted into the same cache.
        mockGetFirstAsync.mockResolvedValue(null);
        fetchMock.mockResolvedValue(reply(200, { message: { ciphertext: 'dGhpcw==' } }));

        await deleteMessageApi('img-2');

        expect(mockDeleteAsync).toHaveBeenCalledWith(CACHED_JPEG('img-2'), { idempotent: true });
    });

    it('removes it on the PEER\'s phone when the tombstone arrives in a sync', async () => {
        // The local row is still the image; the node's copy is the tombstone the other end just made.
        mockGetAllAsync.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM messages')) {
                return [{ id: 'img-3', metadata: null, edited_at: null, type: 'image' }];
            }
            return [];
        });
        mockGetFirstAsync.mockResolvedValue({
            ciphertext: 'b2xkLWJsb2I=', nonce: 'n1', type: 'image', edited_at: null, metadata: null,
        });
        fetchMock.mockResolvedValue(reply(200, {
            conversation: { id: 'conv-1' },
            messages: [{
                id: 'img-3', type: 'removed', ciphertext: 'dGhpcw==', nonce: 'plaintext-v1',
                metadata: JSON.stringify({ removed: true, removedBy: 'them-pub' }),
                timestamp: '2026-09-23T04:00:00Z',
            }],
        }));

        await syncSingleConversation('conv-1');

        const inserted = mockRunAsync.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO messages'),
        );
        expect(inserted).toBeTruthy();
        expect(inserted![1]).toContain('removed');
        expect(mockDeleteAsync).toHaveBeenCalledWith(CACHED_JPEG('img-3'), { idempotent: true });
    });

    it('leaves the cache alone for an ordinary incoming message', async () => {
        mockGetAllAsync.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM messages')) return [];
            return [];
        });
        mockGetFirstAsync.mockResolvedValue(null);
        fetchMock.mockResolvedValue(reply(200, {
            conversation: { id: 'conv-2' },
            messages: [{ id: 'txt-1', type: 'text', ciphertext: 'aGk=', nonce: 'n1', timestamp: '2026-09-23T04:00:00Z' }],
        }));

        await syncSingleConversation('conv-2');

        // The message really did land — otherwise "the cache was left alone" would prove nothing.
        const inserted = mockRunAsync.mock.calls.find(
            ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO messages'),
        );
        expect(inserted).toBeTruthy();
        expect(inserted![1]).toContain('txt-1');
        expect(mockDeleteAsync).not.toHaveBeenCalled();
    });
});
