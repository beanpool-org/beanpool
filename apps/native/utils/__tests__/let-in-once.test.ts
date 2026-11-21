/**
 * Let in once (slice S3b; scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, Marty 19 Nov 2026 "yes to all 5"; the
 * block first: DESIGN-s7-blocks-verified-everywhere-fable.md §2.4, Marty 21 Nov: someone unblocked is not let in quietly).
 *
 * One table (close the class): who the member let in {wrote a line, accepted their request themselves, friend, bought from
 * them, sold to them on their own Need, paid them, a linked contact} and who they did not {they paid the member, a deal only
 * asked, a chat only they wrote in, nobody} x what else holds {nothing, blocked here, blocked in another held community, blocked and unblocked later, the
 * person re-keyed since, the account switching as the list is read, the copy that lets them in a guest's look (a linked contact is in none)} x where the
 * request waits {in another held community, read in place (requestsInPlace); in the community in use (syncMessages)}. Each
 * row: accepted quietly (one POST /api/messages/request {accept} to the request's own community, and no card) or an ordinary
 * card (no POST, the request still waiting). Accepted exactly when the person was let in and nothing else holds.
 *
 * More tables close the classes the deciding reviews found (#3319 at 2dd93abe and at 3b80f0ee):
 * - Who made the row (3b80f0ee F1: only a step the member took lets anyone in) {the member, the other person alone, the node
 *   on its own (a trade's acceptance, a sync)} x every source {a line in a direct chat, a request's acceptance, a friend, a
 *   deal the member bought in, a deal the member sold in, a payment, a linked contact} x where the request waits, and across:
 *   let in only for the member's own row. Then the review's own case: Ann Ignores Sid, Sid takes up her Offer and cancels.
 * - Which key asks (F1) {their key now, the old key of a re-keyed person, a key a listing names as a former one, the key on
 *   offer, the pinned key a chat waits over} x every source above x where the request waits: only the person's key now is let
 *   in, whatever source names it; what a chat's pin in a third community says is enough.
 * - What the member does between the list read and the accept (F2, F3) {nothing, Ignore answered, Ignore answered while the
 *   list's answer was on its way, Decline still on its way, Decline all, Decline all still on its way, Block, a switch to a
 *   third community, another account; and, inside the accept's own awaits before its POST (3b80f0ee F2, F3), an Ignore tapped
 *   and a switch to a third community} x where the request waits: their own answer stands, a Block holds, and an accept goes
 *   only to the community the list came from.
 * - What "Add people I've chatted with and my friends" counts (1697ff89, R2-F1): exactly the chats the let-in reads as the
 *   member's own (a line they wrote, a request they accepted), never a take-up of their Offer or a chat only the other wrote
 *   in; after the tap, nobody it didn't count is let in.
 *
 * Then: the quiet POST is byte-equal to a tap's; nothing else is asked of any server; a direct chat lets in only the key it is
 * pinned to (never a former one); once per request; a copy in use lets in as a held one does; unreadable pins let nobody in;
 * across, the old key isn't let in; an Ignored request isn't pressed later in the run; 500 chats timed.
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
    /** Run once as the contacts list is read, after every copy was (the last read before a quiet accept), its answer made first. */
    afterContacts: null as null | (() => Promise<void>),
    /** Run once while one community's list answer is on its way: made by the node, not yet read by the phone. */
    duringList: null as null | { origin: string; act: () => Promise<void> },
    /** An Ignore held at the node until this settles: the member's answer still on its way. */
    holdIgnore: null as null | Promise<void>,
    /** Run once at the next read of the community address; that read still answers what it read before (it landed after). */
    atAddressRead: null as null | (() => Promise<void>),
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
        getItem: vi.fn(async (k: string) => {
            const was = h.store.get(k) ?? null;
            const once = k === 'beanpool_anchor_url' ? h.atAddressRead : null;
            if (once) {
                h.atAddressRead = null;
                await once();
            }
            return was;
        }),
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
        const read = account.publicKey !== h.me.publicKey
            ? { onPhone: { kind: 'none' }, state: {} }
            : { onPhone: h.contacts.length ? { kind: 'list', list: { v: 1, contacts: h.contacts, removed: [] }, seq: 1, copy: {} } : { kind: 'none' }, state: {} };
        const after = h.afterContacts;
        h.afterContacts = null;
        if (after) await after();
        return read;
    }),
}));

import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { getDatabaseFilenameForNode, markGuestNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { messageRequestsStoreKey, dmPeerPinsStoreKey } from '../storage-keys';
import { announceAccountOnPhone } from '../account-on-phone';
import { blockUser, unblockUser, blockSyncsEndedForTests } from '../blocklist';
import { acceptLetIn, letInFor, _resetLetInForTests } from '../let-in';
import { withPeopleAdded } from '../contacts-former';
import { gateOutsideItem, emptyContactsList, DM_FROM_ADMINS_KEY, DM_NONCE_PREFIX } from '@beanpool/core';

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

/** `at`: the community whose node holds it, for Decline all (left out: every one, as the lists here are). */
interface Conv { id: string; type: string; participants: string[]; request?: { from: string; state: string; at: string; acceptedByYou?: true }; at?: string }
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
        if (body.decision === 'ignore' && h.holdIgnore) await h.holdIgnore;
        const conv = node.convs.find((c) => c.id === body.conversationId);
        if (!conv?.request) return answer(404, { error: 'There is no message request for you in this chat.', code: 'request_not_found' });
        // As engine/dm-requests.ts decideRequest: an accept takes any request not accepted yet, one ignored included (and
        // rings its opener), and the member reads it accepted by their own act; one accepted already stays as it is; an ignore
        // of one accepted is refused.
        if (body.decision === 'accept') {
            if (conv.request.state !== 'accepted') conv.request = { ...conv.request, state: 'accepted', acceptedByYou: true };
        }
        else if (conv.request.state === 'accepted') return answer(409, { error: 'You have accepted this chat already, so it is no longer a request.', code: 'request_accepted' });
        else conv.request = { ...conv.request, state: 'ignored' };
        return answer(200, { success: true, request: conv.request });
    }
    if (method === 'POST' && u.pathname === '/api/messages/request/ignore-all') {
        if (h.holdIgnore) await h.holdIgnore;
        const waiting = node.convs.filter((c) => c.request?.state === 'pending' && (c.at ?? u.origin) === u.origin);
        for (const c of waiting) c.request = { ...c.request!, state: 'ignored' };
        return answer(200, { success: true, ignored: waiting.length });
    }
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        const mine = node.convs.filter((c) => c.participants.includes(list[1]));
        const requests = mine.filter((c) => waitingFor(c, list[1]));
        const listed = answer(200, { conversations: mine.filter((c) => !requests.includes(c)).map(view), totalUnread: 0, deletedAccounts: [], requests: { count: requests.length, conversations: requests.map(view) } });
        const during = h.duringList;
        if (during?.origin === u.origin) {
            h.duringList = null;
            await during.act();
        }
        return listed;
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
    h.afterContacts = null;
    h.duringList = null;
    h.holdIgnore = null;
    h.atAddressRead = null;
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

/**
 * A member's line's nonce as the node stores it: every line a member writes in a direct chat is sealed (format 4), and the
 * node refuses any other (engine/messaging.ts refuseUnencryptedDm). Only the node writes another kind in their name.
 */
const SEALED = `${DM_NONCE_PREFIX}bm9uY2Vub25jZW5vbmNlbm9uY2Vub25jZQ==`;
/** Writes into `community`'s copy as its own sync would have (that copy is held: no handle of the phone's writes it). */
function intoCopy(community: string, write: (sql: DatabaseSync) => void): void {
    const sql = new DatabaseSync(path.join(h.dir, FILE[community]));
    try { write(sql); } finally { sql.close(); }
}
function dmIn(sql: DatabaseSync, other: string, request: object | null, author: string | null): string {
    const id = randomUUID();
    sql.prepare('INSERT INTO conversations (id, type, created_by, request, listed) VALUES (?, \'dm\', ?, ?, 1)').run(id, author ?? other, request ? JSON.stringify(request) : null);
    for (const k of [me.publicKey, other]) sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, k);
    if (author) sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, \'x\', ?, \'text\', ?)').run(randomUUID(), id, author, SEALED, iso());
    return id;
}

/** A listing in a copy, as its sync keeps it: `author`'s Offer or Need. */
function listingIn(sql: DatabaseSync, author: string, type: 'offer' | 'need'): string {
    const id = randomUUID();
    sql.prepare('INSERT INTO posts (id, type, category, title, description, author_pubkey) VALUES (?, ?, \'general\', \'Eggs\', \'A dozen\', ?)').run(id, type, author);
    return id;
}
/** A deal in a copy, as its sync writes one, on `post` (a listing that copy may not hold). */
function dealIn(sql: DatabaseSync, d: { buyer: string; seller: string; status: string; post?: string }): void {
    sql.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), d.post ?? randomUUID(), d.buyer, d.seller, d.status);
}

/** Who the member let in, or not: written into `community`'s copy for the person known there by `key`. */
interface Source { name: string; letsIn: boolean; put: (community: string, key: string) => void; notInACopy?: true }
const SOURCES: Source[] = [
    { name: 'wrote a line', letsIn: true, put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, null, me.publicKey); }) },
    // Accepted by the member's own act: the node says so (engine/dm-requests.ts RequestView acceptedByYou).
    { name: 'accepted their request themselves', letsIn: true, put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, { from: k, state: 'accepted', at: iso(), acceptedByYou: true }, k); }) },
    { name: 'friend', letsIn: true, put: (c, k) => intoCopy(c, (s) => { s.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(me.publicKey, k); }) },
    { name: 'bought from them', letsIn: true, put: (c, k) => intoCopy(c, (s) => { s.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status) VALUES (?, ?, ?, ?, \'completed\')').run(randomUUID(), randomUUID(), me.publicKey, k); }) },
    // The member offered on their Need, and they approved it (#3319 review F1: a deal on the member's own Offer is no step of theirs).
    { name: 'sold to them on their own Need', letsIn: true, put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: k, seller: me.publicKey, status: 'pending', post: listingIn(s, k, 'need') }); }) },
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

/**
 * Which key asks (#3319 review F1): a let-in names only a key, and a friend, deal, payment or contact row keeps whatever key it
 * was made with. What a chat's pin in a third community (neither the request's nor the let-in's) says about that key decides:
 * the person's key now is let in; a key a re-key replaced, a key a listing names as a former one, a key on offer and the pinned
 * key a verified chat waits over are not, from any source.
 */
interface KeyAsking { name: string; quiet: boolean; pin: (key: string) => object }
const KEYS_ASKING: KeyAsking[] = [
    { name: 'their key now', quiet: true, pin: (k) => ({ peer: k, since: iso(), by: 'listing', former: [person().publicKey] }) },
    { name: 'the old key of a re-keyed person', quiet: false, pin: (k) => ({ peer: person().publicKey, since: iso(), by: 'listing', former: [k] }) },
    { name: 'a key a listing names as a former one', quiet: false, pin: (k) => ({ peer: person().publicKey, since: iso(), by: 'first-seen', heard: { tryKeys: [k] } }) },
    { name: 'the key on offer', quiet: false, pin: (k) => ({ peer: person().publicKey, since: iso(), by: 'member', offered: { peer: k, at: iso() } }) },
    { name: 'the pinned key a chat waits over (another on offer)', quiet: false, pin: (k) => ({ peer: k, since: iso(), by: 'member', offered: { peer: person().publicKey, at: iso() } }) },
];

/** Keeps `pin` for a chat in `community`'s file, as the phone keeps its pins (dm-peer-pins.ts), read afresh. */
function pinIn(community: string, pin: object): void {
    h.store.set(dmPeerPinsStoreKey(me.publicKey, FILE[community]), JSON.stringify({ pins: { [randomUUID()]: pin } }));
    db._resetDmPeerPinsForTests();
}

describe('let in once: which key asks x who let them in x where the request waits (#3319 review F1)', () => {
    for (const place of PLACES) {
        const third = [A, B, C].find((x) => x !== place.at && x !== place.source)!;
        for (const source of SOURCES) {
            for (const key of KEYS_ASKING) {
                const quiet = source.letsIn && key.quiet;
                it(`${place.name}; a chat pinned in a third | ${source.name} | ${key.name} asks -> ${quiet ? 'accepted quietly' : 'a card'}`, async () => {
                    await phoneHoldingThree();
                    source.put(place.source, them.publicKey);
                    pinIn(third, key.pin(them.publicKey));
                    const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
                    node.convs.push(req);
                    asked = [];
                    await place.read();
                    await settle();
                    if (quiet) {
                        expect(acceptsTo(place.at)).toEqual([{ origin: place.at, body: { conversationId: req.id, decision: 'accept' } }]);
                        expect(req.request?.state).toBe('accepted');
                    } else {
                        expect(acceptsTo(place.at)).toEqual([]);
                        expect(req.request?.state).toBe('pending');
                        expect(keptRequestIds(place.at)).toContain(req.id);
                    }
                });
            }
        }
    }
});

/**
 * What the member does between the read of the request's list and its quiet accept (#3319 review F2, F3). `when`: 'list',
 * while that list's answer is on its way (the node made it, then took the member's answer, then the phone read it);
 * 'accept', after every copy was read, just before the accept; 'inside', inside the accept itself, at its read of the
 * community address (chatCopyForRequest), after every check before it and before its POST (#3319 review at 3b80f0ee, F2 and
 * F3), that read still answering the address it read. The member let them in as a linked contact, so the contacts list is
 * the let-in's last read. Their own answer stands, a Block since holds, and an accept goes only to the community the
 * list came from.
 */
interface Between {
    name: string;
    when: 'list' | 'accept' | 'inside';
    act: (ctx: { req: Conv; place: Place; after: Array<() => Promise<void>> }) => Promise<void>;
    quiet: (place: Place) => boolean;
    state: (place: Place) => 'accepted' | 'ignored' | 'pending';
}
/** The community a tap on the request sends with (the chat screen's and the card's `community`): none in the community in use. */
const tapCommunity = (place: Place) => (place.at === B ? undefined : place.at);
const ignoreTapped = async ({ req, place }: { req: Conv; place: Place }) => { await db.decideMessageRequest(req.id, 'ignore', tapCommunity(place)); };
const BETWEEN: Between[] = [
    { name: 'nothing', when: 'accept', act: async () => {}, quiet: () => true, state: () => 'accepted' },
    { name: 'Ignore tapped in the chat, its answer back', when: 'accept', act: ignoreTapped, quiet: () => false, state: () => 'ignored' },
    { name: 'Ignore answered while the list\'s answer was on its way', when: 'list', act: ignoreTapped, quiet: () => false, state: () => 'ignored' },
    {
        name: 'Decline tapped on its card, its answer still on the way', when: 'accept', quiet: () => false, state: () => 'ignored',
        act: async ({ req, place, after }) => {
            let release = () => {};
            h.holdIgnore = new Promise<void>((r) => { release = r; });
            const answered = db.decideMessageRequest(req.id, 'ignore', tapCommunity(place)).catch((e) => e);
            after.push(async () => { release(); h.holdIgnore = null; await answered; });
        },
    },
    {
        name: 'Decline all tapped (the community in use\'s requests)', when: 'accept', act: async () => { await db.ignoreAllMessageRequests(); },
        quiet: (p) => p.at !== B, state: (p) => (p.at === B ? 'ignored' : 'accepted'),
    },
    {
        // Which community's requests it ends isn't known until its answer: none is accepted quietly anywhere meanwhile.
        name: 'Decline all tapped, its answer still on the way', when: 'accept', quiet: () => false, state: (p) => (p.at === B ? 'ignored' : 'pending'),
        act: async ({ after }) => {
            let release = () => {};
            h.holdIgnore = new Promise<void>((r) => { release = r; });
            const answered = db.ignoreAllMessageRequests().catch((e) => e);
            after.push(async () => { release(); h.holdIgnore = null; await answered; });
        },
    },
    { name: 'Block tapped', when: 'accept', act: async () => { await blockUser(them.publicKey); await blockSyncsEndedForTests(); }, quiet: () => false, state: () => 'pending' },
    {
        // In place, the accept still goes to the request's own community; the one in use's request has no copy in place there.
        name: 'the phone switches to a third community', when: 'accept', act: async () => { await switchPhoneTo(C); },
        quiet: (p) => p.at === A, state: (p) => (p.at === A ? 'accepted' : 'pending'),
    },
    {
        name: 'the account on the phone changes', when: 'accept', quiet: () => false, state: () => 'pending',
        act: async () => { const other = person(); h.me = { ...other }; announceAccountOnPhone(other.publicKey); },
    },
    {
        // Asked after every await on the way to the POST (db.ts decideMessageRequest): a tap landing during them stands.
        name: 'Ignore tapped inside the accept, before its POST', when: 'inside', quiet: () => false, state: () => 'ignored',
        act: async ({ req, place, after }) => {
            const answered = db.decideMessageRequest(req.id, 'ignore', tapCommunity(place)).catch((e) => e);
            after.push(async () => { await answered; });
        },
    },
    {
        // One read of the address decides where it goes (db.ts chatCopyForRequest), never to the third: in place, the accept
        // still goes to the request's own community; the one in use's request has no copy in place there, so nothing is sent.
        name: 'the phone switches to a third community inside the accept', when: 'inside', act: async () => { await switchPhoneTo(C); },
        quiet: (p) => p.at === A, state: (p) => (p.at === A ? 'accepted' : 'pending'),
    },
];
/** The request's row in `community`'s copy as an earlier read in place left it (the card the member taps there was drawn from it). */
function requestHeldIn(community: string, req: Conv): void {
    intoCopy(community, (s) => {
        s.prepare('INSERT INTO conversations (id, type, created_by, request) VALUES (?, \'dm\', ?, ?)').run(req.id, req.request!.from, JSON.stringify(req.request));
        for (const k of req.participants) s.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(req.id, k);
    });
}
const acceptPosts = () => asked.filter((a) => a.method === 'POST' && new URL(a.url).pathname === '/api/messages/request' && a.body && JSON.parse(a.body).decision === 'accept')
    .map((a) => ({ origin: new URL(a.url).origin, id: JSON.parse(a.body!).conversationId }));

describe('let in once: what the member does between the list read and the accept x where the request waits (#3319 review F2, F3)', () => {
    for (const place of PLACES) {
        for (const between of BETWEEN) {
            const quiet = between.quiet(place);
            it(`${place.name} | ${between.name} -> ${quiet ? `accepted quietly, sent to ${new URL(place.at).host}` : 'a card, no accept sent anywhere'}`, async () => {
                await phoneHoldingThree();
                SOURCES.find((s) => s.name === 'a linked contact')!.put(place.source, them.publicKey);
                const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() }, at: place.at };
                node.convs.push(req);
                if (place.at === A) requestHeldIn(A, req);
                const after: Array<() => Promise<void>> = [];
                let acted = false;
                const act = async () => { acted = true; await between.act({ req, place, after }); };
                if (between.when === 'list') h.duringList = { origin: place.at, act };
                else if (between.when === 'inside') h.afterContacts = async () => { h.atAddressRead = act; };
                else h.afterContacts = act;
                asked = [];
                await place.read();
                for (const step of after) await step();
                await settle();
                expect(acted).toBe(true);
                expect(acceptPosts()).toEqual(quiet ? [{ origin: place.at, id: req.id }] : []);
                expect(req.request?.state).toBe(between.state(place));
            });
        }
    }
});

/**
 * Who made the row (#3319 review at 3b80f0ee, F1; the director's call of 21 Nov 2026 on the PR's own rule "one person's word
 * doesn't count": only a step the member took lets anyone in) x every source the let-in reads x where the request waits, and
 * across. Each row is let in exactly when the member, on any of their own devices, took the step (or the server carries out
 * one they signed: a standing deal's later period); each is red without the line of db.ts LET_IN_SQL (or the contacts read)
 * that judges it. Who can make a row carrying the member's key without the member's own act, as the server is built
 * (#3319 review N1, "close the class"):
 * - an admin, for the owner: a notice from the node's inbox (routes/admin.ts inbox/send, any admin or an owner's token),
 *   written under the first owner's key, readable and marked as the community admins' (state-engine.ts adminSendMessage), and
 *   the acceptance of a request it answers, which the node records as nobody's act (engine/dm-requests.ts nodeLineInRequest
 *   `byNode`: no `acceptedByYou`). Rows below. No admin route writes a friend, a deal or a payment in a member's name but
 *   one: the offboarding gift (member-wizards.ts executeOffboard) pays a departing member's balance to someone, in the same
 *   transaction that closes their account, after which their key can sign nothing here, reads included (https-server.ts
 *   CLOSED_ACCOUNT_REFUSAL), so it never reaches their phone.
 * - an assistant, for the owner: its tools list Offers and Needs, events, groups and enterprises in the owner's name
 *   (agent/tools.ts); it sends no line, adds no friend, takes up, asks for or approves no deal and pays nobody. A deal on a
 *   listing it made goes as one on the member's own listing does. Rows below.
 * - the server on its own: system lines (author SYSTEM, type system), a trade's acceptance (acceptOnTrade, nobody's act),
 *   an escrow's payouts and refunds (from escrow_*); and a standing deal's later period, which pays under the authorisation
 *   the member signed when they took the deal up or approved it (a step towards that same person: it counts). Rows below.
 * - another of the member's devices: the same key, so the same rows, as sync brings them. Rows below.
 * - a standby's copy or the phone's sync: a copy of a row, judged as the row is (who made it never changes on the way).
 * - a re-key (key-move.ts, the member-wizards re-key): moves the member's own rows to their new key.
 * Cells nobody but the member can make have no other row: a friend (only the signer adds one, social.ts addFriend) and a
 * linked contact (the phone's own list).
 */
type Maker = 'the member' | 'the member, on another of their devices' | 'the server, on the member\'s signed word'
    | 'an admin, for the owner' | 'an assistant, for the owner' | 'the other person alone' | 'the node on its own';
const MEMBERS_ACT: readonly Maker[] = ['the member', 'the member, on another of their devices', 'the server, on the member\'s signed word'];
interface Made { source: string; by: Maker; how: string; put: (community: string, key: string) => void }
function lineIn(sql: DatabaseSync, conversationId: string, author: string, type: string, line: { nonce?: string; metadata?: object } = {}): void {
    sql.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, \'x\', ?, ?, ?, ?)')
        .run(randomUUID(), conversationId, author, line.nonce ?? SEALED, type, line.metadata ? JSON.stringify(line.metadata) : null, iso());
}
/** A notice from the node's inbox, as state-engine.ts adminSendMessage stores it: the first owner's key, readable, marked. */
const ADMINS_NOTICE = { nonce: 'plaintext-v1', metadata: { [DM_FROM_ADMINS_KEY]: true } };
const friendIn = (sql: DatabaseSync, owner: string, friend: string) => sql.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)').run(owner, friend);
const paymentIn = (sql: DatabaseSync, from: string, to: string) => sql.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c) VALUES (?, ?, ?, 100)').run(randomUUID(), from, to);
const MADE: Made[] = [
    { source: 'a line in a direct chat', by: 'the member', how: 'the member wrote it', put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, null, me.publicKey); }) },
    { source: 'a line in a direct chat', by: 'the other person alone', how: 'only they wrote', put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, null, k); }) },
    { source: 'a line in a direct chat', by: 'the node on its own', how: 'a system line (a trade\'s note)', put: (c, k) => intoCopy(c, (s) => { lineIn(s, dmIn(s, k, null, k), 'SYSTEM', 'system'); }) },
    { source: 'a line in a direct chat', by: 'the node on its own', how: 'a system line in the member\'s name', put: (c, k) => intoCopy(c, (s) => { lineIn(s, dmIn(s, k, null, k), me.publicKey, 'system'); }) },
    {
        source: 'a line in a direct chat', by: 'the member, on another of their devices', how: 'a photo sent from their other phone, as sync keeps it',
        put: (c, k) => intoCopy(c, (s) => { lineIn(s, dmIn(s, k, null, null), me.publicKey, 'image'); }),
    },
    // The review's own probe (#3319 at e9ed010b, N1): a copy holding only an admin's notice to them, in the owner's name.
    {
        source: 'a line in a direct chat', by: 'an admin, for the owner', how: 'a notice from the node\'s inbox, the copy\'s only line',
        put: (c, k) => intoCopy(c, (s) => { lineIn(s, dmIn(s, k, null, null), me.publicKey, 'text', ADMINS_NOTICE); }),
    },
    {
        source: 'a line in a direct chat', by: 'an admin, for the owner', how: 'a line marked as the admins\', though its nonce is a sealed line\'s',
        put: (c, k) => intoCopy(c, (s) => { lineIn(s, dmIn(s, k, null, null), me.publicKey, 'text', { metadata: { [DM_FROM_ADMINS_KEY]: true } }); }),
    },
    {
        source: 'a line in a direct chat', by: 'the node on its own', how: 'a readable line in the member\'s name, unmarked',
        put: (c, k) => intoCopy(c, (s) => { lineIn(s, dmIn(s, k, null, null), me.publicKey, 'text', { nonce: 'plaintext-v1' }); }),
    },
    {
        source: 'a request\'s acceptance', by: 'the member', how: 'their own Accept (the node says acceptedByYou)',
        put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, { from: k, state: 'accepted', at: iso(), acceptedByYou: true }, k); }),
    },
    {
        source: 'a request\'s acceptance', by: 'the other person alone', how: 'it reads accepted, not by the member\'s act',
        put: (c, k) => intoCopy(c, (s) => { dmIn(s, k, { from: k, state: 'accepted', at: iso() }, k); }),
    },
    {
        // The node records it as nobody's act (nodeLineInRequest `byNode`), so its view has no acceptedByYou; the notice is beside it.
        source: 'a request\'s acceptance', by: 'an admin, for the owner', how: 'a notice from the node\'s inbox answered their request',
        put: (c, k) => intoCopy(c, (s) => { lineIn(s, dmIn(s, k, { from: k, state: 'accepted', at: iso() }, k), me.publicKey, 'text', ADMINS_NOTICE); }),
    },
    {
        source: 'a request\'s acceptance', by: 'the node on its own', how: 'a trade accepted one the member Ignored, the deal cancelled',
        put: (c, k) => intoCopy(c, (s) => {
            dmIn(s, k, { from: k, state: 'accepted', at: iso() }, k);
            dealIn(s, { buyer: k, seller: me.publicKey, status: 'cancelled', post: listingIn(s, me.publicKey, 'offer') });
        }),
    },
    { source: 'a friend', by: 'the member', how: 'the member added them', put: (c, k) => intoCopy(c, (s) => { friendIn(s, me.publicKey, k); }) },
    { source: 'a friend', by: 'the other person alone', how: 'they added the member', put: (c, k) => intoCopy(c, (s) => { friendIn(s, k, me.publicKey); }) },
    {
        source: 'a deal, the member buying', by: 'the member', how: 'took up their Offer (pending)',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: me.publicKey, seller: k, status: 'pending', post: listingIn(s, k, 'offer') }); }),
    },
    {
        source: 'a deal, the member buying', by: 'the member', how: 'approved their offer on the member\'s Need (completed)',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: me.publicKey, seller: k, status: 'completed', post: listingIn(s, me.publicKey, 'need') }); }),
    },
    {
        source: 'a deal, the member buying', by: 'the other person alone', how: 'they offered on the member\'s Need, never approved',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: me.publicKey, seller: k, status: 'requested', post: listingIn(s, me.publicKey, 'need') }); }),
    },
    {
        source: 'a deal, the member buying', by: 'an assistant, for the owner', how: 'it listed the Need; they offered, never approved',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: me.publicKey, seller: k, status: 'requested', post: listingIn(s, me.publicKey, 'need') }); }),
    },
    {
        source: 'a deal, the member buying', by: 'the server, on the member\'s signed word', how: 'a standing deal\'s later period, paid at its start',
        put: (c, k) => intoCopy(c, (s) => {
            s.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status, standing_id, period_no) VALUES (?, ?, ?, ?, \'completed\', ?, 2)')
                .run(randomUUID(), listingIn(s, k, 'offer'), me.publicKey, k, randomUUID());
        }),
    },
    {
        source: 'a deal, the member buying', by: 'the node on its own', how: 'their offer rejected as another was approved',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: me.publicKey, seller: k, status: 'rejected', post: listingIn(s, me.publicKey, 'need') }); }),
    },
    {
        source: 'a deal, the member selling', by: 'the member', how: 'offered on their Need, they approved (pending)',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: k, seller: me.publicKey, status: 'pending', post: listingIn(s, k, 'need') }); }),
    },
    {
        source: 'a deal, the member selling', by: 'the member', how: 'offered on their Need, done (completed)',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: k, seller: me.publicKey, status: 'completed', post: listingIn(s, k, 'need') }); }),
    },
    {
        source: 'a deal, the member selling', by: 'the other person alone', how: 'they took up the member\'s Offer (pending)',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: k, seller: me.publicKey, status: 'pending', post: listingIn(s, me.publicKey, 'offer') }); }),
    },
    {
        source: 'a deal, the member selling', by: 'the other person alone', how: 'they took up the member\'s Offer and released it (completed)',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: k, seller: me.publicKey, status: 'completed', post: listingIn(s, me.publicKey, 'offer') }); }),
    },
    {
        source: 'a deal, the member selling', by: 'an assistant, for the owner', how: 'it listed the Offer; they took it up (pending)',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: k, seller: me.publicKey, status: 'pending', post: listingIn(s, me.publicKey, 'offer') }); }),
    },
    {
        source: 'a deal, the member selling', by: 'the other person alone', how: 'they took up a listing this copy doesn\'t hold (pending)',
        put: (c, k) => intoCopy(c, (s) => { dealIn(s, { buyer: k, seller: me.publicKey, status: 'pending' }); }),
    },
    { source: 'a payment', by: 'the member', how: 'the member paid them', put: (c, k) => intoCopy(c, (s) => { paymentIn(s, me.publicKey, k); }) },
    { source: 'a payment', by: 'the other person alone', how: 'they paid the member', put: (c, k) => intoCopy(c, (s) => { paymentIn(s, k, me.publicKey); }) },
    { source: 'a payment', by: 'the node on its own', how: 'a deal\'s escrow paid them', put: (c, k) => intoCopy(c, (s) => { paymentIn(s, `escrow_${randomUUID()}`, k); }) },
    { source: 'a payment', by: 'the server, on the member\'s signed word', how: 'a standing deal\'s period paid to them', put: (c, k) => intoCopy(c, (s) => { paymentIn(s, me.publicKey, k); }) },
    { source: 'a linked contact', by: 'the member', how: 'the member linked them', put: (_c, k) => { h.contacts = [{ links: [{ key: k }] }]; } },
];

describe('let in once: who made the row x every source x where the request waits, and across (#3319 review at 3b80f0ee, F1)', () => {
    for (const made of MADE) {
        const letsIn = MEMBERS_ACT.includes(made.by);
        for (const place of PLACES) {
            it(`${place.name} | ${made.source} | ${made.by}: ${made.how} -> ${letsIn ? 'accepted quietly' : 'a card'}`, async () => {
                await phoneHoldingThree();
                made.put(place.source, them.publicKey);
                const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
                node.convs.push(req);
                asked = [];
                await place.read();
                await settle();
                expect(acceptsTo(place.at)).toEqual(letsIn ? [{ origin: place.at, body: { conversationId: req.id, decision: 'accept' } }] : []);
                expect(req.request?.state).toBe(letsIn ? 'accepted' : 'pending');
            });
        }
        it(`across | ${made.source} | ${made.by}: ${made.how} -> ${letsIn ? 'their first line opens a chat, door closed' : 'their first line goes nowhere, door closed'}`, async () => {
            await phoneHoldingThree();
            made.put(C, them.publicKey);
            const letIn = await letInFor(me.publicKey)(them.publicKey);
            expect(letIn).toBe(letsIn);
            expect(gateOutsideItem({ kind: 'dm-line', chat: null, doorOpen: false, blocked: false, letIn })).toBe(letsIn ? 'line' : 'drop');
        });
    }
});

/** A request from `from` waiting for the member, in `at`'s list (left out: every list, as the node stand-in lists them). */
const waitingRequest = (from: string, at?: string): Conv => ({ id: randomUUID(), type: 'dm', participants: [from, me.publicKey], request: { from, state: 'pending', at: iso() }, ...(at ? { at } : {}) });

describe('let in once: the review\'s own case (#3319 at 3b80f0ee, F1): Ann Ignores Sid, Sid takes up her Offer, then cancels', () => {
    it('Sid is let in nowhere: no request of his is accepted quietly, in another community or in hers, and his first line across meets her closed door', async () => {
        await phoneHoldingThree();
        const sid = them.publicKey;
        // In A, Ann's Offer, as A's copy holds it; Sid writes her a line there, a request, which she reads in place.
        let offer = '';
        intoCopy(A, (s) => { offer = listingIn(s, me.publicKey, 'offer'); });
        const inA = waitingRequest(sid, A);
        node.convs.push(inA);
        requestHeldIn(A, inA);
        intoCopy(A, (s) => { lineIn(s, inA.id, sid, 'text'); });
        // She taps Ignore on its card.
        await db.decideMessageRequest(inA.id, 'ignore', A);
        expect(inA.request?.state).toBe('ignored');
        // Sid takes up her Offer alone (escrow.ts acceptPost): the trade accepts his request (dm-requests.ts acceptOnTrade,
        // accepted_by null, so no acceptedByYou), and A's next sync brings the chat as the node lists it and the deal, pending.
        inA.request = { from: sid, state: 'accepted', at: inA.request!.at };
        intoCopy(A, (s) => {
            s.prepare('UPDATE conversations SET request = ? WHERE id = ?').run(JSON.stringify(inA.request), inA.id);
            dealIn(s, { buyer: sid, seller: me.publicKey, status: 'pending', post: offer });
        });
        // While it waits: his request in B, the community in use, is a card.
        const inB = waitingRequest(sid, B);
        node.convs.push(inB);
        asked = [];
        await db.syncMessages(me.publicKey);
        await settle();
        expect(acceptPosts()).toEqual([]);
        expect(inB.request?.state).toBe('pending');
        // He cancels (escrow.ts cancelPostTransaction: refunded in full); his request in A stays accepted.
        intoCopy(A, (s) => { s.prepare('UPDATE marketplace_transactions SET status = \'cancelled\' WHERE buyer_pubkey = ?').run(sid); });
        const inC = waitingRequest(sid, C);
        node.convs.push(inC);
        asked = [];
        await db.requestsInPlace(me.publicKey, C);
        await db.syncMessages(me.publicKey);
        await settle();
        expect(acceptPosts()).toEqual([]);
        expect([inB.request?.state, inC.request?.state]).toEqual(['pending', 'pending']);
        // Across: nobody let him in, so his first line meets her door, closed.
        const letIn = await letInFor(me.publicKey)(sid);
        expect(letIn).toBe(false);
        expect(gateOutsideItem({ kind: 'dm-line', chat: null, doorOpen: false, blocked: false, letIn })).toBe('drop');
    });
});

/**
 * "Add people I've chatted with and my friends" (contacts.tsx addPeople: db.ts getChattedWithMembers, then contacts-former.ts
 * withPeopleAdded) links each person it counts by hand, and a linked contact is let in on every community the phone holds. So
 * it counts a chat only by the test let in once reads (#3319 review at 1697ff89, R2-F1; Marty 21 Nov 2026: "chatted with"
 * counts only chats where the member wrote or accepted themselves). One table {the member wrote a line; from another of their
 * devices; accepted their request themselves} x {only they wrote, requests off; someone took up the member's Offer alone;
 * they wrote, the member Ignored, then a trade accepted it; a notice from the node's inbox in the member's name; a request
 * waiting for the member}: offered exactly for the member's own. Then the review's probe, end to end.
 */
interface ChatKind { name: string; offered: boolean; put: (s: DatabaseSync, k: string) => void }
/** A trade's chat as the node opens it (messaging.ts ensureTransactionConversation, asNode): no request, on the Offer. */
function tradeChatIn(s: DatabaseSync, buyer: string, request: object | null): string {
    const offer = listingIn(s, me.publicKey, 'offer');
    const id = dmIn(s, buyer, request, buyer);
    s.prepare('UPDATE conversations SET post_id = ? WHERE id = ?').run(offer, id);
    lineIn(s, id, 'SYSTEM', 'system');
    dealIn(s, { buyer, seller: me.publicKey, status: 'pending', post: offer });
    return id;
}
const CHAT_KINDS: ChatKind[] = [
    { name: 'the member wrote a line', offered: true, put: (s, k) => { dmIn(s, k, null, me.publicKey); } },
    { name: 'the member sent a photo from another of their devices', offered: true, put: (s, k) => { lineIn(s, dmIn(s, k, null, k), me.publicKey, 'image'); } },
    { name: 'the member accepted their request themselves (acceptedByYou)', offered: true, put: (s, k) => { dmIn(s, k, { from: k, state: 'accepted', at: iso(), acceptedByYou: true }, k); } },
    { name: 'only they wrote, requests off, never answered', offered: false, put: (s, k) => { dmIn(s, k, null, k); } },
    { name: 'they took up the member\'s Offer alone: the trade\'s chat, their line and the node\'s', offered: false, put: (s, k) => { tradeChatIn(s, k, null); } },
    { name: 'they wrote, the member Ignored, then a trade accepted it', offered: false, put: (s, k) => { tradeChatIn(s, k, { from: k, state: 'accepted', at: iso() }); } },
    { name: 'a notice from the node\'s inbox in the member\'s name, its only line', offered: false, put: (s, k) => { lineIn(s, dmIn(s, k, null, null), me.publicKey, 'text', ADMINS_NOTICE); } },
    { name: 'a request waiting for the member', offered: false, put: (s, k) => { dmIn(s, k, { from: k, state: 'pending', at: iso() }, k); } },
];
/** A member's card in a copy, as its sync keeps it: "Add people I've chatted with" names only people the copy has a card for. */
const cardIn = (s: DatabaseSync, key: string, callsign: string) => s.prepare('INSERT INTO members (public_key, callsign) VALUES (?, ?)').run(key, callsign);
/** The tap on Add, as contacts.tsx addPeople makes it: the people it counts, linked by hand to the community in use. */
async function addPeopleIveChattedWith(): Promise<string[]> {
    const chats = await db.getChattedWithMembers(me.publicKey);
    const list = withPeopleAdded(emptyContactsList(), chats.map((p) => ({ key: String(p.publicKey), callsign: String(p.callsign) })), me.publicKey, B);
    h.contacts = list.contacts as any;
    return list.contacts.flatMap((c) => c.links.map((l) => l.key));
}

describe('let in once: "Add people I\'ve chatted with and my friends" counts only chats the member took part in (#3319 review at 1697ff89, R2-F1)', () => {
    it('one table: offered, and linked, exactly for a chat the member wrote in or accepted themselves', async () => {
        await phoneHoldingThree();
        const people = CHAT_KINDS.map((kind) => ({ kind, key: person().publicKey }));
        intoCopy(B, (s) => {
            for (const [i, p] of people.entries()) {
                cardIn(s, p.key, `person${i}`);
                p.kind.put(s, p.key);
            }
        });
        const offered = new Set((await db.getChattedWithMembers(me.publicKey)).map((p) => p.publicKey));
        const linked = new Set(await addPeopleIveChattedWith());
        for (const p of people) {
            expect(offered.has(p.key), `offered | ${p.kind.name}`).toBe(p.kind.offered);
            expect(linked.has(p.key), `linked | ${p.kind.name}`).toBe(p.kind.offered);
            // Across, after the tap: let in exactly when the member took part.
            expect(await letInFor(me.publicKey)(p.key), `let in across | ${p.kind.name}`).toBe(p.kind.offered);
        }
    });

    it('the review\'s probe: Sid\'s take-up of the member\'s Offer and Kim\'s unanswered requests-off chat are not offered, and after Add neither is let in anywhere', async () => {
        await phoneHoldingThree();
        const sid = person().publicKey;
        const kim = person().publicKey;
        const tom = person().publicKey;
        intoCopy(B, (s) => {
            cardIn(s, sid, 'sid');
            cardIn(s, kim, 'kim');
            cardIn(s, tom, 'tom');
            // Sid takes up Ann's Offer alone: the node opens the trade's chat, no request, his line and the escrow's note.
            tradeChatIn(s, sid, null);
            // Requests are off here: Kim's line arrived straight away, and Ann never answered.
            dmIn(s, kim, null, kim);
            // Control: Ann wrote to Tom.
            dmIn(s, tom, null, me.publicKey);
        });
        expect((await db.getChattedWithMembers(me.publicKey)).map((p) => p.publicKey)).toEqual([tom]);
        expect(await addPeopleIveChattedWith()).toEqual([tom]);
        // Their requests in another community she holds, read in place: Sid's and Kim's are cards; Tom's is accepted for her.
        const [fromSid, fromKim, fromTom] = [sid, kim, tom].map((from) => waitingRequest(from, A));
        node.convs.push(fromSid, fromKim, fromTom);
        asked = [];
        const got = await db.requestsInPlace(me.publicKey, A);
        await settle();
        expect(acceptPosts()).toEqual([{ origin: A, id: fromTom.id }]);
        expect([fromSid, fromKim, fromTom].map((r) => r.request?.state)).toEqual(['pending', 'pending', 'accepted']);
        expect(got?.conversations.map((c: any) => c.id).sort()).toEqual([fromSid.id, fromKim.id].sort());
        // Across: neither is let in; their first line meets her closed door.
        for (const k of [sid, kim]) {
            const letIn = await letInFor(me.publicKey)(k);
            expect(letIn).toBe(false);
            expect(gateOutsideItem({ kind: 'dm-line', chat: null, doorOpen: false, blocked: false, letIn })).toBe('drop');
        }
    });
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

    it('a held copy\'s DM pins that can\'t be read: nobody is let in quietly, as what they know was replaced is unknown (F1)', async () => {
        SOURCES[2].put(A, them.publicKey);
        h.store.set(dmPeerPinsStoreKey(me.publicKey, FILE[C]), 'not the pins');
        db._resetDmPeerPinsForTests();
        const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
        node.convs.push(req);
        expect((await db.requestsInPlace(me.publicKey, A))?.conversations.map((c: any) => c.id)).toEqual([req.id]);
        expect(acceptsTo(A)).toEqual([]);
    });

    it('the copy in use\'s DM pins that can\'t be read: nobody is let in quietly in place either (F1)', async () => {
        SOURCES[2].put(C, them.publicKey);
        h.store.set(dmPeerPinsStoreKey(me.publicKey, FILE[B]), 'not the pins');
        db._resetDmPeerPinsForTests();
        const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() } };
        node.convs.push(req);
        expect((await db.requestsInPlace(me.publicKey, A))?.conversations.map((c: any) => c.id)).toEqual([req.id]);
        expect(acceptsTo(A)).toEqual([]);
    });

    it('across: a first line from a re-keyed person\'s old key is not let in, from their key now it is (F1)', async () => {
        const now = person();
        SOURCES[2].put(C, them.publicKey);
        SOURCES[2].put(C, now.publicKey);
        pinIn(A, { peer: now.publicKey, since: iso(), by: 'listing', former: [them.publicKey] });
        const letIn = letInFor(me.publicKey);
        expect(await letIn(now.publicKey)).toBe(true);
        expect(await letIn(them.publicKey)).toBe(false);
    });

    it('a request the member Ignored is never accepted quietly later in this run, though a list names it waiting again (F2)', async () => {
        SOURCES[2].put(C, them.publicKey);
        const req: Conv = { id: randomUUID(), type: 'dm', participants: [them.publicKey, me.publicKey], request: { from: them.publicKey, state: 'pending', at: iso() }, at: A };
        node.convs.push(req);
        requestHeldIn(A, req);
        h.duringList ={ origin: A, act: async () => { await db.decideMessageRequest(req.id, 'ignore', A); } };
        await db.requestsInPlace(me.publicKey, A);
        expect(req.request?.state).toBe('ignored');
        req.request = { ...req.request!, state: 'pending' };
        asked = [];
        expect((await db.requestsInPlace(me.publicKey, A))?.conversations.map((c: any) => c.id)).toEqual([req.id]);
        expect(acceptPosts()).toEqual([]);
        expect(req.request?.state).toBe('pending');
    });

    it('500 chats in each of two held copies and the copy in use: the let-in read, timed', async () => {
        const fill = (s: DatabaseSync) => {
            s.exec('BEGIN');
            for (let i = 0; i < 500; i++) {
                const other = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
                const id = randomUUID();
                s.prepare('INSERT INTO conversations (id, type, created_by, listed) VALUES (?, \'dm\', ?, 1)').run(id, other);
                for (const k of [me.publicKey, other]) s.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, k);
                for (let j = 0; j < 20; j++) s.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp) VALUES (?, ?, ?, \'x\', ?, ?)').run(randomUUID(), id, j === 19 && i % 2 === 0 ? me.publicKey : other, SEALED, new Date(Date.now() - j * 1000).toISOString());
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
