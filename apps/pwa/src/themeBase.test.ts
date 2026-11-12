/**
 * The web's base from the colour library, per set (slice T1, DESIGN-themes-fable.md §7; Marty and Damo, 12 Nov 2026).
 *
 * tailwind.config.js writes the library's variables (brandBase): Light under :root, Classic under :root.dark-theme, and Dark
 * (`night` in code) under :root.dark-theme[data-bp-theme="night"] with only what it changes. index.css's base variables
 * (--bg-*, --text-*, --border-*, --pattern-bg, --header-bg …) read those, and the `nature` scale is the ramp as channels.
 * This resolves every base variable the way a browser does, per set, and holds:
 *   - Classic light and Classic dark to main's values, exactly (main 5ab8b7dc's index.css, copied below), so this slice
 *     changes nothing a member sees there;
 *   - Dark's to the library's own grounds and ramp;
 *   - --accent gone, and no sage hex left in index.css but the one fixed on purpose (Leaflet's ring).
 * The Chromium check of every class string (e2e/dark-class-check.mjs, DARK_CLASSES_ALL=1, compared before and after) is
 * the proof on the built CSS; this is the quick one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND_SETS, brandCssVariableMap, brandGrounds, contrastRatio, type BrandSet } from '@beanpool/core/brand-colours';

const SRC = __dirname;
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type Config = {
    default: { theme: { extend: { colors: { nature: Record<string, string> } } } };
    RAMP_STEPS: string[];
    brandBase: () => Record<string, Record<string, string>>;
    themeBlockSelector: (set: BrandSet) => string;
    THEME_BLOCK_SETS: BrandSet[];
};
const load = async (): Promise<Config> => import(/* @vite-ignore */ pathToFileURL(path.resolve(SRC, '../tailwind.config.js')).href);

/** The declarations of every index.css block whose selector is exactly this one, in file order. */
function cssBlock(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (m[1].trim() !== selector) continue;
        for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    }
    return out;
}

/** Every custom property on <html> in one set, as the cascade gives it: the plugin's blocks and index.css's, by weight. */
function cascade(base: Record<string, Record<string, string>>, set: BrandSet, blockSelector: (s: BrandSet) => string): Record<string, string> {
    const dark = set !== 'light';
    const layers = [base[':root'], cssBlock(':root')];
    if (dark) layers.push(base[':root.dark-theme'], cssBlock(':root.dark-theme'));
    if (dark && set !== 'dark') layers.push(base[blockSelector(set)] ?? {});
    return Object.assign({}, ...layers);
}

/** A variable's value with var() and rgb(var() …) resolved: '#rrggbb', or 'rgba(r, g, b, a)' under an alpha. */
function resolve(vars: Record<string, string>, value: string, depth = 0): string {
    if (depth > 6) throw new Error(`too deep: ${value}`);
    const v = value.trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) {
        if (!(ref[1] in vars)) throw new Error(`${ref[1]} is not declared`);
        return resolve(vars, vars[ref[1]], depth + 1);
    }
    const rgb = /^rgb\(var\((--[\w-]+)\)(?:\s*\/\s*([\d.]+))?\)$/.exec(v);
    if (rgb) {
        const ch = (vars[rgb[1]] ?? '').split(/\s+/).map(Number);
        if (ch.length !== 3 || ch.some((c) => !Number.isInteger(c))) throw new Error(`${rgb[1]} is not channels: ${vars[rgb[1]]}`);
        if (rgb[2] != null) return `rgba(${ch.join(', ')}, ${rgb[2]})`;
        return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    }
    return v.toLowerCase();
}

/** main 5ab8b7dc's index.css: each base variable this slice moved onto the library, as main declared it. */
const MAIN_LIGHT: Record<string, string> = {
    '--bg-primary': '#f6f4f0', '--bg-secondary': '#fbfaf8', '--bg-card': '#ffffff', '--bg-input': '#ffffff',
    '--text-primary': '#1d231d', '--text-secondary': '#384038', '--text-muted': '#647664', '--text-faint': '#9eaf9e',
    '--border-primary': '#dce3dc', '--border-secondary': '#eef1ee', '--border-input': '#c0ccc0',
    '--success': '#647664', '--scrollbar-thumb': '#c0ccc0', '--header-bg': '#fbfaf8', '--pattern-bg': '#f1f1e4',
};
const MAIN_DARK: Record<string, string> = {
    '--bg-primary': '#1d231d', '--bg-secondary': '#384038', '--bg-card': '#2a322a', '--bg-input': '#2a322a', '--bg-hover': '#434e43',
    '--text-secondary': '#dce3dc', '--text-muted': '#9eaf9e', '--text-faint': '#9eaf9e',
    '--border-primary': '#434e43', '--border-secondary': '#384038', '--border-input': '#809380', '--on-danger': '#1d231d',
    '--credit-muted': '#9eaf9e', '--tier-track': '#434e43', '--tier-card': '#2a322a', '--tier-card-border': '#434e43',
    '--success': '#809380', '--scrollbar-thumb': '#526052', '--header-bg': '#1d231d', '--header-overlay': 'rgba(29, 35, 29, 0.85)',
    '--pattern-bg': '#141a1a', '--nav-bg': '#2a322a',
};
/** main's tailwind.config.js `nature` scale. */
const MAIN_NATURE: Record<string, string> = {
    50: '#f6f7f6', 100: '#eef1ee', 200: '#dce3dc', 300: '#c0ccc0', 400: '#9eaf9e', 500: '#809380',
    600: '#647664', 700: '#526052', 800: '#434e43', 900: '#384038', 950: '#1d231d',
};

describe("the web's base comes from the colour library, per set", () => {
    it('writes Light, Classic and one block per further set (Dark), and nothing for Dusk or Ember', async () => {
        const { brandBase, THEME_BLOCK_SETS, themeBlockSelector } = await load();
        expect(THEME_BLOCK_SETS).toEqual(['night']);
        expect(Object.keys(brandBase())).toEqual([':root', ':root.dark-theme', ':root.dark-theme[data-bp-theme="night"]']);
        expect(themeBlockSelector('night')).toBe(':root.dark-theme[data-bp-theme="night"]');
        expect(JSON.stringify(brandBase())).not.toMatch(/dusk|ember/i);
    });

    it("Light and Classic keep every brand role exactly as main writes it (brandCssVariableMap('light' / 'dark'))", async () => {
        const base = (await load()).brandBase();
        for (const [selector, set] of [[':root', 'light'], [':root.dark-theme', 'dark']] as const) {
            for (const [name, hex] of Object.entries(brandCssVariableMap(set))) expect(base[selector][name], `${selector} ${name}`).toBe(hex);
        }
    });

    it("the `nature` scale is the ramp as channels, and Classic's ramp is main's scale, step for step", async () => {
        const { default: config, RAMP_STEPS, brandBase } = await load();
        const base = brandBase();
        expect(Object.keys(config.theme.extend.colors.nature)).toEqual(RAMP_STEPS);
        for (const step of RAMP_STEPS) {
            expect(config.theme.extend.colors.nature[step]).toBe(`rgb(var(--bp-n-${step}) / <alpha-value>)`);
            for (const selector of [':root', ':root.dark-theme']) {
                expect(resolve(base[selector], `rgb(var(--bp-n-${step}))`), `${selector} nature-${step}`).toBe(MAIN_NATURE[step]);
            }
        }
    });

    it("Classic light and Classic dark resolve every moved base variable to main's value", async () => {
        const { brandBase, themeBlockSelector } = await load();
        const base = brandBase();
        for (const [set, main] of [['light', MAIN_LIGHT], ['dark', MAIN_DARK]] as const) {
            const vars = cascade(base, set, themeBlockSelector);
            const got = Object.fromEntries(Object.keys(main).map((name) => [name, resolve(vars, vars[name])]));
            expect(got, set).toEqual(main);
        }
        // Can fail: the same resolution in Dark is not Classic's.
        const night = cascade(base, 'night', themeBlockSelector);
        expect(resolve(night, night['--bg-primary'])).not.toBe(MAIN_DARK['--bg-primary']);
    });

    it("every set's page, card, sunken row, banner, doodle ground and ramp are the library's own", async () => {
        const { brandBase, themeBlockSelector, RAMP_STEPS } = await load();
        const base = brandBase();
        for (const set of BRAND_SETS) {
            const g = brandGrounds(set);
            const vars = cascade(base, set, themeBlockSelector);
            const at = (name: string) => resolve(vars, vars[name]);
            expect([at('--bg-primary'), at('--bg-card'), at('--bg-input'), at('--bg-secondary'), at('--header-bg'), at('--pattern-bg')], set)
                .toEqual([g.web.page, g.web.card, g.web.card, g.web.sunken, g.web.banner, g.doodle.ground]);
            for (const step of RAMP_STEPS) expect(resolve(vars, `rgb(var(--bp-n-${step}))`), `${set} nature-${step}`).toBe(g.web.ramp[step as '50']);
            for (const [name, hex] of Object.entries(brandCssVariableMap(set))) expect(at(name), `${set} ${name}`).toBe(hex);
        }
    });

    it("Dark's block holds only what it changes from Classic dark", async () => {
        const { brandBase } = await load();
        const base = brandBase();
        const night = base[':root.dark-theme[data-bp-theme="night"]'];
        for (const [name, value] of Object.entries(night)) expect(base[':root.dark-theme'][name], name).not.toBe(value);
        // The 15 accent-family roles T0 gives Dark, the 11 ramp steps and the 5 grounds.
        expect(Object.keys(night).filter((n) => !n.startsWith('--bp-n-') && !/^--bp-(web|doodle)-/.test(n))).toHaveLength(15);
        expect(Object.keys(night).filter((n) => n.startsWith('--bp-n-'))).toHaveLength(11);
        expect(Object.keys(night).filter((n) => /^--bp-(web|doodle)-/.test(n))).toHaveLength(5);
    });

    it("the own chat bubble is the sage fill under white: 4.86:1 in Classic dark (main's --accent was 3.28), 4.5+ in every set", () => {
        const page = fs.readFileSync(path.join(SRC, 'pages/MessagesPage.tsx'), 'utf8');
        expect(page).toContain("background: isMe ? 'var(--bp-sage-fill)' : 'var(--bg-card)',");
        expect(page).toContain("background: failed ? 'var(--bp-chip-danger-tint)' : 'var(--bp-sage-fill)',"); // a line still going
        for (const set of BRAND_SETS) {
            const v = brandCssVariableMap(set);
            expect(v['--bp-sage-on'], set).toBe('#ffffff');
            expect(contrastRatio(v['--bp-sage-on'], v['--bp-sage-fill']), set).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio('#ffffff', brandCssVariableMap('dark')['--bp-sage-fill']).toFixed(2)).toBe('4.86');
        expect(brandCssVariableMap('light')['--bp-sage-fill']).toBe('#647664'); // Light's bubble: main's --accent, unchanged
        // Can fail: main's dark --accent under the same white words.
        expect(contrastRatio('#ffffff', '#809380').toFixed(2)).toBe('3.28');
    });

    it('--accent is gone: no declaration in index.css, no var(--accent) or *-accent class in the app', () => {
        expect(CSS).not.toMatch(/--accent(?:-hover)?\s*:/);
        const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) return files(p);
            return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
        });
        const found: string[] = [];
        for (const file of files(SRC)) {
            const text = fs.readFileSync(file, 'utf8');
            if (/var\(--accent(?:-hover)?\)/.test(text)) found.push(`${path.relative(SRC, file)}: var(--accent)`);
            for (const m of text.matchAll(/(?<![\w-])(?:[\w-]+:)*(?:bg|text|border|ring|outline|from|via|to|fill|stroke|decoration|caret|divide|accent|shadow|placeholder)-accent(?![\w-])/g)) {
                found.push(`${path.relative(SRC, file)}: ${m[0]}`);
            }
        }
        expect(found).toEqual([]);
    });

    it("no sage, charcoal or ground hex is left in index.css but Leaflet's ring, fixed on purpose", () => {
        const sage = new Set([...Object.values(MAIN_NATURE), '#2a322a', '#141a1a', '#f1f1e4']);
        const left = [...CSS.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase()).filter((hex) => sage.has(hex));
        expect(left).toEqual(['#647664']);
        expect(CSS).toMatch(/:root\.dark-theme \.leaflet-container :focus-visible \{\s*outline-color: #647664;/);
        expect(CSS).not.toMatch(/rgba\(\s*(?:100,\s*118,\s*100|29,\s*35,\s*29)\s*,/);
    });
});
