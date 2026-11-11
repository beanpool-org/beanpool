/**
 * The Market's "+ ADD POST" steps aside while the "one way back" card's actions rest in its band (utils/fab-band.ts;
 * PR #1452 re-review, finding 4). Measured on the emulator at 320dp × 1.3 (a 569dp-tall window): the actions at
 * 446-543dp, the button at 479-538dp.
 */
import { describe, it, expect } from 'vitest';
import { FAB_BAND_DP, FAB_BOTTOM_DP, FAB_CLEARANCE_MIN_DP, fabClearanceDp, fabStepsAside } from '../fab-band';

const H = 569;

describe('the floating button and the card\'s actions', () => {
    it('the Market\'s first view at 320dp × 1.3: the actions rest in the band, so the button steps aside', () => {
        expect(fabStepsAside({ top: 446, bottom: 543, scrollY: 0 }, 0, H)).toBe(true);
    });

    it('back as soon as the feed scrolls the actions above the band', () => {
        const at = { top: 446, bottom: 543, scrollY: 0 };
        expect(fabStepsAside(at, 40, H)).toBe(true);
        expect(fabStepsAside(at, 543 - (H - FAB_BAND_DP) + 1, H)).toBe(false);
        // Measured after a scroll: the offset then counts.
        expect(fabStepsAside({ top: 300, bottom: 397, scrollY: 146 }, 146, H)).toBe(false);
        expect(fabStepsAside({ top: 300, bottom: 397, scrollY: 146 }, 0, H)).toBe(true);
    });

    it('a big screen, or the card below the screen, or no card: the button stays', () => {
        expect(fabStepsAside({ top: 446, bottom: 543, scrollY: 0 }, 0, 800)).toBe(false);
        expect(fabStepsAside({ top: H, bottom: H + 97, scrollY: 0 }, 0, H)).toBe(false);
        expect(fabStepsAside(null, 0, H)).toBe(false);
    });
});

describe('the floating button and the end of the list', () => {
    // The button at 1.3x: 28dp of padding and a "+" about 31dp tall, standing 32dp above the bottom, so its top is ~91dp up.
    it('at 1.3x the last card clears the button\'s top, at 320dp and everywhere', () => {
        const buttonTop = FAB_BOTTOM_DP + 28 + 20 * 1.2 * 1.3;
        expect(fabClearanceDp(1.3)).toBeGreaterThan(buttonTop);
        expect(fabClearanceDp(1.3)).toBeGreaterThanOrEqual(FAB_CLEARANCE_MIN_DP);
    });

    it('grows with the system text size, so the biggest text still clears it', () => {
        expect(fabClearanceDp(2)).toBeGreaterThan(fabClearanceDp(1.3));
        expect(fabClearanceDp(2)).toBeGreaterThan(FAB_BOTTOM_DP + 28 + 20 * 1.2 * 2);
    });

    it('never less than the room the lists always had, and a bad scale reads as 1', () => {
        expect(fabClearanceDp(1)).toBe(FAB_CLEARANCE_MIN_DP);
        expect(fabClearanceDp(0.85)).toBe(FAB_CLEARANCE_MIN_DP);
        expect(fabClearanceDp(NaN)).toBe(FAB_CLEARANCE_MIN_DP);
        expect(fabClearanceDp(0)).toBe(FAB_CLEARANCE_MIN_DP);
    });
});

describe('the band follows where the screen ends', () => {
    it('a screen that ends 52dp above the window\'s bottom (a tab bar under it): the button floats 52dp higher, and so does its band', () => {
        const sceneBottom = H - 52;
        // The button now stands at about 426-485 (window coordinates). Actions at 400-440 reach under it, so it steps aside...
        expect(fabStepsAside({ top: 400, bottom: 440, scrollY: 0 }, 0, sceneBottom)).toBe(true);
        // ...which the window's bottom alone would have missed: its band starts 52dp lower, at 469.
        expect(fabStepsAside({ top: 400, bottom: 440, scrollY: 0 }, 0, H)).toBe(false);
    });
});
