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

import { getDb, getMessages, syncMessages, syncSingleConversation, insertMessage, editMessage, sendImageMessage, getDecryptedAttachment, getConversations, getConversationKind, getConversation, isHeldGroupChat, knownDmConversationId, groupScreenKeyringFor, isDmKeyChangePending } from '../db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { refusedSendNotice } from '../dm-lock';
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
import { toEd25519Pkcs8 } from '@beanpool/core';
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
interface Conv { id: string; type: string; participants: string[] }
const node = {
    lines: [] as Line[],
    convs: [] as Conv[],
    photos: new Map<string, { data: string; nonce: string }>(),
    /** The node answering every send 503 (a phone's send then stays on it as failed). */
    refuseSends: false,
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
            conversations: mine.map((c) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-10-01T00:00:00.000Z' })),
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
        const lines = node.lines.filter((l) => l.conversationId === conv.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        return answer(200, { conversation: { id: conv.id, type: conv.type, participants: conv.participants }, messages: lines.slice(-50).map((l) => ({ ...l })) });
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
    Object.assign(node, { lines: [], convs: [dm], photos: new Map(), refuseSends: false });
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

    it('P9: a sync pass over 1,000 conversations (30% not DMs) reads the pins once and writes them at most once', async () => {
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
        getItem.mockClear(); setItem.mockClear();
        await syncMessages(ana.publicKey);
        expect(counts()).toEqual({ gets: 1, sets: 1 });   // 700 DMs pinned at first sight, in one write
        expect(Object.keys(JSON.parse(h.store.get(PINS(ana))!)).length).toBe(701);   // and Ana and Ben's DM from beforeEach
        getItem.mockClear(); setItem.mockClear();
        await syncMessages(ana.publicKey);
        expect(counts()).toEqual({ gets: 1, sets: 0 });   // nothing changed: read once, not written
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

    it('a pin lost to a write made from an older copy of the store is taken again from the phone\'s rows, not the next listing', async () => {
        await aQuestionAndAnAnswer();
        const dan = person('Dan');
        const dm2: Conv = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, dan.publicKey] };
        node.convs = [dm, dm2];
        await phoneOf(ana);
        h.store.delete(PINS(ana));
        const setItem = vi.mocked(AsyncStorage.setItem);
        const real = setItem.getMockImplementation()!;
        let syncWrote!: () => void;
        const syncWrite = new Promise<void>((r) => { syncWrote = r; });
        setItem.mockImplementation(async (k: string, v: string) => {
            if (k === PINS(ana)) {
                const ids = Object.keys(JSON.parse(v));
                if (ids.length === 1 && ids[0] === dm2.id) await syncWrite;   // the screen's write, from the copy it read first
                else { await real(k, v); syncWrote(); return; }
            }
            return real(k, v);
        });
        try { await Promise.all([getMessages(dm2.id), syncMessages(ana.publicKey)]); } finally { setItem.mockImplementation(real); }
        dm.participants = [ana.publicKey, puppet.publicKey];
        puppetSays(dm, 'New phone. What is the code?');
        await syncMessages(ana.publicKey);
        expect(pinOf(ana, dm.id)).toMatchObject({ peer: ben.publicKey });
        expect(await sendTo(dm.id, 'The code is 4821')).toEqual({ err: 'DmKeyChangedError', puppetRead: false });
    });

    it('the send is the first key resolve for an unpinned DM (the post screen\'s decline message): a first sight none of the thread opens under is refused', async () => {
        await aQuestionAndAnAnswer();
        dm.type = 'group_thread';   // listed as a group's chat, so the sync pins nothing; its encrypted lines keep it a DM
        dm.participants = [ana.publicKey, puppet.publicKey];
        h.store.delete(PINS(ana));
        h.store.delete('beanpool_dm_conversations_seen');
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
});
