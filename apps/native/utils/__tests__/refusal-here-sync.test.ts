import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A community in a private preview refuses every read by a non-member with its own sentence (403 `private_preview`), and
// any community refuses every signed request by a key whose account there was closed (403 `account_closed`). The sync
// notes each with its code, so the Market says it instead of "Having trouble connecting" (scratch/global-node/
// DESIGN-global-entry-fable.md §1.3, §C.3, P3). A preview's refusal is the same for an unsigned read, which a member's
// phone makes when it can't reach its key, so it is noted only on the membership probe's word, signed with this phone's
// key. performSync runs against a stubbed node, writing the phone's real schema in an in-memory SQLite, with AsyncStorage
// kept in a map (the members-only-refusal-sync.test.ts harness).

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

const ANCHOR = 'https://global.beanpool.org';
const store = new Map<string, string>();
const me = { publicKey: '', privateKey: '' };
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
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: (n: number) => new Uint8Array(n).fill(3) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...me, callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getDb } from '../db';
import { seedToKeypair } from '../crypto';
import { refusalHere } from '../members-only-listings';
import { marketEmptyState } from '../market-empty-state';
import { forceResyncNotice, performSync, resetSyncFingerprints } from '../../services/pillar-sync';
import { t } from '@beanpool/core';
import { loadIdentity } from '../identity';

const NOTE_KEY = `beanpool_members_only_${ANCHOR}`;
const PREVIEW = { error: 'This community is in a private preview. Ask its owner for an invite.', code: 'private_preview' };
const CLOSED = { error: 'This account was closed here.', code: 'account_closed' };

/** The stubbed node: what the posts read and the membership probe answer, or 'network' for no answer at all. */
const node = {
    posts: { status: 200, body: [] as unknown } as { status: number; body: unknown } | 'network',
    probe: { status: 200, body: { isMember: false } as unknown } as { status: number; body: unknown } | 'network',
};
let probes: Array<{ url: string; headers: Record<string, string> }> = [];

function answer(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
}

const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    if (url.includes('/api/community/membership/')) {
        probes.push({ url, headers: init?.headers ?? {} });
        if (node.probe === 'network') throw new TypeError('Network request failed');
        return answer(node.probe.status, node.probe.body);
    }
    if (url.includes('/api/marketplace/posts')) {
        if (node.posts === 'network') throw new TypeError('Network request failed');
        return answer(node.posts.status, node.posts.body);
    }
    if (url.includes('/api/members')) return answer(200, []);
    return answer(404, {});
});

async function sync() {
    probes = [];
    // pillar-sync tells the screens through `require('react-native')`, which does not load under node.
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: () => {} } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        return await performSync();
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

/** What the Market shows once the first sync has given up waiting (market.tsx: the 12 s wait, then this). */
async function marketShows() {
    return marketEmptyState({ refusal: await refusalHere(), hasActiveFilters: false, firstSyncDone: false, syncTimedOut: true });
}

beforeAll(async () => {
    const k = await seedToKeypair(new Uint8Array(32).fill(7));
    me.publicKey = k.publicKeyHex;
    me.privateKey = k.privateKeyHex;
});

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', ANCHOR);
    store.set('beanpool_node_profiles', JSON.stringify({ [ANCHOR]: { profile: 'local', features: {}, checkedAt: new Date().toISOString() } }));
    store.set('bp_trust_sync_v3', 'true');
    resetSyncFingerprints();
    Object.assign(node, { posts: { status: 200, body: [] }, probe: { status: 200, body: { isMember: false } } });
    vi.mocked(loadIdentity).mockImplementation(async () => ({ ...me, callsign: 'Me' }) as any);
    (globalThis as any).fetch = fetchMock;
    await getDb();
});

describe("a private preview's refusal", () => {
    it("is noted with the node's sentence once the probe, signed with this phone's key, says it is no member; the Market says it", async () => {
        node.posts = { status: 403, body: PREVIEW };
        const result = await sync();
        expect(result.success).toBe(false);
        expect(probes).toHaveLength(1);
        expect(probes[0].url).toBe(`${ANCHOR}/api/community/membership/${me.publicKey}`);
        expect(probes[0].headers['X-Public-Key']).toBe(me.publicKey);
        expect(probes[0].headers['X-Signature']).toBeTruthy();
        expect(await refusalHere()).toEqual({ code: 'private_preview', sentence: PREVIEW.error });
        expect(await marketShows()).toEqual({ kind: 'refused', refusal: { code: 'private_preview', sentence: PREVIEW.error } });
    });

    it('is noted too when a node from before the probe was opened refuses the signed probe with the preview', async () => {
        node.posts = { status: 403, body: PREVIEW };
        node.probe = { status: 403, body: PREVIEW };
        await sync();
        expect((await refusalHere())?.code).toBe('private_preview');
    });

    it("notes a closed account when the probe says this key's account there was closed (a closed key meets the preview first)", async () => {
        store.set('beanpool_saved_nodes', JSON.stringify([{ url: ANCHOR, alias: 'Global community' }]));
        node.posts = { status: 403, body: PREVIEW };
        node.probe = { status: 403, body: CLOSED };
        await sync();
        expect(await refusalHere()).toEqual({ code: 'account_closed', community: 'Global community' });
    });

    it("leaves the note as it was when the probe says the key IS a member: that read went unsigned (PR #1286's rule)", async () => {
        node.posts = { status: 403, body: PREVIEW };
        node.probe = { status: 200, body: { isMember: true } };
        await sync();
        expect(store.has(NOTE_KEY)).toBe(false);
        expect(await marketShows()).toEqual({ kind: 'trouble_connecting' });
    });

    it("leaves the note as it was when the probe gets no answer, or the phone can't read its key (and then asks nothing)", async () => {
        node.posts = { status: 403, body: PREVIEW };
        node.probe = 'network';
        await sync();
        expect(store.has(NOTE_KEY)).toBe(false);

        vi.mocked(loadIdentity).mockImplementation(async () => null as any);
        node.probe = { status: 200, body: { isMember: false } };
        await sync();
        expect(probes).toHaveLength(0);
        expect(store.has(NOTE_KEY)).toBe(false);
    });
});

describe("a closed account's refusal", () => {
    it('is noted with its code (the node checked the signature before it said so); the Market says the closed sentence', async () => {
        store.set('beanpool_saved_nodes', JSON.stringify([{ url: ANCHOR, alias: 'Global community' }]));
        node.posts = { status: 403, body: CLOSED };
        const result = await sync();
        expect(result.success).toBe(false);
        expect(probes).toHaveLength(0);
        expect(await refusalHere()).toEqual({ code: 'account_closed', community: 'Global community' });
        expect((await marketShows()).kind).toBe('refused');
    });
});

// Settings → Force Resync clears the copy and runs a sync of its own, then says what came of it (forceResyncNotice). Before,
// both refusals answered "Posts fetch failed with status: 403", and the notice promised the community "downloads again with
// the next sync", which the node refuses just the same.
describe('what Force Resync says after a refusal', () => {
    const PROMISE = 'downloads again';

    it("a private preview's: the node's own sentence, never a download promised", async () => {
        node.posts = { status: 403, body: PREVIEW };
        const result = await sync();
        expect(result.errorMessage).toBe('private_preview');
        const notice = forceResyncNotice(result);
        expect(notice.title).toBe('Local copy cleared');
        expect(notice.message).toBe(PREVIEW.error);
    });

    it("a closed account's (straight, or the probe's word behind a preview): the closed sentence", async () => {
        node.posts = { status: 403, body: CLOSED };
        const closed = forceResyncNotice(await sync());
        expect(closed.message).toContain(t('Your account here was closed.'));
        expect(closed.message).not.toContain(PROMISE);

        node.posts = { status: 403, body: PREVIEW };
        node.probe = { status: 403, body: CLOSED };
        const behindPreview = forceResyncNotice(await sync());
        expect(behindPreview.message).toBe(closed.message);
    });

    it("a preview's refusal that leaves the standing unclear (the probe says member, or no answer): nothing more", async () => {
        node.posts = { status: 403, body: PREVIEW };
        for (const probe of [{ status: 200, body: { isMember: true } }, 'network'] as const) {
            node.probe = probe;
            const result = await sync();
            expect(result.errorMessage).toBe('private_preview');
            expect(result.refusal).toBeUndefined();
            expect(forceResyncNotice(result)).toEqual({ title: 'Local copy cleared', message: '' });
        }
    });

    it('any other failed read keeps its message and the promise, as before', async () => {
        node.posts = { status: 403, body: { error: 'This key was replaced.', code: 'key_invalidated' } };
        const other = await sync();
        expect(other.errorMessage).toBe('Posts fetch failed with status: 403');
        expect(other.refusal).toBeUndefined();
        expect(forceResyncNotice(other).message).toContain(PROMISE);

        node.posts = { status: 500, body: {} };
        expect(forceResyncNotice(await sync()).message).toContain(PROMISE);
    });
});

describe('everything else, as before', () => {
    it('no answer at all notes nothing: "Having trouble connecting"', async () => {
        node.posts = 'network';
        const result = await sync();
        expect(result.success).toBe(false);
        expect(store.has(NOTE_KEY)).toBe(false);
        expect(await marketShows()).toEqual({ kind: 'trouble_connecting' });
        expect(forceResyncNotice(result).message).toContain('downloads again');
    });

    it('another 403 code clears a note, as any other failed read did, and notes nothing', async () => {
        node.posts = { status: 403, body: CLOSED };
        await sync();
        expect(store.has(NOTE_KEY)).toBe(true);
        node.posts = { status: 403, body: { error: 'This key was replaced.', code: 'key_invalidated' } };
        await sync();
        expect(store.has(NOTE_KEY)).toBe(false);
        expect(await marketShows()).toEqual({ kind: 'trouble_connecting' });
    });

    it('a read that lands clears the note', async () => {
        node.posts = { status: 403, body: PREVIEW };
        await sync();
        expect(store.has(NOTE_KEY)).toBe(true);
        node.posts = { status: 200, body: [] };
        const result = await sync();
        expect(result.success).toBe(true);
        expect(store.has(NOTE_KEY)).toBe(false);
    });
});
