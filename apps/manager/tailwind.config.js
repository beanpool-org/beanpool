// Brand and status colours come from the one library the phone and the web app use (docs/brand-colours.md):
// change a value in packages/beanpool-core/src/brand-colours.ts, never here or in a screen. The source path (as
// vite.config.ts's alias) so the config needs no built dist.
import { brandCssVariableMap, brandTailwindColours } from '../../packages/beanpool-core/src/brand-colours.ts';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        nature: {
          50: '#f4f7f4',
          100: '#e3ebe3',
          200: '#c6d9c7',
          300: '#9ebe9f',
          400: '#729d74',
          500: '#528054',
          600: '#3e6540',
          700: '#335134',
          800: '#2b422c',
          900: '#151e16',
          950: '#0b110b',
        },
        oat: {
          50: '#faf9f6',
          100: '#f3f0e8',
          200: '#e5decb',
          300: '#d4c7a8',
          400: '#c1ad81',
          500: '#b09661',
        },
        terra: {
          500: '#d96b43',
          600: '#c2532b',
        },
        // bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on, bg-bp-chip-ok-tint text-bp-chip-ok-ink, …
        ...brandTailwindColours(),
      }
    },
  },
  plugins: [
    // The custom properties those names point at: light under :root, dark under :root.dark (index.html sets `dark`).
    // The same two blocks brandCssVariables() writes.
    ({ addBase }) => addBase({
      ':root': brandCssVariableMap('light'),
      ':root.dark': brandCssVariableMap('dark'),
    }),
  ],
};
