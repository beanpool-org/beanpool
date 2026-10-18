/**
 * Following a community to its new address carries its copy there, with what guards its chats against the node (review
 * of #2138, finding 1; utils/community-copy-carry.ts).
 *
 * The phone keeps one SQLite file per address (utils/nodes.ts getDatabaseFilenameForNode), and per file each DM's pinned
 * key, the DM guard list and the lines the update held (storage-keys.ts PER_FILE_STORE_KEYS), the group chats' highest
 * epoch (in the file) and the sync cursors. "Use the new address" used to open an empty file at the new address: the pins
 * were seeded again from whatever the node listed then, so whoever runs the node could choose `primaryAddress` and have
 * each follower's DMs pinned to keys of its choosing.
 *
 * Measured here end to end: the real acceptAddressFollow, the real switch (utils/reconnect.ts switchPhoneTo), the real
 * database open (utils/db.ts getDb) over real SQLite files on disk (node:sqlite, in a directory of this test's own), the
 * real DM pins through the real sync against a stand-in node. Only the two identity statements are handed in (both name
 * the same community: address-follow.test.ts checks those). "The app starts again" is every module loaded afresh over the
 * same storage and files.
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
    /** A file name whose move or copy throws (the disk busy, full). */
    failMoveOf: null as string | null,
    /** A key prefix whose next write throws once. */
    failSetPrefix: null as string | null,
    /** The app stops at this write to storage or to a file, counting from 1: that write and every one after it never happen. */
    stopAt: null as number | null,
    writes: 0,
    stopped: false,
    /** A storage key whose read waits for `wait` (the one-time rename's: a writer held between its lock and getDb). */
    gate: null as { key: string; wait: Promise<void> } | null,
}));

/** One write to storage or to a file: counted, and refused from the stop on. */
function written(): void {
    if (h.stopAt === null) return;
    h.writes++;
    if (h.writes >= h.stopAt) h.stopped = true;
    if (h.stopped) throw new Error('the app stopped');
}

/** expo-sqlite over node:sqlite, opening files in this test's directory, as expo-sqlite opens them in its own. */
vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    // A stopped app writes nothing more anywhere.
    const live = () => { if (h.stopped) throw new Error('the app stopped'); };
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            return {
                runAsync: async (q: string, p?: unknown) => {
                    live();
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                execAsync: async (q: string) => { live(); sql.exec(q); },
                getAllAsync: async (q: string, p?: unknown) => sql.prepare(q).all(...params(p)),
                getFirstAsync: async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null,
                withTransactionAsync: async (cb: () => Promise<void>) => { live(); await cb(); },
                closeAsync: async () => { sql.close(); },
            };
        }),
    };
});
/** expo-file-system over the real files. */
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        cacheDirectory: `file://${h.dir}/cache/`,
        EncodingType: { Base64: 'base64' },
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)) })),
        moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
            written();
            if (h.failMoveOf && local(from).endsWith(h.failMoveOf)) throw new Error('disk busy');
            nodeFs.renameSync(local(from), local(to));
        }),
        copyAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
            written();
            if (h.failMoveOf && local(from).endsWith(h.failMoveOf)) throw new Error('disk full');
            nodeFs.copyFileSync(local(from), local(to));
        }),
        deleteAsync: vi.fn(async (uri: string) => { written(); nodeFs.rmSync(local(uri), { force: true }); }),
        makeDirectoryAsync: vi.fn(async (uri: string) => { written(); nodeFs.mkdirSync(local(uri), { recursive: true }); }),
        writeAsStringAsync: vi.fn(async (uri: string, data: string) => { written(); nodeFs.writeFileSync(local(uri), data); }),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => {
            if (h.gate && k === h.gate.key) await h.gate.wait;
            return h.store.get(k) ?? null;
        }),
        setItem: vi.fn(async (k: string, v: string) => {
            written();
            if (h.failSetPrefix && k.startsWith(h.failSetPrefix)) { h.failSetPrefix = null; throw new Error('the app stopped'); }
            h.store.set(k, String(v));
        }),
        removeItem: vi.fn(async (k: string) => { written(); h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { written(); for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Me' })) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as dbModule from '../db';
import * as followModule from '../address-follow';
import * as reconnectModule from '../reconnect';
import * as nodesModule from '../nodes';
import * as carryModule from '../community-copy-carry';
import { type AddressFollowDeps, type CommunityIdentity } from '../address-follow';
import { getDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { MERGES } from '../community-copy-carry';
import {
    PER_FILE_STORE_KEYS, dmConversationsSeenSetAsideStoreKey, dmConversationsSeenStoreKey, dmLinesAtUpdateStoreKey,
    dmPeerPinsSetAsideStoreKey, dmPeerPinsStoreKey,
} from '../storage-keys';
import type { NodeProfile } from '../node-profile';
import type { StoredGroupEpoch } from '../group-chat-keys';

// A finished sync ends with require('react-native') for a DeviceEventEmitter nudge: answered at node's loader for the file.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) } };
    return realLoad.call(this, request, ...rest);
};

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-copy-carry-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

const FROM = 'https://203.0.113.5';
const TO = 'https://beans.example.org';
const FROM_FILE = getDatabaseFilenameForNode(FROM);
const TO_FILE = getDatabaseFilenameForNode(TO);
const ANCHOR = 'beanpool_anchor_url';
const COMMUNITY: CommunityIdentity = { peerId: '12D3KooWTestNodeKeyOfBeansTown', communityId: 'beans-town', epoch: 2 };
const PROFILE = { addresses: ['203.0.113.5', 'beans.example.org'], primaryAddress: 'beans.example.org' } as NodeProfile;

interface Person { publicKey: string; privateKey: string }
function person(): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

/** One run of the app: its modules, each holding what that run keeps in memory. */
interface App { db: typeof dbModule; follow: typeof followModule; reconnect: typeof reconnectModule; nodes: typeof nodesModule; carry: typeof carryModule }
const firstApp: App = { db: dbModule, follow: followModule, reconnect: reconnectModule, nodes: nodesModule, carry: carryModule };

/** The app started again: every module loaded afresh (nothing kept in memory), over the same storage and files. */
async function startedAgain(): Promise<App> {
    vi.resetModules();
    return {
        db: await import('../db'), follow: await import('../address-follow'), reconnect: await import('../reconnect'), nodes: await import('../nodes'),
        carry: await import('../community-copy-carry'),
    };
}

// ── The node: lists the DMs it holds for a key, as routes/messaging.ts answers ───────────────────────────────────────

interface Conv { id: string; type: string; participants: string[] }
const node = { convs: [] as Conv[] };
function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url);
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        const mine = node.convs.filter((c) => c.participants.includes(list[1]));
        return answer(200, {
            conversations: mine.map((c) => ({ id: c.id, type: c.type, name: null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-10-01T00:00:00.000Z' })),
            totalUnread: 0,
            deletedAccounts: [],
        });
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page) {
        const conv = node.convs.find((c) => c.id === page[1]);
        return conv ? answer(200, { conversation: { id: conv.id, type: conv.type, participants: conv.participants }, messages: [] }) : answer(404, { error: 'Conversation not found' });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

// ── The phone ────────────────────────────────────────────────────────────────────────────────────────────────────────

let me: Person;
let peer: Person;
let dm: Conv;
let phoneN = 0;

/** A new phone: its own directory and storage, at the community's number, nothing stopped. */
function newPhone(): void {
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.failMoveOf = null;
    h.failSetPrefix = null;
    h.stopAt = null;
    h.writes = 0;
    h.stopped = false;
    h.gate = null;
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(ANCHOR, FROM);
    me = person();
    peer = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    dm = { id: randomUUID(), type: 'dm', participants: [me.publicKey, peer.publicKey] };
    node.convs = [dm];
    (globalThis as any).fetch = fetchMock;
}

beforeEach(async () => {
    h.stopped = false;
    h.stopAt = null;
    await firstApp.db.closeDB();
    firstApp.db._resetDmPeerPinsForTests();
    firstApp.follow.forgetFollowChecks();
    newPhone();
});

const file = (name: string) => path.join(h.dir, name);
const stored = (key: string) => h.store.get(key) ?? null;
const pinsOf = (fileName: string, who = me.publicKey) => JSON.parse(stored(dmPeerPinsStoreKey(who, fileName)) ?? '{"pins":{}}').pins ?? {};
const pinOf = (fileName: string) => pinsOf(fileName)[dm.id.toLowerCase()];
const cursor = (fileName: string, id: string) => `pillar_sync_${fileName}_${id}`;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

/** Every row of the tables the move must keep, as the copy open now holds them. */
async function rowsHeld(app: App = firstApp): Promise<Record<string, unknown[]>> {
    const db = await app.db.getDb();
    const out: Record<string, unknown[]> = {};
    for (const t of ['conversations', 'conversation_participants', 'messages', 'group_chat_key_state', 'group_chat_epochs']) {
        out[t] = (await db.getAllAsync(`SELECT * FROM ${t} ORDER BY 1, 2`)).map((r) => ({ ...(r as object) }));
    }
    return out;
}

/**
 * The phone at the community's number, as the member has used it: the DM synced and pinned to `peer` (the real sync),
 * a group chat's highest epoch at 7 and another's epoch held with this phone's wrap (the sticky lock), sync cursors, and
 * what the member's resets set aside (another account on this phone too: its pins are kept when it leaves, storage-keys.ts).
 */
async function phoneAtTheNumber(app: App = firstApp): Promise<{ before: Record<string, unknown[]>; keys: Record<string, string | null> }> {
    await app.db.syncMessages(me.publicKey);
    expect(pinOf(FROM_FILE)?.peer, 'precondition: the real sync pinned the DM').toBe(peer.publicKey);
    expect(stored(dmConversationsSeenStoreKey(me.publicKey, FROM_FILE)), 'precondition: the DM guard list holds it').toContain(dm.id);
    await app.db.groupKeyStore(FROM).raiseHighest('g-beans', 7);
    await app.db.groupKeyStore(FROM).putEpochs('g-locked', [epochOne({ w: 'mine' })]);
    h.store.set(cursor(FROM_FILE, 'last-sync'), '1760000000000');
    h.store.set(cursor(FROM_FILE, 'identity-epoch'), '2');
    h.store.set(cursor(FROM_FILE, 'nearby_area'), '{"lat":-28.5}');
    h.store.set(dmPeerPinsSetAsideStoreKey(me.publicKey, FROM_FILE), '{"pins":{"old":1}}');
    h.store.set(dmConversationsSeenSetAsideStoreKey(me.publicKey, FROM_FILE), '["old"]');
    h.store.set(dmLinesAtUpdateStoreKey(me.publicKey, FROM_FILE), '{}');
    h.store.set(dmPeerPinsStoreKey('ab'.repeat(32), FROM_FILE), '{"pins":{}}');
    const keys: Record<string, string | null> = {};
    for (const k of h.store.keys()) if (k.includes(FROM_FILE)) keys[k] = stored(k);
    return { before: await rowsHeld(app), keys };
}

/**
 * The phone at the community's name some time before: it used it there with no DM yet (the real sync: an empty pin book,
 * an empty guard list), a group chat's highest epoch at 3 there, and another at 9 that the number knows only at 2.
 */
async function phoneWasAtTheName(app: App = firstApp): Promise<void> {
    h.store.set(ANCHOR, TO);
    node.convs = [];
    await app.db.syncMessages(me.publicKey);
    await app.db.groupKeyStore(TO).raiseHighest('g-beans', 3);
    await app.db.groupKeyStore(TO).raiseHighest('g-higher-here', 9);
    await app.db.groupKeyStore(TO).putEpochs('g-locked', [epochOne(null)]);
    h.store.set(cursor(TO_FILE, 'last-sync'), '1700000000000');
    await app.db.closeDB();
    expect(stored(dmPeerPinsStoreKey(me.publicKey, TO_FILE)), 'precondition: the name\'s pin book, empty').toBe('{"pins":{}}');
    expect(stored(dmConversationsSeenStoreKey(me.publicKey, TO_FILE)), 'precondition: the name\'s guard list, empty').toBe('[]');
    h.store.set(ANCHOR, FROM);
    node.convs = [dm];
    await app.db.groupKeyStore(FROM).raiseHighest('g-higher-here', 2);
}

function deps(app: App): AddressFollowDeps {
    return {
        anchor: async () => AsyncStorage.getItem(ANCHOR),
        profile: async () => PROFILE,
        statement: async () => COMMUNITY,
        now: () => Date.now(),
        switchTo: app.reconnect.switchPhoneTo,
        savedNodes: app.nodes.getSavedNodes,
        addSavedNode: app.nodes.addSavedNode,
        removeSavedNode: app.nodes.removeSavedNode,
        isGuestNode: app.nodes.isGuestNode,
        markGuestNode: app.nodes.markGuestNode,
    };
}

async function follow(app: App = firstApp) {
    const offer = await app.follow.addressFollowOffer(deps(app));
    expect(offer, 'precondition: the move is offered').toEqual({ from: FROM, to: TO, host: 'beans.example.org' });
    return app.follow.acceptAddressFollow(offer!, deps(app));
}

/** The node lists another key for the DM: the pin must hold it back as an offer, never take it. */
async function nodeListsAnotherKey(app: App = firstApp): Promise<Person> {
    const other = person();
    dm.participants = [me.publicKey, other.publicKey];
    await app.db.syncMessages(me.publicKey);
    return other;
}

/** Group epoch 1 as the store keeps it: the node's record (any JSON here), and this phone's wrap or none. */
const epochOne = (wrap: object | null) => ({ epoch: 1, record: { r: 'one' }, wrap }) as unknown as StoredGroupEpoch;

const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('"Use the new address" carries the community\'s copy and what guards its chats', () => {
    it('the same rows under the new name, the old file gone, every per-file key under the new name, the cursors moved', async () => {
        const { before, keys } = await phoneAtTheNumber();
        expect(await follow()).toBe('moved');
        expect(stored(ANCHOR)).toBe(TO);

        expect(fs.existsSync(file(FROM_FILE)), 'the old file is gone').toBe(false);
        for (const side of ['-wal', '-shm', '-journal', '-carry']) expect(fs.existsSync(file(`${FROM_FILE}${side}`))).toBe(false);
        expect(fs.existsSync(file(TO_FILE))).toBe(true);
        expect(fs.existsSync(file(`${TO_FILE}-carry`)), 'nothing left on its way').toBe(false);
        expect(await rowsHeld(), 'the copy open now is the old one, row for row').toEqual(before);

        for (const [k, v] of Object.entries(keys)) {
            const moved = k.replace(FROM_FILE, TO_FILE);
            expect(stored(moved), moved).toBe(v);
            // The pins and the guard list stay under the old name too (only the member's reset removes a pin); the
            // cursors don't, so the old name never has cursors without its file.
            expect(stored(k), k).toBe(k.startsWith('pillar_sync_') ? null : v);
        }
    });

    it('the group chat\'s highest epoch and its sticky lock are read under the new address', async () => {
        await phoneAtTheNumber();
        expect(await follow()).toBe('moved');
        expect((await firstApp.db.groupKeyStore(TO).load('g-beans')).highest).toBe(7);
        expect((await firstApp.db.groupKeyStore(TO).load('g-locked')).epochs[0]?.wrap).toEqual({ w: 'mine' });
    });

    it('the pins\' seed does not run again: a node listing another key for the DM after the move is held back, as before it', async () => {
        await phoneAtTheNumber();
        expect(await follow()).toBe('moved');
        firstApp.db._resetDmPeerPinsForTests();   // and after the app starts again
        const other = await nodeListsAnotherKey();
        expect(pinOf(TO_FILE)?.peer).toBe(peer.publicKey);
        expect((await firstApp.db.getDmKeyChange(dm.id))?.offeredPeer).toBe(other.publicKey);
    });

    it('a copy already under the new address\'s name keeps its rows (nothing renamed or copied over it), and the result and the log say both were kept', async () => {
        const { before } = await phoneAtTheNumber();
        await firstApp.db.closeDB();
        const theirs = new DatabaseSync(file(TO_FILE));
        theirs.exec("CREATE TABLE planted (x TEXT); INSERT INTO planted VALUES ('the phone was here before');");
        theirs.close();
        h.store.set(dmPeerPinsStoreKey(me.publicKey, TO_FILE), '{"pins":{}}');
        h.store.set(cursor(TO_FILE, 'last-sync'), '1700000000000');
        const warn = quiet();
        const moves = vi.mocked(FileSystem.moveAsync).mock.calls.length;
        const copies = vi.mocked(FileSystem.copyAsync).mock.calls.length;

        expect(await follow()).toBe('moved-kept-both');
        expect(vi.mocked(FileSystem.moveAsync).mock.calls.length, 'nothing renamed over it').toBe(moves);
        expect(vi.mocked(FileSystem.copyAsync).mock.calls.length, 'nothing copied over it').toBe(copies);
        expect(warn.mock.calls.some((c) => String(c[0]).includes('already has a copy') && String(c[0]).includes(TO_FILE))).toBe(true);
        warn.mockRestore();

        expect(stored(ANCHOR)).toBe(TO);
        const db = await firstApp.db.getDb();
        expect(await db.getAllAsync('SELECT x FROM planted')).toEqual([{ x: 'the phone was here before' }]);
        expect(stored(cursor(TO_FILE, 'last-sync')), 'its cursors are its own').toBe('1700000000000');
        // The old copy stays whole, under its own name, with its keys.
        expect(fs.existsSync(file(FROM_FILE))).toBe(true);
        expect(pinOf(FROM_FILE)?.peer).toBe(peer.publicKey);
        expect(stored(cursor(FROM_FILE, 'last-sync'))).toBe('1760000000000');
        await firstApp.db.closeDB();
        const old = new DatabaseSync(file(FROM_FILE));
        expect(old.prepare('SELECT id FROM conversations').all().map((r: any) => r.id)).toEqual((before.conversations as any[]).map((r) => r.id));
        old.close();
    });
});

describe('a copy already at the new address takes what guards the chats, add-only (confirmation 2 of #2138, BLOCKING)', () => {
    it('the reviewer\'s case: used at the name with no DM, a DM made at the number, then followed: the pin holds at the name and another key is only offered', async () => {
        await phoneWasAtTheName();
        await phoneAtTheNumber();
        const warn = quiet();
        expect(await follow()).toBe('moved-kept-both');
        warn.mockRestore();

        expect(pinOf(TO_FILE)?.peer, 'the number\'s pin is in the name\'s pin book').toBe(peer.publicKey);
        expect(JSON.parse(stored(dmConversationsSeenStoreKey(me.publicKey, TO_FILE))!), 'and its guard list').toContain(dm.id);
        firstApp.db._resetDmPeerPinsForTests();   // and after the app starts again
        const other = await nodeListsAnotherKey();
        expect(pinOf(TO_FILE)?.peer, 'never pinned to the node\'s key at first sight').toBe(peer.publicKey);
        expect((await firstApp.db.getDmKeyChange(dm.id))?.offeredPeer, 'held back as an offer').toBe(other.publicKey);
    });

    it('a DM the node first lists at the name as an event\'s chat is still a known DM there', async () => {
        await phoneWasAtTheName();
        await phoneAtTheNumber();
        const warn = quiet();
        expect(await follow()).toBe('moved-kept-both');
        dm.type = 'event';
        await firstApp.db.syncMessages(me.publicKey).catch(() => {});
        warn.mockRestore();
        expect(await firstApp.db.isKnownDmConversation(dm.id, { pinsMustRead: true })).toBe(true);
    });

    it('a DM both pin to different keys keeps the name\'s pin, and the number\'s key is set aside as an offer: neither replaced', async () => {
        await phoneWasAtTheName();
        await phoneAtTheNumber();
        const theirs = person();
        const pinnedAtTheName = { peer: theirs.publicKey, since: '2026-09-01T00:00:00.000Z', by: 'first-seen', checked: true };
        h.store.set(dmPeerPinsStoreKey(me.publicKey, TO_FILE), JSON.stringify({ pins: { [dm.id.toLowerCase()]: pinnedAtTheName } }));
        const atTheNumber = stored(dmPeerPinsStoreKey(me.publicKey, FROM_FILE));
        const warn = quiet();
        expect(await follow()).toBe('moved-kept-both');
        warn.mockRestore();

        const pin = pinOf(TO_FILE);
        expect(pin.peer, 'the name\'s pin stays').toBe(theirs.publicKey);
        expect(pin.offered?.peer, 'the number\'s key is offered, for the member to decide').toBe(peer.publicKey);
        expect(stored(dmPeerPinsStoreKey(me.publicKey, FROM_FILE)), 'the number\'s pins stay as they were').toBe(atTheNumber);
        firstApp.db._resetDmPeerPinsForTests();
        await firstApp.db.syncMessages(me.publicKey);
        expect((await firstApp.db.getDmKeyChange(dm.id))?.offeredPeer, 'nothing is sealed until the member decides').toBe(peer.publicKey);
    });

    it('each group chat takes the higher highest epoch, and the sticky lock either copy holds', async () => {
        await phoneWasAtTheName();
        await phoneAtTheNumber();
        const warn = quiet();
        expect(await follow()).toBe('moved-kept-both');
        warn.mockRestore();
        const groups = firstApp.db.groupKeyStore(TO);
        expect((await groups.load('g-beans')).highest, 'the number\'s 7 over the name\'s 3').toBe(7);
        expect((await groups.load('g-higher-here')).highest, 'never lowered: the name\'s 9 over the number\'s 2').toBe(9);
        expect((await groups.load('g-locked')).epochs[0]?.wrap, 'the wrap the number held: the chat stays locked').toEqual({ w: 'mine' });
    });

    it('the old copy is still on the phone, and the log says so; one already gone is never said to stay', async () => {
        await phoneAtTheNumber();
        const offer = await firstApp.follow.addressFollowOffer(deps(firstApp));
        const warn = quiet();
        // Two follows at once (the card's busy guard stops a double tap; the second finds the first's copy at the name).
        const results = await Promise.all([firstApp.follow.acceptAddressFollow(offer!, deps(firstApp)), firstApp.follow.acceptAddressFollow(offer!, deps(firstApp))]);
        const said = warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('already has a copy'));
        warn.mockRestore();
        expect(results).toEqual(['moved', 'moved-kept-both']);
        expect(fs.existsSync(file(FROM_FILE))).toBe(false);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(`no copy of ${FROM} is left on the phone`);
        expect(said[0]).not.toContain('stays on the phone');
    });
});

describe('a chat-memory reset still waiting at either address never makes the carry skip the pins (confirmation 3 of #2138, dm-peer-pins.ts:348)', () => {
    /**
     * After a fresh start, the node lists another key for the DM at the name and serves none of its lines: the pin holds,
     * the node's key is only offered, and the member's next line is refused before anything is sealed or written.
     */
    async function heldBackAtTheName(app: App, pinned: string): Promise<void> {
        expect(stored(ANCHOR)).toBe(TO);
        const other = await nodeListsAnotherKey(app);
        expect(pinOf(TO_FILE)?.peer, 'never pinned to the node\'s key at first sight').toBe(pinned);
        expect((await app.db.getDmKeyChange(dm.id))?.offeredPeer, 'held back as an offer').toBe(other.publicKey);
        const sent = await app.db.insertMessage(dm.id, me.publicKey, 'see you at the market').then(() => null, (e: Error) => e);
        expect(sent?.name, 'the member\'s next line is refused, never sealed to the node\'s key').toBe('DmKeyChangedError');
        expect(await (await app.db.getDb()).getAllAsync('SELECT id FROM messages WHERE conversation_id = ?', [dm.id]), 'nothing written').toEqual([]);
    }

    async function afterAFreshStart(): Promise<App> {
        await firstApp.db.closeDB();
        return startedAgain();
    }

    it('the reviewer\'s case: a copy at the name and the member\'s reset of the name waiting there: the number\'s pin goes in, the reset re-checks the name\'s own rows', async () => {
        await phoneWasAtTheName();
        await phoneAtTheNumber();
        expect(await firstApp.db.resetDmChatMemory(TO)).toBe('set-aside');
        expect(JSON.parse(stored(dmPeerPinsStoreKey(me.publicKey, TO_FILE))!).reset, 'precondition: the reset\'s marker waits at the name').toBeTruthy();
        const warn = quiet();
        expect(await follow()).toBe('moved-kept-both');
        warn.mockRestore();

        expect(stored(dmPeerPinsSetAsideStoreKey(me.publicKey, TO_FILE)), 'what the reset set aside at the name stays').toBe('{"pins":{}}');
        expect(pinOf(TO_FILE)?.peer, 'the number\'s pin is in the name\'s pin book').toBe(peer.publicKey);
        const app = await afterAFreshStart();
        await heldBackAtTheName(app, peer.publicKey);
        await app.db.closeDB();
    });

    it('the member\'s reset of the number waiting there (the follow before the next sync): the reset is judged on the number\'s rows, and what it pins goes to the name', async () => {
        await phoneWasAtTheName();
        await phoneAtTheNumber();
        const before = stored(dmPeerPinsStoreKey(me.publicKey, FROM_FILE));
        expect(await firstApp.db.resetDmChatMemory(FROM)).toBe('set-aside');
        const warn = quiet();
        expect(await follow()).toBe('moved-kept-both');
        warn.mockRestore();

        expect(stored(dmPeerPinsSetAsideStoreKey(me.publicKey, FROM_FILE)), 'the reset set the number\'s pins aside').toBe(before);
        expect(pinOf(FROM_FILE)?.peer, 'the number\'s re-seed ran over its own rows').toBe(peer.publicKey);
        expect(pinOf(TO_FILE)?.peer, 'and its pin is in the name\'s pin book').toBe(peer.publicKey);
        expect(JSON.parse(stored(dmConversationsSeenStoreKey(me.publicKey, TO_FILE))!), 'and the DM in the name\'s guard list').toContain(dm.id);
        const app = await afterAFreshStart();
        await heldBackAtTheName(app, peer.publicKey);
        await app.db.closeDB();
    });

    it('no copy at the name and a reset of the name waiting there: the number\'s pins go in whole, the member\'s own Continue with them, never judged again as if reset', async () => {
        await phoneAtTheNumber();
        // The person re-keyed at the number, and the member checked the new key's code with them and continued.
        const renewed = await nodeListsAnotherKey();
        expect(await firstApp.db.acceptOfferedPeer(dm.id, renewed.publicKey), 'precondition: the member\'s Continue').toBe(true);
        const continued = pinOf(FROM_FILE);
        expect({ peer: continued?.peer, by: continued?.by, former: continued?.former }).toEqual({ peer: renewed.publicKey, by: 'member', former: [peer.publicKey] });
        expect(await firstApp.db.resetDmChatMemory(TO)).toBe('nothing-stored');
        expect(await follow()).toBe('moved');

        expect(pinOf(TO_FILE), 'the number\'s pin, as the member left it').toEqual(continued);
        const app = await afterAFreshStart();
        const third = await nodeListsAnotherKey(app);
        const pin = pinOf(TO_FILE);
        expect({ peer: pin?.peer, by: pin?.by, former: pin?.former }, 'still the member\'s choice, its old lines still open').toEqual({ peer: renewed.publicKey, by: 'member', former: [peer.publicKey] });
        expect((await app.db.getDmKeyChange(dm.id))?.offeredPeer).toBe(third.publicKey);
        const sent = await app.db.insertMessage(dm.id, me.publicKey, 'see you at the market').then(() => null, (e: Error) => e);
        expect(sent?.name).toBe('DmKeyChangedError');
        await app.db.closeDB();
    });

    it('another account\'s reset waiting at the name: its pins at the number go in, and what its reset set aside stays', async () => {
        const x = 'cd'.repeat(32);
        const xPins = JSON.stringify({ pins: { 'x-dm': { peer: 'ef'.repeat(32), since: '2026-08-01T00:00:00.000Z', by: 'member' } } });
        h.store.set(dmPeerPinsStoreKey(x, FROM_FILE), xPins);
        h.store.set(dmPeerPinsStoreKey(x, TO_FILE), JSON.stringify({ reset: '2026-10-01T00:00:00.000Z' }));
        h.store.set(dmPeerPinsSetAsideStoreKey(x, TO_FILE), '{"pins":{"x-before":1}}');
        await phoneAtTheNumber();
        expect(await follow()).toBe('moved');

        expect(stored(dmPeerPinsStoreKey(x, TO_FILE))).toBe(xPins);
        expect(stored(dmPeerPinsStoreKey(x, FROM_FILE))).toBe(xPins);
        expect(stored(dmPeerPinsSetAsideStoreKey(x, TO_FILE))).toBe('{"pins":{"x-before":1}}');
    });

    it('pins at the name this phone can\'t read: nothing changes, and after the member\'s reset of the name the next tap carries the pin', async () => {
        await phoneWasAtTheName();
        const { keys } = await phoneAtTheNumber();
        h.store.set(dmPeerPinsStoreKey(me.publicKey, TO_FILE), '{"pins":');
        firstApp.db._resetDmPeerPinsForTests();   // a fresh app session: nothing of the name's pins held in memory
        const warn = quiet();
        await expect(follow()).rejects.toThrow('Nothing has changed');
        expect(stored(ANCHOR)).toBe(FROM);
        for (const [k, v] of Object.entries(keys)) expect(stored(k), k).toBe(v);

        expect(await firstApp.db.resetDmChatMemory(TO)).toBe('set-aside');
        expect(await follow()).toBe('moved-kept-both');
        warn.mockRestore();
        expect(pinOf(TO_FILE)?.peer).toBe(peer.publicKey);
        const app = await afterAFreshStart();
        await heldBackAtTheName(app, peer.publicKey);
        await app.db.closeDB();
    });
});

describe('another account\'s keys under the new name are never touched (confirmation 2 of #2138, :89)', () => {
    it('X\'s pins and guard list under the new name stay, and so does the current account\'s own set-aside there', async () => {
        const x = 'cd'.repeat(32);
        const xPins = JSON.stringify({ pins: { 'x-dm': { peer: 'ef'.repeat(32), since: '2026-08-01T00:00:00.000Z', by: 'member' } } });
        h.store.set(dmPeerPinsStoreKey(x, TO_FILE), xPins);
        h.store.set(dmConversationsSeenStoreKey(x, TO_FILE), '["x-dm"]');
        h.store.set(dmPeerPinsSetAsideStoreKey(me.publicKey, TO_FILE), '{"pins":{"set aside at the name":1}}');
        const { keys } = await phoneAtTheNumber();
        expect(await follow()).toBe('moved');

        expect(stored(dmPeerPinsStoreKey(x, TO_FILE))).toBe(xPins);
        expect(stored(dmConversationsSeenStoreKey(x, TO_FILE))).toBe('["x-dm"]');
        expect(stored(dmPeerPinsSetAsideStoreKey(me.publicKey, TO_FILE)), 'the name\'s own set-aside is kept').toBe('{"pins":{"set aside at the name":1}}');
        expect(stored(dmPeerPinsSetAsideStoreKey(me.publicKey, FROM_FILE)), 'and the number\'s, where it was').toBe(keys[dmPeerPinsSetAsideStoreKey(me.publicKey, FROM_FILE)]);
        expect(pinOf(TO_FILE)?.peer).toBe(peer.publicKey);
    });
});

describe('a failure part way leaves the phone where it was, with everything', () => {
    it('the copy fails: the phone stays at the number with its copy, pins and cursors, and the next tap carries everything', async () => {
        const { before, keys } = await phoneAtTheNumber();
        h.failMoveOf = FROM_FILE;
        const warn = quiet();
        await expect(follow()).rejects.toThrow('Nothing has changed');
        warn.mockRestore();
        expect(stored(ANCHOR)).toBe(FROM);
        expect(fs.existsSync(file(TO_FILE))).toBe(false);
        expect(fs.existsSync(file(`${TO_FILE}-carry`))).toBe(false);
        for (const [k, v] of Object.entries(keys)) expect(stored(k), k).toBe(v);
        expect(await rowsHeld(), 'the number opens its own copy again').toEqual(before);

        h.failMoveOf = null;
        expect(await follow()).toBe('moved');
        expect(await rowsHeld()).toEqual(before);
        expect(pinOf(TO_FILE)?.peer).toBe(peer.publicKey);
    });

    it('a key\'s copy fails part way: nothing of the number\'s changes, and the next tap carries everything', async () => {
        const { before, keys } = await phoneAtTheNumber();
        h.failSetPrefix = dmConversationsSeenStoreKey(me.publicKey, TO_FILE);
        const warn = quiet();
        await expect(follow()).rejects.toThrow('Nothing has changed');
        warn.mockRestore();
        expect(stored(ANCHOR)).toBe(FROM);
        expect(fs.existsSync(file(FROM_FILE))).toBe(true);
        for (const [k, v] of Object.entries(keys)) expect(stored(k), k).toBe(v);

        expect(await follow()).toBe('moved');
        expect(await rowsHeld()).toEqual(before);
        expect(stored(dmConversationsSeenStoreKey(me.publicKey, TO_FILE))).toBe(keys[dmConversationsSeenStoreKey(me.publicKey, FROM_FILE)]);
    });

    it('the address write fails: the number keeps its whole copy (its group chats\' highest epoch with it), nothing is left at the name, and "Nothing has changed" is so', async () => {
        const { before, keys } = await phoneAtTheNumber();
        h.failSetPrefix = ANCHOR;
        const warn = quiet();
        await expect(follow()).rejects.toThrow('Nothing has changed');
        warn.mockRestore();
        expect(stored(ANCHOR)).toBe(FROM);
        expect(fs.existsSync(file(TO_FILE)), 'the copy put at the name went again').toBe(false);
        for (const id of ['last-sync', 'identity-epoch', 'nearby_area']) expect(stored(cursor(TO_FILE, id)), id).toBe(null);
        for (const [k, v] of Object.entries(keys)) expect(stored(k), k).toBe(v);

        // The app starts again at the number: the copy there is whole.
        const app = await startedAgain();
        expect(await rowsHeld(app)).toEqual(before);
        expect((await app.db.groupKeyStore(FROM).load('g-beans')).highest).toBe(7);

        expect(await follow(app)).toBe('moved');
        expect(await rowsHeld(app)).toEqual(before);
        const other = await nodeListsAnotherKey(app);
        expect(pinOf(TO_FILE)?.peer).toBe(peer.publicKey);
        expect((await app.db.getDmKeyChange(dm.id))?.offeredPeer).toBe(other.publicKey);
        await app.db.closeDB();
    });
});

describe('a stop at any write leaves the old address with everything, or the new address with everything (confirmation 2 of #2138, :106)', () => {
    /** What the phone has at the address it starts at, after a stop at write `n` and a fresh start. */
    async function checkAfterStop(n: number, app: App, before: Record<string, unknown[]>, keys: Record<string, string | null>, keptBoth: boolean): Promise<'number' | 'name'> {
        const at = stored(ANCHOR);
        expect([FROM, TO], `stop at write ${n}: the phone is at one of the two addresses`).toContain(at);
        const url = at!;
        const fileName = url === FROM ? FROM_FILE : TO_FILE;
        const label = `stop at write ${n}, at ${url}`;
        expect(fs.existsSync(file(fileName)), `${label}: its copy is there`).toBe(true);
        if (url === FROM || !keptBoth) {
            expect(await rowsHeld(app), `${label}: the number's copy, row for row`).toEqual(before);
            // Every key the number had, cursors included, under the name the phone is at.
            for (const [k, v] of Object.entries(keys)) expect(stored(k.replace(FROM_FILE, fileName)), `${label}: ${k}`).toBe(v);
        } else {
            expect(JSON.parse(stored(dmConversationsSeenStoreKey(me.publicKey, TO_FILE))!), `${label}: the guard list`).toContain(dm.id);
            expect(stored(cursor(TO_FILE, 'last-sync')), `${label}: the name's own cursors`).toBe('1700000000000');
        }
        const groups = app.db.groupKeyStore(url);
        expect((await groups.load('g-beans')).highest, `${label}: the group chat's highest epoch`).toBe(7);
        expect((await groups.load('g-locked')).epochs[0]?.wrap, `${label}: its sticky lock`).toEqual({ w: 'mine' });
        expect(pinOf(fileName)?.peer, `${label}: the DM's pin`).toBe(peer.publicKey);
        const other = await nodeListsAnotherKey(app);
        expect(pinOf(fileName)?.peer, `${label}: no seed ran`).toBe(peer.publicKey);
        expect((await app.db.getDmKeyChange(dm.id))?.offeredPeer, `${label}: another key held back as an offer`).toBe(other.publicKey);
        return url === FROM ? 'number' : 'name';
    }

    async function stopAtEachWrite(keptBoth: boolean): Promise<{ number: number; name: number; writes: number }> {
        const seen = { number: 0, name: 0, writes: 0 };
        for (let n = 1; ; n++) {
            newPhone();
            const app = await startedAgain();
            if (keptBoth) await phoneWasAtTheName(app);
            const { before, keys } = await phoneAtTheNumber(app);
            const warn = quiet();
            h.writes = 0;
            h.stopAt = n;
            await follow(app).catch(() => {});
            await settle();
            const reached = h.writes;
            h.stopAt = null;
            h.stopped = false;
            await app.db.closeDB();
            const again = await startedAgain();
            seen[await checkAfterStop(n, again, before, keys, keptBoth)]++;
            await again.db.closeDB();
            warn.mockRestore();
            if (reached < n) {
                seen.writes = reached;
                return seen;
            }
        }
    }

    it('following to a name the phone has no copy for', async () => {
        const seen = await stopAtEachWrite(false);
        // Both outcomes are reached, and the last run (no stop) ends at the name.
        expect(seen.number).toBeGreaterThan(5);
        expect(seen.name).toBeGreaterThan(1);
        expect(stored(ANCHOR)).toBe(TO);
    }, 180_000);

    it('following to a name the phone already has a copy for', async () => {
        const seen = await stopAtEachWrite(true);
        expect(seen.number).toBeGreaterThan(3);
        expect(seen.name).toBeGreaterThan(1);
        expect(stored(ANCHOR)).toBe(TO);
    }, 180_000);
});

describe('the move and the writers take the sync lock in one order (confirmation 2 of #2138, db.ts:229)', () => {
    const within = <T>(p: Promise<T>, ms = 3000) => Promise.race([p.then(() => 'settled' as const), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

    it('a writer held between the sync lock and its getDb while the move starts: both settle, and every later getDb', async () => {
        await phoneAtTheNumber();
        await firstApp.db.closeDB();
        const app = await startedAgain();   // its one-time rename not run yet: the gate below holds it
        let open!: () => void;
        h.gate = { key: CACHE_NAMES_DONE_KEY, wait: new Promise<void>((r) => { open = r; }) };
        const write = app.db.applyDelta({});
        await settle();
        const move = app.reconnect.switchPhoneTo(TO, FROM);
        await settle();
        open();
        h.gate = null;
        expect(await within(Promise.all([write, move]))).toBe('settled');
        expect(stored(ANCHOR)).toBe(TO);
        expect(await within(app.db.getDb())).toBe('settled');
        expect(pinsOf(TO_FILE)[dm.id.toLowerCase()]?.peer).toBe(peer.publicKey);
        await app.db.closeDB();
    });

    it.each([0, 1, 2, 3])('the move starting %i microtask(s) after a writer took the lock: both settle', async (ticks) => {
        await phoneAtTheNumber();
        await firstApp.db.closeDB();
        const app = await startedAgain();
        await app.db.getDb();
        const write = app.db.applyDelta({});
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        // The move as switchPhoneTo runs it, started at once (switchPhoneTo first loads db.ts, which takes longer).
        const move = app.db.whileCopyMoves(TO, () => app.carry.carryCommunityCopy(FROM, TO, () => AsyncStorage.setItem(ANCHOR, TO)));
        expect(await within(Promise.all([write, move]))).toBe('settled');
        expect(stored(ANCHOR)).toBe(TO);
        expect(await within(app.db.getDb())).toBe('settled');
        await app.db.closeDB();
    });
});

describe('every key kept per community file goes with it', () => {
    it('each storage-keys.ts key of an account and a file is in PER_FILE_STORE_KEYS', () => {
        const src = fs.readFileSync(path.join(__dirname, '../storage-keys.ts'), 'utf8');
        const perFile = [...src.matchAll(/export function (\w+)\(publicKey: string, file: string\)/g)].map((m) => m[1]);
        expect(perFile.length).toBeGreaterThanOrEqual(5);
        const list = /export const PER_FILE_STORE_KEYS[\s\S]*?= \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
        expect(list.split(',').map((s) => s.trim()).filter(Boolean).sort()).toEqual([...perFile].sort());
    });

    it('and each has its add-only way into a copy at the new name (community-copy-carry.ts MERGES)', () => {
        for (const keyOf of PER_FILE_STORE_KEYS) expect(MERGES.has(keyOf), keyOf.name).toBe(true);
        expect(MERGES.size).toBe(PER_FILE_STORE_KEYS.length);
    });
});
