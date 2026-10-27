import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// A message request on the phone of the person it is for, over the phone's real schema and real sync (utils/db.ts
// syncMessages, syncSingleConversation, getConversationKind, getConversation, getConversations, getMessages) on an in-memory
// SQLite (node:sqlite), with real DM encryption between real keys. The node is a stand-in that answers as the real one does
// (routes/messaging.ts): the list leaves a request waiting for Bo out of `conversations` and names it under `requests`, and
// GET /api/messages/:id answers the conversation with its people, its `request` and its newest lines. The harness is
// deleted-account-lines.test.ts's.
//
// PR #2540 review 4393642140: a request reached only through syncSingleConversation (the Requests card's preview) had no
// people on the phone, so its line didn't open ("[Encrypted — update your app to read]") and the chat was named by an id
// fragment. Review 4393642158: after a cancel and a new line, the withdrawn line stayed on the phone. Review 4393642152: a
// row the router wrote (getConversationKind asking the node) had no `request`, so the chat read as an ordinary one.

const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    (globalThis as any).__phoneSql = sql;
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
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_mullum.beanpool.org.db'), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { getDb, getMessages, getConversation, getConversations, getConversationKind, syncMessages, syncSingleConversation } from '../db';
import { encryptDmFormat2 } from '../e2e-crypto';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';

const sql = (globalThis as any).__phoneSql as import('node:sqlite').DatabaseSync;
const ANCHOR = 'https://mullum.beanpool.org';
const UNREADABLE = '[Encrypted — update your app to read]';

interface Person { name: string; publicKey: string; privateKey: string }
function person(name: string): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { name, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── The node ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Line { id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string; type: string; systemType: null; metadata: null; timestamp: string; editedAt: null }
interface Conv { id: string; participants: string[]; request: { state: string; from: string; at: string } | null }
const node = { lines: [] as Line[], convs: [] as Conv[] };
let clock = Date.parse('2026-10-20T00:00:00.000Z');
let serial = 0;

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const view = (c: Conv) => ({ id: c.id, type: 'dm', name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-10-20T00:00:00.000Z', request: c.request });
const waitingFor = (c: Conv, key: string) => !!c.request && c.request.from !== key && c.request.state === 'pending';

const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url);
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        const mine = node.convs.filter((c) => c.participants.includes(list[1]));
        const asked = mine.filter((c) => waitingFor(c, list[1]) && node.lines.some((l) => l.conversationId === c.id));
        return answer(200, {
            conversations: mine.filter((c) => !c.request || c.request.from === list[1] || c.request.state === 'accepted').map(view),
            totalUnread: 0,
            deletedAccounts: [],
            requests: { count: asked.length, conversations: asked.map(view) },
        });
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page) {
        const conv = node.convs.find((c) => c.id === decodeURIComponent(page[1]));
        if (!conv) return answer(404, { error: 'Conversation not found' });
        const limit = Number(u.searchParams.get('limit') ?? 50);
        return answer(200, { conversation: view(conv), messages: node.lines.filter((l) => l.conversationId === conv.id).slice(-limit).map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

/** A DM line on the node, locked between its author and the other person, as the apps write it. */
function write(conv: Conv, author: Person, text: string): Line {
    const peer = conv.participants.find((p) => p !== author.publicKey)!;
    const { ciphertext, nonce } = encryptDmFormat2(text, { myEdPrivHex: author.privateKey, peerEdPubHex: peer, conversationId: conv.id });
    clock += 1000;
    const line: Line = { id: `line-${++serial}`, conversationId: conv.id, authorPubkey: author.publicKey, ciphertext, nonce, type: 'text', systemType: null, metadata: null, timestamp: new Date(clock).toISOString(), editedAt: null };
    node.lines.push(line);
    return line;
}
/** Cancel request on the node: the opener's lines since the request was made go (engine/dm-requests.ts withdrawOpenerLines). */
function cancel(conv: Conv): void {
    node.lines = node.lines.filter((l) => !(l.conversationId === conv.id && l.authorPubkey === conv.request!.from));
}

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

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
const texts = async (id: string) => (await withScreens(() => getMessages(id, { limit: 50 }))).map((m: any) => m.text);
const rowsOf = (id: string, key: string) => sql.prepare('SELECT id FROM messages WHERE conversation_id = ? AND author_pubkey = ? ORDER BY id').all(id, key).map((r: any) => r.id);

let bo: Person;
let rhea: Person;
let kai: Person;

beforeEach(async () => {
    h.store.clear();
    h.store.set('beanpool_anchor_url', ANCHOR);
    h.store.set('beanpool_node_profiles', JSON.stringify({ [ANCHOR.toLowerCase()]: { profile: 'global', features: {}, checkedAt: new Date().toISOString() } }));
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    bo = person('Bo');
    rhea = person('Rhea');
    kai = person('Kai');
    h.me = { publicKey: bo.publicKey, privateKey: bo.privateKey };
    node.lines = [];
    node.convs = [];
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    // A phone that has synced before: a chat with Kai, which the list names.
    const control: Conv = { id: 'dm-bo-kai', participants: [kai.publicKey, bo.publicKey], request: null };
    node.convs.push(control);
    write(control, kai, 'control words');
    await withScreens(() => syncMessages(bo.publicKey));
});

describe("a request on the phone of the person it is for", () => {
    it('reached only through syncSingleConversation (the card preview): its people are written, its line opens, its chat is named, and it is no chat in the list (review 4393642140)', async () => {
        const req: Conv = { id: 'dm-rhea-bo', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'first words from Rhea');

        // The list sync names it under Requests only, so it writes no row for it.
        await withScreens(() => syncMessages(bo.publicKey));
        const answered = await withScreens(() => syncSingleConversation(req.id));

        const people = sql.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ? ORDER BY public_key').all(req.id).map((r: any) => r.public_key);
        expect(answered).toBe(true);
        expect(people).toEqual([rhea.publicKey, bo.publicKey].sort());
        const conv = await getConversation(req.id, bo.publicKey);
        expect(conv?.otherPubkey).toBe(rhea.publicKey);
        expect(conv?.request).toMatchObject({ state: 'pending', from: rhea.publicKey });
        expect(await texts(req.id)).toEqual(['first words from Rhea']);
        expect(await texts(req.id)).not.toContain(UNREADABLE);
        // Control: the chat the list names reads too, and it alone is in Bo's chats; the request is under Requests only.
        expect(await texts('dm-bo-kai')).toEqual(['control words']);
        const listed = (await withScreens(() => getConversations(bo.publicKey))).map((c: any) => c.id);
        expect(listed).toEqual(['dm-bo-kai']);
    });

    it('after a cancel and a new line, the phone drops the withdrawn line and keeps the new one (review 4393642158)', async () => {
        const req: Conv = { id: 'dm-rhea-bo-2', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        const first = write(req, rhea, 'first words she withdrew');
        await withScreens(() => syncSingleConversation(req.id));
        expect(rowsOf(req.id, rhea.publicKey)).toEqual([first.id]);

        cancel(req);
        req.request = { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() };
        const second = write(req, rhea, 'her new first words');
        await withScreens(() => syncSingleConversation(req.id));

        expect(rowsOf(req.id, rhea.publicKey)).toEqual([second.id]);
        expect(await texts(req.id)).toEqual(['her new first words']);
    });

    it('one Bo ignored, then withdrawn: its line goes from his phone', async () => {
        const req: Conv = { id: 'dm-rhea-bo-3', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'words he ignored');
        await withScreens(() => syncSingleConversation(req.id));
        req.request = { ...req.request!, state: 'ignored' };
        cancel(req);
        await withScreens(() => syncSingleConversation(req.id));

        expect(rowsOf(req.id, rhea.publicKey)).toEqual([]);
    });

    it('one Bo accepted after it was withdrawn: her withdrawn line goes, and his own line stays', async () => {
        const req: Conv = { id: 'dm-rhea-bo-4', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'words she withdrew');
        await withScreens(() => syncSingleConversation(req.id));
        cancel(req);
        req.request = { ...req.request!, state: 'accepted' };
        const his = write(req, bo, 'hello Rhea');
        await withScreens(() => syncSingleConversation(req.id));

        expect(rowsOf(req.id, rhea.publicKey)).toEqual([]);
        expect(rowsOf(req.id, bo.publicKey)).toEqual([his.id]);
    });

    it('opened by the router (getConversationKind asking the node), its row carries the request (review 4393642152)', async () => {
        const req: Conv = { id: 'dm-rhea-bo-5', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'from a push');

        expect(await withScreens(() => getConversationKind(req.id, { askNode: true }))).toBe('dm');
        const conv = await getConversation(req.id, bo.publicKey);
        expect(conv?.request).toMatchObject({ state: 'pending', from: rhea.publicKey });
        expect(conv?.otherPubkey).toBe(rhea.publicKey);
    });
});
