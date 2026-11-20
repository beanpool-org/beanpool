/**
 * Slice S2b (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, "Unread counts and badge" and "Live typing and
 * instant arrival"): Chat's held rows show their own unread count and their newest line's preview, read from their own
 * community's copy, and a held community whose number rose brings its newest lines into its own copy (S2's write path).
 *
 * One table (close the class): {preview, unread, refresh} x {nothing, a switch mid-read (to another community, and onto
 * that very one), the community removed, the account switched, the app killed, pins that can't place the line}. The phone is
 * set to B; the DM lives in A. B's file starts as a copy of A's (the same ids) with the other person's line spoiled and
 * every line read, so a read or a write that reached B would show. Each row asserts: the right file only (B's file, B's
 * stored state and any third copy exactly as they were), no wrong preview (A's own words or none, never B's, never one
 * the pins can't place), every request to A's own server, and a removed copy never made again.
 *
 * Then: a refresh is bounded (one list read, at most HELD_REFRESH_MAX pages, the newest first) and runs once per rise of
 * the community's number; the preview pass reads at most HELD_PREVIEWS_MAX lines; the table of how Chat can see (or miss)
 * a line waiting there, each fetching it exactly once (#3312 review F1); and the cost row at 500 chats.
 *
 * Real SQLite files on disk (node:sqlite), the real db.ts, the real DM pins, real DM sealing between real keys; the node is
 * a stand-in that answers as routes/messaging.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
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
    /** The next held (query_only) read on this file whose SQL holds `sql`: told when it starts, let go by the test. */
    gate: null as null | { file: string; sql: string; started: () => void; release: Promise<void> },
    /** Handles closed while a read was in flight on them (on a phone that read never settles). */
    cutMidRead: [] as string[],
    /** Every held (query_only) read: its file and its SQL. */
    heldReads: [] as Array<{ file: string; sql: string; rows: number }>,
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            let queryOnly = false;
            let inFlight = 0;
            let closed = false;
            const read = async <T,>(q: string, run: () => T): Promise<T> => {
                if (closed) throw new Error('read on a closed handle');
                inFlight++;
                try {
                    const g = h.gate;
                    if (queryOnly && g && g.file === name && q.includes(g.sql)) {
                        h.gate = null;
                        g.started();
                        await g.release;
                        if (closed) throw new Error('cut by a close: on a phone this read never settles');
                    }
                    const out = run();
                    if (queryOnly) h.heldReads.push({ file: name, sql: q, rows: Array.isArray(out) ? out.length : 1 });
                    return out;
                } finally {
                    inFlight--;
                }
            };
            return {
                runAsync: async (q: string, p?: unknown) => {
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                execAsync: async (q: string) => {
                    if (/query_only\s*=\s*1/i.test(q)) queryOnly = true;
                    sql.exec(q);
                },
                getAllAsync: (q: string, p?: unknown) => read(q, () => sql.prepare(q).all(...params(p))),
                getFirstAsync: async (q: string, p?: unknown) => {
                    if (/^\s*PRAGMA\s+user_version\s*$/i.test(q)) return sql.prepare(q).get() ?? null;
                    return read(q, () => sql.prepare(q).get(...params(p)) ?? null);
                },
                withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
                closeAsync: async () => {
                    if (inFlight > 0) h.cutMidRead.push(name);
                    closed = true;
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => (h.me.publicKey ? { ...h.me, callsign: 'Me' } : null)) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => {}) }));
vi.mock('../blocklist', () => ({ getBlockedUsers: vi.fn(async () => []) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { removeCommunityCaches } from '../community-cache';
import { getDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { sealDmLine } from '../e2e-crypto';
import { dmPeerPinsStoreKey, NOTICE_COUNTS_STORE_KEY, PUSH_ALERTS_OFF_STORE_KEY } from '../storage-keys';
import { communityAddress } from '../push-pins';
import { heldChatsFilledIn, heldChatsInView, refreshHeldWhereRose, _resetHeldRefreshForTests, HELD_QUIET_REFRESH_MS, type HeldChatRow, type HeldChatsView } from '../held-chats';

// A finished sync ends with require('react-native') for a DeviceEventEmitter nudge: answered at node's loader for the file.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-held-previews-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** A: where the DM lives (held). B: the community the phone is set to. C: a third, the phone switches to. */
const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const C = 'https://brookside.example';
const A_FILE = getDatabaseFilenameForNode(A);
const B_FILE = getDatabaseFilenameForNode(B);
const C_FILE = getDatabaseFilenameForNode(C);
const ANCHOR = 'beanpool_anchor_url';
const CHAT_TABLES = ['conversations', 'conversation_participants', 'messages'];

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── The node ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Line { id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string; type: string; metadata: string | null; timestamp: string; editedAt: string | null }
interface Conv { id: string; type: string; participants: string[] }
const node = { convs: [] as Conv[], lines: [] as Line[] };
let clock = Date.parse('2026-11-20T00:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();
let asked: Array<{ method: string; url: string }> = [];

interface Hold { matches: (method: string, pathname: string) => boolean; hit: boolean; seen: Promise<void>; seenNow: () => void; release: () => void; released: Promise<void> }
let hold: Hold | null = null;
/** What goes wrong with the next list read, once (the F1 table). */
let listFault: null | 'refused' | 'fails' | 'times out' = null;
function holdFor(matches: Hold['matches']): Hold {
    let seenNow!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((r) => { seenNow = r; });
    const released = new Promise<void>((r) => { release = r; });
    return { matches, hit: false, seen, seenNow, release, released };
}
function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const lastAt = (c: Conv) => node.lines.filter((l) => l.conversationId === c.id).map((l) => l.timestamp).sort().pop() ?? null;
const view = (c: Conv) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-11-20T00:00:00.000Z', lastMessageAt: lastAt(c), unreadCount: 0 });

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    asked.push({ method, url });
    if (hold && !hold.hit && hold.matches(method, u.pathname)) {
        hold.hit = true;
        hold.seenNow();
        await hold.released;
    }
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'POST' && u.pathname === '/api/messages/send') {
        const line: Line = { id: body.id, conversationId: body.conversationId, authorPubkey: body.authorPubkey, ciphertext: body.ciphertext, nonce: body.nonce, type: body.type || 'text', metadata: body.metadata ?? null, timestamp: tick(), editedAt: null };
        node.lines.push(line);
        return answer(200, { success: true, message: line });
    }
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list && listFault) {
        // The next list read goes wrong once: refused, cut by the network, or never answered (until the refresh gives up).
        const fault = listFault;
        listFault = null;
        if (fault === 'refused') return answer(503, { error: 'busy' });
        if (fault === 'fails') throw new TypeError('Network request failed');
        await new Promise<void>((_, reject) => {
            const signal: AbortSignal | undefined = init.signal;
            const give = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
            if (signal?.aborted) give();
            else signal?.addEventListener('abort', give);
        });
    }
    if (list) {
        return answer(200, { conversations: node.convs.filter((c) => c.participants.includes(list[1])).map(view), totalUnread: 0, deletedAccounts: [] });
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
let dm: Conv;
let phoneN = 0;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const PEER_WORDS = 'see you at the market';
const NEW_WORDS = ['two new lines', 'the second of them'];

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
const messagesIn = (file: string) => (rowsOf(file)?.messages ?? []) as any[];

/**
 * A phone that synced its DM with `peer` in A (pinned there): my line, then theirs, neither read. Then set to B, whose file
 * is a copy of A's (the same ids) with the other person's line spoiled and every line marked read. The node then holds
 * two new lines of theirs in A: the walk's "2 unread lines" that showed nowhere until the chat was opened.
 */
async function phoneOnBWithAHeld(): Promise<void> {
    h.gate = null;
    await db.closeDB();
    db._resetDmPeerPinsForTests();
    db._resetChatsInPlaceForTests();
    _resetHeldRefreshForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(ANCHOR, A);
    me = person();
    peer = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    dm = { id: randomUUID(), type: 'dm', participants: [me.publicKey, peer.publicKey] };
    node.convs = [dm];
    node.lines = [];
    hold = null;
    listFault = null;
    h.cutMidRead = [];
    (globalThis as any).fetch = fetchMock;

    expect(await db.syncMessages(me.publicKey)).toBe(true);
    await db.insertMessage(dm.id, me.publicKey, 'my own words');
    await settle();
    nodeLine(dm, peer, PEER_WORDS);
    expect(await db.syncSingleConversation(dm.id)).toBe(true);
    expect(messagesIn(A_FILE).length).toBe(2);
    await db.closeDB();
    fs.copyFileSync(fileOn(A_FILE), fileOn(B_FILE));
    const spoil = new DatabaseSync(fileOn(B_FILE));
    spoil.prepare('UPDATE messages SET ciphertext = ? WHERE author_pubkey = ?').run('spoiled in B', peer.publicKey);
    spoil.prepare("UPDATE conversation_participants SET last_read_at = '2099-01-01T00:00:00.000Z' WHERE public_key = ?").run(me.publicKey);
    spoil.close();
    await switchPhoneTo(B);
    expect(h.store.get(ANCHOR)).toBe(B);
    for (const words of NEW_WORDS) nodeLine(dm, peer, words);
    asked = [];
    h.heldReads = [];
}

/** The rows Chat lists for A (utils/held-chats.ts heldChatRows), as the fill-in pass is handed them. */
function heldRowOf(conv: Conv, timestamp: string | null): HeldChatRow {
    return {
        id: conv.id, type: 'dm', postId: null, postTitle: null, postPhoto: null, peer: 'Kai', peerAvatar: null, peerUpdatedAt: null,
        peerPubkey: peer.publicKey, peerKeys: [peer.publicKey], rawTimestamp: timestamp, createdAt: null,
        key: `held:${A_FILE}:${conv.id}`, held: true, community: A, communityName: 'Riverside',
    };
}

/** What can happen while a held read or a refresh is on its way. */
interface Meanwhile {
    run: (() => Promise<void>) | null;
    /** A's copy is gone from the phone afterwards. */
    removesA: boolean;
    /** Another account is on the phone afterwards. */
    accountLeft?: boolean;
    /** A's pins can't place the line (set before the action). */
    before?: () => void;
}
const MEANWHILE: Record<string, Meanwhile> = {
    'nothing': { run: null, removesA: false },
    'a switch to another community mid-read': { run: async () => { await switchPhoneTo(C); }, removesA: false },
    'a switch onto that very community mid-read': { run: async () => { await switchPhoneTo(A); }, removesA: false },
    'that community removed from the phone': { run: async () => { await removeCommunityCaches([A]); }, removesA: true },
    'the account switched': {
        run: async () => {
            await db.clearDB({ identityLeaves: true });
            await removeCommunityCaches([A, B], { everyCopy: true });
            const other = person();
            h.me = { publicKey: other.publicKey, privateKey: other.privateKey };
        },
        removesA: true, accountLeft: true,
    },
    'the app killed': { run: async () => { await db.closeDB(); db._resetDmPeerPinsForTests(); }, removesA: false },
    // A's pins as stored can't be read: no preview opens, and S2's poll writes nothing into A's file.
    "pins that can't place the line": {
        run: null, removesA: false,
        before: () => { h.store.set(dmPeerPinsStoreKey(me.publicKey, A_FILE), '{not json'); db._resetDmPeerPinsForTests(); },
    },
};

/** Hold the next held read of A whose SQL holds `sql`; resolves once it started. */
function gateHeldRead(sql: string): { started: Promise<void>; release: () => void } {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const releaseP = new Promise<void>((r) => { release = r; });
    h.gate = { file: A_FILE, sql, started, release: releaseP };
    return { started: startedP, release };
}

beforeEach(async () => {
    await phoneOnBWithAHeld();
});

describe('S2b: a held row\'s preview and count come from its own copy, and a refresh writes its own file only', () => {
    const KINDS = ['preview', 'unread', 'refresh'] as const;
    const cases = KINDS.flatMap((k) => Object.keys(MEANWHILE).map((w) => [k, w] as const));
    it.each(cases)('%s, with %s', async (kind, whatName) => {
        const what = MEANWHILE[whatName];
        what.before?.();
        const before = { B: rowsOf(B_FILE), storedB: storedFor(B_FILE) };
        let cAfterCloser: ReturnType<typeof rowsOf> = null;
        const aBefore = messagesIn(A_FILE);
        const aNewest = aBefore.map((m) => m.timestamp).sort().pop();
        const myKey = me.publicKey;

        let result: any;
        let running: Promise<void>;
        if (kind === 'refresh') {
            // The page of the DM (the write that follows its network await) is what is held.
            hold = holdFor((m, p) => m === 'GET' && p === `/api/messages/${dm.id}`);
            running = db.refreshHeldDms(myKey, A).then((r) => { result = r; });
            if (what.run) {
                await hold.seen;
                await what.run();
                await settle();
                // The copy open in place closed at once.
                expect(db.heldCopyFiles()).not.toContain(A_FILE);
            }
            cAfterCloser = rowsOf(C_FILE);
            hold.release();
        } else {
            const gate = gateHeldRead(kind === 'preview' ? 'json_each' : 'COUNT(msg.id)');
            running = (kind === 'preview' ? db.getHeldPreviews(myKey, A, [dm.id]) : db.getHeldLatest(myKey, A)).then((r) => { result = r; });
            await gate.started;
            // A closer waits for the read in flight (never cuts it), so it runs beside it and ends after it.
            const closing = what.run ? what.run() : Promise.resolve();
            await settle();
            gate.release();
            await closing;
        }
        await running;
        await settle();

        // Never a read cut by a close (on a phone, its promise never settles).
        expect(h.cutMidRead).toEqual([]);
        // B's file exactly as it was (unless the account took every copy with it); its stored state too when nothing moved.
        if (!what.accountLeft) expect(rowsOf(B_FILE)).toEqual(before.B);
        if (!what.run) expect(storedFor(B_FILE)).toEqual(before.storedB);
        // A third copy: nothing written into it after the closer.
        if (kind === 'refresh') expect(rowsOf(C_FILE)).toEqual(cAfterCloser);
        // Every chat request went to A's own server.
        for (const r of asked.filter((x) => new URL(x.url).pathname.startsWith('/api/messages'))) expect(new URL(r.url).origin).toBe(A);
        // A removed copy is never made again.
        if (what.removesA) expect(fs.existsSync(fileOn(A_FILE)), "A's copy made again").toBe(false);

        if (kind === 'preview') {
            const preview = result?.[dm.id] ?? null;
            // Never B's spoiled line, never one the pins can't place: A's own words, or none.
            if (preview !== null) expect(preview).toEqual({ lastMessage: PEER_WORDS, lastMessageFromApp: false });
            if (what.before) expect(preview).toBeNull();
            else if (!what.removesA) expect(preview).not.toBeNull();
            // Asked once the account (or the copy) has gone: nothing, for the old key or the new one. (A read already on
            // its way gives the old account's own words from A at most; Chat drops it, its view having ended.)
            if (what.removesA) {
                expect(await db.getHeldPreviews(myKey, A, [dm.id])).toBeNull();
                expect(await db.getHeldPreviews(h.me.publicKey, A, [dm.id])).toBeNull();
                expect(fs.existsSync(fileOn(A_FILE)), "A's copy made again").toBe(false);
            }
        }
        if (kind === 'unread') {
            // A's own count (their one line, unread there; B's copy has every line read) and A's newest line's time.
            const row = (result as db.HeldLatest[] | null)?.find((r) => r.id === dm.id);
            expect(row).toEqual({ id: dm.id, type: 'dm', newest: aNewest, unread: 1 });
        }
        if (kind === 'refresh') {
            const fresh = new Set(node.lines.slice(-NEW_WORDS.length).map((l) => l.id));
            const newIn = (file: string) => messagesIn(file).filter((m) => fresh.has(m.id)).length;
            expect(newIn(B_FILE), 'nothing of the refresh in B').toBe(0);
            if (whatName === 'nothing' || whatName === 'a switch onto that very community mid-read') {
                // Landed in A's file: through the copy open in place, or through the copy in use once the phone is on A.
                expect(result).toEqual({ brought: 1, answered: true });
                expect(newIn(A_FILE)).toBe(2);
            } else if (what.removesA) {
                expect(rowsOf(A_FILE)).toBeNull();
            } else {
                // Cut by a closer (switched away, killed) or refused by the pins: nothing written anywhere.
                expect(result).toEqual({ brought: 0, answered: true });
                expect(messagesIn(A_FILE)).toEqual(aBefore);
            }
            // The copy open in place is closed again once the refresh is done.
            expect(db.heldCopyFiles()).not.toContain(A_FILE);
        }
    });

    it('after the app was killed mid-refresh, the next refresh brings the two lines into A, and the row shows them', async () => {
        hold = holdFor((m, p) => m === 'GET' && p === `/api/messages/${dm.id}`);
        const first = db.refreshHeldDms(me.publicKey, A);
        await hold.seen;
        await db.closeDB();
        db._resetDmPeerPinsForTests();
        hold.release();
        expect(await first).toEqual({ brought: 0, answered: true });
        hold = null;
        expect(await db.refreshHeldDms(me.publicKey, A)).toEqual({ brought: 1, answered: true });
        const latest = await db.getHeldLatest(me.publicKey, A);
        expect(latest?.find((r) => r.id === dm.id)?.unread).toBe(3);
        const filled = await heldChatsFilledIn(me.publicKey, [heldRowOf(dm, latest![0].newest)]);
        expect(filled.get(`held:${A_FILE}:${dm.id}`)).toEqual({ unread: 3, lastMessage: NEW_WORDS[1], lastMessageFromApp: false });
        expect(messagesIn(B_FILE).some((m) => m.ciphertext === 'spoiled in B')).toBe(true);
    });

    it('pins that name another key for the chat (a re-key not followed): no preview, never the line as theirs', async () => {
        const key = dmPeerPinsStoreKey(me.publicKey, A_FILE);
        const stored = JSON.parse(h.store.get(key)!);
        stored.pins[dm.id] = { ...stored.pins[dm.id], peer: person().publicKey, former: [] };
        h.store.set(key, JSON.stringify(stored));
        db._resetDmPeerPinsForTests();
        expect((await db.getHeldPreviews(me.publicKey, A, [dm.id]))?.[dm.id]).toBeNull();
        // Pins readable, but none for this chat (never pinned there): none, never the line's own author taken as its key.
        delete stored.pins[dm.id];
        h.store.set(key, JSON.stringify(stored));
        db._resetDmPeerPinsForTests();
        expect((await db.getHeldPreviews(me.publicKey, A, [dm.id]))?.[dm.id]).toBeNull();
        // Pins that can't be read: none either.
        h.store.set(key, '{not json');
        db._resetDmPeerPinsForTests();
        expect((await db.getHeldPreviews(me.publicKey, A, [dm.id]))?.[dm.id]).toBeNull();
        // And the refresh writes nothing into A while its pins can't be read (S2's gate).
        expect(await db.refreshHeldDms(me.publicKey, A)).toEqual({ brought: 0, answered: true });
        expect(messagesIn(A_FILE).length).toBe(2);
    });

    it('S7c, the R10 rule: a line under the key on offer (a verified person\'s change waiting there) shows no preview, even when an earlier judgement put that key into `former`', async () => {
        const key = dmPeerPinsStoreKey(me.publicKey, A_FILE);
        const stored = JSON.parse(h.store.get(key)!);
        const pinned = person().publicKey;
        // Control: the line's key is a former one, no offer: its words, as before.
        stored.pins[dm.id] = { ...stored.pins[dm.id], peer: pinned, former: [peer.publicKey] };
        h.store.set(key, JSON.stringify(stored));
        db._resetDmPeerPinsForTests();
        expect((await db.getHeldPreviews(me.publicKey, A, [dm.id]))?.[dm.id]).toEqual({ lastMessage: PEER_WORDS, lastMessageFromApp: false });
        // That same key on offer, waiting for the member there: no words until they continue with it (dmShownFormer, as
        // Chat's own list for the community in use: db.ts getConversations).
        stored.pins[dm.id] = { ...stored.pins[dm.id], offered: { peer: peer.publicKey, at: '2026-11-20T00:00:00.000Z' } };
        h.store.set(key, JSON.stringify(stored));
        db._resetDmPeerPinsForTests();
        expect((await db.getHeldPreviews(me.publicKey, A, [dm.id]))?.[dm.id]).toBeNull();
    });

    it('another account on the phone: a preview asked with the old key opens nothing, and a refresh asks nothing more', async () => {
        const old = me.publicKey;
        const other = person();
        h.me = { publicKey: other.publicKey, privateKey: other.privateKey };
        expect((await db.getHeldPreviews(old, A, [dm.id]))?.[dm.id]).toBeNull();
        asked = [];
        expect(await db.refreshHeldDms(old, A)).toEqual({ brought: 0, answered: true });
        expect(asked.filter((r) => r.url.includes(`/api/messages/${dm.id}`))).toEqual([]);
        expect(messagesIn(A_FILE).length).toBe(2);
    });
});

describe('S2b: bounded', () => {
    it('one refresh reads the list once and at most HELD_REFRESH_MAX pages, newest first; nothing for the community in use', async () => {
        // Seven more DMs held in A, each with a new line on the node.
        const more: Conv[] = [];
        await switchPhoneTo(A);
        for (let i = 0; i < 7; i++) {
            const other = person();
            const conv: Conv = { id: randomUUID(), type: 'dm', participants: [me.publicKey, other.publicKey] };
            node.convs.push(conv);
            nodeLine(conv, other, `hello ${i}`);
            more.push(conv);
        }
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        for (const conv of more) expect(await db.syncSingleConversation(conv.id)).toBe(true);
        // Nothing for the community in use: its own sync brings it.
        asked = [];
        expect(await db.refreshHeldDms(me.publicKey, A)).toEqual({ brought: 0, answered: true });
        expect(asked).toEqual([]);
        await switchPhoneTo(B);
        for (const conv of more) nodeLine(conv, person(), 'not theirs either');
        asked = [];
        const { brought } = await db.refreshHeldDms(me.publicKey, A);
        const lists = asked.filter((r) => /\/api\/messages\/conversations\//.test(r.url));
        const pages = asked.filter((r) => /\/api\/messages\/[^/]+$/.test(new URL(r.url).pathname) && !/conversations/.test(r.url));
        expect(lists.length).toBe(1);
        expect(pages.length).toBe(db.HELD_REFRESH_MAX);
        expect(brought).toBe(db.HELD_REFRESH_MAX);
        // The newest first: the last lines the node took.
        const newest = [...node.convs].sort((a, b) => (lastAt(a)! < lastAt(b)! ? 1 : -1)).slice(0, db.HELD_REFRESH_MAX).map((c) => c.id);
        expect(pages.map((r) => decodeURIComponent(new URL(r.url).pathname.split('/').pop()!)).sort()).toEqual(newest.sort());

        // Chat left while the first page is on its way: no next chat is asked.
        for (const conv of more) nodeLine(conv, person(), 'and again');
        let inView = true;
        hold = holdFor((m, p) => m === 'GET' && /^\/api\/messages\/[^/]+$/.test(p) && !p.includes('conversations'));
        asked = [];
        const cut = db.refreshHeldDms(me.publicKey, A, () => inView);
        await hold.seen;
        inView = false;
        hold.release();
        expect(await cut).toEqual({ brought: 1, answered: true });
        expect(asked.filter((r) => /\/api\/messages\/[^/]+$/.test(new URL(r.url).pathname) && !/conversations/.test(r.url)).length).toBe(1);
        expect(db.heldCopyFiles()).not.toContain(A_FILE);
    });

    it('a refresh runs once per rise of the community\'s number, and again only when it rises further', async () => {
        const viewNow = heldChatsInView();
        const rows = [heldRowOf(dm, null)];
        const setNumber = (n: number) => h.store.set(NOTICE_COUNTS_STORE_KEY, JSON.stringify({ [communityAddress(A)!]: { n: 0, seen: {}, server: n, alerts: n } }));
        const pages = () => asked.filter((r) => r.url.includes(`/api/messages/${dm.id}`)).length;
        setNumber(2);
        expect(await refreshHeldWhereRose(me.publicKey, rows, viewNow)).toEqual([A]);
        expect(pages()).toBe(1);
        // The same number again (a round that changed nothing, a push already counted): nothing asked.
        asked = [];
        expect(await refreshHeldWhereRose(me.publicKey, rows, viewNow)).toEqual([]);
        expect(asked).toEqual([]);
        // It falls (read elsewhere), then rises again: one more refresh.
        setNumber(0);
        expect(await refreshHeldWhereRose(me.publicKey, rows, viewNow)).toEqual([]);
        expect(asked).toEqual([]);
        nodeLine(dm, peer, 'and a third');
        setNumber(1);
        expect(await refreshHeldWhereRose(me.publicKey, rows, viewNow)).toEqual([A]);
        expect(pages()).toBe(1);
        // Chat left: nothing more is asked.
        await viewNow.leave();
        nodeLine(dm, peer, 'and a fourth');
        setNumber(5);
        asked = [];
        expect(await refreshHeldWhereRose(me.publicKey, rows, viewNow)).toEqual([]);
        expect(asked).toEqual([]);
    });

    it('the preview pass opens at most HELD_PREVIEWS_MAX lines, the newest held DMs across communities', async () => {
        const rows: HeldChatRow[] = Array.from({ length: 30 }, (_, i) => ({ ...heldRowOf({ ...dm, id: `${dm.id.slice(0, 30)}-${String(i).padStart(4, '0')}` }, `2026-11-20T01:${String(i).padStart(2, '0')}:00.000Z`) }));
        rows.push(heldRowOf(dm, '2026-11-20T00:00:00.000Z'));
        h.heldReads = [];
        await heldChatsFilledIn(me.publicKey, rows);
        const previewReads = h.heldReads.filter((r) => r.sql.includes('json_each'));
        expect(previewReads.length).toBe(1);
        expect(previewReads[0].rows).toBeLessThanOrEqual(db.HELD_PREVIEWS_MAX);
        // The real DM is the oldest of the 31 rows, past the 20 newest: no preview read for it.
        const filled = await heldChatsFilledIn(me.publicKey, rows);
        expect(filled.get(`held:${A_FILE}:${dm.id}`)).toEqual({ unread: 1, lastMessage: null, lastMessageFromApp: true });
    });
});

describe('S2b: a line that waits in a held community is fetched exactly once, however Chat saw it (#3312 review F1)', () => {
    /** The community's number (notice-counts.ts), as a round's answer leaves it. */
    const setNumber = (n: number) => h.store.set(NOTICE_COUNTS_STORE_KEY, JSON.stringify({ [communityAddress(A)!]: { n: 0, seen: {}, server: n, alerts: n } }));
    const isPage = (r: { url: string }) => new URL(r.url).pathname === `/api/messages/${dm.id}`;
    const isList = (r: { url: string }) => /^\/api\/messages\/conversations\//.test(new URL(r.url).pathname);
    /** Chat in view: its refresh, called as Chat calls it (its focus, a count's change, the beat). */
    interface Chat { view: HeldChatsView; refresh: () => Promise<string[]> }
    const openChat = (): Chat => {
        const view = heldChatsInView();
        return { view, refresh: () => refreshHeldWhereRose(me.publicKey, [heldRowOf(dm, null)], view) };
    };
    /** The clock the beat reads, moved on by the test. */
    let skew = 0;
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    let spies: Array<{ mockRestore: () => void }> = [];

    beforeEach(async () => {
        // A's copy holds every line there first (the walk's two new lines brought), then the row's own line arrives.
        expect((await db.refreshHeldDms(me.publicKey, A)).brought).toBe(1);
        expect(messagesIn(A_FILE).length).toBe(node.lines.length);
        asked = [];
        skew = 0;
        spies = [
            vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew),
            // The refresh's own wait for the list runs out at once (its 10 s), so "times out" is the real timer and abort.
            vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: any[]) => void, ms?: number, ...rest: any[]) =>
                realSetTimeout(fn, ms === db.HELD_REFRESH_LIST_MS ? 0 : ms, ...rest)) as typeof setTimeout),
        ];
    });
    afterEach(() => {
        for (const spy of spies) spy.mockRestore();
    });

    /** Each row ends in the stretch of Chat that should have brought the line, and hands it back. */
    const ROWS: Record<string, () => Promise<Chat>> = {
        'a rise seen while Chat is in view': async () => {
            const chat = openChat();
            expect(await chat.refresh()).toEqual([]);
            expect(asked).toEqual([]);
            nodeLine(dm, peer, 'a new line');
            setNumber(1);
            await chat.refresh();
            return chat;
        },
        'a fall and a rise while Chat is away': async () => {
            // Chat opens on one unread line A's copy already holds: one list read, nothing to bring.
            setNumber(1);
            const first = openChat();
            expect(await first.refresh()).toEqual([]);
            await first.view.leave();
            // Away: that chat read in place (1 -> 0), and a new line there (0 -> 1). Chat saw neither.
            setNumber(0);
            nodeLine(dm, peer, 'a new line');
            setNumber(1);
            const back = openChat();
            await back.refresh();
            return back;
        },
        'Chat left while the list read is on its way': async () => {
            nodeLine(dm, peer, 'a new line');
            setNumber(1);
            const first = openChat();
            hold = holdFor((m, p) => m === 'GET' && p.startsWith('/api/messages/conversations/'));
            const cut = first.refresh();
            await hold.seen;
            await first.view.leave();
            hold.release();
            expect(await cut).toEqual([]);
            hold = null;
            const back = openChat();
            await back.refresh();
            return back;
        },
        ...Object.fromEntries(([['is refused', 'refused'], ['fails', 'fails'], ['times out', 'times out']] as const).map(([said, fault]) => [`the list read ${said}`, async () => {
            nodeLine(dm, peer, 'a new line');
            setNumber(1);
            const chat = openChat();
            listFault = fault;
            expect(await chat.refresh()).toEqual([]);
            expect(asked.filter(isList).length).toBe(1);
            expect(asked.filter(isPage).length).toBe(0);
            // The next call at the same number (the beat, or another community's count changing) asks again.
            await chat.refresh();
            return chat;
        }])),
        "alerts off for that community (no number): on Chat's focus": async () => {
            h.store.set(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify([A]));
            nodeLine(dm, peer, 'a new line');
            // A tally kept from before its alerts went off counts for nothing (notice-counts.ts leaves it out).
            setNumber(4);
            const chat = openChat();
            await chat.refresh();
            return chat;
        },
        'alerts off, a line that comes while Chat stays in view: on the next beat': async () => {
            h.store.set(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify([A]));
            const chat = openChat();
            // On focus: one list read, nothing new yet.
            expect(await chat.refresh()).toEqual([]);
            expect(asked.filter(isList).length).toBe(1);
            nodeLine(dm, peer, 'a new line');
            // Before the beat: nothing asked.
            asked = [];
            expect(await chat.refresh()).toEqual([]);
            expect(asked).toEqual([]);
            skew += HELD_QUIET_REFRESH_MS;
            await chat.refresh();
            return chat;
        },
        // #3312 review F3: Chat's 15 s beat starts at focus, but the focus refresh notes its time only after the rows are read;
        // the first beat must still count as due, or the line waits a second beat.
        'alerts off, the focus refresh noted late (rows read first): the first beat still brings the line': async () => {
            h.store.set(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify([A]));
            const chat = openChat();
            skew = 300; // the interval started at 0; the focus refresh runs once the rows are read
            expect(await chat.refresh()).toEqual([]);
            nodeLine(dm, peer, 'a new line');
            skew = HELD_QUIET_REFRESH_MS; // the beat: 15 s after the interval started, 14.7 s after the focus refresh
            await chat.refresh();
            return chat;
        },
    };

    it.each(Object.keys(ROWS))('%s', async (name) => {
        const lineCount = node.lines.length;
        const chat = await ROWS[name]();
        await settle();
        const added = node.lines.slice(lineCount);
        expect(added.length).toBe(1);
        // The new line is in A's own copy, brought by exactly one read of its page.
        expect(messagesIn(A_FILE).map((m) => m.id)).toContain(added[0].id);
        expect(asked.filter(isPage).length).toBe(1);
        // Nothing in B's.
        expect(messagesIn(B_FILE).map((m) => m.id)).not.toContain(added[0].id);
        // Once brought, the same Chat asks nothing more at the same number, before the next beat.
        asked = [];
        expect(await chat.refresh()).toEqual([]);
        expect(asked).toEqual([]);
        await chat.view.leave();
        expect(db.heldCopyFiles()).toEqual([]);
    });
});

describe('S2b: the cost at 500 chats', () => {
    it('rows, counts and previews of a held copy with 500 chats and 10,000 lines', async () => {
        // A's copy grown to 500 DMs of 20 lines each, the newest of each a real sealed line of its person, pinned in A.
        const sql = new DatabaseSync(fileOn(A_FILE));
        const pinsKey = dmPeerPinsStoreKey(me.publicKey, A_FILE);
        const stored = JSON.parse(h.store.get(pinsKey)!);
        const people = Array.from({ length: 10 }, person);
        sql.exec('BEGIN');
        const conv = sql.prepare('INSERT INTO conversations (id, type, name, created_by, created_at) VALUES (?, ?, NULL, ?, ?)');
        const part = sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)');
        const line = sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (let c = 0; c < 499; c++) {
            const id = randomUUID();
            const them = people[c % people.length];
            conv.run(id, 'dm', me.publicKey, '2026-11-01T00:00:00.000Z');
            part.run(id, me.publicKey);
            part.run(id, them.publicKey);
            for (let l = 0; l < 19; l++) line.run(randomUUID(), id, them.publicKey, 'AAAA', 'x25519-xc20p-v2:AAAA', 'text', `2026-11-0${1 + (l % 9)}T00:00:${String(l).padStart(2, '0')}.000Z`);
            const lineId = randomUUID();
            const sealed = sealDmLine(`line ${c}`, { myEdPrivHex: them.privateKey, peerEdPubHex: me.publicKey, conversationId: id }, { senderPubHex: them.publicKey, messageId: lineId });
            line.run(lineId, id, them.publicKey, sealed.ciphertext, sealed.nonce, 'text', `2026-11-15T00:${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}.000Z`);
            stored.pins[id] = { peer: them.publicKey, since: '2026-11-01T00:00:00.000Z', by: 'first-seen', checked: true };
        }
        sql.exec('COMMIT');
        sql.close();
        h.store.set(pinsKey, JSON.stringify(stored));
        db._resetDmPeerPinsForTests();
        const { syncedCursorKeyOf } = await import('../../services/pillar-sync');
        if (!h.store.get(syncedCursorKeyOf(A_FILE))) h.store.set(syncedCursorKeyOf(A_FILE), '1');

        const ms = async <T,>(run: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const out = await run(); return [out, performance.now() - t]; };
        await db.getHeldConversations(me.publicKey, A); // the handle's first open, as Chat's first read pays it
        const [rows, rowsMs] = await ms(() => db.getHeldConversations(me.publicKey, A));
        const [latest, latestMs] = await ms(() => db.getHeldLatest(me.publicKey, A));
        expect(rows!.length).toBe(500);
        expect(latest!.length).toBe(500);
        const heldRows: HeldChatRow[] = rows!.map((r) => ({ ...r, key: `held:${A_FILE}:${r.id}`, held: true, community: A, communityName: 'Riverside' }));
        h.heldReads = [];
        const [filled, fillMs] = await ms(() => heldChatsFilledIn(me.publicKey, heldRows));
        const previews = [...filled.values()].filter((f) => f.lastMessage);
        expect(previews.length).toBe(db.HELD_PREVIEWS_MAX);
        expect(h.heldReads.filter((r) => r.sql.includes('json_each')).map((r) => r.rows)).toEqual([db.HELD_PREVIEWS_MAX]);
        // Handed more ids than that, the read itself opens no more.
        h.heldReads = [];
        expect(Object.keys((await db.getHeldPreviews(me.publicKey, A, rows!.slice(0, 30).map((r) => r.id)))!).length).toBe(db.HELD_PREVIEWS_MAX);
        expect(h.heldReads.filter((r) => r.sql.includes('json_each')).map((r) => r.rows)).toEqual([db.HELD_PREVIEWS_MAX]);
        // A second held community just as big: still 20 previews in all, the newest across both.
        const D = 'https://lakeside.example';
        const D_FILE = getDatabaseFilenameForNode(D);
        await db.closeDB();
        // The copy is in WAL mode: its lines into the file itself first, so the copy carries them.
        const checkpoint = new DatabaseSync(fileOn(A_FILE));
        checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        checkpoint.close();
        fs.copyFileSync(fileOn(A_FILE), fileOn(D_FILE));
        h.store.set(dmPeerPinsStoreKey(me.publicKey, D_FILE), h.store.get(pinsKey)!);
        const dRows: HeldChatRow[] = heldRows.map((r) => ({ ...r, key: `held:${D_FILE}:${r.id}`, community: D, rawTimestamp: r.rawTimestamp ? r.rawTimestamp.replace(/^2026/, '2027') : null }));
        h.heldReads = [];
        const both = await heldChatsFilledIn(me.publicKey, [...heldRows, ...dRows]);
        const shown = [...both.entries()].filter(([, f]) => f.lastMessage);
        expect(shown.length).toBe(db.HELD_PREVIEWS_MAX);
        // D's rows say they are a year newer: all 20 are D's.
        expect(shown.every(([k]) => k.startsWith(`held:${D_FILE}:`))).toBe(true);
        expect(h.heldReads.filter((r) => r.sql.includes('json_each')).reduce((n, r) => n + r.rows, 0)).toBe(db.HELD_PREVIEWS_MAX);
        console.log(`[cost at 500 chats, 10,000 lines] rows ${rowsMs.toFixed(1)} ms (Chat's first paint, unchanged); after they show: counts ${latestMs.toFixed(1)} ms, counts + ${db.HELD_PREVIEWS_MAX} previews ${fillMs.toFixed(1)} ms`);
    });
});
