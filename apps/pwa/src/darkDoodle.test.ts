/**
 * The web's doodle wallpaper and header banner, per look (colour themes, slice T5; Marty, 12 Nov 2026: "Dark has no green").
 *
 * index.css names each picture in a custom property (--pattern-image and its two image-set forms, --banner-image) and
 * the wallpaper and the banner read them, so a browser fetches only the pictures of the look it is in. Dark
 * (`:root.dark-theme[data-bp-theme="night"]`) swaps in its charcoal tile and banner (scripts/bake-dark-doodle.mjs); Classic
 * and Light keep today's, in the same words.
 *
 * This resolves those properties the way the cascade does (specificity, then file order) for every look and for
 * "Plain background", and holds:
 *   - Classic, Light: the olive and pale tiles and the neon banner, exactly as main's index.css (copied below);
 *   - Dark: the night tiles and the night banner, in all three tile forms;
 *   - Plain background turns the wallpaper off in EVERY look, Dark included (Dark's block is more specific than the plain
 *     rule, which is why the rule names Dark too), and leaves the banner alone;
 *   - the four places that draw the banner read the variable, so none still names the neon file;
 *   - every picture index.css names is a file in public/.
 * The Chromium proof (which files a browser fetches per look) is e2e/dark-doodle-shots.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const PUBLIC = path.join(SRC, '..', 'public');
const RAW = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '');

type Look = { classes: string[]; theme: string | null };
const LOOKS: Record<string, Look> = {
    light: { classes: ['light-theme'], theme: null },
    classic: { classes: ['dark', 'dark-theme'], theme: null },
    dark: { classes: ['dark', 'dark-theme'], theme: 'night' },
};
const plain = (look: Look): Look => ({ ...look, classes: [...look.classes, 'plain-background'] });

/** [selector, declarations, order] for every top-level rule whose selector is :root plus classes and an optional data-bp-theme. */
function rootRules(): Array<{ selector: string; decls: Record<string, string>; order: number }> {
    const out: Array<{ selector: string; decls: Record<string, string>; order: number }> = [];
    let order = 0;
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls: Record<string, string> = {};
        for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim();
        for (const selector of m[1].split(',').map((s) => s.trim())) {
            if (/^:root(\.[\w-]+)*(\[data-bp-theme="[\w-]+"\])?$/.test(selector)) out.push({ selector, decls, order: order++ });
        }
    }
    return out;
}

/** Specificity of a :root selector: :root, each class and the attribute are one each. */
const weight = (selector: string) => 1 + (selector.match(/\.[\w-]+/g) ?? []).length + (selector.includes('[') ? 1 : 0);

function matches(selector: string, look: Look): boolean {
    const classes = selector.match(/\.[\w-]+/g)?.map((c) => c.slice(1)) ?? [];
    const attr = /\[data-bp-theme="([\w-]+)"\]/.exec(selector)?.[1] ?? null;
    return classes.every((c) => look.classes.includes(c)) && (attr === null || attr === look.theme);
}

/** The value of a custom property on <html> in a look: the heaviest matching rule, the later one on a tie. */
function valueIn(look: Look, name: string): string | undefined {
    let best: { w: number; order: number; value: string } | undefined;
    for (const r of rootRules()) {
        if (!(name in r.decls) || !matches(r.selector, look)) continue;
        const w = weight(r.selector);
        if (!best || w > best.w || (w === best.w && r.order > best.order)) best = { w, order: r.order, value: r.decls[name] };
    }
    return best?.value;
}

const TILE = (n: string) => `url('/pattern-${n}.webp')`;
const HIDPI = (n: string, fn: string) => `${fn}(url('/pattern-${n}.webp') 1x, url('/pattern-${n}-2x.webp') 2x)`;

describe('the wallpaper and the banner, per look (index.css, resolved by the cascade)', () => {
    it('Light and Classic keep main\'s: the pale tile, the olive tile, the neon banner, in the same words', () => {
        for (const [name, tile] of [['light', 'light'], ['classic', 'dark']] as const) {
            expect(valueIn(LOOKS[name], '--pattern-image'), name).toBe(TILE(tile));
            expect(valueIn(LOOKS[name], '--pattern-image-hidpi'), name).toBe(HIDPI(tile, 'image-set'));
            expect(valueIn(LOOKS[name], '--pattern-image-hidpi-webkit'), name).toBe(HIDPI(tile, '-webkit-image-set'));
            expect(valueIn(LOOKS[name], '--banner-image'), name).toBe("url('/assets/neon-vines-banner.png')");
        }
    });

    it('Dark draws the night tile in all three forms, and the night banner', () => {
        expect(valueIn(LOOKS.dark, '--pattern-image')).toBe("url('/pattern-night.webp')");
        expect(valueIn(LOOKS.dark, '--pattern-image-hidpi')).toBe(HIDPI('night', 'image-set'));
        expect(valueIn(LOOKS.dark, '--pattern-image-hidpi-webkit')).toBe(HIDPI('night', '-webkit-image-set'));
        expect(valueIn(LOOKS.dark, '--banner-image')).toBe("url('/assets/vines-banner-night.jpg')");
    });

    it('Plain background turns the wallpaper off in every look, Dark included, and leaves the banner as it was', () => {
        for (const name of Object.keys(LOOKS)) {
            for (const p of ['--pattern-image', '--pattern-image-hidpi', '--pattern-image-hidpi-webkit']) {
                expect(valueIn(plain(LOOKS[name]), p), `${name} ${p}`).toBe('none');
            }
            expect(valueIn(plain(LOOKS[name]), '--banner-image'), `${name} banner`).toBe(valueIn(LOOKS[name], '--banner-image'));
            expect(valueIn(plain(LOOKS[name]), '--pattern-bg'), `${name} ground`).toBe('var(--bg-primary)');
        }
    });

    it('the night tile is named only inside Dark\'s own block: no other look can fetch it', () => {
        for (const r of rootRules()) {
            const names = Object.values(r.decls).some((v) => /pattern-night|vines-banner-night/.test(v));
            expect(names, r.selector).toBe(r.selector === ':root.dark-theme[data-bp-theme="night"]');
        }
    });

    it('the Plain background check can fail: without the rule that names Dark, Dark would keep its tile', () => {
        // The same cascade with that one selector removed from the plain rule, as the file stood before this slice.
        const rules = rootRules().filter((r) => r.selector !== ':root.plain-background[data-bp-theme="night"]');
        const look = plain(LOOKS.dark);
        let best: { w: number; order: number; value: string } | undefined;
        for (const r of rules) {
            if (!('--pattern-image' in r.decls) || !matches(r.selector, look)) continue;
            const w = weight(r.selector);
            if (!best || w > best.w || (w === best.w && r.order > best.order)) best = { w, order: r.order, value: r.decls['--pattern-image'] };
        }
        expect(best?.value).toBe("url('/pattern-night.webp')");
    });

    it('the plain rule comes after Dark\'s block and is as specific as it (a tie goes to the later rule)', () => {
        const night = rootRules().find((r) => r.selector === ':root.dark-theme[data-bp-theme="night"]' && '--pattern-image' in r.decls)!;
        const plainNight = rootRules().find((r) => r.selector === ':root.plain-background[data-bp-theme="night"]')!;
        expect(weight(plainNight.selector)).toBeGreaterThanOrEqual(weight(night.selector));
        expect(plainNight.order).toBeGreaterThan(night.order);
    });
});

describe('the places that draw the banner, and the files', () => {
    const BANNER_USERS = ['App.tsx', 'components/AppHeader.tsx', 'components/LobbyHeader.tsx', 'pages/GuestLobby.tsx'];
    for (const file of BANNER_USERS) {
        it(`${file} reads --banner-image and no longer names the neon file`, () => {
            const src = fs.readFileSync(path.join(SRC, file), 'utf8');
            expect(src).toMatch(/backgroundImage: 'var\(--banner-image\)'/);
            expect(src).not.toMatch(/neon-vines-banner/);
        });
    }

    it('no other source file names a banner or tile picture by path (a new one would bypass the look)', () => {
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|css)$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(dir, e.name)] : []);
        const users = walk(SRC).filter((f) => /neon-vines-banner|vines-banner-night|pattern-(light|dark|night)/.test(fs.readFileSync(f, 'utf8')));
        expect(users.map((f) => path.relative(SRC, f))).toEqual(['index.css']);
    });

    it('every picture index.css names is a file in public/', () => {
        const named = [...CSS.matchAll(/url\('(\/(?:assets\/)?(?:pattern|neon-vines|vines-banner)[^']*)'\)/g)].map((m) => m[1]);
        expect(new Set(named)).toEqual(new Set([
            '/pattern-light.webp', '/pattern-light-2x.webp', '/pattern-dark.webp', '/pattern-dark-2x.webp',
            '/pattern-night.webp', '/pattern-night-2x.webp', '/assets/neon-vines-banner.png', '/assets/vines-banner-night.jpg',
        ]));
        for (const f of named) expect(fs.existsSync(path.join(PUBLIC, f)), f).toBe(true);
    });
});
