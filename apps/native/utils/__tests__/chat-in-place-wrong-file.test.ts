/**
 * Slice S2 (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §6): a direct chat of another community this phone
 * holds is read and answered there in place, with no switch. Every in-place action lands in the file and on the server of
 * the community it was asked of, and never in another's, whatever happens while it is on its way.
 *
 * One table (close the class): each in-place action (read, reply, react, edit, delete, mark read, mute, a new chat, a
 * line arriving) x each thing that can happen meanwhile (nothing, a switch to another community, a switch onto that very
 * community, that community removed from the phone, the account leaving the phone, the app killed). The phone is set to B;
 * the chat lives in A (the away community). B's file starts as a copy of A's, so a write by id (an edit, a delete, a
 * reaction, a read mark) into the wrong file would show; B's copy of the other person's line is spoiled, so a read that
 * reached B's file would show it unopened. Each row asserts:
 * - every chat request the action made went to A's own server (signed for its name);
 * - B's file, B's DM pins and guard list, and any third copy are exactly as they were when the answer landed;
 * - with nothing happening meanwhile, the action's effect is in A's file (and the copy open in place closes as the chat is
 *   left); after a switch onto A itself, it is in A's file too (through the copy in use, the same file);
 * - after a closer (switch, removal, the account leaving, the app killed), the copy open in place is closed at once, and a
 *   removed copy is never made again;
 * - the app killed: on the next start, the chat's poll in place brings A's server's word into A's file, never B's.
 *
 * Then the DM key-pin gate (the dm-line-binding rows' rules, utils/__tests__/dm-line-binding.test.ts), for a chat in place:
 * the pins read and written are A's own file's, a verified person's key change pauses its sends, an unverified one's
 * carries on with one notice there, unreadable pins refuse a send with nothing written or sent, and B's pins never decide
 * anything of A's chat.
 *
 * Real SQLite files on disk (node:sqlite, in a directory of this test's own), the real database open, the real DM pins,
 * real DM sealing between real keys; the node is a stand-in that answers as routes/messaging.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const h = vi.hoisted(() => ({
    dir: '',
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
    /** The next native close of this file waits for `release` (a close still running, as a phone's can for a while). */
    closeHold: null as null | { file: string; started: () => void; release: Promise<void> },
}));

/** expo-sqlite over node:sqlite, one real file per name in this test's directory, as expo-sqlite opens them in its own. */
vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            return {
                runAsync: async (q: string, p?: unknown) => {
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                execAsync: async (q: string) => { sql.exec(q); },
                getAllAsync: async (q: string, p?: unknown) => sql.prepare(q).all(...params(p)),
                getFirstAsync: async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null,
                withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
                closeAsync: async () => {
                    const held = h.closeHold;
                    if (held && held.file === name) {
                        h.closeHold = null;
                        held.started();
                        await held.release;
                    }
                    sql.close();
                },
            };
        }),
    };
});
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        get cacheDirectory() { return `file://${h.dir}/cache/`; },
        get documentDirectory() { return `file://${h.dir}/doc/`; },
        EncodingType: { Base64: 'base64' },
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)), size: 0 })),
        moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => { nodeFs.renameSync(local(from), local(to)); }),
        copyAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => { nodeFs.copyFileSync(local(from), local(to)); }),
        deleteAsync: vi.fn(async (uri: string) => { nodeFs.rmSync(local(uri), { force: true, recursive: true }); }),
        makeDirectoryAsync: vi.fn(async (uri: string) => { nodeFs.mkdirSync(local(uri), { recursive: true }); }),
        writeAsStringAsync: vi.fn(async (uri: string, data: string) => { nodeFs.writeFileSync(local(uri), data); }),
        readAsStringAsync: vi.fn(async (uri: string) => (nodeFs.existsSync(local(uri)) ? nodeFs.readFileSync(local(uri), 'utf8') : '')),
        readDirectoryAsync: vi.fn(async (uri: string) => (nodeFs.existsSync(local(uri)) ? nodeFs.readdirSync(local(uri)) : [])),
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
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { removeCommunityCaches } from '../community-cache';
import { getDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { openDmLine, sealDmLine } from '../e2e-crypto';
import { dmPeerPinsStoreKey } from '../storage-keys';

// A finished sync ends with require('react-native') for a DeviceEventEmitter nudge: answered at node's loader for the file.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-chat-in-place-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** A: where the chat lives (away). B: the community the phone is set to. C: a third, the phone switches to. */
const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const C = 'https://brookside.example';
const A_FILE = getDatabaseFilenameForNode(A);
const B_FILE = getDatabaseFilenameForNode(B);
const C_FILE = getDatabaseFilenameForNode(C);
const ANCHOR = 'beanpool_anchor_url';
const CHAT_TABLES = ['conversations', 'conversation_participants', 'messages', 'groups', 'group_members'];

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── The node ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Line { id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string; type: string; metadata: string | null; timestamp: string; editedAt: string | null }
interface Conv { id: string; type: string; participants: string[] }
const node = { convs: [] as Conv[], lines: [] as Line[] };
let clock = Date.parse('2026-11-19T00:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();
/** Every request the phone made, in order: method, URL. */
let asked: Array<{ method: string; url: string }> = [];

interface Hold { matches: (method: string, pathname: string) => boolean; url: string | null; seen: Promise<void>; release: () => void; seenNow: () => void; released: Promise<void> }
let hold: Hold | null = null;
function holdFor(matches: Hold['matches']): Hold {
    let seenNow!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((r) => { seenNow = r; });
    const released = new Promise<void>((r) => { release = r; });
    return { matches, url: null, seen, seenNow, release, released };
}

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const view = (c: Conv) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-11-19T00:00:00.000Z' });

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    asked.push({ method, url });
    if (hold && !hold.url && hold.matches(method, u.pathname)) {
        hold.url = url;
        hold.seenNow();
        await hold.released;
    }
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'POST' && u.pathname === '/api/messages/send') {
        const line: Line = { id: body.id, conversationId: body.conversationId, authorPubkey: body.authorPubkey, ciphertext: body.ciphertext, nonce: body.nonce, type: body.type || 'text', metadata: body.metadata ?? null, timestamp: tick(), editedAt: null };
        node.lines.push(line);
        return answer(200, { success: true, message: line });
    }
    if (method === 'POST' && u.pathname === '/api/messages/edit') return answer(200, { success: true, message: { id: body.messageId, editedAt: tick() } });
    if (method === 'POST' && u.pathname === '/api/messages/delete') {
        return answer(200, { success: true, message: { id: body.messageId, ciphertext: 'gone', metadata: { removed: true, removedBy: h.me.publicKey, removedAt: tick() } } });
    }
    if (method === 'POST' && u.pathname === '/api/messages/react') return answer(200, { success: true });
    if (method === 'POST' && u.pathname === '/api/messages/mark-read') return answer(200, { success: true });
    if (method === 'POST' && u.pathname === '/api/messages/mute') return answer(200, { success: true, mute: { conversationId: body.conversationId, mutedUntil: '2026-11-20T08:00:00.000Z', always: false } });
    if (method === 'POST' && u.pathname === '/api/messages/conversation') {
        const conv: Conv = { id: randomUUID(), type: 'dm', participants: body.participants };
        node.convs.push(conv);
        return answer(200, { conversation: view(conv) });
    }
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        return answer(200, { conversations: node.convs.filter((c) => c.participants.includes(list[1])).map(view), totalUnread: 0, deletedAccounts: [], requests: { count: 0, conversations: [] } });
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page && method === 'GET') {
        const conv = node.convs.find((c) => c.id === decodeURIComponent(page[1]));
        if (!conv) return answer(404, { error: 'Conversation not found' });
        return answer(200, { conversation: view(conv), messages: node.lines.filter((l) => l.conversationId === conv.id).map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

function nodeLine(conv: Conv, author: Person, text: string): Line {
    const other = conv.participants.find((p) => p !== author.publicKey)!;
    const id = randomUUID();
    const { ciphertext, nonce } = sealDmLine(text, { myEdPrivHex: author.privateKey, peerEdPubHex: other, conversationId: conv.id }, { senderPubHex: author.publicKey, messageId: id });
    const line: Line = { id, conversationId: conv.id, authorPubkey: author.publicKey, ciphertext, nonce, type: 'text', metadata: null, timestamp: tick(), editedAt: null };
    node.lines.push(line);
    return line;
}

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

let me: Person;
let peer: Person;
let third: Person;
let dm: Conv;
/** A line of mine in the DM, in both files: what an edit, a delete and a reaction change. */
let mine: string;
let phoneN = 0;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const PEER_WORDS = 'hello from the other side';

const fileOn = (file: string) => path.join(h.dir, file);
function rowsOf(file: string): Record<string, unknown[]> | null {
    if (!fs.existsSync(fileOn(file))) return null;
    const sql = new DatabaseSync(fileOn(file));
    try {
        const out: Record<string, unknown[]> = {};
        for (const t of CHAT_TABLES) out[t] = sql.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...(r as object) }));
        return out;
    } finally {
        sql.close();
    }
}
const storedFor = (file: string) => Object.fromEntries([...h.store.entries()].filter(([k]) => k.includes(file)).sort());

/**
 * A phone that synced its DM with `peer` in A (pinned there) and holds a line of the peer's and one of its own, then was
 * set to B, whose file is a copy of A's (the same ids), with the peer's line spoiled there. A is now the away community.
 */
async function phoneOnBWithAAway(): Promise<void> {
    await db.closeDB();
    db._resetDmPeerPinsForTests();
    // A new phone: no chat held or left in place yet (the marks are this run's memory, by file).
    db._resetChatsInPlaceForTests();
    h.closeHold = null;
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(ANCHOR, A);
    me = person();
    peer = person();
    third = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    dm = { id: randomUUID(), type: 'dm', participants: [me.publicKey, peer.publicKey] };
    node.convs = [dm];
    node.lines = [];
    nodeLine(dm, peer, PEER_WORDS);
    hold = null;
    (globalThis as any).fetch = fetchMock;

    expect(await db.syncMessages(me.publicKey)).toBe(true);
    mine = await db.insertMessage(dm.id, me.publicKey, 'my own words');
    await settle();
    expect(rowsOf(A_FILE)!.messages.length).toBe(2);
    await db.closeDB();
    fs.copyFileSync(fileOn(A_FILE), fileOn(B_FILE));
    const spoil = new DatabaseSync(fileOn(B_FILE));
    spoil.prepare('UPDATE messages SET ciphertext = ? WHERE author_pubkey = ?').run('spoiled in B', peer.publicKey);
    spoil.close();
    await switchPhoneTo(B);
    expect(h.store.get(ANCHOR)).toBe(B);
    asked = [];
}

interface Act {
    name: string;
    /** The request whose answer is held while something happens (null: the action asks no server). */
    held: ((method: string, pathname: string) => boolean) | null;
    before?: () => void;
    act: () => Promise<unknown>;
    /** The action's effect, as A's file and its result show it. */
    landed: (a: Record<string, any[]>, result: any) => boolean;
}

const ACTS: Act[] = [
    {
        name: 'read (getMessages)', held: null,
        act: () => db.getMessages(dm.id, { community: A, notices: true }),
        landed: (_a, r) => Array.isArray(r) && r.some((m: any) => m.text === PEER_WORDS) && r.some((m: any) => m.text === 'my own words'),
    },
    {
        name: 'reply (insertMessage and its delivery)',
        held: (m, p) => m === 'POST' && p === '/api/messages/send',
        act: () => db.insertMessage(dm.id, me.publicKey, 'a reply in place', undefined, undefined, undefined, A),
        landed: (a, id) => a.messages.some((m: any) => m.id === id && !String(m.metadata ?? '').includes('__sendState')),
    },
    {
        name: 'react (toggleMessageReactionApi)',
        held: (m, p) => m === 'POST' && p === '/api/messages/react',
        act: () => db.toggleMessageReactionApi(mine, me.publicKey, '👍', A),
        landed: (a) => String(a.messages.find((m: any) => m.id === mine)?.metadata ?? '').includes('👍'),
    },
    {
        name: 'edit (editMessage)',
        held: (m, p) => m === 'POST' && p === '/api/messages/edit',
        act: () => db.editMessage(dm.id, mine, 'my words, edited in place', A),
        landed: (a) => !!a.messages.find((m: any) => m.id === mine)?.edited_at,
    },
    {
        name: 'delete (deleteMessageApi)',
        held: (m, p) => m === 'POST' && p === '/api/messages/delete',
        act: () => db.deleteMessageApi(mine, A),
        landed: (a) => a.messages.find((m: any) => m.id === mine)?.type === 'removed',
    },
    {
        name: 'mark read (markConversationRead)',
        held: (m, p) => m === 'POST' && p === '/api/messages/mark-read',
        act: () => db.markConversationRead(dm.id, me.publicKey, A),
        landed: (a) => !!a.conversation_participants.find((r: any) => r.conversation_id === dm.id && r.public_key === me.publicKey)?.last_read_at,
    },
    {
        name: 'mute (muteChatApi)',
        held: (m, p) => m === 'POST' && p === '/api/messages/mute',
        act: () => db.muteChatApi(dm.id, '8h', A),
        landed: () => db.getKnownChatMute(dm.id)?.mutedUntil === '2026-11-20T08:00:00.000Z',
    },
    {
        name: 'a new chat (createConversationApi)',
        held: (m, p) => m === 'POST' && p === '/api/messages/conversation',
        act: () => db.createConversationApi('dm', [me.publicKey, third.publicKey], me.publicKey, undefined, undefined, A),
        landed: (a, conv) => a.conversations.some((c: any) => c.id === conv?.id),
    },
    {
        name: 'a line arriving while open (syncSingleConversation)',
        held: (m, p) => m === 'GET' && p === `/api/messages/${dm.id}`,
        before: () => { arrived = nodeLine(dm, peer, 'arrived while open in place').id; },
        act: () => db.syncSingleConversation(dm.id, A),
        landed: (a) => a.messages.some((m: any) => m.id === arrived),
    },
];
let arrived = '';

/** What can happen while an action is on its way. `closes`: it closes the copy open in place. `removesA`: A's copy goes. */
const MEANWHILE: Record<string, { run: (() => Promise<void>) | null; closes: boolean; removesA: boolean }> = {
    'nothing': { run: null, closes: false, removesA: false },
    'a switch to another community': { run: async () => { await switchPhoneTo(C); }, closes: true, removesA: false },
    'a switch onto that very community': { run: async () => { await switchPhoneTo(A); }, closes: true, removesA: false },
    'that community removed from the phone': { run: async () => { await removeCommunityCaches([A]); }, closes: true, removesA: true },
    'the account leaving the phone': {
        run: async () => { await db.clearDB({ identityLeaves: true }); await removeCommunityCaches([A, B], { everyCopy: true }); },
        closes: true, removesA: true,
    },
    'the app killed': { run: async () => { await db.closeDB(); db._resetDmPeerPinsForTests(); }, closes: true, removesA: false },
};

beforeEach(async () => {
    await phoneOnBWithAAway();
});

describe('a chat in place: every action lands in the file and on the server of the community asked, never another', () => {
    const cases = ACTS.flatMap((a) => Object.keys(MEANWHILE).map((w) => [a.name, w, a] as const));
    it.each(cases)('%s, with %s meanwhile', async (_name, whatName, row) => {
        const what = MEANWHILE[whatName];
        // The chat is open in place: its copy is open, and B is the community in use.
        expect((await db.getMessages(dm.id, { community: A })).some((m: any) => m.text === PEER_WORDS)).toBe(true);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        row.before?.();
        asked = [];
        if (row.held) hold = holdFor(row.held);
        let result: unknown;
        let thrown: unknown = null;
        const running = row.act().then((r) => { result = r; }, (e) => { thrown = e; });
        if (hold) await hold.seen;
        else await running;

        if (what.run) await what.run();
        await settle();
        if (what.closes && row.held) expect(db.heldCopyFiles(), 'the copy open in place closed at once').not.toContain(A_FILE);
        const others = { B: rowsOf(B_FILE), C: rowsOf(C_FILE), storedB: storedFor(B_FILE), storedC: storedFor(C_FILE) };

        hold?.release();
        await running;
        await settle();

        // Every chat request went to A's own server.
        const chat = asked.filter((r) => new URL(r.url).pathname.startsWith('/api/messages'));
        if (row.held) expect(chat.length, 'the action asked its server').toBeGreaterThan(0);
        for (const r of chat) expect(new URL(r.url).origin, `${r.method} ${new URL(r.url).pathname}`).toBe(A);
        // Nothing of it in any other community's file or stored state.
        expect({ B: rowsOf(B_FILE), C: rowsOf(C_FILE), storedB: storedFor(B_FILE), storedC: storedFor(C_FILE) }).toEqual(others);

        if (whatName === 'nothing' || whatName === 'a switch onto that very community') {
            expect(thrown, String((thrown as any)?.message ?? '')).toBeNull();
            expect(row.landed(rowsOf(A_FILE) as any, result), 'its effect is in A\'s file').toBe(true);
        }
        if (whatName === 'nothing') {
            await db.leaveChatInPlace(A);
            expect(db.heldCopyFiles(), 'left, the copy open in place closes').not.toContain(A_FILE);
            expect(rowsOf(B_FILE)).toEqual(others.B);
        }
        if (what.removesA) {
            expect(fs.existsSync(fileOn(A_FILE)), 'a removed copy is never made again').toBe(false);
            expect(db.heldCopyFiles()).not.toContain(A_FILE);
        }
        if (whatName === 'the app killed') {
            // The next start, set to B again: the chat's poll in place brings A's server's word into A's file only.
            hold = null;
            await db.getDb();
            const bAfter = rowsOf(B_FILE);
            expect(await db.syncSingleConversation(dm.id, A)).toBe(true);
            await settle();
            const inA = rowsOf(A_FILE)!.messages as any[];
            for (const l of node.lines) expect(inA.filter((m) => m.id === l.id).length, `${l.id.slice(0, 8)} once in A`).toBe(1);
            expect(inA.some((m) => String(m.metadata ?? '').includes('"__sendState":"sending"'))).toBe(false);
            expect(rowsOf(B_FILE)).toEqual(bAfter);
            await db.leaveChatInPlace(A);
        }
    });

    it('a line the other person sends is read in place from A\'s own copy with A\'s pins: B\'s spoiled copy is never read', async () => {
        nodeLine(dm, peer, 'a second line, read in place');
        expect(await db.syncSingleConversation(dm.id, A)).toBe(true);
        const lines = await db.getMessages(dm.id, { community: A });
        expect(lines.map((m: any) => m.text)).toEqual(expect.arrayContaining([PEER_WORDS, 'my own words', 'a second line, read in place']));
        expect(lines.every((m: any) => !m.integrityNote)).toBe(true);
        // B, the community in use, reads its own copy: the spoiled line, unopened.
        const inB = await db.getMessages(dm.id);
        expect(inB.some((m: any) => m.text === PEER_WORDS)).toBe(false);
        await db.leaveChatInPlace(A);
    });

    it('a reply in place opens for the other person in A, under A\'s chat, from me', async () => {
        const id = await db.insertMessage(dm.id, me.publicKey, 'can you read this?', undefined, undefined, undefined, A);
        await settle();
        const sent = node.lines.find((l) => l.id === id)!;
        expect(sent).toBeTruthy();
        const opened = openDmLine({ ciphertext: sent.ciphertext, nonce: sent.nonce }, { myEdPrivHex: peer.privateKey, peerEdPubHex: me.publicKey },
            { conversationId: dm.id, senderPubHex: me.publicKey, messageId: id, part: 'body', metadata: sent.metadata });
        expect(opened.text).toBe('can you read this?');
        await db.leaveChatInPlace(A);
    });

    it('no copy to open in place (a community the phone does not hold, or one never made here): refused, nothing asked, no file made', async () => {
        for (const where of ['https://elsewhere.example', C]) {
            asked = [];
            await expect(db.insertMessage(dm.id, me.publicKey, 'nowhere', undefined, undefined, undefined, where)).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
            expect(asked).toEqual([]);
            expect(fs.existsSync(fileOn(getDatabaseFilenameForNode(where)))).toBe(false);
        }
    });

    it('a copy on the phone of a community it does not keep, or keeps only as a guest\'s look: never opened in place, nothing asked', async () => {
        const unsaved = 'https://unsaved.example';
        fs.copyFileSync(fileOn(A_FILE), fileOn(getDatabaseFilenameForNode(unsaved)));
        h.store.set('beanpool_guest_nodes', JSON.stringify([A]));
        for (const where of [unsaved, A]) {
            asked = [];
            const before = rowsOf(getDatabaseFilenameForNode(where));
            await expect(db.insertMessage(dm.id, me.publicKey, 'not here', undefined, undefined, undefined, where)).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
            expect(asked).toEqual([]);
            expect(rowsOf(getDatabaseFilenameForNode(where))).toEqual(before);
            expect(db.heldCopyFiles()).not.toContain(getDatabaseFilenameForNode(where));
        }
    });

    it('a page naming a request for me (requests in place are slice S3): nothing of the request is written into A\'s copy', async () => {
        // My row in A's chat gone (as for a request that reached a phone before its people did), and the node naming the request.
        const sql = new DatabaseSync(fileOn(A_FILE));
        sql.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').run(dm.id, me.publicKey);
        sql.close();
        const page = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init: any = {}) => {
            const res: any = await page(url, init);
            if (new URL(url).pathname !== `/api/messages/${dm.id}`) return res;
            const body = await res.json();
            body.conversation.request = { from: peer.publicKey, state: 'pending', at: tick() };
            return answer(200, body);
        });
        try {
            await db.syncSingleConversation(dm.id, A);
            const people = (rowsOf(A_FILE)!.conversation_participants as any[]).filter((r) => r.conversation_id === dm.id).map((r) => r.public_key);
            expect(people).not.toContain(me.publicKey);
        } finally {
            fetchMock.mockImplementation(page);
            await db.leaveChatInPlace(A);
        }
    });

    it('the community in use named as the chat\'s: the chat goes on through the copy in use, as before', async () => {
        await switchPhoneTo(A);
        const id = await db.insertMessage(dm.id, me.publicKey, 'set there', undefined, undefined, undefined, A);
        await settle();
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
        expect((rowsOf(A_FILE)!.messages as any[]).some((m) => m.id === id)).toBe(true);
        expect(asked.filter((r) => r.url.includes('/api/messages/send')).every((r) => new URL(r.url).origin === A)).toBe(true);
    });
});

// ── Leaving a chat in place keeps its copy closed (#3305 review) ────────────────────────────────────────────────────

/**
 * What can be on its way as the chat is left (its focus effect's cleanup, leaveChatInPlace): each is begun with the chat
 * held in place (enterChatInPlace), and its request held at the node (or, for a read, its first step done), when the chat
 * is left. `rest` is what is still to come of it once the chat is left (a read's next steps), asked by the same caller.
 */
const ON_ITS_WAY: Array<{ name: string; held: ((method: string, pathname: string) => boolean) | null; start: () => Promise<unknown>; rest?: () => Promise<unknown> }> = [
    {
        // The reviewer's measured sequence, kept: a poll whose GET is still at the node.
        name: 'a poll (its page still on its way)',
        held: (m, p) => m === 'GET' && p === `/api/messages/${dm.id}`,
        start: () => db.syncSingleConversation(dm.id, A),
    },
    {
        name: 'a read mid-flight (loadMessages: the key check done, the code and the thread still to read)',
        held: null,
        start: () => db.getDmKeyChange(dm.id, A),
        rest: async () => { await db.getDmKeyCodeInfo(dm.id, A); await db.getMessages(dm.id, { community: A, notices: true }); },
    },
    {
        name: 'a mark read (its push to the node still on its way)',
        held: (m, p) => m === 'POST' && p === '/api/messages/mark-read',
        start: () => db.markConversationRead(dm.id, me.publicKey, A),
    },
    {
        name: 'a reply (its send still on its way)',
        held: (m, p) => m === 'POST' && p === '/api/messages/send',
        start: () => db.insertMessage(dm.id, me.publicKey, 'sent as the chat was left', undefined, undefined, undefined, A),
    },
];

/**
 * What follows on the screen once a poll or a push lands (loadConversationData, loadMessages: the key check, the key code,
 * the thread, the mark read), and every other in-place action a caller outside the screen could still ask: each is refused
 * (NoCopyInPlaceError) with nothing opened and nothing asked, until a screen holds the chat again.
 */
const AFTER_LEAVING: Array<[string, () => Promise<unknown>]> = [
    ['getConversation', () => db.getConversation(dm.id, me.publicKey, A)],
    ['getDmKeyChange', () => db.getDmKeyChange(dm.id, A)],
    ['getDmKeyCodeInfo', () => db.getDmKeyCodeInfo(dm.id, A)],
    ['getMessages', () => db.getMessages(dm.id, { community: A, notices: true })],
    ['markConversationRead', () => db.markConversationRead(dm.id, me.publicKey, A)],
    ['syncSingleConversation (the next poll, or a push\'s)', () => db.syncSingleConversation(dm.id, A)],
    ['insertMessage', () => db.insertMessage(dm.id, me.publicKey, 'after leaving', undefined, undefined, undefined, A)],
    ['toggleMessageReactionApi', () => db.toggleMessageReactionApi(mine, me.publicKey, '👍', A)],
    ['editMessage', () => db.editMessage(dm.id, mine, 'edited after leaving', A)],
    ['deleteMessageApi', () => db.deleteMessageApi(mine, A)],
    ['muteChatApi', () => db.muteChatApi(dm.id, '8h', A)],
    ['markDmPeerVerified (the key code screen)', () => db.markDmPeerVerified(dm.id, peer.publicKey, A)],
];

describe('a chat in place, left: its copy stays closed and its community is asked nothing until the chat is back (#3305 review)', () => {
    it.each(ON_ITS_WAY.map((w) => [w.name, w] as const))('%s as the chat is left: nothing after it opens the copy or asks A anything', async (_name, way) => {
        db.enterChatInPlace(A);
        expect((await db.getMessages(dm.id, { community: A })).some((m: any) => m.text === PEER_WORDS)).toBe(true);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        // A line the node has that A's file doesn't yet: written by nothing still on its way once the chat is left.
        const late = nodeLine(dm, peer, 'arrived as the chat was left').id;
        if (way.held) hold = holdFor(way.held);
        let thrown: unknown = null;
        const running = way.start().then(() => {}, (e) => { thrown = e; });
        if (hold) await hold.seen;
        else await running;

        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles(), 'left, the copy open in place is closed').not.toContain(A_FILE);
        asked = [];
        const aBefore = rowsOf(A_FILE);
        const others = { B: rowsOf(B_FILE), storedB: storedFor(B_FILE) };
        hold?.release();
        await running;
        if (way.rest) await expect(way.rest()).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
        await settle();
        expect(db.heldCopyFiles(), 'what was on its way opened nothing again').not.toContain(A_FILE);

        for (const [what, call] of AFTER_LEAVING) {
            // Refused before anything is opened or asked; a poll says so as every failed poll does (false, quietly).
            if (what.startsWith('syncSingleConversation')) expect(await call(), what).toBe(false);
            else await expect(call(), what).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
            await settle();
            expect(db.heldCopyFiles(), `${what} opened nothing`).not.toContain(A_FILE);
        }
        // Not one request after the leave, to A or anywhere; nothing written into A's file since, nor B's.
        expect(asked).toEqual([]);
        expect(rowsOf(A_FILE)!.messages.some((m: any) => m.id === late)).toBe(false);
        expect(rowsOf(A_FILE)).toEqual(aBefore);
        expect({ B: rowsOf(B_FILE), storedB: storedFor(B_FILE) }).toEqual(others);
        void thrown;

        // Back in the chat: its copy opens again, and its poll brings what the node had meanwhile into A's file.
        hold = null;
        db.enterChatInPlace(A);
        expect(await db.syncSingleConversation(dm.id, A)).toBe(true);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        expect(rowsOf(A_FILE)!.messages.some((m: any) => m.id === late)).toBe(true);
        expect((await db.getMessages(dm.id, { community: A })).some((m: any) => m.text === 'arrived as the chat was left')).toBe(true);
        expect(asked.filter((r) => new URL(r.url).pathname.startsWith('/api/messages')).every((r) => new URL(r.url).origin === A)).toBe(true);
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });

    it('Key code opens while the chat\'s close is still running: it waits for that close and reads A\'s pins, no refusal', async () => {
        db.enterChatInPlace(A);
        await db.getMessages(dm.id, { community: A });
        let started!: () => void;
        let release!: () => void;
        const closing = new Promise<void>((r) => { started = r; });
        h.closeHold = { file: A_FILE, started: () => started(), release: new Promise<void>((r) => { release = r; }) };
        // Chat -> Key code: the chat is covered and lets go first; its close runs (held here at the native close).
        const chatLet = db.leaveChatInPlace(A);
        await closing;
        // The key code screen shows: it holds the chat, then reads.
        db.enterChatInPlace(A);
        let info: any = 'not yet';
        let thrown: unknown = null;
        const reading = db.getDmKeyCodeInfo(dm.id, A).then((i) => { info = i; }, (e) => { thrown = e; });
        await settle();
        expect(info, 'it waits for the close under way').toBe('not yet');
        expect(thrown).toBeNull();
        release();
        await chatLet;
        await reading;
        expect(thrown, String((thrown as any)?.message ?? '')).toBeNull();
        expect(info?.peer).toBe(peer.publicKey);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        // Back to the chat: it holds again, Key code lets go: the copy stays open for the chat, and closes as it is left.
        db.enterChatInPlace(A);
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        expect((await db.getMessages(dm.id, { community: A })).some((m: any) => m.text === PEER_WORDS)).toBe(true);
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });

    it('Key code holds the chat before it is let go (the other order): the copy is never closed, and reads on', async () => {
        db.enterChatInPlace(A);
        await db.getMessages(dm.id, { community: A });
        db.enterChatInPlace(A);
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        expect((await db.getDmKeyCodeInfo(dm.id, A))?.peer).toBe(peer.publicKey);
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });

    it('a read asked while the close runs, by nothing that holds the chat: it waits, then is refused, and nothing opens', async () => {
        db.enterChatInPlace(A);
        await db.getMessages(dm.id, { community: A });
        let started!: () => void;
        let release!: () => void;
        const closing = new Promise<void>((r) => { started = r; });
        h.closeHold = { file: A_FILE, started: () => started(), release: new Promise<void>((r) => { release = r; }) };
        const left = db.leaveChatInPlace(A);
        await closing;
        asked = [];
        const late = db.getMessages(dm.id, { community: A }).then(() => 'read', (e) => (db.isNoCopyInPlace(e) ? 'refused' : e));
        release();
        await left;
        expect(await late).toBe('refused');
        await settle();
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
        expect(asked).toEqual([]);
    });

    it('a leave with no hold (a caller that never entered) closes it and refuses it as well; one hold left, the other screen keeps it', async () => {
        await db.getMessages(dm.id, { community: A });
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
        await expect(db.getMessages(dm.id, { community: A })).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
        // Two holds (the chat and Contacts starting one there): one let go, the copy stays for the other.
        db.enterChatInPlace(A);
        db.enterChatInPlace(A);
        await db.getMessages(dm.id, { community: A });
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });

    it('a chat left in A refuses nothing of the community in use, nor of a third held community', async () => {
        db.enterChatInPlace(A);
        await db.getMessages(dm.id, { community: A });
        await db.leaveChatInPlace(A);
        // B, the community in use: as before, through its own copy.
        expect(Array.isArray(await db.getMessages(dm.id))).toBe(true);
        expect(Array.isArray(await db.getMessages(dm.id, { community: B }))).toBe(true);
        await db.markConversationRead(dm.id, me.publicKey, B);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });
});

// ── The DM key-pin gate, for a chat in place ────────────────────────────────────────────────────────────────────────

const pinsOf = (file: string) => h.store.get(dmPeerPinsStoreKey(me.publicKey, file));
const pinOf = (file: string): any => JSON.parse(pinsOf(file) ?? '{"pins":{}}').pins[dm.id.toLowerCase()] ?? JSON.parse(pinsOf(file) ?? '{"pins":{}}').pins[dm.id];

describe('a chat in place keeps its own community\'s key pins, notices and pause (the dm-line-binding gate)', () => {
    it('the pin read and written is A\'s file\'s; B\'s pins say nothing of it', async () => {
        await db.getMessages(dm.id, { community: A });
        expect(pinOf(A_FILE)?.peer).toBe(peer.publicKey);
        const bBefore = pinsOf(B_FILE);
        await db.insertMessage(dm.id, me.publicKey, 'sealed to A\'s pin', undefined, undefined, undefined, A);
        await settle();
        expect(pinsOf(B_FILE)).toBe(bBefore);
        await db.leaveChatInPlace(A);
    });

    it('an unverified person re-keys in A: the poll in place hears it, one notice in A\'s chat, and the next line is sealed to the new key', async () => {
        const renewed = person();
        dm.participants = [me.publicKey, renewed.publicKey];
        const bBefore = pinsOf(B_FILE);
        expect(await db.syncSingleConversation(dm.id, A)).toBe(true);
        expect(await db.getDmKeyChange(dm.id, A)).toBeNull();
        const notices = (await db.getMessages(dm.id, { community: A, notices: true })).filter((m: any) => m.keyChangedNotice);
        expect(notices.length).toBe(1);
        expect(pinOf(A_FILE)?.peer).toBe(renewed.publicKey);
        const id = await db.insertMessage(dm.id, me.publicKey, 'to the new key', undefined, undefined, undefined, A);
        await settle();
        const sent = node.lines.find((l) => l.id === id)!;
        const opened = openDmLine({ ciphertext: sent.ciphertext, nonce: sent.nonce }, { myEdPrivHex: renewed.privateKey, peerEdPubHex: me.publicKey },
            { conversationId: dm.id, senderPubHex: me.publicKey, messageId: id, part: 'body', metadata: sent.metadata });
        expect(opened.text).toBe('to the new key');
        expect(pinsOf(B_FILE)).toBe(bBefore);
        // The copy in use (B) never heard it: its own chat is as it was.
        expect(await db.getDmKeyChange(dm.id)).toBeNull();
        await db.leaveChatInPlace(A);
    });

    it('a person marked verified in A re-keys: the chat in place pauses, the send is refused before anything is written or sent', async () => {
        expect(await db.markDmPeerVerified(dm.id, peer.publicKey, A)).toBe(true);
        expect(pinOf(B_FILE)?.verified ?? pinOf(B_FILE)?.verifiedAt ?? null).toBeFalsy();
        const renewed = person();
        dm.participants = [me.publicKey, renewed.publicKey];
        expect(await db.syncSingleConversation(dm.id, A)).toBe(true);
        const change = await db.getDmKeyChange(dm.id, A);
        expect(change?.offeredPeer).toBe(renewed.publicKey);
        expect(change?.verified).toBe(true);
        const linesBefore = (rowsOf(A_FILE)!.messages as any[]).length;
        asked = [];
        await expect(db.insertMessage(dm.id, me.publicKey, 'not to an unchecked key', undefined, undefined, undefined, A)).rejects.toMatchObject({ name: 'DmKeyChangedError' });
        expect((rowsOf(A_FILE)!.messages as any[]).length).toBe(linesBefore);
        expect(asked.filter((r) => r.url.includes('/api/messages/send'))).toEqual([]);
        // Continue with the new key, in place: the pin moves in A only.
        expect(await db.acceptOfferedPeer(dm.id, renewed.publicKey, A)).toBe(true);
        expect(pinOf(A_FILE)?.peer).toBe(renewed.publicKey);
        expect(await db.getDmKeyChange(dm.id, A)).toBeNull();
        await db.leaveChatInPlace(A);
    });

    it('A\'s pins unreadable: a send in place is refused with the store\'s sentence, nothing written or sent; B\'s chat is untouched', async () => {
        h.store.set(dmPeerPinsStoreKey(me.publicKey, A_FILE), '{ this is not a pin store');
        db._resetDmPeerPinsForTests();
        const linesBefore = (rowsOf(A_FILE)!.messages as any[]).length;
        const bBefore = rowsOf(B_FILE);
        asked = [];
        await expect(db.insertMessage(dm.id, me.publicKey, 'not without pins', undefined, undefined, undefined, A)).rejects.toMatchObject({ name: 'DmPinStoreError' });
        expect((rowsOf(A_FILE)!.messages as any[]).length).toBe(linesBefore);
        expect(asked.filter((r) => r.url.includes('/api/messages/send'))).toEqual([]);
        // A poll in place writes nothing of the node's into the DM while its pins are unread (the gate).
        nodeLine(dm, peer, 'held back by the gate');
        expect(await db.syncSingleConversation(dm.id, A)).toBe(false);
        expect((rowsOf(A_FILE)!.messages as any[]).length).toBe(linesBefore);
        expect(rowsOf(B_FILE)).toEqual(bBefore);
        await db.leaveChatInPlace(A);
    });

    it('B\'s pins unreadable: the chat in place reads and sends under A\'s, and B\'s store is left as it was', async () => {
        h.store.set(dmPeerPinsStoreKey(me.publicKey, B_FILE), '{ this is not a pin store');
        db._resetDmPeerPinsForTests();
        expect((await db.getMessages(dm.id, { community: A })).some((m: any) => m.text === PEER_WORDS)).toBe(true);
        const id = await db.insertMessage(dm.id, me.publicKey, 'A\'s pins are fine', undefined, undefined, undefined, A);
        await settle();
        expect(node.lines.some((l) => l.id === id)).toBe(true);
        expect(h.store.get(dmPeerPinsStoreKey(me.publicKey, B_FILE))).toBe('{ this is not a pin store');
        await db.leaveChatInPlace(A);
    });
});
