/**
 * Group chats on the phone: a DM and a group are never one conversation because of how a link, a push or the node spells
 * the id (#1841 review, findings 1 and 3). The node makes ids lower-case; a dishonest one can send them in capitals. The
 * DM guard folds case as the held check, the keyring and the group screens do, so a known DM in any spelling gets no
 * group keys and stays DM-sealed; the group screen opens its keys only through the DM guard; and a held group's lines
 * are signed and routed under the group's own id, however the caller spelled it. Ported from the review's driver (K1,
 * K2, K3, K6; scratch/reviews/opus-1841-scripts/zz-review-1841-db.test.ts), its measurements flipped to assertions.
 * Mock style from group-chat-held-guard.test.ts: device modules stubbed, a stand-in for SQLite (its NOCASE lookups
 * folded as SQLite folds ASCII), and a fake node that keeps a posted epoch and matches ids however spelled.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
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
/** The rows whose id matches `id` with ASCII case folded, as SQLite's NOCASE compares. */
const convsNoCase = (id: string) => [...store.conversations.values()].filter((c) => c.id.toLowerCase() === String(id).toLowerCase());
const mockDb = {
    execAsync: vi.fn(async () => undefined),
    closeAsync: vi.fn(async () => undefined),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    getFirstAsync: vi.fn(async (sql: string, params: any[] = []) => {
        if (/FROM group_chat_key_state/.test(sql)) return store.keyState.get(params[0]) ?? null;
        if (/FROM group_chat_epochs WHERE group_id = \? AND wrap IS NOT NULL/.test(sql)) return (store.epochs.get(params[0]) ?? []).some((e) => e.wrap) ? { y: 1 } : null;
        if (/FROM conversations WHERE id = \? COLLATE NOCASE AND type = 'dm'/.test(sql)) return convsNoCase(params[0]).find((c) => c.type === 'dm') ?? null;
        if (/FROM conversations WHERE id = \?/.test(sql)) return store.conversations.get(params[0]) ?? null;
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
    isKnownDmConversation, getConversationKind,
} from '../db';
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
const DM_SEEN = 'beanpool_dm_conversations_seen';
/** ChatRoute's asks, wired to the real utils/db.ts as app/chat/[id].tsx wires them. */
const ASKS: ChatRouteAsks = { isHeldGroupChat, isKnownDmConversation, getConversationKind };

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
