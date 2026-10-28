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
// row the router wrote (getConversationKind asking the node) had no `request`, so the chat read as an ordinary one. Review
// 4394119880: on the opener's own phone, a line the node withdrew (Cancel request from another app) stayed, drawn as sent.
// Review 4394120364: the Requests list was kept per member, so it followed them into another community. Review 4394670854:
// once the preview wrote a request's people, the Talk badge, Home's Needs you and the contact picker's Recents counted it.
// Review 4395542064: the open chat's poll wrote the node's `request` into a DM before the pins' gate, so with the pins
// unread a node could hide a chat held here from the list and swap its composer for an Accept card. Review 4395706539:
// decideMessageRequest wrote nothing to the phone, so after Accept on a Requests card the chat opened on the row's waiting
// request and drew the Accept card again, and a poll or list asked for before Accept or Cancel request put the old state back.

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
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn((url: string | null) => (url && url.includes('castlemaine') ? 'community_castlemaine.db' : 'beanpool_mullum.beanpool.org.db')), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb, getMessages, getConversation, getConversations, getConversationKind, syncMessages, syncSingleConversation, insertMessage, getMessageRequests, getGlobalUnreadCount, getUnreadByConversation, getRecentChatMembers, decideMessageRequest, _resetDmPeerPinsForTests } from '../db';
import { requestModeOf } from '@beanpool/core';
import { messageRequestsStoreKey, dmPeerPinsStoreKey } from '../storage-keys';
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
interface Conv { id: string; participants: string[]; request: { state: string; from: string; at: string; nextLineIsRequest?: boolean } | null }
const node = {
    lines: [] as Line[],
    convs: [] as Conv[],
    /** Once, between the node reading a page and the phone getting it: what happens while that answer is on its way. */
    beforePage: null as null | (() => Promise<void>),
    /** The same, for the list of conversations. */
    beforeList: null as null | (() => Promise<void>),
};
let clock = Date.parse('2026-10-20T00:00:00.000Z');
let serial = 0;

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const view = (c: Conv) => ({ id: c.id, type: 'dm', name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-10-20T00:00:00.000Z', request: c.request });
const waitingFor = (c: Conv, key: string) => !!c.request && c.request.from !== key && c.request.state === 'pending';

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname === '/api/messages/send') {
        const b = JSON.parse(init.body);
        clock += 1000;
        const line: Line = { id: b.id, conversationId: b.conversationId, authorPubkey: b.authorPubkey, ciphertext: b.ciphertext, nonce: b.nonce, type: 'text', systemType: null, metadata: null, timestamp: new Date(clock).toISOString(), editedAt: null };
        node.lines.push(line);
        return answer(200, { success: true, message: line });
    }
    if (init.method === 'POST' && u.pathname === '/api/messages/request') {
        // Accept, Ignore or Cancel request (routes/messaging.ts): the request as the member now reads it.
        const b = JSON.parse(init.body);
        const conv = node.convs.find((c) => c.id === b.conversationId);
        if (!conv?.request) return answer(404, { error: 'There is no message request for you in this chat.', code: 'request_not_found' });
        if (b.decision === 'cancel') {
            cancel(conv);
            conv.request = { ...conv.request, nextLineIsRequest: true };
        } else {
            conv.request = { ...conv.request, state: b.decision === 'accept' ? 'accepted' : 'ignored' };
        }
        return answer(200, { success: true, request: { ...conv.request } });
    }
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        const mine = node.convs.filter((c) => c.participants.includes(list[1]));
        const asked = mine.filter((c) => waitingFor(c, list[1]) && node.lines.some((l) => l.conversationId === c.id));
        const body = {
            conversations: mine.filter((c) => !c.request || c.request.from === list[1] || c.request.state === 'accepted').map(view),
            totalUnread: 0,
            deletedAccounts: [],
            requests: { count: asked.length, conversations: asked.map(view) },
        };
        const meanwhile = node.beforeList;
        node.beforeList = null;
        if (meanwhile) await meanwhile();
        return answer(200, body);
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page) {
        const conv = node.convs.find((c) => c.id === decodeURIComponent(page[1]));
        if (!conv) return answer(404, { error: 'Conversation not found' });
        const limit = Number(u.searchParams.get('limit') ?? 50);
        const body = { conversation: view(conv), messages: node.lines.filter((l) => l.conversationId === conv.id).slice(-limit).map((l) => ({ ...l })) };
        const meanwhile = node.beforePage;
        node.beforePage = null;
        if (meanwhile) await meanwhile();
        return answer(200, body);
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
    node.beforePage = null;
    node.beforeList = null;
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

describe("a request on its opener's own phone (review 4394119880)", () => {
    /** Bo's request to Rhea, waiting, and on his phone as the list writes it. */
    async function bosRequest(id: string): Promise<Conv> {
        const req: Conv = { id, participants: [bo.publicKey, rhea.publicKey], request: { state: 'pending', from: bo.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        await withScreens(() => syncMessages(bo.publicKey));
        return req;
    }
    /** A line of Bo's this phone never had confirmed, as the send path leaves it. */
    function unsent(conv: Conv, id: string, state: 'sending' | 'failed'): void {
        sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, conv.id, bo.publicKey, 'x', 'y', JSON.stringify({ __sendState: state }), new Date(clock).toISOString());
    }

    it('cancelled from his other app: the withdrawn line goes from this phone, and his unsent lines stay', async () => {
        const req = await bosRequest('dm-bo-rhea-1');
        const first = write(req, bo, 'words he withdrew from the web app');
        await withScreens(() => syncSingleConversation(req.id));
        expect(rowsOf(req.id, bo.publicKey)).toEqual([first.id]);
        unsent(req, 'unsent-sending', 'sending');
        unsent(req, 'unsent-failed', 'failed');

        cancel(req);
        expect(await withScreens(() => syncSingleConversation(req.id))).toBe(true);

        expect(rowsOf(req.id, bo.publicKey)).toEqual(['unsent-failed', 'unsent-sending']);
        // Control: the chat the list names keeps its line.
        expect(await texts('dm-bo-kai')).toEqual(['control words']);
    });

    it('a page from before his own cancel brings the line back, and the next one takes it away again', async () => {
        const req = await bosRequest('dm-bo-rhea-2');
        const first = write(req, bo, 'words he withdrew here');
        await withScreens(() => syncSingleConversation(req.id));
        // The poll in flight read the page before the cancel; the cancel empties the phone's copy as handleCancelRequest does.
        node.beforePage = async () => {
            cancel(req);
            sql.prepare('DELETE FROM messages WHERE conversation_id = ?').run(req.id);
        };
        await withScreens(() => syncSingleConversation(req.id));
        expect(rowsOf(req.id, bo.publicKey)).toEqual([first.id]);

        await withScreens(() => syncSingleConversation(req.id));
        expect(rowsOf(req.id, bo.publicKey)).toEqual([]);
    });

    it('a page asked for before the node took his new line drops none of his lines, and a line the node has stays', async () => {
        const req = await bosRequest('dm-bo-rhea-3');
        let sent = '';
        node.beforePage = async () => {
            sent = await insertMessage(req.id, bo.publicKey, 'his first words');
            await vi.waitFor(() => expect(node.lines.some((l) => l.id === sent)).toBe(true));
            await vi.waitFor(async () => expect((await getMessages(req.id)).every((m: any) => !m.sendState)).toBe(true));
        };
        await withScreens(() => syncSingleConversation(req.id));
        expect(sent).not.toBe('');
        expect(rowsOf(req.id, bo.publicKey)).toEqual([sent]);

        await withScreens(() => syncSingleConversation(req.id));
        expect(rowsOf(req.id, bo.publicKey)).toEqual([sent]);
        expect(await texts(req.id)).toEqual(['his first words']);
    });

    it('once Rhea accepts, his lines the node still has stay with hers', async () => {
        const req = await bosRequest('dm-bo-rhea-4');
        const his = write(req, bo, 'hello Rhea');
        await withScreens(() => syncSingleConversation(req.id));
        req.request = { ...req.request!, state: 'accepted' };
        const hers = write(req, rhea, 'hello Bo');
        await withScreens(() => syncSingleConversation(req.id));

        expect(rowsOf(req.id, bo.publicKey)).toEqual([his.id]);
        expect(rowsOf(req.id, rhea.publicKey)).toEqual([hers.id]);
    });
});

describe('a request waiting for Bo is counted and named nowhere but under Requests (review 4394670854)', () => {
    /** The Talk tab's number, Home's Needs you and the contact picker's Recents, as Bo's phone reads them. */
    async function counted() {
        return {
            badge: await getGlobalUnreadCount(bo.publicKey),
            needsYou: (await getUnreadByConversation(bo.publicKey)).map((c) => c.id).sort(),
            recents: (await getRecentChatMembers(bo.publicKey)).map((m: any) => m.publicKey).sort(),
        };
    }

    it('after its card preview, as before it; once he accepts, it counts as his chat', async () => {
        // A phone that holds their cards, as one that has synced the members does.
        for (const p of [kai, rhea]) sql.prepare('INSERT OR REPLACE INTO members (public_key, callsign) VALUES (?, ?)').run(p.publicKey, p.name);
        const before = await counted();
        expect(before).toEqual({ badge: 1, needsYou: ['dm-bo-kai'], recents: [kai.publicKey] });

        const req: Conv = { id: 'dm-rhea-bo-8', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'first words from Rhea');
        await withScreens(() => syncMessages(bo.publicKey));
        expect(await withScreens(() => syncSingleConversation(req.id))).toBe(true);
        // The preview wrote her people and her line (review 4393642140), so only the rule on `request` keeps it out.
        expect(rowsOf(req.id, rhea.publicKey)).toHaveLength(1);
        expect(await counted()).toEqual(before);

        req.request = { ...req.request!, state: 'ignored' };
        await withScreens(() => syncSingleConversation(req.id));
        expect(await counted()).toEqual(before);

        // Control: the same rows, accepted, are his chat and count everywhere.
        req.request = { ...req.request!, state: 'accepted' };
        await withScreens(() => syncSingleConversation(req.id));
        expect(await counted()).toEqual({ badge: 2, needsYou: ['dm-bo-kai', req.id].sort(), recents: [kai.publicKey, rhea.publicKey].sort() });
    });

    it("a request Bo made is his own chat: the person he asked is in his Recents", async () => {
        for (const p of [kai, rhea]) sql.prepare('INSERT OR REPLACE INTO members (public_key, callsign) VALUES (?, ?)').run(p.publicKey, p.name);
        const req: Conv = { id: 'dm-bo-rhea-9', participants: [bo.publicKey, rhea.publicKey], request: { state: 'pending', from: bo.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, bo, 'hello Rhea');
        await withScreens(() => syncMessages(bo.publicKey));
        await withScreens(() => syncSingleConversation(req.id));

        expect((await withScreens(() => getConversations(bo.publicKey))).map((c: any) => c.id).sort()).toEqual(['dm-bo-kai', req.id].sort());
        expect(await counted()).toEqual({ badge: 1, needsYou: ['dm-bo-kai'], recents: [kai.publicKey, rhea.publicKey].sort() });
    });
});

describe("which chats the node's list named (review 4394120110)", () => {
    it('a chat the list names is marked so; a request waiting for Bo never is, and one the list moves under requests loses it', async () => {
        expect((await getConversation('dm-bo-kai', bo.publicKey))?.listed).toBe(1);

        const req: Conv = { id: 'dm-rhea-bo-6', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'first words from Rhea');
        await withScreens(() => syncMessages(bo.publicKey));
        await withScreens(() => syncSingleConversation(req.id));
        expect((await getConversation(req.id, bo.publicKey))?.listed ?? null).toBeNull();

        const kai2: Conv = { id: 'dm-kai-bo-2', participants: [kai.publicKey, bo.publicKey], request: null };
        node.convs.push(kai2);
        write(kai2, kai, 'an ordinary chat');
        await withScreens(() => syncMessages(bo.publicKey));
        expect((await getConversation(kai2.id, bo.publicKey))?.listed).toBe(1);
        kai2.request = { state: 'pending', from: kai.publicKey, at: new Date(clock - 500).toISOString() };
        await withScreens(() => syncMessages(bo.publicKey));
        expect((await getConversation(kai2.id, bo.publicKey))?.listed ?? null).toBeNull();
    });
});

describe('the Requests list, kept per community (review 4394120364)', () => {
    const CASTLEMAINE = 'https://castlemaine.beanpool.org';
    const MULLUM_FILE = 'beanpool_mullum.beanpool.org.db';
    const CASTLEMAINE_FILE = 'community_castlemaine.db';
    async function rheaAsks(): Promise<Conv> {
        const req: Conv = { id: 'dm-rhea-bo-7', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'first words from Rhea');
        return req;
    }

    it("one community's requests are never read in another, and are still there on the way back", async () => {
        const req = await rheaAsks();
        await withScreens(() => syncMessages(bo.publicKey));
        expect((await getMessageRequests(bo.publicKey))?.conversations.map((c: any) => c.id)).toEqual([req.id]);

        h.store.set('beanpool_anchor_url', CASTLEMAINE);
        expect(await getMessageRequests(bo.publicKey)).toBeNull();

        h.store.set('beanpool_anchor_url', ANCHOR);
        expect((await getMessageRequests(bo.publicKey))?.conversations.map((c: any) => c.id)).toEqual([req.id]);
    });

    it('a list that comes back after the phone moved to another community is kept for neither', async () => {
        await withScreens(() => syncMessages(bo.publicKey));
        const before = h.store.get(messageRequestsStoreKey(bo.publicKey, MULLUM_FILE)) ?? null;
        await rheaAsks();
        node.beforeList = async () => { h.store.set('beanpool_anchor_url', CASTLEMAINE); };
        await withScreens(() => syncMessages(bo.publicKey));

        expect(h.store.get(messageRequestsStoreKey(bo.publicKey, CASTLEMAINE_FILE)) ?? null).toBeNull();
        expect(h.store.get(messageRequestsStoreKey(bo.publicKey, MULLUM_FILE)) ?? null).toBe(before);
        expect(await getMessageRequests(bo.publicKey)).toBeNull();
    });
});

describe("the pins' gate on a request the node names (review 4395542064)", () => {
    /** Bo's pins can't be read while `fn` runs, in a new run of the app (dm-line-binding.test.ts's unreadablePins). */
    async function unreadablePins<T>(fn: () => Promise<T>): Promise<T> {
        _resetDmPeerPinsForTests();
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k.startsWith(dmPeerPinsStoreKey(bo.publicKey, ''))) throw new Error('storage unavailable'); return real(k); });
        try { return await fn(); } finally { getItem.mockImplementation(real); }
    }
    const requestOf = (id: string) => (sql.prepare('SELECT request FROM conversations WHERE id = ?').get(id) as any)?.request ?? null;

    it('a DM held here: with the pins unread, the request the node names is not written, and the chat stays in the list with its composer', async () => {
        const kaiChat = node.convs.find((c) => c.id === 'dm-bo-kai')!;
        kaiChat.request = { state: 'pending', from: kai.publicKey, at: new Date(clock - 500).toISOString() };

        expect(await unreadablePins(() => withScreens(() => syncSingleConversation(kaiChat.id)))).toBe(false);
        expect(requestOf(kaiChat.id)).toBeNull();
        expect((await getConversation(kaiChat.id, bo.publicKey))?.request ?? null).toBeNull();
        expect((await withScreens(() => getConversations(bo.publicKey))).map((c: any) => c.id)).toEqual(['dm-bo-kai']);

        // Control: once the pins read, the same answer is written, so the stand-in does reach the write.
        expect(await withScreens(() => syncSingleConversation(kaiChat.id))).toBe(true);
        expect(JSON.parse(requestOf(kaiChat.id))).toMatchObject({ state: 'pending', from: kai.publicKey });
    });

    it('a DM this phone has no row of: with the pins unread, no row is written for it', async () => {
        const req: Conv = { id: 'dm-rhea-bo-gate', participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'first words from Rhea');

        expect(await unreadablePins(() => withScreens(() => syncSingleConversation(req.id)))).toBe(false);
        expect(sql.prepare('SELECT id FROM conversations WHERE id = ?').get(req.id) ?? null).toBeNull();

        // Control: once the pins read, it is written with its request.
        expect(await withScreens(() => syncSingleConversation(req.id))).toBe(true);
        expect(JSON.parse(requestOf(req.id))).toMatchObject({ state: 'pending', from: rhea.publicKey });
    });
});

describe('a decision on a request, on the phone before anything reads it (review 4395706539)', () => {
    const requestOf = (id: string) => JSON.parse((sql.prepare('SELECT request FROM conversations WHERE id = ?').get(id) as any)?.request ?? 'null');
    /** What the chat reads from the row as it opens, before its first poll answers (app/chat/[id].tsx: no lines yet). */
    const opensAs = async (id: string) => requestModeOf(await getConversation(id, bo.publicKey), bo.publicKey, null);
    const decide = (id: string, decision: 'accept' | 'ignore' | 'cancel') => withScreens(() => decideMessageRequest(id, decision));
    async function rheaAsks(id: string): Promise<Conv> {
        const req: Conv = { id, participants: [rhea.publicKey, bo.publicKey], request: { state: 'pending', from: rhea.publicKey, at: new Date(clock + 500).toISOString() } };
        node.convs.push(req);
        write(req, rhea, 'first words from Rhea');
        await withScreens(() => syncMessages(bo.publicKey));
        return req;
    }

    it('Accept on a Requests card: the chat opens on the acceptance, with no Accept card, and it is his chat', async () => {
        const req = await rheaAsks('dm-rhea-bo-acc-1');
        expect(await withScreens(() => syncSingleConversation(req.id))).toBe(true);
        // Control: the card's preview wrote the request waiting, which the chat opens as the Accept card.
        expect(await opensAs(req.id)).toBe('to-me');

        const answer = await decide(req.id, 'accept');

        expect(answer.request).toMatchObject({ state: 'accepted', from: rhea.publicKey });
        expect(requestOf(req.id)).toMatchObject({ state: 'accepted', from: rhea.publicKey });
        expect(await opensAs(req.id)).toBe('none');
        expect((await withScreens(() => getConversations(bo.publicKey))).map((c: any) => c.id).sort()).toEqual(['dm-bo-kai', req.id].sort());
    });

    it("a poll in flight when Accept lands, asked for before it, writes the acceptance and not the waiting request it read", async () => {
        const req = await rheaAsks('dm-rhea-bo-acc-2');
        await withScreens(() => syncSingleConversation(req.id));
        node.beforePage = async () => { await decide(req.id, 'accept'); };

        expect(await withScreens(() => syncSingleConversation(req.id))).toBe(true);
        expect(requestOf(req.id)).toMatchObject({ state: 'accepted' });
        expect(await opensAs(req.id)).toBe('none');

        // The next poll, asked for after it: the node's word, the same.
        await withScreens(() => syncSingleConversation(req.id));
        expect(requestOf(req.id)).toMatchObject({ state: 'accepted' });
    });

    it("the card's first preview still in flight (no row here yet) when Accept lands: the row it writes holds the acceptance", async () => {
        const req = await rheaAsks('dm-rhea-bo-acc-3');
        expect(sql.prepare('SELECT id FROM conversations WHERE id = ?').get(req.id) ?? null).toBeNull();
        node.beforePage = async () => { await decide(req.id, 'accept'); };

        await withScreens(() => syncSingleConversation(req.id));

        expect(requestOf(req.id)).toMatchObject({ state: 'accepted', from: rhea.publicKey });
        expect(await opensAs(req.id)).toBe('none');
        expect(await texts(req.id)).toEqual(['first words from Rhea']);
    });

    it('an acceptance made on his other app is never undone by a page asked for before it (core requestAfterRead)', async () => {
        const req = await rheaAsks('dm-rhea-bo-acc-4');
        await withScreens(() => syncSingleConversation(req.id));
        // While the page is on its way, he accepts on the web app and the list here hears it.
        node.beforePage = async () => {
            req.request = { ...req.request!, state: 'accepted' };
            await withScreens(() => syncMessages(bo.publicKey));
            expect(requestOf(req.id)).toMatchObject({ state: 'accepted' });
        };

        await withScreens(() => syncSingleConversation(req.id));
        expect(requestOf(req.id)).toMatchObject({ state: 'accepted' });

        // Control: a request named afresh (a new `at`) is the node's word, and is written.
        req.request = { state: 'pending', from: rhea.publicKey, at: new Date(clock + 5000).toISOString() };
        await withScreens(() => syncSingleConversation(req.id));
        expect(requestOf(req.id)).toMatchObject({ state: 'pending', at: req.request.at });
    });

    it('Ignore: the row holds what the node answered, and the chat stays out of his list', async () => {
        const req = await rheaAsks('dm-rhea-bo-ign-1');
        await withScreens(() => syncSingleConversation(req.id));

        await decide(req.id, 'ignore');

        expect(requestOf(req.id)).toMatchObject({ state: 'ignored', from: rhea.publicKey });
        expect((await withScreens(() => getConversations(bo.publicKey))).map((c: any) => c.id)).toEqual(['dm-bo-kai']);
    });

    describe('Cancel request, on his own request', () => {
        async function bosRequest(id: string): Promise<Conv> {
            const req: Conv = { id, participants: [bo.publicKey, rhea.publicKey], request: { state: 'pending', from: bo.publicKey, at: new Date(clock + 500).toISOString(), nextLineIsRequest: false } };
            node.convs.push(req);
            write(req, bo, 'his first words');
            await withScreens(() => syncMessages(bo.publicKey));
            await withScreens(() => syncSingleConversation(req.id));
            expect(requestOf(req.id)).toMatchObject({ from: bo.publicKey, nextLineIsRequest: false });
            return req;
        }

        it('the row says his next line is the request, so the chat reads it so on any reread', async () => {
            const req = await bosRequest('dm-bo-rhea-can-1');

            await decide(req.id, 'cancel');

            expect(requestOf(req.id)).toMatchObject({ state: 'pending', from: bo.publicKey, nextLineIsRequest: true });
            expect(requestModeOf(await getConversation(req.id, bo.publicKey), bo.publicKey, [])).toBe('mine-unsent');
        });

        it('a list asked for before the cancel leaves it so, and the next list says the same', async () => {
            const req = await bosRequest('dm-bo-rhea-can-2');
            node.beforeList = async () => { await decide(req.id, 'cancel'); };

            await withScreens(() => syncMessages(bo.publicKey));
            expect(requestOf(req.id)).toMatchObject({ nextLineIsRequest: true });

            await withScreens(() => syncMessages(bo.publicKey));
            expect(requestOf(req.id)).toMatchObject({ nextLineIsRequest: true });
        });

        it("the chat's poll in flight, asked for before the cancel, leaves it so", async () => {
            const req = await bosRequest('dm-bo-rhea-can-3');
            node.beforePage = async () => { await decide(req.id, 'cancel'); };

            await withScreens(() => syncSingleConversation(req.id));
            expect(requestOf(req.id)).toMatchObject({ nextLineIsRequest: true });
        });
    });
});

describe('a member who reached out while blocked (Marty, 28 Oct 2026, PR #2540: "B: shows as accepted")', () => {
    const requestOf = (id: string) => JSON.parse((sql.prepare('SELECT request FROM conversations WHERE id = ?').get(id) as any)?.request ?? 'null');
    /** Where Bo's phone has the chat, how it opens with its lines, and the Talk badge, Needs you and Recents. */
    async function seen(id: string) {
        return {
            chats: (await withScreens(() => getConversations(bo.publicKey))).some((c: any) => c.id === id),
            requests: ((await getMessageRequests(bo.publicKey))?.conversations ?? []).some((c: any) => c.id === id),
            mode: requestModeOf(await getConversation(id, bo.publicKey), bo.publicKey, await withScreens(() => getMessages(id, { limit: 50 }))),
            badge: await getGlobalUnreadCount(bo.publicKey),
            needsYou: (await getUnreadByConversation(bo.publicKey)).some((c) => c.id === id),
            recents: (await getRecentChatMembers(bo.publicKey)).map((m: any) => m.publicKey),
        };
    }
    /** Bo writes to `other` (his own request, waiting), then `other` writes and the node answers him `answered`. */
    async function reachOutThenTheyWrite(id: string, other: Person) {
        const at = new Date(clock + 500).toISOString();
        const conv: Conv = { id, participants: [other.publicKey, bo.publicKey], request: { state: 'pending', from: bo.publicKey, at, nextLineIsRequest: false } };
        node.convs.push(conv);
        write(conv, bo, 'are you still there?');
        await withScreens(() => syncMessages(bo.publicKey));
        await withScreens(() => syncSingleConversation(id));
        const before = await seen(id);
        write(conv, other, 'sorry, yes');
        conv.request = { state: 'accepted', from: bo.publicKey, at };
        await withScreens(() => syncMessages(bo.publicKey));
        await withScreens(() => syncSingleConversation(id));
        return { at, before, after: await seen(id), texts: await texts(id) };
    }

    it('a blocked member who reached out sees their request accepted when the blocker writes; nothing tells them they are blocked', async () => {
        // Rhea cancelled her request to Bo and blocked him; Bo wrote (his own request, kept for him alone, which he reads as
        // his, waiting); then Rhea wrote. The node answers Bo as it answers a member nobody blocked (test-dm-request-cancel
        // step 11, where Kai stands for one): his own request accepted, at the time he reached out, her line an ordinary one.
        // His phone keeps the chat among his chats at every step, never under Requests, opens it with the composer, and counts
        // her line, exactly as for Kai's.
        for (const p of [kai, rhea]) sql.prepare('INSERT OR REPLACE INTO members (public_key, callsign) VALUES (?, ?)').run(p.publicKey, p.name);
        const blocked = await reachOutThenTheyWrite('dm-rhea-bo-b1', rhea);
        expect(blocked.before).toMatchObject({ chats: true, requests: false, mode: 'mine-waiting' });
        expect(blocked.after).toMatchObject({ chats: true, requests: false, mode: 'none', needsYou: true });
        expect(blocked.after.recents).toContain(rhea.publicKey);
        expect(requestOf('dm-rhea-bo-b1')).toEqual({ state: 'accepted', from: bo.publicKey, at: blocked.at });
        expect(blocked.texts).toEqual(expect.arrayContaining(['are you still there?', 'sorry, yes']));

        const control = await reachOutThenTheyWrite('dm-kai-bo-b2', kai);
        const asSeen = (s: Awaited<ReturnType<typeof seen>>, who: Person) => ({ ...s, badge: undefined, recents: s.recents.includes(who.publicKey) });
        expect(asSeen(blocked.after, rhea)).toEqual(asSeen(control.after, kai));
        expect(asSeen(blocked.before, rhea)).toEqual(asSeen(control.before, kai));
        expect(control.after.badge).toBe(blocked.after.badge + 1);
    });
});
