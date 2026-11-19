/**
 * The Settings sign-in's six digits (security inventory risk 2, 18 Nov: six digits, one try) on the approving phone: one
 * line, whole, at 320 dp and 1.3x text, in two groups ("047 193"). Measured from the screen's own constants, as
 * pair-device-behind-lock.test.ts measures the device pairing's digits.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const screen = () => fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'settings-signin.tsx'), 'utf8');

describe('the six digits on the approving phone', () => {
    it('fit one line at 320 dp and 1.3x text, with room to spare, and never wrap', () => {
        const src = screen();
        const font = Number(/const SIGNIN_DIGITS_FONT = (\d+);/.exec(src)?.[1]);
        const spacing = Number(/const SIGNIN_DIGITS_SPACING = (\d+);/.exec(src)?.[1]);
        const pad = Number(/const SHEET_PAD = (\d+);/.exec(src)?.[1]);
        expect(src).toMatch(/fontSize: SIGNIN_DIGITS_FONT, letterSpacing: SIGNIN_DIGITS_SPACING \}\]\}\s*numberOfLines=\{1\}\s*adjustsFontSizeToFit/);
        expect(src).toContain('{formatDigits(confirmCode)}');
        // A digit is 0.5625 em in Roboto and San Francisco; 0.62 em is the margin, and the space counts as a digit. letterSpacing
        // after every glyph, scaled with the text too, as the worst case. The sheet's border (1 dp each side) is in the margin.
        // formatDigits (utils/settings-signin.ts, its own test) shows them as "047 193": six digits and a space.
        const glyphs = '047 193'.length;
        const scale = 1.3;
        const width = glyphs * (font * scale * 0.62) + glyphs * (spacing * scale);
        const room = 320 - 2 * pad - 2;
        expect(width).toBeLessThan(room);
        expect(room - width).toBeGreaterThan(20);
    });
});
