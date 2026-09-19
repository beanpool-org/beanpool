import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// The header's unread counts (getUnreadByConversation) run as real SQL here, against the columns the phone's
// schema has, so the count, the read cut-off and the peer name are checked rather than assumed.
const sql = new DatabaseSync(':memory:');
sql.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, post_id TEXT, name TEXT);
    CREATE TABLE conversation_participants (conversation_id TEXT, public_key TEXT, last_read_at DATETIME, PRIMARY KEY (conversation_id, public_key));
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, author_pubkey TEXT, ciphertext TEXT, nonce TEXT, timestamp TEXT);
    CREATE TABLE members (public_key TEXT PRIMARY KEY, callsign TEXT);
`);

const mockDb = {
    runAsync: vi.fn().mockResolvedValue({ changes: 1 }),
    execAsync: vi.fn().mockResolvedValue(undefined),
    getAllAsync: vi.fn(async (q: string, params: any[] = []) => sql.prepare(q).all(...params)),
    getFirstAsync: vi.fn().mockResolvedValue(null),
    closeAsync: vi.fn().mockResolvedValue(undefined),
    withTransactionAsync: vi.fn().mockImplementation(async (cb: () => Promise<void>) => { await cb(); }),
};
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/', getInfoAsync: vi.fn().mockResolvedValue({ exists: false }) }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me', privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
const decryptSpy = vi.fn();
vi.mock('../e2e-crypto', async (orig) => ({ ...(await orig<any>()), decryptDM: (...a: any[]) => { decryptSpy(...a); throw new Error('no'); } }));

import { getUnreadByConversation } from '../db';

function seed() {
    const conv = sql.prepare('INSERT INTO conversations (id, type, name) VALUES (?, ?, ?)');
    const part = sql.prepare('INSERT INTO conversation_participants VALUES (?, ?, ?)');
    const msg = sql.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
    sql.prepare('INSERT INTO members VALUES (?, ?)').run('ana', 'Ana');
    sql.prepare('INSERT INTO members VALUES (?, ?)').run('bo', 'Bo');
    // A DM with Ana: read up to 10:00; two of Ana's lines after, one before, and one of mine after.
    conv.run('dm1', 'dm', null); part.run('dm1', 'me', '2026-09-19T10:00:00Z'); part.run('dm1', 'ana', null);
    msg.run('a1', 'dm1', 'ana', 'x', 'v2enc', '2026-09-19T09:00:00Z');
    msg.run('a2', 'dm1', 'ana', 'x', 'v2enc', '2026-09-19T10:05:00Z');
    msg.run('a3', 'dm1', 'ana', 'x', 'v2enc', '2026-09-19T10:06:00Z');
    msg.run('a4', 'dm1', 'me', 'x', 'v2enc', '2026-09-19T10:07:00Z');
    // A DM with Bo, all read.
    conv.run('dm2', 'dm', null); part.run('dm2', 'me', '2026-09-19T12:00:00Z'); part.run('dm2', 'bo', null);
    msg.run('b1', 'dm2', 'bo', 'x', 'v2enc', '2026-09-19T11:00:00Z');
    // A named group thread never read: counted, named by the conversation.
    conv.run('g1', 'group_thread', 'Garden'); part.run('g1', 'me', null); part.run('g1', 'ana', null);
    msg.run('g-1', 'g1', 'ana', 'x', 'plaintext', '2026-09-19T08:00:00Z');
    // An enterprise thread is left out, as in getGlobalUnreadCount.
    conv.run('e1', 'enterprise_thread', 'Bakery'); part.run('e1', 'me', null);
    msg.run('e-1', 'e1', 'bo', 'x', 'plaintext', '2026-09-19T08:00:00Z');
    // A conversation I'm not in.
    conv.run('x1', 'dm', null); part.run('x1', 'ana', null); part.run('x1', 'bo', null);
    msg.run('x-1', 'x1', 'bo', 'x', 'v2enc', '2026-09-19T08:00:00Z');
}

describe('getUnreadByConversation: counts for the header, no decryption', () => {
    it('counts unread lines per conversation after my last read, from others only', async () => {
        seed();
        const rows = (await getUnreadByConversation('me')).sort((a, b) => a.id.localeCompare(b.id));
        expect(rows).toEqual([
            { id: 'dm1', type: 'dm', unread: 2, peer: 'Ana' },
            { id: 'g1', type: 'group_thread', unread: 1, peer: 'Garden' },
        ]);
        expect(decryptSpy).not.toHaveBeenCalled();
    });
});
