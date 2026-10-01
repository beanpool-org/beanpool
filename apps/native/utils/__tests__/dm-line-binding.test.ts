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

import { getDb, getMessages, syncMessages, insertMessage, editMessage, sendImageMessage, getDecryptedAttachment, getConversations } from '../db';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
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
interface Conv { id: string; type: 'dm'; participants: string[] }
const node = {
    lines: [] as Line[],
    convs: [] as Conv[],
    photos: new Map<string, { data: string; nonce: string }>(),
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

/** Pick up a phone: everything another phone left in the database goes, and this one syncs from the node. */
async function phoneOf(who: Person): Promise<void> {
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    fs.rmSync(`${h.cacheDir}/chat-images`, { recursive: true, force: true });
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
    Object.assign(node, { lines: [], convs: [dm], photos: new Map() });
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

    it('still open and show as before; one the node replays after its sender\'s app moved on is marked', async () => {
        const seeYou = oldLine(ana, ben, 'see you at 6');
        const ok = oldLine(ben, ana, 'ok');
        await phoneOf(ana);
        const here = await says(ana, dm, "I'm here");
        const replay = { ...seeYou, id: randomUUID(), timestamp: tick() };
        node.lines.push(replay);
        const bensOld = oldLine(ben, ana, 'on my way');   // Ben is still on an old app: his lines are as they always were

        await phoneOf(ben);
        expect(await shows(dm)).toEqual([
            { id: seeYou.id, from: ana.publicKey, text: 'see you at 6', note: null },
            { id: ok.id, from: ben.publicKey, text: 'ok', note: null },
            { id: here.id, from: ana.publicKey, text: "I'm here", note: null },
            { id: replay.id, from: ana.publicKey, text: 'see you at 6', note: "Sent from an older version of the app: who sent it can't be confirmed." },
            { id: bensOld.id, from: ben.publicKey, text: 'on my way', note: null },
        ]);
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
