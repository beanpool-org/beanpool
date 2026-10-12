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
    /** When set, every read of the four group key tables throws, as a SQLite error would. */
    failGroupReads: false,
    /** The community file open: the group tables of any other community's file hold nothing for these groups. */
    openFile: 'beanpool_test.db',
    anchor: 'https://node.example',
    asyncStore: new Map<string, string>(),
    /** The type the fake node gives a group's conversation, when not group_thread. */
    nodeType: new Map<string, string>(),
}));
const groupTable = (sql: string) => /group_chat_epochs|group_chat_key_state|group_line_verdicts|group_line_signers/.test(sql);
const groupRead = (sql: string) => {
    if (!groupTable(sql)) return false;
    if (store.failGroupReads) throw new Error('SQLITE_IOERR: disk I/O error (simulated)');
    return store.openFile !== 'beanpool_test.db';
};
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
        if (groupRead(sql)) return null;
        if (/FROM conversations WHERE id = \?/.test(sql)) return store.conversations.get(params[0]) ?? null;
        if (/SELECT metadata FROM messages WHERE id/.test(sql)) return store.messages.get(params[0]) ?? null;
        if (/SELECT nonce, metadata FROM messages WHERE id/.test(sql)) return store.messages.get(params[0]) ?? null;
        if (/FROM group_chat_key_state/.test(sql)) return store.keyState.get(params[0]) ?? null;
        return null;
    }),
    getAllAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (groupRead(sql)) return [];
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
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation((name: string) => { store.openFile = name; return Promise.resolve(mockDb); }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? store.anchor : store.asyncStore.get(k) ?? null)),
        setItem: vi.fn(async (k: string, v: string) => { store.asyncStore.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.asyncStore.delete(k); }), getAllKeys: vi.fn(async () => []), multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/', getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined), writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
const who = vi.hoisted(() => ({ me: { publicKey: '', privateKey: '' } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...who.me, callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn((u: string | null) => (String(u).includes('other.example') ? 'beanpool_other.db' : 'beanpool_test.db')), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { insertMessage, postGroupChatMessage, editMessage, editThreadMessage, clearDB, groupKeyringFor, isHeldGroupChat, sendImageMessage, joinGroupApi, approveGroupMemberApi } from '../db';
import { GROUP_CHAT_LOCK_LOST_TEXT, groupChatNotice, GROUP_CHAT_OLD_NODE_NOTICE, GROUP_KEYS_FOR_DM_TEXT } from '../group-chat-lines';
import { forgetGroupKeys, GROUP_KEY_STORE_UNREAD_TEXT } from '../group-chat-keys';

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
const groups = Array.from({ length: 24 }, () => randomUUID());
let chatAnswer: 'unlocked' | 'refused' | 'locked' = 'unlocked';
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
    if (g && method === 'GET' && path.startsWith(`/api/groups/${g}/chat`)) {
        if (chatAnswer === 'locked') return reply(200, { messages: [], canPost: true, encryption: { current: 1, stale: false, fromEpoch: 1 } });
        return chatAnswer === 'unlocked' ? reply(200, { messages: [], canPost: true }) : reply(404, { error: 'Not found' });
    }
    if (g && method === 'GET' && path.startsWith(`/api/messages/${g}`)) return reply(200, { conversation: { id: g, type: store.nodeType.get(g) ?? 'group_thread', name: 'The group', participants: [who.me.publicKey, OTHER] }, messages: [] });
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
/** Every write that left the phone since `from`, in any form. */
const writes = (from: number) => received.slice(from).filter((r) => r.method === 'POST').map((r) => r.path);
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

describe('group chats: a key store that can\'t be read never counts as "never held" (confirmation 2 of #1788, finding 1)', () => {
    it('one failed read of the key tables: every send and edit refuses with the store sentence, nothing goes; once it reads again, same session, the group is held', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[12];
        held(g);
        store.failGroupReads = true;
        const from = received.length;
        const r: Record<string, string> = {};
        try {
            r.held = await tryIt(() => isHeldGroupChat(g));
            r.insert = await tryIt(() => insertMessage(g, who.me.publicKey, 'words while the read fails'));
            r.edit = await tryIt(() => editMessage(g, randomUUID(), 'an edit while the read fails'));
            r.screen = await tryIt(() => postGroupChatMessage(g, 'the screen while the read fails', randomUUID(), null, undefined));
            r.threadEdit = await tryIt(() => editThreadMessage(randomUUID(), 'a thread edit while the read fails', { groupId: g, metadata: { epoch: 2 }, locked: false }));
        } finally {
            store.failGroupReads = false;
        }
        const heldAfter = await isHeldGroupChat(g);
        const after = await tryIt(() => insertMessage(g, who.me.publicKey, 'words once it reads again'));
        await waitFor(() => readable(from).length > 0, 300);
        console.log(`store error: ${JSON.stringify(r)}; held once it reads again ${heldAfter}; then ${after}; writes ${JSON.stringify(writes(from))}`);
        for (const k of Object.keys(r)) expect(r[k]).toBe(`refused: ${GROUP_KEY_STORE_UNREAD_TEXT}`);
        expect(heldAfter).toBe(true);
        expect(after).toBe(`refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`);
        expect(writes(from)).toEqual([]);
        expect(readable(from)).toEqual([]);
    });

    it('a keyring whose first read runs after the phone switched community never reads the other community\'s file: it refuses, then reads its own once back', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[13];
        held(g);
        const ring = await groupKeyringFor(g);
        store.anchor = 'https://other.example';
        let during: string;
        try {
            during = await tryIt(async () => { if (!(await ring.seenLocked())) throw new Error('read as never held'); });
        } finally {
            store.anchor = 'https://node.example';
        }
        const after = await ring.seenLocked();
        console.log(`community switched under the keyring: ${during}; back on its own ${after}`);
        expect(during).toBe(`refused: ${GROUP_KEY_STORE_UNREAD_TEXT}`);
        expect(after).toBe(true);
    });
});

describe('group chats: a held group is never a DM, and a known DM never becomes held (confirmation 2 of #1788, finding 2)', () => {
    it('held AND a known DM (the node typed it dm once): the held guard is asked first; nothing goes DM-sealed to whoever the node lists', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[14];
        held(g);
        store.asyncStore.set('beanpool_dm_conversations_seen', JSON.stringify([g]));
        store.conversations.set(g, { id: g, type: 'dm', created_by: null });
        partsOf(g).add(who.me.publicKey); partsOf(g).add(OTHER);
        const from = received.length;
        let a: string;
        try {
            a = await tryIt(() => insertMessage(g, who.me.publicKey, 'words typed where the group was'));
            await waitFor(() => writes(from).length > 0, 300);
        } finally {
            store.asyncStore.delete('beanpool_dm_conversations_seen');
        }
        console.log(`held + known DM: ${a}; writes ${JSON.stringify(writes(from))}`);
        expect(a).toBe(`refused: ${GROUP_CHAT_LOCK_LOST_TEXT}`);
        expect(writes(from)).toEqual([]);
    });

    it('the node types a held group dm when the phone asks for it: its row stays group_thread and it is never remembered as a DM', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[15];
        held(g);
        store.nodeType.set(g, 'dm');
        const from = received.length;
        const a = await tryIt(() => sendImageMessage(g, 'data:image/jpeg;base64,/9j/AAAA', 'a caption'));
        const remembered = (JSON.parse(store.asyncStore.get('beanpool_dm_conversations_seen') ?? '[]') as string[]).includes(g);
        console.log(`node says dm: photo ${a}; row ${store.conversations.get(g)?.type}; remembered as a DM ${remembered}`);
        expect(store.conversations.get(g)?.type).toBe('group_thread');
        expect(remembered).toBe(false);
        expect(writes(from)).toEqual([]);
    });

    it('a known DM never becomes held: a group post, edit, join or approval under its id is refused before any key is asked; its own line goes DM-sealed', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const d = randomUUID();
        store.conversations.set(d, { id: d, type: 'dm', created_by: null });
        partsOf(d).add(who.me.publicKey); partsOf(d).add(OTHER);
        const from = received.length;
        const r: Record<string, string> = {};
        r.screenLocked = await tryIt(() => postGroupChatMessage(d, 'as a locked group line', randomUUID(), null, { after: null }));
        r.screenOldNode = await tryIt(() => postGroupChatMessage(d, 'as an old node\'s group line', randomUUID(), null, undefined));
        r.threadEdit = await tryIt(() => editThreadMessage(randomUUID(), 'as a group edit', { groupId: d, metadata: { epoch: 1 }, locked: true }));
        r.join = await tryIt(() => joinGroupApi(d, { joinPolicy: 'open' }));
        r.approve = await tryIt(() => approveGroupMemberApi(d, OTHER));
        const dm = await tryIt(() => insertMessage(d, who.me.publicKey, 'a DM line'));
        await waitFor(() => writes(from).length > 0, 1000);
        const groupRoutes = received.slice(from).filter((x) => x.path.includes(`/api/groups/${d}`)).map((x) => `${x.method} ${x.path}`);
        const sent = received.slice(from).filter((x) => x.method === 'POST').map((x) => `${x.path} ${String(x.body?.nonce ?? '').split(':')[0]}`);
        console.log(`known DM as a group: ${JSON.stringify(r)}; DM line ${dm}; group routes asked ${JSON.stringify(groupRoutes)}; sent ${JSON.stringify(sent)}`);
        for (const k of Object.keys(r)) expect(r[k]).toBe(`refused: ${GROUP_KEYS_FOR_DM_TEXT}`);
        expect(groupRoutes).toEqual([]);
        expect(sent).toEqual(['/api/messages/send x25519-xc20p-v2']);
        expect(await isHeldGroupChat(d)).toBe(false);
    });
});

describe('group chats: a phone that never held the keys sends readable words only on the node\'s own chat answer (confirmation 2 of #1788, finding 3)', () => {
    it('no row (a push tap before the sync), the node says group_thread and its chat is locked: nothing readable; the node is asked what it is, then its keys', async () => {
        forgetGroupKeys(); chatAnswer = 'locked';
        const g = groups[16];
        const from = received.length;
        const a = await tryIt(() => insertMessage(g, who.me.publicKey, 'a new member\'s first line'));
        await waitFor(() => readable(from).length > 0, 300);
        const asked = received.slice(from).map((r) => `${r.method} ${r.path.replace(g, 'G')}`);
        chatAnswer = 'unlocked';
        console.log(`never held, no row, chat locked: ${a}; asked ${JSON.stringify(asked)}; readable ${JSON.stringify(readable(from))}`);
        expect(a.startsWith('refused: ')).toBe(true);
        expect(readable(from)).toEqual([]);
        expect(asked.slice(0, 2)).toEqual(['GET /api/messages/G?limit=1', 'GET /api/groups/G/keys?after=0']);
    });

    it('the row or the node says event_thread or enterprise_thread, and the node\'s chat answer is locked or refused: "couldn\'t be locked", nothing readable', async () => {
        const r: Record<string, string> = {};
        const from = received.length;
        for (const [i, t] of [[17, 'event_thread'], [18, 'enterprise_thread']] as const) {
            forgetGroupKeys(); chatAnswer = 'locked';
            const g = groups[i];
            store.conversations.set(g, { id: g, type: t, created_by: null });
            r[`${t} row, chat locked`] = await tryIt(() => insertMessage(g, who.me.publicKey, `a line under ${t}`));
        }
        forgetGroupKeys(); chatAnswer = 'refused';
        const g = groups[19];
        store.nodeType.set(g, 'event_thread');
        r['event_thread from the node, chat 404'] = await tryIt(() => insertMessage(g, who.me.publicKey, 'a line the node typed event_thread'));
        chatAnswer = 'unlocked';
        await waitFor(() => readable(from).length > 0, 300);
        console.log(`never held, node-readable type: ${JSON.stringify(r)}; readable ${JSON.stringify(readable(from))}`);
        for (const k of Object.keys(r)) expect(r[k]).toBe("refused: This message couldn't be locked yet.");
        expect(readable(from)).toEqual([]);
    });

    it('as designed (§14.3): no row, an old node (keys 404, its chat answer has no encryption): the first line goes readable', async () => {
        forgetGroupKeys(); chatAnswer = 'unlocked';
        const g = groups[20];
        const from = received.length;
        const a = await tryIt(() => insertMessage(g, who.me.publicKey, 'an old node\'s line'));
        await waitFor(() => readable(from).length > 0);
        console.log(`never held, no row, old node: ${a}; readable ${JSON.stringify(readable(from))}`);
        expect(readable(from).length).toBe(1);
    });
});
