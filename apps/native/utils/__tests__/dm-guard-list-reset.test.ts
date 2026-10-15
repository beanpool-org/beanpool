/**
 * The DM guard list's reset under its caps (§3.4 amendment 8 §4, GR4), on the module itself with a plain storage map: the
 * marker and the seeded value each stay within 1 MiB; the pins' ids are all kept first, then the salvage, and the file's
 * rows only after both, refused past the cap and logged. db.ts's wiring is dm-line-binding's GR1-GR5.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDmSeenList, DM_SEEN_MAX_BYTES, salvageSeenIds } from '../dm-guard-list';
import { dmConversationsSeenStoreKey, dmConversationsSeenSetAsideStoreKey } from '../storage-keys';

const ME = 'a'.repeat(64);
const FILE = 'beanpool_mullum.beanpool.org.db';
const KEY = dmConversationsSeenStoreKey(ME, FILE);

function memoryStorage() {
    const store = new Map<string, string>();
    return {
        store,
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    };
}

describe('the DM guard list\'s reset under its caps (GR4)', () => {
    it('GR4 2,000 pins\' ids, a 1 MiB salvage and 30,000 rows: the marker and the seeded value within 1 MiB; every pin id kept, then the salvage, rows refused past the cap and logged', async () => {
        const storage = memoryStorage();
        const list = createDmSeenList(storage);
        const pinIds = Array.from({ length: 2000 }, () => randomUUID());
        // A corrupt value of about 1 MiB: 27,000 ids and a broken tail.
        const salvaged = Array.from({ length: 27_000 }, () => randomUUID());
        const corrupt = JSON.stringify(salvaged).slice(0, -1) + ', {broken';
        storage.store.set(KEY, corrupt);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(await list.reset(ME, FILE, pinIds)).toBe('set-aside');
            expect(storage.store.get(dmConversationsSeenSetAsideStoreKey(ME, FILE))).toBe(corrupt);
            const marker = storage.store.get(KEY)!;
            expect(Buffer.byteLength(marker)).toBeLessThanOrEqual(DM_SEEN_MAX_BYTES);
            const keep: string[] = JSON.parse(marker).keep;
            expect(keep.slice(0, 2000)).toEqual(pinIds);
            expect(keep.slice(2000)).toEqual(salvaged.slice(0, keep.length - 2000));
            expect(warn.mock.calls.some((c) => String(c[0]).includes("couldn't be kept at the reset"))).toBe(true);
            const rows = Array.from({ length: 30_000 }, () => randomUUID());
            const seeded = await list.read(ME, FILE, async () => rows);
            const value = storage.store.get(KEY)!;
            expect(Buffer.byteLength(value)).toBeLessThanOrEqual(DM_SEEN_MAX_BYTES);
            expect(seeded.slice(0, keep.length)).toEqual(keep);
            expect(seeded.slice(keep.length)).toEqual(rows.slice(0, seeded.length - keep.length));
            expect(seeded.length - keep.length).toBeLessThan(rows.length);
            expect(warn.mock.calls.some((c) => String(c[0]).includes("couldn't be remembered: this community's list is full"))).toBe(true);
        } finally { warn.mockRestore(); }
    });

    it('a marker\'s keep before the rows when both fit; the salvage reads each whole string literal and skips the broken one', async () => {
        const storage = memoryStorage();
        const list = createDmSeenList(storage);
        const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
        storage.store.set(KEY, `["${a}", "${b.slice(0, 10)}\u0000${b.slice(10)}", "${c}", "trunc`);
        // b's literal is damaged: it alone is lost; c after it is kept, and the cut-off tail is not an id.
        expect(salvageSeenIds(storage.store.get(KEY)!)).toEqual([a, c]);
        expect(await list.reset(ME, FILE, ['pinned'])).toBe('set-aside');
        expect(await list.read(ME, FILE, async () => ['row-1', a])).toEqual(['pinned', a, c, 'row-1']);
        expect(JSON.parse(storage.store.get(KEY)!)).toEqual(['pinned', a, c, 'row-1']);
    });

    it('a value storage can\'t return is removed (nothing set aside) and the marker written; pins that couldn\'t be read keep nothing first, and say so', async () => {
        const storage = memoryStorage();
        const list = createDmSeenList(storage);
        storage.store.set(KEY, '["x"]');
        storage.getItem.mockImplementationOnce(async () => { throw new Error('Row too big to fit into CursorWindow'); });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(await list.reset(ME, FILE, null)).toBe('unreadable-removed');
            expect(storage.removeItem).toHaveBeenCalledWith(KEY);
            expect(storage.store.has(dmConversationsSeenSetAsideStoreKey(ME, FILE))).toBe(false);
            expect(JSON.parse(storage.store.get(KEY)!).keep).toEqual([]);
            expect(warn.mock.calls.some((c) => String(c[0]).includes('The DM pins could not be read at the reset'))).toBe(true);
        } finally { warn.mockRestore(); }
    });

    // #1938 confirmation 9, finding 4 (M6): the salvage reads only literals standing as array elements. Taking any literal,
    // one lost or extra quote pairs every quote after it the wrong way round: the ids after it lost, and the text between
    // two ids (`","`, an id with its comma) added as ids.
    for (const [what, damage] of [
        ['one closing quote lost', (raw: string, id: string) => { const q = raw.indexOf(id) + id.length; return raw.slice(0, q) + raw.slice(q + 1); }],
        ['one opening quote lost', (raw: string, id: string) => { const q = raw.indexOf(id) - 1; return raw.slice(0, q) + raw.slice(q + 1); }],
        ['one extra quote', (raw: string, id: string) => { const q = raw.indexOf(id); return raw.slice(0, q) + '"' + raw.slice(q); }],
    ] as const) {
        it(`GR4q (${what}) in an honest list of ten: only the damaged id is lost, every id after it kept, no junk id added, and the reset keeps them after the pins'`, async () => {
            const ids = Array.from({ length: 10 }, () => randomUUID());
            const damaged = damage(JSON.stringify(ids), ids[3]);
            const intact = ids.filter((_, i) => i !== 3);
            const got = salvageSeenIds(damaged);
            expect(got).toEqual(intact);
            const storage = memoryStorage();
            const list = createDmSeenList(storage);
            storage.store.set(KEY, damaged);
            expect(await list.reset(ME, FILE, ['pinned'])).toBe('set-aside');
            expect(JSON.parse(storage.store.get(KEY)!).keep).toEqual(['pinned', ...intact]);
            expect(await list.read(ME, FILE, async () => [])).toEqual(['pinned', ...intact]);
        });
    }
});
