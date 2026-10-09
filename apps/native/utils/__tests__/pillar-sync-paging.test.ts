import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import Module from 'node:module';

// The posts sync read past its first page (services/pillar-sync.ts, POSTS_NEXT_HEADER). The node answers at most 200
// listings a read, newest changed first (apps/server https-server.ts MAX_PAGE_LIMIT); a phone that took one page and
// moved its cursor to "now" never asked for the rest of a busy delta or a big whole pull again. performSync runs
// against a fake node that answers as the server's route does (routes/marketplace.ts, engine posts.ts PAGE_ORDER): one
// total order, (updated_at, created_at, id) newest first; `paged=1` or `pageAfter=<key>` pages by key and hands out the
// next key while a page is full; without either it answers its first 200 and no key, as a node always has. The phone's
// real schema is written in an in-memory SQLite and AsyncStorage is a map, so cursors last from one cycle to the next.

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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me'.padEnd(64, '0'), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { getDb } from '../db';
import { forgetSyncCursors, performSync, POSTS_PAGE_CAP, resetSyncFingerprints, syncCursorKeysOf } from '../../services/pillar-sync';

const ANN = 'a'.repeat(64);
const KEY = (id: string) => `pillar_sync_beanpool_test.beanpool.org.db_${id}`;
const LAST_SYNC_KEY = KEY('last-sync');
const HELD_KEY = KEY('posts_held_read');
const EPOCH_KEY = KEY('identity-epoch');
/** The server's MAX_PAGE_LIMIT. */
const PAGE = 200;

function listing(id: string, title: string, updatedAt: string, createdAt = '2026-01-01T00:00:00.000Z') {
    return {
        id, type: 'offer', category: 'food', title, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: ANN, createdAt, updatedAt, active: true, status: 'active', audienceScope: 'public',
    };
}
type Listing = ReturnType<typeof listing>;

/** `n` listings changed at `at` + i ms, ids `<prefix>-00000`… */
function many(prefix: string, n: number, at: number): Listing[] {
    return Array.from({ length: n }, (_, i) =>
        listing(`${prefix}-${String(i).padStart(5, '0')}`, `${prefix} ${i}`, new Date(at + i).toISOString()));
}

/** The node: its listings, its epoch, whether it pages by key (false: a node from before it), and a hook between pages. */
const node = {
    posts: [] as Listing[],
    epoch: '0' as string | null,
    paging: true,
    notModified: false,
    /** The read of a cycle (0 the first) answered with this instead: a failure, or a body that isn't a list. */
    broken: null as null | { read: number; status: number; body: string },
    /** Called before the node answers each posts read after the first one of a cycle (1 = the second read). */
    beforeRead: null as null | ((n: number) => void),
};
let requests: string[] = [];
let postsReadsThisCycle = 0;

const order = (a: Listing, b: Listing) =>
    (b.updatedAt.localeCompare(a.updatedAt)) || (b.createdAt.localeCompare(a.createdAt)) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
const keyOf = (p: Listing) => Buffer.from(JSON.stringify([p.updatedAt, p.createdAt, p.id])).toString('base64url');
const below = (p: Listing, key: string) => {
    const [u, c, id] = JSON.parse(Buffer.from(key, 'base64url').toString('utf8'));
    return order(listing(id, '', u, c), p) < 0;
};

function answer(status: number, body: string, headers: Record<string, string | null> = {}) {
    const all: Record<string, string | null> = { 'x-beanpool-epoch': node.epoch, ...headers };
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: (name: string) => all[name.toLowerCase()] ?? null },
        text: async () => body, json: async () => JSON.parse(body),
    };
}

function postsAnswer(url: string) {
    if (postsReadsThisCycle > 0) node.beforeRead?.(postsReadsThisCycle);
    postsReadsThisCycle++;
    if (node.notModified) return answer(304, '');
    if (node.broken?.read === postsReadsThisCycle - 1) return answer(node.broken.status, node.broken.body);
    const q = new URL(url).searchParams;
    const since = q.get('updatedAfter');
    let rows = node.posts.filter(p => !since || p.updatedAt >= since).sort(order);
    const after = q.get('pageAfter');
    const paged = node.paging && (q.get('paged') === '1' || after !== null);
    if (paged && after) rows = rows.filter(p => below(p, after));
    const page = rows.slice(0, PAGE);
    const next = paged && page.length === PAGE ? keyOf(page[page.length - 1]) : null;
    return answer(200, JSON.stringify(page), { 'x-posts-next': next });
}

const fetchMock = vi.fn(async (url: string) => {
    requests.push(url);
    if (url.includes('/api/marketplace/posts')) return postsAnswer(url);
    if (url.includes('/api/members')) return answer(200, '[]');
    return answer(404, '');
});

const postsReads = () => requests.filter(u => u.includes('/api/marketplace/posts'));
const held = () => (sql.prepare('SELECT id, title FROM posts ORDER BY id').all() as any[]);
const heldTitles = () => new Map(held().map(r => [r.id as string, r.title as string]));

/** What the cycle told the screens (DeviceEventEmitter), in order. */
let told: string[] = [];

async function sync(expectSuccess = true) {
    requests = [];
    postsReadsThisCycle = 0;
    told = [];
    // pillar-sync tells the screens through `require('react-native')`, which does not load under node: it is stood in
    // for during the cycle only, as members-only-refusal-sync.test.ts does.
    const nodeLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
        return request === 'react-native' ? { DeviceEventEmitter: { emit: (e: string) => { told.push(e); } } } : nodeLoad.call(this, request, ...rest);
    };
    try {
        const r = await performSync();
        if (expectSuccess) expect(r.success).toBe(true);
        return r;
    } finally {
        (Module as any)._load = nodeLoad;
    }
}

/** A phone that synced once (one old listing), so its next cycle is a delta from that cycle's cursor. */
async function phoneWithACursor() {
    node.posts = [listing('old', 'Ladder', '2026-01-01T00:00:00.000Z')];
    await sync();
    expect(store.get(LAST_SYNC_KEY)).toBeTruthy();
    expect(held()).toHaveLength(1);
}

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', ANCHOR);
    resetSyncFingerprints();
    Object.assign(node, { posts: [], epoch: '0', paging: true, notModified: false, broken: null, beforeRead: null });
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'marketplace_transactions', 'conversations', 'members']) sql.exec(`DELETE FROM ${t}`);
});

describe('a delta of more than one page', () => {
    it('450 listings changed since the cursor: all 450 are written, and the cursor moves', async () => {
        await phoneWithACursor();
        const cursorBefore = Number(store.get(LAST_SYNC_KEY));
        const changed = many('chg', 450, Date.now());
        node.posts.push(...changed);

        const startedAt = Date.now();
        await sync();
        expect(postsReads()).toHaveLength(3); // 200 + 200 + 50
        expect(postsReads().every(u => new URL(u).searchParams.has('updatedAfter'))).toBe(true);
        const titles = heldTitles();
        expect(changed.filter(p => titles.get(p.id) !== p.title)).toEqual([]);
        expect(held()).toHaveLength(451);
        // Moved, to when the read began.
        const cursorAfter = Number(store.get(LAST_SYNC_KEY));
        expect(cursorAfter).toBeGreaterThan(cursorBefore);
        expect(cursorAfter).toBeGreaterThanOrEqual(startedAt);
        expect(store.has(HELD_KEY)).toBe(false);
    });

    it('a node that does not page by key answers one page, as before, and the phone asks it nothing more', async () => {
        node.paging = false;
        await phoneWithACursor();
        node.posts.push(...many('chg', 450, Date.now()));
        await sync();
        expect(postsReads()).toHaveLength(1);
        expect(held()).toHaveLength(201);
    });

    it('the page cap: the cursor is held where the read stopped, and the next cycle carries on and finishes', async () => {
        await phoneWithACursor();
        const cursorBefore = store.get(LAST_SYNC_KEY);
        const changed = many('chg', 50 * PAGE + 300, Date.now());
        node.posts.push(...changed);

        await sync();
        expect(postsReads()).toHaveLength(50);
        expect(held()).toHaveLength(50 * PAGE + 1);
        // Not moved past what it didn't read.
        expect(store.get(LAST_SYNC_KEY)).toBe(cursorBefore);
        const hold = JSON.parse(store.get(HELD_KEY)!);
        expect(hold.after).toBeTruthy();

        await sync();
        // From the page it stopped at, with the same cursor: two pages for the last 300.
        expect(postsReads()).toHaveLength(2);
        expect(new URL(postsReads()[0]).searchParams.get('pageAfter')).toBe(hold.after);
        expect(new URL(postsReads()[0]).searchParams.get('updatedAfter')).toBe(hold.since);
        const titles = heldTitles();
        expect(changed.filter(p => titles.get(p.id) !== p.title)).toEqual([]);
        expect(held()).toHaveLength(changed.length + 1);
        expect(Number(store.get(LAST_SYNC_KEY))).toBe(hold.startedAt);
        expect(store.has(HELD_KEY)).toBe(false);
    }, 60_000);

    it('listings that change, appear and leave between pages: none is lost, each in its latest state by the next cycle', async () => {
        await phoneWithACursor();
        const now = Date.now();
        const changed = many('chg', 450, now - 60_000);
        node.posts.push(...changed);
        // Sorted newest first: chg-00449 … chg-00250 is the first page. chg-00010 is on the third.
        const edited = 'chg-00010';
        const leaves = 'chg-00400';
        node.beforeRead = (n) => {
            if (n !== 1) return;
            // Before the second page: one listing edited (to the top of the order), one made, and one of the first
            // page's leaves this reader's view (a group left). By offset, the second page would start one row late.
            const i = node.posts.findIndex(p => p.id === edited);
            node.posts[i] = listing(edited, 'Edited between pages', new Date(Date.now() + 1000).toISOString());
            node.posts.push(listing('made-mid-read', 'Made between pages', new Date(Date.now() + 1000).toISOString()));
            node.posts = node.posts.filter(p => p.id !== leaves);
        };
        await sync();
        node.beforeRead = null;
        // Every listing that didn't change while the read paged is held after this one cycle.
        const titles = heldTitles();
        expect(changed.filter(p => p.id !== edited && titles.get(p.id) !== p.title).map(p => p.id)).toEqual([]);

        // The next delta asks from before the read began, so the changes made while it paged are in it.
        await sync();
        const after = heldTitles();
        expect(after.get(edited)).toBe('Edited between pages');
        expect(after.get('made-mid-read')).toBe('Made between pages');
        expect(changed.filter(p => p.id !== edited && after.get(p.id) !== p.title).map(p => p.id)).toEqual([]);
    });

    for (const [what, status, body] of [['fails', 500, '{"error":"busy"}'], ['is not a list', 200, '<html>proxy error</html>']] as const) {
        it(`a page that ${what}: what came is written, the read is held at that page, and the next cycle finishes it`, async () => {
            await phoneWithACursor();
            const cursorBefore = store.get(LAST_SYNC_KEY);
            const changed = many('chg', 450, Date.now());
            node.posts.push(...changed);
            node.broken = { read: 1, status, body };
            await sync();
            expect(postsReads()).toHaveLength(2);
            expect(held()).toHaveLength(201);
            expect(store.get(LAST_SYNC_KEY)).toBe(cursorBefore);
            const hold = JSON.parse(store.get(HELD_KEY)!);
            expect(new URL(postsReads()[1]).searchParams.get('pageAfter')).toBe(hold.after);

            node.broken = null;
            await sync();
            expect(postsReads()).toHaveLength(2);
            const titles = heldTitles();
            expect(changed.filter(p => titles.get(p.id) !== p.title)).toEqual([]);
            expect(Number(store.get(LAST_SYNC_KEY))).toBe(hold.startedAt);
            expect(store.has(HELD_KEY)).toBe(false);
        });
    }

    it('a 304 to the first page: one request, nothing written, and the cursor stays', async () => {
        await phoneWithACursor();
        const cursorBefore = store.get(LAST_SYNC_KEY);
        node.posts.push(...many('chg', 450, Date.now()));
        node.notModified = true;
        await sync();
        expect(postsReads()).toHaveLength(1);
        expect(held()).toHaveLength(1);
        expect(store.get(LAST_SYNC_KEY)).toBe(cursorBefore);
    });
});

describe('a whole pull of more than one page', () => {
    it('a first sync of a node with 450 listings writes all 450', async () => {
        const all = many('all', 450, Date.parse('2026-09-01T00:00:00.000Z'));
        node.posts = [...all];
        await sync();
        expect(postsReads()).toHaveLength(3);
        expect(postsReads().some(u => new URL(u).searchParams.has('updatedAfter'))).toBe(false);
        const titles = heldTitles();
        expect(all.filter(p => titles.get(p.id) !== p.title)).toEqual([]);
        expect(held()).toHaveLength(450);
    });

    it('a take-over with 450 held and the same 450 on the node: nothing is dropped, and what only the old server had goes', async () => {
        const all = many('all', 450, Date.parse('2026-09-01T00:00:00.000Z'));
        node.posts = [...all];
        await sync();
        expect(store.get(EPOCH_KEY)).toBe('0');
        // The old server's tail: a listing its standby never copied.
        const tail = listing('tail', 'Only the old server had this', new Date(Date.now() - 1000).toISOString());
        node.posts.push(tail);
        await sync();
        expect(heldTitles().has('tail')).toBe(true);

        // The standby takes over with the 450 and no tail.
        node.posts = [...all];
        node.epoch = '1';
        await sync();
        const titles = heldTitles();
        expect(all.filter(p => titles.get(p.id) !== p.title)).toEqual([]);
        expect(titles.has('tail')).toBe(false);
        expect(held()).toHaveLength(450);
        expect(store.get(EPOCH_KEY)).toBe('1');
    });

    it('a take-over whose whole pull changes between pages drops nothing the node still has', async () => {
        const all = many('all', 450, Date.parse('2026-09-01T00:00:00.000Z'));
        node.posts = [...all];
        await sync();
        node.epoch = '1';
        // all-00010 is on the third page of the new server's whole pull. Edited before the second page, it moves above
        // every key, so the pull never carries it; the read of what changed since the pull began does.
        const edited = 'all-00010';
        node.beforeRead = (n) => {
            if (n !== 2) return; // read 0 is the delta that saw the new epoch, read 1 the pull's first page: this is before its second
            const i = node.posts.findIndex(p => p.id === edited);
            node.posts[i] = listing(edited, 'Edited during the take-over pull', new Date(Date.now() + 1000).toISOString());
        };
        await sync();
        const titles = heldTitles();
        expect(titles.get(edited)).toBe('Edited during the take-over pull');
        expect(held()).toHaveLength(450);
        expect(store.get(EPOCH_KEY)).toBe('1');
    });
});

// A reset of the copy (Force Resync, "Wipe & Join Fresh", "Wipe Connection", the members-only drop) after a read was held:
// carried on below its key, a whole read never read the listings above it again, and the 200 newest stayed missing until
// each was edited (review of PR #1719, B1: R1, R2; R3 its delta twin).
describe('a reset after a held read', () => {
    /** app/(tabs)/settings.tsx Force Resync as it was: four cursors, then clearDB. The held read was not among them. */
    const forceResyncAsBefore = () => {
        for (const id of ['last-sync', 'checkpoint', 'members_last_sync', 'members_held_since']) store.delete(KEY(id));
        sql.exec('DELETE FROM posts');
        resetSyncFingerprints();
    };
    /** A fresh phone on a node of 450 listings whose whole read failed at its second page: 200 written, the rest held. */
    async function wholeReadHeldAtPage2() {
        const all = many('all', 450, Date.parse('2026-09-01T00:00:00.000Z'));
        node.posts = [...all];
        node.broken = { read: 1, status: 500, body: '{"error":"busy"}' };
        await sync();
        expect(held()).toHaveLength(PAGE);
        expect(JSON.parse(store.get(HELD_KEY)!).since).toBe('');
        node.broken = null;
        return all;
    }
    const missingOf = (all: Listing[]) => { const t = heldTitles(); return all.filter(p => !t.has(p.id)).map(p => p.id); };

    it('R1 Force Resync as it was (the hold not removed): the emptied cache drops the hold and the read starts again from page 1', async () => {
        const all = await wholeReadHeldAtPage2();
        forceResyncAsBefore();
        await sync();
        expect(new URL(postsReads()[0]).searchParams.has('pageAfter')).toBe(false);
        expect(missingOf(all)).toEqual([]);
        expect(store.has(HELD_KEY)).toBe(false);
        await sync();
        expect(missingOf(all)).toEqual([]);
        expect(held()).toHaveLength(450);
    });

    it('Force Resync removes the held read with the other cursors (syncCursorKeysOf), and so does a wipe (forgetSyncCursors)', async () => {
        expect(syncCursorKeysOf('beanpool_test.beanpool.org.db')).toEqual(expect.arrayContaining([LAST_SYNC_KEY, HELD_KEY]));
        expect(syncCursorKeysOf('beanpool_test.beanpool.org.db')).not.toContain(EPOCH_KEY);
        const all = await wholeReadHeldAtPage2();
        await forgetSyncCursors();
        expect(store.has(HELD_KEY)).toBe(false);
        expect(store.get(EPOCH_KEY)).toBe('0');
        sql.exec('DELETE FROM posts');
        resetSyncFingerprints();
        await sync();
        expect(new URL(postsReads()[0]).searchParams.has('pageAfter')).toBe(false);
        expect(missingOf(all)).toEqual([]);
    });

    it('R2 the members-only refusal drops the hold with the listings: re-admitted, the phone reads them all again', async () => {
        const all = await wholeReadHeldAtPage2();
        node.broken = { read: 0, status: 403, body: '{"error":"members only","code":"members_only"}' };
        const refused = await sync(false);
        expect(refused.errorMessage).toBe('members_only');
        expect(held()).toHaveLength(0);
        expect(store.has(HELD_KEY)).toBe(false);
        expect(store.has(LAST_SYNC_KEY)).toBe(false);
        node.broken = null;
        await sync();
        expect(new URL(postsReads()[0]).searchParams.has('pageAfter')).toBe(false);
        expect(missingOf(all)).toEqual([]);
        await sync();
        expect(missingOf(all)).toEqual([]);
    });

    it('R3 Force Resync while a delta is held: the whole pull lets the stale hold go, and the next cycle is a delta from the pull', async () => {
        await phoneWithACursor();
        node.posts.push(...many('chg', 450, Date.now()));
        node.broken = { read: 1, status: 500, body: '{"error":"busy"}' };
        await sync();
        expect(JSON.parse(store.get(HELD_KEY)!).since).not.toBe('');
        node.broken = null;
        forceResyncAsBefore();
        await sync();
        expect(held()).toHaveLength(451);
        expect(store.has(HELD_KEY)).toBe(false);
        const cursorAfterWhole = Number(store.get(LAST_SYNC_KEY));
        await sync();
        expect(new URL(postsReads()[0]).searchParams.has('pageAfter')).toBe(false);
        expect(Number(store.get(LAST_SYNC_KEY))).toBeGreaterThanOrEqual(cursorAfterWhole);
        expect(held()).toHaveLength(451);
    });
});

// A whole read that isn't a take-over's is written as it comes: the Market drew nothing until every page was in (51
// requests and 6.6 MB at 10,000 listings), and then one write of up to 10,000 rows held the sync lock (review of PR
// #1719, NB3). A take-over's still needs every page before its replace drops anything.
describe('a whole read written as it comes', () => {
    /** Before each later read of the cycle: the rows the phone held, and how often the screens had been told. */
    function watchBetweenReads() {
        const seen: Record<number, { rows: number; told: number }> = {};
        node.beforeRead = (n) => { seen[n] = { rows: held().length, told: told.filter(e => e === 'sync_data_updated').length }; };
        return seen;
    }

    it('a first sync of 450: page 1 is written and the screens told before page 2 is asked for, and each later page before the next', async () => {
        const all = many('all', 450, Date.parse('2026-09-01T00:00:00.000Z'));
        node.posts = [...all];
        const seen = watchBetweenReads();
        await sync();
        expect(seen[1]).toEqual({ rows: PAGE, told: 1 });
        expect(seen[2].rows).toBe(2 * PAGE);
        expect(held()).toHaveLength(450);
        expect(told.filter(e => e === 'sync_data_updated').length).toBeGreaterThanOrEqual(2);
        expect(store.has(HELD_KEY)).toBe(false);
        expect(store.get(LAST_SYNC_KEY)).toBeTruthy();
    });

    it('a whole read held at page 3: its two written pages stay, and the next cycle asks only for the held page', async () => {
        const all = many('all', 450, Date.parse('2026-09-01T00:00:00.000Z'));
        node.posts = [...all];
        node.broken = { read: 2, status: 500, body: '{"error":"busy"}' };
        await sync();
        expect(held()).toHaveLength(2 * PAGE);
        const hold = JSON.parse(store.get(HELD_KEY)!);
        expect(hold.since).toBe('');
        node.broken = null;
        await sync();
        expect(postsReads()).toHaveLength(1);
        expect(new URL(postsReads()[0]).searchParams.get('pageAfter')).toBe(hold.after);
        const t = heldTitles();
        expect(all.filter(p => t.get(p.id) !== p.title)).toEqual([]);
        expect(store.has(HELD_KEY)).toBe(false);
    });

    it('a take-over still writes only once every page is in: the old server\'s tail is held until the replace', async () => {
        const all = many('all', 450, Date.parse('2026-09-01T00:00:00.000Z'));
        node.posts = [...all];
        await sync();
        node.posts.push(listing('tail', 'Only the old server had this', new Date(Date.now() - 1000).toISOString()));
        await sync();
        node.posts = [...all];
        node.epoch = '1';
        const seen: Record<number, boolean> = {};
        node.beforeRead = (n) => { seen[n] = heldTitles().has('tail'); };
        await sync();
        // Read 0 saw the new epoch, read 1 is the pull's first page; before reads 2 and 3 nothing is written yet.
        expect([seen[2], seen[3]]).toEqual([true, true]);
        expect(heldTitles().has('tail')).toBe(false);
        expect(held()).toHaveLength(450);
        expect(store.get(EPOCH_KEY)).toBe('1');
    });
});

// A take-over's catch-up read (what changed since the pull began) can carry a photo heal's first page, the node's oldest
// listings among it. Counted toward the pull's oldest time, they made the replace drop every listing the node still has
// below a pull the page cap cut short, until the next cycle read them back (review of PR #1719, NB5; R6).
describe('a capped take-over and its catch-up read', () => {
    it('R6 old rows on the catch-up read count as the node\'s, never as the pull\'s: nothing it still has is dropped, even for a cycle', async () => {
        const all = many('all', POSTS_PAGE_CAP * PAGE + 300, Date.parse('2026-06-01T00:00:00.000Z'));
        node.posts = [...all];
        await sync(); await sync(); // two cycles: the cap's 50 pages, then the last 2
        expect(held()).toHaveLength(all.length);
        node.epoch = '1';
        let sawWhole = false;
        (globalThis as any).fetch = async (url: string) => {
            const r: any = await fetchMock(url);
            if (!url.includes('/api/marketplace/posts')) return r;
            const q = new URL(url).searchParams;
            if (!q.has('updatedAfter')) sawWhole = true;
            if (sawWhole && q.has('updatedAfter') && q.get('paged') === '1') {
                // The heal's first page rides on the catch-up: the node's oldest five listings.
                const rows = JSON.parse(await r.text());
                const body = JSON.stringify([...rows, ...[...node.posts].sort(order).slice(-5)]);
                return { ...r, text: async () => body, json: async () => JSON.parse(body) };
            }
            return r;
        };
        try {
            await sync();
            expect(held()).toHaveLength(all.length);
            expect(store.get(EPOCH_KEY)).toBe('1');
            await sync();
            expect(held()).toHaveLength(all.length);
        } finally {
            (globalThis as any).fetch = fetchMock;
        }
    }, 120_000);
});
