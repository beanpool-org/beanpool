import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

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

const ANCHOR = 'https://test.beanpool.org';
const activeAnchor: string | null = ANCHOR;
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? activeAnchor : k === 'beanpool_node_profiles' ? JSON.stringify({ [ANCHOR]: { profile: 'local', features: { pins: true }, checkedAt: new Date().toISOString() } }) : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
        multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pubkey', privateKey: 'aa', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string, body: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { applyDelta, getDb, getPosts, getPost, pinPostOnNode, unpinPostOnNode } from '../db';
import { isPostPinned, pinnedDetailLine, pinFailureText } from '../pins';

describe('post pinning: phone columns, sync, and db operations', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // Ensure db initialized
        await getDb();
    });

    it('posts table has pinned_until and pinned_at columns', async () => {
        const columns = sql.prepare("PRAGMA table_info(posts)").all() as Array<{ name: string }>;
        const names = columns.map(c => c.name);
        expect(names).toContain('pinned_until');
        expect(names).toContain('pinned_at');
    });

    it('sync applies pinnedUntil and pinnedAt to SQLite cache', async () => {
        const now = Date.now();
        const until = new Date(now + 3 * 86400000).toISOString();
        const at = new Date(now).toISOString();

        await applyDelta({
            posts: [{
                id: 'post-pin-1',
                type: 'offer',
                category: 'food',
                title: 'Fresh apples',
                description: 'Organic apples',
                credits: 5,
                author_pubkey: 'author-pk',
                status: 'active',
                pinnedUntil: until,
                pinnedAt: at,
            }],
        });

        const row = sql.prepare("SELECT id, pinned_until, pinned_at FROM posts WHERE id = 'post-pin-1'").get() as any;
        expect(row).toBeTruthy();
        expect(row.pinned_until).toBe(until);
        expect(row.pinned_at).toBe(at);

        // getPosts returns them
        const posts = await getPosts();
        const post = posts.find((p: any) => p.id === 'post-pin-1');
        expect(post).toBeTruthy();
        expect(post.pinnedUntil).toBe(until);
        expect(post.pinnedAt).toBe(at);

        // getPost returns them
        const single = await getPost('post-pin-1');
        expect(single.pinnedUntil).toBe(until);
        expect(single.pinnedAt).toBe(at);
    });

    it('isPostPinned identifies live pin and respects time expiration without sync', async () => {
        const now = Date.now();
        const future = new Date(now + 3600000).toISOString();
        const past = new Date(now - 3600000).toISOString();

        const livePost = {
            id: 'p-live',
            type: 'offer',
            status: 'active',
            active: 1,
            audience_scope: 'public',
            pinned_until: future,
            pinned_at: new Date(now).toISOString(),
        };

        const expiredPost = {
            id: 'p-expired',
            type: 'offer',
            status: 'active',
            active: 1,
            audience_scope: 'public',
            pinned_until: past,
            pinned_at: new Date(now - 86400000).toISOString(),
        };

        expect(isPostPinned(livePost, now)).toBe(true);
        // At future time, livePost expires
        expect(isPostPinned(livePost, now + 7200000)).toBe(false);
        // Already expired
        expect(isPostPinned(expiredPost, now)).toBe(false);
    });

    it('pinPostOnNode sends days to /api/marketplace/posts/:id/pin and updates local row', async () => {
        const now = Date.now();
        const until = new Date(now + 3 * 86400000).toISOString();
        const at = new Date(now).toISOString();

        // Seed a post
        await applyDelta({
            posts: [{
                id: 'post-to-pin',
                type: 'offer',
                category: 'food',
                title: 'To pin',
                credits: 2,
                status: 'active',
                author_pubkey: 'me-pubkey',
            }],
        });

        // Mock fetch
        const globalFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, postId: 'post-to-pin', pinnedUntil: until, pinnedAt: at }),
        });
        vi.stubGlobal('fetch', globalFetch);

        try {
            const res = await pinPostOnNode('post-to-pin', 3);
            expect(res.pinnedUntil).toBe(until);
            expect(globalFetch).toHaveBeenCalledWith(
                'https://test.beanpool.org/api/marketplace/posts/post-to-pin/pin',
                expect.objectContaining({ method: 'POST', body: JSON.stringify({ days: 3 }) })
            );

            // DB was updated
            const row = sql.prepare("SELECT pinned_until, pinned_at, updated_at FROM posts WHERE id = 'post-to-pin'").get() as any;
            expect(row.pinned_until).toBe(until);
            expect(row.pinned_at).toBe(at);
            expect(row.updated_at).toBe(at);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('unpinPostOnNode calls /unpin and clears local row', async () => {
        const now = Date.now();
        const until = new Date(now + 3 * 86400000).toISOString();
        const at = new Date(now).toISOString();

        // Seed a pinned post
        await applyDelta({
            posts: [{
                id: 'post-pinned',
                type: 'offer',
                category: 'food',
                title: 'Pinned',
                credits: 2,
                status: 'active',
                author_pubkey: 'me-pubkey',
                pinnedUntil: until,
                pinnedAt: at,
            }],
        });

        const globalFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, postId: 'post-pinned', pinnedUntil: null, pinnedAt: null }),
        });
        vi.stubGlobal('fetch', globalFetch);

        try {
            const db = await getDb();
            const before = (await db.getFirstAsync('SELECT updated_at FROM posts WHERE id = ?', ['post-pinned']) as { updated_at: string }).updated_at;
            await unpinPostOnNode('post-pinned');
            // The phone's clock stays out of it: a fast clock would make the node's next push read as stale.
            expect((await db.getFirstAsync('SELECT updated_at FROM posts WHERE id = ?', ['post-pinned']) as { updated_at: string }).updated_at).toBe(before);
            expect(globalFetch).toHaveBeenCalledWith(
                'https://test.beanpool.org/api/marketplace/posts/post-pinned/unpin',
                expect.objectContaining({ method: 'POST' })
            );

            const row = sql.prepare("SELECT pinned_until, pinned_at FROM posts WHERE id = 'post-pinned'").get() as any;
            expect(row.pinned_until).toBeNull();
            expect(row.pinned_at).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('pinPostOnNode throws refusal message on HTTP error', async () => {
        const globalFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 409,
            text: async () => JSON.stringify({ error: 'Three posts are pinned already. Take one off first.', code: 'pins_full' }),
        });
        vi.stubGlobal('fetch', globalFetch);

        try {
            await expect(pinPostOnNode('post-fail', 1)).rejects.toThrow('Three posts are pinned already. Take one off first.');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    // Fix round 1 (#2769 finding 2): both go through the shared signed request, so the node answers in the member's language.
    describe('the shared signed request (language, body, refusals)', () => {
        const fetchOf = (res: Record<string, unknown>) => vi.fn().mockResolvedValue(res);

        it('pinPostOnNode sends X-Language beside the signature, so a refusal comes back in the member\'s language', async () => {
            const f = fetchOf({ ok: true, status: 200, json: async () => ({ success: true, postId: 'x', pinnedUntil: null, pinnedAt: null }) });
            vi.stubGlobal('fetch', f);
            try {
                await pinPostOnNode('x', 1);
                const init = f.mock.calls[0][1];
                expect(init.headers).toEqual({ 'X-Signed': 'POST https://test.beanpool.org/api/marketplace/posts/x/pin', 'X-Language': 'en' });
            } finally { vi.unstubAllGlobals(); }
        });

        it('unpinPostOnNode sends X-Language and a {} body, as every other phone POST does', async () => {
            const f = fetchOf({ ok: true, status: 200, json: async () => ({ success: true, postId: 'x' }) });
            vi.stubGlobal('fetch', f);
            try {
                await unpinPostOnNode('x');
                const init = f.mock.calls[0][1];
                expect(init.body).toBe('{}');
                expect(init.headers).toEqual({ 'X-Signed': 'POST https://test.beanpool.org/api/marketplace/posts/x/unpin', 'X-Language': 'en' });
            } finally { vi.unstubAllGlobals(); }
        });

        it("a refusal's sentence reaches the caller exactly as the node wrote it, marked as the node's answer", async () => {
            const f = fetchOf({ ok: false, status: 403, json: async () => ({ error: 'Seul un propriétaire ou un administrateur peut épingler.', code: 'pin_not_allowed' }) });
            vi.stubGlobal('fetch', f);
            try {
                const err: any = await pinPostOnNode('x', 1).catch(e => e);
                expect(err.message).toBe('Seul un propriétaire ou un administrateur peut épingler.');
                expect(err.nodeAnswered).toBe(true);
                expect(err.code).toBe('pin_not_allowed');
                const off: any = await unpinPostOnNode('x').catch(e => e);
                expect(off.message).toBe('Seul un propriétaire ou un administrateur peut épingler.');
            } finally { vi.unstubAllGlobals(); }
        });

        it('a refusal with no sentence leaves the caller to word its own fallback through t()', async () => {
            const f = fetchOf({ ok: false, status: 500, json: async () => ({}) });
            vi.stubGlobal('fetch', f);
            try {
                const err: any = await pinPostOnNode('x', 1).catch(e => e);
                expect(err.nodeAnswered).toBe(false);
                // db.ts's own English is wrapped by the screens' pinFailureText → signedRequestWords, not shown raw.
                expect(pinFailureText(err, 'Failed to pin post')).toBe('Server returned 500');
            } finally { vi.unstubAllGlobals(); }
        });
    });
});
