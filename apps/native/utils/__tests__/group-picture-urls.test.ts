/**
 * A group's own picture, and a crowdfund's photo, reach the phone as the node's URL for each (#1486).
 *
 * The node keeps a group's picture out of its row (group_pictures) and sends, in every group read and list, its URL:
 * `/api/groups/<id>/picture?v=<version>&k=<key>`, relative to the node and keyed on every node, as a member's photo is
 * sent since #1475. The crowdfund list sends each crowdfund's enterprise photo as its `/api/avatar/…` URL, never the
 * photo. The phone draws neither (a group shows its category's emoji, utils/your-groups.ts; a crowdfund's `photos` are
 * stored and never read), so what it must do is keep each field as the node sends it, in its copy and offline, where
 * avatarUri would put its node in front of it with the version and key intact.
 *
 * The phone's real database open (utils/db.ts getDb) runs here over real SQLite (node:sqlite) in a directory of this
 * test's own. The URLs are made by the node's own makers (@beanpool/core) with keys installed. Nothing contacts a
 * node: fetch is a stub that answers as the node does.
 */
import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { avatarUrlOf, configureAvatarKeys, configureGroupPictureKeys, groupPictureUrlOf } from '@beanpool/core';

const h = vi.hoisted(() => ({ dir: '', store: new Map<string, string>() }));

/** expo-sqlite over node:sqlite, opening files in this test's directory. */
vi.mock('expo-sqlite', async () => {
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const { join } = await import('node:path');
    const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
    return {
        get defaultDatabaseDirectory() { return `file://${h.dir}`; },
        openDatabaseAsync: vi.fn(async (name: string) => {
            const sql = new Sqlite(join(h.dir, name));
            return {
                runAsync: async (q: string, p?: unknown) => {
                    const r = sql.prepare(q).run(...params(p));
                    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
                },
                execAsync: async (q: string) => { sql.exec(q); },
                getAllAsync: async (q: string, p?: unknown) => sql.prepare(q).all(...params(p)),
                getFirstAsync: async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null,
                withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
                closeAsync: async () => { sql.close(); },
            };
        }),
    };
});
vi.mock('expo-file-system/legacy', async () => {
    const nodeFs = await import('node:fs');
    const local = (uri: string) => decodeURI(uri).replace(/^file:\/\//, '');
    return {
        cacheDirectory: 'file:///tmp/unused-cache/',
        getInfoAsync: vi.fn(async (uri: string) => ({ exists: nodeFs.existsSync(local(uri)) })),
        moveAsync: vi.fn(async () => {}),
        deleteAsync: vi.fn(async () => {}),
        makeDirectoryAsync: vi.fn(async () => {}),
        writeAsStringAsync: vi.fn(async () => {}),
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
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-image-manipulator', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

import { applyDelta, closeDB, fetchGroups, getDb } from '../db';
import { avatarUri } from '../image-processing';

const NODE = 'https://pictures.example';
const GROUP_KEY = 'GrOuPkEyGrOuPkEyGrOu_-';
const FACE_KEY = 'AbCdEfGhIjKlMnOpQrSt_-';
const SHOP = 'e'.repeat(64);

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-group-pictures-'));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

// Installed before the describes below make their URLs, as every node installs its group picture keyer at boot.
configureGroupPictureKeys(() => GROUP_KEY);
configureAvatarKeys(() => FACE_KEY);
afterAll(() => {
    configureGroupPictureKeys(null);
    configureAvatarKeys(null);
});

const fetchMock = vi.fn();
let phoneN = 0;
beforeEach(async () => {
    await closeDB();
    h.dir = path.join(root, `phone-${++phoneN}`);
    fs.mkdirSync(h.dir);
    h.store.clear();
    h.store.set('beanpool_anchor_url', NODE);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The node's answers, by path; anything else is 404. `null` throws, as a phone with no signal finds. */
function serve(answers: Record<string, unknown> | null) {
    fetchMock.mockImplementation(async (url: string) => {
        if (answers === null) throw new TypeError('Network request failed');
        const at = url.replace(NODE, '');
        if (!(at in answers)) return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
        return { ok: true, status: 200, json: async () => answers[at] };
    });
}

describe("a group's own picture is the node's URL, in the phone's copy and offline", () => {
    const seeds = groupPictureUrlOf('g-seeds', '1a2b3c4d')!;
    const groups = [
        { id: 'g-seeds', name: 'Seed Savers', slug: 'seed-savers', category: 'social', createdBy: SHOP, joinPolicy: 'open',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', avatarUrl: seeds },
        { id: 'g-leaf', name: 'Leaf', slug: 'leaf', category: 'guild', createdBy: SHOP, joinPolicy: 'open',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', avatarUrl: 'bundled://leaf' },
        { id: 'g-none', name: 'Plain', slug: 'plain', category: 'general', createdBy: SHOP, joinPolicy: 'open',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];

    it('the node makes the URL the phone is given: relative, versioned, keyed', () => {
        expect(seeds).toBe(`/api/groups/g-seeds/picture?v=1a2b3c4d&k=${GROUP_KEY}`);
    });

    it('the list keeps each picture as the node sent it, and its copy holds the URL, never a picture', async () => {
        serve({ '/api/groups': groups });
        const listed = await fetchGroups();
        expect(listed.map(g => g.avatarUrl)).toEqual([seeds, 'bundled://leaf', undefined]);
        const db = await getDb();
        const held = await db.getAllAsync<{ id: string; avatar_url: string | null }>('SELECT id, avatar_url FROM groups ORDER BY id');
        expect(held).toEqual([
            { id: 'g-leaf', avatar_url: 'bundled://leaf' },
            { id: 'g-none', avatar_url: null },
            { id: 'g-seeds', avatar_url: seeds },
        ]);
    });

    it('offline, the copy gives the same URL back, and avatarUri resolves it against the node with its version and key', async () => {
        serve({ '/api/groups': groups });
        await fetchGroups();
        serve(null);
        const offline = await fetchGroups();
        const byId = new Map(offline.map(g => [g.id, g.avatarUrl]));
        expect(byId.get('g-seeds')).toBe(seeds);
        expect(byId.get('g-leaf')).toBe('bundled://leaf');
        expect(byId.get('g-none')).toBeNull();
        const drawn = avatarUri(byId.get('g-seeds'), 'g-seeds', '2026-01-02T00:00:00.000Z', NODE)!;
        const u = new URL(drawn);
        expect(`${u.origin}${u.pathname}`).toBe(`${NODE}/api/groups/g-seeds/picture`);
        expect(u.searchParams.get('v')).toBe('1a2b3c4d');
        expect(u.searchParams.get('k')).toBe(GROUP_KEY);
    });

    it('a picture an older node still sends inline is kept as it is', async () => {
        const inline = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
        serve({ '/api/groups': [{ ...groups[0], avatarUrl: inline }] });
        expect((await fetchGroups())[0].avatarUrl).toBe(inline);
        expect(avatarUri(inline, 'g-seeds', undefined, NODE)).toBe(inline);
    });
});

describe("a crowdfund's photo is its enterprise photo's URL in the phone's copy", () => {
    it('the delta stores the list\'s photos as the node sent them: the URL, never a photo', async () => {
        const face = avatarUrlOf(SHOP, '5e6f7a8b')!;
        expect(face).toBe(`/api/avatar/${SHOP}?size=thumb&v=5e6f7a8b&k=${FACE_KEY}`);
        await getDb();
        const applied = await applyDelta({
            projects: [
                { id: SHOP, creatorPubkey: SHOP, title: 'Tool Library', description: 'Tools', photos: [face], goalAmount: 500, currentAmount: 0, status: 'ACTIVE', createdAt: '2026-01-01T00:00:00.000Z' },
                { id: 'f'.repeat(64), creatorPubkey: SHOP, title: 'No photo', description: '', photos: [], goalAmount: 100, currentAmount: 0, status: 'ACTIVE', createdAt: '2026-01-01T00:00:00.000Z' },
            ],
        });
        expect(applied).toBe(true);
        const db = await getDb();
        const held = await db.getAllAsync<{ id: string; photos: string | null }>('SELECT id, photos FROM projects ORDER BY id');
        expect(held).toEqual([
            { id: SHOP, photos: JSON.stringify([face]) },
            { id: 'f'.repeat(64), photos: '[]' },
        ]);
    });
});
