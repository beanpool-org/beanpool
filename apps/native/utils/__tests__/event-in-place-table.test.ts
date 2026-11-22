/**
 * Slice S6, events (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §6): an event's chat of another community this
 * phone holds is read and answered there in place, with no switch.
 *
 * One table (close the class): each way the phone can stand to that community (in use; a held member, and a switch to a third
 * one while the answer is on its way; a held guest's look; the chat left; the community taken off) x that community's own
 * gates (the host, Going, Going and not let in yet, Interested, neither, ended, cancelled, gone after 30 days) x each action.
 * Each row asserts which server was asked (A's own, or none), the name it was signed for (the request's own address), allowed
 * or refused in words, and that no community's file or stored state changed.
 *
 * Then the readable rows, failing closed: a chat this phone ever saw locked is never sent readable, in use and in place, the
 * mark in that community's own file, across a restart. Then what may open in place (the route, and the list that names an
 * event), the DM guard, the rows and their unread counts, and Chat's "· Switch" line, which counts no event's lines.
 *
 * Real SQLite files, the real database open, real guard lists and group key memory; each community's server is a stand-in that
 * answers as routes/marketplace.ts, routes/messaging.ts and engine/event-thread.ts do (its sentences are held to theirs).
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
    /** The next writes of `file` that read as `sql`: `hit` as each is run, and SQLite refuses it. */
    cut: null as null | { file: string; sql: RegExp; times: number; hit?: () => unknown },
    /** The next reads of `file` that read as `sql`: `hit` as each is asked (waited for), then it fails when `refuse`. */
    reads: null as null | { file: string; sql: RegExp; times: number; refuse: boolean; hit?: () => unknown },
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    const cutRead = async (name: string, q: string) => {
        const cut = h.reads;
        if (!cut || cut.file !== name || cut.times <= 0 || !cut.sql.test(q)) return;
        cut.times--;
        await cut.hit?.();
        if (cut.refuse) throw new Error('disk I/O error');
    };
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            return {
                runAsync: async (q: string, p?: unknown) => {
                    const cut = h.cut;
                    if (cut && cut.file === name && cut.times > 0 && cut.sql.test(q)) {
                        cut.times--;
                        cut.hit?.();
                        throw new Error('database is locked');
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
import { _resetGroupKeySessionForTests, noteAnsweredLocked, GROUP_KEY_STORE_UNREAD_TEXT } from '../group-chat-keys';
import { GROUP_CHAT_LOCK_LOST_TEXT, GROUP_KEYS_FOR_DM_TEXT } from '../group-chat-lines';
import { GROUP_NONCE_PREFIX } from '../group-chat-crypto';
import { buildSignedHeaders } from '../crypto';
import { dmConversationsSeenStoreKey } from '../storage-keys';
import { chatInPlaceRoute } from '../held-chats';
import { routeChat } from '../chat-route';
import { heldGroupParams, heldGroupShares, heldGroups, isHeldGroup, noticesBesideHeldChats, type HeldGroup } from '../held-groups';
/** The "· Switch" lines beside these group and event rows (as Chat draws them, with no direct chat held). */
const noticesBesideEvents = (notices: Parameters<typeof noticesBesideHeldChats>[0], rows: readonly HeldGroup[]) => noticesBesideHeldChats(notices, heldGroupShares(rows));
import { noteReadInPlace, noteServerUnread, countNotice, readNoticeAlerts, readNoticeCounts } from '../notice-counts';
import { isWaitingForHost } from '../events';
import AsyncStorage from '@react-native-async-storage/async-storage';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-event-in-place-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** A: where the event is. B: the community the phone is set to. C: a third, the phone switches to. */
const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const C = 'https://brookside.example';
const A_FILE = getDatabaseFilenameForNode(A);
const B_FILE = getDatabaseFilenameForNode(B);
const C_FILE = getDatabaseFilenameForNode(C);
const TABLES = ['conversations', 'conversation_participants', 'messages', 'groups', 'group_members', 'group_chat_epochs', 'group_chat_key_state', 'group_line_signers', 'group_line_verdicts', 'event_rsvps', 'posts'];

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── Each community's server: one event, its chat and its gates, as the server's own routes answer ────────────────────

/** The server's own sentences (held to its source below). */
const SAID = {
    notFound: 'Event not found',
    forbidden: 'Only the host and people going can open this event chat',
    waiting: "The host hasn't let you in yet: the chat opens when they do.",
    gone: 'This event is no longer available',
    ended: 'This event has ended. The chat is read-only.',
    cancelled: 'This event was cancelled. The chat is read-only.',
    onlyHost: 'Only the host can remove messages from this event chat',
    notIn: 'You are not in this conversation',
    notParticipant: 'You are not a participant in this conversation',
    noReactions: 'Reactions are not part of an event chat',
    ownPost: 'Failed — must be a registered member, cannot report yourself',
} as const;

type Rsvp = 'host' | 'going' | 'waiting' | 'interested' | null;
interface Server {
    mine: Rsvp;
    state: 'on' | 'ended' | 'cancelled' | 'gone';
    lines: any[]; wordsIn: string[]; reads: number; muted: string | null; reports: any[];
    /** It answers the chat as locked (no event's is, by design). */
    locked?: boolean;
    /** It lists the event to this member as one, or as these rows. */
    listed?: any[];
}
let servers: Record<string, Server>;
let me: Person;
let host: Person;
/** The event in A (the same id names an event in B too: a copied file, so a write into the wrong one shows). */
let ev: string;
let asked: Array<{ method: string; url: string; signed: string | null; body: any }> = [];
let hold: null | { matches: (method: string, p: string) => boolean; seen: () => void; go: Promise<void>; used: boolean } = null;

const server = (mine: Rsvp): Server => ({ mine, state: 'on', lines: [], wordsIn: [], reads: 0, muted: null, reports: [] });
const eventRow = (unread: number) => ({ kind: 'event', badge: null, id: ev, conversationId: ev, name: 'Working bee', avatarUrl: null, role: 'going', readOnly: false, lastMessage: null, unreadCount: unread, mute: null, lastActivityAt: '2026-11-22T00:00:00.000Z' });

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    const res: any = { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
    res.clone = () => res;
    return res;
}
/** engine/event-thread.ts, in its order: gone, then who may read it. Null: they may. */
function refusedChat(s: Server): any {
    if (s.state === 'gone') return answer(410, { error: SAID.gone });
    if (s.mine === 'waiting') return answer(403, { error: SAID.waiting, code: 'waiting_for_host' });
    if (s.mine !== 'host' && s.mine !== 'going') return answer(403, { error: SAID.forbidden });
    return null;
}
const readOnlyReason = (s: Server) => (s.state === 'cancelled' ? SAID.cancelled : s.state === 'ended' ? SAID.ended : null);

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
    const at = `/api/marketplace/posts/${ev}/chat`;
    if (p === '/api/your-groups') return answer(200, { items: s.listed ?? (s.mine === 'host' || s.mine === 'going' ? [eventRow(2)] : []), totalUnread: 0 });
    if (p === at && method === 'GET') {
        const refused = refusedChat(s);
        if (refused) return refused;
        const why = readOnlyReason(s);
        return answer(200, {
            conversation: { id: ev, type: 'event_thread', participants: [me.publicKey, host.publicKey] }, messages: s.lines, readOnly: !!why, readOnlyReason: why, canPost: !why,
            isHost: s.mine === 'host', title: 'Working bee', eventState: s.state === 'cancelled' ? 'cancelled' : 'scheduled', privateNote: 'Gate code 4412', notice: 'Visible to the host.',
            ...(s.locked ? { encryption: { current: 1, stale: false, fromEpoch: 1 } } : {}),
        });
    }
    if (p === `${at}/message` && method === 'POST') {
        const refused = refusedChat(s);
        if (refused) return refused;
        const why = readOnlyReason(s);
        if (why) return answer(400, { error: why });
        s.wordsIn.push(body.text);
        return answer(201, { success: true, message: { id: body.clientId ?? randomUUID() } });
    }
    if (p === `${at}/remove` && method === 'POST') {
        if (s.mine !== 'host') return answer(403, { error: SAID.onlyHost });
        s.lines = s.lines.map((l) => (l.id === body.messageId ? { ...l, type: 'removed' } : l));
        return answer(200, { success: true });
    }
    if (p === '/api/messages/mark-read' && method === 'POST') {
        // The participants mirror follows the RSVP: the host, and Going and let in (syncEventThreadMembership).
        if (s.mine !== 'host' && s.mine !== 'going') return answer(403, { error: SAID.notParticipant });
        s.reads++;
        return answer(200, { success: true });
    }
    if (p === '/api/messages/mute' && method === 'POST') {
        if (refusedChat(s)) return answer(403, { error: SAID.notIn });
        s.muted = body.duration;
        return answer(200, { success: true, mute: { conversationId: body.conversationId, mutedUntil: '2026-11-23T08:00:00.000Z', always: false } });
    }
    if (p === '/api/messages/react' && method === 'POST') return answer(403, { error: SAID.noReactions });
    if (p === '/api/reports' && method === 'POST') {
        if (s.mine === 'host') return answer(400, { error: SAID.ownPost });
        s.reports.push(body);
        return answer(200, { success: true, report: {} });
    }
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
/** A chat's row and its people, as a visit there when the phone was set to it left them. */
const chatRow = (file: string, id: string, type = 'event_thread') => into(file, (sql) => {
    sql.prepare('INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, type, host.publicKey, '2026-11-20T00:00:00.000Z');
    for (const pk of [me.publicKey, host.publicKey]) sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, pk);
});
const mark = (file: string) => into(file, (sql) => { sql.prepare('INSERT INTO group_chat_key_state (group_id) VALUES (?)').run(`${me.publicKey}/${ev}`); });
const marked = (file: string): boolean => !!rowsOf(file)?.group_chat_key_state.some((x: any) => x.group_id === `${me.publicKey}/${ev}`);
const wordsOut = () => Object.fromEntries([A, B, C].map((o) => [o, servers[o].wordsIn]));
const NOTHING = { [A]: [], [B]: [], [C]: [] };
/** The app started again: nothing this session saw is left. */
async function restart(on: string): Promise<void> {
    await db.closeDB();
    _resetGroupKeySessionForTests();
    db._resetChatsInPlaceForTests();
    await switchPhoneTo(on);
    await db.getDb();
    await settle();
}

/** A phone whose member went to an event in A (its row is in A's copy), then was set to B, whose file is a copy of A's. */
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
    host = person();
    h.me = { ...me };
    ev = randomUUID();
    servers = { [A]: server('going'), [B]: server(null), [C]: server(null) };
    servers[A].lines = [{ id: randomUUID(), authorPubkey: host.publicKey, authorCallsign: 'Dana', type: 'text', nonce: 'plaintext-v1', ciphertext: Buffer.from('bring gloves').toString('base64'), timestamp: '2026-11-22T00:00:00.000Z' }];
    hold = null;
    h.cut = null;
    h.reads = null;
    (globalThis as any).fetch = fetchMock;
    await switchPhoneTo(A);
    await db.getDb();
    chatRow(A_FILE, ev);
    await db.closeDB();
    fs.copyFileSync(fileOn(A_FILE), fileOn(B_FILE));
    await switchPhoneTo(B);
    await settle();
    asked = [];
}
beforeEach(async () => { await phoneOnB(); });

const WORDS = 'see you at nine';

// ── The table ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Act {
    name: string;
    to: { method: string; path: () => string };
    run: (community: string | undefined) => Promise<any>;
    /** What that community's server did, as it counts: once when it is allowed, never when it is refused. */
    did: () => number;
    /** The refusal's words at a gate that refuses it; null where it is allowed. */
    says: (gate: GateName) => string | null;
    landed?: (result: any) => boolean;
}
const GATES = {
    'the host': { mine: 'host', state: 'on' },
    'Going': { mine: 'going', state: 'on' },
    'Going, and not let in yet': { mine: 'waiting', state: 'on' },
    'Interested': { mine: 'interested', state: 'on' },
    'neither': { mine: null, state: 'on' },
    'Going, the event ended': { mine: 'going', state: 'ended' },
    'Going, the event cancelled': { mine: 'going', state: 'cancelled' },
    'Going, 30 days after the end': { mine: 'going', state: 'gone' },
} as const;
type GateName = keyof typeof GATES;
const reads = (g: GateName) => ({ 'Going, and not let in yet': SAID.waiting, 'Interested': SAID.forbidden, 'neither': SAID.forbidden, 'Going, 30 days after the end': SAID.gone } as Partial<Record<GateName, string>>)[g] ?? null;
const ACTS: Act[] = [
    {
        name: 'read (getEventChat)', to: { method: 'GET', path: () => `/api/marketplace/posts/${ev}/chat` }, run: (c) => db.getEventChat(ev, undefined, undefined, c), did: () => 0, says: reads,
        landed: (r) => r.messages.length === 1 && r.title === 'Working bee' && r.privateNote === 'Gate code 4412',
    },
    {
        name: 'answer (postEventChatMessage)', to: { method: 'POST', path: () => `/api/marketplace/posts/${ev}/chat/message` }, run: (c) => db.postEventChatMessage(ev, WORDS, undefined, c),
        did: () => servers[A].wordsIn.length, says: (g) => reads(g) ?? ({ 'Going, the event ended': SAID.ended, 'Going, the event cancelled': SAID.cancelled } as Partial<Record<GateName, string>>)[g] ?? null,
        landed: () => servers[A].wordsIn[0] === WORDS,
    },
    {
        name: 'the host removes a line (removeEventChatMessage)', to: { method: 'POST', path: () => `/api/marketplace/posts/${ev}/chat/remove` }, run: (c) => db.removeEventChatMessage(ev, servers[A].lines[0].id, c),
        did: () => servers[A].lines.filter((l) => l.type === 'removed').length, says: (g) => (g === 'the host' ? null : SAID.onlyHost),
    },
    {
        name: 'mark read (markThreadReadOnNode)', to: { method: 'POST', path: () => '/api/messages/mark-read' }, run: (c) => db.markThreadReadOnNode(ev, me.publicKey, c),
        did: () => servers[A].reads, says: (g) => (GATES[g].mine === 'host' || GATES[g].mine === 'going' ? null : SAID.notParticipant),
    },
    {
        name: 'mute (muteChatApi)', to: { method: 'POST', path: () => '/api/messages/mute' }, run: (c) => db.muteChatApi(ev, '8h', c),
        did: () => (servers[A].muted ? 1 : 0), says: (g) => (reads(g) ? SAID.notIn : null), landed: (r) => !!r?.mute && servers[A].muted === '8h',
    },
    {
        name: 'report to the moderators (reportEvent)', to: { method: 'POST', path: () => '/api/reports' }, run: (c) => db.reportEvent(ev, 'Spam or scam: not a real event', c),
        did: () => servers[A].reports.length, says: (g) => (g === 'the host' ? SAID.ownPost : null),
        landed: () => servers[A].reports[0].targetPostId === ev && servers[A].reports[0].reason === 'Spam or scam: not a real event' && servers[A].reports[0].targetPubkey === undefined,
    },
];
const STANDS: Array<{ name: string; first?: () => Promise<void> | void; named: string | undefined; holds: boolean; refused: boolean; meanwhile?: () => Promise<void> }> = [
    { name: 'in use, no community named', first: () => switchPhoneTo(A).then(() => {}), named: undefined, holds: false, refused: false },
    { name: 'in use, named by a screen that opened in place before the switch', first: () => switchPhoneTo(A).then(() => {}), named: A, holds: true, refused: false },
    { name: 'a held member', named: A, holds: true, refused: false },
    { name: 'a held member, the phone switching to a third community meanwhile', named: A, holds: true, refused: false, meanwhile: () => switchPhoneTo(C).then(() => {}) },
    { name: 'a held guest\'s look', first: () => { h.store.set('beanpool_guest_nodes', JSON.stringify([A])); }, named: A, holds: true, refused: true },
    { name: 'the chat left, and not back', first: async () => { db.enterChatInPlace(A); await db.leaveChatInPlace(A); }, named: A, holds: false, refused: true },
    { name: 'the community taken off the phone', first: async () => { await removeSavedNode(A); await removeCommunityCaches([A]); }, named: A, holds: true, refused: true },
];
const about = (x: { url: string }) => /\/api\/(marketplace|messages|reports)/.test(x.url);

describe('an event\'s chat: each way the phone stands x that community\'s gates x each action: its own server, signed for it, allowed or refused in words', () => {
    const cases = ACTS.flatMap((a) => STANDS.flatMap((s) => (Object.keys(GATES) as GateName[]).map((gate) => [a.name, s.name, gate, a, s] as const)));
    it.each(cases)('%s x %s x %s', async (_a, _s, gate, act, stand) => {
        Object.assign(servers[A], GATES[gate]);
        await stand.first?.();
        await settle();
        if (stand.holds) db.enterChatInPlace(A);
        // A line's and a report's strict DM check reads A's own pins and list, which makes them where there were none: empty, never an entry.
        const entries = (stored: Record<string, string>) => Object.fromEntries(Object.entries(stored).filter(([, v]) => !['[]', '{}', '{"pins":{}}'].includes(v)));
        const state = (file: string) => ({ rows: rowsOf(file), stored: file === A_FILE ? entries(storedFor(file)) : storedFor(file) });
        // In use, a read mark is kept in that community's own file too, as ever; in place nothing of it is kept anywhere.
        const files = stand.first && !stand.refused ? [B_FILE, C_FILE] : [A_FILE, B_FILE, C_FILE];
        const all = () => Object.fromEntries(files.map((f) => [f, state(f)]));
        let before = all();
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
            before = all();
            go();
        }
        await running;
        await settle();
        const wanted = `${act.to.method} ${act.to.path()}`;
        for (const r of asked.filter(about)) {
            expect(new URL(r.url).origin, `${r.method} ${r.url}`).toBe(A);
            expect(r.signed, 'signed for the address it went to').toBe(`${r.method} ${r.url}`);
        }
        if (stand.refused) {
            expect(db.isNoCopyInPlace(thrown), String(thrown?.message)).toBe(true);
            expect(String(thrown.message)).toBe('This phone has switched community since this chat was opened.');
            expect(asked.filter(about).map((x) => x.url), 'nothing asked').toEqual([]);
            expect(act.did(), 'nothing done there').toBe(0);
        } else {
            // Asked once, of A, whose own gates decide: its words as it said them, or the thing done there.
            expect(asked.filter(about).map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual([wanted]);
            const says = act.says(gate);
            expect(thrown ? String(thrown.message) : null).toBe(says);
            if (act.name.startsWith('read') && says === SAID.waiting) expect(isWaitingForHost(thrown), 'told as waiting, never as not going').toBe(true);
            if (!says && act.landed) expect(act.landed(result), `${act.name} happened`).toBe(true);
            expect(act.did()).toBe(says || act.name.startsWith('read') ? 0 : 1);
        }
        expect(wordsOut()).toMatchObject({ [B]: [], [C]: [] });
        // Nothing of it in any file or stored state: the private note least of all.
        expect(all()).toEqual(before);
        expect(JSON.stringify([...h.store.values()])).not.toContain('Gate code');
        if (stand.holds) await db.leaveChatInPlace(A);
        if (stand.named && !stand.first) expect(db.heldCopyFiles(), 'left, the copy open in place closes').not.toContain(A_FILE);
    });

    it('every action x every stand x every gate is in the table (336 rows)', () => {
        expect(cases.length).toBe(6 * 7 * 8);
        // The stand-in's words are the server's own.
        const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'server', 'src', p), 'utf8');
        const source = ['engine/event-thread.ts', 'engine/messaging.ts', 'routes/messaging.ts', 'routes/community.ts'].map(read).join('\n');
        for (const said of Object.values(SAID)) expect(source, said).toContain(said);
    });

    it('what no event\'s chat has on any community (a reaction, an edit, a delete: its server refuses each) is refused in place in words, and nothing is asked', async () => {
        const line = servers[A].lines[0].id;
        db.enterChatInPlace(A);
        for (const run of [
            () => db.toggleMessageReactionApi(line, me.publicKey, '👍', A, ev), () => db.deleteMessageApi(line, A, ev),
            () => db.editThreadMessage(line, WORDS, { groupId: ev, metadata: {}, locked: false }, A), () => db.editMessage(ev, line, WORDS, A),
            () => db.insertMessage(ev, me.publicKey, WORDS, undefined, undefined, undefined, A), () => db.postGroupChatMessage(ev, WORDS, randomUUID(), null, undefined, A),
            () => db.getGroupChat(ev, undefined, undefined, A), () => db.markConversationRead(ev, me.publicKey, A).then(() => { throw new Error('This phone has switched community since this chat was opened.'); }),
        ]) {
            asked = [];
            await expect(run()).rejects.toThrow('This phone has switched community since this chat was opened.');
            await settle();
            expect(asked).toEqual([]);
        }
        await db.leaveChatInPlace(A);
        expect(wordsOut()).toEqual(NOTHING);
    });

    it('a line begun as the chat is left still goes to its own community (whileChatInPlace); a poll is refused once it is left', async () => {
        db.enterChatInPlace(A);
        const sending = db.whileChatInPlace(A, () => db.postEventChatMessage(ev, WORDS, undefined, A));
        await db.leaveChatInPlace(A);
        await sending;
        expect(wordsOut()).toEqual({ ...NOTHING, [A]: [WORDS] });
        asked = [];
        expect(db.isNoCopyInPlace(await db.getEventChat(ev, undefined, undefined, A).then(() => null, (e) => e))).toBe(true);
        expect(asked).toEqual([]);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });
});

// ── Fail closed ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a chat this phone ever saw locked is never sent readable: an event\'s, in use and in place (the mark in its own community\'s file)', () => {
    type Where = 'in use' | 'in place';
    const WHERE: Where[] = ['in use', 'in place'];
    const at = (w: Where) => (w === 'in place' ? A : undefined);
    const stand = async (w: Where) => {
        if (w === 'in use') await switchPhoneTo(A);
        await db.getDb();
        if (w === 'in place') db.enterChatInPlace(A);
        asked = [];
    };
    const send = (w: Where) => db.postEventChatMessage(ev, WORDS, randomUUID(), at(w)).then(() => 'went', (e) => String(e?.message || 'no words'));
    const read = (w: Where) => db.getEventChat(ev, undefined, undefined, at(w)).then(() => 'shown', (e) => String(e?.message || 'no words'));

    it.each(WHERE)('%s: never seen locked: the line goes (so it is the mark that stops the rest)', async (w) => {
        await stand(w);
        expect([await read(w), await send(w), wordsOut()]).toEqual(['shown', 'went', { ...NOTHING, [A]: [WORDS] }]);
    });

    it.each(WHERE.flatMap((w) => ([['its own file marked', A_FILE, false], ['only another community\'s file marked', w === 'in use' ? B_FILE : B_FILE, true]] as const).map(([what, file, goes]) => [w, what, file, goes] as const)))('%s, %s', async (w, _what, file, goes) => {
        mark(file);
        await stand(w);
        expect(await send(w)).toBe(goes ? 'went' : GROUP_CHAT_LOCK_LOST_TEXT);
        expect(wordsOut()).toEqual({ ...NOTHING, [A]: goes ? [WORDS] : [] });
        expect([marked(A_FILE), marked(B_FILE)], 'the marks are as they were').toEqual([file === A_FILE, file === B_FILE]);
    });

    it.each(WHERE)('%s: answered locked: marked in its own file and no other before it is shown; then not locked, and after a restart: nothing readable', async (w) => {
        servers[A].locked = true;
        await stand(w);
        expect(await read(w)).toBe('shown');
        expect([marked(A_FILE), marked(B_FILE), marked(C_FILE)]).toEqual([true, false, false]);
        servers[A].locked = false;
        expect([await send(w), wordsOut()]).toEqual([GROUP_CHAT_LOCK_LOST_TEXT, NOTHING]);
        await restart(w === 'in use' ? A : B);
        if (w === 'in place') db.enterChatInPlace(A);
        expect([await read(w), await send(w), wordsOut()]).toEqual(['shown', GROUP_CHAT_LOCK_LOST_TEXT, NOTHING]);
        // And where it opens: never again in the event's own screen, which posts readable words.
        if (w === 'in place') {
            await db.leaveChatInPlace(A);
            expect(await chatInPlaceRoute(me.publicKey, ev, A)).toMatchObject({ open: 'move' });
            await switchPhoneTo(A);
        }
        const asks = { isHeldGroupChat: (id: string) => db.isHeldGroupChat(id), isLockedGroupChat: db.isLockedGroupChat, knownDmConversationId: (id: string) => db.knownDmConversationId(id), getConversationKind: async () => 'event_thread' };
        expect((await routeChat(asks, ev, { event: true })).view).toBe('group');
    });

    it('in place: answered locked, and SQLite refuses the mark: the answer is not shown, nothing readable goes, and the next answer marks it', async () => {
        servers[A].locked = true;
        await stand('in place');
        h.cut = { file: A_FILE, sql: /INTO group_chat_key_state/, times: 1 };
        expect(await read('in place')).toBe(GROUP_KEY_STORE_UNREAD_TEXT);
        expect(marked(A_FILE)).toBe(false);
        servers[A].locked = false;
        expect([await send('in place'), wordsOut()]).toEqual([GROUP_CHAT_LOCK_LOST_TEXT, NOTHING]);
        servers[A].locked = true;
        expect([await read('in place'), marked(A_FILE)]).toEqual(['shown', true]);
    });

    it.each(WHERE)('%s: the same id answered locked by another community this session: refused here, marked only there; a restart asks this file alone', async (w) => {
        servers[B].mine = 'going';
        servers[B].locked = true;
        if (w === 'in use') await switchPhoneTo(B);
        await db.getDb();
        await db.getEventChat(ev);
        await stand(w);
        expect([await send(w), wordsOut(), marked(A_FILE), marked(B_FILE)]).toEqual([GROUP_CHAT_LOCK_LOST_TEXT, NOTHING, false, true]);
        await restart(w === 'in use' ? A : B);
        if (w === 'in place') db.enterChatInPlace(A);
        expect([await send(w), wordsOut()]).toEqual(['went', { ...NOTHING, [A]: [WORDS] }]);
    });

    it('in place: the chat left with a locked answer on its way: not shown, nothing marked elsewhere, and nothing readable this session', async () => {
        servers[A].locked = true;
        await stand('in place');
        let saw!: () => void;
        let go!: () => void;
        const seen = new Promise<void>((r) => { saw = r; });
        hold = { matches: (m, p) => m === 'GET' && p.endsWith('/chat'), seen: () => saw(), go: new Promise((r) => { go = r; }), used: false };
        const reading = read('in place');
        await seen;
        await db.leaveChatInPlace(A);
        go();
        expect(await reading).not.toBe('shown');
        expect([marked(A_FILE), marked(B_FILE)]).toEqual([false, false]);
        servers[A].locked = false;
        db.enterChatInPlace(A);
        expect([await send('in place'), wordsOut()]).toEqual([GROUP_CHAT_LOCK_LOST_TEXT, NOTHING]);
    });

    it.each(WHERE)('%s: its key memory can\'t be read: nothing goes; read again, it goes', async (w) => {
        await stand(w);
        h.reads = { file: A_FILE, sql: /SELECT highest, after FROM group_chat_key_state/, times: 1, refuse: true };
        expect([await send(w), wordsOut()]).toEqual([GROUP_KEY_STORE_UNREAD_TEXT, NOTHING]);
        h.reads = null;
        expect(await send(w)).toBe('went');
    });

    it.each(WHERE)('%s: a group\'s sealed line kept of it, in any capitals: refused', async (w) => {
        into(A_FILE, (sql) => { sql.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type) VALUES ('s1', ?, ?, 'x', ?, 'text')").run(ev, host.publicKey, `${GROUP_NONCE_PREFIX.toUpperCase()}x`); });
        await stand(w);
        expect([await send(w), wordsOut()]).toEqual([GROUP_CHAT_LOCK_LOST_TEXT, NOTHING]);
    });

    /** What lands at the last moment, as its request is signed. */
    const LANDS: Array<[string, () => Promise<unknown> | void, string]> = [
        ['a locked answer for it', () => { noteAnsweredLocked(ev); }, GROUP_CHAT_LOCK_LOST_TEXT],
        ['its key rings dropped (a Force Resync)', async () => { (await import('../group-chat-keys')).forgetGroupKeys(); }, GROUP_KEY_STORE_UNREAD_TEXT],
    ];
    it.each(WHERE.flatMap((w) => LANDS.map(([what, land, said]) => [w, what, land, said] as const)))('%s, and as its request is signed, the last moment before it leaves: %s: it doesn\'t leave', async (w, _what, land, said) => {
        await stand(w);
        vi.mocked(buildSignedHeaders).mockImplementationOnce(async (method: string, url: string) => { await land(); return { 'X-Signed': `${method} ${url}` } as any; });
        expect([await send(w), wordsOut()]).toEqual([said, NOTHING]);
    });

    it.each(WHERE)('%s, the phone switched to a third community as its file is read for the line: to its own community or not at all, never the other', async (w) => {
        await stand(w);
        let moving: Promise<unknown> | null = null;
        h.reads = { file: A_FILE, sql: /SELECT type FROM conversations WHERE id IN/, times: 1, refuse: false, hit: () => { moving ??= switchPhoneTo(C).catch(() => {}); } };
        const said = await send(w);
        await moving;
        await settle();
        expect(wordsOut(), said).toMatchObject({ [B]: [], [C]: [] });
        expect(asked.filter((r) => r.method === 'POST' && about(r) && !r.url.startsWith(A))).toEqual([]);
    });
});

// ── What opens in place, and what never does ────────────────────────────────────────────────────────────────────────

describe('what opens in place: the route, the list that names an event, and the DM guard', () => {
    const opens = async (id = ev, where = A): Promise<string> => { const r: any = await chatInPlaceRoute(me.publicKey, id, where); return r.kind ? `${r.open} ${r.kind}` : r.open; };
    const noRow = () => into(A_FILE, (sql) => { sql.prepare('DELETE FROM conversations WHERE id = ?').run(ev); });

    it('an event A\'s copy keeps opens in place at its saved address, in any capitals; a guest\'s look and a community not kept open nothing; in use is the ordinary route', async () => {
        expect([await opens(), await opens(ev.toUpperCase()), await opens(randomUUID())]).toEqual(['in-place event', 'in-place event', 'move']);
        expect(await chatInPlaceRoute(me.publicKey, ev, 'HTTPS://Riverside.example/any/path')).toMatchObject({ community: A });
        expect([await opens(ev, C), await opens(ev, B)]).toEqual(['nothing', 'here']);
        h.store.set('beanpool_guest_nodes', JSON.stringify([A]));
        expect(await opens()).toBe('nothing');
        await settle();
        expect(db.heldCopyFiles()).toEqual([]);
    });

    it.each([
        ['a direct chat there', 'dm', 'in-place'], ['a group\'s', 'group_thread', 'in-place group'], ['an enterprise\'s', 'enterprise_thread', 'move'], ['a kind this build doesn\'t know', 'moon_thread', 'move'],
    ])('its row there is %s: not an event\'s screen, and no event\'s call of it is asked', async (_n, type, want) => {
        into(A_FILE, (sql) => { sql.prepare('UPDATE conversations SET type = ? WHERE id = ?').run(type, ev); });
        // Its own server's list calling it an event changes nothing.
        await db.fetchHeldYourGroups(me.publicKey, A);
        expect(await opens()).toBe(want);
        db.enterChatInPlace(A);
        asked = [];
        for (const run of [() => db.getEventChat(ev, undefined, undefined, A), () => db.postEventChatMessage(ev, WORDS, undefined, A), () => db.removeEventChatMessage(ev, 'x', A), () => db.reportEvent(ev, 'Other', A)]) {
            expect(db.isNoCopyInPlace(await run().then(() => null, (e) => e))).toBe(true);
        }
        expect(asked).toEqual([]);
        await db.leaveChatInPlace(A);
    });

    it('an event gone to on another device: opens once A\'s own list names it this run, never on B\'s word, and not once it is no longer named', async () => {
        noRow();
        expect(await opens()).toBe('move');
        servers[B].mine = 'going';
        await db.fetchHeldYourGroups(me.publicKey, B);
        expect(await opens()).toBe('move');
        await db.fetchHeldYourGroups(me.publicKey, A);
        expect(await opens()).toBe('in-place event');
        db.enterChatInPlace(A);
        await db.postEventChatMessage(ev, WORDS, undefined, A);
        expect(wordsOut()).toEqual({ ...NOTHING, [A]: [WORDS] });
        await db.leaveChatInPlace(A);
        // The member is no longer Going there (changed on another device): its own list no longer names it.
        servers[A].mine = 'interested';
        await db.fetchHeldYourGroups(me.publicKey, A);
        expect(await opens()).toBe('move');
    });

    it('a list that names one id as an event and as a group: with no row it is neither\'s screen of words its server reads', async () => {
        noRow();
        servers[A].listed = [eventRow(1), { ...eventRow(1), kind: 'group' }];
        await db.fetchHeldYourGroups(me.publicKey, A);
        expect(await opens()).not.toBe('in-place event');
        db.enterChatInPlace(A);
        expect(db.isNoCopyInPlace(await db.postEventChatMessage(ev, WORDS, undefined, A).then(() => null, (e) => e))).toBe(true);
        expect(wordsOut()).toEqual(NOTHING);
    });

    it('a chat whose group keys A\'s copy holds is never an event there, whatever its row or its server says', async () => {
        into(A_FILE, (sql) => { sql.prepare('INSERT INTO group_chat_key_state (group_id, highest) VALUES (?, 1)').run(`${me.publicKey}/${ev}`); });
        await db.fetchHeldYourGroups(me.publicKey, A);
        expect(await opens()).toBe('in-place group');
        db.enterChatInPlace(A);
        asked = [];
        expect(db.isNoCopyInPlace(await db.postEventChatMessage(ev, WORDS, undefined, A).then(() => null, (e) => e))).toBe(true);
        expect(asked).toEqual([]);
    });

    it('A\'s own DM guard list keeps the id: no event there, and nothing is asked; only B\'s keeps it: A\'s event reads and is answered', async () => {
        const pinned = (file: string) => h.store.set(dmConversationsSeenStoreKey(me.publicKey, file), JSON.stringify([ev]));
        pinned(B_FILE);
        expect(await opens()).toBe('in-place event');
        db.enterChatInPlace(A);
        await db.postEventChatMessage(ev, WORDS, undefined, A);
        expect(wordsOut()).toEqual({ ...NOTHING, [A]: [WORDS] });
        pinned(A_FILE);
        asked = [];
        for (const run of [() => db.getEventChat(ev, undefined, undefined, A), () => db.postEventChatMessage(ev, WORDS, undefined, A), () => db.muteChatApi(ev, '8h', A), () => db.reportEvent(ev, 'Other: private words', A)]) {
            const thrown: any = await run().then(() => null, (e) => e);
            // A mute of a direct chat A knows is a direct chat's own mute there.
            if (thrown) expect(db.isNoCopyInPlace(thrown)).toBe(true);
        }
        expect(asked.filter((r) => /marketplace|reports/.test(r.url))).toEqual([]);
        expect(wordsOut()).toEqual({ ...NOTHING, [A]: [WORDS] });
        await db.leaveChatInPlace(A);
    });

    it('A\'s DM pins unreadable: the strict check refuses the line; nothing readable goes on the list\'s word alone', async () => {
        const { dmPeerPinsStoreKey } = await import('../storage-keys');
        db.enterChatInPlace(A);
        h.store.set(dmPeerPinsStoreKey(me.publicKey, A_FILE), '{ not json');
        db._resetDmPeerPinsForTests();
        const thrown: any = await db.postEventChatMessage(ev, WORDS, undefined, A).then(() => null, (e) => e);
        expect(String(thrown?.message ?? '')).not.toBe('');
        expect(wordsOut()).toEqual(NOTHING);
        await db.leaveChatInPlace(A);
    });

    it('a report whose words A\'s DM guard won\'t let out goes with the reason alone, and says so; in use, the community in use\'s guard decides', async () => {
        expect(GROUP_KEYS_FOR_DM_TEXT).toBeTruthy();
        db.enterChatInPlace(A);
        // A's guard can't be read as the words are asked about: the reason still goes, to A.
        h.store.set(dmConversationsSeenStoreKey(me.publicKey, A_FILE), '{ not json');
        const sent = await db.reportEvent(ev, 'Spam or scam: words of mine', A);
        expect([sent.wordsLeftOut, servers[A].reports.map((r) => r.reason)]).toEqual(['unread', ['Spam or scam']]);
        await db.leaveChatInPlace(A);
    });
});

// ── The rows, and Chat's "· Switch" line ────────────────────────────────────────────────────────────────────────────

describe('each event\'s row: its own community and unread count, on Talk → Groups; the "· Switch" line counts none of their lines', () => {
    const rowsNow = () => heldGroups.getState().map((r) => [r.kind, r.community, r.conversationId, r.unreadCount]);
    const URL_A = { url: A, name: 'Riverside' };
    const notice = (count: number, alerts?: number) => ({ ...URL_A, count, ...(alerts === undefined ? {} : { alerts }) });
    const held = (unread: number, over: Partial<HeldGroup> = {}): HeldGroup => ({ ...(eventRow(unread) as any), community: A, communityName: 'Riverside', key: 'k', movedAt: 0, ...over });
    const keep = () => h.store.set('beanpool_saved_nodes', JSON.stringify([{ url: A, name: 'Riverside' }, { url: B, name: 'Hilltop' }]));

    it('listed with its community\'s name and own count, opened by its address; none for the community in use, a guest\'s look, or someone only Interested there', async () => {
        keep();
        servers[B].mine = 'going';
        await heldGroups.refresh(me.publicKey);
        expect(rowsNow()).toEqual([['event', A, ev, 2]]);
        const [row] = heldGroups.getState();
        expect([isHeldGroup(row), row.communityName, heldGroupParams(row)]).toEqual([true, 'Riverside', { id: ev, community: A, communityName: 'Riverside', event: '1', name: 'Working bee' }]);
        // Muted in place: its own row, and only it.
        heldGroups.at(A).setMute(ev, { conversationId: ev, mutedUntil: null, always: true });
        expect(heldGroups.rowsOf(A)[0].mute).toMatchObject({ always: true });
        servers[A].mine = 'interested';
        await heldGroups.refresh(me.publicKey);
        expect(rowsNow()).toEqual([]);
        servers[A].mine = 'going';
        h.store.set('beanpool_guest_nodes', JSON.stringify([A]));
        await heldGroups.refresh(me.publicKey);
        expect(rowsNow()).toEqual([]);
        h.store.delete('beanpool_guest_nodes');
        await switchPhoneTo(A);
        await heldGroups.refresh(me.publicKey);
        expect(rowsNow().filter(([, community]) => community === A)).toEqual([]);
    });

    it('an enterprise its list names has no row here (it doesn\'t open in place); its group and its event do', async () => {
        keep();
        servers[A].listed = [eventRow(2), { ...eventRow(1), kind: 'group', id: 'g1', conversationId: 'g1', name: 'Garden Crew' }, { ...eventRow(4), kind: 'enterprise', id: 'e1', conversationId: 'e1', name: 'Bakery' }];
        await heldGroups.refresh(me.publicKey);
        expect(rowsNow()).toEqual([['event', A, ev, 2], ['group', A, 'g1', 1]]);
    });

    /** Chat's "· Switch" line for A as it would draw now: A's stored number, what a push told of, and the rows as they stand. */
    const lineForA = async () => noticesBesideEvents([{ ...URL_A, count: (await readNoticeCounts(AsyncStorage))[A] ?? 0, alerts: (await readNoticeAlerts(AsyncStorage))[A] ?? 0 }], heldGroups.getState()).map((n) => n.count);

    // walk-s6 1e (23 Nov 2026): this row said "a group's read there moves no number", which kept a group's line read in place on
    // the "· Switch" line until that community's next round (about 6 minutes on the walk). A group's lines now leave it too.
    it('one read in place: its row\'s count goes as it opens; that community\'s number falls by it only once its server took the read, and only once; a group\'s lines go with what a push told of them', async () => {
        keep();
        // 3 a push told of: the group's line, and 2 of another chat's; the event's 2 tell nobody.
        await noteServerUnread(AsyncStorage, A, 5, 3);
        servers[A].listed = [eventRow(2), { ...eventRow(1), kind: 'group', id: 'g1', conversationId: 'g1', name: 'Garden Crew' }];
        await heldGroups.refresh(me.publicKey);
        heldGroups.at(A).markRead('g1');
        await settle();
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [A]: 5 });
        heldGroups.at(A).readThere('g1');
        heldGroups.at(A).readThere('g1');
        await settle();
        expect([await readNoticeCounts(AsyncStorage), await readNoticeAlerts(AsyncStorage)]).toEqual([{ [A]: 4 }, { [A]: 2 }]);
        // The tap, then the screen's first lines: the row says read, A's number waits for A.
        heldGroups.at(A).markRead(ev);
        heldGroups.at(A).markRead(ev);
        await settle();
        expect([rowsNow().map((r) => r[3]), await readNoticeCounts(AsyncStorage)]).toEqual([[0, 0], { [A]: 4 }]);
        // A took the read: the two lines its row showed leave A's number, once however often it answers.
        heldGroups.at(A).readThere(ev);
        heldGroups.at(A).readThere(ev);
        await settle();
        expect([rowsNow().map((r) => r[3]), await readNoticeCounts(AsyncStorage), await readNoticeAlerts(AsyncStorage), await lineForA()]).toEqual([[0, 0], { [A]: 2 }, { [A]: 2 }, [2]]);
    });

    it('an event\'s lines its last count didn\'t hold yet (Chat asks the list on open, no round): a read of them in place never takes the number below what a push told of (#3364 final review)', async () => {
        keep();
        // A's last count: 3 lines, every one told by a push (a person's); the event's 2 came after it, as Chat's list shows.
        await noteServerUnread(AsyncStorage, A, 3, 3);
        servers[A].listed = [eventRow(2)];
        await heldGroups.refresh(me.publicKey);
        expect(await lineForA()).toEqual([3]);
        heldGroups.at(A).markRead(ev);
        heldGroups.at(A).readThere(ev);
        await settle();
        expect([await readNoticeCounts(AsyncStorage), await lineForA()]).toEqual([{ [A]: 3 }, [3]]);
        // Until A's next round, which says its own number.
        await noteServerUnread(AsyncStorage, A, 1, 1);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [A]: 1 });
    });

    it('tapped, and nothing read (backed out of, or the read or its mark refused): the list asked again brings the row\'s count back, and the "· Switch" line is as it was (review of #3364)', async () => {
        keep();
        // 2 lines on the event's row, 3 in a muted chat there that no push told of.
        await noteServerUnread(AsyncStorage, A, 5, 0);
        await heldGroups.refresh(me.publicKey);
        expect([rowsNow().map((r) => r[3]), await lineForA()]).toEqual([[2], [3]]);
        heldGroups.at(A).markRead(ev);
        await settle();
        expect([rowsNow().map((r) => r[3]), await readNoticeCounts(AsyncStorage)]).toEqual([[0], { [A]: 5 }]);
        await heldGroups.refresh(me.publicKey);
        expect([servers[A].reads, rowsNow().map((r) => r[3]), await readNoticeCounts(AsyncStorage), await lineForA()]).toEqual([0, [2], { [A]: 5 }, [3]]);
        // Opened again, and read there this time: the two lines go from A's number, once; the line still says the other 3.
        heldGroups.at(A).markRead(ev);
        heldGroups.at(A).readThere(ev);
        await settle();
        expect([await readNoticeCounts(AsyncStorage), await lineForA()]).toEqual([{ [A]: 3 }, [3]]);
    });

    it('tapped and backed out of, then read elsewhere: once A\'s list says it is read, a later read here takes nothing more off A\'s number', async () => {
        keep();
        await noteServerUnread(AsyncStorage, A, 5, 0);
        await heldGroups.refresh(me.publicKey);
        heldGroups.at(A).markRead(ev);
        // Read in the web app: A's list says none, and A's next round counts the 3 left.
        servers[A].listed = [eventRow(0)];
        await heldGroups.refresh(me.publicKey);
        await noteServerUnread(AsyncStorage, A, 3, 0);
        heldGroups.at(A).markRead(ev);
        heldGroups.at(A).readThere(ev);
        await settle();
        expect([await readNoticeCounts(AsyncStorage), await lineForA()]).toEqual([{ [A]: 3 }, [3]]);
    });

    it('the event screen in place takes the lines off only from its mark-read\'s answer (the wiring)', () => {
        const screen = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'EventChatView.tsx'), 'utf8');
        expect(screen).toContain('markThreadReadOnNode(eventId, identity.publicKey, at).then(() => heldGroups.at(at).readThere(eventId))');
        expect(screen.split('readThere(').length).toBe(2);
        const pane = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'YourGroupsPane.tsx'), 'utf8');
        expect(pane).not.toContain('readThere(');
    });

    it.each([
        ['only event lines wait there, all on their row', notice(2, 0), [held(2)], null],
        ['event lines and a person\'s', notice(3, 1), [held(2)], 1],
        ['two events', notice(5, 0), [held(2), held(3)], null],
        ['an event\'s row not listed yet (its list not answered): counted as before', notice(2, 0), [], 2],
        // walk-s6 1e (23 Nov 2026): these two said a group's row took nothing off, which drew "1 new message in Riverside Walk ·
        // Switch" for a group's line the phone opens in place. Every chat that opens in place now takes its lines off.
        ['a group\'s lines, all on its row (a push told of them): no line', notice(2, 2), [held(2, { kind: 'group' })], null],
        ['a muted group\'s lines, all on its row (no push told of them): no line', notice(2, 0), [held(2, { kind: 'group', mute: { conversationId: ev, mutedUntil: null, always: true } })], null],
        ['a group\'s line and a person\'s, both told by a push', notice(2, 2), [held(1, { kind: 'group' })], 1],
        ['a group\'s line that came since that community\'s last count, and a person\'s it counted: the line can\'t tell them apart and shows none until the next count', notice(1, 1), [held(1, { kind: 'group' })], null],
        ['another community\'s event takes nothing off', notice(2, 0), [held(2, { community: C })], 2],
        ['its address spelled another way: the same community', notice(2, 0), [held(2, { community: 'HTTPS://Riverside.example/' })], null],
        ['an event line that came since that community\'s last count: what a push told of still shows', notice(1, 1), [held(1)], 1],
        ['more on the row than its number knows', notice(1, 0), [held(4)], null],
        ['silent lines that aren\'t an event\'s (a muted chat\'s): still counted', notice(4, 0), [held(1)], 3],
        ['what a push told of isn\'t known: nothing taken off', notice(2), [held(2)], 2],
        ['a row that says no count', notice(2, 0), [held(NaN)], 2],
    ] as const)('%s', (_n, n, rows, count) => {
        expect(noticesBesideEvents([n], rows as unknown as HeldGroup[]).map((x) => [x.url, x.name, x.count])).toEqual(count === null ? [] : [[A, 'Riverside', count]]);
    });

    it('what a push told of: the lines that community said a push would tell, or the pushes since; none of it for a community in use, with alerts off, or not kept', async () => {
        keep();
        await noteServerUnread(AsyncStorage, A, 4, 1);
        expect(await readNoticeAlerts(AsyncStorage)).toEqual({ [A]: 1 });
        await countNotice(AsyncStorage, A, 'n1');
        await countNotice(AsyncStorage, A, 'n2');
        expect(await readNoticeAlerts(AsyncStorage)).toEqual({ [A]: 2 });
        // A tally from before `alerts` was kept: all of them, so nothing is hidden.
        const key = [...h.store.keys()].find((k) => k.includes('notice') && h.store.get(k)!.includes('riverside'))!;
        const tallies = JSON.parse(h.store.get(key)!);
        for (const t of Object.values<any>(tallies)) { delete t.alerts; t.n = 0; }
        h.store.set(key, JSON.stringify(tallies));
        expect(await readNoticeAlerts(AsyncStorage)).toEqual({ [A]: 4 });
        await switchPhoneTo(A);
        expect(await readNoticeAlerts(AsyncStorage)).toEqual({});
    });

    it('read in place takes off what its server counted, never below none, never a push\'s own count, and nothing in use or with no number', async () => {
        keep();
        await noteReadInPlace(AsyncStorage, A, 2);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});
        await noteServerUnread(AsyncStorage, A, 3, 0);
        await noteReadInPlace(AsyncStorage, A, 0);
        await noteReadInPlace(AsyncStorage, A, -4);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [A]: 3 });
        await countNotice(AsyncStorage, A, 'n1');
        await noteReadInPlace(AsyncStorage, A, 9);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [A]: 1 });
        // That community's next answer is its number again.
        await noteServerUnread(AsyncStorage, A, 7, 0);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [A]: 7 });
    });

    it('Chat draws the line from what is left (the wiring)', () => {
        const chats = fs.readFileSync(path.join(__dirname, '..', '..', 'app', '(tabs)', 'chats.tsx'), 'utf8');
        expect(chats).toContain('const inPlaceShares = React.useMemo(() => [...heldChatShares(heldChats, heldFilled), ...heldGroupShares(groupsHeld)], [heldChats, heldFilled, groupsHeld]);');
        expect(chats).toContain('const otherNotices = React.useMemo(() => noticesBesideHeldChats(noticesElsewhere, inPlaceShares), [noticesElsewhere, inPlaceShares]);');
        expect(chats).toContain('<OtherCommunityNotices notices={otherNotices}');
        expect(chats.split('useOtherCommunitiesNotices()').length).toBe(2);
    });
});
