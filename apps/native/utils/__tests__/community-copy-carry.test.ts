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
 * the same community: address-follow.test.ts checks those).
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
    /** A file name whose move throws (the phone stopped, the disk busy). */
    failMoveOf: null as string | null,
    /** A key prefix whose next write throws once. */
    failSetPrefix: null as string | null,
}));

/** expo-sqlite over node:sqlite, opening files in this test's directory, as expo-sqlite opens them in its own. */
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
/** expo-file-system over the real files. */
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        cacheDirectory: `file://${h.dir}/cache/`,
        EncodingType: { Base64: 'base64' },
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)) })),
        moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
            if (h.failMoveOf && local(from).endsWith(h.failMoveOf)) throw new Error('disk busy');
            nodeFs.renameSync(local(from), local(to));
        }),
        deleteAsync: vi.fn(async (uri: string) => { nodeFs.rmSync(local(uri), { force: true }); }),
        makeDirectoryAsync: vi.fn(async (uri: string) => { nodeFs.mkdirSync(local(uri), { recursive: true }); }),
        writeAsStringAsync: vi.fn(async (uri: string, data: string) => { nodeFs.writeFileSync(local(uri), data); }),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => {
            if (h.failSetPrefix && k.startsWith(h.failSetPrefix)) { h.failSetPrefix = null; throw new Error('the app stopped'); }
            h.store.set(k, String(v));
        }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
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
import { closeDB, getDb, getDmKeyChange, groupKeyStore, syncMessages, _resetDmPeerPinsForTests } from '../db';
import { acceptAddressFollow, addressFollowOffer, forgetFollowChecks, type AddressFollowDeps, type CommunityIdentity } from '../address-follow';
import { switchPhoneTo } from '../reconnect';
import { addSavedNode, getDatabaseFilenameForNode, getSavedNodes, isGuestNode, markGuestNode, removeSavedNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import {
    dmConversationsSeenSetAsideStoreKey, dmConversationsSeenStoreKey, dmLinesAtUpdateStoreKey, dmPeerPinsSetAsideStoreKey, dmPeerPinsStoreKey,
} from '../storage-keys';
import type { NodeProfile } from '../node-profile';

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

beforeEach(async () => {
    await closeDB();
    _resetDmPeerPinsForTests();
    forgetFollowChecks();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.failMoveOf = null;
    h.failSetPrefix = null;
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(ANCHOR, FROM);
    me = person();
    peer = person();
    h.me = { publicKey: me.publicKey, privateKey: me.privateKey };
    dm = { id: randomUUID(), type: 'dm', participants: [me.publicKey, peer.publicKey] };
    node.convs = [dm];
    (globalThis as any).fetch = fetchMock;
});

const file = (name: string) => path.join(h.dir, name);
const stored = (key: string) => h.store.get(key) ?? null;
const pinOf = (fileName: string) => JSON.parse(stored(dmPeerPinsStoreKey(me.publicKey, fileName)) ?? '{"pins":{}}').pins?.[dm.id.toLowerCase()];
const cursor = (fileName: string, id: string) => `pillar_sync_${fileName}_${id}`;

/** Every row of the tables the move must keep, as the copy open now holds them. */
async function rowsHeld(): Promise<Record<string, unknown[]>> {
    const db = await getDb();
    const out: Record<string, unknown[]> = {};
    for (const t of ['conversations', 'conversation_participants', 'messages', 'group_chat_key_state']) {
        out[t] = (await db.getAllAsync(`SELECT * FROM ${t} ORDER BY 1, 2`)).map((r) => ({ ...(r as object) }));
    }
    return out;
}

/**
 * The phone at the community's number, as the member has used it: the DM synced and pinned to `peer` (the real sync),
 * a group chat's highest epoch at 7, sync cursors, and what the member's resets set aside (another account on this
 * phone too: its pins are kept when it leaves, storage-keys.ts).
 */
async function phoneAtTheNumber(): Promise<{ before: Record<string, unknown[]>; keys: Record<string, string | null> }> {
    await syncMessages(me.publicKey);
    expect(pinOf(FROM_FILE)?.peer, 'precondition: the real sync pinned the DM').toBe(peer.publicKey);
    expect(stored(dmConversationsSeenStoreKey(me.publicKey, FROM_FILE)), 'precondition: the DM guard list holds it').toContain(dm.id);
    await groupKeyStore(FROM).raiseHighest('g-beans', 7);
    h.store.set(cursor(FROM_FILE, 'last-sync'), '1760000000000');
    h.store.set(cursor(FROM_FILE, 'identity-epoch'), '2');
    h.store.set(cursor(FROM_FILE, 'nearby_area'), '{"lat":-28.5}');
    h.store.set(dmPeerPinsSetAsideStoreKey(me.publicKey, FROM_FILE), '{"pins":{"old":1}}');
    h.store.set(dmConversationsSeenSetAsideStoreKey(me.publicKey, FROM_FILE), '["old"]');
    h.store.set(dmLinesAtUpdateStoreKey(me.publicKey, FROM_FILE), '{}');
    h.store.set(dmPeerPinsStoreKey('ab'.repeat(32), FROM_FILE), '{"pins":{}}');
    const keys: Record<string, string | null> = {};
    for (const k of h.store.keys()) if (k.includes(FROM_FILE)) keys[k] = stored(k);
    return { before: await rowsHeld(), keys };
}

function deps(): AddressFollowDeps {
    return {
        anchor: async () => AsyncStorage.getItem(ANCHOR),
        profile: async () => PROFILE,
        statement: async () => COMMUNITY,
        now: () => Date.now(),
        switchTo: switchPhoneTo,
        savedNodes: getSavedNodes,
        addSavedNode,
        removeSavedNode,
        isGuestNode,
        markGuestNode,
    };
}

async function follow() {
    const offer = await addressFollowOffer(deps());
    expect(offer, 'precondition: the move is offered').toEqual({ from: FROM, to: TO, host: 'beans.example.org' });
    return acceptAddressFollow(offer!, deps());
}

/** The node lists another key for the DM: the pin must hold it back as an offer, never take it. */
async function nodeListsAnotherKey(): Promise<Person> {
    const other = person();
    dm.participants = [me.publicKey, other.publicKey];
    await syncMessages(me.publicKey);
    return other;
}

describe('"Use the new address" carries the community\'s copy and what guards its chats', () => {
    it('the same rows under the new name, the old file gone, every per-file key under the new name, the cursors moved', async () => {
        const { before, keys } = await phoneAtTheNumber();
        expect(await follow()).toBe('moved');
        expect(stored(ANCHOR)).toBe(TO);

        expect(fs.existsSync(file(FROM_FILE)), 'the old file is gone').toBe(false);
        for (const side of ['-wal', '-shm', '-journal']) expect(fs.existsSync(file(`${FROM_FILE}${side}`))).toBe(false);
        expect(fs.existsSync(file(TO_FILE))).toBe(true);
        expect(await rowsHeld(), 'the copy open now is the old one, row for row').toEqual(before);

        for (const [k, v] of Object.entries(keys)) {
            const moved = k.replace(FROM_FILE, TO_FILE);
            expect(stored(moved), moved).toBe(v);
            // The pins and the guard list stay under the old name too (only the member's reset removes a pin); the
            // cursors don't, so the old name never has cursors without its file.
            expect(stored(k), k).toBe(k.startsWith('pillar_sync_') ? null : v);
        }
    });

    it('the group chat\'s highest epoch is read under the new address', async () => {
        await phoneAtTheNumber();
        expect(await follow()).toBe('moved');
        expect((await groupKeyStore(TO).load('g-beans')).highest).toBe(7);
    });

    it('the pins\' seed does not run again: a node listing another key for the DM after the move is held back, as before it', async () => {
        await phoneAtTheNumber();
        expect(await follow()).toBe('moved');
        _resetDmPeerPinsForTests();   // and after the app starts again
        const other = await nodeListsAnotherKey();
        expect(pinOf(TO_FILE)?.peer).toBe(peer.publicKey);
        expect((await getDmKeyChange(dm.id))?.offeredPeer).toBe(other.publicKey);
    });

    it('a copy already under the new address\'s name is left untouched, and the result and the log say both were kept', async () => {
        const { before } = await phoneAtTheNumber();
        const theirs = new DatabaseSync(file(TO_FILE));
        theirs.exec("CREATE TABLE planted (x TEXT); INSERT INTO planted VALUES ('the phone was here before');");
        theirs.close();
        h.store.set(dmPeerPinsStoreKey(me.publicKey, TO_FILE), '{"pins":{}}');
        h.store.set(cursor(TO_FILE, 'last-sync'), '1700000000000');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const moves = vi.mocked(FileSystem.moveAsync).mock.calls.length;

        expect(await follow()).toBe('moved-kept-both');
        expect(vi.mocked(FileSystem.moveAsync).mock.calls.length, 'nothing renamed over it').toBe(moves);
        expect(warn.mock.calls.some((c) => String(c[0]).includes('already has a copy') && String(c[0]).includes(TO_FILE))).toBe(true);
        warn.mockRestore();

        expect(stored(ANCHOR)).toBe(TO);
        const db = await getDb();
        expect(await db.getAllAsync('SELECT x FROM planted')).toEqual([{ x: 'the phone was here before' }]);
        expect(stored(dmPeerPinsStoreKey(me.publicKey, TO_FILE)), 'nothing carried over its pins').toBe('{"pins":{}}');
        expect(stored(cursor(TO_FILE, 'last-sync'))).toBe('1700000000000');
        // The old copy stays whole, under its own name, with its keys.
        expect(fs.existsSync(file(FROM_FILE))).toBe(true);
        expect(pinOf(FROM_FILE)?.peer).toBe(peer.publicKey);
        expect(stored(cursor(FROM_FILE, 'last-sync'))).toBe('1760000000000');
        await closeDB();
        const old = new DatabaseSync(file(FROM_FILE));
        expect(old.prepare('SELECT id FROM conversations').all().map((r: any) => r.id)).toEqual((before.conversations as any[]).map((r) => r.id));
        old.close();
    });
});

describe('a crash part way never leaves the phone at the new address without its pins', () => {
    it('the rename fails: the phone stays at the number with its copy, pins and cursors, and the next tap carries everything', async () => {
        const { before, keys } = await phoneAtTheNumber();
        h.failMoveOf = FROM_FILE;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(follow()).rejects.toThrow('Nothing has changed');
        warn.mockRestore();
        expect(stored(ANCHOR)).toBe(FROM);
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
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(follow()).rejects.toThrow('Nothing has changed');
        warn.mockRestore();
        expect(stored(ANCHOR)).toBe(FROM);
        expect(fs.existsSync(file(FROM_FILE))).toBe(true);
        for (const [k, v] of Object.entries(keys)) expect(stored(k), k).toBe(v);

        expect(await follow()).toBe('moved');
        expect(await rowsHeld()).toEqual(before);
        expect(stored(dmConversationsSeenStoreKey(me.publicKey, TO_FILE))).toBe(keys[dmConversationsSeenStoreKey(me.publicKey, FROM_FILE)]);
    });

    it('stopped after the rename, before the address: the number keeps its pins (no seed there), and the next tap uses the carried copy', async () => {
        const { before, keys } = await phoneAtTheNumber();
        const pinsThen = keys[dmPeerPinsStoreKey(me.publicKey, FROM_FILE)];
        h.failSetPrefix = ANCHOR;
        await expect(follow()).rejects.toThrow('the app stopped');
        expect(stored(ANCHOR)).toBe(FROM);
        expect(fs.existsSync(file(TO_FILE))).toBe(true);

        // The app starts again at the number: an empty copy there, but its pins are where they were, so no seed runs.
        await closeDB();
        _resetDmPeerPinsForTests();
        expect((await rowsHeld()).conversations).toEqual([]);
        await syncMessages(me.publicKey);
        expect(stored(dmPeerPinsStoreKey(me.publicKey, FROM_FILE))).toBe(pinsThen);

        // The next tap finds the carried copy under the new name, with its keys.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await follow()).toBe('moved-kept-both');
        warn.mockRestore();
        expect(stored(ANCHOR)).toBe(TO);
        expect(await rowsHeld()).toEqual(before);
        const other = await nodeListsAnotherKey();
        expect(pinOf(TO_FILE)?.peer).toBe(peer.publicKey);
        expect((await getDmKeyChange(dm.id))?.offeredPeer).toBe(other.publicKey);
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
});
