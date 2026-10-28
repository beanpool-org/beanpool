import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// An enterprise's shop banner on the phone's own Market list (Pictures S6, review of #2565 at e311b3c5, blocking 1). The
// default list reads the phone's copy (db.ts getPosts), never the node: a banner the sync threw away on arrival showed
// only while a search was typed. Here the node's copy of a listing goes through the sync's own row writer (applyDelta),
// comes back through getPosts, and the card's picture is chosen from that row as market.tsx chooses it
// (utils/market-card-picture.ts): own photo, then banner, then the CategoryTile. Real SQL against the phone's real schema
// (getDb() runs the app's own _doInitDB over this in-memory database), device modules stubbed at the boundary as in
// poll-vote-origins-cache.test.ts.

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

const ANCHOR = 'https://valley.example.org';
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? ANCHOR : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
        multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: '11'.repeat(32), callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { applyDelta, closeDB, getDb, getPosts } from '../db';
import { marketCardPicture } from '../market-card-picture';

const BAKERY = 'b'.repeat(64);
const MEMBER = 'c'.repeat(64);
// As the node names it (@beanpool/core shopPhotoUrlOf): relative, its photo_ref and key in the query.
const BANNER = '/api/shops/shop-1/photo?v=ref1&k=Yqpu8qmgAGQ';
const OWN_PHOTO = '/api/marketplace/posts/L1/photos/0?v=1791608803169&k=AbCdEf';

function listing(id: string, extra: Record<string, unknown> = {}) {
    return {
        id, type: 'offer', category: 'food', title: `Listing ${id}`, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: BAKERY, authorCallsign: 'Valley Bakery',
        createdAt: '2026-10-01T01:00:00.000Z', updatedAt: '2026-10-01T01:00:00.000Z', active: true, status: 'active',
        audienceScope: 'public', photos: [],
        ...extra,
    };
}
const cached = async (id: string) => (await getPosts()).find((p: any) => p.id === id) as any;
const stored = (id: string) => (sql.prepare('SELECT carried_banner FROM posts WHERE id = ?').get(id) as any)?.carried_banner;

beforeEach(async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
    await getDb();
    sql.exec('DELETE FROM posts');
});

describe("the phone's Market list draws an enterprise's shop banner from its own copy", () => {
    it('a synced photoless enterprise listing: the copy keeps the banner, getPosts hands it out on the node, the card draws it', async () => {
        await applyDelta({ posts: [listing('L1', { authorBannerUrl: BANNER })] });
        expect(stored('L1')).toBe(BANNER);
        const p = await cached('L1');
        expect(p.authorBannerUrl).toBe(`${ANCHOR}${BANNER}`);
        expect(marketCardPicture(p)).toEqual({ cover: null, picture: `${ANCHOR}${BANNER}` });
    });

    it("the listing's own photo comes first, and only it is the cover a failed load heals", async () => {
        await applyDelta({ posts: [listing('L1', { authorBannerUrl: BANNER, photos: [OWN_PHOTO] })] });
        const p = await cached('L1');
        expect(marketCardPicture(p)).toEqual({ cover: `${ANCHOR}${OWN_PHOTO}`, picture: `${ANCHOR}${OWN_PHOTO}` });
    });

    it("a member's listing names no banner: no picture, so the card draws its CategoryTile", async () => {
        await applyDelta({ posts: [listing('L2', { authorPublicKey: MEMBER, authorCallsign: 'Ann' })] });
        expect(stored('L2')).toBeNull();
        const p = await cached('L2');
        expect(p.authorBannerUrl ?? null).toBeNull();
        expect(marketCardPicture(p)).toEqual({ cover: null, picture: null });
    });

    it("each copy is the node's word: a new banner replaces the old, and a copy with none (the shop's photo removed) clears it", async () => {
        await applyDelta({ posts: [listing('L1', { authorBannerUrl: BANNER })] });
        const NEW = '/api/shops/shop-1/photo?v=ref2&k=ZZ';
        await applyDelta({ posts: [listing('L1', { authorBannerUrl: NEW, updatedAt: '2026-10-02T01:00:00.000Z' })] });
        expect((await cached('L1')).authorBannerUrl).toBe(`${ANCHOR}${NEW}`);
        // The node names a banner only where there is one (engine rowToPost): a copy without it says there is none now.
        await applyDelta({ posts: [listing('L1', { updatedAt: '2026-10-03T01:00:00.000Z' })] });
        expect(stored('L1')).toBeNull();
        expect(marketCardPicture(await cached('L1')).picture).toBeNull();
    });

    it('anything but a URL is stored as nothing', async () => {
        for (const bad of ['', '   ', 42, null]) {
            sql.exec('DELETE FROM posts');
            await applyDelta({ posts: [listing('L1', { authorBannerUrl: bad })] });
            expect(stored('L1')).toBeNull();
            expect(marketCardPicture(await cached('L1')).picture).toBeNull();
        }
    });
});

describe('the column on a phone that already holds a copy, and on one rolled back', () => {
    it("a copy from before the column gains it on open, keeps its rows, and the next sync fills it", async () => {
        await applyDelta({ posts: [listing('L1')] });
        // The previous build's table: the same, without the column.
        await closeDB();
        sql.exec('ALTER TABLE posts DROP COLUMN carried_banner');
        await getDb();
        const cols = sql.prepare('PRAGMA table_info(posts)').all() as { name: string; type: string; dflt_value: unknown }[];
        const col = cols.find(c => c.name === 'carried_banner');
        expect(col).toMatchObject({ type: 'TEXT', dflt_value: null });
        expect((await cached('L1'))?.title).toBe('Listing L1');
        await applyDelta({ posts: [listing('L1', { authorBannerUrl: BANNER, updatedAt: '2026-10-02T01:00:00.000Z' })] });
        expect((await cached('L1')).authorBannerUrl).toBe(`${ANCHOR}${BANNER}`);
    });

    it('a previous build opens the new table: no trigger, index or default names the column, and its writer leaves it empty', async () => {
        const named = sql.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'index', 'view') AND sql LIKE '%carried_banner%'").all();
        expect(named).toEqual([]);
        // The previous build's row writer names its columns and not this one (INSERT OR REPLACE): it runs, and the
        // column reads empty, so that build's cards draw as they always did.
        sql.prepare("INSERT OR REPLACE INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, audience_scope, created_at, updated_at, carried_callsign, carried_avatar) VALUES ('L9', 'offer', 'food', 'Old build', '', 5, ?, 'active', 1, 'public', '2026-10-01T01:00:00.000Z', '2026-10-01T01:00:00.000Z', 'Valley Bakery', NULL)").run(BAKERY);
        expect(stored('L9')).toBeNull();
        expect((sql.prepare('SELECT * FROM posts WHERE id = ?').get('L9') as any).title).toBe('Old build');
    });
});
