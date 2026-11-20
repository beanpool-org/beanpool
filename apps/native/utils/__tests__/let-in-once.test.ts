/**
 * Let in once (slice S3b; scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, Marty 19 Nov 2026 "yes to all 5"; the
 * block first: DESIGN-s7-blocks-verified-everywhere-fable.md §2.4, Marty 21 Nov: someone unblocked is not let in quietly).
 *
 * One table (close the class): who the member let in {wrote a line, accepted their request, friend, bought from them, sold to
 * them, paid them, a linked contact} and who they did not {they paid the member, a deal only asked, a chat only they wrote in,
 * nobody} x what else holds {nothing, blocked here, blocked in another held community, blocked and unblocked later, the
 * person re-keyed since, the account switching as the list is read, the copy that lets them in a guest's look (a linked contact is in none)} x where the
 * request waits {in another held community, read in place (requestsInPlace); in the community in use (syncMessages)}. Each
 * row: accepted quietly (one POST /api/messages/request {accept} to the request's own community, and no card) or an ordinary
 * card (no POST, the request still waiting). Accepted exactly when the person was let in and nothing else holds.
 *
 * Then: the quiet POST is byte-equal to a tap's; nothing else is asked of any server; a direct chat lets in only the key it is
 * pinned to (never a former one); once per request; a copy in use lets in as a held one does; 500 chats timed.
 *
 * Real SQLite files on disk (node:sqlite), the real db.ts, the real blocklist (its block, unblock and remembered changes),
 * real held handles. The node is a stand-in that answers as routes/messaging.ts does and keeps no block list (404). The
 * private contacts list is a stand-in for contacts-store's loadContacts (its opening is contacts-store.test.ts's).
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
    secure: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
    /** Called once as the let-in list is read (LET_IN_SQL): a row may change something then. */
    onLetInRead: null as null | (() => void),
    letInReads: 0,
    contacts: [] as Array<{ links: Array<{ key: string }> }>,
    contactsOpened: 0,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) },
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
                getAllAsync: async (q: string, p?: unknown) => {
                    if (q.includes("'dm' AS kind")) {
                        h.letInReads++;
                        const once = h.onLetInRead;
                        h.onLetInRead = null;
                        once?.();
                    }
                    return sql.prepare(q).all(...params(p));
                },
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
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (k: string) => h.secure.get(k) ?? null),
    setItemAsync: vi.fn(async (k: string, v: string) => { h.secure.set(k, v); }),
    deleteItemAsync: vi.fn(async (k: string) => { h.secure.delete(k); }),
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => (h.me.publicKey ? { ...h.me, callsign: 'Me' } : null)) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string, body: string) => ({ 'X-Signed': `${method} ${url} ${body}` })),
}));
vi.mock('../contacts-store', async (orig) => ({
    ...(await orig<any>()),
    loadContacts: vi.fn(async (account: { publicKey: string }) => {
        h.contactsOpened++;
        if (account.publicKey !== h.me.publicKey) return { onPhone: { kind: 'none' }, state: {} };
        return { onPhone: h.contacts.length ? { kind: 'list', list: { v: 1, contacts: h.contacts, removed: [] }, seq: 1, copy: {} } : { kind: 'none' }, state: {} };
    }),
}));

import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { getDatabaseFilenameForNode, markGuestNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { messageRequestsStoreKey, dmPeerPinsStoreKey } from '../storage-keys';
import { announceAccountOnPhone } from '../account-on-phone';
import { blockUser, unblockUser, blockSyncsEndedForTests } from '../blocklist';
import { acceptLetIn, _resetLetInForTests } from '../let-in';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-let-in-once-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** A: another community held, where a request waits read in place. B: the community in use. C: a third held community. */
const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const C = 'https://brookside.example';
const FILE: Record<string, string> = { [A]: getDatabaseFilenameForNode(A), [B]: getDatabaseFilenameForNode(B), [C]: getDatabaseFilenameForNode(C) };
const ANCHOR = 'beanpool_anchor_url';

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── The node ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Conv { id: string; type: string; participants: string[]; request?: { from: string; state: string; at: string } }
const node = { convs: [] as Conv[] };
interface Asked { method: string; url: string; body: string | undefined; headers: Record<string, string> }
let asked: Asked[] = [];

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), clone() { return this; } };
}
const view = (c: Conv) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-11-21T00:00:00.000Z', ...(c.request ? { request: c.request } : {}) });
const waitingFor = (c: Conv, me: string) => c.request?.state === 'pending' && c.request.from !== me;

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    asked.push({ method, url, body: init.body, headers: { ...(init.headers || {}) } });
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'POST' && u.pathname === '/api/messages/request') {
        const conv = node.convs.find((c) => c.id === body.conversationId);
        if (!conv?.request || conv.request.state !== 'pending') return answer(404, { error: 'There is no message request for you in this chat.', code: 'request_not_found' });
        conv.request = { ...conv.request, state: body.decision === 'accept' ? 'accepted' : 'ignored' };
        return answer(200, { success: true, request: conv.request });
    }
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
        return answer(200, { conversation: view(conv), messages: [] });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    if (u.pathname === '/api/reports') return answer(200, { success: true });
    // No block list here: the phone's own block stands (blocklist.ts), the node is asked again tomorrow.
    return answer(404, { error: 'not here' });
});

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

let me: Person;
let them: Person;
let phoneN = 0;
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };
const iso = () => new Date().toISOString();

/** A phone that holds A, C and B, set to B, each copy made by its own sync. Nothing waits anywhere yet. */
async function phoneHoldingThree(): Promise<void> {
    await settle();
    await db.closeDB();
    db._resetDmPeerPinsForTests();
    db._resetChatsInPlaceForTests();
    _resetLetInForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.secure.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    h.onLetInRead = null;
    h.letInReads = 0;
    h.contacts = [];
    h.contactsOpened = 0;
    me = person();
    them = person();
    h.me = { ...me };
    announceAccountOnPhone(me.publicKey);
    node.convs = [];
    (globalThis as any).fetch = fetchMock;
    h.store.set(ANCHOR, A);
    expect(await db.syncMessages(me.publicKey)).toBe(true);
    for (const url of [C, B]) {
        await switchPhoneTo(url);
        expect(await db.syncMessages(me.publicKey)).toBe(true);
    }
    await switchPhoneTo(A);
    await switchPhoneTo(B);
    await settle();
    expect(h.store.get(ANCHOR)).toBe(B);
    asked = [];
}

/** Writes into `community`'s copy as its own sync would have (that copy is held: no handle of the phone's writes it). */
function intoCopy(community: string, write: (sql: DatabaseSync) => void): void {
    const sql = new DatabaseSync(path.join(h.dir, FILE[community]));
    try { write(sql); } finally { sql.close(); }
}
function dmIn(sql: DatabaseSync, other: string, request: object | null, author: string | null): string {
    const id = randomUUID();
    sql.prepare('INSERT INTO conversations (id, type, created_by, request, listed) VALUES (?, \'dm\', ?, ?, 1)').run(id, author ?? other, request ? JSON.stringify(request) : null);
    for (const k of [me.publicKey, other]) sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, k);
    if (author) sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, \'x\', \'n\', \'text\', ?)').run(randomUUID(), id, author, iso());
    return id;
}

/** Who the member let in, or not: written into `community`'s copy for the person known there by `key`. */
interface Source { name: string; letsIn: boolean; put: (community: string, key: string) => void; notInACopy?: true }
const SOURCES: Source[] = [
    { name: 'wrote a line', letsIn: true, put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, null, me.publicKey); }) },
    { name: 'accepted their request', letsIn: true, put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, { from: k, state: 'accepted', at: iso() }, k); }) },
    { name: 'friend', letsIn: true, put: (c, k) => intoCopy(c, (s) => { s.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(me.publicKey, k); }) },
    { name: 'bought from them', letsIn: true, put: (c, k) => intoCopy(c, (s) => { s.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status) VALUES (?, ?, ?, ?, \'completed\')').run(randomUUID(), randomUUID(), me.publicKey, k); }) },
    { name: 'sold to them', letsIn: true, put: (c, k) => intoCopy(c, (s) => { s.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status) VALUES (?, ?, ?, ?, \'pending\')').run(randomUUID(), randomUUID(), k, me.publicKey); }) },
    { name: 'paid them', letsIn: true, put: (c, k) => intoCopy(c, (s) => { s.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c) VALUES (?, ?, ?, 100)').run(randomUUID(), me.publicKey, k); }) },
    // The account's own list on the phone, in no community's copy: a guest's look takes nothing from it.
    { name: 'a linked contact', letsIn: true, put: (_c, k) => { h.contacts = [{ links: [{ key: k }] }]; }, notInACopy: true },
    { name: 'they paid the member', letsIn: false, put: (c, k) => intoCopy(c, (s) => { s.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c) VALUES (?, ?, ?, 1)').run(randomUUID(), k, me.publicKey); }) },
    { name: 'a deal they only asked for', letsIn: false, put: (c, k) => intoCopy(c, (s) => { s.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status) VALUES (?, ?, ?, ?, \'requested\')').run(randomUUID(), randomUUID(), k, me.publicKey); }) },
    { name: 'a chat only they wrote in', letsIn: false, put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, null, k); }) },
    { name: 'nobody', letsIn: false, put: () => {} },
];

/** What else holds: done before the request is read. `letInUnder`: the key the person was let in by (theirs now, unless re-keyed). */
interface Column { name: string; quiet: boolean | ((s: Source) => boolean); before: (ctx: { source: string }) => Promise<void>; letInUnder?: () => string }
let rekeyed: Person;
const COLUMNS: Column[] = [
    { name: 'nothing', quiet: true, before: async () => {} },
    { name: 'blocked here', quiet: false, before: async () => { await blockUser(them.publicKey); await blockSyncsEndedForTests(); } },
    {
        name: 'blocked in another held community', quiet: false,
        before: async () => { await switchPhoneTo(C); await blockUser(them.publicKey); await blockSyncsEndedForTests(); await switchPhoneTo(B); },
    },
    {
        name: 'blocked, then unblocked later', quiet: false,
        before: async () => { await blockUser(them.publicKey); await blockSyncsEndedForTests(); await unblockUser(them.publicKey); await blockSyncsEndedForTests(); },
    },
    // Let in under the key they had; the request comes from their new one.
    { name: 'the person re-keyed since', quiet: false, before: async () => {}, letInUnder: () => rekeyed.publicKey },
    {
        name: 'the account switches as the let-in list is read', quiet: false,
        before: async () => {
            const other = person();
            h.onLetInRead = () => { h.me = { ...other }; announceAccountOnPhone(other.publicKey); };
        },
    },
    { name: 'the copy that lets them in is a guest\'s look', quiet: (s) => !!s.notInACopy, before: async ({ source }) => { await markGuestNode(source); } },
];

/** Where the request waits, and where the let-in is found. */
interface Place { name: string; at: string; source: string; read: () => Promise<unknown> }
const PLACES: Place[] = [
    { name: 'in A, read in place; let in in C', at: A, source: C, read: () => db.requestsInPlace(me.publicKey, A) },
    { name: 'in B, the community in use; let in in A', at: B, source: A, read: () => db.syncMessages(me.publicKey) },
];

const acceptsTo = (origin: string) => asked.filter((a) => a.method === 'POST' && new URL(a.url).pathname === '/api/messages/request').map((a) => ({ origin: new URL(a.url).origin, body: a.body && JSON.parse(a.body) }));
const keptRequestIds = (community: string) => {
    const raw = h.store.get(messageRequestsStoreKey(me.publicKey, FILE[community]));
    return raw ? (JSON.parse(raw).conversations as any[]).map((c) => c.id) : [];
};

describe('let in once: one table, who x what else holds x where the request waits', () => {
    for (const place of PLACES) {
        for (const source of SOURCES) {
            for (const column of COLUMNS) {
                const quiet = source.letsIn && (typeof column.quiet === 'function' ? column.quiet(source) : column.quiet);
                it(`${place.name} | ${source.name} | ${column.name} -> ${quiet ? 'accepted quietly' : 'a card'}`, async () => {
                    await phoneHoldingThree();
                    rekeyed = person();
                    source.put(place.source, column.letInUnder?.() ?? them.publicKey);
                    await column.before({ source: place.source });
                    const from = them.publicKey;
                    const req: Conv = { id: randomUUID(), type: 'dm', participants: [from, me.publicKey], request: { from, state: 'pending', at: iso() } };
                    node.convs.push(req);
                    asked = [];
                    const result: any = await place.read();
                    await settle();
                    const accepts = acceptsTo(place.at);
                    if (quiet) {
                        expect(accepts).toEqual([{ origin: place.at, body: { conversationId: req.id, decision: 'accept' } }]);
                        expect(req.request?.state).toBe('accepted');
                        expect(keptRequestIds(place.at)).not.toContain(req.id);
                        if (place.at === A) expect(result?.conversations?.map((c: any) => c.id) ?? []).not.toContain(req.id);
                    } else {
                        expect(accepts).toEqual([]);
                        expect(req.request?.state).toBe('pending');
                    }
                    // Nothing new asked of any server: lists, pages, the one accept, and the block list the phone already syncs.
                    for (const a of asked) {
                        const p = new URL(a.url).pathname;
                        expect(/^\/api\/messages\/(conversations\/[0-9a-f]+|request|[0-9a-f-]+)$|^\/api\/(members|blocks|reports)$/.test(p), `${a.method} ${p}`).toBe(true);
                    }
                });
            }
        }
    }
});

describe('let in once: the rest of the rule', () => {
    beforeEach(async () => { await phoneHoldingThree(); });

    it('the quiet POST is byte-equal to a tap on Accept: the same path, body, signature and headers', async () => {
        SOURCES[0].put(C, them.publicKey);
        const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
        node.convs.push(req);
        await db.requestsInPlace(me.publicKey, A);
        const quiet = asked.filter((a) => a.method === 'POST');
        expect(quiet).toHaveLength(1);
        // The same request, tapped: the card's Accept in place (MessageRequestsPane: decideMessageRequest(id, 'accept', community)).
        req.request = { ...req.request!, state: 'pending' };
        asked = [];
        await db.decideMessageRequest(req.id, 'accept', A);
        const tap = asked.filter((a) => a.method === 'POST');
        expect(tap).toHaveLength(1);
        expect(quiet[0].url).toBe(tap[0].url);
        expect(quiet[0].body).toBe(tap[0].body);
        expect(quiet[0].headers).toEqual(tap[0].headers);
    });

    it('a direct chat lets in only the key it is pinned to: the pinned key yes, the key pinned before it no', async () => {
        const former = person();
        let id = '';
        // The rows still name the old key; the pin moved to the new one (DESIGN-dm-key-signal-model: notice and carry on).
        intoCopy(C, (s) => { id = dmIn(s, former.publicKey, null, me.publicKey); });
        h.store.set(dmPeerPinsStoreKey(me.publicKey, FILE[C]), JSON.stringify({ pins: { [id]: { peer: them.publicKey, since: iso(), by: 'listing', former: [former.publicKey] } } }));
        db._resetDmPeerPinsForTests();
        const fromNew: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
        const fromOld: Conv = { id: randomUUID(), type: 'dm', participants: [former.publicKey, me.publicKey], request: { from: former.publicKey, state: 'pending', at: iso() } };
        node.convs.push(fromNew, fromOld);
        const got = await db.requestsInPlace(me.publicKey, A);
        expect(acceptsTo(A).map((a) => a.body.conversationId)).toEqual([fromNew.id]);
        expect(got?.conversations.map((c: any) => c.id)).toEqual([fromOld.id]);
        expect(got?.count).toBe(1);
    });

    it('unblocked later under another key the request\'s chat names them by in that copy (their key before a re-key): a card', async () => {
        const old = person();
        SOURCES[2].put(C, them.publicKey);
        await blockUser(old.publicKey);
        await blockSyncsEndedForTests();
        await unblockUser(old.publicKey);
        await blockSyncsEndedForTests();
        const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
        // A's copy names their old key in that chat too (its own participant rows, from before the re-key).
        intoCopy(A, (s) => {
            s.prepare('INSERT INTO conversations (id, type, created_by) VALUES (?, \'dm\', ?)').run(req.id, old.publicKey);
            for (const k of [me.publicKey, old.publicKey]) s.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(req.id, k);
        });
        node.convs.push(req);
        const got = await db.requestsInPlace(me.publicKey, A);
        expect(acceptsTo(A)).toEqual([]);
        expect(got?.conversations.map((c: any) => c.id)).toEqual([req.id]);
    });

    it('a let-in found in the copy in use lets in a request read in place', async () => {
        SOURCES[2].put(B, them.publicKey);
        const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
        node.convs.push(req);
        expect((await db.requestsInPlace(me.publicKey, A))?.conversations).toEqual([]);
        expect(acceptsTo(A)).toHaveLength(1);
    });

    it('the community in use a guest\'s look: nothing accepted there, however the person was let in', async () => {
        SOURCES[0].put(A, them.publicKey);
        await markGuestNode(B);
        node.convs.push({ id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } });
        await db.syncMessages(me.publicKey);
        await settle();
        expect(acceptsTo(B)).toEqual([]);
    });

    it('accepted here: the list kept loses it, and one more pass brings the chat into the copy in use', async () => {
        SOURCES[0].put(A, them.publicKey);
        const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
        node.convs.push(req);
        expect(await db.syncMessages(me.publicKey)).toBe(true);
        await settle();
        expect(keptRequestIds(B)).toEqual([]);
        const rows = new DatabaseSync(path.join(h.dir, FILE[B]));
        try {
            const row = rows.prepare('SELECT request FROM conversations WHERE id = ?').get(req.id) as { request: string } | undefined;
            expect(row && JSON.parse(row.request).state).toBe('accepted');
        } finally { rows.close(); }
        // The pass after asked nothing more of anyone.
        expect(acceptsTo(B)).toHaveLength(1);
    });

    it('once per request: a later list that still names it waiting presses nothing again', async () => {
        const accept = vi.fn(async () => ({ success: true }));
        SOURCES[2].put(C, them.publicKey);
        const c = { id: randomUUID(), from: them.publicKey, keys: [them.publicKey] };
        expect([...await acceptLetIn(me.publicKey, [c], accept, async () => true)]).toEqual([c.id]);
        expect([...await acceptLetIn(me.publicKey, [c], accept, async () => true)]).toEqual([]);
        expect(accept).toHaveBeenCalledTimes(1);
    });

    it('a request refused at the node (already decided elsewhere) is not counted, and is tried again next time', async () => {
        const accept = vi.fn().mockRejectedValueOnce(Object.assign(new Error('There is no message request for you in this chat.'), { code: 'request_not_found' })).mockResolvedValueOnce({ success: true });
        SOURCES[2].put(C, them.publicKey);
        const c = { id: randomUUID(), from: them.publicKey, keys: [them.publicKey] };
        expect([...await acceptLetIn(me.publicKey, [c], accept, async () => true)]).toEqual([]);
        expect([...await acceptLetIn(me.publicKey, [c], accept, async () => true)]).toEqual([c.id]);
    });

    it('nothing is read when no request waits, and the contacts list opens only for someone no copy lets in', async () => {
        expect([...await acceptLetIn(me.publicKey, [], async () => ({}), async () => true)]).toEqual([]);
        expect(h.letInReads).toBe(0);
        SOURCES[2].put(C, them.publicKey);
        await acceptLetIn(me.publicKey, [{ id: randomUUID(), from: them.publicKey, keys: [them.publicKey] }], async () => ({}), async () => true);
        expect(h.contactsOpened).toBe(0);
        const stranger = person();
        await acceptLetIn(me.publicKey, [{ id: randomUUID(), from: stranger.publicKey, keys: [stranger.publicKey] }], async () => ({}), async () => true);
        expect(h.contactsOpened).toBe(1);
    });

    it('a let-in read leaves no held handle open (Chat not in view)', async () => {
        SOURCES[2].put(C, them.publicKey);
        await acceptLetIn(me.publicKey, [{ id: randomUUID(), from: them.publicKey, keys: [them.publicKey] }], async () => ({}), async () => true);
        expect(db.heldCopyFiles()).toEqual([]);
    });

    it('500 chats in each of two held copies and the copy in use: the let-in read, timed', async () => {
        const fill = (s: DatabaseSync) => {
            s.exec('BEGIN');
            for (let i = 0; i < 500; i++) {
                const other = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
                const id = randomUUID();
                s.prepare('INSERT INTO conversations (id, type, created_by, listed) VALUES (?, \'dm\', ?, 1)').run(id, other);
                for (const k of [me.publicKey, other]) s.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, k);
                for (let j = 0; j < 20; j++) s.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp) VALUES (?, ?, ?, \'x\', \'n\', ?)').run(randomUUID(), id, j === 19 && i % 2 === 0 ? me.publicKey : other, new Date(Date.now() - j * 1000).toISOString());
                if (i % 5 === 0) s.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(me.publicKey, other);
                if (i % 3 === 0) s.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c) VALUES (?, ?, ?, 1)').run(randomUUID(), me.publicKey, other);
            }
            s.exec('COMMIT');
        };
        for (const c of [A, C, B]) intoCopy(c, fill);
        const t0 = performance.now();
        const held = await db.getHeldLetIn(me.publicKey, C);
        const t1 = performance.now();
        const here = await db.getLetInHere(me.publicKey);
        const t2 = performance.now();
        const stranger = person();
        await acceptLetIn(me.publicKey, [{ id: randomUUID(), from: stranger.publicKey, keys: [stranger.publicKey] }], async () => ({}), async () => true);
        const t3 = performance.now();
        console.log(`[let-in timing] one held copy of 500 chats: ${(t1 - t0).toFixed(1)} ms; the copy in use: ${(t2 - t1).toFixed(1)} ms; a whole check over three copies: ${(t3 - t2).toFixed(1)} ms`);
        // 250 chats with a line of mine, 100 friends (all among them), 167 paid.
        expect(held?.letIn.length).toBeGreaterThanOrEqual(250);
        expect(here?.letIn.length).toBeGreaterThanOrEqual(250);
        // Measured and logged for the PR, never held to a fixed bound here (a shared Mac's load would make it flaky).
    });
});
