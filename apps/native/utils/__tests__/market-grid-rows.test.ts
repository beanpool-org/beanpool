import { describe, expect, it } from 'vitest';
import { gridRows, type GridRow } from '../market-grid-rows';

/**
 * The phone's Market grid as rows (DESIGN-market-grid-sizes-fable.md §2.5, slice PG2): two tiles to a row, a poll a row of its
 * own (both cells, the phone's whole row; since 5 Nov 2026 at a tile row's height, its summary laid over a tile's invisible box:
 * poll-grid-tile-render.test.ts), packed as the web's dense grid packs it, so no cell is empty but the last, and no post is
 * drawn twice or dropped.
 */
const tile = (id: string, type = 'offer') => ({ id, type });
const poll = (id: string) => ({ id, type: 'poll' });
/** The rows as ids: a pair as its ids, a poll as `poll:<id>`. */
const shape = (rows: GridRow<{ id: string; type: string }>[]) => rows.map(r => ('poll' in r ? `poll:${r.poll.id}` : r.pair.map(p => p.id).join('+')));

describe('gridRows', () => {
    it('two tiles to a row, in their order; an odd last tile alone', () => {
        expect(shape(gridRows([tile('a'), tile('b'), tile('c'), tile('d'), tile('e')]))).toEqual(['a+b', 'c+d', 'e']);
        expect(shape(gridRows([tile('a'), tile('b')]))).toEqual(['a+b']);
        expect(gridRows([])).toEqual([]);
    });

    it('a poll is a row of its own (two cells, a tile row tall), where it comes when no tile waits for a partner', () => {
        expect(shape(gridRows([poll('p'), tile('a'), tile('b')]))).toEqual(['poll:p', 'a+b']);
        expect(shape(gridRows([tile('a'), tile('b'), poll('p'), tile('c'), tile('d')]))).toEqual(['a+b', 'poll:p', 'c+d']);
    });

    it('a poll that comes while a tile waits goes after that row, and the next tile fills the cell beside it (no empty cell)', () => {
        expect(shape(gridRows([tile('a'), poll('p'), tile('b'), tile('c')]))).toEqual(['a+b', 'poll:p', 'c']);
        expect(shape(gridRows([tile('a'), poll('p'), poll('q'), tile('b')]))).toEqual(['a+b', 'poll:p', 'poll:q']);
    });

    it('a poll after a last odd tile comes after it', () => {
        expect(shape(gridRows([tile('a'), poll('p')]))).toEqual(['a', 'poll:p']);
        expect(shape(gridRows([tile('a'), tile('b'), tile('c'), poll('p')]))).toEqual(['a+b', 'c', 'poll:p']);
    });

    it('events and every other kind are tiles', () => {
        expect(shape(gridRows([tile('e', 'event'), tile('n', 'need'), tile('o')]))).toEqual(['e+n', 'o']);
    });

    it('every post is drawn once, whatever the mix', () => {
        const kinds = ['offer', 'poll', 'event', 'poll', 'need', 'offer', 'poll', 'offer'];
        for (let n = 0; n <= kinds.length; n++) {
            const posts = kinds.slice(0, n).map((type, i) => ({ id: `x${i}`, type }));
            const drawn = gridRows(posts).flatMap(r => ('poll' in r ? [r.poll] : r.pair));
            expect(drawn.map(p => p.id).sort()).toEqual(posts.map(p => p.id).sort());
            // At most one row of a single tile, and it is the last pair row.
            const pairs = gridRows(posts).filter(r => 'pair' in r) as Extract<GridRow<{ id: string; type: string }>, { pair: unknown }>[];
            expect(pairs.slice(0, -1).every(r => r.pair.length === 2)).toBe(true);
        }
    });

    it('each row is marked as a row, with its first post\'s id as its key', () => {
        const rows = gridRows([tile('a'), tile('b'), poll('p'), { id: 7, type: 'offer' }]);
        expect(rows.every(r => r.isGridRow)).toBe(true);
        expect(rows.map(r => r.id)).toEqual(['a', 'p', '7']);
    });
});
