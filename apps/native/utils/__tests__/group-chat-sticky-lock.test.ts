/**
 * A group chat this phone has held a key of stays locked here, whatever the node says later (review of #1788, finding 4;
 * director's decision b): the real utils/db.ts, against a fake node, sends nothing readable to it, by either path (the
 * chat screen's postGroupChatMessage and the conversation path's insertMessage). Only an old node (its chat answer has no
 * `encryption`) that this phone never saw locked still gets words it can read, as designed (§14.3). Mock style from
 * dm-never-plaintext.test.ts: device modules stubbed at the boundary, a small stand-in for SQLite, a fetch that records
 * every body.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const store = vi.hoisted(() => ({
    conversations: new Map<string, { id: string; type: string; created_by: string | null }>(),
    participants: new Map<string, Set<string>>(),
    messages: new Map<string, any>(),
    writes: [] as Array<{ sql: string; params: any[] }>,
    execs: [] as string[],
    keyState: null as { highest: number; after: number } | null,
}));
const partsOf = (id: string) => { if (!store.participants.has(id)) store.participants.set(id, new Set()); return store.participants.get(id)!; };
const mockDb = {
    execAsync: vi.fn(async (s: string) => { store.execs.push(s); return undefined; }),
    closeAsync: vi.fn(async () => undefined),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    getFirstAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/FROM conversations WHERE id = \?/.test(sql)) return store.conversations.get(params[0]) ?? null;
        if (/SELECT metadata FROM messages WHERE id/.test(sql)) return store.messages.get(params[0]) ?? null;
        if (/FROM group_chat_key_state/.test(sql)) return store.keyState;
        return null;
    }),
    getAllAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/SELECT public_key FROM conversation_participants WHERE conversation_id = \?/.test(sql)) return [...partsOf(params[0])].map((public_key) => ({ public_key }));
        return [];
    }),
    runAsync: vi.fn(async (sql: string, params: any[] = []) => {
        store.writes.push({ sql, params });
        if (/^INSERT INTO messages/.test(sql)) store.messages.set(params[0], { id: params[0], conversation_id: params[1], author_pubkey: params[2], ciphertext: params[3], nonce: params[4], metadata: params[5] });
        return { changes: 1 };
    }),
};
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/', getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined), writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
const who = vi.hoisted(() => ({ me: { publicKey: '', privateKey: '' } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...who.me, callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { insertMessage, postGroupChatMessage, clearDB } from '../db';
import {
    groupChatNotice, GROUP_CHAT_LOCK_LOST_TEXT, GROUP_CHAT_LOCKED_NOTICE, GROUP_CHAT_OLD_NODE_NOTICE,
} from '../group-chat-lines';
import { forgetGroupKeys, groupKeyring, memoryGroupKeyStore, GroupChatKeyError } from '../group-chat-keys';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

const seed = ed25519.utils.randomSecretKey();
who.me = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
const G = '11111111-2222-4333-8444-555555555555';
/** A group on a node from before locked chats: its chat answer carries no `encryption`, and it has no keys route. */
const OLD = '22222222-2222-4333-8444-555555555555';
const received: { method: string; path: string; body: any }[] = [];
function reply(status: number, body: any) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } }; }
(globalThis as any).fetch = vi.fn(async (url: string, init: any = {}) => {
    const path = String(url).replace('https://test.beanpool.org', '');
    const method = init.method ?? 'GET';
    let body: any; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    received.push({ method, path, body });
    // An honest NEW node's answers: GET …/keys 404 is what requireGroupMember says to someone with no live row in an
    // invite-only group (removed, or left); a readable line is refused, but it has already arrived.
    if (method === 'GET' && path.startsWith(`/api/groups/${G}/keys`)) return reply(404, { error: 'Group not found' });
    if (method === 'GET' && path.startsWith(`/api/groups/${OLD}/chat`)) return reply(200, { messages: [], canPost: true, notice: 'anything' });
    if (method === 'POST' && path === `/api/groups/${OLD}/chat/message`) return reply(201, { success: true });
    if (method === 'POST' && path === '/api/messages/send' && body?.conversationId === OLD) return reply(201, { success: true });
    if (method === 'POST' && path === `/api/groups/${G}/chat/message`) return reply(400, { error: 'Update BeanPool to use this group chat: its messages are now end-to-end encrypted.', code: 'not_encrypted' });
    if (method === 'POST' && path === '/api/messages/send') return reply(403, { error: 'Only members of this group can post in its chat' });
    return reply(404, { error: 'not here' });
});

const waitFor = async (pred: () => boolean, ms = 5000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); };

const sentReadable = () => received.filter((r) => (r.path.endsWith('/chat/message') && typeof r.body?.text === 'string')
    || (r.path === '/api/messages/send' && r.body?.nonce === 'plaintext-v1'));
const fresh = () => { forgetGroupKeys(); received.length = 0; store.keyState = null; };

describe('a group chat this phone has held a key of stays locked here', () => {
    it('the chat screen: the node drops `encryption` from a group whose key this phone held; nothing readable is sent, and the phone says why', async () => {
        fresh();
        store.keyState = { highest: 2, after: 2 };
        const err = await postGroupChatMessage(G, 'C1 our secret plan', randomUUID(), null, undefined).catch((e) => e);
        expect(err).toBeInstanceOf(GroupChatKeyError);
        expect(err.message).toBe(GROUP_CHAT_LOCK_LOST_TEXT);
        expect(sentReadable()).toEqual([]);
    });

    it('the conversation path: GET …/keys answers 404 for a group whose key this phone held; nothing is sent', async () => {
        fresh();
        store.keyState = { highest: 2, after: 2 };
        store.conversations.set(G, { id: G, type: 'group_thread', created_by: null });
        const err = await insertMessage(G, who.me.publicKey, 'C2 words for the group').catch((e) => e);
        expect(err?.message).toBe(GROUP_CHAT_LOCK_LOST_TEXT);
        await waitFor(() => false, 200);
        expect(sentReadable()).toEqual([]);
        expect([...store.messages.values()].filter((m) => m.conversation_id === G)).toEqual([]);
    });

    it('a new node that refuses this phone the keys (404) and the chat: nothing readable goes, even from a phone that held no key', async () => {
        fresh();
        store.conversations.set(G, { id: G, type: 'group_thread', created_by: null });
        const err = await insertMessage(G, who.me.publicKey, 'C2 words for the group').catch((e) => e);
        expect(err).toBeInstanceOf(GroupChatKeyError);
        await waitFor(() => false, 200);
        expect(sentReadable()).toEqual([]);
    });

    it('an old node this phone never saw locked still gets words as before, by both paths (§14.3)', async () => {
        fresh();
        await postGroupChatMessage(OLD, 'old node words', randomUUID(), null, undefined);
        store.conversations.set(OLD, { id: OLD, type: 'group_thread', created_by: null });
        await insertMessage(OLD, who.me.publicKey, 'old node line').catch(() => null);
        await waitFor(() => received.some((r) => r.path === '/api/messages/send'));
        expect(sentReadable().map((r) => r.path)).toEqual([`/api/groups/${OLD}/chat/message`, '/api/messages/send']);
    });

    it('the notice is the phone\'s own words for what it decided, never the node\'s', () => {
        expect(groupChatNotice({ nodeSaysLocked: true, seenLocked: false })).toBe(GROUP_CHAT_LOCKED_NOTICE);
        expect(groupChatNotice({ nodeSaysLocked: true, seenLocked: true })).toBe(GROUP_CHAT_LOCKED_NOTICE);
        expect(groupChatNotice({ nodeSaysLocked: false, seenLocked: true })).toBe(GROUP_CHAT_LOCK_LOST_TEXT);
        expect(groupChatNotice({ nodeSaysLocked: false, seenLocked: false })).toBe(GROUP_CHAT_OLD_NODE_NOTICE);
    });

    it('a wipe or sign-out (clearDB) drops the four group-key tables and forgets every opened key (finding 8)', async () => {
        const ring = groupKeyring('https://test.beanpool.org', who.me, G, memoryGroupKeyStore());
        store.execs.length = 0;
        await clearDB();
        const drops = store.execs.filter((s) => /DROP TABLE/.test(s)).join(' ');
        for (const t of ['group_chat_epochs', 'group_chat_key_state', 'group_line_verdicts', 'group_line_signers']) expect(drops).toContain(`DROP TABLE IF EXISTS ${t};`);
        expect(groupKeyring('https://test.beanpool.org', who.me, G, memoryGroupKeyStore())).not.toBe(ring);
    });
});
