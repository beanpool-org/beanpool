import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// What the node operator can do to a direct message, measured on the phone (crypto review M F2, 2026-10-02).
//
// Until now a DM line's associated data was its conversation id alone, under one key both ways, so the node could show
// Ana's line as Ben's, store it again as a new message, put it in another conversation, or reorder the thread, and the
// other phone showed every one as genuine. Now the phone seals each line to its sender, its message id and its part,
// with the line it was written after, and reads every thread through one check.
//
// Ana's lines leave her phone through the real send path (utils/db.ts insertMessage, sendImageMessage, editMessage);
// Ben's phone takes them through its real sync and shows them through getMessages, over the phone's real schema in an
// in-memory SQLite (node:sqlite), as deleted-account-lines.test.ts does. The node is a stand-in that answers as the real
// one does and then does, to the stored lines, what its operator could. The real node keeping a line's id, author,
// ciphertext and nonce verbatim is checked over HTTPS in apps/server (test-dm-never-plaintext, test-dm-line-relay).

const h = vi.hoisted(() => ({
    cacheDir: '',
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
}));

// One database per community file, kept for the file's life, as a phone keeps one file per community (utils/nodes.ts
// getDatabaseFilenameForNode, chosen by beanpool_anchor_url; db.ts getDb reopens on a switch and runs the schema init).
// `sql` below is whichever community is active. `onQuery`: a test's hook on a handle's reads (#1872/#1873 confirmation 3).
vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dbs = new Map<string, any>();
    const dbFor = (name: string) => { let d = dbs.get(name); if (!d) dbs.set(name, (d = new DatabaseSync(':memory:'))); return d; };
    const nameOfUrl = (url: string | null | undefined) => (url && url.includes('castlemaine') ? 'community_castlemaine.db' : 'beanpool_mullum.beanpool.org.db');
    const phoneDbs = { dbFor, nameOfUrl, dbs, onQuery: null as null | ((file: string, q: string) => void | Promise<void>) };
    (globalThis as any).__phoneDbs = phoneDbs;
    (globalThis as any).__phoneSql = new Proxy({}, { get: (_t, p) => { const d = dbFor(nameOfUrl(h.store.get('beanpool_anchor_url'))); const v = (d as any)[p]; return typeof v === 'function' ? v.bind(d) : v; } });
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    const adapterFor = (name: string) => {
        const sql = dbFor(name);
        return {
            runAsync: vi.fn(async (q: string, p?: unknown) => {
                const r = sql.prepare(q).run(...params(p));
                return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
            }),
            execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
            getAllAsync: vi.fn(async (q: string, p?: unknown) => {
                const rows = sql.prepare(q).all(...params(p));
                if (phoneDbs.onQuery) await phoneDbs.onQuery(name, q);
                return rows;
            }),
            getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
            closeAsync: vi.fn(async () => {}),
            withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
        };
    };
    return { openDatabaseAsync: vi.fn(async (name: string) => adapterFor(name)) };
});
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const nodeOs = await import('node:os');
    const nodePath = await import('node:path');
    if (!h.cacheDir) h.cacheDir = nodeFs.mkdtempSync(nodePath.join(process.env.TMPDIR || nodeOs.tmpdir(), 'bp-dm-binding-'));
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        cacheDirectory: `file://${h.cacheDir}/`,
        EncodingType: { Base64: 'base64' },
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)) })),
        deleteAsync: vi.fn(async (uri: string) => { nodeFs.rmSync(local(uri), { force: true }); }),
        makeDirectoryAsync: vi.fn(async (uri: string) => { nodeFs.mkdirSync(local(uri), { recursive: true }); }),
        writeAsStringAsync: vi.fn(async (uri: string, data: string) => { nodeFs.writeFileSync(local(uri), data); }),
        moveAsync: vi.fn(async () => {}),
    };
});
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn((url: string | null) => (url && url.includes('castlemaine') ? 'community_castlemaine.db' : 'beanpool_mullum.beanpool.org.db')), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { getDb, getMessages, syncMessages, syncSingleConversation, createConversationApi, insertMessage, editMessage, sendImageMessage, getDecryptedAttachment, getConversations, getConversationKind, getConversation, isHeldGroupChat, knownDmConversationId, groupScreenKeyringFor, isDmKeyChangePending, isDmUnplaced, _resetDmPeerPinsForTests } from '../db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { refusedSendNotice } from '../dm-lock';
import { DM_PIN_STORE_UNREAD_TEXT } from '../dm-peer-pins';
import { routeChat } from '../chat-route';
import { dmQuoteFor } from '../chat-actions';
import { GROUP_KEYS_FOR_DM_TEXT } from '../group-chat-lines';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { dmPeerPinsStoreKey, dmLinesAtUpdateStoreKey, dmConversationsSeenStoreKey } from '../storage-keys';
import { encryptDmFormat2 } from '../e2e-crypto';
import * as phoneCrypto from '../e2e-crypto';
// The web app's own modules, as its MessagesPage uses them: what it seals, and how it reads a thread.
import * as webCrypto from '../../../pwa/src/lib/e2e-crypto';
import { lockForDm, payloadForChat } from '../../../pwa/src/lib/dm-lock';
import { toEd25519Pkcs8, makeKeySuccession, deriveDmKey, dmLineAad, DM_NONCE_PREFIX } from '@beanpool/core';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hexToBytes } from '@noble/hashes/utils.js';

const sql = (globalThis as any).__phoneSql as import('node:sqlite').DatabaseSync;

// A send that goes through ends with require('react-native') for a DeviceEventEmitter nudge, after insertMessage has
// returned: answered at node's loader for the whole file, so a delivery finishes as it does on a phone.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(h.cacheDir, { recursive: true, force: true });
});

const ANCHOR = 'https://mullum.beanpool.org';
/** What the phone shows in place of a line that doesn't open: never the words, never as anyone's. */
const NOT_VERIFIED = "🔒 This message couldn't be verified, so it isn't shown.";

interface Person { name: string; publicKey: string; privateKey: string }
function person(name: string): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { name, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── The node ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Line {
    id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string;
    type: string; systemType: string | null; metadata: string | null; timestamp: string; editedAt: string | null;
}
interface Conv { id: string; type: string; participants: string[]; formerKeys?: Record<string, unknown[]> }
const node = {
    lines: [] as Line[],
    convs: [] as Conv[],
    photos: new Map<string, { data: string; nonce: string }>(),
    /** The node answering every send 503 (a phone's send then stays on it as failed). */
    refuseSends: false,
    /** The lines the node serves for a conversation, in its order (default: its newest 50 by time, oldest first). */
    serve: null as null | ((conv: Conv) => Line[]),
};
let clock = Date.parse('2026-10-01T09:00:00.000Z');
const tick = () => new Date(clock += 60_000).toISOString();

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

/** The routes the phone's DM paths use, answered as routes/messaging.ts answers them. */
const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (method === 'POST' && u.pathname === '/api/messages/send') {
        if (node.refuseSends) return answer(503, { error: 'Service unavailable' });
        const b = JSON.parse(init.body);
        const id = typeof b.id === 'string' ? b.id.toLowerCase() : randomUUID();   // the node keeps a client's UUID v4, lowered
        const line: Line = {
            id, conversationId: b.conversationId, authorPubkey: b.authorPubkey, ciphertext: b.ciphertext, nonce: b.nonce,
            type: b.type ?? 'text', systemType: null, metadata: b.metadata ?? null, timestamp: tick(), editedAt: null,
        };
        node.lines.push(line);
        if (b.attachment) node.photos.set(id, { data: b.attachment.data, nonce: b.attachment.nonce });
        return answer(200, { success: true, message: line });
    }
    if (method === 'POST' && u.pathname === '/api/messages/edit') {
        const b = JSON.parse(init.body);
        const line = node.lines.find((l) => l.id === b.messageId)!;
        Object.assign(line, { ciphertext: b.ciphertext, nonce: b.nonce, editedAt: tick() });
        return answer(200, { success: true, message: line });
    }
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        const mine = node.convs.filter((c) => c.participants.includes(list[1]));
        return answer(200, {
            conversations: mine.map((c) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-10-01T00:00:00.000Z', ...(c.formerKeys ? { formerKeys: c.formerKeys } : {}) })),
            totalUnread: 0,
            deletedAccounts: [],
        });
    }
    const photo = u.pathname.match(/^\/api\/messages\/([^/]+)\/attachment$/);
    if (photo) {
        const p = node.photos.get(photo[1]);
        return p ? answer(200, p) : answer(404, { error: 'not found' });
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page) {
        const conv = node.convs.find((c) => c.id === page[1]);
        if (!conv) return answer(404, { error: 'Conversation not found' });
        const lines = node.serve ? node.serve(conv) : node.lines.filter((l) => l.conversationId === conv.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-50);
        return answer(200, { conversation: { id: conv.id, type: conv.type, participants: conv.participants }, messages: lines.map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

// ── The phones ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pick up a phone: everything another phone left in the database goes, and this one syncs from the node. `keepPhotos`:
 * the same phone after a wipe-and-fetch, its decrypted photo cache kept (it lives in the filesystem, by design).
 */
async function phoneOf(who: Person, opts: { keepPhotos?: boolean } = {}): Promise<void> {
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    if (!opts.keepPhotos) fs.rmSync(`${h.cacheDir}/chat-images`, { recursive: true, force: true });
    h.me = { publicKey: who.publicKey, privateKey: who.privateKey };
    await syncMessages(who.publicKey);
}

/**
 * The app started again (an update, or a phone restored from the 12 words): the DM pins are read from storage afresh.
 * The phone holds one copy of them in memory for its run (#1872 review, finding 6), so a test that changes the stored pins
 * behind the app's back models them being met at the next start.
 */
const restarted = () => _resetDmPeerPinsForTests();

/** The community file the tests' anchor (mullum) opens: the held lines' key names it (§3.4 amendment 5). */
const FILE_A = 'beanpool_mullum.beanpool.org.db';

/**
 * The phone as a build without pins left it, or a restored one: no pin store in any community file (whose presence is the
 * record of that file's seed), and none of the lines the update held in any community file (db.ts keeps them beside the
 * pins, written only by a build with pins).
 */
const noPinStore = (who: Person) => {
    for (const k of [...h.store.keys()]) if (k.startsWith(dmPeerPinsStoreKey(who.publicKey, '')) || k.startsWith(dmLinesAtUpdateStoreKey(who.publicKey, ''))) h.store.delete(k);
};

/** One account's DM guard list in one community file (§3.4 amendment 7 §3: one per account and file). */
const dmSeenKey = (who: Person, file = FILE_A) => dmConversationsSeenStoreKey(who.publicKey, file);

/** One account's stored pins in one community file, { conversation id → pin } (the stored value is { pins }: §3.4 amendment 6). */
const storedPins = (who: Person, file = FILE_A): Record<string, any> => JSON.parse(h.store.get(dmPeerPinsStoreKey(who.publicKey, file)) ?? '{"pins":{}}').pins;
/** Change one account's stored pins in one file behind the app's back (what slice 2's Continue writes, a pin lost). */
function editStoredPins(who: Person, change: (pins: Record<string, any>) => void, file = FILE_A): void {
    const value = JSON.parse(h.store.get(dmPeerPinsStoreKey(who.publicKey, file))!);
    change(value.pins);
    h.store.set(dmPeerPinsStoreKey(who.publicKey, file), JSON.stringify(value));
}

/** Send a line from the phone in hand, through the real send path, and wait for the node to have it. */
async function says(who: Person, conv: Conv, text: string): Promise<Line> {
    const before = node.lines.length;
    await insertMessage(conv.id, who.publicKey, text);
    await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
    await vi.waitFor(async () => expect((await getMessages(conv.id)).every((m: any) => !m.sendState)).toBe(true));
    return node.lines[node.lines.length - 1];
}

/** The thread as the phone in hand shows it: each line's words and the note under it. */
async function shows(conv: Conv): Promise<Array<{ id: string; from: string; text: string; note: string | null }>> {
    await syncMessages(h.me.publicKey);
    return (await getMessages(conv.id)).map((m: any) => ({ id: m.id, from: m.senderId, text: m.text, note: m.integrityNote ?? null }));
}
const lineOf = async (conv: Conv, id: string) => (await shows(conv)).find((l) => l.id === id)!;
/** One line as the chat screen draws it: in its author's bubble, or in the middle of the chat as nobody's. */
async function drawn(conv: Conv, id: string, opts: { limit?: number } = {}) {
    await syncMessages(h.me.publicKey);
    const m = (await getMessages(conv.id, opts)).find((x: any) => x.id === id) as any;
    return { text: m?.text, note: m?.integrityNote ?? null, unattributed: !!m?.unattributed };
}
const preview = async (who: Person, conv: Conv) => (await getConversations(who.publicKey)).find((c: any) => c.id === conv.id)?.lastMessage;
const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');
const NOT_ENCRYPTED = "⚠️ This message wasn't encrypted, so BeanPool can't confirm who wrote it. It isn't shown.";
const OLD_APP = "Sent from an older version of the app: BeanPool can't confirm who wrote it.";
/** A row the operator writes into the node's database, in someone's name. */
function written(conv: Conv, from: Person, ciphertext: string, nonce: string, extra: Partial<Line> = {}): Line {
    const line: Line = {
        id: randomUUID(), conversationId: conv.id, authorPubkey: from.publicKey, ciphertext, nonce, type: 'text', systemType: null,
        metadata: null, timestamp: tick(), editedAt: null, ...extra,
    };
    node.lines.push(line);
    return line;
}

let ana: Person;
let ben: Person;
let dm: Conv;

beforeEach(async () => {
    // Call history only (implementations stay): the database and store mocks keep every argument and result otherwise,
    // and the cap tests (Z1, Z3, Z10, R4) move megabytes through them, past the worker's heap over the whole file.
    vi.clearAllMocks();
    h.store.clear();
    h.store.set('beanpool_anchor_url', ANCHOR);
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    ana = person('Ana');
    ben = person('Ben');
    dm = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
    Object.assign(node, { lines: [], convs: [dm], photos: new Map(), refuseSends: false, serve: null });
    (globalThis as any).fetch = fetchMock;
    await getDb();
});

/** Ana asks, Ben answers: each from their own phone, each line written after the one before it. */
async function aQuestionAndAnAnswer() {
    await phoneOf(ana);
    const question = await says(ana, dm, 'Shall I cancel the order?');
    await phoneOf(ben);
    const answer = await says(ben, dm, 'No');
    return { question, answer };
}

describe('a line as it was sent', () => {
    it('opens on the other phone, from its sender, unmarked', async () => {
        const { question, answer } = await aQuestionAndAnAnswer();
        await phoneOf(ana);
        expect(await shows(dm)).toEqual([
            { id: question.id, from: ana.publicKey, text: 'Shall I cancel the order?', note: null },
            { id: answer.id, from: ben.publicKey, text: 'No', note: null },
        ]);
        // and in the conversation list's preview
        expect((await getConversations(ana.publicKey)).find((c: any) => c.id === dm.id)?.lastMessage).toBe('No');
    });
});

describe('what the node can do to it', () => {
    it('show Ana\'s line as Ben\'s: Ben\'s phone never shows her words as his', async () => {
        await phoneOf(ana);
        const line = await says(ana, dm, 'I will pay you 50 Beans');
        line.authorPubkey = ben.publicKey;
        await phoneOf(ben);
        const shown = await lineOf(dm, line.id);
        expect(shown.text).toBe(NOT_VERIFIED);
        expect(JSON.stringify(await shows(dm))).not.toContain('50 Beans');
        expect((await getConversations(ben.publicKey)).find((c: any) => c.id === dm.id)?.lastMessage).toBe('🔒 Encrypted message');
    });

    it('store it again as a new message: the copy doesn\'t open', async () => {
        await phoneOf(ana);
        const line = await says(ana, dm, 'Yes, go ahead');
        const copy = { ...line, id: randomUUID(), timestamp: tick() };
        node.lines.push(copy);
        await phoneOf(ben);
        expect((await lineOf(dm, line.id)).text).toBe('Yes, go ahead');
        expect((await lineOf(dm, copy.id)).text).toBe(NOT_VERIFIED);
    });

    it('put it in another conversation: refused there, pointer or not', async () => {
        await phoneOf(ana);
        const line = await says(ana, dm, 'Yes, go ahead');
        const cat = person('Cat');
        // Another pair's conversation: Cat's phone can't open it at all.
        const withCat: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, cat.publicKey] };
        // A second conversation of Ana and Ben's, the line in it under a new id, its metadata pointing back at the first.
        const again: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs.push(withCat, again);
        node.lines.push({ ...line, id: randomUUID(), conversationId: withCat.id, timestamp: tick() });
        const moved = { ...line, id: randomUUID(), conversationId: again.id, timestamp: tick(), metadata: JSON.stringify({ originalConversationId: dm.id }) };
        node.lines.push(moved);

        await phoneOf(cat);
        expect((await shows(withCat)).map((l) => l.text)).toEqual([NOT_VERIFIED]);
        await phoneOf(ben);
        expect((await shows(again)).map((l) => l.text)).toEqual([NOT_VERIFIED]);
    });

    it('reorder Ben\'s answer before Ana\'s question: the answer is marked on both phones', async () => {
        const { question, answer } = await aQuestionAndAnAnswer();
        [question.timestamp, answer.timestamp] = [answer.timestamp, question.timestamp];
        for (const who of [ana, ben]) {
            await phoneOf(who);
            const thread = await shows(dm);
            expect(thread.map((l) => l.id)).toEqual([answer.id, question.id]);   // as the node now orders them
            expect(thread[0]).toMatchObject({ text: 'No', note: 'Shown out of the order it was written in.' });
            expect(thread[1].note).toBeNull();
        }
    });

    it('swap a photo for another of Ana\'s: the swapped one stays locked, the right one opens', async () => {
        await phoneOf(ana);
        await sendImageMessage(dm.id, 'data:image/jpeg;base64,QUFBQQ==', '');
        await sendImageMessage(dm.id, 'data:image/jpeg;base64,QkJCQg==', '');
        const [first, second] = node.lines.slice(-2);
        await phoneOf(ben);
        await shows(dm);
        const firstPhoto = node.photos.get(first.id)!;
        node.photos.set(first.id, node.photos.get(second.id)!);
        expect(await getDecryptedAttachment(dm.id, first.id)).toBeNull();
        node.photos.set(first.id, firstPhoto);
        expect(await getDecryptedAttachment(dm.id, first.id)).toMatch(/chat-images\//);
        expect(fs.readFileSync(`${h.cacheDir}/chat-images/${first.id}.jpg`, 'utf8')).toBe('QUFBQQ==');
    });
});

describe('an edit', () => {
    it('opens on the other phone, in place, unmarked', async () => {
        const { question, answer } = await aQuestionAndAnAnswer();
        await phoneOf(ana);
        await editMessage(dm.id, question.id, 'Shall I cancel the whole order?');
        await phoneOf(ben);
        expect(await shows(dm)).toEqual([
            { id: question.id, from: ana.publicKey, text: 'Shall I cancel the whole order?', note: null },
            { id: answer.id, from: ben.publicKey, text: 'No', note: null },
        ]);
    });
});

describe('old lines (written before this change)', () => {
    /** A line an app from before wrote: format 2, bound to the conversation alone. */
    function oldLine(from: Person, to: Person, text: string): Line {
        const line: Line = {
            id: randomUUID(), conversationId: dm.id, authorPubkey: from.publicKey, type: 'text', systemType: null, metadata: null,
            timestamp: tick(), editedAt: null,
            ...encryptDmFormat2(text, { myEdPrivHex: from.privateKey, peerEdPubHex: to.publicKey, conversationId: dm.id }),
        };
        node.lines.push(line);
        return line;
    }

    it('still open, and every one is marked, wherever it sits and whoever it names: nothing in it proves who wrote it', async () => {
        const seeYou = oldLine(ana, ben, 'see you at 6');
        const ok = oldLine(ben, ana, 'ok');
        await phoneOf(ana);
        const here = await says(ana, dm, "I'm here");
        const replay = { ...seeYou, id: randomUUID(), timestamp: tick() };
        node.lines.push(replay);
        const bensOld = oldLine(ben, ana, 'on my way');   // Ben still on an old app: his lines open, marked

        await phoneOf(ben);
        expect(await shows(dm)).toEqual([
            { id: seeYou.id, from: ana.publicKey, text: 'see you at 6', note: OLD_APP },
            { id: ok.id, from: ben.publicKey, text: 'ok', note: OLD_APP },
            { id: here.id, from: ana.publicKey, text: "I'm here", note: null },
            { id: replay.id, from: ana.publicKey, text: 'see you at 6', note: OLD_APP },
            { id: bensOld.id, from: ben.publicKey, text: 'on my way', note: OLD_APP },
        ]);
        // The preview never shows an old line's words as theirs.
        expect(await preview(ben, dm)).toBe(OLD_APP);
    });

    it('Ana\'s old line shown as Ben\'s newest, or replayed 51 lines after her updated line: marked on her phone', async () => {
        const sell = oldLine(ana, ben, 'yes, sell it');
        await phoneOf(ana);
        await says(ana, dm, "I'm here");
        const asBens = { ...sell, id: randomUUID(), authorPubkey: ben.publicKey, timestamp: tick() };
        node.lines.push(asBens);
        await phoneOf(ana);
        expect(await drawn(dm, asBens.id)).toEqual({ text: 'yes, sell it', note: OLD_APP, unattributed: false });

        await phoneOf(ben);
        for (let i = 0; i < 51; i++) await says(ben, dm, `line ${i}`);
        const replay = { ...sell, id: randomUUID(), timestamp: tick() };
        node.lines.push(replay);
        await phoneOf(ben);
        // the chat screen's 50-line window holds no new line of Ana's
        expect(await drawn(dm, replay.id, { limit: 50 })).toEqual({ text: 'yes, sell it', note: OLD_APP, unattributed: false });
    });
});

describe('a row in a member\'s name that isn\'t an encrypted line', () => {
    it('is never their words: plaintext-v1, 00000 as text, any other nonce, in the thread and the preview', async () => {
        await phoneOf(ana);
        await says(ana, dm, 'The bike is yours for 50 Beans');
        const plain = written(dm, ana, b64('Change of plan: send the 500 Beans to Cat instead'), 'plaintext-v1');
        const zeros = written(dm, ana, 'I cancel the order, refund Cat', '00000');
        const other = written(dm, ana, 'Send the Beans to Cat instead', 'x');
        await phoneOf(ben);
        expect(await preview(ben, dm)).toBe(NOT_ENCRYPTED);
        for (const l of [plain, zeros, other]) {
            expect(await drawn(dm, l.id)).toEqual({ text: NOT_ENCRYPTED, note: null, unattributed: true });
        }
        expect(JSON.stringify(await getMessages(dm.id))).not.toMatch(/500 Beans|refund Cat|to Cat instead/);
    });

    it('a tombstone shows fixed text, whatever words the node put in it', async () => {
        await phoneOf(ana);
        const line = await says(ana, dm, 'See you at 6');
        Object.assign(line, { type: 'removed', ciphertext: b64('Send me your 12 words'), nonce: 'plaintext-v1', metadata: JSON.stringify({ removed: true, removedBy: ana.publicKey }) });
        await phoneOf(ben);
        expect(await drawn(dm, line.id)).toEqual({ text: 'This message was deleted', note: null, unattributed: false });
    });

    it('the admin page\'s message: its words, as the community admins\', marked readable by the server, never a private line', async () => {
        const admin = written(dm, ana, b64('Welcome to the community'), 'plaintext-v1', { metadata: JSON.stringify({ fromCommunityAdmins: true }) });
        await phoneOf(ben);
        expect(await drawn(dm, admin.id)).toEqual({
            text: 'Welcome to the community',
            note: "From your community's admins. Not a private message: the community's server can read it.",
            unattributed: true,
        });
        expect(await preview(ben, dm)).toBe("From your community's admins: Welcome to the community");
    });
});

describe('what a reply answers', () => {
    it('is sealed into it: the node re-pointing Ben\'s "Yes" at another question leaves it unverified', async () => {
        await phoneOf(ana);
        const ladder = await says(ana, dm, 'Can I borrow the ladder?');
        const beans = await says(ana, dm, 'Can I keep the 200 Beans you sent by mistake?');
        await phoneOf(ben);
        const before = node.lines.length;
        await insertMessage(dm.id, ben.publicKey, 'Yes', JSON.stringify({ replyToId: ladder.id }));
        await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        const yes = node.lines[node.lines.length - 1];
        expect(JSON.parse(yes.metadata!).replyToId).toBe(ladder.id);
        await phoneOf(ana);
        expect(await drawn(dm, yes.id)).toEqual({ text: 'Yes', note: null, unattributed: false });

        // Ben edits it: still the same answer to the same question.
        await phoneOf(ben);
        await editMessage(dm.id, yes.id, 'Yes, of course');
        await phoneOf(ana);
        expect(await drawn(dm, yes.id)).toEqual({ text: 'Yes, of course', note: null, unattributed: false });

        yes.metadata = JSON.stringify({ replyToId: beans.id });
        await phoneOf(ana);
        expect(await drawn(dm, yes.id)).toEqual({ text: NOT_VERIFIED, note: null, unattributed: true });
        yes.metadata = null;
        await phoneOf(ana);
        expect((await drawn(dm, yes.id)).text).toBe(NOT_VERIFIED);
    });

    it('a photo sent as a reply opens, and its words and photo both stay bound to what it answers', async () => {
        await phoneOf(ana);
        const q = await says(ana, dm, 'Which one?');
        await phoneOf(ben);
        await sendImageMessage(dm.id, 'data:image/jpeg;base64,UkVQTFk=', 'this one', JSON.stringify({ replyToId: q.id }));
        const pic = node.lines[node.lines.length - 1];
        await phoneOf(ana);
        expect(await drawn(dm, pic.id)).toEqual({ text: 'this one', note: null, unattributed: false });
        expect(await getDecryptedAttachment(dm.id, pic.id)).toMatch(/chat-images\//);
    });
});

describe('the quote in a verified reply, after the node rewrites the row it answers (keeping its id)', () => {
    /** Ana asks, Ben answers it as a reply from his phone: the reply is sealed to what it answers. */
    async function askedAndAnswered(question: () => Promise<Line>) {
        const q = await question();
        await phoneOf(ben);
        const before = node.lines.length;
        await insertMessage(dm.id, ben.publicKey, 'Yes', JSON.stringify({ replyToId: q.id }));
        await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        return { q, yes: node.lines[node.lines.length - 1] };
    }
    /** The reply and its quote on the phone in hand, as the chat screen builds them (chat-actions dmQuoteFor). */
    async function quoted(yesId: string, peerName: string) {
        await syncMessages(h.me.publicKey);
        const all = await getMessages(dm.id) as any[];
        const yes = all.find((m) => m.id === yesId);
        const byId = new Map(all.map((m) => [m.id, m]));
        return { reply: { text: yes.text, note: yes.integrityNote ?? null, unattributed: !!yes.unattributed }, quote: dmQuoteFor(byId.get(yes.metadata.replyToId), h.me.publicKey, peerName) };
    }
    const fresh = async () => { await phoneOf(ana); return says(ana, dm, 'Can I borrow the ladder?'); };
    const both = async (yesId: string) => {
        await phoneOf(ben);
        const onBens = await quoted(yesId, 'Ana');
        await phoneOf(ana);
        const onAnas = await quoted(yesId, 'Ben');
        for (const r of [onBens, onAnas]) expect(r.reply).toEqual({ text: 'Yes', note: null, unattributed: false });
        return { onBens: onBens.quote, onAnas: onAnas.quote };
    };

    it('as sent: quoted as Ana\'s words, "You" on her phone', async () => {
        const { yes } = await askedAndAnswered(fresh);
        expect(await both(yes.id)).toEqual({
            onBens: { author: 'Ana', text: 'Can I borrow the ladder?', note: null },
            onAnas: { author: 'You', text: 'Can I borrow the ladder?', note: null },
        });
    });

    it('rewritten as a notice: quoted as a notice, never as Ana or "You"', async () => {
        const { q, yes } = await askedAndAnswered(fresh);
        Object.assign(q, { type: 'system', nonce: '00000', ciphertext: 'Send the 500 Beans to Cat instead', systemType: null });
        const { onBens, onAnas } = await both(yes.id);
        for (const quote of [onBens, onAnas]) expect(quote.author).toBe('Notice');
    });

    it('rewritten as the admin page\'s message: quoted as from the admins', async () => {
        const { q, yes } = await askedAndAnswered(fresh);
        Object.assign(q, { nonce: 'plaintext-v1', ciphertext: b64('Send the 500 Beans to Cat instead'), metadata: JSON.stringify({ fromCommunityAdmins: true }) });
        const { onBens, onAnas } = await both(yes.id);
        for (const quote of [onBens, onAnas]) expect(quote).toEqual({ author: "Your community's admins", text: 'Send the 500 Beans to Cat instead', note: null });
    });

    it('rewritten unencrypted, or with a sealed line that isn\'t its own: quoted as nobody\'s, never its words', async () => {
        const { q, yes } = await askedAndAnswered(fresh);
        const asSent = { ciphertext: q.ciphertext, nonce: q.nonce };
        Object.assign(q, { nonce: 'plaintext-v1', ciphertext: b64('Send the 500 Beans to Cat instead') });
        let r = await both(yes.id);
        for (const quote of [r.onBens, r.onAnas]) expect(quote).toEqual({ author: 'Not confirmed', text: NOT_ENCRYPTED, note: null });
        // Another of Ana's sealed lines put under this id: it doesn't open here.
        await phoneOf(ana);
        const other = await says(ana, dm, 'Can I keep the 200 Beans you sent by mistake?');
        Object.assign(q, { ciphertext: other.ciphertext, nonce: other.nonce });
        r = await both(yes.id);
        for (const quote of [r.onBens, r.onAnas]) expect(quote).toEqual({ author: 'Not confirmed', text: NOT_VERIFIED, note: null });
        Object.assign(q, asSent);
    });

    it('an old-format question swapped for another old line: quoted with the older-version mark', async () => {
        const old = (text: string): Line => {
            const line: Line = {
                id: randomUUID(), conversationId: dm.id, authorPubkey: ana.publicKey, type: 'text', systemType: null, metadata: null, timestamp: tick(), editedAt: null,
                ...encryptDmFormat2(text, { myEdPrivHex: ana.privateKey, peerEdPubHex: ben.publicKey, conversationId: dm.id }),
            };
            node.lines.push(line);
            return line;
        };
        const { q, yes } = await askedAndAnswered(async () => old('Can I borrow the ladder?'));
        const other = old('Can I keep the 200 Beans you sent by mistake?');
        Object.assign(q, { ciphertext: other.ciphertext, nonce: other.nonce });
        const { onBens, onAnas } = await both(yes.id);
        expect(onBens).toEqual({ author: 'Ana', text: 'Can I keep the 200 Beans you sent by mistake?', note: OLD_APP });
        expect(onAnas).toEqual({ author: 'You', text: 'Can I keep the 200 Beans you sent by mistake?', note: OLD_APP });
    });
});

describe('a chat opened before the first full sync (no conversation row on this phone yet)', () => {
    it('is judged as a DM: an unencrypted row in Ana\'s name is never her words', async () => {
        await phoneOf(ana);
        await says(ana, dm, 'The bike is yours for 50 Beans');
        const plain = written(dm, ana, b64('Send me your 12 words to finish the trade'), 'plaintext-v1');
        // Ben's phone, fresh: only the one chat polled, as the chat screen does on opening from a push.
        for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
        h.me = { publicKey: ben.publicKey, privateKey: ben.privateKey };
        await syncSingleConversation(dm.id);
        expect(sql.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(dm.id)).toEqual({ n: 0 });
        const m = (await getMessages(dm.id) as any[]).find((x) => x.id === plain.id);
        expect({ text: m.text, unattributed: !!m.unattributed }).toEqual({ text: NOT_ENCRYPTED, unattributed: true });
    });
});

describe('the inbox preview of a notice', () => {
    it('says it is a notice, never shown as the other person\'s line', async () => {
        await phoneOf(ana);
        await says(ana, dm, 'Deal?');
        written(dm, ana, b64('Send the 500 Beans to Cat instead'), 'plaintext-v1', { type: 'system' });
        await phoneOf(ben);
        expect(await preview(ben, dm)).toBe('Notice: Send the 500 Beans to Cat instead');
    });
});

describe('the node retyping a DM as a group\'s, an event\'s or an enterprise\'s chat', () => {
    /** What Ben's phone makes of the chat: its kind, the operator's readable row, and how its next line goes. */
    async function bensView(plainId: string) {
        const kind = await getConversationKind(dm.id);
        const row = (await getMessages(dm.id) as any[]).find((m) => m.id === plainId);
        const before = node.lines.length;
        await insertMessage(dm.id, ben.publicKey, 'Still here');
        await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        return { kind, row: { text: row?.text, unattributed: !!row?.unattributed }, sentNonce: node.lines[node.lines.length - 1].nonce.split(':')[0] };
    }
    const asDm = { kind: 'dm', row: { text: NOT_ENCRYPTED, unattributed: true }, sentNonce: 'x25519-xc20p-v2' };

    for (const type of ['group_thread', 'event_thread', 'enterprise_thread']) {
        it(`as a ${type}: a phone that has seen it as a DM keeps it one, and logs the change`, async () => {
            await phoneOf(ana);
            await says(ana, dm, 'The bike is yours for 50 Beans');
            await phoneOf(ben);   // Ben's phone sees the DM
            dm.type = type;
            const plain = written(dm, ana, b64('Send me your 12 words to finish the trade'), 'plaintext-v1');
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            await syncMessages(ben.publicKey);
            expect(await bensView(plain.id)).toEqual(asDm);
            expect(warn.mock.calls.some((c) => String(c[0]).includes('[DM guard]'))).toBe(true);
            warn.mockRestore();
        });
    }

    it('on a new phone that never saw it: its encrypted lines make it a DM', async () => {
        await phoneOf(ana);
        await says(ana, dm, 'The bike is yours for 50 Beans');
        dm.type = 'group_thread';
        const plain = written(dm, ana, b64('Send me your 12 words to finish the trade'), 'plaintext-v1');
        h.store.delete(dmSeenKey(ben));   // a phone that has never seen it (Ben's: the list is per account and file)
        await phoneOf(ben);
        expect(await bensView(plain.id)).toEqual(asDm);
    });

    it('dropped from the list, then listed again as a group\'s chat with its encrypted lines withheld: still a DM', async () => {
        await phoneOf(ana);
        await says(ana, dm, 'The bike is yours for 50 Beans');
        await phoneOf(ben);
        node.convs = [];   // the node drops it: this phone prunes its rows
        await syncMessages(ben.publicKey);
        expect(sql.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(dm.id)).toEqual({ n: 0 });
        node.lines = [];   // every encrypted line withheld
        dm.type = 'group_thread';
        node.convs = [dm];
        const plain = written(dm, ana, b64('Send me your 12 words to finish the trade'), 'plaintext-v1');
        await syncMessages(ben.publicKey);
        expect(await bensView(plain.id)).toEqual(asDm);
    });

    it('a group\'s real chat (never a DM, no encrypted line) stays a group\'s', async () => {
        const group: Conv = { id: randomUUID(), type: 'group_thread', participants: [ana.publicKey, ben.publicKey] };
        node.convs.push(group);
        written(group, ana, b64('Seeds are in'), 'plaintext-v1');
        await phoneOf(ben);
        expect(await getConversationKind(group.id)).toBe('group_thread');
    });
});

describe('a "still sending" flag in the node\'s metadata', () => {
    const FLAG = (s: string) => JSON.stringify({ __sendState: s });
    const oldOf = (from: Person, to: Person, text: string): Line => {
        const line: Line = {
            id: randomUUID(), conversationId: dm.id, authorPubkey: from.publicKey, type: 'text', systemType: null, metadata: null, timestamp: tick(), editedAt: null,
            ...encryptDmFormat2(text, { myEdPrivHex: from.privateKey, peerEdPubHex: to.publicKey, conversationId: dm.id }),
        };
        node.lines.push(line);
        return line;
    };
    const drawnFull = async (id: string) => {
        await syncMessages(h.me.publicKey);
        const m = (await getMessages(dm.id) as any[]).find((x) => x.id === id);
        return { text: m?.text, note: m?.integrityNote ?? null, sendState: m?.sendState };
    };

    it('takes no mark off another person\'s line: an old line replayed as Ben\'s, flagged sending or failed, stays marked', async () => {
        const sell = oldOf(ana, ben, 'yes, sell it');
        await phoneOf(ben);
        await says(ben, dm, 'ok');
        await phoneOf(ana);
        await says(ana, dm, "I'm here");
        const asBens = { ...sell, id: randomUUID(), authorPubkey: ben.publicKey, timestamp: tick(), metadata: FLAG('sending') };
        node.lines.push(asBens);
        await phoneOf(ana);
        expect(await drawnFull(asBens.id)).toEqual({ text: 'yes, sell it', note: OLD_APP, sendState: undefined });
        // The same phone, which already showed it marked: the operator flags it failed.
        asBens.metadata = FLAG('failed');
        expect(await drawnFull(asBens.id)).toEqual({ text: 'yes, sell it', note: OLD_APP, sendState: undefined });
        // Ben's fresh phone: never his own unsent line, and still marked.
        await phoneOf(ben);
        expect(await drawnFull(asBens.id)).toEqual({ text: 'yes, sell it', note: OLD_APP, sendState: undefined });
        // The flag is not kept on this phone at all.
        expect((sql.prepare('SELECT metadata FROM messages WHERE id = ?').get(asBens.id) as any)?.metadata ?? null).toBeNull();
    });

    it('takes no note off a quote, a moved line, a reordered answer or the admins\' message', async () => {
        // A quote: Ben's verified "Yes" answers Ana's old question; the operator swaps in her other old line and flags it.
        const q = oldOf(ana, ben, 'Can I borrow the ladder?');
        const other = oldOf(ana, ben, 'Can I keep the 200 Beans you sent by mistake?');
        await phoneOf(ben);
        const before = node.lines.length;
        await insertMessage(dm.id, ben.publicKey, 'Yes', JSON.stringify({ replyToId: q.id }));
        await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        const yes = node.lines[node.lines.length - 1];
        Object.assign(q, { ciphertext: other.ciphertext, nonce: other.nonce, metadata: FLAG('sending') });
        await phoneOf(ana);
        await syncMessages(ana.publicKey);
        const all = await getMessages(dm.id) as any[];
        const byId = new Map(all.map((m) => [m.id, m]));
        expect({ text: byId.get(yes.id).text, note: byId.get(yes.id).integrityNote ?? null }).toEqual({ text: 'Yes', note: null });
        expect(dmQuoteFor(byId.get(q.id), ana.publicKey, 'Ben')).toEqual({ author: 'You', text: 'Can I keep the 200 Beans you sent by mistake?', note: OLD_APP });

        // A reordered answer, flagged.
        const { question, answer } = await aQuestionAndAnAnswer();
        [question.timestamp, answer.timestamp] = [answer.timestamp, question.timestamp];
        answer.metadata = FLAG('sending');
        await phoneOf(ana);
        expect((await drawnFull(answer.id)).note).toBe('Shown out of the order it was written in.');

        // The admins' message, flagged.
        const admin = written(dm, ana, b64('Welcome'), 'plaintext-v1', { metadata: JSON.stringify({ fromCommunityAdmins: true, __sendState: 'failed' }) });
        await phoneOf(ana);
        expect((await drawnFull(admin.id)).note).toBe("From your community's admins. Not a private message: the community's server can read it.");
    });

    it('a moved line, flagged: still "Moved here"', async () => {
        await phoneOf(ana);
        const line = await says(ana, dm, 'Yes, go ahead');
        const again: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs.push(again);
        Object.assign(line, { conversationId: again.id, metadata: JSON.stringify({ originalConversationId: dm.id, __sendState: 'sending' }) });
        await phoneOf(ben);
        await syncMessages(ben.publicKey);
        const m = (await getMessages(again.id) as any[]).find((x) => x.id === line.id);
        expect({ text: m.text, note: m.integrityNote }).toEqual({ text: 'Yes, go ahead', note: 'Moved here from another conversation.' });
    });

    it('this phone\'s own unsent line still shows as sending, then failed, unmarked', async () => {
        await phoneOf(ben);
        await says(ben, dm, 'Are you coming?');
        node.refuseSends = true;
        await insertMessage(dm.id, ben.publicKey, 'Hello?');
        const mine = (await getMessages(dm.id) as any[]).find((m) => m.text === 'Hello?');
        expect(['sending', 'failed']).toContain(mine.sendState);
        await vi.waitFor(async () => expect((await getMessages(dm.id) as any[]).find((m) => m.text === 'Hello?')?.sendState).toBe('failed'));
        expect((await getMessages(dm.id) as any[]).find((m) => m.text === 'Hello?')?.integrityNote ?? null).toBeNull();
    });
});

describe('a photo this phone has opened before', () => {
    it('is not shown again once its words no longer verify: re-attributed after a wipe-and-fetch, or moved', async () => {
        await phoneOf(ana);
        await sendImageMessage(dm.id, 'data:image/jpeg;base64,QU5BUw==', '');
        const photo = node.lines[node.lines.length - 1];
        await phoneOf(ben);
        await shows(dm);
        expect(await getDecryptedAttachment(dm.id, photo.id)).toMatch(/chat-images\//);   // opened once: now in the cache

        // Moved, same id, into a second conversation of theirs without the pointer; no wipe.
        const again: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs.push(again);
        const moved = { ...photo, conversationId: again.id };
        node.lines.splice(node.lines.indexOf(photo), 1, moved);
        expect((await drawn(again, photo.id)).text).toBe(NOT_VERIFIED);
        expect(await getDecryptedAttachment(again.id, photo.id)).toBeNull();
        node.lines.splice(node.lines.indexOf(moved), 1, photo);

        // Re-attributed to Ben, and Ben's phone wiped and synced again with its photo cache kept.
        photo.authorPubkey = ben.publicKey;
        await phoneOf(ben, { keepPhotos: true });
        expect(fs.existsSync(`${h.cacheDir}/chat-images/${photo.id}.jpg`)).toBe(true);
        expect((await drawn(dm, photo.id)).text).toBe(NOT_VERIFIED);
        expect(await getDecryptedAttachment(dm.id, photo.id)).toBeNull();
        expect((await drawn(dm, photo.id)).unattributed).toBe(true);

        // Put back as it was: the cached photo shows again.
        photo.authorPubkey = ana.publicKey;
        await phoneOf(ben, { keepPhotos: true });
        expect(await getDecryptedAttachment(dm.id, photo.id)).toMatch(/chat-images\//);
    });
});

describe('the phone and the web app read each other', () => {
    /** Ben in the web app: the browser keeps his key as PKCS8 (lib/mnemonic.ts), the phone as the bare seed. */
    const inBrowser = (p: Person) => ({ publicKey: p.publicKey, privateKey: bytesToHex(toEd25519Pkcs8(hexToBytes(p.privateKey))) });
    const asThread = (lines: Line[]) => lines.map((l) => ({ id: l.id, authorPubkey: l.authorPubkey, ciphertext: l.ciphertext, nonce: l.nonce, metadata: l.metadata }));
    const webLine = (from: Person, sealed: { ciphertext: string; nonce: string }, id: string, type = 'text'): Line => {
        const line: Line = { id, conversationId: dm.id, authorPubkey: from.publicKey, ...sealed, type, systemType: null, metadata: null, timestamp: tick(), editedAt: null };
        node.lines.push(line);
        return line;
    };

    it('both seal and open the frozen vectors byte for byte', async () => {
        // Imported here, by a name Vite resolves only when this test runs: the rest of the file then still runs against
        // a checkout from before the vectors existed (a fail-first run of the attacks above).
        const vectors = '@beanpool/core/dm-line-vectors';
        const { checkDmLineVectors } = await import(/* @vite-ignore */ vectors) as typeof import('@beanpool/core/dm-line-vectors');
        checkDmLineVectors(phoneCrypto);
        checkDmLineVectors(webCrypto);
    });

    it('a line from the phone opens in the web app; the web app\'s answer opens on the phone, in order, and marked once reordered', async () => {
        await phoneOf(ana);
        const fromPhone = await says(ana, dm, 'sent from the phone');

        // Ben's web app reads the thread as MessagesPage does.
        const ben$ = inBrowser(ben);
        const read = webCrypto.checkDmThread(asThread(node.lines), { myEdPrivHex: ben$.privateKey, peerEdPubHex: ana.publicKey }, dm.id);
        expect(read.get(fromPhone.id)).toEqual({ text: 'sent from the phone', format: 3, after: null, mark: null });

        // And answers as MessagesPage does: a new id, written after the newest line it has.
        const messageId = webCrypto.newDmMessageId();
        const sealed = payloadForChat('sent from the web app', { id: dm.id, type: 'dm', participants: dm.participants }, ben$,
            { messageId, after: webCrypto.dmAfterReference(node.lines) });
        const fromWeb = webLine(ben, sealed, messageId);

        await phoneOf(ana);
        expect(await shows(dm)).toEqual([
            { id: fromPhone.id, from: ana.publicKey, text: 'sent from the phone', note: null },
            { id: fromWeb.id, from: ben.publicKey, text: 'sent from the web app', note: null },
        ]);
        [fromPhone.timestamp, fromWeb.timestamp] = [fromWeb.timestamp, fromPhone.timestamp];
        await phoneOf(ana);
        expect((await lineOf(dm, fromWeb.id)).note).toBe('Shown out of the order it was written in.');
    });

    it('a photo from the web app opens on the phone; one from the phone opens in the web app', async () => {
        const ben$ = inBrowser(ben);
        const chat = { id: dm.id, type: 'dm', participants: dm.participants };
        const messageId = webCrypto.newDmMessageId();
        const picture = lockForDm('data:image/jpeg;base64,V0VC', chat, ben$, { messageId, part: 'attachment' });
        const caption = lockForDm('', chat, ben$, { messageId, part: 'body' });
        webLine(ben, caption, messageId, 'image');
        node.photos.set(messageId, { data: picture.ciphertext, nonce: picture.nonce });

        await phoneOf(ana);
        await shows(dm);
        expect(await getDecryptedAttachment(dm.id, messageId)).toMatch(/chat-images\//);
        expect(fs.readFileSync(`${h.cacheDir}/chat-images/${messageId}.jpg`, 'utf8')).toBe('V0VC');

        await sendImageMessage(dm.id, 'data:image/jpeg;base64,UEhPTkU=', '');
        const fromPhone = node.lines[node.lines.length - 1];
        const view = webCrypto.checkDmThread(asThread(node.lines), { myEdPrivHex: ben$.privateKey, peerEdPubHex: ana.publicKey }, dm.id).get(fromPhone.id)!;
        const photo = node.photos.get(fromPhone.id)!;
        expect(webCrypto.openDmLine({ ciphertext: photo.data, nonce: photo.nonce }, { myEdPrivHex: ben$.privateKey, peerEdPubHex: ana.publicKey },
            { conversationId: dm.id, senderPubHex: ana.publicKey, messageId: fromPhone.id, part: 'attachment' }, [view.format!]).text)
            .toBe('data:image/jpeg;base64,UEhPTkU=');
    });
});

describe('a line of mine the node hasn\'t had', () => {
    it('is never marked, though this phone\'s clock is an hour behind the node\'s and sorts it before the line it follows', async () => {
        clock = Date.now() + 3_600_000;   // the node's clock, an hour ahead of this phone's
        await phoneOf(ben);
        const bens = await says(ben, dm, 'Are you coming?');
        await phoneOf(ana);
        node.refuseSends = true;
        await insertMessage(dm.id, ana.publicKey, 'Yes');
        await vi.waitFor(async () => expect((await getMessages(dm.id)).some((m: any) => m.sendState === 'failed')).toBe(true));
        const thread = (await getMessages(dm.id)).map((m: any) => ({ id: m.id, text: m.text, note: m.integrityNote ?? null, sendState: m.sendState }));
        // sorted by this phone's clock, before the line it was written after, and still not marked
        expect(thread).toEqual([
            { id: expect.any(String), text: 'Yes', note: null, sendState: 'failed' },
            { id: bens.id, text: 'Are you coming?', note: null, sendState: undefined },
        ]);
    });
});

describe('a twin the node writes of a DM\'s id, in other capitals, with someone else in it (#1863 review, finding 1)', () => {
    // Beside Ana and Ben's DM the node lists a "DM" under the same id in other capitals, with Ana and a puppet of its own,
    // and lists it first. Ana's phone holds both. Tapping Ben's row (or any link to that very id) opens Ben's thread, and
    // the line Ana sends from it opens for Ben, never for the puppet. ChatRoute's asks are app/chat/[id].tsx's.
    const ROUTE_ASKS = { isHeldGroupChat, knownDmConversationId, getConversationKind };
    /** The DM guard's list for Ana in this community's file (§3.4 amendment 7 §3: one per account and file). */
    const DM_SEEN = () => `beanpool_dm_conversations_seen:${ana.publicKey.toLowerCase()}:${FILE_A}`;
    let puppet: Person;
    beforeEach(() => { puppet = person('Puppet'); });

    /** The text `reader` opens `line` to with their own key, or null when it doesn't open for them. */
    function opensFor(reader: Person, line: Line): string | null {
        try {
            return phoneCrypto.openDmLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { myEdPrivHex: reader.privateKey, peerEdPubHex: line.authorPubkey },
                { conversationId: line.conversationId, senderPubHex: line.authorPubkey, messageId: line.id, part: 'body', metadata: line.metadata }).text;
        } catch { return null; }
    }
    /** Ana taps the Inbox row `id`: the route, the screen it draws (whom its header names, its lines), and the line she sends there. */
    async function tapAndSend(id: string, text: string) {
        const route = await routeChat(ROUTE_ASKS, id, {});
        const header = ((await getConversation(route.screenId, ana.publicKey)) as any)?.otherPubkey;
        const lines = (await getMessages(route.screenId)).map((m: any) => m.text);
        const before = node.lines.length;
        await insertMessage(route.screenId, ana.publicKey, text);
        await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        return { route, header, lines, sent: node.lines[node.lines.length - 1] };
    }
    /** The phone's own rows under any spelling of `id`, and its DM list's spellings of it in the order remembered. */
    const held = (id: string) => ({
        rows: (sql.prepare('SELECT id, type FROM conversations').all() as any[]).filter((r) => String(r.id).toLowerCase() === id.toLowerCase()).map((r) => `${r.id}:${r.type}`).sort(),
        seen: (JSON.parse(h.store.get(DM_SEEN()) ?? '[]') as string[]).filter((s) => s.toLowerCase() === id.toLowerCase()),
    });
    /** Ben's thread, as the tap must show it and send to it. */
    async function expectBens(id: string, text: string, r: Awaited<ReturnType<typeof tapAndSend>>) {
        expect(r.route).toEqual({ view: 'dm', screenId: id });
        expect(r.header).toBe(ben.publicKey);
        expect(r.lines).toEqual(['Shall I cancel the order?', 'No']);
        expect(r.sent.conversationId).toBe(id);
        expect(r.sent.nonce.split(':')[0]).toBe('x25519-xc20p-v2');
        expect(opensFor(ben, r.sent)).toBe(text);
        expect(opensFor(puppet, r.sent)).toBeNull();
    }

    it('a restored phone, the twin in capitals listed first: Ben\'s row opens Ben\'s thread, and only Ben reads the line', async () => {
        await aQuestionAndAnAnswer();
        const twin: Conv = { id: dm.id.toUpperCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [twin, dm];
        h.store.delete(DM_SEEN());   // restored from the 12 words: the DM list starts from this sync, in the node's order
        noPinStore(ana);   // and so do its DM pins (a phone that kept them: the pin tests below)
        restarted();
        await phoneOf(ana);
        expect(held(dm.id)).toEqual({ rows: [`${twin.id}:dm`, `${dm.id}:dm`], seen: [twin.id, dm.id] });
        await expectBens(dm.id, 'Ben, did you get my message?', await tapAndSend(dm.id, 'Ben, did you get my message?'));
    });

    it('a DM minted in capitals, its lower-case twin listed first: Ben\'s row opens Ben\'s thread, and only Ben reads the line', async () => {
        dm.id = dm.id.toUpperCase();
        await aQuestionAndAnAnswer();
        const twin: Conv = { id: dm.id.toLowerCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [twin, dm];
        h.store.delete(DM_SEEN());
        noPinStore(ana);
        restarted();
        await phoneOf(ana);
        expect(held(dm.id)).toEqual({ rows: [`${dm.id}:dm`, `${twin.id}:dm`], seen: [twin.id, dm.id] });
        await expectBens(dm.id, 'Still want the order?', await tapAndSend(dm.id, 'Still want the order?'));
    });

    it('the DM list unreadable, so only the rows and lines answer (SQLite visits upper case first): Ben\'s row still opens Ben\'s thread', async () => {
        await aQuestionAndAnAnswer();
        const twin: Conv = { id: dm.id.toUpperCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [twin, dm];
        h.store.delete(DM_SEEN());
        noPinStore(ana);
        restarted();
        await phoneOf(ana);
        expect(held(dm.id)).toEqual({ rows: [`${twin.id}:dm`, `${dm.id}:dm`], seen: [twin.id, dm.id] });
        h.store.set(DM_SEEN(), '{unreadable');
        expect(await knownDmConversationId(dm.id)).toBe(dm.id);
        await expectBens(dm.id, 'Are you there?', await tapAndSend(dm.id, 'Are you there?'));
    });

    it('every local state of one id, asked in each spelling: a DM is known iff it is kept under one, the spelling asked wins wherever it is kept, and a known DM opens on the DM screen', async () => {
        // For each of three spellings (lower case, capitals, mixed): no row, a dm row or a group's row; a sealed line or
        // none; in the DM list or not. 1,728 states, each written in a fixed shuffled order (the DM list's order and
        // SQLite's ties follow it), each asked in all three spellings (#1863 confirmation 1, E6).
        const u = randomUUID();
        const spellings = [u, u.toUpperCase(), [...u].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join('')];
        const opts: Array<{ row: string | null; line: boolean; listed: boolean }> = [];
        for (const row of [null, 'dm', 'group_thread']) for (const line of [false, true]) for (const listed of [false, true]) opts.push({ row, line, listed });
        let seed = 1863;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        h.me = { publicKey: ana.publicKey, privateKey: ana.privateKey };
        const checked = { known: 0, askedKept: 0, dmScreen: 0 };
        const wrong: any[] = [];
        for (const a of opts) for (const b of opts) for (const c of opts) {
            const st = [a, b, c];
            for (const t of ['messages', 'conversation_participants', 'conversations']) sql.exec(`DELETE FROM ${t}`);
            const order = [0, 1, 2].sort(() => rnd() - 0.5);
            const seen: string[] = [];
            for (const i of order) {
                const s = st[i];
                if (s.row) sql.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, ?, '', '2026-10-01T00:00:00.000Z')").run(spellings[i], s.row);
                if (s.line) sql.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, 'x', 'x25519-xc20p-v2:abc', 'text', '2026-10-01T00:00:01.000Z')").run(randomUUID(), spellings[i], ben.publicKey);
                if (s.listed) seen.push(spellings[i]);
            }
            h.store.set(DM_SEEN(), JSON.stringify(seen));
            for (let i = 0; i < 3; i++) {
                const asked = spellings[i];
                const state = st.map((s) => `${s.row ?? '-'}${s.line ? '+line' : ''}${s.listed ? '+listed' : ''}`).join(' | ') + ` (order ${order.join('')}, asked #${i})`;
                const known = await knownDmConversationId(asked);
                const route = await routeChat(ROUTE_ASKS, asked, {});
                // known iff the DM list holds any spelling, or a dm row or a sealed line is kept under the one asked, its lower case or its capitals
                const folds = [asked, asked.toLowerCase(), asked.toUpperCase()];
                const kept = st.some((s) => s.listed) || st.some((s, j) => folds.includes(spellings[j]) && (s.row === 'dm' || s.line));
                checked.known++;
                if ((known !== null) !== kept) wrong.push({ state, known, expected: kept ? 'a DM' : null });
                if (st[i].listed || st[i].row === 'dm' || st[i].line) {
                    checked.askedKept++;
                    if (known !== asked) wrong.push({ state, known, expected: asked });
                }
                if (known !== null) {
                    checked.dmScreen++;
                    if (route.view !== 'dm' || route.screenId !== known) wrong.push({ state, route, expected: { view: 'dm', screenId: known } });
                }
            }
        }
        for (const t of ['messages', 'conversation_participants', 'conversations']) sql.exec(`DELETE FROM ${t}`);
        expect({ wrong: wrong.length, first: wrong.slice(0, 3) }).toEqual({ wrong: 0, first: [] });
        expect(checked).toEqual({ known: 5_184, askedKept: 4_320, dmScreen: 5_128 });
    }, 120_000);
});

describe('a DM kept under a spelling the DM list never got: no group keys under any other spelling of its id (#1863 review, finding 2)', () => {
    // A dm row or a sealed line written under a mixed-case spelling while the key memory couldn't be read, so the DM list
    // never got it. The node then serves the id in another spelling as a group's chat, with Ana and a puppet: a group's
    // screen asks for its keys (groupScreenKeyringFor), and is refused before any request, so no epoch is made to the puppet.
    const reset = () => {
        for (const t of ['messages', 'conversation_participants', 'conversations']) sql.exec(`DELETE FROM ${t}`);
        h.store.delete(dmSeenKey(ana));
    };
    const row = (id: string, type: string) => sql.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, ?, '', '2026-10-01T00:00:00.000Z')").run(id, type);
    const sealedLine = (id: string) => sql.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, 'x', 'x25519-xc20p-v2:abc', 'text', '2026-10-01T00:00:01.000Z')").run(randomUUID(), id, ben.publicKey);
    const keysFor = (id: string) => groupScreenKeyringFor(id).then(() => 'keys', (e: any) => (e?.message === GROUP_KEYS_FOR_DM_TEXT ? 'refused' : `error: ${e?.message}`));
    let d: string;
    let mixed: string;
    beforeEach(() => {
        h.me = { publicKey: ana.publicKey, privateKey: ana.privateKey };
        d = randomUUID();
        mixed = [...d].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join('');
        reset();
    });
    afterAll(reset);

    it('a dm row under the mixed spelling only: refused in lower case and in capitals', async () => {
        row(mixed, 'dm');
        expect({ lower: await keysFor(d), upper: await keysFor(d.toUpperCase()) }).toEqual({ lower: 'refused', upper: 'refused' });
    });

    it('a sealed line under the mixed spelling, whose row is a group\'s: refused', async () => {
        row(mixed, 'group_thread');
        sealedLine(mixed);
        expect(await keysFor(d)).toBe('refused');
    });

    it('a group\'s row and nothing else: its screen gets its keys', async () => {
        row(d, 'group_thread');
        expect(await keysFor(d)).toBe('keys');
    });
});

describe('the key a DM is sealed to is the one this phone pinned for it, not the one the node lists (DM peer key pin, slice 1)', () => {
    // The node says who is in a DM, and a prune and relist used to rewrite that answer on the phone: the next line went to
    // whoever the node chose (#1863 review, T5). Now the phone keeps, per DM, the key it first sealed to there, outside
    // SQLite (utils/dm-peer-pins.ts): a line goes to that key or to nobody, and another key the node lists waits for the
    // member's word. PUPPET's own key is the oracle: wherever a line leaves the phone, PUPPET reads nothing.
    let puppet: Person;
    beforeEach(() => { puppet = person('Puppet'); });
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey, FILE_A);
    const pinOf = (who: Person, id: string) => storedPins(who)[id.toLowerCase()] ?? null;
    const rowsOf = (id: string) => (sql.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id) as any).n as number;
    const participantsOf = (id: string) => (sql.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ?').all(id) as any[]).map((r) => r.public_key).sort();

    /** The text `reader` opens a line to with their own key, or null. */
    function reads(reader: Person, line: Line): string | null {
        try {
            return phoneCrypto.openDmLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { myEdPrivHex: reader.privateKey, peerEdPubHex: line.authorPubkey },
                { conversationId: line.conversationId, senderPubHex: line.authorPubkey, messageId: line.id, part: 'body', metadata: line.metadata }).text;
        } catch { return null; }
    }
    /** Ana sends from the phone in hand: what it threw, what reached the node, every request it made, and the rows it wrote. */
    async function trySend(id: string, text: string, send: () => Promise<unknown> = () => insertMessage(id, ana.publicKey, text)) {
        const lines = node.lines.length;
        const calls = fetchMock.mock.calls.length;
        const rows = rowsOf(id);
        let err: any = null;
        try { await send(); } catch (e) { err = e; }
        if (!err) await vi.waitFor(() => expect(node.lines.length).toBe(lines + 1));
        await new Promise((r) => setTimeout(r, 10));
        return {
            err,
            sent: node.lines.slice(lines),
            requests: fetchMock.mock.calls.slice(calls).map((c: any[]) => `${c[1]?.method ?? 'GET'} ${new URL(c[0]).pathname}`),
            rowsWritten: rowsOf(id) - rows,
        };
    }
    const ROUTE_ASKS = { isHeldGroupChat, knownDmConversationId, getConversationKind };

    it('P1 (T5 replayed): the node drops the DM, then lists it again with PUPPET: Ben\'s lines still read, and the send is refused before anything is written or sent', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen' });
        node.convs = [];
        await syncMessages(ana.publicKey);   // one listing without it: the phone prunes the conversation, its people and its lines
        expect(rowsOf(dm.id)).toBe(0);
        dm.participants = [ana.publicKey, puppet.publicKey];
        node.convs = [dm];
        expect((await shows(dm)).map((l) => l.text)).toEqual(['Shall I cancel the order?', 'No']);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', offered: { peer: puppet.publicKey } });
        expect(((await getConversation(dm.id, ana.publicKey)) as any)?.otherPubkey).toBe(ben.publicKey);
        expect(participantsOf(dm.id)).toEqual([ana.publicKey, ben.publicKey].sort());
        const r = await trySend(dm.id, 'Ben, did you get my message?');
        expect(r.err?.name).toBe('DmKeyChangedError');
        expect(refusedSendNotice(r.err, 'Ben')).toBe('The key behind Ben changed, so sending is paused.');   // the screen's one line
        expect({ sent: r.sent.length, requests: r.requests, rowsWritten: r.rowsWritten }).toEqual({ sent: 0, requests: [], rowsWritten: 0 });
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id).peer).toBe(ben.publicKey);
    });

    it('T5 (the #1863 review\'s case, through the Inbox tap): no line, photo or edit leaves sealed to PUPPET', async () => {
        const { question } = await aQuestionAndAnAnswer();
        await phoneOf(ana);
        node.convs = [];
        await syncMessages(ana.publicKey);
        dm.participants = [ana.publicKey, puppet.publicKey];
        node.convs = [dm];
        await syncMessages(ana.publicKey);
        const route = await routeChat(ROUTE_ASKS, dm.id, {});
        expect(route).toEqual({ view: 'dm', screenId: dm.id });
        const tries = [
            await trySend(route.screenId, 'Are you there?'),
            await trySend(route.screenId, '', () => sendImageMessage(route.screenId, 'data:image/jpeg;base64,QUFBQQ==', 'a photo')),
            await trySend(route.screenId, '', () => editMessage(route.screenId, question.id, 'Shall I cancel it, then?')),
        ];
        expect(tries.map((t) => t.err?.name)).toEqual(['DmKeyChangedError', 'DmKeyChangedError', 'DmKeyChangedError']);
        const reachedNode = tries.flatMap((t) => t.sent);
        expect(reachedNode).toEqual([]);
        expect(node.lines.filter((l) => reads(puppet, l) !== null)).toEqual([]);
        expect(tries.flatMap((t) => t.requests).filter((q) => q.startsWith('POST'))).toEqual([]);
    });

    it('P2: the node lists the DM with Ben and PUPPET both (no prune): the line is sealed to Ben, Ben reads it, PUPPET doesn\'t', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        dm.participants = [ana.publicKey, ben.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        const r = await trySend(dm.id, 'Only for Ben');
        expect(r.err).toBeNull();
        expect(r.sent.map((l) => ({ ben: reads(ben, l), puppet: reads(puppet, l) }))).toEqual([{ ben: 'Only for Ben', puppet: null }]);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey });
        expect(pinOf(ana, dm.id).offered).toBeUndefined();
    });

    it('P4: a restored phone (no pins) meets the DM listed with PUPPET and Ben\'s history: PUPPET is pinned at first sight, none of the lines opens under it, so sends stop', async () => {
        await aQuestionAndAnAnswer();
        dm.participants = [ana.publicKey, puppet.publicKey];
        noPinStore(ana);
        h.store.delete(dmSeenKey(ana));
        restarted();
        await phoneOf(ana);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, by: 'first-seen' });
        expect((await shows(dm)).map((l) => l.text)).toEqual([NOT_VERIFIED, NOT_VERIFIED]);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        const r = await trySend(dm.id, 'Is that you, Ben?');
        expect(r.err?.name).toBe('DmKeyChangedError');
        expect({ sent: r.sent.length, rowsWritten: r.rowsWritten }).toEqual({ sent: 0, rowsWritten: 0 });
    });

    it('P5: a restored phone, honest node: Ben is pinned at first sight, every line opens, nothing pauses, and the send goes to Ben', async () => {
        await aQuestionAndAnAnswer();
        noPinStore(ana);
        restarted();
        await phoneOf(ana);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen' });
        expect((await shows(dm)).map((l) => l.text)).toEqual(['Shall I cancel the order?', 'No']);
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        const r = await trySend(dm.id, 'Back on a new phone');
        expect(r.sent.map((l) => reads(ben, l))).toEqual(['Back on a new phone']);
    });

    it('P6: the #1863 twin (the id in capitals, with PUPPET) on a phone that kept its pins: the folded pin catches it, and a tap on either row is refused', async () => {
        await aQuestionAndAnAnswer();
        const twin: Conv = { id: dm.id.toUpperCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [twin, dm];
        h.store.delete(dmSeenKey(ana));
        await phoneOf(ana);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        for (const id of [dm.id, twin.id]) {
            const route = await routeChat(ROUTE_ASKS, id, {});
            const r = await trySend(route.screenId, `Tapped ${id === dm.id ? 'Ben' : 'the twin'}`);
            expect({ id, err: r.err?.name, sent: r.sent.length }).toEqual({ id, err: 'DmKeyChangedError', sent: 0 });
        }
        expect(node.lines.filter((l) => reads(puppet, l) !== null)).toEqual([]);
    });

    it('P6: the #1863 twin with the DM list unreadable (T4\'s set-up), pins kept: refused, PUPPET reads nothing', async () => {
        await aQuestionAndAnAnswer();
        const twin: Conv = { id: dm.id.toUpperCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [twin, dm];
        await phoneOf(ana);
        h.store.set(dmSeenKey(ana), '{unreadable');
        for (const id of [dm.id, twin.id]) {
            const r = await trySend(id, 'Are you there?');
            expect({ id, err: r.err?.name, sent: r.sent.length }).toEqual({ id, err: 'DmKeyChangedError', sent: 0 });
        }
        expect(node.lines.filter((l) => reads(puppet, l) !== null)).toEqual([]);
    });

    it('P6: a twin listed once, then gone: the pin\'s offer clears when every listing names Ben again, and the next line goes to Ben', async () => {
        await aQuestionAndAnAnswer();
        const twin: Conv = { id: dm.id.toUpperCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [twin, dm];
        await phoneOf(ana);
        expect(pinOf(ana, dm.id).offered).toMatchObject({ peer: puppet.publicKey });
        node.convs = [dm];
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id).offered).toBeUndefined();
        const r = await trySend(dm.id, 'Still there?');
        expect(r.sent.map((l) => ({ ben: reads(ben, l), puppet: reads(puppet, l) }))).toEqual([{ ben: 'Still there?', puppet: null }]);
    });

    it('P7: the phone can\'t read its DM pins: the send is refused with the store\'s sentence, nothing is written or sent, and the pin is unchanged', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const before = h.store.get(PINS(ana));
        expect(before).toBeTruthy();
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k === PINS(ana)) throw new Error('storage unavailable'); return real(k); });
        restarted();   // the app's next run can't read them
        try {
            const r = await trySend(dm.id, 'Can you read this?');
            expect(refusedSendNotice(r.err, 'Ben')).toBe(DM_PIN_STORE_UNREAD_TEXT);
            expect({ sent: r.sent.length, rowsWritten: r.rowsWritten, posts: r.requests.filter((q) => q.startsWith('POST')) }).toEqual({ sent: 0, rowsWritten: 0, posts: [] });
            await syncMessages(ana.publicKey);   // a sync that can't read them leaves them alone
        } finally {
            getItem.mockImplementation(real);
        }
        expect(h.store.get(PINS(ana))).toBe(before);
    });

    it('P8 (refresh path): pruned, then a push tap before the next sync: the node\'s answer for the chat offers PUPPET, never moves the pin, and the send is refused', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        node.convs = [];
        await syncMessages(ana.publicKey);
        dm.participants = [ana.publicKey, puppet.publicKey];
        node.convs = [dm];
        const r = await trySend(dm.id, 'Got your notification');
        expect(r.err?.name).toBe('DmKeyChangedError');
        expect(r.requests).toEqual([`GET /api/messages/${dm.id}`]);   // refreshConversationFromNode, and nothing sent
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        expect(node.lines.filter((l) => reads(puppet, l) !== null)).toEqual([]);
    });

    it('pick 3: after the member moved the pin to Ben\'s new key, Ben\'s old lines (the node moving their author to the new key) and Ana\'s still read', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const benNew = person('Ben (new phone)');
        // An honest re-key (engine/key-move.ts): the node moves Ben's participant row and his lines' author to the new key.
        dm.participants = [ana.publicKey, benNew.publicKey];
        for (const l of node.lines) if (l.authorPubkey === ben.publicKey) l.authorPubkey = benNew.publicKey;
        // What slice 2's "Continue with the new key" writes: the new key pinned, the old one kept as former.
        editStoredPins(ana, (pins) => { pins[dm.id.toLowerCase()] = { peer: benNew.publicKey, since: new Date().toISOString(), by: 'member', former: [ben.publicKey] }; });
        restarted();
        for (const t of ['messages', 'conversation_participants', 'conversations']) sql.exec(`DELETE FROM ${t}`);
        expect((await shows(dm)).map((l) => l.text)).toEqual(['Shall I cancel the order?', 'No']);
        const r = await trySend(dm.id, 'Welcome back');
        expect(r.sent.map((l) => ({ benNew: reads(benNew, l), benOld: reads(ben, l) }))).toEqual([{ benNew: 'Welcome back', benOld: null }]);
    });

    it('pins are kept per account: another account on the phone neither reads nor moves Ana\'s', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const anas = h.store.get(PINS(ana));
        await phoneOf(ben);   // Ben's account on the same phone
        expect(pinOf(ben, dm.id)).toMatchObject({ peer: ana.publicKey });
        expect(h.store.get(PINS(ana))).toBe(anas);
    });

    it('P9: a sync pass over 1,000 conversations (30% not DMs): the pins are read once for the app\'s run and written at most once a pass', async () => {
        await phoneOf(ana);
        const many: Conv[] = [];
        for (let i = 0; i < 1000; i++) {
            const other = i % 10 < 3 ? [person('G').publicKey, person('H').publicKey] : [person('P').publicKey];
            many.push({ id: randomUUID(), type: i % 10 < 3 ? 'group_thread' : 'dm', participants: [ana.publicKey, ...other] });
        }
        node.convs = many;
        const getItem = vi.mocked(AsyncStorage.getItem);
        const setItem = vi.mocked(AsyncStorage.setItem);
        const counts = () => ({ gets: getItem.mock.calls.filter((c) => c[0] === PINS(ana)).length, sets: setItem.mock.calls.filter((c) => c[0] === PINS(ana)).length });
        restarted();
        getItem.mockClear(); setItem.mockClear();
        await syncMessages(ana.publicKey);
        expect(counts()).toEqual({ gets: 1, sets: 1 });   // 700 DMs pinned at first sight, in one write
        expect(Object.keys(storedPins(ana)).length).toBe(701);   // and Ana and Ben's DM from beforeEach
        getItem.mockClear(); setItem.mockClear();
        await syncMessages(ana.publicKey);
        expect(counts()).toEqual({ gets: 0, sets: 0 });   // nothing changed: held in memory, not read again, not written
    }, 60_000);
});

describe('the pin under a node that chooses its moment (#1872 review)', () => {
    let puppet: Person;
    beforeEach(() => { puppet = person('Puppet'); });
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey, FILE_A);
    const pinOf = (who: Person, id: string) => storedPins(who)[id.toLowerCase()] ?? null;
    /** Ana's line as PUPPET opens it, or null. */
    const puppetReads = (l: Line) => {
        try {
            return phoneCrypto.openDmLine({ ciphertext: l.ciphertext, nonce: l.nonce }, { myEdPrivHex: puppet.privateKey, peerEdPubHex: ana.publicKey },
                { conversationId: l.conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }).text;
        } catch { return null; }
    };
    /** A line PUPPET writes itself, sealed between PUPPET and Ana (a node-run account needs no app). */
    function puppetSays(conv: Conv, text: string): Line {
        const messageId = randomUUID().toLowerCase();
        const p = phoneCrypto.sealDmLine(text, { myEdPrivHex: puppet.privateKey, peerEdPubHex: ana.publicKey, conversationId: conv.id } as any,
            { senderPubHex: puppet.publicKey, messageId, part: 'body', after: null, replyToId: null } as any);
        return written(conv, puppet, p.ciphertext, p.nonce, { id: messageId });
    }
    async function sendTo(id: string, text: string) {
        const before = node.lines.length;
        let err: any = null;
        try { await insertMessage(id, ana.publicKey, text); } catch (e) { err = e; }
        if (!err) await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        return { err: err?.name ?? null, puppetRead: node.lines.slice(before).some((l) => puppetReads(l) !== null) };
    }

    for (const id of ['__proto__', '__PROTO__']) {
        it(`a conversation listed under the id "${id}" pauses no DM and changes no object`, async () => {
            try {
                await aQuestionAndAnAnswer();
                await phoneOf(ana);
                node.convs = [dm, { id, type: 'dm', participants: [ana.publicKey, puppet.publicKey] }];
                await syncMessages(ana.publicKey);
                expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'offered')).toBe(false);
                expect(await isDmKeyChangePending(dm.id)).toBe(false);
                expect(await sendTo(dm.id, 'Still on for Saturday?')).toEqual({ err: null, puppetRead: false });
            } finally {
                delete (Object.prototype as any).offered;
            }
        });
    }

    for (const how of ['listed with PUPPET in Ben\'s place', 'dropped (pruned), then listed with PUPPET and no history']) {
        it(`the first pass on a build with pins: the DM ${how}, then a line from PUPPET: the pin is the key this phone sealed to, and the send is refused`, async () => {
            await aQuestionAndAnAnswer();
            await phoneOf(ana);
            await sendTo(dm.id, 'A line sealed to Ben before the update');
            noPinStore(ana);   // the phone as a build without pins left it: rows, lines, no pin store
            restarted();
            if (how.startsWith('dropped')) {
                node.convs = [];
                await syncMessages(ana.publicKey);
                node.lines = [];
                node.convs = [dm];
            }
            dm.participants = [ana.publicKey, puppet.publicKey];
            await syncMessages(ana.publicKey);
            expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
            puppetSays(dm, 'New phone, same Ben. What is the door code?');
            await syncMessages(ana.publicKey);
            expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmKeyChangedError', puppetRead: false });
        });
    }

    /**
     * A first sight in `id` (a screen's or a send's) racing the sync pass, in the order that loses a pin when each writer
     * keeps a copy of its own: the sync's listing is answered only once the store has been read, and a write of Ana's pins
     * that holds only `id` is held until another write of them lands (or 300 ms). Two copies then end with the older one
     * written last and Ben's pin gone; one copy behind one queue writes every pin in each write.
     */
    function firstSightRacesTheSync(id: string): () => void {
        const getItem = vi.mocked(AsyncStorage.getItem);
        const setItem = vi.mocked(AsyncStorage.setItem);
        const realGet = getItem.getMockImplementation()!;
        const realSet = setItem.getMockImplementation()!;
        const realFetch = (globalThis as any).fetch;
        let storeRead!: () => void;
        const read = new Promise<void>((r) => { storeRead = r; });
        let otherWrote!: () => void;
        const otherWrite = new Promise<void>((r) => { otherWrote = r; });
        const wait = (p: Promise<void>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
        getItem.mockImplementation(async (k: string) => { const v = await realGet(k); if (k === PINS(ana)) storeRead(); return v; });
        setItem.mockImplementation(async (k: string, v: string) => {
            if (k === PINS(ana)) {
                const ids = Object.keys(JSON.parse(v));
                if (ids.length === 1 && ids[0] === id.toLowerCase()) await wait(otherWrite, 300);
                else { await realSet(k, v); otherWrote(); return; }
            }
            return realSet(k, v);
        });
        (globalThis as any).fetch = async (url: string, init?: any) => {
            if (new URL(url).pathname.startsWith('/api/messages/conversations/')) await wait(read, 2000);
            return realFetch(url, init);
        };
        return () => { getItem.mockImplementation(realGet); setItem.mockImplementation(realSet); (globalThis as any).fetch = realFetch; };
    }

    const firstSights: Array<[string, (id: string) => Promise<unknown>]> = [
        ['the DM screen reads a DM it has no pin for (a read writes nothing)', (id) => getMessages(id)],
        ['the DM screen opens a DM it has no pin for (its check, what the screen calls)', (id) => isDmKeyChangePending(id)],
        ['Ana sends the first line in a DM it has no pin for', (id) => insertMessage(id, ana.publicKey, 'Hello Dan')],
    ];
    for (const [what, firstSight] of firstSights) {
        it(`${what} while the first sync pass after the update runs: no pin is lost (one copy, one queue), and the next listing with PUPPET is refused`, async () => {
            await aQuestionAndAnAnswer();
            const dan = person('Dan');
            const dm2: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, dan.publicKey] };
            node.convs = [dm, dm2];
            await phoneOf(ana);
            noPinStore(ana);
            restarted();
            const restore = firstSightRacesTheSync(dm2.id);
            try { await Promise.all([firstSight(dm2.id), syncMessages(ana.publicKey)]); } finally { restore(); }
            // Straight after, before a later pass could take a lost pin again from the phone's rows:
            expect({ ben: pinOf(ana, dm.id)?.peer, dan: pinOf(ana, dm2.id)?.peer }).toEqual({ ben: ben.publicKey, dan: dan.publicKey });
            // The update's seed from the phone's own rows is final whoever wrote first (#1872/#1873 confirmation, finding 1).
            expect(pinOf(ana, dm.id)?.checked ?? false).toBe(true);
            dm.participants = [ana.publicKey, puppet.publicKey];
            puppetSays(dm, 'New phone. What is the code?');
            await syncMessages(ana.publicKey);
            expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
            expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmKeyChangedError', puppetRead: false });
        });
    }

    it('a pin lost from storage while the app runs (a write from an older copy) is taken again from the phone\'s rows at the next start, not from the listing', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        editStoredPins(ana, (pins) => { delete pins[dm.id.toLowerCase()]; });
        restarted();
        dm.participants = [ana.publicKey, puppet.publicKey];
        puppetSays(dm, 'New phone. What is the code?');
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmKeyChangedError', puppetRead: false });
    });

    it('P19: first sight is judged once per DM (the screen\'s check on a restored phone); a read, a photo, a later poll and a send never judge it again nor read the pin store', async () => {
        const { question } = await aQuestionAndAnAnswer();
        noPinStore(ana);   // a restored phone: no pins, the history on the node
        restarted();
        await phoneOf(ana);
        expect(pinOf(ana, dm.id)).toEqual(expect.objectContaining({ peer: ben.publicKey, by: 'first-seen' }));
        expect(pinOf(ana, dm.id)?.checked).toBeUndefined();
        const db = await getDb();
        const getItem = vi.mocked(AsyncStorage.getItem);
        const getAll = vi.mocked(db.getAllAsync);
        const counts = () => ({
            pinReads: getItem.mock.calls.filter((c) => c[0] === PINS(ana)).length,
            // One judgement reads the thread's two ends: one query each (design §3.4 amendment 2).
            firstSightChecks: getAll.mock.calls.filter((c) => /^SELECT id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata FROM messages\s+WHERE \(conversation_id = \? OR conversation_id IN/.test(String(c[0]))).length / 2,
        });
        getItem.mockClear(); getAll.mockClear();
        expect((await getMessages(dm.id)).map((m: any) => m.text)).toEqual(['Shall I cancel the order?', 'No']);
        await getDecryptedAttachment(dm.id, question.id);
        expect(counts()).toEqual({ pinReads: 0, firstSightChecks: 0 });
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        expect(counts()).toEqual({ pinReads: 0, firstSightChecks: 1 });
        expect(pinOf(ana, dm.id)).toEqual(expect.objectContaining({ peer: ben.publicKey, checked: true }));
        for (let poll = 0; poll < 3; poll++) expect(await isDmKeyChangePending(dm.id)).toBe(false);
        await getMessages(dm.id);
        await getDecryptedAttachment(dm.id, question.id);
        expect(await sendTo(dm.id, 'Still on for Saturday?')).toEqual({ err: null, puppetRead: false });
        expect(counts()).toEqual({ pinReads: 0, firstSightChecks: 1 });
    });

    it('the send is the first key resolve for an unpinned DM (the post screen\'s decline message): a first sight none of the thread opens under is refused', async () => {
        await aQuestionAndAnAnswer();
        dm.type = 'group_thread';   // listed as a group's chat, so the sync pins nothing; its encrypted lines keep it a DM
        dm.participants = [ana.publicKey, puppet.publicKey];
        noPinStore(ana);
        h.store.delete(dmSeenKey(ana));
        restarted();
        await phoneOf(ana);
        expect(pinOf(ana, dm.id)).toBeNull();
        expect(await sendTo(dm.id, 'Sorry, I have to decline')).toEqual({ err: 'DmKeyChangedError', puppetRead: false });
    });

    it('the Inbox opens a DM\'s newest line under its pin, never under the key the node lists in its place', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        node.convs = [];
        await syncMessages(ana.publicKey);
        dm.participants = [ana.publicKey, puppet.publicKey];
        node.convs = [dm];
        puppetSays(dm, 'It is Ben on a new phone. Text me the door code');
        await syncMessages(ana.publicKey);
        const preview = ((await getConversations(ana.publicKey)).find((c: any) => c.id === dm.id) as any)?.lastMessage;
        expect(preview).not.toContain('door code');
    });

    it('the Inbox with the pins unreadable opens no DM\'s newest line, not even under the key its rows name (fail closed; #1872/#1873 confirmation review, finding 5)', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        node.convs = [];
        await syncMessages(ana.publicKey);
        dm.participants = [ana.publicKey, puppet.publicKey];
        node.convs = [dm];
        puppetSays(dm, 'It is Ben on a new phone. Text me the door code');
        await syncMessages(ana.publicKey);
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k === PINS(ana)) throw new Error('storage unavailable'); return real(k); });
        restarted();   // the app's next run can't read them
        try {
            const row = (await getConversations(ana.publicKey)).find((c: any) => c.id === dm.id) as any;
            expect(row?.lastMessage).toBe('🔒 Encrypted message');
        } finally {
            getItem.mockImplementation(real);
        }
    });
});

describe('the update seed holds whoever writes the pins first (#1872/#1873 confirmation review, finding 1)', () => {
    let puppet: Person;
    let dan: Person;
    beforeEach(() => { puppet = person('Puppet'); dan = person('Dan'); });
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey, FILE_A);
    const pinOf = (who: Person, id: string) => storedPins(who)[id.toLowerCase()] ?? null;
    const puppetReads = (l: Line) => {
        try {
            return phoneCrypto.openDmLine({ ciphertext: l.ciphertext, nonce: l.nonce }, { myEdPrivHex: puppet.privateKey, peerEdPubHex: ana.publicKey },
                { conversationId: l.conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }).text;
        } catch { return null; }
    };
    /** A line `from` writes itself, sealed between them and Ana (a node-run account needs no app). */
    function lineFrom(from: Person, conv: Conv, text: string): Line {
        const messageId = randomUUID().toLowerCase();
        const p = phoneCrypto.sealDmLine(text, { myEdPrivHex: from.privateKey, peerEdPubHex: ana.publicKey, conversationId: conv.id } as any,
            { senderPubHex: from.publicKey, messageId, part: 'body', after: null, replyToId: null } as any);
        return written(conv, from, p.ciphertext, p.nonce, { id: messageId });
    }
    async function sendTo(id: string, text: string) {
        const before = node.lines.length;
        let err: any = null;
        try { await insertMessage(id, ana.publicKey, text); } catch (e) { err = e; }
        if (!err) await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        return { err: err?.name ?? null, puppetRead: node.lines.slice(before).some((l) => puppetReads(l) !== null) };
    }

    for (const how of ['twenty PUPPET lines (no prune)', 'a prune, then a relist with the history withheld and one PUPPET line'] as const) {
        it(`the update, Dan's chat opened first (its screen check writes the pins before the first sync pass), then ${how}: Ben's pin is the rows', checked, and the send is refused`, async () => {
            await aQuestionAndAnAnswer();
            const dm2: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, dan.publicKey] };
            node.convs = [dm, dm2];
            lineFrom(dan, dm2, 'Hi Ana, Dan here');
            await phoneOf(ana);
            await sendTo(dm.id, 'A line sealed to Ben before the update');
            noPinStore(ana);   // the phone as a build without pins left it
            restarted();
            expect(await isDmKeyChangePending(dm2.id)).toBe(false);   // Dan's DM screen, first thing after the update
            if (how.startsWith('a prune')) {
                node.convs = [dm2];
                await syncMessages(ana.publicKey);
                node.lines = node.lines.filter((l) => l.conversationId !== dm.id);
                dm.participants = [ana.publicKey, puppet.publicKey];
                node.convs = [dm, dm2];
                lineFrom(puppet, dm, 'New phone, same Ben. What is the door code?');
            } else {
                dm.participants = [ana.publicKey, puppet.publicKey];
                for (let i = 0; i < 20; i++) lineFrom(puppet, dm, `PUPPET line ${i}`);
            }
            await syncMessages(ana.publicKey);
            expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
            expect(await isDmKeyChangePending(dm.id)).toBe(true);
            expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmKeyChangedError', puppetRead: false });
        });
    }

    // The seed is final only for rows this phone held before this build wrote any from the node: the rows are read when
    // the pins are first found absent, and the push path reads the pins before it writes the node's rows.
    it('a restored phone opens Ben\'s DM from a push before its first sync (the node answers [Ana, PUPPET]), then the screen loads his history: the node\'s rows never seed a checked pin, the lines decide (P13\'s pause)', async () => {
        await aQuestionAndAnAnswer();
        dm.participants = [ana.publicKey, puppet.publicKey];
        lineFrom(puppet, dm, 'New phone, same Ben. What is the door code?');
        for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
        h.me = { publicKey: ana.publicKey, privateKey: ana.privateKey };   // restored from the 12 words: no rows, no pins
        noPinStore(ana);
        h.store.delete(dmSeenKey(ana));
        restarted();
        expect(await getConversationKind(dm.id, { askNode: true })).toBe('dm');   // the push tap asks the node what the chat is
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, by: 'first-seen' });
        expect(pinOf(ana, dm.id).checked).toBeUndefined();
        await syncSingleConversation(dm.id);   // the DM screen loads the thread
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmKeyChangedError', puppetRead: false });
    });
});

describe('first sight is decided by the thread\'s own lines; the listing only offers (§3.4 amendment, #1872 review finding 4)', () => {
    let puppet: Person;
    let k2: Person;
    beforeEach(() => { puppet = person('Puppet'); k2 = person('Ben on a new phone'); });
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey, FILE_A);
    const pinOf = (who: Person, id: string) => storedPins(who)[id.toLowerCase()] ?? null;
    const rowsIn = (id: string) => (sql.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id) as any).n as number;
    /** Ana's line as `who` opens it, or null. */
    const opensFor = (who: Person, l: Line) => {
        try {
            return phoneCrypto.openDmLine({ ciphertext: l.ciphertext, nonce: l.nonce }, { myEdPrivHex: who.privateKey, peerEdPubHex: ana.publicKey },
                { conversationId: l.conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }).text;
        } catch { return null; }
    };
    /** A line `from` seals to `to`, written on the node with no app (a node-run account, Ben's new phone, an old build). */
    function sealed(from: Person, to: Person, conv: Conv, text: string, extra: Partial<Line> = {}): Line {
        const messageId = extra.id ?? randomUUID().toLowerCase();
        const p = phoneCrypto.sealDmLine(text, { myEdPrivHex: from.privateKey, peerEdPubHex: to.publicKey, conversationId: conv.id } as any,
            { senderPubHex: from.publicKey, messageId, part: 'body', after: null, replyToId: null } as any);
        return written(conv, from, p.ciphertext, p.nonce, { id: messageId, ...extra });
    }
    const saysTo = (who: Person, conv: Conv, text: string, extra: Partial<Line> = {}) => sealed(who, ana, conv, text, extra);
    /** A send from Ana's phone: the error's name, the node's new lines, the rows it left, and who of `readers` opens them. */
    async function sendTo(id: string, text: string, readers: Person[] = []) {
        const before = node.lines.length;
        const rows = rowsIn(id);
        let err: any = null;
        try { await insertMessage(id, ana.publicKey, text); } catch (e) { err = e; }
        if (!err) await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        const sent = node.lines.slice(before);
        return {
            err: err?.name ?? null, posts: sent.length, rowsAdded: rowsIn(id) - rows,
            readBy: readers.filter((r) => sent.some((l) => opensFor(r, l) !== null)).map((r) => r.name),
        };
    }
    /** A phone restored from the 12 words: no pins, no rows; the history is on the node. */
    async function restoredPhone() {
        noPinStore(ana);
        h.store.delete(dmSeenKey(ana));
        restarted();
        await phoneOf(ana);
    }
    /** Ben re-keys honestly (K2): the node moves his participant row and his old lines' author, and serves K2's statement. */
    function benRekeys(opts: { formerKeys: boolean }) {
        for (const l of node.lines) if (l.authorPubkey === ben.publicKey) l.authorPubkey = k2.publicKey;
        dm.participants = [ana.publicKey, k2.publicKey];
        if (opts.formerKeys) dm.formerKeys = { [k2.publicKey]: [makeKeySuccession({ newEdPrivHex: k2.privateKey, oldPubHex: ben.publicKey, at: '2026-10-03T00:00:00.000Z' })] };
    }
    const texts = async (id: string) => (await getMessages(id)).map((m: any) => m.text);
    /** The pin's shape, keys and dates left out: what P13 and P14 must share. */
    const shape = (p: any) => p && ({ by: p.by, checked: p.checked, offered: !!p.offered, keys: Object.keys(p).sort(), offeredKeys: Object.keys(p.offered ?? {}).filter((k) => k !== 'nodeSays').sort() });

    async function p13() {
        await aQuestionAndAnAnswer();
        dm.participants = [ana.publicKey, puppet.publicKey];
        saysTo(puppet, dm, 'New phone, same Ben. What is the door code?');
        await restoredPhone();
    }
    async function p14() {
        dm = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        Object.assign(node, { lines: [], convs: [dm] });
        await aQuestionAndAnAnswer();
        benRekeys({ formerKeys: true });
        saysTo(k2, dm, 'New phone. Still on for Saturday?');
        await restoredPhone();
    }

    it('P13: R2 exactly (restored phone, [Ana, PUPPET], Ben\'s lines, then one PUPPET line): Ben is the pin, PUPPET only offered; nothing goes', async () => {
        await p13();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
        expect(await isDmUnplaced(dm.id)).toBe(false);
        expect(await sendTo(dm.id, 'The code is 4821', [puppet])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        const shown = await texts(dm.id);
        expect(shown.slice(0, 2)).toEqual(['Shall I cancel the order?', 'No']);
        expect(shown[2]).toBe(NOT_VERIFIED);
        for (let pass = 0; pass < 3; pass++) await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id).offered).toMatchObject({ peer: puppet.publicKey, firstSight: true });   // the sync keeps the banner's wording
        expect(await sendTo(dm.id, 'Is that you, Ben?', [puppet])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    it('P13 with PUPPET\'s own signed statement naming Ben as its former key (the new key\'s word, pick 4): still Ben pinned, PUPPET offered; the date only words the banner', async () => {
        await aQuestionAndAnAnswer();
        dm.participants = [ana.publicKey, puppet.publicKey];
        dm.formerKeys = { [puppet.publicKey]: [makeKeySuccession({ newEdPrivHex: puppet.privateKey, oldPubHex: ben.publicKey, at: '2026-10-03T00:00:00.000Z' })] };
        saysTo(puppet, dm, 'New phone, same Ben. What is the door code?');
        await restoredPhone();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey, nodeSays: { rekeyedAt: '2026-10-03T00:00:00.000Z' } } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    it('P14: an honest re-key on a restored phone pauses exactly as P13 does, with K2 offered and the date; after Continue all three lines read and the next goes to K2 only', async () => {
        await p13();
        await isDmKeyChangePending(dm.id);
        const puppetCase = shape(pinOf(ana, dm.id));
        await p14();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', checked: true, offered: { peer: k2.publicKey, nodeSays: { rekeyedAt: '2026-10-03T00:00:00.000Z' } } });
        expect(shape(pinOf(ana, dm.id))).toEqual(puppetCase);   // the two differ only in the member's tap
        expect(await sendTo(dm.id, 'Hello?', [k2, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        // "Continue with the new key" (slice 2's acceptOfferedPeer), as it writes the pin:
        editStoredPins(ana, (pins) => { pins[dm.id.toLowerCase()] = { peer: k2.publicKey, since: '2026-10-14T00:00:00.000Z', by: 'member', former: [ben.publicKey] }; });
        restarted();
        expect(await texts(dm.id)).toEqual(['Shall I cancel the order?', 'No', 'New phone. Still on for Saturday?']);
        expect(await sendTo(dm.id, 'Yes, Saturday', [k2, ben])).toEqual({ err: null, posts: 1, rowsAdded: 1, readBy: ['Ben on a new phone'] });
    });

    it('P15: P14 with formerKeys withheld places none of Ben\'s lines: no pin, sends refused as not locked; the listing with formerKeys then gives P14\'s pause', async () => {
        await aQuestionAndAnAnswer();
        benRekeys({ formerKeys: false });
        saysTo(k2, dm, 'New phone. Still on for Saturday?');
        await restoredPhone();
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        expect(await sendTo(dm.id, 'Hello?', [k2, ben, puppet])).toEqual({ err: 'DmNotLockedError', posts: 0, rowsAdded: 0, readBy: [] });
        expect(pinOf(ana, dm.id)).toMatchObject({ unplaced: true, listed: k2.publicKey });
        expect(pinOf(ana, dm.id).peer).toBeUndefined();
        expect(await isDmUnplaced(dm.id)).toBe(true);
        dm.formerKeys = { [k2.publicKey]: [makeKeySuccession({ newEdPrivHex: k2.privateKey, oldPubHex: ben.publicKey, at: '2026-10-03T00:00:00.000Z' })] };
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(await isDmUnplaced(dm.id)).toBe(false);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: k2.publicKey, firstSight: true, nodeSays: { rekeyedAt: '2026-10-03T00:00:00.000Z' } } });
        expect(await sendTo(dm.id, 'Hello?', [k2, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    it('P16 (the documented limit, asserted so a change is deliberate): a restored phone meeting [Ana, PUPPET] with ALL history withheld pins PUPPET, and the send goes', async () => {
        await aQuestionAndAnAnswer();
        dm.participants = [ana.publicKey, puppet.publicKey];
        node.lines = [];
        await restoredPhone();
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        expect(await sendTo(dm.id, 'Hello Ben', [puppet])).toEqual({ err: null, posts: 1, rowsAdded: 1, readBy: ['Puppet'] });
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, by: 'first-seen', checked: true });
    });

    for (const [lines, outcome] of [['Ben-only', 'pause'], ['Ben then K2', 'pause'], ['K2 then Ben', 'refused']] as const) {
        it(`P17: the update, with rows [Ana, Ben, K2] and lines ${lines}: ${outcome === 'pause' ? 'Ben pinned, K2 offered' : 'rule 5, no pin'}; never a pin to K2 from the listing`, async () => {
            if (lines === 'K2 then Ben') saysTo(k2, dm, 'K2 first');
            sealed(ana, ben, dm, 'Shall I cancel the order?');
            sealed(ben, ana, dm, 'No');
            if (lines === 'Ben then K2') saysTo(k2, dm, 'New phone. Still on?');
            await phoneOf(ana);
            // A build without pins: its sync only ever added participants, so the rows now hold Ben and K2.
            noPinStore(ana);
            restarted();
            sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, k2.publicKey);
            dm.participants = [ana.publicKey, k2.publicKey];
            await syncMessages(ana.publicKey);
            const pending = await isDmKeyChangePending(dm.id);
            const sent = await sendTo(dm.id, 'The code is 4821', [k2, ben]);
            if (outcome === 'pause') {
                expect(pending).toBe(true);
                expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: k2.publicKey } });
                expect(sent).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
            } else {
                expect(pending).toBe(false);
                expect(pinOf(ana, dm.id)).toMatchObject({ unplaced: true });
                expect(sent).toEqual({ err: 'DmNotLockedError', posts: 0, rowsAdded: 0, readBy: [] });
            }
            expect(pinOf(ana, dm.id)?.peer).not.toBe(k2.publicKey);
        });
    }

    // §3.4 amendment 2, finding 4: first sight reads both ends of the thread (the oldest 20 and the newest 20 encrypted
    // lines), so a flood of new lines can't push the start of the thread this phone holds out of the judgement.
    /**
     * A line PUPPET seals with Ana named as its sender, in a row the node writes in Ana's name: PUPPET's word twice over.
     * The two ends of a DM share one secret (core dm-crypto: "either of them could seal a line naming the other as
     * sender"), so PUPPET seals it with that secret directly; the app's own seal refuses another sender.
     */
    function forgedAsAna(conv: Conv, text: string, extra: Partial<Line> = {}): Line {
        const messageId = extra.id ?? randomUUID().toLowerCase();
        const key = deriveDmKey({ myEdPrivHex: puppet.privateKey, peerEdPubHex: ana.publicKey, conversationId: conv.id });
        const nonce = new Uint8Array(24).map(() => Math.floor(Math.random() * 256));
        const words = Buffer.from(text, 'utf8');
        const framed = new Uint8Array([3, 0, ...words]);   // format 3, nothing it is written after
        const ct = xchacha20poly1305(key, nonce, dmLineAad(conv.id, { senderPubHex: ana.publicKey, messageId, part: 'body' })).encrypt(framed);
        return written(conv, ana, Buffer.from(ct).toString('base64'), DM_NONCE_PREFIX + Buffer.from(nonce).toString('base64'), { id: messageId, ...extra });
    }

    for (const forged of [false, true]) {
        it(`P17f: the update, rows [Ana, Ben, PUPPET], then 20 PUPPET lines${forged ? ' and one sealed by PUPPET in Ana\'s name' : ''}: Ben pinned from the old end, PUPPET offered, nothing goes`, async () => {
            await aQuestionAndAnAnswer();
            await phoneOf(ana);
            // A build without pins: its sync only ever added participants, so the rows now hold Ben and PUPPET.
            noPinStore(ana);
            restarted();
            sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, puppet.publicKey);
            dm.participants = [ana.publicKey, puppet.publicKey];
            for (let i = 0; i < 20; i++) saysTo(puppet, dm, `PUPPET line ${i}`);
            if (forged) forgedAsAna(dm, 'Ben, I am on my new phone now');
            await syncMessages(ana.publicKey);
            expect(await isDmKeyChangePending(dm.id)).toBe(true);
            expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
            expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        });
    }

    // §3.4 amendment 2, item 3: a line that opens only under the offered key shows no words. Which lines are from the offered
    // key is computed and tested where it is drawn, in slice 2 (#1872 ultrareview, U8: nothing on slice 1 reads it).
    const lineMarks = async (id: string) => (await getMessages(id)).map((m: any) => ({ text: m.text }));

    /** Ben's history of `n` lines (Ana's and Ben's in turn, each sealed to the other), as the node holds it. */
    async function bensHistory(n: number) {
        await aQuestionAndAnAnswer();
        for (let i = 2; i < n; i++) if (i % 2) sealed(ben, ana, dm, `Ben ${i}`); else sealed(ana, ben, dm, `Ana ${i}`);
    }

    it('P20: a restored phone, Ben\'s 30 lines served and then 20 PUPPET lines with PUPPET listed: the old end pins Ben, PUPPET offered, nothing goes', async () => {
        await bensHistory(30);
        dm.participants = [ana.publicKey, puppet.publicKey];
        for (let i = 0; i < 20; i++) saysTo(puppet, dm, `PUPPET line ${i}`);
        await restoredPhone();
        expect(rowsIn(dm.id)).toBe(50);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    it('P20 with Ben\'s lines withheld (the stated residual, asserted so a change is deliberate): 20 PUPPET lines alone pin PUPPET, and the send goes', async () => {
        await bensHistory(30);
        dm.participants = [ana.publicKey, puppet.publicKey];
        node.lines = [];
        for (let i = 0; i < 20; i++) saysTo(puppet, dm, `PUPPET line ${i}`);
        await restoredPhone();
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        expect(await sendTo(dm.id, 'Hello Ben', [puppet, ben])).toEqual({ err: null, posts: 1, rowsAdded: 1, readBy: ['Puppet'] });
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, by: 'first-seen', checked: true });
    });

    it('rows that aren\'t lines (tombstones, a nonce in other capitals) dated before Ben\'s history don\'t push the old end out of the judgement', async () => {
        await aQuestionAndAnAnswer();
        const first = node.lines.reduce((m, l) => (l.timestamp < m ? l.timestamp : m), node.lines[0].timestamp);
        for (let i = 0; i < 20; i++) {
            const at = new Date(Date.parse(first) - (40 - i) * 60_000).toISOString();
            const l = saysTo(puppet, dm, `old ${i}`, { timestamp: at });
            if (i % 2) l.type = 'removed'; else l.nonce = l.nonce.toUpperCase();
        }
        await phoneOf(ana);
        noPinStore(ana);
        restarted();
        sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, puppet.publicKey);
        dm.participants = [ana.publicKey, puppet.publicKey];
        for (let i = 0; i < 20; i++) saysTo(puppet, dm, `PUPPET line ${i}`);
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    // §3.4 amendment 3: the window is ordered by the phone's own clock (rowid: the order it first stored each line in), the
    // 20 lines held longest and the 20 held most recently. The node's timestamps are not consulted.
    const flooded = ['in the first sync after the update', 'held at the update'] as const;
    /** Ben's history the way an existing phone holds it at the update: a build without pins, whose sync only added participants. */
    async function bensHistoryHeld(n: number) {
        await bensHistory(n);
        await phoneOf(ana);
    }
    /** The update: the pins met for the first time, with the rows naming Ben and PUPPET (P17f's set-up). */
    function theUpdate() {
        noPinStore(ana);
        restarted();
        sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, puppet.publicKey);
        dm.participants = [ana.publicKey, puppet.publicKey];
    }
    /** 20 lines dated before the thread's first and 20 after its last, all served in one answer (the node's own order: by date). */
    function floodBothEnds(line: (text: string, extra: Partial<Line>) => Line) {
        const first = node.lines.reduce((m, l) => (l.timestamp < m ? l.timestamp : m), node.lines[0].timestamp);
        const lines: Line[] = [];
        for (let i = 0; i < 20; i++) lines.push(line(`PUPPET early ${i}`, { timestamp: new Date(Date.parse(first) - (40 - i) * 60_000).toISOString() }));
        for (let i = 0; i < 20; i++) lines.push(line(`PUPPET late ${i}`, {}));
        node.serve = (conv) => node.lines.filter((l) => l.conversationId === conv.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        return lines;
    }
    const bensTexts = (n: number) => ['Shall I cancel the order?', 'No', ...Array.from({ length: n - 2 }, (_, k) => (k + 2) % 2 ? `Ben ${k + 2}` : `Ana ${k + 2}`)];
    /** The flood, before or after the update; then the first post-update sync, and the verdict P21 and P22 must hold. */
    async function p21(when: typeof flooded[number], line: (text: string, extra: Partial<Line>) => Line) {
        await bensHistoryHeld(30);
        if (when === 'held at the update') {
            dm.participants = [ana.publicKey, puppet.publicKey];
            floodBothEnds(line);
            await syncMessages(ana.publicKey);   // the last sync before the update stored them after Ben's 30
            expect(rowsIn(dm.id)).toBe(70);
            theUpdate();
        } else {
            theUpdate();
            floodBothEnds(line);
        }
        await syncMessages(ana.publicKey);
        expect(rowsIn(dm.id)).toBe(70);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        const marks = await lineMarks(dm.id);
        expect(marks.filter((m) => m.text === NOT_VERIFIED)).toHaveLength(40);
        expect(marks.filter((m) => m.text !== NOT_VERIFIED).map((m) => m.text)).toEqual(bensTexts(30));
        expect(JSON.stringify(marks)).not.toContain('PUPPET');
    }

    for (const when of flooded) {
        it(`P21: an existing phone at the update, Ben's 30 lines held; 20 PUPPET lines dated before them and 20 after, ${when}: Ben pinned, PUPPET offered, nothing goes; PUPPET's 40 are the fixed line, Ben's read`, async () => {
            await p21(when, (text, extra) => saysTo(puppet, dm, text, extra));
        });

        it(`P22: P21 (${when}) with PUPPET's lines written in Ana's name (sealed by PUPPET naming her) and one marked edited: the same verdict (authors and dates are not consulted)`, async () => {
            let edited = false;
            await p21(when, (text, extra) => {
                const l = forgedAsAna(dm, text, extra);
                if (!edited) { l.editedAt = new Date(Date.parse(l.timestamp) + 60_000).toISOString(); edited = true; }
                return l;
            });
        });
    }

    it('P23 (the residual, asserted so a change is deliberate): a restored phone served 20 PUPPET lines, Ben\'s 30, then 20 PUPPET lines in that order: both ends are PUPPET\'s by arrival, rule 2 pins PUPPET, and the send goes', async () => {
        await bensHistory(30);
        const bens = [...node.lines];
        dm.participants = [ana.publicKey, puppet.publicKey];
        const before = Array.from({ length: 20 }, (_, i) => saysTo(puppet, dm, `PUPPET first ${i}`));
        const after = Array.from({ length: 20 }, (_, i) => saysTo(puppet, dm, `PUPPET last ${i}`));
        node.serve = () => [...before, ...bens, ...after];
        await restoredPhone();
        expect(rowsIn(dm.id)).toBe(70);
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        expect(await sendTo(dm.id, 'Hello Ben', [puppet, ben])).toEqual({ err: null, posts: 1, rowsAdded: 1, readBy: ['Puppet'] });
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, by: 'first-seen', checked: true });
    });

    it('P23b: a restored phone served PUPPET\'s 20 lines (dated after Ben\'s) before Ben\'s 30: by arrival Ben\'s lines are the new end, not the listed key\'s: rule 5, nothing goes (either end read by date would pin)', async () => {
        await bensHistory(30);
        const bens = [...node.lines];
        dm.participants = [ana.publicKey, puppet.publicKey];
        const puppets = Array.from({ length: 20 }, (_, i) => saysTo(puppet, dm, `PUPPET ${i}`));
        node.serve = () => [...puppets, ...bens];
        await restoredPhone();
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        expect(await isDmUnplaced(dm.id)).toBe(true);
        expect(await sendTo(dm.id, 'Hello Ben', [puppet, ben])).toEqual({ err: 'DmNotLockedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    /** PUPPET's copy of a line, under its id: sealed to Ana as PUPPET's own (Ben's lines) or in Ana's name (hers), marked edited. */
    function rewrittenByPuppet(l: Line): void {
        const text = `PUPPET wrote over ${l.id.slice(0, 4)}`;
        const copy = l.authorPubkey === ana.publicKey ? forgedAsAna(dm, text, { id: l.id }) : sealed(puppet, ana, dm, text, { id: l.id });
        node.lines.splice(node.lines.indexOf(copy), 1);
        Object.assign(l, { ciphertext: copy.ciphertext, nonce: copy.nonce, editedAt: new Date().toISOString() });
    }

    // The pin's memory starts at the update (§3.7, amendment 3 companion a): what the phone held then is judged before the
    // first sync writes, so a rewrite or tombstone the node serves after it moves nothing.
    for (const closed of [false, true]) {
        it(`P24: the update with P21's rows held, and a first sync that rewrites every one of Ben's lines with PUPPET's${closed ? ', the app closed before Ana opens the chat' : ''}: judged on the lines held first, Ben pinned; the rewritten lines show the fixed line, never PUPPET's words`, async () => {
            await bensHistoryHeld(30);
            theUpdate();
            for (const l of node.lines.filter((x) => x.conversationId === dm.id)) rewrittenByPuppet(l);
            await syncMessages(ana.publicKey);
            if (closed) restarted();
            expect(await isDmKeyChangePending(dm.id)).toBe(true);
            expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
            // Ana's lines (PUPPET's copies in her name) open under the offered key: the fixed line. Ben's (PUPPET's copies as
            // its own, in rows that name Ben) open under no key: unverified. None shows PUPPET's words.
            const marks = await lineMarks(dm.id);
            expect(marks.map((m) => m.text)).toEqual(Array(30).fill(NOT_VERIFIED));
            expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        });
    }

    it('P25 (honest): an existing phone held Ben\'s lines, Ben re-keyed to K2 before the update and K2\'s 3 lines synced live: a pause with K2 offered (rule 4) and the date; after Continue every line reads', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        benRekeys({ formerKeys: true });
        for (let i = 0; i < 3; i++) saysTo(k2, dm, `K2 line ${i}`);
        await syncMessages(ana.publicKey);   // live, on the build before the update
        noPinStore(ana);
        restarted();
        sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, k2.publicKey);
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: k2.publicKey, firstSight: true, nodeSays: { rekeyedAt: '2026-10-03T00:00:00.000Z' } } });
        expect(await sendTo(dm.id, 'See you Saturday', [k2, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        editStoredPins(ana, (pins) => { pins[dm.id.toLowerCase()] = { peer: k2.publicKey, since: '2026-10-14T00:00:00.000Z', by: 'member', former: [ben.publicKey] }; });
        restarted();
        expect(await texts(dm.id)).toEqual(['Shall I cancel the order?', 'No', 'K2 line 0', 'K2 line 1', 'K2 line 2']);
        expect(await sendTo(dm.id, 'See you Saturday', [k2, ben])).toEqual({ err: null, posts: 1, rowsAdded: 1, readBy: ['Ben on a new phone'] });
    });

    it('P26 (P19\'s counter at the update): one first sight reads the thread\'s two ends once, 2 queries; the sync, the screen\'s checks, a poll, a photo and a send read them no more', async () => {
        const { question } = await aQuestionAndAnAnswer();
        await phoneOf(ana);
        theUpdate();
        for (let i = 0; i < 3; i++) saysTo(puppet, dm, `PUPPET line ${i}`);
        const db = await getDb();
        const getAll = vi.mocked(db.getAllAsync);
        const firstSightQueries = () => getAll.mock.calls.filter((c) => /^SELECT id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata FROM messages\s+WHERE \(conversation_id = \? OR conversation_id IN/.test(String(c[0]))).length;
        getAll.mockClear();
        await syncMessages(ana.publicKey);
        expect(firstSightQueries()).toBe(2);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        for (let poll = 0; poll < 3; poll++) expect(await isDmKeyChangePending(dm.id)).toBe(true);
        await syncMessages(ana.publicKey);
        await getMessages(dm.id);
        await getDecryptedAttachment(dm.id, question.id);
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        expect(firstSightQueries()).toBe(2);
    });

    it('the sync keeps a held line where it was first stored (rowid): an edit, a tombstone and a re-sent copy rewrite the row in place, so they never move it to the new end', async () => {
        await bensHistoryHeld(6);
        const place = () => Object.fromEntries((sql.prepare('SELECT id, rowid AS r FROM messages WHERE conversation_id = ?').all(dm.id) as any[]).map((x) => [x.id, x.r]));
        const held = place();
        const [first, second, third] = node.lines;
        first.editedAt = new Date().toISOString();
        first.metadata = JSON.stringify({ edited: true });
        Object.assign(second, { type: 'removed', ciphertext: b64('This message was deleted'), metadata: JSON.stringify({ removed: true }) });
        third.metadata = JSON.stringify({ reactions: { '👍': [ana.publicKey] } });
        await syncMessages(ana.publicKey);
        const now = place();
        expect((sql.prepare('SELECT type FROM messages WHERE id = ?').get(second.id) as any).type).toBe('removed');
        expect(now).toEqual(held);
    });

    // Every writer of a DM's rows or lines reads the pins first (#1872/#1873 confirmation 2, finding 3): the open chat's poll
    // and a new chat's answer, each the run's first writer.
    it('the update, a push opens Ben\'s chat before any sync (the open chat\'s poll first), the node serving PUPPET\'s copies of his held lines; then a clean listing: judged on the lines held, Ben pinned, PUPPET offered, nothing goes', async () => {
        await bensHistoryHeld(30);
        theUpdate();
        for (const l of node.lines.filter((x) => x.conversationId === dm.id)) rewrittenByPuppet(l);
        await syncSingleConversation(dm.id);
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    it('the update, Ana\'s first act a new chat with Ben, the node answering with their held DM (no line in it yet) and [Ana, PUPPET]: Ben pinned checked from the rows held, PUPPET offered, nothing goes', async () => {
        node.lines = [];
        await phoneOf(ana);
        noPinStore(ana);
        restarted();
        dm.participants = [ana.publicKey, puppet.publicKey];
        (globalThis as any).fetch = async (url: string, init: any = {}) => (init.method === 'POST' && new URL(url).pathname === '/api/messages/conversation'
            ? answer(200, { conversation: { id: dm.id, type: 'dm', participants: dm.participants, createdBy: ana.publicKey } })
            : fetchMock(url, init));
        expect((await createConversationApi('dm', [ana.publicKey, ben.publicKey], ana.publicKey)).id).toBe(dm.id);
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    // §3.4 amendment 2, option H: a first-sight pause ends only on the member's tap. A listing is the node's word, and the
    // pause exists because the listing and the history disagreed; no listing settles that, not even one naming the pin.
    const stillPaused = { err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] };
    /** B's set-up: Ben listed with his history, and one PUPPET line the node dated an hour before it (rule 4 pins PUPPET). */
    async function backdated() {
        await aQuestionAndAnAnswer();
        const first = node.lines.reduce((m, l) => (l.timestamp < m ? l.timestamp : m), node.lines[0].timestamp);
        saysTo(puppet, dm, 'Hi Ana, it is Ben', { timestamp: new Date(Date.parse(first) - 3_600_000).toISOString() });
        await restoredPhone();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, checked: true, offered: { peer: ben.publicKey, firstSight: true } });
    }

    it('B: a restored phone pins PUPPET from a backdated line, Ben offered; the listing then flips to PUPPET: still paused, Ben\'s code stays on the banner, nothing goes', async () => {
        await backdated();
        expect(await sendTo(dm.id, 'Is that you?', [puppet, ben])).toEqual(stillPaused);
        dm.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id).offered).toMatchObject({ peer: ben.publicKey, firstSight: true });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual(stillPaused);
    });

    it('B-detour: B, then the listing names a third key, then PUPPET again: the pause is still first sight, nothing goes', async () => {
        await backdated();
        const q = person('Q');
        dm.participants = [ana.publicKey, q.publicKey];
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, offered: { peer: q.publicKey, firstSight: true } });
        dm.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, offered: { firstSight: true } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben, q])).toEqual(stillPaused);
    });

    it('F: a rule-5 record, a prune and a relist [Ana, Ben] with only PUPPET\'s lines (a pause on PUPPET), then a flip to PUPPET: still paused, nothing goes', async () => {
        await aQuestionAndAnAnswer();
        for (const l of node.lines) if (l.authorPubkey === ben.publicKey) l.authorPubkey = puppet.publicKey;   // re-attributed, no formerKeys
        dm.participants = [ana.publicKey, puppet.publicKey];
        saysTo(puppet, dm, 'New phone, same Ben.');
        await restoredPhone();
        expect(await sendTo(dm.id, 'Hello?', [puppet])).toEqual({ err: 'DmNotLockedError', posts: 0, rowsAdded: 0, readBy: [] });
        node.convs = [];
        await syncMessages(ana.publicKey);
        node.lines = [];
        dm.participants = [ana.publicKey, ben.publicKey];
        saysTo(puppet, dm, 'It is me.');
        saysTo(puppet, dm, 'Text me the code.');
        node.convs = [dm];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, offered: { peer: ben.publicKey, firstSight: true } });
        dm.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual(stillPaused);
    });

    it('H-exit: P13, "Not now", then the node lists Ben again: still paused; a new DM with Ben pins Ben and the line goes to him', async () => {
        await p13();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);   // the banner; "Not now" writes nothing
        dm.participants = [ana.publicKey, ben.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey, firstSight: true } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual(stillPaused);
        const fresh: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs.push(fresh);
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(fresh.id)).toBe(false);
        expect(await sendTo(fresh.id, 'Ben, the code is 4821', [puppet, ben])).toEqual({ err: null, posts: 1, rowsAdded: 1, readBy: ['Ben'] });
        expect(pinOf(ana, fresh.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', checked: true });
    });

    it('H-control: an existing phone\'s offer (pin Ben checked, the node lists PUPPET, then Ben again) clears, and the line goes to Ben', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true });
        dm.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id).offered).toEqual({ peer: puppet.publicKey, at: expect.any(String) });
        expect(await sendTo(dm.id, 'Hello?', [puppet, ben])).toEqual(stillPaused);
        dm.participants = [ana.publicKey, ben.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        expect(pinOf(ana, dm.id).offered).toBeUndefined();
        expect(await sendTo(dm.id, 'Hello Ben', [puppet, ben])).toEqual({ err: null, posts: 1, rowsAdded: 1, readBy: ['Ben'] });
    });

    it('R5: "Not now" on a restored phone\'s pause, then a prune and a relist with the history withheld: still paused, nothing goes', async () => {
        await p13();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);   // the banner; "Not now" writes nothing
        node.convs = [];
        await syncMessages(ana.publicKey);
        expect(rowsIn(dm.id)).toBe(0);
        node.lines = [];
        node.convs = [dm];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821', [puppet])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
    });

    for (const relist of ['no history', 'only PUPPET\'s own lines']) {
        it(`R5 for rule 5: lines it couldn't place, then a prune and a relist with ${relist}: still refused, the listed key never taken`, async () => {
            await aQuestionAndAnAnswer();
            for (const l of node.lines) if (l.authorPubkey === ben.publicKey) l.authorPubkey = puppet.publicKey;   // re-attributed, no formerKeys
            dm.participants = [ana.publicKey, puppet.publicKey];
            saysTo(puppet, dm, 'New phone, same Ben.');
            await restoredPhone();
            expect(await sendTo(dm.id, 'Hello?', [puppet])).toEqual({ err: 'DmNotLockedError', posts: 0, rowsAdded: 0, readBy: [] });
            node.convs = [];
            await syncMessages(ana.publicKey);
            node.lines = [];
            if (relist !== 'no history') { saysTo(puppet, dm, 'It is me.'); saysTo(puppet, dm, 'Text me the code.'); }
            node.convs = [dm];
            await syncMessages(ana.publicKey);
            expect(pinOf(ana, dm.id)).toMatchObject({ unplaced: true });
            expect(await sendTo(dm.id, 'The code is 4821', [puppet])).toEqual({ err: 'DmNotLockedError', posts: 0, rowsAdded: 0, readBy: [] });
        });
    }

    it('the seed from the phone\'s own rows is final only on the first pass: a restored phone\'s rows from a listing (a DM listed as a group\'s chat) never seed a pin to PUPPET', async () => {
        await aQuestionAndAnAnswer();
        dm.type = 'group_thread';
        dm.participants = [ana.publicKey, puppet.publicKey];
        await restoredPhone();
        for (let pass = 0; pass < 2; pass++) await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id)?.checked).toBeUndefined();
        expect(await sendTo(dm.id, 'Sorry, I have to decline', [puppet])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
    });

    // A capitals twin of Ben's DM on a restored phone (#1872/#1873 confirmation review, finding 2): the pin is kept under
    // the folded id, so its first sight is judged on the lines of every spelling this phone holds, never one spelling's.
    /** The node answers its conversation listing with a 500 from now on (it chooses which routes answer). */
    function listingsFail(): () => void {
        const realFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string, init?: any) => {
            if (new URL(url).pathname.startsWith('/api/messages/conversations/')) return { ok: false, status: 500, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
            return realFetch(url, init);
        };
        return () => { (globalThis as any).fetch = realFetch; };
    }

    // Which row the node lists first is the order a restored phone first stores their lines in (§3.4 amendment 3): Ben's
    // first, his lines are the old end and the twin's PUPPET line is new (a pause on Ben); the twin first, PUPPET's line is
    // the old end and Ben's lines come after it under a key the listing doesn't name (rule 5: no pin, sends refused).
    // Nothing goes to PUPPET in either order.
    for (const first of ['Ben\'s row', 'the twin'] as const) {
        const paused = first === 'Ben\'s row';
        const refused = paused ? 'DmKeyChangedError' : 'DmNotLockedError';
        it(`T2: restored phone, a twin with a PUPPET line and Ben's row listed [Ana, PUPPET] with his history, ${first} listed first; Ana opens the twin first: ${paused ? 'both rows pause on Ben' : 'rule 5, no pin'}, nothing goes`, async () => {
            await aQuestionAndAnAnswer();
            const twin: Conv = { id: dm.id.toUpperCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
            dm.participants = [ana.publicKey, puppet.publicKey];
            node.convs = paused ? [dm, twin] : [twin, dm];
            saysTo(puppet, twin, 'Hi Ana, it is Ben on my new number');
            await restoredPhone();
            expect(await isDmKeyChangePending(twin.id)).toBe(paused);
            await syncMessages(ana.publicKey);
            if (paused) expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
            else expect(pinOf(ana, dm.id)).toMatchObject({ unplaced: true, listed: puppet.publicKey });
            expect(await isDmKeyChangePending(dm.id)).toBe(paused);
            expect(await sendTo(dm.id, 'Ben, the code is 4821', [puppet, ben])).toEqual({ err: refused, posts: 0, rowsAdded: 0, readBy: [] });
            expect(await sendTo(twin.id, 'Is that you, Ben?', [puppet, ben])).toEqual({ err: refused, posts: 0, rowsAdded: 0, readBy: [] });
        });
    }

    for (const [variant, first] of [['the twin has a PUPPET line; Ana opens it', 'Ben\'s row'], ['the twin has a PUPPET line; Ana opens it', 'the twin'], ['the twin is empty; Ana sends there first (#1863 E2)', 'the twin']] as const) {
        it(`T: restored phone, ${first} listed first, then the node refuses its listings; ${variant}, then Ben's row: Ben's row never seals to PUPPET`, async () => {
            await aQuestionAndAnAnswer();
            const twin: Conv = { id: dm.id.toUpperCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
            node.convs = first === 'the twin' ? [twin, dm] : [dm, twin];
            // PUPPET's twin line stored before Ben's lines: rule 5 for the folded id (no pin, every send refused as not locked).
            const unplaced = first === 'the twin' && variant.startsWith('the twin has');
            if (variant.startsWith('the twin has')) saysTo(puppet, twin, 'Hi Ana, it is Ben on my new number');
            await restoredPhone();
            const restore = listingsFail();
            try {
                await getMessages(twin.id);
                await isDmKeyChangePending(twin.id);
                if (variant.includes('sends there')) {
                    expect(await sendTo(twin.id, 'Hi, who is this?', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
                }
                await syncMessages(ana.publicKey);
                if (unplaced) expect(pinOf(ana, dm.id)).toMatchObject({ unplaced: true });
                else expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
                expect((await getMessages(dm.id)).map((m: any) => m.text)).toEqual(['Shall I cancel the order?', 'No']);
                expect(await sendTo(dm.id, 'Ben, the code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
                // The send's refresh names Ben: rule 5 judged again is rule 4 by the phone's clock, PUPPET's line first (B's pause).
                if (unplaced) expect(pinOf(ana, dm.id)).toMatchObject({ peer: puppet.publicKey, checked: true, offered: { peer: ben.publicKey, firstSight: true } });
            } finally { restore(); }
        });
    }
});

describe('the update\'s memory holds past the first pass and the first run (#1872/#1873 confirmation 2, finding 1)', () => {
    let puppet: Person;
    let deleted: string[] = [];
    beforeEach(() => {
        puppet = person('Puppet');
        deleted = [];
        // The stand-in lists no deleted accounts; the node here names whoever it likes (conversations' deletedAccounts).
        (globalThis as any).fetch = async (url: string, init?: any) => {
            const r: any = await fetchMock(url, init);
            if (!new URL(url).pathname.startsWith('/api/messages/conversations/') || !r.ok) return r;
            return answer(r.status, { ...(await r.json()), deletedAccounts: deleted });
        };
    });
    const pinOf = (id: string) => storedPins(ana)[id.toLowerCase()] ?? null;
    const opensFor = (who: Person, l: Line) => {
        try {
            return phoneCrypto.openDmLine({ ciphertext: l.ciphertext, nonce: l.nonce }, { myEdPrivHex: who.privateKey, peerEdPubHex: ana.publicKey },
                { conversationId: l.conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }).text;
        } catch { return null; }
    };
    function sealed(from: Person, to: Person, conv: Conv, text: string, extra: Partial<Line> = {}): Line {
        const messageId = extra.id ?? randomUUID().toLowerCase();
        const p = phoneCrypto.sealDmLine(text, { myEdPrivHex: from.privateKey, peerEdPubHex: to.publicKey, conversationId: conv.id } as any,
            { senderPubHex: from.publicKey, messageId, part: 'body', after: null, replyToId: null } as any);
        return written(conv, from, p.ciphertext, p.nonce, { id: messageId, ...extra });
    }
    async function sendTo(id: string, text: string) {
        const before = node.lines.length;
        let err: any = null;
        try { await insertMessage(id, ana.publicKey, text); } catch (e) { err = e; }
        if (!err) await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        const sent = node.lines.slice(before);
        return { err: err?.name ?? null, posts: sent.length, readBy: [ben, puppet].filter((p) => sent.some((l) => opensFor(p, l) !== null)).map((p) => p.name) };
    }
    /** An existing phone at the update: Ben's lines held, its rows naming Ben and PUPPET (an old build's add-only sync, P17f). */
    async function heldThenUpdate(anaWrote: boolean, listed: Person[]) {
        if (anaWrote) sealed(ana, ben, dm, 'Shall I cancel the order?');
        for (let i = 0; i < 4; i++) sealed(ben, ana, dm, `Ben ${i}`);
        await phoneOf(ana);
        noPinStore(ana);
        restarted();
        sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, puppet.publicKey);
        dm.participants = listed.map((p) => p.publicKey);
    }
    const paused = { err: 'DmKeyChangedError', posts: 0, readBy: [] };

    it('the first listing after the update names Ben as deleted (Ana never wrote): his lines are held by the seed before the blanking, so Ben is pinned, PUPPET offered, nothing goes', async () => {
        await heldThenUpdate(false, [ana, puppet]);
        sealed(puppet, ana, dm, 'New phone, same Ben. What is the door code?');
        deleted = [ben.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
    });

    it('the same with a line of Ana\'s in the thread: the pause on Ben, never rule 5 (amendment 3: disagreement pauses on Ben)', async () => {
        await heldThenUpdate(true, [ana, puppet]);
        sealed(puppet, ana, dm, 'New phone, same Ben. What is the door code?');
        deleted = [ben.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmUnplaced(dm.id)).toBe(false);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
    });

    for (const run2 of ['rewrites every held line with PUPPET\'s', 'tombstones every held line'] as const) {
        it(`the first run lists the DM with several keys (not judged), the app restarts, then the node ${run2} and lists [Ana, PUPPET]: still judged on the lines held at the update, nothing goes`, async () => {
            await heldThenUpdate(true, [ana, ben, puppet]);
            await syncMessages(ana.publicKey);
            expect(pinOf(dm.id)).toBeNull();
            restarted();   // the next app run
            for (const l of node.lines.filter((x) => x.conversationId === dm.id)) {
                if (run2 === 'tombstones every held line') {
                    Object.assign(l, { type: 'removed', ciphertext: b64('This message was deleted'), nonce: 'plaintext-v1', metadata: JSON.stringify({ removed: true, removedBy: l.authorPubkey }) });
                } else {
                    const copy = sealed(puppet, ana, dm, `PUPPET over ${l.id.slice(0, 4)}`, { id: l.id });
                    node.lines.splice(node.lines.indexOf(copy), 1);
                    Object.assign(l, { authorPubkey: l.authorPubkey, ciphertext: copy.ciphertext, nonce: copy.nonce, editedAt: new Date().toISOString() });
                }
            }
            dm.participants = [ana.publicKey, puppet.publicKey];
            await syncMessages(ana.publicKey);
            expect(await isDmKeyChangePending(dm.id)).toBe(true);
            expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
            expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
        });
    }

    it('the first run doesn\'t list the DM (pruned), the app restarts, then the node lists [Ana, PUPPET] with the history withheld: Ben pinned from the lines held at the update, nothing goes', async () => {
        await heldThenUpdate(true, [ana, puppet]);
        node.convs = [];
        await syncMessages(ana.publicKey);
        expect((sql.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(dm.id) as any).n).toBe(0);
        restarted();
        node.convs = [dm];
        node.lines = node.lines.filter((l) => l.conversationId !== dm.id);
        sealed(puppet, ana, dm, 'New phone, same Ben. What is the door code?');
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
    });

    it('the pins lost after the update (a write that failed), the node\'s copies synced over the held lines in between: the next seed keeps the update\'s held lines, never re-taken from the node\'s, nothing goes', async () => {
        await heldThenUpdate(true, [ana, ben, puppet]);
        await syncMessages(ana.publicKey);   // the update's run: listed with several keys, not judged; the held lines kept
        const kept = h.store.get(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_A));
        expect(kept).toBeTruthy();
        restarted();
        for (const l of node.lines.filter((x) => x.conversationId === dm.id)) {
            const copy = sealed(puppet, ana, dm, `PUPPET over ${l.id.slice(0, 4)}`, { id: l.id });
            node.lines.splice(node.lines.indexOf(copy), 1);
            Object.assign(l, { ciphertext: copy.ciphertext, nonce: copy.nonce, editedAt: new Date().toISOString() });
        }
        await syncMessages(ana.publicKey);   // a later run writes PUPPET's copies over the held rows
        h.store.delete(dmPeerPinsStoreKey(ana.publicKey, FILE_A));
        restarted();
        dm.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(h.store.get(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_A))).toBe('{}');   // judged on them and pinned: dropped in that write
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
    });

    it('the update\'s run can\'t read the held-lines store: nothing is written over what it holds, and this run judges on the lines the phone holds now', async () => {
        await heldThenUpdate(false, [ana, puppet]);
        sealed(puppet, ana, dm, 'New phone, same Ben. What is the door code?');
        const LINES = dmLinesAtUpdateStoreKey(ana.publicKey, FILE_A);
        h.store.set(LINES, '{}');   // what an earlier run kept, unreadable now
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k === LINES) throw new Error('storage unavailable'); return real(k); });
        const writes = () => vi.mocked(AsyncStorage.setItem).mock.calls.filter(([k]) => k === LINES).length;
        const before = writes();
        try {
            await syncMessages(ana.publicKey);
            expect(writes() - before).toBe(0);   // never written: not the seed's lines, nor a removal after the pin
            expect(h.store.get(LINES)).toBe('{}');
            expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
            expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
        } finally {
            getItem.mockImplementation(real);
        }
    });

    // §3.4 amendment 4: the record, its removal, a write that fails, and a key that arrives later.
    const LINES = () => dmLinesAtUpdateStoreKey(ana.publicKey, FILE_A);
    const stored = () => JSON.parse(h.store.get(LINES()) ?? 'null') as Record<string, any[]> | null;
    const failingSet = (key: () => string, times = Infinity) => {
        const setItem = vi.mocked(AsyncStorage.setItem);
        const real = setItem.getMockImplementation()!;
        const tried: number[] = [];
        let left = times;
        setItem.mockImplementation(async (k: string, v: string) => {
            if (k === key() && left > 0) { left--; tried.push(v.length); throw new Error('storage full'); }
            return real(k, v);
        });
        return { tried, restore: () => setItem.mockImplementation(real) };
    };
    /** The node rewrites every line of the DM it holds with PUPPET's copy, under the same id, marked edited (the phone takes it). */
    const puppetRewritesHeld = () => {
        for (const l of node.lines.filter((x) => x.conversationId === dm.id)) {
            const copy = sealed(puppet, ana, dm, `PUPPET over ${l.id.slice(0, 4)}`, { id: l.id });
            node.lines.splice(node.lines.indexOf(copy), 1);
            Object.assign(l, { ciphertext: copy.ciphertext, nonce: copy.nonce, editedAt: new Date().toISOString() });
        }
    };
    /** Ben re-keys to `to` on the node: his lines' author moves, and the DM is listed with `to`. */
    const moveAuthor = (from: Person, to: Person) => {
        for (const l of node.lines) if (l.authorPubkey === from.publicKey) l.authorPubkey = to.publicKey;
        dm.participants = [ana.publicKey, to.publicKey];
    };

    it('P27 the record: a phone whose rows pin every DM keeps {} after the seed', async () => {
        sealed(ben, ana, dm, 'Ben 0');
        await phoneOf(ana);
        noPinStore(ana);
        restarted();
        await syncMessages(ana.publicKey);
        expect(h.store.get(LINES())).toBe('{}');
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true });
    });

    it('P27 the record: one DM its rows don\'t pin keeps exactly the open\'s six fields per line, in the order the phone stored them, no date, type or word; signed out and in again, it is judged on them, not on the node\'s copies', async () => {
        await heldThenUpdate(true, [ana, ben, puppet]);
        await syncMessages(ana.publicKey);
        const lines = stored()![dm.id.toLowerCase()];
        const held = sql.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid').all(dm.id).map((r: any) => r.id);
        expect(lines.map((l) => l.id)).toEqual(held);
        expect(lines.length).toBe(5);
        for (const l of lines) expect(Object.keys(l).sort()).toEqual(['author_pubkey', 'ciphertext', 'conversation_id', 'id', 'metadata', 'nonce']);
        const raw = h.store.get(LINES())!;
        for (const word of ['Shall I cancel', 'Ben 0', 'Ben 3', ...node.lines.map((l) => l.timestamp)]) expect(raw).not.toContain(word);
        // Signed out and in (the database wiped and fetched again; the pins and this key outlive the wipe:
        // wipe-identity-storage.test.ts), the node now serving PUPPET's copies of the lines and listing [Ana, PUPPET].
        puppetRewritesHeld();
        dm.participants = [ana.publicKey, puppet.publicKey];
        restarted();
        await phoneOf(ana);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
    });

    it('P28 removal: a DM judged and pinned loses its held lines in that pin write, one still unjudged keeps them; a pin write that throws keeps them; the key stays, {} once all are pinned', async () => {
        const dm2: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs = [dm, dm2];
        sealed(ben, ana, dm2, 'Ben in the other chat');
        await heldThenUpdate(true, [ana, ben, puppet]);
        sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm2.id, puppet.publicKey);
        dm2.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(pinOf(dm2.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(Object.keys(stored()!)).toEqual([dm.id.toLowerCase()]);
        dm.participants = [ana.publicKey, puppet.publicKey];
        const once = failingSet(() => dmPeerPinsStoreKey(ana.publicKey, FILE_A), 1);
        try {
            await syncMessages(ana.publicKey);   // judged, but the pin write throws: nothing pinned, the lines stay
        } finally { once.restore(); }
        expect(once.tried.length).toBe(1);
        expect(pinOf(dm.id)).toBeNull();
        expect(Object.keys(stored()!)).toEqual([dm.id.toLowerCase()]);
        restarted();
        await syncMessages(ana.publicKey);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(h.store.get(LINES())).toBe('{}');
    });

    it('P29 the lines write fails at the seed: the rows\' pins and a heldLost mark go in the first pin write; in that run the DM is still judged on the lines held (W3\'s pause)', async () => {
        const dm2: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs = [dm, dm2];
        sealed(ben, ana, dm2, 'Ben in the other chat');
        await heldThenUpdate(true, [ana, ben, puppet]);
        const full = failingSet(LINES);
        try {
            await syncMessages(ana.publicKey);
            expect(pinOf(dm2.id)).toMatchObject({ peer: ben.publicKey, checked: true });
            expect(pinOf(dm.id)).toEqual({ unplaced: true, since: expect.any(String), listed: null, heldLost: true });
            expect(h.store.has(LINES())).toBe(false);
            puppetRewritesHeld();
            dm.participants = [ana.publicKey, puppet.publicKey];
            await syncMessages(ana.publicKey);   // the same run: judged on the lines held, the mark replaced
        } finally { full.restore(); }
        expect(full.tried.length).toBe(1);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
    });

    it('P29 the lines write failed and no judgement came in that run: after a restart the mark is final; the node\'s rewrite and a clean [Ana, PUPPET] are never judged, every send refused', async () => {
        await heldThenUpdate(true, [ana, ben, puppet]);
        const full = failingSet(LINES);
        try { await syncMessages(ana.publicKey); } finally { full.restore(); }
        expect(pinOf(dm.id)).toMatchObject({ unplaced: true, heldLost: true });
        restarted();
        puppetRewritesHeld();
        dm.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(false);
        expect(await isDmUnplaced(dm.id)).toBe(true);
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmNotLockedError', posts: 0, readBy: [] });
        expect(pinOf(dm.id)).toMatchObject({ unplaced: true, heldLost: true });
    });

    it('P29 the held lines unreadable in a later run: a DM still to judge is refused that run, not judged on the node\'s copies; readable again, it is judged on the lines held', async () => {
        await heldThenUpdate(true, [ana, ben, puppet]);
        await syncMessages(ana.publicKey);
        expect(stored()![dm.id.toLowerCase()]).toHaveLength(5);
        restarted();
        puppetRewritesHeld();
        dm.participants = [ana.publicKey, puppet.publicKey];
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k === LINES()) throw new Error('storage unavailable'); return real(k); });
        try {
            await syncMessages(ana.publicKey);
            expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmNotLockedError', posts: 0, readBy: [] });
        } finally { getItem.mockImplementation(real); }
        restarted();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
    });

    it('P29 1,000 DMs the rows don\'t pin, 40 lines each, at the update: over the 1 MB cap (amendment 5; the 6 MB store would also refuse), so no write is tried and each is marked heldLost; none is read, and the one listed cleanly is still judged in that run', async () => {
        const tpl = Array.from({ length: 40 }, (_, i) => phoneCrypto.sealDmLine(`Can you pick up the bread on your way home? I'll pay you back tomorrow, ${i}.`,
            { myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey, conversationId: dm.id } as any,
            { senderPubHex: ben.publicKey, messageId: randomUUID(), part: 'body', after: null, replyToId: null } as any));
        await heldThenUpdate(true, [ana, ben, puppet]);
        const insConv = sql.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', ?, '2026-10-01T00:00:00.000Z')");
        const insPart = sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)');
        const insLine = sql.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, ?, ?, 'text', '2026-10-01T00:00:00.000Z')");
        const others = [person('X').publicKey, person('Y').publicKey];
        for (let d = 0; d < 999; d++) {
            const id = randomUUID();
            insConv.run(id, ana.publicKey);
            for (const pk of [ana.publicKey, ...others]) insPart.run(id, pk);
            for (const p of tpl) insLine.run(randomUUID(), id, others[0], p.ciphertext, p.nonce);
        }
        dm.participants = [ana.publicKey, puppet.publicKey];
        sealed(puppet, ana, dm, 'New phone, same Ben. What is the door code?');
        const setItem = vi.mocked(AsyncStorage.setItem);
        const real = setItem.getMockImplementation()!;
        const tried: number[] = [];
        setItem.mockImplementation(async (k: string, v: string) => {
            if (k === LINES()) { tried.push(v.length); if (v.length > 6 * 1024 * 1024) throw new Error('database or disk is full'); }
            return real(k, v);
        });
        try { await syncMessages(ana.publicKey); } finally { setItem.mockImplementation(real); }
        expect(tried).toEqual([]);   // over the cap: never written (round 6 measured this write at ~16 KB a DM, over 6 MB in all)
        expect(Object.values(storedPins(ana)).filter((p: any) => p.heldLost === true).length).toBe(999);
        expect(h.store.has(LINES())).toBe(false);
        expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
    }, 120_000);

    for (const anaToo of [false, true]) {
        it(`P30 a key arrives later: Ben re-keyed to K2 before the update with formerKeys withheld (rule 5, its lines kept); the app restarts, the node rewrites Ben's held line with K2's copy${anaToo ? ' and tombstones Ana\'s' : ''}, then lists K2's statement naming Ben: judged on the STORED lines, Ben pinned, K2 offered with the date; Continue reads both`, async () => {
            const k2 = person('Ben on a new phone');
            await phoneOf(ana);
            const asked = await says(ana, dm, 'Shall I cancel the order?');
            const no = sealed(ben, ana, dm, 'No');
            moveAuthor(ben, k2);   // the node moves his line's author; the DM is listed with K2, no statement
            await syncMessages(ana.publicKey);   // the build before the update stores Ben's line under K2
            noPinStore(ana);
            restarted();
            for (const pk of [ben.publicKey, k2.publicKey]) sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, pk);
            await syncMessages(ana.publicKey);
            expect(await isDmUnplaced(dm.id)).toBe(true);
            expect(stored()![dm.id.toLowerCase()].map((l) => l.id)).toEqual([asked.id, no.id]);
            restarted();
            const copy = sealed(k2, ana, dm, 'K2 wrote over it', { id: no.id });
            node.lines.splice(node.lines.indexOf(copy), 1);
            Object.assign(no, { ciphertext: copy.ciphertext, nonce: copy.nonce, editedAt: new Date().toISOString() });
            if (anaToo) Object.assign(asked, { type: 'removed', ciphertext: b64('This message was deleted'), nonce: 'plaintext-v1', metadata: JSON.stringify({ removed: true, removedBy: ana.publicKey }) });
            dm.formerKeys = { [k2.publicKey]: [makeKeySuccession({ newEdPrivHex: k2.privateKey, oldPubHex: ben.publicKey, at: '2026-10-03T00:00:00.000Z' })] };
            await syncMessages(ana.publicKey);
            expect(await isDmKeyChangePending(dm.id)).toBe(true);
            expect(pinOf(dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: k2.publicKey, firstSight: true, nodeSays: { rekeyedAt: '2026-10-03T00:00:00.000Z' } } });
            expect(h.store.get(LINES())).toBe('{}');
            editStoredPins(ana, (pins) => { pins[dm.id.toLowerCase()] = { peer: k2.publicKey, since: '2026-10-14T00:00:00.000Z', by: 'member', former: [ben.publicKey] }; });
            restarted();
            expect((await getMessages(dm.id)).map((m: any) => m.text)).toEqual([anaToo ? 'This message was deleted' : 'Shall I cancel the order?', 'K2 wrote over it']);
        });
    }
});

// ── §3.4 amendment 5: one seed per community file (#1872/#1873 confirmation 3, findings 1, 3 and 4) ─────────────────────
// A phone holds one SQLite file per community (the header's two-file harness: castlemaine has its own). The update's
// memory (the seed: the rows' pins, the held lines, the marks) is taken per (account, file), at the account's first pin
// read with that file open, before any writer touches it, and recorded inside the pin write. Each MC test: Ana and Ben's
// DM held in community B by a build without pins; PUPPET's own key is the oracle wherever a line is sent.
describe('the update\'s memory covers every community on the phone (§3.4 amendment 5)', () => {
    const B_URL = 'https://castlemaine.beanpool.org';
    const FILE_B = 'community_castlemaine.db';
    const mcDbs = (globalThis as any).__phoneDbs;
    let puppet: Person;
    let deleted: string[] = [];
    let other: { lines: Line[]; convs: Conv[] };
    let active: 'A' | 'B' = 'A';
    beforeEach(() => {
        puppet = person('Puppet');
        deleted = [];
        active = 'A';
        other = { lines: [], convs: [] };
        const b = mcDbs.dbFor(FILE_B);
        for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) { try { b.exec(`DELETE FROM ${t}`); } catch { /* not made yet */ } }
        (globalThis as any).fetch = async (url: string, init?: any) => {
            const r: any = await fetchMock(url, init);
            if (!new URL(url).pathname.startsWith('/api/messages/conversations/') || !r.ok) return r;
            return answer(r.status, { ...(await r.json()), deletedAccounts: deleted });
        };
    });
    afterEach(async () => {
        mcDbs.onQuery = null;
        await switchTo('A');
    });
    /** The member switches community: the phone opens that community's file, and the stand-in node is that community's. */
    async function switchTo(which: 'A' | 'B') {
        if (which === active) return;
        const cur = { lines: node.lines, convs: node.convs };
        node.lines = other.lines;
        node.convs = other.convs;
        other = cur;
        active = which;
        h.store.set('beanpool_anchor_url', which === 'B' ? B_URL : ANCHOR);
        await getDb();
    }
    const fileOf = (which: 'A' | 'B') => mcDbs.dbFor(which === 'B' ? FILE_B : FILE_A);
    /** A DM's entry in one community file's pins (B's unless named). */
    const pinOf = (id: string, file = FILE_B) => storedPins(ana, file)[id.toLowerCase()] ?? null;
    /** The files whose update seed ran: those with a pins value stored (its presence is the record, §3.4 amendment 6). */
    const seeded = () => [FILE_A, FILE_B].filter((f) => h.store.has(dmPeerPinsStoreKey(ana.publicKey, f)));
    const linesIn = (file: string) => JSON.parse(h.store.get(dmLinesAtUpdateStoreKey(ana.publicKey, file)) ?? 'null') as Record<string, any[]> | null;
    const opensFor = (who: Person, l: Line) => {
        try {
            return phoneCrypto.openDmLine({ ciphertext: l.ciphertext, nonce: l.nonce }, { myEdPrivHex: who.privateKey, peerEdPubHex: ana.publicKey },
                { conversationId: l.conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }).text;
        } catch { return null; }
    };
    function sealed(from: Person, to: Person, conv: Conv, text: string, extra: Partial<Line> = {}): Line {
        const messageId = extra.id ?? randomUUID().toLowerCase();
        const p = phoneCrypto.sealDmLine(text, { myEdPrivHex: from.privateKey, peerEdPubHex: to.publicKey, conversationId: conv.id } as any,
            { senderPubHex: from.publicKey, messageId, part: 'body', after: null, replyToId: null } as any);
        return written(conv, from, p.ciphertext, p.nonce, { id: messageId, ...extra });
    }
    async function sendTo(id: string, text: string, readers: Person[] = [ben, puppet]) {
        const before = node.lines.length;
        let err: any = null;
        try { await insertMessage(id, ana.publicKey, text); } catch (e) { err = e; }
        if (!err) await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        const sent = node.lines.slice(before);
        return { err: err?.name ?? null, posts: sent.length, readBy: readers.filter((p) => sent.some((l) => opensFor(p, l) !== null)).map((p) => p.name) };
    }
    const paused = { err: 'DmKeyChangedError', posts: 0, readBy: [] };
    /** The node rewrites every line it holds of `conv` with PUPPET's copy, under the same id, marked edited. */
    const puppetRewrites = (conv: Conv) => {
        for (const l of node.lines.filter((x) => x.conversationId === conv.id)) {
            const copy = sealed(puppet, ana, conv, `PUPPET over ${l.id.slice(0, 4)}`, { id: l.id });
            node.lines.splice(node.lines.indexOf(copy), 1);
            Object.assign(l, { ciphertext: copy.ciphertext, nonce: copy.nonce, editedAt: new Date().toISOString() });
        }
    };
    const rowsOf = (which: 'A' | 'B', id: string) => ({
        people: (fileOf(which).prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ?').all(id) as any[]).map((r) => r.public_key).sort(),
        lines: (fileOf(which).prepare('SELECT id, ciphertext FROM messages WHERE conversation_id = ? ORDER BY rowid').all(id) as any[]).map((r) => `${r.id}:${r.ciphertext}`),
    });
    /**
     * Ben's DM held in community B by a build without pins (6 of Ben's lines; `puppetRow`: B's rows name PUPPET too, an
     * old build's add-only sync), then the update, whose first run opens community A; the member then switches to B,
     * whose node lists the DM [Ana, PUPPET] from here on.
     */
    async function heldInBThenUpdateInA(opts: { puppetRow?: boolean } = {}): Promise<Conv> {
        node.convs = [];
        node.lines = [];
        await phoneOf(ana);
        await switchTo('B');
        const dmB: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs = [dmB];
        node.lines = [];
        for (let i = 0; i < 6; i++) sealed(ben, ana, dmB, `Ben ${i}`);
        await syncMessages(ana.publicKey);
        if (opts.puppetRow) fileOf('B').prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dmB.id, puppet.publicKey);
        noPinStore(ana);
        restarted();
        await switchTo('A');
        await syncMessages(ana.publicKey);
        await switchTo('B');
        dmB.participants = [ana.publicKey, puppet.publicKey];
        return dmB;
    }

    it('MC1: B\'s first pass names Ben as deleted, with one PUPPET line: Ben pinned, PUPPET offered, nothing goes', async () => {
        const dmB = await heldInBThenUpdateInA();
        deleted = [ben.publicKey];
        sealed(puppet, ana, dmB, 'New phone, same Ben. What is the door code?');
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dmB.id)).toBe(true);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
    });

    for (const [n, how] of [['MC2', 'rewrites every held line with PUPPET\'s'], ['MC3', 'tombstones every held line']] as const) {
        it(`${n}: B's first pass ${how} and lists [Ana, PUPPET]: Ben pinned, PUPPET offered, nothing goes`, async () => {
            const dmB = await heldInBThenUpdateInA();
            if (how === 'tombstones every held line') {
                for (const l of node.lines.filter((x) => x.conversationId === dmB.id)) {
                    Object.assign(l, { type: 'removed', ciphertext: b64('This message was deleted'), nonce: 'plaintext-v1', metadata: JSON.stringify({ removed: true, removedBy: l.authorPubkey }) });
                }
                sealed(puppet, ana, dmB, 'New phone, same Ben. What is the door code?');
            } else puppetRewrites(dmB);
            await syncMessages(ana.publicKey);
            expect(await isDmKeyChangePending(dmB.id)).toBe(true);
            expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
            expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
        });
    }

    it('MC4: B\'s first pass doesn\'t list the DM (pruned); the next lists [Ana, PUPPET] with the history withheld: Ben pinned, PUPPET offered, nothing goes', async () => {
        const dmB = await heldInBThenUpdateInA();
        node.convs = [];
        await syncMessages(ana.publicKey);
        node.convs = [dmB];
        node.lines = node.lines.filter((l) => l.conversationId !== dmB.id);
        sealed(puppet, ana, dmB, 'New phone, same Ben. What is the door code?');
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dmB.id)).toBe(true);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
    });

    it('MC5 the gate: B\'s first pass in a new run with the pin store unreadable, the node listing [Ana, PUPPET] and rewriting: nothing of it is written in B; the next run reads the store, seeds B from the phone\'s own rows, Ben pinned, PUPPET offered, nothing goes', async () => {
        const dmB = await heldInBThenUpdateInA();
        const before = rowsOf('B', dmB.id);
        expect(before.people).toEqual([ana.publicKey, ben.publicKey].sort());
        expect(before.lines).toHaveLength(6);
        puppetRewrites(dmB);
        restarted();   // a later run, whose pin store can't be read
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k === dmPeerPinsStoreKey(ana.publicKey, FILE_B)) throw new Error('storage unavailable'); return real(k); });
        try {
            await syncMessages(ana.publicKey);
            await syncSingleConversation(dmB.id);   // the open chat's poll too
        } finally { getItem.mockImplementation(real); }
        expect(rowsOf('B', dmB.id)).toEqual(before);   // [Ana, Ben] and Ben's 6 lines, as the phone held them
        expect(seeded()).toEqual([FILE_A]);
        restarted();   // the store reads
        await syncMessages(ana.publicKey);
        expect(seeded()).toEqual([FILE_A, FILE_B]);
        expect(await isDmKeyChangePending(dmB.id)).toBe(true);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
    });

    it('MC6 the record is in the pin write: the write of B\'s seed throws once: B unrecorded and nothing written in B that pass; the next pass seeds B again from the phone\'s own rows (MC2\'s verdict); one key holds the pins and the record', async () => {
        const dmB = await heldInBThenUpdateInA();
        const before = rowsOf('B', dmB.id);
        puppetRewrites(dmB);
        const setItem = vi.mocked(AsyncStorage.setItem);
        const real = setItem.getMockImplementation()!;
        let refuse = 1;
        setItem.mockImplementation(async (k: string, v: string) => {
            if (k === dmPeerPinsStoreKey(ana.publicKey, FILE_B) && refuse-- > 0) throw new Error('storage full');
            return real(k, v);
        });
        try { await syncMessages(ana.publicKey); } finally { setItem.mockImplementation(real); }
        expect(refuse).toBe(0);
        expect(seeded()).toEqual([FILE_A]);
        expect(pinOf(dmB.id)).toBeNull();
        expect(rowsOf('B', dmB.id)).toEqual(before);
        await syncMessages(ana.publicKey);   // the next pass, same run
        expect(await isDmKeyChangePending(dmB.id)).toBe(true);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(seeded()).toEqual([FILE_A, FILE_B]);
        // The pins' keys (the DM guard's own per-file lists, §3.4 amendment 7 §3, sit beside them and are not these).
        const mine = [...h.store.keys()].filter((k) => k.includes(ana.publicKey.toLowerCase()) && !k.startsWith('beanpool_dm_conversations_seen:')).sort();
        expect(mine).toEqual([dmPeerPinsStoreKey(ana.publicKey, FILE_A), dmPeerPinsStoreKey(ana.publicKey, FILE_B), dmLinesAtUpdateStoreKey(ana.publicKey, FILE_B), dmLinesAtUpdateStoreKey(ana.publicKey, FILE_A)].sort());
        expect(Object.keys(JSON.parse(h.store.get(dmPeerPinsStoreKey(ana.publicKey, FILE_B))!))).toEqual(['pins']);
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
    });

    it('MC7 one handle: the member switches to A between B\'s seed reading its rows and writing: the record and the held lines name B only; A\'s own seed runs at A\'s next read', async () => {
        sealed(ben, ana, dm, 'Ben in A');
        await phoneOf(ana);   // A holds Ana and Ben's DM
        await switchTo('B');
        const dmB: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs = [dmB];
        node.lines = [];
        for (let i = 0; i < 3; i++) sealed(ben, ana, dmB, `Ben ${i}`);
        await syncMessages(ana.publicKey);
        fileOf('B').prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dmB.id, puppet.publicKey);
        noPinStore(ana);
        restarted();   // the update; its first read is B's Inbox
        let switched = 0;
        mcDbs.onQuery = async (file: string, q: string) => {
            if (switched || file !== FILE_B || !q.includes('FROM conversation_participants cp JOIN conversations c')) return;
            switched++;
            await switchTo('A');
        };
        await getConversations(ana.publicKey);
        mcDbs.onQuery = null;
        expect(switched).toBe(1);
        expect(seeded()).toEqual([FILE_B]);
        expect(Object.keys(linesIn(FILE_B)!)).toEqual([dmB.id.toLowerCase()]);
        expect(linesIn(FILE_B)![dmB.id.toLowerCase()]).toHaveLength(3);
        expect(h.store.has(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_A))).toBe(false);
        expect(pinOf(dm.id, FILE_A)).toBeNull();
        expect(pinOf(dm.id, FILE_B)).toBeNull();
        await getConversations(ana.publicKey);   // A's next read: its own seed, on its own rows
        expect(seeded()).toEqual([FILE_A, FILE_B]);
        expect(pinOf(dm.id, FILE_A)).toMatchObject({ peer: ben.publicKey, checked: true });
        expect(linesIn(FILE_A)).toEqual({});
    });

    it('MC8 per-file lines and the cap: B holds 70 DMs its rows don\'t pin, 40 lines each (over 1 MB), A one honest DM (Ben re-keyed to K2 before the update); the update opens B: B\'s key absent and its 70 heldLost; A\'s key written, A\'s DM paused with K2 offered after a restart; Continue reads every line and the next goes to K2', async () => {
        const k2 = person('Ben on a new phone');
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        for (const l of node.lines) if (l.authorPubkey === ben.publicKey) l.authorPubkey = k2.publicKey;
        dm.participants = [ana.publicKey, k2.publicKey];
        dm.formerKeys = { [k2.publicKey]: [makeKeySuccession({ newEdPrivHex: k2.privateKey, oldPubHex: ben.publicKey, at: '2026-10-03T00:00:00.000Z' })] };
        for (let i = 0; i < 3; i++) sealed(k2, ana, dm, `K2 line ${i}`);
        await syncMessages(ana.publicKey);   // live in A, on the build before the update: rows [Ana, Ben, K2]
        fileOf('A').prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, k2.publicKey);   // that build's add-only sync
        await switchTo('B');
        const tpl = Array.from({ length: 40 }, (_, i) => phoneCrypto.sealDmLine(`Can you pick up the bread on your way home? I'll pay you back tomorrow, ${i}.`,
            { myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey, conversationId: dm.id } as any,
            { senderPubHex: ben.publicKey, messageId: randomUUID(), part: 'body', after: null, replyToId: null } as any));
        const others = [person('X').publicKey, person('Y').publicKey];
        const b = fileOf('B');
        node.convs = [];
        for (let d = 0; d < 70; d++) {
            const id = randomUUID();
            b.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', ?, '2026-10-01T00:00:00.000Z')").run(id, ana.publicKey);
            for (const pk of [ana.publicKey, ...others]) b.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, pk);
            for (const p of tpl) b.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, ?, ?, 'text', '2026-10-01T00:00:00.000Z')").run(randomUUID(), id, others[0], p.ciphertext, p.nonce);
            node.convs.push({ id, type: 'dm', participants: [ana.publicKey, ...others] });
        }
        noPinStore(ana);
        restarted();   // the update: its first run opens B
        await syncMessages(ana.publicKey);
        expect(h.store.has(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_B))).toBe(false);
        expect(Object.values(storedPins(ana, FILE_B)).filter((p: any) => p.heldLost === true)).toHaveLength(70);
        await switchTo('A');
        await getConversations(ana.publicKey);   // A's seed, at its first read
        expect(Object.keys(linesIn(FILE_A)!)).toEqual([dm.id.toLowerCase()]);
        expect(pinOf(dm.id, FILE_A)).toBeNull();
        restarted();   // judged in a later run, on A's stored lines
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(dm.id, FILE_A)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: k2.publicKey, firstSight: true, nodeSays: { rekeyedAt: '2026-10-03T00:00:00.000Z' } } });
        expect(await sendTo(dm.id, 'See you Saturday', [k2, ben])).toEqual(paused);
        editStoredPins(ana, (pins) => { pins[dm.id.toLowerCase()] = { peer: k2.publicKey, since: '2026-10-14T00:00:00.000Z', by: 'member', former: [ben.publicKey] }; });
        restarted();
        expect((await getMessages(dm.id)).map((m: any) => m.text)).toEqual(['Shall I cancel the order?', 'No', 'K2 line 0', 'K2 line 1', 'K2 line 2']);
        expect(await sendTo(dm.id, 'See you Saturday', [k2, ben])).toEqual({ err: null, posts: 1, readBy: ['Ben on a new phone'] });
    }, 120_000);

    it('MC8 the cap\'s edge: one file\'s held lines at 1 MB − 1 byte are written; at 1 MB + 1 they aren\'t, and the DM is marked heldLost', async () => {
        const CAP = 1024 * 1024;
        await phoneOf(ana);
        const big = randomUUID();
        const others = [person('X').publicKey, person('Y').publicKey];
        const line = phoneCrypto.sealDmLine('Ben 0', { myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey, conversationId: big } as any,
            { senderPubHex: ben.publicKey, messageId: randomUUID(), part: 'body', after: null, replyToId: null } as any);
        sql.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', ?, '2026-10-01T00:00:00.000Z')").run(big, ana.publicKey);
        for (const pk of [ana.publicKey, ...others]) sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(big, pk);
        sql.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, 'text', ?, '2026-10-01T00:00:00.000Z')")
            .run(randomUUID(), big, others[0], line.ciphertext, line.nonce, 'x');
        const seedWith = async (pad: number) => {
            sql.prepare('UPDATE messages SET metadata = ? WHERE conversation_id = ?').run('x'.repeat(pad), big);
            noPinStore(ana);
            restarted();
            await getConversations(ana.publicKey);
            return h.store.get(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_A));
        };
        const base = (await seedWith(1))!.length;   // every byte ASCII: its length is its size
        const under = await seedWith(1 + CAP - 1 - base);
        expect(under?.length).toBe(CAP - 1);
        expect(pinOf(big, FILE_A)).toBeNull();
        expect(await seedWith(1 + CAP + 1 - base)).toBeUndefined();
        expect(pinOf(big, FILE_A)).toMatchObject({ unplaced: true, heldLost: true });
    });

    it('MC9 sign out, sign in, switch to B: B\'s record and held lines survive; a DM still unpinned there is judged on them, not on the file fetched again', async () => {
        const dmB = await heldInBThenUpdateInA({ puppetRow: true });
        dmB.participants = [ana.publicKey, ben.publicKey, puppet.publicKey];   // still several keys: not judged in this run
        await syncMessages(ana.publicKey);
        expect(seeded()).toEqual([FILE_A, FILE_B]);
        expect(linesIn(FILE_B)![dmB.id.toLowerCase()]).toHaveLength(6);
        expect(pinOf(dmB.id)).toBeNull();
        // Signed out and in again: every community's database wiped, the pins and the held lines kept (wipe-identity-storage).
        for (const which of ['A', 'B'] as const) for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) fileOf(which).exec(`DELETE FROM ${t}`);
        restarted();
        await switchTo('A');
        await syncMessages(ana.publicKey);
        await switchTo('B');
        puppetRewrites(dmB);
        dmB.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(seeded()).toEqual([FILE_A, FILE_B]);
        expect(await isDmKeyChangePending(dmB.id)).toBe(true);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
    });

    it('the gate for a new chat: with the pin store unreadable, starting a DM asks the node nothing and writes nothing; the member is told the store\'s sentence', async () => {
        await phoneOf(ana);
        restarted();   // a later run, whose pin store can't be read
        const cat = person('Cat');
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k === dmPeerPinsStoreKey(ana.publicKey, FILE_A)) throw new Error('storage unavailable'); return real(k); });
        const calls = fetchMock.mock.calls.length;
        let err: any = null;
        try { await createConversationApi('dm', [ana.publicKey, cat.publicKey], ana.publicKey); } catch (e) { err = e; } finally { getItem.mockImplementation(real); }
        expect(err?.message).toBe(DM_PIN_STORE_UNREAD_TEXT);
        expect(fetchMock.mock.calls.length).toBe(calls);
        expect((sql.prepare('SELECT COUNT(*) AS n FROM conversation_participants WHERE public_key = ?').get(cat.publicKey) as any).n).toBe(0);
    });

    it('C1 (amendment 5 §6 reading c): a held DM pinned unchecked from the listing while the held lines were unreadable keeps them through a later pin write for another DM; its send is judged on them: paused on Ben, PUPPET reads nothing', async () => {
        const LINES = () => dmLinesAtUpdateStoreKey(ana.publicKey, FILE_A);
        const stored = () => JSON.parse(h.store.get(LINES()) ?? 'null') as Record<string, any[]> | null;
        for (let i = 0; i < 4; i++) sealed(ben, ana, dm, `Ben ${i}`);
        await phoneOf(ana);
        noPinStore(ana);
        restarted();
        sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, puppet.publicKey);
        dm.participants = [ana.publicKey, ben.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);                 // the update's run: several keys, not judged; lines kept
        expect(stored()![dm.id.toLowerCase()]).toHaveLength(4);
        restarted();                                       // a later run
        puppetRewrites(dm);
        dm.participants = [ana.publicKey, puppet.publicKey];
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        let throws = 0;
        getItem.mockImplementation(async (k: string) => { if (k === LINES()) { throws++; throw new Error('Row too big to fit into CursorWindow'); } return real(k); });
        try {
            await syncMessages(ana.publicKey);             // the held lines unreadable: the listing pins PUPPET unchecked
        } finally { getItem.mockImplementation(real); }
        expect(throws).toBeGreaterThan(0);
        expect(pinOf(dm.id, FILE_A)).toMatchObject({ peer: puppet.publicKey, by: 'first-seen' });
        expect(pinOf(dm.id, FILE_A).checked).toBeFalsy();
        expect(stored()![dm.id.toLowerCase()]).toHaveLength(4);
        restarted();                                       // the next run, readable again
        const cat = person('Cat');
        const withCat: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, cat.publicKey] };
        node.convs = [dm, withCat];
        await syncMessages(ana.publicKey);                 // a pin write (Cat's first sight): the removal runs after it
        expect(pinOf(withCat.id, FILE_A)).toMatchObject({ peer: cat.publicKey });
        expect(stored()![dm.id.toLowerCase()]).toHaveLength(4);   // an unchecked first-seen pin keeps its held lines
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual(paused);
        expect(pinOf(dm.id, FILE_A)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
    });
});

// ── §3.4 amendment 6: a node can't make the phone keep unbounded pins (#1872/#1873 confirmation 4, findings 1-5) ─────────
// One pins value per (account, community file), its presence the seed's record; every way a node grows it capped (the id,
// the value, the seed, the re-key date, tryKeys, former); at a cap a new entry is refused, never one dropped. Amendment 5's
// gate on every branch (G1-G8: confirmation 4's port-c4.part, its store helpers reading B's own value), with the narrow fix
// for an open group's poll and a group's page (G7, G8). The member's reset of one community's chat memory (Z6), and Sign
// Out's seed of each file before it goes (Z7). PUPPET's own key is the oracle wherever a line is sent.
import { randomBytes } from 'node:crypto';
import * as dbPort from '../db';
import { DM_PINS_UNREAD_LINE, DM_PINS_FULL_TEXT, DM_PINS_MAX_BYTES } from '../dm-peer-pins';
import { dmPeerPinsSetAsideStoreKey } from '../storage-keys';

describe('a node can\'t make the phone keep unbounded pins, and the gate holds on every branch (§3.4 amendment 6)', () => {
    const B_URL = 'https://castlemaine.beanpool.org';
    const FILE_B = 'community_castlemaine.db';
    const mcDbs = (globalThis as any).__phoneDbs;
    let puppet: Person;
    let deleted: string[] = [];
    let other: { lines: Line[]; convs: Conv[] };
    let active: 'A' | 'B' = 'A';
    /** Answers the node gives to /api/messages/<id> for an id it doesn't list (the push refresh's question). */
    let pageFor: Map<string, unknown>;
    beforeEach(() => {
        puppet = person('Puppet');
        deleted = [];
        active = 'A';
        other = { lines: [], convs: [] };
        pageFor = new Map();
        const b = mcDbs.dbFor(FILE_B);
        for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) { try { b.exec(`DELETE FROM ${t}`); } catch { /* not made yet */ } }
        (globalThis as any).fetch = async (url: string, init?: any) => {
            const u = new URL(url);
            const asked = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
            if (asked && pageFor.has(decodeURIComponent(asked[1]))) return answer(200, pageFor.get(decodeURIComponent(asked[1])));
            const r: any = await fetchMock(url, init);
            if (!u.pathname.startsWith('/api/messages/conversations/') || !r.ok) return r;
            return answer(r.status, { ...(await r.json()), deletedAccounts: deleted });
        };
    });
    afterEach(async () => {
        mcDbs.onQuery = null;
        vi.mocked(AsyncStorage.getItem).mockImplementation(async (k: string) => h.store.get(k) ?? null);
        await switchTo('A');
    });
    /** The member switches community: the phone opens that community's file, and the stand-in node is that community's. */
    async function switchTo(which: 'A' | 'B') {
        if (which === active) return;
        const cur = { lines: node.lines, convs: node.convs };
        node.lines = other.lines;
        node.convs = other.convs;
        other = cur;
        active = which;
        h.store.set('beanpool_anchor_url', which === 'B' ? B_URL : ANCHOR);
        await getDb();
    }
    const fileOf = (which: 'A' | 'B') => mcDbs.dbFor(which === 'B' ? FILE_B : FILE_A);
    const PINS_A = () => dmPeerPinsStoreKey(ana.publicKey, FILE_A);
    const PINS_B = () => dmPeerPinsStoreKey(ana.publicKey, FILE_B);
    const bytesOf = (key: string) => Buffer.byteLength(h.store.get(key) ?? '');
    /** A DM's entry in one community file's pins (B's unless named). */
    const pinOf = (id: string, file = FILE_B) => storedPins(ana, file)[id.toLowerCase()] ?? null;
    const opensFor = (who: Person, l: Line) => {
        try {
            return phoneCrypto.openDmLine({ ciphertext: l.ciphertext, nonce: l.nonce }, { myEdPrivHex: who.privateKey, peerEdPubHex: ana.publicKey },
                { conversationId: l.conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }).text;
        } catch { return null; }
    };
    function sealed(from: Person, to: Person, conv: Conv, text: string, extra: Partial<Line> = {}): Line {
        const messageId = extra.id ?? randomUUID().toLowerCase();
        const p = phoneCrypto.sealDmLine(text, { myEdPrivHex: from.privateKey, peerEdPubHex: to.publicKey, conversationId: conv.id } as any,
            { senderPubHex: from.publicKey, messageId, part: 'body', after: null, replyToId: null } as any);
        return written(conv, from, p.ciphertext, p.nonce, { id: messageId, ...extra });
    }
    /** A line `from` seals to Ana, held in a community file as a build without pins stored it (never on the node). */
    function heldLine(file: 'A' | 'B', conversationId: string, from: Person, text: string) {
        const messageId = randomUUID();
        const p = phoneCrypto.sealDmLine(text, { myEdPrivHex: from.privateKey, peerEdPubHex: ana.publicKey, conversationId } as any,
            { senderPubHex: from.publicKey, messageId, part: 'body', after: null, replyToId: null } as any);
        fileOf(file).prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, ?, ?, 'text', ?)")
            .run(messageId, conversationId, from.publicKey, p.ciphertext, p.nonce, tick());
    }
    /** A DM held in a community file by a build without pins: its row and its participant rows. */
    function heldDm(file: 'A' | 'B', id: string, others: string[]) {
        fileOf(file).prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', ?, '2026-10-01T00:00:00.000Z')").run(id, ana.publicKey);
        for (const pk of [ana.publicKey, ...others]) fileOf(file).prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, pk);
    }
    async function sendTo(id: string, text: string, readers: Person[] = [ben, puppet]) {
        const before = node.lines.length;
        let err: any = null;
        try { await insertMessage(id, ana.publicKey, text); } catch (e) { err = e; }
        if (!err) await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        const sent = node.lines.slice(before);
        return { err: err?.name ?? null, posts: sent.length, readBy: readers.filter((p) => sent.some((l) => opensFor(p, l) !== null)).map((p) => p.name) };
    }
    const paused = { err: 'DmKeyChangedError', posts: 0, readBy: [] };
    /** The node rewrites every line it holds of `conv` with PUPPET's copy, under the same id, marked edited. */
    const puppetRewrites = (conv: Conv) => {
        for (const l of node.lines.filter((x) => x.conversationId === conv.id)) {
            const copy = sealed(puppet, ana, conv, `PUPPET over ${l.id.slice(0, 4)}`, { id: l.id });
            node.lines.splice(node.lines.indexOf(copy), 1);
            Object.assign(l, { ciphertext: copy.ciphertext, nonce: copy.nonce, editedAt: new Date().toISOString() });
        }
    };
    const rowsOf = (which: 'A' | 'B', id: string) => ({
        people: (fileOf(which).prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ?').all(id) as any[]).map((r) => r.public_key).sort(),
        lines: (fileOf(which).prepare('SELECT id, type, ciphertext FROM messages WHERE conversation_id = ? ORDER BY rowid').all(id) as any[]).map((r) => `${r.id}:${r.type}:${r.ciphertext}`),
    });
    /** Every pins value of Ana's can't be read while `fn` runs (MC5's way), whichever community file. */
    async function unreadablePins<T>(fn: () => Promise<T>): Promise<T> {
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k.startsWith(dmPeerPinsStoreKey(ana.publicKey, ''))) throw new Error('storage unavailable'); return real(k); });
        try { return await fn(); } finally { getItem.mockImplementation(real); }
    }
    /** As MC's heldInBThenUpdateInA; `puppetRow`: B's rows name PUPPET too (an old build's add-only sync: P17f). */
    async function heldInBThenUpdateInA(opts: { puppetRow?: boolean; benLines?: number } = {}): Promise<Conv> {
        node.convs = [];
        node.lines = [];
        await phoneOf(ana);
        await switchTo('B');
        const dmB: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs = [dmB];
        node.lines = [];
        for (let i = 0; i < (opts.benLines ?? 6); i++) sealed(ben, ana, dmB, `Ben ${i}`);
        await syncMessages(ana.publicKey);
        if (opts.puppetRow) fileOf('B').prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dmB.id, puppet.publicKey);
        noPinStore(ana);
        restarted();
        await switchTo('A');
        await syncMessages(ana.publicKey);
        await switchTo('B');
        dmB.participants = [ana.publicKey, puppet.publicKey];
        return dmB;
    }
    /** The store reads again (a later run); B's node lists [Ana, PUPPET] with one PUPPET line: paused on Ben, nothing goes. */
    async function thenPausedOnBen(dmB: Conv) {
        restarted();
        sealed(puppet, ana, dmB, 'New phone, same Ben. What is the door code?');
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dmB.id)).toBe(true);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
    }
    const tombstoneOf = (who: Person) => ({ type: 'removed', metadata: JSON.stringify({ removed: true, accountDeleted: true, removedBy: who.publicKey, removedAt: new Date().toISOString() }) });
    /** A key the node lists, as pins keep keys (no member behind it). */
    const someKey = () => randomBytes(32).toString('hex');
    /**
     * Ids whose first-sight pins add exactly `bytes` to a value that already holds an entry: each adds its id's length
     * plus 132 (`"id":` and `{"peer":…,"since":…,"by":"first-seen"}`, 128, and its comma), ids 1-64 characters long.
     */
    function idsAdding(bytes: number, prefix: string): string[] {
        const count = Math.ceil(bytes / (64 + 132));
        const sum = bytes - 132 * count;
        expect(sum).toBeGreaterThanOrEqual(8 * count);
        const base = Math.floor(sum / count);
        return Array.from({ length: count }, (_, i) => {
            const len = base + (i < sum % count ? 1 : 0);
            const head = `${prefix}${i.toString(36)}-`;
            return head + 'a'.repeat(len - head.length);
        });
    }

    it('G1 the gate\'s prune: B\'s first pass, with the pin store unreadable, doesn\'t list the DM; nothing of B\'s DM is deleted, and the next run pauses on Ben', async () => {
        const dmB = await heldInBThenUpdateInA({ puppetRow: true });
        const before = rowsOf('B', dmB.id);
        node.convs = [];
        restarted();
        await unreadablePins(() => syncMessages(ana.publicKey));
        expect(rowsOf('B', dmB.id)).toEqual(before);
        node.convs = [dmB];
        node.lines = node.lines.filter((l) => l.conversationId !== dmB.id);
        await thenPausedOnBen(dmB);
    });

    it('G2 the gate\'s blanking of the listing\'s deletedAccounts: B\'s first pass, with the pin store unreadable, names Ben deleted; none of his lines is blanked, and the next run pauses on Ben', async () => {
        const dmB = await heldInBThenUpdateInA({ puppetRow: true });
        const before = rowsOf('B', dmB.id);
        deleted = [ben.publicKey];
        restarted();
        await unreadablePins(() => syncMessages(ana.publicKey));
        expect(rowsOf('B', dmB.id)).toEqual(before);
        await thenPausedOnBen(dmB);
    });

    it('G3 the gate\'s blanking of a tombstone seen on a group\'s page: B\'s first pass, with the pin store unreadable, serves Ben\'s account-deleted tombstone in a group; none of his DM lines is blanked, and the next run pauses on Ben', async () => {
        const dmB = await heldInBThenUpdateInA({ puppetRow: true });
        const before = rowsOf('B', dmB.id);
        const group: Conv = { id: randomUUID(), type: 'group_thread', participants: [ana.publicKey, ben.publicKey, puppet.publicKey] };
        node.convs.push(group);
        written(group, ben, b64('This message was deleted'), 'plaintext-v1', tombstoneOf(ben));
        restarted();
        await unreadablePins(() => syncMessages(ana.publicKey));
        expect(rowsOf('B', dmB.id)).toEqual(before);
        await thenPausedOnBen(dmB);
    });

    for (const [n, what, query] of [['G4', 'rows', 'FROM conversation_participants cp JOIN conversations c'], ['G5', 'window', 'ORDER BY rowid ASC LIMIT 20']] as const) {
        it(`${n} one handle: the seed's ${what} read fails once (a community switch closed the handle it holds) while B's node rewrites the held lines: the seed records nothing, nothing of the node's is written, and the next pass seeds B from the phone's own rows`, async () => {
            const dmB = await heldInBThenUpdateInA({ puppetRow: true });
            const before = rowsOf('B', dmB.id);
            puppetRewrites(dmB);
            let fails = 1;
            mcDbs.onQuery = async (file: string, q: string) => {
                if (fails > 0 && file === FILE_B && q.includes(query)) { fails--; throw new Error('Access to closed resource'); }
            };
            await syncMessages(ana.publicKey);
            mcDbs.onQuery = null;
            expect(fails).toBe(0);
            expect(h.store.has(PINS_B())).toBe(false);   // B's seed unrecorded (its value's presence is the record)
            expect(h.store.has(PINS_A())).toBe(true);
            expect(rowsOf('B', dmB.id)).toEqual(before);
            await syncMessages(ana.publicKey);
            expect(await isDmKeyChangePending(dmB.id)).toBe(true);
            expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
            expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
        });
    }

    it('G6 the gate in the push refresh: with the pin store unreadable, a push tap for an id the phone doesn\'t hold, which B\'s node answers with the held DM\'s id and [Ana, PUPPET]; nothing is written, and the next run pauses on Ben (a DM with no line yet)', async () => {
        const dmB = await heldInBThenUpdateInA({ benLines: 0 });
        const before = rowsOf('B', dmB.id);
        const asked = randomUUID();
        pageFor.set(asked, { conversation: { id: dmB.id, type: 'dm', participants: [ana.publicKey, puppet.publicKey] }, messages: [] });
        restarted();
        await unreadablePins(() => (dbPort as any).getConversationKind(asked, { askNode: true }));
        expect(rowsOf('B', dmB.id)).toEqual(before);
        await thenPausedOnBen(dmB);
    });

    it('G7 the gate in the open GROUP chat\'s poll (the narrow fix): with the pin store unreadable, the group\'s page carries Ben\'s account-deleted tombstone; none of his DM lines is blanked, the group\'s own line arrives, and the next run pauses on Ben', async () => {
        const dmB = await heldInBThenUpdateInA({ puppetRow: true });
        const before = rowsOf('B', dmB.id);
        const group: Conv = { id: randomUUID(), type: 'group_thread', participants: [ana.publicKey, ben.publicKey, puppet.publicKey] };
        fileOf('B').prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'group_thread', ?, '2026-10-01T00:00:00.000Z')").run(group.id, ben.publicKey);
        node.convs.push(group);
        const tomb = written(group, ben, b64('This message was deleted'), 'plaintext-v1', tombstoneOf(ben));
        restarted();
        await unreadablePins(() => syncSingleConversation(group.id));
        expect(rowsOf('B', dmB.id)).toEqual(before);
        expect(rowsOf('B', group.id).lines.map((l) => l.split(':')[0])).toEqual([tomb.id]);   // groups keep syncing
        await thenPausedOnBen(dmB);
    });

    it('G8 the gate for a GROUP\'s page (the narrow fix): with the pin store unreadable at B\'s first pass, a group\'s page reuses the ids of Ben\'s held DM lines; none of them moves or changes, the group\'s other line arrives, and the next run pauses on Ben', async () => {
        const dmB = await heldInBThenUpdateInA({ puppetRow: true });
        const before = rowsOf('B', dmB.id);
        const group: Conv = { id: randomUUID(), type: 'group_thread', participants: [ana.publicKey, ben.publicKey, puppet.publicKey] };
        node.convs.push(group);
        for (const l of node.lines.filter((x) => x.conversationId === dmB.id)) written(group, puppet, b64(`group line over ${l.id.slice(0, 4)}`), 'plaintext-v1', { id: l.id });
        const own = written(group, ben, b64('See you all on Saturday'), 'plaintext-v1');
        node.lines = node.lines.filter((l) => l.conversationId !== dmB.id);
        restarted();
        await unreadablePins(() => syncMessages(ana.publicKey));
        expect(rowsOf('B', dmB.id)).toEqual(before);
        expect(rowsOf('B', group.id).lines.map((l) => l.split(':')[0])).toEqual([own.id]);
        await thenPausedOnBen(dmB);
    });

    it('G8 the gate in the open GROUP chat\'s poll (the narrow fix): with the pin store unreadable, the group\'s page reuses the ids of Ben\'s held DM lines; none of them moves or changes, the group\'s other line arrives, and the next run pauses on Ben', async () => {
        const dmB = await heldInBThenUpdateInA({ puppetRow: true });
        const before = rowsOf('B', dmB.id);
        const group: Conv = { id: randomUUID(), type: 'group_thread', participants: [ana.publicKey, ben.publicKey, puppet.publicKey] };
        fileOf('B').prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'group_thread', ?, '2026-10-01T00:00:00.000Z')").run(group.id, ben.publicKey);
        node.convs.push(group);
        for (const l of node.lines.filter((x) => x.conversationId === dmB.id)) written(group, puppet, b64(`group line over ${l.id.slice(0, 4)}`), 'plaintext-v1', { id: l.id });
        const own = written(group, ben, b64('See you all on Saturday'), 'plaintext-v1');
        node.lines = node.lines.filter((l) => l.conversationId !== dmB.id);
        restarted();
        await unreadablePins(() => syncSingleConversation(group.id));
        expect(rowsOf('B', dmB.id)).toEqual(before);
        expect(rowsOf('B', group.id).lines.map((l) => l.split(':')[0])).toEqual([own.id]);
        await thenPausedOnBen(dmB);
    });

    it('Z1 one community\'s node can\'t make another\'s DMs stop: B lists 7,000 DMs in one pass; B\'s value stays under 1 MiB and A\'s is untouched; in the next run (Android reads a value through a 2 MiB window) A\'s DM with Ben syncs, reads and sends, and again after signing out and in', async () => {
        sealed(ana, ben, dm, 'Shall I cancel the order?');
        sealed(ben, ana, dm, 'No');
        await phoneOf(ana);
        const aValue = h.store.get(PINS_A());
        expect(aValue).toBeDefined();
        await switchTo('B');
        node.convs = [];
        node.lines = [];
        for (let i = 0; i < 7000; i++) node.convs.push({ id: randomUUID(), type: 'dm', participants: [ana.publicKey, someKey()] });
        await syncMessages(ana.publicKey);
        expect(bytesOf(PINS_B())).toBeLessThan(1024 * 1024);
        const kept = Object.keys(storedPins(ana, FILE_B)).length;
        expect(kept).toBeGreaterThan(6000);   // new entries stop at the cap: refused, none dropped
        expect(kept).toBeLessThan(7000);
        expect(h.store.get(PINS_A())).toBe(aValue);
        const windowed = () => {
            const getItem = vi.mocked(AsyncStorage.getItem);
            getItem.mockImplementation(async (k: string) => {
                const v = h.store.get(k) ?? null;
                if (v != null && Buffer.byteLength(k) + Buffer.byteLength(v) > 2 * 1024 * 1024) throw new Error('Row too big to fit into CursorWindow');
                return v;
            });
        };
        restarted();
        windowed();
        await switchTo('A');
        sealed(ben, ana, dm, 'Ben, after');
        await syncMessages(ana.publicKey);
        expect((await getMessages(dm.id)).map((m: any) => m.text)).toEqual(['Shall I cancel the order?', 'No', 'Ben, after']);
        expect(await sendTo(dm.id, 'Got it', [ben])).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
        // Signed out and in again: every community's database wiped, the pins kept (wipe-identity-storage).
        for (const which of ['A', 'B'] as const) for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) fileOf(which).exec(`DELETE FROM ${t}`);
        restarted();
        await syncMessages(ana.publicKey);
        expect((await getMessages(dm.id)).map((m: any) => m.text)).toEqual(['Shall I cancel the order?', 'No', 'Ben, after', 'Got it']);
        expect(await sendTo(dm.id, 'See you then', [ben])).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
    }, 120_000);

    it('Z2 the id cap: B held 22 DMs under 100,000-character ids (two other keys each, a line each), one under a 65-character id and one under a 64-character id; they get no pin, no held lines and no mark, but the 64 is pinned; B\'s value stays under 1 KB; a send in a long-id DM is refused, nothing posted', async () => {
        await phoneOf(ana);
        await switchTo('B');
        node.convs = [];
        node.lines = [];
        const x = person('X');
        const y = person('Y');
        const longIds = Array.from({ length: 22 }, (_, i) => `${i}-${'d'.repeat(100_000)}`);
        const id65 = `e${'5'.repeat(64)}`;
        const id64 = `f${'4'.repeat(63)}`;
        for (const id of longIds) { heldDm('B', id, [x.publicKey, y.publicKey]); heldLine('B', id, x, 'Long id, held'); }
        heldDm('B', id65, [x.publicKey]);
        heldDm('B', id64, [x.publicKey]);
        noPinStore(ana);
        restarted();
        node.convs = [...longIds, id65, id64].map((id) => ({ id, type: 'dm', participants: [ana.publicKey, x.publicKey] }));
        await syncMessages(ana.publicKey);
        expect(Object.keys(storedPins(ana, FILE_B))).toEqual([id64]);
        expect(pinOf(id64)).toMatchObject({ peer: x.publicKey, checked: true });
        expect(bytesOf(PINS_B())).toBeLessThan(1024);
        expect(JSON.parse(h.store.get(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_B))!)).toEqual({});
        expect(await sendTo(longIds[0], 'Long id', [x])).toEqual({ err: 'DmNotLockedError', posts: 0, readBy: [] });
        expect(await sendTo(id65, '65', [x])).toEqual({ err: 'DmNotLockedError', posts: 0, readBy: [] });
        expect(await sendTo(id64, '64', [x])).toEqual({ err: null, posts: 1, readBy: ['X'] });
    }, 120_000);

    it('Z3 the value cap\'s edge: B listed to exactly 1 MiB − 1 is written; one more DM listed is not (pinless), and its send is refused as full, nothing posted', async () => {
        await phoneOf(ana);
        await switchTo('B');
        const dmB: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs = [dmB];
        node.lines = [];
        await syncMessages(ana.publicKey);
        const start = bytesOf(PINS_B());
        for (const id of idsAdding(DM_PINS_MAX_BYTES - 1 - start, 'z')) node.convs.push({ id, type: 'dm', participants: [ana.publicKey, someKey()] });
        await syncMessages(ana.publicKey);
        expect(bytesOf(PINS_B())).toBe(DM_PINS_MAX_BYTES - 1);
        const cat = person('Cat');
        const extra: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, cat.publicKey] };
        node.convs.push(extra);
        await syncMessages(ana.publicKey);
        expect(bytesOf(PINS_B())).toBe(DM_PINS_MAX_BYTES - 1);
        expect(pinOf(extra.id)).toBeNull();
        const r = await sendTo(extra.id, 'Hello Cat', [cat]);
        expect(r).toEqual({ err: 'DmPinsFullError', posts: 0, readBy: [] });
        let err: any = null;
        try { await insertMessage(extra.id, ana.publicKey, 'Hello again'); } catch (e) { err = e; }
        expect(refusedSendNotice(err, 'Cat')).toBe(DM_PINS_FULL_TEXT);
        expect(bytesOf(PINS_B())).toBe(DM_PINS_MAX_BYTES - 1);
    }, 120_000);

    it('Z3 a full file: with room for an offer and not a pin, one pass lists one more DM (pinless, refused as full) and offers on Ben\'s pinned DM (the offer lands); a pass whose replacements alone push over is refused whole: the copy read again, Ben\'s pin unmoved, nothing sealed to the key it offered', async () => {
        await phoneOf(ana);
        await switchTo('B');
        const dmB: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        node.convs = [dmB];
        node.lines = [];
        await syncMessages(ana.publicKey);
        const fillers = idsAdding(DM_PINS_MAX_BYTES - 150 - bytesOf(PINS_B()), 'y');
        const listed = new Map(fillers.map((id) => [id, someKey()]));
        for (const [id, k] of listed) node.convs.push({ id, type: 'dm', participants: [ana.publicKey, k] });
        await syncMessages(ana.publicKey);
        expect(bytesOf(PINS_B())).toBe(DM_PINS_MAX_BYTES - 150);
        const cat = person('Cat');
        const extra: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, cat.publicKey] };
        node.convs.push(extra);
        dmB.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(pinOf(extra.id)).toBeNull();
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        expect(bytesOf(PINS_B())).toBe(DM_PINS_MAX_BYTES - 150 + 118);   // the offer: `,"offered":{"peer":…,"at":…}`
        expect(await sendTo(extra.id, 'Hello Cat', [cat])).toEqual({ err: 'DmPinsFullError', posts: 0, readBy: [] });
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
        // Replacements alone push it over: an offer on a filler's pin (118 more, past the cap). Refused whole.
        const value = h.store.get(PINS_B());
        const q = person('Q');
        const f = node.convs.find((c) => c.id === fillers[0])!;
        f.participants = [ana.publicKey, q.publicKey];
        await syncMessages(ana.publicKey);
        expect(h.store.get(PINS_B())).toBe(value);
        expect(await isDmKeyChangePending(f.id)).toBe(false);   // the copy read again: the refused offer isn't there
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
        const toFiller = await sendTo(f.id, 'Who is this?', [q]);
        expect(toFiller.readBy).toEqual([]);   // never sealed to the key the refused write offered
    }, 120_000);

    it('Z4 the re-key date and the node\'s keys: a verified succession whose date is 100 KB long and parses is kept as 24 characters, in an offer and in what a first sight heard; of 20 former keys served, 8 are kept to try; a pin read with 6 former keys keeps the newest 4', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const k2 = person('Ben on a new phone');
        const at = `Thu Oct 01 2026 00:00:00 GMT+0000 (${'x'.repeat(100_000)})`;
        const chainFor = (newKey: Person, oldKey: string) => [
            makeKeySuccession({ newEdPrivHex: newKey.privateKey, oldPubHex: oldKey, at }),
            ...Array.from({ length: 19 }, () => ({ pubkey: someKey(), at: '2026-09-01T00:00:00.000Z', sig: 'AA' })),
        ];
        dm.participants = [ana.publicKey, k2.publicKey];
        dm.formerKeys = { [k2.publicKey]: chainFor(k2, ben.publicKey) };
        const cat = person('Cat');
        const k3 = person('Cat on a new phone');
        const withCat: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, k3.publicKey], formerKeys: { [k3.publicKey]: chainFor(k3, cat.publicKey) } };
        node.convs.push(withCat);
        await syncMessages(ana.publicKey);
        expect(pinOf(dm.id, FILE_A).offered).toEqual({ peer: k2.publicKey, at: expect.any(String), nodeSays: { rekeyedAt: '2026-10-01T00:00:00.000Z' } });
        expect(pinOf(withCat.id, FILE_A).heard.rekeyedAt).toBe('2026-10-01T00:00:00.000Z');
        expect(pinOf(withCat.id, FILE_A).heard.tryKeys).toHaveLength(8);
        expect(h.store.get(PINS_A())).not.toContain('xxxx');
        expect(bytesOf(PINS_A())).toBeLessThan(4096);
        const formers = Array.from({ length: 6 }, () => someKey());
        editStoredPins(ana, (pins) => { pins[dm.id.toLowerCase()] = { peer: k2.publicKey, since: '2026-10-14T00:00:00.000Z', by: 'member', former: formers }; });
        restarted();
        node.convs.push({ id: randomUUID(), type: 'dm', participants: [ana.publicKey, person('Dan').publicKey] });
        await syncMessages(ana.publicKey);   // a write: the value as the phone holds it
        expect(pinOf(dm.id, FILE_A).former).toEqual(formers.slice(0, 4));
    });

    it('Z5 the seed takes the 2,000 DMs held longest: B held 2,200 at the update, Ana and Ben\'s among the oldest 2,000, Ana and Eve\'s among the newest 200; B\'s node rewrites both [Ana, PUPPET]: Ana and Ben\'s pauses on Ben; Ana and Eve\'s is judged at its send on what the node wrote (the stated residual, as P16)', async () => {
        await phoneOf(ana);
        await switchTo('B');
        node.convs = [];
        node.lines = [];
        const eve = person('Eve');
        const dmOld: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        const dmNew: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, eve.publicKey] };
        const filler: string[] = [];
        for (let i = 0; i < 2200; i++) {
            if (i === 100) { heldDm('B', dmOld.id, [ben.publicKey]); continue; }
            if (i === 2150) { heldDm('B', dmNew.id, [eve.publicKey]); continue; }
            const id = randomUUID();
            filler.push(id);
            heldDm('B', id, [someKey()]);
        }
        for (const [conv, who] of [[dmOld, ben], [dmNew, eve]] as const) {
            for (let i = 0; i < 3; i++) {
                const l = sealed(who, ana, conv, `${who.name} ${i}`);
                fileOf('B').prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, ?, ?, 'text', ?)")
                    .run(l.id, conv.id, who.publicKey, l.ciphertext, l.nonce, l.timestamp);
            }
        }
        noPinStore(ana);
        restarted();
        for (const conv of [dmOld, dmNew]) {
            puppetRewrites(conv);
            conv.participants = [ana.publicKey, puppet.publicKey];
        }
        node.convs = [dmOld, dmNew];
        await syncMessages(ana.publicKey);
        // The seed pinned the 2,000 held longest from the phone's rows, checked; the pass after it pinned the rest from the
        // rows unchecked (a new entry on the rows' word, kept to the cap), so their first send or check judges them.
        const pins = storedPins(ana, FILE_B);
        expect(Object.keys(pins)).toHaveLength(2200);
        expect(Object.values(pins).filter((p: any) => p.checked === true)).toHaveLength(2000);
        expect(pins[filler[0]]).toMatchObject({ checked: true });
        expect(pins[filler[filler.length - 1]].checked).toBeFalsy();
        expect(pinOf(dmNew.id).checked).toBeFalsy();
        expect(pinOf(dmOld.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dmOld.id, 'The code is 4821')).toEqual(paused);
        expect(await sendTo(dmNew.id, 'Hello Eve', [eve, puppet])).toEqual({ err: null, posts: 1, readBy: ['Puppet'] });
    }, 120_000);

    it('Z6 the member\'s reset: B\'s value corrupt refuses B\'s sends with the true sentence, every time, and the phone never resets it on its own; A sends; the reset sets the raw value aside and puts its marker in the value\'s place (§3.4 amendment 7 §2), keeps the held lines, and the next read seeds B from its own rows, judging each DM on its lines; a value storage can\'t return is removed and logged with nothing set aside, and the marker written; a transient throw needs no reset', async () => {
        sealed(ben, ana, dm, 'Ben in A');
        await phoneOf(ana);
        await switchTo('B');
        const dmB: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        const relisted: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        const eve = person('Eve');
        const firstMet: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [dmB, relisted, firstMet];
        node.lines = [];
        for (let i = 0; i < 3; i++) { sealed(ben, ana, dmB, `Ben ${i}`); sealed(ben, ana, relisted, `Ben to relist ${i}`); }
        sealed(puppet, ana, firstMet, 'Hi, it is Eve');
        await syncMessages(ana.publicKey);
        expect(await sendTo(dmB.id, 'Hello Ben')).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
        // Before the fault: the node prunes `relisted` and lists it again as [Ana, PUPPET] with PUPPET's lines only.
        node.convs = [dmB, firstMet];
        await syncMessages(ana.publicKey);
        node.lines = node.lines.filter((l) => l.conversationId !== relisted.id);
        sealed(puppet, ana, relisted, 'PUPPET after the relist');
        relisted.participants = [ana.publicKey, puppet.publicKey];
        node.convs = [dmB, relisted, firstMet];
        await syncMessages(ana.publicKey);
        expect(pinOf(relisted.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        expect(pinOf(firstMet.id)).toMatchObject({ peer: puppet.publicKey, by: 'first-seen' });
        expect(pinOf(firstMet.id).checked).toBeFalsy();
        const lines = h.store.get(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_B));
        expect(lines).toBeDefined();
        // The fault: B's value corrupt. Every send in B refuses with the true sentence; nothing resets it.
        const corrupt = '{"pins":{"' + dmB.id.toLowerCase() + '":{"peer":';
        h.store.set(PINS_B(), corrupt);
        restarted();
        for (let i = 0; i < 3; i++) {
            let err: any = null;
            try { await insertMessage(dmB.id, ana.publicKey, 'Are you there?'); } catch (e) { err = e; }
            expect(err?.name).toBe('DmPinStoreError');
            expect(refusedSendNotice(err, 'Ben')).toBe(DM_PIN_STORE_UNREAD_TEXT);
            await syncMessages(ana.publicKey);
        }
        expect(DM_PIN_STORE_UNREAD_TEXT).toBe("This phone couldn't read who this community's chats are with, so nothing was sent. Try again; if it keeps failing, Settings → Account → Chat memory can reset this community's, which re-checks every chat here from the start.");
        expect((await getMessages(dmB.id)).map((m: any) => m.text)).toEqual(Array(4).fill(DM_PINS_UNREAD_LINE));
        expect(DM_PINS_UNREAD_LINE).toBe("Can't be shown until this phone can read who this chat is with.");
        expect(h.store.get(PINS_B())).toBe(corrupt);
        expect(h.store.has(dmPeerPinsSetAsideStoreKey(ana.publicKey, FILE_B))).toBe(false);
        // A is its own value: it reads and sends.
        await switchTo('A');
        expect(await sendTo(dm.id, 'Hello from A', [ben])).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
        await switchTo('B');
        // The member's reset of B's chat memory.
        expect(await dbPort.resetDmChatMemory(B_URL)).toBe('set-aside');
        expect(h.store.get(dmPeerPinsSetAsideStoreKey(ana.publicKey, FILE_B))).toBe(corrupt);
        expect(Object.keys(JSON.parse(h.store.get(PINS_B())!))).toEqual(['reset']);
        expect(h.store.get(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_B))).toBe(lines);
        await syncMessages(ana.publicKey);
        expect(Object.keys(JSON.parse(h.store.get(PINS_B())!))).toEqual(['pins']);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true });
        expect(await sendTo(dmB.id, 'Back again')).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
        // The relisted DM's rows were written per its pin ([Ana, Ben]) and its only line is PUPPET's (the prune took Ben's):
        // judged with the rows' key listed, rule 3 pins the lines' key and offers the rows' (§3.4 amendment 7 §1), a pause.
        expect(pinOf(relisted.id)).toMatchObject({ peer: puppet.publicKey, checked: true, offered: { peer: ben.publicKey, firstSight: true, afterReset: true } });
        expect(await sendTo(relisted.id, 'The code is 4821')).toEqual(paused);
        // The stated residual: a DM first met on the node's word, unchecked before the fault, whose only line is PUPPET's:
        // judged on it, rule 2 pins PUPPET (the confirmation says so: "may open with the new key").
        expect(pinOf(firstMet.id)).toMatchObject({ peer: puppet.publicKey, checked: true });
        // A value storage can't return: removed and logged, nothing set aside.
        h.store.delete(dmPeerPinsSetAsideStoreKey(ana.publicKey, FILE_B));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const r = await unreadablePins(() => dbPort.resetDmChatMemory(B_URL));
            expect(r).toBe('unreadable-removed');
            expect(warn.mock.calls.some((c) => String(c[0]).includes('could not be read'))).toBe(true);
        } finally { warn.mockRestore(); }
        expect(Object.keys(JSON.parse(h.store.get(PINS_B())!))).toEqual(['reset']);
        expect(h.store.has(dmPeerPinsSetAsideStoreKey(ana.publicKey, FILE_B))).toBe(false);
        await syncMessages(ana.publicKey);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true });
        // One transient throw: that send refuses, the next goes; nothing set aside or removed.
        restarted();
        const value = h.store.get(PINS_B());
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        let once = 1;
        getItem.mockImplementation(async (k: string) => { if (k === PINS_B() && once-- > 0) throw new Error('storage busy'); return real(k); });
        try {
            expect(await sendTo(dmB.id, 'Once')).toEqual({ err: 'DmPinStoreError', posts: 0, readBy: [] });
            expect(await sendTo(dmB.id, 'Twice')).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
        } finally { getItem.mockImplementation(real); }
        expect(h.store.get(PINS_B())).toBe(value);
        expect(h.store.has(dmPeerPinsSetAsideStoreKey(ana.publicKey, FILE_B))).toBe(false);
    }, 120_000);

    it('Z7 Sign Out before the first visit to B after the update: Sign Out\'s seed of each file keeps B\'s memory, and signed in again, B\'s node rewriting [Ana, PUPPET] pauses on Ben; a seed that throws at Sign Out is logged and never stops it', async () => {
        const dmB = await heldInBThenUpdateInA();
        await switchTo('A');
        expect(h.store.has(PINS_B())).toBe(false);
        // Sign Out (account-leaves-phone.ts signOutOfThisPhone): the open file, then each file listed before it is deleted.
        await dbPort.seedDmPinsHere(ana.publicKey);
        await dbPort.seedDmPinsBeforeLeaving(ana.publicKey, [FILE_A, FILE_B]);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true });
        for (const which of ['A', 'B'] as const) for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) fileOf(which).exec(`DELETE FROM ${t}`);
        restarted();
        // Signed in again; the member visits B, whose node rewrites the DM [Ana, PUPPET] with PUPPET's lines.
        await syncMessages(ana.publicKey);
        await switchTo('B');
        puppetRewrites(dmB);
        sealed(puppet, ana, dmB, 'New phone, same Ben. What is the door code?');
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dmB.id)).toBe(true);
        expect(pinOf(dmB.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dmB.id, 'The code is 4821')).toEqual(paused);
    });

    it('Z7 a seed that throws at Sign Out is logged, writes nothing, and Sign Out goes on', async () => {
        await heldInBThenUpdateInA();
        await switchTo('A');
        mcDbs.onQuery = async (file: string, q: string) => {
            if (file === FILE_B && q.includes('FROM conversation_participants cp JOIN conversations c')) throw new Error('Access to closed resource');
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(dbPort.seedDmPinsBeforeLeaving(ana.publicKey, [FILE_A, FILE_B])).resolves.toBeUndefined();
            expect(warn.mock.calls.some((c) => String(c[0]).includes(FILE_B))).toBe(true);
        } finally { warn.mockRestore(); mcDbs.onQuery = null; }
        expect(h.store.has(PINS_B())).toBe(false);
    });

    // ── §3.4 amendment 7: the member's reset judges before it trusts (confirmation 5, finding 1; its tail-a6, tail-rc, tail-gd parts) ──
    const notLocked = { err: 'DmNotLockedError', posts: 0, readBy: [] };
    const resetB = () => dbPort.resetDmChatMemory(B_URL);
    /** The value B's pins key holds, as its own members' names (the marker is `reset` alone; held pins are `pins` alone). */
    const membersOfB = () => Object.keys(JSON.parse(h.store.get(PINS_B())!));
    /** R2's DM: first met in B as [Ana, PUPPET] whose thread holds Ben's 3 lines, never opened (an unchecked first-sight pin on PUPPET). */
    async function firstMetWithBensLines(lines = 3): Promise<Conv> {
        await phoneOf(ana);
        await switchTo('B');
        const e: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [e];
        node.lines = [];
        for (let i = 0; i < lines; i++) sealed(ben, ana, e, `Ben ${i}`);
        await syncMessages(ana.publicKey);
        expect(pinOf(e.id)).toMatchObject({ peer: puppet.publicKey, by: 'first-seen' });
        expect(pinOf(e.id).checked).toBeFalsy();
        return e;
    }
    /** R3's DM: a line it can't place (Q's, re-attributed to Ben) between two of Ben's, rows [Ana, PUPPET]; its first send refused for good (rule 5). */
    async function ruleFiveDm(): Promise<Conv> {
        const q = person('Q');
        await phoneOf(ana);
        await switchTo('B');
        const g: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [g];
        node.lines = [];
        sealed(ben, ana, g, 'Ben 0');
        const qLine = sealed(q, ana, g, 'Q, re-attributed to Ben');
        qLine.authorPubkey = ben.publicKey;
        sealed(ben, ana, g, 'Ben 1');
        await syncMessages(ana.publicKey);
        expect(await sendTo(g.id, 'first try')).toEqual(notLocked);
        expect(pinOf(g.id)).toMatchObject({ unplaced: true, listed: puppet.publicKey });
        await syncMessages(ana.publicKey);
        expect(rowsOf('B', g.id).people).toEqual([ana.publicKey, puppet.publicKey].sort());
        return g;
    }
    /** Rule 3 after a reset: the lines' key (Ben) pinned checked, the rows' key (PUPPET) offered, a first-sight pause the reset marks. */
    const pausedOnBenAfterReset = (id: string) => expect(pinOf(id)).toEqual({
        peer: ben.publicKey, since: expect.any(String), by: 'first-seen', checked: true,
        offered: { peer: puppet.publicKey, at: expect.any(String), firstSight: true, afterReset: true },
    });

    for (const resetFirst of [false, true]) {
        it(`R2 a DM first met in B as [Ana, PUPPET] whose thread holds Ben's 3 lines, never opened; ${resetFirst
            ? 'the member resets B\'s chat memory: the re-seed judges it on its lines, rule 3: Ben pinned checked, PUPPET offered as a first-sight pause marked as the reset\'s, nothing goes, PUPPET reads nothing'
            : 'control, no reset: the send judges it, rule 3: Ben pinned checked, PUPPET offered, nothing goes'}`, async () => {
            const e = await firstMetWithBensLines();
            if (resetFirst) {
                expect(await resetB()).toBe('set-aside');
                expect(membersOfB()).toEqual(['reset']);
                await syncMessages(ana.publicKey);
                expect(membersOfB()).toEqual(['pins']);
                pausedOnBenAfterReset(e.id);
            }
            expect(await isDmKeyChangePending(e.id)).toBe(true);
            expect(await sendTo(e.id, 'The code is 4821')).toEqual(paused);
            expect(pinOf(e.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
            expect(!!pinOf(e.id).offered.afterReset).toBe(resetFirst);
        });

        it(`R3 a rule-5 DM in B (a line it can't place), rows [Ana, PUPPET]; ${resetFirst
            ? 'the member resets B\'s chat memory: the re-seed judges it on its lines, rule 5: the record kept, listed = PUPPET, refused, PUPPET reads nothing'
            : 'control, no reset: refused for good'}`, async () => {
            const g = await ruleFiveDm();
            if (resetFirst) {
                expect(await resetB()).toBe('set-aside');
                await syncMessages(ana.publicKey);
                expect(pinOf(g.id)).toMatchObject({ unplaced: true, listed: puppet.publicKey });
                expect(pinOf(g.id).peer).toBeUndefined();
            }
            expect(await sendTo(g.id, 'The code is 4821')).toEqual(notLocked);
            expect(pinOf(g.id)).toMatchObject({ unplaced: true, listed: puppet.publicKey });
        });
    }

    for (const kind of ['R2c', 'R3c'] as const) {
        it(`${kind} the way a member reaches the reset: B's value goes corrupt after the DM was met, the send refuses with the sentence that names Chat memory, and the member resets there; ${kind === 'R2c' ? 'paused on Ben (rule 3)' : 'refused (rule 5)'}, PUPPET reads nothing`, async () => {
            const e = kind === 'R2c' ? await firstMetWithBensLines() : await ruleFiveDm();
            h.store.set(PINS_B(), '{"pins":{"x');
            restarted();
            await syncMessages(ana.publicKey);
            let err: any = null;
            try { await insertMessage(e.id, ana.publicKey, 'are you there?'); } catch (x) { err = x; }
            expect(err?.name).toBe('DmPinStoreError');
            expect(refusedSendNotice(err, 'Ben')).toBe(DM_PIN_STORE_UNREAD_TEXT);
            expect(await resetB()).toBe('set-aside');
            await syncMessages(ana.publicKey);
            if (kind === 'R2c') {
                pausedOnBenAfterReset(e.id);
                expect(await sendTo(e.id, 'The code is 4821')).toEqual(paused);
            } else {
                expect(pinOf(e.id)).toMatchObject({ unplaced: true, listed: puppet.publicKey });
                expect(await sendTo(e.id, 'The code is 4821')).toEqual(notLocked);
            }
        });
    }

    it('R2 with Ben\'s lines withheld until after the reset: rule 1 pins the rows\' key UNCHECKED (first sight\'s word); Ben\'s lines arrive; the first send judges them, rule 3: Ben pinned, PUPPET offered, nothing goes', async () => {
        const e = await firstMetWithBensLines(0);
        expect(await resetB()).toBe('set-aside');
        await syncMessages(ana.publicKey);
        expect(pinOf(e.id)).toEqual({ peer: puppet.publicKey, since: expect.any(String), by: 'first-seen' });
        for (let i = 0; i < 3; i++) sealed(ben, ana, e, `Ben ${i}`);
        await syncMessages(ana.publicKey);
        expect(await sendTo(e.id, 'The code is 4821')).toEqual(paused);
        expect(pinOf(e.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
    });

    it('R4 the marker is the value itself: a phone whose held lines were never written (P29) still judges after the reset; a value storage can\'t return is removed and the marker written; the re-seed\'s pin write throws once and the marker outlives it, so the next run judges again; after the seed the one key holds pins and no marker', async () => {
        // P29's phone: no held-lines key in B (the update's lines write failed). The reset still judges: paused on Ben.
        const e = await firstMetWithBensLines();
        h.store.delete(dmLinesAtUpdateStoreKey(ana.publicKey, FILE_B));
        restarted();
        expect(await resetB()).toBe('set-aside');
        await syncMessages(ana.publicKey);
        pausedOnBenAfterReset(e.id);
        expect(await sendTo(e.id, 'The code is 4821')).toEqual(paused);
        // A value storage can't return: removed, nothing set aside, and the marker written in its place.
        const f = await firstMetWithBensLines();
        h.store.delete(dmPeerPinsSetAsideStoreKey(ana.publicKey, FILE_B));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try { expect(await unreadablePins(() => resetB())).toBe('unreadable-removed'); } finally { warn.mockRestore(); }
        expect(h.store.has(dmPeerPinsSetAsideStoreKey(ana.publicKey, FILE_B))).toBe(false);
        expect(membersOfB()).toEqual(['reset']);
        const marker = h.store.get(PINS_B());
        // The re-seed's one pin write throws once: the marker stays where it was, and nothing is pinned.
        const setItem = vi.mocked(AsyncStorage.setItem);
        const realSet = setItem.getMockImplementation()!;
        let once = 1;
        setItem.mockImplementation(async (k: string, v: string) => { if (k === PINS_B() && once-- > 0) throw new Error('disk full'); return realSet(k, v); });
        try {
            await syncMessages(ana.publicKey).catch(() => {});
        } finally { setItem.mockImplementation(realSet); }
        expect(once).toBeLessThan(1);
        expect(h.store.get(PINS_B())).toBe(marker);
        // The next run: the marker read again, the re-seed judges again, and its write replaces the marker.
        restarted();
        await syncMessages(ana.publicKey);
        expect(membersOfB()).toEqual(['pins']);
        pausedOnBenAfterReset(f.id);
        expect(await sendTo(f.id, 'The code is 4821')).toEqual(paused);
    });

    it('R4 the cost: B holds 2,000 DMs whose rows name one key, 3 lines each; the first read after the reset judges each once (2,000), the next read none; A\'s file untouched', async () => {
        await phoneOf(ana);
        await switchTo('B');
        const ids = Array.from({ length: 2000 }, () => randomUUID());
        for (const id of ids) {
            heldDm('B', id, [ben.publicKey]);
            for (let i = 0; i < 3; i++) heldLine('B', id, ben, `Ben ${i}`);
        }
        await dbPort.seedDmPinsHere(ana.publicKey);
        expect(pinOf(ids[0])).toMatchObject({ peer: ben.publicKey, checked: true });
        const aBefore = h.store.get(PINS_A());
        expect(await resetB()).toBe('set-aside');
        const windows = { [FILE_A]: 0, [FILE_B]: 0 } as Record<string, number>;
        mcDbs.onQuery = async (file: string, q: string) => { if (q.includes('ORDER BY rowid ASC LIMIT')) windows[file] = (windows[file] ?? 0) + 1; };
        const t0 = performance.now();
        await dbPort.seedDmPinsHere(ana.publicKey);
        const ms = performance.now() - t0;
        expect(windows[FILE_B]).toBe(2000);
        expect(membersOfB()).toEqual(['pins']);
        expect(ids.every((id) => pinOf(id)?.peer === ben.publicKey && pinOf(id)?.checked === true)).toBe(true);
        windows[FILE_B] = 0;
        await dbPort.seedDmPinsHere(ana.publicKey);
        await isDmKeyChangePending(ids[1999]);
        expect(windows[FILE_B]).toBe(0);
        expect(windows[FILE_A]).toBe(0);
        expect(h.store.get(PINS_A())).toBe(aBefore);
        console.log(`[R4 cost] re-seed after the reset, 2,000 one-key DMs x 3 lines: ${Math.round(ms)} ms`);
    }, 300_000);

    it('Z10 B filled to exactly 1 MiB: Cat\'s honest DM, met before the flood and never sent in, is refused with the full sentence word for word, nothing posted; Ben\'s checked DM sends; after the member\'s reset Cat\'s sends', async () => {
        const cat = person('Cat');
        await phoneOf(ana);
        await switchTo('B');
        const dmB: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
        const dmCat: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, cat.publicKey] };
        node.convs = [dmB, dmCat];
        node.lines = [];
        sealed(ben, ana, dmB, 'Ben in B');
        sealed(cat, ana, dmCat, 'Cat in B');
        await syncMessages(ana.publicKey);
        expect(await sendTo(dmB.id, 'Hi Ben', [ben, cat, puppet])).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
        const flood = idsAdding(DM_PINS_MAX_BYTES - bytesOf(PINS_B()), 'z');
        node.convs = [dmB, dmCat, ...flood.map((id) => ({ id, type: 'dm', participants: [ana.publicKey, someKey()] }))];
        await syncMessages(ana.publicKey);
        expect(bytesOf(PINS_B())).toBe(DM_PINS_MAX_BYTES);
        expect(pinOf(dmCat.id)).toMatchObject({ peer: cat.publicKey, by: 'first-seen' });
        expect(pinOf(dmCat.id).checked).toBeFalsy();
        const before = node.lines.length;
        let err: any = null;
        try { await insertMessage(dmCat.id, ana.publicKey, 'Hi Cat'); } catch (x) { err = x; }
        expect(err?.name).toBe('DmPinsFullError');
        expect(refusedSendNotice(err, 'Cat')).toBe("This community lists more chats than this phone can keep track of, so a chat you haven't sent in yet can't send. Your other chats here still can.");
        expect(refusedSendNotice(err, 'Cat')).toBe(DM_PINS_FULL_TEXT);
        expect(node.lines.length).toBe(before);
        expect(await sendTo(dmB.id, 'Hi again Ben', [ben, cat, puppet])).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
        // The member's reset: the re-seed judges Cat's DM on Cat's line (rule 2, checked), so its send needs no write.
        expect(await resetB()).toBe('set-aside');
        await syncMessages(ana.publicKey);
        expect(pinOf(dmCat.id)).toMatchObject({ peer: cat.publicKey, checked: true });
        expect(await sendTo(dmCat.id, 'Hi Cat', [ben, cat, puppet])).toEqual({ err: null, posts: 1, readBy: ['Cat'] });
        expect(await sendTo(dmB.id, 'And Ben', [ben, cat, puppet])).toEqual({ err: null, posts: 1, readBy: ['Ben'] });
    }, 300_000);

    it('U6 the gate is for DMs only: with the pin store unreadable, a push tap for a group the phone doesn\'t hold writes the group\'s row, so it routes as the group it is', async () => {
        await phoneOf(ana);
        const group = { id: randomUUID(), type: 'group_thread', participants: [ana.publicKey, ben.publicKey] };
        pageFor.set(group.id, { conversation: group, messages: [] });
        restarted();
        expect(await unreadablePins(() => getConversationKind(group.id, { askNode: true }))).toBe('group_thread');
        expect(sql.prepare('SELECT type FROM conversations WHERE id = ?').get(group.id)).toEqual({ type: 'group_thread' });
    });

    it('U7 no participant row is written while an offer waits: alternating reads, the screen\'s check and syncs write none, and the rows name the pinned key', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        dm.participants = [ana.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        sql.exec(`CREATE TEMP TABLE IF NOT EXISTS cp_writes (n INTEGER); DELETE FROM cp_writes; INSERT INTO cp_writes VALUES (0);
            CREATE TEMP TRIGGER IF NOT EXISTS cp_w_i AFTER INSERT ON conversation_participants BEGIN UPDATE cp_writes SET n = n + 1; END;
            CREATE TEMP TRIGGER IF NOT EXISTS cp_w_u AFTER UPDATE ON conversation_participants BEGIN UPDATE cp_writes SET n = n + 1; END;
            CREATE TEMP TRIGGER IF NOT EXISTS cp_w_d AFTER DELETE ON conversation_participants BEGIN UPDATE cp_writes SET n = n + 1; END;`);
        try {
            for (let i = 0; i < 3; i++) {
                await getMessages(dm.id);
                await isDmKeyChangePending(dm.id);
                await syncMessages(ana.publicKey);
            }
            expect((sql.prepare('SELECT n FROM cp_writes').get() as any).n).toBe(0);
        } finally {
            sql.exec('DROP TRIGGER IF EXISTS cp_w_i; DROP TRIGGER IF EXISTS cp_w_u; DROP TRIGGER IF EXISTS cp_w_d; DROP TABLE IF EXISTS cp_writes;');
        }
        expect((sql.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ?').all(dm.id) as any[]).map((r) => r.public_key).sort()).toEqual([ana.publicKey, ben.publicKey].sort());
        expect(((await getConversation(dm.id, ana.publicKey)) as any)?.otherPubkey).toBe(ben.publicKey);
    });
});

describe('the DM guard list: one bounded list per community file, never read as empty, the pins asked first (§3.4 amendment 7 §3)', () => {
    // Confirmation 5, finding 6 (on main too): one community's node grew main's one guard list past Android's read window,
    // the next small listing wrote it over from an empty read, and a pruned DM relisted as an unlocked group sent "The code is
    // 4821" readable, while its pin (Ben, checked) sat unread in the pins. GD1-GD3 are amendment 7's table. The list's key
    // and the refusal's sentence are written out here, so the cases run unchanged on a build without them (fail-first).
    const FILE_B = 'community_castlemaine.db';
    const WINDOW = 2 * 1024 * 1024;
    const MiB = 1024 * 1024;
    const OLD_KEY = 'beanpool_dm_conversations_seen';
    const GUARD_UNREAD = "This phone couldn't read which chats here are private, so nothing was sent. Try again.";
    const seenKey = (file = FILE_A) => `beanpool_dm_conversations_seen:${ana.publicKey.toLowerCase()}:${file}`;
    const seenIn = (file = FILE_A): any => { const raw = h.store.get(seenKey(file)); if (raw == null) return null; try { return JSON.parse(raw); } catch { return 'unparseable'; } };
    const bytesOf = (k: string) => Buffer.byteLength(h.store.get(k) ?? '');
    const typeOf = (id: string) => (sql.prepare('SELECT type FROM conversations WHERE id = ?').get(id) as any)?.type ?? null;
    let puppet: Person;
    /** Groups whose chat the node answers with no `encryption` (an old node, §14.3): a phone that never held their keys may send them readable. */
    let unlocked: Set<string>;
    /** Every request a group's chat path made (a readable `{ text }` post would show here). */
    let groupPosts: { path: string; body: any }[];
    beforeEach(() => {
        puppet = person('Puppet');
        unlocked = new Set();
        groupPosts = [];
        (globalThis as any).fetch = async (url: string, init: any = {}) => {
            const u = new URL(url);
            const chat = u.pathname.match(/^\/api\/groups\/([^/]+)\/chat$/);
            if (chat && (init.method ?? 'GET') === 'GET' && unlocked.has(decodeURIComponent(chat[1]))) return answer(200, { messages: [], canPost: true });
            if ((init.method ?? 'GET') === 'POST' && u.pathname.startsWith('/api/groups/')) groupPosts.push({ path: u.pathname, body: JSON.parse(init.body ?? 'null') });
            return fetchMock(url, init);
        };
    });
    afterEach(() => {
        vi.mocked(AsyncStorage.getItem).mockImplementation(async (k: string) => h.store.get(k) ?? null);
        h.store.set('beanpool_anchor_url', ANCHOR);
    });
    function sealedLine(from: Person, to: Person, conv: Conv, text: string): Line {
        const messageId = randomUUID().toLowerCase();
        const p = phoneCrypto.sealDmLine(text, { myEdPrivHex: from.privateKey, peerEdPubHex: to.publicKey, conversationId: conv.id } as any,
            { senderPubHex: from.publicKey, messageId, part: 'body', after: null, replyToId: null } as any);
        return written(conv, from, p.ciphertext, p.nonce, { id: messageId });
    }
    const opensFor = (who: Person, l: Line) => {
        try {
            return phoneCrypto.openDmLine({ ciphertext: l.ciphertext, nonce: l.nonce }, { myEdPrivHex: who.privateKey, peerEdPubHex: ana.publicKey },
                { conversationId: l.conversationId, senderPubHex: l.authorPubkey, messageId: l.id, part: 'body', metadata: l.metadata }).text;
        } catch { return null; }
    };
    /** A send through the real path: its refusal and the line the screen shows for it, and what reached the node. */
    async function sent(id: string, text: string) {
        const before = node.lines.length;
        let err: any = null;
        try { await insertMessage(id, ana.publicKey, text); } catch (e) { err = e; }
        if (!err) await vi.waitFor(() => expect(node.lines.length).toBe(before + 1)).catch(() => {});
        await new Promise((r) => setTimeout(r, 20));
        const lines = node.lines.slice(before);
        return {
            err: err ? (err.name && err.name !== 'Error' ? err.name : String(err.message)) : null,
            notice: err ? refusedSendNotice(err) : null,
            posts: lines.length,
            plaintext: lines.filter((l) => l.nonce === 'plaintext-v1').map((l) => Buffer.from(l.ciphertext, 'base64').toString('utf8')),
            readBy: [ben, puppet].filter((p) => lines.some((l) => opensFor(p, l) !== null)).map((p) => p.name),
        };
    }
    /** Android's legacy AsyncStorage: a value whose row is bigger than the 2 MiB CursorWindow is written, and every read of it throws. */
    function windowed(): string[] {
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        const refused: string[] = [];
        getItem.mockImplementation(async (k: string) => {
            const v = await real(k);
            if (v != null && Buffer.byteLength(String(k)) + Buffer.byteLength(String(v)) > WINDOW) { refused.push(String(k)); throw new Error('Row too big to fit into CursorWindow'); }
            return v;
        });
        return refused;
    }
    /** Ana and Ben's DM with two lines, Ana's phone, and her first line, which seals to Ben and checks his pin. */
    async function anaHasSentToBen() {
        sealedLine(ana, ben, dm, 'Shall I cancel the order?');
        sealedLine(ben, ana, dm, 'No');
        await phoneOf(ana);
        const first = await sent(dm.id, 'Hello Ben');
        return { first, pin: storedPins(ana)[dm.id.toLowerCase()] ?? null };
    }
    const sealedToBen = { err: null, notice: null, posts: 1, plaintext: [], readBy: ['Ben'] };
    const relistedAsGroup = () => ({ id: dm.id, type: 'group_thread', participants: [ana.publicKey, ben.publicKey, puppet.publicKey] });

    it('GD1 the node lists 22 ids of 100,000 characters, then one small DM, prunes Ana and Ben\'s DM and relists it as an unlocked group: the list stays small and whole, other files\' lists untouched, the DM stays a DM, nothing readable', async () => {
        const { first, pin } = await anaHasSentToBen();
        // Measured for the Argon shadow: Ben's pin is checked before the node does anything (on #1872 alone the line still went readable).
        expect(first).toEqual(sealedToBen);
        expect(pin).toMatchObject({ peer: ben.publicKey, checked: true });
        h.store.set(seenKey(FILE_B), JSON.stringify([randomUUID()]));
        const otherFile = h.store.get(seenKey(FILE_B));
        const refused = windowed();
        node.convs = [dm, ...Array.from({ length: 22 }, (_, i) => ({ id: `${i}-${'d'.repeat(100_000)}`, type: 'dm', participants: [ana.publicKey, person(`L${i}`).publicKey] }))];
        await syncMessages(ana.publicKey);
        const afterLongs = { listBytes: bytesOf(seenKey()), oldListBytes: bytesOf(OLD_KEY) };
        const small: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, person('S').publicKey] };
        node.convs = [small];
        await syncMessages(ana.publicKey);   // the prune of `dm`: on main the list's read threw here, and it was written as [small]
        const afterPrune = seenIn();
        node.lines = node.lines.filter((l) => l.conversationId !== dm.id);   // none of the DM's sealed lines served with the group
        unlocked.add(dm.id);
        node.convs = [small, relistedAsGroup()];
        await syncMessages(ana.publicKey);
        const code = await sent(dm.id, 'The code is 4821');
        const r = {
            listSmall: afterLongs.listBytes > 0 && afterLongs.listBytes < 2048,
            oldListBytes: afterLongs.oldListBytes,
            listAfterPrune: Array.isArray(afterPrune) ? { dm: afterPrune.includes(dm.id), small: afterPrune.includes(small.id), long: afterPrune.some((x: string) => x.length > 64) } : afterPrune,
            otherFileUntouched: h.store.get(seenKey(FILE_B)) === otherFile,
            refusedReads: refused.length,
            typeHeld: typeOf(dm.id),
            kind: await getConversationKind(dm.id),
            code,
            pinAfter: storedPins(ana)[dm.id.toLowerCase()]?.peer === ben.publicKey,
        };
        console.log(`GD1 ${JSON.stringify({ ...r, listBytes: afterLongs.listBytes })}`);
        expect(r).toEqual({
            listSmall: true, oldListBytes: 0, listAfterPrune: { dm: true, small: true, long: false }, otherFileUntouched: true, refusedReads: 0,
            typeHeld: 'dm', kind: 'dm', code: sealedToBen, pinAfter: true,
        });
    }, 120_000);

    it('GD1f the list full when the DM is met, so only its pin remembers it: after a prune, a relist as an unlocked group written while the pins couldn\'t be read, and the pins back, it is a DM and nothing goes readable', async () => {
        // A's list at its cap before Ana meets the DM: 26,886 ids of 36 characters take 1,048,555 bytes, too full for one more.
        const filler = Array.from({ length: 26_886 }, () => randomUUID());
        h.store.set(seenKey(), JSON.stringify(filler));
        expect(bytesOf(seenKey())).toBe(1_048_555);
        const { first, pin } = await anaHasSentToBen();
        expect(first).toEqual(sealedToBen);
        expect(pin).toMatchObject({ peer: ben.publicKey, checked: true });
        const listedWhenMet = (seenIn() as string[]).includes(dm.id);
        node.convs = [];
        await syncMessages(ana.publicKey);   // the prune
        node.lines = node.lines.filter((l) => l.conversationId !== dm.id);
        unlocked.add(dm.id);
        node.convs = [relistedAsGroup()];
        // The relist lands while the pins can't be read (the app started again, its pin store failing once): the list is full
        // and nothing else knows the id, so its row takes the node's type.
        restarted();
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        getItem.mockImplementation(async (k: string) => { if (k.startsWith(dmPeerPinsStoreKey(ana.publicKey, ''))) throw new Error('storage unavailable'); return real(k); });
        try { await syncMessages(ana.publicKey); } finally { getItem.mockImplementation(real); }
        const typeWhilePinsUnread = typeOf(dm.id);
        // The pins read again: the first send asks the DM's key context before any group sealing (the row still says group).
        const codeBeforeSync = await sent(dm.id, 'The code is 4821');
        await syncMessages(ana.publicKey);   // the type path asks the pins first: the row goes back to dm
        const codeAfterSync = await sent(dm.id, 'The code is 4822');
        const r = {
            listedWhenMet, listBytes: bytesOf(seenKey()) <= MiB, fillerKept: ((kept) => filler.every((id) => kept.has(id)))(new Set(seenIn() as string[])),
            typeWhilePinsUnread, codeBeforeSync: { plaintext: codeBeforeSync.plaintext, puppet: codeBeforeSync.readBy.includes('Puppet') },
            typeAfter: typeOf(dm.id), kind: await getConversationKind(dm.id), codeAfterSync,
        };
        console.log(`GD1f ${JSON.stringify({ ...r, codeBeforeSync })}`);
        expect(r).toEqual({
            listedWhenMet: false, listBytes: true, fillerKept: true, typeWhilePinsUnread: 'group_thread',
            codeBeforeSync: { plaintext: [], puppet: false }, typeAfter: 'dm', kind: 'dm', codeAfterSync: sealedToBen,
        });
    }, 120_000);

    for (const how of ['a read that throws', 'a corrupt value'] as const) {
        it(`GD2 the list unreadable (${how}) while the node relists the DM as a group and lists a true group: no list write, the DM's row keeps dm, the readable send refused with its own sentence; readable again, the group sends as an old node's`, async () => {
            const { first } = await anaHasSentToBen();
            expect(first).toEqual(sealedToBen);
            const group: Conv = { id: randomUUID(), type: 'group_thread', participants: [ana.publicKey, puppet.publicKey] };
            unlocked.add(group.id);
            unlocked.add(dm.id);
            const getItem = vi.mocked(AsyncStorage.getItem);
            const real = getItem.getMockImplementation()!;
            if (how === 'a corrupt value') h.store.set(seenKey(), '["' + dm.id + '", {unreadable');
            else getItem.mockImplementation(async (k: string) => { if (k === seenKey()) throw new Error('storage unavailable'); return real(k); });
            const stored = h.store.get(seenKey());
            const setItem = vi.mocked(AsyncStorage.setItem);
            const writesBefore = setItem.mock.calls.length;
            // A new DM listed in the same pass: the pass would remember it, and writes nothing over a list it couldn't read.
            const newDm: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, person('Cat').publicKey] };
            node.convs = [relistedAsGroup(), group, newDm];
            await syncMessages(ana.publicKey);
            const toGroup = await sent(group.id, 'Hello group');
            const postsBefore = groupPosts.length;
            let viaGroupScreen: string | null = null;
            try {
                const { postGroupChatMessage } = await import('../db');
                await postGroupChatMessage(group.id, 'Hello group, from its screen', randomUUID());
                viaGroupScreen = 'went';
            } catch (e: any) { viaGroupScreen = refusedSendNotice(e) ?? e?.message; }
            const toDm = await sent(dm.id, 'The code is 4821');
            const r = {
                listWrites: setItem.mock.calls.slice(writesBefore).filter(([k]) => k === seenKey() || k === OLD_KEY).length,
                storedKept: h.store.get(seenKey()) === stored,
                dmRow: typeOf(dm.id), groupRow: typeOf(group.id), newDmRow: typeOf(newDm.id),
                toGroup, viaGroupScreen, groupScreenPosts: groupPosts.length - postsBefore, toDm,
            };
            getItem.mockImplementation(real);
            if (how === 'a corrupt value') h.store.delete(seenKey());   // a fresh list: seeded again from this file's dm rows
            await syncMessages(ana.publicKey);
            const listNow = (seenIn() as string[]) ?? [];
            const readable = { groupRow: typeOf(group.id), listHas: { dm: listNow.includes(dm.id), newDm: listNow.includes(newDm.id) }, toGroup: await sent(group.id, 'Hello again, group') };
            console.log(`GD2 (${how}) ${JSON.stringify({ r, readable })}`);
            expect(r).toEqual({
                listWrites: 0, storedKept: true, dmRow: 'dm', groupRow: null, newDmRow: 'dm',
                toGroup: { err: 'DmGuardUnreadError', notice: GUARD_UNREAD, posts: 0, plaintext: [], readBy: [] },
                viaGroupScreen: GUARD_UNREAD, groupScreenPosts: 0, toDm: sealedToBen,
            });
            expect(readable).toEqual({ groupRow: 'group_thread', listHas: { dm: true, newDm: true }, toGroup: { err: null, notice: null, posts: 1, plaintext: ['Hello again, group'], readBy: [] } });
        }, 120_000);
    }

    it('GD3 the caps: 30,000 UUID DMs in one listing; then, in another community, 22 ids of 100,000 characters and one each of 64 and 65: the value stays within 1 MiB, every id read before is still there, the newest are refused and logged; the long ids are never remembered', async () => {
        await phoneOf(ana);
        const before = seenIn() as string[];
        expect(before).toEqual([dm.id]);
        const warn = vi.spyOn(console, 'warn');
        const many: Conv[] = Array.from({ length: 30_000 }, () => ({ id: randomUUID(), type: 'dm', participants: [ana.publicKey, '0'.repeat(64)] }));
        // The stand-in node answers each of these chats' pages from a set (an empty chat), not by a scan of 30,000.
        const manyIds = new Set(many.map((c) => c.id));
        const fetchNow = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string, init: any = {}) => {
            const page = new URL(url).pathname.match(/^\/api\/messages\/([^/]+)$/);
            if (page && manyIds.has(decodeURIComponent(page[1]))) return answer(200, { conversation: { id: decodeURIComponent(page[1]), type: 'dm', participants: [] }, messages: [] });
            return fetchNow(url, init);
        };
        node.convs = [dm, ...many];
        const started = Date.now();
        try { await syncMessages(ana.publicKey); } finally { (globalThis as any).fetch = fetchNow; }
        const ms = Date.now() - started;
        const after = seenIn() as string[];
        const kept = new Set(after);
        const firstRefused = many.findIndex((c) => !kept.has(c.id));
        const full = {
            withinCap: bytesOf(seenKey()) <= MiB, roomForNoMore: MiB - bytesOf(seenKey()) < 39,
            beforeKept: before.every((id) => kept.has(id)), oldestKept: kept.has(many[0].id), newestRefused: !kept.has(many[many.length - 1].id),
            refusedAreTheNewest: firstRefused > 0 && many.slice(firstRefused).every((c) => !kept.has(c.id)),
            logged: warn.mock.calls.some((c) => String(c[0]).includes('[DM guard]') && String(c[0]).includes('list is full')),
        };
        warn.mockRestore();
        // Another community's node, with ids no honest node makes, into that file's own list.
        h.store.set('beanpool_anchor_url', 'https://castlemaine.beanpool.org');
        await getDb();
        const id64 = `${'e'.repeat(28)}${randomUUID()}`;
        const id65 = `${'f'.repeat(29)}${randomUUID()}`;
        node.convs = [...Array.from({ length: 22 }, (_, i) => ({ id: `${i}-${'d'.repeat(100_000)}`, type: 'dm', participants: [ana.publicKey, person(`L${i}`).publicKey] })),
            { id: id64, type: 'dm', participants: [ana.publicKey, person('S64').publicKey] }, { id: id65, type: 'dm', participants: [ana.publicKey, person('S65').publicKey] }];
        await syncMessages(ana.publicKey);
        const inB = (seenIn(FILE_B) ?? []) as string[];
        h.store.set('beanpool_anchor_url', ANCHOR);
        await getDb();
        const b = { under1KB: bytesOf(seenKey(FILE_B)) > 0 && bytesOf(seenKey(FILE_B)) < 1024, has64: inB.includes(id64), has65: inB.includes(id65), longAbsent: !inB.some((x) => x.length > 65), aUnchanged: JSON.stringify(seenIn()) === JSON.stringify(after) };
        console.log(`GD3 ${JSON.stringify({ full, bytesA: bytesOf(seenKey()), ms, b, bytesB: bytesOf(seenKey(FILE_B)) })}`);
        expect(full).toEqual({ withinCap: true, roomForNoMore: true, beforeKept: true, oldestKept: true, newestRefused: true, refusedAreTheNewest: true, logged: true });
        expect(b).toEqual({ under1KB: true, has64: true, has65: false, longAbsent: true, aUnchanged: true });
    }, 300_000);
});
