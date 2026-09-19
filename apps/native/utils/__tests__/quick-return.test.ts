import { describe, it, expect } from 'vitest';
import {
    INITIAL_QUICK_RETURN, QUICK_RETURN_THRESHOLD, quickReturnStep, quickReturnControlsHidden, quickReturnOffset,
    type QuickReturnState, type QuickReturnInput,
} from '../quick-return';

/** Feed a run of scroll positions through the step, as the list's onScroll would. */
function run(ys: number[], opts: Omit<QuickReturnInput, 'y'> = {}, from: QuickReturnState = INITIAL_QUICK_RETURN) {
    return ys.reduce((s, y) => quickReturnStep(s, { ...opts, y }), from);
}

describe('quick return: show/hide', () => {
    it('rides with the page on the way down and stays hidden deep in the list', () => {
        const s = run([0, 20, 60, 200, 900, 2400]);
        expect(s.revealed).toBe(false);
        expect(quickReturnControlsHidden(s, 250)).toBe(true);
    });

    it('comes back on an upward scroll past the threshold, wherever you are', () => {
        const down = run([0, 400, 1200, 2400]);
        const up = run([2400 - QUICK_RETURN_THRESHOLD], {}, down);
        expect(up.revealed).toBe(true);
        expect(quickReturnControlsHidden(up, 250)).toBe(false);
    });

    it('ignores upward jitter smaller than the threshold', () => {
        const down = run([0, 400, 1200]);
        const jitter = run([1197, 1195, 1193], {}, down); // 7dp up in total
        expect(jitter.revealed).toBe(false);
    });

    it('sums slow upward travel across events until it passes the threshold', () => {
        const down = run([0, 400, 1200]);
        expect(run([1197, 1194, 1191], {}, down).revealed).toBe(false); // 9dp
        expect(run([1197, 1194, 1191, 1189], {}, down).revealed).toBe(true); // 11dp
    });

    it('hides again after a downward scroll past the threshold', () => {
        const revealed = run([0, 1200, 1180]);
        expect(revealed.revealed).toBe(true);
        expect(run([1185], {}, revealed).revealed).toBe(true); // 5dp down: still shown
        expect(run([1185, 1190], {}, revealed).revealed).toBe(false); // 10dp down
    });

    it('a change of direction restarts the count', () => {
        const down = run([0, 1200]);
        // up 6, down 3, up 6: never 10 in one direction
        expect(run([1194, 1197, 1191], {}, down).revealed).toBe(false);
    });

    it('is always shown at the top of the list', () => {
        const s = run([0, 1200, 900, 0]);
        expect(s).toEqual(INITIAL_QUICK_RETURN);
        expect(quickReturnControlsHidden(s, 250)).toBe(false);
        // …and at the top both reveal states put the whole block on screen.
        expect(quickReturnOffset(0, 0, 44, 200)).toBeCloseTo(0);
        expect(quickReturnOffset(0, 1, 44, 200)).toBeCloseTo(0);
    });

    it('does not count the bounce back from the bottom (iOS overscroll) as an upward scroll', () => {
        const s = run([0, 1500, 1540, 1560, 1520, 1500], { maxY: 1500 });
        expect(s.revealed).toBe(false);
    });

    it('does not count a pull-to-refresh stretch (negative offset) as travel', () => {
        const s = run([0, -40, -80, -20, 0, 5]);
        expect(s.revealed).toBe(false);
        expect(quickReturnControlsHidden(s, 250)).toBe(false);
    });

    it('is not "hidden" (no chip) until the block has scrolled fully away', () => {
        expect(quickReturnControlsHidden(run([0, 100]), 250)).toBe(false);
        expect(quickReturnControlsHidden(run([0, 249]), 250)).toBe(false);
        expect(quickReturnControlsHidden(run([0, 250]), 250)).toBe(true);
        // Not measured yet: never hidden.
        expect(quickReturnControlsHidden(run([0, 900]), 0)).toBe(false);
    });
});

describe('quick return: fixed (screen reader, controls in use)', () => {
    it('a screen reader keeps the controls fixed however far down you scroll', () => {
        const s = run([0, 400, 1200, 2400, 5000], { fixed: true });
        expect(s.revealed).toBe(true);
        expect(quickReturnControlsHidden(s, 250)).toBe(false);
    });

    it('turning the screen reader on mid-list brings the controls back at once', () => {
        const hidden = run([0, 400, 1200]);
        expect(hidden.revealed).toBe(false);
        expect(quickReturnStep(hidden, { y: 1200, fixed: true }).revealed).toBe(true);
    });

    it('turning it off leaves them shown until the next scroll down', () => {
        const fixed = run([0, 1200], { fixed: true });
        expect(run([1205], {}, fixed).revealed).toBe(true);
        expect(run([1205, 1215], {}, fixed).revealed).toBe(false);
    });
});

describe('quick return: block offset', () => {
    const T = 44, H = 200;
    it('reveal 0 scrolls the whole block one-for-one until it is gone', () => {
        expect(quickReturnOffset(30, 0, T, H)).toBe(-30);
        expect(quickReturnOffset(T + H, 0, T, H)).toBe(-(T + H));
        expect(quickReturnOffset(5000, 0, T, H)).toBe(-(T + H));
    });
    it('reveal 1 lets the title go but pins the controls at the top', () => {
        expect(quickReturnOffset(30, 1, T, H)).toBe(-30); // title still leaving
        expect(quickReturnOffset(T, 1, T, H)).toBe(-T);
        expect(quickReturnOffset(5000, 1, T, H)).toBe(-T);
    });
});
