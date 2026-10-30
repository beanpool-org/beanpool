/**
 * The Market's fill (Damo via Marty, 30 Oct): a near-empty list on a by-area node is filled underneath with the newest
 * from elsewhere, once, up to a page, and only while fewer than FILL_BELOW are shown near the member.
 */
import { describe, expect, it } from 'vitest';
import { FILL_BELOW, FILL_MAX, READ_TIMEOUT_MS, elsewhereFill, isNodePulsePost, wantsFill } from '../market-fill';

const posts = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

describe('market fill', () => {
    it('gives up after READ_TIMEOUT_MS (20 s)', () => {
        expect(READ_TIMEOUT_MS).toBe(20_000);
    });

    it('recognises a local Daily Pulse post and not one from elsewhere or an ordinary listing', () => {
        expect(isNodePulsePost({ authorCallsign: 'Daily Pulse' })).toBe(true);
        expect(isNodePulsePost({ author_callsign: 'Daily Pulse' })).toBe(true);
        expect(isNodePulsePost({ authorCallsign: 'Daily Pulse', originNode: 'node-2' })).toBe(false);
        expect(isNodePulsePost({ author_callsign: 'Daily Pulse', origin_node: 'node-2' })).toBe(false);
        expect(isNodePulsePost({ authorCallsign: 'Daily Pulse', _remoteNode: {} })).toBe(false);
        expect(isNodePulsePost({ authorCallsign: 'Alice' })).toBe(false);
        expect(isNodePulsePost(null)).toBe(false);
    });

    it('wants a fill below 8 shown and not from 8', () => {
        expect(FILL_BELOW).toBe(8);
        expect(wantsFill(0)).toBe(true);
        expect(wantsFill(7)).toBe(true);
        expect(wantsFill(8)).toBe(false);
        expect(wantsFill(40)).toBe(false);
    });

    it('nothing shown near: the whole of elsewhere, in its order', () => {
        const everywhere = posts('far', 5);
        expect(elsewhereFill([], everywhere)).toEqual(everywhere);
    });

    it('3 shown near: elsewhere without the 3 again', () => {
        const near = posts('near', 3);
        const everywhere = [near[1], ...posts('far', 4), near[0], near[2]];
        expect(elsewhereFill(near, everywhere).map(p => p.id)).toEqual(['far-0', 'far-1', 'far-2', 'far-3']);
    });

    it('8 or more shown near: no fill', () => {
        expect(elsewhereFill(posts('near', 8), posts('far', 10))).toEqual([]);
        expect(elsewhereFill(posts('near', 30), posts('far', 10))).toEqual([]);
    });

    it('a listing repeated in elsewhere comes once', () => {
        const everywhere = [{ id: 'a' }, { id: 'a' }, { id: 'b' }];
        expect(elsewhereFill([], everywhere).map(p => p.id)).toEqual(['a', 'b']);
    });

    it('never takes the whole list past a page', () => {
        const near = posts('near', 3);
        const fill = elsewhereFill(near, posts('far', 200));
        expect(fill).toHaveLength(FILL_MAX - 3);
        expect(near.length + fill.length).toBe(FILL_MAX);
        expect(elsewhereFill([], posts('far', 200))).toHaveLength(FILL_MAX);
    });
});
