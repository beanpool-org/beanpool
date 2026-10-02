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

import { getDb, getMessages, syncMessages, syncSingleConversation, insertMessage, editMessage, sendImageMessage, getDecryptedAttachment, getConversations, getConversationKind } from '../db';
import { dmQuoteFor } from '../chat-actions';
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
