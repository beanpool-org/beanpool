import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandColours, contrastRatio } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

/**
 * The event violet on the phone (DESIGN-detail-pages-fable.md §2.7, slice D0): `colors.event` is core's `event` fill role
 * and `ink.event`, in both sets, so the event pages' chosen answer, their words and their outlines read one library entry
 * instead of the raw #7c3aed / #f5f3ff / #ddd6fe the pages drew. `ink` was the palette's violet-600 (light) and violet-300
 * (dark), read from nowhere central.
 */
const THEMES = [
    ['light', lightColors, brandColours('light')],
    ['dark', darkColors, brandColours('dark')],
] as const;

describe.each(THEMES)('the %s set', (theme, colors, brand) => {
    it('event is core event + ink.event', () => {
        expect(colors.event).toEqual({ ink: brand.ink.event, fill: brand.event.fill, pressed: brand.event.hover, on: brand.event.on });
    });

    it('the chosen answer (white on the fill, and while pressed) reads 4.5:1 or more', () => {
        expect(contrastRatio(colors.event.on, colors.event.fill), `${theme} on the fill`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.event.on, colors.event.pressed), `${theme} on the pressed fill`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors.event.on, colors.event.pressed), theme).toBeGreaterThan(contrastRatio(colors.event.on, colors.event.fill));
    });

    it('the ink reads 4.5:1 or more on the page, the card and the sunken row of this set', () => {
        for (const ground of [colors.surface.app, colors.surface.card, colors.surface.subtle]) {
            expect(contrastRatio(colors.event.ink, ground), `${theme} ${colors.event.ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('the ink is the event tile ink, so the when line and the tile are one violet', () => {
        expect(colors.event.ink).toBe(colors.tile.event.ink);
    });
});

describe('colors.ts draws it from the library, never a hex or a palette step of its own', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'constants', 'colors.ts'), 'utf8');

    it('is mapped once in light and once in dark', () => {
        const pattern = /event: \{ ink: brand(Light|Dark)\.ink\.event, fill: brand\1\.event\.fill, pressed: brand\1\.event\.hover, on: brand\1\.event\.on \}/g;
        expect([...source.matchAll(pattern)].map((m) => m[1]).sort()).toEqual(['Dark', 'Light']);
    });

    it('no event entry reads the palette', () => {
        const lines = source.split('\n').filter((line) => /^\s{4}event: \{/.test(line));
        expect(lines.length).toBe(2);
        for (const line of lines) expect(line).not.toMatch(/palette\.|#[0-9a-fA-F]{3,8}/);
    });
});
