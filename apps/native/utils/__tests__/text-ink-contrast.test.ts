import { describe, it, expect } from 'vitest';
import { BRAND_SETS, brandScheme, contrastRatio } from '@beanpool/core';
import { COLOUR_SETS, doodleGround } from '../../constants/colors';

/**
 * The phone's grey words (`text.*`) on every ground a screen draws them on, in every colour set (light, Classic dark and
 * Dark, core's BRAND_SETS). #1904's reviews measured `text.muted` at 2.25–2.58:1 in light and 3.13–4.10 in dark: it is on
 * every Settings row, chat timestamps and captions, read on old phones in the sun at 130 % text. Every ink here must reach
 * 4.5 (WCAG 2.x AA, normal text) on the card, the page, the bars, the sunken row and the doodle pattern's ground, and muted
 * must stay quieter than secondary so the ladder heading > body > secondary > muted still reads.
 */
const INKS = ['text.heading', 'text.body', 'text.secondary', 'text.muted'] as const;
const THEMES = BRAND_SETS.map((set) => [set, COLOUR_SETS[set]] as const);

const get = (tree: unknown, path: string) => path.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], tree) as string;

const CASES = THEMES.flatMap(([theme, tree]) => {
    const grounds: Record<string, string> = {
        'surface.card': tree.surface.card,
        'surface.app': tree.surface.app,
        'surface.page': tree.surface.page,
        'surface.chrome': tree.surface.chrome,
        'surface.subtle': tree.surface.subtle,
        // The doodle's ground (the library's, constants/colors.ts doodleGround), also surface.chrome while the pattern is on.
        'pattern ground': doodleGround(theme),
    };
    return INKS.flatMap((ink) =>
        Object.entries(grounds).map(([ground, hex]) => ({ key: `${theme} ${ink} on ${ground}`, ink: get(tree, ink), ground: hex })),
    );
});

describe('the phone\'s text inks reach 4.5:1 on every ground, in every colour set', () => {
    it('judges every set of the library', () => {
        expect(THEMES.map(([theme]) => theme)).toEqual(['light', 'dark', 'night']);
    });

    it.each(CASES.map((c) => [c.key, c] as const))('%s', (_key, c) => {
        const ratio = contrastRatio(c.ink, c.ground);
        expect(Number(ratio.toFixed(2)), `${c.ink} on ${c.ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });

    // Home look S4 (Marty's yes, 2 Nov): in dark the card was #1a1a1a on the doodle ground #141a1a, 1.01:1, so the cards
    // did not lift off the page at all. A card must stand apart from the ground it sits on, and its border from the card.
    it.each(THEMES.filter(([theme]) => brandScheme(theme) === 'dark'))('%s: the card lifts off the doodle ground and the app background, and its border shows on it', (theme, tree) => {
        const ground = doodleGround(theme);
        const lift = (a: string, b: string) => Number(contrastRatio(a, b).toFixed(2));
        expect(lift(tree.surface.card, ground), `card ${tree.surface.card} on the doodle ground ${ground}`).toBeGreaterThanOrEqual(1.15);
        expect(lift(tree.surface.card, tree.surface.app), `card on surface.app ${tree.surface.app}`).toBeGreaterThanOrEqual(1.25);
        expect(lift(tree.border.default, tree.surface.card), `border.default ${tree.border.default} on the card`).toBeGreaterThanOrEqual(1.15);
    });

    it.each(THEMES)('%s: muted is quieter than secondary, secondary than body', (_theme, tree) => {
        for (const ground of [tree.surface.card, tree.surface.subtle]) {
            const [body, secondary, muted] = ['text.body', 'text.secondary', 'text.muted'].map((t) => contrastRatio(get(tree, t), ground));
            expect(secondary).toBeLessThan(body);
            // A step a reader can see: at least 1.25× apart in contrast on the same ground.
            expect(secondary / muted, `secondary ${secondary.toFixed(2)} vs muted ${muted.toFixed(2)} on ${ground}`).toBeGreaterThanOrEqual(1.25);
        }
    });
});
