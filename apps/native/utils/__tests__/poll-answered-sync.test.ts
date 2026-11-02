import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A sealed poll (@beanpool/core poll-other): the node knows a member has answered and nothing of how, and says so in every read
// of theirs (`pollAnswered`). A phone that didn't give the answer (it was given on the web, on another phone, or before a
// reinstall) has to say the same as the web app: "You have answered", with no answer ticked. The phone that gave it keeps
// which it was. performSync runs against a stubbed node, writing the phone's real schema in an in-memory SQLite.

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

const ANCHOR = 'https://mullum.beanpool.org';
const ME = 'me'.padEnd(64, '0');
const store = new Map<string, string>();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) store.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: ME, privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getDb, getPosts } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

function poll(id: string, extra: Record<string, unknown> = {}) {
    return {
        id, type: 'poll', category: 'community', title: 'What is missing?', description: '', credits: 0, priceType: 'fixed',
        authorPublicKey: 'a'.repeat(64), createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T01:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public',
        pollOptions: [{ id: 'opt_a', text: 'Buses', votes: 1 }, { id: 'opt_other', text: 'Other', other: true, votes: 1 }], ...extra,
    };
}

const node = { posts: [] as unknown[] };
function answer(status: number, body: string) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
}
const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/marketplace/posts')) return answer(200, JSON.stringify(node.posts));
    if (url.includes('/api/members')) return answer(200, '[]');
    return answer(404, '');
});

async function sync() {
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        await performSync();
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

const answerOf = async (id: string) => ((await getPosts()) as any[]).find(p => p.id === id)?.userVotedOptionId;

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', ANCHOR);
    store.set('beanpool_node_profiles', JSON.stringify({ [ANCHOR]: { profile: 'local', features: {}, checkedAt: new Date().toISOString() } }));
    store.set('bp_trust_sync_v3', 'true');
    resetSyncFingerprints();
    node.posts = [];
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'poll_votes']) sql.exec(`DELETE FROM ${t}`);
});

describe('a sealed poll answered somewhere else', () => {
    it('reads as answered on this phone, with no answer ticked', async () => {
        node.posts = [poll('post-answered', { pollAnswered: true })];
        await sync();
        const mine = await answerOf('post-answered');
        expect(mine).toBeTruthy();
        expect(node.posts[0] as { pollOptions: { id: string }[] }).toSatisfy((p: { pollOptions: { id: string }[] }) => !p.pollOptions.some(o => o.id === mine));
    });

    it('keeps the answer this phone gave, whatever the node says next', async () => {
        sql.prepare('INSERT INTO poll_votes (post_id, voter_pubkey, option_id) VALUES (?, ?, ?)').run('post-mine', ME, 'opt_other');
        node.posts = [poll('post-mine', { pollAnswered: true })];
        await sync();
        expect(await answerOf('post-mine')).toBe('opt_other');
    });

    it('says nothing of a poll the node does not say was answered', async () => {
        node.posts = [poll('post-fresh')];
        await sync();
        expect(await answerOf('post-fresh')).toBeUndefined();
    });
});
