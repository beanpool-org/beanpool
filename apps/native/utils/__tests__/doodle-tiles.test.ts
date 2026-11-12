// @vitest-environment jsdom
/**
 * The phone's doodle wallpaper, one tile per colour set (colour themes, slice T5; Marty, 12 Nov 2026: "Dark has no green").
 *
 * components/PatternBackground.tsx drawn for real, for every choice the Appearance list stores, on a light-mode device and a
 * dark-mode one, through the real resolveSet (utils/theme-preference.ts, core's resolveLook): Classic draws the olive tile,
 * Light the pale one, and Dark (stored `night`, always dark) its own charcoal tile whatever the phone is set to. The
 * component is given the set the way ThemeContext gives it; `theme` is passed as the set's scheme, and is wrong on purpose
 * in one case below to show the tile follows the SET, not the scheme (that was the bug this slice fixes: one tile for
 * every dark look).
 *
 * The files: each tile has its @2x beside it (Metro picks it on a 2x screen), and the 1x tile is 890 px, the 2x 1780 px,
 * the same sizes as Classic's. The tiles' ground, lift and greenness are held by scripts/dark-doodle.test.mjs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ReactAll from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BRAND_SETS, brandScheme, type BrandSet } from '@beanpool/core';
import { resolveSet } from '../theme-preference';

// A require of a tile gives back its path, so a render can say which file it drew.
(Module as any)._extensions['.webp'] = (m: { exports: unknown }, filename: string) => { m.exports = filename; };
(globalThis as any).React = ReactAll; // the component's JSX is the classic transform
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ theme: { set: 'dark', theme: 'dark', patternEnabled: true, colors: { surface: { chrome: '#141a1a', app: '#0a0a0a' } } } as Record<string, any> }));

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    return {
        View: (p: Record<string, any>) => createElement('div', { 'data-ground': flat(p.style).backgroundColor }, p.children),
        Image: (p: Record<string, any>) => createElement('img', { 'data-tile': String(p.source), 'data-resize': p.resizeMode }),
        StyleSheet: { absoluteFill: {}, create: (s: unknown) => s },
    };
});
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => state.theme }));

const IMAGES = path.join(__dirname, '..', '..', 'assets', 'images');
const tileName = (src: string | null) => (src ? path.basename(src) : null);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; });

async function draw(set: BrandSet, patternEnabled = true, theme = brandScheme(set)) {
    state.theme = { set, theme, patternEnabled, colors: { surface: { chrome: `#chrome-${set}`, app: `#app-${set}` } } };
    const { default: PatternBackground } = await import('../../components/PatternBackground');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(PatternBackground)));
    return { tile: tileName(host.querySelector('img')?.getAttribute('data-tile') ?? null), ground: host.querySelector('div')?.getAttribute('data-ground') };
}

describe('the tile follows the colour set the Appearance list stored', () => {
    // [stored choice, device is dark, tile drawn]
    const CASES: Array<[string, boolean, string]> = [
        ['dark', false, 'pattern-dark.webp'],     // Classic, on a light-mode device
        ['dark', true, 'pattern-dark.webp'],      // Classic, on a dark-mode device
        ['light', false, 'pattern-light.webp'],
        ['light', true, 'pattern-light.webp'],
        ['night', false, 'pattern-night.webp'],   // Dark ignores the phone: charcoal on a light-mode device
        ['night', true, 'pattern-night.webp'],
        ['system', false, 'pattern-light.webp'],  // Same as phone: Light on a light phone
        ['system', true, 'pattern-dark.webp'],    // and Classic on a dark one (never Dark)
        [null as unknown as string, true, 'pattern-dark.webp'], // nothing stored: Classic
        ['dusk', false, 'pattern-dark.webp'],     // a value this build does not know: Classic
    ];
    for (const [stored, deviceDark, want] of CASES) {
        it(`${JSON.stringify(stored)} on a ${deviceDark ? 'dark' : 'light'}-mode device draws ${want}`, async () => {
            const set = resolveSet(stored as never, deviceDark ? 'dark' : 'light');
            const drawn = await draw(set);
            expect(drawn.tile).toBe(want);
        });
    }

    it('every colour set has a tile of its own (a new set cannot ship without one)', async () => {
        const seen = new Set<string | null>();
        for (const set of BRAND_SETS) {
            const drawn = await draw(set);
            expect(drawn.tile, set).toMatch(/^pattern-.*\.webp$/);
            seen.add(drawn.tile);
            act(() => root?.unmount()); host?.remove();
        }
        expect(seen.size).toBe(BRAND_SETS.length);
    });

    it('Dark and Classic are both dark by scheme, and still draw different tiles: the tile follows the set, not the scheme', async () => {
        const night = await draw('night', true, 'dark');
        act(() => root?.unmount()); host?.remove();
        const classic = await draw('dark', true, 'dark');
        expect(night.tile).toBe('pattern-night.webp');
        expect(classic.tile).toBe('pattern-dark.webp');
    });

    it('the solid colour under the tile is the set\'s chrome with the pattern on, and its page with it off (no tile then)', async () => {
        const on = await draw('night');
        expect(on.ground).toBe('#chrome-night');
        act(() => root?.unmount()); host?.remove();
        const off = await draw('night', false);
        expect(off.tile).toBeNull();
        expect(off.ground).toBe('#app-night');
    });

    it('the tile repeats at its own size (resizeMode repeat), as Classic\'s do', async () => {
        await draw('night');
        expect(host!.querySelector('img')?.getAttribute('data-resize')).toBe('repeat');
    });
});

describe('the tile files', () => {
    it('each set\'s tile has its @2x beside it, at 890 and 1780 px (webp), and Dark\'s is no bigger than Classic\'s', () => {
        for (const name of ['pattern-light', 'pattern-dark', 'pattern-night']) {
            expect(fs.existsSync(path.join(IMAGES, `${name}.webp`)), name).toBe(true);
            expect(fs.existsSync(path.join(IMAGES, `${name}@2x.webp`)), `${name}@2x`).toBe(true);
            const dims = (file: string) => {
                const b = fs.readFileSync(path.join(IMAGES, file));
                expect(b.subarray(0, 4).toString(), file).toBe('RIFF');
                expect(b.subarray(8, 12).toString(), file).toBe('WEBP');
                // A lossy WebP: the VP8 chunk, whose frame header holds the 14-bit width and height.
                expect(b.subarray(12, 16).toString(), file).toBe('VP8 ');
                return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
            };
            expect(dims(`${name}.webp`), name).toEqual([890, 890]);
            expect(dims(`${name}@2x.webp`), `${name}@2x`).toEqual([1780, 1780]);
        }
        const size = (f: string) => fs.statSync(path.join(IMAGES, f)).size;
        expect(size('pattern-night.webp')).toBeLessThanOrEqual(size('pattern-dark.webp'));
        expect(size('pattern-night@2x.webp')).toBeLessThanOrEqual(size('pattern-dark@2x.webp'));
    });

    it('the phone no longer picks its tile by scheme alone (the line that gave every dark look Classic\'s)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'PatternBackground.tsx'), 'utf8');
        expect(src).not.toMatch(/theme === 'dark' \? 'dark' : 'light'/);
        expect(src).toMatch(/Record<BrandSet,/);
    });
});
