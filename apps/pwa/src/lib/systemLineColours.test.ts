/**
 * The colours a DM's system lines resolve to, measured. Light must be the web as it was (Marty, 15 Oct: light as is);
 * dark must read: words 4.5:1 or more on the pill as laid over the chat, the outline 3:1 or more on the page.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEAL_TINT_ALPHA, WEB_INK_GROUNDS, blendOver, brandCssVariableMap, contrastRatio, rgbaOf } from '@beanpool/core/brand-colours';
import { systemLineColours } from './systemLineColours';

const theme = { light: brandCssVariableMap('light'), dark: brandCssVariableMap('dark') };
const varOf = (css: string) => /var\((--[a-z0-9-]+)\)/.exec(css)?.[1] ?? '';
const resolve = (css: string, t: 'light' | 'dark') => theme[t][varOf(css)];
/** `color-mix(in srgb, var(--x) 40%, transparent)` → the colour and its alpha. */
const mix = (css: string) => {
    const m = /^color-mix\(in srgb, var\((--[a-z0-9-]+)\) (\d+)%, transparent\)$/.exec(css);
    if (!m) throw new Error(`not a library tint: ${css}`);
    return { name: m[1], alpha: Number(m[2]) / 100 };
};

const OLD_LIGHT = {
    ESCROW_FUNDED: { background: 'rgba(209, 250, 229, 0.4)', color: '#065f46', border: '#10b981' },
    ESCROW_RELEASED: { background: 'rgba(167, 243, 208, 0.4)', color: '#065f46', border: '#059669' },
    ESCROW_CANCELLED: { background: 'rgba(254, 226, 226, 0.4)', color: '#991b1b', border: '#ef4444' },
};

describe("a trade's lines in a DM", () => {
    for (const [type, old] of Object.entries(OLD_LIGHT)) {
        it(`${type}: library roles only, light exactly as before`, () => {
            const c = systemLineColours(type);
            for (const v of [c.color, c.border]) expect(v).toMatch(/^var\(--bp-deal-[a-z]+-(ink|border)\)$/);
            const { name, alpha } = mix(c.background);
            expect(name).toMatch(/^--bp-deal-[a-z]+-tint$/);
            expect(alpha).toBe(DEAL_TINT_ALPHA);
            expect({ background: rgbaOf(theme.light[name], alpha), color: resolve(c.color, 'light'), border: resolve(c.border, 'light') }).toEqual(old);
        });

        it(`${type}: in dark, words 4.5:1+ on the pill over the chat, outline 3:1+ on the page`, () => {
            const c = systemLineColours(type);
            const { name, alpha } = mix(c.background);
            for (const ground of WEB_INK_GROUNDS.dark) {
                const pill = blendOver(theme.dark[name], alpha, ground);
                expect(contrastRatio(resolve(c.color, 'dark'), pill), `${type} words on ${pill}`).toBeGreaterThanOrEqual(4.5);
                expect(contrastRatio(resolve(c.border, 'dark'), ground), `${type} outline on ${ground}`).toBeGreaterThanOrEqual(3);
            }
        });
    }

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
