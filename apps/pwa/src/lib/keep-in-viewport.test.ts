/**
 * shiftIntoViewport: SyncStatus' sentence under the chip stays on a 320 px screen wherever the chip sits. Measured before
 * the fix (#2097's follow-up): a chip at x≈223 in a 320 px header hung a 289 px sentence (130% text) over 223..512.
 */
import { describe, expect, it } from 'vitest';
import { shiftIntoViewport } from './keep-in-viewport';

const VIEWPORT = 320;

describe('shiftIntoViewport', () => {
    // At 100% text 16rem is 256 px and the gutter 12; at 130% the cap is 100vw - 1.5rem = 289 px and the gutter 15.6.
    const cases: Array<{ name: string; anchorLeft: number; width: number; gutter: number; shift?: number }> = [
        { name: 'chip on the left (mobile header today), 100% text', anchorLeft: 12, width: 256, gutter: 12, shift: 0 },
        { name: 'chip on the left, 130% text', anchorLeft: 15.6, width: 289, gutter: 15.6, shift: 0 },
        { name: 'short sentence near the right fits where it hangs', anchorLeft: 223, width: 80, gutter: 12, shift: 0 },
        { name: 'chip at x 223 (the measured case), 130% text', anchorLeft: 223, width: 289, gutter: 15.6 },
        { name: 'chip at x 223, 100% text', anchorLeft: 223, width: 256, gutter: 12 },
        { name: 'chip at the right edge', anchorLeft: 300, width: 256, gutter: 12 },
        { name: 'chip right of the screen', anchorLeft: 400, width: 200, gutter: 12 },
        { name: 'chip left of the screen', anchorLeft: -40, width: 200, gutter: 12 },
        { name: 'chip inside the left gutter keeps its edge', anchorLeft: 4, width: 200, gutter: 12, shift: 0 },
    ];

    it.each(cases)('$name: the box stays within 0..320', ({ anchorLeft, width, gutter, shift }) => {
        const moved = shiftIntoViewport({ anchorLeft, width, viewportWidth: VIEWPORT, gutter });
        const left = anchorLeft + moved;
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left + width).toBeLessThanOrEqual(VIEWPORT);
        if (shift !== undefined) expect(moved).toBe(shift);
    });

    it('a box that has to move keeps a gutter from the right edge, and the widest one fits between both gutters', () => {
        expect(223 + shiftIntoViewport({ anchorLeft: 223, width: 256, viewportWidth: VIEWPORT, gutter: 12 }) + 256).toBe(VIEWPORT - 12);
        expect(223 + shiftIntoViewport({ anchorLeft: 223, width: 289, viewportWidth: VIEWPORT, gutter: 15.5 })).toBeCloseTo(15.5);
    });

    it('nothing measured (no layout, as in jsdom): left where it hangs', () => {
        expect(shiftIntoViewport({ anchorLeft: 0, width: 0, viewportWidth: 0, gutter: 12 })).toBe(0);
        expect(shiftIntoViewport({ anchorLeft: 223, width: 289, viewportWidth: 0, gutter: 12 })).toBe(0);
        expect(shiftIntoViewport({ anchorLeft: 223, width: 0, viewportWidth: VIEWPORT, gutter: 12 })).toBe(0);
    });
});
