// @vitest-environment jsdom
/**
 * Copy on request, the phone's half (Profile S4, scratch/fable-design/DESIGN-per-community-profile-fable.md §4).
 *
 * What the tap keeps, for which community, and what it reads and fetches to get it. The real pending-profile-sync runs on a
 * recorded AsyncStorage, so what is asserted is what really lands in storage: exactly what was ticked, under the chosen
 * community and no other, and nothing at all when the copy cannot be made whole.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({ store: new Map<string, string>(), writes: [] as string[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.writes.push(k); mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
const dbRow = vi.hoisted(() => ({ row: null as null | Record<string, unknown>, reads: 0 }));
vi.mock('../db', () => ({ getMemberProfile: vi.fn(async () => { dbRow.reads++; return dbRow.row; }) }));

import { COPY_PHOTO_MAX_BYTES, portablePhotoOf, queueProfileCopy, readCopySource, type CopySource } from '../profile-copy';
import { pendingProfileChange } from '../pending-profile-sync';
import { PENDING_PROFILE_STORE_PREFIX } from '../storage-keys';

const KEY = 'a'.repeat(64);
const HERE = 'https://first.example.test';
const OTHER = 'https://second.example.test';
const THIRD = 'https://third.example.test';
const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const NODE_THUMB = `/api/avatar/${KEY}?size=thumb&v=e3733e23&k=abc123`;

const entryOf = (community: string) => mem.store.get(`${PENDING_PROFILE_STORE_PREFIX}${community}`);

/** A response for a photo fetch: its bytes, and the type the community says they are. */
function photoResponse(type: string | null, bytes: number[] = [1, 2, 3, 4], ok = true) {
    return {
        ok,
        status: ok ? 200 : 404,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? type : null) },
        blob: async () => new Blob([new Uint8Array(bytes)], type ? { type } : undefined),
    };
}
const fetchMock = (res: ReturnType<typeof photoResponse>) => vi.fn(async () => res) as unknown as typeof fetch;

const source = (over: Partial<CopySource> = {}): CopySource => ({ from: HERE, callsign: 'Rosa', photoValue: DATA, photo: 'portable', ...over });

beforeEach(() => {
    mem.store.clear();
    mem.writes = [];
    mem.store.set('beanpool_anchor_url', HERE);
    dbRow.row = { public_key: KEY, callsign: 'Rosa', avatar_url: DATA };
    dbRow.reads = 0;
});

describe('readCopySource: this community\'s name and photo, read locally', () => {
    it('reads the row of the community the phone is on, and says where it read it', async () => {
        expect(await readCopySource(KEY)).toEqual({ from: HERE, callsign: 'Rosa', photoValue: DATA, photo: 'portable' });
    });

    it('tells a ready-made picture, an offline pick and the community\'s own picture URL apart from "no photo"', async () => {
        dbRow.row = { callsign: 'Rosa', avatar_url: 'bundled://bean-green' };
        expect((await readCopySource(KEY))?.photo).toBe('portable');
        dbRow.row = { callsign: 'Rosa', avatar_url: NODE_THUMB };
        expect(await readCopySource(KEY)).toMatchObject({ photo: 'node', photoValue: NODE_THUMB });
        for (const empty of [null, '', '  ', 'null', 'undefined']) {
            dbRow.row = { callsign: 'Rosa', avatar_url: empty };
            expect(await readCopySource(KEY)).toMatchObject({ photo: 'none', photoValue: null });
        }
        // A device-local path is no picture to copy anywhere.
        dbRow.row = { callsign: 'Rosa', avatar_url: 'file:///data/user/0/org.beanpool/cache/pic.jpg' };
        expect((await readCopySource(KEY))?.photo).toBe('none');
    });

    it('reads no name that is only a sentinel', async () => {
        dbRow.row = { callsign: 'null', avatar_url: DATA };
        expect((await readCopySource(KEY))?.callsign).toBeNull();
    });

    it('reads nothing, and writes nothing, when the phone has no community or no key', async () => {
        mem.store.delete('beanpool_anchor_url');
        expect(await readCopySource(KEY)).toBeNull();
        mem.store.set('beanpool_anchor_url', HERE);
        expect(await readCopySource('')).toBeNull();
        expect(mem.writes).toEqual([]);
    });

    it('is dropped when the phone moves on while the row is being read: it would be another community\'s', async () => {
        const db = await import('../db');
        (db.getMemberProfile as any).mockImplementationOnce(async () => { mem.store.set('beanpool_anchor_url', OTHER); return dbRow.row; });
        expect(await readCopySource(KEY)).toBeNull();
    });
});

describe('portablePhotoOf: the bytes of the photo, from the community it is read from and no other', () => {
    it('a value that can travel is itself, and nothing is fetched', async () => {
        const f = fetchMock(photoResponse('image/jpeg'));
        expect(await portablePhotoOf(source(), f)).toBe(DATA);
        expect(await portablePhotoOf(source({ photoValue: 'bundled://leaf' }), f)).toBe('bundled://leaf');
        expect(f).not.toHaveBeenCalled();
    });

    it('the community\'s own picture is fetched from that community at full size, unsigned, and its bytes are kept', async () => {
        const f = fetchMock(photoResponse('image/webp', [1, 2, 3, 4]));
        const got = await portablePhotoOf(source({ photoValue: NODE_THUMB, photo: 'node' }), f);
        expect(got).toBe('data:image/webp;base64,AQIDBA==');
        const [url, init] = (f as any).mock.calls[0];
        // The thumbnail size is taken off; the version and the key that go with the photo stay.
        expect(url).toBe(`${HERE}/api/avatar/${KEY}?v=e3733e23&k=abc123`);
        expect(init).not.toHaveProperty('headers');
        expect(init).not.toHaveProperty('method');
    });

    it('an absolute URL of the same community is read; one naming another node is not fetched at all', async () => {
        const f = fetchMock(photoResponse('image/jpeg'));
        expect(await portablePhotoOf(source({ photoValue: `${HERE}/api/avatar/${KEY}?size=thumb`, photo: 'node' }), f)).toMatch(/^data:image\/jpeg;base64,/);
        expect((f as any).mock.calls[0][0]).toBe(`${HERE}/api/avatar/${KEY}`);
        const g = fetchMock(photoResponse('image/jpeg'));
        expect(await portablePhotoOf(source({ photoValue: `${OTHER}/api/avatar/${KEY}?size=thumb`, photo: 'node' }), g)).toBeNull();
        expect(g).not.toHaveBeenCalled();
    });

    it('is no photo when the community does not give an image: a page, a missing photo, one too large, or no answer', async () => {
        const node = source({ photoValue: NODE_THUMB, photo: 'node' });
        expect(await portablePhotoOf(node, fetchMock(photoResponse('text/html', [60, 104])))).toBeNull();
        expect(await portablePhotoOf(node, fetchMock(photoResponse(null)))).toBeNull();
        expect(await portablePhotoOf(node, fetchMock(photoResponse('image/jpeg', [1], false)))).toBeNull();
        expect(await portablePhotoOf(node, fetchMock(photoResponse('image/jpeg', [])))).toBeNull();
        expect(await portablePhotoOf(node, vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
    });

    it('is no photo when the type is one the community\'s avatar service refuses: an SVG would be queued and then turned away', async () => {
        const node = source({ photoValue: NODE_THUMB, photo: 'node' });
        for (const type of ['image/svg+xml', 'image/x-icon', 'image/bmp', 'application/octet-stream']) {
            expect(await portablePhotoOf(node, fetchMock(photoResponse(type, [1, 2, 3])))).toBeNull();
        }
        for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'IMAGE/JPEG; charset=binary']) {
            expect(await portablePhotoOf(node, fetchMock(photoResponse(type, [1, 2, 3])))).toMatch(/^data:image\/(jpeg|png|webp|gif);base64,/);
        }
    });

    it('takes a photo up to 1 MiB and no more: the copy waits in AsyncStorage as base64, which Android reads badly near 2 MB', async () => {
        const node = source({ photoValue: NODE_THUMB, photo: 'node' });
        expect(COPY_PHOTO_MAX_BYTES).toBe(1024 * 1024);
        expect(await portablePhotoOf(node, fetchMock(photoResponse('image/jpeg', new Array(COPY_PHOTO_MAX_BYTES).fill(1))))).toMatch(/^data:image\/jpeg;base64,/);
        expect(await portablePhotoOf(node, fetchMock(photoResponse('image/jpeg', new Array(COPY_PHOTO_MAX_BYTES + 1).fill(1))))).toBeNull();
        // What a copy at the limit stores stays under the 2 MB the stored value must not reach.
        expect(Math.ceil(COPY_PHOTO_MAX_BYTES / 3) * 4).toBeLessThan(2 * 1024 * 1024);
    });

    it('is nothing when the row holds no photo', async () => {
        const f = fetchMock(photoResponse('image/jpeg'));
        expect(await portablePhotoOf(source({ photoValue: null, photo: 'none' }), f)).toBeNull();
        expect(f).not.toHaveBeenCalled();
    });
});

describe('queueProfileCopy: the tap keeps exactly what was ticked, for the community chosen', () => {
    it('name and photo: both are kept for the chosen community, as a copy', async () => {
        const out = await queueProfileCopy({ publicKey: KEY, source: source(), target: OTHER, choice: { name: true, photo: true } });
        expect(out).toEqual({ result: 'waits', sent: { callsign: 'Rosa', avatar: DATA } });
        expect(JSON.parse(entryOf(OTHER)!)).toEqual({ publicKey: KEY, callsign: 'Rosa', avatar: DATA, chosenOnly: true });
        expect(await pendingProfileChange(OTHER, KEY)).toMatchObject({ callsign: 'Rosa', avatar: DATA, chosenOnly: true });
    });

    it('the name alone keeps no photo, and the photo alone keeps no name', async () => {
        await queueProfileCopy({ publicKey: KEY, source: source(), target: OTHER, choice: { name: true, photo: false } });
        expect(JSON.parse(entryOf(OTHER)!)).toEqual({ publicKey: KEY, callsign: 'Rosa', chosenOnly: true });
        mem.store.delete(`${PENDING_PROFILE_STORE_PREFIX}${OTHER}`);
        await queueProfileCopy({ publicKey: KEY, source: source(), target: OTHER, choice: { name: false, photo: true } });
        expect(JSON.parse(entryOf(OTHER)!)).toEqual({ publicKey: KEY, avatar: DATA, chosenOnly: true });
    });

    it('writes under the chosen community only: not another saved one, and not the one it was read from', async () => {
        await queueProfileCopy({ publicKey: KEY, source: source(), target: OTHER, choice: { name: true, photo: true } });
        expect(mem.writes).toEqual([`${PENDING_PROFILE_STORE_PREFIX}${OTHER}`]);
        expect(entryOf(THIRD)).toBeUndefined();
        expect(entryOf(HERE)).toBeUndefined();
    });

    it('the photo of the community\'s own picture is fetched from the source, never from the chosen community', async () => {
        const f = fetchMock(photoResponse('image/jpeg'));
        const out = await queueProfileCopy({
            publicKey: KEY, source: source({ photoValue: NODE_THUMB, photo: 'node' }), target: OTHER, choice: { name: false, photo: true }, fetchImpl: f,
        });
        expect(out.result).toBe('waits');
        expect((f as any).mock.calls.map((c: any[]) => new URL(c[0]).origin)).toEqual([HERE]);
        expect(JSON.parse(entryOf(OTHER)!).avatar).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('nothing ticked keeps nothing and fetches nothing', async () => {
        const f = fetchMock(photoResponse('image/jpeg'));
        const out = await queueProfileCopy({
            publicKey: KEY, source: source({ photoValue: NODE_THUMB, photo: 'node' }), target: OTHER, choice: { name: false, photo: false }, fetchImpl: f,
        });
        expect(out).toEqual({ result: 'nothing', sent: null });
        expect(mem.writes).toEqual([]);
        expect(f).not.toHaveBeenCalled();
    });

    it('a photo that cannot be had keeps NOTHING, not even the name: the member decides', async () => {
        const out = await queueProfileCopy({
            publicKey: KEY, source: source({ photoValue: NODE_THUMB, photo: 'node' }), target: OTHER, choice: { name: true, photo: true },
            fetchImpl: fetchMock(photoResponse('image/jpeg', [1], false)),
        });
        expect(out).toEqual({ result: 'photo-unreadable', sent: null });
        expect(mem.writes).toEqual([]);
    });

    it('a copy to the community it was read from keeps nothing', async () => {
        const out = await queueProfileCopy({ publicKey: KEY, source: source(), target: `${HERE}/`, choice: { name: true, photo: true } });
        expect(out.result).toBe('same-community');
        expect(mem.writes).toEqual([]);
    });

    it('keeps nothing when the phone has moved on from the community the copy was read from', async () => {
        mem.store.set('beanpool_anchor_url', THIRD);
        const out = await queueProfileCopy({ publicKey: KEY, source: source(), target: OTHER, choice: { name: true, photo: true } });
        expect(out.result).toBe('moved');
        expect(mem.writes).toEqual([]);
    });

    it('keeps nothing for an address that is not a plain community address', async () => {
        const out = await queueProfileCopy({ publicKey: KEY, source: source(), target: 'https://user@evil.example.test', choice: { name: true, photo: true } });
        expect(out.result).toBe('not-a-community');
        expect(mem.writes).toEqual([]);
    });

    it('a copy stays a copy through the entry\'s other turns, and an ordinary change kept after it ends that', async () => {
        const { pendingNameAccepted, keepPendingProfileChange } = await import('../pending-profile-sync');
        await queueProfileCopy({ publicKey: KEY, source: source(), target: OTHER, choice: { name: true, photo: true } });
        // The name was sent (by a Save here, say) and accepted: the photo still waits, still as a copy.
        await pendingNameAccepted(OTHER);
        expect(JSON.parse(entryOf(OTHER)!)).toEqual({ publicKey: KEY, avatar: DATA, chosenOnly: true });
        // The member then changes something here themselves: it is an ordinary change, and goes with the row.
        await keepPendingProfileChange(OTHER, KEY, { callsign: 'Rosa Two' });
        expect(JSON.parse(entryOf(OTHER)!)).toEqual({ publicKey: KEY, avatar: DATA, callsign: 'Rosa Two' });
    });

    it('a copy asked for where a change already waits leaves that change as it is, and adds only what was ticked', async () => {
        mem.store.set(`${PENDING_PROFILE_STORE_PREFIX}${OTHER}`, JSON.stringify({ publicKey: KEY, callsign: 'Rosa Two' }));
        await queueProfileCopy({ publicKey: KEY, source: source(), target: OTHER, choice: { name: false, photo: true } });
        expect(JSON.parse(entryOf(OTHER)!)).toEqual({ publicKey: KEY, callsign: 'Rosa Two', avatar: DATA });
    });
});
