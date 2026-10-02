/**
 * The Market's "+ ADD POST" steps aside while the "one way back" card's actions rest in its band (utils/fab-band.ts;
 * PR #1452 re-review, finding 4). Measured on the emulator at 320dp × 1.3 (a 569dp-tall window): the actions at
 * 446-543dp, the button at 479-538dp.
 */
import { describe, it, expect } from 'vitest';
import { FAB_BAND_DP, fabStepsAside } from '../fab-band';

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
