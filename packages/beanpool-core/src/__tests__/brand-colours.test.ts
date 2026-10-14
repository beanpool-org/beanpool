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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC = resolve(ROOT, 'docs/brand-colours.md');
const WEB_CSS = resolve(ROOT, 'apps/pwa/src/index.css');
const MANAGER_TAILWIND = resolve(ROOT, 'apps/manager/tailwind.config.js');
const MANAGER_HTML = resolve(ROOT, 'apps/manager/index.html');

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
        for (const role of ['cta', 'commit', 'action', 'danger', 'gold', 'accent', 'chip.ok', 'chip.need', 'chip.warn', 'chip.danger', 'chip.accent', 'ink.brand', 'ink.success', 'ink.danger', 'ink.warning', 'ink.accent']) {
            expect(roles, role).toContain(role);
        }
        // fills: on/fill + on/hover; chips: ink/tint; inks: one per ground of that theme.
        const inks = Object.keys(BRAND_COLOURS.ink).length;
        const chips = Object.keys(BRAND_COLOURS.chip).length;
        const fills = Object.keys(BRAND_COLOURS).length - 2;
        for (const theme of ['light', 'dark'] as const) {
            expect(pairs.filter((p) => p.theme === theme).length, theme).toBe(fills * 2 + chips + inks * INK_GROUNDS[theme].length);
        }
    });

    it("judges inks on every page, card and sunken ground the web app declares (index.css), in both themes", () => {
        // Each of --bg-primary / --bg-secondary / --bg-card is declared twice: under :root (light), then under
        // :root.dark-theme (dark). Dark --bg-secondary (#384038) sits under words in Messages, the consent card and the
        // radius picker; leaving it out let 4.23:1 and 3.88:1 inks pass (review of #1904, finding 4).
        const css = readFileSync(WEB_CSS, 'utf8');
        for (const name of ['primary', 'secondary', 'card']) {
            const values = [...css.matchAll(new RegExp(`--bg-${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1].toLowerCase());
            expect(values.length, `--bg-${name} declarations in index.css`).toBe(2);
            expect(INK_GROUNDS.light, `light --bg-${name}`).toContain(values[0]);
            expect(INK_GROUNDS.dark, `dark --bg-${name}`).toContain(values[1]);
        }
    });

    it("judges inks on the manager's page, card and raised grounds (its tailwind.config.js), in dark, the manager's only theme", () => {
        const config = readFileSync(MANAGER_TAILWIND, 'utf8');
        for (const shade of ['950', '900', '800']) {
            const value = config.match(new RegExp(`\\b${shade}:\\s*'(#[0-9a-fA-F]{6})'`))?.[1]?.toLowerCase();
            expect(value, `manager nature-${shade}`).toMatch(/^#[0-9a-f]{6}$/);
            expect(INK_GROUNDS.dark, `manager nature-${shade}`).toContain(value);
        }
        expect(readFileSync(MANAGER_HTML, 'utf8'), 'the manager is dark only; add its light grounds if that changes').toMatch(/<html[^>]*class="dark"/);
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

    it('presses toward more contrast with its own words, in both themes', () => {
        // Darker under white words, lighter under charcoal (gold; the sage accent in dark, Marty 14 Oct 2026).
        for (const [role, node] of Object.entries(BRAND_COLOURS)) {
            if (role === 'chip' || role === 'ink') continue;
            const fill = node as { fill: Record<'light' | 'dark', string>; hover: Record<'light' | 'dark', string>; on: Record<'light' | 'dark', string> };
            for (const theme of ['light', 'dark'] as const) {
                expect(contrastRatio(fill.on[theme], fill.hover[theme]), `${theme} ${role}`).toBeGreaterThan(contrastRatio(fill.on[theme], fill.fill[theme]));
            }
        }
    });

    it('the accent is sage: nature-600 under white words in light, a light sage under charcoal in dark', () => {
        expect(BRAND_COLOURS.accent.fill.light).toBe('#647664');
        expect(BRAND_COLOURS.accent.on).toEqual({ light: '#ffffff', dark: '#1d231d' });
        expect(BRAND_COLOURS.ink.accent.dark).toBe(BRAND_COLOURS.accent.fill.dark);
    });
});

describe('brandColours(theme)', () => {
    it('resolves every leaf to that theme', () => {
        const light = brandColours('light');
        const dark = brandColours('dark');
        expect(light.cta.fill).toBe('#b85236');
        expect(light.ink.brand).toBe('#047857');
        expect(dark.ink.brand).toBe('#34d399');
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
        expect(css).toContain('--bp-ink-brand: #34d399;');
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
