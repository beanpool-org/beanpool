import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// "About this listing" on the phone (core chat-about.ts; Marty, 9 Nov): Message on a listing leaves a chip; the next line carries
// the listing sealed beside its words, through the phone's real send path (utils/db.ts insertMessage) over its real schema in an
// in-memory SQLite, as dm-line-binding.test.ts does. The node is a stand-in that stores what it is sent. The other phone reads
// the line through getMessages; the web app reads the same bytes (apps/pwa MessagesPage.about.test.tsx and core chat-about.test.ts
// seal and open them the same way).

const h = vi.hoisted(() => ({
    cacheDir: '',
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dbs = new Map<string, any>();
    const dbFor = (name: string) => { let d = dbs.get(name); if (!d) dbs.set(name, (d = new DatabaseSync(':memory:'))); return d; };
    const nameOfUrl = (_url: string | null | undefined) => 'beanpool_mullum.beanpool.org.db';
    (globalThis as any).__phoneSql = new Proxy({}, { get: (_t, p) => { const d = dbFor(nameOfUrl(h.store.get('beanpool_anchor_url'))); const v = (d as any)[p]; return typeof v === 'function' ? v.bind(d) : v; } });
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    const adapterFor = (name: string) => {
        const sql = dbFor(name);
        return {
            runAsync: vi.fn(async (q: string, p?: unknown) => {
                const r = sql.prepare(q).run(...params(p));
                return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
            }),
            execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
            getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
            getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
            closeAsync: vi.fn(async () => {}),
            withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
        };
    };
    return { openDatabaseAsync: vi.fn(async (name: string) => adapterFor(name)) };
});
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const nodeOs = await import('node:os');
    const nodePath = await import('node:path');
    if (!h.cacheDir) h.cacheDir = nodeFs.mkdtempSync(nodePath.join(process.env.TMPDIR || nodeOs.tmpdir(), 'bp-chat-about-'));
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        cacheDirectory: `file://${h.cacheDir}/`,
        EncodingType: { Base64: 'base64' },
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)) })),
        deleteAsync: vi.fn(async (uri: string) => { nodeFs.rmSync(local(uri), { force: true }); }),
        makeDirectoryAsync: vi.fn(async (uri: string) => { nodeFs.mkdirSync(local(uri), { recursive: true }); }),
        writeAsStringAsync: vi.fn(async (uri: string, data: string) => { nodeFs.writeFileSync(local(uri), data); }),
        moveAsync: vi.fn(async () => {}),
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
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => 'unanswered') }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(() => 'beanpool_mullum.beanpool.org.db'), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { aboutOfPost, chatAboutDrafts } from '@beanpool/core';
import { getDb, getMessages, syncMessages, insertMessage, lookupAboutListing } from '../db';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';

const sql = (globalThis as any).__phoneSql as import('node:sqlite').DatabaseSync;

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => {
    (Module as any)._load = realLoad;
    fs.rmSync(h.cacheDir, { recursive: true, force: true });
});

const ANCHOR = 'https://mullum.beanpool.org';

interface Person { name: string; publicKey: string; privateKey: string }
function person(name: string): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { name, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

interface Line {
    id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string;
    type: string; systemType: string | null; metadata: string | null; timestamp: string; editedAt: string | null;
}
interface Conv { id: string; type: string; participants: string[] }
const node = {
    lines: [] as Line[],
    convs: [] as Conv[],
    refuseSends: false,
    /** The listings the node holds, by id; what it answers for `?id=`. */
    listings: [] as any[],
    /** The node answering the listing read with a failure. */
    listingsDown: false,
};
let clock = Date.parse('2026-10-01T09:00:00.000Z');
const tick = () => new Date(clock += 60_000).toISOString();

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

const fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    if (method === 'POST' && u.pathname === '/api/messages/send') {
        if (node.refuseSends) return answer(503, { error: 'Service unavailable' });
        const b = JSON.parse(init.body);
        const id = typeof b.id === 'string' ? b.id.toLowerCase() : randomUUID();
        // A resend of a line the node already holds is stored once, as the real node does.
        const had = node.lines.find((l) => l.id === id);
        if (had) return answer(200, { success: true, message: had });
        const line: Line = {
            id, conversationId: b.conversationId, authorPubkey: b.authorPubkey, ciphertext: b.ciphertext, nonce: b.nonce,
            type: b.type ?? 'text', systemType: null, metadata: b.metadata ?? null, timestamp: tick(), editedAt: null,
        };
        node.lines.push(line);
        return answer(200, { success: true, message: line });
    }
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
        if (!conv) return answer(404, { error: 'Conversation not found' });
        const lines = node.lines.filter((l) => l.conversationId === conv.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-50);
        return answer(200, { conversation: { id: conv.id, type: conv.type, participants: conv.participants }, messages: lines.map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/marketplace/posts') {
        if (node.listingsDown) return answer(503, { error: 'down' });
        const id = u.searchParams.get('id');
        return answer(200, node.listings.filter((p) => p.id === id));
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

async function phoneOf(who: Person): Promise<void> {
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    h.me = { publicKey: who.publicKey, privateKey: who.privateKey };
    await syncMessages(who.publicKey);
}

/** Send a line from the phone in hand, through the real send path, and wait for the node to have it. */
async function sends(who: Person, text: string, extra: { metadata?: string; reuseId?: string; about?: ReturnType<typeof aboutOfPost> } = {}): Promise<Line> {
    const before = node.lines.length;
    await insertMessage(dm.id, who.publicKey, text, extra.metadata, extra.reuseId, extra.about ?? null);
    await vi.waitFor(() => expect(node.lines.length).toBeGreaterThanOrEqual(before + (extra.reuseId ? 0 : 1)));
    await vi.waitFor(async () => expect((await getMessages(dm.id)).every((m: any) => !m.sendState)).toBe(true));
    return node.lines[node.lines.length - 1];
}
async function shows(): Promise<any[]> {
    await syncMessages(h.me.publicKey);
    return getMessages(dm.id);
}

const EGGS = { id: 'post-eggs-1', type: 'offer', title: 'Fresh eggs', credits: 6, price_type: 'fixed' };

let ana: Person;
let ben: Person;
let dm: Conv;

beforeEach(async () => {
    vi.clearAllMocks();
    h.store.clear();
    h.store.set('beanpool_anchor_url', ANCHOR);
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    ana = person('Ana');
    ben = person('Ben');
    dm = { id: randomUUID(), type: 'dm', participants: [ana.publicKey, ben.publicKey] };
    Object.assign(node, { lines: [], convs: [dm], refuseSends: false, listings: [{ ...EGGS, status: 'active' }], listingsDown: false });
    chatAboutDrafts.clear();
    (globalThis as any).fetch = fetchMock;
    await getDb();
});

describe('a line sent with the listing it is about', () => {
    it('leaves the phone with the listing sealed: the node holds no readable id, title or kind, and the words are the words', async () => {
        await phoneOf(ana);
        const line = await sends(ana, 'Is this still available?', { about: aboutOfPost(EGGS) });
        const stored = JSON.stringify(line);
        for (const readable of ['post-eggs-1', 'Fresh eggs', 'eggs', 'available']) expect(stored).not.toContain(readable);
        expect(Object.keys(JSON.parse(line.metadata!))).toContain('about');
        // A line sent as it was before this change has the same shape: ciphertext, nonce and a metadata object.
        expect(Object.keys(line).sort()).toEqual(['authorPubkey', 'ciphertext', 'conversationId', 'editedAt', 'id', 'metadata', 'nonce', 'systemType', 'timestamp', 'type']);
    });

    it('opens on the other phone, and on the sender\'s own, as the listing, with the words unchanged', async () => {
        await phoneOf(ana);
        const line = await sends(ana, 'Is this still available?', { about: aboutOfPost(EGGS) });
        await phoneOf(ben);
        const asBen = (await shows()).find((m) => m.id === line.id);
        expect(asBen.text).toBe('Is this still available?');
        expect(asBen.about).toEqual({ postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' });
        expect(asBen.integrityNote).toBeNull();
        await phoneOf(ana);
        expect((await shows()).find((m) => m.id === line.id).about).toEqual({ postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' });
    });

    it('only that line has it; the next, sent with no chip, is a plain line', async () => {
        await phoneOf(ana);
        const first = await sends(ana, 'Is this still available?', { about: aboutOfPost(EGGS) });
        const second = await sends(ana, 'Saturday suits me');
        expect(second.metadata === null || !('about' in JSON.parse(second.metadata))).toBe(true);
        const rows = await shows();
        expect(rows.find((m) => m.id === first.id).about).not.toBeNull();
        expect(rows.find((m) => m.id === second.id).about).toBeNull();
    });

    it('a reply carries it too, and it opens', async () => {
        await phoneOf(ana);
        const asked = await sends(ana, 'Hello');
        const reply = await sends(ana, 'About these', { metadata: JSON.stringify({ replyToId: asked.id }), about: aboutOfPost(EGGS) });
        await phoneOf(ben);
        const row = (await shows()).find((m) => m.id === reply.id);
        expect(JSON.parse(reply.metadata!).replyToId).toBe(asked.id);
        expect(row.about).toEqual({ postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' });
    });

    it('a resend of one that failed carries it again, under the same id, and the node stores it once', async () => {
        await phoneOf(ana);
        node.refuseSends = true;
        await insertMessage(dm.id, ana.publicKey, 'Is this still available?', undefined, undefined, aboutOfPost(EGGS));
        await vi.waitFor(async () => expect((await getMessages(dm.id))[0]?.sendState).toBe('failed'));
        const failed = (await getMessages(dm.id))[0];
        expect(failed.about).toEqual({ postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' });
        // What the chat screen's Resend passes: the failed row's metadata, the send flags dropped, and its id.
        const meta = { ...failed.metadata };
        delete meta.__sendState;
        delete meta.__sendError;
        node.refuseSends = false;
        await insertMessage(dm.id, ana.publicKey, failed.text, Object.keys(meta).length ? JSON.stringify(meta) : undefined, failed.id);
        await vi.waitFor(() => expect(node.lines.length).toBe(1));
        await phoneOf(ben);
        const row = (await shows()).find((m) => m.id === failed.id);
        expect(row.text).toBe('Is this still available?');
        expect(row.about).toEqual({ postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' });
    });
});

describe('a line with no listing', () => {
    it('is unaffected: no card, the words and mark it always had', async () => {
        await phoneOf(ana);
        const line = await sends(ana, 'Hello Ben');
        await phoneOf(ben);
        const row = (await shows()).find((m) => m.id === line.id);
        expect(row).toMatchObject({ text: 'Hello Ben', about: null, integrityNote: null });
    });

    it('a listing\'s reference copied onto another line shows no card on it', async () => {
        await phoneOf(ana);
        const withAbout = await sends(ana, 'Is this still available?', { about: aboutOfPost(EGGS) });
        const plain = await sends(ana, 'Something else');
        plain.metadata = JSON.stringify({ ...JSON.parse(plain.metadata ?? '{}'), about: JSON.parse(withAbout.metadata!).about });
        await phoneOf(ben);
        const row = (await shows()).find((m) => m.id === plain.id);
        expect(row.text).toBe('Something else');
        expect(row.about).toBeNull();
    });
});

describe('looking the listing up, for the card', () => {
    it('answers the listing\'s own fields when the node has it for this member', async () => {
        await phoneOf(ana);
        node.listings = [{ ...EGGS, title: 'Fresh eggs, a dozen', credits: 8, status: 'active' }];
        expect(await lookupAboutListing('post-eggs-1')).toMatchObject({ id: 'post-eggs-1', type: 'offer', title: 'Fresh eggs, a dozen', credits: 8, status: 'active' });
    });

    it('answers null when the node holds none for them (gone, or hidden from them: one answer)', async () => {
        await phoneOf(ana);
        node.listings = [];
        expect(await lookupAboutListing('post-eggs-1')).toBeNull();
    });

    it('answers nothing, never "gone", when the node could not be asked', async () => {
        await phoneOf(ana);
        node.listingsDown = true;
        expect(await lookupAboutListing('post-eggs-1')).toBeUndefined();
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        expect(await lookupAboutListing('post-eggs-1')).toBeUndefined();
    });
});
