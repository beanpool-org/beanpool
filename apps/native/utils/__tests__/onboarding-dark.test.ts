import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lightColors, darkColors, palette } from '../../constants/colors';
import { onboardingColors } from '../onboarding-colors';

// Marty, 13 Oct 2026: the welcome and onboarding screens follow dark mode too (they were light-only on purpose).
// A screen that goes back to the static light `colors`, or to dark status-bar icons, fails here.

const ONBOARDING_SCREENS = ['app/welcome.tsx', 'app/recover-identity.tsx', 'app/profile-setup.tsx', 'app/node-mismatch.tsx'];
// Everything onboarding draws: the screens, the area step (profile setup, and Settings → Your area) and the parts welcome shows.
const ONBOARDING_FILES = [...ONBOARDING_SCREENS, 'app/your-area.tsx', 'components/AreaPicker.tsx'];
const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

function luminance(hex: string): number {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

describe('onboarding screens follow dark mode', () => {
    it.each(ONBOARDING_FILES)('%s draws from the light or dark tokens, not the static light colours', (rel) => {
        const src = read(rel);
        expect(src).toMatch(/useOnboardingColors\(\)/);
        expect(src).not.toMatch(/import\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*'\.\.\/constants\/colors'/);
        // Every style sheet is built inside makeStyles(colors, dark), none at module level from the light colours.
        const factory = src.indexOf('function makeStyles(colors: AppColors, dark: boolean)');
        expect(factory).toBeGreaterThan(-1);
        expect(src.indexOf('StyleSheet.create(')).toBeGreaterThan(factory);
    });

    it.each(ONBOARDING_SCREENS)('%s sets light status-bar icons in dark', (rel) => {
        const src = read(rel);
        expect(src).not.toContain('<StatusBar style="dark" />');
        expect(src).toContain("<StatusBar style={dark ? 'light' : 'dark'} />");
    });

    it('light draws exactly the classic light tokens, as before', () => {
        expect(onboardingColors('light')).toEqual({ colors: lightColors, dark: false });
    });

    it('dark draws the app dark tokens on a solid page, with muted text and strong borders raised', () => {
        const { colors, dark } = onboardingColors('dark');
        expect(dark).toBe(true);
        expect(colors.surface.page).toMatch(/^#/);
        expect(colors.text.muted).toBe(palette.gray400);
        expect(colors.border.strong).toBe(palette.gray500);
        // Everything else is the app dark tokens, unchanged.
        expect({ ...colors, text: { ...colors.text, muted: darkColors.text.muted }, border: { ...colors.border, strong: darkColors.border.strong } })
            .toEqual(darkColors);
    });

    describe('dark text reads at 4.5:1 or better on every onboarding surface', () => {
        const { colors } = onboardingColors('dark');
        const grounds = { page: colors.surface.page, card: colors.surface.card, subtle: colors.surface.subtle };
        // The token inks plus the dark branches welcome.tsx and profile-setup.tsx use for fixed palette colours.
        const inks = {
            heading: colors.text.heading,
            body: colors.text.body,
            secondary: colors.text.secondary,
            accent: palette.blue400,
            ok: palette.emerald400,
            warn: palette.amber400,
            danger: colors.feedback.danger.fg,
            // The 13 px consent note, the hints, the callsign tip and every placeholder draw with text.muted.
            muted: colors.text.muted,
        };
        for (const [inkName, ink] of Object.entries(inks)) {
            for (const [groundName, ground] of Object.entries(grounds)) {
                it(`${inkName} on ${groundName}: ${ink} on ${ground}`, () => {
                    expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
                });
            }
        }
        it('the info box text (accent ink on the info tint) reads', () => {
            expect(contrast(palette.blue400, colors.feedback.info.bg)).toBeGreaterThanOrEqual(4.5);
        });
        it('the Apple logo on the dark Recover-with-Social button reads at 3:1 (graphic)', () => {
            expect(read('app/welcome.tsx')).toContain("<AppleLogo size={16} color={dark ? palette.blue400 : '#1D4ED8'} />");
            expect(contrast(palette.blue400, colors.feedback.info.bg)).toBeGreaterThanOrEqual(3);
        });
        it('no onboarding screen hands a literal hex colour to a JSX prop without a dark branch', () => {
            for (const rel of ONBOARDING_FILES) {
                const bare = read(rel).split('\n').filter((l) => /=\s*"#[0-9a-fA-F]{3,8}"/.test(l));
                expect(bare, rel).toEqual([]);
            }
        });
        it('white on the filled blue buttons reads in both schemes', () => {
            expect(contrast('#ffffff', palette.blue600)).toBeGreaterThanOrEqual(4.5);
        });
    });

    describe('UI outlines and the stepper tick read at 3:1 or better', () => {
        it('the stepper tick reads on the green done-dot (fixed colours, the same in light and dark)', () => {
            const src = read('app/welcome.tsx');
            expect(src).toMatch(/dotCompleted: \{\s*backgroundColor: palette\.green500,/);
            expect(src).toMatch(/dotCheck: \{[^}]*color: palette\.green950,/);
            expect(contrast(palette.green950, palette.green500)).toBeGreaterThanOrEqual(3);
        });
        const { colors } = onboardingColors('dark');
        // Inputs are filled with the card (welcome) or app (profile setup) colour and sit on the card or the page.
        const grounds = { page: colors.surface.page, app: colors.surface.app, card: colors.surface.card, subtle: colors.surface.subtle };
        for (const [groundName, ground] of Object.entries(grounds)) {
            it(`dark input outline (border.strong ${colors.border.strong}) on ${groundName} ${ground}`, () => {
                expect(contrast(colors.border.strong, ground)).toBeGreaterThanOrEqual(3);
            });
        }
    });
});
