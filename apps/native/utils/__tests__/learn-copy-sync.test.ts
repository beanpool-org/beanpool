import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Local knowledge on the phone (DESIGN-local-knowledge-fable.md §4.3): the sync's one row writer puts a page in its own table,
// `knowledge_posts`, and never in `posts`, so nothing that reads `posts` (the Market, the map, the calendar) can meet one. Real
// SQL here, over node:sqlite, through the phone's own getDb/_doInitDB/applyDelta, as copy-clear-lock.test.ts does.

const h = vi.hoisted(() => ({ dir: '', anchor: 'https://valley.example.org', store: new Map<string, string>() }));

vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as SQLInputValue[];
    return {
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            const exec = async (q: string) => { sql.exec(q); };
            return {
                databasePath: name,
                execAsync: exec,
                getFirstAsync: async (q: string, p?: unknown) => (sql.prepare(q).get(...params(p)) as unknown) ?? null,
                getAllAsync: async (q: string, p?: unknown) => sql.prepare(q).all(...params(p)) as unknown[],
                runAsync: async (q: string, p?: unknown) => {
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                withTransactionAsync: async (task: () => Promise<void>) => {
                    await exec('BEGIN');
                    try { await task(); await exec('COMMIT'); } catch (e) { await exec('ROLLBACK'); throw e; }
                },
                closeAsync: async () => { sql.close(); },
            };
        }),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? h.anchor : h.store.get(k) ?? null)),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { for (const k of keys) h.store.delete(k); }),
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

import { applyDelta, closeDB, COPY_SCHEMA, getDb, getKnowledgePost, getKnowledgePosts, getPosts, initDB } from '../db';

globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-learn-copy-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
beforeEach(() => {
    h.dir = path.join(root, `phone-${++n}`);
    fs.mkdirSync(h.dir, { recursive: true });
    h.store.clear();
    h.anchor = 'https://valley.example.org';
});
afterEach(async () => { await closeDB(); });

const FILE = 'beanpool_valley.example.org.db';
const rows = async (sql: string) => (await getDb()).getAllAsync<any>(sql);

/** A listing as the node sends it (camelCase, as the posts read answers). */
function offer(id: string, over: Record<string, unknown> = {}) {
    return {
        id, type: 'offer', category: 'food', title: `Jam ${id}`, description: 'Plum jam.', creditsC: 0, authorPublicKey: 'a'.repeat(64),
        status: 'active', active: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
    };
}
/** A page of Local knowledge as the node sends it. */
function pageRow(id: string, over: Record<string, unknown> = {}) {
    return {
        id, type: 'knowledge', category: 'local-services', title: `Page ${id}`, description: 'The answer first.\nThen the details.',
        authorPublicKey: 'b'.repeat(64), authorCallsign: 'Bea', status: 'active', active: 1,
        createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
        knowledge: { sources: [{ url: 'https://example.org/tip', label: 'The council' }], place: 'The tip', lang: 'en', checkedAt: '2026-11-03T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 4, gathered: false },
        ...over,
    };
}

describe('the copy has a table for the pages', () => {
    it('makes knowledge_posts with the copy, and the schema number is 7 (5 with Learn, 6 and 7 with per-item prices)', async () => {
        expect(COPY_SCHEMA).toBe(7);
        await initDB();
        const tables = (await rows("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
        expect(tables).toContain('knowledge_posts');
        const columns = (await rows('PRAGMA table_info(knowledge_posts)')).map((c) => c.name);
        expect(columns).toEqual(['id', 'topic', 'post', 'checked_at', 'updated_at', 'active']);
        expect((await getDb().then((d) => d.getFirstAsync<{ user_version: number }>('PRAGMA user_version')))?.user_version).toBe(COPY_SCHEMA);
    });

    it("a 1.4.0 copy (schema 4) is cleared and read again whole: its cursor is forgotten, so the pages already on the node come", async () => {
        const old = new DatabaseSync(path.join(h.dir, FILE));
        old.exec(`PRAGMA journal_mode = WAL; CREATE TABLE posts (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT); INSERT INTO posts VALUES ('L1', 'offer', 'Jam'); PRAGMA user_version = 4;`);
        old.close();
        h.store.set(`pillar_sync_${FILE}_last-sync`, '1762800000000');
        await initDB();
        expect((await getDb().then((d) => d.getFirstAsync<{ user_version: number }>('PRAGMA user_version')))?.user_version).toBe(7);
        expect(await rows('SELECT id FROM posts')).toEqual([]);
        expect([...h.store.keys()].filter((k) => k.startsWith(`pillar_sync_${FILE}_`))).toEqual([]);
        expect(await rows('SELECT id FROM knowledge_posts')).toEqual([]);
    });
});

describe('the sync’s one writer sends a page to its own table and never to posts', () => {
    it('a delta of an offer and two pages: the offer in posts, the pages in knowledge_posts', async () => {
        await initDB();
        expect(await applyDelta({ posts: [offer('o1'), pageRow('k1'), pageRow('k2', { category: 'emergencies' })] })).toBe(true);
        expect((await rows('SELECT id, type FROM posts')).map((r) => `${r.id}:${r.type}`)).toEqual(['o1:offer']);
        expect((await rows('SELECT id, topic, active FROM knowledge_posts ORDER BY id')).map((r) => `${r.id}:${r.topic}:${r.active}`))
            .toEqual(['k1:local-services:1', 'k2:emergencies:1']);
    });

    it('the Market’s read of posts never meets a page, whatever it asks for', async () => {
        await initDB();
        await applyDelta({ posts: [offer('o1'), pageRow('k1')] });
        expect((await getPosts()).map((p: any) => p.id)).toEqual(['o1']);
        expect((await getPosts({ type: 'knowledge' })).map((p: any) => p.id)).toEqual([]);
        expect((await getPosts({ includeEvents: true, allScopes: true })).map((p: any) => p.id)).toEqual(['o1']);
    });

    it('keeps the page whole: the body, the sources, the place, the writer and the counts come back as the node sent them', async () => {
        await initDB();
        await applyDelta({ posts: [pageRow('k1')] });
        const held = await getKnowledgePost('k1');
        expect(held.title).toBe('Page k1');
        expect(held.description).toBe('The answer first.\nThen the details.');
        expect(held.knowledge.sources).toEqual([{ url: 'https://example.org/tip', label: 'The council' }]);
        expect(held.knowledge.place).toBe('The tip');
        expect(held.knowledge.helped).toBe(4);
        expect(held.authorCallsign).toBe('Bea');
        expect((await getKnowledgePosts()).map((p) => p.id)).toEqual(['k1']);
        expect(await rows('SELECT checked_at, updated_at FROM knowledge_posts')).toEqual([{ checked_at: '2026-11-03T00:00:00.000Z', updated_at: '2026-11-02T00:00:00.000Z' }]);
    });

    it('a changed page replaces its row (an edit, a new Checked date)', async () => {
        await initDB();
        await applyDelta({ posts: [pageRow('k1')] });
        await applyDelta({ posts: [pageRow('k1', { title: 'Page k1, corrected', updatedAt: '2026-11-05T00:00:00.000Z' })] });
        expect((await getKnowledgePosts()).map((p) => p.title)).toEqual(['Page k1, corrected']);
        expect(await rows('SELECT COUNT(*) AS n FROM knowledge_posts')).toEqual([{ n: 1 }]);
    });

    it('a page the node tombstones (taken down) or pauses leaves Learn at the next sync', async () => {
        await initDB();
        await applyDelta({ posts: [pageRow('k1'), pageRow('k2')] });
        await applyDelta({ posts: [pageRow('k1', { active: 0, status: 'cancelled' }), pageRow('k2', { status: 'paused' })] });
        expect(await getKnowledgePosts()).toEqual([]);
        expect(await getKnowledgePost('k1')).toBeNull();
        expect(await rows('SELECT id, active FROM knowledge_posts ORDER BY id')).toEqual([{ id: 'k1', active: 0 }, { id: 'k2', active: 0 }]);
    });

    it('a row with no id writes nothing and breaks nothing', async () => {
        await initDB();
        expect(await applyDelta({ posts: [{ type: 'knowledge', title: 'No id' }, offer('o1')] })).toBe(true);
        expect(await rows('SELECT id FROM knowledge_posts')).toEqual([]);
        expect((await rows('SELECT id FROM posts')).map((r) => r.id)).toEqual(['o1']);
    });
});

describe('after a take-over, and for a community that refuses the phone', () => {
    it('the whole pull replaces the pages too: a page the node no longer has, changed after the oldest row it sent, goes', async () => {
        await initDB();
        await applyDelta({ posts: [
            pageRow('keep', { updatedAt: '2026-11-04T00:00:00.000Z' }),
            pageRow('gone', { updatedAt: '2026-11-09T00:00:00.000Z' }),
            pageRow('older', { updatedAt: '2026-10-01T00:00:00.000Z' }),
        ] });
        // The new main server's pull: its oldest row is from 4 Nov, so it speaks for everything newer than that.
        await applyDelta({ posts: [offer('o1', { updatedAt: '2026-11-04T00:00:00.000Z' }), pageRow('keep', { updatedAt: '2026-11-04T00:00:00.000Z' })], postsReplace: true });
        expect((await rows('SELECT id FROM knowledge_posts ORDER BY id')).map((r) => r.id)).toEqual(['keep', 'older']);
    });

    it('a community that keeps its listings for its members leaves this phone no page either', async () => {
        await initDB();
        await applyDelta({ posts: [pageRow('k1')] });
        await applyDelta({ postsRefused: true });
        expect(await rows('SELECT id FROM knowledge_posts')).toEqual([]);
    });
});
