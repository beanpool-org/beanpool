import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Members on demand on the phone (DESIGN-global-members-by-area §2.2, #1792, slice M2). On a community whose profile says
// `features.membersOnDemand` (the worldwide one), performSync never reads /api/members whole and never asks for everyone
// who changed: after the cycle lands it asks for the referenced cards it lacks by key, at most 3 batches of 100 a cycle,
// re-checks the 100 held cards fetched longest ago with their oldest stamp, and leaves every card where it was when a
// read is refused. A community that doesn't say gets exactly the requests it got before. performSync runs against a
// fake node, writing the phone's real schema in an in-memory SQLite, with AsyncStorage kept in a map across cycles.

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

const A_URL = 'https://a.beanpool.org';
const OWN = 'e'.repeat(64);
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'e'.repeat(64), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import { applyDelta, getDb, getPosts } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

const DB = 'beanpool_a.beanpool.org.db';
const KEY = (id: string) => `pillar_sync_${DB}_${id}`;
const hexKey = (n: number) => n.toString(16).padStart(64, '0');
const FACE = (pk: string) => `/api/avatar/${pk}?v=1`;

// The node's directory: every member as the directory row shape (§2.1), with when their card last changed.
interface Card { publicKey: string; callsign: string; avatarUrl: string | null; profileUpdatedAt: string }
const node = {
    cards: new Map<string, Card>(),
    keysReads: 'ok' as 'ok' | 'busy',
    requests: [] as string[],
};
function answer(status: number, body: string) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: () => null },
        text: async () => body, json: async () => JSON.parse(body),
    };
}
function listing(id: string, author: string) {
    return {
        id, type: 'offer', category: 'food', title: `Listing ${id}`, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: author, authorCallsign: 'Carried', authorAvatarUrl: FACE(author),
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public', photos: [],
    };
}
const AUTHOR = hexKey(0xa0a0);
const fetchMock = vi.fn(async (url: string) => {
    node.requests.push(url);
    const u = new URL(url);
    if (u.pathname === '/api/marketplace/posts') return answer(200, JSON.stringify([listing('L1', AUTHOR)]));
    if (u.pathname === '/api/members') {
        const keys = u.searchParams.get('keys');
        if (keys !== null) {
            if (node.keysReads === 'busy') return answer(503, JSON.stringify({ code: 'heavy_read_busy' }));
            const asked = keys.split(',');
            if (asked.length > 100) return answer(400, '{}');
            const after = u.searchParams.get('updatedAfter');
            const rows = asked.map(k => node.cards.get(k)).filter((c): c is Card => !!c && (after === null || c.profileUpdatedAt > after));
            return answer(200, JSON.stringify(rows));
        }
        return answer(200, JSON.stringify([...node.cards.values()]));
    }
    return answer(404, '');
});

const membersRequests = () => node.requests.filter(r => new URL(r).pathname === '/api/members');
const keysOf = (r: string) => new URL(r).searchParams.get('keys')?.split(',') ?? [];
const held = () => (sql.prepare('SELECT public_key FROM members').all() as any[]).map(r => r.public_key as string);
const cardStamp = (pk: string) => (sql.prepare('SELECT card_fetched_at FROM members WHERE public_key = ?').get(pk) as any)?.card_fetched_at ?? null;
function onDemandProfile(on: boolean | undefined) {
    const features = on === undefined ? {} : { membersOnDemand: on };
    store.set('beanpool_node_profiles', JSON.stringify({ [A_URL]: { profile: on ? 'global' : 'local', features, checkedAt: new Date().toISOString() } }));
}
function partners(n: number) {
    const keys: string[] = [];
    for (let i = 1; i <= n; i++) {
        const pk = hexKey(i);
        keys.push(pk);
        sql.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits) VALUES (?, ?, ?, ?, ?)').run(`t${i}`, 'L1', OWN, pk, 1);
    }
    return keys;
}

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', A_URL);
    resetSyncFingerprints();
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'marketplace_transactions', 'conversations', 'conversation_participants', 'members', 'ratings', 'friends']) sql.exec(`DELETE FROM ${t}`);
    node.cards.clear();
    node.keysReads = 'ok';
    node.requests = [];
    node.cards.set(OWN, { publicKey: OWN, callsign: 'Me', avatarUrl: null, profileUpdatedAt: '2026-09-01T00:00:00.000Z' });
    for (let i = 1; i <= 2000; i++) {
        const pk = hexKey(i);
        node.cards.set(pk, { publicKey: pk, callsign: `M${i}`, avatarUrl: FACE(pk), profileUpdatedAt: '2026-09-01T00:00:00.000Z' });
    }
});

describe('a community that says membersOnDemand', () => {
    it('never reads the directory whole nor asks for everyone who changed, over several cycles', async () => {
        onDemandProfile(true);
        partners(5);
        for (let i = 0; i < 3; i++) expect((await performSync()).success).toBe(true);
        const reads = membersRequests();
        expect(reads.length).toBeGreaterThan(0);
        for (const r of reads) expect(new URL(r).searchParams.get('keys'), r).not.toBeNull();
        // The own card and the five partners; no one else.
        expect(held().sort()).toEqual([OWN, ...[1, 2, 3, 4, 5].map(hexKey)].sort());
    });

    it('a restore with 350 partners: 3 batches of ≤ 100 the first cycle, the rest the next; then held ⊇ referenced ∪ own', async () => {
        onDemandProfile(true);
        const keys = partners(350);
        await performSync();
        const first = membersRequests();
        const firstMissing = first.filter(r => new URL(r).searchParams.get('updatedAfter') === null);
        expect(firstMissing.length).toBe(3);
        for (const r of firstMissing) expect(keysOf(r).length).toBeLessThanOrEqual(100);
        expect(held().length).toBe(300);
        node.requests = [];
        await performSync();
        const h = new Set(held());
        for (const k of [OWN, ...keys]) expect(h.has(k)).toBe(true);
        // The second cycle asked only for the 51 left (one batch), plus the one re-check.
        const second = membersRequests();
        expect(second.filter(r => new URL(r).searchParams.get('updatedAfter') === null).map(r => keysOf(r).length)).toEqual([51]);
    });

    it('a 503 heavy_read_busy keeps every held card and fetches the missing ones next cycle', async () => {
        onDemandProfile(true);
        const keys = partners(20);
        await performSync();
        expect(held().length).toBe(21);
        // New partners arrive; the node is busy for the next cycle.
        for (let i = 21; i <= 30; i++) sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run('c1', hexKey(i));
        node.keysReads = 'busy';
        await performSync();
        expect(held().length).toBe(21);
        for (const k of [OWN, ...keys]) expect(held()).toContain(k);
        node.keysReads = 'ok';
        await performSync();
        expect(held().length).toBe(31);
    });

    it('re-checks the held cards round robin: the re-check URL carries the batch\'s oldest stamp, and a changed card lands', async () => {
        onDemandProfile(true);
        partners(3);
        await performSync();
        const before = [OWN, hexKey(1), hexKey(2), hexKey(3)].map(cardStamp);
        expect(before).not.toContain(null);
        // The own card was fetched a moment before the partners: it is the oldest of the batch.
        sql.prepare('UPDATE members SET card_fetched_at = ? WHERE public_key = ?').run('2026-10-01T00:00:00.000Z', OWN);
        node.requests = [];
        node.cards.set(hexKey(2), { ...node.cards.get(hexKey(2))!, callsign: 'Renamed', profileUpdatedAt: new Date(Date.now() + 60_000).toISOString() });
        await performSync();
        const recheck = membersRequests().filter(r => new URL(r).searchParams.get('updatedAfter') !== null);
        expect(recheck.length).toBe(1);
        expect(new URL(recheck[0]).searchParams.get('updatedAfter')).toBe('2026-10-01T00:00:00.000Z');
        expect(keysOf(recheck[0]).sort()).toEqual([OWN, hexKey(1), hexKey(2), hexKey(3)].sort());
        // Every card re-checked is stamped now.
        for (const k of [OWN, hexKey(1), hexKey(2), hexKey(3)]) expect(cardStamp(k) > '2026-10-01T00:00:00.000Z').toBe(true);
        expect((sql.prepare('SELECT callsign FROM members WHERE public_key = ?').get(hexKey(2)) as any).callsign).toBe('Renamed');
    });

    it('a directory copy from before the switch is pruned to the rule: referenced and own kept, at most 1,000', async () => {
        await applyDelta({ members: [...node.cards.values()] }, DB);
        expect(held().length).toBe(2001);
        onDemandProfile(true);
        const keys = partners(10);
        await performSync();
        const h = held();
        expect(h.length).toBeLessThanOrEqual(1000);
        for (const k of [OWN, ...keys]) expect(h).toContain(k);
    });

    it('a listing by an author it holds no card for shows the carried name and face', async () => {
        onDemandProfile(true);
        await performSync();
        expect(held()).not.toContain(AUTHOR);
        const posts = await getPosts();
        const row = posts.find((p: any) => p.id === 'L1') as any;
        expect(row.author_callsign).toBe('Carried');
        expect(row.author_avatar).toBe(FACE(AUTHOR));
    });
});

describe('a community that does not say membersOnDemand', () => {
    it('gets exactly the requests it got before: the same with no profile, a local profile, or the switch off', async () => {
        const runs: string[][] = [];
        for (const profile of ['none', 'local', 'off'] as const) {
            store.clear();
            store.set('beanpool_anchor_url', A_URL);
            resetSyncFingerprints();
            for (const t of ['posts', 'members', 'marketplace_transactions']) sql.exec(`DELETE FROM ${t}`);
            if (profile === 'local') onDemandProfile(undefined);
            if (profile === 'off') onDemandProfile(false);
            partners(5);
            node.requests = [];
            await performSync();
            await performSync();
            runs.push(node.requests.map(r => r.replace(/updatedAfter=[^&]+/, 'updatedAfter=<cursor>')));
        }
        expect(runs[1]).toEqual(runs[0]);
        expect(runs[2]).toEqual(runs[0]);
        // The whole directory first, then the members delta; never a keys read.
        const members = runs[0].filter(r => new URL(r).pathname === '/api/members');
        expect(members[0]).toBe(`${A_URL}/api/members`);
        expect(members.some(r => r.includes('keys='))).toBe(false);
        expect(held().length).toBe(2001);
    });
});
