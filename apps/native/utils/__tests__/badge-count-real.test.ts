import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Real SQLite tests for badge-count:
// The phone's red number counts only what the member can find and open.
// 1. For each system line the rule drops (joined, left, removed, role change, own system lines),
//    the count stays the same in all three reads: getGlobalUnreadCount, getUnreadByConversation, and getConversations.
// 2. An ordinary line counts.
// 3. Another member's system event/poll line counts.
// 4. All three agree on one conversation.

const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    (globalThis as any).__badgePhoneSql = sql;
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
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///nowhere/',
    getInfoAsync: vi.fn(async () => ({ exists: false })),
    deleteAsync: vi.fn(async () => {}),
    makeDirectoryAsync: vi.fn(async () => {}),
    writeAsStringAsync: vi.fn(async () => {}),
    moveAsync: vi.fn(async () => {}),
}));
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Bo' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(() => 'beanpool_mullum.db'), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { getDb, getGlobalUnreadCount, getUnreadByConversation, getConversations, markConversationReadLocally } from '../db';
import { QUIET_SYSTEM_TYPES } from '@beanpool/core';

const sql = (globalThis as any).__badgePhoneSql as import('node:sqlite').DatabaseSync;

interface Person { name: string; publicKey: string; privateKey: string }
function person(name: string): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { name, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

/** Runs `fn` with react-native's DeviceEventEmitter stood in for (node cannot load it). */
async function withScreens<T>(fn: () => Promise<T>): Promise<T> {
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        return await fn();
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

let bo: Person;
let kai: Person;
let serial = 0;
let clock = Date.parse('2026-10-01T10:00:00.000Z');

function insertMessage(opts: {
    conversationId: string;
    authorPubkey: string;
    type?: string | null;
    systemType?: string | null;
    metadata?: string | null;
    timestamp?: string;
    ciphertext?: string;
    nonce?: string;
}) {
    const id = `msg-${++serial}`;
    clock += 1000;
    const ts = opts.timestamp || new Date(clock).toISOString();
    sql.prepare(`
        INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        opts.conversationId,
        opts.authorPubkey,
        opts.ciphertext ?? 'line text',
        opts.nonce ?? 'plaintext-v1',
        opts.type === undefined ? 'text' : opts.type,
        opts.systemType ?? null,
        opts.metadata ?? null,
        ts,
    );
    return { id, timestamp: ts };
}

beforeEach(async () => {
    h.store.clear();
    h.store.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
    bo = person('Bo');
    kai = person('Kai');
    h.me = { publicKey: bo.publicKey, privateKey: bo.privateKey };

    await getDb();
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) {
        sql.exec(`DELETE FROM ${t}`);
    }

    // Insert members
    sql.prepare('INSERT INTO members (public_key, callsign) VALUES (?, ?)').run(bo.publicKey, 'Bo');
    sql.prepare('INSERT INTO members (public_key, callsign) VALUES (?, ?)').run(kai.publicKey, 'Kai');
});

describe('badge-count: real SQLite tests for all three unread readers', () => {
    it('drops membership system lines: count stays 0 across getGlobalUnreadCount, getUnreadByConversation, and getConversations', async () => {
        const convId = 'grp-1';
        sql.prepare('INSERT INTO conversations (id, type, name) VALUES (?, ?, ?)').run(convId, 'group_thread', 'Garden Group');
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, bo.publicKey, null);
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, kai.publicKey, null);

        // Initially zero
        expect(await getGlobalUnreadCount(bo.publicKey)).toBe(0);
        expect(await getUnreadByConversation(bo.publicKey)).toEqual([]);
        const initialList = await withScreens(() => getConversations(bo.publicKey));
        expect(initialList.find((c: any) => c.id === convId)?.unread).toBe(0);

        // For each quiet system line the rule drops, counts stay at 0 in all three reads
        for (const quietType of QUIET_SYSTEM_TYPES) {
            insertMessage({
                conversationId: convId,
                authorPubkey: 'SYSTEM',
                type: 'system',
                systemType: quietType,
                metadata: JSON.stringify({ actorPubkey: kai.publicKey }),
            });

            const globalCount = await getGlobalUnreadCount(bo.publicKey);
            const byConv = await getUnreadByConversation(bo.publicKey);
            const list = await withScreens(() => getConversations(bo.publicKey));
            const convRow = list.find((c: any) => c.id === convId);

            expect(globalCount).toBe(0);
            expect(byConv).toEqual([]);
            expect(convRow?.unread).toBe(0);
        }
    });

    it("drops own system lines (events/polls posted by viewer): count stays 0 in all three reads", async () => {
        const convId = 'grp-2';
        sql.prepare('INSERT INTO conversations (id, type, name) VALUES (?, ?, ?)').run(convId, 'group_thread', 'Park Crew');
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, bo.publicKey, null);
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, kai.publicKey, null);

        // Bo posted an event in the group
        insertMessage({
            conversationId: convId,
            authorPubkey: 'SYSTEM',
            type: 'system',
            systemType: 'GROUP_EVENT_POSTED',
            metadata: JSON.stringify({ actorPubkey: bo.publicKey, eventId: 'ev-1' }),
        });

        // Bo posted a poll in the group
        insertMessage({
            conversationId: convId,
            authorPubkey: 'SYSTEM',
            type: 'system',
            systemType: 'GROUP_POLL_POSTED',
            metadata: JSON.stringify({ actorPubkey: bo.publicKey, pollId: 'poll-1' }),
        });

        expect(await getGlobalUnreadCount(bo.publicKey)).toBe(0);
        expect(await getUnreadByConversation(bo.publicKey)).toEqual([]);
        const list = await withScreens(() => getConversations(bo.publicKey));
        expect(list.find((c: any) => c.id === convId)?.unread).toBe(0);
    });

    it('ordinary lines and other members’ system lines count, and all three agree on one conversation', async () => {
        const convId = 'grp-3';
        sql.prepare('INSERT INTO conversations (id, type, name) VALUES (?, ?, ?)').run(convId, 'group_thread', 'Repair Cafe');
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, bo.publicKey, null);
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, kai.publicKey, null);

        // 1. Membership lines arrive (should not count)
        insertMessage({ conversationId: convId, authorPubkey: 'SYSTEM', type: 'system', systemType: 'GROUP_MEMBER_JOINED' });
        insertMessage({ conversationId: convId, authorPubkey: 'SYSTEM', type: 'system', systemType: 'GROUP_ROLE_CHANGED' });

        // 2. An ordinary line from Kai arrives (should count +1)
        insertMessage({ conversationId: convId, authorPubkey: kai.publicKey, type: 'text' });

        // 3. Kai posts an event in the group (should count +1 because actor is Kai, not Bo)
        insertMessage({
            conversationId: convId,
            authorPubkey: 'SYSTEM',
            type: 'system',
            systemType: 'GROUP_EVENT_POSTED',
            metadata: JSON.stringify({ actorPubkey: kai.publicKey, eventId: 'ev-2' }),
        });

        // 4. Bo's own message arrives (should not count)
        insertMessage({ conversationId: convId, authorPubkey: bo.publicKey, type: 'text' });

        // 5. Bo's own poll arrives (should not count)
        insertMessage({
            conversationId: convId,
            authorPubkey: 'SYSTEM',
            type: 'system',
            systemType: 'GROUP_POLL_POSTED',
            metadata: JSON.stringify({ actorPubkey: bo.publicKey, pollId: 'poll-2' }),
        });

        // Verify: total unread should be exactly 2 in all three reads
        const globalCount = await getGlobalUnreadCount(bo.publicKey);
        const byConv = await getUnreadByConversation(bo.publicKey);
        const list = await withScreens(() => getConversations(bo.publicKey));
        const convRow = list.find((c: any) => c.id === convId);

        expect(globalCount).toBe(2);
        expect(byConv).toEqual([
            { id: convId, type: 'group_thread', unread: 2, peer: 'Repair Cafe' },
        ]);
        expect(convRow).toBeDefined();
        expect(convRow?.unread).toBe(2);

        // All three agree
        expect(globalCount).toBe(byConv[0].unread);
        expect(globalCount).toBe(convRow?.unread);

        // 6. Mark read locally: all three reads clear to 0
        await markConversationReadLocally(convId, bo.publicKey);

        expect(await getGlobalUnreadCount(bo.publicKey)).toBe(0);
        expect(await getUnreadByConversation(bo.publicKey)).toEqual([]);
        const listAfterRead = await withScreens(() => getConversations(bo.publicKey));
        expect(listAfterRead.find((c: any) => c.id === convId)?.unread).toBe(0);
    });

    it('enterprise threads are excluded from all three reads', async () => {
        const entId = 'ent-thread-1';
        sql.prepare('INSERT INTO conversations (id, type, name) VALUES (?, ?, ?)').run(entId, 'enterprise_thread', 'Bakery Enterprise');
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(entId, bo.publicKey, null);

        insertMessage({ conversationId: entId, authorPubkey: kai.publicKey, type: 'text' });

        expect(await getGlobalUnreadCount(bo.publicKey)).toBe(0);
        expect(await getUnreadByConversation(bo.publicKey)).toEqual([]);
        const list = await withScreens(() => getConversations(bo.publicKey));
        expect(list.find((c: any) => c.id === entId)).toBeUndefined();
    });

    it('counts non-system messages with NULL type even when quiet systemType or viewer actorPubkey is present (3VL)', async () => {
        const convId = 'grp-null-type';
        sql.prepare('INSERT INTO conversations (id, type, name) VALUES (?, ?, ?)').run(convId, 'group_thread', 'Null Type Group');
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, bo.publicKey, null);
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, kai.publicKey, null);

        // A message from Kai where type is NULL in SQLite, but systemType is in the quiet list
        // and metadata has actorPubkey matching bo.
        // Under 3VL without COALESCE, (NULL = 'system' AND ...) -> NULL -> falsy in WHERE.
        // With COALESCE(type, '') = 'system', it evaluates to FALSE, and NOT (FALSE) is TRUE.
        insertMessage({
            conversationId: convId,
            authorPubkey: kai.publicKey,
            type: null,
            systemType: 'GROUP_MEMBER_JOINED',
            metadata: JSON.stringify({ actorPubkey: bo.publicKey }),
        });

        expect(await getGlobalUnreadCount(bo.publicKey)).toBe(1);
        const byConv = await getUnreadByConversation(bo.publicKey);
        expect(byConv).toEqual([
            { id: convId, type: 'group_thread', unread: 1, peer: 'Null Type Group' },
        ]);
        const list = await withScreens(() => getConversations(bo.publicKey));
        const convRow = list.find((c: any) => c.id === convId);
        expect(convRow?.unread).toBe(1);
    });

    it('subquery unread counting does not shadow outer query message alias in getConversations', async () => {
        const convId = 'grp-alias-test';
        sql.prepare('INSERT INTO conversations (id, type, name) VALUES (?, ?, ?)').run(convId, 'group_thread', 'Alias Test Group');
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, bo.publicKey, null);
        sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(convId, kai.publicKey, null);

        // Latest message in conversation from Kai
        const encodedText = Buffer.from('hello from Kai').toString('base64');
        insertMessage({
            conversationId: convId,
            authorPubkey: kai.publicKey,
            type: 'text',
            ciphertext: encodedText,
            nonce: 'plaintext-v1',
        });

        const list = await withScreens(() => getConversations(bo.publicKey));
        const convRow = list.find((c: any) => c.id === convId);
        expect(convRow).toBeDefined();
        expect(convRow?.unread).toBe(1);
        expect(convRow?.lastMessage).toBe('hello from Kai');
    });
});
