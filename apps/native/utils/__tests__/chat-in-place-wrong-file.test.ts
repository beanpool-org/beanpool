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
 * Then leaving the chat (#3305 review): each thing on its way as it is left (a poll, a read mid-flight, a mark read, a
 * reply) x everything that could still follow (the screen's follow-ups after a poll or a push, and every other in-place
 * action from anywhere): nothing opens A's copy again and nothing is asked of A until the chat holds it again, when it
 * opens and its poll brings what came meanwhile. Key code, opened as the chat's close still runs, waits for that close and
 * reads; a read by nothing holding the chat waits and is refused.
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
    /** Lets a held close go: called by the test, and by the next phone's set-up so one failed row never hangs the next. */
    letCloseGo: () => {},
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
// The route's check (held-chats.ts) imports Chat's blocklist read, which loads react-native: nobody is blocked here.
vi.mock('../blocklist', () => ({ getBlockedUsers: vi.fn(async () => []) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import * as SQLite from 'expo-sqlite';
import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { removeCommunityCaches } from '../community-cache';
import { getDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { openDmLine, sealDmLine } from '../e2e-crypto';
import { dmPeerPinsStoreKey } from '../storage-keys';
import { chatInPlaceRoute, heldChatsInView } from '../held-chats';

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
    h.letCloseGo();
    h.closeHold = null;
    await db.closeDB();
    db._resetDmPeerPinsForTests();
    // A new phone: no chat held or left in place yet (the marks are this run's memory, by file).
    db._resetChatsInPlaceForTests();
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

    it('a page naming a request for me in a DM A holds (slice S3, which lifts S2\'s carve-out): its people go into A\'s copy as when set there, and into no other', async () => {
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
        const bBefore = rowsOf(B_FILE);
        try {
            expect(await db.syncSingleConversation(dm.id, A)).toBe(true);
            const people = (rowsOf(A_FILE)!.conversation_participants as any[]).filter((r) => r.conversation_id === dm.id).map((r) => r.public_key);
            expect(people).toContain(me.publicKey);
            expect(JSON.parse(String((rowsOf(A_FILE)!.conversations as any[]).find((c) => c.id === dm.id)?.request)).from).toBe(peer.publicKey);
            expect(rowsOf(B_FILE)).toEqual(bBefore);
            for (const r of asked) expect(new URL(r.url).origin).toBe(A);
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

/** Hold the next native close of `file` until `release()`: `started` settles once that close is under way. */
function holdCloseOf(file: string): { started: Promise<void>; release: () => void } {
    let begun!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => { begun = r; });
    const gate = new Promise<void>((r) => { release = r; });
    h.closeHold = { file, started: () => begun(), release: gate };
    h.letCloseGo = release;
    return { started, release };
}

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
        const { started, release } = holdCloseOf(A_FILE);
        // Chat -> Key code: the chat is covered and lets go first; its close runs (held here at the native close).
        const chatLet = db.leaveChatInPlace(A);
        await started;
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
        const { started, release } = holdCloseOf(A_FILE);
        const left = db.leaveChatInPlace(A);
        await started;
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

describe('a chat in place, opened: its copy opens once, and the first poll\'s line lands from that poll (#3305 review)', () => {
    /** Each native open of A's file (the copy open in place; Chat's read-only rows are S1's and not asked here). */
    const opensOfA = () => vi.mocked(SQLite.openDatabaseAsync).mock.calls.filter(([name]) => name === A_FILE).length;
    const NEWEST = 'the newest line, waiting at the node';

    /**
     * The chat's focus effect as it opens in place (app/chat/[id].tsx): held, then in one turn the conversation (the peer's
     * key), the thread, and the first poll, whose page is held at A's node with a line A's file doesn't have yet. Returns
     * once the peer's key is read, as the screen has it then.
     */
    async function openWithFirstPollAtTheNode() {
        const opensBefore = opensOfA();
        const newest = nodeLine(dm, peer, NEWEST).id;
        db.enterChatInPlace(A);
        hold = holdFor((m, p) => m === 'GET' && p === `/api/messages/${dm.id}`);
        const peerRead = db.getConversation(dm.id, me.publicKey, A);
        const threadRead = db.getMessages(dm.id, { community: A, notices: true });
        const polled = db.syncSingleConversation(dm.id, A);
        await hold.seen;
        expect((await peerRead)?.otherPubkey, 'the peer\'s key is read').toBe(peer.publicKey);
        expect((await threadRead).some((m: any) => m.text === NEWEST), 'not in A\'s file before the poll').toBe(false);
        return { polled, newest, opensBefore };
    }
    const inA = (id: string) => rowsOf(A_FILE)!.messages.some((m: any) => m.id === id);

    it('held once as the peer\'s key is read: that first poll writes its line into A\'s file, and A\'s copy opens once for the whole open', async () => {
        const others = { B: rowsOf(B_FILE), storedB: storedFor(B_FILE) };
        const { polled, newest, opensBefore } = await openWithFirstPollAtTheNode();
        hold!.release();
        expect(await polled, 'the first poll answered').toBe(true);
        expect(inA(newest), 'its line is in A\'s file from that first poll').toBe(true);
        // The poll's follow-ups, as the screen runs them: the conversation, the thread (the line shows), the read mark.
        await db.getConversation(dm.id, me.publicKey, A);
        expect((await db.getMessages(dm.id, { community: A, notices: true })).some((m: any) => m.text === NEWEST)).toBe(true);
        await db.markConversationRead(dm.id, me.publicKey, A);
        await settle();
        expect(opensOfA() - opensBefore, 'A\'s copy opened once, never closed and opened again').toBe(1);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        expect(asked.filter((r) => new URL(r.url).pathname.startsWith('/api/messages')).every((r) => new URL(r.url).origin === A)).toBe(true);
        expect({ B: rowsOf(B_FILE), storedB: storedFor(B_FILE) }).toEqual(others);
        await db.leaveChatInPlace(A);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
        expect(opensOfA() - opensBefore).toBe(1);
    });

    it('contrast: let go and held again under that poll (the screen\'s re-run before this fix): its line waits for the next poll, through a second open', async () => {
        const { polled, newest, opensBefore } = await openWithFirstPollAtTheNode();
        // The re-run, as React ran it: the cleanup lets go (its close runs while the page is at the node), the next run
        // holds and asks its own first poll.
        const left = db.leaveChatInPlace(A);
        db.enterChatInPlace(A);
        const second = db.syncSingleConversation(dm.id, A);
        await left;
        hold!.release();
        await Promise.all([polled, second]);
        await settle();
        expect(inA(newest), 'that first poll\'s line is not in A\'s file').toBe(false);
        expect(await db.syncSingleConversation(dm.id, A), 'the next poll').toBe(true);
        expect(inA(newest)).toBe(true);
        expect(opensOfA() - opensBefore, 'A\'s copy closed and opened again').toBe(2);
        await db.leaveChatInPlace(A);
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

// ── A link naming another community with an id its copy holds as no DM (#3305 review F1, F2, F3) ─────────────────────

/** A readable line on the node: a group's, an event's or an enterprise's chat is node-readable by design. */
function readableLine(conv: Conv, author: Person, text: string, metadata: string | null = null, type = 'text'): Line {
    const line: Line = { id: randomUUID(), conversationId: conv.id, authorPubkey: author.publicKey, ciphertext: Buffer.from(text, 'utf8').toString('base64'), nonce: 'plaintext-v1', type, metadata, timestamp: tick(), editedAt: null };
    node.lines.push(line);
    return line;
}

/** Into `file` straight, as a visit there when the phone was set to it left it: the chat's row (typed `type`), its people, a line. */
function keptIn(file: string, conv: Conv, line: Line, type = conv.type): void {
    const sql = new DatabaseSync(fileOn(file));
    try {
        sql.prepare('INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, ?, ?, ?)').run(conv.id, type, conv.participants[0], line.timestamp);
        for (const pk of conv.participants) sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(conv.id, pk);
        sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(line.id, conv.id, line.authorPubkey, line.ciphertext, line.nonce, line.type, line.metadata, line.timestamp);
    } finally {
        sql.close();
    }
}

/**
 * Every kind of id a link (beanpool://chat/<id>?community=<A>) can name that A's own copy holds as no DM. `id` is the chat,
 * `line` one of its lines (what a reaction, an edit or a delete names).
 */
const NOT_A_DM_IN_A: Array<{ name: string; make: () => { id: string; line: string } }> = [
    {
        // The reviewer's: an enterprise's discussion is its own key, "no secret", and A's server answers its page to every member.
        name: 'an enterprise\'s discussion (its id the enterprise\'s key), not on the phone',
        make: () => {
            const conv: Conv = { id: person().publicKey, type: 'enterprise_thread', participants: [me.publicKey, peer.publicKey] };
            node.convs.push(conv);
            return { id: conv.id, line: readableLine(conv, peer, 'an offer in the discussion').id };
        },
    },
    {
        name: 'a group\'s chat A\'s copy keeps (read there when the phone was set to A)',
        make: () => {
            const conv: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, peer.publicKey, third.publicKey] };
            node.convs.push(conv);
            const line = readableLine(conv, peer, 'words in the group');
            keptIn(A_FILE, conv, line);
            return { id: conv.id, line: line.id };
        },
    },
    {
        name: 'an event\'s chat, not on the phone',
        make: () => {
            const conv: Conv = { id: randomUUID(), type: 'event_thread', participants: [me.publicKey, peer.publicKey] };
            node.convs.push(conv);
            return { id: conv.id, line: readableLine(conv, peer, 'see you at the hall').id };
        },
    },
    {
        // The held guard: a group whose keys this copy holds stays its group, whatever its row there says.
        name: 'a group whose keys A\'s copy holds, its row there typed a DM',
        make: () => {
            const conv: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, peer.publicKey, third.publicKey] };
            node.convs.push(conv);
            const line = readableLine(conv, peer, 'a held group\'s words');
            keptIn(A_FILE, conv, line, 'dm');
            const sql = new DatabaseSync(fileOn(A_FILE));
            sql.prepare('INSERT INTO group_chat_key_state (group_id, highest) VALUES (?, 1)').run(`${me.publicKey}/${conv.id.toLowerCase()}`);
            sql.close();
            return { id: conv.id, line: line.id };
        },
    },
    {
        name: 'a direct chat A\'s server lists that A\'s copy doesn\'t hold yet',
        make: () => {
            const conv: Conv = { id: randomUUID(), type: 'dm', participants: [me.publicKey, third.publicKey] };
            node.convs.push(conv);
            return { id: conv.id, line: nodeLine(conv, third, 'not on this phone yet').id };
        },
    },
    {
        name: 'the DM\'s own id in other capitals',
        make: () => ({ id: dm.id.toUpperCase(), line: randomUUID() }),
    },
];

/**
 * Every in-place call that can write, of the phone's memory (A's DM guard list, A's pins, the deleted accounts' memory,
 * the mute memory) or of A's file, or ask A's server: each, for an id A's copy holds as no DM, refuses before anything
 * (NoCopyInPlaceError) or does nothing (false, nothing).
 */
const IN_PLACE_WRITES: Array<[string, (x: { id: string; line: string }) => Promise<unknown>]> = [
    ['the poll (syncSingleConversation)', (x) => db.syncSingleConversation(x.id, A)],
    ['mark read (markConversationRead)', (x) => db.markConversationRead(x.id, me.publicKey, A)],
    ['mute (muteChatApi)', (x) => db.muteChatApi(x.id, '8h', A)],
    ['reply (insertMessage)', (x) => db.insertMessage(x.id, me.publicKey, 'a reply', undefined, undefined, undefined, A)],
    ['edit (editMessage)', (x) => db.editMessage(x.id, x.line, 'edited', A)],
    ['delete (deleteMessageApi)', (x) => db.deleteMessageApi(x.line, A)],
    ['react (toggleMessageReactionApi)', (x) => db.toggleMessageReactionApi(x.line, me.publicKey, '👍', A)],
    ['take a line off (deleteLocalMessage)', (x) => db.deleteLocalMessage(x.line, A)],
    ['Accept a request (decideMessageRequest)', (x) => db.decideMessageRequest(x.id, 'accept', A)],
    ['mark the key verified (markDmPeerVerified)', (x) => db.markDmPeerVerified(x.id, peer.publicKey, A)],
    ['the route\'s check (heldChatIsDm)', (x) => db.heldChatIsDm(me.publicKey, A, x.id)],
];

describe('a link naming another community with an id its copy holds as no DM: nothing of it is asked or written in place (#3305 review F1)', () => {
    const cases = NOT_A_DM_IN_A.flatMap((k) => IN_PLACE_WRITES.map(([w, run]) => [k.name, w, k, run] as const));
    it.each(cases)('%s x %s: refused or nothing, nothing asked, nothing of A\'s or B\'s memory or files changed', async (_k, _w, kind, run) => {
        const x = kind.make();
        // The chat screen holds A as it would (so nothing below is refused for a chat left), its copy open on a DM's read.
        db.enterChatInPlace(A);
        expect((await db.getMessages(dm.id, { community: A })).some((m: any) => m.text === PEER_WORDS)).toBe(true);
        const before = { A: rowsOf(A_FILE), B: rowsOf(B_FILE), storedA: storedFor(A_FILE), storedB: storedFor(B_FILE), mute: db.getKnownChatMute(x.id) };
        asked = [];
        const outcome = await run(x).then((v) => ({ v }), (e) => ({ e }));
        await settle();
        if ('e' in outcome) expect(db.isNoCopyInPlace(outcome.e), String((outcome.e as any)?.message ?? outcome.e)).toBe(true);
        else expect(outcome.v ?? false).toBe(false);
        expect(asked.map((r) => `${r.method} ${r.url}`), 'nothing asked of any server').toEqual([]);
        expect({ A: rowsOf(A_FILE), B: rowsOf(B_FILE), storedA: storedFor(A_FILE), storedB: storedFor(B_FILE), mute: db.getKnownChatMute(x.id) }).toEqual(before);
        await db.leaveChatInPlace(A);
    });

    it('control: the same calls for the DM A\'s copy holds do reach A (the rows above are not refusing everything)', async () => {
        db.enterChatInPlace(A);
        expect(await db.heldChatIsDm(me.publicKey, A, dm.id)).toBe(true);
        asked = [];
        expect(await db.syncSingleConversation(dm.id, A)).toBe(true);
        await db.muteChatApi(dm.id, '8h', A);
        await db.toggleMessageReactionApi(mine, me.publicKey, '👍', A);
        await settle();
        expect(asked.map((r) => `${r.method} ${new URL(r.url).origin}${new URL(r.url).pathname}`)).toEqual(expect.arrayContaining([
            `GET ${A}/api/messages/${dm.id}`, `POST ${A}/api/messages/mute`, `POST ${A}/api/messages/react`,
        ]));
        expect(db.getKnownChatMute(dm.id)?.mutedUntil).toBe('2026-11-20T08:00:00.000Z');
        await db.leaveChatInPlace(A);
    });

    it('the route asks as Chat is left (its read-only handle on A still closing): it waits for that close, then answers from A\'s copy', async () => {
        // A tap on Chat's held row: Chat's read-only handle on A is open, and Chat's leave closes it as the chat's route asks.
        expect(await db.heldChatIsDm(me.publicKey, A, dm.id)).toBe(true);
        expect(db.heldCopyFiles()).toContain(A_FILE);
        const close = holdCloseOf(A_FILE);
        const leaving = db.closeHeldCopies();
        await close.started;
        const asking = db.heldChatIsDm(me.publicKey, A, dm.id);
        await settle();
        close.release();
        await leaving;
        expect(await asking, 'a DM A holds, asked during Chat\'s close').toBe(true);
        await db.closeHeldCopies();
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
        // Mutation: no wait for the close under way (heldChatIsDm asks once) -> false, and the route would offer only a move.
    });

    it('the reviewer\'s sequence: an enterprise\'s key polled in place on A writes nothing, and set to A its discussion, Offers and decisions still go to the node', async () => {
        const key = person().publicKey;
        const conv: Conv = { id: key, type: 'enterprise_thread', participants: [me.publicKey, peer.publicKey] };
        node.convs.push(conv);
        readableLine(conv, peer, 'an offer in the discussion');
        const aBefore = { rows: rowsOf(A_FILE), stored: storedFor(A_FILE) };
        // The route's check first: A's copy holds no DM under the key (and does under the DM's own id).
        expect(await db.heldChatIsDm(me.publicKey, A, key)).toBe(false);
        expect(await db.heldChatIsDm(me.publicKey, A, dm.id)).toBe(true);
        // The chat's poll in place, had anything opened it: nothing asked, nothing written, A's DM guard list as it was.
        db.enterChatInPlace(A);
        asked = [];
        expect(await db.syncSingleConversation(key, A)).toBe(false);
        await settle();
        expect(asked).toEqual([]);
        expect({ rows: rowsOf(A_FILE), stored: storedFor(A_FILE) }).toEqual(aBefore);
        await db.leaveChatInPlace(A);
        // Set to A: nothing knows the key as a DM, and the enterprise's discussion, an Offer and a decision are each asked of A.
        await switchPhoneTo(A);
        expect(await db.isKnownDmConversation(key)).toBe(false);
        expect(await db.getConversationKind(key)).not.toBe('dm');
        const tries: Array<[string, () => Promise<unknown>, string]> = [
            ['its discussion', () => db.postEnterpriseThreadMessage(key, 'hello the enterprise'), `/api/treasury/${key}/thread/message`],
            ['an Offer', () => db.treasuryPostOffer(key, { category: 'tools', title: 'A long ladder', price_c: 100 }), `/api/treasury/${key}/offer`],
            ['a decision', () => db.proposeEnterpriseDecision(key, { title: 'Buy a ladder', description: 'For the shed', effect: 'spend' as any }), `/api/enterprise/${key}/decisions`],
        ];
        for (const [what, tryIt, pathname] of tries) {
            asked = [];
            const thrown: any = await tryIt().then(() => null, (e) => e);
            expect(String(thrown?.message ?? ''), what).not.toContain('as a direct message');
            expect(asked.map((r) => new URL(r.url).pathname), what).toContain(pathname);
        }
        // Mutation (the review's): the poll's gate off and `|| here.inPlace` back in its remember -> A's stored list holds the
        // key, isKnownDmConversation answers true, and each of the three is refused before asking ("... as a direct message").
    });

    it('a group\'s page with a deleted account\'s tombstone, polled in place on A: B\'s own blanking of that account is untouched', async () => {
        const gone = person();
        const tombstone = (conv: Conv) => readableLine(conv, gone, 'This message was deleted',
            JSON.stringify({ accountDeleted: true, removedBy: gone.publicKey, removedAt: tick() }), 'removed');
        const groupA: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, gone.publicKey] };
        const groupB: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, gone.publicKey] };
        node.convs.push(groupA, groupB);
        tombstone(groupA);
        // B holds an older line of theirs in a group of its own, still holding its words; B's page of it names the tombstone.
        const older: Line = { id: randomUUID(), conversationId: groupB.id, authorPubkey: gone.publicKey, ciphertext: Buffer.from('my old words', 'utf8').toString('base64'), nonce: 'plaintext-v1', type: 'text', metadata: null, timestamp: tick(), editedAt: null };
        keptIn(B_FILE, groupB, older);
        tombstone(groupB);
        db.enterChatInPlace(A);
        const polledInPlace = await db.syncSingleConversation(groupA.id, A);
        await db.leaveChatInPlace(A);
        // B's own poll of its group: its older line of that account is blanked, as with no poll in place at all.
        expect(await db.syncSingleConversation(groupB.id)).toBe(true);
        const row = (rowsOf(B_FILE)!.messages as any[]).find((m) => m.id === older.id);
        expect({ type: row?.type, nonce: row?.nonce }, 'B blanks its own line of the deleted account').toEqual({ type: 'removed', nonce: 'plaintext-v1' });
        // And the group's page was never polled in place (A's copy holds no DM under its id).
        expect(polledInPlace, 'the group\'s page refused in place').toBe(false);
        // Mutations: the poll's gate off -> red only at the line above (B still blanks: the memory is kept by the copy's
        // file); the gate off AND the memory kept by the community in use (currentDbName) -> red at B's line, which keeps its
        // words (the review's second effect).
    });

    it('a held DM whose page A\'s node types a group\'s, carrying a deleted account\'s tombstone: polled in place, A\'s lines of theirs go, and B still blanks its own (#3305 max review r2 N1)', async () => {
        // The gate passes this one (A's copy holds it as a DM); the page's own type is what lets a tombstone blank
        // (chat-sync.ts accountDeletedAuthor), and a node relisting a DM as a group's chat is the DM guard's own threat.
        const gone = person();
        const tombstoneIn = (conv: Conv) => readableLine(conv, gone, 'This message was deleted',
            JSON.stringify({ accountDeleted: true, removedBy: gone.publicKey, removedAt: tick() }), 'removed');
        const plainOld = (conv: Conv, words: string): Line => ({ id: randomUUID(), conversationId: conv.id, authorPubkey: gone.publicKey, ciphertext: Buffer.from(words, 'utf8').toString('base64'), nonce: 'plaintext-v1', type: 'text', metadata: null, timestamp: tick(), editedAt: null });
        // A holds an older line of theirs, in a group A keeps (the in-place poll's blanking reaches A's whole copy).
        const groupA: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, gone.publicKey] };
        const olderInA = plainOld(groupA, 'my old words in A');
        keptIn(A_FILE, groupA, olderInA);
        // B holds an older line of theirs in a group of its own, still holding its words; B's page of it names the tombstone.
        const groupB: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, gone.publicKey] };
        node.convs.push(groupB);
        const olderInB = plainOld(groupB, 'my old words in B');
        keptIn(B_FILE, groupB, olderInB);
        tombstoneIn(groupB);
        // A's node now answers the held DM's page as a group's, with the tombstone on it.
        dm.type = 'group_thread';
        tombstoneIn(dm);
        const typeInA = () => (rowsOf(A_FILE)!.conversations as any[]).find((c) => c.id === dm.id)?.type;
        expect(typeInA()).toBe('dm');
        db.enterChatInPlace(A);
        expect(await db.syncSingleConversation(dm.id, A), 'the held DM is polled in place (the gate passes it)').toBe(true);
        await db.leaveChatInPlace(A);
        expect(typeInA(), 'A\'s row stays a DM').toBe('dm');
        const lineOf = (file: string, id: string) => (rowsOf(file)!.messages as any[]).find((m) => m.id === id);
        expect({ type: lineOf(A_FILE, olderInA.id)?.type, nonce: lineOf(A_FILE, olderInA.id)?.nonce }, 'the poll in place blanked A\'s line of the account').toEqual({ type: 'removed', nonce: 'plaintext-v1' });
        expect(lineOf(B_FILE, olderInB.id)?.type, 'nothing of B\'s blanked by A\'s poll').toBe('text');
        // B's own poll of its group: its older line of that account is blanked, as with no poll in place at all.
        expect(await db.syncSingleConversation(groupB.id)).toBe(true);
        expect({ type: lineOf(B_FILE, olderInB.id)?.type, nonce: lineOf(B_FILE, olderInB.id)?.nonce }, 'B blanks its own line of the deleted account').toEqual({ type: 'removed', nonce: 'plaintext-v1' });
        // Mutation (the xhigh review's, green on every other row): the memory kept by the community in use (`const copy =
        // currentDbName ?? ''`), the poll's gate kept -> A's poll marks B's file done, and B's line keeps its words.
    });
});

/** A's node answering a new DM with `id`, for the very people asked (so the people check holds): as a node that reuses an id. */
function createAnswersWith(id: string): void {
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
        if ((init.method || 'GET') === 'POST' && new URL(url).pathname === '/api/messages/conversation') {
            asked.push({ method: 'POST', url });
            return answer(200, { conversation: view({ id, type: 'dm', participants: JSON.parse(init.body).participants }) });
        }
        return fetchMock(url, init);
    };
}

/** What A's copy can already hold under the id A's node answers a new DM with: never a DM's to start over (newDmFitsIn). */
const NO_NEW_DM_OVER: Array<{ name: string; make: () => string }> = [
    {
        name: 'a group whose keys A\'s copy holds, its row there typed a DM',
        make: () => {
            const conv: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, peer.publicKey, third.publicKey] };
            keptIn(A_FILE, conv, readableLine(conv, peer, 'a held group\'s words'), 'dm');
            const sql = new DatabaseSync(fileOn(A_FILE));
            sql.prepare('INSERT INTO group_chat_key_state (group_id, highest) VALUES (?, 1)').run(`${me.publicKey}/${conv.id.toLowerCase()}`);
            sql.close();
            return conv.id;
        },
    },
    {
        name: 'a group whose wrapped key A\'s copy holds (no key state yet), its row there typed a DM',
        make: () => {
            const conv: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, peer.publicKey, third.publicKey] };
            keptIn(A_FILE, conv, readableLine(conv, peer, 'a wrapped group\'s words'), 'dm');
            const sql = new DatabaseSync(fileOn(A_FILE));
            sql.prepare('INSERT INTO group_chat_epochs (group_id, epoch, record, wrap) VALUES (?, 1, ?, ?)').run(`${me.publicKey}/${conv.id.toLowerCase()}`, 'record', 'wrap');
            sql.close();
            return conv.id;
        },
    },
    {
        name: 'a group\'s chat A\'s copy keeps as a group',
        make: () => {
            const conv: Conv = { id: randomUUID(), type: 'group_thread', participants: [me.publicKey, peer.publicKey, third.publicKey] };
            keptIn(A_FILE, conv, readableLine(conv, peer, 'words in the group'));
            return conv.id;
        },
    },
    {
        name: 'an event\'s chat A\'s copy keeps',
        make: () => {
            const conv: Conv = { id: randomUUID(), type: 'event_thread', participants: [me.publicKey, peer.publicKey] };
            keptIn(A_FILE, conv, readableLine(conv, peer, 'see you at the hall'));
            return conv.id;
        },
    },
];

describe('a new DM started in place that A\'s copy already holds as no DM: refused, nothing written or remembered (#3305 max review r2 N2)', () => {
    it.each(NO_NEW_DM_OVER.map((k) => [k.name, k] as const))('A\'s node answers with the id of %s', async (_name, kind) => {
        const id = kind.make();
        createAnswersWith(id);
        const before = { A: rowsOf(A_FILE), B: rowsOf(B_FILE), storedA: storedFor(A_FILE), storedB: storedFor(B_FILE) };
        asked = [];
        const thrown: any = await db.createConversationApi('dm', [me.publicKey, third.publicKey], me.publicKey, undefined, undefined, A).then(() => null, (e) => e);
        await settle();
        expect(String(thrown?.message ?? thrown)).toBe('This community answered with someone else for this chat, so it wasn\'t started.');
        // Asked of A only, and nothing of it written: no row, no people, no pin, nothing in A's DM guard list.
        expect(asked.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${A}/api/messages/conversation`]);
        expect({ A: rowsOf(A_FILE), B: rowsOf(B_FILE), storedA: storedFor(A_FILE), storedB: storedFor(B_FILE) }).toEqual(before);
        await db.leaveChatInPlace(A);
        // Mutation: newDmFitsIn always true -> A's DM guard list and pins keep the id, and its people are written into A.
        // (A fresh id A's copy doesn't hold is started and written there: the table's 'a new chat' row, with nothing meanwhile.)
    });
});

describe('the route\'s check (chatInPlaceRoute) leaves no read-only handle open, whatever it answers (#3305 max review r2 N2)', () => {
    const ANSWERS: Array<{ name: string; open: string; ask: () => Promise<{ open: string }> }> = [
        { name: 'an id A\'s copy doesn\'t hold', open: 'move', ask: () => chatInPlaceRoute(me.publicKey, randomUUID(), A) },
        { name: 'the DM\'s id in other capitals', open: 'move', ask: () => chatInPlaceRoute(me.publicKey, dm.id.toUpperCase(), A) },
        { name: 'the DM A\'s copy holds', open: 'in-place', ask: () => chatInPlaceRoute(me.publicKey, dm.id, A) },
        { name: 'a community the phone doesn\'t keep', open: 'nothing', ask: () => chatInPlaceRoute(me.publicKey, dm.id, C) },
        {
            name: 'A kept only as a guest\'s look', open: 'nothing',
            ask: () => { h.store.set('beanpool_guest_nodes', JSON.stringify([A])); return chatInPlaceRoute(me.publicKey, dm.id, A); },
        },
    ];

    it.each(ANSWERS.map((a) => [a.name, a.open, a] as const))('%s: answers \'%s\', and no held handle is open after', async (_name, open, row) => {
        expect(db.heldCopyFiles()).toEqual([]);
        expect((await row.ask()).open).toBe(open);
        await settle();
        expect(db.heldCopyFiles(), 'the check\'s read-only handle closed').toEqual([]);
        // Mutation: chatInPlaceRoute without its closeUnlessInView -> A's read-only handle stays open after 'move' and
        // 'in-place' (a 'nothing' answer opens none at all).
    });

    it('contrast: asked with Chat in view, Chat\'s read-only handle on A stays open for Chat, and closes as Chat is left', async () => {
        const view = heldChatsInView();
        try {
            expect((await chatInPlaceRoute(me.publicKey, randomUUID(), A)).open).toBe('move');
            await settle();
            expect(db.heldCopyFiles(), 'the check did open a read-only handle on A').toContain(A_FILE);
        } finally {
            await view.leave();
        }
        expect(db.heldCopyFiles()).toEqual([]);
    });
});

describe('a chat in place is reached by the community as the phone saved it, never a link\'s spelling (#3305 review F2)', () => {
    const SPELLINGS = ['https://Riverside.EXAMPLE', 'https://riverside.example/some/path', 'HTTPS://RIVERSIDE.EXAMPLE/'];

    it('a guest mark in any spelling: refused before anything opens or is asked, whichever spelling the call names', async () => {
        h.store.set('beanpool_guest_nodes', JSON.stringify(['https://RIVERSIDE.example/']));
        for (const where of [A, ...SPELLINGS]) {
            asked = [];
            const before = rowsOf(A_FILE);
            await expect(db.insertMessage(dm.id, me.publicKey, 'not on a look', undefined, undefined, undefined, where)).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
            expect(asked, where).toEqual([]);
            expect(rowsOf(A_FILE)).toEqual(before);
            expect(db.heldCopyFiles(), where).not.toContain(A_FILE);
        }
        // Mutation: the guest mark compared by its exact string (isGuestNode) -> the capitals and the trailing path open A's
        // copy writable and send.
    });

    it('a link\'s own spelling of a community the phone keeps: every request goes to the saved address, every line to A\'s file', async () => {
        for (const where of SPELLINGS) {
            db.enterChatInPlace(where);
            asked = [];
            const id = await db.insertMessage(dm.id, me.publicKey, `by ${where}`, undefined, undefined, undefined, where);
            expect(await db.syncSingleConversation(dm.id, where)).toBe(true);
            await settle();
            const chat = asked.filter((r) => new URL(r.url).pathname.startsWith('/api/messages'));
            expect(chat.length).toBeGreaterThan(0);
            for (const r of chat) expect(r.url.startsWith(`${A}/api/messages`), r.url).toBe(true);
            expect((rowsOf(A_FILE)!.messages as any[]).some((m) => m.id === id)).toBe(true);
            await db.leaveChatInPlace(where);
        }
        // Mutation: copyInPlaceFor's `anchorUrl: community` (the link's spelling) -> requests go to the spelling asked.
    });
});

describe('a chat in place reads its photos from A\'s own server (#3305 review F3: D26, D27)', () => {
    function photoOf(file: string, key: string, url: string): void {
        const sql = new DatabaseSync(fileOn(file));
        sql.prepare('INSERT OR REPLACE INTO members (public_key, callsign, avatar_url) VALUES (?, ?, ?)').run(key, 'Kofi', url);
        sql.close();
    }

    it('the other person\'s photo at the top is A\'s, by the path A\'s node stored, never the community in use\'s (D26)', async () => {
        photoOf(A_FILE, peer.publicKey, '/uploads/kofi-in-a.jpg');
        photoOf(B_FILE, peer.publicKey, '/uploads/kofi-in-b.jpg');
        const there = await db.getConversation(dm.id, me.publicKey, A);
        expect(there?.otherAvatar).toBe(`${A}/uploads/kofi-in-a.jpg`);
        await db.leaveChatInPlace(A);
        // Mutation: getConversation without its onCommunity in place -> '/uploads/kofi-in-a.jpg', which the screen would
        // load from the community in use.
    });

    it('a line\'s photo is asked of A\'s server, for A\'s line, and of no other (D27)', async () => {
        const line = node.lines.find((l) => l.authorPubkey === peer.publicKey)!;
        asked = [];
        await db.getDecryptedAttachment(dm.id, line.id, false, A);
        expect(asked.filter((r) => r.url.includes('/attachment')).map((r) => r.url)).toEqual([`${A}/api/messages/${line.id}/attachment`]);
        await db.leaveChatInPlace(A);
        // Mutation: the attachment's signedGet without its anchorUrl -> asked of the community in use (B).
    });
});
