import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandColours, contrastRatio } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

/**
 * The card style box's three chips on the phone (DESIGN-card-style-box-fable.md §1.2, slice D0): `market.poll` for the
 * POLL chip, `chip.quiet` for RECURRING, a category, a group's lock and "Closes in", `chip.info` for 👤 YOU. Each is the
 * core role of the same name, `{ fg: ink, bg: tint }` as `market.offer` is, in both themes, and reads 4.5:1 or more.
 * A screen that draws one names the token; this holds the tokens to the library so a hex cannot slip in here.
 */
const THEMES = [
    ['light', lightColors, brandColours('light')],
    ['dark', darkColors, brandColours('dark')],
] as const;

describe.each(THEMES)('the %s set', (theme, colors, brand) => {
    it('market.poll is core chip.poll', () => {
        expect(colors.market.poll).toEqual({ fg: brand.chip.poll.ink, bg: brand.chip.poll.tint });
    });

    it('chip.quiet is core chip.quiet', () => {
        expect(colors.chip.quiet).toEqual({ fg: brand.chip.quiet.ink, bg: brand.chip.quiet.tint });
    });

    it('chip.info is core chip.info', () => {
        expect(colors.chip.info).toEqual({ fg: brand.chip.info.ink, bg: brand.chip.info.tint });
    });

    it.each([
        ['market.poll', () => colors.market.poll],
        ['chip.quiet', () => colors.chip.quiet],
        ['chip.info', () => colors.chip.info],
    ] as const)('%s reads 4.5:1 or more', (name, token) => {
        const { fg, bg } = token();
        expect(contrastRatio(fg, bg), `${theme} ${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it('the POLL chip is not the EVENT violet, and not the Offer or Need chip', () => {
        expect(colors.market.poll.bg).not.toBe(colors.tile.event.tint);
        expect(colors.market.poll.fg).not.toBe(colors.tile.event.ink);
        expect(colors.market.poll).not.toEqual(colors.market.offer);
        expect(colors.market.poll).not.toEqual(colors.market.need);
    });
});

describe('colors.ts draws them from the library, never a hex of its own', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'constants', 'colors.ts'), 'utf8');

    it.each([
        ['market.poll', /poll: \{ fg: brand(Light|Dark)\.chip\.poll\.ink, bg: brand\1\.chip\.poll\.tint \}/g],
        ['chip.quiet', /quiet: \{ fg: brand(Light|Dark)\.chip\.quiet\.ink, bg: brand\1\.chip\.quiet\.tint \}/g],
        ['chip.info', /info: \{ fg: brand(Light|Dark)\.chip\.info\.ink, bg: brand\1\.chip\.info\.tint \}/g],
    ] as const)('%s is mapped once in light and once in dark', (_name, pattern) => {
        const found = [...source.matchAll(pattern)].map((m) => m[1]);
        expect(found.sort()).toEqual(['Dark', 'Light']);
    });
});
