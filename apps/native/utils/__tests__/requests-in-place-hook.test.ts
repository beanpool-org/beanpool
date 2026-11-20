// @vitest-environment jsdom
/**
 * Slice S3 (utils/requests-in-place.ts): while Chat's Message requests shows, each other community this phone holds where
 * requests wait is held in place and read there; it is let go when the list is left; a place with none waiting, or one that
 * can't be read in place, is never read; and a request that arrives there while the list shows is read too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

const calls = vi.hoisted(() => ({ log: [] as string[], lists: new Map<string, any>() }));
vi.mock('../db', () => ({
    enterChatInPlace: (c: string) => { calls.log.push(`enter ${c}`); },
    leaveChatInPlace: async (c: string) => { calls.log.push(`leave ${c}`); },
    requestsInPlace: async (_me: string, c: string) => { calls.log.push(`read ${c}`); return calls.lists.get(c) ?? null; },
}));

import { placesToReadInPlace, readRequestsInPlace, useRequestsInPlace } from '../requests-in-place';

const RIVER = 'https://riverside.example';
const HILL = 'https://hilltop.example';
const OPEN = 'https://opendoor.example';
const place = (url: string, count: number) => ({ address: url, url, name: url.slice(8), count });

beforeEach(() => {
    calls.log = [];
    calls.lists = new Map([[RIVER, { count: 1, conversations: [{ id: 'r1' }] }], [HILL, { count: 2, conversations: [{ id: 'h1' }, { id: 'h2' }] }]]);
});
afterEach(() => cleanup());

describe('which places are read in place', () => {
    it('only those with requests waiting, each once', () => {
        expect(placesToReadInPlace([place(RIVER, 1), place(HILL, 0), place(RIVER, 1), place(OPEN, 3)]).map((p) => p.url)).toEqual([RIVER, OPEN]);
        expect(placesToReadInPlace(null)).toEqual([]);
    });

    it('a place that can\'t be read in place is left out (its S0 card stays); a stop ends the reads', async () => {
        const read = await readRequestsInPlace('me', [place(RIVER, 1), place(OPEN, 3), place(HILL, 2)], () => true);
        expect(read.map((g) => [g.place.url, g.entries.map((e) => e.id)])).toEqual([[RIVER, ['r1']], [HILL, ['h1', 'h2']]]);
        let left = 1;
        calls.log = [];
        await readRequestsInPlace('me', [place(RIVER, 1), place(HILL, 2)], () => left-- > 0);
        expect(calls.log).toEqual([`read ${RIVER}`]);
    });

    it('each group keeps its read\'s count, which may be more than it lists (#3309 review F3)', async () => {
        calls.lists.set(RIVER, { count: 140, conversations: [{ id: 'r1' }] });
        const read = await readRequestsInPlace('me', [place(RIVER, 140), place(HILL, 2)], () => true);
        expect(read.map((g) => [g.place.url, g.count, g.entries.length])).toEqual([[RIVER, 140, 1], [HILL, 2, 2]]);
    });
});

describe('useRequestsInPlace: held while the list shows, let go after', () => {
    it('holds and reads each place with requests as the list opens, lets each go as it closes', async () => {
        const { result, rerender } = renderHook(({ shown, places }) => useRequestsInPlace('me', places, shown), {
            initialProps: { shown: false, places: [place(RIVER, 1), place(HILL, 0)] },
        });
        expect(calls.log).toEqual([]);
        rerender({ shown: true, places: [place(RIVER, 1), place(HILL, 0)] });
        await waitFor(() => expect(result.current[0].map((g) => g.place.url)).toEqual([RIVER]));
        expect(calls.log).toEqual([`enter ${RIVER}`, `read ${RIVER}`]);
        calls.log = [];
        rerender({ shown: false, places: [place(RIVER, 1), place(HILL, 0)] });
        await waitFor(() => expect(calls.log).toEqual([`leave ${RIVER}`]));
        expect(result.current[0]).toEqual([]);
    });

    it('a request arriving there while the list shows is read; the same counts again read nothing', async () => {
        const { result, rerender } = renderHook(({ places }) => useRequestsInPlace('me', places, true), { initialProps: { places: [place(RIVER, 1)] } });
        await waitFor(() => expect(result.current[0].length).toBe(1));
        calls.log = [];
        rerender({ places: [place(RIVER, 1)] });
        expect(calls.log).toEqual([]);
        calls.lists.set(RIVER, { count: 2, conversations: [{ id: 'r1' }, { id: 'r2' }] });
        rerender({ places: [place(RIVER, 2)] });
        await waitFor(() => expect(result.current[0][0].entries.map((e: any) => e.id)).toEqual(['r1', 'r2']));
        // Let go, then held again and read (the read waits for the close the let-go began, then opens it again: db.ts).
        expect(calls.log).toEqual([`leave ${RIVER}`, `enter ${RIVER}`, `read ${RIVER}`]);
    });

    it('no account on the phone: nothing held or read', () => {
        renderHook(() => useRequestsInPlace(null, [place(RIVER, 1)], true));
        expect(calls.log).toEqual([]);
    });
});
