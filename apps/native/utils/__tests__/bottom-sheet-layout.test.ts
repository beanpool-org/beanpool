import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

// Rehearsal 5 Oct b, item 4: with an avatar picked, the footer took its height from the body (about 360 dp of content in a
// 300 dp body at 320 dp and 130% text), and the body stayed at its top: the avatars were cut at the footer's line.
describe('the Profile Photo sheet’s avatar row is never cut by the footer', () => {
    const sheet = fs.readFileSync(path.join(__dirname, '../../components/AvatarPickerSheet.tsx'), 'utf8');
    const bodyStart = sheet.indexOf('<ScrollView\n                        ref={bodyScrollRef}');
    const bodyEnd = sheet.indexOf('{/* Footer:');
    const body = sheet.slice(bodyStart, bodyEnd);

    it('the body scrolls to its end when its height changes with an avatar picked (the footer appearing)', () => {
        expect(bodyStart).toBeGreaterThan(0);
        expect(body).toMatch(/onLayout=\{\(\) => \{ if \(selectedAvatarId && !loading\) bodyScrollRef\.current\?\.scrollToEnd\(/);
    });

    it('the avatar row is the body’s last part, so its end is the whole row', () => {
        const row = body.indexOf('styles.avatarScrollWrap');
        expect(row).toBeGreaterThan(body.indexOf('styles.sectionTitle'));
        // From the row's wrap to the body's end, only the row's own parts (its avatars and its two arrows).
        const after = [...body.slice(row).matchAll(/styles\.(\w+)/g)].map((m) => m[1]);
        expect(after.length).toBeGreaterThan(1);
        expect(after.filter((name) => !name.startsWith('avatar'))).toEqual([]);
    });

    it('"Use Selected Avatar" stays in the footer, outside the scrolling body (the earlier fix)', () => {
        expect(body).not.toContain('Use Selected Avatar');
        expect(sheet.slice(bodyEnd)).toContain('Use Selected Avatar');
    });
});
