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

const h = vi.hoisted(() => ({ dir: '', store: new Map<string, string>(), me: { publicKey: '', privateKey: '' } }));

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
import { forgetGroupKeys } from '../group-chat-keys';
import { groupChatShownLines, openGroupThread, GROUP_KEYS_FOR_DM_TEXT, type OpenedGroupThread } from '../group-chat-lines';
import { dmPeerPinsStoreKey, dmConversationsSeenStoreKey } from '../storage-keys';
import { chatInPlaceRoute } from '../held-chats';
import { heldGroups } from '../held-groups';

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

interface Server { epochs: any[]; lines: any[]; wordsIn: string[]; left: boolean }
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
    if (p === '/api/your-groups') return answer(200, { items: s.left ? [] : [{ kind: 'group', badge: null, id: g, conversationId: g, name: 'Garden Crew', avatarUrl: '/uploads/garden.jpg', role: 'member', readOnly: false, lastMessage: null, unreadCount: 2, mute: null, lastActivityAt: '2026-11-21T00:00:00.000Z' }, { kind: 'event', id: 'event-1', conversationId: 'event-1', name: 'Working bee', avatarUrl: null, role: 'going', badge: null, readOnly: false, lastMessage: null, unreadCount: 1, mute: null, lastActivityAt: '2026-11-22T00:00:00.000Z' }], totalUnread: 3 });
    if (p === at && method === 'GET') return answer(200, { id: g, name: 'Garden Crew', memberCount: 2, viewerRole: 'member' });
    if (p === `${at}/members` && method === 'GET') return answer(200, [me, peer].map((m, i) => ({ memberPubkey: m.publicKey, callsign: i ? 'Dana' : 'Me', status: 'active', role: 'member' })));
    if (p === `${at}/guests`) return answer(200, { guests: [], on: false });
    if (p === `${at}/keys` && method === 'GET') {
        const after = Number(u.searchParams.get('after') ?? 0);
        const epochs = s.epochs.filter((e) => e.epoch > after);
        return answer(200, {
            current: s.epochs.length ? s.epochs[s.epochs.length - 1].epoch : null, stale: false, fromEpoch: s.epochs.length ? 1 : null,
            roster: [me.publicKey, peer.publicKey].sort(), epochs: epochs.map(({ wraps: _w, ...e }) => e),
            myWraps: epochs.flatMap((e) => e.wraps.filter((w: any) => w.recipient === me.publicKey).map((w: any) => ({ ...w, epoch: e.epoch, wrapper: e.createdBy, sig: null }))), more: false,
        });
    }
    if (p === `${at}/keys/epoch` && method === 'POST') { s.epochs.push(body.epoch); return answer(200, { ok: true }); }
    if (p === `${at}/keys/missing`) return answer(200, { missing: [] });
    if (p === `${at}/chat` && method === 'GET') {
        return answer(200, { conversation: { id: g, name: 'Garden Crew' }, group: { name: 'Garden Crew' }, messages: s.lines, canPost: true, isConvenor: true, encryption: { current: s.epochs.length || null, stale: false, fromEpoch: s.epochs.length ? 1 : null } });
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
