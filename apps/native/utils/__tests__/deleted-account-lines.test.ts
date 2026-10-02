import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// The other person's phone blanks a deleted member's lines itself (Marty, 2026-10-01: "Yes, blank lines and photos").
//
// When Rhea deletes her account, the node turns every line she wrote into her own tombstone (apps/server/src/engine/
// message-tombstone.ts blankMessagesOf). But the app's sync asks each conversation for its newest 50 lines, and the purge
// sends no event per line, so Bo's phone kept her older DM lines: the ciphertext it can still decrypt, which the chat reads
// from the phone as he scrolls up, and the photos it decrypted (#1392's deciding review). Now the conversation list names
// her (`deletedAccounts`), and the phone blanks every line of hers it holds, in every chat it keeps, and drops her photos.
//
// The phone's real schema and real sync (utils/db.ts syncMessages, syncSingleConversation, getMessages) run here over an
// in-memory SQLite (node:sqlite), with real DM encryption between real keys and the photo cache as real files. The node
// is a stand-in that answers as the real one does: the newest `limit` lines (50 when the app sends none, which it never
// does), and a delete that blanks her lines exactly as blankMessagesOf does. The node's side of it is checked over HTTPS
// in apps/server/src/test-delete-blanks-chat.ts.

const h = vi.hoisted(() => ({
    cacheDir: '',
    store: new Map<string, string>(),
    me: { publicKey: '', privateKey: '' },
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    (globalThis as any).__phoneSql = sql;
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    const adapter = {
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
    (globalThis as any).__phoneAdapter = adapter;
    return { openDatabaseAsync: vi.fn(async () => adapter) };
});
/** The photo cache as real files, in a directory of this test's own. */
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const nodeOs = await import('node:os');
    const nodePath = await import('node:path');
    if (!h.cacheDir) h.cacheDir = nodeFs.mkdtempSync(nodePath.join(process.env.TMPDIR || nodeOs.tmpdir(), 'bp-deleted-lines-'));
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        cacheDirectory: `file://${h.cacheDir}/`,
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...h.me, callsign: 'Bo' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_mullum.beanpool.org.db'), addSavedNode: vi.fn(async () => {}) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { getDb, getMessages, syncMessages, syncSingleConversation } from '../db';
import { encryptDmFormat2 } from '../e2e-crypto';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';

const sql = (globalThis as any).__phoneSql as import('node:sqlite').DatabaseSync;
const adapter = (globalThis as any).__phoneAdapter as { runAsync: ReturnType<typeof vi.fn> };

const ANCHOR = 'https://mullum.beanpool.org';
const DELETED_TEXT = 'This message was deleted';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

interface Person { name: string; publicKey: string; privateKey: string }
function person(name: string): Person {
    const seed = ed25519.utils.randomSecretKey();
    return { name, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

// ── The node ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Line {
    id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string;
    type: string; systemType: string | null; metadata: string | null; timestamp: string; editedAt: string | null;
}
interface Conv { id: string; type: 'dm' | 'group_thread'; participants: string[]; name?: string }

const node = {
    lines: [] as Line[],
    convs: [] as Conv[],
    deleted: new Set<string>(),
    /** Keys the list names whatever they are: a node gone wrong, for the guard below. */
    alsoNamed: [] as string[],
    requests: [] as string[],
};
let clock = Date.parse('2026-09-01T00:00:00.000Z');
let serial = 0;

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

/** GET /api/messages/conversations/:key, and GET /api/messages/:id as the node answers them (routes/messaging.ts). */
const fetchMock = vi.fn(async (url: string) => {
    node.requests.push(url);
    const u = new URL(url);
    const list = u.pathname.match(/^\/api\/messages\/conversations\/([^/]+)$/);
    if (list) {
        const mine = node.convs.filter((c) => c.participants.includes(list[1]));
        const others = new Set(mine.flatMap((c) => c.participants).filter((p) => p !== list[1]));
        return answer(200, {
            conversations: mine.map((c) => ({ id: c.id, type: c.type, name: c.name ?? null, participants: c.participants, createdBy: c.participants[0], createdAt: '2026-09-01T00:00:00.000Z' })),
            totalUnread: 0,
            deletedAccounts: [...[...others].filter((p) => node.deleted.has(p)), ...node.alsoNamed].sort(),
        });
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page) {
        const conv = node.convs.find((c) => c.id === page[1]);
        if (!conv) return answer(404, { error: 'Conversation not found' });
        const limit = Number(u.searchParams.get('limit') ?? 50);
        const lines = node.lines.filter((l) => l.conversationId === conv.id);
        return answer(200, { conversation: { id: conv.id, type: conv.type, participants: conv.participants }, messages: lines.slice(-limit).map((l) => ({ ...l })) });
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

/** One line written on the node: a DM line locked between its author and the other person, a group's in plain text. */
function write(conv: Conv, author: Person, text: string, opts: { type?: string; metadata?: Record<string, unknown> } = {}): Line {
    let ciphertext: string;
    let nonce: string;
    if (conv.type === 'dm') {
        const peer = conv.participants.find((p) => p !== author.publicKey)!;
        // Lines already on the node, as written before the line format took the sender and id in (format 2): what a
        // member's history is made of, and what this phone must still read and blank.
        ({ ciphertext, nonce } = encryptDmFormat2(text, { myEdPrivHex: author.privateKey, peerEdPubHex: peer, conversationId: conv.id }));
    } else {
        ciphertext = b64(text);
        nonce = 'plaintext-v1';
    }
    clock += 1000;
    const line: Line = {
        id: `line-${++serial}`, conversationId: conv.id, authorPubkey: author.publicKey, ciphertext, nonce,
        type: opts.type ?? 'text', systemType: null, metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
        timestamp: new Date(clock).toISOString(), editedAt: null,
    };
    node.lines.push(line);
    return line;
}

/** Delete account on the node: every line of theirs becomes their own tombstone, as blankMessagesOf writes it. Nothing is sent. */
function deleteAccount(who: Person): void {
    node.deleted.add(who.publicKey);
    const removedAt = new Date(clock).toISOString();
    for (const l of node.lines) {
        if (l.authorPubkey !== who.publicKey || l.type === 'removed') continue;
        const md = l.metadata ? JSON.parse(l.metadata) : {};
        delete md.mentions;
        delete md.reactions;
        delete md.replyToId;
        Object.assign(md, { removed: true, removedBy: who.publicKey, removedAt, accountDeleted: true });
        Object.assign(l, { type: 'removed', ciphertext: b64(DELETED_TEXT), nonce: 'plaintext-v1', metadata: JSON.stringify(md) });
    }
}

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Runs `fn` with react-native's DeviceEventEmitter stood in for (node cannot load it), returning what the screens are told. */
async function withScreens(fn: () => Promise<unknown>): Promise<string[]> {
    const told: string[] = [];
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: (e: string) => { told.push(e); } } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        await fn();
    } finally {
        (Module as any)._load = nodeLoad;
    }
    return told;
}
const phoneSyncs = () => withScreens(() => syncMessages(h.me.publicKey));

const cached = (id: string) => path.join(h.cacheDir, 'chat-images', `${id}.jpg`);
/** The decrypted copy of a photo, as getDecryptedAttachment leaves it once the bubble has been seen. */
function photoSeen(id: string): void {
    fs.mkdirSync(path.join(h.cacheDir, 'chat-images'), { recursive: true });
    fs.writeFileSync(cached(id), `decrypted jpeg of ${id}`);
}
const rowsBy = (key: string) => sql.prepare('SELECT * FROM messages WHERE author_pubkey = ? ORDER BY id').all(key) as any[];
const blankWrites = () => adapter.runAsync.mock.calls.filter(([q]) => typeof q === 'string' && q.includes("UPDATE messages SET type = 'removed'")).length;

let bo: Person;
let rhea: Person;

beforeEach(async () => {
    h.store.clear();
    h.store.set('beanpool_anchor_url', ANCHOR);
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    // Each test is its own phone and its own people: what the phone remembers of an earlier one cannot help it here.
    bo = person('Bo');
    rhea = person('Rhea');
    h.me = { publicKey: bo.publicKey, privateKey: bo.privateKey };
    Object.assign(node, { lines: [], convs: [], deleted: new Set<string>(), alsoNamed: [], requests: [] });
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['messages', 'conversation_participants', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
    fs.rmSync(path.join(h.cacheDir, 'chat-images'), { recursive: true, force: true });
    adapter.runAsync.mockClear();
});
afterAll(() => { fs.rmSync(h.cacheDir, { recursive: true, force: true }); });

/**
 * A DM in which Bo's phone holds 60 lines of Rhea's, none of them among the newest 50: she wrote 60 (some photos he has
 * opened, one he reacted to, one a reply), Bo 5 between, then Bo 55 more. The phone synced along the way, as it does.
 */
async function bosPhoneHoldsHerDm() {
    const dm: Conv = { id: 'dm-bo-rhea', type: 'dm', participants: [rhea.publicKey, bo.publicKey] };
    node.convs.push(dm);
    const hers: Line[] = [];
    const words: string[] = [];
    const hersSays = (n: number) => `Vandrelle ${n}: the gate code is ${1000 + n}`;
    for (let n = 1; n <= 30; n++) {
        const opts = n % 10 === 0 ? { type: 'image' } : n === 7 ? { metadata: { reactions: { '👍': [bo.publicKey] } } } : {};
        hers.push(write(dm, rhea, hersSays(n), opts));
        words.push(hersSays(n));
    }
    await phoneSyncs();
    const bos: Line[] = [];
    for (let n = 1; n <= 5; n++) bos.push(write(dm, bo, `Bo ${n}: thanks`, n === 5 ? { type: 'image' } : {}));
    for (let n = 31; n <= 60; n++) {
        hers.push(write(dm, rhea, hersSays(n), n % 10 === 0 ? { type: 'image' } : n === 33 ? { metadata: { replyToId: bos[0].id } } : {}));
        words.push(hersSays(n));
    }
    await phoneSyncs();
    for (let n = 6; n <= 60; n++) {
        bos.push(write(dm, bo, `Bo ${n}: on my way`));
        if (n === 30) await phoneSyncs();
    }
    await phoneSyncs();

    const herPhotos = hers.filter((l) => l.type === 'image').map((l) => l.id);
    const boPhoto = bos[4].id;
    for (const id of [...herPhotos, boPhoto]) photoSeen(id);
    const herCiphertexts = hers.map((l) => l.ciphertext);

    // What the checks below stand on: the phone holds all 60 of hers and reads them, and no page reaches any of them now.
    const shown = await getMessages(dm.id);
    expect(shown.filter((m: any) => m.senderId === rhea.publicKey).map((m: any) => m.text)).toEqual(words);
    expect(shown).toHaveLength(120);
    const page = await (await fetchMock(`${ANCHOR}/api/messages/${dm.id}`)).json();
    expect(page.messages).toHaveLength(50);
    expect(page.messages.some((m: any) => m.authorPubkey === rhea.publicKey)).toBe(false);
    expect(herPhotos.every((id) => fs.existsSync(cached(id)))).toBe(true);
    return { dm, hers, bos, words, herPhotos, boPhoto, herCiphertexts };
}

async function expectAllHersBlank(fx: Awaited<ReturnType<typeof bosPhoneHoldsHerDm>>, boBefore: any[]) {
    const shown = await getMessages(fx.dm.id);
    const hersShown = shown.filter((m: any) => m.senderId === rhea.publicKey);
    expect(hersShown).toHaveLength(60);
    expect(hersShown.filter((m: any) => m.text !== DELETED_TEXT).map((m: any) => `${m.id}: ${m.text}`)).toEqual([]);
    expect(hersShown.every((m: any) => m.type === 'removed' && m.metadata?.removed === true
        && m.metadata?.removedBy === rhea.publicKey && m.metadata?.accountDeleted === true)).toBe(true);
    expect(hersShown.some((m: any) => m.metadata?.reactions || m.metadata?.replyToId || m.metadata?.mentions)).toBe(false);
    // Each where it was: the same ids, in the same order, at the same times.
    expect(hersShown.map((m: any) => m.id)).toEqual(fx.hers.map((l) => l.id));
    expect(hersShown.map((m: any) => m.rawTimestamp)).toEqual(fx.hers.map((l) => l.timestamp));
    // Not a byte of her words left in the phone's database: her ciphertexts, or her words as written.
    const all = JSON.stringify(sql.prepare('SELECT * FROM messages').all());
    expect(fx.herCiphertexts.filter((c) => all.includes(c))).toEqual([]);
    expect(all.includes('Vandrelle') || all.includes(b64('Vandrelle').slice(0, 8))).toBe(false);
    expect(JSON.stringify(shown).includes('Vandrelle')).toBe(false);
    // Her photos' decrypted copies are gone from the phone; Bo's stays.
    expect(fx.herPhotos.filter((id) => fs.existsSync(cached(id)))).toEqual([]);
    expect(fs.existsSync(cached(fx.boPhoto))).toBe(true);
    // Bo's own 60 lines are exactly as they were, every column, and still read as he wrote them.
    expect(rowsBy(bo.publicKey)).toEqual(boBefore);
    expect(shown.filter((m: any) => m.senderId === bo.publicKey).map((m: any) => m.text))
        .toEqual(fx.bos.map((_, i) => (i < 5 ? `Bo ${i + 1}: thanks` : `Bo ${i + 1}: on my way`)));
    expect(shown).toHaveLength(120);
}

describe("a deleted member's older lines on the other person's phone", () => {
    it('every one of her 60 DM lines reads "This message was deleted" after the next sync, her photos are gone, and Bo\'s lines are untouched', async () => {
        const fx = await bosPhoneHoldsHerDm();
        const boBefore = rowsBy(bo.publicKey);

        deleteAccount(rhea);
        const told = await phoneSyncs();

        await expectAllHersBlank(fx, boBefore);
        expect(told).toContain('sync_data_updated');
        // The app's own requests: the list, then the conversation with no limit (the newest 50).
        expect(node.requests.some((r) => r.includes('limit='))).toBe(false);
    });

    it('a phone that was offline when she deleted catches it on its first sync a day later, with no socket event', async () => {
        const fx = await bosPhoneHoldsHerDm();
        const boBefore = rowsBy(bo.publicKey);
        node.requests = [];

        // She deletes while Bo's phone is off: no socket, no push, nothing reaches it. A day passes.
        deleteAccount(rhea);
        clock += 24 * 3600_000;
        expect(rowsBy(rhea.publicKey).some((r) => r.type === 'removed')).toBe(false);

        await phoneSyncs();

        await expectAllHersBlank(fx, boBefore);
        // From the sync's own answers only: the conversation list, the conversation, the directory.
        expect(new Set(node.requests.map((r) => new URL(r).pathname))).toEqual(new Set([
            `/api/messages/conversations/${bo.publicKey}`, `/api/messages/${fx.dm.id}`, '/api/members',
        ]));
        // And once is enough: the next sync writes nothing more.
        adapter.runAsync.mockClear();
        await phoneSyncs();
        expect(blankWrites()).toBe(0);
        await expectAllHersBlank(fx, boBefore);
    });

    it('blanks her older lines in a group chat this phone keeps, from a tombstone of hers on its page, when the list does not name her', async () => {
        // She left the group before deleting, so she is in none of Bo's chats: only her tombstones on the page say so.
        const cy = person('Cy');
        const group: Conv = { id: 'group-seeds', type: 'group_thread', name: 'Seed Savers', participants: [bo.publicKey, rhea.publicKey, cy.publicKey] };
        node.convs.push(group);
        for (let n = 1; n <= 10; n++) write(group, rhea, `Ostrevain ${n}: compost by Friday`);
        await phoneSyncs();
        for (let n = 1; n <= 45; n++) write(group, cy, `Cy ${n}: noted`);
        await phoneSyncs();
        group.participants = [bo.publicKey, cy.publicKey];
        const cyBefore = rowsBy(cy.publicKey);
        expect(rowsBy(rhea.publicKey)).toHaveLength(10);

        deleteAccount(rhea);
        const list = await (await fetchMock(`${ANCHOR}/api/messages/conversations/${bo.publicKey}`)).json();
        expect(list.deletedAccounts).toEqual([]);
        await phoneSyncs();

        const hers = rowsBy(rhea.publicKey);
        expect(hers).toHaveLength(10);
        expect(hers.filter((r) => Buffer.from(r.ciphertext, 'base64').toString('utf8') !== DELETED_TEXT).map((r) => r.id)).toEqual([]);
        expect(JSON.stringify(sql.prepare('SELECT * FROM messages').all()).includes(b64('Ostrevain').slice(0, 12))).toBe(false);
        expect(rowsBy(cy.publicKey)).toEqual(cyBefore);

        // Once: the chat's next poll, with her tombstones still on its page, writes nothing.
        adapter.runAsync.mockClear();
        await withScreens(() => syncSingleConversation(group.id));
        await phoneSyncs();
        expect(blankWrites()).toBe(0);
    });

    it("an open group chat's poll blanks them too, from her tombstone on its page", async () => {
        const cy = person('Cy');
        const group: Conv = { id: 'group-open', type: 'group_thread', name: 'Ladder Share', participants: [bo.publicKey, cy.publicKey] };
        node.convs.push(group);
        for (let n = 1; n <= 60; n++) {
            write(group, rhea, `Pemberlook ${n}: ladder is free`);
            if (n === 30) await phoneSyncs();
        }
        await phoneSyncs();
        expect(rowsBy(rhea.publicKey)).toHaveLength(60);

        deleteAccount(rhea);
        // Only the open chat's poll runs (chat/[id].tsx every 3 s): its page is her newest 50, her first 10 are older.
        const told = await withScreens(() => syncSingleConversation(group.id));

        const hers = rowsBy(rhea.publicKey);
        expect(hers).toHaveLength(60);
        expect(hers.filter((r) => Buffer.from(r.ciphertext, 'base64').toString('utf8') !== DELETED_TEXT)).toEqual([]);
        expect(told).toContain('sync_data_updated');
    });

    it("an open DM's poll takes no tombstone on its page as a signal: only the conversation list's deletedAccounts does", async () => {
        const dm: Conv = { id: 'dm-open', type: 'dm', participants: [rhea.publicKey, bo.publicKey] };
        node.convs.push(dm);
        for (let n = 1; n <= 60; n++) {
            write(dm, rhea, `Pemberlook ${n}: ladder is free`);
            if (n === 30) await phoneSyncs();
        }
        await phoneSyncs();
        expect(rowsBy(rhea.publicKey)).toHaveLength(60);

        deleteAccount(rhea);
        await withScreens(() => syncSingleConversation(dm.id));
        // Her newest 50 lines on the page are her own tombstones, and they replace what the phone held of those 50 ...
        expect(blankWrites()).toBe(0);
        const older = (await getMessages(dm.id)).filter((m: any) => m.senderId === rhea.publicKey).slice(0, 10);
        expect(older.map((m: any) => m.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Pemberlook ${i + 1}: ladder is free`));

        // ... and the list, which names her, blanks the rest on the next full sync.
        await phoneSyncs();
        const shown = (await getMessages(dm.id)).filter((m: any) => m.senderId === rhea.publicKey);
        expect(shown.filter((m: any) => m.text !== DELETED_TEXT)).toEqual([]);
    });

    it("a forged tombstone in a DM line from an active member blanks nothing: the node deleted nothing, so the list names nobody", async () => {
        const dee = person('Dee');
        const dm: Conv = { id: 'dm-bo-dee-forged', type: 'dm', participants: [dee.publicKey, bo.publicKey] };
        node.convs.push(dm);
        const words: string[] = [];
        for (let n = 1; n <= 60; n++) {
            words.push(`Dee ${n}: the key is under the pot`);
            write(dm, dee, words[n - 1]);
            if (n === 30) await phoneSyncs();
        }
        await phoneSyncs();
        expect(rowsBy(dee.publicKey)).toHaveLength(60);

        // Dee, active, sends one more DM line whose metadata claims she deleted her account. The node stores it as sent.
        write(dm, dee, 'Dee 61: crafted', { metadata: { removed: true, removedBy: dee.publicKey, accountDeleted: true } });
        const deeBefore = rowsBy(dee.publicKey);
        await phoneSyncs();
        await withScreens(() => syncSingleConversation(dm.id));
        await phoneSyncs();

        expect(blankWrites()).toBe(0);
        const shown = (await getMessages(dm.id)).filter((m: any) => m.senderId === dee.publicKey && m.text !== 'Dee 61: crafted');
        expect(shown.map((m: any) => m.text)).toEqual(words);
        expect(rowsBy(dee.publicKey).slice(0, 60)).toEqual(deeBefore.slice(0, 60));
    });

    it("never blanks this phone's own lines, nor anyone the node did not name (a member the community removed)", async () => {
        const dee = person('Dee');
        const dm: Conv = { id: 'dm-bo-dee', type: 'dm', participants: [dee.publicKey, bo.publicKey] };
        node.convs.push(dm);
        for (let n = 1; n <= 5; n++) write(dm, dee, `Dee ${n}`);
        await phoneSyncs();
        for (let n = 1; n <= 55; n++) write(dm, bo, `Bo ${n}`);
        await phoneSyncs();
        const deeBefore = rowsBy(dee.publicKey);
        const boBefore = rowsBy(bo.publicKey);

        // Removed by the community, not deleted by herself: the node blanks nothing of hers and names her nowhere. And a node
        // naming this phone's own key (it never does) blanks nothing of Bo's.
        node.alsoNamed = [bo.publicKey];
        await phoneSyncs();

        expect(rowsBy(dee.publicKey)).toEqual(deeBefore);
        expect(rowsBy(bo.publicKey)).toEqual(boBefore);
        expect(blankWrites()).toBe(0);
        expect((await getMessages(dm.id)).filter((m: any) => m.senderId === dee.publicKey).map((m: any) => m.text))
            .toEqual(['Dee 1', 'Dee 2', 'Dee 3', 'Dee 4', 'Dee 5']);
    });
});
