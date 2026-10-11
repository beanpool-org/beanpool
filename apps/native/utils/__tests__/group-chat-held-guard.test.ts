/**
 * Group chats on the phone: a group whose keys this phone has held is locked here for good, whatever the node or the
 * local row says (director's decision b). Every path that can post into its conversation id seals or refuses: the screen,
 * the conversation path with its row missing or under another type, an edit by either path, and a Force Resync keeps it
 * (director, NB3). Ported from the #1788 confirmation review's drivers (confirm-db), flipped to the refusals. Mock style
 * from group-chat-sticky-lock.test.ts: device modules stubbed, a stand-in for SQLite, and a fake node recording bodies.
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
    execs: [] as string[],
    keyState: new Map<string, { highest: number; after: number }>(),
}));
const partsOf = (id: string) => { if (!store.participants.has(id)) store.participants.set(id, new Set()); return store.participants.get(id)!; };
const mockDb = {
    execAsync: vi.fn(async (s: string) => {
        store.execs.push(s);
        // What SQLite does to the rows of a dropped table (initDB recreates it empty).
        if (/DROP TABLE IF EXISTS group_chat_key_state/.test(s)) store.keyState.clear();
        if (/DROP TABLE IF EXISTS conversations;/.test(s)) store.conversations.clear();
        if (/DROP TABLE IF EXISTS messages;/.test(s)) store.messages.clear();
        return undefined;
    }),
    closeAsync: vi.fn(async () => undefined),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    getFirstAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/FROM conversations WHERE id = \?/.test(sql)) return store.conversations.get(params[0]) ?? null;
        if (/SELECT metadata FROM messages WHERE id/.test(sql)) return store.messages.get(params[0]) ?? null;
        if (/SELECT nonce, metadata FROM messages WHERE id/.test(sql)) return store.messages.get(params[0]) ?? null;
        if (/FROM group_chat_key_state/.test(sql)) return store.keyState.get(params[0]) ?? null;
        return null;
    }),
    getAllAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/SELECT public_key FROM conversation_participants WHERE conversation_id = \?/.test(sql)) return [...partsOf(params[0])].map((public_key) => ({ public_key }));
        return [];
    }),
    runAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/^INSERT INTO messages/.test(sql)) store.messages.set(params[0], { id: params[0], conversation_id: params[1], author_pubkey: params[2], ciphertext: params[3], nonce: params[4], metadata: params[5] });
        if (/^INSERT OR IGNORE INTO conversations /.test(sql) && !store.conversations.has(params[0])) store.conversations.set(params[0], { id: params[0], type: params[1], created_by: params[4] ?? null });
        if (/^INSERT OR IGNORE INTO conversation_participants/.test(sql)) partsOf(params[0]).add(params[1]);
        return { changes: 1 };
    }),
};
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://node.example' : null)),
        setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []), multiRemove: vi.fn(async () => {}),
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

import { insertMessage, postGroupChatMessage, editMessage, editThreadMessage, clearDB, groupKeyringFor } from '../db';
import { GROUP_CHAT_LOCK_LOST_TEXT, groupChatNotice, GROUP_CHAT_OLD_NODE_NOTICE } from '../group-chat-lines';
import { forgetGroupKeys } from '../group-chat-keys';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

const seed = ed25519.utils.randomSecretKey();
who.me = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
const OTHER = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
/** Every group in this file is one this phone may have held keys of; the fake node answers each the same way. */
const groups = Array.from({ length: 12 }, () => randomUUID());
let chatAnswer: 'unlocked' | 'refused' = 'unlocked';
const received: { method: string; path: string; body: any }[] = [];
function reply(status: number, body: any) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } }; }
(globalThis as any).fetch = vi.fn(async (url: string, init: any = {}) => {
    const path = String(url).replace('https://node.example', '');
    const method = init.method ?? 'GET';
    let body: any; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    received.push({ method, path, body });
    const g = groups.find((x) => path.includes(x));
    // The node: no keys for this phone (an old node, or one refusing it: 404), its chat answer with no `encryption`.
    if (g && method === 'GET' && path.startsWith(`/api/groups/${g}/keys`)) return reply(404, { error: 'Not found' });
    if (g && method === 'GET' && path.startsWith(`/api/groups/${g}/chat`)) return chatAnswer === 'unlocked' ? reply(200, { messages: [], canPost: true }) : reply(404, { error: 'Not found' });
    if (g && method === 'GET' && path.startsWith(`/api/messages/${g}`)) return reply(200, { conversation: { id: g, type: 'group_thread', name: 'The group', participants: [who.me.publicKey, OTHER] }, messages: [] });
    if (method === 'POST' && path.endsWith('/chat/message')) return reply(201, { success: true, message: { id: body?.clientId } });
    if (method === 'POST' && path === '/api/messages/send') return reply(201, { success: true, message: { id: body?.id, timestamp: new Date().toISOString() } });
    if (method === 'POST' && path === '/api/messages/edit') return reply(200, { success: true, message: { editedAt: new Date().toISOString() } });
    return reply(404, { error: 'not here' });
});

const waitFor = async (pred: () => boolean, ms = 3000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); };
/** Everything readable that left the phone since `from`: `{ text }` to a chat, or plaintext-v1 to send or edit. */
const readable = (from: number) => received.slice(from).filter((r) => (r.path.endsWith('/chat/message') && typeof r.body?.text === 'string')
    || ((r.path === '/api/messages/send' || r.path === '/api/messages/edit') && r.body?.nonce === 'plaintext-v1'))
    .map((r) => `${r.path} ${r.body?.text ?? Buffer.from(String(r.body?.ciphertext ?? ''), 'base64').toString('utf8')}`);
/** This phone held a key of `g`: the highest epoch it verified is 2 (group_chat_key_state, kept per identity). */
const held = (g: string) => store.keyState.set(`${who.me.publicKey}/${g}`, { highest: 2, after: 2 });
const seen = async (g: string) => (await groupKeyringFor(g)).seenLocked();
const tryIt = async (f: () => Promise<unknown>) => { try { await f(); return 'went'; } catch (e: any) { return `refused: ${e?.message}`; } };

describe('group chats: a held group is locked whatever its row says', () => {
    it('as designed: a phone that never held a key sends an old node words it can read, by both paths, with the old-node notice (§14.3)', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[0];
        const from = received.length;
        await postGroupChatMessage(g, 'never held: screen path', randomUUID(), null, undefined);
        store.conversations.set(g, { id: g, type: 'group_thread', created_by: null });
        await insertMessage(g, who.me.publicKey, 'never held: conversation path').catch(() => null);
        await waitFor(() => readable(from).length >= 2);
        console.log('never held:', JSON.stringify(readable(from)), '| notice:', groupChatNotice({ nodeSaysLocked: false, seenLocked: await seen(g) }) === GROUP_CHAT_OLD_NODE_NOTICE ? 'old-node notice' : 'OTHER');
        expect(readable(from).length).toBe(2);
    });

    it('F4 closed: a phone that held a key sends nothing readable by the screen path or by the conversation path when its row says group_thread', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[1];
        held(g);
        store.conversations.set(g, { id: g, type: 'group_thread', created_by: null });
        const from = received.length;
        const a = await tryIt(() => postGroupChatMessage(g, 'held: screen path', randomUUID(), null, undefined));
        const b = await tryIt(() => insertMessage(g, who.me.publicKey, 'held: conversation path'));
        await waitFor(() => false, 200);
        console.log('held, row group_thread:', JSON.stringify([a, b]), '| readable sent:', JSON.stringify(readable(from)));
        expect([a, b]).toEqual([`refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`, `refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`]);
        expect(readable(from)).toEqual([]);
    });

    it('also: a new node that refuses this phone the keys and the chat (404 both) gets nothing readable, held or not', async () => {
        forgetGroupKeys(); chatAnswer = 'refused';
        const g = groups[2];
        store.conversations.set(g, { id: g, type: 'group_thread', created_by: null });
        const from = received.length;
        const a = await tryIt(() => insertMessage(g, who.me.publicKey, 'a removed member\'s line'));
        await waitFor(() => false, 200);
        chatAnswer = 'unlocked';
        console.log('removed member:', a, '| readable sent:', JSON.stringify(readable(from)));
        expect(readable(from)).toEqual([]);
    });

    it('held, no conversations row (pruned by a sync, or a push before one): the conversation path refuses', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[3];
        held(g);
        store.conversations.delete(g);
        const held1 = await seen(g);
        const from = received.length;
        const a = await tryIt(() => insertMessage(g, who.me.publicKey, 'first line from the DM screen'));
        await waitFor(() => readable(from).length > 0);
        const asked = received.slice(from).map((r) => `${r.method} ${r.path.replace(g, 'G')}`);
        console.log(`GAP row missing: seenLocked ${held1}; insertMessage ${a}; requests ${JSON.stringify(asked)}; readable sent ${JSON.stringify(readable(from))}`);
        expect(held1).toBe(true);
        expect(a).toBe(`refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`);
        expect(readable(from)).toEqual([]);
    });

    it('held, no row: the conversation path\'s edit (editMessage) refuses', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[4];
        held(g);
        store.conversations.delete(g);
        const id = randomUUID();
        const from = received.length;
        const a = await tryIt(() => editMessage(g, id, 'an edit from the DM screen'));
        console.log(`GAP edit, row missing: ${a}; readable sent ${JSON.stringify(readable(from))}`);
        expect(a).toBe(`refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`);
        expect(readable(from)).toEqual([]);
    });

    it('held, the row re-supplied as event_thread: refused', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[5];
        held(g);
        store.conversations.set(g, { id: g, type: 'event_thread', created_by: null });
        const from = received.length;
        const a = await tryIt(() => insertMessage(g, who.me.publicKey, 'a group line under an event label'));
        await waitFor(() => readable(from).length > 0, 300);
        console.log(`GAP row event_thread: ${a}; readable sent ${JSON.stringify(readable(from))}`);
        expect(a).toBe(`refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`);
        expect(readable(from)).toEqual([]);
    });

    it('held: editThreadMessage seals or refuses even when the screen says unlocked', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[6];
        held(g);
        const from = received.length;
        const a = await tryIt(() => editThreadMessage(randomUUID(), 'edit with no sealed argument', { groupId: g, metadata: { epoch: 2 }, locked: false }));
        console.log(`editThreadMessage(…, undefined) for a held group: ${a}; seenLocked ${await seen(g)}; readable sent ${JSON.stringify(readable(from))}`);
        expect(a.startsWith('refused: ')).toBe(true);
        expect(readable(from)).toEqual([]);
    });

    it('Force Resync (clearDB + initDB, the identity kept) keeps the sticky lock and the highest epoch', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[7];
        held(g);
        const before = await tryIt(() => postGroupChatMessage(g, 'before the resync', randomUUID(), null, undefined));
        const seenBefore = await seen(g);
        store.execs.length = 0;
        await clearDB();
        const drops = store.execs.filter((s) => /DROP TABLE/.test(s)).join(' ');
        const seenAfter = await seen(g);
        const from = received.length;
        const after = await tryIt(() => postGroupChatMessage(g, 'after the resync', randomUUID(), null, undefined));
        const notice = groupChatNotice({ nodeSaysLocked: false, seenLocked: seenAfter });
        console.log(`Force Resync: before "${before}" (seenLocked ${seenBefore}); clearDB dropped group_chat_key_state: ${drops.includes('group_chat_key_state')}; seenLocked after ${seenAfter}; after "${after}"; readable sent ${JSON.stringify(readable(from))}; the notice now: ${notice === GROUP_CHAT_OLD_NODE_NOTICE ? 'the old-node notice (the node can read it)' : notice}`);
        expect(before).toBe(`refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`);
        expect(drops.includes('group_chat_key_state')).toBe(false);
        expect(seenAfter).toBe(true);
        expect(after).toBe(`refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`);
        expect(readable(from)).toEqual([]);
    });

    it('Sign Out (clearDB identityLeaves: the identity leaves this phone) forgets it, as a new phone starts', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[8];
        held(g);
        expect(await seen(g)).toBe(true);
        store.execs.length = 0;
        await clearDB({ identityLeaves: true });
        const drops = store.execs.filter((s) => /DROP TABLE/.test(s)).join(' ');
        expect(drops).toContain('DROP TABLE IF EXISTS group_chat_key_state;');
        expect(await seen(g)).toBe(false);
    });
});
