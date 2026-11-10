import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/**
 * The replica column `event_repeat_skips` in db.ts (DESIGN-map-calendar-fable.md §4, §8 S2).
 * Verifies that:
 * 1. The column is in the copy's schema (utils/db.ts: a copy from before it is below COPY_SCHEMA and is read again whole).
 * 2. Syncing an event with cancelled skips (`eventRepeatSkips`) stores them as JSON in SQLite.
 * 3. `getPosts({ includeEvents: true })` and `getPosts({ type: 'event' })` read `event_repeat_skips` back.
 * 4. `persistEventView` updates `event_repeat_skips`.
 */

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

import { applyDelta, getDb, getPosts, persistEventView } from '../db';

const HOST = 'h'.repeat(64);

function eventPost(id: string, extra: Record<string, unknown> = {}) {
    return {
        id, type: 'event', category: 'community', title: `Event ${id}`, description: '', credits: 0,
        authorPublicKey: HOST, authorCallsign: 'Host',
        createdAt: '2026-11-01T01:00:00.000Z', updatedAt: '2026-11-01T01:00:00.000Z', active: true, status: 'active',
        audienceScope: 'public', photos: [],
        eventStartAt: '2026-11-07T09:00:00.000Z', eventEndAt: '2026-11-07T12:00:00.000Z',
        eventStartLocal: '2026-11-07T09:00', eventEndLocal: '2026-11-07T12:00',
        eventPlaceName: 'Hall', eventState: 'scheduled',
        eventRepeat: { freq: 'weekly', interval: 1, byDay: 'SA' },
        ...extra,
    };
}

const storedSkips = (id: string) => (sql.prepare('SELECT event_repeat_skips FROM posts WHERE id = ?').get(id) as any)?.event_repeat_skips;

beforeEach(async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
    await getDb();
    sql.exec('DELETE FROM posts');
});

describe('the replica column event_repeat_skips', () => {
    it('the copy\'s schema has the column, and a listing synced before any skip reads it as none', async () => {
        // 1. The schema makes it (no ALTER on open: a copy from before it is below COPY_SCHEMA and read again whole).
        const cols = (sql.prepare('PRAGMA table_info(posts)').all() as { name: string; type: string; dflt_value: unknown }[]);
        const col = cols.find(c => c.name === 'event_repeat_skips');
        expect(col).toMatchObject({ type: 'TEXT', dflt_value: null });

        // 2. Seed a post with no skips
        await applyDelta({ posts: [eventPost('ev-old', { title: 'Old Event' })] });

        // Verify existing rows are intact
        const existing = (await getPosts({ includeEvents: true })).find((p: any) => p.id === 'ev-old');
        expect(existing).toBeTruthy();
        expect(existing.title).toBe('Old Event');
        expect(existing.event_repeat_skips).toBeNull();

        // 4. Syncing new delta with skips writes to the new column
        await applyDelta({ posts: [eventPost('ev-old', { eventRepeatSkips: ['2026-11-14', '2026-11-21'], updatedAt: '2026-11-02T01:00:00.000Z' })] });
        expect(storedSkips('ev-old')).toBe('["2026-11-14","2026-11-21"]');

        const readBack = (await getPosts({ type: 'event' })).find((p: any) => p.id === 'ev-old');
        expect(readBack.event_repeat_skips).toBe('["2026-11-14","2026-11-21"]');
    });

    it('persistEventView updates event_repeat_skips on an existing post', async () => {
        await applyDelta({ posts: [eventPost('ev-view')] });
        expect(storedSkips('ev-view')).toBeNull();

        await persistEventView(eventPost('ev-view', { eventRepeatSkips: ['2026-11-28'] }), 'me-pub');
        expect(storedSkips('ev-view')).toBe('["2026-11-28"]');
    });
});
