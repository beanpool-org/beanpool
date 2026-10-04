import { describe, it, expect } from 'vitest';
import { bottomSheetLayout, SHEET_MAX_SHARE, SHEET_TOP_GAP, SHEET_FOOTER_GAP } from '../bottom-sheet-layout';

// The rehearsal of 5 Oct (d1): "Use Selected Avatar" at y 812–854 on an 854-high screen, its label cut at the edge.
describe('the Profile Photo sheet’s layout', () => {
    it('the footer’s button sits above the gesture bar or the navigation buttons', () => {
        expect(bottomSheetLayout(854, { top: 24, bottom: 48 }).footerPaddingBottom).toBe(48 + SHEET_FOOTER_GAP);
        expect(bottomSheetLayout(854, { top: 24, bottom: 0 }).footerPaddingBottom).toBe(SHEET_FOOTER_GAP);
        expect(bottomSheetLayout(854, { top: 24, bottom: 48 }).footerPaddingBottom).toBeGreaterThan(48);
    });

    it('the sheet is capped below the status bar, so its header is never under it', () => {
        const { maxHeight } = bottomSheetLayout(854, { top: 24, bottom: 48 });
        expect(maxHeight).toBeLessThanOrEqual(854 * SHEET_MAX_SHARE);
        expect(maxHeight).toBeLessThanOrEqual(854 - 24 - SHEET_TOP_GAP);
        // A short window (landscape, split screen) with a tall status bar: the status bar wins over the share.
        expect(bottomSheetLayout(100, { top: 40, bottom: 0 }).maxHeight).toBe(100 - 40 - SHEET_TOP_GAP);
    });

    it('odd numbers from the platform never give a negative size', () => {
        expect(bottomSheetLayout(0, { top: 24, bottom: 0 }).maxHeight).toBe(0);
        expect(bottomSheetLayout(30, { top: 24, bottom: 0 }).maxHeight).toBe(0);
        expect(bottomSheetLayout(854, { top: -5, bottom: -5 })).toEqual({ maxHeight: 854 * SHEET_MAX_SHARE, footerPaddingBottom: SHEET_FOOTER_GAP });
        expect(bottomSheetLayout(Number.NaN, { top: Number.NaN, bottom: Number.NaN })).toEqual({ maxHeight: 0, footerPaddingBottom: SHEET_FOOTER_GAP });
    });
});
