import plugin from 'tailwindcss/plugin';
import { BRAND_SETS, brandCssVariableMap, brandGrounds, brandTailwindColours } from '@beanpool/core/brand-colours';

/*
 * Every colour that changes with the look comes from the shared library (packages/beanpool-core/src/brand-colours.ts,
 * docs/brand-colours.md): the plugin below writes it into index.css's @tailwind base as CSS variables, Light under :root,
 * Classic under :root.dark-theme, and each further set (Dark is `night` in code) under :root.dark-theme[data-bp-theme="…"]
 * with only what that set changes. Two kinds:
 *   - the brand roles (--bp-cta-fill …), which brandTailwindColours() names, so a control writes bg-bp-commit-fill
 *     hover:bg-bp-commit-hover text-bp-commit-on;
 *   - the web's base: the grey ramp as colour channels (--bp-n-900: 56 64 56), so the `nature` scale below keeps every
 *     `/50` opacity class working on old Android WebViews (rgb(r g b / a), no color-mix()), and the grounds the base
 *     variables in index.css read (--bp-web-page, --bp-web-card, --bp-web-sunken, --bp-web-banner, --bp-doodle-ground).
 * Change a colour there, never here, in index.css or in a screen.
 */

/** The steps of the web's grey ramp, Tailwind's `nature` scale. */
export const RAMP_STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

/** '#384038' → '56 64 56': a colour as the channels rgb(var(--bp-n-900) / <alpha-value>) takes. */
export function channels(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(' ');
}

/** One set's web base: the ramp as channels, and the grounds index.css's base variables read. */
export function webBaseVariableMap(set) {
    const g = brandGrounds(set);
    const out = {};
    for (const step of RAMP_STEPS) out[`--bp-n-${step}`] = channels(g.web.ramp[step]);
    out['--bp-web-page'] = g.web.page;
    out['--bp-web-card'] = g.web.card;
    out['--bp-web-sunken'] = g.web.sunken;
    out['--bp-web-banner'] = g.web.banner;
    out['--bp-doodle-ground'] = g.doodle.ground;
    return out;
}

/** Everything one set writes: the brand roles and the web base. */
export function webSetVariableMap(set) {
    return { ...brandCssVariableMap(set), ...webBaseVariableMap(set) };
}

/** The sets beyond Classic's two, each written as a block on top of Classic dark (each is a dark look). */
export const THEME_BLOCK_SETS = BRAND_SETS.filter((set) => set !== 'light' && set !== 'dark');

/** The selector a further set's block is written under. The picker (slice T3: src/lib/useTheme.ts and public/theme-boot.js) sets the attribute on <html>. */
export const themeBlockSelector = (set) => `:root.dark-theme[data-bp-theme="${set}"]`;

/** Only the variables a set changes from Classic dark: the rest it inherits from :root.dark-theme. */
export function themeBlockVariables(set) {
    const classic = webSetVariableMap('dark');
    return Object.fromEntries(Object.entries(webSetVariableMap(set)).filter(([name, value]) => classic[name] !== value));
}

/** The whole base the plugin writes, selector → variables, in cascade order. */
export function brandBase() {
    const base = { ':root': webSetVariableMap('light'), ':root.dark-theme': webSetVariableMap('dark') };
    for (const set of THEME_BLOCK_SETS) base[themeBlockSelector(set)] = themeBlockVariables(set);
    return base;
}

const brandVariables = plugin(({ addBase }) => {
  addBase(brandBase());
});

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'selector',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ...brandTailwindColours(),
        // The grey ramp, from the library per set (webBaseVariableMap): `nature` names the accent family by its Classic
        // colour, and is Dark's charcoal greys in Dark.
        nature: Object.fromEntries(RAMP_STEPS.map((step) => [step, `rgb(var(--bp-n-${step}) / <alpha-value>)`])),
        terra: {
          50: '#fdf7f5',
          100: '#fcedea',
          200: '#f7d8ce',
          300: '#f0bcab',
          400: '#e5967f',
          500: '#d87254', // Soft Terracotta
          600: '#c2583b',
          700: '#a3472e',
          800: '#863b28',
          900: '#6f3424',
          950: '#3c180e',
        },
        oat: {
          50: '#fbfaf8',
          100: '#f6f4f0',
          200: '#ebe6df',
          300: '#dfd7c9',
          400: '#d0c2b0',
          500: '#bca992', // Base oat background
          600: '#a5927b',
          700: '#897864',
          800: '#6f6254',
          900: '#5b5046',
          950: '#302a25',
        },
        bg: {
          primary: 'var(--bg-primary)',
          secondary: 'var(--bg-secondary)',
          card: 'var(--bg-card)',
          input: 'var(--bg-input)',
          hover: 'var(--bg-hover)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          faint: 'var(--text-faint)',
        },
        border: {
          primary: 'var(--border-primary)',
          secondary: 'var(--border-secondary)',
          input: 'var(--border-input)',
        },
        link: 'var(--link)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      spacing: {
        'nav-height': 'var(--bottom-nav-height)',
        'nav-offset': 'var(--bottom-nav-offset)',
      },
    },
  },
  plugins: [brandVariables],
}
