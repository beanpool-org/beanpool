import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_mullum.beanpool.org.db'), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { getDb, getMessages, syncMessages, syncSingleConversation, insertMessage, editMessage, sendImageMessage, getDecryptedAttachment, getConversations, getConversationKind, getConversation, isHeldGroupChat, knownDmConversationId, groupScreenKeyringFor, isDmKeyChangePending, isDmUnplaced, _resetDmPeerPinsForTests, getDmKeyChange, acceptOfferedPeer } from '../db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { refusedSendNotice, dmLineSlotText, DM_OFFERED_KEY_LINE } from '../dm-lock';
import { dmKeyChangeCopy } from '../dm-key-change';
import { DM_PIN_STORE_UNREAD_TEXT } from '../dm-peer-pins';
import { routeChat } from '../chat-route';
import { dmQuoteFor } from '../chat-actions';
import { GROUP_KEYS_FOR_DM_TEXT } from '../group-chat-lines';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { dmPeerPinsStoreKey } from '../storage-keys';
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
        h.store.delete('beanpool_dm_conversations_seen');   // a phone that has never seen it
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
    const DM_SEEN = 'beanpool_dm_conversations_seen';
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
        seen: (JSON.parse(h.store.get(DM_SEEN) ?? '[]') as string[]).filter((s) => s.toLowerCase() === id.toLowerCase()),
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
        h.store.delete(DM_SEEN);   // restored from the 12 words: the DM list starts from this sync, in the node's order
        h.store.delete(dmPeerPinsStoreKey(ana.publicKey));   // and so do its DM pins (a phone that kept them: the pin tests below)
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
        h.store.delete(DM_SEEN);
        h.store.delete(dmPeerPinsStoreKey(ana.publicKey));
        restarted();
        await phoneOf(ana);
        expect(held(dm.id)).toEqual({ rows: [`${dm.id}:dm`, `${twin.id}:dm`], seen: [twin.id, dm.id] });
        await expectBens(dm.id, 'Still want the order?', await tapAndSend(dm.id, 'Still want the order?'));
    });

    it('the DM list unreadable, so only the rows and lines answer (SQLite visits upper case first): Ben\'s row still opens Ben\'s thread', async () => {
        await aQuestionAndAnAnswer();
        const twin: Conv = { id: dm.id.toUpperCase(), type: 'dm', participants: [ana.publicKey, puppet.publicKey] };
        node.convs = [twin, dm];
        h.store.delete(DM_SEEN);
        h.store.delete(dmPeerPinsStoreKey(ana.publicKey));
        restarted();
        await phoneOf(ana);
        expect(held(dm.id)).toEqual({ rows: [`${twin.id}:dm`, `${dm.id}:dm`], seen: [twin.id, dm.id] });
        h.store.set(DM_SEEN, '{unreadable');
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
            h.store.set(DM_SEEN, JSON.stringify(seen));
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
        h.store.delete('beanpool_dm_conversations_seen');
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
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey);
    const pinOf = (who: Person, id: string) => (JSON.parse(h.store.get(PINS(who)) ?? '{}') as Record<string, any>)[id.toLowerCase()] ?? null;
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
        h.store.delete(PINS(ana));
        h.store.delete('beanpool_dm_conversations_seen');
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
        h.store.delete(PINS(ana));
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
        h.store.delete('beanpool_dm_conversations_seen');
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
        h.store.set('beanpool_dm_conversations_seen', '{unreadable');
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
        const pins = JSON.parse(h.store.get(PINS(ana))!);
        pins[dm.id.toLowerCase()] = { peer: benNew.publicKey, since: new Date().toISOString(), by: 'member', former: [ben.publicKey] };
        h.store.set(PINS(ana), JSON.stringify(pins));
        restarted();
        for (const t of ['messages', 'conversation_participants', 'conversations']) sql.exec(`DELETE FROM ${t}`);
        expect((await shows(dm)).map((l) => l.text)).toEqual(['Shall I cancel the order?', 'No']);
        const r = await trySend(dm.id, 'Welcome back');
        expect(r.sent.map((l) => ({ benNew: reads(benNew, l), benOld: reads(ben, l) }))).toEqual([{ benNew: 'Welcome back', benOld: null }]);
    });

    // Slice 2: the banner's state (getDmKeyChange), the member's "Continue with the new key" (acceptOfferedPeer) and the
    // Inbox tag, through the same real sync, send and read paths.
    const tagOf = async (who: Person, id: string) => (await getConversations(who.publicKey)).find((c: any) => c.id === id)?.keyChanged;
    const snapshot = (who: Person, id: string) => ({
        pins: h.store.get(PINS(who)) ?? null,
        participants: participantsOf(id),
        messages: sql.prepare('SELECT id, author_pubkey, ciphertext, nonce FROM messages WHERE conversation_id = ? ORDER BY id').all(id),
    });
    /** Ben re-keys honestly (engine/key-move.ts): the node moves his participant row and his lines' author to the new key. */
    function benRekeys(benNew: Person) {
        dm.participants = [ana.publicKey, benNew.publicKey];
        for (const l of node.lines) if (l.authorPubkey === ben.publicKey) l.authorPubkey = benNew.publicKey;
    }

    it('P3 (an honest re-key): the banner offers Ben\'s new key; after Ana continues, the new key reads her line, the old key never gets one, and Ben\'s old lines and photo still open (former = [Ben])', async () => {
        await phoneOf(ana);
        await says(ana, dm, 'Shall I cancel the order?');
        await phoneOf(ben);
        await says(ben, dm, 'No');
        await sendImageMessage(dm.id, 'data:image/jpeg;base64,QkVOUw==', '');
        const photo = node.lines[node.lines.length - 1];
        await phoneOf(ana);
        const benNew = person('Ben (new phone)');
        benRekeys(benNew);
        await syncMessages(ana.publicKey);

        // The banner's state, the Inbox tag, and a send refused before anything leaves.
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: benNew.publicKey } });
        expect(await getDmKeyChange(dm.id)).toEqual({ offeredPeer: benNew.publicKey, firstSight: false, name: null });
        expect(await tagOf(ana, dm.id)).toBe(true);
        const refused = await trySend(dm.id, 'Is that you?');
        expect({ err: refused.err?.name, sent: refused.sent.length }).toEqual({ err: 'DmKeyChangedError', sent: 0 });

        // Continue with a key that isn't the one on offer: nothing moves.
        expect(await acceptOfferedPeer(dm.id, puppet.publicKey)).toBe(false);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', offered: { peer: benNew.publicKey } });

        expect(await acceptOfferedPeer(dm.id, benNew.publicKey)).toBe(true);
        expect(pinOf(ana, dm.id)).toEqual({ peer: benNew.publicKey, since: expect.any(String), by: 'member', former: [ben.publicKey] });
        expect(await getDmKeyChange(dm.id)).toBeNull();
        expect(await tagOf(ana, dm.id)).toBe(false);

        const shown = await shows(dm);
        expect(shown.slice(0, 2).map((l) => l.text)).toEqual(['Shall I cancel the order?', 'No']);
        expect(shown.map((l) => l.text)).not.toContain(NOT_VERIFIED);
        expect(await getDecryptedAttachment(dm.id, photo.id)).toMatch(/chat-images\//);
        expect(fs.readFileSync(`${h.cacheDir}/chat-images/${photo.id}.jpg`, 'utf8')).toBe('QkVOUw==');

        const r = await trySend(dm.id, 'Welcome back');
        expect(r.err).toBeNull();
        expect(r.sent.map((l) => ({ benNew: reads(benNew, l), benOld: reads(ben, l), puppet: reads(puppet, l) }))).toEqual([{ benNew: 'Welcome back', benOld: null, puppet: null }]);
        // Ben's old key never received a line after the move, and PUPPET none at all.
        expect(node.lines.filter((l) => l.authorPubkey === ana.publicKey && reads(puppet, l) !== null)).toEqual([]);
        // A sync after the move leaves the member's pin where they put it.
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: benNew.publicKey, by: 'member', former: [ben.publicKey] });
        expect(pinOf(ana, dm.id).offered).toBeUndefined();
    });

    it('P12: reading the banner again ("Not now", or the next poll) writes nothing; "Continue" rewrites the participant rows to [Ana, the new key] and marks the pin the member\'s', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const benNew = person('Ben (new phone)');
        benRekeys(benNew);
        await syncMessages(ana.publicKey);
        expect(await getDmKeyChange(dm.id)).toEqual({ offeredPeer: benNew.publicKey, firstSight: false, name: null });
        const before = snapshot(ana, dm.id);
        expect(before.participants).toEqual([ana.publicKey, ben.publicKey].sort());
        // "Not now" calls nothing; what the screen asks on its next load is the same read.
        expect(await getDmKeyChange(dm.id)).toEqual({ offeredPeer: benNew.publicKey, firstSight: false, name: null });
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(snapshot(ana, dm.id)).toEqual(before);

        expect(await acceptOfferedPeer(dm.id, benNew.publicKey)).toBe(true);
        const after = snapshot(ana, dm.id);
        expect(after.participants).toEqual([ana.publicKey, benNew.publicKey].sort());
        expect(after.messages).toEqual(before.messages);
        expect(JSON.parse(after.pins!)[dm.id.toLowerCase()]).toMatchObject({ peer: benNew.publicKey, by: 'member', former: [ben.publicKey] });
        // Continuing twice moves nothing more.
        expect(await acceptOfferedPeer(dm.id, benNew.publicKey)).toBe(false);
        expect(snapshot(ana, dm.id)).toEqual(after);
    });

    it('a third key offered between the banner and the tap: "Continue" for the key Ana checked moves nothing', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const benNew = person('Ben (new phone)');
        benRekeys(benNew);
        await syncMessages(ana.publicKey);
        const banner = await getDmKeyChange(dm.id);
        expect(banner?.offeredPeer).toBe(benNew.publicKey);
        dm.participants = [ana.publicKey, puppet.publicKey];   // the node swaps the offer while Ana is on the phone to Ben
        await syncMessages(ana.publicKey);
        // The screen's next read shows a new banner for PUPPET's key (keyed on it, so Ana's tick for Ben's code is gone).
        expect(await getDmKeyChange(dm.id)).toEqual({ offeredPeer: puppet.publicKey, firstSight: false, name: null });
        const before = snapshot(ana, dm.id);
        expect(await acceptOfferedPeer(dm.id, banner!.offeredPeer!)).toBe(false);
        expect(snapshot(ana, dm.id)).toEqual(before);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        const r = await trySend(dm.id, 'Still there?');
        expect({ err: r.err?.name, sent: r.sent.length }).toEqual({ err: 'DmKeyChangedError', sent: 0 });
    });

    it('the banner names the person from a key\'s member row: the pinned key\'s, else the offered key\'s once the directory moves the name; never the conversation id (#1873 review, finding 2)', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const benNew = person('Ben (new phone)');
        benRekeys(benNew);
        await syncMessages(ana.publicKey);
        sql.prepare('DELETE FROM members WHERE public_key IN (?, ?)').run(ben.publicKey, benNew.publicKey);
        expect((await getDmKeyChange(dm.id))?.name).toBeNull();   // no row: the banner says "this person"
        // An honest re-key: the node moves the member row to the new key and the phone's directory sync drops the old one.
        sql.prepare('INSERT INTO members (public_key, callsign) VALUES (?, ?)').run(benNew.publicKey, 'Ben');
        expect((await getDmKeyChange(dm.id))?.name).toBe('Ben');
        // The pinned key's own row comes first.
        sql.prepare('INSERT INTO members (public_key, callsign) VALUES (?, ?)').run(ben.publicKey, 'Benjamin (old)');
        expect((await getDmKeyChange(dm.id))?.name).toBe('Benjamin (old)');
        const title = dmKeyChangeCopy({ peerName: (await getDmKeyChange(dm.id))!.name, code: '1111 2222 3333 4444 5555', firstSight: false }).title;
        expect(title).toBe('The key behind "Benjamin (old)" changed.');
        expect(title).not.toContain(dm.id.slice(0, 8));
    });

    it('several other keys listed in place of the pinned one: the banner offers none, and nothing can be continued with', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const benNew = person('Ben (new phone)');
        dm.participants = [ana.publicKey, benNew.publicKey, puppet.publicKey];
        await syncMessages(ana.publicKey);
        expect(await getDmKeyChange(dm.id)).toEqual({ offeredPeer: null, firstSight: false, name: null });
        expect(await acceptOfferedPeer(dm.id, benNew.publicKey)).toBe(false);
        expect(await acceptOfferedPeer(dm.id, puppet.publicKey)).toBe(false);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen' });
    });

    it('a restored phone that met the DM with someone else in it (P4\'s set-up): Ben\'s lines place Ben, the banner is a first-sight pause offering the listed key, and Continue moves only to that key, Ben kept in former', async () => {
        await aQuestionAndAnAnswer();
        dm.participants = [ana.publicKey, puppet.publicKey];
        h.store.delete(PINS(ana));
        restarted();
        await phoneOf(ana);
        expect(await getDmKeyChange(dm.id)).toEqual({ offeredPeer: puppet.publicKey, firstSight: true, name: null });
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', checked: true, offered: { peer: puppet.publicKey, firstSight: true } });
        expect(await tagOf(ana, dm.id)).toBe(true);   // the Inbox tag for a first-sight pause too (slice 1's handover, 7)
        expect(await acceptOfferedPeer(dm.id, ben.publicKey)).toBe(false);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, by: 'first-seen', offered: { peer: puppet.publicKey } });
        expect(await acceptOfferedPeer(dm.id, puppet.publicKey)).toBe(true);
        expect(pinOf(ana, dm.id)).toEqual({ peer: puppet.publicKey, since: expect.any(String), by: 'member', former: [ben.publicKey] });
        expect(await getDmKeyChange(dm.id)).toBeNull();
        expect(await tagOf(ana, dm.id)).toBe(false);
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
        expect(Object.keys(JSON.parse(h.store.get(PINS(ana))!)).length).toBe(701);   // and Ana and Ben's DM from beforeEach
        getItem.mockClear(); setItem.mockClear();
        await syncMessages(ana.publicKey);
        expect(counts()).toEqual({ gets: 0, sets: 0 });   // nothing changed: held in memory, not read again, not written
    }, 60_000);
});

describe('the pin under a node that chooses its moment (#1872 review)', () => {
    let puppet: Person;
    beforeEach(() => { puppet = person('Puppet'); });
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey);
    const pinOf = (who: Person, id: string) => (JSON.parse(h.store.get(PINS(who)) ?? '{}') as Record<string, any>)[id.toLowerCase()] ?? null;
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
            h.store.delete(PINS(ana));   // the phone as a build without pins left it: rows, lines, no pin store
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
            h.store.delete(PINS(ana));
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
        const pins = JSON.parse(h.store.get(PINS(ana))!);
        delete pins[dm.id.toLowerCase()];
        h.store.set(PINS(ana), JSON.stringify(pins));
        restarted();
        dm.participants = [ana.publicKey, puppet.publicKey];
        puppetSays(dm, 'New phone. What is the code?');
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmKeyChangedError', puppetRead: false });
    });

    it('P19: first sight is judged once per DM (the screen\'s check on a restored phone); a read, a photo, a later poll and a send never judge it again nor read the pin store', async () => {
        const { question } = await aQuestionAndAnAnswer();
        h.store.delete(PINS(ana));   // a restored phone: no pins, the history on the node
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
        h.store.delete(PINS(ana));
        h.store.delete('beanpool_dm_conversations_seen');
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
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey);
    const pinOf = (who: Person, id: string) => (JSON.parse(h.store.get(PINS(who)) ?? '{}') as Record<string, any>)[id.toLowerCase()] ?? null;
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
            h.store.delete(PINS(ana));   // the phone as a build without pins left it
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
        h.store.delete(PINS(ana));
        h.store.delete('beanpool_dm_conversations_seen');
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
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey);
    const pinOf = (who: Person, id: string) => (JSON.parse(h.store.get(PINS(who)) ?? '{}') as Record<string, any>)[id.toLowerCase()] ?? null;
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
        h.store.delete(PINS(ana));
        h.store.delete('beanpool_dm_conversations_seen');
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
        expect(await getDmKeyChange(dm.id)).toEqual({ offeredPeer: k2.publicKey, firstSight: true, rekeyedAt: '2026-10-03T00:00:00.000Z', name: null });
        // "Continue with the new key": the real call, with no restart after it (the pin book's copy is the one it changes).
        expect(await acceptOfferedPeer(dm.id, ben.publicKey)).toBe(false);
        expect(await acceptOfferedPeer(dm.id, k2.publicKey)).toBe(true);
        expect(pinOf(ana, dm.id)).toEqual({ peer: k2.publicKey, since: expect.any(String), by: 'member', former: [ben.publicKey] });
        expect(await getDmKeyChange(dm.id)).toBeNull();
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
            h.store.delete(PINS(ana));
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
            h.store.delete(PINS(ana));
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

    // §3.4 amendment 2, item 3, the data half (slice 2 draws the fixed line): a line that opens only under the offered key
    // is marked fromOfferedKey and shows no words, on first sight and on an existing phone's offer alike.
    const lineMarks = async (id: string) => (await getMessages(id)).map((m: any) => ({ text: m.text, offered: m.fromOfferedKey }));
    // What the DM screen draws in each line's slot ([id].tsx renderUnattributedLine → dmLineSlotText): the fixed line for
    // a line from the offered key, for every offer, never its words.
    const drawn = async (id: string) => (await getMessages(id)).map((m: any) => dmLineSlotText(m));

    it('item 3: P13\'s PUPPET line is marked as from the offered key and shows no words, before and after "Not now"; Ben\'s lines read unmarked', async () => {
        await p13();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        const want = [
            { text: 'Shall I cancel the order?', offered: false },
            { text: 'No', offered: false },
            { text: NOT_VERIFIED, offered: true },
        ];
        expect(await lineMarks(dm.id)).toEqual(want);
        expect(await drawn(dm.id)).toEqual(['Shall I cancel the order?', 'No', DM_OFFERED_KEY_LINE]);
        for (let pass = 0; pass < 2; pass++) await syncMessages(ana.publicKey);   // "Not now" writes nothing
        expect(await lineMarks(dm.id)).toEqual(want);
        expect(await drawn(dm.id)).toEqual(['Shall I cancel the order?', 'No', DM_OFFERED_KEY_LINE]);
    });

    it('item 3: P14\'s K2 line is marked as from the offered key until Continue, then reads as K2\'s words, unmarked', async () => {
        await p14();
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect((await lineMarks(dm.id))[2]).toEqual({ text: NOT_VERIFIED, offered: true });
        expect((await drawn(dm.id))[2]).toBe(DM_OFFERED_KEY_LINE);
        const pins = JSON.parse(h.store.get(PINS(ana))!);
        pins[dm.id.toLowerCase()] = { peer: k2.publicKey, since: '2026-10-14T00:00:00.000Z', by: 'member', former: [ben.publicKey] };
        h.store.set(PINS(ana), JSON.stringify(pins));
        restarted();
        expect(await lineMarks(dm.id)).toEqual([
            { text: 'Shall I cancel the order?', offered: false },
            { text: 'No', offered: false },
            { text: 'New phone. Still on for Saturday?', offered: false },
        ]);
        expect((await drawn(dm.id))[2]).toBe('New phone. Still on for Saturday?');
    });

    it('item 3: an existing phone\'s offer (T5\'s shape) marks PUPPET\'s line; a line that opens under no key stays unmarked', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        dm.participants = [ana.publicKey, puppet.publicKey];
        saysTo(puppet, dm, 'New phone, same Ben. What is the door code?');
        written(dm, puppet, b64('not a sealed line'), DM_NONCE_PREFIX + b64('n'.repeat(24)));
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, offered: { peer: puppet.publicKey } });
        expect(await lineMarks(dm.id)).toEqual([
            { text: 'Shall I cancel the order?', offered: false },
            { text: 'No', offered: false },
            { text: NOT_VERIFIED, offered: true },
            { text: NOT_VERIFIED, offered: false },
        ]);
        expect(await drawn(dm.id)).toEqual(['Shall I cancel the order?', 'No', DM_OFFERED_KEY_LINE, NOT_VERIFIED]);
    });

    /** Ben's history of `n` lines (Ana's and Ben's in turn, each sealed to the other), as the node holds it. */
    async function bensHistory(n: number) {
        await aQuestionAndAnAnswer();
        for (let i = 2; i < n; i++) i % 2 ? sealed(ben, ana, dm, `Ben ${i}`) : sealed(ana, ben, dm, `Ana ${i}`);
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
        h.store.delete(PINS(ana));
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
        h.store.delete(PINS(ana));
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
        expect(marks.filter((m) => m.offered)).toEqual(Array(40).fill({ text: NOT_VERIFIED, offered: true }));
        expect(marks.filter((m) => !m.offered).map((m) => m.text)).toEqual(bensTexts(30));
        expect(JSON.stringify(marks)).not.toContain('PUPPET');
        const shown = await drawn(dm.id);
        expect(shown.filter((t) => t === DM_OFFERED_KEY_LINE)).toHaveLength(40);
        expect(shown.filter((t) => t !== DM_OFFERED_KEY_LINE)).toEqual(bensTexts(30));
        expect(JSON.stringify(shown)).not.toContain('PUPPET');
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
            expect(marks.map((m) => m.offered)).toEqual(Array.from({ length: 30 }, (_, i) => i % 2 === 0));
            expect(await drawn(dm.id)).toEqual(Array.from({ length: 30 }, (_, i) => i % 2 === 0 ? DM_OFFERED_KEY_LINE : NOT_VERIFIED));
            expect(await sendTo(dm.id, 'The code is 4821', [puppet, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        });
    }

    it('P25 (honest): an existing phone held Ben\'s lines, Ben re-keyed to K2 before the update and K2\'s 3 lines synced live: a pause with K2 offered (rule 4) and the date; after Continue every line reads', async () => {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        benRekeys({ formerKeys: true });
        for (let i = 0; i < 3; i++) saysTo(k2, dm, `K2 line ${i}`);
        await syncMessages(ana.publicKey);   // live, on the build before the update
        h.store.delete(PINS(ana));
        restarted();
        sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(dm.id, k2.publicKey);
        await syncMessages(ana.publicKey);
        expect(await isDmKeyChangePending(dm.id)).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey, checked: true, offered: { peer: k2.publicKey, firstSight: true, nodeSays: { rekeyedAt: '2026-10-03T00:00:00.000Z' } } });
        expect(await sendTo(dm.id, 'See you Saturday', [k2, ben])).toEqual({ err: 'DmKeyChangedError', posts: 0, rowsAdded: 0, readBy: [] });
        const pins = JSON.parse(h.store.get(PINS(ana))!);
        pins[dm.id.toLowerCase()] = { peer: k2.publicKey, since: '2026-10-14T00:00:00.000Z', by: 'member', former: [ben.publicKey] };
        h.store.set(PINS(ana), JSON.stringify(pins));
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
// #1873 review, finding 5 (its port-cases.part): "Continue" against a sync pass, and photos under every attribution. The
// race cases failed on 300cb036 (each writer read and wrote the whole store) and pass with the pin book's one queue; the
// photo matrix kills M8 (a former key tried for a row in anyone's name). Under the pin book the store is read from storage
// once an app run, so each race starts a fresh run (restarted()) and holds that one read: the pass and the tap both wait
// on it, then take their turns in the queue.
describe('#1873 review: "Continue" and the sync pass, and photos under every attribution', () => {
    let puppet: Person;
    beforeEach(() => { puppet = person('Puppet'); });
    const PINS = (who: Person) => dmPeerPinsStoreKey(who.publicKey);
    const pinOf = (who: Person, id: string) => (JSON.parse(h.store.get(PINS(who)) ?? '{}') as Record<string, any>)[id.toLowerCase()] ?? null;
    function reads(reader: Person, line: Line): string | null {
        try {
            return phoneCrypto.openDmLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { myEdPrivHex: reader.privateKey, peerEdPubHex: line.authorPubkey },
                { conversationId: line.conversationId, senderPubHex: line.authorPubkey, messageId: line.id, part: 'body', metadata: line.metadata }).text;
        } catch { return null; }
    }
    async function send(text: string): Promise<Line | string> {
        const before = node.lines.length;
        try { await insertMessage(dm.id, ana.publicKey, text); } catch (e: any) { return e?.name; }
        await vi.waitFor(() => expect(node.lines.length).toBe(before + 1));
        return node.lines[node.lines.length - 1];
    }
    /** A fresh app run, then hold the nth read of the pins from storage: answered with what the store held when asked, once released. */
    function holdPinsRead(who: Person, nth = 1) {
        restarted();
        const getItem = vi.mocked(AsyncStorage.getItem);
        const real = getItem.getMockImplementation()!;
        let n = 0; let captured!: () => void; const wasRead = new Promise<void>((r) => { captured = r; });
        let release!: () => void; const released = new Promise<void>((r) => { release = r; });
        getItem.mockImplementation(async (k: string) => {
            if (k !== PINS(who) || ++n < nth) return real(k);
            getItem.mockImplementation(real);
            const snap = h.store.get(k) ?? null; captured(); await released; return snap;
        });
        return { wasRead, release };
    }
    const settle = () => new Promise((r) => setTimeout(r, 30));
    async function honestRekeyBanner() {
        await aQuestionAndAnAnswer();
        await phoneOf(ana);
        const k2 = person('Ben (new phone)');
        dm.participants = [ana.publicKey, k2.publicKey];
        for (const l of node.lines) if (l.authorPubkey === ben.publicKey) l.authorPubkey = k2.publicKey;
        await syncMessages(ana.publicKey);
        expect(await getDmKeyChange(dm.id)).toEqual({ offeredPeer: k2.publicKey, firstSight: false, name: null });
        return k2;
    }

    it('a sync pass that read the pins before "Continue" and writes after it doesn\'t undo it: the member\'s key holds, and the next line goes to it', async () => {
        const k2 = await honestRekeyBanner();
        node.convs.push({ id: randomUUID(), type: 'dm', participants: [ana.publicKey, person('Cat').publicKey] });   // so the pass writes
        const gate = holdPinsRead(ana);
        const sync = syncMessages(ana.publicKey);
        await gate.wasRead;
        const tap = acceptOfferedPeer(dm.id, k2.publicKey);
        await settle();
        gate.release();
        await sync;
        expect(await tap).toBe(true);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: k2.publicKey, by: 'member', former: [ben.publicKey] });
        const l = await send('After the pass');
        expect(typeof l === 'string' ? l : { k2: reads(k2, l), ben: reads(ben, l), puppet: reads(puppet, l) }).toEqual({ k2: 'After the pass', ben: null, puppet: null });
    });

    it('a pass that lists the old key again while "Continue" lands: Continue says nothing changed, never "moved" over a pin that isn\'t the member\'s', async () => {
        const k2 = await honestRekeyBanner();
        dm.participants = [ana.publicKey, ben.publicKey];
        const gate = holdPinsRead(ana);
        const sync = syncMessages(ana.publicKey);
        await gate.wasRead;
        const tap = acceptOfferedPeer(dm.id, k2.publicKey);
        await settle();
        gate.release();
        await sync;
        const moved = await tap;
        const pin = pinOf(ana, dm.id);
        // Either the tap landed (and the pin is the member's) or it said so: never "moved" with the pin back on the old key.
        expect({ moved, peer: pin.peer === k2.publicKey ? 'K2' : pin.peer === ben.publicKey ? 'Ben' : '?', by: pin.by })
            .toEqual(moved ? { moved: true, peer: 'K2', by: 'member' } : { moved: false, peer: 'Ben', by: 'first-seen' });
    });

    it('"Continue" that read the pins before a pass offered a third key keeps that offer: the next line is refused, not sealed', async () => {
        const k2 = await honestRekeyBanner();
        const k3 = person('K3');
        const gate = holdPinsRead(ana);
        const tap = acceptOfferedPeer(dm.id, k2.publicKey);
        await gate.wasRead;
        dm.participants = [ana.publicKey, k3.publicKey];
        const sync = syncMessages(ana.publicKey);
        await settle();
        gate.release();
        const moved = await tap;
        await sync;
        // Whichever turn came first, K3's offer is kept: on the member's K2 (the tap first) or on Ben (the pass first, and
        // the tap then refused, the key it checked no longer on offer). Never K3 pinned, never the offer lost.
        expect(pinOf(ana, dm.id)).toMatchObject(moved
            ? { peer: k2.publicKey, by: 'member', former: [ben.publicKey], offered: { peer: k3.publicKey } }
            : { peer: ben.publicKey, offered: { peer: k3.publicKey } });
        expect(await send('Between passes')).toBe('DmKeyChangedError');
        expect(node.lines.filter((l) => l.authorPubkey === ana.publicKey && (reads(k3, l) ?? reads(puppet, l)) !== null)).toEqual([]);
    });

    it('photos after "Continue": the former key opens Ben\'s and Ana\'s old photos, and nothing opens one the node put in anyone else\'s name', async () => {
        await phoneOf(ana);
        await says(ana, dm, 'Shall I cancel the order?');
        await sendImageMessage(dm.id, 'data:image/jpeg;base64,QU5BUw==', '');
        const anaPhoto = node.lines[node.lines.length - 1];
        await phoneOf(ben);
        await says(ben, dm, 'No');
        await sendImageMessage(dm.id, 'data:image/jpeg;base64,QkVOUw==', '');
        const benPhoto = node.lines[node.lines.length - 1];
        const k2 = person('Ben (new phone)');
        dm.participants = [ana.publicKey, k2.publicKey];
        for (const l of node.lines) if (l.authorPubkey === ben.publicKey) l.authorPubkey = k2.publicKey;
        await phoneOf(ana);
        expect(await acceptOfferedPeer(dm.id, k2.publicKey)).toBe(true);
        const open = async (line: Line, author?: string) => {
            if (author) sql.prepare('UPDATE messages SET author_pubkey = ? WHERE id = ?').run(author, line.id);
            fs.rmSync(`${h.cacheDir}/chat-images`, { recursive: true, force: true });
            return (await getDecryptedAttachment(dm.id, line.id)) ? fs.readFileSync(`${h.cacheDir}/chat-images/${line.id}.jpg`, 'utf8') : null;
        };
        expect({ ben: await open(benPhoto), ana: await open(anaPhoto), benAsOld: await open(benPhoto, ben.publicKey) }).toEqual({ ben: 'QkVOUw==', ana: 'QU5BUw==', benAsOld: 'QkVOUw==' });
        expect([await open(benPhoto, puppet.publicKey), await open(benPhoto, ana.publicKey), await open(anaPhoto, k2.publicKey), await open(anaPhoto, ben.publicKey)])
            .toEqual([null, null, null, null]);
    });
});
