/**
 * Group chats on the phone: a DM and a group are never one conversation because of how a link, a push or the node spells
 * the id (#1841 review, findings 1 and 3). The node makes ids lower-case; a dishonest one can send them in capitals. The
 * DM guard folds case as the held check, the keyring and the group screens do, so a known DM in any spelling gets no
 * group keys and stays DM-sealed; the group screen opens its keys only through the DM guard; and a held group's lines
 * are signed and routed under the group's own id, however the caller spelled it. Ported from the review's driver (K1,
 * K2, K3, K6; scratch/reviews/opus-1841-scripts/zz-review-1841-db.test.ts), its measurements flipped to assertions.
 * Mock style from group-chat-held-guard.test.ts: device modules stubbed, a stand-in for SQLite (its `id IN (…)` lookups
 * match each spelling exactly, as SQLite's index does), and a fake node that keeps a posted epoch and matches ids however
 * spelled.
 */
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import Module from 'node:module';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

type EpochRow = { epoch: number; record: string; wrap: string | null };
const store = vi.hoisted(() => ({
    conversations: new Map<string, { id: string; type: string; created_by: string | null }>(),
    participants: new Map<string, Set<string>>(),
    messages: new Map<string, any>(),
    keyState: new Map<string, { highest: number; after: number }>(),
    epochs: new Map<string, EpochRow[]>(),
    asyncStore: new Map<string, string>([['beanpool_anchor_url', 'https://node.example']]),
}));
const partsOf = (id: string) => { if (!store.participants.has(id)) store.participants.set(id, new Set()); return store.participants.get(id)!; };
/**
 * Rows an `id IN (…)` lookup matches, in the order SQLite answers them: BINARY order, so upper case first (its index visits
 * the IN list sorted), with the id an `ORDER BY id = ? DESC` asks for first (#1863 review, finding 4).
 */
const inSqliteOrder = <T>(rows: T[], idOf: (r: T) => string, first?: unknown) =>
    [...rows].sort((a, b) => Number(idOf(b) === first) - Number(idOf(a) === first) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
/** The rows whose id matches `id` with ASCII case folded, as SQLite's NOCASE compares. */
const convsNoCase = (id: string) => [...store.conversations.values()].filter((c) => c.id.toLowerCase() === String(id).toLowerCase());
const mockDb = {
    execAsync: vi.fn(async () => undefined),
    closeAsync: vi.fn(async () => undefined),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    getFirstAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/FROM group_chat_key_state/.test(sql)) return store.keyState.get(params[0]) ?? null;
        if (/FROM group_chat_epochs WHERE group_id = \? AND wrap IS NOT NULL/.test(sql)) return (store.epochs.get(params[0]) ?? []).some((e) => e.wrap) ? { y: 1 } : null;
        if (/SELECT id FROM conversations WHERE id IN \(/.test(sql)) {
            const first = /ORDER BY id = \? DESC/.test(sql) ? params[params.length - 1] : undefined;
            const ids = first === undefined ? params : params.slice(0, -1);
            return inSqliteOrder(ids.map((p) => store.conversations.get(p)).filter((c) => c?.type === 'dm'), (c) => c!.id, first)[0] ?? null;
        }
        if (/FROM conversations WHERE id = \? COLLATE NOCASE AND type = 'dm'/.test(sql)) return convsNoCase(params[0]).find((c) => c.type === 'dm') ?? null;
        if (/FROM conversations WHERE id = \?/.test(sql)) return store.conversations.get(params[0]) ?? null;
        if (/SELECT conversation_id FROM messages WHERE conversation_id IN \(/.test(sql)) {
            const first = /ORDER BY conversation_id = \? DESC/.test(sql) ? params[params.length - 1] : undefined;
            const ps = first === undefined ? params : params.slice(0, -1);
            const ids = ps.slice(0, -1);
            const prefix = String(ps[ps.length - 1]).replace(/%$/, '');
            const m = inSqliteOrder([...store.messages.values()].filter((x) => ids.includes(x.conversation_id) && String(x.nonce).startsWith(prefix)), (x) => x.conversation_id, first)[0];
            return m ? { conversation_id: m.conversation_id } : null;
        }
        if (/SELECT 1 AS y FROM messages WHERE conversation_id IN \(/.test(sql)) {
            const ids = params.slice(0, -1);
            const prefix = String(params[params.length - 1]).replace(/%$/, '');
            return [...store.messages.values()].some((m) => ids.includes(m.conversation_id) && String(m.nonce).startsWith(prefix)) ? { y: 1 } : null;
        }
        if (/SELECT metadata FROM messages WHERE id/.test(sql)) return store.messages.get(params[0]) ?? null;
        if (/SELECT nonce, metadata FROM messages WHERE id/.test(sql)) return store.messages.get(params[0]) ?? null;
        return null;
    }),
    getAllAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/SELECT id FROM conversations WHERE id = \? COLLATE NOCASE/.test(sql)) return convsNoCase(params[0]).map((c) => ({ id: c.id }));
        if (/FROM group_chat_epochs WHERE group_id = \?/.test(sql)) return store.epochs.get(params[0]) ?? [];
        if (/SELECT public_key FROM conversation_participants WHERE conversation_id = \?/.test(sql)) return [...partsOf(params[0])].map((public_key) => ({ public_key }));
        return [];
    }),
    runAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/^INSERT INTO messages/.test(sql)) store.messages.set(params[0], { id: params[0], conversation_id: params[1], author_pubkey: params[2], ciphertext: params[3], nonce: params[4], metadata: params[5] });
        if (/^DELETE FROM messages WHERE id = \?/.test(sql)) store.messages.delete(params[0]);
        if (/^INSERT OR IGNORE INTO conversations /.test(sql) && !store.conversations.has(params[0])) store.conversations.set(params[0], { id: params[0], type: params[1], created_by: params[4] ?? null });
        if (/^INSERT OR IGNORE INTO conversation_participants/.test(sql)) partsOf(params[0]).add(params[1]);
        if (/INSERT OR REPLACE INTO group_chat_epochs/.test(sql)) {
            const rows = (store.epochs.get(params[0]) ?? []).filter((e) => e.epoch !== params[1]);
            rows.push({ epoch: params[1], record: params[2], wrap: params[3] });
            store.epochs.set(params[0], rows.sort((a, b) => a.epoch - b.epoch));
        }
        if (/INSERT INTO group_chat_key_state \(group_id, after\)/.test(sql)) { const s = store.keyState.get(params[0]) ?? { highest: 0, after: 0 }; s.after = Math.max(s.after, params[1]); store.keyState.set(params[0], s); }
        if (/INSERT INTO group_chat_key_state \(group_id, highest\)/.test(sql)) { const s = store.keyState.get(params[0]) ?? { highest: 0, after: 0 }; s.highest = Math.max(s.highest, params[1]); store.keyState.set(params[0], s); }
        if (/UPDATE group_chat_epochs SET wrap = NULL/.test(sql)) for (const e of store.epochs.get(params[0]) ?? []) if (e.epoch === params[1]) e.wrap = null;
        return { changes: 1 };
    }),
};
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => mockDb) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.asyncStore.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.asyncStore.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.asyncStore.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.asyncStore.keys()]), multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array((require('node:crypto') as typeof import('node:crypto')).randomBytes(n)) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/', getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined), writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
const who = vi.hoisted(() => ({ me: { publicKey: '', privateKey: '' } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...who.me, callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(() => 'beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import {
    insertMessage, postGroupChatMessage, editThreadMessage, groupKeyringFor, groupScreenKeyringFor, isHeldGroupChat,
    isKnownDmConversation, knownDmConversationId, getConversationKind, joinGroupApi, approveGroupMemberApi, leaveGroupApi,
    proposeGroupDecision, createPost, updateGroupApi, _resetDmPeerPinsForTests,
} from '../db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { dmConversationsSeenStoreKey, dmPeerPinsStoreKey } from '../storage-keys';
import { GROUP_KEYS_FOR_DM_TEXT } from '../group-chat-lines';
import { forgetGroupKeys } from '../group-chat-keys';
import { openMyKey, openLine } from '../group-chat-crypto';
import { V2_NONCE_PREFIX } from '../e2e-crypto';
import { routeChat, type ChatRouteAsks } from '../chat-route';
import { makeGroupEpochRecord } from '@beanpool/core';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

const mkId = () => { const s = ed25519.utils.randomSecretKey(); return { publicKey: bytesToHex(ed25519.getPublicKey(s)), privateKey: bytesToHex(s) }; };
const ME = mkId();
who.me = ME;
/** Bob: the other person in the DM. */
const OTHER = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
/** A key of the node's own, shown as a member of the "group" it serves under a DM's id. */
const PUPPET = mkId();
/** The DM guard's list for this account in the one community file these cases open (§3.4 amendment 7 §3: one per file). */
const DM_SEEN = dmConversationsSeenStoreKey(ME.publicKey, 'beanpool_test.db');
/** ChatRoute's asks, wired to the real utils/db.ts as app/chat/[id].tsx wires them. */
const ASKS: ChatRouteAsks = { isHeldGroupChat, knownDmConversationId, getConversationKind };

/** How the fake node answers each group (matched by id in any spelling, as a dishonest node would). */
interface NodeView {
    keys: { current: number | null; roster: string[]; epochs: any[]; myWraps: any[] };
    /** A posted epoch becomes the node's current (served back with my wrap). */
    serveWhatIsPosted?: boolean;
}
const views = new Map<string, NodeView>();
const posted: { path: string; rec: any }[] = [];
const received: { method: string; path: string; body: any }[] = [];
function reply(status: number, body: any) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } }; }
(globalThis as any).fetch = vi.fn(async (url: string, init: any = {}) => {
    const path = String(url).replace(/^https:\/\/[a-z.]+/, '');
    const method = init.method ?? 'GET';
    let body: any; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    received.push({ method, path, body });
    const g = /\/api\/(?:groups|messages)\/([0-9a-fA-F-]{36})/.exec(path)?.[1];
    const v = g ? views.get(g.toLowerCase()) : undefined;
    const lp = path.toLowerCase();
    const lg = g?.toLowerCase();
    if (g && v && method === 'GET' && lp.startsWith(`/api/groups/${lg}/keys/missing`)) return reply(200, { missing: [] });
    if (g && v && method === 'GET' && lp.startsWith(`/api/groups/${lg}/keys`)) {
        return reply(200, { current: v.keys.current, stale: false, fromEpoch: v.keys.current === null ? null : 1, roster: v.keys.roster, epochs: v.keys.epochs, myWraps: v.keys.myWraps, more: false });
    }
    if (g && v && method === 'GET' && lp.startsWith(`/api/groups/${lg}/members`)) {
        return reply(200, v.keys.roster.map((memberPubkey) => ({ memberPubkey, status: 'active', role: 'member' })));
    }
    if (g && v && method === 'POST' && lp.startsWith(`/api/groups/${lg}/keys/epoch`)) {
        const rec = body?.epoch;
        posted.push({ path, rec });
        if (rec && v.serveWhatIsPosted) {
            const mine = (rec.wraps ?? []).find((w: any) => w.recipient === who.me.publicKey);
            const { wraps: _w, groupId: _g, ...header } = rec;
            v.keys = { current: rec.epoch, roster: v.keys.roster, epochs: [header], myWraps: mine ? [{ epoch: rec.epoch, wrapper: rec.createdBy, ephPub: mine.ephPub, nonce: mine.nonce, wrapped: mine.wrapped, sig: null }] : [] };
        }
        return reply(201, { success: true });
    }
    if (g && v && method === 'GET' && lp.startsWith(`/api/groups/${lg}/chat`)) return reply(200, { messages: [], canPost: true, encryption: { current: v.keys.current, stale: false, fromEpoch: 1 } });
    if (g && v && method === 'GET' && lp.startsWith(`/api/messages/${lg}`)) {
        return reply(200, { conversation: { id: g, type: 'group_thread', name: 'The group', participants: [who.me.publicKey, OTHER] }, messages: [] });
    }
    if (g && v && method === 'POST' && (lp === `/api/groups/${lg}/join` || lp === `/api/groups/${lg}/members`)) return reply(200, { success: true });
    if (g && v && method === 'DELETE' && lp.startsWith(`/api/groups/${lg}/members/`)) return reply(200, { success: true });
    if (method === 'POST' && lp.endsWith('/chat/message')) return reply(201, { success: true, message: { id: body?.clientId } });
    if (method === 'POST' && path === '/api/messages/send') return reply(201, { success: true, message: { id: body?.id, timestamp: new Date().toISOString() } });
    if (method === 'POST' && path === '/api/messages/edit') return reply(200, { success: true, message: { editedAt: new Date().toISOString() } });
    return reply(404, { error: 'not here' });
});

const waitFor = async (pred: () => boolean, ms = 3000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); };
const tryIt = async (f: () => Promise<unknown>) => { try { await f(); return 'went'; } catch (e: any) { return `refused: ${e?.message}`; } };
const fresh = () => { forgetGroupKeys(); store.asyncStore.delete(DM_SEEN); };
const dmListHas = (id: string) => (JSON.parse(store.asyncStore.get(DM_SEEN) ?? '[]') as string[]).some((x) => x.toLowerCase() === id.toLowerCase());
/** Every group write that left the phone since `from`: an epoch, or a line to a group's chat. */
const groupWrites = (from: number) => received.slice(from).filter((r) => r.method === 'POST' && /\/api\/groups\//.test(r.path)).map((r) => r.path);
/** This phone's group key rows for `g` (as kept: lower-case), and its highest epoch. */
const rowsFor = (g: string) => ({ highest: store.keyState.get(`${ME.publicKey}/${g.toLowerCase()}`)?.highest ?? 0, epochs: (store.epochs.get(`${ME.publicKey}/${g.toLowerCase()}`) ?? []).length });

/** A real epoch record of `g` made by `maker` to `recipients`, its group key, and how the node serves it to me. */
function epochWithKey(g: string, epoch: number, recipients: string[], maker = ME) {
    const { record, groupKey } = makeGroupEpochRecord({ myEdPrivHex: maker.privateKey, groupId: g, epoch, reason: epoch === 1 ? 'start' : 'rotate', subject: null, createdAt: new Date().toISOString(), recipients });
    const mine = record.wraps!.find((w) => w.recipient === ME.publicKey)!;
    const { wraps: _all, groupId: _g, ...header } = record;
    const wrap = { epoch, wrapper: maker.publicKey, ephPub: mine.ephPub, nonce: mine.nonce, wrapped: mine.wrapped, sig: null };
    return { groupKey, header, wrap, stored: { epoch, record: JSON.stringify({ ...header, groupId: g }), wrap: JSON.stringify(wrap) } };
}
/** The puppet's key for an epoch record the phone posted, if the phone wrapped one to it. */
function puppetKeyOf(rec: any): Uint8Array | null {
    const w = (rec?.wraps ?? []).find((x: any) => x.recipient === PUPPET.publicKey);
    if (!w) return null;
    try { return openMyKey(rec, { epoch: rec.epoch, wrapper: rec.createdBy, ephPub: w.ephPub, nonce: w.nonce, wrapped: w.wrapped, sig: null } as any, PUPPET.privateKey, rec.groupId); } catch { return null; }
}
/** The id among `ids` a sealed line opens under with `key` (its signed context), and its words; null if none. */
function opensUnder(line: { ciphertext: string; nonce: string; messageId: string; epoch: number; part?: 'body' | 'edit'; replyToId?: string | null }, key: Uint8Array | null, ids: string[]): { id: string; text: string } | null {
    if (!key) return null;
    for (const id of ids) {
        try { const o = openLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { groupId: id, epoch: line.epoch, senderPubHex: ME.publicKey, messageId: line.messageId, part: line.part ?? 'body', replyToId: line.replyToId ?? null }, key); return { id, text: o.text }; } catch { /* the next id */ }
    }
    return null;
}
/** The first POST since `from` that `pred` picks, as a sealed line. */
const sentLine = (from: number, pred: (r: { method: string; path: string; body: any }) => boolean) => {
    const r = received.slice(from).find((x) => x.method === 'POST' && pred(x));
    if (!r) return null;
    const md = typeof r.body?.metadata === 'string' ? JSON.parse(r.body.metadata) : r.body?.metadata;
    return { path: r.path, conversationId: r.body?.conversationId ?? null, ciphertext: r.body?.ciphertext, nonce: String(r.body?.nonce ?? ''), messageId: r.body?.id ?? r.body?.clientId ?? r.body?.messageId, epoch: md?.epoch };
};
/** The DM screen's send to `conversationId`: what went to /api/messages/send, and whether PUPPET can read it. */
async function dmSend(conversationId: string, text: string, puppetKeys: (Uint8Array | null)[]) {
    const from = received.length;
    const result = await tryIt(() => insertMessage(conversationId, ME.publicKey, text));
    await waitFor(() => !!sentLine(from, (x) => x.path === '/api/messages/send'));
    const s = sentLine(from, (x) => x.path === '/api/messages/send');
    const madeRec = posted.map((p) => p.rec).find((x) => x?.epoch === s?.epoch && String(x?.groupId).toLowerCase() === conversationId.toLowerCase());
    const keys = [...puppetKeys, puppetKeyOf(madeRec)];
    const read = s && !s.nonce.startsWith(V2_NONCE_PREFIX) ? keys.map((k) => opensUnder(s, k, [conversationId, conversationId.toLowerCase(), conversationId.toUpperCase()])).find(Boolean) : null;
    return { result, sealedForTheDm: !!s && s.nonce.startsWith(V2_NONCE_PREFIX), puppetReads: read?.text ?? null };
}

describe('a known DM in any spelling gets no group keys, and stays DM-sealed (#1841 review, finding 1)', () => {
    it('K6 an honest DM (lower-case): a push for its id in capitals with group=1 draws the DM screen; a group screen on its id is refused its keys; Bob\'s words stay DM-sealed', async () => {
        fresh();
        const d0 = randomUUID();
        const D0 = d0.toUpperCase();
        store.conversations.set(d0, { id: d0, type: 'dm', created_by: null });
        partsOf(d0).add(ME.publicKey); partsOf(d0).add(OTHER);
        store.asyncStore.set(DM_SEEN, JSON.stringify([d0]));
        // The node serves the DM's id as a group whose epoch 1 its own member made to [me, Bob, PUPPET].
        const e1 = epochWithKey(d0, 1, [ME.publicKey, OTHER, PUPPET.publicKey], PUPPET);
        views.set(d0, { keys: { current: 1, roster: [ME.publicKey, OTHER, PUPPET.publicKey], epochs: [e1.header], myWraps: [e1.wrap] } });
        const from = received.length;

        expect(await routeChat(ASKS, d0, {})).toEqual({ view: 'dm', screenId: d0 });
        // The push (push-notice-check matches ids in capitals): /chat/<D0>?group=1.
        expect(await isKnownDmConversation(D0)).toBe(true);
        expect((await routeChat(ASKS, D0, { thread: 'group' })).view).toBe('dm');
        // Were a group screen drawn on the DM's id anyway, its open is refused before any key is synced.
        expect(await tryIt(async () => { await (await groupScreenKeyringFor(D0.toLowerCase())).sync(); })).toBe(`refused: ${GROUP_KEYS_FOR_DM_TEXT}`);
        expect(await tryIt(() => postGroupChatMessage(d0, 'K6 group screen post', randomUUID(), null, { after: null }))).toBe(`refused: ${GROUP_KEYS_FOR_DM_TEXT}`);
        expect(await isHeldGroupChat(d0)).toBe(false);
        expect(rowsFor(d0)).toEqual({ highest: 0, epochs: 0 });
        expect((await routeChat(ASKS, d0, {})).view).toBe('dm');

        const sent = await dmSend(d0, 'K6 the words meant for Bob alone', [e1.groupKey]);
        expect(sent).toEqual({ result: 'went', sealedForTheDm: true, puppetReads: null });
        expect(groupWrites(from)).toEqual([]);
    });

    it('K2 a known DM the node minted in capitals: a post in its lower-case twin is refused, the DM never becomes held, and its words stay DM-sealed', async () => {
        fresh();
        const d = randomUUID();
        const D = d.toUpperCase();
        store.conversations.set(D, { id: D, type: 'dm', created_by: null });
        partsOf(D).add(ME.publicKey); partsOf(D).add(OTHER);
        store.asyncStore.set(DM_SEEN, JSON.stringify([D]));
        views.set(d, { keys: { current: null, roster: [ME.publicKey, OTHER, PUPPET.publicKey], epochs: [], myWraps: [] }, serveWhatIsPosted: true });
        const from = received.length;

        expect(await isKnownDmConversation(D)).toBe(true);
        expect(await isKnownDmConversation(d)).toBe(true);
        // A push for the twin: /chat/<d>?group=1.
        expect((await routeChat(ASKS, d, { thread: 'group' })).view).toBe('dm');
        expect(await tryIt(() => postGroupChatMessage(D, 'K2 direct post under D', randomUUID(), null, { after: null }))).toBe(`refused: ${GROUP_KEYS_FOR_DM_TEXT}`);
        expect(await tryIt(() => postGroupChatMessage(d, 'K2 hello, group', randomUUID(), null, { after: null }))).toBe(`refused: ${GROUP_KEYS_FOR_DM_TEXT}`);
        expect(await isHeldGroupChat(D)).toBe(false);
        expect(rowsFor(d)).toEqual({ highest: 0, epochs: 0 });
        expect((await routeChat(ASKS, D, {})).view).toBe('dm');

        const sent = await dmSend(D, 'K2 the words meant for Bob alone', []);
        expect(sent).toEqual({ result: 'went', sealedForTheDm: true, puppetReads: null });
        expect(groupWrites(from)).toEqual([]);
        expect(posted.filter((p) => p.path.toLowerCase().includes(d))).toEqual([]);
    });

    it('K3 a known DM the node minted in capitals: only opening its lower-case twin\'s group screen (its key sync) is refused, and the DM never becomes held', async () => {
        fresh();
        const d = randomUUID();
        const D = d.toUpperCase();
        store.conversations.set(D, { id: D, type: 'dm', created_by: null });
        partsOf(D).add(ME.publicKey); partsOf(D).add(OTHER);
        store.asyncStore.set(DM_SEEN, JSON.stringify([D]));
        const e1 = epochWithKey(d, 1, [ME.publicKey, OTHER, PUPPET.publicKey], PUPPET);
        views.set(d, { keys: { current: 1, roster: [ME.publicKey, OTHER, PUPPET.publicKey], epochs: [e1.header], myWraps: [e1.wrap] } });
        const from = received.length;

        expect(await isHeldGroupChat(D)).toBe(false);
        // GroupChatView's open: the screen's keyring, then its sync.
        expect(await tryIt(async () => { await (await groupScreenKeyringFor(d)).sync(); })).toBe(`refused: ${GROUP_KEYS_FOR_DM_TEXT}`);
        expect(await isHeldGroupChat(D)).toBe(false);
        expect(rowsFor(d)).toEqual({ highest: 0, epochs: 0 });
        expect((await routeChat(ASKS, D, {})).view).toBe('dm');

        const sent = await dmSend(D, 'K3 the words meant for Bob alone', [e1.groupKey]);
        expect(sent).toEqual({ result: 'went', sealedForTheDm: true, puppetReads: null });
        expect(groupWrites(from)).toEqual([]);
    });

    it('a DM known only by the DM list (the node dropped its row), or only by its dm row (not listed), under another spelling is still a known DM', async () => {
        fresh();
        const listed = randomUUID();
        store.asyncStore.set(DM_SEEN, JSON.stringify([listed.toUpperCase()]));
        expect(store.conversations.has(listed) || store.conversations.has(listed.toUpperCase())).toBe(false);
        expect(await isKnownDmConversation(listed)).toBe(true);
        const rowOnly = randomUUID();
        store.conversations.set(rowOnly.toUpperCase(), { id: rowOnly.toUpperCase(), type: 'dm', created_by: null });
        expect(await isKnownDmConversation(rowOnly)).toBe(true);
        expect(dmListHas(rowOnly)).toBe(false);
        const groupRow = randomUUID();
        store.conversations.set(groupRow, { id: groupRow, type: 'group_thread', created_by: null });
        expect(await isKnownDmConversation(groupRow.toUpperCase())).toBe(false);
    });

    it('a known DM only by an encrypted line under another spelling (no list entry, no dm row) is still a known DM', async () => {
        fresh();
        const d = randomUUID();
        const D = d.toUpperCase();
        store.conversations.set(D, { id: D, type: 'group_thread', created_by: null });
        store.messages.set(randomUUID(), { id: 'x', conversation_id: D, nonce: `${V2_NONCE_PREFIX}abc`, metadata: null });
        expect(await isKnownDmConversation(d)).toBe(true);
        expect(await isKnownDmConversation(D)).toBe(true);
        const other = randomUUID();
        store.conversations.set(other, { id: other, type: 'group_thread', created_by: null });
        expect(await isKnownDmConversation(other.toUpperCase())).toBe(false);
    });
});

describe('a known DM is one conversation whatever a link\'s case (#1841 confirmation 1, C3 and C4)', () => {
    it('C4 a DM the node minted in capitals, opened from the Inbox: routing asks the node nothing and writes no second row under the lower-case spelling', async () => {
        fresh();
        const d = randomUUID();
        const D = d.toUpperCase();
        store.conversations.set(D, { id: D, type: 'dm', created_by: null });
        partsOf(D).add(ME.publicKey); partsOf(D).add(OTHER);
        store.asyncStore.set(DM_SEEN, JSON.stringify([D]));
        // A node that would answer the lower-case spelling as a group of its own.
        views.set(d, { keys: { current: null, roster: [ME.publicKey, PUPPET.publicKey], epochs: [], myWraps: [] } });
        const from = received.length;

        expect(await routeChat(ASKS, D, {})).toEqual({ view: 'dm', screenId: D });
        expect(received.slice(from)).toEqual([]);
        expect(store.conversations.has(d)).toBe(false);
        expect(store.participants.get(d)?.size ?? 0).toBe(0);
    });

    it('C3 an honest DM (lower-case): a push for its id in capitals opens the DM screen on the conversation the phone has, with or without group=1', async () => {
        fresh();
        const d0 = randomUUID();
        const D0 = d0.toUpperCase();
        store.conversations.set(d0, { id: d0, type: 'dm', created_by: null });
        partsOf(d0).add(ME.publicKey); partsOf(d0).add(OTHER);
        store.asyncStore.set(DM_SEEN, JSON.stringify([d0]));
        const from = received.length;

        expect(await routeChat(ASKS, D0, {})).toEqual({ view: 'dm', screenId: d0 });
        expect(await routeChat(ASKS, D0, { thread: 'group' })).toEqual({ view: 'dm', screenId: d0 });
        expect(received.slice(from)).toEqual([]);
        expect(store.conversations.has(D0)).toBe(false);
        // Known by its dm row alone (not listed) or by an encrypted line alone: the same spelling comes back.
        store.asyncStore.delete(DM_SEEN);
        expect(await knownDmConversationId(D0)).toBe(d0);
        const lineOnly = randomUUID();
        store.messages.set(randomUUID(), { id: randomUUID(), conversation_id: lineOnly, nonce: `${V2_NONCE_PREFIX}abc`, metadata: null });
        expect(await knownDmConversationId(lineOnly.toUpperCase())).toBe(lineOnly);
        expect(await knownDmConversationId(randomUUID().toUpperCase())).toBe(null);
    });

    it('a DM and a twin the node wrote under its id in capitals: each spelling asked answers itself, whatever order the DM list or SQLite gives (#1863 review, finding 1)', async () => {
        fresh();
        const d = randomUUID();
        const D = d.toUpperCase();
        for (const id of [d, D]) { store.conversations.set(id, { id, type: 'dm', created_by: null }); partsOf(id).add(ME.publicKey); }
        partsOf(d).add(OTHER); partsOf(D).add(PUPPET.publicKey);
        // No list: SQLite answers the IN lookup upper case first.
        expect(await knownDmConversationId(d)).toBe(d);
        expect(await knownDmConversationId(D)).toBe(D);
        // A fresh list fills in the node's listing order, the twin first.
        store.asyncStore.set(DM_SEEN, JSON.stringify([D, d]));
        expect(await knownDmConversationId(d)).toBe(d);
        expect(await routeChat(ASKS, d, {})).toEqual({ view: 'dm', screenId: d });
        // Known only by sealed lines, kept under both spellings.
        store.asyncStore.delete(DM_SEEN);
        const e = randomUUID();
        const E = e.toUpperCase();
        for (const id of [E, e]) store.messages.set(randomUUID(), { id: randomUUID(), conversation_id: id, nonce: `${V2_NONCE_PREFIX}abc`, metadata: null });
        expect(await knownDmConversationId(e)).toBe(e);
        expect(await knownDmConversationId(E)).toBe(E);
    });
});

describe('a held group\'s lines are signed and routed under the group\'s own id, however the caller spells it (#1841 review, finding 3)', () => {
    it('K1 a held group (epoch 1 held, the node serving its keys) written to under its id in capitals: the DM-screen send, the group-screen send and the edit open under the group\'s id; no new epoch', async () => {
        fresh();
        const g = randomUUID();
        const G = g.toUpperCase();
        const e1 = epochWithKey(g, 1, [ME.publicKey, OTHER]);
        views.set(g, { keys: { current: 1, roster: [ME.publicKey, OTHER], epochs: [e1.header], myWraps: [e1.wrap] } });
        store.keyState.set(`${ME.publicKey}/${g}`, { highest: 1, after: 1 });
        store.epochs.set(`${ME.publicKey}/${g}`, [e1.stored]);
        const postedBefore = posted.length;
        for (const spelling of [g, G]) {
            let from = received.length;
            expect(await tryIt(() => insertMessage(spelling, ME.publicKey, `K1 DM-screen send, ${spelling}`))).toBe('went');
            await waitFor(() => !!sentLine(from, (r) => r.path === '/api/messages/send'));
            const s = sentLine(from, (r) => r.path === '/api/messages/send');
            expect(s?.nonce.startsWith('group-')).toBe(true);
            expect(s?.epoch).toBe(1);
            expect(opensUnder(s!, e1.groupKey, [g, G])?.id).toBe(g);

            from = received.length;
            const cid = randomUUID();
            expect(await tryIt(() => postGroupChatMessage(spelling, `K1 group-screen send, ${spelling}`, cid, null, { after: null }))).toBe('went');
            const c = sentLine(from, (r) => r.path.endsWith('/chat/message'));
            expect(c?.path).toBe(`/api/groups/${g}/chat/message`);
            expect(c?.epoch).toBe(1);
            expect(opensUnder({ ...c!, messageId: cid }, e1.groupKey, [g, G])?.id).toBe(g);

            from = received.length;
            const mid = randomUUID();
            expect(await tryIt(() => editThreadMessage(mid, `K1 edit, ${spelling}`, { groupId: spelling, metadata: { epoch: 1 }, locked: true }))).toBe('went');
            const e = sentLine(from, (r) => r.path === '/api/messages/edit');
            expect(e?.epoch).toBe(1);
            expect(opensUnder({ ...e!, messageId: mid, part: 'edit' }, e1.groupKey, [g, G])?.id).toBe(g);
        }
        expect(posted.length).toBe(postedBefore);
        expect(await groupKeyringFor(G)).toBe(await groupKeyringFor(g));
    });
});

describe('a held group\'s membership changes are routed under the group\'s own id, however the caller spells it (#1841 confirmation 1, finding 1)', () => {
    it('join, approve and the convenor\'s removal, each asked of a held group in capitals, go to /api/groups/<g>/…', async () => {
        fresh();
        const NEWCOMER = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
        /** A held group (epoch 1 to me and Bob) the node serves, answering its routes however spelled. */
        const heldGroup = () => {
            const g = randomUUID();
            const e1 = epochWithKey(g, 1, [ME.publicKey, OTHER]);
            views.set(g, { keys: { current: 1, roster: [ME.publicKey, OTHER], epochs: [e1.header], myWraps: [e1.wrap] } });
            store.keyState.set(`${ME.publicKey}/${g}`, { highest: 1, after: 1 });
            store.epochs.set(`${ME.publicKey}/${g}`, [e1.stored]);
            return g;
        };
        /** The membership routes the phone asked since `from`, as sent. */
        const membership = (from: number) => received.slice(from).filter((r) => r.method !== 'GET' && /\/(join|members)(\/|$)/.test(r.path)).map((r) => `${r.method} ${r.path}`);

        const joined = heldGroup();
        let from = received.length;
        await joinGroupApi(joined.toUpperCase());
        expect(membership(from)).toEqual([`POST /api/groups/${joined}/join`]);

        const approved = heldGroup();
        from = received.length;
        await approveGroupMemberApi(approved.toUpperCase(), NEWCOMER);
        expect(membership(from)).toEqual([`POST /api/groups/${approved}/members`]);

        const removed = heldGroup();
        from = received.length;
        expect(await leaveGroupApi(removed.toUpperCase(), OTHER)).toBe(true);
        expect(membership(from)).toEqual([`DELETE /api/groups/${removed}/members/${OTHER}`]);
    });
});

describe('a held group sends sealed while the DM list can\'t be read (§3.4 amendment 7 §3 iii, GD2)', () => {
    for (const how of ['a read that throws', 'a corrupt value'] as const) {
        it(`GD2h the DM list unreadable (${how}): the held group's DM-screen send, group-screen send and edit go sealed under its key; nothing is written to the list`, async () => {
            fresh();
            const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
            const getItem = vi.mocked(AsyncStorage.getItem);
            const real = getItem.getMockImplementation()!;
            const g = randomUUID();
            const e1 = epochWithKey(g, 1, [ME.publicKey, OTHER]);
            views.set(g, { keys: { current: 1, roster: [ME.publicKey, OTHER], epochs: [e1.header], myWraps: [e1.wrap] } });
            store.keyState.set(`${ME.publicKey}/${g}`, { highest: 1, after: 1 });
            store.epochs.set(`${ME.publicKey}/${g}`, [e1.stored]);
            if (how === 'a corrupt value') store.asyncStore.set(DM_SEEN, '{unreadable');
            else getItem.mockImplementation(async (k: string) => { if (k === DM_SEEN) throw new Error('storage unavailable'); return real(k); });
            const stored = store.asyncStore.get(DM_SEEN);
            try {
                let from = received.length;
                const dmScreen = await tryIt(() => insertMessage(g, ME.publicKey, 'GD2h DM-screen send'));
                await waitFor(() => !!sentLine(from, (r) => r.path === '/api/messages/send'));
                const s = sentLine(from, (r) => r.path === '/api/messages/send');
                from = received.length;
                const cid = randomUUID();
                const groupScreen = await tryIt(() => postGroupChatMessage(g, 'GD2h group-screen send', cid, null, { after: null }));
                const c = sentLine(from, (r) => r.path.endsWith('/chat/message'));
                from = received.length;
                const mid = randomUUID();
                const edit = await tryIt(() => editThreadMessage(mid, 'GD2h edit', { groupId: g, metadata: { epoch: 1 }, locked: true }));
                const e = sentLine(from, (r) => r.path === '/api/messages/edit');
                const r = {
                    dmScreen, dmScreenOpens: opensUnder(s!, e1.groupKey, [g])?.text ?? null,
                    groupScreen, groupScreenOpens: opensUnder({ ...c!, messageId: cid }, e1.groupKey, [g])?.text ?? null,
                    edit, editOpens: opensUnder({ ...e!, messageId: mid, part: 'edit' }, e1.groupKey, [g])?.text ?? null,
                    listKept: store.asyncStore.get(DM_SEEN) === stored,
                };
                console.log(`GD2h (${how}) ${JSON.stringify(r)}`);
                expect(r).toEqual({
                    dmScreen: 'went', dmScreenOpens: 'GD2h DM-screen send', groupScreen: 'went', groupScreenOpens: 'GD2h group-screen send',
                    edit: 'went', editOpens: 'GD2h edit', listKept: true,
                });
            } finally {
                getItem.mockImplementation(real);
                store.asyncStore.delete(DM_SEEN);
            }
        });
    }
});

// #1938 confirmation 7, finding 1: the sealed group path. A DM only its pin remembers (Ben, checked; the full list never took
// it; no row, no line: the node pruned it) is relisted by the node as a LOCKED group, roster [me, Bob, PUPPET], while the pins
// can't be read. The group screen opens its keys (groupScreenKeyringFor + sync), sends with `lock` and edits sealed, and none
// of these asks refuseReadableIntoDm: only the key-making guard (refuseGroupKeysForDm). Asked leniently, it let the keys in,
// the DM became a held group, and a held group outranks its pin for good, so after the pins came back even the DM screen
// sealed to PUPPET's group key. The guard now asks the pins strictly (§3.4 amendment 7 §3 iv, "refusing when unreadable").
// Ported from the review's gx4.part, its records flipped to assertions; PUPPET's key is the oracle.
describe('a pinned DM the node relists as a LOCKED group while the pins can\'t be read gets no group keys (#1938 confirmation 7, finding 1)', () => {
    const PINS = dmPeerPinsStoreKey(ME.publicKey, 'beanpool_test.db');
    const pinFor = (id: string) => JSON.stringify({ pins: { [id.toLowerCase()]: { peer: OTHER.toLowerCase(), since: '2026-10-01T00:00:00.000Z', by: 'first-seen', checked: true } } });
    /** The DM list at its cap without the DM (26,886 UUIDs, 1,048,555 bytes), as it was when the DM was met. */
    const fullList = () => JSON.stringify(Array.from({ length: 26_886 }, () => randomUUID()));
    afterEach(() => { store.asyncStore.delete(PINS); store.asyncStore.delete(DM_SEEN); _resetDmPeerPinsForTests(); });
    /** The pins can't be read while `fn` runs: a read that throws, or a value that doesn't parse (the app started again each way). */
    async function whilePinsUnread<T>(how: 'a read that throws' | 'a corrupt value', fn: () => Promise<T>): Promise<T> {
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        const kept = store.asyncStore.get(PINS);
        if (how === 'a corrupt value') store.asyncStore.set(PINS, '{"pins": {corrupt');
        else getItem.mockImplementation(async (k: string) => { if (String(k).startsWith(dmPeerPinsStoreKey(ME.publicKey, ''))) throw new Error('storage unavailable'); return real(k); });
        _resetDmPeerPinsForTests();
        try { return await fn(); } finally {
            getItem.mockImplementation(real);
            if (how === 'a corrupt value') { if (kept === undefined) store.asyncStore.delete(PINS); else store.asyncStore.set(PINS, kept); }
            _resetDmPeerPinsForTests();
        }
    }
    /** What a call came to: 'went', or the refusal's error name (its message when it has none of its own). */
    const outcome = async (f: () => Promise<unknown>) => { try { await f(); return 'went'; } catch (e: any) { return e?.name && e.name !== 'Error' ? e.name : `refused: ${e?.message}`; } };
    /** The group screen's sealed send (GroupChatView with `lock`), and whether PUPPET opens what went. */
    async function lockedSend(id: string, text: string, puppetKeys: (Uint8Array | null)[]) {
        const from = received.length;
        const clientId = randomUUID();
        const result = await outcome(() => postGroupChatMessage(id, text, clientId, null, { after: null }));
        const s = sentLine(from, (x) => /\/chat\/message$/.test(x.path));
        const madeRec = posted.map((p) => p.rec).find((x) => x?.epoch === s?.epoch && String(x?.groupId).toLowerCase() === id.toLowerCase());
        const read = s ? [...puppetKeys, puppetKeyOf(madeRec)].map((k) => opensUnder({ ...s, messageId: clientId }, k, [id, id.toLowerCase()])).find(Boolean) : null;
        return { result, sent: !!s, puppetReads: read?.text ?? null };
    }
    /** The group screen's edit of a sealed line at epoch 1 (editThreadMessage with `locked`), and whether PUPPET opens it. */
    async function lockedEdit(id: string, text: string, puppetKeys: (Uint8Array | null)[]) {
        const from = received.length;
        const messageId = randomUUID();
        const result = await outcome(() => editThreadMessage(messageId, text, { groupId: id, metadata: { epoch: 1 }, locked: true }));
        const s = sentLine(from, (x) => x.path === '/api/messages/edit');
        const read = s ? puppetKeys.map((k) => opensUnder({ ...s, messageId, epoch: 1, part: 'edit' }, k, [id, id.toLowerCase()])).find(Boolean) : null;
        return { result, sent: !!s, puppetReads: read?.text ?? null };
    }
    /** GX1's state: the DM known only by its pin, the list full without it, no row and no line; the node serves its id as a locked group. */
    function relistedLocked(epochBy: 'PUPPET' | 'the phone') {
        fresh();
        const d0 = randomUUID();
        store.asyncStore.set(DM_SEEN, fullList());
        store.asyncStore.set(PINS, pinFor(d0));
        _resetDmPeerPinsForTests();
        const e1 = epochWithKey(d0, 1, [ME.publicKey, OTHER, PUPPET.publicKey], PUPPET);
        views.set(d0, epochBy === 'PUPPET'
            ? { keys: { current: 1, roster: [ME.publicKey, OTHER, PUPPET.publicKey], epochs: [e1.header], myWraps: [e1.wrap] } }
            : { keys: { current: null, roster: [ME.publicKey, OTHER, PUPPET.publicKey], epochs: [], myWraps: [] }, serveWhatIsPosted: true });
        return { d0, puppetKeys: epochBy === 'PUPPET' ? [e1.groupKey] : [] as Uint8Array[] };
    }
    /** Any key PUPPET got from an epoch the phone posted for this id (the phone's own first epoch wraps to the roster). */
    const keysPuppetGot = (d0: string, keys: Uint8Array[]) => [...keys, ...posted.filter((p) => String(p.rec?.groupId).toLowerCase() === d0.toLowerCase()).map((p) => puppetKeyOf(p.rec))];

    for (const how of ['a read that throws', 'a corrupt value'] as const) for (const epochBy of ['PUPPET', 'the phone'] as const) {
        it(`GX4 (${how}, epoch 1 made by ${epochBy}) the screen's key sync, its sealed send and its edit are refused with the pins sentence; no epoch posted, no keys held; the pins back, it is a DM again and PUPPET reads nothing from either screen`, async () => {
            posted.length = 0;
            const { d0, puppetKeys } = relistedLocked(epochBy);
            const from = received.length;
            const unread = await whilePinsUnread(how, async () => ({
                view: (await routeChat(ASKS, d0, {})).view,
                keys: await outcome(async () => { await (await groupScreenKeyringFor(d0)).sync(); }),
                send: await lockedSend(d0, 'The code is 4821 (locked group screen)', puppetKeys),
                edit: await lockedEdit(d0, 'The code is 4821 (an edit)', keysPuppetGot(d0, puppetKeys)),
                held: await isHeldGroupChat(d0),
                rows: rowsFor(d0),
                groupWrites: groupWrites(from),
            }));
            const back = {
                held: await isHeldGroupChat(d0),
                knownDm: await isKnownDmConversation(d0),
                view: (await routeChat(ASKS, d0, {})).view,
                groupScreenSend: await lockedSend(d0, 'The code is 4822 (group screen, pins back)', keysPuppetGot(d0, puppetKeys)),
                dmScreenSend: await dmSend(d0, 'The code is 4823 (DM screen, pins back)', keysPuppetGot(d0, puppetKeys)),
                pinKept: JSON.parse(store.asyncStore.get(PINS) ?? '{}')?.pins?.[d0.toLowerCase()]?.peer === OTHER.toLowerCase(),
                epochsPosted: posted.length,
            };
            console.log(`GX4 (${how}, epoch by ${epochBy}) ${JSON.stringify({ unread, back })}`);
            expect(unread).toEqual({
                view: 'group_thread', keys: 'DmPinStoreError',
                send: { result: 'DmPinStoreError', sent: false, puppetReads: null },
                edit: { result: 'DmPinStoreError', sent: false, puppetReads: null },
                held: false, rows: { highest: 0, epochs: 0 }, groupWrites: [],
            });
            // This harness has no sync to write the dm row back (GX1 in dm-line-binding has: the DM screen then seals to Ben).
            // Whatever the DM screen does here, nothing it sends opens under any key PUPPET has.
            expect(back).toEqual({
                held: false, knownDm: true, view: 'dm',
                groupScreenSend: { result: 'GroupChatKeyError', sent: false, puppetReads: null },
                dmScreenSend: { result: expect.any(String), sealedForTheDm: expect.any(Boolean), puppetReads: null },
                pinKept: true, epochsPosted: 0,
            });
            expect(back.dmScreenSend.result !== 'went' || back.dmScreenSend.sealedForTheDm, 'a DM-screen line that went is DM-sealed').toBe(true);
        }, 120_000);
    }

    for (const how of ['a read that throws', 'a corrupt value'] as const) {
        it(`GX4o (${how}) only opening the relisted chat's screen (its keyring and key sync, as GroupChatView's open does), no send: refused, nothing written; the pins back, it is still a DM and the DM screen's line is not PUPPET's to read`, async () => {
            posted.length = 0;
            const { d0, puppetKeys } = relistedLocked('PUPPET');
            const from = received.length;
            const unread = await whilePinsUnread(how, async () => ({
                view: (await routeChat(ASKS, d0, {})).view,
                open: await outcome(async () => { await (await groupScreenKeyringFor(d0)).sync(); }),
                held: await isHeldGroupChat(d0),
                rows: rowsFor(d0),
                groupWrites: groupWrites(from),
            }));
            const back = {
                held: await isHeldGroupChat(d0),
                view: (await routeChat(ASKS, d0, {})).view,
                dmScreenSend: await dmSend(d0, 'The code is 4824 (DM screen, after one open)', puppetKeys),
            };
            console.log(`GX4o (${how}) ${JSON.stringify({ unread, back })}`);
            expect(unread).toEqual({ view: 'group_thread', open: 'DmPinStoreError', held: false, rows: { highest: 0, epochs: 0 }, groupWrites: [] });
            expect(back).toEqual({ held: false, view: 'dm', dmScreenSend: { result: expect.any(String), sealedForTheDm: expect.any(Boolean), puppetReads: null } });
            expect(back.dmScreenSend.result !== 'went' || back.dmScreenSend.sealedForTheDm, 'a DM-screen line that went is DM-sealed').toBe(true);
        }, 120_000);
    }

    // The one cost (the review's §3, GXH-locked): a locked group this phone never held can't be opened or sent in while the
    // pins can't be read, refused with the pins sentence, until they can; the same rule an unreadable DM list already sets
    // on the key path (DmGuardUnreadError). A group whose keys this phone holds never asks the pins, and sends throughout.
    for (const how of ['a read that throws', 'a corrupt value'] as const) {
        it(`GXH (${how}) honest locked groups while the pins can't be read: a held group opens and sends sealed; a never-held one waits with the pins sentence, then opens and sends once they read`, async () => {
            fresh();
            store.asyncStore.set(DM_SEEN, JSON.stringify([]));
            store.asyncStore.set(PINS, JSON.stringify({ pins: {} }));
            _resetDmPeerPinsForTests();
            const member = mkId();
            const [held, neverHeld] = [randomUUID(), randomUUID()];
            const keyOf: Record<string, Uint8Array> = {};
            for (const g of [held, neverHeld]) {
                const e = epochWithKey(g, 1, [ME.publicKey, member.publicKey], member);
                keyOf[g] = e.groupKey;
                views.set(g, { keys: { current: 1, roster: [ME.publicKey, member.publicKey], epochs: [e.header], myWraps: [e.wrap] } });
                store.conversations.set(g, { id: g, type: 'group_thread', created_by: member.publicKey });
            }
            const openAndSend = async (g: string, text: string) => ({
                keys: await outcome(async () => { await (await groupScreenKeyringFor(g)).sync(); }),
                send: await lockedSend(g, text, [keyOf[g]]),
            });
            const first = { held: await openAndSend(held, 'Hello (pins readable)'), isHeld: await isHeldGroupChat(held) };
            const unread = await whilePinsUnread(how, async () => ({
                held: await openAndSend(held, 'Hello (pins unreadable)'),
                neverHeld: await openAndSend(neverHeld, 'Hello (pins unreadable)'),
                neverHeldIsHeld: await isHeldGroupChat(neverHeld),
            }));
            const back = { neverHeld: await openAndSend(neverHeld, 'Hello (pins back)') };
            // lockedSend's oracle is the group's own key here (the member's): an honest line opens for the honest group.
            const went = (text: string) => ({ keys: 'went', send: { result: 'went', sent: true, puppetReads: text } });
            expect(first).toEqual({ held: went('Hello (pins readable)'), isHeld: true });
            expect(unread).toEqual({
                held: went('Hello (pins unreadable)'),
                neverHeld: { keys: 'DmPinStoreError', send: { result: 'DmPinStoreError', sent: false, puppetReads: null } },
                neverHeldIsHeld: false,
            });
            expect(back).toEqual({ neverHeld: went('Hello (pins back)') });
        }, 120_000);
    }

    // #1938 confirmation 7, finding 2: a group's vote form posts a title and a why the node reads. A known DM's id refuses
    // (GXD in dm-line-binding); a group this phone holds keys of is never a DM, so its votes never wait on the pins.
    for (const how of ['a read that throws', 'a corrupt value'] as const) {
        it(`GXDh (${how}) a held group's vote form while the pins can't be read: the vote goes (its title and why reach the node); a never-held group's waits with the pins sentence`, async () => {
            fresh();
            store.asyncStore.set(DM_SEEN, JSON.stringify([]));
            store.asyncStore.set(PINS, JSON.stringify({ pins: {} }));
            _resetDmPeerPinsForTests();
            const member = mkId();
            const [held, neverHeld] = [randomUUID(), randomUUID()];
            for (const g of [held, neverHeld]) {
                const e = epochWithKey(g, 1, [ME.publicKey, member.publicKey], member);
                views.set(g, { keys: { current: 1, roster: [ME.publicKey, member.publicKey], epochs: [e.header], myWraps: [e.wrap] } });
            }
            expect(await outcome(async () => { await (await groupScreenKeyringFor(held)).sync(); })).toBe('went');
            expect(await isHeldGroupChat(held)).toBe(true);
            const took: string[] = [];
            const nodeFetch = (globalThis as any).fetch;
            (globalThis as any).fetch = async (url: string, init: any = {}) => {
                if ((init.method ?? 'GET') === 'POST' && /\/api\/groups\/[^/]+\/decisions$/.test(String(url))) {
                    const b = JSON.parse(init.body ?? 'null');
                    took.push(b?.title, b?.description);
                    return reply(201, { success: true, decision: { id: randomUUID() } });
                }
                return nodeFetch(url, init);
            };
            const vote = (g: string) => outcome(() => proposeGroupDecision(g, { title: `Close it (${how})`, description: 'We meet in person now', effect: 'close_group' } as any));
            try {
                const unread = await whilePinsUnread(how, async () => ({ held: await vote(held), neverHeld: await vote(neverHeld) }));
                expect(unread).toEqual({ held: 'went', neverHeld: 'DmPinStoreError' });
                expect(took).toEqual([`Close it (${how})`, 'We meet in person now']);
                expect(await vote(neverHeld)).toBe('went');
            } finally { (globalThis as any).fetch = nodeFetch; }
        }, 120_000);
    }

    // #1938 confirmation 8, finding 3: the vote's held-group skip asks the key memory; a key memory that can't be read is not
    // "held" (a mutant reading it as held let the DM's vote out). For a known DM's id and for a plain group alike, a key store
    // that throws refuses the vote and the node reads nothing.
    it('GXDk a group vote when the key memory can\'t be read: for a known DM\'s id and for a never-held group, the vote is refused and the node reads nothing; once it reads, the group\'s goes', async () => {
        fresh();
        store.asyncStore.set(DM_SEEN, JSON.stringify([]));
        const [dmId, group] = [randomUUID(), randomUUID()];
        store.asyncStore.set(PINS, pinFor(dmId));
        _resetDmPeerPinsForTests();
        store.conversations.set(dmId, { id: dmId, type: 'dm', created_by: null });
        const member = mkId();
        const e = epochWithKey(group, 1, [ME.publicKey, member.publicKey], member);
        views.set(group, { keys: { current: 1, roster: [ME.publicKey, member.publicKey], epochs: [e.header], myWraps: [e.wrap] } });
        const took: string[] = [];
        const nodeFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string, init: any = {}) => {
            if ((init.method ?? 'GET') === 'POST' && /\/api\/groups\/[^/]+\/decisions$/.test(String(url))) {
                const b = JSON.parse(init.body ?? 'null');
                took.push(b?.title, b?.description);
                return reply(201, { success: true, decision: { id: randomUUID() } });
            }
            return nodeFetch(url, init);
        };
        const getAll = vi.mocked(mockDb.getAllAsync);
        const real = getAll.getMockImplementation()!;
        getAll.mockImplementation(async (sql: string, params: any[] = []) => {
            if (/FROM group_chat_epochs WHERE group_id = \?/.test(sql)) throw new Error('database disk image is malformed');
            return real(sql, params);
        });
        const vote = (g: string, words: string) => outcome(() => proposeGroupDecision(g, { title: words, description: `${words} (why)`, effect: 'close_group' } as any));
        try {
            const unread = { dm: await vote(dmId, 'The code is 4821'), group: await vote(group, 'Close it') };
            console.log(`GXDk ${JSON.stringify({ unread, took })}`);
            expect(unread.dm).not.toBe('went');
            expect(unread.group).not.toBe('went');
            expect(took).toEqual([]);
        } finally { getAll.mockImplementation(real); }
        try {
            expect(await vote(dmId, 'The code is 4822')).toBe('GroupChatKeyError');
            expect(await vote(group, 'Close it again')).toBe('went');
            expect(took).toEqual(['Close it again', 'Close it again (why)']);
        } finally { (globalThis as any).fetch = nodeFetch; }
    }, 120_000);

    // #1938 confirmation 8, finding 1: a group feed post (app/group-post.tsx, createPost's targetGroupId) carries words the
    // node reads for the group's id. A known DM's id refuses (GXF in dm-line-binding); a group this phone holds keys of never
    // asks the pins, so its post goes while they can't be read; a never-held group's waits with the pins sentence.
    for (const how of ['a read that throws', 'a corrupt value'] as const) {
        it(`GXFh-held (${how}) a held group's feed post while the pins can't be read goes; a never-held group's waits with the pins sentence, then goes`, async () => {
            fresh();
            store.asyncStore.set(DM_SEEN, JSON.stringify([]));
            store.asyncStore.set(PINS, JSON.stringify({ pins: {} }));
            _resetDmPeerPinsForTests();
            const member = mkId();
            const [held, neverHeld] = [randomUUID(), randomUUID()];
            for (const g of [held, neverHeld]) {
                const e = epochWithKey(g, 1, [ME.publicKey, member.publicKey], member);
                views.set(g, { keys: { current: 1, roster: [ME.publicKey, member.publicKey], epochs: [e.header], myWraps: [e.wrap] } });
            }
            expect(await outcome(async () => { await (await groupScreenKeyringFor(held)).sync(); })).toBe('went');
            const took: string[] = [];
            const nodeFetch = (globalThis as any).fetch;
            (globalThis as any).fetch = async (url: string, init: any = {}) => {
                if ((init.method ?? 'GET') === 'POST' && /\/api\/marketplace\/posts$/.test(String(url))) {
                    const b = JSON.parse(init.body ?? 'null');
                    took.push(b?.title);
                    return reply(201, { success: true, post: null });
                }
                return nodeFetch(url, init);
            };
            const post = (g: string, title: string) => outcome(() => createPost({ id: randomUUID(), type: 'offer', title, description: 'x', category: 'other', credits: 1, author_pubkey: ME.publicKey, created_at: new Date().toISOString(), audienceScope: 'group', targetGroupId: g, reach: 'local' }));
            try {
                const unread = await whilePinsUnread(how, async () => ({ held: await post(held, `Bread on Friday (${how})`), neverHeld: await post(neverHeld, 'Bread on Saturday') }));
                expect(unread).toEqual({ held: 'went', neverHeld: 'DmPinStoreError' });
                expect(await post(neverHeld, 'Bread on Sunday')).toBe('went');
                expect(took).toEqual([`Bread on Friday (${how})`, 'Bread on Sunday']);
            } finally { (globalThis as any).fetch = nodeFetch; }
        }, 120_000);
    }

    // #1938 confirmation 9: updateGroupApi's name and about are words for the group's id (no screen sends them today). A
    // known DM's id refuses (GXF in dm-line-binding); a held group's edit never waits on the pins; a never-held group's waits.
    for (const how of ['a read that throws', 'a corrupt value'] as const) {
        it(`GXFh-held edit (${how}) a held group's name and about while the pins can't be read go; a never-held group's wait with the pins sentence, then go`, async () => {
            fresh();
            store.asyncStore.set(DM_SEEN, JSON.stringify([]));
            store.asyncStore.set(PINS, JSON.stringify({ pins: {} }));
            _resetDmPeerPinsForTests();
            const member = mkId();
            const [held, neverHeld] = [randomUUID(), randomUUID()];
            for (const g of [held, neverHeld]) {
                const e = epochWithKey(g, 1, [ME.publicKey, member.publicKey], member);
                views.set(g, { keys: { current: 1, roster: [ME.publicKey, member.publicKey], epochs: [e.header], myWraps: [e.wrap] } });
            }
            expect(await outcome(async () => { await (await groupScreenKeyringFor(held)).sync(); })).toBe('went');
            const took = groupEditsTaken();
            try {
                const unread = await whilePinsUnread(how, async () => ({ held: await edit(held, `Bakers (${how})`), neverHeld: await edit(neverHeld, 'Gardeners') }));
                expect(unread).toEqual({ held: 'went', neverHeld: 'DmPinStoreError' });
                expect(await edit(neverHeld, 'Gardeners again')).toBe('went');
                expect([...took]).toEqual([`Bakers (${how})`, `Bakers (${how}) (about)`, 'Gardeners again', 'Gardeners again (about)']);
            } finally { took.restore(); }
        }, 120_000);
    }
    /** Every group edit's name and about the node took (PATCH /api/groups/:id), answered as the node does. */
    function groupEditsTaken(): string[] & { restore: () => void } {
        const took = [] as unknown as string[] & { restore: () => void };
        const nodeFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string, init: any = {}) => {
            if (init.method === 'PATCH' && /\/api\/groups\/[^/]+$/.test(String(url))) {
                const b = JSON.parse(init.body ?? 'null');
                took.push(...[b?.name, b?.description].filter((x): x is string => typeof x === 'string'));
                return reply(200, { success: true, group: null });
            }
            return nodeFetch(url, init);
        };
        took.restore = () => { (globalThis as any).fetch = nodeFetch; };
        return took;
    }
    const edit = (g: string, name: string) => outcome(() => updateGroupApi(g, { name, description: `${name} (about)` }));

    // #1938 confirmation 9, finding 4 (M1, GXDk's twin on createPost and updateGroupApi): the held-group skip asks the key
    // memory; a key memory that can't be read is not "held". For a known DM's id and for a never-held group alike, a key
    // store that throws refuses the group post and the group edit, and the node reads nothing; once it reads, the DM's id
    // refuses as a DM and the group's go.
    it('GXFk a group post and a group edit when the key memory can\'t be read: for a known DM\'s id and for a never-held group, both refused and the node reads nothing; once it reads, the group\'s go', async () => {
        fresh();
        store.asyncStore.set(DM_SEEN, JSON.stringify([]));
        const [dmId, group] = [randomUUID(), randomUUID()];
        store.asyncStore.set(PINS, pinFor(dmId));
        _resetDmPeerPinsForTests();
        store.conversations.set(dmId, { id: dmId, type: 'dm', created_by: null });
        const member = mkId();
        const e = epochWithKey(group, 1, [ME.publicKey, member.publicKey], member);
        views.set(group, { keys: { current: 1, roster: [ME.publicKey, member.publicKey], epochs: [e.header], myWraps: [e.wrap] } });
        const edits = groupEditsTaken();
        const posts: string[] = [];
        const nodeFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string, init: any = {}) => {
            if ((init.method ?? 'GET') === 'POST' && /\/api\/marketplace\/posts$/.test(String(url))) {
                const b = JSON.parse(init.body ?? 'null');
                posts.push(b?.title, b?.description);
                return reply(201, { success: true, post: null });
            }
            return nodeFetch(url, init);
        };
        const post = (g: string, words: string) => outcome(() => createPost({ id: randomUUID(), type: 'offer', title: words, description: `${words} (why)`, category: 'other', credits: 1, author_pubkey: ME.publicKey, created_at: new Date().toISOString(), audienceScope: 'group', targetGroupId: g, reach: 'local' }));
        const getAll = vi.mocked(mockDb.getAllAsync);
        const real = getAll.getMockImplementation()!;
        getAll.mockImplementation(async (sql: string, params: any[] = []) => {
            if (/FROM group_chat_epochs WHERE group_id = \?/.test(sql)) throw new Error('database disk image is malformed');
            return real(sql, params);
        });
        try {
            const unread = {
                dmPost: await post(dmId, 'The code is 4821'), groupPost: await post(group, 'Bread on Friday'),
                dmEdit: await edit(dmId, 'The code is 4821'), groupEdit: await edit(group, 'Bakers'),
            };
            console.log(`GXFk ${JSON.stringify({ unread, posts, edits })}`);
            for (const [k, v] of Object.entries(unread)) expect(v, k).not.toBe('went');
            expect(posts).toEqual([]);
            expect([...edits]).toEqual([]);
        } finally { getAll.mockImplementation(real); }
        try {
            expect(await post(dmId, 'The code is 4822')).toBe('GroupChatKeyError');
            expect(await edit(dmId, 'The code is 4822')).toBe('GroupChatKeyError');
            expect(await post(group, 'Bread on Saturday')).toBe('went');
            expect(await edit(group, 'Bakers again')).toBe('went');
            expect(posts).toEqual(['Bread on Saturday', 'Bread on Saturday (why)']);
            expect([...edits]).toEqual(['Bakers again', 'Bakers again (about)']);
        } finally { (globalThis as any).fetch = nodeFetch; edits.restore(); }
    }, 120_000);
});
