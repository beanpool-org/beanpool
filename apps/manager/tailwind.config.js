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
        }
      }
    },
  },
  plugins: [],
};
