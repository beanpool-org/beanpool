/**
 * The brand colours (brand-colours.ts) are readable wherever they are drawn: every words-on-fill pair, every chip and
 * every ink on every page or card of either app, in light and dark, computed with WCAG 2.x's own formula. A value
 * that drops under 4.5 (3.0 for a role declared large-text) fails here, before any screen shows it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BRAND_COLOURS,
    INK_GROUNDS,
    LARGE_TEXT_ROLES,
    brandColourLeaves,
    brandColours,
    brandContrastPairs,
    brandCssVariableMap,
    brandCssVariables,
    brandTailwindColours,
    contrastRatio,
} from '../brand-colours.js';

const DOC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/brand-colours.md');

describe('contrastRatio', () => {
    it('matches WCAG reference values', () => {
        expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
        expect(contrastRatio('#777777', '#777777')).toBe(1);
        // The design doc's numbers (scratch/global-node/DESIGN-light-brand-pass-fable.md §1), to two places.
        expect(contrastRatio('#ffffff', '#10b981').toFixed(2)).toBe('2.54'); // the old brand green under white
        expect(contrastRatio('#ffffff', '#c2583b').toFixed(2)).toBe('4.42'); // the old terra-600
        expect(contrastRatio('#1d231d', '#f59e0b').toFixed(2)).toBe('7.46'); // charcoal on gold
    });

    it('refuses anything but #rrggbb', () => {
        expect(() => contrastRatio('#fff', '#000000')).toThrow();
        expect(() => contrastRatio('rgba(0,0,0,1)', '#000000')).toThrow();
    });
});

describe('brand colours are readable in both themes', () => {
    const pairs = brandContrastPairs();

    it('covers every role, in both themes', () => {
        const roles = new Set(pairs.map((p) => p.role));
        for (const role of ['cta', 'commit', 'action', 'danger', 'gold', 'accent', 'chip.ok', 'chip.warn', 'chip.danger', 'ink.brand', 'ink.success', 'ink.danger', 'ink.accent']) {
            expect(roles, role).toContain(role);
        }
        expect(pairs.filter((p) => p.theme === 'light').length).toBe(pairs.filter((p) => p.theme === 'dark').length);
        // fills: on/fill + on/hover; chips: ink/tint; inks: one per ground.
        const inks = Object.keys(BRAND_COLOURS.ink).length;
        const chips = Object.keys(BRAND_COLOURS.chip).length;
        const fills = Object.keys(BRAND_COLOURS).length - 2;
        expect(pairs.filter((p) => p.theme === 'light').length).toBe(fills * 2 + chips + inks * INK_GROUNDS.light.length);
    });

    it.each(pairs.map((p) => [`${p.theme} ${p.role} ${p.pair}`, p] as const))('%s', (_label, p) => {
        expect(p.ratio, `${p.ink} on ${p.ground} is ${p.ratio.toFixed(2)}:1, under ${p.min}`).toBeGreaterThanOrEqual(p.min);
    });

    it('declares no role large-text (4.5 everywhere)', () => {
        expect(LARGE_TEXT_ROLES).toEqual([]);
        expect(pairs.every((p) => p.min === 4.5)).toBe(true);
    });

    it('presses darker, never lighter, on white-word fills', () => {
        // Option C: hover/pressed deepens a white-word fill. Gold (charcoal words) is the one that lightens.
        for (const [role, node] of Object.entries(BRAND_COLOURS)) {
            if (role === 'chip' || role === 'ink' || role === 'gold') continue;
            const fill = node as { fill: { light: string }; hover: { light: string } };
            expect(contrastRatio('#ffffff', fill.hover.light), role).toBeGreaterThan(contrastRatio('#ffffff', fill.fill.light));
        }
    });
});

describe('brandColours(theme)', () => {
    it('resolves every leaf to that theme', () => {
        const light = brandColours('light');
        const dark = brandColours('dark');
        expect(light.cta.fill).toBe('#b85236');
        expect(light.ink.brand).toBe('#047857');
        expect(dark.ink.brand).toBe('#10b981');
        expect(dark.chip.ok.tint).toBe('#022c22');
        for (const { path, colour } of brandColourLeaves()) {
            const get = (tree: unknown) => path.split('.').reduce((n, k) => (n as Record<string, unknown>)[k], tree);
            expect(get(light), path).toBe(colour.light);
            expect(get(dark), path).toBe(colour.dark);
        }
    });
});

describe('CSS for the web app and the manager', () => {
    it('writes every role, light under :root and dark under :root.dark', () => {
        const css = brandCssVariables();
        const [light, dark] = css.split(':root.dark {');
        expect(light).toContain(':root {');
        expect(dark).toBeDefined();
        for (const { path, colour } of brandColourLeaves()) {
            const name = `--bp-${path.split('.').join('-')}`;
            expect(light, name).toContain(`  ${name}: ${colour.light};`);
            expect(dark, name).toContain(`  ${name}: ${colour.dark};`);
        }
        expect(css).toContain('--bp-cta-fill: #b85236;');
        expect(css).toContain('--bp-chip-ok-ink: #065f46;');
        expect(css).toContain('--bp-ink-brand: #10b981;');
    });

    it('takes other selectors', () => {
        const css = brandCssVariables({ lightSelector: 'html', darkSelector: 'html.dark-theme' });
        expect(css).toContain('html {\n');
        expect(css).toContain('html.dark-theme {\n');
        expect(css).not.toContain(':root');
    });

    it('maps names to values per theme, and Tailwind names to the variables', () => {
        expect(brandCssVariableMap('light')['--bp-gold-on']).toBe('#1d231d');
        expect(brandCssVariableMap('dark')['--bp-chip-danger-ink']).toBe('#fca5a5');
        const { bp } = brandTailwindColours();
        expect(bp['cta-fill']).toBe('var(--bp-cta-fill)');
        expect(bp['chip-warn-tint']).toBe('var(--bp-chip-warn-tint)');
        expect(Object.keys(bp).length).toBe(brandColourLeaves().length);
    });
});

describe('docs/brand-colours.md', () => {
    it('lists every role with the values in brand-colours.ts', () => {
        const doc = readFileSync(DOC, 'utf8');
        for (const { path, colour } of brandColourLeaves()) {
            const row = `| \`${path}\` | \`${colour.light}\` | \`${colour.dark}\` |`;
            expect(doc, `docs/brand-colours.md is missing or out of date for ${path}; expected the row\n${row}`).toContain(row);
        }
    });
});
