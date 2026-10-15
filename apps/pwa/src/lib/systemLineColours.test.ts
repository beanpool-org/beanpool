/**
 * The colours a DM's system lines resolve to, measured. Light must be the web as it was (Marty, 15 Oct: light as is);
 * dark must read: words 4.5:1 or more on the pill as laid over the chat, the outline 3:1 or more on the page.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEAL_TINT_ALPHA, WEB_INK_GROUNDS, brandCssVariableMap, contrastRatio } from '@beanpool/core/brand-colours';
import { systemLineColours } from './systemLineColours';

const theme = { light: brandCssVariableMap('light'), dark: brandCssVariableMap('dark') };
const varOf = (css: string) => /var\((--[a-z0-9-]+)\)/.exec(css)?.[1] ?? '';
const resolve = (css: string, t: 'light' | 'dark') => theme[t][varOf(css)];
/** `rgba(2, 44, 34, 0.4)` laid over the opaque `#rrggbb` ground, as the opaque colour a reader sees. */
const over = (rgba: string, ground: string) => {
    const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
    if (!m) throw new Error(`not a plain rgba: ${rgba}`);
    const a = Number(m[4]);
    return '#' + [1, 2, 3].map((i) => Math.round(Number(m[i]) * a + parseInt(ground.slice(2 * i - 1, 2 * i + 1), 16) * (1 - a)).toString(16).padStart(2, '0')).join('');
};
const SRC_DIR = path.resolve(__dirname, '..');
const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
});

const OLD_LIGHT = {
    ESCROW_FUNDED: { background: 'rgba(209, 250, 229, 0.4)', color: '#065f46', border: '#10b981' },
    ESCROW_RELEASED: { background: 'rgba(167, 243, 208, 0.4)', color: '#065f46', border: '#059669' },
    ESCROW_CANCELLED: { background: 'rgba(254, 226, 226, 0.4)', color: '#991b1b', border: '#ef4444' },
};

describe("a trade's lines in a DM", () => {
    for (const [type, old] of Object.entries(OLD_LIGHT)) {
        it(`${type}: library roles only, light exactly as before`, () => {
            const c = systemLineColours(type);
            expect(c.background).toMatch(/^var\(--bp-deal-[a-z]+-wash\)$/);
            for (const v of [c.color, c.border]) expect(v).toMatch(/^var\(--bp-deal-[a-z]+-(ink|border)\)$/);
            expect({ background: resolve(c.background, 'light'), color: resolve(c.color, 'light'), border: resolve(c.border, 'light') }).toEqual(old);
        });

        it(`${type}: in dark, words 4.5:1+ on the pill over the chat, outline 3:1+ on the page`, () => {
            const c = systemLineColours(type);
            for (const ground of WEB_INK_GROUNDS.dark) {
                const pill = over(resolve(c.background, 'dark'), ground);
                expect(contrastRatio(resolve(c.color, 'dark'), pill), `${type} words on ${pill}`).toBeGreaterThanOrEqual(4.5);
                expect(contrastRatio(resolve(c.border, 'dark'), ground), `${type} outline on ${ground}`).toBeGreaterThanOrEqual(3);
            }
        });
    }

    it('an old WebView (no color-mix) draws exactly this: the web app has no color-mix(), and every tint is a plain rgba', () => {
        // Chrome < 111 and old Android WebViews drop a color-mix() declaration (memory product-audience-small-screens:
        // API 26). With none in the sources or CSS there is nothing to drop, so the numbers above are what they draw.
        const found = sources(SRC_DIR).filter((p) => fs.readFileSync(p, 'utf8').includes('color-mix('));
        expect(found.map((p) => path.relative(SRC_DIR, p))).toEqual([]);
        const plainRgba = /^rgba\(\d+, \d+, \d+, ([\d.]+)\)$/;
        for (const t of ['light', 'dark'] as const) {
            for (const type of Object.keys(OLD_LIGHT)) {
                const value = resolve(systemLineColours(type).background, t);
                expect(value, `${t} ${type}`).toMatch(plainRgba);
                expect(Number(plainRgba.exec(value)![1])).toBe(DEAL_TINT_ALPHA);
            }
        }
    });

    it('any other system line keeps the page grey and its secondary words', () => {
        expect(systemLineColours('JOINED')).toEqual({ background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: 'transparent' });
        expect(systemLineColours(undefined).background).toBe('var(--bg-hover)');
    });
});

describe("a removed group line's words (the tombstone on --bg-hover)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
    const decl = (name: string) => [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());

    it('light stays --text-muted; dark is the library sage ink, 4.5:1+ on --bg-hover', () => {
        const [light, dark] = decl('--text-muted-on-hover');
        expect(light).toBe('var(--text-muted)');
        expect(dark).toBe('var(--bp-ink-accent)');
        const hoverDark = decl('--bg-hover').find((v) => v.startsWith('#') && v !== decl('--bg-hover')[0]);
        expect(contrastRatio(theme.dark['--bp-ink-accent'], hoverDark!)).toBeGreaterThanOrEqual(4.5);
    });
});
