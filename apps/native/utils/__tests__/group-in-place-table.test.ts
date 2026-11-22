/**
 * Slice S6 (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §6), part 1: a group's chat of another community this
 * phone holds is read and answered there in place, with no switch.
 *
 * One table (close the class): each group action x each way the phone can stand to that community:
 * - in use (the phone is set to it);
 * - a held member (set to another community), nothing meanwhile, and a switch to a third one while the answer is on its way;
 * - a held guest's look; left (the chat left and not back); taken off the phone.
 * Each row asserts which server was asked (A's own, or none), the name it was signed for (the request's own address), that
 * nothing was asked of, or written for, any other community, and, refused, that it says so in words with nothing asked.
 * Then: what may open in place (the route), the DM guard in place (A's own pins and list decide, never B's), the group keys'
 * memory (A's file only, sealed under A's epoch; let go once the chat is left), and the list that names a group.
 *
 * And (review of #3358, F1) what a group's key ring has in memory and what its file has never part: every write of it x every
 * way it can be refused, then opened again, a restart, and read; the lock across a restart; a community taken off and joined
 * again. And (F2) the one order of Talk → Groups' rows.
 *
 * Real SQLite files on disk, the real database open, real pins and guard lists, real group epochs and sealing; each
 * community's server is a stand-in that answers as routes/groups.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const h = vi.hoisted(() => ({
    dir: '', store: new Map<string, string>(), me: { publicKey: '', privateKey: '' },
    /** The next writes of `file` that read as `sql` (past the first `skip`): `hit` as each is run (`wait`: it waits for what that starts), and SQLite refuses it when `refuse`. */
    cut: null as null | { file: string; sql: RegExp; times: number; refuse: boolean; hit: () => unknown; skip?: number; wait?: boolean },
    /** The reads of `file` that read as `sql`: each fails, or never answers (`hang`), or waits for what `hit` starts (`wait`); `hit` as each is asked. */
    reads: null as null | { file: string; sql: RegExp; times: number; hang: boolean; hit?: () => unknown; refuse?: boolean; wait?: boolean },
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    const cutRead = async (name: string, q: string) => {
        const cut = h.reads;
        if (!cut || cut.file !== name || cut.times <= 0 || !cut.sql.test(q)) return;
        cut.times--;
        const started = cut.hit?.();
        if (cut.wait) await started;
        if (cut.hang) await new Promise<void>(() => {});
        if (cut.refuse !== false) throw new Error('disk I/O error');
    };
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            return {
                runAsync: async (q: string, p?: unknown) => {
                    const cut = h.cut;
                    if (cut && cut.file === name && cut.times > 0 && cut.sql.test(q) && !(cut.skip && cut.skip-- > 0)) {
                        cut.times--;
                        const started = cut.hit();
                        if (cut.wait) await started;
                        if (cut.refuse) throw new Error('database is locked');
                    }
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                execAsync: async (q: string) => { sql.exec(q); },
                getAllAsync: async (q: string, p?: unknown) => { await cutRead(name, q); return sql.prepare(q).all(...params(p)); },
                getFirstAsync: async (q: string, p?: unknown) => { await cutRead(name, q); return sql.prepare(q).get(...params(p)) ?? null; },
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
        readAsStringAsync: vi.fn(async () => ''),
        readDirectoryAsync: vi.fn(async () => []),
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
vi.mock('react-native', () => ({ DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Me' })) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../blocklist', () => ({ getBlockedUsers: vi.fn(async () => []), isUserBlocked: vi.fn(async () => false) }));
// Each request says the address it is signed for: the request's own.
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { removeCommunityCaches } from '../community-cache';
import { getDatabaseFilenameForNode, removeSavedNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { _resetGroupKeySessionForTests, forgetGroupKeys, noteAnsweredLocked, groupKeyring, memoryGroupKeyStore, GROUP_KEY_ROLLBACK_TEXT, GROUP_KEY_STORE_UNREAD_TEXT } from '../group-chat-keys';
import { GROUP_NONCE_PREFIX, makeEpochRecord, sealLine } from '../group-chat-crypto';
import { buildSignedHeaders } from '../crypto';
import { addGroupKeyState, sqliteGroupKeyStore, GROUP_KEY_TABLES_SQL } from '../group-chat-store';
import { groupChatNotice, groupChatShownLines, openGroupThread, GROUP_CHAT_LOCK_LOST_TEXT, GROUP_EDIT_NO_KEY_TEXT, GROUP_KEYS_FOR_DM_TEXT, type OpenedGroupThread } from '../group-chat-lines';
import { dmPeerPinsStoreKey, dmConversationsSeenStoreKey } from '../storage-keys';
import { chatInPlaceRoute } from '../held-chats';
import { routeChat } from '../chat-route';
import { groupsListed, heldGroups, isHeldGroup } from '../held-groups';
import { guestRosterRows } from '../guest-chat-live';
import { yourGroupsStore } from '../../components/useYourGroups';
import type { YourChat } from '../your-groups';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-group-in-place-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** A: where the group lives. B: the community the phone is set to. C: a third, the phone switches to. */
const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const C = 'https://brookside.example';
const A_FILE = getDatabaseFilenameForNode(A);
const B_FILE = getDatabaseFilenameForNode(B);
const C_FILE = getDatabaseFilenameForNode(C);
const ANCHOR = 'beanpool_anchor_url';
const TABLES = ['conversations', 'conversation_participants', 'messages', 'groups', 'group_members', 'group_chat_epochs', 'group_chat_key_state', 'group_line_signers'];

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── Each community's server: one group's keys, members and lines, as routes/groups.ts answers ────────────────────────

interface Server {
    epochs: any[]; lines: any[]; wordsIn: string[]; left: boolean;
    /** It answers the chat with no `encryption` and has no keys: a node that dropped the lock. */
    unlocked?: boolean;
    /** It answers the chat locked, and refuses this phone its keys. */
    noKeys?: boolean;
    /** It doesn't answer the chat at all. */
    mute?: boolean;
    /** Epochs whose record is served unsigned by its maker, until each is asked for by name. */
    badRecords?: Set<number>;
    /** The current key doesn't fit the roster: the next member to write makes a new one. */
    stale?: boolean;
    /** Epochs whose wrap for me is served as another's doing, until it is refused; and those refused. */
    junk?: Set<number>; rejected?: number[];
    /** Its "Your groups" answer, when not the usual one; and its group's guests. */
    listed?: any[]; guests?: any[];
}
let servers: Record<string, Server>;
let me: Person;
let peer: Person;
/** The group in A (the same id names a group in B too: a copied file, so a write into the wrong one shows). */
let g: string;
let asked: Array<{ method: string; url: string; signed: string | null; body: any }> = [];
let hold: null | { matches: (method: string, p: string) => boolean; seen: () => void; go: Promise<void>; used: boolean } = null;

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    const res: any = { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
    res.clone = () => res;
    return res;
}
const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    asked.push({ method, url, signed: init.headers?.['X-Signed'] ?? null, body });
    if (hold && !hold.used && hold.matches(method, u.pathname)) {
        hold.used = true;
        hold.seen();
        await hold.go;
    }
    const s = servers[u.origin];
    if (!s) return answer(404, { error: 'not here' });
    const p = u.pathname;
    const at = `/api/groups/${g}`;
    if (p === '/api/your-groups' && s.listed) return answer(200, { items: s.listed, totalUnread: 0 });
    if (p === '/api/your-groups') return answer(200, { items: s.left ? [] : [{ kind: 'group', badge: null, id: g, conversationId: g, name: 'Garden Crew', avatarUrl: '/uploads/garden.jpg', role: 'member', readOnly: false, lastMessage: null, unreadCount: 2, mute: null, lastActivityAt: '2026-11-21T00:00:00.000Z' }, { kind: 'event', id: 'event-1', conversationId: 'event-1', name: 'Working bee', avatarUrl: null, role: 'going', badge: null, readOnly: false, lastMessage: null, unreadCount: 1, mute: null, lastActivityAt: '2026-11-22T00:00:00.000Z' }], totalUnread: 3 });
    if (p === at && method === 'GET') return answer(200, { id: g, name: 'Garden Crew', memberCount: 2, viewerRole: 'member' });
    if (p === `${at}/members` && method === 'GET') return answer(200, [me, peer].map((m, i) => ({ memberPubkey: m.publicKey, callsign: i ? 'Dana' : 'Me', status: 'active', role: 'member' })));
    if (p === `${at}/guests`) return answer(200, { guests: s.guests ?? [], on: !!s.guests });
    if ((s.unlocked || s.noKeys) && p.startsWith(`${at}/keys`)) return answer(404, { error: 'not here' });
    const refusing = new RegExp(`^${at}/keys/(\\d+)/reject$`).exec(p);
    if (refusing && method === 'POST') { (s.rejected ??= []).push(Number(refusing[1])); s.junk?.delete(Number(refusing[1])); return answer(200, { success: true }); }
    if (p === `${at}/keys` && method === 'GET') {
        const after = Number(u.searchParams.get('after') ?? 0);
        const only = u.searchParams.get('epochs')?.split(',').map(Number);
        const epochs = s.epochs.filter((e) => (only ? only.includes(e.epoch) : e.epoch > after)).map((e) => (s.badRecords?.has(e.epoch) && !only ? { ...e, reason: 'join' } : e));
        return answer(200, {
            current: s.epochs.length ? s.epochs[s.epochs.length - 1].epoch : null, stale: !!s.stale, fromEpoch: s.epochs.length ? 1 : null,
            roster: [me.publicKey, peer.publicKey].sort(), epochs: epochs.map(({ wraps: _w, ...e }) => e),
            myWraps: epochs.flatMap((e) => e.wraps.filter((w: any) => w.recipient === me.publicKey).map((w: any) => ({ ...w, epoch: e.epoch, wrapper: s.junk?.has(e.epoch) ? me.publicKey : e.createdBy, sig: null }))), more: false,
        });
    }
    if (p === `${at}/keys/epoch` && method === 'POST') { s.epochs.push(body.epoch); s.stale = false; return answer(200, { ok: true }); }
    if (p === `${at}/keys/missing`) return answer(200, { missing: [] });
    if (p === `${at}/chat` && method === 'GET' && s.mute) return answer(503, { error: 'busy' });
    if (p === `${at}/chat` && method === 'GET') {
        return answer(200, { conversation: { id: g, name: 'Garden Crew' }, group: { name: 'Garden Crew' }, messages: s.lines, canPost: true, isConvenor: true, encryption: s.unlocked ? undefined : { current: s.epochs.length || null, stale: false, fromEpoch: s.epochs.length ? 1 : null } });
    }
    if (p === `${at}/chat/message` && method === 'POST') {
        if (typeof body.text === 'string') s.wordsIn.push(body.text);
        s.lines.push({ id: body.clientId, authorPubkey: me.publicKey, authorCallsign: 'Me', type: 'text', ciphertext: body.ciphertext, nonce: body.nonce, metadata: body.metadata ?? null, timestamp: new Date().toISOString() });
        return answer(201, { success: true, message: { id: body.clientId } });
    }
    if (method === 'POST' && [`/api/marketplace/posts/${g}/chat/message`, `/api/enterprise/${g}/thread/message`, `/api/treasury/${g}/thread/message`].includes(p)) {
        s.wordsIn.push(body.text);
        return answer(200, { success: true, message: { id: body.clientId } });
    }
    if (method === 'POST' && (p === '/api/messages/send' || p === '/api/messages/edit') && body.nonce === 'plaintext-v1') s.wordsIn.push(Buffer.from(body.ciphertext, 'base64').toString());
    if (method === 'POST' && p === '/api/messages/send') return answer(200, { success: true, message: { id: body.id, ciphertext: body.ciphertext, nonce: body.nonce, timestamp: new Date().toISOString() } });
    if (p === `${at}/members/${me.publicKey}` && method === 'DELETE') return answer(200, { success: true });
    if (method === 'POST' && (p === `${at}/chat/report` || p === `${at}/chat/remove`)) return answer(200, { success: true });
    if (method === 'POST' && p === '/api/messages/mute') return answer(200, { success: true, mute: { conversationId: body.conversationId, mutedUntil: '2026-11-23T08:00:00.000Z', always: false } });
    if (method === 'POST' && ['/api/messages/react', '/api/messages/delete', '/api/messages/edit', '/api/messages/mark-read'].includes(p)) return answer(200, { success: true, message: { id: body.messageId } });
    return answer(404, { error: 'not here' });
});

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

let phoneN = 0;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const fileOn = (file: string) => path.join(h.dir, file);
function rowsOf(file: string): Record<string, unknown[]> | null {
    if (!fs.existsSync(fileOn(file))) return null;
    const sql = new DatabaseSync(fileOn(file));
    try {
        return Object.fromEntries(TABLES.map((t) => [t, sql.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((r) => ({ ...(r as object) }))]));
    } finally {
        sql.close();
    }
}
const storedFor = (file: string) => Object.fromEntries([...h.store.entries()].filter(([k]) => k.includes(file)).sort());
function into(file: string, run: (sql: DatabaseSync) => void): void {
    const sql = new DatabaseSync(fileOn(file));
    try { run(sql); } finally { sql.close(); }
}
/** A group's row and its people, as a visit there when the phone was set to it left them. */
const groupRow = (file: string, id: string, type = 'group_thread') => into(file, (sql) => {
    sql.prepare('INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, type, peer.publicKey, '2026-11-20T00:00:00.000Z');
    for (const pk of [me.publicKey, peer.publicKey]) sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, pk);
});

/** A line of mine in A's group, sealed there when the phone was set to A, with what opens it; and one of Dana's. */
let mine: { id: string; metadata: any };

/** A phone that used its group in A (sealed a line there), then was set to B, whose file is a copy of A's. A is away. */
async function phoneOnB(): Promise<void> {
    await db.closeDB();
    _resetGroupKeySessionForTests();
    db._resetDmPeerPinsForTests();
    db._resetChatsInPlaceForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    me = person();
    peer = person();
    h.me = { ...me };
    g = randomUUID();
    servers = { [A]: { epochs: [], lines: [], wordsIn: [], left: false }, [B]: { epochs: [], lines: [], wordsIn: [], left: true }, [C]: { epochs: [], lines: [], wordsIn: [], left: true } };
    hold = null;
    h.cut = null;
    h.reads = null;
    (globalThis as any).fetch = fetchMock;
    await switchPhoneTo(A);
    await db.getDb();
    groupRow(A_FILE, g);
    const id = randomUUID();
    await db.postGroupChatMessage(g, 'my first line', id, null, { after: null });
    mine = { id, metadata: { epoch: 1 } };
    expect(servers[A].lines.length).toBe(1);
    await db.closeDB();
    fs.copyFileSync(fileOn(A_FILE), fileOn(B_FILE));
    await switchPhoneTo(B);
    await settle();
    asked = [];
}

beforeEach(async () => { await phoneOnB(); });

/** The thread as the screen opens it in place: its lines, named and opened by that community's keys. */
async function opened(community: string | undefined): Promise<{ thread: OpenedGroupThread; shown: any[] }> {
    const chat = await db.getGroupChat(g, undefined, undefined, community);
    const ring = await db.groupScreenKeyringFor(g, community);
    ring.noteShownRoster([me.publicKey, peer.publicKey]);
    const thread = await openGroupThread(ring, chat, [{ memberPubkey: me.publicKey, callsign: 'Me' } as any, { memberPubkey: peer.publicKey, callsign: 'Dana' } as any]);
    return { thread, shown: groupChatShownLines(chat.messages, { locked: true, thread, me: me.publicKey, kind: 'group' }) };
}

interface Act {
    name: string;
    /** The request the action is for, at A. */
    to: { method: string; path: () => string };
    run: (community: string | undefined) => Promise<unknown>;
    /** What shows it happened, at A's server or in A's file. */
    landed?: (result: any) => boolean;
}
const post = (p: () => string) => ({ method: 'POST', path: p });
const ACTS: Act[] = [
    { name: 'read (getGroupChat, opened by its keys)', to: { method: 'GET', path: () => `/api/groups/${g}/chat` }, run: (c) => opened(c), landed: (r) => r.shown.some((m: any) => m.text === 'my first line' && m.outgoing) },
    { name: 'its people (fetchGroupDetails)', to: { method: 'GET', path: () => `/api/groups/${g}/members` }, run: (c) => db.fetchGroupDetails(g, c), landed: (r) => r?.members?.length === 2 },
    {
        name: 'reply (postGroupChatMessage)', to: post(() => `/api/groups/${g}/chat/message`),
        run: (c) => db.postGroupChatMessage(g, 'a reply in place', randomUUID(), mine.id, { after: mine.id }, c),
        landed: () => servers[A].lines.length === 2 && servers[A].wordsIn.length === 0 && String(servers[A].lines[1].nonce).length > 0,
    },
    { name: 'react (toggleMessageReactionApi)', to: post(() => '/api/messages/react'), run: (c) => db.toggleMessageReactionApi(mine.id, me.publicKey, '👍', c, g) },
    { name: 'edit (editThreadMessage)', to: post(() => '/api/messages/edit'), run: (c) => db.editThreadMessage(mine.id, 'edited in place', { groupId: g, metadata: mine.metadata, locked: true }, c) },
    { name: 'delete (deleteMessageApi)', to: post(() => '/api/messages/delete'), run: (c) => db.deleteMessageApi(mine.id, c, g) },
    { name: 'a convenor removes a line (removeGroupChatMessage)', to: post(() => `/api/groups/${g}/chat/remove`), run: (c) => db.removeGroupChatMessage(g, mine.id, c) },
    { name: 'mark read (markThreadReadOnNode)', to: post(() => '/api/messages/mark-read'), run: (c) => db.markThreadReadOnNode(g, me.publicKey, c) },
    { name: 'mute (muteChatApi)', to: post(() => '/api/messages/mute'), run: (c) => db.muteChatApi(g, '8h', c), landed: (r) => !!r?.mute },
    {
        name: 'report to the moderators (reportGroupChatLine)', to: post(() => `/api/groups/${g}/chat/report`),
        run: async (c) => {
            const { thread } = await opened(c);
            return db.reportGroupChatLine(g, mine.id, thread.views.get(mine.id), 'Spam or scam', c);
        },
        landed: () => asked.some((r) => r.url.endsWith('/chat/report') && r.body?.disclosure?.epoch === 1),
    },
    { name: 'leave the group (leaveGroupApi)', to: { method: 'DELETE', path: () => `/api/groups/${g}/members/${me.publicKey}` }, run: (c) => db.leaveGroupApi(g, me.publicKey, undefined, c), landed: (r) => r === true },
];

/** Each way the phone can stand to the group's community: what it is set to first, the community named, and what is expected. */
const STANDS: Array<{ name: string; first?: () => Promise<void> | void; named: string | undefined; holds: boolean; refused: boolean; meanwhile?: () => Promise<void> }> = [
    { name: 'in use, no community named', first: () => switchPhoneTo(A).then(() => {}), named: undefined, holds: false, refused: false },
    { name: 'in use, named by a screen that opened in place before the switch', first: () => switchPhoneTo(A).then(() => {}), named: A, holds: true, refused: false },
    { name: 'a held member', named: A, holds: true, refused: false },
    { name: 'a held member, the phone switching to a third community meanwhile', named: A, holds: true, refused: false, meanwhile: () => switchPhoneTo(C).then(() => {}) },
    { name: 'a held guest\'s look', first: () => { h.store.set('beanpool_guest_nodes', JSON.stringify([A])); }, named: A, holds: true, refused: true },
    { name: 'the chat left, and not back', first: async () => { db.enterChatInPlace(A); await db.leaveChatInPlace(A); }, named: A, holds: false, refused: true },
    { name: 'the community taken off the phone', first: async () => { await removeSavedNode(A); await removeCommunityCaches([A]); }, named: A, holds: true, refused: true },
];

describe('a group in place: every action goes to its own community, signed for it, or is refused in words with nothing asked', () => {
    const cases = ACTS.flatMap((a) => STANDS.map((s) => [a.name, s.name, a, s] as const));
    it.each(cases)('%s x %s', async (_a, _s, act, stand) => {
        await stand.first?.();
        await settle();
        if (stand.holds) db.enterChatInPlace(A);
        const others = () => ({ B: rowsOf(B_FILE), C: rowsOf(C_FILE), storedB: storedFor(B_FILE), storedC: storedFor(C_FILE) });
        let before = others();
        asked = [];
        let go: () => void = () => {};
        let seen: Promise<void> | null = null;
        if (stand.meanwhile) {
            let sawIt!: () => void;
            seen = new Promise((r) => { sawIt = r; });
            hold = { matches: (m, p) => m === act.to.method && p === act.to.path(), seen: () => sawIt(), go: new Promise((r) => { go = r; }), used: false };
        }
        let result: any;
        let thrown: any = null;
        const running = act.run(stand.named).then((r) => { result = r; }, (e) => { thrown = e; });
        if (seen && stand.meanwhile) {
            await seen;
            await stand.meanwhile();
            await settle();
            before = others();
            go();
        }
        await running;
        await settle();
        const name = act.to.method + ' ' + act.to.path();
        // Every request of any kind, signed for its own address, and to A alone: nothing to the community in use, or any other.
        for (const r of asked.filter((x) => !new URL(x.url).pathname.startsWith('/api/community') && /\/api\/(groups|messages)/.test(x.url))) {
            expect(new URL(r.url).origin, `${r.method} ${r.url}`).toBe(A);
            expect(r.signed, 'signed for the address it went to').toBe(`${r.method} ${r.url}`);
        }
        if (stand.refused) {
            // fetchGroupDetails answers null (its screen keeps what it had); every other says why, and nothing was asked.
            if (act.name.startsWith('its people')) expect(result).toBeNull();
            else {
                expect(thrown, 'refused').not.toBeNull();
                expect(db.isNoCopyInPlace(thrown), String(thrown?.message)).toBe(true);
                expect(String(thrown.message)).toBe('This phone has switched community since this chat was opened.');
            }
            expect(asked.filter((x) => /\/api\/(groups|messages)/.test(x.url)).map((x) => `${x.method} ${x.url}`), 'nothing asked').toEqual([]);
        } else {
            expect(asked.map((x) => `${x.method} ${new URL(x.url).pathname}`), name).toContain(name);
            // Once the phone switched away mid-read, what is left of it may be refused, never sent elsewhere.
            if (!stand.meanwhile) {
                expect(thrown, String(thrown?.message ?? '')).toBeNull();
                if (act.landed) expect(act.landed(result), `${act.name} happened`).toBe(true);
            }
        }
        // Nothing of it in any other community's file or stored state (a set-to-A row's own A file apart).
        expect(others()).toEqual(before);
        if (stand.holds) await db.leaveChatInPlace(A);
        if (stand.named && !stand.first) expect(db.heldCopyFiles(), 'left, the copy open in place closes').not.toContain(A_FILE);
    });

    it('every action and every stand is in the table (77 rows)', () => {
        expect(cases.length).toBe(11 * 7);
    });

    it('a reply in place is sealed under A\'s epoch, in A\'s memory only, and opens for the other member; nothing readable left the phone', async () => {
        db.enterChatInPlace(A);
        // Dana made nothing: A's server lists epoch 1, mine. A new one, sealed in place, is under the same epoch.
        await db.postGroupChatMessage(g, 'sealed in place', randomUUID(), null, { after: mine.id }, A);
        const line = servers[A].lines[1];
        expect(line.metadata.epoch).toBe(1);
        expect(servers[A].wordsIn).toEqual([]);
        expect(JSON.stringify(line)).not.toContain('sealed in place');
        // B's file, a copy of A's before the phone was set to it, holds A's old epoch and gets nothing new.
        expect((rowsOf(B_FILE)!.group_chat_epochs as any[]).length).toBe(1);
        await db.leaveChatInPlace(A);
    });

    it('once the chat is left its keys\' memory is closed: the group\'s keyring refuses rather than read another file', async () => {
        db.enterChatInPlace(A);
        const ring = await db.groupKeyringFor(g, A);
        expect(await ring.seenLocked()).toBe(true);
        await db.leaveChatInPlace(A);
        _resetGroupKeySessionForTests();
        const { groupKeyring } = await import('../group-chat-keys');
        const fresh = groupKeyring(A, { ...h.me }, g, db.groupKeyStore(A));
        await expect(fresh.seenLocked()).rejects.toMatchObject({ code: 'store' });
        // B, whose file holds the same group's keys (a copy), never stands in for A's.
        expect(asked.filter((r) => r.url.startsWith(B) && r.url.includes('/api/groups'))).toEqual([]);
    });

    it('with no chat held there, the keys\' memory of another community is never opened: it refuses, and no copy of A opens', async () => {
        _resetGroupKeySessionForTests();
        const { groupKeyring } = await import('../group-chat-keys');
        await expect(groupKeyring(A, { ...h.me }, g, db.groupKeyStore(A)).seenLocked()).rejects.toMatchObject({ code: 'store' });
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });

    it('a mute in place of an id A holds as neither a direct chat nor a group\'s (an event\'s, an enterprise\'s, unknown): refused, nothing asked or remembered', async () => {
        const event = randomUUID();
        const enterprise = randomUUID();
        groupRow(A_FILE, event, 'event_thread');
        groupRow(A_FILE, enterprise, 'enterprise_thread');
        db.enterChatInPlace(A);
        for (const id of [event, enterprise, randomUUID()]) {
            asked = [];
            const thrown = await db.muteChatApi(id, '8h', A).then(() => null, (e) => e);
            expect(db.isNoCopyInPlace(thrown)).toBe(true);
            expect(asked).toEqual([]);
            expect(db.getKnownChatMute(id)).toBeNull();
        }
        await db.leaveChatInPlace(A);
    });

    it('a send begun as the chat is left still finishes in its own community (whileChatInPlace)', async () => {
        db.enterChatInPlace(A);
        const sending = db.whileChatInPlace(A, () => db.postGroupChatMessage(g, 'as I leave', randomUUID(), null, { after: mine.id }, A));
        await db.leaveChatInPlace(A);
        await sending;
        expect(servers[A].lines.length).toBe(2);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });
});

describe('what opens in place (the route), and the list that names a group', () => {
    it.each([
        ['a group A\'s copy keeps', (): string => g, 'in-place', 'group'],
        ['the same id in capitals (a link, a push)', (): string => g.toUpperCase(), 'in-place', 'group'],
        ['an id A\'s copy doesn\'t hold', (): string => randomUUID(), 'move', undefined],
        ['an event\'s chat A\'s copy keeps', (): string => { const id = randomUUID(); groupRow(A_FILE, id, 'event_thread'); return id; }, 'move', undefined],
        ['an enterprise\'s thread A\'s copy keeps', (): string => { const id = randomUUID(); groupRow(A_FILE, id, 'enterprise_thread'); return id; }, 'move', undefined],
    ] as const)('%s: %s, %s', async (_name, id, open, kind) => {
        const route: any = await chatInPlaceRoute(me.publicKey, id(), A);
        expect([route.open, route.kind]).toEqual([open, kind]);
        if (open === 'in-place') expect([route.community, route.name]).toEqual([A, route.name]);
        await settle();
        expect(db.heldCopyFiles()).toEqual([]);
    });

    it('a guest\'s look, and a community the phone doesn\'t keep, open nothing; in use is the ordinary route', async () => {
        expect((await chatInPlaceRoute(me.publicKey, g, C)).open).toBe('nothing');
        expect((await chatInPlaceRoute(me.publicKey, g, B)).open).toBe('here');
        h.store.set('beanpool_guest_nodes', JSON.stringify([A]));
        expect((await chatInPlaceRoute(me.publicKey, g, A)).open).toBe('nothing');
    });

    it('a group joined on another device: opens in place once A\'s own list named it this run, never on B\'s word, and not once it is no longer named', async () => {
        into(A_FILE, (sql) => { sql.prepare('DELETE FROM conversations WHERE id = ?').run(g); sql.prepare('DELETE FROM group_chat_key_state').run(); sql.prepare('DELETE FROM group_chat_epochs').run(); });
        expect(((await chatInPlaceRoute(me.publicKey, g, A)) as any).open).toBe('move');
        // B's list names the same id: nothing of A's opens on it.
        servers[B].left = false;
        await db.fetchHeldYourGroups(me.publicKey, B);
        expect(((await chatInPlaceRoute(me.publicKey, g, A)) as any).open).toBe('move');
        const items = await db.fetchHeldYourGroups(me.publicKey, A);
        expect(items?.map((i) => [i.kind, i.conversationId, i.avatarUrl])).toEqual([['group', g, `${A}/uploads/garden.jpg`], ['event', 'event-1', null]]);
        expect(asked.filter((r) => r.url.endsWith('/api/your-groups')).map((r) => r.signed)).toEqual([`GET ${B}/api/your-groups`, `GET ${A}/api/your-groups`]);
        expect((await chatInPlaceRoute(me.publicKey, g, A)) as any).toMatchObject({ open: 'in-place', kind: 'group', community: A });
        servers[A].left = true;
        await db.fetchHeldYourGroups(me.publicKey, A);
        expect(((await chatInPlaceRoute(me.publicKey, g, A)) as any).open).toBe('move');
        // Another account's answer is nobody's: it names nothing.
        servers[A].left = false;
        const was = h.me;
        h.me = { ...person() };
        expect(await db.fetchHeldYourGroups(was.publicKey, A)).toBeNull();
        h.me = was;
        expect(((await chatInPlaceRoute(me.publicKey, g, A)) as any).open).toBe('move');
    });

    it('Talk\'s rows: A\'s group with its own community and count, nothing for the community in use, a guest\'s look or an event', async () => {
        servers[B].left = false;
        await heldGroups.refresh(me.publicKey);
        expect(heldGroups.getState().map((r) => [r.community, r.conversationId, r.unreadCount, r.key])).toEqual([[A, g, 2, `held-group:${A_FILE}:${g}`]]);
        expect(asked.filter((r) => r.url.endsWith('/api/your-groups')).map((r) => r.url)).toEqual([`${A}/api/your-groups`]);
        // Reading it in place clears its own row.
        heldGroups.at(A).markRead(g);
        expect(heldGroups.getState()[0].unreadCount).toBe(0);
        // The phone set to A: A's groups are Talk's own, so the held row goes before any answer.
        await switchPhoneTo(A);
        await heldGroups.refresh(me.publicKey);
        expect(heldGroups.getState().filter((r) => r.community === A)).toEqual([]);
        await switchPhoneTo(B);
        for (const mark of [A, 'HTTPS://Riverside.example/some/path']) {
            h.store.delete('beanpool_guest_nodes');
            await heldGroups.refresh(me.publicKey);
            expect(heldGroups.getState().length, 'a member again').toBe(1);
            h.store.set('beanpool_guest_nodes', JSON.stringify([mark]));
            await heldGroups.refresh(me.publicKey);
            expect(heldGroups.getState(), `a guest's mark spelled ${mark}`).toEqual([]);
        }
    });

    it('two asks at once (Chat opens as a count changes): the first answers and the second finds no signal, and the rows of the first stay', async () => {
        // Two held communities, as on a phone with three: with one, the second ask always finds the first's list made.
        await switchPhoneTo(C);
        await switchPhoneTo(B);
        const realFetch = (globalThis as any).fetch;
        let n = 0;
        (globalThis as any).fetch = async (url: string, init: any) => {
            if (String(url) === `${A}/api/your-groups` && ++n > 1) throw new Error('no signal');
            return realFetch(url, init);
        };
        await Promise.all([heldGroups.refresh(me.publicKey), heldGroups.refresh(me.publicKey)]);
        (globalThis as any).fetch = realFetch;
        expect(n).toBe(2);
        expect(heldGroups.getState().map((r) => r.conversationId)).toEqual([g]);
        // Mutation: each ask works the communities out for itself -> the second makes A's list again, empty, and the first's is dropped.
    });

    it('a group left in place stays gone while its community can\'t be asked, and comes back only when that community lists it again', async () => {
        await heldGroups.refresh(me.publicKey);
        const realFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => { throw new Error('no signal'); };
        heldGroups.forget(A, g);
        expect(heldGroups.getState()).toEqual([]);
        await heldGroups.refresh(me.publicKey);
        await settle();
        expect(heldGroups.getState(), 'still gone, the ask having failed').toEqual([]);
        (globalThis as any).fetch = realFetch;
        // An answer from before the leave still lists it: no row. One without it: forgotten. Listed again after that: let back in.
        await heldGroups.refresh(me.publicKey);
        expect(heldGroups.getState()).toEqual([]);
        servers[A].left = true;
        await heldGroups.refresh(me.publicKey);
        servers[A].left = false;
        await heldGroups.refresh(me.publicKey);
        expect(heldGroups.getState().map((r) => r.conversationId), 'let back in since').toEqual([g]);
    });

    it('a list wanted for one account is never asked with another\'s key', async () => {
        const was = me.publicKey;
        h.me = { ...person() };
        asked = [];
        expect(await db.fetchHeldYourGroups(was, A)).toBeNull();
        expect(asked.filter((r) => r.url.endsWith('/api/your-groups'))).toEqual([]);
    });

    it('a list whose account left while it was on its way is nobody\'s: not handed back, and it names no group', async () => {
        into(A_FILE, (sql) => { for (const t of ['conversations', 'group_chat_key_state', 'group_chat_epochs']) sql.prepare(`DELETE FROM ${t}`).run(); });
        let seen!: () => void;
        let go!: () => void;
        const asking = new Promise<void>((r) => { seen = r; });
        hold = { matches: (m, p) => m === 'GET' && p === '/api/your-groups', seen: () => seen(), go: new Promise((r) => { go = r; }), used: false };
        const was = h.me;
        const answering = db.fetchHeldYourGroups(me.publicKey, A);
        await asking;
        h.me = { ...person() };
        go();
        expect(await answering).toBeNull();
        h.me = was;
        expect(((await chatInPlaceRoute(me.publicKey, g, A)) as any).open).toBe('move');
    });

    it('a community that doesn\'t answer keeps its rows; another account sees none of them', async () => {
        await heldGroups.refresh(me.publicKey);
        expect(heldGroups.getState().length).toBe(1);
        const realFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => { throw new Error('no signal'); };
        await heldGroups.refresh(me.publicKey);
        expect(heldGroups.getState().length).toBe(1);
        (globalThis as any).fetch = realFetch;
        const next = person();
        h.me = { ...next };
        servers[A].left = true;
        await heldGroups.refresh(next.publicKey);
        expect(heldGroups.getState()).toEqual([]);
    });
});

describe('the DM guard in place: A\'s own pins and list decide, never the community in use\'s', () => {
    const pinned = (file: string, id: string) => h.store.set(dmConversationsSeenStoreKey(me.publicKey, file), JSON.stringify([id]));
    /** A phone that never held the group's keys in A: none stored there, none opened this session. */
    const unheld = () => {
        into(A_FILE, (sql) => { sql.prepare('DELETE FROM group_chat_key_state').run(); sql.prepare('DELETE FROM group_chat_epochs').run(); });
        forgetGroupKeys();
    };

    it('an id A\'s guard list keeps as a DM, its row relisted there as a group\'s: not opened as a group, and nothing sealed, sent or asked', async () => {
        unheld();
        pinned(A_FILE, g);
        expect(await db.heldChatIsGroup(me.publicKey, A, g)).toBe(false);
        db.enterChatInPlace(A);
        // A mute is a direct chat's too (S2): this id is A's DM, and it is muted as one, by A.
        for (const act of ACTS.filter((a) => a.to.method === 'POST' && !a.name.startsWith('mute'))) {
            asked = [];
            const thrown: any = await act.run(A).then(() => null, (e) => e);
            expect(db.isNoCopyInPlace(thrown), `${act.name}: ${thrown?.message}`).toBe(true);
            expect(asked.filter((x) => /\/api\/(groups|messages)/.test(x.url)), act.name).toEqual([]);
        }
        await db.leaveChatInPlace(A);
    });

    it('the strict check at the keys: a DM A knows only in other capitals gets no group keys there, though the route\'s read let the id through', async () => {
        unheld();
        into(A_FILE, (sql) => {
            sql.prepare('INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, ?, ?, ?)').run(g.toUpperCase(), 'dm', peer.publicKey, '2026-11-20T00:00:00.000Z');
        });
        db.enterChatInPlace(A);
        asked = [];
        await expect(db.postGroupChatMessage(g, 'not to a DM', randomUUID(), null, { after: null }, A)).rejects.toMatchObject({ message: GROUP_KEYS_FOR_DM_TEXT });
        expect(asked.filter((x) => x.method === 'POST')).toEqual([]);
        expect((rowsOf(A_FILE)!.group_chat_epochs as any[])).toEqual([]);
        await db.leaveChatInPlace(A);
    });

    it('A\'s pins unreadable: a group whose keys A never held sends nothing; one whose keys it holds still does', async () => {
        h.store.set(dmPeerPinsStoreKey(me.publicKey, A_FILE), '{ this is not a pin store');
        db._resetDmPeerPinsForTests();
        db.enterChatInPlace(A);
        await db.postGroupChatMessage(g, 'held, so its keys vouch for it', randomUUID(), null, { after: mine.id }, A);
        expect(servers[A].lines.length).toBe(2);
        await db.leaveChatInPlace(A);
        unheld();
        db.enterChatInPlace(A);
        asked = [];
        await expect(db.postGroupChatMessage(g, 'never held, pins unread', randomUUID(), null, { after: null }, A)).rejects.toMatchObject({ name: 'DmPinStoreError' });
        expect(asked.filter((x) => x.method === 'POST')).toEqual([]);
        await db.leaveChatInPlace(A);
    });

    it('B keeps the same id as a DM: A\'s group still reads and sends in place, and B\'s list and pins are untouched', async () => {
        pinned(B_FILE, g);
        const before = storedFor(B_FILE);
        db.enterChatInPlace(A);
        await db.postGroupChatMessage(g, 'A\'s own guard', randomUUID(), null, { after: mine.id }, A);
        expect((await opened(A)).shown.map((m) => m.text)).toEqual(['my first line', 'A\'s own guard']);
        expect(storedFor(B_FILE)).toEqual(before);
        await db.leaveChatInPlace(A);
    });

    it('a line of a direct chat A holds is never reacted to or deleted under a group\'s name', async () => {
        const dm = randomUUID();
        const line = randomUUID();
        into(A_FILE, (sql) => {
            sql.prepare('INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, ?, ?, ?)').run(dm, 'dm', peer.publicKey, '2026-11-20T00:00:00.000Z');
            sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)').run(line, dm, me.publicKey, 'x', 'plaintext-v1', 'text', '2026-11-20T00:00:00.000Z');
        });
        db.enterChatInPlace(A);
        for (const run of [() => db.toggleMessageReactionApi(line, me.publicKey, '👍', A, g), () => db.deleteMessageApi(line, A, g)]) {
            asked = [];
            const thrown = await run().then(() => null, (e) => e);
            expect(db.isNoCopyInPlace(thrown)).toBe(true);
            expect(asked).toEqual([]);
        }
        await db.leaveChatInPlace(A);
    });

    it('someone else\'s removal is never done in place', async () => {
        db.enterChatInPlace(A);
        asked = [];
        await expect(db.leaveGroupApi(g, peer.publicKey, undefined, A)).rejects.toThrow();
        expect(asked.filter((x) => x.method === 'DELETE')).toEqual([]);
        await db.leaveChatInPlace(A);
    });
});

// ── What a group's key ring has in memory and what its file has never part (review of #3358, F1) ─────────────────────

/** Dana makes the group's next key at A, and writes under it. */
async function danaWrites(words: string): Promise<void> {
    const s = servers[A];
    const epoch = s.epochs.length + 1;
    const { record, groupKey } = await makeEpochRecord({
        myEdPrivHex: peer.privateKey, groupId: g, epoch, reason: 'rotate', subject: null, createdAt: new Date().toISOString(), recipients: [me.publicKey, peer.publicKey],
    });
    s.epochs.push(record);
    const id = randomUUID();
    const line = sealLine(words, { myEdPrivHex: peer.privateKey, groupKey, groupId: g, epoch, messageId: id, replyToId: null, after: null });
    s.lines.push({ id, authorPubkey: peer.publicKey, authorCallsign: 'Dana', type: 'text', ciphertext: line.ciphertext, nonce: line.nonce, metadata: { epoch }, timestamp: new Date().toISOString() });
}
/** What A's file holds of the group's keys: each epoch with a wrap, the cursor, the highest, whether it is marked locked, the lines with a first signer. */
function onDisk() {
    const r = rowsOf(A_FILE)!;
    const st = (r.group_chat_key_state as any[])[0];
    return { epochs: (r.group_chat_epochs as any[]).filter((e) => e.wrap).map((e) => e.epoch), after: st?.after ?? 0, highest: st?.highest ?? 0, locked: !!st, signers: r.group_line_signers.length };
}
/** Everything this run's ring holds that A's file doesn't (a first signer still to be put apart), and any key A's cursor has passed and its file lacks. */
function parted(): string[] {
    const ring = groupKeyring(A, { ...h.me }, g, db.groupKeyStore(A)) as any;
    const r = rowsOf(A_FILE)!;
    const st = (r.group_chat_key_state as any[])[0];
    const epochs = new Map((r.group_chat_epochs as any[]).map((e) => [e.epoch as number, e]));
    const signers = new Set((r.group_line_signers as any[]).map((x) => x.message_id));
    const out: string[] = [];
    for (const e of ring.epochs.values()) {
        if (!epochs.has(e.epoch)) out.push(`epoch ${e.epoch}`);
        else if (e.wrap && !epochs.get(e.epoch).wrap) out.push(`wrap ${e.epoch}`);
    }
    for (const n of ring.keys.keys()) if (!epochs.get(n)?.wrap) out.push(`key ${n}`);
    if (ring.after > (st?.after ?? 0)) out.push('cursor');
    if (ring.highest > (st?.highest ?? 0)) out.push('highest');
    if (ring.lockKept && !st) out.push('lock');
    for (const id of ring.signers.keys()) if (!ring.unsavedSigners?.has(id) && !signers.has(id)) out.push(`signer ${id}`);
    for (let n = 1; n <= (st?.after ?? 0); n++) if (!epochs.has(n)) out.push(`the cursor past epoch ${n}`);
    return out;
}
const texts = (o: { shown: any[] }) => o.shown.map((m) => m.text);
/** The app starts again, set to `to`: what was in memory is gone, and each file is as it was. */
async function restart(to = B): Promise<void> {
    await db.closeDB();
    _resetGroupKeySessionForTests();
    db._resetDmPeerPinsForTests();
    db._resetChatsInPlaceForTests();
    h.cut = null;
    await switchPhoneTo(to);
    await settle();
}
/** A copy that holds none of the group's keys (it was joined on another device): its row, and no key, cursor, mark or signer. */
function unheldCopy(): void {
    into(A_FILE, (sql) => { for (const t of ['group_chat_key_state', 'group_chat_epochs', 'group_line_signers', 'group_line_verdicts']) sql.prepare(`DELETE FROM ${t}`).run(); });
    _resetGroupKeySessionForTests();
}
/** The next request that matches is held: `asked` once it is on its way, `let go` to answer it. */
function holdNext(matches: (method: string, p: string) => boolean): { asked: Promise<void>; letGo: () => void } {
    let seen!: () => void;
    let letGo!: () => void;
    const askedNow = new Promise<void>((r) => { seen = r; });
    hold = { matches, seen: () => seen(), go: new Promise((r) => { letGo = r; }), used: false };
    return { asked: askedNow, letGo };
}
const keysAsked = (m: string, p: string) => m === 'GET' && p === `/api/groups/${g}/keys`;

describe('a group\'s keys: every write x every way it is refused, then opened again, a restart, and read', () => {
    const WRITES = [
        { name: 'a key (putEpochs)', sql: /INTO group_chat_epochs/, copies: ['holds', 'lacks'] },
        { name: 'the cursor (setCursor)', sql: /INTO group_chat_key_state \(group_id, after\)/, copies: ['holds', 'lacks'] },
        { name: 'the highest epoch (raiseHighest)', sql: /INTO group_chat_key_state \(group_id, highest\)/, copies: ['holds', 'lacks'] },
        { name: 'a line\'s first signer (putSigner)', sql: /INTO group_line_signers/, copies: ['holds', 'lacks'] },
        { name: 'the mark that it is locked (noteLocked)', sql: /INTO group_chat_key_state \(group_id\) VALUES/, copies: ['lacks'] },
        { name: 'a verdict (addVerdict; worked out again)', sql: /INTO group_line_verdicts/, copies: ['holds', 'lacks'] },
    ];
    const CUTS = [
        { name: 'SQLite refuses it once', refuse: true, times: 1, leave: false },
        { name: 'SQLite refuses it until the chat is opened again', refuse: true, times: 1_000, leave: false },
        { name: 'the chat is left as it is written, and all after it is refused', refuse: false, times: 1, leave: true },
    ];
    const rows = WRITES.flatMap((w) => CUTS.flatMap((c) => w.copies.map((copy) => [w.name, c.name, copy, w, c] as const)));
    it.each(rows)('%s x %s x a copy that %s its keys', async (_w, _c, copy, write, cut) => {
        if (copy === 'lacks') unheldCopy();
        await danaWrites('under key 2');
        db.enterChatInPlace(A);
        let hits = 0;
        const leaving: Promise<void>[] = [];
        h.cut = { file: A_FILE, sql: write.sql, times: cut.times, refuse: cut.refuse, hit: () => { if (++hits === 1 && cut.leave) leaving.push(db.leaveChatInPlace(A)); } };
        await opened(A).catch(() => null);
        await settle();
        expect(hits, 'the write was asked').toBeGreaterThan(0);
        expect(parted(), 'refused').toEqual([]);
        h.cut = null;
        if (cut.leave) await Promise.all(leaving);
        else await db.leaveChatInPlace(A);

        db.enterChatInPlace(A);
        expect(texts(await opened(A)), 'opened again').toEqual(['my first line', 'under key 2']);
        expect(parted()).toEqual([]);
        await danaWrites('under key 3');
        expect(texts(await opened(A)), 'a key later').toEqual(['my first line', 'under key 2', 'under key 3']);
        expect(parted()).toEqual([]);
        await db.leaveChatInPlace(A);
        await restart();
        expect(onDisk()).toEqual({ epochs: [1, 2, 3], after: 3, highest: 3, locked: true, signers: 3 });
        db.enterChatInPlace(A);
        expect(texts(await opened(A)), 'after the restart').toEqual(['my first line', 'under key 2', 'under key 3']);
        await db.leaveChatInPlace(A);
        // B, whose file holds the same group's keys (a copy), got none of it.
        expect((rowsOf(B_FILE)!.group_chat_epochs as any[]).map((e) => e.epoch)).toEqual([1]);
    });

    it('every write and every way are in the table (33 rows)', () => {
        expect(rows.length).toBe(5 * 3 * 2 + 1 * 3);
    });

    const CUT_MID_SYNC = [
        { name: 'in place, Back pressed with the keys on their way', start: async () => { db.enterChatInPlace(A); }, away: () => db.leaveChatInPlace(A), back: async () => { db.enterChatInPlace(A); }, at: A as string | undefined, to: B },
        { name: 'in use, the phone set to another community with the keys on their way', start: async () => { await switchPhoneTo(A); }, away: () => switchPhoneTo(B).then(() => {}), back: async () => { await switchPhoneTo(A); }, at: undefined as string | undefined, to: A },
        { name: 'in place, the phone set to a third community and the chat left with the keys on their way', start: async () => { db.enterChatInPlace(A); }, away: async () => { await switchPhoneTo(C); await db.leaveChatInPlace(A); }, back: async () => { await switchPhoneTo(B); db.enterChatInPlace(A); }, at: A as string | undefined, to: B },
    ];
    it.each(CUT_MID_SYNC.flatMap((c) => (['holds', 'lacks'] as const).map((copy) => [c.name, copy, c] as const)))('%s x a copy that %s its keys: opened again, a key later, a restart, and every line reads', async (_n, copy, c) => {
        if (copy === 'lacks') unheldCopy();
        await danaWrites('under key 2');
        await c.start();
        const keys = holdNext(keysAsked);
        const opening = opened(c.at).catch(() => null);
        await keys.asked;
        await c.away();
        keys.letGo();
        await opening;
        await settle();
        expect(parted()).toEqual([]);
        await c.back();
        expect(texts(await opened(c.at))).toEqual(['my first line', 'under key 2']);
        await danaWrites('under key 3');
        expect(texts(await opened(c.at))).toEqual(['my first line', 'under key 2', 'under key 3']);
        if (c.at) await db.leaveChatInPlace(A);
        await restart(c.to);
        expect(onDisk()).toEqual({ epochs: [1, 2, 3], after: 3, highest: 3, locked: true, signers: 3 });
        if (c.at) db.enterChatInPlace(A);
        expect(texts(await opened(c.at))).toEqual(['my first line', 'under key 2', 'under key 3']);
        if (c.at) await db.leaveChatInPlace(A);
    });

    it('a key this phone made that its file won\'t keep seals nothing: the line is not sent; asked again it goes, under that key, and a restart reads it', async () => {
        servers[A].stale = true;
        db.enterChatInPlace(A);
        for (const sql of [/INTO group_chat_epochs/, /\(group_id, highest\)/, /\(group_id, after\)/]) {
            servers[A].stale = true;
            h.cut = { file: A_FILE, sql, times: 1, refuse: true, hit: () => {} };
            const lines = servers[A].lines.length;
            await expect(db.postGroupChatMessage(g, 'not on a key it can\'t keep', randomUUID(), null, { after: mine.id }, A)).rejects.toMatchObject({ code: 'store', message: GROUP_KEY_STORE_UNREAD_TEXT });
            expect(h.cut.times, 'refused').toBe(0);
            h.cut = null;
            expect(servers[A].lines.length, String(sql)).toBe(lines);
            expect(parted()).toEqual([]);
            await db.postGroupChatMessage(g, 'now it keeps it', randomUUID(), null, { after: mine.id }, A);
            expect(servers[A].lines[lines].metadata.epoch).toBe(servers[A].epochs.length);
            expect(parted()).toEqual([]);
        }
        await db.leaveChatInPlace(A);
        await restart();
        db.enterChatInPlace(A);
        expect(texts(await opened(A))).toEqual(['my first line', 'now it keeps it', 'now it keeps it', 'now it keeps it']);
        await db.leaveChatInPlace(A);
        expect(servers[A].wordsIn).toEqual([]);
    });

    it('a wrap to refuse that the file won\'t drop is kept, not refused on the node, and refused at the next opening; then the good one reads, after a restart too', async () => {
        await danaWrites('under key 2');
        servers[A].junk = new Set([2]);
        db.enterChatInPlace(A);
        h.cut = { file: A_FILE, sql: /UPDATE group_chat_epochs SET wrap = NULL/, times: 1, refuse: true, hit: () => {} };
        await opened(A);
        expect(h.cut.times).toBe(0);
        h.cut = null;
        expect([servers[A].rejected ?? [], parted()]).toEqual([[], []]);
        expect(onDisk().epochs).toEqual([1, 2]);
        await opened(A);
        expect([servers[A].rejected, onDisk().epochs, parted()]).toEqual([[2], [1], []]);
        // The good one's own put refused: asked for again at the next opening, not a minute later.
        h.cut = { file: A_FILE, sql: /INTO group_chat_epochs/, times: 1, refuse: true, hit: () => {} };
        expect(texts(await opened(A))).not.toContain('under key 2');
        expect([h.cut.times, parted()]).toEqual([0, []]);
        h.cut = null;
        expect(texts(await opened(A))).toEqual(['my first line', 'under key 2']);
        await db.leaveChatInPlace(A);
        await restart();
        db.enterChatInPlace(A);
        expect(texts(await opened(A))).toEqual(['my first line', 'under key 2']);
        await db.leaveChatInPlace(A);
    });

    it('a record its maker never signed, whose good copy\'s put is refused: not counted as asked for, so the next opening asks again and reads', async () => {
        await danaWrites('under key 2');
        servers[A].badRecords = new Set([2]);
        db.enterChatInPlace(A);
        h.cut = { file: A_FILE, sql: /INTO group_chat_epochs/, times: 1, skip: 1, refuse: true, hit: () => {} };
        expect(texts(await opened(A))).not.toContain('under key 2');
        expect([h.cut.times, parted()]).toEqual([0, []]);
        h.cut = null;
        expect(texts(await opened(A))).toEqual(['my first line', 'under key 2']);
        expect(parted()).toEqual([]);
        await db.leaveChatInPlace(A);
    });

    it('a key opened from the file with no signal, whose raise the file won\'t keep, opens nothing until it is kept', async () => {
        await danaWrites('under key 2');
        db.enterChatInPlace(A);
        await opened(A);
        await db.leaveChatInPlace(A);
        into(A_FILE, (sql) => { sql.prepare('UPDATE group_chat_key_state SET highest = 1').run(); });
        await restart();
        servers[A].noKeys = true;
        db.enterChatInPlace(A);
        h.cut = { file: A_FILE, sql: /\(group_id, highest\)/, times: 1, refuse: true, hit: () => {} };
        expect(texts(await opened(A))).not.toContain('under key 2');
        expect([h.cut.times, parted(), onDisk().highest]).toEqual([0, [], 1]);
        h.cut = null;
        expect(texts(await opened(A))).toContain('under key 2');
        expect([parted(), onDisk().highest]).toEqual([[], 2]);
        await db.leaveChatInPlace(A);
    });

    it('a community taken off the phone and joined again in the same run: its new copy is told every key again, and a restart reads every line', async () => {
        await danaWrites('under key 2');
        db.enterChatInPlace(A);
        await opened(A);
        await db.leaveChatInPlace(A);
        const before = groupKeyring(A, { ...h.me }, g, db.groupKeyStore(A));
        await removeSavedNode(A);
        await removeCommunityCaches([A]);
        await switchPhoneTo(A);
        await db.getDb();
        groupRow(A_FILE, g);
        expect(onDisk().epochs, 'a new copy').toEqual([]);
        // A change of the ring from before, still on its way, reaches nothing.
        await expect(before.noteLocked().then(() => before.sync())).rejects.toMatchObject({ code: 'store' });
        expect(onDisk()).toEqual({ epochs: [], after: 0, highest: 0, locked: false, signers: 0 });
        await danaWrites('under key 3');
        expect(texts(await opened(undefined))).toEqual(['my first line', 'under key 2', 'under key 3']);
        expect(parted()).toEqual([]);
        await restart(A);
        expect(onDisk().epochs).toEqual([1, 2, 3]);
        expect(texts(await opened(undefined))).toEqual(['my first line', 'under key 2', 'under key 3']);
    });

    it('one change at a time: a key of this phone\'s never lands over one taken in while it was put away', async () => {
        await danaWrites('Dana\'s key 2');
        const slow = memoryGroupKeyStore();
        let free!: () => void;
        const freed = new Promise<void>((r) => { free = r; });
        const ring = groupKeyring(A, { ...h.me }, g, db.groupKeyStore(A));
        const { GroupKeyring } = await import('../group-chat-keys');
        const held = new GroupKeyring(ring.groupId, A, { ...h.me } as any, { ...slow, putEpochs: async (id, e) => { await freed; await slow.putEpochs(id, e); } });
        const { record, groupKey } = await held.makeRecord({ epoch: 2, reason: 'rotate', recipients: [me.publicKey, peer.publicKey] });
        const syncing = held.sync();
        await settle();
        const adopting = held.adopt(record, groupKey).then(() => 'adopted', (e) => e.message);
        await settle();
        free();
        await syncing;
        expect(await adopting).toBe(GROUP_KEY_ROLLBACK_TEXT);
        const kept = (await slow.load(`${me.publicKey}/${g}`)).epochs.find((e) => e.epoch === 2)!;
        expect(kept.record.createdBy).toBe(peer.publicKey);
    });

    it('a write the store never answers (its handle closed under it) is refused after a while, and the next one goes on', async () => {
        vi.useFakeTimers();
        try {
            const store = memoryGroupKeyStore();
            const { GroupKeyring } = await import('../group-chat-keys');
            let asks = 0;
            const ring = new GroupKeyring(g, A, { ...h.me } as any, { ...store, noteLocked: (id) => (++asks === 1 ? new Promise<void>(() => {}) : store.noteLocked(id)) });
            const first = ring.noteLocked().then(() => 'kept', (e) => e.code);
            const second = ring.noteLocked().then(() => 'kept', (e) => e.code);
            await vi.advanceTimersByTimeAsync(46_000);
            expect([await first, await second, asks]).toEqual(['store', 'kept', 2]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the sticky lock: on disk before any of the chat is shown or sent; a group ever seen locked is never sent readable', () => {
    /** Every path that can post words into the group, with the node saying it isn't locked: each refuses. */
    async function nothingReadable(): Promise<void> {
        servers[A].unlocked = true;
        db.enterChatInPlace(A);
        await expect(db.postGroupChatMessage(g, 'readable?', randomUUID(), null, undefined, A)).rejects.toThrow(GROUP_CHAT_LOCK_LOST_TEXT);
        await expect(db.editThreadMessage(mine.id, 'readable?', { groupId: g, metadata: {}, locked: false }, A)).rejects.toThrow();
        // The screen's own answer keeps it locked: its ring says so.
        expect(await (await db.groupScreenKeyringFor(g, A)).seenLocked()).toBe(true);
        await db.leaveChatInPlace(A);
        // And once the phone is set there: both of its paths, whatever its row is called.
        await switchPhoneTo(A);
        for (const type of ['group_thread', 'event_thread']) {
            into(A_FILE, (sql) => { sql.prepare('UPDATE conversations SET type = ? WHERE id = ?').run(type, g); });
            await expect(db.postGroupChatMessage(g, 'readable?', randomUUID(), null, undefined)).rejects.toThrow(GROUP_CHAT_LOCK_LOST_TEXT);
            await expect(db.insertMessage(g, me.publicKey, 'readable?')).rejects.toThrow(GROUP_CHAT_LOCK_LOST_TEXT);
        }
        await settle();
        expect(servers[A].wordsIn).toEqual([]);
        expect(asked.filter((r) => r.method === 'POST' && (typeof r.body?.text === 'string' || r.body?.nonce === 'plaintext-v1')).map((r) => r.url)).toEqual([]);
    }

    const SEEN: Array<[string, () => Promise<void>]> = [
        ['opened, and left with its keys on their way; never opened again', async () => {
            db.enterChatInPlace(A);
            const keys = holdNext(keysAsked);
            const opening = opened(A).catch(() => null);
            await keys.asked;
            await db.leaveChatInPlace(A);
            keys.letGo();
            await opening;
            expect(onDisk()).toEqual({ epochs: [], after: 0, highest: 0, locked: true, signers: 0 });
        }],
        ['left with its keys on their way, opened again and read in full', async () => {
            db.enterChatInPlace(A);
            const keys = holdNext(keysAsked);
            const opening = opened(A).catch(() => null);
            await keys.asked;
            await db.leaveChatInPlace(A);
            keys.letGo();
            await opening;
            db.enterChatInPlace(A);
            expect(texts(await opened(A))).toEqual(['my first line']);
            await db.leaveChatInPlace(A);
            expect(onDisk()).toMatchObject({ epochs: [1], highest: 1 });
        }],
        ['SQLite refuses every key of it, the whole run', async () => {
            db.enterChatInPlace(A);
            h.cut = { file: A_FILE, sql: /INTO group_chat_epochs|\(group_id, after\)|\(group_id, highest\)/, times: 1_000, refuse: true, hit: () => {} };
            expect(texts(await opened(A))).not.toContain('my first line');
            await db.leaveChatInPlace(A);
            expect(onDisk()).toMatchObject({ epochs: [], after: 0, highest: 0, locked: true });
        }],
        ['in use, never opened: the node refused it the keys and answered its chat locked to this phone\'s own ask', async () => {
            await switchPhoneTo(A);
            servers[A].noKeys = true;
            await expect(db.insertMessage(g, me.publicKey, 'readable?')).rejects.toThrow();
            servers[A].noKeys = false;
            expect(onDisk()).toEqual({ epochs: [], after: 0, highest: 0, locked: true, signers: 0 });
            await switchPhoneTo(B);
        }],
        ['in use, SQLite refuses the mark once and every key; the next answer marks it', async () => {
            await switchPhoneTo(A);
            h.cut = { file: A_FILE, sql: /INTO group_chat_key_state|INTO group_chat_epochs/, times: 1, refuse: true, hit: () => {} };
            await db.getGroupChat(g);
            expect(onDisk().locked).toBe(false);
            // Not on disk yet: this run's memory refuses it all the same.
            servers[A].unlocked = true;
            await expect(db.postGroupChatMessage(g, 'readable?', randomUUID(), null, undefined)).rejects.toThrow(GROUP_CHAT_LOCK_LOST_TEXT);
            servers[A].unlocked = false;
            await db.getGroupChat(g);
            expect(onDisk().locked).toBe(true);
            await switchPhoneTo(B);
        }],
    ];
    it.each(SEEN)('%s; a restart; a node that then says it isn\'t locked gets nothing readable, by any path', async (_name, seen) => {
        unheldCopy();
        await seen();
        await restart();
        await nothingReadable();
    });

    it('a copy that holds its keys: the same, by the keys (the contrast that was always so)', async () => {
        await restart();
        await nothingReadable();
    });

    it.each([
        ['its key', /INTO group_chat_epochs/], ['the cursor', /\(group_id, after\)/], ['the highest epoch', /\(group_id, highest\)/],
    ])('a line goes only once the file holds its key, the cursor and the highest epoch: %s refused sends nothing', async (_name, sql) => {
        unheldCopy();
        db.enterChatInPlace(A);
        h.cut = { file: A_FILE, sql, times: 1, refuse: true, hit: () => {} };
        await expect(db.postGroupChatMessage(g, 'sealed', randomUUID(), null, { after: null }, A)).rejects.toMatchObject({ code: 'store', message: GROUP_KEY_STORE_UNREAD_TEXT });
        expect([h.cut.times, servers[A].lines.length]).toEqual([0, 1]);
        h.cut = null;
        const going = holdNext((m, p) => m === 'POST' && p === `/api/groups/${g}/chat/message`);
        const sending = db.postGroupChatMessage(g, 'sealed', randomUUID(), null, { after: null }, A);
        await going.asked;
        expect(onDisk(), 'as the line leaves the phone').toMatchObject({ epochs: [1], after: 1, highest: 1, locked: true });
        going.letGo();
        await sending;
        await db.leaveChatInPlace(A);
        expect([servers[A].lines.length, servers[A].wordsIn]).toEqual([2, []]);
    });

    it('a chat left while its own answer was on its way: the answer is refused, so nothing is shown as locked that a restart would not know', async () => {
        unheldCopy();
        db.enterChatInPlace(A);
        const chat = holdNext((m, p) => m === 'GET' && p === `/api/groups/${g}/chat`);
        const reading = db.getGroupChat(g, undefined, undefined, A).then(() => 'shown', () => 'refused');
        await chat.asked;
        await db.leaveChatInPlace(A);
        chat.letGo();
        expect(await reading).toBe('refused');
        expect(onDisk().locked).toBe(false);
    });

    it('a group never seen locked, on a node from before locked chats: words go as they did, in place too (so it is the mark that refuses above)', async () => {
        unheldCopy();
        servers[A].unlocked = true;
        db.enterChatInPlace(A);
        await db.getGroupChat(g, undefined, undefined, A);
        await db.postGroupChatMessage(g, 'an old node\'s words', randomUUID(), null, undefined, A);
        await db.leaveChatInPlace(A);
        expect([servers[A].wordsIn, onDisk().locked]).toEqual([['an old node\'s words'], false]);
    });

    it('the mark goes with the rest when a community is followed to another address this phone has a copy for', async () => {
        const copy = () => {
            const sql = new DatabaseSync(':memory:');
            return {
                getAllAsync: async <T,>(q: string, p: any[] = []) => sql.prepare(q).all(...p) as T[],
                getFirstAsync: async <T,>(q: string, p: any[] = []) => (sql.prepare(q).get(...p) ?? null) as T | null,
                runAsync: async (q: string, p: any[] = []) => sql.prepare(q).run(...p),
                execAsync: async (q: string) => { sql.exec(q); },
            };
        };
        const [from, into_] = [copy(), copy()];
        await from.execAsync(GROUP_KEY_TABLES_SQL);
        await sqliteGroupKeyStore(async () => from).noteLocked('me/g');
        await addGroupKeyState(from, into_);
        expect(await sqliteGroupKeyStore(async () => into_).load('me/g')).toEqual({ epochs: [], highest: 0, after: 0, locked: true });
        expect((await sqliteGroupKeyStore(async () => into_).load('me/other')).locked).toBe(false);
    });

    it('the mark lifts no DM guard: an id this phone knows as a DM gets no group keys, in place or in use, and is not a held group', async () => {
        unheldCopy();
        into(A_FILE, (sql) => { sql.prepare('INSERT INTO group_chat_key_state (group_id) VALUES (?)').run(`${me.publicKey}/${g}`); });
        h.store.set(dmConversationsSeenStoreKey(me.publicKey, A_FILE), JSON.stringify([g]));
        expect(await db.heldChatIsGroup(me.publicKey, A, g)).toBe(false);
        await switchPhoneTo(A);
        expect(await db.isHeldGroupChat(g)).toBe(false);
        await expect(db.groupScreenKeyringFor(g)).rejects.toThrow(GROUP_KEYS_FOR_DM_TEXT);
        await expect(db.postGroupChatMessage(g, 'a DM\'s', randomUUID(), null, { after: null })).rejects.toThrow(GROUP_KEYS_FOR_DM_TEXT);
        expect(onDisk().epochs).toEqual([]);
    });
});

// ── Every path that can send words into a group-like chat asks the lock mark, of its own community's file, last ───────
// (second review of #3358: R1, R2, and the class they are of)

const WORDS = 'the words';
const M4A = readFixture();
function readFixture(): any {
    // The smallest thing core takes for a voice message's shape here: these rows never reach a seal (no key), or a refusal.
    return { bytes: new Uint8Array(2048), durationMs: 1200, peaks: [0.2, 0.4, 0.1] };
}
/** A path that sends words, a photo or a voice message into a chat. `inPlace`: it takes a community. `opens`: whose contrast row sends readable words, for which labels. */
interface Send { fn: string; name: string; run: (c?: string) => Promise<unknown>; inPlace: boolean; readable: readonly Label[] }
type Label = 'group_thread' | 'event_thread' | 'enterprise_thread' | 'none' | 'dm';
const LABELS: readonly Label[] = ['group_thread', 'event_thread', 'enterprise_thread', 'none', 'dm'];
const NOT_A_DM: readonly Label[] = ['group_thread', 'event_thread', 'enterprise_thread', 'none'];
const A_READABLE_ROW: readonly Label[] = ['group_thread', 'event_thread', 'enterprise_thread'];
const SENDS: Send[] = [
    { fn: 'postGroupChatMessage', name: 'the group\'s screen: a line', run: (c) => db.postGroupChatMessage(g, WORDS, randomUUID(), null, undefined, c), inPlace: true, readable: NOT_A_DM },
    { fn: 'editThreadMessage', name: 'the group\'s and the enterprise discussion\'s screen: an edit', run: (c) => db.editThreadMessage(mine.id, WORDS, { groupId: g, metadata: {}, locked: false }, c), inPlace: true, readable: NOT_A_DM },
    { fn: 'postGroupChatPhoto', name: 'the group\'s screen: a photo (only ever sealed)', run: () => db.postGroupChatPhoto(g, { dataUri: 'data:image/jpeg;base64,AAAA', caption: WORDS }), inPlace: false, readable: [] },
    { fn: 'postGroupChatVoice', name: 'the group\'s screen: a voice message (only ever sealed)', run: () => db.postGroupChatVoice(g, { voice: M4A }), inPlace: false, readable: [] },
    { fn: 'insertMessage', name: 'the DM screen: a line', run: (c) => db.insertMessage(g, me.publicKey, WORDS, undefined, undefined, undefined, c), inPlace: true, readable: A_READABLE_ROW },
    { fn: 'editMessage', name: 'the DM screen: an edit', run: (c) => db.editMessage(g, mine.id, WORDS, c), inPlace: true, readable: A_READABLE_ROW },
    { fn: 'sendImageMessage', name: 'the DM screen: a photo (only ever sealed)', run: () => db.sendImageMessage(g, 'data:image/jpeg;base64,AAAA', WORDS), inPlace: false, readable: [] },
    { fn: 'sendVoiceMessage', name: 'the DM screen: a voice message (only ever sealed)', run: () => db.sendVoiceMessage(g, M4A), inPlace: false, readable: [] },
    { fn: 'postEventChatMessage', name: 'an event\'s chat', run: () => db.postEventChatMessage(g, WORDS, randomUUID()), inPlace: false, readable: NOT_A_DM },
    { fn: 'postEnterpriseChatMessage', name: 'an enterprise\'s discussion', run: () => db.postEnterpriseChatMessage(g, WORDS, randomUUID()), inPlace: false, readable: NOT_A_DM },
    { fn: 'postEnterpriseThreadMessage', name: 'an enterprise\'s page', run: () => db.postEnterpriseThreadMessage(g, WORDS, randomUUID()), inPlace: false, readable: NOT_A_DM },
];
const clearKeys = (file: string) => into(file, (sql) => { for (const t of ['group_chat_key_state', 'group_chat_epochs', 'group_line_signers', 'group_line_verdicts']) sql.prepare(`DELETE FROM ${t}`).run(); });
const mark = (file: string) => into(file, (sql) => { sql.prepare('INSERT INTO group_chat_key_state (group_id) VALUES (?)').run(`${me.publicKey}/${g}`); });
const marked = (file: string): boolean => {
    const r = rowsOf(file);
    return !!r && (r.group_chat_key_state as any[]).some((x) => x.group_id === `${me.publicKey}/${g}`);
};
/** Neither copy holds a key of the group (each was joined on another device), and its servers say no chat is locked. */
async function neitherHolds(label: Label = 'group_thread'): Promise<void> {
    await db.closeDB();
    for (const file of [A_FILE, B_FILE]) {
        clearKeys(file);
        into(file, (sql) => {
            sql.prepare('DELETE FROM messages').run();
            sql.prepare('DELETE FROM conversations WHERE id = ?').run(g);
        });
        if (label !== 'none') groupRow(file, g, label);
    }
    _resetGroupKeySessionForTests();
    for (const origin of [A, B, C]) { servers[origin].unlocked = true; servers[origin].wordsIn = []; }
    asked = [];
}
/** Every readable word that left the phone, by whose server it went to. */
const wordsOut = () => Object.fromEntries([A, B, C].map((o) => [o, servers[o].wordsIn]));
const NOTHING = { [A]: [], [B]: [], [C]: [] };

describe('every path that can send words into a group-like chat asks the lock mark of its own community\'s file before it sends', () => {
    /** Whose file is marked, and where the phone is as it sends to A: nothing readable goes once A's own file is marked, and B's mark stops nothing. */
    const STAND = [
        { name: 'in use, its own file marked', where: 'use', mark: A_FILE, goes: false },
        { name: 'in use, only the other community\'s file marked', where: 'use', mark: B_FILE, goes: true },
        { name: 'in place, its own file marked', where: 'place', mark: A_FILE, goes: false },
        { name: 'in place, only the file of the community in use marked', where: 'place', mark: B_FILE, goes: true },
    ] as const;
    const rows = SENDS.flatMap((send) => LABELS.flatMap((label) => STAND.filter((st) => st.where === 'use' || send.inPlace).map((st) => [send.name, label, st.name, send, st] as const)));
    it.each(rows)('%s x called %s x %s', async (_s, label, _st, send, st) => {
        if (st.where === 'use') await switchPhoneTo(A);
        await neitherHolds(label);
        mark(st.mark);
        await db.getDb();
        const c = st.where === 'place' ? A : undefined;
        if (c) db.enterChatInPlace(A);
        const thrown: any = await send.run(c).then(() => null, (e) => e);
        await settle();
        if (c) await db.leaveChatInPlace(A);
        // In place: only a group's own screen sends, and only a group that copy's row says is one (onlyGroupInPlace, onlyDmInPlace).
        const opens = c ? (['postGroupChatMessage', 'editThreadMessage'].includes(send.fn) && label === 'group_thread' ? [label] : []) : send.readable;
        const goes = st.goes && (opens as readonly Label[]).includes(label);
        expect(wordsOut(), String(thrown?.message)).toEqual({ ...NOTHING, [A]: goes ? [WORDS] : [] });
        // A DM known there is a DM in its own screen, the mark or not (it lifts no DM guard): sealed to its pin, never readable.
        const aDmsOwn = label === 'dm' && ['insertMessage', 'editMessage', 'sendImageMessage', 'sendVoiceMessage'].includes(send.fn);
        if (!goes && !aDmsOwn) expect(thrown, 'refused in words').toBeTruthy();
        if (aDmsOwn && send.fn !== 'sendVoiceMessage') expect(thrown?.message ?? null).toBeNull();
        // The sealed-only ones too: a chat its own file has seen locked is a group's, whatever its row is called.
        if (!st.goes && !c && label !== 'dm' && send.fn !== 'editMessage' && (send.readable.includes(label) || send.readable.length === 0 || send.fn === 'insertMessage')) {
            expect(thrown.message).toBe(send.fn === 'editThreadMessage' ? GROUP_EDIT_NO_KEY_TEXT : GROUP_CHAT_LOCK_LOST_TEXT);
        }
        // Nothing of it went anywhere but A, sealed or not.
        expect(asked.filter((r) => r.method === 'POST' && /message|edit/.test(r.url) && !r.url.startsWith(A)).map((r) => r.url)).toEqual([]);
        expect([marked(A_FILE), marked(B_FILE)], 'the marks are as they were').toEqual([st.mark === A_FILE, st.mark === B_FILE]);
    });

    it('the table has every path x every label x its stands (150 rows), and it is every path the phone has (the source)', () => {
        expect(rows.length).toBe(11 * 5 * 2 + 4 * 5 * 2);
        const native = path.join(__dirname, '..', '..');
        const found: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === '__tests__' || e.name === 'node_modules') continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (/\.tsx?$/.test(e.name)) found.push(...sendersIn(full));
            }
        };
        for (const dir of ['app', 'components', 'utils', 'services', 'tools']) if (fs.existsSync(path.join(native, dir))) walk(path.join(native, dir));
        // The sealed lines' own two senders, and the DM screen's delivery, are reached only by the paths above.
        const SEALED_ONLY = ['group-chat-lines.ts:sendSealedGroupLine', 'group-chat-lines.ts:editSealedGroupLine'];
        const own = SENDS.map((x) => x.fn).filter((fn) => !['postGroupChatPhoto', 'postGroupChatVoice', 'insertMessage'].includes(fn)).map((fn) => `db.ts:${fn}`);
        expect([...new Set(found)].sort()).toEqual([...own, 'db.ts:_deliverPendingMessage', ...SEALED_ONLY].sort());
        // Each readable one gets its address from the one last gate, and none reads the address in use itself.
        const source = fs.readFileSync(path.join(native, 'utils', 'db.ts'), 'utf8');
        const bodyOf = (fn: string) => { const at = source.search(new RegExp(`(async )?function ${fn}\\(`)); return source.slice(at, source.indexOf('\n}\n', at)); };
        for (const fn of ['postGroupChatMessage', 'editThreadMessage', 'lockForConversation']) expect(bodyOf(fn), fn).toMatch(/await readableLineTo\(asked, /);
        for (const fn of ['postEventChatMessage', 'postEnterpriseChatMessage', 'postEnterpriseThreadMessage']) expect(bodyOf(fn), fn).toMatch(/const to = await readableChatAddress\(.*\n {4}return _signedRequest\(.*, to\);$/m);
        expect(source.match(/nonce: 'plaintext-v1'/g)?.length, 'the readable lines: lockForConversation, editThreadMessage').toBe(2);
    });

    it.each(SENDS.filter((x) => x.readable.length > 0).map((x) => [x.name, x] as const))('%s: its file\'s memory can\'t be read: refused, nothing goes', async (_n, send) => {
        await switchPhoneTo(A);
        await neitherHolds();
        mark(A_FILE);
        await db.getDb();
        h.reads = { file: A_FILE, sql: /group_chat_key_state|group_chat_epochs/, times: 1_000, hang: false };
        await expect(send.run()).rejects.toThrow();
        h.reads = null;
        expect(wordsOut()).toEqual(NOTHING);
    });

    it.each(SENDS.filter((x) => x.readable.length > 0).map((x) => [x.name, x] as const))('%s: seen locked this run with the mark refused: nothing goes until the file has the mark, and then nothing readable', async (_n, send) => {
        await switchPhoneTo(A);
        await neitherHolds();
        servers[A].unlocked = false;
        await db.getDb();
        h.cut = { file: A_FILE, sql: /INTO group_chat_key_state/, times: 1_000, refuse: true, hit: () => {} };
        await db.getGroupChat(g);
        servers[A].unlocked = true;
        expect(marked(A_FILE)).toBe(false);
        await expect(send.run()).rejects.toMatchObject({ code: 'store' });
        h.cut = null;
        // SQLite takes it again: the send itself puts the mark before it is refused, so a restart knows it.
        await expect(send.run()).rejects.toThrow(send.fn === 'editThreadMessage' ? GROUP_EDIT_NO_KEY_TEXT : GROUP_CHAT_LOCK_LOST_TEXT);
        expect(marked(A_FILE)).toBe(true);
        expect(wordsOut()).toEqual(NOTHING);
    });

    /** The phone set to another community as A's key memory is read for the send, or as A's own chat answer for it is on its way. */
    const LEAVES = [['to B, whose file has no mark', async () => { await switchPhoneTo(B); }], ['to B and back', async () => { await switchPhoneTo(B); await switchPhoneTo(A); }]] as const;
    it.each(SENDS.filter((x) => x.readable.length > 0).flatMap((x) => LEAVES.map(([to, go]) => [x.name, to, x, go] as const)))('%s, the phone switched mid-send %s: never to the other community, and not at all with A\'s file marked', async (_n, _to, send, go) => {
        for (const marks of [[A_FILE], [B_FILE]]) {
            await switchPhoneTo(A);
            await neitherHolds();
            for (const file of marks) mark(file);
            await db.getDb();
            let moving: Promise<void> | null = null;
            h.reads = { file: A_FILE, sql: /FROM group_chat_key_state/, times: 1, hang: false, refuse: false, hit: () => { moving = go(); } };
            await send.run().catch(() => null);
            await moving;
            await settle();
            h.reads = null;
            expect(moving, 'switched as the send asked').not.toBeNull();
            expect([servers[B].wordsIn, servers[C].wordsIn]).toEqual([[], []]);
            if (marks[0] === A_FILE) expect(servers[A].wordsIn).toEqual([]);
        }
    });

    it.each([['a line', () => db.insertMessage(g, me.publicKey, WORDS)], ['an edit', () => db.editMessage(g, mine.id, WORDS)]] as const)('the DM screen, %s: A\'s own chat answer for it on its way, the phone set to B, which says it isn\'t locked: nothing goes to either', async (_n, run) => {
        await switchPhoneTo(A);
        await neitherHolds();
        await db.getDb();
        const chat = holdNext((m, p) => m === 'GET' && p === `/api/groups/${g}/chat`);
        const sending = run().then(() => 'sent', () => 'refused');
        await chat.asked;
        await switchPhoneTo(B);
        chat.letGo();
        expect(await sending).toBe('refused');
        await settle();
        expect(wordsOut()).toEqual(NOTHING);
    });

    it.each(SENDS.filter((x) => x.readable.length > 0).map((x) => [x.name, x] as const))('%s: locked by an answer that lands as its last guard is asked: refused', async (_n, send) => {
        await switchPhoneTo(A);
        await neitherHolds();
        await db.getDb();
        // The DM guard's own read, the last before the mark: the answer lands there.
        const ring = await db.groupKeyringFor(g);
        h.reads = { file: A_FILE, sql: /FROM messages WHERE conversation_id IN/, times: 1_000, hang: false, refuse: false, hit: () => { (ring as any).sawLocked = true; } };
        await expect(send.run()).rejects.toThrow();
        h.reads = null;
        expect(wordsOut()).toEqual(NOTHING);
    });

    it.each([['in use', undefined], ['in place', A]] as const)('%s: its file marked, and its keys come: a line the screen took for an old node\'s goes sealed, under its key', async (_n, c) => {
        if (!c) await switchPhoneTo(A);
        await neitherHolds();
        mark(A_FILE);
        servers[A].unlocked = false;
        await db.getDb();
        if (c) db.enterChatInPlace(A);
        await db.postGroupChatMessage(g, WORDS, randomUUID(), null, undefined, c);
        if (c) await db.leaveChatInPlace(A);
        expect([servers[A].lines.length, servers[A].lines[1]?.metadata?.epoch, wordsOut()]).toEqual([2, 1, NOTHING]);
        expect(JSON.stringify(servers[A].lines[1])).not.toContain(WORDS);
    });

    it.each([['A\'s key memory read this run', true], ['A\'s key memory not read yet', false]] as const)('the DM screen, an edit begun in A, the phone set to B, which holds the group\'s keys and a newer one, just before it is sealed (%s): sealed under A\'s key and sent to A, or refused; nothing under B\'s', async (_n, read) => {
        await switchPhoneTo(A);
        const { record } = await makeEpochRecord({ myEdPrivHex: peer.privateKey, groupId: g, epoch: 2, reason: 'rotate', subject: null, createdAt: new Date().toISOString(), recipients: [me.publicKey, peer.publicKey] });
        servers[B].epochs = [...servers[A].epochs, record];
        forgetGroupKeys();
        if (read) expect(await (await db.groupKeyringFor(g)).holdsKeys()).toBe(true);
        asked = [];
        h.reads = { file: A_FILE, sql: /FROM messages WHERE id = \?/, times: 1, hang: false, refuse: false, wait: true, hit: () => switchPhoneTo(B) };
        const thrown: any = await db.editMessage(g, mine.id, WORDS).then(() => null, (e) => e);
        expect(h.reads.times, 'switched as it was asked').toBe(0);
        h.reads = null;
        expect(thrown?.code ?? null).toBe(read ? null : 'store');
        expect(asked.filter((r) => r.method === 'POST' && /message|edit/.test(r.url)).map((r) => [r.url, r.body.metadata?.epoch])).toEqual(read ? [[`${A}/api/messages/edit`, 1]] : []);
        expect(wordsOut()).toEqual(NOTHING);
    });

    it('what is said is true of a phone that only saw the chat locked, and of one that held its keys (R4)', async () => {
        await switchPhoneTo(A);
        await neitherHolds();
        mark(A_FILE);
        await db.getDb();
        expect(await (await db.groupKeyringFor(g)).holdsKeys()).toBe(false);
        const said: any = await db.postGroupChatMessage(g, WORDS, randomUUID()).then(() => null, (e) => e);
        expect(said.message).toBe(GROUP_CHAT_LOCK_LOST_TEXT);
        expect(said.message).not.toMatch(/held its keys/);
        expect(groupChatNotice({ nodeSaysLocked: false, seenLocked: true })).toBe(GROUP_CHAT_LOCK_LOST_TEXT);
        // And while nothing can be known of it: neither "locked" nor "older", and only then.
        expect(groupChatNotice({ nodeSaysLocked: false, seenLocked: false, keysUnread: true })).toBe(GROUP_KEY_STORE_UNREAD_TEXT);
        expect(groupChatNotice({ nodeSaysLocked: true, seenLocked: false, keysUnread: true })).not.toBe(GROUP_KEY_STORE_UNREAD_TEXT);
    });
});

/** The functions of a source that name a chat line's route, as "file:function". */
function sendersIn(file: string): string[] {
    const text = fs.readFileSync(file, 'utf8');
    if (!/\/(chat|thread)\/message|\/api\/messages\/(send|edit)/.test(text)) return [];
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    (function walk(n: ts.Node, fn: string) {
        let here = fn;
        if (ts.isFunctionDeclaration(n) && n.name) here = n.name.text;
        else if (ts.isVariableDeclaration(n) && n.initializer && ts.isArrowFunction(n.initializer)) here = n.name.getText(sf);
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && /\/(chat|thread)\/message(`|'|"|\$|$)|\/api\/messages\/(send|edit)(`|'|"|$)/.test(n.getText(sf))) out.push(`${path.basename(file)}:${here}`);
        ts.forEachChild(n, (c) => walk(c, here));
    })(sf, '(top level)');
    return out;
}

describe('the mark goes to the file of the community that answered, never to the one in use as the answer lands (R1)', () => {
    const chatAsked = (m: string, p: string) => m === 'GET' && p === `/api/groups/${g}/chat`;
    /** Every ask whose answer marks a chat locked: the chat's own read, and the phone's own ask when the keys are refused. */
    const ASKS: Array<[string, (c?: string) => Promise<unknown>]> = [
        ['the chat\'s answer (getGroupChat)', (c) => db.getGroupChat(g, undefined, undefined, c)],
        ['a refused line\'s own ask (insertMessage)', () => db.insertMessage(g, me.publicKey, WORDS)],
        ['a refused photo\'s own ask (postGroupChatPhoto)', () => db.postGroupChatPhoto(g, { dataUri: 'data:image/jpeg;base64,AAAA', caption: '' })],
    ];
    const MOVES: Array<[string, () => Promise<void>]> = [
        ['nothing (the contrast)', async () => {}],
        ['the phone set to B', async () => { await switchPhoneTo(B); }],
        ['the phone set to C', async () => { await switchPhoneTo(C); }],
        ['the phone set to B and back', async () => { await switchPhoneTo(B); await switchPhoneTo(A); }],
    ];
    it.each(ASKS.flatMap(([ask, run]) => MOVES.map(([move, go]) => [ask, move, run, go] as const)))('in use, %s x %s as the answer is on its way: A\'s file is marked, no other, and a restart gets nothing readable out', async (_a, _m, run, go) => {
        await switchPhoneTo(A);
        await neitherHolds();
        servers[A].unlocked = false;
        servers[A].noKeys = true;
        await db.getDb();
        const chat = holdNext(chatAsked);
        const asking = run().then(() => null, (e) => e);
        await chat.asked;
        await go();
        chat.letGo();
        await asking;
        await settle();
        expect([marked(A_FILE), marked(B_FILE), marked(C_FILE)]).toEqual([true, false, false]);
        expect(db.heldCopyFiles(), 'nothing left open').not.toContain(A_FILE);
        // B never answered: its chat of that id is not locked here. A's is, after a restart too.
        await restart(B);
        expect(await db.isLockedGroupChat(g)).toBe(false);
        await restart(A);
        expect(await db.isLockedGroupChat(g)).toBe(true);
        servers[A].unlocked = true;
        for (const send of SENDS) await send.run().catch(() => null);
        await settle();
        expect(wordsOut()).toEqual(NOTHING);
    });

    it('in use, no account on the phone as it is asked: a locked answer has nobody to be kept for, so it is refused; an unlocked one is shown, as before', async () => {
        await switchPhoneTo(A);
        await neitherHolds();
        await db.getDb();
        const { loadIdentity } = await import('../identity');
        const out: string[] = [];
        for (const unlocked of [false, true]) {
            servers[A].unlocked = unlocked;
            vi.mocked(loadIdentity).mockImplementation(async () => null);
            out.push(await db.getGroupChat(g).then(() => 'shown', () => 'refused'));
            vi.mocked(loadIdentity).mockImplementation(async () => ({ ...h.me, callsign: 'Me' }) as any);
        }
        expect(out).toEqual(['refused', 'shown']);
        expect([marked(A_FILE), marked(B_FILE)]).toEqual([false, false]);
    });

    it('in use, the phone set to B and back as the answer lands, at every moment of it: A\'s file is marked, or the answer was refused; B\'s never is', async () => {
        const seen: string[] = [];
        for (let k = 0; k < 24; k++) {
            await phoneOnB();
            await switchPhoneTo(A);
            await neitherHolds();
            servers[A].unlocked = false;
            await db.getDb();
            const chat = holdNext(chatAsked);
            const reading = db.getGroupChat(g).then(() => 'shown', () => 'refused');
            await chat.asked;
            await switchPhoneTo(B);
            // The switch back starts first (k < 12) or the answer does, by a growing number of turns.
            const turns = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
            let back: Promise<unknown>;
            if (k < 12) { back = switchPhoneTo(A); await turns(k * 9); chat.letGo(); }
            else { chat.letGo(); await turns((k - 12) * 9); back = switchPhoneTo(A); }
            const how = await reading;
            await back;
            await settle();
            expect(marked(B_FILE), `moment ${k}`).toBe(false);
            if (how === 'shown') expect(marked(A_FILE), `moment ${k}: shown, so kept`).toBe(true);
            seen.push(how);
        }
        expect(seen).toContain('shown');
    });

    it.each([[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2], [4, 1]])('in use, the phone on B just as the mark is put, and on A again as it is asked where it is (reads of the address %i, %i): A\'s file is marked, not B\'s', async (from, times) => {
        await switchPhoneTo(A);
        await neitherHolds();
        servers[A].unlocked = false;
        await db.getDb();
        const storage: any = (await import('@react-native-async-storage/async-storage')).default;
        const chat = holdNext(chatAsked);
        const reading = db.getGroupChat(g).then(() => 'shown', () => 'refused');
        await chat.asked;
        let reads = 0;
        storage.getItem.mockImplementation(async (k: string) => (k === ANCHOR && ++reads >= from && reads < from + times ? B : h.store.get(k) ?? null));
        chat.letGo();
        const how = await reading;
        storage.getItem.mockImplementation(async (k: string) => h.store.get(k) ?? null);
        await settle();
        expect(marked(B_FILE)).toBe(false);
        if (times === 1) expect(how).toBe('shown');
        expect([how, marked(A_FILE)], 'shown, so kept').toEqual([how, how === 'shown']);
    });

    it.each([
        ['in place, the phone set to a third community', async () => { await switchPhoneTo(C); }],
        ['in place, the phone set to that very community', async () => { await switchPhoneTo(A); }],
    ] as const)('%s as the answer is on its way: its own file is marked, no other', async (_n, go) => {
        await neitherHolds();
        servers[A].unlocked = false;
        await db.getDb();
        db.enterChatInPlace(A);
        const chat = holdNext(chatAsked);
        const reading = db.getGroupChat(g, undefined, undefined, A).then(() => 'shown', () => 'refused');
        await chat.asked;
        await go();
        chat.letGo();
        expect(await reading).toBe('shown');
        expect([marked(A_FILE), marked(B_FILE), marked(C_FILE)]).toEqual([true, false, false]);
        await db.leaveChatInPlace(A);
    });

    it.each([
        ['A taken off the phone', async () => { await switchPhoneTo(B); await removeSavedNode(A); await removeCommunityCaches([A]); }],
        ['A kept only as a guest\'s look', async () => { h.store.set('beanpool_guest_nodes', JSON.stringify([A])); await switchPhoneTo(B); }],
        ['another account signed in', async () => { h.me = { ...person() }; }],
    ] as const)('%s as the answer is on its way: there is no file to keep it in, so the answer is refused, and nothing is marked anywhere', async (_n, go) => {
        await switchPhoneTo(A);
        await neitherHolds();
        servers[A].unlocked = false;
        await db.getDb();
        const chat = holdNext(chatAsked);
        const reading = db.getGroupChat(g).then(() => 'shown', () => 'refused');
        await chat.asked;
        await go();
        chat.letGo();
        expect(await reading).toBe('refused');
        await settle();
        for (const file of [A_FILE, B_FILE]) expect((rowsOf(file)?.group_chat_key_state ?? []) as any[]).toEqual([]);
    });

    it('the route: a chat only seen locked opens in its group\'s screen whatever its server calls it or a link says; the other community\'s mark moves nothing; a DM known there stays one (R2)', async () => {
        const ASKS_HERE = { isHeldGroupChat: db.isHeldGroupChat, isLockedGroupChat: db.isLockedGroupChat, knownDmConversationId: db.knownDmConversationId, getConversationKind: db.getConversationKind };
        for (const label of ['event_thread', 'enterprise_thread', 'group_thread', 'none'] as const) {
            for (const link of [{}, { event: true }, { thread: 'enterprise' as const }, { thread: 'group' as const }]) {
                await switchPhoneTo(A);
                await neitherHolds(label);
                mark(A_FILE);
                await db.getDb();
                expect(await routeChat(ASKS_HERE, g.toUpperCase(), link), `${label} ${JSON.stringify(link)}`).toEqual({ view: 'group', screenId: g });
            }
        }
        await switchPhoneTo(A);
        await neitherHolds('event_thread');
        mark(B_FILE);
        await db.getDb();
        expect((await routeChat(ASKS_HERE, g, {})).view).toBe('event');
        await neitherHolds('event_thread');
        mark(A_FILE);
        h.store.set(dmConversationsSeenStoreKey(me.publicKey, A_FILE), JSON.stringify([g]));
        await db.getDb();
        expect((await routeChat(ASKS_HERE, g, {})).view).toBe('dm');
        // Its memory unreadable: never a screen that posts readable words without asking it.
        h.store.delete(dmConversationsSeenStoreKey(me.publicKey, A_FILE));
        _resetGroupKeySessionForTests();
        h.reads = { file: A_FILE, sql: /group_chat_key_state|group_chat_epochs/, times: 1_000, hang: false };
        expect(['dm', 'group_thread']).toContain((await routeChat(ASKS_HERE, g, {})).view);
        h.reads = null;
    });
});

describe('the ring\'s first read is bounded, and one that never answers is taken as locked (R3)', () => {
    const RingOver = async (over: Partial<ReturnType<typeof memoryGroupKeyStore>>) => {
        const { GroupKeyring } = await import('../group-chat-keys');
        // Each ring in a run of its own.
        _resetGroupKeySessionForTests();
        return new GroupKeyring(g, A, { ...h.me } as any, { ...memoryGroupKeyStore(), ...over });
    };
    it('the mark alone, read from the file: the first ask of the ring says it (no read before it)', async () => {
        const real = memoryGroupKeyStore();
        await real.noteLocked(`${me.publicKey}/${g}`);
        expect(await (await RingOver(real)).seenLocked()).toBe(true);
        expect(await (await RingOver(real)).locksSends()).toBe(true);
        expect(await (await RingOver(memoryGroupKeyStore())).seenLocked()).toBe(false);
    });

    it.each(['load', 'loadVerdicts', 'loadSigners'] as const)('%s never answers: every ask of the ring is refused in 15 s, the lock just seen holds at once, and the next ask reads again', async (which) => {
        vi.useFakeTimers();
        try {
            const real = memoryGroupKeyStore();
            let asks = 0;
            const ring = await RingOver({ ...real, [which]: (id: string) => (++asks === 1 ? new Promise<never>(() => {}) : (real as any)[which](id)) });
            const noting = ring.noteLocked().then(() => 'kept', (e) => e.code);
            const sending = ring.locksSends().then(() => 'answered', (e) => e.code);
            expect(await ring.seenLocked(), 'with the read still out').toBe(true);
            await vi.advanceTimersByTimeAsync(14_900);
            const early = await Promise.race([noting, Promise.resolve('waiting')]);
            await vi.advanceTimersByTimeAsync(200);
            expect([early, await noting, await sending]).toEqual(['waiting', 'store', 'store']);
            expect(await ring.locksSends()).toBe(true);
            expect((await real.load(`${me.publicKey}/${g}`)).locked).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a late read, after its time, takes nothing into memory', async () => {
        vi.useFakeTimers();
        try {
            let late!: () => void;
            const real = memoryGroupKeyStore();
            let asks = 0;
            const ring = await RingOver({ load: (id) => (++asks === 1 ? new Promise((r) => { late = () => r({ epochs: [], highest: 9, after: 9, locked: true }); }) : real.load(id)) });
            const first = ring.seenLocked().then(() => 'answered', (e) => e.code);
            await vi.advanceTimersByTimeAsync(15_100);
            expect(await first).toBe('store');
            late();
            await vi.advanceTimersByTimeAsync(1);
            expect([await ring.seenLocked(), await ring.highestEpoch()]).toEqual([false, 0]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('the chat\'s own answer comes, locked, with its key memory never answering; nothing readable goes; and the next answer marks the file', async () => {
        await switchPhoneTo(A);
        await neitherHolds();
        servers[A].unlocked = false;
        await db.getDb();
        h.reads = { file: A_FILE, sql: /FROM group_chat_epochs/, times: 1, hang: true };
        vi.useFakeTimers();
        let got: any;
        try {
            const reading = db.getGroupChat(g).then((b) => { got = b; }, (e) => { got = e; });
            await vi.advanceTimersByTimeAsync(16_000);
            await reading;
        } finally {
            vi.useRealTimers();
        }
        expect(got?.encryption, String(got?.message)).toBeTruthy();
        expect(marked(A_FILE)).toBe(false);
        servers[A].unlocked = true;
        await expect(db.postEventChatMessage(g, WORDS)).rejects.toThrow(GROUP_CHAT_LOCK_LOST_TEXT);
        expect([marked(A_FILE), wordsOut()]).toEqual([true, NOTHING]);
    });
});

// ── Readable words fail closed: only on a positive "never locked" (third review of #3358, S1) ────────────────────────

describe('a readable line goes only when this phone positively knows the chat was never locked: what cuts across the mark x what the node then says x where it is open (S1)', () => {
    type Where = 'in use' | 'in place';
    const READABLE = SENDS.filter((x) => x.readable.length > 0);
    const sendsOf = (where: Where) => READABLE.filter((x) => where === 'in use' || ['postGroupChatMessage', 'editThreadMessage'].includes(x.fn));
    const at = (where: Where) => (where === 'in place' ? A : undefined);
    /** Every readable path once, each refusal kept: with words, or it isn't one. */
    async function sendAll(where: Where): Promise<string[]> {
        const said: string[] = [];
        for (const send of sendsOf(where)) said.push(await send.run(at(where)).then(() => 'went', (e) => String(e?.message || 'no words')));
        await settle();
        return said;
    }
    const readable = (where: Where) => Object.fromEntries([A, B, C].map((o) => [o, o === A ? sendsOf(where).map(() => WORDS) : []]));
    /** The phone on A (in use), or on B with the chat open there in place; neither copy holds a key; A's chat locked or not. */
    async function stand(where: Where, locked: boolean, label: Label = 'group_thread'): Promise<void> {
        if (where === 'in use') await switchPhoneTo(A);
        await neitherHolds(label);
        servers[A].unlocked = !locked;
        await db.getDb();
        if (where === 'in place') db.enterChatInPlace(A);
    }
    /** The community held again as it was (a copy taken off or resynced made again, its row with it), and the chat open again. */
    async function backAt(where: Where): Promise<void> {
        await switchPhoneTo(A);
        await db.getDb();
        if (!(rowsOf(A_FILE)!.conversations as any[]).some((r) => r.id === g)) groupRow(A_FILE, g);
        if (where === 'in use') return;
        await switchPhoneTo(B);
        await db.getDb();
        db.enterChatInPlace(A);
    }
    const LOAD = /SELECT highest, after FROM group_chat_key_state/;
    const MARK = /INTO group_chat_key_state \(group_id\) VALUES/;
    const forceResync = () => db.clearDB();
    const takenOff = (url: string) => async () => {
        if (url === A && (h.store.get(ANCHOR) === A)) await switchPhoneTo(B);
        await removeSavedNode(url);
        await removeCommunityCaches([url]);
    };
    const dropped = async () => { forgetGroupKeys(); };
    let moving: Promise<unknown> | null = null;
    let release: () => void = () => {};
    /** What happens as the mark is put: `go` as the ring first reads its file, or as the put is run (which SQLite then takes, or refuses from here on). */
    const asRead = (go: () => Promise<unknown>) => () => { h.reads = { file: A_FILE, sql: LOAD, times: 1, hang: false, refuse: false, hit: () => { moving = go(); } }; };
    const asPut = (go: () => Promise<unknown>, refuse: boolean) => () => { h.cut = { file: A_FILE, sql: MARK, times: refuse ? 1_000 : 1, refuse, hit: () => { moving ??= go(); } }; };
    const never = () => new Promise<void>((r) => { release = r; });
    const EVENTS: Array<{ name: string; arm: () => void; ms?: number; kept?: true }> = [
        { name: 'nothing', arm: () => {}, kept: true },
        { name: 'SQLite refuses it, from here on', arm: asPut(async () => {}, true) },
        { name: 'Force Resync as the ring reads its file', arm: asRead(forceResync) },
        { name: 'Force Resync as it is put', arm: asPut(forceResync, false) },
        { name: 'Force Resync as SQLite refuses it', arm: asPut(forceResync, true) },
        { name: 'another community taken off as the ring reads its file', arm: asRead(takenOff(C)) },
        { name: 'another community taken off as it is put', arm: asPut(takenOff(C), false) },
        { name: 'another community taken off as SQLite refuses it', arm: asPut(takenOff(C), true) },
        { name: 'its own community taken off as the ring reads its file, and joined again', arm: asRead(takenOff(A)) },
        { name: 'its own community taken off as it is put, and joined again', arm: asPut(takenOff(A), false) },
        { name: 'its own community taken off as SQLite refuses it, and joined again', arm: asPut(takenOff(A), true) },
        { name: 'the rings dropped as the ring reads its file', arm: asRead(dropped) },
        { name: 'the rings dropped as it is put', arm: asPut(dropped, false) },
        { name: 'the rings dropped as SQLite refuses it', arm: asPut(dropped, true) },
        { name: 'the ring\'s read of its file never answers', arm: () => { h.reads = { file: A_FILE, sql: LOAD, times: 1, hang: false, wait: true, refuse: true, hit: never }; }, ms: 16_000 },
        { name: 'the put never answers', arm: () => { h.cut = { file: A_FILE, sql: MARK, times: 1, refuse: true, wait: true, hit: never }; }, ms: 46_000 },
    ];
    const THEN: Array<[string, () => void]> = [
        ['locked', () => { servers[A].unlocked = false; }],
        ['not locked', () => { servers[A].unlocked = true; }],
        ['nothing', () => { servers[A].unlocked = true; servers[A].mute = true; }],
    ];
    const WHERE: Where[] = ['in use', 'in place'];
    const rows = EVENTS.flatMap((ev) => THEN.flatMap(([then, says]) => WHERE.map((where) => [ev.name, then, where, ev, says] as const)));
    it.each(rows)('locked, and as its mark is put: %s; the node then says: %s; %s: nothing readable, by any path', async (_e, _t, where, ev, says) => {
        await stand(where, true);
        moving = null;
        release = () => {};
        ev.arm();
        if (ev.ms) vi.useFakeTimers();
        try {
            const reading = db.getGroupChat(g, undefined, undefined, at(where)).catch(() => null);
            if (ev.ms) await vi.advanceTimersByTimeAsync(ev.ms);
            await reading;
        } finally {
            if (ev.ms) vi.useRealTimers();
        }
        release();
        await moving;
        await settle();
        if (where === 'in use' && /ring reads its file$/.test(ev.name) && !/never/.test(ev.name)) {
            // In use the answer stays on the screen, so the ring there is now is told, and its file has the mark (the retry).
            expect(marked(A_FILE), 'kept on the ring there is now').toBe(true);
        }
        const cut = h.cut;
        h.cut = null;
        await backAt(where);
        if (ev.kept) expect(marked(A_FILE)).toBe(true);
        says();
        h.cut = cut;
        await db.getGroupChat(g, undefined, undefined, at(where)).catch(() => null);
        // While SQLite refuses the mark, and once it takes it.
        for (const refusing of [h.cut, null]) {
            h.cut = refusing;
            const said = await sendAll(where);
            expect(wordsOut(), said.join(' | ')).toEqual(NOTHING);
            expect(said, 'refused in words').not.toContain('no words');
        }
        expect([marked(B_FILE), marked(C_FILE)], 'no other community\'s file').toEqual([false, false]);
        if (where === 'in place') await db.leaveChatInPlace(A);
    });

    const NEVER: Array<[string, () => Promise<unknown>]> = [
        ['nothing', async () => {}],
        ['Force Resync', forceResync],
        ['another community taken off', takenOff(C)],
        ['its own community taken off, and joined again', takenOff(A)],
        ['the rings dropped', dropped],
        ['a read of its file that failed once', async () => {
            h.reads = { file: A_FILE, sql: LOAD, times: 1, hang: false };
            await expect((await db.groupKeyringFor(g, h.store.get(ANCHOR) === A ? undefined : A)).seenLocked()).rejects.toMatchObject({ code: 'store' });
            h.reads = null;
        }],
    ];
    it.each(NEVER.flatMap(([name, go]) => WHERE.map((where) => [name, where, go] as const)))('never locked, its node says so, and since: %s; %s: every readable line goes, as it did (the one positive row)', async (_n, where, go) => {
        await stand(where, false);
        await db.getGroupChat(g, undefined, undefined, at(where));
        await go();
        await backAt(where);
        const said = await sendAll(where);
        expect(wordsOut(), said.join(' | ')).toEqual(readable(where));
        if (where === 'in place') await db.leaveChatInPlace(A);
    });

    it('the table has every event x every word of the node x both stands (96 rows), and the positive ones (12)', () => {
        expect([rows.length, NEVER.length * WHERE.length, READABLE.length]).toEqual([16 * 3 * 2, 12, 7]);
    });

    // ── The rest of "positively knows": every other thing that says locked, or that can't say ────────────────────────

    it.each(WHERE)('%s: the same id answered locked by another community this session: refused here in words, and marked only there; a restart asks this file alone', async (where) => {
        await stand(where, false);
        servers[B].unlocked = false;
        if (where === 'in use') await switchPhoneTo(B);
        await db.getGroupChat(g);
        if (where === 'in use') await switchPhoneTo(A);
        servers[B].unlocked = true;
        const said = await sendAll(where);
        expect([wordsOut(), [...new Set(said)].sort()]).toEqual([NOTHING, [GROUP_CHAT_LOCK_LOST_TEXT, GROUP_EDIT_NO_KEY_TEXT].sort()]);
        expect([marked(A_FILE), marked(B_FILE)]).toEqual([false, true]);
        await restart(where === 'in use' ? A : B);
        if (where === 'in place') db.enterChatInPlace(A);
        await sendAll(where);
        expect(wordsOut()).toEqual(readable(where));
    });

    const CHAT_ANSWERS: Array<[string, () => Promise<unknown>]> = [
        ['an event\'s', () => db.getEventChat(g)], ['an enterprise\'s discussion', () => db.getEnterpriseChat(g)], ['an enterprise\'s page', () => db.getEnterpriseThread(g)],
    ];
    it.each(CHAT_ANSWERS)('the id answered locked as %s chat: nothing readable', async (_n, read) => {
        await stand('in use', false);
        fetchMock.mockImplementationOnce(async () => answer(200, { messages: [], encryption: { current: 1 } }));
        await read();
        expect([await sendAll('in use').then(() => wordsOut()), marked(A_FILE)]).toEqual([NOTHING, false]);
    });

    it.each([
        ['another account signed in', async () => { h.me = { ...person() }; }, async () => {}],
        ['no account as it was asked', async () => {}, async () => {
            const { loadIdentity } = await import('../identity');
            vi.mocked(loadIdentity).mockImplementationOnce(async () => null);
        }],
    ] as const)('answered locked, refused as nobody\'s here (%s): nothing readable to that id all the same', async (_n, go, first) => {
        await stand('in use', true);
        await first();
        const chat = holdNext((m, p) => m === 'GET' && p === `/api/groups/${g}/chat`);
        const reading = db.getGroupChat(g).then(() => 'shown', () => 'refused');
        await chat.asked;
        await go();
        chat.letGo();
        expect(await reading).toBe('refused');
        servers[A].unlocked = true;
        await sendAll('in use');
        expect(wordsOut()).toEqual(NOTHING);
    });

    it.each(WHERE)('%s: its keys answered, and the file takes none of them, nor the mark: nothing readable once its node says it isn\'t locked', async (where) => {
        await stand(where, true);
        h.cut = { file: A_FILE, sql: /INTO group_chat_/, times: 1_000, refuse: true, hit: () => {} };
        await expect((await db.groupScreenKeyringFor(g, at(where))).sync()).rejects.toMatchObject({ code: 'store' });
        h.cut = null;
        forgetGroupKeys();
        servers[A].unlocked = true;
        await sendAll(where);
        expect(wordsOut()).toEqual(NOTHING);
    });

    it('a key this phone made, which its file won\'t keep: nothing readable once its node says it isn\'t locked', async () => {
        await stand('in use', true);
        servers[A].epochs = [];
        h.cut = { file: A_FILE, sql: /INTO group_chat_/, times: 1_000, refuse: true, hit: () => {} };
        await expect((await db.groupScreenKeyringFor(g)).rotate()).rejects.toMatchObject({ code: 'store' });
        h.cut = null;
        expect(servers[A].epochs.length, 'the node took it').toBe(1);
        forgetGroupKeys();
        servers[A].unlocked = true;
        await sendAll('in use');
        expect(wordsOut()).toEqual(NOTHING);
    });

    const IN_THE_FILE: Array<[string, (sql: DatabaseSync) => void]> = [
        ['the mark', (sql) => { sql.prepare('INSERT INTO group_chat_key_state (group_id) VALUES (?)').run(`${me.publicKey}/${g}`); }],
        ['an epoch with no wrap for me, and no mark', (sql) => { sql.prepare('INSERT INTO group_chat_epochs (group_id, epoch, record, wrap) VALUES (?, 1, ?, NULL)').run(`${me.publicKey}/${g}`, '{"epoch":1}'); }],
        ['a line\'s first signer, and no mark', (sql) => { sql.prepare('INSERT INTO group_line_signers (group_id, message_id, signer) VALUES (?, ?, ?)').run(`${me.publicKey}/${g}`, 'm', peer.publicKey); }],
        ['a line\'s verdict, and no mark', (sql) => { sql.prepare('INSERT INTO group_line_verdicts (group_id, k) VALUES (?, ?)').run(`${me.publicKey}/${g}`, 'k'); }],
        ['a sealed line of the group\'s, and no mark', (sql) => { sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), g, peer.publicKey, 'AAAA', `${GROUP_NONCE_PREFIX}x`, '2026-11-21T00:00:00.000Z'); }],
        ['a sealed line of the group\'s under its id in capitals', (sql) => { sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), g.toUpperCase(), peer.publicKey, 'AAAA', `${GROUP_NONCE_PREFIX}x`, '2026-11-21T00:00:00.000Z'); }],
        ['its row of a kind this build doesn\'t know', (sql) => { sql.prepare('UPDATE conversations SET type = ? WHERE id = ?').run('sealed_thread', g); }],
        ['its row of no kind at all', (sql) => { sql.prepare('UPDATE conversations SET type = ? WHERE id = ?').run('', g); }],
    ];
    it.each(IN_THE_FILE.flatMap(([what, put]) => [false, true].map((read) => [what, read ? 'read this run before it was there' : 'not read yet', put, read] as const)))('its file has %s (its key memory %s): nothing readable', async (_w, _r, put, read) => {
        await stand('in use', false);
        if (read) expect(await (await db.groupKeyringFor(g)).seenLocked()).toBe(false);
        into(A_FILE, put);
        const said = await sendAll('in use');
        expect(wordsOut(), said.join(' | ')).toEqual(NOTHING);
        expect(said).not.toContain('no words');
    });

    it.each([['as its ring read it', false], ['as a line of the session\'s found it there', true]] as const)('its file had the mark (%s), then its community was taken off and joined again this session: nothing readable', async (_n, late) => {
        await stand('in use', false);
        const ring = await db.groupKeyringFor(g);
        if (late) expect(await ring.seenLocked()).toBe(false);
        mark(A_FILE);
        if (late) await sendAll('in use');
        else expect(await ring.seenLocked()).toBe(true);
        await takenOff(A)();
        await backAt('in use');
        expect(marked(A_FILE), 'a new copy').toBe(false);
        await sendAll('in use');
        expect(wordsOut()).toEqual(NOTHING);
    });

    it.each(READABLE.map((x) => [x.name, x] as const))('%s: its file read once this run; the read for the line fails, or never answers: refused, nothing goes; and the next goes', async (_n, send) => {
        await stand('in use', false);
        expect(await (await db.groupKeyringFor(g)).seenLocked()).toBe(false);
        h.reads = { file: A_FILE, sql: LOAD, times: 1, hang: false };
        await expect(send.run()).rejects.toMatchObject({ code: 'store' });
        h.reads = { file: A_FILE, sql: LOAD, times: 1, hang: true };
        vi.useFakeTimers();
        try {
            const sending = send.run().then(() => 'went', (e) => e.code);
            await vi.advanceTimersByTimeAsync(16_000);
            expect(await sending).toBe('store');
        } finally {
            vi.useRealTimers();
        }
        expect(wordsOut()).toEqual(NOTHING);
        h.reads = null;
        await send.run();
        await settle();
        expect(wordsOut()).toEqual({ ...NOTHING, [A]: [WORDS] });
    });

    it('Sign Out wipes what its files kept of a locked chat (no file is owed its mark, as on a new phone); nothing readable goes to that id until a restart all the same', async () => {
        await stand('in use', true);
        await db.getGroupChat(g);
        expect(marked(A_FILE)).toBe(true);
        await db.clearDB({ identityLeaves: true });
        await backAt('in use');
        servers[A].unlocked = true;
        expect([await (await db.groupKeyringFor(g)).seenLocked(), marked(A_FILE)]).toEqual([false, false]);
        await sendAll('in use');
        expect([wordsOut(), marked(A_FILE)]).toEqual([NOTHING, false]);
        await restart(A);
        await sendAll('in use');
        expect(wordsOut()).toEqual(readable('in use'));
    });

    /** What lands after the line's last guard read its file. */
    const LANDS: Array<[string, () => unknown]> = [
        ['its chat\'s answer, locked', async () => { void (await db.groupKeyringFor(g)).noteLocked().catch(() => {}); }],
        ['another community\'s answer for the id, locked', () => noteAnsweredLocked(g.toUpperCase())],
        ['the rings dropped', () => forgetGroupKeys()],
        ['Force Resync', () => { moving = db.clearDB(); }],
    ];
    it.each(READABLE.flatMap((x) => LANDS.map(([what, land]) => [x.name, what, x, land] as const)))('%s, and as its file is read for it: %s: refused', async (_n, what, send, land) => {
        await stand('in use', false);
        expect(await (await db.groupKeyringFor(g)).seenLocked()).toBe(false);
        moving = null;
        h.reads = { file: A_FILE, sql: /SELECT k FROM group_line_verdicts/, times: 1, hang: false, refuse: false, wait: true, hit: land };
        const said: any = await send.run().then(() => null, (e) => e);
        expect(h.reads.times, 'it landed').toBe(0);
        // What is said is true: seen locked, or this phone's own keys not read just then.
        expect(said?.message).toBe(/locked$/.test(what) ? GROUP_CHAT_LOCK_LOST_TEXT : GROUP_KEY_STORE_UNREAD_TEXT);
        h.reads = null;
        await moving;
        await settle();
        expect(wordsOut()).toEqual(NOTHING);
    });

    it.each(READABLE.flatMap((x) => LANDS.map(([what, land]) => [x.name, what, x, land] as const)))('%s, and as its request is signed, the last moment before it leaves: %s: it doesn\'t leave', async (_n, what, send, land) => {
        await stand('in use', false);
        moving = null;
        let landed = 0;
        const sign = vi.mocked(buildSignedHeaders);
        const real = sign.getMockImplementation()!;
        sign.mockImplementation(async (...args: any[]) => {
            if (args[0] === 'POST' && /message|edit|send/.test(args[1]) && landed++ === 0) await land();
            return (real as any)(...args);
        });
        try {
            const said: any = await send.run().then(() => null, (e) => e);
            await settle();
            await moving;
            await settle();
            if (send.fn !== 'insertMessage') expect(said?.message).toBe(/locked$/.test(what) ? GROUP_CHAT_LOCK_LOST_TEXT : GROUP_KEY_STORE_UNREAD_TEXT);
        } finally {
            sign.mockImplementation(real);
        }
        expect(landed, 'it landed').toBeGreaterThan(0);
        expect(wordsOut()).toEqual(NOTHING);
        // The DM screen's line is kept as not sent, for the member to see.
        if (send.fn === 'insertMessage' && !moving) expect((rowsOf(A_FILE)!.messages as any[]).map((r) => JSON.parse(r.metadata).__sendState)).toEqual(['failed']);
    });
});

describe('what else a chat in place writes, refused as it is left', () => {
    const DAX = { key: 'e'.repeat(64), home: 'hillside.example', name: 'Dax', state: 'in' };
    const guestAsks = () => asked.filter((r) => r.url.endsWith(`/api/groups/${g}/guests`)).length;
    const named = (file: string) => {
        const sql = new DatabaseSync(fileOn(file));
        try { return sql.prepare("SELECT v FROM outside_meta WHERE k LIKE 'guest-names:%'").all().map((r: any) => r.v).join(''); } finally { sql.close(); }
    };

    it('guests\' names: one the file won\'t keep is asked for again at the next opening, not a minute later; names that couldn\'t be read are never written over', async () => {
        servers[A].guests = [DAX];
        const now = Date.now();
        db.enterChatInPlace(A);
        h.cut = { file: A_FILE, sql: /INTO outside_meta/, times: 1, refuse: true, hit: () => {} };
        expect((await guestRosterRows(g, now, A)).shown.length).toBe(1);
        expect([h.cut.times, named(A_FILE)]).toEqual([0, '']);
        h.cut = null;
        await guestRosterRows(g, now, A);
        expect([guestAsks(), named(A_FILE).includes('Dax')]).toEqual([2, true]);
        await db.leaveChatInPlace(A);
        // Dax has left; the list is asked as the chat is left (its file refuses the read), and answers once it is back.
        servers[A].guests = [{ ...DAX, key: 'f'.repeat(64), name: 'Eve' }];
        const list = holdNext((m, p) => m === 'GET' && p.endsWith('/guests'));
        const reading = guestRosterRows(g, now + 61_000, A);
        await list.asked;
        db.enterChatInPlace(A);
        list.letGo();
        await reading;
        expect(named(A_FILE)).toContain('Dax');
        await guestRosterRows(g, now + 61_000, A);
        expect([guestAsks(), named(A_FILE).includes('Dax'), named(A_FILE).includes('Eve')]).toEqual([4, true, true]);
        await db.leaveChatInPlace(A);
    });

    it('a read mark: nothing of it is kept on this phone; refused as the chat is left, the row shows that community\'s own count at its next answer', async () => {
        await heldGroups.refresh(me.publicKey);
        db.enterChatInPlace(A);
        heldGroups.at(A).markRead(g);
        expect(heldGroups.getState()[0].unreadCount).toBe(0);
        const leaving = db.leaveChatInPlace(A);
        expect(db.isNoCopyInPlace(await db.markThreadReadOnNode(g, me.publicKey, A).then(() => null, (e) => e))).toBe(true);
        await leaving;
        await new Promise((r) => setTimeout(r, 5));
        await heldGroups.refresh(me.publicKey);
        expect(heldGroups.getState()[0].unreadCount).toBe(2);
    });
});

describe('Talk → Groups\' rows in one order: newest first, the member\'s own line included, in use and held alike (review of #3358, F2)', () => {
    const row_ = (id: string, at: string): YourChat => ({ kind: 'group', badge: null, id, conversationId: id, name: id, avatarUrl: null, role: 'member', readOnly: false, lastMessage: null, unreadCount: 0, mute: null, lastActivityAt: at });
    const listed = () => groupsListed(yourGroupsStore.getState().items ?? [], heldGroups.getState(), yourGroupsStore.movedAt).map((i) => i.conversationId);
    const held = (id: string) => heldGroups.at(heldGroups.getState().find((r) => r.conversationId === id)!.community);
    /** `hours` from when the lists were made, as a server writes a time: one line's time is the same however often it is served. */
    let made = 0;
    const T = (hours: number) => new Date(made + hours * 3_600_000).toISOString();
    /**
     * B in use, A and C held: each one's list as its server sorts it, its newest an hour old by the servers' clock, which is
     * `ahead` hours ahead of this phone's.
     */
    async function lists(ahead = 0): Promise<void> {
        made = Date.now();
        await switchPhoneTo(C);
        await switchPhoneTo(B);
        servers[B].listed = [row_('own-new', T(ahead - 2)), row_('own-old', T(ahead - 50))];
        servers[A].listed = [row_('a-new', T(ahead - 1)), row_('a-old', T(ahead - 75))];
        servers[C].listed = [row_('c-mid', T(ahead - 3))];
        yourGroupsStore.reset();
        await yourGroupsStore.refresh();
        await heldGroups.refresh(me.publicKey);
        expect(listed()).toEqual(['a-new', 'own-new', 'c-mid', 'own-old', 'a-old']);
    }
    /** A later ask than the last send. */
    const askAgain = async () => {
        await new Promise((r) => setTimeout(r, 5));
        await yourGroupsStore.refresh();
        await heldGroups.refresh(me.publicKey);
    };
    const SENDS: Array<[string, () => void, string[]]> = [
        ['one in use', () => yourGroupsStore.noteSent('own-old'), ['own-old', 'a-new', 'own-new', 'c-mid', 'a-old']],
        ['one held', () => held('a-old').noteSent('a-old'), ['a-old', 'a-new', 'own-new', 'c-mid', 'own-old']],
        ['another held community\'s', () => held('c-mid').noteSent('c-mid'), ['c-mid', 'a-new', 'own-new', 'own-old', 'a-old']],
        ['one held, then one in use', () => { held('a-old').noteSent('a-old'); yourGroupsStore.noteSent('own-old'); }, ['own-old', 'a-old', 'a-new', 'own-new', 'c-mid']],
        ['one in use, then one held', () => { yourGroupsStore.noteSent('own-old'); held('c-mid').noteSent('c-mid'); }, ['c-mid', 'own-old', 'a-new', 'own-new', 'a-old']],
        ['one held, then another community\'s', () => { held('c-mid').noteSent('c-mid'); held('a-old').noteSent('a-old'); }, ['a-old', 'c-mid', 'a-new', 'own-new', 'own-old']],
        ['the one already on top', () => held('a-new').noteSent('a-new'), ['a-new', 'own-new', 'c-mid', 'own-old', 'a-old']],
    ];
    it.each(SENDS.flatMap(([name, sent, order]) => [0, 24].map((ahead) => [name, ahead, sent, order] as const)))('sent in: %s; this phone\'s clock %s hours behind: on top at once, the rest as they were', async (_name, ahead, sent, order) => {
        await lists(ahead);
        // Two sends in one tick of the clock keep their order by the list alone.
        sent();
        expect(listed()).toEqual(order);
        // A line that never got there waits in its chat, at the top: an answer without it, or none at all, moves nothing.
        await askAgain();
        expect(listed(), 'asked again, the line not there yet').toEqual(order);
    });

    it('a chat\'s row taken before its community\'s list was read still moves, reads and mutes the row there is; a community renamed keeps its rows and the sends in them', async () => {
        const row = heldGroups.at(A);
        await lists();
        row.noteSent('a-old');
        expect(listed()[0]).toBe('a-old');
        // Its saved name changed: drawn at the next ask, its list the same one.
        const saved = JSON.parse(h.store.get('beanpool_saved_nodes') ?? '[]') as any[];
        h.store.set('beanpool_saved_nodes', JSON.stringify(saved.map((n) => (n.url === A ? { ...n, alias: 'Renamed' } : n))));
        servers[A].listed = [{ ...row_('a-new', T(-1)), unreadCount: 2 }, row_('a-old', T(-75))];
        await askAgain();
        expect(heldGroups.getState().find((r) => r.conversationId === 'a-new')).toMatchObject({ communityName: 'Renamed', unreadCount: 2 });
        expect(listed()[0], 'the send still counts').toBe('a-old');
        row.markRead('a-new');
        row.setMute('a-new', { conversationId: 'a-new', mutedUntil: null, always: true });
        expect(heldGroups.getState().find((r) => r.conversationId === 'a-new')).toMatchObject({ unreadCount: 0, mute: { always: true } });
    });

    it('once its community shows the line, that line\'s own time counts, held or in use; a newer line in any of them is above it', async () => {
        await lists();
        held('a-old').noteSent('a-old');
        yourGroupsStore.noteSent('own-old');
        expect(listed().slice(0, 2)).toEqual(['own-old', 'a-old']);
        servers[A].listed = [row_('a-old', T(0.1)), row_('a-new', T(-1))];
        servers[B].listed = [row_('own-old', T(0.2)), row_('own-new', T(-2))];
        servers[C].listed = [row_('c-mid', T(0.5))];
        await askAgain();
        expect(listed()).toEqual(['c-mid', 'own-old', 'a-old', 'a-new', 'own-new']);
    });

    it('a send settled by an answer whose rows are the ones already shown moves its chat\'s place all the same', async () => {
        await lists();
        // Dana's line gets there first, in an answer asked before the send; then the send; then the very same answer, asked after it.
        servers[B].listed = [row_('own-new', T(-2)), row_('own-old', T(-50))];
        const asking = holdNext((m, p) => m === 'GET' && p === '/api/your-groups');
        const first = yourGroupsStore.refresh();
        await asking.asked;
        await new Promise((r) => setTimeout(r, 5));
        yourGroupsStore.noteSent('own-old');
        servers[B].listed = [row_('own-old', T(-0.5)), row_('own-new', T(-2))];
        asking.letGo();
        await first;
        expect(listed()[0]).toBe('own-old');
        const shown = yourGroupsStore.getState().items;
        await askAgain();
        expect(yourGroupsStore.getState().items, 'drawn again').not.toBe(shown);
        expect(yourGroupsStore.movedAt(yourGroupsStore.getState().items![0])).toBeLessThan(Date.now() - 1_000_000);
    });

    it('a community no longer held counts no more: a line sent in one in use takes the top of what is drawn, not of what was', async () => {
        await lists();
        servers[A].listed = [row_('a-new', T(24 * 100))];
        await heldGroups.refresh(me.publicKey);
        h.store.set('beanpool_guest_nodes', JSON.stringify([A]));
        await heldGroups.refresh(me.publicKey);
        expect(listed()).toEqual(['own-new', 'c-mid', 'own-old']);
        yourGroupsStore.noteSent('own-old');
        expect(yourGroupsStore.movedAt(yourGroupsStore.getState().items![0])).toBeLessThanOrEqual(Date.now());
    });

    it('F3: a row of the community in use is never another community\'s, whatever its server writes on it; a held row always is', async () => {
        await lists();
        servers[B].listed = [{ ...row_('own-new', T(-2)), key: 'held-group:x:own-new', community: A, communityName: 'Riverside', movedAt: Date.now() + 1e10 }];
        await yourGroupsStore.refresh();
        const all = groupsListed(yourGroupsStore.getState().items!, heldGroups.getState(), yourGroupsStore.movedAt);
        expect(all.map((i) => [i.conversationId, isHeldGroup(i)])).toEqual([['a-new', true], ['own-new', false], ['c-mid', true], ['a-old', true]]);
        // Mutation: told apart by its fields again -> own-new is A's, and above them all.
    });
});
