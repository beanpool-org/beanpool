import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/builds/**',
      '**/*.sample',
      '**/apps/website/**',
      '**/*.log',
    ],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      'preserve-caught-error': 'off',
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
      'no-empty': 'warn',
    },
  },
  // Native: exactly one KeyboardProvider, in app/_layout.tsx. A second one nested inside a Modal
  // broke keyboards app-wide (measured 2026-09-17). Screens and modals use the keyboard-controller
  // hooks/components under the root provider instead.
  {
    files: ['apps/native/**/*.{ts,tsx,js,jsx}'],
    ignores: ['apps/native/app/_layout.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'react-native-keyboard-controller',
          importNames: ['KeyboardProvider'],
          message: 'KeyboardProvider lives only in app/_layout.tsx. A nested provider breaks keyboards app-wide.',
        }],
      }],
      'no-restricted-syntax': ['error', {
        selector: "JSXOpeningElement[name.name='KeyboardProvider'], JSXOpeningElement[name.property.name='KeyboardProvider']",
        message: 'KeyboardProvider lives only in app/_layout.tsx. A nested provider breaks keyboards app-wide.',
      }],
    },
  }
);
