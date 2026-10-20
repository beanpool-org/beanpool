import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// The tool fence (scratch/tools/DESIGN-tool-template-fable.md §1.4, slice T0.1): a file inside a tool's folder imports
// React, @beanpool/core, its own folder and the template's host and primitives (apps/*/tools/host and ui), and nothing
// else; in core, its own folder, the template's modules and core's own. It reaches the app only through `host`, which
// keeps every tool one shape, keeps "what leaves the phone" true by construction, and is the bridge a sandboxed runtime
// plugin would get later (§5). A regex can't see where a file sits, so there is one block per depth inside the folder
// (an import may climb to the folder's top and no further). scripts/tools/fence.test.mjs holds each door shut.
const TOOL_FENCE_MESSAGE = 'A tool talks to the app through host: add a permission, not an import (docs/tools-template.md).';
const SEG = '(?!\\.\\.?(?:/|$))[^/]+';
const PATH = `${SEG}(?:/${SEG})*`;
const ups = (k) => '\\.\\./'.repeat(k);
/** Imports a file `depth` folders inside a tool may make: anything else is refused. */
function toolAllowed(app, depth) {
  const own = [`\\./${PATH}`, ...Array.from({ length: depth }, (_, k) => `${ups(k + 1)}${PATH}`)];
  const template = app
    ? [`${ups(depth + 1)}(?:host|ui)`, 'react', '@beanpool/core']
    : [`${ups(depth + 1)}(?:manifest|host|check|reconcile)\\.js`, `${ups(depth + 2)}(?!index\\.js$)${SEG}\\.js`];
  return `^(?!(?:${[...own, ...template].join('|')})$)`;
}
const TOOL_ROOTS = [
  { app: true, dir: 'apps/native/tools' },
  { app: true, dir: 'apps/pwa/src/tools' },
  { app: false, dir: 'packages/beanpool-core/src/tools' },
];
const KEYBOARD_PROVIDER_JSX = {
  selector: "JSXOpeningElement[name.name='KeyboardProvider'], JSXOpeningElement[name.property.name='KeyboardProvider']",
  message: 'KeyboardProvider lives only in app/_layout.tsx. A nested provider breaks keyboards app-wide.',
};
const TOOL_NO_NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'caches'];
/** One block's rules: imports by `regex`, require() and import() of the tool's own files only, no network or stores. */
const toolFenceRules = (regex, native) => ({
  'no-restricted-imports': ['error', { patterns: [{ regex, caseSensitive: true, message: TOOL_FENCE_MESSAGE }] }],
  'no-restricted-syntax': ['error',
    // By a literal and from its own folder: the phone's screens thunk is require('./screens').
    { selector: "CallExpression[callee.name='require']:not([arguments.0.value=/^\\.\\x2F/])", message: TOOL_FENCE_MESSAGE },
    { selector: "CallExpression[callee.name='require'][arguments.0.value=/\\.\\./]", message: TOOL_FENCE_MESSAGE },
    { selector: 'ImportExpression:not([source.value=/^\\.\\x2F/])', message: TOOL_FENCE_MESSAGE },
    { selector: 'ImportExpression[source.value=/\\.\\./]', message: TOOL_FENCE_MESSAGE },
    ...(native ? [KEYBOARD_PROVIDER_JSX] : []),
  ],
  // The network and the browser's stores are the host's (its one store, its node copy), never a tool's own: shut as a
  // global and as a member of anything (`window.fetch`, `globalThis.localStorage`, `const w = self; w.fetch`,
  // `const { fetch } = window`), with the beacon and the cookie jar.
  'no-restricted-globals': ['error', ...TOOL_NO_NETWORK.map((name) => ({ name, message: TOOL_FENCE_MESSAGE }))],
  'no-restricted-properties': ['error',
    ...[...TOOL_NO_NETWORK, 'sendBeacon'].map((property) => ({ property, message: TOOL_FENCE_MESSAGE })),
    { object: 'document', property: 'cookie', message: TOOL_FENCE_MESSAGE },
  ],
});
const TOOL_SOURCES = '*.{ts,tsx,js,jsx,mjs}';
// A tool's tests are never shipped and import their runner: they are outside the fence.
const TOOL_TESTS = ['**/__tests__/**', '**/*.test.*'];
const toolFence = TOOL_ROOTS.flatMap(({ app, dir }) => [
  ...[0, 1, 2, 3].map((depth) => ({
    files: [`${dir}/*/${'*/'.repeat(depth)}${TOOL_SOURCES}`],
    ignores: TOOL_TESTS,
    rules: toolFenceRules(toolAllowed(app, depth), dir.startsWith('apps/native')),
  })),
  // Deeper than that: its own files by ./ only.
  { files: [`${dir}/*/*/*/*/*/**/${TOOL_SOURCES}`], ignores: TOOL_TESTS, rules: toolFenceRules(`^(?!\\./${PATH}$)`, dir.startsWith('apps/native')) },
]);

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
  // The registrar (apps/registrar): a Cloudflare Worker and its node:test suites and scripts, in plain JS. The Worker runs
  // with the web platform's globals and the tests and scripts with node's, which eslint knows of for no .js file: every
  // use of them was a no-undef error.
  {
    files: ['apps/registrar/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        console: 'readonly', fetch: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly', URL: 'readonly',
        crypto: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortSignal: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', process: 'readonly',
      },
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
  },
  ...toolFence,
);
