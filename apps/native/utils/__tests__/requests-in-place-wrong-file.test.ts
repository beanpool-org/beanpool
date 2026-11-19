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
    blocks: [] as unknown[][],
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
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => {}) }));
// The block's own routing is blocks-reach-community.test.ts's: here it records the community the report handed it.
vi.mock('../blocklist', () => ({
    getBlockedUsers: vi.fn(async () => []),
    blockUser: vi.fn(async (...args: unknown[]) => { h.blocks.push(args); return true; }),
    isUserBlocked: vi.fn(async () => true),
}));
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
import { messageRequestsStoreKey } from '../storage-keys';
import { reportRequestAndBlock } from '../request-report';

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
const node = { convs: [] as Conv[], lines: [] as Line[] };
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
    me = person();
    peer = person();
    asker = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    dm = { id: randomUUID(), type: 'dm', participants: [me.publicKey, peer.publicKey] };
    node.convs = [dm];
    node.lines = [];
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
