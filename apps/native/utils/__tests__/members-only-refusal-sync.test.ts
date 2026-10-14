import { describe, it, expect, vi, beforeEach } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A local community's listings are its members' (2026-09-28). A phone whose key is no member there may already hold them
// from before its node was updated (a guest node, utils/nodes.ts). On the node's members_only refusal, the phone drops
// what it cached of that community's listings, with their poll votes and RSVPs, so no old listing or pin stays on show
// and the Market shows its members-only card (#1286's deciding review, 4125322582). Never another community's cache,
// never the phone's own posts; and once the phone may read them again, the sync is a whole one. performSync runs
// against a stubbed node, writing the phone's real schema in an in-memory SQLite, with AsyncStorage kept in a map.

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
const OTHER = 'https://castlemaine.beanpool.org';
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

import { getDb } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

const ANN = 'a'.repeat(64);
const LAST_SYNC_KEY = 'pillar_sync_beanpool_mullum.beanpool.org.db_last-sync';
const MEMBERS_ONLY_KEY = `beanpool_members_only_${ANCHOR}`;

function listing(id: string, title: string, extra: Record<string, unknown> = {}) {
    return {
        id, type: 'offer', category: 'food', title, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: ANN, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T01:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public', lat: -28.55, lng: 153.5,
        photos: [`/api/marketplace/posts/${id}/photos/0?v=1`], ...extra,
    };
}
const LEMONS = listing('post-lemons', 'Spare lemons');
const POLL = listing('post-poll', 'Market day?', { type: 'poll', credits: 0, pollOptions: [{ id: 'opt_a', text: 'Yes', votes: 1 }] });
const PARTY = listing('post-party', 'Street party', { type: 'event', credits: 0, eventStartAt: '2026-10-10T08:00:00.000Z', eventEndAt: '2026-10-10T12:00:00.000Z' });
/** This phone's own post there, from when it could post: its member's own, which stays. */
const MINE = listing('post-mine', 'My old offer', { authorPublicKey: ME });

const MEMBERS_ONLY = JSON.stringify({ error: "This community's listings are for its members.", code: 'members_only', global: 'https://global.beanpool.org' });
const node = { status: 200, whole: [] as any[], delta: [] as any[], onPosts: null as null | (() => Promise<void>) };
let requests: string[] = [];

function answer(status: number, body: string) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: () => null },
        text: async () => body, json: async () => JSON.parse(body),
    };
}

const fetchMock = vi.fn(async (url: string) => {
    requests.push(url);
    if (url.includes('/api/marketplace/posts')) {
        await node.onPosts?.();
        if (node.status !== 200) return answer(node.status, MEMBERS_ONLY);
        const isDelta = new URL(url).searchParams.has('updatedAfter');
        return answer(200, JSON.stringify(isDelta ? node.delta : node.whole));
    }
    if (url.includes('/api/members')) return answer(200, '[]');
    return answer(404, '');
});

const ids = () => (sql.prepare('SELECT id FROM posts ORDER BY id').all() as any[]).map(r => r.id);
const votes = () => (sql.prepare('SELECT post_id FROM poll_votes ORDER BY post_id').all() as any[]).map(r => r.post_id);
const rsvps = () => (sql.prepare('SELECT post_id FROM event_rsvps ORDER BY post_id').all() as any[]).map(r => r.post_id);
const postsPulls = () => requests.filter(u => u.includes('/api/marketplace/posts'));

/** One sync cycle, from a clean request log, with what the screens are told. */
async function sync() {
    requests = [];
    // pillar-sync tells the screens through `require('react-native')`, which does not load under node: it is stood in
    // for during the cycle only, so the test sees what the screens are told.
    const told: string[] = [];
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: (e: string) => { told.push(e); } } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        const result = await performSync();
        return { result, told };
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', ANCHOR);
    // A phone that ran utils/db.ts's one-shot trust migration long ago: opening a database no longer clears the cursors.
    store.set('bp_trust_sync_v3', 'true');
    resetSyncFingerprints();
    Object.assign(node, { status: 200, whole: [], delta: [], onPosts: null });
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'poll_votes', 'event_rsvps', 'marketplace_transactions', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
});

/** A phone that synced the community whole while its listings were public, voted in its poll and said it's going. */
async function phoneThatCachedTheListings() {
    Object.assign(node, { status: 200, whole: [LEMONS, POLL, PARTY, MINE] });
    const { result } = await sync();
    expect(result.success).toBe(true);
    sql.prepare("INSERT INTO poll_votes (post_id, voter_pubkey, option_id) VALUES ('post-poll', ?, 'opt_a')").run(ME);
    sql.prepare("INSERT INTO event_rsvps (post_id, member_pubkey, status) VALUES ('post-party', ?, 'going')").run(ME);
    // A poll of its own, voted in by its member: its own post's, which stays.
    sql.prepare("INSERT INTO poll_votes (post_id, voter_pubkey, option_id) VALUES ('post-mine', ?, 'opt_a')").run(ME);
    expect(ids()).toEqual(['post-lemons', 'post-mine', 'post-party', 'post-poll']);
    expect(store.has(LAST_SYNC_KEY)).toBe(true);
}

describe("a community's members_only refusal", () => {
    it("drops the listings this phone cached of it, with their poll votes and RSVPs, and keeps the phone's own", async () => {
        await phoneThatCachedTheListings();

        node.status = 403;
        const { result, told } = await sync();
        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('members_only');
        expect(ids()).toEqual(['post-mine']);
        expect(votes()).toEqual(['post-mine']);
        expect(rsvps()).toEqual([]);
        expect(store.get(MEMBERS_ONLY_KEY)).toBe('1');
        // The Market and the map read the listings again (so the pins go), and the Market reads the refusal.
        expect(told).toContain('sync_data_updated');
        expect(told).toContain('members_only_listings');
        // The cursor goes, so the next pull the phone may make is a whole one.
        expect(store.has(LAST_SYNC_KEY)).toBe(false);
    });

    it('an unsigned read refused 401 members_only drops nothing (a locked phone, or a switch in flight: not a verdict on membership)', async () => {
        await phoneThatCachedTheListings();
        node.status = 401;
        await sync();
        expect(ids()).toEqual(['post-lemons', 'post-mine', 'post-party', 'post-poll']);
        expect(votes()).toEqual(['post-mine', 'post-poll']);
        expect(rsvps()).toEqual(['post-party']);
        expect(store.has(LAST_SYNC_KEY)).toBe(true);
        // Nor does it note the community as members-only: the Market's card never shows a member for an unsigned read.
        expect(store.has(MEMBERS_ONLY_KEY)).toBe(false);
    });

    it("a 403 while the phone can't read its own key drops nothing (it can't tell its own posts from the others')", async () => {
        await phoneThatCachedTheListings();
        const { loadIdentity } = await import('../identity');
        vi.mocked(loadIdentity).mockResolvedValue(null as any);
        try {
            node.status = 403;
            await sync();
            expect(ids()).toEqual(['post-lemons', 'post-mine', 'post-party', 'post-poll']);
            expect(votes()).toEqual(['post-mine', 'post-poll']);
        } finally {
            vi.mocked(loadIdentity).mockResolvedValue({ publicKey: ME, privateKey: 'aa', callsign: 'Me' } as any);
        }
    });

    it("never touches another community's cache: switched to another community while the refusal was on its way, nothing goes", async () => {
        await phoneThatCachedTheListings();

        // The member opens another community while this one's answer is in flight: the app opens that one's database (as
        // switching community does), and nothing of this answer may be written there.
        node.status = 403;
        node.onPosts = async () => { store.set('beanpool_anchor_url', OTHER); await getDb(); };
        const { told } = await sync();
        expect(ids()).toEqual(['post-lemons', 'post-mine', 'post-party', 'post-poll']);
        expect(votes()).toEqual(['post-mine', 'post-poll']);
        expect(rsvps()).toEqual(['post-party']);
        expect(told).not.toContain('sync_data_updated');
        expect(store.has(LAST_SYNC_KEY)).toBe(true);
    });

    it('once the phone may read them again, the pull is whole and the listings come back', async () => {
        await phoneThatCachedTheListings();
        node.status = 403;
        await sync();
        expect(ids()).toEqual(['post-mine']);

        // Its key became a member there. The delta alone would carry nothing, and the whole pull everything.
        Object.assign(node, { status: 200, whole: [LEMONS, POLL, PARTY, MINE], delta: [] });
        const { result } = await sync();
        expect(result.success).toBe(true);
        expect(postsPulls().length).toBeGreaterThan(0);
        expect(postsPulls().every(u => !new URL(u).searchParams.has('updatedAfter'))).toBe(true);
        expect(ids()).toEqual(['post-lemons', 'post-mine', 'post-party', 'post-poll']);
        expect(store.has(MEMBERS_ONLY_KEY)).toBe(false);
    });

    it('any other failed read of the listings drops nothing', async () => {
        await phoneThatCachedTheListings();
        node.status = 500;
        const { result } = await sync();
        expect(result.success).toBe(false);
        expect(ids()).toEqual(['post-lemons', 'post-mine', 'post-party', 'post-poll']);
        expect(store.has(LAST_SYNC_KEY)).toBe(true);
    });
});
