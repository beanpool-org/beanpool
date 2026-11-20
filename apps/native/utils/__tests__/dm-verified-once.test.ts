/**
 * S7c, Verified once (scratch/fable-design/DESIGN-s7-blocks-verified-everywhere-fable.md §3, §4; Marty 21 Nov 2026: "Yes, all
 * four"). Verified is of the key, on the member's one list per account (utils/dm-verified-keys.ts): a chat in ANY community on
 * the phone is verified exactly when the key it is sealed to is on it. One community's word never pauses, marks or moves a
 * chat in another.
 *
 * ONE table, closing the class: every path that reads "is this chat verified" (the rows) x how the person stands on the list
 * (marked from this chat, marked from the other community's chat with the same person, not marked, the list unreadable) x
 * where the chat is (the community in use, a chat of another community held in place: slice S2). Real SQLite files on disk,
 * the real db.ts, the real pins and list, real DM sealing between real keys; each community's node is a stand-in that answers
 * as routes/messaging.ts does. The phone holds a DM with Ben (K1) in both: Riverside (held, opened in place) and Hilltop (in
 * use). Oracles: which key opens the sent line, the POSTs, the grey notice, Chat's "key changed" tag (both lists), the card's
 * "You marked" sentence, Verified ✓ on the key code screen, and the other community's pins value, byte for byte.
 *
 * Then the S7c mutants that need the real db.ts, each made through the list or the listing, each dying at its own row; and
 * the source guard: nothing but isVerifiedPin reads the list, and nothing reads a mark on a pin.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const h = vi.hoisted(() => ({
    dir: '',
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
    /** The mutant in force (null: the real code), and the community file the test is acting in (the per-file mutant reads it). */
    mutant: null as null | 'list-per-file' | 'unreadable-as-empty' | 'listing-leaks-to-other-file',
    actingIn: '',
    otherFile: '',
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
vi.mock('../blocklist', () => ({ getBlockedUsers: vi.fn(async () => []) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));
// The mutants that need the real db.ts are made here, around the real modules: off (h.mutant null) they are the real code.
vi.mock('../dm-verified-keys', async (orig) => {
    const real = await orig<typeof import('../dm-verified-keys')>();
    return {
        ...real,
        createDmVerifiedBook: (storage: import('../dm-verified-keys').VerifiedKeysStorage) => {
            const book = real.createDmVerifiedBook(storage);
            // "The mark read per file": one list per community file, as the pin's own mark was before S7c.
            const perFile = new Map<string, import('../dm-verified-keys').DmVerifiedBook>();
            const fileBook = () => {
                if (!perFile.has(h.actingIn)) {
                    perFile.set(h.actingIn, real.createDmVerifiedBook({
                        getItem: (k) => storage.getItem(`${k}:${h.actingIn}`),
                        setItem: (k, v) => storage.setItem(`${k}:${h.actingIn}`, v),
                    }));
                }
                return perFile.get(h.actingIn)!;
            };
            const pick = () => (h.mutant === 'list-per-file' ? fileBook() : book);
            return {
                read: async (me: string) => {
                    const list = await pick().read(me);
                    return h.mutant === 'unreadable-as-empty' && !list.readable ? real.dmVerifiedKeysOf([]) : list;
                },
                add: (me: string, key: string, now?: string) => pick().add(me, key, now),
                remove: (me: string, key: string) => pick().remove(me, key),
                forget: () => { book.forget(); perFile.clear(); },
            };
        },
    };
});
vi.mock('../dm-peer-pins', async (orig) => {
    const real = await orig<typeof import('../dm-peer-pins')>();
    return {
        ...real,
        // "B's listing writing anything into A's file": a listing heard in one file that also offers its key in the other's.
        applyDmListings: (...args: Parameters<typeof real.applyDmListings>) => {
            const changed = real.applyDmListings(...args);
            if (h.mutant === 'listing-leaks-to-other-file' && h.otherFile) {
                const k = Object.keys(Object.fromEntries(h.store)).find((key) => key.startsWith('beanpool_dm_peer_pins:') && key.endsWith(`:${h.otherFile}`));
                const listed = args[2].flat()[0];
                if (k && listed) {
                    const value = JSON.parse(h.store.get(k)!);
                    for (const pin of Object.values<any>(value.pins ?? {})) if (pin.peer !== listed) pin.offered = { peer: listed, at: args[3] };
                    h.store.set(k, JSON.stringify(value));
                }
            }
            return changed;
        },
    };
});

import * as db from '../db';
import { switchPhoneTo } from '../reconnect';
import { getDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { openDmLine, sealDmLine } from '../e2e-crypto';
import { dmPeerPinsStoreKey, dmVerifiedKeysStoreKey } from '../storage-keys';
import { dmKeyCodeShowsVerified } from '../dm-key-change';
import { keyCodeOf } from '../key-code';
import { syncedCursorKeyOf } from '../../services/pillar-sync';

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-verified-once-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

/** HELD: the chat opened in place (another community the phone holds). IN_USE: the community the phone is set to. */
const HELD = 'https://riverside.example';
const IN_USE = 'https://hilltop.example';
const HELD_FILE = getDatabaseFilenameForNode(HELD);
const IN_USE_FILE = getDatabaseFilenameForNode(IN_USE);
const ANCHOR = 'beanpool_anchor_url';

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── Each community's node ───────────────────────────────────────────────────────────────────────────────────────────

interface Line { id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string; type: string; metadata: string | null; timestamp: string; editedAt: string | null }
interface Conv { id: string; type: string; participants: string[] }
const nodes = new Map<string, { convs: Conv[]; lines: Line[] }>();
let clock = Date.parse('2026-11-21T00:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();
let posts: string[] = [];

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const view = (c: Conv) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-11-21T00:00:00.000Z' });

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const node = nodes.get(u.origin);
    if (!node) return answer(404, { error: 'no such community' });
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'POST' && u.pathname === '/api/messages/send') {
        posts.push(u.origin);
        const line: Line = { id: body.id, conversationId: body.conversationId, authorPubkey: body.authorPubkey, ciphertext: body.ciphertext, nonce: body.nonce, type: body.type || 'text', metadata: body.metadata ?? null, timestamp: tick(), editedAt: null };
        node.lines.push(line);
        return answer(200, { success: true, message: line });
    }
    if (method === 'POST' && u.pathname === '/api/messages/mark-read') return answer(200, { success: true });
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) return answer(200, { conversations: node.convs.filter((c) => c.participants.includes(list[1])).map(view), totalUnread: 0, deletedAccounts: [], requests: { count: 0, conversations: [] } });
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page && method === 'GET') {
        const conv = node.convs.find((c) => c.id === decodeURIComponent(page[1]));
        if (!conv) return answer(404, { error: 'Conversation not found' });
        return answer(200, { conversation: view(conv), messages: node.lines.filter((l) => l.conversationId === conv.id).map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

function nodeLine(origin: string, conv: Conv, author: Person, to: string, text: string): void {
    const id = randomUUID();
    const { ciphertext, nonce } = sealDmLine(text, { myEdPrivHex: author.privateKey, peerEdPubHex: to, conversationId: conv.id }, { senderPubHex: author.publicKey, messageId: id });
    nodes.get(origin)!.lines.push({ id, conversationId: conv.id, authorPubkey: author.publicKey, ciphertext, nonce, type: 'text', metadata: null, timestamp: tick(), editedAt: null });
}

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

let me: Person;
let ben: Person;      // K1
let benNew: Person;   // K2: Ben after a re-key, listed by one community only
const chats: Record<string, Conv> = {};
let phoneN = 0;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A phone that holds a DM with Ben (K1) in both communities, pinned in each, set to IN_USE; HELD's chat opens in place. */
async function phone(): Promise<void> {
    h.mutant = null;
    await db.closeDB();
    db._resetDmPeerPinsForTests();
    db._resetChatsInPlaceForTests();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    me = person();
    ben = person();
    benNew = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    (globalThis as any).fetch = fetchMock;
    for (const origin of [HELD, IN_USE]) {
        const conv: Conv = { id: randomUUID(), type: 'dm', participants: [me.publicKey, ben.publicKey] };
        chats[origin] = conv;
        nodes.set(origin, { convs: [conv], lines: [] });
        nodeLine(origin, conv, ben, me.publicKey, `hello from Ben in ${origin}`);
    }
    h.store.set(ANCHOR, HELD);
    expect(await db.syncMessages(me.publicKey)).toBe(true);
    expect(pinOf(HELD)?.peer).toBe(ben.publicKey);
    await db.closeDB();
    // The held copy synced while the phone was there (the pillar sync's cursor): Chat lists its chats (getHeldConversations).
    h.store.set(syncedCursorKeyOf(HELD_FILE), String(clock));
    await switchPhoneTo(IN_USE);
    expect(h.store.get(ANCHOR)).toBe(IN_USE);
    expect(await db.syncMessages(me.publicKey)).toBe(true);
    expect(pinOf(IN_USE)?.peer).toBe(ben.publicKey);
    posts = [];
}

const fileOf = (origin: string) => (origin === HELD ? HELD_FILE : IN_USE_FILE);
const other = (origin: string) => (origin === HELD ? IN_USE : HELD);
const at = (origin: string) => (origin === HELD ? HELD : undefined);
const pinsValue = (origin: string) => h.store.get(dmPeerPinsStoreKey(me.publicKey, fileOf(origin)));
const pinOf = (origin: string): any => JSON.parse(pinsValue(origin) ?? '{"pins":{}}').pins[chats[origin].id.toLowerCase()];
/** Every helper names the community it acts in, so the per-file mutant's list is the one that community's chat would read. */
const acting = (origin: string) => { h.actingIn = fileOf(origin); h.otherFile = fileOf(other(origin)); };

/** The community lists `key` for Ben in its DM, and the phone hears it: the sync (in use), or the chat's poll in place (held). */
async function relist(origin: string, key: Person): Promise<void> {
    acting(origin);
    chats[origin].participants = [me.publicKey, key.publicKey];
    if (origin === HELD) expect(await db.syncSingleConversation(chats[origin].id, HELD)).toBe(true);
    else expect(await db.syncMessages(me.publicKey)).toBe(true);
}

/** A send in that community's chat: the error's name, the POSTs to its node, and which of Ben's keys opens the line. */
async function send(origin: string, text: string): Promise<{ err: string | null; posts: number; opens: 'K1' | 'K2' | null }> {
    acting(origin);
    posts = [];
    let id: string;
    try {
        id = await db.insertMessage(chats[origin].id, me.publicKey, text, undefined, undefined, undefined, at(origin));
    } catch (e: any) {
        return { err: e?.name ?? 'Error', posts: posts.length, opens: null };
    }
    await settle();
    const line = nodes.get(origin)!.lines.find((l) => l.id === id);
    const reads = (who: Person) => {
        if (!line) return false;
        try {
            return openDmLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { myEdPrivHex: who.privateKey, peerEdPubHex: me.publicKey },
                { conversationId: chats[origin].id, senderPubHex: me.publicKey, messageId: id, part: 'body', metadata: line.metadata }).text === text;
        } catch { return false; }
    };
    return { err: null, posts: posts.filter((o) => o === origin).length, opens: reads(ben) ? 'K1' : reads(benNew) ? 'K2' : null };
}

/** Chat's "key changed" tag on that chat's row: Chat's own list (in use), or the held chats' (held). */
async function tag(origin: string): Promise<boolean> {
    acting(origin);
    if (origin === HELD) return !!(await db.getHeldConversations(me.publicKey, HELD))?.find((c) => c.id === chats[HELD].id)?.keyChanged;
    return !!((await db.getConversations(me.publicKey)) as any[]).find((c) => c.id === chats[IN_USE].id)?.keyChanged;
}
async function notices(origin: string): Promise<number> {
    acting(origin);
    return (await db.getMessages(chats[origin].id, { community: at(origin), notices: true })).filter((m: any) => m.keyChangedNotice).length;
}
/** Verified ✓ as the key code screen and the chat's header show it, and whether the screen says the list can't be read. */
async function checkmark(origin: string): Promise<{ shown: boolean; listUnread: boolean }> {
    acting(origin);
    const info = await db.getDmKeyCodeInfo(chats[origin].id, at(origin));
    return { shown: dmKeyCodeShowsVerified(info, keyCodeOf(info?.peer)), listUnread: !!info?.listUnread };
}
async function mark(origin: string): Promise<boolean> {
    acting(origin);
    return db.markDmPeerVerified(chats[origin].id, pinOf(origin).peer, at(origin));
}
async function tryIt<T>(run: () => Promise<T>): Promise<T | string> {
    try { return await run(); } catch (e: any) { return e?.name ?? 'Error'; }
}
const listKeys = () => Object.keys(JSON.parse(h.store.get(dmVerifiedKeysStoreKey(me.publicKey)) ?? '{"keys":{}}').keys).sort();

type Column = 'marked from this chat' | 'marked from the other community\'s chat' | 'not marked' | 'list unreadable';
const COLUMNS: Column[] = ['marked from this chat', 'marked from the other community\'s chat', 'not marked', 'list unreadable'];
const PLACES: Array<[string, string]> = [['the community in use', IN_USE], ['a chat held in place', HELD]];
const marks = (c: Column) => c === 'marked from this chat' || c === 'marked from the other community\'s chat';
/** A change of key waits for the member: Ben is on the list, or the list can't be read (fail closed). */
const holds = (c: Column) => c !== 'not marked';

/** Put Ben (K1) where the column says, as the member's own taps would. */
async function stand(c: Column, origin: string): Promise<void> {
    if (c === 'marked from this chat') expect(await mark(origin)).toBe(true);
    if (c === 'marked from the other community\'s chat' || c === 'list unreadable') expect(await mark(other(origin))).toBe(true);
    if (c === 'list unreadable') {
        h.store.set(dmVerifiedKeysStoreKey(me.publicKey), '{ this is not a list');
        db._resetDmPeerPinsForTests();
    }
}

interface Row { name: string; run: (c: Column, origin: string) => Promise<void> }

const ROWS: Row[] = [
    {
        name: 'Verified ✓ (the key code screen, the chat\'s header)',
        run: async (c, origin) => {
            await stand(c, origin);
            // The mark is of the key: shown in this chat AND the other community's chat with Ben, whichever chat marked it.
            for (const o of [origin, other(origin)]) expect(await checkmark(o), o).toEqual({ shown: marks(c), listUnread: c === 'list unreadable' });
        },
    },
    {
        name: 'the community lists another key (K2, here only): the pause or the notice, the tag, the card; the other community\'s chat untouched',
        run: async (c, origin) => {
            await stand(c, origin);
            const otherPins = pinsValue(other(origin));
            await relist(origin, benNew);
            const r = await send(origin, 'after the re-key');
            if (holds(c)) {
                expect(r).toEqual({ err: 'DmKeyChangedError', posts: 0, opens: null });
                expect(await tag(origin)).toBe(true);
                expect(await notices(origin)).toBe(0);
                acting(origin);
                const change = await db.getDmKeyChange(chats[origin].id, at(origin));
                expect(change?.offeredPeer).toBe(benNew.publicKey);
                // "You marked Ben as verified" only when the list says so: never while it can't be read.
                expect(!!change?.verified).toBe(marks(c));
            } else {
                expect(r).toEqual({ err: null, posts: 1, opens: 'K2' });
                expect(await tag(origin)).toBe(false);
                expect(await notices(origin)).toBe(1);
            }
            // One community's listing never reaches the other's chat: its pins value byte for byte, no tag, no notice, sends to K1.
            expect(pinsValue(other(origin))).toBe(otherPins);
            expect(await tag(other(origin))).toBe(false);
            expect(await notices(other(origin))).toBe(0);
            expect(await send(other(origin), 'still to Ben\'s first key')).toEqual({ err: null, posts: 1, opens: 'K1' });
        },
    },
    {
        name: 'first sight: the phone first meets the chat with its lines under K1 while the community lists K2 (§3.3 row 3)',
        run: async (c, origin) => {
            await stand(c, origin);
            // This phone keeps nothing for the chat (its entry gone from the pins value, which stays: no re-seed), so the
            // listing pins at first sight and the next check judges the thread's lines, all under K1.
            const value = JSON.parse(pinsValue(origin)!);
            delete value.pins[chats[origin].id.toLowerCase()];
            h.store.set(dmPeerPinsStoreKey(me.publicKey, fileOf(origin)), JSON.stringify(value));
            db._resetDmPeerPinsForTests();
            await relist(origin, benNew);
            const r = await send(origin, 'first words here');
            if (holds(c)) {
                expect(r).toEqual({ err: 'DmKeyChangedError', posts: 0, opens: null });
                expect(pinOf(origin)).toMatchObject({ peer: ben.publicKey, offered: { peer: benNew.publicKey } });
                expect(await tag(origin)).toBe(true);
            } else {
                expect(r).toEqual({ err: null, posts: 1, opens: 'K2' });
                expect(pinOf(origin)).toMatchObject({ peer: benNew.publicKey, former: [ben.publicKey] });
                expect(await notices(origin)).toBe(1);
            }
        },
    },
    {
        name: 'the resting rule: Remove verification in the other community\'s chat ends this chat\'s pause at its next check, with the notice',
        run: async (c, origin) => {
            await stand(c, origin);
            await relist(origin, benNew);
            acting(other(origin));
            const removed = await tryIt(() => db.removeDmPeerVerification(chats[other(origin)].id, at(other(origin))));
            if (marks(c)) {
                expect(removed).toBe(true);
                expect(listKeys()).toEqual([]);
                expect(await send(origin, 'carried on')).toEqual({ err: null, posts: 1, opens: 'K2' });
                expect(await notices(origin)).toBe(1);
                expect(await tag(origin)).toBe(false);
            } else if (c === 'list unreadable') {
                expect(removed).toBe('DmVerifiedStoreError');
                expect((await send(origin, 'still paused')).err).toBe('DmKeyChangedError');
            } else {
                expect(removed).toBe(false);
                expect(await send(origin, 'never paused')).toEqual({ err: null, posts: 1, opens: 'K2' });
            }
        },
    },
    {
        name: 'Continue with the new key: K2 joins the list beside K1, this chat sends to K2 and stays Verified ✓; the other chat keeps K1 and its ✓',
        run: async (c, origin) => {
            await stand(c, origin);
            await relist(origin, benNew);
            const otherPins = pinsValue(other(origin));
            acting(origin);
            const moved = await tryIt(() => db.acceptOfferedPeer(chats[origin].id, benNew.publicKey, at(origin)));
            if (marks(c)) {
                expect(moved).toBe(true);
                expect(listKeys()).toEqual([ben.publicKey, benNew.publicKey].sort());
                expect(await send(origin, 'to the new key')).toEqual({ err: null, posts: 1, opens: 'K2' });
                expect((await checkmark(origin)).shown).toBe(true);
                expect((await checkmark(other(origin))).shown).toBe(true);
                expect(pinsValue(other(origin))).toBe(otherPins);
            } else if (c === 'list unreadable') {
                expect(moved).toBe('DmVerifiedStoreError');
                expect(pinOf(origin)).toMatchObject({ peer: ben.publicKey, offered: { peer: benNew.publicKey } });
            } else {
                expect(moved).toBe(false);   // nothing waited: the chat already carried on
            }
        },
    },
    {
        name: 'Remove verification here (no pause): the key leaves the list, so neither chat shows Verified ✓; refused while the list can\'t be read',
        run: async (c, origin) => {
            await stand(c, origin);
            acting(origin);
            const removed = await tryIt(() => db.removeDmPeerVerification(chats[origin].id, at(origin)));
            expect(removed).toBe(marks(c) ? true : c === 'list unreadable' ? 'DmVerifiedStoreError' : false);
            for (const o of [origin, other(origin)]) expect((await checkmark(o)).shown).toBe(false);
            if (c === 'list unreadable') expect(h.store.get(dmVerifiedKeysStoreKey(me.publicKey))).toBe('{ this is not a list');
        },
    },
    {
        name: 'Mark as verified here while the list can\'t be read is refused; otherwise it marks the key for both chats',
        run: async (c, origin) => {
            await stand(c, origin);
            const r = await tryIt(() => mark(origin));
            expect(r).toBe(c === 'list unreadable' ? 'DmVerifiedStoreError' : true);
            if (c !== 'list unreadable') {
                expect(listKeys()).toEqual([ben.publicKey]);
                for (const o of [origin, other(origin)]) expect((await checkmark(o)).shown).toBe(true);
            }
        },
    },
    {
        name: 'the community\'s chat memory reset: the marks stay (its re-seed judges with the list), so a later key change there still waits',
        run: async (c, origin) => {
            await stand(c, origin);
            acting(origin);
            expect(await db.resetDmChatMemory(origin)).toBe('set-aside');
            db._resetDmPeerPinsForTests();
            if (marks(c)) expect(listKeys()).toEqual([ben.publicKey]);
            await relist(origin, benNew);
            const r = await send(origin, 'after the reset');
            expect(r.err).toBe(holds(c) ? 'DmKeyChangedError' : null);
            if (!holds(c)) expect(r.opens).toBe('K2');
        },
    },
];

describe('Verified once: every path that reads "is this chat verified" x how Ben stands on the list x where the chat is (S7c §4)', () => {
    for (const row of ROWS) {
        for (const [where, origin] of PLACES) {
            for (const c of COLUMNS) {
                it(`${row.name} | ${c} | ${where}`, async () => {
                    await phone();
                    await row.run(c, origin);
                    await db.leaveChatInPlace(HELD).catch(() => {});
                });
            }
        }
    }
});

/** The S7c mutants (§4) that need the real db.ts: each must fail the cell named beside it. */
const MUTANTS: Array<{ mutant: NonNullable<typeof h.mutant>; row: string; column: Column; origin: string }> = [
    { mutant: 'list-per-file', row: 'Verified ✓', column: 'marked from the other community\'s chat', origin: IN_USE },
    { mutant: 'list-per-file', row: 'Verified ✓', column: 'marked from the other community\'s chat', origin: HELD },
    { mutant: 'unreadable-as-empty', row: 'the community lists another key', column: 'list unreadable', origin: IN_USE },
    { mutant: 'unreadable-as-empty', row: 'the community lists another key', column: 'list unreadable', origin: HELD },
    { mutant: 'listing-leaks-to-other-file', row: 'the community lists another key', column: 'not marked', origin: IN_USE },
    { mutant: 'listing-leaks-to-other-file', row: 'the community lists another key', column: 'marked from this chat', origin: HELD },
];

describe('the table can fail: each S7c mutant dies at its own cell', () => {
    for (const m of MUTANTS) {
        it(`${m.mutant} → "${m.row}" | ${m.column} | ${m.origin === HELD ? 'held in place' : 'in use'} fails`, async () => {
            const row = ROWS.find((r) => r.name.startsWith(m.row));
            expect(row, m.row).toBeDefined();
            await phone();
            h.mutant = m.mutant;
            let failed = false;
            try { await row!.run(m.column, m.origin); } catch { failed = true; }
            h.mutant = null;
            await db.leaveChatInPlace(HELD).catch(() => {});
            expect(failed).toBe(true);
        });
    }
});

// ── Source guard: one reader, one list ─────────────────────────────────────────────────────────────────────────────

const NATIVE = path.join(__dirname, '..', '..');
function sources(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) sources(full, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
}

describe('source guard (S7c §4): nothing but isVerifiedPin reads the list, and nothing reads a mark on a pin', () => {
    const files = ['app', 'components', 'utils', 'services', 'constants', 'tools'].filter((d) => fs.existsSync(path.join(NATIVE, d))).flatMap((d) => sources(path.join(NATIVE, d)));
    const rel = (f: string) => path.relative(NATIVE, f).split(path.sep).join('/');

    it('the list\'s store is named only where it is kept: storage-keys.ts and dm-verified-keys.ts', () => {
        const naming = files.filter((f) => /beanpool_dm_verified_keys|dmVerifiedKeysStoreKey/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
        expect(naming).toEqual(['utils/dm-verified-keys.ts', 'utils/storage-keys.ts']);
    });

    it('the list\'s keys are read in exactly one place, inside isVerifiedPin; every other reader goes through it', () => {
        const src = fs.readFileSync(path.join(NATIVE, 'utils', 'dm-verified-keys.ts'), 'utf8');
        expect(src.match(/KEYS\.get\(/g)).toHaveLength(1);
        const reader = /export function isVerifiedPin\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
        expect(reader).toMatch(/KEYS\.get\(/);
        // KEYS is never handed out, and no other module defines a reader of its own.
        expect(src).not.toMatch(/export\s+(const|let)\s+KEYS\b/);
        expect(files.filter((f) => /function isVerifiedPin\b/.test(fs.readFileSync(f, 'utf8'))).map(rel)).toEqual(['utils/dm-verified-keys.ts']);
    });

    it('no pin carries a mark: DmPeerPin has no `verified`, nothing writes or reads one, and the pins\' format no longer names it', () => {
        const pins = fs.readFileSync(path.join(NATIVE, 'utils', 'dm-peer-pins.ts'), 'utf8');
        const iface = /export interface DmPeerPin \{([\s\S]*?)\n\}/.exec(pins)?.[1] ?? '';
        expect(iface).not.toMatch(/^\s*verified\??\s*:/m);
        expect(/const PIN_FORMAT_NAMES = new Set\(\[([\s\S]*?)\]\)/.exec(pins)?.[1]).not.toMatch(/'verified'/);
        const offenders = files.filter((f) => /\.verified\s*\??\.\s*peer\b|\bverified\s*:\s*\{\s*peer\b|pin\??\.verified\b/.test(fs.readFileSync(f, 'utf8'))).map(rel);
        expect(offenders).toEqual([]);
    });
});
