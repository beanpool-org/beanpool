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
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const h = vi.hoisted(() => ({
    dir: '', store: new Map<string, string>(), me: { publicKey: '', privateKey: '' },
    /** The next writes of `file` that read as `sql` (past the first `skip`): `hit` as each is run, and SQLite refuses it when `refuse`. */
    cut: null as null | { file: string; sql: RegExp; times: number; refuse: boolean; hit: () => void; skip?: number },
}));

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
                    const cut = h.cut;
                    if (cut && cut.file === name && cut.times > 0 && cut.sql.test(q) && !(cut.skip && cut.skip-- > 0)) {
                        cut.times--;
                        cut.hit();
                        if (cut.refuse) throw new Error('database is locked');
                    }
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
import { forgetGroupKeys, groupKeyring, memoryGroupKeyStore, GROUP_KEY_ROLLBACK_TEXT, GROUP_KEY_STORE_UNREAD_TEXT } from '../group-chat-keys';
import { makeEpochRecord, sealLine } from '../group-chat-crypto';
import { addGroupKeyState, sqliteGroupKeyStore, GROUP_KEY_TABLES_SQL } from '../group-chat-store';
import { groupChatShownLines, openGroupThread, GROUP_CHAT_LOCK_LOST_TEXT, GROUP_KEYS_FOR_DM_TEXT, type OpenedGroupThread } from '../group-chat-lines';
import { dmPeerPinsStoreKey, dmConversationsSeenStoreKey } from '../storage-keys';
import { chatInPlaceRoute } from '../held-chats';
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
    if (p === `${at}/chat` && method === 'GET') {
        return answer(200, { conversation: { id: g, name: 'Garden Crew' }, group: { name: 'Garden Crew' }, messages: s.lines, canPost: true, isConvenor: true, encryption: s.unlocked ? undefined : { current: s.epochs.length || null, stale: false, fromEpoch: s.epochs.length ? 1 : null } });
    }
    if (p === `${at}/chat/message` && method === 'POST') {
        if (typeof body.text === 'string') s.wordsIn.push(body.text);
        s.lines.push({ id: body.clientId, authorPubkey: me.publicKey, authorCallsign: 'Me', type: 'text', ciphertext: body.ciphertext, nonce: body.nonce, metadata: body.metadata ?? null, timestamp: new Date().toISOString() });
        return answer(201, { success: true, message: { id: body.clientId } });
    }
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
    forgetGroupKeys();
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
        forgetGroupKeys();
        const { groupKeyring } = await import('../group-chat-keys');
        const fresh = groupKeyring(A, { ...h.me }, g, db.groupKeyStore(A));
        await expect(fresh.seenLocked()).rejects.toMatchObject({ code: 'store' });
        // B, whose file holds the same group's keys (a copy), never stands in for A's.
        expect(asked.filter((r) => r.url.startsWith(B) && r.url.includes('/api/groups'))).toEqual([]);
    });

    it('with no chat held there, the keys\' memory of another community is never opened: it refuses, and no copy of A opens', async () => {
        forgetGroupKeys();
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
    for (const id of ring.signers.keys()) if (!ring.unsavedSigners.has(id) && !signers.has(id)) out.push(`signer ${id}`);
    for (let n = 1; n <= (st?.after ?? 0); n++) if (!epochs.has(n)) out.push(`the cursor past epoch ${n}`);
    return out;
}
const texts = (o: { shown: any[] }) => o.shown.map((m) => m.text);
/** The app starts again, set to `to`: what was in memory is gone, and each file is as it was. */
async function restart(to = B): Promise<void> {
    await db.closeDB();
    forgetGroupKeys();
    db._resetDmPeerPinsForTests();
    db._resetChatsInPlaceForTests();
    h.cut = null;
    await switchPhoneTo(to);
    await settle();
}
/** A copy that holds none of the group's keys (it was joined on another device): its row, and no key, cursor, mark or signer. */
function unheldCopy(): void {
    into(A_FILE, (sql) => { for (const t of ['group_chat_key_state', 'group_chat_epochs', 'group_line_signers', 'group_line_verdicts']) sql.prepare(`DELETE FROM ${t}`).run(); });
    forgetGroupKeys();
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
    const row = (id: string, at: string): YourChat => ({ kind: 'group', badge: null, id, conversationId: id, name: id, avatarUrl: null, role: 'member', readOnly: false, lastMessage: null, unreadCount: 0, mute: null, lastActivityAt: at });
    const listed = () => groupsListed(yourGroupsStore.getState().items ?? [], heldGroups.getState(), yourGroupsStore.movedAt).map((i) => i.conversationId);
    const held = (id: string) => heldGroups.at(heldGroups.getState().find((r) => r.conversationId === id)!.community);
    /** `hours` from this phone's clock now, as a server writes a time. */
    const T = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    /**
     * B in use, A and C held: each one's list as its server sorts it, its newest an hour old by the servers' clock, which is
     * `ahead` hours ahead of this phone's.
     */
    async function lists(ahead = 0): Promise<void> {
        await switchPhoneTo(C);
        await switchPhoneTo(B);
        servers[B].listed = [row('own-new', T(ahead - 2)), row('own-old', T(ahead - 50))];
        servers[A].listed = [row('a-new', T(ahead - 1)), row('a-old', T(ahead - 75))];
        servers[C].listed = [row('c-mid', T(ahead - 3))];
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

    it('once its community shows the line, that line\'s own time counts, held or in use; a newer line in any of them is above it', async () => {
        await lists();
        held('a-old').noteSent('a-old');
        yourGroupsStore.noteSent('own-old');
        expect(listed().slice(0, 2)).toEqual(['own-old', 'a-old']);
        servers[A].listed = [row('a-old', T(0.1)), row('a-new', T(-1))];
        servers[B].listed = [row('own-old', T(0.2)), row('own-new', T(-2))];
        servers[C].listed = [row('c-mid', T(0.5))];
        await askAgain();
        expect(listed()).toEqual(['c-mid', 'own-old', 'a-old', 'a-new', 'own-new']);
    });

    it('a send settled by an answer whose rows are the ones already shown moves its chat\'s place all the same', async () => {
        await lists();
        // Dana's line gets there first, in an answer asked before the send; then the send; then the very same answer, asked after it.
        servers[B].listed = [row('own-new', T(-2)), row('own-old', T(-50))];
        const asking = holdNext((m, p) => m === 'GET' && p === '/api/your-groups');
        const first = yourGroupsStore.refresh();
        await asking.asked;
        await new Promise((r) => setTimeout(r, 5));
        yourGroupsStore.noteSent('own-old');
        servers[B].listed = [row('own-old', T(-0.5)), row('own-new', T(-2))];
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
        servers[A].listed = [row('a-new', T(24 * 100))];
        await heldGroups.refresh(me.publicKey);
        h.store.set('beanpool_guest_nodes', JSON.stringify([A]));
        await heldGroups.refresh(me.publicKey);
        expect(listed()).toEqual(['own-new', 'c-mid', 'own-old']);
        yourGroupsStore.noteSent('own-old');
        expect(yourGroupsStore.movedAt(yourGroupsStore.getState().items![0])).toBeLessThanOrEqual(Date.now());
    });

    it('F3: a row of the community in use is never another community\'s, whatever its server writes on it; a held row always is', async () => {
        await lists();
        servers[B].listed = [{ ...row('own-new', T(-2)), key: 'held-group:x:own-new', community: A, communityName: 'Riverside', movedAt: Date.now() + 1e10 }];
        await yourGroupsStore.refresh();
        const all = groupsListed(yourGroupsStore.getState().items!, heldGroups.getState(), yourGroupsStore.movedAt);
        expect(all.map((i) => [i.conversationId, isHeldGroup(i)])).toEqual([['a-new', true], ['own-new', false], ['c-mid', true], ['a-old', true]]);
        // Mutation: told apart by its fields again -> own-new is A's, and above them all.
    });
});
