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
        nature: {
          50: '#f6f7f6',
          100: '#eef1ee',
          200: '#dce3dc',
          300: '#c0ccc0',
          400: '#9eaf9e',
          500: '#809380',
          600: '#647664', // Sage Green primary
          700: '#526052',
          800: '#434e43',
          900: '#384038',
          950: '#1d231d', // Charcoal
        },
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
        accent: 'var(--accent)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
