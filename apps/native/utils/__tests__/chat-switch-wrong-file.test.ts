/**
 * A chat answer is written only into the file of the community it was asked of (utils/db.ts chatCopyForRequest).
 *
 * The S1 probe measured it on the API 26 emulator (scratch/walks/RESULT-s1-second-handle-probe.md (4), run 6): syncMessages
 * asked community A, the member switched to B while the answer was on its way, and A's conversation row was written into
 * B's file (A 0, B 1; with no switch A 1, B 0). The function took getDb() after the network await.
 *
 * One table, every chat function that writes after a network await: each is driven with the node's answer held while the
 * phone switches to B, then the answer lands. Two switches, each row under both: the member's (utils/reconnect.ts
 * switchPhoneTo: the copy closed, the address written, B's copy opened, as the probe's run 6 switched) and getDb's own
 * swap (the address written with no closeDB, the copy left closed once the sync lock is free).
 * Each row asserts that B's file and B's own stored state are as they were, that the request was asked of A, and that a
 * sync drops the answer without throwing. B's file starts as a copy of A's, so a write by id (an edit, a delete, a
 * reaction, a request decided) into the wrong file would show.
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
                closeAsync: async () => { sql.close(); },
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
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { VOICE_BARS } from '@beanpool/core';
import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { getDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { sealDmLine } from '../e2e-crypto';
import { dmPeerPinsStoreKey } from '../storage-keys';

// A finished sync ends with require('react-native') for a DeviceEventEmitter nudge: answered at node's loader for the file.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) } };
    return realLoad.call(this, request, ...rest);
};

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-chat-switch-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const A_FILE = getDatabaseFilenameForNode(A);
const B_FILE = getDatabaseFilenameForNode(B);
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
/** `deleted`: the keys the conversation list names as deleted accounts. `pageAs`: a page asked by one id, answered as another conversation (a push for an id the phone doesn't hold). */
const node = { convs: [] as Conv[], lines: [] as Line[], deleted: [] as string[], pageAs: new Map<string, Conv>() };
let clock = Date.parse('2026-11-19T00:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();

/** The answer held: the request it matches, where it was sent, and the moment it is let go. */
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
    if (method === 'POST' && u.pathname === '/api/messages/request') return answer(200, { success: true, request: { state: 'accepted', from: h.me.publicKey, at: tick() } });
    if (method === 'POST' && u.pathname === '/api/messages/conversation') {
        const conv: Conv = { id: randomUUID(), type: 'dm', participants: body.participants };
        node.convs.push(conv);
        return answer(200, { conversation: view(conv) });
    }
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        return answer(200, { conversations: node.convs.filter((c) => c.participants.includes(list[1])).map(view), totalUnread: 0, deletedAccounts: node.deleted, requests: { count: 0, conversations: [] } });
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page && method === 'GET') {
        const asked = decodeURIComponent(page[1]);
        const as = node.pageAs.get(asked);
        if (as) return answer(200, { conversation: view(as), messages: [] });
        const conv = node.convs.find((c) => c.id === asked);
        if (!conv) return answer(404, { error: 'Conversation not found' });
        return answer(200, { conversation: view(conv), messages: node.lines.filter((l) => l.conversationId === conv.id).map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/groups') {
        return answer(200, [{ id: 'allotment-group', name: 'Allotment', slug: 'allotment', description: '', avatarUrl: null, category: 'garden', createdBy: h.me.publicKey, joinPolicy: 'open', createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z', memberCount: 1 }]);
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

/** A DM line on the node, sealed between its author and the other person, as the apps write it. */
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
/** A line of mine in the DM, on both files: what an edit, a delete and a reaction change. */
let mine: string;
let phoneN = 0;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

/** Every chat row of one file, read from the disk on a connection of the test's own (never the app's). */
function rowsOf(file: string): Record<string, unknown[]> {
    const sql = new DatabaseSync(path.join(h.dir, file));
    try {
        const out: Record<string, unknown[]> = {};
        for (const t of CHAT_TABLES) out[t] = sql.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...(r as object) }));
        return out;
    } finally {
        sql.close();
    }
}
/** What this phone stores for one file outside it (the DM pins, the DM guard list, the requests list, the cursors). */
const storedFor = (file: string) => Object.fromEntries([...h.store.entries()].filter(([k]) => k.includes(file)).sort());

/**
 * A phone on A that has synced its DM with `peer` (pinned at first sight) and holds a line of the peer's and one of its
 * own, and B, a community whose file is a copy of A's as it stands, so the same ids are in both.
 */
async function phoneOnAWithBCopied(): Promise<void> {
    await db.closeDB();
    db._resetDmPeerPinsForTests();
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
    node.deleted = [];
    node.pageAs.clear();
    nodeLine(dm, peer, 'hello from the other side');
    hold = null;
    (globalThis as any).fetch = fetchMock;

    expect(await db.syncMessages(me.publicKey)).toBe(true);
    mine = await db.insertMessage(dm.id, me.publicKey, 'my own words');
    await settle();
    const held = rowsOf(A_FILE);
    expect(held.messages.length).toBe(2);
    // B: A's file as it stands, under B's name. Closed first, so its log is in the file.
    await db.closeDB();
    fs.copyFileSync(path.join(h.dir, A_FILE), path.join(h.dir, B_FILE));
    await db.getDb();
}

interface Row {
    name: string;
    /** The request whose answer is held across the switch. */
    held: (method: string, pathname: string) => boolean;
    /** What the node has new, before the call. */
    before?: () => void;
    act: () => Promise<unknown>;
    /** A sync: it drops the answer and never throws at the member. */
    sync?: boolean;
}

/** The two ways the phone moves to B while an answer is out. */
const SWITCHES = {
    'switchPhoneTo': async () => { await switchPhoneTo(B); },
    "getDb's swap": async () => { h.store.set(ANCHOR, B); await db.getDb(); },
} as const;

const ROWS: Row[] = [
    {
        name: 'syncMessages (the conversation list)', sync: true,
        before: () => { node.convs.push({ id: randomUUID(), type: 'dm', participants: [me.publicKey, third.publicKey] }); },
        held: (m, p) => m === 'GET' && p.startsWith('/api/messages/conversations/'),
        act: () => db.syncMessages(me.publicKey),
    },
    {
        name: 'syncMessages (a chat\'s page)', sync: true,
        before: () => { nodeLine(dm, peer, 'a new line on the page'); },
        held: (m, p) => m === 'GET' && p === `/api/messages/${dm.id}`,
        act: () => db.syncMessages(me.publicKey),
    },
    {
        name: 'syncSingleConversation', sync: true,
        before: () => { nodeLine(dm, peer, 'a line the open chat polls for'); },
        held: (m, p) => m === 'GET' && p === `/api/messages/${dm.id}`,
        act: () => db.syncSingleConversation(dm.id),
    },
    {
        name: 'refreshConversationFromNode (getConversationKind asking the node)', sync: true,
        before: () => { node.convs.push({ id: 'riverside-new-chat', type: 'dm', participants: [me.publicKey, third.publicKey] }); },
        held: (m, p) => m === 'GET' && p === '/api/messages/riverside-new-chat',
        act: () => db.getConversationKind('riverside-new-chat', { askNode: true }),
    },
    {
        name: 'deleteMessageApi',
        held: (m, p) => m === 'POST' && p === '/api/messages/delete',
        act: () => db.deleteMessageApi(mine),
    },
    {
        name: 'decideMessageRequest',
        held: (m, p) => m === 'POST' && p === '/api/messages/request',
        act: () => db.decideMessageRequest(dm.id, 'accept'),
    },
    {
        name: 'toggleMessageReactionApi',
        held: (m, p) => m === 'POST' && p === '/api/messages/react',
        act: () => db.toggleMessageReactionApi(mine, me.publicKey, '👍'),
    },
    {
        name: 'createConversationApi',
        held: (m, p) => m === 'POST' && p === '/api/messages/conversation',
        act: () => db.createConversationApi('dm', [me.publicKey, third.publicKey], me.publicKey),
    },
    {
        name: 'insertMessage (its delivery, _deliverPendingMessage)',
        held: (m, p) => m === 'POST' && p === '/api/messages/send',
        act: () => db.insertMessage(dm.id, me.publicKey, 'sent as the phone switched'),
    },
    {
        name: 'editMessage',
        held: (m, p) => m === 'POST' && p === '/api/messages/edit',
        act: () => db.editMessage(dm.id, mine, 'my words, edited'),
    },
    {
        name: 'sendImageMessage',
        held: (m, p) => m === 'POST' && p === '/api/messages/send',
        act: () => db.sendImageMessage(dm.id, 'data:image/jpeg;base64,/9j/AAAA', ''),
    },
    {
        name: 'sendVoiceMessage',
        held: (m, p) => m === 'POST' && p === '/api/messages/send',
        act: () => {
            const sound = new Uint8Array(400);
            sound.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0x4d, 0x34, 0x41, 0x20]);
            return db.sendVoiceMessage(dm.id, { durationMs: 4200, bars: Array.from({ length: VOICE_BARS }, (_, i) => i * 5), sound });
        },
    },
    {
        name: 'fetchGroups',
        held: (m, p) => m === 'GET' && p === '/api/groups',
        act: () => db.fetchGroups(),
    },
];

beforeEach(async () => {
    await phoneOnAWithBCopied();
});

describe('a chat answer held while the phone switches community lands only in the file it was asked for', () => {
    const cases = ROWS.flatMap((r) => Object.entries(SWITCHES).map(([how, sw]) => [r.name, how, r, sw] as const));
    it.each(cases)('%s, switched by %s', async (_name, _how, row, switchToB) => {
        row.before?.();
        hold = holdFor(row.held);
        let thrown: unknown = null;
        const running = row.act().catch((e) => { thrown = e; });
        await hold.seen;

        // The member switches to B while the answer is on its way.
        await switchToB();
        await settle();
        const bBefore = rowsOf(B_FILE);
        const bStoredBefore = storedFor(B_FILE);

        hold.release();
        await running;
        await settle();

        expect(new URL(hold.url!).origin, 'asked of the community whose file it writes').toBe(A);
        expect(rowsOf(B_FILE), "B's file is as it was").toEqual(bBefore);
        expect(storedFor(B_FILE), "B's pins, guard list and requests are as they were").toEqual(bStoredBefore);
        if (row.sync) expect(thrown, 'a sync drops the answer, nothing thrown at the member').toBeNull();
    });

    it('the control, with no switch: the conversation list is written into A (A 1, B 0)', async () => {
        const extra: Conv = { id: randomUUID(), type: 'dm', participants: [me.publicKey, third.publicKey] };
        node.convs.push(extra);
        const bBefore = rowsOf(B_FILE);
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        const inA = rowsOf(A_FILE).conversations.filter((r: any) => r.id === extra.id).length;
        const inB = rowsOf(B_FILE).conversations.filter((r: any) => r.id === extra.id).length;
        expect([inA, inB]).toEqual([1, 0]);
        expect(rowsOf(B_FILE)).toEqual(bBefore);
    });

    it('the probe\'s run 6, with the switch: the conversation list lands in neither file (A 0, B 0), and the next pass on A writes it (A 1)', async () => {
        const extra: Conv = { id: randomUUID(), type: 'dm', participants: [me.publicKey, third.publicKey] };
        node.convs.push(extra);
        hold = holdFor((m, p) => m === 'GET' && p.startsWith('/api/messages/conversations/'));
        const running = db.syncMessages(me.publicKey);
        await hold.seen;
        await switchPhoneTo(B);
        hold.release();
        expect(await running).toBe(false);
        const count = (file: string) => rowsOf(file).conversations.filter((r: any) => r.id === extra.id).length;
        expect([count(A_FILE), count(B_FILE)]).toEqual([0, 0]);
        // Back on A, its next pass reads the list again and keeps it there.
        hold = null;
        await switchPhoneTo(A);
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        expect([count(A_FILE), count(B_FILE)]).toEqual([1, 0]);
    });
});

// ── The DM pin gate, through the same guarded paths ─────────────────────────────────────────────────────────────────
//
// The switch guard sits in the passes the DM pin gate stops (DESIGN-dm-peer-key-pin-fable.md §3.4 amendments 5 and 6):
// with this community's pin store unreadable, nothing of the node's goes into a DM here. One row per branch of the gate
// in the functions the guard changed, each run with no switch and under both switches, and once with the pins readable
// (the control: the node's answer does change the DM then, so a guard change that skipped the gate fails the row).

/** A line of a group's chat on the node, in plain text as the node keeps a group's lines. */
function groupLine(conv: Conv, author: Person, text: string, extra: Partial<Line> = {}): Line {
    const line: Line = {
        id: randomUUID(), conversationId: conv.id, authorPubkey: author.publicKey, ciphertext: Buffer.from(text).toString('base64'),
        nonce: 'plaintext-v1', type: 'text', metadata: null, timestamp: tick(), editedAt: null, ...extra,
    };
    node.lines.push(line);
    return line;
}
/** The tombstone the node writes over a deleted account's line in a group. */
const accountDeletedBy = (who: Person): Partial<Line> => ({
    type: 'removed', ciphertext: Buffer.from('This message was deleted').toString('base64'),
    metadata: JSON.stringify({ removed: true, accountDeleted: true, removedBy: who.publicKey, removedAt: tick() }),
});
const aGroup = (): Conv => ({ id: randomUUID(), type: 'group_thread', participants: [me.publicKey, peer.publicKey, third.publicKey] });
/** A group's row in A's file, as an open group chat already holds it (its poll asks the node for its page). */
function groupHeldInA(g: Conv): void {
    const sql = new DatabaseSync(path.join(h.dir, A_FILE));
    try {
        sql.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'group_thread', ?, '2026-11-19T00:00:00.000Z')").run(g.id, peer.publicKey);
    } finally {
        sql.close();
    }
}
/** Each DM's rows in A's file (its row, its people, its lines), read on a connection of the test's own. */
function dmRowsInA(ids: string[]): Record<string, unknown> {
    const sql = new DatabaseSync(path.join(h.dir, A_FILE));
    const all = (q: string, id: string) => sql.prepare(q).all(id).map((r) => ({ ...(r as object) }));
    try {
        return Object.fromEntries(ids.map((id) => [id, {
            conversation: all('SELECT * FROM conversations WHERE id = ?', id),
            people: all('SELECT * FROM conversation_participants WHERE conversation_id = ? ORDER BY public_key', id),
            lines: all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id', id),
        }]));
    } finally {
        sql.close();
    }
}
const pinsOfA = () => dmPeerPinsStoreKey(me.publicKey, A_FILE);
/** A's pin store unreadable (a value that doesn't parse: DmPinStoreError), read afresh as a new app session reads it. */
function pinsUnreadableInA(): void {
    h.store.set(pinsOfA(), '{ this is not a pin store');
    db._resetDmPeerPinsForTests();
}

interface GateRow {
    name: string;
    /** What the node serves that changes a DM here when the gate is open; returns the DMs to watch. */
    arrange: () => string[];
    held: (method: string, pathname: string) => boolean;
    act: () => Promise<unknown>;
}
const listHeld = (m: string, p: string) => m === 'GET' && p.startsWith('/api/messages/conversations/');
/** The group an open group chat's poll asks for (the syncSingleConversation rows). */
let groupAsked = '';
/** A group on the node whose page carries a line under each id of the DM's lines, the DM's own lines gone from the node. */
function groupOverTheDmsIds(g: Conv): void {
    node.convs.push(g);
    for (const l of node.lines.filter((x) => x.conversationId === dm.id)) groupLine(g, third, `group line over ${l.id.slice(0, 4)}`, { id: l.id });
    node.lines = node.lines.filter((l) => l.conversationId !== dm.id);
}
const GATE_ROWS: GateRow[] = [
    {
        name: "syncMessages' prune (G1): the node no longer lists the DM",
        arrange: () => { node.convs = []; return [dm.id]; },
        held: listHeld, act: () => db.syncMessages(me.publicKey),
    },
    {
        name: "syncMessages' blanking of the listing's deletedAccounts (G2)",
        arrange: () => { node.deleted = [peer.publicKey]; return [dm.id]; },
        held: listHeld, act: () => db.syncMessages(me.publicKey),
    },
    {
        name: "syncMessages: the DM's own page (its new lines)",
        arrange: () => { nodeLine(dm, peer, 'a line the gate holds back'); return [dm.id]; },
        held: listHeld, act: () => db.syncMessages(me.publicKey),
    },
    {
        name: "syncMessages' blanking of an account-deleted tombstone on a group's page (G3)",
        arrange: () => { const g = aGroup(); node.convs.push(g); groupLine(g, peer, '', accountDeletedBy(peer)); return [dm.id]; },
        held: listHeld, act: () => db.syncMessages(me.publicKey),
    },
    {
        name: "syncMessages: a group's page reusing the DM's line ids (G8, the narrow gate)",
        arrange: () => { groupOverTheDmsIds(aGroup()); return [dm.id]; },
        held: listHeld, act: () => db.syncMessages(me.publicKey),
    },
    {
        name: 'syncSingleConversation of an open group: an account-deleted tombstone on its page (G7)',
        arrange: () => { const g = aGroup(); groupAsked = g.id; groupHeldInA(g); node.convs.push(g); groupLine(g, peer, '', accountDeletedBy(peer)); return [dm.id]; },
        held: (m, p) => m === 'GET' && p === `/api/messages/${groupAsked}`, act: () => db.syncSingleConversation(groupAsked),
    },
    {
        name: "syncSingleConversation of an open group: its page reusing the DM's line ids (G8, the poll)",
        arrange: () => { const g = aGroup(); groupAsked = g.id; groupHeldInA(g); groupOverTheDmsIds(g); return [dm.id]; },
        held: (m, p) => m === 'GET' && p === `/api/messages/${groupAsked}`, act: () => db.syncSingleConversation(groupAsked),
    },
    {
        name: "refreshConversationFromNode (a push for an id the phone doesn't hold), answered with a new DM (G6)",
        arrange: () => {
            const fresh: Conv = { id: randomUUID(), type: 'dm', participants: [me.publicKey, third.publicKey] };
            node.pageAs.set('riverside-pushed-chat', fresh);
            return [fresh.id];
        },
        held: (m, p) => m === 'GET' && p === '/api/messages/riverside-pushed-chat',
        act: () => db.getConversationKind('riverside-pushed-chat', { askNode: true }),
    },
];

describe('the DM pin gate holds in every pass the switch guard changed (§3.4 amendments 5 and 6)', () => {
    it.each(GATE_ROWS.map((r) => [r.name, r] as const))("%s: the control, the pins readable: the node's answer reaches the DM", async (_name, row) => {
        const watched = row.arrange();
        const before = dmRowsInA(watched);
        await row.act();
        await settle();
        expect(dmRowsInA(watched), 'the row changes the DM when the gate is open (so the gated runs below are not vacuous)').not.toEqual(before);
    });

    const cases = GATE_ROWS.flatMap((r) => [['no switch', null] as const, ...Object.entries(SWITCHES)].map(([how, sw]) => [r.name, how, r, sw] as const));
    it.each(cases)("%s, the pins unreadable, %s: nothing of the node's goes into the DM", async (_name, _how, row, switchToB) => {
        const watched = row.arrange();
        pinsUnreadableInA();
        const before = dmRowsInA(watched);
        const pinsBefore = h.store.get(pinsOfA());
        hold = holdFor(row.held);
        let thrown: unknown = null;
        const running = row.act().catch((e) => { thrown = e; });
        await hold.seen;
        let bBefore: Record<string, unknown[]> | null = null;
        let bStoredBefore: Record<string, string> | null = null;
        if (switchToB) {
            await switchToB();
            await settle();
            bBefore = rowsOf(B_FILE);
            bStoredBefore = storedFor(B_FILE);
        }
        hold.release();
        await running;
        await settle();

        expect(new URL(hold.url!).origin, 'asked of A').toBe(A);
        expect(dmRowsInA(watched), "A's DM is as it was: the gate held").toEqual(before);
        expect(h.store.get(pinsOfA()), "A's pin store is as it was").toBe(pinsBefore);
        if (bBefore) {
            expect(rowsOf(B_FILE), "B's file is as it was").toEqual(bBefore);
            expect(storedFor(B_FILE), "B's pins, guard list and requests are as they were").toEqual(bStoredBefore);
        }
        expect(thrown, 'a sync never throws at the member').toBeNull();
    });
});
