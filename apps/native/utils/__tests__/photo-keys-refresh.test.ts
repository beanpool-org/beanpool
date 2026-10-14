import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A node that starts keying its listings' photos (PR #1286), stops, or keys them with a new secret hands out new photo
// URLs for listings that did not otherwise change; the ones the phone holds answer 404. Opening a listing reads it again
// (utils/db.ts getPost), and the screen must reload when only its photos changed. A thumbnail that fails to load reads
// its listing again too (utils/photo-refresh.ts), bounded. Real SQL against the phone's real schema, as in
// live-post-apply.test.ts; device modules stubbed at the boundary.

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

// The screens are told to reload through require('react-native').DeviceEventEmitter, which node cannot load and no
// vi.mock reaches: answered at node's loader, and every emit recorded.
const emitted: string[] = [];
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: (name: string) => { emitted.push(name); } } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import AsyncStorage from '@react-native-async-storage/async-storage';
import { applyDelta, getDb, getPost, refreshPostForPhoto } from '../db';
import { MAX_PER_WINDOW, RETRY_AFTER_MS, WINDOW_MS, refreshListingAfterPhotoError, resetPhotoRefreshForTests } from '../photo-refresh';

const ANN = 'a'.repeat(64);
const KEYLESS = '/api/marketplace/posts/post-1/photos/0?v=1790000000000';
const KEYED = `${KEYLESS}&k=${'K'.repeat(22)}`;

function offer(extra: Record<string, unknown> = {}) {
    return {
        id: 'post-1', type: 'offer', category: 'food', title: 'Spare lemons', description: 'A bag', credits: 5,
        priceType: 'fixed', authorPublicKey: ANN, authorCallsign: 'Ann',
        createdAt: '2026-09-24T01:00:00.000Z', updatedAt: '2026-09-24T01:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public', lat: -28.5, lng: 153.4,
        photos: [KEYLESS], authorEnergyCycled: 12, authorFoundingNeeded: false,
        ...extra,
    };
}
const photosOf = (id = 'post-1') => (sql.prepare('SELECT photos FROM posts WHERE id = ?').get(id) as any)?.photos;
const answer = (posts: unknown[]) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => posts });
const flush = () => new Promise((r) => setTimeout(r, 0));

const fetchMock = vi.fn();
const OTHER = 'https://other.beanpool.org';
/** The community the phone is on (AsyncStorage's anchor), as a switch in use-communities.ts sets it. */
const anchorIs = (url: string) => vi.mocked(AsyncStorage.getItem).mockImplementation(async (k: string) => (k === 'beanpool_anchor_url' ? url : null));

beforeEach(async () => {
    emitted.length = 0;
    anchorIs(ANCHOR);
    resetPhotoRefreshForTests();
    fetchMock.mockReset().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) });
    (globalThis as any).fetch = fetchMock;
    await getDb();
    sql.exec('DELETE FROM posts');
});

describe('opening a listing whose photo URLs changed and nothing else', () => {
    it('stores the new URLs and tells the screen to reload', async () => {
        await applyDelta({ posts: [offer()] });
        emitted.length = 0;
        fetchMock.mockResolvedValue(answer([offer({ photos: [KEYED] })]));
        const shown = await getPost('post-1');
        expect(shown.photos).toEqual([`${ANCHOR}${KEYLESS}`]); // what was cached, until the read lands
        await vi.waitFor(() => expect(photosOf()).toBe(JSON.stringify([KEYED])));
        await vi.waitFor(() => expect(emitted).toContain('sync_data_updated'));
        const reloaded = await getPost('post-1');
        expect(reloaded.photos).toEqual([`${ANCHOR}${KEYED}`]);
    });

    it('does not tell it again when the listing is as cached (no reload loop)', async () => {
        await applyDelta({ posts: [offer({ photos: [KEYED] })] });
        emitted.length = 0;
        fetchMock.mockResolvedValue(answer([offer({ photos: [KEYED] })]));
        await getPost('post-1');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        for (let i = 0; i < 5; i++) await flush();
        expect(emitted).not.toContain('sync_data_updated');
    });

    it('tells it when a photo is added or taken away', async () => {
        await applyDelta({ posts: [offer({ photos: [KEYED] })] });
        emitted.length = 0;
        fetchMock.mockResolvedValue(answer([offer({ photos: [KEYED, KEYED.replace('/0?', '/1?')] })]));
        await getPost('post-1');
        await vi.waitFor(() => expect(emitted).toContain('sync_data_updated'));
        emitted.length = 0;
        fetchMock.mockResolvedValue(answer([offer({ photos: [] })]));
        await getPost('post-1');
        await vi.waitFor(() => expect(emitted).toContain('sync_data_updated'));
        expect(photosOf()).toBe('[]');
    });
});

describe('a thumbnail that fails to load reads its listing again, bounded', () => {
    const url = `${ANCHOR}${KEYLESS}`;

    it('reads it, stores the new URL and reloads the screens', async () => {
        await applyDelta({ posts: [offer()] });
        emitted.length = 0;
        fetchMock.mockResolvedValue(answer([offer({ photos: [KEYED] })]));
        expect(refreshListingAfterPhotoError('post-1', url)).toBe(true);
        await vi.waitFor(() => expect(photosOf()).toBe(JSON.stringify([KEYED])));
        await vi.waitFor(() => expect(emitted).toContain('sync_data_updated'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${ANCHOR}/api/marketplace/posts?id=post-1&sync=true`);
    });

    it('reads a URL that keeps failing once per RETRY_AFTER_MS, never in a loop', async () => {
        await applyDelta({ posts: [offer()] });
        fetchMock.mockResolvedValue(answer([offer()])); // the node answers the same URL: it stays broken
        const t0 = 1_000_000;
        expect(refreshListingAfterPhotoError('post-1', url, t0)).toBe(true);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await flush();
        for (const dt of [1, 1000, WINDOW_MS, RETRY_AFTER_MS - 1]) expect(refreshListingAfterPhotoError('post-1', url, t0 + dt)).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(refreshListingAfterPhotoError('post-1', url, t0 + RETRY_AFTER_MS)).toBe(true);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it('reads one listing at a time, and at most MAX_PER_WINDOW in a window across the app', async () => {
        fetchMock.mockImplementation(() => new Promise(() => {})); // never answers
        const t0 = 5_000_000;
        expect(refreshListingAfterPhotoError('post-1', url, t0)).toBe(true);
        expect(refreshListingAfterPhotoError('post-1', `${url}&other`, t0)).toBe(false); // that listing is in flight
        let started = 1;
        for (let i = 2; i <= MAX_PER_WINDOW + 5; i++) {
            if (refreshListingAfterPhotoError(`post-${i}`, `${ANCHOR}/api/marketplace/posts/post-${i}/photos/0?v=1`, t0 + i)) started++;
        }
        expect(started).toBe(MAX_PER_WINDOW);
        expect(refreshListingAfterPhotoError('post-99', `${ANCHOR}/api/marketplace/posts/post-99/photos/0?v=1`, t0 + WINDOW_MS)).toBe(true);
    });

    it("never reads another community's listing, or anything that is not a listing's photo", async () => {
        expect(refreshListingAfterPhotoError('post-1', 'file:///local/photo.jpg')).toBe(false);
        expect(refreshListingAfterPhotoError('post-1', `${ANCHOR}/api/members/x/avatar`)).toBe(false);
        expect(refreshListingAfterPhotoError(undefined, url)).toBe(false);
        // Another node's listing (a peer's, on the Market): the bound is spent, and nothing is fetched from this node.
        expect(refreshListingAfterPhotoError('post-1', `https://other.beanpool.org${KEYLESS}`)).toBe(true);
        for (let i = 0; i < 5; i++) await flush();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("a community switch in the middle of a read never writes one community's listing into another's cache", () => {
    const url = `${ANCHOR}${KEYLESS}`;
    /** The node's answer, once the member has switched to another community and its database is open. */
    const answerAfterSwitch = () => fetchMock.mockImplementation(async () => {
        anchorIs(OTHER);
        await getDb();
        return answer([offer({ photos: [KEYED] })]);
    });

    it('a thumbnail read: the switch lands while the read is out', async () => {
        await applyDelta({ posts: [offer()] });
        emitted.length = 0;
        answerAfterSwitch();
        expect(await refreshPostForPhoto('post-1', url)).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(photosOf()).toBe(JSON.stringify([KEYLESS]));
        expect(emitted).not.toContain('sync_data_updated');
    });

    it('a thumbnail read: the switch lands between reading the community and opening its database', async () => {
        await applyDelta({ posts: [offer()] });
        emitted.length = 0;
        fetchMock.mockResolvedValue(answer([offer({ photos: [KEYED] })]));
        // The first read of the anchor is the old community's; the database then opened is the new one's.
        vi.mocked(AsyncStorage.getItem)
            .mockImplementationOnce(async (k: string) => (k === 'beanpool_anchor_url' ? ANCHOR : null))
            .mockImplementation(async (k: string) => (k === 'beanpool_anchor_url' ? OTHER : null));
        expect(await refreshPostForPhoto('post-1', url)).toBe(false);
        expect(photosOf()).toBe(JSON.stringify([KEYLESS]));
        expect(emitted).not.toContain('sync_data_updated');
    });

    it("opening a listing: the refresh after the switch writes nothing", async () => {
        await applyDelta({ posts: [offer()] });
        emitted.length = 0;
        answerAfterSwitch();
        await getPost('post-1');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        for (let i = 0; i < 5; i++) await flush();
        expect(photosOf()).toBe(JSON.stringify([KEYLESS]));
        expect(emitted).not.toContain('sync_data_updated');
    });
});
