import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';

// Whether the phone's message read worked, as syncMessages answers it (slice L0, review of #2558).
//
// The tabs' message backstop (app/(tabs)/_layout.tsx) counts a read only once it worked. syncMessages swallows every
// failure, so it says which it was: true when the conversation list and every chat's page it asked for came back 2xx,
// false when any did not (a 503 while the node is full, a timeout on a weak link, a dropped request). A read that failed
// is read again on the next tick, as before slice L0; one that worked puts the next off to the backstop.
//
// The phone's real schema and real sync run here over an in-memory SQLite (node:sqlite), as deleted-account-lines.test.ts
// runs them. The node is a stand-in that answers as routes/messaging.ts does, or refuses where a test says.

const h = vi.hoisted(() => ({
    cacheDir: '',
    store: new Map<string, string>(),
    me: { publicKey: 'pk-bo', privateKey: '' },
}));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sql = new DatabaseSync(':memory:');
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
    return { openDatabaseAsync: vi.fn(async () => adapter) };
});
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const nodeOs = await import('node:os');
    const nodePath = await import('node:path');
    if (!h.cacheDir) h.cacheDir = nodeFs.mkdtempSync(nodePath.join(process.env.TMPDIR || nodeOs.tmpdir(), 'bp-read-worked-'));
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

import { getDb, getMessages, syncMessages } from '../db';
import { CACHE_NAMES_DONE_KEY } from '../cache-file-migration';

const ANCHOR = 'https://mullum.beanpool.org';
const RHEA = 'pk-rhea';
const CHATS = ['group-chat-1', 'group-chat-2'];

// ── The node ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the stand-in does to one read: answer it, refuse it 503 (the node full), or never answer (a timeout, a drop). */
type Fate = 'answer' | 'refuse' | 'drop';
const node = { list: 'answer' as Fate, pages: new Map<string, Fate>() };

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}
function fated(fate: Fate, body: () => unknown) {
    if (fate === 'drop') return Promise.reject(new TypeError('Network request failed'));
    return Promise.resolve(fate === 'refuse' ? answer(503, { error: 'This community is busy right now.', code: 'store_full' }) : answer(200, body()));
}

const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url);
    if (/^\/api\/messages\/conversations\/[^/]+$/.test(u.pathname)) {
        return fated(node.list, () => ({
            conversations: CHATS.map((id) => ({ id, type: 'group_thread', name: id, participants: [h.me.publicKey, RHEA], createdBy: RHEA, createdAt: '2026-10-28T00:00:00.000Z' })),
            totalUnread: 0,
            deletedAccounts: [],
        }));
    }
    const page = u.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (page && CHATS.includes(page[1])) {
        const id = page[1];
        return fated(node.pages.get(id) ?? 'answer', () => ({
            conversation: { id, type: 'group_thread', participants: [h.me.publicKey, RHEA] },
            messages: [{
                id: `${id}-line`, conversationId: id, authorPubkey: RHEA, ciphertext: Buffer.from(`Hello from ${id}`).toString('base64'),
                nonce: 'plaintext-v1', type: 'text', systemType: null, metadata: null, timestamp: '2026-10-28T06:00:00.000Z', editedAt: null,
            }],
        }));
    }
    if (u.pathname === '/api/members') return answer(200, []);
    return answer(404, { error: 'not here' });
});

// ── The phone ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One read, with react-native's DeviceEventEmitter stood in for (node cannot load it): what syncMessages answered. */
async function reads(): Promise<unknown> {
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        return await syncMessages(h.me.publicKey);
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

beforeEach(async () => {
    h.store.clear();
    h.store.set('beanpool_anchor_url', ANCHOR);
    h.store.set('beanpool_node_profiles', JSON.stringify({ [ANCHOR]: { profile: 'local', features: {}, checkedAt: new Date().toISOString() } }));
    h.store.set('bp_trust_sync_v3', 'true');
    h.store.set(CACHE_NAMES_DONE_KEY, '1');
    node.list = 'answer';
    node.pages.clear();
    (globalThis as any).fetch = fetchMock;
    const db = await getDb();
    for (const t of ['messages', 'conversation_participants', 'conversations']) await db.execAsync(`DELETE FROM ${t}`);
});
afterAll(() => { fs.rmSync(h.cacheDir, { recursive: true, force: true }); });

describe('syncMessages says whether its read worked', () => {
    it('the list and every chat\'s page came back: it worked, and the lines are on the phone', async () => {
        expect(await reads()).toBe(true);
        for (const id of CHATS) expect((await getMessages(id)).map((m: any) => m.text)).toEqual([`Hello from ${id}`]);
    });

    it('the list refused 503, the node full: it did not', async () => {
        node.list = 'refuse';
        expect(await reads()).toBe(false);
    });

    it('the list never answered, a timeout or a dropped request: it did not', async () => {
        node.list = 'drop';
        expect(await reads()).toBe(false);
    });

    it('the list came back but a chat\'s page was refused: it did not, though the other chat\'s line landed', async () => {
        node.pages.set(CHATS[1], 'refuse');
        expect(await reads()).toBe(false);
        expect((await getMessages(CHATS[0])).map((m: any) => m.text)).toEqual([`Hello from ${CHATS[0]}`]);
        expect(await getMessages(CHATS[1])).toEqual([]);
    });

    it('a chat\'s page never answered: it did not', async () => {
        node.pages.set(CHATS[0], 'drop');
        expect(await reads()).toBe(false);
    });

    it('the read after a failed one works again', async () => {
        node.list = 'refuse';
        expect(await reads()).toBe(false);
        node.list = 'answer';
        expect(await reads()).toBe(true);
    });
});
