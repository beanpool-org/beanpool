import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

/**
 * The phone's grey words (`text.*`) on every ground a screen draws them on, in both themes. #1904's reviews measured
 * `text.muted` at 2.25–2.58:1 in light and 3.13–4.10 in dark: it is on every Settings row, chat timestamps and
 * captions, read on old phones in the sun at 130 % text. Every ink here must reach 4.5 (WCAG 2.x AA, normal text) on
 * the card, the page, the bars, the sunken row and the doodle pattern's ground, and muted must stay quieter than
 * secondary so the ladder heading > body > secondary > muted still reads.
 */
const PATTERN_SRC = readFileSync(join(__dirname, '..', '..', 'app', 'ThemeContext.tsx'), 'utf8');
const PATTERN = /const PATTERN_GROUND = \{ light: '(#[0-9a-f]{6})', dark: '(#[0-9a-f]{6})' \}/.exec(PATTERN_SRC);

const INKS = ['text.heading', 'text.body', 'text.secondary', 'text.muted'] as const;
const THEMES = [
    ['light', lightColors, 1],
    ['dark', darkColors, 2],
] as const;

const get = (tree: unknown, path: string) => path.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], tree) as string;

const CASES = THEMES.flatMap(([theme, tree, index]) => {
    const grounds: Record<string, string> = {
        'surface.card': tree.surface.card,
        'surface.app': tree.surface.app,
        'surface.page': tree.surface.page,
        'surface.chrome': tree.surface.chrome,
        'surface.subtle': tree.surface.subtle,
        'pattern ground': PATTERN?.[index] ?? '',
    };
    return INKS.flatMap((ink) =>
        Object.entries(grounds).map(([ground, hex]) => ({ key: `${theme} ${ink} on ${ground}`, ink: get(tree, ink), ground: hex })),
    );
});

describe('the phone\'s text inks reach 4.5:1 on every ground, in both themes', () => {
    it('reads the doodle pattern\'s ground from ThemeContext', () => {
        expect(PATTERN, 'PATTERN_GROUND in app/ThemeContext.tsx moved: point this test at it').not.toBeNull();
    });

    it.each(CASES.map((c) => [c.key, c] as const))('%s', (_key, c) => {
        const ratio = contrastRatio(c.ink, c.ground);
        expect(Number(ratio.toFixed(2)), `${c.ink} on ${c.ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });

    it.each(THEMES.map(([theme, tree]) => [theme, tree] as const))('%s: muted is quieter than secondary, secondary than body', (_theme, tree) => {
        for (const ground of [tree.surface.card, tree.surface.subtle]) {
            const [body, secondary, muted] = ['text.body', 'text.secondary', 'text.muted'].map((t) => contrastRatio(get(tree, t), ground));
            expect(secondary).toBeLessThan(body);
            // A step a reader can see: at least 1.25× apart in contrast on the same ground.
            expect(secondary / muted, `secondary ${secondary.toFixed(2)} vs muted ${muted.toFixed(2)} on ${ground}`).toBeGreaterThanOrEqual(1.25);
        }
    });
});
