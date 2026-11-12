import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_SETS, brandColours, brandGrounds, brandScheme } from '@beanpool/core';
import { COLOUR_SETS, darkColors, doodleGround, lightColors } from '../../constants/colors';
import { drawnColours } from '../drawn-colours';
import { onboardingColors } from '../onboarding-colors';

/**
 * Colour themes T2 (scratch/fable-design/DESIGN-themes-fable.md §7; Marty and Damo, 12 Nov 2026): constants/colors.ts
 * builds one tree per colour set of the library, and Classic does not move.
 *
 * fixtures/phone-colours-main-5ab8b7dc.json was written from main 5ab8b7dc's lightColors and darkColors before any edit
 * (the branch's first commit). Light and Classic dark must deep-equal it, key order too.
 */
const MAIN = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'phone-colours-main-5ab8b7dc.json'), 'utf8')) as {
    lightColors: unknown;
    darkColors: unknown;
};

/** Every leaf path where two trees differ (both are plain objects of strings). */
function diffPaths(a: unknown, b: unknown, at = ''): string[] {
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b ? [] : [at];
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k));
}

/**
 * Where the phone's Dark (`night`) tree differs from Classic dark, and the library role each one reads. A set changes only
 * what the library gives it (the 17 themed leaves of brand-colours.ts, the phone's card among the grounds); nothing local
 * to colors.ts. A new path here is a role that started following the set, and is listed with the library leaf it reads.
 */
const NIGHT_PATHS: Record<string, (set: 'dark' | 'night') => string> = {
    'text.onAccent': (s) => brandColours(s).accent.on,
    'surface.card': (s) => brandGrounds(s).phone.card,
    'accent.primary': (s) => brandColours(s).ink.accent,
    'accent.fill': (s) => brandColours(s).accent.fill,
    'accent.tint': (s) => brandColours(s).chip.accent.tint,
    'accent.border': (s) => brandColours(s).chip.accent.border,
    'chip.quiet.fg': (s) => brandColours(s).chip.quiet.ink,
    'chip.quiet.bg': (s) => brandColours(s).chip.quiet.tint,
    'tile.general.tint': (s) => brandColours(s).tile.general.tint,
    'tile.general.ink': (s) => brandColours(s).tile.general.ink,
    'card.sage.tint': (s) => brandColours(s).card.sage.tint,
    'card.sage.ink': (s) => brandColours(s).card.sage.ink,
    'chat.quoteTextMe': (s) => brandColours(s).bubble.ink,
    'chat.messageMeBg': (s) => brandColours(s).bubble.tint,
    'chat.messageTextMe': (s) => brandColours(s).bubble.ink,
};

const get = (tree: unknown, path: string) => path.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], tree);

describe("the phone's colour sets: one tree per set of the library, Classic unchanged", () => {
    it('lightColors and darkColors deep-equal main, key order too', () => {
        expect(lightColors).toEqual(MAIN.lightColors);
        expect(darkColors).toEqual(MAIN.darkColors);
        expect(JSON.stringify(lightColors)).toBe(JSON.stringify(MAIN.lightColors));
        expect(JSON.stringify(darkColors)).toBe(JSON.stringify(MAIN.darkColors));
    });

    it('has a tree for every set of the library, light and Classic being lightColors and darkColors themselves', () => {
        expect(Object.keys(COLOUR_SETS)).toEqual([...BRAND_SETS]);
        expect(COLOUR_SETS.light).toBe(lightColors);
        expect(COLOUR_SETS.dark).toBe(darkColors);
    });

    it('Dark (night) is Classic dark with only the library\'s themed values swapped in', () => {
        expect(diffPaths(darkColors, COLOUR_SETS.night).sort()).toEqual(Object.keys(NIGHT_PATHS).sort());
        for (const [path, leaf] of Object.entries(NIGHT_PATHS)) {
            expect(get(darkColors, path), `Classic ${path}`).toBe(leaf('dark'));
            expect(get(COLOUR_SETS.night, path), `Dark ${path}`).toBe(leaf('night'));
        }
        // Can fail: a tree with one local value changed shows up as a path the library does not explain.
        const tampered = { ...COLOUR_SETS.night, text: { ...COLOUR_SETS.night.text, muted: '#123456' } };
        expect(diffPaths(darkColors, tampered)).toContain('text.muted');
    });

    it('the trees read the card, the sunken row, the page and the own bubble from the library', () => {
        for (const set of BRAND_SETS) {
            const tree = COLOUR_SETS[set];
            const g = brandGrounds(set).phone;
            expect([tree.surface.app, tree.surface.page, tree.surface.chrome, tree.surface.card, tree.surface.subtle], set)
                .toEqual([g.page, g.page, g.page, g.card, g.sunken]);
            expect([tree.chat.messageMeBg, tree.chat.messageTextMe], set).toEqual([brandColours(set).bubble.tint, brandColours(set).bubble.ink]);
        }
        const src = readFileSync(join(__dirname, '..', '..', 'constants', 'colors.ts'), 'utf8');
        // No local hex left for the grounds and the bubble: main's literals for them are gone from the file.
        for (const hex of ['#222822\'', "'#1e2923'", "'#d8f2e1'", "'#e6f4ea'", "'#1e291e'", "'#f1efea'", "'#faf9f6'"]) {
            expect(src.split('\n').filter((l) => l.includes(hex) && !l.trim().startsWith('//') && !l.includes('charcoal850:')), hex).toEqual([]);
        }
    });
});

describe('ThemeContext draws the set\'s tree; theme stays its scheme', () => {
    it('reads the doodle ground from the library, the same colours main drew (PATTERN_GROUND in ThemeContext.tsx)', () => {
        expect(doodleGround('light')).toBe('#f1f1e4');
        expect(doodleGround('dark')).toBe('#141a1a');
        expect(doodleGround('night')).toBe(brandGrounds('night').doodle.ground);
        const ctx = readFileSync(join(__dirname, '..', '..', 'app', 'ThemeContext.tsx'), 'utf8');
        expect(ctx, 'ThemeContext keeps a doodle ground of its own').not.toMatch(/PATTERN_GROUND|#f1f1e4|#141a1a/);
        expect(ctx).toMatch(/drawnColours\(set, patternEnabled\)/);
        expect(ctx).toMatch(/const theme: ThemeMode = brandScheme\(set\)/);
    });

    it('with the pattern on: a see-through page and the doodle ground as the chrome, per set; off: the tree itself', () => {
        for (const set of BRAND_SETS) {
            expect(drawnColours(set, false), set).toBe(COLOUR_SETS[set]);
            const on = drawnColours(set, true);
            expect(on.surface, set).toEqual({ ...COLOUR_SETS[set].surface, page: 'transparent', chrome: doodleGround(set) });
            expect({ ...on, surface: COLOUR_SETS[set].surface }, set).toEqual(COLOUR_SETS[set]);
        }
        // Classic as main drew it: the light and dark chrome over the pattern.
        expect(drawnColours('light', true).surface.chrome).toBe('#f1f1e4');
        expect(drawnColours('dark', true).surface.chrome).toBe('#141a1a');
    });

    it('every set has a scheme, and night is dark', () => {
        expect(BRAND_SETS.map((s) => [s, brandScheme(s)])).toEqual([['light', 'light'], ['dark', 'dark'], ['night', 'dark']]);
    });
});

describe('onboarding colours take the set', () => {
    it('light and Classic are as before', () => {
        expect(onboardingColors('light')).toEqual({ colors: lightColors, dark: false });
        expect(onboardingColors('dark').dark).toBe(true);
    });

    it("Dark (night) is the night tree with onboarding's two raised greys, the same raise as Classic's", () => {
        const classic = onboardingColors('dark').colors;
        const night = onboardingColors('night');
        expect(night.dark).toBe(true);
        expect(night.colors.text.muted).toBe(classic.text.muted);
        expect(night.colors.border.strong).toBe(classic.border.strong);
        expect({ ...night.colors, text: { ...night.colors.text, muted: COLOUR_SETS.night.text.muted }, border: { ...night.colors.border, strong: COLOUR_SETS.night.border.strong } })
            .toEqual(COLOUR_SETS.night);
        expect(night.colors.surface.card).toBe(brandGrounds('night').phone.card);
        // Built once: a screen's memo sees the same tree every call.
        expect(onboardingColors('night').colors).toBe(night.colors);
    });
});
