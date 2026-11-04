/**
 * The browser's line for list photos (review of #2853, round 3): a browser runs at most 6 requests to one host at once and
 * the rest wait with no event, so a photo's wait starts at its turn in the line the page keeps, never before.
 */
import { describe, expect, it, vi } from 'vitest';
import { PHOTOS_AT_ONCE, joinPhotoLine, photoLineFor } from './list-photo-line';

const photo = (i: number, host = '') => `${host}/api/marketplace/posts/p${i}/photos/0?v=1&k=K${i}&size=thumb2`;

describe('joinPhotoLine', () => {
    it('gives the first 6 for a host their turn at once and the rest none until one ahead leaves', () => {
        expect(PHOTOS_AT_ONCE).toBe(6);
        const turns = Array.from({ length: 8 }, () => vi.fn());
        const leaves = turns.map((onTurn, i) => joinPhotoLine(photo(i), onTurn));
        expect(turns.map((t) => t.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
        expect(photoLineFor(photo(0))).toEqual({ waiting: 8, started: 6 });

        leaves[2]();
        expect(turns.map((t) => t.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
        // A turn is given once: leaving again, or another leaving, never calls it twice.
        leaves[2]();
        leaves[0]();
        expect(turns.map((t) => t.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);

        for (const leave of leaves) leave();
        expect(photoLineFor(photo(0))).toEqual({ waiting: 0, started: 0 });
    });

    it('a photo that leaves before its turn never gets one, and frees no turn for another', () => {
        const turns = Array.from({ length: 8 }, () => vi.fn());
        const leaves = turns.map((onTurn, i) => joinPhotoLine(photo(i), onTurn));
        leaves[7]();
        expect(turns[7]).not.toHaveBeenCalled();
        expect(turns[6]).not.toHaveBeenCalled();
        leaves[1]();
        expect(turns[6]).toHaveBeenCalledTimes(1);
        expect(turns[7]).not.toHaveBeenCalled();
        for (const leave of leaves) leave();
    });

    it('a photo that moves to a new URL joins the back of the line, as the browser\'s new request does', () => {
        const turns = Array.from({ length: 7 }, () => vi.fn());
        const leaves = turns.map((onTurn, i) => joinPhotoLine(photo(i), onTurn));
        // The first steps down: it leaves, and its next URL joins behind the 7th, which now has its turn.
        leaves[0]();
        const again = vi.fn();
        const leaveAgain = joinPhotoLine(`${photo(0)}&retry=1`, again);
        expect(turns[6]).toHaveBeenCalledTimes(1);
        expect(again).not.toHaveBeenCalled();
        leaves[3]();
        expect(again).toHaveBeenCalledTimes(1);
        for (const leave of [...leaves, leaveAgain]) leave();
    });

    it('each host has its own line; the relative URL and the page\'s own host share one', () => {
        const here = Array.from({ length: 6 }, () => vi.fn());
        const leaves = here.map((onTurn, i) => joinPhotoLine(photo(i), onTurn));
        const sameHost = vi.fn();
        leaves.push(joinPhotoLine(photo(9, location.origin), sameHost));
        const otherHost = vi.fn();
        leaves.push(joinPhotoLine(photo(9, 'https://node.example'), otherHost));
        expect(sameHost).not.toHaveBeenCalled();
        expect(otherHost).toHaveBeenCalledTimes(1);
        for (const leave of leaves) leave();
    });

    it('a photo that needs no request to a host (data:, blob:) has its turn at once and holds no place', () => {
        const leaves = Array.from({ length: 6 }, (_, i) => joinPhotoLine(photo(i), vi.fn()));
        const local = vi.fn();
        leaves.push(joinPhotoLine('data:image/png;base64,iVBORw0KGgo=', local));
        expect(local).toHaveBeenCalledTimes(1);
        expect(photoLineFor(photo(0))).toEqual({ waiting: 6, started: 6 });
        for (const leave of leaves) leave();
    });
});
