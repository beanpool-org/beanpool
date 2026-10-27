import { describe, it, expect, vi, beforeEach } from 'vitest';

// A Cancel request on the recipient's phone (PR #2540 review 4393642158): syncSingleConversation drops the opener's lines
// the node no longer has, whatever the request's state and however many lines the node still holds, and never a line of
// the reader's. The phone's local lines are stood in for: the purge's own read of them answers `local` below.
const local = vi.hoisted(() => ({ lines: [] as { id: string; author: string }[] }));
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

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
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
    deleteAsync: vi.fn().mockResolvedValue(undefined),
}));
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

/** The purge's read of the phone's lines: those of the named author in the conversation, less the ids named after them. */
function answerLocalLines(sql: string, params: unknown[]): { id: string }[] | undefined {
    if (typeof sql !== 'string' || !sql.startsWith('SELECT id FROM messages WHERE conversation_id = ? AND author_pubkey = ?')) return undefined;
    const [, author, ...notIn] = params as string[];
    return local.lines.filter(l => l.author === author && !notIn.includes(l.id)).map(l => ({ id: l.id }));
}
const deletes = () => mockRunAsync.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM messages'));

function nodeAnswers(id: string, request: Record<string, unknown> | null, messages: any[]) {
    fetchMock.mockResolvedValue(reply(200, {
        conversation: { id, type: 'dm', createdBy: 'opener-pub', participants: ['opener-pub', 'recipient-pub'], request },
        messages,
    }));
}
const line = (id: string, author: string) => ({ id, conversationId: 'conv-recipient', authorPubkey: author, ciphertext: 'x', nonce: 'x25519-xc20p-v2:x', type: 'text', timestamp: '2026-10-27T01:00:00.000Z' });

describe('syncSingleConversation request purge', () => {
    beforeEach(() => {
        mockRunAsync.mockClear();
        mockGetAllAsync.mockReset().mockImplementation(async (sql: string, params: unknown[]) => answerLocalLines(sql, params) ?? []);
        mockGetFirstAsync.mockReset().mockResolvedValue(null);
        fetchMock.mockReset();
        (globalThis as any).fetch = fetchMock;
        local.lines = [];
    });

    it('never deletes the opener\'s own lines during poll on empty/pending request', async () => {
        currentIdentity = { publicKey: 'opener-pub', privateKey: 'aa', callsign: 'Opener' };
        local.lines = [{ id: 'mine-1', author: 'opener-pub' }];
        nodeAnswers('conv-opener', { state: 'pending', from: 'opener-pub', at: '2026-10-27T00:00:00Z' }, []);

        await syncSingleConversation('conv-opener');

        expect(deletes()).toHaveLength(0);
    });

    it('purges cancelled request messages on the recipient phone while preserving recipient lines', async () => {
        currentIdentity = { publicKey: 'recipient-pub', privateKey: 'bb', callsign: 'Recipient' };
        local.lines = [{ id: 'withdrawn', author: 'opener-pub' }, { id: 'mine-1', author: 'recipient-pub' }];
        nodeAnswers('conv-recipient', { state: 'pending', from: 'opener-pub', at: '2026-10-27T00:00:00Z' }, []);

        await syncSingleConversation('conv-recipient');

        const calls = deletes();
        expect(calls.length).toBeGreaterThan(0);
        // Only the opener's lines, never the recipient's: the delete names the opener as the author.
        expect(calls[0][0]).toContain('AND author_pubkey = ?');
        expect(calls[0][1]).toEqual(['conv-recipient', 'opener-pub']);
    });

    // The three cases of the review, each 0 deletes before the fix.
    it('a cancel then a new line: the withdrawn line goes, the new one stays', async () => {
        currentIdentity = { publicKey: 'recipient-pub', privateKey: 'bb', callsign: 'Recipient' };
        local.lines = [{ id: 'withdrawn', author: 'opener-pub' }, { id: 'new-line', author: 'opener-pub' }];
        nodeAnswers('conv-recipient', { state: 'pending', from: 'opener-pub', at: '2026-10-27T01:00:00Z' }, [line('new-line', 'opener-pub')]);

        await syncSingleConversation('conv-recipient');

        const calls = deletes();
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toContain('AND author_pubkey = ?');
        expect(calls[0][0]).toContain('id NOT IN (?)');
        expect(calls[0][1]).toEqual(['conv-recipient', 'opener-pub', 'new-line']);
    });

    it('one the recipient ignored, its line withdrawn: it goes', async () => {
        currentIdentity = { publicKey: 'recipient-pub', privateKey: 'bb', callsign: 'Recipient' };
        local.lines = [{ id: 'withdrawn', author: 'opener-pub' }];
        nodeAnswers('conv-recipient', { state: 'ignored', from: 'opener-pub', at: '2026-10-27T00:00:00Z' }, []);

        await syncSingleConversation('conv-recipient');

        expect(deletes()).toHaveLength(1);
        expect(deletes()[0][1]).toEqual(['conv-recipient', 'opener-pub']);
    });

    it('one the recipient accepted since, its line withdrawn before: it goes, and their own line stays', async () => {
        currentIdentity = { publicKey: 'recipient-pub', privateKey: 'bb', callsign: 'Recipient' };
        local.lines = [{ id: 'withdrawn', author: 'opener-pub' }, { id: 'mine-1', author: 'recipient-pub' }];
        nodeAnswers('conv-recipient', { state: 'accepted', from: 'opener-pub', at: '2026-10-27T00:00:00Z' }, [line('mine-1', 'recipient-pub')]);

        await syncSingleConversation('conv-recipient');

        expect(deletes()).toHaveLength(1);
        expect(deletes()[0][1]).toEqual(['conv-recipient', 'opener-pub', 'mine-1']);
    });

    it('nothing withdrawn: nothing deleted', async () => {
        currentIdentity = { publicKey: 'recipient-pub', privateKey: 'bb', callsign: 'Recipient' };
        local.lines = [{ id: 'first', author: 'opener-pub' }];
        nodeAnswers('conv-recipient', { state: 'pending', from: 'opener-pub', at: '2026-10-27T00:00:00Z' }, [line('first', 'opener-pub')]);

        await syncSingleConversation('conv-recipient');

        expect(deletes()).toHaveLength(0);
    });
});
