#!/usr/bin/env node
//
// Undeclared-import guard for every workspace the Docker image builds.
//
// The repo's .npmrc sets node-linker=hoisted, so a bare import resolves from the root
// node_modules even when the importing package never declared it — Test-All goes green.
// The Dockerfile copies no .npmrc, so pnpm's isolated layout gives each package only its
// own declared deps and the build fails there instead. #1075 is the worked example: a
// server test file imported `multiformats/bases/base58`, apps/server had not declared it,
// and no image built for main across seven merges.
//
// So: for each package the Dockerfile builds, every bare import in its sources must be
// declared in that package's own package.json.
//
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Bare builtin NAMES that a Node-only workspace may import without declaring them. This is
// the hardcoded list the check started with, unioned with the running Node's own list, so
// newer builtins (node:sqlite, node:test, util/types, …) are never reported as undeclared.
//
// It applies to `nodeOnly` workspaces only. Half of these names are also real npm packages
// (`buffer`, `events`, `punycode`, `process`, `string_decoder`), and for a universal library
// a bare `buffer` is that npm package, not a builtin: Vite and Metro resolve it from
// node_modules. Skipping it everywhere meant core could drop its `buffer` dependency and
// still pass, which is precisely the failure this guard exists to catch.
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'stream/promises',
  'string_decoder', 'timers', 'timers/promises', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  ...builtinModules,
]);

// The packages the Dockerfile builds, in the order it builds them. `testFilePattern`
// matches a package-relative posix path and widens what that file may import from
// `dependencies` to `dependencies` + `devDependencies` — correct only for files that
// never run in production.
//
// `nodeOnly` marks a workspace whose code only ever runs under Node, so a bare builtin name
// needs no dependency. Everything else here is bundled for a browser or a phone, where a
// bare builtin name is an ordinary npm package and has to be declared like one; those
// workspaces get the `node:` prefix skipped and nothing more.
const WORKSPACES = [
  {
    path: 'packages/beanpool-core',
  },
  {
    path: 'packages/beanpool-engine',
  },
  {
    path: 'apps/pwa',
  },
  {
    // Guarded first, and specifically against the workspace hoisting trap.
    path: 'apps/manager',
    enforceTypes: ['leaflet'],
  },
  {
    // The server's tsc compiles src/**/* — its test files included — so they are part of
    // the Docker build and their imports have to be declared too. The node itself never
    // runs them, so a devDependency is enough (that is where #1075 put multiformats).
    path: 'apps/server',
    nodeOnly: true,
    testFilePattern: /(^|\/)(?:test|bench)-[^/]*$|(^|\/)__fixtures__\/|(^|\/)takeover-test-harness\.ts$/,
  },
];

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === 'dist') continue;
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(walk(full));
    } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(file)) {
      results.push(full);
    }
  }
  return results;
}

// A `/` opens a regex literal only where a value cannot have just ended. These are the
// characters after which it is division instead (or, for `<`, the closing tag of a JSX
// element) — so `(`, `=`, `,`, `:`, `!`, `&&`, a line start and the rest admit a regex.
const DIVISION_AFTER = new Set([')', ']', '}', "'", '"', '`', '/', '<']);
// …and these keywords are followed by a value, so a `/` right after one opens a regex.
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

// One pass over the raw source that both blanks out comments and records which offsets sit
// INSIDE a string literal, a template literal or a regex body. Two regexes cannot do this:
//
//   - Blanking line comments with /\/\/.*$/ mangles any string holding `//`: `'https://x'`
//     loses its closing quote, and an unbalanced quote makes everything after it unreadable.
//   - A specifier only counts when the `import` keyword itself is code, not text. core's
//     `barrel-is-universal.test.ts` asserts on the fixture string
//     `"const { createHash } = await import('crypto');"`, and reading that as a real import
//     would demand core declare `crypto` — which the very next assertion in that file says is
//     NOT installed.
//
// Regex literals have to be tokenised too, not skipped: the Content-Disposition line in
// `apps/server/src/routes/backup.ts` holds `` `…"${name.replace(/[\r\n"\x00-\x1F\x7F]/g, '_')}"` ``,
// and reading that regex's `"` as a quote loses the enclosing template, which then hid the
// real `await import('better-sqlite3')` several hundred lines below it.
//
// Comments become spaces instead of disappearing, so every offset and line start survives —
// the import regex anchors on `^`, and shifting the text would break it. A quoted string and
// a regex are both abandoned at the end of their line, so a misread quote (an apostrophe in
// JSX prose, a `/` that was really division) can mislead this by one line rather than muting
// the rest of the file.
function scanSource(raw) {
  const out = raw.split('');
  const inString = new Uint8Array(raw.length);
  const mark = (from, to) => {
    for (let j = from; j < to && j < raw.length; j++) inString[j] = 1;
  };

  // One frame per template literal we are inside. `braceDepth` counts the `{` opened since
  // that template's last `${`, so the matching `}` returns to template text and not to code.
  const templates = [];
  let templateTextStart = -1;
  // The last significant character of code, and the identifier in progress, together decide
  // whether the next `/` is a regex or a division sign.
  let lastSig = '';
  let word = '';
  let i = 0;

  while (i < raw.length) {
    const c = raw[i];
    const next = raw[i + 1];

    // Inside a template's text run: only `\`, a closing backtick and `${` matter.
    if (templateTextStart >= 0) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        mark(templateTextStart, i);
        templateTextStart = -1;
        templates.pop();
        lastSig = '`';
        word = '';
        i++;
        continue;
      }
      if (c === '$' && next === '{') {
        mark(templateTextStart, i);
        templateTextStart = -1;
        templates[templates.length - 1].braceDepth = 0;
        // An interpolation starts a fresh expression, so a regex may open it.
        lastSig = '{';
        word = '';
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = raw.indexOf('*/', i + 2);
      const stop = end === -1 ? raw.length : end + 2;
      for (let j = i; j < stop; j++) if (raw[j] !== '\n') out[j] = ' ';
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i + 1;
      i++;
      while (i < raw.length && raw[i] !== c && raw[i] !== '\n') {
        i += raw[i] === '\\' ? 2 : 1;
      }
      mark(start, i);
      lastSig = c;
      word = '';
      i++;
      continue;
    }
    if (c === '`') {
      templates.push({ braceDepth: 0 });
      templateTextStart = i + 1;
      i++;
      continue;
    }
    if (c === '/') {
      const opensRegex = word !== ''
        ? REGEX_AFTER_KEYWORD.has(word)
        : !DIVISION_AFTER.has(lastSig);
      if (opensRegex) {
        const start = i + 1;
        i++;
        // A regex cannot span a line, and `/` inside a `[…]` class does not close it.
        let inClass = false;
        while (i < raw.length && raw[i] !== '\n') {
          const d = raw[i];
          if (d === '\\') { i += 2; continue; }
          if (inClass) {
            if (d === ']') inClass = false;
          } else if (d === '[') {
            inClass = true;
          } else if (d === '/') {
            break;
          }
          i++;
        }
        mark(start, i);
        i++;
        while (i < raw.length && raw[i] >= 'a' && raw[i] <= 'z') i++;
      } else {
        i++;
      }
      lastSig = '/';
      word = '';
      continue;
    }
    // Braces only need tracking while a template is open above us.
    if (templates.length > 0 && (c === '{' || c === '}')) {
      const top = templates[templates.length - 1];
      if (c === '{') {
        top.braceDepth++;
      } else if (top.braceDepth === 0) {
        templateTextStart = i + 1;
      } else {
        top.braceDepth--;
      }
      lastSig = c;
      word = '';
      i++;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      word += c;
    } else if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') {
      lastSig = c;
      word = '';
    }
    i++;
  }

  // An unterminated template runs to the end of the file.
  if (templateTextStart >= 0) mark(templateTextStart, raw.length);

  return { code: out.join(''), inString };
}

// The package a specifier resolves to: 'multiformats/bases/base58' → 'multiformats',
// '@beanpool/core/ed25519-key' → '@beanpool/core'.
function basePackageOf(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

function checkWorkspace({ path: relPath, enforceTypes = [], testFilePattern = null, nodeOnly = false }) {
  const wsDir = path.join(REPO_ROOT, relPath);
  const pkgJsonPath = path.join(wsDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    console.error(`Missing package.json at ${pkgJsonPath}`);
    return 1;
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const prodDeps = new Set([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.peerDependencies || {}),
  ]);
  const devDeps = new Set(Object.keys(pkgJson.devDependencies || {}));
  const allDeps = new Set([...prodDeps, ...devDeps]);

  const srcDir = path.join(wsDir, 'src');
  const files = walk(srcDir);
  const errors = [];

  // Four shapes: a side-effect import, an import/export … from clause (which may wrap over
  // several lines), a dynamic import() and a require(), the last two with a literal only.
  //
  // The … from clause's body is `[^'"();]*?`, not `[\s\S]*?`: it still spans newlines for a
  // wrapped `import {\n  a,\n} from 'x'`, but it cannot run from an `export function foo(`
  // down into a body and match something that merely reads like one. apps/pwa has
  // `{isBuyer ? 'Bought from ' : 'Sold to '}`, whose ` from ' : '` a body of `[\s\S]*?`
  // happily reaches, reporting ' : ' as an undeclared package.
  const importRegex = /(?:^\s*import\s+['"]([^'"]+)['"]|^\s*(?:import|export)\s+(?:type\s+)?[^'"();]*?\sfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\))/gm;

  for (const file of files) {
    const wsRelative = path.relative(wsDir, file).split(path.sep).join('/');
    // Every test matched against the package-relative path, never the absolute one: a
    // checkout under e.g. /ci/__tests__/beanpool would otherwise make every file a test file
    // and quietly stop the check enforcing production dependencies at all.
    const isTest =
      wsRelative.includes('.test.') ||
      wsRelative.includes('__tests__') ||
      wsRelative.endsWith('setupTests.ts') ||
      (testFilePattern !== null && testFilePattern.test(wsRelative));
    const { code: content, inString } = scanSource(fs.readFileSync(file, 'utf8'));

    let match;
    while ((match = importRegex.exec(content)) !== null) {
      // A match beginning inside a string literal is prose about an import, not an import.
      // The keyword is what has to be code: a real `import x from 'y'` starts in code and
      // only its specifier is quoted.
      if (inString[match.index]) continue;

      const spec = match[1] || match[2] || match[3] || match[4];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
      if (spec.startsWith('node:')) continue;

      const basePkg = basePackageOf(spec);

      // A bare builtin name is free only where nothing bundles it; see WORKSPACES.
      if (nodeOnly && NODE_BUILTINS.has(basePkg)) continue;

      const isTypeOnly = /^\s*(?:import\s+type|export\s+type)/.test(match[0]);
      const allowed = (isTest || isTypeOnly) ? allDeps : prodDeps;

      if (!allowed.has(basePkg)) {
        errors.push({
          file: path.relative(REPO_ROOT, file),
          spec,
          basePkg,
          isTest,
          type: 'undeclared_dependency',
        });
      }
    }
  }

  for (const pkg of enforceTypes) {
    if (prodDeps.has(pkg) || devDeps.has(pkg)) {
      const typePkg = `@types/${pkg}`;
      if (!devDeps.has(typePkg) && !prodDeps.has(typePkg)) {
        errors.push({
          file: path.relative(REPO_ROOT, pkgJsonPath),
          spec: typePkg,
          basePkg: typePkg,
          isTest: false,
          type: 'missing_types',
        });
      }
    }
  }

  if (errors.length > 0) {
    console.error(`❌ Undeclared imports found in ${relPath}:`);
    for (const err of errors) {
      if (err.type === 'missing_types') {
        console.error(`  - ${err.basePkg} missing from devDependencies in ${err.file}`);
      } else {
        const targetSection = err.isTest ? 'dependencies or devDependencies' : 'dependencies';
        console.error(`  - [${err.isTest ? 'TEST' : 'PROD'}] '${err.spec}' in ${err.file} (must be declared in ${targetSection})`);
      }
    }
    return errors.length;
  }

  console.log(`✓ ${relPath}: all imports declared in package.json`);
  return 0;
}

let totalErrors = 0;
for (const workspace of WORKSPACES) {
  totalErrors += checkWorkspace(workspace);
}

if (totalErrors > 0) {
  console.error(`\nFound ${totalErrors} undeclared import violation(s).`);
  process.exit(1);
}

console.log('✓ All workspace import boundaries verified.');
process.exit(0);
