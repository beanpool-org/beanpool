/**
 * The held copies (utils/held-copies.ts, wired in utils/db.ts) through the real database: every path that closes, clears,
 * moves or deletes a community's copy, each with a held read of another community's chats in flight (slice S1, the probe's
 * conditions: scratch/walks/RESULT-s1-second-handle-probe.md "Verdict").
 *
 * Each row asserts that the path waits for the read (never closes the handle under it: on a phone that read's promise
 * never settles), that the read in flight comes back with that community's own rows, that no held handle is left on a
 * file the path made the copy in use, moved or deleted, and that a held read afterwards never reads a deleted or moved
 * copy, nor makes its file again. Then the rules on their own: never a missing file, never the community in use, only a
 * copy that has synced, only Talk's own chats, every photo on that community's server, and every held handle query_only
 * from before its first read.
 *
 * Real SQLite files on disk (node:sqlite, in a directory of this test's own), as expo-sqlite opens them; a held read can
 * be held open by the test (it is a read on a connection the app made with `PRAGMA query_only = 1`).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const h = vi.hoisted(() => ({
    dir: '',
    store: new Map<string, string>(),
    me: 'a1'.repeat(32),
    /** Every open: its file, and the SQL run on it before its first read. */
    opens: [] as Array<{ file: string; beforeFirstRead: string[] | null; queryOnly: boolean; handle?: any }>,
    /** A held read the test holds: the file it is for, told when it starts, let go by the test. */
    gate: null as null | { file: string; started: () => void; release: Promise<void> },
    /** Handles closed while a read was in flight on them (on a phone, that read never settles). */
    cutMidRead: [] as string[],
    /** The next native close of a held handle on this file, held by the test (on a phone: EXCLUSIVE, a checkpoint, -wal and -shm unlinked). */
    closeGate: null as null | { file: string; started: () => void; release: Promise<void> },
    /** The next read of this storage key, held by the test (a list on its way to a community's copy). */
    getGate: null as null | { key: string; started: () => void; release: Promise<void> },
    /** In order: each held handle's native close once done ("held closed <file>") and each file deleted ("deleted <name>"). */
    log: [] as string[],
    /** The keys this account blocked (utils/blocklist.ts). */
    blocked: [] as string[],
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            const open = { file: name, beforeFirstRead: [] as string[] | null, queryOnly: false };
            h.opens.push(open);
            let inFlight = 0;
            let closed = false;
            const read = async <T,>(run: () => T): Promise<T> => {
                if (closed) throw new Error('read on a closed handle');
                open.beforeFirstRead = null;
                inFlight++;
                try {
                    if (open.queryOnly && h.gate && h.gate.file === name) {
                        const g = h.gate;
                        h.gate = null;
                        g.started();
                        await g.release;
                        if (closed) throw new Error('cut by a close: on a phone this read never settles');
                    }
                    return run();
                } finally {
                    inFlight--;
                }
            };
            const handle = {
                runAsync: async (q: string, p?: unknown) => {
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                execAsync: async (q: string) => {
                    open.beforeFirstRead?.push(q);
                    if (/query_only\s*=\s*1/i.test(q)) open.queryOnly = true;
                    sql.exec(q);
                },
                getAllAsync: (q: string, p?: unknown) => read(() => sql.prepare(q).all(...params(p))),
                getFirstAsync: async (q: string, p?: unknown) => {
                    if (/^\s*PRAGMA\s+user_version\s*$/i.test(q)) return sql.prepare(q).get() ?? null;
                    return read(() => sql.prepare(q).get(...params(p)) ?? null);
                },
                withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
                closeAsync: async () => {
                    if (inFlight > 0) h.cutMidRead.push(name);
                    if (open.queryOnly && h.closeGate && h.closeGate.file === name) {
                        const g = h.closeGate;
                        h.closeGate = null;
                        g.started();
                        await g.release;
                    }
                    closed = true;
                    sql.close();
                    if (open.queryOnly) h.log.push(`held closed ${name}`);
                },
            };
            (open as any).handle = handle;
            return handle;
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
        deleteAsync: vi.fn(async (uri: string) => {
            if (nodeFs.existsSync(local(uri))) h.log.push(`deleted ${local(uri).split('/').pop()}`);
            nodeFs.rmSync(local(uri), { force: true, recursive: true });
        }),
        makeDirectoryAsync: vi.fn(async (uri: string) => { nodeFs.mkdirSync(local(uri), { recursive: true }); }),
        writeAsStringAsync: vi.fn(async (uri: string, data: string) => { nodeFs.writeFileSync(local(uri), data); }),
        readAsStringAsync: vi.fn(async (uri: string) => (nodeFs.existsSync(local(uri)) ? nodeFs.readFileSync(local(uri), 'utf8') : '')),
        readDirectoryAsync: vi.fn(async (uri: string) => (nodeFs.existsSync(local(uri)) ? nodeFs.readdirSync(local(uri)) : [])),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => {
            if (h.getGate && h.getGate.key === k) {
                const g = h.getGate;
                h.getGate = null;
                g.started();
                await g.release;
            }
            return h.store.get(k) ?? null;
        }),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: h.me, privateKey: '00'.repeat(32), callsign: 'Me' })) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => {}) }));
vi.mock('../blocklist', () => ({ getBlockedUsers: vi.fn(async () => h.blocked) }));

import * as db from '../db';
import { heldChatRows, heldChatsInView, heldChatsShown } from '../held-chats';
import { forgetCommunityCopy, removeCommunityCaches } from '../community-cache';
import { writeDmPeerPins } from '../dm-peer-pins';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { switchPhoneTo } from '../reconnect';
import { getDatabaseFilenameForNode } from '../nodes';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';
import { syncedCursorKeyOf } from '../../services/pillar-sync';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';

// A switch ends with require('react-native') for a nudge: answered at node's loader for the file.
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) }, Platform: { OS: 'android' } };
    return realLoad.call(this, request, ...rest);
};

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-held-paths-'));
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(root, { recursive: true, force: true });
});

const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const C = 'https://brookside.example';
const A_FILE = getDatabaseFilenameForNode(A);
const B_FILE = getDatabaseFilenameForNode(B);
const C_FILE = getDatabaseFilenameForNode(C);
const ANCHOR = 'beanpool_anchor_url';
const PEER = 'b2'.repeat(32);
const STRANGER = 'c3'.repeat(32);
const exists = (file: string) => fs.existsSync(path.join(h.dir, file));
const ticks = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** The chats seeded into B's copy, as a sync there wrote them: a DM, a deal chat, a group's chat and a request. */
function seedB(file: string) {
    const sql = new DatabaseSync(path.join(h.dir, file));
    try {
        sql.exec(`
            INSERT INTO members (public_key, callsign, avatar_url, profile_updated_at) VALUES ('${PEER}', 'Kai', '/uploads/kai.jpg', '2026-11-18T00:00:00.000Z');
            INSERT INTO members (public_key, callsign) VALUES ('${STRANGER}', 'Rowan');
            INSERT INTO conversations (id, type) VALUES ('b-dm', 'dm');
            INSERT INTO conversations (id, type, post_id, post_title, post_photo) VALUES ('b-deal', 'dm', 'post-1', 'Ladder', '["/uploads/ladder.jpg"]');
            INSERT INTO conversations (id, type) VALUES ('b-group', 'group_thread');
            INSERT INTO conversations (id, type, request) VALUES ('b-request', 'dm', '{"from":"${STRANGER}","state":"pending"}');
            INSERT INTO conversation_participants (conversation_id, public_key) VALUES ('b-dm', '${h.me}'), ('b-dm', '${PEER}'),
                ('b-deal', '${h.me}'), ('b-deal', '${PEER}'), ('b-group', '${h.me}'), ('b-group', '${PEER}'),
                ('b-request', '${h.me}'), ('b-request', '${STRANGER}');
            INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp) VALUES
                ('m1', 'b-dm', '${PEER}', 'x', 'n', '2026-11-18T10:00:00.000Z'),
                ('m2', 'b-deal', '${h.me}', 'x', 'n', '2026-11-18T09:00:00.000Z');
        `);
    } finally {
        sql.close();
    }
}

/** A phone on A that holds B's copy (synced: its cursor kept) and knows C (no copy on the phone). */
async function phoneOnAHoldingB(): Promise<void> {
    await db.closeDB();
    h.dir = path.join(root, `phone-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    h.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: A }, { url: B, alias: 'Hilltop' }, { url: C, alias: 'Brookside' }]));
    // B's copy, made as the phone makes a copy (its schema, its number), then closed: the phone moves on to A.
    h.store.set(ANCHOR, B);
    await db.getDb();
    await db.closeDB();
    seedB(B_FILE);
    h.store.set(syncedCursorKeyOf(B_FILE), String(Date.parse('2026-11-18T11:00:00.000Z')));
    h.store.set(ANCHOR, A);
    await db.getDb();
    h.opens.length = 0;
    h.cutMidRead.length = 0;
    h.gate = null;
    h.closeGate = null;
    h.getGate = null;
    h.log.length = 0;
    h.blocked = [];
}

/** Hold the next native close of `file`'s held handle. */
function holdHeldClose(file: string) {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    h.closeGate = { file, started, release: new Promise<void>((r) => { release = r; }) };
    return { started: startedP, release };
}

/** Hold the next read of storage `key`. */
function holdStorageRead(key: string) {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    h.getGate = { key, started, release: new Promise<void>((r) => { release = r; }) };
    return { started: startedP, release };
}

/** Hold the next read on `file`'s held handle. */
function holdHeldRead(file: string) {
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    h.gate = { file, started, release: new Promise<void>((r) => { release = r; }) };
    return { started: startedP, release };
}

const ids = (rows: Array<{ id: string }> | null) => (rows ? rows.map((r) => r.id).sort() : null);
const B_CHATS = ['b-deal', 'b-dm'];

interface PathRow {
    name: string;
    act: () => Promise<unknown>;
    /** What a held read of B finds afterwards: its chats, or none (B in use now, or gone). */
    after: 'B held' | 'B in use' | 'B gone';
}

const PATHS: PathRow[] = [
    { name: 'closeDB (Sign Out, a join, a switch\'s own close)', act: () => db.closeDB(), after: 'B held' },
    { name: 'clearDB (Force Resync of the community in use)', act: () => db.clearDB(), after: 'B held' },
    { name: 'switchPhoneTo another community (C)', act: () => switchPhoneTo(C), after: 'B held' },
    { name: 'switchPhoneTo the held community itself (B)', act: () => switchPhoneTo(B), after: 'B in use' },
    { name: "getDb's own swap to the held community (the address written, no closeDB)", act: async () => { h.store.set(ANCHOR, B); await db.getDb(); }, after: 'B in use' },
    {
        name: 'whileCopyMoves, the copy in use carried to a new address',
        act: () => db.whileCopyMoves('https://riverside-new.example', async () => {
            fs.renameSync(path.join(h.dir, A_FILE), path.join(h.dir, getDatabaseFilenameForNode('https://riverside-new.example')));
            h.store.set(ANCHOR, 'https://riverside-new.example');
        }),
        after: 'B held',
    },
    {
        name: 'whileCopyMoves, the held copy itself moved away',
        act: () => db.whileCopyMoves('https://hilltop-new.example', async () => {
            fs.renameSync(path.join(h.dir, B_FILE), path.join(h.dir, getDatabaseFilenameForNode('https://hilltop-new.example')));
        }),
        after: 'B gone',
    },
    { name: 'removeCommunityCaches([B]) (Delete here, a second record\'s copy)', act: () => removeCommunityCaches([B]), after: 'B gone' },
    { name: 'removeCommunityCaches every copy (Sign Out)', act: () => removeCommunityCaches([A, B], { everyCopy: true }), after: 'B gone' },
    { name: 'forgetCommunityCopy(B) (Settings, Forget of a community the phone is not on)', act: () => forgetCommunityCopy(B), after: 'B gone' },
];

beforeEach(async () => {
    await phoneOnAHoldingB();
});

describe('held chats: every path that closes, clears, moves or deletes a copy, with a held read in flight', () => {
    for (const row of PATHS) {
        it(`${row.name}: waits for the read, which comes back with B's own chats; afterwards ${row.after}`, async () => {
            // The held handle is open (a first read), as Chat leaves it while it shows.
            expect(ids(await db.getHeldConversations(h.me, B))).toEqual(B_CHATS);
            const gate = holdHeldRead(B_FILE);
            const read = db.getHeldConversations(h.me, B);
            await gate.started;
            let pathDone = false;
            const going = row.act().finally(() => { pathDone = true; });
            await ticks();
            // Every row's path reaches B's held handle (a close, a clear, a switch, a move or a delete): none has gone past it.
            expect(pathDone).toBe(false);
            gate.release();
            expect(ids(await read)).toEqual(B_CHATS);
            await going;
            expect(h.cutMidRead).toEqual([]);
            // A held read now: B's chats while B is still a held copy, none once it is in use, moved or deleted.
            const again = await db.getHeldConversations(h.me, B);
            if (row.after === 'B held') expect(ids(again)).toEqual(B_CHATS);
            else expect(again).toBeNull();
            if (row.after === 'B gone') {
                // Never made again by an open: an open makes a file that isn't there.
                expect(exists(B_FILE)).toBe(false);
                expect(db.heldCopyFiles()).toEqual([]);
            }
            if (row.after === 'B in use') {
                // The copy in use is B's: no held handle shares its file.
                expect(db.heldCopyFiles()).not.toContain(B_FILE);
                expect(h.opens.filter((o) => o.file === B_FILE && o.queryOnly).length).toBe(1);
            }
            await db.closeHeldCopies();
        });
    }

    it('a held read asked while a delete is under way reads nothing and makes no file again', async () => {
        await db.getHeldConversations(h.me, B);
        const gate = holdHeldRead(B_FILE);
        const read = db.getHeldConversations(h.me, B);
        await gate.started;
        const removing = removeCommunityCaches([B]);
        await ticks();
        // The delete waits on the read in flight; one asked meanwhile is refused, never opened.
        const during = db.getHeldConversations(h.me, B);
        gate.release();
        await read;
        expect(await during).toBeNull();
        await removing;
        expect(exists(B_FILE)).toBe(false);
        expect(await db.getHeldConversations(h.me, B)).toBeNull();
        expect(exists(B_FILE)).toBe(false);
    });

    it('a held read asked while a copy moves is refused, and B\'s file is untouched by it', async () => {
        await db.getHeldConversations(h.me, B);
        let during: Promise<unknown> = Promise.resolve();
        await db.whileCopyMoves('https://riverside-new.example', async () => {
            during = db.getHeldConversations(h.me, B);
            await ticks();
        });
        expect(await during).toBeNull();
        expect(ids(await db.getHeldConversations(h.me, B))).toEqual(B_CHATS);
    });
});

describe('held chats: the rules on their own', () => {
    it('never opens a missing file: C is saved but has no copy, and none is made', async () => {
        expect(await db.getHeldConversations(h.me, C)).toBeNull();
        // C has no cursor either; with one, still no open of a file that isn't there.
        h.store.set(syncedCursorKeyOf(C_FILE), '1');
        expect(await db.getHeldConversations(h.me, C)).toBeNull();
        expect(exists(C_FILE)).toBe(false);
        expect(h.opens.filter((o) => o.file === C_FILE)).toEqual([]);
    });

    it('never the community in use: A, the copy in use, is never opened as a held copy, even with its cursor kept', async () => {
        h.store.set(syncedCursorKeyOf(A_FILE), '1');
        expect(await db.getHeldConversations(h.me, A)).toBeNull();
        expect(h.opens.filter((o) => o.file === A_FILE)).toEqual([]);
    });

    it('never the copy the phone is opening: a held read asked while the copy in use opens B finds none', async () => {
        h.store.set(ANCHOR, B);
        const opening = db.getDb();
        expect(await db.getHeldConversations(h.me, B)).toBeNull();
        await opening;
        expect(h.opens.filter((o) => o.file === B_FILE && o.queryOnly)).toEqual([]);
    });

    it('only a copy that has synced: with its cursor gone (a clear, a reset), B lists nothing', async () => {
        h.store.delete(syncedCursorKeyOf(B_FILE));
        expect(await db.getHeldConversations(h.me, B)).toBeNull();
        expect(h.opens.filter((o) => o.file === B_FILE)).toEqual([]);
    });

    it('every held handle is query_only before its first read, and a write through it fails', async () => {
        await db.getHeldConversations(h.me, B);
        const held = h.opens.filter((o) => o.file === B_FILE);
        expect(held.length).toBe(1);
        expect(held[0].queryOnly).toBe(true);
        // The very handle db.ts opened for B, written to past the module (as a slip in S2 could): SQLite refuses it.
        await expect(held[0].handle.runAsync("INSERT INTO conversations (id, type) VALUES ('written', 'dm')")).rejects.toThrow(/readonly/i);
        await expect(held[0].handle.execAsync("DELETE FROM messages")).rejects.toThrow(/readonly/i);
        // The file is untouched: what the held read listed is what was seeded.
        const sql = new DatabaseSync(path.join(h.dir, B_FILE));
        try {
            expect(sql.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 4 });
        } finally {
            sql.close();
        }
    });

    it("lists B's Talk chats only (no group's chat, no request for me), each photo on B's server, never the one in use", async () => {
        const rows = await db.getHeldConversations(h.me, B);
        expect(ids(rows)).toEqual(B_CHATS);
        const dm = rows!.find((r) => r.id === 'b-dm')!;
        const deal = rows!.find((r) => r.id === 'b-deal')!;
        expect(dm).toMatchObject({ peer: 'Kai', peerPubkey: PEER, peerKeys: [PEER], peerAvatar: `${B}/uploads/kai.jpg`, rawTimestamp: '2026-11-18T10:00:00.000Z' });
        expect(deal).toMatchObject({ postId: 'post-1', postTitle: 'Ladder', postPhoto: `${B}/uploads/ladder.jpg` });
        for (const r of rows!) {
            expect(JSON.stringify(r)).not.toContain(A);
        }
    });

    it("Chat's rows: every held community but the one in use, each under its saved name, and a key of its own", async () => {
        const rows = await heldChatRows(h.me);
        expect(rows.map((r) => [r.community, r.communityName, r.id]).sort()).toEqual([[B, 'Hilltop', 'b-deal'], [B, 'Hilltop', 'b-dm']]);
        expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
        expect(rows.every((r) => r.key.startsWith(`held:${B_FILE}:`))).toBe(true);
        // On B, A becomes the held one (it has no cursor kept here, so it lists nothing) and B's own rows are not held.
        await switchPhoneTo(B);
        expect(await heldChatRows(h.me)).toEqual([]);
    });

    it('a community visited as a guest is never opened', async () => {
        h.store.set('beanpool_guest_nodes', JSON.stringify([B]));
        expect(await heldChatRows(h.me)).toEqual([]);
        expect(h.opens.filter((o) => o.file === B_FILE)).toEqual([]);
    });

    it('a held handle is registered under its own file, never the anchor\'s: the DM pins and the DM guard read that file\'s', async () => {
        await db.getHeldConversations(h.me, B);
        const held = h.opens.filter((o) => o.file === B_FILE && o.queryOnly);
        expect(held.length).toBe(1);
        expect(db._fileOfHandleForTests(held[0].handle)).toBe(B_FILE);
        // And the copy in use is A's, under A's.
        expect(db._fileOfHandleForTests(await db.getDb())).toBe(A_FILE);
    });
});

describe('held chats: a second closer waits for a close under way (#3302 review F1, the reviewer\'s probe through the real database)', () => {
    it('Chat left (its close not awaited), then removeCommunityCaches([B]): B is deleted only once its held handle has closed', async () => {
        await db.getHeldConversations(h.me, B);
        const gate = holdHeldClose(B_FILE);
        // As chats.tsx does as Chat is left: the close is not awaited.
        void db.closeHeldCopies();
        await gate.started;
        const removing = removeCommunityCaches([B]);
        await ticks();
        // The delete waits for the held close under way: B is still there.
        expect(exists(B_FILE)).toBe(true);
        expect(h.log).toEqual([]);
        gate.release();
        await removing;
        expect(exists(B_FILE)).toBe(false);
        const closedAt = h.log.indexOf(`held closed ${B_FILE}`);
        expect(closedAt).toBe(0);
        expect(h.log.slice(1).every((x) => x.startsWith('deleted '))).toBe(true);
        expect(h.log).toContain(`deleted ${B_FILE}`);
    });

    it('Chat left (its close not awaited), then the copy in use opens B: B is opened as the copy in use only once its held handle has closed', async () => {
        await db.getHeldConversations(h.me, B);
        const gate = holdHeldClose(B_FILE);
        void db.closeHeldCopies();
        await gate.started;
        h.store.set(ANCHOR, B);
        const opening = db.getDb();
        await ticks();
        expect(h.opens.filter((o) => o.file === B_FILE && !o.queryOnly)).toEqual([]);
        gate.release();
        await opening;
        expect(h.log).toEqual([`held closed ${B_FILE}`]);
        expect(h.opens.filter((o) => o.file === B_FILE && !o.queryOnly).length).toBe(1);
    });
});

describe('held chats: Settings Forget goes through removeCommunityCaches (#3302 review F2)', () => {
    it('forgetCommunityCopy(B): its cursors, and its file with the WAL and its index, in expo-sqlite\'s own directory', async () => {
        await db.getHeldConversations(h.me, B);
        // B's copy as a stop can leave it: its -wal and -shm beside it (written with no connection open on B).
        await db.closeHeldCopies();
        fs.writeFileSync(path.join(h.dir, `${B_FILE}-wal`), '');
        fs.writeFileSync(path.join(h.dir, `${B_FILE}-shm`), '');
        await forgetCommunityCopy(B);
        for (const f of [B_FILE, `${B_FILE}-wal`, `${B_FILE}-shm`]) expect(exists(f), f).toBe(false);
        expect(h.store.has(syncedCursorKeyOf(B_FILE))).toBe(false);
        expect(db.heldCopyFiles()).toEqual([]);
        expect(h.cutMidRead).toEqual([]);
        // A, the copy in use, is untouched and opens again.
        expect(exists(A_FILE)).toBe(true);
        expect(await db.getHeldConversations(h.me, B)).toBeNull();
        expect(exists(B_FILE)).toBe(false);
    });

    it('both of Settings\' Forget branches delete through forgetCommunityCopy, and by no path of their own', () => {
        const settings = fs.readFileSync(path.join(__dirname, '..', '..', 'app', '(tabs)', 'settings.tsx'), 'utf8');
        const start = settings.indexOf('async function handleForgetNode(');
        const end = settings.indexOf('async function handleForceResync(');
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const forget = settings.slice(start, end);
        expect(forget.match(/forgetCommunityCopy\(targetUrl\)/g)?.length).toBe(2);
        expect(forget).not.toMatch(/deleteAsync|getDatabaseFilePaths|syncCursorKeysOf/);
        // The active one's copy goes only once the phone is off it: after the switch, never before.
        const active = forget.slice(0, forget.indexOf('t("Forget Community?")'));
        expect(active.indexOf('handleSwitchNode(remainingNodes[0].url)')).toBeLessThan(active.indexOf('forgetCommunityCopy(targetUrl)'));
    });
});

describe('held chats: no handle opened after Chat is left stays open (#3302 review F3)', () => {
    it('Chat left before its list reaches a community: that community\'s copy is never opened', async () => {
        const view = heldChatsInView();
        const listing = heldChatRows(h.me, view);
        await view.leave();
        expect(await listing).toEqual([]);
        expect(h.opens.filter((o) => o.file === B_FILE)).toEqual([]);
        expect(db.heldCopyFiles()).toEqual([]);
    });

    it('Chat left while its list is on its way to B: B\'s handle, opened after the close as Chat was left, closes as the list ends', async () => {
        const view = heldChatsInView();
        // The list is past its look at Chat, reading B's cursor, as Chat is left.
        const gate = holdStorageRead(syncedCursorKeyOf(B_FILE));
        const listing = heldChatRows(h.me, view);
        await gate.started;
        await view.leave();
        gate.release();
        await listing;
        // B was opened (after the close as Chat was left), and closed again as the list ended.
        expect(h.opens.filter((o) => o.file === B_FILE && o.queryOnly).length).toBe(1);
        expect(db.heldCopyFiles()).toEqual([]);
        expect(h.log).toEqual([`held closed ${B_FILE}`]);
    });

    it('Chat left and in view again before the old list ends: the handle the new view reads is not closed under it', async () => {
        const first = heldChatsInView();
        const gate = holdStorageRead(syncedCursorKeyOf(B_FILE));
        const listing = heldChatRows(h.me, first);
        await gate.started;
        await first.leave();
        const again = heldChatsInView();
        gate.release();
        await listing;
        expect(db.heldCopyFiles()).toEqual([B_FILE]);
        expect(ids(await heldChatRows(h.me, again))).toEqual(B_CHATS);
        await again.leave();
        expect(db.heldCopyFiles()).toEqual([]);
        // Left twice is left once.
        await again.leave();
        expect(db.heldCopyFiles()).toEqual([]);
    });
});

describe('held chats: the block filter, under every key the chat names the person by there (#3302 review F4)', () => {
    const OLD = 'd4'.repeat(32);
    const OFFERED = 'e5'.repeat(32);

    it('a DM blocked under a re-keyed person\'s old key, kept only in that file\'s pin, never shows as a held row', async () => {
        // B's pins: b-dm is pinned to the person's key now, their former key the one this member blocked. B's rows name only the new key.
        await writeDmPeerPins(AsyncStorage, h.me, B_FILE, { 'b-dm': { peer: PEER, since: '2026-11-18T00:00:00.000Z', by: 'listing', former: [OLD] } } as any);
        db._resetDmPeerPinsForTests();
        const rows = await db.getHeldConversations(h.me, B);
        expect(rows!.find((r) => r.id === 'b-dm')!.peerKeys.sort()).toEqual([OLD, PEER].sort());
        // b-deal has no pin: its rows' key only.
        expect(rows!.find((r) => r.id === 'b-deal')!.peerKeys).toEqual([PEER]);
        h.blocked = [OLD];
        expect((await heldChatsShown(h.me)).map((r) => r.id)).toEqual(['b-deal']);
        h.blocked = [];
        expect((await heldChatsShown(h.me)).map((r) => r.id).sort()).toEqual(B_CHATS);
    });

    it('and under the key it offered in a key change', async () => {
        await writeDmPeerPins(AsyncStorage, h.me, B_FILE, { 'b-dm': { peer: PEER, since: '2026-11-18T00:00:00.000Z', by: 'listing', offered: { peer: OFFERED, at: '2026-11-18T01:00:00.000Z' } } } as any);
        db._resetDmPeerPinsForTests();
        h.blocked = [OFFERED];
        expect((await heldChatsShown(h.me)).map((r) => r.id)).toEqual(['b-deal']);
    });

    it('a blocked key in the rows themselves hides the chat; no pins stored for that file: its rows\' keys, never a seed through the held handle', async () => {
        db._resetDmPeerPinsForTests();
        h.blocked = [PEER];
        expect(await heldChatsShown(h.me)).toEqual([]);
        // Nothing was written for B: a held read seeds no pins.
        expect([...h.store.keys()].some((k) => k.startsWith('beanpool_dm_peer_pins:') && k.endsWith(B_FILE))).toBe(false);
    });
});
