/**
 * Slice S3 (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Message requests", §6 S3; Marty 19 Nov 2026 "yes to
 * all 5"): a message request waiting in another community this phone holds is read and answered there in place, with no
 * switch. Every in-place request action lands in the file and on the server of the community it was asked of, and never in
 * another's, whatever happens while it is on its way.
 *
 * One table (close the class): each in-place request action (the list read there, a card's preview, Accept, Decline,
 * Report, Report and block) x each thing that can happen meanwhile (nothing, a switch to another community, a switch onto
 * that very community, that community removed from the phone, the account leaving the phone, the app killed). The phone is
 * set to B; the request is A's (the away community), and arrived after the phone left A. B's file starts as a copy of A's,
 * so a write by id into the wrong file would show. Each row asserts:
 * - every chat request the action made went to A's own server (signed for its name);
 * - B's file and stored state, and any third copy, are exactly as they were when the answer landed;
 * - with nothing happening meanwhile (or a switch onto A itself), the action's effect is in A's file;
 * - after a closer, the copy open in place is closed at once, and a removed copy (and its stored list) is never made again.
 *
 * Then what the list read may write (#3305 review F1's rule, for requests): only a direct chat for this member, as that
 * community's own server lists it, and never over a group whose keys A's copy holds or a row of another kind.
 *
 * Real SQLite files on disk (node:sqlite, in a directory of this test's own), the real database open, the real DM pins,
 * real DM sealing between real keys; the node is a stand-in that answers as routes/messaging.ts does. The block's own
 * routing (that community's list and its report) is pinned in blocks-reach-community.test.ts; here blockUser is a stand-in
 * that records the community it was handed.
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
    blocks: [] as unknown[][],
    /** Called before each statement the phone writes (a row may change something mid-write). */
    beforeRun: null as null | ((q: string, p: unknown[]) => void),
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
                    h.beforeRun?.(q, params(p));
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
// The block's own routing is blocks-reach-community.test.ts's: here it records the community the report handed it.
vi.mock('../blocklist', () => {
    const getBlockedUsers = vi.fn(async (): Promise<string[]> => []);
    return {
        getBlockedUsers,
        blockUser: vi.fn(async (...args: unknown[]) => { h.blocks.push(args); return true; }),
        isUserBlocked: vi.fn(async () => true),
        // Block first (slice S7b; its own tables are let-in-once's, on the real lists): here the phone's list is the one
        // getBlockedUsers stubs, no community's own list holds anyone, and each community's list counts as read this run.
        readBlockLists: async () => ({ onPhone: new Set(await getBlockedUsers()), once: new Set<string>(), seenThere: new Set<string>() }),
        blockedAnywhere: (lists: { onPhone: ReadonlySet<string>; seenThere: ReadonlySet<string> }, keys: readonly string[]) => keys.some((k) => lists.onPhone.has(k) || lists.seenThere.has(k)),
        blockListReadThisRun: async () => true,
    };
});
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
import { messageRequestsStoreKey, dmPeerPinsStoreKey, MESSAGE_REQUESTS_STORE_PREFIX } from '../storage-keys';
import { reportRequestAndBlock } from '../request-report';
import { getBlockedUsers } from '../blocklist';
import { LISTED_ADDRESS_FIELDS } from '../listed-address-fields';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-requests-in-place-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** A: where the request waits (away). B: the community the phone is set to. C: a third, the phone switches to. */
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
interface Conv { id: string; type: string; participants: string[]; request?: { from: string; state: string; at: string } }
const node = { convs: [] as Conv[], lines: [] as Line[], groups: [] as any[] };
let clock = Date.parse('2026-11-20T00:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();
let asked: Array<{ method: string; url: string; body?: any }> = [];

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
const view = (c: Conv) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-11-20T00:00:00.000Z', ...(c.request ? { request: c.request } : {}) });
const waitingFor = (c: Conv, me: string) => c.request?.state === 'pending' && c.request.from !== me;

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    asked.push({ method, url, body });
    if (hold && !hold.url && hold.matches(method, u.pathname)) {
        hold.url = url;
        hold.seenNow();
        await hold.released;
    }
    if (method === 'POST' && u.pathname === '/api/messages/send') {
        const line: Line = { id: body.id, conversationId: body.conversationId, authorPubkey: body.authorPubkey, ciphertext: body.ciphertext, nonce: body.nonce, type: body.type || 'text', metadata: body.metadata ?? null, timestamp: tick(), editedAt: null };
        node.lines.push(line);
        return answer(200, { success: true, message: line });
    }
    if (method === 'POST' && u.pathname === '/api/messages/request') {
        const conv = node.convs.find((c) => c.id === body.conversationId);
        if (!conv?.request) return answer(404, { error: 'There is no message request for you in this chat.', code: 'request_not_found' });
        conv.request = { ...conv.request, state: body.decision === 'accept' ? 'accepted' : 'ignored' };
        return answer(200, { success: true, request: conv.request });
    }
    if (method === 'POST' && u.pathname === '/api/messages/report') return answer(200, { success: true, reportId: randomUUID() });
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        const mine = node.convs.filter((c) => c.participants.includes(list[1]));
        const requests = mine.filter((c) => waitingFor(c, list[1]));
        return answer(200, { conversations: mine.filter((c) => !requests.includes(c)).map(view), totalUnread: 0, deletedAccounts: [], requests: { count: requests.length, conversations: requests.map(view) } });
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page && method === 'GET') {
        const conv = node.convs.find((c) => c.id === decodeURIComponent(page[1]));
        if (!conv) return answer(404, { error: 'Conversation not found' });
        return answer(200, { conversation: view(conv), messages: node.lines.filter((l) => l.conversationId === conv.id).map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    // The member's groups, each with the asking member's role in it (routes/groups.ts viewerRole, viewerStatus).
    if (u.pathname === '/api/groups' && method === 'GET') return answer(200, node.groups);
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
let asker: Person;
let dm: Conv;
let req: Conv;
let askerLine: Line;
let phoneN = 0;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const ASKER_WORDS = 'hello, can we talk about the ladder?';

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
const requestOf = (rows: Record<string, any[]> | null, id: string) => {
    const raw = rows?.conversations.find((c: any) => c.id === id)?.request;
    return raw ? JSON.parse(String(raw)) : null;
};

/**
 * A phone that synced its DM with `peer` in A, then was set to B, whose file is a copy of A's. Afterwards `asker` writes the
 * member a first line in A: a request, waiting there, that this phone has never seen.
 */
async function phoneOnBWithARequestAway(): Promise<void> {
    await db.closeDB();
    db._resetDmPeerPinsForTests();
    db._resetChatsInPlaceForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(ANCHOR, A);
    h.blocks = [];
    h.beforeRun = null;
    me = person();
    peer = person();
    asker = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    dm = { id: randomUUID(), type: 'dm', participants: [me.publicKey, peer.publicKey] };
    node.convs = [dm];
    node.lines = [];
    node.groups = [];
    nodeLine(dm, peer, 'an old friend');
    hold = null;
    (globalThis as any).fetch = fetchMock;

    expect(await db.syncMessages(me.publicKey)).toBe(true);
    await settle();
    await db.closeDB();
    fs.copyFileSync(fileOn(A_FILE), fileOn(B_FILE));
    await switchPhoneTo(B);
    expect(h.store.get(ANCHOR)).toBe(B);

    req = { id: randomUUID(), type: 'dm', participants: [asker.publicKey, me.publicKey], request: { from: asker.publicKey, state: 'pending', at: tick() } };
    node.convs.push(req);
    askerLine = nodeLine(req, asker, ASKER_WORDS);
    asked = [];
}

/** The list read there in place: A's copy now holds the request as a DM. */
const readThere = async () => { expect((await db.requestsInPlace(me.publicKey, A))?.conversations.map((c: any) => c.id)).toEqual([req.id]); };
/** And its preview: the line is in A's copy. */
const previewThere = async () => { await readThere(); expect(await db.syncSingleConversation(req.id, A)).toBe(true); };

interface Act {
    name: string;
    held: (method: string, pathname: string) => boolean;
    before?: () => Promise<void>;
    act: () => Promise<unknown>;
    landed: (a: Record<string, any[]>, result: any) => boolean;
}

const ACTS: Act[] = [
    {
        name: 'the list read there (requestsInPlace)',
        held: (m, p) => m === 'GET' && p.startsWith('/api/messages/conversations/'),
        act: () => db.requestsInPlace(me.publicKey, A),
        landed: (a, r) => r?.conversations?.[0]?.id === req.id && a.conversations.some((c: any) => c.id === req.id && c.type === 'dm')
            && a.conversation_participants.some((p: any) => p.conversation_id === req.id && p.public_key === me.publicKey),
    },
    {
        name: 'a card\'s preview (syncSingleConversation)',
        held: (m, p) => m === 'GET' && p === `/api/messages/${req.id}`,
        before: readThere,
        act: () => db.syncSingleConversation(req.id, A),
        landed: (a) => a.messages.some((m: any) => m.id === askerLine.id),
    },
    {
        name: 'Accept (decideMessageRequest)',
        held: (m, p) => m === 'POST' && p === '/api/messages/request',
        before: readThere,
        act: () => db.decideMessageRequest(req.id, 'accept', A),
        landed: (a) => requestOf(a, req.id)?.state === 'accepted',
    },
    {
        name: 'Decline (decideMessageRequest)',
        held: (m, p) => m === 'POST' && p === '/api/messages/request',
        before: readThere,
        act: () => db.decideMessageRequest(req.id, 'ignore', A),
        landed: (a) => requestOf(a, req.id)?.state === 'ignored',
    },
    {
        name: 'Report its line (reportDmLine)',
        held: (m, p) => m === 'POST' && p === '/api/messages/report',
        before: previewThere,
        act: () => db.reportDmLine(req.id, askerLine.id, ASKER_WORDS, 'Spam or scam', A),
        landed: (_a, r) => !!r?.success,
    },
    {
        name: 'Report and block (reportRequestAndBlock)',
        held: (m, p) => m === 'POST' && p === '/api/messages/report',
        before: previewThere,
        act: () => reportRequestAndBlock(req.id, { id: askerLine.id, text: ASKER_WORDS }, asker.publicKey, 'Spam or scam', me.publicKey, A),
        landed: (_a, r) => r === 'reported' && h.blocks.length === 1 && h.blocks[0][0] === asker.publicKey && h.blocks[0][4] === A,
    },
];

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
    await phoneOnBWithARequestAway();
});

describe('a request in place: every action lands in the file and on the server of the community asked, never another', () => {
    const cases = ACTS.flatMap((a) => Object.keys(MEANWHILE).map((w) => [a.name, w, a] as const));
    it.each(cases)('%s, with %s meanwhile', async (_name, whatName, row) => {
        const what = MEANWHILE[whatName];
        if (row.before) await row.before();
        // A's kept list as the action starts (the phone's own sync there kept one before it left A).
        const listOfA = h.store.get(messageRequestsStoreKey(me.publicKey, A_FILE));
        asked = [];
        hold = holdFor(row.held);
        let result: unknown;
        let thrown: unknown = null;
        const running = row.act().then((r) => { result = r; }, (e) => { thrown = e; });
        await hold.seen;

        if (what.run) await what.run();
        await settle();
        if (what.closes) expect(db.heldCopyFiles(), 'the copy open in place closed at once').not.toContain(A_FILE);
        const others = { B: rowsOf(B_FILE), C: rowsOf(C_FILE), storedB: storedFor(B_FILE), storedC: storedFor(C_FILE) };

        hold.release();
        await running;
        await settle();

        // Every chat request went to A's own server, the held one among them.
        const chat = asked.filter((r) => new URL(r.url).pathname.startsWith('/api/messages'));
        expect(chat.length, 'the action asked its server').toBeGreaterThan(0);
        for (const r of chat) expect(new URL(r.url).origin, `${r.method} ${new URL(r.url).pathname}`).toBe(A);
        // Nothing of it in any other community's file or stored state.
        expect({ B: rowsOf(B_FILE), C: rowsOf(C_FILE), storedB: storedFor(B_FILE), storedC: storedFor(C_FILE) }).toEqual(others);
        // Never a request or a row of A's in B's file.
        expect((rowsOf(B_FILE)?.conversations ?? []).some((c: any) => c.id === req.id)).toBe(false);

        if (whatName === 'nothing' || whatName === 'a switch onto that very community') {
            expect(thrown, String((thrown as any)?.message ?? '')).toBeNull();
            expect(row.landed(rowsOf(A_FILE) as any, result), 'its effect is in A\'s file').toBe(true);
        }
        if (whatName === 'nothing') {
            await db.leaveChatInPlace(A);
            expect(db.heldCopyFiles(), 'left, the copy open in place closes').not.toContain(A_FILE);
        }
        if (what.removesA) {
            expect(fs.existsSync(fileOn(A_FILE)), 'a removed copy is never made again').toBe(false);
            // Its kept list is not written by an answer that came after the removal (removal itself leaves that store as
            // it was before this slice: no community's list is read from it but the one the phone is set to).
            expect(h.store.get(messageRequestsStoreKey(me.publicKey, A_FILE)), 'nor its list of requests').toBe(listOfA);
            expect(db.heldCopyFiles()).not.toContain(A_FILE);
        }
        if (whatName === 'the app killed') {
            // The next start, set to B again: the list read there brings A's server's word into A's file only.
            hold = null;
            await db.getDb();
            const bAfter = rowsOf(B_FILE);
            asked = [];
            const again = await db.requestsInPlace(me.publicKey, A);
            // Still waiting at A (no decision reached it, or a report): listed and kept in A's copy. Decided: listed no more.
            expect(again?.conversations.map((c: any) => c.id)).toEqual(req.request?.state === 'pending' ? [req.id] : []);
            if (req.request?.state === 'pending') expect(rowsOf(A_FILE)!.conversations.some((c: any) => c.id === req.id)).toBe(true);
            for (const r of asked) expect(new URL(r.url).origin).toBe(A);
            expect(rowsOf(B_FILE)).toEqual(bAfter);
            await db.leaveChatInPlace(A);
        }
    });
});

describe('the list read there in place: what it may write, and where it is kept', () => {
    it('keeps the list for A\'s file alone, and the card\'s line opens from A\'s copy with A\'s pins', async () => {
        await previewThere();
        expect(JSON.parse(h.store.get(messageRequestsStoreKey(me.publicKey, A_FILE))!).conversations.map((c: any) => c.id)).toEqual([req.id]);
        expect(h.store.has(messageRequestsStoreKey(me.publicKey, B_FILE))).toBe(false);
        const lines = await db.getMessages(req.id, { community: A, limit: 20 });
        expect(lines.map((m: any) => m.text)).toContain(ASKER_WORDS);
        // B, the community in use, still knows nothing of it.
        expect(await db.getMessageRequests(me.publicKey)).toBeNull();
        expect((await db.getMessages(req.id)).length).toBe(0);
        await db.leaveChatInPlace(A);
    });

    it('a request the node lists as anything but a direct chat for this member is never written into A\'s copy', async () => {
        const group: Conv = { id: randomUUID(), type: 'group_thread', participants: [asker.publicKey, me.publicKey], request: { from: asker.publicKey, state: 'pending', at: tick() } };
        const three: Conv = { id: randomUUID(), type: 'dm', participants: [asker.publicKey, me.publicKey, peer.publicKey], request: { from: asker.publicKey, state: 'pending', at: tick() } };
        const mine: Conv = { id: randomUUID(), type: 'dm', participants: [asker.publicKey, me.publicKey], request: { from: me.publicKey, state: 'pending', at: tick() } };
        const stranger: Conv = { id: randomUUID(), type: 'dm', participants: [asker.publicKey, me.publicKey], request: { from: peer.publicKey, state: 'pending', at: tick() } };
        node.convs.push(group, three, stranger);
        // The node lists the member's own request as one for them too (a node that lies): still not theirs to answer.
        const page = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init: any = {}) => {
            const res: any = await page(url, init);
            if (!new URL(url).pathname.startsWith('/api/messages/conversations/')) return res;
            const body = await res.json();
            body.requests.conversations.push(view(mine));
            return answer(200, body);
        });
        try {
            const read = await db.requestsInPlace(me.publicKey, A);
            expect(read?.conversations.map((c: any) => c.id)).toEqual([req.id]);
            const ids = (rowsOf(A_FILE)!.conversations as any[]).map((c) => c.id);
            for (const c of [group, three, mine, stranger]) expect(ids).not.toContain(c.id);
        } finally {
            fetchMock.mockImplementation(page);
            await db.leaveChatInPlace(A);
        }
    });

    it('never over a group whose keys A\'s copy holds, nor a row of another kind: those are not answered there in place', async () => {
        const sql = new DatabaseSync(fileOn(A_FILE));
        sql.prepare('INSERT INTO group_chat_key_state (group_id, highest) VALUES (?, ?)').run(`${me.publicKey}/${req.id.toLowerCase()}`, 2);
        sql.close();
        const enterprise: Conv = { id: randomUUID(), type: 'dm', participants: [asker.publicKey, me.publicKey], request: { from: asker.publicKey, state: 'pending', at: tick() } };
        node.convs.push(enterprise);
        const sql2 = new DatabaseSync(fileOn(A_FILE));
        sql2.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'enterprise_thread', '', ?)").run(enterprise.id, tick());
        sql2.close();
        await db.requestsInPlace(me.publicKey, A);
        const rows = rowsOf(A_FILE)!;
        expect((rows.conversations as any[]).some((c) => c.id === req.id)).toBe(false);
        expect((rows.conversations as any[]).find((c) => c.id === enterprise.id)?.type).toBe('enterprise_thread');
        asked = [];
        await expect(db.decideMessageRequest(req.id, 'accept', A)).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
        await expect(db.decideMessageRequest(enterprise.id, 'accept', A)).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
        expect(asked).toEqual([]);
        await db.leaveChatInPlace(A);
    });

    it('the community in use, one not saved, and a guest\'s look: not read in place (null), nothing asked, nothing written', async () => {
        h.store.set('beanpool_guest_nodes', JSON.stringify([C]));
        for (const where of [B, 'https://elsewhere.example', C]) {
            asked = [];
            const before = rowsOf(getDatabaseFilenameForNode(where));
            expect(await db.requestsInPlace(me.publicKey, where)).toBeNull();
            expect(asked).toEqual([]);
            expect(rowsOf(getDatabaseFilenameForNode(where))).toEqual(before);
        }
    });

    it('a request left (its chat closed in place, held by nothing): refused before anything is asked', async () => {
        await readThere();
        await db.leaveChatInPlace(A);
        asked = [];
        expect(await db.requestsInPlace(me.publicKey, A)).toBeNull();
        await expect(db.decideMessageRequest(req.id, 'accept', A)).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
        expect(asked).toEqual([]);
        // Held again (Message requests opened again): it reads.
        db.enterChatInPlace(A);
        await readThere();
        await db.leaveChatInPlace(A);
    });
});

/**
 * #3309 review: what the list read in place hands a card, and what it writes.
 * - F1 (close the class): a request whose opener this phone's account blocked never comes back as a card, by any key the
 *   person is known by in A's copy (the listing's people, the copy's pin for the chat), as Chat's list judges a DM.
 * - F2 (close the class): every address a listing carries comes back whole on A, the card's community, never as a path the
 *   community in use (B) would be asked for; one row per field, and a guard that reads the engine's listing for any field
 *   named like an address.
 * - F3: the count kept, less each listed request left out here.
 * - The pins note (§3.4 amendment 5): A's pins are read first, and a pinned DM's people are [me, the pinned key].
 */
describe('the list read in place: blocked people, addresses, the count and the pins (#3309 review)', () => {
    afterEach(async () => {
        vi.mocked(getBlockedUsers).mockResolvedValue([]);
        await db.leaveChatInPlace(A);
    });

    /** A's list, as its server answers it, changed by `change` first (a field a node of another build sends, a request more). */
    async function withListing<T>(change: (requests: { count: number; conversations: any[] }) => void, run: () => Promise<T>): Promise<T> {
        const page = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init: any = {}) => {
            const res: any = await page(url, init);
            if (!new URL(url).pathname.startsWith('/api/messages/conversations/')) return res;
            const body = await res.json();
            change(body.requests);
            return answer(200, body);
        });
        try {
            return await run();
        } finally {
            fetchMock.mockImplementation(page);
        }
    }
    const keptForA = () => JSON.parse(h.store.get(messageRequestsStoreKey(me.publicKey, A_FILE)) ?? 'null');
    const peopleOf = (id: string) => (rowsOf(A_FILE)!.conversation_participants as any[]).filter((p) => p.conversation_id === id).map((p) => p.public_key).sort();

    /**
     * The person behind `peer`'s DM in A re-keyed since the phone left A: A now lists that chat as a request from their new
     * key. A's copy pinned the chat to their old key, which the listing no longer names.
     */
    function rekeyedRequestOnTheDm(): { now: Person; listing: any } {
        const now = person();
        const listing = { id: dm.id, type: 'dm', name: null, participants: [now.publicKey, me.publicKey], createdBy: now.publicKey, createdAt: '2026-11-20T00:00:00.000Z', request: { from: now.publicKey, state: 'pending', at: tick() } };
        return { now, listing };
    }

    // F1: each way the person can be known in A's copy, by the key the block list holds.
    it.each([
        ['the key A lists them under', () => [asker.publicKey], () => req.id],
        ['the key A\'s copy pinned the chat to (they re-keyed since; the listing names only their new key)', () => [peer.publicKey], () => dm.id],
    ] as const)('someone blocked, by %s: no card, nothing written, the count less it', async (_how, blockedKeys, chat) => {
        expect(peopleOf(dm.id), 'A\'s copy holds the DM with peer, pinned there').toEqual([me.publicKey, peer.publicKey].sort());
        const rekeyed = rekeyedRequestOnTheDm();
        vi.mocked(getBlockedUsers).mockResolvedValue(blockedKeys());
        const read = await withListing((r) => { r.conversations.push(rekeyed.listing); r.count += 1; }, () => db.requestsInPlace(me.publicKey, A));
        const shown = read!.conversations.map((c: any) => c.id);
        expect(shown).not.toContain(chat());
        expect(shown).toHaveLength(1);
        expect(read!.count).toBe(1);
        // Kept for A's own file without them too, and nothing of theirs written into A's copy.
        expect(keptForA().conversations.map((c: any) => c.id)).toEqual(shown);
        if (chat() === req.id) expect((rowsOf(A_FILE)!.conversations as any[]).some((c) => c.id === req.id)).toBe(false);
        expect(peopleOf(dm.id)).toEqual([me.publicKey, peer.publicKey].sort());
    });

    it('control: someone else blocked: both cards stay', async () => {
        const rekeyed = rekeyedRequestOnTheDm();
        vi.mocked(getBlockedUsers).mockResolvedValue([person().publicKey]);
        const read = await withListing((r) => { r.conversations.push(rekeyed.listing); r.count += 1; }, () => db.requestsInPlace(me.publicKey, A));
        expect(read!.conversations.map((c: any) => c.id).sort()).toEqual([req.id, dm.id].sort());
        expect(read!.count).toBe(2);
    });

    // The pins note: a pinned DM's people are [me, the pinned key], never the listing's new key beside them.
    it('a request on a DM A\'s copy pinned: its people stay [me, the pinned key]; the listing\'s new key is not written beside them', async () => {
        const rekeyed = rekeyedRequestOnTheDm();
        const read = await withListing((r) => { r.conversations.push(rekeyed.listing); r.count += 1; }, () => db.requestsInPlace(me.publicKey, A));
        expect(read!.conversations.map((c: any) => c.id)).toContain(dm.id);
        expect(peopleOf(dm.id)).toEqual([me.publicKey, peer.publicKey].sort());
        expect(peopleOf(dm.id)).not.toContain(rekeyed.now.publicKey);
        // A request on a chat A's copy never pinned: the listing's people, as before.
        expect(peopleOf(req.id)).toEqual([me.publicKey, asker.publicKey].sort());
    });

    // F3: the node's count, less each listed one left out here.
    it('the count: the node\'s, less each listed one left out here (blocked, or not a direct chat for the member)', async () => {
        const group = { id: randomUUID(), type: 'group_thread', name: null, participants: [asker.publicKey, me.publicKey], createdBy: asker.publicKey, createdAt: '2026-11-20T00:00:00.000Z', request: { from: asker.publicKey, state: 'pending', at: tick() } };
        const rekeyed = rekeyedRequestOnTheDm();
        vi.mocked(getBlockedUsers).mockResolvedValue([rekeyed.now.publicKey]);
        // A lists three of the 140 waiting there: one shown, one blocked, one a group.
        const read = await withListing((r) => { r.conversations.push(rekeyed.listing, group); r.count = 140; }, () => db.requestsInPlace(me.publicKey, A));
        expect(read!.conversations.map((c: any) => c.id)).toEqual([req.id]);
        expect(read!.count).toBe(138);
    });

    // F2: one row per address field: what comes back is whole on A, never a path B would be asked for.
    it.each(LISTED_ADDRESS_FIELDS.map((f) => [f] as const))('%s, a path on A\'s server, comes back whole on A, never on the community in use', async (field) => {
        const where = `/api/avatar/${asker.publicKey}?size=thumb&v=r1&k=facekey`;
        const read = await withListing((r) => { for (const c of r.conversations) c[field] = where; }, () => db.requestsInPlace(me.publicKey, A));
        const got = read!.conversations[0][field];
        expect(new URL(got).origin).toBe(A);
        expect(new URL(got).origin).not.toBe(h.store.get(ANCHOR));
        expect(got).toBe(`${A}${where}`);
        // Kept for A's own file as A listed it: read there, with the phone set to A, the path is A's.
        expect(keptForA().conversations[0][field]).toBe(where);
    });

    it('a whole address, or none, comes back as it was listed', async () => {
        const whole = `${A}/uploads/listing-photo.jpg`;
        const read = await withListing((r) => { for (const c of r.conversations) { c.peerAvatar = whole; c.postPhoto = null; } }, () => db.requestsInPlace(me.publicKey, A));
        expect(read!.conversations[0].peerAvatar).toBe(whole);
        expect(read!.conversations[0].postPhoto).toBeNull();
    });

    it('swept: with every address field a path, no value anywhere in what comes back is a path the community in use could be asked for', async () => {
        const read = await withListing((r) => {
            for (const c of r.conversations) for (const f of LISTED_ADDRESS_FIELDS) c[f] = `/uploads/${f}.jpg?k=secret`;
        }, () => db.requestsInPlace(me.publicKey, A));
        const paths: string[] = [];
        const walk = (v: unknown, at: string) => {
            if (typeof v === 'string' && v.startsWith('/')) paths.push(`${at}=${v}`);
            else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
        };
        walk(read, 'read');
        expect(paths).toEqual([]);
    });

    it('guard: every field of the engine\'s conversation listing named like an address is made whole in place (LISTED_ADDRESS_FIELDS)', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../../../packages/beanpool-engine/src/messaging.ts'), 'utf8');
        const block = source.slice(source.indexOf('export interface Conversation {'));
        const body = block.slice(0, block.indexOf('\n}'));
        const fields = [...body.matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1]);
        expect(fields.length, 'the interface was read').toBeGreaterThan(10);
        const addressLike = fields.filter((f) => /(avatar|photo|photos|url|picture|image|thumb|link)$/i.test(f));
        expect(addressLike.length).toBeGreaterThanOrEqual(3);
        for (const f of addressLike) expect(LISTED_ADDRESS_FIELDS, f).toContain(f);
    });
});

/**
 * #3309 review N2 (probes P3 and P5), the class closed: every read of the member's own list whose answer is written, kept or
 * handed back after its network await goes through one guard (db.ts ownListRead): requestsInPlace, syncMessages and
 * fetchGroups (found by grep: the reads of the member's conversations list, and the groups list that names the member's
 * role). Each x what can change while its answer is out: Sign Out with the next account set to the community read, the
 * account switched, a switch to another community. Nothing is written into any copy, nothing kept under any key, nothing
 * handed back. A control row (nothing meanwhile) shows each read writes when nothing changes, so the others prove something.
 */
describe('the member\'s own list reads, with the account or the community changing while the answer is out (#3309 review N2, P3, P5)', () => {
    const GROUP = {
        id: 'garden-group', name: 'Garden', slug: 'garden', description: null, avatarUrl: null, category: 'general', createdBy: 'founder',
        joinPolicy: 'open', createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', viewerRole: 'admin', viewerStatus: 'active',
    };
    const listRead = (m: string, p: string) => m === 'GET' && p.startsWith('/api/messages/conversations/');
    interface OwnRead { name: string; read: string; held: (m: string, p: string) => boolean; act: () => Promise<any>; dropped: (r: any) => boolean; landed: (r: any) => boolean }
    const READS: OwnRead[] = [
        {
            name: 'requestsInPlace (A, read in place)', read: A, held: listRead,
            act: () => db.requestsInPlace(me.publicKey, A),
            dropped: (r) => r === null,
            landed: (r) => r?.conversations?.[0]?.id === req.id && (rowsOf(A_FILE)!.conversations as any[]).some((c) => c.id === req.id)
                && JSON.parse(h.store.get(messageRequestsStoreKey(me.publicKey, A_FILE)) ?? 'null')?.conversations?.[0]?.id === req.id,
        },
        {
            name: 'syncMessages (B, the community in use)', read: B, held: listRead,
            act: () => db.syncMessages(me.publicKey),
            dropped: (r) => r === false,
            landed: (r) => r === true && JSON.parse(h.store.get(messageRequestsStoreKey(me.publicKey, B_FILE)) ?? 'null')?.conversations?.[0]?.id === req.id,
        },
        {
            name: 'fetchGroups (B, the community in use)', read: B, held: (m, p) => m === 'GET' && p === '/api/groups',
            act: () => db.fetchGroups(),
            dropped: (r) => Array.isArray(r) && !r.some((g: any) => g.id === GROUP.id),
            landed: (r) => r.some((g: any) => g.id === GROUP.id)
                && (rowsOf(B_FILE)!.group_members as any[]).some((m) => m.group_id === GROUP.id && m.member_pubkey === me.publicKey && m.role === 'admin'),
        },
    ];
    /** Another account on the phone from here. */
    const nextAccount = () => { const next = person(); h.me = { publicKey: next.publicKey, privateKey: next.privateKey }; };
    const MID: Record<string, ((read: string) => Promise<void>) | null> = {
        'nothing (control)': null,
        // As Sign Out leaves the phone (P3): the copies cleared and removed, the kept lists wiped (identity.ts), then the next
        // account set to the very community the read was asked of.
        'Sign Out, and the next account set to the community read': async (where) => {
            await db.clearDB({ identityLeaves: true });
            await removeCommunityCaches([A, B], { everyCopy: true });
            for (const k of [...h.store.keys()]) if (k.startsWith(MESSAGE_REQUESTS_STORE_PREFIX)) h.store.delete(k);
            nextAccount();
            await switchPhoneTo(where);
        },
        'the account switched (another account on the phone, no copy cleared)': async () => { nextAccount(); },
        // A new copy is made at this build's schema (a new copy generation); one already on the phone is only opened.
        'a switch to another community (its copy new)': async () => { await switchPhoneTo(C); },
        'a switch to another community (its copy on the phone already)': async () => {
            fs.copyFileSync(fileOn(B_FILE), fileOn(C_FILE));
            await switchPhoneTo(C);
        },
        // The same account, the community's copy made anew: the answer was for the copy that went.
        'the community read taken off the phone and set to again (its copy made anew)': async (where) => {
            await removeCommunityCaches([where]);
            await switchPhoneTo(where);
        },
    };

    afterEach(async () => { await db.leaveChatInPlace(A); });

    const cases = READS.flatMap((r) => Object.keys(MID).map((w) => [r.name, w, r] as const));
    it.each(cases)('%s, with %s while it is out', async (_name, whatName, row) => {
        node.groups = [GROUP];
        const asking = me.publicKey;
        asked = [];
        hold = holdFor(row.held);
        let result: unknown;
        let thrown: unknown = null;
        const running = row.act().then((r) => { result = r; }, (e) => { thrown = e; });
        await hold.seen;
        const what = MID[whatName];
        if (what) await what(row.read);
        await settle();
        const before = { A: rowsOf(A_FILE), B: rowsOf(B_FILE), C: rowsOf(C_FILE), stored: Object.fromEntries([...h.store.entries()].sort()) };

        hold.release();
        await running;
        await settle();
        hold = null;

        expect(thrown, String((thrown as any)?.message ?? '')).toBeNull();
        if (!what) {
            expect(row.landed(result), 'nothing changed: the read writes, keeps and hands back').toBe(true);
            return;
        }
        expect(row.dropped(result), `nothing handed back: ${JSON.stringify(result)?.slice(0, 200)}`).toBe(true);
        // Nothing written into any copy, the next account's included, and nothing kept under any key.
        expect({ A: rowsOf(A_FILE), B: rowsOf(B_FILE), C: rowsOf(C_FILE), stored: Object.fromEntries([...h.store.entries()].sort()) }).toEqual(before);
        // The next account reads no request of the account that asked, wherever the phone is set (P5).
        if (h.me.publicKey !== asking) expect(await db.getMessageRequests(h.me.publicKey)).toBeNull();
    });

    it('requestsInPlace, with the account switched as the request is written into A\'s copy: nothing kept, nothing handed back', async () => {
        h.beforeRun = (q, p) => { if (q.includes('INSERT INTO conversations') && p[0] === req.id) nextAccount(); };
        const keptBefore = Object.fromEntries([...h.store.entries()].filter(([k]) => k.startsWith(MESSAGE_REQUESTS_STORE_PREFIX)));
        expect(await db.requestsInPlace(me.publicKey, A)).toBeNull();
        expect(h.me.publicKey, 'the account switched mid-write').not.toBe(me.publicKey);
        expect(Object.fromEntries([...h.store.entries()].filter(([k]) => k.startsWith(MESSAGE_REQUESTS_STORE_PREFIX)))).toEqual(keptBefore);
    });
});

/** #3309 review N2 (probe P4): the list read in place ends at its deadline, so a community that never answers is no answer. */
describe('the list read in place ends at its deadline (#3309 review N2, P4)', () => {
    afterEach(async () => {
        db._setRequestsInPlaceDeadlineForTests(null);
        hold?.release();
        hold = null;
        await settle();
        await db.leaveChatInPlace(A);
    });
    const listRead = (m: string, p: string) => m === 'GET' && p.startsWith('/api/messages/conversations/');

    it('a community that never answers: no answer once the deadline passes; nothing written or kept, then or when the answer comes after', async () => {
        db._setRequestsInPlaceDeadlineForTests(40);
        hold = holdFor(listRead);
        const before = { A: rowsOf(A_FILE), stored: storedFor(A_FILE) };
        expect(await db.requestsInPlace(me.publicKey, A)).toBeNull();
        expect({ A: rowsOf(A_FILE), stored: storedFor(A_FILE) }).toEqual(before);
        hold.release();
        await settle();
        expect({ A: rowsOf(A_FILE), stored: storedFor(A_FILE) }).toEqual(before);
    });

    it('an answer whose body never ends: no answer once the deadline passes, nothing written or kept', async () => {
        db._setRequestsInPlaceDeadlineForTests(40);
        const page = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init: any = {}) => {
            if (!new URL(url).pathname.startsWith('/api/messages/conversations/')) return page(url, init);
            return { ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}), text: () => new Promise(() => {}) } as any;
        });
        try {
            const before = { A: rowsOf(A_FILE), stored: storedFor(A_FILE) };
            expect(await db.requestsInPlace(me.publicKey, A)).toBeNull();
            expect({ A: rowsOf(A_FILE), stored: storedFor(A_FILE) }).toEqual(before);
        } finally {
            fetchMock.mockImplementation(page);
        }
    });

    it('control: an answer inside the deadline is read as before', async () => {
        db._setRequestsInPlaceDeadlineForTests(5_000);
        hold = holdFor(listRead);
        const reading = db.requestsInPlace(me.publicKey, A);
        await hold.seen;
        await new Promise((r) => setTimeout(r, 60));
        hold.release();
        expect((await reading)?.conversations.map((c: any) => c.id)).toEqual([req.id]);
    });
});

/**
 * #3309 review N1 (probe P2 as a table): a request in place is judged by every key the person is known by in A's copy (the
 * listing's, A's own participant rows for the chat, its pin), as Talk, the held rows and the chat screen judge a DM. Pinned
 * or unpinned x blocked by each kind of key, or by none. A DM with no pin has no pin's key to be blocked by (its rows named
 * more than one key at the seed, a rule-5 record, past the seed's budget, the member reset their pins): there its own rows
 * are what's left, which is the gap N1 measured.
 */
describe('a blocked person, by every key A\'s copy knows them by, pinned DM or not (#3309 review N1, P2)', () => {
    afterEach(async () => {
        vi.mocked(getBlockedUsers).mockResolvedValue([]);
        await db.leaveChatInPlace(A);
    });
    const peopleOf = (id: string) => (rowsOf(A_FILE)!.conversation_participants as any[]).filter((p) => p.conversation_id === id).map((p) => p.public_key).sort();
    function addRows(id: string, keys: string[], newRow: boolean): void {
        const sql = new DatabaseSync(fileOn(A_FILE));
        if (newRow) sql.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', ?, ?)").run(id, keys[0], tick());
        for (const k of keys) sql.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, k);
        sql.close();
    }

    type By = 'the listing\'s key' | 'the pin\'s key' | 'a key in the copy\'s own rows' | 'nobody of theirs';
    const ROWS: Array<['pinned' | 'unpinned', By, boolean]> = [
        ['pinned', 'the listing\'s key', true], ['pinned', 'the pin\'s key', true], ['pinned', 'a key in the copy\'s own rows', true], ['pinned', 'nobody of theirs', false],
        ['unpinned', 'the listing\'s key', true], ['unpinned', 'a key in the copy\'s own rows', true], ['unpinned', 'nobody of theirs', false],
    ];
    it.each(ROWS)('%s DM, blocked by %s: card hidden %s', async (pinning, by, hidden) => {
        const kNew = person().publicKey;
        const kRow = person().publicKey;
        let chat: string;
        if (pinning === 'pinned') {
            // A's copy pinned its DM with peer at the seed; for the copy-row case a stray key sits in its rows beside the pin's.
            chat = dm.id;
            if (by === 'a key in the copy\'s own rows') addRows(chat, [kRow], false);
        } else {
            // A DM A's copy holds with no pin: written into A's file after its pins were seeded, its rows [kRow, me].
            chat = randomUUID();
            addRows(chat, [kRow, me.publicKey], true);
        }
        const rowsBefore = peopleOf(chat);
        const blockedKey = {
            'the listing\'s key': kNew, 'the pin\'s key': peer.publicKey, 'a key in the copy\'s own rows': kRow, 'nobody of theirs': person().publicKey,
        }[by];
        vi.mocked(getBlockedUsers).mockResolvedValue([blockedKey]);
        // A lists the chat as a request from the person's new key.
        const listing = { id: chat, type: 'dm', name: null, participants: [kNew, me.publicKey], createdBy: kNew, createdAt: '2026-11-20T00:00:00.000Z', request: { from: kNew, state: 'pending', at: tick() } };
        const page = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init: any = {}) => {
            const res: any = await page(url, init);
            if (!new URL(url).pathname.startsWith('/api/messages/conversations/')) return res;
            const body = await res.json();
            body.requests.conversations.push(listing);
            body.requests.count += 1;
            return answer(200, body);
        });
        let read: any;
        try {
            read = await db.requestsInPlace(me.publicKey, A);
        } finally {
            fetchMock.mockImplementation(page);
        }
        const shown = read!.conversations.map((c: any) => c.id);
        expect(shown.includes(chat), 'its card').toBe(!hidden);
        expect(shown).toContain(req.id);
        expect(read!.count).toBe(hidden ? 1 : 2);
        if (hidden || pinning === 'pinned') {
            // Hidden: nothing of theirs written (the new key never beside the blocked one). Pinned: [me, the pin's key] stay.
            expect(peopleOf(chat)).toEqual(rowsBefore);
        } else {
            // Unpinned and shown: the listing's people go beside the rows A held, so this row is the no-pin case it says.
            expect(peopleOf(chat)).toEqual([...rowsBefore, kNew].sort());
        }
    });
});

describe('what the list read in place hands back: only what A\'s copy holds; its pins first (#3309 review N3, N4 R7)', () => {
    afterEach(async () => { await db.leaveChatInPlace(A); });
    const keptForA = () => JSON.parse(h.store.get(messageRequestsStoreKey(me.publicKey, A_FILE)) ?? 'null');

    it('a listed request A\'s copy won\'t write (group keys under its id): no card, not counted, not kept (N3, probe P1)', async () => {
        const sql = new DatabaseSync(fileOn(A_FILE));
        sql.prepare('INSERT INTO group_chat_key_state (group_id, highest) VALUES (?, ?)').run(`${me.publicKey}/${req.id.toLowerCase()}`, 2);
        sql.close();
        const read = await db.requestsInPlace(me.publicKey, A);
        expect(read!.conversations).toEqual([]);
        expect(read!.count).toBe(0);
        expect(keptForA().conversations).toEqual([]);
        expect((rowsOf(A_FILE)!.conversations as any[]).some((c) => c.id === req.id)).toBe(false);
    });

    it('A\'s pins unreadable: nothing written into A\'s copy, nothing kept, no cards (R7)', async () => {
        h.store.set(dmPeerPinsStoreKey(me.publicKey, A_FILE), '{ this is not a pin store');
        db._resetDmPeerPinsForTests();
        const before = { A: rowsOf(A_FILE), kept: h.store.get(messageRequestsStoreKey(me.publicKey, A_FILE)) ?? null };
        expect(await db.requestsInPlace(me.publicKey, A)).toBeNull();
        expect({ A: rowsOf(A_FILE), kept: h.store.get(messageRequestsStoreKey(me.publicKey, A_FILE)) ?? null }).toEqual(before);
    });
});

describe('reportDmLine in place: only a line of that direct chat, as A\'s copy holds it (#3309 review N4 D1, D2)', () => {
    afterEach(async () => { await db.leaveChatInPlace(A); });

    it('a chat A\'s copy holds as a group: refused before anything is asked (D1)', async () => {
        const group = randomUUID();
        const line = randomUUID();
        const sql = new DatabaseSync(fileOn(A_FILE));
        sql.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'group_thread', ?, ?)").run(group, asker.publicKey, tick());
        sql.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, ?, ?, 'a group line', 'plaintext-v1')").run(line, group, asker.publicKey);
        sql.close();
        asked = [];
        await expect(db.reportDmLine(group, line, 'a group line', 'Spam or scam', A)).rejects.toSatisfy((e: unknown) => db.isNoCopyInPlace(e));
        expect(asked).toEqual([]);
    });

    it('a line of another direct chat, named with this request: refused, nothing asked; its own line goes (D2)', async () => {
        await previewThere();
        const another = node.lines.find((l) => l.conversationId === dm.id)!;
        expect((rowsOf(A_FILE)!.messages as any[]).some((m) => m.id === another.id), 'A\'s copy holds the other chat\'s line').toBe(true);
        asked = [];
        await expect(db.reportDmLine(req.id, another.id, 'an old friend', 'Spam or scam', A)).rejects.toThrow('Message not found');
        expect(asked).toEqual([]);
        expect((await db.reportDmLine(req.id, askerLine.id, ASKER_WORDS, 'Spam or scam', A))?.success).toBe(true);
        expect(asked.map((r) => `${r.method} ${new URL(r.url).origin}${new URL(r.url).pathname}`)).toEqual([`POST ${A}/api/messages/report`]);
    });
});
