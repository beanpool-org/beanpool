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
    BRAND_GROUNDS,
    BRAND_SETS,
    DEFAULT_BRAND_SET,
    INK_GROUNDS,
    MANAGER_GROUNDS,
    PHONE_ONLY_ROLES,
    WEB_INK_GROUNDS,
    DEAL_TINT_ALPHA,
    blendOver,
    rgbaOf,
    WEB_ONLY_INKS,
    LARGE_TEXT_ROLES,
    brandColourLeaves,
    brandColours,
    brandContrastPairs,
    brandCssVariableMap,
    brandCssVariables,
    brandGrounds,
    brandInkGrounds,
    brandScheme,
    brandSwatch,
    brandTailwindColours,
    brandWebInkGrounds,
    colourIn,
    contrastRatio,
    relativeLuminance,
    type BrandSet,
    type Themed,
} from '../brand-colours.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
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

describe('brand colours are readable in every set', () => {
    const pairs = brandContrastPairs();

    it('covers every role, in every set', () => {
        const roles = new Set(pairs.map((p) => p.role));
        for (const role of ['cta', 'commit', 'event', 'action', 'danger', 'gold', 'accent', 'sage', 'chip.ok', 'chip.need', 'chip.warn', 'chip.danger', 'chip.accent', 'chip.poll', 'chip.quiet', 'chip.info', 'ink.brand', 'ink.success', 'ink.danger', 'ink.warning', 'ink.accent', 'ink.terra', 'ink.event', 'info', 'neutral', 'ink.info', 'deal.held', 'deal.released', 'deal.cancelled', 'bubble']) {
            expect(roles, role).toContain(role);
        }
        // fills: on/fill + on/hover; chips, tiles, cards and the bubble: ink/tint; inks: one per ground of that set (a web-only
        // ink, the web's grounds). The seven roles that are not fills: chip, deal, tile, card, ink, map, bubble.
        const inkNames = Object.keys(BRAND_COLOURS.ink);
        const chips = Object.keys(BRAND_COLOURS.chip).length;
        const tiles = Object.keys(BRAND_COLOURS.tile).length;
        const cards = Object.keys(BRAND_COLOURS.card).length;
        const fills = Object.keys(BRAND_COLOURS).length - 7;
        const deals = Object.keys(BRAND_COLOURS.deal).length;
        expect(new Set(pairs.map((p) => p.theme))).toEqual(new Set(BRAND_SETS));
        for (const set of BRAND_SETS) {
            const web = brandWebInkGrounds(set).length;
            const all = brandInkGrounds(set).length;
            expect(pairs.filter((p) => p.theme === set).length, set).toBe(fills * 2 + chips + tiles + cards + 1 + deals * web + inkNames.reduce((n, name) => n + (WEB_ONLY_INKS.includes(name) ? web : all), 0));
        }
    });

    it("judges each set's inks on that set's own grounds", () => {
        for (const set of BRAND_SETS) {
            const mine = pairs.filter((p) => p.theme === set && p.role === 'ink.brand').map((p) => p.ground);
            expect(mine, set).toEqual(brandInkGrounds(set));
            const web = pairs.filter((p) => p.theme === set && p.role === 'ink.info').map((p) => p.ground);
            expect(web, set).toEqual(brandWebInkGrounds(set));
        }
        expect(brandInkGrounds('night')).toEqual(['#0a0a0a', '#24262c', '#262626', '#17191c', '#202126', '#2d3036', '#3a3e46']);
    });

    it('covers every tile role for categories, event and pulse, in both themes', () => {
        const roles = new Set(pairs.map((p) => p.role));
        for (const cat of [
            'food', 'services', 'labour', 'tools', 'goods', 'garden', 'housing', 'transport',
            'education', 'arts', 'health', 'care', 'animals', 'tech', 'energy', 'mindset',
            'general', 'event', 'pulse',
        ]) {
            expect(roles).toContain(`tile.${cat}`);
        }
    });

    it('covers every card role for the fifteen hues plus amber, in both themes', () => {
        const roles = new Set(pairs.map((p) => p.role));
        for (const hue of [
            'sage', 'sky', 'blue', 'indigo', 'violet', 'plum', 'pink', 'rose',
            'clay', 'orange', 'yellow', 'lime', 'green', 'teal', 'sand', 'amber',
        ]) {
            expect(roles).toContain(`card.${hue}`);
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

    it("judges a web-only ink on exactly the web app's page, card and sunken grounds, and the phone never reads one", () => {
        const css = readFileSync(WEB_CSS, 'utf8');
        const declared = (i: number) => ['primary', 'secondary', 'card']
            .map((name) => [...css.matchAll(new RegExp(`--bg-${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))][i][1].toLowerCase()).sort();
        expect([...WEB_INK_GROUNDS.light].sort()).toEqual(declared(0));
        expect([...WEB_INK_GROUNDS.dark].sort()).toEqual(declared(1));
        for (const theme of ['light', 'dark'] as const) for (const g of WEB_INK_GROUNDS[theme]) expect(INK_GROUNDS[theme]).toContain(g);
        const phone = readFileSync(resolve(ROOT, 'apps/native/constants/colors.ts'), 'utf8');
        for (const name of WEB_ONLY_INKS) {
            expect(Object.keys(BRAND_COLOURS.ink), name).toContain(name);
            expect(phone, `the phone reads ink.${name}`).not.toMatch(new RegExp(`\\bink\\.${name}\\b`));
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
            if (role === 'chip' || role === 'tile' || role === 'card' || role === 'ink' || role === 'deal' || role === 'map' || role === 'bubble' || role === 'gold') continue;
            const fill = node as { fill: { light: string }; hover: { light: string } };
            expect(contrastRatio('#ffffff', fill.hover.light), role).toBeGreaterThan(contrastRatio('#ffffff', fill.fill.light));
        }
    });

    it('presses toward more contrast with its own words, in every set', () => {
        // Darker under white words, lighter under charcoal (gold; the sage accent in dark, Marty 14 Oct 2026; the blue in Dark).
        expect(pressingFailures(fillRoles())).toEqual([]);
        // Can fail: a pressed fill no further from its words than the fill itself.
        expect(pressingFailures([{ role: 'accent', fill: BRAND_COLOURS.accent.fill, hover: BRAND_COLOURS.accent.fill, on: BRAND_COLOURS.accent.on }])).toHaveLength(BRAND_SETS.length);
    });

    it('the accent is sage: nature-600 under white words in light, a light sage under charcoal in dark', () => {
        expect(BRAND_COLOURS.accent.fill.light).toBe('#647664');
        // Classic's two values exactly; Dark (night) has its own near-black words on the blue.
        expect(BRAND_COLOURS.accent.on).toEqual({ light: '#ffffff', dark: '#1d231d', night: '#0e1620' });
        expect(BRAND_COLOURS.ink.accent.dark).toBe(BRAND_COLOURS.accent.fill.dark);
        expect(BRAND_COLOURS.ink.accent.night).toBe(BRAND_COLOURS.accent.fill.night);
    });

    it('a sage button is the accent in light, and stays that deep fill in dark, drawn apart from the dark page', () => {
        // Director, 16 Oct 2026 (PR #1997): the accent's light sage drew + Create Group as a light block on the dark page.
        for (const part of ['fill', 'hover', 'on'] as const) {
            expect(BRAND_COLOURS.sage[part].light, part).toBe(BRAND_COLOURS.accent[part].light);
            expect(BRAND_COLOURS.sage[part].dark, part).toBe(BRAND_COLOURS.sage[part].light);
        }
        expect(contrastRatio(BRAND_COLOURS.sage.fill.dark, WEB_INK_GROUNDS.dark[0])).toBeGreaterThanOrEqual(3);
    });
});

describe('the card style box chips (chip.poll, chip.quiet, chip.info)', () => {
    // DESIGN-card-style-box-fable.md §1.2 (Marty, 4 Nov 2026): the chips the Market's cards drew with raw hex.
    it('POLL is the card.plum pair, so a poll and an event (tile.event, violet) are two hues', () => {
        expect(BRAND_COLOURS.chip.poll).toEqual({ tint: BRAND_COLOURS.card.plum.tint, ink: BRAND_COLOURS.card.plum.ink });
        expect(BRAND_COLOURS.chip.poll.tint).toEqual({ light: '#fae8ff', dark: '#4a044e' });
        expect(BRAND_COLOURS.chip.poll.ink).toEqual({ light: '#86198f', dark: '#f0abfc' });
        for (const theme of ['light', 'dark'] as const) {
            expect(BRAND_COLOURS.chip.poll.tint[theme], theme).not.toBe(BRAND_COLOURS.tile.event.tint[theme]);
            expect(BRAND_COLOURS.chip.poll.ink[theme], theme).not.toBe(BRAND_COLOURS.tile.event.ink[theme]);
        }
    });

    it('the quiet chip is nature-100 under nature-700 in light, nature-800 under nature-300 in dark', () => {
        // Classic's two values exactly; in Dark (night) the quiet chip is that set's own grey (ramp 800 under ramp 300).
        expect(BRAND_COLOURS.chip.quiet.tint).toEqual({ light: '#eef1ee', dark: '#434e43', night: '#474b55' });
        expect(BRAND_COLOURS.chip.quiet.ink).toEqual({ light: '#526052', dark: '#c0ccc0', night: '#c5c9d1' });
    });

    it('YOU is the tile.services blue pair', () => {
        expect(BRAND_COLOURS.chip.info).toEqual({ tint: BRAND_COLOURS.tile.services.tint, ink: BRAND_COLOURS.tile.services.ink });
        expect(BRAND_COLOURS.chip.info.tint).toEqual({ light: '#dbeafe', dark: '#172554' });
        expect(BRAND_COLOURS.chip.info.ink).toEqual({ light: '#1e40af', dark: '#93c5fd' });
    });

    it.each(['poll', 'quiet', 'info'] as const)('%s reads at 4.5:1 or more, ink on tint, in both themes', (name) => {
        for (const theme of ['light', 'dark'] as const) {
            const pair = brandContrastPairs().find((p) => p.theme === theme && p.role === `chip.${name}`);
            expect(pair, `${theme} chip.${name} is judged`).toBeDefined();
            expect(pair!.ratio, `${theme} chip.${name}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('reach the web as CSS variables and Tailwind names (bp-chip-poll-*, bp-chip-quiet-*, bp-chip-info-*)', () => {
        const { bp } = brandTailwindColours();
        for (const name of ['poll', 'quiet', 'info']) {
            for (const part of ['tint', 'ink']) {
                expect(bp[`chip-${name}-${part}`], `chip-${name}-${part}`).toBe(`var(--bp-chip-${name}-${part})`);
            }
        }
        expect(brandCssVariableMap('light')['--bp-chip-poll-ink']).toBe('#86198f');
        expect(brandCssVariableMap('dark')['--bp-chip-quiet-tint']).toBe('#434e43');
        expect(brandCssVariableMap('dark')['--bp-chip-info-ink']).toBe('#93c5fd');
    });
});

describe("a trade's lines in a direct message (deal.*)", () => {
    it('light is the web as it was: its old tints, words and outlines (Marty, 15 Oct: light as is)', () => {
        const light = Object.fromEntries(Object.entries(BRAND_COLOURS.deal).map(([name, line]) => [name, [rgbaOf(line.tint.light, DEAL_TINT_ALPHA), line.ink.light, line.border.light]]));
        expect(light).toEqual({
            held: ['rgba(209, 250, 229, 0.4)', '#065f46', '#10b981'],
            released: ['rgba(167, 243, 208, 0.4)', '#065f46', '#059669'],
            cancelled: ['rgba(254, 226, 226, 0.4)', '#991b1b', '#ef4444'],
        });
    });

    it("the phone's tints are the same colours (colors.ts lays them at 0.7)", () => {
        const phone = readFileSync(resolve(ROOT, 'apps/native/constants/colors.ts'), 'utf8');
        for (const name of ['held', 'released', 'cancelled']) expect(phone).toMatch(new RegExp(`rgbaOf\\(brand(?:Light|Dark)\\.deal\\.${name}\\.tint, 0\\.7\\)`));
    });

    it('in dark, each outline shows: 3:1 or more on the page and on its own pill', () => {
        for (const [name, line] of Object.entries(BRAND_COLOURS.deal)) {
            for (const ground of WEB_INK_GROUNDS.dark) {
                expect(contrastRatio(line.border.dark, ground), `${name} on ${ground}`).toBeGreaterThanOrEqual(3);
                expect(contrastRatio(line.border.dark, blendOver(line.tint.dark, DEAL_TINT_ALPHA, ground)), `${name} pill on ${ground}`).toBeGreaterThanOrEqual(3);
            }
        }
    });

    it('blendOver and rgbaOf', () => {
        expect(blendOver('#ffffff', 0.5, '#000000')).toBe('#808080');
        expect(blendOver('#d1fae5', 0, '#1d231d')).toBe('#1d231d');
        expect(rgbaOf('#022c22', 0.7)).toBe('rgba(2, 44, 34, 0.7)');
    });
});

describe('brandColours(set)', () => {
    it('resolves every leaf to that set, a leaf with no value of its own to its scheme', () => {
        const light = brandColours('light');
        const dark = brandColours('dark');
        const night = brandColours('night');
        expect(light.cta.fill).toBe('#b85236');
        expect(light.ink.brand).toBe('#047857');
        expect(dark.ink.brand).toBe('#34d399');
        expect(dark.chip.ok.tint).toBe('#022c22');
        expect(night.ink.brand).toBe('#34d399');
        expect(night.accent.fill).toBe('#4cc2ff');
        for (const { path, colour } of brandColourLeaves()) {
            const get = (tree: unknown) => path.split('.').reduce((n, k) => (n as Record<string, unknown>)[k], tree);
            expect(get(light), path).toBe(colour.light);
            expect(get(dark), path).toBe(colour.dark);
            expect(get(night), path).toBe(colour.night ?? colour.dark);
        }
    });
});

describe('CSS for the web app and the manager', () => {
    it('writes every role but the phone-only ones, light under :root and dark under :root.dark', () => {
        const css = brandCssVariables();
        const [light, dark] = css.split(':root.dark {');
        expect(light).toContain(':root {');
        expect(dark).toBeDefined();
        for (const { path, colour } of brandColourLeaves()) {
            const name = `--bp-${path.split('.').join('-')}`;
            if (PHONE_ONLY_ROLES.includes(path.split('.')[0])) {
                expect(css, name).not.toContain(`${name}:`);
                continue;
            }
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
        // The deal tints as the web lays them: plain rgba, light exactly the old web values.
        expect(brandCssVariableMap('light')['--bp-deal-held-wash']).toBe('rgba(209, 250, 229, 0.4)');
        expect(brandCssVariableMap('light')['--bp-deal-released-wash']).toBe('rgba(167, 243, 208, 0.4)');
        expect(brandCssVariableMap('light')['--bp-deal-cancelled-wash']).toBe('rgba(254, 226, 226, 0.4)');
        expect(brandCssVariableMap('dark')['--bp-deal-held-wash']).toBe('rgba(2, 44, 34, 0.4)');
        const { bp } = brandTailwindColours();
        expect(bp['cta-fill']).toBe('var(--bp-cta-fill)');
        expect(bp['chip-warn-tint']).toBe('var(--bp-chip-warn-tint)');
        const phoneOnly = brandColourLeaves().filter(({ path }) => PHONE_ONLY_ROLES.includes(path.split('.')[0]));
        expect(phoneOnly.map((l) => l.path)).toEqual(['bubble.tint', 'bubble.ink']);
        expect(Object.keys(bp).length).toBe(brandColourLeaves().length - phoneOnly.length);
        expect(Object.keys(bp).filter((n) => n.startsWith('bubble'))).toEqual([]);
    });

    it("brandCssVariableMap('night') is Dark's: the accent family in blue and grey, every other role Classic dark's", () => {
        const dark = brandCssVariableMap('dark');
        const night = brandCssVariableMap('night');
        expect(Object.keys(night)).toEqual(Object.keys(dark));
        const differ = Object.keys(night).filter((name) => night[name] !== dark[name]).sort();
        // The 17 themed leaves less the two phone-only bubble ones.
        expect(differ).toEqual([
            '--bp-accent-fill', '--bp-accent-hover', '--bp-accent-on', '--bp-card-sage-ink', '--bp-card-sage-tint',
            '--bp-chip-accent-border', '--bp-chip-accent-ink', '--bp-chip-accent-tint', '--bp-chip-quiet-ink', '--bp-chip-quiet-tint',
            '--bp-ink-accent', '--bp-sage-fill', '--bp-sage-hover', '--bp-tile-general-ink', '--bp-tile-general-tint',
        ]);
        expect(night['--bp-accent-fill']).toBe('#4cc2ff');
        expect(night['--bp-sage-on']).toBe('#ffffff');
    });
});

describe('the event violet (detail pages D0, DESIGN-detail-pages-fable.md §2.7)', () => {
    it('is one deep violet fill under white words in both themes, pressing deeper', () => {
        expect(BRAND_COLOURS.event.fill).toEqual({ light: '#6d28d9', dark: '#6d28d9' });
        expect(BRAND_COLOURS.event.hover).toEqual({ light: '#5b21b6', dark: '#5b21b6' });
        expect(BRAND_COLOURS.event.on).toEqual({ light: '#ffffff', dark: '#ffffff' });
        expect(contrastRatio('#ffffff', BRAND_COLOURS.event.fill.light)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio('#ffffff', BRAND_COLOURS.event.hover.light)).toBeGreaterThan(contrastRatio('#ffffff', BRAND_COLOURS.event.fill.light));
    });

    it("ink.event is the event tile's own ink: violet-800 in light, violet-300 in dark", () => {
        expect(BRAND_COLOURS.ink.event).toEqual({ light: '#5b21b6', dark: '#c4b5fd' });
        expect(BRAND_COLOURS.ink.event).toEqual(BRAND_COLOURS.tile.event.ink);
    });

    it('ink.event reads 4.5:1 or more on every ground both apps draw a page or card on, in both themes', () => {
        const mine = brandContrastPairs().filter((p) => p.role === 'ink.event');
        for (const theme of ['light', 'dark'] as const) {
            expect(mine.filter((p) => p.theme === theme).map((p) => p.ground), theme).toEqual([...INK_GROUNDS[theme]]);
        }
        for (const p of mine) expect(p.ratio, `${p.theme} ${p.ink} on ${p.ground}`).toBeGreaterThanOrEqual(4.5);
    });

    it('event.on is judged on the fill and on the pressed fill', () => {
        const mine = brandContrastPairs().filter((p) => p.role === 'event');
        expect(mine.map((p) => `${p.theme} ${p.pair}`).sort()).toEqual(['dark on / fill', 'dark on / hover', 'light on / fill', 'light on / hover', 'night on / fill', 'night on / hover']);
        for (const p of mine) expect(p.ratio, `${p.theme} ${p.pair}`).toBeGreaterThanOrEqual(4.5);
    });

    it('the web gets bp-event-fill / -hover / -on and bp-ink-event, and no other event name', () => {
        const names = Object.keys(brandTailwindColours().bp).filter((n) => n.startsWith('event') || n === 'ink-event').sort();
        expect(names).toEqual(['event-fill', 'event-hover', 'event-on', 'ink-event']);
        expect(brandCssVariableMap('light')['--bp-event-fill']).toBe('#6d28d9');
        expect(brandCssVariableMap('dark')['--bp-event-fill']).toBe('#6d28d9');
        expect(brandCssVariableMap('light')['--bp-ink-event']).toBe('#5b21b6');
        expect(brandCssVariableMap('dark')['--bp-ink-event']).toBe('#c4b5fd');
    });
});

describe('docs/brand-colours.md', () => {
    const doc = readFileSync(DOC, 'utf8');

    it('lists every role with the values in brand-colours.ts, in its three columns (Light, Classic, Dark)', () => {
        expect(docRowsMissing(doc, brandColourLeaves())).toEqual([]);
        // Can fail: a Dark value the doc does not carry.
        expect(docRowsMissing(doc, [{ path: 'accent.fill', colour: { light: '#647664', dark: '#c0ccc0', night: '#123456' } }])).toHaveLength(1);
    });

    it('lists every ground with the values in brand-colours.ts, in the same three columns', () => {
        expect(docRowsMissing(doc, groundLeaves())).toEqual([]);
    });
});

// ── Sets: Light, Classic and Dark (DESIGN-themes-fable.md §8.1; Marty and Damo, 12 Nov 2026) ──────────────────────────────

/** Every Themed leaf of a tree with its dotted path. */
function leavesOf(tree: unknown, path: string[] = []): Array<{ path: string; colour: Themed }> {
    const node = tree as Record<string, unknown>;
    if (typeof node.light === 'string' && typeof node.dark === 'string') return [{ path: path.join('.'), colour: node as unknown as Themed }];
    return Object.entries(node).flatMap(([key, child]) => leavesOf(child, [...path, key]));
}

const groundLeaves = () => leavesOf(BRAND_GROUNDS);

/** The doc rows a list of leaves needs and the doc lacks: `| path | light | Classic dark | Dark |`. */
function docRowsMissing(doc: string, leaves: Array<{ path: string; colour: Themed }>): string[] {
    return leaves
        .map(({ path, colour }) => `| \`${path}\` | \`${colour.light}\` | \`${colour.dark}\` | \`${colourIn(colour, 'night')}\` |`)
        .filter((row) => !doc.includes(row));
}

/** The fill roles (fill, hover, on), as Themed leaves. */
function fillRoles(): Array<{ role: string; fill: Themed; hover: Themed; on: Themed }> {
    return Object.entries(BRAND_COLOURS)
        .filter(([, node]) => 'fill' in node && 'hover' in node && 'on' in node)
        .map(([role, node]) => ({ role, ...(node as { fill: Themed; hover: Themed; on: Themed }) }));
}

/** A fill whose pressed colour is not further from its words than the fill, per set. */
function pressingFailures(roles: Array<{ role: string; fill: Themed; hover: Themed; on: Themed }>): string[] {
    const out: string[] = [];
    for (const { role, fill, hover, on } of roles) {
        for (const set of BRAND_SETS) {
            const pressed = contrastRatio(colourIn(on, set), colourIn(hover, set));
            const resting = contrastRatio(colourIn(on, set), colourIn(fill, set));
            if (!(pressed > resting)) out.push(`${set} ${role}: pressed ${pressed.toFixed(2)} is not above ${resting.toFixed(2)}`);
        }
    }
    return out;
}

/**
 * The 17 leaves a set beyond Classic may give its own value (DESIGN-themes-fable.md §3.2): the sage accent family and the
 * own chat bubble. `accent`: the one free colour, judged directly (its words, its ink on every ground, its fill as a dot).
 * `ground`: a tint, border or bubble, held to Classic dark's lightness and never lighter. `grey`: words in the set's own
 * grey, held to Classic's lightness and never darker. Adding an 18th, or a Dark colour for danger, fails here.
 */
const THEMED_LEAVES: Readonly<Record<string, 'accent' | 'ground' | 'grey'>> = {
    'accent.fill': 'accent',
    'accent.hover': 'accent',
    'accent.on': 'accent',
    'sage.fill': 'accent',
    'sage.hover': 'accent',
    'chip.accent.tint': 'ground',
    'chip.accent.ink': 'accent',
    'chip.accent.border': 'ground',
    'chip.quiet.tint': 'ground',
    'chip.quiet.ink': 'grey',
    'tile.general.tint': 'ground',
    'tile.general.ink': 'grey',
    'card.sage.tint': 'ground',
    'card.sage.ink': 'grey',
    'ink.accent': 'accent',
    'bubble.tint': 'ground',
    'bubble.ink': 'accent',
};

/** Leaves with a value of their own in a set beyond Classic's, and leaves with a key that is not a set. */
function structureFailures(leaves: Array<{ path: string; colour: Themed }>, allowed: readonly string[]): string[] {
    const out: string[] = [];
    for (const { path, colour } of leaves) {
        for (const key of Object.keys(colour)) if (!(BRAND_SETS as readonly string[]).includes(key)) out.push(`${path} has a "${key}" value, which is not a set`);
        if (colour.night !== undefined && !allowed.includes(path)) out.push(`${path} has a Dark (night) value of its own`);
    }
    for (const path of allowed) if (!leaves.some((l) => l.path === path && l.colour.night !== undefined)) out.push(`${path} is listed but has no Dark value`);
    return out;
}

/**
 * The lightness rule (§3.3.1): Dark changes a colour's hue, never how light it is. Each value within `band` of Classic dark's
 * contrast against itself, and one-sided: `dark` side never lighter than Classic's, `light` side never darker.
 */
function lightnessFailures(values: Array<{ name: string; classic: string; dark: string; side: 'dark' | 'light' }>, band = 1.02): string[] {
    const out: string[] = [];
    for (const { name, classic, dark, side } of values) {
        const drift = contrastRatio(classic, dark);
        if (drift > band) out.push(`${name}: ${dark} drifts ${((drift - 1) * 100).toFixed(2)} % from Classic's ${classic}`);
        const lc = relativeLuminance(classic);
        const ld = relativeLuminance(dark);
        if (side === 'dark' && ld > lc) out.push(`${name}: ${dark} is lighter than Classic's ${classic}`);
        if (side === 'light' && ld < lc) out.push(`${name}: ${dark} is darker than Classic's ${classic}`);
    }
    return out;
}

/** Every Dark value the lightness rule holds: the ramp, the grounds, and the themed tints, borders and greys. */
function lightnessValues(): Array<{ name: string; classic: string; dark: string; side: 'dark' | 'light' }> {
    const out: Array<{ name: string; classic: string; dark: string; side: 'dark' | 'light' }> = [];
    for (const { path, colour } of groundLeaves()) {
        if (colour.night === undefined) continue;
        const step = path.startsWith('web.ramp.') ? Number(path.slice('web.ramp.'.length)) : undefined;
        // The ramp's light half (50 to 500) and the doodle's line sit above their grounds: never darker.
        const side = (step !== undefined && step <= 500) || path === 'doodle.line' ? 'light' : 'dark';
        out.push({ name: path, classic: colour.dark, dark: colour.night, side });
    }
    for (const { path, colour } of brandColourLeaves()) {
        const kind = THEMED_LEAVES[path];
        if (kind === 'ground' || kind === 'grey') out.push({ name: path, classic: colour.dark, dark: colourIn(colour, 'night'), side: kind === 'ground' ? 'dark' : 'light' });
    }
    return out;
}

/** WCAG-free hue of a #rrggbb colour, in degrees (HSL). */
function hueOf(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}

/** HSL saturation of a #rrggbb colour, 0 to 1. */
function saturationOf(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

const hueApart = (a: string, b: string) => {
    const d = Math.abs(hueOf(a) - hueOf(b));
    return Math.min(d, 360 - d);
};

/** The hue guard (§3.5): an accent at least 30 degrees of hue from the inks that carry a meaning in that set. */
function hueGuardFailures(accent: string, set: BrandSet): string[] {
    const c = brandColours(set);
    const meanings = { danger: c.ink.danger, warning: c.ink.warning, Need: c.chip.need.ink, success: c.ink.success };
    return Object.entries(meanings)
        .filter(([, ink]) => hueApart(accent, ink) < 30)
        .map(([name, ink]) => `${set}: ${accent} is ${hueApart(accent, ink).toFixed(0)} degrees from ${name} ${ink}`);
}

/** A colour drawn as a bar, dot or badge (never words) under 3:1 on a ground. */
function underThree(colour: string, grounds: readonly string[]): string[] {
    return grounds.filter((g) => contrastRatio(colour, g) < 3).map((g) => `${colour} on ${g} is ${contrastRatio(colour, g).toFixed(2)}:1`);
}

/** The card lifts off what it lies on, in a dark set (§3.4): 1.15 off the doodle's ground, 1.25 off the page. */
function liftFailures(g: { card: string; doodle: string; page: string }): string[] {
    const out: string[] = [];
    if (contrastRatio(g.card, g.doodle) < 1.15) out.push(`card ${g.card} lifts ${contrastRatio(g.card, g.doodle).toFixed(3)} off the doodle ${g.doodle}`);
    if (contrastRatio(g.card, g.page) < 1.25) out.push(`card ${g.card} lifts ${contrastRatio(g.card, g.page).toFixed(3)} off the page ${g.page}`);
    return out;
}

/** Charcoal, not olive: a blue-grey (hue 200 to 250 degrees) with little colour (saturation under 20 %). */
function notCharcoal(hex: string): string[] {
    const h = hueOf(hex);
    const s = saturationOf(hex);
    return h >= 200 && h <= 250 && s < 0.2 ? [] : [`${hex} is hue ${h.toFixed(0)}, saturation ${(s * 100).toFixed(0)} %`];
}

describe('sets: Light and Classic (light, dark) as before, Dark (night) new', () => {
    it('three sets, each with its scheme; Classic is the default; no Dusk or Ember anywhere', () => {
        expect(BRAND_SETS).toEqual(['light', 'dark', 'night']);
        expect(BRAND_SETS.map(brandScheme)).toEqual(['light', 'dark', 'dark']);
        expect(DEFAULT_BRAND_SET).toBe('dark');
        const src = readFileSync(resolve(HERE, '../brand-colours.ts'), 'utf8');
        expect(src).not.toMatch(/\bdusk\b/i);
        expect(src).not.toMatch(/\bember\b/i);
    });

    it('only the 17 listed leaves carry a Dark value; danger, money, gold, Need and events have none', () => {
        expect(Object.keys(THEMED_LEAVES)).toHaveLength(17);
        expect(structureFailures(brandColourLeaves(), Object.keys(THEMED_LEAVES))).toEqual([]);
        // Can fail: danger given a Dark colour, and a leaf with a key that is not a set.
        const wrong = [...brandColourLeaves(), { path: 'danger.fill', colour: { light: '#b91c1c', dark: '#b91c1c', night: '#ff0000' } }];
        expect(structureFailures(wrong, Object.keys(THEMED_LEAVES))).toEqual(['danger.fill has a Dark (night) value of its own']);
        const dusk = [{ path: 'accent.fill', colour: { light: '#647664', dark: '#c0ccc0', dusk: '#fb86cf' } as unknown as Themed }];
        expect(structureFailures(dusk, ['accent.fill'])).toContain('accent.fill has a "dusk" value, which is not a set');
        // The grounds may only carry a set's value too.
        expect(structureFailures(groundLeaves(), groundLeaves().filter((l) => l.colour.night !== undefined).map((l) => l.path))).toEqual([]);
    });

    it("holds Dark to Classic dark's lightness: within 2 %, grounds never lighter, the light greys never darker", () => {
        const values = lightnessValues();
        // The ramp's 11 steps, the 7 themed grounds (doodle ground and line, phone card, web page, card, sunken, banner)
        // and the 9 themed tints, borders and greys.
        expect(values).toHaveLength(11 + 7 + 9);
        expect(lightnessFailures(values)).toEqual([]);
        const worst = Math.max(...values.map((v) => contrastRatio(v.classic, v.dark)));
        expect(worst).toBeLessThan(1.011);
        // Can fail: a ground made lighter (the sunken grey as the page), and a light grey made darker.
        expect(lightnessFailures([{ name: 'web.page', classic: '#1d231d', dark: '#3a3e46', side: 'dark' }])).toHaveLength(2);
        expect(lightnessFailures([{ name: 'web.ramp.300', classic: '#c0ccc0', dark: '#bfcbbf', side: 'light' }])).toEqual(["web.ramp.300: #bfcbbf is darker than Classic's #c0ccc0"]);
    });

    it('keeps the accent at least 30 degrees of hue from danger, warning, Need and success, in every set', () => {
        for (const set of BRAND_SETS) expect(hueGuardFailures(brandColours(set).accent.fill, set), set).toEqual([]);
        // Can fail: an ember accent sits on danger and Need (why Ember was left out, §3.5).
        expect(hueGuardFailures('#ff8a5c', 'night').length).toBeGreaterThan(0);
        expect(hueGuardFailures('#ff8a5c', 'night').join('\n')).toMatch(/danger/);
    });

    it("draws the accent's fill as a bar, dot or badge at 3:1 on every ground of its set", () => {
        for (const set of BRAND_SETS) expect(underThree(brandColours(set).accent.fill, brandInkGrounds(set)), set).toEqual([]);
        // Can fail: the web's dark card colour as an accent.
        expect(underThree('#2a322a', brandInkGrounds('dark')).length).toBeGreaterThan(0);
    });

    it("draws the sage button 3:1 or more against the web's page, in every set", () => {
        for (const set of BRAND_SETS) expect(underThree(brandColours(set).sage.fill, [brandGrounds(set).web.page]), set).toEqual([]);
        expect(contrastRatio(brandColours('night').sage.fill, brandGrounds('night').web.page)).toBeGreaterThanOrEqual(3);
        // Can fail: a sage button the colour of the web's dark card.
        expect(underThree('#2a322a', [brandGrounds('night').web.page])).toHaveLength(1);
    });

    it('lifts the phone card 1.15 off the doodle and 1.25 off the page, in each dark set', () => {
        for (const set of BRAND_SETS.filter((s) => brandScheme(s) === 'dark')) {
            const g = brandGrounds(set);
            expect(liftFailures({ card: g.phone.card, doodle: g.doodle.ground, page: g.phone.page }), set).toEqual([]);
        }
        // Can fail: a card the colour of the doodle's ground.
        expect(liftFailures({ card: '#17191c', doodle: '#17191c', page: '#0a0a0a' })).toHaveLength(2);
    });
});

describe("Dark's doodle and banner: charcoal, not olive (Marty and Damo, 12 Nov 2026; slice T5 reads them)", () => {
    const classic = brandGrounds('dark');
    const dark = brandGrounds('night');

    it("Classic's doodle and banner are as the apps draw them today", () => {
        const phone = readFileSync(resolve(ROOT, 'apps/native/app/ThemeContext.tsx'), 'utf8');
        expect(phone).toContain(`PATTERN_GROUND = { light: '${brandGrounds('light').doodle.ground}', dark: '${classic.doodle.ground}' }`);
        const css = readFileSync(WEB_CSS, 'utf8');
        const declared = (name: string) => [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1].toLowerCase());
        expect(declared('pattern-bg')).toEqual([brandGrounds('light').doodle.ground, classic.doodle.ground]);
        expect(declared('header-bg')).toEqual([brandGrounds('light').web.banner, classic.web.banner]);
    });

    it("Dark's doodle ground and banner ground are charcoal; Classic's are not", () => {
        expect(notCharcoal(dark.doodle.ground)).toEqual([]);
        expect(notCharcoal(dark.doodle.line)).toEqual([]);
        expect(notCharcoal(dark.web.banner)).toEqual([]);
        // Can fail: Classic's olive grounds.
        expect(notCharcoal(classic.doodle.ground)).toHaveLength(1);
        expect(notCharcoal(classic.web.banner)).toHaveLength(1);
    });

    it("Dark's doodle line stands off its ground as Classic's does (within 1 %), and the card lifts off it as Classic's", () => {
        const lift = (g: typeof dark) => contrastRatio(g.doodle.line, g.doodle.ground);
        expect(lift(classic).toFixed(2)).toBe('1.50'); // measured on main's @2x tile: the median line, #303a37 on #141a1a
        expect(Math.abs(lift(dark) / lift(classic) - 1)).toBeLessThan(0.01);
        expect(contrastRatio(dark.phone.card, dark.doodle.ground).toFixed(2)).toBe('1.16');
        expect(contrastRatio(classic.phone.card, classic.doodle.ground).toFixed(2)).toBe('1.17');
        // Can fail: a line drawn at the ground's own lightness.
        expect(Math.abs(contrastRatio(dark.doodle.ground, dark.doodle.ground) / lift(classic) - 1)).toBeGreaterThan(0.01);
    });
});

describe('brandSwatch: the dots a look shows in the picker', () => {
    it('reads the page (the doodle ground), the card and the accent from the library, per app', () => {
        expect(brandSwatch('dark', 'phone')).toEqual({ page: '#141a1a', card: '#222822', accent: '#c0ccc0' });
        expect(brandSwatch('dark', 'web')).toEqual({ page: '#141a1a', card: '#2a322a', accent: '#c0ccc0' });
        expect(brandSwatch('light', 'phone')).toEqual({ page: '#f1f1e4', card: '#ffffff', accent: '#647664' });
        expect(brandSwatch('night', 'phone')).toEqual({ page: '#17191c', card: '#24262c', accent: '#4cc2ff' });
        expect(brandSwatch('light', 'web')).toEqual({ page: '#f1f1e4', card: '#ffffff', accent: '#647664' });
        expect(brandSwatch('night', 'web')).toEqual({ page: '#17191c', card: '#2d3036', accent: '#4cc2ff' });
    });

    it('tells the three looks apart by their accent', () => {
        const accents = BRAND_SETS.map((set) => brandSwatch(set, 'phone').accent);
        expect(new Set(accents).size).toBe(3);
    });
});

describe("Classic is exactly main's (snapshot of main 6513fb9e, taken before T0)", () => {
    const MAIN = JSON.parse(readFileSync(resolve(HERE, 'fixtures/brand-colours-main-6513fb9e.json'), 'utf8'));

    it("brandColours('light') and ('dark') deep-equal main, plus only the new phone bubble role", () => {
        for (const set of ['light', 'dark'] as const) {
            const { bubble, ...rest } = brandColours(set);
            expect(rest, set).toEqual(MAIN.brandColours[set]);
            expect(JSON.stringify(rest), `${set} key order`).toBe(JSON.stringify(MAIN.brandColours[set]));
            // The phone's own bubble today (apps/native/constants/colors.ts chat.messageMeBg / messageTextMe), unchanged.
            expect(bubble, set).toEqual(set === 'light' ? { tint: '#d8f2e1', ink: '#1e291e' } : { tint: '#1e2923', ink: '#e6f4ea' });
        }
    });

    it("brandCssVariableMap('light') and ('dark') deep-equal main, key order too", () => {
        for (const set of ['light', 'dark'] as const) {
            expect(brandCssVariableMap(set), set).toEqual(MAIN.brandCssVariableMap[set]);
            expect(JSON.stringify(brandCssVariableMap(set)), set).toBe(JSON.stringify(MAIN.brandCssVariableMap[set]));
        }
        expect(brandCssVariables()).toBe(MAIN.brandCssVariables);
        const mainNames = Object.keys(MAIN.brandCssVariableMap.dark).filter((n) => !n.endsWith('-wash')).map((n) => n.slice('--bp-'.length));
        expect(Object.keys(brandTailwindColours().bp)).toEqual(mainNames);
    });

    it('INK_GROUNDS and WEB_INK_GROUNDS, now derived from the grounds, deep-equal main, order too', () => {
        expect(INK_GROUNDS).toEqual(MAIN.INK_GROUNDS);
        expect(WEB_INK_GROUNDS).toEqual(MAIN.WEB_INK_GROUNDS);
        expect(MANAGER_GROUNDS).toEqual({ page: '#0b110b', card: '#151e16', raised: '#2b422c' });
    });

    it("Dark's contrast pairs all reach 4.5 (the lowest named, as in the design's §3.4)", () => {
        const night = brandContrastPairs().filter((p) => p.theme === 'night');
        const lowest = (role: string) => Math.min(...night.filter((p) => p.role === role).map((p) => p.ratio));
        expect(lowest('accent').toFixed(2)).toBe('9.07');
        expect(lowest('sage').toFixed(2)).toBe('4.90');
        expect(lowest('ink.accent').toFixed(2)).toBe('5.35');
        expect(lowest('chip.accent').toFixed(2)).toBe('5.39');
        expect(lowest('chip.quiet').toFixed(2)).toBe('5.26');
        expect(lowest('bubble').toFixed(2)).toBe('13.55');
        expect(lowest('ink.terra').toFixed(2)).toBe('4.60');
        for (const p of night) expect(p.ratio, `${p.role} ${p.pair}`).toBeGreaterThanOrEqual(p.min);
    });
});
